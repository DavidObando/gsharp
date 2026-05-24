# ADR-0036: CLR event subscription with `+=` / `-=`

- **Status**: Accepted
- **Date**: 2026 (this PR)
- **Phase**: Stream B′ — completes the imported-CLR-interop arc from ADR-0034
- **Related**: ADR-0034 (imported CLR interop — static + instance member parity, deferred events); execution plan §4 / §7 (CLR interop)

## Context

ADR-0034 shipped reads and writes for CLR static and instance members and explicitly deferred event subscription. Today CLR events are the only public member kind on imported types that GSharp source cannot reach. The deferral was practical: compound assignment (`x op= y`) is desugared by the parser to `x = x op y` for bare-identifier LHS only, so `obj.Event += handler` did not even parse, and the original `FieldAssignmentExpressionSyntax` only models a 3-token `id.id = expr` LHS — adequate for property writes but not for multi-segment receivers like `foo.bar.baz.Event += h`.

## Decision

Add a dedicated `EventSubscriptionExpressionSyntax` node and matching `BoundClrEventSubscriptionExpression`, wired through parser, binder, interpreter, and IL emitter. The new syntax is detected after `ParseBinaryExpression` returns an `AccessorExpressionSyntax` followed by `+=` / `-=`, which lets multi-segment LHS chains (`a.b.c.Event += h`) fall out for free without changing the existing compound-assignment desugaring or the legacy `FieldAssignmentExpressionSyntax` shape.

Key shape decisions:

1. **Receiver discrimination.** When the LHS chain begins with an `ImportedClassSymbol` (`Console.CancelKeyPress += h`), the binder looks up `EventInfo` with `BindingFlags.Public | BindingFlags.Static` and stores a `null` receiver on the bound node. Otherwise the LHS is bound as a regular expression and looked up with `BindingFlags.Public | BindingFlags.Instance`.

2. **Handler conversion.** GSharp function-literals always materialize as `Action<…>` / `Func<…>` today. Custom CLR delegate types (`EventHandler`, `FileSystemEventHandler`, …) are signature-compatible but not assignment-compatible with `Action<…>`. The binder therefore short-circuits `BindConversion` when the RHS is a `FunctionTypeSymbol` whose Invoke-signature matches the event's `EventHandlerType`. The IL emitter materializes the function literal directly against the event's delegate `ctor` (passing `overrideDelegateType` to `EmitFunctionLiteral`), and the interpreter wraps any `Delegate` whose runtime type does not match via `Delegate.CreateDelegate(eventInfo.EventHandlerType, d.Target, d.Method)`.

3. **Expression type.** The bound node returns `TypeSymbol.Void`. C# subscription expressions are statement-position only; making this `void`-typed matches that semantics and keeps the existing expression-statement emit/interpret paths from trying to push a result.

4. **Add vs. remove dispatch.** A single bound node carries an `IsAdd` bool. The evaluator dispatches to `EventInfo.AddEventHandler` / `RemoveEventHandler`; the emitter resolves the corresponding `add_X` / `remove_X` accessor via `EventInfo.GetAddMethod()` / `GetRemoveMethod()` and emits `callvirt` for reference receivers (or `call` for static/value-type receivers).

## Alternatives considered

- **Extend `FieldAssignmentExpressionSyntax` with an operator token.** Rejected: the existing node models a single `Receiver: SyntaxToken`, so multi-segment LHS would still require a parallel shape. A dedicated node keeps both paths clean.

- **Translate `+=` to `evt = evt + handler` at parse time.** This is how compound assignment works for identifier LHS, but for events the LHS isn't a settable read/write — it's accessor-only, and the rewrite would force the binder to inspect the `BoundBinaryOperator` shape and re-derive the event identity. The direct syntax node is simpler and matches the user mental model.

- **General `FunctionType → CLR-delegate` implicit conversion in `Conversion.Classify`.** This is the right long-term shape (it would also enable passing function literals to BCL methods expecting `EventHandler<T>`, `Action<T>`, etc.), but threading it through the IL emitter requires synthesizing per-delegate-type conversion stubs or runtime `Delegate.CreateDelegate` calls in every call site. We chose to localize the conversion inside the event-subscription emit path for now; generalizing this remains a follow-up (would supersede part of this ADR).

## Consequences

- Multi-segment LHS works as a side benefit: `xs.First().Event += h` is accepted as long as the trailing member is an `EventInfo`.
- Events whose handlers are not function literals (e.g., a CLR variable already typed as a delegate) still work — the binder falls back to `BindConversion`, which handles identity and null conversions.
- `op_True` / `op_False` short-circuit and other operator-on-imports follow-ups remain deferred as documented in ADR-0034.
