// <copyright file="HoverDocumentationRenderer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Documentation
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Text

/// Renders the structured (cref:DocumentationComment) model (ADR-0057 §4) into the
/// Markdown sections a hover card displays. Shared by ingested (C# → G#) and, later,
/// authored (G#) documentation so both surfaces render identically.
internal shared class HoverDocumentationRenderer {
    /// Renders a documentation comment into ordered hover sections, or an empty list when
    /// the comment is null/empty.
    /// @param documentation The documentation to render.
    /// @returns The ordered sections (heading + Markdown body).
    func Render(documentation DocumentationComment?) IReadOnlyList[HoverDocSection] {
        if documentation == nil {
            return Array.Empty[HoverDocSection]()
        }
        let sections = List[HoverDocSection]()
        AddProse(sections, heading: nil, documentation.Summary)
        AddNamed(sections, "Type parameters", documentation.TypeParameters)
        AddNamed(sections, "Parameters", documentation.Parameters)
        AddProse(sections, "Returns", documentation.Returns)
        AddProse(sections, "Value", documentation.Value)
        AddExceptions(sections, documentation.Exceptions)
        AddProse(sections, "Remarks", documentation.Remarks)
        return sections
    }

    private func AddProse(sections List[HoverDocSection], heading string?, content ImmutableArray[DocInline]) {
        let body = RenderInline(content).Trim()
        if body.Length > 0 {
            sections.Add(HoverDocSection(heading, body))
        }
    }

    private func AddNamed(sections List[HoverDocSection], heading string, entries ImmutableArray[DocParam]) {
        if entries.IsDefaultOrEmpty {
            return
        }
        let builder = StringBuilder()
        for entry in entries {
            let description = RenderInline(entry.Content).Trim()
            builder.Append("- `").Append(entry.Name).Append('`')
            if description.Length > 0 {
                builder.Append(" — ").Append(description)
            }
            builder.Append('\n')
        }
        sections.Add(HoverDocSection(heading, builder.ToString().TrimEnd()))
    }

    private func AddExceptions(sections List[HoverDocSection], exceptions ImmutableArray[DocException]) {
        if exceptions.IsDefaultOrEmpty {
            return
        }
        let builder = StringBuilder()
        for exception in exceptions {
            let description = RenderInline(exception.Content).Trim()
            builder.Append("- `").Append(SimpleCrefName(exception.Cref)).Append('`')
            if description.Length > 0 {
                builder.Append(" — ").Append(description)
            }
            builder.Append('\n')
        }
        sections.Add(HoverDocSection("Exceptions", builder.ToString().TrimEnd()))
    }

    private func RenderInline(content ImmutableArray[DocInline]) string {
        if content.IsDefaultOrEmpty {
            return string.Empty
        }
        let builder = StringBuilder()
        for node in content {
            RenderNode(builder, node)
        }
        return builder.ToString()
    }

    private func RenderNode(builder StringBuilder, node DocInline) {
        switch node {
            case text is DocInline.Text {
                builder.Append(Escape(text.Value))
            }
            case code is DocInline.Code {
                builder.Append('`').Append(code.Value).Append('`')
            }
            case codeBlock is DocInline.CodeBlock {
                builder
                    .Append("\n\n```")
                    .Append(codeBlock.Language ?? string.Empty)
                    .Append('\n')
                    .Append(codeBlock.Value.Trim('\n'))
                    .Append("\n```\n\n")
            }
            case para is DocInline.Para {
                builder.Append(`

`).Append(RenderInline(para.Content).Trim()).Append(`

`)
            }
            case list is DocInline.List {
                RenderList(builder, list)
            }
            case symbolRef is DocInline.SymbolRef {
                let refText = RenderInline(symbolRef.Inner).Trim()
                builder
                    .Append('`')
                    .Append(
                    if refText.Length > 0 {
                        refText
                    } else {
                        SimpleCrefName(symbolRef.DocId)
                    }
                )
                    .Append('`')
            }
            case link is DocInline.Link {
                let linkText = RenderInline(link.Inner).Trim()
                builder
                    .Append('[')
                    .Append(
                    if linkText.Length > 0 {
                        linkText
                    } else {
                        link.Href
                    }
                )
                    .Append("](")
                    .Append(link.Href)
                    .Append(')')
            }
            case paramRef is DocInline.ParamRef {
                builder.Append('`').Append(paramRef.Name).Append('`')
            }
            case unknown is DocInline.UnknownXmlElement {
                builder.Append(Escape(StripTags(unknown.RawXml)))
            }
        }
    }

    private func RenderList(builder StringBuilder, list DocInline.List) {
        builder.Append('\n')
        let ordered = list.ListType == "number"
        var i = 1
        for item in list.Items {
            let term = RenderInline(item.Term).Trim()
            let description = RenderInline(item.Description).Trim()
            builder.Append('\n').Append(
                if ordered {
                    "$i. "
                } else {
                    "- "
                }
            )
            if term.Length > 0 {
                builder.Append("**").Append(term).Append("**")
                if description.Length > 0 {
                    builder.Append(" — ")
                }
            }
            builder.Append(description)
            i++
        }
        builder.Append('\n')
    }

    // The cref carries a "T:"/"M:"/... prefix and a fully-qualified name; hover shows the
    // trailing simple name (and method/parameter tail) for readability.
    private func SimpleCrefName(cref string?) string {
        if string.IsNullOrEmpty(cref) {
            return string.Empty
        }
        let name = if cref.Length > 2 && cref[1] == ':' {
            cref.Substring(2)
        } else {
            cref
        }
        let parenIndex = name.IndexOf('(')
        let head = if parenIndex >= 0 {
            name.Substring(0, parenIndex)
        } else {
            name
        }
        let lastDot = head.LastIndexOf('.')
        return if lastDot >= 0 {
            name.Substring(lastDot + 1)
        } else {
            name
        }
    }

    private func StripTags(rawXml string) string {
        let builder = StringBuilder(rawXml.Length)
        var inside = false
        for ch in rawXml {
            if ch == '<' {
                inside = true
            } else if ch == '>' {
                inside = false
            } else if !inside {
                builder.Append(ch)
            }
        }
        return builder.ToString()
    }

    private func Escape(value string) string {
        let builder = StringBuilder(value.Length)
        for ch in value {
            if ch == '\\' || ch == '`' || ch == '*' || ch == '_' || ch == '[' || ch == ']' || ch == '<' {
                builder.Append('\\')
            }
            builder.Append(ch)
        }
        return builder.ToString()
    }
}
