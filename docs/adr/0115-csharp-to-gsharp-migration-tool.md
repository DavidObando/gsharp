# ADR-0115: `cs2gs` — a C#→G# migration tool and gap-discovery pipeline

- **Status**: Accepted
- **Date**: 2026-06-21
- **Phase**: Tooling — issue #914
- **Related**: issue [#914](https://github.com/DavidObando/gsharp/issues/914) (C#→G# migration tool), [ADR-0027](0027-roslyn-fork-decision.md) (Roslyn-fork decision); canonical-output rules cite ADR-0008, ADR-0014, ADR-0017, ADR-0019, ADR-0020, ADR-0024, ADR-0025, ADR-0029, ADR-0047, ADR-0049, ADR-0051, ADR-0053, ADR-0055, ADR-0065, ADR-0067, ADR-0075, ADR-0078, ADR-0079, ADR-0097, ADR-0098, ADR-0109; `website/docs/ref/spec.md`.

## Context

G#'s surface syntax has matured (Phases 1–7; ADR-0001 through ADR-0114) to the point where idiomatic C# maps onto canonical G# in a largely mechanical way: C# `class`/`struct`/`record`/`record struct` correspond to G# `class`/`struct`/`data class`/`data struct`; C# generics map to bracketed G# generics (ADR-0020); C# delegates map to arrow function types (ADR-0075); C# attributes map to `@`-annotations (ADR-0047). Issue #914 asks for a tool that exploits this to do two things at once:

1. **Transform existing C# applications into G# projects** — producing *canonical* G#, not a literal transliteration.
2. **Discover gaps in the G# compiler** — by feeding the generated G# through a real build/verify/test pipeline and turning every failure into a filed issue, then re-running against an updated compiler until parity with the original C# is reached.

The hard requirement is that the process be **accurate and repeatable**: the same corpus run twice against the same `gsc` must produce the same G#, the same diagnostics, and the same triage artifacts. "Migration completed" has a precise meaning — the ported program compiles cleanly, its IL verifies, and its ported tests reproduce the C# baseline.

Two constraints bound the solution space. First, ADR-0027 removed Roslyn from the *compiler*: `gsc` has no `Microsoft.CodeAnalysis` dependency and emits ECMA-335 directly via `ReflectionMetadataEmitter`. Any use of Roslyn in this tool must not reintroduce that dependency into the compiler. Second, issue #914 mentions "pass the output to an LLM so it can file issues" — but a batch pipeline that embeds an LLM API client (and therefore API keys, network egress, and non-determinism) would violate the repeatability requirement and the repo's secret-handling rules. The triage hand-off must be designed around that.

The scaffolded solution under `tools/cs2gs/` already fixes the project decomposition this ADR fills in:

| Project | Responsibility |
| --- | --- |
| `Cs2Gs.CodeModel` | The purpose-built **G# emit AST** and the canonical pretty-printer. |
| `Cs2Gs.Translator` | Roslyn front-end: `CSharpCompilation` + `SemanticModel` → `Cs2Gs.CodeModel`. References `Microsoft.CodeAnalysis.CSharp`. |
| `Cs2Gs.Pipeline` | The ordered Translate → Compile → IL-verify → Test-parity stage machine and triage emission. |
| `Cs2Gs.Report` | HTML + JSON report aggregation. |
| `Cs2Gs.Cli` | The `cs2gs` entry point wiring Pipeline + Report together. |
| `Cs2Gs.Tests` | xUnit tests for the above. |

## Decision

Build `cs2gs` as a **Roslyn-based, offline, deterministic** translator feeding a **four-stage gap-discovery pipeline**, with structured triage artifacts consumed by an *external* issue-filing agent. The tool lives entirely under `tools/cs2gs/` and is never referenced by `gsc` or any compiler/runtime assembly.

### A. Translation approach: Roslyn front-end → dedicated emit AST → canonical pretty-printer

`Cs2Gs.Translator` parses each input with Roslyn into a `CSharpCompilation`, binds a `SemanticModel`, and walks the bound tree to build a tree of `Cs2Gs.CodeModel` nodes — a **purpose-built G# emit AST** owned by this tool. `Cs2Gs.CodeModel` then **pretty-prints canonical G#** (section B). Before any generated `.gs` reaches `gsc`, the pretty-printed text is **round-trip validated by re-parsing it with the real G# parser** (`Gsharp.CodeAnalysis` syntax API, consumed read-only as a library reference); a file that does not parse is a translator bug and fails the Translate stage *before* a compile is ever attempted (section C).

This is chosen over the two alternatives named in issue #914 and one additional design that surfaced:

- **vs. a hand-rolled C# parser.** A hand-rolled parser would have to re-implement C#'s lexer, parser, *and* its semantic model — overload resolution, generic inference, `var` type inference, definite-assignment, nullable flow — to know, e.g., whether a C# `var` local is immutable or what concrete type a method group resolves to. That is years of work that Roslyn already does correctly and that the C# language evolves under us. Rejected.

- **vs. a Roslyn analyzer that builds the *compiler's* G# AST.** Two problems. (1) It would couple the tool to `gsc`'s internal *parse-oriented* syntax tree, whose shape is tuned for binding/emit and carries trivia, spans, and invariants that a translator must satisfy but does not want. (2) It blurs ADR-0027's boundary: the compiler's AST would acquire a Roslyn-shaped construction path. Rejected in favor of a dedicated emit AST that the pretty-printer owns end-to-end.

- **vs. reusing the compiler's syntax tree as the emit AST.** Even setting aside the analyzer framing, the compiler's `SyntaxTree` is an input contract (it must round-trip source text faithfully, preserve trivia, and back a `SemanticModel`); an *emit* AST is an output contract (it only needs to render canonical text and is free to normalize, drop, and re-shape). Conflating the two makes both harder. A small, output-only `Cs2Gs.CodeModel` keeps the translator's job — "decide the canonical G# shape" — separate from the printer's job — "render it deterministically." Rejected reuse.

Why Roslyn here does **not** contradict ADR-0027: ADR-0027 removed Roslyn from the *compiler/emit pipeline* (`Lexer → Parser → Binder → Lowerer → ReflectionMetadataEmitter`), because Roslyn's distinctive value (projecting G# symbols as `ISymbol`, hosting G# inside the Roslyn driver) is not on the v1.0 critical path and would import a multi-million-line rebasing burden into `gsc`. `cs2gs` uses Roslyn for the **opposite** direction and in a **different process**: as an *external, offline C# front-end* that reads *C#* source and never touches the G# compiler's metadata writer. The dependency lives only in `Cs2Gs.Translator` (`PackageReference Microsoft.CodeAnalysis.CSharp`); `gsc` gains no `Microsoft.CodeAnalysis` reference, loads no Roslyn assembly at startup, and incurs no fork. The two ADRs are therefore consistent: "no Roslyn *in the compiler*" (ADR-0027) and "Roslyn *as a C# reader in a sibling tool*" (this ADR) describe disjoint surfaces.

### B. Definition of "canonical G# output"

This is the contract the pretty-printer in `Cs2Gs.CodeModel` must satisfy. Output is **deterministic** (identical input → byte-identical output) and **idiomatic** (matches the house style of `samples/*.gs`). The translator **never guesses**: a C# construct with no established canonical G# form is *not* approximated — it is recorded as a structured *unsupported-construct* triage record (section D) and, where the file can still be emitted, marked at the offending site, so the pipeline surfaces the gap rather than inventing syntax.

#### B.1 File, package, and import layout

- One C# file → one `.gs` file. The first non-comment line is `package <Dotted.Name>` derived from the C# file-scoped/namespaced namespace (multiple namespaces in one file are split or hoisted to the dominant namespace; ambiguity → triage). Grammar: `PackageDecl = "package" identifier { "." identifier }` (spec §Packages and imports).
- `using X.Y;` → `import X.Y`; `using A = X.Y;` → `import A = X.Y` (ADR-aligned alias form, spec §Packages and imports). One import per line, original order preserved, `import` block directly under `package`.
- `System` is implicitly imported by the compiler, but the printer still emits an explicit `import System` when the C# file used it, matching `samples/*.gs` (e.g. `Class.gs`), so the file is legible and `/noimplicitimports`-safe.
- `global using` and `using static` map to `import` where a direct equivalent exists; `using static` with no G# equivalent for member-hoisting is triaged.

#### B.2 Indentation and brace style

- **4-space indentation**, no tabs.
- **K&R / same-line braces**: the opening `{` sits on the declaration/statement line, the body is indented one level, the closing `}` aligns with the opener's line. This matches every sample (`Class.gs`, `Struct.gs`, `DataStruct.gs`). One blank line between sibling member declarations; no trailing whitespace; file ends with a single newline.

#### B.3 `let` vs `var` vs `const` (immutability mapping) — ADR-0008, ADR-0067

| C# | G# | Rule |
| --- | --- | --- |
| `const X` | `const` | compile-time constant; initializer must be constant (ADR-0008). |
| `readonly` field | `let` field | immutable binding (ADR-0008 `let`; field keyword required by ADR-0067). |
| mutable field | `var` field | ADR-0067 requires the `var`/`let` keyword on every field. |
| local `var x = e` / explicitly-typed local **never reassigned** | `let x = e` | Roslyn data-flow (`SemanticModel`/`DataFlowAnalysis`) proves the local is never written after init → emit immutable `let`. |
| local that **is** reassigned | `var x = e` | mutable binding. |

The immutability decision is driven by Roslyn's definite-assignment/data-flow analysis, not by the C# `var`/explicit-type spelling — C#'s `var` is a type-inference keyword, G#'s `let`/`var` is a mutability keyword (ADR-0008), so the mapping is semantic, not lexical. Type clauses are emitted only when C# wrote an explicit type *and* inference would be ambiguous; otherwise inferred (`let x = e`).

**T2 — immutable-field initialization canonicalization.** A G# `let` field is read-only **everywhere**, including inside `init` (`GS0127`; `ExpressionBinder.Assignments.cs`). A C# `readonly` field assigned in the constructor therefore cannot be reproduced as a `let` field assigned in `init`; the assignment must move to a **field initializer** or a **primary-constructor parameter**. The translator analyzes a type's single instance constructor (no `: base(...)`/`: this(...)` chain) when every statement is a `field = …` assignment:

| C# constructor assignment | G# canonical form | Rule |
| --- | --- | --- |
| `_f = ctorParam;` (RHS is exactly a constructor parameter) | primary-constructor parameter `Type(_f T)` | the field is lifted to a primary-constructor parameter **named after the field**; the standalone field declaration is dropped. The parameter-field becomes public (G# primary-ctor parameters are public fields) — recorded as an Info diagnostic. |
| `_f = expr;` (RHS independent of every constructor parameter) | field initializer `private let _f T = expr` | the assignment becomes a `let`-field initializer; the field keeps its `private` visibility and immutable binding. |

When **every** constructor parameter is consumed by exactly one direct `_f = param` assignment, the explicit constructor is **dropped entirely** (its remaining `_f = expr` statements have all become field initializers), leaving no illegal `init`-time `let` assignment. If any statement does not fit the pattern (a non-assignment statement, a parameter used in an expression, a duplicate/unconsumed parameter, multiple constructors, a record) the constructor is left untouched and translated as-is. Chosen over option (b) (a privacy-preserving `var` field) because for L1 the primary-constructor form yields clean, idiomatic, compiling G#; the public-visibility change is recorded for the human to review.

#### B.4 `class` vs `struct` vs `data class` vs `data struct` — ADR-0029, ADR-0025, ADR-0078, spec §Structs…

| C# | G# |
| --- | --- |
| `class` | `class` (reference) |
| `struct` | `struct` (value) |
| `record` / `record class` | `data class` (reference, structural members) |
| `record struct` | `data struct` (value, structural equality) |

`data class`/`data struct` synthesize equality and copy/update ergonomics (ADR-0029, ADR-0032). The `record` *keyword* is **not** emitted (removed by ADR-0078); the canonical spelling is `data class`/`data struct`. C# positional records map to the G# primary-constructor form (`data struct Point(X int32, Y int32)`), fields-only records to the body form. A C# `struct` with exactly one field that C# treats as a newtype is *not* auto-promoted to `inline struct` (ADR-0033) — that is a semantic judgment the tool will not make; it emits a plain `struct` and leaves `inline struct` adoption to the human.

**T4 — fieldless record → plain (`open`) `class`/`struct`.** A G# `data` type requires **at least one field** (`GS0104`, "a data type requires at least one field"). A C# **fieldless record** — typically the `abstract record Shape;` base of a closed `record` hierarchy — therefore maps to a plain `class` (or `struct`), **not** a `data class`; it is marked `open` when any case derives from it (§B.6). Two further losses are made faithfully: G# has **no `abstract` class modifier** (the keyword is not recognized by the parser; `abstract class` → `GS0125`), so C# `abstract` is **dropped** (the `open class` is subclassable but not non-instantiable); and the record-synthesized `IEquatable<Self>` interface is **dropped from the base list** because a class cannot name itself in its own base clause (`open class Shape : IEquatable[Shape]` → `GS0113`, "Type 'Shape' doesn't exist"). Each loss is recorded as an Info diagnostic. The case records (`sealed record Circle(double Radius) : Shape`) keep the `data class Circle(Radius float64) : Shape` mapping.

**T1 — C# tuples → native G# positional tuples.** A C# value/named tuple (`(string Name, int Price, int Quantity)`) maps to the **native G# positional tuple type** `(string, int32, int32)` (spec §Type syntax), *not* to a synthesized `data struct`. G# tuples are **positional only** — the named-element spelling `(Name string, …)` does not parse — so C# element **names are dropped** at the type, and a named-element **access** `item.Price` lowers to the positional field `item.Item2` (resolved via Roslyn's `IFieldSymbol.CorrespondingTupleField`); positional `item.Item1` passes through. Tuple **construction** `(a, b, c)` maps to the G# tuple literal `(a, b, c)`. The mapping is recorded as an Info diagnostic. This was chosen over synthesizing a `data struct` per tuple shape because a `data struct` element type triggers a real compiler gap (below) and because native tuples are the genuinely canonical, round-trippable G# form.

> **`for … in List[ownedType]` element-type erasure — discovered compiler gap.**
> Iterating a `List[T]` whose element `T` is a **user type owned by the same
> compilation** (a `data struct`/`class` declared in the same program) and then
> accessing a member of the loop variable fails to bind (`GS0158`/`GS0159`): the
> for-in binder erases the element type via `TypeSymbol.FromClrType`
> (`StatementBinder.cs` ~L2852, `case ImportedTypeSymbol`), which cannot resolve
> a same-compilation user type, so `item.Member` has no type. Arrays (`[]T`) and
> lists of BCL/primitive elements (`List[int32]`, `List[string]`) bind correctly;
> only `List[ownedUserType]` is affected. Minimal repro:
> ```gsharp
> data struct Item(Name string, Price int32)
> var xs = List[Item]()
> xs.Add(Item{Name: "a", Price: 1})
> for it in xs { Console.WriteLine(it.Name) }   // GS0158 on it.Name
> ```
> This is **why T1 maps tuples to native positional tuples rather than a
> synthesized `data struct`** — `for item in List[(string, int32, int32)]` binds
> and `item.Item2` resolves. Filed as **#939**; the translator does not work
> around it. The indexer path (`xs[0].Name`) binds correctly, so the defect is
> specific to the for-in enumerable element-type recovery, not `List[T]`
> instantiation in general.

#### B.5 Methods: in-body vs receiver-clause — ADR-0079, ADR-0024, spec §Functions and methods

Instance methods on a **`class`** (or `data class`) the package **owns** are declared **in-body** as `func M(...) R { ... }`. The receiver-clause form `func (r T) M(...) R` is **reserved for non-owned receiver types** — CLR/BCL types, primitives, and types from other packages — i.e. C# *extension methods* (`this T` first parameter). ADR-0079 (issue #719) made this the rule and emits the soft `GS0314` warning when a receiver clause names an owned type; `samples/MethodsWithReceivers.gs` is the canonical example (in-body method on an owned class) and `samples/ExtensionFunctions.gs` is the canonical receiver-clause example (on `int32`). Operator overloads keep the receiver-clause form and are exempt from `GS0314` (spec §Functions and methods).

> **Owned-`struct` methods — RESOLVED (issue #938).** ADR-0079 frames the
> in-body canonical form as applying to owned `class` **and** `struct` receivers.
> As of issue #938 the compiler honours that for value types: a `func` member
> inside a `struct`/`data struct` body now binds as an instance method on the
> value type (synthesized by-ref `this`), reusing the receiver-clause
> owned-struct lowering and emission (`Parser.cs` accepts the member; the
> `DeclarationBinder` in-body path is no longer gated on `syntax.IsClass`).
> The **in-body form is therefore the canonical, warning-free spelling** for an
> owned-`struct` instance method, exactly as for classes; the receiver-clause
> form `func (r T) M(...) R` still binds identically but is flagged with
> `GS0314` (`DeclarationBinder.cs`:3129) to steer authors to the in-body site.
> User-defined `init(...)` constructors remain class-only by design — value
> types are constructed via primary constructors and struct literals, so no
> constructor gap exists for structs. The cs2gs translator (§B.14) may still
> lift owned-`struct` methods to the receiver-clause form for mechanical
> reasons; emitting the in-body form instead would now be warning-free and is
> a possible future translator improvement.

C# **extension methods** (`static R M(this T self, …)`) translate to the receiver-clause form `func (self T) M(…) R` (ADR-0019), since `T` is non-owned by definition.

#### B.6 Inheritance and the `:` clause — ADR-0017, spec §Type declarations

- C# classes are sealed-by-default in G#; a base class that is subclassed must be emitted `open class`, and the overriding member must carry `override` (ADR-0017). The translator uses Roslyn's `INamedTypeSymbol.IsSealed`/`IsAbstract`/inheritance graph to decide: a class that any other corpus type derives from → `open`; a C# `abstract`/`virtual` member that is overridden → `open`/`override` on the pair. C# `sealed class` → plain `class` (already the default) or `sealed class` when it participates in a closed hierarchy switched on exhaustively (ADR-0078).
- The base clause lists the **base class first, then interfaces**: `class Dog : Animal, IBark { … }` (spec `BaseClause = ":" QualifiedTypeName … { "," QualifiedTypeName }`; `samples/Class.gs`). Constructor chaining renders as `: Base(args)` on the base clause or `init(...) : Base(args) { … }` (ADR-0065, `samples/ExplicitConstructor.gs`).

#### B.7 Generics — ADR-0020, ADR-0097, ADR-0098/ADR-0049

- Bracket form for both declaration and instantiation: `func Identity[T any](value T) T`, `List[int32]()` (ADR-0020). **No angle brackets** ever appear in output.
- Constraints render in the bracket: the legacy slot (`any`, `comparable`, sealed-interface bound) plus repeatable flag constraints `class`, `struct`, `new()` (ADR-0097). C# `where T : class` → `[T class]`, `where T : struct` → `[T struct]`, `where T : new()` → `[T new()]`, `where T : IFoo` → `[T IFoo]`. Variance `in`/`out` is carried on type parameters of interfaces/delegates (ADR-0021).
- **`where T : notnull`** has no precise G# constraint keyword; the translator **drops** it (records an Info diagnostic). `comparable`/`any` would change the semantics, so the faithful choice is no constraint.

> **Generic-interface constraint `where T : IComparable<T>` — discovered compiler gap.**
> A constructed generic-interface constraint has no canonical G# spelling: the
> bracketed constraint slot does not accept a nested generic argument
> (`func Max[T IComparable[T]]` → `GS0005`, `Unexpected token <DotToken>`/nested
> bracket parse error), and dropping the argument (`[T IComparable]`) names a
> non-existent constraint type (`GS0113`, `Type 'IComparable' doesn't exist`).
> Minimal repro:
> ```gsharp
> func Max[T IComparable[T]](values IReadOnlyList[T]) T { return values[0] }   // GS0005
> ```
> The translator surfaces this as a clean `translation-unsupported` record
> (`TypeParameterConstraintClause`) and **drops** the constraint rather than
> emitting unparseable G#. Filed as **#943**.

#### B.8 Delegate types — arrow form, ADR-0075

Delegate **types** render in the canonical arrow form `(A, B) -> R`, **never** `func(A, B) R` (that legacy spelling emits `GS0303`). Void returns spell `-> void`; multi-return spell `-> (T1, T2)`; async spell `async (T) -> R`. C# `Func<int,int>` → `(int32) -> int32`; `Action<string>` → `(string) -> void`; `Func<Task<int>>` → `async () -> int32`. A C# **named** `delegate` declaration becomes `type Name = delegate func(...) R` (ADR-0059, `samples/NamedDelegate.gs`) — the one place the `func` keyword stays, because it is a *named delegate declaration*, not a type clause. Function-literal expressions keep `func(x int32) int32 { … }`; arrow lambdas use `(x int32) -> expr` (ADR-0074).

#### B.9 String interpolation — ADR-0055, ADR-0007, ADR-0011

Every G# string literal is interpolation-capable (no `$` prefix; see `samples/InterpolatedString.gs`). Therefore:

- A C# **non-interpolated** literal containing a literal `$` must have each `$` escaped to `$$` on output.
- A C# **interpolated** string `$"...{expr}...{x:F2}..."` → `"...${expr}...${x:F2}..."`: each hole `{e}` becomes `${e}`, C# `{{`/`}}` become literal `{`/`}`, and any literal `$` in the surrounding text becomes `$$`. A bare `{ident}` may render as `$ident` only when `ident` is a simple identifier; complex holes always use `${…}`.
- Format/alignment specifiers inside holes are preserved (ADR-0055 rich holes).

#### B.10 Visibility and default-visibility mapping — ADR-0014, ADR-0109, ADR-0006

Defaults: top-level declarations default to `public` (ADR-0014); top-level `private` is permitted (ADR-0109). The printer emits an explicit accessibility modifier **only when the C# accessibility differs from the G# default for that position**, otherwise omits it for canonical minimalism:

| C# | top-level | member |
| --- | --- | --- |
| `public` | omit (default) | emit `public` where member default is not public |
| `internal` | `internal` | `internal` |
| `private` | `private` (ADR-0109) | `private` |
| `protected` / `protected internal` | nearest supported (`internal`) + triage note | as left |

`protected` has no direct G# spelling today; it is mapped to the closest accessibility and flagged in triage rather than silently dropped.

#### B.11 Members: fields, properties, constructors, statics, enums, attributes

- **Fields** require `var`/`let` (ADR-0067, §B.3).
- **Properties** → `prop Name T` for auto-properties, with `{ get { … } set(v) { … } }` bodies for computed/custom accessors (ADR-0051, `samples/PropertyRef/Lib/Lib.gs`). `open prop`/`override prop` mirror method virtuality.
- **Constructors** → `init(params) { … }`, chaining via `: Base(args)` (ADR-0065). C# primary constructors / positional records map to the G# primary-constructor `Name(params)` head.
- **Static members** → a `shared { … }` block (ADR-0053); except the program entry's static class, which is hoisted to top level (T3, above). Sibling static calls inside a non-entry `shared { }` block are emitted **qualified** (`Geometry.Round(...)`), since an unqualified sibling static call does not resolve there (`GS0130`).

> **Static (`shared`) method overload resolution by arity — discovered compiler gap.**
> A user type whose `shared { }` block declares **overloaded** static methods
> (same name, different arity/params) cannot be called on any overload but the
> first-declared one: the binder resolves a single by-name match and arity-checks
> it (`GS0144`), never forming an overload set. Instance-method overloads on the
> same type resolve correctly. Minimal repro:
> ```gs
> class Geometry {
>     shared {
>         func Round(value float64) float64 { return Geometry.Round(value, 2) }
>         func Round(value float64, digits int32) float64 { return Math.Round(value, digits) }
>     }
> }
> Console.WriteLine(Geometry.Round(1.234))   // GS0144: 'Round' requires 1 arguments but was given 2
> ```
> Root cause: `ExpressionBinder.Access.cs` `BindUserTypeStaticCall` uses
> `StructSymbol.TryGetStaticMethod(name, out method)` (single by-name) rather than
> building a static method group + running `OverloadResolver` (as the instance
> path does). Filed as **#940**; it is the sole blocker preventing the L2 corpus
> app (overloaded `Geometry.TotalArea`/`Round`) from migrating green — every other
> L2 construct translates and compiles cleanly. No translation workaround exists
> without distorting the public API, since the spec permits static overloads.
- **Enums** → `enum Name { A, B, C }` (`samples/Enum.gs`); payload-bearing C# unions (sealed hierarchy idioms) map to discriminated-union enums (ADR-0078 §5) only when the source is unambiguously that shape, else triaged.
- **Attributes** → `@Name(args)`, one per line, order preserved (ADR-0047): C# `[Obsolete("x")]` → `@Obsolete("x")`. Explicit attribute targets (`[return: …]`, `[field: …]`, `[assembly: …]`) map to the `@target:Name(...)` form.
- **`foreach`** → `for x in coll` (ADR-0031); LINQ/extension calls keep instance-call syntax (`xs.Where((x int32) -> x % 2 == 0)`, `samples/LinqExtensions.gs`).

**T3 — C# entry point + static class → top-level.** The program entry in G# is **top-level statements** (a sample `.gs` runs its top-level code; there is no `Main` method entry), and an unqualified sibling static call inside a `shared { }` block does not resolve (`GS0130`). The translator uses `Compilation.GetEntryPoint(...)` to find the C# `Main` and rewrites its enclosing static class to top level:

| C# (entry class) | G# |
| --- | --- |
| `static void Main()` body | **top-level statements** appended after all package declarations (this is the program entry) |
| other `static` method of the entry class | **top-level `func`** (siblings call each other unqualified at top level, which resolves) |
| the entry `static class` itself / a `shared { }` wrapper | **dropped** — neither is emitted |

The mapping is recorded as an Info diagnostic. Only the type that *contains the entry point* is hoisted; other `static` utility classes still map to a class whose members sit in a `shared { }` block (§B.11, ADR-0053). This applies to executable compilations (a library compilation has no entry point, so its static classes keep the `shared { }` mapping).

#### B.12 Numeric type names and identifiers — ADR-0049, ADR-0098

Canonical output uses **width-bearing** primitive names (ADR-0049): C# `int`→`int32`, `uint`→`uint32`, `long`→`int64`, `ulong`→`uint64`, `short`→`int16`, `ushort`→`uint16`, `byte`→`uint8`, `sbyte`→`int8`, `float`→`float32`, `double`→`float64`, `bool`→`bool`, `string`→`string`, `char`→`char`, `object`→`object`. The friendly aliases (ADR-0098) parse, but the printer emits the canonical width-bearing form so output is uniform. **Identifier names are preserved verbatim** from C# (PascalCase types/members, camelCase locals) — the tool does not rename to a different casing convention. **Numeric literal spellings are likewise preserved verbatim** (the original token text, not the bound value): a C# `2.0` stays `2.0` and hex such as `0xFF0000` stays `0xFF0000`. This is load-bearing — G# has no implicit numeric promotion, so collapsing `2.0` to `2` would type it as `int32` and make `int32 * float64` a hard `GS0129` error.

#### B.13 Data-type structural equality and `IEquatable<Self>` — ADR-0078, ADR-0025

A `data class`/`data struct` auto-synthesizes value (structural) equality, `GetHashCode`, and the `with` updater. A C# record therefore drops its compiler-synthesized `IEquatable<Self>` from the base clause when emitted as a `data` type — re-stating `: IEquatable[Self]` is both redundant and a parse error (the synthesized interface is not user-written). The structural `==`/`!=` and `with` come for free from the `data` modifier.

#### B.14 Owned value-aggregate methods → lifted receiver-clause funcs — issue #938, ADR-0079

As of issue #938 a `struct`/`data struct` instance method **can** live in the type body — the parser and binder accept an in-body `func` on a value aggregate and bind it warning-free (§B.5). The cs2gs translator nonetheless still **lifts** such a method to a top-level receiver-clause `func (self T) Name(...)` emitted as a sibling immediately after the type, for mechanical reasons (its declaration-lifting pipeline predates the compiler fix). A top-level receiver-clause `func` has no implicit `this`, so inside the lifted body every bare instance-member reference is made explicit through the receiver (`self.X`). This compiles and runs correctly but emits the soft `GS0314` warning (ADR-0079, owned-type receiver clause). Emitting the in-body form instead — now warning-free — is a possible future translator improvement; the `GS0314` it currently produces is an expected, known diagnostic rather than a parity failure. (A plain `struct` still admits no explicit `init`; value types are constructed via primary constructors and struct literals.)

#### B.15 `with`-expressions — spec §Records and `with`

A C# `with`-expression maps to the canonical G# form `expr with { Field = value, … }` (the update list uses `=`, not the struct-literal `:`). An empty update list renders `expr with { }`. The target may be any `data` value; the result is a structurally-distinct copy.

#### B.16 Object initializers and value-type construction → composite literals — spec §Composite literals

C# `new T { Field = v, … }` (an object initializer) maps to the G# **composite literal** `T{Field: v, …}` (the literal body uses `:`). Construction form depends on the target's kind: a **reference type** (`class`, `data class`) uses the call form `T(args)`, but a **value type** (`struct`, `data struct`) uses the composite literal `T{Field: value}` even for positional construction — the call form on a value type is `GS0130` ("Function doesn't exist"). Positional arguments are zipped against the type's ordered settable instance members (e.g. a `record struct Point(double X, double Y)` constructed as `Point{X: …, Y: …}`).

#### B.17 Explicit casts → width-bearing conversion calls — ADR-0049

A C# explicit cast `(T)expr` maps to the G# **width-bearing conversion call** `T(expr)` (e.g. `(int)x` → `int32(x)`, `(byte)n` → `uint8(n)`). This is behaviour-faithful for numeric narrowing: the CLR truncates a `float64`→`int32` conversion toward zero exactly as C# `(int)` does, so a half-up rounding such as `(int)Math.Floor(d*100.0 + 0.5)` reproduces the C# result bit-for-bit (`ToCents(1.234) == 123`).

#### B.18 Sibling static-call qualification in non-entry static classes — ADR-0053

Inside a G# `shared { }` block a bare sibling static call does **not** resolve (`GS0130`); the call must be qualified through the owning type (`Geometry.Round(value, 2)`). The translator therefore qualifies a C# bare static call (`Round(value, 2)`) with its declaring type whenever that type maps to a `shared { }` block. The **entry static class is the explicit exception** (§B.11, T3): its members flatten to top-level `func`s that *do* call each other unqualified, so a bare sibling call inside the entry type stays bare (qualifying it through the dropped type would be `GS0157`).

#### B.19 Extension methods → top-level receiver-clause funcs; emptied static class dropped — ADR-0079

A C# extension method (`static R M(this T self, …)` on a `static class`) translates to a **top-level** receiver-clause `func (self T) M(…) R` (§B.5), because a receiver-clause `func` only binds its receiver at top level — inside a `shared { }` block the receiver is not in scope (`GS0125`/`GS0157`). The translator therefore **lifts** every extension method out of its enclosing `static class` to a top-level sibling (reusing the `pendingTopLevelDeclarations` mechanism of §B.14), and when *every* member of the static class is lifted the now-empty class is **dropped** entirely (a `class` with an empty body and empty `shared` block is `GS0104`/noise). `samples/ExtensionFunctions.gs` and `samples/GenericExtensionFunctions.gs` are the canonical forms.

#### B.20 Lambdas → canonical arrow form — ADR-0074, ADR-0075

A C# lambda maps to the canonical G# **arrow lambda** with a parenthesized, typed parameter list: `n => n % 2 == 0` → `(n int32) -> n % 2 == 0`; `(x, y) => x + y` → `(x int32, y int32) -> x + y`; a block-bodied lambda → `(x int32) -> { …; trailingExpr }` (`samples/ArrowLambda.gs`). Parameter types come from the Roslyn-bound delegate signature; an inferred parameter with no recoverable type falls back to the C# spelling. `Func<int,int>` parameters/returns spell as arrow types `(int32) -> int32` (§B.8). LINQ **method** syntax stays as the instance/extension call chain — `numbers.Where((n int32) -> n % 2 == 0).Select((n int32) -> n * n).Sum()` (`samples/LinqExtensions.gs`, needs `import System.Linq`).

#### B.21 LINQ query syntax → method-call chain (lowering)

G# has **no query-comprehension syntax**, so a C# query expression (`from n in numbers orderby n select n`) is **lowered to the equivalent method-call chain** the C# compiler itself desugars it into: `numbers.OrderBy((n int32) -> n).Select((n int32) -> n)`. `where`/`orderby`/`select`/`from-continuation` map to `.Where`/`.OrderBy`(+`.ThenBy`)/`.Select`/nested calls. The lowering is faithful because it reproduces Roslyn's own query-to-method translation.

#### B.22 `switch` expressions → G# `switch` expression (colon-arm form) — spec §Pattern matching

A C# switch expression maps to the G# **`switch` expression** used in expression position (assignable / returnable): `switch subject { case <pattern>: <expr> … default: <expr> }` (`samples/SwitchExpression.gs`; the colon-arm form is the expression form, distinct from the brace form `samples/PatternSwitch.gs` uses for statements). C# arm patterns map as: constant `0` → `case 0:`; relational `< 10.0` → `case < 10.0:`; type `Circle c` → `case c is Circle:` (the designator is usable in the arm body, e.g. `c.Radius`); property `{ X: 0, Y: 0 }` → `case { X: 0, Y: 0 }:`; discard `_` → `default:`. A property sub-pattern that binds a variable (`Circle { Radius: var r }`) is rewritten to a member access on the arm's type-pattern designator (`r` → `circle.Radius`) because G# has no `var`-binding sub-pattern.

#### B.23 `async`/`await` → G# `async func` with unwrapped return type — spec §Asynchronous, samples `AsyncTask.gs`

A C# `async` method maps to a G# **`async func`**, but the return type is the **UNWRAPPED result type** — the `async` modifier synthesizes the `Task`/`Task<T>` envelope itself (`samples/AsyncTask.gs`, `AsyncValueReturns.gs`). So `async Task<int> M()` → `async func M() int32 { … }` (not `Task[int32]`), and `async Task M()` → `async func M() { … }` (no return type). `await operand` maps to `await operand` unchanged. A **non-async** method that merely *returns* a `Task<T>` keeps its `Task[T]` return type (only `async` methods are unwrapped).

#### B.24 Predefined type as a static-call receiver → BCL type name

A C# predefined-type keyword used as an **expression** receiver of a static call (`string.Concat(parts)`, `int.Parse(s)`) emits the **BCL type name** so the receiver resolves: `string` → `String`, `int` → `Int32`, etc. (`String.Concat(parts)`). The lowercase keyword would not resolve as a static-call target in G#.

#### B.25 Target-typed `new()` → explicit constructed type

A C# target-typed `new()` emits the **explicit constructed type** inferred from the target: `List<int> items = new();` → `List[int32]()`. G# has no target-typed construction, so the type recovered from Roslyn's target type is made explicit.

> **Indexer declaration — discovered compiler gap.** A C# indexer
> (`public T this[int i] => _items[i];`) has **no canonical G# member form**, and
> a hand-written indexer-shaped property declaration *crashes* the compiler
> (`GS9998`, `ArgumentNullException`). The translator emits a clean
> `translation-unsupported` record (`IndexerDeclaration`) and does not attempt a
> mapping. Filed as **#944**.
>
> **Null-coalescing operator `??` — RESOLVED (#941).** `value ?? fallback` now
> maps directly to G#'s `??` null-coalescing operator. Originally this was a
> compiler gap (G# spelled the read `?:` and the parser rejected `??`); issue
> #941 / ADR-0116 respelled the G# operator to `??` and removed `?:`, so the
> translator emits `value ?? fallback` verbatim. No longer surfaced as a
> `translation-unsupported` record.
>
> **Member access on a bare-identifier element access — discovered compiler gap.**
> `values[i].Member` (a single **bare-identifier** index immediately followed by
> `.`) hits a parser ambiguity — `ident[ident]` is parsed as a generic
> instantiation expecting a `(` call, so the `.` is rejected (`GS0005`,
> `Unexpected token <DotToken>`). Literal and compound indices parse fine
> (`values[0].M`, `values[i + 1].M`), as does the index alone (`values[i]`), and
> hoisting the element to a local (`let v = values[i]; v.M`) compiles. Minimal
> repro:
> ```gsharp
> func First(values IReadOnlyList[int32]) int32 { var i = 0  return values[i].CompareTo(0) }   // GS0005 on .CompareTo
> ```
> Surfaced as a clean `translation-unsupported` record
> (`SimpleMemberAccessExpression`); the translator does not auto-hoist (that would
> risk the passing L1/L2 corpus). Filed as **#942**.



`Cs2Gs.Pipeline` runs four ordered stages per corpus app. Each stage has an explicit pass/fail gate; a failure short-circuits the remaining stages for that app, emits a triage artifact (section D), and is recorded in the run report. **"Migration completed" ≡ all four stages green: clean compile + clean IL verification + test parity with the original C#.**

| # | Stage | Action | Pass gate | On failure |
| --- | --- | --- | --- | --- |
| 1 | **Translate** | C#→G# via `Cs2Gs.Translator`; **round-trip parse** each emitted `.gs` with the real G# parser. | Every file parses; zero `unsupported-construct` records. | category `translation-unsupported`; stop. |
| 2 | **Compile** | Invoke `gsc` on the `.gs` set (slash-colon switches `/out: /target: /reference: /targetframework: /nowarn:`, per `src/Compiler/Program.cs`). | `gsc` exit 0, zero error diagnostics. | category `compile-error`, capturing every `GSxxxx`; stop. |
| 3 | **IL-verify** | `dotnet tool restore` then `dotnet tool run ilverify` (the repo-pinned `dotnet-ilverify`, `.config/dotnet-tools.json`) over the emitted assembly + its references, with the two documented ilverify false-positive bundles ignored (`-g`; see §D). | `ilverify` reports no errors. | category `ilverify-failure`; stop. |
| 4 | **Test-parity** | Build the ported `@Fact`/`@Theory`/`@InlineData` G# xUnit tests (the `gsharp-xunit` shape) and run `dotnet test`; compare pass/fail set — and, where applicable, captured program stdout against the repo's `.golden` convention — to the **C# baseline oracle** (section E). | Ported tests reproduce the C# baseline (same tests pass) and optional stdout matches. | category `test-parity-failure`; stop. |

**`gsc` selection / retry semantics.** The pipeline takes a `--gsc <path>` override (defaulting to the repo build output) so a run can be re-executed against a freshly built compiler. When a stage fails because of a *compiler gap* (a missing feature or a bug, not a translator defect), the pipeline records the gap and its retry history; the external agent files an issue (section D); and the **entire run can be re-executed from stage 1** against the updated `gsc`. Retry is whole-corpus and idempotent: because translation is deterministic (section B) and the parity oracle is fixed (section E), the only variable across retries is the compiler, so a previously-red app turning green is unambiguous evidence the gap is closed. Each artifact carries a `retryHistory` so closed-then-reopened regressions are visible.

### D. Triage / issue-filing protocol (the "LLM hook")

**The pipeline calls no LLM API and embeds no keys or network egress.** Issue #914's "pass the output to an LLM" is realized as a *hand-off*, not an in-process call, preserving determinism and the repo's secret-handling rules. Each failing stage writes a **structured, machine-readable triage artifact** (JSON, one file per failure under the run directory). An **external agent** — GitHub Copilot, a human-in-the-loop, or a separate CI job — consumes these artifacts and files GitHub issues via `gh`, labeling each with **`Oats`** (the issue #914 program label) plus applicable labels such as `cil-emit` (stage 3 failures), `bug`, or `enhancement`.

#### D.1 Triage artifact JSON schema (v1.0)

```json
{
  "schemaVersion": "1.0",
  "runId": "2026-06-21T20-00-00Z_3f9c1a",
  "timestamp": "2026-06-21T20:04:12Z",
  "corpusAppId": "corpus/03-generics-linq",
  "gscVersion": "0.9.0+build.482",
  "stage": "compile",
  "category": "compile-error",
  "diagnostic": {
    "id": "GS0313",
    "message": "switch expression not exhaustive over sealed type 'Shape'",
    "severity": "error"
  },
  "sourceLocation": {
    "gsFile": "out/03-generics-linq/Shapes.gs",
    "gsLine": 42,
    "gsColumn": 12,
    "csFile": "corpus/03-generics-linq/Shapes.cs",
    "csLine": 51,
    "csColumn": 9
  },
  "offendingCSharpConstruct": {
    "kind": "SwitchExpression",
    "snippet": "shape switch { Circle c => ..., Square s => ... }"
  },
  "suggestedIssue": {
    "title": "[cs2gs] GS0313 on exhaustive switch over imported sealed hierarchy",
    "body": "Translating corpus/03-generics-linq/Shapes.cs ... <reproduction, expected, actual>",
    "labels": ["Oats", "bug"]
  },
  "fingerprint": "sha256:1b9d…e7",
  "retryHistory": [
    { "runId": "2026-06-20T18-00-00Z_a1", "gscVersion": "0.8.9+build.470", "result": "fail" }
  ]
}
```

Fields:

- `schemaVersion`, `runId`, `timestamp`, `gscVersion`, `corpusAppId` — provenance.
- `stage` ∈ `{translate, compile, ilverify, test-parity}`; `category` ∈ `{translation-unsupported, compile-error, ilverify-failure, test-parity-failure}`.
- `diagnostic` — the G# diagnostic id/message/severity (for stages 2–3; for stage 4 the failing test id and expected-vs-actual).
- `sourceLocation` — both the emitted-`.gs` location **and** the originating C# location (the translator preserves a source map so a gap points back to the C# that triggered it).
- `offendingCSharpConstruct` — the C# construct kind plus a minimal snippet.
- `suggestedIssue` — pre-rendered title/body/labels the external agent can file as-is or refine.
- `retryHistory` — prior `{runId, gscVersion, result}` records for this fingerprint.

**Stages 1–3 implementation notes (what the pipeline emits today).** `Cs2Gs.Pipeline` writes one artifact file per distinct fingerprint per app at `<runsRoot>/<runId>/<appId-sanitized>/<stage>-<fingerprintShort>.json`, plus a whole-run `run.json` summary (section F) the report step aggregates. The fidelity points worth recording:

- **`diagnostic.id` for stage 1.** A `translation-unsupported` failure has no G# diagnostic (no `.gs` is produced for the construct), so the pipeline emits a stable synthetic id: `CS2GS-UNSUPPORTED` for an unmapped construct, or `CS2GS-ROUNDTRIP` for an emitted `.gs` that fails to re-parse. Stage 2 uses the real `GSxxxx`.
- **`sourceLocation` null rules.** The translator does not yet carry a per-line C#↔G# position map, so the two ends of `sourceLocation` are filled by *whichever* side the failure is anchored to and the other sub-fields are left `null` (the schema permits this): a stage-1 `translation-unsupported` fills `cs*` from the Roslyn node location and leaves `gs*` null; a stage-2 `compile-error` fills `gs*` from the `gsc` diagnostic and leaves `cs*` null. Correspondingly, `offendingCSharpConstruct` for a stage-1 failure is the C# construct (kind = Roslyn syntax-kind, snippet = the C# line), while for a stage-2 failure it is the *emitted G# construct* `gsc` flagged (kind classified from the G# line, snippet = the G# line). Wiring a real source map so stage-2/stage-3 artifacts also point back to the originating C# is deferred to a later step.
- **Stage 3 (`ilverify`) artifacts and labels.** `IlVerifyStage` runs only after a green stage-2 compile (it reads the emitted assembly path the `CompileStage` publishes on the shared context). It invokes the repo-pinned `dotnet-ilverify` (`.config/dotnet-tools.json`, tool `dotnet-ilverify` 10.0.8, command `ilverify`) via `dotnet tool run ilverify <assembly> -s System.Private.CoreLib -r <eachReference>` with the process **working directory anchored at the repo root** (so the local tool manifest is discovered) and **all paths passed absolute**; `dotnet tool restore` is run once, lazily, only when the tool probe fails. The reference set is the host runtime BCL (`System.Private.CoreLib.dll`, `System.*.dll`, `mscorlib.dll`, `netstandard.dll` from the shared-framework dir) plus the corpus app's `ReferencedAssemblies`, mirroring `test/Compiler.Tests/IlVerifier.cs`. A non-zero exit with real verification errors yields category `ilverify-failure`, one artifact per distinct **error-code + failing-method skeleton**, with `diagnostic.id` = the ilverify error code (e.g. `StackUnexpected`), `severity` = `error`, `message` = the trimmed `[IL]: Error […]` line, and `offendingCSharpConstruct.kind` = the failing `Type::Method(sig)` parsed from the line (documented fallback `IlMethod` when ilverify reports no method). `sourceLocation.gsFile` points at the emitted `.gs`; all positions are `null` (no source map yet). Labels are **`Oats` + `cil-emit`** (per the §D label list). The fingerprint reuses the §D.2 hash over `category|stage|diagnostic.id|construct.kind|normalizedShape`.
- **Stage 3 ilverify false-positive bundles (the only suppressions).** `dotnet-ilverify` 10.0.8 has two documented FALSE POSITIVES that are verifier limitations, **not** emitter bugs — the same minimal pattern emitted by `csc` fails identically and the JIT accepts the IL. The pipeline passes these as `ilverify -g <code>` ignore flags (and filters them defensively from parsed output) via the named constant `IlVerifyRunner.KnownIlVerifyFalsePositives`, so no spurious `ilverify-failure` gap is filed: (1) **`ReturnPtrToStack`** — by-value returns of a user-declared `ref struct` (track [dotnet/runtime#129030](https://github.com/dotnet/runtime/issues/129030)); (2) the static-virtual `constrained.` + `call` bundle **`CallAbstract`** + **`Constrained`** — ADR-0089 / issue #755 (track [dotnet/runtime#49558](https://github.com/dotnet/runtime/issues/49558)). These cite the same upstream issues as `IlVerifier.KnownIssues`. Any *other* ilverify error in a green-compiling app is a genuine `cil-emit` compiler gap and is captured (never suppressed). The whole stage no-ops to PASS when `GSHARP_SKIP_ILVERIFY=1` (for environments without the tool), matching `IlVerifier`.
- **Stage 4 (`test-parity`) modes, artifacts, and labels.** `TestParityStage` runs only after a green stage-3 (it is appended last in `MigrationPipeline.DefaultStages()`, so it short-circuits with the rest — L2/L3, which stop at stage 1 today, never reach it). It proves the migrated program behaves identically to the original C# against the §E oracle, selecting one of two modes by the corpus app:
  - **Executable apps with a captured stdout golden (e.g. L1) → stdout parity.** The stage runs the stage-2/3 **emitted assembly** (the `EmittedAssemblyPath` the `CompileStage` publishes on the shared context) via `dotnet <emitted>.dll`, captures stdout, and compares it to `baseline.stdout.golden` with the L1 end-to-end normalization (CRLF→LF, single trailing newline). A divergence — or a non-zero exit — yields category `test-parity-failure`, one artifact with `diagnostic.id` = `STDOUT-MISMATCH`, `message` = the first differing line (expected-vs-actual), and `offendingCSharpConstruct.kind` = `ProgramStdout`. **L1 is the first corpus app green end-to-end across all four stages.**
  - **Library apps with a sibling `.Tests` oracle (L2/L3) → xUnit pass/fail-set parity.** The stage translates the C# `.Tests` project to a G# xUnit project (`@Fact`/`@Theory`/`@InlineData`/`Assert.*`), scaffolds an **isolated** test `.gsproj` consuming the **locally-built** `Gsharp.NET.Sdk` nupkg (copied into the repo `.nugs` feed and pinned), runs `dotnet test` producing a TRX, parses it into the `{name, outcome}` set, and compares it to `baseline.tests.json`. Any **missing**, **extra**, or **outcome-mismatch** test yields category `test-parity-failure`, **one artifact per differing test**, with `diagnostic.id` = `TESTPARITY-<Missing|Extra|OutcomeMismatch>`, `message` = expected-vs-actual outcome, and `offendingCSharpConstruct.kind` = the failing test name. The TRX parse mirrors `corpus/trx-to-baseline.py` (only `UnitTestResult` rows; namespace-agnostic by local name; sorted by name) so the comparison is apples-to-apples. Because C#-xUnit-test → G# translation is part of the not-yet-complete *map-advanced* step, the stage **skips the library path with an explicit, recorded reason** (`test-parity.log`: "test-translation pending map-advanced") when an unsupported construct, a round-trip-parse failure, or a G# build failure is hit — it never fabricates a pass and never emits an artifact except on a real outcome mismatch from a successful run. The live orchestration (`GsharpTestProjectRunner`) is proven on a minimal translated G# lib+test that builds and `dotnet test`s green against the local SDK.
  - Both modes label artifacts **`Oats` + `bug`** (per the §D label list) and reuse the §D.2 fingerprint hash over `category|stage|diagnostic.id|construct.kind|normalizedShape` (one fingerprint per differing test / per stdout-mismatch shape). `sourceLocation.gsFile` points at the emitted `.gs`; positions are `null` (the divergence is observed at runtime, not at a source position).


#### D.2 Dedup fingerprint

`fingerprint = sha256( category + "|" + stage + "|" + diagnostic.id + "|" + offendingCSharpConstruct.kind + "|" + normalizedConstructShape )` where `normalizedConstructShape` strips identifiers/literals/line numbers down to the syntactic skeleton. The fingerprint **deliberately excludes** `runId`, `corpusAppId`, `gscVersion`, and concrete source positions, so the *same gap* hitting multiple corpus apps or recurring across runs collapses to **one** issue. The external agent keys on `fingerprint`: an artifact whose fingerprint already maps to an open issue updates that issue's occurrence list instead of filing a duplicate, and a fingerprint whose issue is closed but reappears reopens it.

The `normalizedConstructShape` normalizer (`Cs2Gs.Pipeline.Fingerprint.NormalizeShape`) applies, in order: string/char/interpolated literals → `lit`; numeric literals → `lit`; every remaining identifier or keyword → `id`; runs of whitespace collapsed to a single space and trimmed. Punctuation, operators, and brackets are preserved as the structural skeleton — e.g. both `foo.Bar("hi", 42, baz)` and `qux.Zap('x', 7, other)` normalize to `id.id(lit, lit, id)`, so the same construct shape dedups across apps and runs regardless of names, numbers, or positions. `gscVersion` is sourced from the compiler assembly's informational/product version (e.g. `0.2.106+e2206d0c48`), falling back to its file version.

### E. Corpus and parity oracle

A curated C# corpus of **increasing complexity** lives under `tools/cs2gs/corpus/`, one directory per app (e.g. `01-hello`, `02-classes-structs`, `03-generics-linq`, …). Every corpus app **green-builds and green-tests in C# first**; that captured C# state is the **parity oracle**:

- The C# xUnit results (pass/fail set per test) are recorded as the baseline the G# port must reproduce in stage 4. This library oracle is committed as `<App>.Tests/baseline.tests.json` (`{schemaVersion, app, framework, total, passed, failed, skipped, tests:[{name, outcome}]}`, captured by `corpus/capture-baselines.sh` + `trx-to-baseline.py`); the live library-parity run is exercised once C#-xUnit-test → G# translation (*map-advanced*) lands, and is gated with a recorded reason until then (§D.1).
- Where an app has deterministic console output, its stdout is captured as a `.golden`-style fixture (matching the repo's `samples/*.golden` convention) and compared after the G# build runs. This stdout oracle is live today: **L1-Console** passes stage-4 stdout parity (its emitted assembly's stdout matches `corpus/L1-Console/baseline.stdout.golden`), making it the first corpus app green across all four stages.

Corpus apps are ordered so early failures isolate the simplest possible gap. The oracle is regenerated only when the C# corpus itself changes — never as a side effect of a G# run — so retries (section C) compare against a fixed target.

### F. Reporting

`Cs2Gs.Report` produces, per run, **two** distributable artifacts:

1. A **single self-contained HTML file** (`report.html`; inlined CSS/JS, no external assets) with a per-app × per-stage status matrix, the discovered-gap list (grouped by `fingerprint`), and retry history — the human-facing dashboard.
2. A **machine-readable JSON summary** (`summary.json`) aggregating the same data (per-app/per-stage status, gap list keyed by fingerprint, retry history) for CI consumption and trend tracking.

Both are written under the run directory alongside the per-failure triage artifacts of section D.

**What the report step does today.** `Cs2Gs.Report.ReportModel` aggregates one completed run from its `run.json` (section F schema, `RunResult`) plus every referenced triage artifact (section D.1): it builds the per-app × per-stage matrix in canonical execution order (`translate`→`compile`→`ilverify`→`test-parity`, including `skipped` stages), and the discovered-gap list **grouped by `fingerprint`** — each gap collapses every artifact sharing that fingerprint into one entry carrying the representative category/stage/diagnostic/`offendingCSharpConstruct`/`suggestedIssue`, the per-app **occurrence** list (`appId` + that app's `sourceLocation`), and the **merged, deduped `retryHistory`**. The same gap hitting multiple corpus apps (e.g. the fingerprint shared by L2 and L3 today) therefore renders as **one** gap with multiple occurrences, mirroring the section D.2 dedup contract. All ordering is deterministic — apps by id, gaps by fingerprint, stages in execution order — so both artifacts are byte-stable and diffable.

- **`summary.json`** (written by `JsonSummaryWriter`, reusing `TriageSerialization.Options` so formatting matches the section D artifacts) carries run provenance (`runId`, `timestamp`, `gscVersion`, `succeeded`, `totalApps`, `greenApps`, `stageOrder`), the per-app rows (`appId`, `succeeded`, `failureCategory`, per-stage `{stage,status,artifactCount}`, the run-relative `artifacts`/`fingerprints`), and the `gaps` array keyed by `fingerprint` with `occurrences` and the merged `retryHistory`.
- **`report.html`** (written by `HtmlReportWriter`) is a single file with all CSS and JS inlined and **no external asset, CDN, font, or network reference** of any kind. It renders the run header (runId/timestamp/gscVersion, overall verdict, green/total app count), the color-coded status matrix (cells are **never color-only** — each carries `PASS`/`FAIL`/`SKIP` text plus an `aria-label`), the discovered-gaps section (each gap shows category/stage/diagnostic, the affected apps, the `suggestedIssue` title + labels incl. `Oats`, a collapsible issue body, and retry history), and a per-app detail drill-down linking each app's stages and artifacts. **Every** value interpolated into the document is HTML-encoded through a single `HtmlReportWriter.Encode` helper (diagnostic messages, C# snippets, and issue titles/bodies originate from source code and must be escaped to prevent broken or injected markup); the minimal collapse/expand JS is dependency-free. `Cs2Gs.Report` depends only on `Cs2Gs.Pipeline` (for the `RunResult`/`TriageArtifact` models and serializer options) — no Roslyn.

**CLI wiring.** A `cs2gs migrate` run generates both artifacts into the run directory automatically at the end (and prints their paths). `cs2gs report --run <runDir> [--out <file-or-dir>]` regenerates both from an existing `run.json` without re-running the pipeline, so a CI job can re-render a report (e.g. against an updated report template) without a fresh corpus run.

### G. Validation outcome (issue #914 capstone)

The tool was validated end-to-end across the full L1–L3 corpus. The deterministic
report (`report.html` / `summary.json`) is byte-stable and fully self-contained
(zero external asset/network references), and every discovered gap deduplicates
to a single fingerprinted entry that maps to a filed compiler issue. Final matrix:

| App | translate | compile | ilverify | test-parity | Blocking gap |
| --- | --- | --- | --- | --- | --- |
| `corpus/L1-Console` | PASS | PASS | PASS | PASS | — (fully green E2E) |
| `corpus/L2-Library` | PASS | FAIL | skip | skip | #940 (static-overload) |
| `corpus/L3-Library` | FAIL | skip | skip | skip | #941–#944 (`Advanced.gs` compiles standalone; `Generics.cs` blocked) |

**Objective 1 (faithful migration)** is demonstrated by L1 reaching full
stdout/test parity and by L2 + L3-`Advanced` translating to canonical G# that
`gsc` accepts. **Objective 2 (gap discovery)** is demonstrated by seven
structured, reproduced, and filed compiler gaps surfaced purely by migration
friction:

| Issue | Construct | Diagnostic |
| --- | --- | --- |
| #938 | owned-`struct` instance methods (no warning-free spelling) — **resolved**: in-body `func` now binds on value types | GS0314 |
| #939 | `for…in List[userType]` element-type erasure | GS0158 |
| #940 | static (`shared`) method overloads ignore arity | GS0144 |
| #941 | binary `??` operator unsupported (only `??=` exists) | GS0005 |
| #942 | `expr[i].Member` mis-parses `[i]` as type arguments | GS0005 |
| #943 | generic-interface constraint `[T IComparable[T]]` won't parse | GS0005 |
| #944 | no user-indexer declaration form; attempts crash | GS9998 |

L2/L3 not going fully green is the **intended** objective-2 outcome: the residual
failures are real compiler gaps, captured and filed rather than worked around or
hidden. Each will close as the cited compiler issue is fixed and the corpus run
re-greens automatically.

## Consequences

### Positive

- **Determinism and repeatability.** No LLM in the loop, a fixed parity oracle, and a deterministic pretty-printer mean a run is reproducible; the only intended variable across retries is `gsc`.
- **Canonical output by construction.** Section B is an enforceable contract; round-trip parsing (section A) guarantees emitted G# is at least syntactically real before a compile is attempted.
- **Gap discovery is structured, deduped, and actionable.** Every failure becomes a fingerprinted artifact with a C#↔G# source map and a ready-to-file issue, so the compiler backlog is driven by real migration friction.
- **ADR-0027 boundary preserved.** Roslyn stays out of `gsc`; the dependency is quarantined in `Cs2Gs.Translator`.

### Negative

- **Roslyn dependency in the toolset.** `Cs2Gs.Translator` carries `Microsoft.CodeAnalysis.CSharp` (and its transitive MSBuild/crypto pins already present in the scaffold). This is a tool-only cost, not a compiler cost, but it is real maintenance surface.
- **Corpus curation is ongoing work.** The oracle's value scales with corpus breadth; building and maintaining green C# apps is a continuing investment.
- **"Canonical" must track the language.** Every new G# surface ADR may add or change a section-B rule; the pretty-printer is a living contract, not a one-time write.
- **Constructs without a canonical form are deferred, not translated.** `protected`, `inline struct` newtype promotion, some `using static` shapes, and any not-yet-mapped construct are triaged rather than guessed — correct, but it means some apps will not migrate until the language or the tool grows.

### Neutral

- The four-project decomposition (CodeModel/Translator/Pipeline/Report, plus Cli/Tests) matches the existing scaffold; this ADR fixes responsibilities, not the project layout.
- The triage schema is versioned (`schemaVersion`), so it can evolve without breaking older artifacts.

## Alternatives considered

**Hand-rolled C# parser + AST mapper.** Rejected — re-implements Roslyn's lexer, parser, and (critically) semantic model; cannot cheaply answer the immutability/type-inference questions section B depends on; perpetually chases C# language evolution.

**Roslyn analyzer that builds the compiler's own G# AST.** Rejected — couples the tool to `gsc`'s parse-oriented syntax tree and erodes the ADR-0027 boundary by giving the compiler's AST a Roslyn construction path. A dedicated, output-only emit AST (`Cs2Gs.CodeModel`) is cleaner and keeps "decide the shape" separate from "render the text."

**Reuse the compiler's `SyntaxTree` as the emit AST.** Rejected — an *input* contract (faithful round-trip, trivia, span invariants, `SemanticModel` backing) is the wrong shape for an *output* contract (normalize, drop, re-shape, render deterministically). Conflating them makes both jobs harder.

**Call an LLM API directly from the pipeline.** Rejected — embeds keys and network egress, introduces non-determinism, and breaks the repeatability requirement. The structured triage artifact + external `gh`-filing agent achieves the same outcome (issues get filed) while keeping the pipeline deterministic and secret-free.

**Skip round-trip parse validation and let `gsc` be the first reader of generated G#.** Rejected — it conflates *translator* defects (malformed G#) with *compiler* gaps (valid G# the compiler can't yet handle), polluting the gap signal. Re-parsing with the real G# parser before stage 2 cleanly separates the two.
