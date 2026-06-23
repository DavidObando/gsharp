// <copyright file="BoundTreeWalker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;

#pragma warning disable CS1591 // Missing XML comment for publicly visible type or member
#pragma warning disable SA1600 // Elements should be documented
#pragma warning disable SA1512 // Single-line comments should not be followed by blank line

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Abstract bound-tree visitor that, by default, recurses into every child of
/// every node — mirroring the coverage of <see cref="BoundTreeRewriter"/>.
/// Subclasses override <c>VisitX</c> methods to observe nodes of interest;
/// calling <c>base.VisitX(node)</c> continues the traversal into the node's
/// children. Issue #418 (P1-3): pre-emit allocator walkers were bespoke
/// switch statements with <c>default: return</c> branches, which silently
/// dropped many <see cref="BoundExpression"/> kinds (tuple literals, map
/// literals, null-conditional access, CLR calls/indexers/properties, indirect
/// calls, switch expressions, etc.). Any literal/append nested inside a
/// dropped context reached <c>EmitStructLiteral</c>/<c>EmitAppendExpression</c>
/// without a pre-allocated slot and threw at emit time. Using this default-
/// recurse walker eliminates the entire class of bug.
/// </summary>
public abstract class BoundTreeWalker
{
    /// <summary>Dispatch on a generic node.</summary>
    /// <param name="node">The bound node to visit. Null is tolerated.</param>
    public virtual void Visit(BoundNode node)
    {
        if (node == null)
        {
            return;
        }

        switch (node)
        {
            case BoundStatement s:
                VisitStatement(s);
                break;
            case BoundExpression e:
                VisitExpression(e);
                break;
            case BoundPattern p:
                VisitPattern(p);
                break;
            default:
                // Helper nodes (e.g. BoundPatternSwitchArm, BoundSwitchExpressionArm,
                // BoundCatchClause, BoundFieldInitializer) are visited via their
                // owning statement/expression; nothing to do here.
                break;
        }
    }

    /// <summary>Dispatch on a statement.</summary>
    /// <param name="node">The statement to visit.</param>
    public virtual void VisitStatement(BoundStatement node)
    {
        if (node == null)
        {
            return;
        }

        switch (node.Kind)
        {
            case BoundNodeKind.BlockStatement:
                VisitBlockStatement((BoundBlockStatement)node);
                break;
            case BoundNodeKind.VariableDeclaration:
                VisitVariableDeclaration((BoundVariableDeclaration)node);
                break;
            case BoundNodeKind.IfStatement:
                VisitIfStatement((BoundIfStatement)node);
                break;
            case BoundNodeKind.ForInfiniteStatement:
                VisitForInfiniteStatement((BoundForInfiniteStatement)node);
                break;
            case BoundNodeKind.ForEllipsisStatement:
                VisitForEllipsisStatement((BoundForEllipsisStatement)node);
                break;
            case BoundNodeKind.ForRangeStatement:
                VisitForRangeStatement((BoundForRangeStatement)node);
                break;
            case BoundNodeKind.LabelStatement:
            case BoundNodeKind.GotoStatement:
                // Leaf statements — nothing to recurse into.
                break;
            case BoundNodeKind.ConditionalGotoStatement:
                VisitConditionalGotoStatement((BoundConditionalGotoStatement)node);
                break;
            case BoundNodeKind.ReturnStatement:
                VisitReturnStatement((BoundReturnStatement)node);
                break;
            case BoundNodeKind.ExpressionStatement:
                VisitExpressionStatement((BoundExpressionStatement)node);
                break;
            case BoundNodeKind.TryStatement:
                VisitTryStatement((BoundTryStatement)node);
                break;
            case BoundNodeKind.ThrowStatement:
                VisitThrowStatement((BoundThrowStatement)node);
                break;
            case BoundNodeKind.PatternSwitchStatement:
                VisitPatternSwitchStatement((BoundPatternSwitchStatement)node);
                break;
            case BoundNodeKind.GoStatement:
                VisitGoStatement((BoundGoStatement)node);
                break;
            case BoundNodeKind.ChannelSendStatement:
                VisitChannelSendStatement((BoundChannelSendStatement)node);
                break;
            case BoundNodeKind.SelectStatement:
                VisitSelectStatement((BoundSelectStatement)node);
                break;
            case BoundNodeKind.ScopeStatement:
                VisitScopeStatement((BoundScopeStatement)node);
                break;
            case BoundNodeKind.AwaitForRangeStatement:
                VisitAwaitForRangeStatement((BoundAwaitForRangeStatement)node);
                break;
            case BoundNodeKind.YieldStatement:
                VisitYieldStatement((BoundYieldStatement)node);
                break;
            case BoundNodeKind.AwaitYieldPoint:
            case BoundNodeKind.AwaitResumePoint:
                // Synthetic markers — leaf nodes.
                break;
            default:
                throw new InvalidOperationException(
                    $"BoundTreeWalker: unexpected statement kind '{node.Kind}'.");
        }
    }

