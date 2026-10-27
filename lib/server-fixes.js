/* PageLens — lib/server-fixes.js
 *
 * Turns the header assessment into ready-to-paste configuration for common
 * servers and hosts. Only headers that are missing or weak are included,
 * unless "all" is requested.
 *
 * Pure: returns strings; never applies anything.
 */
(function (root) {
  'use strict';

  const PLATFORMS = [
    { id: 'nginx', label: 'Nginx', file: 'nginx.conf (inside server { })' },
    { id: 'apache', label: 'Apache', file: '.htaccess or VirtualHost' },
    { id: 'caddy', label: 'Caddy', file: 'Caddyfile (inside the site block)' },
    { id: 'netlify', label: 'Netlify / Cloudflare Pages', file: '_headers (in the publish folder)' },
    { id: 'vercel', label: 'Vercel', file: 'vercel.json' },
    { id: 'nextjs', label: 'Next.js', file: 'next.config.js' },
    { id: 'express', label: 'Express (Node)', file: 'server.js' },
    { id: 'iis', label: 'IIS', file: 'web.config' }
  ];

  const DEFAULTS = {
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
    'Cross-Origin-Opener-Policy': 'same-origin'
  };

  const WHY = {
    'Strict-Transport-Security': 'Always use HTTPS for this site (only add once every subdomain works over HTTPS).',
    'X-Content-Type-Options': 'Stop browsers guessing file types.',
    'X-Frame-Options': 'Stop other sites framing this page (older browsers).',
    'Referrer-Policy': 'Send only the site name, not full URLs, to other sites.',
    'Permissions-Policy': 'Turn off camera, microphone and location unless you use them — edit the list if you do.',
    'Cross-Origin-Opener-Policy': 'Isolate this window from pop-ups. Use same-origin-allow-popups if you rely on OAuth or payment pop-ups.',
    'Content-Security-Policy-Report-Only': 'Test a script policy without breaking anything; switch the name to Content-Security-Policy once reports are clean.',
    'X-XSS-Protection': 'The old XSS filter is removed from modern browsers; "0" avoids side effects.'
  };

  /** Decide which headers to add, change or remove. */
  function recommend({ assessment, headers, scan, cspSuggestion, all = false }) {
    const H = headers || {};
    const https = scan.page.protocol === 'https';
    const status = (id) => (assessment.tests.find((t) => t.id === id) || {}).status;
    const set = [];
    const remove = [];
    const want = (name, value, cond) => { if (all || cond) set.push({ name, value, why: WHY[name] || '' }); };

    if (https) want('Strict-Transport-Security', DEFAULTS['Strict-Transport-Security'], status('hsts') !== 'good');
    want('X-Content-Type-Options', DEFAULTS['X-Content-Type-Options'], status('xcto') !== 'good');
    want('X-Frame-Options', DEFAULTS['X-Frame-Options'], status('xfo') !== 'good');
    want('Referrer-Policy', DEFAULTS['Referrer-Policy'], status('referrer') !== 'good');
    want('Permissions-Policy', DEFAULTS['Permissions-Policy'], !H['permissions-policy']);
    want('Cross-Origin-Opener-Policy', DEFAULTS['Cross-Origin-Opener-Policy'], !H['cross-origin-opener-policy']);
    if (cspSuggestion && (all || status('csp') !== 'good')) {
      set.push({ name: 'Content-Security-Policy-Report-Only', value: cspSuggestion.allowlist.replace(/\s*'nonce-\{SERVER_GENERATED_NONCE\}'/g, '').trim(), why: WHY['Content-Security-Policy-Report-Only'] });
    }
    if (H['x-xss-protection'] && !String(H['x-xss-protection']).trim().startsWith('0')) set.push({ name: 'X-XSS-Protection', value: '0', why: WHY['X-XSS-Protection'] });

    for (const n of ['x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version']) if (H[n]) remove.push(n.replace(/(^|-)([a-z])/g, (m, d, c) => d + c.toUpperCase()));
    const serverLeak = H.server && /\d/.test(H.server);
    for (const n of ['expect-ct', 'public-key-pins']) if (H[n]) remove.push(n.replace(/(^|-)([a-z])/g, (m, d, c) => d + c.toUpperCase()));
    return { set, remove, serverLeak };
  }

  const dq = (v) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const xml = (v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  function snippet(platform, rec) {
    const { set, remove, serverLeak } = rec;
    const L = [];
    switch (platform) {
      case 'nginx':
        L.push('# Inside your server { } block. "always" also covers error pages.');
        for (const h of set) L.push(`add_header ${h.name} "${dq(h.value)}" always;`);
        if (serverLeak) L.push('server_tokens off;   # hide the nginx version');
        for (const r of remove) L.push(`proxy_hide_header ${r};\nfastcgi_hide_header ${r};`);
        L.push('# Note: add_header in a location { } block replaces these — repeat them there if you use any.');
        break;
      case 'apache':
        L.push('<IfModule mod_headers.c>');
        for (const h of set) L.push(`  Header always set ${h.name} "${dq(h.value)}"`);
        for (const r of remove) L.push(`  Header always unset ${r}`);
        L.push('</IfModule>');
        if (serverLeak) L.push('# In the main server config (not .htaccess):\n# ServerTokens Prod\n# ServerSignature Off');
        break;
      case 'caddy':
        L.push('header {');
        for (const h of set) L.push(`  ${h.name} "${dq(h.value)}"`);
        for (const r of remove) L.push(`  -${r}`);
        if (serverLeak) L.push('  -Server');
        L.push('}');
        break;
      case 'netlify':
        L.push('/*');
        for (const h of set) L.push(`  ${h.name}: ${h.value}`);
        if (remove.length || serverLeak) L.push('# _headers files cannot remove headers your host adds itself.');
        break;
      case 'vercel': {
        const obj = { headers: [{ source: '/(.*)', headers: set.map((h) => ({ key: h.name, value: h.value })) }] };
        L.push(JSON.stringify(obj, null, 2));
        break;
      }
      case 'nextjs':
        L.push('/** @type {import(\'next\').NextConfig} */');
        L.push('const securityHeaders = [');
        for (const h of set) L.push(`  { key: '${h.name}', value: ${JSON.stringify(h.value)} },`);
        L.push('];\n');
        L.push('module.exports = {');
        L.push('  poweredByHeader: false, // removes X-Powered-By: Next.js');
        L.push('  async headers() {');
        L.push("    return [{ source: '/:path*', headers: securityHeaders }];");
        L.push('  },');
        L.push('};');
        break;
      case 'express':
        L.push("// Tip: the 'helmet' package sets most of these for you: app.use(require('helmet')())");
        L.push("app.disable('x-powered-by');");
        L.push('app.use((req, res, next) => {');
        for (const h of set) L.push(`  res.setHeader('${h.name}', ${JSON.stringify(h.value)});`);
        for (const r of remove.filter((x) => x !== 'X-Powered-By')) L.push(`  res.removeHeader('${r}');`);
        L.push('  next();');
        L.push('});');
        break;
      case 'iis':
        L.push('<configuration>');
        L.push('  <system.webServer>');
        L.push('    <httpProtocol>');
        L.push('      <customHeaders>');
        for (const r of remove) L.push(`        <remove name="${xml(r)}" />`);
        for (const h of set) L.push(`        <add name="${xml(h.name)}" value="${xml(h.value)}" />`);
        L.push('      </customHeaders>');
        L.push('    </httpProtocol>');
        if (serverLeak) L.push('    <security><requestFiltering removeServerHeader="true" /></security>');
        L.push('  </system.webServer>');
        L.push('</configuration>');
        break;
      default:
        return '';
    }
    return L.join('\n');
  }

  /** Best guess at the platform from response headers and detected tech. */
  function detectPlatform(headers, tech) {
    const H = headers || {};
    const server = String(H.server || '').toLowerCase();
    const powered = String(H['x-powered-by'] || '').toLowerCase();
    const has = (n) => (tech || []).some((t) => t.name === n);
    if (H['x-vercel-id'] || server.includes('vercel')) return has('Next.js') ? 'nextjs' : 'vercel';
    if (H['x-nf-request-id'] || server.includes('netlify')) return 'netlify';
    if (powered.includes('next.js') || has('Next.js')) return 'nextjs';
    if (powered.includes('express')) return 'express';
    if (server.includes('nginx') || server.includes('openresty')) return 'nginx';
    if (server.includes('apache') || server.includes('litespeed')) return 'apache';
    if (server.includes('caddy')) return 'caddy';
    if (server.includes('iis') || powered.includes('asp.net')) return 'iis';
    if (server.includes('cloudflare')) return 'netlify';
    return 'nginx';
  }

  root.PageLensFixes = Object.freeze({ PLATFORMS, recommend, snippet, detectPlatform, DEFAULTS });
})(globalThis);
