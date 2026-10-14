// <copyright file="GSharpDocumentationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Documentation

import GSharp.Core.CodeAnalysis.Documentation
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0057 §3: tests that the G# Markdown+KDoc authoring surface is parsed
/// into the internal (cref:DocumentationComment) model.
open class GSharpDocumentationParserTests {
    @Fact
    func Null_ReturnsNull() {
        Assert.Null(GSharpDocumentationParser.Parse(nil))
    }

    @Fact
    func WhitespaceOnly_ReturnsNull() {
        Assert.Null(GSharpDocumentationParser.Parse("   \n  "))
    }

    @Fact
    func LeadingProse_BecomesSummary() {
        let doc DocumentationComment? = GSharpDocumentationParser.Parse("Computes the area of a rectangle.")
        Assert.NotNull(doc)
        Assert.Equal("Computes the area of a rectangle.", PlainText(doc!!.Summary))
    }

    @Fact
    func ParamTag_CapturesNameAndContent() {
        let doc DocumentationComment? = GSharpDocumentationParser.Parse("Summary.\n@param x the horizontal offset")
        Assert.NotNull(doc)
        Assert.Equal("Summary.", PlainText(doc!!.Summary))
        let p = Assert.Single(doc!!.Parameters)
        Assert.Equal("x", p.Name)
        Assert.Equal("the horizontal offset", PlainText(p.Content))
    }

    @Fact
    func TypeparamTag_CapturesNameAndContent() {
        let doc DocumentationComment? = GSharpDocumentationParser.Parse("Summary.\n@typeparam T the element type")
        let tp = Assert.Single(doc!!.TypeParameters)
        Assert.Equal("T", tp.Name)
        Assert.Equal("the element type", PlainText(tp.Content))
    }

    @Fact
    func ReturnsTag_CapturesContent() {
        let doc DocumentationComment? = GSharpDocumentationParser.Parse("Summary.\n@returns the computed area")
        Assert.Equal("the computed area", PlainText(doc!!.Returns))
    }

    @Fact
    func ExceptionTag_CapturesCrefAndContent() {
        let doc DocumentationComment? = GSharpDocumentationParser.Parse(
            "Summary.\n@exception OverflowException when too large"
        )
        let ex = Assert.Single(doc!!.Exceptions)
        Assert.Equal("OverflowException", ex.Cref)
        Assert.Equal("when too large", PlainText(ex.Content))
    }

    @Fact
    func InlineCode_ProducesCodeInline() {
        let doc DocumentationComment? = GSharpDocumentationParser.Parse("Returns `Width * Height`.")
        let code = doc!!.Summary.OfType[DocInline.Code]().Single()
        Assert.Equal("Width * Height", code.Value)
    }

    @Fact
    func CrefLink_ProducesSymbolRef() {
        let doc DocumentationComment? = GSharpDocumentationParser.Parse("See [Rect](cref:MyNs.Rect) for details.")
        let sref = doc!!.Summary.OfType[DocInline.SymbolRef]().Single()
        Assert.Equal("MyNs.Rect", sref.DocId)
        Assert.Equal("Rect", PlainText(sref.Inner))
    }

    @Fact
    func BareCref_ProducesSymbolRefWithNoInner() {
        let doc DocumentationComment? = GSharpDocumentationParser.Parse("See (cref:System.String) for details.")
        let sref = doc!!.Summary.OfType[DocInline.SymbolRef]().Single()
        Assert.Equal("System.String", sref.DocId)
        Assert.True(sref.Inner.IsEmpty)
    }

    @Fact
    func HttpLink_ProducesLinkInline() {
        let doc DocumentationComment? = GSharpDocumentationParser.Parse("Visit [docs](https://example.com).")
        let link = doc!!.Summary.OfType[DocInline.Link]().Single()
        Assert.Equal("https://example.com", link.Href)
        Assert.Equal("docs", PlainText(link.Inner))
    }

