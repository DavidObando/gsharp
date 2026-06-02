// <copyright file="HoverDocumentationRendererTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Documentation;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Tests that the shared hover renderer turns the <see cref="DocumentationComment"/> model
/// (ADR-0057 §4) into the Markdown sections a hover card displays.
/// </summary>
public class HoverDocumentationRendererTests
{
    [Fact]
    public void Null_RendersNoSections()
    {
        Assert.Empty(HoverDocumentationRenderer.Render(null));
    }

    [Fact]
    public void Empty_RendersNoSections()
    {
        Assert.Empty(HoverDocumentationRenderer.Render(DocumentationComment.Empty));
    }

    [Fact]
    public void Summary_RendersAsLeadSectionWithoutHeading()
    {
        var doc = DocumentationComment.Empty with { Summary = Inline("Gets the length.") };
        var section = Assert.Single(HoverDocumentationRenderer.Render(doc));
        Assert.Null(section.Heading);
        Assert.Equal("Gets the length.", section.Body);
    }

    [Fact]
    public void Parameters_RenderAsBulletedList()
    {
        var doc = DocumentationComment.Empty with
        {
            Summary = Inline("Does a thing."),
            Parameters = ImmutableArray.Create(
                new DocParam("count", Inline("How many.")),
                new DocParam("name", Inline("The name."))),
        };

        var sections = HoverDocumentationRenderer.Render(doc);
        var parameters = sections.Single(s => s.Heading == "Parameters");
        Assert.Contains("- `count` — How many.", parameters.Body);
        Assert.Contains("- `name` — The name.", parameters.Body);
    }

    [Fact]
    public void ReturnsAndExceptions_RenderAsSections()
    {
        var doc = DocumentationComment.Empty with
        {
            Returns = Inline("The result."),
            Exceptions = ImmutableArray.Create(
                new DocException("T:System.ArgumentNullException", Inline("When null."))),
        };

        var sections = HoverDocumentationRenderer.Render(doc);
        Assert.Equal("The result.", sections.Single(s => s.Heading == "Returns").Body);
        var exceptions = sections.Single(s => s.Heading == "Exceptions").Body;
        Assert.Contains("- `ArgumentNullException` — When null.", exceptions);
    }

    [Fact]
    public void InlineCodeAndSymbolRef_RenderAsBackticks()
    {
        var summary = ImmutableArray.Create<DocInline>(
            new DocInline.Text("Use "),
            new DocInline.Code("Add"),
            new DocInline.Text(" or "),
            new DocInline.SymbolRef("M:System.Collections.Generic.List`1.Clear", ImmutableArray<DocInline>.Empty),
            new DocInline.Text("."));
        var doc = DocumentationComment.Empty with { Summary = summary };

        var body = Assert.Single(HoverDocumentationRenderer.Render(doc)).Body;
        Assert.Contains("`Add`", body);
        Assert.Contains("`Clear`", body);
    }

    [Fact]
    public void MarkdownSpecialCharactersInText_AreEscaped()
    {
        var doc = DocumentationComment.Empty with { Summary = Inline("a * b _ c [d]") };
        var body = Assert.Single(HoverDocumentationRenderer.Render(doc)).Body;
        Assert.Contains("\\*", body);
        Assert.Contains("\\_", body);
        Assert.Contains("\\[d\\]", body);
    }

    private static ImmutableArray<DocInline> Inline(string text)
    {
        return ImmutableArray.Create<DocInline>(new DocInline.Text(text));
    }
}
