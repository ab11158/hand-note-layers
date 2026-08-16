import { Plugin, TFile } from "obsidian";
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

    this.registerExtensions(["pdf"], PDF_ANNOTATION_VIEW_TYPE);

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
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(MARKDOWN_ANNOTATION_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(PDF_ANNOTATION_VIEW_TYPE);
  }

  private isSupported(file: TFile): boolean {
    return file.extension === "md" || file.extension === "pdf";
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
