// <copyright file="Issue3090AwaitArgumentParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// Parser coverage for issue #3090 nested await call arguments.
class Issue3090AwaitArgumentParserTests {
    @Fact
    func BareAwaitInsideNamedInvocationArgument_Parses() {
        const Source = `package P
async func Run(queue Queue, store Store, id int32, ct CancellationToken) {
    await queue.EnqueueAsync(
        "job",
        priority: 0,
        dueAt: await store.GetDueAtAsync(id, ct),
        ct: ct)
}`
        let tree = SyntaxTree.Parse(Source)
        Assert.Empty(tree.Diagnostics)
        let dueAt = Walk(tree.Root).OfType[NamedArgumentExpressionSyntax]().Single(
            (argument NamedArgumentExpressionSyntax) -> argument.NameToken.Text == "dueAt"
        )
        Assert.IsType[AwaitExpressionSyntax](dueAt.Expression)
    }

    shared {
        private func Walk(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for child in node.GetChildren() {
                for descendant in Walk(child) {
                    yield descendant
                }
            }
        }
    }
}
