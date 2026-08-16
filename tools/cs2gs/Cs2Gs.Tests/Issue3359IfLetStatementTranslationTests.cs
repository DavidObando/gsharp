// <copyright file="Issue3359IfLetStatementTranslationTests.cs" company="GSharp">
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
/// Issue #3359: <c>if (receiver is { } name) { … }</c> must not spill the
/// scrutinee.
/// <para>
/// The general pattern lowering must spill a non-trivial scrutinee into a
/// <c>let __spillN</c>, because the pattern reads it more than once (issue
/// #1731). That costs three things at once: the author's chosen binder name is
/// replaced by <c>__spillN</c>, every read becomes <c>__spillN!!</c>, and the
/// statement gains a brace level to scope the temp. Issue #3359 first answered
/// that with the canonical G# <c>if let</c> statement (ADR-0071), which binds
/// the name at its non-null type and evaluates the receiver once by
/// construction.
/// </para>
/// <para>
/// ADR-0166 / issue #3409: G# now has native pattern variables, so the same
/// C# is emitted verbatim — <c>if receiver is { } name { … }</c>, with any
/// <c>&amp;&amp;</c> guard kept in the header, <c>is not</c> lowered to
/// <c>!(… is { } name)</c>, and the variable leaking past an exiting branch.
/// The tests below assert that form. The <c>if let</c> statement remains valid
/// G# and stays the translation fallback for shapes the native path declines
/// (a <c>var</c> designation, a reassigned binder, a binder read outside a
/// region G# scopes it to); the printer keeps its code-model sample in
/// <c>Coverage/GNodeSamples.cs</c>, and the value-position form keeps its
/// goldens in <c>Adr0151IfLetExpressionTranslationTests</c>.
/// </para>
/// <para>
/// Measured at ~44 occurrences per 100k lines in dotnet/roslyn and ~186 per 100k
/// in this repository — the largest single slice of spill site <b>S1</b>
/// (issue #3347).
/// </para>
/// </summary>
public class Issue3359IfLetStatementTranslationTests
{
    private const string NodeType = @"
public sealed class Node
{
    public Node? StartTag;
    public int X;
}
";

    // ADR-0166 / issue #3409: the bare non-null pattern is emitted verbatim as
    // a native G# pattern variable.
    [Fact]
    public void BareNonNullPattern_TranslatesVerbatim_WithNoSpill()
    {
        string printed = Translate(NodeType + @"
public sealed class C
{
    public void M(Node node)
    {
        if (node.StartTag is { } startTag) { System.Console.WriteLine(startTag.X); }
    }
}");

        Assert.Contains("if node.StartTag is { } startTag {", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal);

        // The three costs the spill imposed, all gone.
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal);
        Assert.Contains("startTag.X", printed, StringComparison.Ordinal);
    }

