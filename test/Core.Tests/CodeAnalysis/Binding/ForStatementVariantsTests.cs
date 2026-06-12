// <copyright file="ForStatementVariantsTests.cs" company="GSharp">
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
/// Phase 2.4: <c>for cond { … }</c> (for-as-while) and the C-style
/// <c>for init; cond; post { … }</c>.
/// </summary>
public class ForStatementVariantsTests
{
    [Fact]
    public void ForCondition_Parses_And_Binds()
    {
        Assert.Empty(Bind("func F() {\n var x = 0\n for x < 3 {\n x = x + 1\n }\n }\n"));
    }

    [Fact]
    public void ForClause_Full_Parses_And_Binds()
    {
        Assert.Empty(Bind("func F() {\n for var i = 0; i < 3; i++ {\n }\n }\n"));
    }

    [Fact]
    public void ForClause_EmptyInit_EmptyPost_Binds()
    {
        Assert.Empty(Bind("func F() {\n var x = 0\n for ; x < 3; {\n x = x + 1\n }\n }\n"));
    }

    [Fact]
    public void ForClause_AllEmpty_BindsAsInfinite()
    {
        Assert.Empty(Bind("func F() {\n for ;; {\n break\n }\n }\n"));
    }

    [Fact]
    public void ForClause_Continue_Reaches_Post()
    {
        // If `continue` skipped `i++` we'd loop forever; the test just
        // checks the bound program is well-formed.
        Assert.Empty(Bind("func F() {\n for var i = 0; i < 3; i++ {\n if i == 1 { continue }\n }\n }\n"));
    }

    [Fact]
    public void ForCondition_Recognizes_Break()
    {
        Assert.Empty(Bind("func F() {\n var x = 0\n for true {\n break\n }\n }\n"));
    }

    [Fact]
    public void ForInfinite_Still_Works()
    {
        Assert.Empty(Bind("func F() {\n for {\n break\n }\n }\n"));
    }

    [Fact]
    public void ForEllipsis_Still_Works()
    {
        Assert.Empty(Bind("func F() {\n for i in 0 ... 3 {\n }\n }\n"));
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
