// <copyright file="Issue2352BinaryNumericCoercionTranslationTests.cs" company="GSharp">
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

/// Issue #2352: (cref:CSharpToGSharpTranslator)'s mixed-numeric binary
/// coercion (in `TranslateBinaryExpression`) used the leading operand's
/// (or trailing operand's) declared C# type as the coercion TARGET for the
/// opposite side whenever that opposite side was a compile-time constant —
/// even when the constant's own numeric kind was `float`/`double`/
/// `decimal` and the non-constant side was an INTEGRAL type (e.g.
/// `long`). That reversed C#'s binary numeric promotion: C# always
/// widens the integral operand up to the floating-point/decimal type,
/// regardless of which side happens to be a compile-time constant (and even
/// when the constant is itself folded from a nested compile-time-constant
/// sub-expression, e.g. `1.0 * 2.0`, rather than a bare literal). The old
/// code instead silently narrowed the constant DOWN to the non-constant
/// integral operand's type, changing both the emitted operator's result type
/// and its runtime value.
///
/// Fix: the "retype the constant to the other operand's type" fast path (a
/// deliberate G# ergonomic choice — see `Issue914NumericCoercionTranslationTests.
/// NumericCoercion_NullableValueTarget_KeepsAsForm` — that mirrors C#'s
/// constant-expression narrowing conversions, C# §10.2.11, which are defined
/// ONLY between integral types) now applies only when BOTH operands' numeric
/// kinds are integral. Every combination involving a `float`/`double`/
/// `decimal` operand instead falls through to the existing
/// converted-type-driven coercion, which always follows Roslyn's own
/// (correct) C# binary numeric promotion direction — independent of which
/// side is a compile-time constant.
open class Issue2352BinaryNumericCoercionTranslationTests {
    /// The exact real-world `Oahu.Diagnostics.PipelineProbeCheck` shape: a
    /// `const double` folded from a compile-time-constant arithmetic
    /// sub-expression (`1000.0 / 60.0`) added to a non-constant `long`
    /// counter. The non-constant `long` must widen to `float64`; the
    /// constant double must NOT be narrowed down to `int64`.
    @Fact
    func PipelineProbeCheck_LongPlusConstantFoldedDouble_WidensLongInsteadOfNarrowingConstant() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        private const double SamplesPerTick = 1000.0 / 60.0;

