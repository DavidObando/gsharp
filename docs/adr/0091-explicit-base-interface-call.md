# ADR-0091: Explicit-base interface call syntax (`base[IFoo].M(...)`)

- **Status**: Accepted
- **Date**: 2026-06-12
- **Phase**: Phase 3.B.4 follow-up (interfaces); deferred-work item from ADR-0085.
- **Related**: ADR-0085 (DIM minimal-scope, supersedes ADR-0018), ADR-0089 (static-virtual interface members), ADR-0090 (private interface helper methods), ADR-0018 (interface defaults, historical), ADR-0017 (method virtuality). Issue #757 (this ADR), parent #706, sibling #755 (ADR-0089), #756 (ADR-0090), #726 (ADR-0085 DIM).

## Context

ADR-0085 introduced default-interface methods (DIM). When a class implements two unrelated interfaces `I1` and `I2` that both supply a default body for the same method `M`, ADR-0085 requires the implementer to declare its own `override func M(...)` to disambiguate (diagnostic **GS0318**). Two deliberate gaps were left open in that PR:

1. Inside the implementer's override, the only way to reuse one of the inherited default bodies was to **copy it inline** — there was no in-language syntax for "delegate to one of the interface defaults specifically." ADR-0085 explicitly named this as deferred:
   > Explicit-base default call syntax (`base<IFoo>.M()` or `IFoo.M(this)`) — Deferred. Not required to satisfy GS0318: the implementer can replicate the body inline. A dedicated syntax is more useful once we have at least one observed user request for "call default *and* augment it".
2. The same shape is independently useful for "override the default *and* extend it" — a class that wants `Describe()` to add a prefix before calling the interface's default body. Without explicit-base, the only way to express this was to copy the entire inherited body verbatim and prepend the new prefix.

Issue #757 asks for the deferred shape. The CLR has supported a non-virtual `call` against an interface's `MethodDef` (i.e. into the interface's default body, bypassing the runtime virtual-dispatch table) since DIM landed in .NET Core 3 / C# 8. G# already targets `net10.0` (`global.json` pins SDK `10.0.300`), so the underlying CLR mechanism is universally available.

