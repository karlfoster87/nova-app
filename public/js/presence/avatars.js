// Avatars for the presence panel. Each one is driven only by what the
// panel hands it: the state (idle, thinking, writing, tool, waiting) and how many sub-agents
// are running. Both draw on a canvas.
// With reduced motion the canvas avatars draw one still frame per change, and none of them
// draws while hidden (the Logs tab, a closed drawer, a background browser tab).

// The picker's choices. An unknown id (such as a browser that had chosen the retired Ghost
// placeholder) falls back to Ripple.
export const AVATARS = [{ id: 'ripple', label: 'Ripple' }, { id: 'rob', label: 'Rob' }];

export function mountAvatar(id, stage) {
  return ({ rob }[id] || ripple)(stage);
}

const TAU = Math.PI * 2;
const WORDS = { idle: 'Standing by', thinking: 'Thinking', writing: 'Responding', tool: 'Running tools', waiting: 'Awaiting input' };

// ---- Colours ------------------------------------------------------------------
// The state colours are the theme's tokens, read once and again when the theme changes.
// light: the page is in light mode (data-scheme on <html>, set by shell/theme.js), so draw dark on light.
const STATE_TOKENS = { idle: '--ok', thinking: '--think', writing: '--accent', tool: '--hot', waiting: '--warn' };
function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return [34, 211, 238];
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}
function palette(el) {
  const cs = getComputedStyle(el);
  const out = { accent: rgb(cs.getPropertyValue('--accent')), ink: rgb(cs.getPropertyValue('--ink')),
    light: document.documentElement.dataset.scheme === 'light' };
  for (const [state, token] of Object.entries(STATE_TOKENS)) out[state] = rgb(cs.getPropertyValue(token));
  return out;
}
const css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const whiten = (c, k) => c.map((v) => v + (255 - v) * k);
// Highlights: paler on a dark stage, the plain colour on a light one (paler would wash out).
const lift = (s, c, k) => (s.colors.light ? c : whiten(c, k));
const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const easeOut = (p) => 1 - (1 - p) ** 3;

