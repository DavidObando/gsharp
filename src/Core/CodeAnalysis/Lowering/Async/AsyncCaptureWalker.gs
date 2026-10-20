// <copyright file="AsyncCaptureWalker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable

/// Computes the set of variables that the async state-machine rewriter must
/// hoist into fields on the synthesized state-machine type (see
/// `~/roslyn-async.md` §5). Roslyn's production implementation runs a
/// definite-assignment pass to hoist only locals that are live across a
/// suspension point. GSharp's V1 takes the simpler conservative rule used by
/// Roslyn's Debug-mode build: every parameter and every referenced
/// user-declared local in an async method body is hoisted, regardless of
/// live-range analysis. This may over-hoist (a strictly intra-statement
/// scratch local that never crosses an `await` still becomes a field)
/// but is always correct, never under-hoists, and avoids pulling in a full
/// data-flow framework before the state machine itself works.
/// @remarks Spill temps are collected into a separate, ordered field group.
/// Rectangular-array dimensions and indices can be captured before a later
/// suspension, so these synthesized values must survive like user locals.
///
/// Spill-temp detection is by name prefix ((cref:GeneratedNames.SpillTempPrefix))
/// because GSharp does not (yet) carry a synthesized-kind tag on
/// (cref:LocalVariableSymbol).
///
/// For `this` capture: the bound tree does not currently
/// distinguish instance-member field access from local access at the rewriter
/// level, so the rewriter treats every instance method as capturing
/// `this`. The walker itself does not need to detect receiver
/// references — the orchestrator sets the corresponding flag based on the
/// kickoff method's receiver.
shared class AsyncCaptureWalker {
    /// The set of variables to hoist onto the synthesized state-machine type
    /// for one kickoff async method.
    class HoistResult {
        /// Initializes a new instance of the (cref:HoistResult) class.
        /// @param parameters Parameters to hoist (always all of them in V1).
        /// @param locals User-declared locals to hoist.
        /// @param spillLocals Synthesized spill locals to hoist.
        init(
            parameters ImmutableArray[ParameterSymbol],
            locals ImmutableArray[LocalVariableSymbol],
            spillLocals ImmutableArray[LocalVariableSymbol]
        ) {
            Parameters = parameters
            Locals = locals
            SpillLocals = spillLocals
        }

        /// Gets the parameters to hoist.
        prop Parameters ImmutableArray[ParameterSymbol] {
            get;
        }

        /// Gets the user-declared locals to hoist, in first-encounter order.
        prop Locals ImmutableArray[LocalVariableSymbol] {
            get;
        }

        /// Gets synthesized spill locals that must survive suspension.
        prop SpillLocals ImmutableArray[LocalVariableSymbol] {
            get;
        }
    }

    private class ReferenceCollector : BoundTreeRewriter {
        private let seen HashSet[LocalVariableSymbol] = HashSet[LocalVariableSymbol]()
        private let fixedLocals HashSet[VariableSymbol] = HashSet[VariableSymbol]()
        private let orderedLocals List[LocalVariableSymbol] = List[LocalVariableSymbol]()
        prop Locals IReadOnlyList[LocalVariableSymbol] -> orderedLocals

        func Visit(node BoundStatement?) {
            if node != nil {
                RewriteStatement(node)
            }
        }

        protected override func RewriteVariableExpression(node BoundVariableExpression) BoundExpression {
            Record(node.Variable)
            return node
        }

        protected override func RewriteAssignmentExpression(node BoundAssignmentExpression) BoundExpression {
            Record(node.Variable)
            return base.RewriteAssignmentExpression(node)
        }

        protected override func RewriteVariableDeclaration(node BoundVariableDeclaration) BoundStatement {
            Record(node.Variable)
            return base.RewriteVariableDeclaration(node)
        }

        protected override func RewriteFixedStatement(node BoundFixedStatement) BoundStatement {
            fixedLocals.Add(node.PointerVariable)
            return base.RewriteFixedStatement(node)
        }

        /// Issue #2331 (deferred half): a parameter or local whose only
        /// reference anywhere in this async body is inside a nested lambda —
        /// including a lambda nested inside that lambda — must still
        /// contribute to the hoist set. Otherwise its value does not survive
        /// suspension across an intervening `await`: a resumed
        /// `MoveNext` call is a fresh invocation of the same method, so
        /// any variable that was not hoisted into a state-machine field is
        /// re-initialized to the CLR default instead of retaining the value
        /// it held before suspension.
        /// @remarks (cref:BoundTreeRewriter) intentionally treats a function
        /// literal as an opaque leaf (its body is a separate lexical scope),
        /// so without this override the walk above never reaches a variable
        /// read/written only inside a nested lambda body. Blindly descending
        /// into `node.Body` with <em>this</em> walker would be wrong: it
        /// would also invoke (cref:RewriteVariableDeclaration) for
        /// locals the lambda itself declares, incorrectly hoisting
        /// lambda-owned state into the outer async method's state machine
        /// and breaking the lambda's own lexical scope.
        ///
        /// Instead, this reuses the capture metadata the binder already
        /// computed: (cref:BoundFunctionLiteralExpression.CapturedVariables)
        /// lists every outer-scope variable the lambda (or any lambda
        /// transitively nested within it) needs, because
        /// `LambdaBinder.CapturedVariableCollector.RewriteFunctionLiteralExpression`
        /// already propagates a nested literal's own captures up into every
        /// enclosing literal's list (issue #503) — the exact mechanism
        /// (cref:Lowering.CaptureBoxingRewriter)'s own capture walker
        /// relies on for the same reason. (cref:LambdaCaptureCollector)
        /// additionally recurses defensively (mirroring
        /// (cref:Lowering.CaptureBoxingRewriter)'s walker) using a
        /// dedicated helper that itself never records a variable declaration,
        /// so a lambda's own locals are still never hoisted even if a future
        /// binder change stops fully flattening the capture list.
        protected override func RewriteFunctionLiteralExpression(node BoundFunctionLiteralExpression) BoundExpression {
            for captured in LambdaCaptureCollector.Collect(node) {
                Record(captured)
            }
            return node
        }

        private func Record(variable VariableSymbol) {
            if variable is LocalVariableSymbol local && !fixedLocals.Contains(variable) && seen.Add(local) {
                orderedLocals.Add(local)
            }
        }
    }

    /// Collects the set of outer-scope variables that a lambda literal — or
    /// any lambda transitively nested inside its body — captures, using only
    /// the binder-computed (cref:BoundFunctionLiteralExpression.CapturedVariables)
    /// metadata on each literal it visits (never a lambda's own local
    /// declarations or parameter reads). Mirrors
    /// `CaptureBoxingRewriter.CaptureWalker`'s defensive recursion (see
    /// #567) for the same reason: the binder already flattens transitive
    /// captures onto every enclosing literal (#503), so the recursion below
    /// is normally a no-op, but keeps this collector correct if that
    /// invariant ever changes.
    private class LambdaCaptureCollector : BoundTreeRewriter {
        private let sink HashSet[VariableSymbol] = HashSet[VariableSymbol]()

        protected override func RewriteFunctionLiteralExpression(node BoundFunctionLiteralExpression) BoundExpression {
            VisitLiteral(node)
            return node
        }

        private func VisitLiteral(node BoundFunctionLiteralExpression) {
            for captured in node.CapturedVariables {
                sink.Add(captured)
            }
            // Recurse purely to reach any further-nested BoundFunctionLiteralExpression
            // node (via this class's own RewriteFunctionLiteralExpression override
            // above). Unlike ReferenceCollector, this walker never overrides
            // RewriteVariableDeclaration/RewriteVariableExpression/RewriteAssignmentExpression,
            // so visiting the lambda's own statements cannot record its own
            // locals or parameters as captures of the enclosing async method.
            RewriteStatement(node.Body)
        }

        shared {
            /// Collects the transitive capture set for [`root`](paramref).
            /// @param root The lambda literal to start from.
            /// @returns Every outer-scope variable [`root`](paramref) or any
            /// lambda nested within it needs.
            func Collect(root BoundFunctionLiteralExpression) IReadOnlyCollection[VariableSymbol] {
                let collector = LambdaCaptureCollector()
                collector.VisitLiteral(root)
                return collector.sink
            }
        }
    }

    /// Walks [`body`](paramref) and returns the hoist set.
    /// @param body The lowered async method body.
    /// @param parameters The kickoff method's parameters.
    /// @returns The set of parameters and locals to hoist, in stable
    /// insertion order. Parameters precede locals; within each group, order
    /// matches first-encounter order in the tree walk so the synthesized
    /// type's fields have a deterministic layout.
    func Analyze(body BoundStatement, parameters ImmutableArray[ParameterSymbol]) HoistResult {
        let collector = ReferenceCollector()
        collector.Visit(body)
        let orderedLocals = ImmutableArray.CreateBuilder[LocalVariableSymbol]()
        let orderedSpillLocals = ImmutableArray.CreateBuilder[LocalVariableSymbol]()
        for local in collector.Locals {
            if local is ParameterSymbol {
                continue
            }
            // Skip ref locals (ByRef-typed) — they cannot be hoisted into fields.
            // RefInitializationHoister reconstructs their storage, or proves that
            // an opaque address has no lifetime crossing a suspension.
            if local.Type is ByRefTypeSymbol {
                continue
            }
            // Issue #4222: skip native `let ref`/`var ref` alias locals too.
            // Unlike a ByRefTypeSymbol pointer local, an alias keeps its
            // pointee type on `Type` and carries the byref-ness out of band
            // via RefKind — but the underlying CLR local slot is still a
            // managed pointer (see SlotPlanner), which the CLR forbids as a
            // state-machine field just the same. RefStructAsyncLivenessAnalyzer
            // already proved (at bind time) that this local is never live
            // across a suspension point, so leaving it un-hoisted is safe: it
            // simply stays a plain MoveNext-body local, and the existing
            // RefKind-driven ldind/stind emission handles it exactly as it
            // would in an ordinary function.
            if local.RefKind != RefKind.None {
                continue
            }
            // Skip ref-struct (ByRef-like) locals — e.g. the synthesized
            // DefaultInterpolatedStringHandler emitted for interpolated strings
            // (ADR-0055 / issue #368). A ByRef-like type cannot be an instance
            // field, so it must stay a MoveNext local. This is safe because such
            // locals are always constructed and fully consumed within a single
            // expression and never stay live across an await suspension.
            // Issue #1919: use the metadata-load-safe TypeSymbol.IsByRefLike
            // helper rather than reading Type.IsByRefLike directly. A
            // delegate-typed local (e.g. a `Func[T, Task[T]]` backing an async
            // lambda variable) whose ClrType was built by mixing the host's
            // live `typeof(Func<,>)` with a MetadataLoadContext-projected type
            // argument (gsc's `/reference:` mode) realizes as a
            // `System.Reflection.Emit.TypeBuilderInstantiation` — an
            // intentionally-tolerated cross-context artifact (see
            // Binding/Conversion.cs) whose `IsByRefLike` throws
            // NotSupportedException instead of returning a real answer.
            if TypeSymbol.IsByRefLike(local.Type) {
                continue
            }
            if local.Name.StartsWith(GeneratedNames.SpillTempPrefix, StringComparison.Ordinal) {
                orderedSpillLocals.Add(local)
            } else {
                orderedLocals.Add(local)
            }
        }
        return HoistResult(parameters, orderedLocals.ToImmutable(), orderedSpillLocals.ToImmutable())
    }
}
