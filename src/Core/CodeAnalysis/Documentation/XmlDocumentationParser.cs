// <copyright file="XmlDocumentationParser.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Xml.Linq;

namespace GSharp.Core.CodeAnalysis.Documentation;

/// <summary>
/// Parses a standard XML-doc <c>&lt;member&gt;</c> fragment (as found in a companion
/// <c>.xml</c> documentation file) into the internal <see cref="DocumentationComment"/>
/// model (ADR-0057 §6 ingestion). The full XML-doc vocabulary is rendered; any element
/// with no first-class model case is preserved verbatim as
/// <see cref="DocInline.UnknownXmlElement"/> rather than dropped, so ingested docs keep
/// full fidelity.
/// </summary>
public static class XmlDocumentationParser
{
    /// <summary>
    /// Parses the children of a <c>&lt;member&gt;</c> element into a documentation comment.
    /// </summary>
    /// <param name="member">The <c>&lt;member&gt;</c> element, or any element whose children are doc sections.</param>
    /// <returns>The parsed documentation comment, or <see cref="DocumentationComment.Empty"/> when <paramref name="member"/> is null.</returns>
    public static DocumentationComment ParseMember(XElement member)
    {
        if (member is null)
        {
            return DocumentationComment.Empty;
        }

        var summary = ImmutableArray<DocInline>.Empty;
        var returns = ImmutableArray<DocInline>.Empty;
        var value = ImmutableArray<DocInline>.Empty;
        var parameters = ImmutableArray.CreateBuilder<DocParam>();
        var typeParameters = ImmutableArray.CreateBuilder<DocParam>();
        var exceptions = ImmutableArray.CreateBuilder<DocException>();
        var seeAlso = ImmutableArray.CreateBuilder<DocReference>();
        var remarks = ImmutableArray.CreateBuilder<DocInline>();

        foreach (var element in member.Elements())
        {
            switch (element.Name.LocalName)
            {
                case "summary":
                    summary = ParseInline(element);
                    break;
                case "returns":
                    returns = ParseInline(element);
                    break;
                case "value":
                    value = ParseInline(element);
                    break;
                case "remarks":
                    AppendInto(remarks, ParseInline(element));
                    break;
                case "inheritdoc":
                    remarks.Add(new DocInline.InheritDoc(CrefAttribute(element)));
                    break;
                case "param":
                    parameters.Add(new DocParam(NameAttribute(element), ParseInline(element)));
                    break;
                case "typeparam":
                    typeParameters.Add(new DocParam(NameAttribute(element), ParseInline(element)));
                    break;
                case "exception":
                    exceptions.Add(new DocException(CrefAttribute(element), ParseInline(element)));
                    break;
                case "seealso":
                    seeAlso.Add(ParseReference(element));
                    break;

                // Elements with no first-class section (e.g. <example>) are preserved
                // verbatim under remarks so they still render and are never dropped.
                default:
                    remarks.Add(new DocInline.UnknownXmlElement(element.ToString(SaveOptions.DisableFormatting)));
                    break;
            }
        }

        return new DocumentationComment(
            summary,
            parameters.ToImmutable(),
            typeParameters.ToImmutable(),
            returns,
            remarks.ToImmutable(),
            value,
            exceptions.ToImmutable(),
            seeAlso.ToImmutable());
    }

