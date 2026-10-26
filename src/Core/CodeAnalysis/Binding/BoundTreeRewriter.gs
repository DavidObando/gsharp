// <copyright file="BoundTreeRewriter.cs" company="GSharp">

// Copyright (C) GSharp Authors. All rights reserved.

// </copyright>


package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable

/// Abstract bound tree rewriter.
abstract class BoundTreeRewriter {
    /// Reweites bound statements.
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    open func RewriteStatement(node BoundStatement) BoundStatement {
        switch node.Kind {
            case BoundNodeKind.BlockStatement {
                return RewriteBlockStatement(cast[BoundBlockStatement](node))
            }
            case BoundNodeKind.VariableDeclaration {
                return RewriteVariableDeclaration(cast[BoundVariableDeclaration](node))
            }
            case BoundNodeKind.LocalFunctionDeclaration {
                return RewriteLocalFunctionDeclaration(cast[BoundLocalFunctionDeclaration](node))
            }
            case BoundNodeKind.IfStatement {
                return RewriteIfStatement(cast[BoundIfStatement](node))
            }
            case BoundNodeKind.ForInfiniteStatement {
                return RewriteForInfiniteStatement(cast[BoundForInfiniteStatement](node))
            }
            case BoundNodeKind.ForEllipsisStatement {
                return RewriteForEllipsisStatement(cast[BoundForEllipsisStatement](node))
            }
            case BoundNodeKind.ForRangeStatement {
                return RewriteForRangeStatement(cast[BoundForRangeStatement](node))
            }
            case BoundNodeKind.LabelStatement {
                return RewriteLabelStatement(cast[BoundLabelStatement](node))
            }
            case BoundNodeKind.GotoStatement {
                return RewriteGotoStatement(cast[BoundGotoStatement](node))
            }
            case BoundNodeKind.ConditionalGotoStatement {
                return RewriteConditionalGotoStatement(cast[BoundConditionalGotoStatement](node))
            }
            case BoundNodeKind.ReturnStatement {
                return RewriteReturnStatement(cast[BoundReturnStatement](node))
            }
            case BoundNodeKind.ExpressionStatement {
                return RewriteExpressionStatement(cast[BoundExpressionStatement](node))
            }
            case BoundNodeKind.TryStatement {
                return RewriteTryStatement(cast[BoundTryStatement](node))
            }
            case BoundNodeKind.ThrowStatement {
                return RewriteThrowStatement(cast[BoundThrowStatement](node))
            }
            case BoundNodeKind.RethrowStatement {
                return RewriteRethrowStatement(cast[BoundRethrowStatement](node))
            }
            case BoundNodeKind.PatternSwitchStatement {
                return RewritePatternSwitchStatement(cast[BoundPatternSwitchStatement](node))
            }
            case BoundNodeKind.GoStatement {
                return RewriteGoStatement(cast[BoundGoStatement](node))
            }
            case BoundNodeKind.FixedStatement {
                return RewriteFixedStatement(cast[BoundFixedStatement](node))
            }
            case BoundNodeKind.AwaitForRangeStatement {
                return RewriteAwaitForRangeStatement(cast[BoundAwaitForRangeStatement](node))
            }
            case BoundNodeKind.YieldStatement {
                return RewriteYieldStatement(cast[BoundYieldStatement](node))
            }
            case BoundNodeKind.AwaitYieldPoint, BoundNodeKind.AwaitResumePoint {
                return node
            }
            default {
                throw Exception("Unexpected node: ${node.Kind}")
            }
        }
    }

    /// Rewrites a block statement.
    /// @param node The block statement to rewrite.
    /// @returns The rewritten block statement.
    protected open func RewriteBlockStatement(node BoundBlockStatement) BoundStatement {
        var builder ImmutableArray[BoundStatement].Builder? = nil
        for var i = 0; i < node.Statements.Length; i++ {
            let oldStatement = node.Statements[i]
            let newStatement = RewriteStatement(oldStatement)
            if newStatement != oldStatement {
                if builder == nil {
                    builder = ImmutableArray.CreateBuilder[BoundStatement](node.Statements.Length)
                    for var j = 0; j < i; j++ {
                        builder.Add(node.Statements[j])
                    }
                }
            }
            if builder != nil {
                builder.Add(newStatement)
            }
        }
        if builder == nil {
            return node
        }
        return BoundBlockStatement(node.Syntax, builder.MoveToImmutable())
    }

    /// Rewrites a variable declaration.
    /// @param node The variable declaration to rewrite.
    /// @returns The rewritten variable declaration.
    protected open func RewriteVariableDeclaration(node BoundVariableDeclaration) BoundStatement {
        let initializer = if node.Initializer == nil {
            default(BoundExpression?)
        } else {
            RewriteExpression(node.Initializer)
        }
        if initializer == node.Initializer {
            return node
        }
        return BoundVariableDeclaration(node.Syntax, node.Variable, initializer, node.ConstantValue)
    }

    /// Rewrites a generic local-function declaration (issue #1886). The literal's body is intentionally not
    /// rewritten here — it forms a separate lexical scope, exactly like
    /// (cref:RewriteFunctionLiteralExpression), and is lowered independently at the point it is hosted for
    /// emission.
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteLocalFunctionDeclaration(node BoundLocalFunctionDeclaration) BoundStatement {
        return node
    }

    /// Rewrites an if statement.
    /// @param node The if statement to rewrite.
    /// @returns The rewritten if statement.
    protected open func RewriteIfStatement(node BoundIfStatement) BoundStatement {
        let condition = RewriteExpression(node.Condition)
        let thenStatement = RewriteStatement(node.ThenStatement)
        let elseStatement = if node.ElseStatement == nil {
            default(BoundStatement?)
        } else {
            RewriteStatement(node.ElseStatement)
        }
        if condition == node.Condition && thenStatement == node.ThenStatement && elseStatement == node.ElseStatement {
            return node
        }
        return BoundIfStatement(node.Syntax, condition, thenStatement, elseStatement)
    }

    /// Rewrites a for infinite statement.
    /// @param node The for infinite statement to rewrite.
    /// @returns The rewritten for infinite statement.
    protected open func RewriteForInfiniteStatement(node BoundForInfiniteStatement) BoundStatement {
        let body = RewriteStatement(node.Body)
        if body == node.Body {
            return node
        }
        return BoundForInfiniteStatement(node.Syntax, body, node.BreakLabel, node.ContinueLabel)
    }

    /// Rewrites a for ellipsis statement.
    /// @param node The for ellipsis statement to rewrite.
    /// @returns The rewritten for ellipsis statement.
    protected open func RewriteForEllipsisStatement(node BoundForEllipsisStatement) BoundStatement {
        let lowerBound = RewriteExpression(node.LowerBound)
        let upperBound = RewriteExpression(node.UpperBound)
        let body = RewriteStatement(node.Body)
        if lowerBound == node.LowerBound && upperBound == node.UpperBound && body == node.Body {
            return node
        }
        return BoundForEllipsisStatement(
            node.Syntax,
            node.Variable,
            lowerBound,
            upperBound,
            body,
            node.BreakLabel,
            node.ContinueLabel
        )
    }

    /// Rewrites a for-range statement.
    /// @param node The for-range statement to rewrite.
    /// @returns The rewritten for-range statement.
    protected open func RewriteForRangeStatement(node BoundForRangeStatement) BoundStatement {
        let collection = RewriteExpression(node.Collection)
        let body = RewriteStatement(node.Body)
        if collection == node.Collection && body == node.Body {
            return node
        }
        return BoundForRangeStatement(
            node.Syntax,
            node.KeyVariable,
            node.ValueVariable,
            collection,
            node.IterationKind,
            body,
            node.BreakLabel,
            node.ContinueLabel
        )
    }

    /// Rewrites a label statement.
    /// @param node The label statement to rewrite.
    /// @returns The rewritten label statement.
    protected open func RewriteLabelStatement(node BoundLabelStatement) BoundStatement {
        return node
    }

    /// Rewrites a goto statement.
    /// @param node The goto statement to rewrite.
    /// @returns The rewritten goto statement.
    protected open func RewriteGotoStatement(node BoundGotoStatement) BoundStatement {
        return node
    }

    /// Rewrites a conditional goto statement.
    /// @param node The conditional goto statement to rewrite.
    /// @returns The rewritten conditional goto statement.
    protected open func RewriteConditionalGotoStatement(node BoundConditionalGotoStatement) BoundStatement {
        let condition = RewriteExpression(node.Condition)
        if condition == node.Condition {
            return node
        }
        return BoundConditionalGotoStatement(node.Syntax, node.Label, condition, node.JumpIfTrue)
    }

    /// Rewrites a return statement.
    /// @param node The return statement to rewrite.
    /// @returns The rewritten return statement.
    protected open func RewriteReturnStatement(node BoundReturnStatement) BoundStatement {
        let expression = if node.Expression == nil {
            default(BoundExpression?)
        } else {
            RewriteExpression(node.Expression)
        }
        if expression == node.Expression {
            return node
        }
        return BoundReturnStatement(node.Syntax, expression, node.IsRef)
    }

    /// Rewrites an expression statement.
    /// @param node The expression statement to rewrite.
    /// @returns The rewritten expression statement.
    protected open func RewriteExpressionStatement(node BoundExpressionStatement) BoundStatement {
        let expression = RewriteExpression(node.Expression)
        if expression == node.Expression {
            return node
        }
        return BoundExpressionStatement(node.Syntax, expression)
    }

    /// Rewrites a try statement.
    /// @param node The try statement to rewrite.
    /// @returns The rewritten statement.
    protected open func RewriteTryStatement(node BoundTryStatement) BoundStatement {
        let tryBlock = RewriteStatement(node.TryBlock)
        let rewrittenClauses = ImmutableArray.CreateBuilder[BoundCatchClause]()
        var clausesChanged = false
        for clause in node.CatchClauses {
            let filter = if clause.Filter == nil {
                default(BoundExpression?)
            } else {
                RewriteExpression(clause.Filter)
            }
            let body = RewriteStatement(clause.Body)
            let rewritten = clause.Update(filter, body)
            rewrittenClauses.Add(rewritten)
            if !object.ReferenceEquals(rewritten, clause) {
                clausesChanged = true
            }
        }
        let finallyBlock = if node.FinallyBlock == nil {
            default(BoundStatement?)
        } else {
            RewriteStatement(node.FinallyBlock)
        }
        if tryBlock == node.TryBlock && !clausesChanged && finallyBlock == node.FinallyBlock {
            return node
        }
        return BoundTryStatement(node.Syntax, tryBlock, rewrittenClauses.ToImmutable(), finallyBlock)
    }

