# Self-migration cut-over: procedure, mapping rules and dry run

Part of [#3501](https://github.com/DavidObando/gsharp/issues/3501) (Phase 3 of
the cut-over plan, gate criterion 8). The cut-over replaces the compiler's C#
source with the G# source that `cs2gs` produces, in one squash PR against the
frozen `main`. This page is the single record of how, so the step does not exist
only as harness behaviour.

The mechanics are code, not prose: [`build/cutover.py`](../build/cutover.py)
(`dry-run` and `hand-fix` subcommands, tests in
[`build/test-cutover.py`](../build/test-cutover.py)). The dry run and the real
cut-over run the same hand-fix code.

## What the repository looks like afterwards

The repository stays **mixed**. By owner decision the Visual Studio extension
(`src/vs-gsharp`: `VsGsharp`, `VsGsharp.CodeLens`, `VsGsharp.UnitTests`) stays C#.
It builds only under the Windows VSSDK toolchain, and it keeps its
`#if NETFRAMEWORK` blocks. A handful of other C# files also stay on purpose (see
"Mapping rules"). The consequences for the documents that are rewritten after the
cut-over (CLAUDE.md, CONTRIBUTING.md, CI):

- `nullable-hygiene` is retired (#4906): it existed to keep C# translatable to G#,
  and the C# that remains is never translated. The compiler's own nullable
  analysis (`TreatWarningsAsErrors`) still covers the VS extension.
- The "no `#if`" rule applies to the translated tree. The VS extension is
  exempt. cs2gs refuses `#if`, which is one reason the extension is not
  migrated.
- `Directory.Build.props` and `build/gsharp.build.props` stay (they serve both
  languages), so StyleCop/`LangVersion` stay in them. Only the per-project C#-only
  properties are stripped from `.gsproj` files.
- `build.yml` keeps a Windows job for `VsGsharp.sln`.

## Recording the translation

Record all of this in the PR body and in the squash commit:

| What | Value |
|---|---|
| Final C# commit and tag | `<sha>` / `v0.4.NNNN` |
| `Gsharp.Cs2Gs` version | the tool version used for `cs2gs migrate` (must equal the tag) |
| `Gsharp.NET.Sdk` pin | the version written to `global.json` `msbuild-sdks` (must equal the tag) |
| `Gsharp.Gsfmt` version | the formatter used for the clean check |
| Output of `cutover.py dry-run` | `dry-run.json` from the final rehearsal |

`dry-run.json` in the work root records the resolved versions and every stage
outcome. Commit it into the PR description, not the tree.

### Recorded values for the cut-over (tag `v0.4.1270`)

| What | Value |
|---|---|
| Final C# commit and tag | `eac5b487b16c7c63bce2a95151968dc2b581a57e` / `v0.4.1270` (branch `cs2gs/csharp-0.4` points at the same commit) |
| `Gsharp.Cs2Gs` version | `0.4.1270` (published, installed from nuget.org only) |
| `Gsharp.NET.Sdk` pin | `0.4.1270` (`global.json` `msbuild-sdks`; no versioned per-project pin survives) |
| `Gsharp.Gsfmt` version | `0.4.1270` |
| Output of `cutover.py dry-run` | the final rehearsal at the tag, 2026-10-13, work root `~/.cache/cutover-dryrun/work`; stage outcomes in "Final rehearsal at the matched tag" below |
| Translated tree this commit contains | the `migrate` output of that rehearsal, assembled and hand-fixed as in "Assembly" and "The hand-fix list" |
| Stage-2 certification of the same C# commit | certified: true on the dry-run tree (run `8d1e76c726801a48e1db4689b37db1da`, 2026-10-13/14, published bootstrap SDK 0.4.1270) and, earlier, on the tree of `eac5b487b` (second attempt); details in "Stage-2 certification" below |
| PR CI | green (37 checks pass, 3 skipped) on `e6a0c9f54`, run 38493756916. The head of the commit that records this line only changes documentation and is checked by its own run (see the PR) |

The cut-over commit is the dry run's `migrate` output assembled and hand-fixed by the same code,
with these deliberate differences, all found while preparing the commit:

- The mirror overwrites files that were already G# or that stay C#. These are not taken from it:
  `samples/**/*.gsproj` and `samples/HotReload/global.json` (per-project SDK pins the samples
  keep on purpose), `src/vs-gsharp/VsGsharp.sln` and the `src/vs-gsharp/test/*Fixtures` `.gsproj`
  files (pinned to `0.3.159` by an allow-list entry), and the build scripts that the phase-2
  branch had already changed (the mirror holds the text of the C# commit).
- Stray mirror outputs are not committed: the `.slnx` files written next to the kept `.sln` files
  (`src/vs-gsharp`, the `gsharp-xunit` template) and the `Gsharp.Extensions.xml` build artefact.
- `build/selfhost/PeBodyMutations.cs` stays C#. It is a file-based `dotnet run` helper that
  `build/test-selfhost-stage2.py` runs by file name, so its `.gs` translation cannot run. (The
  `assemble` stage would delete it because a `.gs` twin exists; this is a gap in the rule "a tracked
  `.cs` with a twin is deleted".)
- `GSA0001`-`GSA0003` are retired by hand (`docs/internal-analyzers.md`).
- `build/selfhost-stage2.py` names the two stage helpers `PackageContentHash.gs` and
  `TestSupervisorLogger.gs`; `build/test-selfhost-stage2.py` skips the C# corpus derivation test
  on a G# tree; `build/check-release-version-refs.py` allow-lists the bootstrap pin `0.4.1270`
  in `global.json` and `InternalAnalyzers.Tests.gsproj`.
- `build.yml` checks the final C# tag out beside the workspace, **builds it**, and exports
  `CS2GS_TEST_SOURCE_ROOT` for the `Cs2Gs.Tests` shards only (see "Source-inspection tests need the
  final C# tree"). Found by the first PR CI run: the variable names one directory that must hold both
  the original sources and the built toolchain (`out/bin/<Config>/nupkgs`), so an unbuilt checkout is
  not enough. The `tests` job timeout is 90 minutes instead of 30 until the shards are rebalanced from
  the first G# timings.
- The VS Code grammar test and `VsGsharp.UnitTests` read the compiler's keyword table and the language
  server sources as `.gs`.
- `build/cutover.py` itself is left as it was: the `hand-fix` stage rewrites its own `.csproj`
  literals, which would break `dry-run` against a C# commit.

Counts of the commit (`git diff --cached --name-status --no-renames`): 4,201 C# files deleted
(4,202 in the dry run, minus `PeBodyMutations.cs`), 4,209 files added (the mirror's 4,218 minus the
stray outputs, the retired GSA files and `PeBodyMutations.gs`, plus the files `apply.sh` adds).

## Translation command

Run from a **fresh clone** of the tag with only nuget.org as the NuGet source:

```sh
python3 build/cutover.py dry-run --commit v0.4.NNNN --pin 0.4.NNNN \
  --work-root ~/.cache/cutover/final          # never under /tmp
```

Under the hood the translate stage is:

```sh
cs2gs migrate --corpus <clone> --out <work>/migrated --artifacts <work>/runs \
  --config Release --sdk-version 0.4.NNNN --sdk-pin global-json \
  --csharp-test-oracle <work>/csharp-tests \
  $(the --exclude list parsed from build/selfmig-common.sh)
```

- `--config Release`; polish is part of the compile stage (the `!!` polish pass
  runs while the migrated apps compile), so the cut-over translation is the
  **full** `migrate`, not `--translate-only`. A translate-only tree is not
  committable: it fails with `GS0536` (redundant `!!`) on the first build.
- The formatter post-pass is on by default (`--format`).
- The `--exclude` set is read from the clone's own `build/selfmig-common.sh`, so
  the rehearsal and the nightly gate cannot disagree about what is a migration
  target.
- `--sdk-version`/`--sdk-pin global-json` come from #4643. A published tool older
  than that has neither flag.

### Why a rehearsal against the *published* `0.4.1150` is only an approximation

The real cut-over translates the tag with the cs2gs *of that tag*. Until the final
tag exists, the newest published pair is `0.4.1150`, which is **105 commits older
than main** and predates #4643. Running the published tool today differs from the
cut-over in these ways, all handled by the script and all reported as
"skew" rather than defects:

1. `0.4.1150` has no `--sdk-version`/`--sdk-pin`. Without them cs2gs writes a
   per-project `Sdk="Gsharp.NET.Sdk/<v>"` pin, taking `<v>` from a **local nupkg**
   it finds under `out/bin/<Config>/nupkgs`, and refuses to run if there is none.
   The script stages the byte-identical published nupkg there (after deleting every
   source-built SDK nupkg, so the only candidate is the published one) and the
   hand-fix list turns the per-project pins into the `global.json` pin.
2. The published tool ships neither `gsc` nor `gsgen` (it resolves them from
   `out/bin/<Config>`), so the script extracts both from the pinned
   `Gsharp.NET.Sdk` package and passes `--gsc`/`--gsgen`.
3. The published tool cannot find the repository root by walking up from its own
   assembly, so `CS2GS_TEST_SOURCE_ROOT` must point at the clone.
4. The translator is older than the source it translates. Any corpus fixture or
   source construct added after the tag can fail translation or compile.
   `tools/cs2gs/corpus/grid/G09-Functions-Console` (a ref-returning local
   function, `RefExpressionLocalFunction.cs`) is the first such case.
5. The SDK that compiles the output (`0.4.1150`) is older than the sources, so
   fixes in gsc made since the tag are absent.

At the real cut-over tool == SDK == tag == translated commit, so items 4 and 5
disappear. Items 1 to 3 disappear only if the released tool fixes them; until
then the script keeps handling them. They are filed as issues (see the dry-run
log).

The nearest equivalent that does not suffer items 4 and 5 is a rehearsal against a
**release-candidate tag**: tag `v0.4.NNNN-rc1` on the freeze commit, let `publish`
push the prerelease packages, and run the script with `--pin 0.4.NNNN-rc1`.
(`--pin` currently accepts `x.y.z`; prerelease support is a one-line change in
`VERSION_RE` and is worth doing when the RC exists.)

## Assembly: delete `.cs`, add `.gs`

`cs2gs migrate` writes a *separate* mirror tree. The cut-over commit is made by
overlaying it onto the checkout (`cutover.py` stage `assemble`):

- Every tracked `.cs` whose `.gs` twin (or split parts) exists in the mirror is
  deleted; every tracked `.csproj` whose `.gsproj` twin exists is deleted.
- Every mirror file is copied in (`bin/`, `obj/`, `.git`, `node_modules`,
  `TestResults` are never copied; `out/obj` junk in the mirror is therefore
  skipped).
- A tracked `.cs`/`.csproj` with **no** twin is **retained** and listed in the
  stage detail for review. It is never deleted silently (see "Retained C#").
- Paths under the excluded projects (`src/vs-gsharp`, the C# sample apps,
  `bench/concurrency/{clr,aot}`, `bench/go2gs-prerequisites/aot`,
  `tools/cs2gs/corpus/CompileGap-Library`) are untouched.

## Mapping rules

- **1:1 paths.** `dir/Name.cs` becomes `dir/Name.gs`; `Name.csproj` becomes
  `Name.gsproj`; partial classes stay one file each.
- **6 split files.** Five C# files produce six extra `.gs` files (the plan's "6 split
  files"), because a top-level construct needs its own file:
  `test/Core.Tests/CodeAnalysis/Binding/Issue2523NullableImportedGenericBaseConversionTests`
  (+ `.Issue2523Fixtures.gs`),
  `.../Issue2839MetadataNullableNavigationThenIncludeTests` (+ `.Issue2839Fixtures.gs`),
  `tools/cs2gs/Cs2Gs.Tests/Issue3460TranslatorTests` (+ `.Fixtures.gs`),
  `.../Issue3461ReservedMetadataFixtures` (+ `.ImportedVisible.gs` and `.class_.gs`),
  `.../Issue3466LateSignatureTypes` (+ `.Signatures.gs`).
  Regenerate this list with the "new `.gs` without a same-named `.cs`" query in the
  dry-run notes if it changes.
- **`shared {}` regrouping.** Static members of a type are regrouped into a
  trailing `shared { }` block in the `.gs` file (for example `Binder.gs`'s
  `BindGlobalScope` moves from the middle of the C# file to the `shared` block).
  By design, not a diff to chase.
- **Modifiers.** `public`/`sealed` are dropped where G# defaults match.
- **Nullability.** `?.` is preserved; C# `!` becomes `!!` (a real check); extra
  `!!` appears where gsc cannot prove a narrowing. The polish pass owns this.
- **Retained C#** (kept on purpose, not translated): the VS extension; the C# sample
  and benchmark apparatus; `samples/ForeignCompile/ThisAssembly.cs` (a foreign `.cs`
  the SDK translates at build time); `tools/cs2gs/Cs2Gs.Tests/Fixtures/Adr0169FunnelSurface/*.cs`
  (C# data the tests read as text). The mirror carries the last two verbatim (#4850),
  so the assemble step has nothing extra to keep.

## The hand-fix list, audited against the repository

The plan listed eight hand-fixes. Audited on `c2b079774` against a real mirror
made by the published tools. "Script" is the `hand-fix` step in `cutover.py`.

| # | Plan item | Today | Script |
|---|---|---|---|
| 1 | Re-enable `GeneratePackageOnBuild` | **Still needed, and for six projects, not one.** The mirror forces `false` everywhere; `Gsharp.NET.Sdk`, `Gsharp.Templates`, `Repl`, `Cs2Gs.Cli`, `Gsfmt.Cli` and `GSharp.CodeAnalysis.Analyzers.Testing` all pack on build in C#. The script reads the list from the C# commit. Missing it made `templates-e2e` fail (no `Gsharp.Templates` nupkg). | 1 |
| 2 | Rewrite the `Pack*` literal `.csproj` paths in `Gsharp.NET.Sdk.csproj` | **Automated by the mirror.** `Compiler`, `Gsfmt.Cli` and `Gsgen.Cli` come out as `.gsproj`. The one `Gsharp.Extensions.csproj` literal is correct, since that project stays `.csproj`. The script re-checks every literal anyway. | 2 |
| 3 | Rebind `Gsharp.Extensions` to the pinned SDK, drop the Bootstrap import and ordering ProjectReferences | **Automated by the mirror** (`RepositoryMirror`, #3772). The script verifies instead of editing and fails if a Bootstrap import or Compiler/SDK ordering reference returns. | 3 |
| 4 | Fix `VsGsharp.csproj:76` (LanguageServer path) | **Still needed**, same line today. Generalised: *any* kept-C# project that names a translated project's `.csproj` needs it. `bench/concurrency/clr/ClrBaseline.csproj` has the same defect (its Channels reference). | 2 |
| 5 | Replace `GSharp.sln` with the generated `.slnx`, check it lists every project | **Needed.** The mirror writes both; at the cut-over the `.slnx` stays and the `.sln` is dropped (#4861). The script deletes the `.sln`, compares every project of the original `.sln` (after `.csproj`→`.gsproj`) with the `.slnx`, and renames the `GSharp.sln` literal to `GSharp.slnx` in scripts and workflows (`build.yml`, the e2e scripts), which invoke it by name. Source files need no rewrite: cs2gs and the test projects find the repository root through one rule, `RepositoryRootMarker`, which accepts either spelling. | 4, 4b |
| 6 | Add `.gitattributes` | **Not needed.** It already exists and is carried over (it classifies `*.gs` for Linguist). The script only verifies the `*.gs` rule. | 5 |
| 7 | Delete the per-file SDK pins in favour of `global.json msbuild-sdks` | **Still needed with a tool that lacks `--sdk-pin`.** A tool that has it already writes the global pin. The script removes `Gsharp.NET.Sdk/<pin>` from `<Project Sdk>` (not from `<Import>`), writes `msbuild-sdks`, and reports any surviving versioned pin outside samples/templates/`src/vs-gsharp`. | 6 |
| 8 | Strip C#-only props (`LangVersion`, StyleCop) | **Narrower than listed.** Only `src/LanguageServer/LanguageServer.gsproj` carries `LangVersion`. StyleCop is applied by the shared `build/gsharp.build.props` (kept, the repo is mixed). | 7 |

Items found by the dry run that the plan did not list:

| Added | Why | Script |
|---|---|---|
| Rewrite `<name>.csproj` to `.gsproj` in `e2etests/*.sh`, `.github/workflows/*.yml`, `build/*.sh|py`, `src/vscode-gsharp`, `website/scripts` | About 130 files name translated projects. Without it the e2e scripts and workflows break. Only names with a `.gsproj` twin and no `.csproj` twin are rewritten, so fixtures such as `App.csproj` are not touched. | 2b |
| Teach the extension-based CI scripts `.gsproj` | `build/generate-ci-test-matrix.py` accepts only `*.tests.csproj` (it exits "Missing sharded test projects" on the migrated tree). Name rewriting cannot reach it; `EXTENSION_FIXES` patches it and the stage runs the matrix generator as a check. Other scripts that list `*.csproj` (`run-cs2gs-selfmig-pr-guard.sh`) are retired in Phase 4. | 2c |
| Reformat with `gsfmt --write` | The plan expected `gsfmt --check` clean. After polish it is not: 394 of 4,350 `.gs` files re-wrap (#4858). The script writes them and requires a clean re-check; commit the result as its own commit. | gsfmt stage |
| Keep the pin to the published artefacts | A source build of the C# solution (which `capture-test-oracle` triggers) packs `Gsharp.NET.Sdk.<v>-g<sha>` and `GSharp.CodeAnalysis.Analyzers.Testing.<v>-g<sha>`; a tool without `--sdk-version` then pins the whole tree to them (#4849). The script deletes every source-built copy before translating. | translate |
| Regenerate `packages.lock.json` | Established from the mirror: the 35 translated product projects (src, test, tools) DO carry a `packages.lock.json`, copied from their C# projects, while samples and templates never had one. The copies are stale for the `.gsproj` projects: the locked-mode restore CI uses fails with NU1004 on the first test project. | 8 |
| Retain untranslated C# the mirror lacks | Since #4850 the mirror carries `ForeignCompile` and the fixtures, so nothing is expected; any tracked `.cs` with no mirror twin is retained, listed, and fails the step for review. | assemble |

## Validation sequence (what the script runs)

1. `gsfmt --check .` with the published formatter. Expect clean; the stage detail
   records the `.gs` file count.
2. `dotnet build src/Core/Core.gsproj -c Release`: the quick "compile `src/Core`
   with the pinned SDK" smoke (it also builds `InternalAnalyzers`).
3. `dotnet restore GSharp.slnx --locked-mode` then
   `dotnet build GSharp.slnx -c Release --no-restore -graph`.
4. `build/run-e2e-tests.sh` (all sixteen e2e scripts; `--e2e sdk nuget-pack` selects
   some).
5. VS Code extension: `npm ci` and `npx vsce package --no-dependencies`.
6. Visual Studio VSIX: **needs Windows** (VSSDK/VSCT, net472). The script only
   checks statically that the `LanguageServer` path in `VsGsharp.csproj` resolves.
   The real build is the Windows `visual-studio-extension` job:
   `msbuild src\vs-gsharp\VsGsharp.sln /restore /t:Build /p:Configuration=Release`.
   That job must be green on the cut-over PR.

Not run by the script (PR CI only): the re-sharded `build.yml` test matrix, per-test
name parity against the tag's last C# nightly TRX files, the stage-2 job.

**Source-inspection tests need the final C# tree.** Tests such as `L1MigrationEndToEndTests` and
`Issue4545ManagedArrayProjectionSelfMigrationTests` read original C# files through
`CS2GS_TEST_SOURCE_ROOT` ([self-migration policy](self-migration-policy.md)). After the cut-over
those `.cs` files are gone from the tree, so the PR CI must check out the final C# commit (the
`v0.4.NNNN` tag, or `cs2gs/csharp-0.4`) into a second directory and export that variable, or the
tests must be rewritten or retired first (gate criterion 9). Do not rely on the migrated tree
providing them. The checkout alone is not enough: the variable also locates the built toolchain, so the
cut-over `build.yml` builds the checked-out C# solution before the `Cs2Gs.Tests` shards run.

## Rollback

- Any time before the first 0.5 tag: revert the squash commit. `cs2gs/csharp-0.4`
  stays the source of truth and the `0.4.NNNN` pin stays valid. The branch is
  semi-frozen: it may receive occasional back-ports from G# to C# when useful to
  exercise cs2gs, so rollback re-releases from its head, not necessarily the tag.
- After the first 0.5 tag: re-release from `cs2gs/csharp-0.4` as `0.4.NNNN+k`;
  keep that branch buildable (its CI is the cs2gs gate that consumes it).
- Nothing the rehearsal does touches `origin`: it clones, commits on a local
  `cutover/dry-run` branch, and never pushes.

## Squash commit message template

The history is a delete-`.cs`/add-`.gs` squash (rename detection will not pair
them). `cutover.py` commits this text during the rehearsal so the template is
exercised:

```text
Migrate the compiler to G#

Final C# tree: <final C# sha> (tag v0.4.NNNN).
Translated with Gsharp.Cs2Gs 0.4.NNNN against Gsharp.NET.Sdk 0.4.NNNN
(build/cutover.py dry-run; procedure in docs/self-migration-cutover.md).

Shape: delete <n> C# files, add <m> files. Rename detection does not pair
them; use the tag to read the C# history. The C# line stays buildable on the
cs2gs/csharp-0.4 branch.
```

No attribution or co-author lines.

## Phase 2: final C# release checklist

The procedure with workflow citations is
[`docs/release/final-csharp-release.md`](release/final-csharp-release.md); every
place a version lives is
[`docs/release/version-bump-checklist.md`](release/version-bump-checklist.md)
(enforced by `build/check-release-version-refs.py`). This is the cut-over's
view of the same work, with the facts the dry run added.

- [ ] Freeze in effect; last nightly green; `build.yml` green on the freeze commit
      and `Show Nerdbank.GitVersioning version` prints `0.4.NNNN`.
- [ ] `version.json`: base stays `0.4` through the final C# release. The 0.5 bump is
      made later (it also changes `AssemblyVersion`, which trips `GS9303` once for
      analyzers built against the old line).
- [ ] `website/src/data/release.json`: `version`, `tag`, `docsVersion`. **Today it
      says `0.4.591` while `0.4.1150` is already published**, so the post-publish
      PR for 1150 was never made. Fix it in the freeze PR, not after.
- [ ] `npm run docs:version` snapshot for the 0.4 line refreshed
      (`website/versioned_docs/version-0.4`), plus `website/versions.json`.
- [ ] Hard-coded `0.4.591` references (the version-bump checklist's "must equal"
      table; `build/check-release-version-refs.py` lists them).
- [ ] Stale `0.3.x` pins: allow-listed ones (VS templates/fixtures `0.3.159`,
      `samples/HotReload/global.json` `0.3.356`) stay; anything else is a miss.
- [ ] `website/docs/release-notes.md`: move Unreleased to a `0.4.NNNN` section that
      says it is the last C#-built release and names `cs2gs/csharp-0.4`; add the
      0.5 section (draft: `docs/release/release-notes-0.5-draft.md`).
- [ ] Tag `v0.4.NNNN` on the freeze commit; `publish` fires. Owner action.
- [ ] Create branch `cs2gs/csharp-0.4` **at the tag**, protect it, state the policy
      in its README: semi-frozen, no feature work; it may receive occasional back-ports
      from G# to C# when useful to exercise cs2gs.
- [ ] nuget.org resolvability from a clean machine: `Gsharp.NET.Sdk`, `Gsharp.Cs2Gs`
      and `Gsharp.Gsfmt` all at `0.4.NNNN`. Do not assume it: `Gsharp.Gsfmt` was
      published for `0.4.591` and `0.4.1150` only. `cutover.py dry-run --pin
      0.4.NNNN --only clone tools` proves it (it installs the tools and downloads
      the SDK package with a private package cache).
- [ ] Re-run the full `cutover.py dry-run` at the tag. Pass criteria are in the next
      section.

## Pass criteria for the final rehearsal

All stages `passed` in `dry-run.json`, with no `skew` caveats: translate green for
every discovered app, `gsfmt --check` clean, `GSharp.slnx` lists every project,
no surviving versioned pin, `core-smoke` and `build` green, every e2e script
green, the VS Code `.vsix` packages. The Visual Studio VSIX is verified by the
Windows job.

## Dry run log

First rehearsal: 2026-10-09, `origin/main` at `c2b079774` (stand-in for the release-candidate
tag), published `Gsharp.Cs2Gs`/`Gsharp.Gsfmt`/`Gsharp.NET.Sdk` **0.4.1150**, private NuGet cache,
nuget.org only. Work root `~/.cache/d-cutover/run2`. The translate stage took 9 h 8 min on a
shared machine (full `migrate`, test parity included). All the failures below are classified as
**skew** (the tool is 105 commits older than the source, see "Why a rehearsal against the
published 0.4.1150 is only an approximation") or **finding** (a real defect or plan gap, with an
issue).

| Stage | Result | Notes |
|---|---|---|
| clone | passed | fresh clone, no `out/`, empty `.nugs` |
| tools | passed | `cs2gs`/`gsfmt` 0.4.1150 installed with a nuget.org-only config; SDK and Testing packages downloaded; `--sdk-pin`/`--sdk-version` not supported (skew) |
| prepare | passed | locked-mode restore of `GSharp.sln`, prerequisite builds, published nupkgs staged |
| translate | failed, 52/57 apps | 5 apps red, all skew: `Compiler.Tests` and `Core.Tests` (GS0179 switch-expression arm types, fixed by #4832; GS0155 nil to `object`/`string`, cf. #4831/#4833), `Cs2Gs.Tests` (GS0154/GS0155/GS0159, same family, not individually verified), `G09-Functions-Console` (translation gap for a ref-returning local function, added after the tag), `Interpreter.Tests` (per-test-name parity: 14 missing and 14 extra of 1,512 cases, theory display names with `(scope: "function")`; not triaged). Findings: #4849, #4850, #4852, #4853, #4858 |
| assemble | passed | 4,182 C# files deleted, 4,194 new files added (5,473 mirror files copied); 8 untranslated C# files retained (#4850) |
| hand-fix | passed | 44 fix groups; findings: #4851 (lock files), #4861 (`GSharp.sln` anchor) |
| gsfmt | passed after `--write` | not clean before: 394 files (#4858) |
| core-smoke | passed | `src/Core` compiles with the pinned published SDK |
| build | failed | `GSharp.slnx` Release: only `Core.Tests`, `Cs2Gs.Tests` (the translate failures above) and `Repl` fail. `Repl` compiled with main's SDK during polish and fails with GS0490 under 0.4.1150 (gsc skew). Locked-mode restore passed after lock regeneration |
| e2e | 14 passed, 1 skipped, 1 failed | `debugger-e2e` skipped (netcoredbg not installed); `gsgen-e2e` fails with `InvalidProgramException` from the stage-1 gsgen (#4862, may be skew); `templates-e2e` and `cs2gs-migrate-generated-regex-e2e` failed until hand-fix 1 (six packable projects) and 4b (the `GSharp.sln` command name in scripts) were added |
| vsix | passed (VS Code); VS: Windows only | `.vsix` packaged; the Visual Studio VSIX path check passes, the VSSDK build must run on Windows |

Two earlier attempts are worth recording because the script now guards against them:
the first full run pinned every project to the source-built `0.4.1253-g...` SDK (#4849 comment),
and the first hand-fix pass reported 15 bogus missing projects because `.sln` solution folders
were parsed as projects.

### Blockers for the real cut-over, in order of risk

1. #4861 (P1) `GSharp.sln` was the repository-root anchor; fixed by `RepositoryRootMarker` (either spelling), so the plan's replacement is safe.
2. #4862 (P1) stage-1 gsgen `InvalidProgramException`: re-run at a matched tag.
3. #4849 (P1) published `cs2gs migrate` needs an in-tree build for `gsc`/`gsgen`, the repo root and the SDK nupkg.
4. #4850 (P1) the mirror drops C# files that translated projects reference.
5. Lower: #4851, #4852, #4853, #4858 (all P2).

Three of the five translate failures are attributable to listed fixes (`Compiler.Tests` and
`Core.Tests`: #4832 and the nil/array-initializer family; `G09`: added after the tag). Two are
**not triaged**: `Cs2Gs.Tests` (GS0154/GS0155/GS0159, not individually verified) and the
`Interpreter.Tests` per-test-name parity mismatch. They stay open items for the matched-tag
rehearsal, which also has to confirm that nothing on the list above is a defect.

### Final rehearsal at the matched tag

Run on 2026-10-13 from a fresh clone of `v0.4.1270` (`eac5b487b`), published
`Gsharp.Cs2Gs`/`Gsharp.Gsfmt`/`Gsharp.NET.Sdk` **0.4.1270** (tool == SDK == tag == translated commit, so
skew items 4 and 5 above no longer apply; `--sdk-version`/`--sdk-pin` are supported), private NuGet cache,
nuget.org only. Work root `~/.cache/cutover-dryrun/work`.

| Stage | Result | Notes |
|---|---|---|
| clone | passed | `eac5b487b` |
| tools | passed | `cs2gs`, `gsfmt` and SDK 0.4.1270 |
| prepare | passed | restored, prerequisite builds, published SDK staged |
| translate | failed (cs2gs exit 1), 58/58 apps green | no app failed or was unverified. The exit 1 comes from the mirror's end-of-run unexpected-file check, which found `build/__pycache__/check-selfmig-stage-floor.cpython-314.pyc`, written by a Python 3.14 run. The file is gitignored and not in the PR. 27,533 s |
| assemble | passed | 4,202 C# files deleted, 4,218 files added; no untranslated C# retained. 2 s |
| hand-fix | passed | 51 fix groups, lock files regenerated. 5 s |
| gsfmt | passed after `--write` | not clean before: 402 of 4,372 `.gs` files rewritten, then clean (#4858). 109 s |
| core-smoke | passed | `src/Core` compiles with the pinned SDK. 263 s |
| build | passed | `GSharp.slnx` in Release. 998 s |
| e2e | reported failed in the main run; passed after re-run | `debugger-e2e` was skipped because netcoredbg was not installed (15 passed, 1 skipped). After installing netcoredbg, `--only e2e --e2e debugger` passed (21 s). `multitarget-e2e` skipped its net8.0 leg (runtime not installed). 569 s |
| vsix | passed (VS Code); VS: Windows only | `.vsix` packaged; the VSSDK build runs in the Windows job. 21 s |

Clone, tools and prepare took 7 s, 5 s and 78 s. The dry run ran 2026-10-13T10:23:03Z to 18:36:14Z (8 h 13 min) and exited 1 (translate and the skipped debugger e2e). Evidence: `~/.cache/cutover-dryrun/evidence/` (`dry-run.json`, `dry-run-after-debugger-rerun.json`, `NOTES.md`).

The cut-over PR repeats the assemble, hand-fix and gsfmt stages on top of the phase-2 branch and
reproduces the same stage counts (4,202 deleted before the `PeBodyMutations.cs` exception; 51 hand-fix groups;
402 files reformatted); the commit's own counts are in the paragraph above.

The tree used is the dry run's own `migrate` output. The preserved tree that the first stage-2 certification
migrated from the same commit (`~/.cache/stage2-final/migrated-eac5b487b/tree`) differs from it in two ways only: the SDK pin
(it pins the in-tree build `0.4.1270-geac5b487b1`, the PR tree pins the published `0.4.1270`) and one corpus test file
(`tools/cs2gs/corpus/L3-Library.Tests/AdvancedTests.gs`, a lambda spelled as `() ->` versus a `func () object?` literal).

### Stage-2 certification (ADR-0198)

All figures are read from the controller's `stage2-report.json` and `verify-stage2-report.py` output.

| | Dry-run tree at `v0.4.1270` | Tree of `eac5b487b`, rerun 1 |
|---|---|---|
| Result | `certified: true`; `verify-stage2-report`: "a genuine certification" | `certified: true`; `verify-stage2-report` passed |
| Run id | `8d1e76c726801a48e1db4689b37db1da` | `ff3c93923472cdfd49aa3a91e61a5c82` |
| Bootstrap SDK | published `Gsharp.NET.Sdk.0.4.1270.nupkg` | in-tree `0.4.1270-geac5b487b1` |
| Projects, configuration | `src/Core/Core.gsproj`, `src/Compiler/Compiler.gsproj`, Release | same |
| Core.Tests under stage 2 | 11,245 executed, 0 failed | 11,245 executed, 0 failed |
| Compiler.Tests under stage 2 | 7,035 executed, 0 failed | 7,035 executed, 0 failed |
| `GSharp.Core.dll`, `gsc.dll` | stage 1 and stage 2 byte-identical, raw and normalized (`rawEqual` and `normalizedEqual` true for both) | same |
| Exclusions | 10 Core.Tests and 64 Compiler.Tests, by name | same |
| Test environment | `GSHARP_SKIP_ILVERIFY=1` (report `testEnvironment`) | same |
| Wall time | 8 h 24 min (2026-10-13T18:36:29Z to 2026-10-14T03:00:21Z), exit 0 | 11,226 s, exit 0 (controller leg only, reusing the migrated tree) |

- Exclusions by name: the 9 Core.Tests and 64 Compiler.Tests of the committed `build/selfhost/stage2-env-bound-tests.json` (tests that need the
  repository layout; they fail identically under stage 1; #4873), plus one Core.Tests entry that is **not committed**:
  `GSharp.Core.Tests.PublicApi.CorePublicApiAllowanceTests.ShippedAllowance_ListsExactlyTheTenAdr0199RecordTypes` (#4889). It was added to the
  tree under test only (`uncommitted-exclusion.diff`); the owner deferred its resolution to after the cut-over, so the committed list still lacks it.
- `GSHARP_SKIP_ILVERIFY`: unset in the invoking shell; the controller sets `GSHARP_SKIP_ILVERIFY=1` for its test runs only, and the report records it. IL verification of the stage outputs is therefore not covered by these test runs (#4873).
- History on `eac5b487b`: the first attempt (`~/.cache/stage2-final/migrated-eac5b487b`, 26,749 s including migration) was **not** certified: one Core.Tests failure (the manifest calls it a repository-layout-bound test added on main, not a stage-1/stage-2 difference);
  the rerun notes name `ShippedAllowance_ListsExactlyTheTenAdr0199RecordTypes` (#4889) as the test they excluded. Rerun 1 added the exclusion above and certified.
- What the dry-run certification covers: the dry run's assembled tree (5,546 files). The PR tree differs from it by the `PeBodyMutations.cs` exception, the retired GSA files, the
  phase-2 merge and the documentation and workflow edits (see "Recorded values"); stage 2 has not been run on the PR tree itself.
- Evidence: `~/.cache/cutover-dryrun/evidence/` (`stage2-reports/stage2-report.json`, `verify-stage2-report.out`, `uncommitted-exclusion.diff`, `NOTES.md`) and `~/.cache/stage2-final/rerun-1/` (`RERUN-NOTES.md`, `evidence/`).
