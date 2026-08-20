import {
  ItemView,
  MarkdownRenderer,
  Notice,
  TFile,
  ViewStateResult,
  WorkspaceLeaf
} from "obsidian";
import {
  AnnotationDocument,
  AnnotationImage,
  AnnotationTool,
  EraserMode,
  SelectionMode,
  ShapeArrowHead,
  ShapeKind,
  ShapeLineStyle,
  cloneDocument,
  createLayer,
  generateId,
  getActiveLayer,
  nextLayerName
} from "../model/annotation";
import {
  exportCurrentAnnotation,
  exportLayerPackage
} from "../export/annotation-export";
import {
  loadAnnotation,
  saveAnnotation
} from "../storage/annotation-store";
import { readImageAsset, writeImageAsset } from "../storage/image-asset-store";
import { AnnotationToolbar } from "./annotation-toolbar";
import { ImageProcessingEditor } from "./image-processing-editor";
import { InkCanvas, InkCanvasViewport } from "./ink-canvas";
import { LayerPanel } from "./layer-panel";
import {
  TemporaryWhiteboard,
  draftFromWhiteboardLayer
} from "./temporary-whiteboard";

export const MARKDOWN_ANNOTATION_VIEW_TYPE = "hand-note-markdown-annotation";

function canvasPng(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Unable to encode Markdown image"));
        return;
      }
      void blob.arrayBuffer().then(resolve, reject);
    }, "image/png");
  });
}

function visibleBackgroundColor(element: HTMLElement): string {
  let current: HTMLElement | null = element.parentElement;
  while (current) {
    const value = window.getComputedStyle(current).backgroundColor;
    const match = value.match(/rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)(?:\D+([\d.]+))?/i);
    if (match && (match[4] === undefined || Number(match[4]) > 0.05)) {
      return `#${[match[1], match[2], match[3]]
        .map((channel) => Number(channel).toString(16).padStart(2, "0"))
        .join("")}`;
    }
    current = current.parentElement;
  }
  return "#ffffff";
}

