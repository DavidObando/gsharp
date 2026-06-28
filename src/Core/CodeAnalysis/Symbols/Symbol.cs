#nullable disable

// <copyright file="Symbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.IO;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Documentation;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a symbol in the language.
/// </summary>
public abstract class Symbol
{
    private DocumentationComment authoredDocumentation;

    /// <summary>
    /// Initializes a new instance of the <see cref="Symbol"/> class.
    /// </summary>
    /// <param name="name">The symbol name.</param>
    private protected Symbol(string name)
    {
        Name = name;
    }

    /// <summary>
    /// Gets the kind of symbol this instance represents.
    /// </summary>
    public abstract SymbolKind Kind { get; }

    /// <summary>
    /// Gets the name of the symbol.
    /// </summary>
    public string Name { get; }

    /// <summary>
    /// Gets the user-written attributes attached to this symbol per ADR-0047.
    /// Defaults to empty; populated by the binder during declaration binding.
    /// </summary>
    public ImmutableArray<BoundAttribute> Attributes { get; private set; } = ImmutableArray<BoundAttribute>.Empty;

    /// <summary>
    /// Writes the symbol to the specified text writer.
    /// </summary>
    /// <param name="writer">The writer to write the symbol to.</param>
    public void WriteTo(TextWriter writer)
    {
        SymbolPrinter.WriteTo(this, writer);
    }

    /// <summary>
    /// Gives a string representation of this symbol.
    /// </summary>
    /// <returns>A string representation of the symbol.</returns>
    public override string ToString()
    {
        using (var writer = new StringWriter())
        {
            WriteTo(writer);
            return writer.ToString();
        }
    }

    /// <summary>
    /// Gets the structured documentation for this symbol (ADR-0057 §4), or
    /// <see langword="null"/> when the symbol is undocumented. The default returns the
    /// authored documentation set by the binder (G# symbols); imported CLR symbols
    /// override this to resolve documentation from the ingested <c>.xml</c> on demand.
    /// </summary>
    /// <returns>The documentation comment, or <see langword="null"/> when undocumented.</returns>
    public virtual DocumentationComment GetDocumentation()
    {
        return this.authoredDocumentation;
    }

    /// <summary>
    /// Sets the bound-attribute list for this symbol. Called by the binder
    /// once attribute resolution for the owning declaration completes.
    /// </summary>
    /// <param name="attributes">The bound attributes to attach.</param>
    internal void SetAttributes(ImmutableArray<BoundAttribute> attributes)
    {
        Attributes = attributes;
    }

    /// <summary>
    /// Attaches authored documentation parsed from a G# doc comment. Called by the
    /// binder once the owning declaration's doc block is parsed into the model.
    /// </summary>
    /// <param name="documentation">The parsed documentation comment.</param>
    internal void SetDocumentation(DocumentationComment documentation)
    {
        this.authoredDocumentation = documentation;
    }
}
