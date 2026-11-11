// <copyright file="BoundTupleLiteralExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// A tuple literal expression `(e1, e2, ...)` bound to a
/// (cref:TupleTypeSymbol). Element conversions are applied at bind
/// time so the contained (cref:Elements) already match the tuple's
/// element types.
class BoundTupleLiteralExpression : BoundExpression {
    init(
        syntax SyntaxNode?,
        tupleType TupleTypeSymbol,
        elements ImmutableArray[BoundExpression],
        narrowedElementReads ImmutableArray[BoundExpression?] = default(ImmutableArray[BoundExpression?])
    ) : base(syntax) {
        TupleType = tupleType
        Elements = elements
        NarrowedElementReads = narrowedElementReads
    }

    prop TupleType TupleTypeSymbol {
        get;
    }

    prop Elements ImmutableArray[BoundExpression] {
        get;
    }

    /// Holds each element's read before the consumer chooses its type.
    internal prop NarrowedElementReads ImmutableArray[BoundExpression?] {
        get;
    }

    override prop Type TypeSymbol -> TupleType
    override prop Kind BoundNodeKind -> BoundNodeKind.TupleLiteralExpression
}
