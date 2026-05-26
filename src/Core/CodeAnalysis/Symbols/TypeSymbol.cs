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
    /// The `byte` symbol (8-bit unsigned integer, <c>System.Byte</c>). Added by ADR-0044.
    /// </summary>
    public static readonly TypeSymbol Byte = new TypeSymbol("byte", typeof(byte));

    /// <summary>
    /// The `sbyte` symbol (8-bit signed integer, <c>System.SByte</c>). Added by ADR-0044.
    /// </summary>
    public static readonly TypeSymbol SByte = new TypeSymbol("sbyte", typeof(sbyte));

    /// <summary>
    /// The `short` symbol (16-bit signed integer, <c>System.Int16</c>). Added by ADR-0044.
    /// </summary>
    public static readonly TypeSymbol Short = new TypeSymbol("short", typeof(short));

    /// <summary>
    /// The `ushort` symbol (16-bit unsigned integer, <c>System.UInt16</c>). Added by ADR-0044.
    /// </summary>
    public static readonly TypeSymbol UShort = new TypeSymbol("ushort", typeof(ushort));

    /// <summary>
    /// The `int` symbol.
    /// </summary>
    public static readonly TypeSymbol Int = new TypeSymbol("int", typeof(int));

    /// <summary>
    /// The `uint` symbol (32-bit unsigned integer, <c>System.UInt32</c>). Added by ADR-0044.
    /// </summary>
    public static readonly TypeSymbol UInt = new TypeSymbol("uint", typeof(uint));

    /// <summary>
    /// The `long` symbol (64-bit signed integer, <c>System.Int64</c>). Added by ADR-0044.
    /// </summary>
    public static readonly TypeSymbol Long = new TypeSymbol("long", typeof(long));

    /// <summary>
    /// The `ulong` symbol (64-bit unsigned integer, <c>System.UInt64</c>). Added by ADR-0044.
    /// </summary>
    public static readonly TypeSymbol ULong = new TypeSymbol("ulong", typeof(ulong));

    /// <summary>
    /// The `nint` symbol (native-width signed integer, <c>System.IntPtr</c>). Added by ADR-0044.
    /// </summary>
    public static readonly TypeSymbol NInt = new TypeSymbol("nint", typeof(nint));

    /// <summary>
    /// The `nuint` symbol (native-width unsigned integer, <c>System.UIntPtr</c>). Added by ADR-0044.
    /// </summary>
    public static readonly TypeSymbol NUInt = new TypeSymbol("nuint", typeof(nuint));

    /// <summary>
    /// The `float32` symbol (IEEE 754 binary32, <c>System.Single</c>). Added by ADR-0044.
    /// </summary>
    public static readonly TypeSymbol Float32 = new TypeSymbol("float32", typeof(float));

    /// <summary>
    /// The `float64` symbol (IEEE 754 binary64, <c>System.Double</c>). Added by ADR-0044.
    /// </summary>
    public static readonly TypeSymbol Float64 = new TypeSymbol("float64", typeof(double));

    /// <summary>
    /// The `decimal` symbol (128-bit base-10, <c>System.Decimal</c>). Added by ADR-0044.
    /// </summary>
    public static readonly TypeSymbol Decimal = new TypeSymbol("decimal", typeof(decimal));

    /// <summary>
    /// The `char` symbol (UTF-16 code unit, <c>System.Char</c>). Added by ADR-0044.
    /// </summary>
    public static readonly TypeSymbol Char = new TypeSymbol("char", typeof(char));

    /// <summary>
    /// The `string` symbol.
    /// </summary>
    public static readonly TypeSymbol String = new TypeSymbol("string", typeof(string));

    /// <summary>
    /// The `object` symbol (universal upper bound, <c>System.Object</c>). Added by ADR-0044 / ADR-0045.
    /// </summary>
    public static readonly TypeSymbol Object = new TypeSymbol("object", typeof(object));

    /// <summary>
    /// The void type symbol.
    /// </summary>
    public static readonly TypeSymbol Void = new TypeSymbol("void", typeof(void));

    /// <summary>The static type of the <c>nil</c> literal (Phase 3.C.2 / ADR-0001). Implicitly convertible to any <see cref="NullableTypeSymbol"/>; not assignable to a non-nullable type.</summary>
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

        // Phase 3.C.5 / ADR-0001: surface CLR value-type nullability
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
        switch (fullName)
        {
            case "System.Boolean":
                return Bool;
            case "System.Byte":
                return Byte;
            case "System.SByte":
                return SByte;
            case "System.Int16":
                return Short;
            case "System.UInt16":
                return UShort;
            case "System.Int32":
                return Int;
            case "System.UInt32":
                return UInt;
            case "System.Int64":
                return Long;
            case "System.UInt64":
                return ULong;
            case "System.IntPtr":
                return NInt;
            case "System.UIntPtr":
                return NUInt;
            case "System.Single":
                return Float32;
            case "System.Double":
                return Float64;
            case "System.Decimal":
                return Decimal;
            case "System.Char":
                return Char;
            case "System.String":
                return String;
            case "System.Object":
                return Object;
            case "System.Void":
                return Void;
        }

        return ImportedTypeSymbol.Get(clrType);
    }
}
