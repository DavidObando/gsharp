// <copyright file="ManagedAliasPlanner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Immutable

/// Saves an admitted alias's descriptor at its original selection site, never at a later use.
internal class ManagedAliasPlanner : BoundTreeRewriter {
    protected override func RewriteVariableDeclaration(node BoundVariableDeclaration) BoundStatement {
        if !(node.Variable is LocalVariableSymbol{ManagedReferenceStorage: {} saved} alias) {
            return base.RewriteVariableDeclaration(node)
        }
        let location = Invariant.Required(
            alias.ManagedReferenceStorageOrigin,
            "the binder created the saved descriptor together with its proven origin",
            expression: "alias.ManagedReferenceStorageOrigin"
        )
        return BoundBlockStatement(
            node.Syntax,
            ImmutableArray.Create[BoundStatement](
                BoundVariableDeclaration(
                    node.Syntax,
                    saved,
                    BoundManagedReferenceExpression(
                        node.Syntax,
                        location,
                        saved.Type,
                        alias.RefKind == RefKind.RefReadOnly
                    )
                ),
                BoundVariableDeclaration(
                    node.Syntax,
                    alias,
                    ManagedReferenceTypes.Borrow(BoundVariableExpression(nil, saved)),
                    node.ConstantValue
                )
            )
        )
    }

    protected override func RewriteFunctionLiteralExpression(node BoundFunctionLiteralExpression) BoundExpression {
        let body = cast[BoundBlockStatement](this.RewriteStatement(node.Body))
        return if body == node.Body {
            node
        } else {
            BoundFunctionLiteralExpression(node.Syntax, node.Function, node.FunctionType, body, node.CapturedVariables)
        }
    }

    protected override func RewriteLocalFunctionDeclaration(node BoundLocalFunctionDeclaration) BoundStatement {
        let literal = cast[BoundFunctionLiteralExpression](this.RewriteFunctionLiteralExpression(node.Literal))
        return if literal == node.Literal {
            node
        } else {
            BoundLocalFunctionDeclaration(node.Syntax, literal)
        }
    }

    shared {
        internal func Prepare(body BoundBlockStatement) BoundBlockStatement -> cast[BoundBlockStatement](
            ManagedAliasPlanner().RewriteStatement(body)
        )

        internal func Prepare(expression BoundExpression) BoundExpression -> ManagedAliasPlanner().RewriteExpression(
            expression
        )
    }
}
