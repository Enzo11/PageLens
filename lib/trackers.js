/* PageLens — lib/trackers.js
 *
 * A small bundled list of well-known third-party domains: who runs them and
 * what they are for. Matching is by domain suffix (a.b.example.com matches
 * example.com). Hosts not in the list are reported as "Unknown" — not as bad.
 *
 * Categories:
 *   advertising, analytics, recording (session replay), tags (tag managers),
 *   social, support, consent, monitoring, payments, captcha, cdn, fonts,
 *   video, maps, hosting, other
 */
(function (root) {
  'use strict';

  const CATEGORIES = {
    advertising: { label: 'Advertising', tracking: true, plain: 'Shows ads and builds interest profiles across sites' },
    analytics: { label: 'Analytics', tracking: true, plain: 'Counts visits and records what you click' },
    recording: { label: 'Session recording', tracking: true, plain: 'Can replay your mouse movements, scrolling and typing' },
    tags: { label: 'Tag manager', tracking: true, plain: 'Loads other tracking scripts chosen by the site' },
    social: { label: 'Social media', tracking: true, plain: 'Lets the social network know you visited' },
    support: { label: 'Chat & support', tracking: false, plain: 'Live chat or help widgets' },
    consent: { label: 'Cookie consent', tracking: false, plain: 'Asks for and stores your cookie choices' },
    monitoring: { label: 'Error monitoring', tracking: false, plain: 'Reports errors and slow pages to the developers' },
    payments: { label: 'Payments', tracking: false, plain: 'Handles card payments' },
    captcha: { label: 'Bot protection', tracking: false, plain: 'Checks that you are human' },
    cdn: { label: 'Content delivery', tracking: false, plain: 'Serves files such as scripts and images' },
    fonts: { label: 'Fonts', tracking: false, plain: 'Serves web fonts' },
    video: { label: 'Video', tracking: false, plain: 'Embedded video players' },
    maps: { label: 'Maps', tracking: false, plain: 'Embedded maps' },
    hosting: { label: 'Hosting & cloud', tracking: false, plain: 'Cloud storage and hosting' },
    other: { label: 'Other services', tracking: false, plain: '' }
  };

  // [domain, company, category]
  const LIST = [
    // Google
    ['google-analytics.com', 'Google', 'analytics'], ['analytics.google.com', 'Google', 'analytics'], ['googletagmanager.com', 'Google', 'tags'],
    ['doubleclick.net', 'Google', 'advertising'], ['googlesyndication.com', 'Google', 'advertising'], ['googleadservices.com', 'Google', 'advertising'],
    ['adservice.google.com', 'Google', 'advertising'], ['googletagservices.com', 'Google', 'advertising'], ['2mdn.net', 'Google', 'advertising'],
    ['fonts.googleapis.com', 'Google', 'fonts'], ['fonts.gstatic.com', 'Google', 'fonts'], ['ajax.googleapis.com', 'Google', 'cdn'],
    ['gstatic.com', 'Google', 'cdn'], ['recaptcha.net', 'Google', 'captcha'], ['youtube.com', 'Google (YouTube)', 'video'],
    ['youtube-nocookie.com', 'Google (YouTube)', 'video'], ['ytimg.com', 'Google (YouTube)', 'video'], ['googlevideo.com', 'Google (YouTube)', 'video'],
    ['maps.googleapis.com', 'Google', 'maps'], ['storage.googleapis.com', 'Google Cloud', 'hosting'], ['firebaseio.com', 'Google Firebase', 'hosting'],
    ['firebaseapp.com', 'Google Firebase', 'hosting'], ['googleapis.com', 'Google', 'other'],
    // Meta
    ['facebook.net', 'Meta', 'social'], ['facebook.com', 'Meta', 'social'], ['fbcdn.net', 'Meta', 'social'], ['instagram.com', 'Meta', 'social'], ['cdninstagram.com', 'Meta', 'social'],
    // Microsoft
    ['clarity.ms', 'Microsoft Clarity', 'recording'], ['bat.bing.com', 'Microsoft Ads', 'advertising'], ['bing.com', 'Microsoft', 'advertising'],
    ['linkedin.com', 'LinkedIn', 'social'], ['licdn.com', 'LinkedIn', 'social'], ['ads.linkedin.com', 'LinkedIn', 'advertising'],
    ['azureedge.net', 'Microsoft Azure', 'cdn'], ['blob.core.windows.net', 'Microsoft Azure', 'hosting'],
    // Other social / ad networks
    ['twitter.com', 'X (Twitter)', 'social'], ['x.com', 'X (Twitter)', 'social'], ['twimg.com', 'X (Twitter)', 'social'], ['ads-twitter.com', 'X (Twitter)', 'advertising'],
    ['tiktok.com', 'TikTok', 'social'], ['analytics.tiktok.com', 'TikTok', 'advertising'], ['snapchat.com', 'Snap', 'advertising'], ['sc-static.net', 'Snap', 'advertising'],
    ['pinterest.com', 'Pinterest', 'social'], ['pinimg.com', 'Pinterest', 'social'], ['reddit.com', 'Reddit', 'social'], ['redditstatic.com', 'Reddit', 'advertising'],
    ['criteo.com', 'Criteo', 'advertising'], ['criteo.net', 'Criteo', 'advertising'], ['taboola.com', 'Taboola', 'advertising'], ['outbrain.com', 'Outbrain', 'advertising'],
    ['adnxs.com', 'Xandr', 'advertising'], ['amazon-adsystem.com', 'Amazon Ads', 'advertising'], ['rubiconproject.com', 'Magnite', 'advertising'],
    ['pubmatic.com', 'PubMatic', 'advertising'], ['openx.net', 'OpenX', 'advertising'], ['casalemedia.com', 'Index Exchange', 'advertising'],
    ['adsrvr.org', 'The Trade Desk', 'advertising'], ['quantserve.com', 'Quantcast', 'advertising'], ['scorecardresearch.com', 'Comscore', 'analytics'],
    ['moatads.com', 'Oracle Moat', 'advertising'], ['media.net', 'Media.net', 'advertising'], ['adform.net', 'Adform', 'advertising'],
    ['bidswitch.net', 'BidSwitch', 'advertising'], ['smartadserver.com', 'Equativ', 'advertising'], ['sharethrough.com', 'Sharethrough', 'advertising'],
    ['teads.tv', 'Teads', 'advertising'], ['yandex.ru', 'Yandex', 'analytics'], ['mc.yandex.ru', 'Yandex Metrica', 'analytics'], ['yandex.net', 'Yandex', 'cdn'],
    ['baidu.com', 'Baidu', 'analytics'], ['hm.baidu.com', 'Baidu Analytics', 'analytics'],
    // Analytics / product analytics
    ['segment.com', 'Segment', 'analytics'], ['segment.io', 'Segment', 'analytics'], ['mixpanel.com', 'Mixpanel', 'analytics'], ['amplitude.com', 'Amplitude', 'analytics'],
    ['heap.io', 'Heap', 'analytics'], ['heapanalytics.com', 'Heap', 'analytics'], ['plausible.io', 'Plausible', 'analytics'], ['usefathom.com', 'Fathom', 'analytics'],
    ['matomo.cloud', 'Matomo', 'analytics'], ['posthog.com', 'PostHog', 'analytics'], ['i.posthog.com', 'PostHog', 'analytics'], ['simpleanalyticscdn.com', 'Simple Analytics', 'analytics'],
    ['chartbeat.com', 'Chartbeat', 'analytics'], ['newrelic.com', 'New Relic', 'monitoring'], ['nr-data.net', 'New Relic', 'monitoring'],
    ['hubspot.com', 'HubSpot', 'analytics'], ['hs-scripts.com', 'HubSpot', 'analytics'], ['hs-analytics.net', 'HubSpot', 'analytics'], ['hsforms.com', 'HubSpot', 'support'],
    ['marketo.net', 'Adobe Marketo', 'analytics'], ['omtrdc.net', 'Adobe Analytics', 'analytics'], ['demdex.net', 'Adobe Audience Manager', 'advertising'],
    ['adobedtm.com', 'Adobe Launch', 'tags'], ['typekit.net', 'Adobe Fonts', 'fonts'], ['kissmetrics.io', 'Kissmetrics', 'analytics'],
    ['vercel-insights.com', 'Vercel Analytics', 'analytics'], ['cloudflareinsights.com', 'Cloudflare Web Analytics', 'analytics'],
    // Session recording
    ['hotjar.com', 'Hotjar', 'recording'], ['hotjar.io', 'Hotjar', 'recording'], ['fullstory.com', 'FullStory', 'recording'], ['logrocket.io', 'LogRocket', 'recording'],
    ['lr-ingest.io', 'LogRocket', 'recording'], ['mouseflow.com', 'Mouseflow', 'recording'], ['smartlook.com', 'Smartlook', 'recording'], ['inspectlet.com', 'Inspectlet', 'recording'],
    ['crazyegg.com', 'Crazy Egg', 'recording'], ['luckyorange.com', 'Lucky Orange', 'recording'], ['contentsquare.net', 'Contentsquare', 'recording'],
    // Tag managers
    ['tealiumiq.com', 'Tealium', 'tags'], ['ensighten.com', 'Ensighten', 'tags'],
    // Support
    ['intercom.io', 'Intercom', 'support'], ['intercomcdn.com', 'Intercom', 'support'], ['zendesk.com', 'Zendesk', 'support'], ['zdassets.com', 'Zendesk', 'support'],
    ['drift.com', 'Drift', 'support'], ['crisp.chat', 'Crisp', 'support'], ['tawk.to', 'tawk.to', 'support'], ['livechatinc.com', 'LiveChat', 'support'],
    ['freshchat.com', 'Freshworks', 'support'], ['tidio.co', 'Tidio', 'support'],
    // Consent
    ['cookielaw.org', 'OneTrust', 'consent'], ['onetrust.com', 'OneTrust', 'consent'], ['cookiebot.com', 'Cookiebot', 'consent'], ['usercentrics.eu', 'Usercentrics', 'consent'],
    ['consensu.org', 'IAB consent', 'consent'], ['trustarc.com', 'TrustArc', 'consent'], ['quantcast.mgr.consensu.org', 'Quantcast Choice', 'consent'],
    // Monitoring
    ['sentry.io', 'Sentry', 'monitoring'], ['sentry-cdn.com', 'Sentry', 'monitoring'], ['bugsnag.com', 'Bugsnag', 'monitoring'], ['datadoghq.com', 'Datadog', 'monitoring'],
    ['browser-intake-datadoghq.com', 'Datadog', 'monitoring'], ['rollbar.com', 'Rollbar', 'monitoring'],
    // Payments / captcha
    ['stripe.com', 'Stripe', 'payments'], ['stripe.network', 'Stripe', 'payments'], ['paypal.com', 'PayPal', 'payments'], ['paypalobjects.com', 'PayPal', 'payments'],
    ['braintreegateway.com', 'Braintree', 'payments'], ['razorpay.com', 'Razorpay', 'payments'], ['adyen.com', 'Adyen', 'payments'], ['klarna.com', 'Klarna', 'payments'],
    ['hcaptcha.com', 'hCaptcha', 'captcha'], ['challenges.cloudflare.com', 'Cloudflare Turnstile', 'captcha'],
    // CDNs / hosting
    ['cloudflare.com', 'Cloudflare', 'cdn'], ['cdnjs.cloudflare.com', 'Cloudflare cdnjs', 'cdn'], ['jsdelivr.net', 'jsDelivr', 'cdn'], ['unpkg.com', 'unpkg', 'cdn'],
    ['jquery.com', 'jQuery CDN', 'cdn'], ['bootstrapcdn.com', 'BootstrapCDN', 'cdn'], ['fontawesome.com', 'Font Awesome', 'fonts'], ['akamaihd.net', 'Akamai', 'cdn'],
    ['akamaized.net', 'Akamai', 'cdn'], ['fastly.net', 'Fastly', 'cdn'], ['cloudfront.net', 'Amazon CloudFront', 'cdn'], ['amazonaws.com', 'Amazon Web Services', 'hosting'],
    ['shopify.com', 'Shopify', 'hosting'], ['shopifycdn.com', 'Shopify', 'cdn'], ['wixstatic.com', 'Wix', 'cdn'], ['parastorage.com', 'Wix', 'cdn'],
    ['squarespace.com', 'Squarespace', 'hosting'], ['squarespace-cdn.com', 'Squarespace', 'cdn'], ['website-files.com', 'Webflow', 'cdn'], ['webflow.com', 'Webflow', 'hosting'],
    ['wp.com', 'WordPress.com', 'cdn'], ['gravatar.com', 'Gravatar', 'other'], ['githubusercontent.com', 'GitHub', 'cdn'], ['github.io', 'GitHub Pages', 'hosting'],
    ['imgix.net', 'imgix', 'cdn'], ['cloudinary.com', 'Cloudinary', 'cdn'], ['vimeo.com', 'Vimeo', 'video'], ['vimeocdn.com', 'Vimeo', 'video'], ['wistia.com', 'Wistia', 'video'],
    ['mapbox.com', 'Mapbox', 'maps'], ['openstreetmap.org', 'OpenStreetMap', 'maps'], ['typeform.com', 'Typeform', 'other'], ['calendly.com', 'Calendly', 'other'],
    ['disqus.com', 'Disqus', 'social'], ['disquscdn.com', 'Disqus', 'social'], ['addthis.com', 'AddThis', 'social'], ['sharethis.com', 'ShareThis', 'social']
  ];

  // Longest suffix wins (maps.googleapis.com before googleapis.com).
  const SORTED = [...LIST].sort((a, b) => b[0].length - a[0].length);

  function lookup(host) {
    host = String(host || '').toLowerCase().replace(/\.$/, '');
    for (const [domain, company, category] of SORTED) {
      if (host === domain || host.endsWith('.' + domain)) return { domain, company, category, ...CATEGORIES[category] };
    }
    return null;
  }

  /** Group third-party hosts from a scan by company and category. */
  function classify(hosts) {
    const companies = new Map();
    const unknown = [];
    for (const h of hosts) {
      const hit = lookup(h.host);
      if (!hit) { unknown.push(h); continue; }
      const key = hit.company;
      const c = companies.get(key) || { company: hit.company, categories: new Set(), hosts: [], requests: 0, bytes: 0, tracking: false };
      c.categories.add(hit.category);
      c.hosts.push(h.host);
      c.requests += h.count || 0;
      c.bytes += h.bytes || 0;
      c.tracking = c.tracking || hit.tracking;
      companies.set(key, c);
    }
    const list = [...companies.values()].map((c) => ({ ...c, categories: [...c.categories].sort(), hosts: [...new Set(c.hosts)].sort() }))
      .sort((a, b) => Number(b.tracking) - Number(a.tracking) || b.requests - a.requests || a.company.localeCompare(b.company));
    const byCategory = {};
    for (const c of list) for (const cat of c.categories) (byCategory[cat] = byCategory[cat] || []).push(c.company);
    return { companies: list, unknown: unknown.sort((a, b) => b.count - a.count || a.host.localeCompare(b.host)), byCategory, trackingCount: list.filter((c) => c.tracking).length };
  }

  root.PageLensTrackers = Object.freeze({ lookup, classify, CATEGORIES, size: LIST.length });
})(globalThis);
