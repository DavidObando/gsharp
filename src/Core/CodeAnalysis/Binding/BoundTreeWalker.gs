// <copyright file="BoundTreeWalker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Immutable

/// Abstract bound-tree visitor that, by default, recurses into every child of
/// every node — mirroring the coverage of (cref:BoundTreeRewriter).
/// Subclasses override `VisitX` methods to observe nodes of interest;
/// calling `base.VisitX(node)` continues the traversal into the node's
/// children. Issue #418 (P1-3): pre-emit allocator walkers were bespoke
/// switch statements with `default: return` branches, which silently
/// dropped many (cref:BoundExpression) kinds (tuple literals, map
/// literals, null-conditional access, CLR calls/indexers/properties, indirect
/// calls, switch expressions, etc.). Any literal/append nested inside a
/// dropped context reached `EmitStructLiteral`
/// without a pre-allocated slot and threw at emit time. Using this default-
/// recurse walker eliminates the entire class of bug.
abstract class BoundTreeWalker {
    /// Dispatch on a generic node.
    /// @param node The bound node to visit. Null is a legitimate absent optional child.
    open func Visit(node BoundNode?) {
        if node == nil {
            return
        }
        switch node {
            case s is BoundStatement {
                VisitStatement(s)
            }
            case e is BoundExpression {
                VisitExpression(e)
            }
            case p is BoundPattern {
                VisitPattern(p)
            }
            default { }
        }
    }

    /// Dispatch on a statement.
    /// @param node The statement to visit. Recursive walkers forward absent optional statements as null.
    open func VisitStatement(node BoundStatement?) {
        if node == nil {
            return
        }
        switch node.Kind {
            case BoundNodeKind.BlockStatement {
                VisitBlockStatement(cast[BoundBlockStatement](node))
            }
            case BoundNodeKind.VariableDeclaration {
                VisitVariableDeclaration(cast[BoundVariableDeclaration](node))
            }
            case BoundNodeKind.LocalFunctionDeclaration {
                VisitLocalFunctionDeclaration(cast[BoundLocalFunctionDeclaration](node))
            }
            case BoundNodeKind.IfStatement {
                VisitIfStatement(cast[BoundIfStatement](node))
            }
            case BoundNodeKind.ForInfiniteStatement {
                VisitForInfiniteStatement(cast[BoundForInfiniteStatement](node))
            }
            case BoundNodeKind.ForEllipsisStatement {
                VisitForEllipsisStatement(cast[BoundForEllipsisStatement](node))
            }
            case BoundNodeKind.ForRangeStatement {
                VisitForRangeStatement(cast[BoundForRangeStatement](node))
            }
            case BoundNodeKind.LabelStatement, BoundNodeKind.GotoStatement { }
            case BoundNodeKind.ConditionalGotoStatement {
                VisitConditionalGotoStatement(cast[BoundConditionalGotoStatement](node))
            }
            case BoundNodeKind.ReturnStatement {
                VisitReturnStatement(cast[BoundReturnStatement](node))
            }
            case BoundNodeKind.ExpressionStatement {
                VisitExpressionStatement(cast[BoundExpressionStatement](node))
            }
            case BoundNodeKind.TryStatement {
                VisitTryStatement(cast[BoundTryStatement](node))
            }
            case BoundNodeKind.ThrowStatement {
                VisitThrowStatement(cast[BoundThrowStatement](node))
            }
            case BoundNodeKind.RethrowStatement { }
            case BoundNodeKind.PatternSwitchStatement {
                VisitPatternSwitchStatement(cast[BoundPatternSwitchStatement](node))
            }
            case BoundNodeKind.GoStatement {
                VisitGoStatement(cast[BoundGoStatement](node))
            }
            case BoundNodeKind.FixedStatement {
                VisitFixedStatement(cast[BoundFixedStatement](node))
            }
            case BoundNodeKind.AwaitForRangeStatement {
                VisitAwaitForRangeStatement(cast[BoundAwaitForRangeStatement](node))
            }
            case BoundNodeKind.YieldStatement {
                VisitYieldStatement(cast[BoundYieldStatement](node))
            }
            case BoundNodeKind.AwaitYieldPoint, BoundNodeKind.AwaitResumePoint { }
            default {
                throw InvalidOperationException("BoundTreeWalker: unexpected statement kind '${node.Kind}'.")
            }
        }
    }

