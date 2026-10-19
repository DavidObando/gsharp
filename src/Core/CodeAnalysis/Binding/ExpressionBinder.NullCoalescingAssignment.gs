// <copyright file="ExpressionBinder.NullCoalescingAssignment.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Threading

internal partial class ExpressionBinder {
    /// ADR-0072 / issue #709, issue #4967: binds what both positions of the
    /// null-coalescing compound assignment `target ??= value` share. The
    /// target must be an assignable expression of nullable (or platform)
    /// type; GS0298 rejects any other. The right-hand side is bound against
    /// the target's `T?`, so the author can write either an underlying-typed
    /// value (which lifts via the implicit `T -> T?` conversion) or another
    /// nullable value. Statement position
    /// ((cref:BindNullCoalescingAssignmentStatement)) and value position
    /// ((cref:BindNullCoalescingAssignmentExpression)) differ only in
    /// whether the lowering yields a value.
    /// @param syntax The `??=` expression.
    /// @returns The bound target read, the bound right-hand side, the type it
    /// was bound against, the target's nullable view, and whether the target
    /// is a non-nullable reference element; all `null` after an error.
    private func BindNullCoalescingAssignmentOperands(syntax NullCoalescingAssignmentExpressionSyntax)(
        Read BoundExpression?,
        Rhs BoundExpression?,
        RhsTargetType TypeSymbol?,
        NullableType NullableTypeSymbol?,
        NonNullableReferenceTarget bool
    ) {
        // Bind the LHS as a read-side expression. This decides the lvalue
        // shape (variable / field / property / indexer) we need to mirror
        // on the write side, and surfaces the type to validate nullability.
        let boundRead = BindExpression(syntax.Target)
        if boundRead is BoundErrorExpression || boundRead.Type == TypeSymbol.Error {
            let _ = BindExpression(syntax.Value)
            return (nil, nil, nil, nil, false)
        }
        var nullableType NullableTypeSymbol? = boundRead.Type as NullableTypeSymbol
        // ADR-0186 §6: `??=` accepts a `T!` left operand and GS0298 does not
        // fire. GS0298 exists to reject a target that can never be nil, and a
        // platform target genuinely can be — that is what oblivious means.
        // The target's `T?` view drives the rest of this method unchanged:
        // the two wrappers share one CLR representation (§1), so the
        // synthesized nil test and the write-back are identical.
        if nullableType == nil && boundRead.Type is PlatformTypeSymbol platformTarget {
            nullableType = NullableTypeSymbol.Get(platformTarget.UnderlyingType)
        }
        let isNonNullableReferenceTarget = nullableType == nil && Conversion.IsReferenceLikeTarget(boundRead.Type) &&
            (boundRead is BoundIndexExpression or BoundClrIndexExpression)
        if nullableType == nil && !isNonNullableReferenceTarget {
            Diagnostics.ReportNullCoalescingAssignmentTargetNotNullable(syntax.OperatorToken.Location, boundRead.Type)
            let _ = BindExpression(syntax.Value)
            return (nil, nil, nil, nil, false)
        }
        // Bind the RHS, converting it to the LHS's nullable type so the
        // author can write either an underlying-typed value (which lifts
        // via the implicit T -> T? conversion) or another nullable value.
        let rhsTargetType = nullableType ?? boundRead.Type
        let boundRhs = BindExpression(syntax.Value, rhsTargetType)
        if boundRhs is BoundErrorExpression || boundRhs.Type == TypeSymbol.Error {
            return (nil, nil, nil, nil, false)
        }
        return (boundRead, boundRhs, rhsTargetType, nullableType, isNonNullableReferenceTarget)
    }

