// <copyright file="EventSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents an event declared on a user-defined type (ADR-0052).
/// </summary>
public sealed class EventSymbol : Symbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="EventSymbol"/> class.
    /// </summary>
    /// <param name="name">The event name.</param>
    /// <param name="type">The event handler type (should be a FunctionTypeSymbol).</param>
    /// <param name="accessibility">The event accessibility.</param>
    /// <param name="isFieldLike">Whether this is a field-like event (no explicit accessors).</param>
    /// <param name="isVirtual">Whether this event is virtual (open modifier present).</param>
    /// <param name="isOverride">Whether this event overrides a base event.</param>
    public EventSymbol(
        string name,
        TypeSymbol type,
        Accessibility accessibility,
        bool isFieldLike,
        bool isVirtual,
        bool isOverride)
        : base(name)
    {
        Type = type;
        Accessibility = accessibility;
        IsFieldLike = isFieldLike;
        IsVirtual = isVirtual;
        IsOverride = isOverride;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.Event;

    /// <summary>Gets the event handler type.</summary>
    public TypeSymbol Type { get; }

    /// <summary>Gets the event accessibility.</summary>
    public Accessibility Accessibility { get; }

    /// <summary>Gets a value indicating whether this is a field-like event (no explicit accessors).</summary>
    public bool IsFieldLike { get; }

    /// <summary>Gets a value indicating whether this event is virtual (open modifier present).</summary>
    public bool IsVirtual { get; }

    /// <summary>Gets a value indicating whether this event overrides a base event.</summary>
    public bool IsOverride { get; }

    /// <summary>Gets or sets the synthesized backing delegate field (null for explicit accessors).</summary>
    public FieldSymbol BackingField { get; set; }

    /// <summary>Gets or sets the synthesized add method symbol.</summary>
    public FunctionSymbol AddMethodSymbol { get; set; }

    /// <summary>Gets or sets the synthesized remove method symbol.</summary>
    public FunctionSymbol RemoveMethodSymbol { get; set; }

    /// <summary>Gets or sets the explicit add body syntax (null for field-like events).</summary>
    public Syntax.BlockStatementSyntax AddBodySyntax { get; set; }

    /// <summary>Gets or sets the explicit remove body syntax (null for field-like events).</summary>
    public Syntax.BlockStatementSyntax RemoveBodySyntax { get; set; }
}
