# ADR-0222: Segmented named type alias targets

- **Status**: Accepted
- **Date**: 2026-11-12
- **Phase**: Language consistency
- **Related**: [#5983](https://github.com/DavidObando/gsharp/issues/5983), #5358,
  [ADR-0020](0020-generic-brackets.md), [ADR-0078](0078-kotlin-style-type-declaration-grammar.md),
  [ADR-0110](0110-nested-type-declarations.md)

## Context

The alias grammar accepts one target identifier.
Other named type positions accept qualified names with separate generic arguments on each segment.
For example, `Outer[int32].Base` works as a direct base but fails as an alias target.

The existing syntax model records each segment's arguments.
The canonical type binder already resolves these segments against their actual containing types.
This request concerns syntax coverage, not declaration scheduling.

## Decision

Extend declared aliases to accept named type targets:

```ebnf
NamedTypeTarget = identifier TypeArgList? { "." identifier TypeArgList? } .
```

Each segment uses existing type argument syntax and binding rules.
The target retains its complete constructed containing type identity.
The binder must not replace a qualified target with its final simple name.
Alias erasure and existing declaration scope and ordering rules remain unchanged.

Share the named type parser with ordinary type clauses.
Continue to bind alias targets through the existing canonical type binder.
Keep the public syntax model and its constructors unchanged.

This decision does not add parameterized aliases, type argument inference, or composite alias target forms.
It does not add a trailing nullable suffix to alias targets.
Existing generic argument syntax and nullability rules remain unchanged inside argument lists.

## Consequences

Aliases can name `Outer[int32].Base` and `Outer[int32].Base[string]`.
Imported and source targets use existing qualified type resolution, arity checks, accessibility, and constraints.
The formatter receives the same type clause representation as other named type positions.
Repository source must wait for an adopted released compiler before using this syntax outside driver input strings.

## Alternatives considered

- Parse any type clause: this also adds unrelated array, pointer, function, tuple, and nullable alias target forms.
- Add an alias-specific segment resolver: this duplicates existing binding and risks losing constructed containing types.
- Resolve only the final identifier: this can select a homonymous type and discard outer generic arguments.
- Keep identifier-only targets: this retains the syntax inconsistency reported in #5983.
