# ADR-0035: User-defined `operator` keyword on GSharp types

- **Status**: Accepted
- **Date**: 2026 (this PR)
- **Phase**: Phase 7 — Stream D follow-up to ADR-0034
- **Related**: ADR-0026 (operator-by-name deferral — **superseded** by this ADR for receiver-form binary and unary operators); ADR-0019 (extension functions / receiver clauses); ADR-0024 (methods-vs-extensions canonical style); ADR-0029 (data struct synthesized `==` / `!=`); ADR-0034 (imported CLR `op_*` consumption); execution plan §6.5.

## Context

ADR-0026 deferred operator overloading on GSharp-declared types pending a real use case and a chosen syntax. ADR-0034 then closed the *consumption* side (GSharp source can call CLR `op_*` static methods on imported types). What remained was a way to *declare* operators on GSharp types so user code can write `p + q` instead of `p.Plus(q)`, and so emitted assemblies expose `op_*` static methods that round-trip to other CLR languages.

After ADR-0024 / Phase 6.4, same-package receiver-form functions (`func (a T) Name(b T) …`) bind onto the user type as ordinary methods rather than going through the extension-function table. This gives us a natural place to hang operators: declare them with the same receiver-form syntax, just with the contextual keyword `operator` in front of the operator token.

## Decision

Ship receiver-form binary and unary `operator` overloads on GSharp `struct` / `data struct` / `class` types. The free-function form, conversions (`operator implicit` / `operator explicit` — landed in **ADR-0120** / issue #1017), `++` / `--`, and `true` / `false` are deferred to a follow-up.

### Syntax

```gsharp
struct Vector2 {
    var X int
    var Y int
}

// receiver-form binary operator
func (a Vector2) operator +(b Vector2) Vector2 {
    return Vector2{X: a.X + b.X, Y: a.Y + b.Y}
}

// receiver-form unary operator
func (a Vector2) operator -() Vector2 {
    return Vector2{X: -a.X, Y: -a.Y}
}
```

Accepted operator tokens this PR: `+ - * / % & | ^ << >> == != < <= > >=` (binary) and `+ - ! ~` (unary). The disambiguator between unary and binary forms is the parameter list after the operator token: an empty list (`operator -()`) is unary; a non-empty list (`operator -(b T)`) is binary.

Both `struct` and `class` user types can declare operators. Value-type `struct` operators bind, evaluate under the interpreter, and lower through the IL pipeline, but they share the pre-existing receiver-method emit limitation: same-package instance methods on value-type structs (including operators) crash at runtime under the IL backend today. The conformance sample uses `class` to side-step that limitation; `struct` parity rides on the broader value-type-method emit fix.

### Binding

`OperatorNames` (in `src/Core/CodeAnalysis/Binding/OperatorNames.cs`) maps each operator `SyntaxKind` to its CLR `op_*` name. The parser synthesizes an `IdentifierToken` whose text is the resolved `op_*` name, so the rest of the pipeline sees an ordinary receiver-form function and registers it as a method on the user type.

`BindBinaryExpression` and `BindUnaryExpression` consult, in order:

1. The built-in `BoundBinaryOperator` / `BoundUnaryOperator` table (numeric, bool, string concat, etc.).
2. **User operator** — for each operand whose type is a `StructSymbol`, `TryGetMethodIncludingInherited(op_*)`; for any operand type, `scope.TryLookupExtensionFunction(op_*)` (covers cross-package receiver-form declarations that still register as extension functions).
3. **Imported CLR operator** — `ClrOperatorResolution.TryResolveBinary` / `TryResolveUnary` on each operand's `ClrType` (ADR-0034).

The user-operator hook lowers to a regular `BoundCallExpression` against the resolved `FunctionSymbol`, so both the interpreter and the IL emitter reuse their existing call paths.

### Emit

Extension-function-shaped operators emit with `MethodAttributes.SpecialName` so the resulting assembly advertises the standard CLR convention. Same-package methods that are operators inherit the user type's emission path; surfacing them as `static specialname` on the user type's `TypeDef` (full C# round-trip) remains a follow-up — today they're callable from GSharp but not from C# consumers as `Vector2 + Vector2`.

## Consequences

- ADR-0026 is superseded for the receiver-form binary and unary operator surface. The "operator-by-name on user types" row in `docs/coverage-matrix.md` flips to ✅ for those forms.
- The parser grows one contextual keyword (`operator`) and one new `SyntaxKind` (`OperatorKeyword`). Existing code that uses `operator` as an identifier outside a `func` declaration continues to work (it's only recognized after `func [(recv T)]`).
- Operator declarations can also be written cross-package via the extension-function form `func (a T) operator +(b T) T`. ADR-0024 still applies — when the user type lives in the same package, the operator binds as a method on the struct; cross-package, it registers in the extension-function table. Both routes are handled by the binder hook.
- The free-function form (`func operator +(a T, b T) T`), conversions (`operator implicit`, `operator explicit`), `op_True` / `op_False` + short-circuit `&&` / `||`, and `++` / `--` overloads are deferred. None block the receiver-form MVP.

## Alternatives considered

- **Kotlin-style operator-by-name** (any method named `plus` becomes `+`). Rejected for the same reasons as ADR-0026: invisible coupling, no CLR round-trip, and conflicts with the existing `Add` / `Plus` method conventions in BCL types.
- **C# free-function form only** (no receiver clause). Rejected because GSharp's same-package receiver-form is already the canonical style for `struct` methods after ADR-0024; forcing operators into a different shape would be inconsistent. The free-function form can be added later without breaking this design.
- **Threading operator metadata through a dedicated `OperatorDeclarationSyntax`.** Rejected as overkill for the MVP — the parser's identifier-synthesis approach reuses the entire downstream pipeline. A dedicated syntax node can be introduced when conversions land (they need a different signature shape).
