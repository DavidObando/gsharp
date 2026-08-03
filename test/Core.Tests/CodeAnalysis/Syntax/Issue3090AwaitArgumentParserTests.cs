// <copyright file="Issue3090AwaitArgumentParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>Parser coverage for issue #3090 nested await call arguments.</summary>
public sealed class Issue3090AwaitArgumentParserTests
{
    [Fact]
    public void BareAwaitInsideNamedInvocationArgument_Parses()
    {
        const string Source = """
            package P
            async func Run(queue Queue, store Store, id int32, ct CancellationToken) {
                await queue.EnqueueAsync(
                    "job",
                    priority: 0,
                    dueAt: await store.GetDueAtAsync(id, ct),
                    ct: ct)
            }
            """;

        var tree = SyntaxTree.Parse(Source);

        Assert.Empty(tree.Diagnostics);
        NamedArgumentExpressionSyntax dueAt = Walk(tree.Root)
            .OfType<NamedArgumentExpressionSyntax>()
            .Single(argument => argument.NameToken.Text == "dueAt");
        Assert.IsType<AwaitExpressionSyntax>(dueAt.Expression);
    }

    private static IEnumerable<SyntaxNode> Walk(SyntaxNode node)
    {
        yield return node;
        foreach (SyntaxNode child in node.GetChildren())
        {
            foreach (SyntaxNode descendant in Walk(child))
            {
                yield return descendant;
            }
        }
    }
}
