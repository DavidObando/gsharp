# ADR-0218: Release publish jobs per destination with safe re-run

- **Status**: Proposed
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
| `VsixPublisher.exe publish` of a version that already exists overwrites it. | Visual Studio documentation | Verified (docs); not exercised |
| `gh release upload --clobber` replaces an asset of the same name. `gh release view \|\| create` is a no-op when the release exists. | Runbook, current workflow | Verified (used in releases) |
| "Re-run failed jobs" keeps `GITHUB_SHA` and `GITHUB_REF`. A run can be re-run for 30 days, at most 50 times. | GitHub documentation | Verified (docs) |
| Artifacts of attempt 1 are available to jobs in attempt 2 of the same run. | Not stated in the documentation that was read; no re-run exists in this repository to observe it. Migration step 2 observes it. | **Unverified** |
| "Re-run failed jobs" also runs the jobs that were skipped because they needed a failed job. | Not stated in the documentation that was read. The runbook assumes it. Migration step 2 observes it. | **Unverified** |
| A job with `needs` is skipped when a prerequisite fails or is skipped, unless its `if` uses `always()` or `!cancelled()`. `always()` is also true in a cancelled run. | GitHub documentation | Verified (docs) |
| `needs.<job>.result` of a matrix job is one value for all legs. The jobs API lists the legs by display name, `r2r-compiler-smoke (<rid>)`. | `build.yml:1046`; `gh run view --json jobs` | Verified |
| A `v*-rc1` tag runs `publish` with a prerelease version `<number>-g<sha>`, because `publicReleaseRefSpec` matches only `^refs/tags/v\d+(?:\.\d+)*$`. The VSIX versions carry no suffix (`SimpleVersion`). | `version.json`, runbook, `build.yml:737-747` | Verified |
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
5. **Extensions before the SDK.** Both extensions can reach the marketplaces
   while the SDK push is still failing. The Visual Studio templates pin the
   exact SDK version, so a user who installs early gets a template that cannot
   restore.
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

Every job has `if: startsWith(github.ref, 'refs/tags/v')` unless the table
says otherwise, downloads the artifacts of the same run with
`actions/download-artifact@v5`, and builds nothing.

| Job | Runner | `needs` | Permissions | Does |
| --- | --- | --- | --- | --- |
| `publish-verify` | ubuntu | `ci` | `actions: read` | Downloads `nuget-packages`, `vscode-gsharp-vsix`, `visual-studio-gsharp-vsix`. Runs `release-publish.py verify` (section 3). Outputs `version`, `prerelease` (`true` for a prerelease tag) and `unverified_rids` (section 2). |
| `publish-github-release` | ubuntu | `publish-verify` | `contents: write` | `gh release view \|\| gh release create --draft --generate-notes`, with `--prerelease` when `prerelease` is `true`. `gh release upload --clobber` of every `.nupkg`, `.snupkg` and `.vsix`. The release stays a draft until `publish-finalize`. |
| `publish-nuget-compiler` | ubuntu | `publish-verify` | none | `release-publish.py nuget-push --group compiler`: the six RID packages, then `check-rid-packages.py --wait-minutes 30`. |
| `publish-nuget-sdk` | ubuntu | `publish-verify`, `publish-nuget-compiler` | none | `check-rid-packages.py` (no wait) as a precondition, then `nuget-push --group sdk`: `Gsharp.NET.Sdk` and the remaining packages with their `.snupkg`, then `check-rid-packages.py --require-sdk --wait-minutes 15`. |
| `publish-vscode-marketplace` | ubuntu | `publish-verify`, `publish-nuget-sdk` | none | Reads `extension/package.json` `version` from the VSIX. `release-publish.py marketplace-version gsharplang.vscode-gsharp`. Skips when present. Else `npx --yes @vscode/vsce@3.9.2 publish --packagePath ... --skip-duplicate`, plus `--pre-release` when `prerelease` is `true`. Queries again and fails when the version is still absent. |
| `publish-visual-studio-marketplace` | windows | `publish-verify`, `publish-nuget-sdk` | none | Reads `Identity/@Version` from `extension.vsixmanifest` in the VSIX. `marketplace-version gsharplang.GSharp-VisualStudio`. Skips when present. Else `VsixPublisher.exe publish` as today. Queries again. |
| `publish-finalize` | ubuntu | `publish-verify`, `publish-github-release`, `publish-vscode-marketplace`, `publish-visual-studio-marketplace`; `if: !cancelled() && startsWith(github.ref, 'refs/tags/v') && needs.publish-verify.result == 'success'` | `contents: write` | Requires the result of the other three prerequisites to be `success` (a skipped extension job means the SDK chain failed). Queries the flat container for the twelve packages, both marketplaces and the release assets. When every destination has the version: appends "Unverified platforms" (section 2) to the release body and runs `gh release edit --draft=false`. Else fails and names the destinations to re-run. Writes a summary table either way. |