    /// Rewrites a rethrow statement (ADR-0176).
    /// @param node The rethrow statement to rewrite.
    /// @returns The rewritten statement; the node itself by default, since a
    /// rethrow has no children.
    protected open func RewriteRethrowStatement(node BoundRethrowStatement) BoundStatement -> node

    /// Rewrites a throw statement.
    /// @param node The throw statement to rewrite.
    /// @returns The rewritten statement.
    protected open func RewriteThrowStatement(node BoundThrowStatement) BoundStatement {
        let expression = RewriteExpression(node.Expression)
        if expression == node.Expression {
            return node
        }
        return BoundThrowStatement(node.Syntax, expression, node.DiagnosticDescriptor)
    }

    /// Rewrites an expression.
    /// @param node The expression to rewrite.
    /// @returns The rewritten expression.
    protected open func RewriteExpression(node BoundExpression) BoundExpression {
        switch node.Kind {
            case BoundNodeKind.ErrorExpression {
                return RewriteErrorExpression(cast[BoundErrorExpression](node))
            }
            case BoundNodeKind.LiteralExpression {
                return RewriteLiteralExpression(cast[BoundLiteralExpression](node))
            }
            case BoundNodeKind.VariableExpression {
                return RewriteVariableExpression(cast[BoundVariableExpression](node))
            }
            case BoundNodeKind.AssignmentExpression {
                return RewriteAssignmentExpression(cast[BoundAssignmentExpression](node))
            }
            case BoundNodeKind.UnaryExpression {
                return RewriteUnaryExpression(cast[BoundUnaryExpression](node))
            }
            case BoundNodeKind.BinaryExpression {
                return RewriteBinaryExpression(cast[BoundBinaryExpression](node))
            }
            case BoundNodeKind.CallExpression {
                return RewriteCallExpression(cast[BoundCallExpression](node))
            }
            case BoundNodeKind.ConversionExpression {
                return RewriteConversionExpression(cast[BoundConversionExpression](node))
            }
            case BoundNodeKind.ImportedCallExpression {
                return RewriteImportedCallExpression(cast[BoundImportedCallExpression](node))
            }
            case BoundNodeKind.ImportedInstanceCallExpression {
                return RewriteImportedInstanceCallExpression(cast[BoundImportedInstanceCallExpression](node))
            }
            case BoundNodeKind.ConstrainedStaticCallExpression {
                return RewriteConstrainedStaticCallExpression(cast[BoundConstrainedStaticCallExpression](node))
            }
            case BoundNodeKind.ArrayCreationExpression {
                return RewriteArrayCreationExpression(cast[BoundArrayCreationExpression](node))
            }
            case BoundNodeKind.StackAllocExpression {
                return RewriteStackAllocExpression(cast[BoundStackAllocExpression](node))
            }
            case BoundNodeKind.MapLiteralExpression {
                return RewriteMapLiteralExpression(cast[BoundMapLiteralExpression](node))
            }
            case BoundNodeKind.IndexExpression {
                return RewriteIndexExpression(cast[BoundIndexExpression](node))
            }
            case BoundNodeKind.IndexAssignmentExpression {
                return RewriteIndexAssignmentExpression(cast[BoundIndexAssignmentExpression](node))
            }
            case BoundNodeKind.LenExpression {
                return RewriteLenExpression(cast[BoundLenExpression](node))
            }
            case BoundNodeKind.StructLiteralExpression {
                return RewriteStructLiteralExpression(cast[BoundStructLiteralExpression](node))
            }
            case BoundNodeKind.BlockExpression {
                return RewriteBlockExpression(cast[BoundBlockExpression](node))
            }
            case BoundNodeKind.ConstructorCallExpression {
                return RewriteConstructorCallExpression(cast[BoundConstructorCallExpression](node))
            }
            case BoundNodeKind.UserInstanceCallExpression {
                return RewriteUserInstanceCallExpression(cast[BoundUserInstanceCallExpression](node))
            }
            case BoundNodeKind.BaseInterfaceCallExpression {
                return RewriteBaseInterfaceCallExpression(cast[BoundBaseInterfaceCallExpression](node))
            }
            case BoundNodeKind.BaseClassCallExpression {
                return RewriteBaseClassCallExpression(cast[BoundBaseClassCallExpression](node))
            }
            case BoundNodeKind.FieldAccessExpression {
                return RewriteFieldAccessExpression(cast[BoundFieldAccessExpression](node))
            }
            case BoundNodeKind.FieldAssignmentExpression {
                return RewriteFieldAssignmentExpression(cast[BoundFieldAssignmentExpression](node))
            }
            case BoundNodeKind.PropertyAccessExpression {
                return RewritePropertyAccessExpression(cast[BoundPropertyAccessExpression](node))
            }
            case BoundNodeKind.PropertyAssignmentExpression {
                return RewritePropertyAssignmentExpression(cast[BoundPropertyAssignmentExpression](node))
            }
            case BoundNodeKind.NullConditionalAccessExpression {
                return RewriteNullConditionalAccessExpression(cast[BoundNullConditionalAccessExpression](node))
            }
            case BoundNodeKind.TupleLiteralExpression {
                return RewriteTupleLiteralExpression(cast[BoundTupleLiteralExpression](node))
            }
            case BoundNodeKind.TupleElementAccessExpression {
                return RewriteTupleElementAccessExpression(cast[BoundTupleElementAccessExpression](node))
            }
            case BoundNodeKind.FunctionLiteralExpression {
                return RewriteFunctionLiteralExpression(cast[BoundFunctionLiteralExpression](node))
            }
            case BoundNodeKind.MethodGroupExpression {
                return RewriteMethodGroupExpression(cast[BoundMethodGroupExpression](node))
            }
            case BoundNodeKind.ClrMethodGroupExpression {
                return RewriteClrMethodGroupExpression(cast[BoundClrMethodGroupExpression](node))
            }
            case BoundNodeKind.IndirectCallExpression {
                return RewriteIndirectCallExpression(cast[BoundIndirectCallExpression](node))
            }
            case BoundNodeKind.InterpolatedStringExpression {
                return RewriteInterpolatedStringExpression(cast[BoundInterpolatedStringExpression](node))
            }
            case BoundNodeKind.ClrConstructorCallExpression {
                return RewriteClrConstructorCallExpression(cast[BoundClrConstructorCallExpression](node))
            }
            case BoundNodeKind.ClrStaticCallExpression {
                return RewriteClrStaticCallExpression(cast[BoundClrStaticCallExpression](node))
            }
            case BoundNodeKind.ClrPropertyAccessExpression {
                return RewriteClrPropertyAccessExpression(cast[BoundClrPropertyAccessExpression](node))
            }
            case BoundNodeKind.ClrPropertyAssignmentExpression {
                return RewriteClrPropertyAssignmentExpression(cast[BoundClrPropertyAssignmentExpression](node))
            }
            case BoundNodeKind.ClrEventSubscriptionExpression {
                return RewriteClrEventSubscriptionExpression(cast[BoundClrEventSubscriptionExpression](node))
            }
            case BoundNodeKind.EventSubscriptionExpression {
                return RewriteEventSubscriptionExpression(cast[BoundEventSubscriptionExpression](node))
            }
            case BoundNodeKind.ClrBinaryOperatorExpression {
                return RewriteClrBinaryOperatorExpression(cast[BoundClrBinaryOperatorExpression](node))
            }
            case BoundNodeKind.ClrUnaryOperatorExpression {
                return RewriteClrUnaryOperatorExpression(cast[BoundClrUnaryOperatorExpression](node))
            }
            case BoundNodeKind.ClrConversionCallExpression {
                return RewriteClrConversionCallExpression(cast[BoundClrConversionCallExpression](node))
            }
            case BoundNodeKind.ClrIndexExpression {
                return RewriteClrIndexExpression(cast[BoundClrIndexExpression](node))
            }
            case BoundNodeKind.ClrIndexAssignmentExpression {
                return RewriteClrIndexAssignmentExpression(cast[BoundClrIndexAssignmentExpression](node))
            }
            case BoundNodeKind.AwaitExpression {
                return RewriteAwaitExpression(cast[BoundAwaitExpression](node))
            }
            case BoundNodeKind.SwitchExpression {
                return RewriteSwitchExpression(cast[BoundSwitchExpression](node))
            }
            case BoundNodeKind.AddressOfExpression {
                return RewriteAddressOfExpression(cast[BoundAddressOfExpression](node))
            }
            case BoundNodeKind.ManagedReferenceExpression {
                return RewriteManagedReferenceExpression(cast[BoundManagedReferenceExpression](node))
            }
            case BoundNodeKind.ManagedFieldKeyExpression {
                let key = cast[BoundManagedFieldKeyExpression](node)
                let keyParent = RewriteExpression(key.Parent)
                let keyField = RewriteExpression(key.Field)
                return if keyParent == key.Parent && keyField == key.Field {
                    key
                } else {
                    BoundManagedFieldKeyExpression(keyParent, keyField)
                }
            }
            case BoundNodeKind.ConditionalAddressExpression {
                return RewriteConditionalAddressExpression(cast[BoundConditionalAddressExpression](node))
            }
            case BoundNodeKind.ConditionalExpression {
                return RewriteConditionalExpression(cast[BoundConditionalExpression](node))
            }
            case BoundNodeKind.ThrowExpression {
                return RewriteThrowExpression(cast[BoundThrowExpression](node))
            }
            case BoundNodeKind.DereferenceExpression {
                return RewriteDereferenceExpression(cast[BoundDereferenceExpression](node))
            }
            case BoundNodeKind.IndirectAssignmentExpression {
                return RewriteIndirectAssignmentExpression(cast[BoundIndirectAssignmentExpression](node))
            }
            case BoundNodeKind.StateMachineAwaitOnCompleted {
                return RewriteStateMachineAwaitOnCompleted(cast[BoundStateMachineAwaitOnCompleted](node))
            }
            case BoundNodeKind.StateMachineBuilderMoveNext {
                return node
            }
            case BoundNodeKind.SpillSequenceExpression {
                return RewriteSpillSequenceExpression(cast[BoundSpillSequenceExpression](node))
            }
            case BoundNodeKind.DefaultExpression {
                return RewriteDefaultExpression(cast[BoundDefaultExpression](node))
            }
            case BoundNodeKind.TypeParameterConstructionExpression {
                return RewriteTypeParameterConstructionExpression(cast[BoundTypeParameterConstructionExpression](node))
            }
            case BoundNodeKind.TypeOfExpression {
                return node
            }
            case BoundNodeKind.SizeOfExpression {
                return node
            }
            case BoundNodeKind.FunctionPointerFromMethodExpression {
                return node
            }
            case BoundNodeKind.FunctionPointerInvocationExpression {
                return RewriteFunctionPointerInvocationExpression(cast[BoundFunctionPointerInvocationExpression](node))
            }
            case BoundNodeKind.IsExpression {
                return RewriteIsExpression(cast[BoundIsExpression](node))
            }
            case BoundNodeKind.AsExpression {
                return RewriteAsExpression(cast[BoundAsExpression](node))
            }
            case BoundNodeKind.ConstructorChainingExpression {
                return RewriteConstructorChainingExpression(cast[BoundConstructorChainingExpression](node))
            }
            default {
                throw Exception("Unexpected node: ${node.Kind}")
            }
        }
    }

