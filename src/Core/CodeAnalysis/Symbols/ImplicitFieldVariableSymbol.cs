#nullable disable

// <copyright file="ImplicitFieldVariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// A binder-internal pseudo-variable representing an instance field made
/// visible by name inside a class method body (Phase 3.B.3 sub-step 2b).
/// Resolving a bare identifier <c>X</c> to one of these triggers the binder
/// to emit a <c>BoundFieldAccessExpression</c> with the implicit
/// <c>this</c> receiver. Never appears in the bound tree itself.
/// </summary>
public sealed class ImplicitFieldVariableSymbol : VariableSymbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ImplicitFieldVariableSymbol"/> class.
    /// </summary>
    /// <param name="receiver">The implicit <c>this</c> parameter the field is read through.</param>
    /// <param name="structType">The class that owns the field.</param>
    /// <param name="field">The underlying field.</param>
    public ImplicitFieldVariableSymbol(ParameterSymbol receiver, StructSymbol structType, FieldSymbol field)
        : base(field.Name, isReadOnly: false, type: field.Type)
    {
        Receiver = receiver;
        StructType = structType;
        Field = field;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.LocalVariable;

    /// <summary>Gets the implicit receiver parameter (<c>this</c>) for the enclosing method.</summary>
    public ParameterSymbol Receiver { get; }

    /// <summary>Gets the class that owns the field.</summary>
    public StructSymbol StructType { get; }

    /// <summary>Gets the field symbol.</summary>
    public FieldSymbol Field { get; }
}
