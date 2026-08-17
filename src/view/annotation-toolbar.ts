import { setIcon } from "obsidian";
import { AnnotationTool, EraserMode, SelectionMode } from "../model/annotation";
import { createIconButton, createLabeledSlider, createToolbar } from "./ui";

export type AnnotationSaveStatus = "saved" | "saving" | "error";

export interface AnnotationToolbarOptions {
  initialTool: AnnotationTool;
  initialColor: string;
  initialPressureEnabled: boolean;
  initialPencilShortcutEnabled: boolean;
  initialEraserMode: EraserMode;
  initialSelectionMode: SelectionMode;
  getSize: (tool: AnnotationTool) => number;
  onToolChange: (tool: AnnotationTool) => void;
  onColorChange: (color: string) => void;
  onSizeChange: (tool: AnnotationTool, size: number) => void;
  onPressureChange: (enabled: boolean) => void;
  onPencilShortcutChange: (enabled: boolean) => void;
  onEraserModeChange: (mode: EraserMode) => void;
  onSelectionModeChange: (mode: SelectionMode) => void;
  onWhiteboard: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  onSave: () => void;
  onLayers: () => void;
  navigationControls?: HTMLElement[];
}

const TOOL_CONFIG: Array<{
  tool: AnnotationTool;
  icon: string;
  label: string;
}> = [
  { tool: "hand", icon: "hand", label: "浏览与移动页面" },
  { tool: "pen", icon: "pen-tool", label: "钢笔" },
  { tool: "pencil", icon: "pencil", label: "铅笔" },
  { tool: "highlighter", icon: "highlighter", label: "荧光笔" },
  { tool: "eraser", icon: "eraser", label: "橡皮擦" },
  { tool: "select", icon: "lasso-select", label: "套索选择" }
];

const FIXED_COLOR_PRESETS = ["#dc2626", "#2563eb", "#16a34a"];
const CUSTOM_COLOR_PRESETS = ["#1f2937", "#9333ea", "#f59e0b"];

export class AnnotationToolbar {
  readonly element: HTMLDivElement;
  private readonly options: AnnotationToolbarOptions;
  private readonly toolButtons = new Map<AnnotationTool, HTMLButtonElement>();
  private readonly colorButtons = new Map<string, HTMLButtonElement>();
  private readonly customColor: HTMLInputElement;
  private readonly sizeControl;
  private readonly pressureButton: HTMLButtonElement;
  private readonly pencilShortcutButton: HTMLButtonElement;
  private readonly eraserMenu: HTMLDivElement;
  private readonly eraserModeButtons = new Map<EraserMode, HTMLButtonElement>();
  private readonly selectionMenu: HTMLDivElement;
  private readonly selectionModeButtons = new Map<SelectionMode, HTMLButtonElement>();
  private readonly whiteboardButton: HTMLButtonElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly saveStatus: HTMLSpanElement;
  private currentTool: AnnotationTool;

