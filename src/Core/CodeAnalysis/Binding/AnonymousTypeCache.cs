// <copyright file="AnonymousTypeCache.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Text;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Per-compile-pass cache of synthesized anonymous-class types (issue #2224,
/// per the repo owner's design comment on that issue). Mirrors Roslyn's
/// anonymous-type cache: two anonymous-class literals (<c>interface { ... }</c>)
/// with the same member names, in the same order, and the same member types
/// unify to the SAME synthesized <see cref="StructSymbol"/> within one
/// compile pass, so their instances share a single synthesized backing type
/// exactly like two <c>new { ... }</c> expressions of the same shape share
/// one <c>&lt;&gt;f__AnonymousType</c> in Roslyn.
/// </summary>
internal sealed class AnonymousTypeCache
{
    private readonly Dictionary<string, StructSymbol> byShape = new();
    private readonly List<StructSymbol> symbols = new();
    private int counter;

    /// <summary>Gets every distinct synthesized anonymous type created so far in this cache, in creation order.</summary>
    public IReadOnlyList<StructSymbol> Symbols => symbols;

    /// <summary>
    /// Returns the cached synthesized type for the given ordered member
    /// shape (name + type, order-sensitive like C# anonymous types),
    /// creating and caching a new one on first use.
    /// </summary>
    /// <param name="members">The member names and types, in declaration order.</param>
    /// <param name="packageName">The package the synthesized type is emitted into.</param>
    /// <returns>The (cached) synthesized anonymous-class <see cref="StructSymbol"/>.</returns>
    public StructSymbol GetOrCreate(IReadOnlyList<(string Name, TypeSymbol Type)> members, string packageName)
    {
        var key = BuildKey(members);
        if (byShape.TryGetValue(key, out var existing))
        {
            return existing;
        }

        var fields = ImmutableArray.CreateBuilder<FieldSymbol>(members.Count);
        var ctorParams = ImmutableArray.CreateBuilder<ParameterSymbol>(members.Count);
        foreach (var (name, type) in members)
        {
            // Immutable, get-only members (ADR-2224 / C# anonymous-type
            // parity): a public readonly field. This reuses the existing
            // `data struct` synthesized-member pipeline (Equals/GetHashCode/
            // ToString/Deconstruct, ADR-0029) verbatim — that pipeline is
            // driven entirely by StructSymbol.Fields, so no emitter changes
            // are needed for equality/ToString semantics. `isClass: false`
            // (value type) is used deliberately: DataStructSynthesizer's
            // Equals/GetHashCode emission assumes value-type struct
            // (unbox-based field access) and does not yet support
            // reference-type `data class` (see its `!structSym.IsClass`
            // asserts) — a documented deviation from C#'s reference-type
            // anonymous types.
            fields.Add(new FieldSymbol(name, type, Accessibility.Public, isReadOnly: true));
            ctorParams.Add(new ParameterSymbol(name, type));
        }

        // Roslyn-style synthesized name; unique per distinct shape within
        // this cache (one per compile pass).
        var typeName = $"<>AnonymousType{counter++}";
        var symbol = new StructSymbol(
            typeName,
            fields.MoveToImmutable(),
            Accessibility.Public,
            declaration: null,
            packageName: packageName ?? string.Empty,
            isData: true,
            isInline: false,
            isClass: false,
            primaryConstructorParameters: ctorParams.MoveToImmutable());

        byShape[key] = symbol;
        symbols.Add(symbol);
        return symbol;
    }

    private static string BuildKey(IReadOnlyList<(string Name, TypeSymbol Type)> members)
    {
        var sb = new StringBuilder();
        foreach (var (name, type) in members)
        {
            sb.Append(name).Append(':');
            FunctionTypeSymbol.AppendIdentityKey(sb, type);
            sb.Append(';');
        }

        return sb.ToString();
    }
}
