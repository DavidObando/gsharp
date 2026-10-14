// <copyright file="Issue1030InterfaceStaticMembersTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// ADR-0089 / issue #1030 — interface static *state* (storage) and
/// default-bodied static-virtual interface *properties* (follow-up to #1019).
/// Pins binder behaviour: interface `var`/`let`/`const` fields
/// bind, qualified `IName.Field` read/write binds, a default-bodied
/// static interface property binds and does NOT require an implementer, and
/// assigning a `let`/`const` interface field is rejected.
open class Issue1030InterfaceStaticMembersTests {
    @Fact
    func InterfaceStaticState_VarLetConst_Binds() {
        let source = `
interface ICounter {
  shared {
    var Count int32 = 0
    let Label string = "c"
    const Max int32 = 100
  }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func QualifiedReadAndWrite_Binds() {
        let source = `
interface ICounter {
  shared {
    var Count int32 = 0
  }
}

func Bump() int32 {
  ICounter.Count = ICounter.Count + 1
  return ICounter.Count
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func AssignToConstInterfaceField_ReportsCannotAssign() {
        let source = `
interface ICounter {
  shared {
    const Max int32 = 100
  }
}

func Bad() {
  ICounter.Max = 5
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func DefaultBodiedStaticProperty_ImplementerNotRequired() {
        // A fully default-bodied static-virtual interface property is satisfied
        // by the interface itself; an implementer that omits it is NOT flagged
        // with GS0397.
        let source = `
sealed interface IData {
  shared {
    prop Name string { get { return "default" } }
  }
}

struct Apple : IData {
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0397")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GenericInterfaceStaticState_Binds() {
        // Issue #1030 (deferred work): generic interface static state is now
        // supported — fields bind and qualified per-construction access binds
        // cleanly (no GS0330).
        let source = `
sealed interface IBox[T] {
  shared {
    var Slot int32 = 0
    const Cap int32 = 8
  }
}

func Use() int32 {
  IBox[int32].Slot = IBox[int32].Slot + 1
  IBox[string].Slot = IBox[string].Slot + 2
  return IBox[int32].Slot + IBox[string].Slot + IBox[int32].Cap
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0330")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GenericInterfaceStaticField_CompoundAssignment_Binds() {
        // Issue #1030 (deferred work): compound assignment on a generic
        // interface static field binds with no diagnostics.
        let source = `
interface IBox[T] {
  shared {
    var Count int32 = 0
  }
}

func Bump() int32 {
  IBox[int32].Count += 3
  IBox[int32].Count -= 1
  return IBox[int32].Count
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
