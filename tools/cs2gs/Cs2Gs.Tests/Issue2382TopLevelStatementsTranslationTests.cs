// <copyright file="Issue2382TopLevelStatementsTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2382: cs2gs translates native C# top-level statements
/// (<c>GlobalStatementSyntax</c> — no enclosing class/method syntax at all, as
/// opposed to an explicit <c>Main</c> method hoisted by
/// <c>CSharpToGSharpTranslator.DeclarationVisitor.TranslateEntryType</c>,
/// which issue #1904's tests already cover) directly to G# native top-level
/// statements (ADR-0066): the implicit <c>args</c> binding, top-level
/// <c>await</c>, a top-level <c>return</c>, ordinary declarations/control
/// flow, and top-level local functions — hoisted to a genuine top-level
/// <c>func</c> sibling when capture-free (unlocking unrestricted forward/
/// mutual reference, unlike a <c>let</c> binding) or kept as an ordered
/// <c>let</c> binding when a sibling top-level local (or the implicit
/// <c>args</c>) is captured.
/// <para>
/// The Oahu trigger is <c>tools/Oahu.Diagnostics/Program.cs</c>: top-level
/// statements that reference <c>args</c>, a top-level <c>await</c> + a
/// top-level <c>return</c> of an awaited call, and a trailing
/// <c>static void RenderPretty(DiagnosticReport report)</c> local function
/// with no captures. <see cref="TopLevelStatements_AsyncAwaitWithIntReturn_MatchesOahuDiagnosticsShape"/>
/// models that exact combined shape (generalized to an async, int-returning
/// hoisted helper for a stronger regression) end-to-end through the real
/// <c>gsc</c>.
/// </para>
/// </summary>
public class Issue2382TopLevelStatementsTranslationTests
{
    [Fact]
    public void SimpleSyncProgram_LowersToTopLevelStatements()
    {
        string printed = Render(@"
using System;

Console.WriteLine(""hello"");
");

        Assert.Contains("Console.WriteLine(\"hello\")", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("func Main", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("class Program", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);

        (int exit, string stdout) = CompileAndRunProgram(printed);
        Assert.Equal(0, exit);
        Assert.Equal("hello", stdout.Trim());
    }

    [Fact]
    public void ReturnInt_LowersToTopLevelReturn()
    {
        string printed = Render(@"
return 42;
");

        Assert.Contains("return 42", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);

        (int exit, _) = CompileAndRunProgram(printed);
        Assert.Equal(42, exit);
    }

    [Fact]
    public void ImplicitArgs_UsesArgsIdentifierDirectly()
    {
        string printed = Render(@"
using System;

Console.WriteLine(args.Length);
");

        Assert.Contains("args.Length", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);

        (int exit, string stdout) = CompileAndRunProgram(printed);
        Assert.Equal(0, exit);
        Assert.Equal("0", stdout.Trim());
    }

    [Fact]
    public void TopLevelAwait_LowersToTopLevelAwaitStatement()
    {
        string printed = Render(@"
using System;
using System.Threading.Tasks;

await Task.Delay(1);
Console.WriteLine(""done"");
");

        Assert.Contains("await Task.Delay(1)", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);

        (int exit, string stdout) = CompileAndRunProgram(printed);
        Assert.Equal(0, exit);
        Assert.Equal("done", stdout.Trim());
    }

    [Fact]
    public void AsyncAwaitWithIntReturn_MatchesOahuDiagnosticsShape()
    {
        // Models the exact combined Oahu.Diagnostics/Program.cs shape: a
        // top-level `await`, a top-level `return` of an awaited call — called
        // BEFORE its own declaration (mirrors `RenderPretty` appearing after
        // its call site) — through a `static` (therefore always capture-free,
        // issue #2382) async top-level local function.
        string printed = Render(@"
using System;
using System.Threading.Tasks;

Console.WriteLine(""before"");
await Task.Delay(1);
return await ComputeAsync();

static async Task<int> ComputeAsync()
{
    await Task.Delay(1);
    return 5;
}
");

        // The static local function must be hoisted to a genuine sibling
        // top-level `func` (forward-referenceable), never a `let` binding.
        Assert.DoesNotContain("let ComputeAsync", printed, StringComparison.Ordinal);
        Assert.Contains("async func ComputeAsync()", printed, StringComparison.Ordinal);
        Assert.Contains("await Task.Delay(1)", printed, StringComparison.Ordinal);
        Assert.Contains("return await ComputeAsync()", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);

        (int exit, string stdout) = CompileAndRunProgram(printed);
        Assert.Equal(5, exit);
        Assert.Equal("before", stdout.Trim());
    }

    [Fact]
    public void CaptureFreeStaticLocalFunction_HoistsToTopLevelFuncNotLetBinding()
    {
        // Mirrors Oahu.Diagnostics' trailing `static void RenderPretty(...)`:
        // called before its own textual declaration, referencing only its own
        // parameter (no sibling top-level local, no `args`).
        string printed = Render(@"
using System;

Greet(""world"");

static void Greet(string name)
{
    Console.WriteLine($""Hello, {name}!"");
}
");

        Assert.DoesNotContain("let Greet", printed, StringComparison.Ordinal);
        Assert.Contains("func Greet(name string)", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);

        (int exit, string stdout) = CompileAndRunProgram(printed);
        Assert.Equal(0, exit);
        Assert.Equal("Hello, world!", stdout.Trim());
    }

    [Fact]
    public void NonStaticButActuallyCaptureFreeLocalFunction_IsAlsoHoisted()
    {
        // Exercises the body-walk branch of `IsTopLevelLocalFunctionCaptureFree`
        // (not just the `static`-modifier fast path): a NON-static local
        // function that nonetheless references no sibling top-level local and
        // no `args` must still be hoisted to a top-level `func`.
        string printed = Render(@"
using System;

Console.WriteLine(Square(6));

int Square(int n) => n * n;
");

        Assert.DoesNotContain("let Square", printed, StringComparison.Ordinal);
        Assert.Contains("func Square(n int32)", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);

        (int exit, string stdout) = CompileAndRunProgram(printed);
        Assert.Equal(0, exit);
        Assert.Equal("36", stdout.Trim());
    }

    [Fact]
    public void MutuallyReferencingCaptureFreeLocalFunctions_HoistToIndependentlyOrderedFuncs()
    {
        // Two `static` top-level local functions calling EACH OTHER — true
        // mutual/forward reference that a `let` binding could never support
        // (see Cs2Gs.Tests.LocalFunctionHoistTranslationTests.
        // Issue2231MutualRecursionRemainsUnsupportedByGscLetBindings). Hoisting
        // to genuine top-level `func`s (pre-declared in binding scope
        // regardless of textual order, ADR-0066) fixes this for the
        // capture-free case.
        string printed = Render(@"
using System;

Console.WriteLine(IsEven(4));

static bool IsEven(int n) => n == 0 || IsOdd(n - 1);

static bool IsOdd(int n) => n != 0 && IsEven(n - 1);
");

        Assert.DoesNotContain("let IsEven", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("let IsOdd", printed, StringComparison.Ordinal);
        Assert.Contains("func IsEven(n int32)", printed, StringComparison.Ordinal);
        Assert.Contains("func IsOdd(n int32)", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);

        (int exit, string stdout) = CompileAndRunProgram(printed);
        Assert.Equal(0, exit);
        Assert.Equal("True", stdout.Trim());
    }

    [Fact]
    public void CapturingLocalFunction_StaysOrderedLetBinding()
    {
        // `Greet` reads `greeting`, a sibling top-level local — it must NOT be
        // hoisted to an independent top-level `func` (it has no implicit
        // access to a sibling top-level statement's local from there); it
        // keeps the pre-existing ordered `let`-binding closure form.
        string printed = Render(@"
using System;

var greeting = ""hello"";

void Greet()
{
    Console.WriteLine(greeting);
}

Greet();
");

        Assert.Contains("let Greet", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("func Greet(", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);

        (int exit, string stdout) = CompileAndRunProgram(printed);
        Assert.Equal(0, exit);
        Assert.Equal("hello", stdout.Trim());
    }

    [Fact]
    public void CapturingLocalFunctionCalledBeforeDeclaration_HoistsOrderedLetBindingAboveUse()
    {
        // Generalizes issue #2231's existing in-method-body hoist test to the
        // top-level-statement sequence: `Helper` is used before its textual
        // declaration and captures `seed` (a sibling top-level local) — the
        // `let Helper` binding must land above the use but below `let seed`.
        string printed = Render(@"
using System;

int seed = 5;
int result = Helper();

int Helper()
{
    return seed + 1;
}

Console.WriteLine(result);
");

        int seedIndex = printed.IndexOf("let seed", StringComparison.Ordinal);
        int declIndex = printed.IndexOf("let Helper", StringComparison.Ordinal);
        int useIndex = printed.IndexOf("Helper()", StringComparison.Ordinal);
        Assert.True(seedIndex >= 0 && declIndex >= 0 && useIndex >= 0, "All three should be present.\n" + printed);
        Assert.True(seedIndex < declIndex, "`let Helper` must not be hoisted above `let seed`.\n" + printed);
        Assert.True(declIndex < useIndex, "`let Helper` must still be hoisted above its first use.\n" + printed);
        AssertRoundTripParses(printed);

        (int exit, string stdout) = CompileAndRunProgram(printed);
        Assert.Equal(0, exit);
        Assert.Equal("6", stdout.Trim());
    }

    [Fact]
    public void GenericCaptureFreeLocalFunction_HoistsToTopLevelGenericFunc()
    {
        string printed = Render(@"
using System;

Console.WriteLine(Identity(42));

static T Identity<T>(T value) => value;
");

        Assert.DoesNotContain("let Identity", printed, StringComparison.Ordinal);
        Assert.Contains("Identity[T]", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);

        (int exit, string stdout) = CompileAndRunProgram(printed);
        Assert.Equal(0, exit);
        Assert.Equal("42", stdout.Trim());
    }

    [Fact]
    public void MixedWithExplicitMain_TopLevelStatementsWinAsEntryPoint()
    {
        // ADR-0066 D6 / C# CS7022 (a warning, not an error): a compilation
        // with BOTH top-level statements and an explicit Main-shaped method
        // anywhere still compiles — the synthesized top-level entry point
        // wins and the explicit method becomes an ordinary, never-invoked
        // static method. cs2gs must not double-hoist or crash on this shape.
        string printed = Render(
            @"
using System;

Console.WriteLine(""top-level ran"");

static class OtherEntry
{
    static void Main(string[] args)
    {
        Console.WriteLine(""explicit Main ran"");
    }
}
",
            allowNonInfoDiagnostics: true);

        Assert.Contains("Console.WriteLine(\"top-level ran\")", printed, StringComparison.Ordinal);
        Assert.Contains("Main", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);

        (int exit, string stdout) = CompileAndRunProgram(printed);
        Assert.Equal(0, exit);

        // Only the top-level statement runs; the explicit (now-orphaned)
        // `OtherEntry.Main` is never invoked by anything.
        Assert.Equal("top-level ran", stdout.Trim());
    }

    [Fact]
    public void MultipleFiles_CoexistsWithNamespaceTypeDeclaredInAnotherFile()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[]
            {
                ("Program.cs", @"
using System;
using Demo;

Console.WriteLine(Greeter.Greet(""Ada""));
"),
                ("Greeter.cs", @"
namespace Demo
{
    public static class Greeter
    {
        public static string Greet(string name) => $""Hi, {name}"";
    }
}
"),
            },
            outputKind: OutputKind.ConsoleApplication);

        Assert.True(
            project.BoundWithoutErrors,
            "inline multi-file source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(2, project.Documents.Count);

        var translator = new CSharpToGSharpTranslator();
        var printedFiles = new System.Collections.Generic.List<string>();
        foreach (LoadedDocument document in project.Documents)
        {
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            CompilationUnit unit = translator.TranslateDocument(document, context);
            Assert.DoesNotContain(context.Diagnostics, d => d.Severity != TranslationSeverity.Info);
            printedFiles.Add(GSharpPrinter.Print(unit));
        }

        string programPrinted = printedFiles[0];
        string greeterPrinted = printedFiles[1];
        Assert.Contains("Console.WriteLine(Greeter.Greet(\"Ada\"))", programPrinted, StringComparison.Ordinal);
        Assert.Contains("class Greeter", greeterPrinted, StringComparison.Ordinal);

        foreach (string printed in printedFiles)
        {
            AssertRoundTripParses(printed);
        }

        (int exit, string stdout) = CompileAndRunProgram(printedFiles.ToArray());
        Assert.Equal(0, exit);
        Assert.Equal("Hi, Ada", stdout.Trim());
    }

    private static void AssertRoundTripParses(string printed)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(printed);

        Assert.True(
            result.Success,
            "Translated G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
    }

    private static string Render(string source, bool allowNonInfoDiagnostics = false)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Program.cs", source) },
            outputKind: OutputKind.ConsoleApplication);

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        if (!allowNonInfoDiagnostics)
        {
            // The top-level-statements hoist itself always logs an Info
            // diagnostic (issue #2382, mirroring T3/ADR-0115 §B.1) — only
            // reject a genuine Warning/Unsupported here.
            Assert.DoesNotContain(context.Diagnostics, d => d.Severity != TranslationSeverity.Info);
        }

        return GSharpPrinter.Print(unit);
    }

    /// <summary>
    /// Compiles a translated top-level G# PROGRAM (already includes its own
    /// entry statements — unlike <c>LocalFunctionHoistTranslationTests
    /// .CompileAndRun</c>, no extra call expression needs to be appended)
    /// with the real <c>gsc</c> and runs it, returning the process exit code
    /// and captured stdout+stderr.
    /// </summary>
    private static (int Exit, string Stdout) CompileAndRunProgram(params string[] printedFiles)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2382-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        var gsPaths = new System.Collections.Generic.List<string>();
        for (int i = 0; i < printedFiles.Length; i++)
        {
            string gsPath = Path.Combine(workDir, $"Program{i}.gs");
            File.WriteAllText(gsPath, printedFiles[i]);
            gsPaths.Add(gsPath);
        }

        string dllPath = Path.Combine(workDir, "Program.dll");
        string quotedSources = string.Join(" ", gsPaths.Select(p => $"\"{p}\""));
        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{dllPath}\" {quotedSources}");
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated top-level program with zero errors. Output:\n" + compileOut +
                "\n\nTranslated G#:\n" + string.Join("\n---\n", printedFiles));

        return RunDotnet($"\"{dllPath}\"");
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var psi = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using var process = Process.Start(psi);
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }
}