    /// ADR-0072 / issue #709: binds `target ??= value` in statement position
    /// (an expression statement whose value is discarded) to
    /// `if read(target) == nil { write(target) = value }`, after capturing
    /// any non-trivial receiver and every index so that `obj.field ??= …`
    /// does not evaluate `obj` twice. Issue #4967 keeps this lowering, the
    /// one the statement form always had, so existing statements emit the
    /// same IL; it shares (cref:BindNullCoalescingAssignmentOperands) and
    /// (cref:TryBuildNullCoalescingReadWrite) with the value form. The
    /// lowered statement and its captures are anchored to the statement, a
    /// rebuilt target read to the target and the write to the `??=`
    /// expression, so the semantic model resolves each syntax node.
    /// @param statement The expression statement.
    /// @param syntax The `??=` expression of the statement.
    /// @returns The lowered statement.
    internal func BindNullCoalescingAssignmentStatement(
        statement ExpressionStatementSyntax,
        syntax NullCoalescingAssignmentExpressionSyntax
    ) BoundStatement {
        let (boundRead, boundRhs, _, _, isNonNullableReferenceTarget) = BindNullCoalescingAssignmentOperands(syntax)
        if boundRead == nil || boundRhs == nil {
            return BoundExpressionStatement(statement, BoundErrorExpression(nil))
        }
        let receiver = GetNullCoalescingReceiver(boundRead)
        // Evaluate a suspending value before entering the write node: generic
        // operand spilling would otherwise spill a struct receiver by value.
        let suspendingStorageWrite = receiver != nil &&
            !ReceiverTypeIsReference(receiver.Type) &&
            AsyncBoundTreeQueries.HasAwait(boundRhs)
        let rhsLocal LocalVariableSymbol? = if suspendingStorageWrite && boundRhs.Type != TypeSymbol.Never {
            LocalVariableSymbol(
                "<ncaRhs${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
                isReadOnly: true,
                boundRhs.Type
            )
        } else {
            default(LocalVariableSymbol?)
        }
        if rhsLocal != nil {
            $scope.TryDeclareVariable(rhsLocal)
        }
        let preStatements = ImmutableArray.CreateBuilder[BoundStatement]()
        let (read, write) = TryBuildNullCoalescingReadWrite(
            syntax,
            statement,
            syntax.Target,
            syntax,
            boundRead,
            if rhsLocal == nil {
                boundRhs
            } else {
                BoundVariableExpression(syntax.Value, rhsLocal)
            },
            preStatements,
            snapshotReceivers: false
        )
        if read == nil || write == nil {
            return BoundExpressionStatement(statement, BoundErrorExpression(nil))
        }
        // Condition: read == nil. Routes through the existing nil-compare
        // operator so any value-type Nullable<T> lowering is handled in the
        // same code path as `x == nil` elsewhere.
        // The test is synthesized and has no syntax of its own: lowering turns
        // the `if` into a conditional goto with no anchor, so an anchored test
        // would become the semantic model's answer for the statement, the
        // target or the `??=` expression.
        var conditionRead = read
        if isNonNullableReferenceTarget {
            conditionRead = BoundConversionExpression(nil, NullableTypeSymbol.Get(read.Type), read)
        }
        let nilLiteral = BoundLiteralExpression(nil, nil, TypeSymbol.Null)
        let eqOp = Invariant.Required(
            BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, conditionRead.Type, TypeSymbol.Null),
            "a nullable coalescing assignment target supports nil comparison",
            expression: "BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, conditionRead.Type, TypeSymbol.Null)"
        )
        let condition BoundExpression = BoundBinaryExpression(nil, conditionRead, eqOp, nilLiteral)
        let thenStmt BoundStatement = if suspendingStorageWrite && boundRhs.Type == TypeSymbol.Never {
            BoundExpressionStatement(statement, boundRhs)
        } else if rhsLocal == nil {
            BoundExpressionStatement(statement, write)
        } else {
            BoundBlockStatement(
                statement,
                ImmutableArray.Create[BoundStatement](
                    BoundVariableDeclaration(statement, rhsLocal, boundRhs),
                    BoundExpressionStatement(statement, write)
                )
            )
        }
        let ifStmt BoundStatement = BoundIfStatement(statement, condition, thenStmt, elseStatement: nil)
        if preStatements.Count == 0 {
            return ifStmt
        }
        preStatements.Add(ifStmt)
        return BoundBlockStatement(statement, preStatements.ToImmutable())
    }

    /// Issue #4967: binds `target ??= value` in value position. The value is
    /// the target's final value: the value read when it was not nil,
    /// otherwise the stored value. The lowering is the compound-assignment
    /// shape, a (cref:BoundBlockExpression) of the receiver and index
    /// captures over
    ///
    /// ```text
    /// read ?? { let <ncaVal> = value; write(<ncaVal>); <ncaVal> }
    /// ```
    ///
    /// so the target is read once, the right-hand side runs only when that
    /// read is nil, and the `??` operator table types the result: `T` when
    /// the stored value is known non-nil, otherwise `T?`. A throwing
    /// right-hand side is the fallback itself (`read ?? throw E`).
    /// @param syntax The `??=` expression.
    /// @returns The bound, lowered expression.
    private func BindNullCoalescingAssignmentExpression(
        syntax NullCoalescingAssignmentExpressionSyntax
    ) BoundExpression {
        let (
            operandRead,
            operandRhs,
            operandTargetType,
            nullableType,
            isNonNullableReferenceTarget
        ) = BindNullCoalescingAssignmentOperands(syntax)
        if operandRead == nil || operandRhs == nil || operandTargetType == nil {
            return BoundErrorExpression(nil)
        }
        let boundRead BoundExpression = operandRead
        let boundRhs BoundExpression = operandRhs
        let rhsTargetType TypeSymbol = operandTargetType
        // Issue #4967: the value `??=` yields is the value it stores. Binding
        // the right-hand side against `T?` wraps a non-nullable value in the
        // lifting conversion; the value is the pre-conversion value converted
        // once to the target's underlying `T`, and the write stores that same
        // value lifted to `T?` (so a boxed value keeps its identity, #4967
        // review). Only a value whose type proves it non-nil gets `T`: see
        // (cref:ProvesNonNil). Every other right-hand side is stored and
        // yielded exactly as bound, typed `T?`, as the statement form always
        // stored it.
        let preConversion = if boundRhs is BoundConversionExpression lift && lift.Type == rhsTargetType {
            lift.Expression
        } else {
            boundRhs
        }
        let underlying TypeSymbol? = nullableType?.UnderlyingType
        let provesNonNil = underlying != nil && ProvesNonNil(preConversion.Type, underlying)
        let preStatements = ImmutableArray.CreateBuilder[BoundStatement]()
        // A throwing right-hand side (`x ??= throw E`) has no value to store:
        // it is the coalesce's fallback as is, as in `x ?? throw E`.
        let isThrow = boundRhs.Type == TypeSymbol.Never
        let valueLocal LocalVariableSymbol? = if isThrow {
            default(LocalVariableSymbol?)
        } else {
            LocalVariableSymbol(
                "<ncaVal${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
                isReadOnly: true,
                if provesNonNil {
                    Invariant.Required(underlying, "a non-nil value has an underlying type", expression: "underlying")
                } else {
                    rhsTargetType
                }
            )
        }
        var storedValue = boundRhs
        if valueLocal != nil {
            $scope.TryDeclareVariable(valueLocal)
            let valueRead = BoundVariableExpression(syntax, valueLocal)
            storedValue = if valueLocal.Type == rhsTargetType {
                cast[BoundExpression](valueRead)
            } else {
                conversions.BindConversion(syntax.Value.Location, valueRead, rhsTargetType)
            }
        }
        let (read, write) = TryBuildNullCoalescingReadWrite(
            syntax,
            syntax,
            syntax.Target,
            syntax,
            boundRead,
            storedValue,
            preStatements,
            snapshotReceivers: true
        )
        if read == nil || write == nil {
            return BoundErrorExpression(nil)
        }
        // The nil test is the `??` operator's own, so any value-type
        // Nullable<T> lowering is handled in the same code path as `a ?? b`
        // elsewhere. A non-nullable reference element is viewed as `T?`.
        var coalesceRead = read
        if isNonNullableReferenceTarget {
            coalesceRead = BoundConversionExpression(syntax, NullableTypeSymbol.Get(read.Type), read)
        }
        let whenNil BoundExpression = if valueLocal == nil {
            boundRhs
        } else {
            let initialValue = if valueLocal.Type == boundRhs.Type {
                boundRhs
            } else if provesNonNil {
                conversions.BindConversion(syntax.Value.Location, preConversion, valueLocal.Type)
            } else {
                conversions.BindConversion(syntax.Value.Location, boundRhs, valueLocal.Type)
            }
            BoundBlockExpression(
                syntax,
                ImmutableArray.Create[BoundStatement](
                    BoundVariableDeclaration(syntax, valueLocal, initialValue),
                    BoundExpressionStatement(syntax, write)
                ),
                BoundVariableExpression(syntax, valueLocal)
            )
        }
        let coalesceOperator = Invariant.Required(
            BoundBinaryOperator.Bind(SyntaxKind.QuestionQuestionToken, coalesceRead.Type, whenNil.Type),
            "a nullable coalescing assignment target coalesces with its own stored value",
            expression: "BoundBinaryOperator.Bind(SyntaxKind.QuestionQuestionToken, coalesceRead.Type, whenNil.Type)"
        )
        let whenNilValue = if whenNil.Type == coalesceOperator.Type || whenNil.Type == TypeSymbol.Never {
            whenNil
        } else {
            conversions.BindConversion(syntax.Value.Location, whenNil, coalesceOperator.Type)
        }
        let coalesce = BoundBinaryExpression(syntax, coalesceRead, coalesceOperator, whenNilValue)
        if preStatements.Count == 0 {
            return coalesce
        }
        return BoundBlockExpression(syntax, preStatements.ToImmutable(), coalesce)
    }

    /// ADR-0072 / issue #709: builds the read+write pair for a
    /// `??=` target by inspecting the bound read form. Non-trivial
    /// receivers are spilled into synthetic locals (declared in the
    /// current scope and prepended to [`preStatements`](paramref))
    /// so the receiver is evaluated exactly once. Returns
    /// `(null, null)` with a diagnostic when the target shape is
    /// not assignable or the target is read-only.
    /// @param syntax The `??=` expression; diagnostics use its operator.
    /// @param captureAnchor The syntax the capture declarations are anchored to.
    /// @param readAnchor The syntax a rebuilt target read is anchored to.
    /// @param writeAnchor The syntax the write is anchored to.
    /// @param boundRead The bound target read.
    /// @param boundRhs The value to write.
    /// @param preStatements Receives the capture declarations.
    /// @param snapshotReceivers Issue #4967: in value position the value is
    /// computed before the write, so a reference-typed receiver held in a
    /// variable, and every CLR indexer argument, is captured even when it is
    /// a plain variable; otherwise a right-hand side that reassigns it would
    /// redirect the write. A value-type receiver is never copied (the write
    /// must reach its storage).
    /// @returns The read and the write, or `(null, null)`.
    private func TryBuildNullCoalescingReadWrite(
        syntax NullCoalescingAssignmentExpressionSyntax,
        captureAnchor SyntaxNode,
        readAnchor SyntaxNode,
        writeAnchor SyntaxNode,
        boundRead BoundExpression,
        boundRhs BoundExpression,
        preStatements ImmutableArray[BoundStatement].Builder,
        snapshotReceivers bool
    )(Read BoundExpression?, Write BoundExpression?) {
        let memberReceiver = GetNullCoalescingReceiver(boundRead)
        if memberReceiver != nil && !ReceiverTypeIsReference(memberReceiver.Type) {
            if ReceiverBlocksValueTypeMemberWrite(memberReceiver) || RefCapabilities.IsReadOnlyReference(
                memberReceiver
            ) {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, syntax.Target.ToString())
                return (nil, nil)
            }
            if !IsWritableStructFieldReceiver(memberReceiver) && !RefCapabilities.IsNativeRefReturningCall(
                memberReceiver
            ) {
                Diagnostics.ReportFieldAssignmentThroughStructTemporary(
                    syntax.OperatorToken.Location,
                    syntax.Target.ToString(),
                    memberReceiver.Type
                )
                return (nil, nil)
            }
        }
        let SnapshotsReference = func (receiver BoundExpression?) bool {
            return snapshotReceivers && receiver != nil && ReceiverTypeIsReference(receiver.Type)
        }
        switch boundRead {
            case varExpr is BoundVariableExpression {
                {
                    if varExpr.Variable.IsReadOnly {
                        Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, varExpr.Variable.Name)
                        return (nil, nil)
                    }
                    let write = BoundAssignmentExpression(writeAnchor, varExpr.Variable, boundRhs)
                    return (boundRead, write)
                }
            }
            case fieldAccess is BoundFieldAccessExpression {
                {
                    if fieldAccess.InterfaceType != nil {
                        if fieldAccess.Field.IsReadOnly {
                            Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, fieldAccess.Field.Name)
                            return (nil, nil)
                        }
                        let interfaceRead = BoundFieldAccessExpression(
                            readAnchor,
                            fieldAccess.Field,
                            fieldAccess.InterfaceType!!,
                            fieldAccess.SubstitutedType,
                            fieldAccess.NarrowedType
                        )
                        let interfaceWrite = BoundFieldAssignmentExpression(
                            writeAnchor,
                            fieldAccess.Field,
                            fieldAccess.InterfaceType!!,
                            boundRhs,
                            fieldAccess.SubstitutedType
                        )
                        return (interfaceRead, interfaceWrite)
                    }
                    // Issue #947: a read-only (`let`) instance field may be written
                    // by a compound assignment inside the declaring type's
                    // constructor when the receiver is `this`; everywhere else the
                    // read-only field write remains a GS0127 error.
                    if fieldAccess.Field.IsReadOnly {
                        let fn FunctionSymbol? = this.function
                        let inCtor = fn != nil &&
                            fn.Name == ".ctor" &&
                            fn.ThisParameter != nil &&
                            !fieldAccess
                            .Field
                            .IsStatic
                        let receiverIsThis = fieldAccess.Receiver == nil ||
                            (
                            fieldAccess.Receiver is BoundVariableExpression rbve &&
                                fn?.ThisParameter != nil &&
                                object.ReferenceEquals(rbve.Variable, fn!!.ThisParameter)
                        )
                        let declaredByThisType = fieldAccess.StructType == nil ||
                            fn?.ReceiverType == nil ||
                            object.ReferenceEquals(fieldAccess.StructType, fn!!.ReceiverType)
                        if !inCtor || !receiverIsThis || !declaredByThisType {
                            Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, fieldAccess.Field.Name)
                            return (nil, nil)
                        }
                    }
                    // Issue #2043: a static field's bound read has a null
                    // Receiver (there is no instance to dereference); only
                    // capture a receiver local when one actually exists. Calling
                    // CaptureReceiver unconditionally NREs on receiver.Type for
                    // the static case.
                    let receiver = if fieldAccess.Receiver == nil {
                        default(BoundExpression?)
                    } else {
                        CaptureStorageReceiver(
                            captureAnchor,
                            fieldAccess.Receiver,
                            preStatements,
                            forceCapture: SnapshotsReference(fieldAccess.Receiver)
                        )
                    }
                    let read = BoundFieldAccessExpression(
                        readAnchor,
                        receiver,
                        Invariant.Required(
                            fieldAccess.StructType,
                            "a user field access has a declaring struct type",
                            expression: "fieldAccess.StructType"
                        ),
                        fieldAccess.Field,
                        fieldAccess.SubstitutedType,
                        fieldAccess.NarrowedType
                    )
                    let declaringType = Invariant.Required(
                        fieldAccess.StructType,
                        "a user field assignment has a declaring struct type",
                        expression: "fieldAccess.StructType"
                    )
                    let variableReceiver = receiver as BoundVariableExpression
                    let isAlias = variableReceiver?.Variable is LocalVariableSymbol and {RefKind: not RefKind.None}
                    let write = if receiver == nil || (variableReceiver != nil && !isAlias) {
                        BoundFieldAssignmentExpression(
                            writeAnchor,
                            variableReceiver?.Variable,
                            declaringType,
                            fieldAccess.Field,
                            boundRhs,
                            fieldAccess.SubstitutedType
                        )
                    } else {
                        BoundFieldAssignmentExpression.WithExpressionReceiver(
                            writeAnchor,
                            receiver,
                            declaringType,
                            fieldAccess.Field,
                            boundRhs,
                            fieldAccess.SubstitutedType
                        )
                    }
                    return (read, write)
                }
            }
            case propAccess is BoundPropertyAccessExpression {
                {
                    if !propAccess.Property.HasSetter {
                        Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, propAccess.Property.Name)
                        return (nil, nil)
                    }
                    // The write goes through the setter: enforce its own
                    // accessibility (a `private set` on a protected property), as
                    // the plain and compound writes do, against the type that
                    // declares the property.
                    if propAccess.StructType is {} propertyReceiverType &&
                        FindPropertyDeclaringType(propertyReceiverType, propAccess.Property) is {} propertyOwner &&
                        !AccessibilityChecker
                        .IsAccessible(propAccess.Property.SetterAccessibility, propertyOwner, function) {
                        Diagnostics.ReportMemberInaccessible(
                            syntax.OperatorToken.Location,
                            propAccess.Property.Name,
                            propertyOwner.Name,
                            propAccess.Property.SetterAccessibility
                        )
                        return (nil, nil)
                    }
                    // Issue #946: a compound assignment (`+=` / `??=`) to an
                    // init-only property is only legal during object initialization.
                    if propAccess.Property.IsInitOnly {
                        let fn FunctionSymbol? = this.function
                        let inInitContext = fn != nil && (fn.Name == ".ctor" || fn.IsInitOnlySetter)
                        let receiverIsThis = propAccess.Receiver == nil ||
                            (
                            propAccess.Receiver is BoundVariableExpression rbve &&
                                fn?.ThisParameter != nil &&
                                object.ReferenceEquals(rbve.Variable, fn!!.ThisParameter)
                        )
                        if !inInitContext || !receiverIsThis {
                            Diagnostics.ReportInitOnlyPropertyAssignment(
                                syntax.OperatorToken.Location,
                                propAccess.Property.Name
                            )
                            return (nil, nil)
                        }
                    }
                    let receiver = if propAccess.Receiver == nil {
                        default(BoundExpression?)
                    } else {
                        CaptureStorageReceiver(
                            captureAnchor,
                            propAccess.Receiver,
                            preStatements,
                            forceCapture: SnapshotsReference(propAccess.Receiver)
                        )
                    }
                    let read = BoundPropertyAccessExpression(
                        readAnchor,
                        receiver,
                        propAccess.StructType,
                        propAccess.Property,
                        propAccess.SubstitutedType,
                        propAccess.NarrowedType,
                        propAccess.InterfaceType
                    )
                    let write = BoundPropertyAssignmentExpression(
                        writeAnchor,
                        receiver,
                        propAccess.StructType,
                        propAccess.Property,
                        boundRhs,
                        propAccess.SubstitutedType,
                        propAccess.InterfaceType
                    )
                    return (read, write)
                }
            }
            case clrPropAccess is BoundClrPropertyAccessExpression {
                {
                    // For CLR properties, writability is enforced when the
                    // assignment is built — we mirror the assignment path here
                    // so the same diagnostic surfaces on `??=` targets.
                    if clrPropAccess.Member is PropertyInfo propInfo && !propInfo.CanWrite {
                        Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, propInfo.Name)
                        return (nil, nil)
                    }
                    // The write goes through the setter, which must be callable
                    // here: public, a friend assembly's internal, or protected
                    // from a class deriving from the declaring type. The same
                    // visibility the plain write uses, rather than `CanWrite`
                    // alone, which admits a private setter.
                    if clrPropAccess.Member is PropertyInfo writeProperty && !HasCallableClrSetter(writeProperty) {
                        Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, writeProperty.Name)
                        return (nil, nil)
                    }
                    if clrPropAccess.Member is FieldInfo fieldInfo && (fieldInfo.IsInitOnly || fieldInfo.IsLiteral) {
                        Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, fieldInfo.Name)
                        return (nil, nil)
                    }
                    let receiver = if clrPropAccess.Receiver == nil {
                        default(BoundExpression?)
                    } else {
                        CaptureStorageReceiver(
                            captureAnchor,
                            clrPropAccess.Receiver,
                            preStatements,
                            forceCapture: SnapshotsReference(clrPropAccess.Receiver)
                        )
                    }
                    let read = BoundClrPropertyAccessExpression(
                        readAnchor,
                        receiver,
                        clrPropAccess.Member,
                        clrPropAccess.Type,
                        clrPropAccess.StaticContainerType,
                        clrPropAccess.ConstrainedReceiverTypeParameter,
                        clrPropAccess.ConstrainedInterfaceType
                    )
                    let write = BoundClrPropertyAssignmentExpression(
                        writeAnchor,
                        receiver,
                        clrPropAccess.Member,
                        boundRhs,
                        clrPropAccess.Type,
                        clrPropAccess.StaticContainerType,
                        clrPropAccess.ConstrainedReceiverTypeParameter,
                        clrPropAccess.ConstrainedInterfaceType
                    )
                    return (read, write)
                }
            }
            case idx is BoundIndexExpression {
                {
                    // Spill target and every index so none is re-evaluated.
                    let target = CaptureReceiver(captureAnchor, idx.Target, preStatements, forceCapture: true)
                    let indices = ImmutableArray.CreateBuilder[BoundExpression](idx.Indices.Length)
                    for index in idx.Indices {
                        indices.Add(CaptureReceiver(captureAnchor, index, preStatements, forceCapture: true))
                    }
                    let capturedIndices = indices.MoveToImmutable()
                    let read = BoundIndexExpression(readAnchor, target, capturedIndices, idx.Type)
                    let write = BoundIndexAssignmentExpression(
                        writeAnchor,
                        target.Variable,
                        capturedIndices,
                        boundRhs,
                        idx.Type
                    )
                    return (read, write)
                }
            }
            case clrIdx is BoundClrIndexExpression {
                {
                    if !clrIdx.Indexer.CanWrite {
                        Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, clrIdx.Indexer.Name)
                        return (nil, nil)
                    }
                    let target = CaptureStorageReceiver(
                        captureAnchor,
                        clrIdx.Target,
                        preStatements,
                        forceCapture: SnapshotsReference(clrIdx.Target)
                    )
                    // Evaluate storage checks before arguments, without keeping
                    // the managed pointer alive across a suspending argument.
                    if !ReceiverTypeIsReference(target.Type) {
                        preStatements.Add(
                            BoundExpressionStatement(captureAnchor, BoundAddressOfExpression(captureAnchor, target))
                        )
                    }
                    let argsBuilder = ImmutableArray.CreateBuilder[BoundExpression](clrIdx.Arguments.Length)
                    for arg in clrIdx.Arguments {
                        argsBuilder.Add(
                            CaptureReceiver(captureAnchor, arg, preStatements, forceCapture: snapshotReceivers)
                        )
                    }
                    let args = argsBuilder.ToImmutable()
                    let read = BoundClrIndexExpression(
                        readAnchor,
                        target,
                        clrIdx.Indexer,
                        args,
                        clrIdx.Type,
                        clrIdx.ConstrainedReceiverTypeParameter,
                        clrIdx.ConstrainedInterfaceType
                    )
                    let write = if target is BoundVariableExpression variable &&
                        variable.Variable is not LocalVariableSymbol{RefKind: not RefKind.None} {
                        BoundClrIndexAssignmentExpression(
                            writeAnchor,
                            variable.Variable,
                            clrIdx.Indexer,
                            args,
                            boundRhs,
                            clrIdx.Type,
                            clrIdx.ConstrainedReceiverTypeParameter,
                            clrIdx.ConstrainedInterfaceType
                        )
                    } else {
                        BoundClrIndexAssignmentExpression.WithExpressionTarget(
                            writeAnchor,
                            target,
                            clrIdx.Indexer,
                            args,
                            boundRhs,
                            clrIdx.Type,
                            clrIdx.ConstrainedReceiverTypeParameter,
                            clrIdx.ConstrainedInterfaceType
                        )
                    }
                    return (read, write)
                }
            }
            case BoundBaseClassCallExpression{IsSetterAccessor: false, Arguments: {IsEmpty: true}} baseRead when(
                baseRead.Property ?? FindPropertyByGetter(baseRead.BaseClass, baseRead.Method)
            ) is {} baseProperty {
                {
                    if !baseProperty.HasSetter {
                        Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, baseProperty.Name)
                        return (nil, nil)
                    }
                    if !AccessibilityChecker.IsAccessible(
                        baseProperty.SetterAccessibility,
                        baseRead.BaseClass,
                        function
                    ) {
                        Diagnostics.ReportMemberInaccessible(
                            syntax.OperatorToken.Location,
                            baseProperty.Name,
                            baseRead.BaseClass.Name,
                            baseProperty.SetterAccessibility
                        )
                    }
                    let baseWrite BoundExpression = if baseProperty.SetterSymbol == nil {
                        BoundBaseClassCallExpression(
                            writeAnchor,
                            baseRead.Receiver,
                            baseRead.BaseClass,
                            method: nil,
                            ImmutableArray.Create(boundRhs),
                            TypeSymbol.Void,
                            property: baseProperty,
                            isSetterAccessor: true
                        )
                    } else {
                        BoundBaseClassCallExpression(
                            writeAnchor,
                            baseRead.Receiver,
                            baseRead.BaseClass,
                            baseProperty.SetterSymbol,
                            ImmutableArray.Create(boundRhs)
                        )
                    }
                    return (baseRead, baseWrite)
                }
            }
            case BoundImportedInstanceCallExpression{
                IsNonVirtualBaseCall: true,
                Arguments: {IsEmpty: true}
            } clrBaseRead when FindPropertyByGetter(clrBaseRead.Method) is {} clrBaseProperty {
                {
                    // The same derived-member visibility plain `base.P = v` uses:
                    // public, protected, or a friend assembly's internal setter.
                    let setter MethodInfo? = clrBaseProperty.SetMethod
                    let friendInternals = clrBaseProperty
                        .DeclaringType
                        ?.Assembly is {} declaringAssembly &&
                        $scope.References!!.CanAccessInternalMembers(declaringAssembly)
                    if setter == nil || setter.IsAbstract || !ClrMemberVisibility.IsVisibleFromDerived(
                        setter,
                        friendInternals
                    ) {
                        Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, clrBaseProperty.Name)
                        return (nil, nil)
                    }
                    let clrBaseWrite = BoundImportedInstanceCallExpression(
                        writeAnchor,
                        clrBaseRead.Receiver,
                        setter,
                        TypeSymbol.Void,
                        ImmutableArray.Create(boundRhs),
                        isNonVirtualBaseCall: true
                    )
                    return (clrBaseRead, clrBaseWrite)
                }
            }
            default {
                Diagnostics.ReportNullCoalescingAssignmentInvalidTarget(syntax.OperatorToken.Location)
                return (nil, nil)
            }
        }
    }

    /// Whether [`property`](paramref)'s setter can be called from the
    /// current member: public, internal in a friend assembly, or protected
    /// when the enclosing class derives from the declaring type.
    /// @param property The imported property.
    /// @returns `true` when the setter is callable here.
    private func HasCallableClrSetter(property PropertyInfo) bool {
        let friendInternals = property
            .DeclaringType
            ?.Assembly is {} declaringAssembly &&
            $scope.References!!.CanAccessInternalMembers(declaringAssembly)
        let visible MethodInfo? = if DerivesFromClrType(property.DeclaringType) {
            ClrMemberVisibility.GetDerivedVisibleSetter(property, friendInternals)
        } else {
            ClrMemberVisibility.GetVisibleSetter(property, friendInternals)
        }
        return visible != nil
    }

    /// Whether the class enclosing the current member (the member's own, or
    /// the one a function literal is nested in) inherits from
    /// [`declaringType`](paramref) through its imported base chain.
    /// @param declaringType The CLR declaring type.
    /// @returns `true` when the enclosing class derives from it.
    private func DerivesFromClrType(declaringType Type?) bool {
        let current = function
        if declaringType == nil ||
            (
            current?.ReceiverType ?? current?.StaticOwnerType ?? current?.LexicalEnclosingType
        ) is not StructSymbol enclosing {
            return false
        }
        let declaringDefinition = if declaringType.IsGenericType {
            declaringType.GetGenericTypeDefinition()
        } else {
            declaringType
        }
        for var level Type? = ExpressionBinder.GetInheritedClrBaseType(enclosing);
            level != nil;
            level = level!!
            .BaseType {
            let levelDefinition = if level.IsGenericType {
                level.GetGenericTypeDefinition()
            } else {
                level
            }
            if level.IsSameAs(declaringType) || levelDefinition.IsSameAs(declaringDefinition) {
                return true
            }
        }
        return false
    }

    /// Keep value-type receivers in their original storage. Capture only the
    /// reference owners and indices of field/element chains, so an awaited RHS
    /// cannot redirect the write and no managed pointer needs to cross it.
    private func CaptureStorageReceiver(
        anchor SyntaxNode,
        receiver BoundExpression,
        preStatements ImmutableArray[BoundStatement].Builder,
        forceCapture bool = false
    ) BoundExpression {
        let storage = CaptureStorageReceiverCore(anchor, receiver, preStatements, forceCapture)
        return SideEffectSpiller.CaptureRuntimeGenericStorageReceiver(
            storage,
            anchor,
            preStatements,
            func (role string, isReadOnly bool, storageType TypeSymbol) LocalVariableSymbol {
                let local = LocalVariableSymbol(
                    "<nca$role${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
                    isReadOnly,
                    storageType
                )
                $scope.TryDeclareVariable(local)
                return local
            }
        )
    }

    private func CaptureStorageReceiverCore(
        anchor SyntaxNode,
        receiver BoundExpression,
        preStatements ImmutableArray[BoundStatement].Builder,
        forceCapture bool
    ) BoundExpression {
        if ReceiverTypeIsReference(receiver.Type) {
            return CaptureReceiver(anchor, receiver, preStatements, forceCapture)
        }
        switch receiver {
            case tuple is BoundTupleElementAccessExpression {
                return BoundTupleElementAccessExpression(
                    tuple.Syntax,
                    CaptureStorageReceiver(anchor, tuple.Receiver, preStatements, forceCapture),
                    tuple.TupleType,
                    tuple.Index
                )
            }
            case _ is BoundVariableExpression {
                return receiver
            }
            case field is BoundFieldAccessExpression {
                if field.Receiver == nil {
                    return field
                }
                return BoundFieldAccessExpression(
                    field.Syntax,
                    CaptureStorageReceiver(anchor, field.Receiver, preStatements, forceCapture: true),
                    field.StructType,
                    field.Field,
                    field.SubstitutedType,
                    field.NarrowedType
                )
            }
            case index is BoundIndexExpression when index.IsArrayBackedElementAccess {
                let target = CaptureReceiver(anchor, index.Target, preStatements, forceCapture: true)
                let indices = ImmutableArray.CreateBuilder[BoundExpression](index.Indices.Length)
                for argument in index.Indices {
                    indices.Add(CaptureReceiver(anchor, argument, preStatements, forceCapture: true))
                }
                return BoundIndexExpression(index.Syntax, target, indices.MoveToImmutable(), index.Type)
            }
            case field is BoundClrPropertyAccessExpression when field.Member is FieldInfo {
                return BoundClrPropertyAccessExpression(
                    field.Syntax,
                    if field.Receiver == nil {
                        default(BoundExpression?)
                    } else {
                        CaptureStorageReceiver(anchor, field.Receiver, preStatements, forceCapture: true)
                    },
                    field.Member,
                    field.Type,
                    field.StaticContainerType,
                    field.ConstrainedReceiverTypeParameter,
                    field.ConstrainedInterfaceType,
                    field.IsAddressableStaticField,
                    field.IsReadOnlySubmissionGlobal
                )
            }
            case block is BoundBlockExpression {
                preStatements.AddRange(block.Statements)
                return CaptureStorageReceiver(anchor, block.Expression, preStatements, forceCapture)
            }
            default {
                // Opaque ref-returning receivers cannot be reconstructed after
                // suspension. A native ref alias preserves them once and lets
                // the existing liveness analyzer reject that case (GS0258).
                let name = "<ncaStorage${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
                let local = LocalVariableSymbol(name, isReadOnly: false, receiver.Type, anchor){
                    RefKind = RefKind.Ref,
                    ManagedReferenceOrigin = receiver
                }
                $scope.TryDeclareVariable(local)
                preStatements.Add(BoundVariableDeclaration(anchor, local, BoundAddressOfExpression(anchor, receiver)))
                return BoundVariableExpression(receiver.Syntax, local)
            }
        }
    }

    /// ADR-0072 / issue #709: captures a non-trivial value expression
    /// into a synthetic read-only local declared in the current scope so
    /// the receiver is evaluated exactly once across the read+test+write
    /// triple. Simple variable references are returned unchanged unless a
    /// snapshot is required. Storage receivers use (cref:CaptureStorageReceiver)
    /// instead, so value-type storage is never replaced with a copy.
    private func CaptureReceiver(
        anchor SyntaxNode,
        receiver BoundExpression,
        preStatements ImmutableArray[BoundStatement].Builder,
        forceCapture bool = false
    ) BoundVariableExpression {
        if !forceCapture && receiver is BoundVariableExpression bve {
            return bve
        }
        let name = "<ncaRecv${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
        let local = LocalVariableSymbol(name, isReadOnly: true, receiver.Type)
        $scope.TryDeclareVariable(local)
        let declaration = BoundVariableDeclaration(anchor, local, receiver)
        preStatements.Add(declaration)
        return BoundVariableExpression(anchor, local)
    }

    shared {
        private func GetNullCoalescingReceiver(read BoundExpression) BoundExpression? -> switch read {
            case field is BoundFieldAccessExpression: field.Receiver
            case property is BoundPropertyAccessExpression: property.Receiver
            case imported is BoundClrPropertyAccessExpression: imported.Receiver
            case index is BoundClrIndexExpression: index.Target
            default: default(BoundExpression?)
        }

        /// Issue #4967: whether a stored `??=` value of static type
        /// [`valueType`](paramref) is known non-nil, so the expression's
        /// value can be typed [`underlying`](paramref) rather than `T?`.
        /// It is the test plain `=` uses to narrow its target (issue #1123),
        /// except that a platform (`T!`) value does not qualify: it may be
        /// nil (ADR-0186), and treating it as `T` would insert a §4 check
        /// on a value the statement form stores unchecked.
        /// @param valueType The right-hand side's pre-conversion type.
        /// @param underlying The target's underlying non-nullable type.
        /// @returns `true` when the value is statically non-nil.
        private func ProvesNonNil(
            valueType TypeSymbol,
            underlying TypeSymbol
        ) bool -> valueType is not PlatformTypeSymbol &&
            StatementBinder.AssignmentTypePreservesNarrowing(valueType, underlying)

        /// The class in [`receiverType`](paramref)'s hierarchy that declares
        /// [`property`](paramref) (instance or static).
        /// @param receiverType The type the property was read through.
        /// @param property The property.
        /// @returns The declaring type, or `null` when it is not found.
        private func FindPropertyDeclaringType(receiverType StructSymbol, property PropertySymbol) StructSymbol? {
            for level in receiverType.GetHierarchy() {
                for candidate in level.Properties {
                    if object.ReferenceEquals(candidate, property) ||
                        (
                        candidate.Name == property.Name && object.ReferenceEquals(
                            candidate.GetterSymbol,
                            property.GetterSymbol
                        ) &&
                            candidate.GetterSymbol != nil
                    ) {
                        return level
                    }
                }
                for candidate in level.StaticProperties {
                    if object.ReferenceEquals(candidate, property) {
                        return level
                    }
                }
            }
            return nil
        }

        /// The source property whose getter is [`getter`](paramref), found
        /// on [`declaringType`](paramref): a base property read bound to its
        /// getter call carries only the accessor.
        /// @param declaringType The base class the getter was called on.
        /// @param getter The getter, or `null`.
        /// @returns The property, or `null` when the call is not a getter.
        private func FindPropertyByGetter(declaringType StructSymbol, getter FunctionSymbol?) PropertySymbol? {
            if getter == nil {
                return nil
            }
            for type in declaringType.GetHierarchy() {
                for property in type.Properties {
                    if object.ReferenceEquals(property.GetterSymbol, getter) {
                        return property
                    }
                }
            }
            return nil
        }

        /// The imported property whose getter is [`getter`](paramref).
        /// @param getter The called method.
        /// @returns The property, or `null` when the method is not a property getter.
        private func FindPropertyByGetter(getter MethodInfo) PropertyInfo? {
            if !getter.IsSpecialName || getter.DeclaringType is not{} declaringType {
                return nil
            }
            for property in ClrTypeUtilities.SafeGetProperties(
                declaringType,
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
            ) {
                if property.GetMethod is {} candidate &&
                    candidate.MetadataToken == getter.MetadataToken &&
                    candidate.Module == getter.Module {
                    return property
                }
            }
            return nil
        }
    }
}
