// Navigation menu extraction. Runs both in the popup (on fetched HTML) and injected
// into the page via chrome.scripting, so it must stay self-contained.
// Exposes a global `Nav` object.
(function (global) {
  'use strict';

  const CANDIDATES = [
    'nav', '[role="navigation"]', '.main-navigation', '#site-navigation', '#primary-menu',
    '.primary-menu', '.wp-block-navigation', '.elementor-nav-menu', '#top-menu', '.menu',
  ].join(',');
  const GOOD = /main|primary|top-menu|site-nav|navbar|header-menu|menu-main/i;
  const BAD = /breadcrumb|social|footer|pagination|share|lang|cart|account|skip|search|widget|sidebar|secondary|utility|top-?bar/i;
  const ASSET = /\.(jpe?g|png|gif|webp|avif|svg|pdf|zip|mp3|mp4|webm|docx?|xlsx?|pptx?)$/i;
  const NOISE = /\/wp-(admin|login|content|json)\b|\/feed\/?$|[?&](replytocom|share)=/i;
  const MAX_LABEL = 80;
  const MAX_CONTENT_LINKS = 60;     // per page, for deep scan
  const CONCURRENCY = 4;
  const TIMEOUT_MS = 20000;

  const bareHost = host => host.replace(/^www\./i, '').toLowerCase();
  const clean = s => (s || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);

  // Resolves an href to a same-site page URL without its #hash, or null.
  function pageUrl(href, base) {
    if (!href || href.startsWith('#')) return null;
    let url;
    try { url = new URL(href, base); } catch (_) { return null; }
    if (!/^https?:$/.test(url.protocol)) return null;
    if (bareHost(url.host) !== bareHost(new URL(base).host)) return null;
    if (ASSET.test(url.pathname) || NOISE.test(url.href)) return null;
    url.hash = '';
    return url.href;
  }

  function describe(el) {
    return el ? [el.id, el.getAttribute('class'), el.getAttribute('aria-label')].join(' ') : '';
  }

  // Higher is more likely to be the site's main menu.
  function score(el, base) {
    const links = [...el.querySelectorAll('a[href]')]
      .filter(a => pageUrl(a.getAttribute('href'), base)).length;
    if (links < 2) return -Infinity;

    let s = Math.min(links, 40);
    if (links > 150) s -= 30;                           // a whole-page wrapper, not a menu
    if (el.closest('header, [role="banner"], #masthead, .site-header')) s += 30;
    if (el.closest('footer, [role="contentinfo"], .site-footer, aside')) s -= 50;
    const text = describe(el) + ' ' + describe(el.parentElement);
    if (GOOD.test(text)) s += 20;
    if (BAD.test(text)) s -= 40;
    if (el.querySelector('li ul, li ol')) s += 10;      // has dropdowns
    if (!el.getClientRects().length) s -= 15;           // hidden (e.g. mobile copy); no-op on fetched HTML
    return s;
  }

  // Lists in el that are not nested inside another list in el.
  function topLists(el) {
    if (el.tagName === 'UL' || el.tagName === 'OL') return [el];
    return [...el.querySelectorAll('ul, ol')].filter(list => {
      const outer = list.parentElement.closest('ul, ol');
      return !outer || !el.contains(outer);
    });
  }

  // Submenu lists that belong directly to this <li>.
  function ownLists(li) {
    return [...li.querySelectorAll('ul, ol')].filter(list => list.parentElement.closest('li') === li);
  }

  function ownAnchors(li) {
    return [...li.querySelectorAll('a[href]')].filter(a => a.closest('li') === li);
  }

  function anchorLabel(a) {
    return clean(a.textContent) || clean(a.getAttribute('aria-label')) || clean(a.getAttribute('title'));
  }

  // Submenu headings are often a <button> or <span> rather than a link.
  function headingLabel(li) {
    for (const c of li.children) {
      if (c.tagName === 'UL' || c.tagName === 'OL' || c.querySelector('ul, ol')) continue;
      const t = clean(c.textContent);
      if (t) return t;
    }
    return '';
  }

  function parseItems(lists, base) {
    const items = [];
    for (const list of lists) {
      for (const li of list.children) {
        if (li.tagName !== 'LI') continue;
        const [a, ...rest] = ownAnchors(li);
        const href = a ? a.getAttribute('href') || '' : '';
        const url = a ? pageUrl(href, base) : null;

        let children = parseItems(ownLists(li), base);
        // Bootstrap-style dropdowns: extra links in a <div> instead of a nested list.
        if (!children.length && rest.length) {
          children = rest
            .map(r => ({ label: anchorLabel(r), url: pageUrl(r.getAttribute('href'), base), children: [] }))
            .filter(c => c.url);
        }

        const external = a && !url && href && !href.startsWith('#');
        if ((external || !url) && !children.length) continue;   // mailto:, other sites, empty "#"
        items.push({ label: (a && anchorLabel(a)) || headingLabel(li), url, children });
      }
    }
    return items;
  }

  // Finds the site's main menu in doc. Returns { items, where } or null, where
  // items is [{ label, url|null, children }] in menu order.
  function extractMenu(doc, base) {
    let best = null;
    let bestScore = -Infinity;
    for (const el of doc.querySelectorAll(CANDIDATES)) {
      const s = score(el, base);
      if (s > bestScore) { best = el; bestScore = s; }
    }
    if (!best) return null;

    const lists = topLists(best);
    const items = lists.length
      ? parseItems(lists, base)
      : [...best.querySelectorAll('a[href]')]
        .map(a => ({ label: anchorLabel(a), url: pageUrl(a.getAttribute('href'), base), children: [] }))
        .filter(i => i.url);
    if (!items.length) return null;

    const where = best.tagName.toLowerCase() + (best.id ? '#' + best.id : '');
    return { items, where };
  }

  // Same-site links in the main content of a document (header, footer, menus and
  // sidebars excluded).
  function contentLinks(doc, base) {
    const scope = doc.querySelector('main, [role="main"], article, .entry-content, #content, .site-content') || doc.body;
    if (!scope) return [];
    const seen = new Set([pageUrl(base, base)]);
    const out = [];
    for (const a of scope.querySelectorAll('a[href]')) {
      if (a.closest('header, footer, nav, aside, [role="navigation"], .breadcrumb, .breadcrumbs, .sidebar, .widget, #comments')) continue;
      const url = pageUrl(a.getAttribute('href'), base);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ label: anchorLabel(a), url, children: [] });
      if (out.length >= MAX_CONTENT_LINKS) break;
    }
    return out;
  }

  async function fetchDoc(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', redirect: 'follow' });
      if (!res.ok || !(res.headers.get('content-type') || '').includes('html')) return null;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      return { doc, base: res.url || url };
    } finally {
      clearTimeout(timer);
    }
  }

  // Fetches the home page and extracts its menu (fallback when the live tab can't be read).
  async function fetchMenu(origin) {
    try {
      const got = await fetchDoc(origin + '/');
      return got && extractMenu(got.doc, got.base);
    } catch (_) {
      return null;
    }
  }

  // Deep scan: fetches each page and collects links from its content.
  // Returns Map(pageUrl -> [{ label, url, children: [] }]).
  async function scanPages(urls, onProgress) {
    const found = new Map();
    const queue = [...urls];
    let done = 0;
    async function worker() {
      while (queue.length) {
        const url = queue.shift();
        try {
          const got = await fetchDoc(url);
          if (got) found.set(url, contentLinks(got.doc, got.base));
        } catch (_) { /* skip pages that fail or time out */ }
        onProgress?.(`Deep scan: ${++done} of ${urls.length} main pages…`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
    return found;
  }

  global.Nav = { extractMenu, fetchMenu, contentLinks, scanPages };
})(globalThis);
