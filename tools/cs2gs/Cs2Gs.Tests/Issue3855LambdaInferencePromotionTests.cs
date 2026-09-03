// <copyright file="Issue3855LambdaInferencePromotionTests.cs" company="GSharp">
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
/// Issue #3855: in a nullable-OBLIVIOUS compilation the #1072 promotion
/// (<c>PromoteIfUsedAsNullable</c>) renders a null-tested parameter <c>T?</c>.
/// That is right for a parameter whose annotation is merely DESCRIPTIVE — the
/// target type is already fixed, and widening an input position is
/// contravariance, so a <c>(T?) -&gt; R</c> literal still converts to a
/// <c>(T) -&gt; R</c> target.
/// <para>
/// It is wrong for a LAMBDA parameter that is an argument to a generic method
/// with INFERRED type arguments. There the annotation is not checked against a
/// target — it CHOOSES one. <c>xs.Where(d =&gt; d != null)</c> emitted
/// <c>.Where((d T?) -&gt; d != nil)</c>, gsc inferred <c>TSource := T?</c>, and
/// the whole sequence widened to <c>sequence[T?]</c>: every downstream member
/// access then ran on a nullable receiver (<c>GS0158 Cannot find member</c> /
/// <c>GS0154</c>) several lines away from the lambda that caused it.
/// </para>
/// <para>
/// The canonical shape is the one from
/// <c>CSharpToGSharpTranslator.PragmaSuppressions.cs</c> — a
/// <c>Select(cast).Where(x =&gt; x is not null).OrderBy(...)</c> chain, which
/// has now defeated two separate fixes (#3835's rewrite and #3854's cast
/// lowering) — so it is asserted here both at the translation level and by
/// EXECUTING the emitted G#.
/// </para>
/// </summary>
public sealed class Issue3855LambdaInferencePromotionTests
{
    /// <summary>
    /// The canonical #3855/#3843 chain, in a nullable-oblivious compilation:
    /// <c>Select</c> an explicit cast, filter the nulls out at sequence level,
    /// then reach a member on the surviving elements.
    /// </summary>
    private const string InequalityChainSource = @"
namespace Demo
{
    using System.Collections.Generic;
    using System.Linq;

    public class Node
    {
        public Node(int span) { this.Span = span; }

        public int Span { get; set; }
    }

    public class Chain
    {
        public static int Total(IEnumerable<object> items)
        {
            var sum = 0;
            foreach (var d in items
                .Select(t => (Node)t)
                .Where(d => d != null)
                .OrderBy(d => d.Span))
            {
                sum += d.Span;
            }

            return sum;
        }
    }
}
";

    /// <summary>
    /// The same chain spelled with the <c>is not null</c> pattern the real
    /// <c>PragmaSuppressions.cs</c> uses — a second, independent entry into
    /// <c>IsUsedAsNullable</c> (its <c>IsPatternExpressionSyntax</c> arm).
    /// </summary>
    private const string PatternChainSource = @"
namespace Demo
{
    using System.Collections.Generic;
    using System.Linq;

    public class Node
    {
        public Node(int span) { this.Span = span; }

        public int Span { get; set; }
    }

    public class PatternChain
    {
        public static int Total(IEnumerable<object> items)
        {
            var sum = 0;
            foreach (var d in items
                .Select(t => (Node)t)
                .Where(d => d is not null)
                .OrderBy(d => d.Span))
            {
                sum += d.Span;
            }

            return sum;
        }
    }
}
";

    /// <summary>
    /// The fix's boundary on the other side: a lambda handed to a NON-generic
    /// callee has a fixed target type, so the #1072 promotion still applies.
    /// Nothing infers from the annotation; the widened input position is plain
    /// contravariance.
    /// </summary>
    private const string FixedTargetSource = @"
namespace Demo
{
    using System;

    public class FixedTarget
    {
        public static void Run(Action<string> handler)
        {
            handler(""x"");
        }

        public static void Go()
        {
            Run(s => { if (s == null) { return; } });
        }
    }
}
";

    /// <summary>
    /// A generic callee whose type arguments are written EXPLICITLY infers
    /// nothing, so the annotation is descriptive again and the promotion stands.
    /// </summary>
    private const string ExplicitTypeArgumentSource = @"
namespace Demo
{
    using System;

    public class ExplicitArgs
    {
        public static void Run<T>(Action<T> handler, T value)
        {
            handler(value);
        }

        public static void Go()
        {
            Run<string>(s => { if (s == null) { return; } }, ""x"");
        }
    }
}
";

    /// <summary>
    /// A generic callee whose lambda parameter position is CONCRETE — the
    /// method's type parameter appears only in the RESULT position — infers
    /// nothing from this annotation either, so the promotion stands. This is
    /// what keeps the rule narrower than "any lambda in any generic call".
    /// </summary>
    private const string ConcreteArrowPositionSource = @"
namespace Demo
{
    using System;

    public class ConcreteArrow
    {
        public static T Run<T>(Func<string, T> project)
        {
            return project(""x"");
        }

        public static int Go()
        {
            return Run(s => s == null ? 0 : s.Length);
        }
    }
}
";