        public double PipelineProbeCheck(long sampleCount)
        {
            return sampleCount + SamplesPerTick;
        }
    }
}`)
        Assert.Contains("float64(sampleCount)", printed)
        Assert.DoesNotContain("int64(", printed)
    }

    /// Direct repro of the reported defect: a non-constant `long` added to a
    /// constant-folded `double` sub-expression (`1.0 * 2.0`, not a bare
    /// literal) must widen the `long`, never narrow the double constant.
    @Fact
    func LongPlusConstantFoldedDoubleExpression_WidensLong() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public double D(long x) => x + 1.0 * 2.0;
    }
}`)
        Assert.Contains("float64(x)", printed)
        Assert.DoesNotContain("int64(", printed)
    }

    /// Operand order: the constant-folded double expression on the LEFT and the
    /// non-constant `long` on the RIGHT must produce the identical widening
    /// direction (the constant's position must not change which operand is
    /// coerced).
    @Fact
    func ConstantFoldedDoubleExpressionPlusLong_WidensLong_OperandOrderReversed() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public double D(long x) => 1.0 * 2.0 + x;
    }
}`)
        Assert.Contains("float64(x)", printed)
        Assert.DoesNotContain("int64(", printed)
    }

    /// The same widening direction must hold for a comparison operator (`>`),
    /// not just arithmetic operators.
    @Fact
    func ComparisonOperator_LongVersusConstantFoldedDouble_WidensLong() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public bool Cmp(long x) => x > (1.0 * 2.0);
    }
}`)
        Assert.Contains("float64(x)", printed)
        Assert.DoesNotContain("int64(", printed)
    }

    /// Nested constant sub-expression: an inner (both-integral) promotion
    /// combines a non-constant `long` with an integer literal correctly, and
    /// the OUTER promotion (the resulting `long` expression against a
    /// constant-folded `double`) must still widen the whole inner
    /// sub-expression to `float64`, not narrow the outer double constant.
    @Fact
    func NestedConstantExpression_OuterFloatingPromotionWidensInnerIntegralResult() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public double Nested(long x) => (x + 1) + (2.0 * 3.0);
    }
}`)
        Assert.Contains("float64(", printed)
        Assert.DoesNotContain("int64(x + int64(1))", printed)
        Assert.DoesNotContain("int64((x + int64(1)))", printed)
    }

    /// `float`/`long` combination: the non-constant `long` widens to
    /// `float32` for a constant `float` literal operand.
    @Fact
    func LongPlusFloatConstant_WidensLongToFloat32() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public float F(long x) => x + 1.5f;
    }
}`)
        Assert.Contains("float32(x)", printed)
        Assert.DoesNotContain("int64(", printed)
    }

    /// `float`/`double` combination: a non-constant `float` widens to
    /// `float64` for a constant `double` operand (neither side is
    /// integral, exercising the converted-type-driven path for a
    /// float32->float64 promotion).
    @Fact
    func FloatPlusDoubleConstant_WidensFloatToFloat64() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public double F(float f) => f + 2.0;
    }
}`)
        Assert.Contains("float64(f)", printed)
    }

    /// `decimal`/`long` combination: the non-constant `long` widens
    /// to `decimal` for a constant `decimal` literal operand.
    @Fact
    func LongPlusDecimalConstant_WidensLongToDecimal() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public decimal D(long x) => x + 5m;
    }
}`)
        Assert.Contains("decimal(x)", printed)
        Assert.DoesNotContain("int64(", printed)
    }

    /// `decimal`/`int`-constant combination (reverse direction): a
    /// non-constant `decimal` operand is left unchanged, and the integer
    /// constant widens to `decimal`.
    @Fact
    func DecimalPlusIntConstant_WidensIntConstantToDecimal() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public decimal D(decimal d) => d + 5;
    }
}`)
        Assert.Contains("decimal(5)", printed)
    }

    /// A `checked` context must not change the widening direction: the
    /// exact defect scenario, wrapped in `checked(...)`, still widens the
    /// non-constant `long` instead of narrowing the double constant.
    @Fact
    func CheckedContext_LongPlusConstantFoldedDouble_StillWidensLong() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public double D(long x) => checked(x + 1.0 * 2.0);
    }
}`)
        Assert.Contains("float64(x)", printed)
        Assert.DoesNotContain("int64(", printed)
    }

    /// An `unchecked` context (both operands integral, no floating-point
    /// operand present) must remain unaffected: a same-width integral
    /// combination performs no coercion at all.
    @Fact
    func UncheckedContext_BothLong_NoCoercionNeeded() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public long D(long x) => unchecked(x + 100L * 2L);
    }
}`)
        Assert.DoesNotContain("int64(", printed)
        Assert.DoesNotContain("float64(", printed)
    }

    /// Negative/regression control: the pre-existing purely-integral
    /// constant-narrowing ergonomics (issue #914 / the nullable
    /// `uint16?` comparison) must be entirely unaffected by the new
    /// integral-only gate, since both operands there ARE integral.
    @Fact
    func RegressionControl_NullableUshortEqualsIntConstant_StillNarrowsConstant() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Entry { public ushort ChannelCount { get; set; } }

    public class C
    {
        public bool IsStereo(Entry? e) => e?.ChannelCount == 2;
    }
}`)
        Assert.Contains("(2 as uint16?)", printed)
    }

    /// Negative/regression control: the pre-existing byte-vs-int-literal
    /// comparison (both integral) must still narrow the literal to the
    /// concrete non-nullable value type via the conversion-call form.
    @Fact
    func RegressionControl_ByteGreaterThanIntConstant_StillNarrowsConstant() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public bool F(byte b) => b > 1;
    }
}`)
        Assert.Contains("uint8(1)", printed)
        Assert.DoesNotContain("as uint8", printed)
    }

    /// Negative/regression control: the pre-existing bitwise operator promotion
    /// (both integral) must still narrow the constant operand.
    @Fact
    func RegressionControl_BitwiseOperator_StillNarrowsIntegralConstant() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public uint B(uint a) => a & 0xFF;
    }
}`)
        Assert.Contains("& uint32(", printed)
        Assert.DoesNotContain("as uint32", printed)
    }

    /// Ambiguity/negative control: two ALREADY-matching floating-point operands
    /// (both `double`) must not trigger any coercion at all — the widening
    /// fix must not introduce a spurious conversion when the underlying kinds
    /// already agree.
    @Fact
    func MatchingDoubleOperands_NoCoercionIntroduced() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public double D(double x, double y) => x + y * 2.0;
    }
}`)
        Assert.DoesNotContain("float64(x)", printed)
        Assert.DoesNotContain("float64(y)", printed)
    }

    /// End-to-end (real `gsc` compile + run): the exact
    /// `PipelineProbeCheck` shape must produce the SAME floating-point
    /// result C# would compute (`long` widened to `double` before the
    /// addition), not an integer-truncated value.
    @Fact
    func PipelineProbeCheck_EndToEnd_ProducesCorrectFloatingPointResult() {
        const Source = `
using System;

namespace Demo
{
    public static class C
    {
        private const double SamplesPerTick = 1000.0 / 60.0;

        public static double PipelineProbeCheck(long sampleCount)
        {
            return sampleCount + SamplesPerTick;
        }

        public static void Run()
        {
            Console.WriteLine(PipelineProbeCheck(5L).ToString("R"));
        }
    }
}
`
        let printed = TranslateAndValidate(Source)
        let stdout = CompileAndRun(printed, "C.Run()")
        let expected = float64(5.0) + (1000.0 / 60.0)
        Assert.Equal(expected.ToString("R"), stdout.Trim())
    }

    /// End-to-end (real `gsc` compile + run): both operand orders of the
    /// direct repro must produce the identical, C#-faithful floating-point
    /// result at runtime.
    @Fact
    func LongPlusConstantFoldedDouble_EndToEnd_BothOperandOrdersMatchCSharp() {
        const Source = `
using System;

namespace Demo
{
    public static class C
    {
        public static double Forward(long x) => x + 1.25 * 2.0;

        public static double Reversed(long x) => 1.25 * 2.0 + x;

        public static void Run()
        {
            Console.WriteLine(Forward(3L).ToString("R"));
            Console.WriteLine(Reversed(3L).ToString("R"));
        }
    }
}
`
        let printed = TranslateAndValidate(Source)
        let stdout = CompileAndRun(printed, "C.Run()")
        let lines = stdout.Trim().ReplaceLineEndings(Environment.NewLine).Split(Environment.NewLine)
        Assert.Equal(2, lines.Length)
        Assert.Equal((float64(3.0) + 1.25 * 2.0).ToString("R"), lines[0].Trim())
        Assert.Equal((1.25 * 2.0 + float64(3.0)).ToString("R"), lines[1].Trim())
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
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2352-e2e", Guid.NewGuid().ToString("N"))
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
