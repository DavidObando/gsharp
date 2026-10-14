// <copyright file="Issue1071AsyncOverrideTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #1071: the override-matching and interface-satisfaction comparisons
/// must use a method's <em>effective</em> (post-async-normalization) return
/// type. An `async func M()` with no annotation has effective return type
/// `Task`; `async func M() T` has effective return type `Task[T]`.
/// Previously the comparison used the declared return type, so an async
/// override of `func M() Task` tripped GS0185 and an async implementation
/// of an interface `func M() Task;` tripped GS0187. Genuine return-type
/// mismatches must still be rejected.
open class Issue1071AsyncOverrideTests {
    @Fact
    func AsyncOverride_OfTaskReturningBaseMethod_BindsWithoutDiagnostics() {
        const source = `package p
import System.Threading.Tasks
open class Base {
    protected open func DoAsync() Task;
}
open class Derived : Base {
    protected override async func DoAsync() {
        await Task.CompletedTask
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func NonAsyncControl_TaskReturningOverride_BindsWithoutDiagnostics() {
        // The semantically identical non-async override (already accepted) — the
        // only difference from the async case is async-return normalization.
        const source = `package p
import System.Threading.Tasks
open class Base {
    protected open func DoAsync() Task;
}
open class Derived : Base {
    protected override func DoAsync() Task {
        return Task.CompletedTask
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func AsyncImplementation_OfTaskReturningInterfaceMethod_BindsWithoutDiagnostics() {
        const source = `package p
import System.Threading
import System.Threading.Tasks
interface I { func RunAsync(c CancellationTokenSource) Task; }
class C : I {
    async func RunAsync(c CancellationTokenSource) { await Task.CompletedTask }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func AsyncValueOverride_OfGenericTaskReturningBaseMethod_BindsWithoutDiagnostics() {
        const source = `package p
import System.Threading.Tasks
open class Base {
    protected open func GetAsync() Task[int32];
}
open class Derived : Base {
    protected override async func GetAsync() int32 {
        await Task.CompletedTask
        return 5
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func AsyncValueImplementation_OfGenericTaskReturningInterfaceMethod_BindsWithoutDiagnostics() {
        const source = `package p
import System.Threading.Tasks
interface I { func GetAsync() Task[int32]; }
class C : I {
    async func GetAsync() int32 {
        await Task.CompletedTask
        return 7
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func AsyncTaskOverride_OfGenericTaskBaseMethod_StillReportsGS0185() {
        // Genuine return-type mismatch: effective Task vs base Task[int32].
        const source = `package p
import System.Threading.Tasks
open class Base {
    protected open func DoAsync() Task[int32];
}
open class Derived : Base {
    protected override async func DoAsync() {
        await Task.CompletedTask
    }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Id == "GS0185")
    }

    @Fact
    func AsyncTaskImplementation_OfGenericTaskInterfaceMethod_StillReportsGS0187() {
        // Genuine return-type mismatch: effective Task vs interface Task[int32].
        const source = `package p
import System.Threading.Tasks
interface I { func RunAsync() Task[int32]; }
class C : I {
    async func RunAsync() { await Task.CompletedTask }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Id == "GS0187")
    }

    @Fact
    func AsyncVoidOverride_OfVoidBaseMethod_BindsWithoutDiagnostics() {
        const source = `package p
import System.Threading.Tasks
open class Base {
    protected open func OnOpened() { }
}
open class Derived : Base {
    protected override async func OnOpened() void {
        await Task.CompletedTask
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func AsyncTaskOverride_OfVoidBaseMethod_StillReportsGS0185() {
        const source = `package p
import System.Threading.Tasks
open class Base {
    protected open func OnOpened() { }
}
open class Derived : Base {
    protected override async func OnOpened() {
        await Task.CompletedTask
    }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Id == "GS0185")
    }

    @Fact
    func AsyncVoidImplementation_OfVoidInterfaceMethod_BindsWithoutDiagnostics() {
        const source = `package p
import System.Threading.Tasks
interface I { func Handle(); }
class C : I {
    async func Handle() void {
        await Task.CompletedTask
    }
}`
        Assert.Empty(Bind(source))
    }

    shared {
        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.GlobalScope.Diagnostics.ToList()
        }
    }
}
