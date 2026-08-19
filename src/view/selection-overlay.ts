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

export type SelectionContext = "selection" | "text";

export class SelectionOverlay {
  readonly element: HTMLDivElement;
  readonly outline: SVGSVGElement;
  readonly menu: HTMLDivElement;
  readonly transformBox: HTMLDivElement;
  private readonly path: SVGPathElement;
  private readonly bounds: SVGRectElement;
  private readonly pasteButton: HTMLButtonElement;
  private readonly selectionButtons: HTMLButtonElement[] = [];
  private readonly textButtons: HTMLButtonElement[] = [];
  private readonly fontControl: HTMLDivElement;
  private readonly fontInput: HTMLInputElement;

  constructor(
    onDelete: () => void,
    onDuplicate: () => void,
    onCopy: () => void,
    onCut: () => void,
    onPaste: () => void,
    onColor: (color: string) => void,
    onScreenshot: () => void,
    onEditText: (selectAll: boolean) => void,
    onTextFontSize: (fontSize: number) => void,
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
      ["unlock", "解锁", "unlock"]
    ];
    const objectButtons = operationButtons.map(([icon, label, operation]) => {
      const button = this.createButton(icon, label);
      button.addEventListener("click", () => onOperation(operation));
      return button;
    });
    const selectAllButton = this.createButton("text-cursor-input", "全选");
    selectAllButton.addEventListener("click", () => onEditText(true));
    const fontButton = this.createButton("type", "字体");
    this.fontControl = document.createElement("div");
    this.fontControl.className = "hand-note-selection-font-control";
    this.fontInput = document.createElement("input");
    this.fontInput.type = "number";
    this.fontInput.min = "8";
    this.fontInput.max = "144";
    this.fontInput.step = "1";
    this.fontInput.value = "24";
    this.fontInput.setAttribute("aria-label", "文本字号");
    const fontUnit = document.createElement("span");
    fontUnit.textContent = "px";
    this.fontControl.append(this.fontInput, fontUnit);
    fontButton.addEventListener("click", () => {
      this.fontControl.classList.toggle("is-visible");
      if (this.fontControl.classList.contains("is-visible")) {
        this.fontInput.focus();
        this.fontInput.select();
      }
    });
    const applyFontSize = (): void => {
      const fontSize = Math.max(8, Math.min(144, Number(this.fontInput.value) || 24));
      this.fontInput.value = String(fontSize);
      onTextFontSize(fontSize);
    };
    this.fontInput.addEventListener("change", applyFontSize);
    this.fontInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        applyFontSize();
        this.fontControl.classList.remove("is-visible");
      }
    });

    const sharedButtons = [
      duplicateButton,
      copyButton,
      cutButton,
      this.pasteButton,
      deleteButton,
      colorButton
    ];
    this.selectionButtons.push(transformButton, screenshotButton, ...objectButtons);
    this.textButtons.push(selectAllButton, fontButton);
    this.menu.append(
      duplicateButton,
      copyButton,
      cutButton,
      this.pasteButton,
      deleteButton,
      selectAllButton,
      fontButton,
      this.fontControl,
      transformButton,
      colorButton,
      colorInput,
      screenshotButton,
      ...objectButtons
    );
    sharedButtons.forEach((button) => button.dataset.selectionContext = "shared");
    this.selectionButtons.forEach((button) => button.dataset.selectionContext = "selection");
    this.textButtons.forEach((button) => button.dataset.selectionContext = "text");

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
    this.setContext("selection");
    this.clear();
  }

  setContext(context: SelectionContext): void {
    this.menu.dataset.context = context;
    this.selectionButtons.forEach((button) => {
      button.hidden = context !== "selection";
    });
    this.textButtons.forEach((button) => {
      button.hidden = context !== "text";
    });
    this.fontControl.classList.remove("is-visible");
  }

  setTextFontSize(fontSize: number): void {
    this.fontInput.value = String(Math.round(Math.max(8, Math.min(144, fontSize))));
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

    this.menu.classList.add("is-visible");
    const measuredMenu = this.menu.getBoundingClientRect();
    const menuWidth = Math.min(measuredMenu.width, Math.max(0, canvasRect.width - 16));
    const menuLeft = Math.max(8, Math.min(canvasRect.width - menuWidth - 8, left + width - menuWidth));
    const menuHeight = Math.min(measuredMenu.height, Math.max(0, canvasRect.height - 16));
    const menuTop = top >= menuHeight + 8
      ? top - menuHeight - 6
      : Math.min(canvasRect.height - menuHeight - 8, top + height + 8);
    this.menu.style.left = `${menuLeft}px`;
    this.menu.style.top = `${Math.max(8, menuTop)}px`;
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
    button.className = "clickable-icon hand-note-tool hand-note-selection-menu-button";
    setIcon(button, icon);
    setControlTooltip(button, label);
    const text = document.createElement("span");
    text.textContent = label;
    button.append(text);
    return button;
  }
}
