// <copyright file="Issue2195TaskRunAsyncLambdaInferenceTests.cs" company="GSharp">
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

/// Issue #2195 — inferring a generic method's type argument from an ASYNC
/// lambda argument whose body `await`s a generic awaitable.
///
/// `Task.Run(async () -> await Inner[T]())`, where `Inner[T]`
/// returns `ValueTask[T]`, inferred `TResult = object` instead of
/// `T`: the awaited element type of the `ValueTask[T]` was recovered
/// from the awaiter's CLR `GetResult()` return type, which is erased to
/// `object` for a same-compilation user type / open type parameter. The
/// async lambda's return type therefore inferred as `Task[object]`, fixing
/// `Task.Run`'s `TResult` to `object`, and `task.Result`
/// (`object`) failed to convert to the declared `T` (GS0156).
///
/// The fix recovers the awaited element type from the awaitable's SYMBOLIC
/// type argument. It is generalized to every generic awaitable whose
/// `GetResult()` surfaces the awaitable's own type parameter — covering
/// both `Task[U]` and `ValueTask[U]`, for any element type `U`
/// (an open type parameter or a concrete BCL/user type) — and is not keyed on
/// `Task.Run` or `ValueTask`.
open class Issue2195TaskRunAsyncLambdaInferenceTests {
    @Fact
    func TaskRun_InfersTResult_FromAwaitedValueTaskElement_OpenTypeParameter() {
        // The minimal issue repro: awaiting a `ValueTask[T]` must contribute
        // `T` (not `object`) so `Task.Run`'s TResult infers to `T` and
        // `task.Result : T` converts to the declared return `T`.
        let source = `
package R
import System.Threading.Tasks
struct S {
    func Inner[T]() ValueTask[T] -> ValueTask[T](default(T))
    func Get[T]() T {
        let task = Task.Run(async () -> await Inner[T]())
        return task.Result
    }
}
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func TaskRun_InfersTResult_FromAwaitedTaskElement_OpenTypeParameter() {
        // The `Task[T]` variant of the awaitable must behave identically.
        let source = `
package R
import System.Threading.Tasks
struct S {
    func Inner[T]() Task[T] -> Task.FromResult(default(T)!!)
    func Get[T]() T {
        let task = Task.Run(async () -> await Inner[T]())
        return task.Result
    }
}
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func TaskRun_InfersTResult_FromAwaitedValueTaskElement_ConcreteType() {
        // The awaited element type is a concrete BCL type (`string`): the
        // async lambda's return type must infer `Task[string]`, so
        // `Task.Run`'s TResult fixes to `string` and `task.Result : string`.
        let source = `
package R
import System.Threading.Tasks
struct S {
    func Inner() ValueTask[string] -> ValueTask[string]("hi")
    func Get() string {
        let task = Task.Run(async () -> await Inner())
        return task.Result
    }
}
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func UserGenericMethod_InfersTResult_FromAwaitedValueTaskElement() {
        // Generalized (NOT Task.Run): a user-defined generic method with a
        // `Func[Task[TResult]]`-shaped parameter must infer `TResult` from the
        // async lambda that awaits a `ValueTask[T]`.
        let source = `
package R
import System.Threading.Tasks
struct S {
    func Run2[TResult](f () -> Task[TResult]) TResult -> f().Result
    func Inner[T]() ValueTask[T] -> ValueTask[T](default(T))
    func Get[T]() T {
        let r = Run2(async () -> await Inner[T]())
        return r
    }
}
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func ExplicitTypeArgument_StillBinds_NoRegression() {
        // Guard: the explicit-type-argument oracle path must keep binding.
        let source = `
package R
import System.Threading.Tasks
struct S {
    func Inner[T]() ValueTask[T] -> ValueTask[T](default(T))
    func Get[T]() T {
        let task = Task.Run[T](async () -> await Inner[T]())
        return task.Result
    }
}
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func NonAsyncLambda_StillResolvesValueReturningOverload_NoRegression() {
        // Guard: a plain (non-task) lambda must keep binding to the `() -> T`
        // overload — the generalized element-type recovery must not disturb it.
        let source = `
package R
struct S {
    func Wrap[T](f () -> T) T -> f()
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
