// <copyright file="Issue1732LoopLoweringTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Text
import Xunit

/// Regression tests for issue #1732: two loop lowerings silently diverged from
/// C# semantics.
///
/// (1) A `do`/`while` whose condition needs a body-prologue hoist (an
/// `is`-pattern binder or a value-position assignment, issue #1723) must
/// still run the body once BEFORE the hoisted clause is evaluated — C#'s
/// `do`/`while` always tests the condition AFTER the body.
///
/// (2) A C-style `for` lowered to a `while` (multiple
/// declarators/incrementors, or a hoisted condition, issue #914/#1723) must
/// still run its incrementor(s) when the body executes a loop-targeting
/// `continue` — a G# `continue` is a goto straight past the WHOLE
/// lowered body (ADR-0070), so without duplicating the incrementor(s) ahead of
/// the `continue` they were silently skipped, corrupting the iteration
/// count or looping forever.
///
/// Every behavioral claim here is verified by actually compiling the translated
/// G# with the real `gsc` and running it — not just by inspecting the
/// printed text — so a regression that only breaks at runtime (e.g. an
/// infinite loop) cannot slip through a purely structural assertion.
open class Issue1732LoopLoweringTranslationTests {
    /// `do { bodyRuns++; } while ((n = Probe()) < 0)`: the condition
    /// carries a value-position assignment. ADR-0161 keeps it in the native
    /// do-while condition. C# always runs the body once before the
    /// FIRST condition test, so `bodyRuns` must be 1 and `Probe` must
    /// have been called exactly once — and only AFTER the body ran once, not
    /// before.
    @Fact
    func DoWhileAssignmentCondition_RunsBodyOnceBeforeFirstConditionTest() {
        let printed = TranslateAndValidate(`
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

            Console.WriteLine(bodyRuns + "," + n + "," + calls);
        }
    }
}`)
        Assert.Contains("} while (n = Probe()) < 0", printed)
        Assert.True(
            printed.IndexOf("bodyRuns++", StringComparison.Ordinal) < printed.IndexOf(
                "n = Probe()",
                StringComparison.Ordinal
            )
        )
        // Behavioral check: body ran once, Probe was called exactly once, AFTER
        // the body (a bug that hoisted the condition BEFORE the body would
        // instead report "0,1,1" or skip the body when the pre-hoisted guard's
        // stale read looked false, or call Probe twice).
        let stdout = CompileAndRun(printed, "C.Run()")
        Assert.Equal("1,1,1", stdout.Trim())
    }

    /// A C-style `for` with two declarators/incrementors (forces the
    /// while-lowering, issue #914) whose body has a loop-level `continue`.
    /// C# still runs BOTH incrementors on every `continue`; the buggy
    /// while-lowering left `i` stuck at 2 forever (an infinite loop) because
    /// the trailing incrementors were skipped. This test would hang under the
    /// pre-fix lowering; it terminates and produces the exact C# iteration
    /// count/sum under the fix.
    @Fact
    func ForContinue_StillRunsIncrementorsAndTerminatesWithCorrectCount() {
        let printed = TranslateAndValidate(`
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

            Console.WriteLine(sum + "," + i + "," + n);
        }
    }
}`)
        let stdout = CompileAndRun(printed, "C.Run()")
        // C# baseline: i = 0..4 (5 iterations), sum skips i == 2 -> 0+1+3+4 = 8;
        // both i and n reach 5 when the loop exits normally.
        Assert.Equal("8,5,5", stdout.Trim())
    }

    /// Nested `for` loops: the INNER loop's `continue` must only skip
    /// (and still increment) the inner loop's own incrementors, never the outer
    /// loop's. The outer loop here is a plain single-incrementor `for` (the
    /// native G# `for`, unaffected by the while-lowering) wrapping an inner
    /// multi-declarator `for` that requires the fix.
    @Fact
    func NestedForContinue_OnlyIncrementsInnerLoop() {
        let printed = TranslateAndValidate(`
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
}`)
        let stdout = CompileAndRun(printed, "C.Run()")
        // Per outer iteration the inner loop sums ii = 0, 2 (skips 1) -> 2; three
        // outer iterations -> 6. An outer-loop miscount (e.g. the inner
        // continue's rewrite leaking into the outer loop's incrementor) would
        // produce a different total or hang.
        Assert.Equal("6", stdout.Trim())
    }

