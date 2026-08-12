// <copyright file="Issue3351IsPatternBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Binder and bound-tree coverage for issue #3351.</summary>
public sealed class Issue3351IsPatternBindingTests
{
    [Fact]
    public void IsExpression_BindsThroughPatternBinderWithBooleanResult()
    {
        const string Source = """
            let value object = "hello"
            let matched = value is string { Length: > 0 } and not nil
            """;

        var program = BindProgram(Source);
        Assert.Empty(program.Diagnostics);
        var declaration = program.Statement.Statements
            .OfType<BoundVariableDeclaration>()
            .Last();
        var expression = Assert.IsType<BoundIsExpression>(declaration.Initializer);
        var andPattern = Assert.IsType<BoundBinaryPattern>(expression.Pattern);
        var typePattern = Assert.IsType<BoundTypePattern>(andPattern.Left);

        Assert.Same(TypeSymbol.Bool, expression.Type);
        Assert.False(typePattern.HasBinding);
        Assert.NotNull(typePattern.PropertyPattern);
        Assert.Same(typePattern.Variable, andPattern.RightInputVariable);
        Assert.IsType<BoundNotPattern>(andPattern.Right);
    }

    [Fact]
    public void TypePropertyPattern_NarrowsIsExpressionReceiverInThenBody()
    {
        var diagnostics = Bind("""
            func Length(value object) int32 {
                if value is string { Length: > 0 } {
                    return value.Length
                }
                return 0
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void AndPattern_BindsRightPropertyAgainstNarrowedTypeInSwitch()
    {
        var diagnostics = Bind("""
            open class Animal { }
            class Dog : Animal {
                prop Name string { get; init; }
                func Bark() string { return Name }
            }
            func Speak(value Animal) string {
                return switch value {
                    case Dog and { Name: "Rex" }: value.Bark()
                    default: "other"
                }
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void IsExpressionBindings_ReportGS0525AtBindingName()
    {
        const string Source = """
            let value object = "hello"
            if value is text is string { }
            let values = []int32{1, 2}
            if values is [..rest] { }
            """;

        var diagnostics = Bind(Source).Where(diagnostic => diagnostic.Id == "GS0525").ToArray();

        Assert.Equal(2, diagnostics.Length);
        Assert.Equal(
            ["text", "rest"],
            diagnostics.Select(diagnostic => diagnostic.Location.Text.ToString(diagnostic.Location.Span)));
        Assert.All(
            diagnostics,
            diagnostic => Assert.Contains(
                "use 'if let' or 'guard let'",
                diagnostic.Message,
                System.StringComparison.Ordinal));
    }

    [Fact]
    public void IfLet_RemainsBindingAlternative()
    {
        var diagnostics = Bind("""
            let maybe string? = "hello"
            if let text = maybe {
                let length = text.Length
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void GeneralPatternIsExpression_IsRejectedInsideExpressionTreeWithoutCrashingLowering()
    {
        var diagnostics = Bind("""
            import System
            import System.Linq.Expressions
            let expression Expression[Func[int32, bool]] = (value int32) -> value is 1 or 2
            """);

        Assert.Contains(
            diagnostics,
            diagnostic => diagnostic.Id == "GS0473"
                && diagnostic.Message.Contains(
                    "general pattern 'is' expression",
                    System.StringComparison.Ordinal));
    }

    [Fact]
    public void BareTypeAndEnumConstPatterns_CoexistWithoutSwitchRegression()
    {
        var diagnostics = Bind("""
            enum Color { Red, Green }
            const limit = 5
            let color = Color.Red
            let value object = "hello"
            let enumLabel = switch color {
                case Color.Red: "red"
                case Color.Green: "green"
                default: "other"
            }
            let constLabel = switch 5 {
                case limit: "limit"
                default: "other"
            }
            let typeLabel = switch value {
                case string: "string"
                default: "other"
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void LocalConstSwitchPattern_RemainsValuePattern()
    {
        var diagnostics = Bind("""
            func Match(value int32) string {
                const limit = 5
                return switch value {
                    case limit: "limit"
                    default: "other"
                }
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void BareTypePatternsParticipateInSealedExhaustiveness()
    {
        var diagnostics = Bind("""
            sealed interface Shape { }
            class Circle : Shape { }
            class Square : Shape { }
            func Name(shape Shape) string {
                return switch shape {
                    case Circle: "circle"
                    case Square: "square"
                }
            }
            """);

        Assert.Empty(diagnostics);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        return Binder.BindProgram(globalScope).Diagnostics;
    }

    private static BoundProgram BindProgram(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.Empty(tree.Diagnostics);
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        Assert.Empty(globalScope.Diagnostics);
        return Binder.BindProgram(globalScope);
    }
}