    /// <summary>Dispatch on an expression.</summary>
    /// <param name="node">The expression to visit.</param>
    public virtual void VisitExpression(BoundExpression node)
    {
        if (node == null)
        {
            return;
        }

        switch (node.Kind)
        {
            case BoundNodeKind.ErrorExpression:
            case BoundNodeKind.LiteralExpression:
            case BoundNodeKind.VariableExpression:
            case BoundNodeKind.DefaultExpression:
            case BoundNodeKind.TypeParameterConstructionExpression:
            case BoundNodeKind.TypeOfExpression:
            case BoundNodeKind.FunctionLiteralExpression:
            case BoundNodeKind.StateMachineAwaitOnCompleted:
            case BoundNodeKind.StateMachineBuilderMoveNext:
                // Leaves (or, for FunctionLiteralExpression, intentionally
                // opaque since the body is a separate lexical scope —
                // matching BoundTreeRewriter).
                break;
            case BoundNodeKind.MethodGroupExpression:
                VisitMethodGroupExpression((BoundMethodGroupExpression)node);
                break;
            case BoundNodeKind.AssignmentExpression:
                VisitAssignmentExpression((BoundAssignmentExpression)node);
                break;
            case BoundNodeKind.UnaryExpression:
                VisitUnaryExpression((BoundUnaryExpression)node);
                break;
            case BoundNodeKind.BinaryExpression:
                VisitBinaryExpression((BoundBinaryExpression)node);
                break;
            case BoundNodeKind.CallExpression:
                VisitCallExpression((BoundCallExpression)node);
                break;
            case BoundNodeKind.ConversionExpression:
                VisitConversionExpression((BoundConversionExpression)node);
                break;
            case BoundNodeKind.ImportedCallExpression:
                VisitImportedCallExpression((BoundImportedCallExpression)node);
                break;
            case BoundNodeKind.ImportedInstanceCallExpression:
                VisitImportedInstanceCallExpression((BoundImportedInstanceCallExpression)node);
                break;
            case BoundNodeKind.ConstrainedStaticCallExpression:
                VisitConstrainedStaticCallExpression((BoundConstrainedStaticCallExpression)node);
                break;
            case BoundNodeKind.ArrayCreationExpression:
                VisitArrayCreationExpression((BoundArrayCreationExpression)node);
                break;
            case BoundNodeKind.MapLiteralExpression:
                VisitMapLiteralExpression((BoundMapLiteralExpression)node);
                break;
            case BoundNodeKind.MapDeleteExpression:
                VisitMapDeleteExpression((BoundMapDeleteExpression)node);
                break;
            case BoundNodeKind.IndexExpression:
                VisitIndexExpression((BoundIndexExpression)node);
                break;
            case BoundNodeKind.IndexAssignmentExpression:
                VisitIndexAssignmentExpression((BoundIndexAssignmentExpression)node);
                break;
            case BoundNodeKind.LenExpression:
                VisitLenExpression((BoundLenExpression)node);
                break;
            case BoundNodeKind.CapExpression:
                VisitCapExpression((BoundCapExpression)node);
                break;
            case BoundNodeKind.AppendExpression:
                VisitAppendExpression((BoundAppendExpression)node);
                break;
            case BoundNodeKind.StructLiteralExpression:
                VisitStructLiteralExpression((BoundStructLiteralExpression)node);
                break;
            case BoundNodeKind.BlockExpression:
                VisitBlockExpression((BoundBlockExpression)node);
                break;
            case BoundNodeKind.ConstructorCallExpression:
                VisitConstructorCallExpression((BoundConstructorCallExpression)node);
                break;
            case BoundNodeKind.UserInstanceCallExpression:
                VisitUserInstanceCallExpression((BoundUserInstanceCallExpression)node);
                break;
            case BoundNodeKind.BaseInterfaceCallExpression:
                VisitBaseInterfaceCallExpression((BoundBaseInterfaceCallExpression)node);
                break;
            case BoundNodeKind.BaseClassCallExpression:
                VisitBaseClassCallExpression((BoundBaseClassCallExpression)node);
                break;
            case BoundNodeKind.FieldAccessExpression:
                VisitFieldAccessExpression((BoundFieldAccessExpression)node);
                break;
            case BoundNodeKind.FieldAssignmentExpression:
                VisitFieldAssignmentExpression((BoundFieldAssignmentExpression)node);
                break;
            case BoundNodeKind.PropertyAccessExpression:
                VisitPropertyAccessExpression((BoundPropertyAccessExpression)node);
                break;
            case BoundNodeKind.PropertyAssignmentExpression:
                VisitPropertyAssignmentExpression((BoundPropertyAssignmentExpression)node);
                break;
            case BoundNodeKind.NullConditionalAccessExpression:
                VisitNullConditionalAccessExpression((BoundNullConditionalAccessExpression)node);
                break;
            case BoundNodeKind.TupleLiteralExpression:
                VisitTupleLiteralExpression((BoundTupleLiteralExpression)node);
                break;
            case BoundNodeKind.TupleElementAccessExpression:
                VisitTupleElementAccessExpression((BoundTupleElementAccessExpression)node);
                break;
            case BoundNodeKind.ClrMethodGroupExpression:
                VisitClrMethodGroupExpression((BoundClrMethodGroupExpression)node);
                break;
            case BoundNodeKind.IndirectCallExpression:
                VisitIndirectCallExpression((BoundIndirectCallExpression)node);
                break;
            case BoundNodeKind.InterpolatedStringExpression:
                VisitInterpolatedStringExpression((BoundInterpolatedStringExpression)node);
                break;
            case BoundNodeKind.ClrConstructorCallExpression:
                VisitClrConstructorCallExpression((BoundClrConstructorCallExpression)node);
                break;
            case BoundNodeKind.ClrStaticCallExpression:
                VisitClrStaticCallExpression((BoundClrStaticCallExpression)node);
                break;
            case BoundNodeKind.ClrPropertyAccessExpression:
                VisitClrPropertyAccessExpression((BoundClrPropertyAccessExpression)node);
                break;
            case BoundNodeKind.ClrPropertyAssignmentExpression:
                VisitClrPropertyAssignmentExpression((BoundClrPropertyAssignmentExpression)node);
                break;
            case BoundNodeKind.ClrEventSubscriptionExpression:
                VisitClrEventSubscriptionExpression((BoundClrEventSubscriptionExpression)node);
                break;
            case BoundNodeKind.EventSubscriptionExpression:
                VisitEventSubscriptionExpression((BoundEventSubscriptionExpression)node);
                break;
            case BoundNodeKind.ClrBinaryOperatorExpression:
                VisitClrBinaryOperatorExpression((BoundClrBinaryOperatorExpression)node);
                break;
            case BoundNodeKind.ClrUnaryOperatorExpression:
                VisitClrUnaryOperatorExpression((BoundClrUnaryOperatorExpression)node);
                break;
            case BoundNodeKind.ClrConversionCallExpression:
                VisitClrConversionCallExpression((BoundClrConversionCallExpression)node);
                break;
            case BoundNodeKind.ClrIndexExpression:
                VisitClrIndexExpression((BoundClrIndexExpression)node);
                break;
            case BoundNodeKind.ClrIndexAssignmentExpression:
                VisitClrIndexAssignmentExpression((BoundClrIndexAssignmentExpression)node);
                break;
            case BoundNodeKind.AwaitExpression:
                VisitAwaitExpression((BoundAwaitExpression)node);
                break;
            case BoundNodeKind.SwitchExpression:
                VisitSwitchExpression((BoundSwitchExpression)node);
                break;
            case BoundNodeKind.MakeChannelExpression:
                VisitMakeChannelExpression((BoundMakeChannelExpression)node);
                break;
            case BoundNodeKind.ChannelReceiveExpression:
                VisitChannelReceiveExpression((BoundChannelReceiveExpression)node);
                break;
            case BoundNodeKind.ChannelCloseExpression:
                VisitChannelCloseExpression((BoundChannelCloseExpression)node);
                break;
            case BoundNodeKind.AddressOfExpression:
                VisitAddressOfExpression((BoundAddressOfExpression)node);
                break;
            case BoundNodeKind.ConditionalAddressExpression:
                VisitConditionalAddressExpression((BoundConditionalAddressExpression)node);
                break;
            case BoundNodeKind.ConditionalExpression:
                VisitConditionalExpression((BoundConditionalExpression)node);
                break;
            case BoundNodeKind.DereferenceExpression:
                VisitDereferenceExpression((BoundDereferenceExpression)node);
                break;
            case BoundNodeKind.IndirectAssignmentExpression:
                VisitIndirectAssignmentExpression((BoundIndirectAssignmentExpression)node);
                break;
            case BoundNodeKind.SpillSequenceExpression:
                VisitSpillSequenceExpression((BoundSpillSequenceExpression)node);
                break;
            case BoundNodeKind.IsExpression:
                VisitIsExpression((BoundIsExpression)node);
                break;
            case BoundNodeKind.AsExpression:
                VisitAsExpression((BoundAsExpression)node);
                break;
            case BoundNodeKind.ConstructorChainingExpression:
                VisitConstructorChainingExpression((BoundConstructorChainingExpression)node);
                break;
            default:
                throw new InvalidOperationException(
                    $"BoundTreeWalker: unexpected expression kind '{node.Kind}'.");
        }
    }

