// <copyright file="Issue2234IndexerMemberDeconstructAssignTranslationTests.cs" company="GSharp">
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
/// Issue #2234: a deconstruction-ASSIGNMENT whose targets are indexer
/// (<c>arr[i]</c>) or member-access (<c>obj.F</c>) expressions — e.g. the
/// classic tuple-swap-via-indexers <c>(entries[idx], entries[target]) =
/// (entries[target], entries[idx]);</c> — was gapped loudly (CS2GS-GAP) by
/// issue #1895's lowering: that lowering spills the whole right-hand side
/// FIRST into a native <c>let (t0, t1, ...) = rhs</c> binding and only then
/// writes each target, which reverses C#'s left-to-right, targets-then-value
/// evaluation order for any target with a pre-existing storage location to
/// evaluate (an indexer's receiver/index, a member access's receiver).
///
/// The fix generalizes #1895/#1974: before the RHS is spilled, every
/// indexer/member-access target's receiver (and index, for an indexer) is
/// captured into its own temp via <c>MakeDuplicationSafeTarget</c> — the SAME
/// machinery chained assignment (<c>a[F()] = b[G()] = c</c>, issue #1731)
/// already uses to make a target safe to write to without re-evaluating its
/// receiver/index. Only after every target is captured does the RHS get
/// spilled, and only then are the (now single-evaluation-safe) targets
/// written to, in left-to-right order — matching C#'s own evaluation order
/// exactly, including for a self-referential swap.
///
/// No gsc language change was needed for this: cs2gs already fully lowers a
/// deconstruction assignment to a flat sequence of gsc's EXISTING primitives
/// — a native <c>let (...) = rhs</c> tuple-deconstruction-declaration and
/// ordinary <c>target = value</c> assignment statements, which gsc already
/// accepts for any assignable target shape (identifier, indexer, member
/// access) outside of tuple deconstruction. The gap was purely in cs2gs's
/// translation-time evaluation-order handling, not in gsc's grammar.
/// </summary>
public class Issue2234IndexerMemberDeconstructAssignTranslationTests
{
    [Fact]
    public void ElementAccessTargets_MixedWithIdentifier_LowersWithoutGap()
    {
        string rendered = Render(@"
namespace Corpus.Issue2234
{
    public class Holder
    {
        public void M()
        {
            int[] arr = new int[3];
            int i = 0;
            int j = 1;
            int y = 5;
            (arr[i], arr[j], y) = (10, 20, 30);
            System.Console.WriteLine(arr[0] + arr[1] + y);
        }
    }
}
");
        AssertRoundTripParses(rendered);
        Assert.Contains("arr[i]", rendered);
        Assert.Contains("arr[j]", rendered);
    }

    [Fact]
    public void MemberAndElementAccessTargets_Mixed_LowersWithoutGap()
    {
        string rendered = Render(@"
namespace Corpus.Issue2234
{
    public class Box
    {
        public int F;
    }

    public class Holder
    {
        public void M()
        {
            var obj = new Box();
            int[] arr = new int[2];
            int i = 0;
            int a = 1;
            int b = 2;
            (obj.F, arr[i], a) = (b, obj.F, 7);
            System.Console.WriteLine(obj.F + arr[0] + a);
        }
    }
}
");
        AssertRoundTripParses(rendered);
        Assert.Contains("obj.F", rendered);
        Assert.Contains("arr[i]", rendered);
    }

    [Fact]
    public void NestedTupleTarget_WithElementAccessLeaf_LowersWithoutGap()
    {
        string rendered = Render(@"
namespace Corpus.Issue2234
{
    public class Holder
    {
        public void M()
        {
            int[] arr = new int[2];
            int i = 0;
            int c = 0;
            ((arr[i], c), c) = ((1, 2), 3);
            System.Console.WriteLine(arr[0] + c);
        }
    }
}
");
        AssertRoundTripParses(rendered);
        Assert.Contains("arr[i]", rendered);
    }

    /// <summary>
    /// The issue's exact repro: a tuple-swap performed entirely through
    /// indexer targets. Proves — by actually running the translated G#
    /// through the real <c>gsc</c> compiler — that the swap produces the
    /// CORRECT swapped values, not just that it compiles.
    /// </summary>
    [Fact]
    public void SwapViaIndexers_CompilesAndRunsWithCorrectResult()
    {
        string printed = TranslateUnit(@"
using System.Collections.Generic;
namespace Corpus.Issue2234
{
    public class Holder
    {
        public void Swap(List<int> entries, int idx, int target)
        {
            (entries[idx], entries[target]) = (entries[target], entries[idx]);
        }
    }
}");

        Assert.DoesNotContain("(entries[idx], entries[target]) =", printed);

        string output = CompileAndRunCapturingOutput(
            printed,
            "var e = List[int32]{ 1, 2, 3, 4, 5 }\n" +
            "Holder().Swap(e, 1, 3)\n" +
            "Console.WriteLine(e[0])\n" +
            "Console.WriteLine(e[1])\n" +
            "Console.WriteLine(e[3])\n" +
            "Console.WriteLine(e[4])");

        Assert.Equal("1" + Environment.NewLine + "4" + Environment.NewLine + "2" + Environment.NewLine + "5", output.Trim());
    }

    /// <summary>
    /// Proves left-to-right evaluation order is preserved for a target whose
    /// index expression has an observable side effect: C# evaluates every
    /// target's storage location (left to right) BEFORE the right-hand side
    /// (also left to right), then performs the assignments. An ordered log
    /// records the actual order the translated-and-compiled G# runs in.
    /// </summary>
    [Fact]
    public void ElementAccessTargets_SideEffectingIndices_PreserveLeftToRightEvaluationOrder()
    {
        string printed = TranslateUnit(@"
using System.Collections.Generic;
namespace Corpus.Issue2234
{
    public class Holder
    {
        public static List<string> Log = new List<string>();

        public static int Idx(string tag, int i)
        {
            Log.Add(tag);
            return i;
        }

        public static int Val(string tag, int v)
        {
            Log.Add(tag);
            return v;
        }

        public void Run(int[] arr)
        {
            (arr[Idx(""L0"", 0)], arr[Idx(""L1"", 1)]) = (Val(""R0"", 10), Val(""R1"", 20));
        }
    }
}");

        string output = CompileAndRunCapturingOutput(
            printed,
            "var arr = []int32{0, 0}\n" +
            "Holder().Run(arr)\n" +
            "Console.WriteLine(arr[0])\n" +
            "Console.WriteLine(arr[1])\n" +
            "Console.WriteLine(String.Join(\",\", Holder.Log))");

        string[] lines = output.Trim().Split(Environment.NewLine);
        Assert.Equal("10", lines[0]);
        Assert.Equal("20", lines[1]);
        Assert.Equal("L0,L1,R0,R1", lines[2]);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Empty(context.Diagnostics);
        return GSharpPrinter.Print(unit);
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
        Assert.Empty(context.Diagnostics);

        string printed = GSharpPrinter.Print(unit);
        AssertRoundTripParses(printed);
        return printed;
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    /// <summary>
    /// Compiles <paramref name="printed"/> (with <paramref name="topLevelCode"/>
    /// appended as top-level entry statements) with the real <c>gsc</c> and
    /// runs it, returning captured stdout — proving the translated snippet
    /// not only compiles but produces the correct runtime values.
    /// </summary>
    private static string CompileAndRunCapturingOutput(string printed, string topLevelCode)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2234-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        string dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(gsPath, printed + Environment.NewLine + topLevelCode + Environment.NewLine);

        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut +
                "\n\nTranslated G#:\n" + printed);

        (int runExit, string runOut) = RunDotnet($"\"{dllPath}\"");
        Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + runOut);
        return runOut;
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
