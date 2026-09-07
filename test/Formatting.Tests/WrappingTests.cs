// <copyright file="WrappingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Formatting.Tests;

/// <summary>
/// ADR-0179 phase 6. The exit criterion the ADR names for wrapping is a
/// line-width property test, so that is what this file is built around: one
/// over-long source per breakable construct, each asserted to come back inside
/// the canonical width, to survive the round-trip check, and to be a fixed
/// point of the formatter.
/// </summary>
public sealed class WrappingTests
{
    private const int MaxLineWidth = 120;

    /// <summary>
    /// Gets one over-long source per construct the formatter is expected to
    /// break. Each is a single logical line well past the budget with at least
    /// one legal break point inside it.
    /// </summary>
    public static TheoryData<string, string> WideShapes()
    {
        var data = new TheoryData<string, string>();
        foreach (KeyValuePair<string, string> shape in Shapes())
        {
            data.Add(shape.Key, shape.Value);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(WideShapes))]
    public void Format_KeepsEveryLineWithinTheCanonicalWidth(string name, string input)
    {
        FormatResult result = GSharpFormatter.Format(SourceText.From(input));

        Assert.True(
            result.Diagnostics.IsEmpty,
            name + ": " + string.Join(Environment.NewLine, result.Diagnostics.Select(d => d.Message)));

        // A line may only exceed the width when a single token already does —
        // the formatter is not allowed to break a literal or an identifier.
        foreach (string line in result.Text!.ToString().Split('\n'))
        {
            Assert.True(
                line.Length <= MaxLineWidth || WidestAtom(line) + Indentation(line) > MaxLineWidth,
                name + ": line exceeded the canonical width: " + line);
        }
    }

    [Theory]
    [MemberData(nameof(WideShapes))]
    public void Format_IsAFixedPointOnItsOwnWrappedOutput(string name, string input)
    {
        // The wrapped output is the input the formatter sees most often — the
        // language server re-formats on every save, and `gsfmt --check` re-runs
        // itself in CI (ADR-0179 D4). A break the layout invents on pass one and
        // then re-reads as an author newline on pass two is not idempotent, and
        // that is exactly what a continuation indent used to be.
        FormatResult once = GSharpFormatter.Format(SourceText.From(input));
        Assert.True(once.Diagnostics.IsEmpty, name);

        FormatResult twice = GSharpFormatter.Format(once.Text!);
        Assert.True(twice.Diagnostics.IsEmpty, name);
        Assert.Equal(once.Text!.ToString(), twice.Text!.ToString());
        Assert.False(twice.Changed, name + ": formatting its own output changed it.");
    }

