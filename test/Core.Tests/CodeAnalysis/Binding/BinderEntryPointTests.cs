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
        // ADR-0066 D6: GS0166 is a warning, not an error — the synthesized
        // TLS entry point wins and the explicit Main is shadowed.
        Assert.Contains(globalScope.Diagnostics, IsTopLevelMainConflictWarning);
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
    public void TopLevel_Statements_From_Multiple_Files_Concatenate_In_Path_Sorted_Order()
    {
        // ADR-0066 §2 (D7 accepted): when TLS span multiple files in the
        // entry-point package, the binder sorts contributing files by
        // SourceText.FileName (case-sensitive ordinal) before iterating, so
        // cross-file TLS ordering is identical regardless of how the
        // compilation receives the syntax trees. Within each file,
        // statements are bound in lexical source order.
        //
        // Construct the trees with explicit file names so the sort key is
        // observable, and pass them to BindGlobalScope in REVERSED order
        // to prove the binder's sort — not the caller's — chooses the
        // concatenation order.
        var a = SyntaxTree.Parse(SourceText.From("package P\nvar a1 = 1\nvar a2 = 2\n", fileName: "A.gs"));
        var b = SyntaxTree.Parse(SourceText.From("package P\nvar b1 = 3\nvar b2 = 4\n", fileName: "B.gs"));

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(b, a));

        var names = globalScope.Statements
            .OfType<BoundVariableDeclaration>()
            .Select(decl => decl.Variable.Name)
            .ToArray();

        Assert.Equal(new[] { "a1", "a2", "b1", "b2" }, names);
        Assert.DoesNotContain(globalScope.Diagnostics, IsMultiPackageTopLevel);
    }

    [Fact]
    public void TopLevel_Statements_Sort_Is_Deterministic_Across_Caller_Permutations()
    {
        // Regression guard for ADR-0066 §2 / D7: passing the same trees
        // in two different orders must produce identical bound-statement
        // ordering. Without the path-sort, the test would fail because
        // SelectMany respects input order.
        var a = SyntaxTree.Parse(SourceText.From("package P\nvar a = 1\n", fileName: "A.gs"));
        var b = SyntaxTree.Parse(SourceText.From("package P\nvar b = 2\n", fileName: "B.gs"));
        var c = SyntaxTree.Parse(SourceText.From("package P\nvar c = 3\n", fileName: "C.gs"));

        var ordering1 = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(a, b, c))
            .Statements.OfType<BoundVariableDeclaration>().Select(s => s.Variable.Name).ToArray();
        var ordering2 = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(c, a, b))
            .Statements.OfType<BoundVariableDeclaration>().Select(s => s.Variable.Name).ToArray();
        var ordering3 = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(b, c, a))
            .Statements.OfType<BoundVariableDeclaration>().Select(s => s.Variable.Name).ToArray();

        Assert.Equal(new[] { "a", "b", "c" }, ordering1);
        Assert.Equal(ordering1, ordering2);
        Assert.Equal(ordering1, ordering3);
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
        // files: still GS0166 (now a warning per D6).
        var tls = SyntaxTree.Parse(SourceText.From("package P\nvar marker = 1\n"));
        var explicitMain = SyntaxTree.Parse(SourceText.From("package P\nfunc Main() {\n}\n"));

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tls, explicitMain));

        Assert.NotNull(globalScope.EntryPoint);
        Assert.Equal("<Main>$", globalScope.EntryPoint.Name);
        Assert.Contains(globalScope.Diagnostics, IsTopLevelMainConflictWarning);
    }

    [Fact]
    public void Reports_Conflict_When_TopLevel_And_Explicit_Main_Live_In_Different_Packages()
    {
        // ADR-0066 §4 / D6: GS0166 is global to the compilation. TLS in one
        // package + `func Main()` in another still conflicts; the synthesized
        // <Main>$ wins as the entry point and the diagnostic is a warning.
        var tls = SyntaxTree.Parse(SourceText.From("package P1\nvar marker = 1\n"));
        var explicitMain = SyntaxTree.Parse(SourceText.From("package P2\nfunc Main() {\n}\n"));

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tls, explicitMain));

        Assert.NotNull(globalScope.EntryPoint);
        Assert.Equal("<Main>$", globalScope.EntryPoint.Name);
        Assert.Contains(globalScope.Diagnostics, IsTopLevelMainConflictWarning);
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

    [Fact]
    public void Reports_GS0285_When_TLS_Used_In_Library_Compilation()
    {
        // ADR-0066 deferred decision D4 (mirrors C# CS8805): top-level
        // statements in a library compilation are an error. The diagnostic
        // is reported at the first global statement and the rest of the
        // flow continues — so the synthesized <Main>$ is still produced
        // and downstream consumers see a complete bound tree.
        var globalScope = BindLibrary("Console.WriteLine(\"hi\")\n");

        var libraryTlsDiagnostics = globalScope.Diagnostics
            .Where(IsTopLevelInLibrary)
            .ToArray();
        Assert.Single(libraryTlsDiagnostics);
        Assert.NotNull(globalScope.EntryPoint);
        Assert.Equal("<Main>$", globalScope.EntryPoint.Name);
    }

    [Fact]
    public void Does_Not_Report_GS0285_For_Library_Without_TLS()
    {
        // A function-only library compilation has no global statements, so
        // the D4 guard must stay silent.
        var globalScope = BindLibrary("func Helper() {\n}\n");

        Assert.DoesNotContain(globalScope.Diagnostics, IsTopLevelInLibrary);
    }

    [Fact]
    public void Does_Not_Report_GS0285_For_Exe_With_TLS()
    {
        // The default code path (isLibrary: false via BindSource) must stay
        // clean — TLS in an executable is the normal case.
        var globalScope = BindSource("Console.WriteLine(\"hi\")\n");

        Assert.DoesNotContain(globalScope.Diagnostics, IsTopLevelInLibrary);
    }

    [Fact]
    public void Synthesizes_Int_EntryPoint_When_Return_Has_Expression()
    {
        // ADR-0066 D2: any value-returning return in TLS infers `int` as the
        // synthesized entry point's return type (so the CLR can surface the
        // value as Process.ExitCode).
        var globalScope = BindSource("return 0\n");

        Assert.NotNull(globalScope.EntryPoint);
        Assert.Same(TypeSymbol.Int32, globalScope.EntryPoint.Type);
        Assert.DoesNotContain(globalScope.Diagnostics, d => d.Id == "GS0287");
    }

    [Fact]
    public void Synthesizes_Void_EntryPoint_When_Only_Bare_Return()
    {
        // ADR-0066 D2: bare `return;` keeps the synthesized entry point as
        // `void`-returning.
        var globalScope = BindSource("return\n");

        Assert.NotNull(globalScope.EntryPoint);
        Assert.Same(TypeSymbol.Void, globalScope.EntryPoint.Type);
        Assert.DoesNotContain(globalScope.Diagnostics, d => d.Id == "GS0287");
    }

    [Fact]
    public void Synthesizes_Void_EntryPoint_When_No_Return()
    {
        // ADR-0066 D2: the absence of any return keeps the synthesized
        // entry point as `void` (the default).
        var globalScope = BindSource("var n = 1\n");

        Assert.NotNull(globalScope.EntryPoint);
        Assert.Same(TypeSymbol.Void, globalScope.EntryPoint.Type);
        Assert.DoesNotContain(globalScope.Diagnostics, d => d.Id == "GS0287");
    }

    [Fact]
    public void Reports_GS0287_When_TLS_Mixes_Bare_And_Value_Returns()
    {
        // ADR-0066 D2: mixing bare `return;` and value-returning `return X`
        // in TLS reports GS0287 at the first offender. The first-seen shape
        // wins recovery. Here the first return is value-returning, so the
        // bare return is the offender and the synthesized entry point keeps
        // `int`.
        var globalScope = BindSource("if (true) { return 0 }\nreturn\n");

        Assert.NotNull(globalScope.EntryPoint);
        Assert.Same(TypeSymbol.Int32, globalScope.EntryPoint.Type);
        Assert.Single(globalScope.Diagnostics.Where(d => d.Id == "GS0287"));
    }

    [Fact]
    public void Synthesizes_Async_Task_EntryPoint_When_TLS_Awaits()
    {
        // ADR-0066 D3: a TLS source that contains `await` flips the
        // synthesized entry point's IsAsync flag. Per the async-state-machine
        // contract (ADR-0023), `Type` stays as the *element* type (Void here)
        // and `IsAsync == true` directs the lowerer to wrap the kickoff to
        // `Task` at emit time.
        var globalScope = BindSource("import System.Threading.Tasks\nawait Task.Delay(1)\n");

        Assert.NotNull(globalScope.EntryPoint);
        Assert.True(globalScope.EntryPoint.IsAsync);
        Assert.Same(TypeSymbol.Void, globalScope.EntryPoint.Type);
    }

    [Fact]
    public void Synthesizes_Async_Task_Of_Int_EntryPoint_When_TLS_Awaits_And_Returns_Int()
    {
        // ADR-0066 D3: TLS that both awaits and value-returns produces an
        // async entry point whose element type is `int` — the async-state
        // machine lowerer maps that to `Task<int>` at emit.
        var globalScope = BindSource("import System.Threading.Tasks\nawait Task.Delay(1)\nreturn 0\n");

        Assert.NotNull(globalScope.EntryPoint);
        Assert.True(globalScope.EntryPoint.IsAsync);
        Assert.Same(TypeSymbol.Int32, globalScope.EntryPoint.Type);
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }

    private static BoundGlobalScope BindLibrary(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(
            previous: null,
            ImmutableArray.Create(tree),
            references: null,
            implicitSystemImport: true,
            preprocessorSymbols: null,
            isLibrary: true);
    }

    private static bool IsMultiPackageTopLevel(Diagnostic d) => d.Id == "GS0165";

    private static bool IsTopLevelMainConflict(Diagnostic d) => d.Id == "GS0166";

    private static bool IsTopLevelInLibrary(Diagnostic d) => d.Id == "GS0285";

    private static bool IsTopLevelMainConflictWarning(Diagnostic d) =>
        d.Id == "GS0166" && d.Severity == DiagnosticSeverity.Warning;
}
