#nullable disable

// <copyright file="GSharpDocumentationParser.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Text;
using System.Xml.Linq;

namespace GSharp.Core.CodeAnalysis.Documentation;

/// <summary>
/// Parses a G# documentation block (Markdown + KDoc-style block tags + xmldoc escape hatch)
/// into the internal <see cref="DocumentationComment"/> model (ADR-0057 §3).
/// </summary>
internal static class GSharpDocumentationParser
{
    /// <summary>
    /// Parses the raw joined documentation block text into a <see cref="DocumentationComment"/>.
    /// Returns <see langword="null"/> when the input is null or whitespace-only.
    /// </summary>
    /// <param name="blockText">The joined lines from the doc block (newline-separated).</param>
    /// <returns>The parsed documentation model, or <see langword="null"/>.</returns>
    internal static DocumentationComment Parse(string blockText)
    {
        if (string.IsNullOrWhiteSpace(blockText))
        {
            return null;
        }

        var lines = blockText.Split('\n');
        var sections = SplitIntoSections(lines);

        var summary = ImmutableArray<DocInline>.Empty;
        var parameters = ImmutableArray.CreateBuilder<DocParam>();
        var typeParameters = ImmutableArray.CreateBuilder<DocParam>();
        var returns = ImmutableArray<DocInline>.Empty;
        var remarks = ImmutableArray<DocInline>.Empty;
        var value = ImmutableArray<DocInline>.Empty;
        var exceptions = ImmutableArray.CreateBuilder<DocException>();
        var seeAlso = ImmutableArray.CreateBuilder<DocReference>();

        foreach (var section in sections)
        {
            switch (section.Tag)
            {
                case null:
                    // Leading prose = summary.
                    summary = ParseInlineContent(section.Body);
                    break;
                case "@param":
                    if (TryExtractName(section.Body, out var paramName, out var paramContent))
                    {
                        parameters.Add(new DocParam(paramName, ParseInlineContent(paramContent)));
                    }

                    break;
                case "@typeparam":
                    if (TryExtractName(section.Body, out var typeParamName, out var typeParamContent))
                    {
                        typeParameters.Add(new DocParam(typeParamName, ParseInlineContent(typeParamContent)));
                    }

                    break;
                case "@returns":
                    returns = ParseInlineContent(section.Body);
                    break;
                case "@remarks":
                    remarks = ParseInlineContent(section.Body);
                    break;
                case "@value":
                    value = ParseInlineContent(section.Body);
                    break;
                case "@exception":
                    if (TryExtractName(section.Body, out var exCref, out var exContent))
                    {
                        exceptions.Add(new DocException(exCref, ParseInlineContent(exContent)));
                    }

                    break;
                case "@seealso":
                    if (TryExtractName(section.Body, out var saCref, out var saContent))
                    {
                        var inlines = ParseInlineContent(saContent);
                        if (saCref.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                            saCref.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                        {
                            seeAlso.Add(new DocReference(null, saCref, inlines));
                        }
                        else
                        {
                            seeAlso.Add(new DocReference(saCref, null, inlines));
                        }
                    }

                    break;
            }
        }

        return new DocumentationComment(
            summary,
            parameters.ToImmutable(),
            typeParameters.ToImmutable(),
            returns,
            remarks,
            value,
            exceptions.ToImmutable(),
            seeAlso.ToImmutable());
    }

    private static List<Section> SplitIntoSections(string[] lines)
    {
        var sections = new List<Section>();
        string currentTag = null;
        var currentBody = new StringBuilder();

        foreach (var line in lines)
        {
            var trimmed = line.TrimStart();
            if (trimmed.StartsWith("@param ", StringComparison.Ordinal) ||
                trimmed.StartsWith("@typeparam ", StringComparison.Ordinal) ||
                trimmed.StartsWith("@returns", StringComparison.Ordinal) ||
                trimmed.StartsWith("@remarks", StringComparison.Ordinal) ||
                trimmed.StartsWith("@value", StringComparison.Ordinal) ||
                trimmed.StartsWith("@exception ", StringComparison.Ordinal) ||
                trimmed.StartsWith("@seealso ", StringComparison.Ordinal))
            {
                // Flush previous section.
                if (currentBody.Length > 0 || currentTag != null)
                {
                    sections.Add(new Section(currentTag, currentBody.ToString()));
                    currentBody.Clear();
                }

                // Extract tag and the rest of the line.
                var spaceIdx = trimmed.IndexOf(' ');
                if (spaceIdx < 0)
                {
                    currentTag = trimmed;
                }
                else
                {
                    currentTag = trimmed.Substring(0, spaceIdx);
                    currentBody.Append(trimmed.Substring(spaceIdx + 1));
                }
            }
            else
            {
                if (currentBody.Length > 0)
                {
                    currentBody.Append('\n');
                }

                currentBody.Append(line);
            }
        }

        if (currentBody.Length > 0 || currentTag != null)
        {
            sections.Add(new Section(currentTag, currentBody.ToString()));
        }

        return sections;
    }

    private static bool TryExtractName(string body, out string name, out string remainder)
    {
        name = null;
        remainder = string.Empty;
        if (string.IsNullOrWhiteSpace(body))
        {
            return false;
        }

        var trimmed = body.TrimStart();
        var spaceIdx = trimmed.IndexOf(' ');
        if (spaceIdx < 0)
        {
            name = trimmed;
            remainder = string.Empty;
        }
        else
        {
            name = trimmed.Substring(0, spaceIdx);
            remainder = trimmed.Substring(spaceIdx + 1);
        }

        return !string.IsNullOrEmpty(name);
    }

    private static ImmutableArray<DocInline> ParseInlineContent(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return ImmutableArray<DocInline>.Empty;
        }

        var result = ImmutableArray.CreateBuilder<DocInline>();
        var lines = text.Split('\n');
        var i = 0;

        while (i < lines.Length)
        {
            // Fenced code block detection.
            if (lines[i].TrimStart().StartsWith("```", StringComparison.Ordinal))
            {
                var fenceLine = lines[i].TrimStart();
                var lang = fenceLine.Length > 3 ? fenceLine.Substring(3).Trim() : string.Empty;

                if (string.Equals(lang, "xmldoc", StringComparison.OrdinalIgnoreCase))
                {
                    // XML escape hatch: collect raw XML until closing ```.
                    i++;
                    var xmlBuilder = new StringBuilder();
                    while (i < lines.Length && !lines[i].TrimStart().StartsWith("```", StringComparison.Ordinal))
                    {
                        if (xmlBuilder.Length > 0)
                        {
                            xmlBuilder.Append('\n');
                        }

                        xmlBuilder.Append(lines[i]);
                        i++;
                    }

                    if (i < lines.Length)
                    {
                        i++; // skip closing ```
                    }

                    var rawXml = xmlBuilder.ToString().Trim();
                    if (!string.IsNullOrEmpty(rawXml))
                    {
                        result.Add(new DocInline.UnknownXmlElement(rawXml));
                    }
                }
                else
                {
                    // Regular fenced code block.
                    i++;
                    var codeBuilder = new StringBuilder();
                    while (i < lines.Length && !lines[i].TrimStart().StartsWith("```", StringComparison.Ordinal))
                    {
                        if (codeBuilder.Length > 0)
                        {
                            codeBuilder.Append('\n');
                        }

                        codeBuilder.Append(lines[i]);
                        i++;
                    }

                    if (i < lines.Length)
                    {
                        i++; // skip closing ```
                    }

                    result.Add(new DocInline.CodeBlock(lang, codeBuilder.ToString()));
                }

                continue;
            }

            // Check for list items (bullet or ordered).
            if (IsListItem(lines[i]))
            {
                var (listType, items) = ParseList(lines, ref i);
                result.Add(new DocInline.List(listType, items));
                continue;
            }

            // Paragraph: collect lines until blank line or special structure.
            var paraBuilder = new StringBuilder();
            while (i < lines.Length &&
                   !string.IsNullOrWhiteSpace(lines[i]) &&
                   !lines[i].TrimStart().StartsWith("```", StringComparison.Ordinal) &&
                   !IsListItem(lines[i]))
            {
                if (paraBuilder.Length > 0)
                {
                    paraBuilder.Append(' ');
                }

                paraBuilder.Append(lines[i].TrimEnd());
                i++;
            }

            if (paraBuilder.Length > 0)
            {
                var paraInlines = ParseInlineRuns(paraBuilder.ToString());
                if (result.Count > 0)
                {
                    // Wrap in Para if it's not the first block.
                    result.Add(new DocInline.Para(paraInlines));
                }
                else
                {
                    result.AddRange(paraInlines);
                }
            }

            // Skip blank lines between paragraphs.
            while (i < lines.Length && string.IsNullOrWhiteSpace(lines[i]))
            {
                i++;
            }
        }

        return result.ToImmutable();
    }

