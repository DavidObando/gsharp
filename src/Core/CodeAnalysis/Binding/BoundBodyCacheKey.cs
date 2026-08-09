// <copyright file="BoundBodyCacheKey.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
public readonly record struct BoundBodyCacheKey(string StableMemberId, string BodyHash)
{
    /// <summary>
    /// Gets the position-independent member identity (source file path, owning
    /// package, containing-type path and name + parameter-type signature).
    /// </summary>
    public string StableMemberId { get; } = StableMemberId ?? string.Empty;

    /// <summary>Gets the content hash of the member body's source text.</summary>
    public string BodyHash { get; } = BodyHash ?? string.Empty;

    /// <inheritdoc/>
    public override string ToString() => $"{StableMemberId}#{BodyHash}";
}