    @Fact
    func ParamRef_ProducesParamRefInline() {
        let doc DocumentationComment? = GSharpDocumentationParser.Parse("Returns [`x`](paramref) squared.")
        let pref = doc!!.Summary.OfType[DocInline.ParamRef]().Single()
        Assert.Equal("x", pref.Name)
    }

    @Fact
    func FencedCodeBlock_ProducesCodeBlockInline() {
        let doc DocumentationComment? = GSharpDocumentationParser.Parse((`Example:
` + "```" + `gs
let x = 1
` + "```"))
        let cb = doc!!
            .Summary
            .OfType[DocInline.CodeBlock]()
            .FirstOrDefault() ??
            doc!!
            .Summary
            .OfType[DocInline.Para]()
            .SelectMany(
            func (p DocInline.Para) IEnumerable[DocInline] {
                return p.Content
            }
        )
            .OfType[DocInline.CodeBlock]()
            .First()
        Assert.Equal("gs", cb.Language)
        Assert.Contains("let x = 1", cb.Value)
    }

    @Fact
    func XmldocEscapeHatch_ProducesUnknownXmlElement() {
        let doc DocumentationComment? = GSharpDocumentationParser.Parse((`Summary.
` + "```" + `xmldoc
<note>Important</note>
` + "```"))
        let unknown = doc!!
            .Summary
            .OfType[DocInline.UnknownXmlElement]()
            .FirstOrDefault() ??
            doc!!
            .Summary
            .OfType[DocInline.Para]()
            .SelectMany(
            func (p DocInline.Para) IEnumerable[DocInline] {
                return p.Content
            }
        )
            .OfType[DocInline.UnknownXmlElement]()
            .First()
        Assert.Contains("<note>Important</note>", unknown.RawXml)
    }

    @Fact
    func BulletList_ProducesListInline() {
        let doc DocumentationComment? = GSharpDocumentationParser.Parse(`Options:
- First
- Second`)
        let list = doc!!
            .Summary
            .OfType[DocInline.List]()
            .FirstOrDefault() ??
            doc!!
            .Summary
            .OfType[DocInline.Para]()
            .SelectMany(
            func (p DocInline.Para) IEnumerable[DocInline] {
                return p.Content
            }
        )
            .OfType[DocInline.List]()
            .First()
        Assert.Equal("bullet", list.ListType)
        Assert.Equal(2, list.Items.Length)
    }

    @Fact
    func OrderedList_ProducesNumberList() {
        let doc DocumentationComment? = GSharpDocumentationParser.Parse(`Steps:
1. Alpha
2. Beta`)
        let list = doc!!
            .Summary
            .OfType[DocInline.List]()
            .FirstOrDefault() ??
            doc!!
            .Summary
            .OfType[DocInline.Para]()
            .SelectMany(
            func (p DocInline.Para) IEnumerable[DocInline] {
                return p.Content
            }
        )
            .OfType[DocInline.List]()
            .First()
        Assert.Equal("number", list.ListType)
        Assert.Equal(2, list.Items.Length)
    }

    @Fact
    func RemarksTag_CapturesContent() {
        let doc DocumentationComment? = GSharpDocumentationParser.Parse("Summary.\n@remarks This is a remark.")
        Assert.Equal("This is a remark.", PlainText(doc!!.Remarks))
    }

    @Fact
    func MultipleParams_AllCaptured() {
        let doc DocumentationComment? = GSharpDocumentationParser.Parse(`Summary.
@param x the x
@param y the y`)
        Assert.Equal(2, doc!!.Parameters.Length)
        Assert.Equal("x", doc!!.Parameters[0].Name)
        Assert.Equal("y", doc!!.Parameters[1].Name)
    }

    shared {
        private func PlainText(content ImmutableArray[DocInline]) string {
            return string.Concat(content.OfType[DocInline.Text]().Select((t DocInline.Text) -> t.Value)).Trim()
        }
    }
}
