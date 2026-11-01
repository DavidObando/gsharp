# ADR-0218: Release publish jobs per destination with safe re-run

- **Status**: Accepted
- **Date**: 2026-10-29
- **Phase**: Release engineering
- **Related**: [#5530](https://github.com/DavidObando/gsharp/issues/5530),
  [#4640](https://github.com/DavidObando/gsharp/issues/4640) (closed),
  [#4639](https://github.com/DavidObando/gsharp/issues/4639),
  [ADR-0207](0207-readytorun-compiler-payloads-and-rid-selection.md) ("Costs of the promise"),
  [ADR-0200](0200-component-aware-pr-validation.md),
  [release runbook](../release/final-csharp-release.md)

This ADR is a design. It changes no workflow. The maintainer decided the open
points on 2026-10-29 (see "Decisions"). An implementation PR follows. File and
line references name `main` at `97929ec08`.

## Context

### The publish flow today

`.github/workflows/build.yml` runs on pushes to `main`, on `v*` tags and on
pull requests. One `publish` job (`build.yml:1102-1184`) runs on a `v*` tag
after eleven gate jobs. One more job, `publish-visual-studio-extension`
(`build.yml:1186-1225`), needs `publish`.

| Step | Job | Command | Source |
| --- | --- | --- | --- |
| Artifacts | `build` | Packs `out/bin/Release/nupkgs/*` (`.nupkg` and `.snupkg`) into artifact `nuget-packages`. The packages include the six `Gsharp.NET.Sdk.Compiler.<rid>` packages. | `build.yml:148-155` |
| Artifacts | `vsix` | Packs `vscode-gsharp.vsix` into artifact `vscode-gsharp-vsix`. Version is `nbgv get-version -v SimpleVersion`. | `build.yml:706-757` |
| Artifacts | `visual-studio-extension` | Builds `GSharp.VisualStudio.vsix` into artifact `visual-studio-gsharp-vsix`. Its project templates are poked to `Gsharp.NET.Sdk/$(NuGetPackageVersion)`. | `build.yml:759-791`, `src/vs-gsharp/src/VsGsharp/VsGsharp.csproj:112-114` |
| 1 | `publish` | `gh release view \|\| gh release create --generate-notes`, then `gh release upload ... --clobber` of every `.nupkg`, `.snupkg` and both `.vsix`. The release is public at once. | `build.yml:1132-1138` |
| 2 | `publish` | Push the six RID compiler packages with `dotnet nuget push --skip-duplicate`, three attempts each, then require `count == 6`. | `build.yml:1148-1160` |
| 3 | `publish` | `build/check-rid-packages.py --wait-minutes 30` until the six packages are on the flat container. | `build.yml:1162-1163` |
| 4 | `publish` | Push the remaining packages (`Gsharp.NET.Sdk` and the tools) with `--skip-duplicate`, one attempt each. | `build.yml:1165-1171` |
| 5 | `publish` | `check-rid-packages.py --require-sdk --wait-minutes 15`. | `build.yml:1173-1174` |
| 6 | `publish` | `npx --yes @vscode/vsce publish --packagePath ./vsix/vscode-gsharp.vsix` with `VSCE_PAT`. The vsce version is not pinned. | `build.yml:1181-1184` |
| 7 | `publish-visual-studio-extension` | `VsixPublisher.exe publish` with `src/vs-gsharp/vs-publish.json` and the same `VSCE_PAT`. | `build.yml:1200-1225` |

The gate set of `publish` is `build, tests, test-partition, harness, e2e,
ilverify, cs2gs-corpus, vsix, visual-studio-extension,
desktop-msbuild-sdk-smoke, r2r-compiler-smoke` (`build.yml:1104`). The `ci`
aggregate (`build.yml:1090-1100`) needs every job, runs with `if: always()`,
and runs `build/ci-selection.py --check build`, which fails when a selected
job did not succeed. `publish` does not need `ci`.

The artifact `nuget-packages` of v0.5.212 held eleven packages: six `.nupkg`
(`Gsharp.NET.Sdk`, `Gsharp.Templates`, `Gsharp.Repl`, `Gsharp.Gsfmt`,
`Gsharp.Cs2Gs`, `GSharp.CodeAnalysis.Analyzers.Testing`) and five `.snupkg`.
`Gsharp.Templates` has no symbols (`Gsharp.Templates.gsproj:10`). Since #5198
the artifact also holds the six RID packages, which set
`IncludeSymbols=false` (`Gsharp.NET.Sdk.Compiler.gsproj:12`). So a release
holds twelve `.nupkg` and five `.snupkg`.

### Facts this design rests on

| Fact | How it was checked | Status |
| --- | --- | --- |
| No tag run has published a `Gsharp.NET.Sdk.Compiler.<rid>` package. The flat container returns 404 for `gsharp.net.sdk.compiler.linux-x64` and `win-x64`. The latest release is v0.5.212 (2026-10-22). The RID publish steps landed in #5198 on 2026-10-23. | `curl` of `api.nuget.org/v3-flatcontainer`, `gh release list`, `git log -S check-rid-packages` | Verified |
| The five 0.5 tag runs (v0.5.7 to v0.5.212) succeeded on attempt 1. No run among the last 200 of this repository has a second attempt. | `gh api .../actions/runs` | Verified |
| In the 0.4 line, the VS Code step failed on a transient Marketplace error in three releases. `publish-visual-studio-extension` was skipped each time, and no run was re-run. The extensions stayed at 0.4.1 until a manual publish. | #4640, runbook "Marketplace state" | Verified (history) |
| Both marketplaces are at 0.5.212 (`gsharplang.vscode-gsharp` 0.5.212, `gsharplang.GSharp-VisualStudio` 0.5.212.9261). The Visual Studio version has four parts. | Marketplace `extensionquery` API | Verified |
| `dotnet nuget push --skip-duplicate` treats a 409 Conflict as a warning. It does not hide a 401 or 403. A `.snupkg` beside the `.nupkg` is pushed with it. | .NET CLI documentation; runbook (v0.4.591 logged 5 + 4 pushes) | Verified (docs) |
| Whether the symbol server also answers 409 for an existing `.snupkg`, and whether `--skip-duplicate` still pushes the `.snupkg` after the `.nupkg` got 409. | Not checked. The prerelease rehearsal (migration step 5) answers it. | **Unverified** |
| `@vscode/vsce` 3.9.2 (the `devDependencies` version) has `publish --skip-duplicate` ("fail silently if version already exists"), `publish --pre-release`, `show <extensionid> --json`. | `npx @vscode/vsce@3.9.2 --help` | Verified (`--help`) |
| `vsce package --pre-release` writes the marker `Microsoft.VisualStudio.Code.PreRelease` into the VSIX manifest. Whether `vsce publish --packagePath --pre-release` can add it to an existing VSIX. The `vsix` job packages without the flag today (`build.yml:751`). | vsce `--help`; `build.yml` | Package flag verified (`--help`); publish-time marker **unverified** |
| `VsixPublisher.exe publish` of a version that already exists overwrites it. | Visual Studio documentation | Verified (docs); not exercised |
| `gh release upload --clobber` replaces an asset of the same name. `gh release view \|\| create` is a no-op when the release exists. | Runbook, current workflow | Verified (used in releases) |
| "Re-run failed jobs" keeps `GITHUB_SHA` and `GITHUB_REF`. A run can be re-run for 30 days, at most 50 times. | GitHub documentation | Verified (docs) |
| Artifacts of attempt 1 are available to jobs in attempt 2 of the same run. | Probe run 41130582950 (PR #5553, closed): a job that needed a re-run failed job downloaded an artifact whose content said it was uploaded by attempt 1. | Verified (observed) |
| "Re-run failed jobs" also runs the jobs that were skipped because they needed a failed job. | Same probe run: the job skipped in attempt 1 ran in attempt 2 after its prerequisite passed. | Verified (observed) |
| A job with `needs` is skipped when a prerequisite fails or is skipped, unless its `if` uses `always()` or `!cancelled()`. `always()` is also true in a cancelled run. | GitHub documentation | Verified (docs) |
| `needs.<job>.result` of a matrix job is one value for all legs. The jobs API lists the legs by display name, `r2r-compiler-smoke (<rid>)`. | `build.yml:1046`; `gh run view --json jobs` | Verified |
| A `v*-rc1` tag runs `publish` with a prerelease version `<number>-g<sha>`, because `publicReleaseRefSpec` matches only `^refs/tags/v\d+(?:\.\d+)*$`. The VSIX versions carry no suffix (`SimpleVersion`). | `version.json`, runbook, `build.yml:738-748` | Verified |
| A job on a hosted runner label that no longer exists fails, or waits in the queue. | Not checked. | **Unverified** |
| Repository secrets are not available to workflow runs from forks. | GitHub documentation, from memory. | Not re-read |
| nuget.org, the VS Code Marketplace and the Visual Studio Marketplace accept GitHub OIDC trusted publishing. | NuGet, vsce and Visual Studio documentation | Verified (docs); out of scope |

### Where a partial failure leaves things today

1. **Public release before the feed.** Step 1 creates a public GitHub release
   with every asset before any package is on nuget.org. A failure in steps 2
   to 5 leaves a public release page for a version that no feed serves.
2. **The RID edge is protected, but untested.** A failed RID push fails the
   job before the SDK push, as ADR-0207 requires. The local count of six runs
   after the pushes, not before. No release has run these steps.
3. **One re-run unit.** "Re-run failed jobs" re-runs the whole `publish` job.
   Steps 1 to 5 tolerate that. Step 6 does not: `vsce publish` without
   `--skip-duplicate` fails when the Marketplace already has the version. A
   timeout after the upload was accepted leaves exactly that state (#4640).
4. **The Visual Studio job is coupled.** It needs `publish`, so any failure in
   steps 1 to 6 skips it, although its artifact and credentials are fine.
5. **Extensions after the SDK is an accident of the single job.** Today the
   VS Code step follows the SDK feed check inside one `set -euo pipefail`
   job, and the Visual Studio job needs the whole `publish` job, so neither
   extension publishes while the SDK push fails. The guarantee matters: the
   Visual Studio templates pin the exact SDK version, so a user who installs
   the extension early gets a template that cannot restore. A split that puts
   the extensions beside the NuGet jobs would lose it, so the split must keep
   it as an explicit edge.
6. **No pre-flight.** Nothing checks the tag name against the package version
   (#4639) or the artifact inventory before the first push.
7. **Gate against ADR-0207.** ADR-0207 says a RID whose smoke cannot run must
   not block the release. `publish` needs all six legs of
   `r2r-compiler-smoke`. If a hosted label such as `macos-15-intel` disappears,
   the tag cannot publish, and the tag's workflow cannot be edited.

### Failure matrix today

| Failing step | What stays published | "Re-run failed jobs" today |
| --- | --- | --- |
| A gate job | Nothing | Re-runs the gate, then `publish`. If the cause is a missing runner label, the tag is stuck. |
| 1 GitHub release | Nothing, or a release with some assets | Safe: `view \|\| create`, `--clobber`. |
| 2 RID pushes | Public release; zero to five RID packages; no SDK; no marketplaces | Safe for NuGet (`--skip-duplicate`). |
| 3 RID wait (30 min) | Public release; six RID packages on the way | Safe. |
| 4 Remaining packages (one attempt each) | Public release; RID packages; SDK and some tools | Safe. A failed SDK push with RID packages present leaves a consistent feed. |
| 5 Post-check | Everything on NuGet | Safe. |
| 6 VS Code (error before upload) | Release and NuGet | Safe. |
| 6 VS Code (timeout after upload) | Release, NuGet and VS Code | **Fails again.** `vsce publish` rejects the existing version. The Visual Studio job never runs. Manual publish per runbook. |
| 7 Visual Studio | Everything but Visual Studio | Re-runs only that job. `VsixPublisher` overwrites the same version. |

## Decision

### 1. One job per destination, inline in `build.yml`

The `publish` and `publish-visual-studio-extension` jobs are replaced by seven
jobs in `build.yml`. There is no new workflow file, no reusable workflow, no
`workflow_dispatch`, no environment and no concurrency group. The only retry
tool is "Re-run failed jobs" on the tag run. The split exists so that this
button is safe and re-runs only what failed.

Every job has the condition `if: !cancelled() && startsWith(github.ref,
'refs/tags/v') && needs.<p>.result == 'success'` for each direct prerequisite
`<p>` listed in its `needs`, unless the table says otherwise. The explicit form
is required because the implicit `success()` also looks at failed ancestors
(see the probe in "Implementation notes"). Every job downloads the artifacts of
the same run with `actions/download-artifact@v5` and builds nothing.

| Job | Runner | `needs` | Permissions | Does |
| --- | --- | --- | --- | --- |
| `publish-verify` | ubuntu | `ci`; `if: !cancelled() && startsWith(github.ref, 'refs/tags/v') && needs.ci.result == 'success'` | default (`contents: read`) | Downloads `nuget-packages`, `vscode-gsharp-vsix`, `visual-studio-gsharp-vsix`. Runs `release-publish.py verify` (section 3). Outputs `version`, `prerelease` (`true` when `tag-kind` is `prerelease`, section 3) and `unverified_rids` (section 2). |
| `publish-github-release` | ubuntu | `publish-verify` | `contents: write` | `gh release view \|\| gh release create --draft --generate-notes`, with `--prerelease` when `prerelease` is `true`. `gh release upload --clobber` of every `.nupkg`, `.snupkg` and `.vsix`. The release stays a draft until `publish-finalize`. |
| `publish-nuget-compiler` | ubuntu | `publish-verify` | none | `release-publish.py nuget-push --group compiler`: the six RID packages, then `check-rid-packages.py --wait-minutes 30`. |
| `publish-nuget-sdk` | ubuntu | `publish-verify`, `publish-nuget-compiler` | none | `check-rid-packages.py` (no wait) as a precondition, then `nuget-push --group sdk`: `Gsharp.NET.Sdk` and the remaining packages with their `.snupkg`, then `check-rid-packages.py --require-sdk --wait-minutes 15`. |
| `publish-vscode-marketplace` | ubuntu | `publish-verify`, `publish-nuget-sdk` | none | Reads `extension/package.json` `version` from the VSIX. `release-publish.py marketplace-version gsharplang.vscode-gsharp`. Skips when present. Else `npx --yes @vscode/vsce@3.9.2 publish --packagePath ... --skip-duplicate`. The pre-release marker is already inside the VSIX (section 5). Queries again and fails when the version is still absent. |
| `publish-visual-studio-marketplace` | windows | `publish-verify`, `publish-nuget-sdk`; `if: needs.publish-verify.outputs.prerelease != 'true'` (skipped for a prerelease tag, section 5) | none | Reads `Identity/@Version` from `extension.vsixmanifest` in the VSIX. `marketplace-version gsharplang.GSharp-VisualStudio`. Skips when present. Else `VsixPublisher.exe publish` as today. Queries again. |
| `publish-finalize` | ubuntu | `publish-verify`, `publish-github-release`, `publish-vscode-marketplace`, `publish-visual-studio-marketplace`; `if: !cancelled() && startsWith(github.ref, 'refs/tags/v') && needs.publish-verify.result == 'success'` | `contents: write` | Requires `publish-github-release` and `publish-vscode-marketplace` to be `success`, and `publish-visual-studio-marketplace` to be `success`, or `skipped` while `prerelease` is `true` (a skipped VS Code job, or a skipped Visual Studio job on a release tag, means the SDK chain failed). Queries the flat container for the twelve packages, the VS Code Marketplace, the Visual Studio Marketplace (release only) and the release assets. When every required destination has the version: rewrites the marker-bounded "Publication notes" section of the release body (section 2) and runs `gh release edit --draft=false`. Else fails and names the destinations to re-run. Writes a summary table either way. |

The dependency chain is: six RID packages, then the SDK and tools, then both
extensions, then finalize. The GitHub release draft runs beside the chain.
Rules:

- Every job states its condition in full (above). The implicit `success()`
  would skip a job after a failed ancestor, which on a tag includes an advisory
  `r2r-compiler-smoke` leg behind `ci`, so a default `needs` job could not
  publish. `publish-verify` checks `ci`'s own result (`success`), not the jobs
  behind it. `publish-finalize` keeps its own wider condition (table), so that
  it reports the state after a failure, and its `prerelease` skip rule for the
  Visual Studio job. The form uses `!cancelled()`, not `always()`, because
  `always()` also runs in a cancelled run, and a cancelled release must not
  publish or finalize. The `needs` context holds direct prerequisites only, so
  every job that reads `needs.publish-verify.outputs.*` lists `publish-verify`.
- Secrets stay repository secrets (`NUGET_API_KEY`, `VSCE_PAT`,
  `GITHUB_TOKEN`), as today. No environment is needed for them: the publish
  jobs run only on `v*` tag refs, which only the maintainer pushes, and
  repository secrets do not reach fork pull requests. An environment would
  repeat the tag condition as a deployment policy and add a moving part.
- `contents: write` is given to the two jobs that touch the release. The
  other publish jobs set no `permissions` key and keep the repository default,
  which is `read` (`gh api .../actions/permissions/workflow`). Same-run
  `download-artifact` needs no `GITHUB_TOKEN` scope; today's `publish` job
  downloads with `contents: write` only. A job-level `permissions` key
  replaces the defaults, so a job that names one scope must name every scope
  it needs.
- The order of the two NuGet groups is enforced twice: by the `needs` edge
  and by the feed check at the start of `publish-nuget-sdk`. The second guard
  matters because ADR-0207 result 6 makes a missing RID package a restore
  failure on that RID.
- Both extension jobs wait for the SDK. Users who get an extension update
  then find the SDK that its templates pin.
- Two tag runs do not conflict: every destination is keyed by version, and
  the RID-to-SDK order is inside one run.

### 2. The gate is `ci`; `r2r-compiler-smoke` is advisory for a tag

`publish-verify` needs `ci` and nothing else. `ci` already needs every job and
runs `build/ci-selection.py --check build`, so the gate set has one source and
cannot drift from the aggregate. Compared with today, `format`,
`release-version-refs`, `vscode-extension`, `discover-tests` and the three
`go2gs` jobs join the gate.

`r2r-compiler-smoke` stays in the `needs` of `ci`, so `ci` waits for all six
legs and knows their result. The check script gets an advisory rule:

- `ci` passes `ADVISORY_JOBS=r2r-compiler-smoke` and `GITHUB_REF` to the
  script. The rule applies only when `GITHUB_REF` starts with `refs/tags/v`.
  On pull requests and on `main` pushes the smoke stays required, so a
  regression is caught before a tag.
- On a tag, a `failure`, `cancelled` or `skipped` result of an advisory job
  does not fail the check. The script lists the legs whose conclusion is not
  `success` through the jobs API of the current run (`gh api
  repos/{repo}/actions/runs/{run_id}/jobs`, display names
  `r2r-compiler-smoke (<rid>)`), writes them to the step summary, and sets the
  job output `unverified_rids` (for example `osx-x64`). `ci` declares that
  output; `publish-verify` forwards it. The jobs API needs `actions: read`,
  which the repository default token (`read`) does not include, so `ci` gets
  `permissions: { contents: read, actions: read }`.
- `publish-finalize` owns one section of the GitHub release body, bounded by
  the markers `<!-- publish-notes -->` and `<!-- /publish-notes -->`. It
  replaces the text between the markers with the current notes, at most two
  lines: "Unverified platforms: `osx-x64`. The ReadyToRun compiler smoke did
  not run or did not pass on this platform (ADR-0207). The IL compiler is the
  fallback." when `unverified_rids` is not empty; and "Not published to the
  Visual Studio Marketplace: prerelease tags publish to NuGet, GitHub and the
  VS Code Marketplace (pre-release) only." when `prerelease` is `true`
  (section 5). When both are empty, it removes the section. The rest of the
  body is kept. So a re-run after a body update whose un-draft failed writes
  the section once, and a re-run after a successful smoke leg removes the RID.
  The post-release documentation PR copies the notes into
  `website/docs/release-notes.md`, and the runbook says so. This keeps the
  ADR-0207 rule that an unverified platform is named in the release notes,
  without a hand step in the tag run.
- `osx-x64` is therefore never a gate, and no RID is. A smoke failure on a tag
  is visible in `ci`'s summary, in the release body and in the run's job list.

Residual: a leg whose runner label no longer exists may wait in the queue
instead of failing (unverified). Then `ci` waits too. If a single leg cannot
be cancelled by hand, the fallback is a PR that removes the label from the
matrix and a new tag. `build/test-ci-selection.py` gets cases for the advisory
rule: a failed advisory job passes on a tag ref and fails on a pull request
ref; a failed non-advisory job fails on both (ADR-0154 mutants: a rule that
ignores the ref, and one that ignores the job name).

### 3. Tag kinds, and verify before the first push

One function, `tag_kind(ref_name)` in `release-publish.py`, exposed as
`release-publish.py tag-kind <ref name>`, defines what a release and a
prerelease are. Every consumer calls it; no workflow expression repeats the
rule.

| Tag | Kind | Example |
| --- | --- | --- |
| `v<core>` | `release` | `v0.5.212` |
| `v<core>-<pre>` (a SemVer 2.0 prerelease suffix: `-rc1`, `-beta.2`, `-alpha`, ...) | `prerelease` | `v0.5.300-rc1` |
| Anything else, including a non-tag ref | `none` | `main`, `v1`, `v01.5.300`, `v0.5.300+build`, `v0.5.300-01`, `v0.5.300-alpha..1` |

`<core>` is three numeric identifiers without leading zeros,
`N = 0|[1-9][0-9]*`, as `N.N.N`. `<pre>` is one or more dot-separated
identifiers; each is `N` or a string of `[0-9A-Za-z-]` with at least one
letter or hyphen. This is the SemVer 2.0 grammar for versions without build
metadata; a `+build` part is rejected because NuGet drops it. The malformed
examples in the last row are negative test cases.

The consumers are: `verify` (a tag run with kind `none` fails); the `vsix` job
(`--pre-release` package flag for `prerelease`); `publish-github-release`
(`--prerelease` for `prerelease`); `publish-visual-studio-marketplace` (runs
for `release` only); `publish-finalize` (accepts the skipped Visual Studio job
for `prerelease`). `publish-verify` outputs `prerelease` as `true` or `false`
from the same call, and the downstream jobs read that output. The `vsix` job
runs before `ci`, so it calls `tag-kind` itself with `github.ref_name`.
`build/test-release-publish.py` covers the three kinds and the examples above,
with a mutant that accepts `v0.5.300+build` and one that treats `v0.5.300-rc1`
as `release`.

`release-publish.py verify --artifacts <dir> --tag <tag>` runs in
`publish-verify` and fails the release before any push when:

- the inventory is wrong. Expected: six `Gsharp.NET.Sdk.Compiler.<rid>.nupkg`
  (no symbols), six other `.nupkg` (`Gsharp.NET.Sdk`, `Gsharp.Templates`,
  `Gsharp.Repl`, `Gsharp.Gsfmt`, `Gsharp.Cs2Gs`,
  `GSharp.CodeAnalysis.Analyzers.Testing`), five `.snupkg` (all of those but
  `Gsharp.Templates`), `vscode-gsharp.vsix` and `GSharp.VisualStudio.vsix`.
  The list lives in the script, next to `RIDS` of `check-rid-packages.py`;
- the packages carry more than one version;
- the tag does not match the version. Kind `release`: the package version must
  equal the tag without `v`. Kind `prerelease`: the package version must be
  `<number>-g<sha>` whose `<number>` equals the tag's number. Kind `none`
  fails. This closes #4639;
- the VS Code VSIX pre-release marker (`Microsoft.VisualStudio.Code.PreRelease`
  in `extension.vsixmanifest`) is present for kind `release` or absent for
  kind `prerelease`;
- the `PackageDownload` version inside `Gsharp.NET.Sdk.props` of the SDK
  package is not the version of the six RID packages;
- the VS Code VSIX version is not exactly the `<core>` of the tag, or the
  Visual Studio VSIX version is not four numeric parts whose first three equal
  the `<core>` of the tag part by part (`0.5.2120.9261` does not match
  `0.5.212`; a textual prefix test would accept it);
- the project templates inside the Visual Studio VSIX do not pin
  `Gsharp.NET.Sdk/<version>`.

The NuGet part of the same check, `verify --nuget-only`, also runs as a step
of the `build` job on every push, right after the existing
`check-netstandard-*` steps, against `out/bin/Release/nupkgs`. It has no
VSIX and no tag, so it checks exactly three things: the package inventory
(twelve `.nupkg`, five `.snupkg`), one version across the packages, and the
`PackageDownload` version of the SDK equal to the RID package version. That step would have shown, on every `main` push
since 2026-10-23, that the build produces a seven-package SDK set that the
publish code has never consumed. It costs one script call and no secrets.

### 4. Idempotency per destination

"Already published at this version" is success.

| Destination | Mechanism | Idempotent today | Idempotent proposed |
| --- | --- | --- | --- |
| nuget.org | `dotnet nuget push <pkg>.nupkg --skip-duplicate`, three attempts with a pause, in the fixed order. Then, when `<pkg>.snupkg` exists, `dotnet nuget push <pkg>.snupkg --skip-duplicate` explicitly, so a symbol package whose first upload failed after the primary succeeded is retried on a re-run. No flat-container pre-query decides a skip: the feed proves the primary only, not the symbols. | Yes (409 is a warning). The remaining-packages loop has no retry. | Yes, with retry on both groups. 401 and 403 still fail. |
| GitHub release | `view \|\| create --draft [--prerelease]`; `upload --clobber`. One job owns `create`. | Yes. | Yes. |
| VS Code Marketplace | Pre-query (`marketplace-version`, the `extensionquery` REST). Present: skip. Absent: `vsce publish --skip-duplicate`. Post-query decides success, not the vsce exit code, because `--skip-duplicate` after a post-upload timeout is unverified. vsce pinned to 3.9.2. | **No.** | Yes. |
| Visual Studio Marketplace | Pre-query on the four-part version from `extension.vsixmanifest`. Present: skip. Absent: `VsixPublisher.exe publish` (documented overwrite). Post-query. | Yes by overwrite (not exercised). | Yes. |

The flat container and the `extensionquery` API are public. The queries need
no credentials.

### 5. Prerelease tags

A tag of kind `prerelease` (section 3: any SemVer prerelease suffix, not only
`-rc`) publishes to three destinations and skips the fourth:

| Destination | Kind `release` | Kind `prerelease` |
| --- | --- | --- |
| nuget.org | `<number>` | `<number>-g<sha>`, the prerelease version that the build already produces |
| GitHub release | draft, then public | draft with `--prerelease`, then public and still marked prerelease |
| VS Code Marketplace | release version | pre-release version: the `vsix` job packages with `vsce package --pre-release` when `tag-kind` says `prerelease`, so the marker is inside the VSIX; `verify` checks the marker against the kind; the publish step passes no flag. Whether `vsce publish --packagePath` can add the marker to an already packaged VSIX is unverified, so the design does not rely on it. |
| Visual Studio Marketplace | published | **not published.** The Marketplace has no pre-release channel, so a prerelease would reach every Visual Studio user as an update. `publish-visual-studio-marketplace` is skipped by its `if`. |

`publish-finalize` finalizes a prerelease without the Visual Studio job: it
accepts the result `skipped` for that job only when `prerelease` is `true`,
does not query the Visual Studio Marketplace, and writes the "Not published to
the Visual Studio Marketplace" note into the release body (section 2). The
post-release documentation PR copies that note into the release notes. Only a
plain `v<major>.<minor>.<patch>` tag publishes to Visual Studio.

The VSIX versions carry no suffix. A prerelease tag and the following release
tag must therefore sit on different commits, so that the NBGV height differs
and the marketplace versions differ. The pre-query of
`publish-vscode-marketplace` reads the pre-release flag of a present version
(the version property `Microsoft.VisualStudio.Code.PreRelease`, name
unverified). Present with the same flag as this run: skip, as after a
post-upload timeout. Present with the other flag: fail with a collision
message, because an rc tag and a release tag share the commit. The Visual
Studio version has a per-build fourth part, so it does not collide.

### 6. Failure matrix proposed

"Re-run" means "Re-run failed jobs" on the tag run.

| Failing job | What stays published | After "Re-run failed jobs" |
| --- | --- | --- |
| A gate job (any job that `ci` requires) | Nothing | The gate re-runs, then `ci`, then the chain. |
| `r2r-compiler-smoke` leg on a tag | Everything; the release body names the RID | Nothing to re-run. The maintainer may re-run the leg; `ci` and `publish-finalize` re-run after it and the release body is rewritten without the RID. |
| `publish-verify` | Nothing | The inventory or the tag is wrong by construction. Fix is a new tag. |
| `publish-github-release` | Draft release with some assets; the NuGet chain and the extensions proceed; finalize fails | Uploads with `--clobber`; finalize un-drafts. |
| `publish-nuget-compiler` | Zero to six RID packages; SDK, extensions and finalize skipped or failed; draft release | Pushes with `--skip-duplicate`; the chain continues to finalize. |
| `publish-nuget-sdk` | Six RID packages; some of SDK and tools; extensions skipped; draft release | The precondition check passes; pushes the rest; the chain continues. |
| `publish-vscode-marketplace` (timeout after upload) | Everything but finalize. The Visual Studio job depends on `publish-nuget-sdk`, not on VS Code, so it runs and publishes in the same attempt | The pre-query finds the version; the job succeeds; finalize un-drafts. Visual Studio needs no re-run. |
| `publish-visual-studio-marketplace` (release tag) | Everything but finalize | Pre-query, else overwrite publish; finalize un-drafts. |
| `publish-visual-studio-marketplace` skipped (prerelease tag) | Not a failure. NuGet, GitHub and VS Code publish; finalize un-drafts and the release body says Visual Studio was not published | Nothing to re-run. |
| `publish-finalize` (network) | Everything; release stays draft | Re-runs the queries and un-drafts. |
| Tag run older than 30 days or re-run 50 times | As above | No re-run. The runbook's manual publish stays the last resort. |

## Consequences

Positive:

- A failed destination is re-run alone. NuGet pushes only what is missing;
  the marketplaces skip a present version.
- The Visual Studio job no longer depends on the VS Code job.
- Both extensions reach users after the SDK they pin.
- The GitHub release becomes public only when every destination has the
  version, and it names an unverified platform.
- The six-RID inventory is checked on every push, and the tag check of #4639
  comes with the verify step.
- One gate list (`ci`), one advisory rule in one tested script.

Negative:

- Seven jobs per tag run instead of two. Each is short.
- The release page appears later than today (after `publish-finalize`).
- One more script with tests, and the advisory rule in `ci-selection.py`.
- Two GitHub Actions behaviors are unverified until migration step 2 observes
  them: artifacts across attempts, and re-run of skipped dependents.

Neutral:

- `format`, `release-version-refs`, `vscode-extension`, `discover-tests` and
  the `go2gs` jobs join the gate (decision 1).
- A prerelease never reaches the Visual Studio Marketplace (decision 10).
  Visual Studio users see only plain `v<major>.<minor>.<patch>` releases.
- The runbook's manual-publish section stays as the last resort.

## Migration plan

Each step is a PR. The first is the least risky.

1. **Script and tests, no workflow change.** Add `build/release-publish.py`
   with `verify [--nuget-only]`, `nuget-push --group compiler|sdk` and
   `marketplace-version <id>`. Add `build/test-release-publish.py` with fake
   artifacts and a fake flat container. Mutants (ADR-0154): a push order that
   puts the SDK before the RID packages; an inventory that accepts five RID
   packages; a tag rule that accepts `v0.5.1-rc1` as a release tag; a symbol
   push that is skipped when the primary exists. Add the `verify --nuget-only`
   step to `build`. Verifiable on PR CI and on the next `main` push.
2. **Observe the two unverified behaviors.** A PR adds a throwaway workflow
   `rerun-probe.yml` (`on: pull_request`): job A uploads an artifact; job B
   fails when `github.run_attempt == 1`; job C needs B and downloads the
   artifact. Re-run failed jobs. Record whether C ran and whether the download
   found the attempt-1 artifact. The same workflow has job D with
   `if: always()` that needs a job that fails on every attempt and succeeds
   itself, and job E that needs D with no status function; record whether E
   runs. The PR is closed without merge; the findings go into the fact table
   and decide whether the chain jobs get the explicit condition (section 1).
3. **Advisory smoke.** Add the advisory rule and the `unverified_rids` output
   to `ci-selection.py --check build` and `ci`, with the tests of section 2.
   Verifiable on PR CI (the rule is inert off tags) and by the script tests.
4. **Split.** Replace the two publish jobs with the seven jobs of section 1,
   `needs: [ci]`, draft-then-finalize, prerelease handling (`tag-kind` in
   `vsix` and the publish jobs, the `--pre-release` package flag, the skipped
   Visual Studio job), pinned vsce, `--skip-duplicate`, both extensions after
   the SDK. Update the runbook
   ("Watch the tag run", "Post-publish docs PR" for the unverified-platform
   sentence, manual publish as last resort). Verifiable before a tag only by
   the script tests and `actionlint`; the real exercise is step 5.
5. **Rehearsal: one real prerelease.** The maintainer tags `v0.5.N-rc1` on a
   `main` commit and approves that run. It exercises every job, the six-RID
   publish, the symbol pushes, the VS Code Marketplace with a pre-release
   version, the skipped Visual Studio job, the draft and the finalize. The
   Visual Studio publish path is first exercised by the next release tag. The run also answers the unverified
   symbol-server and `--skip-duplicate` rows. Nothing in this ADR triggers it.
6. **Follow-ups out of scope.** Trusted publishing (OIDC) for the three
   destinations and assembly signing are a separate issue that the maintainer
   files. This ADR only notes that all three destinations support OIDC.

## Alternatives considered

1. **Keep one job and add `--skip-duplicate` to vsce.** Fixes the known failure
   but keeps the Visual Studio coupling, the public-release-before-feed order
   and the single re-run unit. Rejected.
2. **A `workflow_dispatch` retry workflow with a reviewer-protected
   environment.** Rejected by the maintainer: it adds a workflow, an
   environment, a reviewer step and a resolver for the tag's run. "Re-run
   failed jobs" covers the retry when the jobs are idempotent, which is the
   point of the split.
3. **A reusable workflow for the publish jobs.** Fine in itself, but with one
   caller it adds a file and an indirection for nothing. Rejected for inline
   jobs.
4. **A dry-run job on `main` with mocked pushes and credential checks.**
   Rejected: it needs a mock feed, a local push loop and credential probes
   that do not exist for nuget.org, and it still cannot prove acceptance by
   the real destinations. The `verify --nuget-only` step in `build` keeps the
   part that would have caught the six-RID gap, and the prerelease rehearsal
   proves the rest end to end.
5. **Environments with a `v*` tag policy for the secrets.** Rejected: the
   publish jobs already run only on tag refs, and repository secrets do not
   reach fork pull requests. An environment would repeat the condition.
6. **Concurrency groups per destination.** Rejected: destinations are keyed by
   version, two tag runs do not conflict, and the default queue cancels a
   pending job, which would leave a release incomplete.
7. **Rebuild on retry.** Rejected: the retry would publish bytes that differ
   from the release assets and from what the gates tested.
8. **`continue-on-error` on the Marketplace steps.** Hides a failure as
   success. Rejected.
9. **A matrix over destinations.** The runners differ, and the RID-to-SDK and
   SDK-to-extension edges cannot be expressed inside a matrix. Rejected.
10. **Remove `r2r-compiler-smoke` from the `needs` of `ci`.** Then `ci` would
    not know the legs' results, and the unverified platform could not be
    named. Rejected for the advisory rule in the check script.
11. **Public release at once, as today.** Rejected by the maintainer in
    favor of draft-then-finalize.

## Decisions

The maintainer decided these points on 2026-10-29:

1. The gate is `needs: [ci]`.
2. Publishing is not gated on any RID. `r2r-compiler-smoke` is advisory for a
   tag, and an unverified platform is named in the release notes (ADR-0207).
3. Both extensions wait for `publish-nuget-sdk`. The chain is RID packages,
   SDK, extensions, finalize.
4. The GitHub release stays a draft until finalize.
5. The only retry is "Re-run failed jobs". No dispatch workflow, no
   environment, no reviewer. Repository secrets stay as they are.
6. Prerelease tags publish, with the GitHub release marked as a prerelease. One
   real prerelease rehearses the flow (migration step 5).
10. (2026-10-29, later) A prerelease is any tag with a SemVer prerelease
    suffix, `v<major>.<minor>.<patch>-<anything>`, defined once by
    `tag-kind` (section 3). Every prerelease skips
    `publish-visual-studio-marketplace`; only a plain `v<major>.<minor>.<patch>`
    tag publishes to Visual Studio. Finalize accepts the skipped job for a
    prerelease and the release body names the omission.
7. `NUGET_API_KEY` can push any package id. Precondition met; no action.
8. Prefer the simplest graph with per-destination re-run: inline jobs, no
   dry-run job, one verify step in `build`.
9. Trusted publishing and assembly signing are a separate issue.

No question remains open.

## Implementation notes

- Step 1 (`build/release-publish.py`): `verify` takes `--nupkgs <dir>` and `--vsix <dir>`
  (the two download folders), not one `--artifacts` folder. With `--tag` and `GITHUB_OUTPUT`
  set it writes `version` and `prerelease`.
- The `PackageDownload` check reads `build/Gsharp.NET.Sdk.props` in the SDK package. That file
  does not hold a stamped version: it asks for `[$(GsharpSdkVersion)]`, and the props file
  derives that value from the name of the SDK's own folder, which is the SDK package version.
  The check therefore requires the expression `[$(GsharpSdkVersion)]` or a literal equal to the
  package version, and the single-version check ties the SDK version to the six RID packages.
- `marketplace-version <id> --version V [--kind release|prerelease|any]` exits 0 when the
  version is published with the same flag, 1 when absent, 3 on a flag collision.
- Step 4 (`nuget-push`): `dotnet nuget push X.nupkg` also pushes an `X.snupkg` beside it, so the
  `.nupkg` push passes `--no-symbols` and the explicit `.snupkg` push is the only symbol push of a
  run. A first attempt pushes each symbol package once; only a re-run of `publish-nuget-sdk` pushes
  a `.snupkg` that may already exist (the unverified symbol-server row).

### Step 2: the re-run probe

A throwaway workflow ran on PR #5553 (closed without merge, so it never reached `main`). It used
`on: pull_request`, no secrets, no publishing. Run 41130582950, attempts 1 and 2 (the second by
`gh run rerun --failed`):

| Question | Observed | Effect on the design |
| --- | --- | --- |
| Is an attempt-1 artifact available in attempt 2? | Yes. The job downloaded `probe` and read "uploaded by attempt 1". | None. The design stands. |
| Does "Re-run failed jobs" run jobs skipped because a prerequisite failed? | Yes. The dependent was skipped in attempt 1 and ran in attempt 2. | None. The design stands. |
| After `D` (`if: always()`, needs a job that fails on every attempt, itself succeeds), does `E` (needs `D`, no status function) run? | **No.** `E` was skipped in both attempts. The implicit `success()` also checks the failed ancestor, not only the direct prerequisite. | Step 4 must give every chain job the explicit `!cancelled() && needs.<prerequisite>.result == 'success'` form. This matters on a tag: `ci` runs after a failed advisory `r2r-compiler-smoke` leg, so a default `needs: publish-verify` job would be skipped. |
| Does the explicit form run in that shape? | Yes, in both attempts. | Confirms the form. |

Not observed by the probe: a missing hosted runner label, the symbol-server answer for a duplicate
`.snupkg`, and the `vsce` pre-release marker. They stay unverified; the first needs a tag run, the
others wait for the step-5 rehearsal.
