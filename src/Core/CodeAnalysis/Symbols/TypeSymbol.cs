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

    /// <summary>
    /// Issue #1018: the bottom ("never") type of a <c>throw</c> expression. A
    /// throw-expression never produces a value (it always transfers control via
    /// CIL <c>throw</c>), so its static type is implicitly convertible to ANY
    /// target type. <c>Conversion.Classify</c> treats it as an implicit
    /// conversion source, and the conditional/null-coalesce common-type logic
    /// resolves to the sibling operand's type.
    /// </summary>
    public static readonly TypeSymbol Never = new TypeSymbol("never");

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
        if (NullableLifting.IsValueTypeNullableClr(clrType))
        {
            var inner = clrType.GetGenericArguments()[0];
            return NullableTypeSymbol.Get(FromClrType(inner));
        }

        if (clrType.IsPointer)
        {
            return PointerTypeSymbol.Get(FromClrType(clrType.GetElementType()));
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
    /// Issue #367: returns <c>true</c> when <paramref name="type"/> denotes a
    /// by-ref-like (<c>ref struct</c>) type. This covers both imported CLR types
    /// such as <c>Span[T]</c>, <c>ReadOnlySpan[T]</c>, or
    /// <c>DefaultInterpolatedStringHandler</c> (detected via
    /// <c>System.Runtime.CompilerServices.IsByRefLikeAttribute</c>) and
    /// user-declared <c>ref struct</c> types (<see cref="StructSymbol.IsRefStruct"/>)
    /// that have no CLR type yet because they are being compiled. These values are
    /// stack-only and may not escape to the heap (no boxing, no field of a
    /// non-ref-struct, no closure capture, no async/iterator hoisting, and no use
    /// as a generic type argument). A <see cref="NullableTypeSymbol"/> wrapper is
    /// unwrapped first so <c>Span[T]?</c> is still recognised.
    /// </summary>
    /// <param name="type">The type to inspect.</param>
    /// <returns><c>true</c> if the type is by-ref-like.</returns>
    public static bool IsByRefLike(TypeSymbol type)
    {
        var unwrapped = type is NullableTypeSymbol nullable ? nullable.UnderlyingType : type;
        if (unwrapped is StructSymbol { IsRefStruct: true })
        {
            return true;
        }

        return unwrapped?.ClrType != null && ClrTypeUtilities.IsByRefLike(unwrapped.ClrType);
    }

    /// <summary>
    /// ADR-0122 / issue #1014. Returns the pointee (element) type when
    /// <paramref name="type"/> is either a managed by-ref pointer
    /// (<see cref="ByRefTypeSymbol"/>, <c>T&amp;</c>) or an unmanaged raw pointer
    /// (<see cref="PointerTypeSymbol"/>, <c>T*</c>). Several pointer operations
    /// (dereference, indirect assignment, indexing, address-of) share an IL
    /// shape across both pointer kinds; this helper lets them treat the two
    /// uniformly while the type system keeps them distinct.
    /// </summary>
    /// <param name="type">The candidate pointer type.</param>
    /// <param name="pointee">The pointee type when the method returns <c>true</c>.</param>
    /// <returns><c>true</c> when <paramref name="type"/> is a managed or unmanaged pointer.</returns>
    public static bool TryGetPointeeType(TypeSymbol type, out TypeSymbol pointee)
    {
        switch (type)
        {
            case ByRefTypeSymbol byRef:
                pointee = byRef.PointeeType;
                return true;
            case PointerTypeSymbol ptr:
                pointee = ptr.PointeeType;
                return true;
            default:
                pointee = null;
                return false;
        }
    }

    /// <summary>
    /// ADR-0122 / issue #1014. Returns whether <paramref name="type"/> is an
    /// unmanaged raw pointer (<see cref="PointerTypeSymbol"/>, CLR
    /// <c>ELEMENT_TYPE_PTR</c>).
    /// </summary>
    /// <param name="type">The type to inspect.</param>
    /// <returns><c>true</c> when the type is an unmanaged pointer.</returns>
    public static bool IsUnmanagedPointer(TypeSymbol type) => type is PointerTypeSymbol;

    /// <summary>
    /// ADR-0122 §3 / issue #1033. Returns whether <paramref name="type"/> is a
    /// true <c>void</c>-element unmanaged pointer (<c>*void</c>, CLR
    /// <c>ELEMENT_TYPE_PTR</c> over <c>ELEMENT_TYPE_VOID</c>) — the faithful
    /// mapping of C# <c>void*</c>, distinct from the byte pointer <c>*uint8</c>.
    /// A <c>*void</c> carries no element type: it may be round-tripped through
    /// <c>nint</c>/<c>IntPtr</c> and cast to/from a typed pointer <c>*T</c>, but
    /// it may not be directly dereferenced, indexed, or used in pointer
    /// arithmetic (those require a cast to a typed pointer first).
    /// </summary>
    /// <param name="type">The type to inspect.</param>
    /// <returns><c>true</c> when the type is the void-element pointer <c>*void</c>.</returns>
    public static bool IsVoidPointer(TypeSymbol type) => type is PointerTypeSymbol { PointeeType: var pointee } && pointee == Void;

    /// <summary>
    /// ADR-0122 / issue #1014. Returns whether <paramref name="type"/> is a
    /// legal pointee for an unmanaged pointer in the supported core subset: a
    /// blittable primitive (<c>int8</c>…<c>int64</c>, <c>uint8</c>…<c>uint64</c>,
    /// <c>nint</c>/<c>nuint</c>, <c>float32</c>/<c>float64</c>) or another
    /// unmanaged pointer (pointer-to-pointer). Pointers to arbitrary managed
    /// types are out of scope and rejected by the binder.
    /// </summary>
    /// <param name="type">The candidate pointee type.</param>
    /// <returns><c>true</c> when the type is a legal unmanaged pointee.</returns>
    public static bool IsLegalPointeeType(TypeSymbol type)
    {
        if (type is PointerTypeSymbol)
        {
            return true;
        }

        return type == Int8 || type == UInt8 || type == Int16 || type == UInt16
            || type == Int32 || type == UInt32 || type == Int64 || type == UInt64
            || type == NInt || type == NUInt || type == Float32 || type == Float64
            || type == Bool || type == Char;
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
            case FunctionTypeSymbol fn:
                foreach (var param in fn.ParameterTypes)
                {
                    if (ContainsTypeParameter(param))
                    {
                        return true;
                    }
                }

                return ContainsTypeParameter(fn.ReturnType);
            case ImportedTypeSymbol it when !it.TypeArguments.IsDefaultOrEmpty:
                foreach (var arg in it.TypeArguments)
                {
                    if (ContainsTypeParameter(arg))
                    {
                        return true;
                    }
                }

                return false;
            case TupleTypeSymbol tup:
                // Issue #813: value-tuple element types must propagate
                // "contains type parameter" so callers like
                // `ImportedTypeSymbol.HasTypeParameterArgument` route a
                // wrapping `IEnumerable[(int32, T)]` through the
                // type-spec encoder instead of falling back to the
                // type-erased `IEnumerable<object>` shape.
                foreach (var elem in tup.ElementTypes)
                {
                    if (ContainsTypeParameter(elem))
                    {
                        return true;
                    }
                }

                return false;
            default:
                return false;
        }
    }

    /// <summary>
    /// Issue #903: returns <c>true</c> when <paramref name="type"/> is, or
    /// structurally contains, a user-defined type declared in the
    /// <em>current compilation</em> that has no CLR backing yet (its
    /// <see cref="ClrType"/> is <see langword="null"/> because the type is
    /// still being compiled) — a <see cref="StructSymbol"/> (struct or class),
    /// <see cref="EnumSymbol"/>, <see cref="InterfaceSymbol"/>, or
    /// <see cref="DelegateTypeSymbol"/>.
    /// <para>
    /// Such a type is erased to <c>System.Object</c> (or its CLR ride-through)
    /// during reflection-based overload resolution, which loses its symbolic
    /// identity. This predicate is the same-compilation sibling of
    /// <see cref="ContainsTypeParameter"/>: it lets the binder recognise when a
    /// symbolic projection (recovered from a receiver's
    /// <see cref="ImportedTypeSymbol.TypeArguments"/>) carries information the
    /// type-erased closed CLR shape cannot represent, so the projection must be
    /// surfaced instead of the erased reflection result. This is what makes
    /// <c>List[Check].Single((c) -&gt; c.Id == "x")</c> and
    /// <c>List[Check].Select((c) -&gt; c.Id)</c> recover the real
    /// <c>Check</c> element type for both the lambda parameter and the call's
    /// return type.
    /// </para>
    /// <para>
    /// In-scope generic <see cref="TypeParameterSymbol"/>s (already covered by
    /// <see cref="ContainsTypeParameter"/>) are intentionally excluded here.
    /// </para>
    /// </summary>
    /// <param name="type">The type to inspect.</param>
    /// <returns><c>true</c> if the type references a same-compilation user type without CLR backing.</returns>
    public static bool ContainsSameCompilationUserType(TypeSymbol type)
    {
        switch (type)
        {
            case null:
                return false;
            case TypeParameterSymbol:
                return false;
            case NullableTypeSymbol n:
                return ContainsSameCompilationUserType(n.UnderlyingType);
            case SliceTypeSymbol s:
                return ContainsSameCompilationUserType(s.ElementType);
            case ArrayTypeSymbol a:
                return ContainsSameCompilationUserType(a.ElementType);
            case MapTypeSymbol m:
                return ContainsSameCompilationUserType(m.KeyType) || ContainsSameCompilationUserType(m.ValueType);
            case FunctionTypeSymbol fn:
                foreach (var param in fn.ParameterTypes)
                {
                    if (ContainsSameCompilationUserType(param))
                    {
                        return true;
                    }
                }

                return ContainsSameCompilationUserType(fn.ReturnType);
            case TupleTypeSymbol tup:
                foreach (var elem in tup.ElementTypes)
                {
                    if (ContainsSameCompilationUserType(elem))
                    {
                        return true;
                    }
                }

                return false;
            case ImportedTypeSymbol it when !it.TypeArguments.IsDefaultOrEmpty:
                foreach (var arg in it.TypeArguments)
                {
                    if (ContainsSameCompilationUserType(arg))
                    {
                        return true;
                    }
                }

                return false;
            case StructSymbol:
            case EnumSymbol:
            case InterfaceSymbol:
            case DelegateTypeSymbol:
                return type.ClrType == null;
            default:
                return false;
        }
    }

    /// <summary>
    /// Returns true when <paramref name="type"/> — after unwrapping nullable,
    /// slice and array wrappers — is itself a same-compilation user-defined
    /// type (struct/class/enum/interface/delegate with a null <c>ClrType</c>).
    /// Unlike <see cref="ContainsSameCompilationUserType"/>, this does NOT
    /// recurse into the type arguments of a constructed imported generic: a
    /// constructed generic over a user element (e.g. <c>ChannelWriter[Entry]</c>)
    /// is NOT a top-level user type, because method/extension lookup on such a
    /// non-interned constructed generic is not yet supported (#1305).
    /// </summary>
    /// <param name="type">The type to inspect.</param>
    /// <returns>
    /// <c>true</c> if the unwrapped top-level type is a same-compilation
    /// user-defined type; otherwise <c>false</c>.
    /// </returns>
    public static bool IsSameCompilationUserTypeTopLevel(TypeSymbol type)
    {
        switch (type)
        {
            case null:
                return false;
            case NullableTypeSymbol n:
                return IsSameCompilationUserTypeTopLevel(n.UnderlyingType);
            case SliceTypeSymbol s:
                return IsSameCompilationUserTypeTopLevel(s.ElementType);
            case ArrayTypeSymbol a:
                return IsSameCompilationUserTypeTopLevel(a.ElementType);
            case StructSymbol:
            case EnumSymbol:
            case InterfaceSymbol:
            case DelegateTypeSymbol:
                return type.ClrType == null;
            default:
                return false;
        }
    }
}
