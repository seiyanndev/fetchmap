// Sitemap discovery, fetching and parsing. Exposes a global `Sitemap` object.
(function (global) {
  'use strict';

  const COMMON_PATHS = [
    '/sitemap.xml',
    '/sitemap_index.xml',
    '/sitemap-index.xml',
    '/wp-sitemap.xml',
    '/sitemap.php',
    '/sitemap.txt',
    '/sitemap.xml.gz',
  ];

  const MAX_SITEMAPS = 200;      // hard cap on child sitemaps followed
  const CONCURRENCY = 4;
  const TIMEOUT_MS = 30000;

  async function fetchWithTimeout(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { signal: ctrl.signal, credentials: 'omit', redirect: 'follow' });
    } finally {
      clearTimeout(timer);
    }
  }

  // Returns response body as text, transparently gunzipping raw .gz payloads.
  async function readBody(res) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
      return await new Response(stream).text();
    }
    return new TextDecoder('utf-8').decode(buf);
  }

  function childText(el, name) {
    for (const c of el.children) {
      if (c.localName === name) return c.textContent.trim();
    }
    return '';
  }

  // Parses a sitemap body. Returns { type: 'index'|'urlset'|'text', entries: [{loc, lastmod}] }
  // or null if the body is not a sitemap (e.g. an HTML soft-404 page).
  function parse(body) {
    const trimmed = body.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('<')) {
      const doc = new DOMParser().parseFromString(trimmed, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) return null;
      const root = doc.documentElement;
      let type, itemName;
      if (root.localName === 'sitemapindex') { type = 'index'; itemName = 'sitemap'; }
      else if (root.localName === 'urlset') { type = 'urlset'; itemName = 'url'; }
      else return null;

      const entries = [];
      for (const item of root.children) {
        if (item.localName !== itemName) continue;
        const loc = childText(item, 'loc');
        if (loc) entries.push({ loc, lastmod: childText(item, 'lastmod') });
      }
      return { type, entries };
    }

    // Plain-text sitemap: one absolute URL per line.
    const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length && lines.every(l => /^https?:\/\//i.test(l))) {
      return { type: 'text', entries: lines.map(loc => ({ loc, lastmod: '' })) };
    }
    return null;
  }

  async function fetchSitemap(url) {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parse(await readBody(res));
    if (!parsed) throw new Error('Not a valid sitemap');
    return parsed;
  }

  // Reads robots.txt and returns any declared Sitemap: URLs.
  async function sitemapsFromRobots(origin) {
    try {
      const res = await fetchWithTimeout(origin + '/robots.txt');
      if (!res.ok) return [];
      const text = await res.text();
      const found = [];
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
        if (m) {
          try { found.push(new URL(m[1], origin).href); } catch (_) { /* skip malformed */ }
        }
      }
      return found;
    } catch (_) {
      return [];
    }
  }

  // Finds root sitemap URLs for an origin: robots.txt first, then common paths.
  async function discover(origin, onProgress) {
    onProgress?.('Checking robots.txt…');
    const fromRobots = await sitemapsFromRobots(origin);
    if (fromRobots.length) return [...new Set(fromRobots)];

    for (const path of COMMON_PATHS) {
      const url = origin + path;
      onProgress?.(`Trying ${path}…`);
      try {
        await fetchSitemap(url);
        return [url];
      } catch (_) { /* try next */ }
    }
    return [];
  }

  // Crawls root sitemaps (following sitemap indexes) and collects all page URLs.
  // Returns { urls: [{loc, lastmod, source}], sitemaps: [{url, count, error}] }
  async function crawl(roots, onProgress) {
    const queue = [...roots];
    const seen = new Set(roots);
    const sitemaps = [];
    const urls = new Map();
    let active = 0;

    async function worker() {
      while (queue.length) {
        const url = queue.shift();
        active++;
        onProgress?.(`Fetching ${sitemaps.length + active} of ${seen.size} sitemaps · ${urls.size} URLs`);
        const record = { url, count: 0, error: '' };
        try {
          const { type, entries } = await fetchSitemap(url);
          if (type === 'index') {
            for (const e of entries) {
              let child;
              try { child = new URL(e.loc, url).href; } catch (_) { continue; }
              if (!seen.has(child) && seen.size < MAX_SITEMAPS) {
                seen.add(child);
                queue.push(child);
              }
            }
            record.count = entries.length;
            record.isIndex = true;
          } else {
            for (const e of entries) {
              if (!urls.has(e.loc)) urls.set(e.loc, { ...e, source: url });
            }
            record.count = entries.length;
          }
        } catch (err) {
          record.error = err.name === 'AbortError' ? 'Timed out' : err.message;
        }
        sitemaps.push(record);
        active--;
      }
    }

    // Workers exit when the queue is momentarily empty, so keep spawning until
    // nothing is in flight and nothing is queued (index fetches enqueue children).
    while (queue.length) {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    }

    return { urls: [...urls.values()], sitemaps, capped: seen.size >= MAX_SITEMAPS };
  }

  function decodeSegment(s) {
    try { return decodeURIComponent(s); } catch (_) { return s; }
  }

  // Tree node shared by both tree sources:
  //   name    display label (path segment, menu text or host)
  //   href    URL this level stands for (constructed for virtual path levels)
  //   link    URL to open, or '' for virtual levels and label-only menu headings
  //   page    the sitemap entry for this node, or null if it is not in the sitemap
  //   inNav   true if the node is in the site's main navigation menu
  //   source  'path' (from URL paths), 'nav' (menu) or 'content' (deep scan)
  //   order   menu position; path-derived children sort by name after menu items
  //   group   true for the "Not in navigation" bucket
  // finishTree() then sets depth (0 = top level), sorted children and total
  // (sitemap pages in the subtree, including the node itself).
  function makeNode(name, parent, extra) {
    return {
      name, parent, href: '', link: '', page: null, inNav: false, source: 'path',
      order: Infinity, group: false, depth: 0, children: new Map(), total: 0, ...extra,
    };
  }

  function setPage(node, u) {
    if (node.page) return;          // "/about" and "/about/" share a node; first wins
    node.page = u;
    node.link = u.loc;
    if (!node.href) node.href = u.loc;
  }

  function finishTree(root) {
    (function finish(node, depth) {
      node.depth = depth;
      node.children = [...node.children.values()].sort((a, b) =>
        a.order - b.order || a.name.localeCompare(b.name, undefined, { numeric: true }));
      node.total = node.page ? 1 : 0;
      for (const c of node.children) node.total += finish(c, depth + 1);
      return node.total;
    })(root, -1);
  }

  // Builds a hierarchy from page URLs alone. Sitemaps carry no parent/child data, so
  // the structure comes from URL paths: root -> host -> path segments (-> ?query).
  // Returns { root, nodeOf } with nodeOf mapping each loc to its node.
  function buildTree(urls) {
    const root = makeNode('', null);
    const nodeOf = new Map();

    for (const u of urls) {
      let url;
      try { url = new URL(u.loc); } catch (_) { continue; }
      const segs = [url.host, ...url.pathname.split('/').filter(Boolean)];
      if (url.search) segs.push(url.search);

      let node = root;
      let href = '';
      segs.forEach((seg, i) => {
        href = i === 0 ? url.origin + '/' : href + seg + '/';
        let child = node.children.get(seg);
        if (!child) {
          child = makeNode(i === 0 ? seg : decodeSegment(seg), node, { href });
          node.children.set(seg, child);
        }
        node = child;
      });
      setPage(node, u);
      nodeOf.set(u.loc, node);
    }

    finishTree(root);
    return { root, nodeOf };
  }

  const bareHost = host => host.replace(/^www\./i, '').toLowerCase();

  // Identity of a page that ignores http/https, www. and trailing slashes.
  function pageKey(url) {
    return bareHost(url.host) + url.pathname.replace(/\/+$/, '') + url.search;
  }

  // pageKey() of the first n segments, where segs may end with a "?query" segment.
  function prefixKey(host, segs, n) {
    const parts = segs.slice(0, n);
    const query = parts.length && parts[parts.length - 1].startsWith('?') ? parts.pop() : '';
    return host + (parts.length ? '/' + parts.join('/') : '') + query;
  }

  // Builds the tree from the site's main menu, then places every sitemap URL under it:
  //   root -> site (home page) -> menu items (in menu order) -> dropdown items
  // contentLinks (optional) maps a menu page URL to links found inside that page.
  // A sitemap URL goes to the menu node with the same address, else under the menu
  // node with the longest matching path prefix, else into "Not in navigation".
  // Menu items: [{ label, url|null, children }]. Returns { root, nodeOf }.
  function buildNavTree(menuItems, urls, origin, contentLinks) {
    const site = new URL(origin);
    const siteHost = bareHost(site.host);
    const root = makeNode('', null);
    const home = makeNode(site.hostname, root, { href: site.origin + '/', link: site.origin + '/', order: 0 });
    root.children.set('site', home);

    const index = new Map([[pageKey(site), home]]);   // pageKey -> node
    const nodeOf = new Map();
    let seq = 0;

    function addLinked(parent, item, source) {
      let url = null;
      try { if (item.url) url = new URL(item.url); } catch (_) { /* label only */ }
      const key = url && pageKey(url);
      let node = key && index.get(key);
      if (node) {
        if (source === 'nav') node.inNav = true;
      } else {
        const name = item.label ||
          (url ? decodeSegment(url.pathname.split('/').filter(Boolean).pop() || url.hostname) : '(untitled)');
        node = makeNode(name, parent, {
          href: url ? url.href : '', link: url ? url.href : '',
          inNav: source === 'nav', source, order: seq++,
        });
        parent.children.set('item' + node.order, node);
        if (key) index.set(key, node);
      }
      for (const c of item.children || []) addLinked(node, c, source);
      return node;
    }

    for (const item of menuItems) addLinked(home, item, 'nav');
    if (contentLinks) {
      for (const [pageUrl, links] of contentLinks) {
        let parent;
        try { parent = index.get(pageKey(new URL(pageUrl))); } catch (_) { continue; }
        if (parent) for (const l of links) addLinked(parent, l, 'content');
      }
    }

    const unlisted = makeNode('Not in navigation', home, { group: true, order: Number.MAX_SAFE_INTEGER });
    home.children.set('unlisted', unlisted);

    for (const u of urls) {
      let url;
      try { url = new URL(u.loc); } catch (_) { continue; }
      let node = index.get(pageKey(url));
      if (!node) {
        const host = bareHost(url.host);
        const segs = url.pathname.split('/').filter(Boolean);
        if (url.search) segs.push(url.search);

        // Deepest existing ancestor. The home page is skipped on purpose, otherwise
        // every page would count as being "under" it.
        let start = 0;
        let parent = null;
        for (let n = segs.length - 1; n > 0; n--) {
          parent = index.get(prefixKey(host, segs, n));
          if (parent) { start = n; break; }
        }
        if (!parent) {
          parent = unlisted;
          if (host !== siteHost) {
            const hostKey = 'host:' + host;
            if (!unlisted.children.has(hostKey)) {
              unlisted.children.set(hostKey, makeNode(url.hostname, unlisted, { href: url.origin + '/' }));
            }
            parent = unlisted.children.get(hostKey);
          }
        }

        node = parent;
        for (let j = start; j < segs.length; j++) {
          const seg = segs[j];
          let child = node.children.get('seg:' + seg);
          if (!child) {
            const href = url.origin + '/' + segs.slice(0, j + 1).join('/') + '/';
            child = makeNode(decodeSegment(seg), node, { href });
            node.children.set('seg:' + seg, child);
            index.set(prefixKey(host, segs, j + 1), child);
          }
          node = child;
        }
      }
      setPage(node, u);
      nodeOf.set(u.loc, node);
    }

    if (!unlisted.children.size) home.children.delete('unlisted');
    finishTree(root);
    return { root, nodeOf };
  }

  global.Sitemap = { discover, crawl, parse, buildTree, buildNavTree };
})(globalThis);