    /// Rewrites an error expression.
    /// @param node The error expression to rewrite.
    /// @returns The rewritten error expression.
    protected open func RewriteErrorExpression(node BoundErrorExpression) BoundExpression {
        return node
    }

    /// Rewrites a literal expression.
    /// @param node The literal expression to rewrite.
    /// @returns The rewritten literal expression.
    protected open func RewriteLiteralExpression(node BoundLiteralExpression) BoundExpression {
        return node
    }

    /// Rewrites a default expression. Leaf node — returns as-is by default.
    /// @param node The default expression to rewrite.
    /// @returns The rewritten default expression.
    protected open func RewriteDefaultExpression(node BoundDefaultExpression) BoundExpression {
        return node
    }

    /// Issue #988: rewrites a (cref:BoundTypeParameterConstructionExpression) (a leaf).
    /// @param node The type-parameter construction expression to rewrite.
    /// @returns The rewritten expression.
    protected open func RewriteTypeParameterConstructionExpression(
        node BoundTypeParameterConstructionExpression
    ) BoundExpression {
        return node
    }

    /// Rewrites a variable expression.
    /// @param node The variable expression to rewrite.
    /// @returns The rewritten variable expression.
    protected open func RewriteVariableExpression(node BoundVariableExpression) BoundExpression {
        return node
    }

    /// Rewrites an assignment expression.
    /// @param node The assignment expression to rewrite.
    /// @returns The rewritten assignment expression.
    protected open func RewriteAssignmentExpression(node BoundAssignmentExpression) BoundExpression {
        let expression = RewriteExpression(node.Expression)
        if expression == node.Expression {
            return node
        }
        return BoundAssignmentExpression(node.Syntax, node.Variable, expression)
    }

    /// Rewrites a unary expression.
    /// @param node The unary expression to rewrite.
    /// @returns The rewritten unary expression.
    protected open func RewriteUnaryExpression(node BoundUnaryExpression) BoundExpression {
        let operand = RewriteExpression(node.Operand)
        if operand == node.Operand {
            return node
        }
        // ADR-0186 §4: `IsChecked` and `PlatformCheckMessage` are both

        // carried through. Dropping the message would not break anything the

        // compiler can observe — the check still emits — which is exactly why

        // it is easy to lose: the only symptom is an unattributed

        // `NullReferenceException` inside an async body, an iterator or a

        // lambda, i.e. precisely the frames where attribution matters most.

        return BoundUnaryExpression(node.Syntax, node.Op, operand, node.IsChecked, node.PlatformCheckMessage)
    }

    /// Rewrites a binary expression.
    /// @param node The binary expression to rewrite.
    /// @returns The rewritten binary expression.
    protected open func RewriteBinaryExpression(node BoundBinaryExpression) BoundExpression {
        let left = RewriteExpression(node.Left)
        let right = RewriteExpression(node.Right)
        if left == node.Left && right == node.Right {
            return node
        }
        return BoundBinaryExpression(node.Syntax, left, node.Op, right, node.IsChecked)
    }

    private func CompleteSelectedCallCopy(original BoundExpression, copy BoundExpression) BoundExpression {
        original.CopyStaticQualifierTo(copy)
        original.CopyLogicalCompletionTo(copy)
        return copy
    }

    /// Rewrites a call expression.
    /// @param node The call expression to rewrite.
    /// @returns The rewritten call expression.
    protected open func RewriteCallExpression(node BoundCallExpression) BoundExpression {
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < node.Arguments.Length; i++ {
            let oldArgument = node.Arguments[i]
            let newArgument = RewriteExpression(oldArgument)
            if newArgument != oldArgument {
                if builder == nil {
                    builder = ImmutableArray.CreateBuilder[BoundExpression](node.Arguments.Length)
                    for var j = 0; j < i; j++ {
                        builder.Add(node.Arguments[j])
                    }
                }
            }
            if builder != nil {
                builder.Add(newArgument)
            }
        }
        if builder == nil {
            return node
        }
        // Issue #1644: preserve the set-after-construction generic-owner properties

        // (#1209 / #1433) so the emitter still parents the call at the construction's

        // TypeSpec instead of a bare open-generic MethodDef.

        return CompleteSelectedCallCopy(
            node,
            BoundCallExpression(
                node.Syntax,
                node.Function,
                builder.MoveToImmutable(),
                node.ReturnType,
                node.IsConditionalElided
            ){
                StaticGenericOwnerType = node.StaticGenericOwnerType,
                StaticGenericInterfaceOwnerType = node.StaticGenericInterfaceOwnerType,
                MethodTypeArguments = node.MethodTypeArguments
            }
        )
    }

    /// ADR-0122 §9 / issue #1035: rewrites a function-pointer `calli`
    /// invocation by rewriting the pointer expression and each argument.
    /// @param node The invocation to rewrite.
    /// @returns The rewritten expression.
    protected open func RewriteFunctionPointerInvocationExpression(
        node BoundFunctionPointerInvocationExpression
    ) BoundExpression {
        let newPointer = RewriteExpression(node.Pointer)
        let builder = ImmutableArray.CreateBuilder[BoundExpression](node.Arguments.Length)
        var changed = newPointer != node.Pointer
        for var i = 0; i < node.Arguments.Length; i++ {
            let oldArgument = node.Arguments[i]
            let newArgument = RewriteExpression(oldArgument)
            changed |= newArgument != oldArgument
            builder.Add(newArgument)
        }
        if !changed {
            return node
        }
        return BoundFunctionPointerInvocationExpression(
            node.Syntax,
            newPointer,
            builder.MoveToImmutable(),
            node.FunctionPointerType
        )
    }

    /// ADR-0089 / issue #755: rewrites a constrained static-virtual call
    /// expression by rewriting each argument; the receiver type-parameter
    /// and target slot are immutable.
    /// @param node The call to rewrite.
    /// @returns The rewritten expression.
    protected open func RewriteConstrainedStaticCallExpression(
        node BoundConstrainedStaticCallExpression
    ) BoundExpression {
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < node.Arguments.Length; i++ {
            let oldArgument = node.Arguments[i]
            let newArgument = RewriteExpression(oldArgument)
            if newArgument != oldArgument {
                if builder == nil {
                    builder = ImmutableArray.CreateBuilder[BoundExpression](node.Arguments.Length)
                    for var j = 0; j < i; j++ {
                        builder.Add(node.Arguments[j])
                    }
                }
            }
            if builder != nil {
                builder.Add(newArgument)
            }
        }
        if builder == nil {
            return node
        }
        // Issue #3525: the imported-CLR-interface shape carries a MethodInfo

        // (ClrMethod) instead of a FunctionSymbol (InterfaceMethod).

        let copy = if node.InterfaceMethod != nil {
            BoundConstrainedStaticCallExpression(
                node.Syntax,
                node.TypeParameter,
                node.InterfaceMethod,
                builder.MoveToImmutable(),
                node.ReturnType
            )
        } else {
            BoundConstrainedStaticCallExpression(
                node.Syntax,
                node.TypeParameter,
                node.ClrMethod!!,
                builder.MoveToImmutable(),
                node.ArgumentRefKinds,
                node.ReturnType,
                node.ConstrainedInterfaceType!!,
                node.TypeArgumentSymbols
            )
        }
        return CompleteSelectedCallCopy(node, copy)
    }

    /// Rewrites a conversion expression.
    /// @param node The conversion expression to rewrite.
    /// @returns The rewritten conversion expression.
    protected open func RewriteConversionExpression(node BoundConversionExpression) BoundExpression {
        let expression = RewriteExpression(node.Expression)
        if expression == node.Expression {
            return node
        }
        let copy = BoundConversionExpression(node.Syntax, node.Type, expression, node.IsChecked)
        node.CopyImplicitConversionTo(copy)
        return copy
    }

    /// Rewrites a bound await expression (Phase 5.1).
    /// @param node The await expression to rewrite.
    /// @returns The rewritten await expression.
    protected open func RewriteAwaitExpression(node BoundAwaitExpression) BoundExpression {
        let expression = RewriteExpression(node.Expression)
        if expression == node.Expression {
            return node
        }
        let copy = BoundAwaitExpression(node.Syntax, expression, node.Type, node.AwaiterTypeSymbol)
        node.CopyImplicitCompletionTo(copy)
        return copy
    }