    /// Dispatch on an expression.
    /// @param node The expression to visit. Recursive walkers forward absent optional expressions as null.
    open func VisitExpression(node BoundExpression?) {
        if node == nil {
            return
        }
        switch node.Kind {
            case BoundNodeKind.ErrorExpression,
            BoundNodeKind.Utf8StringExpression,
            BoundNodeKind.LiteralExpression,
            BoundNodeKind.VariableExpression,
            BoundNodeKind.DefaultExpression,
            BoundNodeKind.TypeParameterConstructionExpression,
            BoundNodeKind.TypeOfExpression,
            BoundNodeKind.SizeOfExpression,
            BoundNodeKind.FunctionPointerFromMethodExpression,
            BoundNodeKind.FunctionLiteralExpression,
            BoundNodeKind.StateMachineAwaitOnCompleted,
            BoundNodeKind.StateMachineBuilderMoveNext { }
            case BoundNodeKind.MethodGroupExpression {
                VisitMethodGroupExpression(cast[BoundMethodGroupExpression](node))
            }
            case BoundNodeKind.AssignmentExpression {
                VisitAssignmentExpression(cast[BoundAssignmentExpression](node))
            }
            case BoundNodeKind.UnaryExpression {
                VisitUnaryExpression(cast[BoundUnaryExpression](node))
            }
            case BoundNodeKind.BinaryExpression {
                VisitBinaryExpression(cast[BoundBinaryExpression](node))
            }
            case BoundNodeKind.CallExpression {
                VisitCallExpression(cast[BoundCallExpression](node))
            }
            case BoundNodeKind.FunctionPointerInvocationExpression {
                VisitFunctionPointerInvocationExpression(cast[BoundFunctionPointerInvocationExpression](node))
            }
            case BoundNodeKind.ConversionExpression {
                VisitConversionExpression(cast[BoundConversionExpression](node))
            }
            case BoundNodeKind.ImportedCallExpression {
                VisitImportedCallExpression(cast[BoundImportedCallExpression](node))
            }
            case BoundNodeKind.ImportedInstanceCallExpression {
                VisitImportedInstanceCallExpression(cast[BoundImportedInstanceCallExpression](node))
            }
            case BoundNodeKind.ConstrainedStaticCallExpression {
                VisitConstrainedStaticCallExpression(cast[BoundConstrainedStaticCallExpression](node))
            }
            case BoundNodeKind.ArrayCreationExpression {
                VisitArrayCreationExpression(cast[BoundArrayCreationExpression](node))
            }
            case BoundNodeKind.StackAllocExpression {
                VisitStackAllocExpression(cast[BoundStackAllocExpression](node))
            }
            case BoundNodeKind.MapLiteralExpression {
                VisitMapLiteralExpression(cast[BoundMapLiteralExpression](node))
            }
            case BoundNodeKind.IndexExpression {
                VisitIndexExpression(cast[BoundIndexExpression](node))
            }
            case BoundNodeKind.IndexAssignmentExpression {
                VisitIndexAssignmentExpression(cast[BoundIndexAssignmentExpression](node))
            }
            case BoundNodeKind.LenExpression {
                VisitLenExpression(cast[BoundLenExpression](node))
            }
            case BoundNodeKind.StructLiteralExpression {
                VisitStructLiteralExpression(cast[BoundStructLiteralExpression](node))
            }
            case BoundNodeKind.BlockExpression {
                VisitBlockExpression(cast[BoundBlockExpression](node))
            }
            case BoundNodeKind.ConstructorCallExpression {
                VisitConstructorCallExpression(cast[BoundConstructorCallExpression](node))
            }
            case BoundNodeKind.UserInstanceCallExpression {
                VisitUserInstanceCallExpression(cast[BoundUserInstanceCallExpression](node))
            }
            case BoundNodeKind.BaseInterfaceCallExpression {
                VisitBaseInterfaceCallExpression(cast[BoundBaseInterfaceCallExpression](node))
            }
            case BoundNodeKind.BaseClassCallExpression {
                VisitBaseClassCallExpression(cast[BoundBaseClassCallExpression](node))
            }
            case BoundNodeKind.FieldAccessExpression {
                VisitFieldAccessExpression(cast[BoundFieldAccessExpression](node))
            }
            case BoundNodeKind.FieldAssignmentExpression {
                VisitFieldAssignmentExpression(cast[BoundFieldAssignmentExpression](node))
            }
            case BoundNodeKind.PropertyAccessExpression {
                VisitPropertyAccessExpression(cast[BoundPropertyAccessExpression](node))
            }
            case BoundNodeKind.PropertyAssignmentExpression {
                VisitPropertyAssignmentExpression(cast[BoundPropertyAssignmentExpression](node))
            }
            case BoundNodeKind.NullConditionalAccessExpression {
                VisitNullConditionalAccessExpression(cast[BoundNullConditionalAccessExpression](node))
            }
            case BoundNodeKind.TupleLiteralExpression {
                VisitTupleLiteralExpression(cast[BoundTupleLiteralExpression](node))
            }
            case BoundNodeKind.TupleElementAccessExpression {
                VisitTupleElementAccessExpression(cast[BoundTupleElementAccessExpression](node))
            }
            case BoundNodeKind.ClrMethodGroupExpression {
                VisitClrMethodGroupExpression(cast[BoundClrMethodGroupExpression](node))
            }
            case BoundNodeKind.IndirectCallExpression {
                VisitIndirectCallExpression(cast[BoundIndirectCallExpression](node))
            }
            case BoundNodeKind.InterpolatedStringExpression {
                VisitInterpolatedStringExpression(cast[BoundInterpolatedStringExpression](node))
            }
            case BoundNodeKind.ClrConstructorCallExpression {
                VisitClrConstructorCallExpression(cast[BoundClrConstructorCallExpression](node))
            }
            case BoundNodeKind.ClrStaticCallExpression {
                VisitClrStaticCallExpression(cast[BoundClrStaticCallExpression](node))
            }
            case BoundNodeKind.ClrPropertyAccessExpression {
                VisitClrPropertyAccessExpression(cast[BoundClrPropertyAccessExpression](node))
            }
            case BoundNodeKind.ClrPropertyAssignmentExpression {
                VisitClrPropertyAssignmentExpression(cast[BoundClrPropertyAssignmentExpression](node))
            }
            case BoundNodeKind.ClrEventSubscriptionExpression {
                VisitClrEventSubscriptionExpression(cast[BoundClrEventSubscriptionExpression](node))
            }
            case BoundNodeKind.EventSubscriptionExpression {
                VisitEventSubscriptionExpression(cast[BoundEventSubscriptionExpression](node))
            }
            case BoundNodeKind.ClrBinaryOperatorExpression {
                VisitClrBinaryOperatorExpression(cast[BoundClrBinaryOperatorExpression](node))
            }
            case BoundNodeKind.ClrUnaryOperatorExpression {
                VisitClrUnaryOperatorExpression(cast[BoundClrUnaryOperatorExpression](node))
            }
            case BoundNodeKind.ClrConversionCallExpression {
                VisitClrConversionCallExpression(cast[BoundClrConversionCallExpression](node))
            }
            case BoundNodeKind.ClrIndexExpression {
                VisitClrIndexExpression(cast[BoundClrIndexExpression](node))
            }
            case BoundNodeKind.ClrIndexAssignmentExpression {
                VisitClrIndexAssignmentExpression(cast[BoundClrIndexAssignmentExpression](node))
            }
            case BoundNodeKind.AwaitExpression {
                VisitAwaitExpression(cast[BoundAwaitExpression](node))
            }
            case BoundNodeKind.SwitchExpression {
                VisitSwitchExpression(cast[BoundSwitchExpression](node))
            }
            case BoundNodeKind.AddressOfExpression {
                VisitAddressOfExpression(cast[BoundAddressOfExpression](node))
            }
            case BoundNodeKind.ManagedReferenceExpression {
                VisitManagedReferenceExpression(cast[BoundManagedReferenceExpression](node))
            }
            case BoundNodeKind.ManagedFieldKeyExpression {
                VisitExpression((cast[BoundManagedFieldKeyExpression](node)).Parent)
            }
            case BoundNodeKind.ConditionalAddressExpression {
                VisitConditionalAddressExpression(cast[BoundConditionalAddressExpression](node))
            }
            case BoundNodeKind.ConditionalExpression {
                VisitConditionalExpression(cast[BoundConditionalExpression](node))
            }
            case BoundNodeKind.ThrowExpression {
                VisitThrowExpression(cast[BoundThrowExpression](node))
            }
            case BoundNodeKind.DereferenceExpression {
                VisitDereferenceExpression(cast[BoundDereferenceExpression](node))
            }
            case BoundNodeKind.IndirectAssignmentExpression {
                VisitIndirectAssignmentExpression(cast[BoundIndirectAssignmentExpression](node))
            }
            case BoundNodeKind.SpillSequenceExpression {
                VisitSpillSequenceExpression(cast[BoundSpillSequenceExpression](node))
            }
            case BoundNodeKind.IsExpression {
                VisitIsExpression(cast[BoundIsExpression](node))
            }
            case BoundNodeKind.AsExpression {
                VisitAsExpression(cast[BoundAsExpression](node))
            }
            case BoundNodeKind.ConstructorChainingExpression {
                VisitConstructorChainingExpression(cast[BoundConstructorChainingExpression](node))
            }
            default {
                throw InvalidOperationException("BoundTreeWalker: unexpected expression kind '${node.Kind}'.")
            }
        }
    }

