import { App, TFile, normalizePath } from "obsidian";
import { PDFDocument } from "pdf-lib";
import { AnnotationDocument, cloneDocument } from "../model/annotation";
import { getAnnotationPath, loadAnnotation } from "../storage/annotation-store";
import { drawFreehandStroke } from "../view/freehand-renderer";
import { readImageAsset } from "../storage/image-asset-store";

const EXPORT_ROOT = "HandLayers 导出";
const ELLIPSE_CONTROL_FACTOR = 2 * (Math.sqrt(2) - 1) / 3;

export interface AnnotationExportResult {
  directory: string;
  exportedFiles: number;
  excludedDraftWhiteboards: number;
}

export interface PdfExportResult {
  path: string;
  excludedDraftWhiteboards: number;
}

export interface LayerPackageExportResult {
  path: string;
  layerCount: number;
  excludedDraftWhiteboards: number;
}

interface ExportedFileEntry {
  sourcePath: string;
  sourceCopy: string;
  annotationCopy: string;
  flattenedCopies: string[];
  imageAssetCopies: string[];
  layerCount: number;
  visibleLayerCount: number;
  excludedDraftWhiteboards: number;
}

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;"
    };
    return entities[character];
  });
}

interface ExportPoint {
  x: number;
  y: number;
}

function quadraticControlThrough(
  start: ExportPoint,
  through: ExportPoint,
  end: ExportPoint
): ExportPoint {
  return {
    x: 2 * through.x - (start.x + end.x) / 2,
    y: 2 * through.y - (start.y + end.y) / 2
  };
}

