// <copyright file="ChannelOperationRewriterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// ADR-0174 D4 (Phase 3-1): (cref:ChannelOperationRewriter) turns the
/// binder's blocking facade calls (`ChannelOps.Receive / Receive2 / Send`)
/// into awaited `ReceiveValueAsync / ReceiveTupleAsync / SendAsync` calls
/// of the same type, and leaves a `lock` body on the blocking lowering.
open class ChannelOperationRewriterTests {
    @Fact
    func Receive_BecomesAwaitedReceiveValueAsync_OfTheElementType() {
        let body = BindAsyncBody(`package P
async func f(ch chan[int32]) int32 {
    let v = <-ch
    return v
}`)
        let rewritten = ChannelOperationRewriter.Rewrite(body.Body, body.References)
        Assert.Empty(FacadeCalls(body.Body, "ReceiveValueAsync"))
        Assert.True(FacadeCalls(body.Body, "Receive").Count == 1, "bound body:\n" + Print(body.Body))
        let await_ = Assert.Single(Awaits(rewritten))
        let call = Assert.IsType[BoundImportedCallExpression](await_.Expression)
        Assert.Equal("ReceiveValueAsync", call.Function.Name)
        Assert.Equal(TypeSymbol.Int32, await_.Type)
        Assert.Contains("ValueTask", call.Type.Name)
        Assert.Empty(FacadeCalls(rewritten, "Receive"))
    }

    @Fact
    func Receive2_BecomesAwaitedReceiveTupleAsync_OfTheTupleType() {
        let body = BindAsyncBody(`package P
async func f(ch chan[string]) bool {
    let (v, ok) = <-ch
    return ok
}`)
        let rewritten = ChannelOperationRewriter.Rewrite(body.Body, body.References)
        let await_ = Assert.Single(Awaits(rewritten))
        let call = Assert.IsType[BoundImportedCallExpression](await_.Expression)
        Assert.Equal("ReceiveTupleAsync", call.Function.Name)
        let tuple = Assert.IsType[TupleTypeSymbol](await_.Type)
        Assert.Equal([]TypeSymbol{TypeSymbol.String, TypeSymbol.Bool}, tuple.ElementTypes)
    }

    @Fact
    func Send_BecomesAwaitedSendAsync_TypedVoid() {
        let body = BindAsyncBody(`package P
async func f(ch out chan[int32]) {
    ch <- 1
}`)
        let rewritten = ChannelOperationRewriter.Rewrite(body.Body, body.References)
        let await_ = Assert.Single(Awaits(rewritten))
        let call = Assert.IsType[BoundImportedCallExpression](await_.Expression)
        Assert.Equal("SendAsync", call.Function.Name)
        Assert.Equal(TypeSymbol.Void, await_.Type)
        Assert.Equal(
            "ChannelWriter`1",
            call.Function.Method.GetParameters()[0].ParameterType.GetGenericTypeDefinition().Name
        )
    }

    @Fact
    func ForIn_OverAChannel_BecomesAnAwaitedTupleReceive() {
        let body = BindAsyncBody(`package P
async func f(ch in chan[int32]) int32 {
    var sum = 0
    for v in ch {
        sum = sum + v
    }
    return sum
}`)
        let rewritten = ChannelOperationRewriter.Rewrite(body.Body, body.References)
        let await_ = Assert.Single(Awaits(rewritten))
        Assert.Equal("ReceiveTupleAsync", Assert.IsType[BoundImportedCallExpression](await_.Expression).Function.Name)
        Assert.Empty(FacadeCalls(rewritten, "Receive2"))
    }

    @Fact
    func Receive_InsideLock_StaysBlocking() {
        let body = BindAsyncBody(`package P
class Gate {
}
async func f(ch chan[int32]) int32 {
    var v = 0
    lock gate {
        v = <-ch
    }
    return v
}
let gate = Gate()`)
        let rewritten = ChannelOperationRewriter.Rewrite(body.Body, body.References)
        Assert.Empty(Awaits(rewritten))
        Assert.Single(FacadeCalls(rewritten, "Receive"))
    }

    @Fact
    func UserStructElement_KeepsTheSymbolicTypeArgument() {
        let body = BindAsyncBody(`package P
struct Pair {
    var X int32
    var Y int32
}
async func f(ch chan[Pair]) int32 {
    let p = <-ch
    return p.X
}`)
        let rewritten = ChannelOperationRewriter.Rewrite(body.Body, body.References)
        let await_ = Assert.Single(Awaits(rewritten))
        let call = Assert.IsType[BoundImportedCallExpression](await_.Expression)
        Assert.Equal("Pair", Assert.Single(call.TypeArgumentSymbols)?.Name)
        Assert.Equal("Pair", await_.Type.Name)
        Assert.NotNull(await_.AwaiterTypeSymbol)
    }

    private class AwaitCollector : BoundTreeWalker {
        init() {
            Found = List[BoundAwaitExpression]()
        }

        prop Found List[BoundAwaitExpression] {
            get;
        }

        protected override func VisitAwaitExpression(node BoundAwaitExpression) {
            Found.Add(node)
            base.VisitAwaitExpression(node)
        }
    }

    private class FacadeCallCollector : BoundTreeWalker {
        private let name string

        init(name string) {
            Found = List[BoundImportedCallExpression]()
            this.name = name
        }

        prop Found List[BoundImportedCallExpression] {
            get;
        }

        protected override func VisitImportedCallExpression(node BoundImportedCallExpression) {
            if ChannelRuntimeBinder.IsFacadeCall(node, name) {
                Found.Add(node)
            }
            base.VisitImportedCallExpression(node)
        }
    }

    shared {
        private func BindAsyncBody(source string)(Body BoundBlockStatement, References ReferenceResolver) {
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
            let program = Binder.BindProgram(compilation.GlobalScope)
            Assert.False(
                program.Diagnostics.Any((d Diagnostic) -> d.IsError),
                string.Join("; ", program.Diagnostics.Select((d Diagnostic) -> d.Message))
            )
            let pair = program.Functions.Single(
                (p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == "f"
            )
            return (pair.Value, compilation.References ?? ReferenceResolver.Default())
        }

        private func Print(body BoundStatement) string {
            using let writer = StringWriter()
            BoundNodePrinter.WriteTo(body, writer)
            return writer.ToString()
        }

        private func Awaits(body BoundStatement) List[BoundAwaitExpression] {
            let collector = AwaitCollector()
            collector.Visit(body)
            return collector.Found
        }

        private func FacadeCalls(body BoundStatement, name string) List[BoundImportedCallExpression] {
            let collector = FacadeCallCollector(name)
            collector.Visit(body)
            return collector.Found
        }
    }
}
