// <copyright file="BoundBodyCacheTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0105 (Phase 1) — tests for <see cref="BoundBodyCache"/>: the
/// content-addressed bound-body cache and its soundness gate.
/// </summary>
public class BoundBodyCacheTests
{
    /// <summary>
    /// (a) A cache-backed bind reuses the exact lowered body a from-scratch
    /// bind produced: same object reference and byte-identical
    /// <see cref="BoundNodePrinter"/> output. Reuse is only sound when the
    /// cached body was bound against the same <see cref="BoundGlobalScope"/>
    /// instance, so we drive two binds over the <em>same</em> scope.
    /// </summary>
    [Fact]
    public void CacheBackedBind_Reuses_ByteIdentical_Bodies()
    {
        var source = """
            package P
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
            }
            """;
        var globalScope = BindGlobalScope(source);

        var cache = new BoundBodyCache();
        var fromScratch = Binder.BindProgram(globalScope, references: null);
        var firstWithCache = Binder.BindProgram(globalScope, references: null, cache);
        var secondWithCache = Binder.BindProgram(globalScope, references: null, cache);

        Assert.True(cache.Stores > 0);
        Assert.True(cache.Hits > 0);

        foreach (var function in globalScope.Functions)
        {
            // The second cache-backed bind reuses the very object the first
            // bind stored (proving an actual hit, not a silent re-bind).
            Assert.Same(firstWithCache.Functions[function], secondWithCache.Functions[function]);

            // And the cached body is byte-for-byte what a from-scratch bind
            // produced.
            Assert.Equal(Print(fromScratch.Functions[function]), Print(secondWithCache.Functions[function]));
        }

        // Diagnostics are reproduced exactly across the cache boundary.
        Assert.Equal(Print(fromScratch.Diagnostics), Print(secondWithCache.Diagnostics));
    }

    /// <summary>
    /// (b) The stable key is identical across re-parses of byte-identical text
    /// (position-independent identity), and DIFFERENT when the member body
    /// changes (content-addressed).
    /// </summary>
    [Fact]
    public void StableKey_Is_Stable_Across_Reparse_And_Changes_With_Body()
    {
        const string original = """
            package P
            func F(x int) int {
                return x + 1
            }
            """;

        // A leading comment shifts every span downward but must NOT change the
        // stable key: identity is file + type + signature + body-text, never a
        // span or node reference.
        const string spanShifted = """
            package P
            // an unrelated leading comment that shifts spans
            func F(x int) int {
                return x + 1
            }
            """;

        const string bodyChanged = """
            package P
            func F(x int) int {
                return x + 2
            }
            """;

        var keyOriginal = KeyOfFirstFunction(original);
        var keyReparsed = KeyOfFirstFunction(original);
        var keyShifted = KeyOfFirstFunction(spanShifted);
        var keyChanged = KeyOfFirstFunction(bodyChanged);

        Assert.Equal(keyOriginal, keyReparsed);
        Assert.Equal(keyOriginal.GetHashCode(), keyReparsed.GetHashCode());
        Assert.Equal(keyOriginal, keyShifted);
        Assert.NotEqual(keyOriginal, keyChanged);
    }

    /// <summary>
    /// (c) Editing one file does not corrupt another file's bound body. Two
    /// files contribute distinct functions; reuse serves each its own body and
    /// never cross-contaminates, and a body change in one file does not alter
    /// the other file's key.
    /// </summary>
    [Fact]
    public void Reuse_Does_Not_Corrupt_Other_Files_Bodies()
    {
        var fileA = SyntaxTree.Parse(SourceText.From(
            """
            package P
            func Alpha() int {
                return 111
            }
            """, fileName: "A.gs"));
        var fileB = SyntaxTree.Parse(SourceText.From(
            """
            package P
            func Beta() int {
                return 222
            }
            """, fileName: "B.gs"));

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(fileA, fileB));

        var cache = new BoundBodyCache();
        var fromScratch = Binder.BindProgram(globalScope, references: null);
        Binder.BindProgram(globalScope, references: null, cache); // populate
        var reused = Binder.BindProgram(globalScope, references: null, cache); // hit

        var alpha = globalScope.Functions.Single(f => f.Name == "Alpha");
        var beta = globalScope.Functions.Single(f => f.Name == "Beta");

        // Each reused body matches its own from-scratch counterpart...
        Assert.Equal(Print(fromScratch.Functions[alpha]), Print(reused.Functions[alpha]));
        Assert.Equal(Print(fromScratch.Functions[beta]), Print(reused.Functions[beta]));

        // ...and the two bodies remain distinct (no cross-file leakage).
        Assert.NotEqual(Print(reused.Functions[alpha]), Print(reused.Functions[beta]));

