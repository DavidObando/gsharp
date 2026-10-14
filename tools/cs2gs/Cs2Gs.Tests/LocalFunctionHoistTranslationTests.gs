// <copyright file="LocalFunctionHoistTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.IO
import Xunit

/// Translator-fidelity tests for C# local functions. C# local functions are
/// hoisted (callable before their lexical declaration), but G# renders them as
/// `let name = func(...)` bindings, which are not hoisted and generally
/// cannot be forward-referenced (GS0130/GS0125, issue #2231) — a lone
/// function-literal `let`, or one referenced before its own declaration,
/// still fails exactly as before. Issue #4219 carved out one exception: a
/// consecutive run of TWO OR MORE non-generic function-literal `let`
/// declarations (no intervening non-function `let`, no explicit outer
/// type clause) may now forward-reference and call each other, mutually
/// recursively — see
/// (cref:Issue2231MutualRecursionNowSupportedByGscLetBindings). That
/// gsc-level capability is unrelated to this file's own subject: this
/// translator still moves a referenced-before-declared local's `let`
/// binding to just before its first use — but no earlier than the last
/// sibling local it captures by closure (G# closures require captured locals
/// to already be in scope at the binding point) — rather than emitting the
/// new consecutive-group form itself.
open class LocalFunctionHoistTranslationTests {
    @Fact
    func LocalFunctionCalledBeforeDeclaration_IsHoistedToTop() {
        let printed = TranslateUnit(`
using System;

namespace Demo
{
    public class C
    {
        public int Field;
        public void M(int input)
        {
            if (input > 0)
            {
                Helper(input);
            }
            else
            {
                Helper(0);
            }

            void Helper(int x)
            {
                Field = x;
            }
        }
    }
}`)
        // The `let Helper = func ...` binding must precede the first call site.
        let declIndex = printed.IndexOf("let Helper", StringComparison.Ordinal)
        let callIndex = printed.IndexOf("Helper(input)", StringComparison.Ordinal)
        Assert.True(declIndex >= 0, "Local function should be emitted as a let binding.\n" + printed)
        Assert.True(callIndex >= 0, "Call site should be present.\n" + printed)
        Assert.True(
            declIndex < callIndex,
            "Local function declaration must be hoisted above its first use.\n" + printed
        )
    }

    @Fact
    func LocalFunctionCapturingSiblingLocal_IsHoistedAfterCaptureNotAboveIt() {
        // Issue #2231, case (c): `Helper` is used before its textual
        // declaration AND captures `seed`, a sibling local declared between
        // the original declaration position and the use. The fix must hoist
        // `let Helper` above the use but *below* `let seed` — not skip
        // hoisting altogether (which would leave the forward-reference bug
        // unfixed) and not hoist to the very top of the block (which would
        // break the `seed` capture).
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public int M()
        {
            int seed = 5;
            int result = Helper();

            int Helper()
            {
                return seed + 1;
            }

            return result;
        }
    }
}`)
        let seedIndex = printed.IndexOf("let seed", StringComparison.Ordinal)
        let declIndex = printed.IndexOf("let Helper", StringComparison.Ordinal)
        let useIndex = printed.IndexOf("Helper()", StringComparison.Ordinal)
        Assert.True(seedIndex >= 0 && declIndex >= 0 && useIndex >= 0, "All three should be present.\n" + printed)
        Assert.True(
            seedIndex < declIndex,
            "Local function capturing a sibling local must not be hoisted above it.\n" + printed
        )
        Assert.True(declIndex < useIndex, "Local function must still be hoisted above its first use.\n" + printed)
        CompileAndRun(printed, "Console.WriteLine(C().M())", "6")
    }

    @Fact
    func ExpressionBodiedLocalFunction_ReturnsConditionalValue() {
        let printed = TranslateUnit(`
using System;