    /// Rewrites a bound switch expression.
    /// @param node The switch expression to rewrite.
    /// @returns The rewritten switch expression.
    protected open func RewriteSwitchExpression(node BoundSwitchExpression) BoundExpression {
        let discriminant = RewriteExpression(node.Discriminant)
        var builder ImmutableArray[BoundSwitchExpressionArm].Builder? = nil
        for var i = 0; i < node.Arms.Length; i++ {
            let arm = node.Arms[i]
            let pattern = if arm.Pattern == nil {
                default(BoundPattern?)
            } else {
                RewritePattern(arm.Pattern)
            }
            let guard_ = if arm.Guard == nil {
                default(BoundExpression?)
            } else {
                RewriteExpression(arm.Guard)
            }
            let result = RewriteExpression(arm.Result)
            if builder == nil && (pattern != arm.Pattern || guard_ != arm.Guard || result != arm.Result) {
                builder = ImmutableArray.CreateBuilder[BoundSwitchExpressionArm](node.Arms.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(node.Arms[j])
                }
            }
            builder?.Add(BoundSwitchExpressionArm(arm.Syntax, pattern, guard_, result))
        }
        if discriminant == node.Discriminant && builder == nil {
            return node
        }
        return BoundSwitchExpression(node.Syntax, discriminant, builder?.MoveToImmutable() ?? node.Arms, node.Type)
    }

    /// Rewrites a bound pattern switch statement.
    /// @param node The pattern switch statement.
    /// @returns The rewritten statement.
    protected open func RewritePatternSwitchStatement(node BoundPatternSwitchStatement) BoundStatement {
        let discriminant = RewriteExpression(node.Discriminant)
        var builder ImmutableArray[BoundPatternSwitchArm].Builder? = nil
        for var i = 0; i < node.Arms.Length; i++ {
            let arm = node.Arms[i]
            let pattern = if arm.Pattern == nil {
                default(BoundPattern?)
            } else {
                RewritePattern(arm.Pattern)
            }
            let guard_ = if arm.Guard == nil {
                default(BoundExpression?)
            } else {
                RewriteExpression(arm.Guard)
            }
            let body = RewriteStatement(arm.Body)
            if builder == nil && (pattern != arm.Pattern || guard_ != arm.Guard || body != arm.Body) {
                builder = ImmutableArray.CreateBuilder[BoundPatternSwitchArm](node.Arms.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(node.Arms[j])
                }
            }
            builder?.Add(BoundPatternSwitchArm(arm.Syntax, pattern, guard_, body))
        }
        if discriminant == node.Discriminant && builder == nil {
            return node
        }
        return BoundPatternSwitchStatement(
            node.Syntax,
            discriminant,
            builder?.MoveToImmutable() ?? node.Arms,
            node.IsExhaustive
        )
    }

    /// Rewrites a bound pattern.
    /// @param node The pattern.
    /// @returns The rewritten pattern.
    protected open func RewritePattern(node BoundPattern) BoundPattern {
        switch node.Kind {
            case BoundNodeKind.ConstantPattern {
                let constant = cast[BoundConstantPattern](node)
                let value = RewriteExpression(constant.Value)
                return if value == constant.Value {
                    node
                } else {
                    cast[BoundPattern](BoundConstantPattern(node.Syntax, node.Type, value))
                }
            }
            case BoundNodeKind.DiscardPattern {
                return node
            }
            case BoundNodeKind.TypePattern {
                let type = cast[BoundTypePattern](node)
                let typeProperty = if type.PropertyPattern == nil {
                    default(BoundPropertyPattern?)
                } else {
                    cast[BoundPropertyPattern](RewritePattern(type.PropertyPattern))
                }
                return if typeProperty == type.PropertyPattern {
                    node
                } else {
                    cast[BoundPattern](
                        BoundTypePattern(nil, node.Type, type.TargetType, type.Variable, type.HasBinding, typeProperty)
                    )
                }
            }
            case BoundNodeKind.RelationalPattern {
                let relational = cast[BoundRelationalPattern](node)
                let relValue = RewriteExpression(relational.Value)
                return if relValue == relational.Value {
                    node
                } else {
                    cast[BoundPattern](BoundRelationalPattern(node.Syntax, node.Type, relational.Op, relValue))
                }
            }
            case BoundNodeKind.PropertyPattern {
                let property = cast[BoundPropertyPattern](node)
                var fieldsBuilder ImmutableArray[BoundPropertyPatternField].Builder? = nil
                for var i = 0; i < property.Fields.Length; i++ {
                    let field = property.Fields[i]
                    let pattern = RewritePattern(field.Pattern)
                    if fieldsBuilder == nil && pattern != field.Pattern {
                        fieldsBuilder = ImmutableArray.CreateBuilder[BoundPropertyPatternField](property.Fields.Length)
                        for var j = 0; j < i; j++ {
                            fieldsBuilder.Add(property.Fields[j])
                        }
                    }
                    fieldsBuilder?.Add(
                        if field.ClrMember != nil {
                            BoundPropertyPatternField(field.Syntax, field.ClrMember, field.Type, pattern)
                        } else {
                            (
                                if field.Property != nil {
                                    BoundPropertyPatternField(
                                        field.Syntax,
                                        field.Property,
                                        field.DeclaringType,
                                        pattern
                                    )
                                } else {
                                    BoundPropertyPatternField(
                                        field.Syntax,
                                        Invariant.Required(
                                            field.Field,
                                            "a property pattern field has one bound member",
                                            expression: "field.Field"
                                        ),
                                        field.DeclaringType,
                                        pattern
                                    )
                                }
                            )
                        }
                    )
                }
                return if fieldsBuilder == nil {
                    node
                } else {
                    cast[BoundPattern](BoundPropertyPattern(node.Syntax, node.Type, fieldsBuilder.MoveToImmutable()))
                }
            }
            case BoundNodeKind.ListPattern {
                let list = cast[BoundListPattern](node)
                var elementsBuilder ImmutableArray[BoundPattern].Builder? = nil
                for var i = 0; i < list.Elements.Length; i++ {
                    let element = RewritePattern(list.Elements[i])
                    if (elementsBuilder == nil && element != list.Elements[i]) {
                        elementsBuilder = ImmutableArray.CreateBuilder[BoundPattern](list.Elements.Length)
                        for var j = 0; j < i; j++ {
                            elementsBuilder.Add(list.Elements[j])
                        }
                    }
                    elementsBuilder?.Add(element)
                }
                return if elementsBuilder == nil {
                    node
                } else {
                    cast[BoundPattern](
                        BoundListPattern(
                            node.Syntax,
                            node.Type,
                            elementsBuilder.MoveToImmutable(),
                            list.ElementType,
                            list.LengthProperty,
                            list.IndexerProperty,
                            list.InputVariable
                        )
                    )
                }
            }
            case BoundNodeKind.SlicePattern {
                let slice = cast[BoundSlicePattern](node)
                let newSliceInner = if slice.Pattern == nil {
                    default(BoundPattern?)
                } else {
                    RewritePattern(slice.Pattern)
                }
                return if newSliceInner == slice.Pattern {
                    node
                } else {
                    cast[BoundPattern](
                        BoundSlicePattern(
                            node.Syntax,
                            node.Type,
                            slice.ElementType,
                            slice.Variable,
                            Invariant.Required(
                                newSliceInner,
                                "a rewritten slice pattern retains its nested pattern",
                                expression: "newSliceInner"
                            )
                        )
                    )
                }
            }
            case BoundNodeKind.BinaryPattern {
                let binary = cast[BoundBinaryPattern](node)
                let newLeft = RewritePattern(binary.Left)
                let newRight = RewritePattern(binary.Right)
                return if newLeft == binary.Left && newRight == binary.Right {
                    node
                } else {
                    cast[BoundPattern](
                        BoundBinaryPattern(
                            nil,
                            node.Type,
                            binary.IsConjunction,
                            newLeft,
                            newRight,
                            binary.RightInputVariable
                        )
                    )
                }
            }
            case BoundNodeKind.NotPattern {
                let not = cast[BoundNotPattern](node)
                let newInner = RewritePattern(not.Pattern)
                return if newInner == not.Pattern {
                    node
                } else {
                    cast[BoundPattern](BoundNotPattern(node.Syntax, node.Type, newInner))
                }
            }
            default {
                throw Exception("Unexpected pattern node: ${node.Kind}")
            }
        }
    }

    /// Rewrites a bound go statement (Phase 5.3).
    /// @param node The go statement to rewrite.
    /// @returns The rewritten go statement.
    protected open func RewriteGoStatement(node BoundGoStatement) BoundStatement {
        let expression = RewriteExpression(node.Expression)
        let sink = if node.Sink == nil {
            default(BoundExpression?)
        } else {
            RewriteExpression(node.Sink)
        }
        let resultCell = if node.ResultCell == nil {
            default(BoundExpression?)
        } else {
            RewriteExpression(node.ResultCell)
        }
        if expression == node.Expression && sink == node.Sink && resultCell == node.ResultCell {
            return node
        }
        // The go statement's syntax is its stable identity: the emitter finds

        // the closure synthesized for it by that syntax when a state-machine

        // rewrite has rebuilt the node (ADR-0174 D4 makes that the common case).

        return BoundGoStatement(node.Syntax, expression, sink, resultCell, node.ResultType, node.LexicalEnclosingType)
    }

    /// ADR-0125 / issue #1026: rewrites a `fixed` statement, rewriting its
    /// pinned-source expression and body while preserving the pinned/pointer
    /// locals and pin kind.
    /// @param node The fixed statement to rewrite.
    /// @returns The rewritten statement.
    protected open func RewriteFixedStatement(node BoundFixedStatement) BoundStatement {
        let source = RewriteExpression(node.PinnedSource)
        let body = RewriteStatement(node.Body)
        if source == node.PinnedSource && body == node.Body {
            return node
        }
        return BoundFixedStatement(
            node.Syntax,
            node.PinKind,
            node.PinnedVariable,
            node.PointerVariable,
            source,
            body,
            node.SourceVariable
        )
    }

    /// Rewrites a bound `await for v := range stream` statement (Phase 5.8).
    /// @param node The await-for-range statement to rewrite.
    /// @returns The rewritten await-for-range statement.
    protected open func RewriteAwaitForRangeStatement(node BoundAwaitForRangeStatement) BoundStatement {
        let stream = RewriteExpression(node.Stream)
        let body = RewriteStatement(node.Body)
        if stream == node.Stream && body == node.Body {
            return node
        }
        return BoundAwaitForRangeStatement(
            node.Syntax,
            node.ValueVariable,
            stream,
            body,
            node.BreakLabel,
            node.ContinueLabel
        )
    }

