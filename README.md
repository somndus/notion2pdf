# notion2pdf

Convertit un export **HTML Notion** (avec ses sous-pages) en **un seul PDF** thémé :
couverture, sommaire cliquable avec numéros de page, signets, diagrammes Mermaid rendus.

Stack : Node.js + Playwright (Chromium headless). Pas d'interface, une ligne de commande.

## Installation

```bash
cd notion2pdf
npm install            # installe les dépendances et Chromium (≈150 Mo, une seule fois)
```

Node 18.17 ou plus récent. Si tu préfères utiliser ton Chrome déjà installé plutôt que
télécharger Chromium :

```bat
set NOTION2PDF_CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
```

## Usage

Dans Notion : `⋯` → *Exporter* → format **HTML**, *Inclure les sous-pages* coché. Puis :

```bash
node cli.js "Export-xxxx.zip"
node cli.js "Export-xxxx.zip" -t dojo -o GDD.pdf --version v0.3 --author "Mon Studio"
node cli.js ./dossier-deja-dezippe/ --keep-html ./build
```

| Option | Effet |
| --- | --- |
| `-o, --out` | fichier PDF de sortie (défaut : `<titre>.pdf`) |
| `-t, --theme` | nom d'un thème de `themes/` ou chemin d'un dossier de thème (défaut : `studio`) |
| `--list-themes` | liste les thèmes |
| `--root` | force la page racine (nom de fichier ou id) si la détection auto se trompe |
| `--title`, `--subtitle`, `--version`, `--author` | textes de la couverture / métadonnées |
| `--format A4\|Letter` | format de page |
| `--toc-depth n` | 1 = pages, 2 = + titres H1 Notion (défaut), 3 = + H2 |
| `--no-toc`, `--no-cover` | sans sommaire / sans couverture |
| `--no-page-numbers` | une seule passe (plus rapide, sommaire sans numéros) |
| `--keep-links` | garde les liens "sous-page" de Notion dans le texte |
| `--no-demote` | ne rétrograde pas les titres (par défaut H1 Notion → H2, le titre de page reste le seul H1) |
| `--image-width px`, `--image-quality q`, `--no-compress` | images redimensionnées (1600 px) et ré-encodées en JPEG (0.85) avant impression : PDF ~10× plus léger. `--no-compress` pour l'original |
| `--keep-html dossier` | conserve `document.html` et `cover.html` : ouvre-les dans Chrome pour ajuster un thème |
| `--lang` | langue (date de la couverture), défaut `fr` |

## Comment ça marche

1. `src/parse.js` dézippe, repère la page racine (celle qu'aucune autre ne référence)
   et suit récursivement les blocs *link-to-page* dans l'ordre d'apparition.
2. `src/merge.js` jette le CSS Notion, garde le HTML sémantique, réécrit liens et images,
   convertit les blocs Mermaid, génère couverture + sommaire, et assemble un seul HTML
   avec `themes/_base.css` + le thème.
3. `src/render.js` imprime avec Chromium en deux passes (la première sert à retrouver
   sur quelle page tombe chaque section, la seconde écrit les numéros dans le sommaire),
   puis fusionne couverture + corps avec pdf-lib et ajoute les signets.

## Créer un thème

Copie `themes/studio` vers `themes/mon-theme`. Un thème contient :

```
themes/mon-theme/
├─ theme.css      obligatoire — variables + touches perso
├─ theme.json     marges, pied de page, fond de page, titre du sommaire
├─ cover.html     optionnel — remplace themes/_cover.html
└─ fonts/         optionnel — Nom-Bold.woff2, Nom-Regular.woff2… déclarés automatiquement
```

`themes/_base.css` style **tous** les blocs qu'un export Notion peut contenir
(callouts, colonnes, tableaux, to-do, toggles, couleurs de fond, code, bookmarks…)
à partir de variables. Dans la plupart des cas un thème se résume à redéfinir ces
variables dans `theme.css` :

```css
:root {
  --paper: #fff;  --ink: #1b1d22;  --accent: #2e5aac;  --surface: #f4f6f9;
  --font-body: "Segoe UI", Arial, sans-serif;
  --font-display: var(--font-body);
  --fs-body: 10.5pt;  --fs-h1: 28pt;  --fs-h2: 16pt;
}
```

Puis à ajouter ce qui fait sa personnalité (`.page-header`, `h2`, `aside.callout`,
`.cover-*`, `.toc-*`…). Le HTML est sous tes yeux avec `--keep-html`.

`theme.json` :

```json
{
  "description": "affichée par --list-themes",
  "tocTitle": "Sommaire",
  "pageBackground": "#f7f1e6",
  "mermaidTheme": "neutral",
  "pdf": {
    "format": "A4",
    "margin": { "top": "18mm", "right": "17mm", "bottom": "20mm", "left": "17mm" },
    "headerTemplate": "<span></span>",
    "footerTemplate": "<div style=\"…\">{{title}} <span class=\"pageNumber\"></span></div>"
  }
}
```

- `pageBackground` : Chromium ne peint jamais les marges ; si ton papier n'est pas blanc,
  mets la couleur ici et elle sera peinte sous chaque page.
- `headerTemplate` / `footerTemplate` : HTML de Chromium, **styles inline uniquement**
  (pas de CSS externe), classes spéciales `pageNumber`, `totalPages`, `date`.
  Pour un fond coloré, ajoute `-webkit-print-color-adjust:exact`. `{{title}}`,
  `{{version}}`, `{{author}}` sont remplacés.

Polices : dépose `MaPolice-Regular.woff2`, `MaPolice-Bold.woff2`, `MaPolice-Italic.woff2`
dans `fonts/` et utilise `font-family: "MaPolice"`. Le poids est déduit du suffixe
(Light, Regular, Medium, SemiBold, Bold, Black ou un nombre).

Variables de `cover.html` : `{{title}} {{subtitle}} {{description}} {{version}} {{author}}
{{date}} {{year}} {{coverImage}}` et `{{#if version}}…{{/if}}`.

## Blocs Notion pris en charge

Titres, paragraphes, couleurs de texte et de fond, listes à puces / numérotées / to-do,
toggles (ouverts), citations, callouts (avec icône), colonnes, tableaux simples et bases
de données exportées en tableau, images, légendes, bookmarks, code (Mermaid rendu en
schéma), séparateurs, liens internes (réécrits en ancres), covers et icônes de page.

Non pris en charge : vidéos et embeds (ignorés), bases de données en vue galerie/board
(exportées par Notion comme tableau, donc affichées comme tel).
