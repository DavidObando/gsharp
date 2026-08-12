// <copyright file="Issue3352WhileLetBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Binding, scope, flow, and lowering coverage for issue #3352.</summary>
public sealed class Issue3352WhileLetBindingTests
{
    [Fact]
    public void BindingIsNarrowedInsideBody()
    {
        var diagnostics = Bind("""
            func Lengths(value string?) int32 {
                var total = 0
                while let text = value {
                    total = total + text.Length
                    break
                }
                return total
            }
            """).Diagnostics;

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void MultipleBindingsAreNarrowedInsideBody()
    {
        var diagnostics = Bind("""
            func Combine(left string, right string) string {
                return left + right
            }

            func Run(first string?, second string?) string {
                while let left string = first, let right = second {
                    return Combine(left, right)
                }
                return ""
            }
            """).Diagnostics;

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void BindingInitializerResolvesAgainstEnclosingScope()
    {
        var diagnostics = Bind("""
            func Run(value string?) int32 {
                while let value = value {
                    return value.Length
                }
                return 0
            }
            """).Diagnostics;

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void BindingsAreNotVisibleToLaterInitializers()
    {
        var diagnostics = Bind("""
            func Run(first string?) {
                while let left = first, let right = left {
                    break
                }
            }
            """).Diagnostics;

        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0125");
    }

    [Fact]
    public void BindingDoesNotEscapeLoop()
    {
        var diagnostic = Assert.Single(Bind("""
            func Run(value string?) int32 {
                while let text = value { break }
                let escaped = text
                return 0
            }
            """).Diagnostics);

        Assert.Equal("GS0125", diagnostic.Id);
        Assert.Contains("text", diagnostic.Message);
    }

    [Fact]
    public void NonNullableInitializerReportsGS0296()
    {
        var diagnostic = Assert.Single(Bind("""
            func Run(value string) {
                while let text = value { break }
            }
            """).Diagnostics);

        Assert.Equal("GS0296", diagnostic.Id);
        Assert.Contains("'while let'", diagnostic.Message);
    }

    [Fact]
    public void NestedAndLabeledLoopsBindBreakAndContinue()
    {
        var diagnostics = Bind("""
            func Run(outerValue string?, innerValue string?) {
                outer: while let value = outerValue {
                    while let value = innerValue {
                        if value.Length == 0 { continue outer }
                        break outer
                    }
                }
            }
            """).Diagnostics;

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void LoweringPlacesBindingAtCheckLabelAfterContinue()
    {
        var program = Bind("""
            var next string? = "value"
            while let value = next {
                continue
            }
            """);
        Assert.Empty(program.Diagnostics);

        var statements = program.Statement.Statements;
        var initialGoto = statements.OfType<BoundGotoStatement>().First();
        Assert.StartsWith("check", initialGoto.Label.Name);

        var continueIndex = statements
            .Select((statement, index) => (statement, index))
            .Single(pair => pair.statement is BoundLabelStatement label &&
                label.Label.Name.StartsWith("continue", System.StringComparison.Ordinal))
            .index;
        var checkIndex = statements
            .Select((statement, index) => (statement, index))
            .Single(pair => pair.statement is BoundLabelStatement label &&
                label.Label.Name.StartsWith("check", System.StringComparison.Ordinal))
            .index;
        var breakIndex = statements
            .Select((statement, index) => (statement, index))
            .Single(pair => pair.statement is BoundLabelStatement label &&
                label.Label.Name.StartsWith("break", System.StringComparison.Ordinal))
            .index;

        Assert.True(continueIndex >= 0);
        Assert.Equal(continueIndex + 1, checkIndex);
        Assert.Equal("value", Assert.IsType<BoundVariableDeclaration>(statements[checkIndex + 1]).Variable.Name);
        Assert.StartsWith(
            "body",
            Assert.IsType<BoundConditionalGotoStatement>(statements[checkIndex + 2]).Label.Name);
        Assert.Equal(checkIndex + 3, breakIndex);
    }

    private static BoundProgram Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.Empty(tree.Diagnostics);
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return Binder.BindProgram(globalScope);
        }

        return Binder.BindProgram(globalScope);
    }
}
