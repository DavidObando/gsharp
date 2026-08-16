// <copyright file="Issue914WhileConditionHoistTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for the <c>Oahu.Decrypt</c> migration fix tracked under
/// issue #914: a <c>while</c>/<c>do-while</c> whose condition carries a
/// side-effecting <c>is</c>-pattern clause (a call declaring <c>out var</c>
/// matched against an <c>and</c>/<c>not</c> pattern combinator). G# has no
/// <c>and</c>/<c>not</c> combinators, so the naive lowering re-emitted the
/// scrutinee per sub-test — re-running the call and re-declaring the
/// <c>out var</c> (→ GS0102). The fix hoists the scrutinee to a single local at
/// the top of the loop body and converts the trailing pattern tests into
/// <c>break</c> guards, keeping the leading side-effect-free clauses as the real
/// loop condition. Since ADR-0166 / issue #3409, G# accepts pattern variables
/// (and the ADR-0162 <c>and</c>/<c>not</c> combinators) directly in a boolean
/// <c>is</c>, so a loop whose designations all qualify is emitted verbatim and
/// the hoist remains the fallback for the other shapes. Each snippet must
/// round-trip-parse through the real G# parser.
/// </summary>
public class Issue914WhileConditionHoistTranslationTests
{
    /// <summary>
    /// The motivating <c>Frame.LoadChildren</c> shape:
    /// <c>while (a &amp;&amp; b &amp;&amp; M(out var n) is Frame child and not EmptyFrame)</c>.
    /// ADR-0166 / issue #3409: the whole condition is emitted verbatim as a native
    /// pattern variable in the loop condition — the scrutinee call, the
    /// <c>out var</c> declaration and the binder each appear exactly once and no
    /// hoist local or <c>break</c> guard is produced.
    /// </summary>
    [Fact]
    public void WhileWithOutVarAndPatternCombinator_UsesNativePatternVariable()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public abstract class Frame { }

    public sealed class EmptyFrame : Frame { }

    public sealed class RealFrame : Frame { }

    public static class TagFactory
    {
        public static Frame CreateTag(out int lengthRead)
        {
            lengthRead = 1;
            return new RealFrame();
        }
    }

    public sealed class Loader
    {
        public System.Collections.Generic.List<Frame> Children { get; } = new();

        public void LoadChildren(int endPosition)
        {
            int position = 0;
            int origPosition = position;

            while (position < endPosition
                && origPosition == position
                && TagFactory.CreateTag(out var lengthRead) is Frame child and not EmptyFrame)
            {
                origPosition += lengthRead;
                Children.Add(child);
            }
        }
    }
}");

        // ADR-0166 / issue #3409: the whole condition — leading pure clauses, the
        // side-effecting scrutinee, the `and not` combinator and the binder — is
        // the native loop condition.
        Assert.Contains(
            "while position < endPosition && origPosition == position && (TagFactory.CreateTag(out var lengthRead) is Frame child and not EmptyFrame) {",
            printed);

        // No hoist local and no `break` guard are produced.
        Assert.DoesNotContain("let child", printed);
        Assert.DoesNotContain("break", printed);
        Assert.DoesNotContain("__spill", printed);

        // The `out var` declaration and the call must each appear exactly once.
        Assert.Equal(1, CountOccurrences(printed, "out var lengthRead"));
        Assert.Equal(1, CountOccurrences(printed, "TagFactory.CreateTag"));

        // The body reads the pattern variable and the out-var.
        Assert.Contains("origPosition += lengthRead", printed);
        Assert.Contains("Children.Add(child)", printed);
    }

    /// <summary>
    /// A plain <c>while</c> with no pattern binding or side-effecting duplicated
    /// scrutinee must be left as a plain <c>while cond { }</c> — the hoist
    /// transform must not regress ordinary loops.
    /// </summary>
    [Fact]
    public void SimpleWhile_IsNotHoisted()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public int Sum(int n)
        {
            int i = 0;
            int total = 0;
            while (i < n)
            {
                total += i;
                i++;
            }

            return total;
        }
    }
}");

        Assert.Contains("while i < n {", printed);
        Assert.DoesNotContain("break", printed);
    }

    /// <summary>
    /// A <c>while</c> whose only condition is a side-effecting pattern clause
    /// (no leading pure clauses). ADR-0166 / issue #3409: the pattern is the
    /// native loop condition (no <c>while true</c> + hoist + <c>break</c> guard).
    /// </summary>
    [Fact]
    public void WhilePatternOnly_UsesNativePatternVariableCondition()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public abstract class Node { }

    public sealed class Stop : Node { }

    public sealed class Step : Node { }

    public static class Source
    {
        public static Node Next(out int read)
        {
            read = 1;
            return new Step();
        }
    }

    public sealed class C
    {
        public int Drain()
        {
            int consumed = 0;
            while (Source.Next(out var read) is Node node and not Stop)
            {
                consumed += read;
            }

            return consumed;
        }
    }
}");

        Assert.Contains("while (Source.Next(out var read) is Node node and not Stop) {", printed);
        Assert.Contains("consumed += read", printed);
        Assert.DoesNotContain("while true {", printed);
        Assert.DoesNotContain("let node", printed);
        Assert.DoesNotContain("break", printed);
        Assert.Equal(1, CountOccurrences(printed, "out var read"));
        Assert.Equal(1, CountOccurrences(printed, "Source.Next"));
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        for (int index = haystack.IndexOf(needle, StringComparison.Ordinal);
            index >= 0;
            index = haystack.IndexOf(needle, index + needle.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
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
}
