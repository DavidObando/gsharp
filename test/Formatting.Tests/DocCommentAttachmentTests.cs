// <copyright file="DocCommentAttachmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Formatting.Tests;

/// <summary>
/// ADR-0179 phase 7b regression suite: formatted output must still COMPILE.
/// <para>
/// The defect that produced this file is the reason it does not test
/// idempotence. `gsfmt` split the accessibility modifier off `init` — emitting
/// `private`, a blank line, then `init(...)` — which detaches the preceding
/// `///` block from the declaration it documents and makes gsc report GS0227
/// "documentation comment is not attached to a declaration". That output was a
/// perfectly STABLE fixed point: `gsfmt --check` over all 3,905 files of the
/// migrated tree was clean, and every `Cs2Gs.Tests` assertion still passed.
/// It just did not compile, and six of the eight PR-guard apps failed on it.
/// </para>
/// <para>
/// The lesson, and the contract of this file: a formatter invariant that only
/// says "formatting twice changes nothing" cannot see a fixed point that is the
/// WRONG one. These tests therefore bind and emit the formatted text and assert
/// on the diagnostics, which is the property the gate actually depends on.
/// </para>
/// </summary>
public sealed class DocCommentAttachmentTests
{
    /// <summary>The diagnostic a detached <c>///</c> block produces.</summary>
    private const string FloatingDocumentationComment = "GS0227";

    /// <summary>
    /// Gets one documented member per declaration keyword that can carry an
    /// accessibility modifier. Each shape needs a PRECEDING member in the same
    /// type: the break the formatter inserts is a member boundary, so a lone
    /// documented declaration never reproduced the defect.
    /// </summary>
    public static TheoryData<string, string, string> DocumentedMembers()
    {
        var data = new TheoryData<string, string, string>();
        foreach ((string Name, string Source, string Keyword) shape in Shapes())
        {
            data.Add(shape.Name, shape.Source, shape.Keyword);
        }

        return data;
    }

    /// <summary>
    /// Formatting a documented member must not detach its <c>///</c> block:
    /// the formatted text has to bind and emit without GS0227.
    /// </summary>
    /// <param name="name">The shape's name, for test output.</param>
    /// <param name="source">The source to format and then compile.</param>
    /// <param name="keyword">The declaration keyword; unused here, see the sibling test.</param>
    [Theory]
    [MemberData(nameof(DocumentedMembers))]
    public void FormattedDocumentedMember_CompilesWithoutFloatingDocComment(
        string name,
        string source,
        string keyword)
    {
        _ = keyword;
        FormatResult result = GSharpFormatter.Format(SourceText.From(source, name + ".gs"));
        Assert.Empty(result.Diagnostics);
        string formatted = result.Text!.ToString();

        ImmutableArray<Diagnostic> diagnostics = CompileDiagnostics(formatted, name);

        Assert.DoesNotContain(
            diagnostics,
            diagnostic => diagnostic.Id == FloatingDocumentationComment);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    /// <summary>
    /// The structural half of the same property, asserted directly so a failure
    /// names the cause rather than only the symptom: the line right after the
    /// <c>///</c> block must carry the declaration keyword. Asserting on the
    /// KEYWORD rather than merely on "the next line is not blank" is what makes
    /// this catch the real defect — the split emitted `private` on that line and
    /// pushed `init` past a blank line, so a non-blank check passes on output
    /// that does not compile.
    /// </summary>
    /// <param name="name">The shape's name, for test output.</param>
    /// <param name="source">The source to format.</param>
    /// <param name="keyword">The declaration keyword that must stay on the documented line.</param>
    [Theory]
    [MemberData(nameof(DocumentedMembers))]
    public void FormattedDocumentedMember_KeepsDeclarationOnTheDocumentedLine(
        string name,
        string source,
        string keyword)
    {
        FormatResult result = GSharpFormatter.Format(SourceText.From(source, name + ".gs"));
        Assert.Empty(result.Diagnostics);
        string[] lines = result.Text!.ToString().Split('\n');

        var documented = 0;
        for (var i = 0; i < lines.Length - 1; i++)
        {
            if (!lines[i].TrimStart().StartsWith("///", StringComparison.Ordinal))
            {
                continue;
            }

            documented++;
            Assert.True(
                lines[i + 1].Contains(keyword, StringComparison.Ordinal),
                $"'{name}': the line after the doc comment is '{lines[i + 1]}', which does not carry "
                + $"'{keyword}' — the declaration has been split away from the comment that "
                + $"documents it.\n{result.Text}");
        }

        Assert.Equal(1, documented);
    }

    /// <summary>
    /// Binds and emits <paramref name="formatted"/> and returns every
    /// diagnostic the compiler produced. Emission goes to a
    /// <see cref="MemoryStream"/> rather than to disk, and it is the emit path
    /// specifically because <c>DocumentationValidator</c> — the only thing that
    /// reports GS0227 — runs there and nowhere else.
    /// </summary>
    private static ImmutableArray<Diagnostic> CompileDiagnostics(string formatted, string name)
    {
        SyntaxTree tree = SyntaxTree.Parse(SourceText.From(formatted, name + ".gs"));
        var compilation = new Compilation(tree);
        using var pe = new MemoryStream();
        return compilation.Emit(pe, pdbStream: null, refStream: null, docStream: null).Diagnostics;
    }

    /// <summary>
    /// The shapes. `init` is the one that regressed, and every accessibility
    /// modifier regressed with it, so all three are covered rather than one;
    /// the rest are the sibling declaration keywords, probed here so that the
    /// next node whose <c>Span</c> forgets its own modifiers is caught by this
    /// file rather than by the nightly gate.
    /// </summary>
    private static IEnumerable<(string Name, string Source, string Keyword)> Shapes()
    {
        yield return Shape("private init", Member("private init(a string, b int32) { }"), "init");
        yield return Shape("internal init", Member("internal init(a string, b int32) { }"), "init");
        yield return Shape("public init", Member("public init(a string, b int32) { }"), "init");
        yield return Shape(
            "private convenience init",
            Member("private convenience init(a string, b int32) { init(a) }"),
            "convenience init");
        yield return Shape("private func", Member("private func Helper() int32 -> 1"), "func");
        yield return Shape("private prop", Member("private prop Value int32 -> 1"), "prop");
        yield return Shape("private var", Member("private var field int32 = 0"), "var");
        yield return Shape("private let", Member("private let bound int32 = 0"), "let");
        yield return Shape("private class", Member("private class Nested { }"), "class");
        yield return Shape("private struct", Member("private struct NestedStruct { }"), "struct");
        yield return Shape("private interface", Member("private interface INested { }"), "interface");
        yield return Shape("private enum", Member("private enum NestedEnum { A }"), "enum");
        yield return Shape("deinit", Member("deinit { }"), "deinit");
    }

    /// <summary>
    /// Wraps one documented member in a type that already has a member before
    /// it, which is what makes the member boundary the formatter breaks at
    /// exist at all.
    /// </summary>
    private static string Member(string declaration) =>
        "package P\n"
        + "\n"
        + "class T {\n"
        + "    init(seed string) { }\n"
        + "\n"
        + "    /// Documents the member below.\n"
        + "    " + declaration + "\n"
        + "}\n";

    private static (string Name, string Source, string Keyword) Shape(
        string name,
        string source,
        string keyword) => (name, source, keyword);
}