    /// <summary>Dispatch on a pattern.</summary>
    /// <param name="node">The pattern to visit.</param>
    public virtual void VisitPattern(BoundPattern node)
    {
        if (node == null)
        {
            return;
        }

        switch (node.Kind)
        {
            case BoundNodeKind.DiscardPattern:
            case BoundNodeKind.TypePattern:
                break;
            case BoundNodeKind.ConstantPattern:
                VisitConstantPattern((BoundConstantPattern)node);
                break;
            case BoundNodeKind.RelationalPattern:
                VisitRelationalPattern((BoundRelationalPattern)node);
                break;
            case BoundNodeKind.PropertyPattern:
                VisitPropertyPattern((BoundPropertyPattern)node);
                break;
            case BoundNodeKind.ListPattern:
                VisitListPattern((BoundListPattern)node);
                break;
            default:
                throw new InvalidOperationException(
                    $"BoundTreeWalker: unexpected pattern kind '{node.Kind}'.");
        }
    }

    // ----- Statements ----------------------------------------------------

    protected virtual void VisitBlockStatement(BoundBlockStatement node)
    {
        foreach (var s in node.Statements)
        {
            VisitStatement(s);
        }
    }

    protected virtual void VisitVariableDeclaration(BoundVariableDeclaration node)
    {
        VisitExpression(node.Initializer);
    }

