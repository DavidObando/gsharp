// <copyright file="Adr0174SuspendFuncBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Symbols.Display;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0174 D4, the declared path: a <c>suspend func</c> is a suspending
/// function — its logical return type is <c>R</c>, a call from a suspending or
/// <c>async</c> body is an implicit await typed <c>R</c>, a call from a plain
/// function blocks through the runtime's root bridge and warns (GS0558), and
/// the synthesized entry point is the root where that block is silent. The
/// body may use <c>await</c>; <c>async</c> and <c>suspend</c> never coexist.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): a mutant that types the call as
/// <c>ValueTask[R]</c> without the implicit await breaks
/// <see cref="Call_FromSuspendingCaller_IsAnImplicitAwaitTypedR"/> (the
/// bound tree has no await, the sum is not <c>int32</c>); a mutant that drops
/// the root exemption breaks <see cref="Call_FromEntryPoint_DoesNotWarn"/>.
/// </remarks>
public class Adr0174SuspendFuncBindingTests
{
    [Fact]
    public void Declaration_IsSuspending_NotAsync_WithLogicalReturnType()
    {
        var program = Bind("""
            package P
            suspend func take(ch in chan[int32]) int32 {
                return <-ch
            }
            """);

        var take = program.Functions.Keys.Single(f => f.Name == "take");
        Assert.Equal(SuspendingKind.Declared, take.SuspendingKind);
        Assert.True(take.IsSuspending);
        Assert.False(take.IsAsync);
        Assert.True(take.AsyncReturnsValueTask);
        Assert.Equal(TypeSymbol.Int32, take.Type);
    }

    [Fact]
    public void Call_FromSuspendingCaller_IsAnImplicitAwaitTypedR()
    {
        var program = Bind("""
            package P
            suspend func take(ch in chan[int32]) int32 {
                return <-ch
            }
            suspend func twice(ch in chan[int32]) int32 {
                return take(ch) + take(ch)
            }
            """);

        var twice = program.Functions.Single(p => p.Key.Name == "twice");
        var awaits = Collect<BoundAwaitExpression>(twice.Value);
        Assert.Equal(2, awaits.Count);
        Assert.All(awaits, a => Assert.Equal(TypeSymbol.Int32, a.Type));
        Assert.All(awaits, a => Assert.Contains("ValueTask", a.Expression.Type!.Name));
        Assert.Empty(program.Diagnostics);
    }

    [Fact]
    public void Call_FromAsyncCaller_IsAnImplicitAwait()
    {
        var program = Bind("""
            package P
            suspend func take(ch in chan[int32]) int32 {
                return <-ch
            }
            async func run(ch chan[int32]) int32 {
                return take(ch)
            }
            """);

        var run = program.Functions.Single(p => p.Key.Name == "run");
        Assert.Single(Collect<BoundAwaitExpression>(run.Value));
        Assert.Empty(program.Diagnostics);
    }

    [Fact]
    public void Call_FromABoundaryFunction_BlocksAndWarnsGS0558()
    {
        // A plain caller would be inferred suspending (D4); an `open` method is
        // a boundary, so its call keeps the blocking root bridge and warns.
        var program = Bind("""
            package P
            suspend func take(ch in chan[int32]) int32 {
                return <-ch
            }
            open class Reader {
                open func Read(ch chan[int32]) int32 {
                    return take(ch)
                }
            }
            """);

        var diagnostic = Assert.Single(program.Diagnostics);
        Assert.Equal("GS0558", diagnostic.Id);
        Assert.Equal(DiagnosticSeverity.Warning, diagnostic.Severity);
        Assert.Contains("'take'", diagnostic.Message);
        var read = program.Functions.Single(p => p.Key.Name == "Read");
        Assert.Empty(Collect<BoundAwaitExpression>(read.Value));
        var bridge = Assert.Single(Collect<BoundImportedCallExpression>(read.Value), c => c.Function.Name == "Wait");
        Assert.Equal("Gsharp.Concurrency.Blocking", bridge.Function.ImportedClass.ClassType.FullName);
        Assert.Equal(TypeSymbol.Int32, bridge.Type);
    }

    [Fact]
    public void Call_FromPlainFunction_IsInferred_AndAwaited()
    {
        var program = Bind("""
            package P
            suspend func take(ch in chan[int32]) int32 {
                return <-ch
            }
            func plain(ch chan[int32]) int32 {
                return take(ch)
            }
            """);

        Assert.Empty(program.Diagnostics);
        var plain = program.Functions.Single(p => p.Key.Name == "plain");
        Assert.Equal(SuspendingKind.Inferred, plain.Key.SuspendingKind);
        Assert.Single(Collect<BoundAwaitExpression>(plain.Value));
    }

