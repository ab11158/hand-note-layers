import { setIcon } from "obsidian";
import { StrokePoint } from "../model/annotation";
import type { InkCanvasViewport } from "./ink-canvas";

export interface SelectionBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class SelectionOverlay {
  readonly element: HTMLDivElement;
  readonly outline: SVGSVGElement;
  readonly menu: HTMLDivElement;
  readonly transformBox: HTMLDivElement;
  private readonly path: SVGPathElement;
  private readonly bounds: SVGRectElement;

  constructor(
    onDelete: () => void,
    onCancel: () => void,
    onDuplicate: () => void,
    onScreenshot: () => void,
    onTransformStart: (event: PointerEvent, handle: string) => void
  ) {
    this.element = document.createElement("div");
    this.element.className = "hand-note-selection-layer";

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

    const moveButton = this.createButton("move", "移动选区");
    moveButton.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onTransformStart(event, "move");
    });
    const scaleButton = this.createButton("maximize-2", "缩放选区");
    scaleButton.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onTransformStart(event, "se");
    });
    const screenshotButton = this.createButton("camera", "截屏选区");
    screenshotButton.addEventListener("click", onScreenshot);
    const duplicateButton = this.createButton("copy", "复制选中内容");
    duplicateButton.addEventListener("click", onDuplicate);
    const deleteButton = this.createButton("trash-2", "删除选中内容");
    deleteButton.addEventListener("click", onDelete);
    const cancelButton = this.createButton("x", "取消选择");
    cancelButton.addEventListener("click", onCancel);
    this.menu.append(
      moveButton,
      scaleButton,
      screenshotButton,
      duplicateButton,
      deleteButton,
      cancelButton
    );

    this.transformBox = document.createElement("div");
    this.transformBox.className = "hand-note-selection-transform";
    this.transformBox.setAttribute("aria-label", "移动或缩放选区");
    this.transformBox.addEventListener("pointerdown", (event) => {
      if (event.target !== this.transformBox) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onTransformStart(event, "move");
    });
    for (const handle of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `hand-note-selection-handle is-${handle}`;
      button.setAttribute("aria-label", `缩放选区 ${handle}`);
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onTransformStart(event, handle);
      });
      this.transformBox.append(button);
    }
    this.element.append(this.outline, this.transformBox, this.menu);
    this.clear();
  }

  setDraft(points: StrokePoint[], viewport: InkCanvasViewport): void {
    this.prepare(viewport);
    this.path.setAttribute("d", this.pathData(points, viewport, false));
    this.bounds.setAttribute("visibility", "hidden");
    this.menu.classList.remove("is-visible");
  }

  setSelection(
    points: StrokePoint[],
    selectionBounds: SelectionBounds,
    viewport: InkCanvasViewport
  ): void {
    this.prepare(viewport);
    this.path.setAttribute("d", this.pathData(points, viewport, true));

    const left = selectionBounds.minX * viewport.documentWidth - viewport.offsetX;
    const top = selectionBounds.minY * viewport.documentHeight - viewport.offsetY;
    const width = Math.max(
      1,
      (selectionBounds.maxX - selectionBounds.minX) * viewport.documentWidth
    );
    const height = Math.max(
      1,
      (selectionBounds.maxY - selectionBounds.minY) * viewport.documentHeight
    );
    this.bounds.setAttribute("x", String(left));
    this.bounds.setAttribute("y", String(top));
    this.bounds.setAttribute("width", String(width));
    this.bounds.setAttribute("height", String(height));
    this.bounds.setAttribute("visibility", "visible");

    const menuWidth = Math.min(240, Math.max(0, viewport.width - 16));
    const menuLeft = Math.max(
      8,
      Math.min(viewport.width - menuWidth - 8, left + width - menuWidth)
    );
    const menuTop = top >= 52 ? top - 44 : Math.min(viewport.height - 44, top + height + 8);
    this.menu.style.left = `${menuLeft}px`;
    this.menu.style.top = `${Math.max(8, menuTop)}px`;
    this.menu.classList.add("is-visible");
    this.transformBox.style.left = `${left}px`;
    this.transformBox.style.top = `${top}px`;
    this.transformBox.style.width = `${width}px`;
    this.transformBox.style.height = `${height}px`;
    this.transformBox.classList.add("is-visible");
  }

  clear(): void {
    this.path.setAttribute("d", "");
    this.bounds.setAttribute("visibility", "hidden");
    this.element.classList.remove("is-visible");
    this.menu.classList.remove("is-visible");
    this.transformBox.classList.remove("is-visible");
  }

  private prepare(viewport: InkCanvasViewport): void {
    this.element.style.left = `${viewport.offsetX}px`;
    this.element.style.top = `${viewport.offsetY}px`;
    this.element.style.width = `${viewport.width}px`;
    this.element.style.height = `${viewport.height}px`;
    this.outline.setAttribute(
      "viewBox",
      `0 0 ${Math.max(1, viewport.width)} ${Math.max(1, viewport.height)}`
    );
    this.element.classList.add("is-visible");
  }

  private pathData(
    points: StrokePoint[],
    viewport: InkCanvasViewport,
    close: boolean
  ): string {
    if (points.length === 0) {
      return "";
    }
    const commands = points.map((point, index) => {
      const command = index === 0 ? "M" : "L";
      const x = point.x * viewport.documentWidth - viewport.offsetX;
      const y = point.y * viewport.documentHeight - viewport.offsetY;
      return `${command}${x} ${y}`;
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
