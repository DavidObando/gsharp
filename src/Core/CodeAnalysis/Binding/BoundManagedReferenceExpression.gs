// <copyright file="BoundManagedReferenceExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// An explicit persistent address, distinct from borrowed address-of.
class BoundManagedReferenceExpression : BoundExpression {
    init(
        syntax SyntaxNode?,
        location BoundExpression,
        type TypeSymbol,
        readOnly bool,
        retainForCapture bool = false
    ) : base(syntax) {
        Location = location
        _type = type
        IsReadOnly = readOnly
        RetainForCapture = retainForCapture
    }

    prop Location BoundExpression {
        get;
    }

    prop IsReadOnly bool {
        get;
    }

    prop RetainForCapture bool {
        get;
    }

    private var _type TypeSymbol
    override prop Type TypeSymbol -> _type
    override prop Kind BoundNodeKind -> BoundNodeKind.ManagedReferenceExpression
}
