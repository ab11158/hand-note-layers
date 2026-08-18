import { Notice, Plugin, TFile } from "obsidian";
import {
  AnnotationExportResult,
  exportCurrentAnnotation,
  exportVaultAnnotations
} from "./export/annotation-export";
import { deleteAnnotation } from "./storage/annotation-store";
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

    this.addRibbonIcon("pen-tool", "用 Hand Note Layers 标注当前文件", () => {
      const file = this.app.workspace.getActiveFile();
      if (file) {
        this.openAnnotation(file);
      }
    });

    this.addCommand({
      id: "annotate-current-file",
      name: "用 Hand Note Layers 标注当前文件",
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
      name: "用 Hand Note Layers 标注当前 Markdown",
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
      id: "export-current-annotation",
      name: "导出当前文件（保留 Hand Note Layers 图层）",
      checkCallback: (checking) => {
        const view = this.getActiveAnnotationView();
        const file = view ? null : this.app.workspace.getActiveFile();
        if (!view && (!file || !this.isSupported(file))) {
          return false;
        }
        if (!checking) {
          void this.exportCurrentFile(view, file);
        }
        return true;
      }
    });

    this.addCommand({
      id: "export-vault-annotations",
      name: "导出整个仓库的 Hand Note Layers 文件",
      callback: () => void this.exportWholeVault()
    });

    const handlePencilDoubleTap = () => {
      this.getActiveAnnotationView()?.togglePenAndEraser();
    };
    window.addEventListener("hand-note-pencil-double-tap", handlePencilDoubleTap);
    this.register(() => {
      window.removeEventListener("hand-note-pencil-double-tap", handlePencilDoubleTap);
    });
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(MARKDOWN_ANNOTATION_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(PDF_ANNOTATION_VIEW_TYPE);
  }

  private isSupported(file: TFile): boolean {
    return file.extension === "md" || file.extension === "pdf";
  }

  private getActiveAnnotationView(): MarkdownAnnotationView | PdfAnnotationView | null {
    const view = this.app.workspace.activeLeaf?.view;
    return view instanceof MarkdownAnnotationView || view instanceof PdfAnnotationView
      ? view
      : null;
  }

  private async exportCurrentFile(
    view: MarkdownAnnotationView | PdfAnnotationView | null,
    fallbackFile: TFile | null
  ): Promise<void> {
    try {
      const file = view ? await view.prepareExport() : fallbackFile;
      if (!file) {
        new Notice("没有可导出的文件");
        return;
      }
      this.showExportResult(await exportCurrentAnnotation(this.app, file));
    } catch (error) {
      console.error("Hand Note Layers: failed to export current file", error);
      new Notice("当前文件导出失败，请查看开发者控制台");
    }
  }

  private async exportWholeVault(): Promise<void> {
    try {
      const annotationViews = [
        ...this.app.workspace.getLeavesOfType(MARKDOWN_ANNOTATION_VIEW_TYPE),
        ...this.app.workspace.getLeavesOfType(PDF_ANNOTATION_VIEW_TYPE)
      ]
        .map((leaf) => leaf.view)
        .filter(
          (view): view is MarkdownAnnotationView | PdfAnnotationView =>
            view instanceof MarkdownAnnotationView || view instanceof PdfAnnotationView
        );
      await Promise.all(annotationViews.map((view) => view.prepareExport()));
      this.showExportResult(await exportVaultAnnotations(this.app));
    } catch (error) {
      console.error("Hand Note Layers: failed to export vault", error);
      new Notice("仓库导出失败，请查看开发者控制台");
    }
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

    this.app.workspace.getLeaf(true).setViewState({
      type: viewType,
      active: true,
      state: { file: file.path }
    });
  }
}