namespace Demo
{
    public class C
    {
        public string M(bool first)
        {
            string Pick() => first ? "first" : "second";
            return Pick();
        }
    }
}`)
        Assert.Contains("return if first", printed, StringComparison.Ordinal)
        CompileAndRun(printed, "Console.WriteLine(C().M(true))", "first")
    }

    @Fact
    func MinimalRepro_LetActionBeforeLetHandler_Issue2231() {
        // Issue #2231's exact minimal repro: a delegate-typed local function
        // assigned to a plain local before its declaration.
        let printed = TranslateUnit(`
using System;
namespace Demo
{
    public class C
    {
        public void M()
        {
            Action<int> action = handler;

            void handler(int x)
            {
            }
        }
    }
}`)
        let declIndex = printed.IndexOf("let handler", StringComparison.Ordinal)
        let actionIndex = printed.IndexOf("let action", StringComparison.Ordinal)
        Assert.True(declIndex >= 0 && actionIndex >= 0, "Both bindings should be present.\n" + printed)
        Assert.True(declIndex < actionIndex, "`let handler` must be hoisted above `let action = handler`.\n" + printed)
        CompileAndRun(printed, "C().M()\nConsole.WriteLine(\"ok\")", "ok")
    }

    @Fact
    func EventHandlerPlusEqualsForwardReference_IsHoisted() {
        // Issue #2231: mirrors the `AudibleApi.cs` shape — a local function
        // subscribed to an event with `+=` before its textual declaration.
        let printed = TranslateUnit(`
using System;
namespace Demo
{
    public class C
    {
        public event EventHandler Progress;

