// <copyright file="XmlDocumentationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Documentation

import System.Collections.Immutable
import System.Linq
import System.Xml.Linq
import GSharp.Core.CodeAnalysis.Documentation
import Xunit

/// ADR-0057 §6: tests that the XML-doc vocabulary is parsed into the internal
/// (cref:DocumentationComment) model with full fidelity.
open class XmlDocumentationParserTests {
    @Fact
    func NullMember_ReturnsEmpty() {
        Assert.Same(DocumentationComment.Empty, XmlDocumentationParser.ParseMember(nil))
    }

    @Fact
    func Summary_TextIsNormalizedAndTrimmed() {
        let member = Member(`<summary>
            Gets the length.
        </summary>`)
        let doc = XmlDocumentationParser.ParseMember(member)
        Assert.Equal("Gets the length.", PlainText(doc.Summary))
    }

    @Fact
    func Params_TypeParams_Returns_AreCaptured() {
        let member = Member(
            "<summary>Creates a list.</summary>" +
                "<typeparam name=\"T\">The element type.</typeparam>" +
                "<param name=\"capacity\">The initial capacity.</param>" +
                "<returns>A new list.</returns>"
        )
        let doc = XmlDocumentationParser.ParseMember(member)
        Assert.Equal("Creates a list.", PlainText(doc.Summary))
        Assert.Equal("T", doc.TypeParameters.Single().Name)
        Assert.Equal("The element type.", PlainText(doc.TypeParameters.Single().Content))
        Assert.Equal("capacity", doc.Parameters.Single().Name)
        Assert.Equal("The initial capacity.", PlainText(doc.Parameters.Single().Content))
        Assert.Equal("A new list.", PlainText(doc.Returns))
    }

    @Fact
    func Exception_CapturesCrefAndContent() {
        let member = Member("<exception cref=\"T:System.ArgumentNullException\">When null.</exception>")
        let doc = XmlDocumentationParser.ParseMember(member)
        let exception = Assert.Single(doc.Exceptions)
        Assert.Equal("T:System.ArgumentNullException", exception.Cref)
        Assert.Equal("When null.", PlainText(exception.Content))
    }

    @Fact
    func InlineCode_And_SeeCref_AreModelled() {
        let member = Member("<summary>Use <c>Add</c> then <see cref=\"M:N.C.Clear\"/>.</summary>")
        let doc = XmlDocumentationParser.ParseMember(member)
        let code = doc.Summary.OfType[DocInline.Code]().Single()
        Assert.Equal("Add", code.Value)
        let reference = doc.Summary.OfType[DocInline.SymbolRef]().Single()
        Assert.Equal("M:N.C.Clear", reference.DocId)
    }

    @Fact
    func ParamRef_And_Langword_AreModelled() {
        let member = Member("<summary>Returns <paramref name=\"x\"/> or <see langword=\"null\"/>.</summary>")
        let doc = XmlDocumentationParser.ParseMember(member)
        Assert.Equal("x", doc.Summary.OfType[DocInline.ParamRef]().Single().Name)
        Assert.Contains(doc.Summary.OfType[DocInline.Code](), (c DocInline.Code) -> c.Value == "null")
    }

    @Fact
    func List_ItemsBecomeListModel() {
        let member = Member(
            "<summary><list type=\"bullet\">" +
                "<item><term>One</term><description>First.</description></item>" +
                "<item><description>Second.</description></item>" +
                "</list></summary>"
        )
        let doc = XmlDocumentationParser.ParseMember(member)
        let list = doc.Summary.OfType[DocInline.List]().Single()
        Assert.Equal("bullet", list.ListType)
        Assert.Equal(2, list.Items.Length)
        Assert.Equal("One", PlainText(list.Items[0].Term))
        Assert.Equal("First.", PlainText(list.Items[0].Description))
        Assert.Equal("Second.", PlainText(list.Items[1].Description))
    }

    @Fact
    func UnknownInlineElement_IsPreservedVerbatim() {
        let member = Member("<summary>See <bogus a=\"1\">x</bogus>.</summary>")
        let doc = XmlDocumentationParser.ParseMember(member)
        let unknown = doc.Summary.OfType[DocInline.UnknownXmlElement]().Single()
        Assert.Contains("<bogus", unknown.RawXml)
        Assert.Contains("x</bogus>", unknown.RawXml)
    }

    @Fact
    func UnknownTopLevelElement_IsPreservedUnderRemarks() {
        let member = Member("<summary>S.</summary><example>Sample.</example>")
        let doc = XmlDocumentationParser.ParseMember(member)
        let unknown = doc.Remarks.OfType[DocInline.UnknownXmlElement]().Single()
        Assert.Contains("<example>", unknown.RawXml)
    }

    @Fact
    func InheritDoc_IsModelled() {
        let member = Member("<inheritdoc cref=\"M:Base.Foo\"/>")
        let doc = XmlDocumentationParser.ParseMember(member)
        let inheritDoc = doc.Remarks.OfType[DocInline.InheritDoc]().Single()
        Assert.Equal("M:Base.Foo", inheritDoc.Cref)
    }

    @Fact
    func CodeBlock_PreservesLanguageAndText() {
        let member = Member("<summary><code language=\"csharp\">var x = 1;</code></summary>")
        let doc = XmlDocumentationParser.ParseMember(member)
        let codeBlock = doc.Summary.OfType[DocInline.CodeBlock]().Single()
        Assert.Equal("csharp", codeBlock.Language)
        Assert.Contains("var x = 1;", codeBlock.Value)
    }

    @Fact
    func InterElementSpacing_IsPreservedAroundInlineElements() {
        let member = Member("<summary>Returns the <see cref=\"T:System.String\"/> value of <c>x</c> now.</summary>")
        let doc = XmlDocumentationParser.ParseMember(member)
        let texts = doc.Summary.OfType[DocInline.Text]().Select((t DocInline.Text) -> t.Value).ToArray()
        Assert.Equal("Returns the ", texts[0])
        Assert.Equal(" value of ", texts[1])
        Assert.Equal(" now.", texts[2])
    }

    @Fact
    func Langword_KeepsSurroundingSpaces() {
        let member = Member("<summary>Returns <see langword=\"true\"/> if equal.</summary>")
        let doc = XmlDocumentationParser.ParseMember(member)
        let texts = doc.Summary.OfType[DocInline.Text]().Select((t DocInline.Text) -> t.Value).ToArray()
        Assert.Equal("Returns ", texts[0])
        Assert.Equal(" if equal.", texts[1])
    }

    shared {
        private func Member(innerXml string) XElement {
            return XElement.Parse("<member name=\"T:Test\">$innerXml</member>")
        }

        private func PlainText(content ImmutableArray[DocInline]) string {
            return string.Concat(content.OfType[DocInline.Text]().Select((t DocInline.Text) -> t.Value)).Trim()
        }
    }
}
