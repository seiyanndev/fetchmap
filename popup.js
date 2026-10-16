'use strict';

const RENDER_LIMIT = 1000;          // max rows rendered per list / per tree level
const TREE_EXPAND_LIMIT = 3000;     // max pages "Expand all" will render
const FILTER_EXPAND_LIMIT = 50;     // auto-expand filtered branches with at most this many matches
const VIEW_KEY = 'fetchmap.view';

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
};

let origin = '';
let allUrls = [];
let tree = null;    // { root, nodeOf }, built on first use after each fetch
let view = 'list';
try { if (localStorage.getItem(VIEW_KEY) === 'tree') view = 'tree'; } catch (_) { /* storage unavailable */ }

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

function render() {
  const count = filteredUrls().length;
  els.urlCount.textContent = count === allUrls.length
    ? `${allUrls.length} URLs`
    : `${count} of ${allUrls.length} URLs`;

  const isTree = view === 'tree';
  els.viewList.setAttribute('aria-pressed', String(!isTree));
  els.viewTree.setAttribute('aria-pressed', String(isTree));
  els.urlList.hidden = isTree;
  els.urlTree.hidden = !isTree;
  els.treeTools.hidden = !isTree;
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
  return tree ??= Sitemap.buildTree(allUrls);
}

function isMatch(node, q) {
  return !!node.page && node.page.loc.toLowerCase().includes(q);
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

// Folds chains of URL-less single-child folders into one row, e.g. "blog/2024".
function compact(node, ctx) {
  let name = node.name;
  let kids = ctx.kidsOf(node);
  while (node.depth > 0 && !node.page && kids.length === 1 && kids[0].children.length) {
    node = kids[0];
    name += '/' + node.name;
    kids = ctx.kidsOf(node);
  }
  return { node, name, kids };
}

function treeRow(node, name, count) {
  const row = document.createElement('div');
  row.className = 'row';

  let label;
  if (node.page) {
    label = document.createElement('a');
    label.href = node.page.loc;
    label.target = '_blank';
    label.rel = 'noopener';
    label.title = node.page.loc;
  } else {
    label = document.createElement('span');
    label.classList.add('virtual');
    label.title = 'Not in sitemap';
  }
  label.classList.add('name');
  label.textContent = name;
  row.appendChild(label);

  if (count) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = count;
    badge.title = `${count} page${count === 1 ? '' : 's'} below`;
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
    renderKids();
  }
  details.addEventListener('toggle', () => { if (details.open) renderKids(); });
  li.appendChild(details);
  return li;
}

// mode: 'default' (hosts open, plus small filtered branches), 'all' or 'none'.
function renderTree(mode = 'default') {
  const ctx = treeContext();
  const open = mode === 'all' ? () => true
    : mode === 'none' || !ctx.q ? node => node.depth === 0
    : node => node.depth === 0 || ctx.pagesIn(node) <= FILTER_EXPAND_LIMIT;

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

function setView(next) {
  view = next;
  try { localStorage.setItem(VIEW_KEY, view); } catch (_) { /* storage unavailable */ }
  render();
}

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
  tree = null;

  try {
    let roots;
    if (manualUrl) {
      roots = [manualUrl];
    } else {
      roots = await Sitemap.discover(origin, setStatus);
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

    const failed = sitemaps.filter(s => s.error).length;
    let msg = `Found ${urls.length} URLs in ${sitemaps.length} sitemap${sitemaps.length === 1 ? '' : 's'}.`;
    if (failed) msg += ` ${failed} failed.`;
    if (capped) msg += ' Sitemap limit reached; some may be skipped.';
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
  try { return new URL(origin).hostname.replace(/[^a-z0-9.-]/gi, '_'); } catch (_) { return 'sitemap'; }
}

function download(content, ext, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${hostSlug()}-sitemap${view === 'tree' ? '-tree' : ''}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function csvCell(v) {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// Indented outline: pages as full URLs, virtual levels as "segment/ (not in sitemap)".
function treeOutline() {
  const ctx = treeContext();
  const lines = [];
  (function walk(nodes) {
    for (const n of nodes) {
      const indent = '  '.repeat(n.depth);
      lines.push(indent + (n.page ? n.page.loc : `${n.name}/ (not in sitemap)`));
      walk(ctx.kidsOf(n));
    }
  })(ctx.kidsOf(ctx.root));
  return lines.join('\n');
}

function treeJson() {
  const ctx = treeContext();
  const toJson = n => {
    const o = { name: n.name, url: n.page?.loc || null };
    if (n.page?.lastmod) o.lastmod = n.page.lastmod;
    const kids = ctx.kidsOf(n);
    if (kids.length) o.children = kids.map(toJson);
    return o;
  };
  return ctx.kidsOf(ctx.root).map(toJson);
}

function urlText() {
  return view === 'tree' ? treeOutline() : filteredUrls().map(u => u.loc).join('\n');
}

$('copy-btn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(urlText());
  setStatus(view === 'tree'
    ? 'Copied tree outline to clipboard.'
    : `Copied ${filteredUrls().length} URLs to clipboard.`, 'ok');
});

$('txt-btn').addEventListener('click', () => {
  download(urlText(), 'txt', 'text/plain');
});

$('csv-btn').addEventListener('click', () => {
  const { nodeOf } = getTree();
  const rows = [['url', 'lastmod', 'sitemap', 'depth', 'parent']]
    .concat(filteredUrls().map(u => {
      const node = nodeOf.get(u.loc);
      const parent = node?.parent?.depth >= 0 ? node.parent.href : '';
      return [u.loc, u.lastmod, u.source, node ? String(node.depth) : '', parent];
    }));
  download(rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'csv', 'text/csv');
});

$('json-btn').addEventListener('click', () => {
  const data = view === 'tree' ? treeJson() : filteredUrls();
  download(JSON.stringify(data, null, 2), 'json', 'application/json');
});

// ---- Init ----

els.filter.addEventListener('input', render);
els.viewList.addEventListener('click', () => setView('list'));
els.viewTree.addEventListener('click', () => setView('tree'));
$('expand-btn').addEventListener('click', expandAll);
$('collapse-btn').addEventListener('click', () => renderTree('none'));

els.form.addEventListener('submit', e => {
  e.preventDefault();
  const manual = els.manualUrl.value.trim();
  if (manual) {
    try {
      const u = new URL(manual);
      if (!origin) origin = u.origin;
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
    els.origin.textContent = url.hostname;
    run('');
  } else {
    setStatus('This page is not a website. Enter a sitemap URL to fetch it.', 'error');
  }
})();
