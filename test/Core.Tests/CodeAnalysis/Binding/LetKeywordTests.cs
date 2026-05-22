// <copyright file="LetKeywordTests.cs" company="GSharp">
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
/// Phase 1.6: <c>let</c> introduces an immutable runtime binding. At the
/// binder level it produces a <see cref="VariableSymbol"/> with
/// <c>IsReadOnly == true</c>, indistinguishable from <c>const</c> in
/// every check that gates assignment.
/// </summary>
public class LetKeywordTests
{
    [Fact]
    public void Let_Binding_Is_ReadOnly()
    {
        var diagnostics = Bind("func F() { let x = 1\n }\n");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Assignment_To_Let_Binding_Reports_CannotAssign()
    {
        var diagnostics = Bind("func F() {\n let x = 1\n x = 2\n }\n");

        Assert.Contains(
            diagnostics,
            d => d.Message.Contains("read-only", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Let_Without_Initializer_Reports_Error()
    {
        var tree = SyntaxTree.Parse(SourceText.From("func F() {\n let x\n }\n"));
        Assert.NotEmpty(tree.Diagnostics);
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
