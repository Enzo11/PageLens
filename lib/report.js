/* PageLens — lib/report.js
 *
 * Builds a shareable Markdown security report (for a client, a ticket or a
 * pull request), and parses security.txt (RFC 9116).
 * Pure: strings in, strings out.
 */
(function (root) {
  'use strict';

  const SEV = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
  const STATUS = { good: 'OK', weak: 'Weak', missing: 'Missing', bad: 'Problem', info: 'Info', na: 'n/a', other: '' };

  const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);

  /**
   * @param {object} o
   *   scan, score (PageLensScore result), assessment (PageLensHeaders), csp (PageLensCsp),
   *   fixes {platform, label, snippet, set, remove}, trackers (PageLensTrackers.classify), securityTxt, version
   */
  function securityMarkdown(o) {
    const { scan, score, assessment, csp, fixes, trackers, securityTxt, version } = o;
    const date = new Date(scan.scannedAt).toISOString().slice(0, 10);
    const sec = score.areas.security;
    const issues = score.ranked.filter((i) => i.area === 'security');
    const L = [];
    L.push(`# Security report: ${scan.page.host}`);
    L.push('');
    L.push(`**Page:** ${scan.page.url}  `);
    L.push(`**Checked:** ${date} with PageLens ${version || ''} (passive checks only: no attack traffic, no logins)  `);
    L.push(`**Header grade:** ${assessment && assessment.available ? `${assessment.grade} (${assessment.score}/100, HTTP Observatory method)` : 'headers not available'}  `);
    L.push(`**Privacy & security score:** ${sec.score}/100 (${sec.grade.label}) · overall page score ${score.overall}/100`);
    L.push('');

    L.push('## Summary');
    L.push('');
    const c = sec.counts;
    L.push(issues.length
      ? `${issues.length} finding${issues.length === 1 ? '' : 's'}: ${c.critical} critical, ${c.high} high, ${c.medium} medium, ${c.low} low.`
      : 'No security findings from the automatic checks.');
    L.push('');

    if (issues.length) {
      L.push('## Findings (most important first)');
      L.push('');
      L.push('| # | Severity | Finding | How to fix |');
      L.push('|---|---|---|---|');
      issues.forEach((i, n) => L.push(`| ${n + 1} | ${SEV[i.severity]} | ${cell(i.title)} | ${cell(clip(i.fix, 220))} |`));
      L.push('');
    }

    if (assessment && assessment.available) {
      L.push('## Header tests');
      L.push('');
      L.push('| Test | Result | Points |');
      L.push('|---|---|---|');
      for (const t of assessment.tests) L.push(`| ${cell(t.label)} | ${cell(t.result)} | ${t.modifier > 0 ? '+' : ''}${t.modifier}${t.bonus ? ' (bonus)' : ''} |`);
      L.push('');
      L.push('## Response headers');
      L.push('');
      L.push('| Header | Status | Value |');
      L.push('|---|---|---|');
      for (const r of assessment.table.filter((x) => x.security)) L.push(`| ${cell(r.name)} | ${STATUS[r.status] || r.status} | ${r.value == null ? '—' : '`' + cell(clip(r.value, 160)) + '`'} |`);
      L.push('');
    }

    if (fixes && fixes.set.length + fixes.remove.length) {
      L.push(`## Recommended configuration (${fixes.label})`);
      L.push('');
      for (const h of fixes.set) L.push(`- **${h.name}**: ${h.why}`);
      for (const r of fixes.remove) L.push(`- **Remove ${r}**: it reveals server details.`);
      L.push('');
      L.push('```');
      L.push(fixes.snippet);
      L.push('```');
      L.push('');
    }

    if (csp) {
      L.push('## Suggested Content-Security-Policy');
      L.push('');
      L.push('Deploy as `Content-Security-Policy-Report-Only` first and watch for violations.');
      L.push('');
      L.push('Allowlist (built from the resources this page loaded):');
      L.push('');
      L.push('```');
      L.push(csp.allowlist);
      L.push('```');
      L.push('');
      L.push('Strict (recommended by Google; needs a fresh nonce on every script tag):');
      L.push('');
      L.push('```');
      L.push(csp.strict);
      L.push('```');
      L.push('');
      for (const n of csp.notes) L.push(`- ${n}`);
      L.push('');
    }

    if (trackers && trackers.companies.length) {
      L.push('## Third parties');
      L.push('');
      for (const t of trackers.companies) L.push(`- ${t.company} (${t.categories.join(', ')}): ${t.hosts.join(', ')}`);
      if (trackers.unknown.length) L.push(`- Unrecognized hosts: ${trackers.unknown.map((u) => u.host).join(', ')}`);
      L.push('');
    }

    if (securityTxt) {
      L.push('## security.txt');
      L.push('');
      L.push(securityTxt.found ? `Found. Contact: ${securityTxt.contact.join(', ') || 'none'}; expires ${securityTxt.expires || 'not set'}${securityTxt.expired ? ' (EXPIRED)' : ''}.` : 'Not found at /.well-known/security.txt.');
      L.push('');
    }

    L.push('## Method');
    L.push('');
    L.push('- Reads only what the browser already loaded, plus one ordinary request for this page\'s headers without cookies.');
    L.push('- Never sends attack traffic, fuzzes, or logs in. Cookie, storage and form values are never read.');
    L.push('- Header grade follows Mozilla HTTP Observatory\'s published scoring. PageLens cannot test http→https redirects for https pages or the HSTS preload list.');
    L.push('- Automated checks miss things. Treat this as a starting point, not a penetration test.');
    L.push('');
    return L.join('\n');
  }

  /** Parse security.txt (RFC 9116). `now` makes expiry checks deterministic. */
  function parseSecurityTxt(text, now) {
    const out = { found: true, contact: [], expires: null, expired: false, encryption: [], policy: [], acknowledgments: [], hiring: [], canonical: [], languages: null, signed: false, problems: [] };
    if (!text) return { found: false };
    out.signed = /-----BEGIN PGP SIGNED MESSAGE-----/.test(text);
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('-----') || /^Hash:/i.test(line)) continue;
      const m = /^([A-Za-z-]+):\s*(.+)$/.exec(line);
      if (!m) continue;
      const k = m[1].toLowerCase();
      const v = m[2].trim().slice(0, 300);
      if (k === 'contact') out.contact.push(v);
      else if (k === 'expires') out.expires = v;
      else if (k === 'encryption') out.encryption.push(v);
      else if (k === 'policy') out.policy.push(v);
      else if (k === 'acknowledgments' || k === 'acknowledgements') out.acknowledgments.push(v);
      else if (k === 'hiring') out.hiring.push(v);
      else if (k === 'canonical') out.canonical.push(v);
      else if (k === 'preferred-languages') out.languages = v;
    }
    if (!out.contact.length) out.problems.push('No Contact field (required)');
    if (!out.expires) out.problems.push('No Expires field (required)');
    else {
      const t = Date.parse(out.expires);
      if (!Number.isFinite(t)) out.problems.push('Expires is not a valid date');
      else if (t < now) { out.expired = true; out.problems.push('The file has expired'); }
      else if (t - now > 366 * 86400000) out.problems.push('Expires is more than a year away (RFC 9116 recommends less)');
    }
    return out;
  }

  root.PageLensReport = Object.freeze({ securityMarkdown, parseSecurityTxt });
})(globalThis);
