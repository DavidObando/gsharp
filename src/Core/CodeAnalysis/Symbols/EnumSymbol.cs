// <copyright file="EnumSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a user-defined enum type backed by <see cref="int"/>.
/// </summary>
public sealed class EnumSymbol : TypeSymbol
{
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
        Members = ImmutableArray<EnumMemberSymbol>.Empty;
    }

    /// <summary>Gets the enum accessibility.</summary>
    public Accessibility Accessibility { get; }

    /// <summary>Gets the package the enum lives in.</summary>
    public string PackageName { get; }

    /// <summary>Gets the declaring syntax node.</summary>
    public EnumDeclarationSyntax Declaration { get; }

    /// <summary>Gets the enum members in declaration order.</summary>
    public ImmutableArray<EnumMemberSymbol> Members { get; private set; }

    /// <summary>Gets the CLR underlying type for enum values.</summary>
    public TypeSymbol UnderlyingType => TypeSymbol.Int;

    /// <summary>Sets the enum members after the owning enum symbol has been created.</summary>
    /// <param name="members">The enum members in declaration order.</param>
    public void SetMembers(ImmutableArray<EnumMemberSymbol> members)
    {
        Members = members;
    }

    /// <summary>Looks up an enum member by name.</summary>
    /// <param name="name">The member name.</param>
    /// <param name="member">The found member, if any.</param>
    /// <returns>True if the member exists.</returns>
    public bool TryGetMember(string name, out EnumMemberSymbol member)
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
}
