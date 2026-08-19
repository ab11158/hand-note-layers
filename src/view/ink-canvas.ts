import { Notice, setIcon } from "obsidian";
import {
  AnnotationDocument,
  AnnotationLayer,
  AnnotationStroke,
  AnnotationTool,
  EraserMode,
  SelectionMode,
  ShapeKind,
  StrokePoint,
  generateId,
  getActiveLayer
} from "../model/annotation";
import { SelectionBounds, SelectionOverlay } from "./selection-overlay";
import { drawFreehandStroke } from "./freehand-renderer";
import { ShapeOverlay } from "./shape-overlay";

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
  getShapeKind?: () => ShapeKind;
  getPressureEnabled: () => boolean;
  onDocumentChange: (document: AnnotationDocument, renderCanvas?: boolean) => void;
  onInteraction?: (
    type: "stroke-start" | "stroke-end" | "erase" | "selection-delete"
  ) => void;
  onActivate?: () => void;
  onFingerPan?: (deltaX: number, deltaY: number) => void;
  onPencilShortcut?: () => void;
  onRequestTool?: (tool: AnnotationTool) => void;
  pageIndex?: number;
}

export interface InkCanvasHistoryState {
  undoStack: InkHistoryEntry[];
  redoStack: InkHistoryEntry[];
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
  private static readonly PENCIL_COMPATIBILITY_GUARD_MS = 500;
  private static selectionClipboard: {
    strokes: AnnotationStroke[];
    bounds: SelectionBounds;
  } | null = null;

  readonly canvas: HTMLCanvasElement;
  readonly liveCanvas: HTMLCanvasElement;
  readonly selectionLayer: HTMLDivElement;
  readonly selectionOutline: SVGSVGElement;
  readonly selectionMenu: HTMLDivElement;
  readonly selectionTransform: HTMLDivElement;
  readonly shapeControls: HTMLDivElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly liveContext: CanvasRenderingContext2D;
  private readonly options: InkCanvasOptions;
  private readonly selectionOverlay: SelectionOverlay;
  private readonly shapeOverlay: ShapeOverlay;
  private readonly textEditorPortal: HTMLDivElement;
  private readonly textEditor: HTMLTextAreaElement;
  private activeStroke: AnnotationStroke | null = null;
  private activePointerId: number | null = null;
  private activePointerKind: "draw" | "pan" | null = null;
  private activeInputChannel: "pointer" | "stylus-touch" | null = null;
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
  private activeStrokeLayerId: string | null = null;
  private activeStrokeLayerOpacity = 1;
  private activeStrokeIndex = -1;
  private activeStrokeDocument: AnnotationDocument | null = null;
  private activeStrokePathLength = 0;
  private activeSmoothedPressure = 0.5;
  private lastStylusActivityAt = Number.NEGATIVE_INFINITY;
  private lassoPoints: StrokePoint[] = [];
  private selectedStrokeIds = new Set<string>();
  private selectedLayerId: string | null = null;
  private selectionBounds: SelectionBounds | null = null;
  private selectedShapeId: string | null = null;
  private selectedShapeLayerId: string | null = null;
  private shapeEditState: {
    pointerId: number;
    layerId: string;
    strokeId: string;
    pointIndex: number;
    changed: boolean;
  } | null = null;
  private editingText: {
    layerId: string;
    strokeId: string;
    created: boolean;
    original: {
      text?: string;
      color: string;
      size: number;
      fontSize?: number;
      points: StrokePoint[];
    };
  } | null = null;
  private textEditorScrollLock: {
    target: HTMLElement | null;
    scrollLeft: number;
    scrollTop: number;
    overflow: string;
    overscrollBehavior: string;
    windowX: number;
    windowY: number;
  } | null = null;
  private textLongPress: {
    pointerId: number;
    pointerType: string;
    layerId: string;
    strokeId: string;
    startX: number;
    startY: number;
    mode: "touch-pan" | "pen-text" | "pen-select";
    timer: number;
  } | null = null;
  private selectionTransformState: {
    pointerId: number;
    handle: string;
    startX: number;
    startY: number;
    bounds: SelectionBounds;
    points: Map<string, StrokePoint[]>;
    textSizes: Map<string, { fontSize: number; size: number }>;
    startAngle: number;
    changed: boolean;
  } | null = null;
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

    this.liveCanvas = document.createElement("canvas");
    this.liveCanvas.className = "hand-note-canvas hand-note-live-canvas";
    this.liveCanvas.style.position = "absolute";
    this.liveCanvas.style.inset = "0";
    this.liveCanvas.style.width = "100%";
    this.liveCanvas.style.height = "100%";
    this.liveCanvas.style.pointerEvents = "none";
    this.liveCanvas.style.zIndex = "4";
    const liveContext = this.liveCanvas.getContext("2d");
    if (!liveContext) {
      throw new Error("Unable to create live ink context");
    }
    this.liveContext = liveContext;

