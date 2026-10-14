// <copyright file="Issue1316AssignmentTargetTypeTests.cs" company="GSharp">
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

/// Issue #1316: a simple-assignment statement `lhs = rhs` must propagate
/// the declared type of `lhs` (a property/field/local of type `T?`)
/// as the target/expected type when binding `rhs`. Without this, a
/// conditional/if-expression with a `nil` arm and a `T` arm binds
/// context-free, picks `T` from the non-nil arm, and rejects the
/// `nil` arm with `GS0155` — even though the identical RHS bound
/// through `let x T? = rhs` (which does receive the target type) compiles
/// cleanly. The target type must flow into the assignment RHS the same way.
open class Issue1316AssignmentTargetTypeTests {
    @Fact
    func PropertyAssignment_ConditionalWithNilArm_NoDiagnostics() {
        // Acceptance (a): the issue repro — `A = if c { nil } else { T(...) }`
        // where `A : AesCtr?` must bind clean (previously GS0155).
        const source = `package p
class AesCtr { init(k []uint8) {} }
class C {
    init(key []uint8) {
        A = if key.Length == 0 { nil } else { AesCtr(key) }
    }
    prop A AesCtr? { get; init; }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func BareFieldAssignment_ConditionalWithNilArm_NoDiagnostics() {
        // Acceptance (b): bare field-name assignment variant.
        const source = `package p
class AesCtr { init(k []uint8) {} }
class C {
    var f AesCtr?
    init(key []uint8) {
        f = if key.Length == 0 { nil } else { AesCtr(key) }
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func DottedFieldAssignment_ConditionalWithNilArm_NoDiagnostics() {
        // Acceptance (b): `this.f = ...` dotted field-write variant.
        const source = `package p
class AesCtr { init(k []uint8) {} }
class C {
    var f AesCtr?
    init(key []uint8) {
        this.f = if key.Length == 0 { nil } else { AesCtr(key) }
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func LocalAssignment_ConditionalWithNilArm_NoDiagnostics() {
        // Acceptance (b): local-variable assignment variant.
        const source = `package p
class AesCtr { init(k []uint8) {} }
class C {
    func F(key []uint8) {
        var a AesCtr? = nil
        a = if key.Length == 0 { nil } else { AesCtr(key) }
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func PropertyAssignment_IncompatibleValue_StillErrors() {
        // Acceptance (c): a genuinely-incompatible assignment (`A = 5` for
        // `A : AesCtr?`) must STILL report GS0155.
        const source = `package p
class AesCtr { init(k []uint8) {} }
class C {
    init(key []uint8) {
        A = 5
    }
    prop A AesCtr? { get; init; }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func LetInitializer_ConditionalWithNilArm_StillBinds() {
        // Acceptance (d): the pre-existing `let x T? = if ... nil ...` control
        // must keep binding cleanly (the path the fix mirrors).
        const source = `package p
class AesCtr { init(k []uint8) {} }
class C {
    init(key []uint8) {
        let a AesCtr? = if key.Length == 0 { nil } else { AesCtr(key) }
    }
}`
        Assert.Empty(Bind(source))
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            let program = Binder.BindProgram(globalScope)
            return program.Diagnostics.ToImmutableArray()
        }
    }
}
