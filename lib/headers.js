/* PageLens — lib/headers.js
 *
 * Grades a page's HTTP response headers the way Mozilla's HTTP Observatory
 * does: start at 100, apply a fixed modifier per test, add bonus points only
 * if the result is already 90+, then map to a letter grade (A+ … F).
 * Modifiers follow the published Observatory methodology
 * (developer.mozilla.org/en-US/observatory/docs/tests_and_scoring).
 *
 * Differences, stated in the UI:
 *   - PageLens only sees ONE passive response (the page itself), so it cannot
 *     test http→https redirects for https pages or the HSTS preload list.
 *   - Cookie flags are graded only when the user allowed the cookie check.
 *
 * Pure: no DOM, no network.
 */
(function (root) {
  'use strict';

  const GRADES = [
    [100, 'A+'], [90, 'A'], [85, 'A-'], [80, 'B+'], [70, 'B'], [65, 'B-'], [60, 'C+'],
    [50, 'C'], [45, 'C-'], [40, 'D+'], [30, 'D'], [25, 'D-'], [0, 'F']
  ];
  const letter = (score) => GRADES.find(([min]) => score >= min)[1];

  const SESSION_COOKIE = /(sess|^sid$|_sid$|auth|token|jwt|login|remember|csrf|xsrf)/i;
  const CSRF_COOKIE = /(csrf|xsrf)/i;

  function parseCsp(value) {
    const out = {};
    if (!value) return out;
    for (const part of String(value).split(',')[0].split(';')) {
      const [name, ...vals] = part.trim().split(/\s+/);
      if (name && !out[name.toLowerCase()]) out[name.toLowerCase()] = vals.map((v) => v.toLowerCase());
    }
    return out;
  }

  function cspAnalysis(value) {
    const d = parseCsp(value);
    const names = Object.keys(d);
    if (!names.length) return { valid: false, directives: d };
    const script = d['script-src'] || d['default-src'] || null;
    const style = d['style-src'] || d['default-src'] || null;
    const object = d['object-src'] || d['default-src'] || null;
    const hasNonceOrHash = (list) => Boolean(list && list.some((s) => /^'(nonce-|sha(256|384|512)-)/.test(s)));
    const strictDynamic = Boolean(script && script.includes("'strict-dynamic'"));
    const broad = (list) => Boolean(list && list.some((s) => s === '*' || s === 'https:' || s === 'http:' || s === 'data:' || s === 'blob:' || s === 'filesystem:'));
    const insecure = (list) => Boolean(list && list.some((s) => s === 'http:' || s.startsWith('http://')));
    const unsafeInlineScript = Boolean(script && script.includes("'unsafe-inline'") && !hasNonceOrHash(script) && !strictDynamic);
    const broadScript = Boolean(script && broad(script) && !strictDynamic);
    const unrestrictedScript = !script;
    const unrestrictedObject = !object || (broad(object) && !object.includes("'none'"));
    const passive = ['img-src', 'media-src'].map((k) => d[k] || null);
    const issues = [];
    if (unsafeInlineScript) issues.push("'unsafe-inline' scripts are allowed");
    if (broadScript) issues.push('scripts may load from any site (wildcard source)');
    if (unrestrictedScript) issues.push('no script-src or default-src');
    if (unrestrictedObject) issues.push("object-src is not 'none'");
    if (script && script.includes("'unsafe-eval'")) issues.push("'unsafe-eval' is allowed");
    if (insecure(script) || insecure(style) || insecure(d['default-src'])) issues.push('allows loading over insecure http');
    if (!d['base-uri']) issues.push('no base-uri (an injected <base> tag could redirect relative URLs)');
    if (!d['frame-ancestors']) issues.push('no frame-ancestors');
    return {
      valid: true,
      directives: d,
      defaultNone: Boolean(d['default-src'] && d['default-src'].includes("'none'")),
      unsafeInline: unsafeInlineScript || broadScript || unrestrictedScript || unrestrictedObject,
      unsafeEval: Boolean(script && script.includes("'unsafe-eval'")),
      unsafeInlineStyleOnly: !unsafeInlineScript && Boolean(style && style.includes("'unsafe-inline'")),
      insecureScheme: insecure(script) || insecure(style) || insecure(d['default-src']) || insecure(d['object-src']) || insecure(d['connect-src']),
      insecurePassive: passive.some(insecure),
      strict: strictDynamic && hasNonceOrHash(script),
      issues
    };
  }

  /**
   * @param {{headers: object|null, headerInfo: object|null, scan: object, cookies: Array|null}} input
   */
  function assess({ headers, headerInfo, scan, cookies }) {
    const H = headers || {};
    const https = scan.page.protocol === 'https';
    const tests = [];
    const add = (t) => tests.push(t);

    if (!headers) {
      return { available: false, tests: [], score: null, grade: null, table: [] };
    }

    // ---- Content Security Policy
    const cspValue = H['content-security-policy'];
    const csp = cspAnalysis(cspValue);
    if (!cspValue) {
      add({ id: 'csp', label: 'Content Security Policy', result: H['content-security-policy-report-only'] ? 'Only report-only (not enforced)' : 'Not set', modifier: -25, status: 'missing',
        explain: 'Without a CSP, any script that gets injected into the page can run.', fix: 'Add a policy. Start with Content-Security-Policy-Report-Only, then enforce it.' });
    } else if (!csp.valid) {
      add({ id: 'csp', label: 'Content Security Policy', result: 'Could not be parsed', modifier: -25, status: 'bad', explain: 'Browsers may ignore a malformed policy.', fix: 'Fix the syntax: directives separated by semicolons.' });
    } else if (csp.unsafeInline) {
      add({ id: 'csp', label: 'Content Security Policy', result: 'Allows unsafe inline or broad scripts', modifier: -20, status: 'weak', explain: `The policy exists but ${csp.issues.slice(0, 2).join(' and ')}.`, fix: "Use nonces or hashes with 'strict-dynamic', and set object-src 'none'." });
    } else if (csp.insecureScheme) {
      add({ id: 'csp', label: 'Content Security Policy', result: 'Allows resources over http', modifier: -20, status: 'weak', explain: 'Resources may load without encryption.', fix: 'Remove http: sources.' });
    } else if (csp.unsafeEval) {
      add({ id: 'csp', label: 'Content Security Policy', result: "Allows 'unsafe-eval'", modifier: -10, status: 'weak', explain: 'eval() and similar functions can run strings as code.', fix: "Remove 'unsafe-eval' (refactor code that uses eval or new Function)." });
    } else if (csp.insecurePassive) {
      add({ id: 'csp', label: 'Content Security Policy', result: 'Images or media over http allowed', modifier: -10, status: 'weak', explain: 'Images and media may load without encryption.', fix: 'Remove http: from img-src and media-src.' });
    } else if (csp.unsafeInlineStyleOnly) {
      add({ id: 'csp', label: 'Content Security Policy', result: 'Good (inline styles allowed)', modifier: 0, status: 'good', explain: "Scripts are restricted. 'unsafe-inline' only applies to styles, which is lower risk.", fix: null });
    } else {
      add({ id: 'csp', label: 'Content Security Policy', result: csp.defaultNone ? "Strong (default-src 'none')" : 'Strong', modifier: csp.defaultNone ? 10 : 5, bonus: true, status: 'good', explain: 'No unsafe inline scripts or eval.', fix: null });
    }

    // ---- HSTS
    const hsts = H['strict-transport-security'];
    if (!https) {
      add({ id: 'hsts', label: 'Strict-Transport-Security', result: 'Site not served over HTTPS', modifier: -20, status: 'bad', explain: 'HSTS only works on HTTPS sites.', fix: 'Move the site to HTTPS first.' });
    } else if (!hsts) {
      add({ id: 'hsts', label: 'Strict-Transport-Security', result: 'Not set', modifier: -20, status: 'missing', explain: 'Browsers may connect over plain http first, which can be intercepted.', fix: 'Strict-Transport-Security: max-age=31536000; includeSubDomains' });
    } else {
      const m = /max-age\s*=\s*"?(\d+)/i.exec(hsts);
      const age = m ? Number(m[1]) : null;
      if (age == null) add({ id: 'hsts', label: 'Strict-Transport-Security', result: 'Header not recognized', modifier: -20, status: 'bad', explain: 'max-age is missing.', fix: 'Strict-Transport-Security: max-age=31536000; includeSubDomains' });
      else if (age < 15768000) add({ id: 'hsts', label: 'Strict-Transport-Security', result: `max-age ${Math.round(age / 86400)} days (under 6 months)`, modifier: -10, status: 'weak', explain: 'Browsers forget the rule quickly.', fix: 'Use max-age=31536000 (one year).' });
      else add({ id: 'hsts', label: 'Strict-Transport-Security', result: `max-age ${Math.round(age / 86400)} days${/includesubdomains/i.test(hsts) ? ', includes subdomains' : ''}${/preload/i.test(hsts) ? ', preload requested' : ''}`, modifier: 0, status: 'good', explain: 'Browsers will always use HTTPS for this site.', fix: null });
    }

    // ---- Redirection (only what one passive request can show)
    if (headerInfo) {
      if (!https && headerInfo.finalScheme !== 'https') {
        add({ id: 'redirect', label: 'Redirect to HTTPS', result: 'No redirect to HTTPS', modifier: -20, status: 'bad', explain: 'Visitors stay on the insecure http address.', fix: 'Redirect every http:// request to https:// (301).' });
      } else if (headerInfo.requestedScheme === 'https' && headerInfo.finalScheme === 'http') {
        add({ id: 'redirect', label: 'Redirect to HTTPS', result: 'Redirects to http', modifier: -20, status: 'bad', explain: 'The final address is insecure.', fix: 'Redirect only to https:// URLs.' });
      } else {
        add({ id: 'redirect', label: 'Redirect to HTTPS', result: https ? 'Page is on HTTPS (http → https redirect not tested)' : 'Redirects to HTTPS', modifier: 0, status: https ? 'na' : 'good', explain: 'PageLens does not request the http:// address itself, to stay passive.', fix: null });
      }
    }

    // ---- X-Frame-Options / frame-ancestors
    const xfo = (H['x-frame-options'] || '').trim().toUpperCase();
    if (csp.valid && csp.directives['frame-ancestors']) {
      add({ id: 'xfo', label: 'Clickjacking protection', result: `CSP frame-ancestors ${csp.directives['frame-ancestors'].join(' ')}`, modifier: 5, bonus: true, status: 'good', explain: 'Other sites cannot frame this page without permission.', fix: null });
    } else if (xfo === 'DENY' || xfo === 'SAMEORIGIN') {
      add({ id: 'xfo', label: 'Clickjacking protection', result: `X-Frame-Options ${xfo}`, modifier: 0, status: 'good', explain: 'Other sites cannot frame this page.', fix: "Optionally also add CSP frame-ancestors 'self' (the modern equivalent)." });
    } else if (xfo.startsWith('ALLOW-FROM')) {
      add({ id: 'xfo', label: 'Clickjacking protection', result: 'X-Frame-Options ALLOW-FROM (ignored by modern browsers)', modifier: 0, status: 'weak', explain: 'Chrome, Firefox and Safari ignore ALLOW-FROM, so the page is effectively unprotected.', fix: "Use CSP frame-ancestors 'self' https://allowed.example instead." });
    } else if (xfo) {
      add({ id: 'xfo', label: 'Clickjacking protection', result: 'X-Frame-Options not recognized', modifier: -20, status: 'bad', explain: 'Browsers ignore invalid values.', fix: "X-Frame-Options: SAMEORIGIN, or CSP frame-ancestors 'self'." });
    } else {
      add({ id: 'xfo', label: 'Clickjacking protection', result: 'Not set', modifier: -20, status: 'missing', explain: 'Another site could load this page invisibly and trick people into clicking it.', fix: "Content-Security-Policy: frame-ancestors 'self' (and X-Frame-Options: SAMEORIGIN for old browsers)." });
    }

    // ---- X-Content-Type-Options
    const xcto = (H['x-content-type-options'] || '').trim().toLowerCase();
    if (xcto === 'nosniff') add({ id: 'xcto', label: 'X-Content-Type-Options', result: 'nosniff', modifier: 0, status: 'good', explain: 'Browsers will not guess file types.', fix: null });
    else add({ id: 'xcto', label: 'X-Content-Type-Options', result: xcto ? 'Not recognized' : 'Not set', modifier: -5, status: xcto ? 'bad' : 'missing', explain: 'A browser might treat an uploaded file as a script.', fix: 'X-Content-Type-Options: nosniff' });

    // ---- Referrer-Policy
    const rp = (H['referrer-policy'] || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean).pop() || '';
    if (['no-referrer', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin'].includes(rp)) {
      add({ id: 'referrer', label: 'Referrer-Policy', result: rp, modifier: 5, bonus: true, status: 'good', explain: 'Full page addresses are not leaked to other sites.', fix: null });
    } else if (rp === 'no-referrer-when-downgrade') {
      add({ id: 'referrer', label: 'Referrer-Policy', result: rp, modifier: 0, status: 'weak', explain: 'Full URLs (including private paths) are sent to other https sites.', fix: 'Referrer-Policy: strict-origin-when-cross-origin' });
    } else if (['origin', 'origin-when-cross-origin', 'unsafe-url'].includes(rp)) {
      add({ id: 'referrer', label: 'Referrer-Policy', result: rp, modifier: -5, status: 'weak', explain: rp === 'unsafe-url' ? 'Full URLs are sent everywhere, even over http.' : 'More of the address is shared than needed.', fix: 'Referrer-Policy: strict-origin-when-cross-origin' });
    } else if (rp) {
      add({ id: 'referrer', label: 'Referrer-Policy', result: 'Not recognized', modifier: -5, status: 'bad', explain: 'Browsers ignore invalid values.', fix: 'Referrer-Policy: strict-origin-when-cross-origin' });
    } else {
      add({ id: 'referrer', label: 'Referrer-Policy', result: 'Not set (browser default)', modifier: 0, status: 'missing', explain: 'Modern browsers default to strict-origin-when-cross-origin, but setting it explicitly is safer.', fix: 'Referrer-Policy: strict-origin-when-cross-origin' });
    }

    // ---- Subresource Integrity (from the page)
    const ext = scan.code.scripts.external;
    const third = ext.filter((s) => s.thirdParty);
    const insecureScripts = ext.filter((s) => s.scheme === 'http');
    if (!ext.length) add({ id: 'sri', label: 'Subresource Integrity', result: 'No external scripts', modifier: 0, status: 'na', explain: '', fix: null });
    else if (insecureScripts.length) {
      const withSri = insecureScripts.every((s) => s.integrity);
      add({ id: 'sri', label: 'Subresource Integrity', result: `${insecureScripts.length} script${insecureScripts.length === 1 ? '' : 's'} over http`, modifier: withSri ? -20 : -50, status: 'bad', explain: 'Scripts loaded over http can be replaced by anyone on the network.', fix: 'Load every script over https.' });
    } else if (!third.length) add({ id: 'sri', label: 'Subresource Integrity', result: 'All scripts from this site', modifier: 0, status: 'good', explain: 'No outside script sources to protect.', fix: null });
    else if (third.every((s) => s.integrity)) add({ id: 'sri', label: 'Subresource Integrity', result: 'All outside scripts are integrity-checked', modifier: 5, bonus: true, status: 'good', explain: 'Changed CDN files would be blocked.', fix: null });
    else add({ id: 'sri', label: 'Subresource Integrity', result: `${third.filter((s) => !s.integrity).length} of ${third.length} outside scripts unchecked`, modifier: -5, status: 'weak', explain: 'If a CDN is hacked, a changed file would run on this page.', fix: 'Add integrity="sha384-…" crossorigin="anonymous" to fixed-version CDN scripts.' });

    // ---- Cookies (only with flags)
    if (cookies) {
      const list = cookies;
      const session = list.filter((c) => SESSION_COOKIE.test(c.name));
      const hstsOn = https && Boolean(hsts);
      let t;
      if (!list.length) t = { result: 'No cookies', modifier: 0, status: 'good' };
      else if (session.some((c) => !c.secure && https) || (!https && session.length)) t = { result: 'Session cookie without Secure', modifier: hstsOn ? -10 : -40, status: 'bad' };
      else if (session.some((c) => !c.httpOnly)) t = { result: 'Session cookie readable by scripts (no HttpOnly)', modifier: -30, status: 'bad' };
      else if (list.some((c) => CSRF_COOKIE.test(c.name) && (c.sameSite === 'unspecified' || c.sameSite === 'no_restriction'))) t = { result: 'Anti-CSRF cookie without SameSite', modifier: -20, status: 'bad' };
      else if (list.some((c) => !c.secure)) t = { result: 'Some cookies without Secure', modifier: hstsOn ? -5 : -20, status: 'weak' };
      else if (list.every((c) => c.sameSite === 'lax' || c.sameSite === 'strict')) t = { result: 'Secure, HttpOnly sessions and SameSite', modifier: 5, bonus: true, status: 'good' };
      else t = { result: 'Secure, HttpOnly sessions', modifier: 0, status: 'good' };
      add({ id: 'cookies', label: 'Cookies', ...t, explain: `${list.length} cookie${list.length === 1 ? '' : 's'} checked (flags only).`, fix: t.modifier < 0 ? 'Set Secure on every cookie, HttpOnly on session cookies, and SameSite=Lax.' : null });
    } else {
      add({ id: 'cookies', label: 'Cookies', result: 'Not checked yet', modifier: 0, status: 'na', explain: 'Use "Check cookie flags" in the Privacy tab to include cookies in the grade.', fix: null });
    }

    // ---- CORS on the document
    const acao = H['access-control-allow-origin'];
    if (acao) {
      const cred = /true/i.test(H['access-control-allow-credentials'] || '');
      add({ id: 'cors', label: 'Cross-origin access (CORS)', result: acao === '*' ? 'Any site may read this page' : `Allowed for ${acao}`, modifier: cred && acao !== '*' ? 0 : 0,
        status: acao === '*' ? 'weak' : 'info', explain: acao === '*' ? 'Fine for public pages, but never for pages that show private data.' : 'Only the listed origin may read responses.', fix: acao === '*' ? 'Remove Access-Control-Allow-Origin from HTML pages unless they are public.' : null });
    }

    // ---- X-XSS-Protection (legacy)
    const xxp = H['x-xss-protection'];
    if (xxp != null) {
      const ok = /^\s*(0|1(\s*;\s*mode=block)?)\s*(;.*)?$/i.test(xxp);
      add({ id: 'xxp', label: 'X-XSS-Protection (legacy)', result: xxp, modifier: ok ? 0 : -5, status: ok ? (xxp.trim().startsWith('0') ? 'good' : 'info') : 'bad',
        explain: 'Modern browsers removed the XSS filter. "0" or leaving it out is the current advice; rely on CSP instead.', fix: xxp.trim().startsWith('0') ? null : 'X-XSS-Protection: 0 (or remove it)' });
    }

    // ---- score
    let score = 100;
    for (const t of tests) if (!t.bonus && t.modifier < 0) score += t.modifier;
    score = Math.max(0, score);
    let bonus = 0;
    if (score >= 90) for (const t of tests) if (t.bonus) bonus += t.modifier;
    score += bonus;

    return {
      available: true,
      tests,
      score,
      bonus,
      grade: letter(score),
      csp,
      table: headerTable(H, csp, https)
    };
  }

  // ------------------------------------------------------------ raw header table

  const SECURITY_HEADERS = [
    'content-security-policy', 'content-security-policy-report-only', 'strict-transport-security', 'x-frame-options',
    'x-content-type-options', 'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
    'cross-origin-resource-policy', 'access-control-allow-origin', 'access-control-allow-credentials', 'x-xss-protection',
    'reporting-endpoints', 'report-to', 'nel', 'expect-ct', 'public-key-pins', 'x-permitted-cross-domain-policies', 'clear-site-data'
  ];
  const LEAK_HEADERS = ['server', 'x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version', 'x-generator', 'x-drupal-cache', 'x-runtime', 'x-version'];

  function headerTable(H, csp, https) {
    const rows = [];
    const row = (name, status, note) => rows.push({ name, value: H[name] == null ? null : String(H[name]), status, note, security: true });

    for (const name of SECURITY_HEADERS) {
      const v = H[name];
      switch (name) {
        case 'content-security-policy':
          row(name, !v ? 'missing' : csp.valid && !csp.unsafeInline && !csp.unsafeEval ? 'good' : 'weak', !v ? 'Limits which scripts can run' : csp.issues.length ? csp.issues.join('; ') : 'Restrictive policy');
          break;
        case 'content-security-policy-report-only':
          if (v) row(name, 'info', 'Reports violations without blocking — good while testing a policy');
          break;
        case 'strict-transport-security':
          row(name, !https ? 'na' : !v ? 'missing' : /max-age\s*=\s*"?(\d{8,})/i.test(v) ? 'good' : 'weak', https ? 'Forces HTTPS on future visits' : 'Needs HTTPS');
          break;
        case 'x-frame-options':
          row(name, v ? (/^(deny|sameorigin)$/i.test(v.trim()) ? 'good' : 'weak') : csp.valid && csp.directives['frame-ancestors'] ? 'good' : 'missing',
            v ? 'Blocks framing by other sites' : csp.valid && csp.directives['frame-ancestors'] ? 'Covered by CSP frame-ancestors' : 'Blocks framing (clickjacking)');
          break;
        case 'x-content-type-options':
          row(name, v && /nosniff/i.test(v) ? 'good' : 'missing', 'Stops MIME-type guessing');
          break;
        case 'referrer-policy':
          row(name, !v ? 'missing' : /(^|,\s*)(no-referrer|same-origin|strict-origin|strict-origin-when-cross-origin)\s*$/i.test(v) ? 'good' : 'weak', 'Controls what URL other sites see');
          break;
        case 'permissions-policy':
          row(name, v ? 'good' : 'missing', 'Limits camera, microphone, location and other powerful features');
          break;
        case 'cross-origin-opener-policy':
          row(name, !v ? 'missing' : /same-origin/i.test(v) ? 'good' : 'weak', 'Isolates this window from pop-ups and openers');
          break;
        case 'cross-origin-embedder-policy':
        case 'cross-origin-resource-policy':
          if (v) row(name, 'good', name === 'cross-origin-resource-policy' ? 'Controls who may embed this resource' : 'Required for cross-origin isolation');
          break;
        case 'access-control-allow-origin':
          if (v) row(name, v === '*' ? 'weak' : 'info', v === '*' ? 'Any site may read this response' : 'CORS allowed for one origin');
          break;
        case 'access-control-allow-credentials':
          if (v) row(name, 'info', 'Cross-site requests may include cookies');
          break;
        case 'x-xss-protection':
          if (v) row(name, v.trim().startsWith('0') ? 'good' : 'info', 'Legacy; modern advice is "0" or remove');
          break;
        case 'expect-ct':
        case 'public-key-pins':
          if (v) row(name, 'weak', 'Deprecated — remove it');
          break;
        default:
          if (v) row(name, 'good', name === 'nel' || name === 'report-to' || name === 'reporting-endpoints' ? 'Error and violation reporting' : '');
      }
    }
    for (const name of LEAK_HEADERS) {
      const v = H[name];
      if (v) rows.push({ name, value: String(v), status: /\d/.test(v) || name !== 'server' ? 'weak' : 'info', note: /\d/.test(v) ? 'Reveals software version' : 'Reveals software in use', security: true });
    }
    const shown = new Set(rows.map((r) => r.name));
    for (const name of Object.keys(H).sort()) {
      if (shown.has(name)) continue;
      rows.push({ name, value: String(H[name]), status: 'other', note: '', security: false });
    }
    return rows;
  }

  root.PageLensHeaders = Object.freeze({ assess, parseCsp, cspAnalysis, letter, GRADES });
})(globalThis);
