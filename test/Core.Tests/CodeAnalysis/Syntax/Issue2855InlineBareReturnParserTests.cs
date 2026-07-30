// <copyright file="Issue2855InlineBareReturnParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #2855: a closing brace on the same line terminates a bare
/// <c>return</c>; it must not be parsed as the return expression.
/// </summary>
public class Issue2855InlineBareReturnParserTests
{
    private const string Source = """
        package P

        func Stop(value bool) {
            if value { return }
        }

        Stop(true)
        """;

    [Fact]
    public void SameLineCloseBrace_LeavesBareReturnExpressionNull()
    {
        var tree = SyntaxTree.Parse(Source);

        Assert.Empty(tree.Diagnostics);
        var function = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var ifStatement = Assert.IsType<IfStatementSyntax>(Assert.Single(function.Body.Statements));
        var ifBody = Assert.IsType<BlockStatementSyntax>(ifStatement.ThenStatement);
        var returnStatement = Assert.IsType<ReturnStatementSyntax>(Assert.Single(ifBody.Statements));
        Assert.Null(returnStatement.Expression);
    }

    [Fact]
    public void SameLineCloseBrace_DoesNotProduceReturnBindingDiagnostics()
    {
        var tree = SyntaxTree.Parse(Source);
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        var program = Binder.BindProgram(globalScope);

        Assert.Empty(tree.Diagnostics);
        Assert.Empty(globalScope.Diagnostics);
        Assert.Empty(program.Diagnostics);
    }
}
