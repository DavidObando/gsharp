// <copyright file="IncompleteAccessorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Regression tests for binding incomplete member-access expressions (e.g. <c>x.</c>)
/// that the language server hits while the user is mid-typing. Binding such input must
/// not throw — the parser already reports the missing identifier — otherwise the LSP
/// completion and semantic-tokens requests fail.
/// </summary>
public class IncompleteAccessorTests
{
    [Theory]
    [InlineData("var x int32 = 42\nx.")]
    [InlineData("var x int32 = 42\nx.\n")]
    [InlineData("var s string = \"a\"\ns.")]
    [InlineData("var x int32 = 42\nx.foo.")]
    [InlineData("var x int32 = 42\nx.\nx.\n")]
    public void IncompleteMemberAccess_DoesNotThrow(string source)
    {
        var tree = SyntaxTree.Parse(source);
        var compilation = new Compilation(tree);

        var globalScope = compilation.GlobalScope;
        Assert.NotNull(globalScope);

        var program = Binder.BindProgram(globalScope);
        Assert.NotNull(program);

        // The dangling accessor is reported as a syntax diagnostic, not a crash.
        Assert.NotEmpty(tree.Diagnostics);
    }
}
