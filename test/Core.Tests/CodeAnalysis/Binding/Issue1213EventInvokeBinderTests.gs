// <copyright file="Issue1213EventInvokeBinderTests.cs" company="GSharp">
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

/// Issue #1213: an `event` member can be declared on a class but could not
/// be referenced or invoked in expression position. A bare reference reported
/// `GS0125` ("Variable 'X' doesn't exist") and a `this.`-qualified
/// reference reported `GS0158` ("Cannot find member"). Inside the declaring
/// type, an event must bind to its private backing delegate field so the
/// canonical raise pattern `MyEvent?.Invoke(args)` resolves and emits.
open class Issue1213EventInvokeBinderTests {
    @Fact
    func BareEventReference_NullConditionalInvoke_Binds() {
        const source = `package p
class C {
    event ChapterRead (object?, int32) -> void
    func Fire(x int32) { ChapterRead?.Invoke(this, x) }
}`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Empty(diagnostics)
    }

    @Fact
    func QualifiedEventReference_NullConditionalInvoke_Binds() {
        const source = `package p
class C {
    event ChapterRead (object?, int32) -> void
    func Fire(x int32) { this.ChapterRead?.Invoke(this, x) }
}`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Empty(diagnostics)
    }

    @Fact
    func EventReference_DirectInvoke_AfterNilCheck_Binds() {
        const source = `package p
class C {
    event ChapterRead (object?, int32) -> void
    func Fire(x int32) {
        if ChapterRead != nil {
            ChapterRead.Invoke(this, x)
        }
    }
}`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func VoidDelegateEvent_NoArgs_Binds() {
        const source = `package p
class C {
    event Ping () -> void
    func FirePing() { Ping?.Invoke() }
}`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func MultiArgEvent_NullConditionalInvoke_Binds() {
        const source = `package p
class C {
    event Multi (int32, string, bool) -> void
    func FireMulti(n int32, s string, b bool) { this.Multi?.Invoke(n, s, b) }
}`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics)
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
