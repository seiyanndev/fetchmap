'use strict';

const RENDER_LIMIT = 1000;          // max rows rendered per list / per tree level
const TREE_EXPAND_LIMIT = 3000;     // max pages "Expand all" will render
const FILTER_EXPAND_LIMIT = 50;     // auto-expand filtered branches with at most this many matches
const DIAGRAM_LIMIT = 1500;         // max boxes in an exported diagram
const PREFS_KEY = 'fetchmap.prefs';

const $ = id => document.getElementById(id);
const els = {
  origin: $('origin'),
  form: $('manual-form'),
  manualUrl: $('manual-url'),
  fetchBtn: $('fetch-btn'),
  status: $('status'),
  sitemapsSection: $('sitemaps-section'),
  sitemapCount: $('sitemap-count'),
  sitemapList: $('sitemap-list'),
  results: $('results'),
  filter: $('filter'),
  urlCount: $('url-count'),
  urlList: $('url-list'),
  urlTree: $('url-tree'),
  viewList: $('view-list'),
  viewTree: $('view-tree'),
  treeTools: $('tree-tools'),
  srcNav: $('src-nav'),
  srcPath: $('src-path'),
  navOptions: $('nav-options'),
  deepScan: $('deep-scan'),
};

let origin = '';          // origin of the active tab
let siteOrigin = '';      // origin of the site being mapped
let tabId = null;
let allUrls = [];
let navMenu = null;       // { items, where } from Nav.extractMenu, or null
let contentLinks = null;  // deep scan results: Map(pageUrl -> links)
let navTree = null;       // built lazily; reset whenever their inputs change
let pathTree = null;
let openNodes = new Set();  // tree nodes currently expanded, used by the diagram export

const prefs = { view: 'list', source: 'nav', deep: false };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch (_) { /* storage unavailable */ }

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) { /* storage unavailable */ }
}

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = 'status' + (kind ? ' ' + kind : '');
}

function filterQuery() {
  return els.filter.value.trim().toLowerCase();
}

function filteredUrls() {
  const q = filterQuery();
  return q ? allUrls.filter(u => u.loc.toLowerCase().includes(q)) : allUrls;
}

function activeSource() {
  return prefs.source === 'nav' && navMenu ? 'nav' : 'path';
}

function render() {
  const count = filteredUrls().length;
  els.urlCount.textContent = count === allUrls.length
    ? `${allUrls.length} URLs`
    : `${count} of ${allUrls.length} URLs`;

  const isTree = prefs.view === 'tree';
  const source = activeSource();
  els.viewList.setAttribute('aria-pressed', String(!isTree));
  els.viewTree.setAttribute('aria-pressed', String(isTree));
  els.srcNav.setAttribute('aria-pressed', String(source === 'nav'));
  els.srcPath.setAttribute('aria-pressed', String(source === 'path'));
  els.srcNav.disabled = !navMenu;
  els.srcNav.title = navMenu
    ? `Main navigation menu (${navMenu.where}), with sitemap pages placed under it`
    : 'No navigation menu found on this site';
  els.deepScan.checked = prefs.deep;

  els.urlList.hidden = isTree;
  els.urlTree.hidden = !isTree;
  els.treeTools.hidden = !isTree;
  els.navOptions.hidden = !isTree || source !== 'nav';
  for (const b of document.querySelectorAll('.tree-only')) b.hidden = !isTree;

  if (isTree) renderTree();
  else renderUrls();
}

function renderUrls() {
  const list = filteredUrls();
  const frag = document.createDocumentFragment();
  for (const u of list.slice(0, RENDER_LIMIT)) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = u.loc;
    a.textContent = u.loc;
    a.target = '_blank';
    a.rel = 'noopener';
    li.appendChild(a);
    if (u.lastmod) {
      const span = document.createElement('span');
      span.className = 'lastmod';
      span.textContent = u.lastmod.slice(0, 10);
      span.title = u.lastmod;
      li.appendChild(span);
    }
    frag.appendChild(li);
  }
  if (list.length > RENDER_LIMIT) {
    const li = document.createElement('li');
    li.className = 'more';
    li.textContent = `…${list.length - RENDER_LIMIT} more (filter to narrow, or export for the full list)`;
    frag.appendChild(li);
  }
  els.urlList.replaceChildren(frag);
}