        // Changing file B's body must not change file A's stable key.
        var editedB = SyntaxTree.Parse(SourceText.From(
            """
            package P
            func Beta() int {
                return 999
            }
            """, fileName: "B.gs"));
        var editedScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(fileA, editedB));

        Assert.Equal(KeyOf(globalScope, "Alpha"), KeyOf(editedScope, "Alpha"));
        Assert.NotEqual(KeyOf(globalScope, "Beta"), KeyOf(editedScope, "Beta"));
    }

    /// <summary>
    /// Soundness gate: a body cached against one <see cref="BoundGlobalScope"/>
    /// instance is NEVER reused for a different scope instance (which would
    /// reference stale, freshly-allocated symbols). This is what keeps Phase 1
    /// correct — and is why reuse is a near-no-op until Phase 2 gives symbols
    /// stable cross-compilation identity.
    /// </summary>
    [Fact]
    public void SoundnessGate_Blocks_Reuse_Across_Different_Scope_Instances()
    {
        const string source = """
            package P
            func F() int {
                return 42
            }
            """;

        var scope1 = BindGlobalScope(source);
        var scope2 = BindGlobalScope(source); // identical text, fresh symbols

        var cache = new BoundBodyCache();
        var program1 = Binder.BindProgram(scope1, references: null, cache); // populate against scope1

        var hitsBefore = cache.Hits;
        var program2 = Binder.BindProgram(scope2, references: null, cache); // must NOT reuse scope1's bodies
        var hitsAfter = cache.Hits;

        Assert.Equal(hitsBefore, hitsAfter);

        var f1 = scope1.Functions.Single(f => f.Name == "F");
        var f2 = scope2.Functions.Single(f => f.Name == "F");

        // Different scope → freshly bound body (different object), even though
        // the printed form is identical text.
        Assert.NotSame(program1.Functions[f1], program2.Functions[f2]);
        Assert.Equal(Print(program1.Functions[f1]), Print(program2.Functions[f2]));
    }

    /// <summary>
    /// The optional cache parameter never changes <see cref="BindProgram"/>'s
    /// output for a wide member surface (functions, instance/static methods,
    /// computed properties): bodies and diagnostics are byte-identical to the
    /// full-rebuild path.
    /// </summary>
    [Fact]
    public void CachePath_Matches_FullRebuild_For_Mixed_Members()
    {
        var source = """
            package P
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
            }
            """;
        var globalScope = BindGlobalScope(source);

        var noCache = Binder.BindProgram(globalScope, references: null);
        var withCache = Binder.BindProgram(globalScope, references: null, new BoundBodyCache());

        Assert.Equal(Print(noCache.Diagnostics), Print(withCache.Diagnostics));

        foreach (var function in noCache.Functions.Keys)
        {
            Assert.Equal(Print(noCache.Functions[function]), Print(withCache.Functions[function]));
        }
    }

    /// <summary>
    /// Emit is bit-for-bit identical whether the bound program came from a
    /// cache hit or a from-scratch bind. A sound cache hit reuses the same
    /// lowered bodies, and emit is a pure function of the bound program, so the
    /// emitted PE must be byte-identical — the load-bearing determinism
    /// guarantee from ADR-0105.
    /// </summary>
    [Fact]
    public void Emit_Is_ByteIdentical_For_CacheHit_Vs_FromScratch()
    {
        var source = """
            package P
            func Add(a int, b int) int {
                var s = a + b
                return s
            }
            func Choose(n int) int {
                if n > 0 {
                    return n
                }
                return 0 - n
            }
            """;
        var globalScope = BindGlobalScope(source);

        var fromScratch = Binder.BindProgram(globalScope, references: null);

        var cache = new BoundBodyCache();
        Binder.BindProgram(globalScope, references: null, cache); // populate
        var fromCache = Binder.BindProgram(globalScope, references: null, cache); // hit
        Assert.True(cache.Hits > 0);

        var fromScratchPe = EmitToBytes(fromScratch);
        var fromCachePe = EmitToBytes(fromCache);

        Assert.Equal(fromScratchPe, fromCachePe);
    }

    private static byte[] EmitToBytes(BoundProgram program)
    {
        using var stream = new MemoryStream();
        GSharp.Core.CodeAnalysis.Emit.ReflectionMetadataEmitter.Emit(program, stream, references: null, assemblyName: "CacheDeterminism");
        return stream.ToArray();
    }

    private static BoundGlobalScope BindGlobalScope(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }

    private static BoundBodyCacheKey KeyOfFirstFunction(string source)
    {
        var globalScope = BindGlobalScope(source);
        var function = globalScope.Functions.First(f => f.Declaration != null);
        Assert.True(BoundBodyCache.TryCreateKey(function, function.Declaration.Body, out var key));
        return key;
    }

    private static BoundBodyCacheKey KeyOf(BoundGlobalScope globalScope, string functionName)
    {
        var function = globalScope.Functions.Single(f => f.Name == functionName);
        Assert.True(BoundBodyCache.TryCreateKey(function, function.Declaration.Body, out var key));
        return key;
    }

    private static string Print(BoundNode node)
    {
        var writer = new StringWriter();
        node.WriteTo(writer);
        return writer.ToString();
    }

    private static string Print(ImmutableArray<Diagnostic> diagnostics) =>
        string.Join("\n", diagnostics.Select(d => $"{d.Id}:{d.Severity}:{d.Message}"));
}
