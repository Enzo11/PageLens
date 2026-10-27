/* PageLens — lib/csp-builder.js
 *
 * Suggests a Content-Security-Policy from what this page actually loaded.
 * Two flavours:
 *   - allowlist: lists every origin seen, per resource type. Easy to adopt,
 *     but only as complete as this one page view.
 *   - strict: Google's recommended nonce + 'strict-dynamic' policy
 *     (web.dev/strict-csp). Strongest, but the server must add a fresh nonce
 *     to every <script> tag on each response.
 * Both should be deployed as Content-Security-Policy-Report-Only first.
 *
 * Pure: reads the scan object only.
 */
(function (root) {
  'use strict';

  const MAX_PER_DIRECTIVE = 40;

  function originOf(url, pageOrigin) {
    if (!url) return null;
    if (url.startsWith('data:')) return 'data:';
    if (url.startsWith('blob:')) return 'blob:';
    try {
      const u = new URL(url, pageOrigin);
      if (u.protocol !== 'https:' && u.protocol !== 'http:' && u.protocol !== 'wss:' && u.protocol !== 'ws:') return null;
      return u.origin === pageOrigin ? "'self'" : u.origin;
    } catch {
      return null;
    }
  }

  const DIRECTIVE_FOR_KIND = { script: 'script-src', css: 'style-src', font: 'font-src', image: 'img-src', media: 'media-src', xhr: 'connect-src', document: 'frame-src' };

  function build(scan, existingCspValue) {
    const pageOrigin = new URL(scan.page.url).origin;
    const https = scan.page.protocol === 'https';
    const sets = {
      'script-src': new Set(["'self'"]), 'style-src': new Set(["'self'"]), 'img-src': new Set(["'self'"]), 'font-src': new Set(["'self'"]),
      'connect-src': new Set(["'self'"]), 'media-src': new Set(), 'frame-src': new Set(), 'form-action': new Set(["'self'"]), 'worker-src': new Set()
    };
    const add = (dir, url) => {
      const o = originOf(url, pageOrigin);
      if (!o) return;
      if (o === 'data:' && !['img-src', 'font-src', 'media-src'].includes(dir)) return; // never allow data: scripts/styles
      if (o === 'blob:' && !['img-src', 'media-src', 'worker-src', 'connect-src'].includes(dir)) return;
      sets[dir].add(https && o.startsWith('http://') ? o.replace('http://', 'https://') : o);
    };

    for (const r of scan.performance.resources) {
      const dir = DIRECTIVE_FOR_KIND[r.kind];
      if (dir) add(dir, r.url);
      else if (r.kind === 'other') add('connect-src', r.url); // beacons, pings, unknown fetches
    }
    for (const s of scan.code.scripts.external) add('script-src', s.url);
    for (const s of scan.code.styleSheets.external) add('style-src', s.url);
    for (const i of scan.media.images) if (i.src) add('img-src', i.src);
    for (const f of scan.media.iframes) if (f.url && f.url !== 'about:blank') add('frame-src', f.url);
    for (const f of scan.interaction.forms) if (f.action) add('form-action', f.action);

    // Google Fonts CSS pulls font files from fonts.gstatic.com.
    if ([...sets['style-src']].some((o) => o === 'https://fonts.googleapis.com')) sets['font-src'].add('https://fonts.gstatic.com');

    const inlineScripts = scan.code.scripts.inline;
    const inlineHandlers = scan.code.inlineHandlers.count + (scan.code.javascriptHrefs || 0);
    const inlineStyles = scan.code.styleSheets.inline + scan.code.styleSheets.styleAttributes;
    if (inlineStyles) sets['style-src'].add("'unsafe-inline'");

    const truncated = [];
    const list = (dir) => {
      const vals = [...sets[dir]];
      const keywords = vals.filter((v) => v.startsWith("'") || v.endsWith(':'));
      const origins = vals.filter((v) => !(v.startsWith("'") || v.endsWith(':'))).sort();
      if (origins.length > MAX_PER_DIRECTIVE) truncated.push(dir);
      return [...keywords, ...origins.slice(0, MAX_PER_DIRECTIVE)];
    };

    const directives = [
      ['default-src', ["'self'"]],
      ['script-src', [...list('script-src'), ...(inlineScripts ? ["'nonce-{SERVER_GENERATED_NONCE}'"] : [])]],
      ['style-src', list('style-src')],
      ['img-src', list('img-src')],
      ['font-src', list('font-src')],
      ['connect-src', list('connect-src')],
      sets['media-src'].size ? ['media-src', list('media-src')] : null,
      sets['frame-src'].size ? ['frame-src', list('frame-src')] : null,
      sets['worker-src'].size ? ['worker-src', list('worker-src')] : null,
      ['object-src', ["'none'"]],
      ['base-uri', ["'self'"]],
      ['form-action', list('form-action')],
      ['frame-ancestors', ["'self'"]],
      https ? ['upgrade-insecure-requests', []] : null
    ].filter(Boolean);

    const allowlist = directives.map(([d, v]) => (v.length ? `${d} ${v.join(' ')}` : d)).join('; ');
    const strict = [
      "script-src 'nonce-{SERVER_GENERATED_NONCE}' 'strict-dynamic' https: 'unsafe-inline'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'self'",
      https ? 'upgrade-insecure-requests' : null
    ].filter(Boolean).join('; ');

    const notes = [];
    if (inlineScripts) notes.push(`This page has ${inlineScripts} inline <script> block${inlineScripts === 1 ? '' : 's'}. Add nonce="{SERVER_GENERATED_NONCE}" to each (a new random value per response), or move them into files.`);
    if (inlineHandlers) notes.push(`${inlineHandlers} inline event handler${inlineHandlers === 1 ? '' : 's'} (onclick=…, javascript: links) will be blocked. Move them to addEventListener in a script file.`);
    if (inlineStyles) notes.push("Inline styles are used, so style-src includes 'unsafe-inline'. That is lower risk than inline scripts; remove it later by moving styles to CSS files.");
    if (truncated.length) notes.push(`Very many origins in ${truncated.join(', ')}; only the first ${MAX_PER_DIRECTIVE} are listed.`);
    if (scan.performance.bufferLikelyFull) notes.push('The browser stopped recording after 250 files, so some origins may be missing.');
    notes.push('Built from this one page view. Scripts that load later (after clicks, on other pages, or for logged-in users) are not included — deploy as Report-Only first and watch for violations.');

    return {
      allowlist,
      strict,
      directives: directives.map(([name, values]) => ({ name, values })),
      notes,
      counts: { inlineScripts, inlineHandlers, inlineStyles },
      existing: existingCspValue || null
    };
  }

  root.PageLensCsp = Object.freeze({ build });
})(globalThis);
