// <copyright file="MultiAssignmentTests.cs" company="GSharp">
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
/// Phase 2.3: <c>a, b = b, a</c> multi-target assignment with sequential
/// evaluation via synthesized temporaries. The short-var multi-decl form
/// <c>a, b := 1, 2</c> was removed by ADR-0077 / issue #717; the parser
/// now emits GS0305 for that spelling — covered by
/// <see cref="GSharp.Core.Tests.CodeAnalysis.Syntax.Issue717ColonEqualsRemovedParserTests"/>.
/// </summary>
public class MultiAssignmentTests
{
    [Fact]
    public void MultiDecl_AsTwoVarLines_Binds()
    {
        Assert.Empty(Bind("func F() {\n var a = 1\n var b = 2\n var s = a + b\n }\n"));
    }

    [Fact]
    public void MultiAssignment_Swap_Binds()
    {
        Assert.Empty(Bind("func F() {\n var a = 1\n var b = 2\n a, b = b, a\n }\n"));
    }

    [Fact]
    public void MultiAssignment_Three_Way_Binds()
    {
        Assert.Empty(Bind("func F() {\n var a = 1\n var b = 2\n var c = 3\n a, b, c = c, a, b\n }\n"));
    }

    [Fact]
    public void MultiAssignment_Count_Mismatch_Reports_Error()
    {
        var diagnostics = Bind("func F() {\n var a = 1\n var b = 2\n a, b = 1, 2, 3\n }\n");
        Assert.Contains(diagnostics, d => d.Message.Contains("target", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void MultiAssignment_To_Readonly_Reports_Error()
    {
        var diagnostics = Bind("func F() {\n let a = 1\n var b = 2\n a, b = b, a\n }\n");
        Assert.Contains(diagnostics, d => d.Message.Contains("read-only", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void MultiAssignment_To_Undefined_Reports_Error()
    {
        var diagnostics = Bind("func F() {\n var a = 1\n a, missing = 1, 2\n }\n");
        Assert.Contains(diagnostics, d => d.Message.Contains("doesn't exist", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void MultiDecl_DifferentTypes_AsTwoVarLines_Binds()
    {
        Assert.Empty(Bind("func F() {\n var a = 1\n var b = \"two\"\n var s = b\n var n = a\n }\n"));
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
