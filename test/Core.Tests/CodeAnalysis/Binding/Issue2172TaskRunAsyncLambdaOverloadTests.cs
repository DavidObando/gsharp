// <copyright file="Issue2172TaskRunAsyncLambdaOverloadTests.cs" company="GSharp">
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
/// Issue #2172 — <c>Task.Run(async () -&gt; await ...)</c>, where the async
/// lambda awaits a <c>Task[T]</c>, previously failed overload resolution with
/// GS0160 ("Call to 'Run' is ambiguous"). The lambda's natural type is
/// <c>Func&lt;Task&lt;T&gt;&gt;</c>, which is an identity conversion to BOTH
/// <c>Run&lt;TResult&gt;(Func&lt;TResult&gt;)</c> (TResult = Task&lt;T&gt;) and
/// <c>Run&lt;TResult&gt;(Func&lt;Task&lt;TResult&gt;&gt;)</c> (TResult = T), so
/// neither dominated on conversion kind and the call was reported ambiguous —
/// which cascaded into GS0158 on the follow-up <c>.Result</c> access. C# prefers
/// the task-returning delegate overload; gsc now applies the same betterness
/// rule (prefer <c>Func[Task[X]]</c> over <c>Func[X]</c> for a task-returning
/// lambda argument), so the call resolves to the <c>Func[Task[TResult]]</c>
/// overload with <c>task : Task[T]</c> and <c>task.Result : T</c>.
/// The rule is generalized: it is not keyed on <c>Task.Run</c> and also fires
/// for a user-defined overload set differing by <c>() -&gt; X</c> vs
/// <c>() -&gt; Task[X]</c>.
/// </summary>
public class Issue2172TaskRunAsyncLambdaOverloadTests
{
    [Fact]
    public void TaskRun_AsyncLambda_ResolvesWithoutAmbiguityOrCascade()
    {
        // The minimal issue repro: if resolution picked Func<TResult>
        // (TResult = Task[T]), `task` would be Task[Task[T]], `task.Result`
        // would be Task[T], and `return task.Result` (declared T) would be a
        // type error. A clean bind therefore proves the Func[Task[TResult]]
        // overload (task : Task[T], task.Result : T) was selected.
        var source = @"
package R
import System.Threading.Tasks
struct S {
    func Get[T]() T {
        let task = Task.Run(async () -> await MakeAsync[T]())
        return task.Result
    }
    func MakeAsync[T]() Task[T] -> Task.FromResult(default(T)!!)
}
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void UserOverloadSet_FuncXVersusFuncTaskX_PrefersTaskReturningOverload()
    {
        // Generalized (NOT Task.Run): a user-defined overload set that differs
        // only by `() -> T` vs `() -> Task[T]`. The task-returning async lambda
        // must select the `() -> Task[T]` overload so `Use[T]() T` returns T.
        // If the `() -> T` overload were chosen, T would infer to Task[T] and
        // the declared `T` return would mismatch.
        var source = @"
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
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void NonAsyncLambda_StillResolvesValueReturningOverload()
    {
        // Guard: a plain (non-task) lambda must keep binding to the `() -> T`
        // overload — the new betterness rule must not disturb it.
        var source = @"
package R
struct S {
    func Wrap[T](f () -> T) T -> f()
    func Wrap[T](f () -> S) S -> f()
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