    [Fact]
    public void Call_FromEntryPoint_DoesNotWarn()
    {
        var (diagnostics, _) = CompileDiagnostics("""
            package P
            suspend func take(ch in chan[int32]) int32 {
                return <-ch
            }
            let ch = chan[int32](1)
            ch <- 3
            let v = take(ch)
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Await_IsAllowedInsideASuspendFunc()
    {
        var (diagnostics, _) = CompileDiagnostics("""
            package P
            import System.Threading.Tasks
            suspend func pause() int32 {
                await Task.Delay(1)
                return 1
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ExplicitAwait_OnASuspendingCall_IsRedundantAndLegal()
    {
        // The call is already completed as an implicit await; a spelled-out
        // `await` (what a C# or Go programmer, and cs2gs, writes) must not
        // report GS0133 against the logical type `int32`.
        var program = Bind("""
            package P
            suspend func twice(ch in chan[int32]) int32 {
                return <-ch * 2
            }
            suspend func run(ch chan[int32]) int32 {
                let a = await twice(ch)
                return a
            }
            """);

        var run = program.Functions.Single(p => p.Key.Name == "run");
        var await = Assert.Single(Collect<BoundAwaitExpression>(run.Value));
        Assert.Equal(TypeSymbol.Int32, await.Type);
        Assert.Empty(program.Diagnostics);
    }

    [Fact]
    public void ExplicitAwait_OnAGenuineNestedTask_StillAwaitsTwice()
    {
        var program = Bind("""
            package P
            import System.Threading.Tasks
            suspend func inner() Task[int32] {
                return Task.FromResult(3)
            }
            suspend func run() int32 {
                return await inner()
            }
            """);

        var run = program.Functions.Single(p => p.Key.Name == "run");
        Assert.Equal(2, Collect<BoundAwaitExpression>(run.Value).Count);
        Assert.Empty(program.Diagnostics);
    }

    [Fact]
    public void VoidSuspendFunc_CallIsAnAwaitedStatement()
    {
        var program = Bind("""
            package P
            suspend func fill(ch out chan[int32]) {
                ch <- 1
            }
            suspend func run(ch chan[int32]) {
                fill(ch)
            }
            """);

        var run = program.Functions.Single(p => p.Key.Name == "run");
        var await = Assert.Single(Collect<BoundAwaitExpression>(run.Value));
        Assert.Equal(TypeSymbol.Void, await.Type);
        Assert.Empty(program.Diagnostics);
    }

    [Fact]
    public void SuspendMethod_OnAClass_IsAnImplicitAwaitAtTheCallSite()
    {
        var program = Bind("""
            package P
            class Pump {
                var ch chan[int32] = chan[int32](4)
                suspend func Take() int32 {
                    return <-ch
                }
                suspend func TakeTwo() int32 {
                    return Take() + Take()
                }
            }
            """);

        Assert.Empty(program.Diagnostics);
        var takeTwo = program.Functions.Single(p => p.Key.Name == "TakeTwo");
        Assert.Equal(2, Collect<BoundAwaitExpression>(takeTwo.Value).Count);
    }

    [Fact]
    public void SymbolDisplay_ShowsSuspend()
    {
        var program = Bind("""
            package P
            suspend func take(ch in chan[int32]) int32 {
                return <-ch
            }
            """);

        var take = program.Functions.Keys.Single(f => f.Name == "take");
        var display = SymbolDisplay.ToDisplayString(take, SymbolDisplayFormat.Hover);
        Assert.Contains("suspend", display);
        Assert.DoesNotContain("ValueTask", display);
    }

    private static BoundProgram Bind(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source));
        Assert.Empty(compilation.GlobalScope.Diagnostics.Where(d => d.IsError));
        return Binder.BindProgram(compilation.GlobalScope, compilation.References ?? ReferenceResolver.Default());
    }

    private static (ImmutableArray<Diagnostic> Diagnostics, Compilation Compilation) CompileDiagnostics(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source));
        return (EmittedOracle.CompileDiagnostics(compilation), compilation);
    }

    private static System.Collections.Generic.List<T> Collect<T>(BoundStatement body)
        where T : BoundNode
    {
        var collector = new Collector<T>();
        collector.Visit(body);
        return collector.Found;
    }

    private sealed class Collector<T> : BoundTreeWalker
        where T : BoundNode
    {
        public System.Collections.Generic.List<T> Found { get; } = new();

        protected override void VisitAwaitExpression(BoundAwaitExpression node)
        {
            if (node is T match)
            {
                Found.Add(match);
            }

            base.VisitAwaitExpression(node);
        }

        protected override void VisitImportedCallExpression(BoundImportedCallExpression node)
        {
            if (node is T match)
            {
                Found.Add(match);
            }

            base.VisitImportedCallExpression(node);
        }
    }
}
