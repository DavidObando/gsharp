// <copyright file="Adr0174ScopeLoweringTests.cs" company="GSharp">
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
/// ADR-0174 D5/D6: <c>scope { … }</c> is lowered by the binder onto the runtime's
/// <c>ScopeFrame</c> — <c>Enter</c>, an implicit <c>ctx</c> of type <c>Context</c>,
/// the body in a try whose catch records the body's exception and whose finally
/// calls <c>Exit</c> — and every <c>go</c> inside it carries the frame as its
/// completion sink. A function containing a scope suspends (the join is a
/// suspension point), so inside its state machine the exit is an awaited
/// <c>ExitAsync</c>; at the root it blocks.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): a mutant that hands every <c>go</c> a
/// <c>null</c> sink (never registering with the enclosing frame; run while
/// landing P3-5) breaks
/// <see cref="Go_InsideScope_ReportsToTheFrame_AndOutsideToNoSink"/>, and the
/// emitted failure tests then die with the runtime's free-goroutine fail-fast.
/// </remarks>
public class Adr0174ScopeLoweringTests
{
    [Fact]
    public void Scope_LowersToScopeFrameEnterTryFinallyExit_WithCtx()
    {
        var program = Bind("""
            package P
            func work(ch out chan[int32]) {
                ch <- 1
            }
            func run() int32 {
                let ch = chan[int32](1)
                scope {
                    go work(ch)
                }
                return <-ch
            }
            """);

        var run = Body(program, "run");
        var calls = Collect<BoundImportedCallExpression>(run);
        Assert.Contains(calls, c => c.Function.Name == "Enter" && c.Function.ImportedClass.ClassType.FullName == "Gsharp.Concurrency.ScopeFrame");
        var tries = Collect<BoundTryStatement>(run);
        var scopeTry = Assert.Single(tries);
        Assert.Single(scopeTry.CatchClauses);
        Assert.NotNull(scopeTry.FinallyBlock);
        var exits = Collect<BoundImportedInstanceCallExpression>(run).Where(ChannelRuntimeBinder.IsScopeExit).ToList();
        Assert.Single(exits);
        var ctx = Collect<BoundVariableDeclaration>(run).Single(d => d.Variable.Name == "ctx");
        Assert.Equal("Gsharp.Concurrency.Context", ctx.Variable.Type.ClrType?.FullName);
        Assert.Empty(program.Diagnostics);
    }

    [Fact]
    public void NestedScope_EntersUnderTheEnclosingCtx_OutermostUnderDefault()
    {
        var program = Bind("""
            package P
            func run() {
                scope {
                    scope {
                    }
                }
            }
            """);

        var run = Body(program, "run");
        var enters = Collect<BoundImportedCallExpression>(run).Where(c => c.Function.Name == "Enter").ToList();
        Assert.Equal(2, enters.Count);
        Assert.IsType<BoundDefaultExpression>(Assert.Single(enters[0].Arguments));
        var inner = Assert.IsType<BoundClrPropertyAccessExpression>(Assert.Single(enters[1].Arguments));
        Assert.Equal("Context", inner.Member.Name);
        var outerFrame = Assert.IsType<BoundVariableExpression>(inner.Receiver).Variable;
        Assert.StartsWith("<scope$frame$", outerFrame.Name);
        Assert.Empty(program.Diagnostics);
    }

    [Fact]
    public void Go_InsideScope_ReportsToTheFrame_AndOutsideToNoSink()
    {
        var program = Bind("""
            package P
            func work(ch out chan[int32]) {
                ch <- 1
            }
            func run() int32 {
                let ch = chan[int32](2)
                go work(ch)
                scope {
                    go work(ch)
                }
                return <-ch + <-ch
            }
            """);

        var gos = Collect<BoundGoStatement>(Body(program, "run"));
        Assert.Equal(2, gos.Count);
        Assert.Null(gos[0].Sink);
        var sink = Assert.IsType<BoundVariableExpression>(gos[1].Sink);
        Assert.Equal("Gsharp.Concurrency.ScopeFrame", sink.Variable.Type.ClrType?.FullName);
    }

    [Fact]
    public void Scope_IsASuspensionPoint_AndTheEntryPointStaysARoot()
    {
        var program = Bind("""
            package P
            func work(ch out chan[int32]) {
                ch <- 1
            }
            func join(ch chan[int32]) {
                scope {
                    go work(ch)
                }
            }
            let ch = chan[int32](1)
            scope {
                go work(ch)
            }
            let v = <-ch
            """);

        Assert.Equal(SuspendingKind.Inferred, program.Functions.Keys.Single(f => f.Name == "join").SuspendingKind);
        var entry = program.Functions.Keys.Single(f => f.IsTopLevelEntryPoint);
        Assert.Equal(SuspendingKind.None, entry.SuspendingKind);
        Assert.Empty(program.Diagnostics);
    }

    [Fact]
    public void GoOperand_YieldingAValue_IsShapedToDiscard()
    {
        var program = Bind("""
            package P
            func compute(ch out chan[int32]) int32 {
                ch <- 1
                return 1
            }
            func run() int32 {
                let ch = chan[int32](1)
                go compute(ch)
                return <-ch
            }
            """);

        var go = Assert.Single(Collect<BoundGoStatement>(Body(program, "run")));
        Assert.Equal("System.Threading.Tasks.ValueTask", go.Expression.Type?.ClrType?.FullName);
        var discard = Assert.IsType<BoundImportedCallExpression>(go.Expression);
        Assert.Equal("Discard", discard.Function.Name);
    }

    private static BoundProgram Bind(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source));
        Assert.Empty(compilation.GlobalScope.Diagnostics.Where(d => d.IsError));
        var program = Binder.BindProgram(compilation.GlobalScope, compilation.References ?? ReferenceResolver.Default());
        Assert.Empty(program.Diagnostics.Where(d => d.IsError).Select(d => d.Message));
        return program;
    }

    private static BoundBlockStatement Body(BoundProgram program, string name)
        => program.Functions.Single(p => p.Key.Name == name).Value;

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