    /// Dispatch on a pattern.
    /// @param node The pattern to visit. Recursive walkers may forward an absent optional pattern.
    open func VisitPattern(node BoundPattern?) {
        if node == nil {
            return
        }
        switch node.Kind {
            case BoundNodeKind.DiscardPattern { }
            case BoundNodeKind.TypePattern {
                VisitTypePattern(cast[BoundTypePattern](node))
            }
            case BoundNodeKind.ConstantPattern {
                VisitConstantPattern(cast[BoundConstantPattern](node))
            }
            case BoundNodeKind.RelationalPattern {
                VisitRelationalPattern(cast[BoundRelationalPattern](node))
            }
            case BoundNodeKind.PropertyPattern {
                VisitPropertyPattern(cast[BoundPropertyPattern](node))
            }
            case BoundNodeKind.ListPattern {
                VisitListPattern(cast[BoundListPattern](node))
            }
            case BoundNodeKind.SlicePattern {
                VisitSlicePattern(cast[BoundSlicePattern](node))
            }
            case BoundNodeKind.BinaryPattern {
                VisitBinaryPattern(cast[BoundBinaryPattern](node))
            }
            case BoundNodeKind.NotPattern {
                VisitNotPattern(cast[BoundNotPattern](node))
            }
            default {
                throw InvalidOperationException("BoundTreeWalker: unexpected pattern kind '${node.Kind}'.")
            }
        }
    }

