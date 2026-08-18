import { setIcon } from "obsidian";
import { StrokePoint } from "../model/annotation";

export interface SelectionBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class SelectionOverlay {
  readonly outline: SVGSVGElement;
  readonly menu: HTMLDivElement;
  readonly transformBox: HTMLDivElement;
  private readonly path: SVGPathElement;
  private readonly bounds: SVGRectElement;

  constructor(
    onDelete: () => void,
    onCancel: () => void,
    onDuplicate: () => void,
    onTransformStart: (event: PointerEvent, handle: string) => void
  ) {
    const namespace = "http://www.w3.org/2000/svg";
    this.outline = document.createElementNS(namespace, "svg");
    this.outline.classList.add("hand-note-selection-overlay");
    this.outline.setAttribute("aria-hidden", "true");

    this.path = document.createElementNS(namespace, "path");
    this.path.classList.add("hand-note-selection-path");
    this.bounds = document.createElementNS(namespace, "rect");
    this.bounds.classList.add("hand-note-selection-bounds");
    this.outline.append(this.path, this.bounds);

    this.menu = document.createElement("div");
    this.menu.className = "hand-note-selection-menu";

    const duplicateButton = this.createButton("copy", "复制选中笔迹");
    duplicateButton.addEventListener("click", onDuplicate);
    const deleteButton = this.createButton("trash-2", "删除选中笔迹");
    deleteButton.addEventListener("click", onDelete);
    const cancelButton = this.createButton("x", "取消选择");
    cancelButton.addEventListener("click", onCancel);
    this.menu.append(duplicateButton, deleteButton, cancelButton);

    this.transformBox = document.createElement("div");
    this.transformBox.className = "hand-note-selection-transform";
    this.transformBox.setAttribute("aria-label", "移动或缩放选区");
    let longPressTimer: number | null = null;
    let startX = 0;
    let startY = 0;
    const cancelLongPress = () => {
      if (longPressTimer !== null) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };
    this.transformBox.addEventListener("pointerdown", (event) => {
      if (event.target !== this.transformBox) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      startX = event.clientX;
      startY = event.clientY;
      if (event.pointerType === "touch") {
        cancelLongPress();
        longPressTimer = window.setTimeout(() => {
          longPressTimer = null;
          this.menu.classList.add("is-visible");
        }, 420);
      }
      onTransformStart(event, "move");
    });
    this.transformBox.addEventListener("pointermove", (event) => {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 8) {
        cancelLongPress();
      }
    });
    this.transformBox.addEventListener("pointerup", cancelLongPress);
    this.transformBox.addEventListener("pointercancel", cancelLongPress);
    for (const handle of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `hand-note-selection-handle is-${handle}`;
      button.setAttribute("aria-label", `缩放选区 ${handle}`);
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.menu.classList.remove("is-visible");
        onTransformStart(event, handle);
      });
      this.transformBox.append(button);
    }
    this.clear();
  }

  setDraft(points: StrokePoint[], documentWidth: number, documentHeight: number): void {
    this.prepare(documentWidth, documentHeight);
    this.path.setAttribute("d", this.pathData(points, documentWidth, documentHeight, false));
    this.bounds.setAttribute("visibility", "hidden");
    this.menu.classList.remove("is-visible");
  }

  setSelection(
    points: StrokePoint[],
    selectionBounds: SelectionBounds,
    documentWidth: number,
    documentHeight: number
  ): void {
    this.prepare(documentWidth, documentHeight);
    this.path.setAttribute("d", this.pathData(points, documentWidth, documentHeight, true));

    const left = selectionBounds.minX * documentWidth;
    const top = selectionBounds.minY * documentHeight;
    const width = Math.max(1, (selectionBounds.maxX - selectionBounds.minX) * documentWidth);
    const height = Math.max(1, (selectionBounds.maxY - selectionBounds.minY) * documentHeight);
    this.bounds.setAttribute("x", String(left));
    this.bounds.setAttribute("y", String(top));
    this.bounds.setAttribute("width", String(width));
    this.bounds.setAttribute("height", String(height));
    this.bounds.setAttribute("visibility", "visible");

    const menuWidth = 118;
    const menuLeft = Math.max(8, Math.min(documentWidth - menuWidth - 8, left + width - menuWidth));
    const menuTop = Math.max(8, top - 44);
    this.menu.style.left = `${menuLeft}px`;
    this.menu.style.top = `${menuTop}px`;
    this.transformBox.style.left = `${left}px`;
    this.transformBox.style.top = `${top}px`;
    this.transformBox.style.width = `${width}px`;
    this.transformBox.style.height = `${height}px`;
    this.transformBox.classList.add("is-visible");
  }

  clear(): void {
    this.path.setAttribute("d", "");
    this.bounds.setAttribute("visibility", "hidden");
    this.outline.classList.remove("is-visible");
    this.menu.classList.remove("is-visible");
    this.transformBox.classList.remove("is-visible");
  }

  private prepare(documentWidth: number, documentHeight: number): void {
    this.outline.setAttribute(
      "viewBox",
      `0 0 ${Math.max(1, documentWidth)} ${Math.max(1, documentHeight)}`
    );
    this.outline.classList.add("is-visible");
  }

  private pathData(
    points: StrokePoint[],
    documentWidth: number,
    documentHeight: number,
    close: boolean
  ): string {
    if (points.length === 0) {
      return "";
    }
    const commands = points.map((point, index) => {
      const command = index === 0 ? "M" : "L";
      return `${command}${point.x * documentWidth} ${point.y * documentHeight}`;
    });
    if (close && points.length > 2) {
      commands.push("Z");
    }
    return commands.join(" ");
  }

  private createButton(icon: string, label: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "clickable-icon hand-note-tool";
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    setIcon(button, icon);
    return button;
  }
}
