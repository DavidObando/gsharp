// <copyright file="XmlDocMarkdownConverter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Xml.Linq;

namespace Cs2Gs.Translator;

/// <summary>
/// Issue #3501 Track B1: converts a C# XML documentation comment into G#'s
/// ADR-0057 Markdown authoring surface. The mapping is the ADR's bijective
/// subset applied in reverse — <c>&lt;summary&gt;</c> becomes leading prose,
/// the structured elements become <c>@param</c>/<c>@typeparam</c>/
/// <c>@returns</c>/<c>@remarks</c>/<c>@value</c>/<c>@exception</c>/
/// <c>@seealso</c> block tags, and inline elements become their Markdown
/// spellings (<c>&lt;c&gt;</c> → backticks, <c>&lt;see cref&gt;</c> →
/// <c>(cref:X)</c> / <c>[text](cref:X)</c>, <c>&lt;paramref&gt;</c> →
/// <c>[`name`](paramref)</c>, <c>&lt;para&gt;</c> → blank lines, bullet and
/// number lists → Markdown lists, <c>&lt;code&gt;</c> → fenced blocks).
/// Anything outside the subset is spliced verbatim into the ADR's
/// <c>```xmldoc</c> fenced escape hatch so no construct is lost, and a
/// comment that does not parse as XML at all passes through unchanged.
/// </summary>
internal static class XmlDocMarkdownConverter
{
    /// <summary>
    /// Converts one raw documentation-comment trivia string (the `///`-prefixed
    /// lines) into ADR-0057 Markdown doc-comment lines, each already carrying
    /// the <c>///</c> marker.
    /// </summary>
    /// <param name="rawTrivia">The full text of the documentation trivia.</param>
    /// <returns>The converted lines, or <see langword="null"/> when the input
    /// has no content.</returns>
    public static IReadOnlyList<string> Convert(string rawTrivia)
    {
        List<string> sourceLines = rawTrivia
            .Split('\n')
            .Select(line => line.Trim())
            .Where(line => line.Length > 0)
            .Select(line => line.StartsWith("///", StringComparison.Ordinal)
                ? line.Substring(3).TrimStart()
                : line)
            .ToList();
        if (sourceLines.Count == 0)
        {
            return null;
        }

        XElement root;
        try
        {
            root = XElement.Parse(
                "<gsdoc>" + string.Join("\n", sourceLines) + "</gsdoc>",
                LoadOptions.PreserveWhitespace);
        }
        catch (System.Xml.XmlException)
        {
            // Not well-formed XML (e.g. prose with a stray '<'): pass the
            // original lines through untouched — never lose author content.
            return sourceLines.Select(line => line.Length == 0 ? "///" : $"/// {line}").ToList();
        }

        var output = new List<string>();
        var sections = new List<(string Tag, XElement Element)>();
        var summaryParts = new List<XNode>();
        var unmapped = new List<XNode>();
        foreach (XNode node in root.Nodes())
        {
            if (node is XElement element)
            {
                switch (element.Name.LocalName)
                {
                    case "summary":
                        summaryParts.AddRange(element.Nodes());
                        continue;
                    case "param":
                    case "typeparam":
                    case "returns":
                    case "remarks":
                    case "value":
                    case "exception":
                    case "seealso":
                        sections.Add((element.Name.LocalName, element));
                        continue;
                    default:
                        unmapped.Add(node);
                        continue;
                }
            }

            // Loose prose outside <summary> joins the summary.
            summaryParts.Add(node);
        }

        AppendBlockContent(output, summaryParts);
        foreach ((string tag, XElement element) in sections)
        {
            string head = tag switch
            {
                "param" => $"@param {element.Attribute("name")?.Value}",
                "typeparam" => $"@typeparam {element.Attribute("name")?.Value}",
                "returns" => "@returns",
                "remarks" => "@remarks",
                "value" => "@value",
                "exception" => $"@exception {element.Attribute("cref")?.Value}",
                "seealso" => element.Attribute("cref") is { } cref
                    ? $"@seealso {cref.Value}"
                    : $"@seealso {element.Attribute("href")?.Value}",
                _ => null,
            };
            List<string> body = RenderBlockLines(element.Nodes());
            if (body.Count == 0)
            {
                output.Add(head);
            }
            else
            {
                output.Add($"{head} {body[0]}".TrimEnd());
                output.AddRange(body.Skip(1));
            }
        }

        foreach (XNode node in unmapped)
        {
            // The ADR-0057 escape hatch: splice any construct the subset
            // omits (<inheritdoc/>, <list type="table">, custom elements)
            // verbatim so it round-trips losslessly.
            output.Add("```xmldoc");
            output.AddRange(node.ToString().Split('\n').Select(line => line.TrimEnd()));
            output.Add("```");
        }

        while (output.Count > 0 && string.IsNullOrWhiteSpace(output[^1]))
        {
            output.RemoveAt(output.Count - 1);
        }

        while (output.Count > 0 && string.IsNullOrWhiteSpace(output[0]))
        {
            output.RemoveAt(0);
        }

        if (output.Count == 0)
        {
            return null;
        }

        return output
            .Select(line => string.IsNullOrWhiteSpace(line) ? "///" : $"/// {line}")
            .ToList();
    }

    private static void AppendBlockContent(List<string> output, IEnumerable<XNode> nodes)
    {
        List<string> lines = RenderBlockLines(nodes);
        output.AddRange(lines);
    }

