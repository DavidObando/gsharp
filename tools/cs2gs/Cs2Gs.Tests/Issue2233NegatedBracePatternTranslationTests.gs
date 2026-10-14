// <copyright file="Issue2233NegatedBracePatternTranslationTests.cs" company="GSharp">
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

/// Translation tests for issue #2233: a negated bare recursive (declaration)
/// pattern used as an early-exit guard — `if (x is not { } v) { return; }`
/// — dropped the binding for `v` in code following the guard, because
/// (cref:CSharpToGSharpTranslator)'s existing hoisted-nullable-local
/// lowering for `is not T t` (issue #914) only matched a pattern that
/// carries an explicit type test; a bare `{ }` pattern (no type, e.g.
/// unwrapping a nullable field like `DateTimeOffset?`) fell through to a
/// naive translation that rewrote the guard condition but never bound the
/// pattern variable, producing gsc GS0125 ("Variable 'v' doesn't exist").
///
/// The fix generalizes the same hoisted-nullable-local mechanism: for a bare
/// pattern the hoisted local's type is the receiver's own non-null type (no
/// `as` downcast is emitted, which also sidesteps `as`'s
/// reference-only restriction for a nullable value-type receiver).
///
/// ADR-0166 / issue #3409: G# now scopes pattern variables the way C# definite
/// assignment does, so a qualifying `x is { } v` — positive or negated —
/// is emitted verbatim (`if !(x is { } v) { return }`, then plain
/// `v`) with no hoisted local at all. The hoist lowering above remains the
/// fallback when the binder is later reassigned (G# pattern variables are
/// `let`-immutable) and is witnessed by
/// (cref:NegatedBracePattern_ReferenceTypeReceiver_ReassignedBinder_HoistsBindingPastIf).
open class Issue2233NegatedBracePatternTranslationTests {
    /// The issue's exact repro shape: a negated bare pattern early-exit guard
    /// over a nullable-value-type FIELD keeps `at` bound (and usable) in
    /// the code that follows the guard.
    @Fact
    func NegatedBracePattern_NullableValueTypeField_KeepsBinderAsNativePatternVariable() {
        let printed = TranslateUnit(`
using System;
namespace Demo
{
    public class C
    {
        private DateTimeOffset? promptShownAt;
        private static readonly TimeSpan ExitWindow = TimeSpan.FromSeconds(2);

        public bool ToastActive(Func<DateTimeOffset> clock)
        {
            if (promptShownAt is not { } at)
            {
                return false;
            }

            return clock() - at <= ExitWindow;
        }
    }
}`)
        // ADR-0166 / issue #3409: native `!(x is { } at)` guard; no hoisted
        // `let at DateTimeOffset? = promptShownAt` / `if at == nil`.
        Assert.Contains("if promptShownAt is not { } at {", printed)
        Assert.Contains("clock() - at <= ExitWindow", printed)
        Assert.DoesNotContain("let at", printed)
        Assert.DoesNotContain("== nil", printed)
        Assert.DoesNotContain("as DateTimeOffset", printed)
        CompileAndRun(printed, "C().ToastActive(func () DateTimeOffset { return DateTimeOffset.UtcNow })")
    }

