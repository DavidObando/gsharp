// <copyright file="Adr0179BacktickRawStringTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

// ADR-0179 phase 9b: G#'s backtick raw string has no escape, so before
// this change ANY multi-line literal containing a backtick fell back to a
// fully escaped one-liner — in the repo self-migration that produced 30
// lines over 300 characters, one of them 5,122 characters long, and no
// formatter can ever break them because the literal IS the line.
//
// The fix spells such a value as Go does: a parenthesized concatenation of
// raw-string runs and quoted backtick runs. The whole risk is that the
// splice changes the string's VALUE, so the load-bearing test here is an
// END-TO-END one: translate, print, compile with the real gsc, run, and
// compare the runtime bytes against the C# original. A printer-output
// assertion would not have caught a dropped or doubled character.
class Adr0179BacktickRawStringTests {
    @Fact
    func MultilineLiteralWithBacktick_SplicesInsteadOfEscapingToOneLine() {
        let printed = Translate(BacktickFixtureSource)
        Assert.Contains("` + \"`\" + `", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("\\n", printed, StringComparison.Ordinal)
        Assert.All(
            printed.Split('\n'),
            (line string) -> Assert.True(
                line.Length <= 300,
                "The spliced literal must not leave a >300-char line: " + line
            )
        )
    }

    @Fact
    func MostlyBacktickLiteral_KeepsTheEscapedOneLiner() {
        // The splice is not unconditionally better. A value that is mostly
        // backticks fragments into many two-character pieces whose longest
        // line beats nothing, so the printer measures both shapes and
        // keeps the escaped one-liner. Guarding this is what keeps the fix
        // from trading one unreadable line for a worse one.
        let body = string.Concat(Enumerable.Repeat("`a`\\n", 60))
        let printed = Translate((`namespace Demo
{
    public static class Ticks
    {
        public const string Source = "` + "$body" + `";
    }
}`))
        Assert.DoesNotContain("` + \"`\" + `", printed, StringComparison.Ordinal)
        Assert.Contains("\\n", printed, StringComparison.Ordinal)
    }

    @Fact
    func SplicedLiteral_RoundTripsByteIdenticallyThroughGsc() {
        // The value the C# fixture declares, computed here so the
        // comparison is against the ORIGINAL rather than against another
        // copy of the printer's opinion.
        const Expected = (`package Demo

class Bus {
    // a ` + "`" + `backtick` + "`" + ` in a comment
`) + (`    func Tick() string {
        return ` + "`" + `raw` + "`" + `
    }
}
`)
        let printed = Translate(BacktickFixtureSource)
        Assert.Contains("` + \"`\" + `", printed, StringComparison.Ordinal)
        let stdout = CompileAndRun(
            printed,
            "let bytes = System.Text.Encoding.UTF8.GetBytes(Demo.Fixture.Source)\n" +
                "System.Console.Write(System.Convert.ToBase64String(bytes))\n"
        )
        let expectedBase64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(Expected))
        Assert.Equal(expectedBase64, stdout.Trim())
    }

    shared {
        // A multi-line value carrying backticks in three positions that the
        // run-splitting has to get right: inside a line, as a doubled run, and
        // adjacent to a newline.
        private const BacktickFixtureSource string = (`namespace Demo
{
    public static class Fixture
    {
        public const string Source = "package Demo\n\nclass Bus {\n    // a ` + "`" + `backtick` + "`" + ` in a comment\n    func Tick() string {\n        return ` + "`" + `raw` + "`" + `\n    }\n}\n";
    }
}`)

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Snippet.cs", source)},
                references: nil
            )
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }

        private func CompileAndRun(printed string, entry string) string {
            let compiler string? = FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let workDir = Path.Combine(AppContext.BaseDirectory, "adr-0179-9b", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let gsPath = Path.Combine(workDir, "Snippet.gs")
            let dllPath = Path.Combine(workDir, "Snippet.dll")
            File.WriteAllText(gsPath, printed + Environment.NewLine + entry + Environment.NewLine)
            let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"")
            Assert.True(
                compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the spliced literal with zero errors. Output:\n" + compileOut + `

Translated G#:
` + printed
            )
            let (runExit, stdout) = RunDotnet("\"$dllPath\"")
            Assert.True(runExit == 0, "The compiled snippet must run successfully. Output:\n" + stdout)
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
