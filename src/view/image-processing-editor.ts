import { App, Modal, Notice, setIcon } from "obsidian";
import {
  ImageOperation,
  ImagePoint,
  ImageSelectionMode
} from "../model/annotation";

export interface ImageEditorResult {
  png: ArrayBuffer;
  width: number;
  height: number;
  operations: ImageOperation[];
  maskEnabled: boolean;
  maskColor: string;
}

interface EditorSnapshot {
  pixels: ImageData;
  mask: Uint8Array;
  operations: ImageOperation[];
}

function canvasPng(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Unable to encode processed image"));
        return;
      }
      void blob.arrayBuffer().then(resolve, reject);
    }, "image/png");
  });
}

function parseHex(color: string): [number, number, number] {
  const value = color.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16)
  ];
}

function rgbToLab(red: number, green: number, blue: number): [number, number, number] {
  const linear = (value: number) => {
    const channel = value / 255;
    return channel > 0.04045
      ? Math.pow((channel + 0.055) / 1.055, 2.4)
      : channel / 12.92;
  };
  const r = linear(red);
  const g = linear(green);
  const b = linear(blue);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (value: number) =>
    value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function copyImageData(value: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(value.data), value.width, value.height);
}

export class ImageProcessingEditor extends Modal {
  private readonly source: HTMLCanvasElement;
  private readonly preview: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private pixels: ImageData;
  private mask: Uint8Array;
  private selectionMode: ImageSelectionMode = "replace";
  private contiguous = true;
  private tolerance = 24;
  private fillColor = "#ffffff";
  private feather = 1;
  private brushRadius = 14;
  private operationMode: "select" | "brush" | "cleanup" | "perspective" = "select";
  private brushDown = false;
  private operations: ImageOperation[] = [];
  private undoStack: EditorSnapshot[] = [];
  private redoStack: EditorSnapshot[] = [];
  private perspectiveCorners: [ImagePoint, ImagePoint, ImagePoint, ImagePoint];
  private activeCorner = -1;
  private resolveResult: ((result: ImageEditorResult | null) => void) | null = null;
  private maskVisible = true;
  private sourceMaskEnabled = true;
  private sourceMaskColor = "#ffffff";
  private straightenDegrees = 0;

