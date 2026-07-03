// <copyright file="Issue1732LoopLoweringTranslationTests.cs" company="GSharp">
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
/// Regression tests for issue #1732: two loop lowerings silently diverged from
/// C# semantics.
/// <para>
/// (1) A <c>do</c>/<c>while</c> whose condition needs a body-prologue hoist (an
/// <c>is</c>-pattern binder or a value-position assignment, issue #1723) must
/// still run the body once BEFORE the hoisted clause is evaluated — C#'s
/// <c>do</c>/<c>while</c> always tests the condition AFTER the body.
/// </para>
/// <para>
/// (2) A C-style <c>for</c> lowered to a <c>while</c> (multiple
/// declarators/incrementors, or a hoisted condition, issue #914/#1723) must
/// still run its incrementor(s) when the body executes a loop-targeting
/// <c>continue</c> — a G# <c>continue</c> is a goto straight past the WHOLE
/// lowered body (ADR-0070), so without duplicating the incrementor(s) ahead of
/// the <c>continue</c> they were silently skipped, corrupting the iteration
/// count or looping forever.
/// </para>
/// Every behavioral claim here is verified by actually compiling the translated
/// G# with the real <c>gsc</c> and running it — not just by inspecting the
/// printed text — so a regression that only breaks at runtime (e.g. an
/// infinite loop) cannot slip through a purely structural assertion.
/// </summary>
public class Issue1732LoopLoweringTranslationTests
{
    /// <summary>
    /// <c>do { bodyRuns++; } while ((n = Probe()) &lt; 0)</c>: the condition
    /// carries a value-position assignment, forcing the condition-hoist lowering
    /// (issue #1723) for the do-while. C# always runs the body once before the
    /// FIRST condition test, so <c>bodyRuns</c> must be 1 and <c>Probe</c> must
    /// have been called exactly once — and only AFTER the body ran once, not
    /// before.
    /// </summary>
    [Fact]
    public void DoWhileHoistedCondition_RunsBodyOnceBeforeFirstConditionTest()
    {
        string printed = TranslateAndValidate(@"
using System;

namespace Demo
{
    public sealed class C
    {
        private static int calls = 0;

        private static int Probe()
        {
            calls++;
            return calls;
        }

        public static void Run()
        {
            int n = 0;
            int bodyRuns = 0;
            do
            {
                bodyRuns++;
            }
            while ((n = Probe()) < 0);

            Console.WriteLine(bodyRuns + "","" + n + "","" + calls);
        }
    }
}");

        // Structural check: the hoisted assignment/break-guard trails the body
        // (do-while tail hoist), not leads it.
        Assert.Contains("} while true", printed);
        Assert.True(printed.IndexOf("bodyRuns++", StringComparison.Ordinal) <
            printed.IndexOf("n = C.Probe()", StringComparison.Ordinal));

        // Behavioral check: body ran once, Probe was called exactly once, AFTER
        // the body (a bug that hoisted the condition BEFORE the body would
        // instead report "0,1,1" or skip the body when the pre-hoisted guard's
        // stale read looked false, or call Probe twice).
        string stdout = CompileAndRun(printed, "C.Run()");
        Assert.Equal("1,1,1", stdout.Trim());
    }

    /// <summary>
    /// A C-style <c>for</c> with two declarators/incrementors (forces the
    /// while-lowering, issue #914) whose body has a loop-level <c>continue</c>.
    /// C# still runs BOTH incrementors on every <c>continue</c>; the buggy
    /// while-lowering left <c>i</c> stuck at 2 forever (an infinite loop) because
    /// the trailing incrementors were skipped. This test would hang under the
    /// pre-fix lowering; it terminates and produces the exact C# iteration
    /// count/sum under the fix.
    /// </summary>
    [Fact]
    public void ForContinue_StillRunsIncrementorsAndTerminatesWithCorrectCount()
    {
        string printed = TranslateAndValidate(@"
using System;

namespace Demo
{
    public sealed class C
    {
        public static void Run()
        {
            int sum = 0;
            int i;
            int n;
            for (i = 0, n = 0; i < 5; i++, n++)
            {
                if (i == 2)
                {
                    continue;
                }

                sum += i;
            }

            Console.WriteLine(sum + "","" + i + "","" + n);
        }
    }
}");

        string stdout = CompileAndRun(printed, "C.Run()");

        // C# baseline: i = 0..4 (5 iterations), sum skips i == 2 -> 0+1+3+4 = 8;
        // both i and n reach 5 when the loop exits normally.
        Assert.Equal("8,5,5", stdout.Trim());
    }

    /// <summary>
    /// Nested <c>for</c> loops: the INNER loop's <c>continue</c> must only skip
    /// (and still increment) the inner loop's own incrementors, never the outer
    /// loop's. The outer loop here is a plain single-incrementor <c>for</c> (the
    /// native G# <c>for</c>, unaffected by the while-lowering) wrapping an inner
    /// multi-declarator <c>for</c> that requires the fix.
    /// </summary>
    [Fact]
    public void NestedForContinue_OnlyIncrementsInnerLoop()
    {
        string printed = TranslateAndValidate(@"
using System;

namespace Demo
{
    public sealed class C
    {
        public static void Run()
        {
            int outerSum = 0;
            for (int oi = 0; oi < 3; oi++)
            {
                int ii;
                int extra;
                for (ii = 0, extra = 0; ii < 3; ii++, extra++)
                {
                    if (ii == 1)
                    {
                        continue;
                    }

                    outerSum += ii;
                }
            }

            Console.WriteLine(outerSum);
        }
    }
}");

        string stdout = CompileAndRun(printed, "C.Run()");

        // Per outer iteration the inner loop sums ii = 0, 2 (skips 1) -> 2; three
        // outer iterations -> 6. An outer-loop miscount (e.g. the inner
        // continue's rewrite leaking into the outer loop's incrementor) would
        // produce a different total or hang.
        Assert.Equal("6", stdout.Trim());
    }

    /// <summary>
    /// A single-incrementor <c>for</c> with no other reason to lower (plain
    /// condition, one declarator) uses G#'s NATIVE <c>for</c> statement, not the
    /// while-lowering — so its <c>continue</c> was never affected by this bug.
    /// Regression guard: the fix must not change this already-correct path.
    /// </summary>
    [Fact]
    public void SingleIncrementorForContinue_UsesNativeForAndIsUnaffected()
    {
        string printed = TranslateAndValidate(@"
using System;

namespace Demo
{
    public sealed class C
    {
        public static void Run()
        {
            int sum = 0;
            for (int i = 0; i < 5; i++)
            {
                if (i == 2)
                {
                    continue;
                }

                sum += i;
            }

            Console.WriteLine(sum);
        }
    }
}");

        Assert.Contains("for var i = 0", printed);
        Assert.DoesNotContain("while true {", printed);

        string stdout = CompileAndRun(printed, "C.Run()");
        Assert.Equal("8", stdout.Trim());
    }

    /// <summary>
    /// A <c>continue</c> nested inside a <c>try</c>/<c>finally</c> within a
    /// while-lowered <c>for</c>: C# runs the <c>finally</c> BEFORE the
    /// incrementors re-run, but duplicating the incrementors textually ahead of
    /// the <c>continue</c> (this fix's technique) would instead run them BEFORE
    /// the <c>finally</c> — reordering an observable side effect. This shape has
    /// no faithful lowering here, so it must surface as a visible
    /// <see cref="TranslationSeverity.Unsupported"/> diagnostic instead of
    /// silently reordering.
    /// </summary>
    [Fact]
    public void ForContinueInsideTryFinally_ReportsUnsupportedInsteadOfReordering()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Snippet.cs", @"
using System;

namespace Demo
{
    public sealed class C
    {
        public static void Run()
        {
            int i;
            int n;
            for (i = 0, n = 0; i < 3; i++, n++)
            {
                try
                {
                    if (i == 1)
                    {
                        continue;
                    }
                }
                finally
                {
                    Console.WriteLine(""finally "" + i);
                }
            }
        }
    }
}"),
        });
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        _ = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported &&
                d.Message.Contains("try") && d.Message.Contains("finally"));
    }

