// <copyright file="BoundBodyCache.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0105 (Phase 1) — a per-project cache of lowered member bodies keyed by a
/// <em>stable, content-addressed</em> identity rather than by symbol object
/// reference, syntax-node reference, or source span.
/// </summary>
/// <remarks>
/// <para>
/// The cache key is conceptually <c>(stableMemberId, bodyHash)</c>:
/// </para>
/// <list type="bullet">
///   <item><description>
///     <c>stableMemberId</c> is position-independent: source file path, owning
///     package, containing-type path (if any) and the member's name +
///     parameter-type signature (via <see cref="Binder.FormatOverloadSignature"/>).
///     It deliberately depends on <em>none</em> of: a symbol object reference, a
///     <see cref="SyntaxNode"/> reference, or a <see cref="Text.TextSpan"/> —
///     all of which shift when earlier text changes.
///   </description></item>
///   <item><description>
///     <c>bodyHash</c> is a content hash (SHA-256) of the member body's source
///     text. Any change to the body — including whitespace — produces a
///     different hash and therefore a miss. This is intentionally conservative:
///     over-invalidation only costs a re-bind, whereas under-invalidation would
///     be a correctness bug.
///   </description></item>
/// </list>
/// <para>
/// <strong>Soundness gate (critical — read ADR-0105 "Stable symbol identity"
/// and "Determinism").</strong> A lowered body references symbols drawn from a
/// particular <see cref="BoundGlobalScope"/>. Until ADR-0105 Phase 2 introduces
/// per-file symbol tables with stable symbol identity, every fresh
/// <see cref="Compilation.Compilation"/> allocates <em>fresh</em> symbol
/// instances, so a body cached against compilation <c>N</c>'s symbols cannot be
/// spliced into compilation <c>N+1</c> without silently referencing stale
/// symbols. To keep emit and diagnostics bit-for-bit identical to the
/// full-rebuild path, reuse is therefore gated on the cached body having been
/// bound against the <em>same</em> <see cref="BoundGlobalScope"/> instance
/// (reference equality), which guarantees the referenced symbols are the exact
/// same instances. Across language-server edits this gate is (by design)
/// almost never satisfied — Phase 1 lands the infrastructure with a near-zero
/// hit-rate and no user-visible effect, exactly as ADR-0105 states. Phase 2
/// will replace this gate with a symbol-identity-based check so that body-only
/// edits hit.
/// </para>
/// <para>
/// The cached entry carries both the lowered <see cref="BoundBlockStatement"/>
/// and the per-body diagnostics, so reuse reproduces diagnostics exactly.
/// </para>
/// <para>This type is thread-safe.</para>
/// </remarks>
public sealed class BoundBodyCache
{
    private readonly ConcurrentDictionary<BoundBodyCacheKey, Entry> entries = new();

    private long hits;
    private long misses;
    private long stores;

    /// <summary>Gets the number of sound cache hits (reused bodies) served so far.</summary>
    public long Hits => Interlocked.Read(ref hits);

    /// <summary>Gets the number of cache misses (bodies that had to be bound from scratch) so far.</summary>
    public long Misses => Interlocked.Read(ref misses);

    /// <summary>Gets the number of bodies stored into the cache so far.</summary>
    public long Stores => Interlocked.Read(ref stores);

    /// <summary>
    /// Computes the stable, content-addressed key for a member body. Returns
    /// <see langword="false"/> when a stable key cannot be formed (e.g. a body
    /// with no backing source text), in which case the caller must treat the
    /// lookup as a miss and bind from scratch.
    /// </summary>
    /// <param name="member">The member symbol whose body is being bound.</param>
    /// <param name="bodySyntax">The body syntax that will be bound and lowered.</param>
    /// <param name="key">The computed stable key, when this method returns true.</param>
    /// <returns><see langword="true"/> when a stable key was formed.</returns>
    public static bool TryCreateKey(FunctionSymbol member, SyntaxNode bodySyntax, out BoundBodyCacheKey key)
    {
        key = default;
        if (member == null || bodySyntax == null)
        {
            return false;
        }

        var sourceText = bodySyntax.SyntaxTree?.Text;
        if (sourceText == null)
        {
            return false;
        }

        var filePath = sourceText.FileName ?? string.Empty;
        var packagePath = member.Package?.Name ?? string.Empty;
        var typePath = ComputeContainingTypePath(member);
        var signature = Binder.FormatOverloadSignature(member);
        var stableMemberId = string.Concat(filePath, "|", packagePath, "|", typePath, "|", signature);

        var bodyText = sourceText.ToString(bodySyntax.Span);
        var bodyHash = ComputeHash(bodyText);

        key = new BoundBodyCacheKey(stableMemberId, bodyHash);
        return true;
    }

