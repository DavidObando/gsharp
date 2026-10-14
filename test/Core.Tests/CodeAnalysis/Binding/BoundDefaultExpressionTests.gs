// <copyright file="BoundDefaultExpressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import Xunit

/// Unit tests for (cref:BoundDefaultExpression).
open class BoundDefaultExpressionTests {
    @Fact
    func BoundDefaultExpression_Has_Expected_Kind_And_Type() {
        let type = TypeSymbol.Int32
        let expr = BoundDefaultExpression(nil, type)
        Assert.Equal(BoundNodeKind.DefaultExpression, expr.Kind)
        Assert.Same(type, expr.Type)
    }

    @Fact
    func BoundDefaultExpression_With_ReferenceType_Has_Correct_Kind() {
        let type = TypeSymbol.String
        let expr = BoundDefaultExpression(nil, type)
        Assert.Equal(BoundNodeKind.DefaultExpression, expr.Kind)
        Assert.Same(type, expr.Type)
    }

    @Fact
    func BoundDefaultExpression_With_ClrType_Preserves_Type() {
        let type = TypeSymbol.FromClrType(typeof(TimeSpan))
        let expr = BoundDefaultExpression(nil, type)
        Assert.Equal(BoundNodeKind.DefaultExpression, expr.Kind)
        Assert.Equal(typeof(TimeSpan), expr.Type.ClrType)
    }
}
