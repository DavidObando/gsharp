# ADR-0039: By-ref pointers (`&` / `*`) and CLR interop for `ref` / `out` / `in` parameters

- **Status**: Accepted
- **Date**: 2026-05-25
- **Phase**: Phase 7 follow-up — async emitter milestone (state-machine kickoff / MoveNext); also closes CLR interop gaps tracked since ADR-0034
- **Related**: ADR-0023 (async state machine), ADR-0034 (imported CLR interop), ADR-0035 (user operator overloads), ADR-0038 (generic method inference); async emitter plan (field-map, kickoff, MoveNext)

## Context

GSharp's async emitter must synthesize IL equivalent to the canonical Roslyn kickoff stub:

```csharp
<M>d__N sm;
sm.<>t__builder = AsyncTaskMethodBuilder<T>.Create();
sm.<>4__this   = this;
sm.<>3__p_i    = p_i;
sm.<>1__state  = -1;
sm.<>t__builder.Start(ref sm);          // Start<TStateMachine>(ref TStateMachine)
return sm.<>t__builder.Task;
```

The call `sm.<>t__builder.Start(ref sm)` requires:

1. A managed pointer to the local `sm` (IL: `ldloca`).
2. A method-spec for the constructed generic `Start<<M>d__N>` (already supported by `GetMethodEntityHandle` in `ReflectionMetadataEmitter.cs`).
3. The emitter infrastructure to know that argument 0 of `Start` is passed by-ref so the call site emits the address rather than the value.

The same gap blocks `MoveNext`'s `builder.AwaitOnCompleted(ref awaiter, ref this)` and `builder.AwaitUnsafeOnCompleted`, plus a wide class of user-facing BCL APIs: `int.TryParse(string, out int)`, `Interlocked.CompareExchange<T>(ref T, T, T)`, `Dictionary<K,V>.TryGetValue(K, out V)`, span-accepting APIs, and value-type instance methods whose receiver is implicitly `ref` at the IL level.

Today's bound tree (`BoundImportedInstanceCallExpression`, `BoundImportedCallExpression`, `BoundClrConstructorCallExpression`) carries only `ImmutableArray<BoundExpression> Arguments` with no per-argument `RefKind` annotation. The emitter handles value-type receivers via `EmitInstanceReceiver` (which calls `TryLoadVariableAddress` for the narrow case of a `BoundVariableExpression` receiver — see `ReflectionMetadataEmitter.cs` lines 5778–5811) but has no general "address-of expression" concept for arguments or for arbitrary lvalue shapes.

The syntax layer already reserves `StarToken` as a unary prefix (precedence 6, "dereference") and `AmpersandToken` as a unary prefix (precedence 6, "reference of") in `SyntaxFacts.GetUnaryOperatorPrecedence`. However, the binder currently rejects both when reached through `BoundUnaryOperator.Bind` because no entry in the `supportedOperators` array maps them. The grammar is thus prepared for these operators but they are unimplemented end-to-end.

## Decision

Introduce **managed by-ref pointers** as a first-class concept in the bound tree, symbol system, and both backends (emitter and evaluator). Surface syntax follows Go conventions (`&x` for address-of, `*p` for dereference, `*T` for the pointer type). Unmanaged pointers and pointer arithmetic are explicitly out of scope (see §Follow-ups).

### 1. Surface syntax

```gsharp
// Calling a CLR method with ref/out parameters:
var ok = int.TryParse("42", &result)       // out parameter — pass address of `result`
Interlocked.CompareExchange(&counter, 1, 0) // ref parameter

// Explicit pointer local (rare in user code; common in synthesized async IL):
var p *int = &x
*p = 42
fmt.Println(*p)
```

**Grammar disambiguation.** `*` and `&` are already recognized at unary-prefix precedence 6 (higher than any binary precedence). The parser's existing `ParseBinaryExpression` loop resolves ambiguity: when `*` or `&` appears in prefix position (i.e. after an operator, `(`, `,`, `=`, `return`, `var`, or at statement start), it is a unary operator. In binary position (between two operands) it remains multiplication / bitwise-and respectively. This matches Go's rules exactly. In type-annotation position (`var p *int`, `func foo(x *int) ...`), the parser recognizes `*` followed by a type-name as a pointer-type syntax node — this is unambiguous because type annotations are syntactically distinct from expression contexts.

