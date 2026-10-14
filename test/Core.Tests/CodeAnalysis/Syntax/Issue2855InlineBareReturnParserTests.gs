// <copyright file="Issue2855InlineBareReturnParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #2855: a closing brace on the same line terminates a bare
/// `return`; it must not be parsed as the return expression.
open class Issue2855InlineBareReturnParserTests {
    @Fact
    func SameLineCloseBrace_LeavesBareReturnExpressionNull() {
        let tree = SyntaxTree.Parse(Source)
        Assert.Empty(tree.Diagnostics)
        let function = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let ifStatement = Assert.IsType[IfStatementSyntax](Assert.Single(function.Body!!.Statements))
        let ifBody = Assert.IsType[BlockStatementSyntax](ifStatement.ThenStatement)
        let returnStatement = Assert.IsType[ReturnStatementSyntax](Assert.Single(ifBody.Statements))
        Assert.Null(returnStatement.Expression)
    }

    @Fact
    func SameLineCloseBrace_DoesNotProduceReturnBindingDiagnostics() {
        let tree = SyntaxTree.Parse(Source)
        let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        let program = Binder.BindProgram(globalScope)
        Assert.Empty(tree.Diagnostics)
        Assert.Empty(globalScope.Diagnostics)
        Assert.Empty(program.Diagnostics)
    }

    shared {
        private const Source string = `package P

func Stop(value bool) {
    if value { return }
}

Stop(true)`
    }
}
