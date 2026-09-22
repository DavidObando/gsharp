# ADR-0181: Readonly managed-reference contracts

- **Status**: Accepted
- **Date**: 2026-09-15
- **Related**: ADR-0039 (managed pointers), ADR-0058 (escape safety),
  ADR-0060 (ref parameters and returns), ADR-0156 (emitted execution).
- **Issue**: #4220; consumer-side continuation tracked separately in #4219.

## Context

A readonly reference is a live alias, not a snapshot and not a writable
reference. Neither a by-value return nor a writable-ref return preserves its
contract. Imported readonly-ref value reads already work; this decision adds
source contracts and shares readonly capability checks across imported paths.
Existing `let ref` aliases are writable and retain that meaning.

## Decision

### Source spelling

`readonly` is contextual immediately after a declaration's `ref`:

```gsharp
func View[T](ref value T) ref readonly T {
    return ref value
}

class Buffer {
    var values []int32 = []int32{10, 20}
    prop First ref readonly int32 -> values[0]
    prop this[i int32] ref readonly int32 {
        get { return ref values[i] }
    }
}

func Observe() int32 {
    var value = 10
    let ref writable = value
    let ref readonly view = writable
    var ref readonly another int32 = view
    writable = 42
    return another // 42, not 10
}
```

The return statement remains `return ref expression`; the declaration defines
the capability. `readonly` remains usable as an ordinary identifier elsewhere.
Both `let ref readonly` and `var ref readonly` prohibit writes through the
alias. Neither changes the binding or object-immutability rules of ordinary
`let`/`var`. `let ref` and `var ref` remain writable aliases.

Methods may be generic, virtual, overriding, or interface methods. Properties
and indexers retain ADR-0060 §14's concrete computed-getter restrictions:
no auto-property, setter/init accessor, abstract property, or source interface
property declaration. Concrete implementations of imported property slots
must preserve their exact readonly/writable/value return contract.

### Representation and permissions

`RefKind.RefReadOnly` is distinct from `Ref`, `Out`, `In`, and `None`.
Function/property symbols store pointee type separately from return ref-kind.
Local aliases store their own ref-kind; bound addresses carry readonly
capability independently of their managed-pointer type and lifetime.
Rewriting and generic substitution preserve this information.

Allowed:

- Value reads, including imported methods/properties/indexers and existing
  `ReadOnlySpan` paths.
- A readonly alias of addressable storage or another readonly/writable alias.
- Passing the referent to an appropriate `in` parameter.
- Mutating an object reached through a readonly reference of reference type.
  The object is not immutable; replacing the reference in its slot is forbidden.

Rejected:

- Assignment, compound assignment, increment/decrement of the referent.
- Writable `ref` or `out` passing, including conditional and nested-field paths.
- Taking a writable address or constructing a writable alias from readonly storage.
- Exposing readonly storage through a writable-ref return.
- Aliasing a copied field receiver, map/string element, or other expression
  without an addressable storage slot.

Readonlyness propagates through value-type fields. A non-readonly instance
method call on a readonly struct referent uses a defensive copy. Imported
readonly methods and methods of readonly structs can use the original address.
Taking a readonly alias of a nested field does **not** use that defensive copy:
it must retain the original field's identity. Ordinary `let` receiver behavior
is unchanged.

Return ref-kind participates in interface/override and method-group/delegate
compatibility before any structural function-type view erases CLR details.
Byref pointee types are invariant: neither reference covariance nor changing a
writable/readonly/value return mode is a valid method-group conversion.
Imported delegates retain the contract on `Invoke`; ordinary by-value literals
cannot implement ref-returning delegates.

### Lifetime is independent

Readonly permission does not extend storage lifetime. Existing ref-safe escape
checks apply equally to readonly and writable returns:

- A local slot or by-value parameter slot cannot escape its function.
- `scoped` storage cannot escape its declared scope.
- An alias inherits its referent's lifetime, rather than the lifetime of the
  local slot holding the alias.
- Dereferencing an existing pointer parameter follows its scoped/unscoped
  referent contract, not the lifetime of the copied parameter slot.
- Caller-owned unscoped ref storage, static storage, and heap array/class
  storage can survive the callee when existing escape checks permit it.
- Existing restrictions on async suspension, captures, and managed-reference
  storage remain in force.

For example, returning a readonly alias of an unscoped `ref` parameter is
legal; returning a readonly alias of a local integer is not. Both use the same
address and escape representation as writable refs, not a readonly-only path.

### CLR interoperability

`T&` alone is insufficient. The emitted contract follows Roslyn:

1. The method/getter return signature contains
   `modreq(System.Runtime.InteropServices.InAttribute)` and `T&`.
2. The sequence-zero return parameter carries
   `System.Runtime.CompilerServices.IsReadOnlyAttribute`.
3. A readonly-ref property's PropertyDef signature contains the same modifier
   and byref type, and its PropertyDef carries `IsReadOnlyAttribute`.

The property attribute matters independently of the getter return attribute:
omitting it makes otherwise plausible metadata unsupported to a C# consumer.
Abstract/interface method return rows follow the same rules.
Metadata-only `/refout` getter fallbacks also emit the sequence-zero readonly
return attribute; implementation and reference assemblies must agree.

Imports inspect required return modifiers and return attributes centrally.
Byref return nullability and tuple names describe the pointee, not a nullable
managed pointer. Property, indexer, call, delegate, override, and explicit
interface paths must agree on the resulting capability and substituted type.
Ordinary reads dereference the result; importing readonly metadata must not
break pre-existing value reads.

### Translation and explicit boundaries

cs2gs preserves `ref readonly` on supported named methods, computed properties,
indexers, and local aliases. Executable translation tests retain aliases,
mutate the original storage through an authorized path, and observe the new
value. They do not replace readonly contracts with writable refs or snapshots.

The following remain separate:

- **#4219:** first-class consumption/retention of source getter/call ref
  results and direct writes through named writable ref-returning calls were
  completed by #4224 and #4350. Ref-returning literals and their source
  delegate integration remain under #4219. Source
  `let ref readonly alias = holder.First` must not be implemented by
  snapshotting the value; neither may a field underneath a value-type ref
  result bypass that boundary.
- Ref reassignment: no `alias = ref other` operation.
- Readonly-ref fields and readonly-ref parameter variants: no new forms.
  Existing `in` parameters are not redefined as readonly-return contracts.
- Relaxation of the concrete computed-property restriction.

## Validation

`Issue4220ReadOnlyRefTests` covers live alias identity, preserved writable
`let ref`, permissions, shallow mutation, defensive copies, generic
substitution, matching, and invalid escapes. `Issue4220ReadOnlyRefInteropTests`
compares metadata against Roslyn, executes C# consumers, checks rejected C#
writes/conversions, and tests imported reads and compatibility. cs2gs
ref-local/member/property regressions cover translation and executed alias
identity while retaining loud-gap tests for the explicitly deferred surfaces.

The heap-backed producer and by-value consumer fixtures pass unsuppressed
ILVerify. ILVerify 10.0.8 reports `ReturnPtrToStack` for the minimal incoming
byref forwarder `ldarg; ret` from **both Roslyn and G#**. The caller-owned
forwarder tests therefore compare complete method IL against Roslyn and
execute retained aliases; they do not suppress verifier errors or substitute a
heap alias for the caller's storage.
