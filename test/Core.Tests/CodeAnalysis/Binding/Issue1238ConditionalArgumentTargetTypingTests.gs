// <copyright file="Issue1238ConditionalArgumentTargetTypingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #1238: an `if`/`else` (conditional), ternary, or
/// switch-expression used directly as a CALL ARGUMENT must be target-typed to
/// the corresponding parameter type — the same target-typing path already used
/// for `return` statements and typed `let`. Previously the argument's
/// branches were unified in isolation, so a `nil` (or narrower) branch
/// failed to widen to the parameter's nullable type with GS0155. These tests
/// pin the fixed behavior for call, constructor, and nested-call arguments,
/// and confirm genuine no-common-type errors are still reported.
open class Issue1238ConditionalArgumentTargetTypingTests {
    @Fact
    func IfExpressionArgument_NilBranch_TargetTypedToParameter() {
        const Source = `package Issue1238.IfArg

class C {
    func Sink(data string?) { }
    func Call(s string?) {
        Sink(if s == nil { nil } else { s!! })
    }
}
`
        Assert.Empty(EmitDiagnostics(Source).Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func IfExpressionArgument_AmongOtherArguments_TargetTypedToParameter() {
        const Source = `package Issue1238.IfArgMulti

import System.Text

class C {
    func Sink(name string, data []?uint8) { }
    func Call(data string?) {
        Sink("x", if data == nil { nil } else { Encoding.UTF8.GetBytes(data!!) })
    }
}
`
        Assert.Empty(EmitDiagnostics(Source).Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func TernaryArgument_NilBranch_TargetTypedToParameter() {
        const Source = `package Issue1238.TernaryArg

class C {
    func Sink(data string?) { }
    func Call(s string?) {
        Sink(s == nil ? nil : s!!)
    }
}
`
        Assert.Empty(EmitDiagnostics(Source).Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func SwitchExpressionArgument_NilArm_TargetTypedToParameter() {
        const Source = `package Issue1238.SwitchArg

class C {
    func Sink(data string?) { }
    func Call(n int32) {
        Sink(switch n { case 0: nil default: "x" })
    }
}
`
        Assert.Empty(EmitDiagnostics(Source).Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func ConstructorArgument_IfExpressionNilBranch_TargetTypedToParameter() {
        const Source = `package Issue1238.CtorArg

class Holder {
    init(name string, data string?) { }
}

class C {
    func Make(s string?) Holder {
        return Holder("n", if s == nil { nil } else { s!! })
    }
}
`
        Assert.Empty(EmitDiagnostics(Source).Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func NestedCallArgument_IfExpressionNilBranch_TargetTypedToParameter() {
        const Source = `package Issue1238.NestedArg

class C {
    func Sink(data string?) { }
    func Wrap(s string?) string? { return s }
    func Call(s string?) {
        Sink(Wrap(if s == nil { nil } else { s!! }))
    }
}
`
        Assert.Empty(EmitDiagnostics(Source).Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func ReturnAndTypedLetPositions_StillBindCleanly() {
        // Regression guard: the positions that already worked must keep working.
        const Source = `package Issue1238.AlreadyOk

import System.Text

class C {
    func R(data string?) []?uint8 {
        return if data == nil { nil } else { Encoding.UTF8.GetBytes(data!!) }
    }
    func L(data string?) []?uint8 {
        let r []?uint8 = if data == nil { nil } else { Encoding.UTF8.GetBytes(data!!) }
        return r
    }
    func Sink(data []?uint8) { }
    func PlainNil() { Sink(nil) }
}
`
        Assert.Empty(EmitDiagnostics(Source).Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func OverloadResolution_WithIfExpressionArgument_NotRegressed() {
        // The if-expression arms unify naturally to int32 and must still select
        // the int32 overload (defer path is not engaged for a clean unification).
        const Source = `package Issue1238.Overload

class C {
    func F(x int32) string { return "int" }
    func F(x string) string { return "str" }
    func Pick(b bool) string {
        return F(if b { 1 } else { 2 })
    }
}
`
        Assert.Empty(EmitDiagnostics(Source).Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func GenuineNoCommonTypeArgument_StillReportsError() {
        // Neither branch is convertible to the other or to the parameter type;
        // the error must surface (not be swallowed by the defer mechanism).
        const Source = `package Issue1238.BadArg

class C {
    func Sink(data string?) { }
    func Call(b bool) {
        Sink(if b { 1 } else { 2 })
    }
}
`
        Assert.Contains(EmitDiagnostics(Source), (d Diagnostic) -> d.IsError && d.Id == "GS0154")
    }

    @Fact
    func UntypedLetWithNoCommonType_StillReportsError() {
        // Outside argument position the defer flag is never set, so an untyped
        // local with mismatched branches keeps reporting immediately.
        const Source = `package Issue1238.UntypedLet

class C {
    func Call(b bool) {
        let x = if b { 1 } else { "s" }
    }
}
`
        Assert.Contains(EmitDiagnostics(Source), (d Diagnostic) -> d.IsError && d.Id == "GS0263")
    }

    shared {
        private func EmitDiagnostics(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation.Emit(peStream).Diagnostics
        }
    }
}