    protected virtual void VisitIfStatement(BoundIfStatement node)
    {
        VisitExpression(node.Condition);
        VisitStatement(node.ThenStatement);
        if (node.ElseStatement != null)
        {
            VisitStatement(node.ElseStatement);
        }
    }

    protected virtual void VisitForInfiniteStatement(BoundForInfiniteStatement node)
    {
        VisitStatement(node.Body);
    }

    protected virtual void VisitForEllipsisStatement(BoundForEllipsisStatement node)
    {
        VisitExpression(node.LowerBound);
        VisitExpression(node.UpperBound);
        VisitStatement(node.Body);
    }

    protected virtual void VisitForRangeStatement(BoundForRangeStatement node)
    {
        VisitExpression(node.Collection);
        VisitStatement(node.Body);
    }

    protected virtual void VisitConditionalGotoStatement(BoundConditionalGotoStatement node)
    {
        VisitExpression(node.Condition);
    }

    protected virtual void VisitReturnStatement(BoundReturnStatement node)
    {
        if (node.Expression != null)
        {
            VisitExpression(node.Expression);
        }
    }

    protected virtual void VisitExpressionStatement(BoundExpressionStatement node)
    {
        VisitExpression(node.Expression);
    }

    protected virtual void VisitTryStatement(BoundTryStatement node)
    {
        VisitStatement(node.TryBlock);
        foreach (var clause in node.CatchClauses)
        {
            VisitStatement(clause.Body);
        }

        if (node.FinallyBlock != null)
        {
            VisitStatement(node.FinallyBlock);
        }
    }

