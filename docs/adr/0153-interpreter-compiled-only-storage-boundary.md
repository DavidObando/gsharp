# ADR-0153: Interpreter compiled-only storage boundary

- **Status**: Accepted
- **Date**: 2026-08-01
- **Phase**: Phase 9 — low-level / interop depth
- **Related**: ADR-0039 (managed by-ref pointers), ADR-0122 (unsafe context and unmanaged pointers), ADR-0124 (`stackalloc`), ADR-0125 (`fixed`), issues [#2956](https://github.com/DavidObando/gsharp/issues/2956), [#3004](https://github.com/DavidObando/gsharp/issues/3004), [#3022](https://github.com/DavidObando/gsharp/issues/3022), and [#2939](https://github.com/DavidObando/gsharp/issues/2939)

## Context

The compiled backend has a CLR storage model. It can emit managed byrefs,
unmanaged pointers, pinned locals, `localloc`, `sizeof`, `ldftn`, and `calli`.
The tree-walking interpreter models values, not storage locations. Its local
frames contain values, and it has no address space, alias identity, pointer
lifetime, or GC-pinning mechanism.

ADR-0039's interpreter support for `ref` and `out` does not provide a general
pointer model. `&x` and `*p` are evaluated as identity operations. Ref/out calls
work only because the call-site machinery recognizes an address-of argument,
records its source slot, and writes the result back after the call. Outside
that position, an address is reduced to a value copy. Issue #3004 demonstrates
the consequence: after `var p *int32 = &x`, a later write to `x` is invisible
through `*p`, so `gsi` returns a plausible stale value with exit code 0.

`fixed` is the cleanest existing boundary. The evaluator already rejects it
with a self-contained message explaining that pinning requires the CIL
pinned-local emit path. `stackalloc`, `sizeof` over unmanaged storage, method
function pointers, and function-pointer invocation use the same pattern.

Script-mode diagnostic rendering is not part of this boundary contract and may
include a source location and caret. Boundary messages must still name the
construct, state that the interpreter does not support it, and explain which
compiled runtime facility it requires. They cannot rely on surrounding
diagnostic rendering for meaning.

## Decision

Constructs whose interpreter behavior requires real address identity —
including pinning, stack allocation, unmanaged-pointer storage or dereference,
and function-pointer execution — are **compiled-only**. `gsi` must report a
self-contained boundary diagnostic instead of attempting a value-only
approximation. Users who need these constructs must compile with `gsc`.

This ADR governs only the evaluator's storage-model boundary. It does not
redefine unsafe/native language validity or CIL emission.

The `unsafe` context itself remains supported. It is a permission boundary, not
a storage operation; an `unsafe` block containing only otherwise-supported
value operations continues to evaluate normally.

The current implementation status is:

| Construct | Current `gsi` behavior | Contract status |
|---|---|---|
| `unsafe { ... }` without a storage-only construct | Evaluates normally | Supported |
| `fixed` over array/slice, string, or a pinnable-reference source | Self-contained boundary diagnostic | Meets contract |
| `stackalloc` | Self-contained boundary diagnostic | Meets contract |
| `sizeof` requiring the CIL unmanaged-storage path | Self-contained boundary diagnostic | Meets contract |
| `&Method` function pointer | Self-contained boundary diagnostic | Meets contract |
| Function-pointer invocation | Self-contained boundary diagnostic | Meets contract |
| Ref local alias (`let ref r = arr[i]`) | Re-evaluates the initializer at read time; silently wrong | Must become a boundary; tracked by #3022 |
| `*p = value` | Boundary enforcement is owned by #3028; without it, falls through to a generic “Unexpected node” failure | Must be a boundary |
| `*(p + 1)` | Boundary enforcement is owned by #3028; without it, leaks a raw reflection/conversion failure | Must be a boundary |
| Free-standing `&x` followed by `*p` | Boundary enforcement is owned by #3028; without it, silently returns a copied, stale value | Must be a boundary; underlying aliasing tracked by #3004 |
| Pointer arithmetic or comparison over copied values | May return coincidentally plausible results | Must become a boundary |

Until the evaluator has a dedicated boundary diagnostic code, the clean
boundary sites surface through `GS9999` with exact, construct-specific messages.
This is an interim classification limitation, not permission to treat every
`GS9999` as intentional. The conformance work in #2939 must classify only the
known boundary messages as `IntentionalBoundary` and must assert that each
listed boundary fires; any other `GS9999` remains a failure.

## Consequences

- `gsi` does not promise compiled/interpreted parity for storage-dependent
  unsafe constructs.
- Existing ref/out argument write-back at call sites remains supported; this
  does not provide stable ref-local aliasing.
- Boundary tests pin non-zero exit status, empty standard output, and the
  self-contained diagnostic message while tolerating surrounding renderer
  context.
- Issue #3004 owns the highest-severity contract violation: free-standing
  address-of and dereference currently return a wrong answer instead of failing.
- A future dedicated diagnostic code can replace the interim `GS9999`
  classification without changing the boundary itself.

## Alternatives considered

### Emulate `fixed` and unmanaged pointers in the interpreter

Rejected. Faithful behavior requires a storage-location abstraction,
alias-preserving cells, address identity, pointer arithmetic, lifetime rules,
stack allocation, and pinning semantics across arrays, strings, spans, locals,
and calls. This is a memory-model subsystem, not a localized implementation of
one statement. A partial model would preserve the current, more dangerous
failure mode: plausible wrong answers.

### Reject only `fixed`

Rejected. `fixed` is one user of the missing storage model and is already the
best-behaved member of the family. Drawing the line at one keyword would leave
`&`, `*`, pointer arithmetic, `stackalloc`, `sizeof`, and function pointers with
inconsistent or silently incorrect behavior.
