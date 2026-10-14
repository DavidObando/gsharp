// <copyright file="GSharpDocumentationParser.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Documentation

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Text
import System.Xml.Linq

/// Parses a G# documentation block (Markdown + KDoc-style block tags + xmldoc escape hatch)
/// into the internal (cref:DocumentationComment) model (ADR-0057 §3).
internal shared class GSharpDocumentationParser {
    private struct Section {
        init(tag string?, body string) {
            Tag = tag
            Body = body
        }

        prop Tag string? {
            get;
        }

        prop Body string {
            get;
        }
    }

    /// Parses the raw joined documentation block text into a (cref:DocumentationComment).
    /// Returns `null` when the input is null or whitespace-only.
    /// @param blockText The joined lines from the doc block (newline-separated).
    /// @returns The parsed documentation model, or `null`.
    internal func Parse(blockText string) DocumentationComment? {
        if string.IsNullOrWhiteSpace(blockText) {
            return nil
        }
        let lines = blockText.Split('\n')
        let sections = SplitIntoSections(lines)
        var summary = ImmutableArray[DocInline].Empty
        let parameters = ImmutableArray.CreateBuilder[DocParam]()
        let typeParameters = ImmutableArray.CreateBuilder[DocParam]()
        var returns = ImmutableArray[DocInline].Empty
        var remarks = ImmutableArray[DocInline].Empty
        var value = ImmutableArray[DocInline].Empty
        let exceptions = ImmutableArray.CreateBuilder[DocException]()
        let seeAlso = ImmutableArray.CreateBuilder[DocReference]()
        for section in sections {
            switch section.Tag {
                case nil {
                    // Leading prose = summary.
                    summary = ParseInlineContent(section.Body)
                }
                case "@param" {
                    if TryExtractName(section.Body, out var paramName, out var paramContent) {
                        parameters.Add(DocParam(paramName, ParseInlineContent(paramContent)))
                    }
                }
                case "@typeparam" {
                    if TryExtractName(section.Body, out var typeParamName, out var typeParamContent) {
                        typeParameters.Add(DocParam(typeParamName, ParseInlineContent(typeParamContent)))
                    }
                }
                case "@returns" {
                    returns = ParseInlineContent(section.Body)
                }
                case "@remarks" {
                    remarks = ParseInlineContent(section.Body)
                }
                case "@value" {
                    value = ParseInlineContent(section.Body)
                }
                case "@exception" {
                    if TryExtractName(section.Body, out var exCref, out var exContent) {
                        exceptions.Add(DocException(exCref, ParseInlineContent(exContent)))
                    }
                }
                case "@seealso" {
                    if TryExtractName(section.Body, out var saCref, out var saContent) {
                        let inlines = ParseInlineContent(saContent)
                        if saCref.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || saCref.StartsWith(
                            "https://",
                            StringComparison.OrdinalIgnoreCase
                        ) {
                            seeAlso.Add(DocReference(nil, saCref, inlines))
                        } else {
                            seeAlso.Add(DocReference(saCref, nil, inlines))
                        }
                    }
                }
            }
        }
        return DocumentationComment(
            summary,
            parameters.ToImmutable(),
            typeParameters.ToImmutable(),
            returns,
            remarks,
            value,
            exceptions.ToImmutable(),
            seeAlso.ToImmutable()
        )
    }

    private func SplitIntoSections(lines[]string) List[Section] {
        let sections = List[Section]()
        var currentTag string? = nil
        let currentBody = StringBuilder()
        for line in lines {
            let trimmed = line.TrimStart()
            if trimmed.StartsWith("@param ", StringComparison.Ordinal) || trimmed.StartsWith(
                "@typeparam ",
                StringComparison.Ordinal
            ) ||
                trimmed.StartsWith("@returns", StringComparison.Ordinal) || trimmed.StartsWith(
                "@remarks",
                StringComparison.Ordinal
            ) ||
                trimmed.StartsWith("@value", StringComparison.Ordinal) || trimmed.StartsWith(
                "@exception ",
                StringComparison.Ordinal
            ) ||
                trimmed
                .StartsWith("@seealso ", StringComparison.Ordinal) {
                // Flush previous section.
                if currentBody.Length > 0 || currentTag != nil {
                    sections.Add(Section(currentTag, currentBody.ToString()))
                    currentBody.Clear()
                }
                // Extract tag and the rest of the line.
                let spaceIdx = trimmed.IndexOf(' ')
                if spaceIdx < 0 {
                    currentTag = trimmed
                } else {
                    currentTag = trimmed.Substring(0, spaceIdx)
                    currentBody.Append(trimmed.Substring(spaceIdx + 1))
                }
            } else {
                if currentBody.Length > 0 {
                    currentBody.Append('\n')
                }
                currentBody.Append(line)
            }
        }
        if currentBody.Length > 0 || currentTag != nil {
            sections.Add(Section(currentTag, currentBody.ToString()))
        }
        return sections
    }

    private func TryExtractName(body string, @NotNullWhen(true) out name string?, out remainder string) bool {
        name = nil
        remainder = string.Empty
        if string.IsNullOrWhiteSpace(body) {
            return false
        }
        let trimmed = body.TrimStart()
        let spaceIdx = trimmed.IndexOf(' ')
        if spaceIdx < 0 {
            name = trimmed
            remainder = string.Empty
        } else {
            name = trimmed.Substring(0, spaceIdx)
            remainder = trimmed.Substring(spaceIdx + 1)
        }
        return !string.IsNullOrEmpty(name)
    }

    private func ParseInlineContent(text string) ImmutableArray[DocInline] {
        if string.IsNullOrWhiteSpace(text) {
            return ImmutableArray[DocInline].Empty
        }
        let result = ImmutableArray.CreateBuilder[DocInline]()
        let lines = text.Split('\n')
        var i = 0
        while i < lines.Length {
            // Fenced code block detection.
            if lines[i].TrimStart().StartsWith("```", StringComparison.Ordinal) {
                let fenceLine = lines[i].TrimStart()
                let lang = if fenceLine.Length > 3 {
                    fenceLine.Substring(3).Trim()
                } else {
                    string.Empty
                }
                if string.Equals(lang, "xmldoc", StringComparison.OrdinalIgnoreCase) {
                    // XML escape hatch: collect raw XML until closing ```.
                    i++
                    let xmlBuilder = StringBuilder()
                    while i < lines.Length && !lines[i].TrimStart().StartsWith("```", StringComparison.Ordinal) {
                        if xmlBuilder.Length > 0 {
                            xmlBuilder.Append('\n')
                        }
                        xmlBuilder.Append(lines[i])
                        i++
                    }
                    if i < lines.Length {
                        i++ // skip closing ```

                    }
                    let rawXml = xmlBuilder.ToString().Trim()
                    if !string.IsNullOrEmpty(rawXml) {
                        result.Add(DocInline.UnknownXmlElement(rawXml))
                    }
                } else {
                    // Regular fenced code block.
                    i++
                    let codeBuilder = StringBuilder()
                    while i < lines.Length && !lines[i].TrimStart().StartsWith("```", StringComparison.Ordinal) {
                        if codeBuilder.Length > 0 {
                            codeBuilder.Append('\n')
                        }
                        codeBuilder.Append(lines[i])
                        i++
                    }
                    if i < lines.Length {
                        i++ // skip closing ```

                    }
                    result.Add(DocInline.CodeBlock(lang, codeBuilder.ToString()))
                }
                continue
            }
            // Check for list items (bullet or ordered).
            if IsListItem(lines[i]) {
                let (listType, items) = ParseList(lines, &i)
                result.Add(DocInline.List(listType, items))
                continue
            }
            // Paragraph: collect lines until blank line or special structure.
            let paraBuilder = StringBuilder()
            while i < lines.Length && !string.IsNullOrWhiteSpace(lines[i]) && !lines[i].TrimStart().StartsWith(
                "```",
                StringComparison.Ordinal
            ) &&
                !IsListItem(lines[i]) {
                if paraBuilder.Length > 0 {
                    paraBuilder.Append(' ')
                }
                paraBuilder.Append(lines[i].TrimEnd())
                i++
            }
            if paraBuilder.Length > 0 {
                let paraInlines = ParseInlineRuns(paraBuilder.ToString())
                if result.Count > 0 {
                    // Wrap in Para if it's not the first block.
                    result.Add(DocInline.Para(paraInlines))
                } else {
                    result.AddRange(paraInlines)
                }
            }
            // Skip blank lines between paragraphs.
            while i < lines.Length && string.IsNullOrWhiteSpace(lines[i]) {
                i++
            }
        }
        return result.ToImmutable()
    }

    private func IsListItem(line string) bool {
        let trimmed = line.TrimStart()
        if trimmed.StartsWith("- ", StringComparison.Ordinal) || trimmed.StartsWith("* ", StringComparison.Ordinal) {
            return true
        }
        // Ordered list: digit(s) followed by '. '
        for var j = 0; j < trimmed.Length; j++ {
            if char.IsDigit(trimmed[j]) {
                continue
            }
            if trimmed[j] == '.' && j > 0 && j + 1 < trimmed.Length && trimmed[j + 1] == ' ' {
                return true
            }
            break
        }
        return false
    }

    private func ParseList(lines[]string, ref i int32)(ListType string, Items ImmutableArray[DocListItem]) {
        let items = ImmutableArray.CreateBuilder[DocListItem]()
        let first = lines[i].TrimStart()
        let isOrdered = char.IsDigit(first[0])
        let listType = if isOrdered {
            "number"
        } else {
            "bullet"
        }
        while i < lines.Length && IsListItem(lines[i]) {
            let trimmed = lines[i].TrimStart()
            var itemText string
            if isOrdered {
                let dotIdx = trimmed.IndexOf(". ", StringComparison.Ordinal)
                itemText = if dotIdx >= 0 {
                    trimmed.Substring(dotIdx + 2)
                } else {
                    trimmed
                }
            } else {
                itemText = trimmed.Substring(2) // skip "- " or "* "

            }
            let inlines = ParseInlineRuns(itemText)
            items.Add(DocListItem(ImmutableArray[DocInline].Empty, inlines))
            i++
        }
        return (listType, items.ToImmutable())
    }

    private func ParseInlineRuns(text string) ImmutableArray[DocInline] {
        let result = ImmutableArray.CreateBuilder[DocInline]()
        var pos = 0
        let textBuilder = StringBuilder()
        while pos < text.Length {
            // Inline code: `code`
            if text[pos] == '`' {
                FlushText(result, textBuilder)
                pos++
                var codeEnd = text.IndexOf('`', pos)
                if codeEnd < 0 {
                    codeEnd = text.Length
                }
                result.Add(DocInline.Code(text.Substring(pos, codeEnd - pos)))
                pos = if codeEnd < text.Length {
                    codeEnd + 1
                } else {
                    codeEnd
                }
                continue
            }
            // Link/ref forms: [text](target) or [`name`](paramref)
            if text[pos] == '[' {
                let closeBracket = FindClosingBracket(text, pos)
                if closeBracket > pos && closeBracket + 1 < text.Length && text[closeBracket + 1] == '(' {
                    let closeParen = text.IndexOf(')', closeBracket + 2)
                    if closeParen > closeBracket + 1 {
                        let linkText = text.Substring(pos + 1, closeBracket - pos - 1)
                        let target = text.Substring(closeBracket + 2, closeParen - closeBracket - 2)
                        FlushText(result, textBuilder)
                        if string.Equals(target, "paramref", StringComparison.Ordinal) {
                            // [`name`](paramref) → ParamRef
                            let name = linkText.Trim('`')
                            result.Add(DocInline.ParamRef(name))
                        } else if target.StartsWith("cref:", StringComparison.Ordinal) {
                            // [text](cref:Target) → SymbolRef
                            let crefTarget = target.Substring(5)
                            let inner = if string.IsNullOrEmpty(linkText) {
                                ImmutableArray[DocInline].Empty
                            } else {
                                ImmutableArray.Create[DocInline](DocInline.Text(linkText))
                            }
                            result.Add(DocInline.SymbolRef(crefTarget, inner))
                        } else if target.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || target.StartsWith(
                            "https://",
                            StringComparison.OrdinalIgnoreCase
                        ) {
                            // [text](https://…) → Link
                            let inner = if string.IsNullOrEmpty(linkText) {
                                ImmutableArray[DocInline].Empty
                            } else {
                                ImmutableArray.Create[DocInline](DocInline.Text(linkText))
                            }
                            result.Add(DocInline.Link(target, inner))
                        } else {
                            // Unknown link form — treat as text.
                            textBuilder.Append(text, pos, closeParen - pos + 1)
                        }
                        pos = closeParen + 1
                        continue
                    }
                }
            }
            // Bare (cref:Target) form.
            if text[pos] == '(' && pos + 5 < text.Length && text.Substring(pos + 1, 5) == "cref:" {
                let closeParen = text.IndexOf(')', pos + 6)
                if closeParen > pos + 6 {
                    FlushText(result, textBuilder)
                    let target = text.Substring(pos + 6, closeParen - pos - 6)
                    result.Add(DocInline.SymbolRef(target, ImmutableArray[DocInline].Empty))
                    pos = closeParen + 1
                    continue
                }
            }
            textBuilder.Append(text[pos])
            pos++
        }
        FlushText(result, textBuilder)
        return result.ToImmutable()
    }

    private func FindClosingBracket(text string, openPos int32) int32 {
        var depth = 0
        for var i = openPos; i < text.Length; i++ {
            if text[i] == '[' {
                depth++
            } else if text[i] == ']' {
                depth--
                if depth == 0 {
                    return i
                }
            }
        }
        return -1
    }

    private func FlushText(result ImmutableArray[DocInline].Builder, textBuilder StringBuilder) {
        if textBuilder.Length > 0 {
            result.Add(DocInline.Text(textBuilder.ToString()))
            textBuilder.Clear()
        }
    }
}
