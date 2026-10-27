/* PageLens — popup/popup.js
 *
 * Popup shell: runs the scan, renders the tabbed dashboard, handles the role
 * and mode switch, themes, click-to-highlight, Copy CSS and JSON export.
 *
 * Page content is always inserted as text (never innerHTML), so a hostile page
 * title or heading cannot inject markup into the extension.
 */
'use strict';

(() => {
  const C = globalThis.PageLensColor;
  const Tokens = globalThis.PageLensTokens;
  const Score = globalThis.PageLensScore;
  const Analyze = globalThis.PageLensAnalyze;
  const VERSION = chrome.runtime.getManifest().version;

  const $ = (sel, root = document) => root.querySelector(sel);
  const view = $('#view');

  const WEB_TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'design', label: 'Design' },
    { id: 'ux', label: 'UX' },
    { id: 'access', label: 'Access' },
    { id: 'speed', label: 'Speed' },
    { id: 'privacy', label: 'Privacy' },
    { id: 'security', label: 'Security' }
  ];

  // The role switch only reorders. Every role sees every block.
  const BLOCK_ORDER = {
    everyday: ['verdict', 'trust', 'fixes', 'profile', 'speed', 'design', 'layout', 'seo'],
    designer: ['verdict', 'fixes', 'design', 'layout', 'profile', 'speed', 'trust', 'seo'],
    developer: ['verdict', 'fixes', 'profile', 'speed', 'layout', 'trust', 'seo', 'design'],
    security: ['verdict', 'trust', 'fixes', 'profile', 'layout', 'speed', 'seo', 'design']
  };

  // Which three area bars sit under the score ring for each role.
  const ROLE_AREAS = {
    everyday: ['accessibility', 'performance', 'security'],
    designer: ['uiux', 'design', 'accessibility'],
    developer: ['performance', 'security', 'seo'],
    security: ['security', 'performance', 'accessibility']
  };

  // Areas a role sees first in the fix list. Order only; nothing is removed.
  const ROLE_FOCUS = {
    everyday: null,
    designer: ['design', 'uiux', 'accessibility'],
    developer: ['performance', 'security', 'seo'],
    security: ['security']
  };

  const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

  const state = {
    tabId: null,
    url: '',
    scan: null,
    tech: [],
    headers: null,
    headersError: null,
    role: 'everyday',
    theme: 'system',
    mode: 'website',
    view: 'overview',
    ghView: 'summary',
    status: 'loading', // loading | ready | blocked | error
    error: null,
    repo: null,
    scanMs: 0,
    issues: [],
    score: null,
    rulesRun: 0,
    analysisErrors: [],
    cookies: null, // [{name, secure, httpOnly, sameSite, ...}] — never values
    openIssues: new Set(),
    assessment: null, // header grade (lib/headers.js)
    csp: null, // suggested CSP (lib/csp-builder.js)
    trackers: null, // third parties by company (lib/trackers.js)
    securityTxt: null,
    securityTxtStatus: null,
    fixPlatform: null,
    fixAll: false,
    showAllHeaders: false,
    historyOn: true,
    history: null, // {key, list, prev, diff} for the current page
    recent: [],
    overlay: null, // 'history'
    showAllFixes: false
  };

  // ============================================================ tiny DOM kit

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') {
          for (const [p, val] of Object.entries(v)) {
            if (val == null) continue;
            if (p.startsWith('--')) el.style.setProperty(p, val);
            else el.style[p] = val;
          }
        } else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'text') el.textContent = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  const SVGNS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, String(v));
    for (const kid of kids.flat()) if (kid != null) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }

  function icon(path) {
    return s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
      s('path', { d: path, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }
  const ICONS = {
    info: 'M12 8h.01M11 12h1v5h1M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
    lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v10H6z',
    block: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8',
    github: 'M9 19c-4 1.5-4-2-6-2.5m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21',
    chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z',
    check: 'M5 12.5 10 17l9-10',
    repo: 'M6 3h11a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm-2 14a2 2 0 0 1 2-2h12M9 7h5',
    box: 'M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8',
    gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z'
  };

  function card(title, body, opts = {}) {
    return h('section', { class: 'card' + (opts.class ? ' ' + opts.class : ''), 'aria-label': title },
      h('header', { class: 'card-h' }, h('h2', null, title), opts.meta ? h('span', { class: 'card-meta' }, opts.meta) : null),
      body);
  }

  const kv = (rows) => h('dl', { class: 'kv' }, rows.filter(Boolean).map(([k, v, title]) => [h('dt', null, k), h('dd', { title: title || null }, v == null || v === '' ? '—' : v)]));
  const stat = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'stat-v', title: typeof value === 'string' ? value : null }, value), h('div', { class: 'stat-l' }, label), sub ? h('div', { class: 'stat-s' }, sub) : null);
  const chip = (label, value, opts = {}) => h(opts.onclick ? 'button' : 'span', { class: 'chip' + (opts.accent ? ' accent' : ''), type: opts.onclick ? 'button' : null, onclick: opts.onclick, title: opts.title }, h('b', null, label), value ? h('span', { class: 'v' }, value) : null);
  const notice = (text, ic = ICONS.info) => h('div', { class: 'notice' }, icon(ic), h('div', null, text));

  /** Plain wording for everyday users, precise wording for experts. */
  const say = (plain, expert) => (state.role === 'everyday' ? plain : expert);

  // ============================================================ formatting

  function fmtBytes(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }
  function fmtMs(ms) {
    if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
  }
  const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(x < 0.1 && x > 0 ? 1 : 0)}%`);
  const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const sizeOf = (r) => (r.bytes ? fmtBytes(r.bytes) : r.cached ? 'cached' : '—');
  const fileName = (url) => {
    const p = (url || '').replace(/\/$/, '').split('/');
    return p[p.length - 1] || url || '(document)';
  };

  // ============================================================ prefs + theme

  async function loadPrefs() {
    try {
      const { prefs } = await chrome.storage.local.get('prefs');
      if (prefs && BLOCK_ORDER[prefs.role]) state.role = prefs.role;
      if (prefs && ['system', 'light', 'dark'].includes(prefs.theme)) state.theme = prefs.theme;
      if (prefs && prefs.history === false) state.historyOn = false;
      state.onboarded = Boolean(prefs && prefs.onboarded);
    } catch { /* defaults */ }
  }
  function savePrefs() {
    chrome.storage.local.set({ prefs: { role: state.role, theme: state.theme, history: state.historyOn, onboarded: state.onboarded } }).catch(() => {});
  }
  function applyTheme() {
    if (state.theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', state.theme);
    const btn = $('#theme');
    btn.dataset.theme = state.theme;
    const label = `Theme: ${state.theme}`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  // ============================================================ toast

  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }
  async function copy(text, what = 'Copied') {
    try {
      await navigator.clipboard.writeText(text);
      toast(what);
    } catch {
      toast('Copy failed — clipboard blocked');
    }
  }

  // ============================================================ page helpers (run in the tab)

  /** Runs inside the page (isolated world): scroll to and outline an element. */
  function highlightInPage(selector) {
    let el = null;
    try { el = document.querySelector(selector); } catch { return false; }
    if (!el) return false;
    const ID = '__pagelens_highlight__';
    document.getElementById(ID)?.remove();
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const box = document.createElement('div');
    box.id = ID;
    box.setAttribute('aria-hidden', 'true');
    Object.assign(box.style, {
      position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', borderRadius: '4px',
      outline: '3px solid #6b4dff', outlineOffset: '2px', background: 'rgba(107,77,255,0.14)',
      boxShadow: '0 0 0 9999px rgba(10,10,30,0.18)', transition: 'opacity .3s', opacity: '1'
    });
    document.documentElement.appendChild(box);
    const start = performance.now();
    const follow = () => {
      if (!box.isConnected) return;
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { top: r.top + 'px', left: r.left + 'px', width: Math.max(r.width, 2) + 'px', height: Math.max(r.height, 2) + 'px' });
      const t = performance.now() - start;
      if (t > 2400) box.style.opacity = '0';
      if (t < 2800) requestAnimationFrame(follow);
      else box.remove();
    };
    follow();
    return true;
  }

  async function highlight(selector) {
    if (!selector || state.tabId == null) return;
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: state.tabId }, func: highlightInPage, args: [selector] });
      if (!res || !res.result) toast('That element is no longer on the page');
    } catch {
      toast('Could not reach the page');
    }
  }

  /** Runs in the page's MAIN world to read library globals (versions). Read-only. */
  function techProbe() {
    const out = [];
    const w = window;
    const get = (fn) => { try { return fn(); } catch { return undefined; } };
    const add = (name, category, version) => out.push({
      name, category, evidence: 'page globals',
      version: version != null && version !== '' ? String(version).slice(0, 24) : null
    });
    let v;
    if ((v = get(() => w.jQuery && w.jQuery.fn && w.jQuery.fn.jquery))) add('jQuery', 'JS library', v);
    if ((v = get(() => w.jQuery && w.jQuery.ui && w.jQuery.ui.version))) add('jQuery UI', 'JS library', v);
    if ((v = get(() => w.React && w.React.version))) add('React', 'Framework', v);
    if (get(() => w.__NEXT_DATA__)) add('Next.js', 'Framework', get(() => w.next && w.next.version));
    if (get(() => w.__NUXT__ || w.$nuxt)) add('Nuxt', 'Framework', null);
    if ((v = get(() => w.Vue && w.Vue.version))) add('Vue', 'Framework', v);
    else if (get(() => w.__VUE__)) add('Vue', 'Framework', null);
    if ((v = get(() => w.angular && w.angular.version && w.angular.version.full))) add('AngularJS', 'Framework', v);
    if ((v = get(() => w.Ember && w.Ember.VERSION))) add('Ember', 'Framework', v);
    if (get(() => w.__remixContext)) add('Remix', 'Framework', null);
    if ((v = get(() => w.Alpine && w.Alpine.version))) add('Alpine.js', 'JS library', v);
    if ((v = get(() => w.htmx && w.htmx.version))) add('htmx', 'JS library', v);
    if ((v = get(() => w._ && w._.VERSION))) add(get(() => typeof w._.runInContext === 'function') ? 'Lodash' : 'Underscore', 'JS library', v);
    if ((v = get(() => w.moment && w.moment.version))) add('Moment.js', 'JS library', v);
    if ((v = get(() => (w.bootstrap && w.bootstrap.Tooltip && w.bootstrap.Tooltip.VERSION) ||
      (w.jQuery && w.jQuery.fn.tooltip && w.jQuery.fn.tooltip.Constructor && w.jQuery.fn.tooltip.Constructor.VERSION)))) add('Bootstrap', 'UI framework', v);
    if ((v = get(() => w.d3 && w.d3.version))) add('D3', 'JS library', v);
    if ((v = get(() => w.THREE && w.THREE.REVISION))) add('three.js', 'JS library', 'r' + v);
    if ((v = get(() => w.gsap && w.gsap.version))) add('GSAP', 'JS library', v);
    if ((v = get(() => w.DOMPurify && w.DOMPurify.version))) add('DOMPurify', 'JS library', v);
    if ((v = get(() => w.Handlebars && w.Handlebars.VERSION))) add('Handlebars', 'JS library', v);
    if ((v = get(() => w.Chart && w.Chart.version))) add('Chart.js', 'JS library', v);
    if (get(() => w.Shopify)) add('Shopify', 'E-commerce', null);
    if (get(() => w.wixBiSession || w.wixPerformanceMeasurements)) add('Wix', 'Site builder', null);
    if (get(() => w.Squarespace || (w.Static && w.Static.SQUARESPACE_CONTEXT))) add('Squarespace', 'Site builder', null);
    if (get(() => w.google_tag_manager)) add('Google Tag Manager', 'Tag manager', null);
    if (get(() => typeof w.gtag === 'function' || typeof w.ga === 'function')) add('Google Analytics', 'Analytics', null);
    if (get(() => typeof w.fbq === 'function')) add('Meta Pixel', 'Advertising', null);
    if (get(() => typeof w.hj === 'function')) add('Hotjar', 'Analytics', null);
    if (get(() => w.wp && (w.wp.data || w.wp.i18n))) add('WordPress', 'CMS', null);
    if (get(() => w.Drupal)) add('Drupal', 'CMS', null);
    return out;
  }

  function mergeTech(...lists) {
    const map = new Map();
    for (const list of lists) {
      for (const t of list || []) {
        if (!t || !t.name) continue;
        const key = t.name.toLowerCase();
        const prev = map.get(key);
        if (!prev) map.set(key, { ...t });
        else if (!prev.version && t.version) prev.version = t.version;
      }
    }
    const order = ['Framework', 'CMS', 'Site builder', 'E-commerce', 'Platform', 'UI framework', 'CSS framework', 'JS library'];
    return [...map.values()].sort((a, b) => {
      const ia = order.indexOf(a.category);
      const ib = order.indexOf(b.category);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
    });
  }

  // ============================================================ scan

  function restrictedReason(url) {
    if (!url) return {
      title: 'Click the PageLens icon on the page',
      text: 'Chrome only lets PageLens read a tab after you click its icon there. Reload the page and try again.'
    };
    let u;
    try { u = new URL(url); } catch { return { title: 'Unreadable address', text: 'This tab has an address PageLens cannot read.' }; }
    if (!['http:', 'https:', 'file:'].includes(u.protocol)) return {
      title: "Chrome's own pages are off limits",
      text: 'Extensions cannot read settings, the new tab page or other extensions. Open any website and click PageLens again.'
    };
    if (u.hostname === 'chromewebstore.google.com' || (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'))) return {
      title: 'The Chrome Web Store is protected',
      text: 'Chrome blocks every extension from reading the Web Store. Try any other site.'
    };
    return null;
  }

  /** Repository pages on GitHub, GitLab or Codeberg → {platform, owner, repo, full}. */
  function parseRepo(url) {
    try {
      const u = new URL(url);
      if (!/^(www\.)?(github\.com|gitlab\.com|codeberg\.org)$/i.test(u.hostname)) return null;
      return globalThis.PageLensForges.parse(url);
    } catch {
      return null;
    }
  }


  function friendlyError(err) {
    const msg = String((err && err.message) || err || '');
    if (/cannot access|permission|host/i.test(msg)) return {
      title: 'PageLens needs your click on this tab',
      text: 'Chrome gives access only after you click the PageLens icon while this tab is open. Click it again here.'
    };
    if (/file/i.test(msg)) return {
      title: 'Local files need one setting',
      text: 'Open chrome://extensions, find PageLens, and turn on "Allow access to file URLs".'
    };
    if (/frame|removed|closed|No tab/i.test(msg)) return { title: 'The page changed', text: 'The tab navigated or closed while scanning. Scan again.' };
    return { title: 'Scan failed', text: msg ? `Chrome said: ${msg.slice(0, 160)}` : 'Something went wrong while reading the page.' };
  }

  async function fetchHeaders() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'pagelens:headers', url: state.url });
      if (res && res.ok) { state.headers = res; state.headersError = null; }
      else { state.headers = null; state.headersError = (res && res.error) || 'unknown'; }
    } catch (err) {
      state.headers = null;
      state.headersError = String(err && err.message || err);
    }
  }

  async function scan() {
    state.status = 'loading';
    state.error = null;
    $('#rescan').classList.add('spin');
    render();
    const t0 = performance.now();
    const target = { tabId: state.tabId };

    const [ex, probe] = await Promise.allSettled([
      chrome.scripting.executeScript({ target, files: ['lib/color.js', 'content/extract.js'] }),
      chrome.scripting.executeScript({ target, world: 'MAIN', func: techProbe }),
      fetchHeaders()
    ]);

    $('#rescan').classList.remove('spin');

    if (ex.status === 'rejected') {
      state.status = 'error';
      state.error = friendlyError(ex.reason);
      render();
      return;
    }
    const result = ex.value && ex.value[0] && ex.value[0].result;
    if (!result || result.error) {
      state.status = 'error';
      state.error = friendlyError(result ? result.message || result.error : 'The page returned nothing.');
      render();
      return;
    }

    state.scan = result;
    const probed = probe.status === 'fulfilled' && probe.value && probe.value[0] ? probe.value[0].result : [];
    const fromHeaders = [];
    const hd = state.headers && state.headers.headers;
    if (hd) {
      if (hd.server) fromHeaders.push({ name: hd.server.split(/[\s/]/)[0], category: 'Server', version: (hd.server.match(/\/([\d.]+)/) || [])[1] || null, evidence: 'Server header' });
      if (hd['x-powered-by']) fromHeaders.push({ name: hd['x-powered-by'].split(/[\s/]/)[0], category: 'Server', version: (hd['x-powered-by'].match(/\/([\d.]+)/) || [])[1] || null, evidence: 'X-Powered-By header' });
      if (hd['cf-ray']) fromHeaders.push({ name: 'Cloudflare', category: 'CDN', version: null, evidence: 'cf-ray header' });
      if (hd['x-vercel-id']) fromHeaders.push({ name: 'Vercel', category: 'Hosting', version: null, evidence: 'x-vercel-id header' });
      if (hd['x-nf-request-id']) fromHeaders.push({ name: 'Netlify', category: 'Hosting', version: null, evidence: 'x-nf-request-id header' });
      if (hd['x-amz-cf-id']) fromHeaders.push({ name: 'Amazon CloudFront', category: 'CDN', version: null, evidence: 'x-amz-cf-id header' });
      if (hd['x-github-request-id']) fromHeaders.push({ name: 'GitHub Pages', category: 'Hosting', version: null, evidence: 'x-github-request-id header' });
    }
    state.tech = mergeTech(probed, result.tech, fromHeaders);
    await loadCookiesIfAllowed();
    runAnalysis();
    state.scanMs = Math.round(performance.now() - t0);
    state.status = 'ready';
    render();
  }

  /** Deterministic: rules over the scan + headers + cookie flags. */
  function runAnalysis() {
    if (!state.scan) return;
    const out = globalThis.PageLensPipeline.website({ scan: state.scan, headers: state.headers, cookies: state.cookies, tech: state.tech, securityTxt: state.securityTxt });
    state.assessment = out.assessment;
    state.csp = out.csp;
    state.trackers = out.trackers;
    const res = out.analysis;
    state.issues = res.issues;
    state.analysisErrors = res.errors;
    state.rulesRun = res.rules;
    state.score = out.score;
    if (res.errors.length) console.warn('PageLens rule errors', res.errors);
    recordHistory();
  }

  function cookieOrigin() {
    try {
      const u = new URL(state.url);
      return /^https?:$/.test(u.protocol) ? u.origin + '/*' : null;
    } catch {
      return null;
    }
  }

  /** Reads cookie FLAGS only. Values are dropped the moment they arrive and never stored. */
  async function loadCookies() {
    if (!chrome.cookies) return false;
    const list = await chrome.cookies.getAll({ url: state.url });
    state.cookies = list.map((c) => ({
      name: c.name,
      domain: c.domain,
      hostOnly: c.hostOnly,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      session: c.session,
      expirationDate: c.expirationDate || null
    })).sort((a, b) => a.name.localeCompare(b.name));
    return true;
  }

  async function loadCookiesIfAllowed() {
    const origin = cookieOrigin();
    if (!origin) return;
    try {
      const ok = await chrome.permissions.contains({ permissions: ['cookies'], origins: [origin] });
      if (ok) await loadCookies();
    } catch { /* not granted */ }
  }

  async function requestCookieCheck() {
    const origin = cookieOrigin();
    if (!origin) return;
    try {
      const granted = await chrome.permissions.request({ permissions: ['cookies'], origins: [origin] });
      if (!granted) { toast('Permission not granted'); return; }
      await loadCookies();
      if (!state.headers) await fetchHeaders(); // same site grant also unlocks headers
      runAnalysis();
      rerenderKeepingScroll();
      toast(`Checked ${plural(state.cookies ? state.cookies.length : 0, 'cookie')}`);
    } catch {
      toast('Cookie check failed');
    }
  }

  function rerenderKeepingScroll() {
    render.keepScroll = true;
    render();
  }

  async function requestHeaderAccess() {
    let origin;
    try { origin = new URL(state.url).origin + '/*'; } catch { return; }
    try {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) { toast('Permission not granted'); return; }
      await fetchHeaders();
      runAnalysis();
      rerenderKeepingScroll();
      toast(state.headers ? 'Headers loaded' : 'Still could not read headers');
    } catch (err) {
      toast('Permission request failed');
    }
  }

  // ============================================================ shared widgets

  function ring(score, size = 96) {
    const r = size / 2 - 8;
    const c = 2 * Math.PI * r;
    const svg = s('svg', { class: 'ring', width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': score == null ? 'Not scored yet' : `Score ${score} out of 100` },
      s('circle', { class: 'track', cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': 8 }));
    if (score == null) {
      svg.append(s('circle', { class: 'pending', cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': 8 }));
    } else {
      svg.append(s('circle', {
        class: `arc s-${scoreClass(score)}`, cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': 8, 'stroke-linecap': 'round',
        'stroke-dasharray': c, 'stroke-dashoffset': c * (1 - score / 100), transform: `rotate(-90 ${size / 2} ${size / 2})`
      }));
    }
    svg.append(s('text', { x: '50%', y: '50%', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': size * 0.28, 'font-weight': 650 }, score == null ? '—' : String(score)));
    return svg;
  }

  function areaBar(label, value) {
    return h('div', { class: 'area' }, h('span', null, label),
      h('div', { class: 'bar' + (value == null ? ' pending' : ` s-${scoreClass(value)}`), role: 'presentation' }, value == null ? null : h('i', { style: { width: Math.max(2, value) + '%' } })),
      h('span', { class: 'v' }, value == null ? '—' : String(value)));
  }

  function paletteStrip(palette, max = 14) {
    const shown = palette.slice(0, max);
    const total = shown.reduce((a, p) => a + p.share, 0) || 1;
    return h('div', { class: 'strip', role: 'list', 'aria-label': 'Color palette by usage' },
      shown.map((p) => h('button', {
        type: 'button', class: 'strip-seg', role: 'listitem',
        style: { background: p.hex, flex: `${Math.max(p.share / total, 0.025)} 1 0` },
        title: `${p.hex} · ${pct(p.share)} — click to copy`,
        'aria-label': `${p.hex}, ${pct(p.share)} of usage. Copy.`,
        onclick: () => copy(p.hex, `Copied ${p.hex}`)
      })));
  }

  function barRows(rows, format = (v) => v) {
    const max = Math.max(1, ...rows.map((r) => r.value));
    return h('div', { class: 'barrows' }, rows.map((r) => h('div', { class: 'barrow' },
      h('span', null, r.label),
      h('div', { class: 'bar' }, h('i', { style: { width: `${Math.max(2, (r.value / max) * 100)}%` } })),
      h('span', { class: 'v' }, r.text || format(r.value)))));
  }

  function table(cols, rows) {
    return h('table', { class: 'tbl' },
      h('colgroup', null, cols.map((c) => h('col', { style: { width: c.width || null } }))),
      h('thead', null, h('tr', null, cols.map((c) => h('th', { class: c.num ? 'num' : null }, c.label)))),
      h('tbody', null, rows.map((r) => h('tr', null, cols.map((c) => {
        const v = c.get(r);
        return h('td', { class: [c.num ? 'num' : '', c.wrap ? 'wrap' : ''].join(' ').trim() || null, title: typeof v === 'string' ? v : null }, v);
      })))));
  }

  function empty(title, text, ic = ICONS.info, extra = null) {
    return h('div', { class: 'empty-state' }, h('div', { class: 'icon' }, icon(ic)), h('h2', null, title), h('p', null, text), extra);
  }

  function linkRow(label, text, selector, extra) {
    return h('button', { type: 'button', class: 'linkrow', title: selector ? `Show on page: ${selector}` : null, onclick: () => highlight(selector) },
      label ? h('span', { class: 'lvl' }, label) : null, h('span', { class: 'txt' }, text), extra || null);
  }

  // ============================================================ issues

  function sevDot(sev) {
    return h('span', { class: `sev sev-${sev}`, role: 'img', 'aria-label': `${SEV_LABEL[sev]} severity`, title: `${SEV_LABEL[sev]} severity` });
  }

  function contrastPairs(pairs) {
    return h('div', { class: 'cpairs' }, pairs.slice(0, 6).map((p) => h('div', { class: 'cpair' },
      h('span', { class: 'cprev', style: { color: p.fg, background: p.bg } }, 'Aa'),
      h('span', { class: 'cinfo' },
        h('span', { class: 'mono' }, `${p.fg} on ${p.bg}`),
        h('span', { class: 'faint small' }, `${p.ratio}:1 · needs ${p.need}:1${p.sample ? ` · "${p.sample}"` : ''}`)),
      p.suggestion ? h('button', {
        type: 'button', class: 'cfix', title: `Copy ${p.suggestion}`, onclick: (e) => { e.stopPropagation(); copy(p.suggestion, `Copied ${p.suggestion}`); }
      }, h('span', { class: 'cprev', style: { color: p.suggestion, background: p.bg } }, 'Aa'), h('span', { class: 'mono' }, p.suggestion)) : null)));
  }

  function issueBody(issue) {
    const where = issue.where.length
      ? h('div', { class: 'where' }, h('span', { class: 'faint small' }, say('Find it:', 'Where:')),
        issue.where.slice(0, 6).map((sel, i) => h('button', { type: 'button', class: 'chip', title: sel, onclick: () => highlight(sel) },
          h('b', null, issue.where.length === 1 ? 'Show on page' : `#${i + 1}`))),
        issue.where.length > 6 ? h('span', { class: 'faint small' }, `+${issue.where.length - 6}`) : null)
      : null;
    const techLine = [issue.whereText, issue.tech].filter(Boolean).join(' · ');
    return h('div', { class: 'issue-b' },
      h('p', null, issue.why),
      h('p', { class: 'fix' }, h('b', null, 'How to fix: '), issue.fix),
      issue.rule === 'contrast' && issue.data ? contrastPairs(issue.data.pairs) : null,
      issue.rule === 'near-duplicate-colors' && issue.data ? h('div', { class: 'chips' }, issue.data.pairs.slice(0, 6).map((p) =>
        h('span', { class: 'chip' }, h('span', { class: 'pair' }, h('i', { style: { background: p.a } }), h('span', null, p.a), h('span', { class: 'faint' }, '≈'), h('i', { style: { background: p.b } }), h('span', null, p.b))))) : null,
      where,
      techLine
        ? (state.role === 'everyday'
          ? h('details', { class: 'tech' }, h('summary', null, 'Technical detail'), h('div', { class: 'mono' }, techLine))
          : h('div', { class: 'tech mono' }, techLine))
        : null,
      h('div', { class: 'issue-meta' }, [SEV_LABEL[issue.severity], Score.EFFORT[issue.effort].label, Score.AREA[issue.area].label, issue.ref].filter(Boolean).join(' · ')));
  }

  function issueItem(issue, opts = {}) {
    const open = state.openIssues.has(issue.id);
    const li = h('li', { class: 'issue' + (open ? ' open' : '') });
    const head = h('button', { type: 'button', class: 'issue-h', 'aria-expanded': String(open) },
      sevDot(issue.severity),
      h('span', { class: 'issue-t' }, issue.title),
      h('span', { class: 'issue-tags' },
        opts.showArea ? h('span', { class: 'tag' }, Score.AREA[issue.area].label.replace('Privacy & security', 'Security').replace('Design consistency', 'Design')) : null,
        h('span', { class: `tag effort-${issue.effort}` }, Score.EFFORT[issue.effort].label)));
    head.addEventListener('click', () => {
      const nowOpen = !state.openIssues.has(issue.id);
      if (nowOpen) state.openIssues.add(issue.id); else state.openIssues.delete(issue.id);
      li.classList.toggle('open', nowOpen);
      head.setAttribute('aria-expanded', String(nowOpen));
      const body = li.querySelector('.issue-b');
      if (nowOpen && !body) li.append(issueBody(issue));
      if (!nowOpen && body) body.remove();
    });
    li.append(head);
    if (open) li.append(issueBody(issue));
    return li;
  }

  const issueList = (issues, opts) => h('ul', { class: 'issues' }, issues.map((i) => issueItem(i, opts)));

  function rankedForRole() {
    const ranked = state.score ? state.score.ranked : [];
    const focus = ROLE_FOCUS[state.role];
    if (!focus) return ranked;
    return [...ranked.filter((i) => focus.includes(i.area)), ...ranked.filter((i) => !focus.includes(i.area))];
  }

  const scoreClass = (n) => (n >= 90 ? 'good' : n >= 75 ? 'ok' : n >= 60 ? 'warn' : 'bad');

  function okLine(text) {
    return h('div', { class: 'okline' }, icon(ICONS.check), h('span', null, text));
  }

  /** Score + issues for one area. Used at the top of each tab. */
  function areaCard(id, title, topic) {
    const a = state.score.areas[id];
    const issues = state.score.ranked.filter((i) => i.area === id && (!topic || i.topic === topic));
    return h('section', { class: 'card area-card', 'aria-label': `${a.label} score` },
      h('header', { class: 'area-head' },
        h('div', { class: `area-score s-${scoreClass(a.score)}` }, String(a.score)),
        h('div', null,
          h('h2', null, title || a.label),
          h('div', { class: 'muted small' }, topic
            ? `${issues.length ? plural(issues.length, 'issue') : 'no issues found'} · part of the ${a.label} score (${a.score}/100)`
            : `${a.grade.label} · ${issues.length ? plural(issues.length, 'issue') : 'no issues found'} · ${Math.round(a.weight * 100)}% of the total score`))),
      issues.length ? issueList(issues) : okLine('No problems found by the automatic checks.'));
  }

  function trustVerdict() {
    const sec = state.score.areas.security;
    const suspicious = state.issues.some((i) => (i.rule === 'phishing-host' && i.severity === 'high') || i.rule === 'login-mismatch');
    if (suspicious) return { cls: 'bad', text: 'Be careful on this site', sub: 'The address or the login form looks suspicious.' };
    if (sec.counts.critical) return { cls: 'bad', text: 'Not safe for personal details', sub: 'It has a serious security gap.' };
    if (sec.score >= 80) return { cls: 'good', text: 'Looks trustworthy', sub: 'No serious security problems found.' };
    if (sec.score >= 55) return { cls: 'warn', text: 'Mostly fine, some safety gaps', sub: 'Missing protections that well-run sites usually have.' };
    return { cls: 'bad', text: 'Weak security', sub: 'Several protections are missing.' };
  }

  // ============================================================ data shortcuts

  // ============================================================ overview blocks

  const BLOCKS = {
    verdict() {
      const sc = state.score;
      const serious = sc.counts.critical + sc.counts.high;
      const summary = sc.total
        ? say(
          `${plural(sc.total, 'thing')} to improve${serious ? `, ${serious} of them serious` : ''}. Start with the fixes below.`,
          `${plural(sc.total, 'issue')}: ${sc.counts.critical} critical, ${sc.counts.high} high, ${sc.counts.medium} medium, ${sc.counts.low} low.`)
        : 'The automatic checks found nothing to fix.';
      const top = rankedForRole().slice(0, 3);
      return card('Verdict', [
        h('div', { class: 'verdict' }, ring(sc.overall),
          h('div', null,
            h('div', { class: `grade g-${scoreClass(sc.overall)}` }, sc.grade.label),
            h('p', { class: 'muted' }, summary),
            sinceLine(state.history),
            sc.capped ? h('p', { class: 'faint small' }, say(
              `Held below "Good" until the critical problem is fixed (would be ${sc.uncapped}).`,
              `Capped at 74 by a critical issue (uncapped ${sc.uncapped}).`)) : null)),
        h('div', { class: 'areas' }, ROLE_AREAS[state.role].map((id) => areaBar(Score.AREA[id].label, sc.areas[id].score))),
        top.length ? [h('h3', { class: 'sub-h' }, say('Fix these first', 'Top 3 fixes (impact ÷ effort)')), issueList(top, { showArea: true })] : null
      ], { meta: `${state.rulesRun} checks` });
    },

    fixes() {
      const all = rankedForRole().slice(3);
      if (!all.length) return null;
      const LIMIT = 8;
      const shown = state.showAllFixes ? all : all.slice(0, LIMIT);
      return card(say('More things to fix', 'Fix list'), [
        issueList(shown, { showArea: true }),
        all.length > LIMIT ? h('button', {
          type: 'button', class: 'btn more-btn',
          onclick: () => { state.showAllFixes = !state.showAllFixes; rerenderKeepingScroll(); }
        }, state.showAllFixes ? 'Show fewer' : `Show all ${all.length}`) : null
      ], { meta: ROLE_FOCUS[state.role] ? say('your areas first', 'role areas first, then by impact ÷ effort') : 'ranked by impact ÷ effort' });
    },

    seo() {
      return areaCard('seo', say('Search engines', 'SEO basics'));
    },

    trust() {
      const sc = state.scan;
      const https = sc.page.protocol === 'https';
      const third = sc.performance.hosts.filter((x) => x.thirdParty).length;
      const items = [
        [https ? 'good' : 'bad', say('Secure connection', 'HTTPS'), https ? 'Yes' : 'No — page loaded over plain HTTP'],
        [state.assessment && state.assessment.available ? (state.assessment.score >= 70 ? 'good' : state.assessment.score >= 50 ? 'warn' : 'bad') : 'none', say('Safety headers', 'Header grade'), state.assessment && state.assessment.available ? `Grade ${state.assessment.grade} (${state.assessment.score}/100)` : 'Not checked yet'],
        [state.trackers && state.trackers.trackingCount ? 'warn' : 'none', say('Companies tracking visitors', 'Trackers'), state.trackers ? (state.trackers.trackingCount ? plural(state.trackers.trackingCount, 'company', 'companies') : 'None found') : '—'],
        ['none', say('Other sites loading content', 'Third-party hosts'), third ? plural(third, 'host') : 'None'],
        ['none', say('Cookies visible to scripts', 'Script-readable cookies'), sc.storage.cookies.readableCount ? plural(sc.storage.cookies.readableCount, 'cookie') : 'None']
      ];
      if (sc.page.isPunycode || sc.page.isIpHost) items.push(['warn', 'Address', sc.page.isPunycode ? 'Uses an encoded (punycode) domain' : 'Uses a raw IP address']);
      const tv = trustVerdict();
      return card(say('Can I trust this site?', 'Trust verdict'), [
        h('div', { class: `trust t-${tv.cls}` }, h('span', { class: `dot ${tv.cls}` }), h('div', null, h('div', { class: 't' }, tv.text), h('div', { class: 'd' }, tv.sub)),
          h('span', { class: 'trust-score' }, `${state.score.areas.security.score}/100`)),
        h('ul', { class: 'checklist' }, items.map(([dot, t, v]) =>
          h('li', null, h('span', { class: 'dot ' + dot }), h('div', { class: 't' }, t), h('div', { class: 'state' }, v))))
      ], { meta: 'Security tab has detail' });
    },

    profile() {
      const sc = state.scan;
      const nav = sc.performance.navigation;
      const hd = state.headers && state.headers.headers;
      return card('Site profile', [
        kv([
          ['Title', sc.page.title || h('span', { class: 'faint' }, 'No title')],
          ['Description', sc.meta.description || h('span', { class: 'faint' }, 'None set')],
          ['Language', sc.page.lang || h('span', { class: 'faint' }, 'Not declared')],
          state.role !== 'everyday' ? ['Protocol', nav && nav.protocol ? nav.protocol.toUpperCase() : null] : null,
          state.role !== 'everyday' && hd && hd.server ? ['Server', hd.server] : null
        ]),
        h('h3', { class: 'sub-h' }, say('Built with', 'Tech stack')),
        state.tech.length
          ? h('div', { class: 'chips' }, state.tech.slice(0, 18).map((t) => chip(t.name, t.version, { title: `${t.category} · found via ${t.evidence}` })))
          : h('div', { class: 'muted small' }, 'Nothing recognizable — likely hand-built or heavily bundled.')
      ]);
    },

    speed() {
      const p = state.scan.performance;
      return card(say('Speed', 'Performance'), h('div', { class: 'stats' },
        stat(say('Page size', 'Weight'), fmtBytes(p.totalBytes)),
        stat('Requests', String(p.requests)),
        stat(say('Main content', 'LCP'), fmtMs(p.lcp && p.lcp.time)),
        stat(say('Fully loaded', 'Load'), fmtMs(p.navigation && p.navigation.load))), { meta: 'Speed tab has detail' });
    },

    design() {
      const d = state.scan.design;
      const fontsLine = d.fonts.slice(0, 3).map((f) => f.family).join(' · ');
      return card(say('Look and feel', 'Design system'), [
        paletteStrip(d.palette),
        h('div', { class: 'sub' }, `${plural(d.palette.length, 'main color')} (${d.colorCount} raw) · ${plural(d.fonts.length, 'font')}${fontsLine ? ': ' + fontsLine : ''}`)
      ], { meta: 'Design tab has detail' });
    },

    layout() {
      const st = state.scan.structure;
      const counts = Object.entries(st.headingCounts).filter(([, n]) => n);
      const roles = [...new Set(st.landmarks.map((l) => l.role))];
      return card(say('Page structure', 'Layout & structure'), [
        h('div', { class: 'chips' }, counts.length ? counts.map(([lvl, n]) => chip(lvl.toUpperCase(), '×' + n)) : h('span', { class: 'muted small' }, 'No headings found')),
        h('div', { class: 'sub' }, roles.length ? `Landmarks: ${roles.join(', ')}` : 'No landmark regions (header, nav, main, footer) found')
      ], { meta: 'UX tab has detail' });
    }
  };

  function renderOverview() {
    const frag = document.createDocumentFragment();
    if (state.repo) {
      frag.append(h('div', { class: 'notice' }, icon(ICONS.github),
        h('div', { style: { flex: '1' } }, `This is the ${platformName(state.repo.platform)} repository ${state.repo.full}. Repo mode explains the project itself.`),
        h('button', { type: 'button', class: 'btn', onclick: () => { state.mode = 'github'; if (gh.status === 'idle') loadRepo(state.repo); else render(); } }, 'Open')));
    }
    for (const id of BLOCK_ORDER[state.role]) {
      const block = BLOCKS[id]();
      if (block) frag.append(block);
    }
    frag.append(h('div', { class: 'faint small', style: { textAlign: 'center' } },
      `Scanned ${state.scan.stats.elementsSampled.toLocaleString()} of ${state.scan.stats.elementsTotal.toLocaleString()} elements, ${state.rulesRun} checks, ${state.scanMs} ms · on-device`));
    return frag;
  }

  // ============================================================ design tab

  function renderDesign() {
    const d = state.scan.design;
    const frag = document.createDocumentFragment();
    frag.append(areaCard('design', say('Design consistency', 'Design consistency')));

    // Palette
    const roleText = (r) => {
      const parts = [];
      if (r.background > 0.005) parts.push(`bg ${pct(r.background)}`);
      if (r.text > 0.005) parts.push(`text ${pct(r.text)}`);
      if (r.border > 0.005) parts.push(`border ${pct(r.border)}`);
      return parts.join(' · ') || 'minor';
    };
    frag.append(card('Colors by usage', [
      paletteStrip(d.palette, 16),
      h('div', { class: 'swatches', style: { marginTop: '10px' } }, d.palette.filter((p) => p.share >= 0.0005).slice(0, 16).map((p) => h('button', {
        type: 'button', class: 'swatch', title: `Copy ${p.hex}${p.variants.length ? ` · merged with ${p.variants.join(', ')}` : ''}`,
        onclick: () => copy(p.hex, `Copied ${p.hex}`)
      },
      h('span', { class: 'chipc', style: { background: p.hex } }),
      h('span', null,
        h('div', { class: 'hex' }, p.hex.toUpperCase(), h('span', { class: 'faint', style: { fontWeight: 400 } }, `  ${pct(p.share)}`)),
        h('div', { class: 'meta' }, (p.kind === 'accent' ? 'accent · ' : '') + roleText(p.roles) + (p.variants.length ? ` · +${p.variants.length}` : '')))))),
      h('div', { class: 'sub' }, say(
        `Share is how much of the page each color covers. Very close shades are grouped together (${d.colorCount} distinct values found).`,
        `Weighted share: 50% background area, 35% text characters, 15% border length. ΔE<3 merged; ${d.colorCount} raw values.`))
    ], { meta: `${d.palette.length} swatches` }));

    if (d.nearDuplicates.length) {
      frag.append(card(say('Almost-identical colors', 'Near-duplicate colors'), [
        h('p', { class: 'muted small' }, say('These pairs look the same to the eye but are different values in the code.', 'Distinct values with ΔE76 < 4 — candidates for consolidation.')),
        h('div', { class: 'chips' }, d.nearDuplicates.slice(0, 12).map((p) => h('span', { class: 'chip', title: `ΔE ${p.deltaE}` },
          h('span', { class: 'pair' }, h('i', { style: { background: p.a } }), h('span', null, p.a), h('span', { class: 'faint' }, '≈'), h('i', { style: { background: p.b } }), h('span', null, p.b)))))
      ], { meta: `${d.nearDuplicates.length} pairs` }));
    }

    // Fonts
    frag.append(card('Fonts', d.fonts.length ? d.fonts.slice(0, 6).map((f) => h('div', { class: 'font-row' },
      h('div', { class: 'aa', style: { fontFamily: f.stack.map((x) => `"${x.replace(/"/g, '')}"`).join(',') + ', sans-serif' } }, 'Aa'),
      h('div', { style: { minWidth: 0 } },
        h('div', { class: 'name', title: f.stack.join(', ') }, f.family),
        h('div', { class: 'detail' }, [
          `mostly ${f.primaryRole}`,
          `weights ${f.weights.slice(0, 4).map((w) => w.weight).join(', ')}`,
          f.source === 'web' ? `web font${f.loadedFaces ? ` · ${f.loadedFaces}/${f.faces} faces loaded` : ''}` : f.source === 'system' ? 'generic family' : 'installed font'
        ].join(' · '))),
      h('div', { class: 'share' }, pct(f.share)))) : h('div', { class: 'muted' }, 'No visible text found.'),
    { meta: say('share of text', 'share of characters') }));

    // Type scale
    const ts = d.typeScale;
    frag.append(card('Type scale', [
      ts.steps.slice(0, 10).map((st) => h('div', { class: 'type-row' },
        h('span', { class: 'px' }, `${st.px}px`),
        h('span', { class: 'sample', style: { fontSize: Math.min(st.px, 30) + 'px', fontWeight: st.role === 'heading' ? 650 : 400 }, title: `Used on: ${st.tags.join(', ')} · line-height ${st.lineHeight}` },
          st.px === ts.basePx ? 'Body text' : st.role === 'heading' ? 'Heading' : st.tags[0] || 'Text'),
        h('span', { class: 'share' }, pct(st.share)))),
      h('div', { class: 'sub' }, [
        `Base ${ts.basePx}px`,
        ts.medianRatio ? `step ratio ≈ ${ts.medianRatio}${ts.scaleName ? ` (${ts.scaleName})` : ''}` : 'no consistent ratio',
        `${ts.steps.length} sizes in regular use`
      ].join(' · '))
    ]));

    // Spacing
    const sp = d.spacing;
    const maxCount = Math.max(1, ...sp.values.map((v) => v.count));
    frag.append(card('Spacing', [
      h('div', { class: 'chips' }, sp.values.slice(0, 16).map((v) => h('span', { class: 'space-chip', title: `${v.count} uses` },
        h('i', { style: { width: Math.min(64, Math.max(2, v.px)) + 'px', opacity: 0.35 + 0.6 * (v.count / maxCount) } }), `${v.px}`, h('span', null, `×${v.count}`)))),
      h('div', { class: 'sub' }, sp.onGrid4 == null ? 'No spacing values found.' : say(
        `${pct(sp.onGrid8)} of spacing follows an 8px rhythm, ${pct(sp.onGrid4)} a 4px rhythm. ${sp.distinct} different values in use.`,
        `On 8px grid: ${pct(sp.onGrid8)} · on 4px grid: ${pct(sp.onGrid4)} · ${sp.distinct} distinct values (margin, padding, gap).`))
    ]));

    // Radii + shadows
    frag.append(card('Corner radius', d.radii.values.length ? [
      h('div', { class: 'previews' }, d.radii.values.slice(0, 8).map((r) => h('div', { class: 'preview', title: `${r.value} · ${r.count} uses` },
        h('div', { class: 'box', style: { borderRadius: r.value } }), h('div', { class: 'lbl' }, r.value), h('div', null, `×${r.count}`)))),
      h('div', { class: 'sub' }, `${d.radii.distinct} distinct radius values`)
    ] : h('div', { class: 'muted' }, 'Everything uses square corners.')));

    frag.append(card('Shadows', d.shadows.values.length ? [
      h('div', { class: 'previews shadow-stage' }, d.shadows.values.slice(0, 4).map((sh) => h('div', { class: 'preview', title: sh.value },
        h('div', { class: 'shadow-box', style: { boxShadow: sh.value } }), h('div', { class: 'lbl', style: { color: '#565667' } }, `×${sh.count}`)))),
      h('div', { class: 'sub' }, `${d.shadows.distinct} distinct shadows${d.shadows.textShadows ? ` · ${d.shadows.textShadows} text shadows` : ''}`)
    ] : h('div', { class: 'muted' }, 'No box shadows — a flat style.')));

    // Components
    const cp = d.components;
    const counts = [['Buttons', cp.buttons], ['Links', cp.links], ['Inputs', cp.inputs], ['Checks', cp.checkboxes],
      ['Selects', cp.selects], ['Images', cp.images], ['Icons', cp.icons], ['Cards', cp.cards], ['Navs', cp.navs],
      ['Tables', cp.tables], ['Videos', cp.videos], ['Iframes', cp.iframes]];
    frag.append(card('Components', [
      h('div', { class: 'comp-grid' }, counts.map(([l, n]) => h('div', { class: 'comp' }, h('b', null, String(n)), h('span', null, l)))),
      cp.buttonVariants.length ? [
        h('h3', { class: 'sub-h' }, `Button styles (${cp.buttonVariants.length})`),
        h('div', { class: 'btn-stage btn-variants' }, cp.buttonVariants.slice(0, 8).map((b) => h('div', { class: 'btn-sample' },
          h('button', {
            type: 'button', title: `Show on page · ${b.count} uses`, onclick: () => highlight(b.selector),
            style: {
              background: b.background || 'transparent', color: b.color, borderRadius: b.radius, border: b.border || '0',
              fontWeight: b.fontWeight, fontSize: `min(${b.fontSize}, 14px)`, padding: b.padding
            }
          }, b.label || 'Button'),
          h('span', { style: { color: '#565667' } }, `×${b.count}`))))
      ] : null
    ]));

    return frag;
  }

  // ============================================================ UX tab (layout & structure)

  function renderUX() {
    const sc = state.scan;
    const st = sc.structure;
    const frag = document.createDocumentFragment();
    frag.append(areaCard('uiux', say('Ease of use', 'UI/UX review')));

    // Heading outline
    const MAX = 60;
    frag.append(card(say('Headings', 'Heading outline'), st.headings.length ? [
      h('ol', { class: 'outline' }, st.headings.slice(0, MAX).map((hd) => h('li', { style: { '--lvl': hd.level - 1 } },
        h('button', { type: 'button', onclick: () => highlight(hd.selector), title: `Show on page${hd.visible ? '' : ' (visually hidden)'}` },
          h('span', { class: 'lvl' }, 'H' + hd.level),
          h('span', { class: 'txt' + (hd.empty ? ' empty' : '') + (!hd.visible ? ' hiddenh' : '') }, hd.empty ? '(empty heading)' : hd.text))))),
      st.headings.length > MAX ? h('div', { class: 'more' }, `+ ${st.headings.length - MAX} more`) : null,
      h('div', { class: 'sub' }, say('Click any heading to find it on the page.', 'Click to highlight. Indent = level; grey = not visible.'))
    ] : h('div', { class: 'muted' }, 'This page has no headings.'), { meta: plural(st.headings.length, 'heading') }));

    // Section map
    const total = Math.max(1, sc.page.scrollHeight);
    const flat = [];
    for (const b of st.sections) {
      flat.push({ ...b, depth: 0 });
      for (const c of b.children || []) flat.push({ ...c, depth: 1 });
    }
    const labelOf = (b) => b.heading || (b.role ? b.role : `<${b.tag}>`);
    const SHORT = { banner: 'head', navigation: 'nav', main: 'main', contentinfo: 'foot', complementary: 'side', region: 'regn', search: 'srch', form: 'form' };
    const badge = (b) => (b.role ? SHORT[b.role] || b.role.slice(0, 4) : b.tag.slice(0, 7));
    // Minimap draws the most detailed level available: a block's children replace the block itself.
    const mapBlocks = st.sections.flatMap((b) => (b.children && b.children.length ? b.children : [b]));
    if (flat.length) {
      const map = h('div', { class: 'minimap', 'aria-hidden': 'true' }, mapBlocks.map((b) => h('button', {
        type: 'button', tabindex: '-1', class: b.role ? 'lm' : null, title: labelOf(b),
        style: { top: `${(b.top / total) * 100}%`, height: `max(3px, ${(b.height / total) * 100}% - 2px)` },
        onclick: () => highlight(b.selector)
      })));
      frag.append(card('Section map', h('div', { class: 'sectionmap' }, map,
        h('div', { class: 'secrows' }, flat.slice(0, 40).map((b) => h('div', { style: { paddingLeft: b.depth ? '14px' : '0' } },
          linkRow(badge(b), labelOf(b), b.selector, h('span', { class: 'faint small', style: { marginLeft: 'auto', flex: 'none' } }, pct(b.height / total))))))),
      { meta: `page ${sc.page.scrollHeight.toLocaleString()}px tall` }));
    }

    // Landmarks
    frag.append(card('Landmarks', st.landmarks.length
      ? h('div', null, st.landmarks.map((l) => linkRow(l.role, [l.label || `<${l.tag}>`, l.links != null ? ` · ${l.links} links` : ''].join(''), l.selector)))
      : h('p', { class: 'muted' }, say('No header, navigation, main or footer regions are marked up. Screen reader users rely on these to jump around.',
        'No landmark regions found.')),
    { meta: plural(st.landmarks.length, 'region') }));

    // Readability + actions
    const rd = sc.text.readability;
    const ctas = sc.interaction.ctas;
    frag.append(card(say('Reading and actions', 'Readability & primary action'), [
      h('div', { class: 'stats three' },
        stat(say('Body text', 'Base size'), `${rd.basePx}px`, rd.baseLineHeight ? `line-height ${rd.baseLineHeight}` : null),
        stat(say('Line length', 'Median line'), rd.medianLineChars ? `~${rd.medianLineChars} ch` : '—', `${rd.paragraphs} paragraphs`),
        stat(say('Tiny text', 'Text < 12px'), pct(rd.smallTextShare), `${rd.totalChars.toLocaleString()} chars`)),
      h('h3', { class: 'sub-h' }, say('Most eye-catching actions on first screen', 'Above-the-fold action candidates')),
      ctas.length
        ? h('div', null, ctas.slice(0, 5).map((c, i) => linkRow(String(i + 1), c.label || '(no label)', c.selector,
          h('span', { class: 'faint small', style: { marginLeft: 'auto', flex: 'none' } }, c.filled ? 'filled' : 'link'))))
        : h('div', { class: 'muted small' }, 'No buttons or links in the first screen.')
    ]));

    // Forms summary
    const it = sc.interaction;
    if (it.forms.length || it.fields.length) {
      frag.append(card('Forms', kv([
        ['Forms', String(it.forms.length)],
        ['Fields', String(it.fields.length)],
        ['Login forms', String(it.forms.filter((f) => f.hasPassword).length)],
        ['Search forms', String(it.forms.filter((f) => f.isSearch).length)]
      ])));
    }
    return frag;
  }

  // ============================================================ access tab

  function renderAccess() {
    const sc = state.scan;
    const imgs = sc.media.images.filter((i) => i.visible);
    const fields = sc.interaction.fields.filter((f) => f.visible);
    const frag = document.createDocumentFragment();
    frag.append(areaCard('accessibility', say('Can everyone use it?', 'Accessibility (WCAG 2.2)')));
    frag.append(card(say('What was checked', 'Coverage'), [
      h('div', { class: 'stats three' },
        stat(say('Text color pairs', 'Contrast groups'), String(sc.text.contrastGroups.length), 'text on background'),
        stat('Images', String(imgs.length), `${imgs.filter((i) => i.alt === null).length} without alt`),
        stat('Form fields', String(fields.length), `${fields.filter((f) => !f.label).length} without a label`),
        stat(say('Clickable things', 'Targets'), String(sc.interaction.targets.total), `${sc.interaction.targets.small.filter((t) => !t.inline).length} under 24×24px`),
        stat('Headings', String(sc.structure.headings.length), sc.structure.headingCounts.h1 === 1 ? 'one H1' : `${sc.structure.headingCounts.h1} H1s`),
        stat('Language', sc.page.lang || 'none', 'declared on <html>')),
      h('div', { class: 'sub' }, say(
        'PageLens checks focus outlines, Tab order and click-only elements from the page code. A quick Tab through the page is still the best final test.',
        `Static checks: focus indicators (CSSOM, ${sc.a11y ? plural(sc.a11y.focusables, 'focusable') : 'n/a'}${sc.a11y && sc.a11y.focusCssUnreadable ? `, ${sc.a11y.focusCssUnreadable} cross-origin sheets unreadable` : ''}), tabindex, aria-hidden, names, ARIA refs. Not automated: focus order vs visual order, text over images.`))
    ]));
    return frag;
  }

  // ============================================================ speed tab

  function renderSpeed() {
    const p = state.scan.performance;
    const nav = p.navigation || {};
    const frag = document.createDocumentFragment();
    frag.append(areaCard('performance', say('Speed', 'Performance')));

    frag.append(card(say('How fast it loads', 'Load timing'), h('div', { class: 'stats' },
      stat(say('Server reply', 'TTFB'), fmtMs(nav.ttfb)),
      stat(say('First paint', 'FCP'), fmtMs(p.fcp)),
      stat(say('Main content', 'LCP'), fmtMs(p.lcp && p.lcp.time)),
      stat(say('Layout jumps', 'CLS'), String(p.cls)),
      stat(say('Page ready', 'DOM loaded'), fmtMs(nav.domContentLoaded)),
      stat(say('Fully loaded', 'Load event'), fmtMs(nav.load)),
      stat(say('Page size', 'Transfer'), fmtBytes(p.totalBytes)),
      stat('Requests', String(p.requests))), {
      meta: nav.type === 'back_forward' ? 'from back/forward cache' : nav.protocol ? nav.protocol.toUpperCase() : null
    }));

    const types = Object.entries(p.byType).map(([k, v]) => ({ label: k, value: v.bytes, count: v.count })).sort((a, b) => b.value - a.value);
    frag.append(card(say('What makes it heavy', 'Weight by type'), [
      barRows(types.map((t) => ({ label: t.label, value: t.value, text: `${fmtBytes(t.value)} · ${t.count}` }))),
      h('div', { class: 'sub' }, [
        p.unknownSize ? `${p.unknownSize} cross-site files hide their size` : null,
        p.cachedCount ? `${p.cachedCount} came from cache` : null,
        p.bufferLikelyFull ? 'browser stopped counting after 250 files' : null
      ].filter(Boolean).join(' · ') || 'Sizes are compressed transfer sizes.')
    ]));

    frag.append(card(say('Biggest files', 'Heaviest requests'), table([
      { label: 'File', width: '52%', get: (r) => fileName(r.url) },
      { label: 'Type', width: '16%', get: (r) => r.kind },
      { label: 'Host', width: '18%', get: (r) => (r.thirdParty ? '3rd' : '1st') },
      { label: 'Size', width: '14%', num: true, get: (r) => fmtBytes(r.bytes) }
    ], p.heaviest.filter((r) => r.bytes > 0).slice(0, 10))));

    if (p.renderBlocking.length) {
      frag.append(card(say('Files that hold up the first paint', 'Render-blocking'), table([
        { label: 'File', width: '62%', get: (r) => fileName(r.url) },
        { label: 'Type', width: '18%', get: (r) => r.kind },
        { label: 'Size', width: '20%', num: true, get: sizeOf }
      ], p.renderBlocking.slice(0, 10)), { meta: String(p.renderBlocking.length) }));
    }

    frag.append(card(say('Where files come from', 'Hosts'), table([
      { label: 'Host', width: '56%', get: (r) => r.host || '(inline/data)' },
      { label: 'Party', width: '14%', get: (r) => (r.thirdParty ? '3rd' : '1st') },
      { label: 'Files', width: '12%', num: true, get: (r) => String(r.count) },
      { label: 'Size', width: '18%', num: true, get: (r) => (r.bytes ? fmtBytes(r.bytes) : '—') }
    ], p.hosts.slice(0, 10)), { meta: plural(p.hosts.length, 'host') }));

    return frag;
  }

  // ============================================================ privacy tab

  function renderPrivacy() {
    const sc = state.scan;
    const frag = document.createDocumentFragment();
    frag.append(notice(say(
      'PageLens only looks at what your browser already loaded. It never attacks, probes or logs in, and never shows cookie or password values.',
      'Passive only: one header re-fetch of this URL without cookies, no probing. Values of cookies, storage and fields are never read.'), ICONS.lock));
    frag.append(areaCard('security', say('Privacy', 'Privacy findings'), 'privacy'));

    // Who is watching: third parties by company and category
    const tr = state.trackers;
    const CAT = globalThis.PageLensTrackers ? globalThis.PageLensTrackers.CATEGORIES : {};
    if (tr && (tr.companies.length || tr.unknown.length)) {
      const groups = {};
      for (const c of tr.companies) {
        const main = c.categories.find((k) => CAT[k] && CAT[k].tracking) || c.categories[0];
        (groups[main] = groups[main] || []).push(c);
      }
      const order = ['advertising', 'recording', 'analytics', 'social', 'tags', 'support', 'consent', 'monitoring', 'payments', 'captcha', 'video', 'maps', 'fonts', 'cdn', 'hosting', 'other'];
      frag.append(card(say('Who can see your visit', 'Third parties by company'), [
        h('div', { class: 'stats three' },
          stat(say('Tracking companies', 'Trackers'), String(tr.trackingCount)),
          stat(say('Other services', 'Known services'), String(tr.companies.length - tr.trackingCount)),
          stat(say('Unrecognized', 'Unknown hosts'), String(tr.unknown.length))),
        order.filter((k) => groups[k]).map((k) => h('div', { class: 'tp-group' },
          h('div', { class: 'tp-h' }, h('span', { class: `dot ${CAT[k] && CAT[k].tracking ? 'warn' : 'none'}` }), h('b', null, CAT[k] ? CAT[k].label : k),
            CAT[k] && CAT[k].plain ? h('span', { class: 'faint small' }, ` · ${CAT[k].plain}`) : null),
          h('div', { class: 'chips' }, groups[k].map((c) => chip(c.company, String(c.requests), { title: `${c.hosts.join(', ')} · ${plural(c.requests, 'request')} · ${fmtBytes(c.bytes)}` }))))),
        tr.unknown.length ? h('div', { class: 'tp-group' },
          h('div', { class: 'tp-h' }, h('span', { class: 'dot none' }), h('b', null, say('Not in PageLens\'s list', 'Unrecognized hosts')),
            h('span', { class: 'faint small' }, say(' · not necessarily bad, just unknown', ' · not in the bundled list of ' + globalThis.PageLensTrackers.size + ' domains'))),
          h('div', { class: 'chips' }, tr.unknown.slice(0, 20).map((x) => chip(x.host, String(x.count), { title: `${x.count} files · ${fmtBytes(x.bytes)}` })))) : null,
        h('div', { class: 'sub' }, say('Every company listed here learns that you opened this page.', 'Classified by domain suffix against a bundled list. Counts are requests seen in this page load.'))
      ], { meta: `${tr.companies.length + tr.unknown.length} outside hosts` }));
    } else {
      frag.append(card(say('Who can see your visit', 'Third parties'), okLine('Everything loads from the site itself.')));
    }

    // Cookies + storage (names only)
    const stg = sc.storage;
    frag.append(card(say('Cookies and saved data', 'Cookies & storage'), [
      kv([
        [say('Cookies', 'Readable cookies'), String(stg.cookies.readableCount)],
        ['Local storage', stg.localStorage.blocked ? 'blocked' : plural(stg.localStorage.count, 'key')],
        ['Session storage', stg.sessionStorage.blocked ? 'blocked' : plural(stg.sessionStorage.count, 'key')]
      ]),
      stg.cookies.names.length ? [h('h3', { class: 'sub-h' }, 'Cookie names'), h('div', { class: 'chips' }, stg.cookies.names.slice(0, 30).map((n) => chip(n)))] : null,
      stg.localStorage.names.length ? [h('h3', { class: 'sub-h' }, 'Storage keys'), h('div', { class: 'chips' }, stg.localStorage.names.slice(0, 30).map((n) => chip(n)))] : null,
      h('div', { class: 'sub' }, say('Names only — values are never read. Cookies hidden from scripts can\'t be seen here.',
        'Names only, read via document.cookie. Use "Check cookie flags" below for HttpOnly cookies and Secure / SameSite flags.'))
    ]));

    // Cookie flags (optional permission, flags only)
    const ck = state.cookies;
    frag.append(card(say('Cookie safety settings', 'Cookie flags'), ck ? [
      ck.length ? table([
        { label: 'Name', width: '40%', get: (c) => c.name },
        { label: 'Secure', width: '15%', get: (c) => (c.secure ? 'Yes' : 'No') },
        { label: 'HttpOnly', width: '16%', get: (c) => (c.httpOnly ? 'Yes' : 'No') },
        { label: 'SameSite', width: '15%', get: (c) => ({ no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: '—' }[c.sameSite] || c.sameSite) },
        { label: 'Lasts', width: '14%', num: true, get: (c) => (c.session || !c.expirationDate ? 'session' : `${Math.max(0, Math.round((c.expirationDate - Date.now() / 1000) / 86400))} d`) }
      ], ck.slice(0, 40)) : h('div', { class: 'muted' }, 'This site sets no cookies for this address.'),
      h('div', { class: 'sub' }, 'Flags only. Cookie values are discarded as soon as Chrome returns them and are never stored or shown.')
    ] : [
      h('p', { class: 'muted' }, say(
        'PageLens can check whether this site protects its cookies (for example, so scripts can\'t steal your login). Chrome asks your permission for this site only.',
        'Reads Secure, HttpOnly, SameSite and expiry via chrome.cookies for this origin only (optional permission). Values are discarded.')),
      h('button', { type: 'button', class: 'btn primary', onclick: requestCookieCheck, style: { marginTop: '6px', padding: '6px 14px' } }, 'Check cookie flags')
    ], { meta: ck ? plural(ck.length, 'cookie') : null }));

    return frag;
  }

  // ============================================================ security tab

  const STATUS_DOT = { good: 'good', weak: 'warn', missing: 'bad', bad: 'bad', info: 'none', na: 'none', other: 'none' };
  const STATUS_LABEL = { good: 'OK', weak: 'Weak', missing: 'Missing', bad: 'Problem', info: 'Info', na: 'n/a', other: '' };
  const GRADE_CLASS = (g) => (!g ? 'none' : g.startsWith('A') ? 'good' : g.startsWith('B') ? 'ok' : g.startsWith('C') ? 'warn' : 'bad');

  function currentFixes() {
    return globalThis.PageLensPipeline.fixes({ assessment: state.assessment, headers: state.headers, scan: state.scan, csp: state.csp, tech: state.tech, platform: state.fixPlatform, all: state.fixAll });
  }

  function securityReport() {
    return globalThis.PageLensReport.securityMarkdown({
      scan: state.scan, score: state.score, assessment: state.assessment, csp: state.csp, fixes: currentFixes(),
      trackers: state.trackers, securityTxt: state.securityTxt, version: VERSION
    });
  }

  async function checkSecurityTxt() {
    state.securityTxtStatus = 'loading';
    rerenderKeepingScroll();
    try {
      const res = await chrome.runtime.sendMessage({ type: 'pagelens:securitytxt', url: state.url });
      if (res && res.ok) {
        state.securityTxt = res.found ? globalThis.PageLensReport.parseSecurityTxt(res.text, Date.now()) : { found: false, status: res.status };
        state.securityTxtStatus = 'done';
        runAnalysis();
      } else {
        state.securityTxtStatus = res && res.error === 'no-access' ? 'no-access' : 'error';
      }
    } catch {
      state.securityTxtStatus = 'error';
    }
    rerenderKeepingScroll();
  }

  function renderSecurity() {
    const sc = state.scan;
    const https = sc.page.protocol === 'https';
    const A = state.assessment;
    const frag = document.createDocumentFragment();

    // Grade + report
    const secIssues = state.score.ranked.filter((i) => i.area === 'security' && i.topic !== 'privacy');
    frag.append(h('section', { class: 'card' },
      h('div', { class: 'grade-row' },
        h('div', { class: `big-grade s-${GRADE_CLASS(A && A.grade)}`, 'aria-label': A && A.available ? `Header grade ${A.grade}` : 'No grade' }, A && A.available ? A.grade : '—'),
        h('div', { style: { minWidth: 0 } },
          h('h2', { class: 'grade-title' }, say('Security grade', 'Header grade (Observatory method)')),
          h('div', { class: 'muted small' }, A && A.available
            ? `${A.score}/100${A.bonus ? ` (incl. +${A.bonus} bonus)` : ''} · ${plural(secIssues.length, 'security finding')}`
            : 'Needs the page headers — allow access below.'),
          h('div', { class: 'faint small' }, say('Same scoring as Mozilla\'s HTTP Observatory.', 'Mozilla HTTP Observatory modifiers; one passive response, no redirect probe.')))),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn primary', disabled: !A || !A.available ? true : null, onclick: () => copy(securityReport(), 'Security report copied as Markdown') }, 'Copy report'),
        h('button', {
          type: 'button', class: 'btn', disabled: !A || !A.available ? true : null,
          onclick: () => { download(`security-report-${sc.page.host}-${new Date().toISOString().slice(0, 10)}.md`, securityReport(), 'text/markdown'); toast('Report downloaded'); }
        }, 'Download .md'))));

    if (!state.headers) {
      const noAccess = state.headersError === 'no-access';
      frag.append(card(say('Safety headers', 'Response headers'), [
        h('p', { class: 'muted' }, noAccess
          ? 'Chrome did not let PageLens re-read this page\'s headers. Allow it for this site only and PageLens will make one plain request, without your cookies.'
          : `Headers could not be read (${state.headersError || 'unknown error'}).`),
        noAccess ? h('button', { type: 'button', class: 'btn primary', onclick: requestHeaderAccess, style: { marginTop: '6px' } }, 'Allow for this site') : null
      ]));
    }

    frag.append(areaCard('security', say('Security findings', 'Security findings'), 'security'));

    if (A && A.available) {
      // Observatory-style tests
      frag.append(card(say('How the grade is worked out', 'Header tests'), [
        h('ul', { class: 'checklist' }, A.tests.map((t) => h('li', null,
          h('span', { class: `dot ${STATUS_DOT[t.status]}` }),
          h('div', { style: { minWidth: 0 } }, h('div', { class: 't' }, t.label), h('div', { class: 'd' }, t.result), t.fix && t.status !== 'good' ? h('div', { class: 'val' }, t.fix) : null),
          h('div', { class: `state pts ${t.modifier > 0 ? 'plus' : t.modifier < 0 ? 'minus' : ''}` }, t.status === 'na' ? 'n/a' : `${t.modifier > 0 ? '+' : ''}${t.modifier}`)))),
        h('div', { class: 'sub' }, 'Start at 100, subtract each penalty, then add bonus points only if the result is already 90 or more. A+ needs 100+.')
      ]));

      // Raw headers
      const rows = A.table.filter((r) => state.showAllHeaders || r.security);
      frag.append(card(say('Headers this site sends', 'Raw response headers'), [
        h('ul', { class: 'hdrs' }, rows.map((r) => h('li', null,
          h('div', { class: 'hdr-h' }, h('span', { class: `dot ${STATUS_DOT[r.status]}` }), h('span', { class: 'mono hdr-name' }, r.name),
            STATUS_LABEL[r.status] ? h('span', { class: `tag hdr-${r.status}` }, STATUS_LABEL[r.status]) : null),
          r.value != null ? h('div', { class: 'hdr-v mono' }, r.value) : null,
          r.note ? h('div', { class: 'd' }, r.note) : null))),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn', onclick: () => { state.showAllHeaders = !state.showAllHeaders; rerenderKeepingScroll(); } },
            state.showAllHeaders ? 'Security headers only' : `Show all ${A.table.length} headers`),
          h('button', { type: 'button', class: 'btn', onclick: () => copy(Object.entries(state.headers.headers).map(([k, v]) => `${k}: ${v}`).join('\n'), 'Headers copied') }, 'Copy raw')),
        h('div', { class: 'sub' }, `From one request to ${state.headers.finalUrl || sc.page.url} (HTTP ${state.headers.status}, ${state.headers.ms} ms, no cookies). Set-Cookie is never read.`)
      ], { meta: `${A.table.filter((r) => r.security).length} security-related` }));

      // Ready-to-paste fixes
      const fx = currentFixes();
      const F = globalThis.PageLensFixes;
      const select = h('select', { class: 'platform-select', 'aria-label': 'Server or host' },
        F.PLATFORMS.map((p) => h('option', { value: p.id, selected: p.id === fx.platform ? true : null }, p.label)));
      select.addEventListener('change', (e) => { state.fixPlatform = e.target.value; rerenderKeepingScroll(); });
      const allToggle = h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: state.fixAll ? true : null }), ' Include headers that are already fine');
      allToggle.querySelector('input').addEventListener('change', (e) => { state.fixAll = e.target.checked; rerenderKeepingScroll(); });
      frag.append(card(say('Fix it: copy-and-paste settings', 'Ready-to-paste server config'), [
        h('div', { class: 'fix-ctl' }, select, allToggle),
        fx.set.length || fx.remove.length || fx.serverLeak ? [
          h('ul', { class: 'bullets', style: { margin: '8px 0' } },
            fx.set.map((x) => h('li', null, h('b', { class: 'mono' }, x.name), ` — ${x.why}`)),
            fx.remove.map((x) => h('li', null, h('b', { class: 'mono' }, `remove ${x}`), ' — reveals server software')),
            fx.serverLeak ? h('li', null, h('b', { class: 'mono' }, 'hide Server version'), ' — the version number helps attackers') : null),
          h('div', { class: 'faint small' }, `Put this in ${fx.file}:`),
          codeBlock(fx.snippet, { copied: `${fx.label} config copied` }),
          h('div', { class: 'sub' }, say(
            'Test on a staging site first. HSTS tells browsers to refuse plain http for a year, so only add it once every subdomain works over HTTPS.',
            'Pre-selected from the Server/X-Powered-By headers. CSP goes in as Report-Only so nothing breaks; enforce it after reviewing reports.'))
        ] : okLine('Nothing to add — the important headers are already set.')
      ], { meta: fx.label }));

      // CSP builder
      const C = state.csp;
      if (C) {
        frag.append(card(say('A script policy made for this page', 'Suggested Content-Security-Policy'), [
          h('p', { class: 'muted small' }, say(
            'A Content-Security-Policy tells the browser which scripts are allowed. PageLens built one from the files this page actually loaded.',
            `Generated from ${sc.performance.resources.length} loaded resources, ${sc.code.scripts.external.length} script tags and ${sc.interaction.forms.length} forms.`)),
          A.csp && A.csp.valid ? h('div', { class: 'notice', style: { margin: '6px 0' } }, icon(ICONS.info), h('div', null, `This site already has a policy${A.csp.issues.length ? ` (${A.csp.issues.slice(0, 2).join('; ')})` : ''}. Compare before replacing it.`)) : null,
          h('h3', { class: 'sub-h' }, 'Option 1 · Allowlist', h('span', { class: 'faint small', style: { fontWeight: 400 } }, '  easiest to adopt')),
          codeBlock(`Content-Security-Policy-Report-Only: ${C.allowlist}`, { copied: 'CSP copied', wrap: true }),
          h('h3', { class: 'sub-h' }, 'Option 2 · Strict', h('span', { class: 'faint small', style: { fontWeight: 400 } }, '  strongest, recommended by Google')),
          codeBlock(`Content-Security-Policy-Report-Only: ${C.strict}`, { copied: 'CSP copied', wrap: true }),
          h('ul', { class: 'bullets small', style: { marginTop: '8px' } }, C.notes.map((n) => h('li', { class: 'muted' }, n))),
          h('details', { class: 'more-details' }, h('summary', null, 'What each part allows'),
            h('dl', { class: 'secsum' }, C.directives.map((d) => [h('dt', { class: 'mono' }, d.name), h('dd', { class: 'mono' }, d.values.join(' ') || '(on)')])))
        ]));
      }
    }

    // Connection
    const hd = state.headers;
    frag.append(card('Connection', h('ul', { class: 'checklist' },
      h('li', null, h('span', { class: 'dot ' + (https ? 'good' : 'bad') }), h('div', null, h('div', { class: 't' }, 'HTTPS'), h('div', { class: 'd' }, say('Traffic between you and the site is encrypted', 'TLS transport'))), h('div', { class: 'state' }, https ? 'On' : 'Off')),
      h('li', null, h('span', { class: 'dot ' + (!https ? 'none' : sc.code.mixedContent.length ? 'warn' : 'good') }), h('div', null, h('div', { class: 't' }, say('Insecure files on a secure page', 'Mixed content')), h('div', { class: 'd' }, 'http:// files loaded by an https:// page')), h('div', { class: 'state' }, https ? String(sc.code.mixedContent.length) : 'n/a')),
      hd ? h('li', null, h('span', { class: 'dot none' }), h('div', null, h('div', { class: 't' }, 'Redirects'), h('div', { class: 'd' }, hd.redirected ? `Ended at ${hd.finalUrl}` : 'Address served directly')), h('div', { class: 'state' }, hd.redirected ? 'Yes' : 'No')) : null,
      h('li', null, h('span', { class: 'dot none' }), h('div', null, h('div', { class: 't' }, say('Certificate expiry', 'Certificate')), h('div', { class: 'd' }, 'Chrome does not share certificate details with extensions')), h('div', { class: 'state' }, 'Not available')))));

    // security.txt (opt-in)
    const st = state.securityTxt;
    frag.append(card(say('Can people report problems?', 'security.txt (RFC 9116)'), [
      !st ? [
        h('p', { class: 'muted' }, say(
          'Well-run sites publish a small security.txt file saying who to contact about security problems. Checking it takes one extra request, only when you click.',
          'Optional: one GET to /.well-known/security.txt without cookies. Not run automatically, to keep the default scan to what the browser already loaded.')),
        state.securityTxtStatus === 'no-access' ? h('p', { class: 'muted small' }, 'Chrome blocked the request. Use "Allow for this site" above, then try again.') : null,
        state.securityTxtStatus === 'error' ? h('p', { class: 'muted small' }, 'The request failed. Try again.') : null,
        h('button', { type: 'button', class: 'btn primary', disabled: state.securityTxtStatus === 'loading' ? true : null, onclick: checkSecurityTxt, style: { marginTop: '6px', padding: '6px 14px' } },
          state.securityTxtStatus === 'loading' ? 'Checking…' : 'Check security.txt')
      ] : st.found ? [
        kv([
          ['Contact', st.contact.length ? st.contact.join(', ') : h('span', { class: 'bad-text' }, 'missing')],
          ['Expires', st.expires ? `${st.expires}${st.expired ? ' (expired)' : ''}` : h('span', { class: 'bad-text' }, 'missing')],
          st.policy.length ? ['Policy', st.policy.join(', ')] : null,
          st.encryption.length ? ['Encryption key', st.encryption.join(', ')] : null,
          ['Signed', st.signed ? 'Yes (PGP)' : 'No']
        ]),
        st.problems.length ? h('ul', { class: 'bullets small', style: { marginTop: '6px' } }, st.problems.map((p) => h('li', null, p))) : okLine('Complete and valid.')
      ] : h('p', { class: 'muted' }, say('This site has no security.txt, so there is no official way to report a security problem.', `No file at /.well-known/security.txt (HTTP ${st.status || '—'}).`))
    ]));

    // Code exposure
    const code = sc.code;
    const sri = code.scripts.external.filter((x) => x.thirdParty);
    frag.append(card(say('Code on the page', 'Script exposure'), kv([
      [say('Outside scripts', 'External scripts'), `${code.scripts.external.length} (${sri.length} third-party, ${sri.filter((x) => x.integrity).length} with SRI)`],
      ['Inline scripts', `${code.scripts.inline} · ${fmtBytes(code.scripts.inlineBytes)}`],
      [say('Inline click code', 'Inline handlers'), String(code.inlineHandlers.count)],
      [say('Links opening new tabs unsafely', 'target=_blank w/o rel'), String(sc.interaction.links.blankNoOpener.length)],
      ['HTML comments', `${code.comments.count}${Object.keys(code.comments.keywords).length ? ' · mentions ' + Object.keys(code.comments.keywords).join(', ') : ''}`],
      [say('Forms sending data', 'Form targets'), sc.interaction.forms.length ? sc.interaction.forms.map((f) => `${f.method.toUpperCase()} ${f.actionHost || 'same page'}${f.actionScheme === 'http' ? ' (http!)' : ''}`).slice(0, 3).join(', ') : 'None']
    ])));

    return frag;
  }

  // ============================================================ github mode

  const GH = globalThis.PageLensGitHub;
  const GH_TABS = [
    { id: 'summary', label: 'Summary' },
    { id: 'setup', label: 'Setup' },
    { id: 'code', label: 'Code' },
    { id: 'trust', label: 'Trust' },
    { id: 'contribute', label: 'Contribute' }
  ];
  // Role switch only reorders the Summary blocks. Every role sees all of them.
  const GH_BLOCK_ORDER = {
    everyday: ['about', 'trust', 'quickstart', 'contribute', 'readfirst'],
    designer: ['about', 'trust', 'quickstart', 'readfirst', 'contribute'],
    developer: ['about', 'quickstart', 'readfirst', 'trust', 'contribute'],
    security: ['trust', 'about', 'quickstart', 'readfirst', 'contribute']
  };
  const LANG_COLORS = {
    JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572a5', Go: '#00add8', Rust: '#dea584', Java: '#b07219', C: '#555555',
    'C++': '#f34b7d', 'C#': '#178600', Ruby: '#701516', PHP: '#4f5d95', Shell: '#89e051', HTML: '#e34c26', CSS: '#563d7c', SCSS: '#c6538c',
    Swift: '#f05138', Kotlin: '#a97bff', Dart: '#00b4ab', Vue: '#41b883', Svelte: '#ff3e00', Cython: '#fedf5b', 'Jupyter Notebook': '#da5b0b',
    Dockerfile: '#384d54', Makefile: '#427819', Lua: '#000080', Elixir: '#6e4a7e', Haskell: '#5e5086', Scala: '#c22d40', 'Objective-C': '#438eff',
    R: '#198ce7', MDX: '#fcb32c', Astro: '#ff5a03', Nix: '#7e7eff', Zig: '#ec915c', Julia: '#a270ba', Perl: '#0298c3', Clojure: '#db5855'
  };
  const LANG_FALLBACK = ['#8b8b9e', '#a8a8b8', '#6c6c80', '#c4c4d0'];

  const gh = {
    status: 'idle', // idle | loading | ready | error
    target: null,
    report: null,
    raw: null,
    fromCache: false,
    stale: false,
    error: null,
    progress: '',
    extra: null, // optional Scorecard / OSV results
    translation: null // on-device translation of the summary
  };

  function safeHref(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
    } catch {
      return null;
    }
  }

  function extLink(label, url, cls = 'xlink') {
    const href = safeHref(url);
    if (!href) return h('span', null, label);
    return h('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer', title: href }, label);
  }

  function codeBlock(text, opts = {}) {
    return h('div', { class: 'code' + (opts.wrap ? ' wrap' : '') },
      h('pre', null, h('code', null, text)),
      h('button', { type: 'button', class: 'code-copy', title: 'Copy', 'aria-label': 'Copy commands', onclick: () => copy(text, opts.copied || 'Copied') }, 'Copy'));
  }

  const ghSay = say;
  const ghAgo = (days) => GH._internals.ago(days);
  const ghNum = (n) => GH._internals.human(n);

  const PLATFORM_NAMES = { github: 'GitHub', gitlab: 'GitLab', codeberg: 'Codeberg' };
  const platformName = (id) => PLATFORM_NAMES[id] || 'GitHub';
  const platformHost = (id) => ({ github: 'api.github.com', gitlab: 'gitlab.com', codeberg: 'codeberg.org' }[id] || 'api.github.com');

  function friendlyGhError(err, target) {
    const code = err && err.code;
    const name = platformName(target && target.platform);
    if (code === 'not-found') return { title: 'Repository not found', text: 'It may be private, renamed or misspelled. PageLens can only read public repositories.' };
    if (code === 'rate-limit') {
      const at = err.reset ? new Date(err.reset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
      return { title: `${name} limit reached`, text: (target && target.platform !== 'github' ? `${name}'s request limit is used up for now.` : `GitHub allows ${state.ghToken ? '5,000 lookups an hour with your token' : '60 free lookups an hour from your network (add a token in Settings for 5,000)'}, and they are used up.`) + (at ? ` Try again after ${at}.` : ' Try again later.') };
    }
    if (code === 'network') return { title: `Could not reach ${name}`, text: target && target.platform !== 'github' ? `Chrome may need your permission to read ${platformHost(target.platform)}'s public API.` : 'Check your connection and try again.', permission: Boolean(target && target.platform !== 'github') };
    if (code === 'blocked') return { title: 'Unavailable', text: err.message };
    return { title: `${name} lookup failed`, text: (err && err.message) || 'Something went wrong.' };
  }

  async function allowForge(target) {
    try {
      const ok = await chrome.permissions.request({ origins: [`https://${platformHost(target.platform)}/*`] });
      if (ok) loadRepo(target, { force: true });
      else toast('Permission not granted');
    } catch {
      toast('Permission request failed');
    }
  }

  async function loadRepo(target, { force = false } = {}) {
    if (!target) return;
    gh.status = 'loading';
    gh.target = target;
    gh.error = null;
    gh.extra = null;
    gh.translation = null;
    gh.progress = `Contacting ${platformName(target.platform)}…`;
    $('#rescan').classList.add('spin');
    if (state.mode === 'github') render();
    try {
      const res = await GH.load(target.owner, target.repo, {
        force,
        platform: target.platform || 'github',
        token: state.ghToken,
        onProgress: (msg) => {
          gh.progress = msg;
          const el = document.getElementById('gh-progress');
          if (el) el.textContent = msg;
        }
      });
      gh.raw = res.raw;
      gh.report = res.report;
      gh.fromCache = res.fromCache;
      gh.stale = res.stale;
      gh.error = res.error || null;
      gh.status = 'ready';
      gh.history = null;
      recordRepoHistory();
    } catch (err) {
      gh.status = 'error';
      gh.error = err;
    }
    $('#rescan').classList.remove('spin');
    if (state.mode === 'github') render();
  }

  function repoForm(compact = false) {
    const input = h('input', {
      type: 'text', class: 'repo-input', placeholder: 'owner/repo, or a GitHub, GitLab or Codeberg link', 'aria-label': 'Repository',
      spellcheck: 'false', autocomplete: 'off', value: compact ? '' : (gh.target ? (gh.target.platform && gh.target.platform !== 'github' ? `${gh.target.platform}:${gh.target.full}` : `${gh.target.owner}/${gh.target.repo}`) : '')
    });
    const form = h('form', { class: 'repo-form' + (compact ? ' compact' : '') }, input,
      h('button', { type: 'submit', class: 'btn primary' }, 'Analyze'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const t = globalThis.PageLensForges.parse(input.value);
      if (!t) { toast('Enter owner/repo or paste a repository link'); input.focus(); return; }
      state.ghView = 'summary';
      loadRepo(t);
    });
    return form;
  }

  function langBar(langs) {
    if (!langs.length) return null;
    const shown = langs.filter((l) => l.share >= 0.005).slice(0, 8);
    const color = (l, i) => LANG_COLORS[l.name] || LANG_FALLBACK[i % LANG_FALLBACK.length];
    return h('div', { class: 'langs' },
      h('div', { class: 'langbar', role: 'img', 'aria-label': shown.map((l) => `${l.name} ${pct(l.share)}`).join(', ') },
        shown.map((l, i) => h('i', { style: { background: color(l, i), flex: `${l.share} 1 0` }, title: `${l.name} ${pct(l.share)}` }))),
      h('div', { class: 'langlegend' }, shown.slice(0, 6).map((l, i) => h('span', null, h('i', { style: { background: color(l, i) } }), `${l.name} `, h('span', { class: 'faint' }, pct(l.share))))));
  }

  function ghFooter(rep) {
    const m = rep.meta;
    const bits = [];
    if (gh.fromCache) bits.push(`Saved copy from ${Math.max(0, Math.round((Date.now() - m.fetchedAt) / 60000))} min ago`);
    else bits.push(`${m.apiCalls} ${rep.repo.platformName || 'GitHub'} requests`);
    if (!gh.fromCache && m.rate && m.rate.remaining != null && (rep.repo.platform || 'github') === 'github') {
      const at = m.rate.reset ? new Date(m.rate.reset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
      bits.push(`${m.rate.remaining} of ${m.rate.limit || 60} left this hour${at ? ` (resets ${at})` : ''}`);
    }
    if (m.partial.length) bits.push(`couldn't read: ${m.partial.join(', ')}`);
    return h('div', { class: 'faint small', style: { textAlign: 'center' } }, bits.join(' · '));
  }

  // ------------------------------------------------------------ summary tab

  function googleTranslateUrl(rep) {
    return `https://translate.google.com/translate?sl=${encodeURIComponent(rep.language.code)}&tl=en&u=${encodeURIComponent(rep.repo.url)}`;
  }

  /** Translate the summary with Chrome's built-in, on-device Translator (Chrome 138+). */
  async function translateSummary(rep) {
    const code = rep.language.code;
    const set = (v) => { gh.translation = { for: rep.repo.fullName, ...v }; rerenderKeepingScroll(); };
    if (!('Translator' in self)) { set({ status: 'unsupported' }); return; }
    try {
      const avail = await self.Translator.availability({ sourceLanguage: code, targetLanguage: 'en' });
      if (avail === 'unavailable') { set({ status: 'unsupported' }); return; }
      set({ status: 'loading', progress: avail === 'available' ? null : 0 });
      const translator = await self.Translator.create({
        sourceLanguage: code,
        targetLanguage: 'en',
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            const el = document.getElementById('tr-progress');
            if (el) el.textContent = `Downloading the ${rep.language.name} language pack… ${Math.round(e.loaded * 100)}%`;
          });
        }
      });
      const sm = rep.summary;
      const tx = async (x) => (x ? translator.translate(x) : x);
      const text = { oneLine: await tx(sm.oneLine), paragraph: await tx(sm.paragraph), features: [], sections: [] };
      for (const f of sm.features) text.features.push(await tx(f));
      for (const sec of sm.sections) text.sections.push({ ...sec, heading: await tx(sec.heading), text: await tx(sec.text) });
      set({ status: 'done', text, showOriginal: false });
    } catch (err) {
      set({ status: 'error', message: String(err && err.message || err) });
    }
  }

  function translateBar(rep, tr) {
    const gtl = extLink('Open in Google Translate ↗', googleTranslateUrl(rep), 'chip');
    let body;
    if (!tr) {
      body = [h('span', null, `The README is written in ${rep.language.name}.`),
        h('div', { class: 'btn-row', style: { marginTop: '6px' } },
          h('button', { type: 'button', class: 'btn primary', onclick: () => translateSummary(rep) }, 'Translate to English'), gtl)];
    } else if (tr.status === 'loading') {
      body = [h('span', { id: 'tr-progress' }, 'Translating on your device… (the first time, Chrome downloads a small language pack)'), h('div', { style: { marginTop: '6px' } }, gtl)];
    } else if (tr.status === 'done') {
      body = [h('span', null, tr.showOriginal ? `Showing the original ${rep.language.name}.` : `Translated from ${rep.language.name} on your device by Chrome.`),
        h('button', { type: 'button', class: 'linkbtn', onclick: () => { tr.showOriginal = !tr.showOriginal; rerenderKeepingScroll(); } }, tr.showOriginal ? 'Show English' : 'Show original')];
    } else {
      body = [h('span', null, tr.status === 'unsupported'
        ? 'This Chrome cannot translate on-device (needs Chrome 138+ on desktop).'
        : `Translation failed: ${tr.message}`), h('div', { style: { marginTop: '6px' } }, gtl)];
    }
    return h('div', { class: 'notice', style: { marginBottom: '8px' } }, icon(ICONS.info), h('div', { style: { flex: '1', minWidth: 0 } }, body));
  }

  const GH_BLOCKS = {
    about(rep) {
      const orig = rep.summary;
      const tr = gh.translation && gh.translation.for === rep.repo.fullName ? gh.translation : null;
      const showTr = tr && tr.status === 'done' && !tr.showOriginal;
      const sm = showTr ? { ...orig, ...tr.text } : orig;
      return card(ghSay('What is it?', 'Summary'), [
        rep.language ? translateBar(rep, tr) : null,
        h('p', { class: 'oneline' }, sm.oneLine),
        h('p', { class: 'muted' }, sm.paragraph),
        langBar(rep.languages),
        sm.features.length ? [h('h3', { class: 'sub-h' }, 'Highlights'), h('ul', { class: 'bullets' }, sm.features.map((f) => h('li', null, f)))] : null,
        sm.sections.length ? h('details', { class: 'more-details', open: state.role === 'developer' ? true : null },
          h('summary', null, `Full summary (${sm.sections.length} README sections)`),
          h('dl', { class: 'secsum' }, sm.sections.map((x) => [h('dt', null, x.heading), h('dd', null, x.text)]))) : null,
        !sm.readmeFound ? h('div', { class: 'sub' }, 'This repository has no README, so the summary comes from its description and files.') : null
      ]);
    },

    trust(rep) {
      const t = rep.trust;
      return card(ghSay('Can I rely on it?', 'Trust'), [
        h('div', { class: `trust t-${t.verdict.cls}` }, h('span', { class: `dot ${t.verdict.cls}` }),
          h('div', null, h('div', { class: 't' }, t.verdict.label), h('div', { class: 'd' }, t.verdict.text)),
          h('span', { class: 'trust-score' }, `${t.score}/100`)),
        sinceLine(gh.history),
        t.risks.filter((x) => x.level !== 'info').length
          ? h('ul', { class: 'checklist' }, t.risks.filter((x) => x.level !== 'info').slice(0, 3).map((x) => h('li', null, h('span', { class: `dot ${RISK_DOT[x.level]}` }), h('div', { class: 't' }, x.text), h('span', { class: `tag risk-${x.level}` }, x.level))))
          : null,
        h('ul', { class: 'checklist' }, t.reasons.filter((x) => x.ok).slice(0, 4).map((x) => h('li', null, h('span', { class: 'dot good' }), h('div', { class: 't' }, x.text), h('span'))))
      ], { meta: 'Trust tab has detail' });
    },

    quickstart(rep) {
      const st = rep.setup;
      const first = st.detected.find((d) => /install the command|use it in your project/i.test(d.title)) || st.readme[0] || st.detected[0];
      if (!first) return card(ghSay('How do I use it?', 'Quick start'), h('p', { class: 'muted' }, 'No install steps were found in the README or project files.'));
      const title = first.title || first.heading;
      return card(ghSay('How do I use it?', 'Quick start'), [
        h('div', { class: 'small muted', style: { marginBottom: '6px' } }, title),
        codeBlock(first.commands[0]),
        h('button', { type: 'button', class: 'btn more-btn', onclick: () => { state.ghView = 'setup'; render(); } }, 'Full setup guide')
      ]);
    },

    readfirst(rep) {
      const rf = rep.map.readFirst;
      if (!rf.length) return null;
      return card(ghSay('Where to start reading', 'Files to read first'), [
        h('ol', { class: 'readlist' }, rf.slice(0, 4).map((f) => h('li', null, extLink(f.path, f.url, 'xlink mono'), h('span', { class: 'faint small' }, f.reason)))),
        rf.length > 4 ? h('button', { type: 'button', class: 'btn more-btn', onclick: () => { state.ghView = 'code'; render(); } }, `All ${rf.length} files and the folder map`) : null
      ]);
    },

    contribute(rep) {
      const c = rep.contribute;
      if (!c.openToContrib) return null;
      return card(ghSay('Want to help?', 'Contributing'), [
        h('p', { class: 'muted' }, c.goodFirst.length
          ? `${plural(c.goodFirst.length, 'beginner-friendly issue')} open right now${c.docs.contributing ? ', and a contributing guide explains the rules' : ''}.`
          : `No issues are labelled for beginners right now${c.docs.contributing ? ', but there is a contributing guide' : ''}.`),
        h('button', { type: 'button', class: 'btn more-btn', onclick: () => { state.ghView = 'contribute'; render(); } }, 'How to contribute')
      ]);
    }
  };

  function ghHeader(rep) {
    const r = rep.repo;
    const t = rep.trust;
    return h('section', { class: 'card repo-head' },
      h('div', { class: 'repo-title' },
        icon(r.platform && r.platform !== 'github' ? ICONS.repo : ICONS.github),
        h('div', { style: { minWidth: 0 } },
          extLink(r.fullName, r.url, 'repo-name'),
          h('div', { class: 'faint small' }, [r.platform && r.platform !== 'github' ? r.platformName : null, rep.kind.label, rep.languages[0] ? rep.languages[0].name : null, t.license.short ? `${t.license.short} license` : 'no license'].filter(Boolean).join(' · ')))),
      h('div', { class: 'chips' },
        chip('★', ghNum(r.stars)), chip('Forks', ghNum(r.forks)), t.lastCommit.days != null ? chip('Updated', ghAgo(t.lastCommit.days)) : null,
        r.archived ? chip('Archived', null, { accent: true }) : null, r.fork ? chip('Fork', null) : null,
        r.homepage && safeHref(r.homepage) ? h('a', { class: 'chip', href: safeHref(r.homepage), target: '_blank', rel: 'noopener noreferrer' }, h('b', null, 'Website ↗')) : null),
      r.topics.length ? h('div', { class: 'chips', style: { marginTop: '6px' } }, r.topics.slice(0, 8).map((x) => h('span', { class: 'chip accent' }, x))) : null,
      r.renamed ? h('div', { class: 'sub' }, `Now known as ${r.fullName}.`) : null);
  }

  function renderGhSummary(rep) {
    const frag = document.createDocumentFragment();
    if (gh.stale) frag.append(notice(`${rep.repo.platformName || 'GitHub'}'s limit is used up or it could not be reached, so this is a saved copy from ${Math.round((Date.now() - rep.meta.fetchedAt) / 60000)} min ago.`));
    frag.append(ghHeader(rep));
    for (const id of GH_BLOCK_ORDER[state.role]) {
      const b = GH_BLOCKS[id](rep);
      if (b) frag.append(b);
    }
    frag.append(card('Analyze another repository', repoForm(true)));
    return frag;
  }

  // ------------------------------------------------------------ setup tab

  function renderGhSetup(rep) {
    const st = rep.setup;
    const frag = document.createDocumentFragment();
    frag.append(notice(ghSay(
      'These commands come from the project itself. Read them before you run anything on your computer.',
      'Commands are copied from the README and derived from manifests. Review before running; nothing is executed by PageLens.')));
    if (st.prereqs.length) {
      frag.append(card(ghSay('You will need', 'Prerequisites'), h('ul', { class: 'checklist' }, st.prereqs.map((p) =>
        h('li', null, h('span', { class: 'dot none' }), h('div', null, h('div', { class: 't' }, p.name), h('div', { class: 'd' }, `from ${p.source}`)), h('div', { class: 'state' }, p.value))))));
    }
    if (st.readme.length) {
      frag.append(card(ghSay('Steps from the README', 'README instructions'), st.readme.map((x) => h('div', { class: 'setup-step' },
        h('h3', { class: 'sub-h' }, x.heading), x.note ? h('p', { class: 'muted small' }, x.note) : null, x.commands.map((c) => codeBlock(c))))));
    }
    if (st.detected.length) {
      frag.append(card(ghSay('Worked out from the project files', 'Derived from manifests'), st.detected.map((d) => h('div', { class: 'setup-step' },
        h('h3', { class: 'sub-h' }, d.title, h('span', { class: 'faint small', style: { fontWeight: 400 } }, `  · ${d.source}`)),
        d.note ? h('p', { class: 'muted small' }, d.note) : null,
        d.commands.map((c) => codeBlock(c)),
        d.scripts && d.scripts.length ? h('div', { class: 'chips', style: { marginTop: '6px' } }, h('span', { class: 'faint small' }, 'All commands:'), d.scripts.map((x) => h('span', { class: 'chip' }, x))) : null))));
    }
    if (st.examples.length) {
      frag.append(card(ghSay('Example from the README', 'Usage examples'), st.examples.map((x) => h('div', { class: 'setup-step' },
        h('h3', { class: 'sub-h' }, x.heading, x.lang ? h('span', { class: 'faint small', style: { fontWeight: 400 } }, `  · ${x.lang}`) : null), codeBlock(x.code)))));
    }
    if (st.notes.length) frag.append(card('Notes', h('ul', { class: 'bullets' }, st.notes.map((n) => h('li', null, n)))));
    return frag;
  }

  // ------------------------------------------------------------ code tab

  function renderGhCode(rep) {
    const m = rep.map;
    const frag = document.createDocumentFragment();
    if (!m.hasTree) {
      frag.append(empty('No file list', rep.repo.empty ? 'This repository is empty.' : `${rep.repo.platformName || 'GitHub'} did not return the file list for this repository.`, ICONS.info));
      return frag;
    }
    frag.append(card(ghSay('Size and languages', 'Overview'), [
      h('div', { class: 'stats' },
        stat('Files', m.totals.files.toLocaleString()), stat('Size', fmtBytes(m.totals.bytes)), stat('Folders', m.totals.dirs.toLocaleString()),
        stat('Test files', m.tests.count.toLocaleString(), m.totals.files ? pct(m.tests.share) : null)),
      h('div', { style: { marginTop: '10px' } }, langBar(rep.languages)),
      rep.stack.length ? [h('h3', { class: 'sub-h' }, ghSay('Built with', 'Detected stack')), h('div', { class: 'chips' }, rep.stack.map((x) => chip(x.name, null, { title: `${x.category} · from ${x.evidence}` })))] : null,
      m.truncated || m.trimmed ? h('div', { class: 'sub' }, `Very large repository: ${rep.repo.platformName || 'GitHub'} returned only part of the file list, so counts are approximate.`) : null
    ]));
    if (m.readFirst.length) {
      frag.append(card(ghSay('Read these first', 'Files to read first'), h('ol', { class: 'readlist' }, m.readFirst.map((f) =>
        h('li', null, extLink(f.path, f.url, 'xlink mono'), h('span', { class: 'faint small' }, f.reason))))));
    }
    frag.append(card(ghSay('What is in each folder', 'Folder map'), [
      m.top.length ? h('div', { class: 'folders' }, m.top.map((d) => h('div', { class: 'folder' },
        h('div', { class: 'folder-h' }, extLink(d.name + '/', d.url, 'xlink mono'), h('span', { class: 'faint small' }, `${plural(d.files, 'file')} · ${fmtBytes(d.bytes)}`)),
        d.desc ? h('div', { class: 'small muted' }, d.desc) : null,
        d.children.length ? h('div', { class: 'folder-kids mono' }, d.children.join('/  ') + '/' + (d.more ? `  +${d.more}` : '')) : null)))
        : h('p', { class: 'muted' }, 'Everything sits in the top folder.'),
      m.rootFiles.length ? [h('h3', { class: 'sub-h' }, 'Top-level files'), h('div', { class: 'chips' }, m.rootFiles.slice(0, 24).map((f) => h('a', { class: 'chip', href: f.url, target: '_blank', rel: 'noopener noreferrer' }, h('span', { class: 'v' }, f.name))))] : null
    ], { meta: `${m.top.length} folders` }));
    if (m.largest.length && state.role !== 'everyday') {
      frag.append(card('Largest files', table([
        { label: 'File', width: '78%', get: (r) => r.path },
        { label: 'Size', width: '22%', num: true, get: (r) => fmtBytes(r.bytes) }
      ], m.largest)));
    }
    return frag;
  }

  // ------------------------------------------------------------ trust tab

  const PART_LABEL = {
    activity: ['Recent activity', 'Activity'], releases: ['Releases', 'Releases'], contributors: ['People involved', 'Contributors'],
    license: ['License', 'License'], community: ['Answers issues & PRs', 'Community response'], security: ['Security habits', 'Security practices'],
    engineering: ['Tests & CI', 'Engineering']
  };
  const RISK_DOT = { high: 'bad', medium: 'warn', low: 'none', info: 'none' };

  function sparkline(weeks) {
    const W = 380;
    const H = 44;
    const max = Math.max(1, ...weeks);
    const bw = W / weeks.length;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H + 12}`, class: 'spark', role: 'img', 'aria-label': `Commits per week for the last ${weeks.length} weeks, peak ${max}` });
    weeks.forEach((v, i) => {
      const hgt = v ? Math.max(2, (v / max) * H) : 1;
      svg.append(s('rect', { x: (i * bw + 0.5).toFixed(1), y: (H - hgt).toFixed(1), width: Math.max(1, bw - 1.5).toFixed(1), height: hgt.toFixed(1), rx: 1, class: v ? 'bar-on' : 'bar-off' },
        s('title', null, `${v} commit${v === 1 ? '' : 's'}, ${weeks.length - i} week${weeks.length - i === 1 ? '' : 's'} ago`)));
    });
    svg.append(s('text', { x: 0, y: H + 11, class: 'spark-l' }, '1 year ago'), s('text', { x: W, y: H + 11, 'text-anchor': 'end', class: 'spark-l' }, 'this week'));
    return svg;
  }

  async function runExternalChecks(rep) {
    const X = globalThis.PageLensGitHubExtra;
    gh.extra = { status: 'loading', for: rep.repo.fullName };
    rerenderKeepingScroll();
    try {
      const ok = await chrome.permissions.request({ origins: X.ORIGINS });
      if (!ok) { gh.extra = { status: 'denied', for: rep.repo.fullName }; rerenderKeepingScroll(); return; }
      const [sc, osv] = await Promise.allSettled([X.fetchScorecard(rep.repo.fullName, undefined, rep.repo.host), X.fetchOsv(rep.packages)]);
      gh.extra = {
        status: 'done', for: rep.repo.fullName,
        scorecard: sc.status === 'fulfilled' ? sc.value : { error: String(sc.reason && sc.reason.message || sc.reason) },
        osv: osv.status === 'fulfilled' ? osv.value : { error: String(osv.reason && osv.reason.message || osv.reason) }
      };
    } catch (err) {
      gh.extra = { status: 'error', for: rep.repo.fullName, error: String(err && err.message || err) };
    }
    rerenderKeepingScroll();
  }

  function renderExternal(rep) {
    const x = gh.extra && gh.extra.for === rep.repo.fullName ? gh.extra : null;
    if (!x || x.status === 'denied' || x.status === 'error') {
      return [
        h('p', { class: 'muted small' }, ghSay(
          'Ask two free, independent security databases about this project: OpenSSF Scorecard (how safely it is built) and OSV (known vulnerabilities in its packages).',
          `Queries api.scorecard.dev for ${rep.repo.fullName} and api.osv.dev for ${plural(rep.packages.length, 'pinned package')}. Sends only these names; needs a one-time Chrome permission.`)),
        x && x.status === 'denied' ? h('p', { class: 'muted small' }, 'Permission was not given, so nothing was sent.') : null,
        x && x.status === 'error' ? h('p', { class: 'muted small' }, `Check failed: ${x.error}`) : null,
        h('button', { type: 'button', class: 'btn primary', style: { padding: '6px 14px' }, onclick: () => runExternalChecks(rep) }, 'Check security databases')
      ];
    }
    if (x.status === 'loading') return h('p', { class: 'muted' }, 'Asking OpenSSF Scorecard and OSV…');
    const sc = x.scorecard;
    const osv = x.osv;
    return [
      h('h3', { class: 'sub-h' }, 'OpenSSF Scorecard'),
      sc.error ? h('p', { class: 'muted small' }, `Unavailable: ${sc.error}`)
        : !sc.found ? h('p', { class: 'muted small' }, 'This repository has not been scanned by Scorecard yet (it covers about a million popular projects).')
          : [
            h('div', { class: 'kvline' }, h('b', { class: `sc-score s-${sc.score >= 7 ? 'good' : sc.score >= 5 ? 'warn' : 'bad'}` }, `${sc.score}/10`), h('span', { class: 'faint small' }, `scanned ${sc.date || ''}`)),
            h('ul', { class: 'checklist' }, sc.checks.slice(0, ghSay(8, 20)).map((c) => h('li', null,
              h('span', { class: `dot ${c.score < 0 ? 'none' : c.score >= 7 ? 'good' : c.score >= 4 ? 'warn' : 'bad'}` }),
              h('div', { style: { minWidth: 0 } }, c.url ? extLink(c.name, c.url) : h('div', { class: 't' }, c.name), h('div', { class: 'd' }, c.reason)),
              h('div', { class: 'state' }, c.score < 0 ? 'n/a' : `${c.score}/10`))))
          ],
      h('h3', { class: 'sub-h' }, 'Known vulnerabilities (OSV)'),
      osv.error ? h('p', { class: 'muted small' }, `Unavailable: ${osv.error}`)
        : !osv.checked ? h('p', { class: 'muted small' }, 'No exact package versions to check (only pinned versions like ==1.2.3 can be looked up).')
          : osv.results.length ? h('ul', { class: 'checklist' }, osv.results.map((r) => h('li', null, h('span', { class: 'dot bad' }),
            h('div', { style: { minWidth: 0 } }, h('div', { class: 't mono' }, `${r.name} ${r.version}`), h('div', { class: 'd' }, `${r.ecosystem} · from ${r.source}`),
              h('div', { class: 'chips', style: { marginTop: '4px' } }, r.vulns.slice(0, 6).map((id) => extLink(id, `https://osv.dev/vulnerability/${encodeURIComponent(id)}`, 'chip')))),
            h('div', { class: 'state' }, plural(r.vulns.length, 'issue')))))
            : okLine(`No known vulnerabilities in ${plural(osv.checked, 'checked package')}.`)
    ];
  }

  function renderGhTrust(rep) {
    const t = rep.trust;
    const frag = document.createDocumentFragment();

    // Verdict + breakdown
    frag.append(card(ghSay('Can I rely on it?', 'Project health'), [
      h('div', { class: 'verdict' }, ring(t.score),
        h('div', null,
          h('div', { class: `grade g-${t.verdict.cls === 'good' ? 'good' : t.verdict.cls === 'warn' ? 'warn' : 'bad'}` }, t.verdict.label),
          h('p', { class: 'muted' }, t.verdict.text),
          t.capped ? h('p', { class: 'faint small' }, `Held at 74 because of a high risk (would be ${t.uncapped}).`) : null)),
      h('h3', { class: 'sub-h' }, ghSay('Where the points come from', 'Score breakdown')),
      h('div', { class: 'barrows breakdown' }, Object.keys(t.partMax).map((k) => {
        const v = t.parts[k];
        const max = t.partMax[k];
        const ratio = v / max;
        return h('div', { class: 'barrow' },
          h('span', null, PART_LABEL[k][state.role === 'everyday' ? 0 : 1]),
          h('div', { class: `bar s-${ratio >= 0.8 ? 'good' : ratio >= 0.5 ? 'ok' : ratio >= 0.3 ? 'warn' : 'bad'}` }, h('i', { style: { width: `${Math.max(2, ratio * 100)}%` } })),
          h('span', { class: 'v' }, `${v}/${max}`));
      }))
    ]));

    // Risks
    frag.append(card(ghSay('Things to watch out for', 'Risks'), t.risks.length
      ? h('ul', { class: 'checklist' }, t.risks.map((x) => h('li', null, h('span', { class: `dot ${RISK_DOT[x.level]}` }),
        h('div', { style: { minWidth: 0 } }, h('div', { class: 't' }, x.text), x.detail ? h('div', { class: 'd' }, x.detail) : null),
        h('span', { class: `tag risk-${x.level}` }, x.level === 'info' ? 'note' : x.level))))
      : okLine('No notable risks found.'), { meta: t.risks.length ? String(t.risks.length) : null }));

    // Activity
    const lc = t.lastCommit;
    const ca = t.commitActivity;
    const TREND = { up: 'picking up', down: 'slowing down', steady: 'steady', none: 'no commits' };
    frag.append(card(ghSay('Is anyone working on it?', 'Activity'), [
      ca.weeks.length ? [sparkline(ca.weeks), h('div', { class: 'sub', style: { marginTop: '2px', marginBottom: '8px' } },
        `${plural(ca.total, 'commit')} in the last year · active in ${ca.activeWeeks} of ${ca.weeks.length} weeks${ca.trend ? ` · last 3 months ${TREND[ca.trend]} (${ca.last13} vs ${ca.prev13})` : ''}`)]
        : h('p', { class: 'faint small' }, ca.status === 'computing' ? 'GitHub is still calculating the weekly chart for this repository. Refresh in a minute to see it.' : 'Weekly commit chart unavailable.'),
      kv([
        ['Status', h('span', null, h('span', { class: `dot ${t.activity.cls}`, style: { marginRight: '6px' } }), t.activity.label)],
        ['Last change', lc.days != null ? `${ghAgo(lc.days)}${lc.author ? ` by ${lc.author}` : ''}` : null],
        lc.message ? ['Latest commit', h('span', { class: 'mono' }, lc.message)] : null,
        ['Started', t.age.days != null ? ghAgo(t.age.days) : null]
      ])
    ]));

    // Community: issues + pull requests
    const is = t.issues;
    const pr = t.pulls;
    frag.append(card(ghSay('Do they answer and accept help?', 'Community response'), [
      h('div', { class: 'stats' },
        stat(ghSay('Issues answered', 'Issue response'), is.available && is.responseRate != null ? pct(is.responseRate) : '—', is.available ? `${is.sample} recent` : is.disabled ? 'issues off' : null),
        stat(ghSay('Time to close', 'Median close'), is.available && is.medianCloseDays != null ? (is.medianCloseDays < 1 ? '<1 day' : plural(Math.round(is.medianCloseDays), 'day')) : '—'),
        stat(ghSay('PRs merged', 'PR merge rate'), pr.available && pr.mergeRate != null ? pct(pr.mergeRate) : '—', pr.available ? `${pr.sample} recent` : null),
        stat(ghSay('Time to merge', 'Median merge'), pr.available && pr.medianMergeDays != null ? (pr.medianMergeDays < 1 ? '<1 day' : plural(Math.round(pr.medianMergeDays), 'day')) : '—')),
      pr.available && pr.outside ? h('div', { class: 'sub' }, ghSay(
        `Newcomers' pull requests: ${pr.outsideMerged} of ${pr.outside} merged.`,
        `Outside contributors: ${pr.outsideMerged}/${pr.outside} merged (${pct(pr.outsideMergeRate)}). Bots excluded (${pr.bots}).`)) : null,
      is.available && is.unanswered ? h('div', { class: 'sub' }, `${plural(is.unanswered, 'open issue')} older than two weeks with no reply.`) : null
    ]));

    // Contributors
    const ct = t.contributors;
    frag.append(card('Contributors', [
      kv([
        ['People', ct.label],
        ct.topShare != null ? [ghSay('Depends on one person?', 'Top contributor share'), `${Math.round(ct.topShare * 100)}% of commits by ${ct.top[0] ? ct.top[0].login : 'one person'}`] : null
      ]),
      ct.top.length ? h('div', { class: 'barrows', style: { marginTop: '8px' } }, ct.top.map((x) => h('div', { class: 'barrow' },
        h('span', { class: 'mono', title: x.login, style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, x.login),
        h('div', { class: 'bar' }, h('i', { style: { width: `${Math.max(2, x.share * 100)}%` } })),
        h('span', { class: 'v' }, pct(x.share))))) : null
    ]));

    // Security
    const sec = t.security;
    const wf = sec.workflows;
    frag.append(card(ghSay('Is it built safely?', 'Security'), [
      h('ul', { class: 'checklist' },
        h('li', null, h('span', { class: `dot ${sec.policy ? 'good' : 'none'}` }), h('div', null, h('div', { class: 't' }, sec.policy ? extLink('Security policy', sec.policy.url) : 'Security policy'), h('div', { class: 'd' }, 'How to report a vulnerability privately')), h('div', { class: 'state' }, sec.policy ? 'Yes' : 'No')),
        h('li', null, h('span', { class: `dot ${sec.depsBot ? 'good' : 'none'}` }), h('div', null, h('div', { class: 't' }, 'Automatic dependency updates'), h('div', { class: 'd' }, sec.depsBot ? sec.depsBot.tool : 'Dependabot or Renovate')), h('div', { class: 'state' }, sec.depsBot ? 'Yes' : 'No')),
        h('li', null, h('span', { class: `dot ${sec.sast ? 'good' : 'none'}` }), h('div', null, h('div', { class: 't' }, ghSay('Automatic code scanning', 'Static analysis (SAST)')), h('div', { class: 'd' }, 'CodeQL, Semgrep, Snyk, Trivy… in CI')), h('div', { class: 'state' }, sec.sast ? 'Yes' : 'No')),
        wf.count ? h('li', null, h('span', { class: `dot ${wf.withPermissions === wf.count ? 'good' : 'warn'}` }), h('div', null, h('div', { class: 't' }, ghSay('CI permissions limited', 'Token permissions set')), h('div', { class: 'd' }, '"permissions:" block in each workflow')), h('div', { class: 'state' }, `${wf.withPermissions}/${wf.count}`)) : null,
        wf.actions ? h('li', null, h('span', { class: `dot ${wf.pinnedShare >= 0.5 ? 'good' : 'warn'}` }), h('div', { style: { minWidth: 0 } }, h('div', { class: 't' }, ghSay('CI actions pinned', 'Pinned actions (SHA)')), h('div', { class: 'd' }, wf.unpinned.length ? `Not pinned: ${wf.unpinned.slice(0, 4).join(', ')}${wf.unpinned.length > 4 ? '…' : ''}` : 'All actions pinned to a commit')), h('div', { class: 'state' }, `${wf.pinned}/${wf.actions}`)) : null,
        h('li', null, h('span', { class: `dot ${wf.dangerous.length ? 'bad' : wf.count ? 'good' : 'none'}` }), h('div', null, h('div', { class: 't' }, wf.dangerous.length ? ghSay('Risky CI patterns found', 'Dangerous workflows') : ghSay('No risky CI patterns', 'Dangerous workflows')), h('div', { class: 'd' }, wf.dangerous.length ? wf.dangerous.map((d) => d.text).join(' · ') : wf.count ? `${plural(wf.count, 'workflow')} checked` : 'No CI workflows')), h('div', { class: 'state' }, wf.dangerous.length ? String(wf.dangerous.length) : wf.count ? 'None' : 'n/a')),
        h('li', null, h('span', { class: `dot ${sec.binaries.count ? 'warn' : 'good'}` }), h('div', null, h('div', { class: 't' }, ghSay('No hidden compiled files', 'Binary artifacts')), h('div', { class: 'd' }, sec.binaries.count ? sec.binaries.sample.slice(0, 3).join(', ') : '.exe, .dll, .jar, .so… in the repo')), h('div', { class: 'state' }, String(sec.binaries.count)))),
      sec.advisories ? [
        h('h3', { class: 'sub-h' }, ghSay('Past security problems it reported', 'Published security advisories'), h('span', { class: 'faint small', style: { fontWeight: 400 } }, `  ${sec.advisories.count}${sec.advisories.more ? '+' : ''}`)),
        sec.advisories.count
          ? h('ul', { class: 'checklist' }, sec.advisories.list.map((a) => h('li', null, h('span', { class: `dot ${a.severity === 'critical' || a.severity === 'high' ? 'bad' : 'warn'}` }),
            h('div', { style: { minWidth: 0 } }, a.url ? extLink(a.summary || a.ghsa, a.url) : h('div', { class: 't' }, a.summary || a.ghsa), h('div', { class: 'd' }, [a.ghsa, a.cve, a.published ? a.published.slice(0, 10) : null].filter(Boolean).join(' · '))),
            h('div', { class: 'state' }, a.severity || ''))))
          : h('p', { class: 'muted small' }, 'None published. (Publishing advisories is a good sign: it means problems are disclosed openly.)')
      ] : null,
      h('h3', { class: 'sub-h' }, ghSay('Independent checks', 'External databases (optional)')),
      renderExternal(rep)
    ]));

    // Releases
    const rl = t.releases;
    frag.append(card('Releases', rl.available ? (rl.total ? kv([
      ['Latest', rl.latest ? `${rl.latest.tag} · ${ghAgo(rl.latest.days)}${rl.latest.prerelease ? ' (pre-release)' : ''}` : null],
      ['Last 12 months', plural(rl.lastYear, 'release')],
      ['Typical gap', rl.medianIntervalDays != null ? `about every ${rl.medianIntervalDays < 14 ? plural(rl.medianIntervalDays, 'day') : rl.medianIntervalDays < 60 ? plural(Math.round(rl.medianIntervalDays / 7), 'week') : plural(Math.round(rl.medianIntervalDays / 30), 'month')}` : null],
      ['Total', rl.more ? '30+' : String(rl.total)]
    ]) : h('p', { class: 'muted' }, `No releases on ${rep.repo.platformName || 'GitHub'}. The project may publish versions elsewhere (npm, PyPI) or not version at all.`))
      : h('p', { class: 'muted' }, 'Could not read releases.')));

    // License
    frag.append(card('License', [
      h('div', { class: 't', style: { fontWeight: 600, marginBottom: '4px' } }, t.license.name || 'None'),
      h('p', { class: 'muted' }, t.license.plain)
    ], { meta: t.license.kind }));

    // Hygiene & popularity
    const f = t.flags;
    const p = t.popularity;
    frag.append(card(ghSay('Good habits', 'Hygiene & popularity'), [
      h('ul', { class: 'checklist' }, [
        [f.ci, 'Automated checks (CI)'], [f.tests, 'Tests'], [f.coc, 'Code of conduct'], [f.contributing, 'Contributing guide']
      ].map(([ok, label]) => h('li', null, h('span', { class: `dot ${ok ? 'good' : 'none'}` }), h('div', { class: 't' }, label), h('div', { class: 'state' }, ok ? 'Yes' : 'No')))),
      h('div', { class: 'stats', style: { marginTop: '10px' } }, stat('Stars', ghNum(p.stars)), stat('Forks', ghNum(p.forks)), stat('Watchers', ghNum(p.watchers)), stat(ghSay('Open items', 'Open issues+PRs'), ghNum(p.openIssues)))
    ]));
    return frag;
  }

  // ------------------------------------------------------------ contribute tab

  function renderGhContribute(rep) {
    const c = rep.contribute;
    const frag = document.createDocumentFragment();
    if (!c.openToContrib) frag.append(notice(rep.repo.archived ? 'This repository is archived, so it does not accept changes any more.' : 'Issues are turned off for this repository.'));

    frag.append(card(ghSay('Good first issues', 'Good first issues'), [
      c.goodFirst.length ? h('ul', { class: 'gfi' }, c.goodFirst.map((i) => h('li', null,
        h('a', { href: i.url, target: '_blank', rel: 'noopener noreferrer', class: 'gfi-t' }, h('span', { class: 'faint' }, `#${i.number} `), i.title),
        h('div', { class: 'gfi-m' },
          i.labels.map((l) => h('span', { class: 'tag effort-quick' }, l)),
          h('span', { class: 'faint small' }, `${ghAgo(i.days)} · ${plural(i.comments, 'comment')}`),
          i.assigned ? h('span', { class: 'tag' }, 'someone assigned') : null))))
        : h('p', { class: 'muted' }, 'No issues are labelled for newcomers right now.'),
      h('div', { class: 'chips', style: { marginTop: '8px' } }, extLink('All good first issues ↗', c.gfiUrl, 'chip'), extLink('All issues ↗', c.issuesUrl, 'chip'))
    ], { meta: c.goodFirst.length ? String(c.goodFirst.length) : null }));

    if (c.requirements.length) {
      frag.append(card(ghSay('Rules to follow', 'Requirements'), h('ul', { class: 'bullets' }, c.requirements.map((x) => h('li', null, x)))));
    }

    frag.append(card(ghSay('How to send your first change', 'Contribution steps'), h('ol', { class: 'steps' }, c.steps.map((st) => h('li', null,
      h('div', { class: 't' }, st.title), st.text ? h('div', { class: 'muted small' }, st.text) : null, st.command ? codeBlock(st.command) : null)))));

    const d = c.docs;
    frag.append(card(ghSay('Project guides', 'Community files'), [
      h('ul', { class: 'checklist' }, [
        ['Contributing guide', d.contributing], ['Code of conduct', d.coc],
        ['Issue templates', d.issueTemplates], ['Pull request template', d.prTemplate], ['Discussions forum', d.discussions]
      ].map(([label, v]) => h('li', null, h('span', { class: `dot ${v ? 'good' : 'none'}` }),
        h('div', { class: 't' }, v && v.url ? extLink(label, v.url) : label), h('div', { class: 'state' }, v ? 'Yes' : 'No')))),
      c.outline.length ? h('details', { class: 'more-details' }, h('summary', null, 'What the contributing guide covers'),
        h('dl', { class: 'secsum' }, c.outline.map((x) => [h('dt', null, x.heading), x.text ? h('dd', null, x.text) : h('dd', { class: 'faint' }, '—')]))) : null
    ]));
    return frag;
  }

  // ------------------------------------------------------------ router

  const GH_RENDER = { summary: renderGhSummary, setup: renderGhSetup, code: renderGhCode, trust: renderGhTrust, contribute: renderGhContribute };

  function renderGithub() {
    if (gh.status === 'idle') {
      return h('div', null,
        empty('Analyze a repository', 'Open a repository on GitHub, GitLab or Codeberg, or type one here (for example owner/repo or gitlab:group/project). PageLens uses their free public APIs — no account needed.', ICONS.github),
        card('Repository', repoForm()));
    }
    if (gh.status === 'loading') {
      const frag = document.createDocumentFragment();
      frag.append(h('div', { class: 'muted small', id: 'gh-progress', style: { textAlign: 'center' } }, gh.progress));
      for (const hgt of [110, 150, 90]) frag.append(h('div', { class: 'skeleton', style: { height: hgt + 'px' } }));
      return frag;
    }
    if (gh.status === 'error') {
      const e = friendlyGhError(gh.error, gh.target);
      return h('div', null,
        empty(e.title, e.text, ICONS.block, e.permission
          ? h('button', { type: 'button', class: 'btn primary', style: { marginTop: '6px', padding: '6px 14px' }, onclick: () => allowForge(gh.target) }, `Allow ${platformHost(gh.target.platform)}`)
          : gh.error && gh.error.code !== 'not-found'
            ? h('button', { type: 'button', class: 'btn primary', style: { marginTop: '6px', padding: '6px 14px' }, onclick: () => loadRepo(gh.target, { force: true }) }, 'Try again') : null),
        card('Try another repository', repoForm()));
    }
    const frag = document.createDocumentFragment();
    frag.append(GH_RENDER[state.ghView](gh.report));
    frag.append(ghFooter(gh.report));
    return frag;
  }

  // ============================================================ states

  function renderLoading() {
    const frag = document.createDocumentFragment();
    frag.append(h('div', { class: 'muted small', style: { textAlign: 'center' } }, 'Reading the page…'));
    for (const hgt of [150, 86, 120, 64]) frag.append(h('div', { class: 'skeleton', style: { height: hgt + 'px' } }));
    return frag;
  }

  function renderProblem() {
    const e = state.error || {};
    return empty(e.title || 'Nothing to show', e.text || '', ICONS.block,
      state.status === 'error' ? h('button', { type: 'button', class: 'btn primary', onclick: scan, style: { marginTop: '6px', padding: '6px 14px' } }, 'Try again') : null);
  }

  // ============================================================ package mode (npm, PyPI)

  const PKG = globalThis.PageLensPackages;
  const pkg = { status: 'idle', target: null, raw: null, report: null, error: null, fromCache: false, history: null };
  const PKG_TTL = 60 * 60 * 1000;
  const pkgKey = (t) => `pkgcache:${t.ecosystem}:${t.name}`.toLowerCase();

  async function loadPackage(target, { force = false } = {}) {
    if (!target) return;
    pkg.status = 'loading';
    pkg.target = target;
    pkg.error = null;
    pkg.history = null;
    $('#rescan').classList.add('spin');
    if (state.mode === 'package') render();
    try {
      let raw = null;
      if (!force) {
        try {
          const got = await chrome.storage.local.get(pkgKey(target));
          const c = got[pkgKey(target)];
          if (c && Date.now() - c.fetchedAt < PKG_TTL) { raw = c; pkg.fromCache = true; }
        } catch { /* no cache */ }
      }
      if (!raw) {
        raw = await PKG.collect(target, { onProgress: (msg) => { const el = document.getElementById('pkg-progress'); if (el) el.textContent = msg; } });
        pkg.fromCache = false;
        try { await chrome.storage.local.set({ [pkgKey(target)]: raw }); } catch { /* optional */ }
      }
      pkg.raw = raw;
      pkg.report = PKG.analyze(raw);
      pkg.status = 'ready';
      recordPackageHistory();
    } catch (err) {
      pkg.status = 'error';
      pkg.error = err;
    }
    $('#rescan').classList.remove('spin');
    if (state.mode === 'package') render();
  }

  async function allowRegistries() {
    try {
      const ok = await chrome.permissions.request({ origins: PKG.ORIGINS });
      if (ok) loadPackage(pkg.target, { force: true });
      else toast('Permission not granted');
    } catch {
      toast('Permission request failed');
    }
  }

  async function recordPackageHistory() {
    if (!state.historyOn || !pkg.report) return;
    try {
      const key = HIST.keyForPackage(pkg.report.pkg.ecosystem, pkg.report.pkg.name);
      const snap = HIST.snapshotPackage(pkg.report);
      const res = await HIST.save(key, snap);
      pkg.history = { key, list: res.list, prev: res.prev, diff: res.prev ? HIST.diff(res.prev, snap) : null };
      if (state.mode === 'package') rerenderKeepingScroll();
    } catch (err) {
      console.warn('PageLens history', err);
    }
  }

  function packageForm(compact) {
    const input = h('input', { type: 'text', class: 'repo-input', placeholder: 'npm:name, pypi:name or a package page link', 'aria-label': 'Package', spellcheck: 'false', autocomplete: 'off',
      value: compact || !pkg.target ? '' : `${pkg.target.ecosystem === 'npm' ? 'npm' : 'pypi'}:${pkg.target.name}` });
    const form = h('form', { class: 'repo-form' }, input, h('button', { type: 'submit', class: 'btn primary' }, 'Check'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const t = PKG.parse(input.value);
      if (!t) { toast('Enter npm:name or pypi:name'); input.focus(); return; }
      loadPackage(t);
    });
    return form;
  }

  function monthBars(monthly) {
    const W = 380;
    const H = 36;
    const max = Math.max(1, ...monthly);
    const bw = W / monthly.length;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H + 12}`, class: 'spark', role: 'img', 'aria-label': `Releases per month for the last ${monthly.length} months` });
    monthly.forEach((v, i) => {
      const hh = v ? Math.max(3, (v / max) * H) : 1;
      svg.append(s('rect', { x: (i * bw + 1).toFixed(1), y: (H - hh).toFixed(1), width: Math.max(2, bw - 3).toFixed(1), height: hh.toFixed(1), rx: 1.5, class: v ? 'bar-on' : 'bar-off' },
        s('title', null, `${v} release${v === 1 ? '' : 's'}, ${monthly.length - i} month${monthly.length - i === 1 ? '' : 's'} ago`)));
    });
    svg.append(s('text', { x: 0, y: H + 11, class: 'spark-l' }, '2 years ago'), s('text', { x: W, y: H + 11, 'text-anchor': 'end', class: 'spark-l' }, 'this month'));
    return svg;
  }

  const PKG_PART = { maintenance: ['Recently updated', 'Maintenance'], popularity: ['Used by many', 'Popularity'], security: ['Safety', 'Security'], license: ['License', 'License'], information: ['Clear information', 'Metadata'] };

  function renderPackage() {
    if (pkg.status === 'idle') {
      return h('div', null,
        empty('Check a package', 'Open a package page on npmjs.com or pypi.org, or type one here. PageLens checks how well it is maintained, known vulnerabilities, install scripts and look-alike names.', ICONS.box),
        card('Package', packageForm()));
    }
    if (pkg.status === 'loading') {
      const frag = document.createDocumentFragment();
      frag.append(h('div', { class: 'muted small', id: 'pkg-progress', style: { textAlign: 'center' } }, 'Contacting the registry…'));
      for (const hgt of [110, 150, 90]) frag.append(h('div', { class: 'skeleton', style: { height: hgt + 'px' } }));
      return frag;
    }
    if (pkg.status === 'error') {
      const code = pkg.error && pkg.error.code;
      const net = code === 'network';
      return h('div', null,
        empty(code === 'not-found' ? 'Package not found' : net ? 'Could not reach the registry' : 'Package check failed',
          code === 'not-found' ? 'Check the spelling. npm names are lowercase; scoped names look like @scope/name.' : net ? 'Chrome may need your permission to read the public package registries (npm, PyPI) and the OSV vulnerability database.' : (pkg.error && pkg.error.message) || '',
          ICONS.block,
          net ? h('button', { type: 'button', class: 'btn primary', style: { marginTop: '6px', padding: '6px 14px' }, onclick: allowRegistries }, 'Allow package registries')
            : code !== 'not-found' ? h('button', { type: 'button', class: 'btn primary', style: { marginTop: '6px', padding: '6px 14px' }, onclick: () => loadPackage(pkg.target, { force: true }) }, 'Try again') : null),
        card('Check another package', packageForm()));
    }
    const r = pkg.report;
    const p = r.pkg;
    const frag = document.createDocumentFragment();

    frag.append(h('section', { class: 'card repo-head' },
      h('div', { class: 'repo-title' }, icon(ICONS.box),
        h('div', { style: { minWidth: 0 } }, extLink(p.name, p.registryUrl, 'repo-name'),
          h('div', { class: 'faint small' }, [p.ecosystem, p.latest ? `v${p.latest}` : null, p.license || 'no license', r.releases.latestDays != null ? `released ${ghAgo(r.releases.latestDays)}` : null].filter(Boolean).join(' · ')))),
      p.description ? h('p', { class: 'muted', style: { margin: '0 0 8px' } }, p.description) : null,
      h('div', { class: 'chips' },
        chip('Downloads/week', r.downloads.week != null ? ghNum(r.downloads.week) : '—'),
        chip('Versions', String(r.releases.count)),
        chip('Dependencies', String(r.dependencies.list.length)),
        p.types ? chip('Types', 'included') : null,
        p.engines ? chip(p.ecosystem === 'npm' ? 'Node' : 'Python', p.engines) : null)));

    frag.append(card(ghSay('Is it safe to depend on?', 'Package health'), [
      h('div', { class: 'verdict' }, ring(r.score),
        h('div', null, h('div', { class: `grade g-${r.verdict.cls === 'good' ? 'good' : r.verdict.cls === 'warn' ? 'warn' : 'bad'}` }, r.verdict.label), h('p', { class: 'muted' }, r.verdict.text),
          r.capped ? h('p', { class: 'faint small' }, `Held at 74 because of a high risk (would be ${r.uncapped}).`) : null,
          sinceLine(pkg.history))),
      h('div', { class: 'barrows breakdown', style: { marginTop: '10px' } }, Object.keys(r.partMax).map((k) => {
        const ratio = r.parts[k] / r.partMax[k];
        return h('div', { class: 'barrow' }, h('span', null, PKG_PART[k][state.role === 'everyday' ? 0 : 1]),
          h('div', { class: `bar s-${ratio >= 0.8 ? 'good' : ratio >= 0.5 ? 'ok' : ratio >= 0.3 ? 'warn' : 'bad'}` }, h('i', { style: { width: `${Math.max(2, ratio * 100)}%` } })),
          h('span', { class: 'v' }, `${r.parts[k]}/${r.partMax[k]}`));
      }))
    ]));

    frag.append(card(ghSay('Things to watch out for', 'Risks'), r.risks.length
      ? h('ul', { class: 'checklist' }, r.risks.map((x) => h('li', null, h('span', { class: `dot ${RISK_DOT[x.level]}` }),
        h('div', { style: { minWidth: 0 } }, h('div', { class: 't' }, x.text), x.detail ? h('div', { class: 'd' }, x.detail) : null),
        h('span', { class: `tag risk-${x.level}` }, x.level === 'info' ? 'note' : x.level))))
      : okLine('No notable risks found.')));

    frag.append(card(ghSay('Install it', 'Install'), [codeBlock(p.install), h('div', { class: 'sub' }, ghSay('Check the risks above before installing.', 'Pin the version in production (lockfile or ==).'))]));

    const sec = r.security;
    frag.append(card(ghSay('Known problems', 'Security'), [
      h('h3', { class: 'sub-h' }, `Known vulnerabilities in ${p.latest || 'the latest version'}`),
      !sec.vulnChecked ? h('p', { class: 'muted small' }, 'The vulnerability database could not be reached.')
        : sec.vulns.length ? h('ul', { class: 'checklist' }, sec.vulns.map((v) => h('li', null, h('span', { class: 'dot bad' }),
          h('div', { style: { minWidth: 0 } }, extLink(v.id, `https://osv.dev/vulnerability/${encodeURIComponent(v.id)}`), h('div', { class: 'd' }, [v.summary, v.aliases && v.aliases.length ? v.aliases.join(', ') : null, v.fixed && v.fixed.length ? `fixed in ${v.fixed.join(', ')}` : null].filter(Boolean).join(' · '))),
          h('span', { class: 'state' }, v.severity || ''))))
          : okLine('None known (OSV database).'),
      h('ul', { class: 'checklist', style: { marginTop: '6px' } },
        p.ecosystem === 'npm'
          ? h('li', null, h('span', { class: `dot ${sec.installScripts.length ? 'warn' : 'good'}` }), h('div', { style: { minWidth: 0 } }, h('div', { class: 't' }, ghSay('Runs code when installed', 'Install scripts')), h('div', { class: 'd' }, sec.installScripts.length ? sec.installScripts.map((x) => `${x.name}: ${x.script}`).join(' · ') : 'No preinstall, install or postinstall script')), h('span', { class: 'state' }, sec.installScripts.length ? 'Yes' : 'No'))
          : h('li', null, h('span', { class: `dot ${sec.sdistOnly ? 'warn' : 'good'}` }), h('div', null, h('div', { class: 't' }, ghSay('Ready-built files (wheels)', 'Wheels')), h('div', { class: 'd' }, sec.sdistOnly ? 'Source only: pip runs build code during install' : `${sec.wheels} wheel file${sec.wheels === 1 ? '' : 's'}`)), h('span', { class: 'state' }, sec.sdistOnly ? 'No' : 'Yes')),
        p.ecosystem === 'npm' ? h('li', null, h('span', { class: `dot ${sec.provenance ? 'good' : 'none'}` }), h('div', null, h('div', { class: 't' }, ghSay('Built in public CI (provenance)', 'Provenance attestation')), h('div', { class: 'd' }, 'Proves which repository and workflow built the package')), h('span', { class: 'state' }, sec.provenance ? 'Yes' : 'No')) : null,
        h('li', null, h('span', { class: `dot ${sec.lookalike ? 'bad' : 'good'}` }), h('div', null, h('div', { class: 't' }, ghSay('Name is not a look-alike', 'Typosquat check')), h('div', { class: 'd' }, sec.lookalike ? `Very close to "${sec.lookalike}"` : `Compared with ${PKG.POPULAR[p.ecosystem].length} popular ${p.ecosystem} names`)), h('span', { class: 'state' }, sec.lookalike ? 'Suspicious' : 'OK')))
    ]));

    const rl = r.releases;
    frag.append(card('Releases', [
      monthBars(rl.monthly),
      kv([
        ['Latest', p.latest ? `${p.latest}${rl.latestDays != null ? ` · ${ghAgo(rl.latestDays)}` : ''}` : '—'],
        ['Last 12 months', plural(rl.lastYear, 'release')],
        ['Typical gap', rl.medianGapDays != null ? `about ${rl.medianGapDays < 14 ? plural(rl.medianGapDays, 'day') : rl.medianGapDays < 60 ? plural(Math.round(rl.medianGapDays / 7), 'week') : plural(Math.round(rl.medianGapDays / 30), 'month')}` : '—'],
        ['First release', rl.first ? rl.first.slice(0, 10) : '—'],
        ['Maintainers', r.maintainers ? String(r.maintainers) : '—']
      ]),
      rl.datesApprox ? h('div', { class: 'sub' }, 'Release dates for older versions were not available, so the chart may be incomplete.') : null
    ]));

    if (r.dependencies.list.length) {
      frag.append(card(ghSay('What it pulls in', 'Dependencies'), h('div', { class: 'chips' }, r.dependencies.list.slice(0, 60).map((d) => chip(d))), { meta: String(r.dependencies.list.length) }));
    }

    frag.append(card(ghSay('Where the code lives', 'Source'), [
      kv([['Repository', p.repository || 'not linked'], ['Homepage', p.homepage || '—'], ['Issues', p.bugs || '—']]),
      p.repoTarget ? h('button', { type: 'button', class: 'btn more-btn', onclick: () => { state.mode = 'github'; state.ghView = 'summary'; loadRepo(p.repoTarget); } }, `Analyze the source repository (${p.repoTarget.full})`) : null
    ]));
    frag.append(card('Check another package', packageForm(true)));
    frag.append(h('div', { class: 'faint small', style: { textAlign: 'center' } }, [pkg.fromCache ? 'Saved copy from the last hour' : 'Fresh from the registry', r.meta.partial.length ? `couldn't read: ${r.meta.partial.join(', ')}` : null].filter(Boolean).join(' · ')));
    return frag;
  }

  // ============================================================ history (change tracker)

  const HIST = globalThis.PageLensHistory;

  function agoText(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const hrs = Math.round(m / 60);
    if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
    const d = Math.round(hrs / 24);
    return d < 31 ? `${d} day${d === 1 ? '' : 's'} ago` : new Date(t).toISOString().slice(0, 10);
  }

  async function recordHistory() {
    if (!state.historyOn || !state.scan || !state.score) return;
    // The website scan also runs quietly on repo and package pages; only save it once the user looks at it.
    if (state.mode !== 'website') { state.pendingWebHistory = true; return; }
    state.pendingWebHistory = false;
    try {
      const key = HIST.keyForUrl(state.scan.page.url);
      const snap = HIST.snapshotWebsite({ scan: state.scan, score: state.score, assessment: state.assessment, trackers: state.trackers, tech: state.tech, at: state.scan.scannedAt });
      const res = await HIST.save(key, snap);
      state.history = { key, list: res.list, prev: res.prev, diff: res.prev ? HIST.diff(res.prev, snap) : null };
      if (state.status === 'ready' && state.mode === 'website') rerenderKeepingScroll();
    } catch (err) {
      console.warn('PageLens history', err);
    }
  }

  async function recordRepoHistory() {
    if (!state.historyOn || !gh.report) return;
    try {
      const key = HIST.keyForRepo(gh.report.repo.platform && gh.report.repo.platform !== 'github' ? `${gh.report.repo.platform}:${gh.report.repo.fullName}` : gh.report.repo.fullName);
      const snap = HIST.snapshotRepo(gh.report, gh.report.meta.fetchedAt);
      const res = await HIST.save(key, snap);
      gh.history = { key, list: res.list, prev: res.prev, diff: res.prev ? HIST.diff(res.prev, snap) : null };
      if (state.mode === 'github') rerenderKeepingScroll();
    } catch (err) {
      console.warn('PageLens history', err);
    }
  }

  const deltaText = (n) => (n > 0 ? `▲ ${n}` : n < 0 ? `▼ ${Math.abs(n)}` : '±0');

  /** One-line "since last scan" summary used on Overview and GitHub Summary. */
  function sinceLine(hist) {
    if (!hist || !hist.diff) return null;
    const d = hist.diff;
    const bits = d.empty ? ['no changes'] : [
      d.overall.delta ? `score ${deltaText(d.overall.delta)}` : 'same score',
      d.fixed.length ? `${d.fixed.length} fixed` : null,
      d.added.length ? `${d.added.length} new` : null,
      d.changed && d.changed.length ? `${d.changed.length} changed` : null
    ].filter(Boolean);
    return h('button', { type: 'button', class: `since ${d.overall.delta > 0 ? 'up' : d.overall.delta < 0 ? 'down' : ''}`, onclick: () => openOverlay('history') },
      h('span', null, `Since last check (${agoText(d.since)}): ${bits.join(' · ')}`), h('span', { class: 'since-go' }, 'Changes →'));
  }

  function changeList(d) {
    const rows = [];
    const row = (tone, text, sub) => rows.push(h('li', null, h('span', { class: `dot ${tone}` }), h('div', { style: { minWidth: 0 } }, h('div', { class: 't' }, text), sub ? h('div', { class: 'd' }, sub) : null), h('span')));
    for (const a of d.areas) row(a.delta > 0 ? 'good' : 'bad', `${(Score.AREA[a.id] && Score.AREA[a.id].label) || a.id}: ${a.before} → ${a.after}`, deltaText(a.delta));
    for (const i of d.fixed) row('good', `Fixed: ${i.title}`, i.sev);
    for (const i of d.added) row('bad', `New: ${i.title}`, i.sev);
    for (const c of d.changed || []) row('none', `Changed: ${c.after}`, `was: ${c.before}${c.sevBefore !== c.sev ? ` (${c.sevBefore} → ${c.sev})` : ''}`);
    for (const m of d.metrics) row(m.better ? 'good' : 'bad', `${m.name}: ${m.name === 'Page size' ? fmtBytes(m.before) : m.name.includes('LCP') ? fmtMs(m.before) : m.before} → ${m.name === 'Page size' ? fmtBytes(m.after) : m.name.includes('LCP') ? fmtMs(m.after) : m.after}`, m.pct != null ? `${m.pct > 0 ? '+' : ''}${Math.round(m.pct * 100)}%` : null);
    if (d.headerGrade) row('none', `Header grade ${d.headerGrade.before || '—'} → ${d.headerGrade.after || '—'}`);
    if (d.release) row('good', `New release ${d.release.after}`, d.release.before ? `was ${d.release.before}` : null);
    if (d.tech) {
      for (const u of d.tech.upgraded) row('none', `${u.name} updated ${u.from} → ${u.to}`);
      for (const n of d.tech.added) row('none', `Now uses ${n}`);
      for (const n of d.tech.removed) row('none', `No longer uses ${n}`);
    }
    if (d.trackers) {
      for (const n of d.trackers.added) row('bad', `New tracker: ${n}`);
      for (const n of d.trackers.removed) row('good', `Tracker removed: ${n}`);
    }
    if (d.colors && (d.colors.added.length || d.colors.removed.length)) row('none', 'Palette changed', [d.colors.added.length ? `added ${d.colors.added.join(' ')}` : null, d.colors.removed.length ? `removed ${d.colors.removed.join(' ')}` : null].filter(Boolean).join(' · '));
    if (d.fonts && (d.fonts.added.length || d.fonts.removed.length)) row('none', 'Fonts changed', [d.fonts.added.length ? `added ${d.fonts.added.join(', ')}` : null, d.fonts.removed.length ? `removed ${d.fonts.removed.join(', ')}` : null].filter(Boolean).join(' · '));
    return h('ul', { class: 'checklist' }, rows);
  }

  function miniTrend(list) {
    const pts = [...list].reverse().map((x) => x.overall);
    if (pts.length < 2) return null;
    const W = 380;
    const H = 46;
    const x = (i) => 6 + (i * (W - 12)) / (pts.length - 1);
    const y = (v) => 6 + (1 - v / 100) * (H - 12);
    const path = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    return s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'trend', role: 'img', 'aria-label': `Score history: ${pts.join(', ')}` },
      s('path', { d: path, class: 'trend-line', fill: 'none' }),
      ...pts.map((v, i) => s('circle', { cx: x(i).toFixed(1), cy: y(v).toFixed(1), r: 3, class: 'trend-dot' }, s('title', null, String(v)))));
  }

  function renderHistory() {
    const frag = document.createDocumentFragment();
    const isRepo = state.mode !== 'website';
    const hist = state.mode === 'package' ? pkg.history : isRepo ? gh.history : state.history;
    const what = state.mode === 'package' ? (pkg.report ? `${pkg.report.pkg.ecosystem} · ${pkg.report.pkg.name}` : null)
      : isRepo ? (gh.report ? gh.report.repo.fullName : null) : (state.scan ? state.scan.page.host + state.scan.page.url.replace(/^https?:\/\/[^/]+/, '') : null);
    frag.append(h('div', { class: 'overlay-head' },
      h('button', { type: 'button', class: 'btn', onclick: closeOverlay }, '← Back'),
      h('h2', null, 'History')));

    if (!state.historyOn) {
      frag.append(notice('Scan history is turned off. Turn it on below to track changes over time.'));
    } else if (hist && hist.list && hist.list.length) {
      const d = hist.diff;
      frag.append(card(state.mode === 'package' ? 'Changes to this package' : isRepo ? 'Changes to this repository' : 'Changes on this page', [
        h('div', { class: 'faint small', style: { marginBottom: '6px' } }, what),
        !d ? h('p', { class: 'muted' }, 'This is the first check saved. Come back later to see what changed.')
          : d.empty ? okLine(`No changes since ${agoText(d.since)}.`)
            : [
              h('div', { class: `since-big ${d.overall.delta > 0 ? 'up' : d.overall.delta < 0 ? 'down' : ''}` },
                h('b', null, `${d.overall.before} → ${d.overall.after}`), h('span', null, `${deltaText(d.overall.delta)} since ${agoText(d.since)}`)),
              changeList(d)
            ]
      ], { meta: plural(hist.list.length, 'check') }));
      if (hist.list.length >= 2) {
        frag.append(card('Score over time', [
          miniTrend(hist.list),
          h('ul', { class: 'checklist' }, hist.list.map((x) => h('li', null,
            h('span', { class: `dot ${x.overall >= 90 ? 'good' : x.overall >= 60 ? 'warn' : 'bad'}` }),
            h('div', null, h('div', { class: 't' }, `${x.overall}/100 · ${x.grade}`), h('div', { class: 'd' }, new Date(x.at).toLocaleString())),
            h('span', { class: 'state' }, agoText(x.at)))))
        ]));
      }
    } else {
      frag.append(card('This page', h('p', { class: 'muted' }, isRepo ? 'Analyze a repository to start its history.' : 'Scan a page to start its history.')));
    }

    // Recently checked pages and repos
    const recentList = state.recent || [];
    frag.append(h('button', { type: 'button', class: 'btn more-btn cmp-open', onclick: openCompare }, 'Compare two checks side by side'));
    frag.append(card('Recently checked', recentList.length ? h('ul', { class: 'checklist' }, recentList.map((r) => h('li', null,
      h('span', { class: `dot ${r.score >= 90 ? 'good' : r.score >= 60 ? 'warn' : 'bad'}` }),
      h('div', { style: { minWidth: 0 } },
        safeHref(r.url) ? h('a', { class: 'xlink', href: safeHref(r.url), target: '_blank', rel: 'noopener noreferrer' }, r.title || r.url) : h('div', { class: 't' }, r.title),
        h('div', { class: 'd' }, `${r.kind === 'repo' ? 'Repository' : r.kind === 'pkg' ? 'Package' : 'Page'} · ${plural(r.count, 'check')} · ${agoText(r.last)}`)),
      h('span', { class: 'state' }, `${r.score}`))))
      : h('p', { class: 'muted' }, 'Nothing saved yet.'), { meta: recentList.length ? String(recentList.length) : null }));

    // Settings
    const toggle = h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: state.historyOn ? true : null }), ' Save scan history on this computer');
    toggle.querySelector('input').addEventListener('change', (e) => {
      state.historyOn = e.target.checked;
      savePrefs();
      if (state.historyOn) { if (state.mode === 'github') recordRepoHistory(); else recordHistory(); }
      rerenderKeepingScroll();
    });
    frag.append(card('Settings', [
      toggle,
      h('div', { class: 'sub' }, 'History stays in this browser (chrome.storage.local). It stores the page address without query strings, its title, scores and finding titles — never page content, cookies or form values. Up to 12 checks per page and 60 pages.'),
      h('div', { class: 'btn-row' },
        hist && hist.key ? h('button', { type: 'button', class: 'btn', onclick: async () => { await HIST.clear(hist.key); if (state.mode === 'package') pkg.history = null; else if (isRepo) gh.history = null; else state.history = null; state.recent = await HIST.recent(); toast('History for this page cleared'); rerenderKeepingScroll(); } }, isRepo ? 'Clear this repo' : 'Clear this page') : null,
        h('button', { type: 'button', class: 'btn', onclick: async () => { await HIST.clear(); state.history = null; gh.history = null; state.recent = []; toast('All history cleared'); rerenderKeepingScroll(); } }, 'Clear all'))
    ]));
    return frag;
  }

  async function openOverlay(name) {
    state.overlay = name;
    closeExportMenu();
    if (name === 'history') {
      try { state.recent = await HIST.recent(30); } catch { state.recent = []; }
    }
    render();
  }

  function closeOverlay() {
    state.overlay = null;
    render();
  }

  // ============================================================ compare mode

  const CMP = globalThis.PageLensCompare;
  const compareState = { options: [], a: null, b: null, snapA: null, snapB: null };

  /** Options: the latest check of each recent item, plus earlier checks of the current one. */
  async function compareOptions() {
    const recentList = await HIST.recent(60);
    const opts = [];
    for (const r of recentList) opts.push({ value: `${r.key}#0`, key: r.key, idx: 0, kind: r.kind, label: `${r.title || r.url} — latest (${r.score})` });
    const cur = state.mode === 'package' ? pkg.history : state.mode === 'github' ? gh.history : state.history;
    if (cur && cur.list && cur.list.length > 1) {
      cur.list.slice(1).forEach((x, i) => opts.push({ value: `${cur.key}#${i + 1}`, key: cur.key, idx: i + 1, kind: x.kind, label: `${x.title} — ${agoText(x.at)} (${x.overall})` }));
    }
    return opts;
  }

  async function loadSnap(value) {
    if (!value) return null;
    const [key, idx] = value.split('#');
    const list = await HIST.list(key);
    return list[Number(idx) || 0] || null;
  }

  async function openCompare() {
    compareState.options = await compareOptions();
    const cur = state.mode === 'package' ? pkg.history : state.mode === 'github' ? gh.history : state.history;
    const curKey = cur && cur.key;
    const first = compareState.options.find((o) => o.key === curKey && o.idx === 0) || compareState.options[0] || null;
    const second = (curKey && compareState.options.find((o) => o.key === curKey && o.idx === 1)) ||
      compareState.options.find((o) => first && o.kind === first.kind && o.key !== first.key) || null;
    compareState.a = first ? first.value : null;
    compareState.b = second ? second.value : null;
    compareState.snapA = await loadSnap(compareState.a);
    compareState.snapB = await loadSnap(compareState.b);
    state.overlay = 'compare';
    render();
  }

  function renderCompare() {
    const frag = document.createDocumentFragment();
    frag.append(h('div', { class: 'overlay-head' }, h('button', { type: 'button', class: 'btn', onclick: () => openOverlay('history') }, '← History'), h('h2', null, 'Compare')));
    const opts = compareState.options;
    if (opts.length < 2) {
      frag.append(card('Compare', h('p', { class: 'muted' }, 'Check at least two pages, repositories or packages (or the same one twice on different days) and they will appear here.')));
      return frag;
    }
    const kindOf = (v) => (opts.find((o) => o.value === v) || {}).kind;
    const pick = (which) => {
      const kind = which === 'b' ? kindOf(compareState.a) : null;
      const sel = h('select', { class: 'platform-select cmp-select', 'aria-label': which === 'a' ? 'First item' : 'Second item' },
        opts.filter((o) => !kind || o.kind === kind).map((o) => h('option', { value: o.value, selected: o.value === compareState[which] ? true : null }, o.label)));
      sel.addEventListener('change', async (e) => {
        compareState[which] = e.target.value;
        compareState[which === 'a' ? 'snapA' : 'snapB'] = await loadSnap(e.target.value);
        if (which === 'a' && kindOf(compareState.b) !== kindOf(compareState.a)) {
          const alt = opts.find((o) => o.kind === kindOf(compareState.a) && o.value !== compareState.a);
          compareState.b = alt ? alt.value : null;
          compareState.snapB = await loadSnap(compareState.b);
        }
        rerenderKeepingScroll();
      });
      return sel;
    };
    frag.append(card('What to compare', h('div', { class: 'cmp-pick' },
      h('label', null, h('span', { class: 'cmp-tag a' }, 'A'), pick('a')),
      h('label', null, h('span', { class: 'cmp-tag b' }, 'B'), pick('b')))));

    const c = CMP.compare(compareState.snapA, compareState.snapB);
    if (!c) { frag.append(card('Result', h('p', { class: 'muted' }, 'Pick a second item of the same kind.'))); return frag; }
    if (c.error) { frag.append(card('Result', h('p', { class: 'muted' }, 'Pick two items of the same kind (two websites, two repositories or two packages).'))); return frag; }

    const lead = c.tally.a === c.tally.b ? 'They come out even.' : `${c.tally.a > c.tally.b ? 'A' : 'B'} is ahead on ${Math.max(c.tally.a, c.tally.b)} of ${c.tally.a + c.tally.b} measures.`;
    let group = null;
    const rows = [];
    for (const r of c.rows) {
      if (r.group !== group) { rows.push(h('tr', { class: 'cmp-g' }, h('th', { colspan: '3' }, r.group))); group = r.group; }
      rows.push(h('tr', null, h('td', null, r.label),
        h('td', { class: `num ${r.win === 'a' ? 'cmp-win' : ''}` }, r.aText),
        h('td', { class: `num ${r.win === 'b' ? 'cmp-win' : ''}` }, r.bText)));
    }
    frag.append(card('Side by side', [
      h('p', { class: 'muted small' }, lead),
      h('table', { class: 'tbl cmp' },
        h('colgroup', null, h('col', { style: { width: '46%' } }), h('col', { style: { width: '27%' } }), h('col', { style: { width: '27%' } })),
        h('thead', null, h('tr', null, h('th', null, ''), h('th', { class: 'num' }, 'A'), h('th', { class: 'num' }, 'B'))),
        h('tbody', null, rows)),
      h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', onclick: () => copy(CMP.markdown(c), 'Comparison copied as Markdown') }, 'Copy as Markdown'))
    ]));

    const issueCol = (title, list, tone) => card(title, list.length
      ? h('ul', { class: 'checklist' }, list.slice(0, 30).map((i) => h('li', null, h('span', { class: `dot ${tone}` }), h('div', { class: 't' }, i.title), h('span', { class: 'state' }, i.sev))))
      : okLine('None.'), { meta: String(list.length) });
    frag.append(issueCol(c.kind === 'web' ? 'Problems only A has' : 'Risks only A has', c.onlyA, 'warn'));
    frag.append(issueCol(c.kind === 'web' ? 'Problems only B has' : 'Risks only B has', c.onlyB, 'warn'));
    if (c.extra.fonts) {
      frag.append(card('Design and tools', kv([
        ['Fonts', `A: ${c.extra.fonts.a.join(', ') || '—'}\nB: ${c.extra.fonts.b.join(', ') || '—'}`],
        ['Trackers', `A: ${c.extra.trackers.a.join(', ') || 'none'}\nB: ${c.extra.trackers.b.join(', ') || 'none'}`],
        ['Tech', `A: ${c.extra.tech.a.slice(0, 6).join(', ') || '—'}\nB: ${c.extra.tech.b.slice(0, 6).join(', ') || '—'}`]
      ]), { class: 'cmp-extra' }));
      frag.append(card('Palettes', h('div', { class: 'cmp-pal' },
        ['a', 'b'].map((k) => h('div', null, h('span', { class: `cmp-tag ${k}` }, k.toUpperCase()), h('div', { class: 'strip' }, c.extra.colors[k].slice(0, 10).map((hex) => h('span', { class: 'strip-seg', style: { background: hex, flex: '1 1 0' }, title: hex }))))))));
    }
    return frag;
  }

  // ============================================================ settings + welcome

  const ROLE_CARDS = [
    { id: 'everyday', title: 'Everyday user', text: 'Is this site safe? Who is tracking me? Plain answers.' },
    { id: 'designer', title: 'Designer', text: 'Colors, fonts, spacing and contrast fixes, with exports.' },
    { id: 'developer', title: 'Developer', text: 'Speed, structure, stack, and how to run any repo.' },
    { id: 'security', title: 'Security', text: 'Header grade, CSP, cookies, CI supply-chain risks.' }
  ];

  async function loadSecrets() {
    try {
      const { ghToken } = await chrome.storage.local.get('ghToken');
      state.ghToken = typeof ghToken === 'string' && ghToken ? ghToken : null;
    } catch { state.ghToken = null; }
  }

  function renderWelcome() {
    const frag = document.createDocumentFragment();
    frag.append(h('section', { class: 'welcome' },
      h('img', { src: '../icons/icon128.png', alt: '', width: '56', height: '56' }),
      h('h2', null, 'Welcome to PageLens'),
      h('p', { class: 'muted' }, 'One click gives a plain-English report on any website, repository or package.'),
      h('ul', { class: 'welcome-points' },
        h('li', null, icon(ICONS.check), h('span', null, h('b', null, 'Checks everything: '), 'design, accessibility, speed, privacy, security and SEO.')),
        h('li', null, icon(ICONS.lock), h('span', null, h('b', null, 'Private: '), 'runs in your browser. No account, no tracking, never reads passwords or cookie values.')),
        h('li', null, icon(ICONS.info), h('span', null, h('b', null, 'Predictable: '), 'fixed rules, no AI guesses. The same page always gives the same result.')))));
    frag.append(card('How should PageLens talk to you?', [
      h('div', { class: 'role-cards', role: 'radiogroup', 'aria-label': 'Role' }, ROLE_CARDS.map((r) => h('button', {
        type: 'button', role: 'radio', class: 'role-card', 'aria-checked': String(state.role === r.id),
        onclick: () => { state.role = r.id; savePrefs(); rerenderKeepingScroll(); }
      }, h('b', null, r.title), h('span', null, r.text)))),
      h('div', { class: 'sub' }, 'This only changes the order and wording. Everyone sees the full report, and you can switch at any time with "View as".')
    ]));
    frag.append(h('button', { type: 'button', class: 'btn primary welcome-go', onclick: () => { state.onboarded = true; savePrefs(); closeOverlay(); } }, 'Start'));
    return frag;
  }

  async function grantedOptional() {
    try {
      const all = await chrome.permissions.getAll();
      const req = new Set(chrome.runtime.getManifest().host_permissions || []);
      return { origins: (all.origins || []).filter((o) => !req.has(o)), permissions: (all.permissions || []).filter((p) => p === 'cookies') };
    } catch {
      return { origins: [], permissions: [] };
    }
  }

  async function openSettings() {
    state.settingsInfo = { granted: await grantedOptional(), rate: null };
    state.overlay = 'settings';
    render();
  }

  function renderSettings() {
    const info = state.settingsInfo || { granted: { origins: [], permissions: [] } };
    const frag = document.createDocumentFragment();
    frag.append(h('div', { class: 'overlay-head' }, h('button', { type: 'button', class: 'btn', onclick: closeOverlay }, '← Back'), h('h2', null, 'Settings')));

    // Appearance
    const themeSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Theme' }, ['system', 'light', 'dark'].map((t) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(state.theme === t), onclick: () => { state.theme = t; applyTheme(); savePrefs(); rerenderKeepingScroll(); }
    }, t[0].toUpperCase() + t.slice(1))));
    const roleSel = h('select', { class: 'platform-select', 'aria-label': 'Default view' }, ROLE_CARDS.map((r) => h('option', { value: r.id, selected: state.role === r.id ? true : null }, r.title)));
    roleSel.addEventListener('change', (e) => { state.role = e.target.value; savePrefs(); render(); });
    frag.append(card('Appearance', h('div', { class: 'settings-rows' },
      h('div', { class: 'settings-row' }, h('span', null, 'Theme'), themeSeg),
      h('div', { class: 'settings-row' }, h('span', null, 'View as'), roleSel))));

    // GitHub token
    const tokenInput = h('input', { type: 'password', class: 'repo-input', placeholder: state.ghToken ? '•••••••• saved' : 'github_pat_… or ghp_…', 'aria-label': 'GitHub token', autocomplete: 'off', spellcheck: 'false' });
    const save = h('button', { type: 'button', class: 'btn primary' }, 'Save');
    save.addEventListener('click', async () => {
      const v = tokenInput.value.trim();
      if (!/^(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,255}$/.test(v)) { toast('That does not look like a GitHub token'); return; }
      await chrome.storage.local.set({ ghToken: v });
      state.ghToken = v;
      tokenInput.value = '';
      toast('Token saved on this computer');
      checkRate();
    });
    async function checkRate() {
      try {
        state.settingsInfo.rate = await GH.rateLimit(state.ghToken);
      } catch (err) {
        state.settingsInfo.rate = { error: err && err.code === 'forbidden' ? 'GitHub rejected the token' : 'Could not reach GitHub' };
      }
      rerenderKeepingScroll();
    }
    const rate = info.rate;
    frag.append(card('GitHub lookups', [
      h('p', { class: 'muted small' }, 'Without an account GitHub allows 60 lookups an hour (about 5 repositories). A personal token raises that to 5,000. Create a fine-grained token with no extra permissions — public data only.'),
      h('div', { class: 'repo-form' }, tokenInput, save),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn', onclick: checkRate }, 'Check my limit'),
        state.ghToken ? h('button', { type: 'button', class: 'btn', onclick: async () => { await chrome.storage.local.remove('ghToken'); state.ghToken = null; toast('Token removed'); rerenderKeepingScroll(); } }, 'Remove token') : null,
        extLink('Create a token ↗', 'https://github.com/settings/personal-access-tokens/new', 'chip')),
      rate ? h('div', { class: 'sub' }, rate.error ? rate.error : `${rate.remaining} of ${rate.limit} lookups left this hour${rate.reset ? ` (resets ${new Date(rate.reset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : ''}.`) : null,
      h('div', { class: 'sub' }, `Status: ${state.ghToken ? 'token saved (stored only in this browser, sent only to api.github.com)' : 'no token'}`)
    ]));

    // Data
    const histToggle = h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: state.historyOn ? true : null }), ' Save scan history on this computer');
    histToggle.querySelector('input').addEventListener('change', (e) => { state.historyOn = e.target.checked; savePrefs(); rerenderKeepingScroll(); });
    frag.append(card('Your data', [
      histToggle,
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn', onclick: async () => { await HIST.clear(); state.history = null; gh.history = null; pkg.history = null; toast('History cleared'); } }, 'Clear history'),
        h('button', { type: 'button', class: 'btn', onclick: async () => {
          const all = await chrome.storage.local.get(null);
          await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('gh:') || k.startsWith('pkgcache:')));
          toast('Saved repository and package data cleared');
        } }, 'Clear saved lookups')),
      h('div', { class: 'sub' }, 'Everything PageLens keeps stays in this browser. Nothing is uploaded.')
    ]));

    // Permissions
    const g = info.granted;
    const rows = [...g.permissions.map((p) => ({ label: 'Cookie flags', id: { permissions: [p] } })), ...g.origins.map((o) => ({ label: o.replace('/*', ''), id: { origins: [o] } }))];
    frag.append(card('Extra access you allowed', rows.length
      ? h('ul', { class: 'checklist' }, rows.map((r) => h('li', null, h('span', { class: 'dot good' }), h('div', { class: 't mono', style: { overflowWrap: 'anywhere' } }, r.label),
        h('button', { type: 'button', class: 'btn', onclick: async () => { try { await chrome.permissions.remove(r.id); } catch { /* ignore */ } state.settingsInfo.granted = await grantedOptional(); toast('Access removed'); rerenderKeepingScroll(); } }, 'Remove'))))
      : h('p', { class: 'muted small' }, 'None. PageLens only asks for more access when you click a button that needs it.')));

    // About
    frag.append(card('About', [
      kv([['Version', VERSION], ['License', 'MIT (free and open source)'], ['How it works', 'Fixed rules, no AI, runs on your device']]),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn', onclick: () => { state.overlay = 'welcome'; render(); } }, 'Show welcome again'),
        h('button', { type: 'button', class: 'btn', onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL('report/privacy.html') }) }, 'Privacy policy'))
    ]));
    return frag;
  }

  // ============================================================ exports + full report

  const Model = globalThis.PageLensReportModel;
  const today = () => new Date().toISOString().slice(0, 10);

  function buildModel() {
    if (state.mode === 'package') {
      return pkg.report ? Model.packageReport(pkg.report, { role: state.role, version: VERSION, diff: pkg.history && pkg.history.diff }) : null;
    }
    if (state.mode === 'github') {
      return gh.report ? Model.repository(gh.report, { role: state.role, version: VERSION, diff: gh.history && gh.history.diff }) : null;
    }
    if (!state.scan || !state.score) return null;
    return Model.website({
      scan: state.scan, score: state.score, assessment: state.assessment, csp: state.csp, fixes: currentFixes(), trackers: state.trackers,
      tech: state.tech, headers: state.headers, cookies: state.cookies, securityTxt: state.securityTxt,
      diff: state.history && state.history.diff, role: state.role, version: VERSION
    });
  }

  function exportName(ext) {
    const base = state.mode === 'package' && pkg.report ? `${pkg.report.pkg.ecosystem}-${pkg.report.pkg.name}`.replace('@', '').replace('/', '-')
      : state.mode === 'github' && gh.report ? gh.report.repo.fullName.replace(/\//g, '-') : (state.scan ? state.scan.page.host : 'page') || 'page';
    return `pagelens-${base.replace(/[^\w.-]+/g, '-')}-${today()}.${ext}`;
  }

  const EXPORTS = {
    md: { label: 'Report (Markdown)', ext: '.md', both: true, run: () => download(exportName('md'), globalThis.PageLensMarkdown.render(buildModel()), 'text/markdown') },
    html: { label: 'Report (HTML file)', ext: '.html', both: true, run: () => download(exportName('html'), globalThis.PageLensHtml.document(buildModel()), 'text/html') },
    json: { label: 'All data (JSON)', ext: '.json', both: true, run: () => exportJson() },
    css: { label: 'CSS variables', ext: '.css', run: () => download(exportName('css'), Tokens.toCssVariables(state.scan), 'text/css') },
    tailwind: { label: 'Tailwind config', ext: '.js', run: () => download(`tailwind.config.${(state.scan.page.host || 'page').replace(/[^\w.-]+/g, '-')}.js`, Tokens.toTailwind(state.scan), 'text/javascript') },
    tokens: { label: 'Design tokens (Figma / Style Dictionary)', ext: '.json', run: () => download(exportName('tokens.json'), Tokens.toDesignTokens(state.scan), 'application/json') }
  };

  function closeExportMenu() {
    const m = document.getElementById('export-menu');
    if (m) m.remove();
    $('#act-export').setAttribute('aria-expanded', 'false');
  }

  function toggleExportMenu() {
    if (document.getElementById('export-menu')) { closeExportMenu(); return; }
    const isRepo = state.mode !== 'website';
    const items = Object.entries(EXPORTS).filter(([, x]) => x.both || !isRepo);
    const menu = h('div', { id: 'export-menu', class: 'menu', role: 'menu', 'aria-label': 'Export' },
      items.map(([id, x]) => h('button', {
        type: 'button', role: 'menuitem', class: 'menu-item',
        onclick: () => {
          closeExportMenu();
          try { x.run(); if (id !== 'json') toast(`${x.label} downloaded`); } catch (err) { toast('Export failed'); console.error(err); }
        }
      }, h('span', null, x.label), h('span', { class: 'faint mono' }, x.ext))));
    document.querySelector('.app').append(menu);
    $('#act-export').setAttribute('aria-expanded', 'true');
    menu.querySelector('button').focus();
    menu.addEventListener('keydown', (e) => {
      const btns = [...menu.querySelectorAll('button')];
      const i = btns.indexOf(document.activeElement);
      if (e.key === 'Escape') { closeExportMenu(); $('#act-export').focus(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    });
  }

  async function openFullReport() {
    if (state.mode === 'package') {
      if (!pkg.raw) return;
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      try {
        await (chrome.storage.session || chrome.storage.local).set({ [`report:${id}`]: { kind: 'pkg', raw: pkg.raw, diff: pkg.history && pkg.history.diff, role: state.role, version: VERSION, theme: state.theme } });
        await chrome.tabs.create({ url: chrome.runtime.getURL(`report/report.html?id=${id}`) });
      } catch { toast('Could not open the report'); }
      return;
    }
    const isRepo = state.mode === 'github';
    const payload = isRepo
      ? { kind: 'repo', raw: gh.raw, diff: gh.history && gh.history.diff, role: state.role, version: VERSION, theme: state.theme }
      : { kind: 'web', scan: state.scan, headers: state.headers, cookies: state.cookies, tech: state.tech, securityTxt: state.securityTxt, platform: state.fixPlatform, diff: state.history && state.history.diff, role: state.role, version: VERSION, theme: state.theme };
    if ((isRepo && !gh.raw) || (!isRepo && !state.scan)) return;
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    try {
      const area = chrome.storage.session || chrome.storage.local;
      await area.set({ [`report:${id}`]: payload });
      await chrome.tabs.create({ url: chrome.runtime.getURL(`report/report.html?id=${id}`) });
    } catch (err) {
      console.error(err);
      toast('Could not open the report');
    }
  }

  // ============================================================ render + controls

  const RENDER = { overview: renderOverview, design: renderDesign, ux: renderUX, access: renderAccess, speed: renderSpeed, privacy: renderPrivacy, security: renderSecurity };

  function renderView() {
    if (state.overlay === 'history') return renderHistory();
    if (state.overlay === 'compare') return renderCompare();
    if (state.overlay === 'settings') return renderSettings();
    if (state.overlay === 'welcome') return renderWelcome();
    if (state.mode === 'package') return renderPackage();
    if (state.mode === 'github') return renderGithub();
    if (state.status === 'loading') return renderLoading();
    if (state.status !== 'ready') return renderProblem();
    return RENDER[state.view]();
  }

  function render() {
    // tabs
    const tabs = $('#tabs');
    if (tabs.dataset.mode !== state.mode) buildTabs();
    const ghReady = gh.status === 'ready';
    tabs.hidden = (state.mode === 'github' && !ghReady) || state.mode === 'package';
    for (const b of tabs.children) {
      const on = b.dataset.tab === currentTab();
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    // mode
    for (const b of $('#mode').children) b.setAttribute('aria-checked', String(b.dataset.mode === state.mode));
    $('#role').value = state.role;

    const ready = state.status === 'ready' && state.mode === 'website';
    const modeReady = state.mode === 'github' ? ghReady : state.mode === 'package' ? pkg.status === 'ready' : ready;
    $('#act-css').disabled = !ready;
    $('#act-export').disabled = !modeReady;
    $('#act-export').title = 'Download the report, data or design tokens';
    $('#act-report').disabled = !modeReady;
    $('#act-report').title = 'Open the full report in a new tab (printable)';
    $('#act-history').disabled = false;
    $('#act-history').title = 'History and changes since the last scan';
    $('#act-history').setAttribute('aria-pressed', String(state.overlay === 'history' || state.overlay === 'compare'));
    if (state.overlay) for (const b of tabs.children) b.setAttribute('aria-selected', 'false');
    closeExportMenu();

    const keep = view.scrollTop;
    view.replaceChildren(renderView());
    view.scrollTop = render.keepScroll ? keep : 0;
    render.keepScroll = false;
  }

  const tabsFor = (mode) => (mode === 'github' ? GH_TABS : mode === 'package' ? [] : WEB_TABS);
  const currentTab = () => (state.mode === 'github' ? state.ghView : state.view);
  function setTab(id) {
    if (state.mode === 'github') state.ghView = id;
    else state.view = id;
  }

  function buildTabs() {
    const tabs = $('#tabs');
    tabs.replaceChildren(...tabsFor(state.mode).map((t) => h('button', {
      type: 'button', class: 'tab', role: 'tab', id: `tab-${t.id}`, 'data-tab': t.id, 'aria-controls': 'view',
      onclick: () => { state.overlay = null; setTab(t.id); render(); }
    }, t.label)));
    tabs.dataset.mode = state.mode;
    if (!buildTabs.bound) {
      buildTabs.bound = true;
      tabs.addEventListener('keydown', (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const list = tabsFor(state.mode);
        const i = list.findIndex((t) => t.id === currentTab());
        const n = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
        setTab(list[n].id);
        render();
        $(`#tab-${currentTab()}`).focus();
      });
    }
    view.setAttribute('role', 'tabpanel');
  }

  function bindControls() {
    $('#theme').addEventListener('click', () => {
      state.theme = { system: 'light', light: 'dark', dark: 'system' }[state.theme];
      applyTheme();
      savePrefs();
    });
    $('#role').addEventListener('change', (e) => {
      state.role = e.target.value;
      savePrefs();
      render();
    });
    $('#mode').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      state.mode = b.dataset.mode;
      if (state.mode === 'website' && state.pendingWebHistory) recordHistory();
      if (state.mode === 'github' && gh.status === 'idle' && state.repo) loadRepo(state.repo);
      else if (state.mode === 'package' && pkg.status === 'idle' && state.pkgTarget) loadPackage(state.pkgTarget);
      else render();
    });
    $('#rescan').addEventListener('click', () => {
      if (state.mode === 'github') {
        if (gh.status === 'loading' || !gh.target) return;
        loadRepo(gh.target, { force: true });
        return;
      }
      if (state.mode === 'package') {
        if (pkg.status === 'loading' || !pkg.target) return;
        loadPackage(pkg.target, { force: true });
        return;
      }
      if (state.status === 'loading' || state.status === 'blocked') return;
      scan();
    });
    $('#act-css').addEventListener('click', () => {
      if (!state.scan) return;
      copy(Tokens.toCssVariables(state.scan), 'CSS variables copied');
    });
    $('#act-export').addEventListener('click', (e) => { e.stopPropagation(); toggleExportMenu(); });
    $('#act-report').addEventListener('click', openFullReport);
    $('#settings').addEventListener('click', () => (state.overlay === 'settings' ? closeOverlay() : openSettings()));
    $('#act-history').addEventListener('click', () => (state.overlay ? closeOverlay() : openOverlay('history')));
    document.addEventListener('click', (e) => { if (!e.target.closest('#export-menu') && !e.target.closest('#act-export')) closeExportMenu(); });
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function exportJson() {
    if (state.mode === 'package') {
      if (!pkg.report) return;
      download(exportName('json'), JSON.stringify({ app: 'PageLens', version: VERSION, mode: 'package', exportedAt: new Date().toISOString(), report: pkg.report, raw: pkg.raw }, null, 2), 'application/json');
      toast('Package report exported as JSON');
      return;
    }
    if (state.mode === 'github') {
      if (!gh.report) return;
      const payload = { app: 'PageLens', version: VERSION, mode: 'github', exportedAt: new Date().toISOString(), fetchedAt: new Date(gh.report.meta.fetchedAt).toISOString(), report: gh.report };
      download(`pagelens-${gh.report.repo.fullName.replace('/', '-')}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), 'application/json');
      toast('Repo report exported as JSON');
      return;
    }
    if (!state.scan) return;
    const payload = {
      app: 'PageLens',
      version: VERSION,
      schema: state.scan.schema,
      exportedAt: new Date().toISOString(),
      scan: state.scan,
      tech: state.tech,
      headers: state.headers,
      cookieFlags: state.cookies,
      score: state.score ? {
        overall: state.score.overall,
        grade: state.score.grade.label,
        areas: Object.fromEntries(Object.values(state.score.areas).map((x) => [x.id, { score: x.score, weight: x.weight, issues: x.issues }]))
      } : null,
      issues: state.score ? state.score.ranked : []
    };
    download(`pagelens-${state.scan.page.host || 'page'}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), 'application/json');
    toast('Scan exported as JSON');
  }

  // ============================================================ init

  async function init() {
    await loadPrefs();
    await loadSecrets();
    applyTheme();
    if (!state.onboarded && !new URLSearchParams(location.search).has('tabId')) state.overlay = 'welcome';
    buildTabs();
    bindControls();

    // ?tabId= lets the popup run in a full tab (used later by "Full report" and for testing).
    const params = new URLSearchParams(location.search);
    let tab = null;
    try {
      if (params.has('tabId')) {
        tab = await chrome.tabs.get(Number(params.get('tabId')));
        document.body.classList.add('full');
      } else {
        [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      }
    } catch { tab = null; }

    if (!tab) {
      state.status = 'blocked';
      state.error = { title: 'No tab found', text: 'Open a website and click PageLens again.' };
      render();
      return;
    }
    state.tabId = tab.id;
    state.url = tab.url || '';
    state.repo = parseRepo(state.url);
    state.pkgTarget = /^https:\/\/(www\.)?(npmjs\.com|pypi\.org)\//.test(state.url) ? PKG.parse(state.url) : null;
    if (state.pkgTarget) {
      state.mode = 'package';
      buildTabs();
      loadPackage(state.pkgTarget);
    } else if (state.repo) {
      state.mode = 'github';
      buildTabs();
      loadRepo(state.repo); // runs alongside the website scan below
    }

    let hostLabel = tab.title || 'This tab';
    try {
      const u = new URL(state.url);
      hostLabel = u.protocol === 'file:' ? decodeURIComponent(u.pathname.split('/').pop() || 'Local file') : u.host + (u.pathname !== '/' ? u.pathname : '');
    } catch { /* keep title */ }
    $('#host').textContent = hostLabel;
    $('#host').title = hostLabel;

    const blocked = restrictedReason(state.url);
    if (blocked) {
      state.status = 'blocked';
      state.error = blocked;
      render();
      return;
    }
    await scan();
  }

  init();
})();
