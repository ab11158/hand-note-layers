import { setIcon } from "obsidian";
import {
  AnnotationDocument,
  AnnotationTool,
  EraserMode,
  createEmptyDocument
} from "../model/annotation";
import { InkCanvas, InkCanvasViewport } from "./ink-canvas";

export interface WhiteboardBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TemporaryWhiteboardOptions {
  host: HTMLElement;
  initialBounds: WhiteboardBounds;
  getTool: () => AnnotationTool;
  getColor: () => string;
  getSize: () => number;
  getEraserSize: () => number;
  getEraserMode: () => EraserMode;
  getPressureEnabled: () => boolean;
  onActivate: () => void;
  onDelete: () => void;
  onPencilShortcut?: () => void;
}

type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export class TemporaryWhiteboard {
  readonly element: HTMLDivElement;
  readonly inkCanvas: InkCanvas;
  private readonly options: TemporaryWhiteboardOptions;
  private readonly content: HTMLDivElement;
  private readonly innerSurface: HTMLDivElement;
  private document: AnnotationDocument;
  private bounds: WhiteboardBounds;
  private virtualWidth: number;
  private virtualHeight: number;
  private panX: number;
  private panY: number;
  private viewportFrame: number | null = null;
  private manipulation:
    | {
        pointerId: number;
        startX: number;
        startY: number;
        startBounds: WhiteboardBounds;
        handle: ResizeHandle | "move";
      }
    | null = null;

  constructor(options: TemporaryWhiteboardOptions) {
    this.options = options;
    this.bounds = this.clampBounds(options.initialBounds);
    this.virtualWidth = Math.max(1600, Math.round(this.bounds.width * 3));
    this.virtualHeight = Math.max(2200, Math.round(this.bounds.height * 3));
    this.panX = Math.max(0, (this.virtualWidth - this.bounds.width) / 2);
    this.panY = Math.max(0, (this.virtualHeight - this.bounds.height) / 2);
    this.document = createEmptyDocument("temporary-whiteboard");

    this.element = document.createElement("div");
    this.element.className = "hand-note-whiteboard is-editing";

    this.content = document.createElement("div");
    this.content.className = "hand-note-whiteboard-content";
    this.innerSurface = document.createElement("div");
    this.innerSurface.className = "hand-note-whiteboard-surface";
    this.innerSurface.style.width = `${this.virtualWidth}px`;
    this.innerSurface.style.height = `${this.virtualHeight}px`;
    this.content.append(this.innerSurface);
    this.element.append(this.content, this.createControls());
    this.createHandles();
    options.host.append(this.element);

    this.inkCanvas = new InkCanvas({
      getDocument: () => this.document,
      getTool: options.getTool,
      getColor: options.getColor,
      getSize: options.getSize,
      getEraserSize: options.getEraserSize,
      getEraserMode: options.getEraserMode,
      getPressureEnabled: options.getPressureEnabled,
      onDocumentChange: (next) => {
        this.document = next;
      },
      onActivate: options.onActivate,
      onFingerPan: (deltaX, deltaY) => {
        options.onActivate();
        this.panBy(deltaX, deltaY);
      },
      onPencilShortcut: options.onPencilShortcut
    });
    this.innerSurface.append(
      this.inkCanvas.canvas,
      this.inkCanvas.selectionOutline,
      this.inkCanvas.selectionMenu
    );
    this.applyBounds();
    this.updateViewport();
  }

  destroy(): void {
    this.inkCanvas.destroy();
    if (this.viewportFrame !== null) {
      window.cancelAnimationFrame(this.viewportFrame);
    }
    window.removeEventListener("pointermove", this.handleManipulationMove);
    window.removeEventListener("pointerup", this.handleManipulationEnd);
    window.removeEventListener("pointercancel", this.handleManipulationEnd);
    this.element.remove();
  }

  setEditing(editing: boolean): void {
    this.element.classList.toggle("is-editing", editing);
    if (editing) {
      this.options.onActivate();
    }
  }

  isEditing(): boolean {
    return this.element.classList.contains("is-editing");
  }

  updateInputMode(): void {
    this.inkCanvas.updateInputMode();
  }

  resetPan(): void {
    this.panX = Math.max(0, (this.virtualWidth - this.bounds.width) / 2);
    this.panY = Math.max(0, (this.virtualHeight - this.bounds.height) / 2);
    this.scheduleViewportUpdate();
  }

  private createControls(): HTMLDivElement {
    const controls = document.createElement("div");
    controls.className = "hand-note-whiteboard-controls";

    const moveButton = this.createControlButton("grip-horizontal", "移动临时白板");
    moveButton.classList.add("hand-note-whiteboard-move");
    moveButton.addEventListener("pointerdown", (event) =>
      this.beginManipulation(event, "move")
    );
    const resetButton = this.createControlButton("locate-fixed", "回到白板中心");
    resetButton.addEventListener("click", () => this.resetPan());
    const deleteButton = this.createControlButton("trash-2", "删除临时白板");
    deleteButton.addEventListener("click", this.options.onDelete);
    controls.append(moveButton, resetButton, deleteButton);
    return controls;
  }

  private createControlButton(icon: string, label: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "clickable-icon hand-note-tool";
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    setIcon(button, icon);
    return button;
  }

  private createHandles(): void {
    const handles: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
    for (const handle of handles) {
      const element = document.createElement("button");
      element.type = "button";
      element.className = `hand-note-whiteboard-handle is-${handle}`;
      element.setAttribute("aria-label", `调整白板 ${handle}`);
      element.addEventListener("pointerdown", (event) =>
        this.beginManipulation(event, handle)
      );
      this.element.append(element);
    }
  }

  private beginManipulation(
    event: PointerEvent,
    handle: ResizeHandle | "move"
  ): void {
    event.preventDefault();
    event.stopPropagation();
    this.options.onActivate();
    this.manipulation = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startBounds: { ...this.bounds },
      handle
    };
    window.addEventListener("pointermove", this.handleManipulationMove, {
      passive: false
    });
    window.addEventListener("pointerup", this.handleManipulationEnd);
    window.addEventListener("pointercancel", this.handleManipulationEnd);
  }

  private handleManipulationMove = (event: PointerEvent): void => {
    const state = this.manipulation;
    if (!state || state.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    const next = { ...state.startBounds };
    if (state.handle === "move") {
      next.left += dx;
      next.top += dy;
    } else {
      if (state.handle.includes("w")) {
        next.left += dx;
        next.width -= dx;
      }
      if (state.handle.includes("e")) {
        next.width += dx;
      }
      if (state.handle.includes("n")) {
        next.top += dy;
        next.height -= dy;
      }
      if (state.handle.includes("s")) {
        next.height += dy;
      }
    }
    this.bounds = this.clampBounds(next);
    this.applyBounds();
  };

  private handleManipulationEnd = (event: PointerEvent): void => {
    if (!this.manipulation || this.manipulation.pointerId !== event.pointerId) {
      return;
    }
    this.manipulation = null;
    window.removeEventListener("pointermove", this.handleManipulationMove);
    window.removeEventListener("pointerup", this.handleManipulationEnd);
    window.removeEventListener("pointercancel", this.handleManipulationEnd);
    this.scheduleViewportUpdate();
  };

  private panBy(deltaX: number, deltaY: number): void {
    const visibleWidth = Math.max(1, this.content.clientWidth || this.bounds.width);
    const visibleHeight = Math.max(1, this.content.clientHeight || this.bounds.height);
    this.panX = Math.max(
      0,
      Math.min(this.virtualWidth - visibleWidth, this.panX + deltaX)
    );
    this.panY = Math.max(
      0,
      Math.min(this.virtualHeight - visibleHeight, this.panY + deltaY)
    );
    this.scheduleViewportUpdate();
  }

  private scheduleViewportUpdate(): void {
    if (this.viewportFrame !== null) {
      return;
    }
    this.viewportFrame = window.requestAnimationFrame(() => {
      this.viewportFrame = null;
      this.updateViewport();
    });
  }

  private updateViewport(): void {
    const width = Math.max(1, this.content.clientWidth || this.bounds.width);
    const height = Math.max(1, this.content.clientHeight || this.bounds.height);
    this.panX = Math.max(0, Math.min(this.virtualWidth - width, this.panX));
    this.panY = Math.max(0, Math.min(this.virtualHeight - height, this.panY));
    this.innerSurface.style.transform = `translate(${-this.panX}px, ${-this.panY}px)`;
    const viewport: InkCanvasViewport = {
      documentWidth: this.virtualWidth,
      documentHeight: this.virtualHeight,
      offsetX: this.panX,
      offsetY: this.panY,
      width,
      height
    };
    this.inkCanvas.setViewport(viewport);
  }

  private applyBounds(): void {
    this.element.style.left = `${this.bounds.left}px`;
    this.element.style.top = `${this.bounds.top}px`;
    this.element.style.width = `${this.bounds.width}px`;
    this.element.style.height = `${this.bounds.height}px`;
  }

  private clampBounds(bounds: WhiteboardBounds): WhiteboardBounds {
    const hostWidth = Math.max(320, this.options.host.clientWidth);
    const hostHeight = Math.max(240, this.options.host.scrollHeight);
    const minWidth = Math.min(240, hostWidth);
    const minHeight = Math.min(180, hostHeight);
    const width = Math.max(minWidth, Math.min(hostWidth, bounds.width));
    const height = Math.max(minHeight, Math.min(hostHeight, bounds.height));
    return {
      left: Math.max(0, Math.min(hostWidth - width, bounds.left)),
      top: Math.max(0, Math.min(hostHeight - height, bounds.top)),
      width,
      height
    };
  }
}
