// Rend le HTML en PDF avec Chromium (Playwright), en deux passes pour les numéros de page.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFString, PDFNumber } from "pdf-lib";
import { fillTocNumbers, fontFaceData } from "./merge.js";

const DEFAULT_PDF = {
  format: "A4",
  margin: { top: "18mm", right: "16mm", bottom: "20mm", left: "16mm" },
  headerTemplate: "<span></span>",
  footerTemplate: `
<div style="width:100%;font-family:Helvetica,Arial,sans-serif;font-size:8px;color:#777;padding:0 16mm;display:flex;justify-content:space-between">
  <span>{{title}}</span><span class="pageNumber"></span>
</div>`,
};

function sub(tpl, vars) {
  return tpl.replace(/{{(\w+)}}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));
}

async function launch() {
  const executablePath = process.env.NOTION2PDF_CHROME || undefined; // ex: chemin vers chrome.exe
  return chromium.launch({ executablePath, args: ["--allow-file-access-from-files"] });
}

/** Réduit la taille des éléments `selector` (white-space: nowrap côté thème) jusqu'à ce qu'ils tiennent
    dans leur largeur ; plancher : la variable CSS --fit-min (px), 10 px par défaut. */
async function fitText(page, selector) {
  if (!selector) return;
  await page.evaluate((sel) => {
    for (const el of document.querySelectorAll(sel)) {
      const min = parseFloat(getComputedStyle(el).getPropertyValue("--fit-min")) || 10;
      let size = parseFloat(getComputedStyle(el).fontSize);
      while (el.scrollWidth > el.clientWidth + 0.5 && size > min) {
        size = Math.max(min, size - 0.5);
        el.style.fontSize = `${size}px`;
      }
    }
  }, selector);
}

/** Charge un HTML dans une page et attend polices, images et mermaid */
async function loadHtml(browser, html, workDir, name, compress, measure, fit) {
  const file = path.join(workDir, `${name}.html`);
  fs.writeFileSync(file, html);
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.warn("  [chromium]", m.text()); });
  await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; })));
    if ("__mermaidDone" in window) {
      for (let i = 0; i < 300 && !window.__mermaidDone; i++) await new Promise((r) => setTimeout(r, 100));
    }
  });
  // Compression des images : Chromium ré-encode png/webp sans perte (PDF énorme) ;
  // on les redimensionne et ré-encode en JPEG dans le navigateur, sans dépendance native.
  if (compress && compress.maxWidth > 0) {
    await page.evaluate(async ({ maxWidth, quality }) => {
      const canvas = document.createElement("canvas");
      const g = canvas.getContext("2d");
      for (const img of [...document.images]) {
        if (!img.naturalWidth || img.src.startsWith("data:")) continue;
        const isPng = /\.png(\?|$)/i.test(img.src);
        const mayAlpha = /\.(png|webp|gif)(\?|$)/i.test(img.src); // formats qui peuvent porter de la transparence
        const scale = Math.min(1, maxWidth / img.naturalWidth);
        if (scale === 1 && isPng) continue; // petit png : on ne touche pas (transparence)
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        g.clearRect(0, 0, canvas.width, canvas.height);
        g.drawImage(img, 0, 0, canvas.width, canvas.height);
        let hasAlpha = false;
        if (mayAlpha) {
          const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let i = 3; i < d.length; i += 4 * 97) if (d[i] < 250) { hasAlpha = true; break; }
        }
        // transparente mais posée sur un fond opaque (cadre du thème) : on l'aplatit sur ce fond → JPEG
        const bg = getComputedStyle(img).backgroundColor;
        if (hasAlpha && /^rgb\(/.test(bg)) {
          g.globalCompositeOperation = "destination-over";
          g.fillStyle = bg;
          g.fillRect(0, 0, canvas.width, canvas.height);
          g.globalCompositeOperation = "source-over";
          hasAlpha = false;
        }
        const url = hasAlpha ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", quality);
        await new Promise((r) => { img.onload = img.onerror = r; img.src = url; });
      }
    }, compress);
  }
  await page.emulateMedia({ media: "print" });

  // Mesure : à la largeur exacte du contenu imprimé, on repère les tableaux plus hauts
  // qu'une page et on les autorise à se couper (les autres restent d'un seul tenant).
  if (measure && measure.contentW > 0) {
    await page.setViewportSize({ width: measure.contentW, height: Math.max(400, Math.round(measure.contentH)) });
    await page.evaluate((maxH) => {
      for (const t of document.querySelectorAll("table")) {
        if (t.getBoundingClientRect().height > maxH) t.classList.add("allow-split");
      }
    }, measure.contentH * 0.96);
  } else if (measure && measure.pageW > 0) {
    // page pleine (couverture, décor) : le viewport = la feuille, pour que 100vw/100vh et fitText soient justes
    await page.setViewportSize({ width: Math.round(measure.pageW), height: Math.round(measure.pageH) });
  }
  await fitText(page, fit);
  return page;
}

