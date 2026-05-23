// <copyright file="BoundTreeRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Abstract bound tree rewriter.
/// </summary>
public abstract class BoundTreeRewriter
{
    /// <summary>
    /// Reweites bound statements.
    /// </summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    public virtual BoundStatement RewriteStatement(BoundStatement node)
    {
        switch (node.Kind)
        {
            case BoundNodeKind.BlockStatement:
                return RewriteBlockStatement((BoundBlockStatement)node);
            case BoundNodeKind.VariableDeclaration:
                return RewriteVariableDeclaration((BoundVariableDeclaration)node);
            case BoundNodeKind.IfStatement:
                return RewriteIfStatement((BoundIfStatement)node);
            case BoundNodeKind.ForInfiniteStatement:
                return RewriteForInfiniteStatement((BoundForInfiniteStatement)node);
            case BoundNodeKind.ForEllipsisStatement:
                return RewriteForEllipsisStatement((BoundForEllipsisStatement)node);
            case BoundNodeKind.LabelStatement:
                return RewriteLabelStatement((BoundLabelStatement)node);
            case BoundNodeKind.GotoStatement:
                return RewriteGotoStatement((BoundGotoStatement)node);
            case BoundNodeKind.ConditionalGotoStatement:
                return RewriteConditionalGotoStatement((BoundConditionalGotoStatement)node);
            case BoundNodeKind.ReturnStatement:
                return RewriteReturnStatement((BoundReturnStatement)node);
            case BoundNodeKind.ExpressionStatement:
                return RewriteExpressionStatement((BoundExpressionStatement)node);
            case BoundNodeKind.TryStatement:
                return RewriteTryStatement((BoundTryStatement)node);
            case BoundNodeKind.ThrowStatement:
                return RewriteThrowStatement((BoundThrowStatement)node);
            default:
                throw new Exception($"Unexpected node: {node.Kind}");
        }
    }

    /// <summary>
    /// Rewrites a block statement.
    /// </summary>
    /// <param name="node">The block statement to rewrite.</param>
    /// <returns>The rewritten block statement.</returns>
    protected virtual BoundStatement RewriteBlockStatement(BoundBlockStatement node)
    {
        ImmutableArray<BoundStatement>.Builder builder = null;

        for (var i = 0; i < node.Statements.Length; i++)
        {
            var oldStatement = node.Statements[i];
            var newStatement = RewriteStatement(oldStatement);
            if (newStatement != oldStatement)
            {
                if (builder == null)
                {
                    builder = ImmutableArray.CreateBuilder<BoundStatement>(node.Statements.Length);

                    for (var j = 0; j < i; j++)
                    {
                        builder.Add(node.Statements[j]);
                    }
                }
            }

            if (builder != null)
            {
                builder.Add(newStatement);
            }
        }

        if (builder == null)
        {
            return node;
        }

        return new BoundBlockStatement(builder.MoveToImmutable());
    }

    /// <summary>
    /// Rewrites a variable declaration.
    /// </summary>
    /// <param name="node">The variable declaration to rewrite.</param>
    /// <returns>The rewritten variable declaration.</returns>
    protected virtual BoundStatement RewriteVariableDeclaration(BoundVariableDeclaration node)
    {
        var initializer = RewriteExpression(node.Initializer);
        if (initializer == node.Initializer)
        {
            return node;
        }

        return new BoundVariableDeclaration(node.Variable, initializer);
    }

    /// <summary>
    /// Rewrites an if statement.
    /// </summary>
    /// <param name="node">The if statement to rewrite.</param>
    /// <returns>The rewritten if statement.</returns>
    protected virtual BoundStatement RewriteIfStatement(BoundIfStatement node)
    {
        var condition = RewriteExpression(node.Condition);
        var thenStatement = RewriteStatement(node.ThenStatement);
        var elseStatement = node.ElseStatement == null ? null : RewriteStatement(node.ElseStatement);
        if (condition == node.Condition && thenStatement == node.ThenStatement && elseStatement == node.ElseStatement)
        {
            return node;
        }

        return new BoundIfStatement(condition, thenStatement, elseStatement);
    }

