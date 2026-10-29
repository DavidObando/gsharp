# ADR-0218: Release publish jobs per destination with safe retry

- **Status**: Proposed
- **Date**: 2026-10-29
- **Phase**: Release engineering
- **Related**: [#5530](https://github.com/DavidObando/gsharp/issues/5530),
  [#4640](https://github.com/DavidObando/gsharp/issues/4640) (closed),
  [#4639](https://github.com/DavidObando/gsharp/issues/4639),
  [ADR-0207](0207-readytorun-compiler-payloads-and-rid-selection.md) ("Costs of the promise"),
  [ADR-0200](0200-component-aware-pr-validation.md),
  [release runbook](../release/final-csharp-release.md)

This ADR is a design proposal. It changes no workflow. An implementation PR
follows maintainer sign-off. File and line references name `main` at
`97929ec08`.

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
aggregate (`build.yml:1090-1100`) requires more jobs: `format`,
`release-version-refs`, `vscode-extension`, `discover-tests` and the three
`go2gs` jobs. `publish` does not need `ci`.

### Facts this proposal rests on

| Fact | How it was checked | Status |
| --- | --- | --- |
| No tag run has ever published a `Gsharp.NET.Sdk.Compiler.<rid>` package. The flat container returns 404 for `gsharp.net.sdk.compiler.linux-x64` and `win-x64`. The latest release is v0.5.212 (2026-10-22). The RID publish steps landed in #5198 on 2026-10-23. | `curl` of `api.nuget.org/v3-flatcontainer`, `gh release list`, `git log -S check-rid-packages` | Verified |
| The five 0.5 tag runs (v0.5.7 to v0.5.212) succeeded on attempt 1. No run among the last 200 of this repository has a second attempt. | `gh api .../actions/runs` | Verified |
| In the 0.4 line, the VS Code step failed on a transient Marketplace error in three releases. `publish-visual-studio-extension` was skipped each time, and no run was re-run. The extensions stayed at 0.4.1 until a manual publish. | #4640, runbook "Marketplace state" | Verified (history) |
| Both marketplaces are at 0.5.212 (`gsharplang.vscode-gsharp` 0.5.212, `gsharplang.GSharp-VisualStudio` 0.5.212.9261). The Visual Studio version has four parts. | Marketplace `extensionquery` API | Verified |
| `dotnet nuget push --skip-duplicate` treats a 409 Conflict as a warning. It does not hide a 401 or 403. | .NET CLI documentation | Verified (docs) |
| `@vscode/vsce` 3.9.2 has `publish --skip-duplicate` ("fail silently if version already exists"), `verify-pat [publisher]`, `show <extensionid> --json`, and `publish --oidc`. | `npx @vscode/vsce@3.9.2 --help`; vsce README | Verified (`--help`) |
| `VsixPublisher.exe publish` of a version that already exists overwrites it. It also supports `-oidc` (trusted publishing). | Visual Studio documentation | Verified (docs); not exercised |
| `gh release upload --clobber` replaces an asset of the same name. `gh release view \|\| create` is a no-op when the release exists. | Runbook, current workflow | Verified (used in releases) |
| "Re-run failed jobs" keeps `GITHUB_SHA` and `GITHUB_REF`. A run can be re-run for 30 days, at most 50 times. | GitHub documentation | Verified (docs) |
| Artifacts of attempt 1 are available to jobs in attempt 2 of the same run. | Not stated in the documentation that was read; no re-run exists in this repository to observe it. | **Unverified** |
| "Re-run failed jobs" also runs the jobs that were skipped because they needed a failed job. | Not stated in the documentation that was read. The runbook assumes it. | **Unverified** |
| A job with `needs` is skipped when a prerequisite fails or is skipped, unless its `if` uses `always()`. | GitHub documentation | Verified (docs) |
| `actions/download-artifact@v5` downloads from another run with `run-id` and `github-token` (`actions: read`). | Action README | Verified (docs) |
| Run artifacts of a tag run expire after about 90 days (the v0.4.591 run of 2026-09-09 expired 2026-12-08). | #4640 comment | Verified (one observation) |
| The REST `workflow_dispatch` `ref` "can be a branch or tag name". The workflow file must exist on the default branch for the event to be offered. A dispatch uses the workflow file at `ref`. | GitHub documentation | Verified (docs) |
| A job-level `concurrency` group is repository-wide, so it serializes the same job across two runs. `cancel-in-progress: false` keeps a running job. | GitHub documentation | Verified (docs) |
| Environments with protection rules work on public repositories under GitHub Free. Deployment policies accept tag name patterns. Environment secrets reach only jobs that name the environment, after its rules pass. The repository is public and has environments `copilot` and `github-pages` only. | GitHub documentation; `gh api .../environments`; `gh repo view` | Verified (docs and API) |
| `jobs.<id>.environment` accepts an expression for its name. | Not re-read. | **Unverified** |
| nuget.org trusted publishing binds a policy to repository owner, repository, workflow file name and an optional GitHub environment. Scopes select "new packages" versus "new versions" by glob. | NuGet documentation | Verified (docs) |
| `build/ci-selection.py` treats `workflow_dispatch` as full validation (`build/test-ci-selection.py:141-144`). | Source | Verified |
| A `v*-rc1` tag still runs `publish`, with a prerelease `-g<sha>` version. | Runbook, `version.json` | Verified (runbook) |

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
5. **No retry outside the tag run.** After 30 days or 50 attempts, or when the
   tag's workflow file lacks a fix, nothing publishes without a new tag. The
   runbook then asks for a manual publish from a workstation with the PAT.
6. **No pre-flight.** Nothing checks the tag name against the package version
   (#4639), the artifact inventory, or the credentials before the first push.
7. **Gate against ADR-0207.** ADR-0207 says a RID whose smoke cannot run must
   not block the release. `publish` needs all six legs of
   `r2r-compiler-smoke`. If a hosted label such as `macos-15-intel` disappears,
   the tag cannot publish, and the tag's workflow cannot be edited.

### Failure matrix today

| Failing step | What stays published | "Re-run failed jobs" today |
| --- | --- | --- |
| A gate job | Nothing | Re-runs the gate, then `publish`. If the cause is a missing runner label, the tag is stuck. |
| 1 GitHub release | Nothing, or a release with some assets | Safe: `view \|\| create`, `--clobber`. |
| 2 RID pushes (for example 403 from an API key that does not cover the six new ids) | Public release; zero to five RID packages; no SDK; no marketplaces | Safe for NuGet (`--skip-duplicate`). The cause (key scope) needs a new key, which a re-run cannot supply. |
| 3 RID wait (30 min) | Public release; six RID packages on the way | Safe. |
| 4 Remaining packages (one attempt each) | Public release; RID packages; SDK and some tools | Safe. A failed SDK push with RID packages present leaves a consistent feed. |
| 5 Post-check | Everything on NuGet | Safe. |
| 6 VS Code (error before upload) | Release and NuGet | Safe. |
| 6 VS Code (timeout after upload) | Release, NuGet and VS Code | **Fails again.** `vsce publish` rejects the existing version. The Visual Studio job never runs. Manual publish per runbook. |
| 7 Visual Studio | Everything but Visual Studio | Re-runs only that job. `VsixPublisher` overwrites the same version. |

## Decision

### 1. One job per destination behind one verified artifact set

The release path becomes a reusable workflow,
`.github/workflows/release-publish.yml` (`on: workflow_call`). `build.yml`
calls it on a `v*` tag. A new `release-retry.yml` (`on: workflow_dispatch`)
calls it for a retry. The reusable workflow holds one job per destination.
Every job downloads the artifacts of one source run. No job builds anything.

Inputs of the reusable workflow: `run_id` (the run whose artifacts to publish),
`tag`, `destination` (`all` or one job name below) and `dry_run` (boolean).

| Job | Runner | `needs` | Environment | Permissions | Does |
| --- | --- | --- | --- | --- | --- |
| `publish-verify` | ubuntu | none | none | `actions: read` | Downloads `nuget-packages`, `vscode-gsharp-vsix`, `visual-studio-gsharp-vsix` from `run_id`. Runs `release-publish.py verify` (section 3). Uploads the verified set as artifact `release-set` with a `manifest.json` of SHA-256 digests. Outputs `version`. |
| `publish-github-release` | ubuntu | `publish-verify` | `release` | `contents: write` | `gh release view \|\| gh release create --draft --generate-notes`; `gh release upload --clobber` of all assets. The release stays a draft until `publish-finalize`. |
| `publish-nuget-compiler` | ubuntu | `publish-verify` | `release` | none | Pushes the six `Gsharp.NET.Sdk.Compiler.<rid>` packages with retry, then `check-rid-packages.py --wait-minutes 30`. |
| `publish-nuget-sdk` | ubuntu | `publish-nuget-compiler` (see the `if` below) | `release` | none | Runs `check-rid-packages.py` (no wait) as a precondition. Pushes `Gsharp.NET.Sdk` and the remaining packages with retry. Runs `check-rid-packages.py --require-sdk --wait-minutes 15`. |
| `publish-vscode-marketplace` | ubuntu | `publish-verify` | `release` | none | Reads the version inside the VSIX. Queries the Marketplace. Skips when present. Else `npx @vscode/vsce@<pinned> publish --packagePath ... --skip-duplicate`. Confirms presence after the publish. |
| `publish-visual-studio-marketplace` | windows | `publish-verify` (open question 3 adds `publish-nuget-sdk`) | `release` | none | Reads `Identity/@Version` from `extension.vsixmanifest` in the VSIX. Queries the Marketplace. Skips when present. Else `VsixPublisher.exe publish`. Confirms presence. |
| `publish-finalize` | ubuntu | all five publish jobs, `if: always()` | `release` | `contents: write` | Reads `toJSON(needs)`. Queries every destination (section 4). When every destination has the version, `gh release edit --draft=false` and a summary table. Else fails and names the destinations to retry. |

Rules for every publish job:

- `if: always() && needs.publish-verify.result == 'success' && (inputs.destination == 'all' || inputs.destination == '<this job>')`.
  A job that is not selected is skipped, not failed, so `publish-finalize`
  can tell the two apart.
- `publish-nuget-sdk` adds `&& (needs.publish-nuget-compiler.result == 'success' || inputs.destination == 'publish-nuget-sdk')`.
  The topology edge is not the only guard. The feed check inside the job is
  the guard that matters, because ADR-0207 result 6 makes a missing RID
  package a restore failure.
- `concurrency: { group: release-<job>, cancel-in-progress: false }`. Two
  tags, or a tag run and a retry, never publish to one destination at once.
- Inputs reach shell only through `env:`. No `${{ inputs.* }}` inside `run:`.
- Every destination step calls `build/release-publish.py <destination>` with
  `--artifacts`, `--tag`, `--version` and, when `inputs.dry_run`, `--dry-run`.
  The workflow holds no publish logic of its own.

### 2. Gate set and the two callers

`build.yml` keeps one job for the tag path:

```yaml
  publish:
    needs: [build, tests, test-partition, harness, e2e, ilverify, cs2gs-corpus,
            vsix, visual-studio-extension, desktop-msbuild-sdk-smoke, r2r-compiler-smoke]
    if: startsWith(github.ref, 'refs/tags/v')
    permissions: { contents: write, actions: read, id-token: write }
    uses: ./.github/workflows/release-publish.yml
    with: { run_id: '${{ github.run_id }}', tag: '${{ github.ref_name }}', destination: all, dry_run: false }
    secrets: inherit
```

The gate list is the one that `publish` has today. Open question 1 asks
whether it becomes `needs: [ci]`. `build/release-publish.py gate-jobs` prints
the list, and a test asserts that `build.yml` names the same jobs, in the style
of `build/test-ci-selection.py`. The retry caller checks the same list.

`release-retry.yml` runs on `workflow_dispatch` from `main` with inputs `tag`
(string), `destination` (choice) and `dry_run` (boolean, default `true`).
Its first job, `resolve`, runs `release-publish.py resolve --tag <tag>`:

1. Rejects a tag that does not match `^v\d+(\.\d+)*$` or that does not exist
   (`GET /repos/{owner}/{repo}/git/ref/tags/{tag}`).
2. Finds the `build` workflow run of that tag (`event=push`, `branch=<tag>`).
3. Requires every gate job of that run to have conclusion `success` (jobs API,
   `filter=latest`). The job names come from `gate-jobs`.
4. Outputs the run id and the tag commit.

Then it calls `release-publish.yml` with that run id. The retry never rebuilds.
It works while the artifacts of the tag run exist (about 90 days). After that,
a new tag is the only path, which this ADR accepts.

"Re-run failed jobs" on the tag run stays the first retry tool. With one job
per destination, it re-runs only the failed destinations and `publish-finalize`.

### 3. Verify before the first push

`release-publish.py verify` runs in `publish-verify` and fails the whole
release before any push when:

- the three artifacts are missing or the inventory is wrong: six RID packages,
  `Gsharp.NET.Sdk`, every other `IsPackable` package of the build, their
  `.snupkg` files, and both VSIX files;
- the packages carry more than one version;
- the tag is not `v<NuGetPackageVersion>` (this closes #4639; open question 6
  decides the rule for a prerelease tag);
- the `PackageDownload` version inside `Gsharp.NET.Sdk.props` of the SDK
  package is not the version of the six RID packages;
- the VS Code VSIX version is not `SimpleVersion` of the tag, or the Visual
  Studio VSIX version does not start with it;
- the project templates inside the Visual Studio VSIX do not pin
  `Gsharp.NET.Sdk/<version>`.

The job writes `manifest.json` with the SHA-256 of every file and uploads the
set as `release-set`. Every publish job downloads `release-set` and checks the
digests. The runbook's stage-2 section wanted a digest-bound manifest; this is
the small version of it.

### 4. Idempotency per destination

"Already published at this version" is success. Each destination has a
read-only query that runs before and after the write.

| Destination | Query | Write | Idempotent today | Idempotent proposed |
| --- | --- | --- | --- | --- |
| nuget.org | Flat container `/<id>/<version>/<id>.nuspec` (`check-rid-packages.py` has it). | `dotnet nuget push --skip-duplicate`, three attempts with a pause. | Yes (409 is a warning). The remaining-packages loop has no retry. | Yes. The script skips a package that the query finds, so a re-run pushes only the missing ones and reports them. 401 and 403 still fail. |
| GitHub release | `gh release view <tag> --json assets`. | `view \|\| create --draft`; `upload --clobber`. | Yes. | Yes. The script uploads only assets whose digest differs from `manifest.json`. One job owns `create`, so two jobs never race on it. |
| VS Code Marketplace | `extensionquery` REST, or `vsce show gsharplang.vscode-gsharp --json`, compared with `extension/package.json` `version` inside the VSIX. | `vsce publish --packagePath --skip-duplicate`, pinned to the `devDependencies` version (3.9.2). | **No.** | Yes. The pre-query skips a present version. `--skip-duplicate` covers the window between query and publish. Whether `--skip-duplicate` also tolerates the post-upload error after a timeout is unverified; the post-query decides, not the exit code of vsce. |
| Visual Studio Marketplace | `extensionquery` for `gsharplang.GSharp-VisualStudio`, compared with `Identity/@Version` of `extension.vsixmanifest` inside the VSIX. The comparison uses the full four-part version from the artifact, not the tag. | `VsixPublisher.exe publish`. | Yes by overwrite (documented, not exercised). | Yes. The pre-query skips a present version. An overwrite of the same version is accepted as a no-op. |

The Marketplace queries and the flat container are public and need no
credentials. They can run from any job, including the dry run on `main`.

### 5. `workflow_dispatch` retry and its safety

- **Only existing tags.** `resolve` rejects a malformed tag, an unknown tag, a
  tag whose run did not pass the gates, and a run without artifacts.
- **No rebuild.** The retry publishes the bytes of the tag run, checked against
  `manifest.json`.
- **Environment.** The tag path uses environment `release`, with deployment
  policy "Selected branches and tags: `v*`" and no reviewers, so pushing the
  tag stays the approval. The retry runs on `main`, so it uses environment
  `release-retry`, with branch policy `main` and a required reviewer (the
  maintainer, with "prevent self-review" off). The job sets the environment
  name by expression (unverified; the fallback is two copies of the publish
  jobs, which this ADR does not want).
- **Secrets.** `NUGET_API_KEY` and `VSCE_PAT` move from repository secrets to
  environment secrets of both environments. No new secret. Jobs outside the two
  environments cannot read them. `GITHUB_TOKEN` gets `contents: write` only in
  the two jobs that touch the release.
- **Inputs.** `destination` is a `choice`. `tag` is validated by regex before
  any use and never interpolated into a `run:` script.
- **Default dry run.** `dry_run` defaults to `true`. A real retry needs an
  explicit `false` and the reviewer's approval.
- **Serialization.** The concurrency groups of section 1 stop a retry from
  overlapping a tag run of the same destination.

### 6. Dry-run mode

`release-publish.py <destination> --dry-run` runs the same code as the real
publish, up to the write. It downloads nothing from secrets. It:

1. runs `verify` (section 3);
2. queries each destination and prints a plan: "push" for an absent version,
   "skip" for a present one, with the file names and digests;
3. exercises `dotnet nuget push` against a local folder source
   (`--source <temp dir>`) for every package, in the real order, so the loop,
   the retry and the count logic run;
4. checks credentials where a read-only check exists: `vsce verify-pat
   gsharplang` for the shared PAT (both marketplaces use the `gsharplang`
   publisher), and `gh api repos/{owner}/{repo}/releases` for the token. nuget.org
   offers no key check without a push; with trusted publishing (section 8),
   `NuGet/login` obtains the temporary key without a push and so verifies the
   policy;
5. prints the same summary table as `publish-finalize`.

A job `publish-dry-run` runs on every push to `main`, needs `build`, `vsix` and
`visual-studio-extension`, and has no environment and no secrets, so step 4 is
skipped there. Credential checks run only in the environments: in the retry
with `dry_run: true`, and in a tag run before the first write.

This is the check that would have caught the current gap. Since #5198 every
`main` run packs seven NuGet packages that no publish code has ever consumed.
A dry run on `main` would have run the inventory, the version agreement
between SDK and RID packages, the push order and the local-folder push on
every commit since 2026-10-23. A real tag then runs code that `main` has
exercised. The gap that no dry run closes is the acceptance of a new package id
by nuget.org, which depends on the scope of `NUGET_API_KEY`
(open question 7).

### 7. Failure matrix proposed

"Re-run" means "Re-run failed jobs" on the tag run. "Dispatch" means
`release-retry.yml` with the named destination.

| Failing job | What stays published | Re-run or dispatch | Result |
| --- | --- | --- | --- |
| A gate job | Nothing | Re-run the gate. If a runner label is gone, see open question 2. | The reusable workflow runs after the gate passes. |
| `publish-verify` | Nothing | Fix is a new tag. The inventory is wrong by construction. | No destination is touched. |
| `publish-github-release` | Draft release with some assets; every other destination proceeds | Re-run or dispatch `publish-github-release` | Uploads only the assets whose digest differs. `publish-finalize` un-drafts. |
| `publish-nuget-compiler` | Zero to six RID packages; SDK not pushed; marketplaces and draft release proceed | Re-run or dispatch `publish-nuget-compiler`, then `publish-nuget-sdk` runs | Pushes only the missing RID packages. The SDK job waits for the feed check. |
| `publish-nuget-sdk` | Six RID packages; some of SDK and tools | Re-run or dispatch `publish-nuget-sdk` | The precondition check passes; pushes only the missing packages. |
| `publish-vscode-marketplace` (timeout after upload) | Everything else | Re-run or dispatch `publish-vscode-marketplace` | The pre-query finds the version and the job succeeds. The Visual Studio job was never blocked. |
| `publish-visual-studio-marketplace` | Everything else | Re-run or dispatch | Pre-query, else overwrite publish. |
| `publish-finalize` (a destination failed) | Everything that succeeded; release stays draft | Fix the failed destination; `publish-finalize` re-runs with it | Un-drafts only when every query returns the version. |
| Tag run older than 30 days or re-run 50 times | As above | Dispatch | Same scripts, same artifacts, reviewer approval. |
| Artifacts expired (about 90 days) | As above | None | New tag. Out of scope. |

### 8. Trusted publishing (follow-up, not required)

nuget.org, the VS Code Marketplace (`vsce publish --oidc`) and the Visual
Studio Marketplace (`VsixPublisher.exe publish -oidc`) accept GitHub OIDC
tokens. A policy binds the repository, the workflow file and, for nuget.org,
an optional environment. This removes `NUGET_API_KEY` and `VSCE_PAT` and their
expiry. It is independent of the job split and goes into its own issue. Note
for that issue: for a reusable workflow the OIDC token carries both
`workflow_ref` (caller) and `job_workflow_ref` (called); which one nuget.org
matches against "Workflow File" is unverified.

## Consequences

Positive:

- A failed destination is re-run alone. A re-run pushes only what is missing.
- The Visual Studio job no longer depends on the VS Code job.
- The six-RID publish path runs on every `main` push in dry-run mode before a
  tag depends on it.
- The GitHub release becomes public only when every destination has the
  version.
- The tag check of #4639 and a digest-bound artifact set come with the verify
  step.
- Secrets move into environments. The retry needs a reviewer.

Negative:

- Two more workflow files and one more script with tests.
- The release page appears later than today (after `publish-finalize`).
- More jobs per tag run (seven instead of two). Each is short.
- The `environment` expression and the cross-attempt artifact behavior are
  unverified until migration step 2 observes them.

Neutral:

- The gate set is unchanged unless open question 1 changes it.
- The runbook's manual-publish section stays as the last resort.

## Migration plan

Each step is a PR. The first is the least risky. Nothing before step 5 changes
the publish topology.

1. **Script and tests, no workflow change.** Add `build/release-publish.py`
   with subcommands `verify`, `gate-jobs`, `resolve`, one per destination, and
   `--dry-run`. Add `build/test-release-publish.py` with a fake flat container,
   a fake Marketplace and fake artifacts. Mutants (ADR-0154): a script that
   pushes the SDK before the six RID packages, one that skips the count, one
   that compares the Visual Studio version to the tag instead of the manifest,
   and one that accepts a `v0.5.1-rc1` tag as a release. Verifiable on PR CI.
2. **Observe the two unverified semantics.** A PR adds a throwaway workflow
   `rerun-probe.yml` (`on: pull_request`): job A uploads an artifact; job B
   fails when `github.run_attempt == 1`; job C needs B and downloads the
   artifact. Re-run failed jobs. Record whether C ran and whether the download
   found the attempt-1 artifact. The same PR tries `environment: ${{ ... }}`
   against a throwaway environment. The PR is closed without merge; the
   findings go into this ADR's fact table.
3. **Dry run on `main`.** Add `publish-dry-run` to `build.yml`. Register the
   new paths in `build/ci-selection.py` so a PR that changes them runs it.
   Verifiable on the next `main` push.
4. **Harden the existing job.** In the current `publish` job: pin vsce, add
   `--skip-duplicate`, call the script for each step (pre-query, retry on the
   remaining packages, move the six count before the pushes). Change
   `publish-visual-studio-extension` to need the gate set instead of
   `publish`. Verifiable: the next tag runs the same code as the dry run.
5. **Split.** Add `release-publish.yml`, replace the two jobs with the caller
   job. Create environment `release` with the `v*` tag policy, move the two
   secrets. Verifiable before a tag: the dry-run job runs the same scripts;
   the workflow syntax is checked with `actionlint` locally. The first real
   exercise is the next tag.
6. **Retry.** Add `release-retry.yml` and environment `release-retry` with the
   reviewer. Verifiable without a release: dispatch with `dry_run: true` for
   an existing tag such as `v0.5.212`. Expected plan: every destination
   "skip" (already published), credentials verified.
7. **Trusted publishing.** Separate issue.

Update `docs/release/final-csharp-release.md` ("Watch the tag run" and the
manual-publish section) in step 5 and step 6.

## Alternatives considered

1. **Keep one job and add `--skip-duplicate` to vsce.** Fixes the known failure
   but keeps the Visual Studio coupling, the public-release-before-feed order
   and the single re-run unit. Step 4 of the migration takes the cheap part.
2. **Dispatch inside `build.yml`.** One file, and the nuget.org OIDC policy
   names `build.yml`. Rejected because `ci-selection.py` treats a dispatch as
   full validation, so every CI job would run on `main` for a retry, or the
   selection contract would need a release-retry exception. Every publish job
   would also carry a dual `if`. The reusable workflow keeps the job
   definitions in one place without that.
3. **Rebuild on retry.** A dispatch that checks out the tag and builds again.
   Rejected: the retry would publish bytes that differ from the release assets
   and from what the gates tested. The repository keeps emitted output
   deterministic, but package timestamps and signatures are not.
4. **`continue-on-error` on the Marketplace steps.** Hides a failure as
   success. Rejected.
5. **A matrix over destinations.** One job definition, but the runners differ,
   the RID-to-SDK edge cannot be expressed inside a matrix, and `fail-fast`
   semantics do not fit. Rejected.
6. **Use the GitHub release as the artifact store for retries.** A draft
   release is not public, assets can be replaced, and the window is not longer
   than the run artifacts in practice. Rejected in favor of run artifacts with
   `manifest.json`.
7. **A release workflow on the `release: published` event.** The release
   would be created by hand and the gates would not be bound to it. Rejected.
8. **Public release at once, as today.** Rejected in favor of draft-then-finalize,
   because a public release page for a version that no feed serves misleads
   users. Open question 4 lets the maintainer keep today's behavior.

## Open questions

1. **Gate set.** Keep the eleven-job list, or `needs: [ci]`? `ci` adds
   `format`, `release-version-refs`, `vscode-extension`, `discover-tests` and
   the three `go2gs` jobs to the gate. It removes the drift between the two
   lists.
2. **`r2r-compiler-smoke` as a hard gate.** ADR-0207 says a RID that the smoke
   cannot verify may ship, named in the release notes. Today `publish` needs
   all six legs. Options: keep the hard gate; gate on the five hosted
   x64/arm64 legs and make `osx-x64` advisory; or make the whole smoke
   advisory with a release-notes requirement that `verify` enforces.
3. **Visual Studio extension after the SDK.** The VSIX project templates pin
   `Gsharp.NET.Sdk/<version>`. A user who installs the extension before the SDK
   is on the feed gets a template that fails to restore. Add `needs:
   publish-nuget-sdk` to `publish-visual-studio-marketplace`, or accept the
   window? The VS Code extension has no such pin.
4. **Draft release until finalize.** Accept that the release page appears a
   few minutes later, or keep the public release at the start?
5. **Two environments and a required reviewer on the retry.** Accept the
   reviewer step (the maintainer approves their own dispatch), or use one
   environment with tag policy `v*` plus branch `main` and no reviewer?
6. **Prerelease tags.** `verify` requires `v<NuGetPackageVersion>`. A
   `v0.5.300-rc1` tag publishes `0.5.300-g<sha>` today. Reject such tags, or
   allow them and mark the GitHub release as a prerelease?
7. **`NUGET_API_KEY` scope.** The key was updated 2026-05-29. The six
   `Gsharp.NET.Sdk.Compiler.<rid>` ids are new. The key must allow "push new
   packages" for the glob that covers them, or the first RID push fails with
   403 and no retry helps. This is a check before the next tag, not a design
   choice, but only the maintainer can do it.
8. **Reusable workflow versus one file.** Section 2 recommends the reusable
   workflow. Alternative 2 lists the cost of one file.
9. **Trusted publishing.** Open an issue for section 8 now, or after the split
   has run in one release?