    /// Rewrites a bound yield statement (ADR-0040).
    /// @param node The yield statement to rewrite.
    /// @returns The rewritten yield statement.
    protected open func RewriteYieldStatement(node BoundYieldStatement) BoundStatement {
        let expression = RewriteExpression(node.Expression)
        if expression == node.Expression {
            return node
        }
        return BoundYieldStatement(node.Syntax, expression)
    }

    /// Rewrites an address-of expression.
    /// @param node The address-of expression to rewrite.
    /// @returns The rewritten expression.
    protected open func RewriteManagedReferenceExpression(node BoundManagedReferenceExpression) BoundExpression {
        let location = RewriteExpression(node.Location)
        return if location == node.Location {
            node
        } else {
            BoundManagedReferenceExpression(node.Syntax, location, node.Type, node.IsReadOnly, node.RetainForCapture)
        }
    }

    /// Rewrites a borrowed address without changing its permissions.
    /// @param node The borrowed address.
    /// @returns The rewritten address.
    protected open func RewriteAddressOfExpression(node BoundAddressOfExpression) BoundExpression {
        let operand = RewriteExpression(node.Operand)
        if operand == node.Operand {
            return node
        }
        return BoundAddressOfExpression(node.Syntax, operand, node.IsUnmanaged, node.IsReadOnly)
    }

    /// ADR-0061: Rewrites a conditional address-of expression.
    /// @param node The conditional address-of expression to rewrite.
    /// @returns The rewritten expression.
    protected open func RewriteConditionalAddressExpression(node BoundConditionalAddressExpression) BoundExpression {
        let condition = RewriteExpression(node.Condition)
        let whenTrue = RewriteExpression(node.WhenTrueOperand)
        let whenFalse = RewriteExpression(node.WhenFalseOperand)
        if condition == node.Condition && whenTrue == node.WhenTrueOperand && whenFalse == node.WhenFalseOperand {
            return node
        }
        return BoundConditionalAddressExpression(node.Syntax, condition, whenTrue, whenFalse, node.PointeeType)
    }

    /// ADR-0062: Rewrites a general two-arm conditional (ternary) expression.
    /// @param node The conditional expression to rewrite.
    /// @returns The rewritten expression.
    protected open func RewriteConditionalExpression(node BoundConditionalExpression) BoundExpression {
        let condition = RewriteExpression(node.Condition)
        let whenTrue = RewriteExpression(node.WhenTrue)
        let whenFalse = RewriteExpression(node.WhenFalse)
        if condition == node.Condition && whenTrue == node.WhenTrue && whenFalse == node.WhenFalse {
            return node
        }
        return BoundConditionalExpression(node.Syntax, condition, whenTrue, whenFalse, node.Type)
    }

    /// Issue #1018: rewrites a throw-expression's operand.
    /// @param node The throw-expression to rewrite.
    /// @returns The rewritten throw-expression, or [`node`](paramref) if unchanged.
    protected open func RewriteThrowExpression(node BoundThrowExpression) BoundExpression {
        let expression = RewriteExpression(node.Expression)
        if expression == node.Expression {
            return node
        }
        return BoundThrowExpression(node.Syntax, expression)
    }

    /// Rewrites a dereference expression.
    /// @param node The dereference expression to rewrite.
    /// @returns The rewritten expression.
    protected open func RewriteDereferenceExpression(node BoundDereferenceExpression) BoundExpression {
        let operand = RewriteExpression(node.Operand)
        if operand == node.Operand {
            return node
        }
        return BoundDereferenceExpression(node.Syntax, operand)
    }

    /// Rewrites an indirect assignment expression (ADR-0060 §13: `*p = expr`).
    /// @param node The indirect assignment expression to rewrite.
    /// @returns The rewritten expression.
    protected open func RewriteIndirectAssignmentExpression(node BoundIndirectAssignmentExpression) BoundExpression {
        let pointer = RewriteExpression(node.Pointer)
        let value = RewriteExpression(node.Value)
        if pointer == node.Pointer && value == node.Value {
            return node
        }
        return BoundIndirectAssignmentExpression(node.Syntax, pointer, value)
    }

    /// Rewrites a state-machine await-on-completed marker. This is a leaf node
    /// with no rewritable children; default behavior returns the node unchanged.
    /// @param node The state-machine await-on-completed node.
    /// @returns The node, unchanged.
    protected open func RewriteStateMachineAwaitOnCompleted(node BoundStateMachineAwaitOnCompleted) BoundExpression {
        return node
    }

    /// Rewrites a spill-sequence expression.
    /// @param node The spill-sequence expression to rewrite.
    /// @returns The rewritten expression.
    protected open func RewriteSpillSequenceExpression(node BoundSpillSequenceExpression) BoundExpression {
        let builder = ImmutableArray.CreateBuilder[BoundStatement](node.SideEffects.Length)
        var changed = false
        for stmt in node.SideEffects {
            let rewritten = RewriteStatement(stmt)
            builder.Add(rewritten)
            if rewritten != stmt {
                changed = true
            }
        }
        let value = RewriteExpression(node.Value)
        if !changed && value == node.Value {
            return node
        }
        return BoundSpillSequenceExpression(node.Syntax, node.Locals, builder.MoveToImmutable(), value)
    }

    /// Rewrites an imported call expression.
    /// @param node The imported call expression to rewrite.
    /// @returns The rewritten imported call expression.
    protected open func RewriteImportedCallExpression(node BoundImportedCallExpression) BoundExpression {
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < node.Arguments.Length; i++ {
            let oldArgument = node.Arguments[i]
            let newArgument = RewriteExpression(oldArgument)
            if newArgument != oldArgument {
                if builder == nil {
                    builder = ImmutableArray.CreateBuilder[BoundExpression](node.Arguments.Length)
                    for var j = 0; j < i; j++ {
                        builder.Add(node.Arguments[j])
                    }
                }
            }
            if builder != nil {
                builder.Add(newArgument)
            }
        }
        if builder == nil {
            return node
        }
        return CompleteSelectedCallCopy(
            node,
            BoundImportedCallExpression(
                node.Syntax,
                node.Function,
                builder.MoveToImmutable(),
                node.ArgumentRefKinds,
                node.TypeArgumentSymbols,
                node.StaticContainerType
            )
        )
    }

    /// Rewrites an imported instance call expression.
    /// @param node The imported instance call expression to rewrite.
    /// @returns The rewritten expression.
    protected open func RewriteImportedInstanceCallExpression(
        node BoundImportedInstanceCallExpression
    ) BoundExpression {
        let newReceiver = RewriteExpression(node.Receiver)
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < node.Arguments.Length; i++ {
            let oldArgument = node.Arguments[i]
            let newArgument = RewriteExpression(oldArgument)
            if newArgument != oldArgument {
                if builder == nil {
                    builder = ImmutableArray.CreateBuilder[BoundExpression](node.Arguments.Length)
                    for var j = 0; j < i; j++ {
                        builder.Add(node.Arguments[j])
                    }
                }
            }
            if builder != nil {
                builder.Add(newArgument)
            }
        }
        let args = builder?.MoveToImmutable() ?? node.Arguments
        if newReceiver == node.Receiver && builder == nil {
            return node
        }
        return BoundImportedInstanceCallExpression(
            node.Syntax,
            newReceiver,
            node.Method,
            node.Type,
            args,
            node.ArgumentRefKinds,
            node.TypeArgumentSymbols,
            node.ConstrainedReceiverTypeParameter,
            node.ConstrainedInterfaceType,
            node.IsNonVirtualBaseCall
        )
    }

    /// Rewrites an array creation expression.
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteArrayCreationExpression(node BoundArrayCreationExpression) BoundExpression {
        if node.ContainerType is RectangularArrayTypeSymbol rectangular {
            var changed = false
            let dimensions = ImmutableArray.CreateBuilder[BoundExpression](node.DimensionExpressions.Length)
            for dimension in node.DimensionExpressions {
                let rewritten = RewriteExpression(dimension)
                changed |= rewritten != dimension
                dimensions.Add(rewritten)
            }
            let elements = ImmutableArray.CreateBuilder[BoundExpression](node.Elements.Length)
            for element in node.Elements {
                let rewritten = RewriteExpression(element)
                changed |= rewritten != element
                elements.Add(rewritten)
            }
            return if changed {
                BoundArrayCreationExpression.CreateRectangular(
                    node.Syntax,
                    rectangular,
                    dimensions.MoveToImmutable(),
                    elements.MoveToImmutable(),
                    node.RectangularLengths
                )
            } else {
                node
            }
        }
        // Issue #1016: runtime-length form has no element initialisers; rewrite

        // the length expression instead.

        if node.LengthExpression != nil {
            let newLength = RewriteExpression(node.LengthExpression)
            return if newLength == node.LengthExpression {
                node
            } else {
                BoundArrayCreationExpression(node.Syntax, node.ContainerType, newLength)
            }
        }
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < node.Elements.Length; i++ {
            let oldEl = node.Elements[i]
            let newEl = RewriteExpression(oldEl)
            if newEl != oldEl && builder == nil {
                builder = ImmutableArray.CreateBuilder[BoundExpression](node.Elements.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(node.Elements[j])
                }
            }
            builder?.Add(newEl)
        }
        return if builder == nil {
            node
        } else {
            BoundArrayCreationExpression(node.Syntax, node.ContainerType, builder.MoveToImmutable())
        }
    }

