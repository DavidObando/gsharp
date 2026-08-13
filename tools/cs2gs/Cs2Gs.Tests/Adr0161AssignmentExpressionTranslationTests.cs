// <copyright file="Adr0161AssignmentExpressionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0161 / issue #3350: a C# assignment used in value position translates to
/// G#'s assignment EXPRESSION, emitted where C# put it.
/// <para>
/// The premise this replaces was that "G# assignment is statement-only" — stated
/// in the translator's own comments and in issue #3347. It was false. Because of
/// it, an assignment inside a short-circuited <c>&amp;&amp;</c> / <c>||</c> /
/// <c>??</c> operand — which genuinely cannot be hoisted into a preceding
/// statement, since its write must run only when that operand is evaluated — was
/// reported <c>Unsupported</c> and then <b>silently dropped</b> (issue #1723).
/// </para>
/// </summary>
public class Adr0161AssignmentExpressionTranslationTests
{
    /// <summary>
    /// The #1723 reproducer. Before ADR-0161 this emitted `if a &amp;&amp; (5) &gt; 0`
    /// — the write to `x` gone entirely — plus an Unsupported diagnostic.
    /// </summary>
    [Fact]
    public void ShortCircuitedAndOperand_PreservesTheWrite()
    {
        (string printed, TranslationContext context) = Translate(@"
public sealed class C
{
    public void M(bool a)
    {
        int x = 0;
        if (a && (x = 5) > 0) { System.Console.WriteLine(x); }
    }
}");

        Assert.Contains("(x = 5)", printed, StringComparison.Ordinal);
        AssertNoUnsupported(context, printed);
    }

    [Fact]
    public void ShortCircuitedCoalesceOperand_PreservesTheWrite()
    {
        (string printed, TranslationContext context) = Translate(@"
#nullable enable
public sealed class C
{
    public void M(string? s)
    {
        string? t = null;
        System.Console.WriteLine(s ?? (t = ""fallback""));
    }
}");

        Assert.Contains(@"(t = ""fallback"")", printed, StringComparison.Ordinal);
        AssertNoUnsupported(context, printed);
    }

    /// <summary>
    /// A C# source-level paren around the assignment must not double up with the
    /// parentheses the assignment expression renders for itself.
    /// </summary>
    [Fact]
    public void SourceLevelParentheses_AreNotDoubled()
    {
        (string printed, _) = Translate(@"
public sealed class C
{
    public void M(bool a)
    {
        int x = 0;
        if (a && (x = 5) > 0) { System.Console.WriteLine(x); }
    }
}");

        Assert.DoesNotContain("((x = 5))", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The assignment must stay INSIDE the short-circuited operand — hoisting it
    /// ahead of the condition would run the write unconditionally, which is the
    /// opposite error from dropping it.
    /// </summary>
    [Fact]
    public void ShortCircuitedWrite_IsNotHoistedAheadOfTheCondition()
    {
        (string printed, _) = Translate(@"
public sealed class C
{
    public void M(bool a)
    {
        int x = 0;
        if (a && (x = 5) > 0) { System.Console.WriteLine(x); }
    }
}");

        int conditionIndex = printed.IndexOf("if a &&", StringComparison.Ordinal);
        int writeIndex = printed.IndexOf("x = 5", StringComparison.Ordinal);
        Assert.True(conditionIndex >= 0, "Expected the `if` condition in:\n" + printed);
        Assert.True(
            writeIndex > conditionIndex,
            "The write must stay inside the short-circuited operand, not be hoisted:\n" + printed);
    }

    /// <summary>
    /// A conditional-access branch is short-circuited the same way and was
    /// covered by the same Unsupported report.
    /// </summary>
    [Fact]
    public void ConditionalAccessBranch_PreservesTheWrite()
    {
        (string printed, TranslationContext context) = Translate(@"
#nullable enable
public sealed class Node { public int Value; }

public sealed class C
{
    public void M(Node? n)
    {
        int seen = 0;
        System.Console.WriteLine(n?.Value.ToString() ?? (seen = 1).ToString());
    }
}");

        Assert.Contains("seen = 1", printed, StringComparison.Ordinal);
        AssertNoUnsupported(context, printed);
    }

    /// <summary>
    /// A `??=` write is conditional on the target being nil and G# has no
    /// coalescing-assignment EXPRESSION, so it keeps its existing hoisting path
    /// rather than being emitted in place.
    /// </summary>
    [Fact]
    public void CoalesceAssignment_KeepsExistingLowering()
    {
        (string printed, _) = Translate(@"
#nullable enable
public sealed class C
{
    public void M(string? s)
    {
        string? t = null;
        t ??= s;
        System.Console.WriteLine(t);
    }
}");

        Assert.Contains("??=", printed, StringComparison.Ordinal);
    }

    private static void AssertNoUnsupported(TranslationContext context, string printed)
    {
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported && d.Message.Contains("1723"));

        RoundTripResult roundTrip = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            roundTrip.Success,
            "Translated G# must round-trip. Errors:\n" + string.Join("\n", roundTrip.Errors)
                + "\n\nPrinted:\n" + printed);
    }

    private static (string Printed, TranslationContext Context) Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", "using System;\n\nnamespace Demo\n{\n" + source + "\n}\n") });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return (GSharpPrinter.Print(unit), context);
    }
}
