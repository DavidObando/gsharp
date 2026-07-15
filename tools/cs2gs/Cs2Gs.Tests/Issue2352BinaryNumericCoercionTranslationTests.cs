// <copyright file="Issue2352BinaryNumericCoercionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2352: <see cref="CSharpToGSharpTranslator"/>'s mixed-numeric binary
/// coercion (in <c>TranslateBinaryExpression</c>) used the leading operand's
/// (or trailing operand's) declared C# type as the coercion TARGET for the
/// opposite side whenever that opposite side was a compile-time constant —
/// even when the constant's own numeric kind was <c>float</c>/<c>double</c>/
/// <c>decimal</c> and the non-constant side was an INTEGRAL type (e.g.
/// <c>long</c>). That reversed C#'s binary numeric promotion: C# always
/// widens the integral operand up to the floating-point/decimal type,
/// regardless of which side happens to be a compile-time constant (and even
/// when the constant is itself folded from a nested compile-time-constant
/// sub-expression, e.g. <c>1.0 * 2.0</c>, rather than a bare literal). The old
/// code instead silently narrowed the constant DOWN to the non-constant
/// integral operand's type, changing both the emitted operator's result type
/// and its runtime value.
/// <para>
/// Fix: the "retype the constant to the other operand's type" fast path (a
/// deliberate G# ergonomic choice — see <c>Issue914NumericCoercionTranslationTests.
/// NumericCoercion_NullableValueTarget_KeepsAsForm</c> — that mirrors C#'s
/// constant-expression narrowing conversions, C# §10.2.11, which are defined
/// ONLY between integral types) now applies only when BOTH operands' numeric
/// kinds are integral. Every combination involving a <c>float</c>/<c>double</c>/
/// <c>decimal</c> operand instead falls through to the existing
/// converted-type-driven coercion, which always follows Roslyn's own
/// (correct) C# binary numeric promotion direction — independent of which
/// side is a compile-time constant.
/// </para>
/// </summary>
public class Issue2352BinaryNumericCoercionTranslationTests
{
    /// <summary>
    /// The exact real-world <c>Oahu.Diagnostics.PipelineProbeCheck</c> shape: a
    /// <c>const double</c> folded from a compile-time-constant arithmetic
    /// sub-expression (<c>1000.0 / 60.0</c>) added to a non-constant <c>long</c>
    /// counter. The non-constant <c>long</c> must widen to <c>float64</c>; the
    /// constant double must NOT be narrowed down to <c>int64</c>.
    /// </summary>
    [Fact]
    public void PipelineProbeCheck_LongPlusConstantFoldedDouble_WidensLongInsteadOfNarrowingConstant()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("float64(sampleCount)", printed);
        Assert.DoesNotContain("int64(", printed);
    }

    /// <summary>
    /// Direct repro of the reported defect: a non-constant <c>long</c> added to a
    /// constant-folded <c>double</c> sub-expression (<c>1.0 * 2.0</c>, not a bare
    /// literal) must widen the <c>long</c>, never narrow the double constant.
    /// </summary>
    [Fact]
    public void LongPlusConstantFoldedDoubleExpression_WidensLong()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public double D(long x) => x + 1.0 * 2.0;
    }
}");

        Assert.Contains("float64(x)", printed);
        Assert.DoesNotContain("int64(", printed);
    }

    /// <summary>
    /// Operand order: the constant-folded double expression on the LEFT and the
    /// non-constant <c>long</c> on the RIGHT must produce the identical widening
    /// direction (the constant's position must not change which operand is
    /// coerced).
    /// </summary>
    [Fact]
    public void ConstantFoldedDoubleExpressionPlusLong_WidensLong_OperandOrderReversed()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public double D(long x) => 1.0 * 2.0 + x;
    }
}");

        Assert.Contains("float64(x)", printed);
        Assert.DoesNotContain("int64(", printed);
    }

    /// <summary>
    /// The same widening direction must hold for a comparison operator (<c>&gt;</c>),
    /// not just arithmetic operators.
    /// </summary>
    [Fact]
    public void ComparisonOperator_LongVersusConstantFoldedDouble_WidensLong()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public bool Cmp(long x) => x > (1.0 * 2.0);
    }
}");

        Assert.Contains("float64(x)", printed);
        Assert.DoesNotContain("int64(", printed);
    }

    /// <summary>
    /// Nested constant sub-expression: an inner (both-integral) promotion
    /// combines a non-constant <c>long</c> with an integer literal correctly, and
    /// the OUTER promotion (the resulting <c>long</c> expression against a
    /// constant-folded <c>double</c>) must still widen the whole inner
    /// sub-expression to <c>float64</c>, not narrow the outer double constant.
    /// </summary>
    [Fact]
    public void NestedConstantExpression_OuterFloatingPromotionWidensInnerIntegralResult()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public double Nested(long x) => (x + 1) + (2.0 * 3.0);
    }
}");

        Assert.Contains("float64(", printed);
        Assert.DoesNotContain("int64(x + int64(1))", printed);
        Assert.DoesNotContain("int64((x + int64(1)))", printed);
    }

    /// <summary>
    /// <c>float</c>/<c>long</c> combination: the non-constant <c>long</c> widens to
    /// <c>float32</c> for a constant <c>float</c> literal operand.
    /// </summary>
    [Fact]
    public void LongPlusFloatConstant_WidensLongToFloat32()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public float F(long x) => x + 1.5f;
    }
}");

        Assert.Contains("float32(x)", printed);
        Assert.DoesNotContain("int64(", printed);
    }

    /// <summary>
    /// <c>float</c>/<c>double</c> combination: a non-constant <c>float</c> widens to
    /// <c>float64</c> for a constant <c>double</c> operand (neither side is
    /// integral, exercising the converted-type-driven path for a
    /// float32-&gt;float64 promotion).
    /// </summary>
    [Fact]
    public void FloatPlusDoubleConstant_WidensFloatToFloat64()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public double F(float f) => f + 2.0;
    }
}");

        Assert.Contains("float64(f)", printed);
    }

    /// <summary>
    /// <c>decimal</c>/<c>long</c> combination: the non-constant <c>long</c> widens
    /// to <c>decimal</c> for a constant <c>decimal</c> literal operand.
    /// </summary>
    [Fact]
    public void LongPlusDecimalConstant_WidensLongToDecimal()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public decimal D(long x) => x + 5m;
    }
}");

        Assert.Contains("decimal(x)", printed);
        Assert.DoesNotContain("int64(", printed);
    }

    /// <summary>
    /// <c>decimal</c>/<c>int</c>-constant combination (reverse direction): a
    /// non-constant <c>decimal</c> operand is left unchanged, and the integer
    /// constant widens to <c>decimal</c>.
    /// </summary>
    [Fact]
    public void DecimalPlusIntConstant_WidensIntConstantToDecimal()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public decimal D(decimal d) => d + 5;
    }
}");

        Assert.Contains("decimal(5)", printed);
    }

    /// <summary>
    /// A <c>checked</c> context must not change the widening direction: the
    /// exact defect scenario, wrapped in <c>checked(...)</c>, still widens the
    /// non-constant <c>long</c> instead of narrowing the double constant.
    /// </summary>
    [Fact]
    public void CheckedContext_LongPlusConstantFoldedDouble_StillWidensLong()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public double D(long x) => checked(x + 1.0 * 2.0);
    }
}");

        Assert.Contains("float64(x)", printed);
        Assert.DoesNotContain("int64(", printed);
    }

    /// <summary>
    /// An <c>unchecked</c> context (both operands integral, no floating-point
    /// operand present) must remain unaffected: a same-width integral
    /// combination performs no coercion at all.
    /// </summary>
    [Fact]
    public void UncheckedContext_BothLong_NoCoercionNeeded()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public long D(long x) => unchecked(x + 100L * 2L);
    }
}");

        Assert.DoesNotContain("int64(", printed);
        Assert.DoesNotContain("float64(", printed);
    }

    /// <summary>
    /// Negative/regression control: the pre-existing purely-integral
    /// constant-narrowing ergonomics (issue #914 / the nullable
    /// <c>uint16?</c> comparison) must be entirely unaffected by the new
    /// integral-only gate, since both operands there ARE integral.
    /// </summary>
    [Fact]
    public void RegressionControl_NullableUshortEqualsIntConstant_StillNarrowsConstant()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Entry { public ushort ChannelCount { get; set; } }

    public class C
    {
        public bool IsStereo(Entry? e) => e?.ChannelCount == 2;
    }
}");

        Assert.Contains("(2 as uint16?)", printed);
    }

    /// <summary>
    /// Negative/regression control: the pre-existing byte-vs-int-literal
    /// comparison (both integral) must still narrow the literal to the
    /// concrete non-nullable value type via the conversion-call form.
    /// </summary>
    [Fact]
    public void RegressionControl_ByteGreaterThanIntConstant_StillNarrowsConstant()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public bool F(byte b) => b > 1;
    }
}");

        Assert.Contains("uint8(1)", printed);
        Assert.DoesNotContain("as uint8", printed);
    }

    /// <summary>
    /// Negative/regression control: the pre-existing bitwise operator promotion
    /// (both integral) must still narrow the constant operand.
    /// </summary>
    [Fact]
    public void RegressionControl_BitwiseOperator_StillNarrowsIntegralConstant()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public uint B(uint a) => a & 0xFF;
    }
}");

        Assert.Contains("& uint32(", printed);
        Assert.DoesNotContain("as uint32", printed);
    }

    /// <summary>
    /// Ambiguity/negative control: two ALREADY-matching floating-point operands
    /// (both <c>double</c>) must not trigger any coercion at all — the widening
    /// fix must not introduce a spurious conversion when the underlying kinds
    /// already agree.
    /// </summary>
    [Fact]
    public void MatchingDoubleOperands_NoCoercionIntroduced()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public double D(double x, double y) => x + y * 2.0;
    }
}");

        Assert.DoesNotContain("float64(x)", printed);
        Assert.DoesNotContain("float64(y)", printed);
    }

    /// <summary>
    /// End-to-end (real <c>gsc</c> compile + run): the exact
    /// <c>PipelineProbeCheck</c> shape must produce the SAME floating-point
    /// result C# would compute (<c>long</c> widened to <c>double</c> before the
    /// addition), not an integer-truncated value.
    /// </summary>
    [Fact]
    public void PipelineProbeCheck_EndToEnd_ProducesCorrectFloatingPointResult()
    {
        const string Source = @"
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
            Console.WriteLine(PipelineProbeCheck(5L).ToString(""R""));
        }
    }
}
";
        string printed = TranslateAndValidate(Source);
        string stdout = CompileAndRun(printed, "C.Run()");

        double expected = 5L + (1000.0 / 60.0);
        Assert.Equal(expected.ToString("R"), stdout.Trim());
    }

    /// <summary>
    /// End-to-end (real <c>gsc</c> compile + run): both operand orders of the
    /// direct repro must produce the identical, C#-faithful floating-point
    /// result at runtime.
    /// </summary>
    [Fact]
    public void LongPlusConstantFoldedDouble_EndToEnd_BothOperandOrdersMatchCSharp()
    {
        const string Source = @"
using System;

namespace Demo
{
    public static class C
    {
        public static double Forward(long x) => x + 1.25 * 2.0;

        public static double Reversed(long x) => 1.25 * 2.0 + x;

        public static void Run()
        {
            Console.WriteLine(Forward(3L).ToString(""R""));
            Console.WriteLine(Reversed(3L).ToString(""R""));
        }
    }
}
";
        string printed = TranslateAndValidate(Source);
        string stdout = CompileAndRun(printed, "C.Run()");

        string[] lines = stdout.Trim().Replace("\r\n", "\n").Split('\n');
        Assert.Equal(2, lines.Length);
        Assert.Equal((3L + 1.25 * 2.0).ToString("R"), lines[0].Trim());
        Assert.Equal((1.25 * 2.0 + 3L).ToString("R"), lines[1].Trim());
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static string TranslateAndValidate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    /// <summary>
    /// Compiles <paramref name="printed"/> (with <paramref name="callExpression"/>
    /// appended as a top-level entry statement) with the real <c>gsc</c> and runs
    /// it, returning stdout.
    /// </summary>
    private static string CompileAndRun(string printed, string callExpression)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2352-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        string dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine);

        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut +
                "\n\nTranslated G#:\n" + printed);

        (int runExit, string stdout) = RunDotnet($"\"{dllPath}\"");
        Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + stdout);
        return stdout;
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var psi = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using var process = Process.Start(psi);
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }
}