  constructor(options: AnnotationToolbarOptions) {
    this.options = options;
    this.currentTool = options.initialTool;
    this.element = createToolbar();
    this.selectionMenu = document.createElement("div");
    this.selectionMenu.className = "hand-note-eraser-menu";
    this.selectionMenu.append(
      this.createSelectionModeButton("all", "全选", "scan"),
      this.createSelectionModeButton("rectangle", "框选", "box-select"),
      this.createSelectionModeButton("free", "自由套索", "lasso-select")
    );

    const toolGroup = this.createGroup();
    for (const config of TOOL_CONFIG) {
      const button = createIconButton(config.icon, config.label);
      button.addEventListener("click", () => {
        if (config.tool === "eraser" && this.currentTool === "eraser") {
          this.eraserMenu.classList.toggle("is-open");
          return;
        }
        if (config.tool === "select" && this.currentTool === "select") {
          this.selectionMenu.classList.toggle("is-open");
          return;
        }
        this.eraserMenu.classList.remove("is-open");
        options.onToolChange(config.tool);
      });
      this.toolButtons.set(config.tool, button);
      if (config.tool === "eraser") {
        const wrapper = document.createElement("div");
        wrapper.className = "hand-note-tool-menu-wrap";
        this.eraserMenu = document.createElement("div");
        this.eraserMenu.className = "hand-note-eraser-menu";
        this.eraserMenu.append(
          this.createEraserModeButton("partial", "局部擦除", "eraser"),
          this.createEraserModeButton("stroke", "整笔擦除", "delete")
        );
        wrapper.append(button, this.eraserMenu);
        toolGroup.append(wrapper);
      } else if (config.tool === "select") {
        const wrapper = document.createElement("div");
        wrapper.className = "hand-note-tool-menu-wrap";
        wrapper.append(button, this.selectionMenu);
        toolGroup.append(wrapper);
      } else {
        toolGroup.append(button);
      }
    }
    this.whiteboardButton = createIconButton("presentation", "临时白板");
    this.whiteboardButton.addEventListener("click", options.onWhiteboard);
    toolGroup.append(this.whiteboardButton);

    const historyGroup = this.createGroup();
    const undoButton = createIconButton("undo-2", "撤回上一步操作");
    undoButton.addEventListener("click", options.onUndo);
    const redoButton = createIconButton("redo-2", "重做");
    redoButton.addEventListener("click", options.onRedo);
    const clearButton = createIconButton("trash-2", "清除当前图层");
    clearButton.addEventListener("click", options.onClear);
    historyGroup.append(undoButton, redoButton, clearButton);

    const colorGroup = this.createGroup("hand-note-color-group");
    for (const color of FIXED_COLOR_PRESETS) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "hand-note-color-swatch";
      swatch.style.setProperty("--hand-note-swatch", color);
      swatch.setAttribute("aria-label", `颜色 ${color}`);
      swatch.addEventListener("click", () => options.onColorChange(color));
      this.colorButtons.set(color, swatch);
      colorGroup.append(swatch);
    }
    for (const color of CUSTOM_COLOR_PRESETS) {
      const swatch = document.createElement("input");
      swatch.type = "color";
      swatch.value = color;
      swatch.className = "hand-note-color-swatch is-custom";
      swatch.setAttribute("aria-label", "自定义预设颜色");
      swatch.addEventListener("input", () => options.onColorChange(swatch.value));
      colorGroup.append(swatch);
    }

    this.customColor = document.createElement("input");
    this.customColor.type = "color";
    this.customColor.value = options.initialColor;
    this.customColor.className = "hand-note-color";
    this.customColor.setAttribute("aria-label", "自定义笔迹颜色");
    this.customColor.addEventListener("input", () => {
      options.onColorChange(this.customColor.value);
    });
    colorGroup.append(this.customColor);

    this.sizeControl = createLabeledSlider(
      "粗细",
      1,
      24,
      1,
      options.getSize(options.initialTool),
      (value) => options.onSizeChange(this.currentTool, value)
    );

    const inputGroup = this.createGroup();
    this.pressureButton = createIconButton("gauge", "压感笔宽");
    this.pressureButton.addEventListener("click", () => {
      options.onPressureChange(!this.pressureButton.classList.contains("is-active"));
    });
    this.pencilShortcutButton = createIconButton(
      "repeat-2",
      "触控笔快捷键切换钢笔与橡皮擦"
    );
    this.pencilShortcutButton.addEventListener("click", () => {
      options.onPencilShortcutChange(
        !this.pencilShortcutButton.classList.contains("is-active")
      );
    });
    inputGroup.append(this.pressureButton, this.pencilShortcutButton);

    const documentGroup = this.createGroup();
    this.saveButton = createIconButton("save", "立即保存批注");
    this.saveButton.addEventListener("click", options.onSave);
    this.saveStatus = document.createElement("span");
    this.saveStatus.className = "hand-note-save-status";
    const layerButton = createIconButton("layers", "笔记图层");
    layerButton.addEventListener("click", options.onLayers);
    documentGroup.append(this.saveButton, this.saveStatus, layerButton);

    this.element.append(
      toolGroup,
      this.createDivider(),
      colorGroup,
      this.sizeControl.element,
      this.createDivider(),
      historyGroup
    );
    if (options.navigationControls?.length) {
      const navigationGroup = this.createGroup();
      navigationGroup.append(...options.navigationControls);
      this.element.append(this.createDivider(), navigationGroup);
    }
    this.element.append(
      this.createDivider(),
      inputGroup,
      this.createDivider(),
      documentGroup
    );

