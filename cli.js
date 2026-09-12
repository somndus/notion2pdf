#!/usr/bin/env node
// notion2pdf — export HTML Notion (zip ou dossier) → un seul PDF thémé
import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { prepareInput, findRoot, buildTree } from "./src/parse.js";
import { loadTheme, buildDocument } from "./src/merge.js";
import { renderPdf } from "./src/render.js";

const PKG_ROOT = path.dirname(new URL(import.meta.url).pathname);

const HELP = `
notion2pdf — convertit un export HTML Notion (avec sous-pages) en un seul PDF

Usage
  notion2pdf <export.zip | dossier> [options]

Options
  -o, --out <fichier>      PDF de sortie            (défaut : <titre>.pdf)
  -t, --theme <nom|dossier> Thème                    (défaut : studio)
      --list-themes        Liste les thèmes disponibles
      --root <fichier|id>  Force la page racine (sinon détectée automatiquement)
      --title <texte>      Titre du document (défaut : titre de la page racine)
      --subtitle <texte>   Sous-titre sur la couverture
      --version <texte>    Version affichée sur la couverture (ex : v0.4)
      --author <texte>     Auteur / studio (couverture + métadonnées PDF)
      --format <A4|Letter> Format de page          (défaut : celui du thème, sinon A4)
      --toc-depth <n>      Profondeur du sommaire : 1 = pages, 2 = + titres H1, 3 = + H2 (défaut : 2)
      --no-toc             Pas de sommaire
      --no-cover           Pas de page de couverture
      --no-page-numbers    Pas de numéros dans le sommaire (une seule passe, plus rapide)
      --no-demote          Ne pas rétrograder les titres (H1 Notion reste H1)
      --keep-links         Garder les liens "sous-page" de Notion dans le texte (retirés par défaut quand il y a un sommaire)
      --image-width <px>   Largeur max des images embarquées (défaut : 1600 ; 0 = pas de redimensionnement)
      --image-quality <q>  Qualité JPEG 0-1 (défaut : 0.85)
      --no-compress        Embarquer les images telles quelles (PDF beaucoup plus lourd)
      --keep-html <dossier> Conserve le HTML fusionné (pratique pour ajuster un thème dans le navigateur)
      --lang <code>        Langue du document / format de date (défaut : fr)
  -h, --help

Exemples
  notion2pdf Export.zip
  notion2pdf Export.zip -t dojo -o GDD.pdf --version v0.3 --author "Mon Studio"
  notion2pdf ./export-notion/ --keep-html ./build --no-page-numbers
`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      theme: { type: "string", short: "t", default: "studio" },
      "list-themes": { type: "boolean" },
      root: { type: "string" },
      title: { type: "string" },
      subtitle: { type: "string" },
      version: { type: "string" },
      author: { type: "string" },
      format: { type: "string" },
      "toc-depth": { type: "string", default: "2" },
      "no-toc": { type: "boolean" },
      "no-cover": { type: "boolean" },
      "no-page-numbers": { type: "boolean" },
      "no-demote": { type: "boolean" },
      "keep-links": { type: "boolean" },
      "keep-html": { type: "string" },
      "image-width": { type: "string", default: "1600" },
      "image-quality": { type: "string", default: "0.85" },
      "no-compress": { type: "boolean" },
      lang: { type: "string", default: "fr" },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (e) {
  console.error(`Erreur : ${e.message}\n${HELP}`);
  process.exit(2);
}
const { values: v, positionals } = args;

if (v.help) { console.log(HELP); process.exit(0); }

if (v["list-themes"]) {
  const dir = path.join(PKG_ROOT, "themes");
  for (const t of fs.readdirSync(dir)) {
    if (t.startsWith("_") || !fs.existsSync(path.join(dir, t, "theme.css"))) continue;
    let desc = "";
    try { desc = JSON.parse(fs.readFileSync(path.join(dir, t, "theme.json"), "utf8")).description || ""; } catch {}
    console.log(`  ${t.padEnd(14)} ${desc}`);
  }
  process.exit(0);
}

const input = positionals[0];
if (!input) { console.error(HELP); process.exit(2); }
if (!fs.existsSync(input)) { console.error(`Fichier introuvable : ${input}`); process.exit(2); }

const t0 = Date.now();
const log = (m) => console.log(`· ${m}`);

const { dir, cleanup } = prepareInput(input);
try {
  const theme = loadTheme(v.theme);
  const rootFile = findRoot(dir, v.root);
  const tree = buildTree(dir, rootFile);
  log(`Racine : ${tree.root.title}  (${tree.pages.length} page${tree.pages.length > 1 ? "s" : ""})`);
  for (const p of tree.pages.slice(1)) log(`${"  ".repeat(p.depth)}↳ ${p.title}`);
  if (tree.orphans.length) log(`Pages non reliées, ignorées : ${tree.orphans.map((f) => f.replace(/ [0-9a-f]{32}\.html$/, "")).join(", ")}`);

  const doc = buildDocument(tree, theme, {
    title: v.title, subtitle: v.subtitle, version: v.version, author: v.author,
    toc: !v["no-toc"], tocDepth: parseInt(v["toc-depth"]) || 2,
    demoteHeadings: !v["no-demote"], keepLinks: v["keep-links"], lang: v.lang, locale: v.lang === "fr" ? "fr-FR" : v.lang,
  });
  if (doc.hasMermaid) log("Diagramme(s) Mermaid détecté(s) : rendu via mermaid.js");

  const out = v.out || `${doc.vars.title.replace(/[\\/:*?"<>|]+/g, "-").trim() || "document"}.pdf`;
  const res = await renderPdf(doc, theme, {
    out, format: v.format, cover: !v["no-cover"], pageNumbers: !v["no-page-numbers"], keepHtml: v["keep-html"], log,
    compress: v["no-compress"] ? null : { maxWidth: parseInt(v["image-width"]) || 0, quality: parseFloat(v["image-quality"]) || 0.85 },
  });
  log(`OK → ${res.out}  (${res.pages} pages, thème ${theme.name}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  if (res.html) log(`HTML conservé dans ${res.html}`);
} catch (e) {
  console.error(`\nÉchec : ${e.message}`);
  if (process.env.DEBUG) console.error(e.stack);
  if (/Executable doesn't exist|browserType.launch/.test(e.message)) {
    console.error(`\nChromium n'est pas installé pour Playwright. Lance :  npx playwright install chromium\n` +
      `ou pointe vers ton Chrome :  set NOTION2PDF_CHROME="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"`);
  }
  process.exit(1);
} finally {
  cleanup();
}
