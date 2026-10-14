// <copyright file="BoundBodyCacheTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// ADR-0105 (Phase 1) — tests for (cref:BoundBodyCache): the
/// content-addressed bound-body cache and its soundness gate.
open class BoundBodyCacheTests {
    /// (a) A cache-backed bind reuses the exact lowered body a from-scratch
    /// bind produced: same object reference and byte-identical
    /// (cref:BoundNodePrinter) output. Reuse is only sound when the
    /// cached body was bound against the same (cref:BoundGlobalScope)
    /// instance, so we drive two binds over the <em>same</em> scope.
    @Fact
    func CacheBackedBind_Reuses_ByteIdentical_Bodies() {
        let source = `package P
func Add(a int, b int) int {
    var s = a + b
    return s
}
func Loop() int {
    var total = 0
    for var i = 0; i < 10; i++ {
        total = total + i
    }
    return total
}`
        let globalScope = BindGlobalScope(source)
        let cache = BoundBodyCache()
        let fromScratch = Binder.BindProgram(globalScope, references: nil)
        let firstWithCache = Binder.BindProgram(globalScope, references: nil, cache)
        let secondWithCache = Binder.BindProgram(globalScope, references: nil, cache)
        Assert.True(cache.Stores > int64(0))
        Assert.True(cache.Hits > int64(0))
        for function in globalScope.Functions {
            // The second cache-backed bind reuses the very object the first
            // bind stored (proving an actual hit, not a silent re-bind).
            Assert.Same(firstWithCache.Functions[function], secondWithCache.Functions[function])
            // And the cached body is byte-for-byte what a from-scratch bind
            // produced.
            Assert.Equal(Print(fromScratch.Functions[function]), Print(secondWithCache.Functions[function]))
        }
        // Diagnostics are reproduced exactly across the cache boundary.
        Assert.Equal(Print(fromScratch.Diagnostics), Print(secondWithCache.Diagnostics))
    }

    /// (b) The stable key is identical across re-parses of byte-identical text
    /// (position-independent identity), and DIFFERENT when the member body
    /// changes (content-addressed).
    @Fact
    func StableKey_Is_Stable_Across_Reparse_And_Changes_With_Body() {
        const original = `package P
func F(x int) int {
    return x + 1
}`
        // A leading comment shifts every span downward but must NOT change the
        // stable key: identity is file + type + signature + body-text, never a
        // span or node reference.
        const spanShifted = `package P
// an unrelated leading comment that shifts spans
func F(x int) int {
    return x + 1
}`
        const bodyChanged = `package P
func F(x int) int {
    return x + 2
}`
        let keyOriginal = KeyOfFirstFunction(original)
        let keyReparsed = KeyOfFirstFunction(original)
        let keyShifted = KeyOfFirstFunction(spanShifted)
        let keyChanged = KeyOfFirstFunction(bodyChanged)
        Assert.Equal(keyOriginal, keyReparsed)
        Assert.Equal(keyOriginal.GetHashCode(), keyReparsed.GetHashCode())
        Assert.Equal(keyOriginal, keyShifted)
        Assert.NotEqual(keyOriginal, keyChanged)
    }

