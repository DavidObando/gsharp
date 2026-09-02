// <copyright file="SuspensionInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding.Suspension;

/// <summary>
/// ADR-0174 D4: suspension is inferred. A plain <c>func</c> that performs a
/// channel operation, or calls a function that suspends, becomes suspending
/// (<see cref="SuspendingKind.Inferred"/>) after a fixed point over the call
/// graph; the calls to it are retyped and completed exactly like calls to a
/// declared <c>suspend func</c>. Inference stops at the ADR's boundaries and
/// does not color through a <c>go</c> operand or a <c>lock</c> body.
/// </summary>
/// <remarks>
/// Discrimination witnesses (ADR-0154): a mutant that runs one pass instead
/// of iterating breaks <see cref="MutualRecursion_Converges"/>; a mutant that
/// colors through a <c>go</c> operand breaks <see cref="GoOperand_DoesNotColorTheCaller"/>;
/// a mutant that colors the entry point breaks <see cref="EntryPoint_StaysARoot"/>.
/// </remarks>
public class SuspensionInferenceTests
{
    [Fact]
    public void DirectChannelOperation_ColorsTheFunction()
    {
        var program = Bind("""
            package P
            func take(ch in chan[int32]) int32 {
                return <-ch
            }
            func send(ch out chan[int32], v int32) {
                ch <- v
            }
            func drain(ch in chan[int32]) int32 {
                var s = 0
                for v in ch {
                    s = s + v
                }
                return s
            }
            func plain(x int32) int32 {
                return x + 1
            }
            """);

        Assert.Equal(SuspendingKind.Inferred, Function(program, "take").SuspendingKind);
        Assert.Equal(SuspendingKind.Inferred, Function(program, "send").SuspendingKind);
        Assert.Equal(SuspendingKind.Inferred, Function(program, "drain").SuspendingKind);
        Assert.Equal(SuspendingKind.None, Function(program, "plain").SuspendingKind);
        Assert.True(Function(program, "take").AsyncReturnsValueTask);
        Assert.False(Function(program, "take").IsAsync);
        Assert.Equal(TypeSymbol.Int32, Function(program, "take").Type);
    }

    [Fact]
    public void TransitiveCall_ColorsTheCaller_AndTheCallBecomesAnAwait()
    {
        var program = Bind("""
            package P
            func take(ch in chan[int32]) int32 {
                return <-ch
            }
            func twice(ch in chan[int32]) int32 {
                return take(ch) + take(ch)
            }
            func thrice(ch in chan[int32]) int32 {
                return twice(ch) + take(ch)
            }
            """);

        Assert.Equal(SuspendingKind.Inferred, Function(program, "twice").SuspendingKind);
        Assert.Equal(SuspendingKind.Inferred, Function(program, "thrice").SuspendingKind);
        var awaits = Awaits(Body(program, "twice"));
        Assert.Equal(2, awaits.Count);
        Assert.All(awaits, a => Assert.Equal(TypeSymbol.Int32, a.Type));
        Assert.All(awaits, a => Assert.Contains("ValueTask", a.Expression.Type!.Name));
        Assert.Empty(program.Diagnostics);
    }

    [Fact]
    public void MutualRecursion_Converges()
    {
        var program = Bind("""
            package P
            func ping(a chan[int32], b chan[int32], n int32) {
                if n == 0 {
                    return
                }
                a <- n
                pong(a, b, n - 1)
            }
            func pong(a chan[int32], b chan[int32], n int32) {
                let v = <-a
                b <- v
                ping(a, b, n)
            }
            func caller(a chan[int32], b chan[int32]) {
                ping(a, b, 2)
            }
            func outer(a chan[int32], b chan[int32]) {
                caller(a, b)
            }
            """);

        Assert.Equal(SuspendingKind.Inferred, Function(program, "ping").SuspendingKind);
        Assert.Equal(SuspendingKind.Inferred, Function(program, "pong").SuspendingKind);
        Assert.Equal(SuspendingKind.Inferred, Function(program, "caller").SuspendingKind);
        Assert.Equal(SuspendingKind.Inferred, Function(program, "outer").SuspendingKind);
        Assert.Single(Awaits(Body(program, "outer")));
        Assert.Empty(program.Diagnostics);
    }

