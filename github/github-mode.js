/* PageLens — github/github-mode.js
 *
 * GitHub mode. Two halves:
 *
 *   1. collect(owner, repo)  — talks to the free public GitHub API (no token)
 *      and raw.githubusercontent.com (no rate limit) and returns one plain
 *      "raw" object. About 8 API calls per repo; results are cached for an
 *      hour in chrome.storage.local so the 60-calls-an-hour limit goes far.
 *
 *   2. analyze(raw)          — pure and deterministic. Turns the raw data into
 *      summaries, an install-and-run guide, a folder map, files to read
 *      first, a trust panel and a contribution guide. "Now" is the time the
 *      data was fetched, so the same data always gives the same report.
 *
 * Nothing here runs repo code or renders README HTML. README text is only
 * ever displayed as plain text by the popup.
 */
(function (root) {
  'use strict';

  const API = 'https://api.github.com';
  const RAW = 'https://raw.githubusercontent.com';
  const CACHE_PREFIX = 'gh:';
  const CACHE_TTL_MS = 60 * 60 * 1000;
  const CACHE_KEEP = 15;
  const RAW_VERSION = 2; // bump when the shape of `raw` changes
  const TREE_KEEP = 8000;
  const DAY = 86400000;

  // ============================================================ input parsing

  const RESERVED = new Set(['settings', 'orgs', 'marketplace', 'explore', 'topics', 'login', 'join', 'features', 'pricing',
    'about', 'sponsors', 'notifications', 'new', 'search', 'collections', 'trending', 'enterprise', 'team', 'security',
    'customer-stories', 'readme', 'codespaces', 'issues', 'pulls', 'discussions', 'dashboard', 'apps', 'site', 'contact']);
  const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

  /** Accepts "owner/repo", a github.com URL, or "git@github.com:owner/repo.git". */
  function parseRepoInput(input) {
    let s = String(input || '').trim();
    if (!s) return null;
    s = s.replace(/^git@github\.com:/i, 'https://github.com/');
    let owner;
    let repo;
    if (/^(https?:\/\/)?(www\.)?github\.com\//i.test(s)) {
      try {
        const u = new URL(/^https?:/i.test(s) ? s : 'https://' + s);
        [owner, repo] = u.pathname.split('/').filter(Boolean);
      } catch {
        return null;
      }
    } else {
      [owner, repo] = s.split('/').filter(Boolean);
    }
    if (!owner || !repo) return null;
    repo = repo.replace(/\.git$/i, '');
    if (RESERVED.has(owner.toLowerCase()) || !NAME_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return null;
    return { owner, repo };
  }

  // ============================================================ fetch layer

  class GitHubError extends Error {
    constructor(code, message, extra = {}) {
      super(message);
      this.code = code;
      Object.assign(this, extra);
    }
  }

  function readRate(res, rate) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining == null) return;
    const r = Number(remaining);
    const limit = Number(res.headers.get('x-ratelimit-limit')) || null;
    const reset = Number(res.headers.get('x-ratelimit-reset')) || null;
    if (rate.remaining == null || r < rate.remaining) {
      rate.remaining = r;
      rate.limit = limit;
      rate.reset = reset ? reset * 1000 : null;
    }
  }

  function makeClient(fetchImpl, rate, token) {
    let calls = 0;
    // Optional personal token (Settings): raises the limit from 60 to 5,000 an hour. Sent to api.github.com only.
    const auth = token && /^(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,255}$/.test(token) ? { Authorization: `Bearer ${token}` } : {};

    async function api(path, { allow404 = false } = {}) {
      calls += 1;
      let res;
      try {
        res = await fetchImpl(API + path, {
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...auth },
          credentials: 'omit',
          cache: 'no-store'
        });
      } catch (err) {
        throw new GitHubError('network', 'Could not reach GitHub.');
      }
      readRate(res, rate);
      if (res.status === 404 && allow404) return { status: 404, data: null, headers: res.headers };
      if (res.status === 403 || res.status === 429) {
        if (res.headers.get('x-ratelimit-remaining') === '0' || res.status === 429) {
          throw new GitHubError('rate-limit', 'GitHub\'s free hourly limit is used up on this network.', { reset: rate.reset });
        }
        throw new GitHubError('forbidden', 'GitHub refused the request.');
      }
      if (res.status === 404) throw new GitHubError('not-found', 'Repository not found, or it is private.');
      if (res.status === 451) throw new GitHubError('blocked', 'This repository is unavailable for legal reasons.');
      if (res.status === 202 || res.status === 204) return { status: res.status, data: null, headers: res.headers };
      if (res.status === 409) return { status: 409, data: null, headers: res.headers }; // empty repository
      if (!res.ok) throw new GitHubError('http', `GitHub answered ${res.status}.`);
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      return { status: res.status, data, headers: res.headers };
    }

    async function raw(owner, repo, ref, path, maxBytes = 200000) {
      const url = `${RAW}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`;
      try {
        const res = await fetchImpl(url, { credentials: 'omit', cache: 'no-store' });
        if (!res.ok) return null;
        const text = await res.text();
        return text.length > maxBytes ? text.slice(0, maxBytes) : text;
      } catch {
        return null;
      }
    }

    return { api, raw, calls: () => calls };
  }

  /** Optional call: failures become null and are listed in raw.partial. */
  async function soft(name, partial, fn) {
    try {
      return await fn();
    } catch (err) {
      if (err && err.code === 'rate-limit') throw err;
      partial.push(name);
      return null;
    }
  }

  function contributorCount(res) {
    if (!res || res.status !== 200 || !Array.isArray(res.data)) return { count: null, approx: false };
    const link = res.headers.get('link') || '';
    const m = /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link);
    if (m) return { count: (Number(m[1]) - 1) * 100, approx: true };
    return { count: res.data.length, approx: false };
  }

  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));

  function trimIssue(i) {
    return {
      number: i.number,
      title: String(i.title || '').slice(0, 200),
      state: i.state,
      created_at: i.created_at,
      closed_at: i.closed_at,
      comments: i.comments,
      isPR: Boolean(i.pull_request),
      labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean).slice(0, 8),
      assigned: Boolean(i.assignee || (i.assignees && i.assignees.length)),
      author_association: i.author_association || null
    };
  }

  /** Which root files to read as text (no API quota: raw.githubusercontent.com). */
  const FETCH_FILES = [
    /^readme(\.(md|markdown|rst|txt|adoc|org))?$/i,
    /^package\.json$/, /^pyproject\.toml$/, /^requirements(-dev)?\.txt$/, /^dockerfile$/i,
    /^(docker-)?compose\.ya?ml$/, /^cargo\.toml$/, /^go\.mod$/, /^makefile$/i, /^composer\.json$/,
    /^\.nvmrc$/, /^\.node-version$/, /^\.python-version$/, /^setup\.cfg$/
  ];
  const CONTRIB_PATHS = ['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md', 'CONTRIBUTING.rst', 'CONTRIBUTING'];

  function treeStats(entries) {
    const top = {};
    let files = 0;
    let bytes = 0;
    let dirs = 0;
    for (const e of entries) {
      const first = e.path.split('/')[0];
      if (e.type === 'tree') {
        dirs += 1;
        if (!e.path.includes('/')) top[first] = top[first] || { files: 0, bytes: 0 };
        continue;
      }
      if (e.type !== 'blob') continue;
      files += 1;
      bytes += e.size || 0;
      if (e.path.includes('/')) {
        const t = top[first] || (top[first] = { files: 0, bytes: 0 });
        t.files += 1;
        t.bytes += e.size || 0;
      }
    }
    return { files, bytes, dirs, top };
  }

  /**
   * Collect everything GitHub mode needs.
   * @returns {Promise<object>} raw data (serializable)
   */
  async function collect(owner, repo, { fetchImpl = root.fetch.bind(root), onProgress = () => {}, now = Date.now(), token = null } = {}) {
    const rate = { remaining: null, limit: null, reset: null };
    const gh = makeClient(fetchImpl, rate, token);
    const partial = [];
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    onProgress('Reading repository…');
    const repoRes = await gh.api(base);
    const r = repoRes.data;
    if (!r || !r.full_name) throw new GitHubError('not-found', 'Repository not found, or it is private.');
    const [realOwner, realName] = r.full_name.split('/');
    const rbase = `/repos/${encodeURIComponent(realOwner)}/${encodeURIComponent(realName)}`;
    const branch = r.default_branch || 'main';

    onProgress('Reading history, releases and issues…');
    const commitsP = soft('commits', partial, () => gh.api(`${rbase}/commits?per_page=30`));
    const treeP = commitsP.then((c) => {
      const sha = c && c.status === 200 && Array.isArray(c.data) && c.data[0] ? c.data[0].sha : null;
      if (!sha && c && c.status === 409) return null; // empty repo
      return soft('tree', partial, () => gh.api(`${rbase}/git/trees/${encodeURIComponent(sha || branch)}?recursive=1`));
    });
    const [langs, contrib, releases, commits, issues, gfi, tree, advisories, activity, pulls] = await Promise.all([
      soft('languages', partial, () => gh.api(`${rbase}/languages`)),
      soft('contributors', partial, () => gh.api(`${rbase}/contributors?per_page=100`)),
      soft('releases', partial, () => gh.api(`${rbase}/releases?per_page=30`)),
      commitsP,
      r.has_issues === false ? null : soft('issues', partial, () => gh.api(`${rbase}/issues?state=all&per_page=100`)),
      r.has_issues === false ? null : soft('good-first-issues', partial, () => gh.api(`${rbase}/issues?state=open&labels=${encodeURIComponent('good first issue')}&per_page=15`)),
      treeP,
      soft('security-advisories', partial, () => gh.api(`${rbase}/security-advisories?per_page=30&state=published`, { allow404: true })),
      soft('commit-activity', partial, () => gh.api(`${rbase}/stats/commit_activity`)),
      soft('pull-requests', partial, () => gh.api(`${rbase}/pulls?state=closed&per_page=50&sort=updated&direction=desc`))
    ]);

    // Tree: keep everything for stats, trim the list we store.
    let entries = tree && tree.data && Array.isArray(tree.data.tree) ? tree.data.tree : [];
    entries = entries
      .filter((e) => e && typeof e.path === 'string' && (e.type === 'blob' || e.type === 'tree'))
      .map((e) => (e.type === 'blob' ? { path: e.path, type: 'blob', size: e.size || 0 } : { path: e.path, type: 'tree' }));
    const stats = treeStats(entries);
    const sorted = [...entries].sort((a, b) => {
      const da = a.path.split('/').length;
      const db = b.path.split('/').length;
      return da - db || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    });
    const kept = sorted.slice(0, TREE_KEEP);

    // Text files from raw (no API quota).
    onProgress('Reading README and project files…');
    const ref = (commits && commits.data && commits.data[0] && commits.data[0].sha) || branch;
    const rootFiles = entries.filter((e) => e.type === 'blob' && !e.path.includes('/'));
    const wanted = [];
    for (const re of FETCH_FILES) {
      const matches = rootFiles.filter((e) => re.test(e.path) && e.size < 1500000);
      if (re.source.startsWith('^readme')) {
        // Prefer README.md over other README variants.
        matches.sort((a, b) => (/\.(md|markdown)$/i.test(b.path) ? 1 : 0) - (/\.(md|markdown)$/i.test(a.path) ? 1 : 0));
        if (matches[0]) wanted.push(matches[0].path);
      } else {
        for (const m of matches.slice(0, 2)) wanted.push(m.path);
      }
    }
    const paths = new Set(entries.map((e) => e.path));
    const contribPath = CONTRIB_PATHS.find((p) => paths.has(p)) ||
      entries.map((e) => e.path).find((p) => /^(\.github\/|docs\/)?contributing(\.\w+)?$/i.test(p));
    if (contribPath) wanted.push(contribPath);
    // CI workflows (for supply-chain checks), read from raw — no API quota.
    for (const e of entries.filter((x) => x.type === 'blob' && /^\.github\/workflows\/[^/]+\.ya?ml$/.test(x.path) && x.size < 200000).slice(0, 10)) wanted.push(e.path);

    const files = {};
    await Promise.all(wanted.map(async (p) => {
      const text = await gh.raw(realOwner, realName, ref, p, /^readme/i.test(p) ? 200000 : 100000);
      if (text != null) files[p] = text;
    }));

    // README fallback through the API when the tree was unavailable.
    if (!Object.keys(files).some((p) => /^readme/i.test(p)) && !entries.length) {
      const rd = await soft('readme', partial, () => gh.api(`${rbase}/readme`, { allow404: true }));
      if (rd && rd.data && rd.data.content && rd.data.encoding === 'base64') {
        try {
          const bin = atob(rd.data.content.replace(/\n/g, ''));
          const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
          files[rd.data.path || 'README.md'] = new TextDecoder().decode(bytes).slice(0, 200000);
        } catch { /* ignore */ }
      }
    }

    const cc = contributorCount(contrib);
    return {
      v: RAW_VERSION,
      platform: 'github',
      host: 'github.com',
      fetchedAt: now,
      requested: { owner, repo },
      repo: {
        ...pick(r, ['full_name', 'name', 'description', 'homepage', 'html_url', 'stargazers_count', 'forks_count', 'subscribers_count',
          'open_issues_count', 'default_branch', 'created_at', 'updated_at', 'pushed_at', 'archived', 'disabled', 'fork', 'is_template',
          'language', 'size', 'has_issues', 'has_wiki', 'has_discussions', 'visibility']),
        owner: r.owner ? { login: r.owner.login, type: r.owner.type } : null,
        topics: Array.isArray(r.topics) ? r.topics.slice(0, 20) : [],
        license: r.license ? { spdx_id: r.license.spdx_id, name: r.license.name } : null,
        parent: r.parent ? { full_name: r.parent.full_name } : null
      },
      languages: langs && langs.data && typeof langs.data === 'object' ? langs.data : null,
      contributors: {
        status: contrib ? contrib.status : null,
        count: cc.count,
        approx: cc.approx,
        top: contrib && Array.isArray(contrib.data)
          ? contrib.data.slice(0, 100).map((c) => ({ login: c.login || (c.name ? 'anonymous' : null), contributions: c.contributions || 0, type: c.type || null }))
          : []
      },
      releases: releases && Array.isArray(releases.data)
        ? releases.data.filter((x) => !x.draft).map((x) => ({ tag: String(x.tag_name || '').slice(0, 60), name: String(x.name || '').slice(0, 100), published_at: x.published_at || x.created_at, prerelease: Boolean(x.prerelease) }))
        : null,
      commits: commits && Array.isArray(commits.data)
        ? commits.data.map((c) => ({
          sha: c.sha,
          date: (c.commit && ((c.commit.committer && c.commit.committer.date) || (c.commit.author && c.commit.author.date))) || null,
          message: String((c.commit && c.commit.message) || '').split('\n')[0].slice(0, 140),
          author: (c.author && c.author.login) || null
        }))
        : (commits && commits.status === 409 ? [] : null),
      emptyRepo: Boolean(commits && commits.status === 409),
      issues: issues && Array.isArray(issues.data) ? issues.data.map(trimIssue) : null,
      goodFirst: gfi && Array.isArray(gfi.data) ? gfi.data.map(trimIssue) : null,
      tree: { entries: kept, truncated: Boolean(tree && tree.data && tree.data.truncated), trimmed: entries.length > kept.length, stats },
      files,
      ref,
      advisories: advisories && advisories.status === 200 && Array.isArray(advisories.data)
        ? advisories.data.map((a) => ({
          ghsa: a.ghsa_id, cve: a.cve_id || null, summary: String(a.summary || '').slice(0, 200), severity: a.severity || null,
          published: a.published_at || null, state: a.state, url: a.html_url || null
        }))
        : null,
      commitActivity: activity && activity.status === 200 && Array.isArray(activity.data)
        ? { status: 'ok', weeks: activity.data.map((w) => w.total || 0).slice(-52), lastWeek: activity.data.length ? activity.data[activity.data.length - 1].week : null }
        : { status: activity && activity.status === 202 ? 'computing' : 'unavailable', weeks: [] },
      pulls: pulls && Array.isArray(pulls.data)
        ? pulls.data.map((x) => ({
          number: x.number, created_at: x.created_at, closed_at: x.closed_at, merged_at: x.merged_at || null,
          author_association: x.author_association || null, bot: Boolean(x.user && (x.user.type === 'Bot' || /\[bot\]$/.test(x.user.login || '')))
        }))
        : null,
      partial,
      rate,
      apiCalls: gh.calls()
    };
  }

  // ============================================================ cache

  const hasStorage = () => typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const cacheKey = (owner, repo, platform = 'github') => `${CACHE_PREFIX}${platform === 'github' ? '' : platform + ':'}${owner}/${repo}`.toLowerCase();

  async function readCache(owner, repo, platform = 'github') {
    if (!hasStorage()) return null;
    try {
      const key = cacheKey(owner, repo, platform);
      const got = await chrome.storage.local.get(key);
      const entry = got[key];
      return entry && entry.v === RAW_VERSION ? entry : null;
    } catch {
      return null;
    }
  }

  async function writeCache(raw) {
    if (!hasStorage()) return;
    try {
      const plat = raw.platform || 'github';
      const keys = [cacheKey(raw.requested.owner, raw.requested.repo, plat)];
      if (raw.repo.full_name) keys.push(cacheKey(raw.repo.full_name.split('/').slice(0, -1).join('/'), raw.repo.full_name.split('/').pop(), plat));
      const set = {};
      for (const k of new Set(keys)) set[k] = raw;
      await chrome.storage.local.set(set);
      // Evict oldest entries beyond CACHE_KEEP.
      const all = await chrome.storage.local.get(null);
      const entries = Object.entries(all).filter(([k, v]) => k.startsWith(CACHE_PREFIX) && v && v.fetchedAt);
      const uniqueByFetch = entries.sort((a, b) => b[1].fetchedAt - a[1].fetchedAt);
      const seen = new Set();
      const drop = [];
      for (const [k, v] of uniqueByFetch) {
        const id = (v.repo && v.repo.full_name) || k;
        if (!seen.has(id) && seen.size >= CACHE_KEEP) drop.push(k);
        seen.add(id);
      }
      if (drop.length) await chrome.storage.local.remove(drop);
    } catch {
      /* storage full or unavailable: caching is optional */
    }
  }

  /**
   * Load a repo, preferring a fresh cache entry.
   * @returns {Promise<{raw, report, fromCache:boolean, stale:boolean, error?:GitHubError}>}
   */
  async function load(owner, repo, { force = false, fetchImpl, onProgress, now = Date.now(), platform = 'github', token = null } = {}) {
    const cached = await readCache(owner, repo, platform);
    if (cached && !force && now - cached.fetchedAt < CACHE_TTL_MS) {
      return { raw: cached, report: analyze(cached), fromCache: true, stale: false };
    }
    try {
      const raw = platform === 'github'
        ? await collect(owner, repo, { fetchImpl, onProgress, now, token })
        : await root.PageLensForges.collect({ platform, owner, repo, full: `${owner}/${repo}` }, { fetchImpl, onProgress, now });
      await writeCache(raw);
      return { raw, report: analyze(raw), fromCache: false, stale: false };
    } catch (err) {
      // Rate limit or network trouble: an older copy beats nothing.
      if (cached && (err.code === 'rate-limit' || err.code === 'network')) {
        return { raw: cached, report: analyze(cached), fromCache: true, stale: true, error: err };
      }
      throw err;
    }
  }

  // ============================================================ text helpers (pure)

  function decodeEntities(s) {
    return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => {
        const c = Number(n);
        return c > 0 && c < 0x10ffff ? String.fromCodePoint(c) : '';
      });
  }

  /** Markdown inline → plain text. */
  function plain(s) {
    return decodeEntities(String(s || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ') // linked badges
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
      .replace(/!\[[^\]]*\]\[[^\]]*\]/g, ' ')
      .replace(/<img[^>]*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/?[a-z][^>]*>/gi, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
      .replace(/(^|[\s(])\*(?=\S)([^*]+?)(?<=\S)\*(?=[\s).,;:!?]|$)/g, '$1$2')
      .replace(/(^|\s)_(?=\S)([^_]+?)(?<=\S)_(?=\s|[.,;:!?]|$)/g, '$1$2')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/:([a-z0-9_+-]+):/g, (m, name) => (/^[a-z_]+$/.test(name) ? '' : m)) // :emoji: shortcodes
      .replace(/\s+/g, ' ')
      .trim());
  }

  function firstSentence(text, max = 200) {
    const t = String(text || '').trim();
    if (!t) return '';
    const m = /^(.{20,}?[.!?])(?=\s+[A-Z0-9"'(]|\s*$)/.exec(t) || /^(.{6,}?[。！？])/u.exec(t);
    let s = m ? m[1] : t;
    if (s.length > max) {
      s = s.slice(0, max);
      const cut = s.lastIndexOf(' ');
      s = (cut > max * 0.6 ? s.slice(0, cut) : s).replace(/[,;:\s]+$/, '') + '…';
    }
    return s;
  }

  const SHELL_LANGS = new Set(['', 'sh', 'bash', 'shell', 'console', 'zsh', 'fish', 'powershell', 'ps1', 'pwsh', 'cmd', 'bat', 'batch', 'terminal', 'shell-session', 'shellsession', 'text', 'txt']);

  /** Splits markdown into title, intro and sections. Handles ATX, setext and HTML headings, and fenced code. */
  function parseMarkdown(md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const out = { title: null, intro: [], sections: [] };
    let cur = null; // section being filled
    let para = [];
    let fence = null;
    let code = [];
    let codeLang = '';
    let seenHeading = false;
    let inHtmlComment = false;

    const target = () => (cur ? cur : null);
    const flushPara = () => {
      if (!para.length) return;
      const text = para.join(' ');
      para = [];
      const t = target();
      if (t) t.paras.push(text);
      else out.intro.push(text);
    };
    const pushBullet = (text) => {
      const t = target();
      if (t) t.bullets.push(text);
      else out.intro.push(text);
    };
    const startSection = (level, heading) => {
      flushPara();
      const h = plain(heading).replace(/^#+\s*/, '');
      if (!seenHeading && level === 1 && !out.title) {
        out.title = h;
        seenHeading = true;
        return;
      }
      seenHeading = true;
      cur = { level, heading: h, paras: [], bullets: [], code: [] };
      out.sections.push(cur);
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (fence) {
        if (new RegExp('^\\s*' + fence.replace(/[`~]/g, (c) => '\\' + c) + '[`~]*\\s*$').test(line)) {
          const t = target();
          const block = { lang: codeLang, code: code.join('\n').replace(/\s+$/, '') };
          if (t) t.code.push(block);
          else (out.introCode || (out.introCode = [])).push(block);
          fence = null;
          code = [];
        } else {
          code.push(line);
        }
        continue;
      }
      if (inHtmlComment) {
        if (line.includes('-->')) inHtmlComment = false;
        continue;
      }
      if (/^\s*<!--/.test(line) && !line.includes('-->')) { inHtmlComment = true; continue; }
      const f = /^\s*(```+|~~~+)\s*([\w+#.-]*)/.exec(line);
      if (f) {
        flushPara();
        fence = f[1];
        codeLang = (f[2] || '').toLowerCase();
        code = [];
        continue;
      }
      const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (atx) { startSection(atx[1].length, atx[2]); continue; }
      const html = /^\s*<h([1-6])[^>]*>(.*?)<\/h\1>\s*$/i.exec(line);
      if (html) { startSection(Number(html[1]), html[2]); continue; }
      if (para.length && /^\s{0,3}(=+|-{2,})\s*$/.test(line) && !/^\s*[-*+]\s/.test(para[para.length - 1])) {
        const heading = para.pop();
        flushPara();
        startSection(line.trim()[0] === '=' ? 1 : 2, heading);
        continue;
      }
      if (!line.trim()) { flushPara(); continue; }
      const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (bullet && !/^\s*[-*_]{3,}\s*$/.test(line)) {
        flushPara();
        const text = plain(bullet[1]);
        if (text) pushBullet(text);
        continue;
      }
      if (/^\s*[-*_]{3,}\s*$/.test(line) || /^\s*\|/.test(line)) { flushPara(); continue; } // rules, tables
      para.push(line.trim());
    }
    if (fence) {
      const t = target();
      const block = { lang: codeLang, code: code.join('\n') };
      if (t) t.code.push(block);
    }
    flushPara();

    out.intro = out.intro.map(plain).filter(Boolean);
    for (const s of out.sections) s.paras = s.paras.map(plain).filter(Boolean);
    return out;
  }

  /** A paragraph that reads like prose, not a badge row or a link list. */
  function isProse(text) {
    const cjk = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
    if (cjk >= 10) return true; // Chinese, Japanese and Korean have no spaces between words
    return text.length >= 30 && /\p{L}{3,}\s+\p{L}{2,}/u.test(text) && (text.match(/\s/g) || []).length >= 4;
  }

  function cleanShell(block) {
    let lines = block.code.split('\n');
    const prompted = lines.filter((l) => /^\s*(\$|>|PS>|PS [A-Z]:\\[^>]*>|%)\s/.test(l));
    if (prompted.length && (block.lang === 'console' || block.lang === 'shell-session' || prompted.length < lines.length)) {
      lines = prompted; // drop output lines
    }
    lines = lines.map((l) => l.replace(/^\s*(\$|PS>|%)\s+/, '').replace(/^\s*>\s+(?=\w)/, ''));
    const text = lines.join('\n').trim();
    return text;
  }

  function looksLikeCommands(text, own = []) {
    const first = text.split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) || '';
    const word = (first.trim().split(/\s+/)[0] || '').toLowerCase();
    if (word && own.includes(word)) return true; // the project's own command, e.g. "rocket deploy"
    return /^(sudo\s+)?(npm|npx|pnpm|yarn|bun|deno|node|pip3?|pipx|python3?|py|uv|poetry|conda|mamba|cargo|rustup|go|make|cmake|docker|docker-compose|podman|kubectl|helm|git|brew|apt(-get)?|dnf|yum|pacman|snap|choco|winget|scoop|curl|wget|gem|bundle|rails|composer|php|mvn|gradle|\.\/gradlew|dotnet|nix|cd|cp|mv|mkdir|export|set|source|\.\s|\.\/|bash|sh|zsh|code|flutter|dart|swift|xcodebuild|mix|elixir|stack|cabal|ghc|zig|bazel|just|task|terraform|ansible|vagrant|hugo|jekyll|gh|tar|unzip|chmod|ln|echo)\b/i.test(first.trim());
  }

  // ============================================================ lightweight file parsers

  function parseJson(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  /** Very small TOML reader: [section] key = "value" (strings, numbers, booleans). Enough for names and versions. */
  function parseTomlLite(text) {
    const out = {};
    let section = '';
    const arrays = {};
    for (const raw of String(text || '').split('\n')) {
      const line = raw.replace(/\s+#.*$/, '').trim();
      if (!line) continue;
      const sec = /^\[\[?([^\]]+)\]\]?$/.exec(line);
      if (sec) {
        section = sec[1].trim();
        if (line.startsWith('[[')) arrays[section] = (arrays[section] || 0) + 1;
        out[section] = out[section] || {};
        continue;
      }
      const kv = /^([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(.+)$/.exec(line);
      if (!kv) continue;
      const key = kv[1].replace(/^"|"$/g, '');
      let val = kv[2].trim();
      if (/^"(.*)"$/.test(val) || /^'(.*)'$/.test(val)) val = val.slice(1, -1);
      else if (val === 'true' || val === 'false') val = val === 'true';
      else if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
      (out[section] = out[section] || {})[key] = val;
    }
    out.__arrays = arrays;
    return out;
  }

  function makeTargets(text) {
    const out = [];
    const re = /^([A-Za-z0-9][\w.-]*)\s*:(?!=)/gm;
    let m;
    while ((m = re.exec(String(text || ''))) && out.length < 40) {
      if (!out.includes(m[1]) && !/^\./.test(m[1])) out.push(m[1]);
    }
    return out;
  }

  // ============================================================ analysis (pure)

  const FOLDER_INFO = [
    [/^(src|source|sources)$/i, 'Source code'],
    [/^lib$/i, 'Library code'],
    [/^app$/i, 'Application code (often routes or pages)'],
    [/^(pages|routes)$/i, 'Pages and routes'],
    [/^components$/i, 'Reusable UI components'],
    [/^(public|static|assets|resources|res|media|images|img)$/i, 'Static files: images, icons, fonts'],
    [/^(docs?|documentation|website|site)$/i, 'Documentation'],
    [/^(tests?|__tests__|spec|specs|testing|e2e|cypress|playwright)$/i, 'Automated tests'],
    [/^(examples?|samples?|demos?|playground)$/i, 'Usage examples'],
    [/^(scripts?|bin|tools?|hack|utils?)$/i, 'Helper scripts and tools'],
    [/^\.github$/i, 'GitHub settings: CI workflows, issue templates'],
    [/^\.(circleci|gitlab|buildkite)$/i, 'CI configuration'],
    [/^\.(vscode|idea|devcontainer)$/i, 'Editor and dev-container settings'],
    [/^cmd$/i, 'Command-line entry points (Go)'],
    [/^pkg$/i, 'Public Go packages'],
    [/^internal$/i, 'Private internal code'],
    [/^(packages|modules)$/i, 'Monorepo packages'],
    [/^apps$/i, 'Monorepo applications'],
    [/^crates$/i, 'Rust crates (workspace members)'],
    [/^(config|configs|conf|settings)$/i, 'Configuration'],
    [/^(migrations|db|database|prisma|schema)$/i, 'Database schema and migrations'],
    [/^(include|headers)$/i, 'C/C++ header files'],
    [/^(vendor|third_party|third-party|external|deps)$/i, 'Bundled third-party code'],
    [/^(dist|build|out|target|release)$/i, 'Built output (committed to the repo)'],
    [/^(bench|benches|benchmarks?)$/i, 'Performance benchmarks'],
    [/^(deploy|deployment|k8s|kubernetes|helm|charts|infra|terraform|ops|ansible)$/i, 'Deployment and infrastructure'],
    [/^(android|ios|macos|windows|linux|web|desktop|mobile)$/i, 'Platform-specific code'],
    [/^(notebooks?)$/i, 'Jupyter notebooks'],
    [/^(data|datasets|fixtures)$/i, 'Data and fixtures'],
    [/^(locales?|i18n|lang|translations)$/i, 'Translations'],
    [/^(styles?|css|scss|sass)$/i, 'Stylesheets'],
    [/^(api|server|backend)$/i, 'Server / API code'],
    [/^(client|frontend|ui|web-ui)$/i, 'Front-end code'],
    [/^(models?)$/i, 'Data models'],
    [/^(plugins?|extensions?|addons?)$/i, 'Plugins and extensions'],
    [/^(types|typings|@types)$/i, 'Type definitions'],
    [/^(templates?|views|layouts)$/i, 'Templates and views'],
    [/^(proto|protos|protobuf)$/i, 'Protocol buffer definitions'],
    [/^(benchmark|perf)$/i, 'Performance tests'],
    [/^(\.husky|\.changeset)$/i, 'Git hooks and release notes tooling']
  ];

  function folderInfo(name) {
    for (const [re, d] of FOLDER_INFO) if (re.test(name)) return d;
    return null;
  }

  const TEST_RE = /(^|\/)(tests?|__tests__|spec|specs|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb|exs?)$|(^|\/)test_[^/]+\.py$|Tests?\.(cs|java|kt|swift)$/i;
  const CI_RE = /^(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|\.circleci\/config\.yml|azure-pipelines\.yml|\.travis\.yml|Jenkinsfile|bitbucket-pipelines\.yml|\.buildkite\/[^/]+|appveyor\.yml)$/;

  const ENTRY_CANDIDATES = [
    'src/index.ts', 'src/index.tsx', 'src/index.js', 'src/index.mjs', 'src/main.ts', 'src/main.tsx', 'src/main.js',
    'src/App.tsx', 'src/App.jsx', 'src/App.vue', 'src/App.svelte', 'app/page.tsx', 'app/page.jsx', 'app/layout.tsx', 'pages/index.tsx', 'pages/index.js',
    'src/routes/+page.svelte', 'index.ts', 'index.js', 'server.js', 'server.ts', 'app.js', 'app.ts',
    'main.go', 'src/main.rs', 'src/lib.rs', 'main.py', 'app.py', 'manage.py', 'src/__main__.py', '__main__.py', 'cli.py',
    'src/main.c', 'main.c', 'src/main.cpp', 'main.cpp', 'Program.cs', 'src/main/java', 'lib/main.dart', 'Sources', 'mix.exs', 'config.ru'
  ];

  const pct = (x) => Math.round(x * 1000) / 10;
  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const daysBetween = (a, b) => Math.max(0, Math.round((b - a) / DAY));
  const ts = (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  };
  const human = (n) => {
    if (n == null) return '—';
    const trim = (x) => x.replace(/\.0$/, '');
    if (n >= 1e6) return `${trim((n / 1e6).toFixed(1))}M`;
    if (n >= 1e5) return `${Math.round(n / 1000)}k`;
    if (n >= 1000) return `${trim((n / 1000).toFixed(1))}k`;
    return String(n);
  };
  const ago = (days) => (days == null ? 'unknown' : days === 0 ? 'today' : days === 1 ? 'yesterday' : days < 31 ? `${days} days ago`
    : days < 365 ? `${Math.round(days / 30)} month${Math.round(days / 30) === 1 ? '' : 's'} ago` : `${(days / 365).toFixed(days < 730 ? 1 : 0)} years ago`);

  /** Links and words that differ between GitHub, GitLab and Codeberg. */
  function platformOf(raw) {
    const id = raw.platform || 'github';
    const web = (raw.repo.html_url || `https://${raw.host || 'github.com'}/${raw.repo.full_name}`).replace(/\/$/, '');
    const branch = encodeURIComponent(raw.repo.default_branch || 'main');
    const P = {
      github: { name: 'GitHub', pr: 'pull request', prs: 'pull requests', file: (t, p) => `${web}/${t}/${branch}/${p}`, issues: `${web}/issues`, issue: (n) => `${web}/issues/${n}`,
        gfi: `${web}/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22`, fork: `Click "Fork" on ${web.replace(/^https:\/\//, '')} to get your own copy.`, open: 'On your fork, click "Compare & pull request".' },
      gitlab: { name: 'GitLab', pr: 'merge request', prs: 'merge requests', file: (t, p) => `${web}/-/${t}/${branch}/${p}`, issues: `${web}/-/issues`, issue: (n) => `${web}/-/issues/${n}`,
        gfi: `${web}/-/issues/?label_name%5B%5D=good%20first%20issue`, fork: `Click "Fork" on ${web.replace(/^https:\/\//, '')} to copy the project into your namespace.`, open: 'GitLab shows a "Create merge request" banner after you push; click it.' },
      codeberg: { name: 'Codeberg', pr: 'pull request', prs: 'pull requests', file: (t, p) => `${web}/src/branch/${branch}/${p}`, issues: `${web}/issues`, issue: (n) => `${web}/issues/${n}`,
        gfi: `${web}/issues?state=open`, fork: `Click "Fork" on ${web.replace(/^https:\/\//, '')} to get your own copy.`, open: 'On the original repository, open "Pull requests → New pull request" and pick your branch.' }
    }[id] || null;
    return { id, web, host: raw.host || 'github.com', ...(P || {}) };
  }

  function blobUrl(raw, path, type = 'blob') {
    const enc = path.split('/').map(encodeURIComponent).join('/');
    return platformOf(raw).file(type, enc);
  }

  function fileLookup(raw) {
    const files = raw.files || {};
    const byLower = {};
    for (const k of Object.keys(files)) byLower[k.toLowerCase()] = k;
    const get = (name) => {
      const k = byLower[name.toLowerCase()];
      return k ? files[k] : null;
    };
    const find = (re) => {
      const k = Object.keys(files).find((p) => re.test(p));
      return k ? { path: k, text: files[k] } : null;
    };
    return { get, find };
  }

  // ---------------------------------------------------------------- stack

  function detectStack(raw, F, paths) {
    const stack = [];
    const add = (name, category, evidence) => { if (!stack.some((s) => s.name === name)) stack.push({ name, category, evidence }); };
    const has = (p) => paths.has(p);

    const pkg = parseJson(F.get('package.json') || '');
    if (pkg) {
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) };
      const DEP_SIGNS = [
        ['next', 'Next.js', 'Framework'], ['react', 'React', 'UI library'], ['vue', 'Vue', 'Framework'], ['svelte', 'Svelte', 'Framework'],
        ['@sveltejs/kit', 'SvelteKit', 'Framework'], ['nuxt', 'Nuxt', 'Framework'], ['@angular/core', 'Angular', 'Framework'],
        ['astro', 'Astro', 'Framework'], ['solid-js', 'Solid', 'Framework'], ['@remix-run/react', 'Remix', 'Framework'],
        ['express', 'Express', 'Server'], ['fastify', 'Fastify', 'Server'], ['koa', 'Koa', 'Server'], ['hono', 'Hono', 'Server'],
        ['@nestjs/core', 'NestJS', 'Server'], ['electron', 'Electron', 'Desktop'], ['react-native', 'React Native', 'Mobile'],
        ['expo', 'Expo', 'Mobile'], ['vite', 'Vite', 'Build tool'], ['webpack', 'webpack', 'Build tool'], ['esbuild', 'esbuild', 'Build tool'],
        ['typescript', 'TypeScript', 'Language'], ['tailwindcss', 'Tailwind CSS', 'Styling'], ['prisma', 'Prisma', 'Database'],
        ['jest', 'Jest', 'Testing'], ['vitest', 'Vitest', 'Testing'], ['mocha', 'Mocha', 'Testing'], ['@playwright/test', 'Playwright', 'Testing'],
        ['cypress', 'Cypress', 'Testing'], ['eslint', 'ESLint', 'Linting'], ['@biomejs/biome', 'Biome', 'Linting'], ['prettier', 'Prettier', 'Formatting']
      ];
      add('Node.js', 'Runtime', 'package.json');
      for (const [dep, name, cat] of DEP_SIGNS) if (deps[dep]) add(name, cat, 'package.json');
    }
    const pyText = [F.get('pyproject.toml'), F.get('requirements.txt'), F.get('requirements-dev.txt'), F.get('setup.cfg')].filter(Boolean).join('\n');
    if (pyText || has('setup.py') || has('Pipfile')) {
      add('Python', 'Runtime', pyText ? 'pyproject / requirements' : 'setup.py');
      const PY = [['django', 'Django', 'Framework'], ['flask', 'Flask', 'Framework'], ['fastapi', 'FastAPI', 'Framework'],
        ['streamlit', 'Streamlit', 'Framework'], ['torch', 'PyTorch', 'ML'], ['tensorflow', 'TensorFlow', 'ML'], ['jax', 'JAX', 'ML'],
        ['transformers', 'Hugging Face Transformers', 'ML'], ['scikit-learn', 'scikit-learn', 'ML'], ['pandas', 'pandas', 'Data'],
        ['numpy', 'NumPy', 'Data'], ['pytest', 'pytest', 'Testing'], ['ruff', 'Ruff', 'Linting'], ['pydantic', 'Pydantic', 'Library'],
        ['sqlalchemy', 'SQLAlchemy', 'Database'], ['celery', 'Celery', 'Jobs'], ['click', 'Click', 'CLI'], ['typer', 'Typer', 'CLI']];
      for (const [dep, name, cat] of PY) if (new RegExp(`(^|["'\\s,\\[])${dep.replace(/[-]/g, '[-_]')}([\\s=<>~!;\\[",']|$)`, 'im').test(pyText)) add(name, cat, 'Python dependencies');
    }
    if (F.get('Cargo.toml') || has('Cargo.toml')) add('Rust', 'Language', 'Cargo.toml');
    if (F.get('go.mod') || has('go.mod')) add('Go', 'Language', 'go.mod');
    if (has('Gemfile')) add('Ruby', 'Language', 'Gemfile');
    if (has('config/routes.rb')) add('Ruby on Rails', 'Framework', 'config/routes.rb');
    if (F.get('composer.json') || has('composer.json')) add('PHP', 'Language', 'composer.json');
    if (has('artisan')) add('Laravel', 'Framework', 'artisan');
    if (has('pom.xml')) add('Maven (Java)', 'Build tool', 'pom.xml');
    if (has('build.gradle') || has('build.gradle.kts')) add('Gradle', 'Build tool', 'build.gradle');
    if ([...paths].some((p) => /\.(csproj|sln)$/.test(p) && !p.includes('/'))) add('.NET', 'Runtime', '.csproj / .sln');
    if (has('pubspec.yaml')) add('Flutter / Dart', 'Framework', 'pubspec.yaml');
    if (has('Package.swift')) add('Swift Package', 'Build tool', 'Package.swift');
    if (has('CMakeLists.txt')) add('CMake', 'Build tool', 'CMakeLists.txt');
    if (has('mix.exs')) add('Elixir', 'Language', 'mix.exs');
    if (has('deno.json') || has('deno.jsonc')) add('Deno', 'Runtime', 'deno.json');
    if (F.find(/^dockerfile$/i) || has('Dockerfile')) add('Docker', 'Container', 'Dockerfile');
    if ([...paths].some((p) => /^(docker-)?compose\.ya?ml$/.test(p))) add('Docker Compose', 'Container', 'compose file');
    if ([...paths].some((p) => /\.tf$/.test(p))) add('Terraform', 'Infrastructure', '.tf files');
    if (has('manifest.json') && raw.languages && raw.languages.JavaScript) add('Browser extension (likely)', 'Platform', 'manifest.json');
    if ([...paths].some((p) => /^\.github\/workflows\//.test(p))) add('GitHub Actions', 'CI', '.github/workflows');
    return { stack, pkg };
  }

  function detectKind(raw, F, paths, pkg, stack) {
    const name = raw.repo.name || '';
    const readme = F.find(/^readme/i);
    const linkCount = readme ? (readme.text.match(/\]\(https?:/g) || []).length : 0;
    const codeLangs = raw.languages ? Object.keys(raw.languages).filter((l) => !/^(markdown|html|css|scss|text|tex|shell|makefile|dockerfile)$/i.test(l)) : [];
    const hasStack = (n) => stack.some((s) => s.name === n);
    const pyproject = parseTomlLite(F.get('pyproject.toml') || '');
    const cargo = parseTomlLite(F.get('Cargo.toml') || '');

    if (/^awesome[-_]/i.test(name) || (linkCount > 60 && !codeLangs.length)) return { id: 'list', label: 'curated list of links' };
    if (!codeLangs.length && raw.languages && !Object.keys(raw.languages).length && paths.size) {
      const md = [...paths].filter((p) => /\.(md|mdx|rst|txt)$/i.test(p)).length;
      if (md > paths.size * 0.5) return { id: 'docs', label: 'documentation or writing project' };
    }
    if (pkg && (pkg.workspaces || paths.has('pnpm-workspace.yaml') || paths.has('lerna.json') || paths.has('turbo.json') || paths.has('nx.json'))) {
      return { id: 'monorepo', label: 'monorepo of several packages' };
    }
    if (hasStack('Browser extension (likely)')) return { id: 'extension', label: 'browser extension' };
    if (hasStack('Electron')) return { id: 'desktop', label: 'desktop app' };
    if (hasStack('React Native') || hasStack('Expo') || hasStack('Flutter / Dart')) return { id: 'mobile', label: 'mobile app' };
    if (pkg) {
      if (pkg.bin) return { id: 'cli', label: 'command-line tool' };
      const web = ['Next.js', 'Nuxt', 'SvelteKit', 'Astro', 'Remix', 'Angular'].some(hasStack) || (pkg.private && ['React', 'Vue', 'Svelte', 'Solid'].some(hasStack));
      if (web) return { id: 'webapp', label: 'web app' };
      if (['Express', 'Fastify', 'Koa', 'Hono', 'NestJS'].some(hasStack) && pkg.private !== false && !pkg.main && !pkg.exports) return { id: 'service', label: 'web service / API' };
      if ((pkg.main || pkg.exports || pkg.module || pkg.types) && !pkg.private) return { id: 'library', label: 'JavaScript library' };
    }
    if (pyproject.project || pyproject['tool.poetry'] || paths.has('setup.py')) {
      const scripts = pyproject['project.scripts'] || pyproject['tool.poetry.scripts'];
      if (['Django', 'Flask', 'FastAPI', 'Streamlit'].some(hasStack) && !scripts) return { id: 'webapp', label: 'Python web app' };
      if (scripts && Object.keys(scripts).length) return { id: 'cli', label: 'Python command-line tool' };
      return { id: 'library', label: 'Python library' };
    }
    if (F.get('requirements.txt') && ['Django', 'Flask', 'FastAPI', 'Streamlit'].some(hasStack)) return { id: 'webapp', label: 'Python web app' };
    if (cargo.package || cargo.workspace) {
      if (cargo.workspace && !cargo.package) return { id: 'monorepo', label: 'Rust workspace' };
      if (paths.has('src/main.rs') || (cargo.__arrays && cargo.__arrays.bin)) return { id: 'cli', label: 'Rust program' };
      return { id: 'library', label: 'Rust library (crate)' };
    }
    if (F.get('go.mod')) {
      if (paths.has('main.go') || [...paths].some((p) => /^cmd\/[^/]+\/main\.go$/.test(p))) return { id: 'cli', label: 'Go program' };
      return { id: 'library', label: 'Go module' };
    }
    if (hasStack('Docker')) return { id: 'service', label: 'containerized application' };
    if (raw.repo.language) return { id: 'project', label: `${raw.repo.language} project` };
    return { id: 'project', label: 'project' };
  }

  // ---------------------------------------------------------------- summaries

  function codeHint(blocks) {
    const b = blocks[0];
    const first = b ? (SHELL_LANGS.has(b.lang) ? cleanShell(b) : b.code).split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !l.startsWith('//')) : null;
    return first ? `Example: ${first.slice(0, 120)}` : `${blocks.length} code example${blocks.length === 1 ? '' : 's'}.`;
  }

  function buildSummary(raw, md, kind, languages, stack, trust) {
    const r = raw.repo;
    const intro = md ? md.intro.filter(isProse) : [];
    const firstProse = intro[0] || (md && md.sections.length ? md.sections[0].paras.find(isProse) : '') || '';
    const desc = r.description ? plain(r.description) : '';
    const oneLineCore = desc || firstSentence(firstProse, 160) || `A ${kind.label}.`;
    const endPunct = (t) => (/[\p{Script=Latin}\d)"']$/u.test(t) ? t + '.' : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(t) ? t + '。' : t);
    const oneLine = endPunct(oneLineCore);

    const parts = [];
    const squash = (t) => String(t || '').toLowerCase().replace(/[\s\p{P}]+/gu, '');
    let lead = firstProse && (!desc || !firstProse.toLowerCase().startsWith(desc.slice(0, 30).toLowerCase())) ? firstSentence(firstProse, 260) : '';
    if (lead && desc && (squash(desc).includes(squash(lead)) || squash(lead).includes(squash(desc)))) lead = ''; // says the same thing
    parts.push(desc ? endPunct(desc) : oneLine);
    if (lead && lead !== oneLine) parts.push(lead);
    const article = /^[aeiou]/i.test(kind.label) ? 'an' : 'a';
    const langBit = languages.length
      ? ` written mainly in ${languages[0].name}${languages.length > 1 && languages[1].share >= 0.1 ? ` and ${languages[1].name}` : ''}`
      : '';
    const fw = stack.filter((s) => ['Framework', 'UI library', 'Server', 'ML'].includes(s.category)).map((s) => s.name).slice(0, 3);
    const kindSaid = parts.join(' ').toLowerCase().includes(kind.label.toLowerCase());
    parts.push(kindSaid
      ? (langBit || fw.length ? `It is${langBit}${fw.length ? `${langBit ? ',' : ''} built with ${fw.join(', ')}` : ''}.` : '')
      : `It is ${article} ${kind.label}${langBit}${fw.length ? `, built with ${fw.join(', ')}` : ''}.`);
    if (trust.license.ok) parts.push(`It is open source under the ${trust.license.short} license.`);
    else if (!trust.license.spdx) parts.push('It has no license, so by default you may read the code but not reuse it.');
    const pop = r.stargazers_count != null ? `${human(r.stargazers_count)} stars` : null;
    const act = r.archived ? 'The project is archived and read-only.'
      : trust.lastCommit.days != null ? `The last change was ${ago(trust.lastCommit.days)}${pop ? `, and it has ${pop}` : ''}.` : (pop ? `It has ${pop}.` : '');
    if (act) parts.push(act);

    // Full summary: what each README section is about.
    const sections = [];
    if (md) {
      for (const s of md.sections) {
        if (s.level > 3 || /^(table of contents|contents|toc|license|licence|badges?|sponsors?|backers|contributors|acknowledg|credits|star history)/i.test(s.heading)) continue;
        const text = s.paras.find(isProse);
        const bullets = s.bullets.filter((b) => b.length > 3).slice(0, 4);
        if (!text && !bullets.length && !s.code.length) continue;
        sections.push({
          heading: s.heading.slice(0, 80),
          level: s.level,
          text: text ? firstSentence(text, 240) : bullets.length ? bullets.join(' · ').slice(0, 240) : codeHint(s.code)
        });
        if (sections.length >= 14) break;
      }
    }
    const featSec = md ? md.sections.find((s) => /feature|highlight|why |why$|what (it|this) (does|can)|key|capabilit|benefit|功能|特点|特性|特色|亮点|機能|特徴|기능|特長|возможности/i.test(s.heading) && s.bullets.length) : null;
    const features = featSec ? featSec.bullets.map((b) => b.replace(/^[^\p{L}\p{N}"'(]+/u, '').slice(0, 160)).filter(Boolean).slice(0, 8) : [];

    return {
      oneLine,
      paragraph: parts.filter(Boolean).join(' '),
      sections,
      features,
      topics: r.topics || [],
      readmeFound: Boolean(md),
      title: md && md.title ? md.title : r.name
    };
  }

  // ---------------------------------------------------------------- setup guide

  function buildSetup(raw, md, F, paths, pkg, kind) {
    const r = raw.repo;
    const name = r.full_name.split('/').pop();
    const owner = r.full_name.split('/').slice(0, -1).join('/');
    const prereqs = [];
    const detected = [];
    const notes = [];

    // The project's own command names count as commands in README blocks.
    const own = [name.toLowerCase()];
    if (pkg && pkg.bin && typeof pkg.bin === 'object') own.push(...Object.keys(pkg.bin).map((x) => x.toLowerCase()));
    if (pkg && typeof pkg.bin === 'string' && pkg.name) own.push(String(pkg.name).split('/').pop().toLowerCase());
    const pyScripts = parseTomlLite(F.get('pyproject.toml') || '')['project.scripts'];
    if (pyScripts) own.push(...Object.keys(pyScripts).map((x) => x.toLowerCase()));

    // From the README
    const readme = [];
    const examples = [];
    if (md) {
      const SETUP_RE = /install|getting started|get started|quick ?start|setup|set up|usage|how to (use|run)|running|run locally|build(ing)?|develop|local|requirements|prerequisites|deploy|docker|安装|安裝|快速开始|快速開始|快速上手|开始使用|使用|部署|运行|運行|启动|环境|依赖|インストール|使い方|始め方|セットアップ|설치|사용법|시작하기|установка|использование|запуск/i;
      for (const s of md.sections) {
        if (!SETUP_RE.test(s.heading)) continue;
        const cmds = [];
        for (const b of s.code) {
          if (SHELL_LANGS.has(b.lang)) {
            const text = cleanShell(b);
            if (text && looksLikeCommands(text, own) && text.length < 1500) cmds.push(text);
          } else if (examples.length < 3 && b.code.trim() && b.code.length < 1500 && /usage|example|quick|getting/i.test(s.heading)) {
            examples.push({ heading: s.heading, lang: b.lang, code: b.code.trim() });
          }
        }
        const note = s.paras.find(isProse);
        if (cmds.length) readme.push({ heading: s.heading.slice(0, 80), note: note ? firstSentence(note, 200) : null, commands: cmds.slice(0, 4) });
        if (readme.length >= 6) break;
      }
      // Some READMEs put the install command in the intro.
      if (!readme.length && md.introCode) {
        const cmds = md.introCode.filter((b) => SHELL_LANGS.has(b.lang)).map(cleanShell).filter((t) => t && looksLikeCommands(t, own));
        if (cmds.length) readme.push({ heading: 'From the top of the README', note: null, commands: cmds.slice(0, 3) });
      }
    }

    const clone = `git clone ${platformOf(raw).web}.git\ncd ${name}`;
    const hasFile = (p) => paths.has(p) || F.get(p) != null;
    const env = ['.env.example', '.env.sample', '.env.template', 'example.env', '.env.dist'].find(hasFile);

    // Node
    if (pkg) {
      const pm = pkg.packageManager ? String(pkg.packageManager).split('@')[0]
        : hasFile('pnpm-lock.yaml') ? 'pnpm' : hasFile('yarn.lock') ? 'yarn' : (hasFile('bun.lockb') || hasFile('bun.lock')) ? 'bun' : 'npm';
      const install = pm === 'npm' ? (hasFile('package-lock.json') ? 'npm ci' : 'npm install') : pm === 'yarn' ? 'yarn install' : `${pm} install`;
      const run = (s) => (pm === 'npm' ? (s === 'start' || s === 'test' ? `npm ${s}` : `npm run ${s}`) : pm === 'yarn' ? `yarn ${s}` : `${pm} run ${s}`);
      const node = (pkg.engines && pkg.engines.node) || (F.get('.nvmrc') || F.get('.node-version') || '').trim() || null;
      if (node) prereqs.push({ name: 'Node.js', value: node, source: pkg.engines && pkg.engines.node ? 'package.json engines' : '.nvmrc' });
      else prereqs.push({ name: 'Node.js', value: 'a current LTS version', source: 'package.json' });
      if (pm !== 'npm') prereqs.push({ name: pm, value: pkg.packageManager ? String(pkg.packageManager).split('@')[1] || 'latest' : 'latest', source: pkg.packageManager ? 'packageManager field' : 'lockfile' });
      const scripts = pkg.scripts || {};
      const ORDER = [['dev', 'start in development mode'], ['start', 'start the app'], ['serve', 'serve locally'], ['develop', 'start in development mode'],
        ['build', 'production build'], ['test', 'run the tests'], ['lint', 'check code style'], ['typecheck', 'check types']];
      const cmds = [clone, env ? `cp ${env} .env   # then fill in the values` : null, install].filter(Boolean);
      const runs = ORDER.filter(([s]) => scripts[s]).map(([s, why]) => [run(s), why]);
      const width = Math.max(0, ...runs.map(([c]) => c.length));
      for (const [c, why] of runs) cmds.push(`${c.padEnd(width)}   # ${why}`);
      detected.push({ title: 'Run it locally (Node.js)', source: 'package.json', commands: [cmds.join('\n')], scripts: Object.keys(scripts).slice(0, 20) });
      if (pkg.name && !pkg.private && kind.id !== 'webapp' && kind.id !== 'service') {
        const cmd = pkg.bin ? `npm install -g ${pkg.name}` : `${pm === 'npm' ? 'npm install' : pm === 'yarn' ? 'yarn add' : `${pm} add`} ${pkg.name}`;
        detected.unshift({ title: pkg.bin ? 'Install the command' : 'Use it in your project', source: 'package.json name', commands: [cmd] });
      }
    }

    // Python
    const py = parseTomlLite(F.get('pyproject.toml') || '');
    const reqs = F.get('requirements.txt');
    if (py.project || py['tool.poetry'] || reqs || paths.has('setup.py') || paths.has('Pipfile')) {
      const pyVer = (py.project && py.project['requires-python']) || (py['tool.poetry.dependencies'] && py['tool.poetry.dependencies'].python) || (F.get('.python-version') || '').trim() || null;
      prereqs.push({ name: 'Python', value: pyVer || '3.x', source: pyVer ? (F.get('.python-version') ? '.python-version' : 'pyproject.toml') : 'project files' });
      const cmds = [clone];
      if (hasFile('uv.lock')) {
        prereqs.push({ name: 'uv', value: 'latest', source: 'uv.lock' });
        cmds.push('uv sync');
      } else if (py['tool.poetry'] || hasFile('poetry.lock')) {
        prereqs.push({ name: 'Poetry', value: 'latest', source: 'pyproject.toml' });
        cmds.push('poetry install');
      } else if (paths.has('Pipfile')) {
        cmds.push('pipenv install');
      } else {
        cmds.push('python -m venv .venv', 'source .venv/bin/activate   # Windows: .venv\\Scripts\\activate');
        if (reqs) cmds.push('pip install -r requirements.txt');
        if (py.project || paths.has('setup.py')) cmds.push(`pip install -e .${py['project.optional-dependencies'] && py['project.optional-dependencies'].dev ? '[dev]' : ''}`);
        if (F.get('requirements-dev.txt')) cmds.push('pip install -r requirements-dev.txt');
      }
      if (env) cmds.splice(1, 0, `cp ${env} .env   # then fill in the values`);
      if (paths.has('manage.py')) cmds.push('python manage.py migrate', 'python manage.py runserver');
      const scripts = py['project.scripts'] || py['tool.poetry.scripts'];
      if (scripts) cmds.push(`${Object.keys(scripts)[0]} --help`);
      else if (paths.has('main.py')) cmds.push('python main.py');
      else if (paths.has('app.py')) cmds.push(/streamlit/i.test(reqs || '') ? 'streamlit run app.py' : 'python app.py');
      if ([...paths].some((p) => TEST_RE.test(p) && p.endsWith('.py'))) cmds.push('pytest');
      detected.push({ title: 'Run it locally (Python)', source: py.project ? 'pyproject.toml' : reqs ? 'requirements.txt' : 'setup.py', commands: [cmds.join('\n')] });
      const pyName = (py.project && py.project.name) || (py['tool.poetry'] && py['tool.poetry'].name);
      if (pyName && kind.id !== 'webapp') detected.unshift({ title: kind.id === 'cli' ? 'Install the command' : 'Use it in your project', source: 'pyproject.toml name', commands: [kind.id === 'cli' ? `pipx install ${pyName}` : `pip install ${pyName}`] });
    }

    // Rust
    const cargo = parseTomlLite(F.get('Cargo.toml') || '');
    if (cargo.package || cargo.workspace) {
      prereqs.push({ name: 'Rust', value: (cargo.package && cargo.package['rust-version']) ? `${cargo.package['rust-version']} or newer` : 'stable (via rustup)', source: 'Cargo.toml' });
      const bin = paths.has('src/main.rs') || (cargo.__arrays && cargo.__arrays.bin);
      detected.push({ title: 'Build and run (Rust)', source: 'Cargo.toml', commands: [[clone, 'cargo build --release', bin ? 'cargo run -- --help' : null, 'cargo test'].filter(Boolean).join('\n')] });
      if (cargo.package && cargo.package.name) detected.unshift({ title: bin ? 'Install the command' : 'Use it in your project', source: 'Cargo.toml name', commands: [bin ? `cargo install ${cargo.package.name}` : `cargo add ${cargo.package.name}`] });
    }

    // Go
    const gomod = F.get('go.mod');
    if (gomod) {
      const mod = (/^module\s+(\S+)/m.exec(gomod) || [])[1];
      const ver = (/^go\s+([\d.]+)/m.exec(gomod) || [])[1];
      prereqs.push({ name: 'Go', value: ver ? `${ver} or newer` : 'latest', source: 'go.mod' });
      const cmdDirs = [...paths].filter((p) => /^cmd\/[^/]+$/.test(p)).map((p) => p.split('/')[1]);
      const runLine = paths.has('main.go') ? 'go run .' : cmdDirs.length ? `go run ./cmd/${cmdDirs[0]}` : null;
      detected.push({ title: 'Build and run (Go)', source: 'go.mod', commands: [[clone, 'go build ./...', runLine, 'go test ./...'].filter(Boolean).join('\n')] });
      if (mod) detected.unshift({ title: runLine ? 'Install the command' : 'Use it in your project', source: 'go.mod module', commands: [runLine ? `go install ${mod}${cmdDirs.length && !paths.has('main.go') ? `/cmd/${cmdDirs[0]}` : ''}@latest` : `go get ${mod}`] });
    }

    // Ruby / PHP
    if (paths.has('Gemfile')) detected.push({ title: 'Install dependencies (Ruby)', source: 'Gemfile', commands: [[clone, 'bundle install', paths.has('bin/rails') || paths.has('config/routes.rb') ? 'bin/rails server' : null].filter(Boolean).join('\n')] });
    if (paths.has('composer.json')) detected.push({ title: 'Install dependencies (PHP)', source: 'composer.json', commands: [[clone, 'composer install', paths.has('artisan') ? 'php artisan serve' : null].filter(Boolean).join('\n')] });

    // Docker
    const dockerfile = F.find(/^dockerfile$/i);
    const compose = F.find(/^(docker-)?compose\.ya?ml$/);
    if (compose) {
      prereqs.push({ name: 'Docker', value: 'with Compose', source: compose.path });
      detected.push({ title: 'Run with Docker Compose', source: compose.path, commands: [[clone, env ? `cp ${env} .env` : null, 'docker compose up --build'].filter(Boolean).join('\n')] });
    } else if (dockerfile) {
      const exposes = [];
      const re = /^\s*EXPOSE\s+([\d\s/a-z]+)/gim;
      let m;
      while ((m = re.exec(dockerfile.text))) for (const p of m[1].trim().split(/\s+/)) if (/^\d+/.test(p)) exposes.push(p.split('/')[0]);
      const port = exposes[0];
      const base = (/^\s*FROM\s+(\S+)/im.exec(dockerfile.text) || [])[1];
      prereqs.push({ name: 'Docker', value: 'any recent version', source: 'Dockerfile' });
      const tag = name.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
      detected.push({
        title: 'Run with Docker', source: 'Dockerfile',
        commands: [[clone, `docker build -t ${tag} .`, `docker run --rm${port ? ` -p ${port}:${port}` : ''} ${tag}`].join('\n')],
        note: [base ? `Based on ${base}` : null, port ? `serves on port ${port}` : null].filter(Boolean).join(', ') || null
      });
    }

    // Makefile
    const make = F.find(/^makefile$/i);
    if (make) {
      const targets = makeTargets(make.text);
      const useful = ['install', 'setup', 'deps', 'bootstrap', 'build', 'dev', 'run', 'serve', 'start', 'test', 'check', 'lint'].filter((t) => targets.includes(t));
      if (useful.length) detected.push({ title: 'Shortcuts in the Makefile', source: 'Makefile', commands: [useful.map((t) => `make ${t}`).join('\n')], scripts: targets.slice(0, 20) });
    }

    if (env) notes.push(`Copy ${env} to .env and fill it in before running — the app reads its settings from there.`);
    if (!readme.length && !detected.length) notes.push('No install steps could be found in the README or project files.');

    // Don't repeat a one-line install command the README already shows.
    const readmeLines = new Set(readme.flatMap((x) => x.commands.flatMap((c) => c.split('\n').map((l) => l.trim()))));
    const kept = detected.filter((d) => !(d.commands.length === 1 && !d.commands[0].includes('\n') && readmeLines.has(d.commands[0].trim())));

    return { prereqs: dedupe(prereqs, (p) => p.name), readme, detected: dedupe(kept, (d) => d.title), examples, env: env || null, notes };
  }

  function dedupe(arr, key) {
    const seen = new Set();
    return arr.filter((x) => {
      const k = key(x);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // ---------------------------------------------------------------- folder map + read first

  function buildMap(raw, F, paths, pkg) {
    const entries = raw.tree.entries;
    const stats = raw.tree.stats;
    const top = [];
    const topDirs = entries.filter((e) => e.type === 'tree' && !e.path.includes('/'));
    for (const d of topDirs) {
      const s = stats.top[d.path] || { files: 0, bytes: 0 };
      const children = entries.filter((e) => e.type === 'tree' && e.path.startsWith(d.path + '/') && e.path.split('/').length === 2).map((e) => e.path.split('/')[1]);
      top.push({ name: d.path, type: 'dir', files: s.files, bytes: s.bytes, desc: folderInfo(d.path), children: children.slice(0, 6), more: Math.max(0, children.length - 6), url: blobUrl(raw, d.path, 'tree') });
    }
    top.sort((a, b) => (a.name.startsWith('.') ? 1 : 0) - (b.name.startsWith('.') ? 1 : 0) || b.files - a.files || (a.name < b.name ? -1 : 1));
    const rootFiles = entries.filter((e) => e.type === 'blob' && !e.path.includes('/')).map((e) => ({ name: e.path, bytes: e.size, url: blobUrl(raw, e.path) }));

    const blobs = entries.filter((e) => e.type === 'blob');
    const tests = blobs.filter((e) => TEST_RE.test(e.path));
    const ci = blobs.filter((e) => CI_RE.test(e.path));
    const largest = [...blobs].sort((a, b) => b.size - a.size).slice(0, 5).map((e) => ({ path: e.path, bytes: e.size, url: blobUrl(raw, e.path) }));

    // Files to read first
    const read = [];
    const addRead = (path, reason) => {
      if (!path || read.some((x) => x.path === path)) return;
      read.push({ path, reason, url: blobUrl(raw, path) });
    };
    const findPath = (re) => blobs.find((e) => re.test(e.path));
    const readmeEntry = findPath(/^readme(\.\w+)?$/i) || (Object.keys(raw.files || {}).find((p) => /^readme/i.test(p)) ? { path: Object.keys(raw.files).find((p) => /^readme/i.test(p)) } : null);
    if (readmeEntry) addRead(readmeEntry.path, 'What it is and how to use it');
    const arch = findPath(/^(architecture|ARCHITECTURE|design|DESIGN|HACKING|hacking|INTERNALS)\.md$/) || findPath(/^docs?\/(architecture|design|internals|overview)[^/]*\.md$/i);
    if (arch) addRead(arch.path, 'How the pieces fit together');
    const contrib = findPath(/^(\.github\/|docs\/)?contributing(\.\w+)?$/i);
    if (contrib) addRead(contrib.path, 'How to set up and send changes');
    const manifest = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'setup.py', 'Gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'pubspec.yaml', 'mix.exs', 'CMakeLists.txt']
      .find((p) => paths.has(p));
    if (manifest) addRead(manifest, 'Dependencies and project commands');

    const entryPoints = [];
    const resolve = (p) => {
      if (!p || typeof p !== 'string') return null;
      const clean = p.replace(/^\.\//, '');
      for (const c of [clean, clean + '.js', clean + '.ts', clean + '/index.js', clean + '/index.ts']) if (paths.has(c)) return c;
      // Built entry (dist/index.js) → look for the source version.
      const src = clean.replace(/^(dist|build|lib|out)\//, 'src/').replace(/\.(c|m)?js$/, '');
      for (const c of [src + '.ts', src + '.tsx', src + '.js', src + '.mjs']) if (paths.has(c)) return c;
      return null;
    };
    if (pkg) {
      const binPath = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && typeof pkg.bin === 'object' ? Object.values(pkg.bin)[0] : null;
      const exp = pkg.exports && typeof pkg.exports === 'object' ? (pkg.exports['.'] && (typeof pkg.exports['.'] === 'string' ? pkg.exports['.'] : pkg.exports['.'].import || pkg.exports['.'].default || pkg.exports['.'].require)) : typeof pkg.exports === 'string' ? pkg.exports : null;
      for (const p of [binPath, pkg.module, exp, pkg.main]) {
        const r = resolve(typeof p === 'string' ? p : null);
        if (r && !entryPoints.includes(r)) entryPoints.push(r);
      }
    }
    for (const c of ENTRY_CANDIDATES) {
      if (entryPoints.length >= 2) break;
      if (paths.has(c) && !entryPoints.includes(c)) entryPoints.push(c);
    }
    if (entryPoints.length < 2) {
      const goCmd = blobs.find((e) => /^cmd\/[^/]+\/main\.go$/.test(e.path));
      if (goCmd) entryPoints.push(goCmd.path);
    }
    for (const e of entryPoints.slice(0, 2)) addRead(e, 'Where the program starts');
    const example = blobs.find((e) => /^(examples?|samples?)\/[^/]+\.\w+$/i.test(e.path) && !/readme/i.test(e.path)) || blobs.find((e) => /^(examples?|samples?)\//i.test(e.path) && /\.(js|ts|py|go|rs|rb|java|kt|c|cpp|cs|swift|php|sh)$/.test(e.path));
    if (example) addRead(example.path, 'A small working example');
    const test = [...tests].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.size - b.size).find((e) => e.size > 200);
    if (test) addRead(test.path, 'Shows what the code is expected to do');
    if (ci[0]) addRead(ci[0].path, 'How it is built and tested automatically');

    return {
      totals: { files: stats.files, bytes: stats.bytes, dirs: stats.dirs },
      truncated: raw.tree.truncated,
      trimmed: raw.tree.trimmed,
      top: top.slice(0, 30),
      rootFiles: rootFiles.slice(0, 40),
      readFirst: read.slice(0, 8),
      largest,
      tests: { count: tests.length, share: stats.files ? tests.length / stats.files : 0 },
      ci: ci.map((e) => e.path).slice(0, 10),
      hasTree: entries.length > 0
    };
  }

  // ---------------------------------------------------------------- trust

  const LICENSE_SHORT = { 'MIT': 'MIT', 'Apache-2.0': 'Apache 2.0', 'GPL-3.0': 'GPL-3.0', 'GPL-2.0': 'GPL-2.0', 'AGPL-3.0': 'AGPL-3.0', 'LGPL-3.0': 'LGPL-3.0', 'LGPL-2.1': 'LGPL-2.1', 'BSD-3-Clause': 'BSD 3-Clause', 'BSD-2-Clause': 'BSD 2-Clause', 'MPL-2.0': 'MPL 2.0', 'ISC': 'ISC', 'Unlicense': 'Unlicense', 'CC0-1.0': 'CC0', 'BSL-1.0': 'Boost', 'EPL-2.0': 'EPL 2.0' };
  const COPYLEFT = new Set(['GPL-3.0', 'GPL-2.0', 'AGPL-3.0', 'LGPL-3.0', 'LGPL-2.1', 'MPL-2.0', 'EPL-2.0']);

  function licenseInfo(raw) {
    const l = raw.repo.license;
    if (!l || !l.spdx_id) return { spdx: null, name: null, short: null, ok: false, kind: 'none', plain: 'No license — you may read the code, but not copy, change or share it without permission.' };
    if (l.spdx_id === 'NOASSERTION') return { spdx: 'NOASSERTION', name: l.name || 'Custom', short: 'custom', ok: false, kind: 'custom', plain: 'Has a license that could not be recognized automatically. Read the LICENSE file before reusing the code.' };
    const copyleft = COPYLEFT.has(l.spdx_id);
    return {
      spdx: l.spdx_id, name: l.name, short: LICENSE_SHORT[l.spdx_id] || l.spdx_id, ok: true, kind: copyleft ? 'copyleft' : 'permissive',
      plain: copyleft ? `${LICENSE_SHORT[l.spdx_id] || l.spdx_id}: free to use, but if you share changed versions you must share your changes under the same license.`
        : `${LICENSE_SHORT[l.spdx_id] || l.spdx_id}: free to use, change and share, including in commercial work.`
    };
  }

  // ---------------------------------------------------------------- activity, pull requests, security (pure)

  function buildActivity(raw) {
    const ca = raw.commitActivity || { status: 'unavailable', weeks: [] };
    const weeks = ca.weeks || [];
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const recent = sum(weeks.slice(-13));
    const before = sum(weeks.slice(-26, -13));
    let trend = null;
    if (weeks.length >= 26) {
      if (recent === 0 && before === 0) trend = 'none';
      else if (recent >= before * 1.25 + 1) trend = 'up';
      else if (recent <= before * 0.75 - 1) trend = 'down';
      else trend = 'steady';
    }
    return {
      status: ca.status,
      weeks,
      total: sum(weeks),
      activeWeeks: weeks.filter((w) => w > 0).length,
      last13: recent,
      prev13: before,
      trend,
      peak: weeks.length ? Math.max(...weeks) : 0
    };
  }

  const OUTSIDE = new Set(['NONE', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'CONTRIBUTOR']);

  function buildPulls(raw) {
    if (!raw.pulls) return { available: false };
    const list = raw.pulls.filter((p) => !p.bot);
    const merged = list.filter((p) => p.merged_at);
    const mergeDays = merged.map((p) => (ts(p.merged_at) - ts(p.created_at)) / DAY).filter((d) => d >= 0);
    const outside = list.filter((p) => OUTSIDE.has(p.author_association));
    const outsideMerged = outside.filter((p) => p.merged_at);
    return {
      available: true,
      sample: list.length,
      bots: raw.pulls.length - list.length,
      merged: merged.length,
      mergeRate: list.length ? merged.length / list.length : null,
      medianMergeDays: mergeDays.length ? Math.round(median(mergeDays) * 10) / 10 : null,
      outside: outside.length,
      outsideMerged: outsideMerged.length,
      outsideMergeRate: outside.length ? outsideMerged.length / outside.length : null
    };
  }

  const BINARY_RE = /\.(exe|dll|so|dylib|jar|class|pyc|pyo|o|a|lib|war|ear|apk|msi|bin|wasm|deb|rpm)$/i;
  const SAST_RE = /github\/codeql-action|returntocorp\/semgrep|semgrep\/semgrep|snyk\/actions|sonarsource\/|securego\/gosec|aquasecurity\/trivy|ossf\/scorecard-action|anchore\/scan-action|zaproxy\/action|bearer\/bearer-action/i;

  /** Lightweight versions of OpenSSF Scorecard's workflow checks, run on the YAML text. */
  function analyzeWorkflows(files) {
    const out = { count: 0, actions: 0, pinned: 0, unpinned: [], withPermissions: 0, dangerous: [], curlPipe: [], sast: false, files: [] };
    for (const [path, text] of Object.entries(files)) {
      if (!/^\.github\/workflows\//.test(path)) continue;
      out.count += 1;
      const name = path.split('/').pop();
      const info = { path, actions: 0, pinned: 0, permissions: /^\s*permissions\s*:/m.test(text) };
      if (info.permissions) out.withPermissions += 1;
      const re = /^\s*-?\s*uses\s*:\s*["']?([^\s"'#]+)["']?/gm;
      let m;
      while ((m = re.exec(text))) {
        const ref = m[1];
        if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
        const at = ref.lastIndexOf('@');
        const version = at > 0 ? ref.slice(at + 1) : '';
        info.actions += 1;
        out.actions += 1;
        if (/^[0-9a-f]{40}$/i.test(version)) { info.pinned += 1; out.pinned += 1; }
        else if (out.unpinned.length < 12 && !out.unpinned.includes(ref)) out.unpinned.push(ref);
      }
      if (SAST_RE.test(text)) out.sast = true;
      const prTarget = /\bpull_request_target\b/.test(text);
      const checksOutHead = /github\.event\.pull_request\.head\.(sha|ref)|github\.head_ref/.test(text);
      if (prTarget && checksOutHead) out.dangerous.push({ path, kind: 'pr-target-checkout', text: `${name}: runs pull_request_target and checks out the pull request's code (it can run with repository secrets)` });
      const inject = /\$\{\{\s*github\.(event\.(issue\.(title|body)|pull_request\.(title|body)|comment\.body|review\.body|review_comment\.body|pages\.[^}]*page_name|commits[^}]*message|head_commit\.(message|author\.(email|name)))|head_ref)\s*\}\}/;
      // Collect only the lines that belong to `run:` steps (the shell commands).
      const runLines = [];
      let runIndent = -1;
      for (const l of text.split('\n')) {
        const indent = l.length - l.trimStart().length;
        const runStart = /^(\s*)(-\s+)?run\s*:/.exec(l);
        if (runStart) {
          runIndent = runStart[1].length + (runStart[2] ? runStart[2].length : 0);
          runLines.push(l);
        } else if (runIndent >= 0 && (l.trim() === '' || indent > runIndent)) {
          runLines.push(l);
        } else {
          runIndent = -1;
        }
      }
      if (runLines.some((l) => inject.test(l))) out.dangerous.push({ path, kind: 'script-injection', text: `${name}: puts untrusted text (issue or PR titles, comments, branch names) straight into a shell command` });
      if (/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/.test(text)) out.curlPipe.push(name);
      out.files.push(info);
    }
    out.pinnedShare = out.actions ? out.pinned / out.actions : null;
    return out;
  }

  function buildSecurity(raw, paths, map) {
    const entries = raw.tree.entries;
    const wf = analyzeWorkflows(raw.files || {});
    const binaries = entries.filter((e) => e.type === 'blob' && BINARY_RE.test(e.path) && !/(^|\/)(test|tests|fixtures?|testdata)\//i.test(e.path)).map((e) => e.path);
    const policyPath = [...paths].find((p) => /^(\.github\/|docs\/)?security\.md$/i.test(p)) || null;
    const advisories = raw.advisories ? [...raw.advisories].sort((a, b) => (ts(b.published) || 0) - (ts(a.published) || 0)) : null;
    const depsBot = [...paths].find((p) => /^(\.github\/dependabot\.ya?ml|renovate\.json5?|\.renovaterc(\.json)?|\.github\/renovate\.json5?)$/.test(p)) || null;
    return {
      policy: policyPath ? { path: policyPath, url: blobUrl(raw, policyPath) } : null,
      advisories: advisories ? { count: advisories.length, list: advisories.slice(0, 6), more: advisories.length >= 30 } : null,
      depsBot: depsBot ? { path: depsBot, tool: /renovate/i.test(depsBot) ? 'Renovate' : 'Dependabot' } : null,
      workflows: wf,
      binaries: { count: binaries.length, sample: binaries.slice(0, 6) },
      sast: wf.sast
    };
  }

  /** Packages worth checking against OSV: the project itself and exactly pinned dependencies. */
  function buildPackages(raw, F) {
    const out = [];
    const add = (ecosystem, name, version, source) => {
      if (!name || !version || out.length >= 300) return;
      if (out.some((p) => p.ecosystem === ecosystem && p.name === name && p.version === version)) return;
      out.push({ ecosystem, name, version, source });
    };
    const pkg = parseJson(F.get('package.json') || '');
    if (pkg) {
      if (pkg.name && pkg.version && !pkg.private) add('npm', pkg.name, String(pkg.version), 'this project');
      for (const [n, v] of Object.entries({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })) {
        if (/^\d+\.\d+\.\d+([-+][\w.]+)?$/.test(String(v))) add('npm', n, String(v), 'package.json');
      }
    }
    const py = parseTomlLite(F.get('pyproject.toml') || '');
    if (py.project && py.project.name && py.project.version) add('PyPI', py.project.name, String(py.project.version), 'this project');
    for (const file of ['requirements.txt', 'requirements-dev.txt']) {
      for (const line of String(F.get(file) || '').split('\n')) {
        const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*==\s*([0-9][\w.!+-]*)\s*(;.*)?(#.*)?$/.exec(line);
        if (m) add('PyPI', m[1], m[3], file);
      }
    }
    const cargo = parseTomlLite(F.get('Cargo.toml') || '');
    if (cargo.package && cargo.package.name && cargo.package.version) add('crates.io', cargo.package.name, String(cargo.package.version), 'this project');
    return out;
  }

  /** Very small script detector for READMEs that are not in English. */
  function detectScript(text) {
    const t = String(text || '');
    const count = (re) => (t.match(re) || []).length;
    const letters = count(/\p{L}/gu);
    if (letters < 12) return null;
    const kana = count(/[぀-ヿ]/g);
    const han = count(/\p{Script=Han}/gu);
    const hangul = count(/\p{Script=Hangul}/gu);
    const cyr = count(/\p{Script=Cyrillic}/gu);
    const arab = count(/\p{Script=Arabic}/gu);
    const deva = count(/\p{Script=Devanagari}/gu);
    const thai = count(/\p{Script=Thai}/gu);
    const share = (n) => n / letters;
    if (share(kana) > 0.08) return { code: 'ja', name: 'Japanese' };
    if (share(hangul) > 0.2) return { code: 'ko', name: 'Korean' };
    if (share(han) > 0.2) return { code: 'zh', name: 'Chinese' };
    if (share(cyr) > 0.3) return { code: 'ru', name: 'Russian (or another Cyrillic language)' };
    if (share(arab) > 0.3) return { code: 'ar', name: 'Arabic' };
    if (share(deva) > 0.3) return { code: 'hi', name: 'Hindi' };
    if (share(thai) > 0.3) return { code: 'th', name: 'Thai' };
    return null;
  }

  function buildTrust(raw, paths, map, ext) {
    const now = raw.fetchedAt;
    const r = raw.repo;
    const reasons = [];

    // Activity
    const lastCommitAt = raw.commits && raw.commits[0] ? ts(raw.commits[0].date) : ts(r.pushed_at);
    const lastDays = lastCommitAt != null ? daysBetween(lastCommitAt, now) : null;
    const commits90 = raw.commits ? raw.commits.filter((c) => ts(c.date) != null && now - ts(c.date) <= 90 * DAY).length : null;
    let activity;
    if (r.archived) activity = { id: 'archived', label: 'Archived', cls: 'bad' };
    else if (lastDays == null) activity = { id: 'unknown', label: 'Unknown', cls: 'none' };
    else if (lastDays <= 30) activity = { id: 'active', label: 'Active', cls: 'good' };
    else if (lastDays <= 180) activity = { id: 'slowing', label: 'Slowing down', cls: 'warn' };
    else if (lastDays <= 365) activity = { id: 'quiet', label: 'Quiet', cls: 'warn' };
    else activity = { id: 'inactive', label: 'Inactive', cls: 'bad' };

    // Releases
    const rel = (raw.releases || []).filter((x) => ts(x.published_at) != null).sort((a, b) => ts(b.published_at) - ts(a.published_at));
    const stable = rel.filter((x) => !x.prerelease);
    const lastYear = rel.filter((x) => now - ts(x.published_at) <= 365 * DAY).length;
    const intervals = [];
    for (let i = 0; i + 1 < Math.min(rel.length, 11); i++) intervals.push((ts(rel[i].published_at) - ts(rel[i + 1].published_at)) / DAY);
    const latest = stable[0] || rel[0] || null;
    const releases = {
      available: raw.releases != null,
      total: rel.length,
      more: raw.releases && raw.releases.length >= 30,
      lastYear,
      latest: latest ? { tag: latest.tag, name: latest.name, date: latest.published_at, days: daysBetween(ts(latest.published_at), now), prerelease: latest.prerelease } : null,
      medianIntervalDays: intervals.length ? Math.round(median(intervals)) : null
    };

    // Contributors
    const c = raw.contributors;
    const totalContrib = c.top.reduce((a, x) => a + x.contributions, 0);
    const humans = c.top.filter((x) => x.type !== 'Bot' && !/\[bot\]$/.test(x.login || ''));
    const topShare = totalContrib && humans[0] ? humans[0].contributions / totalContrib : null;
    const contributors = {
      count: c.count,
      approx: c.approx,
      label: c.count == null ? 'unknown' : c.approx ? `${human(c.count)}+` : String(c.count),
      top: humans.slice(0, 5).map((x) => ({ login: x.login, share: totalContrib ? x.contributions / totalContrib : 0 })),
      topShare
    };

    // Issues
    let issues = { available: false };
    if (r.has_issues === false) issues = { available: false, disabled: true };
    else if (raw.issues) {
      const list = raw.issues.filter((i) => !i.isPR);
      const old = list.filter((i) => now - ts(i.created_at) > 7 * DAY);
      const answered = old.filter((i) => i.comments > 0 || i.state === 'closed');
      const closeDays = list.filter((i) => i.state === 'closed' && ts(i.closed_at)).map((i) => (ts(i.closed_at) - ts(i.created_at)) / DAY);
      const unanswered = list.filter((i) => i.state === 'open' && i.comments === 0 && now - ts(i.created_at) > 14 * DAY).length;
      issues = {
        available: true,
        sample: list.length,
        considered: old.length,
        responseRate: old.length ? answered.length / old.length : null,
        medianCloseDays: closeDays.length ? Math.round(median(closeDays) * 10) / 10 : null,
        closed: closeDays.length,
        unanswered,
        prs: raw.issues.length - list.length
      };
    }

    const lic = licenseInfo(raw);
    const flags = {
      ci: map.ci.length > 0,
      tests: map.tests.count > 0,
      security: [...paths].some((p) => /^(\.github\/|docs\/)?security\.md$/i.test(p)),
      depsBot: [...paths].some((p) => /^(\.github\/dependabot\.ya?ml|renovate\.json5?|\.renovaterc(\.json)?|\.github\/renovate\.json5?)$/.test(p)),
      coc: [...paths].some((p) => /^(\.github\/|docs\/)?code[_-]of[_-]conduct(\.\w+)?$/i.test(p)),
      contributing: [...paths].some((p) => /^(\.github\/|docs\/)?contributing(\.\w+)?$/i.test(p)),
      fork: Boolean(r.fork),
      parent: r.parent ? r.parent.full_name : null,
      archived: Boolean(r.archived),
      template: Boolean(r.is_template)
    };

    // Health score (0–100), deterministic. Seven parts.
    const { activityStats, pullsStats, security } = ext;
    let score = 0;
    const part = {};
    part.activity = r.archived ? 0 : lastDays == null ? 8 : lastDays <= 30 ? 25 : lastDays <= 90 ? 20 : lastDays <= 180 ? 13 : lastDays <= 365 ? 6 : 0;
    if (!r.archived && activityStats.weeks.length >= 26 && activityStats.activeWeeks < 4 && part.activity > 6) part.activity -= 4; // a single recent commit after a long silence
    part.releases = !releases.available ? 5 : lastYear >= 3 ? 10 : lastYear >= 1 ? 8 : rel.length ? 4 : 3;
    part.contributors = c.count == null ? 7 : c.count >= 10 ? 15 : c.count >= 3 ? 10 : c.count === 2 ? 6 : 3;
    if (topShare != null && topShare > 0.85 && c.count >= 3) part.contributors = Math.max(0, part.contributors - 3);
    part.license = lic.ok ? 10 : lic.kind === 'custom' ? 5 : 0;
    const issuePts = !issues.available ? (issues.disabled ? 4 : 5) : issues.responseRate == null ? 6 : issues.responseRate >= 0.8 ? 10 : issues.responseRate >= 0.5 ? 7 : issues.responseRate >= 0.25 ? 3 : 1;
    const prPts = !pullsStats.available || !pullsStats.sample ? 3 : (pullsStats.mergeRate >= 0.5 && (pullsStats.medianMergeDays == null || pullsStats.medianMergeDays <= 14)) ? 5 : pullsStats.mergeRate >= 0.3 ? 3 : pullsStats.merged ? 1 : 0;
    part.community = issuePts + prPts;
    const wf = security.workflows;
    const wfPts = !wf.count ? 2 : wf.dangerous.length ? 0 : ((wf.withPermissions === wf.count ? 2 : wf.withPermissions ? 1 : 0) + (wf.pinnedShare != null && wf.pinnedShare >= 0.5 ? 2 : wf.pinnedShare != null && wf.pinnedShare > 0 ? 1 : 0));
    part.security = (security.policy ? 4 : 0) + (security.depsBot ? 3 : 0) + wfPts + (security.sast ? 2 : 0) + (map.hasTree && !security.binaries.count ? 2 : 0);
    part.engineering = (flags.ci ? 5 : 0) + (flags.tests ? 5 : 0);
    for (const v of Object.values(part)) score += v;
    score = Math.max(0, Math.min(100, Math.round(score)));
    const PART_MAX = { activity: 25, releases: 10, contributors: 15, license: 10, community: 15, security: 15, engineering: 10 };

    let verdict;
    if (r.archived) verdict = { label: 'Archived', cls: 'bad', text: 'The owners have stopped working on it. It still works as-is, but expect no fixes.' };
    else if (score >= 75) verdict = { label: 'Healthy', cls: 'good', text: 'Actively looked after, with the basics a reliable project should have.' };
    else if (score >= 50) verdict = { label: 'Fair', cls: 'warn', text: 'Usable, but check the risks below before relying on it.' };
    else verdict = { label: 'Risky', cls: 'bad', text: 'Few signs of active care. Expect slow or no help if something breaks.' };

    // Risks: concrete things a careful user should know, most serious first.
    const risks = [];
    const risk = (level, text, detail) => risks.push({ level, text, detail });
    if (r.archived) risk('high', 'Archived — no more fixes, including security fixes', 'Look for a maintained fork or alternative before adopting it.');
    if (wf.dangerous.length) for (const d of wf.dangerous.slice(0, 3)) risk('high', 'Risky CI workflow', d.text);
    if (!lic.ok && lic.kind === 'none') risk('high', 'No license', 'Legally you may not copy, change or redistribute the code without permission.');
    if (!r.archived && lastDays != null && lastDays > 365) risk('medium', `No changes for ${ago(lastDays).replace(' ago', '')}`, 'Bugs and security problems may not get fixed.');
    if (c.count != null && c.count <= 2 && topShare != null && topShare > 0.8) risk('medium', 'Depends on one person', `${Math.round(topShare * 100)}% of commits come from ${contributors.top[0] ? contributors.top[0].login : 'one contributor'}. If they stop, the project may stop.`);
    if (security.binaries.count) risk('medium', `${security.binaries.count} compiled binary file${security.binaries.count === 1 ? '' : 's'} in the repository`, `Binaries can't be reviewed like source code: ${security.binaries.sample.slice(0, 3).join(', ')}.`);
    if (issues.available && issues.unanswered >= 10) risk('medium', `${issues.unanswered} recent issues with no reply`, 'Questions and bug reports are piling up.');
    if (wf.curlPipe.length) risk('low', 'CI downloads and runs scripts directly (curl | sh)', `In ${wf.curlPipe.slice(0, 3).join(', ')}. A compromised download would run in the build.`);
    if (wf.count && wf.withPermissions < wf.count) risk('low', 'CI token permissions not limited', `${wf.count - wf.withPermissions} of ${wf.count} workflow${wf.count === 1 ? '' : 's'} have no "permissions:" block, so they may get broad write access.`);
    if (wf.actions && wf.pinnedShare < 0.5) risk('low', 'CI actions not pinned to exact versions', `${wf.actions - wf.pinned} of ${wf.actions} actions use a tag like @v4 instead of a commit SHA, so their code can change without notice.`);
    if (!security.policy && (r.stargazers_count || 0) >= 500) risk('low', 'No security policy', 'Popular project without SECURITY.md: no clear way to report vulnerabilities privately.');
    if (lic.kind === 'copyleft') risk('info', `Copyleft license (${lic.short})`, 'If you distribute changed versions, you must share your changes under the same license.');
    if (flags.fork) risk('info', `Fork of ${flags.parent || 'another repository'}`, 'Check whether the original project is more active.');
    const ORDER = { high: 0, medium: 1, low: 2, info: 3 };
    risks.sort((a, b) => ORDER[a.level] - ORDER[b.level]);

    // Guardrail (same idea as the website score): a serious risk keeps the
    // project out of "Healthy" no matter how good the other numbers are.
    const uncapped = score;
    const capped = !r.archived && risks.some((x) => x.level === 'high') && score > 74;
    if (capped) {
      score = 74;
      verdict = { label: 'Fair', cls: 'warn', text: 'Well maintained in many ways, but it has a serious risk listed below.' };
    }

    // Reasons (ordered good → bad, deterministic)
    const say = (ok, text) => reasons.push({ ok, text });
    if (r.archived) say(false, 'Archived: read-only, no longer maintained');
    else if (lastDays != null) say(lastDays <= 90, `Last change ${ago(lastDays)}${commits90 != null && lastDays <= 90 ? ` (${commits90 >= 30 ? '30+' : commits90} in the last 90 days)` : ''}`);
    if (releases.available) say(lastYear >= 1, rel.length ? `${lastYear} release${lastYear === 1 ? '' : 's'} in the last year${releases.latest ? `, latest ${releases.latest.tag} ${ago(releases.latest.days)}` : ''}` : `No ${platformOf(raw).name} releases (it may publish elsewhere)`);
    if (c.count != null) say(c.count >= 3, `${contributors.label} contributor${c.count === 1 ? '' : 's'}${topShare != null && topShare > 0.8 && c.count > 1 ? `; one person made ${Math.round(topShare * 100)}% of commits` : ''}`);
    say(lic.ok, lic.ok ? `${lic.short} license` : lic.kind === 'custom' ? 'Unrecognized license' : 'No license');
    if (issues.available && issues.responseRate != null) say(issues.responseRate >= 0.5, `${Math.round(issues.responseRate * 100)}% of recent issues got a reply or were closed`);
    if (issues.disabled) say(false, 'Issues are turned off');
    say(flags.ci, flags.ci ? 'Automated checks (CI) run on changes' : 'No automated checks (CI) found');
    say(flags.tests, flags.tests ? `${map.tests.count} test file${map.tests.count === 1 ? '' : 's'}` : 'No test files found');
    if (flags.security) say(true, 'Has a security policy (SECURITY.md)');
    if (flags.depsBot) say(true, 'Dependencies are updated automatically');
    if (pullsStats.available && pullsStats.sample) say(pullsStats.mergeRate >= 0.3, `${Math.round(pullsStats.mergeRate * 100)}% of recent ${platformOf(raw).prs} were merged${pullsStats.medianMergeDays != null ? `, typically in ${pullsStats.medianMergeDays < 1 ? 'under a day' : `${Math.round(pullsStats.medianMergeDays)} day${Math.round(pullsStats.medianMergeDays) === 1 ? '' : 's'}`}` : ''}`);
    if (flags.fork) say(false, `This is a fork of ${flags.parent || 'another repository'}`);

    return {
      score, uncapped, capped, parts: part, partMax: PART_MAX, verdict, reasons, risks,
      commitActivity: activityStats, pulls: pullsStats, security,
      lastCommit: { date: lastCommitAt ? new Date(lastCommitAt).toISOString() : null, days: lastDays, message: raw.commits && raw.commits[0] ? raw.commits[0].message : null, author: raw.commits && raw.commits[0] ? raw.commits[0].author : null, last90: commits90 },
      activity, releases, contributors, issues, license: lic, flags,
      popularity: { stars: r.stargazers_count, forks: r.forks_count, watchers: r.subscribers_count, openIssues: r.open_issues_count },
      age: { created: r.created_at, days: ts(r.created_at) != null ? daysBetween(ts(r.created_at), now) : null }
    };
  }

  // ---------------------------------------------------------------- contribute

  const GFI_RE = /good.?first|first.?timers?|beginner|easy|starter|newcomer|up.?for.?grabs|help.?wanted|hacktoberfest/i;

  function buildContribute(raw, F, paths, setup, map) {
    const PL = platformOf(raw);
    const now = raw.fetchedAt;
    const r = raw.repo;
    const name = r.full_name.split('/').pop();
    const owner = r.full_name.split('/').slice(0, -1).join('/');
    const contribPath = [...paths].find((p) => /^(\.github\/|docs\/)?contributing(\.\w+)?$/i.test(p)) || Object.keys(raw.files || {}).find((p) => /contributing/i.test(p)) || null;
    const contribText = contribPath ? (raw.files || {})[contribPath] || null : null;
    const cmd = contribText ? parseMarkdown(contribText) : null;

    const docs = {
      contributing: contribPath ? { path: contribPath, url: blobUrl(raw, contribPath) } : null,
      coc: (() => { const p = [...paths].find((x) => /^(\.github\/|docs\/)?code[_-]of[_-]conduct(\.\w+)?$/i.test(x)); return p ? { path: p, url: blobUrl(raw, p) } : null; })(),
      issueTemplates: [...paths].some((p) => /^\.github\/ISSUE_TEMPLATE(\/|\.md$)/i.test(p) || /^\.github\/issue_template\.md$/i.test(p)),
      prTemplate: [...paths].some((p) => /^(\.github\/|docs\/)?pull_request_template\.md$/i.test(p) || /^\.github\/PULL_REQUEST_TEMPLATE\//i.test(p)),
      discussions: Boolean(r.has_discussions)
    };

    const outline = cmd ? cmd.sections.filter((s) => s.level <= 3).map((s) => ({ heading: s.heading.slice(0, 80), text: s.paras.find(isProse) ? firstSentence(s.paras.find(isProse), 180) : null })).slice(0, 12) : [];

    const requirements = [];
    const ct = (contribText || '').toLowerCase();
    if (/\bcla\b|contributor license agreement/.test(ct)) requirements.push('Sign the Contributor License Agreement (CLA) before your first pull request is accepted.');
    if (/\bdco\b|signed-off-by|sign-off|git commit -s\b/.test(ct)) requirements.push('Sign off every commit (git commit -s) to certify the Developer Certificate of Origin.');
    if (/conventional commits?/.test(ct) || [...paths].some((p) => /^(commitlint\.config\.\w+|\.commitlintrc(\.\w+)?)$/.test(p))) requirements.push('Write commit messages in the Conventional Commits style, e.g. "fix: handle empty input".');
    if (/changeset/.test(ct) || [...paths].some((p) => p.startsWith('.changeset/'))) requirements.push('Add a changeset (npx changeset) describing your change.');
    if (/discuss|open an issue first|before (starting|working)/.test(ct)) requirements.push('Open or comment on an issue first so maintainers can agree on the approach.');

    // Steps
    const fromSetup = setup.detected.find((d) => /run it locally|build and run|install dependencies/i.test(d.title));
    const installLines = fromSetup ? fromSetup.commands[0].split('\n').filter((l) => !/^git clone|^cd /.test(l)).map((l) => (/^cp /.test(l) ? l : l.replace(/\s+#.*$/, ''))) : [];
    const testLine = installLines.find((l) => /\b(test|pytest|go test|cargo test)\b/.test(l));
    const lintLine = installLines.find((l) => /\blint\b/.test(l));
    const setupLines = installLines.filter((l) => l !== testLine && l !== lintLine && !/\b(run dev|npm start|runserver|go run|cargo run|python main|python app|streamlit run|--help)\b/.test(l));
    const steps = [
      { title: 'Fork the repository', text: PL.fork },
      { title: 'Clone your fork', command: `git clone https://${PL.host}/YOUR-USERNAME/${name}.git\ncd ${name}\ngit remote add upstream ${PL.web}.git` },
      setupLines.length ? { title: 'Install dependencies', command: setupLines.join('\n') } : null,
      { title: 'Create a branch', command: 'git checkout -b fix/short-description' },
      { title: 'Make your change and check it', command: [testLine, lintLine].filter(Boolean).join('\n') || null, text: testLine ? null : 'Run the project and check your change works; no test command was detected.' },
      { title: 'Commit and push', command: `git add -A\ngit commit${requirements.some((x) => /sign off/i.test(x)) ? ' -s' : ''} -m "${requirements.some((x) => /conventional/i.test(x)) ? 'fix: ' : ''}describe your change"\ngit push origin fix/short-description` },
      { title: `Open a ${PL.pr}`, text: `${PL.open}${docs.prTemplate ? ' Fill in the template.' : ''}` }
    ].filter(Boolean);

    // Good first issues: dedicated query + labelled ones from the recent sample.
    const merged = new Map();
    for (const i of [...(raw.goodFirst || []), ...((raw.issues || []).filter((x) => x.state === 'open' && x.labels.some((l) => GFI_RE.test(l))))]) {
      if (i.isPR || merged.has(i.number)) continue;
      merged.set(i.number, i);
    }
    const goodFirst = [...merged.values()]
      .sort((a, b) => Number(a.assigned) - Number(b.assigned) || ts(b.created_at) - ts(a.created_at) || b.number - a.number)
      .slice(0, 10)
      .map((i) => ({
        number: i.number, title: i.title, labels: i.labels.filter((l) => GFI_RE.test(l)).slice(0, 2), otherLabels: i.labels.filter((l) => !GFI_RE.test(l)).slice(0, 2),
        days: daysBetween(ts(i.created_at), now), comments: i.comments, assigned: i.assigned,
        url: PL.issue(i.number)
      }));

    return {
      docs, outline, requirements, steps, goodFirst,
      issuesUrl: PL.issues,
      gfiUrl: PL.gfi,
      prWord: PL.pr,
      openToContrib: !r.archived && r.has_issues !== false
    };
  }

  // ---------------------------------------------------------------- main

  function analyze(raw) {
    const F = fileLookup(raw);
    const paths = new Set(raw.tree.entries.map((e) => e.path));
    for (const p of Object.keys(raw.files || {})) paths.add(p);
    const readme = F.find(/^readme/i);
    // Markdown parser also copes with reStructuredText headings (=== / --- underlines) well enough for summaries.
    const md = readme && /\.(md|markdown|rst|txt)$|^readme$/i.test(readme.path) ? parseMarkdown(readme.text) : readme ? { title: null, intro: readme.text.split(/\n\s*\n/).map(plain).filter(Boolean).slice(0, 10), sections: [] } : null;

    const totalLang = raw.languages ? Object.values(raw.languages).reduce((a, b) => a + b, 0) : 0;
    const languages = raw.languages
      ? Object.entries(raw.languages).sort((a, b) => b[1] - a[1]).map(([name, bytes]) => ({ name, bytes, share: totalLang ? bytes / totalLang : 0 }))
      : [];

    const { stack, pkg } = detectStack(raw, F, paths);
    const kind = detectKind(raw, F, paths, pkg, stack);
    const map = buildMap(raw, F, paths, pkg);
    const security = buildSecurity(raw, paths, map);
    const trust = buildTrust(raw, paths, map, { activityStats: buildActivity(raw), pullsStats: buildPulls(raw), security });
    const summary = buildSummary(raw, md, kind, languages, stack, trust);
    const setup = buildSetup(raw, md, F, paths, pkg, kind);
    const contribute = buildContribute(raw, F, paths, setup, map);

    const r = raw.repo;
    return {
      repo: {
        fullName: r.full_name, name: r.name, owner: r.full_name.split('/').slice(0, -1).join('/'), url: platformOf(raw).web,
        platform: platformOf(raw).id, platformName: platformOf(raw).name, prWord: platformOf(raw).pr, host: platformOf(raw).host,
        description: r.description ? plain(r.description) : null, homepage: r.homepage || null, topics: r.topics || [],
        stars: r.stargazers_count, forks: r.forks_count, defaultBranch: r.default_branch, archived: Boolean(r.archived),
        fork: Boolean(r.fork), empty: raw.emptyRepo, renamed: raw.requested && `${raw.requested.owner}/${raw.requested.repo}`.toLowerCase() !== r.full_name.toLowerCase()
      },
      languages: languages.slice(0, 10).map((l) => ({ ...l, share: Math.round(l.share * 1000) / 1000 })),
      stack, kind, summary, setup, map, trust, contribute,
      packages: buildPackages(raw, F),
      language: detectScript([summary.oneLine, summary.paragraph, ...summary.features, ...summary.sections.map((x) => x.heading + ' ' + x.text)].join(' ')),
      meta: { fetchedAt: raw.fetchedAt, partial: raw.partial || [], apiCalls: raw.apiCalls, rate: raw.rate }
    };
  }

  /** Used by Settings to show the current GitHub limit (does not count against it). */
  async function rateLimit(token, fetchImpl = root.fetch.bind(root)) {
    const rate = { remaining: null, limit: null, reset: null };
    const c = makeClient(fetchImpl, rate, token);
    const res = await c.api('/rate_limit');
    const core = res.data && res.data.resources && res.data.resources.core;
    return core ? { remaining: core.remaining, limit: core.limit, reset: core.reset * 1000 } : rate;
  }

  root.PageLensGitHub = Object.freeze({
    rateLimit,
    parseRepoInput, collect, analyze, load, readCache,
    CACHE_TTL_MS,
    GitHubError,
    _internals: { parseMarkdown, plain, firstSentence, parseTomlLite, makeTargets, cleanShell, looksLikeCommands, licenseInfo, ago, human, pct }
  });
})(globalThis);

/* ---------------------------------------------------------------------------
 * Optional outside checks (only when the user clicks, after Chrome grants
 * access to these two hosts). They send the repository name or package
 * names to Google-run open-source security services:
 *   - OpenSSF Scorecard  https://api.scorecard.dev  (supply-chain checks, 0–10)
 *   - OSV.dev            https://api.osv.dev        (known vulnerabilities)
 * Neither needs an account or key.
 * ------------------------------------------------------------------------- */
(function (root) {
  'use strict';
  const G = root.PageLensGitHub;
  if (!G) return;

  const ORIGINS = ['https://api.scorecard.dev/*', 'https://api.osv.dev/*'];

  async function fetchScorecard(fullName, fetchImpl = root.fetch.bind(root), host = 'github.com') {
    if (host !== 'github.com' && host !== 'gitlab.com') return { found: false, unsupported: true };
    const path = String(fullName).split('/').map(encodeURIComponent).join('/');
    const res = await fetchImpl(`https://api.scorecard.dev/projects/${host}/${path}`, { credentials: 'omit', cache: 'no-store' });
    if (res.status === 404) return { found: false };
    if (!res.ok) throw new Error(`Scorecard answered ${res.status}`);
    const d = await res.json();
    return {
      found: true,
      score: typeof d.score === 'number' ? Math.round(d.score * 10) / 10 : null,
      date: d.date || null,
      checks: (d.checks || []).map((c) => ({ name: c.name, score: c.score, reason: String(c.reason || '').slice(0, 200), url: c.documentation && c.documentation.url })).sort((a, b) => (a.score < 0) - (b.score < 0) || a.score - b.score)
    };
  }

  async function fetchOsv(packages, fetchImpl = root.fetch.bind(root)) {
    if (!packages.length) return { checked: 0, results: [] };
    const res = await fetchImpl('https://api.osv.dev/v1/querybatch', {
      method: 'POST', credentials: 'omit', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: packages.slice(0, 300).map((p) => ({ package: { ecosystem: p.ecosystem, name: p.name }, version: p.version })) })
    });
    if (!res.ok) throw new Error(`OSV answered ${res.status}`);
    const d = await res.json();
    const results = [];
    (d.results || []).forEach((r, i) => {
      const ids = (r.vulns || []).map((v) => v.id);
      if (ids.length) results.push({ ...packages[i], vulns: ids.slice(0, 20) });
    });
    return { checked: Math.min(300, packages.length), results };
  }

  root.PageLensGitHubExtra = Object.freeze({ ORIGINS, fetchScorecard, fetchOsv });
})(globalThis);
