// Draws a page tree as a column diagram: the site box on top, main pages in a row
// beneath it, and each main page's subpages stacked in an indented column.
// Output is a self-contained SVG (fonts embedded), optionally rasterised to PNG.
// Exposes a global `Diagram` object.
//
// Model: { title, subtitle, root: Box }
//   Box: { name, path, kind, status, more, children: [Box] }
//   kind:   'root' | 'main' | 'sub' | 'group'
//   status: 'ok' | 'nosm' (not in sitemap) | 'found' (deep scan) | 'folder' (no page)
//   more:   number of hidden pages under a collapsed box (0 = none)
(function (global) {
  'use strict';

  const C = {
    bg: '#FFFFFF', ink: '#0F172A', body: '#334155', muted: '#64748B', line: '#CBD5E1',
    border: '#CBD5E1', accent: '#2563EB', group: '#F1F5F9', warn: '#F59E0B',
    found: '#06B6D4', folder: '#94A3B8', badge: '#EFF6FF',
  };
  // Single-quoted family names: these go inside double-quoted style="" attributes.
  const F = {
    heading: "'Space Grotesk', 'Segoe UI', system-ui, sans-serif",
    body: "Inter, 'Segoe UI', system-ui, sans-serif",
    mono: "'JetBrains Mono', Consolas, monospace",
  };
  const FONT_FILES = [
    ['Space Grotesk', 'fonts/space-grotesk.woff2', '300 700'],
    ['Inter', 'fonts/inter.woff2', '100 900'],
    ['JetBrains Mono', 'fonts/jetbrains-mono.woff2', '100 800'],
  ];

  const PAD = 40;
  const HEADER_H = 70;
  const ROOT_W = 300, ROOT_H = 56;
  const BOX_W = 230, BOX_H = 46;
  const COL_GAP = 28, ROW_GAP = 10, INDENT = 24, LEVEL_GAP = 52;
  const MAX_SIDE = 16000, MAX_AREA = 120e6;   // stay inside Chrome's canvas limits

  const STATUS_LABEL = {
    ok: 'In sitemap',
    nosm: 'Not in sitemap',
    found: 'Found inside a page',
    folder: 'Folder (no page)',
  };

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let measureCtx;
  function textWidth(text, font) {
    measureCtx ??= document.createElement('canvas').getContext('2d');
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }

  // Truncates text with an ellipsis to fit maxWidth.
  function fit(text, font, maxWidth) {
    if (textWidth(text, font) <= maxWidth) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (textWidth(text.slice(0, mid) + '…', font) <= maxWidth) lo = mid; else hi = mid - 1;
    }
    return text.slice(0, lo) + '…';
  }

  let fontCss;
  async function embeddedFonts() {
    fontCss ??= Promise.all(FONT_FILES.map(async ([family, path, weight]) => {
      try {
        const blob = await (await fetch(path)).blob();
        const data = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(r.error);
          r.readAsDataURL(blob);
        });
        return `@font-face{font-family:"${family}";src:url(${data}) format("woff2");font-weight:${weight};}`;
      } catch (_) {
        return '';   // fall back to system fonts
      }
    })).then(parts => parts.join(''));
    return fontCss;
  }

  function countBoxes(box) {
    return 1 + box.children.reduce((n, c) => n + countBoxes(c), 0);
  }

  function layout(model) {
    const mains = model.root.children;
    const cols = mains.map(main => {
      const rows = [];
      (function walk(box, lvl) {
        rows.push({ box, lvl });
        for (const c of box.children) walk(c, lvl + 1);
      })(main, 0);
      return rows;
    });
    const colW = cols.map(rows => BOX_W + INDENT * rows.reduce((m, r) => Math.max(m, r.lvl), 0));
    const rowW = colW.reduce((s, w) => s + w, 0) + COL_GAP * Math.max(0, cols.length - 1);
    const innerW = Math.max(rowW, ROOT_W, 520);
    const width = innerW + PAD * 2;

    const rootBox = { box: model.root, x: PAD + (innerW - ROOT_W) / 2, y: PAD + HEADER_H, w: ROOT_W, h: ROOT_H };
    const boxes = [rootBox];
    const lines = [];
    const mainY = rootBox.y + ROOT_H + LEVEL_GAP;
    let bottom = rootBox.y + ROOT_H;
    let x = PAD + (innerW - rowW) / 2;

    cols.forEach((rows, i) => {
      const stack = [];
      let y = mainY;
      for (const { box, lvl } of rows) {
        const p = { box, x: x + lvl * INDENT, y, w: BOX_W, h: BOX_H };
        boxes.push(p);
        if (lvl > 0) {
          const parent = stack[lvl - 1];
          lines.push(`M${parent.x + 12} ${parent.y + parent.h}V${y + BOX_H / 2}H${p.x}`);
        }
        stack[lvl] = p;
        stack.length = lvl + 1;
        y += BOX_H + ROW_GAP;
      }
      bottom = Math.max(bottom, y - ROW_GAP);
      x += colW[i] + COL_GAP;
    });

    // Root -> main pages: a vertical stem, a horizontal bus and a drop to each column.
    const mainsPlaced = boxes.filter(b => mains.includes(b.box));
    if (mainsPlaced.length) {
      const busY = rootBox.y + ROOT_H + LEVEL_GAP / 2;
      const cx = b => b.x + b.w / 2;
      lines.push(`M${cx(rootBox)} ${rootBox.y + ROOT_H}V${busY}`);
      lines.push(`M${Math.min(cx(rootBox), cx(mainsPlaced[0]))} ${busY}H${Math.max(cx(rootBox), cx(mainsPlaced[mainsPlaced.length - 1]))}`);
      for (const m of mainsPlaced) lines.push(`M${cx(m)} ${busY}V${m.y}`);
    }

    const legendY = bottom + 36;
    return { width, height: legendY + 24 + PAD, boxes, lines, legendY };
  }

  function boxSvg(p) {
    const { box } = p;
    const isRoot = box.kind === 'root';
    const isGroup = box.kind === 'group';
    const fill = isRoot ? C.ink : isGroup ? C.group : C.bg;
    const stroke = isRoot ? C.ink
      : isGroup ? C.border
      : box.status === 'nosm' ? C.warn
      : box.status === 'found' ? C.found
      : box.status === 'folder' ? C.folder
      : C.border;
    const strokeW = box.status === 'nosm' || box.status === 'found' ? 1.5 : 1;
    const dash = box.status === 'folder' && !isRoot && !isGroup ? ' stroke-dasharray="4 3"' : '';

    const titleFont = isRoot ? `700 15px ${F.heading}`
      : box.kind === 'main' || box.kind === 'group' ? `600 13px ${F.body}`
      : `500 12.5px ${F.body}`;
    const pathFont = `400 10.5px ${F.mono}`;
    const titleColor = isRoot ? '#FFFFFF' : box.status === 'folder' && !isGroup ? C.muted : C.ink;
    const pathColor = isRoot ? '#CBD5E1' : C.muted;

    const moreText = box.more ? `+${box.more}` : '';
    const moreW = moreText ? textWidth(moreText, `600 10.5px ${F.body}`) + 12 : 0;
    const textW = p.w - 24 - (moreW ? moreW + 6 : 0);
    const title = fit(box.name || '(untitled)', titleFont, textW);
    const path = box.path ? fit(box.path, pathFont, textW) : '';
    const titleY = path ? p.y + p.h / 2 - 3 : p.y + p.h / 2 + 4.5;

    let s = `<g><rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}"${dash}/>`;
    if (box.kind === 'main') {
      s += `<rect x="${p.x + 1}" y="${p.y + 1}" width="${p.w - 2}" height="3" rx="1.5" fill="${C.accent}"/>`;
    }
    s += `<text x="${p.x + 12}" y="${titleY}" style="font:${titleFont}" fill="${titleColor}">${esc(title)}</text>`;
    if (path) s += `<text x="${p.x + 12}" y="${titleY + 16}" style="font:${pathFont}" fill="${pathColor}">${esc(path)}</text>`;
    if (moreText) {
      const bx = p.x + p.w - 10 - moreW;
      const by = p.y + p.h / 2 - 9;
      s += `<rect x="${bx}" y="${by}" width="${moreW}" height="18" rx="9" fill="${isRoot ? '#1E293B' : C.badge}"/>`;
      s += `<text x="${bx + moreW / 2}" y="${by + 12.5}" text-anchor="middle" style="font:600 10.5px ${F.body}" fill="${isRoot ? '#FFFFFF' : C.accent}">${esc(moreText)}</text>`;
    }
    return s + '</g>';
  }

  function legendSvg(statuses, y) {
    let x = PAD;
    let s = '';
    for (const st of ['ok', 'nosm', 'found', 'folder']) {
      if (!statuses.has(st)) continue;
      const stroke = { ok: C.border, nosm: C.warn, found: C.found, folder: C.folder }[st];
      const dash = st === 'folder' ? ' stroke-dasharray="3 2"' : '';
      s += `<rect x="${x}" y="${y - 10}" width="22" height="14" rx="4" fill="${C.bg}" stroke="${stroke}" stroke-width="1.5"${dash}/>`;
      s += `<text x="${x + 30}" y="${y + 1}" style="font:500 11.5px ${F.body}" fill="${C.body}">${STATUS_LABEL[st]}</text>`;
      x += 30 + textWidth(STATUS_LABEL[st], `500 11.5px ${F.body}`) + 24;
    }
    return s;
  }

  // Returns { svg, width, height, boxes } for the model.
  async function render(model) {
    await Promise.all([
      document.fonts.load(`700 15px ${F.heading}`),
      document.fonts.load(`600 13px ${F.body}`),
      document.fonts.load(`400 10.5px ${F.mono}`),
    ]).catch(() => {});
    const fonts = await embeddedFonts();
    const L = layout(model);

    const statuses = new Set(L.boxes.filter(b => b.box.kind !== 'root' && b.box.kind !== 'group').map(b => b.box.status));
    const title = fit(model.title, `700 20px ${F.heading}`, L.width - PAD * 2);
    const subtitle = fit(model.subtitle || '', `400 12px ${F.body}`, L.width - PAD * 2);

    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}">`,
      `<style>${fonts}</style>`,
      `<rect width="100%" height="100%" fill="${C.bg}"/>`,
      `<text x="${PAD}" y="${PAD + 18}" style="font:700 20px ${F.heading}" fill="${C.ink}">${esc(title)}</text>`,
      `<text x="${PAD}" y="${PAD + 40}" style="font:400 12px ${F.body}" fill="${C.muted}">${esc(subtitle)}</text>`,
      `<path d="${L.lines.join('')}" fill="none" stroke="${C.line}" stroke-width="1.5"/>`,
      ...L.boxes.map(boxSvg),
      legendSvg(statuses, L.legendY),
      '</svg>',
    ].join('');
    return { svg, width: L.width, height: L.height, boxes: L.boxes.length };
  }

  // Rasterises a render() result to a PNG Blob at up to 2x, scaled down if needed
  // to fit the browser's canvas limits.
  async function png({ svg, width, height }) {
    const scale = Math.min(2, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height)));
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve, reject) =>
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  global.Diagram = { render, png, countBoxes };
})(globalThis);
