import { setIcon } from "obsidian";
import {
  AnnotationTool,
  EraserMode,
  ShapeArrowHead,
  SelectionMode,
  ShapeKind,
  ShapeLineStyle
} from "../model/annotation";
import {
  createIconButton,
  createLabeledSlider,
  createToolbar,
  setControlTooltip
} from "./ui";

export type AnnotationSaveStatus = "saved" | "saving" | "error";

export interface AnnotationToolbarOptions {
  initialTool: AnnotationTool;
  initialColor: string;
  initialPressureEnabled: boolean;
  initialPencilShortcutEnabled: boolean;
  initialEraserMode: EraserMode;
  initialSelectionMode: SelectionMode;
  initialShapeKind: ShapeKind;
  initialShapeLineStyle: ShapeLineStyle;
  initialShapeStartArrow: ShapeArrowHead;
  initialShapeEndArrow: ShapeArrowHead;
  initialShapeFillEnabled: boolean;
  getSize: (tool: AnnotationTool) => number;
  onToolChange: (tool: AnnotationTool) => void;
  onColorChange: (color: string) => void;
  onSizeChange: (tool: AnnotationTool, size: number) => void;
  onPressureChange: (enabled: boolean) => void;
  onPencilShortcutChange: (enabled: boolean) => void;
  onEraserModeChange: (mode: EraserMode) => void;
  onSelectionModeChange: (mode: SelectionMode) => void;
  onShapeKindChange: (kind: ShapeKind) => void;
  onShapeLineStyleChange: (style: ShapeLineStyle) => void;
  onShapeArrowChange: (position: "start" | "end", arrow: ShapeArrowHead) => void;
  onShapeFillChange: (enabled: boolean) => void;
  onPaste: () => void;
  onWhiteboard: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  onSave: () => void;
  onExport?: (mode: "pdf" | "layers") => void;
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

const DEFAULT_COLOR_SLOTS = ["#dc2626", "#2563eb", "#16a34a", "#1f2937"];
const COLOR_PALETTE = [
  "#111827",
  "#64748b",
  "#dc2626",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0891b2",
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#ffffff",
  "#000000"
];
const COLOR_STORAGE_KEY = "hand-note-layers-color-slots";

export class AnnotationToolbar {
  readonly element: HTMLDivElement;
  private readonly options: AnnotationToolbarOptions;
  private readonly toolButtons = new Map<AnnotationTool, HTMLButtonElement>();
  private readonly colorButtons: HTMLButtonElement[] = [];
  private readonly colorSlots: string[];
  private readonly colorMenu: HTMLDivElement;
  private activeColorSlot = 0;
  private readonly sizeControl;
  private readonly sizeMenu: HTMLDivElement;
  private readonly sizeButton: HTMLButtonElement;
  private readonly pressureButton: HTMLButtonElement;
  private readonly pencilShortcutButton: HTMLButtonElement;
  private readonly eraserMenu: HTMLDivElement;
  private readonly eraserModeButtons = new Map<EraserMode, HTMLButtonElement>();
  private readonly selectionMenu: HTMLDivElement;
  private readonly selectionModeButtons = new Map<SelectionMode, HTMLButtonElement>();
  private readonly shapeMenu: HTMLDivElement;
  private readonly shapeKindButtons = new Map<ShapeKind, HTMLButtonElement>();
  private readonly shapeLineStyleButtons = new Map<ShapeLineStyle, HTMLButtonElement>();
  private readonly shapeStartArrowButton: HTMLButtonElement;
  private readonly shapeEndArrowButton: HTMLButtonElement;
  private readonly shapeFillButton: HTMLButtonElement;
  private readonly pasteButton: HTMLButtonElement;
  private currentShapeKind: ShapeKind;
  private currentShapeLineStyle: ShapeLineStyle;
  private currentShapeStartArrow: ShapeArrowHead;
  private currentShapeEndArrow: ShapeArrowHead;
  private shapeFillEnabled: boolean;
  private readonly whiteboardButton: HTMLButtonElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly saveStatus: HTMLSpanElement;
  private currentTool: AnnotationTool;

