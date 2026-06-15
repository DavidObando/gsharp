// <copyright file="IncrementalGlobalScopeReuseTests.cs" company="GSharp">
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
/// ADR-0105 (Phase 2) — tests for <see cref="IncrementalGlobalScopeReuse"/> and
/// the dirty-tree-aware <see cref="Binder.BindProgram(BoundGlobalScope, ReferenceResolver, BoundBodyCache, ImmutableHashSet{SyntaxTree})"/>
/// path: a single-file, body-only edit reuses the previous global scope (and
/// therefore every symbol instance), re-binds only the edited file's bodies,
/// and serves every other file's bodies from the <see cref="BoundBodyCache"/>
/// — while remaining bit-for-bit identical to a full rebuild.
/// </summary>
public class IncrementalGlobalScopeReuseTests
{
    /// <summary>
    /// A body-only edit to one file in a multi-file project reuses the cached
    /// bodies of every unchanged file (cache hits, same symbol identity) and
    /// re-binds only the edited file's body.
    /// </summary>
    [Fact]
    public void BodyOnlyEdit_ReusesUnchangedBodies_AndRebindsOnlyEditedFile()
    {
        var fileA = Parse("A.gs", """
            package P
            func A() int {
                return 1
            }
            """);
        var fileB = Parse("B.gs", """
            package P
            func B() int {
                return 2
            }
            """);
        var fileC = Parse("C.gs", """
            package P
            func C() int {
                return 3
            }
            """);

        var scope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(fileA, fileB, fileC));
        var cache = new BoundBodyCache();

        // Populate the cache from the initial full bind.
        Binder.BindProgram(scope, references: null, cache);
        var hitsBefore = cache.Hits;
        var storesBefore = cache.Stores;

