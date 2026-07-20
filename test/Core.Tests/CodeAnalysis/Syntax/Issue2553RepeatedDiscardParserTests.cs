// <copyright file="Issue2553RepeatedDiscardParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

public class Issue2553RepeatedDiscardParserTests
{
    [Fact]
    public void RepeatedDiscards_ParseInTupleLetAssignmentAndLoop()
    {
        const string source = """
            package p
            func F() {
                var value = 0
                let (kept, _, _) = (1, 2, 3)
                value, _, _ = 4, 5, 6
                for (item, _, _) in [1](int32, int32, int32){(7, 8, 9)} {
                }
            }
            """;

        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var body = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single().Body;
        var tupleLet = Assert.IsType<TupleDeconstructionStatementSyntax>(body.Statements[1]);
        Assert.Equal(new[] { "kept", "_", "_" }, tupleLet.Identifiers.Select(token => token.Text));
        var assignment = Assert.IsType<MultiAssignmentStatementSyntax>(body.Statements[2]);
        Assert.Equal(new[] { "value", "_", "_" }, assignment.Targets.Cast<NameExpressionSyntax>().Select(target => target.IdentifierToken.Text));
        var loop = Assert.IsType<ForTupleRangeStatementSyntax>(body.Statements[3]);
        Assert.Equal(new[] { "item", "_", "_" }, loop.Identifiers.Select(token => token.Text));
    }
}
