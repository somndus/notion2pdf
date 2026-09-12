// Lit un export HTML Notion (zip ou dossier) et reconstruit l'arbre des pages.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import AdmZip from "adm-zip";
import * as cheerio from "cheerio";

/** Dézippe si besoin, renvoie le dossier contenant les .html */
export function prepareInput(input) {
  const stat = fs.statSync(input);
  if (stat.isDirectory()) return { dir: findHtmlRoot(input), cleanup: () => {} };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "notion2pdf-"));
  new AdmZip(input).extractAllTo(tmp, true);
  return { dir: findHtmlRoot(tmp), cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

/** Certains exports mettent tout dans un sous-dossier : on descend jusqu'aux .html */
function findHtmlRoot(dir) {
  let cur = dir;
  for (let i = 0; i < 4; i++) {
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name.endsWith(".html"))) return cur;
    const subdirs = entries.filter((e) => e.isDirectory());
    if (subdirs.length !== 1) break;
    cur = path.join(cur, subdirs[0].name);
  }
  throw new Error(`Aucun fichier .html trouvé dans ${dir}`);
}

/** L'id Notion est les 32 hex à la fin du nom de fichier */
export function idFromFilename(file) {
  const m = path.basename(file, ".html").match(/([0-9a-f]{32})$/i);
  return m ? m[1].toLowerCase() : path.basename(file, ".html");
}

function decodeHref(href) {
  try { return decodeURIComponent(href); } catch { return href; }
}

/** Trouve la page racine : celle qui n'est référencée par aucune autre (ou --root) */
export function findRoot(dir, explicitRoot) {
  const htmlFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".html"));
  if (explicitRoot) {
    const hit = htmlFiles.find((f) => f === explicitRoot || f.startsWith(explicitRoot) || idFromFilename(f) === explicitRoot);
    if (!hit) throw new Error(`Page racine introuvable : ${explicitRoot}`);
    return hit;
  }
  const referenced = new Set();
  for (const f of htmlFiles) {
    const $ = cheerio.load(fs.readFileSync(path.join(dir, f), "utf8"));
    $("a[href]").each((_, a) => {
      const href = decodeHref($(a).attr("href")).split("#")[0];
      if (href.endsWith(".html")) referenced.add(path.basename(href));
    });
  }
  const roots = htmlFiles.filter((f) => !referenced.has(f));
  if (roots.length === 1) return roots[0];
  // Plusieurs candidats : on prend celui qui a le plus de liens vers des sous-pages
  let best = htmlFiles[0], bestScore = -1;
  for (const f of roots.length ? roots : htmlFiles) {
    const n = (fs.readFileSync(path.join(dir, f), "utf8").match(/link-to-page/g) || []).length;
    if (n > bestScore) { best = f; bestScore = n; }
  }
  return best;
}

/**
 * Construit l'arbre : { id, file, title, description, cover, icon, $body, children[] }
 * $body = élément cheerio .page-body (les link-to-page sont conservés, réécrits plus tard)
 */
export function buildTree(dir, rootFile, opts = {}) {
  const visited = new Set();
  const pages = []; // ordre de lecture (préfixe)
  const maxDepth = opts.maxDepth ?? 10;

  function visit(file, depth) {
    const abs = path.join(dir, file);
    if (!fs.existsSync(abs) || visited.has(file)) return null;
    visited.add(file);

    const $ = cheerio.load(fs.readFileSync(abs, "utf8"));
    const page = {
      id: idFromFilename(file),
      file,
      depth,
      title: $("h1.page-title").first().text().trim() || $("title").text().trim() || path.basename(file, ".html"),
      description: $("p.page-description").first().text().trim(),
      cover: $("img.page-cover-image").attr("src") || null,
      icon: $(".page-header-icon").first().text().trim() || null,
      $,
      children: [],
    };
    pages.push(page);

    if (depth < maxDepth) {
      $(".page-body figure.link-to-page a[href], .page-body a.link-to-page[href]").each((_, a) => {
        const href = decodeHref($(a).attr("href")).split("#")[0];
        if (!href.endsWith(".html")) return;
        const child = visit(path.basename(href), depth + 1);
        if (child) page.children.push(child);
      });
    }
    return page;
  }

  const root = visit(rootFile, 0);
  const seen = new Set(pages.map((p) => p.file));
  const orphans = fs.readdirSync(dir).filter((f) => f.endsWith(".html") && !seen.has(f));
  return { root, pages, orphans, dir };
}