    private static bool IsListItem(string line)
    {
        var trimmed = line.TrimStart();
        if (trimmed.StartsWith("- ", StringComparison.Ordinal) ||
            trimmed.StartsWith("* ", StringComparison.Ordinal))
        {
            return true;
        }

        // Ordered list: digit(s) followed by '. '
        for (var j = 0; j < trimmed.Length; j++)
        {
            if (char.IsDigit(trimmed[j]))
            {
                continue;
            }

            if (trimmed[j] == '.' && j > 0 && j + 1 < trimmed.Length && trimmed[j + 1] == ' ')
            {
                return true;
            }

            break;
        }

        return false;
    }

    private static (string ListType, ImmutableArray<DocListItem> Items) ParseList(string[] lines, ref int i)
    {
        var items = ImmutableArray.CreateBuilder<DocListItem>();
        var first = lines[i].TrimStart();
        var isOrdered = char.IsDigit(first[0]);
        var listType = isOrdered ? "number" : "bullet";

        while (i < lines.Length && IsListItem(lines[i]))
        {
            var trimmed = lines[i].TrimStart();
            string itemText;
            if (isOrdered)
            {
                var dotIdx = trimmed.IndexOf(". ", StringComparison.Ordinal);
                itemText = dotIdx >= 0 ? trimmed.Substring(dotIdx + 2) : trimmed;
            }
            else
            {
                itemText = trimmed.Substring(2); // skip "- " or "* "
            }

            var inlines = ParseInlineRuns(itemText);
            items.Add(new DocListItem(ImmutableArray<DocInline>.Empty, inlines));
            i++;
        }

        return (listType, items.ToImmutable());
    }

