// <copyright file="TypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a type symbol in the language.
/// </summary>
public class TypeSymbol : Symbol
{
    /// <summary>
    /// The type error symbol.
    /// </summary>
    public static readonly TypeSymbol Error = new TypeSymbol("?");

    /// <summary>
    /// The `bool` symbol.
    /// </summary>
    public static readonly TypeSymbol Bool = new TypeSymbol("bool", typeof(bool));

    /// <summary>
    /// The `int` symbol.
    /// </summary>
    public static readonly TypeSymbol Int = new TypeSymbol("int", typeof(int));

    /// <summary>
    /// The `string` symbol.
    /// </summary>
    public static readonly TypeSymbol String = new TypeSymbol("string", typeof(string));

    /// <summary>
    /// The void type symbol.
    /// </summary>
    public static readonly TypeSymbol Void = new TypeSymbol("void", typeof(void));

    /// <summary>The static type of the <c>nil</c> literal (Phase 3.C.2 / ADR-0020). Implicitly convertible to any <see cref="NullableTypeSymbol"/>; not assignable to a non-nullable type.</summary>
    public static readonly TypeSymbol Null = new TypeSymbol("nil");

    private protected TypeSymbol(string name)
        : base(name)
    {
    }

    private protected TypeSymbol(string name, Type clrType)
        : base(name)
    {
        ClrType = clrType;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.Type;

    /// <summary>
    /// Gets the underlying CLR type for this symbol, if any.
    /// </summary>
    public Type ClrType { get; }

    /// <summary>
    /// Maps a CLR <see cref="Type"/> to the corresponding built-in <see cref="TypeSymbol"/>,
    /// or wraps it in an <see cref="ImportedTypeSymbol"/> if it is not built-in.
    /// </summary>
    /// <param name="clrType">The CLR type to map.</param>
    /// <returns>The corresponding <see cref="TypeSymbol"/>.</returns>
    public static TypeSymbol FromClrType(Type clrType)
    {
        if (clrType == null)
        {
            return Void;
        }

        // Phase 3.C.5 / ADR-0020: surface CLR value-type nullability
        // (`Nullable<T>` aka `T?` in C#) as a GSharp `NullableTypeSymbol`
        // wrapping the underlying. Reference-type nullability driven by
        // `[NullableAttribute]` byte arrays is a follow-up.
        if (clrType.IsGenericType && !clrType.IsGenericTypeDefinition)
        {
            var def = clrType.GetGenericTypeDefinition();
            if (def.FullName == "System.Nullable`1")
            {
                var inner = clrType.GetGenericArguments()[0];
                return NullableTypeSymbol.Get(FromClrType(inner));
            }
        }

        // Compare by FullName so types loaded from a MetadataLoadContext (carrying the
        // target framework's identity) still map onto the built-in primitive symbols.
        var fullName = clrType.FullName;
        if (fullName == "System.Boolean")
        {
            return Bool;
        }

        if (fullName == "System.Int32")
        {
            return Int;
        }

        if (fullName == "System.String")
        {
            return String;
        }

        if (fullName == "System.Void")
        {
            return Void;
        }

        return ImportedTypeSymbol.Get(clrType);
    }
}
