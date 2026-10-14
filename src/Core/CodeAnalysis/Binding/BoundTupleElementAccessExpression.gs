// <copyright file="BoundTupleElementAccessExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Access to a tuple element by 1-based `ItemN` name (Phase 4.5).
class BoundTupleElementAccessExpression : BoundExpression {
    init(syntax SyntaxNode?, receiver BoundExpression, tupleType TupleTypeSymbol, index int32) : base(syntax) {
        Receiver = receiver
        TupleType = tupleType
        Index = index
    }

    prop Receiver BoundExpression {
        get;
    }

    prop TupleType TupleTypeSymbol {
        get;
    }

    prop Index int32 {
        get;
    }

    override prop Type TypeSymbol -> TupleType.ElementTypes[Index]
    override prop Kind BoundNodeKind -> BoundNodeKind.TupleElementAccessExpression
}
