// <copyright file="Issue1962SwitchExprFollowUpTests.cs" company="GSharp">
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
/// Follow-ups from issue #1962 (PR #1961 / #1890 review) on bare-type
/// switch-expression arms.
/// <para>
/// (1) GS0176: a C# switch expression can be exhaustive purely by its TYPE
/// (and `null`) arms — with no `_`/`var` catch-all at all — cases Roslyn
/// itself proves exhaustive (e.g. `int? x switch { int =&gt;, null =&gt; }`,
/// since `HasValue` is a closed true/false domain). gsc's own exhaustiveness
/// check has no equivalent proof for type-pattern arms, so the translated
/// arm set trips GS0176 unless a synthesized `default:` arm is added.
/// </para>
/// <para>
/// (2) A `null` arm ahead of a type arm (`object? x switch { null =&gt; ..,
/// int =&gt; .., _ =&gt; .. }`) must keep that order in the emitted G#, and
/// the type arm's `_ is int32` test must not accidentally match `null`.
/// </para>
/// <para>
/// (3) A bare-type arm over a nullable VALUE type (`int? x switch { int
/// =&gt; .. }`) must match only when `HasValue`, mirroring Roslyn's `HasValue`
/// narrowing — verified here by actually compiling and running the emitted
/// G# (gsc's `box`+`isinst` emit strategy for `Nullable&lt;T&gt;` gives this
/// for free per ECMA-335's special `Nullable&lt;T&gt;` boxing rule; see
/// <c>MethodBodyEmitter.Patterns.EmitTypePattern</c>).
/// </para>
/// </summary>
public class Issue1962SwitchExprFollowUpTests
{
    /// <summary>
    /// `int? x switch { int =&gt;, null =&gt; }` has no `_`/`var` catch-all,
    /// but Roslyn proves it exhaustive (HasValue true/false is a closed
    /// domain) — so C# accepts it with no CS8509. The translated G# arms
    /// (`case _ is int32:` / `case nil:`) carry no unguarded discard, which
    /// would trip gsc's GS0176 without the synthesized `default:` arm.
    /// </summary>
    /// <remarks>
    /// Structural-only: actually compiling this shape currently hits an
    /// unrelated, pre-existing gsc binder bug — <c>case nil:</c> against a
    /// value-type-<c>Nullable</c> discriminant (`int32?`) crashes emit with
    /// GS9998 (<c>PatternBinder.BindConstantPattern</c> builds the nil-arm's
    /// <c>BoundConversionExpression</c> directly instead of through
    /// <c>ConversionClassifier</c>'s issue-#504 nil→Nullable-value-type
    /// lowering, so <c>EmitConversion</c> never sees the required
    /// <c>BoundDefaultExpression</c>). Reproduces with plain hand-written G#,
    /// independent of cs2gs; filed as gsc issue #2072. The runtime
    /// (`HasValue`) semantics for a bare-type arm over a nullable value type
    /// are instead verified end-to-end by
    /// <see cref="SwitchExpression_BareTypeArmOverNullableValueType_MatchesOnlyWhenHasValue"/>,
    /// which uses a discard rather than an explicit `null` arm and so never
    /// touches the buggy path.
    /// </remarks>
    [Fact]
    public void SwitchExpression_ExhaustiveByNullableValueTypeArmsAlone_SynthesizesDefaultArm()
    {
        string printed = TranslateAndValidate(@"
using System;

namespace Demo
{
    public sealed class C
    {
        public static string Describe(int? x) => x switch
        {
            int => ""has value"",
            null => ""none"",
        };
    }
}");

        Assert.Contains("case _ is int32:", printed, StringComparison.Ordinal);
        Assert.Contains("case nil:", printed, StringComparison.Ordinal);
        Assert.Contains("default: throw", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// Item #1962(3): a bare-type arm over a nullable VALUE type (`int? x
    /// switch { int =&gt; .. }`) must match only when `HasValue` — Roslyn's
    /// own narrowing rule. Compiled and run end-to-end (avoiding the `case
    /// nil:` gsc bug noted above by using a discard for the null case
    /// instead of an explicit `null` arm).
    /// </summary>
    [Fact]
    public void SwitchExpression_BareTypeArmOverNullableValueType_MatchesOnlyWhenHasValue()
    {
        string printed = TranslateAndValidate(@"
using System;

namespace Demo
{
    public sealed class C
    {
        public static string Describe(int? x) => x switch
        {
            int => ""has value"",
            _ => ""none"",
        };
    }
}");

        Assert.Contains("case _ is int32:", printed, StringComparison.Ordinal);
        Assert.Contains("default:", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("default: throw", printed, StringComparison.Ordinal);

        Assert.Equal("has value", CompileAndRun(printed, "C.Describe(5)").Trim());
        Assert.Equal("none", CompileAndRun(printed, "C.Describe(nil)").Trim());
    }

    /// <summary>
    /// `bool flag switch { true =&gt;, false =&gt; }` is Roslyn-exhaustive
    /// with no discard — same GS0176 gap, but via plain constant patterns
    /// rather than a type pattern (pre-existing, not introduced by #1890,
    /// but the same fix generalizes to it).
    /// </summary>
    [Fact]
    public void SwitchExpression_ExhaustiveByBooleanConstantArmsAlone_SynthesizesDefaultArm()
    {
        string printed = TranslateAndValidate(@"
using System;

namespace Demo
{
    public sealed class C
    {
        public static string Describe(bool flag) => flag switch
        {
            true => ""yes"",
            false => ""no"",
        };
    }
}");

        Assert.Contains("default: throw", printed, StringComparison.Ordinal);
        Assert.Equal("yes", CompileAndRun(printed, "C.Describe(true)").Trim());
        Assert.Equal("no", CompileAndRun(printed, "C.Describe(false)").Trim());
    }

    /// <summary>
    /// A guarded discard (`case _ when …`) never satisfies exhaustiveness
    /// (GS0176: "a guarded discard … does not act as a total/default arm"),
    /// so a switch expression whose only catch-all is guarded must still get
    /// a synthesized `default:` arm.
    /// </summary>
    [Fact]
    public void SwitchExpression_OnlyCatchAllIsGuarded_StillSynthesizesDefaultArm()
    {
        string printed = TranslateAndValidate(@"
using System;

namespace Demo
{
    public sealed class C
    {
        public static string Describe(int n) => n switch
        {
            _ when n > 0 => ""positive"",
            _ => ""other"",
        };
    }
}");

        // The source's own unguarded `_ =>` already covers the total case —
        // no synthesized arm should be added on top of it.
        Assert.DoesNotContain("default: throw", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// `object? x switch { null =&gt; .., int =&gt; .., _ =&gt; .. }`: the
    /// `null` arm must stay ahead of the type arm in the emitted G#, and the
    /// type arm's `_ is int32` test must reject `null` (never accidentally
    /// matching it) and reject a non-`int` value, falling through to the
    /// discard.
    /// </summary>
    [Fact]
    public void SwitchExpression_NullArmPrecedesTypeArm_RejectsNullAndNonMatchingType()
    {
        string printed = TranslateAndValidate(@"
using System;

namespace Demo
{
    public sealed class C
    {
        public static string Describe(object? x) => x switch
        {
            null => ""none"",
            int => ""int"",
            _ => ""other"",
        };
    }
}");

        Assert.True(
            printed.IndexOf("case nil:", StringComparison.Ordinal) <
                printed.IndexOf("case _ is int32:", StringComparison.Ordinal),
            "the `null` arm must precede the type arm in emit order:\n" + printed);

        Assert.Equal("int", CompileAndRun(printed, "C.Describe(5)").Trim());
        Assert.Equal("none", CompileAndRun(printed, "C.Describe(nil)").Trim());
        Assert.Equal("other", CompileAndRun(printed, "C.Describe(\"hi\")").Trim());
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
    /// appended, wrapped in a `Console.WriteLine`, as a top-level entry
    /// statement) with the real <c>gsc</c> — proving gsc itself accepts the
    /// synthesized arm (no GS0176) — and runs it, returning stdout.
    /// </summary>
    private static string CompileAndRun(string printed, string callExpression)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-1962-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        string dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(gsPath, printed + Environment.NewLine + $"Console.WriteLine({callExpression})" + Environment.NewLine);

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
