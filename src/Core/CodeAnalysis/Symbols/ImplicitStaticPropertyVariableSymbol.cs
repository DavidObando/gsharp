#nullable disable

// <copyright file="ImplicitStaticPropertyVariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// A binder-internal pseudo-variable representing a static property made
/// visible by name inside a method body of the enclosing type (ADR-0053 §5,
/// extended to instance methods so a class can use its shared properties
/// without the <c>TypeName.</c> prefix). Resolving a bare identifier
/// <c>X</c> to one of these triggers the binder to emit a
/// <c>BoundPropertyAccessExpression</c>/<c>BoundPropertyAssignmentExpression</c>
/// with a <c>null</c> receiver (static access). Never appears in the bound
/// tree itself.
/// </summary>
public sealed class ImplicitStaticPropertyVariableSymbol : VariableSymbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ImplicitStaticPropertyVariableSymbol"/> class.
    /// </summary>
    /// <param name="structType">The class that owns the static property.</param>
    /// <param name="property">The underlying static property.</param>
    public ImplicitStaticPropertyVariableSymbol(StructSymbol structType, PropertySymbol property)
        : base(property.Name, isReadOnly: !property.HasSetter, type: property.Type)
    {
        StructType = structType;
        Property = property;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.LocalVariable;

    /// <summary>Gets the class that owns the static property.</summary>
    public StructSymbol StructType { get; }

    /// <summary>Gets the static property symbol.</summary>
    public PropertySymbol Property { get; }
}
