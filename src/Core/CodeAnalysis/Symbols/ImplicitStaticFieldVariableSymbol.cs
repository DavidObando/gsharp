// <copyright file="ImplicitStaticFieldVariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// A binder-internal pseudo-variable representing a static field made
/// visible by name inside a shared method body (Issue #261 / ADR-0053).
/// Resolving a bare identifier <c>x</c> to one of these triggers the binder
/// to emit a <c>BoundFieldAccessExpression</c> with a <c>null</c> receiver
/// (static access). Never appears in the bound tree itself.
/// </summary>
public sealed class ImplicitStaticFieldVariableSymbol : VariableSymbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ImplicitStaticFieldVariableSymbol"/> class.
    /// </summary>
    /// <param name="structType">The class that owns the static field.</param>
    /// <param name="field">The underlying static field.</param>
    public ImplicitStaticFieldVariableSymbol(StructSymbol structType, FieldSymbol field)
        : base(field.Name, isReadOnly: field.IsReadOnly, type: field.Type)
    {
        StructType = structType;
        Field = field;
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="ImplicitStaticFieldVariableSymbol"/>
    /// class owned by an interface (ADR-0089 / issue #1030). Interface static
    /// fields have no <see cref="StructSymbol"/> owner; <see cref="StructType"/>
    /// stays <c>null</c> and the emitter resolves the field by symbol identity.
    /// </summary>
    /// <param name="interfaceType">The interface that owns the static field.</param>
    /// <param name="field">The underlying static field.</param>
    public ImplicitStaticFieldVariableSymbol(InterfaceSymbol interfaceType, FieldSymbol field)
        : base(field.Name, isReadOnly: field.IsReadOnly, type: field.Type)
    {
        InterfaceType = interfaceType;
        Field = field;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.LocalVariable;

    /// <summary>Gets the class that owns the static field, or <c>null</c> for an interface owner.</summary>
    public StructSymbol StructType { get; }

    /// <summary>Gets the interface that owns the static field (issue #1030), or <c>null</c> for a struct/class owner.</summary>
    public InterfaceSymbol InterfaceType { get; }

    /// <summary>Gets the display name of the owning type (struct/class or interface).</summary>
    public string OwnerName => StructType?.Name ?? InterfaceType?.Name ?? string.Empty;

    /// <summary>Gets the static field symbol.</summary>
    public FieldSymbol Field { get; }
}
