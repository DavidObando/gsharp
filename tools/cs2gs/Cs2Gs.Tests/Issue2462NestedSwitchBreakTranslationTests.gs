// <copyright file="Issue2462NestedSwitchBreakTranslationTests.cs" company="GSharp">
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

open class Issue2462NestedSwitchBreakTranslationTests {
    @Fact
    func SwitchSectionBreaks_AreRemovedThroughTransparentNesting() {
        let printed = TranslateAndValidate(`
using System;

namespace Demo
{
    public sealed class C
    {
        public static void Run(int value, object gate, IDisposable resource)
        {
            switch (value)
            {
                case 0:
                    break;
                case 1:
                case 2:
                {
                    {
                        {
                            break;
                        }
                    }
                }
                case 3:
                    if (value > 0)
                    {
                        break;
                    }
                    break;
                case 4:
                    try
                    {
                        break;
                    }
                    finally
                    {
                        Console.Write("");
                    }
                case 5:
                    using (resource)
                    {
                        break;
                    }
                case 6:
                    lock (gate)
                    {
                        break;
                    }
            }
        }
    }
}`)
        // Issue #3501 A3: section-terminal breaks (even through transparent
        // block nesting) still vanish — a G# arm ends there naturally. The
        // conditional/protected-region breaks that DO have observable flow
        // now keep the `break` spelling (gsc break exits the switch) instead
        // of the retired `goto __switchExit` lowering.
        Assert.DoesNotContain("__switchExit", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("case 0 {\n            break", printed, StringComparison.Ordinal)
    }

    @Fact
    func NestedLoopBreaksArePreserved_AndNestedSwitchHandlesItsOwnTerminator() {
        let printed = TranslateAndValidate(`
using System;

namespace Demo
{
    public sealed class C
    {
        public static void Run(int value, int[] values)
        {
            switch (value)
            {
                case 0:
                    for (;;)
                    {
                        break;
                    }
                    while (true)
                    {
                        break;
                    }
                    do
                    {
                        break;
                    }
                    while (false);
                    foreach (int item in values)
                    {
                        break;
                    }
                    switch (value + 1)
                    {
                        case 1:
                            break;
                    }
                    break;
            }

            static void Local()
            {
                while (true)
                {
                    break;
                }
            }

            Action lambda = () =>
            {
                while (true)
                {
                    break;
                }
            };
        }
    }
}`)
        Assert.Equal(6, CountOccurrences(printed, "break"))
        Assert.DoesNotContain("__switchExit", printed, StringComparison.Ordinal)
    }

    @Fact
    func ConditionalSectionBreak_LowersToExitGotoAndPreservesRuntimeControlFlow() {
        let printed = TranslateAndValidate(`
using System;

namespace Demo
{
    public sealed class C
    {
        public static string Run(int value, bool stop)
        {
            string trace = "";
            switch (value)
            {
                case 1:
                case 2:
                    trace += "start";
                    if (stop)
                    {
                        break;
                    }
                    trace += "after";
                    break;
                default:
                    trace += "default";
                    break;
            }

            return trace + "|done";
        }
    }
}`)
        // Issue #3501 A3: gsc `break` now exits the switch, so the
        // non-terminal C# break keeps its spelling — no `goto __switchExit`
        // lowering — and the stacked `case 1: case 2:` labels merge into one
        // comma arm instead of duplicating the body.
        Assert.DoesNotContain("__switchExit", printed, StringComparison.Ordinal)
        Assert.Contains("break", printed, StringComparison.Ordinal)
        Assert.Contains("case 1, 2", printed, StringComparison.Ordinal)
        Assert.Equal("start|done", CompileAndRun(printed, "C.Run(1, true)").Trim())
        Assert.Equal("startafter|done", CompileAndRun(printed, "C.Run(2, false)").Trim())
        Assert.Equal("default|done", CompileAndRun(printed, "C.Run(9, true)").Trim())
    }

    @Fact
    func GotoCaseDefaultLabelsReturnsAndThrows_RemainIntact() {
        let printed = TranslateAndValidate(`
using System;

namespace Demo
{
    public sealed class C
    {
        public static int Run(int value)
        {
            switch (value)
            {
                case 0:
                    goto case 1;
                case 1:
                tagged:
                    return 1;
                case 2:
                    goto default;
                case 3:
                    throw new InvalidOperationException();
                default:
                    return -1;
            }
        }
    }
}`)
        // Issue #3501 A3: `goto case 1` in case 0 targets the lexically next
        // arm, so it prints as the native `fallthrough`; `goto default` in
        // case 2 skips over case 3 and keeps the synthesized-label lowering.
        Assert.Contains("fallthrough", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__gotoCase", printed, StringComparison.Ordinal)
        Assert.Contains("goto __gotoDefault", printed, StringComparison.Ordinal)
        Assert.Contains("tagged:", printed, StringComparison.Ordinal)
        Assert.Contains("return 1", printed, StringComparison.Ordinal)
        Assert.Contains("throw", printed, StringComparison.Ordinal)
    }

    shared {
        private func CountOccurrences(text string, value string) int32 {
            var count = 0
            var index = 0
            while (index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0 {
                count++
                index += value.Length
            }
            return count
        }

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

        private func CompileAndRun(printed string, callExpression string) string {
            let compiler string? = FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2462-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let gsPath = Path.Combine(workDir, "Snippet.gs")
            let dllPath = Path.Combine(workDir, "Snippet.dll")
            File.WriteAllText(
                gsPath,
                printed + Environment.NewLine + "Console.WriteLine($callExpression)" + Environment.NewLine
            )
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
