# ADR-0060: `ref`, `out`, and `in` parameters — call-site modifiers and method-definition syntax

- **Status**: Proposed
- **Date**: 2026-06-05
- **Phase**: Phase 8 — language ergonomics / CLR-interop surface
- **Related**: issue #341 (`out` parameters at call sites), issue #342 (`ref` / `in` parameters at call sites); ADR-0039 (managed by-ref pointers `&`/`*` / `ByRefTypeSymbol`), ADR-0034 (imported CLR interop), ADR-0038 (generic method inference), ADR-0058 (ref-safe-to-escape), ADR-0017 (method virtuality), ADR-0018 (interface defaults), ADR-0021 (generic variance — established `in`/`out` as contextual keywords)

## Context

G# has the *machinery* for by-reference argument passing — ADR-0039 introduced managed by-ref pointers (`&x` / `*p` / `*T` / `ByRefTypeSymbol`), per-argument `RefKind` on every CLR-call bound-tree node, address-of emission (`ldloca` / `ldflda` / `ldelema` / `ldsflda`), and reflection-based write-back in the interpreter. `Int32.TryParse("42", &result)` and `Interlocked.CompareExchange(&counter, 1, 0)` compile, emit, and run today (see `ByRefEmitTests`).

What is missing is the *user-facing surface* that issues #341 and #342 specifically request:

1. **Distinct intent at the call site.** A single Go-style `&x` does not tell the reader whether the callee is going to *write* (`out`), *read-and-write* (`ref`), or *read-only-by-reference* (`in`). The CLR makes that distinction; G# erases it. Reviewers must mentally cross-reference the imported signature to know what `&x` means. This makes call sites harder to read and increases the surface for silent misuse.

2. **Inline binding for the Try-pattern.** The pervasive `bool TryX(..., out T result)` shape forces a two-line dance in G# today: declare `var result = 0`, then `Int32.TryParse("42", &result)`. There is no equivalent of C#'s `out var result` that introduces the variable inline at the call site, which makes by far the most common BCL use of by-ref parameters feel heavy. Issue #341 calls this out explicitly with the example `var ok = Int32.TryParse("42", out var n)`.

3. **User-defined `ref`/`out`/`in` parameters do not exist — and the existing `*T` parameter path is silently broken.** `ParameterSymbol` has no `RefKind` field, the parser has no parameter-modifier slot for ref-kinds, and although the binder will accept `*T` as a parameter type (treating it as `ByRefTypeSymbol`), the emitter does not. Empirically: declaring `func readVia(counter *int32) int32 { return *counter }` compiles cleanly, but loading the produced assembly throws `System.TypeLoadException: Could not load type 'System.Int32&'`. The cause is in `ReflectionMetadataEmitter.EncodeTypeSymbol` (line 10202), which has no `ByRefTypeSymbol` case and falls through to `EncodeClrType`, which in turn has no `IsByRef` branch — so the parameter signature is encoded as a TypeRef to a non-existent type literally named `"Int32&"` instead of as `ELEMENT_TYPE_BYREF (ELEMENT_TYPE_I4)`. The `isByRef: true` overload exists on the encoder (it is used at lines 5998 and 6405 for synthesized property-setter and async-builder calls) but the user-function emit path at line 5685 never reaches it. Two additional gaps stack on top of the encoding bug: the assignment-statement parser rejects `*p = expr` on the LHS ("Unexpected token `<EqualsToken>`"), so a `*T` parameter cannot be mutated from inside the body; and even with a correct encoding, a `*T` parameter has no signal to differentiate `ref` (no attrs), `out` (`[Out]`), or `in` (`[In]` + `IsReadOnlyAttribute` modreq) — it would always mean `ref`. The result is that a G# library cannot expose a `TryParse`-shaped or `Increment`-shaped API of its own, cannot interoperate with C# callers expecting `ref`/`out`/`in`, and cannot implement an imported interface whose methods declare by-ref parameters. Issues #341 and #342 are framed as call-site problems, but the call-site fix is incomplete without the symmetric definition-side fix — otherwise G# can *consume* the Try-pattern from the BCL but cannot *define* it, and the apparent "you can use `*T` as a parameter" path is a runtime trap.

4. **`in` semantics are inexpressible.** ADR-0039 routes both `&x` at a `RefKind.In` parameter and a bare value at the same parameter through `RefKind.In` (the emitter spills a value to a temp). There is no way at the call site to **opt in** to readonly-reference passing for an lvalue (avoid the copy) without simultaneously opting out of the value form. The user cannot ask the compiler "pass this large struct readonly-by-reference, and tell me if I am accidentally letting it copy."

5. **Reserved-word availability.** `in`, `out`, and `ref` are already established as contextual identifiers in G#: `in`/`out` on type parameters mean variance (ADR-0021), `ref` before `struct` declares a ref struct (ADR-0058), and `scoped` (ADR-0058) demonstrates the parser's "contextual modifier when followed by an identifier" pattern. Extending the same convention to argument positions and parameter declarations is mechanical and breaks no existing programs (verified: no current sample, test, or doc uses `in`/`out`/`ref` as a free identifier at an argument or parameter position).

The constraint envelope:

