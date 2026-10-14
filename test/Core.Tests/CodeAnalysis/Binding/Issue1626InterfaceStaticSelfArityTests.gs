// <copyright file="Issue1626InterfaceStaticSelfArityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1626: an unqualified (bare-name) call inside a static-virtual /
/// private-static interface helper body to a sibling static method with a
/// SINGLE overload skipped arity/named-argument validation entirely —
/// (cref:OverloadResolver.SelectInstanceOverloadOrReport) returns a
/// lone candidate unchecked, and the interface static-self dispatch path then
/// indexed the callee's parameter list positionally. Too many arguments threw
/// an unhandled (cref:System.IndexOutOfRangeException) (compiler
/// crash); too few silently built an invalid, under-sized
/// (cref:BoundCallExpression). Both must now report the standard
/// "wrong number of arguments" diagnostic instead.
open class Issue1626InterfaceStaticSelfArityTests {
    @Fact
    func StaticSelfCall_TooManyArguments_ReportsDiagnostic_NoCrash() {
        let source = `
package p
interface ICalc {
    shared {
        func Caller() int32 { return Helper(1, 2) }
        private func Helper(x int32) int32 { return x }
    }
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func StaticSelfCall_TooFewArguments_ReportsDiagnostic_NoCrash() {
        let source = `
package p
interface ICalc {
    shared {
        func Caller() int32 { return Helper() }
        private func Helper(x int32) int32 { return x }
    }
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func StaticSelfCall_NamedArgumentsOutOfOrder_BindsCorrectly() {
        let source = `
package p
interface ICalc {
    shared {
        func Caller() int32 { return Helper(b: 2, a: 1) }
        private func Helper(a int32, b int32) int32 { return a - b }
    }
}
`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func StaticSelfCall_CorrectArity_StillResolves() {
        let source = `
package p
interface ICalc {
    shared {
        func Caller() int32 { return Helper(1) }
        private func Helper(x int32) int32 { return x }
    }
}
`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(
                previous: nil,
                ImmutableArray.Create(tree),
                ReferenceResolver.Default()
            )
            let program = Binder.BindProgram(globalScope, ReferenceResolver.Default())
            return globalScope.Diagnostics.AddRange(program.Diagnostics)
        }
    }
}
