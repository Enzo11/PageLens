/* PageLens — lib/pipeline.js
 * One place that turns raw inputs into every derived result, so the popup and
 * the full-report tab always compute exactly the same thing. Pure.
 *
 * Needs: color, score, headers, csp-builder, server-fixes, trackers, analyze.
 */
(function (root) {
  'use strict';

  /**
   * @param {{scan, headers, cookies, tech, securityTxt}} input  headers = the service worker's header result
   */
  function website(input) {
    const { scan, headers, cookies, tech, securityTxt } = input;
    const hd = headers && headers.headers;
    const assessment = root.PageLensHeaders.assess({ headers: hd, headerInfo: headers, scan, cookies });
    const csp = root.PageLensCsp.build(scan, hd && hd['content-security-policy']);
    const trackers = root.PageLensTrackers.classify(scan.performance.hosts.filter((x) => x.thirdParty && x.host));
    const analysis = root.PageLensAnalyze.analyze({ scan, headers, cookies, tech, securityTxt });
    const score = root.PageLensScore.score(analysis.issues);
    return { assessment, csp, trackers, analysis, score };
  }

  /** Server config for one platform (null when headers are unavailable). */
  function fixes({ assessment, headers, scan, csp, tech, platform, all = false }) {
    if (!assessment || !assessment.available) return null;
    const F = root.PageLensFixes;
    const hd = headers && headers.headers;
    const id = platform || F.detectPlatform(hd, tech);
    const rec = F.recommend({ assessment, headers: hd, scan, cspSuggestion: csp, all });
    const p = F.PLATFORMS.find((x) => x.id === id) || F.PLATFORMS[0];
    return { platform: p.id, label: p.label, file: p.file, snippet: F.snippet(p.id, rec), ...rec };
  }

  root.PageLensPipeline = Object.freeze({ website, fixes });
})(globalThis);
