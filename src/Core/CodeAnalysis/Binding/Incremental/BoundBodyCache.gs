// <copyright file="BoundBodyCache.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Concurrent
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Security.Cryptography
import System.Text
import System.Threading
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Text

/// ADR-0105 (Phase 1) — a per-project cache of lowered member bodies keyed by a
/// <em>stable, content-addressed</em> identity rather than by symbol object
/// reference, syntax-node reference, or source span.
/// @remarks The cache key is conceptually `(stableMemberId, bodyHash)`:
///
/// - `stableMemberId` is position-independent: source file path, owning package, containing-type path
/// (if any) and the member's name + parameter-type signature (via
/// (cref:Binder.FormatOverloadSignature)). It deliberately depends on <em>none</em> of: a symbol object
/// reference, a (cref:SyntaxNode) reference, or a (cref:Text.TextSpan) — all of which shift when
/// earlier text changes.
/// - `bodyHash` is a content hash (SHA-256) of the member body's source text. Any change to the body —
/// including whitespace — produces a different hash and therefore a miss. This is intentionally
/// conservative: over-invalidation only costs a re-bind, whereas under-invalidation would be a
/// correctness bug.
///
/// <strong>Soundness gate (critical — read ADR-0105 "Stable symbol identity"
/// and "Determinism").</strong> A lowered body references symbols drawn from a
/// particular (cref:BoundGlobalScope): the member's own parameters and
/// locals, the sibling functions/types it calls, and so on. Splicing such a
/// body into a different compilation is only sound if those referenced symbol
/// <em>instances</em> are the exact instances that compilation uses (the
/// emitter and binder key members by reference identity, not by signature).
///
/// ADR-0105 <strong>Phase 2</strong> establishes that identity: a body-only,
/// single-file edit produces a new (cref:Compilation.Compilation) that
/// <em>reuses the prior compilation's symbol instances</em> (the edited file's
/// declarations are re-pointed at the freshly-parsed syntax via
/// (cref:IncrementalGlobalScopeReuse); every other file's symbols flow
/// through unchanged). Because the symbol instances survive across the edit,
/// the soundness gate is the <em>symbol identity of the member</em>: a cached
/// body is reused only when the member symbol presented on lookup is the
/// <em>same instance</em> that produced the stored body
/// ((cref:object.ReferenceEquals(object, object)) on the member). On the
/// from-scratch / full-rebuild path every member is a fresh instance, so the
/// gate correctly forces a re-bind there (a stale-symbol splice can never
/// occur). This replaces Phase 1's (cref:BoundGlobalScope)-reference
/// gate, which never hit across compilations because each one allocated fresh
/// symbols.
///
/// The cached entry carries both the lowered (cref:BoundBlockStatement)
/// and the per-body diagnostics, so reuse reproduces diagnostics exactly.
///
/// This type is thread-safe. A compilation chain owns one cache (ADR-0212 §8):
/// (cref:Compilation.Compilation.IncrementalBodyReuse) creates it and the successor factories
/// pass it on. A one-shot snapshot compilation never shares it, because its
/// symbols are new objects and every lookup would miss the identity gate while
/// every store would evict the live entry.
internal class BoundBodyCache {
    private let entries ConcurrentDictionary[BoundBodyCacheKey, Entry] = ConcurrentDictionary[
        BoundBodyCacheKey,
        Entry
    ]()

    // ponytail: only the latest body per member is ever reusable (an edit makes
    // every prior bodyHash for that member unreachable — see TryReuse's
    // ReferenceEquals gate), so tracking the current key per member and evicting
    // its predecessor keeps the cache at O(members) instead of growing with every edit.
    private let latestKeyByMember ConcurrentDictionary[string, BoundBodyCacheKey] = ConcurrentDictionary[
        string,
        BoundBodyCacheKey
    ]()

    private var hits int64
    private var misses int64
    private var stores int64

    /// Gets the number of sound cache hits (reused bodies) served so far.
    prop Hits int64 -> Interlocked.Read(&hits)

    /// Gets the number of cache misses (bodies that had to be bound from scratch) so far.
    prop Misses int64 -> Interlocked.Read(&misses)

    /// Gets the number of bodies stored into the cache so far.
    prop Stores int64 -> Interlocked.Read(&stores)

    /// Gets the number of entries currently retained in the cache.
    prop Count int32 -> entries.Count

