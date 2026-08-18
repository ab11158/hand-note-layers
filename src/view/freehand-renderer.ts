import { getStroke } from "perfect-freehand";
import type { AnnotationStroke } from "../model/annotation";
import type { InkCanvasViewport } from "./ink-canvas";

export function drawFreehandStroke(
  context: CanvasRenderingContext2D,
  stroke: AnnotationStroke,
  viewport: InkCanvasViewport,
  pressureEnabled: boolean
): void {
  const input = stroke.points.map(
    (point) =>
      [
        point.x * viewport.documentWidth - viewport.offsetX,
        point.y * viewport.documentHeight - viewport.offsetY,
        point.pressure
      ] as [number, number, number]
  );
  if (input.length === 0) {
    return;
  }

  const outline = getStroke(input, {
    size: stroke.size,
    thinning: pressureEnabled ? (stroke.tool === "pencil" ? 0.72 : 0.58) : 0,
    smoothing: stroke.tool === "pencil" ? 0.46 : 0.56,
    streamline: stroke.tool === "pencil" ? 0.2 : 0.28,
    simulatePressure: false,
    easing: (pressure) => pressure,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 }
  });
  if (outline.length === 0) {
    return;
  }

  context.beginPath();
  context.moveTo(outline[0][0], outline[0][1]);
  for (let index = 1; index < outline.length; index += 1) {
    const current = outline[index];
    const next = outline[(index + 1) % outline.length];
    context.quadraticCurveTo(
      current[0],
      current[1],
      (current[0] + next[0]) / 2,
      (current[1] + next[1]) / 2
    );
  }
  context.closePath();
  context.fill();
}
