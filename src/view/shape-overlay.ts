import { AnnotationStroke } from "../model/annotation";
import type { InkCanvasViewport } from "./ink-canvas";

export class ShapeOverlay {
  readonly element: HTMLDivElement;
  private readonly handles: HTMLButtonElement[] = [];
  private stroke: AnnotationStroke | null = null;
  private viewport: InkCanvasViewport | null = null;

  constructor(onHandleStart: (event: PointerEvent, pointIndex: number) => void) {
    this.element = document.createElement("div");
    this.element.className = "hand-note-shape-overlay";
    for (let index = 0; index < 4; index += 1) {
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "hand-note-shape-anchor";
      handle.setAttribute("aria-label", `调整图形锚点 ${index + 1}`);
      handle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onHandleStart(event, index);
      });
      this.handles.push(handle);
      this.element.append(handle);
    }
  }

  setStroke(stroke: AnnotationStroke, viewport: InkCanvasViewport): void {
    this.stroke = stroke;
    this.viewport = viewport;
    this.element.classList.add("is-visible");
    this.update();
  }

  update(): void {
    if (!this.stroke || !this.viewport) {
      return;
    }
    this.handles.forEach((handle, index) => {
      const point = this.stroke?.points[index];
      if (!point) {
        handle.classList.remove("is-visible");
        return;
      }
      handle.style.left = `${point.x * this.viewport.documentWidth}px`;
      handle.style.top = `${point.y * this.viewport.documentHeight}px`;
      handle.classList.add("is-visible");
    });
  }

  clear(): void {
    this.stroke = null;
    this.viewport = null;
    this.element.classList.remove("is-visible");
    this.handles.forEach((handle) => handle.classList.remove("is-visible"));
  }
}
