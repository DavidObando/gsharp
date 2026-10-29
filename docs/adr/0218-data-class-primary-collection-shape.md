# ADR-0218: Data-class primary collection declaration shape

- **Status**: Accepted (maintainer approval on October 28, 2026)
- **Date**: 2026-10-28
- **Phase**: Cross-assembly construction
- **Related**: [#5425](https://github.com/DavidObando/gsharp/issues/5425), [ADR-0159](0159-magic-collection-zero-values-and-nil-comparison.md), [ADR-0214](0214-imported-inline-field-initializers.md)

## Context

Imported data-class literals use the selected primary constructor. Its omitted collection inputs need their declaration's sound zero.

CLR array signatures do not distinguish `[]T` from `[3]T`. The existing `GSharp.MagicCollectionFields` metadata records this distinction for struct storage.

The producer omitted this metadata for all classes. Corrected consumers therefore reject required class collection omissions with `GS0267`.

The maintainer approved the bounded extension: "Approve the bounded metadata extension".

## Decision

Extend the existing declaration-shape payload to a data class's own primary storage only.

Keep the existing metadata key, type token, field identity, payload grammar, and shape tags. Preserve declaration order.

Resolve storage through the existing primary-member mapping. Do not mark inherited storage or class body fields.

Resolve field tokens within the declaring type and module, including private backing fields.
Keep private storage out of the accessible member model. Do not replace an unavailable nonzero token with inherited or named storage.

Primary automatic-property backing fields use the existing field-token mapping in implementation and reference metadata.

Reuse canonical primary-argument zero synthesis and receiver-aware signature readers. Select the same exact primary constructor before synthesis.

An unavailable or unusable required shape reports located `GS0267`. Emit no requested implementation assembly, reference assembly, or portable PDB.

Explicit inputs, nullable omissions, ordinary-call defaults, and known whole-primary-type-parameter shapes retain their existing behavior.

Do not add a runtime helper, expression serialization, metadata key, or public constructor ABI.

Do not change class inheritance, body-field initialization ownership, or ordinary constructor execution. ADR-0214 remains limited to fresh data structs.

## Consequences

New producers preserve distinct slice, fixed-array, map, and synchronous-sequence zeros through implementation and reference metadata.

Consumers of old libraries still reject omissions that require unavailable declaration shape. Recompile both producer and consumer to enable these omissions.

The collection marker does not establish constructor ownership. Existing type identity, primary mapping, and exact signature selection remain authoritative.

## Alternatives considered

- Infer shape from CLR types: rejected because identical array signatures have different declaration zeros.
- Pass null or an empty fixed array: rejected because either result violates the declared contract.
- Introduce a helper or class ownership protocol: rejected because the existing declaration metadata and constructor path are sufficient.
