// <copyright file="BoundDefaultExpressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Unit tests for <see cref="BoundDefaultExpression"/>.
/// </summary>
public class BoundDefaultExpressionTests
{
    [Fact]
    public void BoundDefaultExpression_Has_Expected_Kind_And_Type()
    {
        var type = TypeSymbol.Int;
        var expr = new BoundDefaultExpression(null, type);

        Assert.Equal(BoundNodeKind.DefaultExpression, expr.Kind);
        Assert.Same(type, expr.Type);
    }

    [Fact]
    public void BoundDefaultExpression_With_ReferenceType_Has_Correct_Kind()
    {
        var type = TypeSymbol.String;
        var expr = new BoundDefaultExpression(null, type);

        Assert.Equal(BoundNodeKind.DefaultExpression, expr.Kind);
        Assert.Same(type, expr.Type);
    }

    [Fact]
    public void BoundDefaultExpression_With_ClrType_Preserves_Type()
    {
        var type = TypeSymbol.FromClrType(typeof(System.TimeSpan));
        var expr = new BoundDefaultExpression(null, type);

        Assert.Equal(BoundNodeKind.DefaultExpression, expr.Kind);
        Assert.Equal(typeof(System.TimeSpan), expr.Type.ClrType);
    }
}
