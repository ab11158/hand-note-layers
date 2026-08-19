import { AnnotationStroke } from "../model/annotation";
import type { InkCanvasViewport } from "./ink-canvas";
import { setControlTooltip } from "./ui";

export class ShapeOverlay {
  readonly element: HTMLDivElement;
  private readonly onHandleStart: (event: PointerEvent, pointIndex: number) => void;
  private readonly onInsert: (segmentIndex: number) => void;
  private readonly onDelete: (pointIndex: number) => void;
  private stroke: AnnotationStroke | null = null;
  private viewport: InkCanvasViewport | null = null;

  constructor(
    onHandleStart: (event: PointerEvent, pointIndex: number) => void,
    onInsert: (segmentIndex: number) => void,
    onDelete: (pointIndex: number) => void
  ) {
    this.element = document.createElement("div");
    this.element.className = "hand-note-shape-overlay";
    this.onHandleStart = onHandleStart;
    this.onInsert = onInsert;
    this.onDelete = onDelete;
  }

  setStroke(
    stroke: AnnotationStroke,
    viewport: InkCanvasViewport,
    canvasRect: DOMRect
  ): void {
    this.stroke = stroke;
    this.viewport = viewport;
    if (this.element.parentElement !== document.body) {
      document.body.append(this.element);
    }
    this.element.style.left = `${canvasRect.left}px`;
    this.element.style.top = `${canvasRect.top}px`;
    this.element.style.width = `${canvasRect.width}px`;
    this.element.style.height = `${canvasRect.height}px`;
    this.element.classList.add("is-visible");
    this.update();
  }

  update(): void {
    if (!this.stroke || !this.viewport) {
      return;
    }
    this.element.replaceChildren();
    const points = this.stroke.points;
    points.forEach((point, pointIndex) => {
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "hand-note-shape-anchor is-visible";
      setControlTooltip(handle, `调整路径控制点 ${pointIndex + 1}`);
      this.position(handle, point.x, point.y);
      handle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.onHandleStart(event, pointIndex);
      });
      handle.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.onDelete(pointIndex);
      });
      handle.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.onDelete(pointIndex);
      });
      this.element.append(handle);
    });

    if (!this.supportsPathPoints(this.stroke) || points.length < 2) {
      return;
    }
    const segmentCount = this.stroke.closed ? points.length : points.length - 1;
    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
      const start = points[segmentIndex];
      const end = points[(segmentIndex + 1) % points.length];
      const insert = document.createElement("button");
      insert.type = "button";
      insert.className = "hand-note-shape-anchor hand-note-shape-midpoint is-visible";
      setControlTooltip(insert, "增加路径控制点");
      this.position(insert, (start.x + end.x) / 2, (start.y + end.y) / 2);
      insert.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.onInsert(segmentIndex);
      });
      this.element.append(insert);
    }
  }

  clear(): void {
    this.stroke = null;
    this.viewport = null;
    this.element.classList.remove("is-visible");
    this.element.replaceChildren();
  }

  private position(element: HTMLElement, x: number, y: number): void {
    if (!this.viewport) {
      return;
    }
    element.style.left = `${x * this.viewport.documentWidth - this.viewport.offsetX}px`;
    element.style.top = `${y * this.viewport.documentHeight - this.viewport.offsetY}px`;
  }

  private supportsPathPoints(stroke: AnnotationStroke): boolean {
    return stroke.shape === "line" ||
      stroke.shape === "polyline" ||
      stroke.shape?.startsWith("connector-") === true;
  }
}
