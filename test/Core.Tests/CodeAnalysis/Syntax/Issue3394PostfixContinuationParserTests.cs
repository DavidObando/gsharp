// <copyright file="Issue3394PostfixContinuationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #3394: postfix increment/decrement results remain valid receivers for
/// member access, calls, and indexing.
/// </summary>
public class Issue3394PostfixContinuationParserTests
{
    [Fact]
    public void PostIncrementResult_CanBeMemberAccessReceiver()
    {
        const string source = """
            package P
            func F() {
                var count = 0
                let text = count++.ToString()
            }
            """;

        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var declaration = tree.Root.Members
            .OfType<FunctionDeclarationSyntax>()
            .Single()
            .Body.Statements
            .OfType<VariableDeclarationSyntax>()
            .Last();
        Assert.IsType<AccessorExpressionSyntax>(declaration.Initializer);
    }
}
