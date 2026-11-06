// <copyright file="Issue5786FieldWriteStableMemberPathTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
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
}
