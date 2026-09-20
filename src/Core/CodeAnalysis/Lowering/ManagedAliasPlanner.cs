// <copyright file="ManagedAliasPlanner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering;

/// <summary>Saves an admitted alias's descriptor at its original selection site, never at a later use.</summary>
internal sealed class ManagedAliasPlanner : BoundTreeRewriter
{
    internal static BoundBlockStatement Prepare(BoundBlockStatement body)
        => (BoundBlockStatement)new ManagedAliasPlanner().RewriteStatement(body);

    protected override BoundStatement RewriteVariableDeclaration(BoundVariableDeclaration node)
    {
        if (node.Variable is not LocalVariableSymbol { ManagedReferenceStorage: { } saved } alias)
        {
            return base.RewriteVariableDeclaration(node);
        }

        var location = Invariant.Required(alias.ManagedReferenceStorageOrigin, "the binder created the saved descriptor together with its proven origin");
        return new BoundBlockStatement(node.Syntax, ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(node.Syntax, saved, new BoundManagedReferenceExpression(node.Syntax, location, saved.Type, alias.RefKind == RefKind.RefReadOnly)),
            new BoundVariableDeclaration(node.Syntax, alias, ManagedReferenceTypes.Borrow(new BoundVariableExpression(null, saved)), node.ConstantValue)));
    }

    protected override BoundExpression RewriteFunctionLiteralExpression(BoundFunctionLiteralExpression node)
    {
        var body = (BoundBlockStatement)this.RewriteStatement(node.Body);
        return body == node.Body ? node : new BoundFunctionLiteralExpression(node.Syntax, node.Function, node.FunctionType, body, node.CapturedVariables);
    }

    protected override BoundStatement RewriteLocalFunctionDeclaration(BoundLocalFunctionDeclaration node)
    {
        var literal = (BoundFunctionLiteralExpression)this.RewriteFunctionLiteralExpression(node.Literal);
        return literal == node.Literal ? node : new BoundLocalFunctionDeclaration(node.Syntax, literal);
    }
}
