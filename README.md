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
5. **Tree view** – toggle **List / Tree** to see the site hierarchy, built from URL paths (sitemaps themselves carry no parent/child data). Host → path segments, with page counts per branch. Path levels with no URL of their own (e.g. `/blog/2024/`) show as greyed *virtual* folders, and chains of them collapse into one row. Branches render lazily on expand; filtering keeps matching pages plus their ancestors. In Tree view, Copy/TXT export an indented outline and JSON exports the nested tree; CSV always includes `depth` and `parent` columns.

You can also paste any sitemap URL into the input box to fetch it directly.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest (`activeTab`, `tabs`, `<all_urls>` host permission for cross-origin fetches) |
| `sitemap.js` | Discovery, fetching, gzip handling, parsing, crawling, URL-path tree building |
| `popup.html/css/js` | UI (list + tree views), filtering, export |
| `icons/` | Toolbar icons (`icon16–128.png`) and header mark (`logo-mark.png`), generated from `Glossy Blue Network F Logo.png` |
| `fonts/` | Bundled Space Grotesk, Inter, JetBrains Mono (variable, Latin subset, SIL OFL 1.1) |

## Brand

Colors follow the FetchMap palette (Midnight `#0F172A`, Electric Blue `#2563EB`, Cyan `#06B6D4`) with the recommended light/dark themes, defined as CSS tokens at the top of `popup.css`. Space Grotesk is used for the wordmark and headings, Inter for UI text, JetBrains Mono for URLs.
