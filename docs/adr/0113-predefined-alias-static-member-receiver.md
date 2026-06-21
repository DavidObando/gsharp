# ADR-0113: Predefined type aliases as static-member-access receivers

- **Status**: Accepted
- **Date**: 2026-06-21
- **Phase**: Phase 8 — naming polish
- **Closes**: Issue #919 (`string.Empty` doesn't resolve as expected)
- **Related**: ADR-0098 (friendly numeric type aliases); ADR-0044 (numeric primitive coverage); ADR-0112 (unified member resolution)

## Context

G# spells the built-in value and reference primitives with lowercase
keyword aliases — `string`, `bool`, `char`, `object`, the width-bearing
numeric names (`int32`, `uint8`, `float64`, …), and the friendly numeric
aliases added by ADR-0098 (`int`, `long`, `byte`, …). In every
**type-clause** position these names resolve to the canonical
`TypeSymbol` (and the underlying CLR type) through `Binder.LookupType`.

However, when one of these names appeared as the **receiver of a static
member access** — for example `string.Empty` or `int32.MaxValue` — the
expression binder failed to resolve it. The accessor binder's left-name
resolution only consulted imports, imported classes, user type aliases,
and generic type parameters; the predefined keyword aliases are none of
those, so binding fell through to the "cannot find type" path:

```
error GS0159: Cannot find function FromResult.
error GS0157: Cannot find type string. Are you missing an import?
```

The capitalized BCL spelling (`String.Empty`, `Int32.MaxValue`) worked,
because `String` resolves as an imported CLR class via `import System`.
This left an inconsistency: the same type was a valid static-access
receiver under its CLR name but not under its canonical G# keyword name.

## Decision

A predefined primitive type alias is a valid receiver for static member
access and binds identically to the equivalent CLR-named type.

In the accessor binder's left-name resolution, after the import / alias /
type-parameter lookups fail, the receiver name is resolved through the
same `LookupType` path used by type clauses. When it maps to a predefined
primitive `TypeSymbol` with a backing CLR type, an `ImportedClassSymbol`
over that CLR type is created and the right-hand member is bound against
it — the exact mechanism the capitalized form already uses.

This makes the following forms resolve consistently, with or without
`import System`:

| Form                | Underlying CLR type | Notes                          |
| ------------------- | ------------------- | ------------------------------ |
| `string.Empty`      | `System.String`     | static field                   |
| `int32.MaxValue`    | `System.Int32`      | canonical width-bearing alias  |
| `int.MaxValue`      | `System.Int32`      | friendly alias (ADR-0098)      |
| `object.ReferenceEquals(a, b)` | `System.Object` | static method            |

### Scope and ordering

- The predefined-alias resolution runs **only after** the import,
  imported-class, and user-type-alias lookups have failed. Because the
  primitive keyword aliases are reserved names that cannot be redeclared
  (`Binder.IsPrimitiveTypeName`), this fallback never shadows a
  user-declared alias or an imported type.
- `void` is excluded: it has a CLR type but is meaningless as a
  static-access receiver, so the ordinary "cannot find type" diagnostic
  still applies.
- User struct/enum aliases (which have a null `ClrType`) are unaffected;
  they continue to bind through their existing static-access paths.

## Consequences

- `string.Empty` and the other predefined aliases now resolve as
  static-member-access receivers, matching the capitalized CLR spelling
  and the type-clause behavior of the same names.
- No new syntax or language rule is introduced; this aligns expression
  binding with the already-documented alias resolution. Diagnostics,
  `typeof`, `nameof`, hover, and IL continue to use the canonical name.
- The fix is purely additive in the binder. No emitter or runtime change
  is required: the resulting bound tree is identical to what the
  capitalized form produced.