    // ----- Statements ----------------------------------------------------
    protected open func VisitBlockStatement(node BoundBlockStatement) {
        for s in node.Statements {
            VisitStatement(s)
        }
    }

    protected open func VisitVariableDeclaration(node BoundVariableDeclaration) {
        if node.Initializer is {} initializer {
            VisitExpression(initializer)
        }
    }

    /// Visits a generic local-function declaration (issue #1886) by descending into its function literal,
    /// mirroring (cref:VisitVariableDeclaration).
    /// @param node The node to visit.
    protected open func VisitLocalFunctionDeclaration(node BoundLocalFunctionDeclaration) {
        VisitExpression(node.Literal)
    }

    protected open func VisitIfStatement(node BoundIfStatement) {
        VisitExpression(node.Condition)
        VisitStatement(node.ThenStatement)
        if node.ElseStatement != nil {
            VisitStatement(node.ElseStatement)
        }
    }

    protected open func VisitForInfiniteStatement(node BoundForInfiniteStatement) {
        VisitStatement(node.Body)
    }

    protected open func VisitForEllipsisStatement(node BoundForEllipsisStatement) {
        VisitExpression(node.LowerBound)
        VisitExpression(node.UpperBound)
        VisitStatement(node.Body)
    }

    protected open func VisitForRangeStatement(node BoundForRangeStatement) {
        VisitExpression(node.Collection)
        VisitStatement(node.Body)
    }

