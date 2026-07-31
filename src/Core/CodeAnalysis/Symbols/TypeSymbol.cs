// <copyright file="TypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;

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

        // Issue #1922: a `System.ValueTuple<...>`/`System.Tuple<...>` CLR type
        // reaching here (e.g. the element type of `for x in list` over an
        // imported `List[(T1, T2)]`, resolved via reflection rather than
        // parsed from G# tuple-literal syntax) must map back onto GSharp's own
        // `TupleTypeSymbol` — not a plain `ImportedTypeSymbol` — so downstream
        // binders (deconstruction, member access) recognize it as a tuple.
        // Issue #2750: canonical Rest-chained arity-8+ shapes are flattened
        // back into the source-level positional tuple symbol.
        if (TryGetTupleTypeSymbol(clrType, out var tupleTypeSymbol))
        {
            return tupleTypeSymbol;
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
    /// Issue #1481: the single canonical structural walk over the
    /// <see cref="TypeSymbol"/> lattice, parameterized by a leaf predicate.
    /// Returns <c>true</c> when any <see cref="TypeParameterSymbol"/> reachable
    /// from <paramref name="type"/> (directly or nested inside any composite
    /// type-kind that can structurally carry one) satisfies
    /// <paramref name="match"/>.
    /// <para>This replaces three previously hand-copied, divergent recursions —
    /// the canonical <see cref="ContainsTypeParameter"/> and two emit-layer
    /// copies (<c>MethodBodyPlanner.ContainsTypeParameter</c> and
    /// <c>StateMachineEmitter.ContainsOuterMethodTypeParameter</c>) — which had
    /// drifted apart in which kinds they descended into (the emit copies
    /// omitted <see cref="MapTypeSymbol"/> / <see cref="FunctionTypeSymbol"/>,
    /// erasing generic iterator element types to the <c>&lt;object&gt;</c>
    /// shape). Every composite kind is now handled here in exactly one place;
    /// the public wrappers differ only in their leaf predicate.</para>
    /// </summary>
    /// <param name="type">The type to inspect (may be <see langword="null"/>).</param>
    /// <param name="match">Leaf predicate applied to each referenced type parameter.</param>
    /// <returns><c>true</c> if some referenced type parameter satisfies <paramref name="match"/>.</returns>
    public static bool AnyTypeParameter(TypeSymbol type, Func<TypeParameterSymbol, bool> match)
    {
        switch (type)
        {
            case null:
                return false;
            case TypeParameterSymbol tp:
                return match(tp);
            case NullableTypeSymbol n:
                return AnyTypeParameter(n.UnderlyingType, match);
            case SliceTypeSymbol s:
                return AnyTypeParameter(s.ElementType, match);
            case ArrayTypeSymbol a:
                return AnyTypeParameter(a.ElementType, match);
            case SequenceTypeSymbol seq:
                return AnyTypeParameter(seq.ElementType, match);
            case AsyncSequenceTypeSymbol aseq:
                return AnyTypeParameter(aseq.ElementType, match);
            case MapTypeSymbol m:
                return AnyTypeParameter(m.KeyType, match) || AnyTypeParameter(m.ValueType, match);
            case FunctionTypeSymbol fn:
                foreach (var param in fn.ParameterTypes)
                {
                    if (AnyTypeParameter(param, match))
                    {
                        return true;
                    }
                }

                return AnyTypeParameter(fn.ReturnType, match);
            case TupleTypeSymbol tup:
                // Issue #813: value-tuple element types must propagate
                // "contains type parameter" so callers like
                // `ImportedTypeSymbol.HasTypeParameterArgument` route a
                // wrapping `IEnumerable[(int32, T)]` through the
                // type-spec encoder instead of falling back to the
                // type-erased `IEnumerable<object>` shape.
                foreach (var elem in tup.ElementTypes)
                {
                    if (AnyTypeParameter(elem, match))
                    {
                        return true;
                    }
                }

                return false;
            case ByRefTypeSymbol br:
                return AnyTypeParameter(br.PointeeType, match);
            case StructSymbol st when !st.TypeArguments.IsDefaultOrEmpty:
                foreach (var arg in st.TypeArguments)
                {
                    if (AnyTypeParameter(arg, match))
                    {
                        return true;
                    }
                }

                return false;
            case InterfaceSymbol iface when !iface.TypeArguments.IsDefaultOrEmpty:
                foreach (var arg in iface.TypeArguments)
                {
                    if (AnyTypeParameter(arg, match))
                    {
                        return true;
                    }
                }

                return false;
            case DelegateTypeSymbol del:
                foreach (var param in del.Parameters)
                {
                    if (AnyTypeParameter(param.Type, match))
                    {
                        return true;
                    }
                }

                return AnyTypeParameter(del.ReturnType, match);
            case ImportedTypeSymbol it when !it.TypeArguments.IsDefaultOrEmpty:
                foreach (var arg in it.TypeArguments)
                {
                    if (AnyTypeParameter(arg, match))
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
    /// #313: returns <c>true</c> if <paramref name="type"/> is, or structurally
    /// contains, an in-scope generic <see cref="TypeParameterSymbol"/> (e.g.
    /// <c>T</c>, <c>T?</c>, <c>[]T</c>, or <c>List[T]</c>). Such a type is an
    /// open/partially-constructed generic whose emit form is type-erased to
    /// <c>System.Object</c> under the type-erased generic model (ADR-0004).
    /// </summary>
    /// <param name="type">The type to inspect.</param>
    /// <returns><c>true</c> if the type references an in-scope type parameter.</returns>
    public static bool ContainsTypeParameter(TypeSymbol type) => AnyTypeParameter(type, static _ => true);

    /// <summary>
    /// Issue #810 / #1481: returns <see langword="true"/> when
    /// <paramref name="type"/> structurally references any of the supplied
    /// <paramref name="outerMethodTypeParameters"/>. Used by the iterator
    /// state-machine emitter to decide whether the <c>GetEnumerator</c> return
    /// and the SM's <c>IEnumerable&lt;…&gt;</c> / <c>IEnumerator&lt;…&gt;</c>
    /// interface rows need a symbolic (TypeSpec-encoded) strongly-typed shape
    /// rather than the CLR-erased <c>&lt;object&gt;</c> form. Shares the single
    /// <see cref="AnyTypeParameter"/> walker with
    /// <see cref="ContainsTypeParameter"/>; only the leaf predicate differs.
    /// </summary>
    /// <param name="type">The type to inspect.</param>
    /// <param name="outerMethodTypeParameters">The outer method's in-scope type parameters.</param>
    /// <returns><c>true</c> if the type references one of the outer-method type parameters.</returns>
    public static bool ContainsOuterMethodTypeParameter(TypeSymbol type, ImmutableArray<TypeParameterSymbol> outerMethodTypeParameters)
    {
        if (outerMethodTypeParameters.IsDefaultOrEmpty)
        {
            return false;
        }

        return AnyTypeParameter(type, outerMethodTypeParameters.Contains);
    }

    /// <summary>
    /// Issue #1477: collects, in stable first-seen order, every distinct
    /// <see cref="TypeParameterSymbol"/> structurally referenced by
    /// <paramref name="type"/> — recursing through nullable / slice / array /
    /// map / function / tuple wrappers and the type arguments of constructed
    /// user (<see cref="StructSymbol"/> / <see cref="InterfaceSymbol"/> /
    /// <see cref="DelegateTypeSymbol"/>) and imported generic types. Used by
    /// the closure / capture-box emitter to discover which enclosing type
    /// parameters a synthesized display class must be made generic over.
    /// </summary>
    /// <param name="type">The type to inspect (may be <see langword="null"/>).</param>
    /// <param name="sink">The ordered set to add referenced type parameters to.</param>
    public static void CollectReferencedTypeParameters(TypeSymbol type, List<TypeParameterSymbol> sink)
    {
        switch (type)
        {
            case null:
                return;
            case TypeParameterSymbol tp:
                if (!sink.Contains(tp))
                {
                    sink.Add(tp);
                }

                return;
            case NullableTypeSymbol n:
                CollectReferencedTypeParameters(n.UnderlyingType, sink);
                return;
            case SliceTypeSymbol s:
                CollectReferencedTypeParameters(s.ElementType, sink);
                return;
            case ArrayTypeSymbol a:
                CollectReferencedTypeParameters(a.ElementType, sink);
                return;
            case SequenceTypeSymbol sq:
                CollectReferencedTypeParameters(sq.ElementType, sink);
                return;
            case AsyncSequenceTypeSymbol asq:
                CollectReferencedTypeParameters(asq.ElementType, sink);
                return;
            case MapTypeSymbol m:
                CollectReferencedTypeParameters(m.KeyType, sink);
                CollectReferencedTypeParameters(m.ValueType, sink);
                return;
            case FunctionTypeSymbol fn:
                foreach (var param in fn.ParameterTypes)
                {
                    CollectReferencedTypeParameters(param, sink);
                }

                CollectReferencedTypeParameters(fn.ReturnType, sink);
                return;
            case TupleTypeSymbol tup:
                foreach (var elem in tup.ElementTypes)
                {
                    CollectReferencedTypeParameters(elem, sink);
                }

                return;
            case ByRefTypeSymbol br:
                CollectReferencedTypeParameters(br.PointeeType, sink);
                return;
            case StructSymbol ss when !ss.TypeArguments.IsDefaultOrEmpty:
                foreach (var arg in ss.TypeArguments)
                {
                    CollectReferencedTypeParameters(arg, sink);
                }

                return;
            case StructSymbol ssOpen when !ssOpen.TypeParameters.IsDefaultOrEmpty:
                // Issue #1477: a captured `this` of a generic type `G[T]` is the
                // OPEN definition (TypeParameters set, no TypeArguments) — its
                // own parameters ARE the enclosing parameters the capture field
                // references (`G`1<!0>`), so collect them.
                foreach (var tp in ssOpen.TypeParameters)
                {
                    CollectReferencedTypeParameters(tp, sink);
                }

                return;
            case InterfaceSymbol iface when !iface.TypeArguments.IsDefaultOrEmpty:
                foreach (var arg in iface.TypeArguments)
                {
                    CollectReferencedTypeParameters(arg, sink);
                }

                return;
            case InterfaceSymbol ifaceOpen when !ifaceOpen.TypeParameters.IsDefaultOrEmpty:
                foreach (var tp in ifaceOpen.TypeParameters)
                {
                    CollectReferencedTypeParameters(tp, sink);
                }

                return;
            case DelegateTypeSymbol del:
                foreach (var param in del.Parameters)
                {
                    CollectReferencedTypeParameters(param.Type, sink);
                }

                CollectReferencedTypeParameters(del.ReturnType, sink);
                return;
            case ImportedTypeSymbol it when !it.TypeArguments.IsDefaultOrEmpty:
                foreach (var arg in it.TypeArguments)
                {
                    CollectReferencedTypeParameters(arg, sink);
                }

                return;
            default:
                return;
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
            case TypeParameterSymbol:
                return false;
            case StructSymbol:
            case EnumSymbol:
            case InterfaceSymbol:
            case DelegateTypeSymbol:
                return type.ClrType == null;
        }

        // Issue #1790: every other kind is a wrapper/constructed type — recurse
        // through its immediate inner type(s) via the single canonical
        // enumerator below instead of hand-copying a per-wrapper switch here.
        // This is what previously let Sequence/AsyncSequence/Channel/ByRef/
        // Pointer (whose CLR shape collapses to null when their element/
        // pointee is a same-compilation user type) fall through to the
        // "default: false" arm and alias across compilations (see
        // <see cref="FunctionTypeSymbol.AppendIdentityKey"/>).
        foreach (var inner in GetWrappedTypes(type))
        {
            if (ContainsSameCompilationUserType(inner))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #2498: returns <c>true</c> when <paramref name="type"/> carries a
    /// nullable-reference annotation at any structural position. Unlike CLR
    /// <c>Nullable&lt;T&gt;</c>, reference nullability has no distinct runtime
    /// <see cref="Type"/> shape, so reflection-only generic substitution cannot
    /// reproduce it after inference.
    /// </summary>
    /// <param name="type">The type to inspect.</param>
    /// <returns><c>true</c> when a nullable-reference wrapper is present.</returns>
    public static bool ContainsReferenceNullableAnnotation(TypeSymbol type)
    {
        if (type is NullableTypeSymbol nullable)
        {
            if (!NullableLifting.IsAnyValueTypeNullable(nullable))
            {
                return true;
            }

            return ContainsReferenceNullableAnnotation(nullable.UnderlyingType);
        }

        foreach (var inner in GetWrappedTypes(type))
        {
            if (ContainsReferenceNullableAnnotation(inner))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Compares runtime type identity while ignoring nullable-reference
    /// annotations, which are metadata-only and do not change a CLR signature.
    /// Nullable value types and every other structural distinction remain
    /// significant.
    /// </summary>
    /// <param name="left">The first type.</param>
    /// <param name="right">The second type.</param>
    /// <returns><see langword="true"/> when the runtime signatures are equivalent.</returns>
    public static bool AreRuntimeEquivalentIgnoringReferenceNullability(TypeSymbol left, TypeSymbol right)
    {
        left = StripReferenceNullabilityCore(left);
        right = StripReferenceNullabilityCore(right);

        if (ReferenceEquals(left, right))
        {
            return true;
        }

        if (left == null || right == null)
        {
            return false;
        }

        if (left is NullableTypeSymbol || right is NullableTypeSymbol)
        {
            var leftNullable = left as NullableTypeSymbol;
            var rightNullable = right as NullableTypeSymbol;
            return leftNullable != null
                && rightNullable != null
                && AreRuntimeEquivalentIgnoringReferenceNullability(
                    leftNullable.UnderlyingType,
                    rightNullable.UnderlyingType);
        }

        if (left is StructSymbol leftStruct && right is StructSymbol rightStruct)
        {
            return AreSameConstructedUserTypeCore(
                leftStruct.Definition ?? leftStruct,
                leftStruct.TypeArguments,
                rightStruct.Definition ?? rightStruct,
                rightStruct.TypeArguments);
        }

        if (left is InterfaceSymbol leftInterface && right is InterfaceSymbol rightInterface)
        {
            return AreSameConstructedUserTypeCore(
                leftInterface.Definition ?? leftInterface,
                leftInterface.TypeArguments,
                rightInterface.Definition ?? rightInterface,
                rightInterface.TypeArguments);
        }

        if (left is DelegateTypeSymbol leftDelegate && right is DelegateTypeSymbol rightDelegate)
        {
            return AreSameConstructedUserTypeCore(
                leftDelegate.Definition ?? leftDelegate,
                leftDelegate.TypeArguments,
                rightDelegate.Definition ?? rightDelegate,
                rightDelegate.TypeArguments);
        }

        if (left.GetType() != right.GetType())
        {
            return false;
        }

        if (left is ArrayTypeSymbol leftArray
            && right is ArrayTypeSymbol rightArray
            && leftArray.Length != rightArray.Length)
        {
            return false;
        }

        if (left is FunctionTypeSymbol leftFunction
            && right is FunctionTypeSymbol rightFunction
            && !leftFunction.IsVariadic.SequenceEqual(rightFunction.IsVariadic))
        {
            return false;
        }

        var leftParts = GetWrappedTypes(left).ToArray();
        var rightParts = GetWrappedTypes(right).ToArray();
        if (leftParts.Length > 0 || rightParts.Length > 0)
        {
            return leftParts.Length == rightParts.Length
                && (left.ClrType == null
                    || right.ClrType == null
                    || ClrTypeUtilities.AreSame(left.ClrType, right.ClrType))
                && leftParts.Zip(rightParts, AreRuntimeEquivalentIgnoringReferenceNullability).All(equal => equal);
        }

        return left.ClrType != null
            && right.ClrType != null
            && ClrTypeUtilities.AreSame(left.ClrType, right.ClrType);

        static TypeSymbol StripReferenceNullabilityCore(TypeSymbol type)
        {
            while (true)
            {
                switch (type)
                {
                    case NullabilityAnnotatedTypeSymbol annotated:
                        type = annotated.BaseType;
                        continue;
                    case NullableTypeSymbol nullable when !NullableLifting.IsAnyValueTypeNullable(nullable):
                        type = nullable.UnderlyingType;
                        continue;
                    default:
                        return type;
                }
            }
        }

        static bool AreSameConstructedUserTypeCore(
            TypeSymbol leftDefinition,
            ImmutableArray<TypeSymbol> leftArguments,
            TypeSymbol rightDefinition,
            ImmutableArray<TypeSymbol> rightArguments)
        {
            if (!ReferenceEquals(leftDefinition, rightDefinition)
                || leftArguments.Length != rightArguments.Length)
            {
                return false;
            }

            for (var i = 0; i < leftArguments.Length; i++)
            {
                if (!AreRuntimeEquivalentIgnoringReferenceNullability(leftArguments[i], rightArguments[i]))
                {
                    return false;
                }
            }

            return true;
        }
    }

    /// <summary>
    /// Returns <c>true</c> when a symbolic type projection contains information
    /// that its CLR <see cref="Type"/> cannot faithfully represent.
    /// </summary>
    /// <param name="type">The type to inspect.</param>
    /// <returns><c>true</c> when symbolic substitution must be retained.</returns>
    public static bool RequiresSymbolicProjection(TypeSymbol type)
        => ContainsTypeParameter(type)
            || ContainsSameCompilationUserType(type)
            || ContainsReferenceNullableAnnotation(type);

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

    /// <summary>
    /// Issue #1790: the single canonical enumeration of a wrapper/constructed
    /// <see cref="TypeSymbol"/>'s immediate inner type(s) — the element,
    /// pointee, key/value, parameter/return, or type-argument slot(s) the
    /// composite type structurally carries. Every generic/wrapper kind that
    /// can carry another type is listed here exactly once so callers such as
    /// <see cref="ContainsSameCompilationUserType"/> recurse uniformly rather
    /// than each maintaining its own divergent switch (the class of bug that
    /// let several wrapper kinds silently fall through as "no inner type").
    /// Leaf kinds (primitives, same-compilation user types, type parameters)
    /// are not wrappers and yield nothing here; their callers handle them
    /// directly. Each yielded type is a strict substructure of
    /// <paramref name="type"/> (types form a DAG built during binding, never
    /// a cycle back to themselves), so recursive callers always terminate.
    /// </summary>
    /// <param name="type">The wrapper/constructed type to unwrap.</param>
    /// <returns>The type's immediate inner type(s); empty for a leaf kind.</returns>
    private static IEnumerable<TypeSymbol> GetWrappedTypes(TypeSymbol type)
    {
        switch (type)
        {
            case NullableTypeSymbol n:
                yield return n.UnderlyingType;
                break;
            case SliceTypeSymbol s:
                yield return s.ElementType;
                break;
            case ArrayTypeSymbol a:
                yield return a.ElementType;
                break;
            case PinnedTypeSymbol p:
                yield return p.UnderlyingType;
                break;
            case NullabilityAnnotatedTypeSymbol na:
                yield return na.BaseType;
                break;
            case SequenceTypeSymbol seq:
                yield return seq.ElementType;
                break;
            case AsyncSequenceTypeSymbol aseq:
                yield return aseq.ElementType;
                break;
            case ChannelTypeSymbol ch:
                yield return ch.ElementType;
                break;
            case ByRefTypeSymbol br:
                yield return br.PointeeType;
                break;
            case PointerTypeSymbol ptr:
                yield return ptr.PointeeType;
                break;
            case MapTypeSymbol m:
                yield return m.KeyType;
                yield return m.ValueType;
                break;
            case FunctionTypeSymbol fn:
                foreach (var param in fn.ParameterTypes)
                {
                    yield return param;
                }

                yield return fn.ReturnType;
                break;
            case FunctionPointerTypeSymbol fp:
                foreach (var param in fp.ParameterTypes)
                {
                    yield return param;
                }

                yield return fp.ReturnType;
                break;
            case TupleTypeSymbol tup:
                foreach (var elem in tup.ElementTypes)
                {
                    yield return elem;
                }

                break;
            case ImportedTypeSymbol it when !it.TypeArguments.IsDefaultOrEmpty:
                foreach (var arg in it.TypeArguments)
                {
                    yield return arg;
                }

                break;
        }
    }

    /// <summary>
    /// Issue #1922: recognizes a closed generic <c>System.ValueTuple&lt;...&gt;</c>
    /// or <c>System.Tuple&lt;...&gt;</c> CLR type and maps it onto the equivalent
    /// flat <see cref="TupleTypeSymbol"/>, including canonical arity-8+
    /// <c>TRest</c> nesting.
    /// </summary>
    /// <param name="clrType">The candidate CLR type.</param>
    /// <param name="tupleTypeSymbol">The resulting tuple symbol, if matched.</param>
    /// <returns><see langword="true"/> if <paramref name="clrType"/> is a supported tuple shape.</returns>
    private static bool TryGetTupleTypeSymbol(Type clrType, out TupleTypeSymbol tupleTypeSymbol)
    {
        tupleTypeSymbol = null;
        if (!clrType.IsGenericType || clrType.IsGenericTypeDefinition)
        {
            return false;
        }

        var elementTypes = ImmutableArray.CreateBuilder<TypeSymbol>();
        if (!TryCollectTupleElements(clrType, elementTypes, allowSingleElementRest: false))
        {
            return false;
        }

        tupleTypeSymbol = TupleTypeSymbol.Get(elementTypes.ToImmutable());
        return true;
    }

    private static bool TryCollectTupleElements(
        Type clrType,
        ImmutableArray<TypeSymbol>.Builder elementTypes,
        bool allowSingleElementRest)
    {
        if (!clrType.IsGenericType || clrType.IsGenericTypeDefinition)
        {
            return false;
        }

        var definitionName = clrType.GetGenericTypeDefinition().FullName;
        var isValueTuple = definitionName?.StartsWith("System.ValueTuple`", StringComparison.Ordinal) == true;
        var isReferenceTuple = definitionName?.StartsWith("System.Tuple`", StringComparison.Ordinal) == true;
        if (!isValueTuple && !isReferenceTuple)
        {
            return false;
        }

        var arguments = clrType.GetGenericArguments();
        if (arguments.Length == 1)
        {
            if (!allowSingleElementRest)
            {
                return false;
            }

            elementTypes.Add(FromClrType(arguments[0]));
            return true;
        }

        if (arguments.Length is < 2 or > 8)
        {
            return false;
        }

        var directCount = arguments.Length == 8 ? 7 : arguments.Length;
        for (var i = 0; i < directCount; i++)
        {
            elementTypes.Add(FromClrType(arguments[i]));
        }

        return arguments.Length != 8
            || TryCollectTupleElements(arguments[7], elementTypes, allowSingleElementRest: true);
    }
}