    /// <summary>
    /// Rewrites a for infinite statement.
    /// </summary>
    /// <param name="node">The for infinite statement to rewrite.</param>
    /// <returns>The rewritten for infinite statement.</returns>
    protected virtual BoundStatement RewriteForInfiniteStatement(BoundForInfiniteStatement node)
    {
        var body = RewriteStatement(node.Body);
        if (body == node.Body)
        {
            return node;
        }

        return new BoundForInfiniteStatement(body, node.BreakLabel, node.ContinueLabel);
    }

    /// <summary>
    /// Rewrites a for ellipsis statement.
    /// </summary>
    /// <param name="node">The for ellipsis statement to rewrite.</param>
    /// <returns>The rewritten for ellipsis statement.</returns>
    protected virtual BoundStatement RewriteForEllipsisStatement(BoundForEllipsisStatement node)
    {
        var lowerBound = RewriteExpression(node.LowerBound);
        var upperBound = RewriteExpression(node.UpperBound);
        var body = RewriteStatement(node.Body);
        if (lowerBound == node.LowerBound && upperBound == node.UpperBound && body == node.Body)
        {
            return node;
        }

        return new BoundForEllipsisStatement(node.Variable, lowerBound, upperBound, body, node.BreakLabel, node.ContinueLabel);
    }

    /// <summary>
    /// Rewrites a label statement.
    /// </summary>
    /// <param name="node">The label statement to rewrite.</param>
    /// <returns>The rewritten label statement.</returns>
    protected virtual BoundStatement RewriteLabelStatement(BoundLabelStatement node)
    {
        return node;
    }

    /// <summary>
    /// Rewrites a goto statement.
    /// </summary>
    /// <param name="node">The goto statement to rewrite.</param>
    /// <returns>The rewritten goto statement.</returns>
    protected virtual BoundStatement RewriteGotoStatement(BoundGotoStatement node)
    {
        return node;
    }

    /// <summary>
    /// Rewrites a conditional goto statement.
    /// </summary>
    /// <param name="node">The conditional goto statement to rewrite.</param>
    /// <returns>The rewritten conditional goto statement.</returns>
    protected virtual BoundStatement RewriteConditionalGotoStatement(BoundConditionalGotoStatement node)
    {
        var condition = RewriteExpression(node.Condition);
        if (condition == node.Condition)
        {
            return node;
        }

        return new BoundConditionalGotoStatement(node.Label, condition, node.JumpIfTrue);
    }

    /// <summary>
    /// Rewrites a return statement.
    /// </summary>
    /// <param name="node">The return statement to rewrite.</param>
    /// <returns>The rewritten return statement.</returns>
    protected virtual BoundStatement RewriteReturnStatement(BoundReturnStatement node)
    {
        var expression = node.Expression == null ? null : RewriteExpression(node.Expression);
        if (expression == node.Expression)
        {
            return node;
        }

        return new BoundReturnStatement(expression);
    }

    /// <summary>
    /// Rewrites an expression statement.
    /// </summary>
    /// <param name="node">The expression statement to rewrite.</param>
    /// <returns>The rewritten expression statement.</returns>
    protected virtual BoundStatement RewriteExpressionStatement(BoundExpressionStatement node)
    {
        var expression = RewriteExpression(node.Expression);
        if (expression == node.Expression)
        {
            return node;
        }

        return new BoundExpressionStatement(expression);
    }

    /// <summary>
    /// Rewrites a try statement.
    /// </summary>
    /// <param name="node">The try statement to rewrite.</param>
    /// <returns>The rewritten statement.</returns>
    protected virtual BoundStatement RewriteTryStatement(BoundTryStatement node)
    {
        var tryBlock = RewriteStatement(node.TryBlock);

        var rewrittenClauses = ImmutableArray.CreateBuilder<BoundCatchClause>();
        var clausesChanged = false;
        foreach (var clause in node.CatchClauses)
        {
            var body = RewriteStatement(clause.Body);
            if (body == clause.Body)
            {
                rewrittenClauses.Add(clause);
            }
            else
            {
                rewrittenClauses.Add(new BoundCatchClause(clause.ExceptionType, clause.Variable, body));
                clausesChanged = true;
            }
        }

        var finallyBlock = node.FinallyBlock == null ? null : RewriteStatement(node.FinallyBlock);

        if (tryBlock == node.TryBlock && !clausesChanged && finallyBlock == node.FinallyBlock)
        {
            return node;
        }

        return new BoundTryStatement(tryBlock, rewrittenClauses.ToImmutable(), finallyBlock);
    }