    protected open func VisitConditionalGotoStatement(node BoundConditionalGotoStatement) {
        VisitExpression(node.Condition)
    }

    protected open func VisitReturnStatement(node BoundReturnStatement) {
        if node.Expression != nil {
            VisitExpression(node.Expression)
        }
    }

    protected open func VisitExpressionStatement(node BoundExpressionStatement) {
        VisitExpression(node.Expression)
    }

    protected open func VisitTryStatement(node BoundTryStatement) {
        VisitStatement(node.TryBlock)
        for clause in node.CatchClauses {
            if clause.Filter != nil {
                VisitExpression(clause.Filter)
            }
            VisitStatement(clause.Body)
        }
        if node.FinallyBlock != nil {
            VisitStatement(node.FinallyBlock)
        }
    }

    protected open func VisitThrowStatement(node BoundThrowStatement) {
        VisitExpression(node.Expression)
    }

    protected open func VisitPatternSwitchStatement(node BoundPatternSwitchStatement) {
        VisitExpression(node.Discriminant)
        for arm in node.Arms {
            if arm.Pattern != nil {
                VisitPattern(arm.Pattern)
            }
            if arm.Guard != nil {
                VisitExpression(arm.Guard)
            }
            VisitStatement(arm.Body)
        }
    }

    protected open func VisitGoStatement(node BoundGoStatement) {
        VisitExpression(node.Expression)
        if node.Sink != nil {
            VisitExpression(node.Sink)
        }
    }

    protected open func VisitFixedStatement(node BoundFixedStatement) {
        VisitExpression(node.PinnedSource)
        VisitStatement(node.Body)
    }

    protected open func VisitAwaitForRangeStatement(node BoundAwaitForRangeStatement) {
        VisitExpression(node.Stream)
        VisitStatement(node.Body)
    }

    protected open func VisitYieldStatement(node BoundYieldStatement) {
        VisitExpression(node.Expression)
    }

    // ----- Expressions ---------------------------------------------------
    protected open func VisitAssignmentExpression(node BoundAssignmentExpression) {
        VisitExpression(node.Expression)
    }

    protected open func VisitUnaryExpression(node BoundUnaryExpression) {
        VisitExpression(node.Operand)
    }

    protected open func VisitBinaryExpression(node BoundBinaryExpression) {
        VisitExpression(node.Left)
        VisitExpression(node.Right)
    }

    protected open func VisitCallExpression(node BoundCallExpression) {
        VisitList(node.Arguments)
    }

    /// ADR-0122 §9 / issue #1035: visit a function-pointer `calli` invocation.
    /// @param node The bound node.
    protected open func VisitFunctionPointerInvocationExpression(node BoundFunctionPointerInvocationExpression) {
        VisitExpression(node.Pointer)
        VisitList(node.Arguments)
    }

    protected open func VisitConversionExpression(node BoundConversionExpression) {
        VisitExpression(node.Expression)
    }

