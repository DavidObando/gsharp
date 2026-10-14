// <copyright file="Adr0174AsyncLetBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0174 D15, the rules around the `async let` binding: it needs a
/// `scope` to own it (GS0551), every read is spelled `await`
/// (GS0569), and a binding nobody reads had its work started only to be
/// cancelled (GS0559). The binding's type is the child's result, never a
/// handle, which is what makes a spawn unable to outlive its owner.
/// @remarks Discrimination witness (ADR-0154): GS0569 is enforced twice, and both are
/// needed. A mutant that keeps only the name-resolution check breaks
/// (cref:ReadInAReceiverPosition_ReportsGS0569), because a receiver
/// resolves the symbol through a different path; a mutant that keeps only the
/// walk over the bound block still reports, but at the declaration rather than
/// the read, which (cref:BareRead_ReportsGS0569_AtTheRead) pins.
open class Adr0174AsyncLetBindingTests {
    @Fact
    func OutsideAScope_ReportsGS0551() {
        let diagnostics = Compile(`package P
func work() int32 {
    return 1
}

async let stray = work()`)
        let diagnostic = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0551")
        Assert.Equal(DiagnosticSeverity.Error, diagnostic.Severity)
    }

    @Fact
    func InsideAScope_IsAccepted() {
        let diagnostics = Compile(`package P
func work() int32 {
    return 1
}

scope {
    async let v = work()
    let n = await v
}`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func BareRead_ReportsGS0569_AtTheRead() {
        let diagnostics = Compile(`package P
func work() int32 {
    return 1
}

scope {
    async let v = work()
    let copy = v
}`)
        let diagnostic = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0569")
        Assert.Equal(DiagnosticSeverity.Error, diagnostic.Severity)
        Assert.Contains("'v'", diagnostic.Message)
        Assert.Equal(8, diagnostic.Location.StartLine + 1)
    }

    @Fact
    func ReadInAReceiverPosition_ReportsGS0569() {
        let diagnostics = Compile(`package P
func work() int32 {
    return 1
}

scope {
    async let v = work()
    let text = v.ToString()
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0569")
    }

    @Fact
    func NeverAwaited_ReportsGS0559() {
        let diagnostics = Compile(`package P
func work() int32 {
    return 1
}

scope {
    async let unused = work()
}`)
        let diagnostic = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0559")
        Assert.Equal(DiagnosticSeverity.Warning, diagnostic.Severity)
        Assert.Contains("'unused'", diagnostic.Message)
    }

    @Fact
    func AwaitedOnce_DoesNotReportGS0559() {
        let diagnostics = Compile(`package P
func work() int32 {
    return 1
}

scope {
    async let used = work()
    let n = await used
}`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0559")
    }

    @Fact
    func TheBindingIsTypedAsTheChildsResult() {
        // The binding names `R`, not a task: `await text` is a `string`, and
        // assigning it to an `int32` is an ordinary conversion error rather
        // than a complaint about a `ValueTask`.
        let diagnostics = Compile(`package P
func work() string {
    return "hi"
}

scope {
    async let text = work()
    let n int32 = await text
}`)
        let diagnostic = Assert.Single(diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Contains("string", diagnostic.Message)
        Assert.DoesNotContain("ValueTask", diagnostic.Message)
    }

    @Fact
    func ANestedScopeOwnsItsOwnBindings() {
        // The outer block's GS0559 walk must not claim the inner block's
        // binding, and vice versa.
        let diagnostics = Compile(`package P
func work() int32 {
    return 1
}

scope {
    async let outer = work()
    scope {
        async let inner = work()
        let a = await inner
    }

    let b = await outer
}`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0559")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0569")
    }

    shared {
        private func Compile(source string) ImmutableArray[Diagnostic] -> EmittedOracle.CompileDiagnostics(
            Compilation(SyntaxTree.Parse(source))
        )
    }
}
