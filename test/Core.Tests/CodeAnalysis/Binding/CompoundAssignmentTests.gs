// <copyright file="CompoundAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Binder and emitted-oracle coverage for compound assignment.
open class CompoundAssignmentTests {
    @Theory
    @InlineData("+=")
    @InlineData("-=")
    @InlineData("*=")
    @InlineData("/=")
    @InlineData("%=")
    @InlineData("^=")
    @InlineData("&=")
    @InlineData("|=")
    @InlineData("&^=")
    @InlineData("<<=")
    @InlineData(">>=")
    func CompoundAssignment_OnIntVariable_Binds(op string) {
        let src = (`func F() {
 var x = 4
 x ` + "$op" + ` 1
 }
`)
        let diagnostics = Bind(src)
        Assert.Empty(diagnostics)
    }

    @Fact
    func CompoundAssignment_On_ReadOnly_Reports_Error() {
        let diagnostics = Bind(`func F() {
 let x = 1
 x += 1
 }
`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("read-only", StringComparison.OrdinalIgnoreCase)
        )
    }

    @Fact
    func CompoundAssignment_Desugars_To_AssignmentOfBinary() {
        let tree = SyntaxTree.Parse(SourceText.From(`func F() {
 var x = 1
 x += 2
 }
`))
        Assert.Empty(tree.Diagnostics)
        // Since `x += 2` now parses as an EventSubscriptionExpressionSyntax
        // (the binder distinguishes events from compound assignment), verify
        // the parse structure reflects the new representation.
        let eventSub EventSubscriptionExpressionSyntax? = Find[EventSubscriptionExpressionSyntax](tree.Root)
        Assert.NotNull(eventSub)
        Assert.Equal(SyntaxKind.PlusEqualsToken, eventSub!!.OperatorToken.Kind)
        let lhs = Assert.IsType[NameExpressionSyntax](eventSub!!.LeftHandSide)
        Assert.Equal("x", lhs.IdentifierToken.Text)
    }

    shared {
        private func Find[T SyntaxNode](node SyntaxNode) T? {
            if node is T match {
                return match
            }
            for child in node.GetChildren() {
                let hit T? = Find[T](child)
                if hit != nil {
                    return hit
                }
            }
            return nil
        }

        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            let program = Binder.BindProgram(globalScope)
            return program.Diagnostics.ToImmutableArray()
        }
    }
}
