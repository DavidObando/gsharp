# G# documentation website

This directory contains the source for the official G# documentation website, built with [Docusaurus](https://docusaurus.io/) and published to GitHub Pages at **https://davidobando.github.io/gsharp/**.

See `docs/contributing/docs-authoring.md` for content conventions.

## Local development

```bash
npm ci      # install dependencies
npm start   # start the dev server with hot reload
npm run build   # production build (fails on broken links)
npm run serve   # serve the production build locally
npm run typecheck   # TypeScript type checking
```

Requires Node.js 24 (matching CI).

## Structure

- `docs/` — documentation pages (Learn, Reference, Tooling surfaces).
- `src/pages/` — the landing page.
- `src/components/` — React components used by pages.
- `src/theme/prism-include-languages.ts` — custom `gsharp` syntax-highlighting grammar.
- `docusaurus.config.ts` — site configuration (URL, base path `/gsharp/`, navbar, footer).
- `sidebars.ts` — sidebar information architecture.

## Deployment

The site is built and deployed by `.github/workflows/pages.yml`. Pull requests build only; pushes to `main` deploy. Docs versioning is enabled: the unreleased docs are the "current" version, and released snapshots are cut with `npm run docusaurus docs:version <x.y>`.