async function toPdf(page, pdfOpts, withChrome, pageRanges) {
  return page.pdf({
    format: pdfOpts.format,
    margin: withChrome ? pdfOpts.margin : { top: 0, right: 0, bottom: 0, left: 0 },
    printBackground: true,
    preferCSSPageSize: false,
    displayHeaderFooter: withChrome,
    headerTemplate: pdfOpts.headerTemplate,
    footerTemplate: pdfOpts.footerTemplate,
    ...(pageRanges ? { pageRanges } : {}),
  });
}

/** Calques de décor de chaque page du corps (du fond vers l'avant) : le fond partagé de la palette s'il
    existe, puis la variante de la section : "<id>:opener" sur sa 1re page, "<id>:running" ensuite ;
    avant la 1re section, c'est le sommaire. */
function layerAssignment(numPages, sections, pageOf, bgOf = {}) {
  const starts = sections.map((s) => ({ id: s.id, page: pageOf.sections[s.id] }))
    .filter((s) => s.page).sort((a, b) => a.page - b.page);
  const out = [];
  for (let p = 1; p <= numPages; p++) {
    let cur = null;
    for (const s of starts) { if (s.page <= p) cur = s; else break; }
    const id = cur ? cur.id : "toc";
    const kind = cur ? (cur.page === p ? "opener" : "running") : (p === 1 ? "opener" : "running");
    out.push([bgOf[id]?.[kind], `${id}:${kind}`].filter(Boolean));
  }
  return out;
}

/** Retrouve sur quelle page (1-based) apparaît chaque marqueur pg:/hd: */
async function locateMarkers(pdfBytes) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes), verbosity: 0 }).promise;
  const sections = {}, headings = {};
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    const text = content.items.map((it) => it.str).join("");
    // insensible à la casse : un thème peut mettre les titres en capitales
    for (const m of text.matchAll(/pg:([0-9a-f]{32})/gi)) sections[m[1].toLowerCase()] ??= i;
    for (const m of text.matchAll(/hd:([0-9a-f-]{36})/gi)) headings[m[1].toLowerCase()] ??= i;
  }
  await doc.destroy();
  return { sections, headings, numPages: doc.numPages };
}

