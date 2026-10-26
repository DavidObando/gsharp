// <copyright file="ExpressionBinder.Access.MemberLookup.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import System.Text
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Emit
import System.Globalization
import System.Threading

internal partial class ExpressionBinder {
    /// Issue #3887: the single chokepoint every member access, method call,
    /// index and null-conditional step routes through. When the receiver's type
    /// is ALREADY (cref:TypeSymbol.Error), the lookup below cannot
    /// succeed and will report `GS0158 Cannot find member` /
    /// `GS0159 Cannot find function` naming a member that usually exists
    /// on the type the user actually meant. The receiver can only be
    /// error-typed downstream of an expression that was already diagnosed, so
    /// those two reports are provably redundant with that first diagnostic —
    /// and they dominate triage: one bad argument was measured producing
    /// sixteen of them, all naming reflection surface, on a wall with no
    /// reflection defect in it.
    ///
    /// The suppression deliberately keys off the receiver's TYPE rather than
    /// its node kind. The binder already short-circuited on a
    /// (cref:BoundErrorExpression) node, but node identity is exactly
    /// what a binding loses: once the poison flows through a local
    /// (`let loaded = broken()`) the receiver is an ordinary variable
    /// reference that merely HAS the error type. Keying off the type makes the
    /// suppression survive inference.
    ///
    /// The lookup still RUNS and the diagnostic is still ADDED to the bag —
    /// only its visibility changes. Suppression here must alter which
    /// diagnostics are emitted and never what binds; see
    /// (cref:DiagnosticBag.SuppressMemberLookupCascadeIn{T}) for the two
    /// narrower-looking designs that violate that and the session tests that
    /// caught each of them.
    private func BindAccessorStep(
        receiver BoundExpression?,
        classSymbol ImportedClassSymbol?,
        rightPart ExpressionSyntax,
        receiverSyntax ExpressionSyntax? = nil,
        receiverStart int32? = nil
    ) BoundExpression {
        // Issue #4986: a smart cast narrows `n int32?` to `int32`, but C# code
        // and G# code written before `?:` narrowed (#4964) reads the guarded
        // value through `Nullable<T>`'s own members: `n.Value`,
        // `n.HasValue`, `n.GetValueOrDefault()`. When the narrowed type has
        // no member of that name, bind the member against the original
        // `Nullable<T>` storage instead. This is the one place that decides it
        // for every narrowing region (if-statement, if-expression, `?:`,
        // early exit), because they all build the receiver with
        // `BuildNarrowedRead`. The decision looks the name up without
        // binding anything, so the member and its arguments are bound once:
        // any member of that name the narrowed type has (a struct's own
        // `Value`, an overload that turns out inapplicable, an applicable
        // extension) keeps the narrowed binding and its diagnostics.
        let narrowingUnwrap = receiver as BoundUnaryExpression
        let headToken = AccessorHeadToken(rightPart, out var callSyntax)
        if narrowingUnwrap != nil &&
            narrowingUnwrap.IsNarrowingUnwrap &&
            headToken != nil &&
            NullableOnlyMemberNames.Contains(headToken.ValueText) &&
            !NarrowedTypeMayHaveMember(narrowingUnwrap.Type, headToken.ValueText, callSyntax) {
            return BindAccessorStepOnReceiver(
                narrowingUnwrap.Operand,
                classSymbol,
                rightPart,
                receiverSyntax,
                receiverStart
            )
        }
        return BindAccessorStepOnReceiver(receiver, classSymbol, rightPart, receiverSyntax, receiverStart)
    }

    /// Issue #4986: whether [`type`](paramref), the narrowed type of a
    /// value-type nullable read, may have a member named
    /// [`name`](paramref) that a member access would bind to: an instance or
    /// static member of the type, its interfaces or constraints, or an
    /// extension (source or imported) whose receiver can take it. Nothing is
    /// bound. When the shape is not known well enough to rule a member out,
    /// the answer is `true`, which keeps the narrowed binding.
    /// @param type The narrowed type.
    /// @param name The member name.
    /// @param callSyntax The unbound call, or `nil` for a method group.
    /// @returns `false` only when no member of that name can apply.
    private func NarrowedTypeMayHaveMember(type TypeSymbol, name string, callSyntax CallExpressionSyntax?) bool {
        if !$scope.TryLookupExtensionFunctions(type, name).IsDefaultOrEmpty {
            return true
        }
        if ImportedExtensionMayApply(type, name, callSyntax) {
            return true
        }
        switch type {
            case tupleType is TupleTypeSymbol when TryGetTupleElementIndex(name, tupleType, out _) {
                return true
            }
            case structType is StructSymbol {
                return StructMayHaveMember(structType, name)
            }
            case _ is EnumSymbol {
                return ClrTypeMayHaveMember(typeof(System.Enum), name)
            }
            case typeParameter is TypeParameterSymbol {
                return TypeParameterMayHaveMember(typeParameter, name)
            }
        }
        let clrType = type.ClrType
        if clrType == nil {
            return true
        }
        return ClrTypeMayHaveMember(clrType, name)
    }

    private func StructMayHaveMember(structType StructSymbol, name string) bool {
        if structType.Fields.Any((field FieldSymbol) -> field.Name == name) || structType.StaticFields.Any(
            (field FieldSymbol) -> field.Name == name
        ) ||
            structType
            .ConstFields
            .Any((field FieldSymbol) -> field.Name == name) || structType.Properties.Any(
            (property PropertySymbol) -> property.Name == name
        ) ||
            structType
            .StaticProperties
            .Any((property PropertySymbol) -> property.Name == name) || structType.Methods.Any(
            (method FunctionSymbol) -> method.Name == name
        ) ||
            structType
            .StaticMethods
            .Any((method FunctionSymbol) -> method.Name == name) || structType.Events.Any(
            (event_ EventSymbol) -> event_.Name == name
        ) ||
            structType
            .StaticEvents
            .Any((event_ EventSymbol) -> event_.Name == name) {
            return true
        }
        for interfaceType in structType.Interfaces {
            if InterfaceMayHaveMember(interfaceType, name) {
                return true
            }
        }
        for clrInterface in structType.ImplementedClrInterfaces {
            let clrInterfaceType = clrInterface.ClrType
            if clrInterfaceType == nil || ClrTypeMayHaveMember(clrInterfaceType, name) {
                return true
            }
        }
        return ClrTypeMayHaveMember(typeof(System.ValueType), name)
    }

    private func InterfaceMayHaveMember(interfaceType InterfaceSymbol, name string) bool {
        if interfaceType.Methods.Any((method FunctionSymbol) -> method.Name == name) || interfaceType.StaticMethods.Any(
            (method FunctionSymbol) -> method.Name == name
        ) ||
            interfaceType
            .Properties
            .Any((property PropertySymbol) -> property.Name == name) || interfaceType.Events.Any(
            (event_ EventSymbol) -> event_.Name == name
        ) {
            return true
        }
        for baseInterface in interfaceType.BaseInterfaces {
            if InterfaceMayHaveMember(baseInterface, name) {
                return true
            }
        }
        return false
    }

    private func TypeParameterMayHaveMember(typeParameter TypeParameterSymbol, name string) bool {
        if typeParameter.InterfaceConstraint is InterfaceSymbol interfaceConstraint &&
            InterfaceMayHaveMember(interfaceConstraint, name) {
            return true
        }
        for constraint in[]TypeSymbol? {typeParameter.ClrInterfaceConstraint, typeParameter.ClassConstraint} {
            if constraint != nil {
                let constraintClr = constraint.ClrType
                if constraintClr == nil || ClrTypeMayHaveMember(constraintClr, name) {
                    return true
                }
            }
        }
        if typeParameter.TypeParameterBound is TypeParameterSymbol bound && TypeParameterMayHaveMember(bound, name) {
            return true
        }
        return ClrTypeMayHaveMember(typeof(System.ValueType), name)
    }

    private func ClrTypeMayHaveMember(clrType Type, name string) bool {
        try {
            var lookupType = clrType
            let references = $scope.References
            if references != nil && references.TryGetMemberLookupType(clrType, out var targetLookupType) {
                lookupType = targetLookupType
            }
            let flags = BindingFlags.Public |
            BindingFlags.NonPublic |
            BindingFlags.Instance |
            BindingFlags.Static |
            BindingFlags.FlattenHierarchy
            if lookupType.GetMember(name, flags).Length > 0 {
                return true
            }
            for interfaceType in lookupType.GetInterfaces() {
                if interfaceType.GetMember(name, flags).Length > 0 {
                    return true
                }
            }
            return false
        } catch (ex Exception) when !(ex is OutOfMemoryException) {
            return true
        }
    }

    private func ImportedExtensionMayApply(type TypeSymbol, name string, callSyntax CallExpressionSyntax?) bool {
        let argumentNames = if callSyntax != nil {
            BuildDeferredArgumentNames(callSyntax, 1)
        } else {
            default(IReadOnlyList[string?]?)
        }
        for candidate in this.memberLookup.CollectImportedExtensionMethods(name) {
            try {
                if ClrOverloadResolution.MayAcceptExtensionReceiver(
                    candidate,
                    type,
                    callSyntax?.Arguments.Count,
                    argumentNames
                ) {
                    return true
                }
            } catch (ex Exception) when !(ex is OutOfMemoryException) {
                return true
            }
        }
        return false
    }

    private func BindAccessorStepOnReceiver(
        receiver BoundExpression?,
        classSymbol ImportedClassSymbol?,
        rightPart ExpressionSyntax,
        receiverSyntax ExpressionSyntax?,
        receiverStart int32?
    ) BoundExpression {
        var receiver = receiver
        var result = BindAccessorStepAfterPlatformReceiverCheck(
            CheckPlatformReceiver(receiver, receiverSyntax?.Location ?? rightPart.Location),
            if classSymbol == nil {
                default(ImportedClassSymbol?)
            } else {
                WithFamilyAccess(classSymbol)
            },
            rightPart,
            receiverSyntax,
            receiverStart
        )
        let unwrappedResult = UnwrapTransparentMemberResult(result)
        var recoveredDeclaredReceiver = false
        if receiver != nil && binderCtx.TryGetBackwardGotoNarrowingPath(receiver, out var receiverPath, out _) &&
            TryGetDeclaredReceiver(receiverPath!!, receiver) is {} declaredCallReceiver &&
            rightPart is CallExpressionSyntax callSyntax &&
            unwrappedResult is BoundUserInstanceCallExpression call &&
            FindDeclaredMethod(
            declaredCallReceiver.Type,
            callSyntax.Identifier.ValueText,
            call.Method,
            receiver.Type
        ) is {} declaredMethod {
            binderCtx.UntrackBackwardGotoNarrowingConversion(
                receiverPath!!,
                receiverSyntax?.Location ?? rightPart.Location
            )
            receiver = declaredCallReceiver
            result = RewrapTransparentMemberResult(
                result,
                BoundUserInstanceCallExpression(
                    call.Syntax,
                    receiver,
                    declaredMethod,
                    call.Arguments,
                    call.Type,
                    call.ConstrainedReceiverTypeParameter,
                    call.ConstrainedInterfaceType
                ){MethodTypeArguments = call.MethodTypeArguments}
            )
            recoveredDeclaredReceiver = true
        } else if receiver != nil && binderCtx.TryGetBackwardGotoNarrowingPath(receiver, out receiverPath, out _) &&
            TryGetDeclaredReceiver(receiverPath!!, receiver) is {} declaredClrReceiver &&
            rightPart is CallExpressionSyntax &&
            unwrappedResult is BoundImportedInstanceCallExpression importedCall &&
            FindDeclaredClrMethod(
            declaredClrReceiver.Type,
            importedCall.Method,
            importedCall.Type,
            receiver.Type
        ) is {} declaredClrMethod {
            binderCtx.UntrackBackwardGotoNarrowingConversion(
                receiverPath!!,
                receiverSyntax?.Location ?? rightPart.Location
            )
            receiver = declaredClrReceiver
            result = RewrapTransparentMemberResult(
                result,
                BoundImportedInstanceCallExpression(
                    importedCall.Syntax,
                    declaredClrReceiver,
                    declaredClrMethod,
                    importedCall.Type,
                    importedCall.Arguments,
                    importedCall.ArgumentRefKinds,
                    importedCall.TypeArgumentSymbols,
                    importedCall.ConstrainedReceiverTypeParameter,
                    importedCall.ConstrainedInterfaceType,
                    importedCall.IsNonVirtualBaseCall
                )
            )
            recoveredDeclaredReceiver = true
        } else if receiver != nil && binderCtx.TryGetBackwardGotoNarrowingPath(receiver, out receiverPath, out _) &&
            TryGetDeclaredReceiver(receiverPath!!, receiver) is {} declaredMemberReceiver &&
            rightPart is NameExpressionSyntax {
            let diagnosticCount = Diagnostics.Count
            let declaredResult = BindAccessorStepAfterPlatformReceiverCheck(
                declaredMemberReceiver,
                if classSymbol == nil {
                    default(ImportedClassSymbol?)
                } else {
                    WithFamilyAccess(classSymbol)
                },
                rightPart,
                receiverSyntax,
                receiverStart
            )
            Diagnostics.TruncateTo(diagnosticCount)
            // Rebind through the declared receiver only when the declared
            // lookup preserves the result type: a covariant override yields a
            // more derived type than the base slot, and replacing the bound
            // result would widen it (fail-safe: keep the original binding).
            if !(declaredResult is BoundErrorExpression) &&
                RefersToSameMemberSlot(result, declaredResult, receiver.Type) &&
                object
                .Equals(
                UnwrapTransparentMemberResult(result).Type,
                UnwrapTransparentMemberResult(declaredResult).Type
            ) {
                binderCtx.UntrackBackwardGotoNarrowingConversion(
                    receiverPath!!,
                    receiverSyntax?.Location ?? rightPart.Location
                )
                receiver = declaredMemberReceiver
                result = declaredResult
                recoveredDeclaredReceiver = true
            }
        }
        if !recoveredDeclaredReceiver {
            TrackBackwardGotoNarrowingAccess(receiver, rightPart, result)
        }
        if receiver == nil && classSymbol != nil && rightPart is (NameExpressionSyntax or CallExpressionSyntax) {
            let owner = classSymbol.ConstructedReceiver ??
                classSymbol.SymbolicReceiver ??
                ImportedTypeSymbol.GetWithoutNullability(classSymbol.ClassType, NullabilityFreeReason.ResolvedTypeName)
            RecordStaticTypeQualifier(result, owner, rightPart)
        }
        return result
    }

    private func TryGetDeclaredReceiver(path AccessPath, receiver BoundExpression) BoundExpression? {
        if !path.HasMembers {
            return if path.Root.Type is NullableTypeSymbol {
                default(BoundExpression?)
            } else {
                DeclaredReceiver(path.Root, receiver.Syntax)
            }
        }
        let declaredType = MemberLookup.GetDeclaredAccessPathType(path, receiver.Type)
        if declaredType is NullableTypeSymbol {
            return nil
        }
        switch receiver {
            case field is BoundFieldAccessExpression {
                return BoundFieldAccessExpression(
                    field.Syntax,
                    field.Receiver,
                    field.StructType,
                    field.Field,
                    field.SubstitutedType,
                    narrowedType: nil
                )
            }
            case property is BoundPropertyAccessExpression {
                return BoundPropertyAccessExpression(
                    property.Syntax,
                    property.Receiver,
                    property.StructType,
                    property.Property,
                    property.SubstitutedType,
                    narrowedType: nil,
                    property.InterfaceType
                )
            }
            case property is BoundClrPropertyAccessExpression {
                return BoundClrPropertyAccessExpression(
                    property.Syntax,
                    property.Receiver,
                    property.Member,
                    declaredType,
                    property.StaticContainerType,
                    property.ConstrainedReceiverTypeParameter,
                    property.ConstrainedInterfaceType
                )
            }
        }
        {
            var candidate = receiver
            while true {
                let conversion = candidate
                if !(conversion is BoundConversionExpression) {
                    break
                }
                if object.Equals(conversion.Expression.Type, declaredType) && object.Equals(
                    SmartCastStability.TryGetStablePath(conversion.Expression),
                    path
                ) {
                    return conversion.Expression
                }
                candidate = conversion.Expression
            }
        }
        return nil
    }

    private enum MemberOperation {
        Read,
        Write
    }

    private func TrackBackwardGotoNarrowingAccess(
        receiver BoundExpression?,
        rightPart ExpressionSyntax,
        result BoundExpression
    ) {
        var result = result
        result = UnwrapTransparentMemberResult(result)
        var location TextLocation
        var memberName string?
        var isInvocation bool
        switch rightPart {
            case name is NameExpressionSyntax {
                location = name.Location
                memberName = name.IdentifierToken.ValueText
                isInvocation = false
            }
            case call is CallExpressionSyntax {
                location = call.Identifier.Location
                memberName = call.Identifier.ValueText
                isInvocation = true
            }
            default {
                return
            }
        }
        var path AccessPath
        if receiver is BoundVariableExpression{NarrowedType: not nil} variableRead {
            path = AccessPath.ForVariable(variableRead.Variable)
        } else if receiver == nil || !SmartCastStability.TryGetStableMemberPath(receiver, out var stablePath, out _) {
            return
        } else {
            path = Invariant.Required(
                stablePath,
                "a narrowed stable member receiver has an access path",
                expression: "stablePath"
            )
        }
        let kind = if isInvocation {
            BackwardGotoNarrowingUseKind.Function
        } else {
            BackwardGotoNarrowingUseKind.Member
        }
        let requiredType = switch result {
            case call is BoundUserInstanceCallExpression: call.Method.ContainingType
            case call is BoundImportedInstanceCallExpression: call.CalledFunction.ContainingType
            case field is BoundFieldAccessExpression: field.Field.ContainingType
            case property is BoundPropertyAccessExpression: property.Property.ContainingType
            case property is BoundClrPropertyAccessExpression: property.ReferencedProperty?.ContainingType
            case group is BoundMethodGroupExpression: group.Function?.ContainingType
            case group is BoundClrMethodGroupExpression: group.Method?.ContainingType
            default: default(TypeSymbol?)
        }
        binderCtx.TrackBackwardGotoNarrowingUse(path, location, memberName!!, kind, requiredType: requiredType)
    }

    /// ADR-0186 §4 and §5, in one move: replaces a platform-typed receiver
    /// with the checked, <b>unwrapped</b> value before member binding runs.
    ///
    /// <b>§4.</b> The ADR's revised §4 is explicit that instance-member
    /// receivers get the check <em>like every other coercion</em>. The earlier
    /// draft's receiver exemption — "the CLR checks a `callvirt` receiver
    /// anyway" — was falsified by enumerating the emitter's opcode selection:
    /// `receiverIsClass` is `is StructSymbol {IsClass: true}` and
    /// `receiverIsInterface` is `is InterfaceSymbol`, so a
    /// <em>wrapped</em> receiver type, `string`, `Array`,
    /// non-virtual event accessors and method-group capture all emit
    /// `call` — or `ldftn`, which does not dereference the receiver
    /// at all and lets the nil travel into a delegate's `Target` slot and
    /// arbitrarily far from the site that produced it. The exemption may be
    /// re-derived once #4312/#4313 unify that opcode selection onto a single
    /// "is this a reference at runtime" predicate; until then it would make
    /// the design's safety depend on an emit property four known paths
    /// violate.
    ///
    /// <b>§5.</b> Because the replacement expression's type is
    /// `platform.UnderlyingType` — the same symbol the reader built, not
    /// one re-minted from `ClrType` — member lookup, overload resolution
    /// and extension resolution run against `T` <em>by construction</em>.
    /// A receiver's platform-ness is therefore not an input to member
    /// selection and cannot select a different member (§5a), and the symbolic
    /// or generic-substituted projection the underlying carries survives
    /// intact, so the result type is the one a `T` receiver would get
    /// (§5b). That is the whole mechanism: nothing downstream needs a
    /// `PlatformTypeSymbol` arm, which is exactly the point — the closed
    /// switch in `MemberLookup.GetImportedTypeSymbol` would otherwise
    /// fall through to the erased answer at each of its call sites and turn
    /// `Queue[Entry]!.Dequeue()` from `Entry` into a CLR erasure.
    ///
    /// Guarded accesses are deliberately NOT routed here: `?.` and
    /// `?[` unwrap their own receiver on the branch where it is already
    /// known non-nil, so no coercion to non-null occurs and §4 inserts
    /// nothing.
    /// @param receiver The bound receiver, possibly `null` for a static access.
    /// @param location The access site, for the check's message.
    /// @returns The checked receiver, or the original when it is not platform-typed.
    private func CheckPlatformReceiver(
        receiver BoundExpression?,
        location TextLocation
    ) BoundExpression? -> if receiver == nil {
        default(BoundExpression?)
    } else {
        PlatformCoercion.InsertCheck(receiver, location, "a member access receiver")
    }

    private func BindAccessorStepAfterPlatformReceiverCheck(
        receiver BoundExpression?,
        classSymbol ImportedClassSymbol?,
        rightPart ExpressionSyntax,
        receiverSyntax ExpressionSyntax? = nil,
        receiverStart int32? = nil
    ) BoundExpression -> if receiver != nil &&
        ((receiver is BoundMethodGroupExpression or BoundClrMethodGroupExpression)) &&
        !MethodGroupDiagnostics
        .HasDelegateTarget(receiver) {
        cast[BoundExpression](
            MethodGroupDiagnostics.ReportRequiresTarget(
                Diagnostics,
                receiver,
                receiverSyntax?.Location ?? rightPart.Location
            )
        )
    } else {
        (
            if receiver != nil && receiver.Type == TypeSymbol.Error {
                Diagnostics.SuppressMemberLookupCascadeIn(
                    () -> BindAccessorStepCore(receiver, classSymbol, rightPart, receiverSyntax, receiverStart)
                )
            } else {
                BindAccessorStepCore(receiver, classSymbol, rightPart, receiverSyntax, receiverStart)
            }
        )
    }

