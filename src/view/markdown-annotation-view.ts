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
import { InkCanvas } from "./ink-canvas";
import { LayerPanel } from "./layer-panel";
import { createIconButton, createLabeledSlider, createToolbar } from "./ui";

export const MARKDOWN_ANNOTATION_VIEW_TYPE = "hand-note-markdown-annotation";

export class MarkdownAnnotationView extends ItemView {
  private sourceFile: TFile | null = null;
  private document: AnnotationDocument | null = null;
  private inkCanvas: InkCanvas | null = null;
  private layerPanel: LayerPanel | null = null;
  private toolbar: HTMLDivElement;
  private layerButton: HTMLButtonElement;
  private penButton: HTMLButtonElement;
  private eraserButton: HTMLButtonElement;
  private markdownBody: HTMLDivElement;
  private surface: HTMLDivElement;
  private saveTimer: number | null = null;
  private currentTool: AnnotationTool = "pen";
  private currentColor = "#2563eb";
  private currentSize = 4;
  private currentEraserSize = 24;

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
      getSize: () => this.currentSize,
      getEraserSize: () => this.currentEraserSize,
      onDocumentChange: (next) => this.handleDocumentChange(next),
      onInteraction: () => undefined
    });
    this.surface.append(this.inkCanvas.canvas);

    await this.renderMarkdown();
  }

  private async releaseCurrentFile(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.sourceFile && this.document) {
      await saveAnnotation(this.app, this.sourceFile, this.document);
    }
    this.inkCanvas?.destroy();
    this.inkCanvas = null;
    this.layerPanel = null;
    this.document = null;
    this.sourceFile = null;
  }

  private buildToolbar(): void {
    this.toolbar = createToolbar();

    this.penButton = createIconButton("pencil", "钢笔");
    this.penButton.addEventListener("click", () => this.setTool("pen"));
    this.penButton.classList.add("is-active");

    this.eraserButton = createIconButton("eraser", "橡皮擦");
    this.eraserButton.addEventListener("click", () => this.setTool("eraser"));

    const undoButton = createIconButton("undo", "撤销");
    undoButton.addEventListener("click", () => this.inkCanvas?.undo());

    const redoButton = createIconButton("redo", "重做");
    redoButton.addEventListener("click", () => this.inkCanvas?.redo());

    const clearButton = createIconButton("trash-2", "清除当前层");
    clearButton.addEventListener("click", () => this.inkCanvas?.clearActiveLayer());

    const color = document.createElement("input");
    color.type = "color";
    color.value = this.currentColor;
    color.className = "hand-note-color";
    color.setAttribute("aria-label", "笔迹颜色");
    color.addEventListener("input", () => {
      this.currentColor = color.value;
    });

    const sizeSlider = createLabeledSlider("笔宽", 1, 24, 1, this.currentSize, (value) => {
      this.currentSize = value;
    });

    const eraserSlider = createLabeledSlider("橡皮", 8, 80, 1, this.currentEraserSize, (value) => {
      this.currentEraserSize = value;
    });

    this.layerButton = createIconButton("layers", "笔记层");
    this.layerButton.addEventListener("click", () => {
      this.toggleLayerPanel(!this.layerPanel?.element.classList.contains("is-open"));
    });

    this.toolbar.append(
      this.penButton,
      this.eraserButton,
      undoButton,
      redoButton,
      clearButton,
      color,
      sizeSlider,
      eraserSlider,
      this.layerButton
    );
    this.contentEl.append(this.toolbar);
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
    this.currentTool = tool;
    this.penButton.classList.toggle("is-active", tool === "pen");
    this.eraserButton.classList.toggle("is-active", tool === "eraser");
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

    this.saveTimer = window.setTimeout(() => {
      if (this.sourceFile && this.document) {
        void saveAnnotation(this.app, this.sourceFile, this.document);
      }
    }, 500);
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