    protected virtual void VisitThrowStatement(BoundThrowStatement node)
    {
        VisitExpression(node.Expression);
    }

    protected virtual void VisitPatternSwitchStatement(BoundPatternSwitchStatement node)
    {
        VisitExpression(node.Discriminant);
        foreach (var arm in node.Arms)
        {
            if (arm.Pattern != null)
            {
                VisitPattern(arm.Pattern);
            }

            if (arm.Guard != null)
            {
                VisitExpression(arm.Guard);
            }

            VisitStatement(arm.Body);
        }
    }

    protected virtual void VisitGoStatement(BoundGoStatement node)
    {
        VisitExpression(node.Expression);
    }

    protected virtual void VisitChannelSendStatement(BoundChannelSendStatement node)
    {
        VisitExpression(node.Channel);
        VisitExpression(node.Value);
    }

    protected virtual void VisitSelectStatement(BoundSelectStatement node)
    {
        foreach (var arm in node.Cases)
        {
            if (arm.Channel != null)
            {
                VisitExpression(arm.Channel);
            }

            if (arm.Value != null)
            {
                VisitExpression(arm.Value);
            }

            VisitStatement(arm.Body);
        }
    }

    protected virtual void VisitScopeStatement(BoundScopeStatement node)
    {
        VisitStatement(node.Body);
    }

    protected virtual void VisitAwaitForRangeStatement(BoundAwaitForRangeStatement node)
    {
        VisitExpression(node.Stream);
        VisitStatement(node.Body);
    }

    protected virtual void VisitYieldStatement(BoundYieldStatement node)
    {
        VisitExpression(node.Expression);
    }

    // ----- Expressions ---------------------------------------------------

    protected virtual void VisitAssignmentExpression(BoundAssignmentExpression node)
    {
        VisitExpression(node.Expression);
    }

    protected virtual void VisitUnaryExpression(BoundUnaryExpression node)
    {
        VisitExpression(node.Operand);
    }

    protected virtual void VisitBinaryExpression(BoundBinaryExpression node)
    {
        VisitExpression(node.Left);
        VisitExpression(node.Right);
    }

    protected virtual void VisitCallExpression(BoundCallExpression node)
    {
        VisitList(node.Arguments);
    }

    protected virtual void VisitConversionExpression(BoundConversionExpression node)
    {
        VisitExpression(node.Expression);
    }

