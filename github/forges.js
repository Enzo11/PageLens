/* PageLens — github/forges.js
 *
 * Repository mode beyond GitHub. Collectors for GitLab (gitlab.com) and
 * Forgejo/Gitea (codeberg.org) that return the SAME "raw" shape as
 * PageLensGitHub.collect(), so analysis, tabs, exports and history all work
 * unchanged. Public data only, no tokens.
 *
 * Also owns URL/input parsing for every platform.
 */
(function (root) {
  'use strict';

  const DAY = 86400000;
  const RAW_VERSION = 2;

  const PLATFORMS = {
    github: { id: 'github', name: 'GitHub', host: 'github.com', prWord: 'pull request', prWords: 'pull requests' },
    gitlab: { id: 'gitlab', name: 'GitLab', host: 'gitlab.com', prWord: 'merge request', prWords: 'merge requests' },
    codeberg: { id: 'codeberg', name: 'Codeberg', host: 'codeberg.org', prWord: 'pull request', prWords: 'pull requests' }
  };
  const HOST_TO_PLATFORM = { 'github.com': 'github', 'www.github.com': 'github', 'gitlab.com': 'gitlab', 'www.gitlab.com': 'gitlab', 'codeberg.org': 'codeberg' };

  const GITLAB_RESERVED = new Set(['explore', 'users', 'dashboard', 'help', 'admin', 'search', 'groups', 'projects', '-', 'api', 'snippets', 'public', 'u', 'oauth', 'assets', 'abuse_reports']);
  const GITEA_RESERVED = new Set(['explore', 'user', 'repo', 'org', 'admin', 'api', 'notifications', 'issues', 'pulls', 'milestones', 'assets', '-']);
  const SEG = /^[A-Za-z0-9_.-]{1,100}$/;

  /**
   * Accepts any of:
   *   owner/repo                       (GitHub)
   *   gitlab:group/sub/project  codeberg:user/repo
   *   https://github.com/o/r/…  https://gitlab.com/g/s/p/-/tree/…  https://codeberg.org/u/r/src/…
   *   git@gitlab.com:g/p.git
   * Returns {platform, owner, repo, full} or null.
   */
  function parse(input) {
    let s = String(input || '').trim();
    if (!s) return null;
    const pref = /^(github|gitlab|codeberg):(.+)$/i.exec(s);
    if (pref) return fromPath(pref[1].toLowerCase(), pref[2].split('/').filter(Boolean));
    const ssh = /^git@([^:]+):(.+)$/.exec(s);
    if (ssh) s = `https://${ssh[1]}/${ssh[2]}`;
    if (!/^[a-z]+:\/\//i.test(s) && /^(www\.)?(github\.com|gitlab\.com|codeberg\.org)\//i.test(s)) s = 'https://' + s;
    if (/^https?:\/\//i.test(s)) {
      let u;
      try { u = new URL(s); } catch { return null; }
      const platform = HOST_TO_PLATFORM[u.hostname.toLowerCase()];
      if (!platform) return null;
      return fromPath(platform, u.pathname.split('/').filter(Boolean));
    }
    return fromPath('github', s.split('/').filter(Boolean));
  }

  function fromPath(platform, segs) {
    segs = segs.map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
    if (platform === 'gitlab') {
      const stop = segs.indexOf('-');
      const parts = (stop >= 0 ? segs.slice(0, stop) : segs).map((x) => x.replace(/\.git$/i, ''));
      if (parts.length < 2 || GITLAB_RESERVED.has(parts[0].toLowerCase()) || !parts.every((p) => SEG.test(p))) return null;
      const repo = parts[parts.length - 1];
      const owner = parts.slice(0, -1).join('/');
      return { platform, owner, repo, full: `${owner}/${repo}` };
    }
    const [owner, repoRaw] = segs;
    if (!owner || !repoRaw) return null;
    const repo = repoRaw.replace(/\.git$/i, '');
    if (platform === 'codeberg' && GITEA_RESERVED.has(owner.toLowerCase())) return null;
    if (platform === 'github') {
      const gh = root.PageLensGitHub && root.PageLensGitHub.parseRepoInput(`${owner}/${repo}`);
      return gh ? { platform, owner: gh.owner, repo: gh.repo, full: `${gh.owner}/${gh.repo}` } : null;
    }
    if (!SEG.test(owner) || !SEG.test(repo)) return null;
    return { platform, owner, repo, full: `${owner}/${repo}` };
  }

  // ------------------------------------------------------------ shared helpers

  class ForgeError extends Error {
    constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
  }

  function client(fetchImpl, rate, platformName) {
    let calls = 0;
    async function get(url, { allow404 = false, text = false } = {}) {
      calls += 1;
      let res;
      try {
        res = await fetchImpl(url, { credentials: 'omit', cache: 'no-store', headers: text ? {} : { Accept: 'application/json' } });
      } catch {
        throw new ForgeError('network', `Could not reach ${platformName}.`);
      }
      const rem = res.headers.get('ratelimit-remaining') || res.headers.get('x-ratelimit-remaining');
      if (rem != null) {
        const n = Number(rem);
        if (rate.remaining == null || n < rate.remaining) {
          rate.remaining = n;
          rate.limit = Number(res.headers.get('ratelimit-limit') || res.headers.get('x-ratelimit-limit')) || null;
          const reset = Number(res.headers.get('ratelimit-reset') || res.headers.get('x-ratelimit-reset'));
          rate.reset = reset ? reset * 1000 : null;
        }
      }
      if (res.status === 404 && allow404) return { status: 404, data: null, headers: res.headers };
      if (res.status === 429) throw new ForgeError('rate-limit', `${platformName}'s request limit is used up for now.`, { reset: rate.reset });
      if (res.status === 404 || res.status === 401) throw new ForgeError('not-found', 'Repository not found, or it is private.');
      if (res.status === 403) throw new ForgeError('forbidden', `${platformName} refused the request.`);
      if (!res.ok) throw new ForgeError('http', `${platformName} answered ${res.status}.`);
      if (text) return { status: res.status, data: await res.text(), headers: res.headers };
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      return { status: res.status, data, headers: res.headers };
    }
    return { get, calls: () => calls };
  }

  async function soft(name, partial, fn) {
    try { return await fn(); } catch (err) {
      if (err && err.code === 'rate-limit') throw err;
      partial.push(name);
      return null;
    }
  }

  function treeStats(entries) {
    const top = {};
    let files = 0;
    let bytes = 0;
    let dirs = 0;
    for (const e of entries) {
      const first = e.path.split('/')[0];
      if (e.type === 'tree') { dirs += 1; if (!e.path.includes('/')) top[first] = top[first] || { files: 0, bytes: 0 }; continue; }
      files += 1;
      bytes += e.size || 0;
      if (e.path.includes('/')) { const t = top[first] || (top[first] = { files: 0, bytes: 0 }); t.files += 1; t.bytes += e.size || 0; }
    }
    return { files, bytes, dirs, top };
  }

  function weekly(dates, now) {
    const weeks = new Array(52).fill(0);
    for (const d of dates) {
      const t = Date.parse(d);
      if (!Number.isFinite(t)) continue;
      const idx = Math.floor((now - t) / (7 * DAY));
      if (idx >= 0 && idx < 52) weeks[51 - idx] += 1;
    }
    return weeks;
  }

  const FETCH_FILES = [
    /^readme(\.(md|markdown|rst|txt|adoc|org))?$/i, /^package\.json$/, /^pyproject\.toml$/, /^requirements(-dev)?\.txt$/, /^dockerfile$/i,
    /^(docker-)?compose\.ya?ml$/, /^cargo\.toml$/, /^go\.mod$/, /^makefile$/i, /^composer\.json$/, /^\.nvmrc$/, /^\.node-version$/, /^\.python-version$/, /^setup\.cfg$/
  ];

  function wantedFiles(entries) {
    const rootFiles = entries.filter((e) => e.type === 'blob' && !e.path.includes('/'));
    const out = [];
    for (const re of FETCH_FILES) {
      const m = rootFiles.filter((e) => re.test(e.path));
      if (re.source.startsWith('^readme')) {
        m.sort((a, b) => (/\.(md|markdown)$/i.test(b.path) ? 1 : 0) - (/\.(md|markdown)$/i.test(a.path) ? 1 : 0));
        if (m[0]) out.push(m[0].path);
      } else for (const x of m.slice(0, 2)) out.push(x.path);
    }
    const c = entries.find((e) => e.type === 'blob' && /^(\.github\/|\.gitlab\/|docs\/)?contributing(\.\w+)?$/i.test(e.path));
    if (c) out.push(c.path);
    for (const e of entries.filter((x) => x.type === 'blob' && /^\.github\/workflows\/[^/]+\.ya?ml$/.test(x.path)).slice(0, 10)) out.push(e.path);
    const gl = entries.find((e) => e.path === '.gitlab-ci.yml');
    if (gl) out.push(gl.path);
    return out;
  }

  const sortTree = (entries) => [...entries].sort((a, b) => a.path.split('/').length - b.path.split('/').length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const GITLAB_LICENSE = {
    mit: 'MIT', 'apache-2.0': 'Apache-2.0', 'gpl-3.0': 'GPL-3.0', 'gpl-2.0': 'GPL-2.0', 'agpl-3.0': 'AGPL-3.0', 'lgpl-3.0': 'LGPL-3.0', 'lgpl-2.1': 'LGPL-2.1',
    'bsd-3-clause': 'BSD-3-Clause', 'bsd-2-clause': 'BSD-2-Clause', 'mpl-2.0': 'MPL-2.0', isc: 'ISC', unlicense: 'Unlicense', 'cc0-1.0': 'CC0-1.0', 'epl-2.0': 'EPL-2.0', 'bsl-1.0': 'BSL-1.0'
  };

  function licenseFallback(entries) {
    const f = entries.find((e) => e.type === 'blob' && /^(licen[cs]e|copying)(\.\w+)?$/i.test(e.path));
    return f ? { spdx_id: 'NOASSERTION', name: `License file (${f.path})` } : null;
  }

  const mapIssue = (i, kind) => ({
    number: kind === 'gitlab' ? i.iid : i.number,
    title: String(i.title || '').slice(0, 200),
    state: i.state === 'opened' ? 'open' : i.state,
    created_at: i.created_at,
    closed_at: i.closed_at || null,
    comments: kind === 'gitlab' ? i.user_notes_count || 0 : i.comments || 0,
    isPR: false,
    labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean).slice(0, 8),
    assigned: Boolean((i.assignees && i.assignees.length) || i.assignee),
    author_association: null
  });

  // ------------------------------------------------------------ GitLab

  async function collectGitLab(full, { fetchImpl = root.fetch.bind(root), onProgress = () => {}, now = Date.now(), host = 'gitlab.com' } = {}) {
    const rate = { remaining: null, limit: null, reset: null };
    const c = client(fetchImpl, rate, 'GitLab');
    const partial = [];
    const base = `https://${host}/api/v4/projects/${encodeURIComponent(full)}`;
    onProgress('Reading project…');
    const p = (await c.get(`${base}?license=true`)).data;
    if (!p || !p.path_with_namespace) throw new ForgeError('not-found', 'Repository not found, or it is private.');
    const branch = p.default_branch || 'main';
    const since = new Date(now - 365 * DAY).toISOString();

    onProgress('Reading history, releases and issues…');
    const [langs, contrib, releases, commits, issues, gfi, mrs, yearCommits] = await Promise.all([
      soft('languages', partial, () => c.get(`${base}/languages`)),
      soft('contributors', partial, () => c.get(`${base}/repository/contributors?order_by=commits&sort=desc&per_page=100`)),
      soft('releases', partial, () => c.get(`${base}/releases?per_page=30`)),
      soft('commits', partial, () => c.get(`${base}/repository/commits?per_page=30&ref_name=${encodeURIComponent(branch)}`)),
      p.issues_enabled === false ? null : soft('issues', partial, () => c.get(`${base}/issues?scope=all&per_page=100&order_by=created_at&sort=desc`)),
      p.issues_enabled === false ? null : soft('good-first-issues', partial, () => c.get(`${base}/issues?state=opened&labels=${encodeURIComponent('good first issue')}&per_page=15`)),
      soft('merge-requests', partial, () => c.get(`${base}/merge_requests?state=all&per_page=50&order_by=updated_at`)),
      soft('commit-activity', partial, async () => {
        const dates = [];
        for (let page = 1; page <= 3; page++) {
          const r = await c.get(`${base}/repository/commits?per_page=100&page=${page}&since=${encodeURIComponent(since)}&ref_name=${encodeURIComponent(branch)}`);
          for (const x of r.data || []) dates.push(x.committed_date || x.created_at);
          if (!r.data || r.data.length < 100) break;
        }
        return dates;
      })
    ]);

    // Tree: paginated, 100 per page; read up to 10 pages.
    let entries = [];
    let truncated = false;
    await soft('tree', partial, async () => {
      for (let page = 1; page <= 10; page++) {
        const r = await c.get(`${base}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(branch)}`);
        for (const e of r.data || []) entries.push(e.type === 'tree' ? { path: e.path, type: 'tree' } : { path: e.path, type: 'blob', size: 0 });
        const next = r.headers.get('x-next-page');
        if (!r.data || r.data.length < 100 || !next) break;
        if (page === 10) truncated = true;
      }
    });

    onProgress('Reading README and project files…');
    const ref = commits && commits.data && commits.data[0] ? commits.data[0].id : branch;
    const files = {};
    await Promise.all(wantedFiles(entries).map(async (path) => {
      const r = await soft(`file:${path}`, [], () => c.get(`${base}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`, { text: true, allow404: true }));
      if (r && r.status === 200 && typeof r.data === 'string') files[path] = r.data.slice(0, /^readme/i.test(path) ? 200000 : 100000);
    }));

    const top = contrib && Array.isArray(contrib.data) ? contrib.data.map((x) => ({ login: x.name || 'unknown', contributions: x.commits || 0, type: null })) : [];
    const total = contrib && Number(contrib.headers.get('x-total'));
    const license = p.license && p.license.key ? { spdx_id: GITLAB_LICENSE[p.license.key] || 'NOASSERTION', name: p.license.name || p.license.nickname || p.license.key } : licenseFallback(entries);
    const langData = langs && langs.data && typeof langs.data === 'object' ? Object.fromEntries(Object.entries(langs.data).map(([k, v]) => [k, Math.round(Number(v) * 1000)])) : null;

    return {
      v: RAW_VERSION,
      platform: 'gitlab',
      host,
      fetchedAt: now,
      requested: { owner: full.split('/').slice(0, -1).join('/'), repo: full.split('/').pop() },
      repo: {
        full_name: p.path_with_namespace, name: p.path || p.name, description: p.description || null, homepage: null, html_url: p.web_url,
        stargazers_count: p.star_count, forks_count: p.forks_count, subscribers_count: null, open_issues_count: p.open_issues_count ?? null,
        default_branch: branch, created_at: p.created_at, updated_at: p.last_activity_at, pushed_at: p.last_activity_at, archived: Boolean(p.archived),
        disabled: false, fork: Boolean(p.forked_from_project), is_template: false,
        language: langData ? Object.entries(langData).sort((a, b) => b[1] - a[1])[0]?.[0] || null : null,
        size: null, has_issues: p.issues_enabled !== false, has_wiki: Boolean(p.wiki_enabled), has_discussions: false, visibility: p.visibility,
        owner: p.namespace ? { login: p.namespace.full_path || p.namespace.path, type: p.namespace.kind } : null,
        topics: (p.topics || p.tag_list || []).slice(0, 20), license,
        parent: p.forked_from_project ? { full_name: p.forked_from_project.path_with_namespace } : null
      },
      languages: langData,
      contributors: { status: contrib ? contrib.status : null, count: total || (top.length >= 100 ? 100 : top.length || null), approx: !total && top.length >= 100, top: top.slice(0, 100) },
      releases: releases && Array.isArray(releases.data) ? releases.data.map((x) => ({ tag: String(x.tag_name || '').slice(0, 60), name: String(x.name || '').slice(0, 100), published_at: x.released_at || x.created_at, prerelease: Boolean(x.upcoming_release) })) : null,
      commits: commits && Array.isArray(commits.data) ? commits.data.map((x) => ({ sha: x.id, date: x.committed_date || x.created_at, message: String(x.title || '').slice(0, 140), author: x.author_name || null })) : null,
      emptyRepo: Boolean(commits && Array.isArray(commits.data) && !commits.data.length),
      issues: issues && Array.isArray(issues.data) ? issues.data.map((i) => mapIssue(i, 'gitlab')) : null,
      goodFirst: gfi && Array.isArray(gfi.data) ? gfi.data.map((i) => mapIssue(i, 'gitlab')) : null,
      tree: { entries: sortTree(entries).slice(0, 8000), truncated, trimmed: entries.length > 8000, stats: treeStats(entries) },
      files,
      ref,
      advisories: null,
      commitActivity: yearCommits ? { status: 'ok', weeks: weekly(yearCommits, now), approx: yearCommits.length >= 300 } : { status: 'unavailable', weeks: [] },
      pulls: mrs && Array.isArray(mrs.data) ? mrs.data.filter((m) => m.state === 'merged' || m.state === 'closed').map((m) => ({
        number: m.iid, created_at: m.created_at, closed_at: m.closed_at || m.merged_at, merged_at: m.merged_at || null, author_association: null, bot: /bot$/i.test((m.author && m.author.username) || '')
      })) : null,
      partial,
      rate,
      apiCalls: c.calls()
    };
  }

  // ------------------------------------------------------------ Forgejo / Gitea (Codeberg)

  async function collectGitea(owner, repo, { fetchImpl = root.fetch.bind(root), onProgress = () => {}, now = Date.now(), host = 'codeberg.org' } = {}) {
    const rate = { remaining: null, limit: null, reset: null };
    const c = client(fetchImpl, rate, 'Codeberg');
    const partial = [];
    const base = `https://${host}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    onProgress('Reading repository…');
    const r = (await c.get(base)).data;
    if (!r || !r.full_name) throw new ForgeError('not-found', 'Repository not found, or it is private.');
    const branch = r.default_branch || 'main';
    const since = new Date(now - 365 * DAY).toISOString();

    onProgress('Reading history, releases and issues…');
    const [langs, releases, commits, issues, pulls, yearCommits] = await Promise.all([
      soft('languages', partial, () => c.get(`${base}/languages`)),
      soft('releases', partial, () => c.get(`${base}/releases?limit=30`)),
      soft('commits', partial, () => c.get(`${base}/commits?limit=30&sha=${encodeURIComponent(branch)}&stat=false&verification=false&files=false`)),
      r.has_issues === false ? null : soft('issues', partial, () => c.get(`${base}/issues?state=all&type=issues&limit=50`)),
      soft('pull-requests', partial, () => c.get(`${base}/pulls?state=closed&limit=50&sort=recentupdate`)),
      soft('commit-activity', partial, async () => {
        const dates = [];
        for (let page = 1; page <= 4; page++) {
          const x = await c.get(`${base}/commits?limit=50&page=${page}&sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(since)}&stat=false&verification=false&files=false`);
          for (const k of x.data || []) dates.push((k.commit && k.commit.committer && k.commit.committer.date) || k.created);
          if (!x.data || x.data.length < 50) break;
        }
        return dates;
      })
    ]);
    const sha = commits && commits.data && commits.data[0] ? commits.data[0].sha : branch;
    const tree = await soft('tree', partial, () => c.get(`${base}/git/trees/${encodeURIComponent(sha)}?recursive=true&per_page=10000`));
    const entries = tree && tree.data && Array.isArray(tree.data.tree)
      ? tree.data.tree.filter((e) => e && typeof e.path === 'string' && (e.type === 'blob' || e.type === 'tree')).map((e) => (e.type === 'blob' ? { path: e.path, type: 'blob', size: e.size || 0 } : { path: e.path, type: 'tree' }))
      : [];

    onProgress('Reading README and project files…');
    const files = {};
    await Promise.all(wantedFiles(entries).map(async (path) => {
      const x = await soft(`file:${path}`, [], () => c.get(`${base}/raw/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(sha)}`, { text: true, allow404: true }));
      if (x && x.status === 200 && typeof x.data === 'string') files[path] = x.data.slice(0, /^readme/i.test(path) ? 200000 : 100000);
    }));

    // No contributors API on Gitea: derive from recent commit authors.
    const authorCounts = new Map();
    for (const k of (commits && commits.data) || []) {
      const who = (k.author && k.author.login) || (k.commit && k.commit.author && k.commit.author.name) || 'unknown';
      authorCounts.set(who, (authorCounts.get(who) || 0) + 1);
    }
    const top = [...authorCounts.entries()].sort((a, b) => b[1] - a[1]).map(([login, n]) => ({ login, contributions: n, type: null }));
    const spdx = Array.isArray(r.licenses) && r.licenses.length ? r.licenses[0] : null;
    const license = spdx ? { spdx_id: spdx, name: spdx } : licenseFallback(entries);

    return {
      v: RAW_VERSION,
      platform: 'codeberg',
      host,
      fetchedAt: now,
      requested: { owner, repo },
      repo: {
        full_name: r.full_name, name: r.name, description: r.description || null, homepage: r.website || null, html_url: r.html_url,
        stargazers_count: r.stars_count, forks_count: r.forks_count, subscribers_count: r.watchers_count, open_issues_count: (r.open_issues_count || 0) + (r.open_pr_counter || 0),
        default_branch: branch, created_at: r.created_at, updated_at: r.updated_at, pushed_at: r.updated_at, archived: Boolean(r.archived), disabled: false,
        fork: Boolean(r.fork), is_template: Boolean(r.template), language: r.language || null, size: r.size || null,
        has_issues: r.has_issues !== false, has_wiki: Boolean(r.has_wiki), has_discussions: false, visibility: r.private ? 'private' : 'public',
        owner: r.owner ? { login: r.owner.login, type: null } : null, topics: (r.topics || []).slice(0, 20), license,
        parent: r.parent ? { full_name: r.parent.full_name } : null
      },
      languages: langs && langs.data && typeof langs.data === 'object' ? langs.data : null,
      contributors: { status: commits ? commits.status : null, count: top.length || null, approx: true, top, recentOnly: true },
      releases: releases && Array.isArray(releases.data) ? releases.data.filter((x) => !x.draft).map((x) => ({ tag: String(x.tag_name || '').slice(0, 60), name: String(x.name || '').slice(0, 100), published_at: x.published_at || x.created_at, prerelease: Boolean(x.prerelease) })) : null,
      commits: commits && Array.isArray(commits.data) ? commits.data.map((k) => ({ sha: k.sha, date: (k.commit && k.commit.committer && k.commit.committer.date) || k.created, message: String((k.commit && k.commit.message) || '').split('\n')[0].slice(0, 140), author: (k.author && k.author.login) || null })) : null,
      emptyRepo: Boolean(r.empty),
      issues: issues && Array.isArray(issues.data) ? issues.data.filter((i) => !i.pull_request).map((i) => mapIssue(i, 'gitea')) : null,
      goodFirst: null,
      tree: { entries: sortTree(entries).slice(0, 8000), truncated: Boolean(tree && tree.data && tree.data.truncated), trimmed: entries.length > 8000, stats: treeStats(entries) },
      files,
      ref: sha,
      advisories: null,
      commitActivity: yearCommits ? { status: 'ok', weeks: weekly(yearCommits, now), approx: yearCommits.length >= 200 } : { status: 'unavailable', weeks: [] },
      pulls: pulls && Array.isArray(pulls.data) ? pulls.data.map((x) => ({ number: x.number, created_at: x.created_at, closed_at: x.closed_at, merged_at: x.merged_at || (x.merged ? x.closed_at : null), author_association: null, bot: /bot$/i.test((x.user && x.user.login) || '') })) : null,
      partial,
      rate,
      apiCalls: c.calls()
    };
  }

  /** Collect for any platform. `target` comes from parse(). */
  function collect(target, opts = {}) {
    if (target.platform === 'gitlab') return collectGitLab(target.full, opts);
    if (target.platform === 'codeberg') return collectGitea(target.owner, target.repo, opts);
    return root.PageLensGitHub.collect(target.owner, target.repo, opts);
  }

  root.PageLensForges = Object.freeze({ PLATFORMS, parse, collect, collectGitLab, collectGitea, ForgeError });
})(globalThis);