export class MarkdownAnnotationView extends ItemView {
  private sourceFile: TFile | null = null;
  private document: AnnotationDocument | null = null;
  private inkCanvas: InkCanvas | null = null;
  private layerPanel: LayerPanel | null = null;
  private annotationToolbar: AnnotationToolbar | null = null;
  private whiteboard: TemporaryWhiteboard | null = null;
  private editingWhiteboardLayerId: string | null = null;
  private activeInkTarget: "document" | "whiteboard" = "document";
  private markdownBody: HTMLDivElement;
  private surface: HTMLDivElement;
  private scrollContainer: HTMLDivElement;
  private saveTimer: number | null = null;
  private workspaceTimer: number | null = null;
  private workspaceFrame: number | null = null;
  private surfaceObserver: ResizeObserver | null = null;
  private workspaceViewport: InkCanvasViewport | null = null;
  private currentTool: AnnotationTool = "pen";
  private previousDrawingTool: AnnotationTool = "pen";
  private currentColor = "#2563eb";
  private toolSizes: Record<AnnotationTool, number> = {
    hand: 4,
    pen: 4,
    pencil: 3,
    highlighter: 18,
    eraser: 28,
    select: 4,
    text: 24,
    shape: 4
  };
  private pressureEnabled = true;
  private pencilShortcutEnabled = true;
  private eraserMode: EraserMode = "partial";
  private selectionMode: SelectionMode = "free";
  private shapeKind: ShapeKind = "rectangle";
  private shapeLineStyle: ShapeLineStyle = "solid";
  private shapeStartArrow: ShapeArrowHead = "none";
  private shapeEndArrow: ShapeArrowHead = "none";
  private shapeFillEnabled = false;
  private imagePickActive = false;
  private cancelImagePick: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return MARKDOWN_ANNOTATION_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.sourceFile?.basename ?? "手写标注";
  }

  getIcon(): string {
    return "pen-tool";
  }

  async onOpen(): Promise<void> {
    this.contentEl.classList.add("hand-note-view");

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.sourceFile && file.path === this.sourceFile.path) {
          void this.renderMarkdown();
        }
      })
    );
  }

  async onClose(): Promise<void> {
    await this.releaseCurrentFile();
    this.contentEl.empty();
  }

  getState(): Record<string, unknown> {
    return this.sourceFile ? { file: this.sourceFile.path } : {};
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    const filePath = this.readFilePath(state);
    await this.openFile(filePath);
  }

  private readFilePath(state: unknown): string | null {
    if (typeof state !== "object" || state === null || !("file" in state)) {
      return null;
    }

    const file = (state as { file?: unknown }).file;
    return typeof file === "string" ? file : null;
  }

  private async openFile(filePath: string | null): Promise<void> {
    await this.releaseCurrentFile();
    this.contentEl.empty();
    this.contentEl.classList.add("hand-note-view");

    if (!filePath) {
      this.contentEl.createEl("p", { text: "没有可标注的 Markdown 文件。" });
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile) || file.extension !== "md") {
      this.contentEl.createEl("p", { text: "无法找到源文件。" });
      return;
    }

    this.sourceFile = file;
    this.document = await loadAnnotation(this.app, file);
    this.buildToolbar();
    this.buildMarkdownSurface();
    this.layerPanel = new LayerPanel(this.document, {
      onAddLayer: () => this.addLayer(),
      onDeleteLayer: (layerId) => this.deleteLayer(layerId),
      onSelectLayer: (layerId) => this.selectLayer(layerId),
      onEditWhiteboard: (layerId) => this.editWhiteboardLayer(layerId),
      onRenameLayer: (layerId, name) => this.renameLayer(layerId, name),
      onToggleVisibility: (layerId) => this.toggleVisibility(layerId),
      onOpacityChange: (layerId, opacity) => this.setLayerOpacity(layerId, opacity),
      onMoveLayer: (layerId, direction) => this.moveLayer(layerId, direction),
      onClose: () => this.toggleLayerPanel(false)
    });
    this.contentEl.append(this.layerPanel.element);

    await this.renderMarkdown();

    this.inkCanvas = new InkCanvas({
      getDocument: () => this.document as AnnotationDocument,
      getTool: () => this.currentTool,
      getColor: () => this.currentColor,
      getSize: () => this.toolSizes[this.currentTool],
      getEraserSize: () => this.toolSizes.eraser,
      getEraserMode: () => this.eraserMode,
      getSelectionMode: () => this.selectionMode,
      getShapeKind: () => this.shapeKind,
      getShapeLineStyle: () => this.shapeLineStyle,
      getShapeStartArrow: () => this.shapeStartArrow,
      getShapeEndArrow: () => this.shapeEndArrow,
      getShapeFillEnabled: () => this.shapeFillEnabled,
      getPressureEnabled: () => this.pressureEnabled,
      onDocumentChange: (next, renderCanvas) =>
        this.handleDocumentChange(next, renderCanvas, false),
      onActivate: () => {
        if (this.activeInkTarget === "document") {
          return;
        }
        this.activeInkTarget = "document";
        this.whiteboard?.setEditing(false);
        this.annotationToolbar?.setWhiteboardActive(false);
      },
      onFingerPan: (deltaX, deltaY) => {
        this.scrollContainer.scrollLeft += deltaX;
        this.scrollContainer.scrollTop += deltaY;
      },
      onPencilShortcut: () => this.togglePenAndEraser(),
      onRequestTool: (tool) => this.setTool(tool),
      onClipboardChange: (available) => this.annotationToolbar?.setPasteEnabled(available),
      loadImageAsset: (path) => readImageAsset(this.app, path)
    });
    this.surface.append(
      this.inkCanvas.canvas,
      this.inkCanvas.liveCanvas,
      this.inkCanvas.shapeControls
    );
    if (typeof ResizeObserver !== "undefined") {
      this.surfaceObserver = new ResizeObserver(() =>
        this.scheduleWorkspaceUpdate(true)
      );
      this.surfaceObserver.observe(this.surface);
    }
    this.updateWorkspace(true);
    if (this.document.draftWhiteboards?.length) {
      window.requestAnimationFrame(() => this.toggleWhiteboard());
    }
  }

  private async releaseCurrentFile(): Promise<void> {
    this.cancelImagePick?.();
    this.cancelImagePick = null;
    this.imagePickActive = false;
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.flushSave();
    this.whiteboard?.destroy();
    this.whiteboard = null;
    this.editingWhiteboardLayerId = null;
    this.inkCanvas?.destroy();
    this.surfaceObserver?.disconnect();
    this.surfaceObserver = null;
    if (this.workspaceTimer !== null) {
      window.clearTimeout(this.workspaceTimer);
      this.workspaceTimer = null;
    }
    if (this.workspaceFrame !== null) {
      window.cancelAnimationFrame(this.workspaceFrame);
      this.workspaceFrame = null;
    }
    if (this.scrollContainer) {
      this.scrollContainer.removeEventListener("scroll", this.handleMarkdownScroll);
    }
    this.annotationToolbar?.destroy();
    this.inkCanvas = null;
    this.workspaceViewport = null;
    this.layerPanel = null;
    this.annotationToolbar = null;
    this.document = null;
    this.sourceFile = null;
  }

  private buildToolbar(): void {
    this.annotationToolbar = new AnnotationToolbar({
      initialTool: this.currentTool,
      initialColor: this.currentColor,
      initialPressureEnabled: this.pressureEnabled,
      initialPencilShortcutEnabled: this.pencilShortcutEnabled,
      initialEraserMode: this.eraserMode,
      initialSelectionMode: this.selectionMode,
      initialShapeKind: this.shapeKind,
      initialShapeLineStyle: this.shapeLineStyle,
      initialShapeStartArrow: this.shapeStartArrow,
      initialShapeEndArrow: this.shapeEndArrow,
      initialShapeFillEnabled: this.shapeFillEnabled,
      getSize: (tool) => this.toolSizes[tool],
      onToolChange: (tool) => this.setTool(tool),
      onColorChange: (color) => this.setColor(color),
      onSizeChange: (tool, size) => {
        this.toolSizes[tool] = size;
      },
      onPressureChange: (enabled) => {
        this.pressureEnabled = enabled;
        this.annotationToolbar?.setPressureEnabled(enabled);
      },
      onPencilShortcutChange: (enabled) => {
        this.pencilShortcutEnabled = enabled;
        this.annotationToolbar?.setPencilShortcutEnabled(enabled);
      },
      onEraserModeChange: (mode) => {
        this.eraserMode = mode;
      },
      onSelectionModeChange: (mode) => {
        this.selectionMode = mode;
      },
      onShapeKindChange: (kind) => {
        this.shapeKind = kind;
      },
      onShapeLineStyleChange: (style) => {
        this.shapeLineStyle = style;
        this.currentInkCanvas()?.setSelectedShapeLineStyle(style);
      },
      onShapeArrowChange: (position, arrow) => {
        if (position === "start") {
          this.shapeStartArrow = arrow;
        } else {
          this.shapeEndArrow = arrow;
        }
        this.currentInkCanvas()?.setSelectedShapeArrow(position, arrow);
      },
      onShapeFillChange: (enabled) => {
        this.shapeFillEnabled = enabled;
        this.currentInkCanvas()?.setSelectedShapeFill(enabled);
      },
      onPaste: () => this.currentInkCanvas()?.pasteClipboardAtViewportCenter(),
      onWhiteboard: () => this.toggleWhiteboard(),
      onImageProcess: () => void this.beginImageProcessing(),
      onUndo: () => this.currentInkCanvas()?.undo(),
      onRedo: () => this.currentInkCanvas()?.redo(),
      onClear: () => this.currentInkCanvas()?.clearActiveLayer(),
      onSave: () => void this.flushSave(),
      onExport: (mode) => void this.exportDocument(mode),
      exportPrimaryLabel: "当前笔记导出",
      onLayers: () => {
        this.toggleLayerPanel(!this.layerPanel?.element.classList.contains("is-open"));
      }
    });
    this.contentEl.append(this.annotationToolbar.element);
  }

  private buildMarkdownSurface(): void {
    this.scrollContainer = document.createElement("div");
    this.scrollContainer.className = "hand-note-scroll";
    this.scrollContainer.addEventListener("scroll", this.handleMarkdownScroll, {
      passive: true
    });

    this.surface = document.createElement("div");
    this.surface.className = "hand-note-surface";

    this.markdownBody = document.createElement("div");
    this.markdownBody.className = "hand-note-markdown-body markdown-preview-view";
    this.surface.append(this.markdownBody);
    this.scrollContainer.append(this.surface);
    this.contentEl.append(this.scrollContainer);
  }

  private async renderMarkdown(): Promise<void> {
    if (!this.sourceFile) {
      return;
    }

    this.markdownBody.empty();
    const content = await this.app.vault.read(this.sourceFile);
    await MarkdownRenderer.render(
      this.app,
      content,
      this.markdownBody,
      this.sourceFile.path,
      this
    );
    this.updateWorkspace(true);
  }

  private setTool(tool: AnnotationTool): void {
    if (tool !== "hand" && tool !== "eraser" && tool !== "select") {
      this.previousDrawingTool = tool;
    }
    this.currentTool = tool;
    this.annotationToolbar?.setTool(tool);
    this.inkCanvas?.updateInputMode();
    this.whiteboard?.updateInputMode();
  }

  private setColor(color: string): void {
    this.currentColor = color;
    this.annotationToolbar?.setColor(color);
    this.currentInkCanvas()?.setSelectedTextColor(color);
  }

  private async beginImageProcessing(): Promise<void> {
    if (!this.document) return;
    if (this.imagePickActive) {
      this.cancelImagePick?.();
      return;
    }
    this.imagePickActive = true;
    new Notice("请用 Apple Pencil 点选需要处理的图片；手指仍可滚动页面", 3200);
    const imageElement = await this.selectMarkdownImage();
    this.imagePickActive = false;
    if (!imageElement) return;
    try {
      if (!imageElement.complete) await imageElement.decode();
      const sourceWidth = imageElement.naturalWidth || Math.round(imageElement.getBoundingClientRect().width);
      const sourceHeight = imageElement.naturalHeight || Math.round(imageElement.getBoundingClientRect().height);
      if (sourceWidth < 1 || sourceHeight < 1) throw new Error("Selected image has no pixels");
      const scale = Math.min(1, Math.sqrt(8_000_000 / Math.max(1, sourceWidth * sourceHeight)));
      const source = document.createElement("canvas");
      source.width = Math.max(1, Math.round(sourceWidth * scale));
      source.height = Math.max(1, Math.round(sourceHeight * scale));
      const context = source.getContext("2d");
      if (!context) throw new Error("Unable to create Markdown image canvas");
      context.drawImage(imageElement, 0, 0, source.width, source.height);
      const sourcePng = await canvasPng(source);
      const backgroundColor = visibleBackgroundColor(imageElement);
      const result = await new ImageProcessingEditor(
        this.app,
        source,
        backgroundColor
      ).openForResult();
      if (!result) return;

      const surfaceRect = this.surface.getBoundingClientRect();
      const imageRect = imageElement.getBoundingClientRect();
      const documentWidth = Math.max(1, this.surface.clientWidth);
      const documentHeight = Math.max(1, this.surface.clientHeight);
      const sourceBounds = {
        minX: Math.max(0, (imageRect.left - surfaceRect.left) / documentWidth),
        minY: Math.max(0, (imageRect.top - surfaceRect.top) / documentHeight),
        maxX: Math.min(1, (imageRect.right - surfaceRect.left) / documentWidth),
        maxY: Math.min(1, (imageRect.bottom - surfaceRect.top) / documentHeight)
      };
      const imageId = generateId();
      const [sourceAssetPath, assetPath] = await Promise.all([
        writeImageAsset(this.app, imageId, "source", sourcePng),
        writeImageAsset(this.app, imageId, "result", result.png)
      ]);
      const normalizedWidth = sourceBounds.maxX - sourceBounds.minX;
      const displayHeight = normalizedWidth * documentWidth /
        Math.max(1, result.width / result.height) / documentHeight;
      const image: AnnotationImage = {
        id: imageId,
        sourceAssetPath,
        assetPath,
        sourceBounds,
        pixelWidth: result.width,
        pixelHeight: result.height,
        transform: {
          x: sourceBounds.minX,
          y: (sourceBounds.minY + sourceBounds.maxY - displayHeight) / 2,
          width: normalizedWidth,
          height: displayHeight,
          rotation: 0,
          flipX: false,
          flipY: false
        },
        mask: { enabled: result.maskEnabled, color: result.maskColor },
        operations: result.operations
      };
      this.inkCanvas?.recordHistory();
      const layer = getActiveLayer(this.document);
      layer.images = [...(layer.images ?? []), image];
      this.handleDocumentChange(this.document);
      new Notice("已生成派生图片层；原 Markdown 图片未被修改", 4000);
    } catch (error) {
      console.error("HandLayers: failed to process Markdown image", error);
      new Notice("图片读取或处理失败；网络图片可能不允许像素读取");
    }
  }

  private selectMarkdownImage(): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "hand-note-image-pick-overlay";
      this.surface.append(overlay);
      this.markdownBody.classList.add("is-picking-image");
      let touchPointerId: number | null = null;
      let touchX = 0;
      let touchY = 0;
      let finished = false;
      const finish = (image: HTMLImageElement | null) => {
        if (finished) return;
        finished = true;
        this.cancelImagePick = null;
        window.removeEventListener("keydown", keydown);
        overlay.remove();
        this.markdownBody.classList.remove("is-picking-image");
        resolve(image);
      };
      const imageAt = (clientX: number, clientY: number) => {
        const candidates = Array.from(this.markdownBody.querySelectorAll("img"))
          .filter((image) => {
            const rect = image.getBoundingClientRect();
            return clientX >= rect.left && clientX <= rect.right &&
              clientY >= rect.top && clientY <= rect.bottom;
          });
        return candidates.sort((a, b) => {
          const first = a.getBoundingClientRect();
          const second = b.getBoundingClientRect();
          return first.width * first.height - second.width * second.height;
        })[0] ?? null;
      };
      overlay.addEventListener("pointerdown", (event) => {
        if (event.pointerType === "touch") {
          touchPointerId = event.pointerId;
          touchX = event.clientX;
          touchY = event.clientY;
          overlay.setPointerCapture(event.pointerId);
          return;
        }
        if (event.pointerType !== "pen" && event.pointerType !== "mouse") return;
        event.preventDefault();
        const selected = imageAt(event.clientX, event.clientY);
        if (selected) {
          finish(selected);
        } else {
          new Notice("请点选页面中的图片，或按 Esc 取消", 2200);
        }
      });
      overlay.addEventListener("pointermove", (event) => {
        if (touchPointerId !== event.pointerId) return;
        const deltaX = touchX - event.clientX;
        const deltaY = touchY - event.clientY;
        touchX = event.clientX;
        touchY = event.clientY;
        this.scrollContainer.scrollLeft += deltaX;
        this.scrollContainer.scrollTop += deltaY;
      });
      overlay.addEventListener("pointerup", (event) => {
        if (touchPointerId === event.pointerId) touchPointerId = null;
      });
      const keydown = (event: KeyboardEvent) => {
        if (event.key === "Escape") finish(null);
      };
      this.cancelImagePick = () => finish(null);
      window.addEventListener("keydown", keydown);
    });
  }

  togglePenAndEraser(): void {
    if (!this.pencilShortcutEnabled) {
      return;
    }
    this.setTool(
      this.currentTool === "eraser" ? this.previousDrawingTool : "eraser"
    );
  }

  async prepareExport(): Promise<TFile | null> {
    await this.flushSave();
    return this.sourceFile;
  }

  async exportDocument(mode: "document" | "layers"): Promise<void> {
    if (!this.sourceFile || !this.document) {
      return;
    }
    try {
      await this.flushSave();
      if (mode === "document") {
        const result = await exportCurrentAnnotation(this.app, this.sourceFile);
        const drafts = result.excludedDraftWhiteboards
          ? `，已排除 ${result.excludedDraftWhiteboards} 个未保存白板`
          : "";
        new Notice(`当前文件已导出到 ${result.directory}${drafts}`, 8000);
        return;
      }
      const result = await exportLayerPackage(
        this.app,
        this.sourceFile,
        cloneDocument(this.document)
      );
      const drafts = result.excludedDraftWhiteboards
        ? `，已排除 ${result.excludedDraftWhiteboards} 个未保存白板`
        : "";
      new Notice(`图层包已导出到 ${result.path}${drafts}`, 8000);
    } catch (error) {
      console.error("Hand Note Layers: failed to export Markdown annotation", error);
      new Notice("导出失败，请查看开发者控制台");
    }
  }

  private handleDocumentChange(
    document: AnnotationDocument,
    renderCanvas = true,
    syncLayers = true
  ): void {
    this.document = document;
    if (syncLayers) {
      this.layerPanel?.setDocument(document);
    }
    if (renderCanvas) {
      this.inkCanvas?.render();
    }
    this.scheduleSave();
  }

  private scheduleSave(): void {
    this.cancelScheduledSave();

    this.annotationToolbar?.setSaveStatus("saving");
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      if (this.currentInkCanvas()?.isInteracting()) {
        this.scheduleSave();
        return;
      }
      void this.flushSave();
    }, 2000);
  }

  private cancelScheduledSave(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private async flushSave(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const sourceFile = this.sourceFile;
    const document = this.document;
    if (!sourceFile || !document) {
      return;
    }

    this.annotationToolbar?.setSaveStatus("saving");
    try {
      await saveAnnotation(this.app, sourceFile, document);
      this.annotationToolbar?.setSaveStatus("saved");
    } catch (error) {
      console.error("Hand Note Layers: failed to save Markdown annotation", error);
      this.annotationToolbar?.setSaveStatus("error");
    }
  }

  private addLayer(): void {
    if (!this.document) {
      return;
    }
    this.inkCanvas?.recordHistory();
    const layer = createLayer(nextLayerName(this.document));
    this.document.layers.push(layer);
    this.document.activeLayerId = layer.id;
    this.handleDocumentChange(this.document);
  }

  private deleteLayer(layerId: string): void {
    if (!this.document || this.document.layers.length <= 1) {
      return;
    }
    this.inkCanvas?.recordHistory();
    this.document.layers = this.document.layers.filter((layer) => layer.id !== layerId);
    if (this.document.activeLayerId === layerId) {
      getActiveLayer(this.document);
    }
    this.handleDocumentChange(this.document);
  }

  private selectLayer(layerId: string): void {
    if (!this.document) {
      return;
    }
    this.commitEditedWhiteboard(true);
    const layer = this.document.layers.find((item) => item.id === layerId);
    if (!layer || layer.whiteboard) {
      return;
    }
    layer.visible = true;
    if (layer.opacity <= 0) {
      layer.opacity = layer.lastNonZeroOpacity ?? 1;
    }
    this.document.activeLayerId = layerId;
    this.handleDocumentChange(this.document);
  }

  private renameLayer(layerId: string, name: string): void {
    const layer = this.document?.layers.find((item) => item.id === layerId);
    if (!layer) {
      return;
    }
    this.inkCanvas?.recordHistory();
    layer.name = name;
    this.handleDocumentChange(this.document as AnnotationDocument);
  }

  private toggleVisibility(layerId: string): void {
    const layer = this.document?.layers.find((item) => item.id === layerId);
    if (!layer) {
      return;
    }
    if (layer.id === this.editingWhiteboardLayerId) {
      this.commitEditedWhiteboard(true);
      return;
    }
    if (layer.id === this.document?.activeLayerId) {
      layer.visible = true;
      this.layerPanel?.setDocument(this.document as AnnotationDocument);
      return;
    }
    this.inkCanvas?.recordHistory();
    layer.visible = !layer.visible;
    this.handleDocumentChange(this.document as AnnotationDocument);
  }

  private setLayerOpacity(layerId: string, opacity: number): void {
    const layer = this.document?.layers.find((item) => item.id === layerId);
    if (!layer) {
      return;
    }
    layer.opacity = Math.max(0, Math.min(1, opacity));
    if (layer.opacity > 0) {
      layer.lastNonZeroOpacity = layer.opacity;
    }
    this.handleDocumentChange(this.document as AnnotationDocument, true, false);
  }

  private moveLayer(layerId: string, direction: -1 | 1): void {
    if (!this.document) {
      return;
    }
    const index = this.document.layers.findIndex((layer) => layer.id === layerId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= this.document.layers.length) {
      return;
    }

    this.inkCanvas?.recordHistory();
    const [layer] = this.document.layers.splice(index, 1);
    this.document.layers.splice(target, 0, layer);
    this.handleDocumentChange(this.document);
  }

  private toggleLayerPanel(open: boolean): void {
    this.layerPanel?.element.classList.toggle("is-open", open);
  }

  private currentInkCanvas(): InkCanvas | null {
    if (this.activeInkTarget === "whiteboard" && this.whiteboard) {
      return this.whiteboard.inkCanvas;
    }
    return this.inkCanvas;
  }

  private toggleWhiteboard(): void {
    if (this.whiteboard) {
      const editing = !this.whiteboard.isEditing();
      this.whiteboard.setEditing(editing);
      this.annotationToolbar?.setWhiteboardActive(editing);
      if (editing) {
        this.activeInkTarget = "whiteboard";
      }
      return;
    }

    const visible = this.visibleSurfaceRange();
    const margin = 12;
    const width = Math.max(
      240,
      Math.min(visible.documentWidth - margin * 2, visible.documentWidth * 0.88)
    );
    const availableHeight = Math.max(180, visible.documentHeight - visible.top - margin);
    const height = Math.max(180, Math.min(availableHeight, visible.height * 0.58));
    const top = Math.min(
      visible.documentHeight - height,
      visible.top + visible.height * 0.4
    );
    this.whiteboard = new TemporaryWhiteboard({
      host: this.surface,
      initialDraft: this.document?.draftWhiteboards?.[0],
      initialBounds: {
        left: Math.max(0, (visible.documentWidth - width) / 2),
        top: Math.max(0, top),
        width,
        height
      },
      getTool: () => this.currentTool,
      getColor: () => this.currentColor,
      getSize: () => this.toolSizes[this.currentTool],
      getEraserSize: () => this.toolSizes.eraser,
      getEraserMode: () => this.eraserMode,
      getShapeKind: () => this.shapeKind,
      getShapeLineStyle: () => this.shapeLineStyle,
      getShapeStartArrow: () => this.shapeStartArrow,
      getShapeEndArrow: () => this.shapeEndArrow,
      getShapeFillEnabled: () => this.shapeFillEnabled,
      getPressureEnabled: () => this.pressureEnabled,
      onActivate: () => {
        this.activeInkTarget = "whiteboard";
      },
      onChange: (draft) => this.updateWhiteboardDraft(draft),
      onSave: (layer, draft) => this.saveWhiteboardLayer(layer, draft.id),
      onDelete: () => this.deleteWhiteboard(),
      onPencilShortcut: () => this.togglePenAndEraser(),
      onRequestTool: (tool) => this.setTool(tool),
      onClipboardChange: (available) => this.annotationToolbar?.setPasteEnabled(available),
      loadImageAsset: (path) => readImageAsset(this.app, path)
    });
    this.activeInkTarget = "whiteboard";
    this.annotationToolbar?.setWhiteboardActive(true);
  }

  private editWhiteboardLayer(layerId: string): void {
    if (!this.document) {
      return;
    }
    if (this.editingWhiteboardLayerId === layerId && this.whiteboard) {
      this.whiteboard.setEditing(true);
      this.activeInkTarget = "whiteboard";
      this.annotationToolbar?.setWhiteboardActive(true);
      return;
    }
    if (this.whiteboard) {
      if (this.editingWhiteboardLayerId) {
        this.commitEditedWhiteboard(true);
      } else {
        this.updateWhiteboardDraft(this.whiteboard.getDraft());
        this.whiteboard.destroy();
        this.whiteboard = null;
      }
    }
    const layer = this.document.layers.find((item) => item.id === layerId);
    if (!layer?.whiteboard) {
      return;
    }
    const draft = draftFromWhiteboardLayer(layer, this.surface);
    if (!draft) {
      return;
    }
    this.editingWhiteboardLayerId = layer.id;
    layer.visible = false;
    this.handleDocumentChange(this.document, true, false);
    this.whiteboard = new TemporaryWhiteboard({
      host: this.surface,
      initialDraft: draft,
      initialBounds: draft.bounds,
      getTool: () => this.currentTool,
      getColor: () => this.currentColor,
      getSize: () => this.toolSizes[this.currentTool],
      getEraserSize: () => this.toolSizes.eraser,
      getEraserMode: () => this.eraserMode,
      getShapeKind: () => this.shapeKind,
      getShapeLineStyle: () => this.shapeLineStyle,
      getShapeStartArrow: () => this.shapeStartArrow,
      getShapeEndArrow: () => this.shapeEndArrow,
      getShapeFillEnabled: () => this.shapeFillEnabled,
      getPressureEnabled: () => this.pressureEnabled,
      onActivate: () => {
        this.activeInkTarget = "whiteboard";
      },
      onChange: (nextDraft) => this.updateWhiteboardDraft(nextDraft),
      onSave: (nextLayer, nextDraft) =>
        this.saveWhiteboardLayer(nextLayer, nextDraft.id),
      onDelete: () => this.deleteWhiteboard(),
      onPencilShortcut: () => this.togglePenAndEraser(),
      onRequestTool: (tool) => this.setTool(tool),
      onClipboardChange: (available) => this.annotationToolbar?.setPasteEnabled(available),
      loadImageAsset: (path) => readImageAsset(this.app, path)
    });
    this.activeInkTarget = "whiteboard";
    this.annotationToolbar?.setWhiteboardActive(true);
  }

  private commitEditedWhiteboard(hide: boolean): void {
    const layerId = this.editingWhiteboardLayerId;
    const whiteboard = this.whiteboard;
    if (!layerId || !whiteboard || !this.document) {
      return;
    }
    const index = this.document.layers.findIndex((layer) => layer.id === layerId);
    if (index < 0) {
      return;
    }
    const previous = this.document.layers[index];
    const draft = whiteboard.getDraft();
    const replacement = whiteboard.createLayer(previous.name, previous.whiteboard?.bounds.pageIndex);
    replacement.id = previous.id;
    replacement.name = previous.name;
    replacement.opacity = previous.opacity;
    replacement.lastNonZeroOpacity = previous.lastNonZeroOpacity;
    replacement.visible = !hide;
    this.document.layers[index] = replacement;
    this.document.draftWhiteboards = (this.document.draftWhiteboards ?? []).filter(
      (item) => item.id !== draft.id
    );
    whiteboard.destroy();
    this.whiteboard = null;
    this.editingWhiteboardLayerId = null;
    this.activeInkTarget = "document";
    this.annotationToolbar?.setWhiteboardActive(false);
    this.handleDocumentChange(this.document);
  }

  private deleteWhiteboard(): void {
    const draftId = this.whiteboard?.getDraft().id;
    const editingLayerId = this.editingWhiteboardLayerId;
    this.whiteboard?.destroy();
    this.whiteboard = null;
    this.editingWhiteboardLayerId = null;
    if (draftId && this.document) {
      this.document.draftWhiteboards = (this.document.draftWhiteboards ?? []).filter(
        (draft) => draft.id !== draftId
      );
      this.handleDocumentChange(this.document, false);
    }
    if (editingLayerId && this.document) {
      this.document.layers = this.document.layers.filter(
        (layer) => layer.id !== editingLayerId
      );
      getActiveLayer(this.document);
      this.handleDocumentChange(this.document);
    }
    this.activeInkTarget = "document";
    this.annotationToolbar?.setWhiteboardActive(false);
  }

  private updateWhiteboardDraft(draft: ReturnType<TemporaryWhiteboard["getDraft"]>): void {
    if (!this.document) {
      return;
    }
    const drafts = this.document.draftWhiteboards ?? [];
    const index = drafts.findIndex((item) => item.id === draft.id);
    if (index >= 0) {
      drafts[index] = draft;
    } else {
      drafts.push(draft);
    }
    this.document.draftWhiteboards = drafts;
    this.handleDocumentChange(this.document, false, false);
  }

  private saveWhiteboardLayer(
    layer: ReturnType<TemporaryWhiteboard["createLayer"]>,
    draftId: string
  ): void {
    if (!this.document) {
      return;
    }
    this.inkCanvas?.recordHistory();
    const editingLayerId = this.editingWhiteboardLayerId;
    const existingIndex = editingLayerId
      ? this.document.layers.findIndex((item) => item.id === editingLayerId)
      : -1;
    if (existingIndex >= 0) {
      const existing = this.document.layers[existingIndex];
      layer.id = existing.id;
      layer.name = existing.name;
      layer.opacity = existing.opacity;
      layer.lastNonZeroOpacity = existing.lastNonZeroOpacity;
      layer.visible = true;
      this.document.layers[existingIndex] = layer;
    } else {
      const number =
        this.document.layers.filter((item) => /^白板\d+$/.test(item.name)).length + 1;
      layer.name = `白板${number}`;
      this.document.layers.push(layer);
    }
    getActiveLayer(this.document);
    this.document.draftWhiteboards = (this.document.draftWhiteboards ?? []).filter(
      (draft) => draft.id !== draftId
    );
    this.whiteboard?.destroy();
    this.whiteboard = null;
    this.editingWhiteboardLayerId = null;
    this.activeInkTarget = "document";
    this.annotationToolbar?.setWhiteboardActive(false);
    this.handleDocumentChange(this.document);
  }

  private handleMarkdownScroll = (): void => {
    if (this.workspaceFrame === null) {
      this.workspaceFrame = window.requestAnimationFrame(() => {
        this.workspaceFrame = null;
        this.inkCanvas?.syncInteractionGeometry();
        if (this.viewportOutsideWorkspace()) {
          this.updateWorkspace(true);
        }
      });
    }
    if (this.workspaceTimer !== null) {
      window.clearTimeout(this.workspaceTimer);
    }
    this.workspaceTimer = window.setTimeout(() => {
      this.workspaceTimer = null;
      this.updateWorkspace(false);
    }, 140);
  };

  private scheduleWorkspaceUpdate(force: boolean): void {
    if (this.workspaceFrame !== null) {
      window.cancelAnimationFrame(this.workspaceFrame);
    }
    this.workspaceFrame = window.requestAnimationFrame(() => {
      this.workspaceFrame = null;
      this.updateWorkspace(force);
    });
  }

  private updateWorkspace(force: boolean): void {
    const inkCanvas = this.inkCanvas;
    if (!inkCanvas || !this.surface || !this.scrollContainer) {
      return;
    }
    if (inkCanvas.isInteracting()) {
      if (this.workspaceTimer === null) {
        this.workspaceTimer = window.setTimeout(() => {
          this.workspaceTimer = null;
          this.updateWorkspace(force);
        }, 80);
      }
      return;
    }

    const visible = this.visibleSurfaceRange();
    const current = this.workspaceViewport;
    const threshold = visible.height * 0.25;
    const dimensionsChanged =
      !current ||
      Math.abs(current.documentWidth - visible.documentWidth) > 1 ||
      Math.abs(current.documentHeight - visible.documentHeight) > 1;
    const nearBoundary =
      !current ||
      visible.top < current.offsetY + threshold ||
      visible.bottom > current.offsetY + current.height - threshold;
    if (!force && !dimensionsChanged && !nearBoundary) {
      return;
    }

    const workspaceHeight = Math.min(
      visible.documentHeight,
      Math.max(visible.height * 2.5, visible.height + 384)
    );
    const maxTop = Math.max(0, visible.documentHeight - workspaceHeight);
    let offsetY = Math.max(
      0,
      Math.min(maxTop, visible.top - (workspaceHeight - visible.height) / 2)
    );
    offsetY = Math.max(0, Math.min(maxTop, Math.floor(offsetY / 256) * 256));

    const next: InkCanvasViewport = {
      documentWidth: visible.documentWidth,
      documentHeight: visible.documentHeight,
      offsetX: 0,
      offsetY,
      width: visible.documentWidth,
      height: workspaceHeight
    };
    if (
      current &&
      !dimensionsChanged &&
      Math.abs(next.offsetY - current.offsetY) < Math.max(256, visible.height * 0.5)
    ) {
      return;
    }
    this.workspaceViewport = next;
    inkCanvas.setViewport(next);
  }

  private viewportOutsideWorkspace(): boolean {
    const current = this.workspaceViewport;
    if (!current || !this.surface || !this.scrollContainer) {
      return true;
    }
    const visible = this.visibleSurfaceRange();
    return (
      visible.top < current.offsetY ||
      visible.bottom > current.offsetY + current.height
    );
  }

  private visibleSurfaceRange(): {
    top: number;
    bottom: number;
    height: number;
    documentWidth: number;
    documentHeight: number;
  } {
    const scrollRect = this.scrollContainer.getBoundingClientRect();
    const surfaceRect = this.surface.getBoundingClientRect();
    const documentWidth = Math.max(1, this.surface.clientWidth);
    const documentHeight = Math.max(1, this.surface.scrollHeight);
    const top = Math.max(0, Math.min(documentHeight, scrollRect.top - surfaceRect.top));
    const bottom = Math.max(
      top,
      Math.min(documentHeight, scrollRect.bottom - surfaceRect.top)
    );
    return {
      top,
      bottom,
      height: Math.max(1, Math.min(documentHeight, bottom - top)),
      documentWidth,
      documentHeight
    };
  }
}
