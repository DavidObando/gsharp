// <copyright file="Issue3399CapturingRecursiveLocalFunctionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Diagnostics
import System.IO
import System.Text
import Xunit

/// Issue #3399: C# local functions that capture locals and recurse (directly or
/// mutually) failed to translate — the canonical `let name = func ...`
/// binding a body uses to call itself is not recursive/forward-visible to gsc
/// (GS0130/GS0125). These are now lowered to G#'s nullable function-typed local
/// scheme: every strongly connected component member is first declared
/// `var Name ((…) -> R)? = nil` (all declarations precede the first
/// assignment — a G# closure body cannot reference a not-yet-declared sibling
/// local), then bound with `Name = func ...`; SCC partners are
/// referenced from inside a closure body through a postfix null assertion
/// (`Partner!!(…)`, ADR-0069). G#'s reference capture preserves C#'s
/// shared mutation of the captured sibling locals, so behavior (not just
/// binding) is preserved.
open class Issue3399CapturingRecursiveLocalFunctionTranslationTests {
    @Fact
    func SelfRecursiveCapturingLocalFunction_TranslatesAndPreservesCapture() {
        let printed = LocalFunctionHoistTranslationTests.TranslateUnit(`
namespace Demo
{
    public class C
    {
        public void M()
        {
            int sum = 0;

            void Add(int n)
            {
                if (n > 0)
                {
                    Add(n - 1);
                }

                sum++;
            }

            Add(2);
        }
    }
}`)
        // Issue #3501 A2: a DIRECT self-recursive capturing local now stays
        // on the canonical `let Add = func …` path (gsc literals see their
        // own binding) — the #3399 nullable-local scheme is reserved for
        // MUTUAL recursion.
        Assert.Contains("let Add = func", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("var Add", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Add!!(", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "C().M()")
    }

    @Fact
    func MutuallyRecursiveCapturingLocalFunctions_AllDeclaredBeforeFirstAssignment() {
        let printed = LocalFunctionHoistTranslationTests.TranslateUnit(`
namespace Demo
{
    public class C
    {
        public void M()
        {
            int calls = 0;

            void Even(int n)
            {
                calls++;
                if (n > 0)
                {
                    Odd(n - 1);
                }
            }

            void Odd(int n)
            {
                calls++;
                if (n > 0)
                {
                    Even(n - 1);
                }
            }

            Even(3);
        }
    }
}`)
        Assert.DoesNotContain("let Even", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("let Odd", printed, StringComparison.Ordinal)
        Assert.Contains("var Even", printed, StringComparison.Ordinal)
        Assert.Contains("var Odd", printed, StringComparison.Ordinal)
        Assert.Contains("Even!!(", printed, StringComparison.Ordinal)
        Assert.Contains("Odd!!(", printed, StringComparison.Ordinal)
        // Both nil-initialized declarations must precede the first literal
        // assignment of either member (G# closure bodies cannot
        // forward-reference a not-yet-declared sibling local).
        let evenDecl = IndexOf(printed, "var Even")
        let oddDecl = IndexOf(printed, "var Odd")
        let firstAssign = Math.Min(IndexOf(printed, "Even = func"), IndexOf(printed, "Odd = func"))
        Assert.True(
            evenDecl < firstAssign,
            "The whole SCC's declarations must precede its first assignment.\n" + printed
        )
        Assert.True(
            oddDecl < firstAssign,
            "The whole SCC's declarations must precede its first assignment.\n" + printed
        )
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "C().M()")
    }

    @Fact
    func NestedRecursiveCapturingLocalFunctions_ProjectRegionsShape_Translates() {
        let printed = LocalFunctionHoistTranslationTests.TranslateUnit(`
using System.Collections.Generic;
namespace Demo
{
    public class C
    {
        public List<int> Project(List<int> entries)
        {
            var builder = new List<int>();
            int choiceOrdinal = 0;
            int routeCount = 0;

            void RouteTransfer(int region, int depth)
            {
                routeCount++;
                if (depth > 0)
                {
                    NewLabel(region, depth - 1);
                }
            }

            void NewLabel(int region, int depth)
            {
                if (entries.Count > 0)
                {
                    choiceOrdinal++;
                }

                builder.Add(region + choiceOrdinal);
                if (routeCount < 2)
                {
                    CollectLabels(region, depth);
                }
            }

            void CollectLabels(int region, int depth)
            {
                if (depth > 0)
                {
                    RouteTransfer(region, 2);
                }
            }

            CollectLabels(10, 1);
            return builder;
        }
    }
}`)
        // Three-way SCC — every member goes through the nullable function-local
        // lowering; cross-sibling calls inside closure bodies carry `!!`.
        Assert.Contains("var RouteTransfer", printed, StringComparison.Ordinal)
        Assert.Contains("var NewLabel", printed, StringComparison.Ordinal)
        Assert.Contains("var CollectLabels", printed, StringComparison.Ordinal)
        Assert.Contains("NewLabel!!(", printed, StringComparison.Ordinal)
        Assert.Contains("RouteTransfer!!(", printed, StringComparison.Ordinal)
        Assert.Contains("CollectLabels!!(", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "C().Project(List[int32]())")
    }

    @Fact
    func CaptureFreeMember_HoistedByHoister_StillJoiningCapturingScc_TranslatesAndRuns() {
        // Regression guard: a SCC member that captures nothing itself must
        // STILL join the nullable function-local lowering because its SCC
        // contains a capturing member — the group lowers as one unit, and a
        // `let`/`var` mix inside one sibling group (plus the closure bodies'
        // cross-references, which the hoister may reorder) is exactly the
        // shape gsc rejects (GS0130/GS0125).
        let printed = LocalFunctionHoistTranslationTests.TranslateUnit(`
using System;
namespace Demo
{
    public class C
    {
        public void M()
        {
            int count = 0;

            void A()
            {
                B();
            }

            void B()
            {
                if (count < 2)
                {
                    count++;
                    A();
                }
            }

            A();
            System.Console.WriteLine(count);
        }
    }
}`)
        Assert.Contains("var A", printed, StringComparison.Ordinal)
        Assert.Contains("var B", printed, StringComparison.Ordinal)
        Assert.Contains("B!!(", printed, StringComparison.Ordinal)
        Assert.Contains("A!!(", printed, StringComparison.Ordinal)
        let output = CompileAndCaptureRun(printed, "C().M()")
        Assert.Contains("2", output, StringComparison.Ordinal)
    }

    @Fact
    func NonRecursiveCapturingLocalFunction_KeepsPlainLetBinding() {
        // A capturing local function that is NOT part of a recursive SCC keeps
        // the existing canonical `let` binding (no spurious nullable
        // function-local downgrade).
        let printed = LocalFunctionHoistTranslationTests.TranslateUnit(`
namespace Demo
{
    public class C
    {
        public int M()
        {
            int seed = 5;

            int Helper(int x)
            {
                return x + seed;
            }

            return Helper(1);
        }
    }
}`)
        Assert.Contains("let Helper", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "C().M()")
    }

    @Fact
    func SharedCaptureSemantics_PreservedAcrossRecursionBoundaries() {
        // The mutated scalar is captured by reference: the self-recursive body
        // and a second call must observe the SAME backing storage (C#
        // semantics) — `Add(2)` increments `sum` 3 times (n = 2, 1, 0) plus
        // one extra direct increment, so `sum` prints as 4.
        let printed = LocalFunctionHoistTranslationTests.TranslateUnit(`
using System;
namespace Demo
{
    public class C
    {
        public void M()
        {
            int sum = 0;

            void Add(int n)
            {
                if (n > 0)
                {
                    Add(n - 1);
                }

                sum++;
            }

            Add(2);
            sum++;
            System.Console.WriteLine(sum);
        }
    }
}`)
        let output = CompileAndCaptureRun(printed, "C().M()")
        Assert.Contains("4", output, StringComparison.Ordinal)
    }

    shared {
        private func IndexOf(haystack string, needle string) int32 {
            let index = haystack.IndexOf(needle, StringComparison.Ordinal)
            Assert.True(index >= 0, (`'` + "$needle" + `' should be present.
`) + haystack)
            return index
        }

        /// Same as (cref:LocalFunctionHoistTranslationTests.CompileAndRun)
        /// but returns the program's stdout so value-level assertions are
        /// possible (the shared helper only asserts a successful exit).
        private func CompileAndCaptureRun(printed string, callExpression string) string {
            let compiler string? = LocalFunctionHoistTranslationTests.FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-3399-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let gsPath = Path.Combine(workDir, "Snippet.gs")
            let dllPath = Path.Combine(workDir, "Snippet.dll")
            File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine)
            let (compileExit, compileOut) = RunLocal("\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"")
            Assert.True(
                compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut + `

Translated G#:
` + printed
            )
            let (runExit, runOut) = RunLocal("\"$dllPath\"")
            Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + runOut)
            return runOut
        }

        private func RunLocal(arguments string)(Exit int32, Output string) {
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
    }
}