    /// A single-incrementor `for` with no other reason to lower (plain
    /// condition, one declarator) uses G#'s NATIVE `for` statement, not the
    /// while-lowering — so its `continue` was never affected by this bug.
    /// Regression guard: the fix must not change this already-correct path.
    @Fact
    func SingleIncrementorForContinue_UsesNativeForAndIsUnaffected() {
        let printed = TranslateAndValidate(`
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
}`)
        Assert.Contains("for var i = 0", printed)
        Assert.DoesNotContain("while true {", printed)
        let stdout = CompileAndRun(printed, "C.Run()")
        Assert.Equal("8", stdout.Trim())
    }

    /// A `continue` nested inside a `try`/`finally` within a
    /// while-lowered `for`: C# runs the `finally` BEFORE the
    /// incrementors re-run, but duplicating the incrementors textually ahead of
    /// the `continue` (this fix's technique) would instead run them BEFORE
    /// the `finally` — reordering an observable side effect. This shape has
    /// no faithful lowering here, so it must surface as a visible
    /// (cref:TranslationSeverity.Unsupported) diagnostic instead of
    /// silently reordering.
    @Fact
    func ForContinueInsideTryFinally_ReportsUnsupportedInsteadOfReordering() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `
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
                    Console.WriteLine("finally " + i);
                }
            }
        }
    }
}`)})
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let _ = CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains("try") &&
                d.Message!!.Contains("finally")
        )
    }

    /// A `continue` nested inside a `fixed` block within a
    /// while-lowered `for` (two declarators/incrementors, issue #914).
    /// Unlike `try`/`finally`, a `fixed` block has no exit-time
    /// side effect that could be reordered by duplicating the incrementors
    /// ahead of the `continue` — it only un-pins a pointer — so this shape
    /// DOES have a faithful lowering and must NOT be reported as unsupported.
    /// Pre-fix, `RewriteOwnLoopContinue` had no (cref:FixedStatement)
    /// case, fell through to `default`, and left the `continue`
    /// unrewritten: both incrementors were then silently skipped, corrupting
    /// the iteration count.
    @Fact
    func ForContinueInsideFixed_StillRunsIncrementorsAndTerminatesWithCorrectCount() {
        let printed = TranslateAndValidate(`
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

            Console.WriteLine(sum + "," + i + "," + n);
        }
    }
}`)
        // Structural check: the incrementors are duplicated INSIDE the fixed
        // block, ahead of the continue (mirroring the plain-body case).
        Assert.Contains("fixed p *uint8 = data {", printed)
        Assert.True(
            printed.IndexOf("i++", StringComparison.Ordinal) < printed.IndexOf("continue", StringComparison.Ordinal)
        )
        let stdout = CompileAndRun(printed, "C.Run()")
        // C# baseline: i = 0..4 (5 iterations), sum skips i == 2 ->
        // 10+20+40+50 = 120; both i and n reach 5 when the loop exits normally.
        Assert.Equal("120,5,5", stdout.Trim())
    }

    shared {
        private func TranslateAndValidate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }

        /// Compiles [`printed`](paramref) (with [`callExpression`](paramref)
        /// appended as a top-level entry statement) with the real `gsc` and runs
        /// it, returning stdout. Skipped (never called with a build where gsc isn't
        /// present) is not needed here: this project's own build gate always
        /// produces `out/bin/{config}/Compiler/gsc.dll` before tests run.
        private func CompileAndRun(printed string, callExpression string) string {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-1732-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let gsPath = Path.Combine(workDir, "Snippet.gs")
            let dllPath = Path.Combine(workDir, "Snippet.dll")
            File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine)
            let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"")
            Assert.True(
                compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut + `

Translated G#:
` + printed
            )
            let (runExit, stdout) = RunDotnet("\"$dllPath\"")
            Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + stdout)
            return stdout
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(psi)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