/** Fusionne couverture + corps, ajoute métadonnées et signets */
async function assemble(coverBytes, bodyBytes, sectionsInfo, pageOf, meta) {
  let out = await PDFDocument.create();
  const cover = coverBytes ? await PDFDocument.load(coverBytes) : null;
  const body = await PDFDocument.load(bodyBytes);
  const coverPages = cover ? await out.copyPages(cover, cover.getPageIndices()) : [];
  const bodyPages = await out.copyPages(body, body.getPageIndices());
  [...coverPages, ...bodyPages].forEach((p) => out.addPage(p));
  const offset = coverPages.length;

  // Fond de page : Chromium ne peint pas les marges, on glisse sous chaque page soit le décor du thème
  // (page.html), soit un simple aplat
  if (meta.layers) {
    await drawLayers(out, meta.layers, offset);
    out = await compact(out);
  } else if (meta.pageBackground) paintBackground(out, meta.pageBackground, offset);

  out.setTitle(meta.title || "");
  if (meta.author) out.setAuthor(meta.author);
  out.setCreator("notion2pdf");
  out.setProducer("notion2pdf / Chromium");

  // Liens internes (sommaire, renvois) : Chromium les écrit en destinations nommées dans le catalogue,
  // que la copie des pages ne reprend pas
  writeDests(out, readDests(body), offset);

  // Signets (outline) : un par section, hiérarchisés par profondeur
  const entries = sectionsInfo
    .filter((s) => pageOf.sections[s.id])
    .map((s) => ({ ...s, pageIndex: offset + pageOf.sections[s.id] - 1 }));
  if (entries.length) addOutline(out, entries);

  return out.save();
}

/** Destinations nommées du catalogue (/Dests) : nom → index de page + reste de la destination (/XYZ x y z) */
function readDests(doc) {
  const dests = doc.catalog.lookupMaybe(PDFName.of("Dests"), PDFDict);
  if (!dests) return [];
  const pageIndex = new Map(doc.getPages().map((p, i) => [p.ref.toString(), i]));
  const out = [];
  for (const [name, value] of dests.entries()) {
    const arr = doc.context.lookup(value);
    if (!(arr instanceof PDFArray) || !arr.size()) continue;
    const index = pageIndex.get(arr.get(0).toString());
    if (index != null) out.push({ name, index, rest: arr.asArray().slice(1) });
  }
  return out;
}

function writeDests(doc, dests, offset) {
  if (!dests.length) return;
  const pages = doc.getPages();
  const dict = doc.context.obj({});
  for (const { name, index, rest } of dests) {
    if (pages[offset + index]) dict.set(name, doc.context.obj([pages[offset + index].ref, ...rest]));
  }
  doc.catalog.set(PDFName.of("Dests"), doc.context.register(dict));
}

/** embedPdf recopie les pages embarquées (flux de contenu compris) puis en fabrique un XObject : les copies
    restent dans le fichier sans être référencées, comme les variantes inutilisées. On recopie les pages dans
    un document neuf, qui ne reprend que ce qu'elles référencent. */
async function compact(doc) {
  await doc.flush();
  const fresh = await PDFDocument.create();
  for (const p of await fresh.copyPages(doc, doc.getPageIndices())) fresh.addPage(p);
  return fresh;
}

/** Place une page du PDF de décor sous chaque page (à partir de `from`) : chaque variante est embarquée
    une seule fois (XObject) puis référencée en tout premier dans le flux de contenu des pages qui l'utilisent. */
async function drawLayers(doc, { bytes, keys, assign }, from = 0) {
  const embedded = await doc.embedPdf(bytes, keys.map((_, i) => i));
  const byKey = new Map(keys.map((k, i) => [k, embedded[i]]));
  const ctx = doc.context;
  doc.getPages().forEach((page, i) => {
    if (i < from) return;
    const used = (assign[i - from] || []).map((k) => byKey.get(k)).filter(Boolean);
    if (!used.length) return;
    const ops = used.map((layer) => `q ${page.node.newXObject("Layer", layer.ref)} Do Q\n`).join("");
    const stream = ctx.register(ctx.flateStream(ops));
    const existing = page.node.get(PDFName.of("Contents"));
    const list = existing instanceof PDFArray ? existing.asArray() : existing ? [existing] : [];
    page.node.set(PDFName.of("Contents"), ctx.obj([stream, ...list]));
  });
}

