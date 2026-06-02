// <copyright file="XmlDocumentationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using System.Xml.Linq;
using GSharp.Core.CodeAnalysis.Documentation;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Documentation;

/// <summary>
/// ADR-0057 §6: tests that the XML-doc vocabulary is parsed into the internal
/// <see cref="DocumentationComment"/> model with full fidelity.
/// </summary>
public class XmlDocumentationParserTests
{
    [Fact]
    public void NullMember_ReturnsEmpty()
    {
        Assert.Same(DocumentationComment.Empty, XmlDocumentationParser.ParseMember(null));
    }

    [Fact]
    public void Summary_TextIsNormalizedAndTrimmed()
    {
        var member = Member("<summary>\n            Gets the length.\n        </summary>");
        var doc = XmlDocumentationParser.ParseMember(member);
        Assert.Equal("Gets the length.", PlainText(doc.Summary));
    }

    [Fact]
    public void Params_TypeParams_Returns_AreCaptured()
    {
        var member = Member(
            "<summary>Creates a list.</summary>" +
            "<typeparam name=\"T\">The element type.</typeparam>" +
            "<param name=\"capacity\">The initial capacity.</param>" +
            "<returns>A new list.</returns>");
        var doc = XmlDocumentationParser.ParseMember(member);

        Assert.Equal("Creates a list.", PlainText(doc.Summary));
        Assert.Equal("T", doc.TypeParameters.Single().Name);
        Assert.Equal("The element type.", PlainText(doc.TypeParameters.Single().Content));
        Assert.Equal("capacity", doc.Parameters.Single().Name);
        Assert.Equal("The initial capacity.", PlainText(doc.Parameters.Single().Content));
        Assert.Equal("A new list.", PlainText(doc.Returns));
    }

    [Fact]
    public void Exception_CapturesCrefAndContent()
    {
        var member = Member("<exception cref=\"T:System.ArgumentNullException\">When null.</exception>");
        var doc = XmlDocumentationParser.ParseMember(member);
        var exception = Assert.Single(doc.Exceptions);
        Assert.Equal("T:System.ArgumentNullException", exception.Cref);
        Assert.Equal("When null.", PlainText(exception.Content));
    }

    [Fact]
    public void InlineCode_And_SeeCref_AreModelled()
    {
        var member = Member("<summary>Use <c>Add</c> then <see cref=\"M:N.C.Clear\"/>.</summary>");
        var doc = XmlDocumentationParser.ParseMember(member);

        var code = doc.Summary.OfType<DocInline.Code>().Single();
        Assert.Equal("Add", code.Value);

        var reference = doc.Summary.OfType<DocInline.SymbolRef>().Single();
        Assert.Equal("M:N.C.Clear", reference.DocId);
    }

    [Fact]
    public void ParamRef_And_Langword_AreModelled()
    {
        var member = Member("<summary>Returns <paramref name=\"x\"/> or <see langword=\"null\"/>.</summary>");
        var doc = XmlDocumentationParser.ParseMember(member);

        Assert.Equal("x", doc.Summary.OfType<DocInline.ParamRef>().Single().Name);
        Assert.Contains(doc.Summary.OfType<DocInline.Code>(), c => c.Value == "null");
    }

    [Fact]
    public void List_ItemsBecomeListModel()
    {
        var member = Member(
            "<summary><list type=\"bullet\">" +
            "<item><term>One</term><description>First.</description></item>" +
            "<item><description>Second.</description></item>" +
            "</list></summary>");
        var doc = XmlDocumentationParser.ParseMember(member);

        var list = doc.Summary.OfType<DocInline.List>().Single();
        Assert.Equal("bullet", list.ListType);
        Assert.Equal(2, list.Items.Length);
        Assert.Equal("One", PlainText(list.Items[0].Term));
        Assert.Equal("First.", PlainText(list.Items[0].Description));
        Assert.Equal("Second.", PlainText(list.Items[1].Description));
    }

    [Fact]
    public void UnknownInlineElement_IsPreservedVerbatim()
    {
        var member = Member("<summary>See <bogus a=\"1\">x</bogus>.</summary>");
        var doc = XmlDocumentationParser.ParseMember(member);
        var unknown = doc.Summary.OfType<DocInline.UnknownXmlElement>().Single();
        Assert.Contains("<bogus", unknown.RawXml);
        Assert.Contains("x</bogus>", unknown.RawXml);
    }

    [Fact]
    public void UnknownTopLevelElement_IsPreservedUnderRemarks()
    {
        var member = Member("<summary>S.</summary><example>Sample.</example>");
        var doc = XmlDocumentationParser.ParseMember(member);
        var unknown = doc.Remarks.OfType<DocInline.UnknownXmlElement>().Single();
        Assert.Contains("<example>", unknown.RawXml);
    }

    [Fact]
    public void CodeBlock_PreservesLanguageAndText()
    {
        var member = Member("<summary><code language=\"csharp\">var x = 1;</code></summary>");
        var doc = XmlDocumentationParser.ParseMember(member);
        var codeBlock = doc.Summary.OfType<DocInline.CodeBlock>().Single();
        Assert.Equal("csharp", codeBlock.Language);
        Assert.Contains("var x = 1;", codeBlock.Value);
    }

    [Fact]
    public void InterElementSpacing_IsPreservedAroundInlineElements()
    {
        var member = Member("<summary>Returns the <see cref=\"T:System.String\"/> value of <c>x</c> now.</summary>");
        var doc = XmlDocumentationParser.ParseMember(member);
        var texts = doc.Summary.OfType<DocInline.Text>().Select(t => t.Value).ToArray();

        Assert.Equal("Returns the ", texts[0]);
        Assert.Equal(" value of ", texts[1]);
        Assert.Equal(" now.", texts[2]);
    }

    [Fact]
    public void Langword_KeepsSurroundingSpaces()
    {
        var member = Member("<summary>Returns <see langword=\"true\"/> if equal.</summary>");
        var doc = XmlDocumentationParser.ParseMember(member);
        var texts = doc.Summary.OfType<DocInline.Text>().Select(t => t.Value).ToArray();

        Assert.Equal("Returns ", texts[0]);
        Assert.Equal(" if equal.", texts[1]);
    }

    private static XElement Member(string innerXml)
    {
        return XElement.Parse($"<member name=\"T:Test\">{innerXml}</member>");
    }

    private static string PlainText(ImmutableArray<DocInline> content)
    {
        return string.Concat(content.OfType<DocInline.Text>().Select(t => t.Value)).Trim();
    }
}
