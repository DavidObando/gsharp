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

## Local commands

Commands run from the dedicated implementation worktree. The evidence directory
is its sibling, not a descendant: the migration correctly rejects overlapping
source/destination trees. All output and scratch paths remain inside the parent
project directory.

```bash
evidence="$(cd ../issue-4198-evidence && pwd)"
export TMPDIR="$evidence/runtime"
export TMP="$TMPDIR" TEMP="$TMPDIR"
export SELFMIG_GATE_ROOT="$evidence/selfmig"

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
mapfile -t apps < <(jq -r '.apps[].appId' "$run_dir/run.json")
bash build/run-cs2gs-selfmig-validate.sh full "${apps[@]}"
bash build/run-cs2gs-selfmig-gate.sh \
  "$SELFMIG_GATE_ROOT" "$SELFMIG_GATE_ROOT"

bash build/test-cs2gs-counters.sh
python3 build/test-check-selfmig-stage-floor.py
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