    /// <summary>
    /// Rewrites a throw statement.
    /// </summary>
    /// <param name="node">The throw statement to rewrite.</param>
    /// <returns>The rewritten statement.</returns>
    protected virtual BoundStatement RewriteThrowStatement(BoundThrowStatement node)
    {
        var expression = RewriteExpression(node.Expression);
        if (expression == node.Expression)
        {
            return node;
        }

        return new BoundThrowStatement(expression);
    }

    /// <summary>
    /// Rewrites an expression.
    /// </summary>
    /// <param name="node">The expression to rewrite.</param>
    /// <returns>The rewritten expression.</returns>
    protected virtual BoundExpression RewriteExpression(BoundExpression node)
    {
        switch (node.Kind)
        {
            case BoundNodeKind.ErrorExpression:
                return RewriteErrorExpression((BoundErrorExpression)node);
            case BoundNodeKind.LiteralExpression:
                return RewriteLiteralExpression((BoundLiteralExpression)node);
            case BoundNodeKind.VariableExpression:
                return RewriteVariableExpression((BoundVariableExpression)node);
            case BoundNodeKind.AssignmentExpression:
                return RewriteAssignmentExpression((BoundAssignmentExpression)node);
            case BoundNodeKind.UnaryExpression:
                return RewriteUnaryExpression((BoundUnaryExpression)node);
            case BoundNodeKind.BinaryExpression:
                return RewriteBinaryExpression((BoundBinaryExpression)node);
            case BoundNodeKind.CallExpression:
                return RewriteCallExpression((BoundCallExpression)node);
            case BoundNodeKind.ConversionExpression:
                return RewriteConversionExpression((BoundConversionExpression)node);
            case BoundNodeKind.ImportedCallExpression:
                return RewriteImportedCallExpression((BoundImportedCallExpression)node);
            case BoundNodeKind.ImportedInstanceCallExpression:
                return RewriteImportedInstanceCallExpression((BoundImportedInstanceCallExpression)node);
            case BoundNodeKind.ArrayCreationExpression:
                return RewriteArrayCreationExpression((BoundArrayCreationExpression)node);
            case BoundNodeKind.IndexExpression:
                return RewriteIndexExpression((BoundIndexExpression)node);
            case BoundNodeKind.IndexAssignmentExpression:
                return RewriteIndexAssignmentExpression((BoundIndexAssignmentExpression)node);
            case BoundNodeKind.LenExpression:
                return RewriteLenExpression((BoundLenExpression)node);
            case BoundNodeKind.CapExpression:
                return RewriteCapExpression((BoundCapExpression)node);
            case BoundNodeKind.AppendExpression:
                return RewriteAppendExpression((BoundAppendExpression)node);
            case BoundNodeKind.StructLiteralExpression:
                return RewriteStructLiteralExpression((BoundStructLiteralExpression)node);
            case BoundNodeKind.ConstructorCallExpression:
                return RewriteConstructorCallExpression((BoundConstructorCallExpression)node);
            case BoundNodeKind.UserInstanceCallExpression:
                return RewriteUserInstanceCallExpression((BoundUserInstanceCallExpression)node);
            case BoundNodeKind.FieldAccessExpression:
                return RewriteFieldAccessExpression((BoundFieldAccessExpression)node);
            case BoundNodeKind.FieldAssignmentExpression:
                return RewriteFieldAssignmentExpression((BoundFieldAssignmentExpression)node);
            case BoundNodeKind.NullConditionalAccessExpression:
                return RewriteNullConditionalAccessExpression((BoundNullConditionalAccessExpression)node);
            default:
                throw new Exception($"Unexpected node: {node.Kind}");
        }
    }

