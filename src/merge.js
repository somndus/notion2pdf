// Assemble l'arbre de pages en un seul document HTML prêt à imprimer.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { idFromFilename } from "./parse.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function decodeHref(href) {
  try { return decodeURIComponent(href); } catch { return href; }
}
const esc = (s = "") => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Mini-moteur de template : {{var}}, {{#if var}}…{{/if}} */
export function renderTemplate(tpl, vars) {
  return tpl
    .replace(/{{#if (\w+)}}([\s\S]*?){{\/if}}/g, (_, k, body) => (vars[k] ? body : ""))
    .replace(/{{(\w+)}}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));
}

/** Charge un thème : CSS + config + template de couverture */
export function loadTheme(name) {
  const dir = path.isAbsolute(name) || name.includes(path.sep) ? path.resolve(name) : path.join(PKG_ROOT, "themes", name);
  if (!fs.existsSync(path.join(dir, "theme.css"))) throw new Error(`Thème introuvable : ${name} (${dir})`);
  const read = (f, fallback = "") => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8") : fallback);
  const config = JSON.parse(read("theme.json", "{}"));
  return {
    name: path.basename(dir),
    dir,
    config,
    baseCss: fs.readFileSync(path.join(PKG_ROOT, "themes", "_base.css"), "utf8"),
    css: read("theme.css"),
    coverTemplate: read("cover.html", fs.readFileSync(path.join(PKG_ROOT, "themes", "_cover.html"), "utf8")),
    fontsCss: buildFontFaces(path.join(dir, "fonts")),
  };
}

/** Génère des @font-face pour chaque fichier dans themes/<x>/fonts : Nom-Poids.woff2 → font-family "Nom" */
function buildFontFaces(fontsDir) {
  if (!fs.existsSync(fontsDir)) return "";
  const weights = { thin: 100, extralight: 200, light: 300, regular: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 };
  return fs.readdirSync(fontsDir)
    .filter((f) => /\.(woff2?|ttf|otf)$/i.test(f))
    .map((f) => {
      const base = f.replace(/\.[^.]+$/, "");
      const [family, ...rest] = base.split("-");
      const spec = (rest.join("-") || "regular").toLowerCase();
      const italic = /italic/.test(spec);
      const w = Object.entries(weights).find(([k]) => spec.includes(k))?.[1] ?? (parseInt(spec) || 400);
      return `@font-face{font-family:"${family}";src:url("${pathToFileURL(path.join(fontsDir, f)).href}");font-weight:${w};font-style:${italic ? "italic" : "normal"};font-display:block}`;
    })
    .join("\n");
}

/**
 * Nettoie le .page-body d'une page Notion et le renvoie en HTML.
 * - liens internes → ancres, images → file://, styles inline supprimés
 * - mermaid → <div class="mermaid">, toggles ouverts, titres rétrogradés
 */
function cleanBody(page, ctx) {
  const { $ } = page;
  const $body = $(".page-body").first();
  if (!$body.length) return "";

  // Liens
  $body.find("a[href]").each((_, a) => {
    const $a = $(a);
    const raw = $a.attr("href");
    if (/^(https?:|mailto:|tel:|#)/i.test(raw)) return;
    const [file, hash] = decodeHref(raw).split("#");
    if (file.endsWith(".html")) {
      const id = idFromFilename(path.basename(file));
      if (ctx.pageIds.has(id)) $a.attr("href", hash ? `#${hash}` : `#page-${id}`);
      else $a.attr("href", "#").addClass("link-missing");
    } else if (/\.(png|jpe?g|gif|webp|svg)$/i.test(file)) {
      // <a> autour d'une image : on garde l'ancre inerte
      $a.removeAttr("href");
    } else if (fs.existsSync(path.join(ctx.dir, file))) {
      $a.attr("href", pathToFileURL(path.join(ctx.dir, file)).href);
    }
  });

  // Sous-pages : figure.link-to-page → lien d'ancre (ou supprimé si le sommaire suffit)
  $body.find("figure.link-to-page").each((_, fig) => {
    const $a = $(fig).find("a").first();
    $(fig).replaceWith(`<p class="link-to-page"><a href="${esc($a.attr("href") || "#")}">${esc($a.text())}</a></p>`);
  });
  if (ctx.stripLinks) {
    $body.find("p.link-to-page").remove();
    // un titre qui ne précédait que ces liens devient orphelin : on l'enlève aussi
    $body.find("h1, h2, h3").each((_, h) => {
      let next = $(h).next();
      if (!next.length || /^h[1-6]$/i.test(next[0].tagName)) $(h).remove();
    });
  }

  // Images
  $body.find("img[src]").each((_, img) => {
    const src = decodeHref($(img).attr("src"));
    if (/^(https?:|data:)/i.test(src)) return;
    const abs = path.join(ctx.dir, src);
    if (fs.existsSync(abs)) $(img).attr("src", pathToFileURL(abs).href);
    else $(img).attr("alt", `[image manquante : ${src}]`);
  });

  // Colonnes : ratio Notion → flex
  $body.find(".column[data-notion-column-ratio]").each((_, col) => {
    $(col).attr("data-ratio", $(col).attr("data-notion-column-ratio"));
  });

  // Styles inline : on jette tout, le thème décide
  $body.find("[style]").removeAttr("style");
  $body.find(".column[data-ratio]").each((_, col) => {
    $(col).attr("style", `flex:${parseFloat($(col).attr("data-ratio")) || 1} 1 0`);
  });

  // Scripts/CSS externes injectés par Notion (prism…) : inutiles hors ligne
  $body.find("script, link").remove();

  // Mermaid → rendu par mermaid.js au moment de l'impression
  $body.find("pre.code").each((_, pre) => {
    const $pre = $(pre);
    const lang = ($pre.attr("data-notion-code-syntax") || $pre.find("code").attr("class") || "").toLowerCase();
    if (/mermaid/.test(lang)) {
      $pre.replaceWith(`<div class="mermaid">${esc($pre.find("code").text())}</div>`);
      ctx.hasMermaid = true;
    }
  });

  // Toggles : ouverts pour l'impression
  $body.find("details").attr("open", "");

  // Titres rétrogradés d'un niveau (h1 → h2…) pour que le titre de page reste le seul h1
  if (ctx.demoteHeadings) {
    for (const lvl of [3, 2, 1]) {
      $body.find(`h${lvl}`).each((_, h) => {
        const $h = $(h);
        const attrs = Object.entries(h.attribs || {}).map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
        $h.replaceWith(`<h${lvl + 1}${attrs}>${$h.html()}</h${lvl + 1}>`);
      });
    }
  }

  // Marqueurs invisibles sur les titres du sommaire (pour retrouver leur numéro de page)
  for (let l = 2; l <= ctx.tocDepth; l++) {
    $body.find(`h${l}[id]`).each((_, h) => {
      // placé avant le titre (pas dedans) pour ne pas subir text-transform/letter-spacing du thème
      $(h).before(`<span class="pg-marker">hd:${esc($(h).attr("id"))}</span>`);
    });
  }

  $body.find("p.page-description").each((_, p) => { if (!$(p).text().trim()) $(p).remove(); });
  $body.find("[dir]").removeAttr("dir");
  $body.find("[data-notion-page-id],[data-notion-space-id]").removeAttr("data-notion-page-id data-notion-space-id");

  return $body.html();
}

/** Extrait les entrées de sommaire (titres) d'un HTML de page nettoyé */
function collectHeadings(html, tocDepth) {
  if (tocDepth < 2) return [];
  const $ = cheerio.load(html);
  const levels = [];
  for (let l = 2; l <= tocDepth; l++) levels.push(`h${l}`);
  const out = [];
  $(levels.join(",")).each((_, h) => {
    if (!$(h).attr("id")) return;
    const $h = $(h).clone(); $h.find(".pg-marker").remove();
    out.push({ level: parseInt(h.tagName[1]), id: $(h).attr("id"), title: $h.text().trim() });
  });
  return out;
}

/**
 * Construit le document.
 * @returns {{ coverHtml, bodyHtml, hasMermaid, sections: [{id,title,depth}] }}
 */
export function buildDocument(tree, theme, opts = {}) {
  const { root, pages, dir } = tree;
  const tocDepth = opts.tocDepth ?? 2;
  const ctx = { dir, pageIds: new Set(pages.map((p) => p.id)), hasMermaid: false, demoteHeadings: opts.demoteHeadings !== false, tocDepth,
    stripLinks: opts.toc !== false && opts.keepLinks !== true };
  const title = opts.title || root.title;
  const now = new Date();
  const vars = {
    title,
    subtitle: opts.subtitle || "",
    description: root.description || "",
    version: opts.version || "",
    author: opts.author || "",
    date: now.toLocaleDateString(opts.locale || "fr-FR", { year: "numeric", month: "long", day: "numeric" }),
    year: now.getFullYear(),
    coverImage: root.cover && fs.existsSync(path.join(dir, decodeHref(root.cover)))
      ? pathToFileURL(path.join(dir, decodeHref(root.cover))).href : "",
    coverBackdrop: (theme.config.coverBackdrop && fs.existsSync(path.join(theme.dir, theme.config.coverBackdrop)))
      ? pathToFileURL(path.join(theme.dir, theme.config.coverBackdrop)).href : "",
  };

  // Sections
  const sections = [];
  const sectionHtml = pages.map((page) => {
    const body = cleanBody(page, ctx);
    const headings = collectHeadings(body, tocDepth);
    sections.push({ id: page.id, title: page.title, depth: page.depth, headings });
    const cover = page.depth > 0 && page.cover && fs.existsSync(path.join(dir, decodeHref(page.cover)))
      ? `<img class="section-cover" src="${pathToFileURL(path.join(dir, decodeHref(page.cover))).href}" alt="">` : "";
    const desc = page.description ? `<p class="page-description">${esc(page.description)}</p>` : "";
    const icon = page.icon ? `<span class="page-icon">${esc(page.icon)}</span>` : "";
    return `
<section class="page depth-${page.depth}" id="page-${page.id}" data-title="${esc(page.title)}">
  <header class="page-header">${cover}<span class="pg-marker">pg:${page.id}</span>${icon}<h1 class="page-title">${esc(page.title)}</h1>${desc}</header>
  <div class="page-body">${body}</div>
</section>`;
  });

  // Sommaire
  let tocHtml = "";
  if (opts.toc !== false) {
    const items = [];
    for (const s of sections) {
      if (s.depth === 0 && opts.tocIncludeRoot === false) continue;
      items.push(`<li class="toc-page toc-depth-${s.depth}"><a href="#page-${s.id}"><span class="toc-title">${esc(s.title)}</span><span class="toc-num" data-target="${s.id}"></span></a>`);
      if (s.headings.length) {
        items.push(`<ul>${s.headings.map((h) => `<li class="toc-h toc-h${h.level}"><a href="#${esc(h.id)}"><span class="toc-title">${esc(h.title)}</span><span class="toc-num" data-heading="${esc(h.id)}"></span></a></li>`).join("")}</ul>`);
      }
      items.push(`</li>`);
    }
    tocHtml = `
<nav class="toc" id="toc">
  <h1 class="toc-heading">${esc(opts.tocTitle || theme.config.tocTitle || "Sommaire")}</h1>
  <ul class="toc-list">${items.join("\n")}</ul>
</nav>`;
  }

  const mermaidTag = ctx.hasMermaid
    ? `<script src="${pathToFileURL(path.join(PKG_ROOT, "node_modules/mermaid/dist/mermaid.min.js")).href}"></script>
<script>
  window.__mermaidDone = false;
  document.addEventListener("DOMContentLoaded", async () => {
    try {
      mermaid.initialize({ startOnLoad: false, theme: ${JSON.stringify(theme.config.mermaidTheme || "neutral")}, securityLevel: "loose" });
      await mermaid.run({ querySelector: ".mermaid" });
    } catch (e) { console.error("mermaid", e); }
    window.__mermaidDone = true;
  });
</script>` : "";

  const head = (extra = "") => `<!doctype html>
<html lang="${esc(opts.lang || "fr")}">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
${theme.fontsCss}
${theme.baseCss}
/* ---- thème : ${theme.name} ---- */
${theme.css}
</style>
${extra}
</head>`;

  const coverHtml = `${head()}
<body class="cover-body theme-${esc(theme.name)}">
${renderTemplate(theme.coverTemplate, vars)}
</body></html>`;

  const bodyHtml = `${head(mermaidTag)}
<body class="doc-body theme-${esc(theme.name)}" data-title="${esc(title)}">
${tocHtml}
${sectionHtml.join("\n")}
</body></html>`;

  return { coverHtml, bodyHtml, hasMermaid: ctx.hasMermaid, sections, vars };
}

/** Injecte les numéros de page dans le sommaire (2e passe) */
export function fillTocNumbers(bodyHtml, pageOf) {
  return bodyHtml
    .replace(/<span class="toc-num" data-target="([^"]+)"><\/span>/g, (m, id) => pageOf.sections[id] ? `<span class="toc-num">${pageOf.sections[id]}</span>` : m)
    .replace(/<span class="toc-num" data-heading="([^"]+)"><\/span>/g, (m, id) => pageOf.headings[id] ? `<span class="toc-num">${pageOf.headings[id]}</span>` : m);
}
