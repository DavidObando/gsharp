// <copyright file="TypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding

/// Represents a type symbol in the language.
open partial class TypeSymbol : Symbol {
    internal init(name string) : base(name) { }

    internal init(name string, clrType Type?) : base(name) {
        ClrType = clrType
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    open override prop Kind SymbolKind -> SymbolKind.Type

    /// Gets the underlying CLR type for this symbol, if any.
    prop ClrType Type? {
        get;
    }

    /// Gets the type arguments this generic instantiation was constructed
    /// with — the Roslyn `INamedTypeSymbol.TypeArguments` analogue
    /// (ADR-0169; distinct from (cref:ImportedTypeSymbol.TypeArguments),
    /// which carries only symbolic arguments). Empty for non-generic types.
    open prop ConstructedTypeArguments ImmutableArray[TypeSymbol] {
        get {
            if ClrType is not{IsGenericType: true} generic {
                return ImmutableArray[TypeSymbol].Empty
            }
            let builder = ImmutableArray.CreateBuilder[TypeSymbol](generic.GenericTypeArguments.Length)
            for argument in generic.GenericTypeArguments {
                builder.Add(FromClrTypeWithoutNullability(argument, NullabilityFreeReason.TypeStructure))
            }
            return builder.MoveToImmutable()
        }
    }

    /// Gets the open generic definition this instantiation was constructed
    /// from, or this symbol itself for non-generic types — the Roslyn
    /// `ConstructedFrom` analogue (ADR-0169).
    open prop ConstructedFrom TypeSymbol -> if ClrType is {
        IsGenericType: true,
        IsGenericTypeDefinition: false
    } generic {
        FromClrTypeWithoutNullability(generic.GetGenericTypeDefinition(), NullabilityFreeReason.TypeStructure)
    } else {
        this
    }

    /// Gets a value indicating whether this type is a value type — the
    /// Roslyn `IsValueType` analogue (ADR-0169).
    open prop IsValueType bool -> ClrType?.IsValueType ?? false

    /// Gets a value indicating whether this is a tuple type — the Roslyn
    /// `IsTupleType` analogue (ADR-0169).
    open prop IsTupleType bool -> false

    /// Gets the positional tuple elements as field symbols
    /// (`Item1..ItemN`) — the Roslyn `TupleElements` analogue
    /// (ADR-0169). Empty for non-tuple types.
    open prop TupleElements ImmutableArray[FieldSymbol] -> ImmutableArray[FieldSymbol].Empty

    /// Gets the immediate base type, or `null` when none exists.
    open prop BaseType TypeSymbol? -> if ClrType?.BaseType is {} baseType {
        FromClrTypeWithoutNullability(baseType, NullabilityFreeReason.TypeStructure)
    } else {
        default(TypeSymbol?)
    }

    /// Gets the members declared on this type — the Roslyn
    /// `GetMembers()` analogue (ADR-0169). Empty by default; user-defined
    /// aggregates surface their fields, properties, methods, and events.
    /// @returns The declared members.
    open func GetMembers() ImmutableArray[Symbol] -> ImmutableArray[Symbol].Empty

    /// Gets the constructor callables declared on this type. Constructors stay
    /// outside (cref:GetMembers) because G# models them separately from
    /// ordinary functions.
    /// @returns The declared constructor callables.
    open func GetConstructors() ImmutableArray[FunctionSymbol] -> ImmutableArray[FunctionSymbol].Empty

    /// Renders CLR-backed types the way Roslyn's fully-qualified format does
    /// — `global::Ns.Name<T1, T2>` with type-parameter names on
    /// open definitions — so string comparisons in migrated analyzers (e.g.
    /// against `"global::System.Collections.Generic.Dictionary<TKey, TValue>"`)
    /// carry over verbatim (ADR-0169). Non-CLR-backed types fall back to the
    /// base rendering.
    /// @param format The rendering format.
    /// @returns The rendered type name.
    open override func ToDisplayString(format DisplayFormat) string -> if ClrType is {} clrType {
        RenderClrType(clrType, format)
    } else {
        base.ToDisplayString(format)
    }

    shared {
        /// The type error symbol.
        let Error TypeSymbol = TypeSymbol("?")

        /// The `bool` symbol.
        let Bool TypeSymbol = TypeSymbol("bool", typeof(bool))

        /// The `uint8` symbol (8-bit unsigned integer, `System.Byte`). Renamed from `byte` by ADR-0049.
        let UInt8 TypeSymbol = TypeSymbol("uint8", typeof(uint8))

        /// The `int8` symbol (8-bit signed integer, `System.SByte`). Renamed from `sbyte` by ADR-0049.
        let Int8 TypeSymbol = TypeSymbol("int8", typeof(int8))

        /// The `int16` symbol (16-bit signed integer, `System.Int16`). Renamed from `short` by ADR-0049.
        let Int16 TypeSymbol = TypeSymbol("int16", typeof(int16))

        /// The `uint16` symbol (16-bit unsigned integer, `System.UInt16`). Renamed from `ushort` by ADR-0049.
        let UInt16 TypeSymbol = TypeSymbol("uint16", typeof(uint16))

        /// The `int32` symbol (32-bit signed integer, `System.Int32`). Renamed from `int` by ADR-0049.
        let Int32 TypeSymbol = TypeSymbol("int32", typeof(int32))

        /// The `uint32` symbol (32-bit unsigned integer, `System.UInt32`). Renamed from `uint` by ADR-0049.
        let UInt32 TypeSymbol = TypeSymbol("uint32", typeof(uint32))

        /// The `int64` symbol (64-bit signed integer, `System.Int64`). Renamed from `long` by ADR-0049.
        let Int64 TypeSymbol = TypeSymbol("int64", typeof(int64))

        /// The `uint64` symbol (64-bit unsigned integer, `System.UInt64`). Renamed from `ulong` by ADR-0049.
        let UInt64 TypeSymbol = TypeSymbol("uint64", typeof(uint64))

        /// The `nint` symbol (native-width signed integer, `System.IntPtr`). Added by ADR-0044.
        let NInt TypeSymbol = TypeSymbol("nint", typeof(nint))

        /// The `nuint` symbol (native-width unsigned integer, `System.UIntPtr`). Added by ADR-0044.
        let NUInt TypeSymbol = TypeSymbol("nuint", typeof(nuint))

        /// The `float32` symbol (IEEE 754 binary32, `System.Single`). Added by ADR-0044.
        let Float32 TypeSymbol = TypeSymbol("float32", typeof(float32))

        /// The `float64` symbol (IEEE 754 binary64, `System.Double`). Added by ADR-0044.
        let Float64 TypeSymbol = TypeSymbol("float64", typeof(float64))

        /// The `decimal` symbol (128-bit base-10, `System.Decimal`). Added by ADR-0044.
        let Decimal TypeSymbol = TypeSymbol("decimal", typeof(decimal))

        /// The `char` symbol (UTF-16 code unit, `System.Char`). Added by ADR-0044.
        let Char TypeSymbol = TypeSymbol("char", typeof(char))

        /// The `string` symbol.
        let String TypeSymbol = TypeSymbol("string", typeof(string))

        /// The `object` symbol (universal upper bound, `System.Object`). Added by ADR-0044 / ADR-0045.
        let Object TypeSymbol = TypeSymbol("object", typeof(object))

        /// The void type symbol.
        let Void TypeSymbol = TypeSymbol("void", typeof(Void))

        /// The static type of the `nil` literal (Phase 3.C.2 / ADR-0001). Implicitly convertible to any
        /// (cref:NullableTypeSymbol); not assignable to a non-nullable type.
        let Null TypeSymbol = TypeSymbol("nil")

        /// Issue #1018: the bottom ("never") type of a `throw` expression. A
        /// throw-expression never produces a value (it always transfers control via
        /// CIL `throw`), so its static type is implicitly convertible to ANY
        /// target type. `Conversion.Classify` treats it as an implicit
        /// conversion source, and the conditional/null-coalesce common-type logic
        /// resolves to the sibling operand's type.
        let Never TypeSymbol = TypeSymbol("never")

        /// Maps a CLR (cref:Type) to the corresponding built-in (cref:TypeSymbol),
        /// or wraps it in an (cref:ImportedTypeSymbol) if it is not built-in.
        /// @param clrType The CLR type to map.
        /// @returns The corresponding (cref:TypeSymbol).
        /// @remarks ADR-0193 §3: this is a conversion <em>door</em>. It reads no declaration
        /// nullability, so GSA0007 reports a call to it outside a
        /// (cref:NullabilityFunnelAttribute) member. Signature positions go
        /// through the funnel readers ((cref:ClrNullability)'s
        /// `Get*TypeSymbol`, `MemberLookup.GetClr*TypeSymbol`); a type
        /// with no declaration nullability to lose goes through
        /// (cref:FromClrTypeWithoutNullability), which names why.
        @NullabilityFunnel
        func FromClrType(clrType Type?) TypeSymbol {
            if clrType == nil {
                return TypeSymbol.Void
            }
            if clrType.IsFunctionPointer {
                return FunctionPointerTypeSymbol.FromClrSignature(clrType, FromClrType)
            }
            if clrType.IsPointer {
                return PointerTypeSymbol.Get(FromClrType(clrType.GetElementType()))
            }
            let currentClrType = clrType.UnderlyingSystemType
            // Phase 3.C.5 / ADR-0001: surface CLR value-type nullability
            // (`Nullable<T>` aka `T?` in C#) as a GSharp `NullableTypeSymbol`
            // wrapping the underlying. Reference-type nullability driven by
            // `[NullableAttribute]` byte arrays is a follow-up.
            if NullableLifting.GetValueTypeNullableUnderlyingClr(clrType) is {} nullableUnderlying {
                return NullableLifting.WrapValueTypeNullable(FromClrType(nullableUnderlying))
            }
            if currentClrType.IsArray && currentClrType.GetArrayRank() > 1 {
                return RectangularArrayTypeSymbol.Get(
                    FromClrType(clrType.GetElementType()),
                    currentClrType.GetArrayRank()
                )
            }
            if currentClrType.IsArray && ClrNullability.ContainsFunctionPointer(clrType) {
                return SliceTypeSymbol.Get(FromClrType(clrType.GetElementType()))
            }
            // Issue #1922: a `System.ValueTuple<...>`/`System.Tuple<...>` CLR type
            // reaching here (e.g. the element type of `for x in list` over an
            // imported `List[(T1, T2)]`, resolved via reflection rather than
            // parsed from G# tuple-literal syntax) must map back onto GSharp's own
            // `TupleTypeSymbol` — not a plain `ImportedTypeSymbol` — so downstream
            // binders (deconstruction, member access) recognize it as a tuple.
            // Issue #2750: canonical Rest-chained arity-8+ shapes are flattened
            // back into the source-level positional tuple symbol.
            if TryGetTupleTypeSymbol(clrType, out var tupleTypeSymbol) {
                return tupleTypeSymbol
            }
            if currentClrType.IsConstructedGenericType && ClrNullability.ContainsFunctionPointer(clrType) {
                let arguments = ImmutableArray.CreateBuilder[TypeSymbol]()
                for argument in clrType.GetGenericArguments() {
                    arguments.Add(FromClrType(argument))
                }
                return ImportedTypeSymbol.GetConstructed(
                    currentClrType,
                    currentClrType.GetGenericTypeDefinition(),
                    arguments.ToImmutable()
                )
            }
            // Compare by FullName so types loaded from a MetadataLoadContext (carrying the
            // target framework's identity) still map onto the built-in primitive symbols.
            let fullName = currentClrType.FullName
            switch fullName {
                case "System.Boolean" {
                    return Bool
                }
                case "System.Byte" {
                    return UInt8
                }
                case "System.SByte" {
                    return Int8
                }
                case "System.Int16" {
                    return TypeSymbol.Int16
                }
                case "System.UInt16" {
                    return TypeSymbol.UInt16
                }
                case "System.Int32" {
                    return TypeSymbol.Int32
                }
                case "System.UInt32" {
                    return TypeSymbol.UInt32
                }
                case "System.Int64" {
                    return TypeSymbol.Int64
                }
                case "System.UInt64" {
                    return TypeSymbol.UInt64
                }
                case "System.IntPtr" {
                    return NInt
                }
                case "System.UIntPtr" {
                    return NUInt
                }
                case "System.Single" {
                    return Float32
                }
                case "System.Double" {
                    return Float64
                }
                case "System.Decimal" {
                    return TypeSymbol.Decimal
                }
                case "System.Char" {
                    return TypeSymbol.Char
                }
                case "System.String" {
                    return TypeSymbol.String
                }
                case "System.Object" {
                    return TypeSymbol.Object
                }
                case "System.Void" {
                    return TypeSymbol.Void
                }
            }
            // Delegated declarations retain their metadata providers; CLR modified signatures require their underlying identity.
            return ImportedTypeSymbol.Get(
                if clrType is System.Reflection.TypeDelegator {
                    clrType
                } else {
                    currentClrType
                }
            )
        }

        /// Issue #367: returns `true` when [`type`](paramref) denotes a
        /// by-ref-like (`ref struct`) type. This covers both imported CLR types
        /// such as `Span[T]`, `ReadOnlySpan[T]`, or
        /// `DefaultInterpolatedStringHandler` (detected via
        /// `System.Runtime.CompilerServices.IsByRefLikeAttribute`) and
        /// user-declared `ref struct` types ((cref:StructSymbol.IsRefStruct))
        /// that have no CLR type yet because they are being compiled. These values are
        /// stack-only and may not escape to the heap (no boxing, no field of a
        /// non-ref-struct, no closure capture, no async/iterator hoisting, and no use
        /// as a generic type argument). A (cref:NullableTypeSymbol) wrapper is
        /// unwrapped first so `Span[T]?` is still recognised.
        /// @param type The type to inspect.
        /// @returns `true` if the type is by-ref-like.
        func IsByRefLike(type TypeSymbol?) bool {
            let unwrapped = if type is NullableTypeSymbol nullable {
                nullable.UnderlyingType
            } else {
                type
            }
            if unwrapped is StructSymbol && unwrapped.IsRefStruct == true {
                return true
            }
            return unwrapped?.ClrType != nil && ClrTypeUtilities.IsByRefLike(unwrapped!!.ClrType)
        }

        /// ADR-0122 / issue #1014. Returns the pointee (element) type when
        /// [`type`](paramref) is either a managed by-ref pointer
        /// ((cref:ByRefTypeSymbol), `T&`) or an unmanaged raw pointer
        /// ((cref:PointerTypeSymbol), `T*`). Several pointer operations
        /// (dereference, indirect assignment, indexing, address-of) share an IL
        /// shape across both pointer kinds; this helper lets them treat the two
        /// uniformly while the type system keeps them distinct.
        /// @param type The candidate pointer type.
        /// @param pointee The pointee type when the method returns `true`.
        /// @returns `true` when [`type`](paramref) is a managed or unmanaged pointer.
        func TryGetPointeeType(type TypeSymbol, @NotNullWhen(true) out pointee TypeSymbol?) bool {
            switch type {
                case byRef is ByRefTypeSymbol {
                    pointee = byRef.PointeeType
                    return true
                }
                case ptr is PointerTypeSymbol {
                    pointee = ptr.PointeeType
                    return true
                }
                default {
                    pointee = nil
                    return false
                }
            }
        }

        /// ADR-0122 / issue #1014. Returns whether [`type`](paramref) is an
        /// unmanaged raw pointer ((cref:PointerTypeSymbol), CLR
        /// `ELEMENT_TYPE_PTR`).
        /// @param type The type to inspect.
        /// @returns `true` when the type is an unmanaged pointer.
        func IsUnmanagedPointer(type TypeSymbol) bool -> type is PointerTypeSymbol

        /// ADR-0122 §3 / issue #1033. Returns whether [`type`](paramref) is a
        /// true `void`-element unmanaged pointer (`*void`, CLR
        /// `ELEMENT_TYPE_PTR` over `ELEMENT_TYPE_VOID`) — the faithful
        /// mapping of C# `void*`, distinct from the byte pointer `*uint8`.
        /// A `*void` carries no element type: it may be round-tripped through
        /// `nint`/`IntPtr` and cast to/from a typed pointer `*T`, but
        /// it may not be directly dereferenced, indexed, or used in pointer
        /// arithmetic (those require a cast to a typed pointer first).
        /// @param type The type to inspect.
        /// @returns `true` when the type is the void-element pointer `*void`.
        func IsVoidPointer(type TypeSymbol) bool -> type is PointerTypeSymbol{PointeeType: var pointee} &&
            pointee == TypeSymbol.Void

        /// ADR-0122 / issue #1014. Returns whether [`type`](paramref) is a
        /// legal pointee for an unmanaged pointer in the supported core subset: a
        /// blittable primitive (`int8`…`int64`, `uint8`…`uint64`,
        /// `nint`/`nuint`, `float32`/`float64`) or another
        /// unmanaged pointer (pointer-to-pointer). Pointers to arbitrary managed
        /// types are out of scope and rejected by the binder.
        /// @param type The candidate pointee type.
        /// @returns `true` when the type is a legal unmanaged pointee.
        func IsLegalPointeeType(type TypeSymbol) bool {
            if type is PointerTypeSymbol {
                return true
            }
            return type == Int8 ||
                type == UInt8 ||
                type == TypeSymbol.Int16 ||
                type == TypeSymbol.UInt16 ||
                type == TypeSymbol.Int32 ||
                type == TypeSymbol.UInt32 ||
                type == TypeSymbol.Int64 ||
                type == TypeSymbol.UInt64 ||
                type == NInt ||
                type == NUInt ||
                type == Float32 ||
                type == Float64 ||
                type == Bool ||
                type == TypeSymbol.Char
        }

        /// Issue #1481: the single canonical structural walk over the
        /// (cref:TypeSymbol) lattice, parameterized by a leaf predicate.
        /// Returns `true` when any (cref:TypeParameterSymbol) reachable
        /// from [`type`](paramref) (directly or nested inside any composite
        /// type-kind that can structurally carry one) satisfies
        /// [`match`](paramref).
        ///
        /// This replaces three previously hand-copied, divergent recursions —
        /// the canonical (cref:ContainsTypeParameter) and two emit-layer
        /// copies (`MethodBodyPlanner.ContainsTypeParameter` and
        /// `StateMachineEmitter.ContainsOuterMethodTypeParameter`) — which had
        /// drifted apart in which kinds they descended into (the emit copies
        /// omitted (cref:MapTypeSymbol) / (cref:FunctionTypeSymbol),
        /// erasing generic iterator element types to the `<object>`
        /// shape). Every composite kind is now handled here in exactly one place;
        /// the public wrappers differ only in their leaf predicate.
        /// @param type The type to inspect (may be `null`).
        /// @param match Leaf predicate applied to each referenced type parameter.
        /// @returns `true` if some referenced type parameter satisfies [`match`](paramref).
        func AnyTypeParameter(type TypeSymbol, match(TypeParameterSymbol) -> bool) bool {
            let originalMatch = match
            var visitedDelegates HashSet[(Definition DelegateTypeSymbol, BoundParameters int32)]? = nil
            let AnyTypeParameter = func (type TypeSymbol, match(TypeParameterSymbol) -> bool) bool {
                switch type {
                    case nil {
                        return false
                    }
                    case tp is TypeParameterSymbol {
                        return match(tp)
                    }
                    case n is NullableTypeSymbol {
                        return AnyTypeParameter(n.UnderlyingType, match)
                    }
                    case p is PlatformTypeSymbol {
                        // ADR-0186 §1: `T!` wraps exactly as `T?` does.
                        return AnyTypeParameter(p.UnderlyingType, match)
                    }
                    case s is SliceTypeSymbol {
                        return AnyTypeParameter(s.ElementType, match)
                    }
                    case a is ArrayTypeSymbol {
                        return AnyTypeParameter(a.ElementType, match)
                    }
                    case a is RectangularArrayTypeSymbol {
                        return AnyTypeParameter(a.ElementType, match)
                    }
                    case pinned is PinnedTypeSymbol {
                        return AnyTypeParameter(pinned.UnderlyingType, match)
                    }
                    case annotated is NullabilityAnnotatedTypeSymbol {
                        return AnyTypeParameter(annotated.BaseType, match)
                    }
                    case seq is SequenceTypeSymbol {
                        return AnyTypeParameter(seq.ElementType, match)
                    }
                    case aseq is AsyncSequenceTypeSymbol {
                        return AnyTypeParameter(aseq.ElementType, match)
                    }
                    case channel is ChannelTypeSymbol {
                        return AnyTypeParameter(channel.ElementType, match)
                    }
                    case m is MapTypeSymbol {
                        return AnyTypeParameter(m.KeyType, match) || AnyTypeParameter(m.ValueType, match)
                    }
                    case fn is FunctionTypeSymbol {
                        for param in fn.ParameterTypes {
                            if AnyTypeParameter(param, match) {
                                return true
                            }
                        }
                        return AnyTypeParameter(fn.ReturnType, match)
                    }
                    case tup is TupleTypeSymbol {
                        // Issue #813: value-tuple element types must propagate
                        // "contains type parameter" so callers like
                        // `ImportedTypeSymbol.HasTypeParameterArgument` route a
                        // wrapping `IEnumerable[(int32, T)]` through the
                        // type-spec encoder instead of falling back to the
                        // type-erased `IEnumerable<object>` shape.
                        for elem in tup.ElementTypes {
                            if AnyTypeParameter(elem, match) {
                                return true
                            }
                        }
                        return false
                    }
                    case br is ByRefTypeSymbol {
                        return AnyTypeParameter(br.PointeeType, match)
                    }
                    case pointer is PointerTypeSymbol {
                        return AnyTypeParameter(pointer.PointeeType, match)
                    }
                    case functionPointer is FunctionPointerTypeSymbol {
                        for parameterType in functionPointer.ParameterTypes {
                            if AnyTypeParameter(parameterType, match) {
                                return true
                            }
                        }
                        return AnyTypeParameter(functionPointer.ReturnType, match)
                    }
                    case en is EnumSymbol when !en.EnclosingTypeArguments.IsDefaultOrEmpty {
                        for arg in en.EnclosingTypeArguments {
                            if AnyTypeParameter(arg, match) {
                                return true
                            }
                        }
                        return false
                    }
                    case st is StructSymbol when !st
                        .EnclosingTypeArguments
                        .IsDefaultOrEmpty ||
                        !st
                        .TypeArguments
                        .IsDefaultOrEmpty {
                        for arg in st.EnclosingTypeArguments {
                            if AnyTypeParameter(arg, match) {
                                return true
                            }
                        }
                        for arg in st.TypeArguments {
                            if AnyTypeParameter(arg, match) {
                                return true
                            }
                        }
                        return false
                    }
                    case iface is InterfaceSymbol when !iface.TypeArguments.IsDefaultOrEmpty {
                        for arg in iface.TypeArguments {
                            if AnyTypeParameter(arg, match) {
                                return true
                            }
                        }
                        return false
                    }
                    case del is DelegateTypeSymbol {
                        for arg in del.TypeArguments {
                            if AnyTypeParameter(arg, match) {
                                return true
                            }
                        }
                        // Read declaration signatures, never force constructed projection:
                        // wrapper builders can call this query during that same projection.
                        // Bound formal slots are covered by actual arguments above.
                        let definition = del.Definition ?? del
                        let boundParameters = Math.Min(definition.TypeParameters.Length, del.TypeArguments.Length)
                        // An unbound definition can still expose used formal slots.
                        visitedDelegates ??= HashSet[(DelegateTypeSymbol, int32)]()
                        if !visitedDelegates!!.Add((definition, boundParameters)) {
                            return false
                        }
                        let MatchSignatureParameter = func (parameter TypeParameterSymbol) bool {
                            let index = definition.TypeParameters.IndexOf(parameter)
                            return (index < 0 || index >= boundParameters) && originalMatch(parameter)
                        }
                        for param in definition.Parameters {
                            if AnyTypeParameter(param.Type, MatchSignatureParameter) {
                                return true
                            }
                        }
                        return AnyTypeParameter(definition.ReturnType, MatchSignatureParameter)
                    }
                    case it is ImportedTypeSymbol when !it.TypeArguments.IsDefaultOrEmpty {
                        for arg in it.TypeArguments {
                            if AnyTypeParameter(arg, match) {
                                return true
                            }
                        }
                        return false
                    }
                    default {
                        return false
                    }
                }
            }
            return AnyTypeParameter(type, match)
        }

        /// #313: returns `true` if [`type`](paramref) is, or structurally
        /// contains, an in-scope generic (cref:TypeParameterSymbol) (e.g.
        /// `T`, `T?`, `[]T`, or `List[T]`). Such a type is an
        /// open/partially-constructed generic whose emit form is type-erased to
        /// `System.Object` under the type-erased generic model (ADR-0004).
        /// @param type The type to inspect.
        /// @returns `true` if the type references an in-scope type parameter.
        func ContainsTypeParameter(type TypeSymbol) bool -> AnyTypeParameter(
            type,
            (_ TypeParameterSymbol) -> {
                return true
            }
        )

        /// Issue #4095: returns `true` when [`type`](paramref)
        /// denotes a CLR unbound generic definition rather than a construction
        /// whose identity depends on an in-scope type parameter.
        /// @remarks Source nested types can be unbound definitions because of generic
        /// containing types even when they declare no parameters themselves
        /// (`Outer[_].Inner`). Constructed symbols are excluded by their
        /// explicit argument vectors before the containing-type chain is checked.
        /// @param type The candidate type.
        /// @returns `true` for a representable unbound generic definition.
        func IsUnboundGenericDefinition(type TypeSymbol) bool {
            if type.ClrType is {IsGenericTypeDefinition: true} {
                return true
            }
            let isUnconstructedSourceType = switch type {
                case structType is StructSymbol: structType
                    .EnclosingTypeArguments
                    .IsDefaultOrEmpty &&
                    structType
                    .TypeArguments
                    .IsDefaultOrEmpty
                case enumType is EnumSymbol: enumType.EnclosingTypeArguments.IsDefaultOrEmpty
                case interfaceType is InterfaceSymbol: interfaceType.TypeArguments.IsDefaultOrEmpty
                case delegateType is DelegateTypeSymbol: delegateType.TypeArguments.IsDefaultOrEmpty
                default: false
            }
            if !isUnconstructedSourceType {
                return false
            }
            let declaresTypeParameters = switch type {
                case structType is StructSymbol: !structType.TypeParameters.IsDefaultOrEmpty
                case enumType is EnumSymbol: !enumType.TypeParameters.IsDefaultOrEmpty
                case interfaceType is InterfaceSymbol: !interfaceType.TypeParameters.IsDefaultOrEmpty
                case delegateType is DelegateTypeSymbol: !delegateType.TypeParameters.IsDefaultOrEmpty
                default: false
            }
            return declaresTypeParameters ||
                (type.ContainingType is {} containingType && IsUnboundGenericDefinition(containingType))
        }

        /// ADR-0172: returns `true` when [`type`](paramref)
        /// structurally contains a tuple with declared element names. Named
        /// tuples share their CLR backing with the unnamed shape, so CLR-driven
        /// re-derivation (member projection, imported-call return mapping) erases
        /// the names; gates that decide between "keep the symbolic projection"
        /// and "fall back to the CLR shape" must treat named-tuple content like
        /// symbolically-required content.
        /// @param type The type to inspect.
        /// @returns `true` when any tuple position declares a name.
        func ContainsNamedTupleElements(type TypeSymbol?) bool -> switch type {
            case nil: false
            case tuple is TupleTypeSymbol: tuple.HasNames || tuple.ElementTypes.Any(ContainsNamedTupleElements)
            case nullable is NullableTypeSymbol: ContainsNamedTupleElements(nullable.UnderlyingType)
            case array is ArrayTypeSymbol: ContainsNamedTupleElements(array.ElementType)
            case slice is SliceTypeSymbol: ContainsNamedTupleElements(slice.ElementType)
            case rectangular is RectangularArrayTypeSymbol: ContainsNamedTupleElements(rectangular.ElementType)
            case map_ is MapTypeSymbol: ContainsNamedTupleElements(map_.KeyType) ||
                ContainsNamedTupleElements(map_.ValueType)
            case sequence_ is SequenceTypeSymbol: ContainsNamedTupleElements(sequence_.ElementType)
            case asyncSequence is AsyncSequenceTypeSymbol: ContainsNamedTupleElements(asyncSequence.ElementType)
            case channel is ChannelTypeSymbol: ContainsNamedTupleElements(channel.ElementType)
            case byRef is ByRefTypeSymbol: ContainsNamedTupleElements(byRef.PointeeType)
            case function is FunctionTypeSymbol: function.ParameterTypes.Any(ContainsNamedTupleElements) ||
                ContainsNamedTupleElements(function.ReturnType)
            case ImportedTypeSymbol{TypeArguments: {IsDefaultOrEmpty: false}} imported: imported.TypeArguments.Any(
                ContainsNamedTupleElements
            )
            default: false
        }

        /// Issue #3962: returns `true` when [`type`](paramref)
        /// structurally contains a fixed-length array `[N]T`.
        ///
        /// `[N]T` is the one G# type whose CLR projection is LOSSY. An
        /// (cref:ArrayTypeSymbol) is backed by the plain SZ-array
        /// `T[]` — the very same (cref:Type) as the slice `[]T`
        /// and as an array of every other length — so the declared length lives
        /// ONLY in the symbol. Every other structural wrapper's CLR type is
        /// injective: a channel's direction selects a different BCL type, a
        /// rectangular array's rank is part of its (cref:Type), and
        /// `seq[T]` / `map[K,V]` / `T?` / `T&` / `T*`
        /// each map to a distinct shape.
        ///
        /// Gates that decide between "keep the symbolic projection" and
        /// "fall back to the CLR shape" must therefore treat a fixed array like
        /// symbolically-required content — exactly as
        /// (cref:ContainsNamedTupleElements) does for a named tuple, and
        /// for the same reason. Without that, `List[[3]int32]` and
        /// `List[[4]int32]` both bind to the one cached symbol for
        /// `List<System.Int32[]>` and become the same type.
        /// @param type The type to inspect.
        /// @returns `true` when a fixed-length array appears at any depth.
        func ContainsFixedLengthArray(type TypeSymbol?) bool {
            if type is ArrayTypeSymbol {
                return true
            }
            if type == nil {
                return false
            }
            for inner in GetWrappedTypes(type) {
                if ContainsFixedLengthArray(inner) {
                    return true
                }
            }
            return false
        }

        /// Issue #4024: returns `true` when [`type`](paramref)
        /// structurally contains EITHER G#-native array spelling — a fixed-length
        /// `[N]T` or a slice `[]T`.
        ///
        /// This is the RETENTION predicate, and it is deliberately wider than
        /// (cref:ContainsFixedLengthArray), which stays the COMPARISON
        /// predicate. The one SZ-array CLR type `T[]` backs `[]T` and
        /// `[N]T` at every length alike, so a generic type argument written in
        /// either spelling projects onto the same closed CLR shape. #3962 retained
        /// only `[N]T`, which made `List[[3]int32]` and
        /// `List[[4]int32]` distinct but left `List[[]int32]` carrying no
        /// symbolic argument at all — and a constructed generic with an EMPTY
        /// symbolic argument vector is exactly what a metadata-recovered
        /// `List<int[]>` looks like, so
        /// (cref:ContainsMetadataRecoveredArray) correctly declared the
        /// shape unknowable and kept the lenient CLR comparison. Retaining the
        /// slice is therefore not an optimisation: it is the only thing that makes
        /// a source-spelled `[]T` argument DISTINGUISHABLE from a reflected
        /// one, and so comparable against a retained `[N]T` at all.
        ///
        /// Retention alone is a representation change, not a rule change. A
        /// (cref:SliceTypeSymbol) has a real, non-null
        /// (cref:TypeSymbol.ClrType) and satisfies neither
        /// (cref:RequiresSymbolicProjection) nor the nested-generic or
        /// named-tuple arms of
        /// `ImportedTypeSymbol.HasSubstitutableTypeArgument`, so that property
        /// stays `false` for `List[[]T]`, so the member
        /// projection sites that CONSULT it — parameters, indexers, iteration —
        /// are untouched, exactly as they were for `List[[N]T]` after #3962.
        /// A method RETURN is the exception, and is the one place retention is
        /// observable beyond type identity: `GetClrMethodReturnTypeSymbol`
        /// projects on a nonempty symbolic vector without consulting that
        /// property, so `Stack[[]T]().Pop()` surfaces the retained
        /// `[]T`. Deliberate and pinned; see
        /// `Issue4024SliceTypeArgumentRetentionTests`.
        /// @param type The type to inspect.
        /// @returns `true` when a slice or fixed-length array appears at any depth.
        func ContainsSourceArrayShape(type TypeSymbol?) bool {
            if (type is ArrayTypeSymbol or SliceTypeSymbol) {
                return true
            }
            if type == nil {
                return false
            }
            for inner in GetWrappedTypes(type) {
                if ContainsSourceArrayShape(inner) {
                    return true
                }
            }
            return false
        }

        /// Issue #3962: returns `true` when [`type`](paramref)
        /// structurally contains an array that came back through REFLECTION —
        /// an (cref:ImportedTypeSymbol) whose (cref:TypeSymbol.ClrType)
        /// is an array — rather than as a G#-native `[N]T`/`[]T` symbol.
        ///
        /// Such an array's length is not merely unread but GONE: metadata
        /// records only `T[]`, so no downstream comparison can reconstruct
        /// whether the author wrote `[3]T`, `[4]T` or `[]T`. A
        /// comparison with such a side must therefore stay LENIENT rather than
        /// reject on information neither side has — the same line
        /// `Conversion.AreSameRuntimeChannelElement` draws for a
        /// metadata-recovered channel element.
        /// @param type The type to inspect.
        /// @returns `true` when a reflection-recovered array appears at any depth.
        func ContainsMetadataRecoveredArray(type TypeSymbol?) bool {
            let ClrTypeContainsArray = func (clr Type?) bool {
                if clr == nil {
                    return false
                }
                if clr.IsArray {
                    return true
                }
                var arguments[]Type
                try {
                    if !clr.IsGenericType || clr.IsGenericTypeDefinition {
                        return false
                    }
                    arguments = clr.GetGenericArguments()
                } catch (NotSupportedException) {
                    // A TypeBuilder instantiation cannot be reflected over mid-emit.
                    return false
                }
                for argument in arguments {
                    if ClrTypeContainsArray(argument) {
                        return true
                    }
                }
                return false
            }
            if type is ImportedTypeSymbol imported {
                if imported.ClrType is {IsArray: true} {
                    return true
                }
                // A CONSTRUCTED generic recovered from metadata carries no
                // symbolic type-argument vector at all, so
                // <see cref="GetWrappedTypes"/> yields nothing for it and a nested
                // array would be missed — `List<List<int[]>>` is exactly as
                // length-less as the bare `int[]` one level up, and must be treated
                // the same way. Its CLR arguments are the only description it has,
                // so read those.
                if imported.TypeArguments.IsDefaultOrEmpty && ClrTypeContainsArray(imported.ClrType) {
                    return true
                }
            }
            if type == nil {
                return false
            }
            for inner in GetWrappedTypes(type) {
                if ContainsMetadataRecoveredArray(inner) {
                    return true
                }
            }
            return false
        }

        /// Issue #810 / #1481: returns `true` when
        /// [`type`](paramref) structurally references any of the supplied
        /// [`outerMethodTypeParameters`](paramref). Used by the iterator
        /// state-machine emitter to decide whether the `GetEnumerator` return
        /// and the SM's `IEnumerable<…>` / `IEnumerator<…>`
        /// interface rows need a symbolic (TypeSpec-encoded) strongly-typed shape
        /// rather than the CLR-erased `<object>` form. Shares the single
        /// (cref:AnyTypeParameter) walker with
        /// (cref:ContainsTypeParameter); only the leaf predicate differs.
        /// @param type The type to inspect.
        /// @param outerMethodTypeParameters The outer method's in-scope type parameters.
        /// @returns `true` if the type references one of the outer-method type parameters.
        func ContainsOuterMethodTypeParameter(
            type TypeSymbol,
            outerMethodTypeParameters ImmutableArray[TypeParameterSymbol]
        ) bool {
            if outerMethodTypeParameters.IsDefaultOrEmpty {
                return false
            }
            return AnyTypeParameter(
                type,
                (parameter TypeParameterSymbol) -> {
                    return outerMethodTypeParameters.Contains(parameter)
                }
            )
        }

        /// Issue #1477: collects, in stable first-seen order, every distinct
        /// (cref:TypeParameterSymbol) structurally referenced by
        /// [`type`](paramref) — recursing through nullable / slice / array /
        /// map / function / tuple wrappers and the type arguments of constructed
        /// user ((cref:StructSymbol) / (cref:InterfaceSymbol) /
        /// (cref:DelegateTypeSymbol)) and imported generic types. Used by
        /// the closure / capture-box emitter to discover which enclosing type
        /// parameters a synthesized display class must be made generic over.
        /// @param type The type to inspect (may be `null`).
        /// @param sink The ordered set to add referenced type parameters to.
        func CollectReferencedTypeParameters(
            type TypeSymbol?,
            sink List[TypeParameterSymbol]
        ) -> CollectReferencedTypeParameters(type, sink, nil)

        /// Issue #903: returns `true` when [`type`](paramref) is, or
        /// structurally contains, a user-defined type declared in the
        /// <em>current compilation</em> that has no CLR backing yet (its
        /// (cref:ClrType) is `null` because the type is
        /// still being compiled) — a (cref:StructSymbol) (struct or class),
        /// (cref:EnumSymbol), (cref:InterfaceSymbol), or
        /// (cref:DelegateTypeSymbol).
        ///
        /// Such a type is erased to `System.Object` (or its CLR ride-through)
        /// during reflection-based overload resolution, which loses its symbolic
        /// identity. This predicate is the same-compilation sibling of
        /// (cref:ContainsTypeParameter): it lets the binder recognise when a
        /// symbolic projection (recovered from a receiver's
        /// (cref:ImportedTypeSymbol.TypeArguments)) carries information the
        /// type-erased closed CLR shape cannot represent, so the projection must be
        /// surfaced instead of the erased reflection result. This is what makes
        /// `List[Check].Single((c) -> c.Id == "x")` and
        /// `List[Check].Select((c) -> c.Id)` recover the real
        /// `Check` element type for both the lambda parameter and the call's
        /// return type.
        ///
        /// In-scope generic (cref:TypeParameterSymbol)s (already covered by
        /// (cref:ContainsTypeParameter)) are intentionally excluded here.
        /// @param type The type to inspect.
        /// @returns `true` if the type references a same-compilation user type without CLR backing.
        func ContainsSameCompilationUserType(type TypeSymbol) bool {
            switch type {
                case nil, TypeParameterSymbol {
                    return false
                }
                case StructSymbol, EnumSymbol, InterfaceSymbol, DelegateTypeSymbol {
                    return type.ClrType == nil
                }
            }
            // Issue #1790: every other kind is a wrapper/constructed type — recurse
            // through its immediate inner type(s) via the single canonical
            // enumerator below instead of hand-copying a per-wrapper switch here.
            // This is what previously let Sequence/AsyncSequence/Channel/ByRef/
            // Pointer (whose CLR shape collapses to null when their element/
            // pointee is a same-compilation user type) fall through to the
            // "default: false" arm and alias across compilations (see
            // <see cref="FunctionTypeSymbol.AppendIdentityKey"/>).
            for inner in GetWrappedTypes(type) {
                if ContainsSameCompilationUserType(inner) {
                    return true
                }
            }
            return false
        }

        /// Issue #2498: returns `true` when [`type`](paramref) carries a
        /// nullable-reference annotation at any structural position. Unlike CLR
        /// `Nullable<T>`, reference nullability has no distinct runtime
        /// (cref:Type) shape, so reflection-only generic substitution cannot
        /// reproduce it after inference.
        /// @param type The type to inspect.
        /// @returns `true` when a nullable-reference wrapper is present.
        func ContainsReferenceNullableAnnotation(type TypeSymbol) bool {
            if type is PlatformTypeSymbol {
                // ADR-0186 §1: `T!` is reference-nullability information with no
                // distinct runtime `Type`, which is exactly the property this
                // predicate tests for. A gate that answered `false` here would let
                // reflection-only substitution re-derive `string` from a
                // `string!`, silently erasing the platform-ness.
                return true
            }
            if type is NullableTypeSymbol nullable {
                if !NullableLifting.IsAnyValueTypeNullable(nullable) {
                    return true
                }
                return ContainsReferenceNullableAnnotation(nullable.UnderlyingType)
            }
            for inner in GetWrappedTypes(type) {
                if ContainsReferenceNullableAnnotation(inner) {
                    return true
                }
            }
            return false
        }

        /// Returns whether a type contains the open `nil`-literal type.
        /// @param type The type to inspect.
        /// @returns `true` when [`type`](paramref) contains (cref:Null).
        func ContainsNullLiteralType(type TypeSymbol) bool {
            if type == Null {
                return true
            }
            for inner in GetWrappedTypes(type) {
                if ContainsNullLiteralType(inner) {
                    return true
                }
            }
            return false
        }

        /// Returns whether a type structurally contains a non-emittable `never` slot.
        /// @param type The type to inspect.
        /// @returns `true` when any wrapped type is (cref:Never).
        internal func ContainsNeverType(type TypeSymbol) bool {
            if type == Never {
                return true
            }
            for inner in GetWrappedTypes(type) {
                if ContainsNeverType(inner) {
                    return true
                }
            }
            return false
        }

        /// Compares runtime type identity while ignoring nullable-reference
        /// annotations, which are metadata-only and do not change a CLR signature.
        /// Nullable value types and every other structural distinction remain
        /// significant.
        /// @param left The first type.
        /// @param right The second type.
        /// @returns `true` when the runtime signatures are equivalent.
        func AreRuntimeEquivalentIgnoringReferenceNullability(left TypeSymbol?, right TypeSymbol?) bool {
            var left = left
            var right = right
            // Issue #4932: nil passes through, so a nil operand compares as in the C#
            // (equal only to nil) instead of throwing.
            let StripReferenceNullabilityCore = func (type TypeSymbol?) TypeSymbol? {
                var type = type
                while true {
                    switch type {
                        case annotated is NullabilityAnnotatedTypeSymbol {
                            type = annotated.BaseType
                            continue
                        }
                        case nullable is NullableTypeSymbol when !NullableLifting.IsAnyValueTypeNullable(nullable) {
                            type = nullable.UnderlyingType
                            continue
                        }
                        case platform is PlatformTypeSymbol {
                            // ADR-0186 §1: `T!` is a reference-nullability
                            // annotation with no runtime shape of its own — its
                            // `ClrType` is the underlying's — so a method whose
                            // whole purpose is comparing runtime signatures while
                            // IGNORING reference nullability must strip it. Leaving
                            // it would make `string!` and `string` compare as
                            // different runtime signatures, which they are not.
                            type = platform.UnderlyingType
                            continue
                        }
                        default {
                            return type
                        }
                    }
                }
            }
            let AreSameConstructedUserTypeCore = func (
                leftDefinition TypeSymbol,
                leftArguments ImmutableArray[TypeSymbol],
                rightDefinition TypeSymbol,
                rightArguments ImmutableArray[TypeSymbol]
            ) bool {
                if !object.ReferenceEquals(leftDefinition, rightDefinition) ||
                    leftArguments.Length != rightArguments.Length {
                    return false
                }
                for var i = 0; i < leftArguments.Length; i++ {
                    if !AreRuntimeEquivalentIgnoringReferenceNullability(leftArguments[i], rightArguments[i]) {
                        return false
                    }
                }
                return true
            }
            left = StripReferenceNullabilityCore(left)
            right = StripReferenceNullabilityCore(right)
            if object.ReferenceEquals(left, right) {
                return true
            }
            if left == nil || right == nil {
                return false
            }
            if left is FunctionPointerTypeSymbol || right is FunctionPointerTypeSymbol {
                return left is FunctionPointerTypeSymbol leftPointer &&
                    right is FunctionPointerTypeSymbol rightPointer &&
                    leftPointer.SignatureEquals(rightPointer, AreRuntimeEquivalentIgnoringReferenceNullability)
            }
            let leftIsSequence = SequenceTypeSymbol.TryGetEnumerableInterfaceShape(
                left,
                out var leftSequenceDefinition,
                out var leftSequenceElement
            )
            let rightIsSequence = SequenceTypeSymbol.TryGetEnumerableInterfaceShape(
                right,
                out var rightSequenceDefinition,
                out var rightSequenceElement
            )
            if leftIsSequence || rightIsSequence {
                return leftIsSequence && rightIsSequence && ClrTypeUtilities.AreSame(
                    leftSequenceDefinition,
                    rightSequenceDefinition
                ) &&
                    AreRuntimeEquivalentIgnoringReferenceNullability(leftSequenceElement, rightSequenceElement)
            }
            if left is NullableTypeSymbol || right is NullableTypeSymbol {
                let leftNullable NullableTypeSymbol? = left as NullableTypeSymbol
                let rightNullable NullableTypeSymbol? = right as NullableTypeSymbol
                return leftNullable != nil &&
                    rightNullable != nil &&
                    AreRuntimeEquivalentIgnoringReferenceNullability(
                    leftNullable.UnderlyingType,
                    rightNullable.UnderlyingType
                )
            }
            if left is StructSymbol leftStruct && right is StructSymbol rightStruct {
                return AreSameConstructedUserTypeCore(
                    leftStruct.Definition ?? leftStruct,
                    leftStruct.TypeArguments,
                    rightStruct.Definition ?? rightStruct,
                    rightStruct.TypeArguments
                )
            }
            if left is EnumSymbol leftEnum && right is EnumSymbol rightEnum {
                return AreSameConstructedUserTypeCore(
                    leftEnum.Definition ?? leftEnum,
                    leftEnum.EnclosingTypeArguments,
                    rightEnum.Definition ?? rightEnum,
                    rightEnum.EnclosingTypeArguments
                )
            }
            if left is InterfaceSymbol leftInterface && right is InterfaceSymbol rightInterface {
                return AreSameConstructedUserTypeCore(
                    leftInterface.Definition ?? leftInterface,
                    leftInterface.TypeArguments,
                    rightInterface.Definition ?? rightInterface,
                    rightInterface.TypeArguments
                )
            }
            if left is DelegateTypeSymbol leftDelegate && right is DelegateTypeSymbol rightDelegate {
                return AreSameConstructedUserTypeCore(
                    leftDelegate.Definition ?? leftDelegate,
                    leftDelegate.TypeArguments,
                    rightDelegate.Definition ?? rightDelegate,
                    rightDelegate.TypeArguments
                )
            }
            if left is ImportedTypeSymbol{OpenDefinition: not nil} leftImported &&
                !leftImported
                .TypeArguments
                .IsDefaultOrEmpty &&
                right is ImportedTypeSymbol{OpenDefinition: not nil} rightImported &&
                !rightImported
                .TypeArguments
                .IsDefaultOrEmpty {
                return ClrTypeUtilities.AreSame(leftImported.OpenDefinition, rightImported.OpenDefinition) &&
                    leftImported
                    .TypeArguments
                    .Length == rightImported
                    .TypeArguments
                    .Length &&
                    leftImported
                    .TypeArguments
                    .Zip(rightImported.TypeArguments)
                    .All(
                    (pair(First TypeSymbol, Second TypeSymbol)) -> AreRuntimeEquivalentIgnoringReferenceNullability(
                        pair.First,
                        pair.Second
                    )
                )
            }
            if left.GetType() != right.GetType() {
                return MemberLookup.IsNaturalStructuralDelegateTarget(left, right) ||
                    MemberLookup.IsNaturalStructuralDelegateTarget(right, left)
            }
            if left is ChannelTypeSymbol leftChannel &&
                right is ChannelTypeSymbol rightChannel &&
                leftChannel.Direction != rightChannel.Direction {
                return false
            }
            if left is ArrayTypeSymbol leftArray &&
                right is ArrayTypeSymbol rightArray &&
                leftArray.Length != rightArray.Length {
                return false
            }
            if left is RectangularArrayTypeSymbol leftRectangular &&
                right is RectangularArrayTypeSymbol rightRectangular &&
                leftRectangular.Rank != rightRectangular.Rank {
                return false
            }
            if left is FunctionTypeSymbol leftFunction &&
                right is FunctionTypeSymbol rightFunction &&
                !leftFunction
                .IsVariadic
                .SequenceEqual(rightFunction.IsVariadic) {
                return false
            }
            let leftParts = GetWrappedTypes(left).ToArray()
            let rightParts = GetWrappedTypes(right).ToArray()
            if leftParts.Length > 0 || rightParts.Length > 0 {
                if leftParts.Length != rightParts.Length ||
                    (
                    left.ClrType != nil && right.ClrType != nil && !ClrTypeUtilities.AreSame(
                        left.ClrType,
                        right.ClrType
                    )
                ) {
                    return false
                }
                for var i = 0; i < leftParts.Length; i++ {
                    if !AreRuntimeEquivalentIgnoringReferenceNullability(leftParts[i], rightParts[i]) {
                        return false
                    }
                }
                return true
            }
            return left.ClrType != nil && right.ClrType != nil && ClrTypeUtilities.AreSame(left.ClrType, right.ClrType)
        }

        /// Returns `true` when a symbolic type projection contains information
        /// that its CLR (cref:Type) cannot faithfully represent.
        /// @param type The type to inspect.
        /// @returns `true` when symbolic substitution must be retained.
        func RequiresSymbolicProjection(type TypeSymbol) bool -> ContainsTypeParameter(type) ||
            ContainsSameCompilationUserType(type) ||
            ContainsReferenceNullableAnnotation(type) ||
            ContainsFunctionPointer(type)

        private func ContainsFunctionPointer(type TypeSymbol) bool -> type is FunctionPointerTypeSymbol ||
            GetWrappedTypes(type).Any(ContainsFunctionPointer)

        /// Issue #3746 / ADR-0172: returns `true` when [`type`](paramref)
        /// carries tuple element names at any structural position. Like reference
        /// nullability, element names are metadata over the positional shape and
        /// have no distinct runtime (cref:Type), so any projection that
        /// round-trips a type through its CLR (cref:Type) silently erases
        /// them. Callers that rebuild a type from reflection must consult this and
        /// take their symbolic path instead.
        /// @remarks This deliberately is <em>not</em> folded into
        /// (cref:RequiresSymbolicProjection(TypeSymbol)): that predicate also
        /// gates (cref:TupleTypeSymbol)'s own CLR backing, and a named tuple
        /// must keep its `ValueTuple<…>` (cref:ClrType) — names
        /// never change the runtime type (ADR-0172).
        /// @param type The type to inspect.
        /// @returns `true` when a named tuple appears anywhere in the type.
        func ContainsNamedTupleElement(type TypeSymbol) bool {
            if type is TupleTypeSymbol && type.HasNames == true {
                return true
            }
            for inner in GetWrappedTypes(type) {
                if ContainsNamedTupleElement(inner) {
                    return true
                }
            }
            return false
        }

        /// Returns true when [`type`](paramref) — after unwrapping nullable,
        /// slice and array wrappers — is itself a same-compilation user-defined
        /// type (struct/class/enum/interface/delegate with a null `ClrType`).
        /// Unlike (cref:ContainsSameCompilationUserType), this does NOT
        /// recurse into the type arguments of a constructed imported generic: a
        /// constructed generic over a user element (e.g. `ChannelWriter[Entry]`)
        /// is NOT a top-level user type, because method/extension lookup on such a
        /// non-interned constructed generic is not yet supported (#1305).
        /// @param type The type to inspect.
        /// @returns `true` if the unwrapped top-level type is a same-compilation
        /// user-defined type; otherwise `false`.
        func IsSameCompilationUserTypeTopLevel(type TypeSymbol) bool {
            switch type {
                case nil {
                    return false
                }
                case n is NullableTypeSymbol {
                    return IsSameCompilationUserTypeTopLevel(n.UnderlyingType)
                }
                case p is PlatformTypeSymbol {
                    // ADR-0186 §1: `T!` unwraps here for the same reason `T?` does.
                    // Unreachable until ADR-0186 §9 makes an `@Oblivious` G# source
                    // declaration platform-typed (today the only producer is the
                    // metadata reader, whose results are always imported), but the
                    // unwrap list must not be the one place the wrapper is missing.
                    return IsSameCompilationUserTypeTopLevel(p.UnderlyingType)
                }
                case s is SliceTypeSymbol {
                    return IsSameCompilationUserTypeTopLevel(s.ElementType)
                }
                case a is ArrayTypeSymbol {
                    return IsSameCompilationUserTypeTopLevel(a.ElementType)
                }
                case a is RectangularArrayTypeSymbol {
                    return IsSameCompilationUserTypeTopLevel(a.ElementType)
                }
                case StructSymbol, EnumSymbol, InterfaceSymbol, DelegateTypeSymbol {
                    return type.ClrType == nil
                }
                default {
                    return false
                }
            }
        }

        /// Recursively substitutes immediate children of built-in composite types.
        /// Construction-specific callers remain responsible for user/imported
        /// generic symbols, while every shared wrapper shape is rebuilt here.
        /// @param type Potential composite type.
        /// @param substitute Recursive substitution callback.
        /// @param result Rebuilt type, or [`type`](paramref) when unchanged/unrecognized.
        /// @returns Whether [`type`](paramref) is a handled composite shape.
        internal func TrySubstituteCompositeType(
            type TypeSymbol,
            substitute(TypeSymbol) -> TypeSymbol,
            out result TypeSymbol
        ) bool {
            result = type
            switch type {
                case nullable is NullableTypeSymbol {
                    let nullableInner = substitute(nullable.UnderlyingType)
                    result = if object.ReferenceEquals(nullableInner, nullable.UnderlyingType) {
                        type
                    } else {
                        cast[TypeSymbol](NullableTypeSymbol.Get(nullableInner))
                    }
                    return true
                }
                case platform is PlatformTypeSymbol {
                    // ADR-0186 §1: `T!` is a wrapper exactly like `T?`, and this is
                    // the WRITER half of the walk `GetWrappedTypes` reads. Omitting
                    // it here while the readers know about the wrapper is the worse
                    // failure of the two: the readers would report that a `T!` over
                    // a type parameter CONTAINS one, this method would answer "not a
                    // composite shape", and the caller would keep the unsubstituted
                    // type — a silently wrong answer rather than a missed one.
                    let platformInner = substitute(platform.UnderlyingType)
                    result = if object.ReferenceEquals(platformInner, platform.UnderlyingType) {
                        type
                    } else {
                        PlatformTypeSymbol.Get(platformInner)
                    }
                    return true
                }
                case slice is SliceTypeSymbol {
                    let sliceElement = substitute(slice.ElementType)
                    result = if object.ReferenceEquals(sliceElement, slice.ElementType) {
                        type
                    } else {
                        cast[TypeSymbol](SliceTypeSymbol.Get(sliceElement))
                    }
                    return true
                }
                case array is ArrayTypeSymbol {
                    let arrayElement = substitute(array.ElementType)
                    result = if object.ReferenceEquals(arrayElement, array.ElementType) {
                        type
                    } else {
                        cast[TypeSymbol](ArrayTypeSymbol.Get(arrayElement, array.Length))
                    }
                    return true
                }
                case rectangular is RectangularArrayTypeSymbol {
                    let rectangularElement = substitute(rectangular.ElementType)
                    result = if object.ReferenceEquals(rectangularElement, rectangular.ElementType) {
                        type
                    } else {
                        cast[TypeSymbol](RectangularArrayTypeSymbol.Get(rectangularElement, rectangular.Rank))
                    }
                    return true
                }
                case pinned is PinnedTypeSymbol {
                    let pinnedInner = substitute(pinned.UnderlyingType)
                    result = if object.ReferenceEquals(pinnedInner, pinned.UnderlyingType) {
                        type
                    } else {
                        cast[TypeSymbol](PinnedTypeSymbol(pinnedInner))
                    }
                    return true
                }
                case annotated is NullabilityAnnotatedTypeSymbol {
                    let annotatedBase = substitute(annotated.BaseType)
                    result = if object.ReferenceEquals(annotatedBase, annotated.BaseType) {
                        type
                    } else {
                        cast[TypeSymbol](NullabilityAnnotatedTypeSymbol(annotatedBase, annotated.NullableFlags))
                    }
                    return true
                }
                case sequence_ is SequenceTypeSymbol {
                    let sequenceElement = substitute(sequence_.ElementType)
                    result = if object.ReferenceEquals(sequenceElement, sequence_.ElementType) {
                        type
                    } else {
                        cast[TypeSymbol](SequenceTypeSymbol.Get(sequenceElement))
                    }
                    return true
                }
                case asyncSequence is AsyncSequenceTypeSymbol {
                    let asyncSequenceElement = substitute(asyncSequence.ElementType)
                    result = if object.ReferenceEquals(asyncSequenceElement, asyncSequence.ElementType) {
                        type
                    } else {
                        cast[TypeSymbol](AsyncSequenceTypeSymbol.Get(asyncSequenceElement))
                    }
                    return true
                }
                case channel is ChannelTypeSymbol {
                    let channelElement = substitute(channel.ElementType)
                    result = if object.ReferenceEquals(channelElement, channel.ElementType) {
                        type
                    } else {
                        cast[TypeSymbol](ChannelTypeSymbol.Get(channelElement, channel.Direction))
                    }
                    return true
                }
                case map_ is MapTypeSymbol {
                    let mapKey = substitute(map_.KeyType)
                    let mapValue = substitute(map_.ValueType)
                    result = if object.ReferenceEquals(mapKey, map_.KeyType) && object.ReferenceEquals(
                        mapValue,
                        map_.ValueType
                    ) {
                        type
                    } else {
                        cast[TypeSymbol](MapTypeSymbol.Get(mapKey, mapValue))
                    }
                    return true
                }
                case tuple is TupleTypeSymbol {
                    let tupleElements = ImmutableArray.CreateBuilder[TypeSymbol](tuple.ElementTypes.Length)
                    var tupleChanged = false
                    for elementType in tuple.ElementTypes {
                        let substitutedElement = substitute(elementType)
                        tupleElements.Add(substitutedElement)
                        tupleChanged |= !object.ReferenceEquals(substitutedElement, elementType)
                    }
                    result = if tupleChanged {
                        cast[TypeSymbol](TupleTypeSymbol.Get(tupleElements.MoveToImmutable(), tuple.ElementNames))
                    } else {
                        type
                    }
                    return true
                }
                case byRef is ByRefTypeSymbol {
                    let byRefPointee = substitute(byRef.PointeeType)
                    result = if object.ReferenceEquals(byRefPointee, byRef.PointeeType) {
                        type
                    } else {
                        cast[TypeSymbol](ByRefTypeSymbol.Get(byRefPointee))
                    }
                    return true
                }
                case pointer is PointerTypeSymbol {
                    let pointerPointee = substitute(pointer.PointeeType)
                    result = if object.ReferenceEquals(pointerPointee, pointer.PointeeType) {
                        type
                    } else {
                        cast[TypeSymbol](PointerTypeSymbol.Get(pointerPointee))
                    }
                    return true
                }
                case function is FunctionTypeSymbol {
                    let functionParameters = ImmutableArray.CreateBuilder[TypeSymbol](function.ParameterTypes.Length)
                    var functionChanged = false
                    for parameterType in function.ParameterTypes {
                        let substitutedParameter = substitute(parameterType)
                        functionParameters.Add(substitutedParameter)
                        functionChanged |= !object.ReferenceEquals(substitutedParameter, parameterType)
                    }
                    let functionReturn = substitute(function.ReturnType)
                    functionChanged |= !object.ReferenceEquals(functionReturn, function.ReturnType)
                    result = if functionChanged {
                        cast[TypeSymbol](
                            FunctionTypeSymbol.Get(
                                functionParameters.MoveToImmutable(),
                                function.IsVariadic,
                                functionReturn
                            )
                        )
                    } else {
                        type
                    }
                    return true
                }
                case functionPointer is FunctionPointerTypeSymbol {
                    result = functionPointer.Substitute(substitute)
                    return true
                }
                default {
                    return false
                }
            }
        }

        /// Issue #1790: the single canonical enumeration of a wrapper/constructed
        /// (cref:TypeSymbol)'s immediate inner type(s) — the element,
        /// pointee, key/value, parameter/return, or type-argument slot(s) the
        /// composite type structurally carries. Every generic/wrapper kind that
        /// can carry another type is listed here exactly once so callers such as
        /// (cref:ContainsSameCompilationUserType) recurse uniformly rather
        /// than each maintaining its own divergent switch (the class of bug that
        /// let several wrapper kinds silently fall through as "no inner type").
        /// Leaf kinds (primitives, same-compilation user types, type parameters)
        /// are not wrappers and yield nothing here; their callers handle them
        /// directly. Each yielded type is a strict substructure of
        /// [`type`](paramref) (types form a DAG built during binding, never
        /// a cycle back to themselves), so recursive callers always terminate.
        /// @param type The wrapper/constructed type to unwrap.
        /// @returns The type's immediate inner type(s); empty for a leaf kind.
        internal func GetWrappedTypes(type TypeSymbol) sequence[TypeSymbol] {
            switch type {
                case n is NullableTypeSymbol {
                    yield Invariant.Required(
                        n.UnderlyingType,
                        "a nullable type has an underlying type",
                        expression: "n.UnderlyingType"
                    )
                }
                case p is PlatformTypeSymbol {
                    // ADR-0186 §1: `T!` is a wrapper exactly like `T?`, so it must
                    // appear in the single canonical unwrap or every `Contains*`
                    // walker that delegates here silently treats it as a leaf —
                    // the "wrapper kinds falling through as no inner type" bug
                    // #1790 centralised this switch to end.
                    yield Invariant.Required(
                        p.UnderlyingType,
                        "a platform type has an underlying type",
                        expression: "p.UnderlyingType"
                    )
                }
                case s is SliceTypeSymbol {
                    yield s.ElementType
                }
                case a is ArrayTypeSymbol {
                    yield a.ElementType
                }
                case a is RectangularArrayTypeSymbol {
                    yield a.ElementType
                }
                case p is PinnedTypeSymbol {
                    yield p.UnderlyingType
                }
                case na is NullabilityAnnotatedTypeSymbol {
                    yield na.BaseType
                }
                case seq is SequenceTypeSymbol {
                    yield seq.ElementType
                }
                case aseq is AsyncSequenceTypeSymbol {
                    yield aseq.ElementType
                }
                case ch is ChannelTypeSymbol {
                    yield ch.ElementType
                }
                case br is ByRefTypeSymbol {
                    yield br.PointeeType
                }
                case ptr is PointerTypeSymbol {
                    yield ptr.PointeeType
                }
                case m is MapTypeSymbol {
                    yield m.KeyType
                    yield m.ValueType
                }
                case fn is FunctionTypeSymbol {
                    for param in fn.ParameterTypes {
                        yield Invariant.Required(param, "a function parameter has a type", expression: "param")
                    }
                    yield Invariant.Required(fn.ReturnType, "a function has a return type", expression: "fn.ReturnType")
                }
                case fp is FunctionPointerTypeSymbol {
                    for param in fp.ParameterTypes {
                        yield Invariant.Required(param, "a function-pointer parameter has a type", expression: "param")
                    }
                    yield Invariant.Required(
                        fp.ReturnType,
                        "a function pointer has a return type",
                        expression: "fp.ReturnType"
                    )
                }
                case tup is TupleTypeSymbol {
                    for elem in tup.ElementTypes {
                        yield Invariant.Required(elem, "a tuple element has a type", expression: "elem")
                    }
                }
                case it is ImportedTypeSymbol when !it.TypeArguments.IsDefaultOrEmpty {
                    for arg in it.TypeArguments {
                        yield Invariant.Required(arg, "an imported generic type argument has a type", expression: "arg")
                    }
                }
            }
        }

        /// Collects referenced parameters with an optional delegate traversal observer.
        /// @param type The type to inspect.
        /// @param sink The ordered set to add referenced type parameters to.
        /// @param onDelegateVisit Observes each actual delegate walk.
        internal func CollectReferencedTypeParameters(
            type TypeSymbol?,
            sink List[TypeParameterSymbol],
            onDelegateVisit((DelegateTypeSymbol) -> void)?
        ) {
            let AddParameter = func (parameter TypeParameterSymbol) {
                if !sink.Contains(parameter) {
                    sink.Add(parameter)
                }
            }
            let CollectReferencedTypeParameters = func (
                type TypeSymbol?,
                visitParameter((TypeParameterSymbol) -> void)?,
                signaturePath ImmutableHashSet[(Definition DelegateTypeSymbol, BoundParameters int32)]
            ) {
                switch type {
                    case nil {
                        return
                    }
                    case tp is TypeParameterSymbol {
                        if visitParameter is {} visit {
                            visit(tp)
                        } else {
                            AddParameter(tp)
                        }
                        return
                    }
                    case n is NullableTypeSymbol {
                        CollectReferencedTypeParameters(n.UnderlyingType, visitParameter, signaturePath)
                        return
                    }
                    case p is PlatformTypeSymbol {
                        // ADR-0186 §1: `T!` wraps exactly as `T?` does.
                        CollectReferencedTypeParameters(p.UnderlyingType, visitParameter, signaturePath)
                        return
                    }
                    case s is SliceTypeSymbol {
                        CollectReferencedTypeParameters(s.ElementType, visitParameter, signaturePath)
                        return
                    }
                    case a is ArrayTypeSymbol {
                        CollectReferencedTypeParameters(a.ElementType, visitParameter, signaturePath)
                        return
                    }
                    case a is RectangularArrayTypeSymbol {
                        CollectReferencedTypeParameters(a.ElementType, visitParameter, signaturePath)
                        return
                    }
                    case sq is SequenceTypeSymbol {
                        CollectReferencedTypeParameters(sq.ElementType, visitParameter, signaturePath)
                        return
                    }
                    case asq is AsyncSequenceTypeSymbol {
                        CollectReferencedTypeParameters(asq.ElementType, visitParameter, signaturePath)
                        return
                    }
                    case channel is ChannelTypeSymbol {
                        CollectReferencedTypeParameters(channel.ElementType, visitParameter, signaturePath)
                        return
                    }
                    case m is MapTypeSymbol {
                        CollectReferencedTypeParameters(m.KeyType, visitParameter, signaturePath)
                        CollectReferencedTypeParameters(m.ValueType, visitParameter, signaturePath)
                        return
                    }
                    case fn is FunctionTypeSymbol {
                        for param in fn.ParameterTypes {
                            CollectReferencedTypeParameters(param, visitParameter, signaturePath)
                        }
                        CollectReferencedTypeParameters(fn.ReturnType, visitParameter, signaturePath)
                        return
                    }
                    case tup is TupleTypeSymbol {
                        for elem in tup.ElementTypes {
                            CollectReferencedTypeParameters(elem, visitParameter, signaturePath)
                        }
                        return
                    }
                    case br is ByRefTypeSymbol {
                        CollectReferencedTypeParameters(br.PointeeType, visitParameter, signaturePath)
                        return
                    }
                    case es is EnumSymbol when !es.EnclosingTypeArguments.IsDefaultOrEmpty {
                        for arg in es.EnclosingTypeArguments {
                            CollectReferencedTypeParameters(arg, visitParameter, signaturePath)
                        }
                        return
                    }
                    case ss is StructSymbol {
                        if !ss.EnclosingTypeArguments.IsDefaultOrEmpty {
                            for arg in ss.EnclosingTypeArguments {
                                CollectReferencedTypeParameters(arg, visitParameter, signaturePath)
                            }
                        } else {
                            for tp in StructSymbol.CollectEnclosingTypeParameters(ss) {
                                CollectReferencedTypeParameters(tp, visitParameter, signaturePath)
                            }
                        }
                        for arg in ss.TypeArguments {
                            CollectReferencedTypeParameters(arg, visitParameter, signaturePath)
                        }
                        if ss.TypeArguments.IsDefaultOrEmpty {
                            for tp in ss.TypeParameters {
                                CollectReferencedTypeParameters(tp, visitParameter, signaturePath)
                            }
                        }
                        return
                    }
                    case iface is InterfaceSymbol when !iface.TypeArguments.IsDefaultOrEmpty {
                        for arg in iface.TypeArguments {
                            CollectReferencedTypeParameters(arg, visitParameter, signaturePath)
                        }
                        return
                    }
                    case ifaceOpen is InterfaceSymbol when !ifaceOpen.TypeParameters.IsDefaultOrEmpty {
                        for tp in ifaceOpen.TypeParameters {
                            CollectReferencedTypeParameters(tp, visitParameter, signaturePath)
                        }
                        return
                    }
                    case del is DelegateTypeSymbol {
                        onDelegateVisit?(del)
                        let definition = del.Definition ?? del
                        let boundParameters = Math.Min(definition.TypeParameters.Length, del.TypeArguments.Length)
                        let signatureKey = (definition, boundParameters)
                        let visitedArguments = [del.TypeArguments.Length]bool
                        // Signature uses and unused-argument fallback share one slot walk.
                        // Mark before descending, retaining its first signature position.
                        let VisitArgumentSlot = func (index int32) {
                            if (visitedArguments[index]) {
                                return
                            }
                            visitedArguments[index] = true
                            CollectReferencedTypeParameters(del.TypeArguments[index], visitParameter, signaturePath)
                        }
                        if !signaturePath.Contains(signatureKey) {
                            let declarationPath = signaturePath.Add(signatureKey)
                            // Resolve only formal leaves, retaining signature order without
                            // constructing types. An argument uses its containing mapping;
                            // its declaration path also belongs to that containing context.
                            // A definition's free parameter does not inherit the mapping.
                            let VisitSignatureParameter = func (parameter TypeParameterSymbol) {
                                let index = definition.TypeParameters.IndexOf(parameter)
                                if index >= 0 && index < boundParameters {
                                    VisitArgumentSlot(index)
                                } else {
                                    AddParameter(parameter)
                                }
                            }
                            for param in definition.Parameters {
                                CollectReferencedTypeParameters(param.Type, VisitSignatureParameter, declarationPath)
                            }
                            CollectReferencedTypeParameters(
                                definition.ReturnType,
                                VisitSignatureParameter,
                                declarationPath
                            )
                        }
                        for var index = 0; index < del.TypeArguments.Length; index++ {
                            VisitArgumentSlot(index)
                        }
                        return
                    }
                    case it is ImportedTypeSymbol when !it.TypeArguments.IsDefaultOrEmpty {
                        for arg in it.TypeArguments {
                            CollectReferencedTypeParameters(arg, visitParameter, signaturePath)
                        }
                        return
                    }
                    default {
                        return
                    }
                }
            }
            CollectReferencedTypeParameters(type, nil, ImmutableHashSet[(DelegateTypeSymbol, int32)].Empty)
        }

        /// ADR-0172 Phase B: internal surface of the #1922 CLR-tuple recognizer
        /// for (cref:TupleElementNamesReader) — an imported generic type
        /// argument surfaces as an imported `System.ValueTuple<…>`
        /// rather than a (cref:TupleTypeSymbol), and must be flattened
        /// before element names can be applied to it.
        /// @param clrType The candidate CLR type.
        /// @param tupleTypeSymbol The resulting tuple symbol, if matched.
        /// @returns `true` if [`clrType`](paramref) is a supported tuple shape.
        internal func TryGetTupleTypeSymbolFromClr(
            clrType Type,
            @NotNullWhen(true) out tupleTypeSymbol TupleTypeSymbol?
        ) bool -> TryGetTupleTypeSymbol(clrType, out tupleTypeSymbol)

        /// Issue #1922: recognizes a closed generic `System.ValueTuple<...>`
        /// or `System.Tuple<...>` CLR type and maps it onto the equivalent
        /// flat (cref:TupleTypeSymbol), including canonical arity-8+
        /// `TRest` nesting.
        /// @param clrType The candidate CLR type.
        /// @param tupleTypeSymbol The resulting tuple symbol, if matched.
        /// @returns `true` if [`clrType`](paramref) is a supported tuple shape.
        private func TryGetTupleTypeSymbol(clrType Type, @NotNullWhen(true) out tupleTypeSymbol TupleTypeSymbol?) bool {
            tupleTypeSymbol = nil
            if !clrType.IsGenericType || clrType.IsGenericTypeDefinition {
                return false
            }
            let elementTypes = ImmutableArray.CreateBuilder[TypeSymbol]()
            if !TryCollectTupleElements(clrType, elementTypes, allowSingleElementRest: false) {
                return false
            }
            tupleTypeSymbol = TupleTypeSymbol.Get(elementTypes.ToImmutable())
            return true
        }

        private func TryCollectTupleElements(
            clrType Type,
            elementTypes ImmutableArray[TypeSymbol].Builder,
            allowSingleElementRest bool
        ) bool {
            if !clrType.IsGenericType || clrType.IsGenericTypeDefinition {
                return false
            }
            let definitionName = clrType.UnderlyingSystemType.GetGenericTypeDefinition().FullName
            let isValueTuple = definitionName?.StartsWith("System.ValueTuple`", StringComparison.Ordinal) == true
            let isReferenceTuple = definitionName?.StartsWith("System.Tuple`", StringComparison.Ordinal) == true
            if !isValueTuple && !isReferenceTuple {
                return false
            }
            let arguments = clrType.GetGenericArguments()
            if arguments.Length == 1 {
                if !allowSingleElementRest {
                    return false
                }
                elementTypes.Add(FromClrTypeWithoutNullability(arguments[0], NullabilityFreeReason.TypeStructure))
                return true
            }
            if (arguments.Length is < 2 or > 8) {
                return false
            }
            let directCount = if arguments.Length == 8 {
                7
            } else {
                arguments.Length
            }
            for var i = 0; i < directCount; i++ {
                elementTypes.Add(FromClrTypeWithoutNullability(arguments[i], NullabilityFreeReason.TypeStructure))
            }
            return arguments.Length != 8 ||
                TryCollectTupleElements(arguments[7], elementTypes, allowSingleElementRest: true)
        }

        private func RenderClrType(type Type, format DisplayFormat) string {
            if type.IsGenericParameter {
                return type.Name
            }
            var name = type.Name
            let backtick = name.IndexOf('`')
            if backtick >= 0 {
                name = name.Substring(0, backtick)
            }
            var qualified = if format == DisplayFormat.FullyQualified && type.Namespace is {Length: > 0} ns {
                "global::$ns.$name"
            } else {
                name
            }
            if type.IsGenericType {
                let arguments = type.GetGenericArguments()
                let rendered = [arguments.Length]string
                for var i = 0; i < arguments.Length; i++ {
                    rendered[i] = RenderClrType(arguments[i], format)
                }
                qualified += "<" + string.Join(", ", rendered) + ">"
            }
            return qualified
        }
    }
}
