# ADR-0215: Source Link build inputs

- **Status**: Proposed
- **Date**: 2026-10-26
- **Issue**: [#5404](https://github.com/DavidObando/gsharp/issues/5404)
- **Related**: [ADR-0048](0048-portable-pdb-emit.md), [ADR-0154](0154-test-oracle-strength.md)

## Context

The compiler already writes Source Link JSON into Portable PDBs.
The .NET SDK already generates this JSON from Git metadata for G# projects.
However, G# compilation does not track the JSON file as a build input.
A commit change can leave an incremental build with an obsolete source URL.
An explicit missing JSON file also produces symbols without Source Link.

The repository uses the released compiler specified in `global.json`.
Its build targets need the same input tracking as consumer projects.

## Decision

Use the standard `GenerateSourceLinkFile` target.
Run it before the G# compilation input cache.
Add its `SourceLink` file to `MSBuildAllProjects`, which `CoreCompile` already tracks.
Use one target file for the SDK and the repository build.
Reject an explicit missing file when compilation requests debug information.
Keep design-time command discovery and builds without debug information unchanged.

Keep the existing compiler payload, document names, and SHA-256 source hashes.
Keep source embedding opt-in through `EmbedAllSources`.
Do not add a Source Link package dependency.
Do not add a source upload operation or a repository URL override.
Use the .NET SDK provider configuration for other source hosts.

The [SDK guide](../../website/docs/tooling/sdk-projects.md#source-link) describes publishing and explicit mappings.
The [debug information reference](../debug-info.md#sourcelink-blob-layout) describes the payload.

## Consequences

Incremental builds update symbols when the source revision or mapping file changes.
`EnableSourceLink=false` removes an earlier automatic mapping.
Local repositories without remote metadata keep their ordinary debug symbols.
Repository builds use the specified released compiler without a bootstrap change.

Source Link does not prove that a remote server contains the source.
Publishers must publish the referenced commit and distribute the matching symbols.
Absolute document paths remain unchanged.
Cross-directory path normalization and selective source embedding remain outside this change.

## Alternatives considered

- Another Source Link package duplicates support that the .NET SDK already supplies.
- A new JSON generator duplicates the standard source-control provider logic.
- Embedding all sources changes the source-disclosure policy from ADR-0048.
- Changing compiler emit cannot correct MSBuild skipping compilation.

## Verification

`e2etests/sourcelink-e2e.sh` builds the SDK package with the specified released compiler.
It then tests that package through `dotnet build`.
The Python driver also supports the SDK targets with the released compiler for a pre-change witness.
The test reads real PDB records, resolves document URLs, and compares SHA-256 hashes with Git source bytes.
It checks automatic and explicit mappings, incremental builds, symbol packages, opt-out, local repositories, and embedded PDBs.
It also compares native compiler output with JIT-only output.
