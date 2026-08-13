---
title: "The REPL and script runner (gsi)"
sidebar_position: 2
draft: false
---

# The REPL and script runner (`gsi`)

`gsi` is G#'s interactive REPL and single-file script runner. It ships as
the [`Gsharp.Repl`](https://www.nuget.org/packages/Gsharp.Repl/) .NET
global tool and is the fastest way to try the language without creating a
project. It is a full-screen, keyboard-first TUI built on
Spectre.Console that reuses the same `Core` compilation engine and
`LanguageServer` analysis as the compiler, so the prompt behaves like a
small editor (live syntax colors, completion, hover, and diagnostics)
rather than a plain line reader.

## Install

`gsi` requires a .NET 10 runtime.

```sh
dotnet tool install --global Gsharp.Repl
```

Update or remove it with the usual global-tool commands:

```sh
dotnet tool update --global Gsharp.Repl
dotnet tool uninstall --global Gsharp.Repl
```

## Command-line usage

```text
Usage: gsi [file.gs] [/r:<assembly> ...] [--engine <name>] [--help] [--version]
  file.gs                Run the given G# script and exit.
  /r:<file>              Reference an assembly (repeatable).
  /reference:<file>      Alias for /r: (also -r: and --reference:).
  --engine <name>        Interactive engine: 'emit' (the default and only
                         engine; also via GSI_ENGINE). The legacy 'evaluator'
                         engine has been removed.
  --help, -h             Show this help and exit.
  --version              Show the gsi version and exit.
  (no args)              Start the interactive REPL.
```

### Interactive REPL

Run `gsi` with no arguments in an interactive terminal to open the REPL:

```sh
gsi
```

Each submission becomes a transcript "cell" (your input plus its result
or diagnostics). Because the session state carries forward, you can build
up definitions incrementally:

```gsharp
» let xs = [1, 2, 3]
» import System.Linq
» xs.Select((x int32) -> x * 2).Sum()
= 12
```

The REPL is organised into keyboard-selectable tabs — **REPL**,
**History**, **Variables**, **Diagnostics**, **Help**, and **Settings** —
and includes a command palette (open it with `:`) for session commands:

| Command | Effect |
| --- | --- |
| `reset` | Clear all accumulated session state and start fresh. |
| `clear` | Clear the current editor input. |
| `theme [name]` | Switch the color theme, or cycle themes when no name is given. |
| `load <file.gs>` | Evaluate a `.gs` file into the current session. |
| `exit` / `quit` | Leave the REPL. |

`gsi` needs an interactive terminal; if its input is redirected it exits
with a message instead of starting the UI.

### Run a script and exit

Pass a `.gs` file to emit and run it.
This is handy for quick experiments and shell one-offs — no `.gsproj`
required:

```sh
gsi hello.gs
```

```gsharp
package Hello

import System

func greet(name string) string {
    return "Hello, $name!"
}

Console.WriteLine(greet("world"))
```

Diagnostics are written to standard error, and the process exits with a
non-zero status if evaluation fails, so `gsi file.gs` composes cleanly in
scripts and CI checks.

Use `/r:<path>` or `/reference:<path>` to load an external runtime
assembly before evaluation:

```sh
gsi /r:/path/to/MyLibrary.dll hello.gs
```

The installed `Gsharp.Repl` tool bundles and loads `Gsharp.Extensions`
automatically, so scripts can use its optional and sequence helpers
without adding an explicit reference.

## How it relates to `gsc`

Every driver uses the emitter, including `gsi file.gs` and the
interactive REPL. `--engine emit` explicitly selects the only engine;
any other command-line or `GSI_ENGINE` value is rejected. Both direct
`gsc` modes use the emitter, with `/out:` only controlling whether the
assembly is saved. See the
[`gsc` reference](./gsc.md) and [introduction](../intro.md) for details.
