// <copyright file="NestedFunctionBodyRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Binding;

namespace GSharp.Core.CodeAnalysis.Lowering;

/// <summary>
/// Shared helper for emit-pipeline rewriters whose transforms are lexical-scope
/// agnostic and therefore must run inside hosted nested bodies too.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="BoundTreeRewriter"/> intentionally does not recurse into
/// <see cref="BoundFunctionLiteralExpression.Body"/> or generic local-function
/// bodies because many callers model lexical scopes. Emit-time lowering passes
/// such as interpolated-string rewriting and side-effect spilling are scope
/// neutral, though: if a top-level body gets the transform, a nested hosted
/// body must get that exact same transform before the emitter sees it.
/// </para>
/// <para>
/// This base class provides that shared descent so the emit pipeline does not
/// fork between ordinary bodies and lambda/local-function bodies.
/// </para>
/// </remarks>
internal abstract class NestedFunctionBodyRewriter : BoundTreeRewriter
{
    /// <inheritdoc/>
    protected override BoundExpression RewriteFunctionLiteralExpression(BoundFunctionLiteralExpression node)
    {
        var body = (BoundBlockStatement)this.RewriteStatement(node.Body);
        if (ReferenceEquals(body, node.Body))
        {
            return node;
        }

        return new BoundFunctionLiteralExpression(
            node.Syntax,
            node.Function,
            node.FunctionType,
            body,
            node.CapturedVariables);
    }

    /// <inheritdoc/>
    protected override BoundStatement RewriteLocalFunctionDeclaration(BoundLocalFunctionDeclaration node)
    {
        var literal = (BoundFunctionLiteralExpression)this.RewriteFunctionLiteralExpression(node.Literal);
        return ReferenceEquals(literal, node.Literal)
            ? node
            : new BoundLocalFunctionDeclaration(node.Syntax, literal);
    }
}
