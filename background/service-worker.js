/* PageLens — background/service-worker.js
 *
 * Day 1 job: read the response headers of the page the user is looking at.
 * A content script cannot see headers, so we repeat ONE plain GET of the same
 * URL the browser already loaded, read the headers, and cancel the body.
 *
 * Passive by design:
 *   - no cookies sent (credentials: 'omit'), no custom headers, no retries
 *   - only the exact tab URL, never other paths
 *   - Set-Cookie is never read or stored
 *
 * Works when Chrome has granted host access for the tab's origin, either via
 * activeTab (user clicked the icon) or an optional per-site grant from the popup.
 */
'use strict';

const HEADER_TIMEOUT_MS = 8000;

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    const { prefs } = await chrome.storage.local.get('prefs');
    if (!prefs) await chrome.storage.local.set({ prefs: { role: 'everyday', theme: 'system' } });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg !== 'object') return false;

  if (msg.type === 'pagelens:headers') {
    fetchHeaders(msg.url)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: describeError(err) }));
    return true; // async response
  }
  if (msg.type === 'pagelens:securitytxt') {
    fetchSecurityTxt(msg.url)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: describeError(err) }));
    return true;
  }
  return false;
});

function stripUrl(raw) {
  try {
    const u = new URL(raw);
    return { url: u.origin + u.pathname, hasQuery: Boolean(u.search) };
  } catch {
    return { url: '', hasQuery: false };
  }
}

async function fetchHeaders(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'invalid-url' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'unsupported-scheme' };
  }
  url.hash = '';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
  const started = performance.now();

  try {
    const res = await fetch(url.href, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: controller.signal
    });

    const headers = {};
    res.headers.forEach((value, name) => {
      const key = name.toLowerCase();
      if (key === 'set-cookie' || key === 'set-cookie2') return;
      headers[key] = value.length > 4000 ? value.slice(0, 4000) + '…' : value;
    });

    // We only wanted the headers. Stop downloading the body.
    try { await res.body?.cancel(); } catch { /* already closed */ }

    const finalUrl = stripUrl(res.url);
    return {
      ok: true,
      status: res.status,
      statusText: res.statusText,
      redirected: res.redirected,
      finalUrl: finalUrl.url,
      finalScheme: (() => { try { return new URL(res.url).protocol.replace(':', ''); } catch { return ''; } })(),
      requestedScheme: url.protocol.replace(':', ''),
      headers,
      ms: Math.round(performance.now() - started)
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Only runs when the user clicks "Check security.txt". One GET to the
 * standard disclosure file defined by RFC 9116 — the file exists so that
 * people and tools can read it. No cookies, no other paths.
 */
async function fetchSecurityTxt(pageUrl) {
  let origin;
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'unsupported-scheme' };
    origin = u.origin;
  } catch {
    return { ok: false, error: 'invalid-url' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/.well-known/security.txt`, {
      method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'follow', referrerPolicy: 'no-referrer', signal: controller.signal
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { ok: true, found: false, status: res.status };
    }
    // Many sites answer every path with their HTML page; that is not a security.txt.
    if (/text\/html/i.test(type)) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { ok: true, found: false, status: res.status, note: 'html' };
    }
    const text = (await res.text()).slice(0, 32000);
    return { ok: true, found: true, status: res.status, text, contentType: type, redirected: res.redirected };
  } finally {
    clearTimeout(timer);
  }
}

function describeError(err) {
  if (err && err.name === 'AbortError') return 'timeout';
  // A TypeError from fetch almost always means Chrome did not grant host
  // access for this origin (CORS applies), or the network failed.
  if (err instanceof TypeError) return 'no-access';
  return String((err && err.message) || err || 'unknown');
}