    private func BindAccessorStepCore(
        receiver BoundExpression?,
        classSymbol ImportedClassSymbol?,
        rightPart ExpressionSyntax,
        receiverSyntax ExpressionSyntax? = nil,
        receiverStart int32? = nil
    ) BoundExpression {
        switch rightPart {
            case unary is UnaryExpressionSyntax when unary.OperatorToken.Kind == SyntaxKind.BangBangToken {
                let assertedOperand = BindAccessorStep(receiver, classSymbol, unary.Operand)
                if assertedOperand is BoundErrorExpression {
                    return assertedOperand
                }
                ReportNullAssertionIfRedundant(unary.OperatorToken, assertedOperand)
                // ADR-0186 §6: this is the SECOND path that binds a user
                // `!!` — the accessor-chain one, for `a.b!!`. It must produce
                // the same node the top-level path does, message included:
                // the check fires either way, but without this the two
                // spellings of one assertion give different exception text,
                // which is failure mode 1's read/call drift in miniature.
                if assertedOperand.Type is PlatformTypeSymbol {
                    return PlatformCoercion.InsertCheck(
                        assertedOperand,
                        unary.OperatorToken.Location,
                        "an explicit '!!'",
                        suppressible: false
                    )
                }
                let assertionOperator BoundUnaryOperator? = BoundUnaryOperator.Bind(
                    unary.OperatorToken.Kind,
                    assertedOperand.Type
                )
                if assertionOperator == nil {
                    Diagnostics.ReportUndefinedUnaryOperator(
                        unary.OperatorToken.Location,
                        unary.OperatorToken.Text,
                        assertedOperand.Type
                    )
                    return BoundErrorExpression(nil)
                }
                return BoundUnaryExpression(nil, assertionOperator, assertedOperand, binderCtx.IsCheckedContext)
            }
            case nested is AccessorExpressionSyntax {
                // Issue #672: when the LHS is a CLR type symbol, check whether
                // the left segment of the nested accessor names a nested type
                // (e.g. `Environment.SpecialFolder.ApplicationData` — here
                // `SpecialFolder` is a nested enum inside `Environment`). If so,
                // create a new ImportedClassSymbol for the nested type and bind
                // the right segment against it, enabling chained static/enum
                // member access on nested types.
                if classSymbol != nil &&
                    TryResolveNestedTypeFromAccessorLeft(classSymbol, nested.LeftPart, out var nestedClassSymbol) {
                    if nested.IsNullConditional {
                        // Null-conditional on a type is semantically meaningless
                        // but fall through to avoid a crash.
                        return BoundErrorExpression(nil)
                    }
                    return BindAccessorStep(nil, nestedClassSymbol, nested.RightPart)
                }
                let head = BindAccessorStep(receiver, classSymbol, nested.LeftPart)
                if head is BoundErrorExpression {
                    return head
                }
                // Issue #507 follow-up: ParseNameOrCallExpression folds the
                // right-hand side of an accessor through ParsePostfixChain, so
                // `a.b?.c` parses as `AccessorExpression(a, ., AccessorExpression(b, ?., c))`.
                // The nested accessor's `?.` token must be honored here, or the
                // read/write degenerates into a plain `.c` against `b`'s nullable
                // type and reports "Cannot find member c".
                if nested.IsNullConditional {
                    return BindNullConditionalAccessExpressionCore(head, nested.RightPart)
                }
                let fullReceiverStart = receiverStart ?? receiverSyntax?.Span.Start ?? nested.LeftPart.Span.Start
                return BindAccessorStep(head, nil, nested.RightPart, nested.LeftPart, fullReceiverStart)
            }
            case ce is CallExpressionSyntax {
                // Issue #3084: bind tuple fields symbolically when their CLR
                // projection cannot expose the stored function as a delegate.
                // Issue #3649 extends this to calls through a DECLARED element
                // name (`t.f(10)`), which has no CLR-visible member to fall
                // back to regardless of the element's projected field type.
                if ce.NullableQuestionToken == nil &&
                    receiver?.Type is TupleTypeSymbol tupleType &&
                    TryGetTupleElementIndex(ce.Identifier.ValueText, tupleType, out var tupleIndex) &&
                    (
                    RequiresSymbolicTupleElementInvocation(tupleType, tupleIndex) ||
                        RequiresDeclaredNameTupleElementInvocation(ce.Identifier.ValueText, tupleType, tupleIndex)
                ) {
                    let tupleElement = BoundTupleElementAccessExpression(nil, receiver!!, tupleType, tupleIndex)
                    return overloads.BindIndirectCallExpression(
                        ce,
                        tupleElement,
                        ce.Identifier.ValueText,
                        ce.Identifier.Location,
                        nullSafeInvocation: "?(...)"
                    )
                }
                let callResult = BindAccessorCall(receiver, classSymbol, ce, receiverSyntax, receiverStart)
                CheckValueTaskGetAwaiterGetResult(callResult, ce)
                return callResult
            }
            case objCreate is ObjectCreationExpressionSyntax {
                if objCreate.Target is not CallExpressionSyntax innerCall {
                    return BoundErrorExpression(nil)
                }
                let ctorResult = BindAccessorCall(receiver, classSymbol, innerCall)
                if ctorResult is BoundErrorExpression {
                    return ctorResult
                }
                return BindObjectInitializerSuffix(objCreate, ctorResult)
            }
            case CollectionInitializerExpressionSyntax{Target: {} collectionTarget} collection {
                let collectionReceiver = BindAccessorStep(
                    receiver,
                    classSymbol,
                    collectionTarget,
                    receiverSyntax,
                    receiverStart
                )
                return BindCollectionInitializerSuffix(collection, collectionReceiver)
            }
            case ix is IndexExpressionSyntax {
                let indexTarget = BindAccessorStep(receiver, classSymbol, ix.Target)
                if indexTarget is BoundErrorExpression {
                    return indexTarget
                }
                if ix.IsNullConditional {
                    return BindNullConditionalIndexFromBoundTarget(indexTarget, ix)
                }
                return if ix.Indices.Count > 1 || IsRectangularArrayType(indexTarget.Type) {
                    BindRectangularIndexAgainstTarget(indexTarget, ix.Indices, ix.Target.Location)
                } else {
                    BindIndexAgainstTarget(indexTarget, ix.Index, ix.Target.Location)
                }
            }
            case ne is NameExpressionSyntax {
                if ne.IdentifierToken.IsMissing {
                    // Incomplete member access such as `x.` with no member name yet.
                    // The parser already reported the missing identifier; binding a
                    // null member name would throw (e.g. Type.GetProperty(null)), so
                    // bail out gracefully. This keeps completion / semantic tokens
                    // working while the user is mid-typing.
                    return BoundErrorExpression(nil)
                }
                if classSymbol != nil {
                    let foundMember = classSymbol.TryLookupMember(
                        ne.IdentifierToken.ValueText,
                        ne,
                        out var staticMember
                    )
                    if !foundMember || staticMember == nil {
                        // Issue #337: a static member name that resolves to a
                        // method (not a field/property) is a method group. In a
                        // delegate-conversion context it materializes as a
                        // delegate over the selected overload; the conversion
                        // classifier decides which overload (if any) applies.
                        let staticMethods = classSymbol.GetStaticMethodGroup(ne.IdentifierToken.ValueText)
                        if !staticMethods.IsEmpty {
                            return BoundClrMethodGroupExpression(
                                nil,
                                receiver: nil,
                                classSymbol.ClassType,
                                ne.IdentifierToken.ValueText,
                                staticMethods
                            )
                        }
                        return BindExtensionMethodGroupOrError(receiver, ne)
                    }
                    // Lookup admits a property when either accessor is
                    // visible, but a read calls the getter: it must be the
                    // visible one (`protected static P { private get; set; }`
                    // is writable from a derived class, not readable).
                    if staticMember is PropertyInfo readProperty &&
                        !TryRequireVisibleStaticGetter(classSymbol, readProperty, ne.IdentifierToken.Location) {
                        return BoundErrorExpression(nil)
                    }
                    var staticType = switch staticMember {
                        case sp is PropertyInfo: ClrNullability.GetPropertyTypeSymbol(sp)
                        case sf is FieldInfo: ClrNullability.GetFieldTypeSymbol(sf)
                        default: TypeSymbol.Error
                    }
                    staticType = NormalizeImportedSemanticAggregate(staticType, staticMember)
                    // Issue #1330: when the receiver is a generic type
                    // constructed over an in-scope generic type parameter
                    // (`Comparer[TResult].Default`), the closed CLR member type
                    // is type-erased (`Comparer<object>`). Recover the symbolic
                    // member type (`Comparer[TResult]`) by substituting the
                    // receiver's symbolic arguments through the open member, and
                    // carry the symbolic container so the emitter parents the
                    // static read at the constructed `Comparer<!TResult>`
                    // TypeSpec rather than the erased `Comparer<object>`.
                    if classSymbol.SymbolicReceiver != nil {
                        let symbolicMemberType TypeSymbol? = ResolveStaticMemberTypeFromSymbolicReceiver(
                            classSymbol.SymbolicReceiver,
                            staticMember
                        )
                        if symbolicMemberType != nil {
                            staticType = symbolicMemberType
                        }
                        if staticMember is FieldInfo symbolicLiteral && symbolicLiteral.IsLiteral {
                            let literalType = if classSymbol.ClassType.IsEnum {
                                cast[TypeSymbol](classSymbol.SymbolicReceiver!!)
                            } else {
                                staticType
                            }
                            return BoundLiteralExpression(nil, symbolicLiteral.GetRawConstantValue(), literalType)
                        }
                        return BoundClrPropertyAccessExpression(
                            nil,
                            nil,
                            staticMember,
                            staticType,
                            classSymbol.SymbolicReceiver
                        )
                    }
                    // Literal (const) fields aren't real runtime fields, so
                    // inline their constant value rather than emit `ldsfld`.
                    if staticMember is FieldInfo literal && literal.IsLiteral {
                        return BoundLiteralExpression(nil, literal.GetRawConstantValue(), staticType)
                    }
                    return BoundClrPropertyAccessExpression(nil, nil, staticMember, staticType)
                } else if receiver != nil && TryGetUserInstanceMemberReceiverType(receiver, out var structSym) {
                    // ADR-0112 A3: this-first base-chain instance field walk via
                    // the canonical member-resolution layer, surfacing the
                    // declaring struct so the emitted field token names the right owner.
                    let hasProperty = TypeMemberModel.TryGetProperty(
                        structSym!!,
                        ne.IdentifierToken.ValueText,
                        out var nearestProperty,
                        out var nearestPropertyDeclaringType
                    )
                    let hasField = TypeMemberModel.TryGetFieldIncludingInherited(
                        structSym!!,
                        ne.IdentifierToken.ValueText,
                        MemberQuery.Instance(MemberKinds.Field),
                        out var field,
                        out var declaringType
                    )
                    if hasField &&
                        (
                        !hasProperty ||
                            IsFieldAtLeastAsNearAsProperty(
                            structSym!!,
                            Invariant.Required(
                                declaringType,
                                "a resolved field has a declaring type",
                                expression: "declaringType"
                            ),
                            Invariant.Required(
                                nearestProperty,
                                "a resolved property has a symbol",
                                expression: "nearestProperty"
                            ),
                            Invariant.Required(
                                nearestPropertyDeclaringType,
                                "a resolved property has a declaring type",
                                expression: "nearestPropertyDeclaringType"
                            )
                        )
                    ) {
                        field = Invariant.Required(field, "a resolved field has a symbol", expression: "field")
                        declaringType = Invariant.Required(
                            declaringType,
                            "a resolved field has a declaring type",
                            expression: "declaringType"
                        )
                        // Issue #186 / #175: dotted field read fires
                        // GS0204 if the field carries `@Obsolete`.
                        reportObsoleteUseIfApplicable(
                            ne.IdentifierToken.Location,
                            field,
                            "${declaringType.Name}.${field.Name}"
                        )
                        // Issue #950 / #2044: enforce `protected`/`private` field
                        // access — only the declaring type (and, for
                        // `protected`, its derived types) may read it.
                        if !AccessibilityChecker.IsAccessible(field.Accessibility, declaringType, this.function) {
                            Diagnostics.ReportMemberInaccessible(
                                ne.IdentifierToken.Location,
                                field.Name,
                                declaringType.Name,
                                field.Accessibility
                            )
                        }
                        // ADR-0122 §10 / issue #1035: a fixed-size buffer field
                        // decays to a `*T` to the first element. Lower
                        // `recv.buf` to a reinterpret of `&recv.buf` (the
                        // address of the inline backing struct, whose first
                        // element sits at offset 0) to the element pointer
                        // type. Indexing / passing then flows through the
                        // existing unmanaged-pointer machinery.
                        if field.IsFixedBuffer {
                            return MakeFixedBufferPointer(receiver, declaringType, field)
                        }
                        return ApplyMemberNarrowing(BoundFieldAccessExpression(nil, receiver, declaringType, field))
                    }
                    // ADR-0051: check properties before reporting "unable to find member".
                    if hasProperty {
                        let prop = Invariant.Required(
                            nearestProperty,
                            "a resolved property has a symbol",
                            expression: "nearestProperty"
                        )
                        var propDeclaringType = nearestPropertyDeclaringType
                        if !prop.HasGetter {
                            Diagnostics.ReportCannotAssign(ne.Location, ne.IdentifierToken.ValueText)
                            return BoundErrorExpression(nil)
                        }
                        // Issue #950 / #2044: enforce `protected`/`private`
                        // property access.
                        propDeclaringType = Invariant.Required(
                            propDeclaringType,
                            "a user-defined struct property has a declaring type",
                            expression: "propDeclaringType"
                        )
                        if !AccessibilityChecker.IsAccessible(
                            prop.GetterAccessibility,
                            propDeclaringType,
                            this.function
                        ) {
                            Diagnostics.ReportMemberInaccessible(
                                ne.IdentifierToken.Location,
                                prop.Name,
                                propDeclaringType.Name,
                                prop.GetterAccessibility
                            )
                        }
                        return ApplyMemberNarrowing(BoundPropertyAccessExpression(nil, receiver, structSym, prop))
                    }
                    // Issue #1213 / #1221: an `event` member referenced in
                    // expression position (e.g. `this.MyEvent?.Invoke(args)`)
                    // binds to its backing delegate field, mirroring how C#
                    // compiles a raise of a field-like event to a read of the
                    // backing field. Issue #1213 enabled this for an event
                    // declared on the receiver type; issue #1221 walks the base
                    // chain so an event inherited from a base class can be raised
                    // from a derived type — the field access targets the base
                    // type that declares the (now `family`/protected) backing
                    // field. Restricted to access from inside the declaring type
                    // or a derived type (`IsWithinType`); cross-type reads
                    // continue to fall through to the existing member-lookup
                    // diagnostics so the `+=`/`-=` subscription path is
                    // unaffected.
                    if IsWithinType(structSym) {
                        for evtDeclType in structSym!!.GetHierarchy() {
                            let evt EventSymbol? = evtDeclType.Events.FirstOrDefault(
                                (e EventSymbol) -> e.Name == ne
                                    .IdentifierToken
                                    .ValueText &&
                                    e.IsFieldLike &&
                                    e.BackingField != nil
                            )
                            if evt != nil {
                                return ApplyMemberNarrowing(
                                    BoundFieldAccessExpression(nil, receiver, evtDeclType, evt.BackingField!!)
                                )
                            }
                        }
                    }
                    // Issue #296 / #1582: a GSharp class inheriting an imported
                    // CLR base (directly or through user classes) exposes the
                    // base's instance properties/fields — including inherited
                    // `protected` / `protected internal` members. Resolve the
                    // inherited CLR base type by walking the user base chain,
                    // then reflect the member (reflection walks the CLR chain).
                    if GetInheritedClrBaseType(structSym!!) is Type inheritedBaseClr {
                        let memberName = ne.IdentifierToken.ValueText
                        let clrProp PropertyInfo? = ClrTypeUtilities.SafeGetInheritedInstanceProperty(
                            inheritedBaseClr,
                            memberName,
                            CanAccessInternalsOf
                        )
                        if clrProp != nil && GetVisibleGetter(clrProp, fromDerivedType: true) != nil {
                            return BoundClrPropertyAccessExpression(
                                nil,
                                receiver,
                                clrProp,
                                GetInheritedClrMemberType(receiver.Type, clrProp)
                            )
                        }
                        let clrFld FieldInfo? = ClrTypeUtilities.SafeGetInheritedInstanceField(
                            inheritedBaseClr,
                            memberName,
                            CanAccessInternalsOf
                        )
                        if clrFld != nil {
                            return BoundClrPropertyAccessExpression(
                                nil,
                                receiver,
                                clrFld,
                                GetInheritedClrMemberType(receiver.Type, clrFld)
                            )
                        }
                    }
                    // ADR-0112: an instance method named here in non-call position
                    // is a method group captured against the bound receiver. The
                    // conversion classifier selects the overload (if any) from the
                    // target delegate signature; the emitter binds the delegate's
                    // Target to this receiver (boxing value-type receivers).
                    let instanceMethods = TypeMemberModel.GetMethods(
                        structSym!!,
                        ne.IdentifierToken.ValueText,
                        MemberQuery.Instance(MemberKinds.Method)
                    )
                    if TryBuildUserMethodGroup(receiver, instanceMethods, out var instanceUserGroup) {
                        return instanceUserGroup!!
                    }
                    // Issue #1136: an inherited System.Object instance member
                    // (GetType/ToString/GetHashCode/Equals) named in method-group
                    // position. When the user type declares no explicit imported
                    // base, fall back to typeof(object) so the member is captured
                    // as a CLR method group resolvable against a target delegate.
                    let inheritedMgClr = structSym!!.ImportedBaseType?.ClrType ?? typeof(object)
                    if TryBindClrMethodGroup(
                        receiver,
                        inheritedMgClr,
                        wantStatic: false,
                        ne.IdentifierToken.ValueText,
                        out var inheritedClrGroup
                    ) {
                        return inheritedClrGroup!!
                    }
                    return BindExtensionMethodGroupOrError(receiver, ne)
                } else if receiver != nil && receiver.Type is EnumSymbol {
                    // Issue #1218: an inherited System.Enum / ValueType / Object
                    // instance member (HasFlag/ToString/GetHashCode/Equals/GetType)
                    // named in method-group position on an enum value. Capture it
                    // as a CLR method group over typeof(System.Enum) so it resolves
                    // against a target delegate signature; the emitter boxes the
                    // value-type receiver into the delegate Target.
                    if TryBindClrMethodGroup(
                        receiver,
                        typeof(Enum),
                        wantStatic: false,
                        ne.IdentifierToken.ValueText,
                        out var enumClrGroup
                    ) {
                        return enumClrGroup!!
                    }
                    return BindExtensionMethodGroupOrError(receiver, ne)
                } else if receiver != nil && receiver.Type is InterfaceSymbol ifaceSym {
                    // Issue #1068: read a property declared on the static
                    // interface type (or any base interface) through an
                    // interface-typed receiver. Interface methods already
                    // dispatch via the InterfaceSymbol path in
                    // ExpressionBinder.Calls.cs; this mirrors that for
                    // properties so `b.H` (b : IBase) resolves the abstract
                    // accessor and emits a verifiable `callvirt get_H`.
                    // Inherited base-interface members are surfaced because
                    // TypeMemberModel.TryGetProperty walks SelfAndAllBaseInterfaces.
                    if this.BindSourceInterfacePropertyAccess(ifaceSym, receiver, ne) is {} propertyAccess {
                        return propertyAccess
                    }
                    // Issue #1397: an instance method declared on the static
                    // interface type (or any user base interface) named in
                    // method-group position is captured against the bound
                    // receiver, mirroring the class-receiver path above. The
                    // emitter dispatches via `ldvirtftn` so the delegate invokes
                    // the concrete implementation through interface dispatch.
                    // TypeMemberModel.GetMethods walks SelfAndAllBaseInterfaces
                    // so an inherited base-interface method binds too.
                    let ifaceInstanceMethods = TypeMemberModel.GetMethods(
                        ifaceSym,
                        ne.IdentifierToken.ValueText,
                        MemberQuery.Instance(MemberKinds.Method)
                    )
                    if TryBuildUserMethodGroup(receiver, ifaceInstanceMethods, out var ifaceUserGroup) {
                        return ifaceUserGroup!!
                    }
                    // Issue #1181: a user interface that extends an imported/BCL
                    // interface (e.g. `interface IBox : ICollection`) inherits
                    // that interface's properties/fields/methods. Mirror the
                    // imported-base-class fallback above by probing the
                    // transitive imported base interfaces so `b.Count`
                    // (b : IBox) resolves and emits a verifiable
                    // `callvirt get_Count`. The receiver carries an
                    // InterfaceImpl row to each imported base interface, so a
                    // CLR member access on it is verifiable.
                    let ifaceMemberName = ne.IdentifierToken.ValueText
                    for clrBaseIface in MemberLookup.GetTransitiveClrBaseInterfaces(ifaceSym) {
                        let clrProp PropertyInfo? = ClrTypeUtilities.SafeGetProperty(
                            clrBaseIface,
                            ifaceMemberName,
                            BindingFlags.Public | BindingFlags.Instance
                        )
                        if clrProp != nil && clrProp.GetIndexParameters().Length == 0 && clrProp.CanRead {
                            return BoundClrPropertyAccessExpression(
                                nil,
                                receiver,
                                clrProp,
                                GetInheritedClrMemberType(receiver.Type, clrProp)
                            )
                        }
                        let clrFld FieldInfo? = ClrTypeUtilities.SafeGetField(
                            clrBaseIface,
                            ifaceMemberName,
                            BindingFlags.Public | BindingFlags.Instance
                        )
                        if clrFld != nil {
                            return BoundClrPropertyAccessExpression(
                                nil,
                                receiver,
                                clrFld,
                                GetInheritedClrMemberType(receiver.Type, clrFld)
                            )
                        }
                    }
                    // Issue #1181: an inherited imported-base-interface method
                    // named in method-group position (e.g. `b.Dispose` passed
                    // to a delegate) is captured against the bound receiver.
                    for clrBaseIface in MemberLookup.GetTransitiveClrBaseInterfaces(ifaceSym) {
                        if TryBindClrMethodGroup(
                            receiver,
                            clrBaseIface,
                            wantStatic: false,
                            ifaceMemberName,
                            out var ifaceClrGroup
                        ) {
                            return ifaceClrGroup!!
                        }
                    }
                    return BindExtensionMethodGroupOrError(receiver, ne)
                } else if receiver != nil && receiver.Type is TupleTypeSymbol tupleSym {
                    // Phase 4.5 / issue #2924: tuple element access via
                    // one-based Item1..ItemN or zero-based .0...N selectors.
                    let memberName = ne.IdentifierToken.ValueText
                    if TryGetTupleElementIndex(memberName, tupleSym, out var zeroBased) {
                        return BoundTupleElementAccessExpression(nil, receiver, tupleSym, zeroBased)
                    }
                    return BindExtensionMethodGroupOrError(receiver, ne)
                } else if receiver != nil && TryBindNullableInstanceMember(receiver, ne, out var nullableMember) {
                    return nullableMember!!
                } else if TryGetClrInstanceMemberReceiverType(receiver, out var clrInstanceReceiverType) {
                    // Phase 4 exit: read a public instance property or field on
                    // a CLR receiver (e.g. `lst.Count`, `sb.Length`,
                    // `kvp.Key`). Static members are reached through
                    // ImportedClassSymbol; this path covers instances. A
                    // receiver stated `T?` — source-declared, annotated
                    // imported metadata, or a nullable type argument — never
                    // reaches this arm and requires narrowing, `!!` or `?.`
                    // (see CanBindClrInstanceMember, #4356). An oblivious
                    // imported result arrives as a platform type `T!` under
                    // the default mode (ADR-0186), is checked and unwrapped by
                    // CheckPlatformReceiver before this dispatch, and reaches
                    // it as plain `T`. Issue #3311: an open-generic
                    // `map[K, V]` receiver (null ClrType) is normalized to its
                    // symbolic Dictionary view so `.Keys`/`.Count`/… resolve
                    // over the erased closed shape with symbolic [K, V]
                    // re-projection, exactly as on `Dictionary[K, V]`.
                    let declaredReceiverType = Invariant.Required(
                        clrInstanceReceiverType.ClrType,
                        "a CLR member receiver has a CLR type",
                        expression: "clrInstanceReceiverType.ClrType"
                    )
                    let memberName = ne.IdentifierToken.ValueText
                    // Issue #4924: the members of the target framework's declaration.
                    if !$scope.References!!.TryGetMemberLookupType(declaredReceiverType, out var clrReceiverType) {
                        Diagnostics.ReportTargetFrameworkMemberUnavailable(
                            ne.Location,
                            (declaredReceiverType.FullName ?? declaredReceiverType.Name) + "." + memberName
                        )
                        return BoundErrorExpression(nil)
                    }
                    // Issue #529: use interface-aware lookup so that members
                    // declared on a base interface (e.g. IReadOnlyCollection<T>.Count
                    // surfaced through IReadOnlyList<T>) are found.
                    // Issue #3705: the read and the write path share one probe
                    // so the friend-`internal` widening cannot drift apart
                    // between them again (#3693 / #3702). The getter gate is
                    // the visible one — a `{ private get; … }` property is not
                    // readable here however the property itself was found.
                    let prop PropertyInfo? = SafeGetVisibleInstanceProperty(clrReceiverType, memberName)
                    if prop != nil && prop.GetIndexParameters().Length == 0 && GetVisibleGetter(prop) != nil {
                        // Issue #504 follow-up: properties with NRT
                        // annotations (e.g. `DirectoryInfo.Parent` is
                        // `DirectoryInfo?`) must surface as
                        // NullableTypeSymbol so callers can compare to
                        // `nil` without GS0129. ByRef-returning properties
                        // are rare on CLR types and stay on the existing
                        // MapClrMemberType path, which preserves the
                        // ByRefTypeSymbol wrapper.
                        // Issue #794: substitute the receiver's symbolic
                        // type arguments back through the property's open
                        // declaring type so e.g. `Dictionary[K, V]().Keys`
                        // surfaces as `ICollection[K]` (a generic shape
                        // containing the in-scope `K`) instead of the
                        // type-erased `ICollection<object>`.
                        var propType = if prop.PropertyType.IsByRef {
                            ClrNullability.GetPropertyTypeSymbol(prop)
                        } else {
                            MemberLookup.GetClrPropertyTypeSymbol(
                                clrInstanceReceiverType,
                                prop,
                                projectOnlyWhenSymbolicallyRequired: true
                            )
                        }
                        propType = NormalizeImportedSemanticAggregate(propType, prop)
                        return ConversionClassifier.AutoDereferenceRefReturn(
                            BoundClrPropertyAccessExpression(nil, receiver!!, prop, propType)
                        )
                    }
                    let fld FieldInfo? = SafeGetVisibleInstanceField(clrReceiverType, memberName)
                    if fld != nil {
                        let fieldType = NormalizeImportedSemanticAggregate(
                            MemberLookup.GetClrFieldTypeSymbol(clrInstanceReceiverType, fld),
                            fld
                        )
                        return BoundClrPropertyAccessExpression(
                            nil,
                            Invariant.Required(
                                receiver,
                                "an instance field lookup has a receiver",
                                expression: "receiver"
                            ),
                            fld,
                            fieldType
                        )
                    }
                    // Issue #337: an instance member name that resolves to a
                    // method (not a field/property) is a method group bound to
                    // this receiver. In a delegate-conversion context it captures
                    // the receiver as the delegate target over the selected
                    // overload.
                    if TryBindClrMethodGroup(
                        Invariant.Required(
                            receiver,
                            "an instance member lookup has a receiver",
                            expression: "receiver"
                        ),
                        clrReceiverType,
                        wantStatic: false,
                        memberName,
                        out var instanceGroup
                    ) {
                        return instanceGroup!!
                    }
                    return BindExtensionMethodGroupOrError(receiver, ne)
                } else if receiver != nil &&
                    (receiver.Type is SliceTypeSymbol or ArrayTypeSymbol or RectangularArrayTypeSymbol) &&
                    receiver
                    .Type
                    .ClrType == nil {
                    // Issue #1162: a slice/array whose element is a
                    // same-compilation user type has a null backing
                    // ClrType during binding, so the CLR-property arm
                    // above (gated on `receiver.Type.ClrType != null`)
                    // cannot reflect `System.Array` members such as
                    // `.Length`/`.Rank`/`.LongLength`. The runtime
                    // receiver is the real `T[]`, which derives from
                    // `System.Array`, so reflect the member directly
                    // against `typeof(System.Array)` and bind it as an
                    // ordinary CLR property read; the IL is correct
                    // because the array genuinely exposes the member.
                    let arrayMemberName = ne.IdentifierToken.ValueText
                    let arrayProp PropertyInfo? = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(
                        typeof(Array),
                        arrayMemberName,
                        BindingFlags.Public | BindingFlags.Instance
                    )
                    if arrayProp != nil && arrayProp.GetIndexParameters().Length == 0 && arrayProp.CanRead {
                        return BoundClrPropertyAccessExpression(
                            nil,
                            receiver,
                            arrayProp,
                            ClrNullability.GetPropertyTypeSymbol(arrayProp)
                        )
                    }
                    if TryBindClrMethodGroup(
                        receiver,
                        typeof(Array),
                        wantStatic: false,
                        arrayMemberName,
                        out var arrayMethodGroup
                    ) {
                        return arrayMethodGroup!!
                    }
                    return BindExtensionMethodGroupOrError(receiver, ne)
                } else if receiver != nil && receiver.Type is TypeParameterSymbol tpRecv {
                    // Issue #1235: a value whose static type is a type parameter
                    // constrained to a class (or interface) exposes that
                    // constraint's FULL instance member surface — fields and
                    // properties, not only methods (instance method calls are
                    // resolved through the constraint in ExpressionBinder.Calls).
                    // Field reads lower to a `box !!T; ldfld` against the
                    // constraint class; property reads dispatch through a
                    // verifiable `box !!T; callvirt get_X` (see the emitter).
                    let tpMember BoundExpression? = BindTypeParameterInstanceMemberAccess(tpRecv, receiver, ne)
                    if tpMember != nil {
                        return tpMember
                    }
                    return BindExtensionMethodGroupOrError(receiver, ne)
                } else {
                    return BindExtensionMethodGroupOrError(receiver, ne)
                }
            }
            default {
                return BoundErrorExpression(nil)
            }
        }
    }

    private func TryBindNullableInstanceMember(
        receiver BoundExpression,
        name NameExpressionSyntax,
        @NotNullWhen(true) out member BoundExpression?
    ) bool {
        member = nil
        if receiver.Type is not NullableTypeSymbol nullableType {
            return false
        }
        let memberName = name.IdentifierToken.ValueText
        let nullableInnerClr = nullableType.UnderlyingType?.ClrType
        if nullableInnerClr?.IsValueType == true && this.memberLookup.TryGetNullableConstructedType(
            nullableInnerClr!!,
            out var nullableClr
        ) {
            let nullableProperty PropertyInfo? = ClrTypeUtilities.SafeGetProperty(
                nullableClr!!,
                memberName,
                BindingFlags.Public | BindingFlags.Instance
            )
            if nullableProperty != nil && nullableProperty.GetIndexParameters()
                .Length == 0 &&
                nullableProperty
                .CanRead {
                member = BoundClrPropertyAccessExpression(
                    nil,
                    receiver,
                    nullableProperty,
                    ClrNullability.GetPropertyTypeSymbol(nullableProperty)
                )
                return true
            }
            if TryBindClrMethodGroup(receiver, nullableClr, wantStatic: false, memberName, out var nullableGroup) {
                member = nullableGroup
                return true
            }
            member = BindExtensionMethodGroupOrError(receiver, name)
            return true
        }
        let openTypeParameter = nullableType.UnderlyingType as TypeParameterSymbol
        // Issue #4986: a user value-kind struct or enum has no ClrType while
        // binding either. Admit only its properties here: open method groups
        // do not yet emit a constructed `Nullable<T>` method reference.
        if openTypeParameter?.HasValueTypeConstraint != true &&
            (
            !NullableLifting.IsUserValueTypeNullable(nullableType) ||
                (memberName != "Value" && memberName != "HasValue")
        ) {
            return false
        }
        let openNullable = typeof(System.Nullable[_])
        let openProperty PropertyInfo? = ClrTypeUtilities.SafeGetProperty(
            openNullable,
            memberName,
            BindingFlags.Public | BindingFlags.Instance
        )
        if openProperty != nil && openProperty.GetIndexParameters().Length == 0 && openProperty.CanRead {
            let propertyType = if openProperty.PropertyType.IsGenericParameter {
                nullableType.UnderlyingType
            } else {
                ClrNullability.GetPropertyTypeSymbol(openProperty)
            }
            member = BoundClrPropertyAccessExpression(nil, receiver, openProperty, propertyType)
            return true
        }
        if TryBindClrMethodGroup(receiver, openNullable, wantStatic: false, memberName, out var openNullableGroup) {
            member = openNullableGroup
            return true
        }
        member = BindExtensionMethodGroupOrError(receiver, name)
        return true
    }

    /// Issue #2452: binds a receiver-style extension method reference used as a
    /// value (`receiver.Extension`) after ordinary fields, properties, and
    /// instance methods have all failed lookup. Calls already resolve extensions
    /// through the overload resolver; method-group lookup must use the same
    /// symbol tables instead of treating the name as a missing property.
    private func BindExtensionMethodGroupOrError(receiver BoundExpression?, name NameExpressionSyntax) BoundExpression {
        if receiver is BoundErrorExpression {
            return receiver
        }
        if receiver != nil {
            let userCandidates = $scope.TryLookupExtensionFunctions(receiver.Type, name.IdentifierToken.ValueText)
            if !userCandidates.IsDefaultOrEmpty {
                if userCandidates.Length == 1 &&
                    userCandidates[0] is {IsExtension: true, TypeParameters: {IsDefaultOrEmpty: true}} single &&
                    single
                    .Parameters
                    .Length > 0 {
                    let parameterTypes = ImmutableArray.CreateBuilder[TypeSymbol](single.Parameters.Length - 1)
                    for var i = 1; i < single.Parameters.Length; i++ {
                        parameterTypes.Add(single.Parameters[i].Type)
                    }
                    let functionType = FunctionTypeSymbol.Get(
                        parameterTypes.MoveToImmutable(),
                        single.Type ?? TypeSymbol.Void
                    )
                    return BoundMethodGroupExpression(name, receiver, single, functionType)
                }
                return BoundMethodGroupExpression(name, receiver, userCandidates)
            }
            let importedCandidates = this.memberLookup.CollectImportedExtensionMethods(name.IdentifierToken.ValueText)
            if importedCandidates.Count > 0 {
                return BoundClrMethodGroupExpression(
                    name,
                    receiver,
                    declaringType: nil,
                    name.IdentifierToken.ValueText,
                    importedCandidates.ToImmutableArray()
                )
            }
        }
        Diagnostics.ReportUnableToFindMember(name.Location, name.IdentifierToken.ValueText)
        return BoundErrorExpression(nil)
    }

    /// Issue #672: resolves a nested CLR type from the left part of an
    /// accessor expression when the enclosing type is already known (i.e.
    /// [`classSymbol`](paramref) is non-null). Supports single-level
    /// nesting (left part is a (cref:NameExpressionSyntax)) and
    /// multi-level nesting (left part is an (cref:AccessorExpressionSyntax)
    /// whose segments form a chain of nested types).
    private func TryResolveNestedTypeFromAccessorLeft(
        classSymbol ImportedClassSymbol,
        leftPart ExpressionSyntax,
        @NotNullWhen(true) out nestedClassSymbol ImportedClassSymbol?
    ) bool {
        nestedClassSymbol = nil
        if leftPart is NameExpressionSyntax nameExpr {
            let name = nameExpr.IdentifierToken.ValueText
            // Only resolve as a nested type when the name is NOT a static
            // field/property or method group — those take precedence.
            if classSymbol.TryLookupMember(name, nameExpr, out _) {
                return false
            }
            if !classSymbol.GetStaticMethodGroup(name).IsEmpty {
                return false
            }
            if $scope.References!!.TryResolveNestedType(classSymbol.ClassType, name, out var nestedType) {
                let nested = ImportedClassSymbol(nestedType!!, nameExpr, references: $scope.References)
                nestedClassSymbol = CloseImportedNestedType(
                    classSymbol.ClassType,
                    nested,
                    nameExpr,
                    classSymbol.SymbolicReceiver,
                    classSymbol.ConstructedReceiver
                )
                return true
            }
            return false
        }
        if leftPart is AccessorExpressionSyntax accessor {
            // Multi-level nesting: recursively resolve the left side first,
            // then resolve the right side as a nested type of that.
            if !TryResolveNestedTypeFromAccessorLeft(classSymbol, accessor.LeftPart, out var intermediateSymbol) {
                return false
            }
            if accessor.RightPart is NameExpressionSyntax innerName {
                let innerNameText = innerName.IdentifierToken.ValueText
                if $scope.References!!.TryResolveNestedType(
                    intermediateSymbol!!.ClassType,
                    innerNameText,
                    out var deepNested
                ) {
                    let nested = ImportedClassSymbol(deepNested!!, innerName, references: $scope.References)
                    nestedClassSymbol = CloseImportedNestedType(
                        intermediateSymbol!!.ClassType,
                        nested,
                        innerName,
                        intermediateSymbol!!.SymbolicReceiver,
                        intermediateSymbol!!.ConstructedReceiver
                    )
                    return true
                }
            }
            return false
        }
        return false
    }

    private func BindIndexExpression(syntax IndexExpressionSyntax) BoundExpression {
        if syntax.IsNullConditional {
            // ADR-0073 / issue #710: `a?[i]` evaluates `a` once; if nil, the
            // whole expression is nil (without touching the indexer or the
            // index operand). Otherwise it indexes the captured value once.
            return BindNullConditionalIndexExpression(syntax)
        }
        let target = BindExpression(syntax.Target)
        if syntax.Indices.Count > 1 || IsRectangularArrayType(target.Type) {
            return BindRectangularIndexAgainstTarget(target, syntax.Indices, syntax.Target.Location)
        }
        return BindIndexAgainstTarget(target, syntax.Index, syntax.Target.Location)
    }

