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
        var sb = new System.Text.StringBuilder();
        sb.Append("func(");
        for (var i = 0; i < parameterTypes.Length; i++)
        {
            if (i > 0)
            {
                sb.Append(", ");
            }

            sb.Append(parameterTypes[i].Name);
        }

        sb.Append(')');
        if (returnType != null && returnType != TypeSymbol.Void)
        {
            sb.Append(' ');
            sb.Append(returnType.Name);
        }

        var name = sb.ToString();
        return Cache.GetOrAdd(name, n => new FunctionTypeSymbol(n, parameterTypes, returnType ?? TypeSymbol.Void));
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
