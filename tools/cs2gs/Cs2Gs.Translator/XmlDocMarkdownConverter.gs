// <copyright file="XmlDocMarkdownConverter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import System
import System.Collections.Generic
import System.Linq
import System.Text
import System.Xml.Linq
import System.Xml

/// Issue #3501 Track B1: converts a C# XML documentation comment into G#'s
/// ADR-0057 Markdown authoring surface. The mapping is the ADR's bijective
/// subset applied in reverse — `<summary>` becomes leading prose,
/// the structured elements become `@param`/`@typeparam`/
/// `@returns`/`@remarks`/`@value`/`@exception`/
/// `@seealso` block tags, and inline elements become their Markdown
/// spellings (`<c>` → backticks, `<see cref>` →
/// `(cref:X)` / `[text](cref:X)`, `<paramref>` →
/// `[`name`](paramref)`, `<para>` → blank lines, bullet and
/// number lists → Markdown lists, `<code>` → fenced blocks).
/// Anything outside the subset is spliced verbatim into the ADR's
/// ````xmldoc` fenced escape hatch so no construct is lost, and a
/// comment that does not parse as XML at all passes through unchanged.
internal shared class XmlDocMarkdownConverter {
    /// Issue #3501 follow-up: maximum content width (excluding the
    /// `/// ` marker and indentation) of an emitted prose doc line.
    /// Sized so a doc line at typical nesting stays within the printer's
    /// 120-column budget.
    private const MaxDocLineWidth int32 = 100

    /// ADR-0057 block tags: the only `@name` heads gsc accepts at the
    /// start of a doc-comment line. Anything else there is GS0231.
    private let BlockTags[]string = []string{
        "@param",
        "@typeparam",
        "@returns",
        "@remarks",
        "@value",
        "@exception",
        "@seealso"
    }

    /// Converts one raw documentation-comment trivia string (the `///`-prefixed
    /// lines) into ADR-0057 Markdown doc-comment lines, each already carrying
    /// the `///` marker.
    /// @param rawTrivia The full text of the documentation trivia.
    /// @returns The converted lines, or `null` when the input
    /// has no content.
    func Convert(rawTrivia string) IReadOnlyList[string]? {
        let sourceLines = rawTrivia
            .Split('\n')
            .Select((line string) -> line.Trim())
            .Where((line string) -> line.Length > 0)
            .Select(
            (line string) -> if line.StartsWith("///", StringComparison.Ordinal) {
                line.Substring(3).TrimStart()
            } else {
                line
            }
        )
            .ToList()
        if sourceLines.Count == 0 {
            return nil
        }
        var root XElement
        try {
            root = XElement.Parse(
                "<gsdoc>" + string.Join("\n", sourceLines) + "</gsdoc>",
                LoadOptions.PreserveWhitespace
            )
        } catch (XmlException) {
            // Not well-formed XML (e.g. prose with a stray '<'): pass the
            // original lines through untouched — never lose author content.
            return sourceLines.Select(
                (line string) -> if line.Length == 0 {
                    "///"
                } else {
                    "/// $line"
                }
            )
                .ToList()
        }
        let output = List[string]()
        let sections = List[(Tag string, Element XElement)]()
        let summaryParts = List[XNode]()
        let unmapped = List[XNode]()
        for node in root.Nodes() {
            if node is XElement element {
                switch element.Name.LocalName {
                    case "summary" {
                        summaryParts.AddRange(element.Nodes())
                        continue
                    }
                    case "param", "typeparam", "returns", "remarks", "value", "exception", "seealso" {
                        sections.Add((element.Name.LocalName, element))
                        continue
                    }
                    default {
                        unmapped.Add(node)
                        continue
                    }
                }
            }
            // Loose prose outside <summary> joins the summary.
            summaryParts.Add(node)
        }
        AppendBlockContent(output, summaryParts)
        for (tag, element) in sections {
            let head string? = switch tag {
                case "param": "@param ${element.Attribute(XName?("name")!!)?.Value}"
                case "typeparam": "@typeparam ${element.Attribute(XName?("name")!!)?.Value}"
                case "returns": "@returns"
                case "remarks": "@remarks"
                case "value": "@value"
                case "exception": "@exception ${element.Attribute(XName?("cref")!!)?.Value}"
                case "seealso": if element.Attribute(XName?("cref")!!) is {} cref {
                    "@seealso ${cref.Value}"
                } else {
                    "@seealso ${element.Attribute(XName?("href")!!)?.Value}"
                }
                default: default(string?)
            }
            let body = RenderBlockLines(element.Nodes())
            if body.Count == 0 {
                output.Add(head!!)
            } else {
                output.Add("$head ${body[0]}".TrimEnd())
                output.AddRange(body.Skip(1))
            }
        }
        for node in unmapped {
            // The ADR-0057 escape hatch: splice any construct the subset
            // omits (<inheritdoc/>, <list type="table">, custom elements)
            // verbatim so it round-trips losslessly.
            output.Add("```xmldoc")
            output.AddRange(node.ToString().Split('\n').Select((line string) -> line.TrimEnd()))
            output.Add("```")
        }
        while output.Count > 0 && string.IsNullOrWhiteSpace(output[^1]) {
            output.RemoveAt(output.Count - 1)
        }
        while output.Count > 0 && string.IsNullOrWhiteSpace(output[0]) {
            output.RemoveAt(0)
        }
        if output.Count == 0 {
            return nil
        }
        // ADR-0179 phase 9a: prose lines already arrive with the author's own
        // `///` line structure preserved (see SplitInlineIntoLines), so this
        // pass is a BACKSTOP, not the layout: it only re-wraps a line the
        // author themselves wrote longer than the budget. Fenced content
        // (```…```) is untouched.
        let wrapped = List[string](output.Count)
        var inFence = false
        for line in JoinStrayTagStarts(output) {
            if line.TrimStart().StartsWith("```", StringComparison.Ordinal) {
                inFence = !inFence
                wrapped.Add(line)
            } else if inFence {
                wrapped.Add(line)
            } else {
                wrapped.AddRange(WrapProseLine(line))
            }
        }
        return wrapped.Select(
            (line string) -> if string.IsNullOrWhiteSpace(line) {
                "///"
            } else {
                "/// $line"
            }
        )
            .ToList()
    }

    /// Word-wraps one prose line to (cref:MaxDocLineWidth) content
    /// characters. List items and `@tag` heads simply continue on the
    /// following line (Markdown treats the continuation as part of the same
    /// block). Wrap points are only taken between "atoms": a Markdown link
    /// (`[text](target)`) or backtick code span is never split even
    /// when it contains spaces, and a single atom longer than the width
    /// stays intact on its own line.
    private func WrapProseLine(line string) sequence[string] {
        if line.Length <= MaxDocLineWidth {
            yield line
            yield break
        }
        let current = StringBuilder()
        for atom in SplitIntoAtoms(line) {
            // Never START a line with something gsc would read as a block tag
            // but does not recognise: a continuation line beginning `@rsp` is
            // GS0231, not prose. Overflowing the width beats emitting a doc
            // comment the compiler rejects.
            if current.Length > 0 && current.Length + 1 + atom.Length > MaxDocLineWidth && !IsStrayTagStart(atom) {
                yield current.ToString()
                current.Clear()
            }
            if current.Length > 0 {
                current.Append(' ')
            }
            current.Append(atom)
        }
        if current.Length > 0 {
            yield current.ToString()
        }
    }

    /// Issue #3501: joins any prose line that begins with an `@word` gsc
    /// does not recognise as a block tag onto the line before it.
    /// @remarks ADR-0179 phase 9a preserves the author's own `///` line structure,
    /// which is how `<c>dotnet <tool>.dll\n/// @rsp</c>`
    /// — a C# inline code span the author happened to wrap mid-span — reached
    /// the emitted G# as a line starting `@rsp`. gsc reads a line-leading
    /// `@word` as a block tag and fails the whole project with GS0231
    /// "Unknown documentation tag". The author's line break inside the span
    /// carries no meaning in Markdown, so healing it here is lossless.
    private func JoinStrayTagStarts(lines List[string]) List[string] {
        let joined = List[string](lines.Count)
        var inFence = false
        for line in lines {
            if line.TrimStart().StartsWith("```", StringComparison.Ordinal) {
                inFence = !inFence
                joined.Add(line)
                continue
            }
            if !inFence && IsStrayTagStart(line) && joined.Count > 0 && !string.IsNullOrWhiteSpace(joined[^1]) &&
                !joined[^1]
                .TrimStart().StartsWith("```", StringComparison.Ordinal) {
                joined[^1] = joined[^1].TrimEnd() + " " + line.TrimStart()
                continue
            }
            joined.Add(line)
        }
        return joined
    }

    /// Whether [`text`](paramref) starts with an `@word` that is not
    /// one of ADR-0057's block tags — i.e. text that must not be allowed to
    /// begin an emitted doc line.
    private func IsStrayTagStart(text string) bool {
        let trimmed = text.TrimStart()
        if !trimmed.StartsWith("@", StringComparison.Ordinal) {
            return false
        }
        let end = trimmed.IndexOf(' ')
        let head = if end < 0 {
            trimmed
        } else {
            trimmed.Substring(0, end)
        }
        return !BlockTags.Contains(head, StringComparer.Ordinal)
    }

    /// Splits a prose line at spaces, re-merging any run of words that sits
    /// inside an unclosed inline span — an unterminated code span, an
    /// unclosed `[`, or an unclosed link-target `](…` — so
    /// Markdown links and code spans survive wrapping as single atoms.
    private func SplitIntoAtoms(line string) sequence[string] {
        let atom = StringBuilder()
        for word in line.Split(' ', StringSplitOptions.RemoveEmptyEntries) {
            if atom.Length > 0 {
                atom.Append(' ')
            }
            atom.Append(word)
            if !HasOpenInlineSpan(atom.ToString()) {
                yield atom.ToString()
                atom.Clear()
            }
        }
        if atom.Length > 0 {
            yield atom.ToString()
        }
    }

    private func HasOpenInlineSpan(text string) bool {
        var bracketDepth = 0
        var linkParenDepth = 0
        for var i = 0; i < text.Length; i++ {
            let c = text[i]
            if c == '`' {
                // ADR-0179 phase 9a: brackets inside a code span are CODE, not
                // Markdown. Counting them is what made `` `?[` `` (a `<c>`
                // element naming the null-conditional index operator) leave
                // bracketDepth open forever, so every remaining word merged
                // into one unsplittable atom and the whole comment emitted as
                // a single >300-char line. Skip the span wholesale; an
                // unterminated one is genuinely open.
                let close = text.IndexOf('`', i + 1)
                if close < 0 {
                    return true
                }
                i = close
            } else if c == '[' {
                bracketDepth++
            } else if c == ']' {
                if bracketDepth > 0 {
                    bracketDepth--
                }
                if i + 1 < text.Length && text[i + 1] == '(' {
                    linkParenDepth++
                    i++
                }
            } else if c == ')' && linkParenDepth > 0 {
                linkParenDepth--
            }
        }
        return bracketDepth > 0 || linkParenDepth > 0
    }

    private func AppendBlockContent(output List[string], nodes IEnumerable[XNode]) {
        let lines = RenderBlockLines(nodes)
        output.AddRange(lines)
    }

    /// Renders mixed block content (paragraphs, lists, code fences, inline
    /// runs) into Markdown lines without any comment marker.
    private func RenderBlockLines(nodes IEnumerable[XNode]) List[string] {
        let lines = List[string]()
        let inline = StringBuilder()
        let FlushInline = func () {
            let text = inline.ToString()
            inline.Clear()
            lines.AddRange(SplitInlineIntoLines(text))
        }
        let BlankSeparator = func () {
            if lines.Count > 0 && !string.IsNullOrWhiteSpace(lines[^1]) {
                lines.Add(string.Empty)
            }
        }
        for node in nodes {
            switch node {
                case text is XText {
                    inline.Append(text.Value)
                }
                case XElement{Name: {LocalName: "para"}} para {
                    FlushInline()
                    BlankSeparator()
                    lines.AddRange(RenderBlockLines(para.Nodes()))
                    lines.Add(string.Empty)
                }
                case XElement{Name: {LocalName: "code"}} code {
                    FlushInline()
                    let lang = code.Attribute(XName?("lang")!!)?.Value ?? code.Attribute(XName?("language")!!)
                        ?.Value ??
                        string.Empty
                    lines.Add("```$lang")
                    lines.AddRange(TrimCodeBlock(code.Value))
                    lines.Add("```")
                }
                case XElement{Name: {LocalName: "list"}} list {
                    FlushInline()
                    let type string? = list.Attribute(XName?("type")!!)?.Value
                    if type == "bullet" || type == "number" {
                        var ordinal = 1
                        for item in list.Elements("item") {
                            let itemNodes = if item.Element(XName?("description")!!) is {} description {
                                description.Nodes()
                            } else {
                                item.Nodes()
                            }
                            let itemText = NormalizeInlineWhitespace(RenderInline(itemNodes))
                            lines.Add(
                                if type == "bullet" {
                                    "- $itemText"
                                } else {
                                    "$ordinal. $itemText"
                                }
                            )
                            ordinal++
                        }
                    } else {
                        // Table (and any other) list shapes are outside the
                        // bijective subset — escape-hatch them verbatim.
                        lines.Add("```xmldoc")
                        lines.AddRange(list.ToString().Split('\n').Select((l string) -> l.TrimEnd()))
                        lines.Add("```")
                    }
                }
                default {
                    inline.Append(RenderInline([]XNode{node}))
                }
            }
        }
        FlushInline()
        while lines.Count > 0 && string.IsNullOrWhiteSpace(lines[^1]) {
            lines.RemoveAt(lines.Count - 1)
        }
        return lines
    }

    private func RenderInline(nodes IEnumerable[XNode]) string {
        let sb = StringBuilder()
        for node in nodes {
            switch node {
                case text is XText {
                    sb.Append(text.Value)
                }
                case XElement{Name: {LocalName: "c"}} code {
                    sb.Append('`').Append(code.Value).Append('`')
                }
                case XElement{Name: {LocalName: "see"}} see {
                    if see.Attribute(XName?("cref")!!) is {} cref {
                        let target = StripDocIdPrefix(cref.Value)
                        sb.Append(
                            if string.IsNullOrEmpty(see.Value) {
                                "(cref:$target)"
                            } else {
                                "[${see.Value}](cref:$target)"
                            }
                        )
                    } else if see.Attribute(XName?("href")!!) is {} href {
                        sb
                            .Append('[')
                            .Append(
                            if string.IsNullOrEmpty(see.Value) {
                                href.Value
                            } else {
                                see.Value
                            }
                        )
                            .Append("](")
                            .Append(href.Value)
                            .Append(')')
                    } else if see.Attribute(XName?("langword")!!) is {} langword {
                        // `<see langword="null"/>` has no subset spelling;
                        // backticks read identically and keep the doc inline.
                        sb.Append('`').Append(langword.Value).Append('`')
                    }
                }
                case XElement{Name: {LocalName: "paramref"}} paramref {
                    sb.Append("[`").Append(paramref.Attribute(XName?("name")!!)?.Value).Append("`](paramref)")
                }
                case XElement{Name: {LocalName: "typeparamref"}} typeparamref {
                    // Outside the subset; backticks are the readable stand-in.
                    sb.Append('`').Append(typeparamref.Attribute(XName?("name")!!)?.Value).Append('`')
                }
                default {
                    sb.Append(node.ToString())
                }
            }
        }
        return sb.ToString()
    }

    /// ADR-0179 phase 9a: renders an inline run as Markdown lines that KEEP
    /// the author's own `///` line breaks.
    /// @remarks The run's newlines are exactly the source comment's line boundaries —
    /// (cref:Convert) joins the stripped `///` lines with
    /// `'\n'`, and every inline element renders to a single line — so
    /// splitting here can never cut a code span or a link in half. Collapsing
    /// them instead (the previous behaviour) turned an eight-line
    /// `<remarks>` into one 424-character line and left the width
    /// entirely to a re-wrap pass; a comment's line structure is the author's,
    /// not the translator's, so it is preserved rather than recomputed.
    /// Whitespace WITHIN a line is still normalized, runs of blank lines
    /// collapse to one (the Markdown paragraph break), and the run's leading
    /// and trailing blanks are dropped.
    private func SplitInlineIntoLines(text string) List[string] {
        let lines = List[string]()
        for raw in text.Split('\n') {
            let normalized = NormalizeInlineWhitespace(raw)
            if normalized.Length == 0 {
                // Leading blanks are dropped; interior runs collapse to one.
                if lines.Count > 0 && lines[^1].Length > 0 {
                    lines.Add(string.Empty)
                }
                continue
            }
            lines.Add(normalized)
        }
        while lines.Count > 0 && lines[^1].Length == 0 {
            lines.RemoveAt(lines.Count - 1)
        }
        return lines
    }

    private func NormalizeInlineWhitespace(text string) string {
        let sb = StringBuilder(text.Length)
        var pendingSpace = false
        for c in text {
            if char.IsWhiteSpace(c) {
                pendingSpace = sb.Length > 0
            } else {
                if pendingSpace {
                    sb.Append(' ')
                    pendingSpace = false
                }
                sb.Append(c)
            }
        }
        return sb.ToString()
    }

    private func TrimCodeBlock(value string) IEnumerable[string] {
        let raw = value.Split('\n')
        let kept = raw
            .SkipWhile(string.IsNullOrWhiteSpace)
            .Reverse()
            .SkipWhile(string.IsNullOrWhiteSpace)
            .Reverse()
            .ToList()
        let indent = kept
            .Where((line string) -> line.TrimEnd().Length > 0)
            .Select((line string) -> line.Length - line.TrimStart().Length)
            .DefaultIfEmpty(0)
            .Min()
        return kept.Select(
            (line string) -> if line.Length >= indent {
                line.Substring(indent).TrimEnd()
            } else {
                line.TrimEnd()
            }
        )
    }

    private func StripDocIdPrefix(cref string) string -> if cref.Length > 2 && cref[1] == ':' {
        cref.Substring(2)
    } else {
        cref
    }
}