- **CLR fidelity.** Whatever surface we pick must round-trip through `ELEMENT_TYPE_BYREF` with the right `[In]` / `[Out]` / `IsReadOnlyAttribute` metadata so that C# consumers see normal `ref` / `out` / `in` parameters. The existing import path (`ComputeArgumentRefKinds` in `Binder.cs`) already classifies all four cases — the emit path must produce the same metadata.
- **G# flavor.** Go heritage gives us postfix-type parameters (`x int32`), Go-style explicitness (no hidden conversions), and `&x` as the primitive address-of. Kotlin influence gives us strong contextual-keyword discipline (`val`/`var`/`fun` style: prefix modifiers immediately before the bound identifier), named arguments, and the principle that everything visible at the call site should also be visible at the declaration. Neither Go nor Kotlin have ref-kinds, so the design must be invented in their *style*, not copied from either.
- **Composability with ADR-0039.** `&x` / `*T` / `*p` must continue to work — they remain the primitive that synthesized async/iterator IL is built on, and they are how a user expresses "I want to hold a managed pointer in a local." The new keyword form is a higher-level affordance that desugars into the same bound nodes.

## Decision

Introduce `ref`, `out`, and `in` as **contextual modifiers** in two positions: immediately before an argument expression at a call site, and immediately before a parameter identifier in a function declaration. The modifier carries the intent (read / write / read-only) explicitly, drives overload resolution and definite-assignment, and (on `out` argument positions only) optionally introduces an inline-bound variable. ADR-0039's `&x` operator and `*T` type are retained unchanged as the underlying primitive; the keyword form desugars into the same bound nodes.

### 1. Call-site syntax

The argument grammar of `ParseArguments` (Parser.cs:3842) is extended so that, at the start of each argument position, the parser may consume one of three contextual modifiers (`ref`, `out`, `in`) followed by an argument expression. Disambiguation is local and unambiguous: the modifier is recognized only when `Current.Text` is one of `ref`/`out`/`in` *and* the next token begins a legal argument-modifier payload (an identifier, `var`, `let`, or `_`). Any other follower (`,`, `)`, `=` for a named-argument tail, an operator, a literal) leaves the identifier alone — so a user-defined parameter actually named `out` continues to bind as a normal argument.

```gsharp
// Issue #341 — the Try-pattern with inline binding
if Int32.TryParse("42", out var n) {
    Console.WriteLine(n)             // n is in scope, typed int32
}

// Issue #341 — pre-declared `out` target
var n int32
if Int32.TryParse("42", out n) {
    Console.WriteLine(n)
}

// Issue #342 — ref
var counter = 0
Interlocked.Increment(ref counter)   // mutates counter in place

// Issue #342 — in
var big = SomeLargeStruct{Width: 1920, Height: 1080}
Consume(in big)                      // readonly-by-reference; no copy
```

The four legal **`out` argument shapes** are:

| Form | Meaning |
|---|---|
| `out name` | Pass the address of an existing lvalue `name` (local, parameter, field, array element, dereferenced pointer). Same lvalue rules as ADR-0039. |
| `out var name` | Declare a new mutable local `name`, scoped to the enclosing block, typed as the parameter's pointee type. The local is uninitialized before the call and definitely-assigned after the call. |
| `out let name` | Same as `out var name`, but the new local is read-only (single-assignment): the `out` call is its only write. This is the canonical form for the Try-pattern, where the result is consumed but never re-assigned. |
| `out _` | Discard pattern: a fresh anonymous slot of the parameter's pointee type is materialized and immediately thrown away. Emits to a synthesized local (`ldloca`) so the CLR call still has somewhere to write. |

Optionally-typed forms (`out var name T`, `out let name T`, `out name T` with declaration) are accepted and follow G#'s usual binding grammar — the type clause must be assignable from the parameter's pointee type; an exact match is recommended for clarity but a widening reference conversion is allowed.

`ref` and `in` accept only the lvalue form: `ref name`, `in name`. Neither admits inline binding, because both require the value to be observable *before* the call (`ref` requires definite assignment; `in` is read-only and therefore meaningless on a freshly-introduced local). For `in`, when the user wants to pass a value expression rather than an lvalue, they may bind it first (`let big = SomeLargeStruct{}` then `Consume(in big)`); the binder does **not** silently spill values at `in` argument positions, in deliberate contrast to C#. This makes the cost (a copy to a temp lvalue) visible.

### 2. Method-definition syntax

