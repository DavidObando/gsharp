// <copyright file="DocInline.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Documentation

import System
import System.Collections.Immutable

/// A node in the ordered inline-content tree of a (cref:DocumentationComment).
/// Inline content is the shared internal representation that both the Markdown
/// authoring surface (G# → model) and the ingested XML-doc vocabulary (C# → model)
/// are parsed into, per ADR-0057 §4. Any imported XML element with no first-class
/// case here is preserved verbatim as (cref:UnknownXmlElement) so hover can
/// render it and emission can reproduce it byte-for-byte.
abstract data class DocInline : IEquatable[DocInline] {
    /// A run of literal text.
    /// @param Value The literal text.
    data class Text(Value string) : DocInline, IEquatable[Text] { }

    /// Inline code (XML `<c>` / Markdown backticks).
    /// @param Value The code text.
    data class Code(Value string) : DocInline, IEquatable[Code] { }

    /// A fenced/preformatted code block (XML `<code>`).
    /// @param Language The optional language tag, or null.
    /// @param Value The code text.
    data class CodeBlock(Language string?, Value string) : DocInline, IEquatable[CodeBlock] { }

    /// A paragraph (XML `<para>`).
    /// @param Content The ordered inline content of the paragraph.
    data class Para(Content ImmutableArray[DocInline]) : DocInline, IEquatable[Para] { }

    /// A list (XML `<list>`).
    /// @param ListType The list type (`bullet`, `number`, `table`), or null.
    /// @param Items The list items.
    data class List(ListType string?, Items ImmutableArray[DocListItem]) : DocInline, IEquatable[List] { }

    /// A reference to a documented symbol (XML `<see cref>`).
    /// @param DocId The target documentation id (cref).
    /// @param Inner Optional display content, or default when the cref renders itself.
    data class SymbolRef(DocId string, Inner ImmutableArray[DocInline]) : DocInline, IEquatable[SymbolRef] { }

    /// An external hyperlink (Markdown link with an `http(s)` target).
    /// @param Href The link target.
    /// @param Inner The link display content.
    data class Link(Href string?, Inner ImmutableArray[DocInline]) : DocInline, IEquatable[Link] { }

    /// A reference to a parameter (XML `<paramref name>`).
    /// @param Name The referenced parameter name.
    data class ParamRef(Name string) : DocInline, IEquatable[ParamRef] { }

    /// An `<inheritdoc/>` marker, resolved lazily at hover time.
    /// @param Cref The optional cref target, or null for "inherit from base".
    data class InheritDoc(Cref string?) : DocInline, IEquatable[InheritDoc] { }

    /// A verbatim, well-formed XML fragment with no first-class model case. Backs
    /// both the authoring escape hatch and full-fidelity ingestion (ADR-0057 §4/§6).
    /// @param RawXml The verbatim XML fragment.
    data class UnknownXmlElement(RawXml string) : DocInline, IEquatable[UnknownXmlElement] { }
}

/// A single item of a (cref:DocInline.List), modelling the XML
/// `<item><term>…</term><description>…</description></item>` shape.
/// @param Term The optional term content.
/// @param Description The description content.
data class DocListItem(Term ImmutableArray[DocInline], Description ImmutableArray[DocInline]) : IEquatable[
    DocListItem
] { }