// ---- Tree ----

function getTree() {
  if (activeSource() === 'nav') {
    return navTree ??= Sitemap.buildNavTree(navMenu.items, allUrls, siteOrigin, prefs.deep ? contentLinks : null);
  }
  return pathTree ??= Sitemap.buildTree(allUrls);
}

function isMatch(node, q) {
  return !!node.link && (node.link.toLowerCase().includes(q) || node.name.toLowerCase().includes(q));
}

// Records, for every node, how many matching pages its subtree holds.
function countMatches(node, q, out) {
  let n = isMatch(node, q) ? 1 : 0;
  for (const c of node.children) n += countMatches(c, q, out);
  out.set(node, n);
  return n;
}

// Shared view of the tree under the current filter, used by rendering and export.
function treeContext() {
  const { root, nodeOf } = getTree();
  const q = filterQuery();
  if (!q) {
    return {
      root, nodeOf, q,
      kidsOf: node => node.children,
      pagesIn: node => node.total,
      below: node => node.total - (node.page ? 1 : 0),
    };
  }
  const matches = new Map();
  countMatches(root, q, matches);
  return {
    root, nodeOf, q,
    kidsOf: node => node.children.filter(c => matches.get(c) > 0),
    pagesIn: node => matches.get(node),
    below: node => matches.get(node) - (isMatch(node, q) ? 1 : 0),
  };
}

// Folds chains of link-less single-child folders into one row, e.g. "blog/2024".
function compact(node, ctx) {
  let name = node.name;
  let kids = ctx.kidsOf(node);
  while (node.depth > 0 && !node.link && !node.group && kids.length === 1 && kids[0].children.length) {
    node = kids[0];
    name += '/' + node.name;
    kids = ctx.kidsOf(node);
  }
  return { node, name, kids };
}

function tagsOf(node) {
  const tags = [];
  if (node.source === 'content') tags.push(['found', 'in page', 'Found by deep scan inside a main page']);
  if (node.link && !node.page && !node.group) {
    tags.push(['warn', 'no sitemap', 'Linked from the site but missing from the sitemap']);
  }
  return tags;
}

function treeRow(node, name, count) {
  const row = document.createElement('div');
  row.className = 'row' + (node.group ? ' group' : '');

  let label;
  if (node.link) {
    label = document.createElement('a');
    label.href = node.link;
    label.target = '_blank';
    label.rel = 'noopener';
    label.title = node.link;
  } else {
    label = document.createElement('span');
    if (!node.group) {
      label.classList.add('virtual');
      label.title = node.source === 'nav' ? 'Menu heading (no link)' : 'Not in sitemap';
    }
  }
  label.classList.add('name');
  label.textContent = name;
  row.appendChild(label);

  for (const [cls, text, title] of tagsOf(node)) {
    const tag = document.createElement('span');
    tag.className = 'tag ' + cls;
    tag.textContent = text;
    tag.title = title;
    row.appendChild(tag);
  }
  if (count) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = count;
    badge.title = `${count} sitemap page${count === 1 ? '' : 's'} below`;
    row.appendChild(badge);
  }
  if (node.page?.lastmod) {
    const span = document.createElement('span');
    span.className = 'lastmod';
    span.textContent = node.page.lastmod.slice(0, 10);
    span.title = node.page.lastmod;
    row.appendChild(span);
  }
  return row;
}

function treeChildren(kids, ctx, open) {
  const ul = document.createElement('ul');
  for (const k of kids.slice(0, RENDER_LIMIT)) ul.appendChild(treeItem(k, ctx, open));
  if (kids.length > RENDER_LIMIT) {
    const li = document.createElement('li');
    li.className = 'more';
    li.textContent = `…${kids.length - RENDER_LIMIT} more (filter to narrow, or export for the full tree)`;
    ul.appendChild(li);
  }
  return ul;
}

