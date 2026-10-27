/* PageLens — lib/export-html.js
 * Renders a report model as HTML. Used by the full-report tab and by the
 * "HTML report" export (a single self-contained file, no scripts).
 * Every value from the page is escaped. Pure.
 */
(function (root) {
  'use strict';

  const SEV = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
  const EFFORT = { quick: 'Quick fix', moderate: 'Some work', involved: 'Bigger job' };
  const e = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(String(c)) ? c : '#cccccc');

  const CSS = `
:root{--bg:#f6f6f9;--surface:#fff;--surface-2:#f0f0f5;--border:#e2e2ea;--text:#15151c;--muted:#565667;--faint:#6f6f80;--accent:#5636f5;--accent-soft:#ece8ff;--good:#11804f;--warn:#a96400;--bad:#c42a3a;--ok:#5636f5;
--font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,Consolas,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0e0e13;--surface:#16161d;--surface-2:#1d1d26;--border:#2a2a35;--text:#ececf3;--muted:#a6a6b8;--faint:#8c8ca0;--accent:#8c78ff;--accent-soft:#241f48;--good:#3fcf8f;--warn:#f0b44c;--bad:#ff6b7b;--ok:#8c78ff;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0e0e13;--surface:#16161d;--surface-2:#1d1d26;--border:#2a2a35;--text:#ececf3;--muted:#a6a6b8;--faint:#8c8ca0;--accent:#8c78ff;--accent-soft:#241f48;--good:#3fcf8f;--warn:#f0b44c;--bad:#ff6b7b;--ok:#8c78ff;color-scheme:dark}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 var(--font);-webkit-font-smoothing:antialiased}
.pl-doc{max-width:900px;margin:0 auto;padding:32px 20px 64px}
.pl-head h1{font-size:28px;line-height:1.2;margin:0 0 6px;letter-spacing:-.02em}.pl-sub{color:var(--muted);margin:0 0 10px}.pl-meta{display:flex;flex-wrap:wrap;gap:6px 14px;color:var(--faint);font-size:13px;margin:0;padding:0;list-style:none}
.pl-toc{margin:22px 0 8px;padding:14px 18px;background:var(--surface);border:1px solid var(--border);border-radius:12px;columns:2;column-gap:28px;font-size:14px}.pl-toc ol{margin:0;padding-left:20px}.pl-toc a{color:var(--text);text-decoration:none}.pl-toc a:hover{color:var(--accent);text-decoration:underline}
.pl-sec{margin-top:26px;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:20px 22px;break-inside:avoid-page}
.pl-sec>h2{font-size:20px;margin:0 0 14px;letter-spacing:-.01em}.pl-sec h3{font-size:14px;margin:18px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.pl-sec p{margin:0 0 10px}.pl-note{color:var(--muted);font-size:14px;border-left:3px solid var(--border);padding:2px 0 2px 12px;margin:10px 0}
.pl-score{display:flex;align-items:center;gap:16px;margin-bottom:12px}.pl-score svg{flex:none}.pl-score .lbl{font-size:20px;font-weight:650}.pl-score .nt{color:var(--muted);font-size:14px}
.t-good{color:var(--good)}.t-ok{color:var(--ok)}.t-warn{color:var(--warn)}.t-bad{color:var(--bad)}
.pl-bars{display:grid;gap:7px;margin:8px 0 12px}.pl-bar{display:grid;grid-template-columns:minmax(120px,220px) 1fr 54px;gap:10px;align-items:center;font-size:14px}.pl-bar .tr{height:8px;border-radius:9px;background:var(--surface-2);overflow:hidden}.pl-bar i{display:block;height:100%;border-radius:9px}.pl-bar .v{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
.b-good{background:var(--good)}.b-ok{background:var(--ok)}.b-warn{background:var(--warn)}.b-bad{background:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:13.5px;margin:4px 0 12px}th{text-align:left;color:var(--muted);font-weight:600;font-size:12.5px;border-bottom:1px solid var(--border);padding:6px 8px 6px 0}td{border-bottom:1px solid var(--border);padding:6px 8px 6px 0;vertical-align:top;overflow-wrap:anywhere}tr:last-child td{border-bottom:0}.num{text-align:right;font-variant-numeric:tabular-nums}
.pl-kv td:first-child{color:var(--muted);width:32%}
ul.pl-list{margin:0 0 12px;padding-left:20px}ul.pl-list li{margin:3px 0}ul.pl-list .sub{color:var(--muted);font-size:13.5px}
.pl-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}.pl-chips span{background:var(--surface-2);border:1px solid var(--border);border-radius:99px;padding:2px 10px;font-size:12.5px;font-family:var(--mono)}
.pl-pal{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:0 0 12px}.pl-sw{display:flex;gap:9px;align-items:center;border:1px solid var(--border);border-radius:10px;padding:6px}.pl-sw i{width:36px;height:36px;border-radius:7px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.1);flex:none}.pl-sw b{font-family:var(--mono);font-size:13px;display:block}.pl-sw span{color:var(--muted);font-size:12px}
.pl-out{list-style:none;margin:0 0 12px;padding:0}.pl-out li{padding:2px 0}.pl-out .h{font-family:var(--mono);font-size:11px;font-weight:700;color:var(--accent);background:var(--accent-soft);border-radius:4px;padding:1px 5px;margin-right:8px}
pre{background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:12px;overflow-x:auto;font:12.5px/1.55 var(--mono);white-space:pre-wrap;word-break:break-word;margin:4px 0 12px}
.pl-cap{color:var(--muted);font-size:13px;margin:0 0 4px}
.pl-iss{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:8px}.pl-iss li{border:1px solid var(--border);border-radius:10px;padding:10px 12px}.pl-iss .t{font-weight:600;display:flex;gap:8px;align-items:baseline}.pl-iss .why{color:var(--muted);margin:4px 0 2px;font-size:14px}.pl-iss .fix{font-size:14px;margin:2px 0}.pl-iss .meta{color:var(--faint);font-size:12.5px;margin-top:4px}
.sev{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;border-radius:5px;padding:1px 6px;flex:none}.sev-critical{background:color-mix(in srgb,var(--bad) 18%,transparent);color:var(--bad)}.sev-high{background:color-mix(in srgb,#df5f22 18%,transparent);color:#df5f22}.sev-medium{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)}.sev-low{background:var(--surface-2);color:var(--muted)}
.pl-foot{color:var(--faint);font-size:13px;text-align:center;margin-top:30px}
@media (max-width:640px){.pl-toc{columns:1}.pl-sec{padding:16px}.pl-bar{grid-template-columns:110px 1fr 46px}}
@media print{body{background:#fff}.pl-sec{border:0;padding:0;margin-top:18px}.pl-toc{display:none}a{color:inherit}}
`;

  function ring(value, max, tone) {
    const r = 30;
    const c = 2 * Math.PI * r;
    const frac = Math.max(0, Math.min(1, value / max));
    return `<svg width="76" height="76" viewBox="0 0 76 76" role="img" aria-label="${e(value)} out of ${e(max)}"><circle cx="38" cy="38" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="8"/>` +
      `<circle cx="38" cy="38" r="${r}" fill="none" class="b-${e(tone)}" style="stroke:var(--${e(tone)})" stroke-width="8" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - frac)).toFixed(2)}" transform="rotate(-90 38 38)"/>` +
      `<text x="38" y="38" text-anchor="middle" dominant-baseline="central" font-size="22" font-weight="700" fill="var(--text)" font-family="system-ui,sans-serif">${e(value)}</text></svg>`;
  }

  function block(b) {
    const title = b.title ? `<h3>${e(b.title)}</h3>` : '';
    switch (b.type) {
      case 'p': return `${title}<p>${e(b.text)}</p>`;
      case 'note': return `${title}<p class="pl-note">${e(b.text)}</p>`;
      case 'score': return `${title}<div class="pl-score">${ring(b.value, b.max, b.tone)}<div><div class="lbl t-${e(b.tone)}">${e(b.label)}</div>${b.note ? `<div class="nt">${e(b.note)}</div>` : ''}</div></div>`;
      case 'kv': return `${title}<table class="pl-kv"><tbody>${b.rows.map(([k, v]) => `<tr><td>${e(k)}</td><td>${e(v)}</td></tr>`).join('')}</tbody></table>`;
      case 'table': {
        const num = new Set(b.num || []);
        return `${title}<table><thead><tr>${b.head.map((x, i) => `<th${num.has(i) ? ' class="num"' : ''}>${e(x)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((x, i) => `<td${num.has(i) ? ' class="num"' : ''}>${e(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      }
      case 'bars': return `${title}<div class="pl-bars">${b.items.map((x) => `<div class="pl-bar"><span>${e(x.label)}</span><span class="tr"><i class="b-${e(x.tone)}" style="width:${Math.max(2, Math.round((x.value / x.max) * 100))}%"></i></span><span class="v">${e(x.value)}/${e(x.max)}</span></div>`).join('')}</div>`;
      case 'list': return `${title}<ul class="pl-list">${b.items.map((x) => {
        const it = typeof x === 'string' ? { text: x } : x;
        return `<li${it.level ? ` style="margin-left:${it.level * 18}px"` : ''}${it.tone ? ` class="t-${e(it.tone)}"` : ''}>${e(it.text)}${it.sub ? ` <span class="sub">— ${e(it.sub)}</span>` : ''}</li>`;
      }).join('')}</ul>`;
      case 'chips': return `${title}<div class="pl-chips">${b.items.map((x) => `<span>${e(x)}</span>`).join('')}</div>`;
      case 'palette': return `${title}<div class="pl-pal">${b.items.map((p) => `<div class="pl-sw"><i style="background:${safeColor(p.hex)}"></i><div><b>${e(p.hex.toUpperCase())}</b><span>${(p.share * 100).toFixed(1)}% · ${e(p.role)}</span></div></div>`).join('')}</div>`;
      case 'outline': return `${title}<ul class="pl-out">${b.items.map((x) => `<li style="padding-left:${(x.level - 1) * 18}px"><span class="h">H${e(x.level)}</span>${e(x.text)}</li>`).join('')}</ul>`;
      case 'code': return `${title}${b.caption ? `<p class="pl-cap">${e(b.caption)}</p>` : ''}<pre><code>${e(b.text)}</code></pre>`;
      case 'issues': return `${title}<ul class="pl-iss">${b.items.map((i) => `<li><div class="t"><span class="sev sev-${e(i.severity)}">${e(SEV[i.severity])}</span><span>${e(i.title)}</span></div>` +
        (b.detail ? `<div class="why">${e(i.why)}</div><div class="fix"><b>How to fix:</b> ${e(i.fix)}</div>` : '') +
        `<div class="meta">${e([EFFORT[i.effort], i.whereText, i.ref].filter(Boolean).join(' · '))}</div></li>`).join('')}</ul>`;
      default: return '';
    }
  }

  function body(model) {
    return `<main class="pl-doc"><header class="pl-head"><h1>${e(model.title)}</h1>${model.subtitle ? `<p class="pl-sub">${e(model.subtitle)}</p>` : ''}` +
      `<ul class="pl-meta">${model.meta.map((m) => `<li>${e(m)}</li>`).join('')}</ul></header>` +
      `<nav class="pl-toc" aria-label="Contents"><ol>${model.sections.map((s) => `<li><a href="#${e(s.id)}">${e(s.title)}</a></li>`).join('')}</ol></nav>` +
      model.sections.map((s) => `<section class="pl-sec" id="${e(s.id)}"><h2>${e(s.title)}</h2>${s.blocks.map(block).join('')}</section>`).join('') +
      `<p class="pl-foot">Generated by PageLens — free, open-source and rule-based. The same page always gives the same result.</p></main>`;
  }

  /** A complete standalone HTML file (no scripts, styles inline). */
  function document_(model) {
    return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${e(model.title)}</title>\n<style>${CSS}</style>\n</head>\n<body>\n${body(model)}\n</body>\n</html>\n`;
  }

  root.PageLensHtml = Object.freeze({ CSS, body, document: document_ });
})(globalThis);
