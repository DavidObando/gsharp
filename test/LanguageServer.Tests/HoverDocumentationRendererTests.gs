// <copyright file="HoverDocumentationRendererTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Documentation
import GSharp.LanguageServer
import System.Collections.Immutable
import System.Linq
import Xunit

/// Tests that the shared hover renderer turns the (cref:DocumentationComment) model
/// (ADR-0057 §4) into the Markdown sections a hover card displays.
open class HoverDocumentationRendererTests {
    @Fact
    func Null_RendersNoSections() {
        Assert.Empty(HoverDocumentationRenderer.Render(nil))
    }

    @Fact
    func Empty_RendersNoSections() {
        Assert.Empty(HoverDocumentationRenderer.Render(DocumentationComment.Empty))
    }

    @Fact
    func Summary_RendersAsLeadSectionWithoutHeading() {
        let doc = DocumentationComment.Empty with{Summary = Inline("Gets the length.")}
        let section = Assert.Single(HoverDocumentationRenderer.Render(doc))
        Assert.Null(section.Heading)
        Assert.Equal("Gets the length.", section.Body)
    }

    @Fact
    func Parameters_RenderAsBulletedList() {
        let doc = DocumentationComment.Empty with{
            Summary = Inline("Does a thing."),
            Parameters = ImmutableArray.Create(
                DocParam("count", Inline("How many.")),
                DocParam("name", Inline("The name."))
            )
        }
        let sections = HoverDocumentationRenderer.Render(doc)
        let parameters = sections.Single((s HoverDocSection) -> s.Heading == "Parameters")
        Assert.Contains("- `count` — How many.", parameters.Body)
        Assert.Contains("- `name` — The name.", parameters.Body)
    }

    @Fact
    func ReturnsAndExceptions_RenderAsSections() {
        let doc = DocumentationComment.Empty with{
            Returns = Inline("The result."),
            Exceptions = ImmutableArray.Create(DocException("T:System.ArgumentNullException", Inline("When null.")))
        }
        let sections = HoverDocumentationRenderer.Render(doc)
        Assert.Equal("The result.", sections.Single((s HoverDocSection) -> s.Heading == "Returns").Body)
        let exceptions = sections.Single((s HoverDocSection) -> s.Heading == "Exceptions").Body
        Assert.Contains("- `ArgumentNullException` — When null.", exceptions)
    }

    @Fact
    func InlineCodeAndSymbolRef_RenderAsBackticks() {
        let summary = ImmutableArray.Create[DocInline](
            DocInline.Text("Use "),
            DocInline.Code("Add"),
            DocInline.Text(" or "),
            DocInline.SymbolRef("M:System.Collections.Generic.List`1.Clear", ImmutableArray[DocInline].Empty),
            DocInline.Text(".")
        )
        let doc = DocumentationComment.Empty with{Summary = summary}
        let body = Assert.Single(HoverDocumentationRenderer.Render(doc)).Body
        Assert.Contains("`Add`", body)
        Assert.Contains("`Clear`", body)
    }

    @Fact
    func MarkdownSpecialCharactersInText_AreEscaped() {
        let doc = DocumentationComment.Empty with{Summary = Inline("a * b _ c [d]")}
        let body = Assert.Single(HoverDocumentationRenderer.Render(doc)).Body
        Assert.Contains("\\*", body)
        Assert.Contains("\\_", body)
        Assert.Contains("\\[d\\]", body)
    }

    shared {
        private func Inline(text string) ImmutableArray[DocInline] {
            return ImmutableArray.Create[DocInline](DocInline.Text(text))
        }
    }
}
