import { Notice, Plugin, TFile } from "obsidian";
import {
  AnnotationExportResult,
  exportAnnotatedPdf,
  exportLayerPackage,
  exportVaultAnnotatedPdfs,
  exportVaultLayerPackages
} from "./export/annotation-export";
import { deleteAnnotation, loadAnnotation } from "./storage/annotation-store";
import {
  MARKDOWN_ANNOTATION_VIEW_TYPE,
  MarkdownAnnotationView
} from "./view/markdown-annotation-view";
import {
  PDF_ANNOTATION_VIEW_TYPE,
  PdfAnnotationView
} from "./view/pdf-annotation-view";

export default class HandNoteLayersPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(
      MARKDOWN_ANNOTATION_VIEW_TYPE,
      (leaf) => new MarkdownAnnotationView(leaf)
    );
    this.registerView(
      PDF_ANNOTATION_VIEW_TYPE,
      (leaf) => new PdfAnnotationView(leaf)
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && this.isSupported(file)) {
          void deleteAnnotation(this.app, file);
        }
      })
    );

    this.addRibbonIcon("pen-tool", "用 HandLayers 标注当前文件", () => {
      const file = this.app.workspace.getActiveFile();
      if (file) {
        this.openAnnotation(file);
      }
    });

    this.addCommand({
      id: "annotate-current-file",
      name: "标注当前文件",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.isSupported(file)) {
          return false;
        }
        if (!checking) {
          this.openAnnotation(file);
        }
        return true;
      }
    });

    this.addCommand({
      id: "annotate-current-markdown",
      name: "标注当前 Markdown",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") {
          return false;
        }
        if (!checking) {
          this.openAnnotation(file);
        }
        return true;
      }
    });

    this.addCommand({
      id: "toggle-pen-eraser",
      name: "切换绘图工具与橡皮擦",
      checkCallback: (checking) => {
        const view = this.getActiveAnnotationView();
        if (!view) {
          return false;
        }
        if (!checking) {
          view.togglePenAndEraser();
        }
        return true;
      }
    });

    this.addCommand({
      id: "export-current-pdf",
      name: "导出当前 PDF（合并可见批注）",
      checkCallback: (checking) => {
        const view = this.getActiveAnnotationView();
        const file = this.app.workspace.getActiveFile();
        const available = view instanceof PdfAnnotationView || (!view && file?.extension === "pdf");
        if (available && !checking) {
          void this.exportCurrentPdf();
        }
        return available;
      }
    });

    this.addCommand({
      id: "export-current-layers",
      name: "导出当前笔记所有图层 ZIP",
      checkCallback: (checking) => {
        const view = this.getActiveAnnotationView();
        const file = this.app.workspace.getActiveFile();
        const available = Boolean(view || (file && this.isSupported(file)));
        if (available && !checking) {
          void this.exportCurrentLayers();
        }
        return available;
      }
    });

    this.addCommand({
      id: "export-vault-pdfs",
      name: "导出整个仓库的批注 PDF",
      callback: () => void this.exportVaultPdfs()
    });

    this.addCommand({
      id: "export-vault-layers",
      name: "导出整个仓库的所有图层 ZIP",
      callback: () => void this.exportVaultLayers()
    });

    const handlePencilDoubleTap = () => {
      this.getActiveAnnotationView()?.togglePenAndEraser();
    };
    window.addEventListener("hand-note-pencil-double-tap", handlePencilDoubleTap);
    this.register(() => {
      window.removeEventListener("hand-note-pencil-double-tap", handlePencilDoubleTap);
    });
  }

  private isSupported(file: TFile): boolean {
    return file.extension === "md" || file.extension === "pdf";
  }

  private getActiveAnnotationView(): MarkdownAnnotationView | PdfAnnotationView | null {
    return (
      this.app.workspace.getActiveViewOfType(MarkdownAnnotationView) ??
      this.app.workspace.getActiveViewOfType(PdfAnnotationView)
    );
  }

  private async exportCurrentPdf(): Promise<void> {
    try {
      const view = this.getActiveAnnotationView();
      if (view instanceof PdfAnnotationView) {
        await view.exportDocument("document");
        return;
      }
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== "pdf") {
        new Notice("当前笔记不是 PDF");
        return;
      }
      const result = await exportAnnotatedPdf(this.app, file, await loadAnnotation(this.app, file));
      new Notice(`PDF 已导出到 ${result.path}`, 8000);
    } catch (error) {
      console.error("HandLayers: failed to export current PDF", error);
      new Notice("当前 PDF 导出失败，请查看开发者控制台");
    }
  }

  private async exportCurrentLayers(): Promise<void> {
    try {
      const view = this.getActiveAnnotationView();
      if (view) {
        await view.exportDocument("layers");
        return;
      }
      const file = this.app.workspace.getActiveFile();
      if (!file || !this.isSupported(file)) {
        new Notice("没有可导出的笔记");
        return;
      }
      const result = await exportLayerPackage(this.app, file, await loadAnnotation(this.app, file));
      new Notice(`所有图层已导出到 ${result.path}`, 8000);
    } catch (error) {
      console.error("HandLayers: failed to export current layers", error);
      new Notice("当前笔记图层导出失败，请查看开发者控制台");
    }
  }

  private async exportVaultPdfs(): Promise<void> {
    try {
      await this.prepareOpenViews();
      this.showExportResult(await exportVaultAnnotatedPdfs(this.app));
    } catch (error) {
      console.error("HandLayers: failed to export vault PDFs", error);
      new Notice("整个仓库 PDF 导出失败，请查看开发者控制台");
    }
  }

  private async exportVaultLayers(): Promise<void> {
    try {
      await this.prepareOpenViews();
      this.showExportResult(await exportVaultLayerPackages(this.app));
    } catch (error) {
      console.error("HandLayers: failed to export vault layers", error);
      new Notice("整个仓库图层导出失败，请查看开发者控制台");
    }
  }

  private async prepareOpenViews(): Promise<void> {
    const views = [
      ...this.app.workspace.getLeavesOfType(MARKDOWN_ANNOTATION_VIEW_TYPE),
      ...this.app.workspace.getLeavesOfType(PDF_ANNOTATION_VIEW_TYPE)
    ]
      .map((leaf) => leaf.view)
      .filter(
        (view): view is MarkdownAnnotationView | PdfAnnotationView =>
          view instanceof MarkdownAnnotationView || view instanceof PdfAnnotationView
      );
    await Promise.all(views.map((view) => view.prepareExport()));
  }

  private showExportResult(result: AnnotationExportResult): void {
    const drafts = result.excludedDraftWhiteboards
      ? `，已排除 ${result.excludedDraftWhiteboards} 个未保存白板`
      : "";
    new Notice(
      `已导出 ${result.exportedFiles} 个文件到 ${result.directory}${drafts}`,
      8000
    );
  }

  private openAnnotation(file: TFile): void {
    const viewType =
      file.extension === "pdf"
        ? PDF_ANNOTATION_VIEW_TYPE
        : MARKDOWN_ANNOTATION_VIEW_TYPE;

    void this.app.workspace.getLeaf(true).setViewState({
      type: viewType,
      active: true,
      state: { file: file.path }
    });
  }
}