    /// <summary>
    /// Rewrites an error expression.
    /// </summary>
    /// <param name="node">The error expression to rewrite.</param>
    /// <returns>The rewritten error expression.</returns>
    protected virtual BoundExpression RewriteErrorExpression(BoundErrorExpression node)
    {
        return node;
    }

    /// <summary>
    /// Rewrites a literal expression.
    /// </summary>
    /// <param name="node">The literal expression to rewrite.</param>
    /// <returns>The rewritten literal expression.</returns>
    protected virtual BoundExpression RewriteLiteralExpression(BoundLiteralExpression node)
    {
        return node;
    }

    /// <summary>
    /// Rewrites a variable expression.
    /// </summary>
    /// <param name="node">The variable expression to rewrite.</param>
    /// <returns>The rewritten variable expression.</returns>
    protected virtual BoundExpression RewriteVariableExpression(BoundVariableExpression node)
    {
        return node;
    }

    /// <summary>
    /// Rewrites an assignment expression.
    /// </summary>
    /// <param name="node">The assignment expression to rewrite.</param>
    /// <returns>The rewritten assignment expression.</returns>
    protected virtual BoundExpression RewriteAssignmentExpression(BoundAssignmentExpression node)
    {
        var expression = RewriteExpression(node.Expression);
        if (expression == node.Expression)
        {
            return node;
        }

        return new BoundAssignmentExpression(node.Variable, expression);
    }

    /// <summary>
    /// Rewrites a unary expression.
    /// </summary>
    /// <param name="node">The unary expression to rewrite.</param>
    /// <returns>The rewritten unary expression.</returns>
    protected virtual BoundExpression RewriteUnaryExpression(BoundUnaryExpression node)
    {
        var operand = RewriteExpression(node.Operand);
        if (operand == node.Operand)
        {
            return node;
        }

        return new BoundUnaryExpression(node.Op, operand);
    }

    /// <summary>
    /// Rewrites a binary expression.
    /// </summary>
    /// <param name="node">The binary expression to rewrite.</param>
    /// <returns>The rewritten binary expression.</returns>
    protected virtual BoundExpression RewriteBinaryExpression(BoundBinaryExpression node)
    {
        var left = RewriteExpression(node.Left);
        var right = RewriteExpression(node.Right);
        if (left == node.Left && right == node.Right)
        {
            return node;
        }

        return new BoundBinaryExpression(left, node.Op, right);
    }

    /// <summary>
    /// Rewrites a call expression.
    /// </summary>
    /// <param name="node">The call expression to rewrite.</param>
    /// <returns>The rewritten call expression.</returns>
    protected virtual BoundExpression RewriteCallExpression(BoundCallExpression node)
    {
        ImmutableArray<BoundExpression>.Builder builder = null;

        for (var i = 0; i < node.Arguments.Length; i++)
        {
            var oldArgument = node.Arguments[i];
            var newArgument = RewriteExpression(oldArgument);
            if (newArgument != oldArgument)
            {
                if (builder == null)
                {
                    builder = ImmutableArray.CreateBuilder<BoundExpression>(node.Arguments.Length);

                    for (var j = 0; j < i; j++)
                    {
                        builder.Add(node.Arguments[j]);
                    }
                }
            }

            if (builder != null)
            {
                builder.Add(newArgument);
            }
        }

        if (builder == null)
        {
            return node;
        }

        return new BoundCallExpression(node.Function, builder.MoveToImmutable());
    }

    /// <summary>
    /// Rewrites a conversion expression.
    /// </summary>
    /// <param name="node">The conversion expression to rewrite.</param>
    /// <returns>The rewritten conversion expression.</returns>
    protected virtual BoundExpression RewriteConversionExpression(BoundConversionExpression node)
    {
        var expression = RewriteExpression(node.Expression);
        if (expression == node.Expression)
        {
            return node;
        }

        return new BoundConversionExpression(node.Type, expression);
    }

