---
title: "Authoring these docs"
---

# Authoring these docs

This page documents the conventions for writing pages on the G# documentation site. It exists so that contributors — human or automated — can add or edit pages consistently.

The site is built with [Docusaurus](https://docusaurus.io/) and lives entirely under the `website/` directory of the [gsharp repository](https://github.com/DavidObando/gsharp). Public-facing pages are written fresh here; the implementation-oriented documents under `docs/` and the Architecture Decision Records under `docs/adr/` remain the authoritative source of design intent, and pages here should link back to them rather than duplicating them.

## Building and previewing locally

```bash
cd website
npm ci
npm start      # local dev server with hot reload
npm run build  # production build; fails on broken links
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

## Source material

The site content is grounded in two research artifacts produced while planning the site, plus the in-repo references:

- The language and tooling snapshot (lexical structure, full grammar, type system, concurrency, interop, tooling) — see the implementation sources under `src/Core/CodeAnalysis/` and the curated docs under `docs/`.
- The Architecture Decision Records under `docs/adr/` (numbered `0001`–`0053`+) explain *why* features work the way they do; link to the relevant ADR from guide and reference pages.
- `docs/diagnostics.md` is authoritative for diagnostic IDs (`GSxxxx`); the Diagnostics reference page must preserve those IDs exactly.

## Links

Use root-relative doc links (for example `/docs/ref/spec`) or relative Markdown links between pages. Avoid absolute `https://davidobando.github.io/gsharp/...` links within the site, because the base path (`/gsharp/`) is applied automatically and hard-coding it breaks local preview.