function shapePathData(
  stroke: AnnotationDocument["layers"][number]["strokes"][number],
  points: ExportPoint[]
): string {
  if (stroke.shape === "curve" && points.length === 3) {
    const control = quadraticControlThrough(points[0], points[1], points[2]);
    return `M${points[0].x},${points[0].y} Q${control.x},${control.y} ${points[2].x},${points[2].y}`;
  }
  if ((stroke.shape === "curve" || stroke.shape === "connector-curve") && points.length >= 4) {
    return `M${points[0].x},${points[0].y} C${points[1].x},${points[1].y} ${points[2].x},${points[2].y} ${points[3].x},${points[3].y}`;
  }
  if ((stroke.shape === "ellipse" || stroke.shape === "circle") && points.length >= 4) {
    const commands: string[] = [`M${points[0].x},${points[0].y}`];
    for (let index = 0; index < 4; index += 1) {
      const previous = points[(index + 3) % 4];
      const current = points[index];
      const next = points[(index + 1) % 4];
      const after = points[(index + 2) % 4];
      commands.push(
        `C${current.x + (next.x - previous.x) * ELLIPSE_CONTROL_FACTOR},${current.y + (next.y - previous.y) * ELLIPSE_CONTROL_FACTOR} ` +
        `${next.x - (after.x - current.x) * ELLIPSE_CONTROL_FACTOR},${next.y - (after.y - current.y) * ELLIPSE_CONTROL_FACTOR} ${next.x},${next.y}`
      );
    }
    commands.push("Z");
    return commands.join(" ");
  }
  const commands = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`);
  if (stroke.closed || stroke.shape === "rectangle") {
    commands.push("Z");
  }
  return commands.join(" ");
}

function shapeArrowSvg(
  tip: ExportPoint,
  adjacent: ExportPoint,
  arrow: AnnotationDocument["layers"][number]["strokes"][number]["endArrow"],
  color: string,
  opacity: number,
  strokeWidth: number
): string {
  if (!arrow || arrow === "none") {
    return "";
  }
  const angle = Math.atan2(tip.y - adjacent.y, tip.x - adjacent.x);
  const length = Math.max(7, Math.min(13, 7 + strokeWidth));
  if (arrow === "circle") {
    return `<circle cx="${tip.x}" cy="${tip.y}" r="${Math.max(2.5, Math.min(5, strokeWidth + 2))}" fill="${color}" opacity="${opacity}"/>`;
  }
  const back = {
    x: tip.x - Math.cos(angle) * length,
    y: tip.y - Math.sin(angle) * length
  };
  if (arrow === "diamond") {
    const half = length * 0.42;
    const middle = { x: (tip.x + back.x) / 2, y: (tip.y + back.y) / 2 };
    const first = {
      x: middle.x + Math.cos(angle + Math.PI / 2) * half,
      y: middle.y + Math.sin(angle + Math.PI / 2) * half
    };
    const second = {
      x: middle.x + Math.cos(angle - Math.PI / 2) * half,
      y: middle.y + Math.sin(angle - Math.PI / 2) * half
    };
    return `<polygon points="${tip.x},${tip.y} ${first.x},${first.y} ${back.x},${back.y} ${second.x},${second.y}" fill="${color}" opacity="${opacity}"/>`;
  }
  const spread = Math.PI / 7;
  const first = {
    x: tip.x - Math.cos(angle - spread) * length,
    y: tip.y - Math.sin(angle - spread) * length
  };
  const second = {
    x: tip.x - Math.cos(angle + spread) * length,
    y: tip.y - Math.sin(angle + spread) * length
  };
  return `<polygon points="${tip.x},${tip.y} ${first.x},${first.y} ${second.x},${second.y}" fill="${color}" opacity="${opacity}"/>`;
}

function strokeSvg(
  points: AnnotationDocument["layers"][number]["strokes"],
  layerOpacity: number
): string {
  return points
    .filter((stroke) => stroke.points.length > 0)
    .map((stroke) => {
      const opacity = layerOpacity * (stroke.opacity ?? (stroke.tool === "highlighter" ? 0.32 : 1));
      const line = stroke.points
        .map((point) => `${(point.x * 1000).toFixed(2)},${(point.y * 1000).toFixed(2)}`)
        .join(" ");
      const color = xmlEscape(stroke.color);
      if (stroke.tool === "text") {
        const start = stroke.points[0];
        const fontSize = stroke.fontSize ?? stroke.size ?? 24;
        const lines = (stroke.text ?? "文本").split("\n");
        return `<text x="${(start.x * 1000).toFixed(2)}" y="${(
          start.y * 1000
        ).toFixed(2)}" fill="${color}" font-family="sans-serif" font-size="${fontSize}" dominant-baseline="hanging" opacity="${opacity}">${lines
          .map(
            (text, index) =>
              `<tspan x="${(start.x * 1000).toFixed(2)}" dy="${
                index === 0 ? 0 : fontSize * 1.25
              }">${xmlEscape(text)}</tspan>`
          )
          .join("")}</text>`;
      }
      if (stroke.tool === "shape") {
        const pixels = stroke.points.map((point) => ({
          x: point.x * 1000,
          y: point.y * 1000
        }));
        const path = shapePathData(stroke, pixels);
        const fill = stroke.fillColor && (stroke.closed || stroke.shape === "rectangle" || stroke.shape === "ellipse" || stroke.shape === "circle")
          ? xmlEscape(stroke.fillColor)
          : "none";
        const dash = stroke.lineStyle === "dashed"
          ? `${Math.max(6, stroke.size * 3)} ${Math.max(4, stroke.size * 2)}`
          : stroke.lineStyle === "dotted"
            ? `${Math.max(1, stroke.size * 0.4)} ${Math.max(4, stroke.size * 2)}`
            : "";
        const firstAdjacent = pixels[1];
        const lastAdjacent = pixels[pixels.length - 2];
        const arrows = stroke.closed || stroke.shape === "rectangle" || stroke.shape === "ellipse" || stroke.shape === "circle" || pixels.length < 2 ? "" :
          shapeArrowSvg(pixels[0], firstAdjacent, stroke.startArrow, color, opacity, stroke.size) +
          shapeArrowSvg(pixels[pixels.length - 1], lastAdjacent, stroke.endArrow, color, opacity, stroke.size);
        return `<path d="${path}" fill="${fill}" fill-opacity="${stroke.fillOpacity ?? 0.14}" stroke="${color}" stroke-width="${stroke.size}" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ""} opacity="${opacity}"/>${arrows}`;
      }
      if (stroke.points.length === 1) {
        const point = stroke.points[0];
        return `<circle cx="${(point.x * 1000).toFixed(2)}" cy="${(point.y * 1000).toFixed(2)}" r="${Math.max(0.5, stroke.size / 2)}" fill="${color}" opacity="${opacity}"/>`;
      }
      return `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="${stroke.size}" stroke-linecap="${stroke.tool === "highlighter" ? "square" : "round"}" stroke-linejoin="round" opacity="${opacity}"/>`;
    })
    .join("");
}

function flattenedSvg(document: AnnotationDocument, pageIndex?: number): string {
  const definitions: string[] = [];
  const content: string[] = [];
  document.layers.forEach((layer, layerIndex) => {
    if (!layer.visible || layer.opacity <= 0) {
      return;
    }
    const pageStrokes = layer.strokes.filter(
      (stroke) => stroke.pageIndex === pageIndex
    );
    const whiteboard = layer.whiteboard;
    if (whiteboard?.bounds.pageIndex !== pageIndex && pageStrokes.length === 0) {
      return;
    }
    if (!whiteboard || whiteboard.bounds.pageIndex !== pageIndex) {
      content.push(strokeSvg(pageStrokes, layer.opacity));
      return;
    }
    const bounds = whiteboard.bounds;
    const x = bounds.minX * 1000;
    const y = bounds.minY * 1000;
    const width = (bounds.maxX - bounds.minX) * 1000;
    const height = (bounds.maxY - bounds.minY) * 1000;
    const clipId = `whiteboard-${layerIndex}`;
    definitions.push(
      `<clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${width}" height="${height}"/></clipPath>`
    );
    content.push(
      `<g clip-path="url(#${clipId})"><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${xmlEscape(whiteboard.background)}" opacity="${layer.opacity}"/>${strokeSvg(pageStrokes, layer.opacity)}</g>`
    );
  });
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" preserveAspectRatio="none"><defs>${definitions.join("")}</defs>${content.join("")}</svg>`;
}