`ParseParameter` (Parser.cs:1692) is extended to accept an optional ref-kind modifier immediately before the parameter identifier, following the same "contextual modifier when followed by an identifier" rule already used for `scoped`. The modifier composes with `scoped` (`scoped` precedes the ref-kind modifier when both are present, mirroring C#'s `scoped ref` ordering).

```gsharp
// User-defined Try-pattern (issue #341 symmetry)
func TryParseHex(text string, out result int32) bool {
    // result must be definitely-assigned on every path that returns true
    // and on every path that returns false (the canonical out contract:
    // assigned on all return paths, including failure).
    result = 0
    for ch in text { /* ... */ }
    return true
}

// User-defined ref-mutating helper
func Bump(ref counter int32, by int32) {
    counter = counter + by
}

// User-defined in-by-reference observer
func Area(in rect Rectangle) int32 {
    return rect.Width * rect.Height   // read-only access
}

// Receiver-style method (ADR-0019 extension function shape)
func (c *Counter) Increment(ref delta int32) {
    delta = delta + 1
    c.value = c.value + delta
}

// Combined with `scoped` (ADR-0058) on a `*T` parameter
func observe(scoped ref live SomeRefStruct) { /* ... */ }
```

Inside the body, the **symbol type** of an `out`/`ref`/`in` parameter is its declared element type `T`, not `*T`. Reading the parameter yields a value of type `T` (the binder/emitter inserts `ldind.*` as needed); writing the parameter (legal for `out` and `ref`, illegal for `in`) stores back through the pointer (`stind.*`). This keeps the function body free of explicit dereferences — `result = 0` is a write to the underlying caller variable, not a write to a local. A user who genuinely wants a `*int32` to manipulate explicitly can still write `&result` to take its address, just as ADR-0039 specifies.

**`*T` is not a legal parameter type.** Today the binder accepts `func f(x *int32)` as syntactically valid, but the emitter produces malformed metadata (`TypeLoadException: Could not load type 'Int32&'` at assembly load — see Context §3 for the empirical reproduction). Rather than fix the encoding bug and ship two parallel surfaces for the same concept (the ergonomic `ref x int32` *and* the low-level `x *int32`), this ADR formalizes the carving of responsibilities introduced by ADR-0039:

| Surface | Role | Where legal |
|---|---|---|
| `*T` | the **type** of a managed pointer (`ELEMENT_TYPE_BYREF`) | local variables; synthesized state-machine plumbing |
| `&x` | the **operator** that produces a `*T` value from an lvalue | any expression position; the desugar target of ref-kind arguments |
| `ref` / `out` / `in` | the **parameter and argument modifiers** that name the CLR ref-kind contract | parameter declarations, argument positions |

Under this carving, `*T` is rejected as a parameter type with the new diagnostic GS0238 ("managed-pointer type `*T` is not a legal parameter type; use `ref name T`, `out name T`, or `in name T` instead"). The diagnostic message includes the suggested rewrite. `*T` remains legal as a local-variable type (the underlying primitive for advanced scenarios such as binding an address once and using it twice) and continues to be used internally by the async kickoff and iterator state-machine synthesizers. `*T` was already prohibited as a field type (GS9006) and as a return type / closure capture (GS9004, per ADR-0058); the parameter-position prohibition closes the last gap.

This is not a back-compat break: no user code can be relying on `*T` parameters because every such program fails at assembly load. The change converts a silent runtime trap into a clean compile-time diagnostic with an actionable fix.

### 3. Symbol-level representation

- `RefKind` (already defined in `src/Core/CodeAnalysis/Binding/RefKind.cs`) gains no new cases. The existing four values (`None`, `Ref`, `Out`, `In`) are sufficient and are reused.
- `ParameterSymbol` gains a `RefKind RefKind { get; }` property, defaulting to `RefKind.None`. The constructor accepts the new parameter; all existing call sites pass `RefKind.None` implicitly.
- The declared element type stored on the parameter (`Type` inherited from `LocalVariableSymbol`) remains the **pointee type** `T`, not `ByRefTypeSymbol.Get(T)`. The ref-kind is metadata *about* the parameter, not part of its in-scope type. This avoids forcing every reader of `parameter.Type` to peel a `ByRefTypeSymbol` and keeps the body-scope binding intuitive.
- For function-symbol *signature* purposes (overload resolution, override matching, delegate compatibility), the effective parameter type is `(Type, RefKind)` as a pair. Two functions that differ only in a parameter's `RefKind` are *different signatures*, matching CLR rules.
- `FunctionSymbol`/`ImportedMethodSymbol` already encode by-ref parameters in their underlying `MethodInfo` via `ParameterType.IsByRef`; this remains the source of truth on the import side. The new property on `ParameterSymbol` is the source of truth on the *G#-authored* side, and `Binder.LookupParameter` populates it identically whether the symbol is constructed from a G# declaration or imported from a CLR signature.

### 4. Syntax-tree representation

Two new shapes are introduced on the syntax side; both follow the convention of carrying the literal contextual token so the parser stays lossless and the IDE can render the modifier in semantic highlighting.

- `ParameterSyntax` gains an optional `RefKindModifier` token (sibling to the existing `ScopedModifier`). The slot is null when no modifier is present.
- A new `ArgumentSyntax` wraps every argument in a call's argument list, carrying an optional `RefKindModifier` token, the argument expression, and — for `out var name` / `out let name` / `out _` shapes — an `OutDeclaration` sub-node bearing the `var`/`let`/`_` token and the optional type clause. Today the call grammar passes raw `ExpressionSyntax` into the separated list (Parser.cs:3842); this becomes `SeparatedSyntaxList<ArgumentSyntax>`. The change is internal: `NamedArgumentExpressionSyntax` is folded into `ArgumentSyntax` as a sibling slot (named + ref-kind are mutually compatible in principle; in V1 the binder rejects `name = ref x` with a diagnostic — see §8 for the deferred-relaxation note).

The grammar disambiguation table for the start of an argument:

| Lookahead | Interpretation |
|---|---|
| `name =` (identifier + `=`) | Named argument (existing behavior). |
| `ref` `<ident-or-paren>` | `ref` argument. |
| `in` `<ident-or-paren>` | `in` argument. |
| `out` `var` `<ident>` | `out var` inline-binding argument. |
| `out` `let` `<ident>` | `out let` inline-binding argument. |
| `out` `_` | `out` discard argument. |
| `out` `<ident>` | `out` lvalue argument. |
| Anything else | Plain expression argument. |

The grammar disambiguation table for the start of a parameter:

| Lookahead | Interpretation |
|---|---|
| `scoped` `<ref-kind?>` `<ident>` `<type>` | Scoped parameter, optionally with a ref-kind. |
| `ref`/`out`/`in` `<ident>` `<type>` | Ref-kind parameter. |
| `<ident>` `<type>` | Plain by-value parameter (existing behavior). |

### 5. Bound-tree representation

The keyword form **desugars into the same bound nodes that ADR-0039's `&x` produces**. The binder normalizes every ref-kind argument into a `BoundAddressOfExpression` over the underlying lvalue, and stamps the corresponding `RefKind` into the call expression's `ArgumentRefKinds`. For `out var x` / `out let x` / `out _` argument shapes, the binder additionally:

1. Synthesizes a fresh `LocalVariableSymbol` (read-only for `let`, mutable for `var`, anonymous-discard for `_`) with type equal to the parameter's pointee type, scoped to the enclosing statement block.
2. Wraps the call expression in a `BoundOutDeclarationStatement` (or, when the call is the value of a `BoundExpressionStatement`, prepends a `BoundVariableDeclaration` so the local enters scope before the call). For an *expression-position* call (e.g. inside an `if` condition), the declaration's scope is the enclosing statement and the post-call definite-assignment range begins immediately after the call expression — matching C#'s out-var scope rule.
3. Records the new local as definitely-assigned-after-call in the CFG/DA tracker. The existing DA pass already supports "assigned after this point" tracking; the new rule simply marks the synthesized local as DA at the program point immediately following the containing call.

On the **declaration side**, when a G# function declares a `ref`/`out`/`in` parameter, the binder:

1. Stamps the `ParameterSymbol.RefKind` accordingly.
2. Inserts a `BoundParameterRefAdjustment` lowering step that translates each *read* of the parameter inside the body into an implicit dereference and each *write* (for `ref`/`out`) into an implicit indirect store. The lowering is invisible in the symbol table: the body still sees the parameter as type `T`, but the bound tree carries explicit `BoundDereferenceExpression` / `BoundIndirectAssignmentExpression` nodes that the emitter can lower to `ldind.*` / `stind.*` (already implemented per ADR-0039).
3. For `out` parameters, runs a definite-assignment pass that requires the parameter to be assigned on every return path. Existing DA infrastructure already classifies returns and unreachable code; the new rule is "on every path that reaches a `return`, every `out` parameter must have been written at least once."
4. For `in` parameters, marks the parameter symbol as read-only (the existing `LocalVariableSymbol.IsReadOnly` flag) so any assignment in the body fails with the standard "cannot assign to read-only variable" diagnostic, augmented with a hint that the source is the `in` modifier (see GS0232 in §8).

### 6. Emitter mapping

**Call sites.** No new emit code is needed beyond what ADR-0039 already implements. The keyword-form arguments lower to `BoundAddressOfExpression` (or, for `out _` and value-spilled `in`, a synthesized temp + `ldloca`), and `EmitAddressOf` already handles every lvalue shape (`ldloca`, `ldarga`, `ldflda`, `ldsflda`, `ldelema`). The `ArgumentRefKinds` array drives the call-site argument loop identically to today.

**Parameter signatures.** When emitting a G#-authored function with a ref-kind parameter, the metadata writer in `ReflectionMetadataEmitter` constructs the parameter signature with `ELEMENT_TYPE_BYREF` over the pointee type. This is the same `isByRef: true` path already used for synthesized async-builder calls. The parameter attributes are stamped to match what C# consumers expect:

| RefKind | Element type encoding | `ParameterAttributes` | Extra metadata |
|---|---|---|---|
| `Ref` | `T&` | `None` | none |
| `Out` | `T&` | `Out` | none |
| `In` | `T&` | `In` | `modreq(IsReadOnlyAttribute)` on the parameter type; `IsReadOnlyAttribute` on the parameter; `IsReadOnlyAttribute` on the method if every `in` parameter is annotated (matches Roslyn). |

For `in` parameters, the `System.Runtime.CompilerServices.IsReadOnlyAttribute` is emitted into the user's package (synthesized once per package, like other "embedded" attributes) if the target framework's reference assemblies do not surface a usable one — same pattern Roslyn uses.

**Body lowering.** A function body that reads `result` (an `out int32` parameter) emits:

```
ldarg.<i>           // address of the out slot
ldind.i4            // load the int32 it points to
```

A write to `result = 7` emits:

```
ldarg.<i>           // address of the out slot
ldc.i4.7            // value
stind.i4            // store through the pointer
```

These sequences are already emitted today for `*p` dereference and `*p = expr` assignment on a `BoundDereferenceExpression` (ADR-0039 §5); the binder simply produces those nodes on the user's behalf.

### 7. Interpreter (evaluator) mapping

The interpreter already implements the post-call write-back loop ADR-0039 §6 specifies, via reflection's `object[]` argument array. No additional infrastructure is needed for **call-site** ref-kind arguments — the keyword form lowers to the same `BoundAddressOfExpression` operand that the existing evaluator path consumes.

For **G#-authored functions with ref-kind parameters**, the interpreter maintains a parallel slot map: when entering the function frame, each ref-kind parameter is bound to a `EvaluatorRef` (an indirection token holding a getter/setter pair over the *caller's* variable). Reads inside the body resolve `parameter` through the getter; writes resolve through the setter. On normal return, no additional write-back is needed (the writes already went directly into the caller's slot). For interop with reflection-invoked G# functions, the same `object[]` write-back rule applies: when a G# function is called via `MethodInfo.Invoke`, ref-kind parameter values are written back into the caller's `object[]` by the CLR.

### 8. Diagnostics

The next available GS-series diagnostic ID is GS0230 (verified against `DiagnosticBag.cs` — last allocated is GS0229). New diagnostics:

| ID | Severity | Trigger |
|---|---|---|
| GS0230 | Error | Argument modifier (`ref`/`out`/`in`/none) does not match the parameter's ref-kind. Message includes both observed and expected kinds and the parameter name. |
| GS0231 | Error | `out var` / `out let` / `out _` appears outside an `out` argument position (e.g. as a standalone expression, in a `ref` slot, or as a named-argument value). |
| GS0232 | Error | Assignment to an `in` parameter inside the function body. Message says "`in` parameter `{name}` is read-only; remove the `in` modifier on the declaration if mutation is intended." |
| GS0233 | Error | Function returns on a path where `out` parameter `{name}` is not definitely assigned. Reports the unassigned path's terminator location. |
| GS0234 | Error | Variable `{name}` is not definitely assigned before being passed by `ref`. (User-facing twin of the internal GS9003 that today fires only for synthesized `&x`.) |
| GS0235 | Error | Override or interface implementation's parameter ref-kind does not match the base/interface member. (E.g. overriding `Try(out int32)` with `Try(ref int32)` is illegal.) |
| GS0236 | Error | `out`/`ref`/`in` is not a legal modifier on a variadic parameter (`name ...T`). The two features compose poorly at the CLR level (params arrays cannot be `T&[]`) and are rejected at parse / bind time. |
| GS0237 | Warning | A call passes a value at an `in` parameter position without the `in` modifier. The compiler does **not** silently spill; the warning fires to invite the user to either pass `in lvalue` or remove the `in` from the signature. (Promotable to error in a future ADR if the warning proves consistently followed.) |
| GS0238 | Error | A function declares a parameter of managed-pointer type `*T`. Message: "managed-pointer type `*T` is not a legal parameter type; use `ref name T`, `out name T`, or `in name T` instead." Replaces today's silent emit corruption (Context §3) with a compile-time diagnostic and a concrete rewrite. Same rule applies to delegate parameter slots, named-delegate-type parameters, and `func(...)` structural-type parameters. |

GS9001–GS9006 from ADR-0039 continue to fire for low-level `&x` misuse and remain the canonical diagnostics for direct address-of operations. The new GS023x family is keyword-form-specific and produces more targeted messages because it can name the modifier the user typed.

### 9. Overload resolution

Overload resolution (ADR-0034 / ADR-0038) is extended in one place: when ranking candidates whose parameter `i` has a non-`None` ref-kind, the candidate is *eligible* only if argument `i`'s observed ref-kind matches exactly. There is no implicit `None → In` promotion (per §1 — the `in` modifier is mandatory on the caller's side). The match is symmetric, so `ref` cannot satisfy an `in` parameter and vice versa, matching CLR rules.

