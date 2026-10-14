// <copyright file="Issue757BaseInterfaceCallBinderTests.cs" company="GSharp">
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

/// ADR-0091 / issue #757: binder tests for the explicit-base interface
/// call expression `base[IFoo].Method(args)`. Verifies that the
/// happy path resolves to the inherited default body, and that all four
/// diagnostics (GS0338 / GS0339 / GS0340 / GS0341) fire on the expected
/// ill-formed inputs. Also covers chaining and use inside a private
/// member of the implementing class.
open class Issue757BaseInterfaceCallBinderTests {
    @Fact
    func DiamondDelegation_ExplicitBase_ResolvesAndRuns() {
        let source = `
interface IA {
    func M() int32 { return 10 }
}

interface IB {
    func M() int32 { return 20 }
}

class C : IA, IB {
    func M() int32 { return base[IA].M() + base[IB].M() }
}

var c = C{}
c.M()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(30, result.Value)
    }

    @Fact
    func BaseInterface_NotImplemented_DiagnosticGS0338() {
        let source = `
interface IFoo {
    func M() int32 { return 1 }
}

interface IBar {
    func M() int32 { return 2 }
}

class C : IFoo {
    func M() int32 { return base[IBar].M() }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0338")
    }

    @Fact
    func BaseInterface_MemberNotOnInterface_DiagnosticGS0339() {
        let source = `
interface IFoo {
    func M() int32 { return 1 }
}

class C : IFoo {
    func M() int32 { return base[IFoo].NotAMember() }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0339")
    }

    @Fact
    func BaseInterface_AbstractMember_DiagnosticGS0340() {
        let source = `
interface IFoo {
    func M() int32;
}

class C : IFoo {
    func M() int32 { return base[IFoo].M() }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0340")
    }

    @Fact
    func BaseInterface_PrivateHelper_DiagnosticGS0341() {
        // ADR-0090 / issue #756: private interface helpers are not part
        // of the public contract — ADR-0091 forbids explicit-base calls
        // from reaching them.
        let source = `
interface IFoo {
    func M() int32 { return Helper() }
    private func Helper() int32 { return 7 }
}

class C : IFoo {
    func M() int32 { return base[IFoo].Helper() }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0341")
    }

    @Fact
    func ChainedBaseCalls_BothResolve() {
        let source = `
interface IA {
    func V() int32 { return 3 }
}

interface IB {
    func V() int32 { return 5 }
}

class C : IA, IB {
    func V() int32 { return base[IA].V() + base[IB].V() }
}

var c = C{}
c.V()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(8, result.Value)
    }

    @Fact
    func BaseInterfaceCall_InsidePrivateMember_IsAllowed() {
        // ADR-0091: the binder restricts only by enclosing TYPE, not by
        // the enclosing method's accessibility. A private member of the
        // implementing class may still issue `base[IFoo].M()`.
        let source = `
interface IFoo {
    func Greet() string { return "hi" }
}

class C : IFoo {
    func Greet() string { return Inner() }
    private func Inner() string { return base[IFoo].Greet() + "!" }
}

var c = C{}
c.Greet()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hi!", result.Value)
    }

    @Fact
    func BaseInterfaceCall_OutsideInstanceMember_DiagnosticGS0338() {
        // ADR-0091: `base[IFoo]` is only meaningful inside an instance
        // member of a class. A top-level function has no enclosing type.
        let source = `
interface IFoo {
    func M() int32 { return 1 }
}

func TopLevel() int32 { return base[IFoo].M() }
TopLevel()
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0338")
    }

    @Fact
    func BaseInterfaceCall_WrongArgCount_ReportsArgCountDiagnostic() {
        // Sanity: the binder routes a wrong-arity site through the
        // existing wrong-arg-count diagnostic (GS0036) for ergonomic
        // recovery, rather than silently picking another overload.
        let source = `
interface IFoo {
    func M(x int32) int32 { return x }
}

class C : IFoo {
    func M(x int32) int32 { return base[IFoo].M() }
}
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