    /// <summary>
    /// Rewrites an imported call expression.
    /// </summary>
    /// <param name="node">The imported call expression to rewrite.</param>
    /// <returns>The rewritten imported call expression.</returns>
    protected virtual BoundExpression RewriteImportedCallExpression(BoundImportedCallExpression node)
    {
        ImmutableArray<BoundExpression>.Builder builder = null;

        for (var i = 0; i < node.Arguments.Length; i++)
        {
            var oldArgument = node.Arguments[i];
            var newArgument = RewriteExpression(oldArgument);
            if (newArgument != oldArgument)
            {
                if (builder == null)
                {
                    builder = ImmutableArray.CreateBuilder<BoundExpression>(node.Arguments.Length);

                    for (var j = 0; j < i; j++)
                    {
                        builder.Add(node.Arguments[j]);
                    }
                }
            }

            if (builder != null)
            {
                builder.Add(newArgument);
            }
        }

        if (builder == null)
        {
            return node;
        }

        return new BoundImportedCallExpression(node.Function, builder.MoveToImmutable());
    }

    /// <summary>
    /// Rewrites an imported instance call expression.
    /// </summary>
    /// <param name="node">The imported instance call expression to rewrite.</param>
    /// <returns>The rewritten expression.</returns>
    protected virtual BoundExpression RewriteImportedInstanceCallExpression(BoundImportedInstanceCallExpression node)
    {
        var newReceiver = RewriteExpression(node.Receiver);
        ImmutableArray<BoundExpression>.Builder builder = null;

        for (var i = 0; i < node.Arguments.Length; i++)
        {
            var oldArgument = node.Arguments[i];
            var newArgument = RewriteExpression(oldArgument);
            if (newArgument != oldArgument)
            {
                if (builder == null)
                {
                    builder = ImmutableArray.CreateBuilder<BoundExpression>(node.Arguments.Length);

                    for (var j = 0; j < i; j++)
                    {
                        builder.Add(node.Arguments[j]);
                    }
                }
            }

            if (builder != null)
            {
                builder.Add(newArgument);
            }
        }

        var args = builder?.MoveToImmutable() ?? node.Arguments;
        if (newReceiver == node.Receiver && builder == null)
        {
            return node;
        }

        return new BoundImportedInstanceCallExpression(newReceiver, node.Method, node.Type, args);
    }

    /// <summary>Rewrites an array creation expression.</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteArrayCreationExpression(BoundArrayCreationExpression node)
    {
        ImmutableArray<BoundExpression>.Builder builder = null;
        for (var i = 0; i < node.Elements.Length; i++)
        {
            var oldEl = node.Elements[i];
            var newEl = RewriteExpression(oldEl);
            if (newEl != oldEl && builder == null)
            {
                builder = ImmutableArray.CreateBuilder<BoundExpression>(node.Elements.Length);
                for (var j = 0; j < i; j++)
                {
                    builder.Add(node.Elements[j]);
                }
            }

            builder?.Add(newEl);
        }

        return builder == null ? node : new BoundArrayCreationExpression(node.ContainerType, builder.MoveToImmutable());
    }

    /// <summary>Rewrites an index expression.</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteIndexExpression(BoundIndexExpression node)
    {
        var target = RewriteExpression(node.Target);
        var index = RewriteExpression(node.Index);
        if (target == node.Target && index == node.Index)
        {
            return node;
        }

        return new BoundIndexExpression(target, index, node.Type);
    }

    /// <summary>Rewrites an index assignment expression.</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteIndexAssignmentExpression(BoundIndexAssignmentExpression node)
    {
        var index = RewriteExpression(node.Index);
        var value = RewriteExpression(node.Value);
        if (index == node.Index && value == node.Value)
        {
            return node;
        }

        return new BoundIndexAssignmentExpression(node.Target, index, value, node.Type);
    }

    /// <summary>Rewrites a <c>len(x)</c> expression.</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteLenExpression(BoundLenExpression node)
    {
        var operand = RewriteExpression(node.Operand);
        return operand == node.Operand ? node : new BoundLenExpression(operand);
    }

    /// <summary>Rewrites a <c>cap(x)</c> expression.</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteCapExpression(BoundCapExpression node)
    {
        var operand = RewriteExpression(node.Operand);
        return operand == node.Operand ? node : new BoundCapExpression(operand);
    }

