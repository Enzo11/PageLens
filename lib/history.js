/* PageLens — lib/history.js
 *
 * Change tracker. Each scan is reduced to a small snapshot and stored in
 * chrome.storage.local (this computer only). The newest snapshot is compared
 * with the one before it so the popup can say what got better or worse.
 *
 * Layout:
 *   hist:index        [{key, kind, title, url, last, score, grade, count}]  newest first
 *   hist:<key>        [snapshot, …]                                         newest first
 *
 * Snapshots and diffs are plain data. snapshot*() and diff() are pure;
 * only save/list/recent/clear touch storage.
 */
(function (root) {
  'use strict';

  const INDEX = 'hist:index';
  const PER_PAGE = 12;
  const MAX_PAGES = 60;
  const MERGE_WINDOW_MS = 30 * 60 * 1000; // rescans within 30 min replace the latest entry
  const V = 1;

  const store = () => (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local ? chrome.storage.local : null);

  function keyForUrl(url) {
    try {
      const u = new URL(url);
      return `web:${u.host}${u.pathname.replace(/\/+$/, '') || '/'}`.toLowerCase();
    } catch {
      return null;
    }
  }
  const keyForRepo = (fullName) => `repo:${String(fullName).toLowerCase()}`;
  const keyForPackage = (ecosystem, name) => `pkg:${String(ecosystem).toLowerCase()}:${String(name).toLowerCase()}`;

  // ------------------------------------------------------------ snapshots (pure)

  function snapshotWebsite({ scan, score, assessment, trackers, tech, at }) {
    const p = scan.performance;
    return {
      v: V,
      kind: 'web',
      at: at || scan.scannedAt,
      url: scan.page.url,
      title: scan.page.title || scan.page.host,
      overall: score.overall,
      grade: score.grade.label,
      areas: Object.fromEntries(Object.values(score.areas).map((a) => [a.id, a.score])),
      headerGrade: assessment && assessment.available ? assessment.grade : null,
      issues: score.ranked.map((i) => ({ id: i.id, sev: i.severity, area: i.area, title: i.title })),
      metrics: {
        bytes: p.totalBytes,
        requests: p.requests,
        lcp: p.lcp ? p.lcp.time : null,
        cls: p.cls,
        ttfb: p.navigation ? p.navigation.ttfb : null,
        elements: scan.page.elementCount
      },
      design: {
        colors: scan.design.palette.slice(0, 10).map((c) => c.hex),
        fonts: scan.design.fonts.slice(0, 5).map((f) => f.family)
      },
      trackers: trackers ? trackers.companies.filter((c) => c.tracking).map((c) => c.company) : [],
      tech: (tech || []).map((t) => ({ name: t.name, version: t.version || null }))
    };
  }

  function snapshotRepo(report, at) {
    const t = report.trust;
    return {
      v: V,
      kind: 'repo',
      at: at || report.meta.fetchedAt,
      url: report.repo.url,
      title: report.repo.fullName,
      overall: t.score,
      grade: t.verdict.label,
      areas: { ...t.parts },
      risks: t.risks.map((r) => ({ id: `${r.level}:${r.text}:${String(r.detail || '').slice(0, 80)}`, sev: r.level, title: r.text })),
      metrics: {
        stars: report.repo.stars,
        forks: report.repo.forks,
        openIssues: t.popularity.openIssues,
        lastCommitDays: t.lastCommit.days,
        contributors: t.contributors.count
      },
      release: t.releases.latest ? t.releases.latest.tag : null
    };
  }

  function snapshotPackage(report, at) {
    return {
      v: V,
      kind: 'pkg',
      at: at || report.meta.fetchedAt,
      url: report.pkg.registryUrl,
      title: `${report.pkg.name} (${report.pkg.ecosystem})`,
      overall: report.score,
      grade: report.verdict.label,
      areas: { ...report.parts },
      risks: report.risks.map((r) => ({ id: `${r.level}:${r.text}`, sev: r.level, title: r.text })),
      metrics: {
        downloadsWeek: report.downloads.week,
        versions: report.releases.count,
        dependencies: report.dependencies.list.length,
        vulns: report.security.vulns.length
      },
      release: report.pkg.latest
    };
  }

  const fingerprint = (s) => JSON.stringify([s.overall, s.areas, (s.issues || s.risks || []).map((i) => i.id), s.headerGrade || null]);

  // ------------------------------------------------------------ diff (pure)

  function listDiff(prev = [], cur = []) {
    const a = new Set(prev);
    const b = new Set(cur);
    return { added: cur.filter((x) => !a.has(x)), removed: prev.filter((x) => !b.has(x)) };
  }

  function metricChange(name, before, after, { lowerIsBetter = true, minAbs = 0, minPct = 0.1 } = {}) {
    if (before == null || after == null || before === after) return null;
    const delta = after - before;
    const pct = before ? delta / before : null;
    if (Math.abs(delta) < minAbs) return null;
    if (pct != null && Math.abs(pct) < minPct) return null;
    return { name, before, after, delta, pct, better: lowerIsBetter ? delta < 0 : delta > 0 };
  }

  function diff(prev, cur) {
    if (!prev || !cur || prev.kind !== cur.kind) return null;
    const out = {
      kind: cur.kind,
      since: prev.at,
      overall: { before: prev.overall, after: cur.overall, delta: cur.overall - prev.overall },
      areas: Object.keys(cur.areas).map((k) => ({ id: k, before: prev.areas[k], after: cur.areas[k], delta: (cur.areas[k] ?? 0) - (prev.areas[k] ?? 0) })).filter((x) => x.before != null && x.delta !== 0),
      metrics: []
    };
    const pi = prev.issues || prev.risks || [];
    const ci = cur.issues || cur.risks || [];
    const prevIds = new Set(pi.map((i) => i.id));
    const curIds = new Set(ci.map((i) => i.id));
    out.fixed = pi.filter((i) => !curIds.has(i.id));
    out.added = ci.filter((i) => !prevIds.has(i.id));
    // Same finding, different size or severity ("3 images…" → "1 image…").
    const prevById = new Map(pi.map((i) => [i.id, i]));
    out.changed = ci.filter((i) => prevById.has(i.id) && (prevById.get(i.id).title !== i.title || prevById.get(i.id).sev !== i.sev))
      .map((i) => ({ id: i.id, before: prevById.get(i.id).title, after: i.title, sevBefore: prevById.get(i.id).sev, sev: i.sev }));

    if (cur.kind === 'web') {
      const m = [
        metricChange('Page size', prev.metrics.bytes, cur.metrics.bytes, { minAbs: 20 * 1024 }),
        metricChange('Requests', prev.metrics.requests, cur.metrics.requests, { minAbs: 3 }),
        metricChange('Main content (LCP)', prev.metrics.lcp, cur.metrics.lcp, { minAbs: 200, minPct: 0.15 }),
        metricChange('Layout shift (CLS)', prev.metrics.cls, cur.metrics.cls, { minAbs: 0.03, minPct: 0 }),
        metricChange('Elements', prev.metrics.elements, cur.metrics.elements, { minAbs: 100 })
      ].filter(Boolean);
      out.metrics = m;
      out.headerGrade = prev.headerGrade !== cur.headerGrade ? { before: prev.headerGrade, after: cur.headerGrade } : null;
      out.colors = listDiff(prev.design.colors, cur.design.colors);
      out.fonts = listDiff(prev.design.fonts, cur.design.fonts);
      out.trackers = listDiff(prev.trackers, cur.trackers);
      const pv = new Map(prev.tech.map((t) => [t.name, t.version]));
      const cv = new Map(cur.tech.map((t) => [t.name, t.version]));
      out.tech = {
        added: cur.tech.filter((t) => !pv.has(t.name)).map((t) => t.name),
        removed: prev.tech.filter((t) => !cv.has(t.name)).map((t) => t.name),
        upgraded: cur.tech.filter((t) => pv.has(t.name) && pv.get(t.name) && t.version && pv.get(t.name) !== t.version).map((t) => ({ name: t.name, from: pv.get(t.name), to: t.version }))
      };
    } else if (cur.kind === 'pkg') {
      out.metrics = [
        metricChange('Weekly downloads', prev.metrics.downloadsWeek, cur.metrics.downloadsWeek, { lowerIsBetter: false, minPct: 0.15 }),
        metricChange('Dependencies', prev.metrics.dependencies, cur.metrics.dependencies, { minAbs: 1, minPct: 0 }),
        metricChange('Known vulnerabilities', prev.metrics.vulns, cur.metrics.vulns, { minAbs: 1, minPct: 0 })
      ].filter(Boolean);
      out.release = prev.release !== cur.release ? { before: prev.release, after: cur.release } : null;
    } else {
      out.metrics = [
        metricChange('Stars', prev.metrics.stars, cur.metrics.stars, { lowerIsBetter: false, minAbs: 1, minPct: 0 }),
        metricChange('Forks', prev.metrics.forks, cur.metrics.forks, { lowerIsBetter: false, minAbs: 1, minPct: 0 }),
        metricChange('Open issues + PRs', prev.metrics.openIssues, cur.metrics.openIssues, { minAbs: 1, minPct: 0 }),
        metricChange('Contributors', prev.metrics.contributors, cur.metrics.contributors, { lowerIsBetter: false, minAbs: 1, minPct: 0 })
      ].filter(Boolean);
      out.release = prev.release !== cur.release ? { before: prev.release, after: cur.release } : null;
    }
    out.empty = !out.overall.delta && !out.areas.length && !out.fixed.length && !out.added.length && !out.changed.length && !out.metrics.length &&
      !(out.headerGrade) && !(out.release) &&
      !(out.colors && (out.colors.added.length || out.colors.removed.length)) && !(out.fonts && (out.fonts.added.length || out.fonts.removed.length)) &&
      !(out.trackers && (out.trackers.added.length || out.trackers.removed.length)) &&
      !(out.tech && (out.tech.added.length || out.tech.removed.length || out.tech.upgraded.length));
    return out;
  }

  // ------------------------------------------------------------ storage

  async function list(key) {
    const s = store();
    if (!s || !key) return [];
    try {
      const got = await s.get(`hist:${key}`);
      return Array.isArray(got[`hist:${key}`]) ? got[`hist:${key}`] : [];
    } catch {
      return [];
    }
  }

  async function recent(limit = 30) {
    const s = store();
    if (!s) return [];
    try {
      const got = await s.get(INDEX);
      return (got[INDEX] || []).slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * Save a snapshot. Returns {prev, list, replaced}: `prev` is the snapshot the
   * new one should be compared with.
   */
  async function save(key, snap) {
    const s = store();
    if (!s || !key) return { prev: null, list: [snap], replaced: false };
    const items = await list(key);
    let replaced = false;
    if (items[0] && snap.at - items[0].at < MERGE_WINDOW_MS && snap.at >= items[0].at) {
      // A quick rescan: keep the newer result, compare with the one before.
      items[0] = snap;
      replaced = true;
    } else if (items[0] && fingerprint(items[0]) === fingerprint(snap) && snap.at - items[0].at < 24 * 3600 * 1000) {
      items[0] = { ...snap, firstSeen: items[0].firstSeen || items[0].at };
      replaced = true;
    } else {
      items.unshift(snap);
    }
    const trimmed = items.slice(0, PER_PAGE);
    const got = await s.get(INDEX).catch(() => ({}));
    let index = (got[INDEX] || []).filter((e) => e.key !== key);
    index.unshift({ key, kind: snap.kind, title: snap.title, url: snap.url, last: snap.at, score: snap.overall, grade: snap.grade, count: trimmed.length });
    const dropped = index.slice(MAX_PAGES).map((e) => `hist:${e.key}`);
    index = index.slice(0, MAX_PAGES);
    try {
      await s.set({ [`hist:${key}`]: trimmed, [INDEX]: index });
      if (dropped.length) await s.remove(dropped);
    } catch {
      /* storage full: history is optional */
    }
    return { prev: trimmed[1] || null, list: trimmed, replaced };
  }

  async function clear(key) {
    const s = store();
    if (!s) return;
    if (key) {
      const got = await s.get(INDEX).catch(() => ({}));
      await s.set({ [INDEX]: (got[INDEX] || []).filter((e) => e.key !== key) });
      await s.remove(`hist:${key}`);
      return;
    }
    const all = await s.get(null);
    await s.remove(Object.keys(all).filter((k) => k.startsWith('hist:')));
  }

  root.PageLensHistory = Object.freeze({ keyForUrl, keyForRepo, keyForPackage, snapshotWebsite, snapshotRepo, snapshotPackage, diff, save, list, recent, clear, fingerprint });
})(globalThis);