// ---- Canvas scaffolding -----------------------------------------------------------
// Sizes the canvas to the stage at device resolution and runs draw(ctx, s) each frame.
// s: { w, h, t (seconds), dt, state, prev, changedAt, agents, colors, still }.
function canvasAvatar(stage, draw, onState = () => {}) {
  const canvas = document.createElement('canvas');
  stage.replaceChildren(canvas);
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const s = { w: 0, h: 0, t: 0, dt: 0, state: 'idle', prev: 'idle', changedAt: 0, agents: 0, colors: palette(stage), still: reduce.matches };
  let raf = 0, timer = 0, last = performance.now(), alive = true;

  function size() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    s.w = stage.clientWidth;
    s.h = stage.clientHeight;
    canvas.width = Math.max(1, Math.round(s.w * dpr));
    canvas.height = Math.max(1, Math.round(s.h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function frame(at) {
    raf = timer = 0;
    if (!alive) return;
    s.still = reduce.matches;
    s.dt = s.still ? 1 : Math.min(0.1, Math.max(0, (at - last) / 1000)); // a still frame settles every transition
    last = at;
    s.t += s.dt;
    if (s.w && s.h) { ctx.clearRect(0, 0, s.w, s.h); draw(ctx, s); }
    if (s.still) return;
    // Hidden: look again now and then instead of drawing every frame.
    if (document.hidden || !stage.offsetParent) timer = setTimeout(() => frame(performance.now()), 400);
    else raf = requestAnimationFrame(frame);
  }
  const redraw = () => { if (!raf && !timer) frame(performance.now()); };

  const ro = new ResizeObserver(() => { size(); if (s.still) frame(performance.now()); });
  ro.observe(stage);
  // Theme changes swap the colour tokens.
  const mo = new MutationObserver(() => { s.colors = palette(stage); redraw(); });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-scheme'] });
  reduce.addEventListener('change', redraw);
  size();
  redraw();

  return {
    set(state, { agents = 0 } = {}) {
      if (state !== s.state) { s.prev = s.state; s.state = state; s.changedAt = s.t; onState(state, s); }
      s.agents = agents;
      if (s.still) frame(performance.now());
    },
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      ro.disconnect();
      mo.disconnect();
      reduce.removeEventListener('change', redraw);
    }
  };
}

// A small readout along the bottom edge, like a HUD.
function hud(ctx, s, col) {
  ctx.save();
  ctx.font = '600 9.5px "JetBrains Mono", monospace';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = css(col, 0.85);
  ctx.fillText(`// ${WORDS[s.state].toUpperCase()}`, 12, s.h - 11);
  ctx.textAlign = 'right';
  ctx.fillStyle = css(s.colors.accent, s.agents ? 0.9 : 0.45);
  ctx.fillText(s.agents ? `LINK x${s.agents}` : 'LINK IDLE', s.w - 12, s.h - 11);
  ctx.restore();
}

// ---- Ripple: rings of light from a bright core --------------------------------------
// How often a ring leaves the core, and how long it lives, per state (seconds).
const RINGS = { idle: [2.6, 3.6], thinking: [1.3, 2.5], writing: [0.42, 1.4], tool: [0.8, 1.8], waiting: [1.7, 2.8] };
const BREATH = { idle: 1.2, thinking: 2.2, writing: 7, tool: 4, waiting: 3 };

function ripple(stage) {
  const rings = [];
  let nextAt = 0, col = null, spin = 0;
  return canvasAvatar(stage, (ctx, s) => {
    const { w, h, t, dt } = s;
    col = col ? mix(col, s.colors[s.state], clamp(dt * 4)) : s.colors[s.state];
    const fade = clamp((t - s.changedAt) / 0.5); // state-specific layers fade in
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.42;
    const [every, life] = RINGS[s.state];

    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.4);
    bg.addColorStop(0, css(col, 0.17));
    bg.addColorStop(1, css(col, 0));
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Polar grid and a slowly turning tick ring
    ctx.lineWidth = 1;
    ctx.strokeStyle = css(s.colors.accent, s.colors.light ? 0.14 : 0.08);
    ctx.beginPath();
    for (let i = 1; i <= 4; i++) { ctx.moveTo(cx + (R * i) / 4, cy); ctx.arc(cx, cy, (R * i) / 4, 0, TAU); }
    ctx.moveTo(cx - R * 1.15, cy); ctx.lineTo(cx + R * 1.15, cy);
    ctx.moveTo(cx, cy - R * 1.15); ctx.lineTo(cx, cy + R * 1.15);
    ctx.stroke();
    spin += dt * (s.state === 'tool' ? 1.2 : s.state === 'thinking' ? 0.3 : 0.06);
    ctx.strokeStyle = css(col, 0.4);
    ctx.beginPath();
    for (let i = 0; i < 72; i++) {
      const a = spin + (i * TAU) / 72, r2 = R * (i % 6 ? 1.05 : 1.1);
      ctx.moveTo(cx + Math.cos(a) * R * 1.01, cy + Math.sin(a) * R * 1.01);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
    }
    ctx.stroke();

    // Rings
    if (s.still) { rings.length = 0; for (let i = 0; i < 3; i++) rings.push({ born: t - (life * (i + 0.5)) / 3, seed: i }); }
    else if (t >= nextAt) { rings.push({ born: t, seed: Math.random() * 10 }); nextAt = t + every; }
    ctx.save();
    ctx.shadowColor = css(col, 0.9);
    ctx.shadowBlur = s.colors.light ? 5 : 12;
    for (let i = rings.length - 1; i >= 0; i--) {
      const p = (t - rings[i].born) / life;
      if (p >= 1) { rings.splice(i, 1); continue; }
      const r = R * (0.2 + 0.8 * easeOut(p));
      ctx.strokeStyle = css(lift(s, col, 0.2 * (1 - p)), (1 - p) ** 1.4 * 0.9);
      ctx.lineWidth = 0.6 + 2.4 * (1 - p);
      ctx.beginPath();
      if (s.state === 'writing') { // speech: the ring ripples like a sound wave
        for (let k = 0; k <= 120; k++) {
          const a = (k / 120) * TAU;
          const rr = r + Math.sin(a * 8 + t * 10 + rings[i].seed) * R * 0.03 * (1 - p);
          if (k) ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); else ctx.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
        }
        ctx.closePath();
      } else ctx.arc(cx, cy, r, 0, TAU);
      ctx.stroke();
    }

    if (s.state === 'thinking') { // orbiting arcs
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      for (let k = 0; k < 3; k++) {
        const a = t * (1.4 - k * 0.95) + k * 2.1;
        ctx.strokeStyle = css(lift(s, col, 0.25), 0.9 * fade);
        ctx.beginPath();
        ctx.arc(cx, cy, R * (0.3 + k * 0.11), a, a + 1.2 - k * 0.25);
        ctx.stroke();
      }
    }
    if (s.state === 'tool') { // radar sweep and a racing dashed ring
      const a = t * 2.6;
      ctx.shadowBlur = 0;
      for (let k = 0; k < 16; k++) {
        ctx.fillStyle = css(col, 0.13 * (1 - k / 16) * fade);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R, a - (k + 1) * 0.045, a - k * 0.045);
        ctx.closePath();
        ctx.fill();
      }
      ctx.setLineDash([5, 9]);
      ctx.lineDashOffset = -t * 50;
      ctx.strokeStyle = css(col, 0.7 * fade);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.88, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (s.state === 'waiting') { // a ring that pulses for attention
      const pulse = s.still ? 1 : 0.5 + 0.5 * Math.sin(t * 3.2);
      ctx.strokeStyle = css(col, (0.25 + 0.6 * pulse) * fade);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, R * (0.58 + 0.03 * pulse), 0, TAU);
      ctx.stroke();
    }

    // Sub-agents orbit as satellites, each sending packets to the core.
    for (let k = 0; k < s.agents; k++) {
      const a = t * 0.45 + (k * TAU) / s.agents;
      const x = cx + Math.cos(a) * R * 0.8, y = cy + Math.sin(a) * R * 0.8;
      ctx.shadowBlur = 0;
      ctx.strokeStyle = css(s.colors.accent, 0.2);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(cx, cy); ctx.stroke();
      ctx.shadowBlur = 8;
      ctx.shadowColor = css(s.colors.accent, 1);
      for (const off of [0, 0.5]) {
        const p = (t * 0.8 + k / s.agents + off) % 1;
        ctx.fillStyle = css(lift(s, s.colors.accent, 0.4), 0.95 * (1 - p * 0.5));
        ctx.beginPath(); ctx.arc(x + (cx - x) * p, y + (cy - y) * p, 1.7, 0, TAU); ctx.fill();
      }
      ctx.fillStyle = css(s.colors.accent, 1);
      ctx.beginPath(); ctx.arc(x, y, 3.4, 0, TAU); ctx.fill();
      ctx.strokeStyle = css(s.colors.accent, 0.5);
      ctx.beginPath(); ctx.arc(x, y, 7 + Math.sin(t * 4 + k) * 1.2, 0, TAU); ctx.stroke();
    }

    // Core
    const r0 = R * 0.15 * (1 + 0.08 * (s.still ? 0 : Math.sin(t * BREATH[s.state])));
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, r0 * 2.4);
    core.addColorStop(0, s.colors.light ? css(whiten(col, 0.55), 1) : 'rgba(255,255,255,0.95)');
    core.addColorStop(0.3, css(lift(s, col, 0.3), 0.95));
    core.addColorStop(1, css(col, 0));
    ctx.shadowBlur = 0;
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(cx, cy, r0 * 2.4, 0, TAU); ctx.fill();
    ctx.strokeStyle = css(col, 0.85);
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(cx, cy, r0 * 1.55, 0, TAU); ctx.stroke();
    ctx.restore();
    hud(ctx, s, col);
  });
}

