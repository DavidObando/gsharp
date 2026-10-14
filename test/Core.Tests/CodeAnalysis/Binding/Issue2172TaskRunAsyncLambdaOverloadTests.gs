// <copyright file="Issue2172TaskRunAsyncLambdaOverloadTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #2172 — `Task.Run(async () -> await ...)`, where the async
/// lambda awaits a `Task[T]`, previously failed overload resolution with
/// GS0160 ("Call to 'Run' is ambiguous"). The lambda's natural type is
/// `Func<Task<T>>`, which is an identity conversion to BOTH
/// `Run<TResult>(Func<TResult>)` (TResult = Task<T>) and
/// `Run<TResult>(Func<Task<TResult>>)` (TResult = T), so
/// neither dominated on conversion kind and the call was reported ambiguous —
/// which cascaded into GS0158 on the follow-up `.Result` access. C# prefers
/// the task-returning delegate overload; gsc now applies the same betterness
/// rule (prefer `Func[Task[X]]` over `Func[X]` for a task-returning
/// lambda argument), so the call resolves to the `Func[Task[TResult]]`
/// overload with `task : Task[T]` and `task.Result : T`.
/// The rule is generalized: it is not keyed on `Task.Run` and also fires
/// for a user-defined overload set differing by `() -> X` vs
/// `() -> Task[X]`.
open class Issue2172TaskRunAsyncLambdaOverloadTests {
    @Fact
    func TaskRun_AsyncLambda_ResolvesWithoutAmbiguityOrCascade() {
        // The minimal issue repro: if resolution picked Func<TResult>
        // (TResult = Task[T]), `task` would be Task[Task[T]], `task.Result`
        // would be Task[T], and `return task.Result` (declared T) would be a
        // type error. A clean bind therefore proves the Func[Task[TResult]]
        // overload (task : Task[T], task.Result : T) was selected.
        let source = `
package R
import System.Threading.Tasks
struct S {
    func Get[T]() T {
        let task = Task.Run(async () -> await MakeAsync[T]())
        return task.Result
    }
    func MakeAsync[T]() Task[T] -> Task.FromResult(default(T)!!)
}
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func UserOverloadSet_FuncXVersusFuncTaskX_PrefersTaskReturningOverload() {
        // Generalized (NOT Task.Run): a user-defined overload set that differs
        // only by `() -> T` vs `() -> Task[T]`. The task-returning async lambda
        // must select the `() -> Task[T]` overload so `Use[T]() T` returns T.
        // If the `() -> T` overload were chosen, T would infer to Task[T] and
        // the declared `T` return would mismatch.
        let source = `
package R
import System.Threading.Tasks
struct S {
    func Wrap[T](f () -> T) T -> f()
    func Wrap[T](f () -> Task[T]) T -> f().Result
    func Use[T]() T {
        let r = Wrap(async () -> await MakeAsync[T]())
        return r
    }
    func MakeAsync[T]() Task[T] -> Task.FromResult(default(T)!!)
}
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func NonAsyncLambda_StillResolvesValueReturningOverload() {
        // Guard: a plain (non-task) lambda must keep binding to the `() -> T`
        // overload — the new betterness rule must not disturb it.
        let source = `
package R
struct S {
    func Wrap[T](f () -> T) T -> f()
    func Wrap[T](f () -> S) S -> f()
    func Use() int32 {
        let r = Wrap(() -> 42)
        return r
    }
}
`
        AssertBindsWithoutErrors(source)
    }

    shared {
        private func AssertBindsWithoutErrors(source string) {
            let paths = List[string]()
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if !string.IsNullOrEmpty(tpa) {
                for p in tpa.Split(Path.PathSeparator) {
                    if !string.IsNullOrWhiteSpace(p) && File.Exists(p) {
                        paths.Add(p)
                    }
                }
            }
            using let resolver = ReferenceResolver.WithReferences(paths)
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree), resolver)
            let program = Binder.BindProgram(globalScope, resolver)
            let diagnostics = globalScope.Diagnostics.AddRange(program.Diagnostics)
            Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        }
    }
}
