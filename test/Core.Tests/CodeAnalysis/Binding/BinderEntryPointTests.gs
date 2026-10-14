// <copyright file="BinderEntryPointTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Tests for the C#-9-style top-level-statement entry-point synthesis performed
/// by (cref:Binder.BindGlobalScope). The contract is documented in
/// `docs/adr/0066-top-level-statement-mechanics.md` (which supersedes the
/// original v0.1 sketch in `design/Gsharp-design-v0.1.md`).
open class BinderEntryPointTests {
    @Fact
    func Synthesizes_EntryPoint_For_TopLevel_Statements() {
        let globalScope = BindSource("Console.WriteLine(\"hi\")\n")
        Assert.NotNull(globalScope.EntryPoint)
        Assert.Equal("<Main>$$", globalScope.EntryPoint!!.Name)
        Assert.Null(globalScope.EntryPoint!!.Declaration)
        // ADR-0066 D1: the synthesized `<Main>$` declares a single implicit
        // `args string[]` parameter (D1 = the `static T Main(string[])`
        // shape that the .NET runtime hosts), regardless of whether the
        // user references it from the TLS body.
        Assert.Single(globalScope.EntryPoint!!.Parameters)
        Assert.Equal("args", globalScope.EntryPoint!!.Parameters[0].Name)
    }

    @Fact
    func Synthesizes_EntryPoint_With_Args_Parameter() {
        // ADR-0066 D1: the synthesized entry point's signature is always
        // `<Main>$(string[] args)`. The parameter type is the
        // SliceTypeSymbol over `string`, which the emitter projects to the
        // CLR `string[]` (single-dimensional zero-based array).
        let globalScope = BindSource("var n = 1\n")
        Assert.NotNull(globalScope.EntryPoint)
        Assert.Single(globalScope.EntryPoint!!.Parameters)
        let args = globalScope.EntryPoint!!.Parameters[0]
        Assert.Equal("args", args.Name)
        Assert.IsType[SliceTypeSymbol](args.Type)
        Assert.Same(TypeSymbol.String, (cast[SliceTypeSymbol](args.Type)).ElementType)
        Assert.Equal(typeof([]string), args.Type.ClrType)
    }

