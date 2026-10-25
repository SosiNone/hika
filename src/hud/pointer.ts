/**
 * An arrowhead centred on (x, y), pointing along `angle` (screen radians): filled, or outlined for
 * a secondary cursor. The charts, the scrubber (as CSS) and the map all use this one shape.
 */
export function pointer(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, color: string, fill = true, scale = 1) {
  const cos = Math.cos(angle) * scale, sin = Math.sin(angle) * scale;
  ctx.beginPath();
  for (const [d, side] of [[5.5, 0], [-4, 4], [-1.5, 0], [-4, -4]]) ctx.lineTo(x + cos * d - sin * side, y + sin * d + cos * side);
  ctx.closePath();
  ctx.lineJoin = 'round';
  if (fill) { ctx.fillStyle = color; ctx.fill(); } else { ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke(); }
  ctx.lineJoin = 'miter';
}