    protected virtual void VisitImportedCallExpression(BoundImportedCallExpression node)
    {
        VisitList(node.Arguments);
    }

    protected virtual void VisitImportedInstanceCallExpression(BoundImportedInstanceCallExpression node)
    {
        VisitExpression(node.Receiver);
        VisitList(node.Arguments);
    }

    /// <summary>ADR-0089 / issue #755: visit a constrained static-virtual call.</summary>
    /// <param name="node">The bound node.</param>
    protected virtual void VisitConstrainedStaticCallExpression(BoundConstrainedStaticCallExpression node)
    {
        VisitList(node.Arguments);
    }

    protected virtual void VisitArrayCreationExpression(BoundArrayCreationExpression node)
    {
        VisitList(node.Elements);
    }

    protected virtual void VisitMapLiteralExpression(BoundMapLiteralExpression node)
    {
        foreach (var entry in node.Entries)
        {
            VisitExpression(entry.Key);
            VisitExpression(entry.Value);
        }
    }

    protected virtual void VisitMapDeleteExpression(BoundMapDeleteExpression node)
    {
        VisitExpression(node.Map);
        VisitExpression(node.Key);
    }

    protected virtual void VisitIndexExpression(BoundIndexExpression node)
    {
        VisitExpression(node.Target);
        VisitExpression(node.Index);
    }

    protected virtual void VisitIndexAssignmentExpression(BoundIndexAssignmentExpression node)
    {
        if (node.TargetExpression != null)
        {
            VisitExpression(node.TargetExpression);
        }

        VisitExpression(node.Index);
        VisitExpression(node.Value);
    }

    protected virtual void VisitLenExpression(BoundLenExpression node)
    {
        VisitExpression(node.Operand);
    }

    protected virtual void VisitCapExpression(BoundCapExpression node)
    {
        VisitExpression(node.Operand);
    }

    protected virtual void VisitAppendExpression(BoundAppendExpression node)
    {
        VisitExpression(node.Slice);
        VisitExpression(node.Element);
    }

    protected virtual void VisitStructLiteralExpression(BoundStructLiteralExpression node)
    {
        foreach (var init in node.Initializers)
        {
            VisitExpression(init.Value);
        }
    }

    protected virtual void VisitBlockExpression(BoundBlockExpression node)
    {
        foreach (var s in node.Statements)
        {
            VisitStatement(s);
        }

        VisitExpression(node.Expression);
    }

    protected virtual void VisitConstructorCallExpression(BoundConstructorCallExpression node)
    {
        VisitList(node.Arguments);
    }

    /// <summary>ADR-0065 §2: visits a <see cref="BoundConstructorChainingExpression"/>.</summary>
    /// <param name="node">The node being visited.</param>
    protected virtual void VisitConstructorChainingExpression(BoundConstructorChainingExpression node)
    {
        VisitList(node.Arguments);
    }

    protected virtual void VisitUserInstanceCallExpression(BoundUserInstanceCallExpression node)
    {
        VisitExpression(node.Receiver);
        VisitList(node.Arguments);
    }

    /// <summary>ADR-0091: visits a <see cref="BoundBaseInterfaceCallExpression"/>.</summary>
    /// <param name="node">The node being visited.</param>
    protected virtual void VisitBaseInterfaceCallExpression(BoundBaseInterfaceCallExpression node)
    {
        VisitExpression(node.Receiver);
        VisitList(node.Arguments);
    }

    /// <summary>Issue #986: visits a <see cref="BoundBaseClassCallExpression"/>.</summary>
    /// <param name="node">The node being visited.</param>
    protected virtual void VisitBaseClassCallExpression(BoundBaseClassCallExpression node)
    {
        VisitExpression(node.Receiver);
        VisitList(node.Arguments);
    }

    protected virtual void VisitFieldAccessExpression(BoundFieldAccessExpression node)
    {
        if (node.Receiver != null)
        {
            VisitExpression(node.Receiver);
        }
    }

