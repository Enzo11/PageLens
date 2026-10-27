/* PageLens — lib/score.js
 * Turns a list of issues into area scores, an overall score, a grade and a
 * ranked fix list. Pure and deterministic: same issues in, same numbers out.
 *
 * Every area starts at 100. Each issue subtracts by severity:
 *   critical −20, high −10, medium −4, low −1   (floored at 0)
 * Overall = weighted average of the six areas, capped at 74 while any
 * critical issue remains.
 * Fix list is ranked by impact ÷ effort, where impact = points lost × area weight.
 */
(function (root) {
  'use strict';

  const AREAS = [
    { id: 'accessibility', label: 'Accessibility', weight: 0.25 },
    { id: 'performance', label: 'Performance', weight: 0.25 },
    { id: 'uiux', label: 'UI/UX', weight: 0.2 },
    { id: 'security', label: 'Privacy & security', weight: 0.15 },
    { id: 'design', label: 'Design consistency', weight: 0.1 },
    { id: 'seo', label: 'SEO', weight: 0.05 }
  ];
  const AREA = Object.fromEntries(AREAS.map((a) => [a.id, a]));

  const DEDUCTION = { critical: 20, high: 10, medium: 4, low: 1 };
  const CRITICAL_CAP = 74; // highest score allowed while any critical issue remains
  const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
  const EFFORT = {
    quick: { cost: 1, label: 'Quick fix' },
    moderate: { cost: 2, label: 'Some work' },
    involved: { cost: 3, label: 'Bigger job' }
  };

  function grade(score) {
    if (score >= 90) return { id: 'excellent', label: 'Excellent' };
    if (score >= 75) return { id: 'good', label: 'Good' };
    if (score >= 60) return { id: 'needs-work', label: 'Needs work' };
    return { id: 'poor', label: 'Poor' };
  }

  function impactOf(issue) {
    const area = AREA[issue.area];
    return (DEDUCTION[issue.severity] || 0) * (area ? area.weight : 0);
  }

  function rankValue(issue) {
    return impactOf(issue) / ((EFFORT[issue.effort] || EFFORT.moderate).cost);
  }

  /** Stable, deterministic ordering: rank, then severity, then id. */
  function compareIssues(a, b) {
    return rankValue(b) - rankValue(a) ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  function score(issues) {
    const areas = {};
    for (const a of AREAS) {
      areas[a.id] = { ...a, score: 100, lost: 0, issues: 0, counts: { critical: 0, high: 0, medium: 0, low: 0 } };
    }
    for (const i of issues) {
      const a = areas[i.area];
      if (!a) continue;
      const d = DEDUCTION[i.severity] || 0;
      a.lost += d;
      a.issues += 1;
      a.counts[i.severity] += 1;
    }
    let overall = 0;
    for (const a of Object.values(areas)) {
      a.score = Math.max(0, 100 - a.lost);
      a.grade = grade(a.score);
      overall += a.score * a.weight;
    }
    overall = Math.round(overall);

    const ranked = [...issues].sort(compareIssues);
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const i of issues) counts[i.severity] += 1;

    // Guardrail: a page with a critical problem (e.g. passwords sent in plain
    // text) can never be graded "Good" or "Excellent", whatever the average.
    const uncapped = overall;
    const capped = counts.critical > 0 && overall > CRITICAL_CAP;
    if (capped) overall = CRITICAL_CAP;

    return {
      overall,
      uncapped,
      capped,
      grade: grade(overall),
      areas,
      ranked,
      top: ranked.slice(0, 3),
      counts,
      total: issues.length
    };
  }

  root.PageLensScore = Object.freeze({ AREAS, AREA, DEDUCTION, EFFORT, SEVERITY_ORDER, grade, score, impactOf, rankValue, compareIssues });
})(globalThis);
