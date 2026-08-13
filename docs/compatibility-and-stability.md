# Compatibility and stability policy

G# is currently pre-1.0 (`0.4` version base). This policy makes change risk
explicit without claiming compatibility the project cannot yet guarantee.

## Support window

- `main` and the latest tagged release receive fixes.
- Older pre-1.0 releases are not maintained.
- Published release notes describe migration steps and known compatibility
  breaks for each release line.

## Compatibility promises

| Surface | Pre-1.0 promise |
|---|---|
| G# source | Minor release lines may change syntax or semantics. Breaking changes require an issue or ADR, release-note migration guidance, and a deprecation warning for one release when practical. Correctness and security fixes may break incorrect or unsafe behavior immediately. |
| Emitted assemblies | G# emits normal CLR metadata and IL. Binary compatibility with public APIs follows CLR rules, but compiler-generated implementation details are not stable. Recompile after a compiler upgrade when diagnosing a binary incompatibility. |
| Diagnostics | `GS` diagnostic IDs are never reused for unrelated meanings. Severity, wording, and source span may improve. Automation should key on IDs, not English text. Retired IDs remain reserved. |
| CLI and MSBuild | Documented switches and properties are compatibility surfaces. Removal or semantic change follows the same deprecation and release-note process as source syntax when practical. |
| NuGet packages and tools | Packages use repository versions derived by Nerdbank.GitVersioning. Public managed APIs may still change before 1.0; pin an exact version for production adoption. |
| Drivers | Emitted executable, bare `gsc`, and `gsi` script mode must agree on exit code, stdout, diagnostics, and stderr for the same complete program. The emitted executable is the differential oracle. |
| `cs2gs` output | Translation is migration assistance, not a source-stability promise. Its corpus gates require translated programs to compile, IL-verify, and match C# behavior where the ledger marks support. |

## Platform baseline

- The MSBuild SDK is validated for `net8.0` and `net10.0` projects.
- Command-line tools currently require a .NET 10 runtime.
- Linux CI is required on every PR; Windows has a nightly gate.
- Editor compatibility is documented separately for
  [Visual Studio](vs-gsharp-compatibility.md) and the VS Code extension.

## Change process

1. Define user-visible semantics in an issue and, for cross-cutting decisions,
   an ADR.
2. Add a discriminating regression or conformance test under ADR-0154.
3. Update specification, diagnostics, feature matrix, and release notes in the
   same PR.
4. Use a warning and documented replacement before removal when a safe
   transition exists.
5. Reserve immediate breaks for security, data loss, invalid IL, silent wrong
   answers, or behavior that never matched the documented contract.

This policy itself changes only through a reviewed PR that explains the
adoption impact.
