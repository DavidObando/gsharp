// <copyright file="Issue3526ClassIsInterfaceNarrowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import Xunit

/// Issue #3526 — the concrete-class residual of #2165/#2171: an `is
/// IInterface` test must smart-cast a receiver whose declared type is a
/// concrete class that CAN have subclasses — `open` (subclassable
/// anywhere) or `sealed` (ADR-0078 closed hierarchy, subclassable
/// in-package) — even when the class itself does not statically implement
/// the tested interface. A runtime value may be a subclass that does
/// implement it, so `if x is IInterface` narrows `x` to
/// `IInterface` (matching the pre-existing `object` operand
/// behaviour) and its members resolve. A plain, default class (neither
/// `open` nor `sealed`) is CLR-sealed and has no subclass at all,
/// so it must keep reporting GS0159.
open class Issue3526ClassIsInterfaceNarrowingTests {
    @Fact
    func If_IsImportedInterface_OnOpenClassOperand_NarrowsToTestedInterface() {
        // Repro from the issue: an `open class` receiver tested against the
        // imported `IDisposable` interface it does not statically implement.
        let result = EmittedOracle.Evaluate(`
import System
open class Resource {
}
func DisposeIfNeeded(value Resource) bool {
    if value is IDisposable {
        value.Dispose()
        return true
    }
    return false
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsSourceInterface_OnOpenClassOperand_NarrowsToTestedInterface() {
        // The issue notes the same failure occurs with a source-declared G#
        // interface, so it is not specific to imported `IDisposable`.
        let result = EmittedOracle.Evaluate(`
interface IInit {
    func Init() void;
}
open class Resource {
}
func Run(value Resource) void {
    if value is IInit {
        value.Init()
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsInterface_OnDefaultClassOperand_StillReportsGS0159() {
        // Control: a plain, non-`open`/non-`sealed` class (CLR-sealed, per
        // TypeDefEmitter.ResolveStructTypeShape) has no subclass at all —
        // known or unknown — so the member must remain unresolved.
        let result = EmittedOracle.Evaluate(`
import System
class Resource {
}
func DisposeIfNeeded(value Resource) bool {
    if value is IDisposable {
        value.Dispose()
        return true
    }
    return false
}
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Dispose"))
    }

    @Fact
    func If_IsInterface_OnSealedHierarchyClassOperand_NarrowsToTestedInterface() {
        // Regression for review feedback on #3526: `sealed class` (ADR-0078)
        // is a CLOSED HIERARCHY, not a CLR-sealed type — same-package
        // subclasses are legal (TypeDefEmitter deliberately omits
        // TypeAttributes.Sealed for it) and here a known subclass DOES
        // implement the tested interface. Narrowing must still apply.
        let result = EmittedOracle.Evaluate(`
interface IInit {
    func Init() void;
}
sealed class Resource {
}
class SpecialResource : Resource, IInit {
    func Init() void {}
}
func Run(value Resource) void {
    if value is IInit {
        value.Init()
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func And_IsInterface_OnOpenClassOperand_NarrowsRightOperand() {
        // The short-circuit (`x is I && …`) classifier must agree with the
        // `if`-statement classifier for open-class operands.
        let result = EmittedOracle.Evaluate(`
import System
open class Resource {
}
func Run(value Resource) bool {
    return value is IDisposable && Run2(value)
}
func Run2(value IDisposable) bool {
    value.Dispose()
    return true
}
`)
        Assert.Empty(result.Diagnostics)
    }
}
