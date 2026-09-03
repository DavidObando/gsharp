// <copyright file="Adr0174AmbientContextTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0174 D7: a channel operation observes the innermost enclosing scope's
/// context, so cancelling that block unblocks operations parked inside it.
/// Every operation shape carries the context — the single-value receive, the
/// two-value receive, a channel <c>for … in</c> loop, and a send — and an
/// operation outside every scope keeps the uncancellable default.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): a mutant that binds every operation
/// against the default token (the shape before D7 landed) breaks every fact
/// here that expects <c>Gsharp.Concurrency.Context</c>, and at runtime leaves a
/// parked receive in a cancelled scope hanging forever — see
/// <c>Adr0174CancellationEmitTests</c>.
/// </remarks>
public class Adr0174AmbientContextTests
{
    [Fact]
    public void ReceiveAndSend_InsideAScope_ParkOnTheBlocksContext()
    {
        var calls = ChannelOpCalls("""
            package P
            func f() {
                let ch = chan[int32](1)
                scope {
                    let v = <-ch
                    ch <- 1
                }
            }
            """);

        Assert.Equal(2, calls.Count);
        Assert.All(calls, call => Assert.Equal("Gsharp.Concurrency.Context", ContextArgumentType(call)));
        Assert.All(calls, call => Assert.IsType<BoundVariableExpression>(call.Arguments[^1]));
        Assert.All(calls, call => Assert.Equal("ctx", ((BoundVariableExpression)call.Arguments[^1]).Variable.Name));
    }

    [Fact]
    public void Operations_OutsideEveryScope_ParkOnTheFunctionsHiddenContext()
    {
        // No lexical scope encloses these, so they observe whatever context the
        // caller passed in — the hidden parameter D7 gives every suspending
        // function. A caller inside a `scope` therefore cancels them too.
        var program = Bind("""
            package P
            func f() {
                let ch = chan[int32](1)
                ch <- 1
                let v = <-ch
            }
            """);

        var function = program.Functions.Single(p => p.Key.Name == "f").Key;
        Assert.True(function.IsSuspending);
        var hidden = Assert.IsType<ParameterSymbol>(function.HiddenContextParameter);
        Assert.Equal("<>ctx", hidden.Name);

        // The hidden parameter is emit-only: it leads the CLR signature and is
        // absent from the parameters overload resolution, hover and signature
        // help see — binding runs again on every keystroke, and a shifted
        // parameter list would break every call site the second time around.
        Assert.Same(hidden, function.EmittedParameters[0]);
        Assert.DoesNotContain(hidden, function.Parameters);

        var calls = ChannelOps(program.Functions.Single(p => p.Key.Name == "f").Value);
        Assert.Equal(2, calls.Count);
        Assert.All(calls, call => Assert.Equal("Gsharp.Concurrency.Context", ContextArgumentType(call)));
        Assert.All(calls, call => Assert.Same(hidden, Assert.IsType<BoundVariableExpression>(call.Arguments[^1]).Variable));
    }

    [Fact]
    public void Operations_InABoundaryFunction_KeepTheUncancellableDefault()
    {
        // An `open` method cannot be inferred suspending (its signature is a
        // contract), so it never gains a hidden context and its operations stay
        // uncancellable — the shape every channel operation had before D7.
        var program = Bind("""
            package P
            open class Reader {
                open func Take(ch chan[int32]) int32 {
                    return <-ch
                }
            }
            """);

        var take = program.Functions.Single(p => p.Key.Name == "Take");
        Assert.False(take.Key.IsSuspending);
        Assert.Null(take.Key.HiddenContextParameter);

        var call = Assert.Single(ChannelOps(take.Value));
        Assert.Equal("System.Threading.CancellationToken", ContextArgumentType(call));
        Assert.IsType<BoundDefaultExpression>(call.Arguments[^1]);
    }

    [Fact]
    public void TwoValueReceive_AndChannelLoop_CarryTheContextToo()
    {
        var calls = ChannelOpCalls("""
            package P
            func f() {
                let ch = chan[int32](1)
                scope {
                    let (v, ok) = <-ch
                    for item in ch {
                        let unused = item
                    }
                }
            }
            """);

        Assert.Equal(2, calls.Count);
        Assert.All(calls, call => Assert.Equal("Receive2", call.Function.Name));
        Assert.All(calls, call => Assert.Equal("Gsharp.Concurrency.Context", ContextArgumentType(call)));
    }

