// <copyright file="Issue2818StructTemporaryFieldAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Issue #2818: field writes through non-addressable struct values must fail
/// in binding instead of mutating a discarded emitter spill temporary.
open class Issue2818StructTemporaryFieldAssignmentTests {
    @Fact
    func FunctionResultFieldAssignment_ReportsGS0499() {
        let result = Evaluate(`package P

struct Item {
    var Id int32
}

func MakeItem() Item {
    return Item{Id: 1}
}

MakeItem().Id = 7`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0499")
    }

    @Fact
    func NarrowedOptionalStructFieldAssignment_ReportsGS0499() {
        let result = Evaluate(`package P

struct Item {
    var Id int32
}

var item Item? = Item{Id: 1}
if item != nil {
    item.Id = 7
}`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0499")
    }

    @Theory
    @InlineData("=")
    @InlineData("+=")
    func LetStructLocal_NestedFieldAssignment_ReportsGS0499(assignmentOperator string) {
        let result = Evaluate((`package P2818ReadonlyLocal

struct Item {
    var Id int32
}

struct Outer {
    var Inner Item
}

let outer = Outer{Inner: Item{Id: 1}}
outer.Inner.Id ` + "$assignmentOperator" + ` 5`))
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0499")
    }

    @Theory
    @InlineData("=")
    @InlineData("+=")
    func ClassHeldReadonlyStructFieldAssignment_ReportsGS0499(assignmentOperator string) {
        let result = Evaluate((`package P2818ReadonlyInstance

struct Item {
    var Id int32
}

class Holder {
    let Value Item = Item{Id: 1}
}

var holder = Holder()
holder.Value.Id ` + "$assignmentOperator" + ` 5`))
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0499")
    }

    @Fact
    func InstanceReadonlyStructFieldAssignments_InDeclaringConstructor_DoNotReportGS0499() {
        let result = Evaluate(`package P2818ReadonlyInstanceConstructor

struct Item {
    var Id int32
}

class Holder {
    let Value Item = Item{Id: 1}

    init() {
        Value.Id = 5
        Value.Id += 2
    }
}`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0499")
    }

    @Fact
    func StaticReadonlyStructFieldAssignment_ReportsGS0499() {
        let result = Evaluate(`package P2818StaticSimple

struct Item {
    var Id int32
}

class Holder {
    shared {
        let Origin Item = Item{Id: 1}
    }
}

Holder.Origin.Id = 5`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0499")
    }

    @Fact
    func StaticReadonlyStructFieldCompoundAssignment_ReportsGS0499() {
        let result = Evaluate(`package P2818StaticCompound

struct Item {
    var Id int32
}

class Holder {
    shared {
        let Origin Item = Item{Id: 1}
    }
}

Holder.Origin.Id += 5`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0499")
    }

    @Fact
    func MutableStaticStructFieldAssignments_DoNotReportGS0499() {
        let result = Evaluate(`package P2818StaticMutable

struct Item {
    var Id int32
}

class Holder {
    shared {
        var Origin Item = Item{Id: 1}
    }
}

Holder.Origin.Id = 5
Holder.Origin.Id += 2`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0499")
    }

    @Fact
    func StaticReadonlyStructFieldAssignments_InDeclaringCctor_DoNotReportGS0499() {
        let result = Evaluate(`package P2818StaticCctor

struct Item {
    var Id int32
}

class Holder {
    shared {
        let Origin Item = Item{Id: 1}
        let InitializerResult int32 = (Holder.Origin.Id = 3)
        init {
            Holder.Origin.Id = 5
            Holder.Origin.Id += 2
        }
    }
}`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0499")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
