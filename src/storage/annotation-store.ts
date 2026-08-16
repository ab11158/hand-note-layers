import { App, TFile, normalizePath } from "obsidian";
import {
  AnnotationDocument,
  createEmptyDocument
} from "../model/annotation";

const ANNOTATION_ROOT = ".hand-note-layers";

export function getAnnotationPath(source: TFile): string {
  return normalizePath(`${ANNOTATION_ROOT}/${source.path}.json`);
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await app.vault.adapter.exists(current))) {
      await app.vault.adapter.mkdir(current);
    }
  }
}

function migrateDocument(value: unknown, sourcePath: string): AnnotationDocument {
  const candidate = value as Partial<AnnotationDocument>;

  if (!candidate || !Array.isArray(candidate.layers)) {
    return createEmptyDocument(sourcePath);
  }

  return {
    schemaVersion: 1,
    sourcePath: candidate.sourcePath ?? sourcePath,
    layers: candidate.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      visible: layer.visible ?? true,
      opacity: layer.opacity ?? 1,
      strokes: Array.isArray(layer.strokes)
        ? layer.strokes.map((stroke) => ({
            id: stroke.id,
            tool: stroke.tool === "eraser" ? "eraser" : "pen",
            color: stroke.color ?? "#1f2937",
            size: stroke.size ?? 4,
            points: Array.isArray(stroke.points)
              ? stroke.points.map((point) => ({
                  x: point.x,
                  y: point.y,
                  pressure: point.pressure ?? 0.5
                }))
              : [],
            pageIndex: stroke.pageIndex
          }))
        : []
    })),
    activeLayerId: candidate.activeLayerId ?? candidate.layers[0]?.id ?? "",
    updatedAt: candidate.updatedAt ?? Date.now()
  };
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
  await ensureFolder(app, path);
  document.updatedAt = Date.now();
  await app.vault.adapter.write(path, JSON.stringify(document, null, 2));
}

export async function deleteAnnotation(app: App, source: TFile): Promise<void> {
  const path = getAnnotationPath(source);
  if (await app.vault.adapter.exists(path)) {
    await app.vault.adapter.remove(path);
  }
}
