// <copyright file="Issue3409ConditionalDefiniteAssignmentTests.cs" company="GSharp">
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

/// <summary>
/// Issue #3409 follow-on: definite assignment is tracked per branch edge of a
/// conditional (`&amp;&amp;` / `||` / `!`), so an <c>out</c> argument assigned in
/// the right operand of <c>&amp;&amp;</c> counts on the true edge (C# §9.4.4).
/// The native ADR-0166 pattern shape <c>x is T t &amp;&amp; t.TryGet(out v)</c>
/// exposed the previous conservative rule (GS0238 on the true branch).
/// </summary>
public sealed class Issue3409ConditionalDefiniteAssignmentTests
{
    private const string Prelude = """
        class Foo {
            func TryGet(name string, out value string?) bool {
                value = name
                return true
            }
        }

        """;

    [Theory]
    [InlineData("if x is Foo foo && foo.TryGet(name, out value) { return true }\n    value = nil\n    return false")]
    [InlineData("if x is Foo && (x as Foo)!!.TryGet(name, out value) { return true }\n    value = nil\n    return false")]
    [InlineData("if !(x != nil && foo.TryGet(name, out value)) { value = nil\n        return false }\n    return true")]
    [InlineData("if x == nil || !foo.TryGet(name, out value) { value = nil\n        return false }\n    return true")]
    public void OutAssignmentInShortCircuitOperand_CountsOnTheMatchingEdge(string body)
    {
        var diagnostics = Bind(Prelude + $$"""
            func Try(x object?, foo Foo, name string, out value string?) bool {
                {{body}}
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Theory]
    [InlineData("if x == nil || foo.TryGet(name, out value) { return true }\n    value = nil\n    return false")]
    [InlineData("if x != nil && foo.TryGet(name, out value) { value = nil\n        return false } else { return true }")]
    public void OutAssignmentInShortCircuitOperand_DoesNotCountOnTheOtherEdge(string body)
    {
        var diagnostics = Bind(Prelude + $$"""
            func Try(x object?, foo Foo, name string, out value string?) bool {
                {{body}}
            }
            """);

        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("GS0238", diagnostic.Id);
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
}
