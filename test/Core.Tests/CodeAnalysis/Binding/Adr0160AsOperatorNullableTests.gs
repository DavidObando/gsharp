// <copyright file="Adr0160AsOperatorNullableTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0160 / issue #3349: `as` is a testing conversion — it yields nil when
/// the runtime type does not match — so `x as T` has type `T?`, not
/// `T`.
///
/// Typing it `T` let `let s string = o as string` bind, silently putting a
/// possibly-nil value into a non-nullable local, and it made ADR-0071's
/// `if let` / `guard let` reject the idiomatic
/// `if let s = x as T` with GS0296 (the initializer looked non-nullable, so the
/// binding had "nothing to strip").
open class Adr0160AsOperatorNullableTests {
    @Fact
    func AsResult_AssignedToNonNullableLocal_Diagnoses_GS0155() {
        // The whole point of the ADR: this used to bind, and was unsafe.
        let diagnostics = Bind(`
func Run(o object) int32 {
    let s string = o as string
    return s.Length
}
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func AsResult_AssignedToNullableLocal_Binds() {
        let diagnostics = Bind(`
func Run(o object) int32 {
    let s string? = o as string
    if s != nil {
        return s.Length
    }
    return 0
}
`)
        Assert.Empty(diagnostics)
    }

    /// The reason the ADR exists: the canonical narrowing form over a testing
    /// conversion. Rejected with GS0296 before the change.
    @Fact
    func IfLet_OverAsExpression_Binds() {
        let diagnostics = Bind(`
func Run(o object) int32 {
    if let s = o as string {
        return s.Length
    }
    return 0
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func GuardLet_OverAsExpression_Binds() {
        let diagnostics = Bind(`
func Run(o object) int32 {
    guard let s = o as string else { return 0 }
    return s.Length
}
`)
        Assert.Empty(diagnostics)
    }

    /// An already-nullable target must not be double-wrapped into `T??`.
    @Fact
    func AsNullableTarget_IsNotDoubleWrapped() {
        let diagnostics = Bind(`
func Run(o object) int32 {
    let s string? = o as string?
    if let v = s {
        return v.Length
    }
    return 0
}
`)
        Assert.Empty(diagnostics)
    }

    /// A non-nullable value-type target stays illegal — `as` must be able to
    /// yield nil. This rule predates the ADR and now reads consistently with the
    /// result type.
    @Fact
    func AsNonNullableValueTypeTarget_StillRejected() {
        let diagnostics = Bind(`
func Run(o object) int32 {
    let n = o as int32
    return 0
}
`)
        Assert.NotEmpty(diagnostics)
    }

    /// `x as T ?? fallback` previously produced a BARE type-parameter LHS, which
    /// issue #1516 added dedicated emit paths for. It now produces
    /// `NullableTypeSymbol(T)` and routes through the pre-existing issue-#831
    /// probe instead; both must keep binding.
    @Fact
    func AsResult_CoalescedWithFallback_Binds() {
        let diagnostics = Bind(`
func Run(o object) string {
    return (o as string) ?? "fallback"
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func AsResult_NullAssertedAfterTest_Binds() {
        let diagnostics = Bind(`
func Run(o object) int32 {
    if o is string {
        return (o as string)!!.Length
    }
    return 0
}
`)
        Assert.Empty(diagnostics)
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            let program = Binder.BindProgram(globalScope)
            return program.Diagnostics.ToImmutableArray()
        }
    }
}
