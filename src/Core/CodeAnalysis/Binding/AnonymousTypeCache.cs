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
/// anonymous-type cache: two anonymous-class literals (<c>object { let ... }</c>)
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

        var properties = ImmutableArray.CreateBuilder<PropertySymbol>(members.Count);
        var ctorParams = ImmutableArray.CreateBuilder<ParameterSymbol>(members.Count);
        foreach (var (name, type) in members)
        {
            // Get-only auto-property (C# anonymous-type parity, issue #2224
            // rubber-duck follow-up): a private readonly backing field plus a
            // public get-only property wrapping it — mirroring the real IL
            // shape of a C# anonymous type (and required so EF Core's
            // reflection-based model building, which filters for
            // PropertyInfo, recognizes the synthesized member; see
            // ExpressionTreeLowerer.BuildUserConstructorExpression's 3-arg
            // Expression.New(ctor, args, members) using these PropertySymbols).
            // The synthesized primary constructor assigns the backing field
            // directly (ReflectionMetadataEmitter.EmitClassPrimaryConstructorBodyBytes
            // / TypeDefEmitter.EmitClassPrimaryConstructor fall back to a
            // property's BackingField when no same-named field exists), and
            // DataStructSynthesizer's Equals/GetHashCode/ToString/Deconstruct
            // (ADR-0029) read the backing fields via
            // DataStructSynthesizer.GetSynthesisFields.
            var backingField = new FieldSymbol($"<{name}>k__BackingField", type, Accessibility.Private, isReadOnly: true);
            var property = new PropertySymbol(
                name,
                type,
                Accessibility.Public,
                hasGetter: true,
                hasSetter: false,
                isAutoProperty: true,
                isVirtual: false,
                isOverride: false)
            {
                BackingField = backingField,
            };
            properties.Add(property);
            ctorParams.Add(new ParameterSymbol(name, type));
        }

        // Roslyn-style synthesized name; unique per distinct shape within
        // this cache (one per compile pass).
        var typeName = $"<>AnonymousType{counter++}";
        var symbol = new StructSymbol(
            typeName,
            ImmutableArray<FieldSymbol>.Empty,
            Accessibility.Public,
            declaration: null,
            packageName: packageName ?? string.Empty,
            isData: true,
            isInline: false,
            isClass: false,
            primaryConstructorParameters: ctorParams.MoveToImmutable());
        symbol.SetProperties(properties.MoveToImmutable());

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
