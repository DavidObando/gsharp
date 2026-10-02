# DRAFT: release notes for the 0.5 line

> **DRAFT. Not published.** This file is not part of the website. It collects
> the toolchain-change text for the first G#-built release so that it doesn't
> live in `website/docs/release-notes.md` too early. At the freeze, that
> file's "Unreleased" section becomes the 0.4.NNNN section (see
> [`final-csharp-release.md`](final-csharp-release.md)). This draft moves
> there only when the first 0.5 release is cut.
>
> Items marked **pending D*n*** depend on an owner decision in the self-hosting
> assessment (section 7) and must be confirmed or rewritten before publishing.
> The stage-2 shipping rule follows the owner decision recorded in #4631.
> `0.4.NNNN` is the final C#-built release; `0.5.x` is the first 0.5 version
> number NBGV produces.

The headings follow the "Unreleased" section of
`website/docs/release-notes.md` (Reader's overview, Breaking changes, Added,
Fixed), plus the "Known limitations" heading earlier releases use.

## 0.5.x

### Reader's overview

**The G# compiler is now written in G#.** Starting with 0.5, the compiler,
language server, formatter and tools in this repository are G# source.
cs2gs, the project's own C#-to-G# translator, converted them from the C#
source of the final C#-built release, `0.4.NNNN`. Nothing changes in how you
install or use G#: the package ids, the `Gsharp.NET.Sdk` project SDK, the
`dotnet new` templates, and the VS Code and Visual Studio extensions are the
same.

How 0.5 is built (owner decision recorded in #4631; the assessment's D3
had suggested shipping stage 1 first):

- **Stage 1 (bootstrap, not shipped):** the G# source is compiled by the
  published `Gsharp.NET.Sdk` **0.4.NNNN**, the final C#-built SDK, pinned once
  in the repository's `global.json` `msbuild-sdks`.
- **Stage 2 (what 0.5.x ships):** the G# source compiled again by the
  stage-1 compiler, so the shipped compiler is built by a G#-built compiler.
  The cut-over is accepted only when stage 1 and stage 2 produce
  IL/metadata-identical `GSharp.Core.dll` and `gsc.dll` (MVIDs zeroed), and
  `RefactoringBaselineTests`, Core.Tests and Compiler.Tests pass under stage 2
  (#4631).
- After 0.5.x is published, the pin moves from 0.4.NNNN to a 0.5 release.
  From then on, each release is built by an earlier G# release.

Where the C# source went (**pending D2**; the assessment recommends this
policy):

- The C# source of 0.4.NNNN stays on branch `cs2gs/csharp-0.4`. The branch is
  **frozen except for security fixes**, released as `0.4.NNNN+k`. Nothing is
  back-ported to it.
- All development, including fixes, happens in G# on `main`.
- The branch also serves cs2gs as a pinned C# corpus.

A rule for compiler contributors (**pending D4**): the "N-1 rule". The
compiler's own source may use only language features that the **pinned**
released compiler supports. A PR that adds a language feature must not use
that feature in compiler source until a release containing it becomes the pin.

Before moving an application to 0.5, pin the intended SDK, select its
documentation, run the project's tests, and review the affected diagnostics.

### Breaking changes

- **Assembly version 0.5.0.0.** The minor-version bump changes the
  `AssemblyVersion` of `GSharp.Core` and the other compiler assemblies to
  `0.5.0.0`. A G# analyzer built against 0.4's `GSharp.Core` still loads, but
  reports `GS9303` (an analyzer was built against a different `GSharp.Core`
  version than the host). **Remedy:** rebuild the analyzer against 0.5.
- **Fail-fast `!!`.** The compiler is G# translated from C#, so places where
  C# trusted a value to be non-null (`!`) are now `!!`: a runtime check that
  throws `NullReferenceException` at the site instead of carrying null onward
  (issue #4612). Valid input should behave the same as 0.4.NNNN. If a 0.5
  compiler, language server or tool reports an internal error (`GS9998`) with a
  null-reference trace on input that 0.4.NNNN accepted, please file it with the
  input.
- *(placeholder)* Language and diagnostic breaking changes merged after
  0.4.NNNN go here, in the format of the existing sections: rule, example,
  **Remedy**.

### Added

- *(placeholder)* Language features merged after 0.4.NNNN. Each one is usable
  by G# programs immediately. Under the N-1 rule, the compiler's own source
  can use it only once a release containing it is the pinned SDK.
- *(placeholder)* Tooling and SDK additions.
- *(placeholder)* The stage-2 self-hosting check in CI (the
  stage-1/stage-2 equivalence gate).

### Fixed

- *(placeholder)* Fixes merged after 0.4.NNNN.

### Known limitations

Translating the compiler from C# to G# lost some things, by decision
(**pending D7**). None changes what the compiler does:

- **File headers and regions.** Copyright headers and `#region` blocks are not
  in the G# source.
- **Warning pragmas.** Only G# analyzer (`GSA*`) and nullable (`CS86xx`)
  suppressions were carried over, as `@SuppressDiagnostic`. Other
  `#pragma warning` lines were dropped.
- **Layout.** Some blank lines inside bodies are gone.
  - Static members of a type are grouped in a trailing `shared { }` block, so
    they appear in a different order than in the C# file.
  - `public`/`sealed` modifiers that G# does not spell are omitted.
- **Git history.** History for compiler source restarts at the cut-over
  commit; `git blame` does not follow a `.cs` file to its `.gs` successor. The
  cut-over commit message names the final C# commit and the tag `v0.4.NNNN`.
- **`!!` density.** The translated source has many `!!` assertions where the G#
  compiler could not prove that a value is non-null. Reducing them is ongoing
  cleanup.
- **Conditional compilation.** Translation resolved `#if` blocks, so code under
  a configuration the translation didn't use is gone. Three test-only
  `#if DEBUG` sites were affected (a Release-only assertion in the channel
  tests); they are rewritten as runtime checks before the cut-over.
  *(Confirm the final state.)*
- *(placeholder)* Performance of the G#-built compiler compared with 0.4.NNNN
  (compile time, memory), once measured against the agreed budget
  (**pending D11**).
