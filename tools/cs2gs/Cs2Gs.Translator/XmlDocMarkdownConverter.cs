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
    /// Issue #3501 follow-up: maximum content width (excluding the
    /// <c>/// </c> marker and indentation) of an emitted prose doc line.
    /// Sized so a doc line at typical nesting stays within the printer's
    /// 120-column budget.
    /// </summary>
    private const int MaxDocLineWidth = 100;

    /// <summary>
    /// ADR-0057 block tags: the only <c>@name</c> heads gsc accepts at the
    /// start of a doc-comment line. Anything else there is GS0231.
    /// </summary>
    private static readonly string[] BlockTags =
    {
        "@param", "@typeparam", "@returns", "@remarks",
        "@value", "@exception", "@seealso",
    };

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

        // ADR-0179 phase 9a: prose lines already arrive with the author's own
        // `///` line structure preserved (see SplitInlineIntoLines), so this
        // pass is a BACKSTOP, not the layout: it only re-wraps a line the
        // author themselves wrote longer than the budget. Fenced content
        // (```…```) is untouched.
        var wrapped = new List<string>(output.Count);
        bool inFence = false;
        foreach (string line in JoinStrayTagStarts(output))
        {
            if (line.TrimStart().StartsWith("```", StringComparison.Ordinal))
            {
                inFence = !inFence;
                wrapped.Add(line);
            }
            else if (inFence)
            {
                wrapped.Add(line);
            }
            else
            {
                wrapped.AddRange(WrapProseLine(line));
            }
        }

        return wrapped
            .Select(line => string.IsNullOrWhiteSpace(line) ? "///" : $"/// {line}")
            .ToList();
    }

    /// <summary>
    /// Word-wraps one prose line to <see cref="MaxDocLineWidth"/> content
    /// characters. List items and <c>@tag</c> heads simply continue on the
    /// following line (Markdown treats the continuation as part of the same
    /// block). Wrap points are only taken between "atoms": a Markdown link
    /// (<c>[text](target)</c>) or backtick code span is never split even
    /// when it contains spaces, and a single atom longer than the width
    /// stays intact on its own line.
    /// </summary>
    private static IEnumerable<string> WrapProseLine(string line)
    {
        if (line.Length <= MaxDocLineWidth)
        {
            yield return line;
            yield break;
        }

        var current = new StringBuilder();
        foreach (string atom in SplitIntoAtoms(line))
        {
            // Never START a line with something gsc would read as a block tag
            // but does not recognise: a continuation line beginning `@rsp` is
            // GS0231, not prose. Overflowing the width beats emitting a doc
            // comment the compiler rejects.
            if (current.Length > 0
                && current.Length + 1 + atom.Length > MaxDocLineWidth
                && !IsStrayTagStart(atom))
            {
                yield return current.ToString();
                current.Clear();
            }

            if (current.Length > 0)
            {
                current.Append(' ');
            }

            current.Append(atom);
        }

        if (current.Length > 0)
        {
            yield return current.ToString();
        }
    }

    /// <summary>
    /// Issue #3501: joins any prose line that begins with an <c>@word</c> gsc
    /// does not recognise as a block tag onto the line before it.
    /// </summary>
    /// <remarks>
    /// ADR-0179 phase 9a preserves the author's own <c>///</c> line structure,
    /// which is how <c>&lt;c&gt;dotnet &lt;tool&gt;.dll\n/// @rsp&lt;/c&gt;</c>
    /// — a C# inline code span the author happened to wrap mid-span — reached
    /// the emitted G# as a line starting <c>@rsp</c>. gsc reads a line-leading
    /// <c>@word</c> as a block tag and fails the whole project with GS0231
    /// "Unknown documentation tag". The author's line break inside the span
    /// carries no meaning in Markdown, so healing it here is lossless.
    /// </remarks>
    private static List<string> JoinStrayTagStarts(List<string> lines)
    {
        var joined = new List<string>(lines.Count);
        bool inFence = false;
        foreach (string line in lines)
        {
            if (line.TrimStart().StartsWith("```", StringComparison.Ordinal))
            {
                inFence = !inFence;
                joined.Add(line);
                continue;
            }

            if (!inFence
                && IsStrayTagStart(line)
                && joined.Count > 0
                && !string.IsNullOrWhiteSpace(joined[^1])
                && !joined[^1].TrimStart().StartsWith("```", StringComparison.Ordinal))
            {
                joined[^1] = joined[^1].TrimEnd() + " " + line.TrimStart();
                continue;
            }

            joined.Add(line);
        }

        return joined;
    }

    /// <summary>
    /// Whether <paramref name="text"/> starts with an <c>@word</c> that is not
    /// one of ADR-0057's block tags — i.e. text that must not be allowed to
    /// begin an emitted doc line.
    /// </summary>
    private static bool IsStrayTagStart(string text)
    {
        string trimmed = text.TrimStart();
        if (!trimmed.StartsWith("@", StringComparison.Ordinal))
        {
            return false;
        }

        int end = trimmed.IndexOf(' ');
        string head = end < 0 ? trimmed : trimmed.Substring(0, end);
        return !BlockTags.Contains(head, StringComparer.Ordinal);
    }

    /// <summary>
    /// Splits a prose line at spaces, re-merging any run of words that sits
    /// inside an unclosed inline span — an unterminated code span, an
    /// unclosed <c>[</c>, or an unclosed link-target <c>](…</c> — so
    /// Markdown links and code spans survive wrapping as single atoms.
    /// </summary>
    private static IEnumerable<string> SplitIntoAtoms(string line)
    {
        var atom = new StringBuilder();
        foreach (string word in line.Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            if (atom.Length > 0)
            {
                atom.Append(' ');
            }

            atom.Append(word);
            if (!HasOpenInlineSpan(atom.ToString()))
            {
                yield return atom.ToString();
                atom.Clear();
            }
        }

        if (atom.Length > 0)
        {
            yield return atom.ToString();
        }
    }

    private static bool HasOpenInlineSpan(string text)
    {
        int bracketDepth = 0;
        int linkParenDepth = 0;
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if (c == '`')
            {
                // ADR-0179 phase 9a: brackets inside a code span are CODE, not
                // Markdown. Counting them is what made `` `?[` `` (a `<c>`
                // element naming the null-conditional index operator) leave
                // bracketDepth open forever, so every remaining word merged
                // into one unsplittable atom and the whole comment emitted as
                // a single >300-char line. Skip the span wholesale; an
                // unterminated one is genuinely open.
                int close = text.IndexOf('`', i + 1);
                if (close < 0)
                {
                    return true;
                }

                i = close;
            }
            else if (c == '[')
            {
                bracketDepth++;
            }
            else if (c == ']')
            {
                if (bracketDepth > 0)
                {
                    bracketDepth--;
                }

                if (i + 1 < text.Length && text[i + 1] == '(')
                {
                    linkParenDepth++;
                    i++;
                }
            }
            else if (c == ')' && linkParenDepth > 0)
            {
                linkParenDepth--;
            }
        }

        return bracketDepth > 0 || linkParenDepth > 0;
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
            string text = inline.ToString();
            inline.Clear();
            lines.AddRange(SplitInlineIntoLines(text));
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

    /// <summary>
    /// ADR-0179 phase 9a: renders an inline run as Markdown lines that KEEP
    /// the author's own <c>///</c> line breaks.
    /// </summary>
    /// <remarks>
    /// The run's newlines are exactly the source comment's line boundaries —
    /// <see cref="Convert"/> joins the stripped <c>///</c> lines with
    /// <c>'\n'</c>, and every inline element renders to a single line — so
    /// splitting here can never cut a code span or a link in half. Collapsing
    /// them instead (the previous behaviour) turned an eight-line
    /// <c>&lt;remarks&gt;</c> into one 424-character line and left the width
    /// entirely to a re-wrap pass; a comment's line structure is the author's,
    /// not the translator's, so it is preserved rather than recomputed.
    /// Whitespace WITHIN a line is still normalized, runs of blank lines
    /// collapse to one (the Markdown paragraph break), and the run's leading
    /// and trailing blanks are dropped.
    /// </remarks>
    private static List<string> SplitInlineIntoLines(string text)
    {
        var lines = new List<string>();
        foreach (string raw in text.Split('\n'))
        {
            string normalized = NormalizeInlineWhitespace(raw);
            if (normalized.Length == 0)
            {
                // Leading blanks are dropped; interior runs collapse to one.
                if (lines.Count > 0 && lines[^1].Length > 0)
                {
                    lines.Add(string.Empty);
                }

                continue;
            }

            lines.Add(normalized);
        }

        while (lines.Count > 0 && lines[^1].Length == 0)
        {
            lines.RemoveAt(lines.Count - 1);
        }

        return lines;
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