    protected open func VisitImportedCallExpression(node BoundImportedCallExpression) {
        VisitList(node.Arguments)
    }

    protected open func VisitImportedInstanceCallExpression(node BoundImportedInstanceCallExpression) {
        VisitExpression(node.Receiver)
        VisitList(node.Arguments)
    }

    /// ADR-0089 / issue #755: visit a constrained static-virtual call.
    /// @param node The bound node.
    protected open func VisitConstrainedStaticCallExpression(node BoundConstrainedStaticCallExpression) {
        VisitList(node.Arguments)
    }

    protected open func VisitArrayCreationExpression(node BoundArrayCreationExpression) {
        if node.DimensionExpressions.Length > 1 {
            VisitList(node.DimensionExpressions)
        } else if node.LengthExpression != nil {
            VisitExpression(node.LengthExpression)
        }
        VisitList(node.Elements)
    }

    protected open func VisitStackAllocExpression(node BoundStackAllocExpression) {
        VisitExpression(node.Count)
        for element in node.InitializerElements {
            VisitExpression(element)
        }
    }

    protected open func VisitMapLiteralExpression(node BoundMapLiteralExpression) {
        for entry in node.Entries {
            VisitExpression(entry.Key)
            VisitExpression(entry.Value)
        }
    }

    protected open func VisitIndexExpression(node BoundIndexExpression) {
        VisitExpression(node.Target)
        for index in node.Indices {
            VisitExpression(index)
        }
    }

    protected open func VisitIndexAssignmentExpression(node BoundIndexAssignmentExpression) {
        if node.TargetExpression != nil {
            VisitExpression(node.TargetExpression)
        }
        for index in node.Indices {
            VisitExpression(index)
        }
        VisitExpression(node.Value)
    }

    protected open func VisitLenExpression(node BoundLenExpression) {
        VisitExpression(node.Operand)
    }

    protected open func VisitStructLiteralExpression(node BoundStructLiteralExpression) {
        if node.CopySource != nil {
            VisitExpression(node.CopySource)
        }
        for init in node.Initializers {
            VisitExpression(init.Value)
        }
    }

    protected open func VisitBlockExpression(node BoundBlockExpression) {
        for s in node.Statements {
            VisitStatement(s)
        }
        VisitExpression(node.Expression)
    }

    protected open func VisitConstructorCallExpression(node BoundConstructorCallExpression) {
        VisitList(node.Arguments)
    }

    /// ADR-0065 §2: visits a (cref:BoundConstructorChainingExpression).
    /// @param node The node being visited.
    protected open func VisitConstructorChainingExpression(node BoundConstructorChainingExpression) {
        VisitList(node.Arguments)
    }

    protected open func VisitUserInstanceCallExpression(node BoundUserInstanceCallExpression) {
        VisitExpression(node.Receiver)
        VisitList(node.Arguments)
    }

    /// ADR-0091: visits a (cref:BoundBaseInterfaceCallExpression).
    /// @param node The node being visited.
    protected open func VisitBaseInterfaceCallExpression(node BoundBaseInterfaceCallExpression) {
        VisitExpression(node.Receiver)
        VisitList(node.Arguments)
    }

    /// Issue #986: visits a (cref:BoundBaseClassCallExpression).
    /// @param node The node being visited.
    protected open func VisitBaseClassCallExpression(node BoundBaseClassCallExpression) {
        VisitExpression(node.Receiver)
        VisitList(node.Arguments)
    }

    protected open func VisitFieldAccessExpression(node BoundFieldAccessExpression) {
        if node.Receiver != nil {
            VisitExpression(node.Receiver)
        }
    }

    protected open func VisitFieldAssignmentExpression(node BoundFieldAssignmentExpression) {
        // Issue #1614: an expression-based receiver (issue #567, closure
        // boxing) is an arbitrary BoundExpression subtree — visit it so
        // pre-pass collectors (e.g. AssignmentValueSpillCollector,
        // ReceiverSpillCollector) see any nested spill-worthy nodes inside
        // it, not just the top-level field assignment node.
        if node.ReceiverExpression != nil {
            VisitExpression(node.ReceiverExpression)
        }
        VisitExpression(node.Value)
    }

