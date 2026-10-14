// <copyright file="Issue1912ExplicitEnumValueTranslationTests.cs" company="GSharp">
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

/// Issue #1912: (cref:CSharpToGSharpTranslator.VisitEnumDeclaration)
/// silently dropped every C# enum member's explicit constant value, always
/// re-numbering cases sequentially from 0 — a real behavioral divergence
/// (baseline C# `banana=2`, migrated G# `banana=1`), not just a
/// translation gap. It also erased `[Flags]`, negative values, and alias
/// members (`DefaultError = ServerError`).
///
/// Root cause: G# itself had no grammar for an explicit enum-member value.
/// The fix adds that language feature (`Name = constExpr`, constant-folded
/// at bind time — see `Issue1912ExplicitEnumMemberValueTests` in
/// Core.Tests) and updates the translator to read each C# member's resolved
/// `IFieldSymbol.ConstantValue` and emit an explicit `= value` only
/// when it diverges from the default auto-numbered ordinal (matching C#
/// §19.4's own "implicit member continues from the last explicit one" rule).
/// `[Flags]` is preserved via the existing generic `@Attribute` → CLR
/// custom-attribute annotation mechanism (`@Flags` resolves to
/// `System.FlagsAttribute`).
///
/// Every claim here is verified by actually compiling the translated G# with
/// the real `gsc` and running it, so a value that merely LOOKS right in
/// the printed text (but binds/emits wrong) cannot slip through.
open class Issue1912ExplicitEnumValueTranslationTests {
    @Fact
    func ExplicitPositiveValues_SurviveTranslationAndMatchCSharpAtRuntime() {
        const Source = `
using System;

namespace Demo
{
    public enum Fruit { Apple = 1, Banana = 2, Cherry = 4 }

    public static class C
    {
        public static void Run()
        {
            Fruit picked = Fruit.Banana;
            Console.WriteLine(((int)picked).ToString() + "," + ((int)Fruit.Cherry).ToString());
        }
    }
}
`
        let printed = TranslateAndValidate(Source)
        // Cherry=4 diverges from the auto-continued ordinal (3) and must be
        // explicit; Banana=2 already matches Apple=1's auto-continuation, so it
        // stays implicit — this is the intended "only spell out real
        // divergences" behavior (mirrors C# §19.4's own continuation rule).
        Assert.Contains("enum Fruit { Apple = 1, Banana, Cherry = 4 }", printed, StringComparison.Ordinal)
        let stdout = CompileAndRun(printed, "C.Run()")
        Assert.Equal("2,4", stdout.Trim())
    }

    @Fact
    func NegativeAndLargeValues_SurviveTranslationAndMatchCSharpAtRuntime() {
        const Source = `
using System;

namespace Demo
{
    public enum StatusCode { Unknown = -1, Ok = 200, ServerError = 500 }

    public static class C
    {
        public static void Run()
        {
            Console.WriteLine(((int)StatusCode.Unknown).ToString() + "," + ((int)StatusCode.ServerError).ToString());
        }
    }
}
`
        let printed = TranslateAndValidate(Source)
        Assert.Contains("Unknown = -1", printed, StringComparison.Ordinal)
        Assert.Contains("ServerError = 500", printed, StringComparison.Ordinal)
        let stdout = CompileAndRun(printed, "C.Run()")
        Assert.Equal("-1,500", stdout.Trim())
    }

    @Fact
    func MinValueAndShiftedIntValues_SurviveTranslationAndMatchCSharpAtRuntime() {
        // Regression: the decimal literal 2147483648 (int.MinValue's magnitude)
        // lexes as uint in G#, not int, so a naive fold of a negated/high-bit
        // value used to fail to compile with "must be a constant int32
        // expression" (issue #1912 follow-up). Covers int.MinValue itself and
        // `1 << 31`, both of which the C# semantic model resolves to the same
        // int32 bit pattern.
        const Source = `
using System;

namespace Demo
{
    public enum MinValueEnum { Reserved = int.MinValue }

    public enum ShiftedEnum { Reserved = 1 << 31 }

    public static class C
    {
        public static void Run()
        {
            Console.WriteLine(
                ((int)MinValueEnum.Reserved).ToString() + "," +
                ((int)ShiftedEnum.Reserved).ToString());
        }
    }
}
`
        let printed = TranslateAndValidate(Source)
        Assert.Contains("Reserved = -2147483648", printed, StringComparison.Ordinal)
        let stdout = CompileAndRun(printed, "C.Run()")
        Assert.Equal("-2147483648,-2147483648", stdout.Trim())
    }

    @Fact
    func AliasMember_SurvivesTranslationAndEqualsOriginalAtRuntime() {
        const Source = `
using System;

namespace Demo
{
    public enum StatusCode { ServerError = 500, DefaultError = ServerError }

    public static class C
    {
        public static void Run()
        {
            Console.WriteLine(((int)StatusCode.DefaultError).ToString() + "," + (StatusCode.DefaultError == StatusCode.ServerError));
        }
    }
}
`
        let printed = TranslateAndValidate(Source)
        // The alias resolves to the same numeric constant as its target member.
        Assert.Contains("DefaultError = 500", printed, StringComparison.Ordinal)
        let stdout = CompileAndRun(printed, "C.Run()")
        Assert.Equal("500,True", stdout.Trim())
    }

    @Fact
    func FlagsBitShiftAndOrMembers_SurviveTranslationAndMatchCSharpAtRuntime() {
        const Source = `
using System;

namespace Demo
{
    [Flags]
    public enum Access { None = 0, Read = 1 << 2, Write = 1 << 3, ReadWrite = Read | Write }

    public static class C
    {
        public static void Run()
        {
            Console.WriteLine(
                ((int)Access.Read).ToString() + "," +
                ((int)Access.Write).ToString() + "," +
                ((int)Access.ReadWrite).ToString() + "," +
                (Access.ReadWrite == (Access.Read | Access.Write)));
        }
    }
}
`
        let printed = TranslateAndValidate(Source)
        Assert.Contains("@Flags", printed, StringComparison.Ordinal)
        Assert.Contains("Read = 4", printed, StringComparison.Ordinal)
        Assert.Contains("Write = 8", printed, StringComparison.Ordinal)
        Assert.Contains("ReadWrite = 12", printed, StringComparison.Ordinal)
        let stdout = CompileAndRun(printed, "C.Run()")
        Assert.Equal("4,8,12,True", stdout.Trim())
    }

    @Fact
    func ImplicitMembersMatchingDefaultOrdinal_OmitRedundantExplicitValue() {
        // C# `Apple, Banana, Cherry` (implicit 0,1,2) must still print WITHOUT
        // an explicit `= value` — only a divergent value should ever be spelled
        // out, keeping the common case's G# output unchanged.
        const Source = `
using System;

namespace Demo
{
    public enum Fruit { Apple, Banana, Cherry }
}
`
        let printed = TranslateAndValidate(Source)
        Assert.Contains("enum Fruit { Apple, Banana, Cherry }", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("=", printed, StringComparison.Ordinal)
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
        /// it, returning stdout.
        private func CompileAndRun(printed string, callExpression string) string {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-1912-e2e", Guid.NewGuid().ToString("N"))
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
