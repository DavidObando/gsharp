// <copyright file="Issue2402GenericOperatorDeclarationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public class Issue2402GenericOperatorDeclarationTests
{
    [Fact]
    public void GenericStructReceiverStyleArithmeticOperator_BindsOpenOwnerShape()
    {
        var source =
            """
            struct Box[T] {
                var Value T
                var Rank int32
            }

            func (left Box[T]) operator +(right Box[T]) Box[T] {
                return Box[T]{Value: left.Value, Rank: left.Rank + right.Rank}
            }

            42
            """;
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);

        var box = (StructSymbol)compilation.GlobalScope.Structs.Single(t => t.Name == "Box");
        var add = box.StaticMethods.Single(m => m.Name == "op_Addition");
        Assert.Same(box, add.StaticOwnerType);
        Assert.Empty(add.TypeParameters);
        AssertOpenSelfType(add.Parameters[0].Type, box);
        AssertOpenSelfType(add.Parameters[1].Type, box);
        AssertOpenSelfType(add.Type, box);
    }

    [Fact]
    public void GenericStructReceiverStyleComparisonOperator_BindsWithoutDiagnostics()
    {
        var result = Evaluate(
            """
            struct Box[T] {
                var Value T
                var Rank int32
            }

            func (left Box[T]) operator <(right Box[T]) bool {
                return left.Rank < right.Rank
            }

            true
            """);

        Assert.Empty(result.Diagnostics);
        Assert.True((bool)result.Value);
    }

    [Fact]
    public void GenericStructConversionOperators_BindOpenOwnerShapes()
    {
        var source =
            """
            struct Box[T] {
                var Value T
                var Rank int32
            }

            func operator implicit (value Box[T]) int32 {
                return value.Rank
            }

            func operator explicit (rank int32) Box[T] {
                return Box[T]{Rank: rank}
            }

            42
            """;
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);

        var box = (StructSymbol)compilation.GlobalScope.Structs.Single(t => t.Name == "Box");
        var conversion = box.StaticMethods.Single(m => m.Name == "op_Implicit");
        Assert.Same(box, conversion.StaticOwnerType);
        Assert.Empty(conversion.TypeParameters);
        AssertOpenSelfType(conversion.Parameters[0].Type, box);

        var reverseConversion = box.StaticMethods.Single(m => m.Name == "op_Explicit");
        Assert.Same(box, reverseConversion.StaticOwnerType);
        Assert.Empty(reverseConversion.TypeParameters);
        AssertOpenSelfType(reverseConversion.Type, box);
    }

    [Fact]
    public void GenericOperator_WithUndeclaredReceiverTypeArgument_ReportsUndefinedType()
    {
        var result = Evaluate(
            """
            struct Box[T] {
                var Value T
            }

            func (left Box[Missing]) operator +(right Box[Missing]) Box[Missing] {
                return left
            }
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0113");
    }

    [Fact]
    public void GenericConversionOperator_WithMultipleParameters_StillReportsGS0393()
    {
        var result = Evaluate(
            """
            struct Box[T] {
                var Value T
            }

            func operator implicit (value Box[T], extra int32) int32 {
                return extra
            }
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0393");
    }

    [Fact]
    public void ConversionOperator_WithoutSameCompilationOwner_StillReportsGS0394()
    {
        var result = Evaluate(
            """
            func operator implicit (value int32) string {
                return "invalid"
            }
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0394");
    }

    private static void AssertOpenSelfType(TypeSymbol type, StructSymbol owner)
    {
        var constructed = Assert.IsType<StructSymbol>(type);
        Assert.Same(owner, constructed.Definition);
        Assert.Single(constructed.TypeArguments);
        Assert.Same(owner.TypeParameters[0], constructed.TypeArguments[0]);
    }

    private static Compilation Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(tree);
    }

    private static EvaluationResult Evaluate(string source)
    {
        return Compile(source).Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
