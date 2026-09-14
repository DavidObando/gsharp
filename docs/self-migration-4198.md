# #4198: post-#4197 residual measurement

## Decision

The migration-specific feature request in [#4198](https://github.com/DavidObando/gsharp/issues/4198)
is unnecessary. The complete repository still has **three counted `__local_`
occurrences**, but **none comes from a generic or ref-returning mutually recursive
local function**. Three is not zero, and this is not a claim of complete C# language
parity.

Do not implement generic groups or ref-returning function literals to remove this
residual. The independently motivated capability work remains
[#4219](https://github.com/DavidObando/gsharp/issues/4219); the remaining ordinary
helper is outside #4198's conditional scope.

The repository owner merged [#4232](https://github.com/DavidObando/gsharp/pull/4232)
as `13c96e6e1f18f64886ba291b0b07757f022f2ecb` and closed #4198 on September 14,
while the longer full validation was still running. This documentation follow-up
records its completed result. The measured source remains the explicit
`b9cd4a4fe1` base below: the concurrently merged ADR-0180 changes in #4218 were
**not** part of these runs. No later-main or fully-green-corpus claim is made.

## Reproducible measurement

Measured September 14, 2026, from a dedicated worktree at
`b9cd4a4fe17889b4768ee39b6893335b83ea5971` (then-current `origin/main`), with
.NET SDK `10.0.400` and gsc `0.4.686+b9cd4a4fe1`.
Both [#4200](https://github.com/DavidObando/gsharp/pull/4200), which closed #4197,
and its [#4211](https://github.com/DavidObando/gsharp/pull/4211) follow-up are
ancestors of this commit. The complete #4198/#4197 issue bodies and all comments
(both comment lists were empty) were read before the measurement or any changes.

Run `2026-09-14T19-58-29Z_a6ced4` translated **56/56 projects**, using the unchanged
`selfmig_excludes` list, in one process so linked-source consistency checks remain
active. The resulting source tree contains **3,911 `.gs` files** after the
counter's existing generated-directory pruning.

The independent local repeat, `2026-09-14T20-37-39Z_f92f65`, also translated
**56/56** with the same metrics. `selfmig_hash_tree` compared both complete
pre-validation trees: **zero differing `.gs` files**. This pristine repeat is the
input to four isolated validation shards; their partition includes all 56
projects exactly once.

| Measurement | Value |
| --- | ---: |
| Code `__local_` occurrences | 3 |
| Distinct identifiers among those code occurrences | 1 |
| Raw `__local_` occurrences, including comments and quoted fixtures | 68 |
| Synthetic labels | 0 |
| Formatter-reducible lines over 300 characters | 1 |
| Pre-validation `!!` occurrences | 22,188 |

Pre-validation `!!` counts are **not** gate-parity counts: validation's existing
polish pass removes redundant assertions. No conclusion about the assertion
ceiling follows from that intermediate count.

Independent complete nightlies corroborate the three-use result:

| Run | Commit | Gate `__local_` count |
| --- | --- | ---: |
| [September 13](https://github.com/DavidObando/gsharp/actions/runs/34759865620) | `f24064f6750371c1a2aa8cba710f5b83b1dba4c1` | 3 |
| [September 14](https://github.com/DavidObando/gsharp/actions/runs/34849787331) | `5748a89616f5fef7a08752513dfaa86e4e91cdc2` | 3 |

The September 14 nightly was **red**, despite the unchanged lift count:
`test/Core.Tests/Core.Tests.csproj` reached ILVerify rather than its banked
test-parity floor. That independent failure is not evidence for implementing
#4198 and must not be absorbed by lowering the floor.

## Complete counted residual and caller trace

Every counted occurrence is in `src/Core/CodeAnalysis/Binding/Binder.gs`:

| Pre-validation line | Role |
| --- | --- |
| 3611 | Call from `AddNestedBaseDependencies`, all three original arguments supplied |
| 3633 | Call from `AddBaseFirst`, third original argument defaulted |
| 8816 | Declaration of `__local_BindGlobalScope_FindTopLevelBaseIndex` |

Line 3598 is the corresponding lift comment: the fourth raw occurrence in this
file, deliberately not counted as code. The other 64 raw occurrences are comments
or quoted names/fixtures in translator code and translator tests, not additional
emitted executable helpers.

The C# declaration at `src/Core/CodeAnalysis/Binding/Binder.cs:1194` returns `int`
by value, has no type parameters, and declares
`HashSet<string>? visibleNestedTypeNames = null`. It calls neither itself nor the
other local functions. Its two callers participate in the
`AddBaseFirst`/`AddNestedBaseDependencies` cycle; the helper is merely reachable
from that cycle.

The traced lowering is:

1. `TranslateBlock` registers nullable recursive groups before recursive lifts.
2. `RegisterCapturingRecursiveLocalFunctions` claims the ordinary cycle.
   Its fold pass deliberately rejects a non-recursive candidate with an explicit
   default parameter (`CSharpToGSharpTranslator.Constructors.cs:2724–2742`).
3. `RegisterRecursiveLocalFunctionLifts` follows dependencies but skips already
   claimed group members, leaving this helper on the existing method-lift path.
4. `TranslateLocalFunction` emits the real helper method, including captures.
   `TranslateInvocation` supplies the omitted default before capture arguments.

This is the deliberate behavior established by #4200/#4211, not an uncovered
generic/ref-returning cycle. The existing
`DefaultParameterNonRecursiveDependency_StaysLiftedNotFolded` regression and its
neighboring generic/ref-returning carve-out tests remain unchanged. In particular,
the generic fixture's explicit round-trip-only limitation is **not** being
promoted into an end-to-end parity claim.

## Ratchet and regression coverage

`liftedLocalCeiling` tightens **31 → 3**, backed by the fresh complete measurement
and two independent post-fix nightlies. All other ceilings, `greenFloor`,
`greenApps`, `stageFloor`, exclusions, and parity allowlists remain unchanged.

The added case in `build/test-cs2gs-counters.sh` exercises the real shared counter
and gate: one declaration plus two calls passes ceiling 3; a fourth code
occurrence fails with `GATE: __local_ count 4 exceeded ceiling 3.` The lift comment
does not inflate the code count. No compiler, translator, parser, or emitter
behavior changes.

## Completed local regression results

- Release CLI and `Cs2Gs.Tests` project builds: **0 warnings, 0 errors**.
- Complete native `Cs2Gs.Tests` suite: **3,067 passed, 0 failed, 0 skipped**,
  duration **30 minutes 26 seconds**. TRX counters also report zero errors,
  timeouts, aborted, inconclusive, or not-executed cases.
- Exact migrated `Cs2Gs.Tests`: **3,067 passed, 0 failed, 0 skipped**, duration
  **39 minutes 37 seconds**, after passing compile and ILVerify. Its existing
  72-minute parity budget and 2,680-original-`[Fact]` lower bound were unchanged.
- All **14** existing `Issue4197CapturingRecursiveLocalFunctionWideningTests`
  cases passed, including the ordinary default-parameter residual, non-capturing
  and capturing cycles, ref-returning lift, and explicit generic negative guard.
- Shared counter contract suite, including the new ceiling boundary: **passed**.
- Stage-floor regression suite: **13 passed**.
- `bash -n build/test-cs2gs-counters.sh` and `git diff --check`: **passed**.
- JSON comparison against the measured base: the only changed baseline value is
  `liftedLocalCeiling`, **31 → 3**.

## Complete full-corpus gate result

All four canonical validation shards completed. Their manifests were checked
against the complete translation manifest: **56 apps, each exactly once**.
For this evidenced run, all 12 shard artifacts were required and each copied
file's SHA-256 was compared with its source. This provenance check does not
change the canonical gate's policy for other runs.
The existing merge/gate script replayed every shard's polish delta and produced
`run.merged.json` for `2026-09-14T20-37-39Z_f92f65`.

| Stage | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Translate | 56 | 0 | 0 |
| Compile | 55 | 1 | 0 |
| ILVerify | 54 | 1 | 1 |
| Test-parity | 52 | 2 | 2 |

These are the pipeline's stage verdicts, not a claim that every library has a
runtime oracle. Its existing no-oracle library handling is unchanged; the native
and migrated test-suite counts above are actual executed cases.

| Final metric | Measured | Unchanged limit, except the banked lift ceiling |
| --- | ---: | ---: |
| Fully green apps | 52/56 | floor 54 |
| Synthetic labels | 0 | ceiling 0 |
| Code `__local_` occurrences | 3 | ceiling 3, previously 31 |
| Reducible lines over 300 characters | 1 | ceiling 10 |
| Single-atom-bounded long lines | 40 | report only |
| Post-polish `!!` occurrences | 9,915 | ceiling 12,100 |

**The full gate exits 1.** Every readability ceiling passes, including the
tightened lift ceiling. The unchanged functional gates correctly reject:

- **Green count:** 52 is below 54.
- **Banked identities:** `Compiler.Tests`, `Extensions.Tests`, and
  `Runtime.Channels.Tests` are no longer fully green in this measured run.
- **Stage floor:** `Core.Tests` reaches ILVerify, below its test-parity floor.

| Red app | Actual failure | Separate tracker |
| --- | --- | --- |
| `test/Core.Tests/Core.Tests.csproj` | ILVerify `MethodAccess` | #4233 |
| `test/Extensions.Tests/Extensions.Tests.csproj` | Parity test-host abort, missing `ChannelExtensions` | #4234 |
| `test/Runtime.Channels.Tests/Runtime.Channels.Tests.csproj` | Compile `GS0113`, missing `ChannelExtensions` | #4234 |
| `test/Compiler.Tests/Compiler.Tests.csproj` | One runtime parity failure in `ReceiveValueAsync<T>` | #4236 |

No failure is a generic/ref-returning local-function residual. No floor is
lowered, green identity removed, test filtered out of the full run, or exception
allowlisted. The newly green `Cs2Gs.Tests` app does not conceal the other apps'
regressions. The initial implementation commit's PR CI completed with 38 passing
checks and three policy skips, including the 8/8 hot-core guard; that narrower
green result is **not** substituted for this red whole-corpus gate.

## Independently reproduced blockers

[#4233](https://github.com/DavidObando/gsharp/issues/4233) separately tracks the
exact `Core.Tests` ILVerify regression discovered during this validation:

```text
MethodAccess: Issue4216ReceiverAttributeEmitTests::NotNullWhen_OnExtensionReceiver_RoundTripsThroughReflection()
[offset 0x00000049] Method is not visible.
```

Fingerprint:
`sha256:76e60a0828996d39bf043173515d59ced7cf2bf488de715ab06f88f3415c5909`.
The local artifact (`2026-09-14T21-02-22Z_783bd4`, gsc
`0.4.686+b9cd4a4fe1`) and the September 14 main nightly's artifact
(`2026-09-14T14-13-16Z_e7652d`, gsc `0.4.680+5748a89616`) have the same fingerprint,
method, offset, and diagnostic. The exact C# control passes **1/1**, with zero
skips; its Debug build has zero warnings/errors.

This is not a generic/ref-returning local-function residual. `Core.Tests`
compiles but cannot reach parity until the inaccessible emitted call is fixed.
Its existing test-parity stage floor remains intact. The older parity failures
under [#4214](https://github.com/DavidObando/gsharp/issues/4214) are masked, not
fixed, by this earlier-stage failure. No fixture rewrite, exclusion, exemption,
or unrelated compiler fix is included here.

[#4234](https://github.com/DavidObando/gsharp/issues/4234) tracks a separate
`Extensions.Tests` runtime failure. Translate, compile, and ILVerify pass, but a
free goroutine terminates the test host with `TypeLoadException` for
`Gsharp.Concurrency.ChannelExtensions` from `Gsharp.Runtime.Channels`. The build
log reports conflicting runtime assembly versions, and the already-G# Extensions
assembly expects a C# extension-owner type absent from the translated runtime.
The precise reference/metadata correction remains outside #4198's scope.

The native Extensions suite passes **180/180**, zero skips. A rerun from an
isolated copy of the migrated test output reproduces the crash. Its partial
`Passed!` summaries (53 cases in the pipeline, 63 in the copied-output rerun) are
**not passing suites**: both runs abort. The existing parity/coverage guard
correctly rejects them, and the banked green app remains banked.

The same missing owner also breaks the banked `Runtime.Channels.Tests` app at
compile: `ChannelOpsTests.gs:157` reports
`GS0113: Type 'ChannelExtensions' doesn't exist` for the translated
`typeof(ChannelExtensions).GetMethods()` reflection assertion. Its native suite
passes **208/208**, zero skips. This sibling is tracked under #4234 as well;
neither assertion nor app identity is removed.

[#4236](https://github.com/DavidObando/gsharp/issues/4236) separately tracks the
one failure in the complete migrated `Compiler.Tests` run: **5,855 passed,
1 failed, 0 skipped, 5,856 total**, completed in 3,759 seconds within its existing
90-minute budget. `ChannelElementMatrix_LoadsVerifiesAndRuns` executes a program
that throws `InvalidProgramException` in
`ChannelOps.ReceiveValueAsync<T>`, propagated through a `ScopeException`.
Project compile and ILVerify both pass; runtime execution still fails.

The exact native C# control passes **1/1**. A one-test rerun against the original
migrated output reproduces the same failure, **0 passed / 1 failed**. Its
fingerprint is
`sha256:3dc53ea4f337f3a5ff3d6b1ef62863d4ed15c75246d6fefdbf1ce2eda3d1f142`.
This async runtime failure is not assumed to share #4234's missing-owner cause
and is not a generic mutual-recursion group.

## Local commands

Commands run from the dedicated implementation worktree. The evidence directory
is its sibling, not a descendant: the migration correctly rejects overlapping
source/destination trees. All output and scratch paths remain inside the parent
project directory.

```bash
mkdir -p ../issue-4198-evidence/runtime artifacts/issue-4198
evidence="$(cd ../issue-4198-evidence && pwd)"
git init --quiet "$evidence/runtime"
printf '<Project />\n' > "$evidence/runtime/Directory.Build.props"
printf '<Project />\n' > "$evidence/runtime/Directory.Build.targets"
export TMPDIR="$evidence/runtime"
export TMP="$TMPDIR" TEMP="$TMPDIR"
export SELFMIG_GATE_ROOT="$evidence/selfmig-final"

dotnet restore GSharp.sln --locked-mode -v:minimal
dotnet build tools/cs2gs/Cs2Gs.Cli/Cs2Gs.Cli.csproj \
  -c Release --no-restore -graph -v:minimal
bash build/run-cs2gs-selfmig-migrate.sh

dotnet build tools/cs2gs/Cs2Gs.Tests/Cs2Gs.Tests.csproj \
  -c Release --no-restore -graph -v:minimal
dotnet test tools/cs2gs/Cs2Gs.Tests/Cs2Gs.Tests.csproj \
  -c Release --no-build --no-restore \
  --logger 'trx;LogFileName=cs2gs-full-clean.trx' \
  --results-directory artifacts/issue-4198/test-results

run_dir=$(cat "$SELFMIG_GATE_ROOT/migrate-run-dir.txt")
gh run download 34759865620 --repo DavidObando/gsharp \
  --name cs2gs-selfmig-run --dir artifacts/issue-4198/nightly-34759865620
python3 build/generate-selfmig-shard-matrix.py \
  --run-dir "$run_dir" \
  --costs artifacts/issue-4198/nightly-34759865620/selfmig-shard-costs.json \
  --shards 4 > artifacts/issue-4198/validation-matrix.json

# This listing runs the same invocations serially. Locally their validation
# stages ran concurrently on separate copies, with prerequisite builds serialized.
for shard in 1 2 3 4; do
  mkdir -p "$evidence/validation-$shard"
  cp -a "$SELFMIG_GATE_ROOT/migrated" "$evidence/validation-$shard/migrated"
  cp "$SELFMIG_GATE_ROOT/migrate-run-dir.txt" "$evidence/validation-$shard/"
  mapfile -t apps < <(jq -r --arg name "$shard" \
    '.include[] | select(.name == $name) | .apps | split(" ")[]' \
    artifacts/issue-4198/validation-matrix.json)
  SELFMIG_GATE_ROOT="$evidence/validation-$shard" \
    bash build/run-cs2gs-selfmig-validate.sh "$shard" "${apps[@]}"
done

python3 - "$evidence" <<'PY'
import hashlib
import shutil
import sys
from pathlib import Path

root = Path(sys.argv[1])
for shard in ("1", "2", "3", "4"):
    source = root / f"validation-{shard}" / f"shard-{shard}"
    target = root / "final-shards" / shard
    target.mkdir(parents=True, exist_ok=True)
    for artifact in ("shard-run.json", "shard-costs.json", "polished.tar.gz"):
        src, dst = source / artifact, target / artifact
        if not src.is_file():
            raise SystemExit(f"Missing required artifact: {src}")
        shutil.copy2(src, dst)
        expected = hashlib.sha256(src.read_bytes()).hexdigest()
        actual = hashlib.sha256(dst.read_bytes()).hexdigest()
        if actual != expected:
            raise SystemExit(f"SHA-256 mismatch: {src} -> {dst}")
        print(f"{shard}/{artifact}: {actual}")
PY
bash build/run-cs2gs-selfmig-gate.sh \
  "$SELFMIG_GATE_ROOT" "$evidence/final-shards"

bash build/test-cs2gs-counters.sh
python3 build/test-check-selfmig-stage-floor.py
dotnet build test/Core.Tests/Core.Tests.csproj \
  -c Debug --no-restore -graph -v:minimal
dotnet test test/Core.Tests/Core.Tests.csproj -c Debug --no-build --no-restore \
  --filter FullyQualifiedName~Issue4216ReceiverAttributeEmitTests.NotNullWhen_OnExtensionReceiver_RoundTripsThroughReflection
dotnet build test/Extensions.Tests/Extensions.Tests.csproj \
  -c Debug --no-restore -graph -v:minimal
dotnet test test/Extensions.Tests/Extensions.Tests.csproj \
  -c Debug --no-build --no-restore
dotnet build test/Runtime.Channels.Tests/Runtime.Channels.Tests.csproj \
  -c Debug --no-restore -graph -v:minimal
dotnet test test/Runtime.Channels.Tests/Runtime.Channels.Tests.csproj \
  -c Debug --no-build --no-restore
dotnet build test/Compiler.Tests/Compiler.Tests.csproj \
  -c Debug --no-restore -graph -v:minimal
dotnet test test/Compiler.Tests/Compiler.Tests.csproj -c Debug --no-build --no-restore \
  --filter FullyQualifiedName~Issue2965ChannelElementSlotTests.ChannelElementMatrix_LoadsVerifiesAndRuns
git diff --check
```

The project-local runtime scratch directory is initialized as an empty Git
repository and contains neutral `<Project />` `Directory.Build.props` and
`Directory.Build.targets`. This prevents standalone test fixtures from inheriting
the enclosing repository's ignores or build settings. An initial suite attempt
under the worktree's ignored `artifacts/` directory exposed that environmental
problem; the mirror-ordering reproducer passed after isolation, without modifying
tests or gates. The initial CLI build also required the solution's locked restore
to supply the SDK packaging target's compiler assets.

The original serial validation attempt was stopped when the prior run's measured
app costs showed a roughly six-hour serial workload. It is not counted as a
completed validation. A fresh, byte-identical whole-corpus translation was taken
before copying the shard inputs; no partially polished or interrupted build tree
was reused.