Type inference (`InferTypeArguments` per ADR-0038) is unchanged because it already peels `IsByRef` from parameter types before unification ("ByRef — peel the byref and recurse"). The inference engine sees the pointee type on both sides and the ref-kind matching is a separate gate.

For instance-method receivers (ADR-0024), value-type receivers continue to be passed by their implicit `this` address as today (ADR-0039 §3d). No surface `ref`/`out`/`in` modifier is permitted on a method's receiver clause; the implicit `this` ref-kind is `ref` for value-type instance methods and `none` for reference-type instance methods, as the CLR dictates.

### 10. Async / iterator interactions

`out` and `ref` parameters are **not** legal on `async` functions, on `sequence`-returning iterator functions, or on `async sequence` functions. The state-machine rewriter cannot hoist a managed pointer into a field (`ELEMENT_TYPE_BYREF` is not a valid field signature — ADR-0039 §4 / ADR-0058), so a method whose `out`/`ref` parameter outlives an `await` or `yield` suspension cannot be safely emitted. `in` parameters are likewise rejected on the same grounds.

The diagnostic is GS0226-family (existing async/iterator restriction reporter) extended with the message "ref-kind parameter `{name}` cannot appear on an `async`/`sequence` function." (Same shape as the existing diagnostic that bans `ref struct` locals across `await` per ADR-0058.)

