# ADR-0196: Transport retained generated compilation sources for validation

- **Status**: Accepted
- **Date**: 2026-10-05
- **Phase**: Self-migration artifact replay
- **Related**: #4801, #4752, #3501; ADR-0115, ADR-0154

## Context

Translation and validation can run on different machines and configurations.
The authored-source portability contract from #4752 requires the validator's
authoritative C# corpus, never the producer's absolute paths. A compilation
also contains SDK-generated inputs under build output directories, including
both net10 and netstandard2.0 target-framework declarations. These are not
authored corpus files, and a clean Release validator cannot reproduce a Debug
producer's inputs by opening the same relative path.

## Decision

Retain the existing translation selection. This change does not omit generated
declarations or change how references, compiler invocation, or project transforms
are selected.

For each retained Roslyn document, the repository's existing authored inventory
and build-output directory policy decide provenance. A compilation document
under a `bin` or `obj` directory, absent from that inventory, carries the actual
producing syntax tree text, its SHA-256 (UTF-8 without a preamble), and its
corpus-relative producing project. This evidence is captured during translation,
not read later from an intermediate that another build may have overwritten.
The per-emitted-file `generatedSource` object transports it inside
`validation-context.json`, including across namespace units of the same source.

Hydration keeps the corpus-relative original identity for all sources. Authored
positions must still resolve to readable files inside the authoritative corpus.
Generated positions consume the captured text instead of reading or writing an
intermediate in that corpus. They require portable source metadata, a build-output
path, a matching text hash, and an existing corpus-contained producing project
consistent with own/referenced ownership. No absolute producer file is opened.
The source-declared Fact reader uses this same generated evidence, deduplicating
by original source identity as before; budget constants and per-name oracles do
not change.

This is an additive manifest field, not retrospective provenance inference.
Older manifests without generated text retain their existing fail-closed
behavior. In particular, absent historical generated sources cannot be recovered
from a filename, a fresh SDK build, or translated G# text. Reproduce the migration
to obtain a portable generated-source handoff. Older readers likewise cannot
replay new generated inputs on a root lacking their original intermediates.
The hash detects transport corruption, not malicious re-signing of a manifest;
the manifest remains producing-run evidence with the same trust boundary as its
other translation-derived fields.

## Consequences

Clean cross-root/configuration replay preserves actual generated declarations
and source-derived budgets without polluting the authored corpus. Small generated
texts increase manifest size; authored source contents are not archived. Source
identity, path-escape checks, native metadata, strict compilation and IL
verification remain independent controls.

## Alternatives considered

- Skip missing generated files: loses source/metadata evidence and can change
  source counts.
- Regenerate under Release: does not reproduce the producer's Debug inputs.
- Recognize specific SDK filenames: misses other TFMs and generated inputs.
- Archive all original sources: bypasses the authoritative authored-corpus
  contract and expands the transport unnecessarily.
