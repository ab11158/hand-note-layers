import { createIconButton } from "./ui";
import { AnnotationDocument, AnnotationLayer } from "../model/annotation";

export interface LayerPanelCallbacks {
  onAddLayer: () => void;
  onDeleteLayer: (layerId: string) => void;
  onSelectLayer: (layerId: string) => void;
  onRenameLayer: (layerId: string, name: string) => void;
  onToggleVisibility: (layerId: string) => void;
  onOpacityChange: (layerId: string, opacity: number) => void;
  onMoveLayer: (layerId: string, direction: -1 | 1) => void;
  onClose: () => void;
}

export class LayerPanel {
  readonly element: HTMLDivElement;
  private list: HTMLDivElement;
  private callbacks: LayerPanelCallbacks;
  private annotationDocument: AnnotationDocument;

  constructor(annotationDocument: AnnotationDocument, callbacks: LayerPanelCallbacks) {
    this.annotationDocument = annotationDocument;
    this.callbacks = callbacks;

    this.element = document.createElement("div");
    this.element.className = "hand-note-layer-panel";

    const header = document.createElement("div");
    header.className = "hand-note-layer-header";

    const title = document.createElement("div");
    title.className = "hand-note-layer-title";
    title.textContent = "笔记层";

    const addButton = createIconButton("plus", "新增笔记层");
    addButton.addEventListener("click", () => callbacks.onAddLayer());
    const closeButton = createIconButton("x", "关闭层面板");
    closeButton.addEventListener("click", () => callbacks.onClose());

    header.append(title, addButton, closeButton);
    this.list = document.createElement("div");
    this.list.className = "hand-note-layer-list";

    this.element.append(header, this.list);
    this.render();
  }

  setDocument(document: AnnotationDocument): void {
    this.annotationDocument = document;
    this.render();
  }

  private render(): void {
    this.list.empty();

    for (let index = this.annotationDocument.layers.length - 1; index >= 0; index -= 1) {
      const layer = this.annotationDocument.layers[index];
      this.list.append(this.createLayerRow(layer, index));
    }
  }

  private createLayerRow(layer: AnnotationLayer, index: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "hand-note-layer-row";
    row.classList.toggle("is-active", layer.id === this.annotationDocument.activeLayerId);
    row.classList.toggle("is-hidden", !layer.visible);

    const visibilityButton = createIconButton(layer.visible ? "eye" : "eye-off", layer.visible ? "隐藏图层" : "显示图层");
    visibilityButton.classList.toggle("is-active", layer.visible);
    visibilityButton.addEventListener("click", () => this.callbacks.onToggleVisibility(layer.id));

    const content = document.createElement("div");
    content.className = "hand-note-layer-content";

    const name = document.createElement("span");
    name.className = "hand-note-layer-name";
    name.textContent = layer.name;
    name.title = "双击重命名";
    let clickTimer: number | null = null;
    let longPressTimer: number | null = null;
    let longPressStart: { x: number; y: number } | null = null;
    const startRename = (event?: Event) => {
      event?.preventDefault();
      event?.stopPropagation();
      if (clickTimer !== null) {
        window.clearTimeout(clickTimer);
        clickTimer = null;
      }
      const input = document.createElement("input");
      input.type = "text";
      input.value = layer.name;
      input.className = "hand-note-layer-rename";
      name.replaceWith(input);
      input.focus();
      input.select();

      let finished = false;
      const commit = () => {
        if (finished) {
          return;
        }
        finished = true;
        const nextName = input.value.trim() || layer.name;
        this.callbacks.onRenameLayer(layer.id, nextName);
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          commit();
        } else if (event.key === "Escape") {
          finished = true;
          input.replaceWith(name);
        }
      });
    };
    name.addEventListener("click", (event) => {
      event.stopPropagation();
      if (clickTimer !== null) {
        window.clearTimeout(clickTimer);
      }
      clickTimer = window.setTimeout(() => {
        clickTimer = null;
        this.callbacks.onSelectLayer(layer.id);
      }, 220);
    });
    name.addEventListener("dblclick", startRename);
    name.addEventListener("contextmenu", startRename);
    name.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch") {
        return;
      }
      longPressStart = { x: event.clientX, y: event.clientY };
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
        longPressStart = null;
        startRename(event);
      }, 520);
    });
    const cancelLongPress = () => {
      if (longPressTimer !== null) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      longPressStart = null;
    };
    name.addEventListener("pointerup", cancelLongPress);
    name.addEventListener("pointercancel", cancelLongPress);
    name.addEventListener("pointermove", (event) => {
      if (
        longPressStart &&
        Math.hypot(event.clientX - longPressStart.x, event.clientY - longPressStart.y) > 10
      ) {
        cancelLongPress();
      }
    });

    const opacity = document.createElement("input");
    opacity.type = "range";
    opacity.min = "0";
    opacity.max = "1";
    opacity.step = "0.05";
    opacity.value = String(layer.opacity);
    opacity.setAttribute("aria-label", "图层透明度");
    opacity.className = "hand-note-layer-opacity";
    opacity.addEventListener("input", () => this.callbacks.onOpacityChange(layer.id, Number(opacity.value)));

    const moveUp = createIconButton("chevron-up", "上移图层");
    moveUp.disabled = index === this.annotationDocument.layers.length - 1;
    moveUp.addEventListener("click", () => this.callbacks.onMoveLayer(layer.id, 1));

    const moveDown = createIconButton("chevron-down", "下移图层");
    moveDown.disabled = index === 0;
    moveDown.addEventListener("click", () => this.callbacks.onMoveLayer(layer.id, -1));

    const deleteButton = createIconButton("trash", "删除图层");
    deleteButton.disabled = this.annotationDocument.layers.length <= 1;
    deleteButton.addEventListener("click", () => this.callbacks.onDeleteLayer(layer.id));

    const editButton = createIconButton("pen", "设为当前编辑图层");
    editButton.classList.toggle(
      "is-active",
      layer.id === this.annotationDocument.activeLayerId
    );
    editButton.addEventListener("click", () => this.callbacks.onSelectLayer(layer.id));

    content.append(name, opacity);
    row.append(visibilityButton, content, editButton, moveUp, moveDown, deleteButton);
    return row;
  }
}
