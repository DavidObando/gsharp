---
title: "Canonical formatting (gsfmt)"
sidebar_position: 2
draft: false
---

# Canonical formatting (`gsfmt`)

`gsfmt` is G#'s canonical formatter. It has no layout options: every source file uses 4-space indentation, K&R braces, a fixed 120-column width, no trailing whitespace, and exactly one final LF newline. Imports are sorted unless a comment or a duplicate local name makes reordering unsafe, duplicate blank lines collapse, comments retain their text and line structure, and formatting is rejected if the parsed program or comment set changes.

## Install

```sh
dotnet tool install --global Gsharp.Gsfmt
```

The formatter also ships inside `Gsharp.NET.Sdk`, and the language server calls the same `GSharp.Formatting` library in-process.

## Usage

```text
gsfmt [flags] [path ...]
  -w, --write        rewrite files in place
  -l, --list         print files that would change
      --check        exit 1 if any file would change
  -d, --diff         print a unified diff
      --stdin-name   diagnostic filename for standard input
```

Paths default to the current directory and directories recurse through `.gs` files. With redirected standard input and no paths, `gsfmt` reads stdin and writes the result to stdout. Parse or I/O errors exit 2; `--check` exits 1 only for unformatted input.

`bin/`, `obj/`, and `out/` directories below a formatted path, and `*.g.gs` files, are always excluded. A `.gsfmtignore` file uses gitignore-style patterns, with the nearest ancestor rules taking precedence.

## Build and editor integration

The VS Code extension enables format-on-save for G# by default. LSP formatting options such as tab size are ignored so editor output cannot diverge from CI.

SDK projects can opt into a check-only build gate:

```xml
<PropertyGroup>
  <GsharpFormatOnBuild>true</GsharpFormatOnBuild>
</PropertyGroup>
```

The build never rewrites source. Repository CI should run `gsfmt --check`.
