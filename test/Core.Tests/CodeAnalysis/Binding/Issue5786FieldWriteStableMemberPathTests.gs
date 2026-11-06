// <copyright file="Issue5786FieldWriteStableMemberPathTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import System
import System.IO
import Xunit

/// Issue #5786, ADR-0208 R21: a write of a source `var` field stores no link of a stable member path, so it keeps
/// the facts on member paths. A constructor write of a `let` field, a write whose location can hold the storage of
/// a by-reference root (R20), the fact on a by-reference root itself (R12) and a loop (ADR-0213) still remove them.
/// The tests run the emitted program. A rejected program is checked by its diagnostic ID and line.
open class Issue5786FieldWriteStableMemberPathTests {
    private let Prefix string = `import System

class Owner {
    var A bool
    var B bool
    var N int32
}
`

    // The 1-based line of the source line that contains the marker `// READ`.
    private func MarkedLine(source string) int32 {
        let lines = source.Split('\n')
        for var i = 0; i < lines.Length; i++ {
            if lines[i].Contains("// READ", StringComparison.Ordinal) {
                return i + 1
            }
        }
        throw InvalidOperationException("The source has no // READ marker.")
    }

    private func AssertRejectedAtMarker(body string) {
        let source = Prefix + body
        let result = EmittedOracle.Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal(MarkedLine(source), diagnostic.Location.StartLine + 1)
    }

    private func Token(kind string, body string) string -> kind + ` Token {
    private let owner Owner?
    init(owner Owner) {
        this.owner = owner
    }
    func Restore() {
        if owner != nil {
` + body + `
        }
    }
}
let o = Owner()
Token(o).Restore()
o.A.ToString() + " " + o.B.ToString() + " " + o.N.ToString()
`