    /// Attempts a <em>sound</em> reuse of a previously cached lowered body for
    /// [`member`](paramref). A hit is returned only when the stable key
    /// matches <em>and</em> the cached body was bound for the same
    /// [`member`](paramref) symbol instance (the symbol-identity soundness
    /// gate described on this type). On a sound hit, [`loweredBody`](paramref)
    /// and [`diagnostics`](paramref) are exactly what a from-scratch bind
    /// would have produced.
    /// @param member The member symbol whose body is being bound.
    /// @param bodySyntax The body syntax that would be bound and lowered.
    /// @param loweredBody The reused lowered body, on a sound hit.
    /// @param diagnostics The reused per-body diagnostics, on a sound hit.
    /// @returns `true` on a sound hit; otherwise `false`.
    func TryReuse(
        member FunctionSymbol,
        bodySyntax SyntaxNode,
        @MaybeNullWhen(false) out loweredBody BoundBlockStatement?,
        out diagnostics ImmutableArray[Diagnostic]
    ) bool {
        loweredBody = nil
        diagnostics = ImmutableArray[Diagnostic].Empty
        if !TryCreateKey(member, bodySyntax, out var key) {
            return false
        }
        if entries.TryGetValue(key, out var entry) && object.ReferenceEquals(entry.Member, member) {
            loweredBody = entry.LoweredBody
            diagnostics = entry.Diagnostics
            Interlocked.Increment(&hits)
            CompilationMeasurements.Count("bodies.cache-hits")
            return true
        }
        Interlocked.Increment(&misses)
        return false
    }

    /// Stores a freshly bound and lowered body (and its diagnostics) for later
    /// reuse, tagged with the [`member`](paramref) instance it was bound
    /// for so the symbol-identity soundness gate can be enforced on lookup.
    /// @param member The member symbol whose body was bound.
    /// @param bodySyntax The body syntax that was bound and lowered.
    /// @param loweredBody The lowered body to cache.
    /// @param diagnostics The per-body diagnostics to cache alongside the body.
    func Store(
        member FunctionSymbol,
        bodySyntax SyntaxNode,
        loweredBody BoundBlockStatement?,
        diagnostics ImmutableArray[Diagnostic]
    ) {
        if loweredBody == nil || !TryCreateKey(member, bodySyntax, out var key) {
            return
        }
        entries[key] = Entry(
            member,
            loweredBody,
            if diagnostics.IsDefault {
                ImmutableArray[Diagnostic].Empty
            } else {
                diagnostics
            }
        )
        Interlocked.Increment(&stores)
        CompilationMeasurements.Count("bodies.cache-stores")
        // Evict the previous body for this member (if any and if different):
        // a superseded bodyHash can never hit again, so keeping it is a pure leak.
        let priorKey = latestKeyByMember.GetOrAdd(key.StableMemberId, key)
        if !priorKey.Equals(key) {
            latestKeyByMember[key.StableMemberId] = key
            entries.TryRemove(priorKey, out _)
        }
    }

    private class Entry {
        init(member FunctionSymbol, loweredBody BoundBlockStatement, diagnostics ImmutableArray[Diagnostic]) {
            Member = member
            LoweredBody = loweredBody
            Diagnostics = diagnostics
        }

        prop Member FunctionSymbol {
            get;
        }

        prop LoweredBody BoundBlockStatement {
            get;
        }

        prop Diagnostics ImmutableArray[Diagnostic] {
            get;
        }
    }

    shared {
        /// Computes the stable, content-addressed key for a member body. Returns
        /// `false` when a stable key cannot be formed (e.g. a body
        /// with no backing source text), in which case the caller must treat the
        /// lookup as a miss and bind from scratch.
        /// @param member The member symbol whose body is being bound.
        /// @param bodySyntax The body syntax that will be bound and lowered.
        /// @param key The computed stable key, when this method returns true.
        /// @returns `true` when a stable key was formed.
        func TryCreateKey(member FunctionSymbol?, bodySyntax SyntaxNode?, out key BoundBodyCacheKey) bool {
            key = default(BoundBodyCacheKey)
            if member == nil || bodySyntax == nil {
                return false
            }
            let sourceText SourceText? = bodySyntax.SyntaxTree?.Text
            if sourceText == nil {
                return false
            }
            let filePath = sourceText.FileName ?? string.Empty
            let packagePath = member.Package?.Name ?? string.Empty
            let typePath = ComputeContainingTypePath(member)
            let signature = Binder.FormatOverloadSignature(member)
            let stableMemberId = string.Concat(filePath, "|", packagePath, "|", typePath, "|", signature)
            let bodyText = sourceText.ToString(bodySyntax.Span)
            let bodyHash = ComputeHash(bodyText)
            key = BoundBodyCacheKey(stableMemberId, bodyHash)
            return true
        }

        private func ComputeContainingTypePath(member FunctionSymbol) string {
            let owner = member.ReceiverType ?? member.StaticOwnerType ?? member.ExtensionReceiverType
            return owner?.Name ?? string.Empty
        }

        private func ComputeHash(text string) string {
            let bytes = Encoding.UTF8.GetBytes(text ?? string.Empty)
            let hash = SHA256.HashData(bytes)
            return Convert.ToHexString(hash)
        }
    }
}
