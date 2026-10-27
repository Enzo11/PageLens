/* PageLens — content/analyze.js
 *
 * The rule engine. Small pure functions read the extracted scan (plus the
 * passive header re-fetch and optional cookie flags) and return issues.
 * No AI, no network, no randomness: the same scan always gives the same issues.
 *
 * Classic script: attaches PageLensAnalyze to globalThis. Runs in the popup
 * today; it has no DOM dependency so it can also run in a content script or
 * a worker later.
 *
 * Issue shape:
 *   { id, area, severity, title, why, fix, effort, where[], whereText,
 *     count, ref, tech, data }
 *   area      accessibility | performance | uiux | security | design | seo
 *   severity  critical | high | medium | low
 *   effort    quick | moderate | involved
 *   where     CSS selectors for click-to-highlight
 *
 * Security rules are PASSIVE: they only interpret what the browser loaded.
 * Findings never contain exploit steps or any cookie/storage/field values.
 */
(function (root) {
  'use strict';

  const C = root.PageLensColor;
  const RULES = [];

  function rule(id, area, fn) {
    RULES.push({ id, area, fn });
  }

  // ------------------------------------------------------------ helpers

  const fmtKB = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const sels = (arr, n = 12) => uniq(arr).slice(0, n);
  const fileName = (url) => {
    const p = String(url || '').replace(/\/$/, '').split('/');
    return p[p.length - 1] || url;
  };
  const listNames = (arr, n = 3) => {
    const shown = arr.slice(0, n);
    return shown.join(', ') + (arr.length > n ? ` and ${arr.length - n} more` : '');
  };

  function isLocalHost(host) {
    return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/.test(host) || /\.(localhost|test|local)$/.test(host);
  }

  function cmpVersion(a, b) {
    const pa = String(a).replace(/^[vr]/, '').split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
    const pb = String(b).replace(/^[vr]/, '').split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  function parseCsp(value) {
    const out = {};
    for (const policy of String(value || '').split(',')) {
      for (const part of policy.split(';')) {
        const [name, ...vals] = part.trim().split(/\s+/);
        if (name && !out[name.toLowerCase()]) out[name.toLowerCase()] = vals.map((v) => v.toLowerCase());
      }
    }
    return out;
  }

  // ------------------------------------------------------------ bundled data

  /** Known-vulnerable library versions. Matching is by detected name + version only. */
  const VULNERABLE_LIBS = [
    { lib: 'jQuery', below: '3.5.0', severity: 'high', note: 'Cross-site scripting when handling HTML (CVE-2020-11022, CVE-2020-11023)', upgrade: '3.7 or later' },
    { lib: 'jQuery UI', below: '1.13.2', severity: 'medium', note: 'Cross-site scripting in widget options (CVE-2021-41182, CVE-2021-41183, CVE-2021-41184, CVE-2022-31160)', upgrade: '1.13.2 or later' },
    { lib: 'Bootstrap', below: '3.4.1', severity: 'medium', note: 'Cross-site scripting in tooltip and popover (CVE-2019-8331)', upgrade: '3.4.1, or 5.x' },
    { lib: 'Bootstrap', from: '4.0.0', below: '4.3.1', severity: 'medium', note: 'Cross-site scripting in tooltip and popover (CVE-2019-8331)', upgrade: '4.3.1 or later' },
    { lib: 'Lodash', below: '4.17.21', severity: 'high', note: 'Prototype pollution and command injection (CVE-2019-10744, CVE-2020-8203, CVE-2021-23337)', upgrade: '4.17.21 or later' },
    { lib: 'Underscore', from: '1.3.2', below: '1.12.1', severity: 'high', note: 'Code execution through templates (CVE-2021-23358)', upgrade: '1.13 or later' },
    { lib: 'Moment.js', below: '2.29.4', severity: 'medium', note: 'Slow-down attack in date parsing (CVE-2022-31129)', upgrade: '2.29.4, or a maintained date library' },
    { lib: 'AngularJS', below: '999', severity: 'high', note: 'AngularJS reached end of life in December 2021 and gets no security fixes', upgrade: 'a maintained framework' },
    { lib: 'Handlebars', below: '4.7.7', severity: 'high', note: 'Code execution through templates (CVE-2021-23369, CVE-2021-23383)', upgrade: '4.7.7 or later' },
    { lib: 'DOMPurify', below: '2.5.4', severity: 'medium', note: 'Sanitizer bypass (CVE-2024-45801)', upgrade: '3.1.3 or later' },
    { lib: 'DOMPurify', from: '3.0.0', below: '3.1.3', severity: 'medium', note: 'Sanitizer bypass (CVE-2024-45801)', upgrade: '3.1.3 or later' },
    { lib: 'Chart.js', below: '2.9.4', severity: 'medium', note: 'Prototype pollution (CVE-2020-7746)', upgrade: '2.9.4 or 4.x' },
    { lib: 'Axios', from: '0.8.1', below: '1.6.0', severity: 'medium', note: 'Leaks the CSRF token to other hosts (CVE-2023-45857)', upgrade: '1.6.0 or later' },
    { lib: 'Vue', from: '2.0.0', below: '3.0.0', severity: 'low', note: 'Vue 2 reached end of life on 31 December 2023', upgrade: 'Vue 3' }
  ];

  /** Brands commonly imitated by phishing pages, with the sites they really use. */
  const BRANDS = {
    paypal: ['paypal.com', 'paypal.me'],
    apple: ['apple.com', 'icloud.com'],
    icloud: ['icloud.com', 'apple.com'],
    microsoft: ['microsoft.com', 'live.com', 'office.com', 'microsoftonline.com', 'outlook.com'],
    office365: ['office.com', 'microsoft.com'],
    outlook: ['outlook.com', 'live.com', 'microsoft.com'],
    google: ['google.com', 'google.co.in', 'google.co.uk', 'youtube.com', 'gmail.com'],
    gmail: ['gmail.com', 'google.com'],
    amazon: ['amazon.com', 'amazon.in', 'amazon.co.uk', 'amazon.de', 'aws.amazon.com', 'amazonaws.com'],
    facebook: ['facebook.com', 'fb.com', 'meta.com'],
    instagram: ['instagram.com'],
    whatsapp: ['whatsapp.com', 'whatsapp.net'],
    netflix: ['netflix.com'],
    linkedin: ['linkedin.com'],
    github: ['github.com', 'github.io', 'githubusercontent.com'],
    dropbox: ['dropbox.com'],
    coinbase: ['coinbase.com'],
    binance: ['binance.com'],
    metamask: ['metamask.io'],
    chase: ['chase.com'],
    wellsfargo: ['wellsfargo.com'],
    hdfcbank: ['hdfcbank.com'],
    icicibank: ['icicibank.com'],
    sbi: ['onlinesbi.sbi', 'sbi.co.in'],
    paytm: ['paytm.com'],
    steam: ['steampowered.com', 'steamcommunity.com']
  };

  function deLeet(s) {
    return s.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e')
      .replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/\$/g, 's');
  }
  function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return dp[a.length][b.length];
  }

  const TRACKERS = new Set(['Google Analytics', 'Google Tag Manager', 'Meta Pixel', 'Hotjar', 'Segment', 'Microsoft Clarity']);
  const SECRET_NAME = /(token|secret|jwt|auth|passw|api[_-]?key|credential|bearer|private[_-]?key|access[_-]?key)/i;
  const SESSION_COOKIE = /(sess|^sid$|_sid$|auth|token|jwt|login|remember)/i;
  const TRACKING_COOKIE = /^(_ga|_gid|_gcl|_fbp|_fbc|_hj|_clck|_clsk|ajs_|_uetsid|_uetvid|__utm|_pin_unauth|_tt_)/i;

  // ============================================================ ACCESSIBILITY (WCAG 2.2)

  rule('contrast', 'accessibility', ({ scan }) => {
    const pairs = new Map();
    let checkedChars = 0;
    let failChars = 0;
    let overImage = 0;
    for (const g of scan.text.contrastGroups) {
      if (!g.bg) { overImage += 1; continue; }
      const fg = C.parse(g.fg);
      const bg = C.parse(g.bg);
      if (!fg || !bg) continue;
      checkedChars += g.chars;
      const ratio = C.contrast(fg, bg);
      const need = g.large ? 3 : 4.5;
      if (ratio + 0.005 >= need) continue;
      failChars += g.chars;
      const key = `${g.fg}|${g.bg}`;
      const p = pairs.get(key) || { fg: g.fg, bg: g.bg, ratio, need: 0, chars: 0, count: 0, selectors: [], sample: g.sample, large: g.large };
      p.need = Math.max(p.need, need);
      p.ratio = Math.min(p.ratio, ratio);
      p.chars += g.chars;
      p.count += g.count;
      p.selectors.push(...g.selectors);
      pairs.set(key, p);
    }
    if (!pairs.size) return null;
    const list = [...pairs.values()].sort((a, b) => b.chars - a.chars).map((p) => ({
      fg: p.fg, bg: p.bg, ratio: Math.round(p.ratio * 100) / 100, need: p.need, chars: p.chars, count: p.count,
      sample: p.sample, selectors: sels(p.selectors, 4),
      suggestion: C.suggestPassing(C.parse(p.fg), C.parse(p.bg), p.need)
    }));
    const share = checkedChars ? failChars / checkedChars : 0;
    const severe = list.some((p) => p.ratio < (p.need === 3 ? 2 : 3)) || share > 0.2;
    return {
      severity: severe ? 'high' : 'medium',
      title: `${plural(list.length, 'text color')} too faint to read easily`,
      why: `${Math.round(share * 100)}% of the text doesn't stand out enough from its background. People with low vision, older screens or bright sunlight will struggle to read it.`,
      fix: `Darken (or lighten) the text color until it reaches 4.5:1 contrast for normal text or 3:1 for large text. PageLens suggests a passing color for each pair.`,
      effort: 'quick',
      where: sels(list.flatMap((p) => p.selectors)),
      count: list.reduce((a, p) => a + p.count, 0),
      ref: 'WCAG 2.2 · 1.4.3 Contrast (Minimum)',
      tech: `Ratio = (L1 + 0.05) / (L2 + 0.05). Worst pair ${list[0].fg} on ${list[0].bg} = ${list[0].ratio}:1.${overImage ? ` ${overImage} text groups sit on background images and were not checked.` : ''}`,
      data: { pairs: list.slice(0, 12), overImage }
    };
  });

  rule('img-alt', 'accessibility', ({ scan }) => {
    const missing = scan.media.images.filter((i) => i.visible && i.alt === null && !i.ariaHidden &&
      i.role !== 'presentation' && i.role !== 'none' && !i.ariaLabel && i.width > 1 && i.height > 1);
    if (!missing.length) return null;
    return {
      severity: 'high',
      title: `${plural(missing.length, 'image')} with no description`,
      why: 'Screen readers announce these images by file name or skip them, so blind visitors miss what they show.',
      fix: 'Add an alt attribute to every image: a short description for meaningful images, or alt="" for purely decorative ones.',
      effort: 'quick',
      where: sels(missing.map((i) => i.selector)),
      count: missing.length,
      ref: 'WCAG 2.2 · 1.1.1 Non-text Content',
      tech: `<img> elements without an alt attribute: ${listNames(missing.map((i) => fileName(i.src)))}.`
    };
  });

  rule('link-name', 'accessibility', ({ scan }) => {
    const empty = scan.interaction.links.emptyName;
    if (!empty.length) return null;
    return {
      severity: 'high',
      title: `${plural(empty.length, 'link')} with no readable name`,
      why: 'These links (often icons or images) have no text, so screen readers just say "link" and nobody knows where they go.',
      fix: 'Give each link visible text, an aria-label, or a descriptive alt on the image inside it.',
      effort: 'quick',
      where: sels(empty.map((l) => l.selector)),
      count: empty.length,
      ref: 'WCAG 2.2 · 2.4.4 Link Purpose, 4.1.2 Name, Role, Value'
    };
  });

  rule('form-label', 'accessibility', ({ scan }) => {
    const bad = scan.interaction.fields.filter((f) => f.visible && !f.label);
    if (!bad.length) return null;
    const placeholderOnly = bad.filter((f) => f.hasPlaceholder).length;
    return {
      severity: 'high',
      title: `${plural(bad.length, 'form field')} without a label`,
      why: `Screen readers can't tell people what to type here${placeholderOnly ? ', and placeholder text vanishes as soon as you start typing' : ''}.`,
      fix: 'Add a <label for="…"> for each field (or aria-label if a visible label truly doesn\'t fit). A placeholder is not a label.',
      effort: 'quick',
      where: sels(bad.map((f) => f.selector)),
      count: bad.length,
      ref: 'WCAG 2.2 · 1.3.1 Info and Relationships, 4.1.2 Name, Role, Value',
      tech: `${placeholderOnly} of these rely on placeholder only. Types: ${listNames(uniq(bad.map((f) => f.type)), 5)}.`
    };
  });

  rule('h1', 'accessibility', ({ scan }) => {
    const n = scan.structure.headingCounts.h1;
    if (n === 1) return null;
    const h1s = scan.structure.headings.filter((h) => h.level === 1);
    if (n === 0) {
      return {
        severity: 'medium',
        title: 'No main heading (H1)',
        why: 'The H1 tells screen-reader users and search engines what the page is about. Without it the page has no clear title inside the content.',
        fix: 'Mark the page\'s main title as a single <h1>.',
        effort: 'quick',
        whereText: 'Whole page',
        ref: 'WCAG 2.2 · 1.3.1 Info and Relationships (best practice)'
      };
    }
    return {
      severity: 'low',
      title: `${n} main headings (H1) instead of one`,
      why: 'Several H1s make it unclear which one is the page title.',
      fix: 'Keep one <h1> for the page title and turn the others into <h2>.',
      effort: 'quick',
      where: sels(h1s.map((h) => h.selector)),
      count: n,
      ref: 'Best practice'
    };
  });

  rule('heading-order', 'accessibility', ({ scan }) => {
    const hs = scan.structure.headings;
    const skips = [];
    let prev = 0;
    for (const h of hs) {
      if (prev && h.level > prev + 1) skips.push({ from: prev, to: h.level, selector: h.selector, text: h.text });
      prev = h.level;
    }
    if (!skips.length) return null;
    return {
      severity: 'low',
      title: `Heading levels skip ${plural(skips.length, 'time')}`,
      why: `The outline jumps (for example H${skips[0].from} → H${skips[0].to}), which makes the page structure confusing for screen-reader users who navigate by headings.`,
      fix: 'Use heading levels in order (H2 after H1, H3 after H2) and style them with CSS instead of picking a level for its size.',
      effort: 'quick',
      where: sels(skips.map((s) => s.selector)),
      count: skips.length,
      ref: 'WCAG 2.2 · 1.3.1 Info and Relationships (best practice)'
    };
  });

  rule('heading-empty', 'accessibility', ({ scan }) => {
    const empty = scan.structure.headings.filter((h) => h.empty);
    if (!empty.length) return null;
    return {
      severity: 'medium',
      title: `${plural(empty.length, 'empty heading')}`,
      why: 'Screen readers announce a heading with nothing in it, which is confusing.',
      fix: 'Remove empty heading tags or put the intended text inside them.',
      effort: 'quick',
      where: sels(empty.map((h) => h.selector)),
      count: empty.length,
      ref: 'WCAG 2.2 · 1.3.1, 2.4.6 Headings and Labels'
    };
  });

  rule('lang', 'accessibility', ({ scan }) => {
    if (scan.page.lang && scan.page.lang.trim()) return null;
    return {
      severity: 'medium',
      title: 'Page language is not set',
      why: 'Screen readers use the language setting to pronounce words. Without it they may read the page with the wrong accent or voice.',
      fix: 'Add a lang attribute to the <html> tag, for example <html lang="en">.',
      effort: 'quick',
      where: ['html'],
      ref: 'WCAG 2.2 · 3.1.1 Language of Page'
    };
  });

  rule('target-size', 'accessibility', ({ scan }) => {
    const small = scan.interaction.targets.small.filter((t) => !t.inline && (t.width < 24 || t.height < 24));
    if (!small.length) return null;
    return {
      severity: small.length >= 5 ? 'medium' : 'low',
      title: `${plural(small.length, 'button or link', 'buttons or links')} smaller than 24×24 px`,
      why: 'Small targets are hard to tap on a phone and hard to hit for anyone with shaky hands.',
      fix: 'Make each clickable area at least 24×24 px (padding works), or leave enough space around it.',
      effort: 'moderate',
      where: sels(small.map((t) => t.selector)),
      count: small.length,
      ref: 'WCAG 2.2 · 2.5.8 Target Size (Minimum)',
      tech: 'Targets can still pass if a 24 px circle around each one does not overlap a neighbour; spacing is not measured here.'
    };
  });

  rule('zoom', 'accessibility', ({ scan }) => {
    const vp = (scan.meta.viewport || '').toLowerCase();
    const noScale = /user-scalable\s*=\s*(no|0)/.test(vp);
    const max = /maximum-scale\s*=\s*([\d.]+)/.exec(vp);
    if (!noScale && !(max && parseFloat(max[1]) < 2)) return null;
    return {
      severity: 'high',
      title: 'Zooming is turned off on phones',
      why: 'People with low vision pinch to zoom. This page blocks that.',
      fix: 'Remove user-scalable=no and any maximum-scale below 2 from the viewport meta tag.',
      effort: 'quick',
      whereText: '<meta name="viewport">',
      ref: 'WCAG 2.2 · 1.4.4 Resize Text',
      tech: `viewport: ${scan.meta.viewport}`
    };
  });

  rule('main-landmark', 'accessibility', ({ scan }) => {
    if (scan.structure.landmarks.some((l) => l.role === 'main')) return null;
    return {
      severity: 'low',
      title: 'No main content region',
      why: 'Screen-reader users jump straight to the main content using the <main> landmark. Without it they must tab through the whole header.',
      fix: 'Wrap the page\'s primary content in a <main> element.',
      effort: 'quick',
      whereText: 'Page structure',
      ref: 'WCAG 2.2 · 1.3.1, 2.4.1 Bypass Blocks'
    };
  });

  rule('iframe-title', 'accessibility', ({ scan }) => {
    const bad = scan.media.iframes.filter((f) => f.visible && !f.title);
    if (!bad.length) return null;
    return {
      severity: 'low',
      title: `${plural(bad.length, 'embedded frame')} without a title`,
      why: 'Screen readers announce frames by their title. Without one, people don\'t know what the embedded content is.',
      fix: 'Add a short title attribute to each <iframe>, like title="Product video".',
      effort: 'quick',
      where: sels(bad.map((f) => f.selector)),
      count: bad.length,
      ref: 'WCAG 2.2 · 4.1.2 Name, Role, Value'
    };
  });

  // ============================================================ PERFORMANCE

  rule('page-weight', 'performance', ({ scan }) => {
    const b = scan.performance.totalBytes;
    if (b <= 2 * 1024 * 1024) return null;
    const top = Object.entries(scan.performance.byType).sort((a, b) => b[1].bytes - a[1].bytes)[0];
    return {
      severity: b > 5 * 1024 * 1024 ? 'high' : 'medium',
      title: `Page is heavy (${fmtKB(b)})`,
      why: 'Large pages load slowly on mobile data and cost visitors money on metered connections.',
      fix: `Aim for under 2 MB. Most of the weight is ${top ? top[0] : 'files'} (${top ? fmtKB(top[1].bytes) : ''}) — start there.`,
      effort: 'involved',
      whereText: 'All requests',
      ref: 'Budget: 2 MB'
    };
  });

  rule('requests', 'performance', ({ scan }) => {
    const n = scan.performance.requests;
    if (n <= 100) return null;
    return {
      severity: n > 200 ? 'medium' : 'low',
      title: `${n} separate files load`,
      why: 'Each file is another round trip. Many small requests slow the page, especially on mobile.',
      fix: 'Combine or remove unused scripts, styles and images; lazy-load what is not needed at first.',
      effort: 'involved',
      whereText: 'Network requests',
      count: n
    };
  });

  rule('heavy-images', 'performance', ({ scan }) => {
    const seen = new Set();
    const heavy = [];
    for (const r of scan.performance.resources) {
      if (r.kind === 'image' && r.bytes > 100 * 1024 && !seen.has(r.url)) { seen.add(r.url); heavy.push(r); }
    }
    if (!heavy.length) return null;
    const total = heavy.reduce((a, r) => a + r.bytes, 0);
    const selectors = scan.media.images.filter((i) => seen.has(i.src)).map((i) => i.selector);
    return {
      severity: total > 1024 * 1024 ? 'high' : 'medium',
      title: `${plural(heavy.length, 'image')} over 100 KB (${fmtKB(total)} total)`,
      why: 'Big images are usually the main reason pages load slowly.',
      fix: 'Compress them and serve modern formats (WebP or AVIF) at the size they are shown. Most photos fit in 50–150 KB.',
      effort: 'moderate',
      where: sels(selectors),
      whereText: listNames(heavy.map((r) => fileName(r.url))),
      count: heavy.length,
      data: { files: heavy.slice(0, 10).map((r) => ({ name: fileName(r.url), bytes: r.bytes })) }
    };
  });

  rule('oversized-images', 'performance', ({ scan }) => {
    const dpr = scan.page.viewport.dpr || 1;
    const big = scan.media.images.filter((i) => i.visible && i.width > 0 && i.naturalWidth > 2 * i.width * dpr && i.naturalWidth > 200);
    if (!big.length) return null;
    return {
      severity: 'medium',
      title: `${plural(big.length, 'image')} much larger than shown`,
      why: 'These images are downloaded at more than twice the size they appear on screen, wasting data and time.',
      fix: 'Resize them to the displayed size (×2 for sharp screens), or use srcset so the browser picks the right size.',
      effort: 'moderate',
      where: sels(big.map((i) => i.selector)),
      count: big.length,
      tech: big.slice(0, 3).map((i) => `${fileName(i.src)}: ${i.naturalWidth}px file shown at ${i.width}px`).join('; ')
    };
  });

  rule('lazy-images', 'performance', ({ scan }) => {
    const below = scan.media.images.filter((i) => !i.aboveFold && i.loading !== 'lazy' && i.width * i.height > 10000);
    if (below.length < 3) return null;
    return {
      severity: 'low',
      title: `${plural(below.length, 'image')} below the first screen ${below.length === 1 ? 'loads' : 'load'} straight away`,
      why: 'Images people may never scroll to compete with what they see first.',
      fix: 'Add loading="lazy" to images that start below the first screen.',
      effort: 'quick',
      where: sels(below.map((i) => i.selector)),
      count: below.length
    };
  });

  rule('render-blocking', 'performance', ({ scan }) => {
    const urls = new Map();
    for (const r of scan.performance.renderBlocking) urls.set(r.url, r);
    for (const s of scan.code.scripts.external) if (s.parserBlocking && !urls.has(s.url)) urls.set(s.url, { url: s.url, kind: 'script' });
    const list = [...urls.values()];
    if (!list.length) return null;
    const scripts = list.filter((r) => r.kind === 'script').length;
    return {
      severity: list.length >= 6 ? 'high' : 'medium',
      title: `${plural(list.length, 'file')} ${list.length === 1 ? 'holds' : 'hold'} up the first paint`,
      why: 'The browser waits for these before showing anything, so visitors stare at a blank screen longer.',
      fix: `${scripts ? 'Add defer (or async) to scripts in the <head>. ' : ''}Inline the small amount of CSS needed for the first screen and load the rest without blocking.`,
      effort: 'moderate',
      whereText: listNames(list.map((r) => fileName(r.url))),
      count: list.length
    };
  });

  rule('lcp', 'performance', ({ scan }) => {
    const l = scan.performance.lcp;
    if (!l || l.time <= 2500) return null;
    return {
      severity: l.time > 4000 ? 'high' : 'medium',
      title: `Main content appears slowly (${(l.time / 1000).toFixed(1)} s)`,
      why: 'Largest Contentful Paint measures when the biggest thing on screen shows up. Over 2.5 s feels slow; over 4 s many people leave.',
      fix: 'Make the hero image or heading load first: compress it, preload it, and remove render-blocking files.',
      effort: 'involved',
      where: l.element ? [l.element] : [],
      ref: 'Core Web Vitals · LCP ≤ 2.5 s',
      tech: `Measured in this tab: ${l.time} ms${l.url ? ` (${fileName(l.url)})` : ''}.`
    };
  });

  rule('cls', 'performance', ({ scan }) => {
    const c = scan.performance.cls;
    if (!(c > 0.1)) return null;
    return {
      severity: c > 0.25 ? 'high' : 'medium',
      title: `Page content jumps while loading (CLS ${c})`,
      why: 'Things move as late images, ads or fonts arrive, so people tap the wrong thing.',
      fix: 'Give images and embeds width and height, reserve space for ads and banners, and avoid inserting content above what is already shown.',
      effort: 'moderate',
      whereText: 'Layout during load',
      ref: 'Core Web Vitals · CLS ≤ 0.1'
    };
  });

  rule('ttfb', 'performance', ({ scan }) => {
    const n = scan.performance.navigation;
    if (!n || n.type === 'back_forward' || n.ttfb <= 800) return null;
    return {
      severity: n.ttfb > 1800 ? 'medium' : 'low',
      title: `Server is slow to answer (${n.ttfb} ms)`,
      why: 'Nothing can start loading until the server replies with the page.',
      fix: 'Cache pages on a CDN, speed up database queries, or use a faster host.',
      effort: 'involved',
      whereText: 'Server response',
      ref: 'Time to First Byte ≤ 800 ms'
    };
  });

  rule('compression', 'performance', ({ scan, headers }) => {
    if (!headers) return null;
    const n = scan.performance.navigation;
    const decoded = n ? n.documentDecoded : 0;
    if (headers['content-encoding'] || decoded < 20 * 1024) return null;
    return {
      severity: 'medium',
      title: 'Page is sent without compression',
      why: `The HTML (${fmtKB(decoded)}) travels uncompressed. Turning on compression usually makes it 70% smaller.`,
      fix: 'Enable gzip or Brotli on the server or CDN.',
      effort: 'quick',
      whereText: 'Response headers (Content-Encoding)'
    };
  });

  rule('dom-size', 'performance', ({ scan }) => {
    const n = scan.page.elementCount;
    if (n <= 1500) return null;
    return {
      severity: n > 3000 ? 'medium' : 'low',
      title: `Very large page structure (${n.toLocaleString()} elements)`,
      why: 'Big pages use more memory and make scrolling and clicks feel sluggish on cheaper phones.',
      fix: 'Remove hidden or duplicated markup, and render long lists only as they scroll into view.',
      effort: 'involved',
      whereText: 'DOM',
      ref: 'Lighthouse guideline: ≤ 1,500 elements'
    };
  });

  rule('third-party-scripts', 'performance', ({ scan }) => {
    const ext = scan.code.scripts.external.filter((s) => s.thirdParty);
    const hosts = uniq(ext.map((s) => s.host));
    if (hosts.length <= 8) return null;
    return {
      severity: 'low',
      title: `Scripts from ${hosts.length} other companies`,
      why: 'Each outside script adds download time and can slow or break the page if that company has problems.',
      fix: 'Remove scripts you no longer use and load the rest with defer or after the page is ready.',
      effort: 'moderate',
      whereText: listNames(hosts, 4),
      count: hosts.length
    };
  });

  // ============================================================ UI / UX

  rule('primary-action', 'uiux', ({ scan }) => {
    const ctas = scan.interaction.ctas;
    const filled = ctas.filter((c) => c.filled && c.label);
    if (!ctas.length) return null; // content-only page
    if (!filled.length) {
      return {
        severity: 'medium',
        title: 'No clear main action on the first screen',
        why: 'Visitors should see straight away what to do next (sign up, buy, contact). Here nothing stands out as the main button.',
        fix: 'Give the most important action a filled, high-contrast button near the top of the page.',
        effort: 'moderate',
        where: sels(ctas.slice(0, 3).map((c) => c.selector)),
        whereText: 'First screen'
      };
    }
    if (filled.length >= 2 && filled[1].prominence >= filled[0].prominence * 0.8 && filled[0].background !== null && filled[1].background === filled[0].background) {
      return {
        severity: 'low',
        title: 'Two main buttons compete for attention',
        why: `"${filled[0].label}" and "${filled[1].label}" look equally important, so neither feels like the obvious next step.`,
        fix: 'Keep one filled primary button and make the other secondary (outline or text style).',
        effort: 'quick',
        where: [filled[0].selector, filled[1].selector]
      };
    }
    return null;
  });

  rule('base-size', 'uiux', ({ scan }) => {
    const r = scan.text.readability;
    if (!r.totalChars || r.basePx >= 14) return null;
    return {
      severity: 'medium',
      title: `Body text is small (${r.basePx}px)`,
      why: 'Text below 14 px is tiring to read, especially on phones and for older readers.',
      fix: 'Use 16 px for body text (at least 14 px for dense interfaces).',
      effort: 'quick',
      whereText: 'Body text',
      ref: 'Readability guideline: 16 px body text'
    };
  });

  rule('small-text', 'uiux', ({ scan }) => {
    const r = scan.text.readability;
    if (!(r.smallTextShare > 0.1)) return null;
    return {
      severity: 'low',
      title: `${Math.round(r.smallTextShare * 100)}% of text is tiny (under 12px)`,
      why: 'A lot of very small text is hard to read and easy to miss.',
      fix: 'Keep text at 12 px or larger; reserve the smallest size for legal notes.',
      effort: 'quick',
      whereText: 'Small text'
    };
  });

  rule('line-length', 'uiux', ({ scan }) => {
    const r = scan.text.readability;
    if (!r.medianLineChars || r.medianLineChars <= 90) return null;
    return {
      severity: 'low',
      title: `Lines of text are very long (~${r.medianLineChars} characters)`,
      why: 'Very wide paragraphs make it hard to find the start of the next line.',
      fix: 'Limit paragraphs to about 60–80 characters, e.g. max-width: 70ch.',
      effort: 'quick',
      whereText: 'Paragraphs',
      ref: 'Readability guideline: 45–90 characters per line'
    };
  });

  rule('line-height', 'uiux', ({ scan }) => {
    const r = scan.text.readability;
    if (!r.baseLineHeight || r.baseLineHeight >= 1.3 || r.paragraphs < 1) return null;
    return {
      severity: 'low',
      title: `Body text lines are cramped (line-height ${r.baseLineHeight})`,
      why: 'Tight lines make paragraphs feel dense and harder to follow.',
      fix: 'Use a line-height around 1.5 for body text.',
      effort: 'quick',
      whereText: 'Body text',
      ref: 'WCAG 2.2 · 1.4.12 Text Spacing (guidance)'
    };
  });

  rule('h-scroll', 'uiux', ({ scan }) => {
    const over = scan.page.scrollWidth - scan.page.viewport.width;
    if (over <= 4) return null;
    return {
      severity: 'medium',
      title: 'Page scrolls sideways',
      why: `Content is ${over}px wider than the window, so people have to scroll left and right.`,
      fix: 'Find the element that is too wide (often a fixed-width image, table or long word) and let it shrink with max-width: 100%.',
      effort: 'moderate',
      whereText: 'Layout width',
      ref: 'WCAG 2.2 · 1.4.10 Reflow'
    };
  });

  rule('navigation', 'uiux', ({ scan }) => {
    const navs = scan.structure.landmarks.filter((l) => l.role === 'navigation');
    if (navs.length || scan.interaction.links.internal < 8) return null;
    return {
      severity: 'low',
      title: 'No marked-up navigation menu',
      why: 'There are many links but no navigation region, so the menu is harder to find for keyboard and screen-reader users.',
      fix: 'Wrap the main menu in a <nav> element.',
      effort: 'quick',
      whereText: 'Page structure'
    };
  });

  rule('login-autocomplete', 'uiux', ({ scan }) => {
    const bad = scan.interaction.fields.filter((f) => f.visible && ['email', 'password', 'tel'].includes(f.type) && !f.autocomplete);
    if (!bad.length) return null;
    return {
      severity: 'low',
      title: `${plural(bad.length, 'field')} can't be autofilled properly`,
      why: 'Without autocomplete hints, password managers and browsers guess, so signing in takes longer.',
      fix: 'Add autocomplete="email", "current-password", "new-password" or "tel" to the matching fields.',
      effort: 'quick',
      where: sels(bad.map((f) => f.selector)),
      count: bad.length,
      ref: 'WCAG 2.2 · 1.3.5 Identify Input Purpose'
    };
  });

  rule('js-links', 'uiux', ({ scan }) => {
    const n = scan.interaction.links.javascript;
    if (n < 1) return null;
    return {
      severity: 'low',
      title: `${plural(n, 'link')} that only run scripts`,
      why: 'Links with href="javascript:…" can\'t be opened in a new tab and break if scripts fail.',
      fix: 'Use a <button> for actions and real URLs for links.',
      effort: 'quick',
      whereText: 'Links',
      count: n
    };
  });

  // ============================================================ DESIGN CONSISTENCY

  rule('near-duplicate-colors', 'design', ({ scan }) => {
    const n = scan.design.nearDuplicates.length;
    if (!n) return null;
    return {
      severity: n >= 4 ? 'medium' : 'low',
      title: `${plural(n, 'pair')} of almost-identical colors`,
      why: 'Colors that look the same but are different values make the design harder to keep consistent and maintain.',
      fix: 'Pick one value for each and define them once as design tokens (Copy CSS gives you a starting set).',
      effort: 'moderate',
      whereText: scan.design.nearDuplicates.slice(0, 3).map((p) => `${p.a} ≈ ${p.b}`).join(', '),
      count: n,
      data: { pairs: scan.design.nearDuplicates.slice(0, 12) }
    };
  });

  rule('color-count', 'design', ({ scan }) => {
    const n = scan.design.palette.length;
    if (n <= 16) return null;
    return {
      severity: 'low',
      title: `${n} different main colors`,
      why: 'A large palette usually means colors were picked ad hoc, which makes the site feel less coherent.',
      fix: 'Reduce to a small set: a few neutrals, one or two brand colors, and status colors.',
      effort: 'involved',
      whereText: 'Palette'
    };
  });

  rule('font-count', 'design', ({ scan }) => {
    const fams = scan.design.fonts.filter((f) => f.share >= 0.01 && f.primaryRole !== 'code' && f.source !== 'system');
    if (fams.length <= 3) return null;
    return {
      severity: fams.length > 4 ? 'medium' : 'low',
      title: `${fams.length} different fonts`,
      why: 'More than two or three typefaces looks busy and adds download weight.',
      fix: 'Use one font for headings and one for body text (they can be the same).',
      effort: 'moderate',
      whereText: listNames(fams.map((f) => f.family), 4),
      count: fams.length
    };
  });

  rule('type-scale', 'design', ({ scan }) => {
    const ts = scan.design.typeScale;
    if (ts.steps.length <= 9) return null;
    return {
      severity: 'low',
      title: `${ts.steps.length} different text sizes`,
      why: 'Many close sizes blur the difference between headings and body text.',
      fix: `Settle on a scale of 6–8 sizes${ts.scaleName ? ` (the page roughly follows a ${ts.scaleName} scale already)` : ', for example a 1.25 ratio from a 16px base'}.`,
      effort: 'moderate',
      whereText: 'Type scale',
      count: ts.steps.length
    };
  });

  rule('spacing-grid', 'design', ({ scan }) => {
    const sp = scan.design.spacing;
    if (sp.onGrid4 == null) return null;
    const issues = [];
    if (sp.onGrid4 < 0.6) issues.push(`only ${Math.round(sp.onGrid4 * 100)}% of spacing fits a 4px grid`);
    if (sp.distinct > 30) issues.push(`${sp.distinct} different spacing values`);
    if (!issues.length) return null;
    return {
      severity: 'low',
      title: 'Spacing has no steady rhythm',
      why: `Inconsistent gaps make layouts feel uneven: ${issues.join(' and ')}.`,
      fix: 'Pick a spacing scale based on 4 or 8 px (4, 8, 12, 16, 24, 32, 48…) and use only those values.',
      effort: 'involved',
      whereText: 'Margins, padding and gaps'
    };
  });

  rule('radius-variety', 'design', ({ scan }) => {
    const n = scan.design.radii.distinct;
    if (n <= 6) return null;
    return {
      severity: 'low',
      title: `${n} different corner radii`,
      why: 'Many slightly different roundings make components look like they come from different designs.',
      fix: 'Use three or four radius tokens (small, medium, large, full).',
      effort: 'moderate',
      whereText: 'Corner radius'
    };
  });

  rule('shadow-variety', 'design', ({ scan }) => {
    const n = scan.design.shadows.distinct;
    if (n <= 6) return null;
    return {
      severity: 'low',
      title: `${n} different shadows`,
      why: 'Shadows communicate depth. Too many styles make the hierarchy unclear.',
      fix: 'Define two to four elevation levels and reuse them.',
      effort: 'moderate',
      whereText: 'Shadows'
    };
  });

  rule('button-variety', 'design', ({ scan }) => {
    const v = scan.design.components.buttonVariants;
    if (v.length <= 5) return null;
    return {
      severity: 'low',
      title: `${v.length} different button styles`,
      why: 'Visitors learn what a button looks like. Many styles make it harder to recognize what is clickable.',
      fix: 'Limit buttons to primary, secondary and text (plus a destructive style if needed).',
      effort: 'moderate',
      where: sels(v.map((b) => b.selector)),
      count: v.length
    };
  });

  // ============================================================ PRIVACY & SECURITY (passive)

  rule('https', 'security', ({ scan, local }) => {
    if (scan.page.protocol === 'https' || local || scan.page.protocol === 'file') return null;
    return {
      severity: 'critical',
      title: 'Connection is not secure (no HTTPS)',
      why: 'Anything you see or type on this page can be read or changed by others on the same network, such as public Wi-Fi.',
      fix: 'Serve the whole site over HTTPS (free certificates from Let\'s Encrypt) and redirect http:// to https://.',
      effort: 'moderate',
      whereText: 'Page address'
    };
  });

  rule('insecure-form', 'security', ({ scan, local }) => {
    const forms = scan.interaction.forms.filter((f) => f.actionScheme === 'http' && !isLocalHost(f.actionHost));
    const pwOnHttp = scan.page.protocol === 'http' && !local && scan.interaction.fields.some((f) => f.type === 'password');
    if (!forms.length && !pwOnHttp) return null;
    const pw = forms.some((f) => f.hasPassword) || pwOnHttp;
    return {
      severity: pw ? 'critical' : 'high',
      title: pw ? 'Passwords are sent without encryption' : 'A form sends data without encryption',
      why: pw ? 'Login details typed here travel in plain text and can be captured by anyone on the network.'
        : 'Information typed into this form travels in plain text.',
      fix: 'Make every form submit to an https:// address, and serve the page itself over HTTPS.',
      effort: 'quick',
      where: sels(forms.map((f) => f.selector)),
      whereText: forms.length ? `Form target: ${forms[0].actionHost}` : 'Login form',
      count: forms.length || 1
    };
  });

  rule('mixed-content', 'security', ({ scan }) => {
    const m = scan.code.mixedContent;
    if (!m.length) return null;
    const active = m.some((x) => /script|iframe|link|css|fetch|xmlhttprequest/.test(x.type));
    return {
      severity: active ? 'high' : 'medium',
      title: `${plural(m.length, 'file')} loaded over plain http on a secure page`,
      why: active ? 'Insecure scripts or frames can be swapped by an attacker, undoing the page\'s HTTPS protection.'
        : 'Insecure images can be swapped or tracked on the network, and browsers may block them.',
      fix: 'Change these URLs to https:// (or relative URLs).',
      effort: 'quick',
      whereText: listNames(m.map((x) => x.url), 2),
      count: m.length
    };
  });

  rule('https-downgrade', 'security', ({ headerInfo }) => {
    if (!headerInfo || headerInfo.requestedScheme !== 'https' || headerInfo.finalScheme !== 'http') return null;
    return {
      severity: 'high',
      title: 'Secure address redirects to an insecure one',
      why: 'The https:// address sends visitors to plain http://, dropping encryption.',
      fix: 'Redirect only to https:// URLs.',
      effort: 'quick',
      whereText: `Redirect to ${headerInfo.finalUrl}`
    };
  });

  rule('hsts', 'security', ({ scan, headers }) => {
    if (!headers || scan.page.protocol !== 'https') return null;
    const v = headers['strict-transport-security'];
    if (!v) {
      return {
        severity: 'medium',
        title: 'Browsers are not told to always use HTTPS',
        why: 'Without HSTS, the very first visit can be downgraded to an insecure connection by someone on the network.',
        fix: 'Send Strict-Transport-Security: max-age=31536000; includeSubDomains',
        effort: 'quick',
        whereText: 'Response headers',
        ref: 'Header: Strict-Transport-Security'
      };
    }
    const m = /max-age\s*=\s*"?(\d+)/i.exec(v);
    if (m && Number(m[1]) < 15552000) {
      return {
        severity: 'low',
        title: 'HTTPS protection expires quickly',
        why: `HSTS max-age is ${Math.round(Number(m[1]) / 86400)} days; browsers forget the rule soon after.`,
        fix: 'Use max-age of at least 6 months (15552000), ideally a year.',
        effort: 'quick',
        whereText: 'Strict-Transport-Security',
        tech: v
      };
    }
    return null;
  });

  rule('csp', 'security', ({ headers, scan }) => {
    if (!headers) return null;
    const v = headers['content-security-policy'];
    if (!v) {
      return {
        severity: 'medium',
        title: 'No Content-Security-Policy',
        why: 'A CSP limits which scripts can run, which blunts cross-site scripting attacks if a bug slips in.',
        fix: 'Start with a report-only policy (Content-Security-Policy-Report-Only), then enforce one that allows only your own and trusted script sources.',
        effort: 'involved',
        whereText: 'Response headers',
        ref: 'Header: Content-Security-Policy',
        tech: headers['content-security-policy-report-only'] ? 'A report-only policy is present but not enforced.' : null
      };
    }
    const d = parseCsp(v);
    const src = d['script-src'] || d['default-src'];
    const weak = [];
    if (!src) weak.push('no script-src or default-src');
    else {
      const hasNonceOrHash = src.some((s) => /^'(nonce-|sha256-|sha384-|sha512-)/.test(s));
      const strict = src.includes("'strict-dynamic'");
      if (src.includes("'unsafe-inline'") && !hasNonceOrHash && !strict) weak.push("'unsafe-inline'");
      if (src.includes("'unsafe-eval'")) weak.push("'unsafe-eval'");
      const wild = src.filter((s) => s === '*' || s === 'https:' || s === 'http:' || s === 'data:');
      if (wild.length && !strict) weak.push(`wildcard source (${wild.join(' ')})`);
    }
    if (!weak.length) return null;
    return {
      severity: 'medium',
      title: 'Content-Security-Policy allows risky scripts',
      why: `The policy exists but permits ${weak.join(', ')}, so it gives much weaker protection against injected scripts.`,
      fix: 'Replace unsafe-inline with nonces or hashes, remove unsafe-eval, and list exact script hosts instead of wildcards.',
      effort: 'involved',
      whereText: 'Content-Security-Policy',
      ref: 'Header: Content-Security-Policy',
      tech: `script source list: ${(src || []).join(' ') || '(none)'}${scan.code.inlineHandlers.count ? ` · ${scan.code.inlineHandlers.count} inline event handlers would need refactoring` : ''}`
    };
  });

  rule('clickjacking', 'security', ({ headers }) => {
    if (!headers) return null;
    const xfo = String(headers['x-frame-options'] || '').trim().toUpperCase();
    if (xfo === 'DENY' || xfo === 'SAMEORIGIN') return null;
    const d = parseCsp(headers['content-security-policy']);
    if (d['frame-ancestors']) return null;
    return {
      severity: 'medium',
      title: 'Other sites can embed this page invisibly',
      why: 'An attacker could load this page inside theirs and trick people into clicking buttons they can\'t see (clickjacking).',
      fix: "Send Content-Security-Policy: frame-ancestors 'self' (or X-Frame-Options: SAMEORIGIN).",
      effort: 'quick',
      whereText: 'Response headers',
      ref: 'Header: frame-ancestors / X-Frame-Options'
    };
  });

  rule('nosniff', 'security', ({ headers }) => {
    if (!headers || /nosniff/i.test(headers['x-content-type-options'] || '')) return null;
    return {
      severity: 'low',
      title: 'Browser may guess file types',
      why: 'Without nosniff, a browser might treat an uploaded file as a script.',
      fix: 'Send X-Content-Type-Options: nosniff',
      effort: 'quick',
      whereText: 'Response headers',
      ref: 'Header: X-Content-Type-Options'
    };
  });

  rule('referrer-policy', 'security', ({ headers }) => {
    if (!headers || headers['referrer-policy']) return null;
    return {
      severity: 'low',
      title: 'No referrer policy',
      why: 'Without one, the page relies on browser defaults for how much of its address is shared with other sites.',
      fix: 'Send Referrer-Policy: strict-origin-when-cross-origin',
      effort: 'quick',
      whereText: 'Response headers',
      ref: 'Header: Referrer-Policy'
    };
  });

  rule('permissions-policy', 'security', ({ headers }) => {
    if (!headers || headers['permissions-policy']) return null;
    return {
      severity: 'low',
      title: 'No Permissions-Policy',
      why: 'The page doesn\'t restrict camera, microphone or location access for itself and embedded content.',
      fix: 'Send Permissions-Policy: camera=(), microphone=(), geolocation=() (allow only what you use).',
      effort: 'quick',
      whereText: 'Response headers',
      ref: 'Header: Permissions-Policy'
    };
  });

  rule('version-disclosure', 'security', ({ headers }) => {
    if (!headers) return null;
    const leaks = ['server', 'x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version']
      .filter((k) => headers[k] && /\d/.test(headers[k]))
      .map((k) => `${k}: ${headers[k]}`);
    if (!leaks.length) return null;
    return {
      severity: 'low',
      title: 'Server announces its software version',
      why: 'Version numbers help attackers look up known weaknesses for that exact software.',
      fix: 'Hide version numbers in Server / X-Powered-By headers.',
      effort: 'quick',
      whereText: 'Response headers',
      tech: leaks.join(' · ')
    };
  });

  rule('vulnerable-libs', 'security', ({ tech }) => {
    const hits = [];
    for (const t of tech) {
      if (!t.version) continue;
      for (const v of VULNERABLE_LIBS) {
        if (v.lib !== t.name) continue;
        if (v.from && cmpVersion(t.version, v.from) < 0) continue;
        if (cmpVersion(t.version, v.below) < 0) hits.push({ ...v, version: t.version });
      }
    }
    return hits.map((hit) => ({
      key: hit.lib,
      severity: hit.severity,
      title: `Outdated ${hit.lib} ${hit.version} with known security problems`,
      why: `${hit.note}. Attackers scan for exactly these versions.`,
      fix: `Upgrade ${hit.lib} to ${hit.upgrade}.`,
      effort: 'moderate',
      whereText: `${hit.lib} ${hit.version}`,
      ref: 'PageLens bundled vulnerable-library list'
    }));
  });

  rule('sri', 'security', ({ scan }) => {
    const scripts = scan.code.scripts.external.filter((s) => s.thirdParty && !s.integrity);
    const styles = scan.code.styleSheets.external.filter((s) => s.thirdParty && !s.integrity && !/fonts\.googleapis\.com/.test(s.host));
    const list = [...scripts, ...styles];
    if (!list.length) return null;
    return {
      severity: 'medium',
      title: `${plural(list.length, 'outside file')} loaded without an integrity check`,
      why: 'If the other company\'s server is hacked, a changed file would run on this page unnoticed.',
      fix: 'Add integrity="sha384-…" and crossorigin="anonymous" to fixed-version CDN files, or host them yourself. (Tags like analytics loaders change often and can\'t use this.)',
      effort: 'moderate',
      whereText: listNames(uniq(list.map((s) => s.host)), 3),
      count: list.length,
      ref: 'Subresource Integrity'
    };
  });

  rule('blank-noopener', 'security', ({ scan }) => {
    const l = scan.interaction.links.blankNoOpener;
    if (!l.length) return null;
    return {
      severity: 'low',
      title: `${plural(l.length, 'link')} ${l.length === 1 ? 'opens' : 'open'} new tabs without rel="noopener"`,
      why: 'Older browsers let the opened page redirect this one, a trick used for phishing. Modern browsers protect by default.',
      fix: 'Add rel="noopener" (or "noopener noreferrer") to links with target="_blank".',
      effort: 'quick',
      where: sels(l.map((x) => x.selector)),
      count: l.length
    };
  });

  rule('inline-handlers', 'security', ({ scan }) => {
    const h = scan.code.inlineHandlers;
    if (!h.count) return null;
    return {
      severity: 'low',
      title: `${plural(h.count, 'inline event handler')} (onclick, onload…)`,
      why: 'Inline handlers force a weaker Content-Security-Policy and mix code into markup.',
      fix: 'Attach events with addEventListener in a script file.',
      effort: 'moderate',
      where: sels(h.selectors),
      count: h.count
    };
  });

  rule('source-maps', 'security', ({ scan }) => {
    const n = scan.code.scripts.inlineSourceMaps;
    if (!n) return null;
    return {
      severity: 'low',
      title: 'Source map references in page scripts',
      why: 'Source maps can expose original source code, comments and internal file paths.',
      fix: 'Strip sourceMappingURL comments from production builds, or keep maps private.',
      effort: 'quick',
      whereText: 'Inline scripts',
      count: n
    };
  });

  rule('comments', 'security', ({ scan }) => {
    const k = scan.code.comments.keywords;
    const sensitive = ['password', 'secret', 'token', 'apiKey'].filter((x) => k[x]);
    const internal = ['todo', 'internal', 'admin', 'email'].filter((x) => k[x]);
    if (!sensitive.length && !internal.length) return null;
    return {
      severity: sensitive.length ? 'medium' : 'low',
      title: sensitive.length ? 'HTML comments mention secrets' : 'HTML comments reveal internal notes',
      why: 'Comments ship to every visitor. Words like ' + [...sensitive, ...internal].join(', ') + ' suggest notes meant for developers only.',
      fix: 'Remove comments from production HTML (most build tools can strip them automatically). Rotate any real credentials that were exposed.',
      effort: 'quick',
      whereText: `${plural(scan.code.comments.count, 'comment')} in the HTML`,
      tech: 'PageLens records keyword matches only, never the comment text.'
    };
  });

  rule('storage-secrets', 'security', ({ scan }) => {
    const names = [...scan.storage.localStorage.names, ...scan.storage.sessionStorage.names].filter((n) => SECRET_NAME.test(n));
    if (!names.length) return null;
    return {
      severity: 'medium',
      title: `Login or secret data kept in browser storage (${plural(names.length, 'key')})`,
      why: 'Anything in localStorage can be read by any script on the page, so one injected script could steal it.',
      fix: 'Keep session tokens in HttpOnly, Secure cookies instead of localStorage or sessionStorage.',
      effort: 'involved',
      whereText: `Keys: ${listNames(names, 4)}`,
      tech: 'Listed by name only. Values were never read.'
    };
  });

  rule('readable-session-cookies', 'security', ({ scan, cookies }) => {
    if (cookies) return null; // the precise cookie-flag rule below takes over
    const names = scan.storage.cookies.names.filter((n) => SESSION_COOKIE.test(n));
    if (!names.length) return null;
    return {
      severity: 'medium',
      title: 'Session cookies are readable by page scripts',
      why: 'These look like login cookies, and scripts can read them, so an injected script could hijack the session.',
      fix: 'Set the HttpOnly flag (plus Secure and SameSite=Lax) on session cookies.',
      effort: 'quick',
      whereText: `Cookies: ${listNames(names, 4)}`,
      tech: 'Visible via document.cookie, which means HttpOnly is not set. Names only.'
    };
  });

  rule('cookie-flags', 'security', ({ cookies, scan }) => {
    if (!cookies || !cookies.length) return null;
    const https = scan.page.protocol === 'https';
    const out = [];
    const notSecure = https ? cookies.filter((c) => !c.secure) : [];
    if (notSecure.length) {
      out.push({
        key: 'secure', severity: 'medium',
        title: `${plural(notSecure.length, 'cookie')} without the Secure flag`,
        why: 'These cookies can be sent over an insecure connection where others could read them.',
        fix: 'Add the Secure flag to every cookie on an HTTPS site.',
        effort: 'quick', whereText: `Cookies: ${listNames(notSecure.map((c) => c.name), 4)}`
      });
    }
    const session = cookies.filter((c) => !c.httpOnly && SESSION_COOKIE.test(c.name));
    if (session.length) {
      out.push({
        key: 'httponly', severity: 'medium',
        title: 'Session cookies are readable by page scripts',
        why: 'Login cookies without HttpOnly can be stolen by an injected script.',
        fix: 'Set HttpOnly on session and authentication cookies.',
        effort: 'quick', whereText: `Cookies: ${listNames(session.map((c) => c.name), 4)}`
      });
    }
    const noSameSite = cookies.filter((c) => c.sameSite === 'unspecified' || (c.sameSite === 'no_restriction' && SESSION_COOKIE.test(c.name)));
    if (noSameSite.length) {
      out.push({
        key: 'samesite', severity: 'low',
        title: `${plural(noSameSite.length, 'cookie')} without a clear SameSite setting`,
        why: 'SameSite limits when cookies travel with requests from other sites, which helps stop cross-site request forgery.',
        fix: 'Set SameSite=Lax (or Strict) explicitly; use None only for cookies that truly need cross-site use.',
        effort: 'quick', whereText: `Cookies: ${listNames(noSameSite.map((c) => c.name), 4)}`
      });
    }
    const now = Date.now() / 1000;
    const tracking = cookies.filter((c) => TRACKING_COOKIE.test(c.name) && c.expirationDate && c.expirationDate - now > 180 * 86400);
    if (tracking.length) {
      out.push({
        key: 'tracking', topic: 'privacy', severity: 'low',
        title: `${plural(tracking.length, 'tracking cookie')} kept for over 6 months`,
        why: 'Long-lived analytics and advertising cookies follow visitors across many visits.',
        fix: 'Shorten tracking cookie lifetimes and only set them after consent.',
        effort: 'moderate', whereText: `Cookies: ${listNames(tracking.map((c) => c.name), 4)}`
      });
    }
    return out;
  });

  rule('trackers', 'security', ({ scan, tech }) => {
    const T = root.PageLensTrackers;
    const third = scan.performance.hosts.filter((h) => h.thirdParty && h.host);
    const cls = T ? T.classify(third) : { companies: [] };
    const trackingCos = cls.companies.filter((c) => c.tracking && c.categories.some((k) => ['advertising', 'analytics', 'social', 'tags'].includes(k)));
    const names = new Set(trackingCos.map((c) => c.company));
    for (const t of tech) if (TRACKERS.has(t.name) && !trackingCos.length) names.add(t.name);
    const out = [];
    if (names.size) {
      const ads = trackingCos.filter((c) => c.categories.includes('advertising')).map((c) => c.company);
      out.push({
        topic: 'privacy',
        severity: ads.length >= 3 ? 'medium' : 'low',
        title: `Visitor tracking by ${listNames([...names], 3)}`,
        why: `${plural(names.size, 'company', 'companies')} can see your visit${ads.length ? `, including ${plural(ads.length, 'advertising network')} that build interest profiles across sites` : ''}.`,
        fix: 'Load analytics and advertising only after consent where the law requires it, list them in the privacy policy, and remove tools you no longer use.',
        effort: 'moderate',
        whereText: trackingCos.flatMap((c) => c.hosts).slice(0, 4).join(', ') || 'Third-party scripts',
        count: names.size,
        data: { companies: trackingCos.map((c) => ({ company: c.company, categories: c.categories, hosts: c.hosts })) }
      });
    }
    const rec = cls.companies.filter((c) => c.categories.includes('recording'));
    if (rec.length) {
      out.push({
        key: 'recording', topic: 'privacy',
        severity: 'medium',
        title: `Session recording by ${listNames(rec.map((c) => c.company), 2)}`,
        why: 'Session-recording tools can replay mouse movements, clicks, scrolling and sometimes typing. Fields with personal data must be masked.',
        fix: 'Mask all form fields and personal data in the recording settings, tell visitors in the privacy policy, and ask for consent where required.',
        effort: 'moderate',
        whereText: rec.flatMap((c) => c.hosts).slice(0, 3).join(', ')
      });
    }
    return out;
  });

  rule('third-party-hosts', 'security', ({ scan }) => {
    const n = scan.performance.hosts.filter((h) => h.thirdParty).length;
    if (n <= 15) return null;
    return {
      topic: 'privacy',
      severity: 'low',
      title: `Content from ${n} other sites`,
      why: 'Every outside host learns that you visited this page.',
      fix: 'Self-host fonts and libraries where you can, and remove unused third-party services.',
      effort: 'involved',
      whereText: 'Network requests',
      count: n
    };
  });

  rule('phishing-host', 'security', ({ scan, local }) => {
    if (local) return null;
    const host = scan.page.host;
    const site = scan.page.site;
    const out = [];
    if (scan.page.isIpHost) {
      out.push({
        key: 'ip', severity: 'medium',
        title: 'Site uses a raw IP address instead of a name',
        why: 'Real businesses almost always use a domain name. Phishing pages often use bare IP addresses.',
        fix: 'Visitors: be careful entering personal details here. Owners: serve the site from a domain name.',
        effort: 'moderate', whereText: host
      });
    }
    if (scan.page.isPunycode) {
      out.push({
        key: 'punycode', severity: 'medium',
        title: 'Address uses special lookalike characters',
        why: 'This domain is written with international characters (punycode). That is legitimate for many languages, but also used to imitate famous sites.',
        fix: 'Visitors: check the address carefully before logging in.',
        effort: 'quick', whereText: host
      });
    }
    // Brand lookalikes (e.g. paypa1-secure.com). Whole-token matches only, so
    // "applebees.com" is not mistaken for Apple. Near-misses ("paypai") only
    // count when the page also asks for a password.
    const asksPassword = scan.interaction.fields.some((f) => f.type === 'password');
    const label = deLeet(site.split('.')[0].toLowerCase());
    const tokens = deLeet(host.toLowerCase()).split(/[.-]/).filter(Boolean);
    for (const [brand, official] of Object.entries(BRANDS)) {
      if (official.includes(site) || official.some((o) => host === o || host.endsWith('.' + o))) continue;
      const token = tokens.includes(brand);
      const close = asksPassword && brand.length >= 6 && label !== brand && editDistance(label, brand) === 1;
      if (token || close) {
        out.push({
          key: 'brand', severity: asksPassword ? 'high' : 'medium',
          title: `Address looks like ${brand[0].toUpperCase() + brand.slice(1)}, but isn't its official site`,
          why: `"${host}" resembles ${brand}, whose real sites are ${official.slice(0, 2).join(' and ')}. Lookalike addresses are a common phishing trick.`,
          fix: `Visitors: don't enter passwords or payment details unless you're sure. Go to ${official[0]} directly instead.`,
          effort: 'quick', whereText: host
        });
        break;
      }
    }
    return out;
  });

  rule('login-mismatch', 'security', ({ scan }) => {
    const bad = scan.interaction.forms.filter((f) => f.hasPassword && f.actionThirdParty && f.actionHost);
    if (!bad.length) return null;
    return {
      severity: 'high',
      title: 'Login form sends your password to a different website',
      why: `The password field on ${scan.page.host} submits to ${bad[0].actionHost}. Legitimate single sign-on does this, but so do phishing pages.`,
      fix: 'Visitors: only continue if you recognize that site. Owners: submit logins to your own domain.',
      effort: 'moderate',
      where: sels(bad.map((f) => f.selector)),
      whereText: `Form target: ${bad[0].actionHost}`
    };
  });

  rule('csp-gaps', 'security', ({ headers }) => {
    const H = root.PageLensHeaders;
    if (!headers || !headers['content-security-policy'] || !H) return null;
    const a = H.cspAnalysis(headers['content-security-policy']);
    if (!a.valid || a.unsafeInline || a.unsafeEval) return null; // the main CSP rule covers these
    const gaps = [];
    if (!a.directives['base-uri']) gaps.push('base-uri');
    if (!a.directives['object-src'] && !(a.directives['default-src'] && a.directives['default-src'].includes("'none'"))) gaps.push('object-src');
    if (!gaps.length) return null;
    return {
      severity: 'low',
      title: `Content-Security-Policy is missing ${gaps.join(' and ')}`,
      why: `Without ${gaps.map((g) => (g === 'base-uri' ? "base-uri (an injected <base> tag can redirect every relative script URL)" : "object-src 'none' (plugins can bypass script rules)")).join(' and ')}, the policy is easier to get around.`,
      fix: `Add ${gaps.map((g) => (g === 'base-uri' ? "base-uri 'self'" : "object-src 'none'")).join('; ')} to the policy.`,
      effort: 'quick',
      whereText: 'Content-Security-Policy',
      ref: 'Google strict CSP guidance'
    };
  });

  rule('deprecated-headers', 'security', ({ headers }) => {
    if (!headers) return null;
    const found = ['expect-ct', 'public-key-pins', 'public-key-pins-report-only'].filter((k) => headers[k]);
    if (!found.length) return null;
    return {
      severity: 'low',
      title: `Deprecated security header${found.length === 1 ? '' : 's'}: ${found.join(', ')}`,
      why: 'Browsers no longer use these. Public-Key-Pins in particular could lock visitors out if keys change.',
      fix: `Remove ${found.join(' and ')} from the server configuration.`,
      effort: 'quick',
      whereText: 'Response headers'
    };
  });

  rule('cors-wildcard', 'security', ({ headers }) => {
    if (!headers || headers['access-control-allow-origin'] !== '*') return null;
    return {
      severity: 'low',
      title: 'Any website may read this page (CORS *)',
      why: 'Access-Control-Allow-Origin: * lets scripts on other sites read the response. Harmless for public pages, risky if this page ever shows private data.',
      fix: 'Remove the header from HTML pages, or list the exact origins that need access.',
      effort: 'quick',
      whereText: 'Access-Control-Allow-Origin',
      ref: 'Header: Access-Control-Allow-Origin'
    };
  });

  rule('security-txt', 'security', ({ securityTxt, local }) => {
    if (!securityTxt || local) return null;
    if (!securityTxt.found) {
      return {
        severity: 'low',
        title: 'No security.txt contact file',
        why: 'Security researchers who find a problem have no official way to report it.',
        fix: 'Publish /.well-known/security.txt with Contact: and Expires: lines (RFC 9116). securitytxt.org generates one.',
        effort: 'quick',
        whereText: '/.well-known/security.txt',
        ref: 'RFC 9116'
      };
    }
    if (securityTxt.problems && securityTxt.problems.length) {
      return {
        severity: 'low',
        title: securityTxt.expired ? 'security.txt has expired' : 'security.txt is incomplete',
        why: securityTxt.problems.join('. ') + '.',
        fix: 'Update the file with a Contact: line and an Expires: date less than a year ahead.',
        effort: 'quick',
        whereText: '/.well-known/security.txt',
        ref: 'RFC 9116'
      };
    }
    return null;
  });

  // ============================================================ SEO BASICS

  rule('title', 'seo', ({ scan }) => {
    const t = scan.page.title || '';
    if (!t) {
      return {
        severity: 'high', title: 'Page has no title',
        why: 'The title is the headline shown in search results and on browser tabs.',
        fix: 'Add a descriptive <title> of about 30–60 characters.', effort: 'quick', whereText: '<title>'
      };
    }
    if (t.length < 10 || t.length > 65) {
      return {
        severity: 'low', title: `Page title is too ${t.length < 10 ? 'short' : 'long'} (${t.length} characters)`,
        why: t.length < 10 ? 'A very short title says little in search results.' : 'Search engines cut long titles off.',
        fix: 'Aim for 30–60 characters that describe the page.', effort: 'quick', whereText: '<title>'
      };
    }
    return null;
  });

  rule('description', 'seo', ({ scan }) => {
    const d = scan.meta.description || '';
    if (!d) {
      return {
        severity: 'medium', title: 'No meta description',
        why: 'Search engines show this summary under the title. Without it they pick random text from the page.',
        fix: 'Add <meta name="description" content="…"> with a 120–160 character summary.', effort: 'quick', whereText: '<head>'
      };
    }
    if (d.length > 170) {
      return {
        severity: 'low', title: `Meta description is long (${d.length} characters)`,
        why: 'Search results cut it off around 160 characters.', fix: 'Keep it to 120–160 characters.', effort: 'quick', whereText: '<meta name="description">'
      };
    }
    return null;
  });

  rule('viewport-meta', 'seo', ({ scan }) => {
    if (scan.meta.viewport) return null;
    return {
      severity: 'high', title: 'Not set up for phones (no viewport tag)',
      why: 'Without a viewport tag, phones show a shrunken desktop page. Search engines rank mobile-friendly pages higher.',
      fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.', effort: 'quick', whereText: '<head>'
    };
  });

  rule('noindex', 'seo', ({ scan, headers }) => {
    const robots = `${scan.meta.robots || ''} ${(headers && headers['x-robots-tag']) || ''}`.toLowerCase();
    if (!/noindex/.test(robots)) return null;
    return {
      severity: 'medium', title: 'Page asks search engines not to list it',
      why: 'A noindex rule hides this page from Google and others. Fine for private pages, a problem if you want visitors.',
      fix: 'Remove noindex from the robots meta tag or X-Robots-Tag header if the page should be found.', effort: 'quick',
      whereText: 'robots', tech: robots.trim()
    };
  });

  rule('canonical', 'seo', ({ scan }) => {
    if (scan.meta.canonical) return null;
    return {
      severity: 'low', title: 'No canonical address',
      why: 'If the page is reachable at several addresses, search engines may split its ranking between them.',
      fix: 'Add <link rel="canonical" href="https://…"> pointing at the preferred URL.', effort: 'quick', whereText: '<head>'
    };
  });

  rule('social-preview', 'seo', ({ scan }) => {
    const og = scan.meta.og;
    if (og.title && og.image) return null;
    return {
      severity: 'low', title: 'No social sharing preview',
      why: 'When shared on WhatsApp, LinkedIn or X, the link shows without a proper title or image.',
      fix: 'Add og:title, og:description and og:image meta tags.', effort: 'quick', whereText: '<head>'
    };
  });

  rule('favicon', 'seo', ({ scan }) => {
    if (scan.meta.favicon) return null;
    return {
      severity: 'low', title: 'No site icon (favicon) declared',
      why: 'The icon helps people find the tab and recognize the site in bookmarks and search results.',
      fix: 'Add <link rel="icon" href="/favicon.svg"> (and a PNG fallback).', effort: 'quick', whereText: '<head>'
    };
  });

  rule('structured-data', 'seo', ({ scan }) => {
    if (scan.meta.structuredData.length) return null;
    return {
      severity: 'low', title: 'No structured data',
      why: 'Structured data (JSON-LD) helps search engines show rich results like ratings, prices or FAQs.',
      fix: 'Add a JSON-LD block describing the page (Organization, Product, Article…).', effort: 'moderate', whereText: '<head>'
    };
  });

  // ============================================================ DEEPER CHECKS (v0.6)
  // Older scans (exported JSON from before v0.6) have no scan.a11y / scan.hints; rules skip them.

  rule('focus-indicator', 'accessibility', ({ scan }) => {
    const A = scan.a11y;
    if (!A || !A.noFocusIndicator.length) return null;
    const n = A.noFocusIndicator.length;
    return {
      severity: n >= 5 ? 'high' : 'medium',
      title: `${plural(n, 'control')} with no visible keyboard focus`,
      why: 'The site\'s CSS removes the focus outline on these links or buttons and puts nothing in its place, so keyboard users cannot see where they are on the page.',
      fix: 'Never remove outlines without a replacement. Use :focus-visible { outline: 2px solid; outline-offset: 2px } (or a clear box-shadow) on interactive elements.',
      effort: 'quick',
      where: sels(A.noFocusIndicator.map((x) => x.selector)),
      count: n,
      ref: 'WCAG 2.2 · 2.4.7 Focus Visible, 2.4.11 Focus Not Obscured',
      tech: `Found by matching same-origin CSS rules that set outline: none/0 against each control, with no :focus / :focus-visible rule restoring an indicator.${A.focusCssUnreadable ? ` ${plural(A.focusCssUnreadable, 'cross-origin stylesheet')} could not be read, so there may be more.` : ''}`
    };
  });

  rule('positive-tabindex', 'accessibility', ({ scan }) => {
    const A = scan.a11y;
    if (!A || !A.positiveTabindex.length) return null;
    return {
      severity: 'medium',
      title: `${plural(A.positiveTabindex.length, 'element')} ${A.positiveTabindex.length === 1 ? 'forces its' : 'force their'} own Tab order`,
      why: 'tabindex values above 0 make the Tab key jump around the page in an order that does not match what people see.',
      fix: 'Use tabindex="0" (or none) and put elements in a sensible order in the HTML instead.',
      effort: 'quick',
      where: sels(A.positiveTabindex.map((x) => x.selector)),
      count: A.positiveTabindex.length,
      ref: 'WCAG 2.2 · 2.4.3 Focus Order'
    };
  });

  rule('aria-hidden-focusable', 'accessibility', ({ scan }) => {
    const A = scan.a11y;
    if (!A || !A.hiddenFocusable.length) return null;
    return {
      severity: 'high',
      title: `${plural(A.hiddenFocusable.length, 'control')} hidden from screen readers but still focusable`,
      why: 'Keyboard users can Tab to these, but screen readers announce nothing, so blind users land on silent, invisible controls.',
      fix: 'Remove aria-hidden="true" from regions that contain controls, or make those controls unfocusable (tabindex="-1" or the inert attribute).',
      effort: 'quick',
      where: sels(A.hiddenFocusable.map((x) => x.selector)),
      count: A.hiddenFocusable.length,
      ref: 'WCAG 2.2 · 4.1.2 Name, Role, Value'
    };
  });

  rule('button-name', 'accessibility', ({ scan }) => {
    const A = scan.a11y;
    if (!A || !A.unnamedButtons.length) return null;
    return {
      severity: 'high',
      title: `${plural(A.unnamedButtons.length, 'button')} with no name`,
      why: 'Icon-only buttons without a label are announced as just "button", so screen-reader users cannot tell what they do.',
      fix: 'Add visible text, aria-label="Close menu" (for example), or a <title> inside the SVG icon.',
      effort: 'quick',
      where: sels(A.unnamedButtons.map((x) => x.selector)),
      count: A.unnamedButtons.length,
      ref: 'WCAG 2.2 · 4.1.2 Name, Role, Value'
    };
  });

  rule('click-only', 'accessibility', ({ scan }) => {
    const A = scan.a11y;
    if (!A || A.clickOnly.length < 2) return null;
    return {
      severity: A.clickOnly.length >= 6 ? 'medium' : 'low',
      title: `${plural(A.clickOnly.length, 'clickable area')} that keyboards may not reach`,
      why: 'These look clickable (pointer cursor) but are plain elements, not buttons or links, so keyboard and screen-reader users often cannot use them.',
      fix: 'Use <button> for actions and <a href> for navigation. If you must use a <div>, add role="button", tabindex="0" and Enter/Space key handling.',
      effort: 'moderate',
      where: sels(A.clickOnly.map((x) => x.selector)),
      count: A.clickOnly.length,
      ref: 'WCAG 2.2 · 2.1.1 Keyboard',
      tech: 'Heuristic: computed cursor:pointer on a non-interactive element with no interactive ancestor or descendant.'
    };
  });

  rule('aria-refs', 'accessibility', ({ scan }) => {
    const A = scan.a11y;
    if (!A) return null;
    const out = [];
    if (A.brokenAriaRefs.length) {
      out.push({
        key: 'broken', severity: 'medium',
        title: `${plural(A.brokenAriaRefs.length, 'label link')} ${A.brokenAriaRefs.length === 1 ? 'points' : 'point'} to an element that does not exist`,
        why: 'aria-labelledby, aria-describedby or <label for> refer to an id that is not on the page, so the label or description is silently lost.',
        fix: 'Fix the id, or remove the reference.',
        effort: 'quick', where: sels(A.brokenAriaRefs.map((x) => x.selector)), count: A.brokenAriaRefs.length,
        ref: 'WCAG 2.2 · 1.3.1, 4.1.2', tech: `Missing ids: ${listNames(uniq(A.brokenAriaRefs.map((x) => x.id)), 4)}.`
      });
    }
    if (A.duplicateIds.referenced.length) {
      out.push({
        key: 'duplicate', severity: 'medium',
        title: `${plural(A.duplicateIds.referenced.length, 'id')} used more than once and referenced by labels`,
        why: 'When two elements share an id, labels and descriptions may attach to the wrong one.',
        fix: 'Make every id unique.', effort: 'quick', whereText: `ids: ${listNames(A.duplicateIds.referenced, 4)}`,
        ref: 'WCAG 2.2 · 4.1.2'
      });
    }
    if (A.invalidRoles.length) {
      out.push({
        key: 'roles', severity: 'medium',
        title: `${plural(A.invalidRoles.length, 'invalid ARIA role')}`,
        why: 'Unknown role values are ignored, so these elements may be announced wrongly.',
        fix: 'Use a valid WAI-ARIA role, or remove the attribute and use the right HTML element.',
        effort: 'quick', where: sels(A.invalidRoles.map((x) => x.selector)), count: A.invalidRoles.length,
        ref: 'WAI-ARIA 1.2', tech: `Roles: ${listNames(uniq(A.invalidRoles.map((x) => x.role)), 5)}.`
      });
    }
    return out;
  });

  rule('media-a11y', 'accessibility', ({ scan }) => {
    const A = scan.a11y;
    if (!A) return null;
    const out = [];
    const loud = A.autoplay.filter((m) => !m.muted);
    if (loud.length) {
      out.push({
        key: 'autoplay', severity: 'medium',
        title: `${plural(loud.length, 'video or sound', 'videos or sounds')} play automatically with sound`,
        why: 'Unexpected sound interrupts screen readers and startles people. Without controls, it can be hard to stop.',
        fix: 'Don\'t autoplay with sound: add muted, or start playback only when the user asks. Always show controls.',
        effort: 'quick', where: sels(loud.map((x) => x.selector)), ref: 'WCAG 2.2 · 1.4.2 Audio Control'
      });
    }
    if (A.videosNoCaptions.length) {
      out.push({
        key: 'captions', severity: 'medium',
        title: `${plural(A.videosNoCaptions.length, 'video')} without captions`,
        why: 'Deaf and hard-of-hearing visitors, and anyone watching without sound, miss what is said.',
        fix: 'Add <track kind="captions" src="…vtt" srclang="en"> to each video (embedded players like YouTube have their own caption settings).',
        effort: 'moderate', where: sels(A.videosNoCaptions.map((x) => x.selector)), ref: 'WCAG 2.2 · 1.2.2 Captions (Prerecorded)'
      });
    }
    return out;
  });

  rule('skip-link', 'accessibility', ({ scan }) => {
    const A = scan.a11y;
    if (!A || A.skipLink) return null;
    const navLinks = scan.structure.landmarks.filter((l) => l.role === 'navigation').reduce((a, l) => a + (l.links || 0), 0);
    if (navLinks < 15) return null;
    return {
      severity: 'low',
      title: 'No "Skip to content" link',
      why: `Keyboard users must Tab through ${navLinks} menu links before reaching the content on every page.`,
      fix: 'Add a link as the first item in <body>: <a href="#main" class="skip-link">Skip to content</a>, visible when focused.',
      effort: 'quick', whereText: 'Start of the page', ref: 'WCAG 2.2 · 2.4.1 Bypass Blocks'
    };
  });

  rule('link-text', 'accessibility', ({ scan }) => {
    const A = scan.a11y;
    if (!A || A.genericLinks.length < 2) return null;
    return {
      severity: 'low',
      title: `${plural(A.genericLinks.length, 'link')} called "${A.genericLinks[0].text}" or similar`,
      why: 'Screen-reader users often jump from link to link. "Read more" ten times tells them nothing about where each one goes.',
      fix: 'Make the link text describe the destination ("Read the pricing guide"), or add an aria-label that does.',
      effort: 'quick', where: sels(A.genericLinks.map((x) => x.selector)), count: A.genericLinks.length,
      ref: 'WCAG 2.2 · 2.4.4 Link Purpose (In Context)'
    };
  });

  rule('table-headers', 'accessibility', ({ scan }) => {
    const A = scan.a11y;
    if (!A || !A.tablesNoHeaders.length) return null;
    return {
      severity: 'medium',
      title: `${plural(A.tablesNoHeaders.length, 'data table')} without header cells`,
      why: 'Screen readers announce each cell with its column and row headers. Without <th>, the numbers lose their meaning.',
      fix: 'Mark header cells with <th scope="col"> or <th scope="row">. Layout tables should get role="presentation".',
      effort: 'quick', where: sels(A.tablesNoHeaders.map((x) => x.selector)), ref: 'WCAG 2.2 · 1.3.1 Info and Relationships'
    };
  });

  rule('meta-refresh', 'accessibility', ({ scan }) => {
    const A = scan.a11y;
    if (!A || !A.metaRefresh) return null;
    const m = A.metaRefresh;
    if (m.redirects && m.seconds === 0) {
      return {
        severity: 'low', topic: 'seo',
        title: 'Page redirects with a meta refresh',
        why: 'Instant meta-refresh redirects are slower than server redirects and are handled less reliably by search engines and the Back button.',
        fix: 'Use a 301 redirect on the server instead.', effort: 'quick', whereText: '<meta http-equiv="refresh">'
      };
    }
    return {
      severity: 'medium',
      title: `Page reloads or redirects itself after ${m.seconds == null ? 'a delay' : plural(m.seconds, 'second')}`,
      why: 'Timed refreshes take control away: people lose their place, and screen readers start reading from the top again.',
      fix: 'Remove the timed refresh, or let users stop or extend it.', effort: 'quick', whereText: '<meta http-equiv="refresh">',
      ref: 'WCAG 2.2 · 2.2.1 Timing Adjustable'
    };
  });

  rule('lang-valid', 'accessibility', ({ scan }) => {
    const A = scan.a11y;
    if (!A || A.langValid !== false) return null;
    return {
      severity: 'low',
      title: `Page language "${scan.page.lang}" is not a valid language code`,
      why: 'Screen readers cannot pick the right voice from an invalid code.',
      fix: 'Use a standard code such as "en", "en-IN", "hi" or "zh-CN".', effort: 'quick', where: ['html'], ref: 'WCAG 2.2 · 3.1.1'
    };
  });

  // ---- performance extras

  rule('font-display', 'performance', ({ scan }) => {
    const H = scan.hints;
    if (!H || !H.fontDisplay) return null;
    const blocking = uniq(H.fontDisplay.filter((f) => f.display === 'auto' || f.display === 'block').map((f) => f.family));
    if (!blocking.length) return null;
    return {
      severity: 'low',
      title: `${plural(blocking.length, 'web font')} can hide text while loading`,
      why: 'Without font-display, browsers may show invisible text for up to 3 seconds while the font downloads.',
      fix: 'Add font-display: swap to each @font-face (for Google Fonts, add &display=swap to the URL).',
      effort: 'quick', whereText: listNames(blocking, 3), ref: 'web.dev · font-display'
    };
  });

  rule('img-dimensions', 'performance', ({ scan }) => {
    const imgs = scan.media.images.filter((i) => i.visible && i.hasDims === false && i.width * i.height > 2500);
    if (imgs.length < 2) return null;
    return {
      severity: imgs.length >= 6 ? 'medium' : 'low',
      title: `${plural(imgs.length, 'image')} without width and height`,
      why: 'The browser cannot reserve space before these images load, so the text below jumps down (layout shift).',
      fix: 'Add width and height attributes matching the image ratio (CSS can still resize it), or set aspect-ratio in CSS.',
      effort: 'quick', where: sels(imgs.map((i) => i.selector)), count: imgs.length, ref: 'Core Web Vitals · CLS'
    };
  });

  rule('lcp-lazy', 'performance', ({ scan }) => {
    const l = scan.performance.lcp;
    if (!l || !l.element) return null;
    const img = scan.media.images.find((i) => i.selector === l.element);
    if (!img || img.loading !== 'lazy') return null;
    return {
      severity: 'medium',
      title: 'The main image is lazy-loaded',
      why: 'The largest image on the first screen waits until layout is finished before it starts downloading, which delays the main content.',
      fix: 'Remove loading="lazy" from the hero image and add fetchpriority="high".',
      effort: 'quick', where: [l.element], ref: 'Core Web Vitals · LCP'
    };
  });

  rule('modern-formats', 'performance', ({ scan }) => {
    const legacy = scan.performance.resources.filter((r) => r.kind === 'image' && r.bytes > 50 * 1024 && /\.(jpe?g|png|gif|bmp)$/i.test(r.url));
    if (legacy.length < 2) return null;
    const total = legacy.reduce((a, r) => a + r.bytes, 0);
    return {
      severity: 'low',
      title: `${plural(legacy.length, 'image')} in older formats (${fmtKB(total)})`,
      why: 'WebP and AVIF are usually 25–50% smaller than JPEG or PNG at the same quality.',
      fix: 'Serve WebP or AVIF, with <picture> fallbacks if you still support very old browsers. Most image CDNs can do this automatically.',
      effort: 'moderate', whereText: listNames(legacy.map((r) => fileName(r.url)), 3), count: legacy.length
    };
  });

  rule('http1', 'performance', ({ scan }) => {
    const n = scan.performance.navigation;
    if (!n || !n.protocol || !/^http\/1/.test(n.protocol) || scan.performance.requests < 30) return null;
    return {
      severity: 'low',
      title: 'Site uses the older HTTP/1.1 protocol',
      why: `With ${scan.performance.requests} requests, HTTP/1.1 has to queue files over a few connections. HTTP/2 and HTTP/3 load them in parallel over one.`,
      fix: 'Turn on HTTP/2 (and HTTP/3 if available) on the server or CDN. It usually needs only a setting change and HTTPS.',
      effort: 'quick', whereText: `Protocol: ${n.protocol}`
    };
  });

  rule('preconnect', 'performance', ({ scan }) => {
    const H = scan.hints;
    if (!H) return null;
    const hinted = new Set([...H.preconnect, ...H.dnsPrefetch]);
    const early = uniq(scan.performance.resources.filter((r) => r.thirdParty && r.start < 1500 && (r.renderBlocking || ['css', 'font', 'script'].includes(r.kind))).map((r) => r.host)).filter((h) => h && !hinted.has(h));
    if (early.length < 2) return null;
    return {
      severity: 'low',
      title: `${plural(early.length, 'outside server')} contacted early without a preconnect hint`,
      why: 'Each new server needs a DNS lookup and a secure connection before files can download. A preconnect hint starts that work sooner.',
      fix: `Add <link rel="preconnect" href="https://${early[0]}" crossorigin> in the <head> for the most important ones (2–4 at most).`,
      effort: 'quick', whereText: listNames(early, 4)
    };
  });

  // ---- SEO extras

  rule('canonical-multiple', 'seo', ({ scan }) => {
    const n = scan.meta.canonicalCount;
    if (!n || n < 2) return null;
    return {
      severity: 'medium',
      title: `${n} canonical tags on one page`,
      why: 'With several canonical URLs, search engines may ignore all of them.',
      fix: 'Keep exactly one <link rel="canonical">.', effort: 'quick', whereText: '<head>'
    };
  });

  rule('canonical-offsite', 'seo', ({ scan }) => {
    const c = scan.meta.canonical;
    if (!c) return null;
    let host = '';
    try { host = new URL(c).hostname; } catch { return null; }
    if (!host || host === scan.page.host || host.replace(/^www\./, '') === scan.page.host.replace(/^www\./, '')) return null;
    return {
      severity: 'low',
      title: 'Canonical address points to another site',
      why: `Search engines are told the real version of this page lives on ${host}, so this page may not appear in results.`,
      fix: 'If this is the original, point the canonical at this page\'s own address.', effort: 'quick', whereText: c
    };
  });

  rule('structured-data-invalid', 'seo', ({ scan }) => {
    const bad = scan.meta.structuredData.filter((t) => t === 'invalid').length;
    if (!bad) return null;
    return {
      severity: 'low',
      title: `${plural(bad, 'structured-data block')} cannot be read`,
      why: 'A JSON-LD block has a syntax error, so search engines ignore it.',
      fix: 'Fix the JSON (check it with Google\'s Rich Results Test or validator.schema.org).', effort: 'quick', whereText: '<script type="application/ld+json">'
    };
  });

  // ============================================================ engine

  const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
  const EFFORTS = new Set(['quick', 'moderate', 'involved']);

  function normalize(raw, r) {
    return {
      id: raw.key ? `${r.id}:${raw.key}` : r.id,
      rule: r.id,
      area: r.area,
      topic: raw.topic || (r.area === 'security' ? 'security' : r.area),
      severity: SEVERITIES.has(raw.severity) ? raw.severity : 'low',
      title: raw.title,
      why: raw.why,
      fix: raw.fix,
      effort: EFFORTS.has(raw.effort) ? raw.effort : 'moderate',
      where: raw.where || [],
      whereText: raw.whereText || null,
      count: raw.count || null,
      ref: raw.ref || null,
      tech: raw.tech || null,
      data: raw.data || null
    };
  }

  /**
   * @param {{scan:object, headers?:object|null, cookies?:Array|null, tech?:Array}} input
   * @returns {{issues:Array, errors:Array, checked:{headers:boolean,cookies:boolean}}}
   */
  function analyze(input) {
    const scan = input.scan;
    const ctx = {
      scan,
      headerInfo: input.headers || null,
      headers: (input.headers && input.headers.headers) || null,
      cookies: input.cookies || null,
      securityTxt: input.securityTxt || null,
      tech: input.tech || scan.tech || [],
      local: isLocalHost(scan.page.host)
    };
    const issues = [];
    const errors = [];
    for (const r of RULES) {
      try {
        const res = r.fn(ctx);
        for (const raw of [].concat(res || [])) if (raw && raw.title) issues.push(normalize(raw, r));
      } catch (err) {
        errors.push({ rule: r.id, message: String((err && err.message) || err) });
      }
    }
    return { issues, errors, checked: { headers: Boolean(ctx.headers), cookies: Boolean(ctx.cookies) }, rules: RULES.length };
  }

  root.PageLensAnalyze = Object.freeze({
    analyze,
    rules: () => RULES.map((r) => ({ id: r.id, area: r.area })),
    VULNERABLE_LIBS,
    _internals: { cmpVersion, parseCsp, editDistance, deLeet, isLocalHost }
  });
})(globalThis);
