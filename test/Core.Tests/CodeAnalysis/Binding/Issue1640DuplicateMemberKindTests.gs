// <copyright file="Issue1640DuplicateMemberKindTests.cs" company="GSharp">
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

/// Issue #1640: duplicate-member detection must reject a name collision
/// across DIFFERENT member kinds (field/method/property/event), not just
/// within the same kind. Legitimate method overloads (same name, different
/// signature — including an instance/shared pair per issue #1147) must keep
/// binding clean.
open class Issue1640DuplicateMemberKindTests {
    @Fact
    func PropertyDuplicatingMethodName_IsReported() {
        let source = `package p
class C {
    func Foo() int32 { return 1 }
    prop Foo int32 { get { return 1 } }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Message.Contains("Foo"))
    }

    @Fact
    func MethodDuplicatingPropertyName_IsReported() {
        let source = `package p
class C {
    prop Foo int32 { get { return 1 } }
    func Foo() int32 { return 1 }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Message.Contains("Foo"))
    }

    @Fact
    func EventDuplicatingMethodName_IsReported() {
        let source = `package p
class C {
    func Foo() int32 { return 1 }
    event Foo () -> void
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Message.Contains("Foo"))
    }

    @Fact
    func SharedFieldDuplicatingInstanceMethodName_IsReported() {
        let source = `package p
class C {
    func Foo() int32 { return 1 }
    shared {
        var Foo int32 = 0
    }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Message.Contains("Foo"))
    }

    @Fact
    func SharedPropertyDuplicatingSharedMethodName_IsReported() {
        let source = `package p
class C {
    shared {
        func Foo() int32 { return 1 }
        prop Foo int32 { get { return 1 } }
    }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Message.Contains("Foo"))
    }

    @Fact
    func InstanceAndSharedMethodOverload_SameName_BindsClean() {
        // Issue #1147: an instance method and a `shared` (static) method may
        // legitimately share a name — this is an overload, not a duplicate.
        let source = `package p
class C {
    func Foo(x int32) int32 { return x }
    shared {
        func Foo(x string) int32 { return 0 }
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func DistinctMemberNames_BindClean() {
        let source = `package p
class C {
    var Field int32 = 0
    prop Prop int32 { get { return 1 } }
    func Method() int32 { return 1 }
    event Evt () -> void
}`
        Assert.Empty(Bind(source))
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