### 11. Documentation comments

`@param` (ADR-0057) documentation entries for ref-kind parameters render with the ref-kind in the parameter list — `@param ref counter ...` / `@param out result ...` / `@param in box ...`. The doc-ID encoder uses C#-compatible suffixes for ref-kinds in the parameter signature so that XML doc IDs match those produced by Roslyn (`@` for `ref`/`out`, with the `[Out]` / `[In]` distinction surfaced via the existing parameter-attribute encoding).

### 12. Aliases, delegates, and named delegate types

`named delegate type` declarations (ADR-0059) accept ref-kind parameters identically to function declarations; the underlying CLR delegate type is emitted with `Invoke(T&)` signatures and the appropriate `[Out]` / `[In]` attributes. A delegate-typed local can therefore wrap a `Try(out int32)`-shaped function and the call-site `out var n` form works through the delegate exactly as it works on a direct call. This is necessary for issue-#341 ergonomics to compose with first-class function values (e.g. injecting a "parser" function into a config loader).

Func-typed parameters expressed via the structural `func(T1, T2) R` clause (ADR-0043 family) gain ref-kind modifiers on each parameter slot — `func(out int32) bool`. The syntax mirrors function declarations: `func(out result int32) bool` for a named-slot variant, `func(out int32) bool` for the anonymous variant.

