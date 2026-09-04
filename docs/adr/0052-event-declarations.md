# ADR-0052: Event declarations on user types — `event` keyword

- **Status**: Accepted
- **Date**: 2026-05-29
- **Phase**: Phase 9 — language depth (post-primitive)
- **Related**: ADR-0036 (CLR event subscription — consumption side); ADR-0047 (attribute syntax — `@event:` target kind); ADR-0051 (property declarations — parallel `prop` pattern); issue #140

## Context

GSharp can consume CLR events on imported types via `+=` / `-=` (ADR-0036), but user-defined types cannot declare events. This breaks CLR round-trip: C# consumers cannot subscribe to notifications from GSharp-authored libraries, and GSharp types cannot implement interfaces that require events (e.g., `INotifyPropertyChanged`).

Issue #140 requests support for declaring events with the same metadata shape that a C# `event` declaration produces — `EventDefinition` row + `add_X`/`remove_X` specialname methods — so that downstream C#/F# consumers see standard CLR events.

### The delegate question

GSharp has no `delegate` keyword. First-class function types (`func(T1, T2) R`) lower to `Action<…>`/`Func<…>` BCL delegates (via `FunctionTypeSymbol`). CLR events carry a *named* delegate type, but nothing prevents using `Action<…>` as the handler type — it produces valid, subscribable events from C#.

Custom delegate types (`EventHandler<T>`, `PropertyChangedEventHandler`, etc.) would require a separate `delegate` declaration. This ADR defers that to a follow-up: for v1, events carry `Action<…>`/`Func<…>` handler types. If interop demand arises, a future ADR will introduce `delegate MyHandler(sender Object, e MyEventArgs) ` syntax.;

## Decision

Introduce a contextual keyword **`event`** for declaring CLR events inside `struct`, `class`, and `interface` bodies. The design parallels `prop` (ADR-0051) closely — same accessibility/annotation surface, same accessor-body pattern.

### 1. Grammar

```
event_declaration    = annotations? accessibility_modifier? open_modifier? override_modifier?
                       "event" identifier type_clause event_body?
event_body           = "{" event_accessor_list "}"
event_accessor_list  = add_accessor remove_accessor | remove_accessor add_accessor
add_accessor         = "add" ( block | ";" )
remove_accessor      = "remove" ( block | ";" )
```

The `event` keyword is contextual — recognized only inside a type body. Outside type bodies, `event` remains a valid identifier.

The `type_clause` must resolve to a function type (`func(…) …`) which maps to an `Action<…>` or `Func<…>` delegate at the CLR level.

### 2. Forms

#### Field-like event (most common)

```gs
struct MyButton {
    public event Click func(sender Object, e EventArgs)
}
```

No body — the compiler synthesizes:
- A private backing field: `Action<object, EventArgs> Click` (the multicast delegate)
- Method: `public void add_Click(Action<object, EventArgs> value)` — calls `Delegate.Combine`
- Method: `public void remove_Click(Action<object, EventArgs> value)` — calls `Delegate.Remove`
- `EventDefinition` metadata row linking the event name to the add/remove accessors

The add/remove methods use the standard `Delegate.Combine`/`Delegate.Remove` pattern (not the thread-safe `Interlocked.CompareExchange` loop — simplicity over lock-freedom for v1).

#### Event with explicit accessors

```gs
struct ObservableList {
    private var handlers []func(sender Object, e EventArgs)

    public event CollectionChanged func(sender Object, e EventArgs) {
        add { handlers = append(handlers, value) }
        remove { /* custom removal logic */ }
    }
}
```

When an explicit body is present, the compiler does **not** synthesize a backing field. The `add` and `remove` blocks have an implicit `value` parameter of the handler type. Both must be present — omitting either is an error.

#### Interface event

```gs
interface INotifyPropertyChanged {
    event PropertyChanged func(sender Object, e PropertyChangedEventArgs)
}
```

No body, no accessibility modifier. The interface emits abstract `add_PropertyChanged`/`remove_PropertyChanged` methods and an `EventDefinition` row. Implementing types must declare the matching event.

### 3. Raising events

Events are raised by invoking the backing delegate directly from within the declaring type:

```gs
func (b *MyButton) OnClick() {
    if b.Click != nil {
        b.Click(b, EventArgs.Empty)
    }
}
```