/** Insère un rectangle de couleur en tout premier dans le flux de contenu de chaque page (à partir de `from`) */
function paintBackground(doc, hex, from = 0) {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return;
  const [r, g, b] = m.slice(1).map((h) => (parseInt(h, 16) / 255).toFixed(4));
  const ctx = doc.context;
  doc.getPages().forEach((page, i) => {
    if (i < from) return;
    const { width, height } = page.getSize();
    const ops = `q ${r} ${g} ${b} rg 0 0 ${width.toFixed(2)} ${height.toFixed(2)} re f Q\n`;
    const stream = ctx.register(ctx.flateStream(ops));
    const existing = page.node.get(PDFName.of("Contents"));
    const list = existing instanceof PDFArray ? existing.asArray() : existing ? [existing] : [];
    page.node.set(PDFName.of("Contents"), ctx.obj([stream, ...list]));
  });
}

function addOutline(doc, entries) {
  const ctx = doc.context;
  const pages = doc.getPages();
  const outlineRef = ctx.nextRef();
  const refs = entries.map(() => ctx.nextRef());

  // parent/enfants d'après depth
  const stack = [];
  entries.forEach((e, i) => {
    while (stack.length && entries[stack[stack.length - 1]].depth >= e.depth) stack.pop();
    e.parent = stack.length ? stack[stack.length - 1] : -1;
    e.children = [];
    if (e.parent >= 0) entries[e.parent].children.push(i);
    stack.push(i);
  });
  const roots = entries.map((e, i) => (e.parent < 0 ? i : -1)).filter((i) => i >= 0);

  const countDesc = (i) => entries[i].children.reduce((n, c) => n + 1 + countDesc(c), 0);
  const siblings = (list) => list.map((idx, k) => ({ idx, prev: k > 0 ? list[k - 1] : -1, next: k < list.length - 1 ? list[k + 1] : -1 }));

  const build = (list, parentRef) => {
    for (const { idx, prev, next } of siblings(list)) {
      const e = entries[idx];
      const dict = ctx.obj({
        Title: PDFString.of(e.title),
        Parent: parentRef,
        Dest: ctx.obj([pages[e.pageIndex].ref, PDFName.of("Fit")]),
      });
      if (prev >= 0) dict.set(PDFName.of("Prev"), refs[prev]);
      if (next >= 0) dict.set(PDFName.of("Next"), refs[next]);
      if (e.children.length) {
        dict.set(PDFName.of("First"), refs[e.children[0]]);
        dict.set(PDFName.of("Last"), refs[e.children[e.children.length - 1]]);
        dict.set(PDFName.of("Count"), PDFNumber.of(countDesc(idx)));
        build(e.children, refs[idx]);
      }
      ctx.assign(refs[idx], dict);
    }
  };
  build(roots, outlineRef);

  const outline = ctx.obj({
    Type: PDFName.of("Outlines"),
    First: refs[roots[0]],
    Last: refs[roots[roots.length - 1]],
    Count: PDFNumber.of(entries.length),
  });
  ctx.assign(outlineRef, outline);
  doc.catalog.set(PDFName.of("Outlines"), outlineRef);
  doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
}

/**
 * @param doc  résultat de buildDocument
 * @param theme thème chargé
 * @param opts { out, cover:boolean, pageNumbers:boolean, keepHtml, log, compress:{maxWidth,quality}|null }
 */
