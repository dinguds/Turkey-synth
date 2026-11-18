// omr.js — rough optical music recognition for printed sheet music.
//
// Pipeline: grayscale -> adaptive threshold -> deskew -> find 5-line staves -> erase staff lines ->
// connected components -> per staff: clef, key signature, noteheads (filled + hollow), stems/beams/flags,
// dots, accidentals, rests, barlines, slurs/ties -> pitches + rhythm -> notes in 16th-note steps.
//
// It is heuristic and tuned for clean printed music (one voice per staff, treble or bass clef).
// Everything is measured in units of the staff spacing `sp` so it works at different image sizes.
(function (global) {
  'use strict';

  const STEP_DIATONIC = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
  const LETTERS = 'CDEFGAB';
  const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B (as letter indexes)
  const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F
  const SHARP_KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
  const FLAT_KEYS = ['C', 'F', 'B♭', 'E♭', 'A♭', 'D♭', 'G♭', 'C♭'];

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const argmax = (arr, from = 0) => {
    let best = from;
    for (let i = from; i < arr.length; i++) if (arr[i] > arr[best]) best = i;
    return best;
  };
  function mode(values) {
    const counts = new Map();
    let best = null, bestN = 0;
    for (const v of values) {
      const n = (counts.get(v) || 0) + 1;
      counts.set(v, n);
      if (n > bestN || (n === bestN && v > best)) { best = v; bestN = n; }
    }
    return { value: best, count: bestN };
  }

  // ---------- Image preparation ----------

  function toGray(img) {
    const { width: w, height: h, data } = img;
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      const a = data[j + 3] / 255;
      const lum = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000;
      g[i] = Math.round(lum * a + 255 * (1 - a)); // transparent = white paper
    }
    return g;
  }

  // Bradley adaptive threshold: a pixel is ink if it is noticeably darker than its neighbourhood.
  // Copes with uneven lighting in photos.
  function binarize(gray, w, h) {
    const W = w + 1;
    const integral = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += gray[y * w + x];
        integral[(y + 1) * W + x + 1] = integral[y * W + x + 1] + row;
      }
    }
    const r = clamp(Math.round(Math.max(w, h) / 24), 12, 120);
    const bin = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        const count = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum = integral[(y1 + 1) * W + x1 + 1] - integral[y0 * W + x1 + 1] - integral[(y1 + 1) * W + x0] + integral[y0 * W + x0];
        const v = gray[y * w + x];
        if (v * count < sum * 0.82 && v < 200) bin[y * w + x] = 1;
      }
    }
    return bin;
  }

  // Try small rotations and keep the one whose row projection is sharpest (staff lines line up).
  function estimateSkew(bin, w, h) {
    const pts = [];
    const stepPx = Math.max(1, Math.round(Math.sqrt((w * h) / 400000)));
    // stride across x only: skipping rows would favour 0° (every sample lands on half the bins)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x += stepPx * stepPx) if (bin[y * w + x]) pts.push(x - w / 2, y);
    let best = 0, bestScore = -1;
    const hist = new Float64Array(h + 2 * w);
    for (let deg = -5; deg <= 5.001; deg += 0.25) {
      const t = Math.tan((deg * Math.PI) / 180);
      hist.fill(0);
      for (let i = 0; i < pts.length; i += 2) {
        const yy = Math.round(pts[i + 1] + pts[i] * t) + w;
        if (yy >= 0 && yy < hist.length) hist[yy]++;
      }
      let score = 0;
      for (let i = 0; i < hist.length; i++) score += hist[i] * hist[i];
      if (score > bestScore) { bestScore = score; best = deg; }
    }
    return best;
  }

  function rotateGray(gray, w, h, deg) {
    const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    const out = new Uint8Array(w * h).fill(255);
    const cx = w / 2, cy = h / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // inverse map: rotate output point back into the source
        const dx = x - cx, dy = y - cy;
        const sx = c * dx - s * dy + cx, sy = s * dx + c * dy + cy;
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
        const fx = sx - x0, fy = sy - y0, i = y0 * w + x0;
        out[y * w + x] = (gray[i] * (1 - fx) + gray[i + 1] * fx) * (1 - fy) + (gray[i + w] * (1 - fx) + gray[i + w + 1] * fx) * fy;
      }
    }
    return out;
  }

  // Most common vertical black run = line thickness; most common white run = gap between lines.
  function staffMetrics(bin, w, h) {
    const black = new Uint32Array(64), white = new Uint32Array(512);
    const step = Math.max(1, Math.floor(w / 500));
    for (let x = 0; x < w; x += step) {
      let run = 0, color = bin[x], seenBlack = false;
      for (let y = 0; y < h; y++) {
        const v = bin[y * w + x];
        if (v === color) { run++; continue; }
        if (color) { if (run < 64) black[run]++; seenBlack = true; } else if (seenBlack && run < 512) white[run]++;
        color = v;
        run = 1;
      }
    }
    const lt = Math.max(1, argmax(black, 1));
    const gap = argmax(white, 2);
    return { lt, sp: lt + gap };
  }

  // ---------- Staves ----------

  function findStaves(bin, w, h, lt, sp) {
    // Count only ink in long horizontal runs, so text doesn't count and short staves still stand out.
    const minRun = Math.max(8, Math.round(sp * 3));
    const proj = new Uint32Array(h);
    for (let y = 0; y < h; y++) {
      let n = 0, run = 0;
      for (let x = 0, i = y * w; x <= w; x++, i++) {
        if (x < w && bin[i]) { run++; continue; }
        if (run >= minRun) n += run;
        run = 0;
      }
      proj[y] = n;
    }
    let maxP = 0;
    for (let y = 0; y < h; y++) maxP = Math.max(maxP, proj[y]);
    const thr = Math.min(maxP * 0.3, sp * 10);
    const lines = [];
    for (let y = 0; y < h; y++) {
      if (proj[y] < thr) continue;
      let y2 = y;
      while (y2 + 1 < h && proj[y2 + 1] >= thr) y2++;
      // weight the centre by ink so thick/blurred lines still land in the middle
      let sw = 0, sy = 0;
      for (let k = y; k <= y2; k++) { sw += proj[k]; sy += proj[k] * k; }
      lines.push({ y: sy / sw, a: y, b: y2 });
      y = y2;
    }
    const staves = [];
    for (let i = 0; i + 4 < lines.length;) {
      const ys = lines.slice(i, i + 5).map((l) => l.y);
      const gaps = [ys[1] - ys[0], ys[2] - ys[1], ys[3] - ys[2], ys[4] - ys[3]];
      const ok = gaps.every((g) => g > sp * 0.7 && g < sp * 1.35) && Math.max(...gaps) - Math.min(...gaps) < sp * 0.3 + 2;
      if (ok) { staves.push({ ys, sp: (ys[4] - ys[0]) / 4 }); i += 5; } else i++;
    }
    // horizontal extent: columns where at least 4 of the 5 lines have ink
    for (const st of staves) {
      const inStaff = new Uint8Array(w);
      for (let x = 0; x < w; x++) {
        let n = 0;
        for (const y of st.ys) {
          const yy = Math.round(y);
          if (bin[yy * w + x] || bin[(yy - 1) * w + x] || bin[(yy + 1) * w + x]) n++;
        }
        inStaff[x] = n >= 3 ? 1 : 0;
      }
      let best = [0, -1], start = -1, lastIn = -1;
      const tol = Math.round(st.sp * 2);
      for (let x = 0; x <= w; x++) {
        if (x < w && inStaff[x]) {
          if (start < 0 || x - lastIn > tol) start = x;
          lastIn = x;
          if (lastIn - start > best[1] - best[0]) best = [start, lastIn];
        }
      }
      st.left = best[0];
      st.right = best[1];
    }
    return staves.filter((st) => st.right - st.left > st.sp * 8);
  }

  // Erase staff lines where nothing crosses them; track each line across the page so slight curves still work.
  function removeStaffLines(bin, w, h, staves, lt) {
    const clean = bin.slice();
    for (const st of staves) {
      st.lineY = [];
      for (const y0 of st.ys) {
        const prof = new Float32Array(w).fill(y0);
        // pass 1: measure this line's real thickness
        const lens = [];
        for (let x = st.left; x <= st.right; x += 3) {
          const yy = Math.round(y0);
          if (!bin[yy * w + x]) continue;
          let a = yy, b = yy;
          while (a > 0 && bin[(a - 1) * w + x]) a--;
          while (b < h - 1 && bin[(b + 1) * w + x]) b++;
          lens.push(b - a + 1);
        }
        lens.sort((p, q) => p - q);
        const thick = lens.length ? lens[lens.length >> 1] : lt;
        const maxRun = Math.round(thick * 1.6) + 1;
        let y = y0;
        for (let x = Math.max(0, st.left - 2); x <= Math.min(w - 1, st.right + 2); x++) {
          const yc = Math.round(y);
          let hit = -1;
          for (let d = 0; d <= thick + 1 && hit < 0; d++) {
            if (yc - d >= 0 && bin[(yc - d) * w + x]) hit = yc - d;
            else if (yc + d < h && bin[(yc + d) * w + x]) hit = yc + d;
          }
          prof[x] = y;
          if (hit < 0) continue;
          let a = hit, b = hit;
          while (a > 0 && bin[(a - 1) * w + x]) a--;
          while (b < h - 1 && bin[(b + 1) * w + x]) b++;
          if (b - a + 1 <= maxRun) {
            for (let k = a; k <= b; k++) clean[k * w + x] = 0;
            y = y * 0.85 + ((a + b) / 2) * 0.15;
          }
        }
        st.lineY.push(prof);
      }
    }
    return clean;
  }

  // ---------- Connected components ----------

  function components(bin, w, h) {
    const labels = new Int32Array(w * h);
    const comps = [null];
    const stack = new Int32Array(w * h);
    let next = 1;
    for (let start = 0; start < bin.length; start++) {
      if (!bin[start] || labels[start]) continue;
      const id = next++;
      let sp = 0, x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0;
      stack[sp++] = start;
      labels[start] = id;
      while (sp) {
        const p = stack[--sp];
        const x = p % w, y = (p - x) / w;
        area++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (bin[q] && !labels[q]) { labels[q] = id; stack[sp++] = q; }
          }
        }
      }
      comps.push({ id, x0, y0, x1, y1, area, w: x1 - x0 + 1, h: y1 - y0 + 1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
    }
    return { labels, comps };
  }

  // White regions fully enclosed by a component (the inside of a hollow notehead, a sharp, a flat's belly...).
  // `erased` (optional) marks staff-line pixels that were removed; counting them as ink closes up
  // hollow noteheads whose thin rims were erased along with the line they touch.
  function holesOf(c, labels, w, erased) {
    const bx0 = c.x0 - 1, by0 = c.y0 - 1, bw = c.w + 2, bh = c.h + 2;
    const mark = new Uint8Array(bw * bh); // 1 = component ink, 2 = outside
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const X = bx0 + x, Y = by0 + y;
        if (X < 0 || Y < 0 || X >= w) continue;
        const i = Y * w + X;
        if (labels[i] === c.id || (erased && erased[i] && x > 0 && x < bw - 1)) mark[y * bw + x] = 1;
      }
    }
    const stack = [0];
    mark[0] = 2;
    while (stack.length) {
      const p = stack.pop(), x = p % bw, y = (p - x) / bw;
      const nb = [p - 1, p + 1, p - bw, p + bw];
      if (x === 0) nb[0] = -1;
      if (x === bw - 1) nb[1] = -1;
      for (const q of nb) if (q >= 0 && q < mark.length && !mark[q]) { mark[q] = 2; stack.push(q); }
    }
    const holes = [];
    for (let p = 0; p < mark.length; p++) {
      if (mark[p]) continue;
      let hx0 = bw, hy0 = bh, hx1 = 0, hy1 = 0, area = 0;
      const st = [p];
      mark[p] = 3;
      while (st.length) {
        const q = st.pop(), x = q % bw, y = (q - x) / bw;
        area++;
        hx0 = Math.min(hx0, x); hx1 = Math.max(hx1, x); hy0 = Math.min(hy0, y); hy1 = Math.max(hy1, y);
        for (const r of [q - 1, q + 1, q - bw, q + bw]) if (r >= 0 && r < mark.length && !mark[r]) { mark[r] = 3; st.push(r); }
      }
      holes.push({ x0: hx0 + bx0, y0: hy0 + by0, x1: hx1 + bx0, y1: hy1 + by0, area, w: hx1 - hx0 + 1, h: hy1 - hy0 + 1, cx: (hx0 + hx1) / 2 + bx0, cy: (hy0 + hy1) / 2 + by0 });
    }
    return holes;
  }

  // Vertical extent (as fractions of the component height) of ink within a column band.
  // `c` is a component or a group of components ({ ids: Set, ...bbox }).
  const owns = (c, id) => (c.ids ? c.ids.has(id) : id === c.id);
  function bandExtent(c, labels, w, xa, xb) {
    let top = Infinity, bot = -Infinity;
    for (let x = xa; x <= xb; x++) {
      for (let y = c.y0; y <= c.y1; y++) {
        if (owns(c, labels[y * w + x])) { if (y < top) top = y; if (y > bot) bot = y; }
      }
    }
    if (top === Infinity) return { t: 1, b: 0 };
    return { t: (top - c.y0) / c.h, b: (bot - c.y0) / c.h };
  }

  function accidentalShape(c, labels, w, sp) {
    const hs = c.h / sp, ws = c.w / sp;
    if (hs < 1.5 || hs > 3.7 || ws < 0.3 || ws > 1.4) return null;
    if (c.area / (c.w * c.h) > 0.75) return null;
    const third = Math.max(1, Math.round(c.w / 3));
    const L = bandExtent(c, labels, w, c.x0, c.x0 + third - 1);
    const R = bandExtent(c, labels, w, c.x1 - third + 1, c.x1);
    if (accidentalShape.trace) accidentalShape.trace(`acc@${Math.round(c.cx)},${Math.round(c.cy)} ws=${ws.toFixed(2)} hs=${hs.toFixed(2)} L=${L.t.toFixed(2)}-${L.b.toFixed(2)} R=${R.t.toFixed(2)}-${R.b.toFixed(2)}`);
    // sharp: two strokes running (almost) the full height
    if (ws >= 0.7 && L.t < 0.2 && L.b > 0.85 && R.t < 0.15 && R.b > 0.7) return { type: 'sharp', y: c.cy };
    // flat: full-height stem on the left, belly only in the lower part
    if (L.t < 0.12 && L.b > 0.85 && R.t > 0.4 && hs < 3.2) return { type: 'flat', y: c.y1 - 0.45 * sp };
    // natural: left stroke from the top, right stroke to the bottom, offset from each other
    if (ws < 0.95 && L.t < 0.2 && L.b > 0.55 && L.b < 0.88 && R.t > 0.12 && R.t < 0.45 && R.b > 0.85) return { type: 'natural', y: c.cy };
    return null;
  }

  // ---------- Main ----------

  function recognize(img, opts = {}) {
    const w = img.width, h = img.height;
    let gray = toGray(img);
    let bin = binarize(gray, w, h);
    const skew = estimateSkew(bin, w, h);
    if (Math.abs(skew) >= 0.25) {
      gray = rotateGray(gray, w, h, -skew); // rotate back the other way
      bin = binarize(gray, w, h);
    }
    const { lt, sp: spGuess } = staffMetrics(bin, w, h);
    const staves = findStaves(bin, w, h, lt, spGuess);
    const result = { width: w, height: h, skew, gray: Math.abs(skew) >= 0.25 ? gray : null, lt, sp: spGuess, staves, notes: [], warnings: [], debug: { heads: [], accidentals: [], barlines: [], slurs: [], rests: [], dots: [], trace: [] } };
    if (!staves.length) {
      result.warnings.push('No staves found. Try a sharper, straighter image with the music filling more of the frame.');
      return result;
    }
    const clean = removeStaffLines(bin, w, h, staves, lt);
    const { labels, comps } = components(clean, w, h);
    result.clean = clean;

    // Assign components to the nearest staff (vertical band halfway to its neighbours).
    staves.forEach((st) => { st.top = st.ys[0]; st.bottom = st.ys[4]; });
    staves.forEach((st, i) => {
      const prev = staves[i - 1], next = staves[i + 1];
      st.bandTop = Math.max(prev ? (prev.bottom + st.top) / 2 : 0, st.top - 5 * st.sp);
      st.bandBot = Math.min(next ? (st.bottom + next.top) / 2 : h, st.bottom + 5 * st.sp);
      st.comps = [];
    });
    const tallThin = [];
    for (let i = 1; i < comps.length; i++) {
      const c = comps[i];
      const st0 = staves[0];
      if (c.area < 0.04 * st0.sp * st0.sp) continue;
      if (c.w <= 0.8 * st0.sp && c.h >= 3.4 * st0.sp && c.area / (c.w * c.h) > 0.6) tallThin.push(c);
      const st = staves.find((s) => c.cy >= s.bandTop && c.cy < s.bandBot);
      if (st && c.x1 >= st.left - st.sp && c.x0 <= st.right + st.sp) st.comps.push(c);
    }

    // Barlines (may span two staves in piano music, so they are matched to every staff they cross).
    for (const st of staves) {
      st.barlines = [];
      for (const c of tallThin) {
        if (c.y0 <= st.top + 0.4 * st.sp && c.y1 >= st.bottom - 0.4 * st.sp && c.x0 > st.left + 2 * st.sp) {
          c.isBarline = true;
          if (!st.barlines.some((b) => Math.abs(b.x - c.cx) < 1.5 * st.sp)) st.barlines.push({ x: c.cx, c });
        }
      }
      st.barlines.sort((a, b) => a.x - b.x);
    }
    // Staves joined by a barline belong to the same system (grand staff).
    const joined = staves.map(() => false);
    for (const c of tallThin) {
      for (let i = 0; i + 1 < staves.length; i++) {
        if (c.y0 <= staves[i].top + st0sp(staves) && c.y1 >= staves[i + 1].bottom - st0sp(staves)) joined[i] = true;
      }
    }

    for (const st of staves) analyzeStaff(st, labels, clean, bin, w, h, opts, result);

    // Systems: sequential single staves, or treble+bass pairs.
    let pairs = opts.staves === 'pairs';
    if (!opts.staves || opts.staves === 'auto') {
      const alternating = staves.length >= 2 && staves.length % 2 === 0 && staves.every((s, i) => s.clef === (i % 2 ? 'bass' : 'treble'));
      const brace = staves.length >= 2 && staves.length % 2 === 0 && staves.every((s, i) => i % 2 === 1 || joined[i]);
      pairs = alternating || brace;
    }
    result.systems = [];
    if (pairs) for (let i = 0; i + 1 < staves.length; i += 2) result.systems.push([staves[i], staves[i + 1]]);
    else for (const s of staves) result.systems.push([s]);
    if (pairs && staves.length % 2) result.systems.push([staves[staves.length - 1]]);

    buildTimeline(result, opts);
    return result;
  }

  const st0sp = (staves) => staves[0].sp * 0.5;

  function analyzeStaff(st, labels, clean, bin, w, h, opts, result) {
    const sp = st.sp, half = sp / 2;
    const dbg = result.debug;
    const trace = opts.trace ? (...a) => dbg.trace.push(a.map((v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)).join(' ')) : () => {};
    // Staff-line geometry at a given x (handles slight bowing).
    const lineAt = (k, x) => st.lineY[k][clamp(Math.round(x), 0, w - 1)];
    st.posAt = (x, y) => (lineAt(4, x) - y) / ((lineAt(4, x) - lineAt(0, x)) / 8); // 0 = bottom line, 8 = top line
    const ink = (x, y) => x >= 0 && y >= 0 && x < w && y < h && clean[y * w + x] === 1;
    const comps = st.comps.sort((a, b) => a.x0 - b.x0);
    accidentalShape.trace = opts.trace ? (m) => dbg.trace.push(m) : null;
    const compById = new Map(comps.map((c) => [c.id, c]));

    // --- Clef: the ink in the first ~3.5 spaces of the staff ---
    // (skip braces and the line joining a grand staff: very tall, or tall and thin)
    const near = comps.filter((c) => c.x0 < st.left + 4 * sp && c.h > 0.4 * sp && c.h < 9 * sp && !(c.w < 0.6 * sp && c.h > 3.4 * sp) && c.y0 > st.top - 4 * sp && c.y1 < st.bottom + 4 * sp);
    const main = near.reduce((m, c) => (!m || c.h > m.h ? c : m), null);
    const clefComps = main && main.h > 2.2 * sp ? near.filter((c) => c.x1 >= main.x0 && c.x0 <= main.x1) : [];
    let clef = 'treble', headerX = st.left + 0.5 * sp;
    if (clefComps.length) {
      const top = Math.min(...clefComps.map((c) => c.y0)), bot = Math.max(...clefComps.map((c) => c.y1));
      headerX = Math.max(...clefComps.map((c) => c.x1));
      // the bass clef's two dots sit just to its right
      for (const c of comps) {
        if (!c.used && !clefComps.includes(c) && c.x0 <= headerX + 0.9 * sp && c.x0 > headerX - sp && c.w < 0.7 * sp && c.h < 0.7 * sp) clefComps.push(c);
      }
      headerX = Math.max(...clefComps.map((c) => c.x1));
      if (top > st.top - 0.8 * sp && bot < st.bottom - 0.6 * sp) clef = 'bass';
      clefComps.forEach((c) => (c.used = 'clef'));
    }
    if (opts.clef && opts.clef !== 'auto') clef = opts.clef;
    st.clef = clef;

    st.headerX = headerX;

    // --- Filled noteheads: plateaus of ink density over a notehead-sized window ---
    const y0 = Math.max(0, Math.floor(st.top - 4.5 * sp)), y1 = Math.min(h - 1, Math.ceil(st.bottom + 4.5 * sp));
    const x0 = Math.max(0, Math.floor(headerX + 0.3 * sp)), x1 = Math.min(w - 1, Math.ceil(st.right + 0.5 * sp));
    const RW = x1 - x0 + 2;
    const integ = new Uint32Array(RW * (y1 - y0 + 2));
    for (let y = y0; y <= y1; y++) {
      let row = 0;
      for (let x = x0; x <= x1; x++) {
        row += clean[y * w + x];
        integ[(y - y0 + 1) * RW + (x - x0 + 1)] = integ[(y - y0) * RW + (x - x0 + 1)] + row;
      }
    }
    const boxSum = (ax, ay, bx, by) => {
      ax = clamp(ax, x0, x1); bx = clamp(bx, x0, x1); ay = clamp(ay, y0, y1); by = clamp(by, y0, y1);
      const A = (ay - y0) * RW + (ax - x0), B = (ay - y0) * RW + (bx - x0 + 1), C = (by - y0 + 1) * RW + (ax - x0), D = (by - y0 + 1) * RW + (bx - x0 + 1);
      return integ[D] - integ[B] - integ[C] + integ[A];
    };
    const hw = Math.max(2, Math.round(0.45 * sp)), hh = Math.max(1, Math.round(0.28 * sp));
    const area = (2 * hw + 1) * (2 * hh + 1);
    const cand = new Uint8Array(RW * (y1 - y0 + 2));
    for (let y = y0 + hh; y <= y1 - hh; y++) {
      for (let x = x0 + hw; x <= x1 - hw; x++) {
        if (!clean[y * w + x]) continue;
        if (boxSum(x - hw, y - hh, x + hw, y + hh) >= area * 0.9) cand[(y - y0) * RW + (x - x0)] = 1;
      }
    }
    const heads = [];
    const seen = new Uint8Array(cand.length);
    for (let p = 0; p < cand.length; p++) {
      if (!cand[p] || seen[p]) continue;
      const stack = [p];
      seen[p] = 1;
      let sx = 0, sy = 0, n = 0, bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
      while (stack.length) {
        const q = stack.pop(), x = q % RW, y = (q - x) / RW;
        sx += x; sy += y; n++;
        bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y);
        for (const r of [q - 1, q + 1, q - RW, q + RW]) if (r >= 0 && r < cand.length && cand[r] && !seen[r]) { seen[r] = 1; stack.push(r); }
      }
      const cx = sx / n + x0;
      const bh = by1 - by0;
      if ((bx1 - bx0) > 1.2 * sp || bh > 4.6 * sp) continue; // too big to be noteheads
      // A tall plateau is a chord: noteheads stacked a space apart. Split it evenly.
      const k = bh > 0.9 * sp ? Math.round((bh - 0.4 * sp) / sp) + 1 : 1;
      const centers = [];
      if (k === 1) centers.push(sy / n + y0);
      else for (let i = 0; i < k; i++) centers.push(by0 + y0 + 0.2 * sp + (i * (bh - 0.4 * sp)) / (k - 1));
      for (const cy of centers) {
        // Shape check: notehead-sized horizontal and vertical extents through the centre.
        const runH = (yy) => { let a = Math.round(cx), b = a; while (ink(a - 1, yy)) a--; while (ink(b + 1, yy)) b++; return b - a + 1; };
        const hRun = Math.min(runH(Math.round(cy - 0.15 * sp)), runH(Math.round(cy + 0.15 * sp)));
        let va = Math.round(cy), vb = va;
        while (ink(Math.round(cx), va - 1)) va--;
        while (ink(Math.round(cx), vb + 1)) vb++;
        const vRun = vb - va + 1;
        if (hRun < 0.85 * sp || hRun > 2.6 * sp || vRun < 0.6 * sp || (k === 1 && vRun > 1.7 * sp)) continue;
        const comp = labels[Math.round(cy) * w + Math.round(cx)];
        heads.push({ cx, cy, filled: true, comp });
      }
    }
    const headComps = new Set(heads.map((hd) => hd.comp));

    // --- Group fragments: erasing staff lines can split a sharp/flat/natural into pieces ---
    const groups = [];
    {
      const gap = Math.max(2, 0.25 * sp);
      const free = comps.filter((c) => !c.used && !headComps.has(c.id) && c.h < 4 * sp && c.w < 1.6 * sp);
      const parent = free.map((_, i) => i);
      const box = free.map((c) => [c.x0, c.y0, c.x1, c.y1]);
      const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      for (let i = 0; i < free.length; i++) {
        const a = free[i];
        for (let j = i + 1; j < free.length; j++) {
          const b = free[j];
          if (b.x0 > a.x1 + gap) break; // comps are sorted by x0
          if (!(b.x1 >= a.x0 - gap && b.y0 <= a.y1 + gap && b.y1 >= a.y0 - gap)) continue;
          const ra = find(i), rb = find(j);
          if (ra === rb) continue;
          const A = box[ra], B = box[rb];
          const u = [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[2], B[2]), Math.max(A[3], B[3])];
          if (u[2] - u[0] > 1.25 * sp || u[3] - u[1] > 3.7 * sp) continue; // would be bigger than one accidental
          parent[rb] = ra;
          box[ra] = u;
        }
      }
      const byRoot = new Map();
      free.forEach((c, i) => {
        const r = find(i);
        if (!byRoot.has(r)) byRoot.set(r, []);
        byRoot.get(r).push(c);
      });
      for (const list of byRoot.values()) {
        const g = { comps: list, ids: new Set(list.map((c) => c.id)), x0: Math.min(...list.map((c) => c.x0)), x1: Math.max(...list.map((c) => c.x1)), y0: Math.min(...list.map((c) => c.y0)), y1: Math.max(...list.map((c) => c.y1)), area: list.reduce((t, c) => t + c.area, 0) };
        g.w = g.x1 - g.x0 + 1; g.h = g.y1 - g.y0 + 1; g.cx = (g.x0 + g.x1) / 2; g.cy = (g.y0 + g.y1) / 2;
        g.shape = accidentalShape(g, labels, w, sp);
        list.forEach((c) => (c.group = g));
        groups.push(g);
      }
      groups.sort((a, b) => a.x0 - b.x0);
    }

    // --- Key signature: run of sharps or flats right after the clef ---
    const keyAcc = [];
    for (const c of groups) {
      if (c.used || c.x0 < headerX - 0.2 * sp) continue;
      if (c.x0 > headerX + (keyAcc.length ? 1.2 : 1.8) * sp) break;
      if (c.w < 0.5 * sp && c.h < 0.5 * sp) continue; // specks
      const shape = c.shape;
      if (!shape || shape.type === 'natural' || (keyAcc.length && shape.type !== keyAcc[0].type)) break;
      keyAcc.push(shape);
      c.used = 'key';
      c.comps.forEach((cc) => (cc.used = 'key'));
      headerX = c.x1;
      dbg.accidentals.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, type: shape.type, key: true });
    }
    let keyCount = keyAcc.length, keyType = keyAcc.length ? keyAcc[0].type : null;
    if (opts.key != null && opts.key !== 'auto') {
      const k = +opts.key;
      keyCount = Math.abs(k);
      keyType = k > 0 ? 'sharp' : k < 0 ? 'flat' : null;
    }
    keyCount = Math.min(keyCount, 7);
    const keyAlter = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < keyCount; i++) {
      if (keyType === 'sharp') keyAlter[SHARP_ORDER[i]] = 1;
      else keyAlter[FLAT_ORDER[i]] = -1;
    }
    st.key = { count: keyCount, type: keyType, name: keyType === 'flat' ? FLAT_KEYS[keyCount] : SHARP_KEYS[keyCount] };
    st.keyAlter = keyAlter;


    for (let i = heads.length - 1; i >= 0; i--) if (heads[i].cx < headerX) heads.splice(i, 1);

    // --- Time signature: blobs right after the key that hold no noteheads (digits, or a C).
    // Recognized only so they can be skipped; the bar length is worked out from the rhythms.
    let ts = null;
    for (const c of [...groups, ...comps.filter((cc) => !cc.group)].sort((a, b) => a.x0 - b.x0)) {
      if (c.used || c.x0 < headerX - 0.2 * sp) continue;
      if (c.x0 > headerX + 1.8 * sp) break;
      if (c.shape) break; // an accidental: the music has started
      const hs = c.h / sp, ws = c.w / sp;
      const inside = c.y0 > st.top - 0.7 * sp && c.y1 < st.bottom + 0.7 * sp;
      const hasHead = c.ids ? [...c.ids].some((id) => headComps.has(id)) : headComps.has(c.id);
      // Stacked digits: both halves carry plenty of ink on every row (a stem is thin). Bold digits can
      // look like noteheads, so this test doesn't care about heads.
      let stacked = false;
      if (inside && hs > 3 && hs < 4.8 && ws > 0.8 && ws < 2.6) {
        let top = 0, bot = 0;
        const mid = (c.y0 + c.y1) / 2;
        for (let y = c.y0; y <= c.y1; y++) {
          let n = 0;
          for (let x = c.x0; x <= c.x1; x++) if (owns(c, labels[y * w + x])) n++;
          if (y < mid) top += n; else bot += n;
        }
        const rows = c.h / 2;
        stacked = top / rows > 0.4 * sp && bot / rows > 0.4 * sp;
      }
      if (stacked || (inside && !hasHead && hs > 1.2 && hs < 4.6 && ws > 0.6 && ws < 2.6)) { ts = { x0: c.x0, x1: c.x1 }; break; }
    }
    if (ts) {
      for (const c of comps) {
        if (c.used || c.x1 < ts.x0 - 0.2 * sp || c.x0 > ts.x1 + 0.2 * sp) continue;
        if (c.y0 > st.top - 0.7 * sp && c.y1 < st.bottom + 0.7 * sp) { c.used = 'time'; ts.x1 = Math.max(ts.x1, c.x1); }
      }
      headerX = ts.x1;
      st.headerX = headerX;
      st.hasTime = true;
      for (let i = heads.length - 1; i >= 0; i--) if (heads[i].cx < headerX) heads.splice(i, 1);
    }

    // --- Hollow noteheads (half and whole notes): small, oval white regions fully enclosed by ink.
    // Found on the image *with* staff lines, because erasing lines can cut a hollow head's thin rim.
    {
      const W = x1 - x0 + 1, H = y1 - y0 + 1;
      const seenW = new Uint8Array(W * H);
      const isInk = (x, y) => bin[y * w + x] === 1;
      const stack = new Int32Array(W * H);
      for (let ry = 0; ry < H; ry++) {
        for (let rx = 0; rx < W; rx++) {
          const p0 = ry * W + rx;
          if (seenW[p0] || isInk(rx + x0, ry + y0)) continue;
          let sp0 = 0, n = 0, bx0 = rx, bx1 = rx, by0 = ry, by1 = ry, touches = false;
          stack[sp0++] = p0;
          seenW[p0] = 1;
          while (sp0) {
            const q = stack[--sp0], qx = q % W, qy = (q - qx) / W;
            n++;
            if (qx < bx0) bx0 = qx; if (qx > bx1) bx1 = qx; if (qy < by0) by0 = qy; if (qy > by1) by1 = qy;
            if (qx === 0 || qy === 0 || qx === W - 1 || qy === H - 1) touches = true;
            if (qx > 0 && !seenW[q - 1] && !isInk(qx - 1 + x0, qy + y0)) { seenW[q - 1] = 1; stack[sp0++] = q - 1; }
            if (qx < W - 1 && !seenW[q + 1] && !isInk(qx + 1 + x0, qy + y0)) { seenW[q + 1] = 1; stack[sp0++] = q + 1; }
            if (qy > 0 && !seenW[q - W] && !isInk(qx + x0, qy - 1 + y0)) { seenW[q - W] = 1; stack[sp0++] = q - W; }
            if (qy < H - 1 && !seenW[q + W] && !isInk(qx + x0, qy + 1 + y0)) { seenW[q + W] = 1; stack[sp0++] = q + W; }
          }
          if (touches) continue;
          const hw2 = (bx1 - bx0 + 1) / sp, hh2 = (by1 - by0 + 1) / sp, fill = n / ((bx1 - bx0 + 1) * (by1 - by0 + 1));
          const hcx = (bx0 + bx1) / 2 + x0, hcy = (by0 + by1) / 2 + y0;
          if (hw2 > 0.15 && hw2 < 1.5 && hh2 > 0.1 && hh2 < 1.2) trace('hole', hcx, hcy, 'w', hw2, 'h', hh2, 'fill', fill);
          if (hw2 < 0.22 || hw2 > 1.25 || hh2 < 0.15 || hh2 > 0.95 || fill > 0.9 || n < 0.04 * sp * sp) continue;
          if (hcx < headerX + 0.5 * sp) continue;
          if (st.barlines.some((bl) => Math.abs(bl.x - hcx) < 1.0 * sp)) continue; // gap inside a double barline
          if (heads.some((hd) => Math.abs(hd.cx - hcx) < 0.8 * sp && Math.abs(hd.cy - hcy) < 0.6 * sp)) continue;
          // rim: thin ink on both sides, notehead-sized overall
          const row = Math.round(hcy);
          let l = Math.round(bx0 + x0) - 1, r = Math.round(bx1 + x0) + 1, tl = 0, tr = 0;
          while (l > 0 && isInk(l, row) && tl < sp) { l--; tl++; }
          while (r < w - 1 && isInk(r, row) && tr < sp) { r++; tr++; }
          const outer = (r - l - 1) / sp;
          trace('  rim', tl / sp, tr / sp, 'outer', outer);
          if (!tl || !tr || tl > 0.7 * sp || tr > 0.7 * sp || outer < 0.85 || outer > 2.4) continue;
          // a side that runs well past the hole both upward and downward is a stem, not a rim
          // (e.g. the space enclosed by a flag, its stem and a staff line)
          const holeTop = by0 + y0, holeBot = by1 + y0;
          const throughStem = (xx) => {
            let a2 = row, b2 = row;
            while (a2 > 0 && isInk(xx, a2 - 1)) a2--;
            while (b2 < h - 1 && isInk(xx, b2 + 1)) b2++;
            return a2 < holeTop - 0.7 * sp && b2 > holeBot + 0.7 * sp;
          };
          if (throughStem(l + Math.ceil(tl / 2)) || throughStem(r - Math.ceil(tr / 2))) { trace('  stem-wall'); continue; }
          // thin rim above and below too (beams are thick)
          const col = Math.round(hcx);
          let tt = 0, tb = 0;
          for (let yy = holeTop - 1; yy > 0 && isInk(col, yy) && tt < sp; yy--) tt++;
          for (let yy = holeBot + 1; yy < h - 1 && isInk(col, yy) && tb < sp; yy++) tb++;
          if (tt > 0.8 * sp || tb > 0.8 * sp) { trace('  thick-rim', tt / sp, tb / sp); continue; }
          // reject the insides of accidentals
          const ids = new Set();
          for (let yy = Math.round(hcy - 0.6 * sp); yy <= Math.round(hcy + 0.6 * sp); yy++) {
            for (let xx = l; xx <= r; xx++) { const id = labels[yy * w + xx]; if (id) ids.add(id); }
          }
          let accidental = false;
          for (const id of ids) {
            const c = compById.get(id);
            if (c && (c.used === 'key' || (c.group && c.group.shape))) accidental = true;
          }
          if (accidental) { trace('  accidental'); continue; }
          heads.push({ cx: (l + r) / 2, cy: hcy, filled: false, comp: [...ids][0] || 0, rimIds: ids });
          ids.forEach((id) => headComps.add(id));
        }
      }
    }

    // --- Barlines: columns of ink spanning the whole staff that aren't a notehead's stem.
    // (Done by columns rather than shapes because ties and slurs often run through barlines.)
    {
      const fromComps = st.barlines;
      st.barlines = [];
      const full = (x) => {
        const t = Math.round(lineAt(0, x)), b = Math.round(lineAt(4, x));
        let n = 0;
        for (let y = t; y <= b; y++) if (clean[y * w + x]) n++;
        return n >= (b - t + 1) * 0.92;
      };
      const xa = Math.round(headerX + 0.5 * sp), xb = Math.min(w - 1, Math.round(st.right + 2));
      let run = null;
      for (let x = xa; x <= xb + 1; x++) {
        if (x <= xb && full(x)) { if (run) run.b = x; else run = { a: x, b: x }; continue; }
        if (!run) continue;
        const cx = (run.a + run.b) / 2;
        if (run.b - run.a + 1 <= 0.9 * sp && !heads.some((hd) => Math.abs(hd.cx - cx) < 1.0 * sp)) {
          const prev = st.barlines[st.barlines.length - 1];
          if (prev && cx - prev.x < 1.5 * sp) prev.x = (prev.x + cx) / 2; // double barline
          else st.barlines.push({ x: cx });
        }
        run = null;
      }
      for (const b of fromComps) if (!st.barlines.some((o) => Math.abs(o.x - b.x) < 1.5 * sp)) st.barlines.push(b);
      st.barlines.sort((a, b) => a.x - b.x);
    }

    // --- Notes above/below the staff must sit on ledger lines (rejects text such as a title) ---
    for (let i = heads.length - 1; i >= 0; i--) {
      const hd = heads[i];
      const pos = st.posAt(hd.cx, hd.cy);
      if (pos < -1.5 || pos > 9.5) {
        const lp = pos > 9.5 ? 10 : -2; // the first ledger line position outside the staff
        const ly = lineAt(4, hd.cx) - (lp * (lineAt(4, hd.cx) - lineAt(0, hd.cx))) / 8;
        let found = false;
        for (let dy = -Math.round(0.3 * sp); dy <= Math.round(0.3 * sp) && !found; dy++) {
          const yy = Math.round(ly + dy);
          let a = Math.round(hd.cx), b = a;
          while (ink(a - 1, yy) || (bin[yy * w + a - 1] === 1)) { a--; if (hd.cx - a > 2 * sp) break; }
          while (ink(b + 1, yy) || (bin[yy * w + b + 1] === 1)) { b++; if (b - hd.cx > 2 * sp) break; }
          if (b - a > 1.4 * sp) found = true;
        }
        if (!found) heads.splice(i, 1);
      }
    }

    // --- Durations: stems, beams/flags, dots ---
    const runVert = (x, y, dir, maxLen) => {
      let len = 0, gap = 0;
      for (let k = 1; k <= maxLen; k++) {
        if (ink(x, y + dir * k)) { len = k; gap = 0; } else if (++gap > 1) break;
      }
      return len;
    };
    for (const hd of heads) {
      let best = null;
      const maxLen = Math.round(6 * sp);
      for (let x = Math.round(hd.cx + 0.25 * sp); x <= Math.round(hd.cx + 0.9 * sp); x++) {
        const len = runVert(x, Math.round(hd.cy), -1, maxLen);
        if (!best || len > best.len) best = { x, dir: -1, len };
      }
      for (let x = Math.round(hd.cx - 0.9 * sp); x <= Math.round(hd.cx - 0.25 * sp); x++) {
        const len = runVert(x, Math.round(hd.cy), 1, maxLen);
        if (len > best.len) best = { x, dir: 1, len };
      }
      hd.stem = best.len >= 2.2 * sp ? { ...best, end: Math.round(hd.cy) + best.dir * best.len } : null;
      let beams = 0;
      if (hd.stem && hd.filled) {
        const span = Math.min(2.2 * sp, hd.stem.len - 1.1 * sp);
        for (const dx of [-0.45 * sp, 0.45 * sp]) {
          const xx = Math.round(hd.stem.x + dx);
          let runs = 0, run = 0;
          for (let k = 0; k <= span; k++) {
            const yy = hd.stem.end - hd.stem.dir * k;
            if (ink(xx, yy)) run++;
            else { if (run >= 0.2 * sp) runs++; run = 0; }
          }
          if (run >= 0.2 * sp) runs++;
          beams = Math.max(beams, runs);
        }
      }
      hd.beams = Math.min(beams, 2);
      if (hd.filled && !hd.stem) hd.noStem = true;
      hd.dur = hd.filled ? [4, 2, 1][hd.beams] : hd.stem ? 8 : 16;
    }

    // Filled noteheads always have stems. Without one it's a half/whole rest (a solid block) or noise.
    const blockRests = [];
    for (let i = heads.length - 1; i >= 0; i--) {
      const hd = heads[i];
      if (!hd.noStem) continue;
      heads.splice(i, 1);
      const c = compById.get(hd.comp);
      if (!c) continue;
      const ws = c.w / sp, hs = c.h / sp, fill = c.area / (c.w * c.h);
      if (fill > 0.75 && ws > 0.7 && ws < 1.7 && hs > 0.25 && hs < 0.9) {
        const pos = st.posAt(c.cx, c.cy);
        c.used = 'rest';
        blockRests.push({ x: c.cx, dur: pos >= 5 ? 16 : 8, whole: pos >= 5 });
        dbg.rests.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, dur: pos >= 5 ? 16 : 8 });
      }
    }

    // Dots: small round blobs just right of a notehead.
    for (const c of comps) {
      if (c.used || headComps.has(c.id)) continue;
      const ws = c.w / sp, hs = c.h / sp;
      if (ws < 0.18 || ws > 0.75 || hs < 0.18 || hs > 0.75 || c.area / (c.w * c.h) < 0.5) continue;
      let best = null;
      for (const hd of heads) {
        const dx = (c.cx - hd.cx) / sp, dy = Math.abs(c.cy - hd.cy) / sp;
        if (dx > 0.7 && dx < 2.3 && dy < 0.8 && (!best || dx < best.dx)) best = { hd, dx };
      }
      if (best && !best.hd.dotted) {
        best.hd.dotted = true;
        best.hd.dur *= 1.5;
        c.used = 'dot';
        dbg.dots.push({ x: c.cx, y: c.cy, r: c.w / 2 });
      }
    }

    // --- Accidentals in the music: attach each to the notehead on its right ---
    for (const c of groups) {
      if (c.used || c.cx < headerX || [...c.ids].some((id) => headComps.has(id))) continue;
      const shape = c.shape;
      if (!shape) continue;
      let best = null;
      for (const hd of heads) {
        const dx = (hd.cx - 0.6 * sp - c.x1) / sp, dy = Math.abs(hd.cy - shape.y) / sp;
        if (dx > -0.4 && dx < 2.2 && dy < 0.65 && (!best || dx < best.dx)) best = { hd, dx };
      }
      if (!best) continue; // probably a rest; handled below
      best.hd.acc = shape.type;
      c.used = 'acc';
      c.comps.forEach((cc) => (cc.used = 'acc'));
      dbg.accidentals.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, type: shape.type });
    }

    // --- Slurs and ties: long, thin arcs ---
    st.arcs = [];
    for (const c of comps) {
      if (c.used || headComps.has(c.id) || c.isBarline) continue;
      const ws = c.w / sp, hs = c.h / sp;
      if (ws < 1.3 || hs < 0.2 || hs > Math.max(2, 0.45 * ws) || c.area / c.w > 0.45 * sp) continue;
      if (c.h <= st.lt + 2 || hs < 0.25) continue; // straight thin line (ledger line)
      c.used = 'arc';
      const endY = (x) => { let s = 0, n = 0; for (let y = c.y0; y <= c.y1; y++) if (labels[y * w + x] === c.id) { s += y; n++; } return n ? s / n : c.cy; };
      st.arcs.push({ c, yL: endY(c.x0), yR: endY(c.x1) });
    }

    // --- Rests ---
    const rests = blockRests;
    for (const c of comps) {
      if (c.used || headComps.has(c.id) || c.isBarline || c.cx < headerX) continue;
      const ws = c.w / sp, hs = c.h / sp, fill = c.area / (c.w * c.h);
      const pos = st.posAt(c.cx, c.cy);
      if (pos < 0.5 || pos > 7.5) continue;
      let dur = 0;
      if (fill > 0.75 && ws > 0.7 && ws < 1.7 && hs > 0.25 && hs < 0.8) dur = pos >= 5 ? 16 : 8; // whole hangs from line 4, half sits on line 3
      else if (fill < 0.28 || c.area / c.h < 0.22 * sp) continue; // too thin: a piece of a slur
      else if (hs >= 1.9 && hs <= 3.5 && ws >= 0.5 && ws <= 1.4) dur = 4;
      else if (hs >= 1.1 && hs < 1.9 && ws >= 0.5 && ws <= 1.4) dur = 2;
      if (!dur) continue;
      c.used = 'rest';
      rests.push({ x: c.cx, dur, whole: dur === 16 && fill > 0.75 });
      dbg.rests.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, dur });
    }

    // --- Pitches ---
    for (const hd of heads) {
      hd.pos = Math.round(st.posAt(hd.cx, hd.cy));
      const bottomDiatonic = clef === 'bass' ? 2 * 7 + 4 : 4 * 7 + 2; // G2 or E4 on the bottom line
      hd.diatonic = bottomDiatonic + hd.pos;
    }
    heads.sort((a, b) => a.cx - b.cx);

    // Ties vs slurs. A tie joins two noteheads of the same pitch; anything else is a slur (legato).
    for (const arc of st.arcs) {
      const { c } = arc;
      const near = (x, y, side) => {
        let best = null;
        for (const hd of heads) {
          const dx = side < 0 ? (c.x0 - hd.cx) / sp : (hd.cx - c.x1) / sp;
          const dy = Math.abs(hd.cy - y) / sp;
          if (dx > -1.0 && dx < 1.3 && dy < 1.6 && (!best || Math.abs(dx) + dy < best.s)) best = { hd, s: Math.abs(dx) + dy };
        }
        return best && best.hd;
      };
      const A = near(c.x0, arc.yL, -1), B = near(c.x1, arc.yR, 1);
      const inside = heads.filter((hd) => hd.cx >= c.x0 - 0.9 * sp && hd.cx <= c.x1 + 0.9 * sp && Math.abs(hd.cy - c.cy) < 4.5 * sp);
      const groups = new Set(inside.map((hd) => Math.round(hd.cx / sp)));
      const openRight = !B && c.x1 > st.right - 2.5 * sp;
      if (A && ((B && B !== A && A.pos === B.pos && groups.size <= 2) || openRight)) {
        A.tieForward = true;
        arc.tie = true;
      } else if (inside.length >= 2) {
        const last = inside.reduce((m, hd) => (hd.cx > m.cx ? hd : m));
        inside.forEach((hd) => { if (hd !== last) hd.legato = true; });
      }
      dbg.slurs.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, tie: !!arc.tie });
    }

    // --- Events grouped into measures, with accidentals applied per measure ---
    const events = [];
    const chords = [];
    for (const hd of heads) {
      const last = chords[chords.length - 1];
      const shareStem = last && hd.stem && last.stemX != null && Math.abs(hd.stem.x - last.stemX) < 0.35 * sp;
      if (last && (Math.abs(hd.cx - last.x) < 0.6 * sp || shareStem)) {
        last.heads.push(hd);
        last.dur = Math.max(last.dur, hd.dur);
      } else {
        chords.push({ x: hd.cx, heads: [hd], dur: hd.dur, stemX: hd.stem ? hd.stem.x : null });
      }
    }
    for (const ch of chords) events.push({ type: 'chord', x: ch.x, dur: ch.dur, heads: ch.heads });
    for (const r of rests) events.push({ type: 'rest', x: r.x, dur: r.dur, whole: r.whole });
    events.sort((a, b) => a.x - b.x);

    const bars = st.barlines.filter((b) => b.x > headerX + sp).map((b) => b.x);
    const edges = [headerX, ...bars];
    if (st.right - edges[edges.length - 1] > 2 * sp) edges.push(st.right + 1);
    st.measures = [];
    for (let i = 0; i + 1 < edges.length; i++) {
      const evs = events.filter((e) => e.x >= edges[i] && e.x < edges[i + 1]);
      if (!evs.length && i === edges.length - 2 && edges[i + 1] > st.right) continue;
      // accidentals last until the barline
      const measureAlter = new Map();
      for (const e of evs) {
        if (e.type !== 'chord') continue;
        for (const hd of e.heads) {
          if (hd.acc) measureAlter.set(hd.diatonic, hd.acc === 'sharp' ? 1 : hd.acc === 'flat' ? -1 : 0);
          const letter = ((hd.diatonic % 7) + 7) % 7;
          const alter = measureAlter.has(hd.diatonic) ? measureAlter.get(hd.diatonic) : keyAlter[letter];
          const octave = Math.floor(hd.diatonic / 7);
          hd.midi = 12 * (octave + 1) + STEP_DIATONIC[letter] + alter;
          hd.name = LETTERS[letter] + (alter > 0 ? '♯' : alter < 0 ? '♭' : '') + octave;
        }
      }
      st.measures.push({ x0: edges[i], x1: edges[i + 1], events: evs, sum: evs.reduce((s, e) => s + e.dur, 0) });
    }

    for (const hd of heads) {
      dbg.heads.push({ x: hd.cx, y: hd.cy, r: sp * 0.6, filled: hd.filled, name: hd.name || '?', dur: hd.dur, legato: !!hd.legato, tie: !!hd.tieForward, acc: hd.acc || null });
    }
    for (const b of st.barlines) dbg.barlines.push({ x: b.x, y0: st.top, y1: st.bottom });
    st.heads = heads;
    st.sp = sp;
  }

  // Lay measures out in time (16th-note steps) and produce piano-roll notes.
  function buildTimeline(result, opts) {
    const all = result.staves.flatMap((s) => s.measures);
    let barLen = opts.barLen && opts.barLen !== 'auto' ? +opts.barLen : null;
    if (!barLen) {
      const sums = all.filter((m) => m.events.length && !(m.events.length === 1 && m.events[0].whole)).map((m) => Math.round(m.sum));
      const m = mode(sums.filter((s) => s >= 4 && s <= 32));
      barLen = m.value && m.count >= Math.max(1, sums.length * 0.3) ? m.value : 16;
    }
    result.barLen = barLen;
    result.timeSig = { 16: '4/4', 12: '3/4 or 6/8', 8: '2/4', 4: '1/4', 24: '6/4 or 12/8', 20: '5/4', 6: '3/8', 14: '7/8' }[barLen] || barLen / 4 + '/4';

    const notes = [];
    let measureBase = 0, firstMeasure = true;
    result.estimatedMeasures = 0;
    for (const system of result.systems) {
      let count = 0;
      for (const st of system) {
        st.measures.forEach((m, k) => {
          const offs = placeMeasure(m, barLen, firstMeasure && k === 0);
          if (offs.estimated) result.estimatedMeasures++;
          m.events.forEach((e, i) => {
            if (e.type !== 'chord') return;
            const start = (measureBase + k) * barLen + offs[i].start;
            for (const hd of e.heads) {
              if (hd.midi == null) continue;
              notes.push({ m: hd.midi, start, len: Math.max(1, offs[i].len), legato: !!hd.legato, tie: !!hd.tieForward, name: hd.name });
            }
          });
        });
        count = Math.max(count, st.measures.length);
      }
      if (count) firstMeasure = false;
      measureBase += count;
    }
    // Merge tied notes into one longer note.
    notes.sort((a, b) => a.start - b.start || a.m - b.m);
    const out = [];
    for (const n of notes) {
      if (n.merged) continue;
      let cur = n;
      while (cur.tie) {
        const nxt = notes.find((o) => !o.merged && o !== n && o.m === n.m && Math.abs(o.start - (n.start + n.len)) <= 1);
        if (!nxt) break;
        n.len = nxt.start + nxt.len - n.start;
        nxt.merged = true;
        cur = nxt;
        n.tie = nxt.tie;
      }
      out.push({ m: n.m, start: n.start, len: n.len, legato: n.legato, name: n.name });
    }
    result.notes = out;
    result.measureCount = measureBase;
    result.totalSteps = measureBase * barLen;
  }

  // Offsets within a measure. Trust the notated durations when they add up; otherwise fall back to
  // horizontal spacing (missed rests) or squeeze proportionally (over-full measures).
  function placeMeasure(m, barLen, isFirst) {
    const evs = m.events;
    if (!evs.length) return [];
    const res = [];
    let t = 0;
    const sum = m.sum;
    if (evs.length === 1 && evs[0].whole) return [{ start: 0, len: barLen }];
    if (Math.abs(sum - barLen) < 0.5 || (isFirst && sum < barLen)) {
      const shift = isFirst && sum < barLen ? barLen - sum : 0; // pickup bar
      for (const e of evs) { res.push({ start: Math.round(t + shift), len: Math.round(e.dur) }); t += e.dur; }
    } else if (sum > barLen) {
      res.estimated = true;
      const k = barLen / sum;
      for (const e of evs) { res.push({ start: Math.round(t * k), len: Math.max(1, Math.round(e.dur * k)) }); t += e.dur; }
    } else {
      res.estimated = true;
      const span = m.x1 - m.x0;
      for (const e of evs) res.push({ start: clamp(Math.round(((e.x - m.x0) / span) * barLen - 0.5), 0, barLen - 1), len: Math.round(e.dur) });
    }
    // keep onsets increasing and notes from running into the next event or the barline
    for (let i = 0; i < res.length; i++) {
      if (i && res[i].start <= res[i - 1].start) res[i].start = Math.min(barLen - 1, res[i - 1].start + 1);
      const limit = (i + 1 < res.length ? res[i + 1].start : barLen) - res[i].start;
      res[i].len = clamp(res[i].len, 1, Math.max(1, limit));
    }
    return res;
  }

  // Convenience for the page: scale an image so staff spacing lands near `target` pixels, then recognize.
  function recognizeImage(source, opts = {}) {
    const maxSide = 2600;
    const draw = (scale) => {
      const w = Math.max(1, Math.round(source.width * scale)), h = Math.max(1, Math.round(source.height * scale));
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const g = cv.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, w, h);
      g.imageSmoothingQuality = 'high';
      g.drawImage(source, 0, 0, w, h);
      return { canvas: cv, data: g.getImageData(0, 0, w, h) };
    };
    let scale = Math.min(1, maxSide / Math.max(source.width, source.height));
    let pass = draw(scale);
    // quick metrics pass to pick a good working resolution
    const gray = toGray(pass.data);
    const { sp } = staffMetrics(binarize(gray, pass.data.width, pass.data.height), pass.data.width, pass.data.height);
    const target = 16;
    if (sp > 4 && (sp < 13 || sp > 26)) {
      const s2 = clamp(scale * (target / sp), 0.1, 4);
      if (Math.max(source.width, source.height) * s2 <= 4200) { scale = s2; pass = draw(scale); }
    }
    const result = recognize(pass.data, opts);
    if (result.gray) {
      // show the straightened image so the overlay lines up
      const g = pass.canvas.getContext('2d'), d = g.getImageData(0, 0, result.width, result.height);
      for (let i = 0; i < result.gray.length; i++) d.data[4 * i] = d.data[4 * i + 1] = d.data[4 * i + 2] = result.gray[i];
      g.putImageData(d, 0, 0);
    }
    result.canvas = pass.canvas;
    result.scale = scale;
    return result;
  }

  global.OMR = { recognize, recognizeImage, _internals: { toGray, binarize, staffMetrics, findStaves, estimateSkew, rotateGray } };
})(typeof window !== 'undefined' ? window : globalThis);
