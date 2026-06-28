#nullable disable

// <copyright file="BoundBodyCacheKey.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0105 (Phase 1) — the stable, content-addressed key of a cached member
/// body: a <see cref="StableMemberId"/> (position-independent member identity)
/// paired with a <see cref="BodyHash"/> (content hash of the body's source
/// text). Equality and hashing are value-based and use only these two strings,
/// never a symbol or <see cref="Syntax.SyntaxNode"/> reference, so a key is
/// identical across re-parses of byte-identical text and differs whenever the
/// body changes.
/// </summary>
public readonly struct BoundBodyCacheKey : IEquatable<BoundBodyCacheKey>
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundBodyCacheKey"/> struct.
    /// </summary>
    /// <param name="stableMemberId">The position-independent member identity.</param>
    /// <param name="bodyHash">The content hash of the member body's source text.</param>
    public BoundBodyCacheKey(string stableMemberId, string bodyHash)
    {
        StableMemberId = stableMemberId ?? string.Empty;
        BodyHash = bodyHash ?? string.Empty;
    }

    /// <summary>
    /// Gets the position-independent member identity (source file path, owning
    /// package, containing-type path and name + parameter-type signature).
    /// </summary>
    public string StableMemberId { get; }

    /// <summary>Gets the content hash of the member body's source text.</summary>
    public string BodyHash { get; }

    /// <summary>Determines whether two keys are equal.</summary>
    /// <param name="left">The left key.</param>
    /// <param name="right">The right key.</param>
    /// <returns><see langword="true"/> when the keys are equal.</returns>
    public static bool operator ==(BoundBodyCacheKey left, BoundBodyCacheKey right) => left.Equals(right);

    /// <summary>Determines whether two keys are not equal.</summary>
    /// <param name="left">The left key.</param>
    /// <param name="right">The right key.</param>
    /// <returns><see langword="true"/> when the keys are not equal.</returns>
    public static bool operator !=(BoundBodyCacheKey left, BoundBodyCacheKey right) => !left.Equals(right);

    /// <inheritdoc/>
    public bool Equals(BoundBodyCacheKey other) =>
        string.Equals(StableMemberId, other.StableMemberId, StringComparison.Ordinal)
        && string.Equals(BodyHash, other.BodyHash, StringComparison.Ordinal);

    /// <inheritdoc/>
    public override bool Equals(object obj) => obj is BoundBodyCacheKey other && Equals(other);

    /// <inheritdoc/>
    public override int GetHashCode() => HashCode.Combine(
        StringComparer.Ordinal.GetHashCode(StableMemberId ?? string.Empty),
        StringComparer.Ordinal.GetHashCode(BodyHash ?? string.Empty));

    /// <inheritdoc/>
    public override string ToString() => $"{StableMemberId}#{BodyHash}";
}
