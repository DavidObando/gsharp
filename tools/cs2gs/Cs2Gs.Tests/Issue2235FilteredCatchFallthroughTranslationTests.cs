// <copyright file="Issue2235FilteredCatchFallthroughTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translation tests for issue #2235 (follow-up to #1724, ADR-0115 §B): a
/// <c>catch ... when (filter)</c> clause with a later sibling catch whose
/// type could also receive the exception used to block translation entirely
/// (reported unsupported) because the per-clause rethrow-on-false-filter
/// lowering would make the exception escape the whole <c>try</c> instead of
/// falling through to that sibling, as C# requires.
///
/// The fix merges the offending filtered clause and every clause after it
/// into ONE G# catch, typed at a provably-safe common type, whose body
/// manually replays C#'s top-to-bottom type-then-filter matching using
/// ordinary <c>is</c> type tests (G#'s Kotlin-style smart cast narrows the
/// shared binder inside each branch, ADR-0069) plus each clause's own filter.
/// </summary>
public class Issue2235FilteredCatchFallthroughTranslationTests
{
    /// <summary>
    /// The issue's exact repro: two back-to-back filtered
    /// <c>OperationCanceledException when (...)</c> clauses, both of which
    /// must fall through to a later <c>catch (Exception)</c> when their own
    /// filter is false. Proves the merge handles 2+ filtered clauses in a row.
    /// </summary>
    [Fact]
    public void TwoBackToBackFilteredClauses_FallThroughToLaterExceptionCatch()
    {
        string printed = TranslateUnit(@"
using System;
using System.Threading;
namespace Demo
{
    public class C
    {
        public int Run(CancellationToken ct)
        {
            try
            {
                throw new OperationCanceledException();
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return 1;
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return 2;
            }
            catch (Exception)
            {
                return 3;
            }
        }
    }
}");

        Assert.Contains("catch (ex Exception)", printed);
        Assert.Contains("ex is OperationCanceledException", printed);
        Assert.Contains("ct.IsCancellationRequested", printed);
        Assert.Contains("return 1", printed);
        Assert.Contains("return 2", printed);
        Assert.Contains("return 3", printed);

        // A CancellationToken defaults to not-requested, so `ct.IsCancellationRequested`
        // is false for the first filtered clause and its negation is true for the
        // second: the exception must fall through the first filter and be caught
        // by the second clause's body (return 2), not the first or the final
        // `catch (Exception)`.
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(System.Threading.CancellationToken()))", "2");
    }

    /// <summary>
    /// Simpler shape: a single filtered clause with one overlapping later
    /// sibling. Runtime proof both branches of the merged dispatch are live:
    /// a filter-true exception is caught by the first clause, a filter-false
    /// one falls through to the sibling.
    /// </summary>
    [Fact]
    public void SingleFilteredClause_WithOverlappingSibling_FallsThroughWhenFilterFalse()
    {
        string printed = TranslateUnit(@"
using System;
namespace Demo
{
    public class C
    {
        public int Run(bool retryable)
        {
            try
            {
                throw new InvalidOperationException(""boom"");
            }
            catch (InvalidOperationException ex) when (retryable)
            {
                return 1;
            }
            catch (Exception)
            {
                return 2;
            }
        }
    }
}");

        Assert.Contains("catch (ex Exception)", printed);
        Assert.Contains("ex is InvalidOperationException", printed);

        CompileAndRun(printed, "System.Console.WriteLine(C().Run(true))", "1");
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(false))", "2");
    }

    /// <summary>
    /// Regression guard for the EXISTING #1724 safe shape: a filtered clause
    /// with no overlapping later sibling (disjoint types) must still use the
    /// simple rethrow-if-false lowering, not the merge — no diagnostic, no
    /// merged catch.
    /// </summary>
    [Fact]
    public void FilteredClause_WithDisjointSibling_StillUsesSimpleRethrowLowering()
    {
        string printed = TranslateUnit(@"
using System;
namespace Demo
{
    public class C
    {
        public int Run(bool retryable)
        {
            try
            {
                throw new InvalidOperationException(""boom"");
            }
            catch (InvalidOperationException ex) when (retryable)
            {
                return 1;
            }
            catch (FormatException)
            {
                return 2;
            }
        }
    }
}");

        Assert.Contains("catch (ex InvalidOperationException)", printed);
        Assert.Contains("if !retryable", printed);
        Assert.Contains("throw ex", printed);
        Assert.DoesNotContain("is InvalidOperationException", printed);

        CompileAndRun(printed, "System.Console.WriteLine(C().Run(true))", "1");
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    /// <summary>
    /// Compiles <paramref name="printed"/> (with <paramref name="callExpression"/>
    /// appended as a top-level entry statement) with the real <c>gsc</c> and runs
    /// it, asserting its stdout equals <paramref name="expectedOutput"/> — proving
    /// the merged dispatch's runtime control flow (not just its shape) is correct.
    /// </summary>
    private static void CompileAndRun(string printed, string callExpression, string expectedOutput)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2235-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        string dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine);

        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut +
                "\n\nTranslated G#:\n" + printed);

        (int runExit, string runOut) = RunDotnet($"\"{dllPath}\"");
        Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + runOut);
        Assert.Equal(expectedOutput, runOut.Trim());
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
