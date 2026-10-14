// <copyright file="XmlDocumentationParser.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Documentation

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Xml.Linq
import System.Text

/// Parses a standard XML-doc `<member>` fragment (as found in a companion
/// `.xml` documentation file) into the internal (cref:DocumentationComment)
/// model (ADR-0057 §6 ingestion). The full XML-doc vocabulary is rendered; any element
/// with no first-class model case is preserved verbatim as
/// (cref:DocInline.UnknownXmlElement) rather than dropped, so ingested docs keep
/// full fidelity.
shared class XmlDocumentationParser {
    /// Parses the children of a `<member>` element into a documentation comment.
    /// @param member The `<member>` element, or any element whose children are doc sections.
    /// @returns The parsed documentation comment, or (cref:DocumentationComment.Empty) when
    /// [`member`](paramref) is null.
    func ParseMember(member XElement?) DocumentationComment {
        if member == nil {
            return DocumentationComment.Empty
        }
        var summary = ImmutableArray[DocInline].Empty
        var returns = ImmutableArray[DocInline].Empty
        var value = ImmutableArray[DocInline].Empty
        let parameters = ImmutableArray.CreateBuilder[DocParam]()
        let typeParameters = ImmutableArray.CreateBuilder[DocParam]()
        let exceptions = ImmutableArray.CreateBuilder[DocException]()
        let seeAlso = ImmutableArray.CreateBuilder[DocReference]()
        let remarks = ImmutableArray.CreateBuilder[DocInline]()
        for element in member.Elements() {
            switch element.Name.LocalName {
                case "summary" {
                    summary = ParseInline(element)
                }
                case "returns" {
                    returns = ParseInline(element)
                }
                case "value" {
                    value = ParseInline(element)
                }
                case "remarks" {
                    AppendInto(remarks, ParseInline(element))
                }
                case "inheritdoc" {
                    remarks.Add(DocInline.InheritDoc(CrefAttribute(element)))
                }
                case "param" {
                    parameters.Add(DocParam(NameAttribute(element), ParseInline(element)))
                }
                case "typeparam" {
                    typeParameters.Add(DocParam(NameAttribute(element), ParseInline(element)))
                }
                case "exception" {
                    exceptions.Add(DocException(CrefAttribute(element), ParseInline(element)))
                }
                case "seealso" {
                    seeAlso.Add(ParseReference(element))
                }
                default {
                    remarks.Add(DocInline.UnknownXmlElement(element.ToString(SaveOptions.DisableFormatting)))
                }
            }
        }
        return DocumentationComment(
            summary,
            parameters.ToImmutable(),
            typeParameters.ToImmutable(),
            returns,
            remarks.ToImmutable(),
            value,
            exceptions.ToImmutable(),
            seeAlso.ToImmutable()
        )
    }

    /// Parses the mixed content of an element into ordered inline nodes, trimming the
    /// surrounding whitespace introduced by the source file's `///` indentation.
    /// @param container The element whose content to parse.
    /// @returns The ordered inline content.
    func ParseInline(container XElement?) ImmutableArray[DocInline] {
        if container == nil {
            return ImmutableArray[DocInline].Empty
        }
        let builder = ImmutableArray.CreateBuilder[DocInline]()
        for node in container.Nodes() {
            switch node {
                case text is XText {
                    let normalized = NormalizeWhitespace(text.Value)
                    if normalized.Length > 0 {
                        builder.Add(DocInline.Text(normalized))
                    }
                }
                case element is XElement {
                    builder.Add(ParseInlineElement(element))
                }
            }
        }
        return TrimEdges(builder)
    }

    private func ParseInlineElement(element XElement) DocInline {
        switch element.Name.LocalName {
            case "c" {
                return DocInline.Code(element.Value)
            }
            case "code" {
                return DocInline.CodeBlock(string?(element.Attribute(XName?("language")!!)), element.Value)
            }
            case "para" {
                return DocInline.Para(ParseInline(element))
            }
            case "list" {
                return ParseList(element)
            }
            case "paramref", "typeparamref" {
                return DocInline.ParamRef(NameAttribute(element))
            }
            case "inheritdoc" {
                return DocInline.InheritDoc(CrefAttribute(element))
            }
            case "see" {
                return ParseSee(element)
            }
            default {
                return DocInline.UnknownXmlElement(element.ToString(SaveOptions.DisableFormatting))
            }
        }
    }

    private func ParseSee(element XElement) DocInline {
        let cref string? = CrefAttribute(element)
        if cref != nil {
            return DocInline.SymbolRef(cref, ParseInline(element))
        }
        let href string? = string?(element.Attribute(XName?("href")!!))
        if href != nil {
            return DocInline.Link(href, ParseInline(element))
        }
        // <see langword="null"/> renders as inline code, like its IDE presentation.
        let langword string? = string?(element.Attribute(XName?("langword")!!))
        if langword != nil {
            return DocInline.Code(langword)
        }
        return DocInline.UnknownXmlElement(element.ToString(SaveOptions.DisableFormatting))
    }

    private func ParseList(element XElement) DocInline {
        let listType = string?(element.Attribute(XName?("type")!!))
        let items = ImmutableArray.CreateBuilder[DocListItem]()
        // <listheader> describes the columns; model it as the first item's term/description.
        for item in element.Elements() {
            if item.Name.LocalName is not("item" or "listheader") {
                continue
            }
            var term XElement? = nil
            var description XElement? = nil
            for child in item.Elements() {
                if child.Name.LocalName == "term" {
                    term ??= child
                } else if child.Name.LocalName == "description" {
                    description ??= child
                }
            }
            if term == nil && description == nil {
                // <item>text</item> shorthand: the whole item is the description.
                items.Add(DocListItem(ImmutableArray[DocInline].Empty, ParseInline(item)))
                continue
            }
            items.Add(
                DocListItem(
                    if term == nil {
                        ImmutableArray[DocInline].Empty
                    } else {
                        ParseInline(term)
                    },
                    if description == nil {
                        ImmutableArray[DocInline].Empty
                    } else {
                        ParseInline(description)
                    }
                )
            )
        }
        return DocInline.List(listType, items.ToImmutable())
    }

    private func ParseReference(element XElement) DocReference {
        return DocReference(CrefAttribute(element), string?(element.Attribute(XName?("href")!!)), ParseInline(element))
    }

    private func AppendInto(builder ImmutableArray[DocInline].Builder, items ImmutableArray[DocInline]) {
        for item in items {
            builder.Add(item)
        }
    }

    private func NameAttribute(element XElement) string {
        return string?(element.Attribute(XName?("name")!!)) ?? string.Empty
    }

    private func CrefAttribute(element XElement) string? {
        return string?(element.Attribute(XName?("cref")!!))
    }

    // Collapse the runs of whitespace (including the newlines and leading indentation
    // that the `///` prefix leaves in the xml) into single spaces. A leading/trailing
    // space is preserved (collapsed to one) so the spacing between adjacent text and
    // inline elements survives; TrimEdges removes the spaces at the true block edges.
    // Code blocks bypass this and keep their original text via element.Value.
    private func NormalizeWhitespace(value string) string {
        if string.IsNullOrEmpty(value) {
            return string.Empty
        }
        let builder = StringBuilder(value.Length)
        var inWhitespace = false
        let leadingWhitespace = char.IsWhiteSpace(value[0])
        for ch in value {
            if char.IsWhiteSpace(ch) {
                inWhitespace = true
                continue
            }
            if inWhitespace && (builder.Length > 0 || leadingWhitespace) {
                builder.Append(' ')
            }
            inWhitespace = false
            builder.Append(ch)
        }
        if inWhitespace {
            builder.Append(' ')
        }
        return builder.ToString()
    }

    private func TrimEdges(builder ImmutableArray[DocInline].Builder) ImmutableArray[DocInline] {
        while builder.Count > 0 && (builder[0] is DocInline.Text and {Value: " "}) {
            builder.RemoveAt(0)
        }
        while builder.Count > 0 && (builder[builder.Count - 1] is DocInline.Text and {Value: " "}) {
            builder.RemoveAt(builder.Count - 1)
        }
        if builder.Count > 0 && builder[0] is DocInline.Text first {
            builder[0] = DocInline.Text(first.Value.TrimStart())
        }
        if builder.Count > 0 && builder[builder.Count - 1] is DocInline.Text last {
            builder[builder.Count - 1] = DocInline.Text(last.Value.TrimEnd())
        }
        return builder.ToImmutable()
    }
}
