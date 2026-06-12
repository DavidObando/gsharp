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

    private static long typeParameterIdSeed;

    private FunctionTypeSymbol(string name, ImmutableArray<TypeSymbol> parameterTypes, TypeSymbol returnType)
        : base(name, BuildClrType(parameterTypes, returnType))
    {
        ParameterTypes = parameterTypes;
        ReturnType = returnType;
    }

    /// <summary>Gets the function's parameter types.</summary>
    public ImmutableArray<TypeSymbol> ParameterTypes { get; }

    /// <summary>Gets the function's return type. <c>void</c> when the function returns nothing.</summary>
    public TypeSymbol ReturnType { get; }

    /// <summary>Gets the number of parameters.</summary>
    public int Arity => ParameterTypes.Length;

    /// <summary>Returns the cached <see cref="FunctionTypeSymbol"/> for the given signature.</summary>
    /// <param name="parameterTypes">The parameter types.</param>
    /// <param name="returnType">The return type (use <see cref="TypeSymbol.Void"/> for no return).</param>
    /// <returns>A cached <see cref="FunctionTypeSymbol"/>.</returns>
    public static FunctionTypeSymbol Get(ImmutableArray<TypeSymbol> parameterTypes, TypeSymbol returnType)
    {
        // ADR-0075 / issue #715: the canonical display form of a function type
        // is the arrow shape `(T1, T2, ...) -> R` (Kotlin/Swift style), to
        // match the canonical source spelling. A void-returning function is
        // displayed as `(T1, ...) -> void`.
        var sb = new System.Text.StringBuilder();
        sb.Append('(');
        for (var i = 0; i < parameterTypes.Length; i++)
        {
            if (i > 0)
            {
                sb.Append(", ");
            }

            sb.Append(parameterTypes[i].Name);
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

            AppendIdentityKey(keyBuilder, parameterTypes[i]);
        }

        keyBuilder.Append(")->");
        AppendIdentityKey(keyBuilder, returnType ?? TypeSymbol.Void);

        var cacheKey = keyBuilder.ToString();
        return Cache.GetOrAdd(cacheKey, _ => new FunctionTypeSymbol(name, parameterTypes, returnType ?? TypeSymbol.Void));
    }

    private static void AppendIdentityKey(System.Text.StringBuilder builder, TypeSymbol type)
    {
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
            default:
                builder.Append(type?.Name ?? "void");
                break;
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
        var paramClr = new System.Type[parameterTypes.Length];
        for (var i = 0; i < parameterTypes.Length; i++)
        {
            var pt = parameterTypes[i]?.ClrType;
            if (pt == null)
            {
                return null;
            }

            paramClr[i] = pt;
        }

        bool isVoid = returnType == null || returnType == TypeSymbol.Void;
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

        var retClr = returnType.ClrType;
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
