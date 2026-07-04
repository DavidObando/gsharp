// <copyright file="Issue1912ExplicitEnumValueTranslationTests.cs" company="GSharp">
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
/// Issue #1912: <see cref="CSharpToGSharpTranslator.VisitEnumDeclaration"/>
/// silently dropped every C# enum member's explicit constant value, always
/// re-numbering cases sequentially from 0 — a real behavioral divergence
/// (baseline C# <c>banana=2</c>, migrated G# <c>banana=1</c>), not just a
/// translation gap. It also erased <c>[Flags]</c>, negative values, and alias
/// members (<c>DefaultError = ServerError</c>).
/// <para>
/// Root cause: G# itself had no grammar for an explicit enum-member value.
/// The fix adds that language feature (<c>Name = constExpr</c>, constant-folded
/// at bind time — see <c>Issue1912ExplicitEnumMemberValueTests</c> in
/// Core.Tests) and updates the translator to read each C# member's resolved
/// <c>IFieldSymbol.ConstantValue</c> and emit an explicit <c>= value</c> only
/// when it diverges from the default auto-numbered ordinal (matching C#
/// §19.4's own "implicit member continues from the last explicit one" rule).
/// <c>[Flags]</c> is preserved via the existing generic `@Attribute` → CLR
/// custom-attribute annotation mechanism (<c>@Flags</c> resolves to
/// <c>System.FlagsAttribute</c>).
/// </para>
/// Every claim here is verified by actually compiling the translated G# with
/// the real <c>gsc</c> and running it, so a value that merely LOOKS right in
/// the printed text (but binds/emits wrong) cannot slip through.
/// </summary>
public class Issue1912ExplicitEnumValueTranslationTests
{
    [Fact]
    public void ExplicitPositiveValues_SurviveTranslationAndMatchCSharpAtRuntime()
    {
        const string Source = @"
using System;

namespace Demo
{
    public enum Fruit { Apple = 1, Banana = 2, Cherry = 4 }

    public static class C
    {
        public static void Run()
        {
            Fruit picked = Fruit.Banana;
            Console.WriteLine(((int)picked).ToString() + "","" + ((int)Fruit.Cherry).ToString());
        }
    }
}
";
        string printed = TranslateAndValidate(Source);

        // Cherry=4 diverges from the auto-continued ordinal (3) and must be
        // explicit; Banana=2 already matches Apple=1's auto-continuation, so it
        // stays implicit — this is the intended "only spell out real
        // divergences" behavior (mirrors C# §19.4's own continuation rule).
        Assert.Contains("enum Fruit { Apple = 1, Banana, Cherry = 4 }", printed, StringComparison.Ordinal);

        string stdout = CompileAndRun(printed, "C.Run()");
        Assert.Equal("2,4", stdout.Trim());
    }

    [Fact]
    public void NegativeAndLargeValues_SurviveTranslationAndMatchCSharpAtRuntime()
    {
        const string Source = @"
using System;

namespace Demo
{
    public enum StatusCode { Unknown = -1, Ok = 200, ServerError = 500 }

    public static class C
    {
        public static void Run()
        {
            Console.WriteLine(((int)StatusCode.Unknown).ToString() + "","" + ((int)StatusCode.ServerError).ToString());
        }
    }
}
";
        string printed = TranslateAndValidate(Source);

        Assert.Contains("Unknown = -1", printed, StringComparison.Ordinal);
        Assert.Contains("ServerError = 500", printed, StringComparison.Ordinal);

        string stdout = CompileAndRun(printed, "C.Run()");
        Assert.Equal("-1,500", stdout.Trim());
    }

    [Fact]
    public void MinValueAndShiftedIntValues_SurviveTranslationAndMatchCSharpAtRuntime()
    {
        // Regression: the decimal literal 2147483648 (int.MinValue's magnitude)
        // lexes as uint in G#, not int, so a naive fold of a negated/high-bit
        // value used to fail to compile with "must be a constant int32
        // expression" (issue #1912 follow-up). Covers int.MinValue itself and
        // `1 << 31`, both of which the C# semantic model resolves to the same
        // int32 bit pattern.
        const string Source = @"
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
                ((int)MinValueEnum.Reserved).ToString() + "","" +
                ((int)ShiftedEnum.Reserved).ToString());
        }
    }
}
";
        string printed = TranslateAndValidate(Source);

        Assert.Contains("Reserved = -2147483648", printed, StringComparison.Ordinal);

        string stdout = CompileAndRun(printed, "C.Run()");
        Assert.Equal("-2147483648,-2147483648", stdout.Trim());
    }

    [Fact]
    public void AliasMember_SurvivesTranslationAndEqualsOriginalAtRuntime()
    {
        const string Source = @"
using System;

namespace Demo
{
    public enum StatusCode { ServerError = 500, DefaultError = ServerError }

    public static class C
    {
        public static void Run()
        {
            Console.WriteLine(((int)StatusCode.DefaultError).ToString() + "","" + (StatusCode.DefaultError == StatusCode.ServerError));
        }
    }
}
";
        string printed = TranslateAndValidate(Source);

        // The alias resolves to the same numeric constant as its target member.
        Assert.Contains("DefaultError = 500", printed, StringComparison.Ordinal);

        string stdout = CompileAndRun(printed, "C.Run()");
        Assert.Equal("500,True", stdout.Trim());
    }

    [Fact]
    public void FlagsBitShiftAndOrMembers_SurviveTranslationAndMatchCSharpAtRuntime()
    {
        const string Source = @"
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
                ((int)Access.Read).ToString() + "","" +
                ((int)Access.Write).ToString() + "","" +
                ((int)Access.ReadWrite).ToString() + "","" +
                (Access.ReadWrite == (Access.Read | Access.Write)));
        }
    }
}
";
        string printed = TranslateAndValidate(Source);

        Assert.Contains("@Flags", printed, StringComparison.Ordinal);
        Assert.Contains("Read = 4", printed, StringComparison.Ordinal);
        Assert.Contains("Write = 8", printed, StringComparison.Ordinal);
        Assert.Contains("ReadWrite = 12", printed, StringComparison.Ordinal);

        string stdout = CompileAndRun(printed, "C.Run()");
        Assert.Equal("4,8,12,True", stdout.Trim());
    }

    [Fact]
    public void ImplicitMembersMatchingDefaultOrdinal_OmitRedundantExplicitValue()
    {
        // C# `Apple, Banana, Cherry` (implicit 0,1,2) must still print WITHOUT
        // an explicit `= value` — only a divergent value should ever be spelled
        // out, keeping the common case's G# output unchanged.
        const string Source = @"
using System;

namespace Demo
{
    public enum Fruit { Apple, Banana, Cherry }
}
";
        string printed = TranslateAndValidate(Source);

        Assert.Contains("enum Fruit { Apple, Banana, Cherry }", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("=", printed, StringComparison.Ordinal);
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

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-1912-e2e", Guid.NewGuid().ToString("N"));
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
