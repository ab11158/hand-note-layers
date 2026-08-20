import { App, TFile, normalizePath } from "obsidian";
import {
  AnnotationImage,
  AnnotationDocument,
  createEmptyDocument,
  getActiveLayer
} from "../model/annotation";

const ANNOTATION_ROOT = ".hand-note-layers";
const saveQueues = new Map<string, Promise<void>>();

function migrateImage(image: Partial<AnnotationImage>): AnnotationImage | null {
  if (
    typeof image.id !== "string" ||
    typeof image.sourceAssetPath !== "string" ||
    typeof image.assetPath !== "string" ||
    !image.sourceBounds ||
    !image.transform
  ) {
    return null;
  }
  return {
    id: image.id,
    sourceAssetPath: image.sourceAssetPath,
    assetPath: image.assetPath,
    pageIndex: image.pageIndex,
    sourceBounds: image.sourceBounds,
    pixelWidth: Math.max(1, image.pixelWidth ?? 1),
    pixelHeight: Math.max(1, image.pixelHeight ?? 1),
    transform: {
      x: image.transform.x ?? image.sourceBounds.minX,
      y: image.transform.y ?? image.sourceBounds.minY,
      width: image.transform.width ?? image.sourceBounds.maxX - image.sourceBounds.minX,
      height: image.transform.height ?? image.sourceBounds.maxY - image.sourceBounds.minY,
      rotation: image.transform.rotation ?? 0,
      flipX: image.transform.flipX ?? false,
      flipY: image.transform.flipY ?? false
    },
    mask: {
      enabled: image.mask?.enabled ?? true,
      color: image.mask?.color ?? "#ffffff"
    },
    operations: Array.isArray(image.operations) ? image.operations : []
  };
}

export function getAnnotationPath(source: TFile): string {
  return normalizePath(`${ANNOTATION_ROOT}/${source.path}.json`);
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const parts = path.split("/").slice(0, -1);
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

function migrateTool(tool: unknown): AnnotationDocument["layers"][number]["strokes"][number]["tool"] {
  if (
    tool === "pen" ||
    tool === "pencil" ||
    tool === "highlighter" ||
    tool === "eraser" ||
    tool === "text" ||
    tool === "shape"
  ) {
    return tool;
  }
  return "pen";
}

function migrateDocument(value: unknown, sourcePath: string): AnnotationDocument {
  const candidate = value as Partial<AnnotationDocument>;

  if (!candidate || !Array.isArray(candidate.layers)) {
    return createEmptyDocument(sourcePath);
  }

  const document: AnnotationDocument = {
    schemaVersion: 2,
    sourcePath: candidate.sourcePath ?? sourcePath,
    layers: candidate.layers.map((layer) => ({
      id: layer.id,
      name:
        typeof layer.name === "string"
          ? layer.name.replace(/^图层\s+(\d+)$/, "图层$1")
          : "图层1",
      visible: layer.visible ?? true,
      opacity: layer.opacity ?? 1,
      lastNonZeroOpacity:
        layer.lastNonZeroOpacity ?? ((layer.opacity ?? 1) > 0 ? layer.opacity ?? 1 : 1),
      whiteboard: layer.whiteboard,
      images: Array.isArray(layer.images)
        ? (layer.images
            .map((image) => migrateImage(image))
            .filter(Boolean) as AnnotationImage[])
        : [],
      strokes: Array.isArray(layer.strokes)
        ? layer.strokes.map((stroke) => ({
            id: stroke.id,
            tool: migrateTool(stroke.tool),
            color: stroke.color ?? "#1f2937",
            size: stroke.size ?? 4,
            opacity:
              stroke.opacity ?? (stroke.tool === "highlighter" ? 0.32 : undefined),
            points: Array.isArray(stroke.points)
              ? stroke.points.map((point) => ({
                  x: point.x,
                  y: point.y,
                  pressure: point.pressure ?? 0.5
                }))
              : [],
            pageIndex: stroke.pageIndex,
            shape: stroke.shape,
            lineStyle: stroke.lineStyle,
            startArrow: stroke.startArrow,
            endArrow: stroke.endArrow,
            fillColor: stroke.fillColor,
            fillOpacity: stroke.fillOpacity,
            closed: stroke.closed,
            locked: stroke.locked,
            groupId: stroke.groupId,
            startConnection: stroke.startConnection,
            endConnection: stroke.endConnection,
            text: stroke.text,
            fontSize: stroke.fontSize
          }))
        : []
    })),
    activeLayerId: candidate.activeLayerId ?? candidate.layers[0]?.id ?? "",
    updatedAt: candidate.updatedAt ?? Date.now(),
    draftWhiteboards: Array.isArray(candidate.draftWhiteboards)
      ? candidate.draftWhiteboards.map((draft) => ({
          ...draft,
          images: Array.isArray(draft.images)
            ? (draft.images
                .map((image) => migrateImage(image))
                .filter(Boolean) as AnnotationImage[])
            : []
        }))
      : []
  };
  getActiveLayer(document);
  return document;
}

export async function loadAnnotation(
  app: App,
  source: TFile
): Promise<AnnotationDocument> {
  const path = getAnnotationPath(source);

  if (!(await app.vault.adapter.exists(path))) {
    return createEmptyDocument(source.path);
  }

  try {
    const raw = await app.vault.adapter.read(path);
    return migrateDocument(JSON.parse(raw), source.path);
  } catch (error) {
    console.error("Hand Note Layers: failed to load annotation", error);
    return createEmptyDocument(source.path);
  }
}

export async function saveAnnotation(
  app: App,
  source: TFile,
  document: AnnotationDocument
): Promise<void> {
  const path = getAnnotationPath(source);
  document.updatedAt = Date.now();
  const snapshot = JSON.stringify(document);
  const previous = saveQueues.get(path) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await ensureFolder(app, path);
      await app.vault.adapter.write(path, snapshot);
    });

  saveQueues.set(path, next);
  try {
    await next;
  } finally {
    if (saveQueues.get(path) === next) {
      saveQueues.delete(path);
    }
  }
}

export async function deleteAnnotation(app: App, source: TFile): Promise<void> {
  const path = getAnnotationPath(source);
  await saveQueues.get(path)?.catch(() => undefined);
  if (await app.vault.adapter.exists(path)) {
    await app.vault.adapter.remove(path);
  }
}