    /// ADR-0124 / issues #1024, #1041: rewrites a (cref:BoundStackAllocExpression)
    /// by rewriting its element-count subexpression and any initializer elements.
    /// @param node The stackalloc node to rewrite.
    /// @returns The rewritten node, or the original when unchanged.
    protected open func RewriteStackAllocExpression(node BoundStackAllocExpression) BoundExpression {
        let newCount = RewriteExpression(node.Count)
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < node.InitializerElements.Length; i++ {
            let oldElement = node.InitializerElements[i]
            let newElement = RewriteExpression(oldElement)
            if newElement != oldElement && builder == nil {
                builder = ImmutableArray.CreateBuilder[BoundExpression](node.InitializerElements.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(node.InitializerElements[j])
                }
            }
            builder?.Add(newElement)
        }
        let newElements = if builder == nil {
            node.InitializerElements
        } else {
            ImmutableArray.CreateRange[BoundExpression](builder)
        }
        if newCount == node.Count && builder == nil {
            return node
        }
        return BoundStackAllocExpression(
            node.Syntax,
            node.ResultType,
            node.ElementType,
            newCount,
            node.IsPointerForm,
            newElements
        )
    }

    /// Rewrites a map literal expression.
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteMapLiteralExpression(node BoundMapLiteralExpression) BoundExpression {
        var builder ImmutableArray[BoundMapEntry].Builder? = nil
        for var i = 0; i < node.Entries.Length; i++ {
            let oldEntry = node.Entries[i]
            let newKey = RewriteExpression(oldEntry.Key)
            let newValue = RewriteExpression(oldEntry.Value)
            if (newKey != oldEntry.Key || newValue != oldEntry.Value) && builder == nil {
                builder = ImmutableArray.CreateBuilder[BoundMapEntry](node.Entries.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(node.Entries[j])
                }
            }
            builder?.Add(
                if newKey == oldEntry.Key && newValue == oldEntry.Value {
                    oldEntry
                } else {
                    BoundMapEntry(newKey, newValue)
                }
            )
        }
        return if builder == nil {
            node
        } else {
            BoundMapLiteralExpression(node.Syntax, node.MapType, builder.MoveToImmutable())
        }
    }

    /// Rewrites an index expression.
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteIndexExpression(node BoundIndexExpression) BoundExpression {
        let target = RewriteExpression(node.Target)
        let indices = ImmutableArray.CreateBuilder[BoundExpression](node.Indices.Length)
        var changed = target != node.Target
        for index in node.Indices {
            let rewritten = RewriteExpression(index)
            indices.Add(rewritten)
            changed |= rewritten != index
        }
        if !changed {
            return node
        }
        return BoundIndexExpression(node.Syntax, target, indices.MoveToImmutable(), node.Type)
    }

    /// Rewrites an index assignment expression.
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteIndexAssignmentExpression(node BoundIndexAssignmentExpression) BoundExpression {
        let targetExpr BoundExpression? = if node.TargetExpression != nil {
            RewriteExpression(node.TargetExpression)
        } else {
            default(BoundExpression?)
        }
        let indices = ImmutableArray.CreateBuilder[BoundExpression](node.Indices.Length)
        var changed = targetExpr != node.TargetExpression
        for index in node.Indices {
            let rewritten = RewriteExpression(index)
            indices.Add(rewritten)
            changed |= rewritten != index
        }
        let value = RewriteExpression(node.Value)
        changed |= value != node.Value
        if !changed {
            return node
        }
        let rewrittenIndices = indices.MoveToImmutable()
        if targetExpr != nil {
            return BoundIndexAssignmentExpression.WithExpressionTarget(
                node.Syntax,
                targetExpr,
                rewrittenIndices,
                value,
                node.Type
            )
        }
        return BoundIndexAssignmentExpression(
            node.Syntax,
            Invariant.Required(
                node.Target,
                "an index assignment without an expression target has a variable target",
                expression: "node.Target"
            ),
            rewrittenIndices,
            value,
            node.Type
        )
    }

    /// Rewrites a `len(x)` expression.
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteLenExpression(node BoundLenExpression) BoundExpression {
        let operand = RewriteExpression(node.Operand)
        return if operand == node.Operand {
            node
        } else {
            BoundLenExpression(node.Syntax, operand)
        }
    }

    /// Rewrites a struct composite literal.
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteStructLiteralExpression(node BoundStructLiteralExpression) BoundExpression {
        let copySource = if node.CopySource == nil {
            default(BoundExpression?)
        } else {
            RewriteExpression(node.CopySource)
        }
        var builder ImmutableArray[BoundFieldInitializer].Builder? = nil
        for var i = 0; i < node.Initializers.Length; i++ {
            let init = node.Initializers[i]
            // Discard constructor-owned copies before a rewrite can extract

            // their evaluation into side effects outside the constructor.

            let constructorOwnsValue = init.IsDeclarationInitializer &&
                node
                .StructType
                .NeedsSynthesizedValueStructDefaultCtor
            let newValue = if constructorOwnsValue {
                init.Value
            } else {
                RewriteExpression(init.Value)
            }
            if (constructorOwnsValue || newValue != init.Value) && builder == nil {
                builder = ImmutableArray.CreateBuilder[BoundFieldInitializer](node.Initializers.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(node.Initializers[j])
                }
            }
            if builder != nil && !constructorOwnsValue {
                builder.Add(
                    if newValue == init.Value {
                        init
                    } else {
                        init with{Value = newValue}
                    }
                )
            }
        }
        return if builder == nil && copySource == node.CopySource {
            node
        } else {
            BoundStructLiteralExpression(
                node.Syntax,
                node.StructType,
                builder?.ToImmutable() ?? node.Initializers,
                copySource,
                node.IsZeroInitialization
            )
        }
    }

    /// Rewrites a block expression.
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteBlockExpression(node BoundBlockExpression) BoundExpression {
        var statementBuilder ImmutableArray[BoundStatement].Builder? = nil
        for var i = 0; i < node.Statements.Length; i++ {
            let oldStatement = node.Statements[i]
            let newStatement = RewriteStatement(oldStatement)
            if newStatement != oldStatement && statementBuilder == nil {
                statementBuilder = ImmutableArray.CreateBuilder[BoundStatement](node.Statements.Length)
                for var j = 0; j < i; j++ {
                    statementBuilder.Add(node.Statements[j])
                }
            }
            if statementBuilder != nil {
                statementBuilder.Add(newStatement)
            }
        }
        let expression = RewriteExpression(node.Expression)
        if statementBuilder == nil && expression == node.Expression {
            return node
        }
        return BoundBlockExpression(node.Syntax, statementBuilder?.ToImmutable() ?? node.Statements, expression)
    }

    /// Rewrites a class primary-constructor call.
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteConstructorCallExpression(node BoundConstructorCallExpression) BoundExpression {
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < node.Arguments.Length; i++ {
            let oldArg = node.Arguments[i]
            let newArg = RewriteExpression(oldArg)
            if newArg != oldArg && builder == nil {
                builder = ImmutableArray.CreateBuilder[BoundExpression](node.Arguments.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(node.Arguments[j])
                }
            }
            if builder != nil {
                builder.Add(newArg)
            }
        }
        return if builder == nil {
            node
        } else {
            BoundConstructorCallExpression(
                node.Syntax,
                node.StructType,
                builder.ToImmutable(),
                node.SelectedConstructor
            )
        }
    }

    /// ADR-0065 §2: rewrites a constructor self-delegation expression.
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteConstructorChainingExpression(node BoundConstructorChainingExpression) BoundExpression {
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < node.Arguments.Length; i++ {
            let oldArg = node.Arguments[i]
            let newArg = RewriteExpression(oldArg)
            if newArg != oldArg && builder == nil {
                builder = ImmutableArray.CreateBuilder[BoundExpression](node.Arguments.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(node.Arguments[j])
                }
            }
            if builder != nil {
                builder.Add(newArg)
            }
        }
        return if builder == nil {
            node
        } else {
            BoundConstructorChainingExpression(node.Syntax, node.SelectedConstructor, builder.ToImmutable())
        }
    }

    /// Rewrites a CLR constructor call (Phase 4 exit).
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteClrConstructorCallExpression(node BoundClrConstructorCallExpression) BoundExpression {
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < node.Arguments.Length; i++ {
            let oldArg = node.Arguments[i]
            let newArg = RewriteExpression(oldArg)
            if newArg != oldArg && builder == nil {
                builder = ImmutableArray.CreateBuilder[BoundExpression](node.Arguments.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(node.Arguments[j])
                }
            }
            if builder != nil {
                builder.Add(newArg)
            }
        }
        return if builder == nil {
            node
        } else {
            BoundClrConstructorCallExpression(
                node.Syntax,
                node.ClrType,
                node.Constructor,
                builder.ToImmutable(),
                node.Type
            )
        }
    }

    /// Rewrites a CLR static method call expression.
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteClrStaticCallExpression(node BoundClrStaticCallExpression) BoundExpression {
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < node.Arguments.Length; i++ {
            let oldArg = node.Arguments[i]
            let newArg = RewriteExpression(oldArg)
            if newArg != oldArg && builder == nil {
                builder = ImmutableArray.CreateBuilder[BoundExpression](node.Arguments.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(node.Arguments[j])
                }
            }
            if builder != nil {
                builder.Add(newArg)
            }
        }
        return if builder == nil {
            node
        } else {
            node.WithArguments(builder.ToImmutable())
        }
    }

    /// Rewrites a CLR property/field access on a CLR receiver.
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteClrPropertyAccessExpression(node BoundClrPropertyAccessExpression) BoundExpression {
        if node.Receiver == nil {
            return node
        }
        let receiver = RewriteExpression(node.Receiver)
        return if receiver == node.Receiver {
            node
        } else {
            BoundClrPropertyAccessExpression(
                node.Syntax,
                receiver,
                node.Member,
                node.Type,
                node.StaticContainerType,
                node.ConstrainedReceiverTypeParameter,
                node.ConstrainedInterfaceType
            )
        }
    }

    /// Rewrites a CLR property/field write (static or instance).
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteClrPropertyAssignmentExpression(
        node BoundClrPropertyAssignmentExpression
    ) BoundExpression {
        let receiver = if node.Receiver == nil {
            default(BoundExpression?)
        } else {
            RewriteExpression(node.Receiver)
        }
        let value = RewriteExpression(node.Value)
        if receiver == node.Receiver && value == node.Value {
            return node
        }
        return BoundClrPropertyAssignmentExpression(
            nil,
            receiver,
            node.Member,
            value,
            node.Type,
            node.StaticContainerType,
            node.ConstrainedReceiverTypeParameter,
            node.ConstrainedInterfaceType
        )
    }

