// <copyright file="Issue1071AsyncOverrideTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1071: the override-matching and interface-satisfaction comparisons
/// must use a method's <em>effective</em> (post-async-normalization) return
/// type. An <c>async func M()</c> with no annotation has effective return type
/// <c>Task</c>; <c>async func M() T</c> has effective return type <c>Task[T]</c>.
/// Previously the comparison used the declared return type, so an async
/// override of <c>func M() Task</c> tripped GS0185 and an async implementation
/// of an interface <c>func M() Task;</c> tripped GS0187. Genuine return-type
/// mismatches must still be rejected.
/// </summary>
public class Issue1071AsyncOverrideTests
{
    [Fact]
    public void AsyncOverride_OfTaskReturningBaseMethod_BindsWithoutDiagnostics()
    {
        const string source = """
            package p
            import System.Threading.Tasks
            open class Base {
                protected open func DoAsync() Task;
            }
            open class Derived : Base {
                protected override async func DoAsync() {
                    await Task.CompletedTask
                }
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void NonAsyncControl_TaskReturningOverride_BindsWithoutDiagnostics()
    {
        // The semantically identical non-async override (already accepted) — the
        // only difference from the async case is async-return normalization.
        const string source = """
            package p
            import System.Threading.Tasks
            open class Base {
                protected open func DoAsync() Task;
            }
            open class Derived : Base {
                protected override func DoAsync() Task {
                    return Task.CompletedTask
                }
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void AsyncImplementation_OfTaskReturningInterfaceMethod_BindsWithoutDiagnostics()
    {
        const string source = """
            package p
            import System.Threading
            import System.Threading.Tasks
            interface I { func RunAsync(c CancellationTokenSource) Task; }
            class C : I {
                async func RunAsync(c CancellationTokenSource) { await Task.CompletedTask }
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void AsyncValueOverride_OfGenericTaskReturningBaseMethod_BindsWithoutDiagnostics()
    {
        const string source = """
            package p
            import System.Threading.Tasks
            open class Base {
                protected open func GetAsync() Task[int32];
            }
            open class Derived : Base {
                protected override async func GetAsync() int32 {
                    await Task.CompletedTask
                    return 5
                }
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void AsyncValueImplementation_OfGenericTaskReturningInterfaceMethod_BindsWithoutDiagnostics()
    {
        const string source = """
            package p
            import System.Threading.Tasks
            interface I { func GetAsync() Task[int32]; }
            class C : I {
                async func GetAsync() int32 {
                    await Task.CompletedTask
                    return 7
                }
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void AsyncTaskOverride_OfGenericTaskBaseMethod_StillReportsGS0185()
    {
        // Genuine return-type mismatch: effective Task vs base Task[int32].
        const string source = """
            package p
            import System.Threading.Tasks
            open class Base {
                protected open func DoAsync() Task[int32];
            }
            open class Derived : Base {
                protected override async func DoAsync() {
                    await Task.CompletedTask
                }
            }
            """;
        Assert.Contains(Bind(source), d => d.Id == "GS0185");
    }

    [Fact]
    public void AsyncTaskImplementation_OfGenericTaskInterfaceMethod_StillReportsGS0187()
    {
        // Genuine return-type mismatch: effective Task vs interface Task[int32].
        const string source = """
            package p
            import System.Threading.Tasks
            interface I { func RunAsync() Task[int32]; }
            class C : I {
                async func RunAsync() { await Task.CompletedTask }
            }
            """;
        Assert.Contains(Bind(source), d => d.Id == "GS0187");
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.GlobalScope.Diagnostics.ToList();
    }
}