### 13. Migration and back-compat

- **Encoding-bug fix.** As part of this ADR's emit work, `EncodeTypeSymbol` (`ReflectionMetadataEmitter.cs:10202`) and `EncodeClrType` (line 10397) gain explicit `ByRefTypeSymbol` / `Type.IsByRef` branches that route through the encoder's existing `isByRef: true` overload. The user-function emit path at line 5685 picks up the fix transparently. This removes the runtime `TypeLoadException` that Context §3 documents. No existing test exercises this path (because nothing using it ever loaded), so there is no behavioral regression — the change converts an empirically-unreachable failure into an empirically-unreachable code path now governed by GS0238.
- **Assignment-LHS gap.** The parser is taught to accept a `BoundDereferenceExpression` (i.e. `*p`) on the left-hand side of an assignment, producing a `BoundIndirectAssignmentExpression`. This is needed for ADR-0039's `*T` locals to be usable as targets (`*p = expr` must work), and is consumed by §5's parameter-body lowering even though the user-visible body does not show the `*`. The change is additive to the existing `BoundAssignmentExpression` family — current programs with a plain identifier or member-access LHS are unaffected.
- Existing programs that use ADR-0039's `&x` at a call site continue to compile and emit identical IL. No deprecation warning is emitted in V1.
- New code is **encouraged** to use the keyword form. The `&x` form remains available and is documented as the primitive for users who genuinely want to manipulate `*T` values explicitly (advanced scenarios, holding a managed pointer in a local for two consecutive uses, etc.). A future ADR may add an opt-in style warning that suggests the keyword form at call sites where it is available.
- Synthesized IL (async kickoff, iterator state-machines, awaiter plumbing) continues to use `BoundAddressOfExpression` directly. The rewriter passes never go through the keyword-form parser.
- No existing test should regress. The keyword form is additive parser surface; the bound-tree shape it produces is identical to today's `&x` shape for the call-site case. There are zero existing G# user-defined functions with by-ref parameters (Context §3 — the path is broken on emit), so the new GS0238 prohibition has no compilable corpus to break.

## Consequences

**Unlocked:**

- Idiomatic G# call sites for the entire Try-pattern surface: `if Int32.TryParse(s, out var n) { use(n) }`, `if dict.TryGetValue(key, out let value) { use(value) }`, `Enum.TryParse[Color](s, out var c)`. Issue #341 is resolved end-to-end.
- Idiomatic G# call sites for `ref` and `in` BCL APIs: `Interlocked.Increment(ref counter)`, `Volatile.Read(in field)`, `MemoryMarshal.GetReference(in span)`. Issue #342 is resolved end-to-end.
- G# libraries can *define* and *export* Try-pattern, ref-mutating, and readonly-by-reference APIs that C# consumers see as ordinary `ref`/`out`/`in` methods. G# becomes a peer producer of these patterns, not just a consumer.
- G# can implement imported interfaces that declare by-ref parameters (e.g. custom `IDictionary[K, V]` implementations with their `TryGetValue` shape), closing a longstanding interop hole.
- Override and interface-implementation matching gains a sharp diagnostic (GS0235) that catches a class of CLR-rejection-at-load-time bugs at compile time.
- Documentation comments and IDE hover render the ref-kind explicitly, improving discoverability.

**New failure modes / required diagnostics:**

- Call sites that previously worked with `&x` against a `ref`/`out`/`in` parameter still work; new call sites that mix the modifier with a non-lvalue payload produce GS0230. The "must be lvalue" diagnostic remains GS9001 for the underlying `&x` and is reused (via the same lvalue classifier) for the keyword form.
- Users writing G# functions with `out` parameters must satisfy the new definite-assignment rule on every return path (GS0233). This is strictly correct behavior; the diagnostic mirrors the existing C# rule.
- The deliberate refusal to silently spill values at `in` argument positions (GS0237 warning) is a divergence from C#. The rationale is that G# values the explicitness of cost; users who want the spill can write `let temp = expr` then `in temp`.

**Foreclosed:**

- `ref` returns from G# functions (`func foo() ref int32 { return ref x }`). Not addressed in this ADR; remains a follow-up gated on ref-safe-to-escape per ADR-0058.
- `ref` local variables outside the existing `*T` form. Not addressed; users who want a managed-pointer local continue to use `var p *int32 = &x` per ADR-0039.
- `params` / variadic `ref`/`out`/`in` parameters. Rejected by GS0236 at parse/bind time and not on any roadmap (the CLR has no array-of-byref encoding).
- Conditional ref-passing (`f(ok ? ref x : ref y)`). The ternary form requires both branches to produce the same lvalue *category*, which is a meaningful escape-analysis question; deferred until there is concrete demand.

