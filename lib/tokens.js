/* PageLens — lib/tokens.js
 * Turns the extracted design system into design tokens.
 * Day 1: CSS custom properties. Later builds add Tailwind config and Figma tokens
 * from the same token list, so naming lives in one place.
 */
(function (root) {
  'use strict';

  const SIZE_NAMES_UP = ['lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl'];
  const SIZE_NAMES_DOWN = ['sm', 'xs', '2xs', '3xs'];

  function quoteFamily(stack) {
    return stack
      .map((f) => (/^[a-z-]+$/i.test(f) && !/\s/.test(f) ? f : `"${f.replace(/"/g, '')}"`))
      .join(', ');
  }

  /** Build an ordered token list: [{group, name, value, note}] */
  function buildTokens(scan) {
    const d = scan && scan.design;
    if (!d) return [];
    const tokens = [];

    // Colors: name by dominant role, numbered by usage.
    const counters = { bg: 0, text: 0, border: 0, accent: 0 };
    for (const sw of d.palette.slice(0, 16)) {
      let role;
      if (sw.kind === 'accent') role = 'accent';
      else {
        const r = sw.roles || {};
        role = r.background >= r.text && r.background >= r.border ? 'bg' : r.text >= r.border ? 'text' : 'border';
      }
      counters[role] += 1;
      tokens.push({ group: 'color', name: `--color-${role}-${counters[role]}`, value: sw.hex, note: `${(sw.share * 100).toFixed(1)}% of color usage` });
    }

    // Fonts
    const byRole = (role) => d.fonts.find((f) => f.primaryRole === role);
    const heading = byRole('heading') || d.fonts[0];
    const body = byRole('body') || d.fonts[0];
    const mono = byRole('code');
    if (heading) tokens.push({ group: 'font', name: '--font-heading', value: quoteFamily(heading.stack) });
    if (body) tokens.push({ group: 'font', name: '--font-body', value: quoteFamily(body.stack) });
    if (mono) tokens.push({ group: 'font', name: '--font-mono', value: quoteFamily(mono.stack) });

    // Type scale, named around the base size.
    const steps = [...d.typeScale.steps].sort((a, b) => a.px - b.px);
    if (steps.length) {
      const basePx = d.typeScale.basePx;
      let baseIdx = steps.findIndex((s) => s.px === basePx);
      if (baseIdx < 0) baseIdx = Math.max(0, steps.findIndex((s) => s.px > basePx) - 1);
      steps.forEach((s, i) => {
        let name;
        if (i === baseIdx) name = 'base';
        else if (i > baseIdx) name = SIZE_NAMES_UP[i - baseIdx - 1] || `${i - baseIdx}xl`;
        else name = SIZE_NAMES_DOWN[baseIdx - i - 1] || `${baseIdx - i}xs`;
        tokens.push({ group: 'type', name: `--text-${name}`, value: `${+(s.px / 16).toFixed(4)}rem`, note: `${s.px}px` });
      });
    }

    // Spacing: most-used values, ascending.
    const space = d.spacing.values.slice(0, 12).map((v) => v.px).sort((a, b) => a - b);
    space.forEach((px, i) => tokens.push({ group: 'space', name: `--space-${i + 1}`, value: `${px}px` }));

    // Radii
    const radii = d.radii.values
      .map((r) => r.value)
      .filter((v) => !/\s/.test(v))
      .slice(0, 6);
    const sized = radii
      .map((v) => ({ v, n: v.endsWith('%') || parseFloat(v) >= 999 ? Infinity : parseFloat(v) }))
      .sort((a, b) => a.n - b.n);
    const radiusNames = ['sm', 'md', 'lg', 'xl', '2xl'];
    let ri = 0;
    for (const r of sized) {
      const name = r.n === Infinity ? 'full' : radiusNames[ri++] || `${ri}`;
      if (tokens.some((t) => t.name === `--radius-${name}`)) continue;
      tokens.push({ group: 'radius', name: `--radius-${name}`, value: r.n === Infinity ? '9999px' : r.v });
    }

    // Shadows
    d.shadows.values.slice(0, 4).forEach((s, i) => tokens.push({ group: 'shadow', name: `--shadow-${i + 1}`, value: s.value }));

    return tokens;
  }

  function toCssVariables(scan) {
    const tokens = buildTokens(scan);
    const host = (scan && scan.page && scan.page.host) || 'page';
    const lines = [
      `/* Design tokens extracted by PageLens from ${host}`,
      ` * ${new Date(scan.scannedAt).toISOString().slice(0, 10)} · measured from rendered styles */`,
      ':root {'
    ];
    let group = null;
    for (const t of tokens) {
      if (t.group !== group) {
        if (group) lines.push('');
        lines.push(`  /* ${t.group} */`);
        group = t.group;
      }
      lines.push(`  ${t.name}: ${t.value};${t.note ? ` /* ${t.note} */` : ''}`);
    }
    lines.push('}');
    return lines.join('\n') + '\n';
  }

  const strip = (name, prefix) => name.replace(`--${prefix}-`, '');

  /** tailwind.config.js (theme.extend), using the same token names. */
  function toTailwind(scan) {
    const tokens = buildTokens(scan);
    const group = (g, prefix) => Object.fromEntries(tokens.filter((t) => t.group === g).map((t) => [strip(t.name, prefix), t.value]));
    const fonts = Object.fromEntries(tokens.filter((t) => t.group === 'font').map((t) => [strip(t.name, 'font'),
      t.value.split(/,\s*/).map((f) => f.replace(/^"|"$/g, ''))]));
    const theme = {
      colors: group('color', 'color'),
      fontFamily: fonts,
      fontSize: group('type', 'text'),
      spacing: Object.fromEntries(Object.entries(group('space', 'space')).map(([k, v]) => [`s${k}`, v])),
      borderRadius: group('radius', 'radius'),
      boxShadow: group('shadow', 'shadow')
    };
    for (const k of Object.keys(theme)) if (!Object.keys(theme[k]).length) delete theme[k];
    const host = (scan && scan.page && scan.page.host) || 'page';
    return `/** Tailwind theme extracted by PageLens from ${host} (${new Date(scan.scannedAt).toISOString().slice(0, 10)}).
 * Usage: bg-bg-1, text-text-1, font-heading, text-base, p-s3, rounded-md, shadow-1 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    extend: ${JSON.stringify(theme, null, 2).replace(/\n/g, '\n    ')}
  }
};
`;
  }

  /** W3C Design Tokens Community Group format (works with Tokens Studio for Figma, Style Dictionary). */
  function toDesignTokens(scan) {
    const tokens = buildTokens(scan);
    const TYPE = { color: 'color', font: 'fontFamily', type: 'dimension', space: 'dimension', radius: 'dimension', shadow: 'shadow' };
    const PREFIX = { color: 'color', font: 'font', type: 'text', space: 'space', radius: 'radius', shadow: 'shadow' };
    const GROUP = { color: 'color', font: 'font', type: 'fontSize', space: 'spacing', radius: 'radius', shadow: 'shadow' };
    const out = { $description: `Extracted by PageLens from ${(scan && scan.page && scan.page.host) || 'page'}` };
    for (const t of tokens) {
      const g = GROUP[t.group];
      out[g] = out[g] || {};
      const entry = { $type: TYPE[t.group], $value: t.group === 'font' ? t.value.split(/,\s*/).map((f) => f.replace(/^"|"$/g, '')) : t.value };
      if (t.group === 'shadow') { entry.$type = 'string'; } // CSS shadow strings are kept as-is
      if (t.note) entry.$description = t.note;
      out[g][strip(t.name, PREFIX[t.group])] = entry;
    }
    return JSON.stringify(out, null, 2) + '\n';
  }

  root.PageLensTokens = Object.freeze({ buildTokens, toCssVariables, toTailwind, toDesignTokens });
})(globalThis);