    // ADR-0166 / issue #3409: the else branch rides on the native `if`
    // unchanged; the pattern variable is simply out of scope there.
    [Fact]
    public void WithElseBranch_TranslatesVerbatimWithElse()
    {
        string printed = Translate(NodeType + @"
public sealed class C
{
    public void M(Node node)
    {
        if (node.StartTag is { } tag) { System.Console.WriteLine(tag.X); }
        else { System.Console.WriteLine(-1); }
    }
}");

        Assert.Contains("if node.StartTag is { } tag {", printed, StringComparison.Ordinal);
        Assert.Contains("} else {", printed, StringComparison.Ordinal);
        Assert.Contains("Console.WriteLine(-1)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// ADR-0166 / issue #3409: a native pattern variable is in scope in the
    /// right operand of <c>&amp;&amp;</c>, so the conjoined guard stays in the
    /// <c>if</c> header exactly as the author wrote it. (The ADR-0071 <c>if let</c>
    /// STATEMENT grammar has no <c>&amp;&amp; guard</c> clause, which is why the
    /// earlier lowering had to nest the guard inside the then-branch.)
    /// </summary>
    [Fact]
    public void ConjoinedGuard_StaysInTheHeader()
    {
        string printed = Translate(NodeType + @"
public sealed class C
{
    public void M(Node node)
    {
        if (node.StartTag is { } tag && tag.X > 0) { System.Console.WriteLine(tag.X); }
    }
}");

        Assert.Contains("if node.StartTag is { } tag && tag.X > 0 {", printed, StringComparison.Ordinal);

        // No nested re-test of the guard, no `if let`, no spill.
        Assert.DoesNotContain("if tag.X > 0", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// ADR-0166 / issue #3409: with the guard in the header, a single
    /// <c>else</c> covers both binding failure and guard failure — the else
    /// branch is no longer duplicated into the bound path.
    /// </summary>
    [Fact]
    public void ConjoinedGuardWithElse_KeepsASingleElse()
    {
        string printed = Translate(NodeType + @"
public sealed class C
{
    public void M(Node node)
    {
        if (node.StartTag is { } tag && tag.X > 0) { System.Console.WriteLine(tag.X); }
        else { System.Console.WriteLine(-1); }
    }
}");

        Assert.Contains("if node.StartTag is { } tag && tag.X > 0 {", printed, StringComparison.Ordinal);
        Assert.Contains("} else {", printed, StringComparison.Ordinal);
        Assert.Equal(1, printed.Split("Console.WriteLine(-1)").Length - 1);
        Assert.DoesNotContain("if tag.X > 0", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A binder READ after an exiting then-branch is legal in C#. ADR-0166 /
    /// issue #3409: G# scopes the variable of <c>!(x is { } t)</c> to the
    /// statements after an <c>if</c> whose then-branch always exits, so the
    /// negated pattern lowers to <c>!(… is { } tag)</c> and the variable leaks
    /// — no hoisted nullable local, no <c>== nil</c> guard.
    /// </summary>
    [Fact]
    public void NegatedEarlyExit_LowersToBangIsAndLeaksTheVariable()
    {
        string printed = Translate(NodeType + @"
public sealed class C
{
    public void M(Node node)
    {
        if (node.StartTag is not { } tag) { return; }
        System.Console.WriteLine(tag.X);
    }
}");

        Assert.Contains("if !(node.StartTag is { } tag) {", printed, StringComparison.Ordinal);
        Assert.Contains("Console.WriteLine(tag", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("== nil", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A trivial scrutinee never spilled in the first place, but the native
    /// pattern variable is still the better rendering — it keeps the binder
    /// name instead of reusing the receiver with a `!!` at each read.
    /// </summary>
    [Fact]
    public void TrivialScrutinee_AlsoTranslatesVerbatim()
    {
        string printed = Translate(@"
#nullable enable
public sealed class C
{
    public void M(string? s)
    {
        if (s is { } text) { System.Console.WriteLine(text.Length); }
    }
}");

        // ADR-0166 / issue #3409: native pattern variable, not `if let text = s`.
        Assert.Contains("if s is { } text {", printed, StringComparison.Ordinal);
        Assert.Contains("text.Length", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A type-test pattern (<c>is T t</c>) used to keep the positive-guard `as`
    /// hoist. ADR-0166 / issue #3409: it is a native declaration pattern now,
    /// emitted verbatim with no `as` cast.
    /// </summary>
    [Fact]
    public void TypeTestPattern_TranslatesVerbatim()
    {
        string printed = Translate(@"
public sealed class C
{
    public void M(object o)
    {
        if (o is string s) { System.Console.WriteLine(s.Length); }
    }
}");

        Assert.Contains("if o is string s {", printed, StringComparison.Ordinal);
        Assert.Contains("s.Length", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("as string", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// ADR-0071 requires a NULLABLE initializer — the binding exists to strip the
    /// nullability, and a non-nullable one is GS0296 — so this shape used to take
    /// a scoped binding with the author's name. ADR-0166 / issue #3409: the
    /// native <c>{ }</c> pattern is a plain non-nil test accepted over any input
    /// type, so C#'s runtime null test on a non-nullable reference translates
    /// verbatim.
    /// </summary>
    [Fact]
    public void NonNullableScrutinee_TranslatesVerbatim()
    {
        string printed = Translate(@"
public sealed class C
{
    public int G(string s)
    {
        if (s is { } text) { return text.Length; }
        return -1;
    }
}");

        Assert.Contains("if s is { } text {", printed, StringComparison.Ordinal);
        Assert.Contains("return text.Length", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("let text = s", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("!= nil", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", "#nullable enable\nusing System;\n\nnamespace Demo\n{\n" + source + "\n}\n") });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(unit);

        RoundTripResult roundTrip = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            roundTrip.Success,
            "Translated G# must round-trip. Errors:\n" + string.Join("\n", roundTrip.Errors)
                + "\n\nPrinted:\n" + printed);

        return printed;
    }
}