    private func BindRectangularIndexAgainstTarget(
        target BoundExpression,
        indexSyntaxes GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
        targetLocation TextLocation
    ) BoundExpression {
        TrackBackwardGotoIndexUse(target, targetLocation)
        let rectangular RectangularArrayTypeSymbol? = GetRectangularArrayTypeForBinding(target.Type)
        if rectangular == nil && (target.Type is StructSymbol or InterfaceSymbol) {
            // ADR-0187 / issue #4350: a multi-parameter user indexer
            // (`this[index int32, fromEnd bool]`) is read with the same
            // comma-separated index list as a rectangular array.
            let BindAll = func () ImmutableArray[BoundExpression] {
                let bound = ImmutableArray.CreateBuilder[BoundExpression](indexSyntaxes.Count)
                for indexSyntax in indexSyntaxes {
                    bound.Add(BindExpression(indexSyntax))
                }
                return bound.MoveToImmutable()
            }
            if TryResolveUserIndexer(
                target.Type,
                indexSyntaxes.Count,
                BindAll,
                targetLocation,
                out var multiIndexer,
                out var multiSubstitution,
                out var multiArguments,
                out var multiReported,
                out var multiView
            ) {
                return BindUserIndexerRead(
                    ViewIndexerReceiver(target, multiView, targetLocation),
                    multiIndexer!!,
                    multiSubstitution,
                    (i int32, parameterType TypeSymbol) -> if multiArguments.IsDefault {
                        conversions.BindConversion(indexSyntaxes[i], parameterType)
                    } else {
                        conversions.BindConversion(indexSyntaxes[i].Location, multiArguments[i], parameterType)
                    },
                    targetLocation,
                    indexSyntaxes.Count
                )
            }
            if multiReported {
                return BoundErrorExpression(nil)
            }
        }
        if rectangular == nil &&
            (target.Type is ImportedTypeSymbol or StructSymbol or NullabilityAnnotatedTypeSymbol) &&
            target
            .Type
            .ClrType is {} multiClrTarget {
            // Issue #4350: a multi-parameter IMPORTED indexer — the runtime's
            // `Slice<T>.this[int index, bool fromEnd]`, reached through the
            // native `slice[T]` view — resolves through the same CLR indexer
            // overload resolution as a single index.
            let multiClrArguments = ImmutableArray.CreateBuilder[BoundExpression](indexSyntaxes.Count)
            for indexSyntax in indexSyntaxes {
                multiClrArguments.Add(BindExpression(indexSyntax))
            }
            let multiOutcome = this.memberLookup.TryResolveClrIndexer(
                target.Type,
                multiClrTarget,
                multiClrArguments.MoveToImmutable(),
                out var multiClrIndexer,
                out var multiResolvedArguments
            )
            if multiOutcome == ClrIndexerResolutionOutcome.Resolved &&
                multiClrIndexer != nil &&
                ClrMemberVisibility.GetVisibleGetter(
                multiClrIndexer,
                CanAccessInternalsOf(multiClrIndexer.DeclaringType)
            ) != nil {
                let elementType = if target.Type is ImportedTypeSymbol importedTarget {
                    MapErasedIndexerElementType(importedTarget, multiClrIndexer)
                } else {
                    MemberLookup.GetClrPropertyTypeSymbol(target.Type, multiClrIndexer)
                }
                let convertedArguments = BindClrIndexerArguments(
                    target.Type,
                    multiClrIndexer,
                    multiResolvedArguments,
                    targetLocation
                )
                return ConversionClassifier.AutoDereferenceRefReturn(
                    BoundClrIndexExpression(nil, target, multiClrIndexer, convertedArguments, elementType)
                )
            }
            if ReportClrIndexerResolutionFailure(multiOutcome, targetLocation) {
                return BoundErrorExpression(nil)
            }
        }
        if rectangular == nil {
            Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type)
            return BoundErrorExpression(nil)
        }
        if indexSyntaxes.Count != rectangular.Rank {
            Diagnostics.ReportRectangularArrayIndexRankMismatch(targetLocation, rectangular.Rank, indexSyntaxes.Count)
            return BoundErrorExpression(nil)
        }
        let indices = ImmutableArray.CreateBuilder[BoundExpression](indexSyntaxes.Count)
        for indexSyntax in indexSyntaxes {
            indices.Add(BindRectangularArrayElementIndex(indexSyntax))
        }
        return BoundIndexExpression(nil, target, indices.MoveToImmutable(), rectangular.ElementType)
    }

    // ADR-0073 / issue #710: bind `target?[index]`. The receiver is evaluated
    // exactly once into a synthetic capture local; the indexed access is then
    // bound against the capture and wrapped in a
    // BoundNullConditionalAccessExpression so the existing lowering and emit
    // pipeline (which already handles `?.`) covers the new form for free.
    private func BindNullConditionalIndexExpression(syntax IndexExpressionSyntax) BoundExpression {
        let receiver = BindExpression(syntax.Target)
        if receiver is BoundErrorExpression {
            return receiver
        }
        return BindNullConditionalIndexFromBoundTarget(receiver, syntax)
    }

    // ADR-0073 / issue #710: shared core for `?[i]` binding. Splits the
    // already-bound receiver into capture + indexed access so nested
    // accessor-chain entry points (e.g. the `IndexExpressionSyntax` case in
    // BindAccessorStep that handles `a.b?[i]`) can reuse the same logic.
    private func BindNullConditionalIndexFromBoundTarget(
        receiver BoundExpression,
        syntax IndexExpressionSyntax
    ) BoundExpression {
        let receiverType = receiver.Type
        var underlying TypeSymbol
        if receiverType is NullableTypeSymbol nullable {
            underlying = nullable.UnderlyingType
        } else if receiverType is PlatformTypeSymbol platform {
            // ADR-0186 §6: `?[` accepts a `T!` receiver and yields `U?` as
            // usual; GS0300 does NOT fire. The warning says "the null-check is
            // dead code", which is true for a `T` receiver and false for a
            // platform one — it may genuinely be nil. Note this is also the
            // one receiver position that takes no §4 check: the access is
            // guarded, so no coercion to non-null happens at all.
            underlying = platform.UnderlyingType
        } else if receiverType == TypeSymbol.Null {
            // `nil?[i]` is statically nil.
            return BoundLiteralExpression(nil, nil)
        } else {
            // GS0300 (warning): the receiver of `?[...]` is non-nullable, so
            // the null-check is dead code. Suggest the plain `[...]` form.
            Diagnostics.ReportNullConditionalIndexReceiverNotNullable(syntax.OpenBracketToken.Location, receiverType)
            underlying = receiverType
        }
        let captureName = "$$ncap_" + (binderCtx.NullConditionalCaptureCounter += 1).ToString(
            CultureInfo.InvariantCulture
        )
        let capture = LocalVariableSymbol(captureName, isReadOnly: true, type: underlying)
        // Push a temp scope so the capture is in scope while we bind the
        // indexed access against it.
        $scope = BoundScope($scope)
        $scope.TryDeclareVariable(capture)
        let captureRef = BoundVariableExpression(nil, capture)
        let whenNotNull = if syntax.Indices.Count > 1 || IsRectangularArrayType(captureRef.Type) {
            BindRectangularIndexAgainstTarget(captureRef, syntax.Indices, syntax.Target.Location)
        } else {
            BindIndexAgainstTarget(captureRef, syntax.Index, syntax.Target.Location)
        }
        $scope = $scope.Pop()
        if whenNotNull is BoundErrorExpression || whenNotNull.Type == TypeSymbol.Error {
            return BoundErrorExpression(nil)
        }
        let resultType = if whenNotNull.Type is NullableTypeSymbol {
            whenNotNull.Type
        } else {
            cast[TypeSymbol](NullableTypeSymbol.Get(whenNotNull.Type))
        }
        // Issue #1475: allocate the result slot for ANY value-type underlying
        // recognised by symbol (user enum/struct, value-constrained type
        // parameter, tuple), not only when `ClrType.IsValueType`. Mirrors the
        // member-access `?.` path so `?[]` over a user value type also
        // materialises `default(Nullable<T>)` on the nil branch instead of
        // `ldnull`.
        var resultSlot LocalVariableSymbol? = nil
        if resultType is NullableTypeSymbol nullableResult && ReflectionMetadataEmitter.IsValueTypeSymbol(
            nullableResult.UnderlyingType
        ) {
            let resultSlotName = "$$nres_" + binderCtx.NullConditionalCaptureCounter.ToString(
                CultureInfo.InvariantCulture
            )
            resultSlot = LocalVariableSymbol(resultSlotName, isReadOnly: false, type: resultType)
        }
        return BoundNullConditionalAccessExpression(nil, receiver, capture, whenNotNull, resultType, resultSlot)
    }

    private func BindIndexAgainstTarget(
        target BoundExpression,
        indexSyntax ExpressionSyntax,
        targetLocation TextLocation,
        boundIndexOverride BoundExpression? = nil
    ) BoundExpression {
        var target = target
        TrackBackwardGotoIndexUse(target, targetLocation)
        // ADR-0186 §4/§5: an indexer receiver is a receiver. Checked and
        // unwrapped here for the same two reasons `BindAccessorStep` does it
        // — see `CheckPlatformReceiver`. Without the unwrap, indexing a
        // platform receiver reported GS0116 "type 'List[int32]!' is not
        // indexable", which is §5a's failure in its plainest form: the
        // receiver's platform-ness changed what member lookup found.
        target = PlatformCoercion.InsertCheck(target, targetLocation, "an indexer receiver")
        // ADR-0122 / issue #1014: pointer indexing `p[i]` == `*(p + i)`.
        if target.Type is PointerTypeSymbol pointerTarget {
            // ADR-0122 §3 / issue #1033: a `*void` pointer has no element type,
            // so `p[i]` (which lowers to `*(p + i)`) is rejected (GS0403); cast
            // to a typed pointer `*T` first.
            if TypeSymbol.IsVoidPointer(target.Type) {
                Diagnostics.ReportVoidPointerOperationNotAllowed(targetLocation, "index")
                return BoundErrorExpression(nil)
            }
            var pointerIndex = boundIndexOverride ?? BindExpression(indexSyntax)
            if pointerIndex is BoundErrorExpression {
                return pointerIndex
            }
            if !IsPointerOffsetType(pointerIndex.Type) {
                pointerIndex = if boundIndexOverride != nil {
                    conversions.BindConversion(indexSyntax.Location, pointerIndex, TypeSymbol.NInt)
                } else {
                    conversions.BindConversion(indexSyntax, TypeSymbol.NInt)
                }
            }
            let elementPointer = LowerPointerOffset(target, pointerTarget, pointerIndex, subtract: false)
            return BoundDereferenceExpression(nil, elementPointer)
        }
        // Issue #1016: a range operand (`a[lo..hi]`) slices the target rather
        // than indexing a single element.
        if indexSyntax is RangeExpressionSyntax rangeSyntax {
            return BindRangeSlice(target, rangeSyntax, targetLocation)
        }
        if NativeSliceTypes.TryGetElement(target.Type, out _, out _) {
            return BindNativeSliceIndex(target, indexSyntax, boundIndexOverride)
        }
        // Issue #1022: a from-end index (`a[^n]`) reads the single element
        // `length - n`.
        if boundIndexOverride != nil && ClrTypeUtilities.AreSame(boundIndexOverride.Type?.ClrType, typeof(Index)) {
            return BindSystemIndexAccess(target, boundIndexOverride, targetLocation)
        }
        if boundIndexOverride == nil && indexSyntax is FromEndIndexExpressionSyntax fromEndSyntax {
            return BindFromEndIndex(target, fromEndSyntax, targetLocation)
        }
        // Issue #1038: an index whose value is a `System.Range` slices the
        // target (`let r = 1..3; a[r]`, or the inline `a[(1..3)]`), dispatching
        // to the same array/string/span/`this[System.Range]` shapes used by the
        // syntactic `a[1..3]` form. Bind the index once here and reuse the bound
        // expression in the ordinary index paths below to avoid re-binding.
        // `default`/interpolated index syntaxes can never be a range value and
        // keep their dedicated conversion handling, so they are not pre-bound.
        var boundIndex BoundExpression? = boundIndexOverride
        if boundIndex == nil &&
            !(indexSyntax is DefaultExpressionSyntax) &&
            !(indexSyntax is InterpolatedStringExpressionSyntax) {
            boundIndex = BindExpression(indexSyntax)
            if boundIndex is BoundErrorExpression {
                return boundIndex
            }
            if IsSystemRangeType(boundIndex.Type) {
                return BindRangeValueSlice(target, boundIndex, targetLocation)
            }
            if ClrTypeUtilities.AreSame(boundIndex.Type.ClrType, typeof(Index)) {
                return BindSystemIndexAccess(target, boundIndex, targetLocation)
            }
        }
        let ConvertIndex = func (conversionTargetType TypeSymbol) BoundExpression {
            return if boundIndex != nil {
                conversions.BindConversion(indexSyntax.Location, boundIndex, conversionTargetType)
            } else {
                conversions.BindConversion(indexSyntax, conversionTargetType)
            }
        }
        let BoundIndexArg = func () BoundExpression {
            return boundIndex ?? BindExpression(indexSyntax)
        }
        // Phase 3.A.4: map indexing `m[k]` — key bound to K, result type V.
        // The Go convention "zero value if missing" applies at evaluation;
        // the bound representation reuses BoundIndexExpression with the
        // element type set to V.
        if target.Type is MapTypeSymbol mapType {
            let key = ConvertIndex(mapType.KeyType)
            return BoundIndexExpression(nil, target, key, mapType.ValueType)
        }
        let element TypeSymbol? = GetIndexElementType(target.Type)
        if element != nil {
            // Issue #1279: array/slice element access accepts any integer-typed
            // index (matching C#). `boundIndex` is non-null for every non-
            // default/interpolated index; those two carry no natural type and
            // keep the historical int32 conversion driven by the target type.
            let index = if boundIndex != nil {
                ConvertArrayElementIndex(indexSyntax.Location, boundIndex)
            } else {
                ConvertIndex(TypeSymbol.Int32)
            }
            return BoundIndexExpression(nil, target, index, element)
        }
        // Issue #1129: `string` is the primitive `TypeSymbol.String` (not an
        // `ImportedTypeSymbol`), so it matches none of the indexer-resolution
        // branches below. Model `s[i]` against .NET's `String` indexer
        // (`char this[int]` / `get_Chars(int)`), yielding a `char`. Issue #1279:
        // any integer-typed index is accepted; because `get_Chars` takes an
        // int32, the wider integer types convert (narrow) to int32. Emit already
        // lowers a `BoundIndexExpression` whose target is `string` to `get_Chars`
        // (#537).
        if target.Type == TypeSymbol.String {
            let index = if boundIndex != nil {
                ConvertStringCharIndex(indexSyntax.Location, boundIndex)
            } else {
                ConvertIndex(TypeSymbol.Int32)
            }
            return BoundIndexExpression(nil, target, index, TypeSymbol.Char)
        }
        // Phase 4 exit: CLR indexer read on an imported reference type
        // (e.g. `d["k"]` on Dictionary[string, int]). Pick a public
        // instance indexer (a `PropertyInfo` whose `GetIndexParameters()`
        // matches the single argument by assignability).
        // Issue #209: when the target carries inner-position nullable flags,
        // use them to type the element correctly (e.g., `list[0]` on `List<string?>` → `string?`).
        var clrIndexerOutcome = ClrIndexerResolutionOutcome.NoneFound
        if target.Type is TypeParameterSymbol tpIndexTarget {
            let clrIndexConstraint TypeSymbol? = tpIndexTarget.ClrInterfaceConstraint
            let clrConstraintType Type? = clrIndexConstraint?.ClrType
            if clrIndexConstraint != nil && clrConstraintType != nil {
                let idxArgs = ImmutableArray.Create(BoundIndexArg())
                let outcome = this.memberLookup.TryResolveClrIndexer(
                    clrIndexConstraint,
                    clrConstraintType,
                    idxArgs,
                    out var idxProp,
                    out var resolvedIdxArgs
                )
                if outcome == ClrIndexerResolutionOutcome.Resolved {
                    if ClrMemberVisibility.GetVisibleGetter(
                        idxProp!!,
                        CanAccessInternalsOf(idxProp!!.DeclaringType)
                    ) == nil {
                        Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type)
                        return BoundErrorExpression(nil)
                    }
                    let elementType = MemberLookup.GetClrPropertyTypeSymbol(clrIndexConstraint, idxProp!!)
                    let declaringInterface = MemberLookup.GetClrMemberDeclaringTypeSymbol(clrIndexConstraint, idxProp!!)
                    let convertedIdxArgs = BindClrIndexerArguments(
                        clrIndexConstraint,
                        idxProp!!,
                        resolvedIdxArgs,
                        indexSyntax.Location
                    )
                    return ConversionClassifier.AutoDereferenceRefReturn(
                        BoundClrIndexExpression(
                            nil,
                            target,
                            idxProp!!,
                            convertedIdxArgs,
                            elementType,
                            tpIndexTarget,
                            declaringInterface
                        )
                    )
                }
                clrIndexerOutcome = outcome
            }
        }
        let annotIdx NullabilityAnnotatedTypeSymbol? = target.Type as NullabilityAnnotatedTypeSymbol
        let clrAnnotIdx Type? = annotIdx?.ClrType
        if annotIdx != nil && clrAnnotIdx != nil {
            let idxArgsAnnot = ImmutableArray.Create(BoundIndexArg())
            let outcome = this.memberLookup.TryResolveClrIndexer(
                target.Type,
                clrAnnotIdx,
                idxArgsAnnot,
                out var idxPropAnnot,
                out var resolvedIdxArgsAnnot
            )
            if outcome == ClrIndexerResolutionOutcome.Resolved {
                // A successful CLR indexer resolution establishes a non-null property.
                if ClrMemberVisibility.GetVisibleGetter(
                    idxPropAnnot!!,
                    CanAccessInternalsOf(idxPropAnnot!!.DeclaringType)
                ) == nil {
                    Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type)
                    return BoundErrorExpression(nil)
                }
                let elemTypeAnnot = MemberLookup.GetClrPropertyTypeSymbol(target.Type, idxPropAnnot!!)
                let convertedIdxArgsAnnot = BindClrIndexerArguments(
                    target.Type,
                    idxPropAnnot!!,
                    resolvedIdxArgsAnnot,
                    indexSyntax.Location
                )
                return ConversionClassifier.AutoDereferenceRefReturn(
                    BoundClrIndexExpression(nil, target, idxPropAnnot!!, convertedIdxArgsAnnot, elemTypeAnnot)
                )
            }
            clrIndexerOutcome = outcome
        }
        let clrTarget Type? = target.Type.ClrType
        if (target.Type is ImportedTypeSymbol || target.Type is StructSymbol) && clrTarget != nil {
            let idxArgs = ImmutableArray.Create(BoundIndexArg())
            let outcome = this.memberLookup.TryResolveClrIndexer(
                target.Type,
                clrTarget,
                idxArgs,
                out var idxProp,
                out var resolvedIdxArgs
            )
            if outcome == ClrIndexerResolutionOutcome.Resolved {
                // A successful CLR indexer resolution establishes a non-null property.
                if ClrMemberVisibility.GetVisibleGetter(
                    idxProp!!,
                    CanAccessInternalsOf(idxProp!!.DeclaringType)
                ) == nil {
                    Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type)
                    return BoundErrorExpression(nil)
                }
                let elementType = if target.Type is ImportedTypeSymbol imported {
                    MapErasedIndexerElementType(imported, idxProp!!)
                } else {
                    ClrNullability.GetPropertyTypeSymbol(idxProp!!)
                }
                let convertedIdxArgs = BindClrIndexerArguments(
                    target.Type,
                    idxProp!!,
                    resolvedIdxArgs,
                    indexSyntax.Location
                )
                return ConversionClassifier.AutoDereferenceRefReturn(
                    BoundClrIndexExpression(nil, target, idxProp!!, convertedIdxArgs, elementType)
                )
            }
            clrIndexerOutcome = outcome
        }
        // ADR-0118 / issue #944: index access on a user-defined type that
        // declares an indexer member (`prop this[i T] U`). Binds `obj[i]` to a
        // call of the indexer getter (`obj.get_Item(i)`). ADR-0149 follow-up
        // (issue #2370): an INTERFACE-typed receiver dispatches through the
        // interface's own get_Item slot the same way. ADR-0187 / issue #4350:
        // a type may declare several overloaded indexers; the one taking the
        // written argument is selected by ordinary overload resolution.
        if (target.Type is StructSymbol or InterfaceSymbol) {
            if TryResolveUserIndexer(
                target.Type,
                argumentCount: 1,
                () -> ImmutableArray.Create(BoundIndexArg()),
                indexSyntax.Location,
                out var readIndexer,
                out var readSubstitution,
                out var readArguments,
                out var readReported,
                out var readView
            ) {
                ReplaceBackwardGotoIndexUse(
                    target,
                    targetLocation,
                    readIndexer!!.ContainingType ?? readView ?? target.Type
                )
                if binderCtx.TryGetBackwardGotoNarrowingPath(target, out var targetPath, out _) &&
                    !targetPath!!.HasMembers &&
                    !(targetPath!!.Root.Type is NullableTypeSymbol) &&
                    FindDeclaredIndexer(
                    targetPath!!.Root.Type,
                    readIndexer!!,
                    MemberOperation.Read,
                    target.Type,
                    readSubstitution
                ) is {} declaredIndexer {
                    binderCtx.UntrackBackwardGotoNarrowingIndex(targetPath!!.Root, targetLocation)
                    target = DeclaredReceiver(targetPath!!.Root, target.Syntax)
                    readIndexer = declaredIndexer.Indexer
                    readSubstitution = declaredIndexer.Substitution
                    readView = declaredIndexer.View ?? target.Type
                }
                return BindUserIndexerRead(
                    ViewIndexerReceiver(target, readView, targetLocation),
                    readIndexer!!,
                    readSubstitution,
                    (_ int32, parameterType TypeSymbol) -> if readArguments.IsDefault {
                        ConvertIndex(parameterType)
                    } else {
                        conversions.BindConversion(indexSyntax.Location, readArguments[0], parameterType)
                    },
                    targetLocation,
                    writtenArgumentCount: 1
                )
            }
            if readReported {
                return BoundErrorExpression(nil)
            }
        }
        if !ReportClrIndexerResolutionFailure(clrIndexerOutcome, indexSyntax.Location) &&
            target.Type != TypeSymbol.Error {
            Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type)
        }
        return BoundErrorExpression(nil)
    }

    private func FindDeclaredIndexer(
        declaredType TypeSymbol,
        indexer PropertySymbol,
        operation MemberOperation,
        receiverType TypeSymbol,
        selectedSubstitution Dictionary[TypeParameterSymbol, TypeSymbol]?
    ) VisibleUserIndexer? {
        var declaredType = declaredType
        declaredType = if declaredType is NullableTypeSymbol nullable {
            nullable.UnderlyingType
        } else {
            declaredType
        }
        let candidates = GetVisibleUserIndexers(declaredType)
        var overridden PropertySymbol? = indexer
        while overridden != nil {
            for candidate in candidates {
                if object.ReferenceEquals(candidate.Indexer, overridden) ||
                    (
                    overridden.Declaration != nil && object.ReferenceEquals(
                        candidate.Indexer.Declaration,
                        overridden.Declaration
                    )
                ) {
                    // A covariant override has a different result type than the
                    // declared slot; keep the original binding (fail-safe).
                    return if SamePropertySlot(indexer, candidate.Indexer, operation, receiverType) && object.Equals(
                        SubstituteIndexerType(candidate.Indexer.Type, candidate.Substitution),
                        SubstituteIndexerType(indexer.Type, selectedSubstitution)
                    ) {
                        candidate
                    } else {
                        nil
                    }
                }
            }
            overridden = overridden.OverriddenProperty
        }
        if !(declaredType is InterfaceSymbol) {
            return nil
        }
        let interfaceMatches = candidates
            .Where(
            (candidate VisibleUserIndexer) -> CanRecoverInterfacePropertySlot(
                indexer,
                candidate.Indexer,
                operation,
                receiverType
            ) &&
                HasSameIndexerSignature(candidate.Indexer, indexer, candidate.Substitution)
        )
            .Take(2)
            .ToArray()
        return if interfaceMatches.Length == 1 {
            interfaceMatches[0]
        } else {
            nil
        }
    }

    private func HasSameIndexerSignature(
        candidate PropertySymbol,
        selected PropertySymbol,
        substitution Dictionary[TypeParameterSymbol, TypeSymbol]?
    ) bool {
        if candidate
            .Parameters
            .Length != selected
            .Parameters
            .Length ||
            candidate.ReturnRefKind != selected.ReturnRefKind ||
            !object.Equals(SubstituteIndexerType(candidate.Type, substitution), selected.Type) {
            return false
        }
        for var i = 0; i < candidate.Parameters.Length; i++ {
            if candidate.Parameters[i].RefKind != selected.Parameters[i].RefKind || !object.Equals(
                SubstituteIndexerType(candidate.Parameters[i].Type, substitution),
                selected.Parameters[i].Type
            ) {
                return false
            }
        }
        return true
    }

    /// ADR-0149 follow-up (issue #2370): the interface counterpart of
    /// (cref:TryGetUserIndexer(StructSymbol, out PropertySymbol, out Dictionary{TypeParameterSymbol,
    /// TypeSymbol})).
    /// Walks [`target`](paramref) and its base interfaces
    /// ((cref:InterfaceSymbol.SelfAndAllBaseInterfaces)) for the first
    /// declared indexer (an interface may declare at most one `this[...]`
    /// slot per ADR-0149's parameter-shape uniqueness rule — multiple
    /// interfaces with DIFFERENT indexer shapes are disambiguated by the
    /// static receiver TYPE at the call site, exactly like ordinary named
    /// members), building the type-parameter substitution for a constructed
    /// generic receiver (e.g. `IBox[int32]` over `interface IBox[T]`).
    private func TrackBackwardGotoIndexUse(
        target BoundExpression,
        location TextLocation,
        requiredType TypeSymbol? = nil
    ) {
        var requiredType = requiredType
        if binderCtx.TryGetBackwardGotoNarrowingPath(target, out var path, out _) {
            if requiredType == nil &&
                target.Type is StructSymbol structType &&
                TryGetUserIndexer(structType, out var structIndexer, out _) {
                requiredType = structIndexer!!.ContainingType
            } else if requiredType == nil &&
                target.Type is InterfaceSymbol interfaceType &&
                TryGetUserIndexer(interfaceType, out var interfaceIndexer, out _) {
                requiredType = interfaceIndexer!!.ContainingType
            }
            binderCtx.TrackBackwardGotoNarrowingUse(
                path!!,
                location,
                string.Empty,
                BackwardGotoNarrowingUseKind.Index,
                requiredType: requiredType
            )
        }
    }

    private func ReplaceBackwardGotoIndexUse(target BoundExpression, location TextLocation, requiredType TypeSymbol) {
        if binderCtx.TryGetBackwardGotoNarrowingPath(target, out var path, out _) {
            if !(path!!.Root.Type is NullableTypeSymbol) {
                binderCtx.UntrackBackwardGotoNarrowingIndexUse(path!!.Root, location)
            }
            TrackBackwardGotoIndexUse(target, location, requiredType)
        }
    }

    private func BindIndexedWriteThroughChain(
        chainBase BoundExpression?,
        remainingChain ExpressionSyntax,
        indexSyntax ExpressionSyntax,
        valueSyntax ExpressionSyntax?,
        boundValueOverride BoundExpression?,
        compoundOperatorToken SyntaxToken?,
        compoundRhsSyntax ExpressionSyntax?,
        diagnosticLocation TextLocation,
        outerSyntax SyntaxNode
    ) BoundExpression {
        if TrySplitAtLeftmostNullConditional(remainingChain, out var leftSyntax, out var rightSyntax) {
            let boundLeft = if chainBase == nil {
                BindExpression(leftSyntax!!)
            } else {
                BindAccessorStep(chainBase, nil, leftSyntax!!)
            }
            if boundLeft is BoundErrorExpression || boundLeft.Type == TypeSymbol.Error {
                return BoundErrorExpression(nil)
            }
            var underlying TypeSymbol
            if boundLeft.Type is NullableTypeSymbol nullable {
                underlying = nullable.UnderlyingType
            } else if boundLeft.Type == TypeSymbol.Null {
                // Statically nil receiver: assignment is a no-op. Produce a
                // bound literal null so the surrounding expression sees a
                // well-typed value; lowering treats `null` literals as
                // statement-position no-ops.
                return BoundLiteralExpression(nil, nil)
            } else {
                // Non-nullable receiver: `?.` degenerates to `.`, but we still
                // produce a nullable result type for syntactic consistency
                // with the read-side null-conditional path.
                underlying = boundLeft.Type
            }
            let captureName = "$$ncap_" + (binderCtx.NullConditionalCaptureCounter += 1).ToString(
                CultureInfo.InvariantCulture
            )
            let capture = LocalVariableSymbol(captureName, isReadOnly: true, type: underlying)
            $scope = BoundScope($scope)
            $scope.TryDeclareVariable(capture)
            let captureRef = BoundVariableExpression(nil, capture)
            let whenNotNull = BindIndexedWriteThroughChain(
                chainBase: captureRef,
                remainingChain: rightSyntax!!,
                indexSyntax,
                valueSyntax,
                boundValueOverride,
                compoundOperatorToken,
                compoundRhsSyntax,
                diagnosticLocation,
                outerSyntax
            )
            $scope = $scope.Pop()
            if whenNotNull is BoundErrorExpression {
                return whenNotNull
            }
            let resultType = if whenNotNull.Type is NullableTypeSymbol {
                whenNotNull.Type
            } else {
                cast[TypeSymbol](NullableTypeSymbol.Get(whenNotNull.Type))
            }
            var resultSlot LocalVariableSymbol? = nil
            if resultType is NullableTypeSymbol nullableResult &&
                nullableResult
                .UnderlyingType
                ?.ClrType is {IsValueType: true} {
                let resultSlotName = "$$nres_" + binderCtx.NullConditionalCaptureCounter.ToString(
                    CultureInfo.InvariantCulture
                )
                resultSlot = LocalVariableSymbol(resultSlotName, isReadOnly: false, type: resultType)
            }
            return BoundNullConditionalAccessExpression(nil, boundLeft, capture, whenNotNull, resultType, resultSlot)
        }
        let boundReceiver = if chainBase == nil {
            BindExpression(remainingChain)
        } else {
            BindAccessorStep(chainBase, nil, remainingChain)
        }
        if boundReceiver is BoundErrorExpression || boundReceiver.Type == TypeSymbol.Error {
            return BoundErrorExpression(nil)
        }
        if GetRectangularArrayTypeForBinding(boundReceiver.Type) is {} rectangularReceiver {
            Diagnostics.ReportRectangularArrayIndexRankMismatch(
                diagnosticLocation,
                rectangularReceiver.Rank,
                indexCount: 1
            )
            return BoundErrorExpression(outerSyntax)
        }
        if NativeSliceTypes.TryGetElement(boundReceiver.Type, out _, out _) &&
            compoundOperatorToken != nil &&
            compoundRhsSyntax != nil {
            return BindNativeSliceCompoundAssignment(
                boundReceiver,
                indexSyntax,
                compoundOperatorToken,
                compoundRhsSyntax,
                outerSyntax is CompoundIndexAssignmentExpressionSyntax && outerSyntax.ReturnsPreviousValue == true,
                outerSyntax is CompoundIndexAssignmentExpressionSyntax && outerSyntax.IsIncrementDecrement == true
            )
        }
        let tempName = "<idxAsn${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
        let tempVar = LocalVariableSymbol(tempName, isReadOnly: true, boundReceiver.Type)
        if !$scope.TryDeclareVariable(tempVar) {
            // Defensive: synthesized names cannot collide with user identifiers
            // (the `<...>` prefix is not a valid identifier token), so a failure
            // here means a duplicate synthesized name within the same scope,
            // which Interlocked.Increment guarantees against. Treat as fatal.
            throw InvalidOperationException("Failed to declare synthesized index-assignment target local '$tempName'.")
        }
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.Add(BoundVariableDeclaration(outerSyntax, tempVar, boundReceiver))
        var assignment BoundExpression
        var previousDeclaration BoundVariableDeclaration? = nil
        var previousValue BoundVariableExpression? = nil
        if compoundOperatorToken != nil {
            if !SyntaxFacts.TryGetCompoundAssignmentBaseOperator(compoundOperatorToken.Kind, out var baseOpKind) {
                // Defensive: parser only emits this node for kinds recognised
                // by TryGetCompoundAssignmentBaseOperator above.
                return BoundErrorExpression(nil)
            }
            var sharedIndex BoundExpression? = nil
            if indexSyntax is FromEndIndexExpressionSyntax {
                if !TryBindSystemIndexValue(indexSyntax, out var boundSystemIndex) {
                    return BoundErrorExpression(nil)
                }
                let indexLocal = DeclareRangeTemp("index", boundSystemIndex!!.Type, boundSystemIndex!!, statements)
                sharedIndex = BoundVariableExpression(nil, indexLocal)
            }
            let tempRef = BoundVariableExpression(nil, tempVar)
            var indexRead = BindIndexAgainstTarget(tempRef, indexSyntax, diagnosticLocation, sharedIndex)
            if indexRead is BoundErrorExpression {
                if compoundRhsSyntax != nil {
                    let _ = BindExpression(compoundRhsSyntax)
                }
                return indexRead
            }
            if sharedIndex == nil && TryCaptureCompoundIndexArgument(&indexRead, statements, out var capturedIndex) {
                sharedIndex = capturedIndex
            } else if sharedIndex == nil &&
                !(indexSyntax is DefaultExpressionSyntax) &&
                !(indexSyntax is RangeExpressionSyntax) {
                let boundIndex = BindExpression(indexSyntax)
                if boundIndex is BoundErrorExpression {
                    return boundIndex
                }
                let indexLocal = DeclareRangeTemp("index", boundIndex.Type, boundIndex, statements)
                sharedIndex = BoundVariableExpression(nil, indexLocal)
                indexRead = BindIndexAgainstTarget(tempRef, indexSyntax, diagnosticLocation, sharedIndex)
                if indexRead is BoundErrorExpression {
                    return indexRead
                }
            }
            let compoundTarget = indexRead
            if compoundRhsSyntax is not{} resolvedCompoundRhsSyntax {
                return BoundErrorExpression(nil)
            }
            let rhsBound = BindExpression(resolvedCompoundRhsSyntax)
            if rhsBound is BoundErrorExpression || rhsBound.Type == TypeSymbol.Error {
                return BoundErrorExpression(nil)
            }
            // A user-defined `operator op=` mutates its receiver in place, so a
            // NON-addressable element read (a map or indexer `get` returns a
            // copy) has to be staged in a local and written back through the
            // setter below. The staging local is created BEFORE resolution so
            // the operator — and the conversion of its argument, which may
            // report diagnostics — is bound exactly once, against the target
            // that is actually mutated. It is materialised only if resolution
            // succeeds. A pointer dereference and an array-backed element are
            // already addressable, so they keep the in-place application; a
            // WRITABLE native ref-returning indexer (issue #4224) becomes
            // addressable by hoisting the reference its getter returns, which
            // also keeps that getter evaluated exactly once across the read,
            // the postfix capture, and the mutation.
            let refReturningElement = RefCapabilities.IsNativeRefReturningCall(compoundTarget) &&
                !RefCapabilities.IsReadOnlyStorage(compoundTarget) && IsLvalue(compoundTarget)
            var addressTemp LocalVariableSymbol? = nil
            var elementAddress BoundAddressOfExpression? = nil
            var valueTemp LocalVariableSymbol? = nil
            if refReturningElement {
                elementAddress = BoundAddressOfExpression(nil, compoundTarget, unmanaged: false)
                addressTemp = LocalVariableSymbol(
                    "<idxRef${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
                    isReadOnly: true,
                    elementAddress.Type
                )
            } else if ReflectionMetadataEmitter.IsValueTypeSymbol(compoundTarget.Type) &&
                !(compoundTarget is BoundDereferenceExpression) &&
                !(compoundTarget is BoundIndexExpression && compoundTarget.IsArrayBackedElementAccess == true) {
                valueTemp = LocalVariableSymbol(
                    "<idxCompound${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
                    isReadOnly: false,
                    compoundTarget.Type
                )
            }
            var userCompoundTarget = compoundTarget
            if addressTemp != nil {
                userCompoundTarget = BoundDereferenceExpression(nil, BoundVariableExpression(nil, addressTemp))
            } else if valueTemp != nil {
                userCompoundTarget = BoundVariableExpression(nil, valueTemp)
            }
            let userCompound BoundExpression? = TryBindUserCompoundAssignmentOperator(
                compoundOperatorToken.Kind,
                userCompoundTarget,
                rhsBound,
                resolvedCompoundRhsSyntax.Location
            )
            if userCompound != nil {
                if addressTemp != nil {
                    // The captured managed pointer cannot survive a suspension
                    // of the enclosing async method, so an awaiting right-hand
                    // side is rejected exactly as it is for a ref-returning
                    // call or property target.
                    if AsyncBoundTreeQueries.HasAwait(rhsBound) {
                        Diagnostics.ReportManagedReference(
                            resolvedCompoundRhsSyntax.Location,
                            "a ref-returning assignment target cannot survive suspension; evaluate the value before selecting the target"
                        )
                        return BoundErrorExpression(outerSyntax)
                    }
                    $scope.TryDeclareVariable(addressTemp)
                    statements.Add(
                        BoundVariableDeclaration(
                            outerSyntax,
                            addressTemp,
                            Invariant.Required(
                                elementAddress,
                                "a hoisted element reference has an address",
                                expression: "elementAddress"
                            )
                        )
                    )
                } else if valueTemp != nil {
                    $scope.TryDeclareVariable(valueTemp)
                    statements.Add(BoundVariableDeclaration(outerSyntax, valueTemp, compoundTarget))
                }
                var previousRead = userCompoundTarget
                previousValue = CapturePostfixCompoundValue(
                    outerSyntax is CompoundIndexAssignmentExpressionSyntax && outerSyntax.ReturnsPreviousValue == true,
                    outerSyntax,
                    &previousRead,
                    out previousDeclaration
                )
                if valueTemp != nil {
                    if previousDeclaration != nil {
                        statements.Add(previousDeclaration)
                    }
                    statements.Add(BoundExpressionStatement(outerSyntax, userCompound))
                    let writeBack = BindIndexedAssignmentToVariableWithBoundValue(
                        tempVar,
                        indexSyntax,
                        userCompoundTarget,
                        diagnosticLocation,
                        sharedIndex,
                        boundReceiver
                    )
                    if previousValue != nil {
                        statements.Add(BoundExpressionStatement(outerSyntax, writeBack))
                        return BoundBlockExpression(outerSyntax, statements.ToImmutable(), previousValue)
                    }
                    return BoundBlockExpression(outerSyntax, statements.ToImmutable(), writeBack)
                }
                return FinishUserCompoundIncrement(
                    outerSyntax,
                    outerSyntax is CompoundIndexAssignmentExpressionSyntax && outerSyntax.ReturnsPreviousValue == true,
                    outerSyntax is CompoundIndexAssignmentExpressionSyntax && outerSyntax.IsIncrementDecrement == true,
                    userCompoundTarget,
                    userCompound,
                    previousDeclaration,
                    previousValue,
                    statements
                )
            }
            // Review finding (#4350): a built-in operator over a writable
            // ref-returning element must also call the getter exactly once —
            // read and write through the hoisted reference rather than binding
            // a second getter call for the store.
            if addressTemp != nil {
                if AsyncBoundTreeQueries.HasAwait(rhsBound) {
                    Diagnostics.ReportManagedReference(
                        resolvedCompoundRhsSyntax.Location,
                        "a ref-returning assignment target cannot survive suspension; evaluate the value before selecting the target"
                    )
                    return BoundErrorExpression(outerSyntax)
                }
                $scope.TryDeclareVariable(addressTemp)
                statements.Add(
                    BoundVariableDeclaration(
                        outerSyntax,
                        addressTemp,
                        Invariant.Required(
                            elementAddress,
                            "a hoisted element reference has an address",
                            expression: "elementAddress"
                        )
                    )
                )
                indexRead = userCompoundTarget
            }
            previousValue = CapturePostfixCompoundValue(
                outerSyntax is CompoundIndexAssignmentExpressionSyntax && outerSyntax.ReturnsPreviousValue == true,
                outerSyntax,
                &indexRead,
                out previousDeclaration
            )
            // issue #1226 / #1246: the right operand of a compound element/indexer
            // assignment (`data[i] op= v`, including the synthetic `1` for
            // `++`/`--`) participates in the SAME constant-integer-literal
            // adaptation and implicit numeric widening as the equivalent binary
            // `data[i] op v`, via the shared adaptation helper.
            let combined BoundExpression? = TryBindCompoundBinaryOperation(
                baseOpKind,
                indexRead,
                rhsBound,
                resolvedCompoundRhsSyntax.Location
            )
            if combined == nil {
                Diagnostics.ReportUndefinedBinaryOperator(
                    compoundOperatorToken.Location,
                    compoundOperatorToken.Text,
                    indexRead.Type,
                    rhsBound.Type
                )
                return BoundErrorExpression(nil)
            }
            assignment = if addressTemp != nil {
                cast[BoundExpression](
                    BoundIndirectAssignmentExpression(
                        outerSyntax,
                        BoundVariableExpression(nil, addressTemp),
                        conversions.BindConversion(resolvedCompoundRhsSyntax.Location, combined, compoundTarget.Type)
                    )
                )
            } else {
                BindIndexedAssignmentToVariableWithBoundValue(
                    tempVar,
                    indexSyntax,
                    combined,
                    diagnosticLocation,
                    sharedIndex,
                    boundReceiver
                )
            }
        } else if boundValueOverride != nil {
            assignment = BindIndexedAssignmentToVariableWithBoundValue(
                tempVar,
                indexSyntax,
                boundValueOverride,
                diagnosticLocation,
                receiverCapabilitySource: boundReceiver
            )
        } else {
            if valueSyntax is not{} resolvedValueSyntax {
                return BoundErrorExpression(nil)
            }
            assignment = BindIndexedAssignmentToVariable(
                tempVar,
                indexSyntax,
                resolvedValueSyntax,
                diagnosticLocation,
                boundReceiver
            )
        }
        if assignment is BoundErrorExpression {
            return assignment
        }
        return FinishPostfixCompoundAssignment(outerSyntax, statements, previousDeclaration, previousValue, assignment)
    }

    private func TryCaptureCompoundIndexArgument(
        ref indexRead BoundExpression,
        statements ImmutableArray[BoundStatement].Builder,
        @NotNullWhen(true) out capturedIndex BoundExpression?
    ) bool {
        let Capture = func (argument BoundExpression) BoundExpression {
            let indexLocal = DeclareRangeTemp("index", argument.Type, argument, statements)
            return BoundVariableExpression(nil, indexLocal)
        }
        switch indexRead {
            case clrIndex is BoundClrIndexExpression when clrIndex.Arguments.Length == 1 {
                capturedIndex = Capture(clrIndex.Arguments[0])
                indexRead = BoundClrIndexExpression(
                    nil,
                    clrIndex.Target,
                    clrIndex.Indexer,
                    ImmutableArray.Create(capturedIndex!!),
                    clrIndex.Type
                )
                return true
            }
            case BoundDereferenceExpression{Operand: BoundClrIndexExpression clrRefIndex} when clrRefIndex
                .Arguments
                .Length == 1 {
                capturedIndex = Capture(clrRefIndex.Arguments[0])
                indexRead = BoundDereferenceExpression(
                    nil,
                    BoundClrIndexExpression(
                        nil,
                        clrRefIndex.Target,
                        clrRefIndex.Indexer,
                        ImmutableArray.Create(capturedIndex!!),
                        clrRefIndex.Type
                    )
                )
                return true
            }
            case builtInIndex is BoundIndexExpression {
                capturedIndex = Capture(builtInIndex.Index)
                indexRead = BoundIndexExpression(nil, builtInIndex.Target, capturedIndex!!, builtInIndex.Type)
                return true
            }
            case userIndex is BoundUserInstanceCallExpression when userIndex.Arguments.Length == 1 {
                capturedIndex = Capture(userIndex.Arguments[0])
                indexRead = BoundUserInstanceCallExpression(
                    nil,
                    userIndex.Receiver,
                    userIndex.Method,
                    ImmutableArray.Create(capturedIndex!!),
                    userIndex.Type,
                    userIndex.ConstrainedReceiverTypeParameter,
                    userIndex.ConstrainedInterfaceType
                ){MethodTypeArguments = userIndex.MethodTypeArguments}
                return true
            }
            default {
                capturedIndex = nil
                return false
            }
        }
    }

    private func TrySplitAtLeftmostNullConditional(
        chain ExpressionSyntax,
        @NotNullWhen(true) out left ExpressionSyntax?,
        @NotNullWhen(true) out right ExpressionSyntax?
    ) bool {
        // ParseNameOrCallExpression makes accessor chains RIGHT-recursive: in
        // `a.b?.c.d`, the outer accessor is `.` with LeftPart `a` and RightPart
        // `AccessorExpression(b, ?., AccessorExpression(c, ., d))`. To find the
        // leftmost `?.` we walk the RIGHT spine: if the current node is itself
        // `?.`, it is the split point; otherwise recurse into RightPart and
        // rebuild the LEFT side by re-attaching the prefix with the inner
        // `?.` replaced by its own LeftPart.
        if chain is AccessorExpressionSyntax acc {
            if acc.IsNullConditional {
                left = acc.LeftPart
                right = acc.RightPart
                return true
            }
            if TrySplitAtLeftmostNullConditional(acc.RightPart, out var innerLeft, out var innerRight) {
                left = AccessorExpressionSyntax(acc.SyntaxTree, acc.LeftPart, acc.DotToken, innerLeft!!)
                right = innerRight
                return true
            }
        }
        left = nil
        right = nil
        return false
    }

    private func BindIndexedAssignmentToVariable(
        variable VariableSymbol,
        indexSyntax ExpressionSyntax,
        valueSyntax ExpressionSyntax,
        diagnosticLocation TextLocation,
        receiverCapabilitySource BoundExpression? = nil
    ) BoundExpression {
        return BindIndexedAssignmentToVariableCore(
            variable,
            indexSyntax,
            valueSyntax,
            boundValueOverride: nil,
            diagnosticLocation,
            receiverCapabilitySource: receiverCapabilitySource
        )
    }

    private func BindIndexedAssignmentToVariableWithBoundValue(
        variable VariableSymbol,
        indexSyntax ExpressionSyntax,
        boundValue BoundExpression,
        diagnosticLocation TextLocation,
        boundIndexOverride BoundExpression? = nil,
        receiverCapabilitySource BoundExpression? = nil
    ) BoundExpression {
        return BindIndexedAssignmentToVariableCore(
            variable,
            indexSyntax,
            valueSyntax: nil,
            boundValueOverride: boundValue,
            diagnosticLocation,
            boundIndexOverride,
            receiverCapabilitySource
        )
    }

    private func BindIndexedAssignmentToVariableCore(
        variable VariableSymbol,
        indexSyntax ExpressionSyntax,
        valueSyntax ExpressionSyntax?,
        boundValueOverride BoundExpression?,
        diagnosticLocation TextLocation,
        boundIndexOverride BoundExpression? = nil,
        receiverCapabilitySource BoundExpression? = nil
    ) BoundExpression {
        // Issue #2488: direct indexed writes bypass the ordinary name-expression
        // read binder, so explicitly reuse its narrowed receiver construction.
        // Member/indexer lookup sees the effective type while loads still refer
        // to the original variable slot.
        var target = BuildNarrowedVariableRead(variable, diagnosticLocation)
        TrackBackwardGotoIndexUse(target, diagnosticLocation)
        // ADR-0186 §4/§5, issue #4323: the indexer WRITE path needs the same
        // receiver check and unwrap the READ path gets in
        // `BindIndexAgainstTarget`. This is failure mode 1 of the ADR's own
        // catalogue — "the read path and the call path drifted" — recurring
        // one access kind over: `l[0]` bound correctly on a `List[string]!`
        // receiver while `l[0] = "q"` reported GS0116 "not indexable",
        // because only the read side had been taught to unwrap. It is the
        // same one-line call at both sites deliberately; a second copy of
        // the RULE is what the ADR forbids, not a second call to the one
        // implementation.
        target = PlatformCoercion.InsertCheck(target, diagnosticLocation, "an indexer receiver")
        let targetType = target.Type
        let permissionReceiver = receiverCapabilitySource ?? target
        let isReadOnlyReceiver = RefCapabilities.IsReadOnlyValueReference(permissionReceiver)
        let hasNarrowedTarget = target is not BoundVariableExpression targetVariable ||
            targetVariable.NarrowedType != nil
        if GetRectangularArrayTypeForBinding(targetType) is {} rectangularTarget {
            Diagnostics.ReportRectangularArrayIndexRankMismatch(
                diagnosticLocation,
                rectangularTarget.Rank,
                indexCount: 1
            )
            return BoundErrorExpression(indexSyntax)
        }
        let MakeIndexAssignment = func (
            index BoundExpression,
            value BoundExpression,
            elementType TypeSymbol
        ) BoundExpression {
            return if hasNarrowedTarget {
                BoundIndexAssignmentExpression.WithExpressionTarget(nil, target, index, value, elementType)
            } else {
                BoundIndexAssignmentExpression(nil, variable, index, value, elementType)
            }
        }
        let MakeClrIndexAssignment = func (
            indexer PropertyInfo,
            arguments ImmutableArray[BoundExpression],
            value BoundExpression,
            resultType TypeSymbol,
            constrainedReceiverTypeParameter TypeParameterSymbol? = nil,
            constrainedInterfaceType TypeSymbol? = nil
        ) BoundExpression {
            if indexer.SetMethod != nil && isReadOnlyReceiver {
                Diagnostics.ReportCannotAssign(diagnosticLocation, "this[]")
                return BoundErrorExpression(indexSyntax)
            }
            return if hasNarrowedTarget {
                BoundClrIndexAssignmentExpression.WithExpressionTarget(
                    nil,
                    target,
                    indexer,
                    arguments,
                    value,
                    resultType,
                    constrainedReceiverTypeParameter,
                    constrainedInterfaceType
                )
            } else {
                BoundClrIndexAssignmentExpression(
                    nil,
                    variable,
                    indexer,
                    arguments,
                    value,
                    resultType,
                    constrainedReceiverTypeParameter,
                    constrainedInterfaceType
                )
            }
        }
        let MakeUserIndexAssignment = func (
            setter FunctionSymbol,
            index BoundExpression,
            value BoundExpression,
            elementType TypeSymbol,
            trailingDefaults ImmutableArray[BoundExpression]
        ) BoundExpression {
            if isReadOnlyReceiver {
                Diagnostics.ReportCannotAssign(diagnosticLocation, "this[]")
                return BoundErrorExpression(indexSyntax)
            }
            let indexName = "<idxAsnIndex${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
            let capturedIndex = LocalVariableSymbol(indexName, isReadOnly: true, index.Type)
            $scope.TryDeclareVariable(capturedIndex)
            let resultName = "<idxAsnValue${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
            let result = LocalVariableSymbol(resultName, isReadOnly: true, elementType)
            $scope.TryDeclareVariable(result)
            let indexRead = BoundVariableExpression(nil, capturedIndex)
            let resultRead = BoundVariableExpression(nil, result)
            let call = BoundUserInstanceCallExpression(
                nil,
                target,
                setter,
                trailingDefaults.Insert(0, indexRead).Add(resultRead)
            )
            return BoundBlockExpression(
                nil,
                ImmutableArray.Create[BoundStatement](
                    BoundVariableDeclaration(nil, capturedIndex, index),
                    BoundVariableDeclaration(nil, result, value),
                    BoundExpressionStatement(nil, call)
                ),
                resultRead
            )
        }
        let BindValue = func (elementType TypeSymbol) BoundExpression {
            if boundValueOverride != nil {
                return conversions.BindConversion(diagnosticLocation, boundValueOverride, elementType)
            }
            return BindExpression(
                Invariant.Required(valueSyntax, "index assignments have a value expression", expression: "valueSyntax"),
                elementType
            )
        }
        if NativeSliceTypes.TryGetElement(targetType, out var nativeElement, out _) {
            return BindNativeSliceAssignment(
                target,
                indexSyntax,
                BindValue(nativeElement),
                diagnosticLocation,
                boundIndexOverride
            )
        }
        if boundIndexOverride != nil && ClrTypeUtilities.AreSame(boundIndexOverride.Type?.ClrType, typeof(Index)) {
            return BindSystemIndexAssignment(
                variable,
                target,
                targetType,
                hasNarrowedTarget,
                boundIndexOverride,
                BindValue,
                diagnosticLocation,
                isReadOnlyReceiver
            )
        }
        if boundIndexOverride == nil && TryBindSystemIndexValue(indexSyntax, out var systemIndex) {
            return BindSystemIndexAssignment(
                variable,
                target,
                targetType,
                hasNarrowedTarget,
                systemIndex!!,
                BindValue,
                diagnosticLocation,
                isReadOnlyReceiver
            )
        }
        let BindIndexValue = func () BoundExpression {
            return boundIndexOverride ?? BindExpression(indexSyntax)
        }
        let ConvertIndexValue = func (targetType TypeSymbol) BoundExpression {
            return if boundIndexOverride != nil {
                conversions.BindConversion(indexSyntax.Location, boundIndexOverride, targetType)
            } else {
                conversions.BindConversion(indexSyntax, targetType)
            }
        }
        let element TypeSymbol? = GetIndexElementType(targetType)
        if element != nil {
            let index = if boundIndexOverride != nil {
                ConvertArrayElementIndex(indexSyntax.Location, boundIndexOverride)
            } else {
                BindArrayElementIndex(indexSyntax)
            }
            let value = BindValue(element)
            return MakeIndexAssignment(index, value, element)
        }
        // ADR-0122 / issue #1014: pointer indexed write `p[i] = v` == `*(p + i) = v`.
        if targetType is PointerTypeSymbol pointerType {
            // ADR-0122 §3 / issue #1033: a `*void` pointer has no element type,
            // so an indexed write `p[i] = v` is rejected (GS0403); cast to a
            // typed pointer `*T` first.
            if TypeSymbol.IsVoidPointer(targetType) {
                Diagnostics.ReportVoidPointerOperationNotAllowed(diagnosticLocation, "index")
                return BoundErrorExpression(nil)
            }
            var pointerIndex = BindIndexValue()
            if pointerIndex is BoundErrorExpression {
                return pointerIndex
            }
            if !IsPointerOffsetType(pointerIndex.Type) {
                pointerIndex = if boundIndexOverride != nil {
                    conversions.BindConversion(indexSyntax.Location, pointerIndex, TypeSymbol.NInt)
                } else {
                    conversions.BindConversion(indexSyntax, TypeSymbol.NInt)
                }
            }
            let elementPointer = LowerPointerOffset(target, pointerType, pointerIndex, subtract: false)
            let pointerValue = BindValue(pointerType.PointeeType)
            return BoundIndirectAssignmentExpression(nil, elementPointer, pointerValue)
        }
        // Phase 3.A.4: map indexed assignment `m[k] = v` — key bound to K,
        // value bound to V.
        if targetType is MapTypeSymbol mapType {
            let keyExpr = ConvertIndexValue(mapType.KeyType)
            let valExpr = BindValue(mapType.ValueType)
            return MakeIndexAssignment(keyExpr, valExpr, mapType.ValueType)
        }
        // Phase 4 exit: CLR indexer write on an imported reference type
        // (e.g. `d["k"] = 1` on Dictionary[string, int]).
        // Issue #209: honour inner-position nullable flags when present.
        var clrIndexerOutcome = ClrIndexerResolutionOutcome.NoneFound
        if targetType is TypeParameterSymbol tpIndexTarget {
            let clrIndexConstraint TypeSymbol? = tpIndexTarget.ClrInterfaceConstraint
            let clrConstraintType Type? = clrIndexConstraint?.ClrType
            if clrIndexConstraint != nil && clrConstraintType != nil {
                let idxArgs = ImmutableArray.Create(BindIndexValue())
                let outcome = this.memberLookup.TryResolveClrIndexer(
                    clrIndexConstraint,
                    clrConstraintType,
                    idxArgs,
                    out var idxProp,
                    out var resolvedIdxArgs
                )
                if outcome == ClrIndexerResolutionOutcome.Resolved {
                    if ClrMemberVisibility.GetVisibleSetter(
                        idxProp!!,
                        CanAccessInternalsOf(idxProp!!.DeclaringType)
                    ) == nil {
                        Diagnostics.ReportTypeNotIndexable(diagnosticLocation, targetType)
                        return BoundErrorExpression(nil)
                    }
                    let elementType = MemberLookup.GetClrPropertyTypeSymbol(clrIndexConstraint, idxProp!!)
                    let declaringInterface = MemberLookup.GetClrMemberDeclaringTypeSymbol(clrIndexConstraint, idxProp!!)
                    let value = BindValue(elementType)
                    let convertedArgs = BindClrIndexerArguments(
                        clrIndexConstraint,
                        idxProp!!,
                        resolvedIdxArgs,
                        indexSyntax.Location
                    )
                    return MakeClrIndexAssignment(
                        idxProp!!,
                        convertedArgs,
                        value,
                        elementType,
                        tpIndexTarget,
                        declaringInterface
                    )
                }
                clrIndexerOutcome = outcome
            }
        } else if targetType is NullabilityAnnotatedTypeSymbol annotWr && targetType.ClrType is Type clrAnnotWr {
            let idxArgsAnnotWr = ImmutableArray.Create(BindIndexValue())
            let outcome = this.memberLookup.TryResolveClrIndexer(
                targetType,
                clrAnnotWr,
                idxArgsAnnotWr,
                out var idxPropAnnotWr,
                out var resolvedIdxArgsAnnotWr
            )
            if outcome == ClrIndexerResolutionOutcome.Resolved {
                // A successful CLR indexer resolution establishes a non-null property.
                if ClrMemberVisibility.GetVisibleSetter(
                    idxPropAnnotWr!!,
                    CanAccessInternalsOf(idxPropAnnotWr!!.DeclaringType)
                ) == nil {
                    Diagnostics.ReportTypeNotIndexable(diagnosticLocation, targetType)
                    return BoundErrorExpression(nil)
                }
                let valueTypeAnnotWr = MemberLookup.GetClrPropertyTypeSymbol(targetType, idxPropAnnotWr!!)
                let boundValueAnnotWr = BindValue(valueTypeAnnotWr)
                let convertedIdxArgsAnnotWr = BindClrIndexerArguments(
                    targetType,
                    idxPropAnnotWr!!,
                    resolvedIdxArgsAnnotWr,
                    indexSyntax.Location
                )
                return MakeClrIndexAssignment(
                    idxPropAnnotWr!!,
                    convertedIdxArgsAnnotWr,
                    boundValueAnnotWr,
                    valueTypeAnnotWr,
                    constrainedReceiverTypeParameter: nil,
                    constrainedInterfaceType: nil
                )
            }
            clrIndexerOutcome = outcome
        } else if (targetType is ImportedTypeSymbol || targetType is StructSymbol) &&
            targetType.ClrType is Type clrTarget {
            let idxArgs = ImmutableArray.Create(BindIndexValue())
            let outcome = this.memberLookup.TryResolveClrIndexer(
                targetType,
                clrTarget,
                idxArgs,
                out var idxProp,
                out var resolvedIdxArgs
            )
            if outcome == ClrIndexerResolutionOutcome.Resolved {
                // A successful CLR indexer resolution establishes a non-null property.
                let convertedIdxArgs = BindClrIndexerArguments(
                    targetType,
                    idxProp!!,
                    resolvedIdxArgs,
                    indexSyntax.Location
                )
                // ADR-0056 §2: span element write. `Span[T]` has no `set_Item`; its
                // indexer is a `ref T`-returning getter and writes go through that
                // managed pointer. Detect the ref-returning getter and store through
                // it. A `ReadOnlySpan[T]` getter is `ref readonly T` — writing is a
                // hard error (GS0226).
                if ClrMemberVisibility.GetVisibleSetter(
                    idxProp!!,
                    CanAccessInternalsOf(idxProp!!.DeclaringType)
                ) == nil {
                    let refGetter MethodInfo? = GetVisibleGetter(idxProp!!)
                    if refGetter != nil && refGetter.ReturnType.IsByRef {
                        if IsReadOnlyRefReturn(idxProp!!) {
                            Diagnostics.ReportCannotAssignReadOnlySpanElement(diagnosticLocation, targetType)
                            return BoundErrorExpression(nil)
                        }
                        let resolvedElementType = if targetType is ImportedTypeSymbol importedRefReturn {
                            MapErasedIndexerElementType(importedRefReturn, idxProp!!)
                        } else {
                            ResolveIndexerElementType(targetType, idxProp!!)
                        }
                        let pointeeType = if resolvedElementType is ByRefTypeSymbol byRef {
                            byRef.PointeeType
                        } else {
                            (
                                if ClrNullability.GetReturnTypeSymbol(refGetter) is ByRefTypeSymbol readByRef {
                                    readByRef.PointeeType
                                } else {
                                    TypeSymbol.Error
                                }
                            )
                        }
                        let refValue = BindValue(pointeeType)
                        return MakeClrIndexAssignment(
                            idxProp!!,
                            convertedIdxArgs,
                            refValue,
                            pointeeType,
                            constrainedReceiverTypeParameter: nil,
                            constrainedInterfaceType: nil
                        )
                    }
                    Diagnostics.ReportTypeNotIndexable(diagnosticLocation, targetType)
                    return BoundErrorExpression(nil)
                }
                // Issue #968: recover the symbolic element type the same way
                // the READ path does (MapErasedIndexerElementType). On a
                // `List[T]` whose element `T` is the enclosing type's generic
                // parameter, `idxProp.PropertyType` is the type-erased CLR
                // `object` (T -> object). Typing the write value as `object`
                // here would reject the assignment `_items[i] = value` (where
                // `value: T`) with GS0155 ("Cannot convert type 'T' to
                // 'object'"). Substituting the open `set_Item` value parameter
                // back through the receiver's symbolic type arguments yields the
                // real element type (`T`), so the `T` value binds without a
                // spurious boxing conversion — the WRITE-path counterpart to the
                // READ-path element-type recovery (issues #313 / #671 / #957).
                let valueType = if targetType is ImportedTypeSymbol imported {
                    MapErasedIndexerElementType(imported, idxProp!!)
                } else {
                    ClrNullability.GetPropertyTypeSymbol(idxProp!!)
                }
                let boundValue = BindValue(valueType)
                return MakeClrIndexAssignment(
                    idxProp!!,
                    convertedIdxArgs,
                    boundValue,
                    valueType,
                    constrainedReceiverTypeParameter: nil,
                    constrainedInterfaceType: nil
                )
            }
            clrIndexerOutcome = outcome
        }
        // ADR-0118 / issue #944: index assignment on a user-defined type that
        // declares an indexer member. Binds `obj[i] = v` to a call of the
        // indexer setter (`obj.set_Item(i, v)`). ADR-0149 follow-up (issue
        // #2370): an INTERFACE-typed receiver dispatches through the
        // interface's own set_Item slot. ADR-0187 / issue #4350: overloaded
        // indexers are selected by the written index argument first.
        if (targetType is StructSymbol or InterfaceSymbol) {
            if TryResolveUserIndexer(
                targetType,
                argumentCount: 1,
                () -> ImmutableArray.Create(BindIndexValue()),
                indexSyntax.Location,
                out var writeIndexer,
                out var writeSubstitution,
                out var writeArguments,
                out var writeReported,
                out var writeView
            ) {
                if binderCtx.TryGetBackwardGotoNarrowingPath(target, out var targetPath, out _) &&
                    !targetPath!!.HasMembers &&
                    !(targetPath!!.Root.Type is NullableTypeSymbol) &&
                    FindDeclaredIndexer(
                    targetPath!!.Root.Type,
                    writeIndexer!!,
                    MemberOperation.Write,
                    target.Type,
                    writeSubstitution
                ) is {} declaredIndexer {
                    binderCtx.UntrackBackwardGotoNarrowingIndex(targetPath!!.Root, diagnosticLocation)
                    target = DeclaredReceiver(targetPath!!.Root, target.Syntax)
                    writeIndexer = declaredIndexer.Indexer
                    writeSubstitution = declaredIndexer.Substitution
                    writeView = declaredIndexer.View ?? target.Type
                } else {
                    ReplaceBackwardGotoIndexUse(
                        target,
                        diagnosticLocation,
                        writeIndexer!!.ContainingType ?? writeView ?? target.Type
                    )
                }
                target = ViewIndexerReceiver(target, writeView, diagnosticLocation)
                let selectedIndexer = writeIndexer
                let paramType = SubstituteIndexerType(selectedIndexer!!.Parameters[0].Type, writeSubstitution)
                let ConvertWriteIndex = func () BoundExpression {
                    return if writeArguments.IsDefault {
                        ConvertIndexValue(paramType)
                    } else {
                        conversions.BindConversion(indexSyntax.Location, writeArguments[0], paramType)
                    }
                }
                if selectedIndexer!!.SetterSymbol == nil {
                    // Issue #4224: a writable-ref-returning indexer getter (no
                    // setter, but `ReturnRefKind == Ref`) stores through the
                    // getter instead of failing outright, mirroring the
                    // named-property write-through path (TryBindRefGetterWriteThrough)
                    // and the existing imported/CLR ref-indexer write-through
                    // above. A `ref readonly` getter stays protected.
                    if targetType is StructSymbol &&
                        selectedIndexer!!.GetterSymbol is {ReturnRefKind: RefKind.Ref} refIndexerGetter {
                        if isReadOnlyReceiver {
                            Diagnostics.ReportCannotAssign(diagnosticLocation, "this[]")
                            return BoundErrorExpression(indexSyntax)
                        }
                        let refElementType = SubstituteIndexerType(refIndexerGetter.Type, writeSubstitution)
                        let refIndexArg = ConvertWriteIndex()
                        let refValue = BindValue(refElementType)
                        if !CheckUserIndexerAccessibility(
                            selectedIndexer!!,
                            requireGetter: true,
                            requireSetter: false,
                            diagnosticLocation
                        ) {
                            return BoundErrorExpression(nil)
                        }
                        let refGetCall = BoundUserInstanceCallExpression(
                            nil,
                            target,
                            refIndexerGetter,
                            TrailingIndexerDefaults(selectedIndexer!!, 1, writeSubstitution).Insert(0, refIndexArg),
                            refElementType
                        )
                        return BoundIndirectAssignmentExpression(
                            nil,
                            BoundAddressOfExpression(nil, refGetCall, unmanaged: false),
                            refValue
                        )
                    }
                    Diagnostics.ReportTypeNotIndexable(diagnosticLocation, targetType)
                    return BoundErrorExpression(nil)
                }
                let elementType = SubstituteIndexerType(
                    selectedIndexer!!.SetterSymbol!!.Parameters[^1].Type,
                    writeSubstitution
                )
                let indexArg = ConvertWriteIndex()
                let value = BindValue(elementType)
                if !CheckUserIndexerAccessibility(
                    selectedIndexer!!,
                    requireGetter: false,
                    requireSetter: true,
                    diagnosticLocation
                ) {
                    return BoundErrorExpression(nil)
                }
                return MakeUserIndexAssignment(
                    selectedIndexer!!.SetterSymbol!!,
                    indexArg,
                    value,
                    elementType,
                    TrailingIndexerDefaults(selectedIndexer!!, 1, writeSubstitution)
                )
            }
            if writeReported {
                return BoundErrorExpression(nil)
            }
        }
        if !ReportClrIndexerResolutionFailure(clrIndexerOutcome, indexSyntax.Location) &&
            targetType != TypeSymbol.Error {
            Diagnostics.ReportTypeNotIndexable(diagnosticLocation, targetType)
        }
        return BoundErrorExpression(nil)
    }

    private func ReportClrIndexerResolutionFailure(outcome ClrIndexerResolutionOutcome, location TextLocation) bool {
        switch outcome {
            case ClrIndexerResolutionOutcome.NoneApplicable {
                Diagnostics.ReportNoApplicableOverload(location, "this[]")
                return true
            }
            case ClrIndexerResolutionOutcome.Ambiguous {
                Diagnostics.ReportAmbiguousOverloadResolution(location, "this[]")
                return true
            }
            default {
                return false
            }
        }
    }

    private func BindClrIndexerArguments(
        targetType TypeSymbol,
        indexer PropertyInfo,
        arguments ImmutableArray[BoundExpression],
        diagnosticLocation TextLocation
    ) ImmutableArray[BoundExpression] {
        let converted = ImmutableArray.CreateBuilder[BoundExpression](arguments.Length)
        for var i = 0; i < arguments.Length; i++ {
            let parameterType = MemberLookup.GetIndexerParameterTypeSymbol(targetType, indexer, i)
            // Issue #4400: an `in` index parameter takes a readonly reference;
            // the plain index argument is converted to the pointee and passed
            // by address (an lvalue's own, or a spilled temp's), as in C#.
            let indexParameters = indexer.GetIndexParameters()
            if i < indexParameters.Length && ConversionClassifier.IsImplicitInClrArgument(
                arguments[i],
                indexParameters[i]
            ) {
                let inPointee = if TypeSymbol.TryGetPointeeType(parameterType, out var substitutedPointee) {
                    substitutedPointee!!
                } else {
                    ConversionClassifier.GetImplicitInClrPointeeType(
                        indexParameters[i],
                        i,
                        method: nil,
                        receiverType: nil,
                        symbolicMethodTypeArgs: default(ImmutableArray[TypeSymbol?])
                    )
                }
                converted.Add(
                    conversions.BindImplicitInArgument(diagnosticLocation, arguments[i], inPointee, parameter: nil)
                )
                continue
            }
            converted.Add(conversions.BindConversion(diagnosticLocation, arguments[i], parameterType))
        }
        return converted.MoveToImmutable()
    }

    /// Issue #1354: maps an imported method's return type to a
    /// (cref:TypeSymbol), applying the reference-type nullability rule
    /// (oblivious/unannotated → `T?`, explicit `[Nullable(1)]` →
    /// non-null) via (cref:ClrNullability.GetReturnTypeSymbol). This is
    /// the call-return-type counterpart of the property readers:
    /// without it, the non-generic instance-method fallback chain would land on
    /// a bare (cref:TypeSymbol.FromClrType) and treat oblivious imported
    /// reference returns as non-null. The existing by-ref-return handling
    /// (e.g. `ref T` returns) is preserved.
    /// @param method The imported method whose return type to map.
    /// @returns The nullability-aware return type symbol.
    private func MapClrMethodReturnType(method MethodInfo?) TypeSymbol {
        if method == nil {
            return TypeSymbol.Void
        }
        return ImportedTypeSymbol.NormalizeSemanticAggregate(
            ClrNullability.GetReturnTypeSymbol(method),
            method.ReturnType,
            $scope.References
        )
    }

    private func NormalizeImportedSemanticAggregate(type TypeSymbol, member MemberInfo) TypeSymbol {
        let clrType = switch member {
            case property is PropertyInfo: property.PropertyType
            case field is FieldInfo: field.FieldType
            default: default(Type?)
        }
        return ImportedTypeSymbol.NormalizeSemanticAggregate(type, clrType, $scope.References)
    }

    // Issue #1016: bind a range/slice expression `target[lo..hi]` (and the
    // open-ended forms). The bound representation reuses existing nodes wrapped
    // in a BoundBlockExpression so emit and the interpreter both work without a
    // new bound-node kind. Sliceable shapes mirror C#:
    //   - arrays / slices (`[N]T`, `[]T`, CLR `T[]`) -> new T[len] + Array.Copy.
    //   - `string` -> Substring(start, len).
    //   - span-like types with `int Length`/`int Count` + `Slice(int, int)`.
    //   - types with a `this[System.Range]` indexer -> call it directly.
    // Issue #1022: bind a single from-end index `target[^n]` to the element at
    // `length - n`. The bound representation reuses existing nodes wrapped in a
    // BoundBlockExpression (no new bound-node kind). Indexable shapes mirror C#:
    //   - arrays / slices (`[N]T`, `[]T`, CLR `T[]`) -> `src[len(src) - n]`.
    //   - types with a `this[System.Index]` indexer -> call it with `^n`.
    //   - types with `int Length`/`int Count` + a `this[int]` indexer (string,
    //     List<T>, span-like) -> `src[Length - n]`.
    private func BindFromEndIndex(
        target BoundExpression,
        fromEnd FromEndIndexExpressionSyntax,
        targetLocation TextLocation
    ) BoundExpression {
        if target is BoundErrorExpression || target.Type == TypeSymbol.Error || target.Type == nil {
            let _ = BindExpression(fromEnd.Operand)
            return BoundErrorExpression(nil)
        }
        if !TryBindSystemIndexValue(fromEnd, out var indexValue) {
            return BoundErrorExpression(nil)
        }
        return BindSystemIndexAccess(target, indexValue!!, targetLocation)
    }

    private func TryBindSystemIndexValue(
        syntax ExpressionSyntax,
        @NotNullWhen(true) out indexValue BoundExpression?
    ) bool {
        if syntax is FromEndIndexExpressionSyntax fromEnd {
            let indexCtor = typeof(Index).GetConstructor([]Type{typeof(int32), typeof(bool)})
            let indexSym = TypeSymbol.FromClrTypeWithoutNullability(typeof(Index), NullabilityFreeReason.TypeLiteral)
            let offset = conversions.BindConversion(fromEnd.Operand, TypeSymbol.Int32)
            indexValue = BoundClrConstructorCallExpression(
                nil,
                typeof(Index),
                indexCtor!!,
                ImmutableArray.Create[BoundExpression](offset, BoundLiteralExpression(nil, true)),
                indexSym
            )
            return true
        }
        let bound = BindExpression(syntax)
        if !(bound is BoundErrorExpression) && ClrTypeUtilities.AreSame(bound.Type.ClrType, typeof(Index)) {
            indexValue = bound
            return true
        }
        indexValue = nil
        return false
    }

    private func BindSystemIndexAccess(
        target BoundExpression,
        indexValue BoundExpression,
        targetLocation TextLocation
    ) BoundExpression {
        let element TypeSymbol? = GetIndexElementType(target.Type)
        if element != nil {
            let statements = ImmutableArray.CreateBuilder[BoundStatement]()
            let srcLocal = DeclareRangeTemp("src", target.Type, target, statements)
            let idx = BuildSystemIndexOffset(
                indexValue,
                BoundLenExpression(nil, BoundVariableExpression(nil, srcLocal)),
                statements
            )
            let read = BoundIndexExpression(nil, BoundVariableExpression(nil, srcLocal), idx, element)
            return BoundBlockExpression(nil, statements.ToImmutable(), read)
        }
        let clrType Type? = target.Type.ClrType
        if clrType != nil {
            if TryFindIndexIndexer(clrType, out var indexIndexer) {
                let resultType = ResolveIndexerElementType(target.Type, indexIndexer)
                return ConversionClassifier.AutoDereferenceRefReturn(
                    BoundClrIndexExpression(nil, target, indexIndexer, ImmutableArray.Create(indexValue), resultType)
                )
            }
            if TryFindCountedIntIndexer(clrType, out var lengthMember, out var intIndexer) {
                let statements = ImmutableArray.CreateBuilder[BoundStatement]()
                let srcLocal = DeclareRangeTemp("src", target.Type, target, statements)
                let srcRef = BoundVariableExpression(nil, srcLocal)
                let lengthExpr = BoundClrPropertyAccessExpression(nil, srcRef, lengthMember, TypeSymbol.Int32)
                let idx = BuildSystemIndexOffset(indexValue, lengthExpr, statements)
                let resultType = ResolveIndexerElementType(target.Type, intIndexer)
                let read = ConversionClassifier.AutoDereferenceRefReturn(
                    BoundClrIndexExpression(
                        nil,
                        BoundVariableExpression(nil, srcLocal),
                        intIndexer,
                        ImmutableArray.Create[BoundExpression](idx),
                        resultType
                    )
                )
                return BoundBlockExpression(nil, statements.ToImmutable(), read)
            }
        }
        // ADR-0187 / issue #4350: a user type that declares a
        // `this[System.Index]` indexer (among possibly several overloads)
        // receives the Index value directly, as C# binds it.
        if (target.Type is StructSymbol or InterfaceSymbol) &&
            TryGetUserIndexerTaking(
            target.Type,
            typeof(Index),
            out var userIndexer,
            out var substitution,
            out var indexView
        ) &&
            userIndexer!!.GetterSymbol != nil {
            return BindUserIndexerRead(
                ViewIndexerReceiver(target, indexView, targetLocation),
                userIndexer!!,
                substitution,
                (_ int32, parameterType TypeSymbol) -> conversions.BindConversion(
                    targetLocation,
                    indexValue,
                    parameterType
                ),
                targetLocation
            )
        }
        Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type)
        return BoundErrorExpression(nil)
    }

    private func BindSystemIndexAssignment(
        variable VariableSymbol,
        target BoundExpression,
        targetType TypeSymbol,
        hasNarrowedTarget bool,
        indexValue BoundExpression,
        bindValue(TypeSymbol) -> BoundExpression,
        diagnosticLocation TextLocation,
        isReadOnlyReceiver bool
    ) BoundExpression {
        var target = target
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let element TypeSymbol? = GetIndexElementType(targetType)
        if element != nil {
            let idx = BuildSystemIndexOffset(indexValue, BoundLenExpression(nil, target), statements)
            let assignment = if hasNarrowedTarget {
                BoundIndexAssignmentExpression.WithExpressionTarget(nil, target, idx, bindValue(element), element)
            } else {
                BoundIndexAssignmentExpression(nil, variable, idx, bindValue(element), element)
            }
            return BoundBlockExpression(nil, statements.ToImmutable(), assignment)
        }
        let clrType Type? = targetType.ClrType
        if clrType != nil {
            var indexer PropertyInfo?
            var arguments ImmutableArray[BoundExpression]
            if TryFindIndexIndexer(clrType, out indexer) {
                arguments = ImmutableArray.Create(indexValue)
            } else if TryFindCountedIntIndexer(clrType, out var lengthMember, out indexer) {
                let lengthExpr = BoundClrPropertyAccessExpression(nil, target, lengthMember, TypeSymbol.Int32)
                arguments = ImmutableArray.Create(BuildSystemIndexOffset(indexValue, lengthExpr, statements))
            } else {
                Diagnostics.ReportTypeNotIndexable(diagnosticLocation, targetType)
                return BoundErrorExpression(nil)
            }
            // Either indexer lookup succeeded, so the property is present here.
            let getter MethodInfo? = ClrMemberVisibility.GetVisibleGetter(
                indexer,
                CanAccessInternalsOf(indexer.DeclaringType)
            )
            var valueType = ResolveIndexerElementType(targetType, indexer)
            if indexer.SetMethod != nil && isReadOnlyReceiver {
                Diagnostics.ReportCannotAssign(diagnosticLocation, "this[]")
                return BoundErrorExpression(indexValue.Syntax)
            }
            if !indexer.CanWrite {
                if getter == nil || !getter.ReturnType.IsByRef {
                    Diagnostics.ReportTypeNotIndexable(diagnosticLocation, targetType)
                    return BoundErrorExpression(nil)
                }
                if IsReadOnlyRefReturn(indexer) {
                    Diagnostics.ReportCannotAssignReadOnlySpanElement(diagnosticLocation, targetType)
                    return BoundErrorExpression(nil)
                }
                valueType = if valueType is ByRefTypeSymbol byRef {
                    byRef.PointeeType
                } else {
                    valueType
                }
            }
            let assignment = if hasNarrowedTarget {
                BoundClrIndexAssignmentExpression.WithExpressionTarget(
                    nil,
                    target,
                    indexer,
                    arguments,
                    bindValue(valueType),
                    valueType
                )
            } else {
                BoundClrIndexAssignmentExpression(nil, variable, indexer, arguments, bindValue(valueType), valueType)
            }
            return BoundBlockExpression(nil, statements.ToImmutable(), assignment)
        }
        // ADR-0187 / issue #4350: a user `this[System.Index]` indexer
        // receives the Index value directly; a ref-returning getter with no
        // setter stores through the returned reference.
        if (targetType is StructSymbol || targetType is InterfaceSymbol) &&
            TryGetUserIndexerTaking(
            targetType,
            typeof(Index),
            out var userIndexer,
            out var substitution,
            out var indexView
        ) {
            target = ViewIndexerReceiver(target, indexView, diagnosticLocation)
            let parameterType = SubstituteIndexerType(userIndexer!!.Parameters[0].Type, substitution)
            if userIndexer!!.SetterSymbol != nil {
                if isReadOnlyReceiver {
                    Diagnostics.ReportCannotAssign(diagnosticLocation, "this[]")
                    return BoundErrorExpression(nil)
                }
                let valueType = SubstituteIndexerType(userIndexer!!.Type, substitution)
                let convertedIndex = conversions.BindConversion(diagnosticLocation, indexValue, parameterType)
                let value = bindValue(valueType)
                if !CheckUserIndexerAccessibility(
                    userIndexer!!,
                    requireGetter: false,
                    requireSetter: true,
                    diagnosticLocation
                ) {
                    return BoundErrorExpression(nil)
                }
                return BoundUserInstanceCallExpression(
                    nil,
                    target,
                    userIndexer!!.SetterSymbol!!,
                    ImmutableArray.Create(convertedIndex, value)
                )
            }
            if targetType is StructSymbol && userIndexer!!.GetterSymbol is {ReturnRefKind: RefKind.Ref} refGetter {
                if isReadOnlyReceiver {
                    Diagnostics.ReportCannotAssign(diagnosticLocation, "this[]")
                    return BoundErrorExpression(nil)
                }
                let refElementType = SubstituteIndexerType(refGetter.Type, substitution)
                let convertedIndex = conversions.BindConversion(diagnosticLocation, indexValue, parameterType)
                let value = bindValue(refElementType)
                if !CheckUserIndexerAccessibility(
                    userIndexer!!,
                    requireGetter: true,
                    requireSetter: false,
                    diagnosticLocation
                ) {
                    return BoundErrorExpression(nil)
                }
                let refGetCall = BoundUserInstanceCallExpression(
                    nil,
                    target,
                    refGetter,
                    ImmutableArray.Create(convertedIndex),
                    refElementType
                )
                return BoundIndirectAssignmentExpression(
                    nil,
                    BoundAddressOfExpression(nil, refGetCall, unmanaged: false),
                    value
                )
            }
        }
        Diagnostics.ReportTypeNotIndexable(diagnosticLocation, targetType)
        return BoundErrorExpression(nil)
    }

    private func BuildSystemIndexOffset(
        indexValue BoundExpression,
        length BoundExpression,
        statements ImmutableArray[BoundStatement].Builder
    ) BoundExpression {
        let indexLocal = DeclareRangeTemp("index", indexValue.Type, indexValue, statements)
        // System.Index always declares the exact GetOffset(int) instance method.
        let getOffset = typeof(Index).GetMethod("GetOffset", []Type{typeof(int32)})!!
        return BoundImportedInstanceCallExpression(
            nil,
            BoundVariableExpression(nil, indexLocal),
            getOffset,
            TypeSymbol.Int32,
            ImmutableArray.Create(length)
        )
    }

    // `length - n` for a from-end index `^n`.
    private func MakeFromEndOffset(fromEnd FromEndIndexExpressionSyntax, lengthExpr BoundExpression) BoundExpression {
        let offset = conversions.BindConversion(fromEnd.Operand, TypeSymbol.Int32)
        let subtractOp = BoundBinaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int32, TypeSymbol.Int32)!!
        return BoundBinaryExpression(nil, lengthExpr, subtractOp, offset)
    }

    private func BindRangeSlice(
        target BoundExpression,
        $range RangeExpressionSyntax,
        targetLocation TextLocation
    ) BoundExpression {
        if target is BoundErrorExpression || target.Type == TypeSymbol.Error || target.Type == nil {
            if $range.LowerBound != nil {
                let _ = BindExpression($range.LowerBound)
            }
            if $range.UpperBound != nil {
                let _ = BindExpression($range.UpperBound)
            }
            return BoundErrorExpression(nil)
        }
        if NativeSliceTypes.TryGetElement(target.Type, out _, out _) {
            return BindNativeSliceRange(target, $range)
        }
        let arrayElement TypeSymbol? = GetArraySliceElementType(target.Type)
        if arrayElement != nil {
            return BindArraySlice(target, $range, arrayElement)
        }
        if target.Type == TypeSymbol.String {
            return BindStringSlice(target, $range)
        }
        let clrType Type? = target.Type.ClrType
        if clrType != nil {
            if TryFindRangeIndexer(clrType, out var rangeIndexer) {
                return BindRangeIndexerSlice(target, $range, rangeIndexer)
            }
            if TryFindSliceShape(clrType, out var lengthMember, out var sliceMethod) {
                return BindSpanLikeSlice(target, $range, lengthMember, sliceMethod)
            }
        }
        Diagnostics.ReportTypeNotSliceable($range.Location, target.Type)
        return BoundErrorExpression(nil)
    }

    private func DeclareRangeTemp(
        role string,
        type TypeSymbol,
        initializer BoundExpression,
        statements ImmutableArray[BoundStatement].Builder
    ) LocalVariableSymbol {
        let name = "$$slice_" + role + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
            CultureInfo.InvariantCulture
        )
        let local = LocalVariableSymbol(name, isReadOnly: true, type: type)
        $scope.TryDeclareVariable(local)
        statements.Add(BoundVariableDeclaration(nil, local, initializer))
        return local
    }

    // Binds the lower/upper bounds (each optional, each possibly a from-end
    // `^n` marker — issue #1022) as int32 expressions and emits the `src`,
    // source-length, `start`, and `len` temporaries shared by the array,
    // string, and span-like slicing paths. A from-end bound `^n` lowers to
    // `srcLen - n`; an open lower bound is `0` and an open upper bound is
    // `srcLen`. `len = upper - start`.
    private func BuildSliceBounds(
        target BoundExpression,
        $range RangeExpressionSyntax,
        lengthOf(BoundExpression) -> BoundExpression,
        statements ImmutableArray[BoundStatement].Builder
    )(Src BoundExpression, Start BoundExpression, Len BoundExpression) {
        let srcLocal = DeclareRangeTemp("src", target.Type, target, statements)
        let SrcRef = func () BoundExpression {
            return BoundVariableExpression(nil, srcLocal)
        }
        // Compute the source length once; required for open upper bounds and for
        // any from-end (`^n`) bound, and harmless otherwise.
        let srcLenLocal = DeclareRangeTemp("srclen", TypeSymbol.Int32, lengthOf(SrcRef()), statements)
        let SrcLenRef = func () BoundExpression {
            return BoundVariableExpression(nil, srcLenLocal)
        }
        let lowerBound = BindRangeBoundValue(
            BindRangeBound($range.LowerBound),
            SrcLenRef,
            BoundLiteralExpression(nil, 0),
            statements
        )
        let startLocal = DeclareRangeTemp("start", TypeSymbol.Int32, lowerBound, statements)
        let startRef = BoundVariableExpression(nil, startLocal)
        let upperBound = BindRangeBoundValue(BindRangeBound($range.UpperBound), SrcLenRef, SrcLenRef(), statements)
        let subtractOp = BoundBinaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int32, TypeSymbol.Int32)!!
        let lengthExpr = BoundBinaryExpression(nil, upperBound, subtractOp, startRef)
        let lenLocal = DeclareRangeTemp("len", TypeSymbol.Int32, lengthExpr, statements)
        return (
            BoundVariableExpression(nil, srcLocal),
            BoundVariableExpression(nil, startLocal),
            BoundVariableExpression(nil, lenLocal)
        )
    }

    // ADR-0187: bind one written range bound exactly once. A `^n` marker keeps
    // its int32 operand and from-end flag so the direct slicing paths can
    // resolve it against the source length; a bound that is already a
    // `System.Index` value (`i..j` over saved indices, `(^1)..`) is kept as an
    // Index; any other bound converts to an int32 from-start offset.
    private func BindRangeBound(boundSyntax ExpressionSyntax?) RangeBound? {
        if boundSyntax == nil {
            return nil
        }
        if boundSyntax is FromEndIndexExpressionSyntax fromEnd {
            return RangeBound(
                conversions.BindConversion(fromEnd.Operand, TypeSymbol.Int32),
                FromEnd: true,
                IsIndexValue: false
            )
        }
        if (boundSyntax is DefaultExpressionSyntax or InterpolatedStringExpressionSyntax) {
            return RangeBound(
                conversions.BindConversion(boundSyntax, TypeSymbol.Int32),
                FromEnd: false,
                IsIndexValue: false
            )
        }
        let bound = BindExpression(boundSyntax)
        if !(bound is BoundErrorExpression) && ClrTypeUtilities.AreSame(bound.Type?.ClrType, typeof(Index)) {
            return RangeBound(bound, FromEnd: false, IsIndexValue: true)
        }
        return RangeBound(
            conversions.BindConversion(boundSyntax.Location, bound, TypeSymbol.Int32),
            FromEnd: false,
            IsIndexValue: false
        )
    }

    // Issue #1022: resolve a bound range bound to an int32 offset. A from-end
    // marker `^n` lowers to `srcLen - n`; an Index value resolves through
    // `Index.GetOffset(srcLen)` (ADR-0187); a missing bound uses
    // <paramref name="defaultValue"/>; otherwise the bound is the plain value.
    private func BindRangeBoundValue(
        bound RangeBound?,
        srcLenRef() -> BoundExpression,
        defaultValue BoundExpression,
        statements ImmutableArray[BoundStatement].Builder
    ) BoundExpression {
        if bound is not{} value {
            return defaultValue
        }
        if value.IsIndexValue {
            return BuildSystemIndexOffset(value.Value, srcLenRef(), statements)
        }
        if value.FromEnd {
            let subtractOp = BoundBinaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int32, TypeSymbol.Int32)!!
            return BoundBinaryExpression(nil, srcLenRef(), subtractOp, value.Value)
        }
        return value.Value
    }

    private func BindArraySlice(
        target BoundExpression,
        $range RangeExpressionSyntax,
        elementType TypeSymbol
    ) BoundExpression {
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let lengthOf(BoundExpression) -> BoundExpression = (src BoundExpression) -> BoundLenExpression(nil, src)
        let (srcRef, startRef, lenRef) = BuildSliceBounds(target, $range, lengthOf, statements)
        let resultType = SliceTypeSymbol.Get(elementType)
        // dst = new T[len]
        let dstLocal = DeclareRangeTemp(
            "dst",
            resultType,
            BoundArrayCreationExpression(nil, resultType, lenRef),
            statements
        )
        let dstRef = BoundVariableExpression(nil, dstLocal)
        // Array.Copy(src, start, dst, 0, len)
        let copyMethod = typeof(Array).GetMethod(
            "Copy",
            []Type{typeof(Array), typeof(int32), typeof(Array), typeof(int32), typeof(int32)}
        )!!
        let copyCall = BoundClrStaticCallExpression(
            nil,
            copyMethod,
            TypeSymbol.Void,
            ImmutableArray.Create[BoundExpression](srcRef, startRef, dstRef, BoundLiteralExpression(nil, 0), lenRef)
        )
        statements.Add(BoundExpressionStatement(nil, copyCall))
        return BoundBlockExpression($range, statements.ToImmutable(), BoundVariableExpression(nil, dstLocal))
    }

    private func BindStringSlice(target BoundExpression, $range RangeExpressionSyntax) BoundExpression {
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let lengthOf(BoundExpression) -> BoundExpression = (src BoundExpression) -> BoundLenExpression(nil, src)
        let (srcRef, startRef, lenRef) = BuildSliceBounds(target, $range, lengthOf, statements)
        // System.String always declares the exact Substring(int, int) method.
        let substring = typeof(string).GetMethod("Substring", []Type{typeof(int32), typeof(int32)})!!
        let call = BoundImportedInstanceCallExpression(
            nil,
            srcRef,
            substring,
            TypeSymbol.String,
            ImmutableArray.Create[BoundExpression](startRef, lenRef)
        )
        return BoundBlockExpression($range, statements.ToImmutable(), call)
    }

    private func BindSpanLikeSlice(
        target BoundExpression,
        $range RangeExpressionSyntax,
        lengthMember MemberInfo,
        sliceMethod MethodInfo
    ) BoundExpression {
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let lengthOf(BoundExpression) -> BoundExpression = (src BoundExpression) -> BoundClrPropertyAccessExpression(
            nil,
            src,
            lengthMember,
            TypeSymbol.Int32
        )
        let (srcRef, startRef, lenRef) = BuildSliceBounds(target, $range, lengthOf, statements)
        let returnType = SliceResultType(
            target,
            sliceMethod.ReturnType,
            ClrNullability.GetReturnTypeSymbol(sliceMethod)
        )
        let call = BoundImportedInstanceCallExpression(
            nil,
            srcRef,
            sliceMethod,
            returnType,
            ImmutableArray.Create[BoundExpression](startRef, lenRef)
        )
        return BoundBlockExpression($range, statements.ToImmutable(), call)
    }

    private func BindRangeIndexerSlice(
        target BoundExpression,
        $range RangeExpressionSyntax,
        indexer PropertyInfo
    ) BoundExpression {
        let rangeValue = BuildSystemRangeValue($range)
        let resultType = SliceResultType(target, indexer.PropertyType, ClrNullability.GetPropertyTypeSymbol(indexer))
        return BoundClrIndexExpression($range, target, indexer, ImmutableArray.Create(rangeValue), resultType)
    }

    // Issue #1016/#1022/#1038: construct a `System.Range` value from a range
    // expression's bounds. Each bound becomes a `System.Index`: an open lower
    // defaults to the start (`Index(0, fromEnd: false)`), an open upper to the
    // end (`Index(0, fromEnd: true)`), a `^n` marker to `Index(n, fromEnd:
    // true)`, a bound that is already a `System.Index` value is used as-is
    // (ADR-0187: `^3..^1`, `i..j`), and a plain value `v` to `Index(v,
    // fromEnd: false)`. Shared by the `this[System.Range]` indexer-slice path
    // (#1016), the native-slice path, and the standalone range value (#1038).
    // Bounds are bound, and therefore evaluated, exactly once, left to right.
    private func BuildSystemRangeValue($range RangeExpressionSyntax) BoundExpression {
        let lower = BindRangeBound($range.LowerBound)
        let upper = BindRangeBound($range.UpperBound)
        return BuildSystemRangeValue(lower, upper)
    }

    // ADR-0187: bind a first-class `^n` expression to a `System.Index` value.
    private func BindFromEndIndexValue(syntax FromEndIndexExpressionSyntax) BoundExpression {
        let _ = TryBindSystemIndexValue(syntax, out var indexValue)
        return Invariant.Required(
            indexValue,
            "TryBindSystemIndexValue always binds a from-end index expression",
            expression: "indexValue"
        )
    }

    // Issue #1038 / ADR-0187: bind a standalone range expression (`let r =
    // 1..3`, `^4..^1`, `..`) to a constructed `System.Range` value.
    private func BindStandaloneRange($range RangeExpressionSyntax) BoundExpression -> BuildSystemRangeValue($range)

    /// ADR-0187: one bound written in a range expression, bound exactly once.
    /// @param Value The bound int32 offset or `System.Index` value.
    /// @param FromEnd Whether [`Value`](paramref) is the operand of a written `^n` marker.
    /// @param IsIndexValue Whether [`Value`](paramref) is already a `System.Index`.
    private data struct RangeBound(Value BoundExpression, FromEnd bool, IsIndexValue bool) : IEquatable[RangeBound] { }

    // Issue #1038: slice a target by a runtime `System.Range` value (`a[r]`,
    // where `r : System.Range`). Mirrors the syntactic `a[1..3]` shapes from
    // #1016 but reads the concrete `start`/`length` from the range value via
    // `System.Index.GetOffset(length)` rather than from syntactic bounds:
    //   - arrays / slices (`[N]T`, `[]T`, CLR `T[]`) -> new T[len] + Array.Copy.
    //   - `string` -> Substring(start, len).
    //   - span-like types (`int Length`/`Count` + `Slice(int, int)`).
    //   - a type exposing `this[System.Range]` -> call it with the value directly.
    private func BindRangeValueSlice(
        target BoundExpression,
        rangeValue BoundExpression,
        targetLocation TextLocation
    ) BoundExpression {
        let arrayElement TypeSymbol? = GetArraySliceElementType(target.Type)
        if arrayElement != nil {
            let statements = ImmutableArray.CreateBuilder[BoundStatement]()
            let lengthOf(BoundExpression) -> BoundExpression = (src BoundExpression) -> BoundLenExpression(nil, src)
            let (srcRef, startRef, lenRef) = BuildRangeValueBounds(target, rangeValue, lengthOf, statements)
            let resultType = SliceTypeSymbol.Get(arrayElement)
            let dstLocal = DeclareRangeTemp(
                "dst",
                resultType,
                BoundArrayCreationExpression(nil, resultType, lenRef),
                statements
            )
            let dstRef = BoundVariableExpression(nil, dstLocal)
            let copyMethod = typeof(Array).GetMethod(
                "Copy",
                []Type{typeof(Array), typeof(int32), typeof(Array), typeof(int32), typeof(int32)}
            )!!
            let copyCall = BoundClrStaticCallExpression(
                nil,
                copyMethod,
                TypeSymbol.Void,
                ImmutableArray.Create[BoundExpression](srcRef, startRef, dstRef, BoundLiteralExpression(nil, 0), lenRef)
            )
            statements.Add(BoundExpressionStatement(nil, copyCall))
            return BoundBlockExpression(nil, statements.ToImmutable(), BoundVariableExpression(nil, dstLocal))
        }
        if target.Type == TypeSymbol.String {
            let statements = ImmutableArray.CreateBuilder[BoundStatement]()
            let lengthOf(BoundExpression) -> BoundExpression = (src BoundExpression) -> BoundLenExpression(nil, src)
            let (srcRef, startRef, lenRef) = BuildRangeValueBounds(target, rangeValue, lengthOf, statements)
            // System.String always declares the exact Substring(int, int) method.
            let substring = typeof(string).GetMethod("Substring", []Type{typeof(int32), typeof(int32)})!!
            let call = BoundImportedInstanceCallExpression(
                nil,
                srcRef,
                substring,
                TypeSymbol.String,
                ImmutableArray.Create[BoundExpression](startRef, lenRef)
            )
            return BoundBlockExpression(nil, statements.ToImmutable(), call)
        }
        let clrType Type? = target.Type.ClrType
        if clrType != nil {
            if TryFindRangeIndexer(clrType, out var rangeIndexer) {
                let resultType = SliceResultType(
                    target,
                    rangeIndexer.PropertyType,
                    ClrNullability.GetPropertyTypeSymbol(rangeIndexer)
                )
                return BoundClrIndexExpression(nil, target, rangeIndexer, ImmutableArray.Create(rangeValue), resultType)
            }
            if TryFindSliceShape(clrType, out var lengthMember, out var sliceMethod) {
                let statements = ImmutableArray.CreateBuilder[BoundStatement]()
                let lengthOf(BoundExpression) -> BoundExpression = (
                    src BoundExpression
                ) -> BoundClrPropertyAccessExpression(nil, src, lengthMember!!, TypeSymbol.Int32)
                let (srcRef, startRef, lenRef) = BuildRangeValueBounds(target, rangeValue, lengthOf, statements)
                let returnType = SliceResultType(
                    target,
                    sliceMethod.ReturnType,
                    ClrNullability.GetReturnTypeSymbol(sliceMethod)
                )
                let call = BoundImportedInstanceCallExpression(
                    nil,
                    srcRef,
                    sliceMethod,
                    returnType,
                    ImmutableArray.Create[BoundExpression](startRef, lenRef)
                )
                return BoundBlockExpression(nil, statements.ToImmutable(), call)
            }
        }
        Diagnostics.ReportTypeNotSliceable(targetLocation, target.Type)
        return BoundErrorExpression(nil)
    }

    // Issue #1038: emit the `src`/`start`/`len` temporaries for slicing by a
    // runtime `System.Range` value. The source length is computed once; the
    // range's `Start`/`End` indices are resolved to concrete offsets via
    // `System.Index.GetOffset(length)`, and `len = end - start`.
    private func BuildRangeValueBounds(
        target BoundExpression,
        rangeValue BoundExpression,
        lengthOf(BoundExpression) -> BoundExpression,
        statements ImmutableArray[BoundStatement].Builder
    )(Src BoundExpression, Start BoundExpression, Len BoundExpression) {
        let indexSym = TypeSymbol.FromClrTypeWithoutNullability(typeof(Index), NullabilityFreeReason.TypeLiteral)
        let startProp = typeof(Range).GetProperty("Start")!!
        let endProp = typeof(Range).GetProperty("End")!!
        let getOffset = typeof(Index).GetMethod("GetOffset", []Type{typeof(int32)})!!
        let srcLocal = DeclareRangeTemp("src", target.Type, target, statements)
        let SrcRef = func () BoundExpression {
            return BoundVariableExpression(nil, srcLocal)
        }
        let srcLenLocal = DeclareRangeTemp("srclen", TypeSymbol.Int32, lengthOf(SrcRef()), statements)
        let SrcLenRef = func () BoundExpression {
            return BoundVariableExpression(nil, srcLenLocal)
        }
        let rngLocal = DeclareRangeTemp("rng", rangeValue.Type, rangeValue, statements)
        let RngRef = func () BoundExpression {
            return BoundVariableExpression(nil, rngLocal)
        }
        // Resolve Start/End (System.Index) into addressable locals so the
        // struct-receiver GetOffset call has an address to load.
        let startIdxLocal = DeclareRangeTemp(
            "startidx",
            indexSym,
            BoundClrPropertyAccessExpression(nil, RngRef(), startProp, indexSym),
            statements
        )
        let endIdxLocal = DeclareRangeTemp(
            "endidx",
            indexSym,
            BoundClrPropertyAccessExpression(nil, RngRef(), endProp, indexSym),
            statements
        )
        let startExpr = BoundImportedInstanceCallExpression(
            nil,
            BoundVariableExpression(nil, startIdxLocal),
            getOffset,
            TypeSymbol.Int32,
            ImmutableArray.Create[BoundExpression](SrcLenRef())
        )
        let startLocal = DeclareRangeTemp("start", TypeSymbol.Int32, startExpr, statements)
        let endExpr = BoundImportedInstanceCallExpression(
            nil,
            BoundVariableExpression(nil, endIdxLocal),
            getOffset,
            TypeSymbol.Int32,
            ImmutableArray.Create[BoundExpression](SrcLenRef())
        )
        let endLocal = DeclareRangeTemp("end", TypeSymbol.Int32, endExpr, statements)
        let subtractOp = BoundBinaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int32, TypeSymbol.Int32)!!
        let lengthExpr = BoundBinaryExpression(
            nil,
            BoundVariableExpression(nil, endLocal),
            subtractOp,
            BoundVariableExpression(nil, startLocal)
        )
        let lenLocal = DeclareRangeTemp("len", TypeSymbol.Int32, lengthExpr, statements)
        return (
            BoundVariableExpression(nil, srcLocal),
            BoundVariableExpression(nil, startLocal),
            BoundVariableExpression(nil, lenLocal)
        )
    }

    private func ConvertArrayElementIndex(location TextLocation, boundIndex BoundExpression) BoundExpression {
        if IsWideIntegerIndexType(boundIndex.Type) {
            return conversions.BindConversion(location, boundIndex, TypeSymbol.NInt, allowExplicit: true)
        }
        return conversions.BindConversion(location, boundIndex, TypeSymbol.Int32)
    }

    // Issue #1279: `string` char-indexing (`s[i]`) lowers to the CLR
    // `get_Chars(int32)` accessor, so any integer index converts to int32 (an
    // explicit narrowing for the wider integer types). Non-integer indices
    // report GS0156 via the implicit int32 conversion.
    private func ConvertStringCharIndex(location TextLocation, boundIndex BoundExpression) BoundExpression {
        return conversions.BindConversion(
            location,
            boundIndex,
            TypeSymbol.Int32,
            allowExplicit: IsWideIntegerIndexType(boundIndex.Type)
        )
    }

    // Issue #1279: bind an array/slice element index from syntax. A
    // default/interpolated index carries no natural type, so it keeps the
    // historical target-typed int32 conversion; every other index is bound and
    // then converted via the integer-aware element-index rule above.
    private func BindArrayElementIndex(indexSyntax ExpressionSyntax) BoundExpression {
        if indexSyntax is DefaultExpressionSyntax || indexSyntax is InterpolatedStringExpressionSyntax {
            return conversions.BindConversion(indexSyntax, TypeSymbol.Int32)
        }
        let boundIndex = BindExpression(indexSyntax)
        if boundIndex is BoundErrorExpression {
            return boundIndex
        }
        return ConvertArrayElementIndex(indexSyntax.Location, boundIndex)
    }

    private func BindRectangularArrayElementIndex(indexSyntax ExpressionSyntax) BoundExpression {
        if indexSyntax is DefaultExpressionSyntax || indexSyntax is InterpolatedStringExpressionSyntax {
            return conversions.BindConversion(indexSyntax, TypeSymbol.Int32)
        }
        let boundIndex = BindExpression(indexSyntax)
        if boundIndex is BoundErrorExpression {
            return boundIndex
        }
        return conversions.BindConversion(
            indexSyntax.Location,
            boundIndex,
            TypeSymbol.Int32,
            allowExplicit: IsWideIntegerIndexType(boundIndex.Type)
        )
    }

    /// Issue #662: detect the pattern `valueTask.GetAwaiter().GetResult()` and
    /// emit warning GS0275. The pattern is unsafe due to ValueTask's single-await
    /// semantics. The safe form is `valueTask.AsTask().GetAwaiter().GetResult()`.
    private func CheckValueTaskGetAwaiterGetResult(boundCall BoundExpression, callSyntax CallExpressionSyntax) {
        // The outermost call must be GetResult() with 0 args on a CLR instance.
        if boundCall is not BoundImportedInstanceCallExpression getResultCall {
            return
        }
        if getResultCall.Method.Name != "GetResult" || getResultCall.Arguments.Length != 0 {
            return
        }
        // Its receiver must be a CLR instance call to GetAwaiter() with 0 args.
        if getResultCall.Receiver is not BoundImportedInstanceCallExpression getAwaiterCall {
            return
        }
        if getAwaiterCall.Method.Name != "GetAwaiter" || getAwaiterCall.Arguments.Length != 0 {
            return
        }
        // The receiver of GetAwaiter() must have a ValueTask or ValueTask<T> type.
        let awaiterReceiverType Type? = getAwaiterCall.Receiver?.Type?.ClrType
        if awaiterReceiverType == nil {
            return
        }
        var fullName string?
        if awaiterReceiverType.IsGenericType && !awaiterReceiverType.IsGenericTypeDefinition {
            fullName = awaiterReceiverType.GetGenericTypeDefinition()?.FullName
        } else {
            fullName = awaiterReceiverType.FullName
        }
        if fullName == "System.Threading.Tasks.ValueTask" || fullName == "System.Threading.Tasks.ValueTask`1" {
            Diagnostics.ReportValueTaskDirectGetResult(callSyntax.Identifier.Location)
        }
    }

    /// Issue #1235: resolves an instance field/property read named on a
    /// receiver whose static type is a (cref:TypeParameterSymbol),
    /// against the type parameter's class constraint (including inherited
    /// members) or interface constraint. Instance method <em>calls</em> are
    /// handled separately in `ExpressionBinder.Calls`; this surfaces the
    /// remaining member kinds (fields and properties) so a constrained type
    /// parameter exposes its constraint's full instance member surface.
    /// Returns `null` when no such member exists (so the caller
    /// reports GS0158).
    /// @param tpRecv The type-parameter receiver's type.
    /// @param receiver The bound receiver expression.
    /// @param ne The member-name syntax.
    /// @returns The bound member access, or `null`.
    private func BindTypeParameterInstanceMemberAccess(
        tpRecv TypeParameterSymbol,
        receiver BoundExpression,
        ne NameExpressionSyntax
    ) BoundExpression? {
        let memberName = ne.IdentifierToken.ValueText
        // Class constraint (issue #1056 surfaced methods; this adds the rest):
        // fields and properties, walking the base chain of the constraint class.
        if tpRecv.ClassConstraint is StructSymbol classConstraint {
            if TypeMemberModel.TryGetFieldIncludingInherited(
                classConstraint,
                memberName,
                MemberQuery.Instance(MemberKinds.Field),
                out var field,
                out var fieldDeclaringType
            ) {
                reportObsoleteUseIfApplicable(
                    ne.IdentifierToken.Location,
                    field,
                    "${fieldDeclaringType.Name}.${field.Name}"
                )
                if !AccessibilityChecker.IsAccessible(field.Accessibility, fieldDeclaringType, this.function) {
                    Diagnostics.ReportMemberInaccessible(
                        ne.IdentifierToken.Location,
                        field.Name,
                        fieldDeclaringType.Name,
                        field.Accessibility
                    )
                }
                return ApplyMemberNarrowing(BoundFieldAccessExpression(nil, receiver, fieldDeclaringType, field))
            }
            if TypeMemberModel.TryGetProperty(classConstraint, memberName, out var prop, out var propDeclaringType) {
                propDeclaringType = Invariant.Required(
                    propDeclaringType,
                    "a constrained property has a declaring type",
                    expression: "propDeclaringType"
                )
                if !prop.HasGetter {
                    Diagnostics.ReportCannotAssign(ne.Location, memberName)
                    return BoundErrorExpression(nil)
                }
                if !AccessibilityChecker.IsAccessible(prop.GetterAccessibility, propDeclaringType, this.function) {
                    Diagnostics.ReportMemberInaccessible(
                        ne.IdentifierToken.Location,
                        prop.Name,
                        propDeclaringType.Name,
                        prop.GetterAccessibility
                    )
                }
                return ApplyMemberNarrowing(BoundPropertyAccessExpression(nil, receiver, propDeclaringType, prop))
            }
        }
        let importedClassConstraint TypeSymbol? = tpRecv.ClassConstraint
        let importedClass Type? = importedClassConstraint?.ClrType
        if importedClassConstraint != nil && importedClass != nil {
            let clrProperty PropertyInfo? = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(
                importedClass,
                memberName,
                BindingFlags.Public | BindingFlags.Instance
            )
            if clrProperty != nil && clrProperty.GetIndexParameters().Length == 0 {
                if clrProperty.GetGetMethod(nonPublic: false) == nil {
                    Diagnostics.ReportCannotAssign(ne.Location, memberName)
                    return BoundErrorExpression(nil)
                }
                let propertyType = MemberLookup.GetClrPropertyTypeSymbol(importedClassConstraint, clrProperty)
                let declaringConstraint = MemberLookup.GetClrMemberDeclaringTypeSymbol(
                    importedClassConstraint,
                    clrProperty
                )
                return ConversionClassifier.AutoDereferenceRefReturn(
                    BoundClrPropertyAccessExpression(
                        nil,
                        receiver,
                        clrProperty,
                        propertyType,
                        constrainedReceiverTypeParameter: tpRecv,
                        constrainedInterfaceType: declaringConstraint
                    )
                )
            }
        }
        // Interface constraint: an instance property declared on the
        // interface or any base interface. The getter dispatches through a
        // verifiable `box !!T; callvirt I::get_X` in the emitter.
        if tpRecv.InterfaceConstraint is InterfaceSymbol interfaceConstraint && this.BindSourceInterfacePropertyAccess(
            interfaceConstraint,
            receiver,
            ne
        ) is {} propertyAccess {
            return propertyAccess
        }
        if tpRecv.ClrInterfaceConstraint is TypeSymbol clrInterfaceConstraint &&
            clrInterfaceConstraint.ClrType is Type clrInterface &&
            clrInterface
            .IsInterface {
            let clrProperty PropertyInfo? = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(
                clrInterface,
                memberName,
                BindingFlags.Public | BindingFlags.Instance
            )
            if clrProperty != nil && clrProperty.GetIndexParameters().Length == 0 {
                if clrProperty.GetGetMethod(nonPublic: false) == nil {
                    Diagnostics.ReportCannotAssign(ne.Location, memberName)
                    return BoundErrorExpression(nil)
                }
                let propertyType = MemberLookup.GetClrPropertyTypeSymbol(clrInterfaceConstraint, clrProperty)
                let declaringInterface = MemberLookup.GetClrMemberDeclaringTypeSymbol(
                    clrInterfaceConstraint,
                    clrProperty
                )
                return ConversionClassifier.AutoDereferenceRefReturn(
                    BoundClrPropertyAccessExpression(
                        nil,
                        receiver,
                        clrProperty,
                        propertyType,
                        constrainedReceiverTypeParameter: tpRecv,
                        constrainedInterfaceType: declaringInterface
                    )
                )
            }
        }
        return nil
    }

    private func BindSourceInterfacePropertyAccess(
        receiverType InterfaceSymbol,
        receiver BoundExpression,
        syntax NameExpressionSyntax
    ) BoundExpression? {
        if !TypeMemberModel.TryGetPropertyWithOwner(
            receiverType,
            syntax.IdentifierToken.ValueText,
            out var property,
            out var owner
        ) {
            return nil
        }
        if !property.HasGetter {
            Diagnostics.ReportCannotAssign(syntax.Location, syntax.IdentifierToken.ValueText)
            return BoundErrorExpression(nil)
        }
        if !AccessibilityChecker.IsAccessible(property.GetterAccessibility, owner, this.function) {
            Diagnostics.ReportMemberInaccessible(
                syntax.IdentifierToken.Location,
                property.Name,
                owner?.Name ?? receiverType.Name,
                property.GetterAccessibility
            )
        }
        let interfaceOwner = owner as InterfaceSymbol
        let propertyType = interfaceOwner?.SubstituteMemberType(property.Type) ?? property.Type
        return BoundPropertyAccessExpression(
            nil,
            receiver,
            nil,
            property,
            if object.ReferenceEquals(propertyType, property.Type) {
                default(TypeSymbol?)
            } else {
                propertyType
            },
            narrowedType: nil,
            interfaceType: interfaceOwner
        )
    }

    /// ADR-0089 / issue #755: resolves `T.Method(args)` against the
    /// static-virtual interface members of [`tpSym`](paramref)'s
    /// constraint. Produces a (cref:BoundConstrainedStaticCallExpression)
    /// at the call site; reports GS0333 when the named member is not a
    /// static-virtual on any constraint interface.
    private func BindTypeParameterStaticAccessorStep(
        tpSym TypeParameterSymbol,
        leftName NameExpressionSyntax,
        rightPart ExpressionSyntax
    ) BoundExpression {
        let result = BindTypeParameterStaticAccessorStepCore(tpSym, leftName, rightPart)
        RecordStaticTypeQualifier(result, tpSym, rightPart)
        return result
    }

    private func BindTypeParameterStaticAccessorStepCore(
        tpSym TypeParameterSymbol,
        leftName NameExpressionSyntax,
        rightPart ExpressionSyntax
    ) BoundExpression {
        // Issue #3525: a type parameter constrained to an imported CLR
        // interface (e.g. `T : IParsable[T]`) has no InterfaceConstraint —
        // its static-virtual members are reached through ClrInterfaceConstraint
        // instead. Only bail out here when NEITHER constraint shape is present.
        if tpSym.InterfaceConstraint == nil && tpSym.ClrInterfaceConstraint == nil {
            Diagnostics.ReportStaticVirtualMemberNotFoundOnTypeParameter(
                leftName.Location,
                tpSym.Name,
                if rightPart is CallExpressionSyntax ce0 {
                    ce0.Identifier.ValueText
                } else {
                    (
                        if rightPart is NameExpressionSyntax ne0 {
                            ne0.IdentifierToken.ValueText
                        } else {
                            "?"
                        }
                    )
                }
            )
            return BoundErrorExpression(nil)
        }
        switch rightPart {
            case nested is AccessorExpressionSyntax {
                // Issue #2962: the parser folds `T.V.Member` as
                // `T.(V.Member)`. Bind the constrained static property first,
                // then continue the remaining chain against its value.
                let head = BindTypeParameterStaticAccessorStep(tpSym, leftName, nested.LeftPart)
                if head is BoundErrorExpression {
                    return head
                }
                if nested.IsNullConditional {
                    return BindNullConditionalAccessExpressionCore(head, nested.RightPart)
                }
                return BindAccessorStep(head, nil, nested.RightPart)
            }
            case ix is IndexExpressionSyntax {
                let indexTarget = BindTypeParameterStaticAccessorStep(tpSym, leftName, ix.Target)
                if indexTarget is BoundErrorExpression {
                    return indexTarget
                }
                if ix.IsNullConditional {
                    return BindNullConditionalIndexFromBoundTarget(indexTarget, ix)
                }
                return if ix.Indices.Count > 1 || IsRectangularArrayType(indexTarget.Type) {
                    BindRectangularIndexAgainstTarget(indexTarget, ix.Indices, ix.Target.Location)
                } else {
                    BindIndexAgainstTarget(indexTarget, ix.Index, ix.Target.Location)
                }
            }
            case callSyntax is CallExpressionSyntax {
                {
                    let methodName = callSyntax.Identifier.ValueText
                    if tpSym.InterfaceConstraint != nil {
                        var slot FunctionSymbol? = nil
                        for candidate in TypeMemberModel.GetMethods(
                            tpSym.InterfaceConstraint!!,
                            methodName,
                            MemberQuery.Static(MemberKinds.Method)
                        ) {
                            if candidate.Parameters.Length == callSyntax.Arguments.Count {
                                slot = candidate
                                break
                            }
                        }
                        if slot != nil {
                            let boundArgs = ImmutableArray.CreateBuilder[BoundExpression](callSyntax.Arguments.Count)
                            for var i = 0; i < callSyntax.Arguments.Count; i++ {
                                boundArgs.Add(BindExpression(callSyntax.Arguments[i]))
                            }
                            // Substitute the slot's return type T → caller's T
                            // (which is also the receiver tpSym). The slot was
                            // bound on the open interface definition so its return
                            // type might still mention the interface's own type
                            // parameter symbol — translate it through the
                            // constructed interface's TypeArguments.
                            let returnType = SubstituteThroughConstructedInterface(
                                slot.Type,
                                tpSym.InterfaceConstraint!!
                            )
                            return BoundConstrainedStaticCallExpression(
                                callSyntax,
                                tpSym,
                                slot,
                                boundArgs.MoveToImmutable(),
                                returnType
                            )
                        }
                    }
                    // Issue #3525: the constraint is (or also is) an imported CLR
                    // interface declaring a static-virtual member — e.g.
                    // `T : IParsable[T]` and `T.TryParse(...)`. Resolve the
                    // static method via reflection rather than TypeMemberModel,
                    // mirroring the imported-instance CLR path (issue #943).
                    if tpSym.ClrInterfaceConstraint is TypeSymbol clrConstraint &&
                        clrConstraint.ClrType is Type clrInterface &&
                        clrInterface.IsInterface &&
                        TryBindTypeParameterStaticClrCall(
                        tpSym,
                        clrConstraint,
                        clrInterface,
                        methodName,
                        callSyntax,
                        out var clrCall
                    ) {
                        return clrCall!!
                    }
                    Diagnostics.ReportStaticVirtualMemberNotFoundOnTypeParameter(
                        leftName.Location,
                        tpSym.Name,
                        methodName
                    )
                    return BoundErrorExpression(nil)
                }
            }
            case ne is NameExpressionSyntax {
                {
                    // ADR-0089 / issue #1019: a static-virtual interface
                    // *property* read `T.Prop` dispatches through the
                    // property's getter accessor (a static-virtual slot),
                    // emitted as `constrained. !!T  call I::get_Prop()`.
                    let propName = ne.IdentifierToken.ValueText
                    var slotProp PropertySymbol? = nil
                    var slotIface InterfaceSymbol? = nil
                    for iface in tpSym.InterfaceConstraint?.SelfAndAllBaseInterfaces() ??
                        Enumerable
                        .Empty[InterfaceSymbol]() {
                        // Issue #1268: a constructed generic interface
                        // constraint (e.g. `T : IData[int32]` or the
                        // self-referential `T : IData[T]`) does not surface
                        // its declared static-virtual *properties* on the
                        // constructed instance — only methods are
                        // substituted onto it. Walk the open definition's
                        // property table so the slot is found regardless of
                        // whether the constraint is open or constructed; the
                        // getter resolved here is the open definition's
                        // static-virtual accessor (keyed in the emitter's
                        // MethodHandles), and the constructed interface is
                        // retained for type-argument substitution / emit.
                        let defIface = iface.Definition ?? iface
                        defIface.EnsureMembersResolved()
                        for candidate in defIface.Properties {
                            if candidate.IsStatic && candidate.Name == propName {
                                slotProp = candidate
                                slotIface = iface
                                break
                            }
                        }
                        if slotProp != nil {
                            break
                        }
                    }
                    if slotProp == nil || slotProp.GetterSymbol == nil || slotIface == nil {
                        Diagnostics.ReportStaticVirtualMemberNotFoundOnTypeParameter(
                            leftName.Location,
                            tpSym.Name,
                            propName
                        )
                        return BoundErrorExpression(nil)
                    }
                    let typeParameterMap = DeclarationBinder.BuildInterfaceTypeParameterMap(slotIface) ??
                        Dictionary[TypeParameterSymbol, TypeSymbol]()
                    let propType = DeclarationBinder.GetInterfacePropertyExpectedType(slotProp.Type, typeParameterMap)
                    return BoundConstrainedStaticCallExpression(
                        ne,
                        tpSym,
                        slotProp.GetterSymbol!!,
                        ImmutableArray[BoundExpression].Empty,
                        propType
                    )
                }
            }
            default {
                let accessText = rightPart.SyntaxTree.Text.ToString(rightPart.Span)
                Diagnostics.ReportStaticVirtualMemberNotFoundOnTypeParameter(rightPart.Location, tpSym.Name, accessText)
                return BoundErrorExpression(nil)
            }
        }
    }

    /// Issue #3525: resolves `T.Method(args)` against the static
    /// members declared by [`tp`](paramref)'s imported CLR interface
    /// constraint (e.g. `T.TryParse(...)` with `T : IParsable[T]`).
    /// Mirrors (cref:TryBindConstrainedClrCall)'s instance-call
    /// overload resolution, but against static candidates and without a
    /// receiver expression.
    /// @param tp The receiver type parameter, carrying the CLR interface constraint.
    /// @param constraintType The symbolic (possibly constructed generic) interface constraint.
    /// @param clrInterface The reflected interface type backing [`constraintType`](paramref).
    /// @param methodName The invoked method name.
    /// @param callSyntax The originating call-expression syntax.
    /// @param result The bound constrained static call on success.
    /// @returns `true` when a matching static method was found and bound.
    private func TryBindTypeParameterStaticClrCall(
        tp TypeParameterSymbol,
        constraintType TypeSymbol,
        clrInterface Type,
        methodName string,
        callSyntax CallExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        let candidates = List[MethodInfo]()
        for m in ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(
            clrInterface,
            BindingFlags.Public | BindingFlags.Static
        ) {
            if m.IsStatic && ClrTypeUtilities.EmittedMemberNameMatches(m, methodName) {
                candidates.Add(m)
            }
        }
        if candidates.Count == 0 {
            return false
        }
        if !overloads.TryAnalyzeCallArgumentLayout(callSyntax.Arguments, out _, out var argumentNames) {
            result = BoundErrorExpression(callSyntax)
            return true
        }
        let clrArgumentNames = if argumentNames.IsDefault {
            default(IReadOnlyList[string?]?)
        } else {
            cast[IReadOnlyList[string?]](argumentNames)
        }
        let boundArgs = ImmutableArray.CreateBuilder[BoundExpression](callSyntax.Arguments.Count)
        for var i = 0; i < callSyntax.Arguments.Count; i++ {
            boundArgs.Add(BindExpression(OverloadResolver.UnwrapNamedArgumentValue(callSyntax.Arguments[i])))
        }
        var arguments = boundArgs.MoveToImmutable()
        let argTypes = [arguments.Length]Type?
        for var i = 0; i < arguments.Length; i++ {
            let t Type? = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type)
            if t == nil && arguments[i].Type != TypeSymbol.Null {
                if !ClrOverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]) {
                    return false
                }
            }
            argTypes[i] = t
        }
        let interpolatedStringArgs = ComputeInterpolatedStringArgFlags(callSyntax.Arguments, arguments.Length)
        let symbolicArgTypes = MemberLookup.BuildSymbolicArgTypeVector(
            nil,
            ImmutableArray.CreateRange(arguments.Select((argument BoundExpression) -> argument.Type))
        )
        let recoverTypeArgSymbols(MethodInfo, bool) -> ImmutableArray[TypeSymbol?] = (
            closed MethodInfo,
            isExpanded bool
        ) -> {
            let refinedArgs = RefineSymbolicArgsForMethodGroups(
                closed,
                arguments,
                symbolicArgTypes,
                receiverArgCount: 0,
                isExpanded: isExpanded,
                argumentNames: clrArgumentNames,
                parameterMapping: default(ImmutableArray[int32]),
                methodGroupSlots: out var recoverMethodGroupSlots
            )
            // Issue #4133 (hot-core translation guard finding): see
            // MergeMethodGroupArgumentSlots's doc.
            recoverMethodGroupSlots = MergeMethodGroupArgumentSlots(
                arguments,
                receiverArgCount: 0,
                refinedArgs.Length,
                recoverMethodGroupSlots
            )
            return MemberLookup.BuildSymbolicMethodTypeArgs(
                closed,
                default(ImmutableArray[TypeSymbol]),
                refinedArgs,
                isExpanded,
                clrArgumentNames,
                recoverMethodGroupSlots
            )
        }
        let resolution = ClrOverloadResolution.Resolve(
            candidates,
            argTypes,
            nil,
            $scope.References!!.MapClrTypeToReferences,
            interpolatedStringArgs,
            argumentNames: clrArgumentNames,
            recoverTypeArgSymbols: recoverTypeArgSymbols,
            constantNarrowingArgumentCheck: MakeConstantNarrowingArgumentCheck(arguments),
            structuralProjectionArgumentCheck: MakeStructuralProjectionArgumentCheck(
                arguments,
                nativeConversions: conversions
            ),
            erasedArgumentMismatchCheck: MakeErasedArgumentMismatchCheck(arguments),
            delegateRefKindArgumentCheck: MakeDelegateRefKindArgumentCheck(arguments),
            methodGroupInference: MakeMethodGroupInference(arguments, GetEffectiveArgumentClrTypeForOverloadResolution),
            methodGroupArgumentCheck: MakeMethodGroupArgumentCheck(arguments),
            symbolicArgTypes: symbolicArgTypes,
            symbolicArgumentConversionClassifier: MakeSymbolicArgumentConversionClassifier(
                arguments,
                nativeConversions: conversions
            )
        )
        if resolution.Outcome == ClrOverloadResolution.ResolutionOutcome.Ambiguous {
            Diagnostics.ReportAmbiguousOverload(
                callSyntax.Location,
                methodName,
                resolution.Ambiguous.Length,
                resolution.Ambiguous.Select(ClrOverloadResolution.FormatMethodSignature)
            )
            result = BoundErrorExpression(callSyntax)
            return true
        }
        if resolution.Outcome != ClrOverloadResolution.ResolutionOutcome.Resolved || resolution.Best is not{} method {
            return false
        }
        let parameters = method.GetParameters()
        let refinedSymbolicArgs = RefineSymbolicArgsForMethodGroups(
            method,
            arguments,
            symbolicArgTypes,
            receiverArgCount: 0,
            isExpanded: resolution.IsExpanded,
            argumentNames: clrArgumentNames,
            parameterMapping: resolution.ParameterMapping,
            methodGroupSlots: out var finalMethodGroupSlots
        )
        // Issue #4133 (hot-core translation guard finding): see
        // MergeMethodGroupArgumentSlots's doc.
        finalMethodGroupSlots = MergeMethodGroupArgumentSlots(
            arguments,
            receiverArgCount: 0,
            refinedSymbolicArgs.Length,
            finalMethodGroupSlots
        )
        let symbolicMethodTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(
            method,
            default(ImmutableArray[TypeSymbol]),
            refinedSymbolicArgs,
            resolution.IsExpanded,
            clrArgumentNames,
            finalMethodGroupSlots
        )
        // Return type: a return that names the constraint type-variable is
        // recovered by projecting through the constructed constraint,
        // mirroring TryBindConstrainedClrCall's instance-call handling.
        let returnType = MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(
            method,
            symbolicMethodTypeArgs,
            constraintType
        ) ??
            MemberLookup.GetClrMethodReturnTypeSymbol(constraintType, method)
        let declaringConstraint = MemberLookup.GetClrMemberDeclaringTypeSymbol(constraintType, method)
        var downstreamMapping = resolution.ParameterMapping
        let expandedArgumentLocations = CaptureExpandedArgumentLocations(
            callSyntax,
            arguments.Length,
            downstreamMapping,
            parameters.Length,
            receiverArgCount: 0,
            resolution.IsExpanded
        )
        arguments = RebindFormattableInterpolationArguments(
            arguments,
            callSyntax.Arguments,
            parameters,
            downstreamMapping,
            isExpanded: resolution.IsExpanded
        )
        // Reviewer finding on #4142: the same gap as constrained instance
        // dispatch (ExpressionBinder.Calls.Arguments.cs,
        // TryBindConstrainedClrCall) — expanded resolution can select a
        // `params Handler[]` candidate for a custom
        // [InterpolatedStringHandler] element, but only FormattableString
        // rebinding ran here, so a handler-typed params element was packed
        // with an ordinary string interpolation and failed conversion
        // (measured: GS0155 "Cannot convert type 'string' to '<Handler>'").
        // Route it through the shared rewrite, BEFORE expansion, same as
        // every other resolved CLR call dispatch. There is no receiver at
        // all here (a constrained STATIC call), so the prelude/updated-
        // receiver outputs are discarded through the convenience overload.
        arguments = ApplyInterpolatedStringHandlers(
            parameters,
            arguments,
            receiver: nil,
            callSyntax.Location,
            downstreamMapping,
            resolution.IsExpanded
        )
        if resolution.IsExpanded {
            let symbolicParamsType = MemberLookup.GetClrMethodParameterTypeSymbol(
                constraintType,
                method,
                parameters.Length - 1
            )
            let symbolicParamsElement = if symbolicParamsType is SliceTypeSymbol symbolicParams {
                symbolicParams.ElementType
            } else {
                default(TypeSymbol?)
            }
            arguments = overloads.ExpandParamsArguments(
                arguments,
                parameters,
                callSyntax,
                parameterMapping: downstreamMapping,
                symbolicMethodTypeArgs: symbolicMethodTypeArgs,
                paramsElementTypeOverride: symbolicParamsElement
            )
            downstreamMapping = default(ImmutableArray[int32])
        }
        arguments = ApplySymbolicClrArgumentConversions(
            arguments,
            parameters,
            downstreamMapping,
            method,
            constraintType,
            symbolicMethodTypeArgs
        )
        arguments = if method.IsGenericMethod {
            conversions.BindClrParameterConversions(
                arguments,
                parameters,
                callSyntax,
                downstreamMapping,
                method: method,
                receiverType: constraintType,
                symbolicMethodTypeArgs: symbolicMethodTypeArgs,
                expandedParamsIndex: if resolution.IsExpanded {
                    parameters.Length - 1
                } else {
                    -1
                },
                parameterArgumentLocations: expandedArgumentLocations
            )
        } else {
            conversions.BindImplicitInClrArguments(
                arguments,
                parameters,
                callSyntax,
                downstreamMapping,
                method,
                constraintType,
                expandedArgumentLocations
            )
        }
        var orderedArgs = OverloadResolver.BuildOrderedCallArguments(arguments, downstreamMapping, parameters)
        if resolution.IsExpanded {
            orderedArgs = OverloadResolver.PreserveExpandedArgumentEvaluationOrder(
                orderedArgs,
                resolution.ParameterMapping
            )
        }
        let refKinds = ComputeArgumentRefKinds(parameters)
        result = BoundConstrainedStaticCallExpression(
            callSyntax,
            tp,
            method,
            orderedArgs,
            refKinds,
            returnType,
            declaringConstraint,
            symbolicMethodTypeArgs
        )
        return true
    }

    shared {
        /// Issue #4986: the names of the members `Nullable<T>` itself
        /// declares (`HasValue`, `Value`, `GetValueOrDefault`). Overrides of
        /// `object` members and accessor methods are left out, since every
        /// narrowed `T` has those already.
        private let NullableOnlyMemberNames HashSet[string] = HashSet[string](
            typeof(System.Nullable[_])
                .GetMembers(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
                .Where(
                (member MemberInfo) -> switch member {
                    case method is MethodInfo: !method.IsSpecialName && method.GetBaseDefinition()
                        .DeclaringType == method.DeclaringType
                    case _ is PropertyInfo: true
                    default: false
                }
            )
                .Select((member MemberInfo) -> member.Name),
            StringComparer.Ordinal
        )

        /// Issue #4986: the identifier token that names the first member an
        /// accessor step looks up: `Value` in `n.Value.X`,
        /// `GetValueOrDefault` in `n.GetValueOrDefault(7)`.
        /// @param rightPart The syntax after the receiver's `.`.
        /// @param callSyntax The unbound head call, or `nil` for a method group.
        /// @returns The head identifier token, or `nil` without a member name
        /// or for explicit generic calls (`Nullable<T>` has no generic methods).
        private func AccessorHeadToken(rightPart ExpressionSyntax?, out callSyntax CallExpressionSyntax?) SyntaxToken? {
            callSyntax = nil
            switch rightPart {
                case name is NameExpressionSyntax {
                    return name.IdentifierToken
                }
                case call is CallExpressionSyntax when call.TypeArgumentList == nil {
                    callSyntax = call
                    return call.Identifier
                }
                case accessor is AccessorExpressionSyntax {
                    return AccessorHeadToken(accessor.LeftPart, out callSyntax)
                }
                case index is IndexExpressionSyntax {
                    return AccessorHeadToken(index.Target, out callSyntax)
                }
                case creation is ObjectCreationExpressionSyntax {
                    return AccessorHeadToken(creation.Target, out callSyntax)
                }
                case collection is CollectionInitializerExpressionSyntax {
                    return AccessorHeadToken(collection.Target, out callSyntax)
                }
                case unary is UnaryExpressionSyntax when unary.OperatorToken.Kind == SyntaxKind.BangBangToken {
                    return AccessorHeadToken(unary.Operand, out callSyntax)
                }
            }
            return nil
        }

        private func TryGetTupleElementIndex(memberName string, tupleType TupleTypeSymbol, out zeroBased int32) bool {
            if string.IsNullOrEmpty(memberName) {
                zeroBased = -1
                return false
            }
            // ADR-0172: a declared element name resolves to its position;
            // `ItemN` and the zero-based `.N` selectors below stay valid on
            // named tuples too.
            if tupleType.TryGetElementIndexByName(memberName, out zeroBased) {
                return true
            }
            if int32.TryParse(memberName, out var numericIndex) && numericIndex >= 0 && numericIndex < tupleType.Arity {
                zeroBased = numericIndex
                return true
            }
            if memberName.StartsWith("Item", StringComparison.Ordinal) && int32.TryParse(
                memberName.Substring(4),
                out var oneBased
            ) &&
                oneBased >= 1 &&
                oneBased <= tupleType.Arity {
                zeroBased = oneBased - 1
                return true
            }
            zeroBased = -1
            return false
        }

        private func GetTupleFieldName(
            memberName string,
            tupleType TupleTypeSymbol
        ) string -> if TryGetTupleElementIndex(memberName, tupleType, out var index) {
            "Item" + (index + 1).ToString(CultureInfo.InvariantCulture)
        } else {
            memberName ?? string.Empty
        }

        private func RequiresSymbolicTupleElementInvocation(tupleType TupleTypeSymbol, index int32) bool {
            if !MemberLookup.TryGetDelegateFunctionTypeFromSymbol(tupleType.ElementTypes[index], out _) {
                return false
            }
            if tupleType.ClrType == nil {
                return true
            }
            let fieldName = "Item" + (index + 1).ToString(CultureInfo.InvariantCulture)
            let field FieldInfo? = ClrTypeUtilities.SafeGetField(
                tupleType.ClrType,
                fieldName,
                BindingFlags.Public | BindingFlags.Instance
            )
            return field == nil || !ClrTypeUtilities.IsDelegateType(field.FieldType)
        }

        /// Issue #3649: a DECLARED tuple element name (ADR-0172 — `t.f(10)`)
        /// never exists as a member on the tuple's CLR backing (element names are
        /// metadata-only; only `ItemN` fields are real), so a call through a
        /// declared name must always bind as element read + indirect invocation.
        /// Without this, only the (cref:RequiresSymbolicTupleElementInvocation)
        /// cases took the indirect path and `t.f(10)` fell through to CLR
        /// method lookup on `ValueTuple`, reporting "Cannot find function f"
        /// even though `let a = t.f; a(10)` worked. Positional `ItemN` /
        /// `.N` spellings keep their existing paths.
        private func RequiresDeclaredNameTupleElementInvocation(
            memberName string,
            tupleType TupleTypeSymbol,
            index int32
        ) bool {
            if !MemberLookup.TryGetDelegateFunctionTypeFromSymbol(tupleType.ElementTypes[index], out _) {
                return false
            }
            // Only declared element names need the indirect path here; the
            // canonical `ItemN` spelling resolves against the real CLR field, and
            // a declared name that IS `ItemN` behaves identically either way.
            return tupleType.TryGetElementIndexByName(memberName, out var namedIndex) && namedIndex == index
        }

        private func RefersToSameMemberSlot(
            selected BoundExpression,
            declared BoundExpression,
            receiverType TypeSymbol
        ) bool {
            var selected = selected
            var declared = declared
            selected = UnwrapTransparentMemberResult(selected)
            declared = UnwrapTransparentMemberResult(declared)
            return switch (selected, declared) {
                case {
                    Item1: left is BoundFieldAccessExpression,
                    Item2: right is BoundFieldAccessExpression
                }: object.ReferenceEquals(left.Field, right.Field) ||
                    (
                    left.Field.Declaration != nil && object.ReferenceEquals(
                        left.Field.Declaration,
                        right.Field.Declaration
                    )
                )
                case {
                    Item1: left is BoundPropertyAccessExpression,
                    Item2: right is BoundPropertyAccessExpression
                }: SamePropertySlot(left.Property, right.Property, MemberOperation.Read, receiverType)
                case {
                    Item1: left is BoundClrPropertyAccessExpression,
                    Item2: right is BoundClrPropertyAccessExpression
                }: SameClrMemberSlot(left.Member, right.Member, MemberOperation.Read)
                case {Item1: left is BoundMethodGroupExpression, Item2: right is BoundMethodGroupExpression}: left
                    .Candidates
                    .Length == right
                    .Candidates
                    .Length &&
                    left
                    .Candidates
                    .All(
                    (candidate FunctionSymbol) -> right.Candidates.Any(
                        (other FunctionSymbol) -> SameMethodSlot(candidate, other)
                    )
                )
                case {Item1: left is BoundClrMethodGroupExpression, Item2: right is BoundClrMethodGroupExpression}: left
                    .Candidates
                    .Length == right
                    .Candidates
                    .Length &&
                    left
                    .Candidates
                    .All(
                    (candidate MethodInfo) -> right.Candidates.Any(
                        (other MethodInfo) -> SameClrMethodSlot(candidate, other)
                    )
                )
                default: false
            }
        }

        private func UnwrapTransparentMemberResult(expression BoundExpression) BoundExpression {
            var expression = expression
            while expression is BoundDereferenceExpression dereference {
                expression = dereference.Operand
            }
            return expression
        }

        private func IsFieldAtLeastAsNearAsProperty(
            receiver StructSymbol,
            fieldOwner StructSymbol,
            property PropertySymbol,
            propertyOwner StructSymbol
        ) bool {
            var propertyOwner = propertyOwner
            // Interface-field adapters are emitted on the implementing type but
            // represent the backing field's declaration for source lookup.
            if property.Declaration == nil && property.BackingField is {} backingField {
                for candidate in receiver.GetHierarchy() {
                    if candidate.Fields.Any((field FieldSymbol) -> object.ReferenceEquals(field, backingField)) {
                        propertyOwner = candidate
                        break
                    }
                }
            }
            for candidate in receiver.GetHierarchy() {
                if object.ReferenceEquals(candidate, fieldOwner) || object.ReferenceEquals(
                    candidate.Definition,
                    fieldOwner.Definition ?? fieldOwner
                ) {
                    return true
                }
                if object.ReferenceEquals(candidate, propertyOwner) || object.ReferenceEquals(
                    candidate.Definition,
                    propertyOwner.Definition ?? propertyOwner
                ) {
                    return false
                }
            }
            return true
        }

        private func RewrapTransparentMemberResult(
            original BoundExpression,
            replacement BoundExpression
        ) BoundExpression -> if original is BoundDereferenceExpression dereference {
            cast[BoundExpression](
                BoundDereferenceExpression(
                    dereference.Syntax,
                    RewrapTransparentMemberResult(dereference.Operand, replacement)
                )
            )
        } else {
            replacement
        }

        private func SamePropertySlot(
            selected PropertySymbol,
            declared PropertySymbol,
            operation MemberOperation,
            receiverType TypeSymbol,
            declaredOwner InterfaceSymbol? = nil
        ) bool {
            let HasRequiredAccessor = func (property PropertySymbol, operation MemberOperation) bool {
                return if operation == MemberOperation.Read {
                    property.HasGetter
                } else {
                    property.HasSetter
                }
            }
            if !HasRequiredAccessor(selected, operation) || !HasRequiredAccessor(declared, operation) {
                return false
            }
            for var current PropertySymbol? = selected; current != nil; current = current!!.OverriddenProperty {
                if object.ReferenceEquals(current, declared) ||
                    (current.Declaration != nil && object.ReferenceEquals(current.Declaration, declared.Declaration)) {
                    return true
                }
            }
            let selectedAccessor FunctionSymbol? = if operation == MemberOperation.Read {
                selected.GetterSymbol
            } else {
                selected.SetterSymbol
            }
            let declaredAccessor FunctionSymbol? = if operation == MemberOperation.Read {
                declared.GetterSymbol
            } else {
                declared.SetterSymbol
            }
            if selectedAccessor != nil &&
                declaredAccessor != nil &&
                (
                SameMethodSlot(selectedAccessor, declaredAccessor) || object.ReferenceEquals(
                    selectedAccessor.ExplicitInterfaceMember,
                    declaredAccessor
                ) ||
                    object.ReferenceEquals(selected.ExplicitInterfaceMember, declared)
            ) {
                return true
            }
            if !CanRecoverInterfacePropertySlot(selected, declared, operation, receiverType) {
                return false
            }
            return selected.Name == declared.Name && object.Equals(
                selected.Type,
                declaredOwner?.SubstituteMemberType(declared.Type) ?? declared.Type
            ) &&
                selected.ReturnRefKind == declared.ReturnRefKind &&
                selected
                .Parameters
                .Length == declared
                .Parameters
                .Length &&
                selected
                .Parameters
                .Zip(declared.Parameters)
                .All(
                (pair(First ParameterSymbol, Second ParameterSymbol)) -> pair
                    .First
                    .RefKind == pair
                    .Second
                    .RefKind &&
                    object.Equals(
                    pair.First.Type,
                    declaredOwner?.SubstituteMemberType(pair.Second.Type) ?? pair.Second.Type
                )
            )
        }

        private func CanRecoverInterfacePropertySlot(
            selected PropertySymbol,
            declared PropertySymbol,
            operation MemberOperation,
            receiverType TypeSymbol
        ) bool {
            let selectedAccessor = if operation == MemberOperation.Read {
                selected.GetterSymbol
            } else {
                selected.SetterSymbol
            }
            let declaredAccessor = if operation == MemberOperation.Read {
                declared.GetterSymbol
            } else {
                declared.SetterSymbol
            }
            let declaredOwner = declared.ContainingType ?? declaredAccessor?.ContainingType
            if !(declaredOwner is InterfaceSymbol) ||
                selected.HasExplicitInterfaceClause ||
                (operation == MemberOperation.Read && (!selected.HasGetter || !declared.HasGetter)) ||
                (operation == MemberOperation.Write && (!selected.HasSetter || !declared.HasSetter)) {
                return false
            }
            // The competing explicit implementation must be looked up on the
            // narrowed receiver's own hierarchy: for an inherited public member the
            // selected owner is the base type, which cannot see a derived class
            // re-implementing the interface explicitly. An unresolvable receiver
            // keeps the concrete access (fail-safe).
            if GetReceiverStruct(receiverType) is not{} implementationType {
                return false
            }
            return !implementationType
                .GetHierarchy()
                .SelectMany(
                func (type StructSymbol) IEnumerable[PropertySymbol] {
                    return type.Properties
                }
            )
                .Any(
                (property PropertySymbol) -> !object.ReferenceEquals(property, selected) &&
                    (
                    object.ReferenceEquals(property.ExplicitInterfaceMember, declared) ||
                        (
                        operation == MemberOperation.Read && object.ReferenceEquals(
                            property.GetterSymbol?.ExplicitInterfaceMember,
                            declared.GetterSymbol
                        )
                    ) ||
                        (
                        operation == MemberOperation.Write && object.ReferenceEquals(
                            property.SetterSymbol?.ExplicitInterfaceMember,
                            declared.SetterSymbol
                        )
                    )
                )
            )
        }

        private func GetReceiverStruct(receiverType TypeSymbol) StructSymbol? -> (
            if receiverType is NullableTypeSymbol nullable {
                nullable.UnderlyingType
            } else {
                receiverType
            }
        ) as StructSymbol

        private func SameMethodSlot(left FunctionSymbol, right FunctionSymbol) bool {
            for var current FunctionSymbol? = left; current != nil; current = current!!.OverriddenMethod {
                if object.ReferenceEquals(current, right) ||
                    (current.Declaration != nil && object.ReferenceEquals(current.Declaration, right.Declaration)) {
                    return true
                }
            }
            return false
        }

        private func SameClrMemberSlot(left MemberInfo, right MemberInfo, operation MemberOperation) bool {
            return switch left {
                case leftMethod is MethodInfo when right is MethodInfo rightMethod: SameClrMethodSlot(
                    leftMethod,
                    rightMethod
                )
                case leftProperty is PropertyInfo when right is PropertyInfo rightProperty: SameClrPropertySlot(
                    leftProperty,
                    rightProperty,
                    operation
                )
                default: left.MetadataToken == right.MetadataToken && object.ReferenceEquals(left.Module, right.Module)
            }
        }

        internal func SameClrMethodSlot(left MethodInfo, right MethodInfo) bool {
            var left = left
            var right = right
            try {
                // A `MetadataLoadContext` method answers `GetBaseDefinition` by throwing
                // (cref:NotSupportedException). Skip the call for it; the sequence keeps the
                // outcome of the throwing form, where the left side is already replaced when
                // only the right side throws.
                if !ClrTypeUtilities.IsMetadataLoadContextMember(left) {
                    left = left.GetBaseDefinition()
                    if !ClrTypeUtilities.IsMetadataLoadContextMember(right) {
                        right = right.GetBaseDefinition()
                    }
                }
            } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                // MetadataLoadContext cannot expose override chains, so only exact
                // member identity is safe.

            }
            return left.MetadataToken == right.MetadataToken && object.ReferenceEquals(left.Module, right.Module)
        }

        private func SameClrPropertySlot(left PropertyInfo, right PropertyInfo, operation MemberOperation) bool {
            let leftAccessor MethodInfo? = if operation == MemberOperation.Read {
                left.GetMethod
            } else {
                left.SetMethod
            }
            let rightAccessor MethodInfo? = if operation == MemberOperation.Read {
                right.GetMethod
            } else {
                right.SetMethod
            }
            return leftAccessor != nil && rightAccessor != nil && SameClrMethodSlot(leftAccessor, rightAccessor)
        }

        private func DeclaredReceiver(variable VariableSymbol, syntax SyntaxNode?) BoundExpression {
            return if variable.Type is NullableTypeSymbol nullable {
                BoundVariableExpression(syntax, variable, nullable.UnderlyingType)
            } else {
                BoundVariableExpression(syntax, variable)
            }
        }

        private func FindDeclaredMethod(
            declaredType TypeSymbol,
            name string,
            selected FunctionSymbol,
            receiverType TypeSymbol
        ) FunctionSymbol? {
            var declaredType = declaredType
            declaredType = if declaredType is NullableTypeSymbol nullable {
                nullable.UnderlyingType
            } else {
                declaredType
            }
            var candidateArray = Array.Empty[FunctionSymbol]()
            if declaredType is StructSymbol structType {
                candidateArray = structType.GetMethodsIncludingInherited(name).ToArray()
            } else if declaredType is InterfaceSymbol interfaceType {
                candidateArray = interfaceType
                    .SelfAndAllBaseInterfaces()
                    .SelectMany(
                    func (current InterfaceSymbol) IEnumerable[FunctionSymbol] {
                        return current.GetMethods(name)
                    }
                )
                    .ToArray()
            }
            var overridden FunctionSymbol? = selected
            while overridden != nil {
                let exact FunctionSymbol? = candidateArray.FirstOrDefault(
                    (candidate FunctionSymbol) -> object.ReferenceEquals(candidate, overridden) ||
                        (
                        overridden!!.Declaration != nil && object.ReferenceEquals(
                            candidate.Declaration,
                            overridden!!.Declaration
                        )
                    )
                )
                if exact != nil {
                    return exact
                }
                overridden = overridden.OverriddenMethod
            }
            if selected.ExplicitInterfaceMember is {} explicitInterfaceMember {
                let exactInterfaceMatch FunctionSymbol? = candidateArray.FirstOrDefault(
                    (candidate FunctionSymbol) -> SameMethodSlot(explicitInterfaceMember, candidate)
                )
                if exactInterfaceMatch != nil {
                    return exactInterfaceMatch
                }
            }
            if !(declaredType is InterfaceSymbol) {
                return nil
            }
            let interfaceMatches = candidateArray
                .Where(
                (candidate FunctionSymbol) -> HasSameCallableSignature(candidate, selected) &&
                    CanRecoverInterfaceMethodSlot(selected, candidate, receiverType)
            )
                .Take(2)
                .ToArray()
            return if interfaceMatches.Length == 1 {
                interfaceMatches[0]
            } else {
                default(FunctionSymbol?)
            }
        }

        private func CanRecoverInterfaceMethodSlot(
            selected FunctionSymbol,
            declared FunctionSymbol,
            receiverType TypeSymbol
        ) bool {
            if !(declared.ContainingType is InterfaceSymbol) || selected.HasExplicitInterfaceClause {
                return false
            }
            // Scan the narrowed receiver's hierarchy, not the selected member's
            // owner (the base type for an inherited public method); an
            // unresolvable receiver keeps the concrete call (fail-safe).
            if GetReceiverStruct(receiverType) is not{} implementationType {
                return false
            }
            return !implementationType
                .GetHierarchy()
                .SelectMany(
                func (type StructSymbol) IEnumerable[FunctionSymbol] {
                    return type.Methods
                }
            )
                .Any(
                (method FunctionSymbol) -> !object.ReferenceEquals(method, selected) &&
                    method.ExplicitInterfaceMember is {} explicitMember &&
                    SameMethodSlot(explicitMember, declared)
            )
        }

        private func FindDeclaredClrMethod(
            declaredType TypeSymbol,
            selected MethodInfo,
            selectedReturnType TypeSymbol,
            receiverType TypeSymbol
        ) MethodInfo? {
            var declaredType = declaredType
            declaredType = if declaredType is NullableTypeSymbol nullable {
                nullable.UnderlyingType
            } else {
                declaredType
            }
            let WithCompatibleReturn = func (method MethodInfo) MethodInfo? {
                return if object.Equals(
                    MemberLookup.GetClrMethodReturnTypeSymbol(declaredType, method),
                    selectedReturnType
                ) {
                    method
                } else {
                    default(MethodInfo?)
                }
            }
            let declaredClrType Type? = declaredType.ClrType
            if declaredClrType == nil {
                return if IsClrMethodAvailableOnSourceType(declaredType, selected) {
                    WithCompatibleReturn(selected)
                } else {
                    default(MethodInfo?)
                }
            }
            let selectedDefinition = if selected.IsGenericMethod {
                selected.GetGenericMethodDefinition()
            } else {
                selected
            }
            let flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
            let candidates = ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(declaredClrType, flags)
            for candidate in candidates {
                let candidateDefinition = if candidate.IsGenericMethod {
                    candidate.GetGenericMethodDefinition()
                } else {
                    candidate
                }
                if !SameClrMethodSlot(selectedDefinition, candidateDefinition) {
                    continue
                }
                if candidateDefinition.IsGenericMethodDefinition && selected.IsGenericMethod {
                    try {
                        return WithCompatibleReturn(
                            candidateDefinition.MakeGenericMethod(selected.GetGenericArguments())
                        )
                    } catch (ArgumentException) {
                        return nil
                    }
                }
                return WithCompatibleReturn(candidate)
            }
            // Resolve the interface map and competing explicit implementations
            // against the narrowed receiver's CLR type; selected.DeclaringType is
            // the base type for an inherited method. An unresolvable receiver
            // (for example a source type) keeps the concrete call (fail-safe).
            let receiverClrType Type? = (
                if receiverType is NullableTypeSymbol nullableReceiver {
                    nullableReceiver.UnderlyingType
                } else {
                    receiverType
                }
            ).ClrType
            if !declaredClrType.IsInterface || selected.DeclaringType == nil || receiverClrType == nil {
                return nil
            }
            try {
                let map_ = receiverClrType.GetInterfaceMap(declaredClrType)
                for var i = 0; i < map_.TargetMethods.Length; i++ {
                    if SameClrMethodSlot(selectedDefinition, map_.TargetMethods[i]) {
                        return WithCompatibleReturn(map_.InterfaceMethods[i])
                    }
                }
                return nil
            } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) || ex is ArgumentException { }
            let implicitMatches = candidates
                .Where(
                (candidate MethodInfo) -> IsImplicitClrInterfaceImplementation(
                    declaredClrType,
                    receiverClrType,
                    selectedDefinition,
                    candidate
                )
            )
                .Take(2)
                .ToArray()
            if implicitMatches.Length != 1 {
                return nil
            }
            let implicitMatch = implicitMatches[0]
            if implicitMatch.IsGenericMethodDefinition && selected.IsGenericMethod {
                try {
                    return WithCompatibleReturn(implicitMatch.MakeGenericMethod(selected.GetGenericArguments()))
                } catch (ArgumentException) {
                    return nil
                }
            }
            return WithCompatibleReturn(implicitMatch)
        }

        private func IsImplicitClrInterfaceImplementation(
            interfaceType Type,
            receiverClrType Type,
            selected MethodInfo,
            interfaceMethod MethodInfo
        ) bool {
            if !selected.IsPublic ||
                selected.IsStatic ||
                selected.DeclaringType == nil ||
                !ClrTypeUtilities.IsAssignableByName(interfaceType, receiverClrType) ||
                HasExplicitClrInterfaceImplementation(receiverClrType, selected, interfaceMethod) ||
                selected.Name != interfaceMethod.Name ||
                selected
                .GetGenericArguments().Length != interfaceMethod.GetGenericArguments()
                .Length ||
                !SameClrSignatureType(selected.ReturnType, interfaceMethod.ReturnType) {
                return false
            }
            let selectedParameters = selected.GetParameters()
            let interfaceParameters = interfaceMethod.GetParameters()
            return selectedParameters.Length == interfaceParameters.Length && selectedParameters.Zip(
                interfaceParameters
            )
                .All(
                (pair(First ParameterInfo, Second ParameterInfo)) -> SameClrSignatureType(
                    pair.First.ParameterType,
                    pair.Second.ParameterType
                )
            )
        }

        private func HasExplicitClrInterfaceImplementation(
            receiverClrType Type,
            selected MethodInfo,
            interfaceMethod MethodInfo
        ) bool {
            let suffix = "." + interfaceMethod.Name
            let interfaceParameters = interfaceMethod.GetParameters()
            const flags = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
            let HasExplicitImplementationInHierarchy = func () bool {
                for var current Type? = receiverClrType; current != nil; current = current!!.BaseType {
                    if ClrTypeUtilities.SafeGetMethods(current, flags).Any(
                        (candidate MethodInfo) -> !object.ReferenceEquals(candidate, selected) &&
                            candidate.IsPrivate &&
                            candidate.IsVirtual &&
                            candidate.IsFinal &&
                            candidate
                            .Name
                            .EndsWith(suffix, StringComparison.Ordinal) && candidate.GetGenericArguments()
                            .Length == interfaceMethod
                            .GetGenericArguments()
                            .Length &&
                            SameClrSignatureType(candidate.ReturnType, interfaceMethod.ReturnType) &&
                            candidate.GetParameters() is {} parameters &&
                            parameters.Length == interfaceParameters.Length &&
                            parameters
                            .Zip(interfaceParameters).All(
                            (pair(First ParameterInfo, Second ParameterInfo)) -> SameClrSignatureType(
                                pair.First.ParameterType,
                                pair.Second.ParameterType
                            )
                        )
                    ) {
                        return true
                    }
                }
                return false
            }
            // Walk the receiver's whole hierarchy: a derived class can re-implement
            // the interface explicitly over an inherited public method.
            try {
                return HasExplicitImplementationInHierarchy()
            } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                // An unresolvable base type: assume an explicit implementation
                // exists so no interface slot is recovered (fail-safe).
                return true
            }
        }

        // Compares two signature types structurally. Under MetadataLoadContext the
        // T of I.Map<T> and the T of an implementation are distinct reflection
        // objects, so raw Type equality rejects valid generic methods. Generic
        // parameters compare by kind and ordinal; compound types recurse.
        private func SameClrSignatureType(left Type, right Type) bool {
            if object.ReferenceEquals(left, right) || left == right {
                return true
            }
            if left.IsGenericParameter || right.IsGenericParameter {
                // Only method-level parameters match by ordinal; a type-level
                // parameter of a different declaring type is a different type.
                return left.IsGenericParameter &&
                    right.IsGenericParameter &&
                    left.DeclaringMethod != nil &&
                    right.DeclaringMethod != nil &&
                    left.GenericParameterPosition == right.GenericParameterPosition
            }
            if left.HasElementType || right.HasElementType {
                return left.HasElementType &&
                    right.HasElementType &&
                    left.IsArray == right.IsArray &&
                    left.IsByRef == right.IsByRef &&
                    left.IsPointer == right.IsPointer &&
                    (!left.IsArray || left.GetArrayRank() == right.GetArrayRank()) &&
                    left.GetElementType() is {} leftElement && right.GetElementType() is {} rightElement &&
                    SameClrSignatureType(leftElement, rightElement)
            }
            if left.IsGenericType && right.IsGenericType {
                let leftArguments = left.GetGenericArguments()
                let rightArguments = right.GetGenericArguments()
                return leftArguments.Length == rightArguments.Length &&
                    left.GetGenericTypeDefinition() is {} leftDefinition &&
                    right.GetGenericTypeDefinition() is {} rightDefinition &&
                    (
                    leftDefinition == rightDefinition ||
                        (
                        leftDefinition.FullName != nil &&
                            leftDefinition.FullName == rightDefinition.FullName &&
                            leftDefinition
                            .Assembly
                            .GetName()
                            .Name == rightDefinition
                            .Assembly
                            .GetName()
                            .Name
                    )
                ) &&
                    leftArguments
                    .Zip(rightArguments).All(
                    (pair(First Type, Second Type)) -> SameClrSignatureType(pair.First, pair.Second)
                )
            }
            return false
        }

        private func IsClrMethodAvailableOnSourceType(declaredType TypeSymbol, selected MethodInfo) bool {
            let declaringClrType Type? = selected.DeclaringType
            if declaringClrType == nil {
                return false
            }
            if declaringClrType.FullName == typeof(object).FullName {
                return true
            }
            if declaredType is not StructSymbol structType {
                return false
            }
            for current in structType.GetHierarchy() {
                if current.ImportedBaseType?.ClrType is {} importedBase && ClrTypeUtilities.IsAssignableByName(
                    declaringClrType,
                    importedBase
                ) {
                    return true
                }
                if current.ImplementedClrInterfaces.Any(
                    (type TypeSymbol) -> type.ClrType is {} clrInterface && ClrTypeUtilities.IsAssignableByName(
                        declaringClrType,
                        clrInterface
                    )
                ) {
                    return true
                }
            }
            return false
        }

        private func HasSameCallableSignature(candidate FunctionSymbol, selected FunctionSymbol) bool {
            if candidate
                .Parameters
                .Length != selected
                .Parameters
                .Length ||
                candidate
                .TypeParameters
                .Length != selected
                .TypeParameters
                .Length ||
                candidate.ReturnRefKind != selected.ReturnRefKind {
                return false
            }
            let typeParameterMap = candidate
                .TypeParameters
                .Zip(selected.TypeParameters)
                .ToDictionary(
                (pair(First TypeParameterSymbol, Second TypeParameterSymbol)) -> pair.First,
                (pair(First TypeParameterSymbol, Second TypeParameterSymbol)) -> cast[TypeSymbol](pair.Second)
            )
            if !object.Equals(StructSymbol.SubstituteTypeParameters(candidate.Type, typeParameterMap), selected.Type) {
                return false
            }
            for var i = 0; i < candidate.Parameters.Length; i++ {
                if candidate.Parameters[i].RefKind != selected.Parameters[i].RefKind || !object.Equals(
                    StructSymbol.SubstituteTypeParameters(candidate.Parameters[i].Type, typeParameterMap),
                    selected.Parameters[i].Type
                ) {
                    return false
                }
            }
            return true
        }

        /// Returns whether CLR instance lookup may continue through a receiver:
        /// the receiver has a loadable (cref:TypeSymbol.ClrType) and its
        /// type is not a (cref:NullableTypeSymbol) — that is, nobody has
        /// stated it `T?`. A receiver that IS stated nullable, whether a
        /// source-declared `T?`, an annotated-nullable imported member
        /// (`e.InnerException`) or a generic member substituted with a
        /// nullable type argument (`Box[string?].Value`), must be narrowed,
        /// asserted (`!!`) or read through `?.` first.
        ///
        /// This predicate never sees a (cref:PlatformTypeSymbol): both
        /// callers run `PlatformCoercion.InsertCheck` on the receiver first
        /// (the read path through `CheckPlatformReceiver`, the write path
        /// explicitly in `BindMemberFieldAssignmentExpression`), which inserts
        /// ADR-0186 §4's nil check and unwraps `T!` to its underlying
        /// `T`. That coercion, not this test, answers an oblivious receiver's
        /// safety question.
        ///
        /// <b>Issue #4356.</b> This test used to carry a second disjunct,
        /// `|| receiver is BoundClrPropertyAccessExpression`, which let lookup
        /// continue through ANY nullable receiver that happened to be an imported
        /// field or property read. It was added (#2459) for oblivious members,
        /// which ADR-0136 imported as `T?`; ADR-0186's `T!` now handles
        /// those. But it tested the kind of bound node rather than where the
        /// nullability came from, so it also waved through stated-nullable chains
        /// with no narrowing and no nil check. ADR-0186 step 4 kept it only because
        /// cs2gs output depended on it; #4356 fixed cs2gs and deleted it, along
        /// with its twin in (cref:TryGetUserInstanceMemberReceiverType).
        private func CanBindClrInstanceMember(receiver BoundExpression?) bool {
            return receiver?.Type?.ClrType != nil && !(receiver!!.Type is NullableTypeSymbol)
        }

        /// Returns the G#-declared class or struct whose instance members a
        /// receiver reads. A stated-nullable receiver (`T?`) does not qualify
        /// here either (issue #4356): an imported read projected to a G# class
        /// through a nullable type argument (#4121) used to be accepted when it was
        /// a (cref:BoundClrPropertyAccessExpression), the same node-shape
        /// carve-out (cref:CanBindClrInstanceMember) carried.
        /// @param receiver The bound receiver.
        /// @param receiverType The receiver's G# struct/class symbol.
        /// @returns `true` when the receiver is a G# struct/class.
        private func TryGetUserInstanceMemberReceiverType(
            receiver BoundExpression,
            @NotNullWhen(true) out receiverType StructSymbol?
        ) bool {
            receiverType = receiver.Type as StructSymbol
            return receiverType != nil
        }

        /// Issue #3311: resolves the effective receiver type used for CLR
        /// instance-member lookup. A receiver with a loadable
        /// (cref:TypeSymbol.ClrType) is used as-is
        /// ((cref:CanBindClrInstanceMember)); an open-generic
        /// `map[K, V]` receiver — whose ClrType is null by construction when
        /// K or V is a type parameter — surfaces the symbolic constructed
        /// `Dictionary[K, V]` view instead, so the interop member surface
        /// (`.Keys`, `.Values`, `.Count`, method groups) resolves
        /// exactly as on an explicitly-typed `Dictionary[K, V]` receiver.
        /// @param receiver The bound receiver expression.
        /// @param effectiveType The effective lookup type, on success.
        /// @returns `true` when CLR instance lookup may proceed.
        private func TryGetClrInstanceMemberReceiverType(
            receiver BoundExpression?,
            @NotNullWhen(true) out effectiveType TypeSymbol?
        ) bool {
            if CanBindClrInstanceMember(receiver) {
                // CanBindClrInstanceMember proves that the receiver expression is present.
                effectiveType = receiver!!.Type
                return true
            }
            // Issue #3311 (open maps) and ADR-0174 D12 (channels over symbolic
            // elements): surface the symbolic constructed BCL view.
            if receiver?.Type is TypeSymbol receiverType && MemberLookup.TryGetSymbolicOpenReceiverView(
                receiverType,
                out var symbolicView
            ) {
                effectiveType = symbolicView
                return true
            }
            effectiveType = nil
            return false
        }

        private func IsRectangularArrayType(type TypeSymbol) bool -> GetRectangularArrayTypeForBinding(type) != nil

        private func GetRectangularArrayTypeForBinding(type TypeSymbol) RectangularArrayTypeSymbol? {
            if type is RectangularArrayTypeSymbol rectangular {
                return rectangular
            }
            if type is NullableTypeSymbol {
                return nil
            }
            return if type.ClrType is {IsArray: true} clr && clr.GetArrayRank() > 1 {
                RectangularArrayTypeSymbol.Get(
                    TypeSymbol.FromClrTypeWithoutNullability(clr.GetElementType(), NullabilityFreeReason.TypeStructure),
                    clr.GetArrayRank()
                )
            } else {
                default(RectangularArrayTypeSymbol?)
            }
        }

        private func TryGetUserIndexer(
            target InterfaceSymbol,
            @NotNullWhen(true) out indexer PropertySymbol?,
            out substitution Dictionary[TypeParameterSymbol, TypeSymbol]?
        ) bool {
            indexer = nil
            substitution = nil
            for iface in target.SelfAndAllBaseInterfaces() {
                let def = iface.Definition ?? iface
                for p in def.Properties {
                    if p.IsIndexer {
                        indexer = p
                        break
                    }
                }
                if indexer != nil {
                    break
                }
            }
            if indexer == nil {
                return false
            }
            // Build the type-parameter substitution for a constructed generic
            // receiver (e.g. `IBox[int32]` over `interface IBox[T]`).
            if !target.TypeArguments.IsDefaultOrEmpty && target.Definition != nil && !object.ReferenceEquals(
                target.Definition,
                target
            ) {
                let defTps = target.Definition.TypeParameters
                if !defTps.IsDefaultOrEmpty && defTps.Length == target.TypeArguments.Length {
                    substitution = Dictionary[TypeParameterSymbol, TypeSymbol](defTps.Length)
                    for var i = 0; i < defTps.Length; i++ {
                        substitution!![defTps[i]] = target.TypeArguments[i]
                    }
                }
            }
            return true
        }

        internal func MapErasedIndexerElementType(target ImportedTypeSymbol, closedIndexer PropertyInfo) TypeSymbol {
            // Issue #313 (HasTypeParameterArgument): substitute the open indexer's
            // generic-parameter result back through the target's symbolic type
            // arguments so `list[i]` on `List[T]` is typed as `T`.
            // Issue #671: also substitute when the target is a constructed
            // generic with G# user-defined or nested-symbolic type arguments
            // (e.g. `outer[0]` on `List[List[MyGs]]` -> `List[MyGs]`); without
            // this the element would type-erase to `List<object>` and downstream
            // member access on the result would emit against the wrong parent.
            // ADR-0172: `HasSubstitutableTypeArgument` only counts a DIRECT named
            // tuple argument; a named tuple nested deeper in the argument
            // (`List[[](a int32, b string)]`) still needs the substitution to
            // surface its names, so widen the gate here without changing the
            // property's broader (conversion/lowering) meaning.
            if (
                target.HasSubstitutableTypeArgument ||
                    (
                    !target.TypeArguments.IsDefaultOrEmpty && target.TypeArguments.Any(
                        TypeSymbol.ContainsNamedTupleElements
                    )
                )
            ) &&
                target.OpenDefinition is Type openDefinition {
                try {
                    let openIndexer = MemberLookup.FindOpenIndexerDefinition(openDefinition, closedIndexer)
                    if openIndexer?.PropertyType is Type openElement {
                        // ADR-0056 §1/§2: a ref-returning indexer (e.g. `Span[T]`)
                        // surfaces its element as `T&`; map it through a
                        // `ByRefTypeSymbol` so §1 auto-dereference applies.
                        let openCore = if openElement.IsByRef {
                            openElement.GetElementType()!!
                        } else {
                            openElement
                        }
                        if openCore.IsGenericParameter {
                            let position = openCore.GenericParameterPosition
                            if position >= 0 && position < target.TypeArguments.Length {
                                let arg = target.TypeArguments[position]
                                return if openElement.IsByRef {
                                    cast[TypeSymbol](ByRefTypeSymbol.Get(arg))
                                } else {
                                    arg
                                }
                            }
                        }
                        // Issue #3501: an indexer whose result merely MENTIONS the
                        // receiver's type parameter inside a constructed generic —
                        // `ILookup[TKey, TElement].this[TKey]` returning
                        // `IEnumerable[TElement]` — fell through the bare-slot case
                        // above and used the erased closed shape, so a lookup over
                        // a same-compilation element type surfaced
                        // `IEnumerable[object]` and every member read on the
                        // iterated element failed GS0158. Recover the substituted
                        // shape via the same recursive projection the method-
                        // parameter path uses (#2365).
                        if openCore.ContainsGenericParameters {
                            // ADR-0193 Phase 2: merged, like every sibling
                            // indexer read (`GetClrPropertyTypeSymbol`).
                            var projected TypeSymbol? = MemberLookup.GetClrMemberValueTypeSymbol(
                                openIndexer!!,
                                openDefinition,
                                target.TypeArguments
                            )
                            if projected is ByRefTypeSymbol projectedByRef {
                                projected = projectedByRef.PointeeType
                            }
                            if projected != nil &&
                                projected != TypeSymbol.Error &&
                                (
                                TypeSymbol.RequiresSymbolicProjection(projected) ||
                                    TypeSymbol.ContainsNamedTupleElements(projected)
                            ) {
                                return if openElement.IsByRef {
                                    cast[TypeSymbol](ByRefTypeSymbol.Get(projected))
                                } else {
                                    projected
                                }
                            }
                        }
                    }
                } catch (AmbiguousMatchException) {
                    // Fall back to the erased element type below.

                }
            }
            // Symbolic receivers were projected above. Preserve the remaining closed signature's array surface and modifiers.
            return ClrNullability.GetPropertyTypeSymbol(closedIndexer)
        }

        // Issue #1301: resolve the element type of a closed indexer against the
        // receiver's symbolic type arguments, mirroring the normal `this[int]`
        // index path. Routing the from-end (`a[^n]`) / `System.Index` indexer
        // paths through here keeps a user-defined element type `T` (whose
        // `ClrType` is null during binding) typed as `T` instead of erasing to
        // `object`.
        private func ResolveIndexerElementType(targetType TypeSymbol, indexer PropertyInfo) TypeSymbol {
            if targetType is ImportedTypeSymbol imported {
                return MapErasedIndexerElementType(imported, indexer)
            }
            return MemberLookup.GetClrPropertyTypeSymbol(targetType, indexer, projectOnlyWhenSymbolicallyRequired: true)
        }

        // ADR-0118 / issue #944: locate a user-declared indexer member on a (possibly
        // constructed-generic) user type and, for a constructed type, build the
        // type-parameter substitution from the receiver's type arguments. The
        // returned PropertySymbol is the OPEN indexer on the type definition so its
        // get_Item/set_Item accessors resolve to the emitted MethodDef handles.
        private func TryGetUserIndexer(
            target StructSymbol,
            @NotNullWhen(true) out indexer PropertySymbol?,
            out substitution Dictionary[TypeParameterSymbol, TypeSymbol]?
        ) bool {
            indexer = nil
            substitution = nil
            let definition = target.Definition ?? target
            for c in definition.GetHierarchy() {
                for p in c.Properties {
                    if p.IsIndexer {
                        indexer = p
                        break
                    }
                }
                if indexer != nil {
                    break
                }
            }
            if indexer == nil {
                return false
            }
            // Build the type-parameter substitution for a constructed generic
            // receiver (e.g. `Repo[int32]` over `class Repo[T]`).
            if !target.TypeArguments.IsDefaultOrEmpty && target.Definition != nil && !object.ReferenceEquals(
                target.Definition,
                target
            ) {
                let defTps = target.Definition!!.TypeParameters
                if !defTps.IsDefaultOrEmpty && defTps.Length == target.TypeArguments.Length {
                    substitution = Dictionary[TypeParameterSymbol, TypeSymbol](defTps.Length)
                    for var i = 0; i < defTps.Length; i++ {
                        substitution!![defTps[i]] = target.TypeArguments[i]
                    }
                }
            }
            return true
        }

        /// Issue #1330: recover the symbolic type of a static member read on a
        /// generic type constructed over an in-scope generic type parameter (e.g.
        /// `Comparer[TResult].Default`). The receiver's closed CLR shape is
        /// type-erased (`Comparer<object>`), so reflection reports the
        /// member's open type closed over `object`. Walk the open member on the
        /// receiver's (cref:ImportedTypeSymbol.OpenDefinition) and project its
        /// type using the receiver's symbolic (cref:ImportedTypeSymbol.TypeArguments).
        /// Returns `null` when no substitution applies.
        private func ResolveStaticMemberTypeFromSymbolicReceiver(
            symbolicReceiver ImportedTypeSymbol,
            closedMember MemberInfo?
        ) TypeSymbol? {
            if symbolicReceiver?.OpenDefinition == nil ||
                symbolicReceiver
                .TypeArguments
                .IsDefaultOrEmpty ||
                closedMember == nil {
                return nil
            }
            try {
                const staticFlags = BindingFlags.Public | BindingFlags.Static
                let openMember MemberInfo? = switch closedMember {
                    case _ is PropertyInfo: (
                        ClrTypeUtilities.SafeGetProperty(
                            symbolicReceiver.OpenDefinition!!,
                            closedMember.Name,
                            staticFlags
                        ) as MemberInfo?
                    )
                    case _ is FieldInfo: (
                        symbolicReceiver.OpenDefinition!!.GetField(closedMember.Name, staticFlags) as MemberInfo?
                    )
                    default: nil
                }
                let openMemberType Type? = switch openMember {
                    case openProperty is PropertyInfo: openProperty.PropertyType
                    case openField is FieldInfo: openField.FieldType
                    default: default(Type?)
                }
                if openMember == nil || openMemberType == nil {
                    return nil
                }
                // ADR-0193 Phase 2: merged, as the instance-member readers are.
                let mapped = MemberLookup.GetClrMemberValueTypeSymbol(
                    openMember,
                    symbolicReceiver.OpenDefinition,
                    symbolicReceiver.TypeArguments
                )
                return if TypeSymbol.ContainsTypeParameter(mapped) || TypeSymbol.IsSameCompilationUserTypeTopLevel(
                    mapped
                ) ||
                    openMemberType.IsGenericParameter ||
                    openMemberType.IsGenericType {
                    mapped
                } else {
                    default(TypeSymbol?)
                }
            } catch (AmbiguousMatchException) {
                return nil
            }
        }

        private func IsReadOnlyRefReturn(indexer PropertyInfo) bool -> RefCapabilities.GetReturnRefKind(
            indexer
        ) == RefKind.RefReadOnly

        // Element type for the array/slice slicing path, or null if the target is
        // not an array/slice. Result of slicing is always a `[]T` slice.
        // Issue #1951: internal (not private) so PatternBinder.BindListPattern can
        // reuse the same array/slice-or-metadata-array recognition for list
        // patterns instead of only accepting the in-compilation
        // ArrayTypeSymbol/SliceTypeSymbol.
        internal func GetArraySliceElementType(type TypeSymbol) TypeSymbol? {
            return switch type {
                case arr is ArrayTypeSymbol: arr.ElementType
                case slice is SliceTypeSymbol: slice.ElementType
                case imp is ImportedTypeSymbol when imp
                    .ClrType
                    ?.IsArray == true &&
                    imp.ClrType!!.GetArrayRank() == 1: TypeSymbol.FromClrTypeWithoutNullability(
                    imp.ClrType!!.GetElementType(),
                    NullabilityFreeReason.TypeStructure
                )
                case annot is NullabilityAnnotatedTypeSymbol when annot
                    .ClrType
                    ?.IsArray == true &&
                    annot.ClrType!!.GetArrayRank() == 1: annot.GetTypeArgumentSymbolForClrType(
                    annot.ClrType!!.GetElementType()
                )
                default: default(TypeSymbol?)
            }
        }

        /// Issue #3907: the static type of a range slice (`src[a..b]`) over an
        /// imported slice shape.
        /// @remarks The slice member is discovered by reflecting on the receiver's
        /// (cref:TypeSymbol.ClrType), and issue #658 erases a type argument
        /// that has no CLR representation while binding — so inside
        /// `class Holder[T]` a `Span[T]` receiver reflects as
        /// `Span<object>` and `Slice` reports that as its return
        /// type. Taking the reflected answer verbatim threw the symbolic `T`
        /// away: `destination[1..]` produced a `Span[object]` that no
        /// longer converted back into the `Span[T]` slot it was sliced
        /// from.
        ///
        /// Every slice shape in the BCL — `Span<T>`,
        /// `ReadOnlySpan<T>`, `Memory<T>`,
        /// `ReadOnlyMemory<T>`, `string` — yields the RECEIVER'S
        /// OWN type, so when the reflected result is identical to the receiver's
        /// CLR type the symbolic answer is just the receiver's symbolic type,
        /// which still carries `T`. Deliberately guarded on that identity:
        /// a slice member returning anything else keeps the reflected answer
        /// unchanged, and a receiver whose type argument is already concrete
        /// (`Span[int32]`) gets back the same symbol it had before.
        /// @param target The sliced receiver.
        /// @param reflectedResult The slice member's reflected result type.
        /// @param readResult The slice member's result type, read through the funnel.
        /// @returns The slice expression's static type.
        private func SliceResultType(target BoundExpression, reflectedResult Type, readResult TypeSymbol) TypeSymbol {
            let targetType = target.Type
            if targetType?.ClrType != nil && targetType.ClrType.IsSameAs(reflectedResult) {
                return targetType
            }
            return readResult
        }

        private func BuildSystemRangeValue(lower RangeBound?, upper RangeBound?) BoundExpression {
            let indexCtor = typeof(Index).GetConstructor([]Type{typeof(int32), typeof(bool)})!!
            let rangeCtor = typeof(Range).GetConstructor([]Type{typeof(Index), typeof(Index)})!!
            let indexSym = TypeSymbol.FromClrTypeWithoutNullability(typeof(Index), NullabilityFreeReason.TypeLiteral)
            let rangeSym = TypeSymbol.FromClrTypeWithoutNullability(typeof(Range), NullabilityFreeReason.TypeLiteral)
            let MakeIndex = func (bound RangeBound?, defaultFromEnd bool) BoundExpression {
                if bound is {IsIndexValue: true} indexValue {
                    return indexValue.Value
                }
                // Issue #1022: a `^n` bound becomes System.Index(n, fromEnd: true);
                // the System.Range value resolves the concrete offset at runtime.
                let value = bound?.Value ?? BoundLiteralExpression(nil, 0)
                let fromEnd = bound?.FromEnd ?? defaultFromEnd
                return BoundClrConstructorCallExpression(
                    nil,
                    typeof(Index),
                    indexCtor,
                    ImmutableArray.Create[BoundExpression](value, BoundLiteralExpression(nil, fromEnd)),
                    indexSym
                )
            }
            // Open lower defaults to the start (0, from-start); open upper defaults
            // to the end (^0, i.e. value 0 from-end).
            let startIndex = MakeIndex(lower, defaultFromEnd: false)
            let endIndex = MakeIndex(upper, defaultFromEnd: true)
            return BoundClrConstructorCallExpression(
                nil,
                typeof(Range),
                rangeCtor,
                ImmutableArray.Create[BoundExpression](startIndex, endIndex),
                rangeSym
            )
        }

        // Issue #1038: a `System.Range`-typed value used as an index argument
        // (`a[r]`) slices the target. Uses ClrTypeUtilities.IsSameAs per the issue
        // #835 guard against reference-identity typeof comparisons.
        private func IsSystemRangeType(type TypeSymbol) bool {
            return type?.ClrType != nil && type.ClrType.IsSameAs(typeof(Range))
        }

        private func TryFindRangeIndexer(clrType Type, @NotNullWhen(true) out indexer PropertyInfo?) bool {
            for property in clrType.GetProperties(BindingFlags.Public | BindingFlags.Instance) {
                let indexParams = property.GetIndexParameters()
                if indexParams.Length == 1 && indexParams[0].ParameterType.IsSameAs(typeof(Range)) {
                    indexer = property
                    return true
                }
            }
            indexer = nil
            return false
        }

        // Issue #1022: a type that exposes a `this[System.Index]` indexer can serve
        // a from-end index directly (the indexer resolves `^n` at runtime).
        private func TryFindIndexIndexer(clrType Type, @NotNullWhen(true) out indexer PropertyInfo?) bool {
            for property in clrType.GetProperties(BindingFlags.Public | BindingFlags.Instance) {
                let indexParams = property.GetIndexParameters()
                if indexParams.Length == 1 && indexParams[0].ParameterType.IsSameAs(typeof(Index)) {
                    indexer = property
                    return true
                }
            }
            indexer = nil
            return false
        }

        // Issue #1022: a type with an `int Length`/`int Count` property and a
        // `this[int]` indexer (string, List<T>, span-like) can serve a from-end
        // index as `this[Length - n]`.
        private func TryFindCountedIntIndexer(
            clrType Type,
            @NotNullWhen(true) out lengthMember MemberInfo?,
            @NotNullWhen(true) out intIndexer PropertyInfo?
        ) bool {
            lengthMember = nil
            intIndexer = nil
            var lengthProp PropertyInfo? = nil
            for candidateType in MemberLookup.EnumerateSelfAndInterfaces(clrType) {
                lengthProp = candidateType.GetProperty("Length", BindingFlags.Public | BindingFlags.Instance)
                if lengthProp != nil && lengthProp.PropertyType.IsSameAs(typeof(int32)) {
                    break
                }
                lengthProp = candidateType.GetProperty("Count", BindingFlags.Public | BindingFlags.Instance)
                if lengthProp != nil && lengthProp.PropertyType.IsSameAs(typeof(int32)) {
                    break
                }
                lengthProp = nil
            }
            if lengthProp == nil {
                return false
            }
            for candidateType in MemberLookup.EnumerateSelfAndInterfaces(clrType) {
                for property in candidateType.GetProperties(BindingFlags.Public | BindingFlags.Instance) {
                    let indexParams = property.GetIndexParameters()
                    if indexParams.Length == 1 && indexParams[0].ParameterType.IsSameAs(typeof(int32)) {
                        lengthMember = lengthProp
                        intIndexer = property
                        return true
                    }
                }
            }
            return false
        }

        private func TryFindSliceShape(
            clrType Type,
            @NotNullWhen(true) out lengthMember MemberInfo?,
            @NotNullWhen(true) out sliceMethod MethodInfo?
        ) bool {
            lengthMember = nil
            sliceMethod = nil
            var lengthProp PropertyInfo? = clrType.GetProperty("Length", BindingFlags.Public | BindingFlags.Instance)
            if lengthProp == nil || !lengthProp.PropertyType.IsSameAs(typeof(int32)) {
                lengthProp = clrType.GetProperty("Count", BindingFlags.Public | BindingFlags.Instance)
            }
            if lengthProp == nil || !lengthProp.PropertyType.IsSameAs(typeof(int32)) {
                return false
            }
            // Issue #2114: probe for `Slice(int, int)` by enumerating candidates and
            // comparing parameter types with IsSameAs, rather than the reflection
            // overload that takes a runtime Type[]. When `clrType` is a
            // MetadataLoadContext RoType (the `/reference:` resolver path), passing
            // runtime `typeof(int)` to GetMethod makes DefaultBinder.SelectMethod
            // throw "Type must be a type provided by the MetadataLoadContext" and
            // crash the compiler (GS9998). IsSameAs works across both contexts.
            var slice MethodInfo? = nil
            for candidate in clrType.GetMethods(BindingFlags.Public | BindingFlags.Instance) {
                if candidate.Name != "Slice" {
                    continue
                }
                let sliceParams = candidate.GetParameters()
                if sliceParams.Length == 2 && sliceParams[0].ParameterType.IsSameAs(typeof(int32)) &&
                    sliceParams[1]
                    .ParameterType
                    .IsSameAs(typeof(int32)) {
                    slice = candidate
                    break
                }
            }
            if slice == nil {
                return false
            }
            lengthMember = lengthProp
            sliceMethod = slice
            return true
        }

        // Issue #1279: array/slice element access accepts any integer-typed index
        // (matching C#). Integer types that implicitly widen to int32
        // (int8/uint8/int16/uint16/char/int32) convert to int32; the wider integer
        // types (uint32/int64/uint64/nint/nuint) convert to native int (nint),
        // which CIL ldelem/stelem/ldelema accept as the index operand. Non-integer
        // indices fall through to the int32 conversion, which reports GS0156.
        private func IsWideIntegerIndexType(type TypeSymbol) bool -> type == TypeSymbol.UInt32 ||
            type == TypeSymbol.Int64 ||
            type == TypeSymbol.UInt64 ||
            type == TypeSymbol.NInt ||
            type == TypeSymbol.NUInt

        private func GetIndexElementType(type TypeSymbol) TypeSymbol? {
            return switch type {
                case arr is ArrayTypeSymbol: arr.ElementType
                case slice is SliceTypeSymbol: slice.ElementType
                case imp is ImportedTypeSymbol when imp
                    .ClrType
                    ?.IsArray == true &&
                    imp.ClrType!!.GetArrayRank() == 1: TypeSymbol.FromClrTypeWithoutNullability(
                    imp.ClrType!!.GetElementType(),
                    NullabilityFreeReason.TypeStructure
                )
                case annot is NullabilityAnnotatedTypeSymbol when annot
                    .ClrType
                    ?.IsArray == true &&
                    annot.ClrType!!.GetArrayRank() == 1: annot.GetTypeArgumentSymbolForClrType(
                    annot.ClrType!!.GetElementType()
                )
                default: default(TypeSymbol?)
            }
        }

        /// ADR-0089: substitute a type that may mention the constructed
        /// interface's open type parameter with the corresponding type
        /// argument from [`constructedIface`](paramref). Conservative —
        /// only rewrites a top-level (cref:TypeParameterSymbol)
        /// reference; leaves nested/generic shapes alone (the slot's
        /// signature is typically just `T` for the common math
        /// pattern).
        private func SubstituteThroughConstructedInterface(
            type TypeSymbol,
            constructedIface InterfaceSymbol
        ) TypeSymbol {
            if type is TypeParameterSymbol tp &&
                constructedIface?.Definition != nil &&
                !constructedIface.Definition!!
                .TypeParameters
                .IsDefaultOrEmpty &&
                !constructedIface
                .TypeArguments
                .IsDefaultOrEmpty {
                for var i = 0; i < constructedIface.Definition!!.TypeParameters.Length; i++ {
                    if object.ReferenceEquals(constructedIface.Definition!!.TypeParameters[i], tp) {
                        return constructedIface.TypeArguments[i]
                    }
                }
            }
            return type
        }

        /// ADR-0122 §10 / issue #1035: builds the `*T` value a fixed-size
        /// buffer field decays to — the address of the inline backing struct
        /// (whose first element sits at offset 0) reinterpreted to the element
        /// pointer type. Reuses the existing address-of + pointer-reinterpret
        /// machinery, so no new bound-node kind is required.
        /// @param receiver The receiver expression the buffer field is read from.
        /// @param declaringType The type that declares the buffer field.
        /// @param field The fixed-size buffer field.
        /// @returns A `*T`-typed bound expression to the first element.
        private func MakeFixedBufferPointer(
            receiver BoundExpression,
            declaringType StructSymbol,
            field FieldSymbol
        ) BoundExpression {
            let fieldAccess = BoundFieldAccessExpression(nil, receiver, declaringType, field)
            let addressOf = BoundAddressOfExpression(nil, fieldAccess, unmanaged: true)
            if field.FixedBufferElementType is not{} elementType {
                throw InvalidOperationException("Fixed-buffer field is missing its element type.")
            }
            let elementPointer = PointerTypeSymbol.Get(elementType)
            return BoundConversionExpression(nil, elementPointer, addressOf)
        }

        /// ADR-0125 amendment (issue #4378): recognises the `*T` decay that
        /// (cref:MakeFixedBufferPointer) builds for a fixed-size buffer field
        /// and recovers the underlying buffer field access, so the `fixed`
        /// statement can pin the buffer's containing storage instead of rejecting
        /// the already-decayed raw pointer. (cref:MakeFixedBufferPointer) is
        /// the only producer of this exact shape: source code cannot spell an
        /// address-of over an undecayed buffer field, because every reference to
        /// the field decays first.
        /// @param expression A bound `fixed` statement source.
        /// @param bufferAccess The fixed-size buffer field access, on success.
        /// @returns `true` when [`expression`](paramref) is a decayed fixed-size buffer field.
        internal func TryGetFixedBufferFieldAccess(
            expression BoundExpression,
            @NotNullWhen(true) out bufferAccess BoundFieldAccessExpression?
        ) bool {
            if expression is BoundConversionExpression{
                Type: PointerTypeSymbol,
                Expression: BoundAddressOfExpression{
                    IsUnmanaged: true,
                    Operand: BoundFieldAccessExpression{Field: {IsFixedBuffer: true}} access
                }
            } {
                bufferAccess = access
                return true
            }
            bufferAccess = nil
            return false
        }
    }
}