    [Fact]
    public void Format_ReflowsAContinuationItPreviouslyWrapped()
    {
        // The regression in miniature: a hard break kept from the input landed
        // at the enclosing indent, dropping the +4 the group had used, so the
        // second pass produced different text from the first.
        const string input =
            "func run(alpha bool, beta bool) bool {\n"
            + "    return alpha &&\n"
            + "(beta || alpha)\n"
            + "}\n";

        FormatResult once = GSharpFormatter.Format(SourceText.From(input));
        FormatResult twice = GSharpFormatter.Format(once.Text!);

        Assert.Empty(once.Diagnostics);
        Assert.Equal(once.Text!.ToString(), twice.Text!.ToString());
        Assert.Contains("return alpha && (beta || alpha)", once.Text!.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Format_KeepsAnArgumentsOwnChainFlatWhenTheArgumentListBreaks()
    {
        // Each element of a list is its own group, so breaking the list does not
        // break what is inside the elements. Without that, one over-long call
        // exploded every operator and every `.` in every argument.
        string arguments = string.Join(
            ", ",
            Enumerable.Range(0, 8).Select(index => $"first{index} + second{index} + third{index}"));
        string input = $"func run() {{\nCompute({arguments})\n}}\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));
        string formatted = result.Text!.ToString();

        Assert.Empty(result.Diagnostics);
        Assert.Contains("\n    Compute(\n        first0 + second0 + third0,\n", formatted, StringComparison.Ordinal);
    }

    [Fact]
    public void Format_DoesNotStrandTheReceiverOfAShortMemberChain()
    {
        // `Console.WriteLine(<block argument>)` is one link. Breaking it put
        // `Console` alone on a line and `.WriteLine(` on the next, which is the
        // single ugliest shape the wrapped corpus produced.
        const string input =
            "func run() {\n"
            + "Console.WriteLine(func (value int32) int32 {\n"
            + "return value + value\n"
            + "})\n"
            + "}\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));

        Assert.Empty(result.Diagnostics);
        Assert.Contains("Console.WriteLine(", result.Text!.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Format_BreaksAMemberChainLongEnoughToReadVertically()
    {
        const string input =
            "func run(text string) string {\n"
            + "return text.ToUpper().Trim().ToLowerInvariant().Replace(\"alpha\", \"beta\")"
            + ".Substring(0, 3).PadLeft(40).TrimEnd().ToUpperInvariant().Normalize().Trim()\n"
            + "}\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));

        Assert.Empty(result.Diagnostics);
        Assert.Contains("\n        .ToUpper()\n", result.Text!.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Format_BreaksAPatternDisjunction()
    {
        // G# spells pattern `or`/`and` as contextual identifiers, not operator
        // tokens, so this arm had no break point of any kind and stayed long no
        // matter how the rest of the layout improved.
        string patterns = string.Join(
            " or ",
            Enumerable.Range(0, 12).Select(index => $"SyntaxKind.TokenNumber{index}"));
        string input =
            "func run(kind SyntaxKind) bool {\n"
            + $"return switch kind {{\ncase {patterns}: true\ndefault: false\n}}\n"
            + "}\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));
        string formatted = result.Text!.ToString();

        Assert.Empty(result.Diagnostics);
        Assert.Contains("SyntaxKind.TokenNumber0 or\n", formatted, StringComparison.Ordinal);
        Assert.All(
            formatted.Split('\n'),
            line => Assert.True(line.Length <= MaxLineWidth, "line exceeded the canonical width: " + line));
    }

    private static IEnumerable<KeyValuePair<string, string>> Shapes()
    {
        string wide = string.Join(
            ", ",
            Enumerable.Range(0, 12).Select(index => $"\"argument value number {index}\""));

        yield return Shape("call argument list", $"func run() {{\nCompute({wide})\n}}\n");

        yield return Shape(
            "nested single-argument call",
            $"func run() {{\nOuter(Inner({wide}))\n}}\n");

        yield return Shape(
            "collection literal",
            $"func run() {{\nlet values = []string{{{wide}}}\n}}\n");

        yield return Shape(
            "composite literal",
            "class Point {\n    var X int32\n    var Y int32\n}\n"
            + "func run(n int32) {\n"
            + "let point = Point{X: n + n + n + n + n + n + n + n + n + n + n, "
            + "Y: n * n * n * n * n * n * n * n * n * n * n * n}\n"
            + "}\n");

        yield return Shape(
            "logical operator chain",
            "func run(alpha string, beta string, n int32) bool {\n"
            + "return alpha == \"alpha\" && beta == \"beta\" && n > 100 && alpha != beta "
            + "&& n < 1000 && alpha != \"gamma\" && true\n"
            + "}\n");

        yield return Shape(
            "arithmetic operator chain",
            "func run(n int32) int32 {\n"
            + "return n + n + n + n + n + n + n + n + n + n + n + n + n + n + n + n + n "
            + "+ n + n + n + n + n + n + n + n + n\n"
            + "}\n");

        yield return Shape(
            "if-expression initialiser",
            "func run(alpha string) string {\n"
            + "let chosen = if alpha == \"alpha\" { \"the alpha branch result value here\" } "
            + "else { \"the fallback branch result value here\" }\n"
            + "return chosen\n"
            + "}\n");

        yield return Shape(
            "member chain",
            "func run(text string) string {\n"
            + "return text.ToUpper().Trim().ToLowerInvariant().Replace(\"alpha\", \"beta\")"
            + ".Substring(0, 3).PadLeft(40).TrimEnd().ToUpperInvariant().Normalize().Trim()\n"
            + "}\n");

        yield return Shape(
            "switch-arm pattern disjunction",
            "func run(kind SyntaxKind) bool {\n"
            + "return switch kind {\ncase "
            + string.Join(" or ", Enumerable.Range(0, 12).Select(index => $"SyntaxKind.TokenNumber{index}"))
            + ": true\ndefault: false\n}\n}\n");

        yield return Shape(
            "signature parameter list",
            "func run("
            + string.Join(", ", Enumerable.Range(0, 12).Select(index => $"parameterNumber{index} string"))
            + ") int32 {\nreturn 0\n}\n");
    }

    private static KeyValuePair<string, string> Shape(string name, string input) => new(name, input);

    private static int Indentation(string line) => line.Length - line.TrimStart().Length;

    private static int WidestAtom(string line)
    {
        int widest = 0;
        int index = 0;
        while (index < line.Length)
        {
            int start = index;
            while (index < line.Length && !char.IsWhiteSpace(line[index]))
            {
                index++;
            }

            widest = Math.Max(widest, index - start);
            while (index < line.Length && char.IsWhiteSpace(line[index]))
            {
                index++;
            }
        }

        return widest;
    }
}
