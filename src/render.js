// Rend le HTML en PDF avec Chromium (Playwright), en deux passes pour les numéros de page.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { PDFDocument, PDFName, PDFArray, PDFString, PDFNumber } from "pdf-lib";
import { fillTocNumbers } from "./merge.js";

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

/** Charge un HTML dans une page et attend polices, images et mermaid */
async function loadHtml(browser, html, workDir, name, compress) {
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
        const scale = Math.min(1, maxWidth / img.naturalWidth);
        if (scale === 1 && isPng) continue; // petit png : on ne touche pas (transparence)
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        g.clearRect(0, 0, canvas.width, canvas.height);
        g.drawImage(img, 0, 0, canvas.width, canvas.height);
        let hasAlpha = false;
        if (isPng) {
          const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let i = 3; i < d.length; i += 4 * 97) if (d[i] < 250) { hasAlpha = true; break; }
        }
        const url = hasAlpha ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", quality);
        await new Promise((r) => { img.onload = img.onerror = r; img.src = url; });
      }
    }, compress);
  }
  await page.emulateMedia({ media: "print" });
  return page;
}

async function toPdf(page, pdfOpts, withChrome) {
  return page.pdf({
    format: pdfOpts.format,
    margin: withChrome ? pdfOpts.margin : { top: 0, right: 0, bottom: 0, left: 0 },
    printBackground: true,
    preferCSSPageSize: false,
    displayHeaderFooter: withChrome,
    headerTemplate: pdfOpts.headerTemplate,
    footerTemplate: pdfOpts.footerTemplate,
  });
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
  const out = await PDFDocument.create();
  const cover = coverBytes ? await PDFDocument.load(coverBytes) : null;
  const body = await PDFDocument.load(bodyBytes);
  const coverPages = cover ? await out.copyPages(cover, cover.getPageIndices()) : [];
  const bodyPages = await out.copyPages(body, body.getPageIndices());
  [...coverPages, ...bodyPages].forEach((p) => out.addPage(p));
  const offset = coverPages.length;

  out.setTitle(meta.title || "");
  if (meta.author) out.setAuthor(meta.author);
  out.setCreator("notion2pdf");
  out.setProducer("notion2pdf / Chromium");

  // Fond de page : Chromium ne peint pas les marges, on glisse un aplat sous chaque page
  if (meta.pageBackground) paintBackground(out, meta.pageBackground, offset);

  // Signets (outline) : un par section, hiérarchisés par profondeur
  const entries = sectionsInfo
    .filter((s) => pageOf.sections[s.id])
    .map((s) => ({ ...s, pageIndex: offset + pageOf.sections[s.id] - 1 }));
  if (entries.length) addOutline(out, entries);

  return out.save();
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
  pdfOpts.headerTemplate = sub(pdfOpts.headerTemplate, doc.vars);
  pdfOpts.footerTemplate = sub(pdfOpts.footerTemplate, doc.vars);

  const workDir = opts.keepHtml ? path.resolve(opts.keepHtml) : fs.mkdtempSync(path.join(os.tmpdir(), "notion2pdf-html-"));
  fs.mkdirSync(workDir, { recursive: true });

  const browser = await launch();
  try {
    let coverBytes = null;
    if (opts.cover !== false) {
      log("Couverture…");
      const p = await loadHtml(browser, doc.coverHtml, workDir, "cover", opts.compress);
      coverBytes = await toPdf(p, pdfOpts, false);
      await p.close();
    }

    log("Corps du document (passe 1)…");
    let bodyHtml = doc.bodyHtml;
    let p = await loadHtml(browser, bodyHtml, workDir, "document", opts.compress);
    let bodyBytes = await toPdf(p, pdfOpts, true);
    await p.close();

    let pageOf = { sections: {}, headings: {} };
    if (opts.pageNumbers !== false) {
      pageOf = await locateMarkers(bodyBytes);
      log(`Numérotation du sommaire (passe 2, ${pageOf.numPages} pages)…`);
      bodyHtml = fillTocNumbers(bodyHtml, pageOf);
      p = await loadHtml(browser, bodyHtml, workDir, "document", opts.compress);
      bodyBytes = await toPdf(p, pdfOpts, true);
      await p.close();
    }

    log("Assemblage…");
    const finalBytes = await assemble(coverBytes, bodyBytes, doc.sections, pageOf, {
      title: doc.vars.title, author: doc.vars.author, pageBackground: theme.config.pageBackground,
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
