// <copyright file="IncrementalGlobalScopeReuseTests.cs" company="GSharp">
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

/// ADR-0105 (Phase 2) — tests for (cref:IncrementalGlobalScopeReuse) and
/// the dirty-tree-aware (cref:Binder.BindProgram(BoundGlobalScope, ReferenceResolver, BoundBodyCache,
/// ImmutableHashSet{SyntaxTree}))
/// path: a single-file, body-only edit reuses the previous global scope (and
/// therefore every symbol instance), re-binds only the edited file's bodies,
/// and serves every other file's bodies from the (cref:BoundBodyCache)
/// — while remaining bit-for-bit identical to a full rebuild.
open class IncrementalGlobalScopeReuseTests {
    @Fact
    func NativeProtocolBodiesRebuildSynthesisWithSharedBodyCache() {
        let tree = Parse("Native.gs", `protocol P {}
struct Value {}
func Make() P -> Value{}
`)
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        let cache = BoundBodyCache()
        Binder.BindProgram(scope_, references: nil, cache)
        let program = Binder.BindProgram(scope_, references: nil, cache)
        Assert.Contains(program.Structs, (type StructSymbol) -> type.Name.StartsWith("<>ProtocolEntry"))
        Assert.DoesNotContain(
            program.Diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
        )
    }

