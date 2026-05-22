// <copyright file="BinderEntryPointTests.cs" company="GSharp">
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
/// Tests for the C#-9-style top-level-statement entry-point synthesis performed
/// by <see cref="Binder.BindGlobalScope"/>. The rules are documented in
/// design/Gsharp-design-v0.1.md.
/// </summary>
public class BinderEntryPointTests
{
    [Fact]
    public void Synthesizes_EntryPoint_For_TopLevel_Statements()
    {
        var globalScope = BindSource("Console.WriteLine(\"hi\")\n");

        Assert.NotNull(globalScope.EntryPoint);
        Assert.Equal("<Main>$", globalScope.EntryPoint.Name);
        Assert.Null(globalScope.EntryPoint.Declaration);
        Assert.Empty(globalScope.EntryPoint.Parameters);
    }

    [Fact]
    public void Picks_Explicit_Main_When_No_TopLevel_Statements()
    {
        var globalScope = BindSource("func Main() {\n}\n");

        Assert.NotNull(globalScope.EntryPoint);
        Assert.Equal("Main", globalScope.EntryPoint.Name);
        Assert.NotNull(globalScope.EntryPoint.Declaration);
    }

    [Fact]
    public void EntryPoint_Null_For_Library_Compilation()
    {
        var globalScope = BindSource("func Helper() {\n}\n");

        Assert.Null(globalScope.EntryPoint);
    }

    [Fact]
    public void Reports_Conflict_When_TopLevel_And_Explicit_Main_Coexist()
    {
        var globalScope = BindSource("Console.WriteLine(\"hi\")\nfunc Main() {\n}\n");

        Assert.NotNull(globalScope.EntryPoint);
        Assert.Equal("<Main>$", globalScope.EntryPoint.Name);
        Assert.Contains(globalScope.Diagnostics, d => d.Message.Contains("Top-level statements cannot be used together with an explicit Main"));
    }

    [Fact]
    public void Reports_When_TopLevel_Statements_Span_Multiple_Files()
    {
        var tree1 = SyntaxTree.Parse(SourceText.From("Console.WriteLine(\"a\")\n"));
        var tree2 = SyntaxTree.Parse(SourceText.From("Console.WriteLine(\"b\")\n"));

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree1, tree2));

        Assert.NotNull(globalScope.EntryPoint);
        Assert.Contains(globalScope.Diagnostics, d => d.Message.Contains("Only one source file"));
    }

    [Fact]
    public void BindProgram_Registers_Synthesized_EntryPoint_Body_In_Functions()
    {
        var globalScope = BindSource("Console.WriteLine(\"hi\")\n");
        var program = Binder.BindProgram(globalScope);

        Assert.NotNull(program.EntryPoint);
        Assert.Same(globalScope.EntryPoint, program.EntryPoint);
        Assert.True(program.Functions.ContainsKey(program.EntryPoint));
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }
}
