// <copyright file="Issue1154NullableWideningOverloadTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #1154. Overload resolution must not report a spurious GS0266
/// ambiguity when an argument needs an implicit nullable-widening conversion
/// (T → T?) to match the ONLY applicable candidate while a second, wholly
/// non-applicable overload (e.g. F(string) for a []uint8 argument) also exists.
/// Phase-1 arity/name applicability is convertibility-unaware, so the
/// non-applicable overload used to tie with — and thus be reported ambiguous
/// against — the unique applicable nullable-widening overload. A
/// convertibility-aware filter now excludes non-convertible candidates so the
/// unique applicable overload binds without a diagnostic, while genuine
/// ambiguity and genuine no-applicable-overload cases still report.
open class Issue1154NullableWideningOverloadTests {
    @Fact
    func Repro_NullableWidening_UniqueApplicable_BindsWithoutGS0266() {
        // REPRO: F(string), F([]?uint8); arg is non-nullable []uint8.
        // Only F([]?uint8) is applicable ([]uint8 -> []?uint8 implicit widening).
        const source = `
package p
class C {
    shared { func Make() []uint8 { var r []uint8 return r } }
    func F(a string) { F(C.Make()) }
    func F(a []?uint8) { var n = 1 }
}
`
        // Binder-inspection test (issue #3176 Phase 3b.2): bind via
        // EmittedOracle.CompileDiagnostics and inspect this Compilation's
        // bound state (FindCall); nothing needs to run.
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0266")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        let selected FunctionSymbol? = FindCall(compilation, "F", "F")
        Assert.NotNull(selected)
        let param = selected!!.Parameters.Last()
        Assert.IsType[NullableTypeSymbol](param.Type)
    }

    @Fact
    func VariantA_ExactMatch_StillBinds() {
        // F(string), F([]uint8); arg []uint8 -> exact match to F([]uint8).
        const source = `
package p
class C {
    shared { func Make() []uint8 { var r []uint8 return r } }
    func F(a string) { F(C.Make()) }
    func F(a []uint8) { var n = 1 }
}
`
        // Binder-inspection test (issue #3176 Phase 3b.2): bind via
        // EmittedOracle.CompileDiagnostics and inspect this Compilation's
        // bound state (FindCall); nothing needs to run.
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0266")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        let selected FunctionSymbol? = FindCall(compilation, "F", "F")
        Assert.NotNull(selected)
        let param = selected!!.Parameters.Last()
        Assert.IsNotType[NullableTypeSymbol](param.Type)
    }

    @Fact
    func VariantB_NullableWideningOnly_StillBinds() {
        // F([]?uint8) only; arg []uint8 -> nullable widening applicable.
        const source = `
package p
class C {
    shared { func Make() []uint8 { var r []uint8 return r } }
    func F(a []?uint8) { F(C.Make()) }
}
`
        // Binder-inspection test (issue #3176 Phase 3b.2): bind via
        // EmittedOracle.CompileDiagnostics and inspect this Compilation's
        // bound state (FindCall); nothing needs to run.
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0266")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        let selected FunctionSymbol? = FindCall(compilation, "F", "F")
        Assert.NotNull(selected)
        let param = selected!!.Parameters.Last()
        Assert.IsType[NullableTypeSymbol](param.Type)
    }

    @Fact
    func VariantC_ExactNullableMatch_StillBinds() {
        // F(string), F([]?uint8); arg is []?uint8 -> exact match to T?.
        const source = `
package p
class C {
    shared { func Make() []?uint8 { var r []?uint8 return r } }
    func F(a string) { F(C.Make()) }
    func F(a []?uint8) { var n = 1 }
}
`
        // Binder-inspection test (issue #3176 Phase 3b.2): bind via
        // EmittedOracle.CompileDiagnostics and inspect this Compilation's
        // bound state (FindCall); nothing needs to run.
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0266")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        let selected FunctionSymbol? = FindCall(compilation, "F", "F")
        Assert.NotNull(selected)
        let param = selected!!.Parameters.Last()
        Assert.IsType[NullableTypeSymbol](param.Type)
    }

    @Fact
    func GenuineAmbiguity_StillReportsGS0266() {
        // Argument `Both` converts (implicitly) to both IA and IB equally; the
        // two non-generic overloads genuinely tie. Must still report GS0266.
        const source = `
package p
interface IA {}
interface IB {}
class Both : IA, IB {}
class Factory {
    shared {
        func Take(x IA) int32 { return 1 }
        func Take(x IB) int32 { return 2 }
    }
}
class C {
    func G(b Both) {
        let x = Factory.Take(b)
    }
}
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0266")
    }

    @Fact
    func NoApplicableOverload_StillReports_NotGS0266() {
        // F(string) only; arg []uint8 -> no applicable overload. Must report a
        // diagnostic (not GS0266, not a crash).
        const source = `
package p
class C {
    shared { func Make() []uint8 { var r []uint8 return r } }
    func F(a string) { F(C.Make()) }
}
`
        // Binder-diagnostics test over a library compilation (issue #3176
        // Phase 3b.2): bind via EmittedOracle.CompileDiagnostics.
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree){IsLibrary = true}
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.NotEmpty(diagnostics)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0266")
    }

    private class CallCollector : BoundTreeWalker {
        private let callName string

        init(callName string) {
            Collected = List[FunctionSymbol]()
            this.callName = callName
        }

        prop Collected List[FunctionSymbol] {
            get;
        }

        override func VisitExpression(node BoundExpression) {
            switch node {
                case call is BoundCallExpression when call.Function.Name == callName {
                    Collected.Add(call.Function)
                }
                case instanceCall is BoundUserInstanceCallExpression when instanceCall.Method.Name == callName {
                    Collected.Add(instanceCall.Method)
                }
            }
            base.VisitExpression(node)
        }
    }

    shared {
        private func Compile(source string) Compilation {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Compilation(tree){IsLibrary = true}
        }

        private func FindCall(
            compilation Compilation,
            functionName string,
            callName string
        ) FunctionSymbol? -> FindCalls(compilation, functionName, callName).FirstOrDefault()

        private func FindCalls(compilation Compilation, functionName string, callName string) List[FunctionSymbol] {
            let collector = Issue1154NullableWideningOverloadTests.CallCollector(callName)
            for body in compilation.BoundProgram.Functions.Values {
                collector.Visit(body)
            }
            return collector.Collected
        }
    }
}
