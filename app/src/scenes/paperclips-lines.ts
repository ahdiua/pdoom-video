/** Renderer-independent spark segments. Shared by both Paperclips backends. */
export class PaperclipLines {
  // A.xy, B.xy, width, padding, padding, padding, linear RGBA.
  readonly data: Float32Array;
  count = 0;
  constructor(readonly capacity = 3000) { this.data = new Float32Array(capacity * 12); }
  clear() { this.count = 0; }
  seg2(ax: number, ay: number, bx: number, by: number, width: number, color: [number, number, number], alpha = 1) {
    if (this.count >= this.capacity) return;
    const i = this.count++ * 12;
    this.data.set([ax, ay, bx, by, width, 0, 0, 0, ...color, alpha], i);
  }
}
