# FetchMap – Sitemap Fetcher (Chrome extension)

Click the toolbar icon on any website to discover and fetch its sitemap, browse every URL, and export the list.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder

## How it works

1. **Discovery** – reads `robots.txt` for `Sitemap:` directives; if none, tries
   `/sitemap.xml`, `/sitemap_index.xml`, `/sitemap-index.xml`, `/wp-sitemap.xml`,
   `/sitemap.php`, `/sitemap.txt`, `/sitemap.xml.gz`.
2. **Crawl** – sitemap indexes are followed recursively (4 parallel requests, up to 200 sitemaps, 30s timeout each).
3. **Formats** – XML `<urlset>` / `<sitemapindex>`, gzipped sitemaps, and plain-text URL lists. HTML "soft 404" pages are rejected.
4. **Output** – filterable URL list with `lastmod`, per-sitemap counts/errors, and Copy / TXT / CSV / JSON export (exports respect the current filter).
5. **Tree view** – toggle **List / Tree** to see the site hierarchy, from one of two sources:
   - **Menu** (default) – the site's main navigation is the backbone: home → main menu items (in menu order) → dropdown items, labelled with the menu text. The menu is read from the live tab when it shows the mapped site (so menus built by JavaScript are seen), otherwise from the fetched home page HTML. The main menu is picked by scoring every `<nav>` and common WordPress/Elementor/Divi menu container (inside `<header>`, "main/primary" names, link count; footer, breadcrumb and social menus are penalised). Every sitemap URL is then placed under the menu item with the same address, else under the menu item with the longest matching path prefix, else in a **Not in navigation** group. Menu links missing from the sitemap are tagged **no sitemap**.
   - **Paths** – hierarchy from URL paths only: host → path segments. Path levels with no URL of their own (e.g. `/blog/2024/`) show as greyed *virtual* folders, and chains of them collapse into one row.

   **Deep scan main pages** (Menu source, off by default) also fetches each main menu page and adds the links found in its content (header, footer, menus and sidebars ignored) beneath it, tagged **in page**.

   Branches render lazily on expand; filtering keeps matching pages plus their ancestors. In Tree view, Copy/TXT export an indented outline and JSON exports the nested tree; CSV always includes `depth`, `parent` and `in_nav` columns.
6. **Diagram export** – in Tree view, **PNG** / **SVG** download the tree as a column diagram: the site on top, main pages in a row, subpages stacked beneath each. Box borders show status (in sitemap / not in sitemap / found inside a page / folder) with a legend. The diagram follows what is expanded in the tree (collapsed branches show a `+N` badge) and the current filter. SVG embeds the brand fonts and opens in Figma/Illustrator; PNG is rendered at 2× (scaled down for very large trees). Limit: 1,500 boxes.

You can also paste any sitemap URL into the input box to fetch it directly.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest (`activeTab`, `tabs`, `scripting` to read the live page's menu, `<all_urls>` host permission for cross-origin fetches) |
| `sitemap.js` | Discovery, fetching, gzip handling, parsing, crawling, tree building (URL paths and menu + sitemap) |
| `nav.js` | Main menu detection and parsing, deep scan of page content links (also injected into the page) |
| `diagram.js` | Column diagram layout, SVG rendering with embedded fonts, PNG rasterising |
| `popup.html/css/js` | UI (list + tree views), filtering, export |
| `icons/` | Toolbar icons (`icon16–128.png`) and header mark (`logo-mark.png`), generated from `Glossy Blue Network F Logo.png` |
| `fonts/` | Bundled Space Grotesk, Inter, JetBrains Mono (variable, Latin subset, SIL OFL 1.1) |

## Brand

Colors follow the FetchMap palette (Midnight `#0F172A`, Electric Blue `#2563EB`, Cyan `#06B6D4`) with the recommended light/dark themes, defined as CSS tokens at the top of `popup.css`. Space Grotesk is used for the wordmark and headings, Inter for UI text, JetBrains Mono for URLs.
