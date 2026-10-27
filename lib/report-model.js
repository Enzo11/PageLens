/* PageLens — lib/report-model.js
 *
 * Builds one structured report document. Markdown (lib/export-markdown.js),
 * HTML (lib/export-html.js) and the full-report tab all render this same
 * model, so they always say the same thing.
 *
 * Model: { title, subtitle, meta[], sections: [{ id, title, intro?, blocks: [...] }] }
 * Block types:
 *   p        {text}
 *   kv       {rows: [[label, value]]}
 *   table    {head: [...], rows: [[...]], num?: [colIndex]}
 *   list     {items: [text | {text, sub, level, tone}]}
 *   issues   {items: issue[] , detail: bool}
 *   score    {value, label, tone, note, max}
 *   bars     {items: [{label, value, max, tone}]}
 *   palette  {items: [{hex, share, role}]}
 *   chips    {items: [text]}
 *   code     {lang, text, caption}
 *   outline  {items: [{level, text}]}
 *   note     {text}
 *
 * Pure. Everything is plain text; renderers escape it.
 */
(function (root) {
  'use strict';

  const SEV = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
  const EFFORT = { quick: 'Quick fix', moderate: 'Some work', involved: 'Bigger job' };

  const fmtBytes = (n) => (n == null || !Number.isFinite(n) ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(2)} MB`);
  const fmtMs = (ms) => (ms == null || !Number.isFinite(ms) || ms <= 0 ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
  const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(x < 0.1 && x > 0 ? 1 : 0)}%`);
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const toneFor = (n) => (n >= 90 ? 'good' : n >= 75 ? 'ok' : n >= 60 ? 'warn' : 'bad');
  const fileName = (url) => { const p = String(url || '').replace(/\/$/, '').split('/'); return p[p.length - 1] || url; };
  const date = (t) => new Date(t).toISOString().slice(0, 10);

  const WEB_ORDER = {
    everyday: ['verdict', 'security', 'fixes', 'performance', 'accessibility', 'uiux', 'profile', 'layout', 'design', 'seo'],
    designer: ['verdict', 'design', 'uiux', 'layout', 'accessibility', 'fixes', 'performance', 'profile', 'security', 'seo'],
    developer: ['verdict', 'fixes', 'performance', 'profile', 'security', 'layout', 'accessibility', 'seo', 'design', 'uiux'],
    security: ['verdict', 'security', 'fixes', 'profile', 'performance', 'accessibility', 'layout', 'uiux', 'seo', 'design']
  };
  const ROLE_NAME = { everyday: 'Everyday user', designer: 'Designer', developer: 'Developer', security: 'Security' };

  function diffBlocks(d) {
    if (!d) return [];
    if (d.empty) return [{ type: 'note', text: `No changes since the previous scan on ${date(d.since)}.` }];
    const items = [];
    const sign = (n) => (n > 0 ? `+${n}` : String(n));
    items.push({ text: `Score ${d.overall.before} → ${d.overall.after} (${sign(d.overall.delta)}) since ${date(d.since)}`, tone: d.overall.delta > 0 ? 'good' : d.overall.delta < 0 ? 'bad' : null });
    for (const a of d.areas) items.push({ text: `${a.id}: ${a.before} → ${a.after} (${sign(a.delta)})`, level: 1, tone: a.delta > 0 ? 'good' : 'bad' });
    for (const i of d.fixed) items.push({ text: `Fixed: ${i.title}`, tone: 'good' });
    for (const i of d.added) items.push({ text: `New: ${i.title}`, tone: 'bad' });
    for (const c of d.changed || []) items.push({ text: `Changed: ${c.after} (was: ${c.before})` });
    for (const m of d.metrics) items.push({ text: `${m.name}: ${m.before} → ${m.after}`, tone: m.better ? 'good' : 'bad' });
    if (d.headerGrade) items.push({ text: `Header grade ${d.headerGrade.before || '—'} → ${d.headerGrade.after || '—'}` });
    if (d.tech) for (const u of d.tech.upgraded) items.push({ text: `${u.name} ${u.from} → ${u.to}` });
    if (d.trackers) for (const t of d.trackers.added) items.push({ text: `New tracker: ${t}`, tone: 'bad' });
    if (d.release) items.push({ text: `New release: ${d.release.after}`, tone: 'good' });
    return [{ type: 'list', title: 'Changes since the last scan', items }];
  }

  // ============================================================ website

  /**
   * @param {object} c  scan, score, assessment, csp, fixes, trackers, tech, headers, cookies, securityTxt, diff, role, version
   */
  function website(c) {
    const { scan, score } = c;
    const role = WEB_ORDER[c.role] ? c.role : 'everyday';
    const byArea = (area, topic) => score.ranked.filter((i) => i.area === area && (!topic || i.topic === topic));
    const sec = {};

    // 1. Verdict
    sec.verdict = {
      title: 'Verdict',
      blocks: [
        { type: 'score', value: score.overall, max: 100, label: score.grade.label, tone: toneFor(score.overall), note: score.capped ? `Held below "Good" by a critical problem (would be ${score.uncapped}).` : null },
        { type: 'p', text: score.total ? `${plural(score.total, 'issue')}: ${score.counts.critical} critical, ${score.counts.high} high, ${score.counts.medium} medium, ${score.counts.low} low.` : 'The automatic checks found nothing to fix.' },
        { type: 'bars', items: Object.values(score.areas).map((a) => ({ label: `${a.label} (${Math.round(a.weight * 100)}%)`, value: a.score, max: 100, tone: toneFor(a.score) })) },
        ...(score.top.length ? [{ type: 'issues', title: 'Fix these first', items: score.top, detail: true }] : []),
        ...diffBlocks(c.diff)
      ]
    };

    // 2. Profile
    const nav = scan.performance.navigation;
    const hd = c.headers && c.headers.headers;
    sec.profile = {
      title: 'Site profile and tech stack',
      blocks: [
        { type: 'kv', rows: [
          ['Title', scan.page.title || '—'], ['Address', scan.page.url], ['Description', scan.meta.description || '—'],
          ['Language', scan.page.lang || 'not declared'], ['Protocol', nav && nav.protocol ? nav.protocol.toUpperCase() : '—'],
          ['Server', hd && hd.server ? hd.server : '—'], ['Generator', scan.meta.generator || '—']
        ] },
        c.tech && c.tech.length ? { type: 'table', head: ['Technology', 'Type', 'Version', 'Found via'], rows: c.tech.map((t) => [t.name, t.category, t.version || '—', t.evidence]) } : { type: 'note', text: 'No recognizable technology.' }
      ]
    };

    // 3. Design system
    const d = scan.design;
    const ts = d.typeScale;
    sec.design = {
      title: 'Design system',
      blocks: [
        { type: 'palette', title: 'Colors by usage', items: d.palette.slice(0, 16).map((p) => ({ hex: p.hex, share: p.share, role: p.kind === 'accent' ? 'accent' : (p.roles.background >= p.roles.text ? 'background' : 'text') })) },
        d.nearDuplicates.length ? { type: 'p', text: `Near-duplicate colors: ${d.nearDuplicates.slice(0, 8).map((x) => `${x.a} ≈ ${x.b}`).join(', ')}.` } : null,
        { type: 'table', title: 'Fonts', head: ['Font', 'Used for', 'Weights', 'Share'], rows: d.fonts.slice(0, 6).map((f) => [f.family, f.primaryRole, f.weights.slice(0, 4).map((w) => w.weight).join(', '), pct(f.share)]), num: [3] },
        { type: 'table', title: `Type scale (base ${ts.basePx}px${ts.medianRatio ? `, ratio ≈ ${ts.medianRatio}${ts.scaleName ? ` ${ts.scaleName}` : ''}` : ''})`, head: ['Size', 'Used on', 'Line height', 'Share'], rows: ts.steps.slice(0, 10).map((s) => [`${s.px}px`, s.tags.join(', '), String(s.lineHeight), pct(s.share)]), num: [3] },
        { type: 'chips', title: `Spacing (${pct(d.spacing.onGrid8)} on an 8px grid, ${d.spacing.distinct} values)`, items: d.spacing.values.slice(0, 16).map((v) => `${v.px}px ×${v.count}`) },
        { type: 'chips', title: `Corner radius (${d.radii.distinct} values)`, items: d.radii.values.slice(0, 8).map((r) => `${r.value} ×${r.count}`) },
        d.shadows.values.length ? { type: 'list', title: `Shadows (${d.shadows.distinct})`, items: d.shadows.values.slice(0, 4).map((s) => `${s.value} ×${s.count}`) } : null,
        { type: 'kv', title: 'Components', rows: [['Buttons', `${d.components.buttons} (${d.components.buttonVariants.length} styles)`], ['Links', String(d.components.links)], ['Form inputs', String(d.components.inputs)], ['Images', String(d.components.images)], ['Cards', String(d.components.cards)], ['Navigation menus', String(d.components.navs)]] },
        byArea('design').length ? { type: 'issues', title: 'Consistency issues', items: byArea('design'), detail: true } : { type: 'note', text: 'No design consistency issues found.' }
      ].filter(Boolean)
    };

    // 4. Layout and structure
    const st = scan.structure;
    sec.layout = {
      title: 'Layout and structure',
      blocks: [
        st.headings.length ? { type: 'outline', title: 'Heading outline', items: st.headings.slice(0, 60).map((x) => ({ level: x.level, text: x.empty ? '(empty heading)' : x.text })) } : { type: 'note', text: 'No headings.' },
        { type: 'list', title: 'Landmarks', items: st.landmarks.length ? st.landmarks.map((l) => `${l.role}${l.label ? ` — ${l.label}` : ''}`) : ['None marked up'] },
        { type: 'list', title: 'Page sections (top level)', items: st.sections.slice(0, 20).map((s) => `${s.heading || s.role || `<${s.tag}>`} · ${s.height}px`) }
      ]
    };

    // 5. UI/UX
    const rd = scan.text.readability;
    sec.uiux = {
      title: 'UI/UX review',
      blocks: [
        { type: 'kv', rows: [['Body text', `${rd.basePx}px, line-height ${rd.baseLineHeight || '—'}`], ['Line length', rd.medianLineChars ? `~${rd.medianLineChars} characters` : '—'], ['Text under 12px', pct(rd.smallTextShare)],
          ['Forms', `${scan.interaction.forms.length} (${scan.interaction.fields.length} fields)`], ['First-screen actions', scan.interaction.ctas.slice(0, 3).map((x) => x.label || '(no label)').join(', ') || 'none']] },
        byArea('uiux').length ? { type: 'issues', items: byArea('uiux'), detail: true } : { type: 'note', text: 'No UI/UX issues found.' }
      ]
    };

    // 6. Accessibility
    const contrast = score.ranked.find((i) => i.rule === 'contrast');
    sec.accessibility = {
      title: 'Accessibility (WCAG 2.2)',
      blocks: [
        { type: 'score', value: score.areas.accessibility.score, max: 100, label: score.areas.accessibility.grade.label, tone: toneFor(score.areas.accessibility.score) },
        byArea('accessibility').length ? { type: 'issues', items: byArea('accessibility'), detail: true } : { type: 'note', text: 'No accessibility issues found by the automatic checks.' },
        contrast && contrast.data ? { type: 'table', title: 'Contrast fixes', head: ['Text', 'Background', 'Ratio', 'Needs', 'Suggested color'], rows: contrast.data.pairs.map((p) => [p.fg, p.bg, `${p.ratio}:1`, `${p.need}:1`, p.suggestion || '—']) } : null,
        { type: 'note', text: 'Focus outlines, Tab order and click-only elements are checked from the page code. Not automated: focus order compared with visual order, and text over images. A quick Tab through the page is still the best final test.' }
      ].filter(Boolean)
    };

    // 7. Performance
    const p = scan.performance;
    sec.performance = {
      title: 'Performance',
      blocks: [
        { type: 'kv', rows: [['Page size', fmtBytes(p.totalBytes)], ['Requests', String(p.requests)], ['Server reply (TTFB)', fmtMs(nav && nav.ttfb)], ['First paint', fmtMs(p.fcp)], ['Main content (LCP)', fmtMs(p.lcp && p.lcp.time)], ['Layout shift (CLS)', String(p.cls)], ['Fully loaded', fmtMs(nav && nav.load)]] },
        { type: 'table', title: 'Weight by type', head: ['Type', 'Files', 'Size'], rows: Object.entries(p.byType).sort((a, b) => b[1].bytes - a[1].bytes).map(([k, v]) => [k, String(v.count), fmtBytes(v.bytes)]), num: [1, 2] },
        { type: 'table', title: 'Heaviest files', head: ['File', 'Type', 'Party', 'Size'], rows: p.heaviest.filter((r) => r.bytes > 0).slice(0, 10).map((r) => [fileName(r.url), r.kind, r.thirdParty ? '3rd' : '1st', fmtBytes(r.bytes)]), num: [3] },
        byArea('performance').length ? { type: 'issues', items: byArea('performance'), detail: true } : { type: 'note', text: 'No performance issues found.' }
      ]
    };

    // 8. Privacy and security
    const A = c.assessment;
    const secBlocks = [];
    if (A && A.available) {
      secBlocks.push({ type: 'score', value: A.score, max: 100, label: `Header grade ${A.grade}`, tone: A.grade.startsWith('A') ? 'good' : A.grade.startsWith('B') ? 'ok' : A.grade.startsWith('C') ? 'warn' : 'bad', note: 'Mozilla HTTP Observatory method, one passive response.' });
    }
    secBlocks.push(byArea('security').length ? { type: 'issues', items: byArea('security'), detail: true } : { type: 'note', text: 'No privacy or security issues found.' });
    if (A && A.available) {
      secBlocks.push({ type: 'table', title: 'Header tests', head: ['Test', 'Result', 'Points'], rows: A.tests.map((t) => [t.label, t.result, t.status === 'na' ? 'n/a' : `${t.modifier > 0 ? '+' : ''}${t.modifier}`]), num: [2] });
      secBlocks.push({ type: 'table', title: 'Security-related response headers', head: ['Header', 'Status', 'Value'], rows: A.table.filter((r) => r.security).map((r) => [r.name, { good: 'OK', weak: 'Weak', missing: 'Missing', bad: 'Problem', info: 'Info', na: 'n/a' }[r.status] || '', r.value == null ? '—' : r.value.length > 180 ? r.value.slice(0, 179) + '…' : r.value]) });
    } else {
      secBlocks.push({ type: 'note', text: 'Response headers were not available, so the header grade is missing.' });
    }
    if (c.trackers && (c.trackers.companies.length || c.trackers.unknown.length)) {
      secBlocks.push({ type: 'table', title: 'Third parties', head: ['Company', 'Purpose', 'Hosts', 'Requests'], rows: [
        ...c.trackers.companies.map((t) => [t.company, t.categories.join(', '), t.hosts.join(', '), String(t.requests)]),
        ...c.trackers.unknown.map((u) => ['(unrecognized)', '—', u.host, String(u.count)])
      ], num: [3] });
    }
    if (c.cookies && c.cookies.length) {
      secBlocks.push({ type: 'table', title: 'Cookie flags (values never read)', head: ['Name', 'Secure', 'HttpOnly', 'SameSite'], rows: c.cookies.map((k) => [k.name, k.secure ? 'Yes' : 'No', k.httpOnly ? 'Yes' : 'No', { no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: '—' }[k.sameSite] || k.sameSite]) });
    }
    if (c.fixes && (c.fixes.set.length || c.fixes.remove.length || c.fixes.serverLeak)) {
      secBlocks.push({ type: 'code', title: `Recommended configuration (${c.fixes.label})`, caption: `Put this in ${c.fixes.file}. Test on staging first.`, lang: c.fixes.platform === 'vercel' ? 'json' : c.fixes.platform === 'iis' ? 'xml' : c.fixes.platform === 'nextjs' || c.fixes.platform === 'express' ? 'js' : '', text: c.fixes.snippet });
    }
    if (c.csp) {
      secBlocks.push({ type: 'code', title: 'Suggested Content-Security-Policy (allowlist)', caption: 'Deploy as Report-Only first.', text: `Content-Security-Policy-Report-Only: ${c.csp.allowlist}` });
      secBlocks.push({ type: 'code', title: 'Suggested Content-Security-Policy (strict, nonce-based)', text: `Content-Security-Policy-Report-Only: ${c.csp.strict}` });
    }
    if (c.securityTxt) {
      secBlocks.push({ type: 'p', text: c.securityTxt.found ? `security.txt: contact ${c.securityTxt.contact.join(', ') || 'missing'}, expires ${c.securityTxt.expires || 'not set'}${c.securityTxt.expired ? ' (expired)' : ''}.` : 'security.txt: not found.' });
    }
    secBlocks.push({ type: 'note', text: 'Passive checks only: PageLens reads what the browser loaded plus one ordinary request for headers without cookies. It never sends attack traffic or logs in, and never reads cookie, storage or form values.' });
    sec.security = { title: 'Privacy and security', blocks: secBlocks };

    // 9. SEO
    const m = scan.meta;
    sec.seo = {
      title: 'SEO basics',
      blocks: [
        { type: 'kv', rows: [['Title', `${scan.page.title || '—'} (${(scan.page.title || '').length} characters)`], ['Description', m.description ? `${m.description} (${m.description.length} characters)` : '—'], ['Canonical', m.canonical || '—'], ['Robots', m.robots || 'default'], ['Social preview', m.og.title && m.og.image ? 'Yes' : 'No'], ['Structured data', m.structuredData.join(', ') || 'none']] },
        byArea('seo').length ? { type: 'issues', items: byArea('seo'), detail: true } : { type: 'note', text: 'No SEO issues found.' }
      ]
    };

    // 10. Fix list
    sec.fixes = {
      title: 'Fix list (ranked by impact ÷ effort)',
      blocks: score.ranked.length
        ? [{ type: 'table', head: ['#', 'Severity', 'Area', 'Effort', 'Problem', 'How to fix'], rows: score.ranked.map((i, n) => [String(n + 1), SEV[i.severity], (score.areas[i.area] || {}).label || i.area, EFFORT[i.effort], i.title, i.fix]) }]
        : [{ type: 'note', text: 'Nothing to fix.' }]
    };

    return {
      kind: 'web',
      title: `PageLens report: ${scan.page.host}`,
      subtitle: scan.page.title || scan.page.url,
      meta: [`Page: ${scan.page.url}`, `Scanned ${date(scan.scannedAt)}`, `View: ${ROLE_NAME[role]}`, `PageLens ${c.version || ''}`.trim()],
      sections: WEB_ORDER[role].map((id) => ({ id, ...sec[id] }))
    };
  }

  // ============================================================ repository

  const REPO_ORDER = {
    everyday: ['summary', 'trust', 'setup', 'contribute', 'code'],
    designer: ['summary', 'trust', 'setup', 'code', 'contribute'],
    developer: ['summary', 'setup', 'code', 'trust', 'contribute'],
    security: ['trust', 'summary', 'setup', 'code', 'contribute']
  };

  function repository(rep, { role = 'everyday', version, diff: d } = {}) {
    const r = WEB_ORDER[role] ? role : 'everyday';
    const t = rep.trust;
    const sec = {};
    sec.summary = {
      title: 'Summary',
      blocks: [
        rep.summary.paragraph.startsWith(rep.summary.oneLine) ? null : { type: 'p', text: rep.summary.oneLine },
        { type: 'p', text: rep.summary.paragraph },
        rep.languages.length ? { type: 'chips', title: 'Languages', items: rep.languages.slice(0, 8).map((l) => `${l.name} ${pct(l.share)}`) } : null,
        rep.stack.length ? { type: 'chips', title: 'Built with', items: rep.stack.map((s) => s.name) } : null,
        rep.summary.features.length ? { type: 'list', title: 'Highlights', items: rep.summary.features } : null,
        rep.summary.sections.length ? { type: 'kv', title: 'README sections', rows: rep.summary.sections.map((s) => [s.heading, s.text]) } : null,
        rep.language ? { type: 'note', text: `The README is written in ${rep.language.name}.` } : null
      ].filter(Boolean)
    };
    const st = rep.setup;
    sec.setup = {
      title: 'Install and run',
      blocks: [
        st.prereqs.length ? { type: 'kv', title: 'You will need', rows: st.prereqs.map((p) => [p.name, `${p.value} (from ${p.source})`]) } : null,
        ...st.readme.flatMap((x) => x.commands.map((cmd, i) => ({ type: 'code', title: i === 0 ? `From the README: ${x.heading}` : null, text: cmd }))),
        ...st.detected.flatMap((x) => x.commands.map((cmd) => ({ type: 'code', title: `${x.title} (${x.source})`, caption: x.note || null, text: cmd }))),
        ...st.notes.map((n) => ({ type: 'note', text: n })),
        { type: 'note', text: 'Commands come from the project itself. Read them before running anything.' }
      ].filter(Boolean)
    };
    const m = rep.map;
    sec.code = {
      title: 'Code map',
      blocks: m.hasTree ? [
        { type: 'kv', rows: [['Files', String(m.totals.files)], ['Size', fmtBytes(m.totals.bytes)], ['Folders', String(m.totals.dirs)], ['Test files', String(m.tests.count)]] },
        m.readFirst.length ? { type: 'table', title: 'Files to read first', head: ['File', 'Why'], rows: m.readFirst.map((f) => [f.path, f.reason]) } : null,
        m.top.length ? { type: 'table', title: 'Folders', head: ['Folder', 'What it holds', 'Files'], rows: m.top.map((x) => [`${x.name}/`, x.desc || '—', String(x.files)]), num: [2] } : null
      ].filter(Boolean) : [{ type: 'note', text: 'File list unavailable.' }]
    };
    sec.trust = {
      title: 'Trust',
      blocks: [
        { type: 'score', value: t.score, max: 100, label: t.verdict.label, tone: t.verdict.cls === 'good' ? 'good' : t.verdict.cls === 'warn' ? 'warn' : 'bad', note: t.verdict.text + (t.capped ? ` Held at 74 by a high risk (would be ${t.uncapped}).` : '') },
        { type: 'bars', items: Object.keys(t.partMax).map((k) => ({ label: k, value: t.parts[k], max: t.partMax[k], tone: t.parts[k] / t.partMax[k] >= 0.8 ? 'good' : t.parts[k] / t.partMax[k] >= 0.5 ? 'ok' : 'warn' })) },
        t.risks.length ? { type: 'list', title: 'Risks', items: t.risks.map((x) => ({ text: `${x.level.toUpperCase()}: ${x.text}`, sub: x.detail, tone: x.level === 'high' ? 'bad' : x.level === 'medium' ? 'warn' : null })) } : { type: 'note', text: 'No notable risks found.' },
        { type: 'list', title: 'Signals', items: t.reasons.map((x) => ({ text: x.text, tone: x.ok ? 'good' : 'warn' })) },
        { type: 'kv', title: 'Details', rows: [
          ['Last change', t.lastCommit.days != null ? `${t.lastCommit.days} days ago` : '—'],
          ['Commits in the last year', t.commitActivity.weeks.length ? String(t.commitActivity.total) : '—'],
          ['Latest release', t.releases.latest ? `${t.releases.latest.tag} (${date(t.releases.latest.date)})` : 'none'],
          ['Contributors', t.contributors.label],
          ['License', t.license.name || 'none'],
          ['Issue reply rate', t.issues.available && t.issues.responseRate != null ? pct(t.issues.responseRate) : '—'],
          ['PR merge rate', t.pulls.available && t.pulls.mergeRate != null ? pct(t.pulls.mergeRate) : '—'],
          ['Security policy', t.security.policy ? 'yes' : 'no'],
          ['Published advisories', t.security.advisories ? String(t.security.advisories.count) : '—'],
          ['CI actions pinned', t.security.workflows.actions ? `${t.security.workflows.pinned}/${t.security.workflows.actions}` : '—'],
          ['Stars / forks', `${rep.repo.stars} / ${rep.repo.forks}`]
        ] },
        ...diffBlocks(d)
      ].filter(Boolean)
    };
    const c = rep.contribute;
    sec.contribute = {
      title: 'Contribute',
      blocks: [
        c.goodFirst.length ? { type: 'table', title: 'Good first issues', head: ['#', 'Title', 'Opened'], rows: c.goodFirst.map((i) => [String(i.number), i.title, `${i.days} days ago`]) } : { type: 'note', text: 'No issues labelled for newcomers right now.' },
        c.requirements.length ? { type: 'list', title: 'Rules', items: c.requirements } : null,
        ...c.steps.map((s, i) => (s.command ? { type: 'code', title: `${i + 1}. ${s.title}`, text: s.command } : { type: 'p', text: `${i + 1}. ${s.title}${s.text ? ` — ${s.text}` : ''}` }))
      ].filter(Boolean)
    };
    return {
      kind: 'repo',
      title: `PageLens report: ${rep.repo.fullName}`,
      subtitle: rep.summary.oneLine,
      meta: [`Repository: ${rep.repo.url}`, `Data from ${date(rep.meta.fetchedAt)}`, `View: ${ROLE_NAME[r]}`, `PageLens ${version || ''}`.trim()],
      sections: REPO_ORDER[r].map((id) => ({ id, ...sec[id] }))
    };
  }

  // ============================================================ package

  function packageReport(r, { role = 'everyday', version, diff: d } = {}) {
    const p = r.pkg;
    const sec = {
      health: { title: 'Health', blocks: [
        { type: 'score', value: r.score, max: 100, label: r.verdict.label, tone: r.verdict.cls === 'good' ? 'good' : r.verdict.cls === 'warn' ? 'warn' : 'bad', note: r.verdict.text + (r.capped ? ` Held at 74 by a high risk (would be ${r.uncapped}).` : '') },
        { type: 'bars', items: Object.keys(r.partMax).map((k) => ({ label: k, value: r.parts[k], max: r.partMax[k], tone: r.parts[k] / r.partMax[k] >= 0.8 ? 'good' : r.parts[k] / r.partMax[k] >= 0.5 ? 'ok' : 'warn' })) },
        r.risks.length ? { type: 'list', title: 'Risks', items: r.risks.map((x) => ({ text: `${x.level.toUpperCase()}: ${x.text}`, sub: x.detail, tone: x.level === 'high' ? 'bad' : x.level === 'medium' ? 'warn' : null })) } : { type: 'note', text: 'No notable risks found.' },
        ...diffBlocks(d)
      ] },
      about: { title: 'About', blocks: [
        p.description ? { type: 'p', text: p.description } : null,
        { type: 'kv', rows: [['Ecosystem', p.ecosystem], ['Latest version', p.latest || '—'], ['License', p.license || 'none'], ['Weekly downloads', r.downloads.week != null ? String(r.downloads.week) : '—'],
          ['Repository', p.repository || 'not linked'], ['Homepage', p.homepage || '—'], [p.ecosystem === 'npm' ? 'Node.js' : 'Python', p.engines || '—']] },
        { type: 'code', title: 'Install', text: p.install }
      ].filter(Boolean) },
      security: { title: 'Security', blocks: [
        r.security.vulns.length ? { type: 'table', title: `Known vulnerabilities in ${p.latest}`, head: ['ID', 'Summary'], rows: r.security.vulns.map((v) => [v.id, v.summary || '—']) } : { type: 'note', text: r.security.vulnChecked ? 'No known vulnerabilities in the latest version (OSV).' : 'Vulnerability database not reached.' },
        { type: 'kv', rows: [
          p.ecosystem === 'npm' ? ['Install scripts', r.security.installScripts.length ? r.security.installScripts.map((x) => `${x.name}: ${x.script}`).join('; ') : 'none'] : ['Wheels', r.security.sdistOnly ? 'none (source only)' : String(r.security.wheels)],
          p.ecosystem === 'npm' ? ['Provenance', r.security.provenance ? 'yes' : 'no'] : null,
          ['Look-alike name', r.security.lookalike ? `close to "${r.security.lookalike}"` : 'no']
        ].filter(Boolean) }
      ] },
      releases: { title: 'Releases and dependencies', blocks: [
        { type: 'kv', rows: [['Versions', String(r.releases.count)], ['Last 12 months', String(r.releases.lastYear)], ['Latest release', r.releases.latestAt ? date(r.releases.latestAt) : '—'], ['First release', r.releases.first ? date(r.releases.first) : '—'], ['Maintainers', String(r.maintainers || '—')]] },
        r.dependencies.list.length ? { type: 'chips', title: `Dependencies (${r.dependencies.list.length})`, items: r.dependencies.list } : { type: 'note', text: 'No runtime dependencies.' }
      ] }
    };
    const order = role === 'developer' ? ['health', 'security', 'releases', 'about'] : role === 'security' ? ['security', 'health', 'releases', 'about'] : ['health', 'about', 'security', 'releases'];
    return {
      kind: 'pkg',
      title: `PageLens report: ${p.name} (${p.ecosystem})`,
      subtitle: p.description || '',
      meta: [`Package: ${p.registryUrl}`, `Data from ${date(r.meta.fetchedAt)}`, `View: ${ROLE_NAME[role] || ROLE_NAME.everyday}`, `PageLens ${version || ''}`.trim()],
      sections: order.map((id) => ({ id, ...sec[id] }))
    };
  }

  root.PageLensReportModel = Object.freeze({ website, repository, packageReport, WEB_ORDER, REPO_ORDER, SEV, EFFORT });
})(globalThis);
