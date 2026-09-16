// <copyright file="Issue4239ImplicitTopLevelLocalMutatedByLocalFunctionTests.cs" company="GSharp">
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
/// Issue #4239: a native C# top-level-statements program's implicit local
/// (<c>int value = 0;</c>) that is only ever written from INSIDE a sibling
/// local function's body was emitted as an immutable G# <c>let</c> binding,
/// because <c>TranslateTopLevelProgram</c> (unlike every other body owner —
/// see <c>TranslateBody</c>) never set <c>DocumentTranslationState
/// .CurrentBodyScope</c> before translating the entry statements. With that
/// scope left <see langword="null"/>, <c>IsLocalReassigned</c>'s underlying
/// <c>IsSymbolReassigned</c> walk short-circuited to <see langword="false"/>
/// on the null scope, so the write buried inside the local function's body
/// was never seen — the local was always bound <c>let</c>, and gsc correctly
/// rejected the local function's assignment against it with GS0127.
/// <para>
/// The fix sets <c>CurrentBodyScope</c> to the compilation-unit root (every
/// global statement, and everything nested inside them — including a local
/// function's own body — is a descendant of it) for the whole entry-point
/// translation, exactly mirroring how <c>TranslateBody</c> scopes an
/// ordinary method/constructor/lambda/local-function body to itself.
/// </para>
/// </summary>
public class Issue4239ImplicitTopLevelLocalMutatedByLocalFunctionTests
{
    [Fact]
    public void ImplicitLocalMutatedByLocalFunction_EmitsMutableBindingAndRuns()
    {
        // Exact repro from the issue.
        string printed = Render(@"
int value = 0;
void Update() { value = 1; }
Update();
System.Console.WriteLine(value);
");

        Assert.Contains("var value", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("let value", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);

        (int exit, string stdout) = CompileAndRunProgram(printed);
        Assert.Equal(0, exit);
        Assert.Equal("1", stdout.Trim());
    }

    [Fact]
    public void ImplicitLocalMutatedByLambda_EmitsMutableBindingAndRuns()
    {
        // Same root cause, different capture vector: the write lives inside a
        // lambda body assigned to a sibling top-level local, rather than
        // inside a local function's block body.
        string printed = Render(@"
using System;

int value = 0;
Action update = () => { value = 2; };
update();
Console.WriteLine(value);
");

        Assert.Contains("var value", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("let value", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);

        (int exit, string stdout) = CompileAndRunProgram(printed);
        Assert.Equal(0, exit);
        Assert.Equal("2", stdout.Trim());
    }

    [Fact]
    public void ImplicitLocalMutatedByNestedExpressionInLocalFunction_EmitsMutableBinding()
    {
        // The write is not a bare `value = ...;` statement but buried inside a
        // nested expression (a compound assignment used as a sub-expression),
        // still reachable only via the local-function body walk.
        string printed = Render(@"
using System;

int total = 0;
void Add(int amount) { Console.WriteLine(total += amount); }
Add(3);
Add(4);
Console.WriteLine(total);
");

        Assert.Contains("var total", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("let total", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);

        (int exit, string stdout) = CompileAndRunProgram(printed);
        Assert.Equal(0, exit);
        Assert.Equal("3\n7\n7", stdout.Trim().Replace("\r\n", "\n"));
    }

    [Fact]
    public void ImplicitLocalReadOnlyByLocalFunction_StaysImmutableBinding()
    {
        // Control: a sibling local function that only READS the captured
        // top-level local must keep the immutable `let` binding — the fix
        // must not widen mutability analysis, only correct it.
        string printed = Render(@"
using System;

int value = 41;
void Print() { Console.WriteLine(value + 1); }
Print();
");

        Assert.Contains("let value", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("var value", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);

        (int exit, string stdout) = CompileAndRunProgram(printed);
        Assert.Equal(0, exit);
        Assert.Equal("42", stdout.Trim());
    }

    private static void AssertRoundTripParses(string printed)
    {
        RoundTripResult result = TranslationTestValidation.ValidateRoundTripOnly(
            printed,
            "CompileAndRunProgram binds the complete emitted file set after per-file parse checks.");

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
    /// entry statements) with the real <c>gsc</c> and runs it, returning the
    /// process exit code and captured stdout+stderr.
    /// </summary>
    private static (int Exit, string Stdout) CompileAndRunProgram(params string[] printedFiles)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-4239-e2e", Guid.NewGuid().ToString("N"));
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