    [Fact]
    public void GoOperand_DoesNotColorTheCaller()
    {
        var program = Bind("""
            package P
            func produce(ch out chan[int32]) {
                ch <- 1
                ch.Close()
            }
            func spawn(ch chan[int32]) int32 {
                go produce(ch)
                return 1
            }
            """);

        Assert.Equal(SuspendingKind.Inferred, Function(program, "produce").SuspendingKind);
        Assert.Equal(SuspendingKind.None, Function(program, "spawn").SuspendingKind);
        Assert.Empty(Awaits(Body(program, "spawn")));
        Assert.Empty(program.Diagnostics);
    }

    [Fact]
    public void EntryPoint_StaysARoot_AndBridgesSilently()
    {
        var program = Bind("""
            package P
            func take(ch in chan[int32]) int32 {
                return <-ch
            }
            let ch = chan[int32](1)
            ch <- 1
            let v = take(ch)
            """);

        var entry = program.Functions.Keys.Single(f => f.IsTopLevelEntryPoint);
        Assert.Equal(SuspendingKind.None, entry.SuspendingKind);
        Assert.Empty(Awaits(program.Functions[entry]));
        Assert.Single(Bridges(program.Functions[entry]));
        Assert.Empty(program.Diagnostics);
    }

    [Fact]
    public void AsyncCaller_AwaitsTheInferredCallee()
    {
        var program = Bind("""
            package P
            func take(ch in chan[int32]) int32 {
                return <-ch
            }
            async func run(ch chan[int32]) int32 {
                return take(ch)
            }
            """);

        Assert.True(Function(program, "run").IsAsync);
        Assert.Equal(SuspendingKind.None, Function(program, "run").SuspendingKind);
        Assert.Single(Awaits(Body(program, "run")));
        Assert.Empty(program.Diagnostics);
    }

    [Fact]
    public void CallingAnAsyncFunc_DoesNotColor_ButAwaitingItDoes()
    {
        var program = Bind("""
            package P
            import System.Threading.Tasks
            async func work() int32 {
                await Task.Yield()
                return 1
            }
            func starts() Task[int32] {
                return work()
            }
            suspend func waits() int32 {
                return await work()
            }
            """);

        Assert.Equal(SuspendingKind.None, Function(program, "starts").SuspendingKind);
        Assert.Equal(SuspendingKind.Declared, Function(program, "waits").SuspendingKind);
        Assert.Empty(program.Diagnostics);
    }

    [Fact]
    public void Boundaries_AreNotInferred_AndKeepBlocking()
    {
        var program = Bind("""
            package P
            interface Source {
                func Next() int32;
            }
            class ChanSource : Source {
                var ch chan[int32] = chan[int32](2)
                func Next() int32 {
                    return <-ch
                }
                func Fill() {
                    ch <- 1
                }
            }
            open class Base {
                open func Read(ch chan[int32]) int32 {
                    return <-ch
                }
            }
            func gen(ch chan[int32]) sequence[int32] {
                yield <-ch
            }
            """);

        Assert.Equal(SuspendingKind.None, Function(program, "Next").SuspendingKind);
        Assert.Equal(SuspendingKind.Inferred, Function(program, "Fill").SuspendingKind);
        Assert.Equal(SuspendingKind.None, Function(program, "Read").SuspendingKind);
        Assert.Equal(SuspendingKind.None, Function(program, "gen").SuspendingKind);
    }

    [Fact]
    public void UserMain_IsTheRoot_AndFixedBodies_AreBoundaries()
    {
        var program = Bind("""
            package P
            func take(ch in chan[int32]) int32 {
                return <-ch
            }
            func pinned(xs []int32, ch chan[int32]) int32 {
                ch <- 1
                unsafe {
                    fixed p *int32 = xs {
                        return *p + <-ch
                    }
                }
                return 0
            }
            func Main() {
                let ch = chan[int32](1)
                ch <- 1
                let v = take(ch)
            }
            """);

        Assert.Equal(SuspendingKind.None, Function(program, "Main").SuspendingKind);
        Assert.Equal(SuspendingKind.None, Function(program, "pinned").SuspendingKind);
        Assert.Equal(SuspendingKind.Inferred, Function(program, "take").SuspendingKind);
        Assert.Single(Bridges(Body(program, "Main")));
        Assert.Empty(program.Diagnostics);
    }

