# ADR-0047: Attribute consumption and declaration (Kotlin-style annotations)

- **Status**: Accepted
- **Date**: 2026-05-26
- **Phase**: Phase 9 — language depth (post-primitive)
- **Related**: issue #141, issue #140 (event declaration shares the annotation lead-in), ADR-0006 (visibility), ADR-0019 (extension functions), ADR-0023 (async state machine), ADR-0027 (Roslyn fork — cross-language metadata shape), ADR-0029 (data struct synthesized members), ADR-0034 (imported CLR interop), ADR-0040 (sequence type and yield)

## Context

GSharp's binder already honours a handful of well-known CLR attributes — `[CompilerGenerated]`, `[AsyncStateMachine]`, `[AsyncMethodBuilder]`, `[EnumeratorCancellation]`, `[Nullable]`, `[NotNullWhen]`, `[Extension]`, and friends. These are *recognised on imported metadata* and *synthesised by the emit pipeline*, but the surface language has no way to:

1. **Apply** an attribute to a user declaration (function, type, field, parameter, return type, generic parameter).
2. **Declare** a new attribute type that round-trips to a `System.Attribute`-derived class consumable from C# and F#.

Without (1), GSharp authors cannot mark a method `[Obsolete]`, opt a class into `[Serializable]`, drive an analyzer with `[Conditional("DEBUG")]`, or even spell `[EnumeratorCancellation]` on their own `async sequence` parameter — they must rely on the binder's special-case heuristics. Without (2), GSharp libraries cannot define their own attribute types for downstream consumers to read via `GetCustomAttributes`, breaking parity with the ADR-0027 promise that GSharp libraries look like ordinary .NET assemblies to C#/F# consumers.

The surface choice has three plausible shapes:

* **C#-style brackets**: `[Obsolete("use Bar")]` on the preceding line, plus use-site targets `[field: …]`, `[param: …]`, `[return: …]`.
* **Java/Kotlin `@`**: `@Obsolete("use Bar")` in the same position, with use-site targets `@field:Foo`, `@param:Foo`, `@return:Foo`.
* **F#-style brackets-with-pipes**: `[<Obsolete("use Bar")>]`.

GSharp's lexer already uses `[` for indexing and `]` will be used for slice/array types; the bracket form would either be visually ambiguous with a leading-bracket expression statement or would require a lookahead that the parser does not currently do. The `@` lead-in is unambiguous (today `@` is reserved but unused), reads identically to Kotlin/Java/Python decorators that most current GSharp authors already know, and is one character shorter at the call site. The choice also harmonises with the `@field:` / `@param:` / `@return:` qualifier syntax we want for use-site targeting.

The declaration side is largely sugar: a "tag" annotation on a class declaration that flips its base type to `System.Attribute` and enables `AttributeUsage` validation. The interesting decisions are *what* tag to use (`@Attribute`? `@annotation`? a modifier keyword?) and how compile-time `AttributeUsage` interacts with the existing class-declaration grammar.

This ADR locks the surface syntax, the resolution rules, the use-site targeting model, the declaration sugar, and the binding semantics for compiler-recognised attributes so that the implementation can proceed in reviewable phases (Phase 1: lexer + parser for `@`-form; Phase 2: binder lookup + diagnostics; Phase 3: emit `CustomAttribute` rows; Phase 4: declaration sugar; Phase 5: compiler-recognised attribute migration; Phase 6: interpreter facade; Phase 7: docs).

## Decision

### 1. Surface syntax — Kotlin-style `@` lead-in

An **annotation** is written `@` *Name* (*ArgumentList*)? where *Name* is a dotted identifier path resolved like any other type name, and *ArgumentList* is the same positional + named-argument syntax used by call expressions. The argument list is optional when the attribute has a parameterless constructor — `@Serializable` and `@Serializable()` are equivalent.