    protected virtual void VisitFieldAssignmentExpression(BoundFieldAssignmentExpression node)
    {
        VisitExpression(node.Value);
    }

    protected virtual void VisitPropertyAccessExpression(BoundPropertyAccessExpression node)
    {
        if (node.Receiver != null)
        {
            VisitExpression(node.Receiver);
        }
    }

    protected virtual void VisitPropertyAssignmentExpression(BoundPropertyAssignmentExpression node)
    {
        if (node.Receiver != null)
        {
            VisitExpression(node.Receiver);
        }

        VisitExpression(node.Value);
    }

    protected virtual void VisitNullConditionalAccessExpression(BoundNullConditionalAccessExpression node)
    {
        VisitExpression(node.Receiver);
        VisitExpression(node.WhenNotNull);
    }

    protected virtual void VisitTupleLiteralExpression(BoundTupleLiteralExpression node)
    {
        VisitList(node.Elements);
    }

    protected virtual void VisitTupleElementAccessExpression(BoundTupleElementAccessExpression node)
    {
        VisitExpression(node.Receiver);
    }

    protected virtual void VisitClrMethodGroupExpression(BoundClrMethodGroupExpression node)
    {
        if (node.Receiver != null)
        {
            VisitExpression(node.Receiver);
        }
    }

    protected virtual void VisitMethodGroupExpression(BoundMethodGroupExpression node)
    {
        if (node.Receiver != null)
        {
            VisitExpression(node.Receiver);
        }
    }

    protected virtual void VisitIndirectCallExpression(BoundIndirectCallExpression node)
    {
        VisitExpression(node.Target);
        VisitList(node.Arguments);
    }

    protected virtual void VisitInterpolatedStringExpression(BoundInterpolatedStringExpression node)
    {
        foreach (var part in node.Parts)
        {
            if (!part.IsLiteral)
            {
                VisitExpression(part.Value);
            }
        }

        if (node.Handler != null && !node.Handler.ForwardedArguments.IsDefaultOrEmpty)
        {
            VisitList(node.Handler.ForwardedArguments);
        }
    }

    protected virtual void VisitClrConstructorCallExpression(BoundClrConstructorCallExpression node)
    {
        VisitList(node.Arguments);
    }

    protected virtual void VisitClrStaticCallExpression(BoundClrStaticCallExpression node)
    {
        VisitList(node.Arguments);
    }

    protected virtual void VisitClrPropertyAccessExpression(BoundClrPropertyAccessExpression node)
    {
        if (node.Receiver != null)
        {
            VisitExpression(node.Receiver);
        }
    }

    protected virtual void VisitClrPropertyAssignmentExpression(BoundClrPropertyAssignmentExpression node)
    {
        if (node.Receiver != null)
        {
            VisitExpression(node.Receiver);
        }

        VisitExpression(node.Value);
    }

    protected virtual void VisitClrEventSubscriptionExpression(BoundClrEventSubscriptionExpression node)
    {
        if (node.Receiver != null)
        {
            VisitExpression(node.Receiver);
        }

        VisitExpression(node.Handler);
    }

    protected virtual void VisitEventSubscriptionExpression(BoundEventSubscriptionExpression node)
    {
        if (node.Receiver != null)
        {
            VisitExpression(node.Receiver);
        }

        VisitExpression(node.Handler);
    }

    protected virtual void VisitClrBinaryOperatorExpression(BoundClrBinaryOperatorExpression node)
    {
        VisitExpression(node.Left);
        VisitExpression(node.Right);
    }

    protected virtual void VisitClrUnaryOperatorExpression(BoundClrUnaryOperatorExpression node)
    {
        VisitExpression(node.Operand);
    }

    protected virtual void VisitClrConversionCallExpression(BoundClrConversionCallExpression node)
    {
        VisitExpression(node.Source);
    }

    protected virtual void VisitClrIndexExpression(BoundClrIndexExpression node)
    {
        VisitExpression(node.Target);
        VisitList(node.Arguments);
    }