async function writeFlattenedCopies(
  app: App,
  source: TFile,
  document: AnnotationDocument,
  directory: string
): Promise<string[]> {
  const pages = new Set<number | undefined>();
  for (const layer of document.layers) {
    for (const stroke of layer.strokes) {
      pages.add(stroke.pageIndex);
    }
    if (layer.whiteboard) {
      pages.add(layer.whiteboard.bounds.pageIndex);
    }
  }
  if (pages.size === 0) {
    pages.add(undefined);
  }
  const baseDirectory = normalizePath(`${directory}/可见图层/${source.path}`);
  await ensureFolder(app, baseDirectory);
  const copies: string[] = [];
  for (const pageIndex of [...pages].sort((a, b) => (a ?? 0) - (b ?? 0))) {
    const name = pageIndex === undefined ? "标注.svg" : `第${pageIndex}页.svg`;
    const path = normalizePath(`${baseDirectory}/${name}`);
    await app.vault.adapter.write(path, flattenedSvg(document, pageIndex));
    copies.push(path);
  }
  return copies;
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const parts = normalizePath(path).split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await app.vault.adapter.exists(current))) {
      try {
        await app.vault.adapter.mkdir(current);
      } catch (error) {
        if (!(await app.vault.adapter.exists(current))) {
          throw error;
        }
      }
    }
  }
}

function exportTimestamp(date = new Date()): string {
  const part = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    part(date.getMonth() + 1),
    part(date.getDate()),
    "-",
    part(date.getHours()),
    part(date.getMinutes()),
    part(date.getSeconds())
  ].join("");
}

function withoutDraftWhiteboards(document: AnnotationDocument): AnnotationDocument {
  const exported = cloneDocument(document);
  exported.draftWhiteboards = [];
  return exported;
}

function canvasPng(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Unable to encode annotation overlay"));
        return;
      }
      void blob.arrayBuffer().then(resolve, reject);
    }, "image/png");
  });
}

function wrapCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const character of Array.from(paragraph)) {
      const candidate = line + character;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = character;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawCanvasShapeArrow(
  context: CanvasRenderingContext2D,
  tip: ExportPoint,
  adjacent: ExportPoint,
  arrow: AnnotationDocument["layers"][number]["strokes"][number]["endArrow"],
  strokeWidth: number
): void {
  if (!arrow || arrow === "none") {
    return;
  }
  const angle = Math.atan2(tip.y - adjacent.y, tip.x - adjacent.x);
  const length = Math.max(7, Math.min(13, 7 + strokeWidth));
  context.save();
  context.setLineDash([]);
  context.fillStyle = context.strokeStyle;
  if (arrow === "circle") {
    context.beginPath();
    context.arc(tip.x, tip.y, Math.max(2.5, Math.min(5, strokeWidth + 2)), 0, Math.PI * 2);
    context.fill();
  } else if (arrow === "diamond") {
    const backX = tip.x - Math.cos(angle) * length;
    const backY = tip.y - Math.sin(angle) * length;
    const middleX = (tip.x + backX) / 2;
    const middleY = (tip.y + backY) / 2;
    const half = length * 0.42;
    context.beginPath();
    context.moveTo(tip.x, tip.y);
    context.lineTo(middleX + Math.cos(angle + Math.PI / 2) * half, middleY + Math.sin(angle + Math.PI / 2) * half);
    context.lineTo(backX, backY);
    context.lineTo(middleX + Math.cos(angle - Math.PI / 2) * half, middleY + Math.sin(angle - Math.PI / 2) * half);
    context.closePath();
    context.fill();
  } else {
    const spread = Math.PI / 7;
    context.beginPath();
    context.moveTo(tip.x, tip.y);
    context.lineTo(tip.x - Math.cos(angle - spread) * length, tip.y - Math.sin(angle - spread) * length);
    context.lineTo(tip.x - Math.cos(angle + spread) * length, tip.y - Math.sin(angle + spread) * length);
    context.closePath();
    context.fill();
  }
  context.restore();
}

function drawCanvasStroke(
  context: CanvasRenderingContext2D,
  stroke: AnnotationDocument["layers"][number]["strokes"][number],
  width: number,
  height: number,
  layerOpacity: number
): void {
  if (stroke.points.length === 0) {
    return;
  }
  context.save();
  context.globalAlpha =
    layerOpacity * (stroke.opacity ?? (stroke.tool === "highlighter" ? 0.32 : 1));
  context.fillStyle = stroke.color;
  context.strokeStyle = stroke.color;
  if (stroke.tool === "text") {
    const start = stroke.points[0];
    if (start) {
      const fontSize = Math.max(8, stroke.fontSize ?? stroke.size ?? 24);
      context.font = `${fontSize}px sans-serif`;
      context.textBaseline = "top";
      const end = stroke.points[1];
      const maxWidth = end
        ? Math.max(fontSize, Math.abs(end.x - start.x) * width)
        : Number.POSITIVE_INFINITY;
      wrapCanvasText(context, stroke.text ?? "文本", maxWidth).forEach((line, index) => {
        context.fillText(
          line,
          start.x * width,
          start.y * height + index * fontSize * 1.25
        );
      });
    }
    context.restore();
    return;
  }
  if (stroke.tool === "shape") {
    const points = stroke.points.map((point) => ({
      x: point.x * width,
      y: point.y * height
    }));
    if (points.length >= 2) {
      context.lineWidth = stroke.size;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.setLineDash(
        stroke.lineStyle === "dashed"
          ? [Math.max(6, stroke.size * 3), Math.max(4, stroke.size * 2)]
          : stroke.lineStyle === "dotted"
            ? [Math.max(1, stroke.size * 0.4), Math.max(4, stroke.size * 2)]
            : []
      );
      context.beginPath();
      if (stroke.shape === "curve" && points.length === 3) {
        const control = quadraticControlThrough(points[0], points[1], points[2]);
        context.moveTo(points[0].x, points[0].y);
        context.quadraticCurveTo(control.x, control.y, points[2].x, points[2].y);
      } else if ((stroke.shape === "curve" || stroke.shape === "connector-curve") && points.length >= 4) {
        context.moveTo(points[0].x, points[0].y);
        context.bezierCurveTo(
          points[1].x,
          points[1].y,
          points[2].x,
          points[2].y,
          points[3].x,
          points[3].y
        );
      } else if (stroke.shape === "rectangle" && points.length >= 4) {
        context.moveTo(points[0].x, points[0].y);
        points.slice(1, 4).forEach((point) => context.lineTo(point.x, point.y));
        context.closePath();
      } else if ((stroke.shape === "ellipse" || stroke.shape === "circle") && points.length >= 4) {
        context.moveTo(points[0].x, points[0].y);
        for (let index = 0; index < 4; index += 1) {
          const previous = points[(index + 3) % 4];
          const current = points[index];
          const next = points[(index + 1) % 4];
          const after = points[(index + 2) % 4];
          context.bezierCurveTo(
            current.x + (next.x - previous.x) * ELLIPSE_CONTROL_FACTOR,
            current.y + (next.y - previous.y) * ELLIPSE_CONTROL_FACTOR,
            next.x - (after.x - current.x) * ELLIPSE_CONTROL_FACTOR,
            next.y - (after.y - current.y) * ELLIPSE_CONTROL_FACTOR,
            next.x,
            next.y
          );
        }
        context.closePath();
      } else {
        context.moveTo(points[0].x, points[0].y);
        points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
        if (stroke.closed) {
          context.closePath();
        }
      }
      if (stroke.fillColor && (stroke.closed || stroke.shape === "rectangle" || stroke.shape === "ellipse" || stroke.shape === "circle")) {
        context.save();
        context.globalAlpha *= stroke.fillOpacity ?? 0.14;
        context.fillStyle = stroke.fillColor;
        context.fill();
        context.restore();
      }
      context.stroke();
      context.setLineDash([]);
      if (!stroke.closed && stroke.shape !== "rectangle" && stroke.shape !== "ellipse" && stroke.shape !== "circle") {
        drawCanvasShapeArrow(context, points[0], points[1], stroke.startArrow, stroke.size);
        drawCanvasShapeArrow(
          context,
          points[points.length - 1],
          points[points.length - 2],
          stroke.endArrow,
          stroke.size
        );
      }
    }
    context.restore();
    return;
  }
  if (stroke.tool === "pen" || stroke.tool === "pencil") {
    drawFreehandStroke(
      context,
      stroke,
      {
        documentWidth: width,
        documentHeight: height,
        offsetX: 0,
        offsetY: 0,
        width,
        height
      },
      true
    );
    context.restore();
    return;
  }
  const points = stroke.points.map((point) => ({
    x: point.x * width,
    y: point.y * height
  }));
  if (points.length === 1) {
    context.beginPath();
    context.arc(points[0].x, points[0].y, stroke.size / 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
    return;
  }
  context.globalCompositeOperation =
    stroke.tool === "highlighter" ? "multiply" : "source-over";
  context.lineWidth = stroke.size;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    context.lineTo(points[index].x, points[index].y);
  }
  context.stroke();
  context.restore();
}

async function renderPdfOverlay(
  app: App,
  document: AnnotationDocument,
  pageIndex: number,
  width: number,
  height: number
): Promise<ArrayBuffer | null> {
  const visibleLayers = document.layers.filter(
    (layer) =>
      layer.visible &&
      layer.opacity > 0 &&
      (layer.strokes.some((stroke) => stroke.pageIndex === pageIndex) ||
        layer.images?.some((image) => image.pageIndex === pageIndex) ||
        layer.whiteboard?.bounds.pageIndex === pageIndex)
  );
  if (visibleLayers.length === 0) {
    return null;
  }
  const scale = Math.max(1, Math.min(2, Math.sqrt(5_000_000 / (width * height))));
  const canvas = window.document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to create PDF annotation canvas");
  }
  context.scale(scale, scale);
  for (const layer of visibleLayers) {
    context.save();
    const whiteboard = layer.whiteboard;
    if (whiteboard?.bounds.pageIndex === pageIndex) {
      const bounds = whiteboard.bounds;
      const left = bounds.minX * width;
      const top = bounds.minY * height;
      const boardWidth = (bounds.maxX - bounds.minX) * width;
      const boardHeight = (bounds.maxY - bounds.minY) * height;
      context.beginPath();
      context.rect(left, top, boardWidth, boardHeight);
      context.clip();
      context.globalAlpha = layer.opacity;
      context.fillStyle = whiteboard.background;
      context.fillRect(left, top, boardWidth, boardHeight);
    }
    for (const image of layer.images ?? []) {
      if (image.pageIndex !== pageIndex) continue;
      if (image.mask.enabled) {
        context.fillStyle = image.mask.color;
        context.fillRect(
          image.sourceBounds.minX * width,
          image.sourceBounds.minY * height,
          (image.sourceBounds.maxX - image.sourceBounds.minX) * width,
          (image.sourceBounds.maxY - image.sourceBounds.minY) * height
        );
      }
      try {
        const bytes = await readImageAsset(app, image.assetPath);
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const drawWidth = image.transform.width * width;
        const drawHeight = image.transform.height * height;
        const centerX = image.transform.x * width + drawWidth / 2;
        const centerY = image.transform.y * height + drawHeight / 2;
        context.save();
        context.translate(centerX, centerY);
        context.rotate((image.transform.rotation * Math.PI) / 180);
        context.scale(image.transform.flipX ? -1 : 1, image.transform.flipY ? -1 : 1);
        context.drawImage(bitmap, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
        context.restore();
        bitmap.close();
      } catch (error) {
        console.error("HandLayers: failed to render exported image asset", error);
      }
    }
    for (const stroke of layer.strokes) {
      if (stroke.pageIndex === pageIndex) {
        drawCanvasStroke(context, stroke, width, height, layer.opacity);
      }
    }
    context.restore();
  }
  return canvasPng(canvas);
}

export async function exportAnnotatedPdf(
  app: App,
  source: TFile,
  document: AnnotationDocument
): Promise<PdfExportResult> {
  const sourceBytes = await app.vault.readBinary(source);
  const pdf = await PDFDocument.load(sourceBytes);
  const pages = pdf.getPages();
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const width = page.getWidth();
    const height = page.getHeight();
    const overlay = await renderPdfOverlay(app, document, index + 1, width, height);
    if (!overlay) {
      continue;
    }
    const image = await pdf.embedPng(overlay);
    page.drawImage(image, { x: 0, y: 0, width, height });
  }
  const directory = normalizePath(
    `${EXPORT_ROOT}/${exportTimestamp()}-${source.basename}`
  );
  await ensureFolder(app, directory);
  const path = normalizePath(`${directory}/${source.basename}-带批注.pdf`);
  const bytes = await pdf.save();
  const output = new Uint8Array(bytes.byteLength);
  output.set(bytes);
  await app.vault.adapter.writeBinary(path, output.buffer);
  return {
    path,
    excludedDraftWhiteboards: document.draftWhiteboards?.length ?? 0
  };
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDateTime(date = new Date()): { time: number; date: number } {
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date:
      ((Math.max(1980, date.getFullYear()) - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate()
  };
}

function buildZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const timestamp = zipDateTime();
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name.replace(/\\/g, "/"));
    const checksum = crc32(entry.data);
    const local = new Uint8Array(30 + name.length + entry.data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, timestamp.time, true);
    localView.setUint16(12, timestamp.date, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, entry.data.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(entry.data, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, timestamp.time, true);
    centralView.setUint16(14, timestamp.date, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, entry.data.length, true);
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const output = new Uint8Array(offset + centralSize + end.length);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    output.set(part, cursor);
    cursor += part.length;
  }
  return output;
}

function safeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\p{Cc}]/gu, "_").trim() || "未命名图层";
}

function singleLayerSvg(
  layer: AnnotationDocument["layers"][number],
  pageIndex?: number
): string {
  const opacity = layer.opacity > 0 ? layer.opacity : 1;
  const strokes = layer.strokes.filter((stroke) => stroke.pageIndex === pageIndex);
  let background = "";
  let definitions = "";
  let content = strokeSvg(strokes, opacity);
  if (layer.whiteboard?.bounds.pageIndex === pageIndex) {
    const bounds = layer.whiteboard.bounds;
    const x = bounds.minX * 1000;
    const y = bounds.minY * 1000;
    const width = (bounds.maxX - bounds.minX) * 1000;
    const height = (bounds.maxY - bounds.minY) * 1000;
    definitions = `<clipPath id="whiteboard"><rect x="${x}" y="${y}" width="${width}" height="${height}"/></clipPath>`;
    background = `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${xmlEscape(
      layer.whiteboard.background
    )}" opacity="${opacity}"/>`;
    content = `<g clip-path="url(#whiteboard)">${background}${content}</g>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" preserveAspectRatio="none" data-visible="${layer.visible}" data-opacity="${layer.opacity}"><defs>${definitions}</defs>${content}</svg>`;
}

export async function exportLayerPackage(
  app: App,
  source: TFile,
  document: AnnotationDocument
): Promise<LayerPackageExportResult> {
  const encoder = new TextEncoder();
  const exported = withoutDraftWhiteboards(document);
  const entries: ZipEntry[] = [
    {
      name: `原始文件/${source.name}`,
      data: new Uint8Array(await app.vault.readBinary(source))
    },
    {
      name: "图层数据/annotation.json",
      data: encoder.encode(JSON.stringify(exported, null, 2))
    }
  ];
  const includedAssets = new Set<string>();
  for (const layer of exported.layers) {
    for (const image of layer.images ?? []) {
      for (const path of [image.sourceAssetPath, image.assetPath]) {
        if (includedAssets.has(path)) continue;
        includedAssets.add(path);
        try {
          entries.push({
            name: `图片资源/${path.split("/").pop() ?? "image.png"}`,
            data: new Uint8Array(await readImageAsset(app, path))
          });
        } catch (error) {
          console.error("HandLayers: failed to add image asset to layer package", error);
        }
      }
    }
  }
  exported.layers.forEach((layer, index) => {
    const pages = new Set<number | undefined>();
    layer.strokes.forEach((stroke) => pages.add(stroke.pageIndex));
    if (layer.whiteboard) {
      pages.add(layer.whiteboard.bounds.pageIndex);
    }
    if (pages.size === 0) {
      pages.add(undefined);
    }
    const folder = `${String(index + 1).padStart(3, "0")}-${safeFileName(layer.name)}`;
    [...pages]
      .sort((a, b) => (a ?? 0) - (b ?? 0))
      .forEach((pageIndex) => {
        const name = pageIndex === undefined ? "标注.svg" : `第${pageIndex}页.svg`;
        entries.push({
          name: `图层/${folder}/${name}`,
          data: encoder.encode(singleLayerSvg(layer, pageIndex))
        });
      });
  });
  entries.push({
    name: "导出清单.json",
    data: encoder.encode(
      JSON.stringify(
        {
          format: "hand-note-layers-layer-package",
          formatVersion: 1,
          exportedAt: new Date().toISOString(),
          sourcePath: source.path,
          layerCount: exported.layers.length,
          layers: exported.layers.map((layer, index) => ({
            order: index + 1,
            id: layer.id,
            name: layer.name,
            visible: layer.visible,
            opacity: layer.opacity,
            whiteboard: Boolean(layer.whiteboard),
            imageCount: layer.images?.length ?? 0
          })),
          note: "图层包包含所有已保存图层；未保存的临时白板不会进入导出。"
        },
        null,
        2
      )
    )
  });
  const bytes = buildZip(entries);
  await ensureFolder(app, EXPORT_ROOT);
  const path = normalizePath(
    `${EXPORT_ROOT}/${exportTimestamp()}-${source.basename}-图层包.zip`
  );
  const output = new Uint8Array(bytes.byteLength);
  output.set(bytes);
  await app.vault.adapter.writeBinary(path, output.buffer);
  return {
    path,
    layerCount: exported.layers.length,
    excludedDraftWhiteboards: document.draftWhiteboards?.length ?? 0
  };
}

async function exportOne(
  app: App,
  source: TFile,
  document: AnnotationDocument,
  directory: string
): Promise<ExportedFileEntry> {
  const sourceCopy = normalizePath(`${directory}/源文件/${source.path}`);
  const annotationCopy = normalizePath(
    `${directory}/图层数据/${getAnnotationPath(source)}`
  );
  await ensureFolder(app, sourceCopy.split("/").slice(0, -1).join("/"));
  await ensureFolder(app, annotationCopy.split("/").slice(0, -1).join("/"));
  await app.vault.adapter.writeBinary(sourceCopy, await app.vault.readBinary(source));
  await app.vault.adapter.write(
    annotationCopy,
    JSON.stringify(withoutDraftWhiteboards(document), null, 2)
  );
  const flattenedCopies = await writeFlattenedCopies(
    app,
    source,
    document,
    directory
  );
  const imageAssetCopies: string[] = [];
  const copiedAssets = new Set<string>();
  for (const layer of document.layers) {
    for (const image of layer.images ?? []) {
      for (const assetPath of [image.sourceAssetPath, image.assetPath]) {
        if (copiedAssets.has(assetPath)) continue;
        copiedAssets.add(assetPath);
        try {
          const target = normalizePath(`${directory}/图片资源/${assetPath.split("/").pop() ?? "image.png"}`);
          await ensureFolder(app, target.split("/").slice(0, -1).join("/"));
          await app.vault.adapter.writeBinary(target, await readImageAsset(app, assetPath));
          imageAssetCopies.push(target);
        } catch (error) {
          console.error("HandLayers: failed to copy exported image asset", error);
        }
      }
    }
  }

  return {
    sourcePath: source.path,
    sourceCopy,
    annotationCopy,
    flattenedCopies,
    imageAssetCopies,
    layerCount: document.layers.length,
    visibleLayerCount: document.layers.filter(
      (layer) => layer.visible && layer.opacity > 0
    ).length,
    excludedDraftWhiteboards: document.draftWhiteboards?.length ?? 0
  };
}

async function writeManifest(
  app: App,
  directory: string,
  scope: "current-file" | "vault",
  files: ExportedFileEntry[]
): Promise<void> {
  await app.vault.adapter.write(
    normalizePath(`${directory}/导出清单.json`),
    JSON.stringify(
      {
        format: "hand-note-layers-export",
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        scope,
        note:
          "图层数据保留层级、顺序、可见性和透明度；未保存的临时白板不会进入导出。",
        files
      },
      null,
      2
    )
  );
}

export async function exportCurrentAnnotation(
  app: App,
  source: TFile
): Promise<AnnotationExportResult> {
  const directory = normalizePath(
    `${EXPORT_ROOT}/${exportTimestamp()}-${source.basename}`
  );
  await ensureFolder(app, directory);
  const entry = await exportOne(
    app,
    source,
    await loadAnnotation(app, source),
    directory
  );
  await writeManifest(app, directory, "current-file", [entry]);
  return {
    directory,
    exportedFiles: 1,
    excludedDraftWhiteboards: entry.excludedDraftWhiteboards
  };
}

export async function exportVaultAnnotations(
  app: App
): Promise<AnnotationExportResult> {
  const directory = normalizePath(`${EXPORT_ROOT}/${exportTimestamp()}-整个仓库`);
  await ensureFolder(app, directory);
  const entries: ExportedFileEntry[] = [];
  for (const source of app.vault.getFiles()) {
    if (source.extension !== "md" && source.extension !== "pdf") {
      continue;
    }
    if (!(await app.vault.adapter.exists(getAnnotationPath(source)))) {
      continue;
    }
    entries.push(
      await exportOne(app, source, await loadAnnotation(app, source), directory)
    );
  }
  await writeManifest(app, directory, "vault", entries);
  return {
    directory,
    exportedFiles: entries.length,
    excludedDraftWhiteboards: entries.reduce(
      (total, entry) => total + entry.excludedDraftWhiteboards,
      0
    )
  };
}

export async function exportVaultAnnotatedPdfs(
  app: App
): Promise<AnnotationExportResult> {
  let exportedFiles = 0;
  let excludedDraftWhiteboards = 0;
  for (const source of app.vault.getFiles()) {
    if (
      source.extension !== "pdf" ||
      !(await app.vault.adapter.exists(getAnnotationPath(source)))
    ) {
      continue;
    }
    const result = await exportAnnotatedPdf(app, source, await loadAnnotation(app, source));
    exportedFiles += 1;
    excludedDraftWhiteboards += result.excludedDraftWhiteboards;
  }
  return {
    directory: EXPORT_ROOT,
    exportedFiles,
    excludedDraftWhiteboards
  };
}

export async function exportVaultLayerPackages(
  app: App
): Promise<AnnotationExportResult> {
  let exportedFiles = 0;
  let excludedDraftWhiteboards = 0;
  for (const source of app.vault.getFiles()) {
    if (
      (source.extension !== "md" && source.extension !== "pdf") ||
      !(await app.vault.adapter.exists(getAnnotationPath(source)))
    ) {
      continue;
    }
    const result = await exportLayerPackage(app, source, await loadAnnotation(app, source));
    exportedFiles += 1;
    excludedDraftWhiteboards += result.excludedDraftWhiteboards;
  }
  return {
    directory: EXPORT_ROOT,
    exportedFiles,
    excludedDraftWhiteboards
  };
}
