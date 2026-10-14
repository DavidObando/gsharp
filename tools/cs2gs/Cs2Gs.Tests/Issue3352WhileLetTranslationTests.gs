// <copyright file="Issue3352WhileLetTranslationTests.cs" company="GSharp">
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
import System.Linq
import System.Text
import Xunit

/// Issue #3352: C# positive pattern bindings in `while` conditions use a
/// native G# loop binding — no `let __scrutineeN` body prologue and no
/// `while true` rewrite — when that form preserves the source semantics.
///
/// ADR-0166 / issue #3409: an unmodified binder is now a native pattern
/// variable, so these loops keep the C# shape verbatim
/// (`while C.Next() is string text { }`). The `while let` lowering
/// remains for shapes the native grammar cannot express (residual positional
/// patterns, see (cref:Issue3347RemainingSpillInventoryTests)), and a
/// reassigned binder still takes the mutable-hoist fallback (below).
class Issue3352WhileLetTranslationTests {
    @Fact
    func ReferenceTypePatternEmitsNativePatternVariableAndRuns() {
        let printed = Translate(`#nullable enable
using System;

namespace Demo
{
    public static class C
    {
        private static int calls;

        private static object? Next()
        {
            calls++;
            return calls <= 2 ? calls.ToString() : null;
        }

        public static string Run()
        {
            string result = "";
            while (Next() is string text)
            {
                result += text;
            }

            return result + "|" + calls;
        }
    }
}`)
        // ADR-0166 / issue #3409: native pattern variable instead of `while let`.
        Assert.Contains("while Next() is string text {", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("while let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("as string", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__scrutinee", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("while true", printed, StringComparison.Ordinal)
        Assert.Equal("12|3", CompileAndRun(printed, "C.Run()").Trim())
    }

    @Fact
    func BareNonNullPatternUsesReceiverDirectly() {
        let printed = Translate(`#nullable enable
using System;

namespace Demo
{
    public static class C
    {
        private static int calls;

        private static string? Next()
        {
            calls++;
            return calls == 1 ? "value" : null;
        }

        public static string Run()
        {
            string result = "";
            while (Next() is { } text)
            {
                result += text;
            }

            return result + "|" + calls;
        }
    }
}`)
        // ADR-0166 / issue #3409: the bare non-null pattern is a native
        // pattern variable over the receiver itself — no `as`, no `while let`.
        Assert.Contains("while Next() is { } text {", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("while let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Next() as", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__scrutinee", printed, StringComparison.Ordinal)
        Assert.Equal("value|2", CompileAndRun(printed, "C.Run()").Trim())
    }

    @Fact
    func ConjoinedGuardRunsInsideBindingScope() {
        let printed = Translate(`#nullable enable
using System;

namespace Demo
{
    public static class C
    {
        private static int calls;

        private static object? Next()
        {
            calls++;
            if (calls == 1) return "a";
            if (calls == 2) return "";
            return "unreached";
        }

        public static string Run()
        {
            string result = "";
            while (Next() is string text && text.Length > 0)
            {
                result += text;
            }

            return result + "|" + calls;
        }
    }
}`)
        // ADR-0166 / issue #3409: the conjoined guard reads the native pattern
        // variable in the `&&` right operand — it stays in the loop condition
        // instead of becoming an `if !(guard) { break }` prologue.
        Assert.Contains("while Next() is string text && text.Length > 0 {", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("while let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("break", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__scrutinee", printed, StringComparison.Ordinal)
        Assert.Equal("a|2", CompileAndRun(printed, "C.Run()").Trim())
    }

    @Fact
    func ValueTypePatternBindsUnboxedNativeVariableAndRuns() {
        let printed = Translate(`#nullable enable
using System;

namespace Demo
{
    public static class C
    {
        private static int calls;

        private static object? Next()
        {
            calls++;
            return calls <= 2 ? calls : null;
        }

        public static string Run()
        {
            int sum = 0;
            while (Next() is int value)
            {
                sum += value;
            }

            return sum + "|" + calls;
        }
    }
}`)
        // ADR-0166 / issue #3409: the value-type binder is a native pattern
        // variable of the tested type — no `as int32?` layer to strip.
        Assert.Contains("while Next() is int32 value {", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("while let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("as int32?", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__scrutinee", printed, StringComparison.Ordinal)
        Assert.Equal("3|3", CompileAndRun(printed, "C.Run()").Trim())
    }

    @Fact
    func NativePatternLoopPreservesContinueAndBreak() {
        let printed = Translate(`#nullable enable
using System;

namespace Demo
{
    public static class C
    {
        private static int calls;

        private static object? Next()
        {
            calls++;
            if (calls == 1) return "skip";
            if (calls == 2) return "keep";
            if (calls == 3) return "stop";
            return "unreached";
        }

        public static string Run()
        {
            string result = "";
            while (Next() is string text)
            {
                if (text == "skip") continue;
                result += text;
                if (text == "stop") break;
            }

            return result + "|" + calls;
        }
    }
}`)
        // ADR-0166 / issue #3409: the native pattern loop owns re-evaluation,
        // so `continue` and `break` route exactly as in the C# source.
        Assert.Contains("while Next() is string text {", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("while let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__scrutinee", printed, StringComparison.Ordinal)
        Assert.Equal("keepstop|3", CompileAndRun(printed, "C.Run()").Trim())
    }

    @Fact
    func OuterHoistDoesNotRewriteContinueInsideNestedPatternLoop() {
        let printed = Translate(`#nullable enable
using System;

namespace Demo
{
    public static class C
    {
        private static int outer;
        private static int bodyCalls;
        private static int nextCalls;

        private static object? Next()
        {
            nextCalls++;
            return nextCalls == 1 ? "value" : null;
        }

        public static string Run()
        {
            while ((outer = outer + 1) < 2)
            {
                while (Next() is string text)
                {
                    bodyCalls++;
                    continue;
                }
            }

            return outer + "|" + bodyCalls + "|" + nextCalls;
        }
    }
}`)
        // ADR-0166 / issue #3409: the nested loop is a native pattern loop;
        // its `continue` still targets it, not the outer loop.
        Assert.Contains("while Next() is string text {", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("while let", printed, StringComparison.Ordinal)
        Assert.Equal("2|1|2", CompileAndRun(printed, "C.Run()").Trim())
    }

    @Fact
    func ReassignedPatternLocalKeepsMutableHoistFallback() {
        let printed = Translate(`#nullable enable
using System;

namespace Demo
{
    public static class C
    {
        public static string Run(object? value)
        {
            while (value is string text)
            {
                text = "";
                break;
            }

            return "ok";
        }
    }
}`)
        Assert.DoesNotContain("while let text =", printed, StringComparison.Ordinal)
        Assert.Contains("var text", printed, StringComparison.Ordinal)
        Assert.Equal("ok", CompileAndRun(printed, "C.Run(\"value\")").Trim())
    }

    shared {
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                roundTrip!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", roundTrip!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }

        private func CompileAndRun(printed string, callExpression string) string {
            let compiler string? = FindCompiler()
            Assert.NotNull(compiler)
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-3352-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            try {
                let sourcePath = Path.Combine(workDir, "Snippet.gs")
                let outputPath = Path.Combine(workDir, "Snippet.dll")
                File.WriteAllText(
                    sourcePath,
                    printed + Environment.NewLine + "Console.WriteLine($callExpression)" + Environment.NewLine
                )
                let (compileExit, compileOutput) = RunDotnet(compiler!!, "/target:exe", "/out:$outputPath", sourcePath)
                Assert.True(
                    compileExit == 0 && !compileOutput.Contains("error", StringComparison.OrdinalIgnoreCase),
                    "gsc must compile translated G# with zero errors. Output:\n" + compileOutput + `

Translated G#:
` + printed
                )
                let (runExit, runOutput) = RunDotnet(outputPath)
                Assert.True(runExit == 0, "Translated G# must run successfully. Output:\n" + runOutput)
                return runOutput
            } finally {
                Directory.Delete(workDir, recursive: true)
            }
        }

        private func RunDotnet(arguments ...string)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            for argument in arguments {
                startInfo.ArgumentList.Add(argument)
            }
            using let process Process? = Process.Start(startInfo)
            Assert.NotNull(process)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                let sameConfiguration = Path.Combine(directory.FullName, "Compiler", "gsc.dll")
                if File.Exists(sameConfiguration) {
                    return sameConfiguration
                }
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", configuration, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }
    }
}
