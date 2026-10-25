// <copyright file="ExpressionBinder.Assignments.cs" company="GSharp">
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
import System.Threading

internal partial class ExpressionBinder {
    private func BindAssignmentExpression(syntax AssignmentExpressionSyntax) BoundExpression {
        let name = syntax.IdentifierToken.ValueText
        // Issue #1316: resolve the assignment target before binding the RHS so the
        // target's declared type can be threaded into the RHS binder as the
        // expected type. Without this an if-/conditional-/switch-expression RHS
        // with a `nil` arm (e.g. `A = if c { nil } else { T(...) }` where
        // `A : T?`) binds context-free, picks `T` from the non-nil arm, and then
        // rejects the `nil` arm with GS0155 — even though the identical RHS bound
        // through `let a T? = ...` (which does receive the target type) compiles.
        let variable VariableSymbol? = BindVariableReference(
            name,
            syntax.IdentifierToken.Location,
            suppressNotAVariable: false,
            suppressUndefinedVariable: true
        )
        if variable == nil {
            // Issue #1584: a bare write to an inherited CLR instance
            // property/field of a metadata base resolves to `this.member =
            // value`, mirroring the qualified path and the bare-name READ
            // fallback in BindNameExpression.
            if TryBindInheritedClrInstanceMemberWriteByBareName(
                name,
                syntax.Expression,
                syntax.EqualsToken.Location,
                out var inheritedWrite
            ) &&
                inheritedWrite is {} resolvedInheritedWrite {
                return resolvedInheritedWrite
            }
            // Issue #3840: a bare write inside a DEFAULT INTERFACE METHOD body
            // resolves to `this.Member = value` on the enclosing interface's
            // own property — the write half of the bare-name READ fallback in
            // BindNameExpression.
            let interfaceWrite BoundExpression? = TryBindInterfaceInstancePropertyWriteByBareName(
                name,
                syntax.IdentifierToken.Location,
                syntax.Expression,
                syntax.EqualsToken.Location
            )
            if interfaceWrite != nil {
                return interfaceWrite
            }
            // ADR-0156 Phase 2: a bare write to a top-level global declared by
            // a prior interactive submission stores to the static field on
            // that submission's <Program> container (newest submission first).
            if TryBindSubmissionStaticFieldWrite(
                name,
                syntax.Expression,
                syntax.EqualsToken.Location,
                out var submissionWrite
            ) &&
                submissionWrite is {} resolvedSubmissionWrite {
                return resolvedSubmissionWrite
            }
            // Surface the diagnostic suppressed above (GS0125) only when the
            // name is genuinely unresolved; a non-variable symbol already
            // reported its own diagnostic.
            if $scope.TryLookupSymbol(name) == nil {
                Diagnostics.ReportUndefinedVariable(syntax.IdentifierToken.Location, name)
            }
            return BindExpression(syntax.Expression)
        }
        let boundExpression = BindAssignmentRhs(syntax.Expression, GetAssignmentTargetType(variable))
        if variable is ImplicitFieldVariableSymbol implicitField {
            if implicitField
                .Field
                .IsReadOnly &&
                !IsReadOnlyFieldAssignmentAllowed(implicitField.Field, implicitField.StructType, receiverIsThis: true) {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name)
            }
            // Issue #186 / #175: bare field-name write inside a method fires
            // GS0204 if the underlying field carries `@Obsolete`.
            reportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitField.Field,
                "${implicitField.StructType.Name}.${implicitField.Field.Name}"
            )
            let convertedValue = conversions.BindConversion(
                syntax.Expression.Location,
                boundExpression,
                implicitField.Field.Type
            )
            return BoundFieldAssignmentExpression(
                nil,
                implicitField.Receiver,
                implicitField.StructType,
                implicitField.Field,
                convertedValue
            )
        }
        // Issue #261: bare static field assignment inside a shared method body.
        if variable is ImplicitStaticFieldVariableSymbol implicitStaticField {
            if implicitStaticField.Field.IsReadOnly {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name)
            }
            reportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitStaticField.Field,
                "${implicitStaticField.OwnerName}.${implicitStaticField.Field.Name}"
            )
            let convertedValue = conversions.BindConversion(
                syntax.Expression.Location,
                boundExpression,
                implicitStaticField.Field.Type
            )
            if implicitStaticField.InterfaceType is InterfaceSymbol interfaceType {
                return BoundFieldAssignmentExpression(nil, implicitStaticField.Field, interfaceType, convertedValue)
            }
            if implicitStaticField.StructType is StructSymbol structType {
                return BoundFieldAssignmentExpression(nil, nil, structType, implicitStaticField.Field, convertedValue)
            }
            throw InvalidOperationException("Static field symbol has no owning type.")
        }
        // ADR-0053: bare static property assignment inside a method body
        // (shared or instance) of the enclosing type.
        if variable is ImplicitStaticPropertyVariableSymbol implicitStaticProp {
            if !implicitStaticProp.Property.HasSetter {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name)
            }
            reportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitStaticProp.Property,
                "${implicitStaticProp.StructType.Name}.${implicitStaticProp.Property.Name}"
            )
            let convertedValue = conversions.BindConversion(
                syntax.Expression.Location,
                boundExpression,
                implicitStaticProp.Property.Type
            )
            return BoundPropertyAssignmentExpression(
                nil,
                receiver: nil,
                implicitStaticProp.StructType,
                implicitStaticProp.Property,
                convertedValue
            )
        }
        // Bare property name assignment inside an instance method body resolves
        // to `this.<property> = value` (analogous to implicit field assignment).
        if variable is ImplicitPropertyVariableSymbol implicitProp {
            // Issue #4224: a writable-ref-returning getter (no setter, but
            // `ReturnRefKind == Ref`) stores through the getter instead of
            // failing outright, mirroring the explicit-receiver forms below.
            if !implicitProp
                .Property
                .HasSetter &&
                !IsGetOnlyAutoPropertyConstructorWrite(implicitProp.Property, implicitProp.StructType, receiver: nil) {
                let implicitRefConverted = conversions.BindConversion(
                    syntax.Expression.Location,
                    boundExpression,
                    implicitProp.Property.Type
                )
                if TryBindRefGetterWriteThrough(
                    implicitProp.Property,
                    BoundVariableExpression(nil, implicitProp.Receiver),
                    implicitProp.StructType,
                    implicitProp.StructType,
                    syntax.IdentifierToken.Location,
                    syntax.EqualsToken.Location,
                    implicitRefConverted,
                    out var implicitRefWriteThrough
                ) {
                    return implicitRefWriteThrough
                }
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name)
            }
            EnforceInitOnlyAssignment(implicitProp.Property, receiver: nil, syntax.EqualsToken.Location)
            reportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitProp.Property,
                "${implicitProp.StructType.Name}.${implicitProp.Property.Name}"
            )
            let convertedValue = conversions.BindConversion(
                syntax.Expression.Location,
                boundExpression,
                implicitProp.Property.Type
            )
            return BoundPropertyAssignmentExpression(
                nil,
                BoundVariableExpression(nil, implicitProp.Receiver),
                implicitProp.StructType,
                implicitProp.Property,
                convertedValue
            )
        }
        if variable.IsReadOnly {
            // ADR-0060: an `in` parameter is read-only because of its ref-kind,
            // not because of the standard `let` quality. Report GS0237 with
            // ADR-specific wording instead of the generic "cannot assign to const".
            if variable is ParameterSymbol inParam && inParam.RefKind == RefKind.In {
                Diagnostics.ReportCannotAssignToInParameter(syntax.EqualsToken.Location, name)
            } else {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name)
            }
        }
        let convertedExpression = conversions.BindConversion(syntax.Expression.Location, boundExpression, variable.Type)
        if variable is LocalVariableSymbol{RefKind: RefKind.None} local && ManagedReferenceOrigins.IsScopedHandle(
            convertedExpression
        ) {
            local.IsScoped = true
            local.HoldsScopedManagedReference = true
        }
        return BoundAssignmentExpression(nil, variable, convertedExpression, boundExpression.Type)
    }

    /// Issue #1316 / #2410: binds the RHS of a simple assignment, threading
    /// the resolved LHS [`targetType`](paramref) into the binder for
    /// target-typed RHS forms. Conditional forms engage the same branch-unification and
    /// nil->`T?` adaptation already used for a `let x T? = ...`
    /// initializer. Lambda forms reuse the event-subscription target-typing
    /// path so imported delegate fields/properties can supply omitted
    /// parameter types. Other RHS forms keep their context-free binding; the
    /// per-form conversion below still validates genuine mismatches.
    /// @param syntax The RHS expression syntax.
    /// @param targetType The resolved LHS declared type, or `null`.
    /// @returns The bound RHS expression.
    private func BindAssignmentRhs(syntax ExpressionSyntax, targetType TypeSymbol?) BoundExpression {
        if targetType is {} nonNullTargetTypeForLambda &&
            TryBindLambdaExpressionWithTargetType(syntax, nonNullTargetTypeForLambda, out var targetTypedLambda) {
            return targetTypedLambda!!
        }
        if targetType is {} nonNullTargetType &&
            (
            syntax is IfExpressionSyntax ||
                syntax is IfLetExpressionSyntax ||
                syntax is ConditionalExpressionSyntax ||
                syntax is SwitchExpressionSyntax ||
                syntax is BlockExpressionSyntax
        ) {
            return BindExpression(syntax, nonNullTargetType)
        }
        return BindExpression(syntax)
    }

    /// Issue #946: enforces that an `init`-only property is only assigned
    /// during object initialization. Assignment is permitted when the current
    /// binding context is the declaring type's constructor (`.ctor`) or an
    /// `init` accessor, and the receiver is the instance being initialized
    /// (`this`). Object/aggregate initializers at the creation site bind
    /// through (cref:BindObjectInitializerAssignment) and do not call
    /// this guard, so they are always allowed. Any other assignment reports
    /// `GS0372`. Reads are never restricted.
    /// @param prop The property being assigned.
    /// @param receiver The bound receiver expression, or `null` for an implicit `this` receiver.
    /// @param location The location to report a diagnostic against.
    private func EnforceInitOnlyAssignment(prop PropertySymbol?, receiver BoundExpression?, location TextLocation) {
        if prop == nil || !prop.IsInitOnly {
            return
        }
        let fn FunctionSymbol? = this.function
        let inInitContext = fn != nil && (fn.Name == ".ctor" || fn.IsInitOnlySetter)
        let receiverIsThis = receiver == nil ||
            (
            receiver is BoundVariableExpression bve && fn?.ThisParameter != nil && object.ReferenceEquals(
                bve.Variable,
                fn!!.ThisParameter
            )
        )
        if inInitContext && receiverIsThis {
            return
        }
        Diagnostics.ReportInitOnlyPropertyAssignment(location, prop.Name)
    }

    /// Issue #947: determines whether an assignment to a read-only (`let`)
    /// field is permitted in the current binding context. Mirrors C#
    /// `readonly` field semantics: a read-only <em>instance</em> field may
    /// be assigned (any number of times) inside the declaring type's instance
    /// constructor (`init(...)`, bound as `.ctor`) when the target is
    /// the instance being constructed (`this`), in addition to its
    /// declaration initializer. Anywhere else — other methods, after
    /// construction, on another instance, or from a derived type's constructor
    /// against a base-declared field — the assignment remains a `GS0127`
    /// error. Static read-only fields keep their existing behavior (assignable
    /// only via their initializer, since G# exposes no user-writable static
    /// constructor body).
    /// @param field The field being assigned.
    /// @param declaringType The type that declares [`field`](paramref), when known, used to
    /// reject writes to an inherited read-only field from a derived
    /// constructor; `null` when the caller cannot determine it.
    /// @param receiverIsThis `true` when the assignment targets a field of the
    /// instance currently under construction (`this`).
    /// @returns `true` when the read-only field assignment is allowed here.
    private func IsReadOnlyFieldAssignmentAllowed(
        field FieldSymbol?,
        declaringType TypeSymbol?,
        receiverIsThis bool
    ) bool {
        if field == nil || !field.IsReadOnly {
            return true
        }
        // Static read-only fields are only writable from their initializer (the
        // emitter materializes those into the synthesized static constructor).
        // G# has no user-authored static constructor body, so keep the existing
        // GS0127 behavior for any explicit write.
        if field.IsStatic {
            return false
        }
        let fn FunctionSymbol? = this.function
        if fn == nil || fn.Name != ".ctor" || fn.ThisParameter == nil {
            return false
        }
        if !receiverIsThis {
            return false
        }
        // C# forbids a derived constructor from assigning a base type's
        // read-only field; only the declaring type's constructor may do so.
        if declaringType != nil && fn.ReceiverType != nil && !object.ReferenceEquals(declaringType, fn.ReceiverType) {
            return false
        }
        return true
    }

    /// Issue #4350: whether an assignment to a get-only auto-property
    /// (`prop P T { get; }`) is the C#-legal constructor write that stores
    /// its synthesized backing field. As in C#, only the DECLARING type's
    /// instance constructor may assign it, and only on the instance being
    /// constructed; a lambda or local function inside that constructor is a
    /// different function and stays rejected (C# CS0200). The write needs no
    /// setter: the lowerer turns a declaring-type auto-property store into a
    /// backing-field store.
    /// @param property The property being assigned.
    /// @param declaringType The type that declares [`property`](paramref).
    /// @param receiver The bound receiver, or `null` for an implicit `this`.
    /// @returns `true` when the write is a permitted constructor store.
    private func IsGetOnlyAutoPropertyConstructorWrite(
        property PropertySymbol,
        declaringType TypeSymbol?,
        receiver BoundExpression?
    ) bool {
        if property.HasSetter ||
            !property.IsAutoProperty ||
            property.BackingField == nil ||
            property.ReturnRefKind != RefKind.None {
            return false
        }
        let fn FunctionSymbol? = this.function
        if fn == nil || fn.Name != ".ctor" || fn.ThisParameter == nil {
            return false
        }
        let receiverIsThis = receiver == nil ||
            (
            receiver is BoundVariableExpression variableReceiver && object.ReferenceEquals(
                variableReceiver.Variable,
                fn.ThisParameter
            )
        )
        if !receiverIsThis {
            return false
        }
        // C# forbids a derived constructor from assigning a base type's
        // get-only auto-property; only the declaring type's constructor may.
        // Compared through the constructor's own property list (backing-field
        // identity survives generic substitution) because an implicit bare
        // name reports the enclosing type, not the declaring one.
        if fn.ReceiverType is not StructSymbol constructedType {
            return false
        }
        if declaringType is StructSymbol declaringStruct && !object.ReferenceEquals(
            declaringStruct.Definition ?? declaringStruct,
            constructedType.Definition ?? constructedType
        ) {
            return false
        }
        for own in(constructedType.Definition ?? constructedType).Properties {
            if object.ReferenceEquals(own, property) || object.ReferenceEquals(
                own.BackingField,
                property.BackingField
            ) {
                return true
            }
        }
        return false
    }

    /// Issue #947: returns `true` when [`variable`](paramref)
    /// is the enclosing function's `this` parameter (the instance under
    /// construction or the method's receiver).
    /// @param variable The receiver variable symbol.
    /// @returns `true` when the receiver is `this`.
    private func ReceiverVariableIsThis(variable VariableSymbol) bool {
        let fn = this.function
        return fn?.ThisParameter != nil && object.ReferenceEquals(variable, fn!!.ThisParameter)
    }

    /// Issue #1132: returns `true` when a member write through
    /// [`receiver`](paramref) must be rejected because the receiver is a
    /// read-only (e.g. `let`) local of a <em>value</em> type — mutating one
    /// of its members would mutate the value stored in the read-only slot. A
    /// reference-type receiver (mutating the heap object) and the enclosing
    /// `this` are both exempt.
    /// @param receiver The bound receiver of the member write.
    /// @returns `true` when the member write must be rejected.
    private func ReceiverBlocksValueTypeMemberWrite(receiver BoundExpression) bool {
        return (
            receiver is BoundVariableExpression bve &&
                bve
                .Variable
                .IsReadOnly &&
                !ReceiverVariableIsThis(bve.Variable) &&
                !ReceiverTypeIsReference(bve.Variable.Type)
        ) ||
            RefCapabilities.IsReadOnlyValueReference(receiver)
    }

    /// ADR-0156 Phase 2 (issue #3185): classification of a member-write
    /// receiver whose chain bottoms out at a prior interactive submission's
    /// top-level global (an addressable static field on that submission's
    /// `<Program>` container). `None` for every other shape,
    /// so non-REPL binding behavior is unchanged.
    private enum SubmissionWriteReceiverKind {
        None,
        Addressable,
        ReadOnlyRoot,
        NotAddressable
    }

    /// Issue #4224 (root cause #5): when an instance property has no setter
    /// but its getter returns by `ref` (a native writable-ref-returning
    /// property, e.g. `prop Value ref int32 { get { return ref slot } }`),
    /// assignment does not need an invented setter — it stores through the
    /// getter's managed pointer instead, mirroring the existing imported
    /// span/ref-indexer write-through path (`MakeClrIndexAssignment`).
    /// A `ref readonly` getter ((cref:RefKind.RefReadOnly)) is
    /// excluded: its storage stays protected exactly like a missing setter.
    /// Reuses (cref:IsWritableStructFieldReceiver) — the same
    /// struct-temporary/read-only-binding guard a plain field write through an
    /// arbitrary receiver chain already applies — so writing through a
    /// value-type receiver that is itself a temporary (e.g. a by-value
    /// struct-returning call) or a read-only (`let`) binding is rejected
    /// exactly as it would be for a field.
    /// @param prop The property being assigned.
    /// @param receiver The bound instance receiver (evaluated once; reused verbatim, not re-bound).
    /// @param receiverStructType The receiver's resolved struct/class type.
    /// @param declaringType The type that declares [`prop`](paramref), for the getter accessibility check.
    /// @param memberLocation The location to report a getter-inaccessible diagnostic against.
    /// @param equalsLocation The location to report a struct-temporary diagnostic against.
    /// @param convertedValue The already-converted right-hand-side value.
    /// @param result The bound write-through expression, or an error expression when rejected.
    /// @returns `false` when [`prop`](paramref)'s getter is not `ref`-returning — the caller should report
    /// its own "not assignable" diagnostic instead.
    private func TryBindRefGetterWriteThrough(
        prop PropertySymbol,
        receiver BoundExpression,
        receiverStructType StructSymbol,
        declaringType StructSymbol,
        memberLocation TextLocation,
        equalsLocation TextLocation,
        convertedValue BoundExpression,
        out result BoundExpression
    ) bool {
        if prop.ReturnRefKind != RefKind.Ref {
            result = BoundErrorExpression(nil)
            return false
        }
        // ADR-0187 / issue #4350: a non-@UnscopedRef getter cannot return into
        // its (possibly copied) receiver, so the write lands in the storage the
        // reference names regardless of the receiver's writability — C#'s rule.
        if !receiverStructType.IsClass &&
            !IsWritableStructFieldReceiver(receiver) &&
            (prop.GetterSymbol?.HasUnscopedRef ?? true) {
            Diagnostics.ReportFieldAssignmentThroughStructTemporary(equalsLocation, prop.Name, receiverStructType)
            result = BoundErrorExpression(nil)
            return true
        }
        if !AccessibilityChecker.IsAccessible(prop.GetterAccessibility, declaringType, this.function) {
            Diagnostics.ReportMemberInaccessible(
                memberLocation,
                prop.Name,
                declaringType.Name,
                prop.GetterAccessibility
            )
        }
        let access = BoundPropertyAccessExpression(nil, receiver, receiverStructType, prop)
        result = BoundIndirectAssignmentExpression(
            nil,
            BoundAddressOfExpression(nil, access, unmanaged: false),
            convertedValue
        )
        return true
    }

    private func IsWritableStructFieldReceiver(receiver BoundExpression) bool {
        if receiver is BoundTupleElementAccessExpression tuple {
            return IsWritableStructFieldReceiver(tuple.Receiver)
        }
        if RefCapabilities.IsRefReturningAccess(receiver) {
            return !RefCapabilities.IsReadOnlyReference(receiver)
        }
        if receiver is BoundVariableExpression variable {
            // Unboxing a narrowed reference slot yields a controlled-mutability
            // address, not writable struct storage.
            if variable.NarrowedType != nil &&
                ReceiverTypeIsReference(variable.Variable.Type) &&
                !ReceiverTypeIsReference(variable.Type) {
                return false
            }
            return !ReceiverBlocksValueTypeMemberWrite(receiver)
        }
        if receiver is BoundClrPropertyAccessExpression access {
            if access.Member is not FieldInfo field ||
                field.IsInitOnly ||
                access.IsReadOnlySubmissionGlobal ||
                !RefCapabilities.IsDirectlyAddressableForImplicitIn(access) {
                return false
            }
            let owner = access.Receiver
            return owner == nil || ReceiverTypeIsReference(owner.Type) || IsWritableStructFieldReceiver(owner)
        }
        if receiver is BoundDereferenceExpression dereference {
            return (
                TypeSymbol.IsUnmanagedPointer(dereference.Operand.Type) || dereference.Operand.Type is ByRefTypeSymbol
            ) &&
                !RefCapabilities.IsReadOnlyReference(dereference.Operand)
        }
        // Issue #3292: an array/slice element is real storage — the emitter
        // roots the write chain at the element address (`ldelema`), exactly
        // as C# does for `ps[0].X = v`. This holds regardless of how the
        // collection itself was produced (variable, field, call result, or a
        // `let` binding: the write mutates the heap array, not the binding —
        // issue #1132's shallow-immutability rule). Map elements
        // (Dictionary indexer copies) and CLR indexer results
        // (BoundClrIndexExpression) have no element address and keep the
        // GS0499 struct-temporary rejection.
        if receiver is BoundIndexExpression indexReceiver {
            return indexReceiver.IsArrayBackedElementAccess
        }
        if receiver is not BoundFieldAccessExpression fieldAccess {
            return false
        }
        if fieldAccess.NarrowedType != nil &&
            ReceiverTypeIsReference(fieldAccess.SubstitutedType ?? fieldAccess.Field.Type) &&
            !ReceiverTypeIsReference(fieldAccess.Type) {
            return false
        }
        if fieldAccess.Receiver == nil {
            let staticConstructorOwner = if function?.IsStaticInitializer == true {
                function!!.StaticOwnerType as Symbol
            } else {
                default(Symbol?)
            }
            return fieldAccess.Field.IsStaticAddressLegal(staticConstructorOwner)
        }
        if fieldAccess
            .Field
            .IsReadOnly &&
            fieldAccess.StructType is {} fieldDeclaringType &&
            !IsReadOnlyFieldAssignmentAllowed(
            fieldAccess.Field,
            fieldDeclaringType,
            ReceiverExpressionIsThis(fieldAccess.Receiver)
        ) {
            return false
        }
        return ReceiverTypeIsReference(fieldAccess.Receiver!!.Type) ||
            IsWritableStructFieldReceiver(fieldAccess.Receiver!!)
    }

    /// Issue #947: returns `true` when the bound
    /// [`receiver`](paramref) denotes the enclosing function's `this`
    /// (a `null` receiver is an implicit `this`).
    /// @param receiver The bound receiver expression, or `null`.
    /// @returns `true` when the receiver is `this`.
    private func ReceiverExpressionIsThis(receiver BoundExpression?) bool {
        let fn = this.function
        if fn?.ThisParameter == nil {
            return false
        }
        return receiver == nil ||
            (receiver is BoundVariableExpression bve && object.ReferenceEquals(bve.Variable, fn!!.ThisParameter))
    }

    private func BindObjectInitializerAssignment(
        receiverLocal LocalVariableSymbol,
        receiverType TypeSymbol,
        initSyntax PropertyInitializerSyntax
    ) BoundExpression? -> BindInitializerMemberAssignment(
        receiverLocal,
        receiverType,
        initSyntax.PropertyIdentifier,
        initSyntax.EqualsToken,
        initSyntax.Value,
        initSyntax
    )

    private func BindInitializerMemberAssignment(
        receiverLocal LocalVariableSymbol,
        receiverType TypeSymbol,
        memberIdentifier SyntaxToken,
        separator SyntaxToken,
        valueSyntax ExpressionSyntax,
        anchor SyntaxNode
    ) BoundExpression? {
        let propertyName = memberIdentifier.ValueText
        if receiverType is InterfaceSymbol interfaceSymbol {
            if !TypeMemberModel.TryGetPropertyWithOwner(
                interfaceSymbol,
                propertyName,
                out var property,
                out var propertyOwner
            ) {
                Diagnostics.ReportUnableToFindMember(memberIdentifier.Location, propertyName)
                let _ = BindExpression(valueSyntax)
                return nil
            }
            if !property.HasSetter {
                Diagnostics.ReportCannotAssign(separator.Location, propertyName)
                let _ = BindExpression(valueSyntax)
                return nil
            }
            let effectiveInterface = Invariant.Required(
                propertyOwner as InterfaceSymbol,
                "an interface property has an effective interface owner",
                expression: "propertyOwner as InterfaceSymbol"
            )
            if !AccessibilityChecker.IsAccessible(property.SetterAccessibility, effectiveInterface, this.function) {
                Diagnostics.ReportMemberInaccessible(
                    memberIdentifier.Location,
                    property.Name,
                    effectiveInterface.Name,
                    property.SetterAccessibility
                )
            }
            let propertyType = effectiveInterface.SubstituteMemberType(property.Type)
            let converted = BindExpression(valueSyntax, propertyType)
            let receiverExpr = BoundVariableExpression(anchor, receiverLocal)
            return BoundPropertyAssignmentExpression(
                anchor,
                receiverExpr,
                nil,
                property,
                converted,
                if object.ReferenceEquals(propertyType, property.Type) {
                    default(TypeSymbol?)
                } else {
                    propertyType
                },
                effectiveInterface
            )
        }
        // Receiver-side type discriminator mirrors the receiver dispatch in
        // BindFieldAssignmentExpression: pure CLR types go through reflection;
        // user-defined StructSymbols use the symbol tables; both can fall
        // through to ImportedBaseType lookup for inherited CLR members.
        if !(receiverType is StructSymbol) && !(receiverType is NullableTypeSymbol) && receiverType.ClrType != nil {
            let clrReceiverType = receiverType.ClrType
            var instanceMember MemberInfo? = SafeGetVisibleInstanceProperty(clrReceiverType, propertyName)
            if instanceMember is PropertyInfo idxProp && idxProp.GetIndexParameters().Length != 0 {
                instanceMember = nil
            }
            instanceMember ??= SafeGetVisibleInstanceField(clrReceiverType, propertyName)
            if instanceMember == nil {
                Diagnostics.ReportUnableToFindMember(memberIdentifier.Location, propertyName)
                let _ = BindExpression(valueSyntax)
                return nil
            }
            if !TryGetWritableClrMember(instanceMember, receiverType, out _, out var instTargetSymbol, out _) {
                Diagnostics.ReportCannotAssign(separator.Location, propertyName)
                let _ = BindExpression(valueSyntax)
                return nil
            }
            let converted = BindExpression(valueSyntax, instTargetSymbol!!)
            let receiverExpr = BoundVariableExpression(anchor, receiverLocal)
            return BoundClrPropertyAssignmentExpression(
                anchor,
                receiverExpr,
                instanceMember,
                converted,
                instTargetSymbol!!,
                staticContainerType: nil
            )
        }
        if receiverType is StructSymbol structSymbol {
            let hasNearestProperty = TypeMemberModel.TryGetProperty(
                structSymbol,
                propertyName,
                out var nearestProperty,
                out var nearestPropertyDeclaringType
            )
            let hasInitializerField = TypeMemberModel.TryGetFieldIncludingInherited(
                structSymbol,
                propertyName,
                MemberQuery.Instance(MemberKinds.Field),
                out var field,
                out var fieldDeclaringType
            )
            if hasInitializerField &&
                (
                !hasNearestProperty ||
                    IsFieldAtLeastAsNearAsProperty(
                    structSymbol,
                    Invariant.Required(
                        fieldDeclaringType,
                        "a resolved field has a declaring type",
                        expression: "fieldDeclaringType"
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
                field = Invariant.Required(field, "a resolved initializer field has a symbol", expression: "field")
                fieldDeclaringType = Invariant.Required(
                    fieldDeclaringType,
                    "a resolved initializer field has a declaring type",
                    expression: "fieldDeclaringType"
                )
                // Issue #2059: an object-initializer-suffix (`T(){ Field = v }`)
                // member write is subject to the same `protected`/`private`
                // accessibility rule as a plain assignment (issue #950 / #2044).
                if !AccessibilityChecker.IsAccessible(field.Accessibility, fieldDeclaringType, this.function) {
                    Diagnostics.ReportMemberInaccessible(
                        memberIdentifier.Location,
                        field.Name,
                        fieldDeclaringType.Name,
                        field.Accessibility
                    )
                }
                if field.IsReadOnly {
                    Diagnostics.ReportCannotAssign(memberIdentifier.Location, propertyName)
                    let _ = BindExpression(valueSyntax)
                    return nil
                }
                let converted = BindExpression(valueSyntax, field.Type)
                return BoundFieldAssignmentExpression(anchor, receiverLocal, fieldDeclaringType, field, converted)
            }
            if hasNearestProperty {
                let prop = Invariant.Required(
                    nearestProperty,
                    "a resolved initializer property has a symbol",
                    expression: "nearestProperty"
                )
                var propDeclaringType = nearestPropertyDeclaringType
                propDeclaringType = Invariant.Required(
                    propDeclaringType,
                    "a user-defined struct property has a declaring type",
                    expression: "propDeclaringType"
                )
                if !prop.HasSetter {
                    Diagnostics.ReportCannotAssign(separator.Location, propertyName)
                    let _ = BindExpression(valueSyntax)
                    return nil
                }
                // Issue #2059: object-initializer-suffix property write —
                // mirrors the field check above.
                if !AccessibilityChecker.IsAccessible(prop.SetterAccessibility, propDeclaringType, this.function) {
                    Diagnostics.ReportMemberInaccessible(
                        memberIdentifier.Location,
                        prop.Name,
                        propDeclaringType.Name,
                        prop.SetterAccessibility
                    )
                }
                let converted = BindExpression(valueSyntax, prop.Type)
                let receiverExpr = BoundVariableExpression(anchor, receiverLocal)
                return BoundPropertyAssignmentExpression(anchor, receiverExpr, structSymbol, prop, converted)
            }
            // Issue #319 / #1582 parity: fall through to imported base CLR
            // members reachable through the user base chain, including inherited
            // protected members.
            if GetInheritedClrBaseType(structSymbol) is Type inheritedBaseClr {
                var inhMember MemberInfo? = ClrTypeUtilities.SafeGetInheritedInstanceProperty(
                    inheritedBaseClr,
                    propertyName,
                    CanAccessInternalsOf
                )
                inhMember ??= ClrTypeUtilities.SafeGetInheritedInstanceField(
                    inheritedBaseClr,
                    propertyName,
                    CanAccessInternalsOf
                )
                if inhMember != nil {
                    // Issue #3815: project the inherited member through the
                    // derived receiver so an imported GENERIC base's member keeps
                    // the derived type's own type arguments (ChannelReader[T], not
                    // the erased ChannelReader[object]).
                    if !TryGetWritableClrMember(
                        inhMember,
                        structSymbol,
                        out _,
                        out var inhTargetSymbol,
                        out _,
                        fromDerivedType: true
                    ) {
                        Diagnostics.ReportCannotAssign(separator.Location, propertyName)
                        let _ = BindExpression(valueSyntax)
                        return nil
                    }
                    let converted = BindExpression(valueSyntax, inhTargetSymbol!!)
                    let receiverExpr = BoundVariableExpression(anchor, receiverLocal)
                    return BoundClrPropertyAssignmentExpression(
                        anchor,
                        receiverExpr,
                        inhMember,
                        converted,
                        inhTargetSymbol!!,
                        staticContainerType: nil
                    )
                }
            }
            Diagnostics.ReportUnableToFindMember(memberIdentifier.Location, propertyName)
            let _ = BindExpression(valueSyntax)
            return nil
        }
        Diagnostics.ReportUnableToFindMember(memberIdentifier.Location, propertyName)
        let _ = BindExpression(valueSyntax)
        return nil
    }

    private func BindFieldAssignmentExpression(syntax FieldAssignmentExpressionSyntax) BoundExpression {
        let receiverName = syntax.Receiver.Text
        // Issue #1104: `base.Prop = value` — a non-virtual write to the nearest
        // base class implementation of property `Prop`, mirroring C#
        // `base.Prop = value`. `base` is a contextual keyword: only intercepted
        // when it is not a real value in scope.
        if IsContextualBaseKeyword(NameExpressionSyntax(syntax.SyntaxTree, syntax.Receiver)) {
            let baseValue = BindExpression(syntax.Value)
            return BindBaseClassPropertyWrite(
                syntax.FieldIdentifier.ValueText,
                syntax.FieldIdentifier.Location,
                syntax.Receiver.Location,
                baseValue,
                syntax.Value.Location,
                syntax.EqualsToken.Location,
                explicitBaseType: nil,
                selectorLocation: syntax.Receiver.Location
            )
        }
        binderCtx.TryLookupSourceType($scope, receiverName, preferredArity: 0, function, out var sourceTypeAlias, out _)
        var importedTypeOverride ImportedClassSymbol? = nil
        if sourceTypeAlias != nil {
            let _ = TryResolveImportedTypeOverride(
                receiverName,
                sourceTypeAlias,
                requestedArity: 0,
                declaration: nil,
                out importedTypeOverride
            )
        }
        // ADR-0053: user-defined struct/class type → static field write.
        if importedTypeOverride == nil && sourceTypeAlias is StructSymbol userStruct {
            let fieldName = syntax.FieldIdentifier.ValueText
            if TypeMemberModel.TryGetStaticFieldIncludingInherited(
                userStruct,
                fieldName,
                out var staticField,
                out var fieldOwner
            ) {
                if !AccessibilityChecker.IsAccessible(staticField.Accessibility, fieldOwner, function) {
                    Diagnostics.ReportMemberInaccessible(
                        syntax.FieldIdentifier.Location,
                        staticField.Name,
                        fieldOwner.Name,
                        staticField.Accessibility
                    )
                }
                if staticField.IsReadOnly {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName)
                }
                let fieldType = fieldOwner.SubstituteMemberType(staticField.Type)
                let staticValue = BindAssignmentRhs(syntax.Value, fieldType)
                let staticConverted = conversions.BindConversion(syntax.Value.Location, staticValue, fieldType)
                return BoundFieldAssignmentExpression(nil, nil, fieldOwner, staticField, staticConverted, fieldType)
            }
            // Issue #263: static property assignment.
            if TypeMemberModel.TryGetStaticPropertyIncludingInherited(
                userStruct,
                fieldName,
                out var prop,
                out var propertyOwner
            ) {
                if !AccessibilityChecker.IsAccessible(prop.SetterAccessibility, propertyOwner, function) {
                    Diagnostics.ReportMemberInaccessible(
                        syntax.FieldIdentifier.Location,
                        prop.Name,
                        propertyOwner.Name,
                        prop.SetterAccessibility
                    )
                }
                if !prop.HasSetter {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName)
                    return BoundErrorExpression(nil)
                }
                let staticValue = BindAssignmentRhs(syntax.Value, prop.Type)
                let propConverted = conversions.BindConversion(syntax.Value.Location, staticValue, prop.Type)
                return BoundPropertyAssignmentExpression(nil, receiver: nil, propertyOwner, prop, propConverted)
            }
            if TypeMemberModel.GetNearestImportedBase(userStruct)?.ClrType is Type importedBaseClr {
                let importedBase = WithFamilyAccess(
                    ImportedClassSymbol(importedBaseClr, syntax, references: $scope.References)
                )
                if importedBase.TryLookupMember(fieldName, ne: nil, out var inheritedStaticMember) &&
                    TryGetWritableClrMember(
                    inheritedStaticMember,
                    out _,
                    out var inheritedTarget,
                    out _,
                    fromDerivedType: true
                ) {
                    let inheritedValue = BindAssignmentRhs(syntax.Value, inheritedTarget)
                    let inheritedConverted = conversions.BindConversion(
                        syntax.Value.Location,
                        inheritedValue,
                        inheritedTarget
                    )
                    return BoundClrPropertyAssignmentExpression(
                        nil,
                        receiver: nil,
                        inheritedStaticMember!!,
                        inheritedConverted,
                        inheritedTarget!!,
                        staticContainerType: nil
                    )
                }
            }
            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName)
            return BoundErrorExpression(nil)
        }
        // ADR-0089 / issue #1030: user-defined interface type → static field
        // write (`IName.Field = value`). Interface static fields are plain CLR
        // static fields; emit a static (null receiver / null declaring struct)
        // BoundFieldAssignmentExpression resolved by symbol identity.
        if importedTypeOverride == nil && sourceTypeAlias is InterfaceSymbol userInterface {
            let fieldName = syntax.FieldIdentifier.ValueText
            let staticField FieldSymbol? = userInterface.GetStaticField(fieldName)
            if staticField != nil {
                if staticField.IsReadOnly || staticField.IsConst {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName)
                }
                let fieldType = userInterface.SubstituteMemberType(staticField.Type)
                let staticValue = BindAssignmentRhs(syntax.Value, fieldType)
                let staticConverted = conversions.BindConversion(syntax.Value.Location, staticValue, fieldType)
                return BoundFieldAssignmentExpression(nil, staticField, userInterface, staticConverted, fieldType)
            }
            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName)
            return BoundErrorExpression(nil)
        }
        // ADR-0156 Phase 2 (issue #3185): `name.Member = value` where `name`
        // is a top-level global declared by a prior interactive submission.
        // Consulted before the imported-class probe so a prior cell's global
        // shadows a same-named imported type, mirroring the read fallback's
        // ordering in BindAccessorExpression.
        if TryBindSubmissionGlobalMemberAssignment(syntax, out var submissionMemberWrite) &&
            submissionMemberWrite is {} resolvedSubmissionMemberWrite {
            return resolvedSubmissionMemberWrite
        }
        // Stream B: imported class name on LHS → static field/property write.
        // Submission globals retain value precedence; source/import type
        // precedence was resolved lexically above.
        var importedClass ImportedClassSymbol? = importedTypeOverride
        if importedClass != nil || $scope.TryLookupImportedClass(receiverName, declaration: nil, out importedClass) {
            // A derived class may write an inherited `protected` static member
            // through the declaring type's name, as in C#.
            importedClass = WithFamilyAccess(importedClass!!)
            if !importedClass.TryLookupMember(syntax.FieldIdentifier.ValueText, ne: nil, out var staticMember) {
                Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, syntax.FieldIdentifier.ValueText)
                return BoundErrorExpression(nil)
            }
            if !TryGetWritableClrMember(
                staticMember,
                out var staticTargetType,
                out var staticTargetSymbol,
                out var staticWritable,
                fromDerivedType: importedClass.IsFamilyAccessible(staticMember!!.DeclaringType)
            ) {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, syntax.FieldIdentifier.ValueText)
                return BoundErrorExpression(nil)
            }
            let staticValue = BindAssignmentRhs(syntax.Value, staticTargetSymbol)
            let staticConverted = conversions.BindConversion(syntax.Value.Location, staticValue, staticTargetSymbol)
            return BoundClrPropertyAssignmentExpression(
                nil,
                receiver: nil,
                staticMember!!,
                staticConverted,
                staticTargetSymbol!!,
                staticContainerType: nil
            )
        }
        let variable VariableSymbol? = BindVariableReference(receiverName, syntax.Receiver.Location)
        if variable == nil {
            return BindExpression(syntax.Value)
        }
        // Issue #1316: bind the RHS lazily so a target-typed form
        // (if-/conditional-/switch-expression) can receive the resolved
        // destination member's declared type as the expected type — the same
        // nil-&gt;`T?` / branch-unification adaptation a `let x T? = ...`
        // initializer already gets. The first conversion site below binds it
        // (exactly once); non-target-typed forms still bind context-free.
        var value BoundExpression? = nil
        let BindValue = func (targetType TypeSymbol) BoundExpression {
            return (
                if value == nil {
                    (value = BindAssignmentRhs(syntax.Value, targetType))
                } else {
                    value
                }
            )!!
        }
        // Issue #689 (follow-up to #655): when the receiver name resolves to an
        // implicit field on `this` (e.g. `Tracker.Value = v` where Tracker is a
        // field), the raw ImplicitFieldVariableSymbol has no local slot and the
        // emitter throws GS9998 at EmitLoadVariable time. Synthesize an
        // expression receiver (`this.Tracker`) so the resulting bound node
        // carries a real BoundExpression receiver. The async/sync-iterator
        // state-machine rewriters already recurse through BoundFieldAccess-
        // Expression and substitute the `this` parameter with the hoisted
        // `<>4__this` proxy field — routing through an expression receiver
        // makes the write path symmetric with the read path fixed in #655.
        var implicitFieldReceiverExpr BoundExpression? = nil
        if variable is ImplicitFieldVariableSymbol implicitField {
            implicitFieldReceiverExpr = BoundFieldAccessExpression(
                nil,
                BoundVariableExpression(nil, implicitField.Receiver),
                implicitField.StructType,
                implicitField.Field
            )
        } else if variable is ImplicitPropertyVariableSymbol implicitPropReceiver &&
            implicitPropReceiver
            .Property
            .HasGetter {
            // Issue #1446 (follow-up to #689/#1339): the property counterpart
            // of the implicit-field case above. A bare instance-property name
            // used as the *receiver* of a member write (`Prop.Member = v`,
            // `Prop.Member++`) resolves to an ImplicitPropertyVariableSymbol,
            // which likewise has no local slot. Synthesize `this.Prop` (a
            // getter call) so the receiver carries a real BoundExpression —
            // for a reference-typed property this yields the live object whose
            // member the write then mutates, symmetric with the read path.
            implicitFieldReceiverExpr = BoundPropertyAccessExpression(
                nil,
                BoundVariableExpression(nil, implicitPropReceiver.Receiver),
                implicitPropReceiver.StructType,
                implicitPropReceiver.Property
            )
        } else if variable is ImplicitStaticFieldVariableSymbol implicitStaticFieldReceiver {
            // Issue #3489: the STATIC counterparts of the two cases above. A
            // bare `shared` field/property name used as the receiver of a
            // member write (`Instance.flush = v`, `Instance.Flag = v`)
            // resolves to the implicit-static variable symbols, which have no
            // local slot either — the emitter threw the same GS9998 the
            // instance shapes did before #689/#1446. Synthesize the static
            // access the read path (BindNameAccessReceiver) already uses.
            implicitFieldReceiverExpr = if implicitStaticFieldReceiver.InterfaceType != nil {
                BoundFieldAccessExpression(
                    nil,
                    implicitStaticFieldReceiver.Field,
                    implicitStaticFieldReceiver.InterfaceType
                )
            } else {
                BoundFieldAccessExpression(
                    nil,
                    receiver: nil,
                    implicitStaticFieldReceiver.StructType,
                    implicitStaticFieldReceiver.Field
                )
            }
        } else if variable is ImplicitStaticPropertyVariableSymbol implicitStaticPropReceiver &&
            implicitStaticPropReceiver
            .Property
            .HasGetter {
            implicitFieldReceiverExpr = BoundPropertyAccessExpression(
                nil,
                receiver: nil,
                implicitStaticPropReceiver.StructType,
                implicitStaticPropReceiver.Property
            )
        }
        // Issue #2488: classify and bind the write through the same narrowed
        // receiver view used by reads. The symbol retains its declared nullable
        // storage type, while the bound receiver carries the effective type
        // proven by the active if-let/null-guard frame.
        var assignmentReceiver = implicitFieldReceiverExpr ??
            BuildNarrowedVariableRead(variable, syntax.FieldIdentifier.Location)
        if assignmentReceiver is BoundVariableExpression variableRead && variableRead.NarrowedType != nil {
            binderCtx.TrackBackwardGotoNarrowingUse(
                variableRead.Variable,
                syntax.FieldIdentifier.Location,
                syntax.FieldIdentifier.ValueText,
                BackwardGotoNarrowingUseKind.Member
            )
        }
        let assignmentReceiverType = assignmentReceiver.Type
        // Stream B: instance-CLR receiver → property/field write via reflection.
        if !(assignmentReceiverType is StructSymbol) &&
            !(assignmentReceiverType is NullableTypeSymbol) &&
            assignmentReceiverType?.ClrType != nil {
            let clrReceiverType = assignmentReceiverType.ClrType
            let fieldName = syntax.FieldIdentifier.ValueText
            var instanceMember MemberInfo? = SafeGetVisibleInstanceProperty(clrReceiverType!!, fieldName)
            if instanceMember is PropertyInfo prop && prop.GetIndexParameters().Length != 0 {
                instanceMember = nil
            }
            instanceMember ??= SafeGetVisibleInstanceField(clrReceiverType!!, fieldName)
            if instanceMember == nil {
                Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName)
                return BoundErrorExpression(nil)
            }
            if !TryGetWritableClrMember(
                instanceMember,
                assignmentReceiverType,
                out var instTargetType,
                out var instTargetSymbol,
                out var instWritable
            ) ||
                RefCapabilities
                .IsReadOnlyValueReference(assignmentReceiver) {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName)
                return BoundErrorExpression(nil)
            }
            assignmentReceiver,
            instanceMember = RecoverDeclaredClrMemberWriteReceiver(
                assignmentReceiver,
                syntax.FieldIdentifier.Location,
                instanceMember
            )
            let instConverted = conversions.BindConversion(
                syntax.Value.Location,
                BindValue(instTargetSymbol!!),
                instTargetSymbol
            )
            return BoundClrPropertyAssignmentExpression(
                nil,
                assignmentReceiver,
                instanceMember!!,
                instConverted,
                instTargetSymbol!!,
                staticContainerType: nil
            )
        }
        // Issue #1068: an interface-typed variable receiver (`d.W = v` where
        // d : IDerived) writes the interface property setter (walking base
        // interfaces). Mirrors the read path and the expression-receiver write
        // path; the emitter dispatches via `callvirt set_W`.
        if assignmentReceiverType is InterfaceSymbol ifaceVarType {
            if TypeMemberModel.TryGetPropertyWithOwner(
                ifaceVarType,
                syntax.FieldIdentifier.ValueText,
                out var ifaceProp,
                out var ifaceOwner
            ) {
                if !ifaceProp.HasSetter {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, syntax.FieldIdentifier.ValueText)
                    return BoundErrorExpression(nil)
                }
                let effectiveInterface = Invariant.Required(
                    ifaceOwner as InterfaceSymbol,
                    "an interface property has an effective interface owner",
                    expression: "ifaceOwner as InterfaceSymbol"
                )
                if !AccessibilityChecker.IsAccessible(
                    ifaceProp.SetterAccessibility,
                    effectiveInterface,
                    this.function
                ) {
                    Diagnostics.ReportMemberInaccessible(
                        syntax.FieldIdentifier.Location,
                        ifaceProp.Name,
                        effectiveInterface.Name,
                        ifaceProp.SetterAccessibility
                    )
                }
                let propertyType = effectiveInterface.SubstituteMemberType(ifaceProp.Type)
                assignmentReceiver = RecoverDeclaredPropertyWriteReceiver(
                    assignmentReceiver,
                    syntax.FieldIdentifier.Location,
                    ifaceProp
                )
                let ifaceConverted = conversions.BindConversion(
                    syntax.Value.Location,
                    BindValue(propertyType),
                    propertyType
                )
                EnforceInitOnlyAssignment(ifaceProp, assignmentReceiver, syntax.EqualsToken.Location)
                return BoundPropertyAssignmentExpression(
                    nil,
                    assignmentReceiver,
                    nil,
                    ifaceProp,
                    ifaceConverted,
                    if object.ReferenceEquals(propertyType, ifaceProp.Type) {
                        default(TypeSymbol?)
                    } else {
                        propertyType
                    },
                    effectiveInterface
                )
            }
            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, syntax.FieldIdentifier.ValueText)
            return BoundErrorExpression(nil)
        }
        // Issue #1235 (write side, follow-up to the read path in
        // BindTypeParameterInstanceMemberAccess): a variable receiver whose
        // static type is a type parameter constrained to a class (`t.F = v`
        // with `t : T`, `T : Base`) or to a user-declared interface (`t.P = v`
        // with `T : IShape`) writes through the constraint's field/property, the
        // same instance member surface the read path already exposes. The
        // emitter dispatches via `box !!T; stfld` (fields) or
        // `box !!T; callvirt set_X` (properties) — mirroring the read path's
        // `box !!T; ldfld`/`callvirt get_X`.
        if assignmentReceiverType is TypeParameterSymbol tpVarType {
            if tpVarType.ClassConstraint is StructSymbol tpClassConstraint {
                if TypeMemberModel.TryGetFieldIncludingInherited(
                    tpClassConstraint,
                    syntax.FieldIdentifier.ValueText,
                    MemberQuery.Instance(MemberKinds.Field),
                    out var tpField,
                    out var tpFieldDeclaringType
                ) {
                    let tpFieldConverted = conversions.BindConversion(
                        syntax.Value.Location,
                        BindValue(tpField.Type),
                        tpField.Type
                    )
                    return BoundFieldAssignmentExpression(
                        nil,
                        variable,
                        tpFieldDeclaringType,
                        tpField,
                        tpFieldConverted
                    )
                }
                if TypeMemberModel.TryGetProperty(
                    tpClassConstraint,
                    syntax.FieldIdentifier.ValueText,
                    out var tpProp,
                    out var tpPropDeclaringType
                ) {
                    if !tpProp.HasSetter {
                        Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, syntax.FieldIdentifier.ValueText)
                        return BoundErrorExpression(nil)
                    }
                    let tpPropConverted = conversions.BindConversion(
                        syntax.Value.Location,
                        BindValue(tpProp.Type),
                        tpProp.Type
                    )
                    EnforceInitOnlyAssignment(tpProp, assignmentReceiver, syntax.EqualsToken.Location)
                    return BoundPropertyAssignmentExpression(
                        nil,
                        assignmentReceiver,
                        tpPropDeclaringType,
                        tpProp,
                        tpPropConverted
                    )
                }
            }
            if tpVarType.InterfaceConstraint is InterfaceSymbol tpIfaceConstraint &&
                !tpIfaceConstraint.IsGenericDefinition &&
                tpIfaceConstraint
                .TypeArguments
                .IsDefaultOrEmpty &&
                TypeMemberModel
                .TryGetProperty(tpIfaceConstraint, syntax.FieldIdentifier.ValueText, out var tpIfaceProp, out _) {
                if !tpIfaceProp!!.HasSetter {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, syntax.FieldIdentifier.ValueText)
                    return BoundErrorExpression(nil)
                }
                let tpIfaceConverted = conversions.BindConversion(
                    syntax.Value.Location,
                    BindValue(tpIfaceProp!!.Type),
                    tpIfaceProp!!.Type
                )
                EnforceInitOnlyAssignment(tpIfaceProp, assignmentReceiver, syntax.EqualsToken.Location)
                return BoundPropertyAssignmentExpression(nil, assignmentReceiver, nil, tpIfaceProp!!, tpIfaceConverted)
            }
            if tpVarType.ClrInterfaceConstraint is TypeSymbol clrInterfaceConstraint &&
                clrInterfaceConstraint.ClrType is Type clrInterface &&
                clrInterface
                .IsInterface {
                let clrProperty PropertyInfo? = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(
                    clrInterface,
                    syntax.FieldIdentifier.ValueText,
                    BindingFlags.Public | BindingFlags.Instance
                )
                if clrProperty != nil && clrProperty.GetIndexParameters().Length == 0 {
                    if clrProperty.GetSetMethod(nonPublic: false) == nil {
                        Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, syntax.FieldIdentifier.ValueText)
                        return BoundErrorExpression(nil)
                    }
                    let propertyType = MemberLookup.GetClrPropertyTypeSymbol(clrInterfaceConstraint, clrProperty)
                    let declaringInterface = MemberLookup.GetClrMemberDeclaringTypeSymbol(
                        clrInterfaceConstraint,
                        clrProperty
                    )
                    let constrainedConverted = conversions.BindConversion(
                        syntax.Value.Location,
                        BindValue(propertyType),
                        propertyType
                    )
                    return BoundClrPropertyAssignmentExpression(
                        nil,
                        assignmentReceiver,
                        clrProperty,
                        constrainedConverted,
                        propertyType,
                        staticContainerType: nil,
                        constrainedReceiverTypeParameter: tpVarType,
                        constrainedInterfaceType: declaringInterface
                    )
                }
            }
            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, syntax.FieldIdentifier.ValueText)
            return BoundErrorExpression(nil)
        }
        if !(assignmentReceiverType is StructSymbol structSymbol) {
            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, syntax.FieldIdentifier.ValueText)
            return BoundErrorExpression(nil)
        }
        let hasNearestProperty = TypeMemberModel.TryGetProperty(
            structSymbol,
            syntax.FieldIdentifier.ValueText,
            out var nearestProperty,
            out var nearestPropertyDeclaringType
        )
        let hasAssignmentField = TypeMemberModel.TryGetFieldIncludingInherited(
            structSymbol,
            syntax.FieldIdentifier.ValueText,
            MemberQuery.Instance(MemberKinds.Field),
            out var field,
            out var fieldDeclaringType
        )
        if !hasAssignmentField ||
            (
            hasNearestProperty &&
                !IsFieldAtLeastAsNearAsProperty(
                structSymbol,
                Invariant.Required(
                    fieldDeclaringType,
                    "a resolved field has a declaring type",
                    expression: "fieldDeclaringType"
                ),
                Invariant.Required(nearestProperty, "a resolved property has a symbol", expression: "nearestProperty"),
                Invariant.Required(
                    nearestPropertyDeclaringType,
                    "a resolved property has a declaring type",
                    expression: "nearestPropertyDeclaringType"
                )
            )
        ) {
            // ADR-0051: check if it's a property.
            if TypeMemberModel.TryGetProperty(
                structSymbol,
                syntax.FieldIdentifier.ValueText,
                out var prop,
                out var propDeclaringType
            ) {
                propDeclaringType = Invariant.Required(
                    propDeclaringType,
                    "a user-defined struct property has a declaring type",
                    expression: "propDeclaringType"
                )
                if !prop.HasSetter &&
                    !IsGetOnlyAutoPropertyConstructorWrite(prop, propDeclaringType, assignmentReceiver) {
                    // Issue #4224: a writable-ref-returning getter (no setter,
                    // but `ReturnRefKind == Ref`) stores through the getter
                    // instead of failing outright.
                    let refConverted = conversions.BindConversion(
                        syntax.Value.Location,
                        BindValue(prop.Type),
                        prop.Type
                    )
                    if TryBindRefGetterWriteThrough(
                        prop,
                        assignmentReceiver,
                        structSymbol,
                        propDeclaringType,
                        syntax.FieldIdentifier.Location,
                        syntax.EqualsToken.Location,
                        refConverted,
                        out var refWriteThrough
                    ) {
                        return refWriteThrough
                    }
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, syntax.FieldIdentifier.ValueText)
                    return BoundErrorExpression(nil)
                }
                // Issue #950 / #2044: enforce `protected`/`private` property
                // assignment.
                if !AccessibilityChecker.IsAccessible(prop.SetterAccessibility, propDeclaringType, this.function) {
                    Diagnostics.ReportMemberInaccessible(
                        syntax.FieldIdentifier.Location,
                        prop.Name,
                        propDeclaringType.Name,
                        prop.SetterAccessibility
                    )
                }
                // Issue #1132: writing a property of a read-only value-type
                // receiver mutates the value in the read-only slot — reject it
                // (a reference-type receiver mutates the heap object and the
                // enclosing `this` are both exempt via ReceiverVariableIsThis /
                // ReceiverTypeIsReference).
                if variable.IsReadOnly &&
                    !ReceiverVariableIsThis(variable) &&
                    !ReceiverTypeIsReference(assignmentReceiverType) {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, receiverName)
                }
                let propConverted = conversions.BindConversion(syntax.Value.Location, BindValue(prop.Type), prop.Type)
                EnforceInitOnlyAssignment(prop, assignmentReceiver, syntax.EqualsToken.Location)
                return BindPropertyAssignmentWithDeclaredReceiver(
                    assignmentReceiver,
                    syntax.FieldIdentifier.Location,
                    propDeclaringType,
                    prop,
                    propConverted
                )
            }
            // Issue #319 / #1582: a GSharp class inheriting an imported CLR base
            // exposes the base's settable instance properties/fields — including
            // inherited `protected` / `protected internal` members. Resolve the
            // inherited CLR base type by walking the user base chain so `e.HResult
            // = 42` and protected-field writes work the same as the read fallback.
            if GetInheritedClrBaseType(structSymbol) is Type inheritedBaseClr {
                let memberName = syntax.FieldIdentifier.ValueText
                var clrMember MemberInfo? = ClrTypeUtilities.SafeGetInheritedInstanceProperty(
                    inheritedBaseClr,
                    memberName,
                    CanAccessInternalsOf
                )
                clrMember ??= ClrTypeUtilities.SafeGetInheritedInstanceField(
                    inheritedBaseClr,
                    memberName,
                    CanAccessInternalsOf
                )
                if clrMember != nil {
                    // Issue #3815: project the inherited member through the
                    // derived receiver so an imported GENERIC base's member keeps
                    // the derived type's own type arguments (ChannelReader[T], not
                    // the erased ChannelReader[object]).
                    if !TryGetWritableClrMember(
                        clrMember,
                        structSymbol,
                        out var inhTargetType,
                        out var inhTargetSymbol,
                        out var inhWritable,
                        fromDerivedType: true
                    ) {
                        Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, memberName)
                        return BoundErrorExpression(nil)
                    }
                    assignmentReceiver,
                    clrMember = RecoverDeclaredClrMemberWriteReceiver(
                        assignmentReceiver,
                        syntax.FieldIdentifier.Location,
                        clrMember
                    )
                    let inhConverted = conversions.BindConversion(
                        syntax.Value.Location,
                        BindValue(inhTargetSymbol!!),
                        inhTargetSymbol
                    )
                    return BoundClrPropertyAssignmentExpression(
                        nil,
                        assignmentReceiver,
                        clrMember!!,
                        inhConverted,
                        inhTargetSymbol!!,
                        staticContainerType: nil
                    )
                }
            }
            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, syntax.FieldIdentifier.ValueText)
            return BoundErrorExpression(nil)
        }
        field = Invariant.Required(field, "a resolved assignment field has a symbol", expression: "field")
        fieldDeclaringType = Invariant.Required(
            fieldDeclaringType,
            "a resolved assignment field has a declaring type",
            expression: "fieldDeclaringType"
        )
        assignmentReceiver = RecoverDeclaredMemberWriteReceiver(
            assignmentReceiver,
            syntax.FieldIdentifier.Location,
            fieldDeclaringType
        )
        let receiverIsThisField = ReceiverVariableIsThis(variable)
        // Issue #950 / #2044: enforce `protected`/`private` field assignment
        // — only the declaring type (and, for `protected`, its derived
        // types) may write it.
        if !AccessibilityChecker.IsAccessible(field.Accessibility, fieldDeclaringType, this.function) {
            Diagnostics.ReportMemberInaccessible(
                syntax.FieldIdentifier.Location,
                field.Name,
                fieldDeclaringType.Name,
                field.Accessibility
            )
        }
        // Issue #947: a read-only field of `this` may be assigned inside the
        // declaring type's constructor; in that case the receiver being `this`
        // (which is itself read-only) must not block the field write.
        // Issue #1132: `let` communicates immutability of the *binding* only
        // (shallow / readonly-reference semantics). For a reference-type
        // receiver, `b.Field = v` mutates the heap object, not the binding, so
        // it must be allowed; only value-type receivers (where the field write
        // would mutate the value stored in the read-only slot) stay rejected.
        if variable.IsReadOnly && !receiverIsThisField && !ReceiverTypeIsReference(assignmentReceiverType) {
            Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, receiverName)
        }
        if field.IsReadOnly && !IsReadOnlyFieldAssignmentAllowed(field, fieldDeclaringType, receiverIsThisField) {
            Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, syntax.FieldIdentifier.ValueText)
        }
        // Issue #186 / #175: dotted field write fires GS0204 if the field
        // carries `@Obsolete`.
        reportObsoleteUseIfApplicable(syntax.FieldIdentifier.Location, field, "${structSymbol.Name}.${field.Name}")
        let converted = conversions.BindConversion(syntax.Value.Location, BindValue(field.Type), field.Type)
        let usesExpressionReceiver = implicitFieldReceiverExpr != nil ||
            (assignmentReceiver is BoundVariableExpression narrowedVariable && narrowedVariable.NarrowedType != nil) ||
            assignmentReceiver is BoundUnaryExpression
        if usesExpressionReceiver && !structSymbol.IsClass && !IsWritableStructFieldReceiver(assignmentReceiver) {
            Diagnostics.ReportFieldAssignmentThroughStructTemporary(
                syntax.EqualsToken.Location,
                field.Name,
                structSymbol
            )
            return BoundErrorExpression(syntax)
        }
        if usesExpressionReceiver {
            return BoundFieldAssignmentExpression.WithExpressionReceiver(
                nil,
                assignmentReceiver,
                fieldDeclaringType,
                field,
                converted
            )
        }
        return BoundFieldAssignmentExpression(nil, variable, fieldDeclaringType, field, converted)
    }

    /// Issue #1246: binds the underlying binary operation of a compound
    /// assignment (`lhs op= rhs` ⇒ `lhs op rhs`) so that the right
    /// operand participates in the SAME implicit numeric widening and constant-
    /// integer-literal adaptation that the binary operator `lhs op rhs`
    /// applies (via (cref:BindBinaryOperatorWithNumericAdaptation)).
    /// Issue #1554: when no built-in operator binds, falls back to the SAME
    /// user-defined (`operator` methods) and CLR (`op_*`) resolution
    /// that the equivalent binary expression uses, so that `x += y` binds
    /// whenever `x = x + y` does (e.g. `TimeSpan += TimeSpan`,
    /// `DateTime += TimeSpan`, or a user `operator +`). Returns the
    /// bound expression, or `null` when no operator binds even
    /// after adaptation and both fallbacks (the caller reports GS0129). The
    /// caller is responsible for converting the result back to the LHS type for
    /// the store, which preserves the C#-style guardrail that a compound
    /// assignment whose result does not implicitly convert back to the LHS type
    /// (e.g. `uint8 += int32`) is still rejected — exactly as
    /// `lhs = lhs op rhs` is.
    /// @param baseOperatorKind The base binary operator token kind.
    /// @param leftRead The bound read of the compound-assignment target.
    /// @param boundRhs The bound right-hand-side operand.
    /// @param rhsLocation The source location used for operand diagnostics.
    /// @returns The bound binary/user/CLR operator, or `null`.
    private func TryBindCompoundBinaryOperation(
        baseOperatorKind SyntaxKind,
        leftRead BoundExpression,
        boundRhs BoundExpression,
        rhsLocation TextLocation
    ) BoundExpression? {
        var left = leftRead
        var right = boundRhs
        // ADR-0122 §5 / issue #2175: a compound assignment `p op= i` where the
        // target is an unmanaged pointer (`*T`) is `p = p op i`, so reuse the
        // SAME pointer binary-operator lowering that `p + i` / `p - i` uses
        // (scaled native-int arithmetic), instead of failing to find a built-in
        // `+=`/`-=` operator (GS0129). This generalizes to every legal pointee
        // type, both `+=` and `-=`, and any integer RHS the binary path accepts;
        // a `*void` target is rejected exactly as the binary path rejects it.
        if left.Type is PointerTypeSymbol {
            let pointerResult BoundExpression? = TryBindPointerBinaryOperation(
                baseOperatorKind,
                rhsLocation,
                left,
                right
            )
            if pointerResult != nil {
                return pointerResult
            }
        }
        let op BoundBinaryOperator? = BindBinaryOperatorWithNumericAdaptation(
            baseOperatorKind,
            &left,
            &right,
            rhsLocation,
            rhsLocation
        )
        if op != nil {
            let binary = BoundBinaryExpression(nil, left, op, right, binderCtx.IsCheckedContext)
            let targetType = leftRead.Type
            let targetUnderlying = if targetType is NullableTypeSymbol nullableTarget {
                nullableTarget.UnderlyingType
            } else {
                targetType
            }
            // Issue #2616 / ECMA-334 §14.14.2: compound assignment includes
            // the explicit numeric conversion back to the LHS type. Keep this
            // narrowly on char so ADR-0044's existing small-integer compound
            // semantics are unchanged.
            return if targetUnderlying == TypeSymbol.Char && binary.Type != targetType {
                conversions.BindConversion(rhsLocation, binary, targetType, allowExplicit: true)
            } else {
                cast[BoundExpression](binary)
            }
        }
        // Issue #1554: fall back to user-defined / CLR operator resolution,
        // exactly as the equivalent binary expression `lhs op rhs` does.
        return TryBindBinaryWithUserAndClrFallback(baseOperatorKind, &left, &right, rhsLocation, rhsLocation, out _)
    }

    private func BindBareEventOrCompoundAssignment(
        bareName NameExpressionSyntax,
        syntax EventSubscriptionExpressionSyntax
    ) BoundExpression? {
        let name = bareName.IdentifierToken.ValueText
        let isAdd = syntax.OperatorToken.Kind == SyntaxKind.PlusEqualsToken
        let isEventOperator = isAdd || syntax.OperatorToken.Kind == SyntaxKind.MinusEqualsToken
        // Try implicit `this` event: walk the receiver type's events (including inherited).
        // ADR-0112 A5: the bound node carries the *declaring* class as its
        // owner, which is what the owner-returning TypeMemberModel.TryGetEvent
        // overload reports: that class as the receiver's hierarchy
        // instantiates it, so an event of a generic base (`GB[T]`, inherited
        // through `D : GB[string]`) takes an `EventHandler[string]` handler
        // (issue #4391) and a private base event is reported rather than
        // subscribed to (issue #4394).
        if isEventOperator &&
            function?.ThisParameter != nil &&
            function!!.ReceiverType is StructSymbol receiverStruct &&
            !SourceValueMemberPrecedesInheritedEvent(receiverStruct, name) &&
            TypeMemberModel
            .TryGetEvent(receiverStruct, name, out var ev, out var eventOwner) {
            if ReportInaccessibleSourceEvent(ev!!, eventOwner!!, bareName, syntax.Value) {
                return BoundErrorExpression(nil)
            }
            let receiver = BoundVariableExpression(nil, function!!.ThisParameter!!)
            let eventType = eventOwner!!.SubstituteMemberType(ev!!.Type) ?? ev!!.Type
            let handler = BindEventSubscriptionHandler(syntax.Value, eventType)
            return BoundEventSubscriptionExpression(nil, receiver, eventOwner!!, ev!!, handler, isAdd, eventType)
        }
        // Issue #3907 / #3911: the STATIC counterpart of the walk above — a
        // bare `Ticked += handler` inside the declaring type's own members,
        // where `Ticked` is declared in a `shared` block. This must be checked
        // BEFORE the compound-assignment fallback below, because Binder.cs now
        // also exposes a field-like static event's backing field as a bare
        // name (so the event can be READ and raised). Without this branch that
        // exposure would capture `+=` and turn a subscription into a delegate
        // compound assignment on the backing field, which is a different
        // operation: it bypasses the add/remove accessors and their
        // Interlocked.CompareExchange loop (issue #256), so a concurrent
        // subscribe could be lost.
        //
        // The handler goes through the same BindEventSubscriptionHandler the
        // instance and `Type.Event += handler` paths use, which is what keeps
        // issue #3775's nil-tolerance (`e += nil` is a silent no-op in C#, not
        // a conversion error) identical on the static path.
        let staticOwner = if $scope.TryLookupSymbol(name) is ImplicitStaticFieldVariableSymbol eventField &&
            eventField
            .Field
            .IsEventBackingField {
            eventField.StructType
        } else {
            function?.StaticOwnerType as StructSymbol ?? function?.ReceiverType as StructSymbol
        }
        if isEventOperator &&
            staticOwner != nil &&
            !SourceStaticValueMemberPrecedesInheritedEvent(staticOwner, name) &&
            TypeMemberModel
            .TryGetStaticEventIncludingInherited(staticOwner, name, out var staticEv, out var staticEventOwner) {
            if ReportInaccessibleSourceEvent(staticEv!!, staticEventOwner!!, bareName, syntax.Value) {
                return BoundErrorExpression(nil)
            }
            let staticEventType = staticEventOwner!!.SubstituteMemberType(staticEv!!.Type)
            let staticHandler = BindEventSubscriptionHandler(syntax.Value, staticEventType!!)
            return BoundEventSubscriptionExpression(
                nil,
                receiver: nil,
                staticEventOwner!!,
                staticEv!!,
                staticHandler,
                isAdd,
                staticEventType
            )
        }
        // Not an event: fall back to compound assignment semantics.
        // Reconstruct `name = name +/- rhs` as the parser used to do.
        let variable VariableSymbol? = BindVariableReference(
            name,
            bareName.IdentifierToken.Location,
            suppressNotAVariable: false,
            suppressUndefinedVariable: true
        )
        if variable == nil {
            // Issue #1584: a bare compound-write to an inherited CLR instance
            // property/field of a metadata base resolves to `this.member op=
            // value`, mirroring the qualified compound path and the bare-name
            // simple-write fallback.
            let effThis = GetEffectiveThisParameter()
            if effThis?.Type is StructSymbol thisStruct &&
                GetInheritedClrBaseType(thisStruct) is Type inheritedBaseClr {
                let inheritedReceiver = BoundVariableExpression(nil, effThis!!)
                SyntaxFacts.TryGetCompoundAssignmentBaseOperator(
                    syntax.OperatorToken.Kind,
                    out var inheritedBaseOperator
                )
                let inheritedCompound BoundExpression? = TryBindChainedClrCompoundAssignment(
                    inheritedReceiver,
                    inheritedBaseClr,
                    name,
                    bareName,
                    syntax,
                    inheritedBaseOperator,
                    includeInherited: true
                )
                if inheritedCompound != nil {
                    return inheritedCompound
                }
            }
            // Issue #3840: a bare compound write (`Count += 1`) inside a
            // DEFAULT INTERFACE METHOD body reads and stores the enclosing
            // interface's own property through the implicit `this`, reusing
            // the very same helper the `this.Count += 1` spelling uses.
            if TryResolveInterfaceInstancePropertyByBareName(name, out var ifaceReceiver, out var ifaceThis) {
                SyntaxFacts.TryGetCompoundAssignmentBaseOperator(syntax.OperatorToken.Kind, out var ifaceBaseOperator)
                let ifaceCompound BoundExpression? = TryBindInterfaceCompoundAssignment(
                    ifaceThis!!,
                    ifaceReceiver!!,
                    name,
                    bareName,
                    syntax,
                    ifaceBaseOperator
                )
                if ifaceCompound != nil {
                    return ifaceCompound
                }
            }
            // ADR-0156 Phase 2: a bare compound write (`counter += 1`) to a
            // top-level global declared by a prior interactive submission
            // reads and stores the static field on that submission's
            // <Program> container (newest submission first).
            if TryBindSubmissionStaticFieldCompound(name, bareName, syntax, out var submissionCompound) &&
                submissionCompound is {} resolvedSubmissionCompound {
                return resolvedSubmissionCompound
            }
            // Surface the diagnostic suppressed above (GS0125) only when the
            // name is genuinely unresolved; a non-variable symbol already
            // reported its own diagnostic.
            if $scope.TryLookupSymbol(name) == nil {
                Diagnostics.ReportUndefinedVariable(bareName.IdentifierToken.Location, name)
            }
            return BindExpression(syntax.Value)
        }
        let writableRefProperty = (
            variable is ImplicitPropertyVariableSymbol implicitProperty &&
                implicitProperty
                .Property
                .ReturnRefKind == RefKind.Ref &&
                !implicitProperty
                .Property
                .HasSetter
        ) ||
            (
            variable is ImplicitStaticPropertyVariableSymbol implicitStaticProperty &&
                implicitStaticProperty
                .Property
                .ReturnRefKind == RefKind.Ref &&
                !implicitStaticProperty
                .Property
                .HasSetter
        )
        if writableRefProperty {
            return BindRefGetterCompoundAssignment(syntax)
        }
        let boundRhs = BindExpression(syntax.Value)
        // Synthesize the binary expression: variable op rhs.
        let compoundTarget = BindNameExpressionCore(bareName)
        SyntaxFacts.TryGetCompoundAssignmentBaseOperator(syntax.OperatorToken.Kind, out var baseOpSyntaxKind)
        // Issue #2834 / ADR-0035: a user-defined compound-assignment operator
        // mutates the receiver in place, so it replaces the whole
        // `name = name op rhs` rewrite below rather than feeding it.
        let userCompound BoundExpression? = TryBindUserCompoundAssignmentOperator(
            syntax.OperatorToken.Kind,
            compoundTarget,
            boundRhs,
            syntax.Value.Location
        )
        if userCompound != nil {
            if syntax.IsIncrementDecrement &&
                (variable is ImplicitPropertyVariableSymbol or ImplicitStaticPropertyVariableSymbol) {
                return BindPropertyUserCompoundIncrement(syntax, compoundTarget, boundRhs)
            }
            var previousRead = compoundTarget
            let userPreviousValue = CapturePostfixCompoundValue(
                syntax.ReturnsPreviousValue,
                syntax,
                &previousRead,
                out var userPreviousDeclaration
            )
            return FinishUserCompoundIncrement(
                syntax,
                compoundTarget,
                userCompound,
                userPreviousDeclaration,
                userPreviousValue
            )
        }
        var leftExpr = compoundTarget
        let previousValue = CapturePostfixCompoundValue(
            syntax.ReturnsPreviousValue,
            syntax,
            &leftExpr,
            out var previousDeclaration
        )
        let leftType = leftExpr.Type
        let binaryResult BoundExpression? = TryBindCompoundBinaryOperation(
            baseOpSyntaxKind,
            leftExpr,
            boundRhs,
            syntax.Value.Location
        )
        if binaryResult == nil {
            Diagnostics.ReportUndefinedBinaryOperator(
                syntax.OperatorToken.Location,
                syntax.OperatorToken.Text,
                leftType,
                boundRhs.Type
            )
            return BoundErrorExpression(nil)
        }
        // Issue #3792: a preceding assignment may smart-cast a nullable
        // delegate read to its non-nullable underlying type. Compound
        // assignment still stores into the variable's declared slot type;
        // Delegate.Remove can produce nil, so converting through the narrowed
        // read type would incorrectly reject a valid `D? -= handler`.
        let storeType = if binaryResult is BoundBinaryExpression && binaryResult.Op.IsDelegateCombination == true {
            GetAssignmentTargetType(variable) ?? leftType
        } else {
            leftType
        }
        let convertedResult = conversions.BindConversion(syntax.Value.Location, binaryResult, storeType)
        // Route through the correct assignment path depending on variable kind.
        if variable is ImplicitFieldVariableSymbol implicitField {
            if implicitField
                .Field
                .IsReadOnly &&
                !IsReadOnlyFieldAssignmentAllowed(implicitField.Field, implicitField.StructType, receiverIsThis: true) {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name)
            }
            let fieldAssignment = BoundFieldAssignmentExpression(
                nil,
                implicitField.Receiver,
                implicitField.StructType,
                implicitField.Field,
                convertedResult
            )
            return FinishPostfixCompoundAssignment(syntax, previousDeclaration, previousValue, fieldAssignment)
        }
        if variable is ImplicitStaticFieldVariableSymbol implicitStaticField {
            if implicitStaticField.Field.IsReadOnly {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name)
            }
            if implicitStaticField.InterfaceType is InterfaceSymbol interfaceType {
                let interfaceFieldAssignment = BoundFieldAssignmentExpression(
                    nil,
                    implicitStaticField.Field,
                    interfaceType,
                    convertedResult
                )
                return FinishPostfixCompoundAssignment(
                    syntax,
                    previousDeclaration,
                    previousValue,
                    interfaceFieldAssignment
                )
            }
            if implicitStaticField.StructType is StructSymbol structType {
                let staticFieldAssignment = BoundFieldAssignmentExpression(
                    nil,
                    nil,
                    structType,
                    implicitStaticField.Field,
                    convertedResult
                )
                return FinishPostfixCompoundAssignment(
                    syntax,
                    previousDeclaration,
                    previousValue,
                    staticFieldAssignment
                )
            }
            throw InvalidOperationException("Static field symbol has no owning type.")
        }
        // ADR-0053: bare static property compound assignment inside a method
        // body (shared or instance) of the enclosing type. Compound `+=`/`-=`
        // requires both a getter (for the read half) and a setter (for the
        // write half).
        if variable is ImplicitStaticPropertyVariableSymbol implicitStaticProp {
            if !implicitStaticProp.Property.HasGetter || !implicitStaticProp.Property.HasSetter {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name)
                return BoundErrorExpression(nil)
            }
            let staticPropertyAssignment = BoundPropertyAssignmentExpression(
                nil,
                receiver: nil,
                implicitStaticProp.StructType,
                implicitStaticProp.Property,
                convertedResult
            )
            return FinishPostfixCompoundAssignment(syntax, previousDeclaration, previousValue, staticPropertyAssignment)
        }
        if variable is ImplicitPropertyVariableSymbol implicitProp {
            if !implicitProp
                .Property
                .HasSetter &&
                !IsGetOnlyAutoPropertyConstructorWrite(implicitProp.Property, implicitProp.StructType, receiver: nil) {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name)
            }
            EnforceInitOnlyAssignment(implicitProp.Property, receiver: nil, syntax.OperatorToken.Location)
            let propertyAssignment = BoundPropertyAssignmentExpression(
                nil,
                BoundVariableExpression(nil, implicitProp.Receiver),
                implicitProp.StructType,
                implicitProp.Property,
                convertedResult
            )
            return FinishPostfixCompoundAssignment(syntax, previousDeclaration, previousValue, propertyAssignment)
        }
        if variable is ParameterSymbol inParameter && inParameter.RefKind == RefKind.In {
            Diagnostics.ReportCannotAssignToInParameter(syntax.OperatorToken.Location, inParameter.Name)
        } else if variable.IsReadOnly {
            Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name)
        }
        let assignment = BoundAssignmentExpression(nil, variable, convertedResult)
        return FinishPostfixCompoundAssignment(syntax, previousDeclaration, previousValue, assignment)
    }

    /// ADR-0053 / issue #2154: bind `Type.StaticField op= rhs` or
    /// `Type.StaticProp op= rhs` where [`staticStruct`](paramref)
    /// is the user-defined receiver type. Returns `true` if the named
    /// member was a static field/property and the compound assignment was
    /// produced; `false` if no static field or property by that name
    /// exists on the type (caller falls through to error reporting).
    /// Mirrors the static branch of (cref:BindFieldAssignmentExpression)
    /// (lines ~6586–6619) but for any compound operator.
    private func TryBindUserTypeStaticCompoundAssignment(
        staticStruct StructSymbol,
        memberNameSyntax NameExpressionSyntax,
        syntax EventSubscriptionExpressionSyntax,
        baseOpSyntaxKind SyntaxKind,
        out result BoundExpression?
    ) bool {
        let memberName = memberNameSyntax.IdentifierToken.ValueText
        let boundRhs = BindExpression(syntax.Value)
        if TypeMemberModel.TryGetStaticFieldIncludingInherited(
            staticStruct,
            memberName,
            out var staticField,
            out var fieldOwner
        ) {
            if !AccessibilityChecker.IsAccessible(staticField.Accessibility, fieldOwner, function) {
                Diagnostics.ReportMemberInaccessible(
                    memberNameSyntax.Location,
                    staticField.Name,
                    fieldOwner.Name,
                    staticField.Accessibility
                )
            }
            let fieldType = fieldOwner.SubstituteMemberType(staticField.Type)
            let compoundTarget BoundExpression = BoundFieldAccessExpression(
                nil,
                receiver: nil,
                fieldOwner,
                staticField,
                fieldType,
                narrowedType: nil
            )
            var leftRead = compoundTarget
            let previousValue = CapturePostfixCompoundValue(
                syntax.ReturnsPreviousValue,
                syntax,
                &leftRead,
                out var previousDeclaration
            )
            // Issue #2834: a user-defined compound-assignment operator mutates
            // the target in place, replacing the read/binary/write rewrite.
            let userCompound BoundExpression? = TryBindUserCompoundAssignmentOperator(
                syntax.OperatorToken.Kind,
                compoundTarget,
                boundRhs,
                syntax.Value.Location
            )
            if userCompound != nil {
                result = FinishUserCompoundIncrement(
                    syntax,
                    compoundTarget,
                    userCompound,
                    previousDeclaration,
                    previousValue
                )
                return true
            }
            let binary BoundExpression? = TryBindCompoundBinaryOperation(
                baseOpSyntaxKind,
                leftRead,
                boundRhs,
                syntax.Value.Location
            )
            if binary == nil {
                Diagnostics.ReportUndefinedBinaryOperator(
                    syntax.OperatorToken.Location,
                    syntax.OperatorToken.Text,
                    staticField.Type,
                    boundRhs.Type
                )
                result = BoundErrorExpression(nil)
                return true
            }
            if staticField.IsReadOnly {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName)
            }
            let converted = conversions.BindConversion(syntax.Value.Location, binary, fieldType)
            let fieldAssignment = BoundFieldAssignmentExpression(
                nil,
                nil,
                fieldOwner,
                staticField,
                converted,
                fieldType
            )
            result = FinishPostfixCompoundAssignment(syntax, previousDeclaration, previousValue, fieldAssignment)
            return true
        }
        if TypeMemberModel.TryGetStaticPropertyIncludingInherited(
            staticStruct,
            memberName,
            out var prop,
            out var propertyOwner
        ) {
            if prop.ReturnRefKind == RefKind.Ref && !prop.HasSetter {
                if !AccessibilityChecker.IsAccessible(prop.GetterAccessibility, propertyOwner, function) {
                    Diagnostics.ReportMemberInaccessible(
                        memberNameSyntax.Location,
                        prop.Name,
                        propertyOwner.Name,
                        prop.GetterAccessibility
                    )
                }
                result = BindRefGetterCompoundAssignment(syntax)
                return true
            }
            if !AccessibilityChecker.IsAccessible(prop.SetterAccessibility, propertyOwner, function) {
                Diagnostics.ReportMemberInaccessible(
                    memberNameSyntax.Location,
                    prop.Name,
                    propertyOwner.Name,
                    prop.SetterAccessibility
                )
            }
            // A compound assignment also reads the property, so its getter
            // must be reachable as well as its setter.
            if prop.HasGetter && !AccessibilityChecker.IsAccessible(prop.GetterAccessibility, propertyOwner, function) {
                Diagnostics.ReportMemberInaccessible(
                    memberNameSyntax.Location,
                    prop.Name,
                    propertyOwner.Name,
                    prop.GetterAccessibility
                )
            }
            if !prop.HasGetter || !prop.HasSetter {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName)
                result = BoundErrorExpression(nil)
                return true
            }
            let compoundTarget BoundExpression = BoundPropertyAccessExpression(nil, receiver: nil, propertyOwner, prop)
            // Issue #2834: a user-defined compound-assignment operator mutates
            // the target in place, replacing the read/binary/write rewrite.
            let userCompound BoundExpression? = TryBindUserCompoundAssignmentOperator(
                syntax.OperatorToken.Kind,
                compoundTarget,
                boundRhs,
                syntax.Value.Location
            )
            if userCompound != nil {
                result = if syntax.IsIncrementDecrement {
                    BindPropertyUserCompoundIncrement(syntax, compoundTarget, boundRhs)
                } else {
                    userCompound
                }
                return true
            }
            var leftRead = compoundTarget
            let previousValue = CapturePostfixCompoundValue(
                syntax.ReturnsPreviousValue,
                syntax,
                &leftRead,
                out var previousDeclaration
            )
            let binary BoundExpression? = TryBindCompoundBinaryOperation(
                baseOpSyntaxKind,
                leftRead,
                boundRhs,
                syntax.Value.Location
            )
            if binary == nil {
                Diagnostics.ReportUndefinedBinaryOperator(
                    syntax.OperatorToken.Location,
                    syntax.OperatorToken.Text,
                    prop.Type,
                    boundRhs.Type
                )
                result = BoundErrorExpression(nil)
                return true
            }
            let converted = conversions.BindConversion(syntax.Value.Location, binary, prop.Type)
            let propertyAssignment = BoundPropertyAssignmentExpression(
                nil,
                receiver: nil,
                propertyOwner,
                prop,
                converted
            )
            result = FinishPostfixCompoundAssignment(syntax, previousDeclaration, previousValue, propertyAssignment)
            return true
        }
        result = nil
        return false
    }

    /// ADR-0089 / issue #1030 (generalized by issue #2154): binds
    /// `IName.StaticField op= rhs` for an interface static field.
    /// [`interfaceSym`](paramref) may be the open definition (non-generic,
    /// or self-instantiation) or a constructed generic interface
    /// (`IBox[int32]`); the field is resolved on the definition and the
    /// carried interface symbol drives per-construction emit/storage. Returns
    /// `true` when the named member was an interface static field;
    /// `false` otherwise (caller reports "unable to find member").
    /// @param interfaceSym The interface receiver (definition or constructed).
    /// @param memberNameSyntax The member-name syntax.
    /// @param syntax The originating compound-assignment syntax.
    /// @param baseOpSyntaxKind The base binary operator token kind (e.g. `+` for `+=`).
    /// @param result The bound compound assignment on success.
    /// @returns Whether the member resolved to an interface static field.
    private func TryBindInterfaceStaticCompoundAssignment(
        interfaceSym InterfaceSymbol,
        memberNameSyntax NameExpressionSyntax,
        syntax EventSubscriptionExpressionSyntax,
        baseOpSyntaxKind SyntaxKind,
        out result BoundExpression?
    ) bool {
        let memberName = memberNameSyntax.IdentifierToken.ValueText
        let fieldOwner = interfaceSym.Definition ?? interfaceSym
        let staticField FieldSymbol? = fieldOwner.GetStaticField(memberName)
        if staticField == nil {
            result = nil
            return false
        }
        let fieldType = interfaceSym.SubstituteMemberType(staticField.Type)
        let boundRhs = BindExpression(syntax.Value)
        var leftRead BoundExpression = BoundFieldAccessExpression(nil, staticField, interfaceSym, fieldType)
        let previousValue = CapturePostfixCompoundValue(
            syntax.ReturnsPreviousValue,
            syntax,
            &leftRead,
            out var previousDeclaration
        )
        let binary BoundExpression? = TryBindCompoundBinaryOperation(
            baseOpSyntaxKind,
            leftRead,
            boundRhs,
            syntax.Value.Location
        )
        if binary == nil {
            Diagnostics.ReportUndefinedBinaryOperator(
                syntax.OperatorToken.Location,
                syntax.OperatorToken.Text,
                fieldType,
                boundRhs.Type
            )
            result = BoundErrorExpression(nil)
            return true
        }
        if staticField.IsReadOnly || staticField.IsConst {
            Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName)
        }
        let converted = conversions.BindConversion(syntax.Value.Location, binary, fieldType)
        let fieldAssignment = BoundFieldAssignmentExpression(nil, staticField, interfaceSym, converted, fieldType)
        result = FinishPostfixCompoundAssignment(syntax, previousDeclaration, previousValue, fieldAssignment)
        return true
    }

    private func TryBindInterfaceCompoundAssignment(
        interfaceType InterfaceSymbol,
        receiver BoundExpression,
        memberName string,
        memberNameSyntax NameExpressionSyntax,
        syntax EventSubscriptionExpressionSyntax,
        baseOpSyntaxKind SyntaxKind
    ) BoundExpression? {
        if !TypeMemberModel.TryGetPropertyWithOwner(
            interfaceType,
            memberName,
            out var property,
            out var propertyOwner
        ) {
            return nil
        }
        let effectiveInterface = Invariant.Required(
            propertyOwner as InterfaceSymbol,
            "an interface property has an effective interface owner",
            expression: "propertyOwner as InterfaceSymbol"
        )
        if property.ReturnRefKind == RefKind.Ref && !property.HasSetter {
            if !AccessibilityChecker.IsAccessible(property.GetterAccessibility, effectiveInterface, this.function) {
                Diagnostics.ReportMemberInaccessible(
                    memberNameSyntax.IdentifierToken.Location,
                    property.Name,
                    effectiveInterface.Name,
                    property.GetterAccessibility
                )
            }
            return BindRefGetterCompoundAssignment(syntax)
        }
        if !property.HasGetter || !property.HasSetter {
            Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName)
            return BoundErrorExpression(nil)
        }
        if !AccessibilityChecker.IsAccessible(property.GetterAccessibility, effectiveInterface, this.function) ||
            !AccessibilityChecker
            .IsAccessible(property.SetterAccessibility, effectiveInterface, this.function) {
            Diagnostics.ReportMemberInaccessible(
                memberNameSyntax.IdentifierToken.Location,
                property.Name,
                effectiveInterface.Name,
                property.SetterAccessibility
            )
        }
        let propertyType = effectiveInterface.SubstituteMemberType(property.Type)
        let substitutedType = if object.ReferenceEquals(propertyType, property.Type) {
            default(TypeSymbol?)
        } else {
            propertyType
        }
        let boundRhs = BindExpression(syntax.Value)
        let compoundTarget BoundExpression = BoundPropertyAccessExpression(
            nil,
            receiver,
            nil,
            property,
            substitutedType,
            narrowedType: nil,
            interfaceType: effectiveInterface
        )
        let userCompound BoundExpression? = TryBindUserCompoundAssignmentOperator(
            syntax.OperatorToken.Kind,
            compoundTarget,
            boundRhs,
            syntax.Value.Location
        )
        if userCompound != nil {
            return if syntax.IsIncrementDecrement {
                BindPropertyUserCompoundIncrement(syntax, compoundTarget, boundRhs)
            } else {
                userCompound
            }
        }
        var leftRead = compoundTarget
        let previousValue = CapturePostfixCompoundValue(
            syntax.ReturnsPreviousValue,
            syntax,
            &leftRead,
            out var previousDeclaration
        )
        let binary BoundExpression? = TryBindCompoundBinaryOperation(
            baseOpSyntaxKind,
            leftRead,
            boundRhs,
            syntax.Value.Location
        )
        if binary == nil {
            Diagnostics.ReportUndefinedBinaryOperator(
                syntax.OperatorToken.Location,
                syntax.OperatorToken.Text,
                propertyType,
                boundRhs.Type
            )
            return BoundErrorExpression(nil)
        }
        let converted = conversions.BindConversion(syntax.Value.Location, binary, propertyType)
        EnforceInitOnlyAssignment(property, receiver, syntax.OperatorToken.Location)
        let propertyAssignment = BoundPropertyAssignmentExpression(
            nil,
            receiver,
            nil,
            property,
            converted,
            substitutedType,
            effectiveInterface
        )
        return FinishPostfixCompoundAssignment(syntax, previousDeclaration, previousValue, propertyAssignment)
    }

    /// Issue #3840: tries to bind a bare (unqualified) simple write
    /// `Member = value` inside a DEFAULT INTERFACE METHOD body to an
    /// instance property of the enclosing interface, producing exactly the
    /// (cref:BoundPropertyAssignmentExpression) the `this.Member =
    /// value` qualified path produces. A resolved-but-unsettable property
    /// reports "cannot assign" rather than GS0125, matching that path.
    /// @param name The bare identifier text.
    /// @param nameLocation The identifier location, for diagnostics.
    /// @param valueSyntax The RHS value syntax.
    /// @param assignLocation The location of the assignment operator, for diagnostics.
    /// @returns The bound assignment (or an error expression), or `null` when the name is not an interface
    /// property.
    private func TryBindInterfaceInstancePropertyWriteByBareName(
        name string,
        nameLocation TextLocation,
        valueSyntax ExpressionSyntax,
        assignLocation TextLocation
    ) BoundExpression? {
        if !TryResolveInterfaceInstancePropertyByBareName(name, out var receiver, out var thisInterface) ||
            !TypeMemberModel.TryGetPropertyWithOwner(thisInterface!!, name, out var property, out var propertyOwner) {
            return nil
        }
        if !property!!.HasSetter {
            Diagnostics.ReportCannotAssign(assignLocation, name)
            let _ = BindExpression(valueSyntax)
            return BoundErrorExpression(nil)
        }
        let effectiveInterface = Invariant.Required(
            propertyOwner as InterfaceSymbol,
            "an interface property has an effective interface owner",
            expression: "propertyOwner as InterfaceSymbol"
        )
        if !AccessibilityChecker.IsAccessible(property!!.SetterAccessibility, effectiveInterface, this.function) {
            Diagnostics.ReportMemberInaccessible(
                nameLocation,
                property!!.Name,
                effectiveInterface.Name,
                property!!.SetterAccessibility
            )
        }
        let propertyType = effectiveInterface.SubstituteMemberType(property!!.Type)
        let value = BindAssignmentRhs(valueSyntax, propertyType)
        let converted = conversions.BindConversion(valueSyntax.Location, value, propertyType)
        EnforceInitOnlyAssignment(property, receiver, assignLocation)
        return BoundPropertyAssignmentExpression(
            nil,
            receiver,
            nil,
            property!!,
            converted,
            if object.ReferenceEquals(propertyType, property!!.Type) {
                default(TypeSymbol?)
            } else {
                propertyType
            },
            effectiveInterface
        )
    }

    /// Issue #648 (generalized by issue #2154): compound assignment fallback
    /// for chained member access on user-defined struct/class types (e.g.
    /// `a.B.C += 1`, `a.B.C *= 2`). Synthesizes
    /// `receiver.field = receiver.field op rhs`.
    private func TryBindChainedCompoundAssignment(
        structSym StructSymbol,
        boundReceiver BoundExpression,
        memberName string,
        memberNameSyntax NameExpressionSyntax,
        syntax EventSubscriptionExpressionSyntax,
        baseOpSyntaxKind SyntaxKind
    ) BoundExpression? {
        if TrySaveNativeElementReceiver(boundReceiver, out var savedReceiver, out var prefix) {
            let assignment BoundExpression? = TryBindChainedCompoundAssignment(
                structSym,
                savedReceiver,
                memberName,
                memberNameSyntax,
                syntax,
                baseOpSyntaxKind
            )
            return if assignment == nil {
                default(BoundBlockExpression?)
            } else {
                BoundBlockExpression(syntax, prefix, assignment)
            }
        }
        if TrySavePostfixReceiver(syntax, boundReceiver, out savedReceiver, out prefix) {
            let assignment BoundExpression? = TryBindChainedCompoundAssignment(
                structSym,
                savedReceiver,
                memberName,
                memberNameSyntax,
                syntax,
                baseOpSyntaxKind
            )
            return if assignment == nil {
                default(BoundBlockExpression?)
            } else {
                BoundBlockExpression(syntax, prefix, assignment)
            }
        }
        // ADR-0112 A3: this-first base-chain instance field walk, using the
        // declaring struct as the owner for both the read access and assignment.
        let hasCompoundProperty = TypeMemberModel.TryGetProperty(
            structSym,
            memberName,
            out var compoundProperty,
            out var compoundPropertyDeclaringType
        )
        if TypeMemberModel.TryGetFieldIncludingInherited(
            structSym,
            memberName,
            MemberQuery.Instance(MemberKinds.Field),
            out var field,
            out var declaringType
        ) &&
            (
            !hasCompoundProperty ||
                IsFieldAtLeastAsNearAsProperty(
                structSym,
                declaringType!!,
                Invariant.Required(
                    compoundProperty,
                    "a resolved property has a symbol",
                    expression: "compoundProperty"
                ),
                Invariant.Required(
                    compoundPropertyDeclaringType,
                    "a resolved property has a declaring type",
                    expression: "compoundPropertyDeclaringType"
                )
            )
        ) {
            let boundRhs = BindExpression(syntax.Value)
            if field!!.IsReadOnly &&
                !IsReadOnlyFieldAssignmentAllowed(field, declaringType, ReceiverExpressionIsThis(boundReceiver)) {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName)
            }
            // Issue #950 / #2044: enforce `protected`/`private` field
            // compound-assignment (`+=`/`-=`) — mirrors the plain-`=` check
            // in BindFieldAssignmentExpression / BindMemberFieldAssignmentExpression.
            if !AccessibilityChecker.IsAccessible(field!!.Accessibility, declaringType, this.function) {
                Diagnostics.ReportMemberInaccessible(
                    memberNameSyntax.IdentifierToken.Location,
                    field!!.Name,
                    declaringType!!.Name,
                    field!!.Accessibility
                )
            }
            // Issue #1132: compound-mutating a field of a read-only value-type
            // receiver mutates the value in the read-only slot — reject it.
            // Reference-type receivers and `this` are exempt.
            if ReceiverBlocksValueTypeMemberWrite(boundReceiver) {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName)
            }
            if !structSym.IsClass && !IsWritableStructFieldReceiver(boundReceiver) {
                Diagnostics.ReportFieldAssignmentThroughStructTemporary(
                    syntax.OperatorToken.Location,
                    field!!.Name,
                    structSym
                )
                return BoundErrorExpression(syntax)
            }
            let compoundTarget BoundExpression = BoundFieldAccessExpression(nil, boundReceiver, declaringType, field!!)
            var leftRead = compoundTarget
            let previousValue = CapturePostfixCompoundValue(
                syntax.ReturnsPreviousValue,
                syntax,
                &leftRead,
                out var previousDeclaration
            )
            // Issue #2834: a user-defined compound-assignment operator mutates
            // the target in place, replacing the read/binary/write rewrite.
            let userCompound BoundExpression? = TryBindUserCompoundAssignmentOperator(
                syntax.OperatorToken.Kind,
                compoundTarget,
                boundRhs,
                syntax.Value.Location
            )
            if userCompound != nil {
                return FinishUserCompoundIncrement(
                    syntax,
                    compoundTarget,
                    userCompound,
                    previousDeclaration,
                    previousValue
                )
            }
            let binary BoundExpression? = TryBindCompoundBinaryOperation(
                baseOpSyntaxKind,
                leftRead,
                boundRhs,
                syntax.Value.Location
            )
            if binary == nil {
                Diagnostics.ReportUndefinedBinaryOperator(
                    syntax.OperatorToken.Location,
                    syntax.OperatorToken.Text,
                    field!!.Type,
                    boundRhs.Type
                )
                return BoundErrorExpression(nil)
            }
            let converted = conversions.BindConversion(syntax.Value.Location, binary, field!!.Type)
            let assignment = BoundFieldAssignmentExpression.WithExpressionReceiver(
                nil,
                boundReceiver,
                declaringType!!,
                field!!,
                converted
            )
            return FinishPostfixCompoundAssignment(syntax, previousDeclaration, previousValue, assignment)
        }
        // ADR-0051: check properties.
        if TypeMemberModel.TryGetProperty(structSym, memberName, out var prop, out var propDeclaringType) {
            propDeclaringType = Invariant.Required(
                propDeclaringType,
                "a user-defined struct property has a declaring type",
                expression: "propDeclaringType"
            )
            if prop.ReturnRefKind == RefKind.Ref && !prop.HasSetter {
                if !structSym.IsClass && !IsWritableStructFieldReceiver(boundReceiver) {
                    Diagnostics.ReportFieldAssignmentThroughStructTemporary(
                        syntax.OperatorToken.Location,
                        prop.Name,
                        structSym
                    )
                    return BoundErrorExpression(syntax)
                }
                if !AccessibilityChecker.IsAccessible(prop.GetterAccessibility, propDeclaringType, this.function) {
                    Diagnostics.ReportMemberInaccessible(
                        memberNameSyntax.IdentifierToken.Location,
                        prop.Name,
                        propDeclaringType.Name,
                        prop.GetterAccessibility
                    )
                }
                return BindRefGetterCompoundAssignment(syntax)
            }
            let boundRhs = BindExpression(syntax.Value)
            let compoundTarget BoundExpression = BoundPropertyAccessExpression(nil, boundReceiver, structSym, prop)
            // Issue #2834: a user-defined compound-assignment operator mutates
            // the property's *value* in place, so it needs only a getter — no
            // setter, no accessibility-of-setter check, and no write-back. This
            // is resolved before the read/binary/write checks below.
            if prop.HasGetter {
                let userPropCompound BoundExpression? = TryBindUserCompoundAssignmentOperator(
                    syntax.OperatorToken.Kind,
                    compoundTarget,
                    boundRhs,
                    syntax.Value.Location
                )
                if userPropCompound != nil {
                    return if syntax.IsIncrementDecrement {
                        BindPropertyUserCompoundIncrement(syntax, compoundTarget, boundRhs)
                    } else {
                        userPropCompound
                    }
                }
            }
            if !prop.HasGetter ||
                (!prop.HasSetter && !IsGetOnlyAutoPropertyConstructorWrite(prop, propDeclaringType, boundReceiver)) {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName)
                return BoundErrorExpression(nil)
            }
            // Issue #950 / #2044: enforce `protected`/`private` property
            // compound-assignment.
            if !AccessibilityChecker.IsAccessible(prop.SetterAccessibility, propDeclaringType, this.function) {
                Diagnostics.ReportMemberInaccessible(
                    memberNameSyntax.IdentifierToken.Location,
                    prop.Name,
                    propDeclaringType.Name,
                    prop.SetterAccessibility
                )
            }
            // Issue #1132: compound-mutating a property of a read-only value-type
            // receiver mutates the value in the read-only slot — reject it.
            if ReceiverBlocksValueTypeMemberWrite(boundReceiver) {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName)
            }
            var leftRead = compoundTarget
            let previousValue = CapturePostfixCompoundValue(
                syntax.ReturnsPreviousValue,
                syntax,
                &leftRead,
                out var previousDeclaration
            )
            let binary BoundExpression? = TryBindCompoundBinaryOperation(
                baseOpSyntaxKind,
                leftRead,
                boundRhs,
                syntax.Value.Location
            )
            if binary == nil {
                Diagnostics.ReportUndefinedBinaryOperator(
                    syntax.OperatorToken.Location,
                    syntax.OperatorToken.Text,
                    prop.Type,
                    boundRhs.Type
                )
                return BoundErrorExpression(nil)
            }
            let converted = conversions.BindConversion(syntax.Value.Location, binary, prop.Type)
            EnforceInitOnlyAssignment(prop, boundReceiver, syntax.OperatorToken.Location)
            let propertyAssignment = BoundPropertyAssignmentExpression(nil, boundReceiver, structSym, prop, converted)
            return FinishPostfixCompoundAssignment(syntax, previousDeclaration, previousValue, propertyAssignment)
        }
        // Inherited CLR base member fallback (issue #1582: resolve through the
        // user base chain and include inherited protected members).
        if GetInheritedClrBaseType(structSym) is Type inheritedBaseClr {
            return TryBindChainedClrCompoundAssignment(
                boundReceiver,
                inheritedBaseClr,
                memberName,
                memberNameSyntax,
                syntax,
                baseOpSyntaxKind,
                includeInherited: true
            )
        }
        return nil
    }

    private func BindRefGetterCompoundAssignment(
        syntax EventSubscriptionExpressionSyntax
    ) BoundExpression -> BindIndirectCompoundAssignmentExpression(
        IndirectCompoundAssignmentExpressionSyntax(
            syntax.SyntaxTree,
            syntax.LeftHandSide,
            syntax.OperatorToken,
            syntax.Value,
            syntax.ReturnsPreviousValue,
            syntax.IsIncrementDecrement
        )
    )

    /// Issue #648 (generalized by issue #2154): compound assignment fallback
    /// for chained CLR member access (e.g. `obj.Prop += 1`, `obj.Prop *=
    /// 2` where Prop is a property/field on a CLR type).
    private func TryBindChainedClrCompoundAssignment(
        boundReceiver BoundExpression,
        clrReceiverType Type,
        memberName string,
        memberNameSyntax NameExpressionSyntax,
        syntax EventSubscriptionExpressionSyntax,
        baseOpSyntaxKind SyntaxKind,
        includeInherited bool = false
    ) BoundExpression? {
        if TrySaveNativeElementReceiver(boundReceiver, out var savedReceiver, out var prefix) {
            let savedAssignment BoundExpression? = TryBindChainedClrCompoundAssignment(
                savedReceiver,
                clrReceiverType,
                memberName,
                memberNameSyntax,
                syntax,
                baseOpSyntaxKind,
                includeInherited
            )
            return if savedAssignment == nil {
                default(BoundBlockExpression?)
            } else {
                BoundBlockExpression(syntax, prefix, savedAssignment)
            }
        }
        if TrySavePostfixReceiver(syntax, boundReceiver, out savedReceiver, out prefix) {
            let savedAssignment BoundExpression? = TryBindChainedClrCompoundAssignment(
                savedReceiver,
                clrReceiverType,
                memberName,
                memberNameSyntax,
                syntax,
                baseOpSyntaxKind,
                includeInherited
            )
            return if savedAssignment == nil {
                default(BoundBlockExpression?)
            } else {
                BoundBlockExpression(syntax, prefix, savedAssignment)
            }
        }
        var instanceMember MemberInfo?
        if includeInherited {
            // Issue #1582: the receiver is a derived G# type reaching into its
            // metadata base — surface inherited protected/public members.
            instanceMember = ClrTypeUtilities.SafeGetInheritedInstanceProperty(
                clrReceiverType,
                memberName,
                CanAccessInternalsOf
            )
            instanceMember ??= ClrTypeUtilities.SafeGetInheritedInstanceField(
                clrReceiverType,
                memberName,
                CanAccessInternalsOf
            )
        } else {
            instanceMember = SafeGetVisibleInstanceProperty(clrReceiverType, memberName)
            if instanceMember is PropertyInfo propInfo && propInfo.GetIndexParameters().Length != 0 {
                instanceMember = nil
            }
            instanceMember ??= SafeGetVisibleInstanceField(clrReceiverType, memberName)
        }
        if instanceMember == nil {
            return nil
        }
        if !TryGetWritableClrMember(instanceMember, boundReceiver.Type, out _, out var targetSymbol, out _) ||
            RefCapabilities
            .IsReadOnlyValueReference(boundReceiver) {
            Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName)
            return BoundErrorExpression(nil)
        }
        // ADR-0156 Phase 2 (issue #3185): a compound write through a
        // prior-cell submission global (`p.X += v`, `a.B.C *= v`) enforces
        // the read-only root and addressable-chain rules; non-submission
        // receivers are untouched.
        if ReportSubmissionGlobalMemberWriteBlocked(boundReceiver, memberName, syntax.OperatorToken.Location) {
            return BoundErrorExpression(syntax)
        }
        let boundRhs = BindExpression(syntax.Value)
        var leftRead BoundExpression = BoundClrPropertyAccessExpression(
            nil,
            boundReceiver,
            instanceMember,
            targetSymbol!!
        )
        let previousValue = CapturePostfixCompoundValue(
            syntax.ReturnsPreviousValue,
            syntax,
            &leftRead,
            out var previousDeclaration
        )
        let binary BoundExpression? = TryBindCompoundBinaryOperation(
            baseOpSyntaxKind,
            leftRead,
            boundRhs,
            syntax.Value.Location
        )
        if binary == nil {
            Diagnostics.ReportUndefinedBinaryOperator(
                syntax.OperatorToken.Location,
                syntax.OperatorToken.Text,
                targetSymbol!!,
                boundRhs.Type
            )
            return BoundErrorExpression(nil)
        }
        let converted = conversions.BindConversion(syntax.Value.Location, binary, targetSymbol)
        let assignment = BoundClrPropertyAssignmentExpression(
            nil,
            boundReceiver,
            instanceMember,
            converted,
            targetSymbol!!,
            staticContainerType: nil
        )
        return FinishPostfixCompoundAssignment(syntax, previousDeclaration, previousValue, assignment)
    }

    /// Binds a compound write through an imported static CLR type receiver.
    /// @remarks Issue #4056: [`symbolicContainerType`](paramref) is the constructed
    /// generic view of a receiver whose closed CLR shape is type-ERASED —
    /// `Handler[MyOptions]` over a same-compilation `MyOptions` closes
    /// over the `object` surrogate, because the user type has no
    /// `ClrType` while binding. Both the read path
    /// (`ExpressionBinder.Access.MemberLookup.cs`) and the simple-write
    /// path (`BindMemberFieldAssignmentExpression`) already thread that
    /// symbol onto the bound node so the emitter parents the member reference at
    /// the real `Handler<MyOptions>` TypeSpec. This path dropped it,
    /// and BOTH the compound read (`ldsfld`) and the compound write
    /// (`stsfld`) named `Handler<object>` — IL that ILVerify
    /// rejects with `UnsatisfiedFieldParentInst` and that the CLR refuses to
    /// load. `null` for an ordinary (non-generic, or fully
    /// concrete) imported static receiver, which is every other caller.
    private func TryBindStaticClrCompoundAssignment(
        clrReceiverType Type,
        memberName string,
        memberNameSyntax NameExpressionSyntax,
        syntax EventSubscriptionExpressionSyntax,
        baseOpSyntaxKind SyntaxKind,
        symbolicContainerType ImportedTypeSymbol? = nil
    ) BoundExpression? {
        let importedClass = WithFamilyAccess(
            ImportedClassSymbol(clrReceiverType, memberNameSyntax, symbolicContainerType, $scope.References)
        )
        if !importedClass.TryLookupMember(memberName, ne: nil, out var staticMember) {
            return nil
        }
        if !TryGetWritableClrMember(
            staticMember,
            out _,
            out var targetSymbol,
            out _,
            fromDerivedType: importedClass.IsFamilyAccessible(staticMember!!.DeclaringType)
        ) {
            Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName)
            return BoundErrorExpression(nil)
        }
        // A compound assignment also reads the property: its getter must be
        // callable as well as its setter.
        if staticMember is PropertyInfo compoundProperty &&
            !TryRequireVisibleStaticGetter(importedClass, compoundProperty, memberNameSyntax.IdentifierToken.Location) {
            return BoundErrorExpression(nil)
        }
        let boundRhs = BindExpression(syntax.Value)
        // Issue #4056: the compound READ is a `ldsfld` / `call get_X` of its own,
        // so it needs the symbolic container just as much as the write below. A
        // write-only repair still emits an erased TypeSpec for the read half.
        var leftRead BoundExpression = BoundClrPropertyAccessExpression(
            nil,
            receiver: nil,
            staticMember!!,
            targetSymbol!!,
            staticContainerType: symbolicContainerType
        )
        let previousValue = CapturePostfixCompoundValue(
            syntax.ReturnsPreviousValue,
            syntax,
            &leftRead,
            out var previousDeclaration
        )
        let binary BoundExpression? = TryBindCompoundBinaryOperation(
            baseOpSyntaxKind,
            leftRead,
            boundRhs,
            syntax.Value.Location
        )
        if binary == nil {
            Diagnostics.ReportUndefinedBinaryOperator(
                syntax.OperatorToken.Location,
                syntax.OperatorToken.Text,
                targetSymbol!!,
                boundRhs.Type
            )
            return BoundErrorExpression(nil)
        }
        let converted = conversions.BindConversion(syntax.Value.Location, binary, targetSymbol)
        let assignment = BoundClrPropertyAssignmentExpression(
            nil,
            receiver: nil,
            staticMember!!,
            converted,
            targetSymbol!!,
            staticContainerType: symbolicContainerType
        )
        return FinishPostfixCompoundAssignment(syntax, previousDeclaration, previousValue, assignment)
    }

    /// Binds a compound assignment or increment/decrement whose target is a
    /// base-qualified member: `base.M op= rhs`, `base.M++`,
    /// `--base.M`, and so on. The member is read with
    /// (cref:BindBaseClassPropertyRead) and written with
    /// (cref:BindBaseClassPropertyWrite), so every member shape either
    /// path accepts (a same-compilation field or property, an imported
    /// property, an imported field such as `RegexRunner.runtextpos`)
    /// takes part, and a property is read and written through its base
    /// accessors non-virtually, as C# does.
    /// @remarks The receiver is always the enclosing member's `this`, which has no
    /// side effects, so reading the member and then writing it evaluates the
    /// receiver twice without observable difference. The written value is
    /// held in a local so the expression's own value (the old value for a
    /// postfix form, the new value otherwise) never depends on the write
    /// node's type: a base property setter call is `void`.
    /// @param baseName The `base` receiver name.
    /// @param memberNameSyntax The member name.
    /// @param syntax The compound-assignment syntax.
    /// @param baseOpSyntaxKind The binary operator the compound operator applies.
    /// @returns The bound compound assignment, or an error expression.
    private func BindBaseMemberCompoundAssignment(
        baseName NameExpressionSyntax,
        memberNameSyntax NameExpressionSyntax,
        syntax EventSubscriptionExpressionSyntax,
        baseOpSyntaxKind SyntaxKind
    ) BoundExpression {
        let baseLocation = baseName.Location
        var leftRead = BindBaseClassPropertyRead(
            memberNameSyntax,
            baseLocation,
            explicitBaseType: nil,
            selectorLocation: baseLocation
        )
        let boundRhs = BindExpression(syntax.Value)
        if leftRead is BoundErrorExpression || boundRhs.Type == TypeSymbol.Error {
            return BoundErrorExpression(nil)
        }
        let targetType = leftRead.Type
        // Issue #2834: a user-defined compound-assignment operator on the
        // member's type runs in place, ahead of the `lhs op rhs` rewrite,
        // exactly as for an ordinary member target.
        if TryBindBaseMemberUserCompoundAssignment(
            baseName,
            memberNameSyntax,
            syntax,
            leftRead,
            boundRhs,
            out var userCompoundResult
        ) {
            return userCompoundResult!!
        }
        let previousValue BoundVariableExpression? = CapturePostfixCompoundValue(
            syntax.ReturnsPreviousValue,
            syntax,
            &leftRead,
            out var previousDeclaration
        )
        let binary BoundExpression? = TryBindCompoundBinaryOperation(
            baseOpSyntaxKind,
            leftRead,
            boundRhs,
            syntax.Value.Location
        )
        if binary == nil {
            Diagnostics.ReportUndefinedBinaryOperator(
                syntax.OperatorToken.Location,
                syntax.OperatorToken.Text,
                targetType,
                boundRhs.Type
            )
            return BoundErrorExpression(nil)
        }
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        if previousDeclaration != nil {
            statements.Add(previousDeclaration)
        }
        let converted = conversions.BindConversion(syntax.Value.Location, binary, targetType)
        let name = "<compound${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
        let newValue = LocalVariableSymbol(name, isReadOnly: true, targetType)
        if !$scope.TryDeclareVariable(newValue) {
            throw InvalidOperationException("Failed to declare synthesized compound value local '$name'.")
        }
        statements.Add(BoundVariableDeclaration(syntax, newValue, converted))
        let write = BindBaseClassPropertyWrite(
            memberNameSyntax.IdentifierToken.ValueText,
            memberNameSyntax.IdentifierToken.Location,
            baseLocation,
            BoundVariableExpression(nil, newValue),
            syntax.Value.Location,
            syntax.OperatorToken.Location,
            explicitBaseType: nil,
            selectorLocation: baseLocation
        )
        if write is BoundErrorExpression {
            return write
        }
        statements.Add(BoundExpressionStatement(syntax, write))
        let result BoundExpression = previousValue ?? BoundVariableExpression(nil, newValue)
        return BoundBlockExpression(syntax, statements.ToImmutable(), result)
    }

    /// Issue #2834 for a base-qualified target: `base.M op= v` and
    /// `base.M++` when `M`'s type declares the compound operator.
    /// The base member is read once into a local, the operator runs on that
    /// local, and a value-type result is written back through the base
    /// member's own write (a base setter call for a property), so the getter
    /// runs once and the write is non-virtual, like the read. A reference-type
    /// value is mutated in place and needs no write-back.
    /// @param baseName The `base` receiver name.
    /// @param memberNameSyntax The member name.
    /// @param syntax The compound-assignment syntax.
    /// @param read The bound base read of the member.
    /// @param boundRhs The bound right-hand side.
    /// @param result The bound compound assignment when the type declares the operator.
    /// @returns `true` when a user-defined compound operator applies.
    private func TryBindBaseMemberUserCompoundAssignment(
        baseName NameExpressionSyntax,
        memberNameSyntax NameExpressionSyntax,
        syntax EventSubscriptionExpressionSyntax,
        read BoundExpression,
        boundRhs BoundExpression,
        @System.Diagnostics.CodeAnalysis.NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        if read.Type is not StructSymbol memberType {
            return false
        }
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let name = "<compound${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
        let target = LocalVariableSymbol(name, isReadOnly: false, read.Type)
        let targetExpression = BoundVariableExpression(nil, target)
        let userCompound BoundExpression? = TryBindUserCompoundAssignmentOperator(
            syntax.OperatorToken.Kind,
            targetExpression,
            boundRhs,
            syntax.Value.Location
        )
        if userCompound == nil {
            return false
        }
        // A read-only field is not a compound-assignment target even when the
        // operator mutates in place, exactly as for `this.f op= v`: `base.f`
        // always names a base class's field, which a derived member (even a
        // constructor) may not write.
        let readOnlyField string? = switch read {
            case BoundFieldAccessExpression{
                Field: {IsReadOnly: true} sourceField
            } sourceRead when sourceRead.StructType is not{} fieldOwner ||
                !IsReadOnlyFieldAssignmentAllowed(sourceField, fieldOwner, receiverIsThis: true): sourceField.Name
            case BoundClrPropertyAccessExpression{
                Member: FieldInfo{IsInitOnly: true} or FieldInfo{IsLiteral: true}
            } clrRead: clrRead
                .Member
                .Name
            default: default(string?)
        }
        if readOnlyField != nil {
            Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, readOnlyField)
            result = BoundErrorExpression(nil)
            return true
        }
        if !$scope.TryDeclareVariable(target) {
            throw InvalidOperationException("Failed to declare synthesized compound target local '$name'.")
        }
        statements.Add(BoundVariableDeclaration(syntax, target, read))
        var previousRead BoundExpression = targetExpression
        let previousValue BoundVariableExpression? = CapturePostfixCompoundValue(
            syntax.ReturnsPreviousValue,
            syntax,
            &previousRead,
            out var previousDeclaration
        )
        if previousDeclaration != nil {
            statements.Add(previousDeclaration)
        }
        statements.Add(BoundExpressionStatement(syntax, userCompound))
        if !memberType.IsClass {
            let baseLocation = baseName.Location
            let writeBack = BindBaseClassPropertyWrite(
                memberNameSyntax.IdentifierToken.ValueText,
                memberNameSyntax.IdentifierToken.Location,
                baseLocation,
                targetExpression,
                syntax.Value.Location,
                syntax.OperatorToken.Location,
                explicitBaseType: nil,
                selectorLocation: baseLocation
            )
            if writeBack is BoundErrorExpression {
                result = writeBack
                return true
            }
            statements.Add(BoundExpressionStatement(syntax, writeBack))
        }
        result = BoundBlockExpression(syntax, statements.ToImmutable(), previousValue ?? targetExpression)
        return true
    }

    /// ADR-0060 §13 / issue #4350: binds assignment through an explicit pointer
    /// dereference or a writable ref-returning call.
    /// @param syntax The indirect-assignment syntax.
    /// @returns The bound expression, or an error expression on failure.
    private func BindIndirectAssignmentExpression(syntax IndirectAssignmentExpressionSyntax) BoundExpression {
        let pointer = BindIndirectAssignmentPointer(syntax.Target, out var pointeeType)
        if pointer is BoundErrorExpression {
            return pointer
        }
        var value = BindAssignmentRhs(syntax.Value, pointeeType)
        if value is BoundErrorExpression {
            return value
        }
        if pointer is BoundAddressOfExpression && AsyncBoundTreeQueries.HasAwait(value) {
            Diagnostics.ReportManagedReference(
                syntax.Value.Location,
                "a ref-returning assignment target cannot survive suspension; evaluate the value before selecting the target"
            )
            return BoundErrorExpression(syntax)
        }
        value = conversions.BindConversion(syntax.Value.Location, value, pointeeType)
        if value is BoundErrorExpression {
            return value
        }
        return BoundIndirectAssignmentExpression(syntax, pointer, value)
    }

    /// Issue #1925: binds a compound indirect assignment `*p op= expr`
    /// (e.g. `*(p + i) += 1`). Unlike the plain `*p = expr` form,
    /// the pointer expression must be read AND written through, so — mirroring
    /// (cref:BindIndexedWriteThroughChain)'s single-evaluation of an
    /// indexer receiver — the pointer expression (which may be an arbitrary
    /// pointer-arithmetic expression like `p + i`, not just a bare
    /// variable) is hoisted into a synthesized read-only temp local so it is
    /// evaluated exactly once, then desugared to `*tmp = *tmp op value`.
    private func BindIndirectCompoundAssignmentExpression(
        syntax IndirectCompoundAssignmentExpressionSyntax
    ) BoundExpression {
        let incrementOperatorText string? = if syntax.IsIncrementDecrement {
            (
                if syntax.OperatorToken.Kind == SyntaxKind.PlusEqualsToken {
                    "++"
                } else {
                    "--"
                }
            )
        } else {
            default(string?)
        }
        let pointer = BindIndirectAssignmentPointer(syntax.Target, out var pointeeType, incrementOperatorText)
        if pointer is BoundErrorExpression {
            return pointer
        }
        if !SyntaxFacts.TryGetCompoundAssignmentBaseOperator(syntax.OperatorToken.Kind, out var baseOpKind) {
            // Defensive: parser only emits this node for kinds recognised by
            // TryGetCompoundAssignmentBaseOperator above.
            return BoundErrorExpression(nil)
        }
        let tempName = "<derefAsn${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
        let tempVar = LocalVariableSymbol(tempName, isReadOnly: true, pointer.Type)
        if !$scope.TryDeclareVariable(tempVar) {
            // Defensive: synthesized names cannot collide with user identifiers
            // (the `<...>` prefix is not a valid identifier token), so a failure
            // here means a duplicate synthesized name within the same scope,
            // which Interlocked.Increment guarantees against. Treat as fatal.
            throw InvalidOperationException(
                "Failed to declare synthesized indirect-assignment target local '$tempName'."
            )
        }
        let declaration = BoundVariableDeclaration(syntax, tempVar, pointer)
        let tempRef = BoundVariableExpression(nil, tempVar)
        let indirectTarget BoundExpression = BoundDereferenceExpression(nil, tempRef)
        var indirectRead = indirectTarget
        let previousValue = CapturePostfixCompoundValue(
            syntax.ReturnsPreviousValue,
            syntax,
            &indirectRead,
            out var previousValueDeclaration
        )
        let rhsBound = BindExpression(syntax.Value)
        if rhsBound is BoundErrorExpression || rhsBound.Type == TypeSymbol.Error {
            return BoundErrorExpression(nil)
        }
        if pointer is BoundAddressOfExpression && AsyncBoundTreeQueries.HasAwait(rhsBound) {
            Diagnostics.ReportManagedReference(
                syntax.Value.Location,
                "a ref-returning assignment target cannot survive suspension; evaluate the value before selecting the target"
            )
            return BoundErrorExpression(syntax)
        }
        let userCompound BoundExpression? = TryBindUserCompoundAssignmentOperator(
            syntax.OperatorToken.Kind,
            indirectTarget,
            rhsBound,
            syntax.Value.Location
        )
        if userCompound != nil {
            let statements = ImmutableArray.CreateBuilder[BoundStatement]()
            statements.Add(declaration)
            if syntax.ReturnsPreviousValue {
                return FinishPostfixCompoundAssignment(
                    syntax,
                    statements,
                    previousValueDeclaration,
                    previousValue,
                    userCompound
                )
            }
            if syntax.IsIncrementDecrement {
                statements.Add(BoundExpressionStatement(syntax, userCompound))
                return BoundBlockExpression(syntax, statements.ToImmutable(), indirectTarget)
            }
            return BoundBlockExpression(syntax, statements.ToImmutable(), userCompound)
        }
        // issue #1226 / #1246: the right operand of the compound operation
        // participates in the SAME constant-integer-literal adaptation and
        // implicit numeric widening as the equivalent binary `*p op value`.
        var combined BoundExpression? = TryBindCompoundBinaryOperation(
            baseOpKind,
            indirectRead,
            rhsBound,
            syntax.Value.Location
        )
        if combined == nil {
            Diagnostics.ReportUndefinedBinaryOperator(
                syntax.OperatorToken.Location,
                syntax.OperatorToken.Text,
                indirectRead.Type,
                rhsBound.Type
            )
            return BoundErrorExpression(nil)
        }
        if combined.Type != pointeeType && combined.Type != TypeSymbol.Error {
            let converted = Conversion.Classify(combined.Type, pointeeType)
            if !converted.IsImplicit {
                Diagnostics.ReportCannotConvert(syntax.Value.Location, combined.Type, pointeeType)
                return BoundErrorExpression(nil)
            }
            combined = BoundConversionExpression(nil, pointeeType, combined)
        }
        let assignment = BoundIndirectAssignmentExpression(syntax, tempRef, combined!!)
        if syntax.ReturnsPreviousValue {
            return BoundBlockExpression(
                syntax,
                ImmutableArray.Create[BoundStatement](
                    declaration,
                    Invariant.Required(
                        previousValueDeclaration,
                        "postfix increment/decrement captures its previous value",
                        expression: "previousValueDeclaration"
                    ),
                    BoundExpressionStatement(syntax, assignment)
                ),
                Invariant.Required(
                    previousValue,
                    "postfix increment/decrement declares its previous value",
                    expression: "previousValue"
                )
            )
        }
        return BoundBlockExpression(syntax, ImmutableArray.Create[BoundStatement](declaration), assignment)
    }

    private func BindIndirectAssignmentPointer(
        target ExpressionSyntax,
        out pointeeType TypeSymbol,
        incrementOperatorText string? = nil
    ) BoundExpression {
        pointeeType = TypeSymbol.Error
        let unwrappedTarget = AssignmentTargetSyntaxFacts.UnwrapParentheses(target)
        if unwrappedTarget is UnaryExpressionSyntax dereference &&
            dereference
            .OperatorToken
            .Kind == SyntaxKind
            .StarToken {
            var pointer = BindExpression(dereference.Operand)
            if pointer is BoundErrorExpression {
                return pointer
            }
            if ManagedReferenceTypes.TryGetElement(pointer.Type, out _, out _) {
                pointer = BorrowManagedReference(pointer, unwrappedTarget)
                if pointer is BoundErrorExpression {
                    return pointer
                }
            }
            if RefCapabilities.IsReadOnlyReference(pointer) {
                Diagnostics.ReportManagedReference(target.Location, "readonly storage cannot be written through")
                return BoundErrorExpression(target)
            }
            if !TypeSymbol.TryGetPointeeType(pointer.Type, out var explicitPointeeType) {
                Diagnostics.ReportUndefinedUnaryOperator(
                    dereference.OperatorToken.Location,
                    dereference.OperatorToken.Text,
                    pointer.Type
                )
                return BoundErrorExpression(nil)
            }
            pointeeType = Invariant.Required(
                explicitPointeeType,
                "a successfully classified pointer has a pointee type",
                expression: "explicitPointeeType"
            )
            if TypeSymbol.IsVoidPointer(pointer.Type) {
                Diagnostics.ReportVoidPointerOperationNotAllowed(dereference.OperatorToken.Location, "dereference")
                return BoundErrorExpression(nil)
            }
            return pointer
        }
        let storage = BindExpression(target)
        if storage is BoundErrorExpression {
            return storage
        }
        if !IsLvalue(storage) {
            if incrementOperatorText != nil && AssignmentTargetSyntaxFacts.IsCallResult(target) {
                Diagnostics.ReportInvalidIncrementDecrementTarget(target.Location, incrementOperatorText)
            } else {
                Diagnostics.ReportCannotTakeAddressOfNonLvalue(target.Location, target.ToString())
            }
            return BoundErrorExpression(target)
        }
        if RefCapabilities.IsReadOnlyStorage(storage) {
            if unwrappedTarget is UnaryExpressionSyntax &&
                unwrappedTarget
                .OperatorToken
                .Kind == SyntaxKind.StarToken ||
                AssignmentTargetSyntaxFacts
                .IsCallResult(target) {
                Diagnostics.ReportManagedReference(target.Location, "readonly storage cannot be written through")
            } else {
                Diagnostics.ReportCannotAssign(target.Location, target.ToString())
            }
            return BoundErrorExpression(target)
        }
        pointeeType = storage.Type
        return BoundAddressOfExpression(target, storage, unmanaged: false)
    }

    /// ADR-0060: binds a `ref`/`out`/`in` argument-position expression.
    /// For the lvalue form (e.g. `ref x`, `out result`, `in rect`) the
    /// inner expression is bound to a (cref:BoundAddressOfExpression). For the
    /// inline-declaration / discard form (`out var name`, `out let name`,
    /// `out _`), a synthesized (cref:LocalVariableSymbol) is registered in
    /// the current scope (with the declared type, or — if omitted — the parameter's
    /// pointee type) and the address-of expression wraps it.
    /// @param syntax The ref-kind argument syntax.
    /// @param parameter The callee parameter this argument binds to (may be `null` when unresolved).
    /// @returns The bound address-of expression, or an error expression on failure.
    internal func BindRefArgumentExpression(
        syntax RefArgumentExpressionSyntax,
        parameter ParameterSymbol?
    ) BoundExpression {
        if syntax.IsInlineDeclaration {
            // ADR-0060 §1: `out var n [T]` / `out let n [T]` / `out _ [T]`.
            // Only legal when the modifier is `out` AND the parameter (if known) is `out`.
            if !string.Equals(syntax.RefKindModifier.Text, "out", StringComparison.Ordinal) ||
                (parameter != nil && parameter.RefKind != RefKind.Out) {
                Diagnostics.ReportOutDeclarationOutsideOutArgument(syntax.Location)
                return BoundErrorExpression(nil)
            }
            var declaredType TypeSymbol? = nil
            if syntax.DeclaredType != nil {
                declaredType = bindTypeClause(syntax.DeclaredType) ?? TypeSymbol.Error
            }
            if declaredType == nil && parameter != nil {
                declaredType = parameter.Type
            }
            // ADR-0060: in the first pass (called from BindCallExpression before
            // overload resolution), the parameter is unknown and no explicit
            // type was given. Return a placeholder bound node *without*
            // declaring a local — the call-site arg-loop re-binds us once the
            // parameter has been resolved so the local has the right type.
            if declaredType == nil {
                return BoundAddressOfExpression(nil, BoundErrorExpression(nil))
            }
            // Synthesize the local. `out _` gets a fresh anonymous name; `out var`/`out let`
            // honour the user-given identifier.
            let isReadOnly = syntax.DeclarationKeyword != nil && string.Equals(
                syntax.DeclarationKeyword.Text,
                "let",
                StringComparison.Ordinal
            )
            var localName string? = nil
            if syntax.DiscardToken != nil {
                localName = "<>out_discard_${binderCtx.OutDiscardCounter}"
                binderCtx.OutDiscardCounter++
            }
            let identifierForName SyntaxToken? = syntax.DeclarationIdentifier
            if syntax.DiscardToken == nil && identifierForName != nil {
                localName = identifierForName.Text
            }
            if localName == nil {
                return BoundErrorExpression(nil)
            }
            let local = LocalVariableSymbol(localName, isReadOnly, declaredType, declaringSyntax: syntax)
            if syntax.DiscardToken == nil {
                if syntax.DeclarationIdentifier is not{} resolvedDeclarationIdentifier {
                    return BoundErrorExpression(nil)
                }
                if !$scope.TryDeclareVariable(local) {
                    // Issue #3490: an argument list can legally bind twice —
                    // BindCallExpression pre-binds every argument for overload
                    // probing, then the implicit static-self and using-static
                    // finalizers re-bind the whole call from syntax. When the
                    // colliding local was declared from THIS SAME syntax node,
                    // this is that re-bind, not a genuine duplicate: reuse the
                    // already-declared local (same parameter → same type)
                    // instead of reporting GS0102 and cascading into GS9002 at
                    // the out-parameter position.
                    if $scope.TryLookupSymbol(localName) is LocalVariableSymbol existing && object.ReferenceEquals(
                        existing.DeclaringSyntax,
                        syntax
                    ) {
                        return BoundAddressOfExpression(nil, BoundVariableExpression(nil, existing))
                    }
                    Diagnostics.ReportSymbolAlreadyDeclared(resolvedDeclarationIdentifier.Location, localName)
                    return BoundErrorExpression(nil)
                }
            } else if syntax.DiscardToken != nil {
                // Discards never collide; always declare under the synthesized name.
                $scope.TryDeclareVariable(local)
            }
            let nameExpression = BoundVariableExpression(nil, local)
            return BoundAddressOfExpression(nil, nameExpression)
        }
        // Plain lvalue form: bind the operand and check it's an lvalue.
        // ADR-0061: the operand may be a conditional ref-argument expression
        // (`cond ? a : b`); dispatch to the dedicated binder which produces
        // a BoundConditionalAddressExpression (also typed `T&`). The
        // operand may be wrapped in parens (`ref (cond ? a : b)`); unwrap.
        if syntax.Expression is not{} expression {
            return BoundErrorExpression(nil)
        }
        var rawExpr = expression
        while rawExpr is ParenthesizedExpressionSyntax pen {
            rawExpr = pen.Expression
        }
        if rawExpr is ConditionalRefArgumentExpressionSyntax condSyntax {
            return conversions.BindConditionalRefArgument(condSyntax, syntax.RefKindModifier)
        }
        // ADR-0062: a general conditional expression as the payload of
        // ref/out/in binds to the conditional-address path (preserving
        // ADR-0061 byref safety).
        if rawExpr is ConditionalExpressionSyntax generalCondSyntax {
            return BindConditionalAddressFromGeneral(generalCondSyntax, syntax.RefKindModifier)
        }
        let operand = BindExpression(expression)
        if operand is BoundErrorExpression {
            return operand
        }
        if !IsLvalue(operand) {
            Diagnostics.ReportCannotTakeAddressOfNonLvalue(
                syntax.RefKindModifier.Location,
                syntax.Expression!!.ToString()
            )
            return BoundErrorExpression(nil)
        }
        // Constructor-owned readonly fields retain their initialization permissions.
        if syntax.RefKindModifier.Text != "in" && RefCapabilities.IsReadOnlyStorage(operand) &&
            !(operand is BoundFieldAccessExpression && IsWritableStructFieldReceiver(operand)) {
            Diagnostics.ReportCannotTakeAddressOfConstant(
                syntax.RefKindModifier.Location,
                syntax.Expression!!.ToString()
            )
            return BoundErrorExpression(nil)
        }
        return BoundAddressOfExpression(nil, operand, unmanaged: false, isReadOnly: syntax.RefKindModifier.Text == "in")
    }

    /// ADR-0060 / issues #1133, #1139: re-binds a first-pass inline out-var
    /// placeholder once overload resolution has chosen the callee. An inline
    /// `out var n` / `out let n` / `out _` argument is bound in
    /// the first pass (before the parameter/method is known) to a
    /// (cref:BoundAddressOfExpression) wrapping a
    /// (cref:BoundErrorExpression) that declares <em>no</em> local. Now
    /// that the resolved out-parameter (and its substituted pointee type) is
    /// known, re-bind via (cref:BindRefArgumentExpression) so the
    /// synthesized local is typed correctly and leaks into the enclosing block
    /// scope. Shared by the user-instance path
    /// ((cref:OverloadResolver.BindUserInstanceCall)) and the qualified
    /// static path (`BindUserTypeStaticCall`) so both behave identically.
    /// @param boundArg The first-pass bound argument that may be an
    /// inline out-var placeholder.
    /// @param slotSyntax The argument syntax at this position (may be a
    /// named-argument wrapper).
    /// @param resolvedParameter The resolved out-parameter this argument
    /// binds to.
    /// @param substitutedPointeeType The (already-substituted) pointee
    /// type the synthesized local should carry.
    /// @returns The rebound address-of expression when [`boundArg`](paramref)
    /// is an inline out-var placeholder; otherwise `null` so the
    /// caller keeps its normal conversion path.
    internal func TryRebindInlineOutVarPlaceholder(
        boundArg BoundExpression,
        slotSyntax ExpressionSyntax?,
        resolvedParameter ParameterSymbol,
        substitutedPointeeType TypeSymbol
    ) BoundExpression? {
        if boundArg is not BoundAddressOfExpression inlineOutAddr || inlineOutAddr.Operand.Type != TypeSymbol.Error {
            return nil
        }
        let unwrappedSlotSyntax = if slotSyntax != nil {
            OverloadResolver.UnwrapNamedArgumentValue(slotSyntax)
        } else {
            default(ExpressionSyntax?)
        }
        if unwrappedSlotSyntax is not RefArgumentExpressionSyntax inlineOutRefArg ||
            !inlineOutRefArg.IsInlineDeclaration ||
            inlineOutRefArg.DeclaredType != nil {
            return nil
        }
        let rebindParameter = if object.ReferenceEquals(substitutedPointeeType, resolvedParameter.Type) {
            resolvedParameter
        } else {
            ParameterSymbol(resolvedParameter, substitutedPointeeType)
        }
        return BindRefArgumentExpression(inlineOutRefArg, rebindParameter)
    }

    private func BindIndexAssignmentExpression(syntax IndexAssignmentExpressionSyntax) BoundExpression {
        let name = syntax.TargetIdentifier.ValueText
        if $scope.TryLookupSymbol(name) is not VariableSymbol variable {
            // ADR-0156 Phase 2 (issue #3251): a bare indexed write
            // (`name[i] = v`) whose target is a top-level global declared by
            // a prior interactive submission. Every sibling lvalue shape
            // (read, whole-variable write, compound `name[i] op= v` via the
            // chain path) already consults the submission fallback; without
            // this the shape reports a spurious GS0125.
            if TryBindSubmissionGlobalIndexAssignment(syntax, out var submissionIndexWrite) &&
                submissionIndexWrite is {} resolvedSubmissionIndexWrite {
                return resolvedSubmissionIndexWrite
            }
            Diagnostics.ReportUndefinedVariable(syntax.TargetIdentifier.Location, name)
            return BoundErrorExpression(nil)
        }
        if syntax.Indices.Count > 1 || IsRectangularArrayType(variable.Type) {
            return BindRectangularIndexAssignment(
                variable,
                syntax.Indices,
                syntax.Value,
                syntax.TargetIdentifier.Location
            )
        }
        // Issue #674: when the target resolves to an implicit field on `this`,
        // the raw ImplicitFieldVariableSymbol has no local slot in the emitter.
        // Rewrite to a temp-local initialized from the proper field access
        // expression (mirroring what BindIndexedWriteThroughChain does for
        // chained member-index assignments). The temp is a real local the
        // emitter can load.
        if variable is ImplicitFieldVariableSymbol implicitField {
            // Issue #4377 (ADR-0122 §10): a bare fixed-size buffer field decays
            // to its `*T` first-element pointer, as on the read path, so the
            // indexed write goes through the pointer into the inline buffer.
            let fieldAccess = if implicitField.Field.IsFixedBuffer {
                MakeFixedBufferPointer(
                    BoundVariableExpression(nil, implicitField.Receiver),
                    implicitField.StructType,
                    implicitField.Field
                )
            } else {
                cast[BoundExpression](
                    BoundFieldAccessExpression(
                        nil,
                        BoundVariableExpression(nil, implicitField.Receiver),
                        implicitField.StructType,
                        implicitField.Field
                    )
                )
            }
            let tempName = "<idxAsn${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
            let tempVar = LocalVariableSymbol(tempName, isReadOnly: true, fieldAccess.Type)
            $scope.TryDeclareVariable(tempVar)
            let declaration = BoundVariableDeclaration(syntax, tempVar, fieldAccess)
            let assignment = BindIndexedAssignmentToVariable(
                tempVar,
                syntax.Index,
                syntax.Value,
                syntax.TargetIdentifier.Location
            )
            if assignment is BoundErrorExpression {
                return assignment
            }
            return BoundBlockExpression(syntax, ImmutableArray.Create[BoundStatement](declaration), assignment)
        }
        // Issue #1446: the property counterpart of the implicit-field case
        // above. A bare instance auto-property name resolves to an
        // ImplicitPropertyVariableSymbol, which likewise has no local slot.
        // Initialise a temp local from the property getter (for an array
        // property this is the array reference, so the subsequent stelem
        // mutates the underlying array), then do the indexed write to that
        // real local. Mirrors the read-side property rebinding from #1339.
        if variable is ImplicitPropertyVariableSymbol implicitProp {
            if !implicitProp.Property.HasGetter {
                Diagnostics.ReportCannotAssign(syntax.TargetIdentifier.Location, implicitProp.Property.Name)
                return BoundErrorExpression(nil)
            }
            let propertyAccess = BoundPropertyAccessExpression(
                nil,
                BoundVariableExpression(nil, implicitProp.Receiver),
                implicitProp.StructType,
                implicitProp.Property
            )
            let tempName = "<idxAsn${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
            let tempVar = LocalVariableSymbol(tempName, isReadOnly: true, propertyAccess.Type)
            $scope.TryDeclareVariable(tempVar)
            let declaration = BoundVariableDeclaration(syntax, tempVar, propertyAccess)
            let assignment = BindIndexedAssignmentToVariable(
                tempVar,
                syntax.Index,
                syntax.Value,
                syntax.TargetIdentifier.Location
            )
            if assignment is BoundErrorExpression {
                return assignment
            }
            return BoundBlockExpression(syntax, ImmutableArray.Create[BoundStatement](declaration), assignment)
        }
        // ADR-0140 / issue #2131: the static-field counterpart of the
        // implicit-field case above. A bare static array/slice field name
        // (e.g. `Table` inside a `shared` method or `init { … }` block)
        // resolves to an ImplicitStaticFieldVariableSymbol, which has no local
        // slot in the emitter. Initialise a temp local from the static-field
        // access (for an array/slice this is the reference, so the subsequent
        // stelem mutates the underlying storage), then do the indexed write to
        // that real local.
        if variable is ImplicitStaticFieldVariableSymbol implicitStaticField {
            let fieldAccess = if implicitStaticField.InterfaceType != nil {
                BoundFieldAccessExpression(nil, implicitStaticField.Field, implicitStaticField.InterfaceType)
            } else {
                BoundFieldAccessExpression(
                    nil,
                    receiver: nil,
                    implicitStaticField.StructType,
                    implicitStaticField.Field
                )
            }
            let tempName = "<idxAsn${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
            let tempVar = LocalVariableSymbol(tempName, isReadOnly: true, fieldAccess.Type)
            $scope.TryDeclareVariable(tempVar)
            let declaration = BoundVariableDeclaration(syntax, tempVar, fieldAccess)
            let assignment = BindIndexedAssignmentToVariable(
                tempVar,
                syntax.Index,
                syntax.Value,
                syntax.TargetIdentifier.Location
            )
            if assignment is BoundErrorExpression {
                return assignment
            }
            return BoundBlockExpression(syntax, ImmutableArray.Create[BoundStatement](declaration), assignment)
        }
        return BindIndexedAssignmentToVariable(variable, syntax.Index, syntax.Value, syntax.TargetIdentifier.Location)
    }

    private func BindRectangularIndexAssignment(
        variable VariableSymbol,
        indexSyntaxes GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
        valueSyntax ExpressionSyntax,
        diagnosticLocation TextLocation
    ) BoundExpression {
        var target BoundExpression
        switch variable {
            case implicitField is ImplicitFieldVariableSymbol {
                target = BoundFieldAccessExpression(
                    nil,
                    BoundVariableExpression(nil, implicitField.Receiver),
                    implicitField.StructType,
                    implicitField.Field,
                    TryGetNarrowedType(implicitField)
                )
            }
            case implicitStaticField is ImplicitStaticFieldVariableSymbol {
                target = if implicitStaticField.InterfaceType != nil {
                    BoundFieldAccessExpression(nil, implicitStaticField.Field, implicitStaticField.InterfaceType)
                } else {
                    BoundFieldAccessExpression(
                        nil,
                        receiver: nil,
                        implicitStaticField.StructType,
                        implicitStaticField.Field,
                        TryGetNarrowedType(implicitStaticField)
                    )
                }
            }
            case implicitProperty is ImplicitPropertyVariableSymbol {
                if !implicitProperty.Property.HasGetter {
                    Diagnostics.ReportCannotAssign(diagnosticLocation, implicitProperty.Property.Name)
                    return BoundErrorExpression(nil)
                }
                target = BoundPropertyAccessExpression(
                    nil,
                    BoundVariableExpression(nil, implicitProperty.Receiver),
                    implicitProperty.StructType,
                    implicitProperty.Property,
                    TryGetNarrowedType(implicitProperty)
                )
            }
            case implicitStaticProperty is ImplicitStaticPropertyVariableSymbol {
                if !implicitStaticProperty.Property.HasGetter {
                    Diagnostics.ReportCannotAssign(diagnosticLocation, implicitStaticProperty.Property.Name)
                    return BoundErrorExpression(nil)
                }
                target = BoundPropertyAccessExpression(
                    nil,
                    receiver: nil,
                    implicitStaticProperty.StructType,
                    implicitStaticProperty.Property,
                    TryGetNarrowedType(implicitStaticProperty)
                )
            }
            default {
                target = BuildNarrowedVariableRead(variable, diagnosticLocation)
            }
        }
        TrackBackwardGotoIndexUse(target, diagnosticLocation)
        let rectangular RectangularArrayTypeSymbol? = GetRectangularArrayTypeForBinding(target.Type)
        // ADR-0187 / issue #4350: a multi-parameter user indexer write.
        if rectangular == nil &&
            TryBindMultiIndexUserAssignment(
            target,
            indexSyntaxes,
            (elementType TypeSymbol, _() -> BoundExpression) -> conversions.BindConversion(valueSyntax, elementType),
            (elementType TypeSymbol) -> {
                let _ = conversions.BindConversion(valueSyntax, elementType)
            },
            diagnosticLocation,
            requiresRead: false
        ) is {} userIndexAssignment {
            return userIndexAssignment
        }
        if rectangular == nil {
            Diagnostics.ReportTypeNotIndexable(diagnosticLocation, target.Type)
            return BoundErrorExpression(nil)
        }
        if indexSyntaxes.Count != rectangular.Rank {
            Diagnostics.ReportRectangularArrayIndexRankMismatch(
                diagnosticLocation,
                rectangular.Rank,
                indexSyntaxes.Count
            )
            return BoundErrorExpression(nil)
        }
        let indices = ImmutableArray.CreateBuilder[BoundExpression](indexSyntaxes.Count)
        for indexSyntax in indexSyntaxes {
            indices.Add(BindRectangularArrayElementIndex(indexSyntax))
        }
        let value = conversions.BindConversion(valueSyntax, rectangular.ElementType)
        let boundIndices = indices.MoveToImmutable()
        let narrowed = target is not BoundVariableExpression targetVariable || targetVariable.NarrowedType != nil
        return if narrowed {
            BoundIndexAssignmentExpression.WithExpressionTarget(
                nil,
                target,
                boundIndices,
                value,
                rectangular.ElementType
            )
        } else {
            BoundIndexAssignmentExpression(nil, variable, boundIndices, value, rectangular.ElementType)
        }
    }

    private func BindMemberIndexAssignmentExpression(syntax MemberIndexAssignmentExpressionSyntax) BoundExpression {
        if syntax.Target.IsNullConditional {
            // ADR-0073 / issue #710: reject `a?[i] = v`. The null-conditional
            // index expression is not a valid assignment target — mirroring
            // C#'s CS0131 behavior on `?[]` LHS. Use `if a != nil { a[i] = v }`
            // (or `a[i] = v` directly) instead.
            Diagnostics.ReportNullConditionalIndexAssignmentTarget(syntax.Target.OpenBracketToken.Location)
            return BoundErrorExpression(syntax)
        }
        if syntax.Target.Indices.Count > 1 {
            let target = BindExpression(syntax.Target.Target)
            let rectangular RectangularArrayTypeSymbol? = GetRectangularArrayTypeForBinding(target.Type)
            // ADR-0187 / issue #4350: a multi-parameter user indexer write.
            if rectangular == nil &&
                TryBindMultiIndexUserAssignment(
                target,
                syntax.Target.Indices,
                (elementType TypeSymbol, _() -> BoundExpression) -> conversions.BindConversion(
                    syntax.Value,
                    elementType
                ),
                (elementType TypeSymbol) -> {
                    let _ = conversions.BindConversion(syntax.Value, elementType)
                },
                syntax.Target.Target.Location,
                requiresRead: false
            ) is {} userIndexAssignment {
                return userIndexAssignment
            }
            if rectangular == nil {
                Diagnostics.ReportTypeNotIndexable(syntax.Target.Target.Location, target.Type)
                return BoundErrorExpression(syntax)
            }
            if syntax.Target.Indices.Count != rectangular.Rank {
                Diagnostics.ReportRectangularArrayIndexRankMismatch(
                    syntax.Target.Target.Location,
                    rectangular.Rank,
                    syntax.Target.Indices.Count
                )
                return BoundErrorExpression(syntax)
            }
            let indices = ImmutableArray.CreateBuilder[BoundExpression](rectangular.Rank)
            for indexSyntax in syntax.Target.Indices {
                indices.Add(BindRectangularArrayElementIndex(indexSyntax))
            }
            return BoundIndexAssignmentExpression.WithExpressionTarget(
                syntax,
                target,
                indices.MoveToImmutable(),
                conversions.BindConversion(syntax.Value, rectangular.ElementType),
                rectangular.ElementType
            )
        }
        return BindIndexedWriteThroughChain(
            chainBase: nil,
            remainingChain: syntax.Target.Target,
            indexSyntax: syntax.Target.Index,
            valueSyntax: syntax.Value,
            boundValueOverride: nil,
            compoundOperatorToken: nil,
            compoundRhsSyntax: nil,
            diagnosticLocation: syntax.Target.Target.Location,
            outerSyntax: syntax
        )
    }

    /// Issue #648: binds a chained member-access assignment of the form
    /// `receiver.Field = value` where the receiver is an arbitrary
    /// expression (e.g. `a.B.C = v`). The receiver is bound to a
    /// (cref:BoundExpression), its result type is inspected for the
    /// named field/property, and the appropriate assignment bound node is
    /// produced.
    private func BindMemberFieldAssignmentExpression(syntax MemberFieldAssignmentExpressionSyntax) BoundExpression {
        // Issue #1559 (extends ADR-0089 / issue #1030 and issue #1209/#1323): a
        // write to a static field/property through a constructed generic *type*
        // receiver — `Foo[int32].x = v` (class/struct), `IBox[int32].Field = v`
        // (interface), or an imported CLR generic. The receiver `Foo[int32]` is
        // a TYPE, not a value, so it is resolved to the constructed type symbol
        // (mirroring the READ path in BindAccessorExpression) rather than bound
        // as an index expression — which would otherwise report GS0125
        // "Variable 'Foo' doesn't exist". The parser shapes the receiver as an
        // IndexExpression (single type-arg) or a GenericNameExpression (nullable
        // / nested / multiple type-args); a single dispatcher covers both.
        if TryResolveConstructedGenericTypeReceiver(
            syntax.Receiver,
            out var ctorStruct,
            out var ctorIface,
            out var ctorImported,
            out var ctorFailureHandled
        ) {
            return BindConstructedGenericStaticFieldWrite(syntax, ctorStruct, ctorIface, ctorImported)
        }
        // Issue #4051: the write path's version of the read path's cascade.
        // `Handler[string].Field = "z"` reported the accurate GS0152 and then
        // fell through to `BindExpression(syntax.Receiver)` below — which is
        // exactly the index-expression re-reading the comment above says this
        // branch exists to prevent, and it produced the same two false
        // `GS0125 Variable 'X' doesn't exist`. The construction already
        // explained itself.
        if ctorFailureHandled {
            return BoundErrorExpression(syntax)
        }
        var receiver = BindExpression(syntax.Receiver)
        if receiver is BoundErrorExpression {
            return receiver
        }
        if binderCtx.TryGetBackwardGotoNarrowingPath(receiver, out var path, out _) {
            binderCtx.TrackBackwardGotoNarrowingUse(
                path!!,
                syntax.FieldIdentifier.Location,
                syntax.FieldIdentifier.ValueText,
                BackwardGotoNarrowingUseKind.Member
            )
        }
        // ADR-0186 §4/§5: the WRITE side of a member access has its own
        // receiver path, and failure mode 1 of ADR-0186's catalogue is
        // literally "the read and call paths drifted". Checking and
        // unwrapping here keeps this path identical to
        // `ExpressionBinder.CheckPlatformReceiver`'s: the same check, and the
        // same guarantee that the dispatch below — which switches on the
        // receiver's symbol KIND — never sees a platform wrapper.
        receiver = PlatformCoercion.InsertCheck(receiver, syntax.Receiver.Location, "a member assignment receiver")
        let receiverType = receiver.Type
        let fieldName = if receiverType is TupleTypeSymbol tupleType {
            GetTupleFieldName(syntax.FieldIdentifier.ValueText, tupleType)
        } else {
            syntax.FieldIdentifier.ValueText
        }
        var value BoundExpression? = nil
        let BindValue = func (targetType TypeSymbol) BoundExpression {
            return (
                if value == nil {
                    (value = BindAssignmentRhs(syntax.Value, targetType))
                } else {
                    value
                }
            )!!
        }
        // User-defined struct/class receiver → field or property write.
        if receiverType is StructSymbol structSym {
            let hasNearestProperty = TypeMemberModel.TryGetProperty(
                structSym,
                fieldName,
                out var nearestProperty,
                out var nearestPropertyDeclaringType
            )
            let hasAssignmentField = TypeMemberModel.TryGetFieldIncludingInherited(
                structSym,
                fieldName,
                MemberQuery.Instance(MemberKinds.Field),
                out var field,
                out var declaringType
            )
            // ADR-0112 A3: this-first base-chain instance field walk, using the
            // declaring struct as the owner for the emitted assignment.
            if hasAssignmentField &&
                (
                !hasNearestProperty ||
                    IsFieldAtLeastAsNearAsProperty(
                    structSym,
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
                field = Invariant.Required(field, "a resolved member field has a symbol", expression: "field")
                declaringType = Invariant.Required(
                    declaringType,
                    "a resolved member field has a declaring type",
                    expression: "declaringType"
                )
                if field.IsReadOnly &&
                    !IsReadOnlyFieldAssignmentAllowed(field, declaringType, ReceiverExpressionIsThis(receiver)) {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName)
                }
                // Issue #950 / #2044: enforce `protected`/`private` field
                // assignment through a chained/expression receiver (e.g.
                // `a.B.C = v`, `GetObj().Field = v`) — mirrors the
                // simple-receiver check in BindFieldAssignmentExpression.
                if !AccessibilityChecker.IsAccessible(field.Accessibility, declaringType, this.function) {
                    Diagnostics.ReportMemberInaccessible(
                        syntax.FieldIdentifier.Location,
                        field.Name,
                        declaringType.Name,
                        field.Accessibility
                    )
                }
                reportObsoleteUseIfApplicable(
                    syntax.FieldIdentifier.Location,
                    field,
                    "${declaringType.Name}.${field.Name}"
                )
                let converted = conversions.BindConversion(syntax.Value.Location, BindValue(field.Type), field.Type)
                if !structSym.IsClass && !IsWritableStructFieldReceiver(receiver) {
                    Diagnostics.ReportFieldAssignmentThroughStructTemporary(
                        syntax.EqualsToken.Location,
                        field.Name,
                        structSym
                    )
                    return BoundErrorExpression(syntax)
                }
                receiver = RecoverDeclaredMemberWriteReceiver(
                    receiver,
                    syntax.FieldIdentifier.Location,
                    declaringType,
                    syntax.Receiver.Location
                )
                return BoundFieldAssignmentExpression.WithExpressionReceiver(
                    nil,
                    receiver,
                    declaringType,
                    field,
                    converted
                )
            }
            // ADR-0051: check properties before reporting "unable to find member".
            if hasNearestProperty {
                let prop = Invariant.Required(
                    nearestProperty,
                    "a resolved member property has a symbol",
                    expression: "nearestProperty"
                )
                var propDeclaringType = nearestPropertyDeclaringType
                propDeclaringType = Invariant.Required(
                    propDeclaringType,
                    "a user-defined struct property has a declaring type",
                    expression: "propDeclaringType"
                )
                if !prop.HasSetter && !IsGetOnlyAutoPropertyConstructorWrite(prop, propDeclaringType, receiver) {
                    // Issue #4224: a writable-ref-returning getter (no setter,
                    // but `ReturnRefKind == Ref`) stores through the getter
                    // instead of failing outright. Covers the side-effecting
                    // receiver case (`GetHolder().Value = v`) — `receiver` is
                    // reused verbatim below, so it is evaluated exactly once.
                    let refConverted = conversions.BindConversion(
                        syntax.Value.Location,
                        BindValue(prop.Type),
                        prop.Type
                    )
                    if TryBindRefGetterWriteThrough(
                        prop,
                        receiver,
                        structSym,
                        propDeclaringType,
                        syntax.FieldIdentifier.Location,
                        syntax.EqualsToken.Location,
                        refConverted,
                        out var refWriteThrough
                    ) {
                        return refWriteThrough
                    }
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName)
                    return BoundErrorExpression(nil)
                }
                // Issue #950 / #2044: enforce `protected`/`private` property
                // assignment through a chained/expression receiver.
                if !AccessibilityChecker.IsAccessible(prop.SetterAccessibility, propDeclaringType, this.function) {
                    Diagnostics.ReportMemberInaccessible(
                        syntax.FieldIdentifier.Location,
                        prop.Name,
                        propDeclaringType.Name,
                        prop.SetterAccessibility
                    )
                }
                let propConverted = conversions.BindConversion(syntax.Value.Location, BindValue(prop.Type), prop.Type)
                EnforceInitOnlyAssignment(prop, receiver, syntax.EqualsToken.Location)
                return BindPropertyAssignmentWithDeclaredReceiver(
                    receiver,
                    syntax.FieldIdentifier.Location,
                    propDeclaringType,
                    prop,
                    propConverted,
                    syntax.Receiver.Location
                )
            }
            // Inherited CLR base member fallback (issue #1582: walk the user
            // base chain and include inherited protected members).
            if GetInheritedClrBaseType(structSym) is Type inheritedBaseClr {
                var clrMember MemberInfo? = ClrTypeUtilities.SafeGetInheritedInstanceProperty(
                    inheritedBaseClr,
                    fieldName,
                    CanAccessInternalsOf
                )
                clrMember ??= ClrTypeUtilities.SafeGetInheritedInstanceField(
                    inheritedBaseClr,
                    fieldName,
                    CanAccessInternalsOf
                )
                if clrMember != nil {
                    // Issue #3815: project the inherited member through the
                    // derived receiver so an imported GENERIC base's member keeps
                    // the derived type's own type arguments (ChannelReader[T], not
                    // the erased ChannelReader[object]).
                    if !TryGetWritableClrMember(
                        clrMember,
                        structSym,
                        out var inhTargetType,
                        out var inhTargetSymbol,
                        out var inhWritable,
                        fromDerivedType: true
                    ) {
                        Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName)
                        return BoundErrorExpression(nil)
                    }
                    receiver,
                    clrMember = RecoverDeclaredClrMemberWriteReceiver(
                        receiver,
                        syntax.FieldIdentifier.Location,
                        clrMember,
                        syntax.Receiver.Location
                    )
                    let inhConverted = conversions.BindConversion(
                        syntax.Value.Location,
                        BindValue(inhTargetSymbol!!),
                        inhTargetSymbol
                    )
                    return BoundClrPropertyAssignmentExpression(
                        nil,
                        receiver,
                        clrMember!!,
                        inhConverted,
                        inhTargetSymbol!!,
                        staticContainerType: nil
                    )
                }
            }
            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName)
            return BoundErrorExpression(nil)
        }
        // Issue #1068: write a property declared on the static interface type
        // (or any base interface) through an interface-typed receiver. Mirrors
        // the property read path in ExpressionBinder.Access.cs so `b.H = v`
        // (b : IBase) dispatches via a verifiable `callvirt set_H`.
        if receiverType is InterfaceSymbol ifaceSym {
            if TypeMemberModel.TryGetPropertyWithOwner(ifaceSym, fieldName, out var ifaceProp, out var ifaceOwner) {
                if !ifaceProp.HasSetter {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName)
                    return BoundErrorExpression(nil)
                }
                let effectiveInterface = Invariant.Required(
                    ifaceOwner as InterfaceSymbol,
                    "an interface property has an effective interface owner",
                    expression: "ifaceOwner as InterfaceSymbol"
                )
                if !AccessibilityChecker.IsAccessible(
                    ifaceProp.SetterAccessibility,
                    effectiveInterface,
                    this.function
                ) {
                    Diagnostics.ReportMemberInaccessible(
                        syntax.FieldIdentifier.Location,
                        ifaceProp.Name,
                        effectiveInterface.Name,
                        ifaceProp.SetterAccessibility
                    )
                }
                let propertyType = effectiveInterface.SubstituteMemberType(ifaceProp.Type)
                receiver = RecoverDeclaredPropertyWriteReceiver(
                    receiver,
                    syntax.FieldIdentifier.Location,
                    ifaceProp,
                    syntax.Receiver.Location
                )
                let ifaceConverted = conversions.BindConversion(
                    syntax.Value.Location,
                    BindValue(propertyType),
                    propertyType
                )
                EnforceInitOnlyAssignment(ifaceProp, receiver, syntax.EqualsToken.Location)
                return BoundPropertyAssignmentExpression(
                    nil,
                    receiver,
                    nil,
                    ifaceProp,
                    ifaceConverted,
                    if object.ReferenceEquals(propertyType, ifaceProp.Type) {
                        default(TypeSymbol?)
                    } else {
                        propertyType
                    },
                    effectiveInterface
                )
            }
            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName)
            return BoundErrorExpression(nil)
        }
        let tpReceiver TypeParameterSymbol? = receiverType as TypeParameterSymbol
        let clrInterfaceConstraint TypeSymbol? = tpReceiver?.ClrInterfaceConstraint
        let constraintClrType = clrInterfaceConstraint?.ClrType
        if tpReceiver != nil && clrInterfaceConstraint != nil && constraintClrType?.IsInterface == true {
            let clrProperty PropertyInfo? = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(
                constraintClrType,
                fieldName,
                BindingFlags.Public | BindingFlags.Instance
            )
            if clrProperty != nil && clrProperty.GetIndexParameters().Length == 0 {
                if clrProperty.GetSetMethod(nonPublic: false) == nil {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName)
                    return BoundErrorExpression(nil)
                }
                let propertyType = MemberLookup.GetClrPropertyTypeSymbol(clrInterfaceConstraint, clrProperty)
                let declaringInterface = MemberLookup.GetClrMemberDeclaringTypeSymbol(
                    clrInterfaceConstraint,
                    clrProperty
                )
                let constrainedConverted = conversions.BindConversion(
                    syntax.Value.Location,
                    BindValue(propertyType),
                    propertyType
                )
                return BoundClrPropertyAssignmentExpression(
                    nil,
                    receiver,
                    clrProperty,
                    constrainedConverted,
                    propertyType,
                    staticContainerType: nil,
                    constrainedReceiverTypeParameter: tpReceiver,
                    constrainedInterfaceType: declaringInterface
                )
            }
            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName)
            return BoundErrorExpression(nil)
        }
        // CLR receiver → property/field write via reflection.
        if CanBindClrInstanceMember(receiver) {
            let clrReceiverType = Invariant.Required(
                receiverType.ClrType,
                "a CLR member receiver has a CLR type",
                expression: "receiverType.ClrType"
            )
            var instanceMember MemberInfo? = SafeGetVisibleInstanceProperty(clrReceiverType, fieldName)
            if instanceMember is PropertyInfo propInfo && propInfo.GetIndexParameters().Length != 0 {
                instanceMember = nil
            }
            instanceMember ??= SafeGetVisibleInstanceField(clrReceiverType, fieldName)
            if instanceMember == nil {
                Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName)
                return BoundErrorExpression(nil)
            }
            if !TryGetWritableClrMember(
                instanceMember,
                receiverType,
                out var instTargetType,
                out var instTargetSymbol,
                out var instWritable
            ) ||
                RefCapabilities
                .IsReadOnlyValueReference(receiver) {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName)
                return BoundErrorExpression(nil)
            }
            receiver,
            instanceMember = RecoverDeclaredClrMemberWriteReceiver(
                receiver,
                syntax.FieldIdentifier.Location,
                instanceMember,
                syntax.Receiver.Location
            )
            // ADR-0156 Phase 2 (issue #3185): a chained write through a
            // prior-cell submission global (`a.B.C = v`) enforces the
            // read-only root and addressable-chain rules; non-submission
            // receivers are untouched.
            if ReportSubmissionGlobalMemberWriteBlocked(receiver, fieldName, syntax.EqualsToken.Location) {
                return BoundErrorExpression(syntax)
            }
            let instConverted = conversions.BindConversion(
                syntax.Value.Location,
                BindValue(instTargetSymbol!!),
                instTargetSymbol
            )
            return BoundClrPropertyAssignmentExpression(
                nil,
                receiver,
                instanceMember!!,
                instConverted,
                instTargetSymbol!!,
                staticContainerType: nil
            )
        }
        Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName)
        return BoundErrorExpression(nil)
    }

    private func RecoverDeclaredMemberWriteReceiver(
        receiver BoundExpression,
        location TextLocation,
        requiredType TypeSymbol,
        receiverLocation TextLocation? = nil
    ) BoundExpression {
        if !binderCtx.TryGetBackwardGotoNarrowingPath(receiver, out var path, out _) ||
            path!!.HasMembers ||
            path!!
            .Root
            .Type is NullableTypeSymbol ||
            !CanRecoverDeclaredMemberWriteReceiver(path!!.Root.Type, requiredType) {
            return receiver
        }
        UntrackDeclaredWriteReceiver(path!!, location, receiverLocation)
        return DeclaredReceiver(path!!.Root, receiver.Syntax)
    }

    // The receiver read (and its runtime-changing conversion) is recorded at
    // the receiver expression's span, while the member use is recorded at the
    // member token; a parenthesized or otherwise explicit receiver makes those
    // two spans differ, so untrack the conversion at both.
    private func UntrackDeclaredWriteReceiver(
        path AccessPath,
        memberLocation TextLocation,
        receiverLocation TextLocation?
    ) {
        binderCtx.UntrackBackwardGotoNarrowingConversion(path, memberLocation)
        if receiverLocation is {} receiverSpan {
            binderCtx.UntrackBackwardGotoNarrowingConversion(path, receiverSpan)
        }
        binderCtx.UntrackBackwardGotoNarrowingMemberUse(path, memberLocation)
    }

    private func BindPropertyAssignmentWithDeclaredReceiver(
        receiver BoundExpression,
        location TextLocation,
        selectedOwner StructSymbol,
        selectedProperty PropertySymbol,
        value BoundExpression,
        receiverLocation TextLocation? = nil
    ) BoundPropertyAssignmentExpression {
        if !TryGetDeclaredWriteReceiver(receiver, out var path) {
            return BoundPropertyAssignmentExpression(nil, receiver, selectedOwner, selectedProperty, value)
        }
        if TryResolveDeclaredPropertyWriteSlot(
            path!!.Root.Type,
            receiver.Type,
            selectedProperty,
            out var declaredProperty,
            out var declaredStructOwner,
            out var declaredInterfaceOwner
        ) {
            let recoveredReceiver = RecoverDeclaredWriteReceiver(receiver, path!!, location, receiverLocation)
            if declaredInterfaceOwner != nil {
                let substitutedType = declaredInterfaceOwner.SubstituteMemberType(declaredProperty!!.Type)
                return BoundPropertyAssignmentExpression(
                    nil,
                    recoveredReceiver,
                    nil,
                    declaredProperty!!,
                    value,
                    if object.ReferenceEquals(substitutedType, declaredProperty!!.Type) {
                        default(TypeSymbol?)
                    } else {
                        substitutedType
                    },
                    declaredInterfaceOwner
                )
            }
            return BoundPropertyAssignmentExpression(
                nil,
                recoveredReceiver,
                declaredStructOwner,
                declaredProperty!!,
                value
            )
        }
        return BoundPropertyAssignmentExpression(nil, receiver, selectedOwner, selectedProperty, value)
    }

    private func RecoverDeclaredPropertyWriteReceiver(
        receiver BoundExpression,
        location TextLocation,
        selectedProperty PropertySymbol,
        receiverLocation TextLocation? = nil
    ) BoundExpression {
        if !TryGetDeclaredWriteReceiver(receiver, out var path) ||
            !TryResolveDeclaredPropertyWriteSlot(
            path!!.Root.Type,
            receiver.Type,
            selectedProperty,
            out _,
            out _,
            out _
        ) {
            return receiver
        }
        return RecoverDeclaredWriteReceiver(receiver, path!!, location, receiverLocation)
    }

    private func TryResolveDeclaredPropertyWriteSlot(
        declaredType TypeSymbol,
        receiverType TypeSymbol,
        selectedProperty PropertySymbol,
        @NotNullWhen(true) out declaredProperty PropertySymbol?,
        out declaredStructOwner StructSymbol?,
        out declaredInterfaceOwner InterfaceSymbol?
    ) bool {
        if declaredType is StructSymbol structType && TypeMemberModel.TryGetProperty(
            structType,
            selectedProperty.Name,
            out declaredProperty,
            out declaredStructOwner
        ) &&
            SamePropertySlot(selectedProperty, declaredProperty!!, MemberOperation.Write, receiverType) &&
            object.Equals(declaredProperty!!.Type, selectedProperty.Type) {
            declaredInterfaceOwner = nil
            return true
        }
        if declaredType is InterfaceSymbol interfaceType && TypeMemberModel.TryGetPropertyWithOwner(
            interfaceType,
            selectedProperty.Name,
            out declaredProperty,
            out var declaredOwner
        ) &&
            declaredOwner is InterfaceSymbol interfaceOwner &&
            SamePropertySlot(
            selectedProperty,
            declaredProperty!!,
            MemberOperation.Write,
            receiverType,
            interfaceOwner
        ) {
            declaredStructOwner = nil
            declaredInterfaceOwner = interfaceOwner
            return true
        }
        declaredProperty = nil
        declaredStructOwner = nil
        declaredInterfaceOwner = nil
        return false
    }

    private func RecoverDeclaredClrMemberWriteReceiver(
        receiver BoundExpression,
        location TextLocation,
        selectedMember MemberInfo,
        receiverLocation TextLocation? = nil
    )(Receiver BoundExpression, Member MemberInfo) {
        if !TryGetDeclaredWriteReceiver(receiver, out var path) {
            return (receiver, selectedMember)
        }
        let declaredType = path!!.Root.Type
        let clrType Type? = declaredType.ClrType ??
            (
            if declaredType is StructSymbol structType {
                GetInheritedClrBaseType(structType)
            } else {
                default(Type?)
            }
        )
        if clrType == nil {
            return (receiver, selectedMember)
        }
        let declaredMember MemberInfo? = if selectedMember is PropertyInfo {
            (SafeGetVisibleInstanceProperty(clrType, selectedMember.Name) as MemberInfo?)
        } else {
            (SafeGetVisibleInstanceField(clrType, selectedMember.Name) as MemberInfo?)
        }
        return if declaredMember != nil && SameClrMemberSlot(selectedMember, declaredMember, MemberOperation.Write) {
            (RecoverDeclaredWriteReceiver(receiver, path!!, location, receiverLocation), declaredMember)
        } else {
            (receiver, selectedMember)
        }
    }

    private func TryGetDeclaredWriteReceiver(
        receiver BoundExpression,
        @NotNullWhen(true) out path AccessPath?
    ) bool -> binderCtx.TryGetBackwardGotoNarrowingPath(receiver, out path, out _) &&
        !path!!.HasMembers &&
        !(path!!.Root.Type is NullableTypeSymbol)

    private func RecoverDeclaredWriteReceiver(
        receiver BoundExpression,
        path AccessPath,
        location TextLocation,
        receiverLocation TextLocation? = nil
    ) BoundExpression {
        UntrackDeclaredWriteReceiver(path, location, receiverLocation)
        return DeclaredReceiver(path.Root, receiver.Syntax)
    }

    /// Issue #1559: binds a write to a static field or property reached through
    /// a constructed generic *type* receiver — `Foo[int32].x = v` (user
    /// class/struct), `IBox[int32].Field = v` (user interface), or an
    /// imported CLR generic. Exactly one of the constructed-type arguments is
    /// non-null (the receiver resolver picks the owner kind). The struct/class
    /// and interface paths carry the constructed symbol so the emitter parents
    /// the field/property reference at the correct `TypeSpec` (ADR-0087 /
    /// issue #1030 / issue #1209), giving each closed construction its own
    /// static storage. Mirrors the READ path in
    /// (cref:BindUserTypeStaticMemberAccess) and the non-generic static
    /// write in (cref:BindFieldAssignmentExpression).
    private func BindConstructedGenericStaticFieldWrite(
        syntax MemberFieldAssignmentExpressionSyntax,
        constructedStruct StructSymbol?,
        constructedInterface InterfaceSymbol?,
        constructedImported ImportedClassSymbol?
    ) BoundExpression {
        let fieldName = syntax.FieldIdentifier.ValueText
        var value BoundExpression? = nil
        let BindValue = func (targetType TypeSymbol) BoundExpression {
            return (
                if value == nil {
                    (value = BindAssignmentRhs(syntax.Value, targetType))
                } else {
                    value
                }
            )!!
        }
        // User class/struct → static field or static property write.
        if constructedStruct != nil {
            if TypeMemberModel.TryGetStaticFieldIncludingInherited(
                constructedStruct,
                fieldName,
                out var staticField,
                out var fieldOwner
            ) {
                if !AccessibilityChecker.IsAccessible(staticField.Accessibility, fieldOwner, function) {
                    Diagnostics.ReportMemberInaccessible(
                        syntax.FieldIdentifier.Location,
                        staticField.Name,
                        fieldOwner.Name,
                        staticField.Accessibility
                    )
                }
                if staticField.IsReadOnly {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName)
                }
                let fieldType = fieldOwner.SubstituteMemberType(staticField.Type)
                let staticConverted = conversions.BindConversion(
                    syntax.Value.Location,
                    BindValue(fieldType!!),
                    fieldType
                )
                return BoundFieldAssignmentExpression(nil, nil, fieldOwner, staticField, staticConverted, fieldType)
            }
            if TypeMemberModel.TryGetStaticPropertyIncludingInherited(
                constructedStruct,
                fieldName,
                out var prop,
                out var propertyOwner
            ) {
                if !AccessibilityChecker.IsAccessible(prop.SetterAccessibility, propertyOwner, function) {
                    Diagnostics.ReportMemberInaccessible(
                        syntax.FieldIdentifier.Location,
                        prop.Name,
                        propertyOwner.Name,
                        prop.SetterAccessibility
                    )
                }
                if !prop.HasSetter {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName)
                    return BoundErrorExpression(nil)
                }
                let propConverted = conversions.BindConversion(syntax.Value.Location, BindValue(prop.Type), prop.Type)
                return BoundPropertyAssignmentExpression(nil, receiver: nil, propertyOwner, prop, propConverted)
            }
            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName)
            return BoundErrorExpression(nil)
        }
        // User interface → static field write (per-construction storage).
        if constructedInterface != nil {
            let ownerDef = constructedInterface.Definition ?? constructedInterface
            let ifaceStaticField FieldSymbol? = ownerDef.GetStaticField(fieldName)
            if ifaceStaticField != nil {
                if ifaceStaticField.IsReadOnly || ifaceStaticField.IsConst {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName)
                }
                let fieldType = constructedInterface.SubstituteMemberType(ifaceStaticField.Type)
                let ifaceConverted = conversions.BindConversion(syntax.Value.Location, BindValue(fieldType), fieldType)
                return BoundFieldAssignmentExpression(
                    nil,
                    ifaceStaticField,
                    constructedInterface,
                    ifaceConverted,
                    fieldType
                )
            }
            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName)
            return BoundErrorExpression(nil)
        }
        // Imported CLR generic → static field/property write via reflection on
        // the closed construction (mirrors the non-generic imported-class write
        // in BindFieldAssignmentExpression).
        if constructedImported != nil && constructedImported.TryLookupMember(
            fieldName,
            ne: nil,
            out var staticMember
        ) &&
            TryGetWritableClrMember(staticMember, out _, out var staticTargetSymbol, out _) {
            let staticConverted = conversions.BindConversion(
                syntax.Value.Location,
                BindValue(staticTargetSymbol!!),
                staticTargetSymbol
            )
            return BoundClrPropertyAssignmentExpression(
                nil,
                receiver: nil,
                staticMember!!,
                staticConverted,
                staticTargetSymbol!!,
                staticContainerType: constructedImported.SymbolicReceiver
            )
        }
        Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName)
        return BoundErrorExpression(nil)
    }

    private func BindCompoundIndexAssignmentExpression(syntax CompoundIndexAssignmentExpressionSyntax) BoundExpression {
        if syntax.Target.IsNullConditional {
            // ADR-0073 / issue #710: reject `a?[i] op= v` for the same reason
            // we reject `a?[i] = v` — the null-conditional indexer cannot be
            // an assignment target.
            Diagnostics.ReportNullConditionalIndexAssignmentTarget(syntax.Target.OpenBracketToken.Location)
            return BoundErrorExpression(syntax)
        }
        if syntax.Target.Indices.Count > 1 {
            return BindRectangularCompoundIndexAssignment(syntax)
        }
        return BindIndexedWriteThroughChain(
            chainBase: nil,
            remainingChain: syntax.Target.Target,
            indexSyntax: syntax.Target.Index,
            valueSyntax: nil,
            boundValueOverride: nil,
            compoundOperatorToken: syntax.OperatorToken,
            compoundRhsSyntax: syntax.Value,
            diagnosticLocation: syntax.OperatorToken.Location,
            outerSyntax: syntax
        )
    }

    private func BindRectangularCompoundIndexAssignment(
        syntax CompoundIndexAssignmentExpressionSyntax
    ) BoundExpression {
        let target = BindExpression(syntax.Target.Target)
        let rectangular RectangularArrayTypeSymbol? = GetRectangularArrayTypeForBinding(target.Type)
        // ADR-0187 / issue #4350: `t[a, b] op= v` over a multi-parameter user
        // indexer reads and writes the same selected indexer, evaluating the
        // receiver and each index argument once; a postfix `t[a, b]++`
        // yields the element's previous value.
        if rectangular == nil && SyntaxFacts.TryGetCompoundAssignmentBaseOperator(
            syntax.OperatorToken.Kind,
            out var userBaseOperator
        ) {
            let userAssignment BoundExpression? = TryBindMultiIndexUserAssignment(
                target,
                syntax.Target.Indices,
                func (elementType TypeSymbol, readCurrent() -> BoundExpression) BoundExpression {
                    let current = readCurrent()
                    let rhs = BindExpression(syntax.Value)
                    if rhs is BoundErrorExpression || rhs.Type == TypeSymbol.Error {
                        return BoundErrorExpression(syntax)
                    }
                    let combined BoundExpression? = TryBindCompoundBinaryOperation(
                        userBaseOperator,
                        current,
                        rhs,
                        syntax.Value.Location
                    )
                    if combined == nil {
                        Diagnostics.ReportUndefinedBinaryOperator(
                            syntax.OperatorToken.Location,
                            syntax.OperatorToken.Text,
                            elementType,
                            rhs.Type
                        )
                        return BoundErrorExpression(syntax)
                    }
                    return combined
                },
                (ignoredElementType TypeSymbol) -> {
                    let _ = BindExpression(syntax.Value)
                },
                syntax.Target.Target.Location,
                requiresRead: true,
                syntax.ReturnsPreviousValue
            )
            if userAssignment != nil {
                return userAssignment
            }
        }
        if rectangular == nil {
            Diagnostics.ReportTypeNotIndexable(syntax.Target.Target.Location, target.Type)
            return BoundErrorExpression(syntax)
        }
        if syntax.Target.Indices.Count != rectangular.Rank {
            Diagnostics.ReportRectangularArrayIndexRankMismatch(
                syntax.Target.Target.Location,
                rectangular.Rank,
                syntax.Target.Indices.Count
            )
            return BoundErrorExpression(syntax)
        }
        if !SyntaxFacts.TryGetCompoundAssignmentBaseOperator(syntax.OperatorToken.Kind, out var baseOperator) {
            return BoundErrorExpression(syntax)
        }
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let targetLocal = DeclareRangeTemp("array", target.Type, target, statements)
        let targetReference = BoundVariableExpression(nil, targetLocal)
        let indices = ImmutableArray.CreateBuilder[BoundExpression](rectangular.Rank)
        for indexSyntax in syntax.Target.Indices {
            let index = BindRectangularArrayElementIndex(indexSyntax)
            let indexLocal = DeclareRangeTemp("index", index.Type, index, statements)
            indices.Add(BoundVariableExpression(nil, indexLocal))
        }
        let capturedIndices = indices.MoveToImmutable()
        var read BoundExpression = BoundIndexExpression(
            syntax.Target,
            targetReference,
            capturedIndices,
            rectangular.ElementType
        )
        let compoundTarget = read
        let previousValue = CapturePostfixCompoundValue(
            syntax.ReturnsPreviousValue,
            syntax,
            &read,
            out var previousDeclaration
        )
        let rhs = BindExpression(syntax.Value)
        if rhs is BoundErrorExpression || rhs.Type == TypeSymbol.Error {
            return BoundErrorExpression(syntax)
        }
        let userCompound BoundExpression? = TryBindUserCompoundAssignmentOperator(
            syntax.OperatorToken.Kind,
            compoundTarget,
            rhs,
            syntax.Value.Location
        )
        if userCompound != nil {
            return FinishUserCompoundIncrement(
                syntax,
                syntax.ReturnsPreviousValue,
                syntax.IsIncrementDecrement,
                compoundTarget,
                userCompound,
                previousDeclaration,
                previousValue,
                statements
            )
        }
        let combined BoundExpression? = TryBindCompoundBinaryOperation(baseOperator, read, rhs, syntax.Value.Location)
        if combined == nil {
            Diagnostics.ReportUndefinedBinaryOperator(
                syntax.OperatorToken.Location,
                syntax.OperatorToken.Text,
                rectangular.ElementType,
                rhs.Type
            )
            return BoundErrorExpression(syntax)
        }
        let converted = conversions.BindConversion(syntax.Value.Location, combined, rectangular.ElementType)
        let assignment = BoundIndexAssignmentExpression.WithExpressionTarget(
            syntax,
            targetReference,
            capturedIndices,
            converted,
            rectangular.ElementType
        )
        return FinishPostfixCompoundAssignment(syntax, statements, previousDeclaration, previousValue, assignment)
    }

    private func BindPropertyUserCompoundIncrement(
        syntax EventSubscriptionExpressionSyntax,
        propertyTarget BoundExpression,
        boundRhs BoundExpression
    ) BoundExpression {
        var propertyTarget = propertyTarget
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let receiver BoundExpression? = switch propertyTarget {
            case source is BoundPropertyAccessExpression: source.Receiver
            case imported is BoundClrPropertyAccessExpression: imported.Receiver
            default: default(BoundExpression?)
        }
        if receiver != nil && TrySavePostfixReceiver(syntax, receiver, out var savedReceiver, out var receiverPrefix) {
            statements.AddRange(receiverPrefix)
            propertyTarget = switch propertyTarget {
                case source is BoundPropertyAccessExpression: cast[BoundExpression](
                    BoundPropertyAccessExpression(
                        source.Syntax,
                        savedReceiver,
                        source.StructType,
                        source.Property,
                        source.SubstitutedType,
                        source.NarrowedType,
                        source.InterfaceType
                    )
                )
                case imported is BoundClrPropertyAccessExpression: cast[BoundExpression](
                    BoundClrPropertyAccessExpression(
                        imported.Syntax,
                        savedReceiver,
                        imported.Member,
                        imported.Type,
                        imported.StaticContainerType,
                        imported.ConstrainedReceiverTypeParameter,
                        imported.ConstrainedInterfaceType
                    )
                )
                default: propertyTarget
            }
        }
        var stableTarget BoundExpression
        let needsWriteBack = ReflectionMetadataEmitter.IsValueTypeSymbol(propertyTarget.Type) &&
            !IsLvalue(propertyTarget)
        if !needsWriteBack && IsLvalue(propertyTarget) && !RefCapabilities.IsReadOnlyReference(propertyTarget) {
            let pointer = BoundAddressOfExpression(propertyTarget.Syntax, propertyTarget)
            let address = DeclareRangeTemp("incrementPropertyAddress", pointer.Type, pointer, statements)
            stableTarget = BoundDereferenceExpression(propertyTarget.Syntax, BoundVariableExpression(nil, address))
        } else {
            let name = "<incrementTarget${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
            let target = LocalVariableSymbol(name, isReadOnly: false, propertyTarget.Type)
            if !$scope.TryDeclareVariable(target) {
                throw InvalidOperationException("Failed to declare synthesized increment target local '$name'.")
            }
            statements.Add(BoundVariableDeclaration(syntax, target, propertyTarget))
            stableTarget = BoundVariableExpression(nil, target)
        }
        var writeBack BoundExpression? = nil
        if needsWriteBack {
            writeBack = switch propertyTarget {
                case source is BoundPropertyAccessExpression when source
                    .Property
                    .HasSetter: cast[BoundExpression](
                    BoundPropertyAssignmentExpression(
                        syntax,
                        source.Receiver,
                        source.StructType,
                        source.Property,
                        stableTarget,
                        source.SubstitutedType,
                        source.InterfaceType
                    )
                )
                case BoundClrPropertyAccessExpression{
                    Member: PropertyInfo property
                } imported when property.SetMethod != nil: cast[BoundExpression](
                    BoundClrPropertyAssignmentExpression(
                        syntax,
                        imported.Receiver,
                        property,
                        stableTarget,
                        imported.Type,
                        imported.StaticContainerType,
                        imported.ConstrainedReceiverTypeParameter,
                        imported.ConstrainedInterfaceType
                    )
                )
                default: nil
            }
            if writeBack == nil {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, syntax.LeftHandSide.ToString())
                return BoundErrorExpression(syntax)
            }
        }
        var previousValue BoundVariableExpression? = nil
        var previousDeclaration BoundVariableDeclaration? = nil
        if syntax.ReturnsPreviousValue {
            var previousRead = stableTarget
            previousValue = CapturePostfixCompoundValue(
                returnsPreviousValue: true,
                syntax,
                &previousRead,
                out previousDeclaration
            )
        }
        let userCompound = Invariant.Required(
            TryBindUserCompoundAssignmentOperator(
                syntax.OperatorToken.Kind,
                stableTarget,
                boundRhs,
                syntax.Value.Location
            ),
            "a property compound operator resolved before increment target capture",
            expression: `TryBindUserCompoundAssignmentOperator(
                syntax.OperatorToken.Kind,
                stableTarget,
                boundRhs,
                syntax.Value.Location)`
        )
        if writeBack != nil {
            if previousDeclaration != nil {
                statements.Add(previousDeclaration)
            }
            statements.Add(BoundExpressionStatement(syntax, userCompound))
            if previousValue != nil {
                statements.Add(BoundExpressionStatement(syntax, writeBack))
                return BoundBlockExpression(syntax, statements.ToImmutable(), previousValue)
            }
            return BoundBlockExpression(syntax, statements.ToImmutable(), writeBack)
        }
        if syntax.ReturnsPreviousValue {
            return FinishPostfixCompoundAssignment(syntax, statements, previousDeclaration, previousValue, userCompound)
        }
        statements.Add(BoundExpressionStatement(syntax, userCompound))
        return BoundBlockExpression(syntax, statements.ToImmutable(), stableTarget)
    }

    private func CapturePostfixCompoundValue(
        returnsPreviousValue bool,
        syntax SyntaxNode,
        ref read BoundExpression,
        out declaration BoundVariableDeclaration?
    ) BoundVariableExpression? {
        declaration = nil
        if !returnsPreviousValue {
            return nil
        }
        let name = "<postfix${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
        let variable = LocalVariableSymbol(name, isReadOnly: true, read.Type)
        if !$scope.TryDeclareVariable(variable) {
            throw InvalidOperationException("Failed to declare synthesized postfix value local '$name'.")
        }
        declaration = BoundVariableDeclaration(syntax, variable, read)
        let captured = BoundVariableExpression(nil, variable)
        read = captured
        return captured
    }

    private func TrySavePostfixReceiver(
        syntax EventSubscriptionExpressionSyntax,
        receiver BoundExpression,
        out savedReceiver BoundExpression,
        out prefix ImmutableArray[BoundStatement]
    ) bool {
        savedReceiver = receiver
        prefix = ImmutableArray[BoundStatement].Empty
        if !syntax.IsIncrementDecrement ||
            receiver is BoundVariableExpression ||
            receiver is BoundDereferenceExpression &&
            receiver.Operand is BoundVariableExpression {
            return false
        }
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        if Binder.IsReferenceTypeForConstraint(receiver.Type) {
            let saved = DeclareRangeTemp("receiver", receiver.Type, receiver, statements)
            savedReceiver = BoundVariableExpression(receiver.Syntax, saved)
        } else {
            if !IsWritableStructFieldReceiver(receiver) || RefCapabilities.IsReadOnlyReference(receiver) {
                return false
            }
            let pointer = BoundAddressOfExpression(receiver.Syntax, receiver)
            let saved = DeclareRangeTemp("receiverAddress", pointer.Type, pointer, statements)
            savedReceiver = BoundDereferenceExpression(receiver.Syntax, BoundVariableExpression(nil, saved))
        }
        prefix = statements.ToImmutable()
        return true
    }

    /// ADR-0156 Phase 2: binds a bare simple write (`name = value`) to a
    /// top-level global declared by a prior interactive submission as a store
    /// to the static field on that submission's `<Program>`
    /// container, newest submission first. Read-only (`let`) globals —
    /// known from the submission's source-side scope, since the emitted field
    /// intentionally omits `InitOnly` — report GS0203.
    /// @param name The bare identifier being assigned.
    /// @param valueSyntax The right-hand-side expression syntax.
    /// @param operatorLocation The assignment operator's location for diagnostics.
    /// @param result The bound assignment, when the name matched a prior submission's global.
    /// @returns `true` when a prior submission declared the global.
    private func TryBindSubmissionStaticFieldWrite(
        name string,
        valueSyntax ExpressionSyntax,
        operatorLocation TextLocation,
        out result BoundExpression?
    ) bool {
        result = nil
        let submissionImports SubmissionImports? = $scope.SubmissionImports
        if submissionImports == nil || !submissionImports.TryFindGlobalVariable(
            $scope.References!!,
            name,
            out var programType,
            out var declared
        ) ||
            programType is not{} resolvedProgramType ||
            declared is not{} resolvedDeclared {
            return false
        }
        let classSymbol = ImportedClassSymbol(resolvedProgramType, declaration: nil, references: $scope.References)
        if !classSymbol.TryLookupMember(name, ne: nil, out var member) ||
            !TryGetWritableClrMember(member, out _, out var targetSymbol, out _) {
            Diagnostics.ReportCannotAssign(operatorLocation, name)
            result = BoundErrorExpression(nil)
            return true
        }
        if resolvedDeclared.IsReadOnly {
            Diagnostics.ReportCannotAssign(operatorLocation, name)
        }
        // Issue #3308: the writable-member probe reports the field's CLR
        // projection; reverse-project magic wrapper kinds (chan/slice/fixed
        // array) so the RHS converts against the same symbolic type the
        // declaring cell assigned under (e.g. `ch = make(chan int32, 2)`).
        if member is FieldInfo globalField {
            targetSymbol = SubmissionGlobalTypeProjection.ReverseProject(
                targetSymbol!!,
                globalField.FieldType,
                resolvedDeclared.Type,
                $scope.References!!
            )
        }
        let value = BindAssignmentRhs(valueSyntax, targetSymbol)
        let converted = conversions.BindConversion(valueSyntax.Location, value, targetSymbol)
        result = BoundClrPropertyAssignmentExpression(
            nil,
            receiver: nil,
            member!!,
            converted,
            targetSymbol!!,
            staticContainerType: nil
        )
        return true
    }

    /// ADR-0156 Phase 2: binds a bare compound write (`name op= value`)
    /// to a top-level global declared by a prior interactive submission as a
    /// read-modify-store of the static field on that submission's
    /// `<Program>` container, newest submission first.
    /// @param name The bare identifier being assigned.
    /// @param bareName The identifier's name-expression syntax (for the read half).
    /// @param syntax The compound assignment syntax.
    /// @param result The bound assignment, when the name matched a prior submission's global.
    /// @returns `true` when a prior submission declared the global.
    private func TryBindSubmissionStaticFieldCompound(
        name string,
        bareName NameExpressionSyntax,
        syntax EventSubscriptionExpressionSyntax,
        out result BoundExpression?
    ) bool {
        result = nil
        let submissionImports SubmissionImports? = $scope.SubmissionImports
        if submissionImports == nil || !submissionImports.TryFindGlobalVariable(
            $scope.References!!,
            name,
            out var programType,
            out var declared
        ) ||
            programType is not{} resolvedProgramType ||
            declared is not{} resolvedDeclared {
            return false
        }
        let classSymbol = ImportedClassSymbol(resolvedProgramType, declaration: nil, references: $scope.References)
        if !classSymbol.TryLookupMember(name, ne: nil, out var member) ||
            !TryGetWritableClrMember(member, out _, out var targetSymbol, out _) {
            Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name)
            result = BoundErrorExpression(nil)
            return true
        }
        if resolvedDeclared.IsReadOnly {
            Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name)
        }
        // Read half: bind the same bare name through the submission member
        // read fallback so the leftExpr is the field load.
        if !TryBindSubmissionStaticMember(bareName, out var boundLeft) {
            return false
        }
        let compoundTarget = boundLeft!!
        var leftExpr = compoundTarget
        let previousValue = CapturePostfixCompoundValue(
            syntax.ReturnsPreviousValue,
            syntax,
            &leftExpr,
            out var previousDeclaration
        )
        let boundRhs = BindExpression(syntax.Value)
        SyntaxFacts.TryGetCompoundAssignmentBaseOperator(syntax.OperatorToken.Kind, out var baseOpSyntaxKind)
        let userCompound BoundExpression? = TryBindUserCompoundAssignmentOperator(
            syntax.OperatorToken.Kind,
            compoundTarget,
            boundRhs,
            syntax.Value.Location
        )
        if userCompound != nil {
            result = FinishUserCompoundIncrement(
                syntax,
                compoundTarget,
                userCompound,
                previousDeclaration,
                previousValue
            )
            return true
        }
        let binaryResult BoundExpression? = TryBindCompoundBinaryOperation(
            baseOpSyntaxKind,
            leftExpr,
            boundRhs,
            syntax.Value.Location
        )
        if binaryResult == nil {
            Diagnostics.ReportUndefinedBinaryOperator(
                syntax.OperatorToken.Location,
                syntax.OperatorToken.Text,
                leftExpr.Type,
                boundRhs.Type
            )
            result = BoundErrorExpression(nil)
            return true
        }
        let converted = conversions.BindConversion(syntax.Value.Location, binaryResult, targetSymbol)
        let assignment = BoundClrPropertyAssignmentExpression(
            nil,
            receiver: nil,
            member!!,
            converted,
            targetSymbol!!,
            staticContainerType: nil
        )
        result = FinishPostfixCompoundAssignment(syntax, previousDeclaration, previousValue, assignment)
        return true
    }

    /// ADR-0156 Phase 2 (issue #3251): binds a bare indexed write
    /// (`name[i] = v`) whose target is a top-level global declared by a
    /// prior interactive submission. The receiver is bound through the shared
    /// bare-identifier read fallback ((cref:TryBindSubmissionStaticMember),
    /// which applies the issue #3185 addressable-static-field marking) into a
    /// synthesized temp local, then the ordinary indexed write targets the
    /// temp — for a map / array / slice global the temp holds the reference,
    /// so the store mutates the stored global. This is the same
    /// temp-receiver shape the compound chain path
    /// (`BindIndexedWriteThroughChain`) and the same-cell static-field
    /// path ((cref:ImplicitStaticFieldVariableSymbol)) already use, so
    /// simple and compound indexed writes stay in lockstep.
    /// @param syntax The `name[index] = value` assignment syntax.
    /// @param result The bound assignment when the target named a prior submission's global.
    /// @returns `true` when a prior submission declared the global (and the current cell does not shadow
    /// it).
    private func TryBindSubmissionGlobalIndexAssignment(
        syntax IndexAssignmentExpressionSyntax,
        out result BoundExpression?
    ) bool {
        result = nil
        let submissionImports SubmissionImports? = $scope.SubmissionImports
        let name = syntax.TargetIdentifier.ValueText
        if submissionImports == nil || !submissionImports.TryFindGlobalVariable(
            $scope.References!!,
            name,
            out _,
            out _
        ) {
            return false
        }
        // The current cell's own declarations shadow prior cells (newest
        // declaration wins regardless of kind): when the name resolves to any
        // same-cell symbol, keep the regular path's diagnostics.
        if $scope.TryLookupSymbol(name) != nil {
            return false
        }
        let nameSyntax = NameExpressionSyntax(syntax.SyntaxTree, syntax.TargetIdentifier)
        if !TryBindSubmissionStaticMember(nameSyntax, out var receiver) ||
            receiver is BoundErrorExpression ||
            receiver!!.Type == TypeSymbol.Error {
            return false
        }
        let tempName = "<idxAsn${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
        let tempVar = LocalVariableSymbol(tempName, isReadOnly: true, receiver!!.Type)
        $scope.TryDeclareVariable(tempVar)
        let declaration = BoundVariableDeclaration(syntax, tempVar, receiver)
        let assignment = BindIndexedAssignmentToVariable(
            tempVar,
            syntax.Index,
            syntax.Value,
            syntax.TargetIdentifier.Location
        )
        if assignment is BoundErrorExpression {
            result = assignment
            return true
        }
        result = BoundBlockExpression(syntax, ImmutableArray.Create[BoundStatement](declaration), assignment)
        return true
    }

    /// ADR-0156 Phase 2 (issue #3185): binds a member write
    /// (`name.Member = value`) where `name` is a top-level global
    /// declared by a prior interactive submission. The receiver is the
    /// submission's static field marked addressable, so the emitter stores
    /// through the field's address (`ldsflda`) for a struct-typed global
    /// (mutating the stored global in place, mirroring the same-cell
    /// global-variable write) and through the object reference for a
    /// class-typed global. A read-only (`let`) value-typed global
    /// rejects the write with the same diagnostic the local-variable rule
    /// (issue #1132) produces.
    /// @param syntax The `name.field = value` assignment syntax.
    /// @param result The bound assignment when the receiver named a prior submission's global.
    /// @returns `true` when a prior submission declared the global (and the current cell does not shadow
    /// it).
    private func TryBindSubmissionGlobalMemberAssignment(
        syntax FieldAssignmentExpressionSyntax,
        out result BoundExpression?
    ) bool {
        result = nil
        let submissionImports SubmissionImports? = $scope.SubmissionImports
        let name = syntax.Receiver.Text
        if submissionImports == nil || !submissionImports.TryFindGlobalVariable(
            $scope.References!!,
            name,
            out var programType,
            out var declared
        ) ||
            programType is not{} resolvedProgramType ||
            declared is not{} resolvedDeclared {
            return false
        }
        // The current cell's own declarations shadow prior cells: when the
        // receiver name resolves as a variable in this compilation, the
        // regular variable path below must bind it.
        if BindVariableReference(
            name,
            syntax.Receiver.Location,
            suppressNotAVariable: true,
            suppressUndefinedVariable: true
        ) != nil {
            return false
        }
        let container = ImportedClassSymbol(resolvedProgramType, declaration: nil, references: $scope.References)
        if !container.TryLookupMember(name, ne: nil, out var globalMember) ||
            globalMember is not FieldInfo globalField {
            return false
        }
        let globalType = ClrNullability.GetFieldTypeSymbol(globalField)
        if globalType?.ClrType == nil {
            return false
        }
        let receiver = BoundClrPropertyAccessExpression(
            nil,
            receiver: nil,
            globalField,
            globalType,
            isAddressableStaticField: true,
            isReadOnlySubmissionGlobal: resolvedDeclared.IsReadOnly
        )
        let clrReceiverType = globalType.ClrType
        let memberName = syntax.FieldIdentifier.ValueText
        var instanceMember MemberInfo? = SafeGetVisibleInstanceProperty(clrReceiverType!!, memberName)
        if instanceMember is PropertyInfo indexedProperty && indexedProperty.GetIndexParameters().Length != 0 {
            instanceMember = nil
        }
        instanceMember ??= SafeGetVisibleInstanceField(clrReceiverType!!, memberName)
        if instanceMember == nil {
            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, memberName)
            result = BoundErrorExpression(nil)
            return true
        }
        if !TryGetWritableClrMember(instanceMember, globalType, out _, out var targetSymbol, out _) {
            Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, memberName)
            result = BoundErrorExpression(nil)
            return true
        }
        // Issue #1132's read-only rule, mirrored for a prior-cell global: a
        // member write through a `let` VALUE-typed global would mutate the
        // value stored in the read-only binding — reject it. A class-typed
        // `let` global mutates the heap object and stays writable.
        if declared?.IsReadOnly == true && !ReceiverTypeIsReference(globalType) {
            Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name)
        }
        let value = BindAssignmentRhs(syntax.Value, targetSymbol)
        let converted = conversions.BindConversion(syntax.Value.Location, value, targetSymbol)
        result = BoundClrPropertyAssignmentExpression(
            nil,
            receiver,
            instanceMember,
            converted,
            targetSymbol!!,
            staticContainerType: nil
        )
        return true
    }

    /// Issue #3185: applies the gated submission-global diagnostics to a
    /// CLR member write (simple or compound) through a possibly
    /// submission-rooted receiver chain. Reports the read-only rejection
    /// (report-and-continue, mirroring issue #1132's handling) or the
    /// struct-temporary rejection (blocking — emitting it would silently
    /// write a copy, the exact wrong-value class ADR-0156 exists to kill).
    /// A non-submission receiver never produces a diagnostic here.
    /// @param receiver The bound member-write receiver.
    /// @param memberName The written member's name (for diagnostics).
    /// @param location The assignment operator's location.
    /// @returns `true` when the write must be blocked (caller returns an error expression).
    private func ReportSubmissionGlobalMemberWriteBlocked(
        receiver BoundExpression,
        memberName string,
        location TextLocation
    ) bool {
        switch ClassifySubmissionGlobalWriteReceiver(receiver) {
            case SubmissionWriteReceiverKind.ReadOnlyRoot {
                Diagnostics.ReportCannotAssign(location, memberName)
                return false
            }
            case SubmissionWriteReceiverKind.NotAddressable {
                Diagnostics.ReportFieldAssignmentThroughStructTemporary(location, memberName, receiver.Type)
                return true
            }
            default {
                return false
            }
        }
    }

    shared {
        /// Issue #1316: resolves the declared type of a simple-assignment target so
        /// it can be threaded into the RHS binder as the expected type. Mirrors the
        /// per-form types used by the conversions below: an implicit field/property
        /// write uses the member's type; any other writable variable uses its own
        /// declared type.
        /// @param variable The resolved assignment-target symbol.
        /// @returns The target's declared type, or `null` when unknown.
        private func GetAssignmentTargetType(variable VariableSymbol) TypeSymbol? {
            return switch variable {
                case implicitField is ImplicitFieldVariableSymbol: implicitField.Field.Type
                case implicitStaticField is ImplicitStaticFieldVariableSymbol: implicitStaticField.Field.Type
                case implicitStaticProp is ImplicitStaticPropertyVariableSymbol: implicitStaticProp.Property.Type
                case implicitProp is ImplicitPropertyVariableSymbol: implicitProp.Property.Type
                default: variable?.Type
            }
        }

        /// Issue #1132: returns `true` when the receiver
        /// [`type`](paramref) of a dotted member write is a reference type, in
        /// which case mutating one of its members mutates the heap object rather
        /// than the (possibly read-only) binding. A nullable reference type is
        /// unwrapped first so a smart-cast / annotated reference receiver is also
        /// treated as a reference, while a nullable value type (`int32?`) stays
        /// a value type and remains rejected.
        /// @param type The receiver variable's type.
        /// @returns `true` when the receiver is a reference type.
        private func ReceiverTypeIsReference(type TypeSymbol) bool {
            let underlying = if type is NullableTypeSymbol nullable {
                nullable.UnderlyingType
            } else {
                type
            }
            return Binder.IsReferenceTypeForConstraint(underlying)
        }

        private func SourceValueMemberPrecedesInheritedEvent(type StructSymbol, name string) bool {
            for level in type.GetHierarchy() {
                if level.Events.Any((candidate EventSymbol) -> candidate.Name == name) {
                    return false
                }
                if level.TryGetField(name, out _) || level.Properties.Any(
                    (candidate PropertySymbol) -> !candidate.IsIndexer && candidate.Name == name
                ) {
                    return true
                }
            }
            return false
        }

        private func SourceStaticValueMemberPrecedesInheritedEvent(type StructSymbol, name string) bool {
            for level in type.GetHierarchy() {
                if TypeMemberModel.TryGetStaticEvent(level, name, out _) {
                    return false
                }
                if level.TryGetStaticField(name, out _) || TypeMemberModel.TryGetStaticProperty(level, name, out _) {
                    return true
                }
            }
            return false
        }

        internal func CanRecoverDeclaredMemberWriteReceiver(
            declaredType TypeSymbol,
            requiredType TypeSymbol
        ) bool -> Conversion.IsRepresentationPreservingImplicit(declaredType, requiredType)

        private func FinishUserCompoundIncrement(
            syntax SyntaxNode,
            returnsPreviousValue bool,
            isIncrementDecrement bool,
            target BoundExpression,
            userCompound BoundExpression,
            previousDeclaration BoundVariableDeclaration?,
            previousValue BoundVariableExpression?
        ) BoundExpression {
            if returnsPreviousValue {
                return FinishPostfixCompoundAssignment(syntax, previousDeclaration, previousValue, userCompound)
            }
            if !isIncrementDecrement {
                return userCompound
            }
            return BoundBlockExpression(
                syntax,
                ImmutableArray.Create[BoundStatement](BoundExpressionStatement(syntax, userCompound)),
                target
            )
        }

        private func FinishUserCompoundIncrement(
            syntax SyntaxNode,
            returnsPreviousValue bool,
            isIncrementDecrement bool,
            target BoundExpression,
            userCompound BoundExpression,
            previousDeclaration BoundVariableDeclaration?,
            previousValue BoundVariableExpression?,
            statements ImmutableArray[BoundStatement].Builder
        ) BoundExpression {
            if returnsPreviousValue {
                return FinishPostfixCompoundAssignment(
                    syntax,
                    statements,
                    previousDeclaration,
                    previousValue,
                    userCompound
                )
            }
            if !isIncrementDecrement {
                return BoundBlockExpression(syntax, statements.ToImmutable(), userCompound)
            }
            statements.Add(BoundExpressionStatement(syntax, userCompound))
            return BoundBlockExpression(syntax, statements.ToImmutable(), target)
        }

        private func FinishUserCompoundIncrement(
            syntax EventSubscriptionExpressionSyntax,
            target BoundExpression,
            userCompound BoundExpression,
            previousDeclaration BoundVariableDeclaration?,
            previousValue BoundVariableExpression?
        ) BoundExpression -> FinishUserCompoundIncrement(
            syntax,
            syntax.ReturnsPreviousValue,
            syntax.IsIncrementDecrement,
            target,
            userCompound,
            previousDeclaration,
            previousValue
        )

        private func FinishPostfixCompoundAssignment(
            syntax SyntaxNode,
            statements ImmutableArray[BoundStatement].Builder,
            previousDeclaration BoundVariableDeclaration?,
            previousValue BoundVariableExpression?,
            assignment BoundExpression
        ) BoundExpression {
            if previousDeclaration == nil || previousValue == nil {
                return BoundBlockExpression(syntax, statements.ToImmutable(), assignment)
            }
            statements.Add(previousDeclaration)
            statements.Add(BoundExpressionStatement(syntax, assignment))
            return BoundBlockExpression(syntax, statements.ToImmutable(), previousValue)
        }

        private func FinishPostfixCompoundAssignment(
            syntax SyntaxNode,
            previousDeclaration BoundVariableDeclaration?,
            previousValue BoundVariableExpression?,
            assignment BoundExpression
        ) BoundExpression {
            if previousDeclaration == nil || previousValue == nil {
                return assignment
            }
            return BoundBlockExpression(
                syntax,
                ImmutableArray.Create[BoundStatement](
                    previousDeclaration,
                    BoundExpressionStatement(syntax, assignment)
                ),
                previousValue
            )
        }

        /// Issue #3185: classifies a member-write receiver against the
        /// submission-global chain rules. Walks CLR member-access links from the
        /// receiver down to the chain root; only a chain that bottoms out at an
        /// addressable submission static field classifies as anything but
        /// (cref:SubmissionWriteReceiverKind.None). Crossing a
        /// reference-typed link makes the remaining chain heap-rooted (writable
        /// regardless of the root's read-only flag); crossing a computed
        /// (property) link makes an in-place write impossible. Issue #3252 /
        /// issue #3292: a value-typed ELEMENT link classifies by its storage —
        /// an array-backed element (`ps[0]` over an array or slice) has a
        /// real address (`ldelema`) and is
        /// (cref:SubmissionWriteReceiverKind.Addressable), while a
        /// map/indexer element (`m[k]` — the getter returns a copy) is
        /// (cref:SubmissionWriteReceiverKind.NotAddressable), matching
        /// the GS0499 rejection the identical same-cell shape reports.
        /// @param receiver The bound member-write receiver.
        /// @returns The chain classification.
        private func ClassifySubmissionGlobalWriteReceiver(receiver BoundExpression?) SubmissionWriteReceiverKind {
            if receiver == nil || ReceiverTypeIsReference(receiver.Type) {
                return SubmissionWriteReceiverKind.None
            }
            // Issue #3252: the receiver IS an element load (`ps[0].X = v`).
            // Issue #3292: an array-backed element has a real address
            // (`ldelema`), so the write reaches the stored element in place —
            // crossing the element link is heap-rooted, so the root's read-only
            // flag no longer applies (same rule as a reference-typed link). An
            // indexer/map element load stays a struct temporary.
            if TryGetElementAccessTarget(receiver, out var elementCollection) &&
                elementCollection is {} resolvedElementCollection {
                if !ChainHasSubmissionGlobalRoot(resolvedElementCollection) {
                    return SubmissionWriteReceiverKind.None
                }
                return if IsAddressableElementLoad(receiver) {
                    SubmissionWriteReceiverKind.Addressable
                } else {
                    SubmissionWriteReceiverKind.NotAddressable
                }
            }
            var access BoundClrPropertyAccessExpression? = receiver as BoundClrPropertyAccessExpression
            if access == nil {
                return SubmissionWriteReceiverKind.None
            }
            var sawComputedLink = false
            while true {
                if access.Receiver == nil {
                    if !access.IsAddressableStaticField {
                        return SubmissionWriteReceiverKind.None
                    }
                    if access.IsReadOnlySubmissionGlobal {
                        return SubmissionWriteReceiverKind.ReadOnlyRoot
                    }
                    return if sawComputedLink {
                        SubmissionWriteReceiverKind.NotAddressable
                    } else {
                        SubmissionWriteReceiverKind.Addressable
                    }
                }
                if !(access.Member is FieldInfo) {
                    sawComputedLink = true
                }
                if ReceiverTypeIsReference(access.Receiver.Type) {
                    // Heap-rooted from here on: the write mutates the referenced
                    // object, so the root's read-only flag no longer applies —
                    // but the value-typed links walked so far must all have been
                    // real fields for the address chain to reach the storage.
                    if access.Receiver is BoundClrPropertyAccessExpression referenceLink &&
                        ChainHasSubmissionGlobalRoot(referenceLink) {
                        return if sawComputedLink {
                            SubmissionWriteReceiverKind.NotAddressable
                        } else {
                            SubmissionWriteReceiverKind.Addressable
                        }
                    }
                    return SubmissionWriteReceiverKind.None
                }
                // Issue #3252: the value-typed field walk rests on an element
                // load (`qs[0].B2.C = v`). Issue #3292: when the element is
                // array-backed and every link walked so far is a real field, the
                // address chain (`ldelema` + `ldflda`…) reaches the stored
                // element in place; an indexer/map element (or a computed link
                // above the element) still bottoms out in a copy and stays
                // blocked.
                if TryGetElementAccessTarget(access.Receiver!!, out var linkCollection) &&
                    linkCollection is {} resolvedLinkCollection {
                    if !ChainHasSubmissionGlobalRoot(resolvedLinkCollection) {
                        return SubmissionWriteReceiverKind.None
                    }
                    return if !sawComputedLink && IsAddressableElementLoad(access.Receiver!!) {
                        SubmissionWriteReceiverKind.Addressable
                    } else {
                        SubmissionWriteReceiverKind.NotAddressable
                    }
                }
                if access.Receiver is not BoundClrPropertyAccessExpression inner {
                    return SubmissionWriteReceiverKind.None
                }
                access = inner
            }
        }

        /// Issue #3252: extracts the indexed collection from a bound element
        /// load — (cref:BoundIndexExpression) (arrays, slices, maps) or
        /// (cref:BoundClrIndexExpression) (CLR indexer, e.g. an imported
        /// `Dictionary`).
        /// @param expression The candidate element-access expression.
        /// @param collection The indexed collection expression, when [`expression`](paramref) is an element
        /// load.
        /// @returns `true` when [`expression`](paramref) is an element load.
        private func TryGetElementAccessTarget(expression BoundExpression, out collection BoundExpression?) bool {
            switch expression {
                case index is BoundIndexExpression {
                    collection = index.Target
                    return true
                }
                case clrIndex is BoundClrIndexExpression {
                    collection = clrIndex.Target
                    return true
                }
                default {
                    collection = nil
                    return false
                }
            }
        }

        /// Issue #3292: whether an element load denotes addressable element
        /// storage — an array-backed (cref:BoundIndexExpression) whose
        /// element address the emitter can root a write chain at
        /// (`ldelema`). A map element load or a CLR indexer result
        /// ((cref:BoundClrIndexExpression)) returns a copy and is never
        /// addressable.
        /// @param expression The element-load expression.
        /// @returns `true` when the element has a real address.
        private func IsAddressableElementLoad(expression BoundExpression) bool -> expression is BoundIndexExpression &&
            expression.IsArrayBackedElementAccess == true

        /// Issue #3185: whether a CLR member-access chain bottoms out at a prior
        /// submission's addressable global static field. Issue #3252: the walk
        /// also crosses element-access links (`obj.Arr[0]`) so an indexed
        /// collection reached through fields of a submission global still
        /// classifies against the seam rules.
        /// @param expression The chain's innermost inspected link.
        /// @returns `true` when the chain root is a flagged submission global.
        private func ChainHasSubmissionGlobalRoot(expression BoundExpression) bool {
            var expression = expression
            while true {
                switch expression {
                    case BoundClrPropertyAccessExpression{Receiver: nil} root {
                        return root.IsAddressableStaticField
                    }
                    case link is BoundClrPropertyAccessExpression {
                        expression = link.Receiver!!
                        continue
                    }
                    case index is BoundIndexExpression {
                        expression = index.Target
                        continue
                    }
                    case clrIndex is BoundClrIndexExpression {
                        expression = clrIndex.Target
                        continue
                    }
                    default {
                        return false
                    }
                }
            }
        }
    }
}
