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
  createLayer,
  getActiveLayer
} from "../model/annotation";
import {
  loadAnnotation,
  saveAnnotation
} from "../storage/annotation-store";
import { AnnotationToolbar } from "./annotation-toolbar";
import { InkCanvas } from "./ink-canvas";
import { LayerPanel } from "./layer-panel";

export const MARKDOWN_ANNOTATION_VIEW_TYPE = "hand-note-markdown-annotation";

export class MarkdownAnnotationView extends ItemView {
  private sourceFile: TFile | null = null;
  private document: AnnotationDocument | null = null;
  private inkCanvas: InkCanvas | null = null;
  private layerPanel: LayerPanel | null = null;
  private annotationToolbar: AnnotationToolbar | null = null;
  private markdownBody: HTMLDivElement;
  private surface: HTMLDivElement;
  private saveTimer: number | null = null;
  private currentTool: AnnotationTool = "pen";
  private previousDrawingTool: AnnotationTool = "pen";
  private currentColor = "#2563eb";
  private toolSizes: Record<AnnotationTool, number> = {
    hand: 4,
    pen: 4,
    pencil: 3,
    highlighter: 18,
    eraser: 28
  };
  private pressureEnabled = true;
  private fingerDrawingEnabled = false;
  private pencilShortcutEnabled = true;

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
      onRenameLayer: (layerId, name) => this.renameLayer(layerId, name),
      onToggleVisibility: (layerId) => this.toggleVisibility(layerId),
      onOpacityChange: (layerId, opacity) => this.setLayerOpacity(layerId, opacity),
      onMoveLayer: (layerId, direction) => this.moveLayer(layerId, direction),
      onClose: () => this.toggleLayerPanel(false)
    });
    this.contentEl.append(this.layerPanel.element);

    this.inkCanvas = new InkCanvas({
      getDocument: () => this.document as AnnotationDocument,
      getTool: () => this.currentTool,
      getColor: () => this.currentColor,
      getSize: () => this.toolSizes[this.currentTool],
      getEraserSize: () => this.toolSizes.eraser,
      getPressureEnabled: () => this.pressureEnabled,
      getFingerDrawingEnabled: () => this.fingerDrawingEnabled,
      onDocumentChange: (next) => this.handleDocumentChange(next),
      onInteraction: () => undefined,
      onPencilShortcut: () => this.togglePenAndEraser()
    });
    this.surface.append(this.inkCanvas.canvas);

    await this.renderMarkdown();
  }

  private async releaseCurrentFile(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.flushSave();
    this.inkCanvas?.destroy();
    this.inkCanvas = null;
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
      initialFingerDrawingEnabled: this.fingerDrawingEnabled,
      initialPencilShortcutEnabled: this.pencilShortcutEnabled,
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
      onFingerDrawingChange: (enabled) => this.setFingerDrawingEnabled(enabled),
      onPencilShortcutChange: (enabled) => {
        this.pencilShortcutEnabled = enabled;
        this.annotationToolbar?.setPencilShortcutEnabled(enabled);
      },
      onUndo: () => this.inkCanvas?.undo(),
      onRedo: () => this.inkCanvas?.redo(),
      onClear: () => this.inkCanvas?.clearActiveLayer(),
      onSave: () => void this.flushSave(),
      onLayers: () => {
        this.toggleLayerPanel(!this.layerPanel?.element.classList.contains("is-open"));
      }
    });
    this.contentEl.append(this.annotationToolbar.element);
  }

  private buildMarkdownSurface(): void {
    const scrollContainer = document.createElement("div");
    scrollContainer.className = "hand-note-scroll";

    this.surface = document.createElement("div");
    this.surface.className = "hand-note-surface";

    this.markdownBody = document.createElement("div");
    this.markdownBody.className = "hand-note-markdown-body markdown-preview-view";
    this.surface.append(this.markdownBody);
    scrollContainer.append(this.surface);
    this.contentEl.append(scrollContainer);
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
    this.inkCanvas?.render();
  }

  private setTool(tool: AnnotationTool): void {
    if (tool !== "hand" && tool !== "eraser") {
      this.previousDrawingTool = tool;
    }
    this.currentTool = tool;
    this.annotationToolbar?.setTool(tool);
    this.inkCanvas?.updateInputMode();
  }

  private setColor(color: string): void {
    this.currentColor = color;
    this.annotationToolbar?.setColor(color);
  }

  private setFingerDrawingEnabled(enabled: boolean): void {
    this.fingerDrawingEnabled = enabled;
    this.annotationToolbar?.setFingerDrawingEnabled(enabled);
    this.inkCanvas?.updateInputMode();
  }

  togglePenAndEraser(): void {
    if (!this.pencilShortcutEnabled) {
      return;
    }
    this.setTool(
      this.currentTool === "eraser" ? this.previousDrawingTool : "eraser"
    );
  }

  private handleDocumentChange(document: AnnotationDocument): void {
    this.document = document;
    this.layerPanel?.setDocument(document);
    this.inkCanvas?.render();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }

    this.annotationToolbar?.setSaveStatus("saving");
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flushSave();
    }, 350);
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
    const layer = createLayer(`图层 ${this.document.layers.length + 1}`);
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
      this.document.activeLayerId = this.document.layers[0].id;
    }
    this.handleDocumentChange(this.document);
  }

  private selectLayer(layerId: string): void {
    if (!this.document) {
      return;
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
    this.inkCanvas?.recordHistory();
    layer.visible = !layer.visible;
    this.handleDocumentChange(this.document as AnnotationDocument);
  }

  private setLayerOpacity(layerId: string, opacity: number): void {
    const layer = this.document?.layers.find((item) => item.id === layerId);
    if (!layer) {
      return;
    }
    layer.opacity = opacity;
    this.handleDocumentChange(this.document as AnnotationDocument);
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
}
