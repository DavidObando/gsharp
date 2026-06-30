# ADR-0059: Named delegate types — `type Name = delegate func(...)`

- **Status**: Accepted
- **Date**: 2026-06-05
- **Phase**: Phase 9 — language depth (post-primitive)
- **Related**: ADR-0052 (event declarations); ADR-0036 (event subscription); issue #255; issue #140

## Context

ADR-0052 introduced the `event` keyword for declaring CLR events on user types, but the ADR pragmatically restricted handler types to `Action<…>` / `Func<…>` (the same shape `func(…) R` already lowers to). ADR-0052 §Follow-up Work explicitly defers user-declared *named* delegate types to a later ADR. Issue #255 raises that follow-up: C# / F# consumers expect events to carry **named** delegate types (`EventHandler`, `PropertyChangedEventHandler`, etc.) — partly for self-documentation, partly because some BCL idioms (e.g. `INotifyPropertyChanged`) name their handler type as part of the contract.

GSharp already plays the delegate game on the consumption side. A `FunctionTypeSymbol` (`func(T1, T2) R`) is implicitly convertible to any compatible CLR delegate type — Action/Func/Predicate as well as named delegates imported from C# assemblies (`Conversion.cs:IsFunctionToDelegateConvertible`). What is missing is the *declaration* side: there is no GSharp syntax that emits a real CLR delegate class. This ADR fills the gap.

## Decision

Introduce a delegate-typed form of the `type` declaration. The grammar reuses the existing `type Name = …` alias surface and adds the contextual keyword **`delegate`** in front of a function-type clause:

```
delegate_declaration =
    annotations? accessibility_modifier? "type" identifier
    type_parameter_list? "=" "delegate" "func" "(" parameter_list? ")" type_clause?
```

A declaration of this form produces a new TypeDef in metadata: a `sealed class` whose base is `System.MulticastDelegate`, plus a `.ctor(object, IntPtr)` and an `Invoke(params...) ret` method, both flagged `MethodImplAttributes.Runtime | Managed` (no IL body — the CLR provides the implementation). The name is registered on the declaring package's scope just like a `struct`/`class`/`interface` so it can be used wherever a type clause is legal — including as the handler type for an `event`.

### Grammar examples

```gs
// Simple handler shape — emits a sealed MulticastDelegate-derived class.
public type ClickHandler = delegate func(sender Object, e EventArgs)

// Returning a value — same shape, with a return type.
type Mapper = delegate func(input string) int32
```

Generic delegate declarations (`type Predicate[T any] = delegate func(value T) bool`) are accepted by the parser but rejected by the binder in v1; they are listed as follow-up work below.

A function literal of a compatible shape converts implicitly to a named delegate:

```gs
var handler ClickHandler = func(sender Object, e EventArgs) {
    System.Console.WriteLine("clicked")
}
button.Click += handler
```

A named delegate may serve as an `event` handler type, replacing the previous `Action<…>` shape (ADR-0052 carve-out):

```gs
public type PropertyChangedHandler = delegate func(sender Object, e PropertyChangedEventArgs)

class Button {
    public event Changed PropertyChangedHandler
}
```

### Parameter naming

`func(...)`-shaped function types currently use anonymous positional parameters (the binder synthesises names `arg0`, `arg1`, …). For *named* delegates the parameter names matter to consumers — C# uses them in IntelliSense for `+=` handler tab-completion. The grammar therefore allows the same `name type` syntax used in `func` declarations:

```gs
public type MouseHandler = delegate func(sender Object, e MouseEventArgs)
```

When no name is provided the emitter falls back to `arg0`/`arg1`/…, matching what C# emits for unnamed delegate parameters.

### CLR metadata shape

For `public type ClickHandler = delegate func(sender Object, e EventArgs)`:

| Metadata row | Content |
|--------------|---------|
| TypeDef | `public sealed class ClickHandler` extends `System.MulticastDelegate` |
| MethodDef | `public hidebysig specialname rtspecialname instance void .ctor(object, native int)` with `methImpl = Runtime \| Managed`, no IL |
| MethodDef | `public hidebysig virtual newslot instance void Invoke(object sender, class [System.Runtime]System.EventArgs e)` with `methImpl = Runtime \| Managed`, no IL |

`BeginInvoke` / `EndInvoke` are intentionally *not* emitted; modern Roslyn omits them for portable assemblies and the CLR no longer requires them for delegate invocation. (Async UI patterns that historically relied on those methods have moved to `Task` / `Task<T>` since .NET 4.5.) Adding them later is a non-breaking change if a consumer asks.

### Conversion rules

1. A `FunctionTypeSymbol` value (a `func` literal or any variable typed `func(P) R`) implicitly converts to a named delegate when the shapes match, via the existing `IsFunctionToDelegateConvertible` path. The emitter materialises the conversion the same way it materialises `func → Action<…>` today (`func` value → delegate ctor).
2. Two *distinct* named delegates do **not** silently convert into each other, even when their shapes match. This mirrors CLR rules: `Action` and `ThreadStart` are unrelated even though both are `void()`. Going from one named delegate to another requires extracting the underlying function value (`var f func() = a; var b OtherDelegate = f`).
3. Any named-delegate value widens implicitly to `System.Delegate` and `System.MulticastDelegate`, identical to the existing rule for `Action`/`Func` (`Conversion.cs:IsSystemDelegateBaseType`).

