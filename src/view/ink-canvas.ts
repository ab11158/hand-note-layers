import {
  AnnotationDocument,
  AnnotationLayer,
  AnnotationStroke,
  AnnotationTool,
  EraserMode,
  SelectionMode,
  StrokePoint,
  generateId,
  getActiveLayer
} from "../model/annotation";
import { SelectionBounds, SelectionOverlay } from "./selection-overlay";

export interface InkCanvasViewport {
  documentWidth: number;
  documentHeight: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

export interface InkCanvasOptions {
  getDocument: () => AnnotationDocument;
  getTool: () => AnnotationTool;
  getColor: () => string;
  getSize: () => number;
  getEraserSize: () => number;
  getEraserMode: () => EraserMode;
  getSelectionMode?: () => SelectionMode;
  getPressureEnabled: () => boolean;
  onDocumentChange: (document: AnnotationDocument, renderCanvas?: boolean) => void;
  onInteraction?: (
    type: "stroke-start" | "stroke-end" | "erase" | "selection-delete"
  ) => void;
  onActivate?: () => void;
  onFingerPan?: (deltaX: number, deltaY: number) => void;
  onPencilShortcut?: () => void;
  pageIndex?: number;
}

export interface InkCanvasHistoryState {
  undoStack: InkHistoryEntry[];
  redoStack: InkHistoryEntry[];
}

export interface InkInputDiagnostic {
  event: string;
  time: number;
  pointerId?: number;
  pointerType?: string;
  firstInkMs?: number;
  interStrokeMs?: number;
  detail?: string;
}

type InkHistoryEntry =
  | { kind: "snapshot"; document: AnnotationDocument }
  | {
      kind: "stroke-add";
      layerId: string;
      stroke: AnnotationStroke;
      index: number;
    };

export class InkCanvas {
  private static readonly MAX_CANVAS_PIXELS = 12_000_000;
  private static readonly MAX_CANVAS_DIMENSION = 16_384;
  private static readonly MAX_LASSO_POINTS = 192;
  private static readonly MAX_INPUT_DIAGNOSTICS = 240;

  readonly canvas: HTMLCanvasElement;
  readonly selectionOutline: SVGSVGElement;
  readonly selectionMenu: HTMLDivElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly options: InkCanvasOptions;
  private readonly selectionOverlay: SelectionOverlay;
  private activeStroke: AnnotationStroke | null = null;
  private activePointerId: number | null = null;
  private activePointerKind: "draw" | "pan" | null = null;
  private activeSimpleContact = false;
  private activeTool: AnnotationTool | null = null;
  private eraserChanged = false;
  private undoStack: InkHistoryEntry[] = [];
  private redoStack: InkHistoryEntry[] = [];
  private observer: ResizeObserver | null = null;
  private interactionFrame: number | null = null;
  private resizeFrame: number | null = null;
  private activeRect: DOMRect | null = null;
  private cachedRect: DOMRect | null = null;
  private activeViewport: InkCanvasViewport | null = null;
  private viewport: InkCanvasViewport | null = null;
  private renderedPointCount = 0;
  private pendingEraserPoints: StrokePoint[] = [];
  private panLastX = 0;
  private panLastY = 0;
  private panLastTime = 0;
  private panVelocityX = 0;
  private panVelocityY = 0;
  private panInertiaFrame: number | null = null;
  private publishTimer: number | null = null;
  private pendingPublish: {
    document: AnnotationDocument;
    render: boolean;
    checkLayerOrder: boolean;
  } | null = null;
  private strokeStartedAt = 0;
  private activeStrokeLayerId: string | null = null;
  private activeStrokeLayerOpacity = 1;
  private activeStrokeIndex = -1;
  private activeStrokeDocument: AnnotationDocument | null = null;
  private lastStrokeEndedAt: number | null = null;
  private readonly inputDiagnostics = new Array<InkInputDiagnostic>(
    InkCanvas.MAX_INPUT_DIAGNOSTICS
  );
  private inputDiagnosticCount = 0;
  private inputDiagnosticCursor = 0;
  private lassoPoints: StrokePoint[] = [];
  private selectedStrokeIds = new Set<string>();
  private selectedLayerId: string | null = null;
  private selectionBounds: SelectionBounds | null = null;
  private readonly strokeBounds = new WeakMap<AnnotationStroke, {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }>();

  constructor(options: InkCanvasOptions) {
    this.options = options;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "hand-note-canvas";
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

    this.selectionOverlay = new SelectionOverlay(
      () => this.deleteSelection(),
      () => this.cancelSelection()
    );
    this.selectionOutline = this.selectionOverlay.outline;
    this.selectionMenu = this.selectionOverlay.menu;

    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("pointercancel", this.handlePointerUp);
    this.canvas.addEventListener("lostpointercapture", this.handleLostPointerCapture);
    window.addEventListener("pointerup", this.handlePointerUp);
    window.addEventListener("pointercancel", this.handlePointerUp);
    this.updateInputMode();

    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.scheduleResizeRender());
      this.observer.observe(this.canvas);
    }