    [Fact]
    public void ResidualBridge_InABoundaryFunction_ReportsGS0558()
    {
        var program = Bind("""
            package P
            func take(ch in chan[int32]) int32 {
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
        Assert.Contains("'take'", diagnostic.Message);
        Assert.Single(Bridges(Body(program, "Read")));
    }

    [Fact]
    public void ChannelOperationInsideLock_DoesNotColor()
    {
        var program = Bind("""
            package P
            class Gate {
            }
            func guarded(ch chan[int32]) int32 {
                var v = 0
                lock gate {
                    v = <-ch
                }
                return v
            }
            let gate = Gate()
            """);

        Assert.Equal(SuspendingKind.None, Function(program, "guarded").SuspendingKind);
        Assert.Empty(program.Diagnostics);
    }

    [Fact]
    public void LambdaBody_CallingAnInferredFunction_IsBridged()
    {
        var program = Bind("""
            package P
            func take(ch in chan[int32]) int32 {
                return <-ch
            }
            func build(ch chan[int32]) (int32) -> int32 {
                return (x) -> take(ch) + x
            }
            """);

        Assert.Equal(SuspendingKind.None, Function(program, "build").SuspendingKind);
        var literals = Literals(Body(program, "build"));
        var literal = Assert.Single(literals);
        Assert.Single(Bridges(literal.Body));
        var diagnostic = Assert.Single(program.Diagnostics);
        Assert.Equal("GS0558", diagnostic.Id);
    }

    private static BoundProgram Bind(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source));
        Assert.Empty(compilation.GlobalScope.Diagnostics.Where(d => d.IsError));
        var program = Binder.BindProgram(compilation.GlobalScope, compilation.References ?? ReferenceResolver.Default());
        Assert.Empty(program.Diagnostics.Where(d => d.IsError).Select(d => d.Message));
        return program;
    }

    private static FunctionSymbol Function(BoundProgram program, string name)
        => program.Functions.Keys.Single(f => f.Name == name);

    private static BoundBlockStatement Body(BoundProgram program, string name)
        => program.Functions.Single(p => p.Key.Name == name).Value;

    private static List<BoundAwaitExpression> Awaits(BoundStatement body)
    {
        var collector = new Collector();
        collector.Visit(body);
        return collector.Awaits;
    }

    private static List<BoundImportedCallExpression> Bridges(BoundStatement body)
    {
        var collector = new Collector();
        collector.Visit(body);
        return collector.Bridges;
    }

    private static List<BoundFunctionLiteralExpression> Literals(BoundStatement body)
    {
        var collector = new Collector();
        collector.Visit(body);
        return collector.Literals;
    }

    private sealed class Collector : BoundTreeWalker
    {
        public List<BoundAwaitExpression> Awaits { get; } = new();

        public List<BoundImportedCallExpression> Bridges { get; } = new();

        public List<BoundFunctionLiteralExpression> Literals { get; } = new();

        protected override void VisitAwaitExpression(BoundAwaitExpression node)
        {
            Awaits.Add(node);
            base.VisitAwaitExpression(node);
        }

        protected override void VisitImportedCallExpression(BoundImportedCallExpression node)
        {
            if (node.Function.Name == "Wait" && node.Function.ImportedClass.ClassType.FullName == "Gsharp.Concurrency.Blocking")
            {
                Bridges.Add(node);
            }

            base.VisitImportedCallExpression(node);
        }

        public override void VisitExpression(BoundExpression node)
        {
            if (node is BoundFunctionLiteralExpression literal)
            {
                Literals.Add(literal);
            }

            base.VisitExpression(node);
        }
    }
}
