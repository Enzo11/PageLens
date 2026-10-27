/* PageLens — lib/color.js
 * Pure color math shared by the popup, content scripts and (later) the report page.
 * Classic script: attaches PageLensColor to globalThis so it works both as a
 * <script> in extension pages and as an injected content-script file.
 */
(function (root) {
  'use strict';

  const cache = new Map();
  let ctx = null;

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  function fromHex(str) {
    let h = str.replace('#', '').trim();
    if (![3, 4, 6, 8].includes(h.length) || /[^0-9a-f]/i.test(h)) return null;
    if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1 };
  }

  // Fallback for oklch(), lab(), color(), named colors, etc.: let a 1×1 canvas
  // convert to sRGB pixels. Deterministic for a given browser.
  function viaCanvas(str) {
    try {
      if (!ctx) {
        const cv = typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(1, 1)
          : Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
        ctx = cv.getContext('2d', { willReadFrequently: true });
      }
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#010203';
      ctx.fillStyle = str;
      if (ctx.fillStyle === '#010203' && str !== '#010203') return null; // invalid color
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      if (d[3] === 0) return { r: 0, g: 0, b: 0, a: 0 };
      return { r: d[0], g: d[1], b: d[2], a: Math.round((d[3] / 255) * 1000) / 1000 };
    } catch {
      return null;
    }
  }

  const RGB_RE = /^rgba?\(\s*([^)]*)\)$/i;

  /** Parse any CSS color string into {r,g,b,a} (0–255, alpha 0–1), or null. */
  function parse(input) {
    if (input == null) return null;
    const str = String(input).trim().toLowerCase();
    if (!str || str === 'none' || str === 'currentcolor' || str === 'inherit' || str === 'initial') return null;
    if (str === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (cache.has(str)) return cache.get(str);

    let out = null;
    const m = RGB_RE.exec(str);
    if (m) {
      const parts = m[1].split(/[\s,/]+/).filter(Boolean);
      if (parts.length >= 3) {
        const ch = (v) => (v.endsWith('%') ? parseFloat(v) * 2.55 : parseFloat(v));
        const al = (v) => (v == null ? 1 : v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v));
        out = {
          r: clamp(Math.round(ch(parts[0])), 0, 255),
          g: clamp(Math.round(ch(parts[1])), 0, 255),
          b: clamp(Math.round(ch(parts[2])), 0, 255),
          a: clamp(al(parts[3]), 0, 1)
        };
        if ([out.r, out.g, out.b, out.a].some(Number.isNaN)) out = null;
      }
    } else if (str[0] === '#') {
      out = fromHex(str);
    }
    if (!out) out = viaCanvas(str);

    if (cache.size > 4000) cache.clear();
    cache.set(str, out);
    return out;
  }

  const hex2 = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');

  /** '#rrggbb', or '#rrggbbaa' when alpha < 1. */
  function toHex(c) {
    if (!c) return null;
    const base = '#' + hex2(c.r) + hex2(c.g) + hex2(c.b);
    return c.a != null && c.a < 0.999 ? base + hex2(c.a * 255) : base;
  }

  /** Composite fg over bg (both {r,g,b,a}). */
  function blend(fg, bg) {
    if (!fg) return bg;
    if (!bg || fg.a >= 1) return { ...fg, a: fg.a ?? 1 };
    const a = fg.a + bg.a * (1 - fg.a);
    if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (f, b) => (f * fg.a + b * bg.a * (1 - fg.a)) / a;
    return { r: Math.round(mix(fg.r, bg.r)), g: Math.round(mix(fg.g, bg.g)), b: Math.round(mix(fg.b, bg.b)), a };
  }

  /** WCAG 2.x relative luminance. */
  function luminance(c) {
    const lin = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  }

  /** WCAG contrast ratio, 1–21. */
  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
  }

  function rgbToHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h, s, l };
  }

  function hslToRgb({ h, s, l }) {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255), a: 1 };
  }

  function rgbToLab({ r, g, b }) {
    const lin = (v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const R = lin(r), G = lin(g), B = lin(b);
    let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    let y = R * 0.2126 + G * 0.7152 + B * 0.0722;
    let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    x = f(x); y = f(y); z = f(z);
    return { L: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
  }

  /** CIE76 distance. < 2.3 is barely noticeable; < 5 looks like "the same color". */
  function deltaE(c1, c2) {
    const a = rgbToLab(c1);
    const b = rgbToLab(c2);
    return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);
  }

  /** Flatten a translucent color onto white for display/comparison. */
  function flatten(c, bg = { r: 255, g: 255, b: 255, a: 1 }) {
    return c && c.a < 1 ? blend(c, bg) : c;
  }

  function isNeutral(c) {
    const { s, l } = rgbToHsl(c);
    return s < 0.12 || l < 0.06 || l > 0.97;
  }

  /** Black or white, whichever reads better on c. */
  function inkOn(c) {
    const f = flatten(c);
    return contrast(f, { r: 0, g: 0, b: 0, a: 1 }) >= contrast(f, { r: 255, g: 255, b: 255, a: 1 }) ? '#000000' : '#ffffff';
  }

  /**
   * Smallest lightness change to fg (keeping hue and saturation) that reaches
   * `target` contrast on bg. Returns hex or null. Deterministic.
   */
  function suggestPassing(fg, bg, target = 4.5) {
    const base = rgbToHsl(fg);
    if (contrast(fg, bg) >= target) return toHex({ ...fg, a: 1 });
    for (let step = 0.01; step <= 1; step += 0.01) {
      for (const dir of [-1, 1]) {
        const l = base.l + dir * step;
        if (l < 0 || l > 1) continue;
        const cand = hslToRgb({ h: base.h, s: base.s, l });
        if (contrast(cand, bg) >= target) return toHex(cand);
      }
    }
    return null;
  }

  root.PageLensColor = Object.freeze({
    parse, fromHex, toHex, blend, flatten, luminance, contrast,
    rgbToHsl, hslToRgb, rgbToLab, deltaE, isNeutral, inkOn, suggestPassing
  });
})(globalThis);