### 2. Type system: `ByRefTypeSymbol`

A new `ByRefTypeSymbol` wraps an existing `TypeSymbol` to represent the managed-pointer type `*T`:

```csharp
public sealed class ByRefTypeSymbol : TypeSymbol
{
    public ByRefTypeSymbol(TypeSymbol pointeeType)
        : base($"*{pointeeType.Name}", pointeeType.ClrType?.MakeByRefType())
    {
        PointeeType = pointeeType;
    }

    public TypeSymbol PointeeType { get; }
}
```

At CLR metadata level this maps to `ELEMENT_TYPE_BYREF` — it is a **managed reference**, not `ELEMENT_TYPE_PTR` (unmanaged pointer). The `ClrType` property uses `MakeByRefType()` which produces the correct metadata encoding. `ByRefTypeSymbol` instances are interned per pointee type to allow identity comparison.

The surface type `*T` is purely syntactic sugar for "managed pointer to T" and is semantically equivalent to C#'s `ref T` at a parameter or local level. No unmanaged pointer semantics (arithmetic, pinning, fixed) are implied.

### 3. Bound tree changes

#### 3a. `BoundAddressOfExpression`

New node representing `&expr`:

```csharp
public sealed class BoundAddressOfExpression : BoundExpression
{
    public BoundAddressOfExpression(BoundExpression operand)
    {
        Operand = operand;
        Type = new ByRefTypeSymbol(operand.Type);
    }

    public override BoundNodeKind Kind => BoundNodeKind.AddressOfExpression;
    public override TypeSymbol Type { get; }
    public BoundExpression Operand { get; }
}
```

The operand must be an **lvalue**: `BoundVariableExpression` (local or parameter), `BoundFieldAccessExpression` (instance or static field), `BoundIndexExpression` (array element), or `BoundClrPropertyAccessExpression` that maps to a field (not a property getter). The binder validates lvalue-ness and reports a diagnostic otherwise (see §6).

#### 3b. `BoundDereferenceExpression`

New node representing `*expr`:

```csharp
public sealed class BoundDereferenceExpression : BoundExpression
{
    public BoundDereferenceExpression(BoundExpression operand)
    {
        Operand = operand;
        Type = ((ByRefTypeSymbol)operand.Type).PointeeType;
    }

    public override BoundNodeKind Kind => BoundNodeKind.DereferenceExpression;
    public override TypeSymbol Type { get; }
    public BoundExpression Operand { get; }
}
```

#### 3c. Per-argument `RefKind` on call expressions

Extend `BoundImportedCallExpression`, `BoundImportedInstanceCallExpression`, and `BoundClrConstructorCallExpression` with a parallel array:

```csharp
public ImmutableArray<RefKind> ArgumentRefKinds { get; }
```

Where `RefKind` is a new enum:

```csharp
public enum RefKind
{
    None,
    Ref,
    Out,
    In,
}
```