    /// Rewrites a CLR event subscription (Stream B′).
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteClrEventSubscriptionExpression(
        node BoundClrEventSubscriptionExpression
    ) BoundExpression {
        let receiver = if node.Receiver == nil {
            default(BoundExpression?)
        } else {
            RewriteExpression(node.Receiver)
        }
        let handler = RewriteExpression(node.Handler)
        if receiver == node.Receiver && handler == node.Handler {
            return node
        }
        return BoundClrEventSubscriptionExpression(
            nil,
            receiver,
            node.Event,
            handler,
            node.IsAdd,
            node.ConstrainedReceiverTypeParameter,
            node.ConstrainedInterfaceType,
            node.EventContainingType
        ){IsNonVirtualBaseCall = node.IsNonVirtualBaseCall}
    }

    /// Rewrites a user-defined event subscription expression (ADR-0052).
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteEventSubscriptionExpression(node BoundEventSubscriptionExpression) BoundExpression {
        let receiver = if node.Receiver == nil {
            default(BoundExpression?)
        } else {
            RewriteExpression(node.Receiver)
        }
        let handler = RewriteExpression(node.Handler)
        if receiver == node.Receiver && handler == node.Handler {
            return node
        }
        return BoundEventSubscriptionExpression(
            node.Syntax,
            receiver,
            node.StructType,
            node.Event,
            handler,
            node.IsAdd,
            node.EventType
        ){IsNonVirtualBaseCall = node.IsNonVirtualBaseCall}
    }

    /// Rewrites a CLR binary operator call (Stream C).
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteClrBinaryOperatorExpression(node BoundClrBinaryOperatorExpression) BoundExpression {
        let left = RewriteExpression(node.Left)
        let right = RewriteExpression(node.Right)
        if left == node.Left && right == node.Right {
            return node
        }
        // Issue #2388: preserve whichever of Method (imported CLR type) /

        // Function (nullable-lifted same-compilation struct operator) the

        // original node carried — exactly one is non-null.

        return if node.Function != nil {
            BoundClrBinaryOperatorExpression(
                node.Syntax,
                node.OperatorKind,
                left,
                right,
                node.Function,
                node.FunctionOwnerType,
                node.Type
            )
        } else {
            BoundClrBinaryOperatorExpression(node.Syntax, node.OperatorKind, left, right, node.Method, node.Type)
        }
    }

    /// Rewrites a CLR unary operator call (Stream C).
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteClrUnaryOperatorExpression(node BoundClrUnaryOperatorExpression) BoundExpression {
        let operand = RewriteExpression(node.Operand)
        if operand == node.Operand {
            return node
        }
        return BoundClrUnaryOperatorExpression(node.Syntax, node.OperatorKind, operand, node.Method, node.Type)
    }

    /// Rewrites a CLR conversion call (Stream E).
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteClrConversionCallExpression(node BoundClrConversionCallExpression) BoundExpression {
        let source = RewriteExpression(node.Source)
        if source == node.Source {
            return node
        }
        return if node.Function != nil {
            BoundClrConversionCallExpression(nil, source, node.Function, node.FunctionOwnerType, node.Type)
        } else {
            BoundClrConversionCallExpression(
                nil,
                source,
                Invariant.Required(
                    node.Method,
                    "an imported conversion carries a CLR method",
                    expression: "node.Method"
                ),
                node.Type
            )
        }
    }

    /// Rewrites a CLR indexer read.
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteClrIndexExpression(node BoundClrIndexExpression) BoundExpression {
        let target = RewriteExpression(node.Target)
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < node.Arguments.Length; i++ {
            let oldArg = node.Arguments[i]
            let newArg = RewriteExpression(oldArg)
            if newArg != oldArg && builder == nil {
                builder = ImmutableArray.CreateBuilder[BoundExpression](node.Arguments.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(node.Arguments[j])
                }
            }
            if builder != nil {
                builder.Add(newArg)
            }
        }
        if target == node.Target && builder == nil {
            return node
        }
        let args = builder?.ToImmutable() ?? node.Arguments
        return BoundClrIndexExpression(
            nil,
            target,
            node.Indexer,
            args,
            node.Type,
            node.ConstrainedReceiverTypeParameter,
            node.ConstrainedInterfaceType
        )
    }

    /// Rewrites a CLR indexer write.
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteClrIndexAssignmentExpression(node BoundClrIndexAssignmentExpression) BoundExpression {
        let targetExpr BoundExpression? = if node.TargetExpression != nil {
            RewriteExpression(node.TargetExpression)
        } else {
            default(BoundExpression?)
        }
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < node.Arguments.Length; i++ {
            let oldArg = node.Arguments[i]
            let newArg = RewriteExpression(oldArg)
            if newArg != oldArg && builder == nil {
                builder = ImmutableArray.CreateBuilder[BoundExpression](node.Arguments.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(node.Arguments[j])
                }
            }
            if builder != nil {
                builder.Add(newArg)
            }
        }
        let value = RewriteExpression(node.Value)
        if targetExpr == node.TargetExpression && builder == nil && value == node.Value {
            return node
        }
        let args = builder?.ToImmutable() ?? node.Arguments
        if targetExpr != nil {
            return BoundClrIndexAssignmentExpression.WithExpressionTarget(
                nil,
                targetExpr,
                node.Indexer,
                args,
                value,
                node.Type,
                node.ConstrainedReceiverTypeParameter,
                node.ConstrainedInterfaceType
            )
        }
        return BoundClrIndexAssignmentExpression(
            nil,
            Invariant.Required(
                node.Target,
                "a CLR index assignment without an expression target has a variable target",
                expression: "node.Target"
            ),
            node.Indexer,
            args,
            value,
            node.Type,
            node.ConstrainedReceiverTypeParameter,
            node.ConstrainedInterfaceType
        )
    }

    /// Rewrites an instance-method call on a user-defined class.
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteUserInstanceCallExpression(node BoundUserInstanceCallExpression) BoundExpression {
        let receiver = RewriteExpression(node.Receiver)
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < node.Arguments.Length; i++ {
            let oldArg = node.Arguments[i]
            let newArg = RewriteExpression(oldArg)
            if newArg != oldArg && builder == nil {
                builder = ImmutableArray.CreateBuilder[BoundExpression](node.Arguments.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(node.Arguments[j])
                }
            }
            if builder != nil {
                builder.Add(newArg)
            }
        }
        if receiver == node.Receiver && builder == nil {
            return node
        }
        // Preserve every call-site property while replacing only receiver and

        // arguments. The return-type override carries async Task lifting (#502);

        // constrained metadata controls generic-interface dispatch (#1052); and

        // method type arguments are the authoritative bind-time substitution

        // when emit-time structural re-inference is impossible (#1931).

        return BoundUserInstanceCallExpression(
            node.Syntax,
            receiver,
            node.Method,
            builder?.ToImmutable() ?? node.Arguments,
            node.Type,
            node.ConstrainedReceiverTypeParameter,
            node.ConstrainedInterfaceType
        ){MethodTypeArguments = node.MethodTypeArguments}
    }

    /// Rewrites an explicit-base interface call (ADR-0091).
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteBaseInterfaceCallExpression(node BoundBaseInterfaceCallExpression) BoundExpression {
        let receiver = RewriteExpression(node.Receiver)
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < node.Arguments.Length; i++ {
            let oldArg = node.Arguments[i]
            let newArg = RewriteExpression(oldArg)
            if newArg != oldArg && builder == nil {
                builder = ImmutableArray.CreateBuilder[BoundExpression](node.Arguments.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(node.Arguments[j])
                }
            }
            if builder != nil {
                builder.Add(newArg)
            }
        }
        if receiver == node.Receiver && builder == nil {
            return node
        }
        return BoundBaseInterfaceCallExpression(
            node.Syntax,
            receiver,
            node.Interface,
            node.Method,
            builder?.ToImmutable() ?? node.Arguments
        )
    }

    /// Issue #986: rewrites a (cref:BoundBaseClassCallExpression).
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteBaseClassCallExpression(node BoundBaseClassCallExpression) BoundExpression {
        let receiver = RewriteExpression(node.Receiver)
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < node.Arguments.Length; i++ {
            let oldArg = node.Arguments[i]
            let newArg = RewriteExpression(oldArg)
            if newArg != oldArg && builder == nil {
                builder = ImmutableArray.CreateBuilder[BoundExpression](node.Arguments.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(node.Arguments[j])
                }
            }
            if builder != nil {
                builder.Add(newArg)
            }
        }
        if receiver == node.Receiver && builder == nil {
            return node
        }
        return BoundBaseClassCallExpression(
            node.Syntax,
            receiver,
            node.BaseClass,
            node.Method,
            builder?.ToImmutable() ?? node.Arguments,
            node.Type,
            node.Property,
            node.IsSetterAccessor
        ){MethodTypeArguments = node.MethodTypeArguments}
    }

    /// Rewrites a field read.
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteFieldAccessExpression(node BoundFieldAccessExpression) BoundExpression {
        // ADR-0053: static field access has no receiver (null). This also covers

        // the interface static-field read form (ADR-0089 / #1030, InterfaceType

        // != null), which likewise has a null Receiver — nothing to rewrite, so

        // returning the original node here can never drop InterfaceType (issue #1644).

        if node.Receiver == nil {
            return node
        }
        let receiver = RewriteExpression(node.Receiver)
        return if receiver == node.Receiver {
            node
        } else {
            BoundFieldAccessExpression(
                node.Syntax,
                receiver,
                Invariant.Required(
                    node.StructType,
                    "an instance field access has a struct type",
                    expression: "node.StructType"
                ),
                node.Field,
                node.SubstitutedType,
                node.NarrowedType
            )
        }
    }

