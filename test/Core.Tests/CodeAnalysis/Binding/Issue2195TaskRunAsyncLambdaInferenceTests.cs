// <copyright file="Issue2195TaskRunAsyncLambdaInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2195 — inferring a generic method's type argument from an ASYNC
/// lambda argument whose body <c>await</c>s a generic awaitable.
/// <para>
/// <c>Task.Run(async () -&gt; await Inner[T]())</c>, where <c>Inner[T]</c>
/// returns <c>ValueTask[T]</c>, inferred <c>TResult = object</c> instead of
/// <c>T</c>: the awaited element type of the <c>ValueTask[T]</c> was recovered
/// from the awaiter's CLR <c>GetResult()</c> return type, which is erased to
/// <c>object</c> for a same-compilation user type / open type parameter. The
/// async lambda's return type therefore inferred as <c>Task[object]</c>, fixing
/// <c>Task.Run</c>'s <c>TResult</c> to <c>object</c>, and <c>task.Result</c>
/// (<c>object</c>) failed to convert to the declared <c>T</c> (GS0156).
/// </para>
/// <para>
/// The fix recovers the awaited element type from the awaitable's SYMBOLIC
/// type argument. It is generalized to every generic awaitable whose
/// <c>GetResult()</c> surfaces the awaitable's own type parameter — covering
/// both <c>Task[U]</c> and <c>ValueTask[U]</c>, for any element type <c>U</c>
/// (an open type parameter or a concrete BCL/user type) — and is not keyed on
/// <c>Task.Run</c> or <c>ValueTask</c>.
/// </para>
/// </summary>
public class Issue2195TaskRunAsyncLambdaInferenceTests
{
    [Fact]
    public void TaskRun_InfersTResult_FromAwaitedValueTaskElement_OpenTypeParameter()
    {
        // The minimal issue repro: awaiting a `ValueTask[T]` must contribute
        // `T` (not `object`) so `Task.Run`'s TResult infers to `T` and
        // `task.Result : T` converts to the declared return `T`.
        var source = @"
package R
import System.Threading.Tasks
struct S {
    func Inner[T]() ValueTask[T] -> ValueTask[T](default(T))
    func Get[T]() T {
        let task = Task.Run(async () -> await Inner[T]())
        return task.Result
    }
}
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void TaskRun_InfersTResult_FromAwaitedTaskElement_OpenTypeParameter()
    {
        // The `Task[T]` variant of the awaitable must behave identically.
        var source = @"
package R
import System.Threading.Tasks
struct S {
    func Inner[T]() Task[T] -> Task.FromResult(default(T)!!)
    func Get[T]() T {
        let task = Task.Run(async () -> await Inner[T]())
        return task.Result
    }
}
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void TaskRun_InfersTResult_FromAwaitedValueTaskElement_ConcreteType()
    {
        // The awaited element type is a concrete BCL type (`string`): the
        // async lambda's return type must infer `Task[string]`, so
        // `Task.Run`'s TResult fixes to `string` and `task.Result : string`.
        var source = @"
package R
import System.Threading.Tasks
struct S {
    func Inner() ValueTask[string] -> ValueTask[string](""hi"")
    func Get() string {
        let task = Task.Run(async () -> await Inner())
        return task.Result
    }
}
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void UserGenericMethod_InfersTResult_FromAwaitedValueTaskElement()
    {
        // Generalized (NOT Task.Run): a user-defined generic method with a
        // `Func[Task[TResult]]`-shaped parameter must infer `TResult` from the
        // async lambda that awaits a `ValueTask[T]`.
        var source = @"
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
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void ExplicitTypeArgument_StillBinds_NoRegression()
    {
        // Guard: the explicit-type-argument oracle path must keep binding.
        var source = @"
package R
import System.Threading.Tasks
struct S {
    func Inner[T]() ValueTask[T] -> ValueTask[T](default(T))
    func Get[T]() T {
        let task = Task.Run[T](async () -> await Inner[T]())
        return task.Result
    }
}
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void NonAsyncLambda_StillResolvesValueReturningOverload_NoRegression()
    {
        // Guard: a plain (non-task) lambda must keep binding to the `() -> T`
        // overload — the generalized element-type recovery must not disturb it.
        var source = @"
package R
struct S {
    func Wrap[T](f () -> T) T -> f()
    func Use() int32 {
        let r = Wrap(() -> 42)
        return r
    }
}
";
        AssertBindsWithoutErrors(source);
    }

    private static void AssertBindsWithoutErrors(string source)
    {
        var paths = new List<string>();
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (!string.IsNullOrEmpty(tpa))
        {
            foreach (var p in tpa.Split(Path.PathSeparator))
            {
                if (!string.IsNullOrWhiteSpace(p) && File.Exists(p))
                {
                    paths.Add(p);
                }
            }
        }

        using var resolver = ReferenceResolver.WithReferences(paths);
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree), resolver);
        var program = Binder.BindProgram(globalScope, resolver);
        var diagnostics = globalScope.Diagnostics.AddRange(program.Diagnostics);
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }
}
