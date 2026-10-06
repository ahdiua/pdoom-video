// "Without a single CDR": the memory the roadmap planned for, drawn in world units on the same
// drawing sheet as the roadmap (north of it). It is the companion of the bureau's von Neumann
// figure: the other legacy architecture, a Lisp machine's list structure. The lyric is the list
// (Without a single ...) as a box-and-pointer diagram: one cons cell per word, the car pointing
// down at the word (lit as it is sung), the cdr pointing on to the rest of the list. The spark is
// the pointer x, chasing the cdrs from cell to cell on the words. The last cell's cdr field is
// missing: an empty dashed box whose name is sung letter by letter. Then the collector reclaims
// every cell, and the empty field ends as the prompt's caret.
import { Lyrics, type Word } from '../engine/lyrics';
import { rgba } from '../engine/palette';
import { F, font } from '../engine/type';
import { ease, lerp, prog } from '../engine/util';

export const LIST = {
  GX: 700, // x of song time t0 ("Without")
  V: 480, // world units per second (the camera's tracking rate)
  GL: 700, // y of the spine (the row of cells)
  DS: 38, // half-size of one field of a cell
  PITCH: 300, // cell to cell
  ROW: [346, 456, 566], // baseline of the atoms below the spine, nearest first (the last word is nearest)
  WORD: 112, // lyric type size
};

export interface ListTimes {
  t0: number; // time at x = GX
  words: Word[]; // Without, a, single: one cons cell each
  cdr: Word;
  syl: number[]; // C, D, R
  gc: number; // the cells are reclaimed
  beat: number; // beat length (the empty field blinks on the half beat)
  end: number;
}

/** x, (cdr x), (cddr x), ...: the spine pointer after n hops. */
const spine = (n: number) => (n === 0 ? 'x' : `(c${'d'.repeat(n)}r x)`);
/** (car x), (cadr x), (caddr x): the nth element. */
const nth = (n: number) => `(ca${'d'.repeat(n)}r x)`;

type DrawOpts = { alpha: number; keep: number; morph: number; caret: { hw: number; hh: number } };

export class ConsList {
  constructor(public T: ListTimes, public pdoom: string) {}
  X(t: number) { return LIST.GX + (t - this.T.t0) * LIST.V; }
  /** The missing cdr field of the last cell. */
  get slot() { return { x: this.X(this.T.cdr.start), y: LIST.GL }; }
  /** x of the divider between the car and cdr fields of cell i. */
  cellX(i: number) { return this.slot.x - LIST.DS - (this.T.words.length - 1 - i) * LIST.PITCH; }
  carX(i: number) { return this.cellX(i) - LIST.DS; }
  rowY(i: number) { return LIST.GL + LIST.ROW[this.T.words.length - 1 - i]!; }
  /** The variable x, left of the first cell. */
  get rootX() { return this.cellX(0) - 2 * LIST.DS - 170; }
  /** When cell i is reclaimed: last cell first. */
  tGc(i: number) { return this.T.gc + (this.T.words.length - 1 - i) * 0.07; }

  /** The pointer's x: it lands on each cell as its word starts, then presses against the missing field. */
  playX(t: number) {
    const T = this.T, ws = T.words;
    let x = lerp(this.rootX, this.carX(0), ease.outCubic(prog(t, T.t0 - 0.3, T.t0)));
    for (let i = 1; i < ws.length; i++) {
      const arr = ws[i]!.start, dep = Math.max(ws[i - 1]!.start + 0.02, arr - 0.16);
      if (t > dep) x = lerp(this.carX(i - 1), this.carX(i), ease.inOutCubic(prog(t, dep, arr)));
    }
    const t1 = T.cdr.start;
    if (t > t1 - 0.12) x = lerp(this.carX(ws.length - 1), this.slot.x - LIST.DS - 10, ease.outCubic(prog(t, t1 - 0.12, t1)));
    return x;
  }