    /// <summary>
    /// Renders mixed block content (paragraphs, lists, code fences, inline
    /// runs) into Markdown lines without any comment marker.
    /// </summary>
    private static List<string> RenderBlockLines(IEnumerable<XNode> nodes)
    {
        var lines = new List<string>();
        var inline = new StringBuilder();

        void FlushInline()
        {
            string text = NormalizeInlineWhitespace(inline.ToString());
            inline.Clear();
            if (text.Length > 0)
            {
                lines.Add(text);
            }
        }

        void BlankSeparator()
        {
            if (lines.Count > 0 && !string.IsNullOrWhiteSpace(lines[^1]))
            {
                lines.Add(string.Empty);
            }
        }

        foreach (XNode node in nodes)
        {
            switch (node)
            {
                case XText text:
                    inline.Append(text.Value);
                    break;

                case XElement { Name.LocalName: "para" } para:
                    FlushInline();
                    BlankSeparator();
                    lines.AddRange(RenderBlockLines(para.Nodes()));
                    lines.Add(string.Empty);
                    break;

                case XElement { Name.LocalName: "code" } code:
                    FlushInline();
                    string lang = code.Attribute("lang")?.Value
                        ?? code.Attribute("language")?.Value
                        ?? string.Empty;
                    lines.Add($"```{lang}");
                    lines.AddRange(TrimCodeBlock(code.Value));
                    lines.Add("```");
                    break;

                case XElement { Name.LocalName: "list" } list:
                    FlushInline();
                    string type = list.Attribute("type")?.Value;
                    if (type is "bullet" or "number")
                    {
                        int ordinal = 1;
                        foreach (XElement item in list.Elements("item"))
                        {
                            IEnumerable<XNode> itemNodes = item.Element("description") is { } description
                                ? description.Nodes()
                                : item.Nodes();
                            string itemText = NormalizeInlineWhitespace(RenderInline(itemNodes));
                            lines.Add(type == "bullet" ? $"- {itemText}" : $"{ordinal}. {itemText}");
                            ordinal++;
                        }
                    }
                    else
                    {
                        // Table (and any other) list shapes are outside the
                        // bijective subset — escape-hatch them verbatim.
                        lines.Add("```xmldoc");
                        lines.AddRange(list.ToString().Split('\n').Select(l => l.TrimEnd()));
                        lines.Add("```");
                    }

                    break;

                default:
                    inline.Append(RenderInline(new[] { node }));
                    break;
            }
        }

        FlushInline();
        while (lines.Count > 0 && string.IsNullOrWhiteSpace(lines[^1]))
        {
            lines.RemoveAt(lines.Count - 1);
        }

        return lines;
    }

    private static string RenderInline(IEnumerable<XNode> nodes)
    {
        var sb = new StringBuilder();
        foreach (XNode node in nodes)
        {
            switch (node)
            {
                case XText text:
                    sb.Append(text.Value);
                    break;

                case XElement { Name.LocalName: "c" } code:
                    sb.Append('`').Append(code.Value).Append('`');
                    break;

                case XElement { Name.LocalName: "see" } see:
                    if (see.Attribute("cref") is { } cref)
                    {
                        string target = StripDocIdPrefix(cref.Value);
                        sb.Append(string.IsNullOrEmpty(see.Value)
                            ? $"(cref:{target})"
                            : $"[{see.Value}](cref:{target})");
                    }
                    else if (see.Attribute("href") is { } href)
                    {
                        sb.Append('[')
                            .Append(string.IsNullOrEmpty(see.Value) ? href.Value : see.Value)
                            .Append("](")
                            .Append(href.Value)
                            .Append(')');
                    }
                    else if (see.Attribute("langword") is { } langword)
                    {
                        // `<see langword="null"/>` has no subset spelling;
                        // backticks read identically and keep the doc inline.
                        sb.Append('`').Append(langword.Value).Append('`');
                    }

                    break;

                case XElement { Name.LocalName: "paramref" } paramref:
                    sb.Append("[`").Append(paramref.Attribute("name")?.Value).Append("`](paramref)");
                    break;

                case XElement { Name.LocalName: "typeparamref" } typeparamref:
                    // Outside the subset; backticks are the readable stand-in.
                    sb.Append('`').Append(typeparamref.Attribute("name")?.Value).Append('`');
                    break;

                default:
                    sb.Append(node.ToString());
                    break;
            }
        }

        return sb.ToString();
    }

    private static string NormalizeInlineWhitespace(string text)
    {
        var sb = new StringBuilder(text.Length);
        bool pendingSpace = false;
        foreach (char c in text)
        {
            if (char.IsWhiteSpace(c))
            {
                pendingSpace = sb.Length > 0;
            }
            else
            {
                if (pendingSpace)
                {
                    sb.Append(' ');
                    pendingSpace = false;
                }

                sb.Append(c);
            }
        }

        return sb.ToString();
    }

    private static IEnumerable<string> TrimCodeBlock(string value)
    {
        string[] raw = value.Split('\n');
        var kept = raw
            .SkipWhile(string.IsNullOrWhiteSpace)
            .Reverse()
            .SkipWhile(string.IsNullOrWhiteSpace)
            .Reverse()
            .ToList();
        int indent = kept
            .Where(line => line.TrimEnd().Length > 0)
            .Select(line => line.Length - line.TrimStart().Length)
            .DefaultIfEmpty(0)
            .Min();
        return kept.Select(line => line.Length >= indent ? line.Substring(indent).TrimEnd() : line.TrimEnd());
    }

    private static string StripDocIdPrefix(string cref) =>
        cref.Length > 2 && cref[1] == ':' ? cref.Substring(2) : cref;
}