// ---- Rob: robot eyes on an LED matrix ---------------------------------------------------
// The whole window is a dot-matrix display showing a pair of eyes, in the manner of EVE from
// WALL-E. Eye shapes are sampled onto the LEDs, so expressions morph by blending the old shape
// into the new one. The eyes hop on a spring when the state changes and bob to each state's
// rhythm. Shapes are measured in units of half the window's width, so they stay round.
const EYE_X = 0.47; // each eye's centre from the middle
const TILT = 0.14;  // how far the resting ovals lean, inner ends up
const COLS = 46;    // LEDs across

function rob(stage) {
  let col = null, y = 0, vy = 0, morph = 1, expr = 'idle', prevExpr = 'idle';
  let blinkAt = 2, blinkT = -9, lookAt = 3;
  const look = [0, 0], lookTo = [0, 0], prevLook = [0, 0];
  const rand = (a, b) => a + Math.random() * (b - a);

  // Brightness 0..1 of the eyes at (x, y), in units, for an expression.
  function field(e, x, yy, open, lk, t) {
    let best = 0;
    for (const side of [-1, 1]) {
      const du = x - (side * EYE_X + lk[0]), dv = yy - lk[1];
      const shape = (rx, ry, rot, dy = 0) => {
        const c = Math.cos(rot), s = Math.sin(rot);
        const a = du * c + dv * s, b = -du * s + dv * c - dy;
        return { d: Math.hypot(a / rx, b / ry), b };
      };
      const soft = (d) => clamp((1.04 - d) / 0.1);
      let I;
      if (e === 'writing') { // happy: upturned arcs
        const outer = shape(0.34, 0.3, side * 0.1), inner = shape(0.36, 0.3, side * 0.1, 0.16);
        I = outer.b < 0.06 ? Math.min(soft(outer.d), clamp((inner.d - 0.96) / 0.1)) : 0;
      } else if (e === 'tool') { // focused: narrow bars with a scan running across
        I = soft(shape(0.37, 0.1, 0).d);
        if (I > 0.1 && Math.abs(x - Math.sin(t * 3.2) * 0.95) < 0.05) I = 1;
        else I *= 0.7;
      } else if (e === 'thinking') { // pensive: lids lowered, looking up and aside
        const o = shape(0.32, 0.21 * open, side * 0.08);
        I = soft(o.d) * (o.b < -0.08 ? 0.25 : 1);
      } else if (e === 'waiting') { // wide open, with a highlight
        I = soft(shape(0.32, 0.36 * open, side * 0.05).d);
        if (Math.hypot((du - 0.11) / 0.08, (dv + 0.13) / 0.08) < 1) I *= 0.12;
      } else { // resting ovals
        I = soft(shape(0.34, 0.27 * open, side * TILT).d);
      }
      best = Math.max(best, I);
    }
    if (e === 'thinking') { // three dots lighting in turn
      const lit = Math.floor(t * 3) % 3;
      for (let k = 0; k < 3; k++) if (Math.hypot(x - (0.28 + k * 0.13), yy - 0.4) < 0.045) best = Math.max(best, k === lit ? 1 : 0.3);
    }
    return best;
  }

  return canvasAvatar(stage, (ctx, s) => {
    const { w, h, t, dt } = s;
    const light = s.colors.light;
    col = col ? mix(col, s.colors[s.state], clamp(dt * 5)) : s.colors[s.state];
    morph = clamp(morph + dt / 0.32);
    const U = w / 2;

    // Spring hop, plus a per-state bob (pixels)
    vy += (-110 * y - 10 * vy) * dt;
    y += vy * dt;
    const bob = s.still ? 0 : {
      idle: Math.sin(t * 1.7) * U * 0.03, thinking: Math.sin(t * 1.1) * U * 0.02, writing: -Math.abs(Math.sin(t * 5.2)) * U * 0.05,
      tool: Math.sin(t * 16) * U * 0.006, waiting: Math.sin(t * 2.3) * U * 0.035
    }[s.state];

    // Where the eyes look
    if (s.state === 'thinking') { lookTo[0] = 0.08; lookTo[1] = -0.14; }
    else if (s.state === 'idle') {
      if (t > lookAt) { lookTo[0] = rand(-0.12, 0.12); lookTo[1] = rand(-0.06, 0.05); lookAt = t + rand(2, 5); }
    } else { lookTo[0] = 0; lookTo[1] = s.state === 'writing' ? 0.03 : 0; }
    look[0] += (lookTo[0] - look[0]) * clamp(dt * 7);
    look[1] += (lookTo[1] - look[1]) * clamp(dt * 7);

    // Blinks, now and then a double one
    if (!s.still && t > blinkAt) { blinkT = t; blinkAt = t + (Math.random() < 0.2 ? 0.35 : rand(2.5, 6)); }
    const bp = (t - blinkT) / 0.17;
    const open = s.state === 'writing' || s.state === 'tool' || bp < 0 || bp > 1 ? 1 : 1 - Math.sin(Math.PI * bp) * 0.93;
    const squash = clamp(1 - vy / U * 0.35, 0.82, 1.18); // the eyes stretch as they spring
    const oy = h / 2 + y + bob;

    if (!light && s.state !== 'writing' && s.state !== 'tool') { // a soft bloom behind each eye (not behind thin shapes, where it reads as a ghost of the oval)
      for (const side of [-1, 1]) {
        const ex = w / 2 + (side * EYE_X + look[0]) * U, ey = oy + look[1] * U;
        const g = ctx.createRadialGradient(ex, ey, 0, ex, ey, U * 0.5);
        g.addColorStop(0, css(col, 0.1 * morph));
        g.addColorStop(1, css(col, 0));
        ctx.fillStyle = g;
        ctx.fillRect(ex - U * 0.6, ey - U * 0.6, U * 1.2, U * 1.2);
      }
    }

    // LEDs, batched by brightness so there are only a few fills
    const cell = w / COLS, rows = Math.ceil(h / cell);
    const top = (h - rows * cell) / 2;
    const dim = new Path2D(), levels = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < COLS; c++) {
        const px = (c + 0.5) * cell, py = top + (r + 0.5) * cell;
        const x = (px - w / 2) / U, yy = (py - oy) / U / squash;
        let I = field(expr, x, yy, open, look, t);
        if (morph < 1) I = I * morph + field(prevExpr, x, yy, open, prevLook, t) * (1 - morph);
        if (I < 0.08) { dim.moveTo(px + cell * 0.16, py); dim.arc(px, py, cell * 0.16, 0, TAU); continue; }
        const lvl = Math.min(3, Math.floor(I * 4));
        const rr = cell * (0.26 + 0.14 * I);
        levels[lvl].moveTo(px + rr, py);
        levels[lvl].arc(px, py, rr, 0, TAU);
      }
    }
    ctx.fillStyle = light ? css(s.colors.ink, 0.07) : css(col, 0.07);
    ctx.fill(dim);
    ctx.shadowColor = css(col, 1);
    levels.forEach((p, i) => {
      ctx.shadowBlur = i === 3 ? (light ? 2 : 6) : 0;
      ctx.fillStyle = css(light ? col : whiten(col, i === 3 ? 0.35 : 0.1), 0.35 + i * 0.22);
      ctx.fill(p);
    });

    // Sub-agents light a row of LEDs near the bottom, in turn, like a link in use.
    const n = Math.min(8, s.agents);
    for (let k = 0; k < n; k++) {
      const c = Math.round(COLS / 2 + (k - (n - 1) / 2) * 2 - 0.5);
      const px = (c + 0.5) * cell, py = top + (rows - 4.5) * cell;
      const on = s.still || Math.floor(t * 5) % n === k;
      ctx.fillStyle = css(s.colors.accent, on ? 1 : 0.4);
      ctx.shadowColor = css(s.colors.accent, 1);
      ctx.shadowBlur = on && !light ? 8 : 0;
      ctx.beginPath(); ctx.arc(px, py, cell * 0.38, 0, TAU); ctx.fill();
    }
    ctx.shadowBlur = 0;
    hud(ctx, s, col);
  }, (state, s) => {
    prevExpr = expr;
    expr = state;
    prevLook[0] = look[0]; prevLook[1] = look[1];
    morph = s.still ? 1 : 0;
    vy -= (s.w / 2) * 1.3; // hop
  });
}