    this.selectionOverlay = new SelectionOverlay(
      () => this.deleteSelection(),
      () => this.cancelSelection(),
      () => this.duplicateSelection(),
      () => this.copySelection(),
      () => this.cutSelection(),
      () => this.pasteSelection(),
      (color) => this.setSelectionColor(color),
      () => void this.exportSelectionScreenshot(),
      (event, handle) => this.beginSelectionTransform(event, handle)
    );
    this.selectionOverlay.setPasteEnabled(InkCanvas.selectionClipboard !== null);
    this.selectionLayer = this.selectionOverlay.element;
    this.selectionOutline = this.selectionOverlay.outline;
    this.selectionMenu = this.selectionOverlay.menu;
    this.selectionTransform = this.selectionOverlay.transformBox;
    this.shapeOverlay = new ShapeOverlay((event, pointIndex) =>
      this.beginShapeAnchorDrag(event, pointIndex)
    );
    this.shapeControls = this.shapeOverlay.element;
    this.textEditorPortal = document.createElement("div");
    this.textEditorPortal.className = "hand-note-text-editor-portal";
    const textEditorHeader = document.createElement("div");
    textEditorHeader.className = "hand-note-text-editor-header";
    const textEditorTitle = document.createElement("strong");
    textEditorTitle.textContent = "编辑文本";
    const textEditorActions = document.createElement("div");
    textEditorActions.className = "hand-note-text-editor-actions";
    const cancelTextButton = document.createElement("button");
    cancelTextButton.type = "button";
    cancelTextButton.className = "clickable-icon";
    cancelTextButton.setAttribute("aria-label", "取消文本编辑");
    cancelTextButton.setAttribute("title", "取消文本编辑");
    setIcon(cancelTextButton, "x");
    cancelTextButton.addEventListener("click", () => this.cancelTextEditor());
    const completeTextButton = document.createElement("button");
    completeTextButton.type = "button";
    completeTextButton.className = "clickable-icon mod-cta";
    completeTextButton.setAttribute("aria-label", "完成文本编辑");
    completeTextButton.setAttribute("title", "完成文本编辑");
    setIcon(completeTextButton, "check");
    completeTextButton.addEventListener("click", this.commitTextEditor);
    textEditorActions.append(cancelTextButton, completeTextButton);
    textEditorHeader.append(textEditorTitle, textEditorActions);
    this.textEditor = document.createElement("textarea");
    this.textEditor.className = "hand-note-text-editor";
    this.textEditor.setAttribute("aria-label", "编辑文本框");
    this.textEditor.placeholder = "在此输入文本…";
    this.textEditor.addEventListener("input", this.handleTextEditorInput);
    this.textEditor.addEventListener("keydown", this.handleTextEditorKeyDown);
    this.textEditorPortal.append(textEditorHeader, this.textEditor);

    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("pointercancel", this.handlePointerCancel);
    this.canvas.addEventListener("lostpointercapture", this.handleLostPointerCapture);
    this.canvas.addEventListener("gotpointercapture", this.handlePointerCaptureChange);
    this.canvas.addEventListener("lostpointercapture", this.handlePointerCaptureChange);
    window.addEventListener("pointerdown", this.handleWindowPointerDownCapture, true);
    window.addEventListener("pointermove", this.handleWindowPointerMoveCapture, true);
    window.addEventListener("pointerup", this.handleWindowPointerEndCapture, true);
    window.addEventListener("pointercancel", this.handleWindowPointerEndCapture, true);
    window.addEventListener("pointerup", this.handlePointerUp);
    window.addEventListener("pointercancel", this.handlePointerCancel);
    window.addEventListener("touchstart", this.handleWindowTouchCapture, {
      capture: true,
      passive: false
    });
    window.addEventListener("touchmove", this.handleWindowTouchCapture, {
      capture: true,
      passive: false
    });
    window.addEventListener("touchend", this.handleWindowTouchCapture, {
      capture: true,
      passive: false
    });
    window.addEventListener("touchcancel", this.handleWindowTouchCapture, {
      capture: true,
      passive: false
    });
    window.addEventListener("mousedown", this.handleCompatibilityMouseCapture, true);
    window.addEventListener("mouseup", this.handleCompatibilityMouseCapture, true);
    window.addEventListener("click", this.handleCompatibilityMouseCapture, true);
    window.addEventListener("dblclick", this.handleCompatibilityMouseCapture, true);
    window.addEventListener("contextmenu", this.handleCompatibilityMouseCapture, true);
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
    this.canvas.removeEventListener("pointercancel", this.handlePointerCancel);
    this.canvas.removeEventListener("lostpointercapture", this.handleLostPointerCapture);
    this.canvas.removeEventListener("gotpointercapture", this.handlePointerCaptureChange);
    this.canvas.removeEventListener("lostpointercapture", this.handlePointerCaptureChange);
    window.removeEventListener("pointerdown", this.handleWindowPointerDownCapture, true);
    window.removeEventListener("pointermove", this.handleWindowPointerMoveCapture, true);
    window.removeEventListener("pointerup", this.handleWindowPointerEndCapture, true);
    window.removeEventListener("pointercancel", this.handleWindowPointerEndCapture, true);
    window.removeEventListener("pointerup", this.handlePointerUp);
    window.removeEventListener("pointercancel", this.handlePointerCancel);
    window.removeEventListener("touchstart", this.handleWindowTouchCapture, true);
    window.removeEventListener("touchmove", this.handleWindowTouchCapture, true);
    window.removeEventListener("touchend", this.handleWindowTouchCapture, true);
    window.removeEventListener("touchcancel", this.handleWindowTouchCapture, true);
    window.removeEventListener("mousedown", this.handleCompatibilityMouseCapture, true);
    window.removeEventListener("mouseup", this.handleCompatibilityMouseCapture, true);
    window.removeEventListener("click", this.handleCompatibilityMouseCapture, true);
    window.removeEventListener("dblclick", this.handleCompatibilityMouseCapture, true);
    window.removeEventListener("contextmenu", this.handleCompatibilityMouseCapture, true);
    this.observer?.disconnect();
    this.cancelTextLongPress();
    this.unlockTextEditorScroll();
    window.visualViewport?.removeEventListener("resize", this.positionTextEditor);
    window.visualViewport?.removeEventListener("scroll", this.positionTextEditor);
    window.removeEventListener("resize", this.positionTextEditor);
    this.selectionOverlay.destroy();
    this.shapeControls.remove();
    this.textEditorPortal.remove();
    this.liveCanvas.remove();
    if (this.interactionFrame !== null) {
      window.cancelAnimationFrame(this.interactionFrame);
    }
    if (this.resizeFrame !== null) {
      window.cancelAnimationFrame(this.resizeFrame);
    }
    this.finalizeActiveStroke();
    this.flushDocumentPublish();
    this.stopPanInertia();
    this.endSelectionTransform();
  }

  setDocument(_document: AnnotationDocument): void {
    this.finalizeActiveStroke();
    this.activeStroke = null;
    this.activePointerId = null;
    this.activePointerKind = null;
    this.activeInputChannel = null;
    this.activeTool = null;
    this.eraserChanged = false;
    this.activeRect = null;
    this.cachedRect = null;
    this.activeViewport = null;
    this.renderedPointCount = 0;
    this.pendingEraserPoints = [];
    this.clearActiveStrokeMetadata();
    this.clearLiveCanvas();
    this.cancelSelection();
    this.clearShapeSelection();
    this.closeTextEditor();
    this.resetHistory();
    this.render();
  }

  updateInputMode(): void {
    const tool = this.options.getTool();
    if (tool !== "select" && this.hasSelection()) {
      this.cancelSelection();
    }
    if (tool !== "shape") {
      this.clearShapeSelection();
    }
    if (tool !== "text") {
      this.commitTextEditor();
    }
    this.canvas.style.pointerEvents = "auto";
    this.canvas.style.touchAction = "none";
    this.canvas.style.cursor =
      tool === "eraser" ? "cell" : tool === "hand" ? "grab" : "crosshair";
  }

  setViewport(viewport: InkCanvasViewport | null): void {
    this.viewport = viewport;
    const canvases = [this.canvas, this.liveCanvas];
    if (viewport) {
      for (const canvas of canvases) {
        canvas.style.inset = "auto";
        canvas.style.left = `${viewport.offsetX}px`;
        canvas.style.top = `${viewport.offsetY}px`;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
      }
    } else {
      for (const canvas of canvases) {
        canvas.style.inset = "0";
        canvas.style.left = "";
        canvas.style.top = "";
        canvas.style.width = "100%";
        canvas.style.height = "100%";
      }
    }
    if (this.selectionBounds && this.lassoPoints.length > 2) {
      const dimensions =
        viewport ?? this.currentViewport(this.canvas.getBoundingClientRect());
      this.selectionOverlay.setSelection(
        this.lassoPoints,
        this.selectionBounds,
        dimensions,
        this.canvas.getBoundingClientRect()
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

  hasSelection(): boolean {
    return this.selectedStrokeIds.size > 0;
  }

  cancelSelection(): void {
    this.endSelectionTransform();
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

  duplicateSelection(): void {
    if (this.selectedStrokeIds.size === 0) {
      return;
    }
    const document = this.options.getDocument();
    const layer = document.layers.find((item) => item.id === this.selectedLayerId);
    if (!layer) {
      return;
    }
    this.pushHistory(document);
    const duplicates = layer.strokes
      .filter((stroke) => this.selectedStrokeIds.has(stroke.id))
      .map((stroke) => this.cloneStroke(stroke));
    layer.strokes.push(...duplicates);
    this.selectedStrokeIds = new Set(duplicates.map((stroke) => stroke.id));
    this.refreshSelectionBounds();
    this.options.onDocumentChange(document, false);
  }

  private copySelection(): void {
    const snapshot = this.selectionSnapshot();
    if (!snapshot) {
      return;
    }
    InkCanvas.selectionClipboard = snapshot;
    this.selectionOverlay.setPasteEnabled(true);
    new Notice("已拷贝到插件剪贴板");
  }

  private cutSelection(): void {
    const snapshot = this.selectionSnapshot();
    if (!snapshot) {
      return;
    }
    InkCanvas.selectionClipboard = snapshot;
    this.selectionOverlay.setPasteEnabled(true);
    this.deleteSelection();
    new Notice("已剪切到插件剪贴板");
  }

  private pasteSelection(): void {
    const clipboard = InkCanvas.selectionClipboard;
    if (!clipboard || clipboard.strokes.length === 0) {
      return;
    }
    const document = this.options.getDocument();
    const layer = getActiveLayer(document);
    const viewport = this.currentViewport(this.canvas.getBoundingClientRect());
    const targetX = (viewport.offsetX + viewport.width / 2) / Math.max(1, viewport.documentWidth);
    const targetY = (viewport.offsetY + viewport.height / 2) / Math.max(1, viewport.documentHeight);
    const sourceX = (clipboard.bounds.minX + clipboard.bounds.maxX) / 2;
    const sourceY = (clipboard.bounds.minY + clipboard.bounds.maxY) / 2;
    const dx = Math.max(
      -clipboard.bounds.minX,
      Math.min(1 - clipboard.bounds.maxX, targetX - sourceX)
    );
    const dy = Math.max(
      -clipboard.bounds.minY,
      Math.min(1 - clipboard.bounds.maxY, targetY - sourceY)
    );

    this.pushHistory(document);
    const pasted = clipboard.strokes.map((stroke) => ({
      ...this.cloneStroke(stroke),
      pageIndex: this.options.pageIndex,
      points: stroke.points.map((point) => ({
        ...point,
        x: point.x + dx,
        y: point.y + dy
      }))
    }));
    layer.strokes.push(...pasted);
    this.cancelSelection();
    this.selectedLayerId = layer.id;
    this.selectedStrokeIds = new Set(pasted.map((stroke) => stroke.id));
    this.refreshSelectionBounds();
    this.options.onActivate?.();
    this.options.onRequestTool?.("select");
    this.options.onDocumentChange(document, false);
  }

  private setSelectionColor(color: string): void {
    if (this.selectedStrokeIds.size === 0) {
      return;
    }
    const document = this.options.getDocument();
    const layer = document.layers.find((item) => item.id === this.selectedLayerId);
    if (!layer) {
      return;
    }
    const selected = layer.strokes.filter((stroke) => this.selectedStrokeIds.has(stroke.id));
    if (selected.length === 0 || selected.every((stroke) => stroke.color === color)) {
      return;
    }
    this.pushHistory(document);
    for (const stroke of selected) {
      stroke.color = color;
    }
    this.render();
    this.options.onDocumentChange(document, false);
  }

  private selectionSnapshot(): { strokes: AnnotationStroke[]; bounds: SelectionBounds } | null {
    if (!this.selectionBounds || this.selectedStrokeIds.size === 0) {
      return null;
    }
    const layer = this.options
      .getDocument()
      .layers.find((item) => item.id === this.selectedLayerId);
    if (!layer) {
      return null;
    }
    return {
      strokes: layer.strokes
        .filter((stroke) => this.selectedStrokeIds.has(stroke.id))
        .map((stroke) => this.cloneStroke(stroke, false)),
      bounds: { ...this.selectionBounds }
    };
  }

  private cloneStroke(stroke: AnnotationStroke, generateNewId = true): AnnotationStroke {
    return {
      ...stroke,
      id: generateNewId ? generateId() : stroke.id,
      points: stroke.points.map((point) => ({ ...point }))
    };
  }

  setSelectedTextColor(color: string): boolean {
    const document = this.options.getDocument();
    const editing = this.editingText;
    const targetLayerId = editing?.layerId ?? this.selectedLayerId;
    const layer = document.layers.find((item) => item.id === targetLayerId);
    if (!layer) {
      return false;
    }
    const targetIds = editing
      ? new Set([editing.strokeId])
      : this.selectedStrokeIds;
    const textStrokes = layer.strokes.filter(
      (stroke) => targetIds.has(stroke.id) && stroke.tool === "text"
    );
    if (textStrokes.length === 0 || textStrokes.every((stroke) => stroke.color === color)) {
      return false;
    }
    if (!editing) {
      this.pushHistory(document);
    }
    for (const stroke of textStrokes) {
      stroke.color = color;
    }
    if (editing) {
      this.textEditor.style.color = color;
    }
    this.options.onDocumentChange(document, false);
    this.render();
    return true;
  }

  private async exportSelectionScreenshot(): Promise<void> {
    const bounds = this.selectionBounds;
    if (!bounds) {
      return;
    }
    const canvasRect = this.canvas.getBoundingClientRect();
    const viewport = this.currentViewport(canvasRect);
    const left = bounds.minX * viewport.documentWidth - viewport.offsetX;
    const top = bounds.minY * viewport.documentHeight - viewport.offsetY;
    const right = bounds.maxX * viewport.documentWidth - viewport.offsetX;
    const bottom = bounds.maxY * viewport.documentHeight - viewport.offsetY;
    const cropLeft = Math.max(0, left);
    const cropTop = Math.max(0, top);
    const cropRight = Math.min(canvasRect.width, right);
    const cropBottom = Math.min(canvasRect.height, bottom);
    const width = cropRight - cropLeft;
    const height = cropBottom - cropTop;
    if (width < 1 || height < 1) {
      new Notice("选区当前不在可见画布内");
      return;
    }

    const scale = Math.max(
      1,
      Math.min(2, 4096 / Math.max(width, height), window.devicePixelRatio || 1)
    );
    const output = document.createElement("canvas");
    output.width = Math.max(1, Math.round(width * scale));
    output.height = Math.max(1, Math.round(height * scale));
    const context = output.getContext("2d");
    if (!context) {
      return;
    }
    context.setTransform(scale, 0, 0, scale, 0, 0);
    const parent = this.canvas.parentElement;
    const isWhiteboard = this.canvas.closest(".hand-note-whiteboard") !== null;
    const isMarkdown = this.canvas.closest(".hand-note-surface") !== null && !isWhiteboard;
    const background = isWhiteboard
      ? "#ffffff"
      : parent
        ? window.getComputedStyle(parent).backgroundColor
        : "#ffffff";
    context.fillStyle = background === "rgba(0, 0, 0, 0)" ? "#ffffff" : background;
    context.fillRect(0, 0, width, height);

    const baseCanvas = Array.from(parent?.children ?? []).find(
      (element): element is HTMLCanvasElement =>
        element instanceof HTMLCanvasElement && element.classList.contains("hand-note-pdf-canvas")
    );
    if (baseCanvas) {
      this.drawCanvasCrop(context, baseCanvas, canvasRect, cropLeft, cropTop, width, height);
    }
    this.drawCanvasCrop(context, this.canvas, canvasRect, cropLeft, cropTop, width, height);

    const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, "image/png"));
    if (!blob) {
      new Notice("选区截屏生成失败");
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `hand-note-selection-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    new Notice(
      isMarkdown
        ? "已导出选区批注；Markdown 正文暂不包含在截图中"
        : "选区截图已导出"
    );
  }

  private drawCanvasCrop(
    context: CanvasRenderingContext2D,
    source: HTMLCanvasElement,
    canvasRect: DOMRect,
    cropLeft: number,
    cropTop: number,
    width: number,
    height: number
  ): void {
    const sourceRect = source.getBoundingClientRect();
    if (sourceRect.width <= 0 || sourceRect.height <= 0) {
      return;
    }
    const cropScreenLeft = canvasRect.left + cropLeft;
    const cropScreenTop = canvasRect.top + cropTop;
    const intersectionLeft = Math.max(cropScreenLeft, sourceRect.left);
    const intersectionTop = Math.max(cropScreenTop, sourceRect.top);
    const intersectionRight = Math.min(cropScreenLeft + width, sourceRect.right);
    const intersectionBottom = Math.min(cropScreenTop + height, sourceRect.bottom);
    if (intersectionRight <= intersectionLeft || intersectionBottom <= intersectionTop) {
      return;
    }
    const sourceScaleX = source.width / sourceRect.width;
    const sourceScaleY = source.height / sourceRect.height;
    context.drawImage(
      source,
      (intersectionLeft - sourceRect.left) * sourceScaleX,
      (intersectionTop - sourceRect.top) * sourceScaleY,
      (intersectionRight - intersectionLeft) * sourceScaleX,
      (intersectionBottom - intersectionTop) * sourceScaleY,
      intersectionLeft - cropScreenLeft,
      intersectionTop - cropScreenTop,
      intersectionRight - intersectionLeft,
      intersectionBottom - intersectionTop
    );
  }

  private beginSelectionTransform(event: PointerEvent, handle: string): void {
    if (
      !this.selectionBounds ||
      !this.selectedLayerId ||
      this.selectedStrokeIds.size === 0
    ) {
      return;
    }
    const layer = this.options
      .getDocument()
      .layers.find((item) => item.id === this.selectedLayerId);
    if (!layer) {
      return;
    }
    const points = new Map<string, StrokePoint[]>();
    const textSizes = new Map<string, { fontSize: number; size: number }>();
    for (const stroke of layer.strokes) {
      if (this.selectedStrokeIds.has(stroke.id)) {
        points.set(
          stroke.id,
          (stroke.tool === "text" ? this.textRectanglePoints(stroke) : stroke.points)
            .map((point) => ({ ...point }))
        );
        if (stroke.tool === "text") {
          textSizes.set(stroke.id, {
            fontSize: Math.max(8, stroke.fontSize ?? stroke.size ?? 24),
            size: stroke.size
          });
        }
      }
    }
    this.selectionTransformState = {
      pointerId: event.pointerId,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      bounds: { ...this.selectionBounds },
      points,
      textSizes,
      startAngle: this.selectionPointerAngle(event, this.selectionBounds),
      changed: false
    };
    window.addEventListener("pointermove", this.handleSelectionTransformMove, {
      passive: false
    });
    window.addEventListener("pointerup", this.handleSelectionTransformEnd);
    window.addEventListener("pointercancel", this.handleSelectionTransformEnd);
  }

  private handleSelectionTransformMove = (event: PointerEvent): void => {
    const state = this.selectionTransformState;
    if (!state || event.pointerId !== state.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const viewport = this.currentViewport(this.canvas.getBoundingClientRect());
    const dx = (event.clientX - state.startX) / Math.max(1, viewport.documentWidth);
    const dy = (event.clientY - state.startY) / Math.max(1, viewport.documentHeight);
    const angle = state.handle === "rotate"
      ? this.selectionPointerAngle(event, state.bounds) - state.startAngle
      : 0;
    if (
      !state.changed &&
      Math.hypot(dx, dy) < 0.0015 &&
      (state.handle !== "rotate" || Math.abs(angle) < 0.01)
    ) {
      return;
    }
    if (!state.changed) {
      this.pushHistory(this.options.getDocument());
      state.changed = true;
    }
    const layer = this.options
      .getDocument()
      .layers.find((item) => item.id === this.selectedLayerId);
    if (!layer) {
      return;
    }
    if (state.handle === "rotate") {
      const centerX = ((state.bounds.minX + state.bounds.maxX) / 2) * viewport.documentWidth;
      const centerY = ((state.bounds.minY + state.bounds.maxY) / 2) * viewport.documentHeight;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      for (const stroke of layer.strokes) {
        const original = state.points.get(stroke.id);
        if (!original) {
          continue;
        }
        stroke.points = original.map((point) => {
          const pointX = point.x * viewport.documentWidth - centerX;
          const pointY = point.y * viewport.documentHeight - centerY;
          return {
            ...point,
            x: (centerX + pointX * cosine - pointY * sine) / viewport.documentWidth,
            y: (centerY + pointX * sine + pointY * cosine) / viewport.documentHeight
          };
        });
        this.strokeBounds.delete(stroke);
      }
      this.refreshSelectionBounds();
      this.render();
      return;
    }
    const next = this.transformedSelectionBounds(state.bounds, state.handle, dx, dy);
    const originalWidth = Math.max(0.0001, state.bounds.maxX - state.bounds.minX);
    const originalHeight = Math.max(0.0001, state.bounds.maxY - state.bounds.minY);
    const nextWidth = next.maxX - next.minX;
    const nextHeight = next.maxY - next.minY;
    const textScale = Math.max(
      0.25,
      Math.min(4, Math.min(nextWidth / originalWidth, nextHeight / originalHeight))
    );
    for (const stroke of layer.strokes) {
      const original = state.points.get(stroke.id);
      if (!original) {
        continue;
      }
      stroke.points = original.map((point) => ({
        ...point,
        x: next.minX + ((point.x - state.bounds.minX) / originalWidth) * nextWidth,
        y: next.minY + ((point.y - state.bounds.minY) / originalHeight) * nextHeight
      }));
      const textSize = state.textSizes.get(stroke.id);
      if (state.handle !== "move" && textSize) {
        stroke.fontSize = Math.max(8, textSize.fontSize * textScale);
        stroke.size = Math.max(8, textSize.size * textScale);
      }
      this.strokeBounds.delete(stroke);
    }
    this.selectionBounds = next;
    this.lassoPoints = this.rectanglePoints(next);
    this.render();
    this.selectionOverlay.setSelection(
      this.lassoPoints,
      next,
      viewport,
      this.canvas.getBoundingClientRect()
    );
  };

  private selectionPointerAngle(event: PointerEvent, bounds: SelectionBounds): number {
    const rect = this.canvas.getBoundingClientRect();
    const viewport = this.currentViewport(rect);
    const pointerX = event.clientX - rect.left + viewport.offsetX;
    const pointerY = event.clientY - rect.top + viewport.offsetY;
    const centerX = ((bounds.minX + bounds.maxX) / 2) * viewport.documentWidth;
    const centerY = ((bounds.minY + bounds.maxY) / 2) * viewport.documentHeight;
    return Math.atan2(pointerY - centerY, pointerX - centerX);
  }

  private handleSelectionTransformEnd = (event: PointerEvent): void => {
    if (
      !this.selectionTransformState ||
      event.pointerId !== this.selectionTransformState.pointerId
    ) {
      return;
    }
    this.endSelectionTransform();
  };

  private endSelectionTransform(): void {
    const changed = this.selectionTransformState?.changed ?? false;
    this.selectionTransformState = null;
    window.removeEventListener("pointermove", this.handleSelectionTransformMove);
    window.removeEventListener("pointerup", this.handleSelectionTransformEnd);
    window.removeEventListener("pointercancel", this.handleSelectionTransformEnd);
    if (changed) {
      this.options.onDocumentChange(this.options.getDocument(), false);
    }
  }

  private transformedSelectionBounds(
    bounds: SelectionBounds,
    handle: string,
    dx: number,
    dy: number
  ): SelectionBounds {
    const next = { ...bounds };
    if (handle === "move") {
      const moveX = Math.max(-bounds.minX, Math.min(1 - bounds.maxX, dx));
      const moveY = Math.max(-bounds.minY, Math.min(1 - bounds.maxY, dy));
      next.minX += moveX;
      next.maxX += moveX;
      next.minY += moveY;
      next.maxY += moveY;
      return next;
    }
    const minimum = 0.01;
    if (handle.includes("w")) {
      next.minX = Math.max(0, Math.min(bounds.maxX - minimum, bounds.minX + dx));
    }
    if (handle.includes("e")) {
      next.maxX = Math.min(1, Math.max(bounds.minX + minimum, bounds.maxX + dx));
    }
    if (handle.includes("n")) {
      next.minY = Math.max(0, Math.min(bounds.maxY - minimum, bounds.minY + dy));
    }
    if (handle.includes("s")) {
      next.maxY = Math.min(1, Math.max(bounds.minY + minimum, bounds.maxY + dy));
    }
    return next;
  }

  private refreshSelectionBounds(): void {
    const layer = this.options
      .getDocument()
      .layers.find((item) => item.id === this.selectedLayerId);
    if (!layer) {
      return;
    }
    this.selectionBounds = layer.strokes
      .filter((stroke) => this.selectedStrokeIds.has(stroke.id))
      .reduce<SelectionBounds | null>(
        (bounds, stroke) => this.unionBounds(bounds, this.getStrokeBounds(stroke)),
        null
      );
    if (!this.selectionBounds) {
      return;
    }
    this.lassoPoints = this.rectanglePoints(this.selectionBounds);
    const viewport = this.currentViewport(this.canvas.getBoundingClientRect());
    this.selectionOverlay.setSelection(
      this.lassoPoints,
      this.selectionBounds,
      viewport,
      this.canvas.getBoundingClientRect()
    );
    this.selectionOverlay.setPasteEnabled(InkCanvas.selectionClipboard !== null);
  }

  private rectanglePoints(bounds: SelectionBounds): StrokePoint[] {
    return [
      { x: bounds.minX, y: bounds.minY, pressure: 0.5 },
      { x: bounds.maxX, y: bounds.minY, pressure: 0.5 },
      { x: bounds.maxX, y: bounds.maxY, pressure: 0.5 },
      { x: bounds.minX, y: bounds.maxY, pressure: 0.5 }
    ];
  }

  private selectTextStroke(layer: AnnotationLayer, stroke: AnnotationStroke): void {
    this.cancelSelection();
    this.selectedLayerId = layer.id;
    this.selectedStrokeIds = new Set([stroke.id]);
    this.selectionBounds = this.getStrokeBounds(stroke);
    this.lassoPoints = this.rectanglePoints(this.selectionBounds);
    const viewport = this.currentViewport(this.canvas.getBoundingClientRect());
    this.selectionOverlay.setSelection(
      this.lassoPoints,
      this.selectionBounds,
      viewport,
      this.canvas.getBoundingClientRect()
    );
    this.selectionOverlay.setPasteEnabled(InkCanvas.selectionClipboard !== null);
    this.options.onActivate?.();
  }

  private startTextLongPress(
    event: PointerEvent,
    layer: AnnotationLayer,
    stroke: AnnotationStroke,
    mode: "touch-pan" | "pen-text" | "pen-select"
  ): void {
    this.cancelTextLongPress();
    const timer = window.setTimeout(() => {
      const pending = this.textLongPress;
      if (!pending || pending.pointerId !== event.pointerId) {
        return;
      }
      this.textLongPress = null;
      this.selectTextStroke(layer, stroke);
      const pointerId = this.activePointerId;
      this.resetPointerState();
      if (pointerId !== null && this.canvas.hasPointerCapture(pointerId)) {
        this.canvas.releasePointerCapture(pointerId);
      }
      this.resumePendingDocumentPublish();
    }, 420);
    this.textLongPress = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      layerId: layer.id,
      strokeId: stroke.id,
      startX: event.clientX,
      startY: event.clientY,
      mode,
      timer
    };
  }

  private cancelTextLongPress(): void {
    if (!this.textLongPress) {
      return;
    }
    window.clearTimeout(this.textLongPress.timer);
    this.textLongPress = null;
  }

  private textLongPressMoved(event: PointerEvent): boolean {
    const pending = this.textLongPress;
    if (!pending || pending.pointerId !== event.pointerId) {
      return false;
    }
    if (Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) <= 8) {
      return false;
    }
    this.cancelTextLongPress();
    return true;
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
      viewport,
      this.canvas.getBoundingClientRect()
    );
    this.selectionOverlay.setPasteEnabled(InkCanvas.selectionClipboard !== null);
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
    this.finalizeActiveStroke();
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
    this.finalizeActiveStroke();
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
    if (this.liveCanvas.width !== width || this.liveCanvas.height !== height) {
      this.liveCanvas.width = width;
      this.liveCanvas.height = height;
    }

    this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    this.context.clearRect(0, 0, rect.width, rect.height);
    this.liveContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    this.liveContext.clearRect(0, 0, rect.width, rect.height);
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
        if (stroke === this.activeStroke && this.isLiveStroke(stroke)) {
          continue;
        }
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
    this.renderedPointCount = 0;
    this.drawLiveStroke();
    this.refreshShapeOverlay();
    if (this.selectionBounds && this.lassoPoints.length > 2) {
      this.selectionOverlay.setSelection(this.lassoPoints, this.selectionBounds, viewport, rect);
    }
    this.positionTextEditor();
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

    if (stroke.tool === "shape") {
      this.drawShapeStroke(context, stroke, viewport);
      context.restore();
      return;
    }

    if (stroke.tool === "text") {
      this.drawTextStroke(context, stroke, viewport);
      context.restore();
      return;
    }

    if (stroke.tool === "pen" || stroke.tool === "pencil") {
      context.fillStyle = stroke.color;
      drawFreehandStroke(
        context,
        stroke,
        viewport,
        this.options.getPressureEnabled()
      );
      context.restore();
      return;
    }

    if (stroke.tool === "highlighter") {
      this.drawHighlighterStroke(context, stroke, viewport);
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

  private drawShapeStroke(
    context: CanvasRenderingContext2D,
    stroke: AnnotationStroke,
    viewport: InkCanvasViewport
  ): void {
    const points = stroke.points.map((point) => ({
      x: point.x * viewport.documentWidth - viewport.offsetX,
      y: point.y * viewport.documentHeight - viewport.offsetY
    }));
    if (points.length < 2) {
      return;
    }
    context.globalCompositeOperation = "source-over";
    context.lineWidth = stroke.size;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    if (stroke.shape === "curve" && points.length >= 4) {
      context.moveTo(points[0].x, points[0].y);
      context.bezierCurveTo(
        points[1].x,
        points[1].y,
        points[2].x,
        points[2].y,
        points[3].x,
        points[3].y
      );
    } else if (stroke.shape === "rectangle" && points.length >= 4) {
      context.moveTo(points[0].x, points[0].y);
      for (let index = 1; index < 4; index += 1) {
        context.lineTo(points[index].x, points[index].y);
      }
      context.closePath();
    } else if (stroke.shape === "ellipse" && points.length >= 4) {
      context.moveTo(points[0].x, points[0].y);
      for (let index = 0; index < 4; index += 1) {
        const previous = points[(index + 3) % 4];
        const current = points[index];
        const next = points[(index + 1) % 4];
        const after = points[(index + 2) % 4];
        context.bezierCurveTo(
          current.x + (next.x - previous.x) / 6,
          current.y + (next.y - previous.y) / 6,
          next.x - (after.x - current.x) / 6,
          next.y - (after.y - current.y) / 6,
          next.x,
          next.y
        );
      }
      context.closePath();
    } else {
      context.moveTo(points[0].x, points[0].y);
      context.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    }
    context.stroke();
  }

  private drawTextStroke(
    context: CanvasRenderingContext2D,
    stroke: AnnotationStroke,
    viewport: InkCanvasViewport
  ): void {
    const start = stroke.points[0];
    if (!start || !stroke.text) {
      return;
    }
    const fontSize = Math.max(8, stroke.fontSize ?? stroke.size ?? 24);
    const x = start.x * viewport.documentWidth - viewport.offsetX;
    const y = start.y * viewport.documentHeight - viewport.offsetY;
    context.globalCompositeOperation = "source-over";
    context.fillStyle = stroke.color;
    context.font = `${fontSize}px sans-serif`;
    context.textBaseline = "top";
    const lineHeight = fontSize * 1.25;
    const end = stroke.points[1];
    const rotated = stroke.points.length >= 4 && end;
    const maxWidth = end
      ? Math.max(
          fontSize,
          rotated
            ? Math.hypot(
                (end.x - start.x) * viewport.documentWidth,
                (end.y - start.y) * viewport.documentHeight
              )
            : Math.abs(end.x - start.x) * viewport.documentWidth
        )
      : Number.POSITIVE_INFINITY;
    if (rotated) {
      const angle = Math.atan2(
        (end.y - start.y) * viewport.documentHeight,
        (end.x - start.x) * viewport.documentWidth
      );
      context.translate(x, y);
      context.rotate(angle);
    }
    this.wrapCanvasText(context, stroke.text, maxWidth).forEach((line, index) => {
      context.fillText(line, rotated ? 0 : x, (rotated ? 0 : y) + index * lineHeight);
    });
  }

  private wrapCanvasText(
    context: CanvasRenderingContext2D,
    text: string,
    maxWidth: number
  ): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split("\n")) {
      let line = "";
      for (const character of Array.from(paragraph)) {
        const candidate = line + character;
        if (line && context.measureText(candidate).width > maxWidth) {
          lines.push(line);
          line = character;
        } else {
          line = candidate;
        }
      }
      lines.push(line);
    }
    return lines;
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

  private beginObjectStroke(
    layer: AnnotationLayer,
    point: StrokePoint,
    tool: "shape" | "text"
  ): void {
    const viewport = this.activeViewport ?? this.currentViewport(this.canvas.getBoundingClientRect());
    const end = tool === "text"
      ? this.defaultTextEnd(point, viewport)
      : { ...point };
    this.activeStrokeIndex = layer.strokes.length;
    this.activeStroke = {
      id: generateId(),
      tool,
      color: this.options.getColor(),
      size: this.options.getSize(),
      opacity: 1,
      points:
        tool === "shape"
          ? this.shapePoints(point, end, this.options.getShapeKind?.() ?? "rectangle")
          : this.rectanglePoints(this.boundsForPoints([point, end])),
      pageIndex: this.options.pageIndex,
      shape: tool === "shape" ? this.options.getShapeKind?.() ?? "rectangle" : undefined,
      text: tool === "text" ? "" : undefined,
      fontSize: tool === "text" ? this.options.getSize() : undefined
    };
    this.activeStrokeLayerId = layer.id;
    this.activeStrokeLayerOpacity = layer.opacity;
    this.activeStrokeDocument = this.options.getDocument();
    layer.strokes.push(this.activeStroke);
    this.options.onInteraction?.("stroke-start");
    this.render();
  }

  private updateObjectStroke(event: PointerEvent): void {
    const stroke = this.activeStroke;
    if (!stroke || !this.activeRect || !this.activeViewport) {
      return;
    }
    const point = this.pointFromEvent(event, this.activeRect, this.activeViewport);
    const start = stroke.points[0];
    if (!start) {
      return;
    }
    if (stroke.tool === "shape") {
      stroke.points = this.shapePoints(start, point, stroke.shape ?? "rectangle");
    } else if (stroke.tool === "text") {
      const dx = Math.abs(point.x - start.x) * this.activeViewport.documentWidth;
      const dy = Math.abs(point.y - start.y) * this.activeViewport.documentHeight;
      const end = dx < 8 && dy < 8
        ? this.defaultTextEnd(start, this.activeViewport)
        : point;
      stroke.points = this.rectanglePoints(this.boundsForPoints([start, end]));
    }
    this.strokeBounds.delete(stroke);
    this.render();
  }

  private shapePoints(
    start: StrokePoint,
    end: StrokePoint,
    kind: ShapeKind
  ): StrokePoint[] {
    const point = (x: number, y: number): StrokePoint => ({ x, y, pressure: 0.5 });
    if (kind === "line") {
      return [{ ...start }, { ...end }];
    }
    if (kind === "rectangle") {
      return [
        { ...start },
        point(end.x, start.y),
        { ...end },
        point(start.x, end.y)
      ];
    }
    if (kind === "ellipse") {
      const left = Math.min(start.x, end.x);
      const right = Math.max(start.x, end.x);
      const top = Math.min(start.y, end.y);
      const bottom = Math.max(start.y, end.y);
      const centerX = (left + right) / 2;
      const centerY = (top + bottom) / 2;
      return [
        point(centerX, top),
        point(right, centerY),
        point(centerX, bottom),
        point(left, centerY)
      ];
    }
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    return [
      { ...start },
      point(start.x + dx / 3, start.y + dy * 0.08),
      point(start.x + (dx * 2) / 3, end.y - dy * 0.08),
      { ...end }
    ];
  }

  private findObjectAtPoint(
    layer: AnnotationLayer,
    point: StrokePoint,
    tool: "shape" | "text"
  ): AnnotationStroke | null {
    const viewport = this.currentViewport(this.canvas.getBoundingClientRect());
    const paddingX = 14 / Math.max(1, viewport.documentWidth);
    const paddingY = 14 / Math.max(1, viewport.documentHeight);
    for (let index = layer.strokes.length - 1; index >= 0; index -= 1) {
      const stroke = layer.strokes[index];
      if (stroke.tool !== tool || stroke.pageIndex !== this.options.pageIndex) {
        continue;
      }
      const bounds = this.getStrokeBounds(stroke);
      if (
        point.x >= bounds.minX - paddingX &&
        point.x <= bounds.maxX + paddingX &&
        point.y >= bounds.minY - paddingY &&
        point.y <= bounds.maxY + paddingY
      ) {
        return stroke;
      }
    }
    return null;
  }

  private findTextAtPoint(
    document: AnnotationDocument,
    point: StrokePoint
  ): { layer: AnnotationLayer; stroke: AnnotationStroke } | null {
    for (let index = document.layers.length - 1; index >= 0; index -= 1) {
      const layer = document.layers[index];
      if (!layer.visible || layer.opacity <= 0 || layer.whiteboard) {
        continue;
      }
      const stroke = this.findObjectAtPoint(layer, point, "text");
      if (stroke) {
        return { layer, stroke };
      }
    }
    return null;
  }

  private selectShape(layerId: string, strokeId: string): void {
    this.selectedShapeLayerId = layerId;
    this.selectedShapeId = strokeId;
    this.refreshShapeOverlay();
  }

  private clearShapeSelection(): void {
    this.endShapeAnchorDrag();
    this.selectedShapeLayerId = null;
    this.selectedShapeId = null;
    this.shapeOverlay.clear();
  }

  private refreshShapeOverlay(): void {
    if (!this.selectedShapeId || !this.selectedShapeLayerId) {
      this.shapeOverlay.clear();
      return;
    }
    const layer = this.options
      .getDocument()
      .layers.find((candidate) => candidate.id === this.selectedShapeLayerId);
    const stroke = layer?.strokes.find((candidate) => candidate.id === this.selectedShapeId);
    if (!stroke || stroke.tool !== "shape") {
      this.clearShapeSelection();
      return;
    }
    const viewport = this.currentViewport(this.canvas.getBoundingClientRect());
    this.shapeOverlay.setStroke(stroke, viewport);
  }

  private beginShapeAnchorDrag(event: PointerEvent, pointIndex: number): void {
    if (!this.selectedShapeId || !this.selectedShapeLayerId) {
      return;
    }
    const layer = this.options
      .getDocument()
      .layers.find((candidate) => candidate.id === this.selectedShapeLayerId);
    const stroke = layer?.strokes.find((candidate) => candidate.id === this.selectedShapeId);
    if (!layer || !stroke || !stroke.points[pointIndex]) {
      return;
    }
    this.shapeEditState = {
      pointerId: event.pointerId,
      layerId: layer.id,
      strokeId: stroke.id,
      pointIndex,
      changed: false
    };
    window.addEventListener("pointermove", this.handleShapeAnchorMove, { passive: false });
    window.addEventListener("pointerup", this.handleShapeAnchorEnd);
    window.addEventListener("pointercancel", this.handleShapeAnchorEnd);
  }

  private handleShapeAnchorMove = (event: PointerEvent): void => {
    const state = this.shapeEditState;
    if (!state || state.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const layer = this.options
      .getDocument()
      .layers.find((candidate) => candidate.id === state.layerId);
    const stroke = layer?.strokes.find((candidate) => candidate.id === state.strokeId);
    if (!stroke) {
      return;
    }
    if (!state.changed) {
      this.pushHistory(this.options.getDocument());
      state.changed = true;
    }
    const viewport = this.currentViewport(this.canvas.getBoundingClientRect());
    const rect = this.canvas.getBoundingClientRect();
    stroke.points[state.pointIndex] = this.pointFromEvent(event, rect, viewport);
    this.strokeBounds.delete(stroke);
    this.render();
  };

  private handleShapeAnchorEnd = (event: PointerEvent): void => {
    if (!this.shapeEditState || this.shapeEditState.pointerId !== event.pointerId) {
      return;
    }
    this.endShapeAnchorDrag();
  };

  private endShapeAnchorDrag(): void {
    const changed = this.shapeEditState?.changed ?? false;
    this.shapeEditState = null;
    window.removeEventListener("pointermove", this.handleShapeAnchorMove);
    window.removeEventListener("pointerup", this.handleShapeAnchorEnd);
    window.removeEventListener("pointercancel", this.handleShapeAnchorEnd);
    if (changed) {
      this.options.onDocumentChange(this.options.getDocument(), false);
    }
  }

  private openTextEditor(layerId: string, strokeId: string, created = false): void {
    this.commitTextEditor();
    const layer = this.options.getDocument().layers.find((item) => item.id === layerId);
    const stroke = layer?.strokes.find((item) => item.id === strokeId);
    if (!layer || !stroke || stroke.tool !== "text") {
      return;
    }
    this.selectTextStroke(layer, stroke);
    this.selectionOverlay.hideMenu();
    if (!created) {
      this.pushHistory(this.options.getDocument());
    }
    this.editingText = {
      layerId,
      strokeId,
      created,
      original: {
        text: stroke.text,
        color: stroke.color,
        size: stroke.size,
        fontSize: stroke.fontSize,
        points: stroke.points.map((point) => ({ ...point }))
      }
    };
    this.textEditor.value = stroke.text ?? "";
    this.textEditor.style.color = stroke.color;
    this.textEditor.style.fontSize = `${stroke.fontSize ?? stroke.size}px`;
    document.body.append(this.textEditorPortal);
    this.textEditorPortal.classList.add("is-visible");
    this.lockTextEditorScroll();
    window.visualViewport?.addEventListener("resize", this.positionTextEditor);
    window.visualViewport?.addEventListener("scroll", this.positionTextEditor);
    window.addEventListener("resize", this.positionTextEditor);
    this.positionTextEditor();
    window.setTimeout(() => {
      this.textEditor.focus();
      if (created) {
        this.textEditor.select();
      }
    }, 0);
  }

  private handleTextEditorInput = (): void => {
    const stroke = this.currentTextStroke();
    if (!stroke) {
      return;
    }
    stroke.text = this.textEditor.value;
    this.strokeBounds.delete(stroke);
    this.render();
  };

  private handleTextEditorKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      this.cancelTextEditor();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      this.commitTextEditor();
    }
  };

  private commitTextEditor = (): void => {
    const editing = this.editingText;
    if (!editing) {
      return;
    }
    const document = this.options.getDocument();
    const layer = document.layers.find((candidate) => candidate.id === editing.layerId);
    const strokeIndex = layer?.strokes.findIndex((candidate) => candidate.id === editing.strokeId) ?? -1;
    const stroke = strokeIndex >= 0 ? layer?.strokes[strokeIndex] : null;
    if (!layer || !stroke) {
      this.hideTextEditor();
      return;
    }
    if (!this.textEditor.value.trim()) {
      layer.strokes.splice(strokeIndex, 1);
      if (editing.created) {
        const history = this.undoStack[this.undoStack.length - 1];
        if (history?.kind === "stroke-add" && history.stroke.id === editing.strokeId) {
          this.undoStack.pop();
        }
      }
      this.hideTextEditor();
      this.cancelSelection();
      this.options.onDocumentChange(document, false);
      this.render();
      return;
    }
    stroke.text = this.textEditor.value;
    this.strokeBounds.delete(stroke);
    this.hideTextEditor();
    this.options.onRequestTool?.("select");
    this.selectTextStroke(layer, stroke);
    this.options.onDocumentChange(document, false);
    this.render();
  };

  private cancelTextEditor(): void {
    const editing = this.editingText;
    if (!editing) {
      return;
    }
    const layer = this.options
      .getDocument()
      .layers.find((candidate) => candidate.id === editing.layerId);
    const strokeIndex = layer?.strokes.findIndex((candidate) => candidate.id === editing.strokeId) ?? -1;
    const stroke = strokeIndex >= 0 ? layer?.strokes[strokeIndex] : null;
    if (layer && stroke && editing.created) {
      layer.strokes.splice(strokeIndex, 1);
      const history = this.undoStack[this.undoStack.length - 1];
      if (history?.kind === "stroke-add" && history.stroke.id === editing.strokeId) {
        this.undoStack.pop();
      }
    } else if (stroke) {
      stroke.text = editing.original.text;
      stroke.color = editing.original.color;
      stroke.size = editing.original.size;
      stroke.fontSize = editing.original.fontSize;
      stroke.points = editing.original.points.map((point) => ({ ...point }));
      this.strokeBounds.delete(stroke);
      const history = this.undoStack[this.undoStack.length - 1];
      if (history?.kind === "snapshot") {
        this.undoStack.pop();
      }
    }
    this.hideTextEditor();
    if (layer && stroke && !editing.created) {
      this.options.onRequestTool?.("select");
      this.selectTextStroke(layer, stroke);
    } else {
      this.cancelSelection();
    }
    this.options.onDocumentChange(this.options.getDocument(), false);
    this.render();
  }

  private textRectanglePoints(stroke: AnnotationStroke): StrokePoint[] {
    if (stroke.points.length >= 4) {
      return stroke.points;
    }
    return this.rectanglePoints(this.boundsForPoints(stroke.points));
  }

  private defaultTextEnd(start: StrokePoint, viewport: InkCanvasViewport): StrokePoint {
    return {
      ...start,
      x: Math.min(1, start.x + 180 / Math.max(1, viewport.documentWidth)),
      y: Math.min(1, start.y + 60 / Math.max(1, viewport.documentHeight))
    };
  }

  private closeTextEditor(): void {
    this.hideTextEditor();
  }

  private hideTextEditor(): void {
    this.editingText = null;
    this.textEditorPortal.classList.remove("is-visible");
    window.visualViewport?.removeEventListener("resize", this.positionTextEditor);
    window.visualViewport?.removeEventListener("scroll", this.positionTextEditor);
    window.removeEventListener("resize", this.positionTextEditor);
    this.unlockTextEditorScroll();
    this.textEditorPortal.remove();
  }

  private currentTextStroke(): AnnotationStroke | null {
    if (!this.editingText) {
      return null;
    }
    const layer = this.options
      .getDocument()
      .layers.find((candidate) => candidate.id === this.editingText?.layerId);
    return layer?.strokes.find((candidate) => candidate.id === this.editingText?.strokeId) ?? null;
  }

  private positionTextEditor = (): void => {
    if (!this.editingText || !this.textEditorPortal.classList.contains("is-visible")) {
      return;
    }
    this.selectionOverlay.hideMenu();
    const lock = this.textEditorScrollLock;
    if (lock?.target) {
      lock.target.scrollLeft = lock.scrollLeft;
      lock.target.scrollTop = lock.scrollTop;
    }
    const visualViewport = window.visualViewport;
    const viewportLeft = visualViewport?.offsetLeft ?? 0;
    const viewportTop = visualViewport?.offsetTop ?? 0;
    const viewportWidth = visualViewport?.width ?? window.innerWidth;
    const viewportHeight = visualViewport?.height ?? window.innerHeight;
    const margin = 12;
    const width = Math.max(120, Math.min(560, viewportWidth - margin * 2));
    const height = Math.max(
      96,
      Math.min(240, viewportHeight - margin * 2, viewportHeight * 0.34)
    );
    this.textEditorPortal.style.left = `${viewportLeft + Math.max(margin, (viewportWidth - width) / 2)}px`;
    this.textEditorPortal.style.top = `${viewportTop + Math.max(margin, viewportHeight - height - margin)}px`;
    this.textEditorPortal.style.width = `${width}px`;
    this.textEditorPortal.style.height = `${height}px`;
  };

  private lockTextEditorScroll(): void {
    if (this.textEditorScrollLock) {
      return;
    }
    const target = this.canvas.closest(".hand-note-scroll") as HTMLElement | null;
    this.textEditorScrollLock = {
      target,
      scrollLeft: target?.scrollLeft ?? 0,
      scrollTop: target?.scrollTop ?? 0,
      overflow: target?.style.overflow ?? "",
      overscrollBehavior: target?.style.overscrollBehavior ?? "",
      windowX: window.scrollX,
      windowY: window.scrollY
    };
    if (target) {
      target.style.overflow = "hidden";
      target.style.overscrollBehavior = "none";
    }
  }

  private unlockTextEditorScroll(): void {
    const lock = this.textEditorScrollLock;
    if (!lock) {
      return;
    }
    if (lock.target) {
      lock.target.style.overflow = lock.overflow;
      lock.target.style.overscrollBehavior = lock.overscrollBehavior;
      lock.target.scrollLeft = lock.scrollLeft;
      lock.target.scrollTop = lock.scrollTop;
    }
    window.scrollTo(lock.windowX, lock.windowY);
    this.textEditorScrollLock = null;
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "pen") {
      this.claimPencilEvent(event);
      if (this.activeInputChannel === "stylus-touch") {
        return;
      }
    }
    this.startPointerSession(event, "pointer");
  };

  private startPointerSession(
    event: PointerEvent,
    inputChannel: "pointer" | "stylus-touch" = "pointer"
  ): void {
    if (this.activePointerId !== null) {
      if (event.pointerType !== "pen") {
        return;
      }
      if (this.activePointerKind === "draw" && this.activeStroke) {
        this.finalizeActiveStroke();
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
      this.activeInputChannel = "pointer";
      this.panLastX = event.clientX;
      this.panLastY = event.clientY;
      this.panLastTime = event.timeStamp || performance.now();
      this.panVelocityX = 0;
      this.panVelocityY = 0;
      const document = this.options.getDocument();
      const rect = this.cachedRect ?? this.canvas.getBoundingClientRect();
      const point = this.pointFromEvent(event, rect, this.currentViewport(rect));
      const text = this.findTextAtPoint(document, point);
      if (text) {
        this.startTextLongPress(event, text.layer, text.stroke, "touch-pan");
      }
      return;
    }

    const tool = this.options.getTool();
    if (tool === "hand") {
      return;
    }
    if (tool !== "select" && tool !== "text" && this.hasSelection()) {
      this.cancelSelection();
    }
    const document = this.options.getDocument();
    const layer = getActiveLayer(document);
    if (!layer || !layer.visible) {
      return;
    }

    this.deferPendingDocumentPublish();
    const hotPathStartedAt = performance.now();
    this.claimPencilEvent(event);
    this.activePointerId = event.pointerId;
    this.activePointerKind = "draw";
    this.activeInputChannel = inputChannel;
    this.activeTool = tool;
    this.options.onActivate?.();
    this.activeRect = this.cachedRect ?? this.canvas.getBoundingClientRect();
    this.cachedRect = this.activeRect;
    this.activeViewport = this.currentViewport(this.activeRect);
    this.ensureCanvasReady(this.activeRect);
    this.renderedPointCount = 0;
    this.pendingEraserPoints = [];

    const point = this.pointFromEvent(
      event,
      this.activeRect,
      this.activeViewport
    );
    if (event.pointerType === "pen" && (tool === "pen" || tool === "pencil")) {
      point.pressure = Math.max(0.12, Math.min(1, event.pressure));
      this.activeStrokePathLength = 0;
      this.activeSmoothedPressure = point.pressure;
    }
    if (layer.whiteboard && !this.pointInBounds(point, layer.whiteboard.bounds)) {
      this.resetPointerState();
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      this.resumePendingDocumentPublish();
      return;
    }

    if (tool === "shape") {
      const existing = this.findObjectAtPoint(layer, point, "shape");
      if (existing) {
        this.selectShape(layer.id, existing.id);
        this.resetPointerState();
        this.resumePendingDocumentPublish();
        return;
      }
      this.clearShapeSelection();
      this.beginObjectStroke(layer, point, "shape");
      return;
    }

    if (tool === "text") {
      const existing = this.findTextAtPoint(document, point);
      if (existing) {
        if (event.pointerType === "pen") {
          this.startTextLongPress(event, existing.layer, existing.stroke, "pen-text");
          return;
        }
        this.openTextEditor(existing.layer.id, existing.stroke.id);
        this.resetPointerState();
        this.resumePendingDocumentPublish();
        return;
      }
      this.beginObjectStroke(layer, point, "text");
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
        this.resumePendingDocumentPublish();
        return;
      }
      this.lassoPoints = [point];
      this.updateLassoDraft();
      if (event.pointerType === "pen") {
        const text = this.findTextAtPoint(document, point);
        if (text) {
          this.startTextLongPress(event, text.layer, text.stroke, "pen-select");
        }
      }
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
  }

  private handlePointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) {
      if (this.shouldRescueOrphanPenMove(event)) {
        this.startPointerSession(event, "pointer");
      }
      return;
    }

    if (event.pointerType === "pen") {
      this.claimPencilEvent(event);
    } else {
      event.preventDefault();
    }
    if (this.activePointerKind === "pan") {
      const pendingLongPress = this.textLongPress?.pointerId === event.pointerId;
      const moved = this.textLongPressMoved(event);
      if (pendingLongPress && !moved) {
        return;
      }
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
    if (this.textLongPress?.pointerId === event.pointerId) {
      const mode = this.textLongPress.mode;
      const moved = this.textLongPressMoved(event);
      if (!moved || mode === "pen-text") {
        return;
      }
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

    if (
      (this.activeTool === "shape" || this.activeTool === "text") &&
      this.activeStroke
    ) {
      this.updateObjectStroke(event);
      return;
    }

    if (!this.activeStroke) {
      return;
    }

    this.collectStrokePoints(event);
    this.scheduleInteractionFrame();
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) {
      return;
    }

    if (event.pointerType === "pen") {
      this.claimPencilEvent(event);
    } else {
      event.preventDefault();
    }
    if (this.activePointerKind === "pan") {
      this.cancelTextLongPress();
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

    const pendingLongPress = this.textLongPress;
    if (pendingLongPress?.pointerId === event.pointerId) {
      this.cancelTextLongPress();
      const pointerId = event.pointerId;
      if (pendingLongPress.mode === "pen-text") {
        this.openTextEditor(pendingLongPress.layerId, pendingLongPress.strokeId);
      } else {
        this.cancelSelection();
      }
      this.resetPointerState();
      if (this.canvas.hasPointerCapture(pointerId)) {
        this.canvas.releasePointerCapture(pointerId);
      }
      this.resumePendingDocumentPublish();
      return;
    }

    if (this.activeTool === "shape" && this.activeStroke) {
      const stroke = this.activeStroke;
      const layerId = this.activeStrokeLayerId;
      this.updateObjectStroke(event);
      this.finalizeActiveStroke();
      if (layerId) {
        this.selectShape(layerId, stroke.id);
      }
      return;
    } else if (this.activeTool === "text" && this.activeStroke) {
      const stroke = this.activeStroke;
      const layerId = this.activeStrokeLayerId;
      this.updateObjectStroke(event);
      this.finalizeActiveStroke();
      if (layerId) {
        this.openTextEditor(layerId, stroke.id, true);
      }
      return;
    } else if (this.activeTool === "select") {
      this.collectLassoPoints(event, true);
    } else if (this.activeTool === "eraser") {
      this.collectEraserPoints(event);
    } else if (this.activeStroke) {
      this.collectStrokePoints(event, true);
      this.finalizeActiveStroke();
      return;
    }
    this.flushPendingInteraction();

    if (this.activeTool === "select") {
      this.finalizeLasso();
    } else if (this.activeTool === "eraser") {
      if (this.eraserChanged) {
        this.options.onInteraction?.("erase");
        this.scheduleDocumentPublish(this.options.getDocument(), false);
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

  private handlePointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) {
      return;
    }

    if (event.pointerType === "pen") {
      this.claimPencilEvent(event);
    } else {
      event.preventDefault();
    }
    this.cancelTextLongPress();
    if (this.activePointerKind === "draw" && this.activeStroke) {
      this.finalizeActiveStroke();
      return;
    }

    this.finishNonStrokeInteraction(true);
  };

  private handleLostPointerCapture = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) {
      return;
    }
    if (event.pointerType === "pen" && this.activeInputChannel === "pointer") {
      return;
    }
    this.handlePointerCancel(event);
  };

  private finishNonStrokeInteraction(commitEraser: boolean): void {
    this.flushPendingInteraction();
    if (this.activeTool === "select") {
      this.cancelSelection();
    } else if (this.activeTool === "eraser") {
      if (commitEraser && this.eraserChanged) {
        this.options.onInteraction?.("erase");
        this.scheduleDocumentPublish(this.options.getDocument(), false);
      } else if (!this.eraserChanged) {
        this.undoStack.pop();
      }
      this.eraserChanged = false;
    }
    const pointerId = this.activePointerId;
    this.resetPointerState();
    if (pointerId !== null && this.canvas.hasPointerCapture(pointerId)) {
      this.canvas.releasePointerCapture(pointerId);
    }
  }

  private resetPointerState(): void {
    this.cancelTextLongPress();
    this.activePointerId = null;
    this.activePointerKind = null;
    this.activeInputChannel = null;
    this.activeTool = null;
    this.activeRect = null;
    this.activeViewport = null;
    this.renderedPointCount = 0;
    this.pendingEraserPoints = [];
  }

  private finalizeActiveStroke(): void {
    const stroke = this.activeStroke;
    if (!stroke) {
      return;
    }
    const document = this.activeStrokeDocument ?? this.options.getDocument();
    const layerId = this.activeStrokeLayerId ?? document.activeLayerId;
    const strokeIndex = Math.max(0, this.activeStrokeIndex);
    const pointerId = this.activePointerId;
    if (this.isLiveStroke(stroke) && this.activeViewport) {
      if (this.interactionFrame !== null) {
        window.cancelAnimationFrame(this.interactionFrame);
        this.interactionFrame = null;
      }
      this.drawStroke(stroke, this.activeViewport, this.activeStrokeLayerOpacity);
      this.clearLiveCanvas();
    } else {
      this.flushPendingInteraction();
    }
    this.activeStroke = null;
    this.resetPointerState();
    if (pointerId !== null && this.canvas.hasPointerCapture(pointerId)) {
      this.canvas.releasePointerCapture(pointerId);
    }
    this.pushHistoryEntry({
      kind: "stroke-add",
      layerId,
      stroke,
      index: strokeIndex
    });
    this.clearActiveStrokeMetadata();
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
      if (stroke.tool === "shape" || stroke.tool === "text") {
        layer.strokes.splice(index, 1);
        if (stroke.id === this.selectedShapeId) {
          this.clearShapeSelection();
        }
        removed = true;
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
      pressure: event.pressure || 0.5
    };
  }

  private handleWindowPointerDownCapture = (event: PointerEvent): void => {
    if (event.pointerType !== "pen" || !this.shouldOwnPencilPoint(event)) {
      return;
    }
    this.lastStylusActivityAt = performance.now();
    this.claimPencilEvent(event);
    if (this.activeInputChannel === "stylus-touch") {
      return;
    }
    this.startPointerSession(event, "pointer");
  };

  private handleWindowPointerMoveCapture = (event: PointerEvent): void => {
    if (event.pointerType !== "pen") {
      return;
    }
    if (
      this.activeInputChannel === "stylus-touch" &&
      this.activePointerKind === "draw"
    ) {
      if (this.shouldOwnPencilPoint(event)) {
        this.lastStylusActivityAt = performance.now();
        this.claimPencilEvent(event);
      }
      return;
    }
    if (
      this.activeInputChannel === "pointer" &&
      event.pointerId === this.activePointerId
    ) {
      this.lastStylusActivityAt = performance.now();
      this.claimPencilEvent(event);
      this.handlePointerMove(event);
      return;
    }
    if (this.shouldRescueOrphanPenMove(event)) {
      this.lastStylusActivityAt = performance.now();
      this.claimPencilEvent(event);
      this.handlePointerMove(event);
    }
  };

  private handleWindowPointerEndCapture = (event: PointerEvent): void => {
    if (event.pointerType !== "pen") {
      return;
    }
    const ownsActivePointer =
      this.activeInputChannel === "pointer" &&
      event.pointerId === this.activePointerId;
    if (!ownsActivePointer && !this.shouldOwnPencilPoint(event)) {
      return;
    }
    this.lastStylusActivityAt = performance.now();
    this.claimPencilEvent(event);
    if (!ownsActivePointer) {
      return;
    }
    if (event.type === "pointercancel") {
      this.handlePointerCancel(event);
    } else {
      this.handlePointerUp(event);
    }
  };

  private handleWindowTouchCapture = (event: TouchEvent): void => {
    for (const touch of Array.from(event.changedTouches)) {
      const stylusTouch = touch as Touch & {
        altitudeAngle?: number;
        azimuthAngle?: number;
        force?: number;
        touchType?: string;
      };
      const touchType = stylusTouch.touchType ?? "unknown";
      const stylusLike =
        touchType === "stylus" ||
        (stylusTouch.altitudeAngle ?? 0) > 0 ||
        (stylusTouch.azimuthAngle ?? 0) > 0;
      if (!stylusLike) {
        continue;
      }
      if (!this.touchTouchesCanvas(touch, event.target)) {
        continue;
      }
      this.lastStylusActivityAt = performance.now();
      this.claimPencilEvent(event);
      if (event.type === "touchstart") {
        if (this.activeInputChannel === "pointer") {
          continue;
        }
        this.startPointerSession(
          this.pointerEventFromStylusTouch(event, touch),
          "stylus-touch"
        );
        continue;
      }
      if (
        this.activeInputChannel !== "stylus-touch" ||
        touch.identifier !== this.activePointerId
      ) {
        continue;
      }
      const pointerEvent = this.pointerEventFromStylusTouch(event, touch);
      if (event.type === "touchmove") {
        this.handlePointerMove(pointerEvent);
      } else if (event.type === "touchcancel") {
        this.handlePointerCancel(pointerEvent);
      } else if (event.type === "touchend") {
        this.handlePointerUp(pointerEvent);
      }
    }
  };

  private handleCompatibilityMouseCapture = (event: MouseEvent): void => {
    const receivedAt = performance.now();
    if (
      !this.isInPencilCompatibilityGuard(receivedAt) ||
      !this.eventTouchesCanvas(event)
    ) {
      return;
    }
    this.suppressCompatibilityEvent(event);
  };

  private shouldRescueOrphanPenMove(event: PointerEvent): boolean {
    return (
      this.activePointerId === null &&
      event.pointerType === "pen" &&
      this.shouldOwnPencilPoint(event) &&
      ((event.buttons & 1) === 1 || event.pressure > 0.01)
    );
  }

  private handlePointerCaptureChange = (event: PointerEvent): void => {
    if (event.pointerType !== "pen") {
      return;
    }
    if (
      event.type === "gotpointercapture" &&
      this.activeInputChannel === "pointer" &&
      this.canvas.hasPointerCapture(event.pointerId)
    ) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
  };

  private eventTouchesCanvas(event: MouseEvent | PointerEvent): boolean {
    return this.shouldOwnContactPoint(event.clientX, event.clientY, event.target);
  }

  private touchTouchesCanvas(touch: Touch, target: EventTarget | null): boolean {
    return this.shouldOwnContactPoint(touch.clientX, touch.clientY, target);
  }

  private shouldOwnPencilPoint(event: PointerEvent): boolean {
    return this.shouldOwnContactPoint(event.clientX, event.clientY, event.target);
  }

  private shouldOwnContactPoint(
    clientX: number,
    clientY: number,
    target: EventTarget | null
  ): boolean {
    if (target === this.canvas || this.canvas.contains(target as Node | null)) {
      return true;
    }
    if (target instanceof Element) {
      if (
        target.closest(
          "button, input, select, textarea, a, [contenteditable='true'], " +
            ".hand-note-whiteboard-controls, .hand-note-whiteboard-handle, " +
            ".hand-note-selection-menu, .hand-note-selection-transform, " +
            ".hand-note-selection-handle, .hand-note-layer-panel"
        ) !== null
      ) {
        return false;
      }
      if (target.closest(".hand-note-canvas") !== null) {
        return false;
      }
      const ownerView = this.canvas.closest(".hand-note-view");
      const targetView = target.closest(".hand-note-view");
      if (!ownerView || targetView !== ownerView) {
        return false;
      }
    } else {
      return false;
    }
    const rect = this.canvas.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }

  private claimPencilEvent(event: Event): void {
    if (event.cancelable) {
      event.preventDefault();
    }
    event.stopPropagation();
  }

  private pointerEventFromStylusTouch(
    event: TouchEvent,
    touch: Touch
  ): PointerEvent {
    const stylusTouch = touch as Touch & { force?: number };
    const ended = event.type === "touchend" || event.type === "touchcancel";
    const pointerType =
      event.type === "touchstart"
        ? "pointerdown"
        : event.type === "touchmove"
          ? "pointermove"
          : event.type === "touchcancel"
            ? "pointercancel"
            : "pointerup";
    return {
      type: pointerType,
      pointerId: touch.identifier,
      pointerType: "pen",
      clientX: touch.clientX,
      clientY: touch.clientY,
      pressure: ended ? 0 : Math.max(0.01, stylusTouch.force ?? 0.5),
      buttons: ended ? 0 : 1,
      isPrimary: true,
      tiltX: 0,
      tiltY: 0,
      width: Math.max(0.5, (touch.radiusX || 0.25) * 2),
      height: Math.max(0.5, (touch.radiusY || 0.25) * 2),
      timeStamp: event.timeStamp,
      target: event.target,
      cancelable: event.cancelable,
      preventDefault: () => {
        if (event.cancelable) {
          event.preventDefault();
        }
      },
      stopPropagation: () => event.stopPropagation(),
      getCoalescedEvents: () => []
    } as unknown as PointerEvent;
  }

  private isInPencilCompatibilityGuard(receivedAt = performance.now()): boolean {
    return (
      receivedAt - this.lastStylusActivityAt <=
      InkCanvas.PENCIL_COMPATIBILITY_GUARD_MS
    );
  }

  private suppressCompatibilityEvent(event: MouseEvent): void {
    if (event.cancelable) {
      event.preventDefault();
    }
    event.stopPropagation();
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
    }, 300);
  }

  private deferPendingDocumentPublish(): void {
    if (this.publishTimer === null) {
      return;
    }
    window.clearTimeout(this.publishTimer);
    this.publishTimer = null;
  }

  private resumePendingDocumentPublish(): void {
    const pending = this.pendingPublish;
    if (!pending || this.publishTimer !== null) {
      return;
    }
    this.scheduleDocumentPublish(
      pending.document,
      pending.render,
      pending.checkLayerOrder
    );
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

    if (!this.activeStroke) {
      return;
    }

    if (this.isLiveStroke(this.activeStroke)) {
      this.drawLiveStroke();
      this.renderedPointCount = this.activeStroke.points.length;
      return;
    }

    if (this.renderedPointCount >= this.activeStroke.points.length) {
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

  private isFreehandStroke(stroke: AnnotationStroke): boolean {
    return stroke.tool === "pen" || stroke.tool === "pencil";
  }

  private isLiveStroke(stroke: AnnotationStroke): boolean {
    return this.isFreehandStroke(stroke) || stroke.tool === "highlighter";
  }

  private drawLiveStroke(): void {
    const activeStroke =
      this.activeStroke && this.isLiveStroke(this.activeStroke)
        ? this.activeStroke
        : null;
    if (!activeStroke) {
      this.clearLiveCanvas();
      return;
    }
    const rect = this.activeRect ?? this.cachedRect ?? this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const ratio = this.canvasPixelRatio(rect.width, rect.height);
    this.liveContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.liveContext.clearRect(0, 0, rect.width, rect.height);
    this.drawStrokeOnLiveCanvas(
      activeStroke,
      this.activeViewport ?? this.currentViewport(rect),
      this.activeStrokeLayerOpacity
    );
  }

  private drawStrokeOnLiveCanvas(
    stroke: AnnotationStroke,
    viewport: InkCanvasViewport,
    layerOpacity: number
  ): void {
    this.liveContext.save();
    this.liveContext.globalAlpha =
      layerOpacity * (stroke.opacity ?? this.defaultOpacity(stroke.tool));
    this.liveContext.fillStyle = stroke.color;
    if (stroke.tool === "highlighter") {
      this.liveContext.globalCompositeOperation = "multiply";
      this.drawHighlighterStroke(this.liveContext, stroke, viewport);
    } else {
      drawFreehandStroke(
        this.liveContext,
        stroke,
        viewport,
        this.options.getPressureEnabled()
      );
    }
    this.liveContext.restore();
  }

  private drawHighlighterStroke(
    context: CanvasRenderingContext2D,
    stroke: AnnotationStroke,
    viewport: InkCanvasViewport
  ): void {
    const points = stroke.points;
    if (points.length === 0) {
      return;
    }
    const coordinates = points.map((point) => ({
      x: point.x * viewport.documentWidth - viewport.offsetX,
      y: point.y * viewport.documentHeight - viewport.offsetY
    }));
    let length = 0;
    for (let index = 1; index < coordinates.length; index += 1) {
      length += Math.hypot(
        coordinates[index].x - coordinates[index - 1].x,
        coordinates[index].y - coordinates[index - 1].y
      );
    }
    context.fillStyle = stroke.color;
    context.strokeStyle = stroke.color;
    if (length <= Math.max(2, stroke.size * 0.3)) {
      const center = coordinates[coordinates.length - 1];
      context.beginPath();
      context.arc(center.x, center.y, stroke.size / 2, 0, Math.PI * 2);
      context.fill();
      return;
    }
    context.beginPath();
    context.lineWidth = stroke.size;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.moveTo(coordinates[0].x, coordinates[0].y);
    for (let index = 1; index < coordinates.length; index += 1) {
      context.lineTo(coordinates[index].x, coordinates[index].y);
    }
    context.stroke();
  }

  private clearLiveCanvas(): void {
    this.liveContext.save();
    this.liveContext.setTransform(1, 0, 0, 1, 0, 0);
    this.liveContext.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
    this.liveContext.restore();
  }

  private collectStrokePoints(event: PointerEvent, forceLastPoint = false): void {
    if (!this.activeStroke || !this.activeRect || !this.activeViewport) {
      return;
    }

    const samples = this.coalescedEvents(event);
    for (let index = 0; index < samples.length; index += 1) {
      const force = forceLastPoint && index === samples.length - 1;
      if (!force && samples[index].pointerType === "pen" && samples[index].pressure <= 0.01) {
        continue;
      }
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
      this.appendStrokePoint(point, force, samples[index].pointerType === "pen");
    }
  }

  private appendStrokePoint(point: StrokePoint, force: boolean, penInput: boolean): void {
    if (!this.activeStroke || !this.activeRect || !this.activeViewport) {
      return;
    }

    const last = this.activeStroke.points[this.activeStroke.points.length - 1];
    const dx = (point.x - last.x) * this.activeViewport.documentWidth;
    const dy = (point.y - last.y) * this.activeViewport.documentHeight;
    const distanceSquared = dx * dx + dy * dy;
    const pressureChanged = Math.abs(point.pressure - last.pressure) >= 0.025;
    if (force && distanceSquared < 0.01 && !pressureChanged) {
      return;
    }
    if (penInput && this.isFreehandStroke(this.activeStroke)) {
      const distance = Math.sqrt(distanceSquared);
      const rawPressure = Math.max(0, Math.min(1, point.pressure));
      const earlyPressure =
        this.activeStrokePathLength < this.activeStroke.size
          ? Math.max(0.12, rawPressure)
          : rawPressure;
      const eased =
        this.activeSmoothedPressure +
        (earlyPressure - this.activeSmoothedPressure) * 0.4;
      const maxDelta = Math.max(
        0.02,
        0.3 * (distance / Math.max(1, this.activeStroke.size))
      );
      point.pressure = Math.max(
        this.activeSmoothedPressure - maxDelta,
        Math.min(this.activeSmoothedPressure + maxDelta, eased)
      );
      this.activeSmoothedPressure = point.pressure;
      this.activeStrokePathLength += distance;
      if (!force && distanceSquared < 1) {
        last.x = point.x;
        last.y = point.y;
        last.pressure = Math.max(last.pressure, point.pressure);
        return;
      }
    } else if (!force && distanceSquared < 0.25 && !pressureChanged) {
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
    if (event.pointerType === "pen" && this.isIosLike()) {
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

  private isIosLike(): boolean {
    const navigatorValue = globalThis.navigator;
    if (!navigatorValue) {
      return false;
    }
    return (
      /iPad|iPhone|iPod/.test(navigatorValue.userAgent) ||
      (navigatorValue.platform === "MacIntel" && navigatorValue.maxTouchPoints > 1)
    );
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
      viewport,
      this.canvas.getBoundingClientRect()
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
      new Notice("未选中内容");
      return;
    }
    this.selectionBounds = selectedBounds;
    this.lassoPoints = this.rectanglePoints(selectedBounds);
    this.selectionOverlay.setSelection(
      this.lassoPoints,
      selectedBounds,
      viewport,
      this.canvas.getBoundingClientRect()
    );
    this.selectionOverlay.setPasteEnabled(InkCanvas.selectionClipboard !== null);
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
    this.activeStrokePathLength = 0;
    this.activeSmoothedPressure = 0.5;
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
