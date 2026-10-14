// <copyright file="Issue2165IsInterfaceNarrowingTests.cs" company="GSharp">
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

/// Issue #2165 — `is`-pattern smart-cast narrowing to an INTERFACE must
/// also take effect when the operand's static type is a TYPE PARAMETER
/// (`T`) or ANOTHER INTERFACE, not only when it is `object` or a
/// concrete class. A value of interface/type-parameter type may dynamically
/// implement additional, statically-unrelated interfaces, so `if x is IInit`
/// narrows `x` to `IInit` (Kotlin-parity) and `x.Init()` resolves.
open class Issue2165IsInterfaceNarrowingTests {
    @Fact
    func If_IsInterface_OnInterfaceOperand_NarrowsToTestedInterface() {
        // Declared type is another (unrelated) interface. Narrowing to the
        // tested interface must make its member resolvable.
        let result = Evaluate(`
interface IInit {
    func Init() void;
}
interface IShape {
    func Area() int32;
}
func Run(x IShape) void {
    if x is IInit {
        x.Init()
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsInterface_OnTypeParameterOperand_NarrowsToTestedInterface() {
        // Declared type is an unconstrained type parameter.
        let result = Evaluate(`
interface IInit {
    func Init() void;
}
func Run[T](x T) void {
    if x is IInit {
        x.Init()
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func And_IsInterface_OnInterfaceOperand_NarrowsRightOperand() {
        // The short-circuit (`x is I && …`) classifier must agree with the
        // `if`-statement classifier for interface operands.
        let result = Evaluate(`
interface IInit {
    func Init() int32;
}
interface IShape {
    func Area() int32;
}
func Run(x IShape) bool {
    return x is IInit && x.Init() > 0
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsInterface_OnObjectOperand_StillNarrows() {
        // Control (A): the pre-existing `object` operand case must keep working.
        let result = Evaluate(`
interface IInit {
    func Init() void;
}
func Run(x object) void {
    if x is IInit {
        x.Init()
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsConcreteClass_OnObjectOperand_StillNarrows() {
        // Control (B): the pre-existing concrete-class operand case must keep
        // working.
        let result = Evaluate(`
class Circle {
    func Blah() void {}
}
func Run(x object) void {
    if x is Circle {
        x.Blah()
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsBaseInterface_OnInterfaceOperand_KeepsDeclaredMembers() {
        // A widening to a base interface the declared type already satisfies
        // must NOT narrow — the declared interface's own members must remain
        // resolvable (no regression, no member hiding).
        let result = Evaluate(`
interface IBase {
    func Base() void;
}
interface IShape : IBase {
    func Area() int32;
}
func Run(x IShape) int32 {
    if x is IBase {
        return x.Area()
    }
    return 0
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func InterfaceOperand_TestedMemberUnavailableBeforeTest() {
        // Before the narrowing test, `x` is still `IShape` — `Init()` (an
        // IInit-only member) must NOT resolve.
        let result = Evaluate(`
interface IInit {
    func Init() void;
}
interface IShape {
    func Area() int32;
}
func Run(x IShape) void {
    x.Init()
}
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Init"))
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
