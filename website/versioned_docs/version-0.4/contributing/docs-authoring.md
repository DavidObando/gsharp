---
title: "Authoring these docs"
description: "Write and preview G# documentation with verified examples and version-safe links."
---

# Authoring these docs

This page documents the conventions for writing pages on the G# documentation site. It exists so that contributors — human or automated — can add or edit pages consistently.

The site is built with [Docusaurus](https://docusaurus.io/) and lives entirely under the `website/` directory of the [gsharp repository](https://github.com/DavidObando/gsharp). Public-facing pages are written fresh here; the implementation-oriented documents under `docs/` remain the authoritative source of design intent, and pages here should link back to them rather than duplicating them.

## Building and previewing locally

```bash
cd website
npm ci
npm start      # local dev server with hot reload
npm run build  # production build; fails on broken links
npm run serve  # production preview, including the generated search index
npm run typecheck
npm run test:content
```

The production build (`npm run build`) runs with `onBrokenLinks: 'throw'`, so a broken internal link fails the build and the CI check. Always run it before opening a pull request.

## Page conventions

Every page starts with YAML front matter. Always quote the `title` because many G# titles contain a colon:

```md
---
title: "Tutorial: Control flow"
sidebar_position: 4
---
```

Use sentence case for headings. Start each page with a single `#` H1 that matches the title, then use `##`/`###` for sections. Keep one concept per page where practical.

Write an intentional `description` in front matter: one concise sentence about what the reader will learn or accomplish. Lead with the user-facing concept or task before implementation history.

Do not hard-wrap continuous prose. Let the renderer handle line wrapping; only insert line breaks between paragraphs and list items. This keeps diffs small and readable.

## Code blocks

Use the `gsharp` language tag (aliases `gs` and `g#`) for G# code so it gets the custom syntax highlighting defined in `website/src/theme/prism-include-languages.ts`:

````md
```gsharp title="hello.gs"
package Hello

import System

Console.WriteLine("Hello, world!")
```
````

Use `csharp`, `go`, `bash`, and `json` for other languages. When showing program output, follow the code block with a plain ```` ```text ```` block.

### Prefer checked-in samples

Whenever possible, G# code shown in the docs should come from a real, compiling program checked in under the repository's `samples/` directory (each `samples/NAME.gs` may have a sibling `samples/NAME.golden` capturing its expected stdout). This guarantees the examples actually compile and run, because `SampleConformanceTests` builds every sample with `gsc`, runs it, and diffs stdout against the golden file.

When you add a new example to the docs:

- First check whether an existing sample demonstrates the feature.
- If you need a new example, add it under `samples/` (with a `.golden` if it produces output) so it is covered by conformance tests, then mirror it in the docs.
- Keep the docs copy faithful to the checked-in source; if you must trim it for brevity, keep it syntactically valid.

For expected-output blocks in tutorials and the Tour, copy the text from the sample's `.golden` file.

The homepage imports the complete `samples/Website*.gs` fixtures and their `.golden` output directly. Run `python3 website/tests/verify-examples.py` from the repository root when changing them or the advertised release. It checks the published template and SDK in an isolated workspace; a pass with a development compiler alone does not establish compatibility with the release.

## Source material

The site content is grounded in two research artifacts produced while planning the site, plus the in-repo references:

- The language and tooling snapshot (lexical structure, full grammar, type system, concurrency, interop, tooling) — see the implementation sources under `src/Core/CodeAnalysis/` and the curated docs under `docs/`.
- Design records explain *why* features work the way they do. End-user pages should not cite or link individual records; the single [Design decisions](../design-decisions.md) page is the only index for them.
- `docs/diagnostics.md` is authoritative for diagnostic IDs (`GSxxxx`); the Diagnostics reference page must preserve those IDs exactly.

## Links

Use **relative Markdown links between documentation pages**, including the `.md` or `.mdx` extension. They retain the selected documentation version. A root-relative `/docs/...` link inside Next instead sends the reader to the released snapshot.

From React marketing pages, use Docusaurus `Link` with site-relative paths. The homepage deliberately links to the release; an explicit Next link must be labeled as preview or as a current project snapshot.

Do not hard-code the deployed `/gsharp/` prefix in internal links. Preserve document IDs and existing anchors when changing headings; add a legacy anchor at the corresponding section when a rename is necessary.

## Versions and releases

`website/docs` is development documentation at `/docs/next`. The first entry in `versions.json` is the default released snapshot at `/docs`; older snapshots retain their versioned paths.

When refreshing a release, use the source from its actual Git tag, not a wholesale copy of unreleased main. The 0.4 snapshot was refreshed against `v0.4.591`. Update the advertised package in `src/data/release.json`, the matching installation instructions, and the public-installation checks together. Historical versions must retain their own syntax and commands.

## Presentation and search

Reuse the semantic tokens in `src/css/custom.css`, CSS Modules for page-specific layout, and native Docusaurus components. Keep code selectable, diagrams lightweight, and keyboard focus visible. Check narrow layouts, both themes, and reduced motion.

Pagefind indexes the production HTML after `npm run build`. Use `npm run serve` to check search; the hot-reload server does not generate an index. Search failure should be reported, not hidden.

Keep source and license information for font and image assets. Reference-site screenshots are design research, not artwork to redistribute in the website.
