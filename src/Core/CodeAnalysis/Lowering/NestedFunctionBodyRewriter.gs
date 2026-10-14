// <copyright file="NestedFunctionBodyRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering

import GSharp.Core.CodeAnalysis.Binding

/// Shared helper for emit-pipeline rewriters whose transforms are lexical-scope
/// agnostic and therefore must run inside hosted nested bodies too.
/// @remarks (cref:BoundTreeRewriter) intentionally does not recurse into
/// (cref:BoundFunctionLiteralExpression.Body) or generic local-function
/// bodies because many callers model lexical scopes. Emit-time lowering passes
/// such as interpolated-string rewriting and side-effect spilling are scope
/// neutral, though: if a top-level body gets the transform, a nested hosted
/// body must get that exact same transform before the emitter sees it.
///
/// This base class provides that shared descent so the emit pipeline does not
/// fork between ordinary bodies and lambda/local-function bodies.
internal abstract class NestedFunctionBodyRewriter : BoundTreeRewriter {
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected open override func RewriteFunctionLiteralExpression(node BoundFunctionLiteralExpression) BoundExpression {
        let body = cast[BoundBlockStatement](this.RewriteStatement(node.Body))
        if object.ReferenceEquals(body, node.Body) {
            return node
        }
        return BoundFunctionLiteralExpression(
            node.Syntax,
            node.Function,
            node.FunctionType,
            body,
            node.CapturedVariables
        )
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected open override func RewriteLocalFunctionDeclaration(node BoundLocalFunctionDeclaration) BoundStatement {
        let literal = cast[BoundFunctionLiteralExpression](this.RewriteFunctionLiteralExpression(node.Literal))
        return if object.ReferenceEquals(literal, node.Literal) {
            node
        } else {
            BoundLocalFunctionDeclaration(node.Syntax, literal)
        }
    }
}
