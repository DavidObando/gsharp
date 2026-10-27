// <copyright file="FunctionTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Concurrent
import System.Collections.Immutable
import System.Runtime.CompilerServices
import System.Text
import System.Threading

/// Represents a first-class function type `func(T1, T2, ...) R`
/// (Phase 4.7). Instances are cached and compared by structural equality of
/// parameter and return types so two textually identical type clauses share
/// the same (cref:FunctionTypeSymbol).
class FunctionTypeSymbol : TypeSymbol {
    private init(
        name string,
        parameterTypes ImmutableArray[TypeSymbol],
        isVariadic ImmutableArray[bool],
        returnType TypeSymbol
    ) : base(name, BuildClrType(parameterTypes, returnType)) {
        ParameterTypes = parameterTypes
        IsVariadic = isVariadic
        ReturnType = returnType
    }

    /// Gets the function's parameter types.
    prop ParameterTypes ImmutableArray[TypeSymbol] {
        get;
    }

    /// Gets the per-parameter variadic flags (ADR-0102 follow-up / issue #818).
    /// Always parallel to (cref:ParameterTypes) — entry `i` is
    /// `true` iff the corresponding parameter is the
    /// trailing variadic `...T` slot. All-`false` for
    /// a regular function type. The variadic slot's
    /// (cref:ParameterTypes) entry is the already-wrapped slice
    /// (`[]T`) so existing callers that just look at the parameter
    /// type continue to work; the flag is consulted at call sites to
    /// drive pack / pass-through.
    prop IsVariadic ImmutableArray[bool] {
        get;
    }

    /// Gets the function's return type. `void` when the function returns nothing.
    prop ReturnType TypeSymbol {
        get;
    }

    /// Gets the number of parameters.
    prop Arity int32 -> ParameterTypes.Length

    /// Gets a value indicating whether this function type declares a trailing variadic parameter.
    prop HasVariadic bool -> !IsVariadic.IsDefaultOrEmpty && IsVariadic[IsVariadic.Length - 1]