**Other ADRs constrained:**

- A future ADR introducing `ref` returns must compose with §5's body lowering: the `BoundIndirectAssignmentExpression` shape extends naturally to `BoundRefReturnStatement`.
- A future relaxation of GS0237 (auto-spill at `in` argument positions) would convert the warning into a silent compiler-inserted temp; it should preserve the *option* to opt back in to strict mode via a package-level pragma.
- The `customize` partial-class support (multi-package emit, ADR-0028) must propagate `ParameterSymbol.RefKind` across partial declarations and surface a mismatch diagnostic if two partial declarations disagree on the modifier.

## Alternatives considered

### A. Keep `&x` only — do not introduce `ref`/`out`/`in` keywords at call sites

Address #341 / #342 purely by improving ADR-0039: relax the lvalue rule for `out`-parameter `&x` arguments to allow `&var n` as an inline-declaring form; ship better diagnostics; document the existing path.

**Pros.** Zero new parser surface. One uniform address-of operator. The shortest path to "feature complete."
**Cons.** Loses the per-call-site distinction between read / write / read-only intent, which is precisely what issue #341 calls out implicitly (the issue's example sketches `out var n`, not `&var n`). Forecloses user-defined `ref`/`out`/`in` parameter declarations entirely — there is no obvious syntax for "this parameter is `ref` in the CLR signature" in a Go-style language without introducing a keyword somewhere. And `&var n` is structurally weird: `&` is an *operator* on an lvalue, so making it a declarator-binding form requires special-casing the parser at exactly the position where it should be simplest.

**Rejected** because it answers only half of the user's request (call sites) and provides no path for the definition-side gap that issues #341 / #342 together imply.

### B. Adopt C#'s call-site syntax exactly, including silent spill at `in` and optional modifier elision

Match C#'s rules: `out`/`ref` mandatory, `in` optional (compiler-inserted temp when omitted), `out var` for inline binding. Keep `&x` only for the synthesized async-emit path.

