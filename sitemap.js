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

  // Builds a hierarchy from page URLs. Sitemaps carry no parent/child data, so the
  // structure comes from URL paths: root -> host -> path segments (-> ?query).
  // Path levels with no URL of their own become virtual nodes (page: null).
  // Node: { name, href, parent, depth, page, children: [], total } where depth is 0
  // for hosts and total counts pages in the subtree including the node itself.
  // Returns { root, nodeOf } with nodeOf mapping each loc to its node.
  function buildTree(urls) {
    const makeNode = (name, href, parent) => ({
      name, href, parent, depth: parent ? parent.depth + 1 : -1,
      page: null, children: new Map(), total: 0,
    });
    const root = makeNode('', '', null);
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
          child = makeNode(i === 0 ? seg : decodeSegment(seg), href, node);
          node.children.set(seg, child);
        }
        node = child;
      });
      // "/about" and "/about/" land on the same node; the first one wins.
      if (!node.page) {
        node.page = u;
        node.href = u.loc;
      }
      nodeOf.set(u.loc, node);
    }

    (function finish(node) {
      node.children = [...node.children.values()]
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      node.total = node.page ? 1 : 0;
      for (const c of node.children) node.total += finish(c);
      return node.total;
    })(root);

    return { root, nodeOf };
  }

  global.Sitemap = { discover, crawl, parse, buildTree };
})(globalThis);