    /// (c) Editing one file does not corrupt another file's bound body. Two
    /// files contribute distinct functions; reuse serves each its own body and
    /// never cross-contaminates, and a body change in one file does not alter
    /// the other file's key.
    @Fact
    func Reuse_Does_Not_Corrupt_Other_Files_Bodies() {
        let fileA = SyntaxTree.Parse(SourceText.From(`package P
func Alpha() int {
    return 111
}`, fileName: "A.gs"))
        let fileB = SyntaxTree.Parse(SourceText.From(`package P
func Beta() int {
    return 222
}`, fileName: "B.gs"))
        let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(fileA, fileB))
        let cache = BoundBodyCache()
        let fromScratch = Binder.BindProgram(globalScope, references: nil)
        Binder.BindProgram(globalScope, references: nil, cache) // populate
        let reused = Binder.BindProgram(globalScope, references: nil, cache) // hit
        let alpha = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Alpha")
        let beta = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Beta")
        // Each reused body matches its own from-scratch counterpart...
        Assert.Equal(Print(fromScratch.Functions[alpha]), Print(reused.Functions[alpha]))
        Assert.Equal(Print(fromScratch.Functions[beta]), Print(reused.Functions[beta]))
        // ...and the two bodies remain distinct (no cross-file leakage).
        Assert.NotEqual(Print(reused.Functions[alpha]), Print(reused.Functions[beta]))
        // Changing file B's body must not change file A's stable key.
        let editedB = SyntaxTree.Parse(SourceText.From(`package P
func Beta() int {
    return 999
}`, fileName: "B.gs"))
        let editedScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(fileA, editedB))
        Assert.Equal(KeyOf(globalScope, "Alpha"), KeyOf(editedScope, "Alpha"))
        Assert.NotEqual(KeyOf(globalScope, "Beta"), KeyOf(editedScope, "Beta"))
    }

    /// Soundness gate: a body cached against one (cref:BoundGlobalScope)
    /// instance is NEVER reused for a different scope instance (which would
    /// reference stale, freshly-allocated symbols). This is what keeps Phase 1
    /// correct — and is why reuse is a near-no-op until Phase 2 gives symbols
    /// stable cross-compilation identity.
    @Fact
    func SoundnessGate_Blocks_Reuse_Across_Different_Scope_Instances() {
        const source = `package P
func F() int {
    return 42
}`
        let scope1 = BindGlobalScope(source)
        let scope2 = BindGlobalScope(source) // identical text, fresh symbols
        let cache = BoundBodyCache()
        let program1 = Binder.BindProgram(scope1, references: nil, cache) // populate against scope1
        let hitsBefore = cache.Hits
        let program2 = Binder.BindProgram(scope2, references: nil, cache) // must NOT reuse scope1's bodies
        let hitsAfter = cache.Hits
        Assert.Equal(hitsBefore, hitsAfter)
        let f1 = scope1.Functions.Single((f FunctionSymbol) -> f.Name == "F")
        let f2 = scope2.Functions.Single((f FunctionSymbol) -> f.Name == "F")
        // Different scope → freshly bound body (different object), even though
        // the printed form is identical text.
        Assert.NotSame(program1.Functions[f1], program2.Functions[f2])
        Assert.Equal(Print(program1.Functions[f1]), Print(program2.Functions[f2]))
    }

    /// The optional cache parameter never changes (cref:BindProgram)'s
    /// output for a wide member surface (functions, instance/static methods,
    /// computed properties): bodies and diagnostics are byte-identical to the
    /// full-rebuild path.
    @Fact
    func CachePath_Matches_FullRebuild_For_Mixed_Members() {
        let source = `package P
struct Counter {
    var value int

    func Bump() int {
        value = value + 1
        return value
    }

    var Doubled int {
        get { return value * 2 }
    }
}
func Top(n int) int {
    if n > 0 {
        return n
    }
    return 0
}`
        let globalScope = BindGlobalScope(source)
        let noCache = Binder.BindProgram(globalScope, references: nil)
        let withCache = Binder.BindProgram(globalScope, references: nil, BoundBodyCache())
        Assert.Equal(Print(noCache.Diagnostics), Print(withCache.Diagnostics))
        for function in noCache.Functions.Keys {
            Assert.Equal(Print(noCache.Functions[function]), Print(withCache.Functions[function]))
        }
    }

    /// Emit is bit-for-bit identical whether the bound program came from a
    /// cache hit or a from-scratch bind. A sound cache hit reuses the same
    /// lowered bodies, and emit is a pure function of the bound program, so the
    /// emitted PE must be byte-identical — the load-bearing determinism
    /// guarantee from ADR-0105.
    @Fact
    func Emit_Is_ByteIdentical_For_CacheHit_Vs_FromScratch() {
        let source = `package P
func Add(a int, b int) int {
    var s = a + b
    return s
}
func Choose(n int) int {
    if n > 0 {
        return n
    }
    return 0 - n
}`
        let globalScope = BindGlobalScope(source)
        let fromScratch = Binder.BindProgram(globalScope, references: nil)
        let cache = BoundBodyCache()
        Binder.BindProgram(globalScope, references: nil, cache) // populate
        let fromCache = Binder.BindProgram(globalScope, references: nil, cache) // hit
        Assert.True(cache.Hits > int64(0))
        let fromScratchPe = EmitToBytes(fromScratch)
        let fromCachePe = EmitToBytes(fromCache)
        Assert.Equal(fromScratchPe, fromCachePe)
    }

    /// Issue #1645 — repeatedly editing one member's body must not leak stale
    /// entries: only the current (memberId, bodyHash) stays cached, while a
    /// lookup for that current body still hits.
    @Fact
    func Store_Evicts_Stale_BodyHashes_For_Same_Member_On_Edit() {
        let cache = BoundBodyCache()
        var lastKey = default(BoundBodyCacheKey)
        var lastFunction FunctionSymbol? = nil
        for var i = 0; i < 5; i++ {
            let source = (`package P
func F(x int) int {
    return x + ` + "$i" + `
}`)
            let globalScope = BindGlobalScope(source)
            let function = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "F")
            let body = BoundBlockStatement(function.Declaration!!.Body, ImmutableArray[BoundStatement].Empty)
            cache.Store(function, function.Declaration!!.Body!!, body, ImmutableArray[Diagnostic].Empty)
            lastFunction = function
            Assert.True(BoundBodyCache.TryCreateKey(function, function.Declaration!!.Body!!, out lastKey))
        }
        // Only the most recent edit's body survives — no unbounded growth.
        Assert.Equal(1, cache.Count)
        // The current (memberId, bodyHash) still hits.
        Assert.True(cache.TryReuse(lastFunction!!, lastFunction!!.Declaration!!.Body!!, out _, out _))
    }

    shared {
        private func EmitToBytes(program BoundProgram)[]uint8 {
            using let stream = MemoryStream()
            ReflectionMetadataEmitter.Emit(program, stream, references: nil, assemblyName: "CacheDeterminism")
            return stream.ToArray()
        }

        private func BindGlobalScope(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }

        private func KeyOfFirstFunction(source string) BoundBodyCacheKey {
            let globalScope = BindGlobalScope(source)
            let function = globalScope.Functions.First((f FunctionSymbol) -> f.Declaration != nil)
            Assert.True(BoundBodyCache.TryCreateKey(function, function.Declaration!!.Body!!, out var key))
            return key
        }

        private func KeyOf(globalScope BoundGlobalScope, functionName string) BoundBodyCacheKey {
            let function = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == functionName)
            Assert.True(BoundBodyCache.TryCreateKey(function, function.Declaration!!.Body!!, out var key))
            return key
        }

        private func Print(node BoundNode) string {
            let writer = StringWriter()
            BoundNodeWriter.WriteTo(node, writer)
            return writer.ToString()
        }

        private func Print(diagnostics ImmutableArray[Diagnostic]) string -> string.Join(
            "\n",
            diagnostics.Select((d Diagnostic) -> "${d.Id}:${d.Severity}:${d.Message}")
        )
    }
}