    this.render();
  }

  destroy(): void {
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerUp);
    this.canvas.removeEventListener("lostpointercapture", this.handleLostPointerCapture);
    window.removeEventListener("pointerup", this.handlePointerUp);
    window.removeEventListener("pointercancel", this.handlePointerUp);
    this.observer?.disconnect();
    this.selectionOutline.remove();
    this.selectionMenu.remove();
    if (this.interactionFrame !== null) {
      window.cancelAnimationFrame(this.interactionFrame);
    }
    if (this.resizeFrame !== null) {
      window.cancelAnimationFrame(this.resizeFrame);
    }
    this.flushDocumentPublish();
    this.stopPanInertia();
  }

  setDocument(_document: AnnotationDocument): void {
    this.activeStroke = null;
    this.activePointerId = null;
    this.activePointerKind = null;
    this.activeSimpleContact = false;
    this.activeTool = null;
    this.eraserChanged = false;
    this.activeRect = null;
    this.cachedRect = null;
    this.activeViewport = null;
    this.renderedPointCount = 0;
    this.pendingEraserPoints = [];
    this.clearActiveStrokeMetadata();
    this.cancelSelection();
    this.resetHistory();
    this.render();
  }

  updateInputMode(): void {
    const tool = this.options.getTool();
    if (tool !== "select" && this.hasSelection()) {
      this.cancelSelection();
    }
    this.canvas.style.pointerEvents = "auto";
    this.canvas.style.touchAction = "none";
    this.canvas.style.cursor =
      tool === "eraser" ? "cell" : tool === "hand" ? "grab" : "crosshair";
  }

  setViewport(viewport: InkCanvasViewport | null): void {
    this.viewport = viewport;
    if (viewport) {
      this.canvas.style.inset = "auto";
      this.canvas.style.left = `${viewport.offsetX}px`;
      this.canvas.style.top = `${viewport.offsetY}px`;
      this.canvas.style.width = `${viewport.width}px`;
      this.canvas.style.height = `${viewport.height}px`;
    } else {
      this.canvas.style.inset = "0";
      this.canvas.style.left = "";
      this.canvas.style.top = "";
      this.canvas.style.width = "100%";
      this.canvas.style.height = "100%";
    }
    if (this.selectionBounds && this.lassoPoints.length > 2) {
      const dimensions =
        viewport ?? this.currentViewport(this.canvas.getBoundingClientRect());
      this.selectionOverlay.setSelection(
        this.lassoPoints,
        this.selectionBounds,
        dimensions.documentWidth,
        dimensions.documentHeight
      );
    }
    this.render();
  }

  syncInteractionGeometry(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.cachedRect = rect;
    if (this.activePointerKind === "draw") {
      this.activeRect = rect;
      this.activeViewport = this.currentViewport(rect);
    }
  }

  isInteracting(): boolean {
    return this.activePointerKind === "draw";
  }

  getInputDiagnostics(): InkInputDiagnostic[] {
    if (this.inputDiagnosticCount < InkCanvas.MAX_INPUT_DIAGNOSTICS) {
      return this.inputDiagnostics.slice(0, this.inputDiagnosticCount);
    }
    return [
      ...this.inputDiagnostics.slice(this.inputDiagnosticCursor),
      ...this.inputDiagnostics.slice(0, this.inputDiagnosticCursor)
    ];
  }

  hasSelection(): boolean {
    return this.selectedStrokeIds.size > 0;
  }

  cancelSelection(): void {
    this.lassoPoints = [];
    this.selectedStrokeIds.clear();
    this.selectedLayerId = null;
    this.selectionBounds = null;
    this.selectionOverlay.clear();
  }

  deleteSelection(): void {
    if (this.selectedStrokeIds.size === 0) {
      return;
    }
    const document = this.options.getDocument();
    const layer = document.layers.find((item) => item.id === this.selectedLayerId);
    if (!layer) {
      this.cancelSelection();
      return;
    }
    this.pushHistory(document);
    layer.strokes = layer.strokes.filter(
      (stroke) => !this.selectedStrokeIds.has(stroke.id)
    );
    this.cancelSelection();
    this.options.onInteraction?.("selection-delete");
    this.options.onDocumentChange(document);
  }

  selectAll(): void {
    const layer = getActiveLayer(this.options.getDocument());
    const strokes = layer.strokes.filter(
      (stroke) =>
        this.options.pageIndex === undefined ||
        stroke.pageIndex === this.options.pageIndex
    );
    if (strokes.length === 0) {
      this.cancelSelection();
      return;
    }
    this.selectedLayerId = layer.id;
    this.selectedStrokeIds = new Set(strokes.map((stroke) => stroke.id));
    this.selectionBounds = strokes.reduce<SelectionBounds | null>(
      (bounds, stroke) => this.unionBounds(bounds, this.getStrokeBounds(stroke)),
      null
    );
    if (!this.selectionBounds) {
      return;
    }
    this.lassoPoints = [
      { x: this.selectionBounds.minX, y: this.selectionBounds.minY, pressure: 0.5 },
      { x: this.selectionBounds.maxX, y: this.selectionBounds.minY, pressure: 0.5 },
      { x: this.selectionBounds.maxX, y: this.selectionBounds.maxY, pressure: 0.5 },
      { x: this.selectionBounds.minX, y: this.selectionBounds.maxY, pressure: 0.5 }
    ];
    const viewport = this.currentViewport(this.canvas.getBoundingClientRect());
    this.selectionOverlay.setSelection(
      this.lassoPoints,
      this.selectionBounds,
      viewport.documentWidth,
      viewport.documentHeight
    );
  }

  resetHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  getHistoryState(): InkCanvasHistoryState {
    return {
      undoStack: this.undoStack.slice(),
      redoStack: this.redoStack.slice()
    };
  }

  restoreHistoryState(state: InkCanvasHistoryState): void {
    this.undoStack = state.undoStack.slice();
    this.redoStack = state.redoStack.slice();
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) {
      return;
    }

    this.activeStroke = null;
    this.activePointerId = null;
    this.activeTool = null;
    this.eraserChanged = false;
    this.cancelSelection();
    if (previous.kind === "stroke-add") {
      const document = this.options.getDocument();
      const layer = document.layers.find((item) => item.id === previous.layerId);
      if (!layer) {
        return;
      }
      const index = layer.strokes.findIndex((stroke) => stroke.id === previous.stroke.id);
      if (index >= 0) {
        layer.strokes.splice(index, 1);
      }
      this.redoStack.push(previous);
      this.options.onDocumentChange(document);
      return;
    }
    this.redoStack.push({
      kind: "snapshot",
      document: this.snapshotDocument(this.options.getDocument())
    });
    this.options.onDocumentChange(previous.document);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) {
      return;
    }

    this.activeStroke = null;
    this.activePointerId = null;
    this.activeTool = null;
    this.eraserChanged = false;
    this.cancelSelection();
    if (next.kind === "stroke-add") {
      const document = this.options.getDocument();
      const layer = document.layers.find((item) => item.id === next.layerId);
      if (!layer) {
        return;
      }
      const index = Math.max(0, Math.min(layer.strokes.length, next.index));
      layer.strokes.splice(index, 0, next.stroke);
      this.undoStack.push(next);
      this.options.onDocumentChange(document);
      return;
    }
    this.undoStack.push({
      kind: "snapshot",
      document: this.snapshotDocument(this.options.getDocument())
    });
    this.options.onDocumentChange(next.document);
  }

  clearActiveLayer(): void {
    const document = this.options.getDocument();
    const layer = getActiveLayer(document);

    if (layer.strokes.length === 0) {
      return;
    }

    this.pushHistory(document);
    this.cancelSelection();
    layer.strokes = [];
    this.options.onDocumentChange(document);
  }

  recordHistory(): void {
    this.pushHistory(this.options.getDocument());
  }

  render(): void {
    const canvas = this.canvas;
    const rect = canvas.getBoundingClientRect();
    this.cachedRect = rect;
    if (rect.width === 0 || rect.height === 0) {
      return;
    }

    const pixelRatio = this.canvasPixelRatio(rect.width, rect.height);
    const width = Math.max(1, Math.round(rect.width * pixelRatio));
    const height = Math.max(1, Math.round(rect.height * pixelRatio));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    this.context.clearRect(0, 0, rect.width, rect.height);
    const viewport = this.currentViewport(rect);

    const document = this.options.getDocument();
    for (const layer of document.layers) {
      if (!layer.visible || layer.opacity <= 0) {
        continue;
      }

      this.context.save();
      this.context.globalAlpha = layer.opacity;
      if (layer.whiteboard) {
        const bounds = layer.whiteboard.bounds;
        if (
          bounds.pageIndex !== undefined &&
          this.options.pageIndex !== bounds.pageIndex
        ) {
          this.context.restore();
          continue;
        }
        const left = bounds.minX * viewport.documentWidth - viewport.offsetX;
        const top = bounds.minY * viewport.documentHeight - viewport.offsetY;
        const width = (bounds.maxX - bounds.minX) * viewport.documentWidth;
        const height = (bounds.maxY - bounds.minY) * viewport.documentHeight;
        this.context.beginPath();
        this.context.rect(left, top, width, height);
        this.context.clip();
        this.context.fillStyle = layer.whiteboard.background;
        this.context.fillRect(left, top, width, height);
      }
      for (const stroke of layer.strokes) {
        if (this.options.pageIndex !== undefined && stroke.pageIndex !== this.options.pageIndex) {
          continue;
        }
        if (!this.strokeIntersectsViewport(stroke, viewport)) {
          continue;
        }
        this.drawStroke(stroke, viewport, layer.opacity);
      }
      this.context.restore();
    }

    this.context.globalAlpha = 1;
    this.renderedPointCount = this.activeStroke?.points.length ?? 0;
  }

  private drawStroke(
    stroke: AnnotationStroke,
    viewport: InkCanvasViewport,
    layerOpacity: number
  ): void {
    if (stroke.points.length === 0) {
      return;
    }

    const context = this.context;
    context.save();
    context.globalAlpha = layerOpacity * (stroke.opacity ?? this.defaultOpacity(stroke.tool));
    context.globalCompositeOperation =
      stroke.tool === "highlighter" ? "multiply" : "source-over";
    context.lineCap = stroke.tool === "highlighter" ? "square" : "round";
    context.lineJoin = "round";
    context.strokeStyle = stroke.color;

    if (stroke.tool === "eraser") {
      context.strokeStyle = "rgba(0,0,0,0)";
      context.restore();
      return;
    }

    const points = stroke.points;
    if (points.length === 1) {
      const point = points[0];
      context.lineWidth = this.pressureWidth(stroke, points[0].pressure);
      context.beginPath();
      context.arc(
        point.x * viewport.documentWidth - viewport.offsetX,
        point.y * viewport.documentHeight - viewport.offsetY,
        context.lineWidth / 2,
        0,
        Math.PI * 2
      );
      context.fillStyle = stroke.color;
      context.fill();
      context.restore();
      return;
    }

    context.beginPath();
    context.moveTo(
      points[0].x * viewport.documentWidth - viewport.offsetX,
      points[0].y * viewport.documentHeight - viewport.offsetY
    );

    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const previousX = previous.x * viewport.documentWidth - viewport.offsetX;
      const previousY = previous.y * viewport.documentHeight - viewport.offsetY;
      const currentX = current.x * viewport.documentWidth - viewport.offsetX;
      const currentY = current.y * viewport.documentHeight - viewport.offsetY;
      const middleX = (previousX + currentX) / 2;
      const middleY = (previousY + currentY) / 2;
      context.lineWidth = this.pressureWidth(stroke, current.pressure);
      context.quadraticCurveTo(previousX, previousY, middleX, middleY);
    }

    const last = points[points.length - 1];
    context.lineTo(
      last.x * viewport.documentWidth - viewport.offsetX,
      last.y * viewport.documentHeight - viewport.offsetY
    );
    context.stroke();
    context.restore();
  }

  private pressureWidth(stroke: AnnotationStroke, pressure: number): number {
    if (stroke.tool === "highlighter" || !this.options.getPressureEnabled()) {
      return stroke.size;
    }
    const normalized = Number.isFinite(pressure) ? Math.max(0, Math.min(1, pressure)) : 0.5;
    const minimum = stroke.tool === "pencil" ? 0.25 : 0.35;
    const range = stroke.tool === "pencil" ? 1.35 : 1.15;
    return Math.max(1, stroke.size * (minimum + normalized * range));
  }

  private defaultOpacity(tool: AnnotationTool): number {
    if (tool === "highlighter") {
      return 0.32;
    }
    if (tool === "pencil") {
      return 0.78;
    }
    return 1;
  }

  private handlePointerDown = (event: PointerEvent): void => {
    const receivedAt = performance.now();
    this.recordInputDiagnostic({
      event: "pointerdown-received",
      time: receivedAt,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      interStrokeMs:
        this.lastStrokeEndedAt === null ? undefined : receivedAt - this.lastStrokeEndedAt
    });
    if (this.activePointerId !== null) {
      if (event.pointerType !== "pen") {
        this.recordInputDiagnostic({
          event: "pointerdown-rejected",
          time: receivedAt,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          detail: `active-pointer:${this.activePointerId}`
        });
        return;
      }
      this.recordInputDiagnostic({
        event: "stale-pointer-takeover",
        time: receivedAt,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        detail: `replaced-pointer:${this.activePointerId}`
      });
      if (this.activePointerKind === "draw" && this.activeStroke) {
        this.finalizeActiveStroke("superseded");
      } else {
        const stalePointerId = this.activePointerId;
        this.resetPointerState();
        if (stalePointerId !== null && this.canvas.hasPointerCapture(stalePointerId)) {
          this.canvas.releasePointerCapture(stalePointerId);
        }
      }
    }

    this.stopPanInertia();
    if (event.pointerType === "touch") {
      event.preventDefault();
      this.canvas.setPointerCapture(event.pointerId);
      this.activePointerId = event.pointerId;
      this.activePointerKind = "pan";
      this.panLastX = event.clientX;
      this.panLastY = event.clientY;
      this.panLastTime = event.timeStamp || performance.now();
      this.panVelocityX = 0;
      this.panVelocityY = 0;
      return;
    }

    const tool = this.options.getTool();
    if (tool === "hand") {
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
    this.activePointerKind = "draw";
    this.activeSimpleContact = event.pointerType === "pen";
    this.activeTool = tool;
    this.options.onActivate?.();
    this.activeRect = this.cachedRect ?? this.canvas.getBoundingClientRect();
    this.cachedRect = this.activeRect;
    this.activeViewport = this.currentViewport(this.activeRect);
    this.strokeStartedAt = receivedAt;
    this.ensureCanvasReady(this.activeRect);
    this.renderedPointCount = 0;
    this.pendingEraserPoints = [];

    const point = this.pointFromEvent(
      event,
      this.activeRect,
      this.activeViewport
    );
    if (layer.whiteboard && !this.pointInBounds(point, layer.whiteboard.bounds)) {
      this.resetPointerState();
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      return;
    }

    if (tool === "select") {
      this.cancelSelection();
      if (this.options.getSelectionMode?.() === "all") {
        this.selectAll();
        this.resetPointerState();
        if (this.canvas.hasPointerCapture(event.pointerId)) {
          this.canvas.releasePointerCapture(event.pointerId);
        }
        return;
      }
      this.lassoPoints = [point];
      this.updateLassoDraft();
      return;
    }

    if (tool === "eraser") {
      this.pushHistory(document);
      this.pendingEraserPoints.push(point);
      this.scheduleInteractionFrame();
      return;
    }

    this.activeStrokeIndex = layer.strokes.length;
    this.activeStroke = {
      id: generateId(),
      tool,
      color: this.options.getColor(),
      size: this.options.getSize(),
      opacity: this.defaultOpacity(tool),
      points: [point],
      pageIndex: this.options.pageIndex
    };
    this.activeStrokeLayerId = layer.id;
    this.activeStrokeLayerOpacity = layer.opacity;
    this.activeStrokeDocument = document;
    layer.strokes.push(this.activeStroke);
    this.options.onInteraction?.("stroke-start");
    this.flushInteractionFrame();
    const firstInkAt = performance.now();
    this.recordInputDiagnostic({
      event: "first-ink",
      time: firstInkAt,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      firstInkMs: firstInkAt - receivedAt,
      detail: this.activeSimpleContact ? "simple-contact" : undefined
    });
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) {
      return;
    }

    event.preventDefault();
    if (this.activePointerKind === "pan") {
      const deltaX = this.panLastX - event.clientX;
      const deltaY = this.panLastY - event.clientY;
      const now = event.timeStamp || performance.now();
      const elapsed = Math.max(1, now - this.panLastTime);
      const frameScale = 16 / elapsed;
      this.panVelocityX = this.panVelocityX * 0.65 + deltaX * frameScale * 0.35;
      this.panVelocityY = this.panVelocityY * 0.65 + deltaY * frameScale * 0.35;
      this.panLastX = event.clientX;
      this.panLastY = event.clientY;
      this.panLastTime = now;
      this.options.onFingerPan?.(deltaX, deltaY);
      return;
    }
    if (this.activeTool === "select") {
      this.collectLassoPoints(event);
      this.scheduleInteractionFrame();
      return;
    }
    if (this.activeTool === "eraser") {
      this.collectEraserPoints(event);
      this.scheduleInteractionFrame();
      return;
    }

    if (!this.activeStroke) {
      return;
    }

    this.collectStrokePoints(event);
    if (this.activeSimpleContact) {
      this.flushInteractionFrame();
    } else {
      this.scheduleInteractionFrame();
    }
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) {
      return;
    }

    event.preventDefault();
    this.recordInputDiagnostic({
      event: "pointerup-received",
      time: performance.now(),
      pointerId: event.pointerId,
      pointerType: event.pointerType
    });

    if (this.activePointerKind === "pan") {
      const pointerId = event.pointerId;
      const velocityX = this.panVelocityX;
      const velocityY = this.panVelocityY;
      this.resetPointerState();
      if (this.canvas.hasPointerCapture(pointerId)) {
        this.canvas.releasePointerCapture(pointerId);
      }
      if (event.type === "pointerup") {
        this.startPanInertia(velocityX, velocityY);
      }
      return;
    }

    if (this.activeTool === "select") {
      this.collectLassoPoints(event, true);
    } else if (this.activeTool === "eraser") {
      this.collectEraserPoints(event);
    } else if (this.activeStroke) {
      this.collectStrokePoints(event, true);
      this.finalizeActiveStroke("pointerup", event.pointerType);
      return;
    }
    this.flushPendingInteraction();

    if (this.activeTool === "select") {
      this.finalizeLasso();
    } else if (this.activeTool === "eraser") {
      if (this.eraserChanged) {
        this.options.onInteraction?.("erase");
        this.options.onDocumentChange(this.options.getDocument(), false);
      } else {
        this.undoStack.pop();
      }
      this.eraserChanged = false;
    }

    const pointerId = event.pointerId;
    this.resetPointerState();
    if (this.canvas.hasPointerCapture(pointerId)) {
      this.canvas.releasePointerCapture(pointerId);
    }
  };

  private handleLostPointerCapture = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) {
      return;
    }
    this.handlePointerUp(event);
  };

  private resetPointerState(): void {
    this.activePointerId = null;
    this.activePointerKind = null;
    this.activeSimpleContact = false;
    this.activeTool = null;
    this.activeRect = null;
    this.activeViewport = null;
    this.renderedPointCount = 0;
    this.pendingEraserPoints = [];
  }

  private finalizeActiveStroke(reason: string, pointerType = "pen"): void {
    const stroke = this.activeStroke;
    if (!stroke) {
      return;
    }
    this.flushPendingInteraction();
    const document = this.activeStrokeDocument ?? this.options.getDocument();
    const layerId = this.activeStrokeLayerId ?? document.activeLayerId;
    const strokeIndex = Math.max(0, this.activeStrokeIndex);
    const pointerId = this.activePointerId;
    this.activeStroke = null;
    this.resetPointerState();
    if (pointerId !== null && this.canvas.hasPointerCapture(pointerId)) {
      this.canvas.releasePointerCapture(pointerId);
    }
    const endedAt = performance.now();
    this.lastStrokeEndedAt = endedAt;
    this.pushHistoryEntry({
      kind: "stroke-add",
      layerId,
      stroke,
      index: strokeIndex
    });
    this.clearActiveStrokeMetadata();
    this.recordInputDiagnostic({
      event: "stroke-finalized",
      time: endedAt,
      pointerId: pointerId ?? undefined,
      pointerType,
      detail: `${reason};duration:${Math.max(0, endedAt - this.strokeStartedAt).toFixed(2)}ms`
    });
    this.options.onInteraction?.("stroke-end");
    this.scheduleDocumentPublish(document, false, true);
  }

  private startPanInertia(velocityX: number, velocityY: number): void {
    if (!this.options.onFingerPan) {
      return;
    }
    let currentX = velocityX;
    let currentY = velocityY;
    const step = (): void => {
      currentX *= 0.92;
      currentY *= 0.92;
      if (Math.abs(currentX) < 0.18 && Math.abs(currentY) < 0.18) {
        this.panInertiaFrame = null;
        return;
      }
      this.options.onFingerPan?.(currentX, currentY);
      this.panInertiaFrame = window.requestAnimationFrame(step);
    };
    this.panInertiaFrame = window.requestAnimationFrame(step);
  }

  private stopPanInertia(): void {
    if (this.panInertiaFrame !== null) {
      window.cancelAnimationFrame(this.panInertiaFrame);
      this.panInertiaFrame = null;
    }
  }

  private eraseAtPoint(layer: AnnotationLayer, point: StrokePoint): boolean {
    const eraserRadius = this.options.getEraserSize() / 2;
    let removed = false;

    for (let index = layer.strokes.length - 1; index >= 0; index -= 1) {
      const stroke = layer.strokes[index];
      if (
        this.options.pageIndex !== undefined &&
        stroke.pageIndex !== this.options.pageIndex
      ) {
        continue;
      }
      if (!this.strokeHitTest(stroke, point, eraserRadius)) {
        continue;
      }
      if (this.options.getEraserMode() === "stroke") {
        layer.strokes.splice(index, 1);
        removed = true;
        continue;
      }
      const fragments = this.eraseStrokePart(stroke, point, eraserRadius);
      layer.strokes.splice(index, 1, ...fragments);
      removed = true;
    }

    return removed;
  }

  private eraseStrokePart(
    stroke: AnnotationStroke,
    point: StrokePoint,
    radius: number
  ): AnnotationStroke[] {
    const rect = this.activeRect ?? this.canvas.getBoundingClientRect();
    const viewport = this.activeViewport ?? this.currentViewport(rect);
    const eraseX = point.x * viewport.documentWidth;
    const eraseY = point.y * viewport.documentHeight;
    const fragments: StrokePoint[][] = [];
    let current: StrokePoint[] = [];

    const finishFragment = (): void => {
      if (current.length > 0) {
        fragments.push(current);
        current = [];
      }
    };
    const pointDistance = (candidate: StrokePoint): number => {
      const dx = candidate.x * viewport.documentWidth - eraseX;
      const dy = candidate.y * viewport.documentHeight - eraseY;
      return Math.sqrt(dx * dx + dy * dy);
    };

    for (let index = 0; index < stroke.points.length; index += 1) {
      const candidate = stroke.points[index];
      const previous = index > 0 ? stroke.points[index - 1] : null;
      const segmentHit = previous
        ? this.distanceToSegment(
            eraseX,
            eraseY,
            previous.x * viewport.documentWidth,
            previous.y * viewport.documentHeight,
            candidate.x * viewport.documentWidth,
            candidate.y * viewport.documentHeight
          ) <= radius
        : false;
      const candidateHit = pointDistance(candidate) <= radius;
      if (candidateHit || segmentHit) {
        finishFragment();
        if (!candidateHit && segmentHit) {
          current.push(candidate);
        }
        continue;
      }
      current.push(candidate);
    }
    finishFragment();

    return fragments.map((points) => ({
      ...stroke,
      id: generateId(),
      points
    }));
  }

  private strokeHitTest(stroke: AnnotationStroke, point: StrokePoint, radius: number): boolean {
    const rect = this.activeRect ?? this.canvas.getBoundingClientRect();
    const viewport = this.activeViewport ?? this.currentViewport(rect);
    const bounds = this.getStrokeBounds(stroke);
    const radiusX = viewport.documentWidth > 0 ? radius / viewport.documentWidth : 0;
    const radiusY = viewport.documentHeight > 0 ? radius / viewport.documentHeight : 0;
    if (
      point.x < bounds.minX - radiusX ||
      point.x > bounds.maxX + radiusX ||
      point.y < bounds.minY - radiusY ||
      point.y > bounds.maxY + radiusY
    ) {
      return false;
    }

    const pixelX = point.x * viewport.documentWidth;
    const pixelY = point.y * viewport.documentHeight;

    for (let index = 1; index < stroke.points.length; index += 1) {
      const start = stroke.points[index - 1];
      const end = stroke.points[index];
      const distance = this.distanceToSegment(
        pixelX,
        pixelY,
        start.x * viewport.documentWidth,
        start.y * viewport.documentHeight,
        end.x * viewport.documentWidth,
        end.y * viewport.documentHeight
      );
      if (distance <= radius) {
        return true;
      }
    }

    if (stroke.points.length === 1) {
      const start = stroke.points[0];
      const dx = pixelX - start.x * viewport.documentWidth;
      const dy = pixelY - start.y * viewport.documentHeight;
      return Math.sqrt(dx * dx + dy * dy) <= radius;
    }

    return false;
  }

  private distanceToSegment(
    pointX: number,
    pointY: number,
    startX: number,
    startY: number,
    endX: number,
    endY: number
  ): number {
    const dx = endX - startX;
    const dy = endY - startY;
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared === 0) {
      const px = pointX - startX;
      const py = pointY - startY;
      return Math.sqrt(px * px + py * py);
    }

    let ratio = ((pointX - startX) * dx + (pointY - startY) * dy) / lengthSquared;
    ratio = Math.max(0, Math.min(1, ratio));
    const closestX = startX + ratio * dx;
    const closestY = startY + ratio * dy;
    const offsetX = pointX - closestX;
    const offsetY = pointY - closestY;
    return Math.sqrt(offsetX * offsetX + offsetY * offsetY);
  }

  private pointFromEvent(
    event: PointerEvent,
    rect = this.canvas.getBoundingClientRect(),
    viewport = this.currentViewport(rect)
  ): StrokePoint {
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const x =
      viewport.documentWidth > 0
        ? (viewport.offsetX + localX) / viewport.documentWidth
        : 0;
    const y =
      viewport.documentHeight > 0
        ? (viewport.offsetY + localY) / viewport.documentHeight
        : 0;

    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      pressure: this.activeSimpleContact ? 0.5 : event.pressure || 0.5
    };
  }

  private recordInputDiagnostic(entry: InkInputDiagnostic): void {
    this.inputDiagnostics[this.inputDiagnosticCursor] = entry;
    this.inputDiagnosticCursor =
      (this.inputDiagnosticCursor + 1) % InkCanvas.MAX_INPUT_DIAGNOSTICS;
    this.inputDiagnosticCount = Math.min(
      InkCanvas.MAX_INPUT_DIAGNOSTICS,
      this.inputDiagnosticCount + 1
    );
  }

  private scheduleDocumentPublish(
    document: AnnotationDocument,
    render: boolean,
    checkLayerOrder = false
  ): void {
    this.pendingPublish = {
      document,
      render: (this.pendingPublish?.render ?? false) || render,
      checkLayerOrder: (this.pendingPublish?.checkLayerOrder ?? false) || checkLayerOrder
    };
    if (this.publishTimer !== null) {
      return;
    }
    this.publishTimer = window.setTimeout(() => {
      this.publishTimer = null;
      if (this.activePointerKind === "draw") {
        this.scheduleDocumentPublish(
          this.pendingPublish?.document ?? document,
          this.pendingPublish?.render ?? render,
          this.pendingPublish?.checkLayerOrder ?? checkLayerOrder
        );
        return;
      }
      this.flushDocumentPublish();
    }, 64);
  }

  private flushDocumentPublish(): void {
    if (this.publishTimer !== null) {
      window.clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }
    const pending = this.pendingPublish;
    this.pendingPublish = null;
    if (!pending) {
      return;
    }
    const render =
      pending.render ||
      (pending.checkLayerOrder && this.needsLayerOrderRefresh(pending.document));
    this.options.onDocumentChange(pending.document, render);
    this.recordInputDiagnostic({
      event: "document-published",
      time: performance.now(),
      detail: render ? "render" : "incremental"
    });
  }

  private pushHistory(document: AnnotationDocument): void {
    this.pushHistoryEntry({ kind: "snapshot", document: this.snapshotDocument(document) });
  }

  private pushHistoryEntry(entry: InkHistoryEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > 100) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  private snapshotDocument(document: AnnotationDocument): AnnotationDocument {
    return {
      ...document,
      layers: document.layers.map((layer) => ({
        ...layer,
        strokes: layer.strokes.slice()
      }))
    };
  }

  private canvasPixelRatio(width: number, height: number): number {
    const preferred = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
    const areaLimit = Math.sqrt(
      InkCanvas.MAX_CANVAS_PIXELS / Math.max(width * height, 1)
    );
    const dimensionLimit =
      InkCanvas.MAX_CANVAS_DIMENSION / Math.max(width, height, 1);
    return Math.max(0.1, Math.min(preferred, areaLimit, dimensionLimit));
  }

  private scheduleResizeRender(): void {
    if (this.resizeFrame !== null) {
      return;
    }
    this.resizeFrame = window.requestAnimationFrame(() => {
      this.resizeFrame = null;
      this.render();
    });
  }

  private scheduleInteractionFrame(): void {
    if (this.interactionFrame !== null) {
      return;
    }
    this.interactionFrame = window.requestAnimationFrame(() => {
      this.interactionFrame = null;
      this.flushInteractionFrame();
    });
  }

  private flushPendingInteraction(): void {
    if (this.interactionFrame !== null) {
      window.cancelAnimationFrame(this.interactionFrame);
      this.interactionFrame = null;
    }
    this.flushInteractionFrame();
  }

  private flushInteractionFrame(): void {
    if (this.activeTool === "select") {
      this.updateLassoDraft();
      return;
    }
    if (this.activeTool === "eraser") {
      const layer = getActiveLayer(this.options.getDocument());
      let changed = false;
      for (const point of this.pendingEraserPoints) {
        changed = this.eraseAtPoint(layer, point) || changed;
      }
      this.pendingEraserPoints = [];
      if (changed) {
        this.eraserChanged = true;
        this.render();
      }
      return;
    }

    if (!this.activeStroke || this.renderedPointCount >= this.activeStroke.points.length) {
      return;
    }

    const rect = this.activeRect ?? this.canvas.getBoundingClientRect();
    const viewport = this.activeViewport ?? this.currentViewport(rect);
    this.drawStrokeIncrement(
      this.activeStroke,
      this.renderedPointCount,
      viewport,
      this.activeStrokeLayerOpacity
    );
    this.renderedPointCount = this.activeStroke.points.length;
  }

  private drawStrokeIncrement(
    stroke: AnnotationStroke,
    fromIndex: number,
    viewport: InkCanvasViewport,
    layerOpacity: number
  ): void {
    const points = stroke.points;
    if (points.length === 0 || viewport.width <= 0 || viewport.height <= 0) {
      return;
    }

    const context = this.context;
    context.save();
    context.globalAlpha = layerOpacity * (stroke.opacity ?? this.defaultOpacity(stroke.tool));
    context.globalCompositeOperation =
      stroke.tool === "highlighter" ? "multiply" : "source-over";
    context.lineCap = stroke.tool === "highlighter" ? "butt" : "round";
    context.lineJoin = "round";
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;

    if (fromIndex === 0) {
      const first = points[0];
      const radius = this.pressureWidth(stroke, first.pressure) / 2;
      context.beginPath();
      const firstX = first.x * viewport.documentWidth - viewport.offsetX;
      const firstY = first.y * viewport.documentHeight - viewport.offsetY;
      if (stroke.tool === "highlighter") {
        context.fillRect(firstX - radius, firstY - radius, radius * 2, radius * 2);
      } else {
        context.arc(firstX, firstY, radius, 0, Math.PI * 2);
        context.fill();
      }
    }

    let pathOpen = false;
    let batchWidth = 0;
    for (let index = Math.max(1, fromIndex); index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const width =
        (this.pressureWidth(stroke, previous.pressure) +
          this.pressureWidth(stroke, current.pressure)) /
        2;
      if (!pathOpen || Math.abs(width - batchWidth) >= 0.75) {
        if (pathOpen) {
          context.stroke();
        }
        batchWidth = width;
        context.lineWidth = batchWidth;
        context.beginPath();
        context.moveTo(
          previous.x * viewport.documentWidth - viewport.offsetX,
          previous.y * viewport.documentHeight - viewport.offsetY
        );
        pathOpen = true;
      }
      context.lineTo(
        current.x * viewport.documentWidth - viewport.offsetX,
        current.y * viewport.documentHeight - viewport.offsetY
      );
    }
    if (pathOpen) {
      context.stroke();
    }
    context.restore();
  }

  private collectStrokePoints(event: PointerEvent, forceLastPoint = false): void {
    if (!this.activeStroke || !this.activeRect || !this.activeViewport) {
      return;
    }

    const samples = this.coalescedEvents(event);
    for (let index = 0; index < samples.length; index += 1) {
      const force = forceLastPoint && index === samples.length - 1;
      const point = this.pointFromEvent(
        samples[index],
        this.activeRect,
        this.activeViewport
      );
      const lastPoint = this.activeStroke.points[this.activeStroke.points.length - 1];
      if (this.isInvalidOriginJump(samples[index], point, lastPoint)) {
        continue;
      }
      if (force && samples[index].pressure === 0) {
        point.pressure =
          this.activeStroke.points[this.activeStroke.points.length - 1].pressure;
      }
      this.appendStrokePoint(point, force);
    }
  }

  private appendStrokePoint(point: StrokePoint, force: boolean): void {
    if (!this.activeStroke || !this.activeRect || !this.activeViewport) {
      return;
    }

    const last = this.activeStroke.points[this.activeStroke.points.length - 1];
    const dx = (point.x - last.x) * this.activeViewport.documentWidth;
    const dy = (point.y - last.y) * this.activeViewport.documentHeight;
    const distanceSquared = dx * dx + dy * dy;
    const pressureChanged = Math.abs(point.pressure - last.pressure) >= 0.025;
    if (!force && distanceSquared < 0.25 && !pressureChanged) {
      return;
    }
    if (force && distanceSquared < 0.01 && !pressureChanged) {
      return;
    }
    this.activeStroke.points.push(point);
  }

  private collectEraserPoints(event: PointerEvent): void {
    if (!this.activeRect || !this.activeViewport) {
      return;
    }

    for (const sample of this.coalescedEvents(event)) {
      const point = this.pointFromEvent(sample, this.activeRect, this.activeViewport);
      const last = this.pendingEraserPoints[this.pendingEraserPoints.length - 1];
      if (this.isInvalidOriginJump(sample, point, last)) {
        continue;
      }
      if (last) {
        const dx = (point.x - last.x) * this.activeViewport.documentWidth;
        const dy = (point.y - last.y) * this.activeViewport.documentHeight;
        if (dx * dx + dy * dy < 4) {
          continue;
        }
      }
      this.pendingEraserPoints.push(point);
    }
  }

  private coalescedEvents(event: PointerEvent): PointerEvent[] {
    if (this.activeSimpleContact) {
      return this.hasUsableCoordinates(event) ? [event] : [];
    }
    const samples = event.getCoalescedEvents?.();
    if (!samples || samples.length === 0) {
      return this.hasUsableCoordinates(event) ? [event] : [];
    }

    const usable = samples.filter(
      (sample) =>
        this.hasUsableCoordinates(sample) &&
        !(
          sample.clientX === 0 &&
          sample.clientY === 0 &&
          (event.clientX !== 0 || event.clientY !== 0)
        )
    );
    if (this.hasUsableCoordinates(event)) {
      const last = usable[usable.length - 1];
      if (!last || last.clientX !== event.clientX || last.clientY !== event.clientY) {
        usable.push(event);
      }
    }
    return usable;
  }

  private hasUsableCoordinates(event: PointerEvent): boolean {
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
      return false;
    }
    const rect = this.activeRect;
    if (!rect) {
      return true;
    }
    const tolerance = 2;
    return (
      event.clientX >= rect.left - tolerance &&
      event.clientX <= rect.left + rect.width + tolerance &&
      event.clientY >= rect.top - tolerance &&
      event.clientY <= rect.top + rect.height + tolerance
    );
  }

  private isInvalidOriginJump(
    event: PointerEvent,
    point: StrokePoint,
    previous: StrokePoint | undefined
  ): boolean {
    if (!previous || event.clientX !== 0 || event.clientY !== 0) {
      return false;
    }
    const viewport = this.activeViewport;
    if (!viewport) {
      return false;
    }
    const dx = (point.x - previous.x) * viewport.documentWidth;
    const dy = (point.y - previous.y) * viewport.documentHeight;
    return dx * dx + dy * dy > 64 * 64;
  }

  private collectLassoPoints(event: PointerEvent, forceLastPoint = false): void {
    if (!this.activeRect || !this.activeViewport) {
      return;
    }
    const samples = this.coalescedEvents(event);
    if (this.options.getSelectionMode?.() === "rectangle") {
      const sample = samples[samples.length - 1];
      const start = this.lassoPoints[0];
      if (!sample || !start) {
        return;
      }
      const current = this.pointFromEvent(sample, this.activeRect, this.activeViewport);
      this.lassoPoints = [
        start,
        { ...start, x: current.x },
        current,
        { ...current, x: start.x }
      ];
      return;
    }
    for (let index = 0; index < samples.length; index += 1) {
      const point = this.pointFromEvent(
        samples[index],
        this.activeRect,
        this.activeViewport
      );
      const last = this.lassoPoints[this.lassoPoints.length - 1];
      if (this.isInvalidOriginJump(samples[index], point, last)) {
        continue;
      }
      if (last) {
        const dx = (point.x - last.x) * this.activeViewport.documentWidth;
        const dy = (point.y - last.y) * this.activeViewport.documentHeight;
        const force = forceLastPoint && index === samples.length - 1;
        if (!force && dx * dx + dy * dy < 4) {
          continue;
        }
      }
      this.lassoPoints.push(point);
      if (this.lassoPoints.length > InkCanvas.MAX_LASSO_POINTS) {
        this.lassoPoints = this.lassoPoints.filter(
          (_, pointIndex) => pointIndex === 0 || pointIndex % 2 === 0
        );
      }
    }
  }

  private updateLassoDraft(): void {
    const viewport =
      this.activeViewport ?? this.currentViewport(this.canvas.getBoundingClientRect());
    this.selectionOverlay.setDraft(
      this.lassoPoints,
      viewport.documentWidth,
      viewport.documentHeight
    );
  }

  private finalizeLasso(): void {
    const viewport =
      this.activeViewport ?? this.currentViewport(this.canvas.getBoundingClientRect());
    if (this.lassoPoints.length < 3) {
      this.cancelSelection();
      return;
    }

    const lassoBounds = this.boundsForPoints(this.lassoPoints);
    const width = (lassoBounds.maxX - lassoBounds.minX) * viewport.documentWidth;
    const height = (lassoBounds.maxY - lassoBounds.minY) * viewport.documentHeight;
    if (width < 8 && height < 8) {
      this.cancelSelection();
      return;
    }

    const layer = getActiveLayer(this.options.getDocument());
    this.selectedLayerId = layer.id;
    this.selectedStrokeIds.clear();
    let selectedBounds: SelectionBounds | null = null;
    for (const stroke of layer.strokes) {
      if (
        this.options.pageIndex !== undefined &&
        stroke.pageIndex !== this.options.pageIndex
      ) {
        continue;
      }
      if (!this.strokeTouchesLasso(stroke, lassoBounds)) {
        continue;
      }
      this.selectedStrokeIds.add(stroke.id);
      selectedBounds = this.unionBounds(selectedBounds, this.getStrokeBounds(stroke));
    }

    if (!selectedBounds || this.selectedStrokeIds.size === 0) {
      this.cancelSelection();
      return;
    }
    this.selectionBounds = selectedBounds;
    this.selectionOverlay.setSelection(
      this.lassoPoints,
      selectedBounds,
      viewport.documentWidth,
      viewport.documentHeight
    );
  }

  private strokeTouchesLasso(
    stroke: AnnotationStroke,
    lassoBounds: SelectionBounds
  ): boolean {
    const strokeBounds = this.getStrokeBounds(stroke);
    if (!this.boundsIntersect(strokeBounds, lassoBounds)) {
      return false;
    }
    if (stroke.points.some((point) => this.pointInPolygon(point, this.lassoPoints))) {
      return true;
    }
    for (let strokeIndex = 1; strokeIndex < stroke.points.length; strokeIndex += 1) {
      const strokeStart = stroke.points[strokeIndex - 1];
      const strokeEnd = stroke.points[strokeIndex];
      for (let lassoIndex = 0; lassoIndex < this.lassoPoints.length; lassoIndex += 1) {
        const lassoStart = this.lassoPoints[lassoIndex];
        const lassoEnd = this.lassoPoints[(lassoIndex + 1) % this.lassoPoints.length];
        if (this.segmentsIntersect(strokeStart, strokeEnd, lassoStart, lassoEnd)) {
          return true;
        }
      }
    }
    return false;
  }

  private pointInPolygon(point: StrokePoint, polygon: StrokePoint[]): boolean {
    let inside = false;
    for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
      const currentPoint = polygon[current];
      const previousPoint = polygon[previous];
      const crosses =
        currentPoint.y > point.y !== previousPoint.y > point.y &&
        point.x <
          ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
            (previousPoint.y - currentPoint.y || Number.EPSILON) +
            currentPoint.x;
      if (crosses) {
        inside = !inside;
      }
    }
    return inside;
  }

  private segmentsIntersect(
    firstStart: StrokePoint,
    firstEnd: StrokePoint,
    secondStart: StrokePoint,
    secondEnd: StrokePoint
  ): boolean {
    const epsilon = 1e-10;
    const direction = (a: StrokePoint, b: StrokePoint, c: StrokePoint): number =>
      (c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x);
    const onSegment = (a: StrokePoint, b: StrokePoint, point: StrokePoint): boolean =>
      point.x >= Math.min(a.x, b.x) - epsilon &&
      point.x <= Math.max(a.x, b.x) + epsilon &&
      point.y >= Math.min(a.y, b.y) - epsilon &&
      point.y <= Math.max(a.y, b.y) + epsilon;
    const firstA = direction(firstStart, firstEnd, secondStart);
    const firstB = direction(firstStart, firstEnd, secondEnd);
    const secondA = direction(secondStart, secondEnd, firstStart);
    const secondB = direction(secondStart, secondEnd, firstEnd);
    if (
      ((firstA > epsilon && firstB < -epsilon) ||
        (firstA < -epsilon && firstB > epsilon)) &&
      ((secondA > epsilon && secondB < -epsilon) ||
        (secondA < -epsilon && secondB > epsilon))
    ) {
      return true;
    }
    return (
      (Math.abs(firstA) <= epsilon && onSegment(firstStart, firstEnd, secondStart)) ||
      (Math.abs(firstB) <= epsilon && onSegment(firstStart, firstEnd, secondEnd)) ||
      (Math.abs(secondA) <= epsilon && onSegment(secondStart, secondEnd, firstStart)) ||
      (Math.abs(secondB) <= epsilon && onSegment(secondStart, secondEnd, firstEnd))
    );
  }

  private boundsForPoints(points: StrokePoint[]): SelectionBounds {
    let minX = 1;
    let minY = 1;
    let maxX = 0;
    let maxY = 0;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    return { minX, minY, maxX, maxY };
  }

  private unionBounds(
    first: SelectionBounds | null,
    second: SelectionBounds
  ): SelectionBounds {
    if (!first) {
      return { ...second };
    }
    return {
      minX: Math.min(first.minX, second.minX),
      minY: Math.min(first.minY, second.minY),
      maxX: Math.max(first.maxX, second.maxX),
      maxY: Math.max(first.maxY, second.maxY)
    };
  }

  private boundsIntersect(first: SelectionBounds, second: SelectionBounds): boolean {
    return !(
      first.maxX < second.minX ||
      first.minX > second.maxX ||
      first.maxY < second.minY ||
      first.minY > second.maxY
    );
  }

  private pointInBounds(point: StrokePoint, bounds: SelectionBounds): boolean {
    return (
      point.x >= bounds.minX &&
      point.x <= bounds.maxX &&
      point.y >= bounds.minY &&
      point.y <= bounds.maxY
    );
  }

  private currentViewport(rect: DOMRect): InkCanvasViewport {
    return (
      this.viewport ?? {
        documentWidth: rect.width,
        documentHeight: rect.height,
        offsetX: 0,
        offsetY: 0,
        width: rect.width,
        height: rect.height
      }
    );
  }

  private strokeIntersectsViewport(
    stroke: AnnotationStroke,
    viewport: InkCanvasViewport
  ): boolean {
    const bounds = this.getStrokeBounds(stroke);
    const viewportBounds: SelectionBounds = {
      minX: viewport.offsetX / viewport.documentWidth,
      minY: viewport.offsetY / viewport.documentHeight,
      maxX: (viewport.offsetX + viewport.width) / viewport.documentWidth,
      maxY: (viewport.offsetY + viewport.height) / viewport.documentHeight
    };
    return this.boundsIntersect(bounds, viewportBounds);
  }

  private ensureCanvasReady(rect: DOMRect): void {
    const pixelRatio = this.canvasPixelRatio(rect.width, rect.height);
    const width = Math.max(1, Math.round(rect.width * pixelRatio));
    const height = Math.max(1, Math.round(rect.height * pixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.render();
    }
  }

  private clearActiveStrokeMetadata(): void {
    this.activeStrokeLayerId = null;
    this.activeStrokeLayerOpacity = 1;
    this.activeStrokeIndex = -1;
    this.activeStrokeDocument = null;
  }

  private needsLayerOrderRefresh(document: AnnotationDocument): boolean {
    const activeLayerIndex = document.layers.findIndex(
      (layer) => layer.id === document.activeLayerId
    );
    if (activeLayerIndex < 0) {
      return false;
    }
    return document.layers.slice(activeLayerIndex + 1).some(
      (layer) =>
        layer.visible &&
        layer.opacity > 0 &&
        layer.strokes.some(
          (stroke) =>
            this.options.pageIndex === undefined ||
            stroke.pageIndex === this.options.pageIndex
        )
    );
  }

  private getStrokeBounds(stroke: AnnotationStroke): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } {
    const cached = this.strokeBounds.get(stroke);
    if (cached) {
      return cached;
    }

    let minX = 1;
    let minY = 1;
    let maxX = 0;
    let maxY = 0;
    for (const point of stroke.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    const bounds = { minX, minY, maxX, maxY };
    this.strokeBounds.set(stroke, bounds);
    return bounds;
  }
}