    /// The rows of the issue with `var` fields instead of auto properties.
    @Theory
    @InlineData("struct", "this.owner.A = true\nthis.owner.B = true", "True True 0")
    @InlineData("class", "this.owner.A = true\nthis.owner.B = true", "True True 0")
    @InlineData("struct", "this.owner.A = true\nlet x = this.owner.B\nthis.owner.B = !x", "True True 0")
    @InlineData("class", "this.owner.A = true\nlet x = this.owner.B\nthis.owner.B = !x", "True True 0")
    @InlineData("struct", "owner.A = true\nowner.B = true", "True True 0")
    @InlineData("class", "owner.A = true\nowner.B = true", "True True 0")
    @InlineData("struct", "owner.N = 1\nowner.N += 2\nowner.N++", "False False 4")
    @InlineData("class", "owner.N = 1\nowner.N += 2\nowner.N++", "False False 4")
    @InlineData("struct", "owner.N = 2\nlet t Owner = owner\nt.B = true", "False True 2")
    @InlineData("class", "owner.N = 2\nlet t Owner = owner\nt.B = true", "False True 2")
    func VarFieldWrites_KeepFact(kind string, body string, expected string) {
        let result = EmittedOracle.Evaluate(Prefix + Token(kind, body))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.ValueText)
    }

    /// A constructor write of a `let` field writes a link of the path, so it removes the fact.
    @Theory
    @InlineData("struct")
    @InlineData("class")
    func ConstructorWriteOfALetLink_RemovesFact(kind string) {
        AssertRejectedAtMarker(kind + ` Token {
    let owner Owner?
    init(first Owner, second Owner?) {
        this.owner = first
        if owner != nil {
            this.owner = second
            owner.A = true // READ
        }
    }
}
"done"
`)
    }

    /// R20: inside `Holder`, `tok.Restore(this, ...)` runs `Restore` on the field `tok`, so `this` names that
    /// field. The field write `h.tok = fresh` can replace `this.owner`.
    @Fact
    func FieldWriteOfTheRootType_RemovesFactOnStructThis() {
        AssertRejectedAtMarker(`struct Token {
    let owner Owner?
    init(owner Owner?) {
        this.owner = owner
    }
    func Restore(h Holder, fresh Token) bool {
        if owner != nil {
            h.tok = fresh
            return this.owner.A // READ
        }
        return false
    }
}
class Holder {
    var tok Token
    func Run() bool {
        return tok.Restore(this, Token(nil))
    }
}
let h = Holder{tok: Token(Owner())}
h.Run().ToString()
`)
    }

    /// R20: a field of a type that contains the root's type can hold the storage of a `ref` parameter.
    @Theory
    @InlineData("Token")
    @InlineData("Wrapper")
    @InlineData("(Token, int32)")
    func FieldWriteThatCanHoldARefParameter_RemovesFact(slotType string) {
        AssertRejectedAtMarker(`struct Token {
    let owner Owner?
    init(owner Owner?) {
        this.owner = owner
    }
}
struct Wrapper {
    var tok Token
}
class Holder {
    var slot ` + slotType + `
}
func Use(ref t Token, h Holder, fresh ` + slotType + `) bool {
    if t.owner != nil {
        h.slot = fresh
        return t.owner.A // READ
    }
    return false
}
"done"
`)
    }

    /// R12: the fact on a by-reference root itself dies on every member write, a scalar field write included.
    @Theory
    @InlineData("struct")
    @InlineData("class")
    func FactOnARefParameterRoot_StillDiesOnAScalarFieldWrite(kind string) {
        AssertRejectedAtMarker(kind + ` Token {
    let owner Owner?
    init(owner Owner?) {
        this.owner = owner
    }
    func Mutate(ref alias string?) int32 {
        if owner != nil && alias != nil {
            owner.N = 1
            return alias.Length // READ
        }
        return 0
    }
}
var s string? = "abc"
Token(Owner()).Mutate(ref s)
`)
    }

    /// ADR-0213: a loop keeps the region rule, so a field write in the loop removes the member facts.
    @Theory
    @InlineData("struct")
    @InlineData("class")
    func FieldWriteInALoop_StillRemovesFact(kind string) {
        AssertRejectedAtMarker(kind + ` Token {
    let owner Owner?
    init(owner Owner?) {
        this.owner = owner
    }
    func Run() bool {
        if owner != nil {
            for var i = 0; i < 2; i++ {
                this.owner.N = i // READ
            }
        }
        return false
    }
}
Token(Owner()).Run()
`)
    }

    /// A struct `this` and a scalar or reference field write of another object keep the fact: the location cannot
    /// hold a `Token`. A class `this` is not a by-reference root.
    @Theory
    @InlineData("struct", "h.name = \"x\"")
    @InlineData("struct", "h.next = h")
    @InlineData("struct", "h.count = 4")
    @InlineData("class", "h.tok = fresh")
    @InlineData("class", "h.pair = pair")
    func FieldWritesThatCannotHoldTheRoot_KeepFact(kind string, write string) {
        let result = EmittedOracle.Evaluate(Prefix + kind + ` Token {
    let owner Owner?
    init(owner Owner?) {
        this.owner = owner
    }
    func Restore(h Holder, fresh Token, pair Wrapper) bool {
        if owner != nil {
            ` + write + `
            this.owner.A = true
            return this.owner.A
        }
        return false
    }
}
struct Wrapper {
    var tok Token
}
class Holder {
    var name string?
    var next Holder?
    var count int32
    var tok Token
    var pair Wrapper
}
Token(Owner()).Restore(Holder{tok: Token(nil), pair: Wrapper{tok: Token(nil)}}, Token(nil), Wrapper{tok: Token(nil)}).ToString()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("True", result.ValueText)
    }

    /// #5832 review: the first access of a static field of an interface runs the initializers of its `shared`
    /// fields, which can run a stored callback that replaces a captured, guarded root. A write and a read of the
    /// field both remove the facts (ADR-0208 R11).
    @Theory
    @InlineData("IState.Count = 1\n        return b.Pet.Length // READ")
    @InlineData("let n = IState.Count\n        return b.Pet.Length + n // READ")
    func InterfaceStaticFieldAccess_RunsInitializer_RemovesFact(access string) {
        let source = `import System

class Box {
    let Pet string?
    init(pet string?) {
        this.Pet = pet
    }
}
func Fire() int32 {
    if reset != nil {
        reset()
    }
    return 0
}
interface IState {
    shared {
        var Count int32 = Fire()
    }
}
func Run() int32 {
    var b = Box("abc")
    reset = func() { b = Box(nil) }
    if b.Pet != nil {
        ` + access + `
    }
    return 0
}
var reset (() -> void)? = nil
Run()
`
        let result = EmittedOracle.Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal(MarkedLine(source), diagnostic.Location.StartLine + 1)
    }

    /// #5832 review: two fields of a type with explicit layout can share storage, so a `var` field write of such a
    /// type removes the facts on its `let` fields. A by-reference value receiver can name a field of such a type, so
    /// a write through it removes them too.
    @Theory
    @InlineData(
        "class",
        "func Run(b Box) int32 {\n    if b.Text != nil {\n        b.Other = nil\n        return b.Text.Length // READ\n    }\n    return 0\n}\nRun(Box(\"abc\"))"
    )
    @InlineData(
        "struct",
        "func Run() int32 {\n    var b = Box(\"abc\")\n    if b.Text != nil {\n        b.Other = nil\n        return b.Text.Length // READ\n    }\n    return 0\n}\nRun()"
    )
    func ExplicitLayoutFieldWrite_RemovesFact(kind string, run string) {
        let source = `import System
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Explicit)
` + kind + ` Box {
    @FieldOffset(0)
    let Text string?
    @FieldOffset(0)
    var Other string?
    init(t string?) {
        this.Text = t
        this.Other = t
    }
}
` + run + `
`
        let result = EmittedOracle.Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal(MarkedLine(source), diagnostic.Location.StartLine + 1)
    }

    @Fact
    func FieldWriteThroughARefIntoExplicitLayout_RemovesFact() {
        let source = `import System
import System.Runtime.InteropServices

struct T {
    let x string?
    init(x string?) {
        this.x = x
    }
}
struct U {
    var y string?
}
@StructLayout(LayoutKind.Explicit)
struct E {
    @FieldOffset(0)
    var a T
    @FieldOffset(0)
    var b U
}
func Run(ref t T, ref u U) int32 {
    if t.x != nil {
        u.y = nil
        return t.x.Length // READ
    }
    return 0
}
var e = E{a: T("abc")}
Run(ref e.a, ref e.b)
`
        let result = EmittedOracle.Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal(MarkedLine(source), diagnostic.Location.StartLine + 1)
    }

    /// The same shapes without explicit layout and through a value-type local keep the fact and run.
    @Theory
    @InlineData("class")
    @InlineData("struct")
    func SequentialLayoutFieldWrite_KeepsFact(kind string) {
        let result = EmittedOracle.Evaluate(`import System

` + kind + ` Box {
    let Text string?
    var Other string?
    init(t string?) {
        this.Text = t
        this.Other = t
    }
}
func Run() int32 {
    var b = Box("abc")
    if b.Text != nil {
        b.Other = nil
        return b.Text.Length
    }
    return 0
}
Run()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("3", result.ValueText)
    }

    /// #5832 review: an interface whose `shared` fields have only literal initializers, no initializer, or a
    /// `const` runs no user code at the first access, so a read of the field keeps the facts (ADR-0208 R11, #5520).
    @Theory
    @InlineData("var Count int32 = 0")
    @InlineData("var Count int32")
    @InlineData("const K int32 = 1\n        var Count int32")
    @InlineData("var Count int32 = -1\n        let Name string = \"x\"")
    func InterfaceStaticFieldRead_WithoutUserCodeInitializer_KeepsFact(fields string) {
        let result = EmittedOracle.Evaluate(`import System

class Box {
    let Pet string?
    init(pet string?) {
        this.Pet = pet
    }
}
interface IState {
    shared {
        ` + fields + `
    }
}
func Run() int32 {
    var b = Box("abc")
    let reset = func() { b = Box(nil) }
    if b.Pet != nil {
        let n = IState.Count
        return b.Pet.Length + n * 0
    }
    reset()
    return 0
}
Run()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("3", result.ValueText)
    }

    /// #5832 review: an imported G# type has no source declaration in this compilation, so its layout is not
    /// known here. A field write of an imported type keeps the full rule, so an overlapping explicit-layout field
    /// cannot keep a stale fact. A read alone keeps the fact.
    @Theory
    @InlineData("        b.Other = nil\n        return b.Text.Length // READ", false)
    @InlineData("        return b.Text.Length", true)
    func ImportedExplicitLayoutFieldWrite_RemovesFact(body string, accepted bool) {
        let libraryPath = EmitLibrary(
            if accepted {
                "read"
            } else {
                "write"
            }
        )
        let source = `import System
import Models

func Run(b Box) int32 {
    if b.Text != nil {
` + body + `
    }
    return 0
}
Run(Box("abc"))
`
        let result = EmittedOracle.Evaluate(source, references: []string{libraryPath})
        if accepted {
            Assert.Empty(result.Diagnostics)
            Assert.Equal("3", result.ValueText)
        } else {
            let diagnostic = Assert.Single(result.Diagnostics)
            Assert.Equal("GS0158", diagnostic.Id)
            Assert.Equal(MarkedLine(source), diagnostic.Location.StartLine + 1)
        }
    }

    private func MemberNotNullBox(kind string, write string, read string, call string) string -> `import System
import System.Diagnostics.CodeAnalysis

class Owner {
    var A bool
}
` + kind + ` Box {
    var _name string?
    var count int32
    let owner Owner?
    init(owner Owner?) {
        this.owner = owner
        this._name = nil
        this.count = 0
    }
    @MemberNotNull("_name")
    func EnsureInit() {
        _name = "hello"
    }
    func Run(other Box) int32 {
        this.EnsureInit()
        if owner != nil {
            ` + write + `
            owner.A = true
            ` + read + `
        }
        return 0
    }
}
` + call + `
`

    /// ADR-0208 R21 and #5830 together: a write of the `var` field `_name` through another reference keeps the
    /// fact on the stable path `owner` and removes the `[MemberNotNull]` fact on `_name`, which it writes.
    @Theory
    @InlineData("class", "other._name = nil")
    @InlineData("struct", "var copy = other\n            copy._name = nil")
    func VarFieldWriteOfTheMemberNotNullField_KeepsPathFact_RemovesMemberNotNullFact(kind string, write string) {
        let source = MemberNotNullBox(kind, write, "return _name.Length // READ", "var b = Box(Owner())\nb.Run(b)")
        let result = EmittedOracle.Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal(MarkedLine(source), diagnostic.Location.StartLine + 1)
    }

    /// A write of another `var` field keeps both facts: through another object, and through the struct `this`
    /// itself, whose own fields do not overlap.
    @Theory
    @InlineData("class", "other.count = 4", "return _name.Length + other.count")
    @InlineData("struct", "var copy = other\n            copy.count = 4", "return _name.Length + copy.count")
    @InlineData("class", "this.count = 4", "return _name.Length + this.count")
    @InlineData("struct", "this.count = 4", "return _name.Length + this.count")
    func VarFieldWriteOfAnotherField_KeepsPathFactAndMemberNotNullFact(kind string, write string, read string) {
        let result = EmittedOracle.Evaluate(MemberNotNullBox(kind, write, read, "var b = Box(Owner())\nb.Run(b)"))
        Assert.Empty(result.Diagnostics)
        Assert.Equal("9", result.ValueText)
    }

    /// A `[MemberNotNull]` fact on a bare field of a struct `this` is a fact on a member of `this`, so R20 applies:
    /// `h.tok = fresh` replaces the storage that `this` names (#5827), and the fact dies.
    @Fact
    func WriteThatReplacesStructThis_RemovesMemberNotNullFact() {
        let source = `import System
import System.Diagnostics.CodeAnalysis

struct Token {
    var _name string?
    init() {
        this._name = nil
    }
    @MemberNotNull("_name")
    func EnsureInit() {
        _name = "hello"
    }
    func Restore(h Holder, fresh Token) int32 {
        this.EnsureInit()
        h.tok = fresh
        return _name.Length // READ
    }
}
class Holder {
    var tok Token
    func Run() int32 {
        return tok.Restore(this, Token())
    }
}
Holder{tok: Token()}.Run()
`
        let result = EmittedOracle.Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal(MarkedLine(source), diagnostic.Location.StartLine + 1)
    }

    shared {
        private func EmitLibrary(caseName string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue5786FieldWrite", caseName)
            Directory.CreateDirectory(directory)
            let libraryPath = Path.Combine(directory, "Models.dll")
            let library = GsCompilation(GsSyntaxTree.Parse(SourceText.From(`package Models
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Explicit)
data class Box {
    @FieldOffset(0)
    let Text string?
    @FieldOffset(0)
    var Other string?
    init(t string?) {
        this.Text = t
        this.Other = t
    }
}`))){IsLibrary = true}
            using let stream = File.Create(libraryPath)
            let result = library.Emit(stream, pdbStream: nil, refStream: nil, assemblyName: "Models")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return libraryPath
        }
    }
}
