// <copyright file="Issue5827ValueTypeWriteOverByReferenceRootTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import Xunit

/// Issue #5827, ADR-0208 R20: a member write that runs no user code keeps the facts on member paths (#5796).
/// A by-reference root (a struct `this`, a `ref` parameter) can name a field, an element or the backing field of an
/// auto property. A write whose location can hold the storage of that root removes the facts on the root's paths.
/// The tests run the emitted program. A rejected program is checked by its diagnostic ID and line.
open class Issue5827ValueTypeWriteOverByReferenceRootTests {
    private let Prefix string = `import System

class Owner {
    prop A bool { get; set; }
    prop B bool { get; set; }
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

    private func AssertRuns(body string, expected string) {
        let result = EmittedOracle.Evaluate(Prefix + body)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.ValueText)
    }

    /// The repro of #5827. Inside `Holder`, `Tok.Restore(...)` runs on the backing field of `Tok`, so `this`
    /// names that field and `h.Tok = fresh` replaces `this.owner`.
    @Fact
    func AutoPropertyWriteOfTheRootType_RemovesFactOnStructThis() {
        AssertRejectedAtMarker(`struct Token {
    let owner Owner?
    init(owner Owner?) {
        this.owner = owner
    }
    func Restore(h Holder, fresh Token) bool {
        if owner != nil {
            h.Tok = fresh
            return this.owner.A // READ
        }
        return false
    }
}
class Holder {
    prop Tok Token { get; set; }
    func Run() bool {
        return Tok.Restore(this, Token(nil))
    }
}
let h = Holder()
h.Tok = Token(Owner())
h.Run().ToString()
`)
    }

    /// A struct that contains the root's type in a field holds the root's storage too.
    @Fact
    func AutoPropertyWriteOfAContainingStruct_RemovesFactOnStructThis() {
        AssertRejectedAtMarker(`struct Token {
    let owner Owner?
    init(owner Owner?) {
        this.owner = owner
    }
    func Restore(h Holder, fresh Wrapper) bool {
        if owner != nil {
            h.Pair = fresh
            return this.owner.A // READ
        }
        return false
    }
}
struct Wrapper {
    var tok Token
    var n int32
}
class Holder {
    prop Pair Wrapper { get; set; }
    func Run() bool {
        return Pair.tok.Restore(this, Wrapper{tok: Token(nil), n: 0})
    }
}
let h = Holder()
h.Pair = Wrapper{tok: Token(Owner()), n: 0}
h.Run().ToString()
`)
    }

    /// A tuple element, a type argument and a `Nullable<T>` can hold the root's type.
    @Theory
    @InlineData("(Token, int32)")
    @InlineData("Box[Token]")
    @InlineData("Token?")
    func AutoPropertyWriteOfATupleOrGenericValue_RemovesFactOnStructThis(slotType string) {
        AssertRejectedAtMarker(`struct Token {
    let owner Owner?
    init(owner Owner?) {
        this.owner = owner
    }
    func Restore(h Holder, fresh ` + slotType + `) bool {
        if owner != nil {
            h.Slot = fresh
            return this.owner.A // READ
        }
        return false
    }
}
struct Box[T] {
    var V T
}
class Holder {
    prop Slot ` + slotType + ` { get; set; }
}
"done"
`)
    }

    /// A `ref` parameter is a by-reference root too.
    @Fact
    func AutoPropertyWriteOfTheRootType_RemovesFactOnRefParameter() {
        AssertRejectedAtMarker(`struct Token {
    let owner Owner?
    init(owner Owner?) {
        this.owner = owner
    }
}
class Holder {
    var tok Token
    prop Tok Token { get; set; }
}
func Use(ref t Token, h Holder, fresh Token) bool {
    if t.owner != nil {
        h.Tok = fresh
        return t.owner.A // READ
    }
    return false
}
let h = Holder()
h.tok = Token(Owner())
Use(ref h.tok, h, Token(nil)).ToString()
`)
    }

    /// A write in a branch reaches the read after the join.
    @Fact
    func AutoPropertyWriteInABranch_RemovesFactAfterTheJoin() {
        AssertRejectedAtMarker(`struct Token {
    let owner Owner?
    init(owner Owner?) {
        this.owner = owner
    }
    func Restore(h Holder, fresh Token, c bool) bool {
        if owner != nil {
            if c {
                h.Tok = fresh
            }
            return this.owner.A // READ
        }
        return false
    }
}
class Holder {
    prop Tok Token { get; set; }
    func Run() bool {
        return Tok.Restore(this, Token(nil), true)
    }
}
let h = Holder()
h.Tok = Token(Owner())
h.Run().ToString()
`)
    }

    /// R14: a setter that can dispatch to an override is a call, so it still removes the facts.
    @Theory
    @InlineData("struct")
    @InlineData("class")
    func OverridableSetter_StillRemovesFact(kind string) {
        let source = `import System

open class Owner {
    open prop A bool { get; set; }
    prop B bool { get; set; }
}
` + kind + ` Token {
    let owner Owner?
    init(owner Owner?) {
        this.owner = owner
    }
    func Restore() {
        if owner != nil {
            this.owner.A = true
            this.owner.B = true // READ
        }
    }
}
Token(Owner()).Restore()
"done"
`
        let result = EmittedOracle.Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal(MarkedLine(source), diagnostic.Location.StartLine + 1)
    }

    /// A constructor write of a get-only auto property writes a stable link, so it removes the facts.
    @Theory
    @InlineData("struct")
    @InlineData("class")
    func ConstructorWriteOfAStableLink_StillRemovesFact(kind string) {
        AssertRejectedAtMarker(kind + ` Token {
    prop P Owner? { get; }
    init(first Owner, second Owner?) {
        this.P = first
        if P != nil {
            this.P = second
            P.A = true // READ
        }
    }
}
Token(Owner(), nil).P == nil
`)
    }

    /// A fact on a by-reference root itself dies on every member write (R12), whatever the written type.
    @Theory
    @InlineData("struct")
    @InlineData("class")
    func FactOnARefParameterRoot_StillDiesOnAScalarPropertyWrite(kind string) {
        AssertRejectedAtMarker(kind + ` Token {
    let owner Owner?
    init(owner Owner?) {
        this.owner = owner
    }
    func Mutate(ref alias string?) int32 {
        if owner != nil && alias != nil {
            owner.B = true
            return alias.Length // READ
        }
        return 0
    }
}
var s string? = "abc"
Token(Owner()).Mutate(ref s)
`)
    }

    /// ADR-0213: a loop keeps the region rule, so a property write in the loop removes the member facts.
    @Theory
    @InlineData("struct")
    @InlineData("class")
    func PropertyWriteInALoop_StillRemovesFact(kind string) {
        let source = Prefix + kind + ` Token {
    let owner Owner?
    init(owner Owner?) {
        this.owner = owner
    }
    func Run() bool {
        if owner != nil {
            for var i = 0; i < 2; i++ {
                this.owner.B = true // READ
            }
        }
        return false
    }
}
Token(Owner()).Run()
`
        let result = EmittedOracle.Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal(MarkedLine(source), diagnostic.Location.StartLine + 1)
    }

    /// The rows of #5786 that #5796 accepts stay accepted: a scalar write cannot hold a `Token`.
    @Theory
    @InlineData("struct", "this.owner.A = true\nthis.owner.B = true", "True True")
    @InlineData("class", "this.owner.A = true\nthis.owner.B = true", "True True")
    @InlineData("struct", "this.owner.A = true\nlet x = this.owner.B\nthis.owner.B = !x", "True True")
    @InlineData("class", "this.owner.A = true\nlet x = this.owner.B\nthis.owner.B = !x", "True True")
    @InlineData("struct", "owner.A = true\nowner.B = true", "True True")
    @InlineData("class", "owner.A = true\nowner.B = true", "True True")
    func ScalarAutoPropertyWrites_KeepFact(kind string, body string, expected string) {
        AssertRuns(kind + ` Token {
    let owner Owner?
    init(owner Owner?) {
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
o.A.ToString() + " " + o.B.ToString()
`, expected)
    }

    /// A reference location holds one reference, not the storage of a struct root. A class `this` is not a
    /// by-reference root, so a value write of any type keeps its facts.
    @Theory
    @InlineData("struct", "h.Name = \"x\"")
    @InlineData("struct", "h.Next = h")
    @InlineData("struct", "h.Count = 4")
    @InlineData("class", "h.Tok = fresh")
    @InlineData("class", "h.Pair = pair")
    func WritesThatCannotHoldTheRoot_KeepFact(kind string, write string) {
        AssertRuns(kind + ` Token {
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
    var n int32
}
class Holder {
    prop Name string? { get; set; }
    prop Next Holder? { get; set; }
    prop Count int32 { get; set; }
    prop Tok Token { get; set; }
    prop Pair Wrapper { get; set; }
}
Token(Owner()).Restore(Holder(), Token(nil), Wrapper{tok: Token(nil), n: 0}).ToString()
`, "True")
    }
}
