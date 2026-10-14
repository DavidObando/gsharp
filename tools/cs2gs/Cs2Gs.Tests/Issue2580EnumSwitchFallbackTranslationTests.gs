// <copyright file="Issue2580EnumSwitchFallbackTranslationTests.cs" company="GSharp">
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

class Issue2580EnumSwitchFallbackTranslationTests {
    @Fact
    func StatementFallback_IsAddedOnlyForIncompleteDefaultlessEnumSwitch() {
        let printed = TranslateAndValidate(`namespace Demo
{
    public enum State { Zero, One }

    public static class C
    {
        public static void Incomplete(State value)
        {
            switch (value)
            {
                case State.One:
                    value = State.Zero;
                    break;
            }
        }

        public static void Complete(State value)
        {
            switch (value)
            {
                case State.Zero or State.One:
                    value = State.Zero;
                    break;
            }
        }

        public static void Explicit(State value)
        {
            switch (value)
            {
                case State.One:
                    value = State.Zero;
                    break;
                default:
                    value = State.One;
                    break;
            }
        }

        public static void NonEnum(int value)
        {
            switch (value)
            {
                case 1:
                    value = 2;
                    break;
            }
        }

        public static int Expression(State value) => value switch
        {
            State.One => 1,
        };
    }
}`)
        Assert.Equal(2, CountOccurrences(printed, "default {"))
        Assert.Contains("default: throw", printed, StringComparison.Ordinal)
    }

    @Fact
    func ImportedEnumFallback_CompilesAndPreservesUnmatchedRuntimePath() {
        let printed = TranslateAndValidate(`using System;

namespace Demo
{
    public static class C
    {
        public static string Run(DayOfWeek value)
        {
            string trace = "before";
            switch (value)
            {
                case DayOfWeek.Monday:
                    trace += "|monday";
                    break;
                case DayOfWeek.Tuesday:
                    trace += "|tuesday";
                    break;
            }

            return trace + "|after";
        }
    }
}`)
        Assert.Contains("default {", printed, StringComparison.Ordinal)
        Assert.Equal(
            "before|after;before|monday|after",
            CompileAndRun(printed, "C.Run(DayOfWeek.Sunday) + \";\" + C.Run(DayOfWeek.Monday)").Trim()
        )
    }

    @Fact
    func SourceEnumFallback_PreservesBreakAndExplicitDefault() {
        let printed = TranslateAndValidate(`namespace Demo
{
    public enum State { A, B, C, D }

    public static class C
    {
        public static string Run(State value)
        {
            string trace = "";
            switch (value)
            {
                case State.A:
                    trace += "a";
                    break;
                case State.B:
                    trace += "b";
                    break;
                case State.C:
                    trace += "c";
                    break;
            }

            return trace + "|done";
        }

        public static string Explicit(State value)
        {
            switch (value)
            {
                case State.A:
                    return "a";
                default:
                    return "explicit";
            }
        }
    }
}`)
        Assert.Equal(2, CountOccurrences(printed, "default {"))
        Assert.Equal(
            "a|done;b|done;|done;explicit",
            CompileAndRun(
                printed,
                "C.Run(State.A) + \";\" + C.Run(State.B) + \";\" + " + "C.Run(State.D) + \";\" + C.Explicit(State.D)"
            ).Trim()
        )
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
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
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
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2580-e2e", Guid.NewGuid().ToString("N"))
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
            let startInfo = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(startInfo)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
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

        private func CountOccurrences(text string, value string) int32 {
            var count = 0
            for var index = 0;
                (index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0;
                index += value.Length {
                count++
            }
            return count
        }
    }
}
