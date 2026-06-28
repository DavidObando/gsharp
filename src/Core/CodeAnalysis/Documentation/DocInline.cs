#nullable disable

// <copyright file="DocInline.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Documentation;

/// <summary>
/// A node in the ordered inline-content tree of a <see cref="DocumentationComment"/>.
/// Inline content is the shared internal representation that both the Markdown
/// authoring surface (G# → model) and the ingested XML-doc vocabulary (C# → model)
/// are parsed into, per ADR-0057 §4. Any imported XML element with no first-class
/// case here is preserved verbatim as <see cref="UnknownXmlElement"/> so hover can
/// render it and emission can reproduce it byte-for-byte.
/// </summary>
public abstract record DocInline
{
    /// <summary>A run of literal text.</summary>
    /// <param name="Value">The literal text.</param>
    public sealed record Text(string Value) : DocInline;

    /// <summary>Inline code (XML <c>&lt;c&gt;</c> / Markdown backticks).</summary>
    /// <param name="Value">The code text.</param>
    public sealed record Code(string Value) : DocInline;

    /// <summary>A fenced/preformatted code block (XML <c>&lt;code&gt;</c>).</summary>
    /// <param name="Language">The optional language tag, or null.</param>
    /// <param name="Value">The code text.</param>
    public sealed record CodeBlock(string Language, string Value) : DocInline;

    /// <summary>A paragraph (XML <c>&lt;para&gt;</c>).</summary>
    /// <param name="Content">The ordered inline content of the paragraph.</param>
    public sealed record Para(ImmutableArray<DocInline> Content) : DocInline;

    /// <summary>A list (XML <c>&lt;list&gt;</c>).</summary>
    /// <param name="ListType">The list type (<c>bullet</c>, <c>number</c>, <c>table</c>), or null.</param>
    /// <param name="Items">The list items.</param>
    public sealed record List(string ListType, ImmutableArray<DocListItem> Items) : DocInline;

    /// <summary>A reference to a documented symbol (XML <c>&lt;see cref&gt;</c>).</summary>
    /// <param name="DocId">The target documentation id (cref).</param>
    /// <param name="Inner">Optional display content, or default when the cref renders itself.</param>
    public sealed record SymbolRef(string DocId, ImmutableArray<DocInline> Inner) : DocInline;

    /// <summary>An external hyperlink (Markdown link with an <c>http(s)</c> target).</summary>
    /// <param name="Href">The link target.</param>
    /// <param name="Inner">The link display content.</param>
    public sealed record Link(string Href, ImmutableArray<DocInline> Inner) : DocInline;

    /// <summary>A reference to a parameter (XML <c>&lt;paramref name&gt;</c>).</summary>
    /// <param name="Name">The referenced parameter name.</param>
    public sealed record ParamRef(string Name) : DocInline;

    /// <summary>An <c>&lt;inheritdoc/&gt;</c> marker, resolved lazily at hover time.</summary>
    /// <param name="Cref">The optional cref target, or null for "inherit from base".</param>
    public sealed record InheritDoc(string Cref) : DocInline;

    /// <summary>
    /// A verbatim, well-formed XML fragment with no first-class model case. Backs
    /// both the authoring escape hatch and full-fidelity ingestion (ADR-0057 §4/§6).
    /// </summary>
    /// <param name="RawXml">The verbatim XML fragment.</param>
    public sealed record UnknownXmlElement(string RawXml) : DocInline;
}

/// <summary>
/// A single item of a <see cref="DocInline.List"/>, modelling the XML
/// <c>&lt;item&gt;&lt;term&gt;…&lt;/term&gt;&lt;description&gt;…&lt;/description&gt;&lt;/item&gt;</c> shape.
/// </summary>
/// <param name="Term">The optional term content.</param>
/// <param name="Description">The description content.</param>
public sealed record DocListItem(ImmutableArray<DocInline> Term, ImmutableArray<DocInline> Description);
