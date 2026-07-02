// <copyright file="FunctionTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a first-class function type <c>func(T1, T2, ...) R</c>
/// (Phase 4.7). Instances are cached and compared by structural equality of
/// parameter and return types so two textually identical type clauses share
/// the same <see cref="FunctionTypeSymbol"/>.
/// </summary>
public sealed class FunctionTypeSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<string, FunctionTypeSymbol> Cache = new ConcurrentDictionary<string, FunctionTypeSymbol>();

    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<TypeParameterSymbol, object> TypeParameterIds = new System.Runtime.CompilerServices.ConditionalWeakTable<TypeParameterSymbol, object>();

    // Issue #1457: a same-compilation user type (a struct/class/enum/interface/
    // delegate still being compiled) has no host CLR Type and is identified
    // across compilations only by its (re-usable) display name. Keying the
    // process-wide function-type cache by that name would alias a `func(Item) R`
    // built in one compilation with a same-named `Item` from another concurrent
    // compilation, so the emitter would look up a TypeDef the current emit never
    // registered ("Struct 'Item' has no emitted TypeDef"). Key such slots by the
    // symbol instance identity instead so they isolate per compilation while
    // still sharing within one.
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<TypeSymbol, object> UserTypeIds = new System.Runtime.CompilerServices.ConditionalWeakTable<TypeSymbol, object>();

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
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<System.Type, object> ClrTypeIds = new System.Runtime.CompilerServices.ConditionalWeakTable<System.Type, object>();

    private static long typeParameterIdSeed;

    private FunctionTypeSymbol(string name, ImmutableArray<TypeSymbol> parameterTypes, ImmutableArray<bool> isVariadic, TypeSymbol returnType)
        : base(name, BuildClrType(parameterTypes, returnType))
    {
        ParameterTypes = parameterTypes;
        IsVariadic = isVariadic;
        ReturnType = returnType;
    }

    /// <summary>Gets the function's parameter types.</summary>
    public ImmutableArray<TypeSymbol> ParameterTypes { get; }

    /// <summary>
    /// Gets the per-parameter variadic flags (ADR-0102 follow-up / issue #818).
    /// Always parallel to <see cref="ParameterTypes"/> — entry <c>i</c> is
    /// <see langword="true"/> iff the corresponding parameter is the
    /// trailing variadic <c>...T</c> slot. All-<see langword="false"/> for
    /// a regular function type. The variadic slot's
    /// <see cref="ParameterTypes"/> entry is the already-wrapped slice
    /// (<c>[]T</c>) so existing callers that just look at the parameter
    /// type continue to work; the flag is consulted at call sites to
    /// drive pack / pass-through.
    /// </summary>
    public ImmutableArray<bool> IsVariadic { get; }

    /// <summary>Gets the function's return type. <c>void</c> when the function returns nothing.</summary>
    public TypeSymbol ReturnType { get; }

    /// <summary>Gets the number of parameters.</summary>
    public int Arity => ParameterTypes.Length;

    /// <summary>Gets a value indicating whether this function type declares a trailing variadic parameter.</summary>
    public bool HasVariadic => !IsVariadic.IsDefaultOrEmpty && IsVariadic[IsVariadic.Length - 1];

    /// <summary>Returns the cached <see cref="FunctionTypeSymbol"/> for the given signature with no variadic parameters.</summary>
    /// <param name="parameterTypes">The parameter types.</param>
    /// <param name="returnType">The return type (use <see cref="TypeSymbol.Void"/> for no return).</param>
    /// <returns>A cached <see cref="FunctionTypeSymbol"/>.</returns>
    public static FunctionTypeSymbol Get(ImmutableArray<TypeSymbol> parameterTypes, TypeSymbol returnType)
    {
        return Get(parameterTypes, isVariadic: default, returnType);
    }

    /// <summary>Returns the cached <see cref="FunctionTypeSymbol"/> for the given signature, with optional per-parameter variadic flags (ADR-0102 follow-up / issue #818).</summary>
    /// <param name="parameterTypes">The parameter types.</param>
    /// <param name="isVariadic">Per-parameter variadic flags; pass <c>default</c> or empty for a non-variadic signature. When non-default the array length must match <paramref name="parameterTypes"/>.</param>
    /// <param name="returnType">The return type (use <see cref="TypeSymbol.Void"/> for no return).</param>
    /// <returns>A cached <see cref="FunctionTypeSymbol"/>. Two calls with the same parameter shape, return type, and variadic flag tuple return the same instance.</returns>
    public static FunctionTypeSymbol Get(ImmutableArray<TypeSymbol> parameterTypes, ImmutableArray<bool> isVariadic, TypeSymbol returnType)
    {
        // ADR-0075 / issue #715: the canonical display form of a function type
        // is the arrow shape `(T1, T2, ...) -> R` (Kotlin/Swift style), to
        // match the canonical source spelling. A void-returning function is
        // displayed as `(T1, ...) -> void`.
        // ADR-0102 follow-up / issue #818: a trailing variadic parameter is
        // rendered with the `...` prefix and the element type rather than
        // the wrapped slice (e.g. `(int32, ...string) -> int32`).
        if (!isVariadic.IsDefaultOrEmpty && isVariadic.Length != parameterTypes.Length)
        {
            throw new System.ArgumentException(
                "isVariadic length must equal parameterTypes length.",
                nameof(isVariadic));
        }

        var hasVariadicFlags = !isVariadic.IsDefaultOrEmpty;
        var sb = new System.Text.StringBuilder();
        sb.Append('(');
        for (var i = 0; i < parameterTypes.Length; i++)
        {
            if (i > 0)
            {
                sb.Append(", ");
            }

            if (hasVariadicFlags && isVariadic[i])
            {
                sb.Append("...");
                if (parameterTypes[i] is SliceTypeSymbol slice)
                {
                    sb.Append(slice.ElementType?.Name ?? parameterTypes[i].Name);
                }
                else
                {
                    sb.Append(parameterTypes[i].Name);
                }
            }
            else
            {
                sb.Append(parameterTypes[i].Name);
            }
        }

        sb.Append(") -> ");
        if (returnType != null && returnType != TypeSymbol.Void)
        {
            sb.Append(returnType.Name);
        }
        else
        {
            sb.Append("void");
        }

        var name = sb.ToString();

        // The display name uses the type-parameter *names* (e.g. "(T) -> U"),
        // but two distinct generic declarations can reuse the same letters for
        // different type parameters. Caching purely by name would alias them
        // and break substitution/inference, which compare TypeParameterSymbol
        // identity. Build the cache key from each component's *identity* so an
        // open delegate type is shared only when its type parameters are the
        // same symbol instances, while concrete delegate types (keyed by their
        // stable type names) stay shared across the whole program.
        var keyBuilder = new System.Text.StringBuilder();
        keyBuilder.Append('(');
        for (var i = 0; i < parameterTypes.Length; i++)
        {
            if (i > 0)
            {
                keyBuilder.Append(',');
            }

            if (hasVariadicFlags && isVariadic[i])
            {
                keyBuilder.Append("...");
            }

            AppendIdentityKey(keyBuilder, parameterTypes[i]);
        }

        keyBuilder.Append(")->");
        AppendIdentityKey(keyBuilder, returnType ?? TypeSymbol.Void);

        var cacheKey = keyBuilder.ToString();
        var normalizedFlags = hasVariadicFlags ? isVariadic : ImmutableArray<bool>.Empty;
        return Cache.GetOrAdd(cacheKey, _ => new FunctionTypeSymbol(name, parameterTypes, normalizedFlags, returnType ?? TypeSymbol.Void));
    }

    /// <summary>
    /// Clears the process-wide function-type cache. Cached instances eagerly
    /// build a host-runtime <c>System.Func</c>/<c>System.Action</c> CLR type
    /// (see <see cref="BuildClrType"/>) that can close over types projected
    /// from a <see cref="System.Reflection.MetadataLoadContext"/>. When that
    /// context is disposed at the end of a compilation, reusing the cached
    /// entry in a later compilation running in the same process throws
    /// <see cref="System.ObjectDisposedException"/>. The
    /// <see cref="ReferenceResolver"/> calls this on dispose alongside
    /// <see cref="ImportedTypeSymbol.ClearCache"/> so each compilation rebuilds
    /// function types against its own live reflection context.
    /// </summary>
    internal static void ClearCache() => Cache.Clear();

    /// <summary>
    /// Issue #1049: returns whether a function-type return slot denotes "no
    /// value" for the purpose of selecting <c>System.Action&lt;...&gt;</c> over
    /// <c>System.Func&lt;..., R&gt;</c>. A slot is void when it is
    /// <see langword="null"/> or <see cref="TypeSymbol.Void"/>.
    /// </summary>
    /// <remarks>
    /// Issue #1399 / ADR-0137: <c>(Args) -&gt; void?</c> is a function returning
    /// nullable <c>void</c> (not a nullable function type). A nullable function
    /// type is spelled <c>((Args) -&gt; void)?</c>, so this helper must not unwrap
    /// nullable return slots.
    /// </remarks>
    /// <param name="returnType">The function-type return slot.</param>
    /// <returns><see langword="true"/> when the return type is void.</returns>
    internal static bool IsVoidReturn(TypeSymbol returnType)
    {
        return returnType == null || returnType == TypeSymbol.Void;
    }

    /// <summary>
    /// Appends an identity-correct cache-key fragment for <paramref name="type"/>.
    /// Issue #1624: shared by <see cref="TupleTypeSymbol"/> and
    /// <see cref="FunctionPointerTypeSymbol"/> so every structural cache in the
    /// symbol table keys on symbol identity (not display name), preventing
    /// same-named types from different compilations from aliasing.
    /// </summary>
    /// <param name="builder">The key builder to append to.</param>
    /// <param name="type">The type whose identity-key fragment to append.</param>
    internal static void AppendIdentityKey(System.Text.StringBuilder builder, TypeSymbol type)
    {
        // Issue #1457: any slot that references a same-compilation user type
        // (directly or nested, e.g. `Item`, `List[Item]`, `(Item, int)`) must be
        // keyed by symbol-instance identity rather than by name, so the cached
        // entry never aliases a same-named user type from another compilation.
        // Type parameters and function types keep their dedicated handling below.
        if (type is not null and not TypeParameterSymbol and not FunctionTypeSymbol
            && ContainsSameCompilationUserType(type))
        {
            var uid = (long)UserTypeIds.GetValue(type, _ => NextTypeParameterId());
            builder.Append("!ut").Append(uid);
            return;
        }

        switch (type)
        {
            case TypeParameterSymbol tp:
                // A boxed, process-unique id keyed off the symbol instance.
                var id = (long)TypeParameterIds.GetValue(tp, _ => NextTypeParameterId());
                builder.Append("!tp").Append(id);
                break;
            case FunctionTypeSymbol fn:
                builder.Append('(');
                for (var i = 0; i < fn.ParameterTypes.Length; i++)
                {
                    if (i > 0)
                    {
                        builder.Append(',');
                    }

                    AppendIdentityKey(builder, fn.ParameterTypes[i]);
                }

                builder.Append(")->");
                AppendIdentityKey(builder, fn.ReturnType);
                break;

            // Issue #1518/#1624 regression: NullableTypeSymbol's ClrType is
            // the bare *underlying* CLR type (see NullableTypeSymbol ctor),
            // not Nullable<T> — so `int32?` and `int32` share the same
            // System.Type. Falling through to the ClrType-identity default
            // below would collapse their keys and alias a `Func<..,int32?>`
            // with a `Func<..,int32>` in the process-wide cache. Always key
            // nullable slots structurally (by their own tag plus the
            // recursively-keyed underlying type) regardless of whether they
            // carry a type parameter.
            case NullableTypeSymbol nt:
                builder.Append("!nullable(");
                AppendIdentityKey(builder, nt.UnderlyingType);
                builder.Append(')');
                break;

            // Issue #1620: a composite type (List[T], []T, T?, (T, int32), ...)
            // that structurally carries a type parameter must NOT fall through
            // to the name-based default below — two distinct generic
            // declarations reusing the same letter (`T`) for unrelated
            // TypeParameterSymbol instances would render the identical name
            // ("List<T>") and alias in the process-wide cache. Recurse
            // structurally so every nested type parameter contributes its own
            // `!tp<N>` identity id instead.
            case not null when TypeSymbol.ContainsTypeParameter(type):
                AppendStructuralKey(builder, type);
                break;
            default:
                AppendNameOrClrIdentityKey(builder, type);
                break;
        }
    }

    /// <summary>
    /// Issue #1620: builds a shape-plus-identity key for a composite type that
    /// structurally contains a <see cref="TypeParameterSymbol"/>. Each
    /// composite kind contributes a stable shape tag (its generic definition
    /// identity for user/imported generics, or a fixed marker for built-in
    /// wrappers) followed by its recursively-keyed components, so the overall
    /// key is unique per distinct combination of shape and nested type
    /// parameter identities while still collapsing structurally identical
    /// signatures.
    /// </summary>
    private static void AppendStructuralKey(System.Text.StringBuilder builder, TypeSymbol type)
    {
        switch (type)
        {
            case NullableTypeSymbol n:
                builder.Append("!nullable(");
                AppendIdentityKey(builder, n.UnderlyingType);
                builder.Append(')');
                break;
            case SliceTypeSymbol s:
                builder.Append("!slice(");
                AppendIdentityKey(builder, s.ElementType);
                builder.Append(')');
                break;
            case ArrayTypeSymbol a:
                builder.Append("!array(");
                AppendIdentityKey(builder, a.ElementType);
                builder.Append(')');
                break;
            case SequenceTypeSymbol seq:
                builder.Append("!seq(");
                AppendIdentityKey(builder, seq.ElementType);
                builder.Append(')');
                break;
            case AsyncSequenceTypeSymbol aseq:
                builder.Append("!aseq(");
                AppendIdentityKey(builder, aseq.ElementType);
                builder.Append(')');
                break;
            case MapTypeSymbol m:
                builder.Append("!map(");
                AppendIdentityKey(builder, m.KeyType);
                builder.Append(',');
                AppendIdentityKey(builder, m.ValueType);
                builder.Append(')');
                break;
            case TupleTypeSymbol tup:
                builder.Append("!tuple(");
                for (var i = 0; i < tup.ElementTypes.Length; i++)
                {
                    if (i > 0)
                    {
                        builder.Append(',');
                    }

                    AppendIdentityKey(builder, tup.ElementTypes[i]);
                }

                builder.Append(')');
                break;
            case ByRefTypeSymbol br:
                builder.Append("!byref(");
                AppendIdentityKey(builder, br.PointeeType);
                builder.Append(')');
                break;
            case StructSymbol st when !st.TypeArguments.IsDefaultOrEmpty:
                builder.Append("!struct:").Append(st.Definition?.Name ?? st.Name).Append('(');
                for (var i = 0; i < st.TypeArguments.Length; i++)
                {
                    if (i > 0)
                    {
                        builder.Append(',');
                    }

                    AppendIdentityKey(builder, st.TypeArguments[i]);
                }

                builder.Append(')');
                break;
            case InterfaceSymbol iface when !iface.TypeArguments.IsDefaultOrEmpty:
                builder.Append("!iface:").Append(iface.Definition?.Name ?? iface.Name).Append('(');
                for (var i = 0; i < iface.TypeArguments.Length; i++)
                {
                    if (i > 0)
                    {
                        builder.Append(',');
                    }

                    AppendIdentityKey(builder, iface.TypeArguments[i]);
                }

                builder.Append(')');
                break;
            case DelegateTypeSymbol del:
                builder.Append("!delegate(");
                for (var i = 0; i < del.Parameters.Length; i++)
                {
                    if (i > 0)
                    {
                        builder.Append(',');
                    }

                    AppendIdentityKey(builder, del.Parameters[i].Type);
                }

                builder.Append(")->");
                AppendIdentityKey(builder, del.ReturnType);
                break;
            case ImportedTypeSymbol it when !it.TypeArguments.IsDefaultOrEmpty:
                builder.Append("!imported:").Append(it.OpenDefinition?.FullName ?? it.Name).Append('(');
                for (var i = 0; i < it.TypeArguments.Length; i++)
                {
                    if (i > 0)
                    {
                        builder.Append(',');
                    }

                    AppendIdentityKey(builder, it.TypeArguments[i]);
                }

                builder.Append(')');
                break;
            default:
                // TypeSymbol.ContainsTypeParameter only descends into the
                // composite kinds handled above (see AnyTypeParameter), so
                // this default is unreachable in practice; keep the
                // name-based fallback for safety.
                AppendNameOrClrIdentityKey(builder, type);
                break;
        }
    }

    /// <summary>
    /// Issue #1624 regression fix: appends the identity-key fragment for a
    /// type that is neither a type parameter, a function type, nor a
    /// same-compilation user type without CLR backing. Such a type either has
    /// no ClrType (the true singleton built-ins like <c>void</c>/<c>error</c>,
    /// safely shared by name) or carries a live <see cref="System.Type"/> —
    /// a built-in primitive (a genuine process-wide singleton) or an
    /// <see cref="ImportedTypeSymbol"/> projected from a
    /// <see cref="System.Reflection.MetadataLoadContext"/> (a distinct
    /// <see cref="System.Type"/> instance per compilation even when the
    /// simple name matches, e.g. two test compilations that each define a
    /// "Holder" class). Keying by the CLR <see cref="System.Type"/> object's
    /// identity keeps every true singleton shared while never aliasing two
    /// same-named types loaded by different compilations.
    /// </summary>
    /// <param name="builder">The key builder to append to.</param>
    /// <param name="type">The type whose fallback key fragment to append.</param>
    private static void AppendNameOrClrIdentityKey(System.Text.StringBuilder builder, TypeSymbol type)
    {
        if (type?.ClrType is System.Type clrType)
        {
            var id = (long)ClrTypeIds.GetValue(clrType, _ => NextTypeParameterId());
            builder.Append("!clr").Append(id);
        }
        else
        {
            builder.Append(type?.Name ?? "void");
        }
    }

    private static object NextTypeParameterId()
    {
        return System.Threading.Interlocked.Increment(ref typeParameterIdSeed);
    }

    private static System.Type BuildClrType(ImmutableArray<TypeSymbol> parameterTypes, TypeSymbol returnType)
    {
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
        var paramClr = new System.Type[parameterTypes.Length];
        for (var i = 0; i < parameterTypes.Length; i++)
        {
            var pt = NullableLifting.GetEffectiveClrType(parameterTypes[i]);
            if (pt == null)
            {
                return null;
            }

            paramClr[i] = pt;
        }

        bool isVoid = IsVoidReturn(returnType);
        if (isVoid)
        {
            switch (paramClr.Length)
            {
                case 0: return typeof(System.Action);
                case 1: return typeof(System.Action<>).MakeGenericType(paramClr);
                case 2: return typeof(System.Action<,>).MakeGenericType(paramClr);
                case 3: return typeof(System.Action<,,>).MakeGenericType(paramClr);
                case 4: return typeof(System.Action<,,,>).MakeGenericType(paramClr);
                case 5: return typeof(System.Action<,,,,>).MakeGenericType(paramClr);
                case 6: return typeof(System.Action<,,,,,>).MakeGenericType(paramClr);
                case 7: return typeof(System.Action<,,,,,,>).MakeGenericType(paramClr);
                case 8: return typeof(System.Action<,,,,,,,>).MakeGenericType(paramClr);
                default: return null;
            }
        }

        var retClr = NullableLifting.GetEffectiveClrType(returnType);
        if (retClr == null)
        {
            return null;
        }

        var args = new System.Type[paramClr.Length + 1];
        System.Array.Copy(paramClr, args, paramClr.Length);
        args[paramClr.Length] = retClr;
        switch (paramClr.Length)
        {
            case 0: return typeof(System.Func<>).MakeGenericType(args);
            case 1: return typeof(System.Func<,>).MakeGenericType(args);
            case 2: return typeof(System.Func<,,>).MakeGenericType(args);
            case 3: return typeof(System.Func<,,,>).MakeGenericType(args);
            case 4: return typeof(System.Func<,,,,>).MakeGenericType(args);
            case 5: return typeof(System.Func<,,,,,>).MakeGenericType(args);
            case 6: return typeof(System.Func<,,,,,,>).MakeGenericType(args);
            case 7: return typeof(System.Func<,,,,,,,>).MakeGenericType(args);
            case 8: return typeof(System.Func<,,,,,,,,>).MakeGenericType(args);
            default: return null;
        }
    }
}
