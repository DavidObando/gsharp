// <copyright file="Issue5786BareMemberWriteReceiverNarrowingTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import Xunit

/// Issue #5786: a bare member name rebinds as `this.member`. A nil guard on a stable member records its fact
/// under the member's access path. A bare member name that is the receiver of a member write, an index write,
/// a compound assignment or an increment, or that is a value read, must see that fact as `this.member` does.
/// The tests run the emitted program in a struct and in a class.
open class Issue5786BareMemberWriteReceiverNarrowingTests {
    // The guarded body starts on this line of the source (1-based).
    private let BodyLine int32 = 23

    private func Source(kind string, ownerField string, body string) string -> `import System.Collections.Generic

class Owner {
    prop A bool { get; set; }
    var N int32 = 0
}
` + kind + ` Token {
    private ` + ownerField + ` owner Owner?
    private let items List[int32]?
    private let arr ([]int32)?
    prop P Owner? { get; }
    prop L List[int32]? { get; }
    init(owner Owner, items List[int32], arr []int32) {
        this.owner = owner
        this.items = items
        this.arr = arr
        this.P = owner
        this.L = items
    }
    func Touch() { }
    func Restore() {
        if owner != nil && items != nil && arr != nil && P != nil && L != nil {
` + body + `
        }
    }
}
let o = Owner()
let xs = List[int32]{0}
let ys = []int32{0}
Token(o, xs, ys).Restore()
o.A.ToString() + " " + o.N.ToString() + " " + xs[0].ToString() + " " + ys[0].ToString()
`

