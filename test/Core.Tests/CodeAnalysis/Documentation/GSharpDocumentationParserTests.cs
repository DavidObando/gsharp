// <copyright file="GSharpDocumentationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Documentation;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Documentation;

/// <summary>
/// ADR-0057 §3: tests that the G# Markdown+KDoc authoring surface is parsed
/// into the internal <see cref="DocumentationComment"/> model.
/// </summary>
public class GSharpDocumentationParserTests
{
    [Fact]
    public void Null_ReturnsNull()
    {
        Assert.Null(GSharpDocumentationParser.Parse(null));
    }

    [Fact]
    public void WhitespaceOnly_ReturnsNull()
    {
        Assert.Null(GSharpDocumentationParser.Parse("   \n  "));
    }

    [Fact]
    public void LeadingProse_BecomesSummary()
    {
        var doc = GSharpDocumentationParser.Parse("Computes the area of a rectangle.");
        Assert.NotNull(doc);
        Assert.Equal("Computes the area of a rectangle.", PlainText(doc.Summary));
    }

    [Fact]
    public void ParamTag_CapturesNameAndContent()
    {
        var doc = GSharpDocumentationParser.Parse("Summary.\n@param x the horizontal offset");
        Assert.NotNull(doc);
        Assert.Equal("Summary.", PlainText(doc.Summary));
        var p = Assert.Single(doc.Parameters);
        Assert.Equal("x", p.Name);
        Assert.Equal("the horizontal offset", PlainText(p.Content));
    }

    [Fact]
    public void TypeparamTag_CapturesNameAndContent()
    {
        var doc = GSharpDocumentationParser.Parse("Summary.\n@typeparam T the element type");
        var tp = Assert.Single(doc.TypeParameters);
        Assert.Equal("T", tp.Name);
        Assert.Equal("the element type", PlainText(tp.Content));
    }

    [Fact]
    public void ReturnsTag_CapturesContent()
    {
        var doc = GSharpDocumentationParser.Parse("Summary.\n@returns the computed area");
        Assert.Equal("the computed area", PlainText(doc.Returns));
    }

    [Fact]
    public void ExceptionTag_CapturesCrefAndContent()
    {
        var doc = GSharpDocumentationParser.Parse("Summary.\n@exception OverflowException when too large");
        var ex = Assert.Single(doc.Exceptions);
        Assert.Equal("OverflowException", ex.Cref);
        Assert.Equal("when too large", PlainText(ex.Content));
    }

    [Fact]
    public void InlineCode_ProducesCodeInline()
    {
        var doc = GSharpDocumentationParser.Parse("Returns `Width * Height`.");
        var code = doc.Summary.OfType<DocInline.Code>().Single();
        Assert.Equal("Width * Height", code.Value);
    }

    [Fact]
    public void CrefLink_ProducesSymbolRef()
    {
        var doc = GSharpDocumentationParser.Parse("See [Rect](cref:MyNs.Rect) for details.");
        var sref = doc.Summary.OfType<DocInline.SymbolRef>().Single();
        Assert.Equal("MyNs.Rect", sref.DocId);
        Assert.Equal("Rect", PlainText(sref.Inner));
    }

    [Fact]
    public void BareCref_ProducesSymbolRefWithNoInner()
    {
        var doc = GSharpDocumentationParser.Parse("See (cref:System.String) for details.");
        var sref = doc.Summary.OfType<DocInline.SymbolRef>().Single();
        Assert.Equal("System.String", sref.DocId);
        Assert.True(sref.Inner.IsEmpty);
    }

    [Fact]
    public void HttpLink_ProducesLinkInline()
    {
        var doc = GSharpDocumentationParser.Parse("Visit [docs](https://example.com).");
        var link = doc.Summary.OfType<DocInline.Link>().Single();
        Assert.Equal("https://example.com", link.Href);
        Assert.Equal("docs", PlainText(link.Inner));
    }

    [Fact]
    public void ParamRef_ProducesParamRefInline()
    {
        var doc = GSharpDocumentationParser.Parse("Returns [`x`](paramref) squared.");
        var pref = doc.Summary.OfType<DocInline.ParamRef>().Single();
        Assert.Equal("x", pref.Name);
    }

    [Fact]
    public void FencedCodeBlock_ProducesCodeBlockInline()
    {
        var doc = GSharpDocumentationParser.Parse("Example:\n```gs\nlet x = 1\n```");
        var cb = doc.Summary.OfType<DocInline.CodeBlock>().FirstOrDefault()
              ?? doc.Summary.OfType<DocInline.Para>().SelectMany(p => p.Content).OfType<DocInline.CodeBlock>().First();
        Assert.Equal("gs", cb.Language);
        Assert.Contains("let x = 1", cb.Value);
    }

    [Fact]
    public void XmldocEscapeHatch_ProducesUnknownXmlElement()
    {
        var doc = GSharpDocumentationParser.Parse("Summary.\n```xmldoc\n<note>Important</note>\n```");
        var unknown = doc.Summary.OfType<DocInline.UnknownXmlElement>().FirstOrDefault()
                  ?? doc.Summary.OfType<DocInline.Para>().SelectMany(p => p.Content).OfType<DocInline.UnknownXmlElement>().First();
        Assert.Contains("<note>Important</note>", unknown.RawXml);
    }

    [Fact]
    public void BulletList_ProducesListInline()
    {
        var doc = GSharpDocumentationParser.Parse("Options:\n- First\n- Second");
        var list = doc.Summary.OfType<DocInline.List>().FirstOrDefault()
                ?? doc.Summary.OfType<DocInline.Para>().SelectMany(p => p.Content).OfType<DocInline.List>().First();
        Assert.Equal("bullet", list.ListType);
        Assert.Equal(2, list.Items.Length);
    }

    [Fact]
    public void OrderedList_ProducesNumberList()
    {
        var doc = GSharpDocumentationParser.Parse("Steps:\n1. Alpha\n2. Beta");
        var list = doc.Summary.OfType<DocInline.List>().FirstOrDefault()
                ?? doc.Summary.OfType<DocInline.Para>().SelectMany(p => p.Content).OfType<DocInline.List>().First();
        Assert.Equal("number", list.ListType);
        Assert.Equal(2, list.Items.Length);
    }

    [Fact]
    public void RemarksTag_CapturesContent()
    {
        var doc = GSharpDocumentationParser.Parse("Summary.\n@remarks This is a remark.");
        Assert.Equal("This is a remark.", PlainText(doc.Remarks));
    }

    [Fact]
    public void MultipleParams_AllCaptured()
    {
        var doc = GSharpDocumentationParser.Parse("Summary.\n@param x the x\n@param y the y");
        Assert.Equal(2, doc.Parameters.Length);
        Assert.Equal("x", doc.Parameters[0].Name);
        Assert.Equal("y", doc.Parameters[1].Name);
    }

    private static string PlainText(ImmutableArray<DocInline> content)
    {
        return string.Concat(content.OfType<DocInline.Text>().Select(t => t.Value)).Trim();
    }
}
