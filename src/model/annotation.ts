export type AnnotationTool =
  | "hand"
  | "pen"
  | "pencil"
  | "highlighter"
  | "eraser"
  | "select";

export type EraserMode = "partial" | "stroke";

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
}

export interface AnnotationStroke {
  id: string;
  tool: AnnotationTool;
  color: string;
  size: number;
  opacity?: number;
  points: StrokePoint[];
  pageIndex?: number;
}

export interface AnnotationLayer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  strokes: AnnotationStroke[];
}

export interface AnnotationDocument {
  schemaVersion: 1;
  sourcePath: string;
  layers: AnnotationLayer[];
  activeLayerId: string;
  updatedAt: number;
}

export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createEmptyDocument(sourcePath: string): AnnotationDocument {
  const layer = createLayer("图层 1");
  return {
    schemaVersion: 1,
    sourcePath,
    layers: [layer],
    activeLayerId: layer.id,
    updatedAt: Date.now()
  };
}

export function createLayer(name: string): AnnotationLayer {
  return {
    id: generateId(),
    name,
    visible: true,
    opacity: 1,
    strokes: []
  };
}

export function cloneDocument(document: AnnotationDocument): AnnotationDocument {
  return JSON.parse(JSON.stringify(document)) as AnnotationDocument;
}

export function getActiveLayer(document: AnnotationDocument): AnnotationLayer {
  return (
    document.layers.find((layer) => layer.id === document.activeLayerId) ??
    document.layers[0]
  );
}