    @Fact
    func Args_Identifier_Resolves_Inside_TLS_Body() {
        // ADR-0066 D1: `args` is in scope inside top-level statements; the
        // binder must resolve `args.Length` without emitting an
        // unresolved-symbol diagnostic for `args`.
        let globalScope = BindSource("var n = args.Length\n")
        Assert.DoesNotContain(
            globalScope.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0125" && d.Message != nil && d.Message.Contains(
                "'args'",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func Picks_Explicit_Main_When_No_TopLevel_Statements() {
        let globalScope = BindSource(`func Main() {
}
`)
        Assert.NotNull(globalScope.EntryPoint)
        Assert.Equal("Main", globalScope.EntryPoint!!.Name)
        Assert.NotNull(globalScope.EntryPoint!!.Declaration)
    }

    @Fact
    func EntryPoint_Null_For_Library_Compilation() {
        let globalScope = BindSource(`func Helper() {
}
`)
        Assert.Null(globalScope.EntryPoint)
    }

    // Issue #1996: class-scoped static `Main` (sync or async, any class) is
    // also a valid entry-point candidate — ResolveEntryPoint must not limit
    // its search to package-scope funcs.
    @Fact
    func Picks_ClassScoped_Static_Main_When_No_TopLevel_Statements() {
        let globalScope = BindSource(`class Program
{
    shared
    {
        func Main()
        {
        }
    }
}
`)
        Assert.NotNull(globalScope.EntryPoint)
        Assert.Equal("Main", globalScope.EntryPoint!!.Name)
        Assert.True(globalScope.EntryPoint!!.IsStatic)
        Assert.False(globalScope.EntryPoint!!.IsAsync)
    }

    @Fact
    func Picks_ClassScoped_Static_Async_Main_When_No_TopLevel_Statements() {
        let globalScope = BindSource(`import System.Threading.Tasks
class Program
{
    shared
    {
        async func Main()
        {
            await Task.Delay(1)
        }
    }
}
`)
        Assert.NotNull(globalScope.EntryPoint)
        Assert.Equal("Main", globalScope.EntryPoint!!.Name)
        Assert.True(globalScope.EntryPoint!!.IsStatic)
        Assert.True(globalScope.EntryPoint!!.IsAsync)
    }

    @Fact
    func ClassScoped_Static_Main_Works_For_Any_Class_Name() {
        // Generalization: the entry-point candidate is not tied to the name
        // `Program` — any class with a static `Main` qualifies.
        let globalScope = BindSource(`class Launcher
{
    shared
    {
        func Main()
        {
        }
    }
}
`)
        Assert.NotNull(globalScope.EntryPoint)
        Assert.Equal("Main", globalScope.EntryPoint!!.Name)
    }

    @Fact
    func ClassScoped_Instance_Main_Does_Not_Qualify_As_EntryPoint() {
        // An instance `Main` has no receiver to construct at process
        // start, so it must not be picked as the entry point.
        let globalScope = BindSource(`class Program
{
    func Main()
    {
    }
}
`)
        Assert.Null(globalScope.EntryPoint)
    }

    @Fact
    func PackageScope_Main_Takes_Precedence_Over_ClassScoped_Main() {
        let globalScope = BindSource(`func Main()
{
}
class Program
{
    shared
    {
        func Main()
        {
        }
    }
}
`)
        Assert.NotNull(globalScope.EntryPoint)
        Assert.Null(globalScope.EntryPoint!!.ReceiverType)
        Assert.False(globalScope.EntryPoint!!.IsStatic)
    }

    @Fact
    func Reports_Conflict_When_TopLevel_And_Explicit_Main_Coexist() {
        let globalScope = BindSource(`Console.WriteLine("hi")
func Main() {
}
`)
        Assert.NotNull(globalScope.EntryPoint)
        Assert.Equal("<Main>$$", globalScope.EntryPoint!!.Name)
        // ADR-0066 D6: GS0166 is a warning, not an error — the synthesized
        // TLS entry point wins and the explicit Main is shadowed.
        Assert.Contains(globalScope.Diagnostics, IsTopLevelMainConflictWarning)
    }

    @Fact
    func Reports_When_TopLevel_Statements_Span_Multiple_Packages() {
        // Per ADR-0066 §5 (and ADR-0028), top-level statements may span
        // multiple files *within the same package* but cannot span packages:
        // there is exactly one synthesized <Main>$ in the entry-point
        // package's <Program>.
        let tree1 = SyntaxTree.Parse(SourceText.From(`package P1
Console.WriteLine("a")
`))
        let tree2 = SyntaxTree.Parse(SourceText.From(`package P2
Console.WriteLine("b")
`))
        let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree1, tree2))
        Assert.NotNull(globalScope.EntryPoint)
        Assert.Contains(globalScope.Diagnostics, IsMultiPackageTopLevel)
    }

