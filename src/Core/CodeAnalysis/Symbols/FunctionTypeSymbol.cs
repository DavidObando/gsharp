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
        : base(name)
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
}