### Why a separate `delegate` keyword

`type Name = func(…) R` could in principle re-mean "emit a CLR delegate." It does not, because the existing `type Name = SomeOtherName` alias surface is *erased* at bind time (ADR-0058's words: "Aliases are not emitted into CIL"). Adding emit semantics to plain `type Name = func(…)` would silently change the meaning of existing code and conflict with users who rely on alias erasure to give a domain-specific name to a function shape without paying for a TypeDef. The `delegate` keyword keeps the two cases visually and semantically distinct:

| Form | Meaning |
|------|---------|
| `type Handler = func(string) int32` | Type alias — `Handler` is `func(string) int32`, erased at emit, no new TypeDef. |
| `type Handler = delegate func(string) int32` | Delegate declaration — emits a sealed `MulticastDelegate`-derived TypeDef called `Handler`. |

### Why a contextual keyword

`delegate` is recognised by the parser only after `=` in a `type … =` declaration. Outside that position it remains a valid identifier. Treating it as a contextual keyword (a `Text == "delegate"` check on an `IdentifierToken`) avoids breaking any code that uses `delegate` as a variable, parameter, or member name.

### Interaction with events (ADR-0052)

ADR-0052 §1 said the event's `type_clause` "must resolve to a function type (`func(…) …`)." This ADR extends that to include named delegate types: an `event Name Handler` declaration may also bind a `Handler` that is a user-declared delegate type or an imported CLR delegate. Field-like events use the supplied delegate type directly as their backing-field type. Explicit-accessor events do the same. The synthesised `add_X` / `remove_X` accessors take a parameter of that delegate type. This is exactly what C# does.

## Alternatives considered

1. **Reuse the alias surface (`type Name = func(...)` emits a delegate).** Rejected — silently changes the meaning of existing aliases and breaks the "alias is erased" property documented in the type-alias syntax. The new keyword keeps both shapes addressable.

2. **`delegate Name(...)` top-level declaration (C# style).** Rejected — GSharp uses `type Name = …` as the single entry point for every nominal type. A bare `delegate` member kind would be the only declaration that bypasses `type`. Consistency wins.

3. **Treat every `FunctionTypeSymbol` as its own implicit named delegate.** Rejected — `func(int32) int32` is structural, and forcing a fresh TypeDef per occurrence would balloon the metadata table and produce non-interchangeable delegate identities (same shape, two named TypeDefs, no implicit conversion between them). Action/Func continue to handle the structural case; named delegates are opt-in.

4. **Emit `BeginInvoke` / `EndInvoke` for compatibility with .NET Framework asynchronous-callback patterns.** Rejected — Roslyn dropped these in C# 4.0 emit for portable / .NET Core targets, and the CLR no longer requires them. Adding them later would be a non-breaking change.

## Consequences

- New SyntaxKind `DelegateKeyword` (contextual `delegate`) and `DelegateDeclaration` (the declaration node), plus matching parser / binder / emit support. Coverage matrix updated.
- New `DelegateTypeSymbol` (sibling of `StructSymbol` / `InterfaceSymbol` / `EnumSymbol`) registered through `TryDeclareTypeAlias` so `LookupType` finds it for free.
- New `BoundGlobalScope.Delegates` and `Binder.BindDelegateDeclaration`; declared delegate types flow through to the emitter.
- The `ReflectionMetadataEmitter` reserves 2 method rows + N parameter rows per delegate (after interface methods, before non-SM class ctors) and emits the TypeDef between interfaces and non-SM classes.
- `EncodeTypeSymbol` learns to route a `DelegateTypeSymbol` reference to its emitted `TypeDef` (a `Class`-encoded reference type).
- The existing `func → delegate` conversion path picks up named delegates automatically — `IsFunctionToDelegateConvertible` already inspects the CLR `Invoke` signature.
- New diagnostic **GS0233** — surfaced when `type Name = delegate …` is not followed by `func(...)`; the parser recovers and the binder skips the declaration.
- ADR-0052's "delegate question" follow-up is closed; events may now carry a named delegate type or continue to carry `Action`/`Func`.

## Follow-up work (out of scope)

- Generic delegate declarations (`type Predicate[T any] = delegate func(value T) bool`) are now supported (issue #1503): the binder binds the type-parameter list, and the emitter mangles the delegate TypeDef name with the backtick-arity suffix, threads one `GenericParam` row per type parameter, and references the slots as `VAR(idx)` in the `Invoke`/`.ctor` signatures — reusing the existing generic struct/class/interface emit mechanism. Constructed instantiations (`Predicate[int32]`) are constructed from a lambda/method group and invoked through a `MemberRef` parented at the delegate `TypeSpec`. **GS0234** has been retired.
- A `where T : delegate` constraint to make `Predicate[T]` instantiations of a generic delegate work as a generic-type-parameter constraint target.
- Emitting `BeginInvoke` / `EndInvoke` if a project enables a legacy-delegate compatibility flag.
- Variance annotations on generic delegate type parameters (`type Func[in T, out R] = delegate func(value T) R`).
