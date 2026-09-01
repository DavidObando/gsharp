// <copyright file="Issue3774CoalescingAssignmentAssertionTests.cs" company="GSharp">
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
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3774 (sweep of the <c>EnsureNonNullAssertion</c> call sites,
/// generalized from #3771): C#'s <c>!</c> is ERASED at compile time, but G#'s
/// <c>!!</c> is a CHECKED assertion that THROWS on nil. Any site that emits
/// <c>!!</c> onto a value that can genuinely be nil at run time therefore adds a
/// throw the original program never had — invisible to the compiler, to
/// ILVerify, and to every binding-only assertion.
/// <para>
/// The site fixed here is the value-position <c>??=</c>
/// (<c>TranslateCoalescingAssignmentAsExpression</c>). The value of
/// <c>x ??= v</c> is nil exactly when <c>v</c> is, but the assertion's guard
/// asked only C#'s own annotations — which are empty in a nullable-OBLIVIOUS
/// compilation, so a same-project member the whole-program taint analysis
/// promoted to <c>T?</c> read as non-null and earned a <c>!!</c> anyway.
/// </para>
/// <para>
/// Two of the four tests EXECUTE the translated G# through the real
/// <c>gsc</c>, because this defect class is definitionally invisible to a
/// text-only assertion. The two "still asserts" tests are anti-vacuity guard
/// rails: they pass on <c>origin/main</c> too, and exist so a fix that simply
/// deleted the assertion could not pass this file.
/// </para>
/// </summary>
public class Issue3774CoalescingAssignmentAssertionTests
{
    private const string PromotedRightHandSideSource = @"
using System;

namespace Demo
{
    public sealed class C
    {
        private static string cache;

        private static string Make()
        {
            return null;
        }

        public static void Run()
        {
            string v = (cache ??= Make());
            Console.WriteLine(v == null ? ""nil"" : v);
        }
    }
}";

    private const string NonNullRightHandSideSource = @"
using System;

namespace Demo
{
    public sealed class C
    {
        private static string cache;

        public static void Run()
        {
            string v = (cache ??= ""d"");
            Console.WriteLine(v);
        }
    }
}";

    /// <summary>
    /// The whole lowered construct is asserted, not a fragment: the #3771 agent
    /// caught its own first draft asserting a substring that main never emitted,
    /// so it passed vacuously. Here the exact conditional-expression form is
    /// pinned and the trailing <c>)!!</c> must be absent from it.
    /// </summary>
    [Fact]
    public void CoalescingAssignmentValue_DoesNotAssertAPromotedNullableRightHandSide()
    {
        string printed = TranslateOblivious(PromotedRightHandSideSource);

        Assert.Contains(
            @"let v string? = (if cache == nil { (cache = Make()) } else { cache })",
            printed);
        Assert.DoesNotContain(
            @"(if cache == nil { (cache = Make()) } else { cache })!!",
            printed);
    }

    /// <summary>
    /// The behavioural half. C# prints <c>nil</c>; on <c>origin/main</c> the
    /// translated G# throws a <see cref="NullReferenceException"/> instead.
    /// </summary>
    [Fact]
    public void CoalescingAssignmentValue_YieldsNilInsteadOfThrowing()
    {
        string printed = TranslateOblivious(PromotedRightHandSideSource);
        string stdout = CompileAndRun(printed, "C.Run()");
        Assert.Equal("nil", stdout.Trim());
    }

    /// <summary>
    /// Anti-vacuity guard rail (passes on <c>origin/main</c> as well): a
    /// right-hand side that genuinely cannot be nil keeps its faithful
    /// assertion, so the fix is a narrowing of the guard rather than a deletion.
    /// </summary>
    [Fact]
    public void CoalescingAssignmentValue_StillAssertsANonNullRightHandSide()
    {
        string printed = TranslateOblivious(NonNullRightHandSideSource);

        Assert.Contains(
            @"(if cache == nil { (cache = ""d"") } else { cache })!!",
            printed);
    }

    /// <summary>
    /// Anti-vacuity guard rail, behavioural half (passes on
    /// <c>origin/main</c> as well): the retained assertion still runs.
    /// </summary>
    [Fact]
    public void CoalescingAssignmentValue_NonNullRightHandSideStillRuns()
    {
        string printed = TranslateOblivious(NonNullRightHandSideSource);
        string stdout = CompileAndRun(printed, "C.Run()");
        Assert.Equal("d", stdout.Trim());
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static string CompileAndRun(string printed, string callExpression)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-3774-e2e", Guid.NewGuid().ToString("N"));
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
        Assert.True(
            runExit == 0,
            "Translated snippet must run successfully. Output:\n" + stdout +
                "\n\nTranslated G#:\n" + printed);
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
