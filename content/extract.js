/* PageLens — content/extract.js
 *
 * Injected on demand (chrome.scripting.executeScript) after lib/color.js.
 * Reads the rendered page and returns one plain, serializable object.
 * It measures; it does not judge. Rules live in content/analyze.js (Day 2).
 *
 * Privacy guarantees enforced here:
 *   - never reads form field values, cookie values or storage values (names only)
 *   - strips query strings and fragments from every URL it reports
 *   - never sends anything anywhere; the popup receives the return value
 *
 * The file's last expression is a Promise; Chrome awaits it and hands the
 * resolved value back to the caller.
 */
(async () => {
  'use strict';

  const C = globalThis.PageLensColor;
  if (!C) return { error: 'color-lib-missing' };

  const T0 = performance.now();
  const doc = document;
  const VW = innerWidth;
  const VH = innerHeight;
  const DPR = devicePixelRatio || 1;

  const LIMITS = {
    elements: 6000,
    headings: 300,
    images: 300,
    contrastGroups: 400,
    targets: 200,
    fields: 200,
    forms: 30,
    sections: 30,
    resources: 400,
    listItems: 50
  };

  // ---------------------------------------------------------------- helpers

  const clip = (s, n = 120) => {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  const round = (n, d = 0) => {
    const f = 10 ** d;
    return Math.round(n * f) / f;
  };
  const px = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  const inc = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);

  const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'gob', 'ne', 'or', 'nic']);
  /** Approximate registrable domain ("site"), good enough to tell first from third party. */
  function siteOf(host) {
    host = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!host || /^\d+(\.\d+){3}$/.test(host) || host.includes(':')) return host;
    const p = host.split('.');
    if (p.length <= 2) return host;
    const n = p[p.length - 1].length === 2 && SECOND_LEVEL.has(p[p.length - 2]) ? 3 : 2;
    return p.slice(-n).join('.');
  }

  const pageUrl = new URL(location.href);
  const pageSite = siteOf(pageUrl.hostname);

  /** URL without query/fragment, plus facts about it. */
  function safeUrl(raw) {
    if (!raw) return null;
    try {
      const u = new URL(raw, location.href);
      if (u.protocol === 'data:') {
        const head = String(raw).slice(5, 60).split(',')[0];
        return { url: 'data:' + head, host: '', scheme: 'data', thirdParty: false, query: false };
      }
      if (u.protocol === 'blob:') return { url: 'blob:', host: '', scheme: 'blob', thirdParty: false, query: false };
      return {
        url: clip(u.origin + u.pathname, 200),
        host: u.hostname,
        scheme: u.protocol.slice(0, -1),
        thirdParty: Boolean(u.hostname) && siteOf(u.hostname) !== pageSite,
        query: Boolean(u.search)
      };
    } catch {
      return { url: clip(raw, 80), host: '', scheme: '', thirdParty: false, query: false };
    }
  }

  const idUnique = new Map();
  function isUniqueId(id) {
    if (idUnique.has(id)) return idUnique.get(id);
    let ok = false;
    try { ok = doc.querySelectorAll('#' + CSS.escape(id)).length === 1; } catch { ok = false; }
    idUnique.set(id, ok);
    return ok;
  }

  /** Short, stable CSS selector for click-to-highlight. */
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      if (node === doc.documentElement) { parts.unshift('html'); break; }
      if (node === doc.body) { parts.unshift('body'); break; }
      if (node.id && isUniqueId(node.id)) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let part = CSS.escape(node.localName);
      const parent = node.parentElement;
      if (!parent) { parts.unshift(part); break; }
      let idx = 0;
      let count = 0;
      for (const sib of parent.children) {
        if (sib.localName === node.localName) {
          count += 1;
          if (sib === node) idx = count;
        }
      }
      if (count > 1) part += `:nth-of-type(${idx})`;
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  const styles = new WeakMap();
  function cs(el) {
    let s = styles.get(el);
    if (!s) { s = getComputedStyle(el); styles.set(el, s); }
    return s;
  }

  function isVisible(el) {
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    } else {
      const s = cs(el);
      if (s.display === 'none' || s.visibility !== 'visible' || px(s.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function ownTextLength(el) {
    let n = 0;
    for (const c of el.childNodes) if (c.nodeType === 3) n += c.nodeValue.trim().length;
    return n;
  }
  function ownTextSample(el, n = 50) {
    let t = '';
    for (const c of el.childNodes) if (c.nodeType === 3) t += ' ' + c.nodeValue;
    return clip(t, n);
  }

  // Effective background behind an element: composite translucent layers
  // up to the first opaque one; give up (null) when a background image is in the way.
  const bgMemo = new WeakMap();
  const WHITE = { r: 255, g: 255, b: 255, a: 1 };
  function effectiveBg(el) {
    if (!el || el.nodeType !== 1) return { color: WHITE, image: false };
    if (bgMemo.has(el)) return bgMemo.get(el);
    const s = cs(el);
    let out;
    if (s.backgroundImage && s.backgroundImage !== 'none') {
      out = { color: null, image: true };
    } else {
      const own = C.parse(s.backgroundColor);
      if (own && own.a >= 0.999) out = { color: { ...own, a: 1 }, image: false };
      else {
        const parent = effectiveBg(el.parentElement);
        if (parent.image) out = parent;
        else out = { color: own && own.a > 0 ? C.blend(own, parent.color) : parent.color, image: false };
      }
    }
    bgMemo.set(el, out);
    return out;
  }

  function splitFamilies(stack) {
    const out = [];
    let cur = '';
    let q = null;
    for (const ch of stack) {
      if (q) { if (ch === q) q = null; else cur += ch; }
      else if (ch === '"' || ch === "'") q = ch;
      else if (ch === ',') { if (cur.trim()) out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function textRole(el) {
    if (el.closest('pre, code, kbd, samp')) return 'code';
    if (el.closest('h1, h2, h3, h4, h5, h6, [role="heading"]')) return 'heading';
    if (el.closest('button, a, label, select, nav, [role="button"], [role="tab"], [role="menuitem"]')) return 'ui';
    return 'body';
  }

  function bufferedEntries(type, wait = 80) {
    return new Promise((resolve) => {
      try {
        const list = [];
        const po = new PerformanceObserver((l) => list.push(...l.getEntries()));
        po.observe({ type, buffered: true });
        setTimeout(() => {
          try { list.push(...po.takeRecords()); po.disconnect(); } catch { /* ignore */ }
          resolve(list);
        }, wait);
      } catch {
        resolve([]);
      }
    });
  }

  // Kick these off now; they resolve while we walk the DOM.
  const lcpP = bufferedEntries('largest-contentful-paint');
  const clsP = bufferedEntries('layout-shift');

  // ---------------------------------------------------------------- page + meta

  const meta = (sel, attr = 'content') => {
    const el = doc.querySelector(sel);
    return el ? clip(el.getAttribute(attr), 300) : null;
  };

  const ldTypes = [];
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent);
      const items = Array.isArray(data) ? data : data['@graph'] || [data];
      for (const it of items) if (it && it['@type']) ldTypes.push(String([].concat(it['@type'])[0]).slice(0, 40));
    } catch { ldTypes.push('invalid'); }
  }

  const allElements = doc.getElementsByTagName('*');

  const page = {
    url: pageUrl.origin + pageUrl.pathname,
    hasQuery: Boolean(pageUrl.search),
    host: pageUrl.hostname,
    site: pageSite,
    protocol: pageUrl.protocol.slice(0, -1),
    isIpHost: /^\d+(\.\d+){3}$/.test(pageUrl.hostname) || pageUrl.hostname.startsWith('['),
    isPunycode: pageUrl.hostname.split('.').some((l) => l.startsWith('xn--')),
    title: clip(doc.title, 200),
    lang: doc.documentElement.getAttribute('lang') || null,
    dir: doc.documentElement.getAttribute('dir') || null,
    doctype: doc.doctype ? doc.doctype.name : null,
    charset: doc.characterSet,
    compatMode: doc.compatMode,
    viewport: { width: VW, height: VH, dpr: DPR },
    scrollHeight: Math.max(doc.documentElement.scrollHeight, doc.body ? doc.body.scrollHeight : 0),
    scrollWidth: Math.max(doc.documentElement.scrollWidth, doc.body ? doc.body.scrollWidth : 0),
    elementCount: allElements.length,
    isSecureContext: globalThis.isSecureContext
  };

  const metaInfo = {
    description: meta('meta[name="description" i]'),
    viewport: meta('meta[name="viewport" i]'),
    robots: meta('meta[name="robots" i]'),
    generator: meta('meta[name="generator" i]'),
    themeColor: meta('meta[name="theme-color" i]'),
    canonical: (() => { const h = meta('link[rel="canonical" i]', 'href'); return h ? safeUrl(h).url : null; })(),
    favicon: Boolean(doc.querySelector('link[rel~="icon" i]')),
    manifest: Boolean(doc.querySelector('link[rel="manifest" i]')),
    og: {
      title: meta('meta[property="og:title" i]'),
      description: meta('meta[property="og:description" i]'),
      image: Boolean(doc.querySelector('meta[property="og:image" i]')),
      type: meta('meta[property="og:type" i]')
    },
    twitterCard: meta('meta[name="twitter:card" i]'),
    structuredData: ldTypes.slice(0, 20),
    canonicalCount: doc.querySelectorAll('link[rel="canonical" i]').length,
    hreflang: doc.querySelectorAll('link[rel="alternate"][hreflang]').length
  };

  // ---------------------------------------------------------------- headings

  const headings = [];
  const headingCounts = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
  for (const el of doc.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')) {
    const tag = el.localName;
    let level = /^h[1-6]$/.test(tag) ? Number(tag[1]) : Number(el.getAttribute('aria-level')) || 2;
    if (el.hasAttribute('aria-level') && el.getAttribute('role') === 'heading') level = Number(el.getAttribute('aria-level')) || level;
    level = Math.min(6, Math.max(1, level));
    headingCounts['h' + level] += 1;
    if (headings.length >= LIMITS.headings) continue;
    let text = clip(el.innerText || el.textContent, 120);
    let fromAlt = false;
    if (!text) {
      const img = el.querySelector('img[alt]');
      if (img && img.getAttribute('alt').trim()) { text = clip(img.getAttribute('alt'), 120); fromAlt = true; }
    }
    const s = cs(el);
    headings.push({
      level,
      text,
      fromAlt,
      empty: !text,
      tag,
      visible: isVisible(el),
      fontSize: round(px(s.fontSize), 1),
      fontWeight: Number(s.fontWeight) || 400,
      selector: selectorFor(el)
    });
  }

  // ---------------------------------------------------------------- landmarks

  const landmarks = [];
  const LANDMARKS = [
    ['banner', 'header, [role="banner"]'],
    ['navigation', 'nav, [role="navigation"]'],
    ['main', 'main, [role="main"]'],
    ['complementary', 'aside, [role="complementary"]'],
    ['contentinfo', 'footer, [role="contentinfo"]'],
    ['search', 'search, [role="search"]'],
    ['form', 'form[aria-label], form[aria-labelledby], [role="form"]'],
    ['region', 'section[aria-label], section[aria-labelledby], [role="region"]']
  ];
  const accName = (el) => {
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return clip(al, 60);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => (doc.getElementById(id) || {}).textContent || '').join(' ');
      if (t.trim()) return clip(t, 60);
    }
    return null;
  };
  for (const [role, sel] of LANDMARKS) {
    for (const el of doc.querySelectorAll(sel)) {
      // Native header/footer are only landmarks at page level.
      if ((role === 'banner' || role === 'contentinfo') && !el.hasAttribute('role') &&
          el.parentElement && el.parentElement.closest('article, aside, main, nav, section')) continue;
      const entry = { role, tag: el.localName, label: accName(el), visible: isVisible(el), selector: selectorFor(el) };
      if (role === 'navigation') entry.links = el.querySelectorAll('a[href]').length;
      landmarks.push(entry);
      if (landmarks.length >= 60) break;
    }
  }

  // ---------------------------------------------------------------- section map

  function firstHeadingText(el) {
    const hd = el.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
    return hd ? clip(hd.innerText || hd.textContent, 60) : null;
  }
  function landmarkRoleOf(el) {
    const role = el.getAttribute('role');
    if (role) return role;
    return { header: 'banner', nav: 'navigation', main: 'main', aside: 'complementary', footer: 'contentinfo' }[el.localName] || null;
  }
  function blocksOf(rootEl, depth = 0) {
    let parent = rootEl;
    // Skip single wrappers (div#app > div#root > ...).
    for (let i = 0; i < 4; i++) {
      const kids = [...parent.children].filter((k) => isVisible(k) && k.getBoundingClientRect().height >= 40);
      if (kids.length === 1 && kids[0].children.length) parent = kids[0];
      else break;
    }
    const out = [];
    for (const k of parent.children) {
      if (out.length >= LIMITS.sections) break;
      if (['script', 'style', 'noscript', 'template', 'link'].includes(k.localName) || !isVisible(k)) continue;
      const r = k.getBoundingClientRect();
      if (r.height < 40) continue;
      const block = {
        tag: k.localName,
        role: landmarkRoleOf(k),
        heading: firstHeadingText(k),
        top: Math.round(r.top + scrollY),
        height: Math.round(r.height),
        selector: selectorFor(k)
      };
      if (depth === 0 && (block.role === 'main' || r.height > page.scrollHeight * 0.6) && k.children.length > 1) {
        block.children = blocksOf(k, 1);
      }
      out.push(block);
    }
    return out;
  }
  const sections = doc.body ? blocksOf(doc.body) : [];

  // ---------------------------------------------------------------- main style walk

  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'title', 'br', 'wbr',
    'source', 'track', 'param', 'option', 'optgroup', 'head', 'base']);
  const bodyEls = doc.body ? doc.body.getElementsByTagName('*') : [];
  const stride = Math.max(1, bodyEls.length / LIMITS.elements);
  const sample = [];
  for (let i = 0; i < bodyEls.length && sample.length < LIMITS.elements; i += stride) {
    const el = bodyEls[Math.floor(i)];
    if (SKIP.has(el.localName) || el.ownerSVGElement) continue; // skip svg internals
    sample.push(el);
  }

  const colorW = new Map(); // hex -> {text, background, border}
  const addColor = (c, kind, weight) => {
    if (!c || c.a <= 0.02 || !(weight > 0)) return;
    const hex = C.toHex(c);
    let e = colorW.get(hex);
    if (!e) { e = { text: 0, background: 0, border: 0 }; colorW.set(hex, e); }
    e[kind] += weight;
  };

  const fonts = new Map();
  const sizes = new Map();
  const spacing = new Map();
  const radii = new Map();
  const shadows = new Map();
  const contrastGroups = new Map();
  let textShadowCount = 0;
  let totalChars = 0;
  let smallChars = 0;
  let scannedVisible = 0;

  // Page canvas color: html bg, else body bg, else white.
  const canvas = (() => {
    const h = C.parse(cs(doc.documentElement).backgroundColor);
    if (h && h.a > 0) return C.blend(h, WHITE);
    const b = doc.body && C.parse(cs(doc.body).backgroundColor);
    if (b && b.a > 0) return C.blend(b, WHITE);
    return WHITE;
  })();
  addColor(canvas, 'background', Math.max(VW, page.scrollWidth) * page.scrollHeight * 0.5);

  const SPACE_PROPS = ['marginTop', 'marginRight', 'marginBottom', 'marginLeft',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'rowGap', 'columnGap'];
  const SIDES = ['Top', 'Right', 'Bottom', 'Left'];

  for (const el of sample) {
    if (!isVisible(el)) continue;
    scannedVisible += 1;
    const s = cs(el);
    const r = el.getBoundingClientRect();

    // backgrounds
    const bg = C.parse(s.backgroundColor);
    if (bg && bg.a > 0.02 && el !== doc.body) addColor(bg, 'background', r.width * r.height);

    // borders
    for (const side of SIDES) {
      const w = px(s[`border${side}Width`]);
      const st = s[`border${side}Style`];
      if (w > 0 && st !== 'none' && st !== 'hidden') {
        addColor(C.parse(s[`border${side}Color`]), 'border', w * (side === 'Top' || side === 'Bottom' ? r.width : r.height));
      }
    }

    // spacing
    for (const p of SPACE_PROPS) {
      const v = px(s[p]);
      if (v > 0 && v <= 400) inc(spacing, round(v));
    }

    // radii
    if (s.borderRadius && s.borderRadius !== '0px') inc(radii, s.borderRadius);

    // shadows
    if (s.boxShadow && s.boxShadow !== 'none') inc(shadows, clip(s.boxShadow, 160));
    if (s.textShadow && s.textShadow !== 'none') textShadowCount += 1;

    // text
    const n = ownTextLength(el);
    if (!n) continue;
    totalChars += n;
    const fontSize = round(px(s.fontSize), 1);
    const weight = Number(s.fontWeight) || 400;
    if (fontSize < 12) smallChars += n;

    const fgRaw = C.parse(s.color);
    const bgInfo = effectiveBg(el);
    const fg = fgRaw && bgInfo.color ? C.blend(fgRaw, bgInfo.color) : fgRaw;
    addColor(fg, 'text', n);

    const role = textRole(el);
    const stack = splitFamilies(s.fontFamily);
    const primary = stack[0] || 'serif';
    let f = fonts.get(primary);
    if (!f) {
      f = { family: primary, stack, chars: 0, roles: { heading: 0, body: 0, ui: 0, code: 0 }, weights: new Map(), sizes: new Set(), italic: 0 };
      fonts.set(primary, f);
    }
    f.chars += n;
    f.roles[role] += n;
    inc(f.weights, weight, n);
    f.sizes.add(fontSize);
    if (s.fontStyle === 'italic') f.italic += n;

    let sz = sizes.get(fontSize);
    if (!sz) { sz = { px: fontSize, chars: 0, elements: 0, tags: new Map(), roles: { heading: 0, body: 0, ui: 0, code: 0 }, lineHeights: new Map() }; sizes.set(fontSize, sz); }
    sz.chars += n;
    sz.elements += 1;
    inc(sz.tags, el.localName);
    sz.roles[role] += n;
    const lh = s.lineHeight === 'normal' ? 1.2 : round(px(s.lineHeight) / (fontSize || 16), 2);
    inc(sz.lineHeights, lh, n);

    // contrast sample groups
    if (fg && contrastGroups.size < LIMITS.contrastGroups) {
      const bgHex = bgInfo.color ? C.toHex(bgInfo.color) : null;
      const key = `${C.toHex(fg)}|${bgHex || 'image'}|${fontSize}|${weight}`;
      let g = contrastGroups.get(key);
      if (!g) {
        g = {
          fg: C.toHex(fg),
          bg: bgHex,
          bgIsImage: bgInfo.image,
          fontSize,
          fontWeight: weight,
          large: fontSize >= 24 || (fontSize >= 18.66 && weight >= 700),
          chars: 0,
          count: 0,
          sample: ownTextSample(el, 40),
          selectors: []
        };
        contrastGroups.set(key, g);
      }
      g.chars += n;
      g.count += 1;
      if (g.selectors.length < 3) g.selectors.push(selectorFor(el));
    }
  }

  // ---------------------------------------------------------------- colors → palette

  const CAT_WEIGHT = { background: 0.5, text: 0.35, border: 0.15 };
  const catTotals = { text: 0, background: 0, border: 0 };
  for (const w of colorW.values()) for (const k in catTotals) catTotals[k] += w[k];
  const activeCats = Object.keys(catTotals).filter((k) => catTotals[k] > 0);
  const catNorm = activeCats.reduce((a, k) => a + CAT_WEIGHT[k], 0) || 1;

  const colors = [...colorW.entries()].map(([hex, w]) => {
    const roles = {};
    let share = 0;
    for (const k of Object.keys(catTotals)) {
      roles[k] = catTotals[k] ? w[k] / catTotals[k] : 0;
      if (catTotals[k]) share += (roles[k] * CAT_WEIGHT[k]) / catNorm;
    }
    const rgb = C.parse(hex);
    const flat = C.flatten(rgb);
    const hsl = C.rgbToHsl(flat);
    return {
      hex,
      share,
      roles: { text: round(roles.text, 4), background: round(roles.background, 4), border: round(roles.border, 4) },
      kind: C.isNeutral(flat) ? 'neutral' : 'accent',
      hsl: { h: round(hsl.h), s: round(hsl.s, 3), l: round(hsl.l, 3) },
      alpha: rgb.a
    };
  }).sort((a, b) => b.share - a.share || (a.hex < b.hex ? -1 : 1));

  // Merge near-identical colors (ΔE < 3) into one swatch for the palette.
  const palette = [];
  for (const c of colors) {
    const flat = C.flatten(C.parse(c.hex));
    const hit = palette.find((p) => C.deltaE(p._flat, flat) < 3);
    if (hit) {
      hit.share += c.share;
      for (const k in hit.roles) hit.roles[k] += c.roles[k];
      if (hit.variants.length < 8) hit.variants.push(c.hex);
    } else if (palette.length < 24) {
      palette.push({ hex: c.hex, share: c.share, roles: { ...c.roles }, kind: c.kind, hsl: c.hsl, variants: [], _flat: flat });
    }
  }
  palette.forEach((p) => {
    delete p._flat;
    p.share = round(p.share, 4);
    for (const k in p.roles) p.roles[k] = round(p.roles[k], 4);
  });

  // Pairs that look alike but are different values (design-consistency input).
  const nearDuplicates = [];
  const top = colors.slice(0, 60);
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const de = C.deltaE(C.flatten(C.parse(top[i].hex)), C.flatten(C.parse(top[j].hex)));
      if (de > 0 && de < 4) nearDuplicates.push({ a: top[i].hex, b: top[j].hex, deltaE: round(de, 2) });
    }
  }
  nearDuplicates.sort((a, b) => a.deltaE - b.deltaE);

  // ---------------------------------------------------------------- fonts + type scale

  const webFonts = new Map();
  try {
    for (const ff of doc.fonts) {
      const fam = ff.family.replace(/^["']|["']$/g, '');
      const e = webFonts.get(fam) || { family: fam, faces: 0, loaded: 0 };
      e.faces += 1;
      if (ff.status === 'loaded') e.loaded += 1;
      webFonts.set(fam, e);
    }
  } catch { /* FontFaceSet unavailable */ }

  const fontList = [...fonts.values()]
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 12)
    .map((f) => {
      const primaryRole = Object.entries(f.roles).sort((a, b) => b[1] - a[1])[0][0];
      const wf = webFonts.get(f.family);
      return {
        family: f.family,
        stack: f.stack.slice(0, 6),
        share: totalChars ? round(f.chars / totalChars, 4) : 0,
        roles: Object.fromEntries(Object.entries(f.roles).map(([k, v]) => [k, totalChars ? round(v / f.chars, 3) : 0])),
        primaryRole,
        weights: [...f.weights.entries()].sort((a, b) => b[1] - a[1]).map(([w, c]) => ({ weight: w, share: round(c / f.chars, 3) })),
        sizes: [...f.sizes].sort((a, b) => a - b),
        italicShare: round(f.italic / f.chars, 3),
        source: wf ? 'web' : /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-\w+|-apple-system|blinkmacsystemfont)$/i.test(f.family) ? 'system' : 'local',
        faces: wf ? wf.faces : 0,
        loadedFaces: wf ? wf.loaded : 0
      };
    });

  const sizeList = [...sizes.values()].sort((a, b) => b.px - a.px);
  const steps = sizeList
    .filter((s) => (totalChars && s.chars / totalChars >= 0.005) || s.roles.heading > 0)
    .map((s) => ({
      px: s.px,
      share: totalChars ? round(s.chars / totalChars, 4) : 0,
      elements: s.elements,
      tags: [...s.tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t),
      role: Object.entries(s.roles).sort((a, b) => b[1] - a[1])[0][0],
      lineHeight: [...s.lineHeights.entries()].sort((a, b) => b[1] - a[1])[0][0]
    }))
    .slice(0, 16);

  const bodySizes = sizeList.filter((s) => s.roles.body > 0).sort((a, b) => b.roles.body - a.roles.body);
  const basePx = bodySizes.length ? bodySizes[0].px : (sizeList[0] ? sizeList[0].px : 16);
  const ratios = [];
  for (let i = 0; i + 1 < steps.length; i++) {
    const r = steps[i].px / steps[i + 1].px;
    if (r >= 1.04 && r <= 2.2) ratios.push(r);
  }
  ratios.sort((a, b) => a - b);
  const medianRatio = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;
  const NAMED = [[1.067, 'Minor second'], [1.125, 'Major second'], [1.2, 'Minor third'], [1.25, 'Major third'],
    [1.333, 'Perfect fourth'], [1.414, 'Augmented fourth'], [1.5, 'Perfect fifth'], [1.618, 'Golden ratio']];
  let scaleName = null;
  if (medianRatio) {
    const best = NAMED.reduce((a, b) => (Math.abs(b[0] - medianRatio) < Math.abs(a[0] - medianRatio) ? b : a));
    if (Math.abs(best[0] - medianRatio) <= 0.035) scaleName = best[1];
  }

  // ---------------------------------------------------------------- spacing / radii / shadows

  let spaceTotal = 0;
  let on4 = 0;
  let on8 = 0;
  for (const [v, c] of spacing) {
    spaceTotal += c;
    if (v % 4 === 0) on4 += c;
    if (v % 8 === 0) on8 += c;
  }
  const spacingValues = [...spacing.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 20).map(([v, c]) => ({ px: v, count: c }));
  const radiiValues = [...radii.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([v, c]) => ({ value: v, count: c }));
  const shadowValues = [...shadows.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([v, c]) => ({ value: v, count: c }));

  // ---------------------------------------------------------------- components

  const visibleCount = (sel) => {
    let n = 0;
    for (const el of doc.querySelectorAll(sel)) if (isVisible(el)) n += 1;
    return n;
  };
  const BUTTON_SEL = 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], a.btn, a.button, a[class*="btn-"], a[class*="button"]';
  const buttonVariants = new Map();
  let buttonCount = 0;
  for (const el of doc.querySelectorAll(BUTTON_SEL)) {
    if (!isVisible(el)) continue;
    buttonCount += 1;
    const s = cs(el);
    const bgC = C.parse(s.backgroundColor);
    const key = [bgC && bgC.a > 0.02 ? C.toHex(bgC) : 'none', C.toHex(C.parse(s.color)), s.borderRadius,
      px(s.borderTopWidth) > 0 ? `${s.borderTopWidth} ${C.toHex(C.parse(s.borderTopColor))}` : 'none', s.fontWeight].join('|');
    let v = buttonVariants.get(key);
    if (!v) {
      v = {
        background: bgC && bgC.a > 0.02 ? C.toHex(bgC) : null,
        color: C.toHex(C.parse(s.color)),
        radius: s.borderRadius,
        border: px(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none' ? `${s.borderTopWidth} ${s.borderTopStyle} ${C.toHex(C.parse(s.borderTopColor))}` : null,
        fontWeight: s.fontWeight,
        fontSize: s.fontSize,
        padding: `${round(px(s.paddingTop))}px ${round(px(s.paddingRight))}px`,
        label: clip(el.innerText || el.value || el.getAttribute('aria-label') || '', 24),
        count: 0,
        selector: selectorFor(el)
      };
      buttonVariants.set(key, v);
    }
    v.count += 1;
  }

  let cards = 0;
  for (const el of sample) {
    if (cards > 500) break;
    const s = cs(el);
    if (px(s.borderTopLeftRadius) > 0 && (s.boxShadow !== 'none' || px(s.borderTopWidth) > 0) &&
        el.querySelector('h2, h3, h4, h5, h6, [role="heading"]') && isVisible(el)) cards += 1;
  }

  const components = {
    buttons: buttonCount,
    links: visibleCount('a[href]'),
    inputs: visibleCount('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"])'),
    checkboxes: visibleCount('input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"], [role="switch"]'),
    selects: visibleCount('select, [role="combobox"], [role="listbox"]'),
    textareas: visibleCount('textarea'),
    images: visibleCount('img, picture, [role="img"]'),
    icons: (() => { let n = 0; for (const el of doc.querySelectorAll('svg')) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.width <= 40 && r.height <= 40) n += 1; } return n; })(),
    videos: visibleCount('video'),
    iframes: doc.querySelectorAll('iframe').length,
    tables: visibleCount('table'),
    lists: visibleCount('ul, ol'),
    navs: visibleCount('nav, [role="navigation"]'),
    tabs: visibleCount('[role="tablist"]'),
    dialogs: doc.querySelectorAll('dialog, [role="dialog"], [aria-modal="true"]').length,
    accordions: visibleCount('details'),
    cards,
    buttonVariants: [...buttonVariants.values()].sort((a, b) => b.count - a.count).slice(0, 10)
  };

  // ---------------------------------------------------------------- readability

  const lineChars = [];
  for (const p of doc.querySelectorAll('p')) {
    if (lineChars.length >= 300) break;
    if (!isVisible(p) || (p.textContent || '').trim().length < 80) continue;
    const s = cs(p);
    const w = p.getBoundingClientRect().width;
    lineChars.push(Math.round(w / ((px(s.fontSize) || 16) * 0.5)));
  }
  lineChars.sort((a, b) => a - b);
  const bodyStep = sizes.get(basePx);
  const readability = {
    basePx,
    baseLineHeight: bodyStep ? [...bodyStep.lineHeights.entries()].sort((a, b) => b[1] - a[1])[0][0] : null,
    paragraphs: lineChars.length,
    medianLineChars: lineChars.length ? lineChars[Math.floor(lineChars.length / 2)] : null,
    totalChars,
    smallTextShare: totalChars ? round(smallChars / totalChars, 4) : 0
  };

  // ---------------------------------------------------------------- images

  const resEntries = performance.getEntriesByType('resource');
  const resByUrl = new Map();
  for (const e of resEntries) resByUrl.set(e.name.split('#')[0], e);
  const bytesOf = (e) => (e ? e.encodedBodySize || e.transferSize || 0 : null);

  const imgEls = [...doc.images];
  const images = [];
  for (const img of imgEls.slice(0, LIMITS.images)) {
    const r = img.getBoundingClientRect();
    const src = img.currentSrc || img.src;
    const su = safeUrl(src);
    let entry = null;
    try { entry = resByUrl.get(new URL(src, location.href).href.split('#')[0]); } catch { entry = null; }
    images.push({
      src: su ? su.url : null,
      host: su ? su.host : '',
      thirdParty: su ? su.thirdParty : false,
      alt: img.hasAttribute('alt') ? clip(img.getAttribute('alt'), 120) : null,
      role: img.getAttribute('role'),
      ariaHidden: img.getAttribute('aria-hidden') === 'true',
      ariaLabel: Boolean(img.getAttribute('aria-label') || img.getAttribute('aria-labelledby')),
      inLink: Boolean(img.closest('a[href], button')),
      linkHasText: (() => { const a = img.closest('a[href], button'); return a ? ownTextLength(a) > 0 || Boolean(a.getAttribute('aria-label')) : false; })(),
      visible: isVisible(img),
      width: Math.round(r.width),
      height: Math.round(r.height),
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      complete: img.complete,
      loading: img.getAttribute('loading'),
      decoding: img.getAttribute('decoding'),
      hasSrcset: img.hasAttribute('srcset') || Boolean(img.closest('picture')),
      hasDims: (img.hasAttribute('width') && img.hasAttribute('height')) || cs(img).aspectRatio !== 'auto',
      aboveFold: r.top < VH && r.bottom > 0,
      bytes: bytesOf(entry),
      format: su && su.scheme === 'data' ? su.url.slice(5, 30) : ((su && su.url.match(/\.([a-z0-9]{2,5})$/i)) || [, null])[1],
      selector: selectorFor(img)
    });
  }

  // ---------------------------------------------------------------- links

  const links = { total: 0, internal: 0, external: 0, javascript: 0, blankNoOpener: [], emptyName: [], externalHosts: [] };
  const extHosts = new Map();
  for (const a of doc.querySelectorAll('a[href]')) {
    links.total += 1;
    const href = a.getAttribute('href') || '';
    if (/^\s*javascript:/i.test(href)) { links.javascript += 1; continue; }
    const su = safeUrl(href);
    if (su && su.host && su.thirdParty) { links.external += 1; inc(extHosts, su.host); } else links.internal += 1;
    if (a.target === '_blank') {
      const rel = (a.getAttribute('rel') || '').toLowerCase().split(/\s+/);
      if (!rel.includes('noopener') && !rel.includes('noreferrer') && links.blankNoOpener.length < LIMITS.listItems) {
        links.blankNoOpener.push({ selector: selectorFor(a), host: su ? su.host : '', text: clip(a.innerText, 40) });
      }
    }
    const hasName = (a.innerText || '').trim() || a.getAttribute('aria-label') || a.getAttribute('aria-labelledby') ||
      a.getAttribute('title') || [...a.querySelectorAll('img[alt]')].some((i) => i.getAttribute('alt').trim()) ||
      a.querySelector('svg title');
    if (!hasName && isVisible(a) && links.emptyName.length < LIMITS.listItems) {
      links.emptyName.push({ selector: selectorFor(a), href: su ? su.url : '' });
    }
  }
  links.externalHosts = [...extHosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([host, count]) => ({ host, count }));

  // ---------------------------------------------------------------- forms + fields (never values)

  function labelOf(el) {
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return { source: 'aria-label', text: clip(al, 60) };
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => (doc.getElementById(id) || {}).textContent || '').join(' ').trim();
      if (t) return { source: 'aria-labelledby', text: clip(t, 60) };
    }
    if (el.labels && el.labels.length) {
      const t = [...el.labels].map((l) => {
        // Label text without option text or nested control text.
        let out = '';
        const walker = doc.createTreeWalker(l, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const n = walker.currentNode;
          if (!n.parentElement.closest('select, textarea, option')) out += ' ' + n.nodeValue;
        }
        return out;
      }).join(' ').trim();
      if (t) return { source: 'label', text: clip(t, 60) };
    }
    const title = el.getAttribute('title');
    if (title && title.trim()) return { source: 'title', text: clip(title, 60) };
    return null;
  }

  const FIELD_SEL = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea';
  const fields = [];
  for (const el of doc.querySelectorAll(FIELD_SEL)) {
    if (fields.length >= LIMITS.fields) break;
    const visible = isVisible(el);
    const r = el.getBoundingClientRect();
    fields.push({
      tag: el.localName,
      type: el.localName === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : el.localName,
      label: labelOf(el),
      hasPlaceholder: Boolean(el.getAttribute('placeholder')),
      required: el.required || el.getAttribute('aria-required') === 'true',
      autocomplete: el.getAttribute('autocomplete'),
      inForm: Boolean(el.form),
      visible,
      width: Math.round(r.width),
      height: Math.round(r.height),
      selector: selectorFor(el)
    });
  }

  const forms = [];
  for (const f of doc.forms) {
    if (forms.length >= LIMITS.forms) break;
    const actionAttr = f.getAttribute('action');
    const actionUrl = safeUrl(actionAttr ? f.action : location.href);
    forms.push({
      selector: selectorFor(f),
      method: (f.getAttribute('method') || 'get').toLowerCase(),
      action: actionUrl ? actionUrl.url : null,
      actionHost: actionUrl ? actionUrl.host : '',
      actionScheme: actionUrl ? actionUrl.scheme : '',
      actionThirdParty: actionUrl ? actionUrl.thirdParty : false,
      hasPassword: Boolean(f.querySelector('input[type="password"]')),
      isSearch: f.getAttribute('role') === 'search' || Boolean(f.querySelector('input[type="search"]')),
      fields: f.querySelectorAll(FIELD_SEL).length,
      visible: isVisible(f)
    });
  }
  const passwordFieldsOutsideForms = [...doc.querySelectorAll('input[type="password"]')].filter((i) => !i.form).length;

  // ---------------------------------------------------------------- tap targets

  const TARGET_SEL = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';
  const targets = { total: 0, small: [] };
  for (const el of doc.querySelectorAll(TARGET_SEL)) {
    if (!isVisible(el)) continue;
    targets.total += 1;
    const r = el.getBoundingClientRect();
    if ((r.width < 24 || r.height < 24) && targets.small.length < LIMITS.targets) {
      const parent = el.parentElement;
      const inline = el.localName === 'a' && cs(el).display.startsWith('inline') && parent && ownTextLength(parent) > 20;
      targets.small.push({
        selector: selectorFor(el),
        width: round(r.width, 1),
        height: round(r.height, 1),
        inline,
        label: clip(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '', 30)
      });
    }
  }

  // Above-the-fold action candidates (UX input: is there one clear primary action?)
  const ctas = [];
  for (const el of doc.querySelectorAll(BUTTON_SEL + ', a[href]')) {
    const r = el.getBoundingClientRect();
    if (r.top >= VH || r.bottom <= 0 || r.width * r.height < 600 || !isVisible(el)) continue;
    const s = cs(el);
    const bgC = C.parse(s.backgroundColor);
    const filled = Boolean(bgC && bgC.a > 0.5);
    let pop = 1;
    if (filled) {
      const behind = effectiveBg(el.parentElement).color || WHITE;
      pop = C.contrast(C.flatten(bgC, behind), behind);
    }
    ctas.push({
      label: clip(el.innerText || el.getAttribute('aria-label') || el.value || '', 40),
      area: Math.round(r.width * r.height),
      filled,
      background: filled ? C.toHex(bgC) : null,
      prominence: round((r.width * r.height) * pop / 1000, 1),
      selector: selectorFor(el)
    });
  }
  ctas.sort((a, b) => b.prominence - a.prominence);

  // ---------------------------------------------------------------- scripts / styles / iframes

  const scripts = { external: [], inline: 0, inlineBytes: 0, inlineSourceMaps: 0, jsonData: 0 };
  const scriptSrcsRaw = [];
  for (const s of doc.scripts) {
    const type = (s.getAttribute('type') || '').toLowerCase();
    const isJs = !type || /javascript|ecmascript|module/.test(type);
    if (s.src) {
      scriptSrcsRaw.push(s.src);
      if (scripts.external.length >= 150) continue;
      const su = safeUrl(s.src);
      const inHead = Boolean(s.closest('head'));
      const module = type === 'module';
      scripts.external.push({
        url: su.url,
        host: su.host,
        thirdParty: su.thirdParty,
        scheme: su.scheme,
        async: s.async,
        defer: s.defer,
        module,
        integrity: Boolean(s.integrity),
        crossorigin: s.getAttribute('crossorigin'),
        inHead,
        parserBlocking: isJs && inHead && !s.async && !s.defer && !module
      });
    } else if (isJs) {
      scripts.inline += 1;
      const t = s.textContent || '';
      scripts.inlineBytes += t.length;
      if (/[#@]\s*sourceMappingURL=/.test(t)) scripts.inlineSourceMaps += 1;
    } else {
      scripts.jsonData += 1;
    }
  }

  const styleSheets = { external: [], inline: 0, inlineBytes: 0, styleAttributes: doc.querySelectorAll('[style]').length };
  const styleUrlsRaw = [];
  for (const l of doc.querySelectorAll('link[rel~="stylesheet" i]')) {
    styleUrlsRaw.push(l.href);
    const su = safeUrl(l.href);
    styleSheets.external.push({
      url: su.url, host: su.host, thirdParty: su.thirdParty, scheme: su.scheme,
      media: l.media || 'all', integrity: Boolean(l.integrity), inHead: Boolean(l.closest('head')), disabled: l.disabled
    });
  }
  for (const st of doc.querySelectorAll('style')) {
    styleSheets.inline += 1;
    styleSheets.inlineBytes += (st.textContent || '').length;
  }

  const HANDLERS = ['onclick', 'onload', 'onerror', 'onmouseover', 'onmouseout', 'onsubmit', 'onchange', 'oninput',
    'onkeydown', 'onkeyup', 'onfocus', 'onblur', 'onmousedown', 'onmouseup', 'ontouchstart'];
  const inlineHandlers = { count: 0, attributes: {}, selectors: [] };
  for (const el of doc.querySelectorAll(HANDLERS.map((h) => `[${h}]`).join(','))) {
    inlineHandlers.count += 1;
    for (const h of HANDLERS) if (el.hasAttribute(h)) inlineHandlers.attributes[h] = (inlineHandlers.attributes[h] || 0) + 1;
    if (inlineHandlers.selectors.length < 20) inlineHandlers.selectors.push(selectorFor(el));
  }
  const jsHrefs = links.javascript;

  const iframes = [...doc.querySelectorAll('iframe')].slice(0, 30).map((f) => {
    const su = safeUrl(f.getAttribute('src') || 'about:blank');
    return {
      url: su ? su.url : null,
      host: su ? su.host : '',
      thirdParty: su ? su.thirdParty : false,
      title: Boolean((f.getAttribute('title') || '').trim()),
      sandbox: f.hasAttribute('sandbox') ? f.getAttribute('sandbox') : null,
      loading: f.getAttribute('loading'),
      visible: isVisible(f),
      selector: selectorFor(f)
    };
  });

  // HTML comments: counts and keyword hits only — never the text itself.
  const comments = { count: 0, chars: 0, keywords: {} };
  const KEYWORDS = { todo: /\btodo\b|\bfixme\b/i, password: /passw(or)?d|pwd/i, secret: /secret/i, token: /token/i,
    apiKey: /api[_-]?key|apikey/i, internal: /\binternal\b|\bstaging\b|\bdebug\b/i, admin: /\badmin\b/i, email: /[\w.+-]+@[\w-]+\.[\w.]+/ };
  {
    const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT);
    let guard = 0;
    while (walker.nextNode() && guard++ < 5000) {
      const t = walker.currentNode.nodeValue || '';
      comments.count += 1;
      comments.chars += t.length;
      for (const [k, re] of Object.entries(KEYWORDS)) if (re.test(t)) comments.keywords[k] = (comments.keywords[k] || 0) + 1;
    }
  }

  // Storage + cookies: NAMES ONLY.
  const names = (store) => {
    try {
      const out = [];
      for (let i = 0; i < store.length && out.length < 100; i++) out.push(clip(store.key(i), 60));
      return { count: store.length, names: out.sort() };
    } catch {
      return { count: null, names: [], blocked: true };
    }
  };
  const cookieNames = (() => {
    try {
      return doc.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean).slice(0, 100).map((n) => clip(n, 60)).sort();
    } catch {
      return [];
    }
  })();
  const storage = {
    localStorage: names(localStorage),
    sessionStorage: names(sessionStorage),
    cookies: { readableCount: cookieNames.length, names: cookieNames }
  };

  // Mixed content (passive view of what loaded).
  const mixed = [];
  if (pageUrl.protocol === 'https:') {
    for (const e of resEntries) if (e.name.startsWith('http:') && mixed.length < 30) mixed.push({ url: safeUrl(e.name).url, type: e.initiatorType });
    for (const el of doc.querySelectorAll('img[src^="http:"], script[src^="http:"], link[href^="http:"][rel~="stylesheet"], iframe[src^="http:"], video[src^="http:"], audio[src^="http:"], source[src^="http:"]')) {
      const u = safeUrl(el.getAttribute('src') || el.getAttribute('href')).url;
      if (mixed.length < 30 && !mixed.some((m) => m.url === u)) mixed.push({ url: u, type: el.localName });
    }
  }

  // ---------------------------------------------------------------- performance

  const nav = performance.getEntriesByType('navigation')[0] || null;
  const paints = performance.getEntriesByType('paint');
  const fcp = paints.find((p) => p.name === 'first-contentful-paint');

  function kindOf(e) {
    let path = '';
    try { path = new URL(e.name).pathname.toLowerCase(); } catch { /* ignore */ }
    const it = e.initiatorType;
    if (/\.(woff2?|ttf|otf|eot)$/.test(path)) return 'font';
    if (/\.css$/.test(path)) return 'css';
    if (/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/.test(path) || it === 'img' || it === 'image') return 'image';
    if (/\.(mp4|webm|mov|mp3|ogg|wav|m3u8|m4s|ts)$/.test(path) || it === 'video' || it === 'audio') return 'media';
    if (/\.m?js$/.test(path) || it === 'script') return 'script';
    if (it === 'link' && /css/.test(path)) return 'css';
    if (it === 'xmlhttprequest' || it === 'fetch' || it === 'beacon') return 'xhr';
    if (it === 'iframe' || it === 'frame') return 'document';
    if (it === 'css') return 'image'; // url() inside CSS without a known extension: usually images
    return 'other';
  }

  const byType = {};
  const hostAgg = new Map();
  let totalBytes = nav ? nav.encodedBodySize || nav.transferSize || 0 : 0;
  let unknownSize = 0;
  let cachedCount = 0;
  const all = [];
  for (const e of resEntries) {
    const kind = kindOf(e);
    const bytes = e.encodedBodySize || e.transferSize || 0;
    if (!bytes && !e.decodedBodySize) unknownSize += 1;
    if (e.transferSize === 0 && e.encodedBodySize > 0) cachedCount += 1;
    totalBytes += bytes;
    const t = byType[kind] || (byType[kind] = { count: 0, bytes: 0 });
    t.count += 1;
    t.bytes += bytes;
    const su = safeUrl(e.name);
    const ha = hostAgg.get(su.host) || { host: su.host, count: 0, bytes: 0, thirdParty: su.thirdParty };
    ha.count += 1;
    ha.bytes += bytes;
    hostAgg.set(su.host, ha);
    all.push({
      url: su.url,
      host: su.host,
      thirdParty: su.thirdParty,
      kind,
      bytes,
      decoded: e.decodedBodySize || 0,
      duration: Math.round(e.duration),
      start: Math.round(e.startTime),
      renderBlocking: e.renderBlockingStatus === 'blocking',
      protocol: e.nextHopProtocol || null,
      cached: e.transferSize === 0 && e.encodedBodySize > 0
    });
  }

  const [lcpEntries, clsEntries] = await Promise.all([lcpP, clsP]);
  const lcpLast = lcpEntries[lcpEntries.length - 1];
  // CLS: largest session window (gap < 1s, window < 5s), ignoring input-driven shifts.
  let cls = 0;
  {
    let win = 0;
    let first = 0;
    let prev = 0;
    for (const e of clsEntries) {
      if (e.hadRecentInput) continue;
      if (win && (e.startTime - prev > 1000 || e.startTime - first > 5000)) { cls = Math.max(cls, win); win = 0; }
      if (!win) first = e.startTime;
      win += e.value;
      prev = e.startTime;
    }
    cls = Math.max(cls, win);
  }

  const performanceInfo = {
    navigation: nav ? {
      type: nav.type,
      protocol: nav.nextHopProtocol || null,
      ttfb: Math.round(nav.responseStart),
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
      load: Math.round(nav.loadEventEnd) || null,
      documentBytes: nav.encodedBodySize || nav.transferSize || 0,
      documentDecoded: nav.decodedBodySize || 0,
      redirects: nav.redirectCount
    } : null,
    fcp: fcp ? Math.round(fcp.startTime) : null,
    lcp: lcpLast ? {
      time: Math.round(lcpLast.startTime),
      size: lcpLast.size,
      element: lcpLast.element ? selectorFor(lcpLast.element) : null,
      url: lcpLast.url ? safeUrl(lcpLast.url).url : null
    } : null,
    cls: round(cls, 3),
    requests: resEntries.length + 1,
    totalBytes,
    unknownSize,
    cachedCount,
    bufferLikelyFull: resEntries.length >= 250,
    byType,
    heaviest: [...all].sort((a, b) => b.bytes - a.bytes).slice(0, 15),
    renderBlocking: all.filter((r) => r.renderBlocking).slice(0, 30),
    hosts: [...hostAgg.values()].sort((a, b) => b.bytes - a.bytes || b.count - a.count).slice(0, 30),
    resources: all.slice(0, LIMITS.resources)
  };

  // ---------------------------------------------------------------- tech hints from the DOM

  const tech = new Map();
  const addTech = (name, category, version, evidence) => {
    const prev = tech.get(name);
    if (!prev) tech.set(name, { name, category, version: version || null, evidence });
    else if (!prev.version && version) prev.version = version;
  };
  if (metaInfo.generator) {
    const m = /^([A-Za-z][\w .-]*?)\s*v?(\d+(?:\.\d+){0,3})?\s*$/.exec(metaInfo.generator.trim());
    addTech(m ? m[1].trim() : clip(metaInfo.generator, 40), 'Platform', m && m[2], 'meta generator');
  }
  const URL_SIGNS = [
    [/\/wp-content\/|\/wp-includes\//, 'WordPress', 'CMS'],
    [/cdn\.shopify\.com/, 'Shopify', 'E-commerce'],
    [/static\.wixstatic\.com|parastorage\.com/, 'Wix', 'Site builder'],
    [/squarespace(-cdn)?\.com/, 'Squarespace', 'Site builder'],
    [/webflow\.(com|io)|website-files\.com/, 'Webflow', 'Site builder'],
    [/googletagmanager\.com\/gtm\.js/, 'Google Tag Manager', 'Tag manager'],
    [/googletagmanager\.com\/gtag\/js|google-analytics\.com\/(analytics|ga)\.js/, 'Google Analytics', 'Analytics'],
    [/connect\.facebook\.net/, 'Meta Pixel', 'Advertising'],
    [/static\.hotjar\.com/, 'Hotjar', 'Analytics'],
    [/cdn\.segment\.com/, 'Segment', 'Analytics'],
    [/plausible\.io/, 'Plausible', 'Analytics'],
    [/clarity\.ms/, 'Microsoft Clarity', 'Analytics'],
    [/js\.stripe\.com/, 'Stripe', 'Payments'],
    [/widget\.intercom\.io|js\.intercomcdn\.com/, 'Intercom', 'Support chat'],
    [/fonts\.googleapis\.com|fonts\.gstatic\.com/, 'Google Fonts', 'Fonts'],
    [/use\.typekit\.net/, 'Adobe Fonts', 'Fonts'],
    [/\/cdn-cgi\/|challenges\.cloudflare\.com/, 'Cloudflare', 'CDN'],
    [/www\.google\.com\/recaptcha|gstatic\.com\/recaptcha/, 'reCAPTCHA', 'Security'],
    [/\/_next\/static\//, 'Next.js', 'Framework'],
    [/\/_nuxt\//, 'Nuxt', 'Framework'],
    [/\/_astro\//, 'Astro', 'Framework']
  ];
  const LIBS = [
    ['jQuery', 'jquery', 'JS library'], ['jQuery UI', 'jquery-ui', 'JS library'], ['jQuery UI', 'jqueryui', 'JS library'],
    ['Bootstrap', 'bootstrap', 'UI framework'], ['Lodash', 'lodash', 'JS library'], ['Underscore', 'underscore', 'JS library'],
    ['Moment.js', 'moment', 'JS library'], ['AngularJS', 'angular', 'Framework'], ['AngularJS', 'angular.js', 'Framework'],
    ['React', 'react', 'Framework'], ['Vue', 'vue', 'Framework'], ['D3', 'd3', 'JS library'], ['Swiper', 'swiper', 'JS library'],
    ['GSAP', 'gsap', 'JS library'], ['three.js', 'three', 'JS library'], ['Handlebars', 'handlebars', 'JS library'],
    ['Axios', 'axios', 'JS library'], ['DOMPurify', 'dompurify', 'JS library'], ['Chart.js', 'chart.js', 'JS library'],
    ['Font Awesome', 'font-awesome', 'Icons'], ['Font Awesome', 'fontawesome', 'Icons']
  ];
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const LIB_RES = LIBS.map(([name, slug, cat]) => [name, cat, new RegExp(`(?:^|[/@._-])${escRe(slug)}(?:[/@._-]v?|\\.js/)(\\d+\\.\\d+(?:\\.\\d+)?)`, 'i')]);
  for (const raw of [...scriptSrcsRaw, ...styleUrlsRaw, ...resEntries.map((e) => e.name)]) {
    let path = raw;
    try { const u = new URL(raw); path = u.hostname + u.pathname; } catch { /* keep raw */ }
    for (const [re, name, cat] of URL_SIGNS) if (re.test(path)) addTech(name, cat, null, 'resource URL');
    for (const [name, cat, re] of LIB_RES) {
      const m = re.exec(path);
      if (m) addTech(name, cat, m[1], 'file name');
    }
  }
  const ng = doc.querySelector('[ng-version]');
  if (ng) addTech('Angular', 'Framework', ng.getAttribute('ng-version'), 'ng-version attribute');
  if (doc.getElementById('__next') || doc.getElementById('__NEXT_DATA__')) addTech('Next.js', 'Framework', null, 'page markup');
  if (doc.getElementById('___gatsby')) addTech('Gatsby', 'Framework', null, 'page markup');
  if (doc.getElementById('__nuxt') || doc.getElementById('__NUXT_DATA__')) addTech('Nuxt', 'Framework', null, 'page markup');
  if (doc.querySelector('[data-reactroot], [data-reactid]')) addTech('React', 'Framework', null, 'page markup');
  if (doc.querySelector('[data-v-app], [data-server-rendered]')) addTech('Vue', 'Framework', null, 'page markup');
  if (doc.querySelector('astro-island')) addTech('Astro', 'Framework', null, 'page markup');
  if (doc.querySelector('[class*="svelte-"]')) addTech('Svelte', 'Framework', null, 'page markup');
  if (doc.querySelector('[data-wf-page], [data-wf-site]')) addTech('Webflow', 'Site builder', null, 'page markup');
  if (doc.querySelector('[x-data]')) addTech('Alpine.js', 'JS library', null, 'page markup');
  if (doc.querySelector('[hx-get], [hx-post], [data-hx-get], [data-hx-post]')) addTech('htmx', 'JS library', null, 'page markup');
  if (doc.querySelector('turbo-frame, [data-turbo]')) addTech('Hotwire Turbo', 'Framework', null, 'page markup');
  {
    const TW = /^(?:[a-z]+:)*(?:-?m[xytrbl]?-\d+|p[xytrbl]?-\d+|flex|grid|gap-\d+|text-(?:xs|sm|base|lg|[2-9]?xl)|bg-[a-z]+-\d{2,3}|text-[a-z]+-\d{2,3}|rounded(?:-[a-z0-9]+)?|w-\d+|h-\d+|items-center|justify-between|space-[xy]-\d+)$/;
    let tokens = 0;
    let hits = 0;
    for (const el of sample.slice(0, 2000)) {
      const cl = el.classList;
      for (let i = 0; i < cl.length; i++) { tokens += 1; if (TW.test(cl[i])) hits += 1; }
    }
    if (hits >= 40 && hits / Math.max(1, tokens) > 0.15) addTech('Tailwind CSS', 'CSS framework', null, 'utility class names');
    if (doc.querySelector('.container .row [class*="col-"], .btn.btn-primary, .navbar-expand-lg, .navbar-expand-md')) {
      addTech('Bootstrap', 'UI framework', null, 'class names');
    }
  }

  // ---------------------------------------------------------------- accessibility extras (v0.6)
  // All static: reads attributes, computed styles and same-origin CSS rules. Never moves focus.

  const NATIVE_INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, label, option, details, video[controls], audio[controls], iframe, [contenteditable="true"]';
  const ROLE_INTERACTIVE = '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [role="slider"], [role="combobox"], [role="textbox"], [role="treeitem"], [role="gridcell"], [tabindex]:not([tabindex="-1"])';
  const FOCUSABLE_SEL = 'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
  const VALID_ROLES = new Set(('alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img image insertion link list listbox listitem log main mark marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem doc-abstract doc-acknowledgments doc-afterword doc-appendix doc-backlink doc-biblioentry doc-bibliography doc-biblioref doc-chapter doc-colophon doc-conclusion doc-cover doc-credit doc-credits doc-dedication doc-endnote doc-endnotes doc-epigraph doc-epilogue doc-errata doc-example doc-footnote doc-foreword doc-glossary doc-glossref doc-index doc-introduction doc-noteref doc-notice doc-pagebreak doc-pagelist doc-part doc-preface doc-prologue doc-pullquote doc-qna doc-subtitle doc-tip doc-toc graphics-document graphics-object graphics-symbol').split(' '));
  const GENERIC_LINK = /^(click here|here|read more|more|learn more|link|this|details|continue|go|more info|click|find out more|see more)$/i;

  const a11y = {
    focusables: 0,
    noFocusIndicator: [],
    focusCssUnreadable: 0,
    positiveTabindex: [],
    hiddenFocusable: [],
    unnamedButtons: [],
    duplicateIds: { total: 0, referenced: [] },
    brokenAriaRefs: [],
    invalidRoles: [],
    autoplay: [],
    videosNoCaptions: [],
    skipLink: false,
    clickOnly: [],
    genericLinks: [],
    tablesNoHeaders: [],
    metaRefresh: null,
    langValid: page.lang ? /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(page.lang.trim()) : null
  };

  // --- focus indicators: read same-origin CSS rules once.
  const removers = [];
  const stylers = [];
  const FOCUS_PSEUDO = /:focus(-visible|-within)?(\([^)]*\))?/g;
  const baseSel = (sel) => sel.replace(/:not\(\s*:focus(-visible)?\s*\)/g, '').replace(FOCUS_PSEUDO, '').replace(/\s+$/, '') || '*';
  function scanRules(rules, depth) {
    for (const r of rules) {
      if (removers.length > 400 && stylers.length > 400) return;
      if (r.cssRules && depth < 4 && !(r instanceof CSSStyleRule)) { try { scanRules(r.cssRules, depth + 1); } catch { /* ignore */ } continue; }
      if (!(r instanceof CSSStyleRule) || !r.style) continue;
      const st = r.style;
      const ow = st.getPropertyValue('outline-width');
      const os = st.getPropertyValue('outline-style');
      const o = st.getPropertyValue('outline');
      const kills = os === 'none' || ow === '0px' || ow === '0' || /^(none|0(px)?)(\s|$)/.test(o.trim());
      const shows = (!kills && (os && os !== 'none' || (o && !/^(none|0)/.test(o.trim())))) ||
        (st.getPropertyValue('box-shadow') && st.getPropertyValue('box-shadow') !== 'none') ||
        Boolean(st.getPropertyValue('border-color') || st.getPropertyValue('border') || st.getPropertyValue('background-color') ||
          st.getPropertyValue('background') || st.getPropertyValue('text-decoration') || st.getPropertyValue('text-decoration-line') || st.getPropertyValue('color'));
      for (const one of r.selectorText.split(',')) {
        const sel = one.trim();
        const isFocus = /:focus/.test(sel);
        const notFocusVisible = /:not\(\s*:focus-visible\s*\)/.test(sel);
        if (kills && removers.length < 400) removers.push(baseSel(sel));
        if (isFocus && !notFocusVisible && shows && stylers.length < 400) stylers.push(baseSel(sel));
      }
    }
  }
  for (const sheet of doc.styleSheets) {
    try { scanRules(sheet.cssRules, 0); } catch { a11y.focusCssUnreadable += 1; }
  }
  const safeMatches = (el, sel) => { try { return el.matches(sel); } catch { return false; } };

  const focusables = [...doc.querySelectorAll(FOCUSABLE_SEL)].filter((el) => isVisible(el));
  a11y.focusables = focusables.length;
  for (const el of focusables.slice(0, 250)) {
    const removed = removers.some((b) => safeMatches(el, b));
    if (!removed) continue; // the browser's own focus ring will show
    const styled = stylers.some((b) => safeMatches(el, b));
    if (!styled && a11y.noFocusIndicator.length < 40) {
      a11y.noFocusIndicator.push({ selector: selectorFor(el), label: clip(el.innerText || el.getAttribute('aria-label') || el.value || el.localName, 40) });
    }
  }

  // --- tab order and hidden focusables
  for (const el of doc.querySelectorAll('[tabindex]')) {
    const t = parseInt(el.getAttribute('tabindex'), 10);
    if (t > 0 && a11y.positiveTabindex.length < 30) a11y.positiveTabindex.push({ selector: selectorFor(el), tabindex: t });
  }
  for (const el of doc.querySelectorAll('[aria-hidden="true"]')) {
    for (const f of el.matches(FOCUSABLE_SEL) ? [el] : el.querySelectorAll(FOCUSABLE_SEL)) {
      if (a11y.hiddenFocusable.length < 30 && f.getAttribute('tabindex') !== '-1') a11y.hiddenFocusable.push({ selector: selectorFor(f) });
    }
  }

  // --- names for buttons
  const accNameOf = (el) => {
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return al.trim();
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => (doc.getElementById(id) || {}).textContent || '').join(' ').trim();
      if (t) return t;
    }
    if (el.localName === 'input') return (el.value || el.getAttribute('title') || (el.type === 'submit' ? 'Submit' : el.type === 'reset' ? 'Reset' : '')).trim();
    const text = (el.innerText || el.textContent || '').trim();
    if (text) return text;
    const img = el.querySelector('img[alt]');
    if (img && img.getAttribute('alt').trim()) return img.getAttribute('alt').trim();
    const svgTitle = el.querySelector('svg title');
    if (svgTitle && svgTitle.textContent.trim()) return svgTitle.textContent.trim();
    return (el.getAttribute('title') || '').trim();
  };
  for (const el of doc.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]')) {
    if (a11y.unnamedButtons.length >= 30) break;
    if (isVisible(el) && !accNameOf(el)) a11y.unnamedButtons.push({ selector: selectorFor(el) });
  }

  // --- ids and ARIA references
  const idCount = new Map();
  for (const el of doc.querySelectorAll('[id]')) idCount.set(el.id, (idCount.get(el.id) || 0) + 1);
  const dupes = [...idCount.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  a11y.duplicateIds.total = dupes.length;
  const referenced = new Set();
  for (const el of doc.querySelectorAll('[aria-labelledby], [aria-describedby], [aria-controls], [aria-owns], [aria-activedescendant], label[for]')) {
    for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'for']) {
      const v = el.getAttribute(attr);
      if (!v) continue;
      for (const id of v.split(/\s+/).filter(Boolean)) {
        referenced.add(id);
        if (!idCount.has(id) && a11y.brokenAriaRefs.length < 30) a11y.brokenAriaRefs.push({ selector: selectorFor(el), attr, id: clip(id, 40) });
      }
    }
  }
  a11y.duplicateIds.referenced = dupes.filter((id) => referenced.has(id)).slice(0, 20).map((id) => clip(id, 40));

  for (const el of doc.querySelectorAll('[role]')) {
    const roles = (el.getAttribute('role') || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (roles.length && !roles.some((r) => VALID_ROLES.has(r)) && a11y.invalidRoles.length < 20) a11y.invalidRoles.push({ selector: selectorFor(el), role: clip(roles.join(' '), 30) });
  }

  // --- media
  for (const m of doc.querySelectorAll('video[autoplay], audio[autoplay]')) {
    if (a11y.autoplay.length < 10) a11y.autoplay.push({ selector: selectorFor(m), tag: m.localName, muted: m.muted || m.hasAttribute('muted'), controls: m.hasAttribute('controls') });
  }
  for (const v of doc.querySelectorAll('video')) {
    if (!isVisible(v) || v.muted || v.hasAttribute('muted') && v.hasAttribute('autoplay') && v.hasAttribute('loop')) continue; // background videos
    if (!v.querySelector('track[kind="captions"], track[kind="subtitles"]') && a11y.videosNoCaptions.length < 10) a11y.videosNoCaptions.push({ selector: selectorFor(v) });
  }

  // --- skip link: a same-page link among the first few focusable elements
  a11y.skipLink = focusables.slice(0, 5).some((el) => el.localName === 'a' && /^#./.test(el.getAttribute('href') || '') && /skip|jump|main|content/i.test(el.textContent + ' ' + (el.getAttribute('aria-label') || ''))) ||
    [...doc.querySelectorAll('a[href^="#"]')].slice(0, 5).some((a) => /skip to|skip navigation|jump to/i.test(a.textContent));

  // --- clickable things a keyboard cannot reach (cursor: pointer on non-interactive elements)
  const interactiveSel = `${NATIVE_INTERACTIVE}, ${ROLE_INTERACTIVE}`;
  for (const el of sample) {
    if (a11y.clickOnly.length >= 30) break;
    if (el.matches(interactiveSel) || el.closest(interactiveSel)) continue;
    if (cs(el).cursor !== 'pointer') continue;
    const parent = el.parentElement;
    if (parent && cs(parent).cursor === 'pointer') continue; // report the outermost only
    if (el.querySelector(interactiveSel)) continue; // wraps a real control
    const r = el.getBoundingClientRect();
    if (r.width < 12 || r.height < 12 || !isVisible(el)) continue;
    a11y.clickOnly.push({ selector: selectorFor(el), label: clip(el.innerText || el.getAttribute('aria-label') || `<${el.localName}>`, 40) });
  }

  // --- link text and tables
  for (const a of doc.querySelectorAll('a[href]')) {
    if (a11y.genericLinks.length >= 30) break;
    if (a.getAttribute('aria-label') || a.getAttribute('aria-labelledby')) continue;
    const t = (a.innerText || '').replace(/[→»›>…\s]+$/u, '').trim();
    if (GENERIC_LINK.test(t) && isVisible(a)) a11y.genericLinks.push({ selector: selectorFor(a), text: clip(t, 30) });
  }
  for (const t of doc.querySelectorAll('table')) {
    if (a11y.tablesNoHeaders.length >= 10) break;
    const role = t.getAttribute('role');
    if (role === 'presentation' || role === 'none' || !isVisible(t)) continue;
    if (t.rows.length > 2 && !t.querySelector('th, [role="columnheader"], [role="rowheader"]')) a11y.tablesNoHeaders.push({ selector: selectorFor(t), rows: t.rows.length });
  }

  const refresh = doc.querySelector('meta[http-equiv="refresh" i]');
  if (refresh) {
    const c = refresh.getAttribute('content') || '';
    const secs = parseInt(c, 10);
    a11y.metaRefresh = { seconds: Number.isFinite(secs) ? secs : null, redirects: /url\s*=/i.test(c) };
  }

  // --- performance hints
  const hints = { preconnect: [], dnsPrefetch: [], preload: 0 };
  for (const l of doc.querySelectorAll('link[rel]')) {
    const rel = l.rel.toLowerCase();
    const su = l.href ? safeUrl(l.href) : null;
    if (/preconnect/.test(rel) && su && su.host) hints.preconnect.push(su.host);
    if (/dns-prefetch/.test(rel) && su && su.host) hints.dnsPrefetch.push(su.host);
    if (/preload|modulepreload/.test(rel)) hints.preload += 1;
  }
  const fontDisplay = [];
  try {
    for (const ff of doc.fonts) fontDisplay.push({ family: clip(ff.family.replace(/^["']|["']$/g, ''), 40), display: ff.display || 'auto', status: ff.status });
  } catch { /* ignore */ }

  // ---------------------------------------------------------------- result

  return {
    schema: 1,
    scannedAt: Date.now(),
    page,
    meta: metaInfo,
    a11y,
    hints: { ...hints, fontDisplay },
    structure: { headings, headingCounts, landmarks, sections },
    design: {
      palette,
      colors: colors.slice(0, 40).map((c) => ({ ...c, share: round(c.share, 4) })),
      colorCount: colors.length,
      nearDuplicates: nearDuplicates.slice(0, 30),
      fonts: fontList,
      webFonts: [...webFonts.values()].slice(0, 20),
      typeScale: { steps, basePx, medianRatio: medianRatio ? round(medianRatio, 3) : null, scaleName },
      spacing: { values: spacingValues, distinct: spacing.size, onGrid4: spaceTotal ? round(on4 / spaceTotal, 3) : null, onGrid8: spaceTotal ? round(on8 / spaceTotal, 3) : null },
      radii: { values: radiiValues, distinct: radii.size },
      shadows: { values: shadowValues, distinct: shadows.size, textShadows: textShadowCount },
      components
    },
    text: { readability, contrastGroups: [...contrastGroups.values()].sort((a, b) => b.chars - a.chars) },
    media: { images, imageCount: imgEls.length, iframes },
    interaction: { links, forms, fields, passwordFieldsOutsideForms, targets, ctas: ctas.slice(0, 10) },
    code: { scripts, styleSheets, inlineHandlers, javascriptHrefs: jsHrefs, comments, mixedContent: mixed },
    storage,
    performance: performanceInfo,
    tech: [...tech.values()],
    stats: {
      extractMs: Math.round(performance.now() - T0),
      elementsTotal: bodyEls.length,
      elementsSampled: sample.length,
      elementsVisible: scannedVisible
    }
  };
})().catch((err) => ({ error: 'extract-failed', message: String((err && err.message) || err) }));