    /// <summary>
    /// Parses the mixed content of an element into ordered inline nodes, trimming the
    /// surrounding whitespace introduced by the source file's <c>///</c> indentation.
    /// </summary>
    /// <param name="container">The element whose content to parse.</param>
    /// <returns>The ordered inline content.</returns>
    public static ImmutableArray<DocInline> ParseInline(XElement container)
    {
        if (container is null)
        {
            return ImmutableArray<DocInline>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<DocInline>();
        foreach (var node in container.Nodes())
        {
            switch (node)
            {
                case XText text:
                    var normalized = NormalizeWhitespace(text.Value);
                    if (normalized.Length > 0)
                    {
                        builder.Add(new DocInline.Text(normalized));
                    }

                    break;
                case XElement element:
                    builder.Add(ParseInlineElement(element));
                    break;
            }
        }

        return TrimEdges(builder);
    }

    private static DocInline ParseInlineElement(XElement element)
    {
        switch (element.Name.LocalName)
        {
            case "c":
                return new DocInline.Code(element.Value);
            case "code":
                return new DocInline.CodeBlock(
                    (string)element.Attribute("language"),
                    element.Value);
            case "para":
                return new DocInline.Para(ParseInline(element));
            case "list":
                return ParseList(element);
            case "paramref":
            case "typeparamref":
                return new DocInline.ParamRef(NameAttribute(element));
            case "inheritdoc":
                return new DocInline.InheritDoc(CrefAttribute(element));
            case "see":
                return ParseSee(element);
            default:
                return new DocInline.UnknownXmlElement(element.ToString(SaveOptions.DisableFormatting));
        }
    }

    private static DocInline ParseSee(XElement element)
    {
        var cref = CrefAttribute(element);
        if (cref != null)
        {
            return new DocInline.SymbolRef(cref, ParseInline(element));
        }

        var href = (string)element.Attribute("href");
        if (href != null)
        {
            return new DocInline.Link(href, ParseInline(element));
        }

        // <see langword="null"/> renders as inline code, like its IDE presentation.
        var langword = (string)element.Attribute("langword");
        if (langword != null)
        {
            return new DocInline.Code(langword);
        }

        return new DocInline.UnknownXmlElement(element.ToString(SaveOptions.DisableFormatting));
    }

    private static DocInline ParseList(XElement element)
    {
        var listType = (string)element.Attribute("type");
        var items = ImmutableArray.CreateBuilder<DocListItem>();

        // <listheader> describes the columns; model it as the first item's term/description.
        foreach (var item in element.Elements().Where(e => e.Name.LocalName is "item" or "listheader"))
        {
            var term = item.Elements().FirstOrDefault(e => e.Name.LocalName == "term");
            var description = item.Elements().FirstOrDefault(e => e.Name.LocalName == "description");

            if (term == null && description == null)
            {
                // <item>text</item> shorthand: the whole item is the description.
                items.Add(new DocListItem(ImmutableArray<DocInline>.Empty, ParseInline(item)));
                continue;
            }

            items.Add(new DocListItem(
                term == null ? ImmutableArray<DocInline>.Empty : ParseInline(term),
                description == null ? ImmutableArray<DocInline>.Empty : ParseInline(description)));
        }

        return new DocInline.List(listType, items.ToImmutable());
    }

    private static DocReference ParseReference(XElement element)
    {
        return new DocReference(
            CrefAttribute(element),
            (string)element.Attribute("href"),
            ParseInline(element));
    }

    private static void AppendInto(ImmutableArray<DocInline>.Builder builder, ImmutableArray<DocInline> items)
    {
        foreach (var item in items)
        {
            builder.Add(item);
        }
    }

    private static string NameAttribute(XElement element)
    {
        return (string)element.Attribute("name") ?? string.Empty;
    }

    private static string CrefAttribute(XElement element)
    {
        return (string)element.Attribute("cref");
    }

    // Collapse the runs of whitespace (including the newlines and leading indentation
    // that the `///` prefix leaves in the xml) into single spaces. A leading/trailing
    // space is preserved (collapsed to one) so the spacing between adjacent text and
    // inline elements survives; TrimEdges removes the spaces at the true block edges.
    // Code blocks bypass this and keep their original text via element.Value.
    private static string NormalizeWhitespace(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        var builder = new System.Text.StringBuilder(value.Length);
        var inWhitespace = false;
        var leadingWhitespace = char.IsWhiteSpace(value[0]);
        foreach (var ch in value)
        {
            if (char.IsWhiteSpace(ch))
            {
                inWhitespace = true;
                continue;
            }

            if (inWhitespace && (builder.Length > 0 || leadingWhitespace))
            {
                builder.Append(' ');
            }

            inWhitespace = false;
            builder.Append(ch);
        }

        if (inWhitespace)
        {
            builder.Append(' ');
        }

        return builder.ToString();
    }

    private static ImmutableArray<DocInline> TrimEdges(ImmutableArray<DocInline>.Builder builder)
    {
        while (builder.Count > 0 && builder[0] is DocInline.Text { Value: " " })
        {
            builder.RemoveAt(0);
        }

        while (builder.Count > 0 && builder[builder.Count - 1] is DocInline.Text { Value: " " })
        {
            builder.RemoveAt(builder.Count - 1);
        }

        if (builder.Count > 0 && builder[0] is DocInline.Text first)
        {
            builder[0] = new DocInline.Text(first.Value.TrimStart());
        }

        if (builder.Count > 0 && builder[builder.Count - 1] is DocInline.Text last)
        {
            builder[builder.Count - 1] = new DocInline.Text(last.Value.TrimEnd());
        }

        return builder.ToImmutable();
    }
}