The binder populates `ArgumentRefKinds` by inspecting `ParameterInfo.IsOut`, `parameterType.IsByRef`, and the `[In]` attribute on each resolved parameter. When a parameter is `ref`/`out`, the binder requires the corresponding argument to be a `BoundAddressOfExpression` (i.e. the user wrote `&x`) — or, for the async synthesizer, the infrastructure can synthesize the node directly. `in` parameters accept either a `BoundAddressOfExpression` or a plain value (in which case the emitter takes the address of a temp copy, matching C#'s implicit-in semantics).

#### 3d. Receiver ref-kind for value-type instance calls

Rather than introducing a separate `ReceiverRefKind` property, the existing `EmitInstanceReceiver` logic is formalized: when the receiver's `ClrType.IsValueType` is true, the emitter **always** loads the receiver's address. The bound tree does not need an explicit annotation because the information is derivable from the receiver's type at emit time. This preserves backward compatibility with all existing value-type instance calls (which already follow this path via `TryLoadVariableAddress`).

For non-lvalue receivers (e.g. a method-call result used as receiver: `getBuilder().Start(ref sm)`), the emitter spills to a temp local and takes the address of the temp. The spill is inserted during emit, not during binding — matching how the existing `EmitFieldAccess` path already handles this case (see `ReflectionMetadataEmitter.cs` line 4983).

### 4. Binder rules

**Lvalue classification.** The binder classifies an expression as an lvalue if it is one of:

- `BoundVariableExpression` (local variable, parameter, or range variable)
- `BoundFieldAccessExpression` (instance or static field of a struct/class)
- `BoundIndexExpression` (array element access)
- `BoundDereferenceExpression` (dereferencing a pointer is itself an lvalue)

Attempting `&expr` on any other expression form (literal, method call result, property getter, binary expression, etc.) is a binder error.

**Implicit ref coercion at call sites.** When overload resolution (ADR-0034/0038) selects a method whose parameter `i` has `IsByRef == true`, the binder checks that argument `i` is wrapped in `BoundAddressOfExpression`. If the user forgot `&`, the binder reports "argument must be passed by reference with `&`" (see §6). This is a hard error, not a warning — matching Go's explicitness and differing from C# where `ref`/`out` keywords are required.

**`out` initialization.** For `out` parameters, the variable passed via `&` need not be definitely assigned before the call. After the call, the variable is considered definitely assigned. The binder tracks this through existing definite-assignment analysis (extending it to recognize `BoundAddressOfExpression` operands at `out` argument positions).

**Lifetime / escape.** V1 adopts a simple rule: **by-ref values cannot escape their declaring scope**. Concretely:

- A `ByRefTypeSymbol` local cannot be captured by a lambda or hoisted across an `await` point.
- A function cannot return a `ByRefTypeSymbol` value.
- A field of a class or struct cannot have `ByRefTypeSymbol` type.

These restrictions match C# 7.0's initial `ref local` rules before `ref struct` / `Span<T>` relaxations. Escape analysis (Roslyn's `ref-safe-to-escape` / `safe-to-escape` two-level system) is deferred to a follow-up.

### 5. Emitter mapping

| Lvalue shape | IL opcode for address-of |
|---|---|
| Local variable | `ldloca <slot>` |
| Parameter | `ldarga <index>` |
| Instance field of an lvalue receiver | `<load receiver address>` then `ldflda <field>` |
| Static field | `ldsflda <field>` |
| Array element | `<load array>` `<load index>` `ldelema <element-type>` |
| Temp spill (non-lvalue receiver) | `stloc <temp>` then `ldloca <temp>` |

The emitter handles `BoundAddressOfExpression` by pattern-matching its `Operand`:

```csharp
private void EmitAddressOf(BoundAddressOfExpression node)
{
    switch (node.Operand)
    {
        case BoundVariableExpression bve:
            if (!TryLoadVariableAddress(bve.Variable))
                throw new EmitException("Cannot take address of variable");
            break;
        case BoundFieldAccessExpression fa:
            EmitFieldAddress(fa);  // new helper: receiver address + ldflda
            break;
        case BoundIndexExpression idx:
            EmitExpression(idx.Target);   // array ref
            EmitExpression(idx.Index);    // index
            il.LoadElementAddress(...);   // ldelema
            break;
        // ...
    }
}
```

For call sites, the emitter inspects `ArgumentRefKinds[i]`:

- `RefKind.None` → emit value normally.
- `RefKind.Ref` or `RefKind.Out` → argument must be `BoundAddressOfExpression`; emit via `EmitAddressOf`.
- `RefKind.In` → if argument is `BoundAddressOfExpression`, emit address; otherwise emit value into a temp local, then `ldloca <temp>`.

The generic-method instantiation path (`GetMethodEntityHandle`) already handles `MethodSpec` encoding for constructed generics (e.g. `Start<<M>d__N>`). The by-ref parameter type is already encoded correctly via the existing `isByRef: true` path in `GetMethodReference` (see `ReflectionMetadataEmitter.cs` lines 2930–2945). No changes are needed to signature encoding.

### 6. Evaluator (interpreter) mapping

The evaluator uses `MethodInfo.Invoke(receiver, object[] args)`. For `ref`/`out` parameters, the CLR's reflection layer writes back modified values into the `object[]` after invocation. The evaluator must:

1. Before the call: evaluate each `BoundAddressOfExpression` operand to identify the **variable slot** (not just the value). Introduce a thin `EvaluatorRef` helper:

```csharp
private record struct EvaluatorRef(VariableSymbol Variable, Action<object> Setter);
```

2. Build the `object[]` using current values of ref'd variables.
3. Call `method.Invoke(receiver, args)`.
4. After the call: for each `ref`/`out` argument position, write-back `args[i]` into the variable via `variables[symbol] = args[i]`.

This matches how `EvaluateImportedInstanceCallExpression` (see `Evaluator.cs` line 1726) already builds the argument array, but adds the post-call write-back loop.

### 7. Diagnostics

| ID | Message | Trigger |
|---|---|---|
| GS9001 | Cannot take address of `{expr}`: expression is not an lvalue | `&` applied to a non-lvalue |
| GS9002 | Argument {n} to `{method}` must be passed by reference (`&`) | Missing `&` at a `ref`/`out` call site |
| GS9003 | Variable `{name}` must be definitely assigned before being passed by `ref` | Uninitialized variable at `ref` (not `out`) argument position |
| GS9004 | By-ref value cannot escape: cannot capture in lambda, return, or store in field | Lifetime violation |
| GS9005 | Cannot take address of a constant | `&` applied to a `const` binding |
| GS9006 | Pointer type `*T` cannot be used as a field type | `ByRefTypeSymbol` in a struct/class field |

### 8. Async emitter integration

With the above in place, the async kickoff emitter synthesizes:

```csharp
// Bound tree fragment for `sm.<>t__builder.Start(ref sm)`:
new BoundImportedInstanceCallExpression(
    receiver: new BoundFieldAccessExpression(smLocal, builderField),
    method: startMethodInfo.MakeGenericMethod(smType),
    returnType: TypeSymbol.Void,
    arguments: ImmutableArray.Create<BoundExpression>(
        new BoundAddressOfExpression(new BoundVariableExpression(smLocal))),
    argumentRefKinds: ImmutableArray.Create(RefKind.Ref))
```

The emitter produces:

```
ldloca sm          // receiver address (value-type instance method)
ldloca sm          // argument: ref sm
call instance void AsyncTaskMethodBuilder`1::Start<SM>(!!0&)
```

Similarly, `AwaitOnCompleted(ref awaiter, ref this)` in MoveNext uses two `BoundAddressOfExpression` arguments.

## Consequences

**Unlocked:**

- The async emitter can synthesize correct IL for `Start`, `AwaitOnCompleted`, `AwaitUnsafeOnCompleted`, `SetStateMachine`, and `SetResult` — removing the last blocking gap for the kickoff stub and MoveNext body.
- User code can call all BCL APIs that use `ref`/`out`/`in` parameters: `int.TryParse`, `Dictionary.TryGetValue`, `Interlocked.*`, `Monitor.TryEnter`, `Utf8JsonReader.TryRead`, etc.
- Value-type instance method calls become uniformly correct: the emitter no longer relies on ad-hoc pattern matching in `EmitInstanceReceiver`; the lvalue-address machinery is general.
- The `OverloadResolution` classifier (ADR-0034) can now correctly rank candidates with by-ref parameters, since `IsByRef` peeling in inference (ADR-0038 line "ByRef — peel the byref and recurse") has a matching bound-tree and type-symbol representation.

**New failure modes:**

- Users who call a `ref`/`out` API without `&` now get a hard error (previously the call simply failed to bind with "unable to find function" because by-ref overloads were filtered out by the resolver's `IsByRef` peeling — now they are candidates but require `&`).
- Escape-analysis diagnostics (GS9004) may surface in code that previously compiled only because by-ref locals were impossible to create. This is strictly correct behavior.

**Gated / not yet available:**

- Unmanaged pointers, `unsafe` blocks, pointer arithmetic.
- By-ref returns (`ref` return type on functions).
- `ref struct` / `Span<T>` as first-class types with lifetime tracking.
- Hoisting by-ref locals across `await` points (the async pipeline's `RefInitializationHoister` remains a separate work item).

**Existing test impact:**

- No existing tests should regress: `*` and `&` as unary operators are currently rejected by the binder (no entry in `BoundUnaryOperator.supportedOperators`), so no user code exercises them. The binary `*` (multiply) and binary `&` (bitwise-and) paths are untouched because disambiguation is handled by the parser's existing precedence rules.
- The `OverloadResolution` change (adding `ArgumentRefKinds` to call nodes) is additive — existing nodes default to an empty/all-`None` array.

## Alternatives considered

### A. Call-site-only `ref` with no surface pointer type

Support `ref` and `out` as keywords at call sites (`foo(ref x, out y)`) without introducing `*T` as a type or `&`/`*` as general operators. This is closer to C#'s surface.

**Pros:** Simpler type system (no `ByRefTypeSymbol`); no disambiguation concerns with `*`/`&`.
**Cons:** Breaks the Go flavor of the language — `ref`/`out` keywords are foreign to Go's syntax. Does not compose: you cannot store a managed pointer in a local (needed for the async emitter's `ref sm` pattern where the SM address is used twice). Requires special-case syntax rather than a composable type-and-operator system.

**Rejected** because the async emitter's synthesized code needs `ByRefTypeSymbol` as a first-class type anyway (to type the `ref sm` operand), and exposing it to users via `*T` aligns with the language's Go heritage.

### B. Roslyn-style dual model (`ref` keyword + `&` operator + pointer types)

Keep C#'s `ref`/`out`/`in` keywords at call sites **and** support `*T` / `&x` / `*p` as separate unsafe-pointer concepts.

**Pros:** Familiar to C# developers; separates managed-ref from unmanaged-pointer cleanly.
**Cons:** Two overlapping syntaxes for the same CLR concept (`ref T` and `*T` both map to `ELEMENT_TYPE_BYREF`). Confusing for a language that aims for Go's simplicity. Doubles the teaching surface.

**Rejected** in favor of a single unified syntax (`&`/`*`/`*T`) that maps to managed by-ref, with unmanaged pointers deferred to a future `unsafe` feature.

### C. Bypass the bound tree — emit raw IL for async kickoff

Hard-code the kickoff IL sequence in the async emitter without teaching the bound tree about by-ref.

**Pros:** Unblocks the async emitter immediately with zero language-design work.
**Cons:** Creates a maintenance trap — every future by-ref call site (AwaitOnCompleted, SetStateMachine, user TryParse calls, Interlocked) must be special-cased in the emitter. The evaluator gets no benefit (it still can't call `ref`/`out` APIs). Does not scale and creates an ever-growing list of emit hacks.

**Rejected** because the gap is pervasive (dozens of BCL APIs, not just async) and a principled solution pays for itself immediately.

## Follow-ups

- **Unmanaged pointers and `unsafe`.** A future ADR will introduce `ELEMENT_TYPE_PTR`, pointer arithmetic (`p + n`, `p++`), the `unsafe` block/function modifier, `fixed` statements, and stack-allocated buffers. These are orthogonal to managed by-ref and not needed for async or standard BCL interop.
- **By-ref returns.** `func foo() *int { return &x }` requires escape analysis to ensure the referent outlives the caller. Deferred until the `ref-safe-to-escape` model is fully specified.
- **`ref struct` / `Span<T>` lifetime.** Requires the two-level escape analysis from C# 11+ (`scoped`, `UnscopedRef`). Tracked as a Phase 8+ feature.
- **Async hoisting of ref locals (`RefInitializationHoister`).** The async state-machine rewriter must not hoist by-ref locals into fields (they're not valid field types). Instead, the rewriter must spill the referent and re-take the address after each resume point. This is a separate concern within the async emitter pipeline.
- **`in` parameter elision.** C# allows omitting `in` at call sites (the compiler takes a temp copy). GSharp V1 requires `&` even for `in` parameters for explicitness; a future relaxation may allow omitting it with a compiler-inserted copy.
- **Definite-assignment enhancements.** Extend the existing DA pass to track `out`-parameter assignments through conditional branches (e.g. `if ok { use(result) }` after `TryParse(&result)`).
