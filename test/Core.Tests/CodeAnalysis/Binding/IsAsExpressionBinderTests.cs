// <copyright file="IsAsExpressionBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Unit tests for the binder's handling of expression-level <c>is</c> and <c>as</c> operators (issue #575).
/// </summary>
public class IsAsExpressionBinderTests
{
    [Fact]
    public void BoundIsExpression_HasBoolType()
    {
        var expr = new BoundIsExpression(null, new BoundLiteralExpression(null, "hello"), TypeSymbol.String);

        Assert.Equal(BoundNodeKind.IsExpression, expr.Kind);
        Assert.Same(TypeSymbol.Bool, expr.Type);
    }

    [Fact]
    public void BoundAsExpression_RefType_HasTargetType()
    {
        var targetType = TypeSymbol.String;
        var expr = new BoundAsExpression(null, new BoundLiteralExpression(null, "hello"), targetType);

        Assert.Equal(BoundNodeKind.AsExpression, expr.Kind);
        Assert.Same(targetType, expr.Type);
    }

    [Fact]
    public void BoundAsExpression_NullableValueType_HasNullableType()
    {
        var nullableInt = NullableTypeSymbol.Get(TypeSymbol.Int32);
        var expr = new BoundAsExpression(null, new BoundLiteralExpression(null, 42), nullableInt);

        Assert.Equal(BoundNodeKind.AsExpression, expr.Kind);
        Assert.Same(nullableInt, expr.Type);
    }

    [Fact]
    public void BindAsExpression_NonNullableValueType_ProducesDiagnostic()
    {
        var source = """
            let boxed object = 42
            let r = boxed as int32
            """;

        var result = Evaluate(source);
        Assert.True(
            result.Diagnostics.Any(d => d.Id == "GS0270"),
            $"Expected GS0270, got: {string.Join(", ", result.Diagnostics.Select(d => $"{d.Id}: {d.Message}"))}");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