    protected virtual void VisitClrIndexAssignmentExpression(BoundClrIndexAssignmentExpression node)
    {
        if (node.TargetExpression != null)
        {
            VisitExpression(node.TargetExpression);
        }

        VisitList(node.Arguments);
        VisitExpression(node.Value);
    }

    protected virtual void VisitAwaitExpression(BoundAwaitExpression node)
    {
        VisitExpression(node.Expression);
    }

    protected virtual void VisitSwitchExpression(BoundSwitchExpression node)
    {
        VisitExpression(node.Discriminant);
        foreach (var arm in node.Arms)
        {
            if (arm.Pattern != null)
            {
                VisitPattern(arm.Pattern);
            }

            if (arm.Guard != null)
            {
                VisitExpression(arm.Guard);
            }

            VisitExpression(arm.Result);
        }
    }

    protected virtual void VisitMakeChannelExpression(BoundMakeChannelExpression node)
    {
        if (node.Capacity != null)
        {
            VisitExpression(node.Capacity);
        }
    }

    protected virtual void VisitChannelReceiveExpression(BoundChannelReceiveExpression node)
    {
        VisitExpression(node.Channel);
    }

    protected virtual void VisitChannelCloseExpression(BoundChannelCloseExpression node)
    {
        VisitExpression(node.Channel);
    }

    protected virtual void VisitAddressOfExpression(BoundAddressOfExpression node)
    {
        VisitExpression(node.Operand);
    }

    /// <summary>ADR-0061: visits a conditional address-of expression.</summary>
    /// <param name="node">The conditional address-of expression.</param>
    protected virtual void VisitConditionalAddressExpression(BoundConditionalAddressExpression node)
    {
        VisitExpression(node.Condition);
        VisitExpression(node.WhenTrueOperand);
        VisitExpression(node.WhenFalseOperand);
    }

    /// <summary>ADR-0062: visits a general two-arm conditional (ternary) expression.</summary>
    /// <param name="node">The conditional expression.</param>
    protected virtual void VisitConditionalExpression(BoundConditionalExpression node)
    {
        VisitExpression(node.Condition);
        VisitExpression(node.WhenTrue);
        VisitExpression(node.WhenFalse);
    }

    protected virtual void VisitDereferenceExpression(BoundDereferenceExpression node)
    {
        VisitExpression(node.Operand);
    }

    protected virtual void VisitIndirectAssignmentExpression(BoundIndirectAssignmentExpression node)
    {
        VisitExpression(node.Pointer);
        VisitExpression(node.Value);
    }

    protected virtual void VisitSpillSequenceExpression(BoundSpillSequenceExpression node)
    {
        foreach (var s in node.SideEffects)
        {
            VisitStatement(s);
        }

        VisitExpression(node.Value);
    }

    // ----- Patterns ------------------------------------------------------

    protected virtual void VisitConstantPattern(BoundConstantPattern node)
    {
        VisitExpression(node.Value);
    }

    protected virtual void VisitRelationalPattern(BoundRelationalPattern node)
    {
        VisitExpression(node.Value);
    }

    protected virtual void VisitPropertyPattern(BoundPropertyPattern node)
    {
        foreach (var field in node.Fields)
        {
            VisitPattern(field.Pattern);
        }
    }

    protected virtual void VisitListPattern(BoundListPattern node)
    {
        foreach (var element in node.Elements)
        {
            VisitPattern(element);
        }
    }

    // ----- Helpers -------------------------------------------------------

    private void VisitList(ImmutableArray<BoundExpression> items)
    {
        if (items.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var item in items)
        {
            VisitExpression(item);
        }
    }

    private void VisitIsExpression(BoundIsExpression node)
    {
        VisitExpression(node.Expression);
    }

    private void VisitAsExpression(BoundAsExpression node)
    {
        VisitExpression(node.Expression);
    }
}

#pragma warning restore SA1512
#pragma warning restore SA1600
#pragma warning restore CS1591
