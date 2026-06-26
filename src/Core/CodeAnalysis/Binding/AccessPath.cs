// <copyright file="AccessPath.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Text;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0069 addendum / issue #1180: the key the smart-cast flow analysis uses
/// to record a narrowing. It identifies the storage location whose runtime
/// type a successful test has proven, generalising the original
/// <see cref="VariableSymbol"/> key to also cover a <em>stable member-access
/// path</em> — a chain of immutable members read through a stable receiver
/// (for example <c>x.shape</c> or <c>this.box.lid</c>).
/// </summary>
/// <remarks>
/// <para>
/// An <see cref="AccessPath"/> is the pair (<see cref="Root"/>,
/// <see cref="Members"/>). The root is the variable the chain starts at
/// (a local, parameter, the receiver/<c>this</c> parameter, or a read-only
/// top-level <c>let</c>); the members are the immutable field / property
/// symbols read in order, outermost last. A path with an empty
/// <see cref="Members"/> list denotes a plain variable narrowing and is
/// equivalent to the historical <see cref="VariableSymbol"/> key — hence the
/// implicit conversion from <see cref="VariableSymbol"/> so the existing
/// variable-keyed call-sites continue to compile unchanged.
/// </para>
/// <para>
/// Equality is structural: two paths are equal when they share the same root
/// symbol and the same member symbols, by reference (symbols are reference
/// unique within a compilation). This lets the analysis re-derive an equal key
/// every time it re-binds the same access expression.
/// </para>
/// </remarks>
public sealed class AccessPath : IEquatable<AccessPath>
{
    private AccessPath(VariableSymbol root, ImmutableArray<Symbol> members)
    {
        Root = root;
        Members = members;
    }

    /// <summary>Gets the variable the access chain is rooted at.</summary>
    public VariableSymbol Root { get; }

    /// <summary>
    /// Gets the immutable member symbols (<see cref="FieldSymbol"/> or
    /// <see cref="PropertySymbol"/>) read after the root, outermost last.
    /// Empty for a plain variable narrowing.
    /// </summary>
    public ImmutableArray<Symbol> Members { get; }

    /// <summary>
    /// Gets a value indicating whether this path reads at least one member
    /// after its root (i.e. it is a member-access path rather than a plain
    /// variable).
    /// </summary>
    public bool HasMembers => !Members.IsDefaultOrEmpty;

    /// <summary>
    /// Implicitly lifts a <see cref="VariableSymbol"/> to its plain
    /// variable access path so historical variable-keyed code compiles
    /// against the generalised <see cref="AccessPath"/>-keyed tables.
    /// </summary>
    /// <param name="variable">The variable to lift.</param>
    public static implicit operator AccessPath(VariableSymbol variable) => ForVariable(variable);

    /// <summary>Creates a plain variable access path.</summary>
    /// <param name="variable">The root variable.</param>
    /// <returns>The access path, or <c>null</c> when <paramref name="variable"/> is <c>null</c>.</returns>
    public static AccessPath ForVariable(VariableSymbol variable)
        => variable == null ? null : new AccessPath(variable, ImmutableArray<Symbol>.Empty);

    /// <summary>Returns a new path that appends <paramref name="member"/> to this one.</summary>
    /// <param name="member">The immutable member read after this path.</param>
    /// <returns>The extended path.</returns>
    public AccessPath Append(Symbol member)
    {
        var members = Members.IsDefault ? ImmutableArray<Symbol>.Empty : Members;
        return new AccessPath(Root, members.Add(member));
    }

    /// <summary>
    /// Returns whether <paramref name="other"/> is a prefix of this path (or
    /// equal to it). Used by invalidation: assigning to <c>x.f</c> drops every
    /// narrowing on a path that starts with <c>x.f</c> (e.g. <c>x.f.g</c>).
    /// </summary>
    /// <param name="other">The candidate prefix.</param>
    /// <returns><c>true</c> when this path starts with <paramref name="other"/>.</returns>
    public bool StartsWith(AccessPath other)
    {
        if (other == null || !ReferenceEquals(Root, other.Root))
        {
            return false;
        }

        var thisMembers = Members.IsDefault ? ImmutableArray<Symbol>.Empty : Members;
        var otherMembers = other.Members.IsDefault ? ImmutableArray<Symbol>.Empty : other.Members;
        if (otherMembers.Length > thisMembers.Length)
        {
            return false;
        }

        for (var i = 0; i < otherMembers.Length; i++)
        {
            if (!ReferenceEquals(thisMembers[i], otherMembers[i]))
            {
                return false;
            }
        }

        return true;
    }

    /// <inheritdoc/>
    public bool Equals(AccessPath other)
    {
        if (other == null || !ReferenceEquals(Root, other.Root))
        {
            return false;
        }

        var a = Members.IsDefault ? ImmutableArray<Symbol>.Empty : Members;
        var b = other.Members.IsDefault ? ImmutableArray<Symbol>.Empty : other.Members;
        if (a.Length != b.Length)
        {
            return false;
        }

        for (var i = 0; i < a.Length; i++)
        {
            if (!ReferenceEquals(a[i], b[i]))
            {
                return false;
            }
        }

        return true;
    }

    /// <inheritdoc/>
    public override bool Equals(object obj) => Equals(obj as AccessPath);

    /// <inheritdoc/>
    public override int GetHashCode()
    {
        var hash = default(HashCode);
        hash.Add(Root);
        if (!Members.IsDefaultOrEmpty)
        {
            foreach (var member in Members)
            {
                hash.Add(member);
            }
        }

        return hash.ToHashCode();
    }

    /// <inheritdoc/>
    public override string ToString()
    {
        var builder = new StringBuilder(Root?.Name ?? "<null>");
        if (!Members.IsDefaultOrEmpty)
        {
            foreach (var member in Members)
            {
                builder.Append('.').Append(member.Name);
            }
        }

        return builder.ToString();
    }
}
