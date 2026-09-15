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
npm run test:content  # release, metadata, link-context, and fixture checks
npx playwright install chromium webkit firefox
npm run test:browser  # production-preview browser and accessibility checks
```

Requires Node.js 24 (matching CI) and Python 3. Python's standard library packages the downloadable example before builds, type checks, and the development server.

## Structure

- `docs/` — documentation pages (Learn, Reference, Tooling surfaces).
- `src/pages/` — the landing page.
- `src/components/` — React components used by pages.
- `src/theme/prism-include-languages.ts` — custom `gsharp` syntax-highlighting grammar.
- `src/theme/DocItem/Content/` — a narrow wrapper supplying search version metadata.
- `src/theme/SearchBar/` — lazy local search using Pagefind's generated browser UI.
- `src/data/release.json` — the published package/version contract for marketing pages.
- `docusaurus.config.ts` — site configuration (URL, base path `/gsharp/`, navbar, footer).
- `sidebars.ts` — sidebar information architecture.

## Deployment

The site is built and deployed by `.github/workflows/pages.yml`. Pull requests build only; pushes to `main` deploy. Docs versioning is enabled: the unreleased docs are the "current" version, and released snapshots are cut with `npm run docusaurus docs:version <x.y>`.

The current docs are served at `/docs/next`; the first entry of `versions.json` supplies the default `/docs` snapshot. The 0.4 documentation was refreshed from `v0.4.591`, not from unreleased main. Preserve historical semantics and document IDs when updating a snapshot. Use relative Markdown file links within docs so Next articles stay in Next.

## Search and production preview

`npm run build` builds Docusaurus and indexes its output with Pagefind. Use `npm run serve` to preview search; `npm start` does not generate an index. Search loads only when opened, includes the active documentation version and unversioned pages, and can switch versions explicitly.

Pagefind's generated browser bundle is loaded directly from the same-origin `/pagefind/` assets. Do not rebundle its dynamic imports through Docusaurus: the published component package uses Vite-specific import hints that are not sufficient for this bundler. No hosted search provider or runtime API key is needed.

The MDX table-cell wrapper preserves token separators in minified HTML and weights diagnostic ID cells. Without separators, an ID and severity can become one indexed word (for example `GS0154Error`), hiding the canonical reference from exact-code searches. Operator shortcut buttons use concept names because punctuation-only queries do not produce search terms.

Production builds fail on broken links and anchors. CI runs content/type checks, browser/accessibility checks, and the published installation flow before deployment. Its existing non-PR compiler, benchmark, and quality-dashboard generation behavior is preserved.

## Examples and release updates

The homepage imports complete `samples/Website*.gs` files and their `.golden` outputs using the bundler's native source-asset support. They are also discoverable by the existing compiler conformance suite.

Run `python3 website/tests/verify-examples.py` from the repository root to check the advertised public template, SDK, and outputs. The script isolates the template hive and project in a temporary workspace, then cleans up. When changing the advertised release, update `src/data/release.json`, both current and released installation guides, and the matching snapshot together. A main-branch compiler pass alone does not prove public-package compatibility.

## Design and editorial maintenance

The Ember design uses semantic tokens in `src/css/custom.css`, page-specific CSS Modules, and standard Docusaurus components. The original hexagonal logo is retained. `static/img/ember-facets.svg` and `social-preview.svg` are original website artwork; the PNG social preview is rendered from that SVG at 1200 x 630.

The website's scoped `.editorconfig` preserves its existing LF line endings and two-space TypeScript/CSS indentation instead of inheriting the repository's C# defaults.

Inter's Latin variable WOFF2 is self-hosted under `static/fonts`, with its SIL Open Font License. It is the Google Fonts distribution of the [Inter project](https://github.com/rsms/inter); no font service is contacted at runtime. System fonts cover characters outside the subset.

The first modernization wave reviewed the original 48 current documents:

| Group | Editorial disposition |
| --- | --- |
| Introduction, installation, quickstart | Rewritten around first success, prerequisites, and explicit release/preview context. |
| Tour overview, first tutorial | Rewritten as a chapter map and an executable data-model walkthrough. |
| Other Tour chapters and tutorials | Technical examples retained; intentional descriptions, version-safe navigation, and shared reading treatment applied. |
| Guides and language bridges | Detailed explanations retained; surfaced through task/audience hubs with intentional descriptions and version-safe links. |
| Reference and extensions | Updated release snapshot, bounded long TOCs, repaired diagnostic destinations, and preserved historical anchors. |
| Tooling | Workflow-first discovery, formatter/analyzer pages included in the release snapshot, detailed references retained. |
| FAQ and release notes | Added adoption guidance, clear starting points, and release summaries before implementation history. |
| Design history, playground, quality dashboard | Technical/status content retained; improved discovery and descriptions without changing provenance or claiming browser execution. |
| Authoring guidance | Updated for local search, examples, design conventions, versions, and anchor preservation. |

The 0.3 archive retains its language content. Its changes are version-local links and long-reference TOC presentation only.

## Review and rollback

Check the homepage, hubs, installation, Tour, specification, diagnostics, and quality dashboard in both themes, at narrow and desktop widths. Run actual Safari visual checks alongside automated WebKit, Chromium, and Firefox coverage. Include keyboard, zoom, reduced-motion, and screen-reader review when publishing a major layout change.

After deployment, verify `/gsharp/`, direct documentation URLs, search assets and version filters, installation links, and the social image. Roll back through a normal revert and the existing Pages deployment; do not remove documentation versions or rewrite URLs as a rollback mechanism.

## Second-wave learning and application content

`samples/Trail` is an original, runnable G# workspace-inventory application. It demonstrates nullable filtering, data classes, directional channels, a bounded worker pool, scope ownership, disposal, and .NET IO/cryptography/JSON. Oahu and goo are linked as independent G# projects; their implementation code and assets were not copied.

`scripts/prepare-showcase.py` builds a deterministic, versioned download and the bundled demo's expected JSON. Versioned ZIPs are retained under `static/downloads` so published guides can keep linking to their matching project. The generated `src/data/trail-report.json` is not committed. `python3 website/tests/verify-trail.py` builds the actual download and verifies it against independent file hashes and failure cases.

The Kotlin and Swift bridges are available in current and 0.4 documentation and linked from the homepage, Learn, introduction, Tour, and sidebars. The G# counterparts are compiled with the published SDK; the Swift counterpart has its own runnable check.

Complete teaching examples are mapped to their source/golden fixtures in `tests/content.test.mjs`. Extend that mapping for new runnable examples; label excerpts and illustrative declarations instead of pretending every fence is standalone code. Focused assertions prevent the retired concurrency-import guidance from returning without banning legitimate historical explanations.

Editor images are captured from a real isolated VS Code profile, not generated imitations. `static/img/trail-editor.json` records the tool versions and source hash. Refresh the images and evidence when the demonstrated source or toolchain changes; do not bypass the consistency check.

## Visual baselines

```bash
npm run test:visual
# Deliberate, reviewed design changes only:
npm run test:visual -- --update-snapshots
```

The visual project uses Playwright's pinned Chromium on macOS 26 arm64, matching the dedicated `macos-26` CI job. Baselines cover representative desktop/narrow surfaces in both themes. Run them in the matching environment, wait for fonts and hydration, and review diffs rather than automatically accepting new images. The existing Chromium/WebKit/Firefox functional suite remains separate.

Release changes must keep `src/data/release.json`, SDK pins, matching snapshot instructions, downloadable examples, and capture evidence consistent. Retain old versioned downloads when creating a new one. Human participant studies and a hands-on screen-reader/touch-device publication review are not replaced by automated checks and must not be reported as performed when unavailable.

## Ten-pattern comparison and benchmark evidence

`/concurrency` presents all ten original Go/G# pairs from `samples/ConcurrencyPatterns`. Each pattern has a stated contract, checked cases, language-specific ergonomics, and limitations. The generated source/download data is separate from measured performance.

```bash
python3 website/tests/verify-concurrency-patterns.py --race
python3 website/tests/verify-swift.py
python3 -m unittest discover -s website/tests -p test_concurrency_snapshot.py
```

The comparison verifier builds the actual downloadable bundle, repeats each pair, checks their exact summaries, and verifies receive-only send rejection in both compilers. Its report is tied to the bundle hash. The Go race detector is additional evidence for Go, not an equivalent G# race-detector claim.

Review regressions also reject acquire-inside-worker source mutations and wrong-reason G# clock/overflow failures. The first is a structural ordering check, distinct from runtime active-work counters. The examples use asynchronous semaphore admission, explicitly owned timer handles, an empty G# scope, and checked SDK helper alternatives; the public notes distinguish verification scaffolding and cancellation classification from general guarantees.

Refresh the static workflow snapshot with an authenticated, read-only GitHub CLI:

```bash
python3 website/scripts/update_concurrency.py
# Reproduce a specific run:
python3 website/scripts/update_concurrency.py --run-id 34809938364
```

Main-branch publication builds refresh the snapshot; PR and visual builds use the checked-in data. The importer validates the three-run aggregate, build/run identity, source registry, modes, intervals, and finite values. Missing artifacts produce an explicit unavailable state; unexpected API/schema failures stop the refresh instead of silently retaining success-shaped data.

The importer fetches the scenario registry from the measured commit, not from a potentially different working tree. It preserves report-only warnings, JIT/AOT/Go separation, the actual range-of-run-medians interval method, compiler/runtime versions, visible CPUs, commit and artifact provenance, and retrieval/measurement times. Unpaired rows never acquire an invented Go counterpart.

The workflow benchmarks lower-level operations, not the teaching programs. Related-operation links do not claim whole-pattern timings. Do not update `bench/concurrency/baseline.json`, rerun heavyweight benchmarks, or infer a universal language winner as part of website publication.
