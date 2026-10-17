// <copyright file="ExpressionBinder.NullCoalescingAssignment.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
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
    /// ADR-0072 / issue #709, issue #4967: binds the null-coalescing
    /// compound assignment `target ??= value`, in statement and value
    /// position alike. The target must be an assignable expression of nullable
    /// (or platform) type. Any non-trivial receiver and every index of the
    /// target is captured into a synthetic local first, so it is evaluated
    /// exactly once; the target is then read once, and only when that read is
    /// nil is the right-hand side evaluated and written back through the same
    /// lvalue. The value is the target's final value: the value read when it
    /// was not nil, otherwise the assigned value. The lowering is the
    /// compound-assignment shape, a (cref:BoundBlockExpression) of the
    /// captures over
    ///
    /// ```text
    /// read ?? { let <ncaVal> = value; write(<ncaVal>); <ncaVal> }
    /// ```
    ///
    /// so the `??` operator table types the result: `T` when the stored
    /// value is known non-nil, otherwise `T?`. A throwing right-hand side is
    /// the fallback itself (`read ?? throw E`). At statement level the value
    /// is discarded.
    /// @param syntax The `??=` expression.
    /// @returns The bound, lowered expression.
    private func BindNullCoalescingAssignmentExpression(
        syntax NullCoalescingAssignmentExpressionSyntax
    ) BoundExpression {
        // Bind the LHS as a read-side expression. This decides the lvalue
        // shape (variable / field / property / indexer) we need to mirror
        // on the write side, and surfaces the type to validate nullability.
        let boundRead = BindExpression(syntax.Target)
        if boundRead is BoundErrorExpression || boundRead.Type == TypeSymbol.Error {
            let _ = BindExpression(syntax.Value)
            return BoundErrorExpression(nil)
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
            return BoundErrorExpression(nil)
        }
        // Bind the RHS, converting it to the LHS's nullable type so the
        // author can write either an underlying-typed value (which lifts
        // via the implicit T -> T? conversion) or another nullable value.
        let rhsTargetType = nullableType ?? boundRead.Type
        let boundRhs = BindExpression(syntax.Value, rhsTargetType)
        if boundRhs is BoundErrorExpression || boundRhs.Type == TypeSymbol.Error {
            return BoundErrorExpression(nil)
        }
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
        let (read, write) = TryBuildNullCoalescingReadWrite(syntax, boundRead, storedValue, preStatements)
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
    private func TryBuildNullCoalescingReadWrite(
        syntax NullCoalescingAssignmentExpressionSyntax,
        boundRead BoundExpression,
        boundRhs BoundExpression,
        preStatements ImmutableArray[BoundStatement].Builder
    )(Read BoundExpression?, Write BoundExpression?) {
        switch boundRead {
            case varExpr is BoundVariableExpression {
                {
                    if varExpr.Variable.IsReadOnly {
                        Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, varExpr.Variable.Name)
                        return (nil, nil)
                    }
                    let write = BoundAssignmentExpression(syntax, varExpr.Variable, boundRhs)
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
                            syntax,
                            fieldAccess.Field,
                            fieldAccess.InterfaceType!!,
                            fieldAccess.SubstitutedType
                        )
                        let interfaceWrite = BoundFieldAssignmentExpression(
                            syntax,
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
                        default(BoundVariableExpression?)
                    } else {
                        CaptureReceiver(syntax, fieldAccess.Receiver, preStatements)
                    }
                    let read = BoundFieldAccessExpression(
                        syntax,
                        receiver,
                        Invariant.Required(
                            fieldAccess.StructType,
                            "a user field access has a declaring struct type",
                            expression: "fieldAccess.StructType"
                        ),
                        fieldAccess.Field
                    )
                    // Use the VariableSymbol-based constructor: every receiver
                    // captured by CaptureReceiver is a BoundVariableExpression
                    // (either the original simple variable or a synthetic local
                    // that holds the spilled receiver). The interpreter and the
                    // existing rewriters all assume this shape for the simple
                    // receiver path; routing through ReceiverExpression bypasses
                    // the interpreter's class-field write logic (issue #709).
                    let write = BoundFieldAssignmentExpression(
                        syntax,
                        receiver?.Variable,
                        Invariant.Required(
                            fieldAccess.StructType,
                            "a user field assignment has a declaring struct type",
                            expression: "fieldAccess.StructType"
                        ),
                        fieldAccess.Field,
                        boundRhs
                    )
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
                        default(BoundVariableExpression?)
                    } else {
                        CaptureReceiver(syntax, propAccess.Receiver, preStatements)
                    }
                    let read = BoundPropertyAccessExpression(
                        syntax,
                        receiver,
                        propAccess.StructType,
                        propAccess.Property,
                        propAccess.SubstitutedType,
                        propAccess.NarrowedType,
                        propAccess.InterfaceType
                    )
                    let write = BoundPropertyAssignmentExpression(
                        syntax,
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
                        default(BoundVariableExpression?)
                    } else {
                        CaptureReceiver(syntax, clrPropAccess.Receiver, preStatements)
                    }
                    let read = BoundClrPropertyAccessExpression(
                        syntax,
                        receiver,
                        clrPropAccess.Member,
                        clrPropAccess.Type,
                        clrPropAccess.StaticContainerType,
                        clrPropAccess.ConstrainedReceiverTypeParameter,
                        clrPropAccess.ConstrainedInterfaceType
                    )
                    let write = BoundClrPropertyAssignmentExpression(
                        syntax,
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
                    let target = CaptureReceiver(syntax, idx.Target, preStatements, forceCapture: true)
                    let indices = ImmutableArray.CreateBuilder[BoundExpression](idx.Indices.Length)
                    for index in idx.Indices {
                        indices.Add(CaptureReceiver(syntax, index, preStatements, forceCapture: true))
                    }
                    let capturedIndices = indices.MoveToImmutable()
                    let read = BoundIndexExpression(syntax, target, capturedIndices, idx.Type)
                    let write = BoundIndexAssignmentExpression(
                        syntax,
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
                    let target = CaptureReceiver(syntax, clrIdx.Target, preStatements)
                    let argsBuilder = ImmutableArray.CreateBuilder[BoundExpression](clrIdx.Arguments.Length)
                    for arg in clrIdx.Arguments {
                        argsBuilder.Add(CaptureReceiver(syntax, arg, preStatements))
                    }
                    let args = argsBuilder.ToImmutable()
                    let read = BoundClrIndexExpression(syntax, target, clrIdx.Indexer, args, clrIdx.Type)
                    let write = BoundClrIndexAssignmentExpression(
                        syntax,
                        target.Variable,
                        clrIdx.Indexer,
                        args,
                        boundRhs,
                        clrIdx.Type
                    )
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
                            syntax,
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
                            syntax,
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
                        syntax,
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

    /// ADR-0072 / issue #709: captures a non-trivial receiver expression
    /// into a synthetic read-only local declared in the current scope so
    /// the receiver is evaluated exactly once across the read+test+write
    /// triple. Simple variable references are returned unchanged because
    /// they have no observable side effects. Always returns a
    /// (cref:BoundVariableExpression) so callers can use the
    /// variable-receiver constructors on field / index assignments — the
    /// expression-receiver overloads bypass interpreter write logic
    /// (issue #709).
    private func CaptureReceiver(
        syntax NullCoalescingAssignmentExpressionSyntax,
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
        let declaration = BoundVariableDeclaration(syntax, local, receiver)
        preStatements.Add(declaration)
        return BoundVariableExpression(syntax, local)
    }

    shared {
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