The dependency chain is: six RID packages, then the SDK and tools, then both
extensions, then finalize. The GitHub release draft runs beside the chain.
Rules:

- Default `needs` semantics do the gating. A job whose prerequisite failed is
  skipped. Only `publish-finalize` uses `!cancelled()`, so that it reports
  the state after a failure. It does not use `always()`, because `always()`
  also runs in a cancelled run, and a cancelled release must not be
  finalized. The `needs` context holds direct prerequisites only, so every job
  that reads `needs.publish-verify.outputs.*` lists `publish-verify`.
- Secrets stay repository secrets (`NUGET_API_KEY`, `VSCE_PAT`,
  `GITHUB_TOKEN`), as today. No environment is needed for them: the publish
  jobs run only on `v*` tag refs, which only the maintainer pushes, and
  repository secrets do not reach fork pull requests. An environment would
  repeat the tag condition as a deployment policy and add a moving part.
- `contents: write` is given to the two jobs that touch the release. The
  other jobs keep `contents: read`.
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
  output; `publish-verify` forwards it.
- `publish-finalize` appends a section to the GitHub release body:
  "Unverified platforms: `osx-x64`. The ReadyToRun compiler smoke did not run
  or did not pass on this platform (ADR-0207). The IL compiler is the
  fallback." The post-release documentation PR copies the sentence into
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

### 3. Verify before the first push

`release-publish.py verify --artifacts <dir> --tag <tag>` runs in
`publish-verify` and fails the release before any push when:

- the inventory is wrong. Expected: six `Gsharp.NET.Sdk.Compiler.<rid>.nupkg`
  (no symbols), six other `.nupkg` (`Gsharp.NET.Sdk`, `Gsharp.Templates`,
  `Gsharp.Repl`, `Gsharp.Gsfmt`, `Gsharp.Cs2Gs`,
  `GSharp.CodeAnalysis.Analyzers.Testing`), five `.snupkg` (all of those but
  `Gsharp.Templates`), `vscode-gsharp.vsix` and `GSharp.VisualStudio.vsix`.
  The list lives in the script, next to `RIDS` of `check-rid-packages.py`;
- the packages carry more than one version;
- the tag does not match the version. A release tag `^v\d+(\.\d+)*$` must
  equal `v<version>`. A prerelease tag `^v\d+(\.\d+)*-[0-9A-Za-z.-]+$` must
  have a package version `<number>-g<sha>` whose `<number>` equals the tag's
  number. Any other tag fails. This closes #4639;
- the `PackageDownload` version inside `Gsharp.NET.Sdk.props` of the SDK
  package is not the version of the six RID packages;
- the VS Code VSIX version is not the `<number>` of the tag, or the Visual
  Studio VSIX version does not start with it;
- the project templates inside the Visual Studio VSIX do not pin
  `Gsharp.NET.Sdk/<version>`.

The NuGet part of the same check (`verify --nuget-only`, the first four
points without the tag) also runs as a step of the `build` job on every push,
right after the existing `check-netstandard-*` steps, against
`out/bin/Release/nupkgs`. That step would have shown, on every `main` push
since 2026-10-23, that the build produces a seven-package SDK set that the
publish code has never consumed. It costs one script call and no secrets.