```
annotation        = "@" annotation_target? annotation_name annotation_args?
annotation_target = annotation_target_kind ":"
annotation_target_kind = "field" | "param" | "return" | "type" | "method" | "property" | "event" | "module" | "assembly" | "genericparam"
annotation_name   = identifier ( "." identifier )*
annotation_args   = "(" argument_list? ")"
```

Multiple annotations stack as separate lead-ins, one per `@`:

```gs
@Obsolete("use Bar instead")
@Conditional("DEBUG")
func foo() { }
```

Or, equivalently, on a single line when the source style permits:

```gs
@Obsolete("use Bar instead") @Conditional("DEBUG") func foo() { }
```

Order is preserved in metadata; reorderings that change attribute meaning (rare in practice) are user-visible.

### 2. Placement and the default target

Annotations may precede any declaration that the CLR allows a custom attribute on:

| Position                            | Default target          |
| ----------------------------------- | ----------------------- |
| Before a top-level `func`           | `method`                |
| Before a top-level `class`/`struct`/`interface`/`type` alias | `type`                  |
| Before a `var`/`const`/`let` at type or namespace scope      | `field`                 |
| Before a member `func`              | `method`                |
| Before a member field declaration   | `field`                 |
| Before a property accessor (`get`/`set`) | `method` (on the accessor) |
| Before a parameter inside `( … )`   | `param` (on that one parameter) |
| Immediately after the closing `)` and before the return type (or `{`) | `return` |
| Before a generic parameter inside `< … >` | `genericparam` |
| Before an `event` declaration (see #140) | `event` |

A use-site target qualifier overrides the default. The grammar `@field:Foo` on a property declaration directs the attribute to the synthesised backing field, not to the property; `@return:NotNull` on a function directs the attribute to the return-value metadata row.

`@assembly:` and `@module:` are only valid at the top of a compilation unit (after `package`/`import`, before any declaration) and are routed to the assembly / module metadata respectively.

The targets above are the *single canonical mapping*. Aliases such as Kotlin's `@receiver:` or `@delegate:` are not adopted; the GSharp surface has no separate receiver target (extension-function receivers are ordinary parameters — see §7), and there is no implicit delegate field to target.

### 3. Name resolution mirrors C#

When the binder sees `@Foo(args)`:

1. Look up `Foo` as a type. If found and it derives from `System.Attribute`, use it.
2. Otherwise, look up `FooAttribute` as a type. If found and it derives from `System.Attribute`, use it.
3. Otherwise, report `ERR_AttributeTypeNotFound` (Foo is not an attribute type / no such attribute).

If both `Foo` and `FooAttribute` exist and both derive from `System.Attribute`, that is an `ERR_AmbiguousAttributeName` — the user must qualify (`@FooAttribute(…)` to force the suffixed spelling, or use a fully-qualified path to force the bare one). This matches C#'s rule.

Constructor and named-argument resolution reuses the existing overload resolution machinery. Compile-time constants only — the value space is the CLR attribute-argument set: primitives, `string`, `Type`, enum, and one-dimensional arrays of those (per ECMA-335 II.23.3). Non-constant arguments report `ERR_AttributeArgumentNotConstant`.

The `Type` form is written `typeof(T)` (per issue #143 / ADR pending) — `@MyAttr(typeof(int))` lowers to the `Type`-token blob entry.

### 4. Use-site target qualifiers

`@kind:Name(…)` directs the attribute to a specific metadata row. The kinds defined in §2 above are the closed set. A qualifier that names an invalid target for the current declaration position reports `ERR_AttributeTargetInvalid` (e.g., `@return:Foo` on a `class` declaration).

The qualifier appears **inside** the `@` token, with no whitespace permitted between `@` and the kind (`@field:Foo`, not `@ field:Foo`). The `:` is the standard token; it does not introduce a new keyword because `field`, `param`, `return`, etc. are *contextual* — they are only special when they immediately follow `@`. Outside that position they remain free as ordinary identifiers (preserving the existing meaning of `field` and `return` in the language).

### 5. Declaration sugar — `@Attribute` on a class

A class declaration prefixed with the `@Attribute` annotation is sugar for "this class derives from `System.Attribute`". The compiler:

1. Implicitly adds `System.Attribute` to the class's base list (or reports `ERR_AttributeClassExplicitBase` if the user already supplied a different base — explicit `: System.Attribute` is allowed and tolerated as a redundant restatement).
2. Requires the class to be `public` if the surrounding module is published as a library (ADR-0027), warning otherwise. Internal attribute types are allowed but only usable inside the same assembly.
3. Honours any `@AttributeUsage(…)` annotation on the same declaration as the canonical `[AttributeUsage]` metadata row. `AttributeUsage` is itself an attribute and resolves through the same lookup rules — no special syntax is needed.

```gs
@Attribute
@AttributeUsage(AttributeTargets.Method | AttributeTargets.Property, AllowMultiple = true)
class TraceAttribute {
    let level : int
    func ctor(level : int) { this.level = level }
}
```

The class compiles to a public `TraceAttribute : System.Attribute` with one `int` constructor and an `AttributeUsage` metadata row that exactly matches what a C# declaration of the same shape would produce. C# consumers `using` the library see `[Trace(2)]` work identically to any C#-defined attribute.

The `@Attribute` annotation is the sole tag for this sugar. We do not adopt Kotlin's `annotation class` keyword form — GSharp already has `class`/`struct`/`interface`, and overloading one of those with a new modifier would either lose the visual symmetry with attribute *consumption* (every other attribute is `@Foo`) or fragment the surface. The `@Attribute` tag *is* an attribute; its presence on a class is what the binder keys on.

### 6. Compiler-recognised attributes

A small, closed set of attributes drive compiler behaviour today (the binder's hand-rolled recognisers). Going forward they are looked up by **type identity**, not by string name, and only after step 3 (§3) has bound the annotation to a `Type`. The recognised set in v1.0:

| Attribute                              | Recognised position             | Compiler effect                         |
| -------------------------------------- | ------------------------------- | --------------------------------------- |
| `System.Runtime.CompilerServices.ExtensionAttribute` | type or method | Already synthesised by ADR-0019; *consumed* when reading imported metadata. User-written `@Extension` on a method is rejected — extension status is conferred by the `func receiver.M(…)` syntax, not by the attribute. |
| `System.Runtime.CompilerServices.EnumeratorCancellationAttribute` | parameter on `async sequence` body | Marks the cancellation-token parameter the sequence rewriter threads through (ADR-0040 / async sequence work). User-written `@EnumeratorCancellation` on a non-`CancellationToken` parameter is `ERR_EnumeratorCancellationWrongType`. |
| `System.Runtime.CompilerServices.AsyncStateMachineAttribute` | method | Synthesis-only; user-written form is rejected. |
| `System.Runtime.CompilerServices.AsyncMethodBuilderAttribute` | method or return type | User-written form is accepted on methods and signals the custom builder pattern (post-v1.0; v1.0 only consumes it from imports). |
| `System.Runtime.CompilerServices.CompilerGeneratedAttribute` | any | Synthesis-only; user-written form is rejected. |
| `System.ObsoleteAttribute`             | any                             | Diagnostic on uses of the marked symbol (warning by default, error if `IsError` arg is `true`). |
| `System.Diagnostics.ConditionalAttribute` | method                       | Calls are elided when the named symbol is not defined in the compilation. |
| `System.Runtime.InteropServices.DllImportAttribute` | method (extern body)    | Recognised but only valid on declarations whose body marker is `extern` (post-v1.0; v1.0 rejects with `ERR_DllImportNotSupported`). |
| `System.AttributeUsageAttribute`       | attribute class only            | Validates targets / multi-apply on every subsequent use of the attribute. |
| `System.Runtime.CompilerServices.NullableAttribute` and `NullableContextAttribute` | any | Read-only; written exclusively by the emitter from ADR-0001 nullability state. User-written form is rejected. |
| `System.Diagnostics.CodeAnalysis.NotNullWhenAttribute` (and the `MaybeNullWhen` / `MemberNotNull*` family) | parameter / return | Recognised on imported metadata for nullability flow; user-written form is accepted and influences the binder's nullability state machine identically to C#. |

The rule "if it is on the recognised list, the binder still emits the `CustomAttribute` row" applies — recognition does not suppress emission. This is what makes the resulting assembly indistinguishable from a C#-produced one to downstream tools.

Attributes not on the recognised list are pure metadata — emitted, queryable through `GetCustomAttributes`, and otherwise inert at compile time.

### 7. Interaction with extension functions

Extension functions (ADR-0019) lower to a static method on `<Extensions>` with the receiver as the first parameter. Attribute syntax composes with this lowering as follows:

* `@Foo` *before* the `func receiver.M(…)` declaration targets the synthesised **method**. The synthesised `[ExtensionAttribute]` already on the method coexists.
* `@param:Foo` on the receiver parameter is valid and targets the first parameter (the receiver) — exactly as if the user had written `func M(self receiverType, …)` and annotated `self`.
* `@type:Foo` is invalid on an extension function — extensions do not have a user-controlled enclosing type; the `<Extensions>` static class is a compiler artifact. The diagnostic is `ERR_AttributeTargetInvalid`.

### 8. Interaction with `data struct` synthesised members

`data struct` (ADR-0029, ADR-0032) synthesises `==`, `!=`, `GetHashCode`, `ToString`, etc. Attribute syntax composes as follows:

* `@Foo` *before* the `data struct` declaration targets the **type**. The synthesised members do **not** inherit type-targeted attributes.
* `@field:Foo` on a `data struct` parameter (the constructor / property-shape parameters that ADR-0032 introduces) attaches `Foo` to the synthesised backing field for that parameter, and `@param:Foo` to the constructor parameter — matching C# `record` use-site target behaviour.
* Synthesised equality / `ToString` members are emitted with `[CompilerGenerated]` (already true today) and are not user-annotatable. A user-defined override of one of those members (which `data struct` already allows) may be annotated normally.

### 9. Interpreter parity

The interpreter (`Evaluator`) gains a parallel "attribute table" keyed by GSharp symbol. Each binding records the resolved attribute type, the constructor arguments (as runtime `object?[]`), and the named-arguments dictionary. The interpreter exposes them through the same reflection-shaped facade it already uses for `MethodInfo` / `Type` mirrors — `GetCustomAttributes(typeof(T))` on an interpreter symbol returns the same materialised list the emit path would surface to a runtime caller. Compiler-recognised attributes (§6) are honoured at interpretation time identically to the compiled path: `[Conditional("DEBUG")]` elision, `[Obsolete]` diagnostics, `[EnumeratorCancellation]` threading.

This keeps the ADR-0023 rule that the interpreter is the authoritative semantics for everything the language exposes.

### 10. Grammar additions (summary)

```
declaration       = annotation* core_declaration
parameter         = annotation* identifier type_clause
generic_param     = annotation* identifier
return_clause     = annotation* type
compilation_unit  = package_decl? import_decl* assembly_or_module_annotation* declaration*
assembly_or_module_annotation = "@" ( "assembly" | "module" ) ":" annotation_name annotation_args?
```

`annotation*` always means "zero or more annotations, each introduced by `@`". The parser does not coalesce a stream of `@`s into a list node — each annotation is its own syntax node so trivia (comments) round-trips faithfully.

## Consequences

* The lexer learns one new token (`AtToken` for `@`). The token already existed in reserved-but-unused state and is now wired into the parser.
* The parser learns annotation lead-ins on every declaration position listed in §2. The parsing is purely additive (an annotation list of length zero behaves like today's grammar), so no existing program changes meaning.
* The binder gains an `AttributeBinder` pass that runs after symbol declaration but before body binding, so that `[Obsolete]` and `[Conditional]` are visible to expression binding. Recognised attributes (§6) flow into the existing recognisers via type identity instead of string match.
* The emitter writes a `CustomAttribute` table row per resolved annotation, matching the CLR shape that C# emits. Existing synthesised attributes (`ExtensionAttribute`, `CompilerGeneratedAttribute`, `NullableAttribute`, …) keep going through their dedicated paths; user-written attributes flow through the same code with `EmitFromUserAnnotation = true`.
* `@Attribute` on a class is sugar for `: System.Attribute`. Library consumers (C#, F#) see ordinary attribute types — no GSharp-specific shape leaks across the assembly boundary.
* GSharp's surface diverges from C# bracket syntax. Authors coming from C# need one note in the language tour: "C# `[Obsolete]` is GSharp `@Obsolete`". The Kotlin `@` form is recognisable to anyone with Kotlin, Java, Python, or TypeScript decorator experience.
* `@` becomes a hard-token, foreclosing its use as a string-literal prefix (C#-style `@"…"` verbatim strings). GSharp already uses backticks for raw strings (ADR-0012), so this collision is theoretical only.
* `field`, `param`, `return`, `type`, `method`, `property`, `event`, `module`, `assembly`, `genericparam` remain ordinary identifiers everywhere except immediately after `@`. They do not become reserved.
* Compiler-recognised attribute *recognition* moves from string-based binder helpers to type-identity comparison against the imported `Type`. The set is closed for v1.0 (§6); adding a new recogniser is a deliberate binder change, not a `if name == "FooAttribute"` shortcut.
* Issue #140 (event declaration) consumes this ADR for its visibility / annotation lead-in surface — `@field:Foo` on a field-like event maps cleanly to the synthesised backing field.

## Alternatives considered

* **C#-style `[Foo]` brackets.** Rejected because (a) `[` already opens an indexer / collection-expression and tightening lookahead to distinguish "annotation list" from "expression statement starting with `[`" introduces ambiguity around top-level statements (which GSharp supports — ADR-0028), (b) `[field: …]` / `[param: …]` qualifiers read as nested indexers to a first-time reader, and (c) Kotlin's `@` is shorter, unambiguous, and matches the broader influence on GSharp's surface (`val`/`var` precedents, single-expression functions, data classes).
* **F#-style `[<Foo>]`.** Rejected as visually heavy and unique to F# — no obvious benefit over either C# or Kotlin spellings while costing two extra characters per annotation.
* **Attribute *declaration* via a new `annotation` keyword (`annotation class Foo { … }`).** Rejected because it forks the class-declaration grammar for a niche case and breaks the symmetry that "attributes are themselves applied with `@`". The `@Attribute` tag keeps the surface uniform and parallels the way `@AttributeUsage` is applied — both are annotations themselves.
* **Open the compiler-recognised set to a user-pluggable table.** Rejected for v1.0; the recognised set is small and tightly coupled to compiler internals (state-machine rewriting, nullability flow). A plugin model can be reopened post-v1.0 if a concrete user need emerges.
* **Treat `[EnumeratorCancellation]` (and friends) as keyword modifiers rather than attributes.** Rejected because the CLR-level rendering must remain an attribute (cross-language interop), and inventing a keyword that only round-trips to an attribute is strictly worse than letting users write the attribute directly.
* **Permit non-constant attribute arguments (e.g., `typeof(T)` of a generic parameter not yet bound).** Rejected — ECMA-335 forbids it, and the diagnostic at the surface is friendlier than letting the emitter fail later.
* **Single global default target ("everything attaches to the nearest declaration regardless of position").** Rejected because the C# author intuition that "the attribute before the `func` decorates the method, not its return type" is too useful to give up. The default-target table in §2 makes the common cases work without qualifiers.
* **Reuse `@` for verbatim string prefixes (C# `@"…"`).** Not adopted; backticks already cover the raw-string case (ADR-0012). Reserving `@` for annotations exclusively keeps the lexer simple.
