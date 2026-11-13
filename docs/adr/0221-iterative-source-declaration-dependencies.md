# ADR-0221: Iterative source declaration dependencies

- **Status**: Accepted
- **Date**: 2026-11-12
- **Phase**: Compiler declaration binding
- **Related**: [#5975](https://github.com/DavidObando/gsharp/issues/5975), #5968, ADR-0047, ADR-0154

## Context

Source attributes can apply other source attributes, including themselves.
An application needs the resolved base identity before it can select an attribute type.
Usage validation needs the definition's complete bound attributes.
Derived member signatures need the base's complete members.
These requirements are different readiness phases, not one recursive declaration dependency.

The guarded lazy binder reports GS0639 for valid deep attribute chains on small-stack workers.
The guard prevents a process crash but does not make those programs compile.
Whole-compilation retries and syntax-only attribute identity cannot satisfy these contracts.

## Decision

Separate source declaration scheduling into header, member, and usage-validation phases.

1. Complete headers with an explicit list of pending source base definitions.
   Publish resolved nominal source-base identities before constraints and generic-argument prerequisites.
   Publish a selected nominal base before awaiting that base's remaining header contracts.
   Plain nominal type arguments use declared identities; only qualifier lookup requires their header readiness.
   Complete constructed base signatures later; nominal identity alone does not publish header or member readiness.
   Resolve each header once in its captured declaration scope, package, tree, unsafe context, and type-parameter context.
   Publish resolved source and imported bases before attribute name resolution.
   Publish declared interface identities and the compiler-owned data equality interface before generic constraint validation.
   Schedule enclosing type-parameter constraints independently, without requiring the enclosing body's completion.
   Schedule enclosing base headers before nested header lookup, without waiting for enclosing members.
   Complete source qualifier-container headers before binding named constraints that use inherited nested types.
   Bind each complete constraint contract once, before the declaration's own base clauses.
   Apply qualifier prerequisites throughout base/interface clauses, including nested type arguments.
   Use the binder's lexical, arity-aware lookup for prerequisite discovery and actual type binding.
   Resolve each nested segment through its selected container, preserving all preceding segment arities.
   Read identifier token values, not escaped source spellings, throughout prerequisite lookup.
   Read declared shared-member names for hiding before complete member contracts exist.
   Complete referenced source type headers before their identities prove imported generic constraints.
   Drain source headers in declaration order after aliases exist and before shell attributes or delegate signatures bind.
2. Check the completed source base relation for inheritance cycles.
   Use the existing cycle checker on the discovered work, without repeating the compilation's nested-type census.
   Retain checked acyclic results across header requests after source base identities become stable.
   Report the existing cycle diagnostic and break the offending base edge before member binding.
   Attribute applications do not create header edges and cannot create inheritance cycles.
3. Use explicit work entries for member requests and their continuations.
   Schedule source base members before derived members.
   Queue nested-body requests without recursively binding their containing declaration.
   Complete qualifier headers before binding class and interface signatures, including nested interface declarations.
   Scan signatures in their owning context; do not traverse nested declaration bodies or executable blocks.
   Publish member readiness only after the complete body has bound.
4. Bind attribute applications against completed header identity.
   Keep constructed generic application types, but read usage from definitions.
   Defer usage checks until all required source bodies are complete.
   Constructor argument encoding continues to use the completed constructor contracts before emission.
   Imported generic constraint checks share the existing deferred constraint queue.
   Drain them after source constructors, members, and interface contracts are complete.
   Validate all declaration-phase pointer pointees through the same post-member queue, including imported wrappers over source layouts.
   Forward late child-binder diagnostics to the compilation bag after child snapshots have been published.
   Partial-declaration rollback and failure cleanup apply to both source and imported checks.

All work and readiness state belongs to one declaration binder.
Restore captured contexts in `finally` blocks and clear pending work if binding fails.
Traversal uses source-ordered work entries; hash collections supply membership and lookup only.
Keep the execution-stack guard for unrelated native-stack resource failures.

The native-protocol storage query follows source base edges with a loop.
Declaration scheduling now admits deep inheritance chains that previously stopped before this query.
Other expression, syntax, storage, and type traversals remain outside this decision.

## Consequences

Valid acyclic annotation chains no longer consume one native stack segment per declaration.
Self and mutual applications remain legal and validate only complete usage contracts.
Base-member and nested-body requests use the same scheduler, independent of file order.
The scheduler requires work and header state proportional to the discovered declaration graph.
It does not introduce global caches, worker threads, compilation retries, or declaration-depth limits.

Driver tests exercise `GSharp.Compiler.Program.Main` on isolated 512 KiB workers.
They inspect emitted metadata, instantiate attributes, execute emitted methods, and verify strict IL.
Equivalent file and declaration orders must preserve contracts.
Repeated deterministic builds of the same input must emit equal bytes.

## Alternatives considered

- Increase worker stack sizes: the host controls the stack, and every larger fixed stack has another boundary.
- Schedule whole declarations recursively: conflates header identity, member readiness, and usage validation.
- Precompute dependencies from annotation spellings: aliases and generic or nested names require semantic resolution.
- Accept provisional usage defaults: can accept invalid targets or reject legal repeated applications.
- Make the entire compiler iterative: exceeds the declaration dependency scope.
