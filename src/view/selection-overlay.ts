import { setIcon } from "obsidian";
import { StrokePoint } from "../model/annotation";
import type { InkCanvasViewport } from "./ink-canvas";
import { setControlTooltip } from "./ui";

export interface SelectionBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type SelectionOperation =
  | "lock"
  | "unlock"
  | "group"
  | "ungroup"
  | "front"
  | "back"
  | "align-left"
  | "align-center"
  | "align-right"
  | "align-top"
  | "align-middle"
  | "align-bottom"
  | "distribute-horizontal"
  | "distribute-vertical";

export class SelectionOverlay {
  readonly element: HTMLDivElement;
  readonly outline: SVGSVGElement;
  readonly menu: HTMLDivElement;
  readonly transformBox: HTMLDivElement;
  private readonly path: SVGPathElement;
  private readonly bounds: SVGRectElement;
  private readonly pasteButton: HTMLButtonElement;

  constructor(
    onDelete: () => void,
    onCancel: () => void,
    onDuplicate: () => void,
    onCopy: () => void,
    onCut: () => void,
    onPaste: () => void,
    onColor: (color: string) => void,
    onScreenshot: () => void,
    onTransformStart: (event: PointerEvent, handle: string) => void,
    onOperation: (operation: SelectionOperation) => void
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
    const duplicateButton = this.createButton("copy-plus", "复制");
    duplicateButton.addEventListener("click", onDuplicate);
    const copyButton = this.createButton("clipboard-copy", "拷贝");
    copyButton.addEventListener("click", onCopy);
    const cutButton = this.createButton("scissors", "剪切");
    cutButton.addEventListener("click", onCut);
    this.pasteButton = this.createButton("clipboard-paste", "粘贴");
    this.pasteButton.addEventListener("click", onPaste);
    const deleteButton = this.createButton("trash-2", "删除");
    deleteButton.addEventListener("click", onDelete);
    const transformButton = this.createButton("move-diagonal-2", "调整大小与旋转");
    transformButton.addEventListener("click", () => {
      this.transformBox.classList.add("is-emphasized");
      window.setTimeout(() => this.transformBox.classList.remove("is-emphasized"), 900);
    });
    const colorButton = this.createButton("palette", "颜色");
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.className = "hand-note-selection-color-input";
    colorInput.setAttribute("aria-label", "选择选区颜色");
    colorButton.addEventListener("click", () => colorInput.click());
    colorInput.addEventListener("input", () => onColor(colorInput.value));
    const screenshotButton = this.createButton("camera", "截屏");
    screenshotButton.addEventListener("click", onScreenshot);
    const operationButtons: Array<[string, string, SelectionOperation]> = [
      ["lock", "锁定", "lock"],
      ["unlock", "解锁", "unlock"],
      ["group", "编组", "group"],
      ["ungroup", "取消编组", "ungroup"],
      ["bring-to-front", "置于顶层", "front"],
      ["send-to-back", "置于底层", "back"],
      ["align-start-horizontal", "左对齐", "align-left"],
      ["align-center-horizontal", "水平居中", "align-center"],
      ["align-end-horizontal", "右对齐", "align-right"],
      ["align-start-vertical", "顶端对齐", "align-top"],
      ["align-center-vertical", "垂直居中", "align-middle"],
      ["align-end-vertical", "底端对齐", "align-bottom"],
      ["columns-3", "水平分布", "distribute-horizontal"],
      ["rows-3", "垂直分布", "distribute-vertical"]
    ];
    const objectButtons = operationButtons.map(([icon, label, operation]) => {
      const button = this.createButton(icon, label);
      button.addEventListener("click", () => onOperation(operation));
      return button;
    });
    const cancelButton = this.createButton("x", "取消选择");
    cancelButton.addEventListener("click", onCancel);
    this.menu.append(
      duplicateButton,
      copyButton,
      cutButton,
      this.pasteButton,
      deleteButton,
      transformButton,
      colorButton,
      colorInput,
      screenshotButton,
      ...objectButtons,
      cancelButton
    );

    this.transformBox = document.createElement("div");
    this.transformBox.className = "hand-note-selection-transform";
    this.transformBox.setAttribute("aria-label", "移动、缩放或旋转选区");
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
      setControlTooltip(button, `缩放选区 ${handle}`);
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onTransformStart(event, handle);
      });
      this.transformBox.append(button);
    }
    const rotateButton = document.createElement("button");
    rotateButton.type = "button";
    rotateButton.className = "hand-note-selection-handle is-rotate";
    setIcon(rotateButton, "rotate-cw");
    setControlTooltip(rotateButton, "旋转选区");
    rotateButton.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onTransformStart(event, "rotate");
    });
    this.transformBox.append(rotateButton);
    this.element.append(this.outline, this.transformBox, this.menu);
    document.body.append(this.element);
    this.clear();
  }

  setPasteEnabled(enabled: boolean): void {
    this.pasteButton.disabled = !enabled;
  }

  setDraft(points: StrokePoint[], viewport: InkCanvasViewport, canvasRect: DOMRect): void {
    this.prepare(viewport, canvasRect);
    this.path.setAttribute("d", this.pathData(points, viewport, false));
    this.bounds.setAttribute("visibility", "hidden");
    this.transformBox.classList.remove("is-visible");
    this.menu.classList.remove("is-visible");
  }

  setSelection(
    points: StrokePoint[],
    selectionBounds: SelectionBounds,
    viewport: InkCanvasViewport,
    canvasRect: DOMRect
  ): void {
    this.prepare(viewport, canvasRect);
    this.path.setAttribute("d", this.pathData(points, viewport, true));
    const left = selectionBounds.minX * viewport.documentWidth - viewport.offsetX;
    const top = selectionBounds.minY * viewport.documentHeight - viewport.offsetY;
    const width = Math.max(1, (selectionBounds.maxX - selectionBounds.minX) * viewport.documentWidth);
    const height = Math.max(1, (selectionBounds.maxY - selectionBounds.minY) * viewport.documentHeight);
    this.bounds.setAttribute("x", String(left));
    this.bounds.setAttribute("y", String(top));
    this.bounds.setAttribute("width", String(width));
    this.bounds.setAttribute("height", String(height));
    this.bounds.setAttribute("visibility", "visible");

    const menuWidth = Math.min(292, Math.max(0, canvasRect.width - 16));
    const menuLeft = Math.max(8, Math.min(canvasRect.width - menuWidth - 8, left + width - menuWidth));
    const estimatedMenuHeight = 126;
    const menuTop = top >= estimatedMenuHeight + 8
      ? top - estimatedMenuHeight - 6
      : Math.min(canvasRect.height - estimatedMenuHeight - 8, top + height + 8);
    this.menu.style.left = `${menuLeft}px`;
    this.menu.style.top = `${Math.max(8, menuTop)}px`;
    this.menu.classList.add("is-visible");
    this.transformBox.style.left = `${left}px`;
    this.transformBox.style.top = `${top}px`;
    this.transformBox.style.width = `${width}px`;
    this.transformBox.style.height = `${height}px`;
    this.transformBox.classList.add("is-visible");
  }

  hideMenu(): void {
    this.menu.classList.remove("is-visible");
  }

  clear(): void {
    this.path.setAttribute("d", "");
    this.bounds.setAttribute("visibility", "hidden");
    this.element.classList.remove("is-visible");
    this.menu.classList.remove("is-visible");
    this.transformBox.classList.remove("is-visible", "is-emphasized");
  }

  destroy(): void {
    this.element.remove();
  }

  private prepare(viewport: InkCanvasViewport, canvasRect: DOMRect): void {
    this.element.style.left = `${canvasRect.left}px`;
    this.element.style.top = `${canvasRect.top}px`;
    this.element.style.width = `${canvasRect.width}px`;
    this.element.style.height = `${canvasRect.height}px`;
    this.outline.setAttribute("viewBox", `0 0 ${Math.max(1, viewport.width)} ${Math.max(1, viewport.height)}`);
    this.element.classList.add("is-visible");
  }

  private pathData(points: StrokePoint[], viewport: InkCanvasViewport, close: boolean): string {
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
    setIcon(button, icon);
    setControlTooltip(button, label);
    return button;
  }
}
