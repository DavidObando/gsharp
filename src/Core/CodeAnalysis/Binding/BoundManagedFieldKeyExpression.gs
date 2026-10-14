// <copyright file="BoundManagedFieldKeyExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols

/// Appends a resolved field token to an immutable location key.
class BoundManagedFieldKeyExpression : BoundExpression {
    init(parent BoundExpression, field BoundExpression) : base(field.Syntax) {
        Parent = parent
        Field = field
    }

    prop Parent BoundExpression {
        get;
    }

    prop Field BoundExpression {
        get;
    }

    override prop Type TypeSymbol -> Parent.Type
    override prop Kind BoundNodeKind -> BoundNodeKind.ManagedFieldKeyExpression
}
