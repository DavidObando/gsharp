// <copyright file="PathMember.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Reflection;
using System.Runtime.CompilerServices;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Identifies one source or imported CLR member in an <see cref="AccessPath"/>.
/// </summary>
public readonly struct PathMember : IEquatable<PathMember>
{
    /// <summary>Initializes a new instance of the <see cref="PathMember"/> struct for a source symbol.</summary>
    /// <param name="sourceSymbol">The source member symbol.</param>
    public PathMember(Symbol sourceSymbol)
    {
        SourceSymbol = sourceSymbol ?? throw new ArgumentNullException(nameof(sourceSymbol));
        ClrMember = null;
    }

    /// <summary>Initializes a new instance of the <see cref="PathMember"/> struct for an imported CLR member.</summary>
    /// <param name="clrMember">The reflected CLR member.</param>
    public PathMember(MemberInfo clrMember)
    {
        ClrMember = clrMember ?? throw new ArgumentNullException(nameof(clrMember));
        SourceSymbol = null;
    }

    /// <summary>Gets the source member symbol, or <see langword="null"/> for a CLR member.</summary>
    public Symbol? SourceSymbol { get; }

    /// <summary>Gets the reflected CLR member, or <see langword="null"/> for a source member.</summary>
    public MemberInfo? ClrMember { get; }

    /// <summary>Gets the member name.</summary>
    public string? Name => SourceSymbol?.Name ?? ClrMember?.Name;

    /// <summary>Determines whether two path members identify the same member.</summary>
    /// <param name="left">The first path member.</param>
    /// <param name="right">The second path member.</param>
    /// <returns><see langword="true"/> when both values identify the same member.</returns>
    public static bool operator ==(PathMember left, PathMember right) => left.Equals(right);

    /// <summary>Determines whether two path members identify different members.</summary>
    /// <param name="left">The first path member.</param>
    /// <param name="right">The second path member.</param>
    /// <returns><see langword="true"/> when the values identify different members.</returns>
    public static bool operator !=(PathMember left, PathMember right) => !left.Equals(right);

    /// <inheritdoc/>
    public bool Equals(PathMember other)
    {
        if (SourceSymbol != null || other.SourceSymbol != null)
        {
            return ReferenceEquals(SourceSymbol, other.SourceSymbol);
        }

        if (ClrMember == null || other.ClrMember == null)
        {
            return ClrMember == null && other.ClrMember == null;
        }

        return ClrMember.MetadataToken == other.ClrMember.MetadataToken
            && ReferenceEquals(ClrMember.Module, other.ClrMember.Module);
    }

    /// <inheritdoc/>
    public override bool Equals(object? obj) => obj is PathMember other && Equals(other);

    /// <inheritdoc/>
    public override int GetHashCode()
    {
        if (SourceSymbol != null)
        {
            return RuntimeHelpers.GetHashCode(SourceSymbol);
        }

        return ClrMember == null
            ? 0
            : HashCode.Combine(RuntimeHelpers.GetHashCode(ClrMember.Module), ClrMember.MetadataToken);
    }

    /// <inheritdoc/>
    public override string ToString() => Name ?? string.Empty;
}