    shared {
        private let Cache ConcurrentDictionary[string, FunctionTypeSymbol] = ConcurrentDictionary[
            string,
            FunctionTypeSymbol
        ]()
        private let TypeParameterIds ConditionalWeakTable[TypeParameterSymbol, object] = ConditionalWeakTable[
            TypeParameterSymbol,
            object
        ]()

        // Issue #1457: a same-compilation user type (a struct/class/enum/interface/
        // delegate still being compiled) has no host CLR Type and is identified
        // across compilations only by its (re-usable) display name. Keying the
        // process-wide function-type cache by that name would alias a `func(Item) R`
        // built in one compilation with a same-named `Item` from another concurrent
        // compilation, so the emitter would look up a TypeDef the current emit never
        // registered ("Struct 'Item' has no emitted TypeDef"). Key such slots by the
        // symbol instance identity instead so they isolate per compilation while
        // still sharing within one.
        private let UserTypeIds ConditionalWeakTable[TypeSymbol, object] = ConditionalWeakTable[TypeSymbol, object]()

        // Issue #1624 regression: a plain imported CLR reference type (e.g. a
        // `Holder` class from a project reference, loaded through a
        // MetadataLoadContext) has a non-null ClrType, so it skipped the
        // ContainsSameCompilationUserType branch above and fell to the
        // name-only default below ("Holder"). Two *different* test
        // compilations each load their own MetadataLoadContext and get a
        // distinct System.Type instance for "Holder" — but the name-only key
        // aliased them, so a tuple cached by the first compilation (holding a
        // ClrType from its now-disposed context) was handed back to the
        // second, breaking emit. Key any type with a live ClrType by that
        // Type object's identity instead: stable process-wide singletons
        // (int32, string, ...) keep one id forever (still fully shared), while
        // distinct MetadataLoadContext Type instances across compilations get
        // distinct ids (no aliasing), and repeated lookups of the *same*
        // System.Type within one compilation collapse to the same id (still
        // interned).
        private let ClrTypeIds ConditionalWeakTable[Type, object] = ConditionalWeakTable[Type, object]()

        private var typeParameterIdSeed int64

        /// Returns the cached (cref:FunctionTypeSymbol) for the given signature with no variadic parameters.
        /// @param parameterTypes The parameter types.
        /// @param returnType The return type (use (cref:TypeSymbol.Void) for no return).
        /// @returns A cached (cref:FunctionTypeSymbol).
        func Get(parameterTypes ImmutableArray[TypeSymbol], returnType TypeSymbol) FunctionTypeSymbol {
            return Get(parameterTypes, isVariadic: default(ImmutableArray[bool]), returnType)
        }

        /// Returns the cached (cref:FunctionTypeSymbol) for the given signature, with optional per-parameter
        /// variadic flags (ADR-0102 follow-up / issue #818).
        /// @param parameterTypes The parameter types.
        /// @param isVariadic Per-parameter variadic flags; pass `default` or empty for a non-variadic
        /// signature. When non-default the array length must match [`parameterTypes`](paramref).
        /// @param returnType The return type (use (cref:TypeSymbol.Void) for no return).
        /// @returns A cached (cref:FunctionTypeSymbol). Two calls with the same parameter shape, return type,
        /// and variadic flag tuple return the same instance.
        func Get(
            parameterTypes ImmutableArray[TypeSymbol],
            isVariadic ImmutableArray[bool],
            returnType TypeSymbol?
        ) FunctionTypeSymbol {
            // ADR-0075 / issue #715: the canonical display form of a function type
            // is the arrow shape `(T1, T2, ...) -> R` (Kotlin/Swift style), to
            // match the canonical source spelling. A void-returning function is
            // displayed as `(T1, ...) -> void`.
            // ADR-0102 follow-up / issue #818: a trailing variadic parameter is
            // rendered with the `...` prefix and the element type rather than
            // the wrapped slice (e.g. `(int32, ...string) -> int32`).
            if !isVariadic.IsDefaultOrEmpty && isVariadic.Length != parameterTypes.Length {
                throw ArgumentException("isVariadic length must equal parameterTypes length.", "isVariadic")
            }
            let hasVariadicFlags = !isVariadic.IsDefaultOrEmpty
            let sb = StringBuilder()
            sb.Append('(')
            for var i = 0; i < parameterTypes.Length; i++ {
                if i > 0 {
                    sb.Append(", ")
                }
                if (hasVariadicFlags && isVariadic[i]) {
                    sb.Append("...")
                    if parameterTypes[i] is SliceTypeSymbol slice {
                        sb.Append(slice.ElementType?.Name ?? parameterTypes[i].Name)
                    } else {
                        sb.Append(parameterTypes[i].Name)
                    }
                } else {
                    sb.Append(parameterTypes[i].Name)
                }
            }
            sb.Append(") -> ")
            if returnType != nil && returnType != TypeSymbol.Void {
                sb.Append(returnType.Name)
            } else {
                sb.Append("void")
            }
            let name = sb.ToString()
            // The display name uses the type-parameter *names* (e.g. "(T) -> U"),
            // but two distinct generic declarations can reuse the same letters for
            // different type parameters. Caching purely by name would alias them
            // and break substitution/inference, which compare TypeParameterSymbol
            // identity. Build the cache key from each component's *identity* so an
            // open delegate type is shared only when its type parameters are the
            // same symbol instances, while concrete delegate types (keyed by their
            // stable type names) stay shared across the whole program.
            let keyBuilder = StringBuilder()
            keyBuilder.Append('(')
            for var i = 0; i < parameterTypes.Length; i++ {
                if i > 0 {
                    keyBuilder.Append(',')
                }
                if (hasVariadicFlags && isVariadic[i]) {
                    keyBuilder.Append("...")
                }
                AppendIdentityKey(keyBuilder, parameterTypes[i])
            }
            keyBuilder.Append(")->")
            AppendIdentityKey(keyBuilder, returnType ?? TypeSymbol.Void)
            let cacheKey = keyBuilder.ToString()
            let normalizedFlags = if hasVariadicFlags {
                isVariadic
            } else {
                ImmutableArray[bool].Empty
            }
            return Cache.GetOrAdd(
                cacheKey,
                (_ string) -> FunctionTypeSymbol(name, parameterTypes, normalizedFlags, returnType ?? TypeSymbol.Void)
            )
        }

        /// Clears the process-wide function-type cache. Cached instances eagerly
        /// build a host-runtime `System.Func`/`System.Action` CLR type
        /// (see (cref:BuildClrType)) that can close over types projected
        /// from a (cref:System.Reflection.MetadataLoadContext). When that
        /// context is disposed at the end of a compilation, reusing the cached
        /// entry in a later compilation running in the same process throws
        /// (cref:System.ObjectDisposedException). The
        /// (cref:ReferenceResolver) calls this on dispose alongside
        /// (cref:ImportedTypeSymbol.ClearCache) so each compilation rebuilds
        /// function types against its own live reflection context.
        internal func ClearCache() -> Cache.Clear()

        /// Issue #1049: returns whether a function-type return slot denotes "no
        /// value" for the purpose of selecting `System.Action<...>` over
        /// `System.Func<..., R>`. A slot is void when it is
        /// `null` or (cref:TypeSymbol.Void).
        /// @remarks Issue #1399 / ADR-0137: `(Args) -> void?` is a function returning
        /// nullable `void` (not a nullable function type). A nullable function
        /// type is spelled `((Args) -> void)?`, so this helper must not unwrap
        /// nullable return slots.
        /// @param returnType The function-type return slot.
        /// @returns `true` when the return type is void.
        internal func IsVoidReturn(returnType TypeSymbol?) bool {
            return returnType == nil || returnType == TypeSymbol.Void
        }

        /// Appends an identity-correct cache-key fragment for [`type`](paramref).
        /// Issue #1624: shared by (cref:TupleTypeSymbol) and
        /// (cref:FunctionPointerTypeSymbol) so every structural cache in the
        /// symbol table keys on symbol identity (not display name), preventing
        /// same-named types from different compilations from aliasing.
        /// @param builder The key builder to append to.
        /// @param type The type whose identity-key fragment to append.
        internal func AppendIdentityKey(builder StringBuilder, type TypeSymbol?) {
            // Issue #1457: any slot that references a same-compilation user type
            // (directly or nested, e.g. `Item`, `List[Item]`, `(Item, int)`) must be
            // keyed by symbol-instance identity rather than by name, so the cached
            // entry never aliases a same-named user type from another compilation.
            // Type parameters and function types keep their dedicated handling below.
            if type != nil &&
                !(type is TypeParameterSymbol) &&
                !(type is FunctionTypeSymbol) &&
                TypeSymbol
                .ContainsSameCompilationUserType(type) {
                let uid = int64(UserTypeIds.GetValue(type, (_ TypeSymbol) -> NextTypeParameterId()))
                builder.Append("!ut").Append(uid)
                return
            }
            switch type {
                case tp is TypeParameterSymbol {
                    // A boxed, process-unique id keyed off the symbol instance.
                    let id = int64(TypeParameterIds.GetValue(tp, (_ TypeParameterSymbol) -> NextTypeParameterId()))
                    builder.Append("!tp").Append(id)
                }
                case fn is FunctionTypeSymbol {
                    builder.Append('(')
                    for var i = 0; i < fn.ParameterTypes.Length; i++ {
                        if i > 0 {
                            builder.Append(',')
                        }
                        if (!fn.IsVariadic.IsDefaultOrEmpty && fn.IsVariadic[i]) {
                            builder.Append("...")
                        }
                        AppendIdentityKey(builder, fn.ParameterTypes[i])
                    }
                    builder.Append(")->")
                    AppendIdentityKey(builder, fn.ReturnType)
                }
                case nt is NullableTypeSymbol {
                    builder.Append("!nullable(")
                    AppendIdentityKey(builder, nt.UnderlyingType)
                    builder.Append(')')
                }
                case pt is PlatformTypeSymbol {
                    builder.Append("!platform(")
                    AppendIdentityKey(builder, pt.UnderlyingType)
                    builder.Append(')')
                }
                case SliceTypeSymbol,
                ArrayTypeSymbol,
                RectangularArrayTypeSymbol,
                PinnedTypeSymbol,
                NullabilityAnnotatedTypeSymbol,
                TupleTypeSymbol,
                ByRefTypeSymbol,
                PointerTypeSymbol,
                FunctionPointerTypeSymbol {
                    AppendStructuralKey(builder, type!!)
                }
                case imported is ImportedTypeSymbol when !imported.TypeArguments.IsDefaultOrEmpty {
                    AppendStructuralKey(builder, imported)
                }
                case not nil when TypeSymbol.ContainsTypeParameter(type!!) {
                    AppendStructuralKey(builder, type!!)
                }
                default {
                    AppendNameOrClrIdentityKey(builder, type)
                }
            }
        }

        /// Issue #1620: builds a shape-plus-identity key for a composite type that
        /// structurally contains a (cref:TypeParameterSymbol). Each
        /// composite kind contributes a stable shape tag (its generic definition
        /// identity for user/imported generics, or a fixed marker for built-in
        /// wrappers) followed by its recursively-keyed components, so the overall
        /// key is unique per distinct combination of shape and nested type
        /// parameter identities while still collapsing structurally identical
        /// signatures.
        /// @param builder The key builder.
        /// @param type The structural type.
        /// @param appendComponent Component identity; defaults to process-local cache identity.
        /// @param appendLeaf Leaf identity; defaults to process-local CLR identity.
        internal func AppendStructuralKey(
            builder StringBuilder,
            type TypeSymbol,
            appendComponent((StringBuilder, TypeSymbol?) -> void)? = nil,
            appendLeaf((StringBuilder, TypeSymbol?) -> void)? = nil
        ) {
            var appendComponent = appendComponent
            var appendLeaf = appendLeaf
            appendComponent ??= AppendIdentityKey
            appendLeaf ??= AppendNameOrClrIdentityKey
            switch type {
                case function is FunctionTypeSymbol {
                    builder.Append("!function(")
                    for var i = 0; i < function.ParameterTypes.Length; i++ {
                        if (!function.IsVariadic.IsDefaultOrEmpty && function.IsVariadic[i]) {
                            builder.Append("...")
                        }
                        appendComponent!!(builder, function.ParameterTypes[i])
                        builder.Append(',')
                    }
                    builder.Append(")->")
                    appendComponent!!(builder, function.ReturnType)
                }
                case n is NullableTypeSymbol {
                    builder.Append("!nullable(")
                    appendComponent!!(builder, n.UnderlyingType)
                    builder.Append(')')
                }
                case p2 is PlatformTypeSymbol {
                    // ADR-0186: see the matching arm in `AppendIdentityKey`. This
                    // copy is reachable through the `ContainsTypeParameter` /
                    // same-compilation-user-type routes, which come here directly.
                    builder.Append("!platform(")
                    appendComponent!!(builder, p2.UnderlyingType)
                    builder.Append(')')
                }
                case s is SliceTypeSymbol {
                    builder.Append("!slice(")
                    appendComponent!!(builder, s.ElementType)
                    builder.Append(')')
                }
                case a is ArrayTypeSymbol {
                    // Length must be part of the key: it is symbol-only metadata
                    // absent from the shared `elementType[]` ClrType, so `[3]int32`
                    // and `[5]int32` (and `[]int32`, via the distinct `!slice` tag
                    // above) would otherwise collide.
                    builder.Append("!array(").Append(a.Length).Append(',')
                    appendComponent!!(builder, a.ElementType)
                    builder.Append(')')
                }
                case a is RectangularArrayTypeSymbol {
                    builder.Append("!mdarray(").Append(a.Rank).Append(',')
                    appendComponent!!(builder, a.ElementType)
                    builder.Append(')')
                }
                case p is PinnedTypeSymbol {
                    builder.Append("!pinned(")
                    appendComponent!!(builder, p.UnderlyingType)
                    builder.Append(')')
                }
                case na is NullabilityAnnotatedTypeSymbol {
                    // Include NullableFlags so two annotations of the same base
                    // type with different inner-position nullability (e.g. key
                    // vs. value nullable in Dictionary<K,V>) also key distinctly,
                    // not just annotated-vs-bare.
                    builder.Append("!nann(")
                    for var i = 0; i < na.NullableFlags.Length; i++ {
                        builder.Append(na.NullableFlags[i]).Append(',')
                    }
                    appendComponent!!(builder, na.BaseType)
                    builder.Append(')')
                }
                case seq is SequenceTypeSymbol {
                    builder.Append("!seq(")
                    appendComponent!!(builder, seq.ElementType)
                    builder.Append(')')
                }
                case aseq is AsyncSequenceTypeSymbol {
                    builder.Append("!aseq(")
                    appendComponent!!(builder, aseq.ElementType)
                    builder.Append(')')
                }
                case channel is ChannelTypeSymbol {
                    builder.Append("!chan")
                    builder.Append(int32(channel.Direction))
                    builder.Append('(')
                    appendComponent!!(builder, channel.ElementType)
                    builder.Append(')')
                }
                case m is MapTypeSymbol {
                    builder.Append("!map(")
                    appendComponent!!(builder, m.KeyType)
                    builder.Append(',')
                    appendComponent!!(builder, m.ValueType)
                    builder.Append(')')
                }
                case tup is TupleTypeSymbol {
                    builder.Append("!tuple(")
                    for var i = 0; i < tup.ElementTypes.Length; i++ {
                        if i > 0 {
                            builder.Append(',')
                        }
                        appendComponent!!(builder, tup.ElementTypes[i])
                    }
                    builder.Append(')')
                    // Issue #4160 (found alongside #4133): mirror
                    // TupleTypeSymbol.Get's own cache key (ADR-0172) by folding
                    // element names into this structural key too. Without this,
                    // two differently-named same-shape tuples nested inside a
                    // larger structural type (e.g. two Func<(Id Guid, Text string), R> and
                    // Func<(Id Guid, Content string), R> lambda-parameter types
                    // from unrelated call sites in the same compilation) produce
                    // an identical key here, alias to the same cached
                    // FunctionTypeSymbol/instance, and silently cross-contaminate
                    // each other's parameter types.
                    if tup.HasNames {
                        builder.Append('|')
                        for var i = 0; i < tup.ElementNames.Length; i++ {
                            if i > 0 {
                                builder.Append(',')
                            }
                            builder.Append(tup.ElementNames[i])
                        }
                    }
                }
                case br is ByRefTypeSymbol {
                    builder.Append("!byref(")
                    appendComponent!!(builder, br.PointeeType)
                    builder.Append(')')
                }
                case pointer is PointerTypeSymbol {
                    builder.Append("!ptr(")
                    appendComponent!!(builder, pointer.PointeeType)
                    builder.Append(')')
                }
                case functionPointer is FunctionPointerTypeSymbol {
                    if functionPointer.IsManaged {
                        builder.Append("!fnptr:m(")
                    } else if functionPointer.IsUnmanagedExtended {
                        // ADR-0095 v2 / issue #3611: open-model conventions are
                        // identity in source order (the modopt blob is ordered).
                        builder
                            .Append("!fnptr:ux[")
                            .Append(string.Join(",", functionPointer.UnmanagedConventions))
                            .Append("](")
                    } else {
                        builder.Append("!fnptr:u[").Append(functionPointer.CallingConvention).Append("](")
                    }
                    for var i = 0; i < functionPointer.ParameterTypes.Length; i++ {
                        if i > 0 {
                            builder.Append(',')
                        }
                        appendComponent!!(builder, functionPointer.ParameterTypes[i])
                    }
                    builder.Append(")->")
                    appendComponent!!(builder, functionPointer.ReturnType)
                    builder.Append(')')
                }
                case st is StructSymbol when !st
                    .EnclosingTypeArguments
                    .IsDefaultOrEmpty ||
                    !st
                    .TypeArguments
                    .IsDefaultOrEmpty {
                    builder.Append("!struct:").Append(st.Definition?.Name ?? st.Name).Append('(')
                    if !st.EnclosingTypeArguments.IsDefaultOrEmpty {
                        for var i = 0; i < st.EnclosingTypeArguments.Length; i++ {
                            if i > 0 {
                                builder.Append(',')
                            }
                            appendComponent!!(builder, st.EnclosingTypeArguments[i])
                        }
                        builder.Append('|')
                    }
                    for var i = 0; i < st.TypeArguments.Length; i++ {
                        if i > 0 {
                            builder.Append(',')
                        }
                        appendComponent!!(builder, st.TypeArguments[i])
                    }
                    builder.Append(')')
                }
                case iface is InterfaceSymbol when !iface.TypeArguments.IsDefaultOrEmpty {
                    builder.Append("!iface:").Append(iface.Definition?.Name ?? iface.Name).Append('(')
                    for var i = 0; i < iface.TypeArguments.Length; i++ {
                        if i > 0 {
                            builder.Append(',')
                        }
                        appendComponent!!(builder, iface.TypeArguments[i])
                    }
                    builder.Append(')')
                }
                case del is DelegateTypeSymbol {
                    builder.Append("!delegate(")
                    for var i = 0; i < del.Parameters.Length; i++ {
                        if i > 0 {
                            builder.Append(',')
                        }
                        appendComponent!!(builder, del.Parameters[i].Type)
                    }
                    builder.Append(")->")
                    appendComponent!!(builder, del.ReturnType)
                }
                case it is ImportedTypeSymbol when !it.TypeArguments.IsDefaultOrEmpty {
                    builder.Append("!imported:").Append(it.OpenDefinition?.FullName ?? it.Name).Append('(')
                    for var i = 0; i < it.TypeArguments.Length; i++ {
                        if i > 0 {
                            builder.Append(',')
                        }
                        appendComponent!!(builder, it.TypeArguments[i])
                    }
                    builder.Append(')')
                }
                default {
                    // TypeSymbol.ContainsTypeParameter only descends into the
                    // composite kinds handled above (see AnyTypeParameter), so
                    // this default is unreachable in practice; keep the
                    // name-based fallback for safety.
                    appendLeaf!!(builder, type)
                }
            }
        }

        /// Issue #1624 regression fix: appends the identity-key fragment for a
        /// type that is neither a type parameter, a function type, nor a
        /// same-compilation user type without CLR backing. Such a type either has
        /// no ClrType (the true singleton built-ins like `void`/`error`,
        /// safely shared by name) or carries a live (cref:System.Type) —
        /// a built-in primitive (a genuine process-wide singleton) or an
        /// (cref:ImportedTypeSymbol) projected from a
        /// (cref:System.Reflection.MetadataLoadContext) (a distinct
        /// (cref:System.Type) instance per compilation even when the
        /// simple name matches, e.g. two test compilations that each define a
        /// "Holder" class). Keying by the CLR (cref:System.Type) object's
        /// identity keeps every true singleton shared while never aliasing two
        /// same-named types loaded by different compilations.
        /// @param builder The key builder to append to.
        /// @param type The type whose fallback key fragment to append.
        private func AppendNameOrClrIdentityKey(builder StringBuilder, type TypeSymbol?) {
            if type?.ClrType is Type clrType {
                let id = int64(ClrTypeIds.GetValue(clrType, (_ Type) -> NextTypeParameterId()))
                builder.Append("!clr").Append(id)
            } else {
                builder.Append(type?.Name ?? "void")
            }
        }

        private func NextTypeParameterId() object {
            return Interlocked.Increment(&typeParameterIdSeed)
        }

        private func BuildClrType(parameterTypes ImmutableArray[TypeSymbol], returnType TypeSymbol) Type? {
            // Phase 4 emit parity (E): map func(T1, ..., Tn) R to the matching
            // System.Func<T1, ..., Tn, R> shape (or System.Action<...> when R
            // is void). Higher arities (>16 args) have no shipped delegate
            // shape and return a null ClrType, keeping the type
            // interpreter-only on the emit side.
            // Issue #1518: use the nullable-lifted effective CLR type so a
            // nullable value-type slot (T?) becomes Nullable<T> rather than the
            // bare underlying T. Otherwise the delegate shape (Func<…,T>) disagrees
            // with the symbol-accurate delegate the emitter builds (Func<…,T?>),
            // which makes overload-resolution inference bind the method type
            // parameter to T instead of Nullable<T> and produces unverifiable IL.
            let paramClr = [parameterTypes.Length]Type
            for var i = 0; i < parameterTypes.Length; i++ {
                let pt Type? = NullableLifting.GetEffectiveClrType(parameterTypes[i])
                if pt == nil {
                    return nil
                }
                paramClr[i] = pt
            }
            let isVoid = IsVoidReturn(returnType)
            if isVoid {
                switch paramClr.Length {
                    case 0 {
                        return typeof(() -> void)
                    }
                    case 1 {
                        return typeof(System.Action[_]).MakeGenericType(paramClr)
                    }
                    case 2 {
                        return typeof(System.Action[_, _]).MakeGenericType(paramClr)
                    }
                    case 3 {
                        return typeof(System.Action[_, _, _]).MakeGenericType(paramClr)
                    }
                    case 4 {
                        return typeof(System.Action[_, _, _, _]).MakeGenericType(paramClr)
                    }
                    case 5 {
                        return typeof(System.Action[_, _, _, _, _]).MakeGenericType(paramClr)
                    }
                    case 6 {
                        return typeof(System.Action[_, _, _, _, _, _]).MakeGenericType(paramClr)
                    }
                    case 7 {
                        return typeof(System.Action[_, _, _, _, _, _, _]).MakeGenericType(paramClr)
                    }
                    case 8 {
                        return typeof(System.Action[_, _, _, _, _, _, _, _]).MakeGenericType(paramClr)
                    }
                    case 9 {
                        return typeof(System.Action[_, _, _, _, _, _, _, _, _]).MakeGenericType(paramClr)
                    }
                    case 10 {
                        return typeof(System.Action[_, _, _, _, _, _, _, _, _, _]).MakeGenericType(paramClr)
                    }
                    case 11 {
                        return typeof(System.Action[_, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(paramClr)
                    }
                    case 12 {
                        return typeof(System.Action[_, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(paramClr)
                    }
                    case 13 {
                        return typeof(System.Action[_, _, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(paramClr)
                    }
                    case 14 {
                        return typeof(System.Action[_, _, _, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(paramClr)
                    }
                    case 15 {
                        return typeof(System.Action[_, _, _, _, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(
                            paramClr
                        )
                    }
                    case 16 {
                        return typeof(System.Action[_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(
                            paramClr
                        )
                    }
                    default {
                        return nil
                    }
                }
            }
            let retClr Type? = NullableLifting.GetEffectiveClrType(returnType)
            if retClr == nil {
                return nil
            }
            let args = [paramClr.Length + 1]Type
            Array.Copy(paramClr, args, paramClr.Length)
            args[paramClr.Length] = retClr
            switch paramClr.Length {
                case 0 {
                    return typeof(System.Func[_]).MakeGenericType(args)
                }
                case 1 {
                    return typeof(System.Func[_, _]).MakeGenericType(args)
                }
                case 2 {
                    return typeof(System.Func[_, _, _]).MakeGenericType(args)
                }
                case 3 {
                    return typeof(System.Func[_, _, _, _]).MakeGenericType(args)
                }
                case 4 {
                    return typeof(System.Func[_, _, _, _, _]).MakeGenericType(args)
                }
                case 5 {
                    return typeof(System.Func[_, _, _, _, _, _]).MakeGenericType(args)
                }
                case 6 {
                    return typeof(System.Func[_, _, _, _, _, _, _]).MakeGenericType(args)
                }
                case 7 {
                    return typeof(System.Func[_, _, _, _, _, _, _, _]).MakeGenericType(args)
                }
                case 8 {
                    return typeof(System.Func[_, _, _, _, _, _, _, _, _]).MakeGenericType(args)
                }
                case 9 {
                    return typeof(System.Func[_, _, _, _, _, _, _, _, _, _]).MakeGenericType(args)
                }
                case 10 {
                    return typeof(System.Func[_, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(args)
                }
                case 11 {
                    return typeof(System.Func[_, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(args)
                }
                case 12 {
                    return typeof(System.Func[_, _, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(args)
                }
                case 13 {
                    return typeof(System.Func[_, _, _, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(args)
                }
                case 14 {
                    return typeof(System.Func[_, _, _, _, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(args)
                }
                case 15 {
                    return typeof(System.Func[_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(args)
                }
                case 16 {
                    return typeof(System.Func[_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(args)
                }
                default {
                    return nil
                }
            }
        }
    }
}
