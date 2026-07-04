// <copyright file="Issue2005EnumTopBitValueTranslationTests.cs" company="GSharp">
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
/// Issue #2005: <see cref="CSharpToGSharpTranslator.VisitEnumDeclaration"/>
/// reinterprets each member's constant bits via <c>ToEnumBitPattern</c> (a
/// <c>ulong</c>) and then range-checked it as a signed <c>long</c> against
/// <c>int.MinValue</c>/<c>int.MaxValue</c>. For an unsigned underlying type's
/// top-bit-set value (e.g. <c>enum X : uint { High = 1u &lt;&lt; 31 }</c>), the
/// bit pattern (<c>2147483648UL</c>) is a POSITIVE <c>long</c> above
/// <c>int.MaxValue</c>, even though its low 32 bits are the perfectly valid
/// (negative) int32 bit pattern <c>int.MinValue</c> — so the check incorrectly
/// dropped the member's value (with an Info diagnostic) instead of
/// reinterpreting it. This is distinct from issue #1912 (fixed): that issue
/// covers the binder's own G# constant-folding; this one is cs2gs's C#→G#
/// value-printing side.
/// <para>
/// Fix: reinterpret the low 32 bits of the bit pattern directly as an int32
/// bit pattern (<c>unchecked((int)(uint)bits)</c>) for every underlying type
/// whose width is <![CDATA[<=]]> 32 bits (byte/sbyte/short/ushort/int/uint —
/// always representable this way), and only fall back to the drop+diagnostic
/// path for a genuine 64-bit (<c>long</c>/<c>ulong</c>) value whose high 32
/// bits aren't the sign-extension of its low 32 bits (i.e. truly has no int32
/// spelling).
/// </para>
/// Every claim here is verified by actually compiling the translated G# with
/// the real <c>gsc</c> and running it, so a value that merely LOOKS right in
/// the printed text (but binds/emits wrong) cannot slip through.
/// </summary>
public class Issue2005EnumTopBitValueTranslationTests
{
    [Fact]
    public void UintTopBitValue_SurvivesTranslationAndMatchesCSharpBitPatternAtRuntime()
    {
        const string Source = @"
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
";
        string printed = TranslateAndValidate(Source);

        Assert.Contains("High = -2147483648", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("dropped", printed, StringComparison.Ordinal);

        string stdout = CompileAndRun(printed, "C.Run()");
        Assert.Equal("-2147483648", stdout.Trim());
    }

    [Fact]
    public void ByteTopBitValue_SurvivesTranslationAndMatchesCSharpBitPatternAtRuntime()
    {
        const string Source = @"
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
";
        string printed = TranslateAndValidate(Source);

        Assert.Contains("High = 128", printed, StringComparison.Ordinal);

        string stdout = CompileAndRun(printed, "C.Run()");
        Assert.Equal("128", stdout.Trim());
    }

    [Fact]
    public void UshortTopBitValue_SurvivesTranslationAndMatchesCSharpBitPatternAtRuntime()
    {
        const string Source = @"
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
";
        string printed = TranslateAndValidate(Source);

        Assert.Contains("High = 32768", printed, StringComparison.Ordinal);

        string stdout = CompileAndRun(printed, "C.Run()");
        Assert.Equal("32768", stdout.Trim());
    }

    [Fact]
    public void UlongValueRepresentableAsInt32BitPattern_SurvivesTranslationAndMatchesCSharpBitPatternAtRuntime()
    {
        // 0xFFFFFFFF80000000 is a 64-bit value whose high 32 bits ARE the
        // proper sign-extension of its low 32 bits (0x80000000 = int.MinValue);
        // it has a faithful int32 spelling even though it's `ulong`-backed and
        // its low 32 bits have the top bit set, so it must survive translation
        // exactly like the 32-bit-underlying-type cases above.
        const string Source = @"
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
";
        string printed = TranslateAndValidate(Source);

        Assert.Contains("High = -2147483648", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("dropped", printed, StringComparison.Ordinal);

        string stdout = CompileAndRun(printed, "C.Run()");
        Assert.Equal("-2147483648", stdout.Trim());
    }

    [Fact]
    public void UlongValueWithNoInt32Spelling_IsDroppedWithDiagnostic()
    {
        // A genuinely non-representable 64-bit value: high 32 bits (0x1) are
        // NOT the sign-extension of the low 32 bits (0x0), so no int32 bit
        // pattern can stand in for it — the Info diagnostic + drop-to-ordinal
        // fallback must still fire here.
        const string Source = @"
using System;

namespace Demo
{
    public enum Flags64 : ulong { Unrepresentable = 0x1_0000_0000UL }
}
";
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", Source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Info &&
                d.Message.Contains("outside the int32 range", StringComparison.Ordinal));
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
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Info &&
                d.Message.Contains("outside the int32 range", StringComparison.Ordinal));

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

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2005-e2e", Guid.NewGuid().ToString("N"));
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
