// <copyright file="FieldSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a field declared on a user-defined struct (Phase 3.B.1).
/// </summary>
public sealed class FieldSymbol : Symbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="FieldSymbol"/> class.
    /// </summary>
    /// <param name="name">The field name.</param>
    /// <param name="type">The field type.</param>
    /// <param name="accessibility">The field accessibility.</param>
    /// <param name="isReadOnly">True when the field is init-only after construction.</param>
    public FieldSymbol(string name, TypeSymbol type, Accessibility accessibility, bool isReadOnly = false)
        : base(name)
    {
        Type = type;
        Accessibility = accessibility;
        IsReadOnly = isReadOnly;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.Field;

    /// <summary>Gets the field type.</summary>
    public TypeSymbol Type { get; }

    /// <summary>Gets the field accessibility.</summary>
    public Accessibility Accessibility { get; }

    /// <summary>Gets a value indicating whether this field is init-only after construction.</summary>
    public bool IsReadOnly { get; }
}
