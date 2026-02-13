# GetSayvaWebsite

This repository is structured as a static GitHub Pages site.

## Deployment target
- The site content is published from the `docs/` directory.
- The Pages deployment workflow is at `.github/workflows/deploy-pages.yml`.
- `.nojekyll` is included to ensure GitHub Pages serves files exactly as-is.

## How to deploy
1. In GitHub repository settings, enable **Pages** and set **Source** to **GitHub Actions**.
2. Push to `main` (or run the workflow manually from the Actions tab).
3. GitHub Actions will deploy the `docs/` folder as a static site.