    @Theory
    @InlineData("struct", "owner.A = true", "True 0 0 0")
    @InlineData("class", "owner.A = true", "True 0 0 0")
    @InlineData("struct", "P.A = true", "True 0 0 0")
    @InlineData("class", "P.A = true", "True 0 0 0")
    @InlineData("struct", "owner.N = 4", "False 4 0 0")
    @InlineData("class", "owner.N = 4", "False 4 0 0")
    @InlineData("struct", "let a = owner.A\nlet n = owner.N\nowner.N = n + 3", "False 3 0 0")
    @InlineData("class", "let a = owner.A\nlet n = owner.N\nowner.N = n + 3", "False 3 0 0")
    @InlineData("struct", "owner.N += 4", "False 4 0 0")
    @InlineData("class", "owner.N += 4", "False 4 0 0")
    @InlineData("struct", "owner.N++", "False 1 0 0")
    @InlineData("class", "owner.N++", "False 1 0 0")
    @InlineData("struct", "items[0] = 7", "False 0 7 0")
    @InlineData("class", "items[0] = 7", "False 0 7 0")
    @InlineData("struct", "L[0] = 8", "False 0 8 0")
    @InlineData("class", "L[0] = 8", "False 0 8 0")
    @InlineData("struct", "arr[0] = 9", "False 0 0 9")
    @InlineData("class", "arr[0] = 9", "False 0 0 9")
    @InlineData("struct", "let t Owner = owner\nt.A = true", "True 0 0 0")
    @InlineData("class", "let t Owner = owner\nt.A = true", "True 0 0 0")
    @InlineData("struct", "let t Owner = P\nt.N = 2", "False 2 0 0")
    @InlineData("class", "let t Owner = P\nt.N = 2", "False 2 0 0")
    func GuardedBareMember_IsNarrowedInWriteReceiverAndValueRead(kind string, body string, expected string) {
        let result = EmittedOracle.Evaluate(Source(kind, "let", body))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.ValueText)
    }

    /// The issue's combined rows: a second write or read through the narrowed member after a scalar property or
    /// `var` field write (ADR-0208 R20, R21).
    @Theory
    @InlineData("struct", "owner.A = true\nowner.N = 3", "True 3 0 0")
    @InlineData("class", "owner.A = true\nowner.N = 3", "True 3 0 0")
    @InlineData("struct", "this.owner.A = true\nthis.owner.N = 3", "True 3 0 0")
    @InlineData("class", "this.owner.A = true\nthis.owner.N = 3", "True 3 0 0")
    @InlineData("struct", "owner.N = 1\nowner.N += 2", "False 3 0 0")
    @InlineData("class", "owner.N = 1\nowner.N += 2", "False 3 0 0")
    @InlineData("struct", "this.owner.N = 1\nthis.owner.N++", "False 2 0 0")
    @InlineData("class", "this.owner.N = 1\nthis.owner.N++", "False 2 0 0")
    @InlineData("struct", "owner.N = 5\nitems[0] = owner.N", "False 5 5 0")
    @InlineData("class", "owner.N = 5\nitems[0] = owner.N", "False 5 5 0")
    @InlineData("struct", "owner.N = 5\nlet t Owner = owner\nt.A = true", "True 5 0 0")
    @InlineData("class", "owner.N = 5\nlet t Owner = owner\nt.A = true", "True 5 0 0")
    @InlineData("struct", "P.A = true\nP.N = 7", "True 7 0 0")
    @InlineData("class", "P.A = true\nP.N = 7", "True 7 0 0")
    func GuardedMember_SeveralScalarWrites_KeepFact(kind string, body string, expected string) {
        let result = EmittedOracle.Evaluate(Source(kind, "let", body))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.ValueText)
    }

    /// The issue's row that reads through `this.owner` and then writes once already compiles. It stays accepted.
    @Theory
    @InlineData("struct")
    @InlineData("class")
    func GuardedMember_ExplicitReadThenOneWrite_RunsAsBefore(kind string) {
        let result = EmittedOracle.Evaluate(Source(kind, "let", "let a = this.owner.A\nthis.owner.A = !a"))
        Assert.Empty(result.Diagnostics)
        Assert.Equal("True 0 0 0", result.ValueText)
    }

    /// A bare rectangular array member is the receiver of a rectangular index write.
    @Theory
    @InlineData("struct")
    @InlineData("class")
    func GuardedBareRectangularMember_IsNarrowedInIndexWriteReceiver(kind string) {
        let result = EmittedOracle.Evaluate(kind + ` Grid {
    private let cells ([,]int32)?
    init(cells [,]int32) {
        this.cells = cells
    }
    func Fill() {
        if cells != nil {
            cells[1, 1] = 4
        }
    }
}
let cells = [2, 2]int32
Grid(cells).Fill()
cells[1, 1].ToString()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("4", result.ValueText)
    }

    /// Issue #208: a `[MemberNotNull]` fact is on the implicit field. A bare write receiver sees it too.
    @Theory
    @InlineData("struct")
    @InlineData("class")
    func MemberNotNullField_BareWriteReceiver_IsNarrowed(kind string) {
        let result = EmittedOracle.Evaluate(`import System.Diagnostics.CodeAnalysis

class Owner {
    prop A bool { get; set; }
}
` + kind + ` Holder {
    private var owner Owner?
    init() {
        this.owner = nil
    }
    @MemberNotNull("owner")
    func Ensure() {
        owner = Owner()
    }
    func Run() bool {
        this.Ensure()
        owner.A = true
        let read Owner = owner
        return read.A
    }
}
var h = Holder()
h.Run().ToString()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("True", result.ValueText)
    }

    /// Negative controls: the bare receiver gets the fact of `this.member` and no other fact.
    /// A `var` field is not a stable path, a call removes member facts, and no guard gives no fact.
    @Theory
    @InlineData("struct", "var", "owner.A = true", 0, "GS0158")
    @InlineData("class", "var", "owner.A = true", 0, "GS0158")
    @InlineData("struct", "let", "Touch()\nowner.A = true", 1, "GS0158")
    @InlineData("class", "let", "Touch()\nowner.A = true", 1, "GS0158")
    @InlineData("struct", "let", "Touch()\nowner.N += 1", 1, "GS0158")
    @InlineData("class", "let", "Touch()\nowner.N += 1", 1, "GS0158")
    @InlineData("struct", "let", "Touch()\nitems[0] = 1", 1, "GS0116")
    @InlineData("class", "let", "Touch()\nitems[0] = 1", 1, "GS0116")
    func BareMemberWithoutFact_StaysRejected(
        kind string,
        ownerField string,
        body string,
        lineOffset int32,
        expectedId string
    ) {
        let result = EmittedOracle.Evaluate(Source(kind, ownerField, body))
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal(expectedId, diagnostic.Id)
        Assert.Equal(BodyLine + lineOffset, diagnostic.Location.StartLine + 1)
    }

    @Theory
    @InlineData("struct")
    @InlineData("class")
    func UnguardedBareMemberWrite_StaysRejected(kind string) {
        let source = Source(kind, "let", "owner.A = true").Replace(
            "if owner != nil && items != nil && arr != nil && P != nil && L != nil {",
            "if items != nil {"
        )
        let result = EmittedOracle.Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal(BodyLine, diagnostic.Location.StartLine + 1)
    }
}