    @Fact
    func Allows_TopLevel_Statements_Across_Multiple_Files_In_Same_Package() {
        // Companion to Reports_When_TopLevel_Statements_Span_Multiple_Packages:
        // two files that share a package may both carry top-level statements;
        // they're concatenated into the package's synthesized <Main>$.
        let tree1 = SyntaxTree.Parse(SourceText.From(`package P
Console.WriteLine("a")
`))
        let tree2 = SyntaxTree.Parse(SourceText.From(`package P
Console.WriteLine("b")
`))
        let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree1, tree2))
        Assert.NotNull(globalScope.EntryPoint)
        // The two files only contribute Console.WriteLine calls; the only
        // diagnostics expected are the unresolved-Console messages (Console
        // isn't imported), not the multi-package conflict (ADR-0066 §5).
        Assert.DoesNotContain(globalScope.Diagnostics, IsMultiPackageTopLevel)
    }

    @Fact
    func BindProgram_Registers_Synthesized_EntryPoint_Body_In_Functions() {
        let globalScope = BindSource("Console.WriteLine(\"hi\")\n")
        let program = Binder.BindProgram(globalScope)
        Assert.NotNull(program.EntryPoint)
        Assert.Same(globalScope.EntryPoint, program.EntryPoint)
        Assert.True(program.Functions.ContainsKey(program.EntryPoint!!))
    }

    @Fact
    func EntryPoint_Package_Matches_Package_That_Owns_TopLevel_Statements() {
        // ADR-0066 §3: the synthesized <Main>$ is owned by the TLS-bearing
        // package, regardless of what other packages the compilation also
        // declares. The non-TLS package may legally declare types/funcs.
        let typesOnly = SyntaxTree.Parse(SourceText.From(`package A
func Helper() {
}
`))
        let withTls = SyntaxTree.Parse(SourceText.From(`package B
var marker = 42
`))
        let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(typesOnly, withTls))
        Assert.NotNull(globalScope.EntryPoint)
        Assert.NotNull(globalScope.EntryPoint!!.Package)
        Assert.Equal("B", globalScope.EntryPoint!!.Package!!.Name)
        Assert.Equal("B", globalScope.Package.Name)
        Assert.DoesNotContain(globalScope.Diagnostics, IsMultiPackageTopLevel)
    }

    @Fact
    func TopLevel_Statements_From_Multiple_Files_Concatenate_In_Path_Sorted_Order() {
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
        let a = SyntaxTree.Parse(SourceText.From(`package P
var a1 = 1
var a2 = 2
`, fileName: "A.gs"))
        let b = SyntaxTree.Parse(SourceText.From(`package P
var b1 = 3
var b2 = 4
`, fileName: "B.gs"))
        let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(b, a))
        let names = globalScope
            .Statements
            .OfType[BoundVariableDeclaration]()
            .Select((decl BoundVariableDeclaration) -> decl.Variable.Name)
            .ToArray()
        Assert.Equal([]string{"a1", "a2", "b1", "b2"}, names)
        Assert.DoesNotContain(globalScope.Diagnostics, IsMultiPackageTopLevel)
    }

    @Fact
    func TopLevel_Statements_Sort_Is_Deterministic_Across_Caller_Permutations() {
        // Regression guard for ADR-0066 §2 / D7: passing the same trees
        // in two different orders must produce identical bound-statement
        // ordering. Without the path-sort, the test would fail because
        // SelectMany respects input order.
        let a = SyntaxTree.Parse(SourceText.From(`package P
var a = 1
`, fileName: "A.gs"))
        let b = SyntaxTree.Parse(SourceText.From(`package P
var b = 2
`, fileName: "B.gs"))
        let c = SyntaxTree.Parse(SourceText.From(`package P
var c = 3
`, fileName: "C.gs"))
        let ordering1 = Binder
            .BindGlobalScope(previous: nil, ImmutableArray.Create(a, b, c))
            .Statements
            .OfType[BoundVariableDeclaration]()
            .Select((s BoundVariableDeclaration) -> s.Variable.Name)
            .ToArray()
        let ordering2 = Binder
            .BindGlobalScope(previous: nil, ImmutableArray.Create(c, a, b))
            .Statements
            .OfType[BoundVariableDeclaration]()
            .Select((s BoundVariableDeclaration) -> s.Variable.Name)
            .ToArray()
        let ordering3 = Binder
            .BindGlobalScope(previous: nil, ImmutableArray.Create(b, c, a))
            .Statements
            .OfType[BoundVariableDeclaration]()
            .Select((s BoundVariableDeclaration) -> s.Variable.Name)
            .ToArray()
        Assert.Equal([]string{"a", "b", "c"}, ordering1)
        Assert.Equal(ordering1, ordering2)
        Assert.Equal(ordering1, ordering3)
    }

    @Fact
    func Synthesized_EntryPoint_Has_Reserved_Name_That_Cannot_Be_Authored_By_Users() {
        // ADR-0066 §3: <Main>$ is reserved; the angle brackets and `$` are
        // not legal identifier characters in G# (the lexer treats `<` as the
        // less-than operator and `$` as a syntax error), so a user-authored
        // function cannot collide with the synthesized name.
        let globalScope = BindSource("Console.WriteLine(\"hi\")\n")
        Assert.Equal("<Main>$$", globalScope.EntryPoint!!.Name)
        Assert.DoesNotContain(
            globalScope.Functions,
            (f FunctionSymbol) -> f != globalScope.EntryPoint && f.Name == "<Main>$$"
        )
    }

    @Fact
    func Reports_When_TopLevel_Statements_Span_Three_Packages() {
        // Regression guard for ADR-0066 §5 — the package-distinctness check
        // must fire for 3+ packages, not just 2 (the underlying code uses
        // `Distinct(...).Length > 1`, which is correct, but worth pinning).
        let t1 = SyntaxTree.Parse(SourceText.From(`package P1
var a = 1
`))
        let t2 = SyntaxTree.Parse(SourceText.From(`package P2
var b = 2
`))
        let t3 = SyntaxTree.Parse(SourceText.From(`package P3
var c = 3
`))
        let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(t1, t2, t3))
        Assert.NotNull(globalScope.EntryPoint)
        Assert.Contains(globalScope.Diagnostics, IsMultiPackageTopLevel)
    }

    @Fact
    func Reports_Conflict_When_TopLevel_And_Explicit_Main_Live_In_Different_Files_Same_Package() {
        // ADR-0066 §4: the conflict between TLS and `func Main()` fires
        // regardless of whether they are co-located. Same package, two
        // files: still GS0166 (now a warning per D6).
        let tls = SyntaxTree.Parse(SourceText.From(`package P
var marker = 1
`))
        let explicitMain = SyntaxTree.Parse(SourceText.From(`package P
func Main() {
}
`))
        let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tls, explicitMain))
        Assert.NotNull(globalScope.EntryPoint)
        Assert.Equal("<Main>$$", globalScope.EntryPoint!!.Name)
        Assert.Contains(globalScope.Diagnostics, IsTopLevelMainConflictWarning)
    }

    @Fact
    func Reports_Conflict_When_TopLevel_And_Explicit_Main_Live_In_Different_Packages() {
        // ADR-0066 §4 / D6: GS0166 is global to the compilation. TLS in one
        // package + `func Main()` in another still conflicts; the synthesized
        // <Main>$ wins as the entry point and the diagnostic is a warning.
        let tls = SyntaxTree.Parse(SourceText.From(`package P1
var marker = 1
`))
        let explicitMain = SyntaxTree.Parse(SourceText.From(`package P2
func Main() {
}
`))
        let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tls, explicitMain))
        Assert.NotNull(globalScope.EntryPoint)
        Assert.Equal("<Main>$$", globalScope.EntryPoint!!.Name)
        Assert.Contains(globalScope.Diagnostics, IsTopLevelMainConflictWarning)
    }

    @Fact
    func Does_Not_Report_Multi_Package_Diagnostic_For_Many_Files_In_One_Package() {
        // Regression guard companion to
        // Allows_TopLevel_Statements_Across_Multiple_Files_In_Same_Package
        // and TopLevel_Statements_From_Multiple_Files_Concatenate_In_Caller_Order.
        // Five files in the same package must produce *zero* GS0165 entries.
        let trees = Enumerable.Range(0, 5).Select((i int32) -> SyntaxTree.Parse(SourceText.From((`package P
var v` + "$i" + ` = ` + "$i" + `
`)))).ToImmutableArray()
        let globalScope = Binder.BindGlobalScope(previous: nil, trees)
        Assert.NotNull(globalScope.EntryPoint)
        Assert.DoesNotContain(globalScope.Diagnostics, IsMultiPackageTopLevel)
    }

    @Fact
    func Reports_GS0285_When_TLS_Used_In_Library_Compilation() {
        // ADR-0066 deferred decision D4 (mirrors C# CS8805): top-level
        // statements in a library compilation are an error. The diagnostic
        // is reported at the first global statement and the rest of the
        // flow continues — so the synthesized <Main>$ is still produced
        // and downstream consumers see a complete bound tree.
        let globalScope = BindLibrary("Console.WriteLine(\"hi\")\n")
        let libraryTlsDiagnostics = globalScope.Diagnostics.Where(IsTopLevelInLibrary).ToArray()
        Assert.Single(libraryTlsDiagnostics)
        Assert.NotNull(globalScope.EntryPoint)
        Assert.Equal("<Main>$$", globalScope.EntryPoint!!.Name)
    }

    @Fact
    func Does_Not_Report_GS0285_For_Library_Without_TLS() {
        // A function-only library compilation has no global statements, so
        // the D4 guard must stay silent.
        let globalScope = BindLibrary(`func Helper() {
}
`)
        Assert.DoesNotContain(globalScope.Diagnostics, IsTopLevelInLibrary)
    }

    @Fact
    func Does_Not_Report_GS0285_For_Exe_With_TLS() {
        // The default code path (isLibrary: false via BindSource) must stay
        // clean — TLS in an executable is the normal case.
        let globalScope = BindSource("Console.WriteLine(\"hi\")\n")
        Assert.DoesNotContain(globalScope.Diagnostics, IsTopLevelInLibrary)
    }

    @Fact
    func Synthesizes_Int_EntryPoint_When_Return_Has_Expression() {
        // ADR-0066 D2: any value-returning return in TLS infers `int` as the
        // synthesized entry point's return type (so the CLR can surface the
        // value as Process.ExitCode).
        let globalScope = BindSource("return 0\n")
        Assert.NotNull(globalScope.EntryPoint)
        Assert.Same(TypeSymbol.Int32, globalScope.EntryPoint!!.Type)
        Assert.DoesNotContain(globalScope.Diagnostics, (d Diagnostic) -> d.Id == "GS0287")
    }

    @Fact
    func Synthesizes_Void_EntryPoint_When_Only_Bare_Return() {
        // ADR-0066 D2: bare `return;` keeps the synthesized entry point as
        // `void`-returning.
        let globalScope = BindSource("return\n")
        Assert.NotNull(globalScope.EntryPoint)
        Assert.Same(TypeSymbol.Void, globalScope.EntryPoint!!.Type)
        Assert.DoesNotContain(globalScope.Diagnostics, (d Diagnostic) -> d.Id == "GS0287")
    }

    @Fact
    func Synthesizes_Void_EntryPoint_When_No_Return() {
        // ADR-0066 D2: the absence of any return keeps the synthesized
        // entry point as `void` (the default).
        let globalScope = BindSource("var n = 1\n")
        Assert.NotNull(globalScope.EntryPoint)
        Assert.Same(TypeSymbol.Void, globalScope.EntryPoint!!.Type)
        Assert.DoesNotContain(globalScope.Diagnostics, (d Diagnostic) -> d.Id == "GS0287")
    }

    @Fact
    func Reports_GS0287_When_TLS_Mixes_Bare_And_Value_Returns() {
        // ADR-0066 D2: mixing bare `return;` and value-returning `return X`
        // in TLS reports GS0287 at the first offender. The first-seen shape
        // wins recovery. Here the first return is value-returning, so the
        // bare return is the offender and the synthesized entry point keeps
        // `int`.
        let globalScope = BindSource(`if (true) { return 0 }
return
`)
        Assert.NotNull(globalScope.EntryPoint)
        Assert.Same(TypeSymbol.Int32, globalScope.EntryPoint!!.Type)
        Assert.Single(globalScope.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0287"))
    }

    @Fact
    func Synthesizes_Async_Task_EntryPoint_When_TLS_Awaits() {
        // ADR-0066 D3: a TLS source that contains `await` flips the
        // synthesized entry point's IsAsync flag. Per the async-state-machine
        // contract (ADR-0023), `Type` stays as the *element* type (Void here)
        // and `IsAsync == true` directs the lowerer to wrap the kickoff to
        // `Task` at emit time.
        let globalScope = BindSource(`import System.Threading.Tasks
await Task.Delay(1)
`)
        Assert.NotNull(globalScope.EntryPoint)
        Assert.True(globalScope.EntryPoint!!.IsAsync)
        Assert.Same(TypeSymbol.Void, globalScope.EntryPoint!!.Type)
    }

    @Fact
    func Synthesizes_Async_Task_Of_Int_EntryPoint_When_TLS_Awaits_And_Returns_Int() {
        // ADR-0066 D3: TLS that both awaits and value-returns produces an
        // async entry point whose element type is `int` — the async-state
        // machine lowerer maps that to `Task<int>` at emit.
        let globalScope = BindSource(`import System.Threading.Tasks
await Task.Delay(1)
return 0
`)
        Assert.NotNull(globalScope.EntryPoint)
        Assert.True(globalScope.EntryPoint!!.IsAsync)
        Assert.Same(TypeSymbol.Int32, globalScope.EntryPoint!!.Type)
    }

    shared {
        private func BindSource(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }

        private func BindLibrary(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(
                previous: nil,
                ImmutableArray.Create(tree),
                references: nil,
                implicitSystemImport: true,
                preprocessorSymbols: nil,
                isLibrary: true
            )
        }

        private func IsMultiPackageTopLevel(d Diagnostic) bool -> d.Id == "GS0165"

        private func IsTopLevelMainConflict(d Diagnostic) bool -> d.Id == "GS0166"

        private func IsTopLevelInLibrary(d Diagnostic) bool -> d.Id == "GS0285"

        private func IsTopLevelMainConflictWarning(d Diagnostic) bool -> d.Id == "GS0166" &&
            d.Severity == DiagnosticSeverity.Warning
    }
}