        public void M()
        {
            Progress += OnProgress;

            void OnProgress(object sender, EventArgs e)
            {
            }
        }
    }
}`)
        let declIndex = printed.IndexOf("let OnProgress", StringComparison.Ordinal)
        let useIndex = printed.IndexOf("OnProgress", StringComparison.Ordinal)
        Assert.True(declIndex >= 0, "Local function should be emitted as a let binding.\n" + printed)
        Assert.True(
            declIndex < useIndex,
            "Local function subscribed via `+=` must be hoisted above the subscription.\n" + printed
        )
    }

    @Fact
    func MutuallyRecursiveLocalFunctions_AreBothHoistedBeforeFirstExternalUse() {
        // Issue #4197 widened `RegisterCapturingRecursiveLocalFunctions` to
        // claim EVERY mutual-recursion cycle (through another local
        // function), capturing or not — this non-capturing `A`/`B` pair no
        // longer lifts to `__local_`; it lowers to the #3399 nullable
        // function-local scheme instead. The hoist invariant under test still
        // applies to that scheme: the nil-initialized declarations (emitted
        // at the position of the first-hoisted group member) must precede the
        // forward call site inside the `if`.
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public void M(int input)
        {
            if (input > 0)
            {
                A();
            }

            void A()
            {
                B();
            }

            void B()
            {
                A();
            }
        }
    }
}`)
        Assert.DoesNotContain("let A", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("let B", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal)
        Assert.Contains("var A", printed, StringComparison.Ordinal)
        Assert.Contains("var B", printed, StringComparison.Ordinal)
        Assert.Contains("A!!(", printed, StringComparison.Ordinal)
        Assert.Contains("B!!(", printed, StringComparison.Ordinal)
        let declIndexA = printed.IndexOf("var A", StringComparison.Ordinal)
        let declIndexB = printed.IndexOf("var B", StringComparison.Ordinal)
        let firstExternalUse = printed.IndexOf("A!!(", StringComparison.Ordinal)
        Assert.True(
            declIndexA >= 0 && declIndexA < firstExternalUse,
            "var A must precede the forward call.\n" + printed
        )
        Assert.True(
            declIndexB >= 0 && declIndexB < firstExternalUse,
            "var B must precede the forward call.\n" + printed
        )
    }

    @Fact
    func CapturingRecursiveLocalFunction_LiftsMutableCaptureByRef() {
        let printed = TranslateUnit(`
using System;
namespace Demo
{
    public class C
    {
    public void Run(int input)
    {
        int sum = 0;

        void Add(int current)
        {
            sum += current;
            if (current > 0)
            {
                Add(current - 1);
            }
        }

        Add(input);
        if (sum != 6)
        {
            throw new Exception("wrong sum");
        }
    }
    }
}`)
        // Issue #3501 A2: gsc `let`-bound literals can self-reference, so a
        // DIRECT self-recursive capturing local stays on the canonical
        // `let Add = func …` path — no lift, no #3399 nullable-local scheme.
        Assert.DoesNotContain("__local_Run_Add", printed, StringComparison.Ordinal)
        Assert.Contains("let Add = func", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Add!!(", printed, StringComparison.Ordinal)
        CompileAndRun(printed, "C().Run(3)\nConsole.WriteLine(\"ok\")", "ok")
    }

    @Fact
    func MutuallyRecursiveLocalFunctions_ForwardSharedMutableCapture() {
        let printed = TranslateUnit(`
using System;
namespace Demo
{
    public class C
    {
    public void Run(int input)
    {
        int sum = 0;

        void AddEven(int current)
        {
            sum += current;
            if (current > 0)
            {
                AddOdd(current - 1);
            }
        }

        void AddOdd(int current)
        {
            sum += current;
            if (current > 0)
            {
                AddEven(current - 1);
            }
        }

        AddEven(input);
        if (sum != 6)
        {
            throw new Exception("wrong sum");
        }
    }
    }
}`)
        // Issue #3399 hybrid: a capturing mutually recursive SCC lowers to G#'s
        // nullable function-typed locals, not synthesized capture-passing helpers.
        Assert.DoesNotContain("let AddEven", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("let AddOdd", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__local_Run_AddEven", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__local_Run_AddOdd", printed, StringComparison.Ordinal)
        Assert.Contains("var AddEven", printed, StringComparison.Ordinal)
        Assert.Contains("var AddOdd", printed, StringComparison.Ordinal)
        Assert.Contains("AddEven!!(", printed, StringComparison.Ordinal)
        Assert.Contains("AddOdd!!(", printed, StringComparison.Ordinal)
        CompileAndRun(printed, "C().Run(3)\nConsole.WriteLine(\"ok\")", "ok")
    }

    @Fact
    func CapturingLocalFunction_WithOutParameters_StaysNativeLiteral() {
        let printed = TranslateUnit(`
using System;
namespace Demo
{
    public class C
    {
    public void Run(int input)
    {
        int offset = 2;

        int Read(out int doubled)
        {
            doubled = input * 2;
            return doubled + offset;
        }

        int result = Read(out var doubled);
        if (result != 8 || doubled != 6)
        {
            throw new Exception("wrong result");
        }
    }
    }
}`)
        // Issue #3501: gsc `let`-bound literals declare and call through
        // ref/out/in parameters natively, so an out-parameter local function no
        // longer lifts to a `__local_` helper.
        Assert.Contains("let Read = func (out doubled int32) int32", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal)
        CompileAndRun(printed, "C().Run(3)\nConsole.WriteLine(\"ok\")", "ok")
    }

    @Fact
    func RecursiveHelper_CaptureKeepsNonNullableReferenceType() {
        let printed = TranslateUnit(`
using System;
using System.Collections.Generic;
namespace Demo
{
    public class C
    {
    public void Run(int input)
    {
        var values = new List<int>();

        void Add(int current)
        {
            values.Add(current);
            if (current > 0)
            {
                Add(current - 1);
            }
        }

        Add(input);
        if (values[0] != input)
        {
            throw new Exception("wrong value");
        }
    }
    }
}`)
        // Issue #3399 hybrid: the captured local stays a plain non-nullable G#
        // local (`let values = List[int32]()`) captured by the nullable function
        // literal — no nullable reference type is introduced for the capture.
        Assert.Contains("let values = List[int32]()", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("List[int32]?", printed, StringComparison.Ordinal)
        CompileAndRun(printed, "C().Run(3)\nConsole.WriteLine(\"ok\")", "ok")
    }

    @Fact
    func StaticRecursiveLocalFunction_IsLiftedToSharedHelper() {
        let printed = TranslateUnit(`
using System;

namespace Demo
{
    public class C
    {
        public int Factorial(int value)
        {
            static bool IsBaseCase(int current) => current <= 1;

            static int Visit(int current)
            {
                return IsBaseCase(current) ? 1 : current * Visit(current - 1);
            }

            return Visit(value);
        }
    }
}`)
        // Issue #3501 A2: direct self-recursion no longer forces the shared-
        // helper lift — both statics stay as in-place `let` literals (Visit's
        // self-call resolves through its own binding; IsBaseCase is declared
        // before Visit, so the sibling call resolves lexically).
        Assert.Contains("let Visit = func", printed, StringComparison.Ordinal)
        Assert.Contains("let IsBaseCase = func", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__local_Factorial_Visit", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__local_Factorial_IsBaseCase", printed, StringComparison.Ordinal)
        CompileAndRun(printed, "Console.WriteLine(C().Factorial(5))", "120")
    }

    @Fact
    func Issue2231MutualRecursionNowSupportedByGscLetBindings() {
        // Issue #4219 gave gsc mutual-recursion groups for a consecutive run
        // of two-or-more non-generic function-literal `let` declarations, so
        // this exact shape (a forward-referencing `let a` / `let b` pair,
        // #2231's original repro) now compiles and runs correctly instead of
        // reporting GS0130. This is a genuine runtime check — a mutual,
        // decrementing ping-pong with a base case, so it actually terminates
        // and the printed result proves both directions of the cycle ran —
        // not just "compiles" or "exits zero".
        //
        // This is a gsc-level capability pin, not a translator one: cs2gs
        // itself does not emit this consecutive-group form for a recursive
        // C# local function — it still lifts to a synthesized helper (or the
        // #3399 nullable-var scheme); see the class doc above.
        const Source = `
package p
class C {
    func M(n int32) int32 {
        let a = func (n int32) int32 {
            if n == 0 { return 0 }
            return 1 + b(n - 1)
        }
        let b = func (n int32) int32 {
            if n == 0 { return 0 }
            return 1 + a(n - 1)
        }
        return a(n)
    }
}`
        CompileAndRun(Source, "Console.WriteLine(C().M(9))", "9")
    }

    shared {
        internal func TranslateUnit(source string, roundTripOnlyReason string? = nil) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(printed)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason)
            }
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
        /// it — proving the translated snippet actually binds (issue #2231's GS0125
        /// forward-reference bug is a binder-time error that a parse-only round-trip
        /// cannot catch).
        internal func CompileAndRun(printed string, callExpression string, expectedOutput string? = nil) {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2231-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let gsPath = Path.Combine(workDir, "Snippet.gs")
            let dllPath = Path.Combine(workDir, "Snippet.dll")
            File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine)
            let compile = ProcessRunner.Run(
                "dotnet",
                []string{compiler!!, "/target:exe", "/out:$dllPath", gsPath},
                timeout: TimeSpan.FromSeconds(30)
            )
            Assert.False(compile.TimedOut, (`gsc timed out and was killed. Output:
` + "${compile.Output}"))
            Assert.True(
                compile.ExitCode == 0 && !compile.Output.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated snippet with zero errors. Output:\n" + compile.Output + `

Translated G#:
` + printed
            )
            let run = ProcessRunner.Run("dotnet", []string{dllPath}, timeout: TimeSpan.FromSeconds(30))
            Assert.False(run.TimedOut, (`Translated program timed out and was killed. Output:
` + "${run.Output}"))
            Assert.True(run.ExitCode == 0, "Translated snippet must run successfully. Output:\n" + run.Output)
            if expectedOutput != nil {
                Assert.Equal(expectedOutput, run.Stdout.Trim())
            }
        }

        internal func FindCompiler() string? {
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
