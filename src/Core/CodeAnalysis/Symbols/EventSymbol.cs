// <copyright file="EventSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

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
    /// <param name="isStatic">Whether this event is declared inside a <c>shared</c> block (ADR-0053).</param>
    /// <param name="declaration">The declaring syntax node, or <see langword="null"/> for synthesized events.</param>
    public EventSymbol(
        string name,
        TypeSymbol type,
        Accessibility accessibility,
        bool isFieldLike,
        bool isVirtual,
        bool isOverride,
        bool isStatic = false,
        EventDeclarationSyntax declaration = null)
        : base(name)
    {
        Type = type;
        Accessibility = accessibility;
        IsFieldLike = isFieldLike;
        IsVirtual = isVirtual;
        IsOverride = isOverride;
        IsStatic = isStatic;
        Declaration = declaration;
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

    /// <summary>Gets a value indicating whether this event is declared inside a <c>shared</c> block (ADR-0053).</summary>
    public bool IsStatic { get; }

    /// <summary>Gets the declaring syntax node, or <see langword="null"/> for synthesized events.</summary>
    public EventDeclarationSyntax Declaration { get; }

    /// <summary>Gets or sets the synthesized backing delegate field (null for explicit accessors).</summary>
    public FieldSymbol BackingField { get; set; }

    /// <summary>Gets or sets the synthesized add method symbol.</summary>
    public FunctionSymbol AddMethodSymbol { get; set; }

    /// <summary>Gets or sets the synthesized remove method symbol.</summary>
    public FunctionSymbol RemoveMethodSymbol { get; set; }

    /// <summary>Gets or sets the synthesized raise method symbol (issue #257). Null when no <c>raise</c> accessor is declared.</summary>
    public FunctionSymbol RaiseMethodSymbol { get; set; }

    /// <summary>Gets or sets the explicit add body syntax (null for field-like events).</summary>
    public Syntax.BlockStatementSyntax AddBodySyntax { get; set; }

    /// <summary>Gets or sets the explicit remove body syntax (null for field-like events).</summary>
    public Syntax.BlockStatementSyntax RemoveBodySyntax { get; set; }

    /// <summary>Gets or sets the explicit raise body syntax (issue #257). Null when no <c>raise</c> accessor is declared.</summary>
    public Syntax.BlockStatementSyntax RaiseBodySyntax { get; set; }
}
