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
  private readonly path: SVGPathElement;
  private readonly bounds: SVGRectElement;

  constructor(onDelete: () => void, onCancel: () => void) {
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

    const deleteButton = this.createButton("trash-2", "删除选中笔迹");
    deleteButton.addEventListener("click", onDelete);
    const cancelButton = this.createButton("x", "取消选择");
    cancelButton.addEventListener("click", onCancel);
    this.menu.append(deleteButton, cancelButton);
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

    const menuWidth = 78;
    const menuLeft = Math.max(8, Math.min(documentWidth - menuWidth - 8, left + width - menuWidth));
    const menuTop = Math.max(8, top - 44);
    this.menu.style.left = `${menuLeft}px`;
    this.menu.style.top = `${menuTop}px`;
    this.menu.classList.add("is-visible");
  }

  clear(): void {
    this.path.setAttribute("d", "");
    this.bounds.setAttribute("visibility", "hidden");
    this.outline.classList.remove("is-visible");
    this.menu.classList.remove("is-visible");
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
