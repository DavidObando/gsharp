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
/// particular <see cref="BoundGlobalScope"/>: the member's own parameters and
/// locals, the sibling functions/types it calls, and so on. Splicing such a
/// body into a different compilation is only sound if those referenced symbol
/// <em>instances</em> are the exact instances that compilation uses (the
/// emitter and binder key members by reference identity, not by signature).
/// </para>
/// <para>
/// ADR-0105 <strong>Phase 2</strong> establishes that identity: a body-only,
/// single-file edit produces a new <see cref="Compilation.Compilation"/> that
/// <em>reuses the prior compilation's symbol instances</em> (the edited file's
/// declarations are re-pointed at the freshly-parsed syntax via
/// <see cref="IncrementalGlobalScopeReuse"/>; every other file's symbols flow
/// through unchanged). Because the symbol instances survive across the edit,
/// the soundness gate is the <em>symbol identity of the member</em>: a cached
/// body is reused only when the member symbol presented on lookup is the
/// <em>same instance</em> that produced the stored body
/// (<see cref="object.ReferenceEquals(object, object)"/> on the member). On the
/// from-scratch / full-rebuild path every member is a fresh instance, so the
/// gate correctly forces a re-bind there (a stale-symbol splice can never
/// occur). This replaces Phase 1's <see cref="BoundGlobalScope"/>-reference
/// gate, which never hit across compilations because each one allocated fresh
/// symbols.
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

    // ponytail: only the latest body per member is ever reusable (an edit makes
    // every prior bodyHash for that member unreachable — see TryReuse's
    // ReferenceEquals gate), so tracking the current key per member and evicting
    // its predecessor keeps the cache at O(members) instead of growing with every edit.
    private readonly ConcurrentDictionary<string, BoundBodyCacheKey> latestKeyByMember = new();

    private long hits;
    private long misses;
    private long stores;

    /// <summary>Gets the number of sound cache hits (reused bodies) served so far.</summary>
    public long Hits => Interlocked.Read(ref hits);

    /// <summary>Gets the number of cache misses (bodies that had to be bound from scratch) so far.</summary>
    public long Misses => Interlocked.Read(ref misses);

    /// <summary>Gets the number of bodies stored into the cache so far.</summary>
    public long Stores => Interlocked.Read(ref stores);

    /// <summary>Gets the number of entries currently retained in the cache.</summary>
    public int Count => entries.Count;

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
    /// matches <em>and</em> the cached body was bound for the same
    /// <paramref name="member"/> symbol instance (the symbol-identity soundness
    /// gate described on this type). On a sound hit, <paramref name="loweredBody"/>
    /// and <paramref name="diagnostics"/> are exactly what a from-scratch bind
    /// would have produced.
    /// </summary>
    /// <param name="member">The member symbol whose body is being bound.</param>
    /// <param name="bodySyntax">The body syntax that would be bound and lowered.</param>
    /// <param name="loweredBody">The reused lowered body, on a sound hit.</param>
    /// <param name="diagnostics">The reused per-body diagnostics, on a sound hit.</param>
    /// <returns><see langword="true"/> on a sound hit; otherwise <see langword="false"/>.</returns>
    public bool TryReuse(
        FunctionSymbol member,
        SyntaxNode bodySyntax,
        out BoundBlockStatement loweredBody,
        out ImmutableArray<Diagnostic> diagnostics)
    {
        loweredBody = null;
        diagnostics = ImmutableArray<Diagnostic>.Empty;

        if (!TryCreateKey(member, bodySyntax, out var key))
        {
            return false;
        }

        if (entries.TryGetValue(key, out var entry) && ReferenceEquals(entry.Member, member))
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
    /// reuse, tagged with the <paramref name="member"/> instance it was bound
    /// for so the symbol-identity soundness gate can be enforced on lookup.
    /// </summary>
    /// <param name="member">The member symbol whose body was bound.</param>
    /// <param name="bodySyntax">The body syntax that was bound and lowered.</param>
    /// <param name="loweredBody">The lowered body to cache.</param>
    /// <param name="diagnostics">The per-body diagnostics to cache alongside the body.</param>
    public void Store(
        FunctionSymbol member,
        SyntaxNode bodySyntax,
        BoundBlockStatement loweredBody,
        ImmutableArray<Diagnostic> diagnostics)
    {
        if (loweredBody == null || !TryCreateKey(member, bodySyntax, out var key))
        {
            return;
        }

        entries[key] = new Entry(member, loweredBody, diagnostics.IsDefault ? ImmutableArray<Diagnostic>.Empty : diagnostics);
        Interlocked.Increment(ref stores);

        // Evict the previous body for this member (if any and if different):
        // a superseded bodyHash can never hit again, so keeping it is a pure leak.
        var priorKey = latestKeyByMember.GetOrAdd(key.StableMemberId, key);
        if (!priorKey.Equals(key))
        {
            latestKeyByMember[key.StableMemberId] = key;
            entries.TryRemove(priorKey, out _);
        }
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
        public Entry(FunctionSymbol member, BoundBlockStatement loweredBody, ImmutableArray<Diagnostic> diagnostics)
        {
            Member = member;
            LoweredBody = loweredBody;
            Diagnostics = diagnostics;
        }

        public FunctionSymbol Member { get; }

        public BoundBlockStatement LoweredBody { get; }

        public ImmutableArray<Diagnostic> Diagnostics { get; }
    }
}
