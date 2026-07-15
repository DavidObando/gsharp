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
    public EventDeclarationSyntax Declaration { get; private set; }

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

    /// <summary>
    /// Gets or sets the in-compilation (G#) interface member this event
    /// explicitly implements (ADR-0148, generalizing the #2010/#2362
    /// explicit-interface convention from methods/properties to events for
    /// the first time). Set when the event carries a dedicated
    /// explicit-interface qualifier clause (<c>event (IFoo) Changed T</c>,
    /// ADR-0148) whose bound interface type —
    /// see <see cref="ExplicitInterfaceClauseTarget"/> — declares a member
    /// with this event's own plain name and a matching handler type. Mirrors
    /// <see cref="PropertySymbol.ExplicitInterfaceMember"/>: the emitter
    /// resolves this event's add/remove accessor methods to a MethodDef or
    /// (for a constructed generic interface) a MemberRef/TypeSpec token and
    /// binds a <c>MethodImpl</c> row per accessor so the CLR routes interface
    /// dispatch to this event's own distinct accessor bodies. Defaults to
    /// <see langword="null"/> for ordinary events.
    /// </summary>
    public EventSymbol ExplicitInterfaceMember { get; set; }

    /// <summary>
    /// Gets a value indicating whether this event's declaration carries a
    /// dedicated explicit-interface qualifier clause (ADR-0148) — a purely
    /// syntactic fact known immediately at declaration time, before
    /// <see cref="ExplicitInterfaceClauseTarget"/> is resolved against the
    /// containing type's implemented interfaces.
    /// </summary>
    public bool HasExplicitInterfaceClause => Declaration?.HasExplicitInterfaceClause == true;

    /// <summary>
    /// Gets or sets the <see cref="InterfaceSymbol"/> the explicit-interface
    /// qualifier clause (<see cref="HasExplicitInterfaceClause"/>) resolves
    /// to, bound by <see cref="Binding.DeclarationBinder.ResolveExplicitInterfaceClauses"/>.
    /// <c>null</c> until resolved.
    /// </summary>
    public InterfaceSymbol ExplicitInterfaceClauseTarget { get; set; }

    /// <summary>
    /// ADR-0105 Phase 2 — re-points this (reused) event at the declaration node
    /// of a freshly-parsed syntax tree whose event signature and accessor shape
    /// are byte-identical to the previous one (a body-only edit). The caller is
    /// responsible for re-pointing <see cref="AddBodySyntax"/>,
    /// <see cref="RemoveBodySyntax"/> and <see cref="RaiseBodySyntax"/> at the
    /// corresponding accessor bodies in the re-parsed tree. The symbol's identity
    /// (including the add/remove/raise method symbols) is preserved so
    /// cross-compilation reuse stays sound. Intended to be called only by
    /// <see cref="Binding.IncrementalGlobalScopeReuse"/>.
    /// </summary>
    /// <param name="declaration">The corresponding declaration in the re-parsed tree.</param>
    internal void RepointDeclaration(EventDeclarationSyntax declaration)
    {
        Declaration = declaration;
    }
}
