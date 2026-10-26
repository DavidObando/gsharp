# ADR-0216: Repository mirror Git provenance

- **Status**: Accepted
- **Date**: 2026-10-26
- **Phase**: cs2gs repository migration
- **Related**: [#5402](https://github.com/DavidObando/gsharp/issues/5402), [ADR-0115](0115-csharp-to-gsharp-migration-tool.md), [ADR-0154](0154-test-oracle-strength.md)

## Context

A repository mirror can sit inside another Git working tree.
Without its own Git metadata, a version task can use the parent repository.
Oahu then reports the translator commit instead of the application commit.
Its version height also changes.

Version tasks need the source commit graph and the original repository-relative paths.
A link to the source Git directory would also link mutable repository state.

## Decision

Create an independent Git clone before copying or translating repository files.
Use no checkout, no hard links, and no borrowed objects.
Keep the source commit graph and HEAD.
Keep source fetch and push URLs instead of the local clone path.
Use an explicit clone remote name, independent of user configuration.
Do not create a translation commit or change the source version settings.
The translated files form uncommitted working-tree changes.

Accept a Git working-tree root, including a linked working tree.
Reject a source subdirectory before creating the destination.
Its new relative paths cannot preserve history-based version calculations.

For an archive without Git history, create an empty Git repository in the destination.
This boundary prevents Git tools from using a destination ancestor.
Keep the archive's version files unchanged.

Keep Git metadata outside the source-file inventory and the completeness check.
Use the same rule for `migrate` and later `validate` builds.
Do not change pipeline stage verdicts or the nightly application bank.

## Consequences

The mirror can calculate source versions after the original checkout becomes unavailable.
Normal SDK builds use the source history without special version properties.
Source-control tools can also identify the source commit in the mirror.
The independent object database requires disk space and clone time.
Shallow source history remains shallow.
This change does not supply missing ancestors.

Driver tests compare original and migrated version output bytes.
They cover a source repository, a linked working tree, and an archive.
The destination sits inside a different repository.

## Alternatives considered

- Copy only `version.json`: this loses version height and commit identity.
- Link the source Git directory: this shares mutable state and requires the original checkout.
- Override version strings: this duplicates version-task decisions and can miss generated metadata.
- Clone a source subdirectory as a repository root: this changes history-relative paths and can produce incorrect versions.
