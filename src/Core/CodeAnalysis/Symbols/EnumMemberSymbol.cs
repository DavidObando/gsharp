// <copyright file="EnumMemberSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a member declared by a user-defined enum.
/// </summary>
public sealed class EnumMemberSymbol : Symbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="EnumMemberSymbol"/> class.
    /// </summary>
    /// <param name="name">The enum member name.</param>
    /// <param name="enumType">The owning enum type.</param>
    /// <param name="value">The auto-numbered integer value.</param>
    public EnumMemberSymbol(string name, EnumSymbol enumType, int value)
        : base(name)
    {
        EnumType = enumType;
        Value = value;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.EnumMember;

    /// <summary>Gets the owning enum type.</summary>
    public EnumSymbol EnumType { get; }

    /// <summary>Gets the auto-numbered integer value.</summary>
    public int Value { get; }
}
