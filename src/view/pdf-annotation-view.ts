import {
  ItemView,
  TFile,
  WorkspaceLeaf
} from "obsidian";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerDataUrl from "pdfjs-dist/build/pdf.worker.min.mjs?worker-dataurl";
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

export const PDF_ANNOTATION_VIEW_TYPE = "hand-note-pdf-annotation";

function createWorkerBlobUrl(dataUrl: string): string {
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return URL.createObjectURL(new Blob([bytes], { type: "application/javascript" }));
}

pdfjsLib.GlobalWorkerOptions.workerSrc = createWorkerBlobUrl(pdfWorkerDataUrl);

export class PdfAnnotationView extends ItemView {
  private sourceFile: TFile | null = null;
  private document: AnnotationDocument | null = null;
  private pdfDocument: pdfjsLib.PDFDocumentProxy | null = null;
  private toolbar: HTMLDivElement;
  private layerButton: HTMLButtonElement;
  private penButton: HTMLButtonElement;
  private eraserButton: HTMLButtonElement;
  private pageContainer: HTMLDivElement;
  private scrollContainer: HTMLDivElement;
  private layerPanel: LayerPanel | null = null;
  private inkCanvases = new Map<number, InkCanvas>();
  private currentPage = 1;
  private currentTool: AnnotationTool = "pen";
  private currentColor = "#2563eb";
  private currentSize = 4;
  private currentEraserSize = 24;
  private pageScale = 1;
  private saveTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return PDF_ANNOTATION_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.sourceFile?.basename ?? "PDF 手写标注";
  }

  getIcon(): string {
    return "file-text";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.classList.add("hand-note-view", "hand-note-pdf-view");

    const state = this.getState() as { file?: string } | undefined;
    if (!state?.file) {
      this.contentEl.createEl("p", { text: "没有可标注的 PDF 文件。" });
      return;
    }

    this.sourceFile = this.app.vault.getAbstractFileByPath(state.file) as TFile | null;
    if (!this.sourceFile) {
      this.contentEl.createEl("p", { text: "无法找到源文件。" });
      return;
    }

    this.document = await loadAnnotation(this.app, this.sourceFile);
    this.buildToolbar();
    this.buildPdfSurface();
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

    await this.loadPdf();
  }

  async onClose(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }
    if (this.sourceFile && this.document) {
      await saveAnnotation(this.app, this.sourceFile, this.document);
    }
    for (const canvas of this.inkCanvases.values()) {
      canvas.destroy();
    }
    this.inkCanvases.clear();
    this.pdfDocument?.destroy();
    this.contentEl.empty();
  }

  private buildToolbar(): void {
    this.toolbar = createToolbar();

    this.penButton = createIconButton("pencil", "钢笔");
    this.penButton.addEventListener("click", () => this.setTool("pen"));
    this.penButton.classList.add("is-active");

    this.eraserButton = createIconButton("eraser", "橡皮擦");
    this.eraserButton.addEventListener("click", () => this.setTool("eraser"));

    const undoButton = createIconButton("undo", "撤销");
    undoButton.addEventListener("click", () => this.currentInkCanvas()?.undo());

    const redoButton = createIconButton("redo", "重做");
    redoButton.addEventListener("click", () => this.currentInkCanvas()?.redo());

    const clearButton = createIconButton("trash-2", "清除当前层");
    clearButton.addEventListener("click", () => this.currentInkCanvas()?.clearActiveLayer());

    const previousPageButton = createIconButton("chevron-up", "上一页");
    previousPageButton.addEventListener("click", () => this.goToPage(this.currentPage - 1));

    const pageInput = document.createElement("input");
    pageInput.type = "number";
    pageInput.min = "1";
    pageInput.max = String(this.pdfDocument?.numPages ?? 1);
    pageInput.value = "1";
    pageInput.className = "hand-note-page-input";
    pageInput.setAttribute("aria-label", "PDF 页码");
    pageInput.addEventListener("change", () => {
      const value = Number(pageInput.value);
      if (Number.isFinite(value)) {
        this.goToPage(value);
      }
    });

    const nextPageButton = createIconButton("chevron-down", "下一页");
    nextPageButton.addEventListener("click", () => this.goToPage(this.currentPage + 1));

    const zoomOutButton = createIconButton("zoom-out", "缩小");
    zoomOutButton.addEventListener("click", () => this.zoom(-0.1));

    const zoomInButton = createIconButton("zoom-in", "放大");
    zoomInButton.addEventListener("click", () => this.zoom(0.1));

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
      previousPageButton,
      pageInput,
      nextPageButton,
      zoomOutButton,
      zoomInButton,
      color,
      sizeSlider,
      eraserSlider,
      this.layerButton
    );
    this.contentEl.append(this.toolbar);
  }

  private buildPdfSurface(): void {
    this.scrollContainer = document.createElement("div");
    this.scrollContainer.className = "hand-note-scroll hand-note-pdf-scroll";

    this.pageContainer = document.createElement("div");
    this.pageContainer.className = "hand-note-pdf-pages";
    this.scrollContainer.append(this.pageContainer);
    this.contentEl.append(this.scrollContainer);
  }

  private async loadPdf(): Promise<void> {
    if (!this.sourceFile) {
      return;
    }

    await this.waitForLayout();
    const data = await this.app.vault.readBinary(this.sourceFile);
    this.pdfDocument = await pdfjsLib.getDocument({
      data: new Uint8Array(data)
    }).promise;

    const pageInput = this.toolbar.querySelector(
      ".hand-note-page-input"
    ) as HTMLInputElement | null;
    if (pageInput) {
      pageInput.max = String(this.pdfDocument.numPages);
    }

    for (let pageIndex = 1; pageIndex <= this.pdfDocument.numPages; pageIndex += 1) {
      await this.renderPage(pageIndex);
    }
  }

  private waitForLayout(): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }

  private async renderPage(pageIndex: number): Promise<void> {
    if (!this.pdfDocument) {
      return;
    }

    const page = await this.pdfDocument.getPage(pageIndex);
    const baseViewport = page.getViewport({ scale: 1 });
    const containerWidth = Math.max(this.pageContainer.clientWidth - 32, 320);
    const fitScale = containerWidth / baseViewport.width;
    const viewport = page.getViewport({ scale: fitScale * this.pageScale });

    const pageEl = document.createElement("div");
    pageEl.className = "hand-note-pdf-page";
    pageEl.dataset.page = String(pageIndex);
    pageEl.style.width = `${viewport.width}px`;
    pageEl.style.height = `${viewport.height}px`;

    const renderCanvas = document.createElement("canvas");
    renderCanvas.className = "hand-note-pdf-canvas";
    renderCanvas.style.width = `${viewport.width}px`;
    renderCanvas.style.height = `${viewport.height}px`;
    renderCanvas.width = Math.round(viewport.width * window.devicePixelRatio);
    renderCanvas.height = Math.round(viewport.height * window.devicePixelRatio);

    const renderContext = renderCanvas.getContext("2d");
    if (renderContext) {
      const ratio = window.devicePixelRatio || 1;
      renderContext.setTransform(ratio, 0, 0, ratio, 0, 0);
      await page.render({
        canvasContext: renderContext,
        viewport
      }).promise;
    }

    pageEl.append(renderCanvas);
    this.pageContainer.append(pageEl);

    const inkCanvas = new InkCanvas({
      getDocument: () => this.document as AnnotationDocument,
      getTool: () => this.currentTool,
      getColor: () => this.currentColor,
      getSize: () => this.currentSize,
      getEraserSize: () => this.currentEraserSize,
      onDocumentChange: (next) => this.handleDocumentChange(next),
      onInteraction: () => undefined,
      pageIndex
    });
    this.inkCanvases.set(pageIndex, inkCanvas);
    pageEl.append(inkCanvas.canvas);
  }

  private currentInkCanvas(): InkCanvas | null {
    return this.inkCanvases.get(this.currentPage) ?? null;
  }

  private goToPage(page: number): void {
    const pageCount = this.pdfDocument?.numPages ?? 1;
    const next = Math.max(1, Math.min(pageCount, page));
    this.currentPage = next;

    const target = this.pageContainer.querySelector(
      `.hand-note-pdf-page[data-page="${next}"]`
    );
    const pageInput = this.toolbar.querySelector(
      ".hand-note-page-input"
    ) as HTMLInputElement | null;
    if (pageInput) {
      pageInput.value = String(next);
    }
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  private zoom(delta: number): void {
    this.pageScale = Math.max(0.5, Math.min(2.5, this.pageScale + delta));
    for (const canvas of this.inkCanvases.values()) {
      canvas.destroy();
    }
    this.inkCanvases.clear();
    this.pageContainer.empty();
    if (this.pdfDocument) {
      void this.renderAllPages();
    }
  }

  private async renderAllPages(): Promise<void> {
    if (!this.pdfDocument) {
      return;
    }
    for (let pageIndex = 1; pageIndex <= this.pdfDocument.numPages; pageIndex += 1) {
      await this.renderPage(pageIndex);
    }
  }

  private setTool(tool: AnnotationTool): void {
    this.currentTool = tool;
    this.penButton.classList.toggle("is-active", tool === "pen");
    this.eraserButton.classList.toggle("is-active", tool === "eraser");
  }

  private handleDocumentChange(document: AnnotationDocument): void {
    this.document = document;
    this.layerPanel?.setDocument(document);
    for (const inkCanvas of this.inkCanvases.values()) {
      inkCanvas.render();
    }
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
    this.currentInkCanvas()?.recordHistory();
    const layer = createLayer(`图层 ${this.document.layers.length + 1}`);
    this.document.layers.push(layer);
    this.document.activeLayerId = layer.id;
    this.handleDocumentChange(this.document);
  }

  private deleteLayer(layerId: string): void {
    if (!this.document || this.document.layers.length <= 1) {
      return;
    }
    this.currentInkCanvas()?.recordHistory();
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
    this.currentInkCanvas()?.recordHistory();
    layer.name = name;
    this.handleDocumentChange(this.document as AnnotationDocument);
  }

  private toggleVisibility(layerId: string): void {
    const layer = this.document?.layers.find((item) => item.id === layerId);
    if (!layer) {
      return;
    }
    this.currentInkCanvas()?.recordHistory();
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

    this.currentInkCanvas()?.recordHistory();
    const [layer] = this.document.layers.splice(index, 1);
    this.document.layers.splice(target, 0, layer);
    this.handleDocumentChange(this.document);
  }

  private toggleLayerPanel(open: boolean): void {
    this.layerPanel?.element.classList.toggle("is-open", open);
  }
}
