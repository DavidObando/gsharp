// <copyright file="BoundBlockStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable
import System.Threading

/// Bound block statement.
class BoundBlockStatement : BoundStatement {
    private var sourceOwnership BoundSourceOwnership?

    /// Initializes a new instance of the (cref:BoundBlockStatement) class.
    /// @param syntax The originating syntax.
    /// @param statements The immutable array of bound statements.
    convenience init(syntax SyntaxNode?, statements ImmutableArray[BoundStatement]) {
        init(syntax, statements, nil)
    }

    internal init(
        syntax SyntaxNode?,
        statements ImmutableArray[BoundStatement],
        preEmitAnalysisBody BoundBlockStatement?
    ) : base(syntax) {
        Statements = statements
        PreEmitAnalysisBody = preEmitAnalysisBody
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.BlockStatement

    /// Gets the immutable array of bound statements.
    prop Statements ImmutableArray[BoundStatement] {
        get;
    }

    /// Gets the pre-emit-rewrite body used by control-flow analyses.
    internal prop PreEmitAnalysisBody BoundBlockStatement? {
        get;
    }

    /// Re-anchoring invalidates facts before changing the graph. Rewriters create fresh roots.
    internal func InvalidateSourceOwnership() -> Volatile.Write[BoundSourceOwnership?](&sourceOwnership, nil)

    internal func SetSourceOwnership(ownership BoundSourceOwnership) -> Volatile.Write[BoundSourceOwnership?](
        &sourceOwnership,
        ownership
    )

    /// Missing producer facts use the same collector without changing syntax anchors.
    internal func GetSourceOwnership() BoundSourceOwnership {
        if Volatile.Read[BoundSourceOwnership?](&sourceOwnership) is {} recorded {
            CompilationMeasurements.Count("semantic.ownership.fact-roots.reused")
            return recorded
        }
        using let measurement = CompilationMeasurements.BeginPhase("semantic.ownership.fallback")
        let collector = BoundSourceOwnership.Collector()
        collector.Visit(this)
        let ownership = collector.Complete()
        CompilationMeasurements.Count("semantic.ownership.fact-roots.fallback")
        CompilationMeasurements.Count("semantic.ownership.fallback-record-visits", ownership.RecordVisits)
        return Interlocked.CompareExchange[BoundSourceOwnership?](&sourceOwnership, ownership, nil) ?? ownership
    }
}