ADR-0090 (private interface helpers, issue #756) is **orthogonal** to this ADR — private helpers are not visible to implementers and therefore are intentionally **not** reachable through `base[IFoo]` (see "Visibility" below).

ADR-0089 (static-virtual interface members, issue #755) is also orthogonal. `base[IFoo].M()` is an instance-call shape that loads `this`; the static-virtual flavour is dispatched through the existing `BoundConstrainedStaticCallExpression` path with a type-parameter receiver and does not need a parallel `base[IFoo]::StaticMethod()` form. A future static-side syntax can be designed independently; this ADR's scope is instance methods only.

## Decision

GSharp accepts **`base[IFoo].M(args)`** as a primary expression inside any instance member of a class (or struct) that implements `IFoo`. The call evaluates the named interface's default body directly, without re-dispatching through the implementer's v-table.

### Surface

```gs
package GSharp.Samples.InterfaceDiamondDisambiguation

import System

interface IGreeter {
    func Greet() string {
        return "hello from IGreeter"
    }
}

interface IFarewell {
    func Greet() string {
        return "goodbye from IFarewell"
    }
}

class Polite : IGreeter, IFarewell {
    // Diamond: both IGreeter.Greet() and IFarewell.Greet() have defaults.
    // ADR-0085 requires the implementer to disambiguate by declaring an
    // override; ADR-0091 lets the override delegate to either base.
    override func Greet() string {
        return "$(base[IGreeter].Greet()) and $(base[IFarewell].Greet())"
    }
}
```

Three things are happening here:

1. **`base`** is a contextual keyword that introduces an *explicit-base* receiver. It is only recognized as a keyword when immediately followed by `[`; in every other position it remains an ordinary identifier (the existing `init(args) : base(args)` constructor form is unaffected).
2. **`[IFoo]`** names the specific interface whose default body should be invoked. The square brackets reuse G#'s existing type-clause bracket shape (ADR-0020 generic call sites already use `[T1, T2]` after an identifier); `base` is the disambiguator that tells the parser the brackets refer to an interface selector rather than an indexer expression.
3. **`.M(args)`** is the call. The binder looks up `M` on the *declaring* `IFoo` interface, verifies that:
   - `IFoo` is in the enclosing type's implemented-interface set,
   - `M` is declared on `IFoo`,
   - `M` carries a default body on `IFoo` (it is not `abstract`),
   - `M` is **not** a `private` helper (ADR-0090 — see "Visibility" below).

### Why `base` (not a sigil or `IFoo.M(this)`)

Three alternatives were considered:

- **`IFoo.M(this)`** (extension-style). Rejected: this is the shape ADR-0085 called out as a possibility, but it conflates two unrelated concepts — extension-function form (`Receiver.Method(args)` sugar for `Method(this, args)`) and explicit-interface dispatch. It also requires every interface method body to be re-bindable as a free function, which contradicts ADR-0019's deliberate "extensions are syntactic sugar over `func`-receiver" framing.
- **`base<IFoo>.M()`** (C#-style). Rejected: G# does not use `<...>` for type arguments anywhere; the existing generic-call shape is `Identifier[T1, T2](...)` (ADR-0020). Introducing `<...>` solely for this one shape would be inconsistent with every other type-argument site in the language.
- **`base.IFoo::M()`** (CLR-style `::`). Rejected: the `::` token does not exist in the G# lexer and adding it for a single feature is gratuitous.

The selected `base[IFoo].M(args)` shape:

- Reuses the **existing** `[T]` bracket form for the interface selector.
- Disambiguates with the **existing** `base` lexeme (already known to the lexer because of the `init : base(args)` constructor form).
- Composes cleanly with the existing postfix `.M(args)` call shape — the parser builds a dedicated `BaseInterfaceCallExpressionSyntax` node so the binder has full structural context.

### Grammar

The grammar adds one production:

```
BaseInterfaceCallExpression :=
    'base' '[' TypeClause ']' '.' Identifier [ '[' TypeArgumentList ']' ] '(' ArgumentList ')'
```

The parser commits to this shape when `Current.Text == "base"` AND `Peek(1).Kind == OpenSquareBracket`. In every other position `base` continues to lex as `IdentifierToken` with no special meaning, so:

- `var base = 5` continues to be a valid variable declaration (`base` is still a legal identifier).
- `init(args) : base(args)` (ADR-0010 / issue #306 constructor delegation) is unaffected — the look-ahead disambiguator on `[` does not fire on `(`.
- `base.M()` (no `[`) parses as before, i.e. as `NameExpression("base").M()`, but the binder now intercepts this shape (issue #986) when `base` is not a real in-scope variable: it resolves `M` against the enclosing class's base chain and binds a `BoundBaseClassCallExpression` that emits a non-virtual base-class call. A hypothetical `var base = …` still shadows the keyword and takes precedence; if there is no base class or no such member the binder reports GS0383/GS0384 instead of the old "name 'base' not in scope" diagnostic.

The optional `'[' TypeArgumentList ']'` after the method identifier is reserved for a future extension to call generic interface methods (`base[IFoo].Map[int]()`); it is parsed but currently rejected by the binder with a "generic methods on explicit-base calls are not supported yet" diagnostic if the user supplies type arguments. The scope of this ADR is non-generic instance methods.

### Binder

The binder produces a new bound node:

```cs
public sealed class BoundBaseInterfaceCallExpression : BoundExpression {
    public BoundExpression Receiver { get; }      // synthetic implicit `this`
    public InterfaceSymbol Interface { get; }     // the IFoo named in base[IFoo]
    public FunctionSymbol Method { get; }         // IFoo's default body
    public ImmutableArray<BoundExpression> Arguments { get; }
}
```

Binding rules:

1. The enclosing function context must be an **instance** member of a class or struct. A call from a top-level function, a `shared { ... }` static, or a CLR-imported call site is rejected with **GS0338** (see "Diagnostics" below).
2. The named interface `IFoo` must resolve in the enclosing function's lexical scope. Resolution failure surfaces the existing "type not found" channel (GS0046); no new diagnostic is required.
3. `IFoo` must appear in `EnclosingType.Interfaces` (the bound interface set populated by `DeclarationBinder`). When it does not, **GS0338** fires.
4. `IFoo` must declare a method named `M` whose signature matches the call site. When `M` does not exist on `IFoo`, **GS0339** fires.
5. `M` must have a **default body** on `IFoo` (i.e. `InterfaceSymbol.HasDefaultBody(M)` is true). When `M` is abstract (no body), **GS0340** fires with a distinct message — the implementer must either supply its own body or delegate to a different interface that *does* provide a default.
6. `M` must **not** be `private` (ADR-0090). Private helpers are intentionally invisible to implementers; calling one through `base[IFoo]` would defeat the encapsulation that ADR-0090 just landed. **GS0341** fires when the user tries.

The receiver is synthesized as a `BoundVariableExpression` reading the enclosing method's `this` parameter. This matches the shape used by `BoundUserInstanceCallExpression` when the call site omits an explicit receiver (e.g. `Foo()` inside an instance method on a class that declares `Foo`).

### Emit (CLR)

The non-virtual `call` shape is the whole point of the feature:

```
ldarg.0
<arg1>
<arg2>
…
call instance R IFoo::M(T1, T2, …)
```

The receiver is `this` (the implementer); the call target is a `MemberRef` whose parent is the *interface's* `TypeDef` (not the implementer's). Because the opcode is `call` (not `callvirt`), the CLR JIT resolves the call statically to `IFoo::M`'s default body, **bypassing the v-table**. This is exactly the same instruction sequence `csc` produces for C# `base.M()` from inside a C# 8+ `override` that targets a DIM.

Implementation notes:

- `MetadataTokenCache.MethodHandles` already maps every interface method (including those with default bodies) to its `MethodDefinitionHandle`, so no new cache plumbing is needed.
- For a generic interface (`IList[T]`), the parent of the `MemberRef` is the *constructed* `TypeSpec` for `IFoo` (e.g. `IList<int32>`), not the open definition. The existing `ResolveInterfaceMethodToken` plumbing is reused unchanged.
- The IL verifier (`ilverify`) must accept the resulting library. ECMA-335 explicitly permits non-virtual `call` against a virtual method when the call site has a verifiable `this` of a type that implements the declaring interface — the shape here.

### Interpreter

The interpreter's `EvaluateBaseInterfaceCallExpression` is the simplest possible thing: it skips the virtual-dispatch walk that `EvaluateUserInstanceCallExpression` performs for interface methods and directly evaluates `program.Functions[node.Method]` with the receiver bound to the implementer's `this`. This matches the CLR semantics — the inherited default body runs without re-entering the implementer's override.

### Diagnostics

| ID | Severity | Trigger |
| --- | --- | --- |
| **GS0338** | Error | A `base[IFoo].M(...)` expression names an interface that is not in the enclosing type's implemented-interface set. Names the enclosing type and the missing interface. Also fires when the call appears outside any instance member (top-level function, shared block, etc.). |
| **GS0339** | Error | A `base[IFoo].M(...)` expression names a member `M` that does not exist on `IFoo`. Names the interface and the missing member. |
| **GS0340** | Error | A `base[IFoo].M(...)` expression names a member `M` that *is* declared on `IFoo` but is **abstract** (has no default body); there is nothing to delegate to. Recommends supplying a body or delegating to a different interface. |
| **GS0341** | Error | A `base[IFoo].M(...)` expression names a `private` helper on `IFoo`. ADR-0090 makes private helpers invisible to implementers; `base[IFoo]` does not bypass that restriction. |

GS0341 is intentionally distinct from GS0334 ("cannot access private interface member from outside the interface declaration"). The two report the same underlying restriction from different call-sites; emitting GS0334 from inside `base[IFoo]` would be confusing because the user is, syntactically, naming a member on an interface their type implements — they expect a different shape of diagnostic.

### Interaction with prior ADRs

- **ADR-0085 (DIM)** — this ADR is the deferred "explicit-base call" item ADR-0085 named. ADR-0085's diamond-conflict resolution (GS0318) still requires the implementer to declare an `override`; the override body may now use `base[IFoo].M(...)` instead of replicating the inherited body inline. The existing GS0318 message intentionally does **not** mention `base[IFoo]` so older tutorials remain accurate; the *fix-it* hint in the ADR-0091 docs links to this ADR.
- **ADR-0089 (static-virtual interface members)** — orthogonal. `base[IFoo]` is an instance-call shape; the static-virtual call shape (`T.M(...)` through a type-parameter receiver) is unchanged.
- **ADR-0090 (private interface helpers)** — `private` helpers are **not** reachable through `base[IFoo]` (GS0341). The ADR-0090 visibility model is preserved: a `private` helper is only callable from sibling members of the same interface declaration.
- **ADR-0018 (historical)** — superseded by ADR-0085; this ADR builds on the new foundation.

### What is **not** in scope

| Capability | Deferred? | Rationale |
| --- | --- | --- |
| `base[IFoo].Property` and `base[IFoo].Property = v` | Deferred | Interface properties (ADR-0051) currently dispatch through their getter/setter `MethodSymbol`s and the explicit-base call form for properties needs its own bind-time validation (read-only vs read/write). A follow-up issue tracks this. |
| `base[IFoo].Event += handler` | Deferred | Same reason as properties — interface events (ADR-0052) need their own explicit-base shape. |
| `base[IFoo].Method[T](...)` (generic interface methods) | Reserved | The parser accepts the syntactic shape (an optional `[TypeArguments]` after the method identifier) but the binder rejects it with a diagnostic until the explicit-generic-base-call shape is designed. |
| `base[BaseClass].M(...)` (class base, not interface) | **Implemented (issue #986)** | G# now supports calling a base **class**'s virtual member non-virtually via the plain `base.M(...)` form (the faithful C# mapping) and the bracketed `base[BaseClass].M(...)` form. Both bind to a `BoundBaseClassCallExpression` and emit `ldarg.0` + a non-virtual `call instance R BaseClass::M(...)`, walking the base chain so the nearest base implementation (including a grandparent's) is reached. Diagnostics GS0383–GS0385 cover misuse. This complements `base(args)` constructor chaining (ADR-0010). |
| Multi-step delegation: `base[IFoo].M(base[IBar].M())` | Works | The parser produces nested `BaseInterfaceCallExpressionSyntax` nodes and the binder/emitter handle them recursively — no special-case plumbing is needed. |

A non-conflicting override may also use `base[IFoo].M(...)` — the user may want to delegate to the inherited default and then add extra logic. ADR-0091 deliberately does **not** restrict the call to overrides that exist because of a GS0318 diamond; the binder only checks (a) the enclosing type implements `IFoo` and (b) `IFoo` has a default for `M`. This matches C#'s behavior and is the more useful surface.

## Consequences

Positive:

- ADR-0085's diamond-conflict resolution (GS0318) is now strictly more powerful: implementers can delegate to one inherited default instead of copying its body.
- "Override + augment" becomes a one-line pattern: `override func M() T { return base[IFoo].M() + ", augmented" }`.
- Cross-language interop: the explicit-base form emits a normal non-virtual `call` instruction, so C# consumers using ILDASM / decompilers see the same shape that `csc` would emit for `base.M()` in an override of a DIM.

Negative:

- `base` is now syntactically reserved when followed by `[`. This is a *contextual* restriction (a user can still declare `var base = 5`), but a user who writes `myArray = base[0]` thinking they are indexing a local named `base` now hits the new BaseInterfaceCallExpression parser path. Mitigated: the binder fires GS0338 with a clear message ("'base[...]' requires the enclosing type to implement an interface; consider renaming the local"); the diagnostic message names this ADR as a pointer.
- The diagnostic count grows by four (GS0338–GS0341). All four are documented in `website/docs/ref/diagnostics.md` and cross-linked here.

Neutral:

- No CLR feature is depended on that is not already used by ADR-0085. The new instruction shape (`call instance` into the interface `TypeDef`) is the same one `csc` produces today; ilverify continues to pass.
- No interaction with closures, async, iterators, or any other lowering pass. `BoundBaseInterfaceCallExpression` participates in `BoundTreeRewriter` / `BoundTreeWalker` / `BoundNodePrinter` / `SpillSequenceSpiller` in the same shape as `BoundUserInstanceCallExpression`.

## Alternatives considered

- **Pick the C# "most-specific override wins" diamond rule instead.** Rejected for the same reasons ADR-0085 rejected it: the rule is hard to teach, depends on a notion of "specificity" we have not yet introduced anywhere else, and silently picks a winner the user may not intend. ADR-0091 keeps the ADR-0085 rule (always require an explicit override) and *adds* a way to express the override's body concisely.
- **Make `base[IFoo]` legal as a standalone receiver expression** (so the user could write `let g = base[IFoo]; g.M(); g.N()`). Rejected: `base[IFoo]` does not denote a runtime value — there is no `IFoo`-typed reference that, when called, bypasses virtual dispatch. The semantics live entirely at the call site (the choice of `call` vs `callvirt`). Splitting the receiver from the call would require the binder to track "I am a non-virtual interface receiver" through arbitrary expression chains; the dedicated call form is strictly simpler.
- **Reuse the existing `AccessorExpressionSyntax` shape** (parse `base[IFoo]` as an `IndexExpressionSyntax` over a `NameExpression("base")` and recognize it post-parse). Rejected: the index-expression path expects an indexable receiver and the binder would have to special-case "the receiver happens to be the identifier 'base'." A dedicated syntax node keeps the parser, binder, printer, and exhaustiveness checks clean.

## Test surface

End-to-end coverage in this PR:

- **Parser** (`test/Core.Tests/CodeAnalysis/Syntax/ExplicitBaseInterfaceCallParserTests.cs`):
  - `base[IFoo].Method()` accepted as a primary expression.
  - `base[IFoo].Method(a, b)` accepted with arguments.
  - `base[IFoo].Method() + base[IBar].Method()` accepted (chains in a binary expression).
  - `base.Method()` (no brackets) continues to parse as `NameExpression("base").Method()` exactly as before.
  - `init(x int) : base(x) { ... }` (constructor) is unaffected.
- **Binder** (`test/Core.Tests/CodeAnalysis/Binding/ExplicitBaseInterfaceCallTests.cs`):
  - Diamond default conflict: implementer overrides `M`, delegates to `base[IFoo].M()` — binds clean.
  - `base[IBar].M()` where `IBar` is not in the enclosing type's interface set — GS0338.
  - `base[IFoo].NotAMember()` — GS0339.
  - `base[IFoo].Abstract()` (abstract member, no default body) — GS0340.
  - `base[IFoo].PrivateHelper()` — GS0341.
  - Call from a top-level `func` — GS0338.
  - Call from a `private` member of the implementing class — works.
- **Emit** (`test/Compiler.Tests/Emit/ExplicitBaseInterfaceCallEmitTests.cs`):
  - Compiles a diamond example, runs the resulting executable, asserts the printed output matches the expected string from delegating to each base.
  - Inspects the `MethodBodyBlock` for the override and asserts the IL stream contains `call` (not `callvirt`) targeting the interface `MethodDef`.
  - Passes `ilverify` on the output assembly.
- **Interpreter** (`test/Interpreter.Tests/ExplicitBaseInterfaceCallInterpreterTests.cs`):
  - Mirrors each of the emit tests; asserts the interpreted output matches the compiled output.
- **Sample** (`samples/InterfaceDiamondDisambiguation.gs` + `.golden`):
  - End-to-end demo, exercises the diamond + override + delegate flow.

The `samples/CoverageMatrix` golden and `docs/coverage-matrix.md` are refreshed with the new `BaseInterfaceCallExpression` `SyntaxKind` and `BoundNodeKind` entries.
