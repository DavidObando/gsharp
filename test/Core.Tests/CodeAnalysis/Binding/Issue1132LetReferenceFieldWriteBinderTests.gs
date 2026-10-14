// <copyright file="Issue1132LetReferenceFieldWriteBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1132: `let` communicates immutability of the <em>binding</em>
/// (shallow / readonly-reference semantics). Writing a field or property of a
/// <em>reference-type</em> object held by a `let` local mutates the heap
/// object, not the binding, so it must be allowed; only the binding itself
/// (`b = other`) and member writes through a <em>value-type</em> `let`
/// local (which would mutate the value in the read-only slot) stay rejected
/// with `GS0127`.
open class Issue1132LetReferenceFieldWriteBinderTests {
    @Fact
    func LetClassLocal_FieldWrite_Allowed() {
        // Acceptance #1: `let b = Box{}; b.Value = 5` (class receiver).
        const source = `package p
class Box { var Value int32 = 0 }
class C {
    func F() int32 {
        let b = Box{ }
        b.Value = 5
        return b.Value
    }
}`
        Assert.DoesNotContain(Bind(source), (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func LetClassLocal_PropertyWrite_Allowed() {
        // Acceptance #2: property write through a `let` class local.
        const source = `package p
class Box {
    var _v int32 = 0
    prop Value int32 {
        get { return _v }
        set { _v = value }
    }
}
class C {
    func F() int32 {
        let b = Box{ }
        b.Value = 5
        return b.Value
    }
}`
        Assert.DoesNotContain(Bind(source), (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func LetClassLocal_CompoundFieldWrite_Allowed() {
        // Acceptance #3: `let b = Counter{}; b.Value += 1` (class receiver).
        const source = `package p
class Counter { var Value int32 = 0 }
class C {
    func F() int32 {
        let b = Counter{ }
        b.Value += 1
        return b.Value
    }
}`
        Assert.DoesNotContain(Bind(source), (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func LetClassLocal_IncrementFieldWrite_Allowed() {
        // Acceptance #3: `let b = Counter{}; b.Value++` (class receiver).
        const source = `package p
class Counter { var Value int32 = 0 }
class C {
    func F() int32 {
        let b = Counter{ }
        b.Value++
        return b.Value
    }
}`
        Assert.DoesNotContain(Bind(source), (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func LetStructLocal_FieldWrite_Rejected() {
        // Acceptance #4: a value-type (struct) receiver stays rejected.
        const source = `package p
struct S { var Value int32 }
class C {
    func F() int32 {
        let s = S{ Value: 1 }
        s.Value = 5
        return s.Value
    }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func LetStructLocal_PropertyWrite_Rejected() {
        // Acceptance #4: struct property write through a `let` struct local.
        const source = `package p
struct S {
    var _v int32
    prop Value int32 {
        get { return _v }
        set { _v = value }
    }
}
class C {
    func F() int32 {
        let s = S{ }
        s.Value = 5
        return s.Value
    }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func LetStructLocal_CompoundFieldWrite_Rejected() {
        // Acceptance #4: struct compound write through a `let` struct local.
        const source = `package p
struct S { var Value int32 }
class C {
    func F() int32 {
        let s = S{ Value: 1 }
        s.Value += 1
        return s.Value
    }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func LetStructLocal_IncrementFieldWrite_Rejected() {
        // Acceptance #4: struct increment through a `let` struct local.
        const source = `package p
struct S { var Value int32 }
class C {
    func F() int32 {
        let s = S{ Value: 1 }
        s.Value++
        return s.Value
    }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func LetClassLocal_Rebind_Rejected() {
        // Acceptance #5: direct rebinding of a `let` class local stays rejected.
        const source = `package p
class Box { var Value int32 = 0 }
class C {
    func F() int32 {
        let b = Box{ }
        b = Box{ }
        return b.Value
    }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func LetStructLocal_Rebind_Rejected() {
        // Acceptance #5: direct rebinding of a `let` struct local stays rejected.
        const source = `package p
struct S { var Value int32 }
class C {
    func F() int32 {
        let s = S{ Value: 1 }
        s = S{ Value: 2 }
        return s.Value
    }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func VarClassLocal_FieldWrite_StillAllowed() {
        // Acceptance #7 (no regression): `var b` field writes are unaffected.
        const source = `package p
class Box { var Value int32 = 0 }
class C {
    func F() int32 {
        var b = Box{ }
        b.Value = 5
        return b.Value
    }
}`
        Assert.DoesNotContain(Bind(source), (d Diagnostic) -> d.Id == "GS0127")
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
