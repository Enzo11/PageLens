/* PageLens — report/report.js
 * Full report in its own tab. The popup stores the raw inputs under
 * chrome.storage.session["report:<id>"]; this page recomputes everything with
 * the same pipeline (so results are identical) and renders all sections.
 * All page content is escaped by lib/export-html.js before insertion.
 */
'use strict';

(async () => {
  const $ = (s) => document.querySelector(s);
  const root = $('#root');
  const id = new URLSearchParams(location.search).get('id');
  const style = document.createElement('style');
  style.textContent = globalThis.PageLensHtml.CSS;
  document.head.append(style);

  let payload = null;
  try {
    const key = `report:${id}`;
    const area = chrome.storage.session || chrome.storage.local;
    payload = (await area.get(key))[key] || (await chrome.storage.local.get(key))[key] || null;
  } catch { payload = null; }

  if (!payload) {
    root.innerHTML = '<p class="err">This report has expired. Open PageLens on the page again and click “Full report”.</p>';
    return;
  }
  if (payload.theme === 'light' || payload.theme === 'dark') document.documentElement.setAttribute('data-theme', payload.theme);

  let derived = null;
  let report = null;
  if (payload.kind === 'web') {
    derived = globalThis.PageLensPipeline.website(payload);
  } else if (payload.kind === 'pkg') {
    report = globalThis.PageLensPackages.analyze(payload.raw);
  } else {
    report = globalThis.PageLensGitHub.analyze(payload.raw);
  }

  function model(role) {
    if (payload.kind === 'web') {
      const fixes = globalThis.PageLensPipeline.fixes({ assessment: derived.assessment, headers: payload.headers, scan: payload.scan, csp: derived.csp, tech: payload.tech, platform: payload.platform });
      return globalThis.PageLensReportModel.website({
        scan: payload.scan, score: derived.score, assessment: derived.assessment, csp: derived.csp, fixes, trackers: derived.trackers,
        tech: payload.tech, headers: payload.headers, cookies: payload.cookies, securityTxt: payload.securityTxt, diff: payload.diff, role, version: payload.version
      });
    }
    if (payload.kind === 'pkg') return globalThis.PageLensReportModel.packageReport(report, { role, version: payload.version, diff: payload.diff });
    return globalThis.PageLensReportModel.repository(report, { role, version: payload.version, diff: payload.diff });
  }

  let current = null;
  function draw(role) {
    current = model(role);
    root.innerHTML = globalThis.PageLensHtml.body(current); // escaped by the renderer
    document.title = current.title;
    $('#bar-title').textContent = current.subtitle || '';
  }

  const select = $('#role');
  select.value = payload.role || 'everyday';
  draw(select.value);
  select.addEventListener('change', () => draw(select.value));

  const download = (name, text, type) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const base = () => (payload.kind === 'web' ? payload.scan.page.host : payload.kind === 'pkg' ? `${report.pkg.ecosystem}-${report.pkg.name}` : report.repo.fullName).replace(/[^\w.-]+/g, '-');
  const day = new Date().toISOString().slice(0, 10);
  $('#dl-md').addEventListener('click', () => download(`pagelens-${base()}-${day}.md`, globalThis.PageLensMarkdown.render(current), 'text/markdown'));
  $('#dl-html').addEventListener('click', () => download(`pagelens-${base()}-${day}.html`, globalThis.PageLensHtml.document(current), 'text/html'));
  $('#print').addEventListener('click', () => window.print());
})();
