---
title: "Introduction to G#"
sidebar_position: 1
draft: false
---

# Introduction to G#

G# is a modern, simple, and accessible programming language for the
.NET runtime. It draws on the everyday ergonomics of Go, Kotlin, and
Swift — small surface, explicit types, sealed hierarchies, nullable
handling that the binder helps you with — and compiles down to ordinary
managed assemblies that any .NET tool can consume.

If you already know .NET, G# gives you another way to build managed
assemblies and call CLR APIs — classes, interfaces, properties,
events, delegates, exceptions, async workflows, and so on — under the
normal `dotnet` toolchain. If you are coming from Go, Kotlin, Swift,
or TypeScript, much of the syntax will already feel familiar.

## How G# runs

Every driver parses, binds, lowers, and emits CIL. SDK projects use
the emitter through MSBuild. Direct `gsc` uses it both with and
without `/out`; without `/out`, `gsc` runs the emitted program
immediately. File-mode `gsi` and the interactive REPL also use the
emitter. G# function literals can be passed to CLR delegate parameters
on these file paths, including bare `gsc`.

The legacy tree-walking evaluator and its `--engine evaluator` /
`GSI_ENGINE=evaluator` forms were removed.
`gsi` now accepts only the `emit` engine choice.

The default emitted target framework is `net10.0`; the compiler also
recognizes `net8.0` and `net9.0` target framework mappings.

## Who G# is for

G# is for people who want a small, predictable language with direct
access to the .NET ecosystem. It is especially useful if you want to
learn or teach .NET without starting from C#, or if you prefer a
modern, Kotlin-/Swift-shaped syntax but still need CLR interop,
MSBuild projects, Portable PDBs, and the broader .NET ecosystem.

The language is still growing. The documentation highlights what
works today and calls out known implementation limits where they
matter.

The 0.4 line adds sound empty collection defaults, full boolean
patterns, `while let`, value-producing block expressions, native CLR
rectangular arrays, map iteration, explicit extension receivers,
goroutine-safe `SyncMap`, and SDK hot reload.

## Where to start

- [Install G#](/docs/getting-started/install) to set up the SDK,
  templates, or a source-built compiler.
- [Quickstart: Hello, G#](/docs/getting-started/quickstart) to compile
  and run your first program.
- [A Tour of G#](/docs/tour) for a short guided walk through syntax,
  types, control flow, concurrency, and .NET interop.
- [Tutorials](/docs/tutorials/getting-started) for task-oriented
  walkthroughs.
- [Language specification](/docs/ref/spec) when you need the reference
  details.