  /**
   * Draw in world units (the caller set the world transform). `px` = world units per screen px.
   * `keep` fades everything except the missing field (the hand-off); `morph` turns it into the caret.
   */
  draw(c: CanvasRenderingContext2D, t: number, px: number, o: DrawOpts) {
    const T = this.T, G = LIST;
    const A = o.alpha * o.keep;
    const L = G.GL;
    c.save();
    c.textBaseline = 'alphabetic';
    c.lineCap = 'butt';
    if (A > 0.002) {
      c.globalAlpha = A;
      // title: the planned memory, filed like the bureau's appendix of legacy architectures
      const x0 = this.X(T.t0 - 0.45);
      c.textAlign = 'left';
      c.font = font(F.mono(600), 26); c.fillStyle = rgba('bone', 0.95);
      c.fillText('DETAIL D — MEMORY, AS PLANNED', x0, L - 178);
      c.font = font(F.mono(400), 18); c.fillStyle = rgba('ash', 0.9);
      c.fillText('LISP MACHINE (1979) · LEGACY ARCHITECTURE · FOR REFERENCE ONLY', x0, L - 152);
      this.drawRoot(c, px);
      T.words.forEach((w, i) => this.drawCell(c, t, px, w, i));
      this.drawPointer(c, t, px);
      // the collector's report and the P(doom) cameo, filed in the legend: always within tolerance
      const la = prog(t, T.gc + 0.05, T.gc + 0.25);
      if (la > 0) {
        c.globalAlpha = A * la;
        const lx = this.slot.x, ly = L + 500;
        c.font = font(F.mono(400), 24); c.fillStyle = rgba('ash', 1); c.textAlign = 'left';
        c.fillText(`GC: ${T.words.length} cells reclaimed · 0 in use`, lx + 44, ly);
        c.strokeStyle = rgba('ash', 1); c.lineWidth = 2 * px;
        c.strokeRect(lx, ly + 24, 26, 26);
        c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = 3.5 * px;
        c.beginPath(); c.moveTo(lx + 6, ly + 37); c.lineTo(lx + 11, ly + 43); c.lineTo(lx + 21, ly + 29); c.stroke();
        c.lineCap = 'butt';
        c.fillText(`P(doom) ${this.pdoom} · within tolerance (±1.00)`, lx + 44, ly + 46);
      }
    }
    c.globalAlpha = o.alpha;
    this.drawSlot(c, t, px, o);
    c.restore();
  }

