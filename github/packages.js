/* PageLens — github/packages.js
 *
 * Package mode: health and safety of an npm or PyPI package.
 *   collect()  → raw data from the public registries (no account, no key)
 *   analyze()  → pure, deterministic report ("now" = fetch time)
 *
 * Sources:
 *   npm:  registry.npmjs.org (manifest + version list), api.npmjs.org (downloads)
 *   PyPI: pypi.org/pypi/<name>/json (metadata, release files, known vulnerabilities),
 *         pypistats.org (downloads)
 *   Both: api.osv.dev (known vulnerabilities for the latest version)
 */
(function (root) {
  'use strict';

  const DAY = 86400000;
  const V = 1;

  // Popular package names, used only to spot look-alike names (typosquatting).
  const POPULAR = {
    npm: ('react react-dom vue angular svelte next nuxt express koa fastify lodash underscore axios request moment dayjs date-fns chalk commander yargs ' +
      'debug dotenv uuid jquery bootstrap typescript webpack vite rollup esbuild babel-core @babel/core eslint prettier jest mocha chai sinon ' +
      'socket.io ws mongoose mongodb mysql mysql2 pg redis ioredis sequelize prisma knex passport jsonwebtoken bcrypt bcryptjs cors body-parser ' +
      'cookie-parser multer nodemon pm2 rxjs redux react-redux zustand mobx graphql apollo-server tailwindcss postcss autoprefixer sass less ' +
      'three d3 chart.js puppeteer playwright cheerio node-fetch got superagent form-data qs semver glob rimraf mkdirp fs-extra minimist ' +
      'classnames prop-types styled-components emotion react-router react-router-dom electron colors async bluebird inquirer ora ' +
      'cross-env concurrently husky lint-staged zod joi yup validator nanoid shortid marked highlight.js sharp jimp crypto-js').split(' '),
    PyPI: ('requests urllib3 numpy pandas scipy matplotlib seaborn scikit-learn tensorflow torch keras flask django fastapi uvicorn gunicorn ' +
      'sqlalchemy psycopg2 psycopg2-binary pymysql redis celery boto3 botocore awscli pyyaml jinja2 click typer rich pydantic attrs ' +
      'pytest tox black flake8 pylint mypy isort ruff setuptools wheel pip virtualenv poetry cryptography pyopenssl paramiko pillow opencv-python ' +
      'beautifulsoup4 lxml selenium scrapy httpx aiohttp websockets openai transformers datasets tqdm python-dateutil pytz six certifi idna ' +
      'charset-normalizer chardet colorama tabulate pyjwt bcrypt passlib python-dotenv docker kubernetes grpcio protobuf google-cloud-storage ' +
      'streamlit gradio jupyter notebook ipython plotly dash networkx sympy nltk spacy gensim xgboost lightgbm').split(' ')
  };

  // ------------------------------------------------------------ input

  /** npmjs.com/package/<name>, pypi.org/project/<name>, "npm:<name>", "pypi:<name>" → {ecosystem, name} */
  function parse(input) {
    const s = String(input || '').trim();
    if (!s) return null;
    const pref = /^(npm|pypi|pip):\s*(.+)$/i.exec(s);
    if (pref) return clean(pref[1].toLowerCase() === 'npm' ? 'npm' : 'PyPI', pref[2].trim());
    let u;
    try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const segs = u.pathname.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
    if (host === 'npmjs.com' && segs[0] === 'package' && segs[1]) {
      return clean('npm', segs[1].startsWith('@') && segs[2] ? `${segs[1]}/${segs[2]}` : segs[1]);
    }
    if (host === 'pypi.org' && segs[0] === 'project' && segs[1]) return clean('PyPI', segs[1]);
    return null;
  }

  function clean(ecosystem, name) {
    name = name.replace(/@[\d][\w.+-]*$/, '').trim();
    if (ecosystem === 'npm' && !/^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(name)) return null;
    if (ecosystem === 'PyPI' && !/^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name)) return null;
    return { ecosystem, name };
  }

  const pypiNorm = (n) => n.toLowerCase().replace(/[-_.]+/g, '-');

  // ------------------------------------------------------------ fetch

  class PackageError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  async function getJson(fetchImpl, url, { required = false, headers = {}, method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetchImpl(url, { method, credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json', ...headers }, body });
    } catch {
      if (required) throw new PackageError('network', 'Could not reach the package registry.');
      return null;
    }
    if (res.status === 404 && required) throw new PackageError('not-found', 'Package not found.');
    if (res.status === 429 && required) throw new PackageError('rate-limit', 'The registry is limiting requests right now.');
    if (!res.ok) {
      if (required) throw new PackageError('http', `The registry answered ${res.status}.`);
      return null;
    }
    try { return await res.json(); } catch { return null; }
  }

  async function collect(target, { fetchImpl = root.fetch.bind(root), now = Date.now(), onProgress = () => {} } = {}) {
    const partial = [];
    const raw = { v: V, kind: 'pkg', ecosystem: target.ecosystem, name: target.name, fetchedAt: now, partial };
    if (target.ecosystem === 'npm') {
      const enc = target.name.startsWith('@') ? `@${encodeURIComponent(target.name.slice(1))}` : encodeURIComponent(target.name);
      onProgress('Reading the npm registry…');
      const corgi = await getJson(fetchImpl, `https://registry.npmjs.org/${enc}`, { required: true, headers: { Accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' } });
      const latestVer = corgi['dist-tags'] && corgi['dist-tags'].latest;
      const [manifest, week, month, versionsInfo] = await Promise.all([
        latestVer ? getJson(fetchImpl, `https://registry.npmjs.org/${enc}/${encodeURIComponent(latestVer)}`) : null,
        getJson(fetchImpl, `https://api.npmjs.org/downloads/point/last-week/${enc}`),
        getJson(fetchImpl, `https://api.npmjs.org/downloads/point/last-month/${enc}`),
        getJson(fetchImpl, `https://api.deps.dev/v3/systems/npm/packages/${encodeURIComponent(target.name)}`)
      ]);
      if (!manifest) partial.push('manifest');
      if (!week) partial.push('downloads');
      if (!versionsInfo) partial.push('release-dates');
      const versions = Object.keys(corgi.versions || {});
      const latestCorgi = (corgi.versions || {})[latestVer] || {};
      raw.latest = latestVer || null;
      raw.versions = versions.slice(-400);
      raw.versionCount = versions.length;
      raw.times = versionsInfo && Array.isArray(versionsInfo.versions)
        ? versionsInfo.versions.filter((x) => x.publishedAt).map((x) => ({ version: x.versionKey && x.versionKey.version, at: x.publishedAt })).slice(-400)
        : (corgi.modified ? [{ version: latestVer, at: corgi.modified, approx: true }] : []);
      raw.manifest = manifest ? {
        description: String(manifest.description || '').slice(0, 400),
        license: typeof manifest.license === 'string' ? manifest.license : manifest.license && manifest.license.type ? manifest.license.type : null,
        homepage: manifest.homepage || null,
        repository: typeof manifest.repository === 'string' ? manifest.repository : manifest.repository && manifest.repository.url ? manifest.repository.url : null,
        bugs: manifest.bugs && manifest.bugs.url ? manifest.bugs.url : null,
        maintainers: (manifest.maintainers || []).length,
        dependencies: Object.keys(manifest.dependencies || {}).slice(0, 200),
        peerDependencies: Object.keys(manifest.peerDependencies || {}).slice(0, 50),
        engines: manifest.engines && manifest.engines.node ? manifest.engines.node : null,
        installScripts: ['preinstall', 'install', 'postinstall'].filter((k) => manifest.scripts && manifest.scripts[k]).map((k) => ({ name: k, script: String(manifest.scripts[k]).slice(0, 160) })),
        deprecated: manifest.deprecated ? String(manifest.deprecated).slice(0, 300) : null,
        provenance: Boolean(manifest.dist && manifest.dist.attestations),
        types: Boolean(manifest.types || manifest.typings),
        unpackedSize: manifest.dist && manifest.dist.unpackedSize ? manifest.dist.unpackedSize : null
      } : {
        description: '', license: null, homepage: null, repository: null, maintainers: 0, dependencies: Object.keys(latestCorgi.dependencies || {}),
        peerDependencies: [], engines: null, installScripts: latestCorgi.hasInstallScript ? [{ name: 'install', script: '(install script present)' }] : [],
        deprecated: latestCorgi.deprecated || null, provenance: false, types: false, unpackedSize: null
      };
      raw.downloads = { week: week ? week.downloads : null, month: month ? month.downloads : null };
    } else {
      onProgress('Reading PyPI…');
      const d = await getJson(fetchImpl, `https://pypi.org/pypi/${encodeURIComponent(target.name)}/json`, { required: true });
      const stats = await getJson(fetchImpl, `https://pypistats.org/api/packages/${encodeURIComponent(pypiNorm(target.name))}/recent`);
      if (!stats) partial.push('downloads');
      const info = d.info || {};
      const releases = d.releases || {};
      raw.name = info.name || target.name;
      raw.latest = info.version || null;
      raw.versionCount = Object.keys(releases).length;
      raw.versions = Object.keys(releases).slice(-400);
      raw.times = Object.entries(releases).map(([ver, files]) => {
        const times = (files || []).map((f) => f.upload_time_iso_8601 || f.upload_time).filter(Boolean).sort();
        return times.length ? { version: ver, at: times[0], yanked: (files || []).every((f) => f.yanked) } : null;
      }).filter(Boolean).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-400);
      const files = d.urls || [];
      const urls = info.project_urls || {};
      const repoUrl = Object.entries(urls).find(([k, v]) => /source|code|repo|github|gitlab/i.test(k) || /github\.com|gitlab\.com|codeberg\.org/i.test(String(v)));
      raw.manifest = {
        description: String(info.summary || '').slice(0, 400),
        license: info.license_expression || (info.license && info.license.length < 80 ? info.license : null) ||
          ((info.classifiers || []).find((c) => c.startsWith('License :: OSI Approved ::')) || '').replace('License :: OSI Approved :: ', '') || null,
        homepage: info.home_page || urls.Homepage || urls.homepage || null,
        repository: repoUrl ? repoUrl[1] : null,
        bugs: urls['Bug Tracker'] || urls.Issues || null,
        maintainers: [info.author, info.maintainer].filter(Boolean).length,
        dependencies: (info.requires_dist || []).filter((x) => !/extra\s*==/.test(x)).map((x) => x.split(/[\s;<>=!~[(]/)[0]).filter(Boolean).slice(0, 200),
        peerDependencies: [],
        engines: info.requires_python || null,
        installScripts: [],
        sdistOnly: files.length > 0 && files.every((f) => f.packagetype === 'sdist'),
        wheels: files.filter((f) => f.packagetype === 'bdist_wheel').length,
        deprecated: (info.classifiers || []).includes('Development Status :: 7 - Inactive') ? 'Marked "Development Status :: 7 - Inactive"' : null,
        devStatus: ((info.classifiers || []).find((c) => c.startsWith('Development Status ::')) || '').replace('Development Status :: ', '') || null,
        provenance: false,
        yanked: Boolean(info.yanked),
        types: (info.classifiers || []).includes('Typing :: Typed')
      };
      raw.pypiVulns = (d.vulnerabilities || []).map((v) => ({ id: v.id, aliases: (v.aliases || []).slice(0, 4), summary: String(v.summary || v.details || '').slice(0, 200), fixed: (v.fixed_in || []).slice(0, 4) }));
      raw.downloads = { week: stats && stats.data ? stats.data.last_week : null, month: stats && stats.data ? stats.data.last_month : null };
    }
    // Known vulnerabilities for the latest version (OSV covers npm and PyPI).
    if (raw.latest) {
      onProgress('Checking known vulnerabilities…');
      const osv = await getJson(fetchImpl, 'https://api.osv.dev/v1/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package: { ecosystem: target.ecosystem, name: raw.name }, version: raw.latest })
      });
      if (!osv) partial.push('osv');
      raw.osv = osv ? (osv.vulns || []).map((v) => ({
        id: v.id, aliases: (v.aliases || []).slice(0, 4), summary: String(v.summary || '').slice(0, 200),
        severity: (v.database_specific && v.database_specific.severity) || null
      })).slice(0, 30) : null;
    }
    return raw;
  }

  // ------------------------------------------------------------ analysis (pure)

  function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1); // swapped letters
      }
    }
    return dp[a.length][b.length];
  }

  function lookalike(ecosystem, name) {
    const list = POPULAR[ecosystem] || [];
    const norm = ecosystem === 'PyPI' ? pypiNorm : (x) => x.toLowerCase();
    const n = norm(name);
    if (list.map(norm).includes(n)) return null;
    const bare = n.replace(/^@[^/]+\//, '');
    for (const p of list) {
      const q = norm(p);
      if (q.length < 4) continue;
      if (editDistance(bare, q) === 1 || bare.replace(/[-_.]/g, '') === q.replace(/[-_.]/g, '') && bare !== q) return p;
    }
    return null;
  }

  const OSI = /^(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|MPL-2\.0|LGPL-2\.1|LGPL-3\.0|GPL-2\.0|GPL-3\.0|AGPL-3\.0|Unlicense|CC0-1\.0|BlueOak-1\.0\.0|Zlib|EPL-2\.0|PSF-2\.0|Python-2\.0)([-+](only|or-later))?$|^(MIT|BSD|Apache|ISC|GPL|LGPL|MPL|Python Software Foundation) License$|^(MIT|BSD|Apache Software|GNU General Public|GNU Lesser General Public|Mozilla Public|ISC) License( \(.*\))?/i;

  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  function repoTarget(url) {
    if (!url || !root.PageLensForges) return null;
    const cleaned = String(url).replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/\.git(#.*)?$/, '').replace(/#.*$/, '');
    const short = /^(github|gitlab):([\w.-]+\/[\w./-]+)$/.exec(cleaned);
    return root.PageLensForges.parse(short ? `https://${short[1]}.com/${short[2]}` : cleaned);
  }

  function analyze(raw) {
    const now = raw.fetchedAt;
    const m = raw.manifest || {};
    const times = (raw.times || []).filter((t) => Number.isFinite(Date.parse(t.at)));
    const latestT = times.length ? Date.parse(times[times.length - 1].at) : null;
    const firstT = times.length ? Date.parse(times[0].at) : null;
    const latestDays = latestT != null ? Math.max(0, Math.round((now - latestT) / DAY)) : null;
    const lastYear = times.filter((t) => now - Date.parse(t.at) <= 365 * DAY).length;
    const gaps = [];
    for (let i = Math.max(1, times.length - 12); i < times.length; i++) gaps.push((Date.parse(times[i].at) - Date.parse(times[i - 1].at)) / DAY);
    const monthly = new Array(24).fill(0);
    for (const t of times) {
      const idx = Math.floor((now - Date.parse(t.at)) / (30.44 * DAY));
      if (idx >= 0 && idx < 24) monthly[23 - idx] += 1;
    }
    const vulns = raw.ecosystem === 'PyPI' && raw.pypiVulns && raw.pypiVulns.length ? raw.pypiVulns : (raw.osv || []);
    const vulnKnown = raw.ecosystem === 'PyPI' ? true : raw.osv != null;
    const look = lookalike(raw.ecosystem, raw.name);
    const license = m.license || null;
    const licenseOk = license ? OSI.test(license.trim()) : false;
    const repo = repoTarget(m.repository);
    const dl = raw.downloads || {};

    // Score (0–100)
    const parts = {};
    parts.maintenance = m.deprecated ? 0 : latestDays == null ? 10 : latestDays <= 90 ? 30 : latestDays <= 365 ? 22 : latestDays <= 730 ? 12 : 4;
    parts.popularity = dl.week == null ? 7 : dl.week >= 100000 ? 15 : dl.week >= 10000 ? 12 : dl.week >= 1000 ? 9 : dl.week >= 100 ? 5 : 1;
    parts.security = (vulnKnown ? (vulns.length ? 0 : 20) : 10) + (m.installScripts && m.installScripts.length ? 0 : raw.ecosystem === 'PyPI' && m.sdistOnly ? 0 : 5) + (m.provenance || (raw.ecosystem === 'PyPI' && m.wheels) ? 5 : 0);
    parts.license = licenseOk ? 10 : license ? 5 : 0;
    parts.information = (repo ? 5 : 0) + (m.description ? 3 : 0) + (m.maintainers > 1 ? 4 : m.maintainers === 1 ? 2 : 0) + (raw.versionCount >= 5 ? 3 : raw.versionCount >= 2 ? 1 : 0);
    const MAX = { maintenance: 30, popularity: 15, security: 30, license: 10, information: 15 };
    let score = Object.values(parts).reduce((a, b) => a + b, 0);

    const risks = [];
    const risk = (level, text, detail) => risks.push({ level, text, detail });
    if (look) risk('high', `Name looks like the popular package "${look}"`, 'Look-alike names are a common way to trick people into installing malware. Double-check you meant this package.');
    if (vulns.length) risk('high', `${vulns.length} known vulnerabilit${vulns.length === 1 ? 'y' : 'ies'} in the latest version (${raw.latest})`, vulns.slice(0, 3).map((v) => v.id).join(', '));
    if (m.deprecated) risk('high', 'Deprecated by its author', m.deprecated);
    if (raw.ecosystem === 'PyPI' && m.yanked) risk('high', 'The latest version was yanked (withdrawn)', 'Pin an earlier version or choose another package.');
    if (!license) risk('high', 'No license', 'Without a license you may not legally use or redistribute the code.');
    if (m.installScripts && m.installScripts.length) risk('medium', `Runs code when installed (${m.installScripts.map((x) => x.name).join(', ')})`, `Install scripts can do anything on your machine: ${m.installScripts[0].script}`);
    if (raw.ecosystem === 'PyPI' && m.sdistOnly) risk('medium', 'Source-only release: installing runs build code', 'There are no wheels for the latest version, so pip runs the package\'s build scripts during install.');
    if (latestDays != null && latestDays > 730 && !m.deprecated) risk('medium', `No release for ${Math.round(latestDays / 365)} years`, 'Bugs and security problems may not get fixed.');
    if (!repo) risk('low', 'No source repository linked', 'You cannot easily check the code behind this package.');
    if (m.maintainers === 1 && raw.ecosystem === 'npm') risk('low', 'Only one maintainer', 'If their account is compromised or they stop, nobody else can publish fixes.');
    if (license && !licenseOk) risk('info', `License "${license}" is not a common open-source license`, 'Read it before using the package commercially.');
    const ORDER = { high: 0, medium: 1, low: 2, info: 3 };
    risks.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
    const uncapped = score;
    const capped = risks.some((x) => x.level === 'high') && score > 74;
    if (capped) score = 74;
    const verdict = m.deprecated ? { label: 'Deprecated', cls: 'bad', text: 'The author recommends not using it any more.' }
      : score >= 75 ? { label: 'Healthy', cls: 'good', text: 'Maintained, popular enough to be well tested, and no known vulnerabilities in the latest version.' }
        : score >= 50 ? { label: 'Fair', cls: 'warn', text: 'Usable, but check the risks below first.' }
          : { label: 'Risky', cls: 'bad', text: 'Think twice before depending on it.' };

    const install = raw.ecosystem === 'npm' ? `npm install ${raw.name}` : `pip install ${raw.name}`;
    return {
      kind: 'pkg',
      pkg: {
        ecosystem: raw.ecosystem, name: raw.name, latest: raw.latest, description: m.description || null, license, licenseOk,
        homepage: m.homepage || null, repository: m.repository || null, repoTarget: repo, bugs: m.bugs || null,
        registryUrl: raw.ecosystem === 'npm' ? `https://www.npmjs.com/package/${raw.name}` : `https://pypi.org/project/${raw.name}/`,
        install, engines: m.engines || null, types: Boolean(m.types), devStatus: m.devStatus || null, unpackedSize: m.unpackedSize || null
      },
      score, uncapped, capped, parts, partMax: MAX, verdict, risks,
      releases: {
        count: raw.versionCount || 0, latestDays, lastYear, first: firstT ? new Date(firstT).toISOString() : null,
        latestAt: latestT ? new Date(latestT).toISOString() : null, medianGapDays: gaps.length ? Math.round(median(gaps)) : null, monthly,
        datesApprox: times.some((t) => t.approx)
      },
      downloads: dl,
      security: { vulns, vulnChecked: vulnKnown, installScripts: m.installScripts || [], provenance: Boolean(m.provenance), sdistOnly: Boolean(m.sdistOnly), wheels: m.wheels || 0, lookalike: look },
      dependencies: { list: m.dependencies || [], peer: m.peerDependencies || [] },
      maintainers: m.maintainers || 0,
      meta: { fetchedAt: raw.fetchedAt, partial: raw.partial || [] }
    };
  }

  const ORIGINS = ['https://registry.npmjs.org/*', 'https://api.npmjs.org/*', 'https://pypi.org/*', 'https://pypistats.org/*', 'https://api.deps.dev/*', 'https://api.osv.dev/*'];

  root.PageLensPackages = Object.freeze({ parse, collect, analyze, lookalike, ORIGINS, PackageError, POPULAR });
})(globalThis);
