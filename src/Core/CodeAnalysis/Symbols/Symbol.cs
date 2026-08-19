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
    private DocumentationComment? authoredDocumentation;

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
    /// Gets the syntax nodes that declare this symbol in source, or empty for
    /// symbols with no source declaration (imported CLR symbols, synthesized
    /// symbols). The analyzer framework's counterpart to Roslyn's
    /// <c>DeclaringSyntaxReferences</c> (ADR-0169).
    /// </summary>
    public virtual ImmutableArray<Syntax.SyntaxNode> DeclaringSyntaxNodes => ImmutableArray<Syntax.SyntaxNode>.Empty;

    /// <summary>
    /// Gets the source locations of this symbol's declarations — the Roslyn
    /// <c>Locations</c> analogue (ADR-0169). Empty for symbols with no source
    /// declaration.
    /// </summary>
    public ImmutableArray<Text.TextLocation> Locations
    {
        get
        {
            var declarations = DeclaringSyntaxNodes;
            if (declarations.IsEmpty)
            {
                return ImmutableArray<Text.TextLocation>.Empty;
            }

            var builder = ImmutableArray.CreateBuilder<Text.TextLocation>(declarations.Length);
            foreach (var declaration in declarations)
            {
                builder.Add(declaration.Location);
            }

            return builder.MoveToImmutable();
        }
    }

    /// <summary>
    /// Gets a value indicating whether this symbol was synthesized by the
    /// compiler rather than declared in source — the Roslyn
    /// <c>IsImplicitlyDeclared</c> analogue (ADR-0169), approximated by G#'s
    /// compiler-generated name convention (a leading <c>&lt;</c>).
    /// </summary>
    public virtual bool IsImplicitlyDeclared => Name.StartsWith("<", System.StringComparison.Ordinal);

    /// <summary>
    /// Gets the first declaration location, or a default (location-less)
    /// <see cref="Text.TextLocation"/> for symbols with no source declaration.
    /// The struct-friendly target for Roslyn's
    /// <c>Locations.Length &gt; 0 ? Locations[0] : null</c> idiom (ADR-0169).
    /// </summary>
    public Text.TextLocation Location
        => DeclaringSyntaxNodes is { IsEmpty: false } declarations ? declarations[0].Location : default;

    /// <summary>
    /// Gets the type that declares this member, or <see langword="null"/> for
    /// top-level symbols — the Roslyn <c>ContainingType</c> analogue
    /// (ADR-0169). Populated fill-once when symbols surface through the
    /// analyzer driver or a <see cref="SemanticModel"/>; symbols observed
    /// outside those surfaces may report null.
    /// </summary>
    public TypeSymbol? ContainingType { get; private protected set; }

    /// <summary>
    /// Gets the display name of the package (namespace) this symbol lives in,
    /// or <see langword="null"/> when unknown — the string-valued counterpart
    /// of Roslyn's <c>ContainingNamespace.ToDisplayString()</c> idiom
    /// (ADR-0169).
    /// </summary>
    public virtual string? ContainingNamespace => ContainingType?.ContainingNamespace;

    /// <summary>
    /// Renders this symbol in the requested format — the Roslyn
    /// <c>ToDisplayString(SymbolDisplayFormat)</c> analogue (ADR-0169).
    /// <see cref="DisplayFormat.FullyQualified"/> mirrors Roslyn's
    /// fully-qualified format, including the <c>global::</c> prefix, so
    /// string comparisons in migrated analyzers carry over verbatim.
    /// </summary>
    /// <param name="format">The rendering format.</param>
    /// <returns>The rendered symbol name.</returns>
    public virtual string ToDisplayString(DisplayFormat format)
        => format == DisplayFormat.FullyQualified && ContainingNamespace is { Length: > 0 } ns
            ? $"global::{ns}.{Name}"
            : Name;

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
    public virtual DocumentationComment? GetDocumentation()
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

    /// <summary>
    /// Anchors this symbol to its declaring type if it has none yet
    /// (idempotent, mirroring <c>BoundNode.AnchorSyntax</c>).
    /// </summary>
    /// <param name="containingType">The declaring type.</param>
    internal void AnchorContainingType(TypeSymbol containingType)
    {
        if (ContainingType is null)
        {
            ContainingType = containingType;
        }
    }
}