    /// Generalization: the same guard over a LOCAL nullable value type (not a
    /// field), confirming the fix is not hardcoded to fields or to
    /// `DateTimeOffset?`.
    @Fact
    func NegatedBracePattern_LocalNullableValueType_KeepsBinderAsNativePatternVariable() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public int G()
        {
            int? maybe = 41;
            if (maybe is not { } value)
            {
                return -1;
            }

            return value + 1;
        }
    }
}`)
        // ADR-0166 / issue #3409: native `!(maybe is { } value)` guard; no
        // hoisted `let value int32? = maybe` / `if value == nil`.
        Assert.Contains("if maybe is not { } value {", printed)
        Assert.Contains("value + 1", printed)
        Assert.DoesNotContain("let value", printed)
        Assert.DoesNotContain("== nil", printed)
        CompileAndRun(printed, "C().G()")
    }

    /// Witness for the hoisted-nullable-local lowering over a nullable
    /// REFERENCE type (no downcast, since there is no type test).
    /// ADR-0166 / issue #3409: the native `!(s is { } text)` form only
    /// applies while `text` is never reassigned; this input reassigns
    /// `text` after the guard, so the translator must still hoist a mutable
    /// nullable local above the exiting `if`.
    @Fact
    func NegatedBracePattern_ReferenceTypeReceiver_ReassignedBinder_HoistsBindingPastIf() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public int G(string s)
        {
            if (s is not { } text)
            {
                return -1;
            }

            text = text.Trim();
            return text.Length;
        }
    }
}`)
        Assert.Contains("var text string? = s", printed)
        Assert.Contains("if text == nil", printed)
        Assert.Contains("text = text.Trim()", printed)
        Assert.Contains("text.Length", printed)
        Assert.DoesNotContain("as string", printed)
        Assert.DoesNotContain("is { } text", printed)
        CompileAndRun(printed, "C().G(\"hi\")")
    }

    /// Standalone positive bare pattern (`if (x is { } v) { ... }`, no
    /// trailing `&&`) over a NON-nullable `string`: C# still
    /// treats `s is { }` as a runtime null test, and ADR-0166 / issue #3409
    /// keeps it as the native `s is { } text` pattern variable (no
    /// `if let`, which ADR-0071 reserves for a nullable initializer, no
    /// scoped `let text = s` local, no `__spillN`).
    @Fact
    func PositiveBracePattern_Standalone_IsNativePatternVariable() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public int G(string s)
        {
            if (s is { } text)
            {
                return text.Length;
            }

            return -1;
        }
    }
}`)
        Assert.Contains("if s is { } text {", printed)
        Assert.Contains("return text.Length", printed)
        Assert.DoesNotContain("let text", printed)
        Assert.DoesNotContain("!= nil", printed)
        Assert.DoesNotContain("if let", printed)
        Assert.DoesNotContain("__spill", printed)
        CompileAndRun(printed, "C().G(\"hi\")")
    }

    /// Case B (issue #2233 fix-direction item 3): a positive bare pattern
    /// AND-combined with a further condition.
    ///
    /// Issue #3359 replaced the smart-cast form (`x != nil && …x!!…`)
    /// with an `if let` whose guard was nested in the then-branch.
    /// ADR-0166 / issue #3409 goes one step further: the pattern variable stays
    /// in the condition (`promptShownAt is { } at && now - at <= …`),
    /// so the binder keeps its name, there is no `!!`, the nullable FIELD is
    /// read once, and the C# short-circuit shape survives verbatim.
    @Fact
    func PositiveBracePattern_AndCombinedWithCondition_IsNativePatternVariable() {
        let printed = TranslateUnit(`
using System;
namespace Demo
{
    public class C
    {
        private DateTimeOffset? promptShownAt;
        private static readonly TimeSpan ExitWindow = TimeSpan.FromSeconds(2);

        public bool ToastActive(DateTimeOffset now)
        {
            if (promptShownAt is { } at && now - at <= ExitWindow)
            {
                return true;
            }

            return false;
        }
    }
}`)
        Assert.Contains("if promptShownAt is { } at && now - at <= ExitWindow {", printed)
        Assert.DoesNotContain("if let", printed)
        Assert.DoesNotContain("promptShownAt!!", printed)
        Assert.DoesNotContain("__spill", printed)
        CompileAndRun(printed, "C().ToastActive(DateTimeOffset.UtcNow)")
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
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
        /// it — proving the translated snippet actually binds (GS0125 is a
        /// binder-time error a parse-only round-trip cannot catch).
        private func CompileAndRun(printed string, callExpression string) {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2233-e2e", Guid.NewGuid().ToString("N"))
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
            let (runExit, runOut) = RunDotnet("\"$dllPath\"")
            Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + runOut)
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