    /// Rewrites a field assignment.
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteFieldAssignmentExpression(node BoundFieldAssignmentExpression) BoundExpression {
        let value = RewriteExpression(node.Value)
        if node.ReceiverExpression != nil {
            let receiverExpr = RewriteExpression(node.ReceiverExpression)
            if object.ReferenceEquals(value, node.Value) && object.ReferenceEquals(
                receiverExpr,
                node.ReceiverExpression
            ) {
                return node
            }
            return BoundFieldAssignmentExpression.WithExpressionReceiver(
                node.Syntax,
                receiverExpr,
                Invariant.Required(
                    node.StructType,
                    "an instance field assignment has a struct type",
                    expression: "node.StructType"
                ),
                node.Field,
                value,
                node.ResultType
            )
        }
        if value == node.Value {
            return node
        }
        // Issue #1644 / ADR-0089 #1030: an interface static field write is built

        // with (syntax, field, interfaceType, value) — Receiver/StructType are

        // both null and InterfaceType carries the owning (possibly constructed)

        // interface. Reconstruct via that constructor instead of the

        // variable-receiver one, or the emitter/interpreter lose the interface

        // static routing and mis-codegen/crash.

        return if node.InterfaceType != nil {
            BoundFieldAssignmentExpression(nil, node.Field, node.InterfaceType, value, node.ResultType)
        } else {
            BoundFieldAssignmentExpression(
                node.Syntax,
                node.Receiver,
                Invariant.Required(
                    node.StructType,
                    "a variable field assignment has a struct type",
                    expression: "node.StructType"
                ),
                node.Field,
                value,
                node.ResultType
            )
        }
    }

    /// Rewrites a property read (ADR-0051).
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewritePropertyAccessExpression(node BoundPropertyAccessExpression) BoundExpression {
        if node.Receiver == nil {
            return node
        }
        let receiver = RewriteExpression(node.Receiver)
        return if receiver == node.Receiver {
            node
        } else {
            BoundPropertyAccessExpression(
                node.Syntax,
                receiver,
                node.StructType,
                node.Property,
                node.SubstitutedType,
                node.NarrowedType,
                node.InterfaceType
            )
        }
    }

    /// Rewrites a property assignment (ADR-0051).
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewritePropertyAssignmentExpression(node BoundPropertyAssignmentExpression) BoundExpression {
        let receiver = if node.Receiver != nil {
            RewriteExpression(node.Receiver)
        } else {
            default(BoundExpression?)
        }
        let value = RewriteExpression(node.Value)
        // receiver is null for a STATIC property assignment -- the line above

        // produces null for exactly that shape, and the constructor's receiver

        // parameter is nullable to accept it. The early return only covers the

        // case where the value is also unchanged, so asserting here (as this

        // line briefly did) crashed any rewrite of a static property's RHS.

        return if receiver == node.Receiver && value == node.Value {
            node
        } else {
            BoundPropertyAssignmentExpression(
                nil,
                receiver,
                node.StructType,
                node.Property,
                value,
                node.SubstitutedType,
                node.InterfaceType
            )
        }
    }

    /// Rewrites a null-conditional access expression (Phase 3.C.3b).
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteNullConditionalAccessExpression(
        node BoundNullConditionalAccessExpression
    ) BoundExpression {
        let receiver = RewriteExpression(node.Receiver)
        let whenNotNull = RewriteExpression(node.WhenNotNull)
        if receiver == node.Receiver && whenNotNull == node.WhenNotNull {
            return node
        }
        return BoundNullConditionalAccessExpression(
            node.Syntax,
            receiver,
            node.Capture,
            whenNotNull,
            node.Type,
            node.ResultSlot
        )
    }

    /// Rewrites a tuple literal (Phase 4.5).
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteTupleLiteralExpression(node BoundTupleLiteralExpression) BoundExpression {
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < node.Elements.Length; i++ {
            let oldEl = node.Elements[i]
            let newEl = RewriteExpression(oldEl)
            if newEl != oldEl && builder == nil {
                builder = ImmutableArray.CreateBuilder[BoundExpression](node.Elements.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(node.Elements[j])
                }
            }
            builder?.Add(newEl)
        }
        return if builder == nil {
            node
        } else {
            BoundTupleLiteralExpression(node.Syntax, node.TupleType, builder.ToImmutable())
        }
    }

    /// Rewrites a tuple element access (Phase 4.5).
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteTupleElementAccessExpression(node BoundTupleElementAccessExpression) BoundExpression {
        let receiver = RewriteExpression(node.Receiver)
        return if receiver == node.Receiver {
            node
        } else {
            BoundTupleElementAccessExpression(node.Syntax, receiver, node.TupleType, node.Index)
        }
    }

    /// Rewrites a function literal (Phase 4.7). The body is intentionally not rewritten because it forms a
    /// separate lexical scope.
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteFunctionLiteralExpression(node BoundFunctionLiteralExpression) BoundExpression {
        return node
    }

    /// Rewrites a method-group expression (issue #324).
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteMethodGroupExpression(node BoundMethodGroupExpression) BoundExpression {
        if node.Receiver == nil {
            return node
        }
        let receiver = RewriteExpression(node.Receiver)
        if receiver == node.Receiver {
            return node
        }
        return if node.FunctionType != nil {
            BoundMethodGroupExpression(
                node.Syntax,
                receiver,
                Invariant.Required(
                    node.Function,
                    "a method group with a function type has a function",
                    expression: "node.Function"
                ),
                node.FunctionType,
                node.StaticOwnerType,
                node.MethodTypeArguments
            ){
                ForceNonVirtualDispatch = node.ForceNonVirtualDispatch,
                HasTargetDelegateType = node.HasTargetDelegateType
            }
        } else {
            BoundMethodGroupExpression(node.Syntax, receiver, node.Candidates, node.StaticOwnerType){
                ForceNonVirtualDispatch = node.ForceNonVirtualDispatch,
                HasTargetDelegateType = node.HasTargetDelegateType
            }
        }
    }

    /// Rewrites a CLR method-group expression (issue #337).
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteClrMethodGroupExpression(node BoundClrMethodGroupExpression) BoundExpression {
        if node.Receiver == nil {
            return node
        }
        let receiver = RewriteExpression(node.Receiver)
        if receiver == node.Receiver {
            return node
        }
        return if node.ResolvedMethod != nil {
            BoundClrMethodGroupExpression(
                node.Syntax,
                receiver,
                Invariant.Required(
                    node.ResolvedMethod,
                    "a resolved CLR method group has a method",
                    expression: "node.ResolvedMethod"
                ),
                Invariant.Required(
                    node.DelegateType,
                    "a resolved CLR method group has a delegate type",
                    expression: "node.DelegateType"
                )
            )
        } else {
            BoundClrMethodGroupExpression(node.Syntax, receiver, node.DeclaringType, node.MethodName, node.Candidates)
        }
    }

    /// Rewrites an indirect call (Phase 4.7).
    /// @param node The node to rewrite.
    /// @returns The rewritten node.
    protected open func RewriteIndirectCallExpression(node BoundIndirectCallExpression) BoundExpression {
        let target = RewriteExpression(node.Target)
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < node.Arguments.Length; i++ {
            let oldArg = node.Arguments[i]
            let newArg = RewriteExpression(oldArg)
            if newArg != oldArg && builder == nil {
                builder = ImmutableArray.CreateBuilder[BoundExpression](node.Arguments.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(node.Arguments[j])
                }
            }
            builder?.Add(newArg)
        }
        if target == node.Target && builder == nil {
            return node
        }
        return BoundIndirectCallExpression(
            node.Syntax,
            target,
            node.FunctionType,
            builder?.ToImmutable() ?? node.Arguments,
            node.ArgumentRefKinds
        )
    }

    /// Rewrites each interpolation hole's value expression, preserving the
    /// ordered literal/hole structure plus alignment/format metadata
    /// (ADR-0055).
    /// @param node The interpolated-string node to rewrite.
    /// @returns The rewritten node, or the original when nothing changed.
    protected open func RewriteInterpolatedStringExpression(node BoundInterpolatedStringExpression) BoundExpression {
        var builder ImmutableArray[BoundInterpolatedStringPart].Builder? = nil
        for var i = 0; i < node.Parts.Length; i++ {
            let oldPart = node.Parts[i]
            if oldPart.IsLiteral {
                builder?.Add(oldPart)
                continue
            }
            let newValue = RewriteExpression(oldPart.Value!!)
            if newValue != oldPart.Value && builder == nil {
                builder = ImmutableArray.CreateBuilder[BoundInterpolatedStringPart](node.Parts.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(node.Parts[j])
                }
            }
            builder?.Add(
                if newValue == oldPart.Value {
                    oldPart
                } else {
                    oldPart.WithValue(newValue)
                }
            )
        }
        // Issue #368: rewrite the forwarded handler arguments as well.

        var handler InterpolatedStringHandlerInfo? = node.Handler
        if handler != nil && !handler.ForwardedArguments.IsDefaultOrEmpty {
            var forwarded ImmutableArray[BoundExpression].Builder? = nil
            for var i = 0; i < handler.ForwardedArguments.Length; i++ {
                let oldArg = handler.ForwardedArguments[i]
                let newArg = RewriteExpression(oldArg)
                if newArg != oldArg && forwarded == nil {
                    forwarded = ImmutableArray.CreateBuilder[BoundExpression](handler.ForwardedArguments.Length)
                    for var j = 0; j < i; j++ {
                        forwarded.Add(handler.ForwardedArguments[j])
                    }
                }
                forwarded?.Add(newArg)
            }
            if forwarded != nil {
                handler = handler.WithForwardedArguments(forwarded.ToImmutable())
            }
        }
        if builder == nil && object.ReferenceEquals(handler, node.Handler) {
            return node
        }
        return node.Update(builder?.ToImmutable() ?? node.Parts, handler)
    }

    /// Rewrites an expression-level `is` pattern test.
    /// @param node The bound is-expression.
    /// @returns The rewritten expression.
    protected open func RewriteIsExpression(node BoundIsExpression) BoundExpression {
        let expression = RewriteExpression(node.Expression)
        let pattern = RewritePattern(node.Pattern)
        if expression == node.Expression && pattern == node.Pattern {
            return node
        }
        return BoundIsExpression(node.Syntax, expression, pattern)
    }

    /// Rewrites an expression-level `as` safe-cast.
    /// @param node The bound as-expression.
    /// @returns The rewritten expression.
    protected open func RewriteAsExpression(node BoundAsExpression) BoundExpression {
        let expression = RewriteExpression(node.Expression)
        if expression == node.Expression {
            return node
        }
        return BoundAsExpression(node.Syntax, expression, node.TargetType)
    }
}
