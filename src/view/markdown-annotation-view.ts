import {
  ItemView,
  MarkdownRenderer,
  TFile,
  ViewStateResult,
  WorkspaceLeaf
} from "obsidian";
import {
  AnnotationDocument,
  AnnotationTool,
  EraserMode,
  SelectionMode,
  ShapeKind,
  createLayer,
  getActiveLayer,
  nextLayerName
} from "../model/annotation";
import {
  loadAnnotation,
  saveAnnotation
} from "../storage/annotation-store";
import { AnnotationToolbar } from "./annotation-toolbar";
import { InkCanvas, InkCanvasViewport } from "./ink-canvas";
import { LayerPanel } from "./layer-panel";
import {
  TemporaryWhiteboard,
  draftFromWhiteboardLayer
} from "./temporary-whiteboard";

export const MARKDOWN_ANNOTATION_VIEW_TYPE = "hand-note-markdown-annotation";

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
          this.renderMarkdown();
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
      onPencilShortcut: () => this.togglePenAndEraser()
    });
    this.surface.append(
      this.inkCanvas.canvas,
      this.inkCanvas.liveCanvas,
      this.inkCanvas.selectionOutline,
      this.inkCanvas.selectionTransform,
      this.inkCanvas.selectionMenu,
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
      onWhiteboard: () => this.toggleWhiteboard(),
      onUndo: () => this.currentInkCanvas()?.undo(),
      onRedo: () => this.currentInkCanvas()?.redo(),
      onClear: () => this.currentInkCanvas()?.clearActiveLayer(),
      onSave: () => void this.flushSave(),
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
      getPressureEnabled: () => this.pressureEnabled,
      onActivate: () => {
        this.activeInkTarget = "whiteboard";
      },
      onChange: (draft) => this.updateWhiteboardDraft(draft),
      onSave: (layer, draft) => this.saveWhiteboardLayer(layer, draft.id),
      onDelete: () => this.deleteWhiteboard(),
      onPencilShortcut: () => this.togglePenAndEraser()
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
      getPressureEnabled: () => this.pressureEnabled,
      onActivate: () => {
        this.activeInkTarget = "whiteboard";
      },
      onChange: (nextDraft) => this.updateWhiteboardDraft(nextDraft),
      onSave: (nextLayer, nextDraft) =>
        this.saveWhiteboardLayer(nextLayer, nextDraft.id),
      onDelete: () => this.deleteWhiteboard(),
      onPencilShortcut: () => this.togglePenAndEraser()
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