    [Fact]
    public void ADeclaredContextParameter_IsUsedInsteadOfAddingAHiddenOne()
    {
        // ADR-0174 D7: an author who writes `ctx Context` has said how the
        // context arrives. The signature stays exactly as written — visible,
        // and callable from C# — and the operations park on their parameter.
        var program = Bind("""
            package P
            import Gsharp.Concurrency
            func worker(ch in chan[int32], ctx Context) int32 {
                return <-ch
            }
            """);

        var worker = program.Functions.Single(p => p.Key.Name == "worker");
        Assert.True(worker.Key.IsSuspending);
        Assert.Null(worker.Key.HiddenContextParameter);
        Assert.Equal(worker.Key.Parameters.Length, worker.Key.EmittedParameters.Length);

        var declared = worker.Key.Parameters.Single(p => p.Name == "ctx");
        Assert.Same(declared, worker.Key.AmbientContextParameter);

        var call = Assert.Single(ChannelOps(worker.Value));
        Assert.Same(declared, Assert.IsType<BoundVariableExpression>(call.Arguments[^1]).Variable);
    }

    [Fact]
    public void AVariadicFunction_CarriesNoContext_BecauseItsLastParameterMustStayLast()
    {
        // The context is appended, and `...T` must be positionally last, so a
        // variadic suspending function keeps its signature and runs its
        // operations uncancelled rather than gaining a broken one.
        var program = Bind("""
            package P
            func sumAll(ch in chan[int32], extras ...int32) int32 {
                var total = <-ch
                for e in extras {
                    total = total + e
                }

                return total
            }
            """);

        var sumAll = program.Functions.Single(p => p.Key.Name == "sumAll");
        Assert.True(sumAll.Key.IsSuspending);
        Assert.Null(sumAll.Key.HiddenContextParameter);
        Assert.Null(sumAll.Key.AmbientContextParameter);
        Assert.Equal(sumAll.Key.Parameters.Length, sumAll.Key.EmittedParameters.Length);

        var call = Assert.Single(ChannelOps(sumAll.Value));
        Assert.Equal("System.Threading.CancellationToken", ContextArgumentType(call));
    }

    [Fact]
    public void NestedScope_BindsTheInnermostContext()
    {
        var program = Bind("""
            package P
            func f() {
                let ch = chan[int32](1)
                scope {
                    scope {
                        let v = <-ch
                    }
                }
            }
            """);

        var body = program.Functions.Single(p => p.Key.Name == "f").Value;
        var contexts = Collect<BoundVariableDeclaration>(body)
            .Where(d => d.Variable.Name == "ctx")
            .Select(d => d.Variable)
            .ToList();
        Assert.Equal(2, contexts.Count);

        var receive = Assert.Single(ChannelOps(body));
        var used = Assert.IsType<BoundVariableExpression>(receive.Arguments[^1]).Variable;
        Assert.Same(contexts[1], used);
        Assert.NotSame(contexts[0], used);
    }

    private static string ContextArgumentType(BoundImportedCallExpression call)
        => call.Arguments[^1].Type?.ClrType?.FullName ?? "?";

    private static List<BoundImportedCallExpression> ChannelOpCalls(string source)
    {
        var program = Bind(source);
        Assert.DoesNotContain(program.Diagnostics, d => d.IsError);
        return ChannelOps(program.Functions.Single(p => p.Key.Name == "f").Value);
    }

    private static List<BoundImportedCallExpression> ChannelOps(BoundStatement body)
        => Collect<BoundImportedCallExpression>(body)
            .Where(c => c.Function.ImportedClass.ClassType.Name == "ChannelOps")
            .ToList();

    private static BoundProgram Bind(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source));
        return Binder.BindProgram(compilation.GlobalScope, compilation.References ?? ReferenceResolver.Default());
    }

    private static List<T> Collect<T>(BoundStatement body)
        where T : BoundNode
    {
        var collector = new Collector<T>();
        collector.Visit(body);
        return collector.Found;
    }

    private sealed class Collector<T> : BoundTreeWalker
        where T : BoundNode
    {
        public List<T> Found { get; } = new();

        public override void VisitStatement(BoundStatement node)
        {
            if (node is T match)
            {
                Found.Add(match);
            }

            base.VisitStatement(node);
        }

        public override void VisitExpression(BoundExpression node)
        {
            if (node is T match)
            {
                Found.Add(match);
            }

            base.VisitExpression(node);
        }
    }
}