    this.setTool(options.initialTool);
    this.setColor(options.initialColor);
    this.setPressureEnabled(options.initialPressureEnabled);
    this.setPencilShortcutEnabled(options.initialPencilShortcutEnabled);
    this.setEraserMode(options.initialEraserMode);
    this.setSelectionMode(options.initialSelectionMode);
    this.setSaveStatus("saved");
  }

  setTool(tool: AnnotationTool): void {
    this.currentTool = tool;
    if (tool !== "eraser") {
      this.eraserMenu.classList.remove("is-open");
    }
    if (tool !== "select") {
      this.selectionMenu.classList.remove("is-open");
    }
    for (const [candidate, button] of this.toolButtons) {
      button.classList.toggle("is-active", candidate === tool);
      button.setAttribute("aria-pressed", String(candidate === tool));
    }

    const isHand = tool === "hand";
    const isSelection = tool === "select";
    const isEraser = tool === "eraser";
    const isHighlighter = tool === "highlighter";
    this.sizeControl.setDisabled(isHand || isSelection);
    this.sizeControl.setLabel(isEraser ? "橡皮" : "粗细");
    this.sizeControl.setRange(
      isEraser ? 8 : 1,
      isEraser ? 80 : isHighlighter ? 48 : 24,
      1
    );
    this.sizeControl.setValue(this.options.getSize(tool));
  }

  setColor(color: string): void {
    this.customColor.value = color;
    for (const [candidate, button] of this.colorButtons) {
      button.classList.toggle("is-active", candidate.toLowerCase() === color.toLowerCase());
    }
  }

  setPressureEnabled(enabled: boolean): void {
    this.setToggle(this.pressureButton, enabled);
  }

  setPencilShortcutEnabled(enabled: boolean): void {
    this.setToggle(this.pencilShortcutButton, enabled);
  }

  setEraserMode(mode: EraserMode): void {
    for (const [candidate, button] of this.eraserModeButtons) {
      button.classList.toggle("is-active", candidate === mode);
      button.setAttribute("aria-pressed", String(candidate === mode));
    }
    const eraserButton = this.toolButtons.get("eraser");
    eraserButton?.setAttribute(
      "aria-label",
      mode === "partial" ? "橡皮擦：局部擦除" : "橡皮擦：整笔擦除"
    );
  }

  setSelectionMode(mode: SelectionMode): void {
    for (const [candidate, button] of this.selectionModeButtons) {
      button.classList.toggle("is-active", candidate === mode);
      button.setAttribute("aria-pressed", String(candidate === mode));
    }
  }

  setWhiteboardActive(active: boolean): void {
    this.setToggle(this.whiteboardButton, active);
  }

  setSaveStatus(status: AnnotationSaveStatus): void {
    const labels: Record<AnnotationSaveStatus, string> = {
      saved: "已保存",
      saving: "保存中",
      error: "保存失败"
    };
    this.saveStatus.textContent = labels[status];
    this.saveStatus.dataset.status = status;
    setIcon(this.saveButton, status === "error" ? "circle-alert" : "save");
  }

  private createGroup(extraClass?: string): HTMLDivElement {
    const group = document.createElement("div");
    group.className = "hand-note-toolbar-group";
    if (extraClass) {
      group.classList.add(extraClass);
    }
    return group;
  }

  private createDivider(): HTMLSpanElement {
    const divider = document.createElement("span");
    divider.className = "hand-note-toolbar-divider";
    divider.setAttribute("aria-hidden", "true");
    return divider;
  }

  private createEraserModeButton(
    mode: EraserMode,
    label: string,
    icon: string
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hand-note-eraser-option";
    button.setAttribute("aria-label", label);
    setIcon(button, icon);
    const text = document.createElement("span");
    text.textContent = label;
    button.append(text);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.options.onEraserModeChange(mode);
      this.setEraserMode(mode);
      this.eraserMenu.classList.remove("is-open");
    });
    this.eraserModeButtons.set(mode, button);
    return button;
  }

  private createSelectionModeButton(
    mode: SelectionMode,
    label: string,
    icon: string
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hand-note-eraser-option";
    button.setAttribute("aria-label", label);
    setIcon(button, icon);
    const text = document.createElement("span");
    text.textContent = label;
    button.append(text);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.options.onSelectionModeChange(mode);
      this.setSelectionMode(mode);
      this.selectionMenu.classList.remove("is-open");
    });
    this.selectionModeButtons.set(mode, button);
    return button;
  }

  private setToggle(button: HTMLButtonElement, enabled: boolean): void {
    button.classList.toggle("is-active", enabled);
    button.setAttribute("aria-pressed", String(enabled));
  }
}
