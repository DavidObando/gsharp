// <copyright file="ChannelOperationRewriterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

/// <summary>
/// ADR-0174 D4 (Phase 3-1): <see cref="ChannelOperationRewriter"/> turns the
/// binder's blocking facade calls (<c>ChannelOps.Receive / Receive2 / Send</c>)
/// into awaited <c>ReceiveValueAsync / ReceiveTupleAsync / SendAsync</c> calls
/// of the same type, and leaves a <c>lock</c> body on the blocking lowering.
/// </summary>
public class ChannelOperationRewriterTests
{
    [Fact]
    public void Receive_BecomesAwaitedReceiveValueAsync_OfTheElementType()
    {
        var body = BindAsyncBody("""
            package P
            async func f(ch chan[int32]) int32 {
                let v = <-ch
                return v
            }
            """);

        var rewritten = ChannelOperationRewriter.Rewrite(body.Body, body.References);

        Assert.Empty(FacadeCalls(body.Body, "ReceiveValueAsync"));
        Assert.True(FacadeCalls(body.Body, "Receive").Count == 1, "bound body:\n" + Print(body.Body));
        var await = Assert.Single(Awaits(rewritten));
        var call = Assert.IsType<BoundImportedCallExpression>(await.Expression);
        Assert.Equal("ReceiveValueAsync", call.Function.Name);
        Assert.Equal(TypeSymbol.Int32, await.Type);
        Assert.Contains("ValueTask", call.Type.Name);
        Assert.Empty(FacadeCalls(rewritten, "Receive"));
    }

    [Fact]
    public void Receive2_BecomesAwaitedReceiveTupleAsync_OfTheTupleType()
    {
        var body = BindAsyncBody("""
            package P
            async func f(ch chan[string]) bool {
                let (v, ok) = <-ch
                return ok
            }
            """);

        var rewritten = ChannelOperationRewriter.Rewrite(body.Body, body.References);

        var await = Assert.Single(Awaits(rewritten));
        var call = Assert.IsType<BoundImportedCallExpression>(await.Expression);
        Assert.Equal("ReceiveTupleAsync", call.Function.Name);
        var tuple = Assert.IsType<TupleTypeSymbol>(await.Type);
        Assert.Equal(new[] { TypeSymbol.String, TypeSymbol.Bool }, tuple.ElementTypes);
    }

    [Fact]
    public void Send_BecomesAwaitedSendAsync_TypedVoid()
    {
        var body = BindAsyncBody("""
            package P
            async func f(ch out chan[int32]) {
                ch <- 1
            }
            """);

        var rewritten = ChannelOperationRewriter.Rewrite(body.Body, body.References);

        var await = Assert.Single(Awaits(rewritten));
        var call = Assert.IsType<BoundImportedCallExpression>(await.Expression);
        Assert.Equal("SendAsync", call.Function.Name);
        Assert.Equal(TypeSymbol.Void, await.Type);
        Assert.Equal("ChannelWriter`1", call.Function.Method.GetParameters()[0].ParameterType.GetGenericTypeDefinition().Name);
    }

    [Fact]
    public void ForIn_OverAChannel_BecomesAnAwaitedTupleReceive()
    {
        var body = BindAsyncBody("""
            package P
            async func f(ch in chan[int32]) int32 {
                var sum = 0
                for v in ch {
                    sum = sum + v
                }
                return sum
            }
            """);

        var rewritten = ChannelOperationRewriter.Rewrite(body.Body, body.References);

        var await = Assert.Single(Awaits(rewritten));
        Assert.Equal("ReceiveTupleAsync", Assert.IsType<BoundImportedCallExpression>(await.Expression).Function.Name);
        Assert.Empty(FacadeCalls(rewritten, "Receive2"));
    }

    [Fact]
    public void Receive_InsideLock_StaysBlocking()
    {
        var body = BindAsyncBody("""
            package P
            class Gate {
            }
            async func f(ch chan[int32]) int32 {
                var v = 0
                lock gate {
                    v = <-ch
                }
                return v
            }
            let gate = Gate()
            """);

        var rewritten = ChannelOperationRewriter.Rewrite(body.Body, body.References);

        Assert.Empty(Awaits(rewritten));
        Assert.Single(FacadeCalls(rewritten, "Receive"));
    }

    [Fact]
    public void UserStructElement_KeepsTheSymbolicTypeArgument()
    {
        var body = BindAsyncBody("""
            package P
            struct Pair {
                var X int32
                var Y int32
            }
            async func f(ch chan[Pair]) int32 {
                let p = <-ch
                return p.X
            }
            """);

        var rewritten = ChannelOperationRewriter.Rewrite(body.Body, body.References);

        var await = Assert.Single(Awaits(rewritten));
        var call = Assert.IsType<BoundImportedCallExpression>(await.Expression);
        Assert.Equal("Pair", Assert.Single(call.TypeArgumentSymbols)?.Name);
        Assert.Equal("Pair", await.Type.Name);
        Assert.NotNull(await.AwaiterTypeSymbol);
    }

    private static (BoundBlockStatement Body, ReferenceResolver References) BindAsyncBody(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        var program = Binder.BindProgram(compilation.GlobalScope);
        Assert.False(program.Diagnostics.Any(d => d.IsError), string.Join("; ", program.Diagnostics.Select(d => d.Message)));
        var pair = program.Functions.Single(p => p.Key.Name == "f");
        return (pair.Value, compilation.References ?? ReferenceResolver.Default());
    }

    private static string Print(BoundStatement body)
    {
        using var writer = new System.IO.StringWriter();
        body.WriteTo(writer);
        return writer.ToString();
    }

    private static List<BoundAwaitExpression> Awaits(BoundStatement body)
    {
        var collector = new AwaitCollector();
        collector.Visit(body);
        return collector.Found;
    }

    private static List<BoundImportedCallExpression> FacadeCalls(BoundStatement body, string name)
    {
        var collector = new FacadeCallCollector(name);
        collector.Visit(body);
        return collector.Found;
    }

    private sealed class AwaitCollector : BoundTreeWalker
    {
        public List<BoundAwaitExpression> Found { get; } = new();

        protected override void VisitAwaitExpression(BoundAwaitExpression node)
        {
            Found.Add(node);
            base.VisitAwaitExpression(node);
        }
    }

    private sealed class FacadeCallCollector : BoundTreeWalker
    {
        private readonly string name;

        public FacadeCallCollector(string name)
        {
            this.name = name;
        }

        public List<BoundImportedCallExpression> Found { get; } = new();

        protected override void VisitImportedCallExpression(BoundImportedCallExpression node)
        {
            if (ChannelRuntimeBinder.IsFacadeCall(node, name))
            {
                Found.Add(node);
            }

            base.VisitImportedCallExpression(node);
        }
    }
}
