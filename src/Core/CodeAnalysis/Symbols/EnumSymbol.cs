// <copyright file="EnumSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a user-defined enum type backed by <see cref="int"/>.
/// </summary>
public sealed class EnumSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<(EnumSymbol Definition, TypeArgsKey EnclosingArgs), EnumSymbol> ConstructedNestedCache = new();

    private ImmutableArray<EnumMemberSymbol> members;

    /// <summary>
    /// Initializes a new instance of the <see cref="EnumSymbol"/> class.
    /// </summary>
    /// <param name="name">The enum type name.</param>
    /// <param name="accessibility">The enum accessibility.</param>
    /// <param name="packageName">The declaring package name.</param>
    /// <param name="declaration">The declaring syntax node.</param>
    public EnumSymbol(
        string name,
        Accessibility accessibility,
        string packageName,
        EnumDeclarationSyntax declaration)
        : base(name)
    {
        Accessibility = accessibility;
        PackageName = packageName;
        Declaration = declaration;
        members = ImmutableArray<EnumMemberSymbol>.Empty;
        Definition = this;
    }

    /// <summary>Gets the enum accessibility.</summary>
    public Accessibility Accessibility { get; }

    /// <summary>Gets the package the enum lives in.</summary>
    public string PackageName { get; }

    /// <inheritdoc/>
    public override string? ContainingNamespace => PackageName;

    /// <summary>Gets the declaring syntax node.</summary>
    public EnumDeclarationSyntax Declaration { get; }

    /// <inheritdoc/>
    public override ImmutableArray<SyntaxNode> DeclaringSyntaxNodes =>
        Declaration is { } declaration ? ImmutableArray.Create<SyntaxNode>(declaration) : ImmutableArray<SyntaxNode>.Empty;

    /// <summary>Gets the enum members in declaration order.</summary>
    public ImmutableArray<EnumMemberSymbol> Members => Definition != null && !ReferenceEquals(Definition, this)
        ? Definition.Members
        : members;

    /// <summary>
    /// Gets the open declaration represented by this symbol. Definitions point
    /// to themselves; constructed nested references point to the declaration.
    /// </summary>
    public EnumSymbol Definition { get; private set; }

    /// <summary>
    /// Gets the flattened enclosing construction arguments in CLR order.
    /// </summary>
    public ImmutableArray<TypeSymbol> EnclosingTypeArguments { get; private set; } = ImmutableArray<TypeSymbol>.Empty;

    /// <summary>
    /// Gets metadata-only generic parameters used when a nested enum is reified
    /// over generic enclosing types.
    /// </summary>
    public ImmutableArray<TypeParameterSymbol> TypeParameters { get; private set; } = ImmutableArray<TypeParameterSymbol>.Empty;

    /// <summary>Gets the CLR underlying enum for values.</summary>
    public TypeSymbol UnderlyingType => TypeSymbol.Int32;

    /// <summary>Sets <see cref="Symbol.ContainingType"/> (ADR-0110 / issue #910).</summary>
    /// <param name="containingType">The enclosing user-defined type.</param>
    public void SetContainingType(TypeSymbol? containingType)
    {
        ContainingType = containingType;
    }

    /// <summary>Sets the enum members after the owning enum symbol has been created.</summary>
    /// <param name="members">The enum members in declaration order.</param>
    public void SetMembers(ImmutableArray<EnumMemberSymbol> members)
    {
        this.members = members;
    }

    /// <summary>Looks up an enum member by name.</summary>
    /// <param name="name">The member name.</param>
    /// <param name="member">The found member, if any.</param>
    /// <returns>True if the member exists.</returns>
    public bool TryGetMember(string name, [NotNullWhen(true)] out EnumMemberSymbol? member)
    {
        foreach (var candidate in Members)
        {
            if (string.Equals(candidate.Name, name, System.StringComparison.Ordinal))
            {
                member = candidate;
                return true;
            }
        }

        member = null;
        return false;
    }

    /// <summary>
    /// Constructs a nested enum reference over its enclosing type arguments.
    /// </summary>
    /// <param name="nestedDefinition">The open nested enum declaration.</param>
    /// <param name="enclosingTypeArguments">Flattened enclosing arguments in CLR order.</param>
    /// <returns>The interned constructed reference.</returns>
    [return: NotNullIfNotNull(nameof(nestedDefinition))]
    public static EnumSymbol? ConstructNested(
        EnumSymbol? nestedDefinition,
        ImmutableArray<TypeSymbol> enclosingTypeArguments)
    {
        if (nestedDefinition == null || enclosingTypeArguments.IsDefaultOrEmpty)
        {
            return nestedDefinition;
        }

        var def = nestedDefinition.Definition ?? nestedDefinition;
        var key = new TypeArgsKey(enclosingTypeArguments);
        return ConstructedNestedCache.GetOrAdd(
            (def, key),
            _ => CreateConstructedNested(def, enclosingTypeArguments));
    }

    /// <summary>
    /// Substitutes the enclosing generic parameters of a nested enum.
    /// </summary>
    /// <param name="nested">The enum definition or constructed reference.</param>
    /// <param name="substitute">The type substitution.</param>
    /// <returns>The substituted enclosing vector, or <c>default</c> when none exists.</returns>
    public static ImmutableArray<TypeSymbol> SubstituteEnclosingArguments(
        EnumSymbol? nested,
        Func<TypeSymbol, TypeSymbol>? substitute)
    {
        if (nested == null || substitute == null)
        {
            return default;
        }

        ImmutableArray<TypeSymbol> current;
        if (!nested.EnclosingTypeArguments.IsDefaultOrEmpty)
        {
            current = nested.EnclosingTypeArguments;
        }
        else
        {
            var enclosingParameters = StructSymbol.CollectEnclosingTypeParameters(nested);
            if (enclosingParameters.IsDefaultOrEmpty)
            {
                return default;
            }

            var currentBuilder = ImmutableArray.CreateBuilder<TypeSymbol>(enclosingParameters.Length);
            foreach (var parameter in enclosingParameters)
            {
                currentBuilder.Add(parameter);
            }

            current = currentBuilder.MoveToImmutable();
        }

        var builder = ImmutableArray.CreateBuilder<TypeSymbol>(current.Length);
        foreach (var argument in current)
        {
            builder.Add(substitute(argument));
        }

        return builder.MoveToImmutable();
    }

    /// <summary>
    /// Closes a nested enum over the generic parameters currently in lexical scope.
    /// </summary>
    /// <param name="nested">The open nested enum.</param>
    /// <param name="typeParameters">Type parameters indexed by source name.</param>
    /// <returns>The constructed nested enum, or <paramref name="nested"/> when its enclosing parameters are not all in scope.</returns>
    [return: NotNullIfNotNull(nameof(nested))]
    internal static EnumSymbol? ConstructNestedFromTypeParameterScope(
        EnumSymbol? nested,
        IReadOnlyDictionary<string, TypeParameterSymbol>? typeParameters)
    {
        if (nested == null || !nested.EnclosingTypeArguments.IsDefaultOrEmpty || typeParameters == null)
        {
            return nested;
        }

        var enclosingParameters = StructSymbol.CollectEnclosingTypeParameters(nested);
        var enclosingArguments = ImmutableArray.CreateBuilder<TypeSymbol>(enclosingParameters.Length);
        foreach (var parameter in enclosingParameters)
        {
            if (!typeParameters.TryGetValue(parameter.Name, out var argument))
            {
                return nested;
            }

            enclosingArguments.Add(argument);
        }

        return enclosingArguments.Count == 0
            ? nested
            : ConstructNested(nested.Definition ?? nested, enclosingArguments.MoveToImmutable());
    }

    /// <summary>
    /// Sets metadata-only generic parameters for the reified nested enum TypeDef.
    /// </summary>
    /// <param name="typeParameters">The flattened enclosing parameters.</param>
    internal void SetTypeParameters(ImmutableArray<TypeParameterSymbol> typeParameters)
    {
        TypeParameters = typeParameters.IsDefault
            ? ImmutableArray<TypeParameterSymbol>.Empty
            : typeParameters;
    }

    /// <summary>Clears constructed nested enum symbols between compilations.</summary>
    internal static void ClearCache() => ConstructedNestedCache.Clear();

    private static EnumSymbol CreateConstructedNested(
        EnumSymbol definition,
        ImmutableArray<TypeSymbol> enclosingTypeArguments)
    {
        var constructed = new EnumSymbol(
            definition.Name,
            definition.Accessibility,
            definition.PackageName,
            definition.Declaration)
        {
            Definition = definition,
            EnclosingTypeArguments = enclosingTypeArguments,
        };
        constructed.SetContainingType(definition.ContainingType);
        return constructed;
    }
}