    @Fact
    func NativeProtocolBodyEditsRequireFreshGlobalCoverage() {
        let original = Parse("Native.gs", `protocol P {}
struct Reader {}
struct Other {}
func Make() P -> Reader{}
`)
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(original))
        let edited = Parse("Native.gs", original.Text.ToString().Replace("-> Reader{}", "-> Other{}"))
        Assert.False(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, original, edited))
    }

    @Theory
    @InlineData("StringBuilder", "MemoryStream")
    @InlineData("api.StringBuilder", "api.MemoryStream")
    func BodyOnlyEdit_PreservesPerFileImportsAndAliases(textType string, streamType string) {
        var fileA = Parse("A.gs", `package P
import System.Text
import api = System.Text
func A() int32 {
    let value = %TYPE%()
    return value.Length
}`.Replace("%TYPE%", textType))
        var fileB = Parse("B.gs", `package P
import System.IO
import api = System.IO
func B() int32 {
    let value = %TYPE%()
    return value.Capacity
}`.Replace("%TYPE%", streamType))
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(fileA, fileB))
        let cache = BoundBodyCache()
        var program = Binder.BindProgram(scope_, references: nil, cache)
        AssertImportedLocals(program)
        for fileName in[]string{"A.gs", "B.gs", "A.gs"} {
            let previous = if fileName == "A.gs" {
                fileA
            } else {
                fileB
            }
            let edited = Parse(fileName, previous.Text.ToString().Replace("    return", "\n    return"))
            let unchanged = if fileName == "A.gs" {
                fileB
            } else {
                fileA
            }
            let unchangedFunction = scope_.Functions.Single(
                (f FunctionSymbol) -> f.Name == if fileName == "A.gs" {
                    "B"
                } else {
                    "A"
                }
            )
            let unchangedBody = program.Functions[unchangedFunction]
            Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, previous, edited))
            program = Binder.BindProgram(scope_, references: nil, cache, ImmutableHashSet.Create(edited))
            AssertImportedLocals(program)
            Assert.Same(unchangedBody, program.Functions[unchangedFunction])
            Assert.Equal(2, scope_.Imports.Count((i ImportSymbol) -> i.Declaration?.SyntaxTree == edited))
            Assert.Equal(2, scope_.Imports.Count((i ImportSymbol) -> i.Declaration?.SyntaxTree == unchanged))
            let fullScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(edited, unchanged))
            let full = Binder.BindProgram(fullScope, references: nil)
            AssertImportedLocals(full)
            for function in program.Functions.Keys {
                let fullFunction = full.Functions.Keys.Single((f FunctionSymbol) -> f.Name == function.Name)
                Assert.Equal(Print(full.Functions[fullFunction]), Print(program.Functions[function]))
            }
            if fileName == "A.gs" {
                fileA = edited
            } else {
                fileB = edited
            }
        }
    }

    @Fact
    func BodyOnlyEdit_RepointsFieldLocation() {
        let original = Parse("A.gs", `package P
class Cache {
    var count int32
    func Resize() {
        var size = 1
    }
    shared {
        var entries int32
    }
}`)
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(original))
        let instanceField = scope_.Structs.Single().Fields.Single()
        let staticField = scope_.Structs.Single().StaticFields.Single()
        let edited = Parse("A.gs", `package P
class Cache {
    var count int32
    func Resize() {
        var size = 100000
    }
    shared {
        var entries int32
    }
}`)
        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, original, edited))
        Assert.Same(edited.Text, instanceField.Location.Text)
        Assert.Equal("count", instanceField.Location.Text!!.ToString(instanceField.Location.Span))
        Assert.Same(edited.Text, staticField.Location.Text)
        Assert.Equal("entries", staticField.Location.Text!!.ToString(staticField.Location.Span))
    }

    /// Issue #5324: a body-only edit that shifts text must re-point enum and delegate declarations
    /// at the edited tree, including constructed delegate references and nested enums.
    @Fact
    func BodyOnlyEdit_RepointsEnumAndDelegateDeclarations() {
        const template = `package P
func Run() int32 {
    %BODY%
}
enum Color { Red, Green }
delegate Handler[T](value T) T;
class Holder[T] {
    enum Mode { On, Off }
}`
        let original = Parse("A.gs", template.Replace("%BODY%", "return 1"))
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(original))
        let edited = Parse("A.gs", template.Replace("%BODY%", "let shifted = 10\n    return shifted"))
        let constructed = DelegateTypeSymbol.Construct(
            scope_.Delegates.Single(),
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32)
        )
        let nested = scope_.Enums.Single((e EnumSymbol) -> e.Name == "Mode")
        let constructedEnum = EnumSymbol.ConstructNested(nested, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        Assert.NotSame(nested, constructedEnum)
        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, original, edited))
        Assert.Equal(2, scope_.Enums.Length)
        for enumSymbol in scope_.Enums {
            Assert.Same(edited, enumSymbol.Declaration.SyntaxTree)
        }
        Assert.Same(edited, scope_.Delegates.Single().Declaration.SyntaxTree)
        Assert.Same(edited, constructed.Declaration.SyntaxTree)
        Assert.Same(edited, constructedEnum.Declaration.SyntaxTree)
    }

    /// ADR-0195 / issue #4674: a `shared class` is bound from a normalized copy of its
    /// parsed declaration, so a body-only edit in a file that holds one must still be
    /// repointed (not fall back to a full bind), including for a shared class nested in an
    /// ordinary one, and the repointed symbols must see the edited tree.
    @Fact
    func BodyOnlyEdit_InFileWithSharedClass_IsRepointed() {
        const template = `package P
shared class Util {
    var entries int32
    func Twice(x int32) int32 {
        return x * %N%
    }
}
class Outer {
    var count int32
    shared class Inner {
        func Make() int32 {
            return %N%
        }
    }
}`
        let original = Parse("A.gs", template.Replace("%N%", "2"))
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(original))
        let util = scope_.Structs.Single((s StructSymbol) -> s.Name == "Util")
        let entries = util.StaticFields.Single()
        let edited = Parse("A.gs", template.Replace("%N%", "3000"))
        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, original, edited))
        Assert.Same(edited.Text, entries.Location.Text)
        Assert.Equal("entries", entries.Location.Text!!.ToString(entries.Location.Span))
        Assert.Same(edited, util.Declaration!!.SyntaxTree)
        Assert.NotEmpty(util.Declaration!!.SharedBlock!!.Methods)
    }

    /// A body-only edit to one file in a multi-file project reuses the cached
    /// bodies of every unchanged file (cache hits, same symbol identity) and
    /// re-binds only the edited file's body.
    @Fact
    func BodyOnlyEdit_ReusesUnchangedBodies_AndRebindsOnlyEditedFile() {
        let fileA = Parse("A.gs", `package P
func A() int {
    return 1
}`)
        let fileB = Parse("B.gs", `package P
func B() int {
    return 2
}`)
        let fileC = Parse("C.gs", `package P
func C() int {
    return 3
}`)
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(fileA, fileB, fileC))
        let cache = BoundBodyCache()
        // Populate the cache from the initial full bind.
        Binder.BindProgram(scope_, references: nil, cache)
        let hitsBefore = cache.Hits
        let storesBefore = cache.Stores
        // Body-only edit to A.gs (signature identical, only the literal changes).
        let editedA = Parse("A.gs", `package P
func A() int {
    return 100
}`)
        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, fileA, editedA))
        let dirty = ImmutableHashSet.Create(editedA)
        let program = Binder.BindProgram(scope_, references: nil, cache, dirty)
        // Exactly the two unchanged files (B, C) hit the cache; A's single body
        // was forced to re-bind (dirty) and re-stored.
        Assert.Equal(hitsBefore + int64(2), cache.Hits)
        Assert.Equal(storesBefore + int64(1), cache.Stores)
        // The re-bound A body reflects the new source text.
        let a = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "A")
        Assert.Contains("100", Print(program.Functions[a]))
    }

    /// ADR-0144: a file containing a `partial` type is never eligible for
    /// the body-only fast path, even for an otherwise body-only edit — the
    /// type's symbol is bound from a synthetic merged declaration spanning every
    /// part, which a single-file positional re-point cannot reproduce. The edit
    /// must fall back to a full rebuild ((cref:IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit)
    /// returns `false`).
    @Fact
    func PartialType_BodyOnlyEdit_FallsBackToFullRebuild() {
        let fileA = Parse("A.gs", `package P
partial class Widget {
    func Value() int {
        return 1
    }
}`)
        let fileB = Parse("B.gs", `package P
partial class Widget {
    func Other() int {
        return 2
    }
}`)
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(fileA, fileB))
        // Body-only edit to A.gs: only the returned literal changes.
        let editedA = Parse("A.gs", `package P
partial class Widget {
    func Value() int {
        return 100
    }
}`)
        Assert.False(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, fileA, editedA))
    }

    /// The fast path is bit-for-bit identical to a full rebuild on the edited
    /// trees: same emitted IL and same diagnostics. This is the load-bearing
    /// determinism guarantee — the cache/reuse must never change output. The
    /// scenario includes a cross-file call (B calls A) so the reused body in B
    /// keeps referring to the re-pointed symbol in A.
    @Fact
    func FastPath_Emit_And_Diagnostics_Are_ByteIdentical_To_FullRebuild() {
        let fileA = Parse("A.gs", `package P
func Helper(x int) int {
    return x * 2
}`)
        let fileB = Parse("B.gs", `package P
func UseHelper(y int) int {
    return Helper(y) + 1
}`)
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(fileA, fileB))
        let cache = BoundBodyCache()
        Binder.BindProgram(scope_, references: nil, cache) // populate
        let editedA = Parse("A.gs", `package P
func Helper(x int) int {
    return x * 2 + 7
}`)
        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, fileA, editedA))
        let fast = Binder.BindProgram(scope_, references: nil, cache, ImmutableHashSet.Create(editedA))
        // Full rebuild over the post-edit trees, no reuse, no cache.
        let fullScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(editedA, fileB))
        let full = Binder.BindProgram(fullScope, references: nil)
        Assert.Equal(EmitToBytes(full), EmitToBytes(fast))
        Assert.Equal(Print(full.Diagnostics), Print(fast.Diagnostics))
    }

    /// Cross-file <em>type</em> dependency: file B constructs and uses a struct
    /// declared in file A. A body-only edit to a method in A must not corrupt
    /// B's reused body — both must match a full rebuild exactly.
    @Fact
    func CrossFileTypeDependency_BodyEdit_DoesNotCorruptDependent() {
        let fileA = Parse("A.gs", `package P
struct Point {
    var X int
    var Y int

    func Area() int {
        return X * Y
    }
}`)
        let fileB = Parse("B.gs", `package P
func MakeArea() int {
    var p = Point{X: 3, Y: 4}
    return p.Area()
}`)
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(fileA, fileB))
        let cache = BoundBodyCache()
        Binder.BindProgram(scope_, references: nil, cache) // populate
        let editedA = Parse("A.gs", `package P
struct Point {
    var X int
    var Y int

    func Area() int {
        return X * Y + 0
    }
}`)
        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, fileA, editedA))
        let fast = Binder.BindProgram(scope_, references: nil, cache, ImmutableHashSet.Create(editedA))
        let fullScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(editedA, fileB))
        let full = Binder.BindProgram(fullScope, references: nil)
        Assert.Equal(Print(full.Diagnostics), Print(fast.Diagnostics))
        // Pair functions by name across the two scopes and compare their bound
        // bodies byte-for-byte (covers both the edited method and the reused
        // dependent in B). Names are unique in this program.
        for fastFn in fast.Functions.Keys {
            let fullFn = full.Functions.Keys.Single((f FunctionSymbol) -> f.Name == fastFn.Name)
            Assert.Equal(Print(full.Functions[fullFn]), Print(fast.Functions[fastFn]))
        }
    }

    /// A signature edit (changing a parameter type) is NOT a body-only edit, so
    /// reuse is refused — the caller must full-rebuild, which correctly re-binds
    /// dependents against the new signature.
    @Fact
    func SignatureEdit_IsRejected_ByReuse() {
        let fileA = Parse("A.gs", `package P
func Helper(x int) int {
    return x * 2
}`)
        let fileB = Parse("B.gs", `package P
func UseHelper(y int) int {
    return Helper(y) + 1
}`)
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(fileA, fileB))
        // Parameter type changed int -> int32: a signature edit, not body-only.
        let editedA = Parse("A.gs", `package P
func Helper(x int32) int {
    return x * 2
}`)
        Assert.False(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, fileA, editedA))
    }

    /// Adding a new declaration to a file is rejected (the skeleton differs), so
    /// reuse falls back to a full rebuild.
    @Fact
    func AddedDeclaration_IsRejected_ByReuse() {
        let fileA = Parse("A.gs", `package P
func A() int {
    return 1
}`)
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(fileA))
        let editedA = Parse("A.gs", `package P
func A() int {
    return 1
}
func Added() int {
    return 2
}`)
        Assert.False(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, fileA, editedA))
    }

    /// ADR-0105 Phase 2 (broadened member surface) — a body-only edit to a
    /// method in a file that <em>also</em> contains a constructor now takes the
    /// fast path: the reused constructor and method symbols are re-pointed at
    /// the new syntax and the result is bit-for-bit identical to a full rebuild.
    /// This is the headline repro fix (test files with `init()`).
    @Fact
    func Constructor_File_BodyEdit_TakesFastPath_AndIsByteIdentical() {
        let fileA = Parse("A.gs", `package P
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
}`)
        let fileB = Parse("B.gs", `package P
func MakeArea() int32 {
    var r = Rect(3, 4)
    return r.Area()
}`)
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(fileA, fileB))
        let cache = BoundBodyCache()
        Binder.BindProgram(scope_, references: nil, cache) // populate
        let hitsBefore = cache.Hits
        // Edit a method body, leaving the constructor's signature (and the whole
        // skeleton) byte-identical.
        let editedA = Parse("A.gs", `package P
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
}`)
        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, fileA, editedA))
        let fast = Binder.BindProgram(scope_, references: nil, cache, ImmutableHashSet.Create(editedA))
        // B's body is served from the cache (unchanged); A's bodies were forced
        // to re-bind (dirty).
        Assert.True(cache.Hits > hitsBefore)
        let fullScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(editedA, fileB))
        let full = Binder.BindProgram(fullScope, references: nil)
        Assert.Equal(EmitToBytes(full), EmitToBytes(fast))
        Assert.Equal(Print(full.Diagnostics), Print(fast.Diagnostics))
    }

    /// A body-only edit also takes the fast path when the file additionally
    /// declares a constructor whose <em>own</em> body is the thing being edited.
    @Fact
    func Constructor_BodyEdit_RebindsConstructorBody() {
        let fileA = Parse("A.gs", `package P
class Box {
    var V int32
    init(v int32) {
        V = v
    }
}`)
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(fileA))
        let cache = BoundBodyCache()
        Binder.BindProgram(scope_, references: nil, cache)
        let editedA = Parse("A.gs", `package P
class Box {
    var V int32
    init(v int32) {
        V = v + 1
    }
}`)
        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, fileA, editedA))
        let fast = Binder.BindProgram(scope_, references: nil, cache, ImmutableHashSet.Create(editedA))
        let fullScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(editedA))
        let full = Binder.BindProgram(fullScope, references: nil)
        // The constructor body re-bound to the new text and matches a full
        // rebuild byte-for-byte.
        for fastFn in fast.Functions.Keys {
            let fullFn = full
                .Functions
                .Keys
                .Single((f FunctionSymbol) -> f.Name == fastFn.Name && f.Parameters.Length == fastFn.Parameters.Length)
            Assert.Equal(Print(full.Functions[fullFn]), Print(fast.Functions[fastFn]))
        }
        Assert.Equal(EmitToBytes(full), EmitToBytes(fast))
    }

    /// A body-only edit to a method in a file that also declares a computed
    /// property takes the fast path; the property's accessor body is re-pointed
    /// at the new tree and the program is byte-identical to a full rebuild.
    @Fact
    func ComputedProperty_File_BodyEdit_TakesFastPath_AndIsByteIdentical() {
        let fileA = Parse("A.gs", `package P
class Counter {
    var n int32
    prop Doubled int32 {
        get { return n * 2 }
    }
    func Bump() int32 {
        return n + 1
    }
}`)
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(fileA))
        let cache = BoundBodyCache()
        Binder.BindProgram(scope_, references: nil, cache)
        // Edit the getter accessor body itself.
        let editedA = Parse("A.gs", `package P
class Counter {
    var n int32
    prop Doubled int32 {
        get { return n * 3 }
    }
    func Bump() int32 {
        return n + 1
    }
}`)
        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, fileA, editedA))
        let fast = Binder.BindProgram(scope_, references: nil, cache, ImmutableHashSet.Create(editedA))
        let fullScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(editedA))
        let full = Binder.BindProgram(fullScope, references: nil)
        Assert.Equal(EmitToBytes(full), EmitToBytes(fast))
        Assert.Equal(Print(full.Diagnostics), Print(fast.Diagnostics))
        // The re-pointed getter body reflects the edit.
        let getter = fast.Functions.Keys.Single((f FunctionSymbol) -> f.Name == "get_Doubled")
        Assert.Contains("3", Print(fast.Functions[getter]))
    }

    /// A body-only edit to an explicit-event accessor (add/remove/raise) takes
    /// the fast path and is byte-identical to a full rebuild.
    @Fact
    func ExplicitEvent_File_BodyEdit_TakesFastPath_AndIsByteIdentical() {
        let fileA = Parse("A.gs", `package P
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
}`)
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(fileA))
        let cache = BoundBodyCache()
        Binder.BindProgram(scope_, references: nil, cache)
        let editedA = Parse("A.gs", `package P
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
}`)
        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, fileA, editedA))
        let fast = Binder.BindProgram(scope_, references: nil, cache, ImmutableHashSet.Create(editedA))
        let fullScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(editedA))
        let full = Binder.BindProgram(fullScope, references: nil)
        Assert.Equal(EmitToBytes(full), EmitToBytes(fast))
        Assert.Equal(Print(full.Diagnostics), Print(fast.Diagnostics))
    }

    /// A body-only edit to a default-interface-method body takes the fast path
    /// and is byte-identical to a full rebuild.
    @Fact
    func InterfaceDefaultMethod_BodyEdit_TakesFastPath_AndIsByteIdentical() {
        let fileA = Parse("A.gs", `package P
interface IGreeter {
    shared {
        var Calls int32
    }
    func Hello() string {
        return "hi"
    }
}`)
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(fileA))
        let field = scope_.Interfaces.Single().StaticFields.Single()
        let cache = BoundBodyCache()
        Binder.BindProgram(scope_, references: nil, cache)
        let editedA = Parse("A.gs", `package P
interface IGreeter {
    shared {
        var Calls int32
    }
    func Hello() string {
        return "hello"
    }
}`)
        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, fileA, editedA))
        Assert.Same(editedA.Text, field.Location.Text)
        Assert.Equal("Calls", field.Location.Text!!.ToString(field.Location.Span))
        let fast = Binder.BindProgram(scope_, references: nil, cache, ImmutableHashSet.Create(editedA))
        let fullScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(editedA))
        let full = Binder.BindProgram(fullScope, references: nil)
        Assert.Equal(EmitToBytes(full), EmitToBytes(fast))
        Assert.Equal(Print(full.Diagnostics), Print(fast.Diagnostics))
        let hello = fast.Functions.Keys.Single((f FunctionSymbol) -> f.Name == "Hello")
        Assert.Contains("hello", Print(fast.Functions[hello]))
    }

    /// A constructor <em>signature</em> edit (changing a ctor parameter type) is
    /// not a body-only edit, so reuse is refused and the caller full-rebuilds.
    @Fact
    func ConstructorSignatureEdit_IsRejected_ByReuse() {
        let fileA = Parse("A.gs", `package P
class Box {
    var V int32
    init(v int32) {
        V = v
    }
}`)
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(fileA))
        // Constructor parameter type changed int32 -> int64: a signature edit.
        let editedA = Parse("A.gs", `package P
class Box {
    var V int32
    init(v int64) {
        V = v
    }
}`)
        Assert.False(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, fileA, editedA))
    }

    /// A computed-property <em>signature</em> edit (changing the property type)
    /// makes the skeleton differ, so reuse is refused.
    @Fact
    func ComputedPropertySignatureEdit_IsRejected_ByReuse() {
        let fileA = Parse("A.gs", `package P
class Counter {
    var n int32
    prop Doubled int32 {
        get { return n }
    }
}`)
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(fileA))
        let editedA = Parse("A.gs", `package P
class Counter {
    var n int32
    prop Doubled int64 {
        get { return n }
    }
}`)
        Assert.False(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, fileA, editedA))
    }

    /// Top-level statements remain an outright bail: the synthesized
    /// `<Main>$` body is bound from the global scope's statements, not
    /// a member-declaration node, so it is not re-pointable.
    @Fact
    func TopLevelStatements_File_IsRejected_ByReuse() {
        let fileA = Parse("A.gs", `package P
func Helper() int32 {
    return 1
}
var x = Helper()`)
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(fileA))
        let editedA = Parse("A.gs", `package P
func Helper() int32 {
    return 2
}
var x = Helper()`)
        Assert.False(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, fileA, editedA))
    }

    shared {
        private func AssertImportedLocals(program BoundProgram) {
            Assert.Empty(program.Diagnostics)
            for name in[]string{"A", "B"} {
                let function = program.Functions.Keys.Single((f FunctionSymbol) -> f.Name == name)
                let local = Assert.Single(program.Functions[function].Statements.OfType[BoundVariableDeclaration]())
                Assert.Equal(
                    if name == "A" {
                        typeof(System.Text.StringBuilder)
                    } else {
                        typeof(MemoryStream)
                    },
                    local.Variable.Type.ClrType
                )
            }
        }

        private func Parse(fileName string, source string) SyntaxTree -> SyntaxTree.Parse(
            SourceText.From(source, fileName)
        )

        private func EmitToBytes(program BoundProgram)[]uint8 {
            using let stream = MemoryStream()
            ReflectionMetadataEmitter.Emit(program, stream, references: nil, assemblyName: "Phase2Determinism")
            return stream.ToArray()
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