    /// <summary>
    /// Attempts a <em>sound</em> reuse of a previously cached lowered body for
    /// <paramref name="member"/>. A hit is returned only when the stable key
    /// matches <em>and</em> the cached body was bound against the same
    /// <paramref name="scope"/> instance (the soundness gate described on this
    /// type). On a sound hit, <paramref name="loweredBody"/> and
    /// <paramref name="diagnostics"/> are exactly what a from-scratch bind would
    /// have produced.
    /// </summary>
    /// <param name="scope">The global scope the current bind is running against.</param>
    /// <param name="member">The member symbol whose body is being bound.</param>
    /// <param name="bodySyntax">The body syntax that would be bound and lowered.</param>
    /// <param name="loweredBody">The reused lowered body, on a sound hit.</param>
    /// <param name="diagnostics">The reused per-body diagnostics, on a sound hit.</param>
    /// <returns><see langword="true"/> on a sound hit; otherwise <see langword="false"/>.</returns>
    public bool TryReuse(
        BoundGlobalScope scope,
        FunctionSymbol member,
        SyntaxNode bodySyntax,
        out BoundBlockStatement loweredBody,
        out ImmutableArray<Diagnostic> diagnostics)
    {
        loweredBody = null;
        diagnostics = ImmutableArray<Diagnostic>.Empty;

        if (scope == null || !TryCreateKey(member, bodySyntax, out var key))
        {
            return false;
        }

        if (entries.TryGetValue(key, out var entry) && ReferenceEquals(entry.Scope, scope))
        {
            loweredBody = entry.LoweredBody;
            diagnostics = entry.Diagnostics;
            Interlocked.Increment(ref hits);
            return true;
        }

        Interlocked.Increment(ref misses);
        return false;
    }

    /// <summary>
    /// Stores a freshly bound and lowered body (and its diagnostics) for later
    /// reuse, tagged with the <paramref name="scope"/> it was bound against so
    /// the soundness gate can be enforced on lookup.
    /// </summary>
    /// <param name="scope">The global scope the body was bound against.</param>
    /// <param name="member">The member symbol whose body was bound.</param>
    /// <param name="bodySyntax">The body syntax that was bound and lowered.</param>
    /// <param name="loweredBody">The lowered body to cache.</param>
    /// <param name="diagnostics">The per-body diagnostics to cache alongside the body.</param>
    public void Store(
        BoundGlobalScope scope,
        FunctionSymbol member,
        SyntaxNode bodySyntax,
        BoundBlockStatement loweredBody,
        ImmutableArray<Diagnostic> diagnostics)
    {
        if (scope == null || loweredBody == null || !TryCreateKey(member, bodySyntax, out var key))
        {
            return;
        }

        entries[key] = new Entry(scope, loweredBody, diagnostics.IsDefault ? ImmutableArray<Diagnostic>.Empty : diagnostics);
        Interlocked.Increment(ref stores);
    }

    private static string ComputeContainingTypePath(FunctionSymbol member)
    {
        var owner = member.ReceiverType ?? member.StaticOwnerType ?? member.ExtensionReceiverType;
        return owner?.Name ?? string.Empty;
    }

    private static string ComputeHash(string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text ?? string.Empty);
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash);
    }

    private sealed class Entry
    {
        public Entry(BoundGlobalScope scope, BoundBlockStatement loweredBody, ImmutableArray<Diagnostic> diagnostics)
        {
            Scope = scope;
            LoweredBody = loweredBody;
            Diagnostics = diagnostics;
        }

        public BoundGlobalScope Scope { get; }

        public BoundBlockStatement LoweredBody { get; }

        public ImmutableArray<Diagnostic> Diagnostics { get; }
    }
}
