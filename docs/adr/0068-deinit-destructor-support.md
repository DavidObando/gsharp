# ADR-0068: `deinit` destructor support for classes

- **Status**: Accepted
- **Date**: 2026-06-11
- **Phase**: Phase 9 — language depth / class destruction
- **Related**: ADR-0003 (OO surface), ADR-0017 (method virtuality / `open`), ADR-0065 (class initializers and base invocation), ADR-0067 (fields require `var`/`let`), issue [#698](https://github.com/DavidObando/gsharp/issues/698)

## Context

G# already provides `init` (ADR-0065) for the construction half of an object's lifecycle: a class declares one or more `init(...)` constructors with Swift-style syntax, and the emitter materialises each as a CLR `.ctor` that chains to a base constructor. The destruction half — non-deterministic cleanup when an instance becomes unreachable and the garbage collector runs the finalizer — has no language surface today. Users wanting to release unmanaged resources owned by a class instance (file handles, native pointers, GC-unaware OS objects) must either hand-write a `func Finalize()` method (which the runtime does not honor because there is no `MethodAttributes.Virtual` / no override slot wiring), reach for `IDisposable` only (which only covers deterministic cleanup), or fall through to OS-level resource leaks when neither path is taken.

The issue asks for the natural Swift-inspired counterpart of `init` — a `deinit` member — that the compiler lowers to a CLR finalizer with the exact shape the C# compiler emits for a `~Type()` destructor. That gives G# users a one-keyword affordance for unmanaged-resource cleanup and unlocks the standard C#-style dispose pattern (a class that implements `IDisposable.Dispose` for deterministic cleanup AND declares a `deinit` as a finalizer safety-net).

## Decision

G# adopts a Swift-syntax / C#-mechanics `deinit` member declared inside a `class` body. It is lowered by the emitter to a protected, virtual, overriding `Finalize` method whose body is wrapped in `try { … } finally { base.Finalize(); }`, byte-for-byte identical to the IL the C# compiler emits for `~Type() { … }`.

### Syntax

A class body may contain at most one `deinit` member. The grammar is intentionally minimal — exactly mirroring Swift:

```ebnf
deinit_declaration = "deinit" block
```

There is no name, no parameter list, no return type, no accessibility modifier, no `open`/`override`/`async` modifier, and no `: base()` clause. The body is a regular G# block and binds with `this` and every instance member of the class in scope, exactly like an `init` body.

```gs
type Resource class {
    var handle int32 = 0

    init(h int32) {
        handle = h
    }

    deinit {
        // run on GC finalization
        ReleaseHandle(handle)
    }
}
```

Per ADR-0067, the field declarations above use the mandatory `var` keyword.

### Mechanics

For each class that declares a `deinit`, the emitter synthesises one extra method on the type:

- **Name**: `Finalize`
- **Signature**: `instance void Finalize()` — no parameters, void return
- **Attributes**: `MethodAttributes.Family | MethodAttributes.Virtual | MethodAttributes.HideBySig` (no `NewSlot` — the method reuses `System.Object::Finalize`'s slot)
- **Body** (matches C# `~Type()` exactly):

  ```
  .try
  {
      <lowered deinit body>
      leave.s END
  }
  finally
  {
      ldarg.0
      call instance void [System.Runtime]System.Object::Finalize()
      endfinally
  }
END:
  ret
  ```

The wrapping `try { … } finally { base.Finalize(); }` is **not** authored by the user — the emitter always wraps the user's body, exactly as the C# compiler does. This guarantees that the finalizer chain runs even if the user's body throws, and that derived deinits chain back up to the most-derived base `Finalize` (and ultimately to `System.Object::Finalize`, a no-op).

The runtime walks the finalizer chain naturally: when a `Derived` instance is reclaimed, the GC invokes `Derived.Finalize()`, whose own `finally` calls `Base.Finalize()`, whose own `finally` calls the next level up, and so on. Each derived class's `deinit` therefore produces its own override of `Finalize`, never an explicit `MethodImpl` row — the slot is inherited from `System.Object`.

### Where `deinit` is allowed

- `type X class { deinit { … } }` — allowed (canonical case).
- `type X open class { deinit { … } }` — allowed; the deinit still emits as an override of `Finalize` and runs whether the instance is `X` or any subclass.
- `type X class : Base { deinit { … } }` — allowed even when `Base` has its own `deinit`. The two are independent overrides of `Finalize`; the chain is established by the `finally` of each derived class calling `base.Finalize()`.

### Where `deinit` is forbidden

- **Structs** — including `data struct`, `inline struct`, and `ref struct`. The CLR does not run finalizers for value types; the compiler reports **GS0289** at the `deinit` keyword. Parser-level recovery still consumes the body so subsequent members are checked.
- **Interfaces and enums** — neither carries instance state nor participates in the CLR finalizer chain; the parser rejects `deinit` in those bodies as an unexpected token.
- **More than one `deinit` per class** — the second and subsequent occurrences report **GS0290** at the duplicate `deinit` keyword. Only the first declaration produces an emitted `Finalize`; the rest are diagnostic-only.

### What a `deinit` body may not do

- **Declare parameters** — `deinit(x int32) { … }` is a parser-level error. The parser surfaces an unexpected `(` and recovers by skipping the parenthesised section.
- **Declare a return type** — `deinit int32 { … }` is a parser-level error. The parser expects `{` immediately after `deinit`.
- **Carry an accessibility modifier** — `public deinit { … }`, `private deinit { … }`, etc. are parser-level errors. The CLR mandates that `Finalize` be `Family` (`protected`); G# does not surface that level of CLR ceremony to the user.
- **Carry an `open`, `override`, or `async` modifier** — the emitter always emits `Finalize` as `Virtual | !NewSlot` (i.e. an override), so the user has nothing meaningful to opt into. Surplus modifiers are diagnosed as unexpected tokens.
- **Return a value** — `return <expr>` inside a `deinit` body is a binder-level error because the synthesized `Finalize` has a `void` return type. The standard return-type-mismatch diagnostic applies.

### Interaction with `IDisposable`

`deinit` is independent of `IDisposable`. A class that owns unmanaged resources should typically implement *both* (the standard C# dispose pattern):

- `Dispose()` for the deterministic, user-driven cleanup path.
- `deinit { … }` for the GC-driven safety net when `Dispose()` was never called.

The compiler does **not** auto-generate either side of this pattern. It does not synthesise a `Dispose` method when a class declares `deinit`, and it does not synthesise `GC.SuppressFinalize(this)` calls anywhere; users wire those manually exactly as in C#. A class is free to declare just `deinit` (no `Dispose`), just `Dispose` (no `deinit`), or both — the language places no constraint on the combination.

### Calling `deinit` explicitly

The `deinit` member is not a callable name. There is no `obj.deinit()`, no `this.deinit()`, and no `init(args)`-style delegation form. The synthesized `Finalize` method exists in metadata so the CLR runtime can invoke it, but the user-facing G# binder does not surface `deinit` as a member lookup name. Attempting `obj.deinit()` produces the standard "member not found" diagnostic.

## Considered alternatives

- **C#-style `~Type()` syntax** — rejected. The G# member-introducer convention (ADR-0067) is "every member kind is announced by a one-token keyword" (`var`, `let`, `func`, `prop`, `event`, `init`). A leading `~` would be the only operator-introduced member in the language and would break that pattern just to save four characters.
- **`finalize` instead of `deinit`** — rejected. The CLR uses `Finalize` as the runtime method name, but the user-facing keyword should match the rest of G#'s Swift-aligned class surface (`init`/`deinit`) rather than a CLR-implementation noun.
- **Attribute-only marking** — rejected. Marking an ordinary method `func Finalize()` with an attribute would require careful slot wiring, would not give the user the always-applied `try/finally` chain to `base.Finalize()`, and would let users author finalizers with signatures the runtime ignores.
- **No support; require explicit `Finalize` override** — rejected. There is no way for a user to write a real `Finalize` override in G# today (no `Override` of an inherited non-virtual CLR method, no `MethodAttributes.Family` exposure), and the issue explicitly asks for first-class support similar to `init`.
- **Implicit `IDisposable.Dispose` synthesis** — rejected. The dispose pattern requires class-author decisions (which fields are managed, which are not, whether `SuppressFinalize` is appropriate, etc.) that the compiler cannot infer. Conflating `deinit` with `Dispose` would either over-generate or under-generate cleanup code; keeping them orthogonal lets each carry its own intent.
- **Multiple `deinit` overloads (mirror ADR-0063 §9)** — rejected. A class instance is finalized at most once by the GC; there is no overload-resolution context for picking between competing destructors. The decision diverges intentionally from `init` here.

## Migration impact

Purely additive. No existing G# code is rejected — `deinit` was not previously a contextual keyword in any context that could conflict with this new usage (it never appeared as an identifier in any existing sample, fixture, or doc snippet). Classes that do not declare a `deinit` continue to emit identically to before.

## Diagnostics

Two new diagnostics are allocated:

- **GS0289** — `"'deinit' is only valid on a class type — '{typeName}' is a {kind}."` Reported at the `deinit` keyword location when the enclosing type is a `struct`, `data struct`, `inline struct`, or `ref struct`.
- **GS0290** — `"Class '{className}' declares more than one 'deinit'; only the first declaration emits a finalizer."` Reported at the second (and any subsequent) `deinit` keyword in a single class body.

## Implementation notes

- **Syntax**: a new `DeinitDeclarationSyntax` (`SyntaxKind.DeinitDeclaration`) holds the `DeinitKeyword` token and the body `BlockStatementSyntax`. `StructDeclarationSyntax` gains a `Deinitializer` slot (single nullable node). `Parser.ParseStructDeclaration` recognises the `deinit` contextual identifier at the same point it dispatches on `init`/`prop`/`event`/`func`/`shared`, calls `ParseDeinitDeclaration` to consume the keyword and the block, and attaches the result to the struct declaration. The dispatcher rejects accessibility/`open`/`override`/`async` modifiers preceding `deinit`, rejects a trailing parameter list, and reports GS0290 on the second declaration.
- **Symbol**: a new `DeinitSymbol` (paralleling `ConstructorSymbol`) wraps a synthesized `FunctionSymbol` named `Finalize` (no params, `void` return, `receiverType = the class`) and the declaring syntax. `StructSymbol` gains a `Deinitializer` property and a `SetDeinitializer` method.
- **Binder**: `DeclarationBinder.BindDeinitDeclaration` is invoked from `BindStructDeclaration` immediately after `BindConstructorDeclarations`. It enforces "class only" (GS0289), constructs the synthesized `Finalize` function symbol, and stores it on the struct symbol. `Binder.BindProgram` binds the deinit body the same way it binds `init` bodies — a new `Binder` rooted at the synthesized function, `StatementBinder.BindStatement` over the body, `Lowerer.Lower` over the result, and an entry in `functionBodies` keyed by the synthesized `FunctionSymbol`.
- **Emit**: `ReflectionMetadataEmitter` reserves one extra method row per class with a `deinit` (alongside the existing ctor and method rows), then in Phase B2 invokes `TypeDefEmitter.EmitClassDeinitializer` which emits a `Finalize` method with `Family | Virtual | HideBySig`, a void/no-arg signature, and a body that wraps the lowered user block in a `try { … } finally { ldarg.0; call object::Finalize(); endfinally }` exception region. The `MemberRef` for `System.Object::Finalize` is registered in `WellKnownReferences`. The user body is emitted through the same `MethodBodyEmitter` plumbing as a regular method body (so locals, labels, closures, sequence points, and PDB metadata all flow correctly).
- **Bound tree**: no new `BoundNodeKind` is introduced. The deinit body is just a regular `BoundBlockStatement`; the `try { … } finally { base.Finalize(); }` wrapping is emitted directly in IL by the emitter, mirroring how `EmitClassConstructorWithBody` directly emits the base-call prelude. The four bound-node exhaustiveness allowlists (`EmitExpression`, `EmitStatement`, `BoundTreeRewriter`, `SpillSequenceSpiller`) require no updates.

## Status

Accepted; implemented in the same PR as this ADR.