The backing field is accessible by name inside the declaring type (like C#). Outside the type, only `+=` / `-=` are permitted — direct invocation or assignment is an error. This access restriction is enforced by the binder.

A user-declared event's `+=` / `-=` accepts a **nilable** handler, and a nil handler is a silent no-op — the synthesized `add_E` / `remove_E` accessors forward to `Delegate.Combine` / `Delegate.Remove`, which are defined on a null operand. The rule and its scope are recorded once, in ADR-0036 §5 (issue #3775); it applies identically to user-declared and imported CLR events.

### 4. Annotations and use-site targets

Per ADR-0047, the `@event:` use-site target directs an annotation to the event metadata:

```gs
@event:Obsolete("Use ClickV2 instead")
@field:NonSerialized
public event Click func(sender Object, e EventArgs)
```

- Default target for annotations on an event declaration: `event`
- `@field:` targets the synthesized backing field (field-like events only)
- `@method:` on an event is ambiguous (add or remove?) — disallowed; use explicit accessors with annotations per-accessor instead

### 5. Interaction with `open` / `override`

Events follow the same virtuality model as methods (ADR-0017):

```gs
class Base {
    public open event Changed func(sender Object, e EventArgs)
}

class Derived {
    public override event Changed func(sender Object, e EventArgs)
}
```

An `open` event emits virtual `add_X`/`remove_X` accessors. An `override` event emits override accessors. The default (no modifier) emits non-virtual accessors.

### 6. CLR metadata shape

For a field-like event `public event Click func(sender Object, e EventArgs)` on type `MyButton`:

| Metadata row | Content |
|-------------|---------|
| FieldDef | `private Action<Object, EventArgs> Click` (backing field) |
| MethodDef | `public hidebysig specialname void add_Click(Action<Object, EventArgs> value)` |
| MethodDef | `public hidebysig specialname void remove_Click(Action<Object, EventArgs> value)` |
| EventDef | Name=`Click`, EventType=`Action<Object, EventArgs>`, AddOn=`add_Click`, RemoveOn=`remove_Click` |

This matches exactly what a C# `public event Action<object, EventArgs> Click;` produces.

## Alternatives considered

1. **`@event` annotation instead of keyword.** Rejected — annotations should not alter the fundamental member kind. An event has different binding semantics (no direct assignment from outside) and emits different metadata. A keyword is warranted.

2. **Go channel-based pub/sub.** GSharp already has channels (`chan`). We could model events as channels. Rejected — this would not produce CLR-compatible metadata, breaking the interop promise.

3. **Require delegate types for events.** Rejected for v1 — adds unnecessary complexity. `Action<…>` is the pragmatic default. Custom delegates can follow in a future ADR.

4. **Kotlin `val onClick: ((Object, EventArgs) -> Unit)?` with `by` delegation.** Rejected — GSharp doesn't use Kotlin's `->` syntax or `by` delegation. The `event` keyword is more explicit and matches Go's philosophy of one obvious way.

## Consequences

- User types can declare CLR events that C# consumers subscribe to with standard `+=` / `-=`.
- GSharp types can implement interfaces requiring events (e.g., `INotifyPropertyChanged`).
- The `event` keyword becomes contextual inside type bodies (non-breaking — it was not previously valid there).
- Raising events uses standard null-check + invoke — no special `raise` keyword.
- Thread-safe event accessors (Interlocked pattern) are deferred to explicit-accessor usage.
- Custom delegate types are deferred — events use `Action<…>`/`Func<…>` for v1.

## Follow-up work (out of scope)

- `delegate MyHandler(…) ` syntax for named delegate types;
- Thread-safe field-like event accessors (Interlocked.CompareExchange pattern)
- `raise` accessor support (C#-style, rarely used)
- ~~Static events on user types~~ — **superseded, see the amendment below.**

## Amendment (2026-09-04, issues #3911 / #3907): static events are supported

**Static events on user types are no longer out of scope.** The entry above is
struck; this section is now authoritative for them.

A static event is declared in a `shared` block, with the same grammar,
accessibility surface and accessor forms as an instance event:

```gsharp
class GsharpRuntime {
    shared {
        event DeferGraceExpired EventHandler[DeferGraceExpiredEventArgs]?

        func RaiseDeferGraceExpired(budget TimeSpan) {
            DeferGraceExpired?(nil, DeferGraceExpiredEventArgs(budget))
        }
    }
}

GsharpRuntime.DeferGraceExpired += func(sender object?, e DeferGraceExpiredEventArgs) { … }
```

### What is supported

Everything the instance form supports, with identical semantics:

- **Declaration** — field-like and explicit-accessor (`add` / `remove` / `raise`), in a `shared` block.
- **Subscription** — `Type.Event += handler` / `-= handler` from outside, and the bare
  `Event += handler` spelling inside the declaring type's own members.
- **Reading and raising** — the event's name resolves inside the declaring type's members
  to its backing delegate field, so `Event?(sender, args)`, `let h = Event`, and
  `if Event != nil` all work. This mirrors C#, where a field-like event access
  *within the program text of the declaring type* is an access to the backing field.
- **Metadata** — an `EventDefinition` row, `add_`/`remove_`/`raise_` specialname
  static methods and `MethodSemantics` rows, so C# consumers subscribe with
  ordinary `+=` / `-=`.
- **Thread safety** — the generated field-like `add`/`remove` accessors use the
  same `Interlocked.CompareExchange` loop as the instance form (issue #256).
- **Nil handlers** — `Event += nil` is a silent no-op, as in C#, because the
  static path binds its handler through the same conversion the instance path
  uses (issue #3775 / PR #3793). It is not a conversion error and not a throw.

### History, and why the entry was stale

Most of this shipped with issue #263 (`shared`-block static events: declaration,
accessors, metadata emission, `Type.Event += handler`). What was never wired up
was the *bare-name* half — reading, raising, and the bare `Event += handler`
form inside the declaring type — because the binder's static bare-name exposure
covered static fields, const fields and static properties but not static events'
backing fields, and the bare `+=`/`-=` path walked instance events only. So a
static event could be declared and subscribed to but never read or raised, which
is what issue #3911 reported: `Static?(nil, args)` failed with `GS0130` while the
identical instance event worked. Issue #3907 fixed both halves.

### Still deferred

Unchanged from the list above, and orthogonal to static-ness: the `delegate`
keyword for named handler types, and custom (non-`Action`/`Func`/`EventHandler`)
delegate declarations. Static events reach these exactly as instance events do.
