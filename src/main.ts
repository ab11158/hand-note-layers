import { Notice, Plugin, TFile } from "obsidian";
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
      id: "copy-input-diagnostics",
      name: "复制 Apple Pencil 输入诊断记录",
      checkCallback: (checking) => {
        const view = this.getActiveAnnotationView();
        if (!view) {
          return false;
        }
        if (!checking) {
          const diagnostics = JSON.stringify(
            {
              capturedAt: new Date().toISOString(),
              file: this.app.workspace.getActiveFile()?.path ?? null,
              records: view.getInputDiagnostics()
            },
            null,
            2
          );
          console.info("Hand Note Layers Apple Pencil diagnostics", diagnostics);
          if (!navigator.clipboard) {
            new Notice("诊断记录已输出到开发者控制台");
            return;
          }
          void navigator.clipboard
            .writeText(diagnostics)
            .then(() => new Notice("Apple Pencil 诊断记录已复制"))
            .catch(() => new Notice("诊断记录已输出到开发者控制台"));
        }
        return true;
      }
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