    protected open func VisitPropertyAccessExpression(node BoundPropertyAccessExpression) {
        if node.Receiver != nil {
            VisitExpression(node.Receiver)
        }
    }

    protected open func VisitPropertyAssignmentExpression(node BoundPropertyAssignmentExpression) {
        if node.Receiver != nil {
            VisitExpression(node.Receiver)
        }
        VisitExpression(node.Value)
    }

    protected open func VisitNullConditionalAccessExpression(node BoundNullConditionalAccessExpression) {
        VisitExpression(node.Receiver)
        VisitExpression(node.WhenNotNull)
    }

    protected open func VisitTupleLiteralExpression(node BoundTupleLiteralExpression) {
        VisitList(node.Elements)
    }

    protected open func VisitTupleElementAccessExpression(node BoundTupleElementAccessExpression) {
        VisitExpression(node.Receiver)
    }

    protected open func VisitClrMethodGroupExpression(node BoundClrMethodGroupExpression) {
        if node.Receiver != nil {
            VisitExpression(node.Receiver)
        }
    }

    protected open func VisitMethodGroupExpression(node BoundMethodGroupExpression) {
        if node.Receiver != nil {
            VisitExpression(node.Receiver)
        }
    }

    protected open func VisitIndirectCallExpression(node BoundIndirectCallExpression) {
        VisitExpression(node.Target)
        VisitList(node.Arguments)
    }

    protected open func VisitInterpolatedStringExpression(node BoundInterpolatedStringExpression) {
        for part in node.Parts {
            if !part.IsLiteral {
                VisitExpression(part.Value)
            }
        }
        if node.Handler != nil && !node.Handler.ForwardedArguments.IsDefaultOrEmpty {
            VisitList(node.Handler.ForwardedArguments)
        }
    }

    protected open func VisitClrConstructorCallExpression(node BoundClrConstructorCallExpression) {
        VisitList(node.Arguments)
    }

    protected open func VisitClrStaticCallExpression(node BoundClrStaticCallExpression) {
        VisitList(node.Arguments)
    }

    protected open func VisitClrPropertyAccessExpression(node BoundClrPropertyAccessExpression) {
        if node.Receiver != nil {
            VisitExpression(node.Receiver)
        }
    }

    protected open func VisitClrPropertyAssignmentExpression(node BoundClrPropertyAssignmentExpression) {
        if node.Receiver != nil {
            VisitExpression(node.Receiver)
        }
        VisitExpression(node.Value)
    }

    protected open func VisitClrEventSubscriptionExpression(node BoundClrEventSubscriptionExpression) {
        if node.Receiver != nil {
            VisitExpression(node.Receiver)
        }
        VisitExpression(node.Handler)
    }

    protected open func VisitEventSubscriptionExpression(node BoundEventSubscriptionExpression) {
        if node.Receiver != nil {
            VisitExpression(node.Receiver)
        }
        VisitExpression(node.Handler)
    }

    protected open func VisitClrBinaryOperatorExpression(node BoundClrBinaryOperatorExpression) {
        VisitExpression(node.Left)
        VisitExpression(node.Right)
    }

    protected open func VisitClrUnaryOperatorExpression(node BoundClrUnaryOperatorExpression) {
        VisitExpression(node.Operand)
    }

    protected open func VisitClrConversionCallExpression(node BoundClrConversionCallExpression) {
        VisitExpression(node.Source)
    }

    protected open func VisitClrIndexExpression(node BoundClrIndexExpression) {
        VisitExpression(node.Target)
        VisitList(node.Arguments)
    }

    protected open func VisitClrIndexAssignmentExpression(node BoundClrIndexAssignmentExpression) {
        if node.TargetExpression != nil {
            VisitExpression(node.TargetExpression)
        }
        VisitList(node.Arguments)
        VisitExpression(node.Value)
    }