// Children are rendered lazily on first expand, so large sites stay responsive.
function treeItem(start, ctx, open) {
  const { node, name, kids } = compact(start, ctx);
  const li = document.createElement('li');
  const row = treeRow(node, name, kids.length ? ctx.below(node) : 0);
  if (!kids.length) {
    li.appendChild(row);
    return li;
  }

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.appendChild(row);
  details.appendChild(summary);

  let rendered = false;
  const renderKids = () => {
    if (rendered) return;
    rendered = true;
    details.appendChild(treeChildren(kids, ctx, open));
  };
  if (open(node)) {
    details.open = true;
    openNodes.add(node);
    renderKids();
  }
  details.addEventListener('toggle', () => {
    if (details.open) {
      openNodes.add(node);
      renderKids();
    } else {
      openNodes.delete(node);
    }
  });
  li.appendChild(details);
  return li;
}

// mode: 'default' (site/hosts open, plus small filtered branches), 'all' or 'none'.
function renderTree(mode = 'default') {
  const ctx = treeContext();
  const open = mode === 'all' ? () => true
    : mode === 'none' || !ctx.q ? node => node.depth === 0
    : node => node.depth === 0 || ctx.pagesIn(node) <= FILTER_EXPAND_LIMIT;

  openNodes = new Set();
  const kids = ctx.kidsOf(ctx.root);
  els.urlTree.replaceChildren(...treeChildren(kids, ctx, open).childNodes);
}

function expandAll() {
  const pages = treeContext().pagesIn(getTree().root);
  if (pages > TREE_EXPAND_LIMIT) {
    setStatus(`Too many pages (${pages}) to expand at once. Filter first, or expand branches individually.`, 'error');
    return;
  }
  renderTree('all');
}

// ---- Navigation menu ----

// Reads the menu from the live tab when it shows the mapped site (sees menus built by
// JavaScript), otherwise from the fetched home page HTML.
async function loadMenu() {
  if (tabId != null && origin === siteOrigin) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['nav.js'] });
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => globalThis.Nav.extractMenu(document, location.href),
      });
      if (res?.result) return res.result;
    } catch (_) { /* page can't be scripted; fall back to fetching */ }
  }
  return Nav.fetchMenu(siteOrigin);
}

// Main pages for deep scan: linked top-level items (except home), or the direct
// children of top-level headings that have no link of their own.
function mainPageUrls() {
  const urls = [];
  for (const item of navMenu.items) {
    for (const i of item.url ? [item] : item.children) {
      if (i.url && new URL(i.url).pathname !== '/' && !urls.includes(i.url)) urls.push(i.url);
    }
  }
  return urls;
}

async function runDeepScan() {
  if (!navMenu || contentLinks) return;
  const urls = mainPageUrls();
  contentLinks = await Nav.scanPages(urls, setStatus);
  const found = [...contentLinks.values()].reduce((n, l) => n + l.length, 0);
  setStatus(`Deep scan: ${found} links found in ${urls.length} main pages.`, 'ok');
}

// ---- Fetch ----

function renderSitemaps(sitemaps) {
  els.sitemapCount.textContent = sitemaps.length;
  const frag = document.createDocumentFragment();
  for (const s of sitemaps) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = s.url;
    a.textContent = s.url;
    a.target = '_blank';
    a.rel = 'noopener';
    li.appendChild(a);
    const meta = document.createElement('span');
    if (s.error) {
      meta.className = 'failed';
      meta.textContent = ` — ${s.error}`;
    } else {
      meta.className = 'count';
      meta.textContent = ` — ${s.count} ${s.isIndex ? 'sitemaps' : 'URLs'}`;
    }
    li.appendChild(meta);
    frag.appendChild(li);
  }
  els.sitemapList.replaceChildren(frag);
  els.sitemapsSection.hidden = sitemaps.length === 0;
}

