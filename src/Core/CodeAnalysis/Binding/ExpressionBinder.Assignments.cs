// <copyright file="ExpressionBinder.Assignments.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access
#pragma warning disable SA1516 // Elements should be separated by blank line

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Text;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class ExpressionBinder
{
    private BoundExpression BindAssignmentExpression(AssignmentExpressionSyntax syntax)
    {
        var name = syntax.IdentifierToken.Text;
        var boundExpression = BindExpression(syntax.Expression);

        var variable = BindVariableReference(name, syntax.IdentifierToken.Location);
        if (variable == null)
        {
            return boundExpression;
        }

        if (variable is ImplicitFieldVariableSymbol implicitField)
        {
            if (implicitField.Field.IsReadOnly
                && !IsReadOnlyFieldAssignmentAllowed(implicitField.Field, implicitField.StructType, receiverIsThis: true))
            {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name);
            }

            // Issue #186 / #175: bare field-name write inside a method fires
            // GS0204 if the underlying field carries `@Obsolete`.
            reportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitField.Field,
                $"{implicitField.StructType.Name}.{implicitField.Field.Name}");

            var convertedValue = conversions.BindConversion(syntax.Expression.Location, boundExpression, implicitField.Field.Type);
            return new BoundFieldAssignmentExpression(null, implicitField.Receiver, implicitField.StructType, implicitField.Field, convertedValue);
        }

        // Issue #261: bare static field assignment inside a shared method body.
        if (variable is ImplicitStaticFieldVariableSymbol implicitStaticField)
        {
            if (implicitStaticField.Field.IsReadOnly)
            {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name);
            }

            reportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitStaticField.Field,
                $"{implicitStaticField.OwnerName}.{implicitStaticField.Field.Name}");

            var convertedValue = conversions.BindConversion(syntax.Expression.Location, boundExpression, implicitStaticField.Field.Type);
            return implicitStaticField.InterfaceType != null
                ? new BoundFieldAssignmentExpression(null, implicitStaticField.Field, implicitStaticField.InterfaceType, convertedValue)
                : new BoundFieldAssignmentExpression(null, null, implicitStaticField.StructType, implicitStaticField.Field, convertedValue);
        }

        // ADR-0053: bare static property assignment inside a method body
        // (shared or instance) of the enclosing type.
        if (variable is ImplicitStaticPropertyVariableSymbol implicitStaticProp)
        {
            if (!implicitStaticProp.Property.HasSetter)
            {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name);
            }

            reportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitStaticProp.Property,
                $"{implicitStaticProp.StructType.Name}.{implicitStaticProp.Property.Name}");

            var convertedValue = conversions.BindConversion(syntax.Expression.Location, boundExpression, implicitStaticProp.Property.Type);
            return new BoundPropertyAssignmentExpression(
                null,
                receiver: null,
                implicitStaticProp.StructType,
                implicitStaticProp.Property,
                convertedValue);
        }

        // Bare property name assignment inside an instance method body resolves
        // to `this.<property> = value` (analogous to implicit field assignment).
        if (variable is ImplicitPropertyVariableSymbol implicitProp)
        {
            if (!implicitProp.Property.HasSetter)
            {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name);
            }

            EnforceInitOnlyAssignment(implicitProp.Property, receiver: null, syntax.EqualsToken.Location);

            reportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitProp.Property,
                $"{implicitProp.StructType.Name}.{implicitProp.Property.Name}");

            var convertedValue = conversions.BindConversion(syntax.Expression.Location, boundExpression, implicitProp.Property.Type);
            return new BoundPropertyAssignmentExpression(
                null,
                new BoundVariableExpression(null, implicitProp.Receiver),
                implicitProp.StructType,
                implicitProp.Property,
                convertedValue);
        }

        if (variable.IsReadOnly)
        {
            // ADR-0060: an `in` parameter is read-only because of its ref-kind,
            // not because of the standard `let` quality. Report GS0237 with
            // ADR-specific wording instead of the generic "cannot assign to const".
            if (variable is ParameterSymbol inParam && inParam.RefKind == RefKind.In)
            {
                Diagnostics.ReportCannotAssignToInParameter(syntax.EqualsToken.Location, name);
            }
            else
            {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name);
            }
        }

        var convertedExpression = conversions.BindConversion(syntax.Expression.Location, boundExpression, variable.Type);

        return new BoundAssignmentExpression(null, variable, convertedExpression, boundExpression.Type);
    }

    /// <summary>
    /// Issue #946: enforces that an <c>init</c>-only property is only assigned
    /// during object initialization. Assignment is permitted when the current
    /// binding context is the declaring type's constructor (<c>.ctor</c>) or an
    /// <c>init</c> accessor, and the receiver is the instance being initialized
    /// (<c>this</c>). Object/aggregate initializers at the creation site bind
    /// through <see cref="BindObjectInitializerAssignment"/> and do not call
    /// this guard, so they are always allowed. Any other assignment reports
    /// <c>GS0372</c>. Reads are never restricted.
    /// </summary>
    /// <param name="prop">The property being assigned.</param>
    /// <param name="receiver">The bound receiver expression, or <see langword="null"/> for an implicit <c>this</c> receiver.</param>
    /// <param name="location">The location to report a diagnostic against.</param>
    private void EnforceInitOnlyAssignment(PropertySymbol prop, BoundExpression receiver, TextLocation location)
    {
        if (prop == null || !prop.IsInitOnly)
        {
            return;
        }

        var fn = this.function;
        var inInitContext = fn != null && (fn.Name == ".ctor" || fn.IsInitOnlySetter);
        var receiverIsThis = receiver == null
            || (receiver is BoundVariableExpression bve
                && fn?.ThisParameter != null
                && ReferenceEquals(bve.Variable, fn.ThisParameter));

        if (inInitContext && receiverIsThis)
        {
            return;
        }

        Diagnostics.ReportInitOnlyPropertyAssignment(location, prop.Name);
    }

    /// <summary>
    /// Issue #947: determines whether an assignment to a read-only (<c>let</c>)
    /// field is permitted in the current binding context. Mirrors C#
    /// <c>readonly</c> field semantics: a read-only <em>instance</em> field may
    /// be assigned (any number of times) inside the declaring type's instance
    /// constructor (<c>init(...)</c>, bound as <c>.ctor</c>) when the target is
    /// the instance being constructed (<c>this</c>), in addition to its
    /// declaration initializer. Anywhere else — other methods, after
    /// construction, on another instance, or from a derived type's constructor
    /// against a base-declared field — the assignment remains a <c>GS0127</c>
    /// error. Static read-only fields keep their existing behavior (assignable
    /// only via their initializer, since G# exposes no user-writable static
    /// constructor body).
    /// </summary>
    /// <param name="field">The field being assigned.</param>
    /// <param name="declaringType">
    /// The type that declares <paramref name="field"/>, when known, used to
    /// reject writes to an inherited read-only field from a derived
    /// constructor; <see langword="null"/> when the caller cannot determine it.
    /// </param>
    /// <param name="receiverIsThis">
    /// <see langword="true"/> when the assignment targets a field of the
    /// instance currently under construction (<c>this</c>).
    /// </param>
    /// <returns><see langword="true"/> when the read-only field assignment is allowed here.</returns>
    private bool IsReadOnlyFieldAssignmentAllowed(FieldSymbol field, TypeSymbol declaringType, bool receiverIsThis)
    {
        if (field == null || !field.IsReadOnly)
        {
            return true;
        }

        // Static read-only fields are only writable from their initializer (the
        // emitter materializes those into the synthesized static constructor).
        // G# has no user-authored static constructor body, so keep the existing
        // GS0127 behavior for any explicit write.
        if (field.IsStatic)
        {
            return false;
        }

        var fn = this.function;
        if (fn == null || fn.Name != ".ctor" || fn.ThisParameter == null)
        {
            return false;
        }

        if (!receiverIsThis)
        {
            return false;
        }

        // C# forbids a derived constructor from assigning a base type's
        // read-only field; only the declaring type's constructor may do so.
        if (declaringType != null && fn.ReceiverType != null
            && !ReferenceEquals(declaringType, fn.ReceiverType))
        {
            return false;
        }

        return true;
    }

    /// <summary>
    /// Issue #947: returns <see langword="true"/> when <paramref name="variable"/>
    /// is the enclosing function's <c>this</c> parameter (the instance under
    /// construction or the method's receiver).
    /// </summary>
    /// <param name="variable">The receiver variable symbol.</param>
    /// <returns><see langword="true"/> when the receiver is <c>this</c>.</returns>
    private bool ReceiverVariableIsThis(VariableSymbol variable)
    {
        var fn = this.function;
        return fn?.ThisParameter != null && ReferenceEquals(variable, fn.ThisParameter);
    }

    /// <summary>
    /// Issue #1132: returns <see langword="true"/> when the receiver
    /// <paramref name="type"/> of a dotted member write is a reference type, in
    /// which case mutating one of its members mutates the heap object rather
    /// than the (possibly read-only) binding. A nullable reference type is
    /// unwrapped first so a smart-cast / annotated reference receiver is also
    /// treated as a reference, while a nullable value type (<c>int32?</c>) stays
    /// a value type and remains rejected.
    /// </summary>
    /// <param name="type">The receiver variable's type.</param>
    /// <returns><see langword="true"/> when the receiver is a reference type.</returns>
    private static bool ReceiverTypeIsReference(TypeSymbol type)
    {
        var underlying = type is NullableTypeSymbol nullable ? nullable.UnderlyingType : type;
        return Binder.IsReferenceTypeForConstraint(underlying);
    }

    /// <summary>
    /// Issue #1132: returns <see langword="true"/> when a member write through
    /// <paramref name="receiver"/> must be rejected because the receiver is a
    /// read-only (e.g. <c>let</c>) local of a <em>value</em> type — mutating one
    /// of its members would mutate the value stored in the read-only slot. A
    /// reference-type receiver (mutating the heap object) and the enclosing
    /// <c>this</c> are both exempt.
    /// </summary>
    /// <param name="receiver">The bound receiver of the member write.</param>
    /// <returns><see langword="true"/> when the member write must be rejected.</returns>
    private bool ReceiverBlocksValueTypeMemberWrite(BoundExpression receiver)
    {
        return receiver is BoundVariableExpression bve
            && bve.Variable.IsReadOnly
            && !ReceiverVariableIsThis(bve.Variable)
            && !ReceiverTypeIsReference(bve.Variable.Type);
    }

    /// <summary>
    /// Issue #947: returns <see langword="true"/> when the bound
    /// <paramref name="receiver"/> denotes the enclosing function's <c>this</c>
    /// (a <see langword="null"/> receiver is an implicit <c>this</c>).
    /// </summary>
    /// <param name="receiver">The bound receiver expression, or <see langword="null"/>.</param>
    /// <returns><see langword="true"/> when the receiver is <c>this</c>.</returns>
    private bool ReceiverExpressionIsThis(BoundExpression receiver)
    {
        var fn = this.function;
        if (fn?.ThisParameter == null)
        {
            return false;
        }

        return receiver == null
            || (receiver is BoundVariableExpression bve && ReferenceEquals(bve.Variable, fn.ThisParameter));
    }

    private BoundExpression BindObjectInitializerAssignment(LocalVariableSymbol receiverLocal, TypeSymbol receiverType, PropertyInitializerSyntax initSyntax)
    {
        var propertyName = initSyntax.PropertyIdentifier.Text;

        // Receiver-side type discriminator mirrors the receiver dispatch in
        // BindFieldAssignmentExpression: pure CLR types go through reflection;
        // user-defined StructSymbols use the symbol tables; both can fall
        // through to ImportedBaseType lookup for inherited CLR members.
        if (receiverType is not StructSymbol && receiverType is not NullableTypeSymbol && receiverType.ClrType != null)
        {
            var clrReceiverType = receiverType.ClrType;
            MemberInfo instanceMember = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(clrReceiverType, propertyName, BindingFlags.Public | BindingFlags.Instance);
            if (instanceMember is PropertyInfo idxProp && idxProp.GetIndexParameters().Length != 0)
            {
                instanceMember = null;
            }

            instanceMember ??= ClrTypeUtilities.SafeGetFieldIncludingInterfaces(clrReceiverType, propertyName, BindingFlags.Public | BindingFlags.Instance);
            if (instanceMember == null)
            {
                Diagnostics.ReportUnableToFindMember(initSyntax.PropertyIdentifier.Location, propertyName);
                _ = BindExpression(initSyntax.Value);
                return null;
            }

            if (!TryGetWritableClrMember(instanceMember, out _, out var instTargetSymbol, out _))
            {
                Diagnostics.ReportCannotAssign(initSyntax.EqualsToken.Location, propertyName);
                _ = BindExpression(initSyntax.Value);
                return null;
            }

            var value = BindExpression(initSyntax.Value);
            var converted = conversions.BindConversion(initSyntax.Value.Location, value, instTargetSymbol);
            var receiverExpr = new BoundVariableExpression(initSyntax, receiverLocal);
            return new BoundClrPropertyAssignmentExpression(initSyntax, receiverExpr, instanceMember, converted, instTargetSymbol);
        }

        if (receiverType is StructSymbol structSymbol)
        {
            if (TypeMemberModel.TryGetFieldIncludingInherited(structSymbol, propertyName, MemberQuery.Instance(MemberKinds.Field), out var field, out _))
            {
                var value = BindExpression(initSyntax.Value);
                var converted = conversions.BindConversion(initSyntax.Value.Location, value, field.Type);
                return new BoundFieldAssignmentExpression(initSyntax, receiverLocal, structSymbol, field, converted);
            }

            if (TypeMemberModel.TryGetProperty(structSymbol, propertyName, out var prop))
            {
                if (!prop.HasSetter)
                {
                    Diagnostics.ReportCannotAssign(initSyntax.EqualsToken.Location, propertyName);
                    _ = BindExpression(initSyntax.Value);
                    return null;
                }

                var value = BindExpression(initSyntax.Value);
                var converted = conversions.BindConversion(initSyntax.Value.Location, value, prop.Type);
                var receiverExpr = new BoundVariableExpression(initSyntax, receiverLocal);
                return new BoundPropertyAssignmentExpression(initSyntax, receiverExpr, structSymbol, prop, converted);
            }

            // Issue #319 parity: fall through to imported base CLR members.
            if (structSymbol.ImportedBaseType?.ClrType is Type inheritedBaseClr)
            {
                MemberInfo inhMember = ClrTypeUtilities.SafeGetProperty(inheritedBaseClr, propertyName, BindingFlags.Public | BindingFlags.Instance);
                if (inhMember is PropertyInfo inhIdxProp && inhIdxProp.GetIndexParameters().Length != 0)
                {
                    inhMember = null;
                }

                inhMember ??= ClrTypeUtilities.SafeGetField(inheritedBaseClr, propertyName, BindingFlags.Public | BindingFlags.Instance);
                if (inhMember != null)
                {
                    if (!TryGetWritableClrMember(inhMember, out _, out var inhTargetSymbol, out _))
                    {
                        Diagnostics.ReportCannotAssign(initSyntax.EqualsToken.Location, propertyName);
                        _ = BindExpression(initSyntax.Value);
                        return null;
                    }

                    var value = BindExpression(initSyntax.Value);
                    var converted = conversions.BindConversion(initSyntax.Value.Location, value, inhTargetSymbol);
                    var receiverExpr = new BoundVariableExpression(initSyntax, receiverLocal);
                    return new BoundClrPropertyAssignmentExpression(initSyntax, receiverExpr, inhMember, converted, inhTargetSymbol);
                }
            }

            Diagnostics.ReportUnableToFindMember(initSyntax.PropertyIdentifier.Location, propertyName);
            _ = BindExpression(initSyntax.Value);
            return null;
        }

        Diagnostics.ReportUnableToFindMember(initSyntax.PropertyIdentifier.Location, propertyName);
        _ = BindExpression(initSyntax.Value);
        return null;
    }

    private BoundExpression BindFieldAssignmentExpression(FieldAssignmentExpressionSyntax syntax)
    {
        var receiverName = syntax.Receiver.Text;

        // Issue #1104: `base.Prop = value` — a non-virtual write to the nearest
        // base class implementation of property `Prop`, mirroring C#
        // `base.Prop = value`. `base` is a contextual keyword: only intercepted
        // when it is not a real value in scope.
        if (receiverName == "base" && !(scope.TryLookupSymbol(receiverName) is VariableSymbol))
        {
            var baseValue = BindExpression(syntax.Value);
            return BindBaseClassPropertyWrite(
                syntax.FieldIdentifier.Text,
                syntax.FieldIdentifier.Location,
                syntax.Receiver.Location,
                baseValue,
                syntax.Value.Location,
                syntax.EqualsToken.Location,
                explicitBaseType: null,
                selectorLocation: syntax.Receiver.Location);
        }

        // Stream B: imported class name on LHS → static field/property write.
        // Probe the import table FIRST so we don't shadow with a variable lookup
        // diagnostic.
        if (scope.TryLookupImportedClass(receiverName, declaration: null, out var importedClass))
        {
            var staticValue = BindExpression(syntax.Value);
            if (!importedClass.TryLookupMember(syntax.FieldIdentifier.Text, ne: null, out var staticMember))
            {
                Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, syntax.FieldIdentifier.Text);
                return new BoundErrorExpression(null);
            }

            if (!TryGetWritableClrMember(staticMember, out var staticTargetType, out var staticTargetSymbol, out var staticWritable))
            {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, syntax.FieldIdentifier.Text);
                return new BoundErrorExpression(null);
            }

            _ = staticWritable;
            _ = staticTargetType;
            var staticConverted = conversions.BindConversion(syntax.Value.Location, staticValue, staticTargetSymbol);
            return new BoundClrPropertyAssignmentExpression(null, receiver: null, staticMember, staticConverted, staticTargetSymbol);
        }

        // ADR-0053: user-defined struct/class type → static field write.
        if (scope.TryLookupTypeAlias(receiverName, out var typeAlias) && typeAlias is StructSymbol userStruct)
        {
            var staticValue = BindExpression(syntax.Value);
            var fieldName = syntax.FieldIdentifier.Text;
            if (TypeMemberModel.TryGetStaticField(userStruct, fieldName, out var staticField))
            {
                if (staticField.IsReadOnly)
                {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName);
                }

                var staticConverted = conversions.BindConversion(syntax.Value.Location, staticValue, staticField.Type);
                return new BoundFieldAssignmentExpression(null, null, userStruct, staticField, staticConverted);
            }

            // Issue #263: static property assignment.
            if (TypeMemberModel.TryGetStaticProperty(userStruct, fieldName, out var prop))
            {
                if (!prop.HasSetter)
                {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName);
                    return new BoundErrorExpression(null);
                }

                var propConverted = conversions.BindConversion(syntax.Value.Location, staticValue, prop.Type);
                return new BoundPropertyAssignmentExpression(null, receiver: null, userStruct, prop, propConverted);
            }

            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName);
            return new BoundErrorExpression(null);
        }

        // ADR-0089 / issue #1030: user-defined interface type → static field
        // write (`IName.Field = value`). Interface static fields are plain CLR
        // static fields; emit a static (null receiver / null declaring struct)
        // BoundFieldAssignmentExpression resolved by symbol identity.
        if (scope.TryLookupTypeAlias(receiverName, out var ifaceAlias) && ifaceAlias is InterfaceSymbol userInterface)
        {
            var staticValue = BindExpression(syntax.Value);
            var fieldName = syntax.FieldIdentifier.Text;
            var staticField = userInterface.GetStaticField(fieldName);
            if (staticField != null)
            {
                if (staticField.IsReadOnly || staticField.IsConst)
                {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName);
                }

                var staticConverted = conversions.BindConversion(syntax.Value.Location, staticValue, staticField.Type);
                return new BoundFieldAssignmentExpression(null, staticField, userInterface, staticConverted);
            }

            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName);
            return new BoundErrorExpression(null);
        }

        var variable = BindVariableReference(receiverName, syntax.Receiver.Location);
        var value = BindExpression(syntax.Value);
        if (variable == null)
        {
            return value;
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
        BoundExpression implicitFieldReceiverExpr = null;
        if (variable is ImplicitFieldVariableSymbol implicitField)
        {
            implicitFieldReceiverExpr = new BoundFieldAccessExpression(
                null,
                new BoundVariableExpression(null, implicitField.Receiver),
                implicitField.StructType,
                implicitField.Field);
        }

        // Stream B: instance-CLR receiver → property/field write via reflection.
        if (variable.Type is not StructSymbol && variable.Type is not NullableTypeSymbol && variable.Type?.ClrType != null)
        {
            var clrReceiverType = variable.Type.ClrType;
            var fieldName = syntax.FieldIdentifier.Text;
            MemberInfo instanceMember = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(clrReceiverType, fieldName, BindingFlags.Public | BindingFlags.Instance);
            if (instanceMember is PropertyInfo prop && prop.GetIndexParameters().Length != 0)
            {
                instanceMember = null;
            }

            instanceMember ??= ClrTypeUtilities.SafeGetFieldIncludingInterfaces(clrReceiverType, fieldName, BindingFlags.Public | BindingFlags.Instance);
            if (instanceMember == null)
            {
                Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName);
                return new BoundErrorExpression(null);
            }

            if (!TryGetWritableClrMember(instanceMember, out var instTargetType, out var instTargetSymbol, out var instWritable))
            {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName);
                return new BoundErrorExpression(null);
            }

            _ = instWritable;
            _ = instTargetType;
            var instReceiver = implicitFieldReceiverExpr ?? new BoundVariableExpression(null, variable);
            var instConverted = conversions.BindConversion(syntax.Value.Location, value, instTargetSymbol);
            return new BoundClrPropertyAssignmentExpression(null, instReceiver, instanceMember, instConverted, instTargetSymbol);
        }

        // Issue #1068: an interface-typed variable receiver (`d.W = v` where
        // d : IDerived) writes the interface property setter (walking base
        // interfaces). Mirrors the read path and the expression-receiver write
        // path; the emitter dispatches via `callvirt set_W`.
        if (variable.Type is InterfaceSymbol ifaceVarType)
        {
            if (TypeMemberModel.TryGetProperty(ifaceVarType, syntax.FieldIdentifier.Text, out var ifaceProp, out _))
            {
                if (!ifaceProp.HasSetter)
                {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, syntax.FieldIdentifier.Text);
                    return new BoundErrorExpression(null);
                }

                var ifaceConverted = conversions.BindConversion(syntax.Value.Location, value, ifaceProp.Type);
                var ifaceReceiver = implicitFieldReceiverExpr ?? new BoundVariableExpression(null, variable);
                EnforceInitOnlyAssignment(ifaceProp, ifaceReceiver, syntax.EqualsToken.Location);
                return new BoundPropertyAssignmentExpression(null, ifaceReceiver, null, ifaceProp, ifaceConverted);
            }

            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, syntax.FieldIdentifier.Text);
            return new BoundErrorExpression(null);
        }

        if (!(variable.Type is StructSymbol structSymbol))
        {
            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, syntax.FieldIdentifier.Text);
            return new BoundErrorExpression(null);
        }

        if (!TypeMemberModel.TryGetFieldIncludingInherited(structSymbol, syntax.FieldIdentifier.Text, MemberQuery.Instance(MemberKinds.Field), out var field, out var fieldDeclaringType))
        {
            // ADR-0051: check if it's a property.
            if (TypeMemberModel.TryGetProperty(structSymbol, syntax.FieldIdentifier.Text, out var prop, out var propDeclaringType))
            {
                if (!prop.HasSetter)
                {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, syntax.FieldIdentifier.Text);
                    return new BoundErrorExpression(null);
                }

                // Issue #950: enforce `protected` property assignment.
                if (!AccessibilityChecker.IsAccessible(prop.Accessibility, propDeclaringType, this.function))
                {
                    Diagnostics.ReportProtectedMemberInaccessible(syntax.FieldIdentifier.Location, prop.Name, propDeclaringType.Name);
                }

                // Issue #1132: writing a property of a read-only value-type
                // receiver mutates the value in the read-only slot — reject it
                // (a reference-type receiver mutates the heap object and the
                // enclosing `this` are both exempt via ReceiverVariableIsThis /
                // ReceiverTypeIsReference).
                if (variable.IsReadOnly && !ReceiverVariableIsThis(variable) && !ReceiverTypeIsReference(variable.Type))
                {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, receiverName);
                }

                var propConverted = conversions.BindConversion(syntax.Value.Location, value, prop.Type);
                var propReceiver = implicitFieldReceiverExpr ?? new BoundVariableExpression(null, variable);
                EnforceInitOnlyAssignment(prop, propReceiver, syntax.EqualsToken.Location);
                return new BoundPropertyAssignmentExpression(null, propReceiver, structSymbol, prop, propConverted);
            }

            // Issue #319: a GSharp class inheriting an imported CLR base exposes
            // the base's settable instance properties/fields. Fall back to CLR
            // member lookup on the imported base type so `e.HResult = 42` style
            // writes work the same as the read fallback further down.
            if (structSymbol.ImportedBaseType?.ClrType is System.Type inheritedBaseClr)
            {
                var memberName = syntax.FieldIdentifier.Text;
                MemberInfo clrMember = ClrTypeUtilities.SafeGetProperty(inheritedBaseClr, memberName, BindingFlags.Public | BindingFlags.Instance);
                if (clrMember is PropertyInfo idxProp && idxProp.GetIndexParameters().Length != 0)
                {
                    clrMember = null;
                }

                clrMember ??= ClrTypeUtilities.SafeGetField(inheritedBaseClr, memberName, BindingFlags.Public | BindingFlags.Instance);
                if (clrMember != null)
                {
                    if (!TryGetWritableClrMember(clrMember, out var inhTargetType, out var inhTargetSymbol, out var inhWritable))
                    {
                        Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, memberName);
                        return new BoundErrorExpression(null);
                    }

                    _ = inhWritable;
                    _ = inhTargetType;
                    var inhReceiver = implicitFieldReceiverExpr ?? new BoundVariableExpression(null, variable);
                    var inhConverted = conversions.BindConversion(syntax.Value.Location, value, inhTargetSymbol);
                    return new BoundClrPropertyAssignmentExpression(null, inhReceiver, clrMember, inhConverted, inhTargetSymbol);
                }
            }

            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, syntax.FieldIdentifier.Text);
            return new BoundErrorExpression(null);
        }

        var receiverIsThisField = ReceiverVariableIsThis(variable);

        // Issue #950: enforce `protected` field assignment — only the declaring
        // type and its derived types may write it.
        if (!AccessibilityChecker.IsAccessible(field.Accessibility, fieldDeclaringType, this.function))
        {
            Diagnostics.ReportProtectedMemberInaccessible(syntax.FieldIdentifier.Location, field.Name, fieldDeclaringType.Name);
        }

        // Issue #947: a read-only field of `this` may be assigned inside the
        // declaring type's constructor; in that case the receiver being `this`
        // (which is itself read-only) must not block the field write.
        // Issue #1132: `let` communicates immutability of the *binding* only
        // (shallow / readonly-reference semantics). For a reference-type
        // receiver, `b.Field = v` mutates the heap object, not the binding, so
        // it must be allowed; only value-type receivers (where the field write
        // would mutate the value stored in the read-only slot) stay rejected.
        if (variable.IsReadOnly && !receiverIsThisField && !ReceiverTypeIsReference(variable.Type))
        {
            Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, receiverName);
        }

        if (field.IsReadOnly
            && !IsReadOnlyFieldAssignmentAllowed(field, fieldDeclaringType, receiverIsThisField))
        {
            Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, syntax.FieldIdentifier.Text);
        }

        // Issue #186 / #175: dotted field write fires GS0204 if the field
        // carries `@Obsolete`.
        reportObsoleteUseIfApplicable(
            syntax.FieldIdentifier.Location,
            field,
            $"{structSymbol.Name}.{field.Name}");

        var converted = conversions.BindConversion(syntax.Value.Location, value, field.Type);
        if (implicitFieldReceiverExpr != null)
        {
            return BoundFieldAssignmentExpression.WithExpressionReceiver(null, implicitFieldReceiverExpr, structSymbol, field, converted);
        }

        return new BoundFieldAssignmentExpression(null, variable, structSymbol, field, converted);
    }

    /// <summary>
    /// Handles a bare `identifier += expr` / `identifier -= expr` that the parser
    /// emitted as an <see cref="EventSubscriptionExpressionSyntax"/> with a
    /// <see cref="NameExpressionSyntax"/> LHS. Resolves as:
    /// 1. An event subscription on the implicit <c>this</c> if the name matches an event.
    /// 2. A compound assignment fallback (<c>x += 1</c>) otherwise.
    /// </summary>
    private BoundExpression BindBareEventOrCompoundAssignment(NameExpressionSyntax bareName, EventSubscriptionExpressionSyntax syntax)
    {
        var name = bareName.IdentifierToken.Text;
        var isAdd = syntax.OperatorToken.Kind == SyntaxKind.PlusEqualsToken;

        // Try implicit `this` event: walk the receiver type's events (including inherited).
        // ADR-0112 A5: intentionally NOT routed through TypeMemberModel.TryGetEvent —
        // that helper returns only the event, not the declaring base level, whereas
        // this bound node must carry the *declaring* type `t` as its owner. Collapsing
        // into TryGetEvent(receiverStruct, …) would change the owner from the declaring
        // base to the derived type, breaking bound-node parity. Left as a manual walk.
        if (function?.ThisParameter != null && function.ReceiverType is StructSymbol receiverStruct)
        {
            for (var t = receiverStruct; t != null; t = t.BaseClass)
            {
                if (t.Events.IsDefaultOrEmpty)
                {
                    continue;
                }

                var ev = t.Events.FirstOrDefault(e => e.Name == name);
                if (ev != null)
                {
                    var receiver = new BoundVariableExpression(null, function.ThisParameter);
                    var handler = BindEventSubscriptionHandler(syntax.Value, ev.Type);
                    return new BoundEventSubscriptionExpression(null, receiver, t, ev, handler, isAdd);
                }
            }
        }

        // Not an event: fall back to compound assignment semantics.
        // Reconstruct `name = name +/- rhs` as the parser used to do.
        var boundRhs = BindExpression(syntax.Value);
        var variable = BindVariableReference(name, bareName.IdentifierToken.Location);
        if (variable == null)
        {
            return boundRhs;
        }

        // Synthesize the binary expression: variable op rhs.
        var leftExpr = BindNameExpressionCore(bareName);
        var baseOpSyntaxKind = isAdd ? SyntaxKind.PlusToken : SyntaxKind.MinusToken;
        var leftType = leftExpr.Type;
        var op = BoundBinaryOperator.Bind(baseOpSyntaxKind, leftType, boundRhs.Type);
        if (op == null)
        {
            Diagnostics.ReportUndefinedBinaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, leftType, boundRhs.Type);
            return new BoundErrorExpression(null);
        }

        var binaryResult = new BoundBinaryExpression(null, leftExpr, op, boundRhs);
        var convertedResult = conversions.BindConversion(syntax.Value.Location, binaryResult, leftType);

        // Route through the correct assignment path depending on variable kind.
        if (variable is ImplicitFieldVariableSymbol implicitField)
        {
            if (implicitField.Field.IsReadOnly
                && !IsReadOnlyFieldAssignmentAllowed(implicitField.Field, implicitField.StructType, receiverIsThis: true))
            {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name);
            }

            return new BoundFieldAssignmentExpression(null, implicitField.Receiver, implicitField.StructType, implicitField.Field, convertedResult);
        }

        if (variable is ImplicitStaticFieldVariableSymbol implicitStaticField)
        {
            if (implicitStaticField.Field.IsReadOnly)
            {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name);
            }

            return implicitStaticField.InterfaceType != null
                ? new BoundFieldAssignmentExpression(null, implicitStaticField.Field, implicitStaticField.InterfaceType, convertedResult)
                : new BoundFieldAssignmentExpression(null, null, implicitStaticField.StructType, implicitStaticField.Field, convertedResult);
        }

        // ADR-0053: bare static property compound assignment inside a method
        // body (shared or instance) of the enclosing type. Compound `+=`/`-=`
        // requires both a getter (for the read half) and a setter (for the
        // write half).
        if (variable is ImplicitStaticPropertyVariableSymbol implicitStaticProp)
        {
            if (!implicitStaticProp.Property.HasGetter || !implicitStaticProp.Property.HasSetter)
            {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name);
                return new BoundErrorExpression(null);
            }

            return new BoundPropertyAssignmentExpression(
                null,
                receiver: null,
                implicitStaticProp.StructType,
                implicitStaticProp.Property,
                convertedResult);
        }

        if (variable is ImplicitPropertyVariableSymbol implicitProp)
        {
            if (!implicitProp.Property.HasSetter)
            {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name);
            }

            EnforceInitOnlyAssignment(implicitProp.Property, receiver: null, syntax.OperatorToken.Location);

            return new BoundPropertyAssignmentExpression(
                null,
                new BoundVariableExpression(null, implicitProp.Receiver),
                implicitProp.StructType,
                implicitProp.Property,
                convertedResult);
        }

        if (variable.IsReadOnly)
        {
            Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name);
        }

        return new BoundAssignmentExpression(null, variable, convertedResult);
    }

    /// <summary>
    /// ADR-0053: bind <c>Type.StaticField +=/-= rhs</c> or
    /// <c>Type.StaticProp +=/-= rhs</c> where <paramref name="staticStruct"/>
    /// is the user-defined receiver type. Returns <c>true</c> if the named
    /// member was a static field/property and the compound assignment was
    /// produced; <c>false</c> if no static field or property by that name
    /// exists on the type (caller falls through to error reporting).
    /// Mirrors the static branch of <see cref="BindFieldAssignmentExpression"/>
    /// (lines ~6586–6619) but for compound `+=` / `-=`.
    /// </summary>
    private bool TryBindUserTypeStaticCompoundAssignment(
        StructSymbol staticStruct,
        NameExpressionSyntax memberNameSyntax,
        EventSubscriptionExpressionSyntax syntax,
        bool isAdd,
        out BoundExpression result)
    {
        var memberName = memberNameSyntax.IdentifierToken.Text;
        var baseOpSyntaxKind = isAdd ? SyntaxKind.PlusToken : SyntaxKind.MinusToken;
        var boundRhs = BindExpression(syntax.Value);

        if (TypeMemberModel.TryGetStaticField(staticStruct, memberName, out var staticField))
        {
            var leftRead = new BoundFieldAccessExpression(null, receiver: null, staticStruct, staticField);
            var op = BoundBinaryOperator.Bind(baseOpSyntaxKind, staticField.Type, boundRhs.Type);
            if (op == null)
            {
                Diagnostics.ReportUndefinedBinaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, staticField.Type, boundRhs.Type);
                result = new BoundErrorExpression(null);
                return true;
            }

            if (staticField.IsReadOnly)
            {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName);
            }

            var binary = new BoundBinaryExpression(null, leftRead, op, boundRhs);
            var converted = conversions.BindConversion(syntax.Value.Location, binary, staticField.Type);
            result = new BoundFieldAssignmentExpression(null, null, staticStruct, staticField, converted);
            return true;
        }

        if (TypeMemberModel.TryGetStaticProperty(staticStruct, memberName, out var prop))
        {
            if (!prop.HasGetter || !prop.HasSetter)
            {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName);
                result = new BoundErrorExpression(null);
                return true;
            }

            var leftRead = new BoundPropertyAccessExpression(null, receiver: null, staticStruct, prop);
            var op = BoundBinaryOperator.Bind(baseOpSyntaxKind, prop.Type, boundRhs.Type);
            if (op == null)
            {
                Diagnostics.ReportUndefinedBinaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, prop.Type, boundRhs.Type);
                result = new BoundErrorExpression(null);
                return true;
            }

            var binary = new BoundBinaryExpression(null, leftRead, op, boundRhs);
            var converted = conversions.BindConversion(syntax.Value.Location, binary, prop.Type);
            result = new BoundPropertyAssignmentExpression(null, receiver: null, staticStruct, prop, converted);
            return true;
        }

        result = null;
        return false;
    }

    /// <summary>
    /// ADR-0089 / issue #1030: binds <c>IName.StaticField +=/-= rhs</c> for an
    /// interface static field. <paramref name="interfaceSym"/> may be the open
    /// definition (non-generic, or self-instantiation) or a constructed generic
    /// interface (<c>IBox[int32]</c>); the field is resolved on the definition
    /// and the carried interface symbol drives per-construction emit/storage.
    /// Returns <c>true</c> when the named member was an interface static field;
    /// <c>false</c> otherwise (caller reports "unable to find member").
    /// </summary>
    /// <param name="interfaceSym">The interface receiver (definition or constructed).</param>
    /// <param name="memberNameSyntax">The member-name syntax.</param>
    /// <param name="syntax">The originating compound-assignment syntax.</param>
    /// <param name="isAdd">Whether the operator is <c>+=</c> (else <c>-=</c>).</param>
    /// <param name="result">The bound compound assignment on success.</param>
    /// <returns>Whether the member resolved to an interface static field.</returns>
    private bool TryBindInterfaceStaticCompoundAssignment(
        InterfaceSymbol interfaceSym,
        NameExpressionSyntax memberNameSyntax,
        EventSubscriptionExpressionSyntax syntax,
        bool isAdd,
        out BoundExpression result)
    {
        var memberName = memberNameSyntax.IdentifierToken.Text;
        var baseOpSyntaxKind = isAdd ? SyntaxKind.PlusToken : SyntaxKind.MinusToken;
        var fieldOwner = interfaceSym.Definition ?? interfaceSym;
        var staticField = fieldOwner.GetStaticField(memberName);
        if (staticField == null)
        {
            result = null;
            return false;
        }

        var boundRhs = BindExpression(syntax.Value);
        var leftRead = new BoundFieldAccessExpression(null, staticField, interfaceSym);
        var op = BoundBinaryOperator.Bind(baseOpSyntaxKind, staticField.Type, boundRhs.Type);
        if (op == null)
        {
            Diagnostics.ReportUndefinedBinaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, staticField.Type, boundRhs.Type);
            result = new BoundErrorExpression(null);
            return true;
        }

        if (staticField.IsReadOnly || staticField.IsConst)
        {
            Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName);
        }

        var binary = new BoundBinaryExpression(null, leftRead, op, boundRhs);
        var converted = conversions.BindConversion(syntax.Value.Location, binary, staticField.Type);
        result = new BoundFieldAssignmentExpression(null, staticField, interfaceSym, converted);
        return true;
    }

    /// <summary>
    /// Issue #648: compound assignment fallback for chained member access on
    /// user-defined struct/class types (e.g. <c>a.B.C += 1</c>). Synthesizes
    /// <c>receiver.field = receiver.field op rhs</c>.
    /// </summary>
    private BoundExpression TryBindChainedCompoundAssignment(
        StructSymbol structSym,
        BoundExpression boundReceiver,
        string memberName,
        NameExpressionSyntax memberNameSyntax,
        EventSubscriptionExpressionSyntax syntax,
        bool isAdd)
    {
        var baseOpSyntaxKind = isAdd ? SyntaxKind.PlusToken : SyntaxKind.MinusToken;
        var boundRhs = BindExpression(syntax.Value);

        // ADR-0112 A3: this-first base-chain instance field walk, using the
        // declaring struct as the owner for both the read access and assignment.
        if (TypeMemberModel.TryGetFieldIncludingInherited(structSym, memberName, MemberQuery.Instance(MemberKinds.Field), out var field, out var declaringType))
        {
            if (field.IsReadOnly
                && !IsReadOnlyFieldAssignmentAllowed(field, declaringType, ReceiverExpressionIsThis(boundReceiver)))
            {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName);
            }

            // Issue #1132: compound-mutating a field of a read-only value-type
            // receiver mutates the value in the read-only slot — reject it.
            // Reference-type receivers and `this` are exempt.
            if (ReceiverBlocksValueTypeMemberWrite(boundReceiver))
            {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName);
            }

            var leftRead = new BoundFieldAccessExpression(null, boundReceiver, declaringType, field);
            var op = BoundBinaryOperator.Bind(baseOpSyntaxKind, field.Type, boundRhs.Type);
            if (op == null)
            {
                Diagnostics.ReportUndefinedBinaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, field.Type, boundRhs.Type);
                return new BoundErrorExpression(null);
            }

            var binary = new BoundBinaryExpression(null, leftRead, op, boundRhs);
            var converted = conversions.BindConversion(syntax.Value.Location, binary, field.Type);
            return BoundFieldAssignmentExpression.WithExpressionReceiver(null, boundReceiver, declaringType, field, converted);
        }

        // ADR-0051: check properties.
        if (TypeMemberModel.TryGetProperty(structSym, memberName, out var prop))
        {
            if (!prop.HasGetter || !prop.HasSetter)
            {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName);
                return new BoundErrorExpression(null);
            }

            // Issue #1132: compound-mutating a property of a read-only value-type
            // receiver mutates the value in the read-only slot — reject it.
            if (ReceiverBlocksValueTypeMemberWrite(boundReceiver))
            {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName);
            }

            var leftRead = new BoundPropertyAccessExpression(null, boundReceiver, structSym, prop);
            var op = BoundBinaryOperator.Bind(baseOpSyntaxKind, prop.Type, boundRhs.Type);
            if (op == null)
            {
                Diagnostics.ReportUndefinedBinaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, prop.Type, boundRhs.Type);
                return new BoundErrorExpression(null);
            }

            var binary = new BoundBinaryExpression(null, leftRead, op, boundRhs);
            var converted = conversions.BindConversion(syntax.Value.Location, binary, prop.Type);
            EnforceInitOnlyAssignment(prop, boundReceiver, syntax.OperatorToken.Location);
            return new BoundPropertyAssignmentExpression(null, boundReceiver, structSym, prop, converted);
        }

        // Inherited CLR base member fallback.
        if (structSym.ImportedBaseType?.ClrType is System.Type inheritedBaseClr)
        {
            return TryBindChainedClrCompoundAssignment(
                boundReceiver, inheritedBaseClr, memberName, memberNameSyntax, syntax, isAdd);
        }

        return null;
    }

    /// <summary>
    /// Issue #648: compound assignment fallback for chained CLR member access
    /// (e.g. <c>obj.Prop += 1</c> where Prop is a property/field on a CLR type).
    /// </summary>
    private BoundExpression TryBindChainedClrCompoundAssignment(
        BoundExpression boundReceiver,
        Type clrReceiverType,
        string memberName,
        NameExpressionSyntax memberNameSyntax,
        EventSubscriptionExpressionSyntax syntax,
        bool isAdd)
    {
        var baseOpSyntaxKind = isAdd ? SyntaxKind.PlusToken : SyntaxKind.MinusToken;

        MemberInfo instanceMember = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(clrReceiverType, memberName, BindingFlags.Public | BindingFlags.Instance);
        if (instanceMember is PropertyInfo propInfo && propInfo.GetIndexParameters().Length != 0)
        {
            instanceMember = null;
        }

        instanceMember ??= ClrTypeUtilities.SafeGetFieldIncludingInterfaces(clrReceiverType, memberName, BindingFlags.Public | BindingFlags.Instance);
        if (instanceMember == null)
        {
            return null;
        }

        if (!TryGetWritableClrMember(instanceMember, out _, out var targetSymbol, out _))
        {
            Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName);
            return new BoundErrorExpression(null);
        }

        var boundRhs = BindExpression(syntax.Value);
        var leftRead = new BoundClrPropertyAccessExpression(null, boundReceiver, instanceMember, targetSymbol);
        var op = BoundBinaryOperator.Bind(baseOpSyntaxKind, targetSymbol, boundRhs.Type);
        if (op == null)
        {
            Diagnostics.ReportUndefinedBinaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, targetSymbol, boundRhs.Type);
            return new BoundErrorExpression(null);
        }

        var binary = new BoundBinaryExpression(null, leftRead, op, boundRhs);
        var converted = conversions.BindConversion(syntax.Value.Location, binary, targetSymbol);
        return new BoundClrPropertyAssignmentExpression(null, boundReceiver, instanceMember, converted, targetSymbol);
    }

    /// <summary>
    /// ADR-0060 §13: binds an indirect assignment <c>*p = expr</c>. The left-hand
    /// side must be a unary dereference of a pointer expression; the result is a
    /// <see cref="BoundIndirectAssignmentExpression"/> whose value type is the
    /// pointee type.
    /// </summary>
    /// <param name="syntax">The indirect-assignment syntax.</param>
    /// <returns>The bound expression, or an error expression on failure.</returns>
    private BoundExpression BindIndirectAssignmentExpression(IndirectAssignmentExpressionSyntax syntax)
    {
        var pointer = BindExpression(syntax.Target.Operand);
        if (pointer is BoundErrorExpression)
        {
            return pointer;
        }

        if (!TypeSymbol.TryGetPointeeType(pointer.Type, out var pointeeType))
        {
            Diagnostics.ReportUndefinedUnaryOperator(syntax.Target.OperatorToken.Location, syntax.Target.OperatorToken.Text, pointer.Type);
            return new BoundErrorExpression(null);
        }

        // ADR-0122 §3 / issue #1033: a true `*void` pointer carries no element
        // type and cannot be written through directly; cast to a typed pointer
        // `*T` (e.g. `*int32(p)`) first.
        if (TypeSymbol.IsVoidPointer(pointer.Type))
        {
            Diagnostics.ReportVoidPointerOperationNotAllowed(syntax.Target.OperatorToken.Location, "dereference");
            return new BoundErrorExpression(null);
        }

        var value = BindExpression(syntax.Value);
        if (value is BoundErrorExpression)
        {
            return value;
        }

        if (value.Type != pointeeType && value.Type != TypeSymbol.Error)
        {
            var converted = Conversion.Classify(value.Type, pointeeType);
            if (!converted.IsImplicit)
            {
                Diagnostics.ReportCannotConvert(syntax.Value.Location, value.Type, pointeeType);
                return new BoundErrorExpression(null);
            }

            value = new BoundConversionExpression(null, pointeeType, value);
        }

        return new BoundIndirectAssignmentExpression(syntax, pointer, value);
    }

    /// <summary>
    /// ADR-0060: binds a <c>ref</c>/<c>out</c>/<c>in</c> argument-position expression.
    /// For the lvalue form (e.g. <c>ref x</c>, <c>out result</c>, <c>in rect</c>) the
    /// inner expression is bound to a <see cref="BoundAddressOfExpression"/>. For the
    /// inline-declaration / discard form (<c>out var name</c>, <c>out let name</c>,
    /// <c>out _</c>), a synthesized <see cref="LocalVariableSymbol"/> is registered in
    /// the current scope (with the declared type, or — if omitted — the parameter's
    /// pointee type) and the address-of expression wraps it.
    /// </summary>
    /// <param name="syntax">The ref-kind argument syntax.</param>
    /// <param name="parameter">The callee parameter this argument binds to (may be <see langword="null"/> when unresolved).</param>
    /// <returns>The bound address-of expression, or an error expression on failure.</returns>
    internal BoundExpression BindRefArgumentExpression(RefArgumentExpressionSyntax syntax, ParameterSymbol parameter)
    {
        if (syntax.IsInlineDeclaration)
        {
            // ADR-0060 §1: `out var n [T]` / `out let n [T]` / `out _ [T]`.
            // Only legal when the modifier is `out` AND the parameter (if known) is `out`.
            if (!string.Equals(syntax.RefKindModifier.Text, "out", System.StringComparison.Ordinal))
            {
                Diagnostics.ReportOutDeclarationOutsideOutArgument(syntax.Location);
                return new BoundErrorExpression(null);
            }

            TypeSymbol declaredType = null;
            if (syntax.DeclaredType != null)
            {
                declaredType = bindTypeClause(syntax.DeclaredType);
            }

            if (declaredType == null && parameter != null)
            {
                declaredType = parameter.Type;
            }

            // ADR-0060: in the first pass (called from BindCallExpression before
            // overload resolution), the parameter is unknown and no explicit
            // type was given. Return a placeholder bound node *without*
            // declaring a local — the call-site arg-loop re-binds us once the
            // parameter has been resolved so the local has the right type.
            if (declaredType == null)
            {
                return new BoundAddressOfExpression(null, new BoundErrorExpression(null));
            }

            // Synthesize the local. `out _` gets a fresh anonymous name; `out var`/`out let`
            // honour the user-given identifier.
            bool isReadOnly = syntax.DeclarationKeyword != null
                && string.Equals(syntax.DeclarationKeyword.Text, "let", System.StringComparison.Ordinal);
            string localName;
            if (syntax.DiscardToken != null)
            {
                localName = $"<>out_discard_{binderCtx.OutDiscardCounter++}";
            }
            else
            {
                localName = syntax.DeclarationIdentifier.Text;
            }

            var local = new LocalVariableSymbol(localName, isReadOnly, declaredType, declaringSyntax: syntax);
            if (syntax.DiscardToken == null && !scope.TryDeclareVariable(local))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(syntax.DeclarationIdentifier.Location, localName);
                return new BoundErrorExpression(null);
            }
            else if (syntax.DiscardToken != null)
            {
                // Discards never collide; always declare under the synthesized name.
                scope.TryDeclareVariable(local);
            }

            var nameExpression = new BoundVariableExpression(null, local);
            return new BoundAddressOfExpression(null, nameExpression);
        }

        // Plain lvalue form: bind the operand and check it's an lvalue.
        // ADR-0061: the operand may be a conditional ref-argument expression
        // (`cond ? a : b`); dispatch to the dedicated binder which produces
        // a BoundConditionalAddressExpression (also typed `T&`). The
        // operand may be wrapped in parens (`ref (cond ? a : b)`); unwrap.
        var rawExpr = syntax.Expression;
        while (rawExpr is ParenthesizedExpressionSyntax pen)
        {
            rawExpr = pen.Expression;
        }

        if (rawExpr is ConditionalRefArgumentExpressionSyntax condSyntax)
        {
            return conversions.BindConditionalRefArgument(condSyntax, syntax.RefKindModifier);
        }

        // ADR-0062: a general conditional expression as the payload of
        // ref/out/in binds to the conditional-address path (preserving
        // ADR-0061 byref safety).
        if (rawExpr is ConditionalExpressionSyntax generalCondSyntax)
        {
            return BindConditionalAddressFromGeneral(generalCondSyntax, syntax.RefKindModifier);
        }

        var operand = BindExpression(syntax.Expression);
        if (operand is BoundErrorExpression)
        {
            return operand;
        }

        if (!IsLvalue(operand))
        {
            Diagnostics.ReportCannotTakeAddressOfNonLvalue(syntax.RefKindModifier.Location, syntax.Expression.ToString());
            return new BoundErrorExpression(null);
        }

        // For `out` we allow writes to a read-only target only if it's an
        // out-parameter or a writable local. The existing GS9005 check fires
        // for true constants; preserve that for `ref` (read-only operand is
        // fine for `in`).
        if (operand is BoundVariableExpression vex && vex.Variable.IsReadOnly
            && string.Equals(syntax.RefKindModifier.Text, "ref", System.StringComparison.Ordinal))
        {
            Diagnostics.ReportCannotTakeAddressOfConstant(syntax.RefKindModifier.Location, vex.Variable.Name);
            return new BoundErrorExpression(null);
        }

        return new BoundAddressOfExpression(null, operand);
    }

    private BoundExpression BindIndexAssignmentExpression(IndexAssignmentExpressionSyntax syntax)
    {
        var name = syntax.TargetIdentifier.Text;
        if (scope.TryLookupSymbol(name) is not VariableSymbol variable)
        {
            Diagnostics.ReportUndefinedVariable(syntax.TargetIdentifier.Location, name);
            return new BoundErrorExpression(null);
        }

        // Issue #674: when the target resolves to an implicit field on `this`,
        // the raw ImplicitFieldVariableSymbol has no local slot in the emitter.
        // Rewrite to a temp-local initialized from the proper field access
        // expression (mirroring what BindIndexedWriteThroughChain does for
        // chained member-index assignments). The temp is a real local the
        // emitter can load.
        if (variable is ImplicitFieldVariableSymbol implicitField)
        {
            var fieldAccess = new BoundFieldAccessExpression(
                null,
                new BoundVariableExpression(null, implicitField.Receiver),
                implicitField.StructType,
                implicitField.Field);

            var tempName = $"<idxAsn{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>";
            var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, fieldAccess.Type);
            scope.TryDeclareVariable(tempVar);
            var declaration = new BoundVariableDeclaration(syntax, tempVar, fieldAccess);

            var assignment = BindIndexedAssignmentToVariable(tempVar, syntax.Index, syntax.Value, syntax.TargetIdentifier.Location);
            if (assignment is BoundErrorExpression)
            {
                return assignment;
            }

            return new BoundBlockExpression(syntax, ImmutableArray.Create<BoundStatement>(declaration), assignment);
        }

        return BindIndexedAssignmentToVariable(variable, syntax.Index, syntax.Value, syntax.TargetIdentifier.Location);
    }

    private BoundExpression BindMemberIndexAssignmentExpression(MemberIndexAssignmentExpressionSyntax syntax)
    {
        if (syntax.Target.IsNullConditional)
        {
            // ADR-0073 / issue #710: reject `a?[i] = v`. The null-conditional
            // index expression is not a valid assignment target — mirroring
            // C#'s CS0131 behavior on `?[]` LHS. Use `if a != nil { a[i] = v }`
            // (or `a[i] = v` directly) instead.
            Diagnostics.ReportNullConditionalIndexAssignmentTarget(syntax.Target.OpenBracketToken.Location);
            return new BoundErrorExpression(syntax);
        }

        return BindIndexedWriteThroughChain(
            chainBase: null,
            remainingChain: syntax.Target.Target,
            indexSyntax: syntax.Target.Index,
            valueSyntax: syntax.Value,
            boundValueOverride: null,
            compoundOperatorToken: null,
            compoundRhsSyntax: null,
            diagnosticLocation: syntax.Target.Target.Location,
            outerSyntax: syntax);
    }

    /// <summary>
    /// Issue #648: binds a chained member-access assignment of the form
    /// <c>receiver.Field = value</c> where the receiver is an arbitrary
    /// expression (e.g. <c>a.B.C = v</c>). The receiver is bound to a
    /// <see cref="BoundExpression"/>, its result type is inspected for the
    /// named field/property, and the appropriate assignment bound node is
    /// produced.
    /// </summary>
    private BoundExpression BindMemberFieldAssignmentExpression(MemberFieldAssignmentExpressionSyntax syntax)
    {
        // ADR-0089 / issue #1030: `IBox[int32].Field = value` — a write to a
        // constructed generic interface's static field. The receiver
        // `IBox[int32]` is a type, not a value, so it is resolved to the
        // constructed interface symbol rather than bound as an index expression.
        if (syntax.Receiver is IndexExpressionSyntax ifaceIndex
            && !ifaceIndex.IsNullConditional
            && TryResolveConstructedGenericInterfaceReceiver(ifaceIndex, out var ctorIface))
        {
            var ifaceFieldName = syntax.FieldIdentifier.Text;
            var ownerDef = ctorIface.Definition ?? ctorIface;
            var ifaceStaticField = ownerDef.GetStaticField(ifaceFieldName);
            if (ifaceStaticField != null)
            {
                var ifaceValue = BindExpression(syntax.Value);
                if (ifaceStaticField.IsReadOnly || ifaceStaticField.IsConst)
                {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, ifaceFieldName);
                }

                var ifaceConverted = conversions.BindConversion(syntax.Value.Location, ifaceValue, ifaceStaticField.Type);
                return new BoundFieldAssignmentExpression(null, ifaceStaticField, ctorIface, ifaceConverted);
            }

            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, ifaceFieldName);
            return new BoundErrorExpression(null);
        }

        var receiver = BindExpression(syntax.Receiver);
        if (receiver is BoundErrorExpression)
        {
            return receiver;
        }

        var value = BindExpression(syntax.Value);
        var fieldName = syntax.FieldIdentifier.Text;
        var receiverType = receiver.Type;

        // User-defined struct/class receiver → field or property write.
        if (receiverType is StructSymbol structSym)
        {
            // ADR-0112 A3: this-first base-chain instance field walk, using the
            // declaring struct as the owner for the emitted assignment.
            if (TypeMemberModel.TryGetFieldIncludingInherited(structSym, fieldName, MemberQuery.Instance(MemberKinds.Field), out var field, out var declaringType))
            {
                if (field.IsReadOnly
                    && !IsReadOnlyFieldAssignmentAllowed(field, declaringType, ReceiverExpressionIsThis(receiver)))
                {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName);
                }

                reportObsoleteUseIfApplicable(
                    syntax.FieldIdentifier.Location,
                    field,
                    $"{declaringType.Name}.{field.Name}");

                var converted = conversions.BindConversion(syntax.Value.Location, value, field.Type);
                return BoundFieldAssignmentExpression.WithExpressionReceiver(null, receiver, declaringType, field, converted);
            }

            // ADR-0051: check properties before reporting "unable to find member".
            if (TypeMemberModel.TryGetProperty(structSym, fieldName, out var prop))
            {
                if (!prop.HasSetter)
                {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName);
                    return new BoundErrorExpression(null);
                }

                var propConverted = conversions.BindConversion(syntax.Value.Location, value, prop.Type);
                EnforceInitOnlyAssignment(prop, receiver, syntax.EqualsToken.Location);
                return new BoundPropertyAssignmentExpression(null, receiver, structSym, prop, propConverted);
            }

            // Inherited CLR base member fallback.
            if (structSym.ImportedBaseType?.ClrType is System.Type inheritedBaseClr)
            {
                MemberInfo clrMember = ClrTypeUtilities.SafeGetProperty(inheritedBaseClr, fieldName, BindingFlags.Public | BindingFlags.Instance);
                if (clrMember is PropertyInfo idxProp && idxProp.GetIndexParameters().Length != 0)
                {
                    clrMember = null;
                }

                clrMember ??= ClrTypeUtilities.SafeGetField(inheritedBaseClr, fieldName, BindingFlags.Public | BindingFlags.Instance);
                if (clrMember != null)
                {
                    if (!TryGetWritableClrMember(clrMember, out var inhTargetType, out var inhTargetSymbol, out var inhWritable))
                    {
                        Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName);
                        return new BoundErrorExpression(null);
                    }

                    _ = inhWritable;
                    _ = inhTargetType;
                    var inhConverted = conversions.BindConversion(syntax.Value.Location, value, inhTargetSymbol);
                    return new BoundClrPropertyAssignmentExpression(null, receiver, clrMember, inhConverted, inhTargetSymbol);
                }
            }

            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName);
            return new BoundErrorExpression(null);
        }

        // Issue #1068: write a property declared on the static interface type
        // (or any base interface) through an interface-typed receiver. Mirrors
        // the property read path in ExpressionBinder.Access.cs so `b.H = v`
        // (b : IBase) dispatches via a verifiable `callvirt set_H`.
        if (receiverType is InterfaceSymbol ifaceSym)
        {
            if (TypeMemberModel.TryGetProperty(ifaceSym, fieldName, out var ifaceProp, out _))
            {
                if (!ifaceProp.HasSetter)
                {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName);
                    return new BoundErrorExpression(null);
                }

                var ifaceConverted = conversions.BindConversion(syntax.Value.Location, value, ifaceProp.Type);
                EnforceInitOnlyAssignment(ifaceProp, receiver, syntax.EqualsToken.Location);
                return new BoundPropertyAssignmentExpression(null, receiver, null, ifaceProp, ifaceConverted);
            }

            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName);
            return new BoundErrorExpression(null);
        }

        // CLR receiver → property/field write via reflection.
        if (receiverType is not NullableTypeSymbol && receiverType?.ClrType != null)
        {
            var clrReceiverType = receiverType.ClrType;
            MemberInfo instanceMember = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(clrReceiverType, fieldName, BindingFlags.Public | BindingFlags.Instance);
            if (instanceMember is PropertyInfo propInfo && propInfo.GetIndexParameters().Length != 0)
            {
                instanceMember = null;
            }

            instanceMember ??= ClrTypeUtilities.SafeGetFieldIncludingInterfaces(clrReceiverType, fieldName, BindingFlags.Public | BindingFlags.Instance);
            if (instanceMember == null)
            {
                Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName);
                return new BoundErrorExpression(null);
            }

            if (!TryGetWritableClrMember(instanceMember, out var instTargetType, out var instTargetSymbol, out var instWritable))
            {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName);
                return new BoundErrorExpression(null);
            }

            _ = instWritable;
            _ = instTargetType;
            var instConverted = conversions.BindConversion(syntax.Value.Location, value, instTargetSymbol);
            return new BoundClrPropertyAssignmentExpression(null, receiver, instanceMember, instConverted, instTargetSymbol);
        }

        Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName);
        return new BoundErrorExpression(null);
    }

    private BoundExpression BindCompoundIndexAssignmentExpression(CompoundIndexAssignmentExpressionSyntax syntax)
    {
        if (syntax.Target.IsNullConditional)
        {
            // ADR-0073 / issue #710: reject `a?[i] op= v` for the same reason
            // we reject `a?[i] = v` — the null-conditional indexer cannot be
            // an assignment target.
            Diagnostics.ReportNullConditionalIndexAssignmentTarget(syntax.Target.OpenBracketToken.Location);
            return new BoundErrorExpression(syntax);
        }

        return BindIndexedWriteThroughChain(
            chainBase: null,
            remainingChain: syntax.Target.Target,
            indexSyntax: syntax.Target.Index,
            valueSyntax: null,
            boundValueOverride: null,
            compoundOperatorToken: syntax.OperatorToken,
            compoundRhsSyntax: syntax.Value,
            diagnosticLocation: syntax.OperatorToken.Location,
            outerSyntax: syntax);
    }
}
