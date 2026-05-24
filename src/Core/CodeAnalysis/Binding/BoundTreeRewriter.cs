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
            case BoundNodeKind.ForRangeStatement:
                return RewriteForRangeStatement((BoundForRangeStatement)node);
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
            case BoundNodeKind.GoStatement:
                return RewriteGoStatement((BoundGoStatement)node);
            case BoundNodeKind.ChannelSendStatement:
                return RewriteChannelSendStatement((BoundChannelSendStatement)node);
            case BoundNodeKind.SelectStatement:
                return RewriteSelectStatement((BoundSelectStatement)node);
            case BoundNodeKind.ScopeStatement:
                return RewriteScopeStatement((BoundScopeStatement)node);
            case BoundNodeKind.AwaitForRangeStatement:
                return RewriteAwaitForRangeStatement((BoundAwaitForRangeStatement)node);
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
    /// Rewrites a for-range statement.
    /// </summary>
    /// <param name="node">The for-range statement to rewrite.</param>
    /// <returns>The rewritten for-range statement.</returns>
    protected virtual BoundStatement RewriteForRangeStatement(BoundForRangeStatement node)
    {
        var collection = RewriteExpression(node.Collection);
        var body = RewriteStatement(node.Body);
        if (collection == node.Collection && body == node.Body)
        {
            return node;
        }

        return new BoundForRangeStatement(node.KeyVariable, node.ValueVariable, collection, node.IterationKind, body, node.BreakLabel, node.ContinueLabel);
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
            case BoundNodeKind.MapLiteralExpression:
                return RewriteMapLiteralExpression((BoundMapLiteralExpression)node);
            case BoundNodeKind.MapDeleteExpression:
                return RewriteMapDeleteExpression((BoundMapDeleteExpression)node);
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
            case BoundNodeKind.TupleLiteralExpression:
                return RewriteTupleLiteralExpression((BoundTupleLiteralExpression)node);
            case BoundNodeKind.TupleElementAccessExpression:
                return RewriteTupleElementAccessExpression((BoundTupleElementAccessExpression)node);
            case BoundNodeKind.FunctionLiteralExpression:
                return RewriteFunctionLiteralExpression((BoundFunctionLiteralExpression)node);
            case BoundNodeKind.IndirectCallExpression:
                return RewriteIndirectCallExpression((BoundIndirectCallExpression)node);
            case BoundNodeKind.ClrConstructorCallExpression:
                return RewriteClrConstructorCallExpression((BoundClrConstructorCallExpression)node);
            case BoundNodeKind.ClrPropertyAccessExpression:
                return RewriteClrPropertyAccessExpression((BoundClrPropertyAccessExpression)node);
            case BoundNodeKind.ClrIndexExpression:
                return RewriteClrIndexExpression((BoundClrIndexExpression)node);
            case BoundNodeKind.ClrIndexAssignmentExpression:
                return RewriteClrIndexAssignmentExpression((BoundClrIndexAssignmentExpression)node);
            case BoundNodeKind.AwaitExpression:
                return RewriteAwaitExpression((BoundAwaitExpression)node);
            case BoundNodeKind.SwitchExpression:
                return RewriteSwitchExpression((BoundSwitchExpression)node);
            case BoundNodeKind.MakeChannelExpression:
                return RewriteMakeChannelExpression((BoundMakeChannelExpression)node);
            case BoundNodeKind.ChannelReceiveExpression:
                return RewriteChannelReceiveExpression((BoundChannelReceiveExpression)node);
            case BoundNodeKind.ChannelCloseExpression:
                return RewriteChannelCloseExpression((BoundChannelCloseExpression)node);
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

    /// <summary>Rewrites a bound await expression (Phase 5.1).</summary>
    /// <param name="node">The await expression to rewrite.</param>
    /// <returns>The rewritten await expression.</returns>
    protected virtual BoundExpression RewriteAwaitExpression(BoundAwaitExpression node)
    {
        var expression = RewriteExpression(node.Expression);
        if (expression == node.Expression)
        {
            return node;
        }

        return new BoundAwaitExpression(expression, node.Type);
    }

    /// <summary>Rewrites a bound switch expression.</summary>
    /// <param name="node">The switch expression to rewrite.</param>
    /// <returns>The rewritten switch expression.</returns>
    protected virtual BoundExpression RewriteSwitchExpression(BoundSwitchExpression node)
    {
        var discriminant = RewriteExpression(node.Discriminant);
        ImmutableArray<BoundSwitchExpressionArm>.Builder builder = null;

        for (var i = 0; i < node.Arms.Length; i++)
        {
            var arm = node.Arms[i];
            var value = arm.Value == null ? null : RewriteExpression(arm.Value);
            var result = RewriteExpression(arm.Result);
            if (builder == null && (value != arm.Value || result != arm.Result))
            {
                builder = ImmutableArray.CreateBuilder<BoundSwitchExpressionArm>(node.Arms.Length);
                for (var j = 0; j < i; j++)
                {
                    builder.Add(node.Arms[j]);
                }
            }

            builder?.Add(new BoundSwitchExpressionArm(value, result));
        }

        if (discriminant == node.Discriminant && builder == null)
        {
            return node;
        }

        return new BoundSwitchExpression(discriminant, builder?.MoveToImmutable() ?? node.Arms, node.Type);
    }

    /// <summary>Rewrites a bound go statement (Phase 5.3).</summary>
    /// <param name="node">The go statement to rewrite.</param>
    /// <returns>The rewritten go statement.</returns>
    protected virtual BoundStatement RewriteGoStatement(BoundGoStatement node)
    {
        var expression = RewriteExpression(node.Expression);
        if (expression == node.Expression)
        {
            return node;
        }

        return new BoundGoStatement(expression);
    }

    /// <summary>Rewrites a bound channel-send statement (Phase 5.5).</summary>
    /// <param name="node">The channel-send statement to rewrite.</param>
    /// <returns>The rewritten channel-send statement.</returns>
    protected virtual BoundStatement RewriteChannelSendStatement(BoundChannelSendStatement node)
    {
        var channel = RewriteExpression(node.Channel);
        var value = RewriteExpression(node.Value);
        if (channel == node.Channel && value == node.Value)
        {
            return node;
        }

        return new BoundChannelSendStatement(channel, value);
    }

    /// <summary>Rewrites a bound select statement (Phase 5.6).</summary>
    /// <param name="node">The select statement to rewrite.</param>
    /// <returns>The rewritten select statement.</returns>
    protected virtual BoundStatement RewriteSelectStatement(BoundSelectStatement node)
    {
        ImmutableArray<BoundSelectCase>.Builder builder = null;
        for (var i = 0; i < node.Cases.Length; i++)
        {
            var arm = node.Cases[i];
            var channel = arm.Channel == null ? null : RewriteExpression(arm.Channel);
            var value = arm.Value == null ? null : RewriteExpression(arm.Value);
            var body = RewriteStatement(arm.Body);
            if (builder == null && (channel != arm.Channel || value != arm.Value || body != arm.Body))
            {
                builder = ImmutableArray.CreateBuilder<BoundSelectCase>(node.Cases.Length);
                for (var j = 0; j < i; j++)
                {
                    builder.Add(node.Cases[j]);
                }
            }

            builder?.Add(new BoundSelectCase(arm.CaseKind, channel, value, arm.Variable, body));
        }

        if (builder == null)
        {
            return node;
        }

        return new BoundSelectStatement(builder.MoveToImmutable());
    }

    /// <summary>Rewrites a bound scope statement (Phase 5.7).</summary>
    /// <param name="node">The scope statement to rewrite.</param>
    /// <returns>The rewritten scope statement.</returns>
    protected virtual BoundStatement RewriteScopeStatement(BoundScopeStatement node)
    {
        var body = RewriteStatement(node.Body);
        if (body == node.Body)
        {
            return node;
        }

        return new BoundScopeStatement(body);
    }

    /// <summary>Rewrites a bound <c>await for v := range stream</c> statement (Phase 5.8).</summary>
    /// <param name="node">The await-for-range statement to rewrite.</param>
    /// <returns>The rewritten await-for-range statement.</returns>
    protected virtual BoundStatement RewriteAwaitForRangeStatement(BoundAwaitForRangeStatement node)
    {
        var stream = RewriteExpression(node.Stream);
        var body = RewriteStatement(node.Body);
        if (stream == node.Stream && body == node.Body)
        {
            return node;
        }

        return new BoundAwaitForRangeStatement(node.ValueVariable, stream, body);
    }

    /// <summary>Rewrites a bound make-channel expression (Phase 5.4).</summary>
    /// <param name="node">The make-channel expression to rewrite.</param>
    /// <returns>The rewritten make-channel expression.</returns>
    protected virtual BoundExpression RewriteMakeChannelExpression(BoundMakeChannelExpression node)
    {
        if (node.Capacity == null)
        {
            return node;
        }

        var capacity = RewriteExpression(node.Capacity);
        if (capacity == node.Capacity)
        {
            return node;
        }

        return new BoundMakeChannelExpression(node.ChannelType, capacity);
    }

    /// <summary>Rewrites a bound channel-receive expression (Phase 5.5).</summary>
    /// <param name="node">The channel-receive expression to rewrite.</param>
    /// <returns>The rewritten channel-receive expression.</returns>
    protected virtual BoundExpression RewriteChannelReceiveExpression(BoundChannelReceiveExpression node)
    {
        var channel = RewriteExpression(node.Channel);
        if (channel == node.Channel)
        {
            return node;
        }

        return new BoundChannelReceiveExpression(channel, node.Type);
    }

    /// <summary>Rewrites a bound channel-close expression (Phase 5.4).</summary>
    /// <param name="node">The channel-close expression to rewrite.</param>
    /// <returns>The rewritten channel-close expression.</returns>
    protected virtual BoundExpression RewriteChannelCloseExpression(BoundChannelCloseExpression node)
    {
        var channel = RewriteExpression(node.Channel);
        if (channel == node.Channel)
        {
            return node;
        }

        return new BoundChannelCloseExpression(channel);
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

    /// <summary>Rewrites a map literal expression.</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteMapLiteralExpression(BoundMapLiteralExpression node)
    {
        ImmutableArray<BoundMapEntry>.Builder builder = null;
        for (var i = 0; i < node.Entries.Length; i++)
        {
            var oldEntry = node.Entries[i];
            var newKey = RewriteExpression(oldEntry.Key);
            var newValue = RewriteExpression(oldEntry.Value);
            if ((newKey != oldEntry.Key || newValue != oldEntry.Value) && builder == null)
            {
                builder = ImmutableArray.CreateBuilder<BoundMapEntry>(node.Entries.Length);
                for (var j = 0; j < i; j++)
                {
                    builder.Add(node.Entries[j]);
                }
            }

            builder?.Add(newKey == oldEntry.Key && newValue == oldEntry.Value
                ? oldEntry
                : new BoundMapEntry(newKey, newValue));
        }

        return builder == null ? node : new BoundMapLiteralExpression(node.MapType, builder.MoveToImmutable());
    }

    /// <summary>Rewrites a <c>delete(m, k)</c> expression.</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteMapDeleteExpression(BoundMapDeleteExpression node)
    {
        var map = RewriteExpression(node.Map);
        var key = RewriteExpression(node.Key);
        if (map == node.Map && key == node.Key)
        {
            return node;
        }

        return new BoundMapDeleteExpression(map, key);
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

    /// <summary>Rewrites a CLR constructor call (Phase 4 exit).</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteClrConstructorCallExpression(BoundClrConstructorCallExpression node)
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

        return builder == null ? node : new BoundClrConstructorCallExpression(node.ClrType, node.Constructor, builder.ToImmutable(), node.Type);
    }

    /// <summary>Rewrites a CLR property/field access on a CLR receiver.</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteClrPropertyAccessExpression(BoundClrPropertyAccessExpression node)
    {
        var receiver = RewriteExpression(node.Receiver);
        return receiver == node.Receiver ? node : new BoundClrPropertyAccessExpression(receiver, node.Member, node.Type);
    }

    /// <summary>Rewrites a CLR indexer read.</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteClrIndexExpression(BoundClrIndexExpression node)
    {
        var target = RewriteExpression(node.Target);
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

        if (target == node.Target && builder == null)
        {
            return node;
        }

        var args = builder?.ToImmutable() ?? node.Arguments;
        return new BoundClrIndexExpression(target, node.Indexer, args, node.Type);
    }

    /// <summary>Rewrites a CLR indexer write.</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteClrIndexAssignmentExpression(BoundClrIndexAssignmentExpression node)
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

        var value = RewriteExpression(node.Value);
        if (builder == null && value == node.Value)
        {
            return node;
        }

        var args = builder?.ToImmutable() ?? node.Arguments;
        return new BoundClrIndexAssignmentExpression(node.Target, node.Indexer, args, value, node.Type);
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

    /// <summary>Rewrites a tuple literal (Phase 4.5).</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteTupleLiteralExpression(BoundTupleLiteralExpression node)
    {
        System.Collections.Immutable.ImmutableArray<BoundExpression>.Builder builder = null;
        for (var i = 0; i < node.Elements.Length; i++)
        {
            var oldEl = node.Elements[i];
            var newEl = RewriteExpression(oldEl);
            if (newEl != oldEl && builder == null)
            {
                builder = System.Collections.Immutable.ImmutableArray.CreateBuilder<BoundExpression>(node.Elements.Length);
                for (var j = 0; j < i; j++)
                {
                    builder.Add(node.Elements[j]);
                }
            }

            builder?.Add(newEl);
        }

        return builder == null ? node : new BoundTupleLiteralExpression(node.TupleType, builder.ToImmutable());
    }

    /// <summary>Rewrites a tuple element access (Phase 4.5).</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteTupleElementAccessExpression(BoundTupleElementAccessExpression node)
    {
        var receiver = RewriteExpression(node.Receiver);
        return receiver == node.Receiver ? node : new BoundTupleElementAccessExpression(receiver, node.TupleType, node.Index);
    }

    /// <summary>Rewrites a function literal (Phase 4.7). The body is intentionally not rewritten because it forms a separate lexical scope.</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteFunctionLiteralExpression(BoundFunctionLiteralExpression node)
    {
        return node;
    }

    /// <summary>Rewrites an indirect call (Phase 4.7).</summary>
    /// <param name="node">The node to rewrite.</param>
    /// <returns>The rewritten node.</returns>
    protected virtual BoundExpression RewriteIndirectCallExpression(BoundIndirectCallExpression node)
    {
        var target = RewriteExpression(node.Target);
        System.Collections.Immutable.ImmutableArray<BoundExpression>.Builder builder = null;
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            var oldArg = node.Arguments[i];
            var newArg = RewriteExpression(oldArg);
            if (newArg != oldArg && builder == null)
            {
                builder = System.Collections.Immutable.ImmutableArray.CreateBuilder<BoundExpression>(node.Arguments.Length);
                for (var j = 0; j < i; j++)
                {
                    builder.Add(node.Arguments[j]);
                }
            }

            builder?.Add(newArg);
        }

        if (target == node.Target && builder == null)
        {
            return node;
        }

        return new BoundIndirectCallExpression(target, node.FunctionType, builder?.ToImmutable() ?? node.Arguments);
    }
}