async function run(manualUrl) {
  els.fetchBtn.disabled = true;
  els.results.hidden = true;
  els.sitemapsSection.hidden = true;
  allUrls = [];
  navMenu = null;
  contentLinks = null;
  navTree = pathTree = null;
  siteOrigin = manualUrl ? new URL(manualUrl).origin : origin;

  try {
    let roots;
    if (manualUrl) {
      roots = [manualUrl];
    } else {
      roots = await Sitemap.discover(siteOrigin, setStatus);
      if (!roots.length) {
        setStatus('No sitemap found. Enter a sitemap URL above to fetch it manually.', 'error');
        return;
      }
    }

    const { urls, sitemaps, capped } = await Sitemap.crawl(roots, setStatus);
    allUrls = urls;
    renderSitemaps(sitemaps);

    if (!urls.length) {
      const firstError = sitemaps.find(s => s.error)?.error;
      setStatus(`No URLs found${firstError ? ` (${firstError})` : ''}.`, 'error');
      return;
    }

    setStatus('Reading navigation menu…');
    navMenu = await loadMenu();
    if (navMenu && prefs.deep) await runDeepScan();

    const failed = sitemaps.filter(s => s.error).length;
    let msg = `Found ${urls.length} URLs in ${sitemaps.length} sitemap${sitemaps.length === 1 ? '' : 's'}.`;
    if (failed) msg += ` ${failed} failed.`;
    if (capped) msg += ' Sitemap limit reached; some may be skipped.';
    msg += navMenu
      ? ` Menu: ${navMenu.items.length} main items.`
      : ' No navigation menu found; tree uses URL paths.';
    setStatus(msg, 'ok');

    els.results.hidden = false;
    render();
  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
  } finally {
    els.fetchBtn.disabled = false;
  }
}

// ---- Export ----

function hostSlug() {
  try { return new URL(siteOrigin || origin).hostname.replace(/[^a-z0-9.-]/gi, '_'); } catch (_) { return 'sitemap'; }
}