export async function renderPdf(doc, theme, opts) {
  const log = opts.log || (() => {});
  const pdfOpts = { ...DEFAULT_PDF, ...(theme.config.pdf || {}) };
  pdfOpts.margin = { ...DEFAULT_PDF.margin, ...(theme.config.pdf?.margin || {}) };
  if (opts.format) pdfOpts.format = opts.format;
  // {{font:Famille}} : police du thème embarquée dans le gabarit (Chromium n'y charge rien d'externe)
  const tpl = (t) => sub(t.replace(/{{font:(\w+)}}/g, (_, fam) => fontFaceData(theme, fam)), doc.vars);
  pdfOpts.headerTemplate = tpl(pdfOpts.headerTemplate);
  pdfOpts.footerTemplate = tpl(pdfOpts.footerTemplate);
  const fit = theme.config.fitText || null;

  // Boîte de contenu imprimée (mm → px @96dpi) pour mesurer les blocs à la bonne largeur
  const mm = (v) => parseFloat(String(v)) || 0;
  const fmt = /letter/i.test(pdfOpts.format) ? { w: 215.9, h: 279.4 } : { w: 210, h: 297 };
  const PX = 96 / 25.4;
  const measure = {
    contentW: Math.round((fmt.w - mm(pdfOpts.margin.left) - mm(pdfOpts.margin.right)) * PX),
    contentH: (fmt.h - mm(pdfOpts.margin.top) - mm(pdfOpts.margin.bottom)) * PX,
  };
  const fullPage = { pageW: fmt.w * PX, pageH: fmt.h * PX };
  // Aperçu : on n'imprime que les N premières pages (couverture comprise)
  const bodyRange = opts.maxPages > 0 ? `1-${Math.max(1, opts.maxPages - (opts.cover !== false ? 1 : 0))}` : null;

  const workDir = opts.keepHtml ? path.resolve(opts.keepHtml) : fs.mkdtempSync(path.join(os.tmpdir(), "notion2pdf-html-"));
  fs.mkdirSync(workDir, { recursive: true });

  const browser = await launch();
  try {
    let coverBytes = null;
    if (opts.cover !== false) {
      log("Couverture…");
      const p = await loadHtml(browser, doc.coverHtml, workDir, "cover", opts.compress, fullPage, fit);
      coverBytes = await toPdf(p, pdfOpts, false);
      await p.close();
    }

    let layerBytes = null;
    if (doc.layers) {
      log(`Décor des pages (${doc.layers.keys.length} variantes)…`);
      const p = await loadHtml(browser, doc.layers.html, workDir, "layers", null, fullPage, fit);
      layerBytes = await toPdf(p, pdfOpts, false);
      await p.close();
    }

    log("Corps du document (passe 1)…");
    let bodyHtml = doc.bodyHtml;
    let p = await loadHtml(browser, bodyHtml, workDir, "document", opts.compress, measure, fit);
    let bodyBytes = await toPdf(p, pdfOpts, true, bodyRange);
    await p.close();

    let pageOf = { sections: {}, headings: {} };
    if (opts.pageNumbers !== false || layerBytes) pageOf = await locateMarkers(bodyBytes);
    if (opts.pageNumbers !== false) {
      log(`Numérotation du sommaire (passe 2, ${pageOf.numPages} pages)…`);
      bodyHtml = fillTocNumbers(bodyHtml, pageOf);
      p = await loadHtml(browser, bodyHtml, workDir, "document", opts.compress, measure, fit);
      bodyBytes = await toPdf(p, pdfOpts, true, bodyRange);
      await p.close();
      if (layerBytes) pageOf = await locateMarkers(bodyBytes); // le sommaire numéroté peut décaler la suite
    }

    log("Assemblage…");
    const finalBytes = await assemble(coverBytes, bodyBytes, doc.sections, pageOf, {
      title: doc.vars.title, author: doc.vars.author, pageBackground: theme.config.pageBackground,
      layers: layerBytes && {
        bytes: layerBytes, keys: doc.layers.keys,
        assign: layerAssignment(pageOf.numPages, doc.sections, pageOf, doc.layers.bgOf),
      },
    });
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(opts.out, finalBytes);
    const pages = (await PDFDocument.load(finalBytes)).getPageCount();
    return { out: opts.out, pages, html: opts.keepHtml ? workDir : null };
  } finally {
    await browser.close();
    if (!opts.keepHtml) fs.rmSync(workDir, { recursive: true, force: true });
  }
}
