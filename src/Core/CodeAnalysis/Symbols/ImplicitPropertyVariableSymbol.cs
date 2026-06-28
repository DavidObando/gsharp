#nullable disable

// <copyright file="ImplicitPropertyVariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// A binder-internal pseudo-variable representing an instance property made
/// visible by name inside a class method body.
/// Resolving a bare identifier <c>Name</c> to one of these triggers the binder
/// to emit a <c>BoundPropertyAccessExpression</c> with the implicit
/// <c>this</c> receiver. Never appears in the bound tree itself.
/// </summary>
public sealed class ImplicitPropertyVariableSymbol : VariableSymbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ImplicitPropertyVariableSymbol"/> class.
    /// </summary>
    /// <param name="receiver">The implicit <c>this</c> parameter the property is accessed through.</param>
    /// <param name="structType">The class that owns the property.</param>
    /// <param name="property">The underlying property.</param>
    public ImplicitPropertyVariableSymbol(ParameterSymbol receiver, StructSymbol structType, PropertySymbol property)
        : base(property.Name, isReadOnly: !property.HasSetter, type: property.Type)
    {
        Receiver = receiver;
        StructType = structType;
        Property = property;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.LocalVariable;

    /// <summary>Gets the implicit receiver parameter (<c>this</c>) for the enclosing method.</summary>
    public ParameterSymbol Receiver { get; }

    /// <summary>Gets the class that owns the property.</summary>
    public StructSymbol StructType { get; }

    /// <summary>Gets the property symbol.</summary>
    public PropertySymbol Property { get; }
}