function download(content, ext, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${hostSlug()}-sitemap${prefs.view === 'tree' ? '-tree' : ''}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function csvCell(v) {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function outlineLine(node, source) {
  if (node.group) return node.name;
  let text = !node.link ? `${node.name}/`
    : source === 'nav' ? `${node.name} — ${node.link}`
    : node.link;
  if (node.source === 'content') text += ' [found in page]';
  if (!node.page) text += node.link ? ' [not in sitemap]' : ' (not in sitemap)';
  return text;
}

// Indented outline of the (filtered) tree.
function treeOutline() {
  const ctx = treeContext();
  const source = activeSource();
  const lines = [];
  (function walk(nodes) {
    for (const n of nodes) {
      lines.push('  '.repeat(n.depth) + outlineLine(n, source));
      walk(ctx.kidsOf(n));
    }
  })(ctx.kidsOf(ctx.root));
  return lines.join('\n');
}

function treeJson() {
  const ctx = treeContext();
  const toJson = n => {
    const o = { name: n.name, url: n.link || null, inSitemap: !!n.page };
    if (n.inNav) o.inNav = true;
    if (n.source === 'content') o.foundInPage = true;
    if (n.group) o.group = true;
    if (n.page?.lastmod) o.lastmod = n.page.lastmod;
    const kids = ctx.kidsOf(n);
    if (kids.length) o.children = kids.map(toJson);
    return o;
  };
  return ctx.kidsOf(ctx.root).map(toJson);
}

function urlText() {
  return prefs.view === 'tree' ? treeOutline() : filteredUrls().map(u => u.loc).join('\n');
}

function displayPath(link) {
  try {
    const u = new URL(link);
    return decodeURI(u.pathname + u.search);
  } catch (_) {
    return link;
  }
}

function diagramStatus(node) {
  if (!node.link) return 'folder';
  if (node.source === 'content') return 'found';
  return node.page ? 'ok' : 'nosm';
}

// Diagram of the tree as currently shown: collapsed branches become a "+N" badge.
function diagramModel() {
  const ctx = treeContext();
  const toBox = (start, level) => {
    const { node, name, kids } = compact(start, ctx);
    const open = kids.length > 0 && openNodes.has(node);
    return {
      name,
      path: node.group ? `${ctx.below(node)} pages` : level === 0 ? node.link || '' : node.link ? displayPath(node.link) : '',
      kind: level === 0 ? 'root' : node.group ? 'group' : level === 1 ? 'main' : 'sub',
      status: diagramStatus(node),
      more: kids.length && !open ? ctx.below(node) || kids.length : 0,
      children: open ? kids.map(k => toBox(k, level + 1)) : [],
    };
  };

  const tops = ctx.kidsOf(ctx.root);
  const root = tops.length === 1
    ? toBox(tops[0], 0)
    : { name: 'Sitemap', path: '', kind: 'root', status: 'ok', more: 0, children: tops.map(t => toBox(t, 1)) };

  const source = activeSource();
  const parts = [
    source === 'nav' ? 'Main navigation + sitemap' : 'URL paths from sitemap',
    new Date().toISOString().slice(0, 10),
    `${ctx.pagesIn(ctx.root)} pages`,
  ];
  if (ctx.q) parts.push(`filter "${ctx.q}"`);
  return { title: `${hostSlug()} — Site map`, subtitle: parts.join(' · '), root };
}

async function exportImage(ext) {
  const model = diagramModel();
  const boxes = Diagram.countBoxes(model.root);
  if (boxes > DIAGRAM_LIMIT) {
    setStatus(`Diagram would have ${boxes} boxes (max ${DIAGRAM_LIMIT}). Collapse some branches or filter first.`, 'error');
    return;
  }
  setStatus('Drawing diagram…');
  try {
    const out = await Diagram.render(model);
    if (ext === 'svg') download(new Blob([out.svg], { type: 'image/svg+xml' }), 'svg');
    else download(await Diagram.png(out), 'png');
    setStatus(`Saved ${ext.toUpperCase()} diagram (${boxes} boxes). It shows the tree as currently expanded.`, 'ok');
  } catch (err) {
    setStatus('Image export failed: ' + err.message, 'error');
  }
}

$('copy-btn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(urlText());
  setStatus(prefs.view === 'tree'
    ? 'Copied tree outline to clipboard.'
    : `Copied ${filteredUrls().length} URLs to clipboard.`, 'ok');
});

$('txt-btn').addEventListener('click', () => {
  download(urlText(), 'txt', 'text/plain');
});

$('csv-btn').addEventListener('click', () => {
  const { nodeOf } = getTree();
  const nav = activeSource() === 'nav';
  const rows = [['url', 'lastmod', 'sitemap', 'depth', 'parent', 'in_nav']]
    .concat(filteredUrls().map(u => {
      const node = nodeOf.get(u.loc);
      const parent = node?.parent?.depth >= 0 ? node.parent.link || node.parent.href || node.parent.name : '';
      const inNav = nav ? (node?.inNav ? 'yes' : 'no') : '';
      return [u.loc, u.lastmod, u.source, node ? String(node.depth) : '', parent, inNav];
    }));
  download(rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'csv', 'text/csv');
});

$('json-btn').addEventListener('click', () => {
  const data = prefs.view === 'tree' ? treeJson() : filteredUrls();
  download(JSON.stringify(data, null, 2), 'json', 'application/json');
});

$('png-btn').addEventListener('click', () => exportImage('png'));
$('svg-btn').addEventListener('click', () => exportImage('svg'));

// ---- Init ----

function setPref(key, value) {
  prefs[key] = value;
  savePrefs();
  render();
}

els.filter.addEventListener('input', render);
els.viewList.addEventListener('click', () => setPref('view', 'list'));
els.viewTree.addEventListener('click', () => setPref('view', 'tree'));
els.srcNav.addEventListener('click', () => setPref('source', 'nav'));
els.srcPath.addEventListener('click', () => setPref('source', 'path'));
$('expand-btn').addEventListener('click', expandAll);
$('collapse-btn').addEventListener('click', () => renderTree('none'));

els.deepScan.addEventListener('change', async () => {
  prefs.deep = els.deepScan.checked;
  savePrefs();
  els.deepScan.disabled = true;
  try {
    if (prefs.deep) await runDeepScan();
    navTree = null;
    render();
  } finally {
    els.deepScan.disabled = false;
  }
});

els.form.addEventListener('submit', e => {
  e.preventDefault();
  const manual = els.manualUrl.value.trim();
  if (manual) {
    try {
      const u = new URL(manual);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
    } catch (_) {
      setStatus('Invalid URL.', 'error');
      return;
    }
  }
  if (!manual && !origin) {
    setStatus('Open a website (http/https) or enter a sitemap URL.', 'error');
    return;
  }
  run(manual);
});

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url;
  try { url = new URL(tab?.url || ''); } catch (_) { /* non-URL tab */ }

  if (url && /^https?:$/.test(url.protocol)) {
    origin = url.origin;
    tabId = tab.id;
    els.origin.textContent = url.hostname;
    run('');
  } else {
    setStatus('This page is not a website. Enter a sitemap URL to fetch it.', 'error');
  }
})();
