// <copyright file="IfInitClauseTests.cs" company="GSharp">
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
/// Phase 2.5: <c>if init; cond { … }</c>. The initializer is a simple
/// statement (short-var decl, assignment, increment/decrement, or call)
/// whose scope spans both the then and else arms.
/// </summary>
public class IfInitClauseTests
{
    [Fact]
    public void IfInit_Binding_Is_Scoped_To_Arm()
    {
        Assert.Empty(Bind("func F() {\n if var x = 1; x > 0 {\n var y = x\n }\n }\n"));
    }

    [Fact]
    public void IfInit_Initializer_Not_Visible_After_Block()
    {
        var diagnostics = Bind("func F() {\n if var x = 1; x > 0 {\n }\n var y = x\n }\n");
        Assert.Contains(
            diagnostics,
            d => d.Message.Contains("doesn't exist", System.StringComparison.OrdinalIgnoreCase) ||
                 d.Message.Contains("undefined", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void IfInit_With_Else_Sees_Initializer_In_Else_Arm()
    {
        Assert.Empty(Bind("func F() {\n if var x = 1; x > 0 {\n var a = x\n } else {\n var b = x\n }\n }\n"));
    }

    [Fact]
    public void IfWithoutInit_Still_Works()
    {
        Assert.Empty(Bind("func F() {\n var x = 1\n if x > 0 {\n }\n }\n"));
    }

    [Fact]
    public void IfInit_Allows_Assignment_As_Init()
    {
        Assert.Empty(Bind("func F() {\n var x = 0\n if x = 1; x > 0 {\n }\n }\n"));
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
