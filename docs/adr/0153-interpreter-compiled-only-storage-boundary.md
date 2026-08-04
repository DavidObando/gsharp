# ADR-0153: Interpreter compiled-only storage boundary

- **Status**: Partially superseded by [ADR-0156](0156-gsi-emit-to-memory-execution.md) Phase 1; remains accepted for the default interactive evaluator
- **Date**: 2026-08-01
- **Phase**: Phase 9 — low-level / interop depth
- **Related**: ADR-0039 (managed by-ref pointers), ADR-0122 (unsafe context and unmanaged pointers), ADR-0124 (`stackalloc`), ADR-0125 (`fixed`), [ADR-0156](0156-gsi-emit-to-memory-execution.md) (execution-engine migration), issues [#2956](https://github.com/DavidObando/gsharp/issues/2956), [#3004](https://github.com/DavidObando/gsharp/issues/3004), [#3022](https://github.com/DavidObando/gsharp/issues/3022), [#3028](https://github.com/DavidObando/gsharp/pull/3028), [#3032](https://github.com/DavidObando/gsharp/pull/3032), [#2939](https://github.com/DavidObando/gsharp/issues/2939), and [#3199](https://github.com/DavidObando/gsharp/issues/3199)

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
that position, an address was previously reduced to a value copy. Issue #3004
demonstrated the consequence; #3028 now rejects free-standing unmanaged pointer
operations with `GS0513` and exit code 1.

`fixed` is the cleanest existing boundary message: the evaluator explains that
pinning requires the CIL pinned-local emit path. `stackalloc`, `sizeof` over
unmanaged storage, method function pointers, and function-pointer invocation
use the same pattern. These older guards are still wrapped as legacy GS9999
diagnostics; #3199 tracks moving deliberate boundary failures out of the
internal-error category.

Diagnostic presentation is not part of this boundary contract. Boundary
messages must still name the construct, state that the evaluator does not
support it, and explain which compiled runtime facility it requires. They
cannot rely on surrounding rendering for meaning.

## Decision

Constructs whose interpreter behavior requires real address identity —
including pinning, stack allocation, unmanaged-pointer storage or dereference,
and function-pointer execution — are **compiled-only in the tree evaluator**.
Default interactive `gsi` must report a self-contained boundary diagnostic
instead of attempting a value-only approximation. Since ADR-0156 Phase 1,
bare `gsc` and `gsi <file>` use emitted execution and run these constructs
natively; `gsc /out:` emits them to disk.

This ADR governs only the evaluator's storage-model boundary. It does not
redefine unsafe/native language validity or CIL emission.

The `unsafe` context itself remains supported. It is a permission boundary, not
a storage operation; an `unsafe` block containing only otherwise-supported
value operations continues to evaluate normally.

The current implementation status is:

| Construct | Current default interactive-evaluator behavior | Contract status |
|---|---|---|
| `unsafe { ... }` without a storage-only construct | Evaluates normally | Supported |
| `fixed` over array/slice, string, or a pinnable-reference source | Self-contained legacy GS9999 boundary | Message meets contract; diagnostic category tracked by #3199 |
| `stackalloc` | Self-contained legacy GS9999 boundary | Message meets contract; diagnostic category tracked by #3199 |
| `sizeof` requiring the CIL unmanaged-storage path | Self-contained legacy GS9999 boundary | Message meets contract; diagnostic category tracked by #3199 |
| `&Method` function pointer | Self-contained legacy GS9999 boundary | Message meets contract; diagnostic category tracked by #3199 |
| Function-pointer invocation | Self-contained legacy GS9999 boundary | Message meets contract; diagnostic category tracked by #3199 |
| Ref local alias (`let ref r = arr[i]`) | Aliases the captured storage location | Meets contract after #3032 |
| `*p = value` | `GS0513` compiled-only boundary | Meets contract |
| `*(p + 1)` | `GS0513` fires before pointer arithmetic is evaluated | Meets contract |
| Free-standing `&x` followed by `*p` | `GS0513` compiled-only boundary | Meets contract |
| Pointer arithmetic or comparison over copied values | May return coincidentally plausible results | Must become a boundary |

The evaluator reports unmanaged `&`/`*` storage boundaries through `GS0513`.
The older construct-specific guards listed above still use self-contained
messages carried by GS9999; #3199 tracks that diagnostic-classification gap.
Outside those named legacy guards, `GS9999` remains a failure.

## Consequences

- The default interactive evaluator does not promise parity for
  storage-dependent unsafe constructs; file-mode drivers use emitted
  execution.
- Existing ref/out argument write-back at call sites remains supported; this
  does not provide stable ref-local aliasing.
- Boundary tests pin non-zero exit status, empty standard output, and the
  self-contained diagnostic message while tolerating surrounding renderer
  context.
- Issue #3004's free-standing address-of and dereference case is now rejected
  by `GS0513`.

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