    /// <summary>
    /// A <c>continue</c> nested inside a <c>fixed</c> block within a
    /// while-lowered <c>for</c> (two declarators/incrementors, issue #914).
    /// Unlike <c>try</c>/<c>finally</c>, a <c>fixed</c> block has no exit-time
    /// side effect that could be reordered by duplicating the incrementors
    /// ahead of the <c>continue</c> — it only un-pins a pointer — so this shape
    /// DOES have a faithful lowering and must NOT be reported as unsupported.
    /// Pre-fix, <c>RewriteOwnLoopContinue</c> had no <see cref="FixedStatement"/>
    /// case, fell through to <c>default</c>, and left the <c>continue</c>
    /// unrewritten: both incrementors were then silently skipped, corrupting
    /// the iteration count.
    /// </summary>
    [Fact]
    public void ForContinueInsideFixed_StillRunsIncrementorsAndTerminatesWithCorrectCount()
    {
        string printed = TranslateAndValidate(@"
using System;

namespace Demo
{
    public sealed class C
    {
        public static unsafe void Run()
        {
            byte[] data = { 10, 20, 30, 40, 50 };
            int sum = 0;
            int i;
            int n;
            for (i = 0, n = 0; i < data.Length; i++, n++)
            {
                fixed (byte* p = data)
                {
                    if (i == 2)
                    {
                        continue;
                    }

                    sum += p[i];
                }
            }

            Console.WriteLine(sum + "","" + i + "","" + n);
        }
    }
}");

        // Structural check: the incrementors are duplicated INSIDE the fixed
        // block, ahead of the continue (mirroring the plain-body case).
        Assert.Contains("fixed p *uint8 = data {", printed);
        Assert.True(printed.IndexOf("i++", StringComparison.Ordinal) <
            printed.IndexOf("continue", StringComparison.Ordinal));

        string stdout = CompileAndRun(printed, "C.Run()");

        // C# baseline: i = 0..4 (5 iterations), sum skips i == 2 ->
        // 10+20+40+50 = 120; both i and n reach 5 when the loop exits normally.
        Assert.Equal("120,5,5", stdout.Trim());
    }

    private static string TranslateAndValidate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);

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
    /// it, returning stdout. Skipped (never called with a build where gsc isn't
    /// present) is not needed here: this project's own build gate always
    /// produces <c>out/bin/{config}/Compiler/gsc.dll</c> before tests run.
    /// </summary>
    private static string CompileAndRun(string printed, string callExpression)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-1732-e2e", Guid.NewGuid().ToString("N"));
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

        (int runExit, string stdout) = RunDotnet($"\"{dllPath}\"");
        Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + stdout);
        return stdout;
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