    protected open func VisitAwaitExpression(node BoundAwaitExpression) {
        VisitExpression(node.Expression)
    }

    protected open func VisitSwitchExpression(node BoundSwitchExpression) {
        VisitExpression(node.Discriminant)
        for arm in node.Arms {
            if arm.Pattern != nil {
                VisitPattern(arm.Pattern)
            }
            if arm.Guard != nil {
                VisitExpression(arm.Guard)
            }
            VisitExpression(arm.Result)
        }
    }

    protected open func VisitAddressOfExpression(node BoundAddressOfExpression) {
        VisitExpression(node.Operand)
    }

    protected open func VisitManagedReferenceExpression(node BoundManagedReferenceExpression) {
        VisitExpression(node.Location)
    }

    /// ADR-0061: visits a conditional address-of expression.
    /// @param node The conditional address-of expression.
    protected open func VisitConditionalAddressExpression(node BoundConditionalAddressExpression) {
        VisitExpression(node.Condition)
        VisitExpression(node.WhenTrueOperand)
        VisitExpression(node.WhenFalseOperand)
    }

    /// ADR-0062: visits a general two-arm conditional (ternary) expression.
    /// @param node The conditional expression.
    protected open func VisitConditionalExpression(node BoundConditionalExpression) {
        VisitExpression(node.Condition)
        VisitExpression(node.WhenTrue)
        VisitExpression(node.WhenFalse)
    }

    /// Issue #1018: visits a throw-expression's operand.
    /// @param node The throw-expression to visit.
    protected open func VisitThrowExpression(node BoundThrowExpression) {
        VisitExpression(node.Expression)
    }

    protected open func VisitDereferenceExpression(node BoundDereferenceExpression) {
        VisitExpression(node.Operand)
    }

    protected open func VisitIndirectAssignmentExpression(node BoundIndirectAssignmentExpression) {
        VisitExpression(node.Pointer)
        VisitExpression(node.Value)
    }

    protected open func VisitSpillSequenceExpression(node BoundSpillSequenceExpression) {
        for s in node.SideEffects {
            VisitStatement(s)
        }
        VisitExpression(node.Value)
    }

    // ----- Patterns ------------------------------------------------------
    protected open func VisitConstantPattern(node BoundConstantPattern) {
        VisitExpression(node.Value)
    }

    protected open func VisitRelationalPattern(node BoundRelationalPattern) {
        VisitExpression(node.Value)
    }

    protected open func VisitTypePattern(node BoundTypePattern) {
        if node.PropertyPattern != nil {
            VisitPropertyPattern(node.PropertyPattern)
        }
    }

    protected open func VisitPropertyPattern(node BoundPropertyPattern) {
        for field in node.Fields {
            VisitPattern(field.Pattern)
        }
    }

    protected open func VisitListPattern(node BoundListPattern) {
        for element in node.Elements {
            VisitPattern(element)
        }
    }

    protected open func VisitSlicePattern(node BoundSlicePattern) {
        if node.Pattern != nil {
            VisitPattern(node.Pattern)
        }
    }

    protected open func VisitBinaryPattern(node BoundBinaryPattern) {
        VisitPattern(node.Left)
        VisitPattern(node.Right)
    }

    protected open func VisitNotPattern(node BoundNotPattern) {
        VisitPattern(node.Pattern)
    }

    protected open func VisitIsExpression(node BoundIsExpression) {
        VisitExpression(node.Expression)
        VisitPattern(node.Pattern)
    }

    // ----- Helpers -------------------------------------------------------
    private func VisitList(items ImmutableArray[BoundExpression]) {
        if items.IsDefaultOrEmpty {
            return
        }
        for item in items {
            VisitExpression(item)
        }
    }

    private func VisitAsExpression(node BoundAsExpression) {
        VisitExpression(node.Expression)
    }
}
