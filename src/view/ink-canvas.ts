import {
  AnnotationDocument,
  AnnotationLayer,
  AnnotationStroke,
  AnnotationTool,
  StrokePoint,
  cloneDocument,
  generateId,
  getActiveLayer
} from "../model/annotation";

export interface InkCanvasOptions {
  getDocument: () => AnnotationDocument;
  getTool: () => AnnotationTool;
  getColor: () => string;
  getSize: () => number;
  getEraserSize: () => number;
  onDocumentChange: (document: AnnotationDocument) => void;
  onInteraction?: (type: "stroke-start" | "stroke-end" | "erase") => void;
  pageIndex?: number;
}

export class InkCanvas {
  readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly options: InkCanvasOptions;
  private activeStroke: AnnotationStroke | null = null;
  private activePointerId: number | null = null;
  private undoStack: AnnotationDocument[] = [];
  private redoStack: AnnotationDocument[] = [];
  private observer: ResizeObserver | null = null;

  constructor(options: InkCanvasOptions) {
    this.options = options;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "hand-note-canvas";
    this.canvas.style.touchAction = "none";
    this.canvas.style.position = "absolute";
    this.canvas.style.inset = "0";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.zIndex = "3";

    const context = this.canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to create 2D canvas context");
    }
    this.context = context;

    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("pointercancel", this.handlePointerUp);

    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.render());
      this.observer.observe(this.canvas);
    }

    this.render();
  }

  destroy(): void {
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerUp);
    this.observer?.disconnect();
  }

  setDocument(_document: AnnotationDocument): void {
    this.activeStroke = null;
    this.activePointerId = null;
    this.resetHistory();
    this.render();
  }

  resetHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) {
      return;
    }

    this.activeStroke = null;
    this.activePointerId = null;
    this.redoStack.push(cloneDocument(this.options.getDocument()));
    this.options.onDocumentChange(previous);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) {
      return;
    }

    this.activeStroke = null;
    this.activePointerId = null;
    this.undoStack.push(cloneDocument(this.options.getDocument()));
    this.options.onDocumentChange(next);
  }

  clearActiveLayer(): void {
    const document = this.options.getDocument();
    const layer = getActiveLayer(document);

    if (layer.strokes.length === 0) {
      return;
    }

    this.pushHistory(document);
    layer.strokes = [];
    this.options.onDocumentChange(document);
  }

  recordHistory(): void {
    this.pushHistory(this.options.getDocument());
  }

  render(): void {
    const canvas = this.canvas;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return;
    }

    const pixelRatio = Math.max(window.devicePixelRatio || 1, 1);
    const width = Math.round(rect.width * pixelRatio);
    const height = Math.round(rect.height * pixelRatio);

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    this.context.clearRect(0, 0, rect.width, rect.height);

    const document = this.options.getDocument();
    for (const layer of document.layers) {
      if (!layer.visible || layer.opacity <= 0) {
        continue;
      }

      this.context.globalAlpha = layer.opacity;
      for (const stroke of layer.strokes) {
        if (this.options.pageIndex !== undefined && stroke.pageIndex !== this.options.pageIndex) {
          continue;
        }
        this.drawStroke(stroke, rect.width, rect.height);
      }
    }

    this.context.globalAlpha = 1;
  }

  private drawStroke(stroke: AnnotationStroke, width: number, height: number): void {
    if (stroke.points.length === 0) {
      return;
    }

    const context = this.context;
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = stroke.color;

    if (stroke.tool === "eraser") {
      context.strokeStyle = "rgba(0,0,0,0)";
      context.restore();
      return;
    }

    const points = stroke.points;
    if (points.length === 1) {
      const point = this.normalizePoint(points[0], width, height);
      context.lineWidth = this.pressureWidth(stroke.size, points[0].pressure);
      context.beginPath();
      context.arc(point.x, point.y, context.lineWidth / 2, 0, Math.PI * 2);
      context.fillStyle = stroke.color;
      context.fill();
      context.restore();
      return;
    }

    context.beginPath();
    const first = this.normalizePoint(points[0], width, height);
    context.moveTo(first.x, first.y);

    for (let index = 1; index < points.length; index += 1) {
      const previous = this.normalizePoint(points[index - 1], width, height);
      const current = this.normalizePoint(points[index], width, height);
      const middleX = (previous.x + current.x) / 2;
      const middleY = (previous.y + current.y) / 2;
      context.lineWidth = this.pressureWidth(stroke.size, current.pressure);
      context.quadraticCurveTo(previous.x, previous.y, middleX, middleY);
    }

    const last = this.normalizePoint(points[points.length - 1], width, height);
    context.lineTo(last.x, last.y);
    context.stroke();
    context.restore();
  }

  private normalizePoint(point: StrokePoint, width: number, height: number): StrokePoint {
    return {
      x: point.x * width,
      y: point.y * height,
      pressure: point.pressure
    };
  }

  private pressureWidth(size: number, pressure: number): number {
    const normalized = Number.isFinite(pressure) ? Math.max(0, Math.min(1, pressure)) : 0.5;
    return Math.max(1, size * (0.35 + normalized * 1.15));
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (this.activePointerId !== null) {
      return;
    }

    const document = this.options.getDocument();
    const layer = getActiveLayer(document);
    if (!layer || !layer.visible || layer.opacity <= 0) {
      return;
    }

    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
    this.activePointerId = event.pointerId;

    const point = this.pointFromEvent(event);
    const tool = this.options.getTool();

    if (tool === "eraser") {
      this.eraseAtPoint(document, layer, point);
      return;
    }

    this.pushHistory(document);
    this.activeStroke = {
      id: generateId(),
      tool,
      color: this.options.getColor(),
      size: this.options.getSize(),
      points: [point],
      pageIndex: this.options.pageIndex
    };
    layer.strokes.push(this.activeStroke);
    this.options.onDocumentChange(document);
    this.options.onInteraction?.("stroke-start");
    this.render();
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) {
      return;
    }

    event.preventDefault();
    const point = this.pointFromEvent(event);

    if (!this.activeStroke) {
      return;
    }

    this.activeStroke.points.push(point);
    this.render();
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) {
      return;
    }

    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }

    if (this.activeStroke) {
      this.activeStroke = null;
      this.options.onInteraction?.("stroke-end");
      this.options.onDocumentChange(this.options.getDocument());
      this.render();
    }

    this.activePointerId = null;
  };

  private eraseAtPoint(
    document: AnnotationDocument,
    layer: AnnotationLayer,
    point: StrokePoint
  ): void {
    const eraserRadius = this.options.getEraserSize() / 2;
    let removed = false;

    this.pushHistory(document);
    for (let index = layer.strokes.length - 1; index >= 0; index -= 1) {
      const stroke = layer.strokes[index];
      if (this.strokeHitTest(stroke, point, eraserRadius)) {
        layer.strokes.splice(index, 1);
        removed = true;
      }
    }

    if (removed) {
      this.options.onDocumentChange(document);
      this.options.onInteraction?.("erase");
      this.render();
    } else {
      this.undoStack.pop();
    }
  }

  private strokeHitTest(stroke: AnnotationStroke, point: StrokePoint, radius: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const pixelPoint: StrokePoint = {
      x: point.x * rect.width,
      y: point.y * rect.height,
      pressure: point.pressure
    };

    for (let index = 1; index < stroke.points.length; index += 1) {
      const start: StrokePoint = {
        x: stroke.points[index - 1].x * rect.width,
        y: stroke.points[index - 1].y * rect.height,
        pressure: stroke.points[index - 1].pressure
      };
      const end: StrokePoint = {
        x: stroke.points[index].x * rect.width,
        y: stroke.points[index].y * rect.height,
        pressure: stroke.points[index].pressure
      };
      const distance = this.distanceToSegment(pixelPoint, start, end);
      if (distance <= radius) {
        return true;
      }
    }

    if (stroke.points.length === 1) {
      const start: StrokePoint = {
        x: stroke.points[0].x * rect.width,
        y: stroke.points[0].y * rect.height,
        pressure: stroke.points[0].pressure
      };
      const dx = pixelPoint.x - start.x;
      const dy = pixelPoint.y - start.y;
      return Math.sqrt(dx * dx + dy * dy) <= radius;
    }

    return false;
  }

  private distanceToSegment(point: StrokePoint, start: StrokePoint, end: StrokePoint): number {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared === 0) {
      const px = point.x - start.x;
      const py = point.y - start.y;
      return Math.sqrt(px * px + py * py);
    }

    let ratio = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
    ratio = Math.max(0, Math.min(1, ratio));
    const closestX = start.x + ratio * dx;
    const closestY = start.y + ratio * dy;
    const offsetX = point.x - closestX;
    const offsetY = point.y - closestY;
    return Math.sqrt(offsetX * offsetX + offsetY * offsetY);
  }

  private pointFromEvent(event: PointerEvent): StrokePoint {
    const rect = this.canvas.getBoundingClientRect();
    const x = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    const y = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;

    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      pressure: event.pressure || (event.pointerType === "pen" ? 0.5 : 0.5)
    };
  }

  private pushHistory(document: AnnotationDocument): void {
    this.undoStack.push(cloneDocument(document));
    if (this.undoStack.length > 100) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }
}
