// <copyright file="IncrementDecrementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 2.2: <c>i++</c> and <c>i--</c> are statement forms (not expressions).
/// The parser lowers them to <c>i = i +/- 1</c>.
/// </summary>
public class IncrementDecrementTests
{
    [Fact]
    public void Increment_OnIntVariable_Binds()
    {
        Assert.Empty(Bind("func F() {\n var x = 1\n x++\n }\n"));
    }

    [Fact]
    public void Decrement_OnIntVariable_Binds()
    {
        Assert.Empty(Bind("func F() {\n var x = 1\n x--\n }\n"));
    }

    [Fact]
    public void Increment_On_ReadOnly_Reports_Error()
    {
        var diagnostics = Bind("func F() {\n let x = 1\n x++\n }\n");
        Assert.Contains(
            diagnostics,
            d => d.Message.Contains("read-only", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Increment_NotAllowed_As_Expression()
    {
        // `let y = x++` should fail to parse `x++` as an expression.
        var tree = SyntaxTree.Parse(SourceText.From("func F() {\n var x = 1\n let y = x++\n }\n"));
        Assert.NotEmpty(tree.Diagnostics);
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
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

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
