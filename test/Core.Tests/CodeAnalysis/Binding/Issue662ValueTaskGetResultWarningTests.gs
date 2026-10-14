// <copyright file="Issue662ValueTaskGetResultWarningTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #662: warn when calling .GetAwaiter().GetResult() directly on a
/// ValueTask or ValueTask<T>.
open class Issue662ValueTaskGetResultWarningTests {
    @Fact
    func GetAwaiter_GetResult_On_ValueTask_Of_Bool_Warns_GS0275() {
        let source = `import System.Threading.Tasks

let vt = ValueTask[bool](true)
let r = vt.GetAwaiter().GetResult()`
        let diags = BindAndGetDiagnostics(source)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0275")
    }

    @Fact
    func GetAwaiter_GetResult_On_NonGeneric_ValueTask_Warns_GS0275() {
        let source = `import System.Threading.Tasks

let vt = ValueTask(Task.CompletedTask)
vt.GetAwaiter().GetResult()`
        let diags = BindAndGetDiagnostics(source)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0275")
    }

    @Fact
    func AsTask_GetAwaiter_GetResult_On_ValueTask_Does_Not_Warn() {
        let source = `import System.Threading.Tasks

let vt = ValueTask[bool](true)
let r = vt.AsTask().GetAwaiter().GetResult()`
        let diags = BindAndGetDiagnostics(source)
        Assert.DoesNotContain(diags, (d Diagnostic) -> d.Id == "GS0275")
    }

    @Fact
    func GetAwaiter_GetResult_On_Task_Of_T_Does_Not_Warn() {
        let source = `import System.Threading.Tasks

let t = Task.FromResult(42)
let r = t.GetAwaiter().GetResult()`
        let diags = BindAndGetDiagnostics(source)
        Assert.DoesNotContain(diags, (d Diagnostic) -> d.Id == "GS0275")
    }

    @Fact
    func GetAwaiter_GetResult_On_Task_Does_Not_Warn() {
        let source = `import System.Threading.Tasks

let t = Task.CompletedTask
t.GetAwaiter().GetResult()`
        let diags = BindAndGetDiagnostics(source)
        Assert.DoesNotContain(diags, (d Diagnostic) -> d.Id == "GS0275")
    }

    @Fact
    func ValueTask_Captured_In_Local_Then_GetAwaiter_GetResult_Warns() {
        let source = `import System.Threading.Tasks

let vt ValueTask[bool] = ValueTask[bool](true)
let r = vt.GetAwaiter().GetResult()`
        let diags = BindAndGetDiagnostics(source)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0275")
    }

    @Fact
    func Await_On_ValueTask_Does_Not_Warn() {
        let source = `import System.Threading.Tasks

async func doWork() bool {
    let vt = ValueTask[bool](true)
    let r = await vt
    return r
}`
        let diags = BindAndGetDiagnostics(source)
        Assert.DoesNotContain(diags, (d Diagnostic) -> d.Id == "GS0275")
    }

    @Fact
    func Warning_Message_Mentions_AsTask() {
        let source = `import System.Threading.Tasks

let vt = ValueTask[bool](true)
let r = vt.GetAwaiter().GetResult()`
        let diags = BindAndGetDiagnostics(source)
        let warning = diags.First((d Diagnostic) -> d.Id == "GS0275")
        Assert.Contains("AsTask", warning.Message)
    }

    shared {
        private func BindAndGetDiagnostics(source string) List[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            return globalScope.Diagnostics.ToList()
        }
    }
}
