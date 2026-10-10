# DRAFT: release notes for the 0.5 line

> **DRAFT. Not published.** This file is not part of the website. It collects
> the toolchain-change text for the first G#-built release so that it doesn't
> live in `website/docs/release-notes.md` too early. At the freeze, that
> file's "Unreleased" section becomes the 0.4.NNNN section (see
> [`final-csharp-release.md`](final-csharp-release.md)). This draft moves
> there only when the first 0.5 release is cut.
>
> The owner decisions D1-D12 of the self-hosting plan (#3501, comment of
> 2026-10-01) are recorded below as decided. Remaining `(Confirm ...)` and
> placeholder items must be resolved before publishing. At the cut-over the
> final text moves to `website/docs/release-notes.md` (see
> `docs/cutover-staged/README.md`, which is deleted once applied).
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
  Under [ADR-0198](../adr/0198-isolated-stage-2-self-host-certification.md),
  the cut-over is accepted only when stage 1 and stage 2 produce identical PE
  bytes for `GSharp.Core.dll` and `gsc.dll`, except only the structurally
  validated 16-byte `Module.Mvid` GUID slot, and `RefactoringBaselineTests`,
  Core.Tests and Compiler.Tests pass under stage 2 (#4631).
- After 0.5.x is published, the pin moves from 0.4.NNNN to a 0.5 release.
  From then on, each release is built by an earlier G# release.

Where the C# source went (owner decision D2):

- The C# source of 0.4.NNNN stays on branch `cs2gs/csharp-0.4`. The branch is
  **semi-frozen**: it gets no bug fixes and no features. It is a living C#
  corpus for cs2gs, so code is occasionally back-ported from G# to C# when it
  merits exercising cs2gs, and a security fix, if one is ever required, is
  released as `0.4.NNNN+k`.
- All development, including fixes, happens in G# on `main`, never on the C#
  branch.
- cs2gs's nightly run migrates a pinned commit of the branch, together with
  Oahu and Code Exploder.
- The Visual Studio extension (`src/vs-gsharp`) is still C#; it is not part of
  the translation.

A rule for compiler contributors (owner decision D4): the "N-1 rule". The
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
(owner decision D7). None of these changes what the compiler does:

- **Regions.** `#region` blocks are not in the G# source. License headers are
  preserved.
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
- **Conditional compilation.** G# has no `#if`. cs2gs reports `#if`/`#elif` as
  an error instead of silently choosing a branch, and the compiler source was
  free of them before translation (three test-only `#if DEBUG` sites were
  rewritten as runtime checks).
- *(placeholder)* Performance of the G#-built compiler compared with 0.4.NNNN
  (compile time, memory), once measured against the agreed budget
  (owner decision D11: aim for parity, 1.5x acceptable). Measured on the
  cut-over candidate: about 1.04x time and 1.02x peak memory; re-measure
  on the released bits.
