# Runbook: the final C#-built 0.4.x release

This runbook covers the last release whose compiler is built from C# source.
It is a fresh `v0.4.NNNN` tag on the freeze commit. The C# source is then kept
on branch `cs2gs/csharp-0.4`, and the compiler source on `main` becomes G#.
The pinned 0.4.NNNN SDK builds it (stage 1, the bootstrap). Per #4631, 0.5.x
ships the stage-2 compiler, which is the G# source rebuilt by the stage-1
compiler. See [`release-notes-0.5-draft.md`](release-notes-0.5-draft.md).

Everything here comes from the workflows and the scripts they call. Citations
are `file:line` at commit `6c4824cbc`; later edits to `build.yml` shift them.
The owner performs every step that pushes a tag, publishes, or changes
repository settings. Agents prepare PRs and verify.

`NNNN` below is the Nerdbank.GitVersioning (NBGV) patch number of the freeze
commit.

## What the workflows do on a tag

| Fact | Source |
|---|---|
| `build.yml` runs on `push` of tags matching `v*`. The same file runs for pushes to `main` and PRs into `main`. | `.github/workflows/build.yml:3-11` |
| The tag only gets a clean version (no `-g<sha>` suffix) if it matches `^refs/tags/v\d+(?:\.\d+)*$`. A tag with a SemVer prerelease suffix such as `v0.5.NNN-rc1` is a *prerelease* (`build/release-publish.py tag-kind`): it publishes packages with a `<number>-g<sha>` version, a pre-release VS Code extension and a draft GitHub release marked as a prerelease, and skips the Visual Studio Marketplace (ADR-0218). | `version.json:9-12`, `build/release-publish.py` |
| The version comes from the tagged commit's git height, not from the tag name. Nothing compares the two (#4639). Builds on `main` are also public, so the `main` push run of the freeze commit already prints the version the tag will publish. | `version.json:7-12`, `build.yml:48-62` |
| `publish-verify` waits for the `ci` aggregate, which needs every job of `build.yml`; `ci` passes when `r2r-compiler-smoke` fails on a tag (ADR-0218, advisory), and the platforms whose leg did not pass are named in the release body. `verify` also fails the run before any push when the tag does not match the package version (#4639). | `build.yml` (`ci`, `publish-verify`) |
| No job declares an `environment:`, so publishing has no approval gate: pushing the tag is the approval. Repository environments are only `copilot` and `github-pages` (`gh api repos/DavidObando/gsharp/environments`, read 2026-10-02). | `build.yml` (no `environment:` key) |

### Stage-2 publication gate

**Owner decision, 2026-10-14: the gate is removed.** The `publish` job no longer
requires a `selfhost-stage2-nightly` run on the tagged commit, and the temporary
workflow guard that refused a 0.5 or stage-2-built artifact is gone, so a 0.5
release can be tagged and published. Stage-1/stage-2 certification is a local,
owner-run step: it cannot run on hosted runners, and its reports are kept as
cut-over evidence in `docs/self-migration-cutover.md` (automating it in the
publish path was deferred, #4885). The rest of this section records the rule as
it stood before the decision; it no longer describes the workflow.

The table above describes the final 0.4 C# release. It is not sufficient for an
artifact whose emitted version is 0.5 or whose build uses the stage-2 compiler.
This rule applies regardless of tag text.

Before any such package or extension can publish:

- ADR-0198 MUST be accepted and its replacement gate MUST be on `main`;
- the exact tagged commit MUST have successful controller-owned stage-1/stage-2
  certification evidence and the required fresh-clone cutover dry run;
- that evidence MUST bind the exact commit and Git tree identities to the common
  source manifest. Dirty, untracked participating, or different-commit source
  bytes MUST be rejected;
- the `publish` job MUST depend on the replacement certification job and verify
  the evidence commit and run identity;
- the controller-owned release manifest MUST list the SHA-256 digest of every
  package and extension to publish, and each artifact MUST be produced by the
  certified run or have every input bound to accepted evidence;
- before the first upload, the publish jobs MUST verify every artifact against
  that manifest. Same-commit artifacts with different bytes MUST be rejected;
- `publish-visual-studio-extension` MUST remain downstream of that gated
  `publish` job.

A first implementation change MUST add a temporary workflow guard that rejects
an emitted 0.5 artifact or an artifact built by the stage-2 compiler, regardless
of tag text. The evidence-bound certification dependency MUST replace that
guard in the same change that enables certified publication.

A self-migration nightly, a proof from another commit, or a manually copied
report MUST NOT satisfy this gate. Until the workflow enforces these checks, a
0.5 artifact or an artifact built by the stage-2 compiler MUST NOT publish.

### Publish order (one tag run)

Seven jobs, one per destination (ADR-0218). The only retry tool is "Re-run failed jobs" on the tag run.

| Job | What it does |
|---|---|
| `publish-verify` | `release-publish.py verify`: the package inventory (6 RID compiler packages, 6 other packages, 5 symbol packages), one version, tag against version, both VSIX versions and the pre-release marker, the template SDK pins. Fails before the first push. |
| `publish-github-release` | Creates the release as a **draft** (`--prerelease` for a prerelease tag) and uploads every `.nupkg`, `.snupkg` and both `.vsix` with `--clobber`. |
| `publish-nuget-compiler` | Pushes the six `Gsharp.NET.Sdk.Compiler.<rid>` packages with `--skip-duplicate`, then waits up to 30 minutes for them on the flat container. |
| `publish-nuget-sdk` | Needs the previous job. Checks the six RID packages are on the feed, pushes `Gsharp.NET.Sdk` and the remaining packages, each `.nupkg` then its `.snupkg`, then checks the SDK is on the feed. |
| `publish-vscode-marketplace` | Needs `publish-nuget-sdk`. Skips when the version is already published; otherwise `vsce@3.9.2 publish --skip-duplicate`, then asks the marketplace again. |
| `publish-visual-studio-marketplace` | Needs `publish-nuget-sdk`. Skipped on any prerelease tag. Skips when the version is published; otherwise `VsixPublisher.exe publish`, then asks again. |
| `publish-finalize` | Runs after a failure too. When every destination has the version it writes the "Publication notes" section of the release body (unverified platforms; no Visual Studio publication for a prerelease) and un-drafts the release. Otherwise it fails and names what is missing. |

The NuGet packages, all built from projects with `IsPackable=true`:

| Package | Project | On nuget.org today |
|---|---|---|
| `Gsharp.NET.Sdk` (SDK, compiler, formatter, gsgen, Channels/Values/HotReload runtimes and built-in analyzers ride inside it) | `src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.csproj` | up to 0.4.591 |
| `Gsharp.Templates` (`dotnet new` templates) | `src/Sdk/Gsharp.Templates/Gsharp.Templates.csproj` | up to 0.4.591 |
| `Gsharp.Repl` (`gsi` tool) | `src/Repl/Repl.csproj` | up to 0.4.591 |
| `Gsharp.Gsfmt` (`gsfmt` tool) | `src/Formatting/Gsfmt.Cli/Gsfmt.Cli.csproj` | 0.4.591 only |
| `Gsharp.Cs2Gs` (`cs2gs` tool) | `tools/cs2gs/Cs2Gs.Cli/Cs2Gs.Cli.csproj` | up to 0.4.591 |
| `GSharp.CodeAnalysis.Analyzers.Testing` (analyzer test library) | `src/Analyzers/GSharp.CodeAnalysis.Analyzers.Testing/GSharp.CodeAnalysis.Analyzers.Testing.csproj` | **never published**; packable since #4281 (2026-09-16), after v0.4.591 |

No workflow publishes to Open VSX.

### Secrets and approvals the owner provides

| Secret | Used by | Notes |
|---|---|---|
| `GITHUB_TOKEN` | GitHub release create/upload (`build.yml:743`); `publish` has `permissions: contents: write` (`build.yml:719-720`) | Automatic. |
| `NUGET_API_KEY` | `dotnet nuget push` (`build.yml:755`) | The GitHub secret was last updated 2026-05-29; the key itself may be older. nuget.org keys expire after at most 365 days; check its expiry on nuget.org. Its scope must allow **pushing a new package id**, `GSharp.CodeAnalysis.Analyzers.Testing`, as well as new versions of the five existing ids. If it can't, that push is rejected and the step fails. Re-running is safe (`--skip-duplicate`). |
| `VSCE_PAT` | VS Code Marketplace (`build.yml:764`) **and** Visual Studio Marketplace (`build.yml:784`, passed as `VS_MARKETPLACE_PAT`) | The GitHub secret was last updated 2026-05-30; the PAT itself may be older. One Azure DevOps PAT with Marketplace (Manage) scope for the `gsharplang` publisher. Check its expiry in Azure DevOps. |

There is no environment approval to give. The owner's approvals are pushing
the tag, creating the C# branch and its ruleset, and merging the freeze and
post-publish PRs.

### Marketplace state: read before tagging

Both marketplace extensions are still at **0.4.1** (#4640). The VS Code
publish step failed on a transient marketplace error (a timeout or "Azure
DevOps Services Unavailable") in the v0.4.59, v0.4.273 and v0.4.591 runs.
`publish-visual-studio-extension` needs `publish`, so it was skipped each time,
and none of those runs was re-run. Watch step 3 of the final release. If it
fails, re-run the failed jobs (below) until both marketplaces have 0.4.NNNN.

## Procedure

### 0. Entry criteria

- Phase 1 exit holds (ASSESSMENT section 6): the self-migration nightly has
  been green for the agreed number of runs, the merge freeze is announced and
  in force, and every PR that must land in C# has landed.
- Owner decisions D1 (fresh tag) and D2 (branch policy) are recorded.

### 1. Freeze PR: release notes only

The website verifiers restore `release.json`'s version **from nuget.org** while
the PR is still open:

- `website/tests/verify-examples.py:40` runs `dotnet new install Gsharp.Templates::<version>`;
- `website/tests/verify-trail.py:32` builds the downloaded Trail project, pinned to `Gsharp.NET.Sdk/<version>`;
- `website/tests/verify-concurrency-patterns.py:75,111` builds against `Gsharp.NET.Sdk/<version>`.

`pages.yml:107-117` runs them on every PR that touches `website/**` or
`samples/**`. So `release.json`, the install page, the Trail and pattern
pins and the docs snapshot **cannot** move to 0.4.NNNN in the freeze commit:
the package doesn't exist yet. The assessment's Phase 2 step 2 bundles them
with the freeze commit; that order fails CI. They move in step 6, after
publishing.

The freeze PR changes only `website/docs/release-notes.md`:

1. Predict NNNN. Under the freeze the squash merge becomes the next commit on
   `main`, and NBGV height grows by one per commit on `main` (checked at
   6c4824cbc: `HEAD~2`/`HEAD~1`/`HEAD` gave 0.4.1127/0.4.1128/0.4.1129):

   ```sh
   git fetch origin
   nbgv get-version -v SimpleVersion origin/main   # prints 0.4.H; NNNN = H + 1
   ```

2. Rename `## Unreleased (0.5 line)` to `## 0.4.NNNN`. Its contents are what
   0.4.NNNN ships. Add a short lead paragraph saying this is the **last release
   whose compiler is built from C# source**, that the C# source stays on branch
   `cs2gs/csharp-0.4` (with the policy decided under D2), and that the next
   line, 0.5, is compiled from G# source. Add a new empty
   `## Unreleased (0.5 line)` above it. Re-read the whole section after
   rebasing (other PRs edit it until the freeze).
3. Leave "Reading these notes" (`The published **0.4.591** release ...`) for
   step 6. `build/check-release-version-refs.py` (from #4641) holds it to
   `release.json`.
4. Merge. Then read the `main` push run of the merge commit:
   - every job of `build.yml` is green;
   - the "Show Nerdbank.GitVersioning version" step summary (`build.yml:48-62`)
     shows `NuGetPackageVersion` = `0.4.NNNN` with no suffix.

   If the printed number differs from the heading, don't add a commit to fix
   it: that would move the height again. Tag the printed version and correct
   the heading in step 6. Website text is not part of any package.

### 2. Tag

On the freeze merge commit (the owner, with push rights):

```sh
git fetch origin
git rev-parse origin/main                       # must be the freeze merge commit
nbgv get-version -v SimpleVersion origin/main   # must print 0.4.NNNN
git tag -a v0.4.NNNN origin/main -m "G# 0.4.NNNN: final C#-built release"
git push origin v0.4.NNNN
```

The tag must be exactly `v` plus the printed version, digits and dots only
(`version.json:11`). Nothing checks this (#4639).

### 3. Watch the tag run

`build.yml` runs in full on the tag. `publish-verify` starts only after `ci`
passes. If a job fails, read its log first and prove the failure is unrelated
to the release (for example, the same failure on `main` or on an unrelated PR)
before running "Re-run failed jobs" (or `gh run rerun <run-id> --failed`).
Don't re-run a failure you haven't explained.

Every publish job is safe to re-run, and "Re-run failed jobs" also runs the
jobs that were skipped behind the failed one. Read the failure by job:

| Failed job | Meaning | Recovery |
|---|---|---|
| `publish-verify` | The artifacts or the tag are wrong by construction. Nothing was published. | Fix on `main` and push a new tag. |
| `publish-github-release` | A draft release with some assets. The NuGet chain and the extensions go on. | Re-run failed jobs: upload uses `--clobber`. |
| `publish-nuget-compiler` | Zero to six RID packages on nuget.org. The SDK, the extensions and finalize are skipped. | Re-run failed jobs: `--skip-duplicate` pushes only what is missing. |
| `publish-nuget-sdk` | RID packages, and part of the SDK and tools, are on nuget.org. The extensions are skipped. | Re-run failed jobs. |
| `publish-vscode-marketplace` | Everything else publishes. A timeout after the upload does not matter: the re-run finds the version and succeeds. | Re-run failed jobs. The Visual Studio job needs no re-run. |
| `publish-visual-studio-marketplace` | Everything else is published. | Re-run failed jobs. |
| `publish-finalize` | A destination is missing, or the network failed. The release stays a draft. The job summary lists each destination. | Fix or re-run the named job, then re-run failed jobs. |

A skipped `publish-visual-studio-marketplace` on a prerelease tag is not a
failure. Manual publication is the last resort when a run is older than 30 days or has
been re-run 50 times. For VS Code use `npx @vscode/vsce@3.9.2 publish --packagePath vscode-gsharp.vsix --skip-duplicate` with the artifact
of the tag run (`gh run download <run-id> -n vscode-gsharp-vsix`). 

  To publish the Visual Studio VSIX by hand, download the `visual-studio-gsharp-vsix`
  artifact of the tag run (`gh run download <run-id> -n visual-studio-gsharp-vsix`).
  Then, on Windows with the Visual Studio SDK, run the same command as
  the `publish-visual-studio-marketplace` job:

  ```powershell
  # Read the PAT without echoing it or leaving it in shell history.
  $pat = [System.Net.NetworkCredential]::new('', (Read-Host -AsSecureString 'Marketplace PAT')).Password
  & $publisher publish -payload GSharp.VisualStudio.vsix `
      -publishManifest src\vs-gsharp\vs-publish.json -personalAccessToken $pat
  Remove-Variable pat
  ```

  `$publisher` is `VSSDK\VisualStudioIntegration\Tools\Bin\VsixPublisher.exe`
  under the Visual Studio installation, located the same way as
  that job. Don't paste the PAT into a shared terminal, a log, or
  an issue.

  Alternatively, upload the VSIX in the Marketplace publisher portal for
  `gsharplang`. The failed job stays red in the run history; record the
  manual publish in the release notes PR.

### 4. Post-publish verification

```sh
V=0.4.NNNN
for id in gsharp.net.sdk gsharp.templates gsharp.repl gsharp.gsfmt gsharp.cs2gs \
          gsharp.codeanalysis.analyzers.testing; do
  curl -fsS "https://api.nuget.org/v3-flatcontainer/$id/index.json" \
    | python3 -c 'import json,sys; sys.exit(sys.argv[1] not in json.load(sys.stdin)["versions"])' "$V" \
    && echo "ok   $id $V" || echo "MISSING $id $V"
done
gh release view "v$V" --repo DavidObando/gsharp --json assets --jq '.assets[].name'
```

- **NuGet:** expect all six ids to print `ok`. Indexing can take several
  minutes after "Your package was pushed".
- **GitHub release:** expect 19 assets: 12 `.nupkg` (the six `Gsharp.NET.Sdk.Compiler.<rid>` packages included), 5 `.snupkg`,
  `vscode-gsharp.vsix` and `GSharp.VisualStudio.vsix`. `publish-finalize` has checked this and un-drafted the release.
- **From a clean machine with only nuget.org:**
  - `dotnet new install Gsharp.Templates::$V --debug:custom-hive <tmp>`;
  - build `samples/Trail` with its pin changed to `$V`;
  - `dotnet tool install Gsharp.Gsfmt --version $V --tool-path <tmp>`;
  - the same for `Gsharp.Cs2Gs` and `Gsharp.Repl` (`gsi`).
- **Marketplaces:** expect latest `0.4.NNNN` for `gsharplang.vscode-gsharp`
  and `0.4.NNNN.*` for `gsharplang.GSharp-VisualStudio`:

  ```sh
  for name in gsharplang.vscode-gsharp gsharplang.GSharp-VisualStudio; do
    curl -s -X POST https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery \
      -H 'Content-Type: application/json' -H 'Accept: application/json;api-version=7.2-preview.1' \
      -d "{\"filters\":[{\"criteria\":[{\"filterType\":7,\"value\":\"$name\"}]}],\"flags\":1}" \
      | python3 -c 'import json,sys; e=json.load(sys.stdin)["results"][0]["extensions"][0]; print(e["extensionName"], e["versions"][0]["version"])'
  done
  ```

- **GitHub release notes:** `--generate-notes` lists merged PR titles. Edit the
  release body to link the `0.4.NNNN` section of the release notes, say this is
  the final C#-built release, and name branch `cs2gs/csharp-0.4`.

### 5. The C# branch

The owner creates the branch at the tag:

```sh
git push origin 'v0.4.NNNN^{commit}:refs/heads/cs2gs/csharp-0.4'   # quoted: zsh expands ^ and {}
```

Protection: ruleset "Lock Main" (id 17277774) covers only `~DEFAULT_BRANCH`.
Nothing protects any other branch (`gh api repos/DavidObando/gsharp/rulesets`,
read 2026-10-02). Add a ruleset for the new branch: block deletion and
force-push, and require PRs. Leave out required status checks, because no
workflow runs there (see "Gaps" below).

```sh
gh api repos/DavidObando/gsharp/rulesets -X POST --input - <<'JSON'
{ "name": "Lock cs2gs/csharp-0.4", "target": "branch", "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/cs2gs/csharp-0.4"], "exclude": [] } },
  "rules": [ { "type": "deletion" }, { "type": "non_fast_forward" },
             { "type": "pull_request", "parameters": { "required_approving_review_count": 0,
               "dismiss_stale_reviews_on_push": false, "require_code_owner_review": false,
               "require_last_push_approval": false, "required_review_thread_resolution": false } } ],
  "bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" } ] }
JSON
```

The bypass entry copies "Lock Main"'s own: `RepositoryRole` 5 is GitHub's
built-in repository **Admin** role. To confirm it before posting, run
`gh api repos/DavidObando/gsharp/rulesets/17277774 --jq .bypass_actors`.
Drop `bypass_actors` if nobody should bypass. Rollback step 7 then needs the
ruleset disabled temporarily to move the branch.

Branch policy (**pending owner decision D2**; the assessment recommends):

- frozen except for security fixes, which ship as `v0.4.NNNN+k` tags on the
  branch;
- no feature back-ports;
- the branch doubles as a pinned C# corpus for cs2gs.

State the policy in the release notes and in the branch's README.

### 6. Post-publish docs PR

Once step 4 is green, one PR on `main` points the website at 0.4.NNNN. Follow
the patch-release steps in `docs/release/version-bump-checklist.md` (#4641):

- `release.json`, the install and Trail pages, the "Reading these notes"
  sentence and both sample pins;
- regenerate the downloads with `prepare-showcase.py` and delete the 0.4.591
  zips;
- regenerate `concurrency-checks.json` with `verify-concurrency-patterns.py --race`;
- recapture the Trail editor evidence;
- refresh the 0.4 docs snapshot from this branch **after** the version
  pointers in `website/docs` have moved. A snapshot copied from the tag would
  still say 0.4.591, which `content.test.mjs:20-25,190-195` and the version
  check reject. Under the freeze, `git diff v0.4.NNNN -- website/docs` should
  show only those pointer edits. `docs:version 0.4` refuses an existing
  version, so remove the snapshot and its `versions.json` entry first, as the
  checklist shows. Then restore the snapshot's hand-written release-notes
  preamble;
- fix the release-notes heading if step 1's prediction was wrong.
- copy the "Publication notes" section of the GitHub release body (an unverified platform, or the omission from the Visual Studio Marketplace) into the release notes, so the ADR-0207 rule that an unverified platform is named in the notes holds.

`build/check-release-version-refs.py` and `npm run test:content` must pass.
Merging deploys the site (`pages.yml:167-181`).

This PR adds a commit after the tag. That doesn't affect the cut-over: the
G# translation is made at the tag commit against the published nupkg, not at
`main`'s tip (ASSESSMENT section 6, Phase 3).

### 7. Rollback

- **Before anything consumes the release:**
  1. Fix forward on `main`.
  2. Let the next commit's printed version (0.4.NNNN+k) become the release,
     and tag `v0.4.NNNN+k`.
  3. Move `cs2gs/csharp-0.4` to the new tag (`git push --force` needs a
     ruleset bypass).
- **nuget.org versions are immutable:** a bad 0.4.NNNN can be unlisted
  (nuget.org package management, or `dotnet nuget delete`, which unlists),
  never replaced.
- **GitHub release:** mark it as a pre-release, or delete it. The tag can stay
  as a record.
- **Marketplaces:** publish the next version. The Visual Studio Marketplace can
  also unpublish a version from the publisher portal.

## Gaps: what the workflows can't do today that the plan needs

1. **No CI on the C# branch.** In `build.yml`, `pull_request.branches` and
   `push.branches` are `[main]` only (`build.yml:4-11`). PRs into
   `cs2gs/csharp-0.4` and pushes to it run nothing, and only a `v*` tag runs the
   full build plus publish. Before the first security fix, edit `build.yml`
   **on that branch** to add it to both triggers. For `push` and
   `pull_request` events, GitHub uses the workflow file from the branch's own
   commit.
2. **Version collision on `main`.** NBGV height on `main` keeps counting under
   `"version": "0.4"`, so `main`'s commits after the tag are also 0.4.NNNN+k.
   They would collide with security-fix versions from the branch.
   `version.json` on `main` must move to `"0.5"` in the version-bump PR that follows the cut-over, which
   resets the height. The version-bump checklist says the same.
3. **Tag name vs package version.** Nothing checks the tag name against the
   package version (#4639).
4. **Release notes.** The GitHub release body is `--generate-notes`; it does
   not use `website/docs/release-notes.md`. Editing it is manual.
5. **Marketplace coupling.** One VS Code Marketplace failure fails `publish` and
   skips the Visual Studio publish, and nothing retries (#4640).
6. **No Open VSX publishing.**
7. **No post-publish check.** No workflow checks nuget.org or the marketplaces
   after publishing; step 4 is manual.
8. **The website moves separately.** It can only follow a release in a
   separate PR after publishing (step 1); no workflow ties the two together.