    /// <summary>Rewrites an <c>append(s, e)</c> expression.</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteAppendExpression(BoundAppendExpression node)
    {
        var slice = RewriteExpression(node.Slice);
        var element = RewriteExpression(node.Element);
        if (slice == node.Slice && element == node.Element)
        {
            return node;
        }

        return new BoundAppendExpression(slice, element, node.SliceType);
    }

    /// <summary>Rewrites a struct composite literal.</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteStructLiteralExpression(BoundStructLiteralExpression node)
    {
        ImmutableArray<BoundFieldInitializer>.Builder builder = null;
        for (var i = 0; i < node.Initializers.Length; i++)
        {
            var init = node.Initializers[i];
            var newValue = RewriteExpression(init.Value);
            if (newValue != init.Value && builder == null)
            {
                builder = ImmutableArray.CreateBuilder<BoundFieldInitializer>(node.Initializers.Length);
                for (var j = 0; j < i; j++)
                {
                    builder.Add(node.Initializers[j]);
                }
            }

            if (builder != null)
            {
                builder.Add(newValue == init.Value ? init : new BoundFieldInitializer(init.Field, newValue));
            }
        }

        return builder == null ? node : new BoundStructLiteralExpression(node.StructType, builder.ToImmutable());
    }

    /// <summary>Rewrites a class primary-constructor call.</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteConstructorCallExpression(BoundConstructorCallExpression node)
    {
        ImmutableArray<BoundExpression>.Builder builder = null;
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            var oldArg = node.Arguments[i];
            var newArg = RewriteExpression(oldArg);
            if (newArg != oldArg && builder == null)
            {
                builder = ImmutableArray.CreateBuilder<BoundExpression>(node.Arguments.Length);
                for (var j = 0; j < i; j++)
                {
                    builder.Add(node.Arguments[j]);
                }
            }

            if (builder != null)
            {
                builder.Add(newArg);
            }
        }

        return builder == null ? node : new BoundConstructorCallExpression(node.StructType, builder.ToImmutable());
    }

    /// <summary>Rewrites an instance-method call on a user-defined class.</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteUserInstanceCallExpression(BoundUserInstanceCallExpression node)
    {
        var receiver = RewriteExpression(node.Receiver);
        ImmutableArray<BoundExpression>.Builder builder = null;
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            var oldArg = node.Arguments[i];
            var newArg = RewriteExpression(oldArg);
            if (newArg != oldArg && builder == null)
            {
                builder = ImmutableArray.CreateBuilder<BoundExpression>(node.Arguments.Length);
                for (var j = 0; j < i; j++)
                {
                    builder.Add(node.Arguments[j]);
                }
            }

            if (builder != null)
            {
                builder.Add(newArg);
            }
        }

        if (receiver == node.Receiver && builder == null)
        {
            return node;
        }

        return new BoundUserInstanceCallExpression(receiver, node.Method, builder?.ToImmutable() ?? node.Arguments);
    }

    /// <summary>Rewrites a field read.</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteFieldAccessExpression(BoundFieldAccessExpression node)
    {
        var receiver = RewriteExpression(node.Receiver);
        return receiver == node.Receiver ? node : new BoundFieldAccessExpression(receiver, node.StructType, node.Field);
    }

    /// <summary>Rewrites a field assignment.</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteFieldAssignmentExpression(BoundFieldAssignmentExpression node)
    {
        var value = RewriteExpression(node.Value);
        return value == node.Value ? node : new BoundFieldAssignmentExpression(node.Receiver, node.StructType, node.Field, value);
    }

    /// <summary>Rewrites a null-conditional access expression (Phase 3.C.3b).</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteNullConditionalAccessExpression(BoundNullConditionalAccessExpression node)
    {
        var receiver = RewriteExpression(node.Receiver);
        var whenNotNull = RewriteExpression(node.WhenNotNull);
        if (receiver == node.Receiver && whenNotNull == node.WhenNotNull)
        {
            return node;
        }

        return new BoundNullConditionalAccessExpression(receiver, node.Capture, whenNotNull, node.Type);
    }
}
