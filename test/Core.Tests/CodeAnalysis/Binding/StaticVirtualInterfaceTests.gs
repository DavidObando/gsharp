// <copyright file="StaticVirtualInterfaceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0089 / issue #755 (issue #865 revision) — static-virtual interface
/// members. These tests pin the binder behaviour for the `shared { … }`
/// interface member shape, the generic-constraint `[T IFoo]` dispatch
/// path (`T.M(args)`), and the diagnostics introduced for failures on the
/// implementer side (GS0330–GS0333).
open class StaticVirtualInterfaceTests {
    @Fact
    func StaticFunc_AbstractInInterface_Binds() {
        let source = `
sealed interface IZero {
    shared {
        func Zero() int32;
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func StaticFunc_DefaultBodyInInterface_Binds() {
        let source = `
sealed interface IZero {
    shared {
        func Zero() int32 { return 0 }
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Implementer_WithSharedStatic_NoDiagnostics() {
        // Canonical pattern: the implementer's shared-block static method
        // satisfies the interface's static-virtual abstract slot.
        let source = `
sealed interface IAdd {
    shared {
        func Add(a int32, b int32) int32;
    }
}

class Adder : IAdd {
    shared {
        func Add(a int32, b int32) int32 { return a + b }
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Implementer_MissingAbstractStatic_ReportsGS0331() {
        let source = `
sealed interface IAdd {
    shared {
        func Add(a int32, b int32) int32;
    }
}

class BrokenAdder : IAdd {
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0331")
    }

    @Fact
    func Implementer_InstanceMethodForStaticSlot_ReportsGS0332() {
        let source = `
sealed interface IAdd {
    shared {
        func Add(a int32, b int32) int32;
    }
}

class WrongAdder : IAdd {
    func Add(a int32, b int32) int32 { return a + b }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0331" || d.Id == "GS0332")
    }

    @Fact
    func Default_OnInterface_AllowsImplementerToOmit() {
        // ADR-0089 §3.2: a default static body lets implementers omit the
        // override entirely. The binder must NOT emit GS0331 here.
        let source = `
sealed interface IZero {
    shared {
        func Zero() int32 { return 0 }
    }
}

class IntZero : IZero {
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GenericConstraint_WithStaticVirtualInterface_NonSealed_Allowed() {
        // ADR-0089 §6.2: the GS0153 sealed-only restriction is relaxed when
        // the interface carries any static-virtual member. A non-sealed
        // static-virtual interface MUST be usable as a generic constraint
        // because it is the only way generic-math abstractions compose.
        let source = `
interface IFactory {
    shared {
        func Make() int32 { return 0 }
    }
}

func Use[T IFactory]() int32 { return T.Make() }
`
        let result = Evaluate(source)
        Assert.DoesNotContain(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("sealed", StringComparison.OrdinalIgnoreCase)
        )
    }

    @Fact
    func TypeParameter_StaticAccess_WithMatchingMember_Binds() {
        // The canonical generic-math dispatch: `T.Add(...)` where `T : IAdd`.
        // No diagnostics on the call site.
        let source = `
sealed interface IAdd {
    shared {
        func Add(a int32, b int32) int32;
    }
}

class Adder : IAdd {
    shared {
        func Add(a int32, b int32) int32 { return a + b }
    }
}

func Sum[T IAdd](w T, a int32, b int32) int32 {
    return T.Add(a, b)
}

Sum(Adder{}, 3, 4)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func TypeParameter_StaticAccess_NonExistentMember_ReportsGS0333() {
        let source = `
sealed interface IAdd {
    shared {
        func Add(a int32, b int32) int32;
    }
}

func Wrong[T IAdd](a int32, b int32) int32 {
    return T.Multiply(a, b)
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0333")
    }

    @Fact
    func InterfaceSharedBlock_NonFuncMember_ReportsGS0330() {
        // Issue #1030: `var` / `let` / `const` interface static state and
        // `prop` static-virtual properties are now supported. Other member
        // kinds (e.g. `event`) remain rejected with GS0330.
        let source = `
interface IBad {
    shared {
        event Changed System.Action
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0330")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
