// <copyright file="BoundBodyCacheKey.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System

/// ADR-0105 (Phase 1) — the stable, content-addressed key of a cached member
/// body: a (cref:StableMemberId) (position-independent member identity)
/// paired with a (cref:BodyHash) (content hash of the body's source
/// text). Equality and hashing are value-based and use only these two strings,
/// never a symbol or (cref:Syntax.SyntaxNode) reference, so a key is
/// identical across re-parses of byte-identical text and differs whenever the
/// body changes.
internal data struct BoundBodyCacheKey(StableMemberId string, BodyHash string) : IEquatable[BoundBodyCacheKey] {
    /// Gets the position-independent member identity (source file path, owning
    /// package, containing-type path and name + parameter-type signature).
    private var _stableMemberId string = StableMemberId ?? string.Empty

    prop StableMemberId string -> _stableMemberId

    /// Gets the content hash of the member body's source text.
    private var _bodyHash string = BodyHash ?? string.Empty

    prop BodyHash string -> _bodyHash

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func ToString() string -> "$StableMemberId#$BodyHash"
}