  constructor(options: AnnotationToolbarOptions) {
    this.options = options;
    this.currentTool = options.initialTool;
    this.currentShapeKind = options.initialShapeKind;
    this.currentShapeLineStyle = options.initialShapeLineStyle;
    this.currentShapeStartArrow = options.initialShapeStartArrow;
    this.currentShapeEndArrow = options.initialShapeEndArrow;
    this.shapeFillEnabled = options.initialShapeFillEnabled;
    this.element = createToolbar();
    this.colorSlots = this.loadColorSlots();
    const initialSlot = this.colorSlots.findIndex(
      (color) => color.toLowerCase() === options.initialColor.toLowerCase()
    );
    this.activeColorSlot = initialSlot >= 0 ? initialSlot : 0;
    this.colorMenu = document.createElement("div");
    this.colorMenu.className = "hand-note-eraser-menu hand-note-color-menu";
    this.selectionMenu = document.createElement("div");
    this.selectionMenu.className = "hand-note-eraser-menu";
    this.selectionMenu.append(
      this.createSelectionModeButton("all", "全选", "scan"),
      this.createSelectionModeButton("rectangle", "框选", "box-select"),
      this.createSelectionModeButton("free", "自由套索", "lasso-select")
    );
    this.shapeMenu = document.createElement("div");
    this.shapeMenu.className = "hand-note-eraser-menu hand-note-shape-menu";
    this.shapeStartArrowButton = this.createShapeArrowButton("start");
    this.shapeEndArrowButton = this.createShapeArrowButton("end");
    this.shapeFillButton = this.createShapeFillButton();
    this.shapeMenu.append(
      this.createShapeKindButton("line", "直线与折线", "minus"),
      this.createShapeKindButton("rectangle", "矩形", "square"),
      this.createShapeKindButton("ellipse", "椭圆", "circle"),
      this.createShapeKindButton("curve", "光滑曲线", "spline"),
      this.createShapeKindButton("connector-straight", "直线连接器", "move-right"),
      this.createShapeKindButton("connector-elbow", "直角连接器", "corner-down-right"),
      this.createShapeKindButton("connector-curve", "曲线连接器", "git-commit-horizontal"),
      this.createShapeLineStyleButton("solid", "实线", "minus"),
      this.createShapeLineStyleButton("dashed", "虚线", "ellipsis"),
      this.createShapeLineStyleButton("dotted", "点线", "more-horizontal"),
      this.shapeStartArrowButton,
      this.shapeEndArrowButton,
      this.shapeFillButton
    );

    const toolGroup = this.createGroup();
    for (const config of TOOL_CONFIG) {
      const button = createIconButton(config.icon, config.label);
      button.addEventListener("click", () => {
        if (config.tool === "eraser" && this.currentTool === "eraser") {
          this.toggleFloatingMenu(this.eraserMenu, button);
          return;
        }
        if (config.tool === "select" && this.currentTool === "select") {
          this.toggleFloatingMenu(this.selectionMenu, button);
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
    this.pasteButton = createIconButton("clipboard-paste", "粘贴到当前图层");
    this.pasteButton.addEventListener("click", options.onPaste);
    toolGroup.append(this.pasteButton);
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
    this.colorSlots.forEach((color, index) => {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "hand-note-color-swatch";
      swatch.style.setProperty("--hand-note-swatch", color);
      swatch.style.backgroundColor = color;
      setControlTooltip(swatch, `颜色位 ${index + 1}`);
      swatch.addEventListener("click", () => {
        this.activeColorSlot = index;
        options.onColorChange(this.colorSlots[index]);
        this.setColor(this.colorSlots[index]);
        this.toggleFloatingMenu(this.colorMenu, swatch);
      });
      this.colorButtons.push(swatch);
      colorGroup.append(swatch);
    });
    this.buildColorMenu();
    colorGroup.append(this.colorMenu);

    this.sizeControl = createLabeledSlider(
      "粗细",
      1,
      48,
      1,
      options.getSize(options.initialTool),
      (value) => options.onSizeChange(this.currentTool, value)
    );
    this.sizeButton = createIconButton("sliders-horizontal", "调整粗细或字号");
    this.sizeMenu = document.createElement("div");
    this.sizeMenu.className = "hand-note-eraser-menu hand-note-size-menu";
    this.sizeMenu.append(this.sizeControl.element);
    this.sizeButton.addEventListener("click", () =>
      this.toggleFloatingMenu(this.sizeMenu, this.sizeButton)
    );
    const sizeWrapper = document.createElement("div");
    sizeWrapper.className = "hand-note-tool-menu-wrap";
    sizeWrapper.append(this.sizeButton, this.sizeMenu);

    const objectGroup = this.createGroup();
    const textButton = createIconButton("type", "文本框");
    textButton.addEventListener("click", () => options.onToolChange("text"));
    this.toolButtons.set("text", textButton);
    const shapeButton = createIconButton("shapes", "图形");
    shapeButton.addEventListener("click", () => {
      if (this.currentTool === "shape") {
        this.toggleFloatingMenu(this.shapeMenu, shapeButton);
      } else {
        options.onToolChange("shape");
      }
    });
    this.toolButtons.set("shape", shapeButton);
    const shapeWrapper = document.createElement("div");
    shapeWrapper.className = "hand-note-tool-menu-wrap";
    shapeWrapper.append(shapeButton, this.shapeMenu);
    objectGroup.append(textButton, shapeWrapper);

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
    documentGroup.append(this.saveButton, this.saveStatus);
    if (options.onExport) {
      const exportButton = createIconButton("download", "导出");
      const exportMenu = document.createElement("div");
      exportMenu.className = "hand-note-eraser-menu hand-note-export-menu";
      exportMenu.append(
        this.createExportButton("file-down", "合成 PDF", () =>
          options.onExport?.("pdf")
        ),
        this.createExportButton("package", "导出图层包 ZIP", () =>
          options.onExport?.("layers")
        )
      );
      exportButton.addEventListener("click", () =>
        this.toggleFloatingMenu(exportMenu, exportButton)
      );
      const exportWrapper = document.createElement("div");
      exportWrapper.className = "hand-note-tool-menu-wrap";
      exportWrapper.append(exportButton, exportMenu);
      documentGroup.append(exportWrapper);
    }
    documentGroup.append(layerButton);

    this.element.append(
      toolGroup,
      this.createDivider(),
      colorGroup,
      sizeWrapper,
      this.createDivider(),
      objectGroup,
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
    this.setShapeKind(options.initialShapeKind);
    this.setShapeLineStyle(options.initialShapeLineStyle);
    this.setShapeArrow("start", options.initialShapeStartArrow);
    this.setShapeArrow("end", options.initialShapeEndArrow);
    this.setShapeFillEnabled(options.initialShapeFillEnabled);
    this.setPasteEnabled(false);
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
    if (tool !== "shape") {
      this.shapeMenu.classList.remove("is-open");
    }
    for (const [candidate, button] of this.toolButtons) {
      button.classList.toggle("is-active", candidate === tool);
      button.setAttribute("aria-pressed", String(candidate === tool));
    }

    const isHand = tool === "hand";
    const isSelection = tool === "select";
    const isEraser = tool === "eraser";
    const isHighlighter = tool === "highlighter";
    const isText = tool === "text";
    const isShape = tool === "shape";
    this.sizeControl.setDisabled(isHand || isSelection);
    this.sizeButton.disabled = isHand || isSelection;
    if (this.sizeButton.disabled) {
      this.sizeMenu.classList.remove("is-open");
    }
    this.sizeControl.setLabel(isEraser ? "橡皮" : isText ? "字号" : "粗细");
    this.sizeControl.setRange(
      isEraser ? 8 : isText ? 12 : 1,
      isEraser ? 80 : isText ? 72 : isHighlighter || isShape ? 48 : 48,
      1
    );
    this.sizeControl.setValue(this.options.getSize(tool));
  }

  setColor(color: string): void {
    const matchingSlot = this.colorSlots.findIndex(
      (candidate) => candidate.toLowerCase() === color.toLowerCase()
    );
    if (matchingSlot >= 0) {
      this.activeColorSlot = matchingSlot;
    }
    this.colorButtons.forEach((button, index) => {
      button.classList.toggle("is-active", index === this.activeColorSlot);
    });
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

  setShapeKind(kind: ShapeKind): void {
    this.currentShapeKind = kind;
    for (const [candidate, button] of this.shapeKindButtons) {
      button.classList.toggle("is-active", candidate === kind);
      button.setAttribute("aria-pressed", String(candidate === kind));
    }
    const shapeButton = this.toolButtons.get("shape");
    if (shapeButton) {
      setIcon(shapeButton, this.shapeKindIcon(kind));
      setControlTooltip(shapeButton, `图形：${this.shapeKindLabel(kind)}`);
    }
  }

  setShapeLineStyle(style: ShapeLineStyle): void {
    this.currentShapeLineStyle = style;
    for (const [candidate, button] of this.shapeLineStyleButtons) {
      button.classList.toggle("is-active", candidate === style);
      button.setAttribute("aria-pressed", String(candidate === style));
    }
  }

  setShapeArrow(position: "start" | "end", arrow: ShapeArrowHead): void {
    if (position === "start") {
      this.currentShapeStartArrow = arrow;
    } else {
      this.currentShapeEndArrow = arrow;
    }
    const button = position === "start"
      ? this.shapeStartArrowButton
      : this.shapeEndArrowButton;
    setIcon(button, this.shapeArrowIcon(position, arrow));
    setControlTooltip(
      button,
      `${position === "start" ? "起点" : "终点"}端点：${this.shapeArrowLabel(arrow)}`
    );
  }

  setShapeFillEnabled(enabled: boolean): void {
    this.shapeFillEnabled = enabled;
    this.shapeFillButton.classList.toggle("is-active", enabled);
    this.shapeFillButton.setAttribute("aria-pressed", String(enabled));
    setControlTooltip(this.shapeFillButton, enabled ? "关闭图形填充" : "启用图形填充");
  }

  setPasteEnabled(enabled: boolean): void {
    this.pasteButton.disabled = !enabled;
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
    setIcon(button, icon);
    setControlTooltip(button, label);
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
    setIcon(button, icon);
    setControlTooltip(button, label);
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

  private createShapeKindButton(
    kind: ShapeKind,
    label: string,
    icon: string
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hand-note-eraser-option";
    setIcon(button, icon);
    setControlTooltip(button, label);
    const text = document.createElement("span");
    text.textContent = label;
    button.append(text);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.options.onShapeKindChange(kind);
      this.setShapeKind(kind);
      this.options.onToolChange("shape");
      this.shapeMenu.classList.remove("is-open");
    });
    this.shapeKindButtons.set(kind, button);
    return button;
  }

  private createShapeLineStyleButton(
    style: ShapeLineStyle,
    label: string,
    icon: string
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hand-note-eraser-option";
    setIcon(button, icon);
    setControlTooltip(button, label);
    const text = document.createElement("span");
    text.textContent = label;
    button.append(text);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.options.onShapeLineStyleChange(style);
      this.setShapeLineStyle(style);
    });
    this.shapeLineStyleButtons.set(style, button);
    return button;
  }

  private createShapeArrowButton(position: "start" | "end"): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hand-note-eraser-option";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const current = position === "start"
        ? this.currentShapeStartArrow
        : this.currentShapeEndArrow;
      const choices: ShapeArrowHead[] = ["none", "arrow", "circle", "diamond"];
      const next = choices[(choices.indexOf(current) + 1) % choices.length];
      this.options.onShapeArrowChange(position, next);
      this.setShapeArrow(position, next);
    });
    return button;
  }

