# notion2pdf

```bash
set NOTION2PDF_CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
:: sans Chrome, Edge marche aussi :
set NOTION2PDF_CHROME="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

:: GDD Absolute Sumo (box art + logo du site copiés dans ..\brand)
node cli.js ..\as_export.zip -t comics -o ..\02_AbsoluteSumo_GDD.pdf --version v0.3 --author "SCHARTIER Isaac" --lang en --cover-image ..\brand\boxart.webp --logo ..\brand\logo-1400.webp

:: aperçu rapide (10 premières pages) pour régler le thème
node cli.js ..\as_export.zip -t comics -o ..\preview.pdf --cover-image ..\brand\boxart.webp --logo ..\brand\logo-1400.webp --max-pages 10
```
