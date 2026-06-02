// <copyright file="HoverDocumentationRenderer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Text;
using GSharp.Core.CodeAnalysis.Documentation;

namespace GSharp.LanguageServer;

/// <summary>
/// Renders the structured <see cref="DocumentationComment"/> model (ADR-0057 §4) into the
/// Markdown sections a hover card displays. Shared by ingested (C# → G#) and, later,
/// authored (G#) documentation so both surfaces render identically.
/// </summary>
internal static class HoverDocumentationRenderer
{
    /// <summary>
    /// Renders a documentation comment into ordered hover sections, or an empty list when
    /// the comment is null/empty.
    /// </summary>
    /// <param name="documentation">The documentation to render.</param>
    /// <returns>The ordered sections (heading + Markdown body).</returns>
    public static IReadOnlyList<HoverDocSection> Render(DocumentationComment documentation)
    {
        if (documentation is null)
        {
            return System.Array.Empty<HoverDocSection>();
        }

        var sections = new List<HoverDocSection>();

        AddProse(sections, heading: null, documentation.Summary);
        AddNamed(sections, "Type parameters", documentation.TypeParameters);
        AddNamed(sections, "Parameters", documentation.Parameters);
        AddProse(sections, "Returns", documentation.Returns);
        AddProse(sections, "Value", documentation.Value);
        AddExceptions(sections, documentation.Exceptions);
        AddProse(sections, "Remarks", documentation.Remarks);

        return sections;
    }

    private static void AddProse(List<HoverDocSection> sections, string heading, ImmutableArray<DocInline> content)
    {
        var body = RenderInline(content).Trim();
        if (body.Length > 0)
        {
            sections.Add(new HoverDocSection(heading, body));
        }
    }

    private static void AddNamed(List<HoverDocSection> sections, string heading, ImmutableArray<DocParam> entries)
    {
        if (entries.IsDefaultOrEmpty)
        {
            return;
        }

        var builder = new StringBuilder();
        foreach (var entry in entries)
        {
            var description = RenderInline(entry.Content).Trim();
            builder.Append("- `").Append(entry.Name).Append('`');
            if (description.Length > 0)
            {
                builder.Append(" — ").Append(description);
            }

            builder.Append('\n');
        }

        sections.Add(new HoverDocSection(heading, builder.ToString().TrimEnd()));
    }

    private static void AddExceptions(List<HoverDocSection> sections, ImmutableArray<DocException> exceptions)
    {
        if (exceptions.IsDefaultOrEmpty)
        {
            return;
        }

        var builder = new StringBuilder();
        foreach (var exception in exceptions)
        {
            var description = RenderInline(exception.Content).Trim();
            builder.Append("- `").Append(SimpleCrefName(exception.Cref)).Append('`');
            if (description.Length > 0)
            {
                builder.Append(" — ").Append(description);
            }

            builder.Append('\n');
        }

        sections.Add(new HoverDocSection("Exceptions", builder.ToString().TrimEnd()));
    }

    private static string RenderInline(ImmutableArray<DocInline> content)
    {
        if (content.IsDefaultOrEmpty)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        foreach (var node in content)
        {
            RenderNode(builder, node);
        }

        return builder.ToString();
    }

    private static void RenderNode(StringBuilder builder, DocInline node)
    {
        switch (node)
        {
            case DocInline.Text text:
                builder.Append(Escape(text.Value));
                break;
            case DocInline.Code code:
                builder.Append('`').Append(code.Value).Append('`');
                break;
            case DocInline.CodeBlock codeBlock:
                builder.Append("\n\n```").Append(codeBlock.Language ?? string.Empty).Append('\n')
                    .Append(codeBlock.Value.Trim('\n')).Append("\n```\n\n");
                break;
            case DocInline.Para para:
                builder.Append("\n\n").Append(RenderInline(para.Content).Trim()).Append("\n\n");
                break;
            case DocInline.List list:
                RenderList(builder, list);
                break;
            case DocInline.SymbolRef symbolRef:
                var refText = RenderInline(symbolRef.Inner).Trim();
                builder.Append('`').Append(refText.Length > 0 ? refText : SimpleCrefName(symbolRef.DocId)).Append('`');
                break;
            case DocInline.Link link:
                var linkText = RenderInline(link.Inner).Trim();
                builder.Append('[').Append(linkText.Length > 0 ? linkText : link.Href).Append("](").Append(link.Href).Append(')');
                break;
            case DocInline.ParamRef paramRef:
                builder.Append('`').Append(paramRef.Name).Append('`');
                break;
            case DocInline.UnknownXmlElement unknown:
                builder.Append(Escape(StripTags(unknown.RawXml)));
                break;
        }
    }

    private static void RenderList(StringBuilder builder, DocInline.List list)
    {
        builder.Append('\n');
        var ordered = list.ListType == "number";
        var i = 1;
        foreach (var item in list.Items)
        {
            var term = RenderInline(item.Term).Trim();
            var description = RenderInline(item.Description).Trim();
            builder.Append('\n').Append(ordered ? $"{i}. " : "- ");
            if (term.Length > 0)
            {
                builder.Append("**").Append(term).Append("**");
                if (description.Length > 0)
                {
                    builder.Append(" — ");
                }
            }

            builder.Append(description);
            i++;
        }

        builder.Append('\n');
    }

    // The cref carries a "T:"/"M:"/... prefix and a fully-qualified name; hover shows the
    // trailing simple name (and method/parameter tail) for readability.
    private static string SimpleCrefName(string cref)
    {
        if (string.IsNullOrEmpty(cref))
        {
            return string.Empty;
        }

        var name = cref.Length > 2 && cref[1] == ':' ? cref.Substring(2) : cref;
        var parenIndex = name.IndexOf('(');
        var head = parenIndex >= 0 ? name.Substring(0, parenIndex) : name;
        var lastDot = head.LastIndexOf('.');
        return lastDot >= 0 ? name.Substring(lastDot + 1) : name;
    }

    private static string StripTags(string rawXml)
    {
        var builder = new StringBuilder(rawXml.Length);
        var inside = false;
        foreach (var ch in rawXml)
        {
            if (ch == '<')
            {
                inside = true;
            }
            else if (ch == '>')
            {
                inside = false;
            }
            else if (!inside)
            {
                builder.Append(ch);
            }
        }

        return builder.ToString();
    }

    private static string Escape(string value)
    {
        var builder = new StringBuilder(value.Length);
        foreach (var ch in value)
        {
            if (ch is '\\' or '`' or '*' or '_' or '[' or ']' or '<')
            {
                builder.Append('\\');
            }

            builder.Append(ch);
        }

        return builder.ToString();
    }
}