### 4. Idempotency per destination

"Already published at this version" is success.

| Destination | Mechanism | Idempotent today | Idempotent proposed |
| --- | --- | --- | --- |
| nuget.org | `dotnet nuget push <pkg>.nupkg --skip-duplicate`, three attempts with a pause, in the fixed order. Then, when `<pkg>.snupkg` exists, `dotnet nuget push <pkg>.snupkg --skip-duplicate` explicitly, so a symbol package whose first upload failed after the primary succeeded is retried on a re-run. No flat-container pre-query decides a skip: the feed proves the primary only, not the symbols. | Yes (409 is a warning). The remaining-packages loop has no retry. | Yes, with retry on both groups. 401 and 403 still fail. |
| GitHub release | `view \|\| create --draft [--prerelease]`; `upload --clobber`. One job owns `create`. | Yes. | Yes. |
| VS Code Marketplace | Pre-query (`marketplace-version`, the `extensionquery` REST). Present: skip. Absent: `vsce publish --skip-duplicate [--pre-release]`. Post-query decides success, not the vsce exit code, because `--skip-duplicate` after a post-upload timeout is unverified. vsce pinned to 3.9.2. | **No.** | Yes. |
| Visual Studio Marketplace | Pre-query on the four-part version from `extension.vsixmanifest`. Present: skip. Absent: `VsixPublisher.exe publish` (documented overwrite). Post-query. | Yes by overwrite (not exercised). | Yes. |

The flat container and the `extensionquery` API are public. The queries need
no credentials.

### 5. Prerelease tags

A prerelease tag such as `v0.5.300-rc1` publishes. The GitHub release is
created with `--prerelease` and stays so after finalize. NuGet receives the
prerelease versions `<number>-g<sha>` that the build already produces. The VS
Code extension is published with `--pre-release`. The Visual Studio Marketplace
has no pre-release channel, so its users receive the version as an update.

The VSIX versions carry no suffix. A prerelease tag and the following release
tag must therefore sit on different commits, so that the NBGV height differs
and the marketplace versions differ. A release run whose `marketplace-version`
pre-query finds the VS Code version present as a pre-release (the version
property `Microsoft.VisualStudio.Code.PreRelease`, name unverified) fails in
`publish-verify` with a collision message instead of skipping. The Visual
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
| `publish-vscode-marketplace` (timeout after upload) | Everything but Visual Studio and finalize | The pre-query finds the version; the job succeeds; finalize un-drafts. The Visual Studio job was never blocked by it. |
| `publish-visual-studio-marketplace` | Everything but finalize | Pre-query, else overwrite publish; finalize un-drafts. |
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
   found the attempt-1 artifact. The PR is closed without merge; the findings
   go into the fact table.
3. **Advisory smoke.** Add the advisory rule and the `unverified_rids` output
   to `ci-selection.py --check build` and `ci`, with the tests of section 2.
   Verifiable on PR CI (the rule is inert off tags) and by the script tests.
4. **Split.** Replace the two publish jobs with the seven jobs of section 1,
   `needs: [ci]`, draft-then-finalize, prerelease handling, pinned vsce,
   `--skip-duplicate`, both extensions after the SDK. Update the runbook
   ("Watch the tag run", "Post-publish docs PR" for the unverified-platform
   sentence, manual publish as last resort). Verifiable before a tag only by
   the script tests and `actionlint`; the real exercise is step 5.
5. **Rehearsal: one real prerelease.** The maintainer tags `v0.5.N-rc1` on a
   `main` commit and approves that run. It exercises every job, the six-RID
   publish, the symbol pushes, both marketplaces with a pre-release VS Code
   version, the draft and the finalize. The run also answers the unverified
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
7. `NUGET_API_KEY` can push any package id. Precondition met; no action.
8. Prefer the simplest graph with per-destination re-run: inline jobs, no
   dry-run job, one verify step in `build`.
9. Trusted publishing and assembly signing are a separate issue.

No question remains open.
