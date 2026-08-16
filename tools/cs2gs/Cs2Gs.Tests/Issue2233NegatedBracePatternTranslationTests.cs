// <copyright file="Issue2233NegatedBracePatternTranslationTests.cs" company="GSharp">
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
/// Translation tests for issue #2233: a negated bare recursive (declaration)
/// pattern used as an early-exit guard — <c>if (x is not { } v) { return; }</c>
/// — dropped the binding for <c>v</c> in code following the guard, because
/// <see cref="CSharpToGSharpTranslator"/>'s existing hoisted-nullable-local
/// lowering for <c>is not T t</c> (issue #914) only matched a pattern that
/// carries an explicit type test; a bare <c>{ }</c> pattern (no type, e.g.
/// unwrapping a nullable field like <c>DateTimeOffset?</c>) fell through to a
/// naive translation that rewrote the guard condition but never bound the
/// pattern variable, producing gsc GS0125 ("Variable 'v' doesn't exist").
///
/// The fix generalizes the same hoisted-nullable-local mechanism: for a bare
/// pattern the hoisted local's type is the receiver's own non-null type (no
/// <c>as</c> downcast is emitted, which also sidesteps <c>as</c>'s
/// reference-only restriction for a nullable value-type receiver).
/// <para>
/// ADR-0166 / issue #3409: G# now scopes pattern variables the way C# definite
/// assignment does, so a qualifying <c>x is { } v</c> — positive or negated —
/// is emitted verbatim (<c>if !(x is { } v) { return }</c>, then plain
/// <c>v</c>) with no hoisted local at all. The hoist lowering above remains the
/// fallback when the binder is later reassigned (G# pattern variables are
/// <c>let</c>-immutable) and is witnessed by
/// <see cref="NegatedBracePattern_ReferenceTypeReceiver_ReassignedBinder_HoistsBindingPastIf"/>.
/// </para>
/// </summary>
public class Issue2233NegatedBracePatternTranslationTests
{
    /// <summary>
    /// The issue's exact repro shape: a negated bare pattern early-exit guard
    /// over a nullable-value-type FIELD keeps <c>at</c> bound (and usable) in
    /// the code that follows the guard.
    /// </summary>
    [Fact]
    public void NegatedBracePattern_NullableValueTypeField_KeepsBinderAsNativePatternVariable()
    {
        string printed = TranslateUnit(@"
using System;
namespace Demo
{
    public class C
    {
        private DateTimeOffset? promptShownAt;
        private static readonly TimeSpan ExitWindow = TimeSpan.FromSeconds(2);

        public bool ToastActive(Func<DateTimeOffset> clock)
        {
            if (promptShownAt is not { } at)
            {
                return false;
            }

            return clock() - at <= ExitWindow;
        }
    }
}");

        // ADR-0166 / issue #3409: native `!(x is { } at)` guard; no hoisted
        // `let at DateTimeOffset? = promptShownAt` / `if at == nil`.
        Assert.Contains("if !(promptShownAt is { } at) {", printed);
        Assert.Contains("clock() - at <= C.ExitWindow", printed);
        Assert.DoesNotContain("let at", printed);
        Assert.DoesNotContain("== nil", printed);
        Assert.DoesNotContain("as DateTimeOffset", printed);

        CompileAndRun(printed, "C().ToastActive(func () DateTimeOffset { return DateTimeOffset.UtcNow })");
    }

    /// <summary>
    /// Generalization: the same guard over a LOCAL nullable value type (not a
    /// field), confirming the fix is not hardcoded to fields or to
    /// <c>DateTimeOffset?</c>.
    /// </summary>
    [Fact]
    public void NegatedBracePattern_LocalNullableValueType_KeepsBinderAsNativePatternVariable()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int G()
        {
            int? maybe = 41;
            if (maybe is not { } value)
            {
                return -1;
            }

            return value + 1;
        }
    }
}");

        // ADR-0166 / issue #3409: native `!(maybe is { } value)` guard; no
        // hoisted `let value int32? = maybe` / `if value == nil`.
        Assert.Contains("if !(maybe is { } value) {", printed);
        Assert.Contains("value + 1", printed);
        Assert.DoesNotContain("let value", printed);
        Assert.DoesNotContain("== nil", printed);

        CompileAndRun(printed, "C().G()");
    }

    /// <summary>
    /// Witness for the hoisted-nullable-local lowering over a nullable
    /// REFERENCE type (no downcast, since there is no type test).
    /// ADR-0166 / issue #3409: the native <c>!(s is { } text)</c> form only
    /// applies while <c>text</c> is never reassigned; this input reassigns
    /// <c>text</c> after the guard, so the translator must still hoist a mutable
    /// nullable local above the exiting <c>if</c>.
    /// </summary>
    [Fact]
    public void NegatedBracePattern_ReferenceTypeReceiver_ReassignedBinder_HoistsBindingPastIf()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int G(string s)
        {
            if (s is not { } text)
            {
                return -1;
            }

            text = text.Trim();
            return text.Length;
        }
    }
}");

        Assert.Contains("var text string? = s", printed);
        Assert.Contains("if text == nil", printed);
        Assert.Contains("text = text.Trim()", printed);
        Assert.Contains("text.Length", printed);
        Assert.DoesNotContain("as string", printed);
        Assert.DoesNotContain("is { } text", printed);

        CompileAndRun(printed, "C().G(\"hi\")");
    }

    /// <summary>
    /// Standalone positive bare pattern (<c>if (x is { } v) { ... }</c>, no
    /// trailing <c>&amp;&amp;</c>) over a NON-nullable <c>string</c>: C# still
    /// treats <c>s is { }</c> as a runtime null test, and ADR-0166 / issue #3409
    /// keeps it as the native <c>s is { } text</c> pattern variable (no
    /// <c>if let</c>, which ADR-0071 reserves for a nullable initializer, no
    /// scoped <c>let text = s</c> local, no <c>__spillN</c>).
    /// </summary>
    [Fact]
    public void PositiveBracePattern_Standalone_IsNativePatternVariable()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int G(string s)
        {
            if (s is { } text)
            {
                return text.Length;
            }

            return -1;
        }
    }
}");

        Assert.Contains("if s is { } text {", printed);
        Assert.Contains("return text.Length", printed);
        Assert.DoesNotContain("let text", printed);
        Assert.DoesNotContain("!= nil", printed);
        Assert.DoesNotContain("if let", printed);
        Assert.DoesNotContain("__spill", printed);

        CompileAndRun(printed, "C().G(\"hi\")");
    }

    /// <summary>
    /// Case B (issue #2233 fix-direction item 3): a positive bare pattern
    /// AND-combined with a further condition.
    /// <para>
    /// Issue #3359 replaced the smart-cast form (<c>x != nil &amp;&amp; …x!!…</c>)
    /// with an <c>if let</c> whose guard was nested in the then-branch.
    /// ADR-0166 / issue #3409 goes one step further: the pattern variable stays
    /// in the condition (<c>promptShownAt is { } at &amp;&amp; now - at &lt;= …</c>),
    /// so the binder keeps its name, there is no <c>!!</c>, the nullable FIELD is
    /// read once, and the C# short-circuit shape survives verbatim.
    /// </para>
    /// </summary>
    [Fact]
    public void PositiveBracePattern_AndCombinedWithCondition_IsNativePatternVariable()
    {
        string printed = TranslateUnit(@"
using System;
namespace Demo
{
    public class C
    {
        private DateTimeOffset? promptShownAt;
        private static readonly TimeSpan ExitWindow = TimeSpan.FromSeconds(2);

        public bool ToastActive(DateTimeOffset now)
        {
            if (promptShownAt is { } at && now - at <= ExitWindow)
            {
                return true;
            }

            return false;
        }
    }
}");

        Assert.Contains("if promptShownAt is { } at && now - at <= C.ExitWindow {", printed);
        Assert.DoesNotContain("if let", printed);
        Assert.DoesNotContain("promptShownAt!!", printed);
        Assert.DoesNotContain("__spill", printed);

        CompileAndRun(printed, "C().ToastActive(DateTimeOffset.UtcNow)");
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
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    /// <summary>
    /// Compiles <paramref name="printed"/> (with <paramref name="callExpression"/>
    /// appended as a top-level entry statement) with the real <c>gsc</c> and runs
    /// it — proving the translated snippet actually binds (GS0125 is a
    /// binder-time error a parse-only round-trip cannot catch).
    /// </summary>
    private static void CompileAndRun(string printed, string callExpression)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2233-e2e", Guid.NewGuid().ToString("N"));
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

        (int runExit, string runOut) = RunDotnet($"\"{dllPath}\"");
        Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + runOut);
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
