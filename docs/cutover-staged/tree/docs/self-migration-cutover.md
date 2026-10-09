# The C# to G# cut-over: record and mapping rules

Issue [#3501](https://github.com/DavidObando/gsharp/issues/3501). This is the
permanent record of how `main` became G# source. The bootstrap procedure is in
[`self-host-bootstrap.md`](self-host-bootstrap.md); the stage-2 certification
contract is [ADR-0198](adr/0198-isolated-stage-2-self-host-certification.md).

<!-- CUTOVER-VERIFY: fill in the facts below from the cut-over PR before merging:
     tag, final C# SHA, cs2gs version and exact command, hand-fix list outcome,
     gsfmt result. Delete this comment. -->

## Facts

| Item | Value |
|---|---|
| Final C#-built release | `v0.4.NNNN` |
| Final C# commit | `<sha>`, preserved on branch `cs2gs/csharp-0.4` |
| Translator | the published `cs2gs` `0.4.NNNN` tool |
| Translation command | `<exact command, including the explicit SDK pin and --config Release>` |
| Bootstrap pin | `Gsharp.NET.Sdk` `0.4.NNNN` under `msbuild-sdks` in `global.json` |

## Mapping rules

- For translated paths, files map 1:1: `X.cs` becomes `X.gs` and `X.csproj`
  becomes `X.gsproj`, except for the files cs2gs splits (list them here after the
  translation). `src/vs-gsharp` and the intentional C# fixtures and inputs keep
  their `.cs`/`.csproj` files.
- Static members are regrouped into a trailing `shared { }` block, so member
  order differs from the C# source. This is by design.
- License headers are preserved. `#region`, `#pragma` and in-body blank lines
  are not. `#if` was removed from the codebase before translation; cs2gs
  reports it as an error.
- C# `!` became `!!`, a runtime check. Trimming redundant ones is ongoing.
- The Visual Studio extension (`src/vs-gsharp`) was not translated.
- `GSharp.sln` was replaced by the generated `GSharp.slnx`.

## Hand fixes applied after translation

Re-enable `GeneratePackageOnBuild`; rewrite the SDK project's `Pack*` literal
project paths to `.gsproj`; rebind `src/Sdk/Gsharp.Extensions` to the pinned SDK;
fix the VS project's LanguageServer reference; add `.gitattributes`; replace
per-file SDK pins with `global.json` `msbuild-sdks`; strip C#-only properties
from generated projects. Record any deviation here.

## History

The cut-over is one squash commit that deletes `.cs` and adds `.gs`; Git rename
detection does not pair them, so `git blame` for compiler source restarts at
that commit. Use branch `cs2gs/csharp-0.4` for the C# history.
