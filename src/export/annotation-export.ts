import { App, TFile, normalizePath } from "obsidian";
import { PDFDocument } from "pdf-lib";
import { AnnotationDocument, cloneDocument } from "../model/annotation";
import { getAnnotationPath, loadAnnotation } from "../storage/annotation-store";
import { drawFreehandStroke } from "../view/freehand-renderer";

const EXPORT_ROOT = "Hand Note Layers 导出";

export interface AnnotationExportResult {
  directory: string;
  exportedFiles: number;
  excludedDraftWhiteboards: number;
}

export interface PdfExportResult {
  path: string;
  excludedDraftWhiteboards: number;
}

interface ExportedFileEntry {
  sourcePath: string;
  sourceCopy: string;
  annotationCopy: string;
  flattenedCopies: string[];
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
    const overlay = await renderPdfOverlay(document, index + 1, width, height);
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

  return {
    sourcePath: source.path,
    sourceCopy,
    annotationCopy,
    flattenedCopies,
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
