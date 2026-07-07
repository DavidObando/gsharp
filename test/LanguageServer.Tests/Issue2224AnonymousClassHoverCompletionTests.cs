// <copyright file="Issue2224AnonymousClassHoverCompletionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.LanguageServer;
using GSharp.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Issue #2224: hover and completion for the new <c>object { let ... }</c>
/// anonymous-class-literal expression. gsc synthesizes a real
/// <c>StructSymbol</c> per distinct member shape, so hovering a variable bound
/// to a literal, or a member access off it, and completing members after a
/// dot all reuse the existing struct hover/completion machinery
/// (<see cref="HoverComputer"/>, <see cref="CompletionComputer"/>)
/// unmodified — this is what these tests verify.
/// </summary>
public class Issue2224AnonymousClassHoverCompletionTests
{
    [Fact]
    public void ComputeHover_OnAnonymousClassVariable_ShowsSynthesizedShape()
    {
        const string source = "func main() {\n"
            + "    var x = object { let Name string = \"Foo\", let Age int32 = 42 }\n"
            + "}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "x"));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("Name", value, System.StringComparison.Ordinal);
        Assert.Contains("string", value, System.StringComparison.Ordinal);
        Assert.Contains("Age", value, System.StringComparison.Ordinal);
        Assert.Contains("int32", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_OnAnonymousClassMemberAccess_ResolvesMemberType()
    {
        const string source = "func main() {\n"
            + "    var x = object { let Name string = \"Foo\", let Age int32 = 42 }\n"
            + "    var n = x.Name\n"
            + "}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Name", occurrence: 1));

        Assert.NotNull(hover);
        Assert.Contains("string", hover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeCompletions_AfterDotOnAnonymousClassValue_OffersMembers()
    {
        const string source = "func main() {\n"
            + "    var x = object { let Name string = \"Foo\", let Age int32 = 42 }\n"
            + "    x.\n"
            + "}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var caret = After(source, "    x.");
        var items = CompletionComputer.ComputeCompletions(content, caret);

        Assert.Contains(items, i => i.Label == "Name" && i.Kind == CompletionItemKind.Field);
        Assert.Contains(items, i => i.Label == "Age" && i.Kind == CompletionItemKind.Field);
    }

    [Fact]
    public void ComputeCompletions_AfterDotOnAnonymousClassValue_DoesNotOfferGlobalKeywords()
    {
        const string source = "func main() {\n"
            + "    var x = object { let Name string = \"Foo\", let Age int32 = 42 }\n"
            + "    x.\n"
            + "}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var caret = After(source, "    x.");
        var items = CompletionComputer.ComputeCompletions(content, caret);

        Assert.DoesNotContain(items, i => i.Kind == CompletionItemKind.Keyword);
    }

    private static Position After(string source, string marker)
    {
        var start = LanguageServerTestHelpers.PositionOf(source, marker);
        return new Position(start.Line, start.Character + marker.Length);
    }
}
