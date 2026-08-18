// <copyright file="Issue3420VarPatternBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Binding and flow coverage for native total <c>var name</c> patterns.</summary>
public sealed class Issue3420VarPatternBindingTests
{
    private const string Shapes = """
        class Holder {
            prop Maybe string? { get; init; }
            prop Values []int32 { get; init; }
        }

        """;

    [Fact]
    public void VarBindings_KeepExactStaticInputTypesThroughNestedPatterns()
    {
        var program = BindProgram(Shapes + """
            func Use(holder Holder, reference object?, number int32?) int32 {
                if holder is { Maybe: var maybe, Values: [var first, ..] }
                    && maybe == nil {
                    return first
                }
                if reference is var captured {
                    return captured == nil ? 1 : 2
                }
                if number is var nullableNumber {
                    return nullableNumber ?? 0
                }
                return -1
            }
            """);

        Assert.Empty(program.Diagnostics);
        var patterns = FindVarPatterns(program)
            .ToDictionary(pattern => pattern.Variable!.Name);

        Assert.Equal(TypeSymbol.Int32, patterns["first"].Variable!.Type);
        AssertNullable(patterns["maybe"].Variable!.Type, TypeSymbol.String);
        AssertNullable(patterns["captured"].Variable!.Type, TypeSymbol.Object);
        AssertNullable(patterns["nullableNumber"].Variable!.Type, TypeSymbol.Int32);
        Assert.All(patterns.Values, pattern => Assert.True(pattern.Variable!.IsReadOnly));
        Assert.All(patterns.Values, pattern => Assert.False(pattern.Variable!.HasDefinitelyNonNullValue));
    }

    [Fact]
    public void VarPattern_UsesExistingDefinitelyAssignedRegions()
    {
        var diagnostics = Bind(Shapes + """
            func Use(value object?) bool {
                if value is var captured && captured == nil {
                    return true
                }
                return false
            }
            """);

        Assert.Empty(diagnostics);

        var outside = Assert.Single(Bind(Shapes + """
            func Use(value object?) bool {
                if value is var captured { }
                return captured == nil
            }
            """));
        Assert.Equal("GS0532", outside.Id);
    }

    [Theory]
    [InlineData("value is not var captured")]
    [InlineData("value is var captured or _")]
    public void VarBinding_UnderNotOrOr_ReportsGS0390(string condition)
    {
        var diagnostic = Assert.Single(Bind($$"""
            func Use(value object?) bool {
                return {{condition}}
            }
            """));

        Assert.Equal("GS0390", diagnostic.Id);
        Assert.Equal("captured", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void VarPattern_IsTotalInSwitchExpressionAndScopesGuardAndArm()
    {
        var diagnostics = Bind("""
            func Describe(value object?) string {
                return switch value {
                    case var captured when captured == nil: "nil"
                    case var captured: captured == nil ? "nil" : "value"
                }
            }
            """);

        Assert.Empty(diagnostics);
    }

    private static void AssertNullable(TypeSymbol actual, TypeSymbol expectedUnderlying)
    {
        var nullable = Assert.IsType<NullableTypeSymbol>(actual);
        Assert.Equal(expectedUnderlying, nullable.UnderlyingType);
    }

    private static IEnumerable<BoundDiscardPattern> FindVarPatterns(BoundProgram program)
    {
        var collector = new VarPatternCollector();
        foreach (var body in program.Functions.Values)
        {
            collector.VisitStatement(body);
        }

        collector.VisitStatement(program.Statement);
        return collector.Patterns;
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

    private sealed class VarPatternCollector : BoundTreeWalker
    {
        public List<BoundDiscardPattern> Patterns { get; } = new();

        public override void VisitPattern(BoundPattern node)
        {
            if (node is BoundDiscardPattern { Variable: not null } varPattern)
            {
                Patterns.Add(varPattern);
            }

            base.VisitPattern(node);
        }
    }
}
