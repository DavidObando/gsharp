// <copyright file="BinderEntryPointTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Tests for the C#-9-style top-level-statement entry-point synthesis performed
/// by <see cref="Binder.BindGlobalScope"/>. The contract is documented in
/// <c>docs/adr/0066-top-level-statement-mechanics.md</c> (which supersedes the
/// original v0.1 sketch in <c>design/Gsharp-design-v0.1.md</c>).
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

        // ADR-0066 D1: the synthesized `<Main>$` declares a single implicit
        // `args string[]` parameter (D1 = the `static T Main(string[])`
        // shape that the .NET runtime hosts), regardless of whether the
        // user references it from the TLS body.
        Assert.Single(globalScope.EntryPoint.Parameters);
        Assert.Equal("args", globalScope.EntryPoint.Parameters[0].Name);
    }

    [Fact]
    public void Synthesizes_EntryPoint_With_Args_Parameter()
    {
        // ADR-0066 D1: the synthesized entry point's signature is always
        // `<Main>$(string[] args)`. The parameter type is the
        // SliceTypeSymbol over `string`, which the emitter projects to the
        // CLR `string[]` (single-dimensional zero-based array).
        var globalScope = BindSource("var n = 1\n");

        Assert.NotNull(globalScope.EntryPoint);
        Assert.Single(globalScope.EntryPoint.Parameters);
        var args = globalScope.EntryPoint.Parameters[0];
        Assert.Equal("args", args.Name);
        Assert.IsType<SliceTypeSymbol>(args.Type);
        Assert.Same(TypeSymbol.String, ((SliceTypeSymbol)args.Type).ElementType);
        Assert.Equal(typeof(string[]), args.Type.ClrType);
    }

    [Fact]
    public void Args_Identifier_Resolves_Inside_TLS_Body()
    {
        // ADR-0066 D1: `args` is in scope inside top-level statements; the
        // binder must resolve `args.Length` without emitting an
        // unresolved-symbol diagnostic for `args`.
        var globalScope = BindSource("var n = args.Length\n");

        Assert.DoesNotContain(
            globalScope.Diagnostics,
            d => d.Id == "GS0125" && d.Message != null && d.Message.Contains("'args'", System.StringComparison.Ordinal));
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
        Assert.Contains(globalScope.Diagnostics, IsTopLevelMainConflict);
    }

    [Fact]
    public void Reports_When_TopLevel_Statements_Span_Multiple_Packages()
    {
        // Per ADR-0066 §5 (and ADR-0028), top-level statements may span
        // multiple files *within the same package* but cannot span packages:
        // there is exactly one synthesized <Main>$ in the entry-point
        // package's <Program>.
        var tree1 = SyntaxTree.Parse(SourceText.From("package P1\nConsole.WriteLine(\"a\")\n"));
        var tree2 = SyntaxTree.Parse(SourceText.From("package P2\nConsole.WriteLine(\"b\")\n"));

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree1, tree2));

        Assert.NotNull(globalScope.EntryPoint);
        Assert.Contains(globalScope.Diagnostics, IsMultiPackageTopLevel);
    }

    [Fact]
    public void Allows_TopLevel_Statements_Across_Multiple_Files_In_Same_Package()
    {
        // Companion to Reports_When_TopLevel_Statements_Span_Multiple_Packages:
        // two files that share a package may both carry top-level statements;
        // they're concatenated into the package's synthesized <Main>$.
        var tree1 = SyntaxTree.Parse(SourceText.From("package P\nConsole.WriteLine(\"a\")\n"));
        var tree2 = SyntaxTree.Parse(SourceText.From("package P\nConsole.WriteLine(\"b\")\n"));

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree1, tree2));

        Assert.NotNull(globalScope.EntryPoint);
        // The two files only contribute Console.WriteLine calls; the only
        // diagnostics expected are the unresolved-Console messages (Console
        // isn't imported), not the multi-package conflict (ADR-0066 §5).
        Assert.DoesNotContain(globalScope.Diagnostics, IsMultiPackageTopLevel);
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

    [Fact]
    public void EntryPoint_Package_Matches_Package_That_Owns_TopLevel_Statements()
    {
        // ADR-0066 §3: the synthesized <Main>$ is owned by the TLS-bearing
        // package, regardless of what other packages the compilation also
        // declares. The non-TLS package may legally declare types/funcs.
        var typesOnly = SyntaxTree.Parse(SourceText.From("package A\nfunc Helper() {\n}\n"));
        var withTls = SyntaxTree.Parse(SourceText.From("package B\nvar marker = 42\n"));

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(typesOnly, withTls));

        Assert.NotNull(globalScope.EntryPoint);
        Assert.NotNull(globalScope.EntryPoint.Package);
        Assert.Equal("B", globalScope.EntryPoint.Package.Name);
        Assert.Equal("B", globalScope.Package.Name);
        Assert.DoesNotContain(globalScope.Diagnostics, IsMultiPackageTopLevel);
    }

    [Fact]
    public void TopLevel_Statements_From_Multiple_Files_Concatenate_In_Caller_Order()
    {
        // ADR-0066 §2: when TLS span multiple files in the entry-point
        // package, the binder concatenates statements in the order the
        // compilation supplies the syntax trees. Within each file, statements
        // are bound in lexical source order.
        //
        // The variable names below let us recover ordering from the bound
        // statement list without depending on a specific bound-tree shape
        // for expression statements.
        var first = SyntaxTree.Parse(SourceText.From("package P\nvar a1 = 1\nvar a2 = 2\n"));
        var second = SyntaxTree.Parse(SourceText.From("package P\nvar b1 = 3\nvar b2 = 4\n"));

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(first, second));

        var names = globalScope.Statements
            .OfType<BoundVariableDeclaration>()
            .Select(decl => decl.Variable.Name)
            .ToArray();

        Assert.Equal(new[] { "a1", "a2", "b1", "b2" }, names);
        Assert.DoesNotContain(globalScope.Diagnostics, IsMultiPackageTopLevel);
    }

    [Fact]
    public void Synthesized_EntryPoint_Has_Reserved_Name_That_Cannot_Be_Authored_By_Users()
    {
        // ADR-0066 §3: <Main>$ is reserved; the angle brackets and `$` are
        // not legal identifier characters in G# (the lexer treats `<` as the
        // less-than operator and `$` as a syntax error), so a user-authored
        // function cannot collide with the synthesized name.
        var globalScope = BindSource("Console.WriteLine(\"hi\")\n");

        Assert.Equal("<Main>$", globalScope.EntryPoint.Name);
        Assert.DoesNotContain(
            globalScope.Functions,
            f => f != globalScope.EntryPoint && f.Name == "<Main>$");
    }

    [Fact]
    public void Reports_When_TopLevel_Statements_Span_Three_Packages()
    {
        // Regression guard for ADR-0066 §5 — the package-distinctness check
        // must fire for 3+ packages, not just 2 (the underlying code uses
        // `Distinct(...).Length > 1`, which is correct, but worth pinning).
        var t1 = SyntaxTree.Parse(SourceText.From("package P1\nvar a = 1\n"));
        var t2 = SyntaxTree.Parse(SourceText.From("package P2\nvar b = 2\n"));
        var t3 = SyntaxTree.Parse(SourceText.From("package P3\nvar c = 3\n"));

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(t1, t2, t3));

        Assert.NotNull(globalScope.EntryPoint);
        Assert.Contains(globalScope.Diagnostics, IsMultiPackageTopLevel);
    }

    [Fact]
    public void Reports_Conflict_When_TopLevel_And_Explicit_Main_Live_In_Different_Files_Same_Package()
    {
        // ADR-0066 §4: the conflict between TLS and `func Main()` fires
        // regardless of whether they are co-located. Same package, two
        // files: still GS0166.
        var tls = SyntaxTree.Parse(SourceText.From("package P\nvar marker = 1\n"));
        var explicitMain = SyntaxTree.Parse(SourceText.From("package P\nfunc Main() {\n}\n"));

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tls, explicitMain));

        Assert.NotNull(globalScope.EntryPoint);
        Assert.Equal("<Main>$", globalScope.EntryPoint.Name);
        Assert.Contains(globalScope.Diagnostics, IsTopLevelMainConflict);
    }

    [Fact]
    public void Reports_Conflict_When_TopLevel_And_Explicit_Main_Live_In_Different_Packages()
    {
        // ADR-0066 §4: GS0166 is global to the compilation. TLS in one
        // package + `func Main()` in another still conflicts; the synthesized
        // <Main>$ wins as the entry point but the diagnostic is still fatal.
        var tls = SyntaxTree.Parse(SourceText.From("package P1\nvar marker = 1\n"));
        var explicitMain = SyntaxTree.Parse(SourceText.From("package P2\nfunc Main() {\n}\n"));

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tls, explicitMain));

        Assert.NotNull(globalScope.EntryPoint);
        Assert.Equal("<Main>$", globalScope.EntryPoint.Name);
        Assert.Contains(globalScope.Diagnostics, IsTopLevelMainConflict);
    }

    [Fact]
    public void Does_Not_Report_Multi_Package_Diagnostic_For_Many_Files_In_One_Package()
    {
        // Regression guard companion to
        // Allows_TopLevel_Statements_Across_Multiple_Files_In_Same_Package
        // and TopLevel_Statements_From_Multiple_Files_Concatenate_In_Caller_Order.
        // Five files in the same package must produce *zero* GS0165 entries.
        var trees = Enumerable.Range(0, 5)
            .Select(i => SyntaxTree.Parse(SourceText.From($"package P\nvar v{i} = {i}\n")))
            .ToImmutableArray();

        var globalScope = Binder.BindGlobalScope(previous: null, trees);

        Assert.NotNull(globalScope.EntryPoint);
        Assert.DoesNotContain(globalScope.Diagnostics, IsMultiPackageTopLevel);
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }

    private static bool IsMultiPackageTopLevel(Diagnostic d) => d.Id == "GS0165";

    private static bool IsTopLevelMainConflict(Diagnostic d) => d.Id == "GS0166";
}