  private arrow(c: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, head = true) {
    const a = Math.atan2(y1 - y0, x1 - x0), h = 16;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1 - (head ? h * 0.6 * Math.cos(a) : 0), y1 - (head ? h * 0.6 * Math.sin(a) : 0)); c.stroke();
    if (!head) return;
    c.fillStyle = c.strokeStyle;
    c.beginPath(); c.moveTo(x1, y1);
    c.lineTo(x1 - h * Math.cos(a - 0.42), y1 - h * Math.sin(a - 0.42));
    c.lineTo(x1 - h * Math.cos(a + 0.42), y1 - h * Math.sin(a + 0.42));
    c.closePath(); c.fill();
  }

  /** The variable x and its pointer into the first cell. */
  private drawRoot(c: CanvasRenderingContext2D, px: number) {
    const G = LIST, y = G.GL, x = this.rootX;
    c.strokeStyle = rgba('ash', 0.9); c.lineWidth = 2 * px;
    c.strokeRect(x - 22, y - 22, 44, 44);
    c.textAlign = 'center';
    c.font = font(F.mono(600), 26); c.fillStyle = rgba('bone', 0.95);
    c.fillText('x', x, y + 8);
    this.arrow(c, x + 22, y, this.cellX(0) - 2 * G.DS - 4, y);
    c.textAlign = 'left';
  }

  /** One cons cell: car field (pointing down at its word), cdr field (pointing at the next cell). */
  private drawCell(c: CanvasRenderingContext2D, t: number, px: number, w: Word, i: number) {
    const T = this.T, G = LIST;
    const n = T.words.length, last = i === n - 1;
    const y = G.GL, r = G.DS, xd = this.cellX(i), xc = this.carX(i);
    const ga = c.globalAlpha;
    const p = Lyrics.wordProgress(w, t);
    const vis = prog(t, w.start - 0.35, w.start - 0.05);
    const eg = t - this.tGc(i), dead = eg >= 0;
    const dash = () => c.setLineDash(dead ? [8, 7] : []);

    // cdr pointer along the spine: planned in ash, bone once followed
    if (!last) {
      const went = t >= T.words[i + 1]!.start;
      c.strokeStyle = dead ? rgba('graphite', 0.9) : rgba(went ? 'bone' : 'ash', 0.9); c.lineWidth = 2.5 * px;
      dash();
      this.arrow(c, xd + r, y, this.cellX(i + 1) - 2 * r - 4, y);
      c.setLineDash([]);
    }
    // car pointer down to the atom: planned in graphite, drawn hot as the word starts
    const ya = y + r, yb = this.rowY(i) - 100;
    c.lineWidth = 2.5 * px;
    c.strokeStyle = rgba('graphite', 0.9);
    dash();
    this.arrow(c, xc, ya, xc, yb);
    if (p > 0 && !dead) {
      const k = ease.outCubic(prog(t, w.start - 0.02, w.start + 0.12));
      c.strokeStyle = p < 1 ? rgba('signal', 1) : rgba('ash', 0.95);
      this.arrow(c, xc, ya, xc, lerp(ya, yb, k), k > 0.95);
    }
    c.setLineDash([]);

    // the fields (the last cell's cdr field is the slot, drawn apart)
    const x0 = xd - 2 * r, wd = last ? 2 * r : 4 * r;
    c.fillStyle = rgba('ink', 1);
    c.fillRect(x0, y - r, wd, 2 * r);
    if (dead) { c.fillStyle = rgba('ember', Math.pow(0.5, eg / 0.06)); c.fillRect(x0, y - r, wd, 2 * r); }
    c.lineJoin = 'miter';
    c.strokeStyle = dead ? rgba('ash', 0.6) : rgba('bone', 0.95); c.lineWidth = 3 * px;
    dash();
    c.strokeRect(x0, y - r, wd, 2 * r);
    if (!last) { c.beginPath(); c.moveTo(xd, y - r); c.lineTo(xd, y + r); c.stroke(); }
    c.setLineDash([]);
    c.textAlign = 'center';
    if (dead) {
      // reclaimed: a ring off the cell, the stamp above it
      const ra = 1 - prog(eg, 0.05, 0.35);
      if (ra > 0) {
        const q = 1 + 1.6 * ease.outCubic(prog(eg, 0, 0.35));
        c.strokeStyle = rgba('signal', ra); c.lineWidth = 2 * px;
        c.strokeRect(x0 + wd / 2 - (wd / 2) * q, y - r * q, wd * q, 2 * r * q);
      }
      c.font = font(F.mono(500), 18); c.fillStyle = rgba('ash', prog(eg, 0, 0.05));
      c.fillText('RECLAIMED', x0 + wd / 2, y - r - 14);
    } else {
      // pointer dots: the car's lights while its word is sung
      const k = t >= w.start ? 1 + 0.6 * Math.pow(0.5, (t - w.start) / 0.05) : 1;
      c.fillStyle = p <= 0 ? rgba('ash', 0.9) : p < 1 ? rgba('signal', 1) : rgba('bone', 1);
      c.beginPath(); c.arc(xc, y, 7 * k, 0, Math.PI * 2); c.fill();
      c.font = font(F.mono(500), 16); c.fillStyle = rgba('graphite', 1);
      c.fillText('car', xc, y - r - 12);
      if (!last) {
        c.fillText('cdr', xd + r, y - r - 12);
        c.fillStyle = rgba('bone', 0.95);
        c.beginPath(); c.arc(xd + r, y, 7, 0, Math.PI * 2); c.fill();
      }
    }

    // the atom: dim until sung, signal while sung, bone after; slams a hair on its start
    if (vis > 0) {
      const by = this.rowY(i);
      const k = t >= w.start ? 1 + 0.12 * Math.pow(0.5, (t - w.start) / 0.05) : 1;
      c.save();
      c.translate(xc - 14, by); c.scale(k, k);
      c.font = font(F.archivo(100, 900), G.WORD);
      c.fillStyle = p <= 0 ? rgba('bone', 0.2 * vis) : p < 1 ? rgba('signal', 1) : rgba('bone', 1);
      c.textAlign = 'left';
      c.fillText(w.w, -6, 0);
      c.restore();
      // how to reach it, in mono, under the word
      c.textAlign = 'left';
      c.font = font(F.mono(400), 18); c.fillStyle = rgba('graphite', vis);
      c.fillText(nth(i), xc - 14, by + 30);
    }
    c.textAlign = 'left';
    c.globalAlpha = ga;
  }

  /** The pointer's flag: the expression that reaches the cell the spark is on. */
  private drawPointer(c: CanvasRenderingContext2D, t: number, px: number) {
    const T = this.T, G = LIST;
    const a = prog(t, T.t0 - 0.3, T.t0) * (1 - prog(t, T.gc - 0.2, T.gc));
    if (a <= 0) return;
    const x = this.playX(t);
    const ga = c.globalAlpha;
    c.globalAlpha = ga * a;
    const top = G.GL - 100;
    c.fillStyle = rgba('signal', 0.85);
    c.fillRect(x - 1 * px, top, 2 * px, 100 - G.DS - 4);
    const hops = t >= T.cdr.start ? T.words.length : Math.max(0, T.words.filter((w) => t >= w.start).length - 1);
    const txt = spine(hops);
    c.font = font(F.mono(600), 20); c.textAlign = 'left';
    const tw = c.measureText(txt).width;
    c.fillStyle = rgba('signal', 1);
    c.fillRect(x, top - 34, tw + 18, 34);
    c.fillStyle = rgba('ink', 1);
    c.fillText(txt, x + 9, top - 10);
    c.globalAlpha = ga;
  }

  /** The missing cdr field: dashed, blinking, its name lit letter by letter as sung; finally the caret. */
  private drawSlot(c: CanvasRenderingContext2D, t: number, px: number, o: DrawOpts) {
    const T = this.T, G = LIST;
    const { x, y } = this.slot;
    const r = G.DS;
    const since = t - T.cdr.start;
    const blinkOn = since < 0 || Math.floor(since / (T.beat / 2)) % 2 === 0;
    const m = o.morph;
    const keep = o.keep;
    // field outline (dashed), morphing into the caret
    const hw = lerp(r, o.caret.hw, m), hh = lerp(r, o.caret.hh, m);
    c.beginPath();
    c.rect(x - hw, y - hh, 2 * hw, 2 * hh);
    if (m > 0) { c.fillStyle = rgba('signal', 0.9 * ease.inQuad(m)); c.fill(); }
    const hot = since >= 0;
    c.setLineDash(m > 0.5 ? [] : [12, lerp(9, 0, m * 2)]);
    c.lineJoin = 'miter';
    c.strokeStyle = hot ? rgba('signal', (blinkOn ? 1 : 0.3) * (1 - m)) : rgba('ash', 0.9);
    c.lineWidth = 3 * px;
    c.stroke();
    c.setLineDash([]);
    // labels fade with the rest
    c.globalAlpha = o.alpha * keep;
    if (keep <= 0.002) return;
    c.textAlign = 'center';
    // before it is sung: a field label like the others; then the lyric, large, beside it
    const big = ease.outExpo(prog(since, 0, 0.14));
    if (big < 1) {
      c.font = font(F.mono(500), 16); c.fillStyle = rgba('graphite', 1 - big);
      c.fillText('cdr', x, y - r - 12);
    }
    if (since >= 0) {
      const size = 150;
      c.font = font(F.mono(700), size);
      const wch = c.measureText('C').width;
      const lx = x + r + 44, base = y + size * 0.36;
      c.textAlign = 'center';
      ['C', 'D', 'R'].forEach((ch, k) => {
        const ts = T.syl[k]!;
        const lit = t >= ts;
        const pop = (lit ? 1 + 0.3 * Math.pow(0.5, (t - ts) / 0.05) : 1) * lerp(0.3, 1, big);
        c.save();
        c.translate(lx + wch * (k + 0.5), base - size * 0.36); c.scale(pop, pop);
        c.fillStyle = lit ? rgba('signal', 1) : rgba('bone', 0.3);
        c.fillText(ch, 0, size * 0.36);
        c.restore();
      });
      c.textAlign = 'left';
      c.font = font(F.mono(700), 64); c.fillStyle = rgba('signal', big);
      c.fillText('*', lx + wch * 3 + 4, base - size * 0.5);
      // status and footnote
      const sa = prog(t, T.syl[1]! - 0.02, T.syl[1]! + 0.05);
      c.font = font(F.mono(600), 26); c.fillStyle = rgba('signal', sa);
      c.fillText('STATUS: NOT ALLOCATED', lx + 6, base + 52);
      const fa = prog(t, T.syl[0]! + 0.3, T.syl[0]! + 0.45);
      c.font = font(F.mono(400), 22); c.fillStyle = rgba('ash', fa);
      c.fillText('* CDR: the rest of the list', lx + 6, base + 92);
    }
    c.textAlign = 'left';
  }
}
