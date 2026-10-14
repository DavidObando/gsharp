// <copyright file="Issue2005EnumTopBitValueTranslationTests.cs" company="GSharp">
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

/// Issue #2005: (cref:CSharpToGSharpTranslator.VisitEnumDeclaration)
/// reinterprets each member's constant bits via `ToEnumBitPattern` (a
/// `ulong`) and then range-checked it as a signed `long` against
/// `int.MinValue`/`int.MaxValue`. For an unsigned underlying type's
/// top-bit-set value (e.g. `enum X : uint { High = 1u << 31 }`), the
/// bit pattern (`2147483648UL`) is a POSITIVE `long` above
/// `int.MaxValue`, even though its low 32 bits are the perfectly valid
/// (negative) int32 bit pattern `int.MinValue` — so the check incorrectly
/// dropped the member's value (with an Info diagnostic) instead of
/// reinterpreting it. This is distinct from issue #1912 (fixed): that issue
/// covers the binder's own G# constant-folding; this one is cs2gs's C#→G#
/// value-printing side.
///
/// Fix: reinterpret the low 32 bits of the bit pattern directly as an int32
/// bit pattern (`unchecked((int)(uint)bits)`) for every underlying type
/// whose width is <= 32 bits (byte/sbyte/short/ushort/int/uint —
/// always representable this way), and only fall back to the drop+diagnostic
/// path for a genuine 64-bit (`long`/`ulong`) value whose high 32
/// bits aren't the sign-extension of its low 32 bits (i.e. truly has no int32
/// spelling).
///
/// Every claim here is verified by actually compiling the translated G# with
/// the real `gsc` and running it, so a value that merely LOOKS right in
/// the printed text (but binds/emits wrong) cannot slip through.
open class Issue2005EnumTopBitValueTranslationTests {
    @Fact
    func UintTopBitValue_SurvivesTranslationAndMatchesCSharpBitPatternAtRuntime() {
        const Source = `
using System;

namespace Demo
{
    public enum Flags32 : uint { High = 1u << 31 }

    public static class C
    {
        public static void Run()
        {
            Console.WriteLine(unchecked((int)(uint)Flags32.High).ToString());
        }
    }
}
`
        let printed = TranslateAndValidate(Source)
        Assert.Contains("High = -2147483648", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("dropped", printed, StringComparison.Ordinal)
        let stdout = CompileAndRun(printed, "C.Run()")
        Assert.Equal("-2147483648", stdout.Trim())
    }

    @Fact
    func ByteTopBitValue_SurvivesTranslationAndMatchesCSharpBitPatternAtRuntime() {
        const Source = `
using System;

namespace Demo
{
    public enum Flags8 : byte { High = 0x80 }

    public static class C
    {
        public static void Run()
        {
            Console.WriteLine(((int)(byte)Flags8.High).ToString());
        }
    }
}
`
        let printed = TranslateAndValidate(Source)
        Assert.Contains("High = 128", printed, StringComparison.Ordinal)
        let stdout = CompileAndRun(printed, "C.Run()")
        Assert.Equal("128", stdout.Trim())
    }

    @Fact
    func UshortTopBitValue_SurvivesTranslationAndMatchesCSharpBitPatternAtRuntime() {
        const Source = `
using System;

namespace Demo
{
    public enum Flags16 : ushort { High = 0x8000 }

    public static class C
    {
        public static void Run()
        {
            Console.WriteLine(((int)(ushort)Flags16.High).ToString());
        }
    }
}
`
        let printed = TranslateAndValidate(Source)
        Assert.Contains("High = 32768", printed, StringComparison.Ordinal)
        let stdout = CompileAndRun(printed, "C.Run()")
        Assert.Equal("32768", stdout.Trim())
    }

    @Fact
    func UlongValueRepresentableAsInt32BitPattern_SurvivesTranslationAndMatchesCSharpBitPatternAtRuntime() {
        // 0xFFFFFFFF80000000 is a 64-bit value whose high 32 bits ARE the
        // proper sign-extension of its low 32 bits (0x80000000 = int.MinValue);
        // it has a faithful int32 spelling even though it's `ulong`-backed and
        // its low 32 bits have the top bit set, so it must survive translation
        // exactly like the 32-bit-underlying-type cases above.
        const Source = `
using System;

namespace Demo
{
    public enum Flags64 : ulong { High = 0xFFFFFFFF80000000UL }

    public static class C
    {
        public static void Run()
        {
            Console.WriteLine(unchecked((int)(ulong)Flags64.High).ToString());
        }
    }
}
`
        let printed = TranslateAndValidate(Source)
        Assert.Contains("High = -2147483648", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("dropped", printed, StringComparison.Ordinal)
        let stdout = CompileAndRun(printed, "C.Run()")
        Assert.Equal("-2147483648", stdout.Trim())
    }

    @Fact
    func UlongValueWithNoInt32Spelling_IsDroppedWithDiagnostic() {
        // A genuinely non-representable 64-bit value: high 32 bits (0x1) are
        // NOT the sign-extension of the low 32 bits (0x0), so no int32 bit
        // pattern can stand in for it — the Info diagnostic + drop-to-ordinal
        // fallback must still fire here.
        const Source = `
using System;

namespace Demo
{
    public enum Flags64 : ulong { Unrepresentable = 0x1_0000_0000UL }
}
`
        let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("Snippet.cs", Source)})
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Info && d.Message!!.Contains(
                "outside the int32 range",
                StringComparison.Ordinal
            )
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
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Info && d.Message!!.Contains(
                    "outside the int32 range",
                    StringComparison.Ordinal
                )
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
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2005-e2e", Guid.NewGuid().ToString("N"))
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