  private createShapeFillButton(): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hand-note-eraser-option";
    setIcon(button, "paint-bucket");
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.options.onShapeFillChange(!this.shapeFillEnabled);
      this.setShapeFillEnabled(!this.shapeFillEnabled);
    });
    return button;
  }

  private createExportButton(
    icon: string,
    label: string,
    onClick: () => void
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hand-note-eraser-option";
    setIcon(button, icon);
    setControlTooltip(button, label);
    const text = document.createElement("span");
    text.textContent = label;
    button.append(text);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
      button.closest(".hand-note-export-menu")?.classList.remove("is-open");
    });
    return button;
  }

  private shapeKindLabel(kind: ShapeKind): string {
    return {
      line: "直线与折线",
      polyline: "折线",
      rectangle: "矩形",
      ellipse: "椭圆",
      curve: "光滑曲线",
      "connector-straight": "直线连接器",
      "connector-elbow": "直角连接器",
      "connector-curve": "曲线连接器"
    }[kind];
  }

  private shapeKindIcon(kind: ShapeKind): string {
    return {
      line: "minus",
      polyline: "route",
      rectangle: "square",
      ellipse: "circle",
      curve: "spline",
      "connector-straight": "move-right",
      "connector-elbow": "corner-down-right",
      "connector-curve": "git-commit-horizontal"
    }[kind];
  }

  private shapeArrowLabel(arrow: ShapeArrowHead): string {
    return {
      none: "无",
      arrow: "箭头",
      circle: "圆点",
      diamond: "菱形"
    }[arrow];
  }

  private shapeArrowIcon(position: "start" | "end", arrow: ShapeArrowHead): string {
    if (arrow === "circle") {
      return "circle";
    }
    if (arrow === "diamond") {
      return "diamond";
    }
    if (arrow === "arrow") {
      return position === "start" ? "arrow-left" : "arrow-right";
    }
    return position === "start" ? "move-left" : "move-right";
  }

  private buildColorMenu(): void {
    for (const color of COLOR_PALETTE) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "hand-note-palette-swatch";
      button.style.setProperty("--hand-note-swatch", color);
      button.style.backgroundColor = color;
      setControlTooltip(button, `选择颜色 ${color}`);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        this.updateActiveColorSlot(color);
      });
      this.colorMenu.append(button);
    }
    const picker = document.createElement("input");
    picker.type = "color";
    picker.className = "hand-note-color-picker";
    picker.setAttribute("aria-label", "拾色器");
    picker.addEventListener("input", () => this.updateActiveColorSlot(picker.value));
    this.colorMenu.append(picker);
  }

  private updateActiveColorSlot(color: string): void {
    this.colorSlots[this.activeColorSlot] = color;
    const button = this.colorButtons[this.activeColorSlot];
    button?.style.setProperty("--hand-note-swatch", color);
    if (button) {
      button.style.backgroundColor = color;
    }
    try {
      window.localStorage.setItem(COLOR_STORAGE_KEY, JSON.stringify(this.colorSlots));
    } catch {
      // Color slots still work for the current session when storage is unavailable.
    }
    this.options.onColorChange(color);
    this.setColor(color);
    this.colorMenu.classList.remove("is-open");
  }

  private loadColorSlots(): string[] {
    try {
      const value = JSON.parse(window.localStorage.getItem(COLOR_STORAGE_KEY) ?? "null");
      if (
        Array.isArray(value) &&
        value.length === 4 &&
        value.every((color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color))
      ) {
        return value;
      }
    } catch {
      // Fall back to the standard four colors.
    }
    return DEFAULT_COLOR_SLOTS.slice();
  }

  private setToggle(button: HTMLButtonElement, enabled: boolean): void {
    button.classList.toggle("is-active", enabled);
    button.setAttribute("aria-pressed", String(enabled));
  }

  private toggleFloatingMenu(menu: HTMLElement, anchor: HTMLElement): void {
    const opening = !menu.classList.contains("is-open");
    this.element.querySelectorAll<HTMLElement>(".hand-note-eraser-menu.is-open")
      .forEach((candidate) => candidate.classList.remove("is-open"));
    if (!opening) {
      return;
    }
    menu.classList.add("is-open");
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const left = Math.max(8, Math.min(viewportWidth - menuRect.width - 8, anchorRect.left));
    const top = anchorRect.bottom + menuRect.height + 8 <= viewportHeight
      ? anchorRect.bottom + 6
      : Math.max(8, anchorRect.top - menuRect.height - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }
}