    [Fact]
    public void InferredGenericCall_NullTestedLambdaParameter_IsNotWidenedToNullable()
    {
        string printed = Translate(InequalityChainSource);

        // The whole point: the filter lambda keeps the element type the chain
        // actually carries, so the ORDERING lambda four characters later sees
        // the same type. Asserted on both lambdas, not just the promoted one —
        // the pre-fix output was internally inconsistent on its face
        // (`(d Node?)` feeding `(d Node)`).
        Assert.Contains("(d Node) -> d != nil", printed, StringComparison.Ordinal);
        Assert.Contains("(d Node) -> d.Span", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("(d Node?)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void InferredGenericCall_IsNotNullPattern_IsNotWidenedToNullable()
    {
        string printed = Translate(PatternChainSource);

        Assert.Contains("(d Node) -> d != nil", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("(d Node?)", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The executing half. On <c>origin/main</c> the emitted G# does not even
    /// compile (<c>GS0158 Cannot find member Span</c> plus <c>GS0129</c> on the
    /// accumulation), so this pins BOTH that gsc accepts the emitted chain and
    /// that it computes the same answer the C# does — 3 + 1 = 4 — rather than,
    /// say, silently dropping the filtered elements.
    /// </summary>
    [Fact]
    public void InferredGenericCall_TranslatedChainCompilesAndProducesTheCSharpAnswer()
    {
        string printed = Translate(InequalityChainSource);
        string stdout = CompileAndRun(
            printed,
            "let xs = []object{ Node(3), Node(1) }\nSystem.Console.WriteLine(Chain.Total(xs).ToString())");

        Assert.Equal("4", stdout.Trim());
    }

    /// <summary>
    /// The <c>is not null</c> spelling must reach the same executable answer as
    /// the <c>!= null</c> one — the two entries into <c>IsUsedAsNullable</c>
    /// must not diverge.
    /// </summary>
    [Fact]
    public void InferredGenericCall_PatternChainCompilesAndProducesTheCSharpAnswer()
    {
        string printed = Translate(PatternChainSource);
        string stdout = CompileAndRun(
            printed,
            "let xs = []object{ Node(3), Node(1) }\nSystem.Console.WriteLine(PatternChain.Total(xs).ToString())");

        Assert.Equal("4", stdout.Trim());
    }

    /// <summary>
    /// The THIRD seam behind <c>PragmaSuppressions.cs</c> (the two above are the
    /// #3843 cast lowering and the #3855 lambda promotion): the #3501 yield
    /// element-taint rule already stands down for a yield a null guard
    /// dominates (#3700/#3714), but its <c>IsNullTestOf</c> only recognised a
    /// BARE test. The real shape conjoins the guard with the test it protects —
    /// <c>if (text != null &amp;&amp; text.StartsWith("GSA")) { yield return
    /// text; }</c> — so the iterator's element widened to <c>string?</c> and the
    /// widened element then failed every non-nullable consumer downstream
    /// (<c>GS0155</c> at <c>state[id] = disable</c>).
    /// </summary>
    private const string ConjoinedYieldGuardSource = @"
namespace Demo
{
    using System.Collections.Generic;

    public class Ids
    {
        public static IEnumerable<string> Names(IEnumerable<string> raw)
        {
            foreach (string candidate in raw)
            {
                string text = candidate.Length == 0 ? null : candidate;
                if (text != null && text.StartsWith(""G""))
                {
                    yield return text;
                }
            }
        }

        public static int Count(IEnumerable<string> raw)
        {
            var seen = new Dictionary<string, bool>();
            foreach (string id in Names(raw))
            {
                seen[id] = true;
            }

            return seen.Count;
        }
    }
}
";

    [Fact]
    public void ConjoinedYieldGuard_DoesNotWidenTheIteratorElement()
    {
        string printed = Translate(ConjoinedYieldGuardSource);

        Assert.Contains("Names(raw IEnumerable[string]) sequence[string]", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("sequence[string?]", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The executing half: the guard the analyzer now believes really does hold
    /// at run time, so the narrowed element must not merely compile — it must
    /// produce the same answer, and no <c>!!</c> in the emitted chain may throw.
    /// </summary>
    [Fact]
    public void ConjoinedYieldGuard_CompilesAndProducesTheCSharpAnswer()
    {
        string printed = Translate(ConjoinedYieldGuardSource);
        string stdout = CompileAndRun(
            printed,
            "let xs = []string{ \"Ga\", \"\", \"Gb\", \"z\" }\nSystem.Console.WriteLine(Ids.Count(xs).ToString())");

        Assert.Equal("2", stdout.Trim());
    }

    [Fact]
    public void FixedDelegateTarget_NullTestedLambdaParameter_IsStillPromoted()
    {
        string printed = Translate(FixedTargetSource);

        Assert.Contains("(s string?)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ExplicitTypeArguments_NullTestedLambdaParameter_IsStillPromoted()
    {
        string printed = Translate(ExplicitTypeArgumentSource);

        Assert.Contains("(s string?)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ConcreteArrowPositionInGenericCall_NullTestedLambdaParameter_IsStillPromoted()
    {
        string printed = Translate(ConcreteArrowPositionSource);

        Assert.Contains("(s string?)", printed, StringComparison.Ordinal);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            Microsoft.CodeAnalysis.NullableContextOptions.Disable,
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
            "Translated G# must round-trip. Errors:\n" + string.Join("\n", result.Errors)
                + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static string CompileAndRun(string printed, string entryStatements)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-3855-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        string dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(
            gsPath,
            printed + Environment.NewLine + entryStatements + Environment.NewLine);

        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut
                + "\n\nTranslated G#:\n" + printed);

        (int runExit, string stdout) = RunDotnet($"\"{dllPath}\"");
        Assert.True(
            runExit == 0,
            "Translated snippet must run successfully. Output:\n" + stdout
                + "\n\nTranslated G#:\n" + printed);
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

        using Process process = Process.Start(psi);
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
