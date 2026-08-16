import {
  ItemView,
  TFile,
  ViewStateResult,
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
import { AnnotationToolbar } from "./annotation-toolbar";
import { InkCanvas, InkCanvasHistoryState } from "./ink-canvas";
import { LayerPanel } from "./layer-panel";
import { createIconButton } from "./ui";

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

let pdfWorkerBlobUrl: string | null = null;

function ensurePdfWorker(): void {
  if (pdfWorkerBlobUrl !== null) {
    return;
  }

  pdfWorkerBlobUrl = createWorkerBlobUrl(pdfWorkerDataUrl);
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerBlobUrl;
}

export class PdfAnnotationView extends ItemView {
  private sourceFile: TFile | null = null;
  private document: AnnotationDocument | null = null;
  private pdfDocument: pdfjsLib.PDFDocumentProxy | null = null;
  private toolbar: HTMLDivElement;
  private annotationToolbar: AnnotationToolbar | null = null;
  private pageContainer: HTMLDivElement;
  private scrollContainer: HTMLDivElement;
  private layerPanel: LayerPanel | null = null;
  private inkCanvases = new Map<number, InkCanvas>();
  private pageHistories = new Map<number, InkCanvasHistoryState>();
  private pageElements = new Map<number, HTMLDivElement>();
  private pageRenderPromises = new Map<number, Promise<void>>();
  private pageUnloadTimers = new Map<number, number>();
  private nearbyPages = new Set<number>();
  private pageObserver: IntersectionObserver | null = null;
  private pageRenderGeneration = 0;
  private scrollFrame: number | null = null;
  private currentPage = 1;
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
    this.contentEl.classList.add("hand-note-view", "hand-note-pdf-view");
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
    this.contentEl.classList.add("hand-note-view", "hand-note-pdf-view");

    if (!filePath) {
      this.contentEl.createEl("p", { text: "没有可标注的 PDF 文件。" });
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile) || file.extension !== "pdf") {
      this.contentEl.createEl("p", { text: "无法找到源文件。" });
      return;
    }

    this.sourceFile = file;
    this.currentPage = 1;
    this.pageScale = 1;
    this.document = await loadAnnotation(this.app, file);
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

  private async releaseCurrentFile(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.flushSave();
    this.pageRenderGeneration += 1;
    this.pageObserver?.disconnect();
    this.pageObserver = null;
    if (this.scrollFrame !== null) {
      window.cancelAnimationFrame(this.scrollFrame);
      this.scrollFrame = null;
    }
    if (this.scrollContainer) {
      this.scrollContainer.removeEventListener("scroll", this.handlePdfScroll);
    }
    for (const timer of this.pageUnloadTimers.values()) {
      window.clearTimeout(timer);
    }
    this.pageUnloadTimers.clear();
    this.nearbyPages.clear();
    for (const canvas of this.inkCanvases.values()) {
      canvas.destroy();
    }
    this.inkCanvases.clear();
    this.pageHistories.clear();
    this.pageElements.clear();
    this.pageRenderPromises.clear();
    await this.pdfDocument?.destroy();
    this.pdfDocument = null;
    this.layerPanel = null;
    this.annotationToolbar = null;
    this.document = null;
    this.sourceFile = null;
  }

  private buildToolbar(): void {
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
      onUndo: () => this.currentInkCanvas()?.undo(),
      onRedo: () => this.currentInkCanvas()?.redo(),
      onClear: () => this.currentInkCanvas()?.clearActiveLayer(),
      onSave: () => void this.flushSave(),
      onLayers: () => {
        this.toggleLayerPanel(!this.layerPanel?.element.classList.contains("is-open"));
      },
      navigationControls: [
        previousPageButton,
        pageInput,
        nextPageButton,
        zoomOutButton,
        zoomInButton
      ]
    });
    this.toolbar = this.annotationToolbar.element;
    this.contentEl.append(this.toolbar);
  }

  private buildPdfSurface(): void {
    this.scrollContainer = document.createElement("div");
    this.scrollContainer.className = "hand-note-scroll hand-note-pdf-scroll";

    this.pageContainer = document.createElement("div");
    this.pageContainer.className = "hand-note-pdf-pages";
    this.scrollContainer.append(this.pageContainer);
    this.scrollContainer.addEventListener("scroll", this.handlePdfScroll, {
      passive: true
    });
    this.contentEl.append(this.scrollContainer);
  }

  private async loadPdf(): Promise<void> {
    if (!this.sourceFile) {
      return;
    }

    ensurePdfWorker();
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

    await this.buildPagePlaceholders();
  }

  private waitForLayout(): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }

  private async buildPagePlaceholders(): Promise<void> {
    const pdfDocument = this.pdfDocument;
    if (!pdfDocument) {
      return;
    }

    const generation = ++this.pageRenderGeneration;
    this.pageObserver?.disconnect();
    this.pageObserver = null;
    for (const timer of this.pageUnloadTimers.values()) {
      window.clearTimeout(timer);
    }
    this.pageUnloadTimers.clear();
    this.nearbyPages.clear();
    this.preserveInkCanvasHistories();
    this.inkCanvases.clear();
    this.pageElements.clear();
    this.pageRenderPromises.clear();
    this.pageContainer.empty();

    const containerWidth = Math.max(this.pageContainer.clientWidth - 32, 320);
    for (let pageIndex = 1; pageIndex <= pdfDocument.numPages; pageIndex += 1) {
      const page = await pdfDocument.getPage(pageIndex);
      if (generation !== this.pageRenderGeneration) {
        return;
      }
      const baseViewport = page.getViewport({ scale: 1 });
      const fitScale = containerWidth / baseViewport.width;
      const viewport = page.getViewport({ scale: fitScale * this.pageScale });
      const pageEl = document.createElement("div");
      pageEl.className = "hand-note-pdf-page";
      pageEl.dataset.page = String(pageIndex);
      pageEl.style.width = `${viewport.width}px`;
      pageEl.style.height = `${viewport.height}px`;
      this.pageElements.set(pageIndex, pageEl);
      this.pageContainer.append(pageEl);
    }

    this.observePageVisibility();
    await this.renderPageWindow(this.currentPage);
  }

  private renderPage(pageIndex: number): Promise<void> {
    const existing = this.pageRenderPromises.get(pageIndex);
    if (existing) {
      return existing;
    }

    const renderPromise = this.renderPageContent(pageIndex).finally(() => {
      if (this.pageRenderPromises.get(pageIndex) === renderPromise) {
        this.pageRenderPromises.delete(pageIndex);
      }
    });
    this.pageRenderPromises.set(pageIndex, renderPromise);
    return renderPromise;
  }

  private async renderPageContent(pageIndex: number): Promise<void> {
    const pdfDocument = this.pdfDocument;
    const pageEl = this.pageElements.get(pageIndex);
    if (!pdfDocument || !pageEl || this.inkCanvases.has(pageIndex)) {
      return;
    }

    const generation = this.pageRenderGeneration;
    const page = await pdfDocument.getPage(pageIndex);
    if (generation !== this.pageRenderGeneration) {
      return;
    }
    const baseViewport = page.getViewport({ scale: 1 });
    const fitScale = pageEl.clientWidth / baseViewport.width;
    const viewport = page.getViewport({ scale: fitScale });

    const renderCanvas = document.createElement("canvas");
    renderCanvas.className = "hand-note-pdf-canvas";
    renderCanvas.style.width = `${viewport.width}px`;
    renderCanvas.style.height = `${viewport.height}px`;
    const preferredRatio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
    const memoryRatio = Math.sqrt(
      8_000_000 / Math.max(viewport.width * viewport.height, 1)
    );
    const ratio = Math.max(0.5, Math.min(preferredRatio, memoryRatio));
    renderCanvas.width = Math.max(1, Math.round(viewport.width * ratio));
    renderCanvas.height = Math.max(1, Math.round(viewport.height * ratio));

    const renderContext = renderCanvas.getContext("2d");
    if (renderContext) {
      renderContext.setTransform(ratio, 0, 0, ratio, 0, 0);
      try {
        await page.render({
          canvasContext: renderContext,
          viewport
        }).promise;
      } catch (error) {
        if (generation === this.pageRenderGeneration) {
          console.error(`Hand Note Layers: failed to render PDF page ${pageIndex}`, error);
        }
        return;
      }
    }

    if (
      generation !== this.pageRenderGeneration ||
      this.pageElements.get(pageIndex) !== pageEl
    ) {
      return;
    }
    pageEl.empty();
    pageEl.append(renderCanvas);

    const inkCanvas = new InkCanvas({
      getDocument: () => this.document as AnnotationDocument,
      getTool: () => this.currentTool,
      getColor: () => this.currentColor,
      getSize: () => this.toolSizes[this.currentTool],
      getEraserSize: () => this.toolSizes.eraser,
      getPressureEnabled: () => this.pressureEnabled,
      getFingerDrawingEnabled: () => this.fingerDrawingEnabled,
      onDocumentChange: (next, renderCanvas) =>
        this.handleDocumentChange(next, renderCanvas),
      onInteraction: (type) => {
        if (type === "stroke-start") {
          this.cancelScheduledSave();
        }
      },
      onPencilShortcut: () => this.togglePenAndEraser(),
      pageIndex
    });
    const history = this.pageHistories.get(pageIndex);
    if (history) {
      inkCanvas.restoreHistoryState(history);
    }
    this.inkCanvases.set(pageIndex, inkCanvas);
    pageEl.append(inkCanvas.canvas);
    inkCanvas.render();
  }

  private currentInkCanvas(): InkCanvas | null {
    return this.inkCanvases.get(this.currentPage) ?? null;
  }

  private goToPage(page: number): void {
    const pageCount = this.pdfDocument?.numPages ?? 1;
    const next = Math.max(1, Math.min(pageCount, page));

    const target = this.pageElements.get(next);
    this.updateCurrentPage(next);
    void this.renderPageWindow(next);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  private zoom(delta: number): void {
    this.pageScale = Math.max(0.5, Math.min(2.5, this.pageScale + delta));
    if (this.pdfDocument) {
      void this.buildPagePlaceholders().then(() => {
        this.pageElements.get(this.currentPage)?.scrollIntoView({ block: "start" });
      });
    }
  }

  private async renderPageWindow(pageIndex: number): Promise<void> {
    const pageCount = this.pdfDocument?.numPages ?? 0;
    const pages = [pageIndex, pageIndex - 1, pageIndex + 1].filter(
      (page) => page >= 1 && page <= pageCount
    );
    await Promise.all(pages.map((page) => this.renderPage(page)));
  }

  private observePageVisibility(): void {
    if (typeof IntersectionObserver === "undefined") {
      return;
    }

    this.pageObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageIndex = Number((entry.target as HTMLElement).dataset.page);
          if (!Number.isFinite(pageIndex)) {
            continue;
          }
          if (entry.isIntersecting) {
            this.nearbyPages.add(pageIndex);
            const unloadTimer = this.pageUnloadTimers.get(pageIndex);
            if (unloadTimer !== undefined) {
              window.clearTimeout(unloadTimer);
              this.pageUnloadTimers.delete(pageIndex);
            }
            void this.renderPage(pageIndex);
          } else {
            this.nearbyPages.delete(pageIndex);
            this.schedulePageUnload(pageIndex);
          }
        }
      },
      {
        root: this.scrollContainer,
        rootMargin: "100% 0px",
        threshold: 0
      }
    );

    for (const pageEl of this.pageElements.values()) {
      this.pageObserver.observe(pageEl);
    }
  }

  private schedulePageUnload(pageIndex: number): void {
    if (!this.inkCanvases.has(pageIndex) || this.pageUnloadTimers.has(pageIndex)) {
      return;
    }
    const timer = window.setTimeout(() => {
      this.pageUnloadTimers.delete(pageIndex);
      if (this.nearbyPages.has(pageIndex) || pageIndex === this.currentPage) {
        return;
      }
      if (this.pageRenderPromises.has(pageIndex)) {
        this.schedulePageUnload(pageIndex);
        return;
      }
      const inkCanvas = this.inkCanvases.get(pageIndex);
      if (inkCanvas) {
        this.pageHistories.set(pageIndex, inkCanvas.getHistoryState());
        inkCanvas.destroy();
      }
      this.inkCanvases.delete(pageIndex);
      this.pageElements.get(pageIndex)?.empty();
    }, 1200);
    this.pageUnloadTimers.set(pageIndex, timer);
  }

  private handlePdfScroll = (): void => {
    if (this.scrollFrame !== null) {
      return;
    }
    this.scrollFrame = window.requestAnimationFrame(() => {
      this.scrollFrame = null;
      const containerRect = this.scrollContainer.getBoundingClientRect();
      const center = containerRect.top + containerRect.height / 2;
      let closestPage = this.currentPage;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const [pageIndex, pageEl] of this.pageElements) {
        const rect = pageEl.getBoundingClientRect();
        const distance = Math.abs(rect.top + rect.height / 2 - center);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestPage = pageIndex;
        }
      }
      if (closestPage !== this.currentPage) {
        this.updateCurrentPage(closestPage);
        void this.renderPageWindow(closestPage);
      }
    });
  };

  private updateCurrentPage(pageIndex: number): void {
    this.currentPage = pageIndex;
    const pageInput = this.toolbar.querySelector(
      ".hand-note-page-input"
    ) as HTMLInputElement | null;
    if (pageInput) {
      pageInput.value = String(pageIndex);
    }
  }

  private preserveInkCanvasHistories(): void {
    for (const [pageIndex, inkCanvas] of this.inkCanvases) {
      this.pageHistories.set(pageIndex, inkCanvas.getHistoryState());
      inkCanvas.destroy();
    }
  }

  private setTool(tool: AnnotationTool): void {
    if (tool !== "hand" && tool !== "eraser") {
      this.previousDrawingTool = tool;
    }
    this.currentTool = tool;
    this.annotationToolbar?.setTool(tool);
    for (const canvas of this.inkCanvases.values()) {
      canvas.updateInputMode();
    }
  }

  private setColor(color: string): void {
    this.currentColor = color;
    this.annotationToolbar?.setColor(color);
  }

  private setFingerDrawingEnabled(enabled: boolean): void {
    this.fingerDrawingEnabled = enabled;
    this.annotationToolbar?.setFingerDrawingEnabled(enabled);
    for (const canvas of this.inkCanvases.values()) {
      canvas.updateInputMode();
    }
  }

  togglePenAndEraser(): void {
    if (!this.pencilShortcutEnabled) {
      return;
    }
    this.setTool(
      this.currentTool === "eraser" ? this.previousDrawingTool : "eraser"
    );
  }

  private handleDocumentChange(
    document: AnnotationDocument,
    renderCanvases = true
  ): void {
    this.document = document;
    this.layerPanel?.setDocument(document);
    if (renderCanvases) {
      for (const inkCanvas of this.inkCanvases.values()) {
        inkCanvas.render();
      }
    }
    this.scheduleSave();
  }

  private scheduleSave(): void {
    this.cancelScheduledSave();
    this.annotationToolbar?.setSaveStatus("saving");
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flushSave();
    }, 350);
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
      console.error("Hand Note Layers: failed to save PDF annotation", error);
      this.annotationToolbar?.setSaveStatus("error");
    }
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
