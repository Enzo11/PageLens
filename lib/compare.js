/* PageLens — lib/compare.js
 * Side-by-side comparison of two history snapshots of the same kind
 * (two websites, two repositories, two packages, or two checks of one).
 * Pure: snapshots in, rows out. Also renders the result as Markdown.
 */
(function (root) {
  'use strict';

  const AREA_LABEL = {
    accessibility: 'Accessibility', performance: 'Performance', uiux: 'UI/UX', security: 'Privacy & security', design: 'Design consistency', seo: 'SEO',
    activity: 'Activity', releases: 'Releases', contributors: 'Contributors', license: 'License', community: 'Community response', engineering: 'Tests & CI',
    maintenance: 'Maintenance', popularity: 'Popularity', information: 'Metadata'
  };
  const METRIC = {
    web: [['bytes', 'Page size', 'lower', 'bytes'], ['requests', 'Requests', 'lower'], ['lcp', 'Main content (LCP)', 'lower', 'ms'], ['cls', 'Layout shift (CLS)', 'lower'], ['ttfb', 'Server reply', 'lower', 'ms'], ['elements', 'Elements', 'lower']],
    repo: [['stars', 'Stars', 'higher'], ['forks', 'Forks', 'higher'], ['contributors', 'Contributors', 'higher'], ['lastCommitDays', 'Days since last change', 'lower'], ['openIssues', 'Open issues + PRs', 'none']],
    pkg: [['downloadsWeek', 'Weekly downloads', 'higher'], ['versions', 'Versions', 'none'], ['dependencies', 'Dependencies', 'lower'], ['vulns', 'Known vulnerabilities', 'lower']]
  };

  const fmt = (v, unit) => {
    if (v == null) return '—';
    if (unit === 'bytes') return v < 1048576 ? `${Math.round(v / 1024)} KB` : `${(v / 1048576).toFixed(2)} MB`;
    if (unit === 'ms') return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`;
    return typeof v === 'number' ? v.toLocaleString('en-US') : String(v);
  };

  function winner(a, b, dir) {
    if (a == null || b == null || a === b || dir === 'none') return null;
    return (dir === 'higher' ? a > b : a < b) ? 'a' : 'b';
  }

  function compare(A, B) {
    if (!A || !B) return null;
    if (A.kind !== B.kind) return { error: 'different-kinds' };
    const rows = [];
    rows.push({ group: 'Score', label: 'Overall', a: A.overall, b: B.overall, win: winner(A.overall, B.overall, 'higher'), aText: `${A.overall} · ${A.grade}`, bText: `${B.overall} · ${B.grade}` });
    for (const k of Object.keys({ ...A.areas, ...B.areas })) {
      const a = A.areas[k];
      const b = B.areas[k];
      rows.push({ group: 'Score', label: AREA_LABEL[k] || k, a, b, win: winner(a, b, 'higher'), aText: fmt(a), bText: fmt(b) });
    }
    if (A.kind === 'web') rows.push({ group: 'Security', label: 'Header grade', a: A.headerGrade, b: B.headerGrade, win: null, aText: A.headerGrade || '—', bText: B.headerGrade || '—' });
    for (const [key, label, dir, unit] of METRIC[A.kind] || []) {
      const a = A.metrics[key];
      const b = B.metrics[key];
      rows.push({ group: 'Numbers', label, a, b, win: winner(a, b, dir), aText: fmt(a, unit), bText: fmt(b, unit) });
    }
    const listA = A.issues || A.risks || [];
    const listB = B.issues || B.risks || [];
    const sevs = A.kind === 'web' ? ['critical', 'high', 'medium', 'low'] : ['high', 'medium', 'low'];
    for (const sv of sevs) {
      const a = listA.filter((i) => i.sev === sv).length;
      const b = listB.filter((i) => i.sev === sv).length;
      rows.push({ group: A.kind === 'web' ? 'Issues' : 'Risks', label: sv[0].toUpperCase() + sv.slice(1), a, b, win: winner(a, b, 'lower'), aText: String(a), bText: String(b) });
    }
    const idsB = new Set(listB.map((i) => i.id));
    const idsA = new Set(listA.map((i) => i.id));
    const onlyA = listA.filter((i) => !idsB.has(i.id));
    const onlyB = listB.filter((i) => !idsA.has(i.id));
    const both = listA.filter((i) => idsB.has(i.id));
    const extra = {};
    if (A.kind === 'web') {
      extra.fonts = { a: A.design.fonts, b: B.design.fonts };
      extra.colors = { a: A.design.colors, b: B.design.colors };
      extra.trackers = { a: A.trackers, b: B.trackers };
      extra.tech = { a: A.tech.map((t) => t.name), b: B.tech.map((t) => t.name) };
    }
    if (A.release || B.release) extra.release = { a: A.release || null, b: B.release || null };
    const scored = rows.filter((r) => r.win);
    const tally = { a: scored.filter((r) => r.win === 'a').length, b: scored.filter((r) => r.win === 'b').length };
    return { kind: A.kind, a: { title: A.title, url: A.url, at: A.at }, b: { title: B.title, url: B.url, at: B.at }, rows, onlyA, onlyB, both, extra, tally, sameTarget: A.url === B.url };
  }

  function markdown(c) {
    const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|');
    const d = (t) => new Date(t).toISOString().slice(0, 10);
    const name = (x) => (c.sameTarget ? `${x.title} (${d(x.at)})` : x.title);
    const L = [`# PageLens comparison`, '', `**A:** ${cell(name(c.a))} — ${c.a.url}  `, `**B:** ${cell(name(c.b))} — ${c.b.url}`, ''];
    L.push(`A is better on ${c.tally.a} measures, B on ${c.tally.b}.`, '');
    L.push('| | A | B |', '|---|---:|---:|');
    for (const r of c.rows) L.push(`| ${cell(r.label)} | ${r.win === 'a' ? '**' + cell(r.aText) + '**' : cell(r.aText)} | ${r.win === 'b' ? '**' + cell(r.bText) + '**' : cell(r.bText)} |`);
    L.push('');
    if (c.onlyA.length) { L.push(`**Only in A (${c.onlyA.length})**`, ''); for (const i of c.onlyA) L.push(`- ${cell(i.title)} (${i.sev})`); L.push(''); }
    if (c.onlyB.length) { L.push(`**Only in B (${c.onlyB.length})**`, ''); for (const i of c.onlyB) L.push(`- ${cell(i.title)} (${i.sev})`); L.push(''); }
    if (c.extra.fonts) L.push(`**Fonts:** A ${c.extra.fonts.a.join(', ') || '—'} · B ${c.extra.fonts.b.join(', ') || '—'}`, '');
    if (c.extra.trackers) L.push(`**Trackers:** A ${c.extra.trackers.a.join(', ') || 'none'} · B ${c.extra.trackers.b.join(', ') || 'none'}`, '');
    L.push('Generated by PageLens.', '');
    return L.join('\n');
  }

  root.PageLensCompare = Object.freeze({ compare, markdown });
})(globalThis);