    private static ImmutableArray<DocInline> ParseInlineRuns(string text)
    {
        var result = ImmutableArray.CreateBuilder<DocInline>();
        var pos = 0;
        var textBuilder = new StringBuilder();

        while (pos < text.Length)
        {
            // Inline code: `code`
            if (text[pos] == '`')
            {
                FlushText(result, textBuilder);
                pos++;
                var codeEnd = text.IndexOf('`', pos);
                if (codeEnd < 0)
                {
                    codeEnd = text.Length;
                }

                result.Add(new DocInline.Code(text.Substring(pos, codeEnd - pos)));
                pos = codeEnd < text.Length ? codeEnd + 1 : codeEnd;
                continue;
            }

            // Link/ref forms: [text](target) or [`name`](paramref)
            if (text[pos] == '[')
            {
                var closeBracket = FindClosingBracket(text, pos);
                if (closeBracket > pos && closeBracket + 1 < text.Length && text[closeBracket + 1] == '(')
                {
                    var closeParen = text.IndexOf(')', closeBracket + 2);
                    if (closeParen > closeBracket + 1)
                    {
                        var linkText = text.Substring(pos + 1, closeBracket - pos - 1);
                        var target = text.Substring(closeBracket + 2, closeParen - closeBracket - 2);

                        FlushText(result, textBuilder);
                        if (string.Equals(target, "paramref", StringComparison.Ordinal))
                        {
                            // [`name`](paramref) → ParamRef
                            var name = linkText.Trim('`');
                            result.Add(new DocInline.ParamRef(name));
                        }
                        else if (target.StartsWith("cref:", StringComparison.Ordinal))
                        {
                            // [text](cref:Target) → SymbolRef
                            var crefTarget = target.Substring(5);
                            var inner = string.IsNullOrEmpty(linkText)
                                ? ImmutableArray<DocInline>.Empty
                                : ImmutableArray.Create<DocInline>(new DocInline.Text(linkText));
                            result.Add(new DocInline.SymbolRef(crefTarget, inner));
                        }
                        else if (target.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                                 target.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                        {
                            // [text](https://…) → Link
                            var inner = string.IsNullOrEmpty(linkText)
                                ? ImmutableArray<DocInline>.Empty
                                : ImmutableArray.Create<DocInline>(new DocInline.Text(linkText));
                            result.Add(new DocInline.Link(target, inner));
                        }
                        else
                        {
                            // Unknown link form — treat as text.
                            textBuilder.Append(text, pos, closeParen - pos + 1);
                        }

                        pos = closeParen + 1;
                        continue;
                    }
                }
            }

            // Bare (cref:Target) form.
            if (text[pos] == '(' && pos + 5 < text.Length &&
                text.Substring(pos + 1, 5) == "cref:")
            {
                var closeParen = text.IndexOf(')', pos + 6);
                if (closeParen > pos + 6)
                {
                    FlushText(result, textBuilder);
                    var target = text.Substring(pos + 6, closeParen - pos - 6);
                    result.Add(new DocInline.SymbolRef(target, ImmutableArray<DocInline>.Empty));
                    pos = closeParen + 1;
                    continue;
                }
            }

            textBuilder.Append(text[pos]);
            pos++;
        }

        FlushText(result, textBuilder);
        return result.ToImmutable();
    }

    private static int FindClosingBracket(string text, int openPos)
    {
        var depth = 0;
        for (var i = openPos; i < text.Length; i++)
        {
            if (text[i] == '[')
            {
                depth++;
            }
            else if (text[i] == ']')
            {
                depth--;
                if (depth == 0)
                {
                    return i;
                }
            }
        }

        return -1;
    }

    private static void FlushText(ImmutableArray<DocInline>.Builder result, StringBuilder textBuilder)
    {
        if (textBuilder.Length > 0)
        {
            result.Add(new DocInline.Text(textBuilder.ToString()));
            textBuilder.Clear();
        }
    }

    private readonly struct Section
    {
        public Section(string tag, string body)
        {
            Tag = tag;
            Body = body;
        }

        public string Tag { get; }

        public string Body { get; }
    }
}
