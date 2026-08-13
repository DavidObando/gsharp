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
/// Issue #3359: <c>if (receiver is { } name) { … }</c> translates to the
/// canonical G# <c>if let</c> statement (ADR-0071) rather than spilling the
/// scrutinee.
/// <para>
/// The general pattern lowering must spill a non-trivial scrutinee into a
/// <c>let __spillN</c>, because the pattern reads it more than once (issue
/// #1731). That costs three things at once: the author's chosen binder name is
/// replaced by <c>__spillN</c>, every read becomes <c>__spillN!!</c>, and the
/// statement gains a brace level to scope the temp. <c>if let</c> binds the name
/// at its non-null type and evaluates the receiver once by construction.
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

    [Fact]
    public void BareNonNullPattern_EmitsIfLet_WithNoSpill()
    {
        string printed = Translate(NodeType + @"
public sealed class C
{
    public void M(Node node)
    {
        if (node.StartTag is { } startTag) { System.Console.WriteLine(startTag.X); }
    }
}");

        Assert.Contains("if let startTag = node.StartTag", printed, StringComparison.Ordinal);

        // The three costs the spill imposed, all gone.
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal);
        Assert.Contains("startTag.X", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void WithElseBranch_EmitsIfLetElse()
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

        Assert.Contains("if let tag = node.StartTag", printed, StringComparison.Ordinal);
        Assert.Contains("else", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The ADR-0071 STATEMENT grammar has no <c>&amp;&amp; guard</c> clause — only
    /// ADR-0151's value-position form takes one, and `gsc` swallows a trailing
    /// <c>&amp;&amp; …</c> into the binding's initializer. The guard is therefore
    /// nested inside the then-branch, where it can read the bound name.
    /// </summary>
    [Fact]
    public void ConjoinedGuard_IsNestedInsideTheBinding()
    {
        string printed = Translate(NodeType + @"
public sealed class C
{
    public void M(Node node)
    {
        if (node.StartTag is { } tag && tag.X > 0) { System.Console.WriteLine(tag.X); }
    }
}");

        Assert.Contains("if let tag = node.StartTag", printed, StringComparison.Ordinal);
        Assert.Contains("if tag.X > 0", printed, StringComparison.Ordinal);

        // The invalid form: a guard trailing the binding in the header.
        Assert.DoesNotContain("if let tag = node.StartTag &&", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A conjoined guard with an else duplicates the else branch into the bound
    /// path so both binding failure and guard failure retain C# semantics.
    /// </summary>
    [Fact]
    public void ConjoinedGuardWithElse_UsesNestedGuard()
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

        Assert.Contains("if let tag =", printed, StringComparison.Ordinal);
        Assert.Contains("if tag.X > 0", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// An else branch that READS the binder is legal in C# when the then-branch
    /// exits, but a G# <c>if let</c> binds only for the then-branch. The
    /// negated-guard hoist handles that shape and must keep doing so.
    /// </summary>
    [Fact]
    public void NegatedEarlyExit_KeepsTheNegatedGuardHoist()
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

        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal);
        Assert.Contains("if tag == nil", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A trivial scrutinee never spilled in the first place, but `if let` is
    /// still the better rendering — it keeps the binder name instead of reusing
    /// the receiver with a `!!` at each read.
    /// </summary>
    [Fact]
    public void TrivialScrutinee_AlsoUsesIfLet()
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

        Assert.Contains("if let text = s", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A type-test pattern (<c>is T t</c>) is a different shape and keeps the
    /// positive-guard `as` hoist, which already avoids a spill.
    /// </summary>
    [Fact]
    public void TypeTestPattern_KeepsTheAsHoist()
    {
        string printed = Translate(@"
public sealed class C
{
    public void M(object o)
    {
        if (o is string s) { System.Console.WriteLine(s.Length); }
    }
}");

        Assert.Contains("as string", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// ADR-0071 requires a NULLABLE initializer — the binding exists to strip the
    /// nullability, and a non-nullable one is GS0296. C# still treats
    /// <c>s is { }</c> on a non-nullable reference as a runtime null test, so
    /// that shape uses a scoped binding with the author's name instead.
    /// </summary>
    [Fact]
    public void NonNullableScrutinee_UsesScopedAuthorBinding()
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

        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal);
        Assert.Contains("let text = s", printed, StringComparison.Ordinal);
        Assert.Contains("text != nil", printed, StringComparison.Ordinal);
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