  constructor(app: App, source: HTMLCanvasElement) {
    super(app);
    this.source = source;
    this.preview = document.createElement("canvas");
    this.preview.width = source.width;
    this.preview.height = source.height;
    const context = this.preview.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("Unable to create image editor canvas");
    }
    this.context = context;
    context.drawImage(source, 0, 0);
    this.pixels = context.getImageData(0, 0, source.width, source.height);
    this.mask = new Uint8Array(source.width * source.height);
    this.perspectiveCorners = [
      { x: 0, y: 0 },
      { x: source.width - 1, y: 0 },
      { x: source.width - 1, y: source.height - 1 },
      { x: 0, y: source.height - 1 }
    ];
  }

  openForResult(): Promise<ImageEditorResult | null> {
    return new Promise((resolve) => {
      this.resolveResult = resolve;
      this.open();
    });
  }

  onOpen(): void {
    this.modalEl.classList.add("hand-note-image-modal");
    this.contentEl.empty();
    this.contentEl.classList.add("hand-note-image-editor");
    const toolbar = this.contentEl.createDiv({ cls: "hand-note-image-editor-toolbar" });
    toolbar.append(
      this.button("mouse-pointer-2", "智能选区", () => this.setMode("select")),
      this.button("plus", "增加选区", () => {
        this.selectionMode = "add";
        this.setMode("brush");
      }),
      this.button("minus", "减少选区", () => {
        this.selectionMode = "subtract";
        this.setMode("brush");
      }),
      this.button("refresh-cw", "反向选区", () => this.invertMask()),
      this.button("x", "清除选区", () => this.clearMask()),
      this.button("paint-bucket", "填充颜色", () => this.fillSelection()),
      this.button("paintbrush", "清理笔", () => this.setMode("cleanup")),
      this.button("sparkles", "受控除噪", () => this.denoise()),
      this.button("crop", "按选区裁剪", () => this.cropToSelection()),
      this.button("rotate-ccw", "向左旋转", () => this.rotate(-90)),
      this.button("rotate-cw", "向右旋转", () => this.rotate(90)),
      this.button("flip-horizontal-2", "水平翻转", () => this.flip("horizontal")),
      this.button("flip-vertical-2", "垂直翻转", () => this.flip("vertical")),
      this.button("scan", "四角透视", () => this.setMode("perspective")),
      this.button("undo-2", "撤销", () => this.undo()),
      this.button("redo-2", "重做", () => this.redo())
    );

    const settings = this.contentEl.createDiv({ cls: "hand-note-image-editor-settings" });
    settings.append(
      this.range("容差", 0, 100, this.tolerance, (value) => (this.tolerance = value)),
      this.range("笔刷", 2, 80, this.brushRadius, (value) => (this.brushRadius = value)),
      this.range("羽化", 0, 12, this.feather, (value) => (this.feather = value)),
      this.range("拉直角度", -15, 15, this.straightenDegrees, (value) => (this.straightenDegrees = value)),
      this.checkbox("连续区域", this.contiguous, (value) => (this.contiguous = value)),
      this.checkbox("显示选区", this.maskVisible, (value) => {
        this.maskVisible = value;
        this.render();
      }),
      this.checkbox("遮挡原图", this.sourceMaskEnabled, (value) => (this.sourceMaskEnabled = value)),
      this.colorInput("填充色", this.fillColor, (value) => (this.fillColor = value)),
      this.colorInput("遮挡色", this.sourceMaskColor, (value) => (this.sourceMaskColor = value)),
      this.button("expand", "扩大 1px", () => this.morphMask(1, true)),
      this.button("shrink", "收缩 1px", () => this.morphMask(1, false)),
      this.button("wand-sparkles", "平滑", () => this.smoothMask()),
      this.button("baseline", "应用文字拉直", () => this.straighten())
    );
    const stage = this.contentEl.createDiv({ cls: "hand-note-image-editor-stage" });
    stage.append(this.preview);
    this.preview.addEventListener("pointerdown", this.pointerDown);
    this.preview.addEventListener("pointermove", this.pointerMove);
    this.preview.addEventListener("pointerup", this.pointerUp);
    this.preview.addEventListener("pointercancel", this.pointerUp);

    const footer = this.contentEl.createDiv({ cls: "hand-note-image-editor-footer" });
    footer.append(
      this.button("eye", "按住查看原图", () => undefined, (button) => {
        button.addEventListener("pointerdown", () => {
          this.context.drawImage(this.source, 0, 0, this.preview.width, this.preview.height);
        });
        button.addEventListener("pointerup", () => this.render());
        button.addEventListener("pointercancel", () => this.render());
      }),
      this.button("rotate-ccw", "重置", () => this.reset()),
      this.button("x", "取消", () => this.finish(null)),
      this.button("check", "应用", () => void this.apply())
    );
    this.render();
  }

  onClose(): void {
    this.preview.removeEventListener("pointerdown", this.pointerDown);
    this.preview.removeEventListener("pointermove", this.pointerMove);
    this.preview.removeEventListener("pointerup", this.pointerUp);
    this.preview.removeEventListener("pointercancel", this.pointerUp);
    if (this.resolveResult) {
      const resolve = this.resolveResult;
      this.resolveResult = null;
      resolve(null);
    }
  }

  private button(
    icon: string,
    label: string,
    action: () => void,
    enhance?: (button: HTMLButtonElement) => void
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "clickable-icon hand-note-image-action";
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    setIcon(button, icon);
    const text = document.createElement("span");
    text.textContent = label;
    button.append(text);
    button.addEventListener("click", action);
    enhance?.(button);
    return button;
  }

  private range(
    label: string,
    min: number,
    max: number,
    value: number,
    onChange: (value: number) => void
  ): HTMLElement {
    const wrapper = document.createElement("label");
    wrapper.className = "hand-note-image-range";
    const text = document.createElement("span");
    text.textContent = label;
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    const output = document.createElement("output");
    output.textContent = String(value);
    input.addEventListener("input", () => {
      output.textContent = input.value;
      onChange(Number(input.value));
    });
    wrapper.append(text, input, output);
    return wrapper;
  }

  private checkbox(label: string, value: boolean, onChange: (value: boolean) => void): HTMLElement {
    const wrapper = document.createElement("label");
    wrapper.className = "hand-note-image-check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = value;
    input.addEventListener("change", () => onChange(input.checked));
    wrapper.append(input, document.createTextNode(label));
    return wrapper;
  }

  private colorInput(label: string, value: string, onChange: (value: string) => void): HTMLElement {
    const wrapper = document.createElement("label");
    wrapper.className = "hand-note-image-check";
    const input = document.createElement("input");
    input.type = "color";
    input.value = value;
    input.addEventListener("input", () => onChange(input.value));
    wrapper.append(document.createTextNode(label), input);
    return wrapper;
  }

  private setMode(mode: typeof this.operationMode): void {
    this.operationMode = mode;
    if (mode === "select") {
      this.selectionMode = "replace";
    }
    this.preview.dataset.mode = mode;
    new Notice(
      mode === "select"
        ? "点击图片中的颜色进行智能选区"
        : mode === "perspective"
          ? "拖动四个角点，完成后再次点击四角透视"
          : "在图片上拖动进行处理",
      2600
    );
  }

  private snapshot(): void {
    this.undoStack.push({
      pixels: copyImageData(this.pixels),
      mask: this.mask.slice(),
      operations: this.operations.map((operation) => ({ ...operation }))
    });
    if (this.undoStack.length > 24) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  private restore(snapshot: EditorSnapshot): void {
    this.pixels = copyImageData(snapshot.pixels);
    this.mask = snapshot.mask.slice();
    this.operations = snapshot.operations.map((operation) => ({ ...operation }));
    this.resizeCanvas(this.pixels.width, this.pixels.height);
    this.render();
  }

  private undo(): void {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return;
    this.redoStack.push({ pixels: copyImageData(this.pixels), mask: this.mask.slice(), operations: [...this.operations] });
    this.restore(snapshot);
  }

  private redo(): void {
    const snapshot = this.redoStack.pop();
    if (!snapshot) return;
    this.undoStack.push({ pixels: copyImageData(this.pixels), mask: this.mask.slice(), operations: [...this.operations] });
    this.restore(snapshot);
  }

  private reset(): void {
    this.snapshot();
    this.resizeCanvas(this.source.width, this.source.height);
    this.context.drawImage(this.source, 0, 0);
    this.pixels = this.context.getImageData(0, 0, this.preview.width, this.preview.height);
    this.mask = new Uint8Array(this.preview.width * this.preview.height);
    this.operations = [];
    this.render();
  }

  private point(event: PointerEvent): ImagePoint {
    const rect = this.preview.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(this.preview.width - 1, ((event.clientX - rect.left) / rect.width) * this.preview.width)),
      y: Math.max(0, Math.min(this.preview.height - 1, ((event.clientY - rect.top) / rect.height) * this.preview.height))
    };
  }

  private pointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    const point = this.point(event);
    if (this.operationMode === "select") {
      this.selectColor(point);
      return;
    }
    if (this.operationMode === "perspective") {
      const nearest = this.perspectiveCorners
        .map((corner, index) => ({ index, distance: Math.hypot(corner.x - point.x, corner.y - point.y) }))
        .sort((a, b) => a.distance - b.distance)[0];
      if (nearest.distance < Math.max(24, this.preview.width * 0.05)) {
        this.activeCorner = nearest.index;
        this.preview.setPointerCapture(event.pointerId);
      } else {
        this.applyPerspective();
      }
      return;
    }
    this.snapshot();
    this.brushDown = true;
    this.preview.setPointerCapture(event.pointerId);
    this.paintAt(point);
  };

  private pointerMove = (event: PointerEvent): void => {
    const point = this.point(event);
    if (this.operationMode === "perspective" && this.activeCorner >= 0) {
      this.perspectiveCorners[this.activeCorner] = point;
      this.render();
      return;
    }
    if (this.brushDown) {
      this.paintAt(point);
    }
  };

  private pointerUp = (event: PointerEvent): void => {
    if (this.brushDown) {
      this.operations.push({
        type: this.operationMode === "cleanup" ? "cleanup" : "mask-brush",
        ...(this.operationMode === "cleanup"
          ? { color: this.fillColor, points: [], radius: this.brushRadius }
          : { points: [], radius: this.brushRadius, mode: this.selectionMode === "subtract" ? "subtract" : "add" })
      } as ImageOperation);
    }
    this.brushDown = false;
    this.activeCorner = -1;
    try {
      if (this.preview.hasPointerCapture(event.pointerId)) this.preview.releasePointerCapture(event.pointerId);
    } catch {
      // Capture may already have been released.
    }
  };

  private selectColor(point: ImagePoint): void {
    this.snapshot();
    const x = Math.floor(point.x);
    const y = Math.floor(point.y);
    const width = this.pixels.width;
    const height = this.pixels.height;
    const sampleIndex = (y * width + x) * 4;
    const sample = rgbToLab(
      this.pixels.data[sampleIndex],
      this.pixels.data[sampleIndex + 1],
      this.pixels.data[sampleIndex + 2]
    );
    const selected = new Uint8Array(width * height);
    const matches = (index: number) => {
      const offset = index * 4;
      return colorDistance(
        sample,
        rgbToLab(this.pixels.data[offset], this.pixels.data[offset + 1], this.pixels.data[offset + 2])
      ) <= this.tolerance;
    };
    if (this.contiguous) {
      const queue = new Int32Array(width * height);
      let head = 0;
      let tail = 0;
      queue[tail++] = y * width + x;
      selected[y * width + x] = 1;
      while (head < tail) {
        const index = queue[head++];
        if (!matches(index)) {
          selected[index] = 0;
          continue;
        }
        const px = index % width;
        const py = Math.floor(index / width);
        const neighbors = [index - 1, index + 1, index - width, index + width];
        neighbors.forEach((next, direction) => {
          if (next < 0 || next >= selected.length || selected[next]) return;
          if ((direction === 0 && px === 0) || (direction === 1 && px === width - 1) || (direction === 2 && py === 0) || (direction === 3 && py === height - 1)) return;
          selected[next] = 1;
          queue[tail++] = next;
        });
      }
    } else {
      for (let index = 0; index < selected.length; index += 1) {
        if (matches(index)) selected[index] = 1;
      }
    }
    for (let index = 0; index < this.mask.length; index += 1) {
      if (this.selectionMode === "replace") this.mask[index] = selected[index] ? 255 : 0;
      else if (this.selectionMode === "add" && selected[index]) this.mask[index] = 255;
      else if (this.selectionMode === "subtract" && selected[index]) this.mask[index] = 0;
    }
    this.operations.push({ type: "color-select", point, tolerance: this.tolerance, contiguous: this.contiguous, mode: this.selectionMode });
    this.render();
  }

  private paintAt(point: ImagePoint): void {
    const radius = this.brushRadius;
    const minX = Math.max(0, Math.floor(point.x - radius));
    const maxX = Math.min(this.pixels.width - 1, Math.ceil(point.x + radius));
    const minY = Math.max(0, Math.floor(point.y - radius));
    const maxY = Math.min(this.pixels.height - 1, Math.ceil(point.y + radius));
    const color = parseHex(this.fillColor);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (Math.hypot(x - point.x, y - point.y) > radius) continue;
        const index = y * this.pixels.width + x;
        if (this.operationMode === "cleanup") {
          const offset = index * 4;
          this.pixels.data[offset] = color[0];
          this.pixels.data[offset + 1] = color[1];
          this.pixels.data[offset + 2] = color[2];
          this.pixels.data[offset + 3] = 255;
        } else {
          this.mask[index] = this.selectionMode === "subtract" ? 0 : 255;
        }
      }
    }
    this.render();
  }

  private invertMask(): void {
    this.snapshot();
    for (let index = 0; index < this.mask.length; index += 1) this.mask[index] = 255 - this.mask[index];
    this.operations.push({ type: "mask-invert" });
    this.render();
  }

  private clearMask(): void {
    this.snapshot();
    this.mask.fill(0);
    this.operations.push({ type: "mask-clear" });
    this.render();
  }

  private morphMask(radius: number, grow: boolean): void {
    this.snapshot();
    const source = this.mask.slice();
    const width = this.pixels.width;
    const height = this.pixels.height;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let value = grow ? 0 : 255;
        for (let dy = -radius; dy <= radius; dy += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            const candidate = nx < 0 || ny < 0 || nx >= width || ny >= height ? 0 : source[ny * width + nx];
            value = grow ? Math.max(value, candidate) : Math.min(value, candidate);
          }
        }
        this.mask[y * width + x] = value;
      }
    }
    this.operations.push({ type: grow ? "mask-grow" : "mask-shrink", radius });
    this.render();
  }

  private smoothMask(): void {
    this.snapshot();
    const source = this.mask.slice();
    const width = this.pixels.width;
    for (let y = 1; y < this.pixels.height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) sum += source[(y + dy) * width + x + dx];
        this.mask[y * width + x] = sum >= 255 * 5 ? 255 : 0;
      }
    }
    this.operations.push({ type: "mask-smooth" });
    this.render();
  }

  private fillSelection(): void {
    if (!this.mask.some((value) => value > 0)) {
      new Notice("请先建立选区");
      return;
    }
    this.snapshot();
    const [red, green, blue] = parseHex(this.fillColor);
    let alphaMask = this.mask;
    if (this.feather > 0) {
      alphaMask = this.blurMask(this.mask, Math.min(12, this.feather));
    }
    for (let index = 0; index < alphaMask.length; index += 1) {
      const alpha = alphaMask[index] / 255;
      if (alpha <= 0) continue;
      const offset = index * 4;
      this.pixels.data[offset] = Math.round(this.pixels.data[offset] * (1 - alpha) + red * alpha);
      this.pixels.data[offset + 1] = Math.round(this.pixels.data[offset + 1] * (1 - alpha) + green * alpha);
      this.pixels.data[offset + 2] = Math.round(this.pixels.data[offset + 2] * (1 - alpha) + blue * alpha);
      this.pixels.data[offset + 3] = 255;
    }
    this.operations.push({ type: "fill", color: this.fillColor, feather: this.feather });
    this.render();
  }

  private blurMask(source: Uint8Array, radius: number): Uint8Array {
    const output = new Uint8Array(source.length);
    const width = this.pixels.width;
    const height = this.pixels.height;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let count = 0;
        for (let dy = -radius; dy <= radius; dy += 1) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -radius; dx <= radius; dx += 1) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            sum += source[ny * width + nx];
            count += 1;
          }
        }
        output[y * width + x] = Math.round(sum / count);
      }
    }
    return output;
  }

  private denoise(): void {
    if (!this.mask.some((value) => value > 0)) {
      new Notice("请先选中需要检查的背景区域");
      return;
    }
    this.snapshot();
    const width = this.pixels.width;
    const visited = new Uint8Array(this.mask.length);
    const [red, green, blue] = parseHex(this.fillColor);
    const maxArea = Math.max(3, Math.round((width * this.pixels.height) / 160000));
    for (let start = 0; start < visited.length; start += 1) {
      if (visited[start] || !this.mask[start]) continue;
      const queue = [start];
      const component: number[] = [];
      visited[start] = 1;
      while (queue.length) {
        const index = queue.pop() as number;
        component.push(index);
        const x = index % width;
        const next = [index - 1, index + 1, index - width, index + width];
        next.forEach((candidate, direction) => {
          if (candidate < 0 || candidate >= visited.length || visited[candidate] || !this.mask[candidate]) return;
          if ((direction === 0 && x === 0) || (direction === 1 && x === width - 1)) return;
          visited[candidate] = 1;
          queue.push(candidate);
        });
      }
      if (component.length <= maxArea) {
        component.forEach((index) => {
          const offset = index * 4;
          this.pixels.data[offset] = red;
          this.pixels.data[offset + 1] = green;
          this.pixels.data[offset + 2] = blue;
        });
      }
    }
    this.operations.push({ type: "denoise", color: this.fillColor, maxArea });
    this.render();
  }

  private cropToSelection(): void {
    let minX = this.pixels.width;
    let minY = this.pixels.height;
    let maxX = -1;
    let maxY = -1;
    for (let index = 0; index < this.mask.length; index += 1) {
      if (!this.mask[index]) continue;
      const x = index % this.pixels.width;
      const y = Math.floor(index / this.pixels.width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (maxX < minX || maxY < minY) {
      new Notice("请先建立用于裁剪的选区");
      return;
    }
    this.snapshot();
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const cropped = new ImageData(width, height);
    for (let y = 0; y < height; y += 1) {
      const sourceStart = ((minY + y) * this.pixels.width + minX) * 4;
      cropped.data.set(this.pixels.data.subarray(sourceStart, sourceStart + width * 4), y * width * 4);
    }
    this.resizeCanvas(width, height);
    this.pixels = cropped;
    this.mask = new Uint8Array(width * height);
    this.operations.push({ type: "crop" });
    this.resetCorners();
    this.render();
  }

  private straighten(): void {
    const degrees = Math.max(-15, Math.min(15, this.straightenDegrees));
    if (Math.abs(degrees) < 0.1) return;
    this.snapshot();
    const source = document.createElement("canvas");
    source.width = this.pixels.width;
    source.height = this.pixels.height;
    source.getContext("2d")?.putImageData(this.pixels, 0, 0);
    this.context.save();
    this.context.fillStyle = this.fillColor;
    this.context.fillRect(0, 0, this.preview.width, this.preview.height);
    this.context.translate(this.preview.width / 2, this.preview.height / 2);
    this.context.rotate((degrees * Math.PI) / 180);
    this.context.drawImage(source, -source.width / 2, -source.height / 2);
    this.context.restore();
    this.pixels = this.context.getImageData(0, 0, this.preview.width, this.preview.height);
    this.mask.fill(0);
    this.operations.push({ type: "straighten", degrees });
    this.render();
  }

  private rotate(degrees: -90 | 90): void {
    this.snapshot();
    const oldWidth = this.pixels.width;
    const oldHeight = this.pixels.height;
    const source = document.createElement("canvas");
    source.width = oldWidth;
    source.height = oldHeight;
    source.getContext("2d")?.putImageData(this.pixels, 0, 0);
    this.resizeCanvas(oldHeight, oldWidth);
    this.context.save();
    this.context.translate(this.preview.width / 2, this.preview.height / 2);
    this.context.rotate((degrees * Math.PI) / 180);
    this.context.drawImage(source, -oldWidth / 2, -oldHeight / 2);
    this.context.restore();
    this.pixels = this.context.getImageData(0, 0, this.preview.width, this.preview.height);
    this.mask = new Uint8Array(this.preview.width * this.preview.height);
    this.operations.push({ type: "rotate", degrees });
    this.resetCorners();
    this.render();
  }

  private flip(axis: "horizontal" | "vertical"): void {
    this.snapshot();
    const source = document.createElement("canvas");
    source.width = this.pixels.width;
    source.height = this.pixels.height;
    source.getContext("2d")?.putImageData(this.pixels, 0, 0);
    this.context.save();
    this.context.setTransform(axis === "horizontal" ? -1 : 1, 0, 0, axis === "vertical" ? -1 : 1, axis === "horizontal" ? this.preview.width : 0, axis === "vertical" ? this.preview.height : 0);
    this.context.drawImage(source, 0, 0);
    this.context.restore();
    this.pixels = this.context.getImageData(0, 0, this.preview.width, this.preview.height);
    this.operations.push({ type: "flip", axis });
    this.render();
  }

  private applyPerspective(): void {
    this.snapshot();
    const source = copyImageData(this.pixels);
    const output = new ImageData(source.width, source.height);
    const [topLeft, topRight, bottomRight, bottomLeft] = this.perspectiveCorners;
    for (let y = 0; y < output.height; y += 1) {
      const v = y / Math.max(1, output.height - 1);
      for (let x = 0; x < output.width; x += 1) {
        const u = x / Math.max(1, output.width - 1);
        const sx = (1 - v) * ((1 - u) * topLeft.x + u * topRight.x) + v * ((1 - u) * bottomLeft.x + u * bottomRight.x);
        const sy = (1 - v) * ((1 - u) * topLeft.y + u * topRight.y) + v * ((1 - u) * bottomLeft.y + u * bottomRight.y);
        const sourceIndex = (Math.max(0, Math.min(source.height - 1, Math.round(sy))) * source.width + Math.max(0, Math.min(source.width - 1, Math.round(sx)))) * 4;
        const targetIndex = (y * output.width + x) * 4;
        output.data.set(source.data.subarray(sourceIndex, sourceIndex + 4), targetIndex);
      }
    }
    this.pixels = output;
    this.mask.fill(0);
    this.operations.push({ type: "perspective", corners: this.perspectiveCorners.map((point) => ({ ...point })) as [ImagePoint, ImagePoint, ImagePoint, ImagePoint] });
    this.resetCorners();
    this.operationMode = "select";
    this.render();
  }

  private resizeCanvas(width: number, height: number): void {
    this.preview.width = Math.max(1, width);
    this.preview.height = Math.max(1, height);
  }

  private resetCorners(): void {
    this.perspectiveCorners = [
      { x: 0, y: 0 },
      { x: this.preview.width - 1, y: 0 },
      { x: this.preview.width - 1, y: this.preview.height - 1 },
      { x: 0, y: this.preview.height - 1 }
    ];
  }

  private render(): void {
    this.context.putImageData(this.pixels, 0, 0);
    if (this.maskVisible) {
      const overlay = this.context.getImageData(0, 0, this.preview.width, this.preview.height);
      for (let index = 0; index < this.mask.length; index += 1) {
        if (!this.mask[index]) continue;
        const offset = index * 4;
        const alpha = (this.mask[index] / 255) * 0.35;
        overlay.data[offset] = Math.round(overlay.data[offset] * (1 - alpha) + 0 * alpha);
        overlay.data[offset + 1] = Math.round(overlay.data[offset + 1] * (1 - alpha) + 145 * alpha);
        overlay.data[offset + 2] = Math.round(overlay.data[offset + 2] * (1 - alpha) + 255 * alpha);
      }
      this.context.putImageData(overlay, 0, 0);
    }
    if (this.operationMode === "perspective") {
      this.context.save();
      this.context.strokeStyle = "#ff3b30";
      this.context.fillStyle = "#ffffff";
      this.context.lineWidth = Math.max(2, this.preview.width / 500);
      this.context.beginPath();
      this.perspectiveCorners.forEach((point, index) => index ? this.context.lineTo(point.x, point.y) : this.context.moveTo(point.x, point.y));
      this.context.closePath();
      this.context.stroke();
      this.perspectiveCorners.forEach((point) => {
        this.context.beginPath();
        this.context.arc(point.x, point.y, Math.max(7, this.preview.width / 120), 0, Math.PI * 2);
        this.context.fill();
        this.context.stroke();
      });
      this.context.restore();
    }
  }

  private async apply(): Promise<void> {
    this.context.putImageData(this.pixels, 0, 0);
    const result: ImageEditorResult = {
      png: await canvasPng(this.preview),
      width: this.preview.width,
      height: this.preview.height,
      operations: [...this.operations],
      maskEnabled: this.sourceMaskEnabled,
      maskColor: this.sourceMaskColor
    };
    this.finish(result);
  }

  private finish(result: ImageEditorResult | null): void {
    const resolve = this.resolveResult;
    this.resolveResult = null;
    this.close();
    resolve?.(result);
  }
}
