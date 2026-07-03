# cs2gs C# corpus

This directory holds the curated **C# corpus** that the `cs2gs` migration tool
(ADR-0115) translates to G# and verifies against. It is **ordinary, idiomatic
C#** — the *input* to the migration — not product code. Step 3 of issue #914
seeds this corpus and captures its C# baselines; no G# and no tool code live
here.

## What the corpus is for

The pipeline (a later step) translates each app C#→G#, compiles the G# with
`gsc`, IL-verifies it, and runs the ported tests. "Migration completed" means
the ported program reproduces the **C# baseline** captured here (ADR-0115
sections C and E). The corpus is deliberately ordered by increasing complexity
so the simplest possible gap is isolated first.

## Levels

| Level | Project(s) | Kind | Exercises (ADR-0115 §B) |
| --- | --- | --- | --- |
| **L1** | `L1-Console` | console exe, no tests | namespace + `System` (B.1); brace/indent style (B.2); `var`/`const`, reassigned vs never-reassigned locals (B.3); reference `class` (B.4); in-body instance methods (B.5); fields + constructor (B.6, B.11); `if`/`for`/`foreach`/`while`; integer + string arithmetic; string interpolation incl. format text and a literal `$` (B.9) |
| **L2** | `L2-Library` + `L2-Library.Tests` | classlib + xUnit | `class`/`struct`/`record`/`record struct` (B.4); interface impl + base-clause ordering, get-only/`init` props (B.6, B.11); `public`/`internal` visibility (B.10); `enum`, auto-properties, static members, method overloads (B.11) |
| **L3** | `L3-Library` + `L3-Library.Tests` | richer classlib + xUnit | generics + constraints `where T : …` (B.7); generic method with inference; indexer (B.11); nullable reference types; extension methods `this T` → receiver clause (B.5); `Func<>`/`Action<>`/lambdas → arrow form (B.8); `switch` expression + type/property/relational patterns; LINQ method **and** query syntax; `async`/`await` over `Task<T>` |
| **L4** | `L4-Console` | console exe, no tests | exception handling: `try`/typed `catch`/`finally`, custom `Exception` subtype + `: base(message)` chaining, re-throw (B.27, B.28); `Dictionary<K,V>` + `HashSet<T>` (add/`TryGetValue`/`Contains`/`Count`, sorted iteration); `using` statement **and** `using var` over an `IDisposable` (B.29); nullable value types `int?` (`.HasValue`/`.Value`, `??`); operator overloading `+`/`*`/`==`/`!=` on a `struct` → receiver-clause `operator` funcs (B.31); conditional/ternary → if-expression (B.26); pre-declared `out` argument → `&x` (B.30) |
| **L5** | `L5-Console` | console exe, no tests | inheritance & polymorphism: open base class, `virtual`/`override` method, `protected` field, dynamic dispatch through a base-typed variable (B.4, B.5); `is` type pattern (no binder) + `switch` **statement** over type patterns → `switch subj { case P { … } }` (B.32); `switch` **expression** with relational patterns (`< 10.0`) → colon-arm form; iterator `yield return` returning `IEnumerable<T>` → `sequence[T]` (B.32); generic constraints `where T : class` / `where T : IComparable<T>` → bracket constraint clause (B.7); integer literal implicitly promoted to a `double` parameter → emitted as a float literal (B.12). Surfaces the next compiler-gap batch (ADR-0115 §G): `base.M()` virtual call, `abstract` method, `new T()` under `new()`, generic auto-property over `T`, user-class `sequence[T]` iterator, `when` guards, `and`/`or` patterns, `is`-binder, `yield break` |

Each level builds **and** tests green in C# **first** — that captured C# state
is the parity oracle.

## The conformance grid (ADR-0138)

`grid/G01…G14` are the per-construct differential fixtures that complement the
app-level L-corpus: console apps with one C# construct per
`Constructs/<SyntaxKind>.cs` (header `// inventory: <SyntaxKind>`), a
deterministic stdout, and a `baseline.stdout.golden` byte-compared against the
translated G# program in stage 4. Their rows in
`tools/cs2gs/coverage/csharp-construct-inventory.json` point back at the
fixture files. Grid apps must stay fully green: a construct that fails any
pipeline stage is quarantined out of the app and ledgered in
`../triage/gaps.json`. A PR that adds a gap-surfacing fixture must ledger the
fingerprint in the same PR — otherwise the CI gate correctly fails on the NEW
fingerprint (that failure-then-ledger flow is the intended loop).

## Isolation from the repo build

The corpus is fully isolated from the repository's shared MSBuild props and
analyzers:

- `Directory.Build.props` / `Directory.Build.targets` here **do not import** the
  repo-root equivalents. MSBuild stops at the first `Directory.Build.*` it finds
  when walking up the tree, so the corpus never inherits StyleCop,
  `TreatWarningsAsErrors=true`, or the `AssemblyName => GSharp.<Project>`
  rewrite. The corpus is plain `Microsoft.NET.Sdk`, `net10.0`, `Nullable=enable`.
- No corpus project is added to `GSharp.sln`, so the solution build and CI
  (which target `GSharp.sln` explicitly) never pick these projects up.

This is why the C# here can use ordinary style (underscore-prefixed private
fields, no StyleCop file headers, implicit `this`) and still build clean.

## Baselines (the parity oracle)

`capture-baselines.sh` (with helper `trx-to-baseline.py`) regenerates the
committed baseline artifacts:

| Artifact | Produced from | Role |
| --- | --- | --- |
| `L1-Console/baseline.stdout.golden` | running the console exe | golden stdout the G# port must reproduce byte-for-byte |
| `L4-Console/baseline.stdout.golden` | running the console exe | golden stdout the G# port must reproduce byte-for-byte |
| `L5-Console/baseline.stdout.golden` | running the console exe | golden stdout the G# port must reproduce byte-for-byte |
| `L2-Library.Tests/baseline.tests.json` | `dotnet test --logger trx` | sorted `{name → outcome}` + pass/fail/skip counts the G# port must reproduce |
| `L3-Library.Tests/baseline.tests.json` | `dotnet test --logger trx` | same, for L3 |

The JSON artifacts strip durations, timestamps, run ids, and machine paths so
they diff cleanly and stay stable across machines.

### Regenerating

```bash
./capture-baselines.sh
```

Run this **only** when the C# corpus itself changes — never as a side effect of
a G# run — so pipeline retries always compare against a fixed target
(ADR-0115 §E).

### How the pipeline consumes the baselines (later step)

- **Stage 4 / test-parity (L2, L3):** after building and running the ported G#
  xUnit tests, the pipeline compares the produced `{name → outcome}` set against
  `baseline.tests.json`. Parity = the same tests pass. Any divergence becomes a
  `test-parity-failure` triage artifact (ADR-0115 §C/§D).
- **Stage 4 / stdout (L1):** the ported G# console output is diffed against
  `baseline.stdout.golden` (the repo's `.golden` convention). A mismatch is a
  `test-parity-failure`.

## Manual commands

```bash
# build + run L1 and see its (deterministic) stdout
dotnet run --project L1-Console/L1-Console.csproj -c Release

# build + run L4 / L5 console exes
dotnet run --project L4-Console/L4-Console.csproj -c Release
dotnet run --project L5-Console/L5-Console.csproj -c Release

# test L2 / L3
dotnet test L2-Library.Tests/L2-Library.Tests.csproj -c Release
dotnet test L3-Library.Tests/L3-Library.Tests.csproj -c Release
```
