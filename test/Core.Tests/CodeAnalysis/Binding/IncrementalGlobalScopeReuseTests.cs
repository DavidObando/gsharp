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
    /// ADR-0144: a file containing a <c>partial</c> type is never eligible for
    /// the body-only fast path, even for an otherwise body-only edit — the
    /// type's symbol is bound from a synthetic merged declaration spanning every
    /// part, which a single-file positional re-point cannot reproduce. The edit
    /// must fall back to a full rebuild (<see cref="IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit"/>
    /// returns <see langword="false"/>).
    /// </summary>
    [Fact]
    public void PartialType_BodyOnlyEdit_FallsBackToFullRebuild()
    {
        var fileA = Parse("A.gs", """
            package P
            partial class Widget {
                func Value() int {
                    return 1
                }
            }
            """);
        var fileB = Parse("B.gs", """
            package P
            partial class Widget {
                func Other() int {
                    return 2
                }
            }
            """);

        var scope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(fileA, fileB));

        // Body-only edit to A.gs: only the returned literal changes.
        var editedA = Parse("A.gs", """
            package P
            partial class Widget {
                func Value() int {
                    return 100
                }
            }
            """);

        Assert.False(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope, fileA, editedA));
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
    /// ADR-0105 Phase 2 (broadened member surface) — a body-only edit to a
    /// method in a file that <em>also</em> contains a constructor now takes the
    /// fast path: the reused constructor and method symbols are re-pointed at
    /// the new syntax and the result is bit-for-bit identical to a full rebuild.
    /// This is the headline repro fix (test files with <c>init()</c>).
    /// </summary>
    [Fact]
    public void Constructor_File_BodyEdit_TakesFastPath_AndIsByteIdentical()
    {
        var fileA = Parse("A.gs", """
            package P
            class Rect {
                var Width int32
                var Height int32
                init(w int32, h int32) {
                    Width = w
                    Height = h
                }
                func Area() int32 {
                    return Width * Height
                }
            }
            """);
        var fileB = Parse("B.gs", """
            package P
            func MakeArea() int32 {
                var r = Rect(3, 4)
                return r.Area()
            }
            """);

        var scope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(fileA, fileB));
        var cache = new BoundBodyCache();
        Binder.BindProgram(scope, references: null, cache); // populate
        var hitsBefore = cache.Hits;

        // Edit a method body, leaving the constructor's signature (and the whole
        // skeleton) byte-identical.
        var editedA = Parse("A.gs", """
            package P
            class Rect {
                var Width int32
                var Height int32
                init(w int32, h int32) {
                    Width = w
                    Height = h
                }
                func Area() int32 {
                    return Width * Height + 0
                }
            }
            """);

        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope, fileA, editedA));
        var fast = Binder.BindProgram(scope, references: null, cache, ImmutableHashSet.Create(editedA));

        // B's body is served from the cache (unchanged); A's bodies were forced
        // to re-bind (dirty).
        Assert.True(cache.Hits > hitsBefore);

        var fullScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(editedA, fileB));
        var full = Binder.BindProgram(fullScope, references: null);

        Assert.Equal(EmitToBytes(full), EmitToBytes(fast));
        Assert.Equal(Print(full.Diagnostics), Print(fast.Diagnostics));
    }

    /// <summary>
    /// A body-only edit also takes the fast path when the file additionally
    /// declares a constructor whose <em>own</em> body is the thing being edited.
    /// </summary>
    [Fact]
    public void Constructor_BodyEdit_RebindsConstructorBody()
    {
        var fileA = Parse("A.gs", """
            package P
            class Box {
                var V int32
                init(v int32) {
                    V = v
                }
            }
            """);
        var scope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(fileA));
        var cache = new BoundBodyCache();
        Binder.BindProgram(scope, references: null, cache);

        var editedA = Parse("A.gs", """
            package P
            class Box {
                var V int32
                init(v int32) {
                    V = v + 1
                }
            }
            """);

        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope, fileA, editedA));
        var fast = Binder.BindProgram(scope, references: null, cache, ImmutableHashSet.Create(editedA));

        var fullScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(editedA));
        var full = Binder.BindProgram(fullScope, references: null);

        // The constructor body re-bound to the new text and matches a full
        // rebuild byte-for-byte.
        foreach (var fastFn in fast.Functions.Keys)
        {
            var fullFn = full.Functions.Keys.Single(f => f.Name == fastFn.Name && f.Parameters.Length == fastFn.Parameters.Length);
            Assert.Equal(Print(full.Functions[fullFn]), Print(fast.Functions[fastFn]));
        }

        Assert.Equal(EmitToBytes(full), EmitToBytes(fast));
    }

    /// <summary>
    /// A body-only edit to a method in a file that also declares a computed
    /// property takes the fast path; the property's accessor body is re-pointed
    /// at the new tree and the program is byte-identical to a full rebuild.
    /// </summary>
    [Fact]
    public void ComputedProperty_File_BodyEdit_TakesFastPath_AndIsByteIdentical()
    {
        var fileA = Parse("A.gs", """
            package P
            class Counter {
                var n int32
                prop Doubled int32 {
                    get { return n * 2 }
                }
                func Bump() int32 {
                    return n + 1
                }
            }
            """);
        var scope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(fileA));
        var cache = new BoundBodyCache();
        Binder.BindProgram(scope, references: null, cache);

        // Edit the getter accessor body itself.
        var editedA = Parse("A.gs", """
            package P
            class Counter {
                var n int32
                prop Doubled int32 {
                    get { return n * 3 }
                }
                func Bump() int32 {
                    return n + 1
                }
            }
            """);

        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope, fileA, editedA));
        var fast = Binder.BindProgram(scope, references: null, cache, ImmutableHashSet.Create(editedA));

        var fullScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(editedA));
        var full = Binder.BindProgram(fullScope, references: null);

        Assert.Equal(EmitToBytes(full), EmitToBytes(fast));
        Assert.Equal(Print(full.Diagnostics), Print(fast.Diagnostics));

        // The re-pointed getter body reflects the edit.
        var getter = fast.Functions.Keys.Single(f => f.Name == "get_Doubled");
        Assert.Contains("3", Print(fast.Functions[getter]));
    }

    /// <summary>
    /// A body-only edit to an explicit-event accessor (add/remove/raise) takes
    /// the fast path and is byte-identical to a full rebuild.
    /// </summary>
    [Fact]
    public void ExplicitEvent_File_BodyEdit_TakesFastPath_AndIsByteIdentical()
    {
        var fileA = Parse("A.gs", """
            package P
            class Notifier {
                var c int32
                public event Changed func() {
                    add { }
                    remove { }
                    raise { }
                }
                func Ping() int32 {
                    return c + 1
                }
            }
            """);
        var scope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(fileA));
        var cache = new BoundBodyCache();
        Binder.BindProgram(scope, references: null, cache);

        var editedA = Parse("A.gs", """
            package P
            class Notifier {
                var c int32
                public event Changed func() {
                    add { }
                    remove { }
                    raise { }
                }
                func Ping() int32 {
                    return c + 2
                }
            }
            """);

        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope, fileA, editedA));
        var fast = Binder.BindProgram(scope, references: null, cache, ImmutableHashSet.Create(editedA));

        var fullScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(editedA));
        var full = Binder.BindProgram(fullScope, references: null);

        Assert.Equal(EmitToBytes(full), EmitToBytes(fast));
        Assert.Equal(Print(full.Diagnostics), Print(fast.Diagnostics));
    }

    /// <summary>
    /// A body-only edit to a default-interface-method body takes the fast path
    /// and is byte-identical to a full rebuild.
    /// </summary>
    [Fact]
    public void InterfaceDefaultMethod_BodyEdit_TakesFastPath_AndIsByteIdentical()
    {
        var fileA = Parse("A.gs", """
            package P
            interface IGreeter {
                func Hello() string {
                    return "hi"
                }
            }
            """);
        var scope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(fileA));
        var cache = new BoundBodyCache();
        Binder.BindProgram(scope, references: null, cache);

        var editedA = Parse("A.gs", """
            package P
            interface IGreeter {
                func Hello() string {
                    return "hello"
                }
            }
            """);

        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope, fileA, editedA));
        var fast = Binder.BindProgram(scope, references: null, cache, ImmutableHashSet.Create(editedA));

        var fullScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(editedA));
        var full = Binder.BindProgram(fullScope, references: null);

        Assert.Equal(EmitToBytes(full), EmitToBytes(fast));
        Assert.Equal(Print(full.Diagnostics), Print(fast.Diagnostics));

        var hello = fast.Functions.Keys.Single(f => f.Name == "Hello");
        Assert.Contains("hello", Print(fast.Functions[hello]));
    }

    /// <summary>
    /// A constructor <em>signature</em> edit (changing a ctor parameter type) is
    /// not a body-only edit, so reuse is refused and the caller full-rebuilds.
    /// </summary>
    [Fact]
    public void ConstructorSignatureEdit_IsRejected_ByReuse()
    {
        var fileA = Parse("A.gs", """
            package P
            class Box {
                var V int32
                init(v int32) {
                    V = v
                }
            }
            """);
        var scope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(fileA));

        // Constructor parameter type changed int32 -> int64: a signature edit.
        var editedA = Parse("A.gs", """
            package P
            class Box {
                var V int32
                init(v int64) {
                    V = v
                }
            }
            """);

        Assert.False(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope, fileA, editedA));
    }

    /// <summary>
    /// A computed-property <em>signature</em> edit (changing the property type)
    /// makes the skeleton differ, so reuse is refused.
    /// </summary>
    [Fact]
    public void ComputedPropertySignatureEdit_IsRejected_ByReuse()
    {
        var fileA = Parse("A.gs", """
            package P
            class Counter {
                var n int32
                prop Doubled int32 {
                    get { return n }
                }
            }
            """);
        var scope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(fileA));

        var editedA = Parse("A.gs", """
            package P
            class Counter {
                var n int32
                prop Doubled int64 {
                    get { return n }
                }
            }
            """);

        Assert.False(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope, fileA, editedA));
    }

    /// <summary>
    /// Top-level statements remain an outright bail: the synthesized
    /// <c>&lt;Main&gt;$</c> body is bound from the global scope's statements, not
    /// a member-declaration node, so it is not re-pointable.
    /// </summary>
    [Fact]
    public void TopLevelStatements_File_IsRejected_ByReuse()
    {
        var fileA = Parse("A.gs", """
            package P
            func Helper() int32 {
                return 1
            }
            var x = Helper()
            """);
        var scope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(fileA));

        var editedA = Parse("A.gs", """
            package P
            func Helper() int32 {
                return 2
            }
            var x = Helper()
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
