export type AnnotationTool =
  | "hand"
  | "pen"
  | "pencil"
  | "highlighter"
  | "eraser"
  | "select"
  | "text"
  | "shape";

export type ShapeKind =
  | "line"
  | "polyline"
  | "rectangle"
  | "ellipse"
  | "circle"
  | "curve"
  | "triangle"
  | "right-triangle"
  | "diamond"
  | "parallelogram"
  | "trapezoid"
  | "pentagon"
  | "hexagon"
  | "star"
  | "connector-straight"
  | "connector-elbow"
  | "connector-curve";

export type ShapeLineStyle = "solid" | "dashed" | "dotted";
export type ShapeArrowHead = "none" | "arrow" | "circle" | "diamond";
export type ShapeConnectionEdge = "top" | "right" | "bottom" | "left";

export interface ShapeConnection {
  strokeId: string;
  edge: ShapeConnectionEdge;
  ratio: number;
}

export type EraserMode = "partial" | "stroke";
export type SelectionMode = "all" | "rectangle" | "free";

export interface AnnotationBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  pageIndex?: number;
}

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
  shape?: ShapeKind;
  lineStyle?: ShapeLineStyle;
  startArrow?: ShapeArrowHead;
  endArrow?: ShapeArrowHead;
  fillColor?: string;
  fillOpacity?: number;
  closed?: boolean;
  locked?: boolean;
  groupId?: string;
  startConnection?: ShapeConnection;
  endConnection?: ShapeConnection;
  text?: string;
  fontSize?: number;
}

export interface AnnotationLayer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  lastNonZeroOpacity?: number;
  strokes: AnnotationStroke[];
  whiteboard?: {
    bounds: AnnotationBounds;
    background: string;
  };
}

export interface WhiteboardDraft {
  id: string;
  name: string;
  bounds: { left: number; top: number; width: number; height: number };
  hostWidth: number;
  hostHeight: number;
  virtualWidth: number;
  virtualHeight: number;
  panX: number;
  panY: number;
  pageIndex?: number;
  strokes: AnnotationStroke[];
  updatedAt: number;
}

export interface AnnotationDocument {
  schemaVersion: 1;
  sourcePath: string;
  layers: AnnotationLayer[];
  activeLayerId: string;
  updatedAt: number;
  draftWhiteboards?: WhiteboardDraft[];
}

export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createEmptyDocument(sourcePath: string): AnnotationDocument {
  const layer = createLayer("图层1");
  return {
    schemaVersion: 1,
    sourcePath,
    layers: [layer],
    activeLayerId: layer.id,
    updatedAt: Date.now(),
    draftWhiteboards: []
  };
}

export function createLayer(name: string): AnnotationLayer {
  return {
    id: generateId(),
    name,
    visible: true,
    opacity: 1,
    lastNonZeroOpacity: 1,
    strokes: []
  };
}

export function nextLayerName(document: AnnotationDocument): string {
  let maximum = 0;
  for (const layer of document.layers) {
    const match = /^图层\s*(\d+)$/.exec(layer.name);
    if (match) {
      maximum = Math.max(maximum, Number(match[1]));
    }
  }
  return `图层${maximum + 1}`;
}

export function cloneDocument(document: AnnotationDocument): AnnotationDocument {
  return JSON.parse(JSON.stringify(document)) as AnnotationDocument;
}

export function getActiveLayer(document: AnnotationDocument): AnnotationLayer {
  const active = document.layers.find(
    (layer) => layer.id === document.activeLayerId && !layer.whiteboard
  );
  if (active) {
    active.visible = true;
    if (active.opacity <= 0) {
      active.opacity = active.lastNonZeroOpacity ?? 1;
    }
    return active;
  }

  let editable = document.layers.find((layer) => !layer.whiteboard);
  if (!editable) {
    editable = createLayer(nextLayerName(document));
    document.layers.push(editable);
  }
  editable.visible = true;
  if (editable.opacity <= 0) {
    editable.opacity = editable.lastNonZeroOpacity ?? 1;
  }
  document.activeLayerId = editable.id;
  return editable;
}
