// <copyright file="Issue2552NestedBreakTargetTests.cs" company="GSharp">
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

open class Issue2552NestedBreakTargetTests {
    @Fact
    func Translator_PreservesLoopBreaksAndLowersSwitchBreaks() {
        let printed = TranslateAndValidate(Source)
        // Issue #3501 A3: gsc `break` exits the innermost switch OR loop
        // (C#/Go alignment), so the switch-targeting breaks keep their
        // spelling — the `goto __switchExit` lowering is retired. Two loop
        // breaks + two switch breaks.
        Assert.Equal(4, CountOccurrences(printed, "break"))
        Assert.Equal(0, CountOccurrences(printed, "goto __switchExit"))
    }

    @Fact
    func Compiler_AcceptsBothNestedShapesWithoutGS0120() {
        let output = Compile(TranslateAndValidate(Source), out _)
        Assert.DoesNotContain("GS0120", output, StringComparison.Ordinal)
    }

    @Fact
    func Runtime_PreservesBothNestedBreakTargets() {
        let printed = TranslateAndValidate(Source)
        let output = CompileAndRun(
            printed,
            "Console.WriteLine(C.SwitchInsideLoop(0))" +
                Environment.NewLine +
                "Console.WriteLine(C.LoopInsideSwitch(0))"
        )
        Assert.Equal("SLSxL" + Environment.NewLine + "LS", output.Trim())
    }

    @Fact
    func Translator_EmitsNativeYieldBreak() {
        // Issue #3501 A1: `yield break` translates to G#'s native
        // `yield break`, which exits the iterator from any nesting depth —
        // including from inside the switch inside the while here. The loop's
        // own `break` keeps its loop binding (the third "break" match below
        // is the loop's).
        let printed = TranslateAndValidate(IteratorSource)
        Assert.Equal(2, CountOccurrences(printed, "yield break"))
        Assert.Equal(3, CountOccurrences(printed, "break"))
        Assert.DoesNotContain("__iteratorExit", printed, StringComparison.Ordinal)
    }

    @Fact
    func Compiler_AcceptsIteratorExitInsideAndOutsideNestedLoop() {
        let output = Compile(TranslateAndValidate(IteratorSource), out _)
        Assert.DoesNotContain("GS0120", output, StringComparison.Ordinal)
    }

    @Fact
    func Runtime_YieldBreakExitsIteratorAcrossNestedLoopAndSwitch() {
        let printed = TranslateAndValidate(IteratorSource)
        let output = CompileAndRun(
            printed,
            "Console.WriteLine(C.Trace(0))" +
                Environment.NewLine +
                "Console.WriteLine(C.Trace(1))" +
                Environment.NewLine +
                "Console.WriteLine(C.Trace(2))"
        )
        Assert.Equal("1" + Environment.NewLine + "123" + Environment.NewLine + "12", output.Trim())
    }

    shared {
        private const Source string = `
using System;

namespace Demo
{
    public sealed class C
    {
        public static string SwitchInsideLoop(int value)
        {
            string trace = "";
            int i = 0;
            while (i < 2)
            {
                i++;
                switch (value)
                {
                    case 0:
                        trace += "S";
                        if (i == 1)
                        {
                            break;
                        }

                        trace += "x";
                        break;
                    default:
                        trace += "D";
                        break;
                }

                trace += "L";
                if (i == 1)
                {
                    continue;
                }

                break;
            }

            return trace;
        }

        public static string LoopInsideSwitch(int value)
        {
            string trace = "";
            switch (value)
            {
                case 0:
                    while (true)
                    {
                        trace += "L";
                        break;
                    }

                    if (trace.Length == 1)
                    {
                        break;
                    }

                    trace += "bad";
                    break;
                default:
                    trace += "D";
                    break;
            }

            return trace + "S";
        }
    }
}`

        private const IteratorSource string = `
using System;
using System.Collections.Generic;

namespace Demo
{
    public sealed class C
    {
        public static IEnumerable<int> Values(int stop)
        {
            yield return 1;
            while (true)
            {
                switch (stop)
                {
                    case 0:
                        yield break;
                    default:
                        break;
                }

                yield return 2;
                break;
            }

            if (stop == 2)
            {
                yield break;
            }

            yield return 3;
        }

        public static string Trace(int stop)
        {
            string trace = "";
            foreach (int value in Values(stop))
            {
                trace += value.ToString();
            }

            return trace;
        }
    }
}`

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
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
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
                string.Join(Environment.NewLine, result!!.Errors) + Environment.NewLine + printed
            )
            return printed
        }

        private func CompileAndRun(printed string, entryPoint string) string {
            let _ = Compile(printed + Environment.NewLine + entryPoint + Environment.NewLine, out var dllPath)
            let (exit, output) = RunDotnet("\"$dllPath\"")
            Assert.Equal(0, exit)
            return output
        }

        private func Compile(printed string, out dllPath string) string {
            let compiler string? = FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2552-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let gsPath = Path.Combine(workDir, "Snippet.gs")
            dllPath = Path.Combine(workDir, "Snippet.dll")
            File.WriteAllText(gsPath, printed)
            let (exit, output) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"")
            Assert.True(exit == 0, output + Environment.NewLine + printed)
            return output
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