**Pros.** Familiar to every .NET developer. Maximizes muscle-memory portability between C# and G# codebases.
**Cons.** The `in`-elision rule is a footgun in a Go-style language. It silently inserts a copy at the call site — exactly the kind of hidden cost Go's design (and G#'s heritage) was built to avoid. A user reading `Consume(big)` cannot tell whether `big` is being copied (call-by-value), passed by readonly reference (call-by-`in` with elision), or being moved (no semantics; Go doesn't have moves either, but the visual ambiguity is what concerns us).

**Rejected in its strongest form**; the chosen design takes C#'s call-site keyword shape *but* makes `in` mandatory at the call site (GS0237 warning today, promotable to error). This keeps the cost visible.

### C. Use `&x` for call sites, introduce a separate modifier syntax for definition sites only

Define G# functions with `func f(ref x int32)` etc., but at call sites continue to require `&x`. The parser would learn `ref`/`out`/`in` in parameter position only.

**Pros.** Smallest call-site change. Bound tree at the call site is unchanged.
**Cons.** Asymmetric: the user writes `ref` on the declaration side but `&` on the call side for the same parameter. The keyword `out` in particular cannot be honored at the call site (it's needed for `out var x`'s inline-binding payload), so the asymmetry would be especially visible for the Try-pattern. And the read-side ergonomics — what the issue actually asks for — are not improved.

**Rejected** because the user's framing explicitly requests "G#-flavored design to `in`, `out`, and `ref` parameters both at call sites and in method definitions," and asymmetry is exactly the failure mode to avoid.

### D. Pure-prefix `inout` / `inref` / `outref` neologisms, avoiding contextual-keyword overload of `in`/`out`

Coin a single new keyword family that does not collide with `in`/`out` from generic variance (ADR-0021) or `ref` from `ref struct` (ADR-0058).

**Pros.** No parser disambiguation needed — the keywords are unambiguously new.
**Cons.** The CLR concepts are *exactly* `in`, `out`, `ref`. Reusing the same three names — already established as contextual modifiers elsewhere in G# — is the simpler, more learnable choice. ADR-0021 and ADR-0058 set the precedent: contextual keywords are how G# handles overload of short identifiers, and the disambiguation cost is borne by the parser once.

**Rejected** in favor of reusing the established `in`/`out`/`ref` contextual identifiers.

### E. Fix the encoding bug and make `*T` parameters mean "CLR `ref`" implicitly

When the user writes `func bump(counter *int32)`, treat the parameter as `RefKind.Ref` automatically: fix `EncodeTypeSymbol` to emit `int32&`, fix the assignment-LHS parser to accept `*counter = expr`, and document `*T` as the Go-style spelling of a ref parameter. Keep `ref name T` from §2 as an alternative spelling for the same concept; `out` and `in` continue to require keywords because they need attribute metadata that `*T` cannot carry.

**Pros.** Honors ADR-0039's framing of `*T` as a first-class type and `&x` as the address-of operator. Familiar to anyone coming from Go (`func f(p *int)`). Smallest *delta* to ADR-0039.
**Cons (three, each independently dispositive).**
1. **Two surfaces for one concept.** `func f(ref counter int32)` and `func f(counter *int32)` would mean the same thing at the CLR level, splitting documentation, code-review guidance, and tooling between two equivalent forms. Every "should I use X or Y" question multiplies by two.
2. **Cannot express `out` or `in`.** A `*T` parameter is undifferentiated managed-pointer; there is no attribute slot or modreq on a *type* that can carry `[Out]` (definite-assignment contract) or `[In] + IsReadOnlyAttribute` (read-only contract). To express those, the user *must* fall back to the keyword form anyway — so the system already has the keyword surface; `*T` is a partial duplicate of `ref` only.
3. **Body ergonomics are bad.** A `*int32` parameter forces explicit `*counter` reads everywhere in the body, and (under a strict reading of ADR-0039) the lvalue-on-LHS assignment `*counter = expr` is a *new* parser feature this option requires. By contrast, the §2 design lets the body use plain `counter` for both reads and writes — symbol type `int32`, automatic indirection — which is the same shape a C# `ref int counter` parameter has. The Go-style spelling looks Go-like but reads worse than either the C# or G#-keyword equivalent.

Additionally, this option misleads via false familiarity: Go's `*T` parameter is a true pointer (nilable, comparable, reassignable, observable as a value), whereas CLR `T&` is a transient managed reference with stack-only semantics. Reusing Go's surface for fundamentally different semantics is exactly the "looks-like / is-not" footgun that ADR-0058 already pays the cost of regulating (`scoped`, RSTE rules). Adding a second instance of that pattern on a path where we have a fully-functional alternative seems unwise.

**Rejected.** Disallow `*T` as a parameter type entirely (GS0238) and have the keyword form be the only way to declare a by-ref parameter. `*T` retains its role as a local-variable type and as the result-type of `&x`. The "small *delta*" win of Option E is more than offset by the loss of one-way-to-do-it and the persistent need for the keyword form for `out` and `in` regardless.

### F. Remove `*T` and `&x` entirely; only keywords remain

The opposite extreme of Option E: deprecate ADR-0039's `*T` type and `&x` operator wherever they appear in user code. All by-ref operations are expressed via `ref`/`out`/`in` keywords; synthesized async/iterator code switches from `BoundAddressOfExpression` to an internal-only bound node not surfaced syntactically.

**Pros.** Single user-facing surface; no Go-vs-CLR semantic mismatch at all.
**Cons.** Loses the genuinely useful primitive: a `*T` local lets a user take an address once and use it for multiple subsequent operations, which `ref`/`out`/`in` keywords cannot express at all (they are *parameter modifiers*, not *expression operators*). The async / iterator synthesizers would need a parallel internal-only address representation, doubling the bound-tree surface for no user benefit. And ADR-0039 is `Accepted` and shipped; reversing it would require a separate ADR with strong justification.

**Rejected** because `*T` and `&x` carry their weight as the underlying primitive — Option E's mistake is exposing them where keywords are clearer, not their existence in principle.

## Follow-ups

- **`ref` returns.** A G# function returning `ref T` (managed-pointer return) requires escape-analysis integration per ADR-0058. Tracked separately.
- **`ref` locals beyond `*T`.** ✅ Implemented in issue #491: `let ref x = expr` / `var ref x = expr` binds `x` as an alias to an lvalue. The local's IL slot is `T&`; reads emit `ldloc; ldind.*`, writes `ldloc; value; stind.*`. Aliasing is rejected at top level, inside `async`/iterator functions, and as `const ref` (diagnostics GS0248–GS0250). Cross-function escape (ref returns / RSTE) is still tracked under "ref returns" above.
- **`in`-elision opt-in.** If GS0237 proves uniformly silenced by users mechanically adding `in`, a future ADR may revisit and either tighten (to error) or relax (with a compiler-inserted temp under an opt-in pragma). Today the design errs toward visible cost.
- **Conditional ref-passing.** `f(cond ? ref x : ref y)` and similar lvalue-ternary forms; a focused mini-ADR after ref-safe-to-escape's data-flow tracker is mature.
- **`scoped ref` / `scoped out` / `scoped in` parameters.** §2 admits `scoped ref` syntactically; ADR-0058 specifies the enforcement for `scoped` on `*T`. The full propagation matrix for the keyword-form ref-kind parameters needs a follow-up test-pass once §11's diagnostics are wired up.
- **Coverage matrix.** New `BoundNodeKind` entries (e.g. `BoundOutDeclarationStatement`, `BoundIndirectAssignmentExpression` if not already present) and any new `SyntaxKind` entries must be added to both `test/Core.Tests/CoverageMatrix/coverage-matrix.golden.txt` and `docs/coverage-matrix.md` in the same change that introduces them.
- **Diagnostics documentation.** GS0230 through GS0238 must be added to `docs/diagnostics.md` in the implementing change; each gets a one-section entry with cause / fix / example, matching the existing format. GS0238 in particular should include the before/after snippet showing the `*T` → `ref name T` rewrite.
- **Named-argument + ref-kind composition.** V1 rejects `name = ref x`; a follow-up should evaluate whether `name = ref x` (or equivalently `ref name = x`) is wanted for call-site readability when the callee has many parameters.
- **Tooling.** The language server (vscode-gsharp) needs completion-list entries for `ref`/`out`/`in` at argument and parameter positions, signature-help rendering of ref-kinds, and quick-fix to insert a missing modifier when GS0230 fires.
