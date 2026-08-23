// <copyright file="SynthesizedRefDelegateCache.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Text;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Issue #3501 A2: per-compile-pass cache of compiler-synthesized delegate
/// types backing native function types with <c>ref</c>/<c>out</c>/<c>in</c>
/// parameters. <c>System.Func</c>/<c>System.Action</c> cannot carry by-ref
/// type arguments, so a function type spelled <c>(ref int32) -&gt; void</c>
/// (or the natural type of a literal <c>func(ref n int32) { … }</c>) lowers
/// to a sealed <c>MulticastDelegate</c> TypeDef with the matching by-ref
/// <c>Invoke</c> signature — the exact shape ADR-0059 named delegates
/// already emit and every call/conversion path already supports. Two
/// spellings of the same shape (same ref kinds, parameter types, and return
/// type) unify to the SAME synthesized symbol within one compile pass,
/// mirroring <see cref="AnonymousTypeCache"/>.
/// </summary>
internal sealed class SynthesizedRefDelegateCache
{
    private readonly Dictionary<string, DelegateTypeSymbol> byShape = new();
    private readonly List<DelegateTypeSymbol> symbols = new();
    private int counter;

    /// <summary>Gets every distinct synthesized delegate created so far in this cache, in creation order.</summary>
    public IReadOnlyList<DelegateTypeSymbol> Symbols => symbols;

    /// <summary>
    /// Returns the cached synthesized delegate for the given signature,
    /// creating and caching a new one on first use. At least one parameter
    /// is expected to carry a non-<see cref="RefKind.None"/> ref kind —
    /// by-value-only shapes stay on <see cref="FunctionTypeSymbol"/>.
    /// </summary>
    /// <param name="parameters">The parameter symbols (names, types, and ref kinds preserved for emit).</param>
    /// <param name="returnType">The delegate's return type (<see cref="TypeSymbol.Void"/> for none).</param>
    /// <param name="packageName">The package (CLR namespace) the synthesized TypeDef is emitted into.</param>
    /// <returns>The (cached) synthesized <see cref="DelegateTypeSymbol"/>.</returns>
    public DelegateTypeSymbol GetOrCreate(
        ImmutableArray<ParameterSymbol> parameters,
        TypeSymbol returnType,
        string? packageName)
    {
        var key = BuildKey(parameters, returnType);
        if (byShape.TryGetValue(key, out var existing))
        {
            return existing;
        }

        // Roslyn synthesizes `<>A{…}`/`<>F{…}` for ref-kind lambdas; the
        // angle-bracket prefix keeps the name unspeakable in source while
        // remaining a valid CLR TypeDef name.
        var symbol = new DelegateTypeSymbol(
            $"<>RefFunc{counter++}",
            packageName ?? string.Empty,
            Accessibility.Internal,
            ImmutableArray<ParameterSymbol>.Empty,
            TypeSymbol.Void,
            declaration: null!);
        symbol.SetSignature(parameters, returnType);

        byShape[key] = symbol;
        symbols.Add(symbol);
        return symbol;
    }

    private static string BuildKey(ImmutableArray<ParameterSymbol> parameters, TypeSymbol returnType)
    {
        var sb = new StringBuilder();
        foreach (var parameter in parameters)
        {
            sb.Append((int)parameter.RefKind).Append(':');
            FunctionTypeSymbol.AppendIdentityKey(sb, parameter.Type);
            sb.Append(';');
        }

        sb.Append("->");
        FunctionTypeSymbol.AppendIdentityKey(sb, returnType);
        return sb.ToString();
    }
}
