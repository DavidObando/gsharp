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
    /// The `uint8` symbol (8-bit unsigned integer, <c>System.Byte</c>). Renamed from `byte` by ADR-0049.
    /// </summary>
    public static readonly TypeSymbol UInt8 = new TypeSymbol("uint8", typeof(byte));

    /// <summary>
    /// The `int8` symbol (8-bit signed integer, <c>System.SByte</c>). Renamed from `sbyte` by ADR-0049.
    /// </summary>
    public static readonly TypeSymbol Int8 = new TypeSymbol("int8", typeof(sbyte));

    /// <summary>
    /// The `int16` symbol (16-bit signed integer, <c>System.Int16</c>). Renamed from `short` by ADR-0049.
    /// </summary>
    public static readonly TypeSymbol Int16 = new TypeSymbol("int16", typeof(short));

    /// <summary>
    /// The `uint16` symbol (16-bit unsigned integer, <c>System.UInt16</c>). Renamed from `ushort` by ADR-0049.
    /// </summary>
    public static readonly TypeSymbol UInt16 = new TypeSymbol("uint16", typeof(ushort));

    /// <summary>
    /// The `int32` symbol (32-bit signed integer, <c>System.Int32</c>). Renamed from `int` by ADR-0049.
    /// </summary>
    public static readonly TypeSymbol Int32 = new TypeSymbol("int32", typeof(int));

    /// <summary>
    /// The `uint32` symbol (32-bit unsigned integer, <c>System.UInt32</c>). Renamed from `uint` by ADR-0049.
    /// </summary>
    public static readonly TypeSymbol UInt32 = new TypeSymbol("uint32", typeof(uint));

    /// <summary>
    /// The `int64` symbol (64-bit signed integer, <c>System.Int64</c>). Renamed from `long` by ADR-0049.
    /// </summary>
    public static readonly TypeSymbol Int64 = new TypeSymbol("int64", typeof(long));

    /// <summary>
    /// The `uint64` symbol (64-bit unsigned integer, <c>System.UInt64</c>). Renamed from `ulong` by ADR-0049.
    /// </summary>
    public static readonly TypeSymbol UInt64 = new TypeSymbol("uint64", typeof(ulong));

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
                return UInt8;
            case "System.SByte":
                return Int8;
            case "System.Int16":
                return Int16;
            case "System.UInt16":
                return UInt16;
            case "System.Int32":
                return Int32;
            case "System.UInt32":
                return UInt32;
            case "System.Int64":
                return Int64;
            case "System.UInt64":
                return UInt64;
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

    /// <summary>
    /// #313: returns <c>true</c> if <paramref name="type"/> is, or structurally
    /// contains, an in-scope generic <see cref="TypeParameterSymbol"/> (e.g.
    /// <c>T</c>, <c>T?</c>, <c>[]T</c>, or <c>List[T]</c>). Such a type is an
    /// open/partially-constructed generic whose emit form is type-erased to
    /// <c>System.Object</c> under the type-erased generic model (ADR-0004).
    /// </summary>
    /// <param name="type">The type to inspect.</param>
    /// <returns><c>true</c> if the type references an in-scope type parameter.</returns>
    public static bool ContainsTypeParameter(TypeSymbol type)
    {
        switch (type)
        {
            case null:
                return false;
            case TypeParameterSymbol:
                return true;
            case NullableTypeSymbol n:
                return ContainsTypeParameter(n.UnderlyingType);
            case SliceTypeSymbol s:
                return ContainsTypeParameter(s.ElementType);
            case ArrayTypeSymbol a:
                return ContainsTypeParameter(a.ElementType);
            case MapTypeSymbol m:
                return ContainsTypeParameter(m.KeyType) || ContainsTypeParameter(m.ValueType);
            case ImportedTypeSymbol it when !it.TypeArguments.IsDefaultOrEmpty:
                foreach (var arg in it.TypeArguments)
                {
                    if (ContainsTypeParameter(arg))
                    {
                        return true;
                    }
                }

                return false;
            default:
                return false;
        }
    }
}