        // Body-only edit to A.gs (signature identical, only the literal changes).
        var editedA = Parse("A.gs", """
            package P
            func A() int {
                return 100
            }
            """);

        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope, fileA, editedA));

        var dirty = ImmutableHashSet.Create(editedA);
        var program = Binder.BindProgram(scope, references: null, cache, dirty);

        // Exactly the two unchanged files (B, C) hit the cache; A's single body
        // was forced to re-bind (dirty) and re-stored.
        Assert.Equal(hitsBefore + 2, cache.Hits);
        Assert.Equal(storesBefore + 1, cache.Stores);

        // The re-bound A body reflects the new source text.
        var a = scope.Functions.Single(f => f.Name == "A");
        Assert.Contains("100", Print(program.Functions[a]));
    }

    /// <summary>
    /// The fast path is bit-for-bit identical to a full rebuild on the edited
    /// trees: same emitted IL and same diagnostics. This is the load-bearing
    /// determinism guarantee — the cache/reuse must never change output. The
    /// scenario includes a cross-file call (B calls A) so the reused body in B
    /// keeps referring to the re-pointed symbol in A.
    /// </summary>
    [Fact]
    public void FastPath_Emit_And_Diagnostics_Are_ByteIdentical_To_FullRebuild()
    {
        var fileA = Parse("A.gs", """
            package P
            func Helper(x int) int {
                return x * 2
            }
            """);
        var fileB = Parse("B.gs", """
            package P
            func UseHelper(y int) int {
                return Helper(y) + 1
            }
            """);

        var scope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(fileA, fileB));
        var cache = new BoundBodyCache();
        Binder.BindProgram(scope, references: null, cache); // populate

        var editedA = Parse("A.gs", """
            package P
            func Helper(x int) int {
                return x * 2 + 7
            }
            """);

        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope, fileA, editedA));
        var fast = Binder.BindProgram(scope, references: null, cache, ImmutableHashSet.Create(editedA));

        // Full rebuild over the post-edit trees, no reuse, no cache.
        var fullScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(editedA, fileB));
        var full = Binder.BindProgram(fullScope, references: null);

        Assert.Equal(EmitToBytes(full), EmitToBytes(fast));
        Assert.Equal(Print(full.Diagnostics), Print(fast.Diagnostics));
    }

    /// <summary>
    /// Cross-file <em>type</em> dependency: file B constructs and uses a struct
    /// declared in file A. A body-only edit to a method in A must not corrupt
    /// B's reused body — both must match a full rebuild exactly.
    /// </summary>
    [Fact]
    public void CrossFileTypeDependency_BodyEdit_DoesNotCorruptDependent()
    {
        var fileA = Parse("A.gs", """
            package P
            struct Point {
                var X int
                var Y int

                func Area() int {
                    return X * Y
                }
            }
            """);
        var fileB = Parse("B.gs", """
            package P
            func MakeArea() int {
                var p = Point{X: 3, Y: 4}
                return p.Area()
            }
            """);

        var scope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(fileA, fileB));
        var cache = new BoundBodyCache();
        Binder.BindProgram(scope, references: null, cache); // populate

        var editedA = Parse("A.gs", """
            package P
            struct Point {
                var X int
                var Y int

                func Area() int {
                    return X * Y + 0
                }
            }
            """);

        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope, fileA, editedA));
        var fast = Binder.BindProgram(scope, references: null, cache, ImmutableHashSet.Create(editedA));

        var fullScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(editedA, fileB));
        var full = Binder.BindProgram(fullScope, references: null);

        Assert.Equal(Print(full.Diagnostics), Print(fast.Diagnostics));

        // Pair functions by name across the two scopes and compare their bound
        // bodies byte-for-byte (covers both the edited method and the reused
        // dependent in B). Names are unique in this program.
        foreach (var fastFn in fast.Functions.Keys)
        {
            var fullFn = full.Functions.Keys.Single(f => f.Name == fastFn.Name);
            Assert.Equal(Print(full.Functions[fullFn]), Print(fast.Functions[fastFn]));
        }
    }

    /// <summary>
    /// A signature edit (changing a parameter type) is NOT a body-only edit, so
    /// reuse is refused — the caller must full-rebuild, which correctly re-binds
    /// dependents against the new signature.
    /// </summary>
    [Fact]
    public void SignatureEdit_IsRejected_ByReuse()
    {
        var fileA = Parse("A.gs", """
            package P
            func Helper(x int) int {
                return x * 2
            }
            """);
        var fileB = Parse("B.gs", """
            package P
            func UseHelper(y int) int {
                return Helper(y) + 1
            }
            """);

        var scope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(fileA, fileB));

        // Parameter type changed int -> int32: a signature edit, not body-only.
        var editedA = Parse("A.gs", """
            package P
            func Helper(x int32) int {
                return x * 2
            }
            """);

        Assert.False(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope, fileA, editedA));
    }

    /// <summary>
    /// Adding a new declaration to a file is rejected (the skeleton differs), so
    /// reuse falls back to a full rebuild.
    /// </summary>
    [Fact]
    public void AddedDeclaration_IsRejected_ByReuse()
    {
        var fileA = Parse("A.gs", """
            package P
            func A() int {
                return 1
            }
            """);
        var scope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(fileA));

        var editedA = Parse("A.gs", """
            package P
            func A() int {
                return 1
            }
            func Added() int {
                return 2
            }
            """);

        Assert.False(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope, fileA, editedA));
    }

    /// <summary>
    /// A file containing a computed property (an accessor body this phase does
    /// not re-point) is rejected even for a plain body edit elsewhere in it, so
    /// reuse falls back rather than risk stale accessor spans.
    /// </summary>
    [Fact]
    public void ComputedProperty_File_IsRejected_ByReuse()
    {
        var fileA = Parse("A.gs", """
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
            """);
        var scope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(fileA));

        var editedA = Parse("A.gs", """
            package P
            struct Counter {
                var value int

                func Bump() int {
                    value = value + 2
                    return value
                }

                var Doubled int {
                    get { return value * 2 }
                }
            }
            """);

        Assert.False(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope, fileA, editedA));
    }

    private static SyntaxTree Parse(string fileName, string source) =>
        SyntaxTree.Parse(SourceText.From(source, fileName));

    private static byte[] EmitToBytes(BoundProgram program)
    {
        using var stream = new MemoryStream();
        GSharp.Core.CodeAnalysis.Emit.ReflectionMetadataEmitter.Emit(program, stream, references: null, assemblyName: "Phase2Determinism");
        return stream.ToArray();
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
