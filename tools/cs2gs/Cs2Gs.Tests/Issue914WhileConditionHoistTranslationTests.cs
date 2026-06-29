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
/// loop condition. Each snippet must round-trip-parse through the real G# parser.
/// </summary>
public class Issue914WhileConditionHoistTranslationTests
{
    /// <summary>
    /// The motivating <c>Frame.LoadChildren</c> shape:
    /// <c>while (a &amp;&amp; b &amp;&amp; M(out var n) is Frame child and not EmptyFrame)</c>.
    /// The leading pure clauses stay in the loop condition; the scrutinee is
    /// evaluated once into <c>let child = …</c>; the <c>not EmptyFrame</c> test
    /// becomes an <c>if child is EmptyFrame { break }</c> guard; and the
    /// <c>out var</c> declaration appears exactly once.
    /// </summary>
    [Fact]
    public void WhileWithOutVarAndPatternCombinator_HoistsScrutineeOnce()
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

        // Leading side-effect-free clauses remain the real loop condition.
        Assert.Contains("while position < endPosition && origPosition == position {", printed);

        // The scrutinee is evaluated once into the hoist local reusing the binder name.
        Assert.Contains("let child = TagFactory.CreateTag(out var lengthRead)", printed);

        // The `not EmptyFrame` arm becomes a break guard.
        Assert.Contains("if child is EmptyFrame {", printed);
        Assert.Contains("break", printed);

        // The `out var` declaration and the call must each appear exactly once.
        Assert.Equal(1, CountOccurrences(printed, "out var lengthRead"));
        Assert.Equal(1, CountOccurrences(printed, "TagFactory.CreateTag"));

        // The body still reads the hoisted binder and out-var.
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
    /// (no leading pure clauses) hoists the scrutinee with a <c>true</c> loop
    /// condition.
    /// </summary>
    [Fact]
    public void WhilePatternOnly_HoistsWithTrueCondition()
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

        Assert.Contains("while true {", printed);
        Assert.Contains("let node = Source.Next(out var read)", printed);
        Assert.Contains("if node is Stop {", printed);
        Assert.Equal(1, CountOccurrences(printed, "out var read"));
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
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
