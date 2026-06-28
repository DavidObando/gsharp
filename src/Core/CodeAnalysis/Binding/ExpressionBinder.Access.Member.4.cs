// <copyright file="ExpressionBinder.Access.Member.4.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
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


    private BoundExpression BindAccessorStep(BoundExpression receiver, ImportedClassSymbol classSymbol, ExpressionSyntax rightPart)
    {
        switch (rightPart)
        {
            case AccessorExpressionSyntax nested:
                // Issue #672: when the LHS is a CLR type symbol, check whether
                // the left segment of the nested accessor names a nested type
                // (e.g. `Environment.SpecialFolder.ApplicationData` — here
                // `SpecialFolder` is a nested enum inside `Environment`). If so,
                // create a new ImportedClassSymbol for the nested type and bind
                // the right segment against it, enabling chained static/enum
                // member access on nested types.
                if (classSymbol != null && TryResolveNestedTypeFromAccessorLeft(classSymbol, nested.LeftPart, out var nestedClassSymbol))
                {
                    if (nested.IsNullConditional)
                    {
                        // Null-conditional on a type is semantically meaningless
                        // but fall through to avoid a crash.
                        return new BoundErrorExpression(null);
                    }

                    return BindAccessorStep(null, nestedClassSymbol, nested.RightPart);
                }

                var head = BindAccessorStep(receiver, classSymbol, nested.LeftPart);
                if (head is BoundErrorExpression)
                {
                    return head;
                }

                // Issue #507 follow-up: ParseNameOrCallExpression folds the
                // right-hand side of an accessor through ParsePostfixChain, so
                // `a.b?.c` parses as `AccessorExpression(a, ., AccessorExpression(b, ?., c))`.
                // The nested accessor's `?.` token must be honored here, or the
                // read/write degenerates into a plain `.c` against `b`'s nullable
                // type and reports "Cannot find member c".
                if (nested.IsNullConditional)
                {
                    return BindNullConditionalAccessExpressionCore(head, nested.RightPart);
                }

                return BindAccessorStep(head, null, nested.RightPart);

            case CallExpressionSyntax ce:
                var callResult = BindAccessorCall(receiver, classSymbol, ce);
                CheckValueTaskGetAwaiterGetResult(callResult, ce);
                return callResult;

            // Issue #569: an object-initializer suffix on a nested-type
            // constructor (`Outer.Inner() { Prop = val }`) parses as
            // ObjectCreationExpressionSyntax wrapping the call. Bind the
            // inner call through the accessor path (which resolves the
            // nested type constructor), then apply the initializer
            // assignments against the constructed instance.
            case ObjectCreationExpressionSyntax objCreate
                when objCreate.Target is CallExpressionSyntax innerCall:
                var ctorResult = BindAccessorCall(receiver, classSymbol, innerCall);
                if (ctorResult is BoundErrorExpression)
                {
                    return ctorResult;
                }

                return BindObjectInitializerSuffix(objCreate, ctorResult);

            // Issue #507 follow-up: support indexer reads through a member chain
            // (`obj.Member[k]`, `obj.A.B[k]`, `obj?.Member[k]`). ParsePostfixChain
            // folds a trailing `[...]` into the right-hand side of the most
            // recent `.`, so the indexer arrives here as the rightPart of an
            // AccessorExpression. We bind the indexer's target through the
            // accessor chain so we get the correct member-rooted bound receiver,
            // then route the index resolution through the shared helper.
            //
            // ADR-0073 / issue #710: when the indexer is null-conditional
            // (`a.b?[i]`, `a?.b?[i]?.c`), capture the bound receiver chain into
            // a synthetic local first and wrap the index in a
            // BoundNullConditionalAccessExpression — mirroring the handling of
            // a nested `?.` accessor a few lines above.
            case IndexExpressionSyntax ix:
                var indexTarget = BindAccessorStep(receiver, classSymbol, ix.Target);
                if (indexTarget is BoundErrorExpression)
                {
                    return indexTarget;
                }

                if (ix.IsNullConditional)
                {
                    return BindNullConditionalIndexFromBoundTarget(indexTarget, ix);
                }

                return BindIndexAgainstTarget(indexTarget, ix.Index, ix.Target.Location);

            case NameExpressionSyntax ne:
                if (ne.IdentifierToken.IsMissing)
                {
                    // Incomplete member access such as `x.` with no member name yet.
                    // The parser already reported the missing identifier; binding a
                    // null member name would throw (e.g. Type.GetProperty(null)), so
                    // bail out gracefully. This keeps completion / semantic tokens
                    // working while the user is mid-typing.
                    return new BoundErrorExpression(null);
                }

                if (classSymbol != null)
                {
                    var foundMember = classSymbol.TryLookupMember(ne.IdentifierToken.Text, ne, out var staticMember);
                    if (!foundMember)
                    {
                        // Issue #337: a static member name that resolves to a
                        // method (not a field/property) is a method group. In a
                        // delegate-conversion context it materializes as a
                        // delegate over the selected overload; the conversion
                        // classifier decides which overload (if any) applies.
                        if (TryBindClrMethodGroup(receiver: null, classSymbol.ClassType, wantStatic: true, ne.IdentifierToken.Text, out var staticGroup))
                        {
                            return staticGroup;
                        }

                        Diagnostics.ReportUnableToFindMember(ne.Location, ne.IdentifierToken.Text);
                        return new BoundErrorExpression(null);
                    }

                    // Stream B: static field/property read on imported type.
                    // `Receiver == null` flags the access as static. Literal
                    // (const) fields aren't real runtime fields, so we inline
                    // their constant value rather than emit `ldsfld`.
                    if (staticMember is FieldInfo litField && litField.IsLiteral)
                    {
                        return new BoundLiteralExpression(null, litField.GetRawConstantValue(), TypeSymbol.FromClrType(litField.FieldType));
                    }

                    var staticType = staticMember switch
                    {
                        PropertyInfo sp => TypeSymbol.FromClrType(sp.PropertyType),
                        FieldInfo sf => TypeSymbol.FromClrType(sf.FieldType),
                        _ => TypeSymbol.Error,
                    };
                    return new BoundClrPropertyAccessExpression(null, null, staticMember, staticType);
                }
                else if (receiver != null && receiver.Type is StructSymbol structSym)
                {
                    // ADR-0112 A3: this-first base-chain instance field walk via
                    // the canonical member-resolution layer, surfacing the
                    // declaring struct so the emitted field token names the right owner.
                    if (TypeMemberModel.TryGetFieldIncludingInherited(structSym, ne.IdentifierToken.Text, MemberQuery.Instance(MemberKinds.Field), out var field, out var declaringType))
                    {
                        // Issue #186 / #175: dotted field read fires
                        // GS0204 if the field carries `@Obsolete`.
                        reportObsoleteUseIfApplicable(ne.IdentifierToken.Location, field, $"{declaringType.Name}.{field.Name}");

                        // Issue #950: enforce `protected` field access — only the
                        // declaring type and its derived types may read it.
                        if (!AccessibilityChecker.IsAccessible(field.Accessibility, declaringType, this.function))
                        {
                            Diagnostics.ReportProtectedMemberInaccessible(ne.IdentifierToken.Location, field.Name, declaringType.Name);
                        }

                        // ADR-0122 §10 / issue #1035: a fixed-size buffer field
                        // decays to a `*T` to the first element. Lower
                        // `recv.buf` to a reinterpret of `&recv.buf` (the
                        // address of the inline backing struct, whose first
                        // element sits at offset 0) to the element pointer
                        // type. Indexing / passing then flows through the
                        // existing unmanaged-pointer machinery.
                        if (field.IsFixedBuffer)
                        {
                            return MakeFixedBufferPointer(receiver, declaringType, field);
                        }

                        return ApplyMemberNarrowing(new BoundFieldAccessExpression(null, receiver, declaringType, field));
                    }

                    // ADR-0051: check properties before reporting "unable to find member".
                    if (TypeMemberModel.TryGetProperty(structSym, ne.IdentifierToken.Text, out var prop, out var propDeclaringType))
                    {
                        if (!prop.HasGetter)
                        {
                            Diagnostics.ReportCannotAssign(ne.Location, ne.IdentifierToken.Text);
                            return new BoundErrorExpression(null);
                        }

                        // Issue #950: enforce `protected` property access.
                        if (!AccessibilityChecker.IsAccessible(prop.Accessibility, propDeclaringType, this.function))
                        {
                            Diagnostics.ReportProtectedMemberInaccessible(ne.IdentifierToken.Location, prop.Name, propDeclaringType.Name);
                        }

                        return ApplyMemberNarrowing(new BoundPropertyAccessExpression(null, receiver, structSym, prop));
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
                    if (IsWithinType(structSym))
                    {
                        for (var evtDeclType = structSym; evtDeclType != null; evtDeclType = evtDeclType.BaseClass)
                        {
                            var evt = evtDeclType.Events.FirstOrDefault(e =>
                                e.Name == ne.IdentifierToken.Text && e.IsFieldLike && e.BackingField != null);
                            if (evt != null)
                            {
                                return ApplyMemberNarrowing(new BoundFieldAccessExpression(null, receiver, evtDeclType, evt.BackingField));
                            }
                        }
                    }

                    // Issue #296: a GSharp class inheriting an imported CLR base
                    // exposes the base's instance properties/fields. Fall back to
                    // CLR member lookup on the imported base type.
                    if (structSym.ImportedBaseType?.ClrType is System.Type inheritedBaseClr)
                    {
                        var memberName = ne.IdentifierToken.Text;
                        var clrProp = ClrTypeUtilities.SafeGetProperty(inheritedBaseClr, memberName, BindingFlags.Public | BindingFlags.Instance);
                        if (clrProp != null && clrProp.GetIndexParameters().Length == 0 && clrProp.CanRead)
                        {
                            return new BoundClrPropertyAccessExpression(null, receiver, clrProp, TypeSymbol.FromClrType(clrProp.PropertyType));
                        }

                        var clrFld = ClrTypeUtilities.SafeGetField(inheritedBaseClr, memberName, BindingFlags.Public | BindingFlags.Instance);
                        if (clrFld != null)
                        {
                            return new BoundClrPropertyAccessExpression(null, receiver, clrFld, TypeSymbol.FromClrType(clrFld.FieldType));
                        }
                    }

                    // ADR-0112: an instance method named here in non-call position
                    // is a method group captured against the bound receiver. The
                    // conversion classifier selects the overload (if any) from the
                    // target delegate signature; the emitter binds the delegate's
                    // Target to this receiver (boxing value-type receivers).
                    var instanceMethods = TypeMemberModel.GetMethods(structSym, ne.IdentifierToken.Text, MemberQuery.Instance(MemberKinds.Method));
                    if (TryBuildUserMethodGroup(receiver, instanceMethods, out var instanceUserGroup))
                    {
                        return instanceUserGroup;
                    }

                    // Issue #1136: an inherited System.Object instance member
                    // (GetType/ToString/GetHashCode/Equals) named in method-group
                    // position. When the user type declares no explicit imported
                    // base, fall back to typeof(object) so the member is captured
                    // as a CLR method group resolvable against a target delegate.
                    var inheritedMgClr = structSym.ImportedBaseType?.ClrType ?? typeof(object);
                    if (TryBindClrMethodGroup(receiver, inheritedMgClr, wantStatic: false, ne.IdentifierToken.Text, out var inheritedClrGroup))
                    {
                        return inheritedClrGroup;
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, ne.IdentifierToken.Text);
                }
                else if (receiver != null && receiver.Type is EnumSymbol)
                {
                    // Issue #1218: an inherited System.Enum / ValueType / Object
                    // instance member (HasFlag/ToString/GetHashCode/Equals/GetType)
                    // named in method-group position on an enum value. Capture it
                    // as a CLR method group over typeof(System.Enum) so it resolves
                    // against a target delegate signature; the emitter boxes the
                    // value-type receiver into the delegate Target.
                    if (TryBindClrMethodGroup(receiver, typeof(System.Enum), wantStatic: false, ne.IdentifierToken.Text, out var enumClrGroup))
                    {
                        return enumClrGroup;
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, ne.IdentifierToken.Text);
                }
                else if (receiver != null && receiver.Type is InterfaceSymbol ifaceSym)
                {
                    // Issue #1068: read a property declared on the static
                    // interface type (or any base interface) through an
                    // interface-typed receiver. Interface methods already
                    // dispatch via the InterfaceSymbol path in
                    // ExpressionBinder.Calls.cs; this mirrors that for
                    // properties so `b.H` (b : IBase) resolves the abstract
                    // accessor and emits a verifiable `callvirt get_H`.
                    // Inherited base-interface members are surfaced because
                    // TypeMemberModel.TryGetProperty walks SelfAndAllBaseInterfaces.
                    if (TypeMemberModel.TryGetProperty(ifaceSym, ne.IdentifierToken.Text, out var ifaceProp, out _))
                    {
                        if (!ifaceProp.HasGetter)
                        {
                            Diagnostics.ReportCannotAssign(ne.Location, ne.IdentifierToken.Text);
                            return new BoundErrorExpression(null);
                        }

                        return new BoundPropertyAccessExpression(null, receiver, null, ifaceProp);
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
                    var ifaceMemberName = ne.IdentifierToken.Text;
                    foreach (var clrBaseIface in MemberLookup.GetTransitiveClrBaseInterfaces(ifaceSym))
                    {
                        var clrProp = ClrTypeUtilities.SafeGetProperty(clrBaseIface, ifaceMemberName, BindingFlags.Public | BindingFlags.Instance);
                        if (clrProp != null && clrProp.GetIndexParameters().Length == 0 && clrProp.CanRead)
                        {
                            return new BoundClrPropertyAccessExpression(null, receiver, clrProp, TypeSymbol.FromClrType(clrProp.PropertyType));
                        }

                        var clrFld = ClrTypeUtilities.SafeGetField(clrBaseIface, ifaceMemberName, BindingFlags.Public | BindingFlags.Instance);
                        if (clrFld != null)
                        {
                            return new BoundClrPropertyAccessExpression(null, receiver, clrFld, TypeSymbol.FromClrType(clrFld.FieldType));
                        }
                    }

                    // Issue #1181: an inherited imported-base-interface method
                    // named in method-group position (e.g. `b.Dispose` passed
                    // to a delegate) is captured against the bound receiver.
                    foreach (var clrBaseIface in MemberLookup.GetTransitiveClrBaseInterfaces(ifaceSym))
                    {
                        if (TryBindClrMethodGroup(receiver, clrBaseIface, wantStatic: false, ifaceMemberName, out var ifaceClrGroup))
                        {
                            return ifaceClrGroup;
                        }
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, ne.IdentifierToken.Text);
                }
                else if (receiver != null && receiver.Type is TupleTypeSymbol tupleSym)
                {
                    // Phase 4.5: tuple element access via Item1..ItemN.
                    var memberName = ne.IdentifierToken.Text;
                    if (memberName.StartsWith("Item", System.StringComparison.Ordinal)
                        && int.TryParse(memberName.Substring(4), out var oneBased)
                        && oneBased >= 1 && oneBased <= tupleSym.Arity)
                    {
                        return new BoundTupleElementAccessExpression(null, receiver, tupleSym, oneBased - 1);
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, memberName);
                    return new BoundErrorExpression(null);
                }
                else if (receiver != null && receiver.Type is NullableTypeSymbol nullableSym
                    && nullableSym.UnderlyingType?.ClrType is { IsValueType: true } nullableInnerClr
                    && this.memberLookup.TryGetNullableConstructedType(nullableInnerClr, out var nullableClr))
                {
                    // Issue #517: a value-type `T?` lowers to `System.Nullable<T>`
                    // at the CLR layer (see `EncodeTypeSymbol`). Resolve `.Value`,
                    // `.HasValue`, etc. against that constructed generic so the
                    // BCL instance API surfaces the same way it does for any
                    // other CLR struct. NRT receivers (reference-type underlying)
                    // have no `Nullable<T>` projection and continue to fall
                    // through to the existing GS0158 path below.
                    var nullableMemberName = ne.IdentifierToken.Text;
                    var nullableProp = ClrTypeUtilities.SafeGetProperty(nullableClr, nullableMemberName, BindingFlags.Public | BindingFlags.Instance);
                    if (nullableProp != null && nullableProp.GetIndexParameters().Length == 0 && nullableProp.CanRead)
                    {
                        var nullablePropType = ClrNullability.GetPropertyTypeSymbol(nullableProp);
                        return new BoundClrPropertyAccessExpression(null, receiver, nullableProp, nullablePropType);
                    }

                    if (TryBindClrMethodGroup(receiver, nullableClr, wantStatic: false, nullableMemberName, out var nullableGroup))
                    {
                        return nullableGroup;
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, nullableMemberName);
                    return new BoundErrorExpression(null);
                }
                else if (receiver != null && receiver.Type is NullableTypeSymbol openNullableSym
                    && openNullableSym.UnderlyingType is TypeParameterSymbol openTp
                    && openTp.HasValueTypeConstraint)
                {
                    // Issue #806: a `T?` receiver where T is an open value-type
                    // type parameter still lowers to `Nullable<T>` at IL emit
                    // time, but the closed `Nullable<T>` CLR instance is not
                    // available here. Resolve the member name against the open
                    // `typeof(Nullable<>)` definition so `.HasValue`, `.Value`
                    // and `.GetValueOrDefault()` bind successfully and lower
                    // to a normal property/method access on the symbolic
                    // constructed receiver.
                    var openNullableMemberName = ne.IdentifierToken.Text;
                    var openNullableDef = typeof(System.Nullable<>);
                    var openProp = ClrTypeUtilities.SafeGetProperty(openNullableDef, openNullableMemberName, BindingFlags.Public | BindingFlags.Instance);
                    if (openProp != null && openProp.GetIndexParameters().Length == 0 && openProp.CanRead)
                    {
                        // HasValue → bool (concrete); Value → the open T (the
                        // property's PropertyType IS the open type parameter
                        // itself in the reflection model). Substitute back to
                        // the binder's symbolic T so downstream type checks
                        // see the right symbol.
                        TypeSymbol openPropType;
                        if (openProp.PropertyType.IsGenericParameter)
                        {
                            openPropType = openTp;
                        }
                        else
                        {
                            openPropType = ClrNullability.GetPropertyTypeSymbol(openProp);
                        }

                        return new BoundClrPropertyAccessExpression(null, receiver, openProp, openPropType);
                    }

                    if (TryBindClrMethodGroup(receiver, openNullableDef, wantStatic: false, openNullableMemberName, out var openNullableGroup))
                    {
                        return openNullableGroup;
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, openNullableMemberName);
                    return new BoundErrorExpression(null);
                }
                else if (receiver != null && receiver.Type != null && receiver.Type is not NullableTypeSymbol && receiver.Type.ClrType != null)
                {
                    // Phase 4 exit: read a public instance property or field on
                    // a CLR receiver (e.g. `lst.Count`, `sb.Length`,
                    // `kvp.Key`). Static members are reached through
                    // ImportedClassSymbol; this path covers instances. Nullable
                    // receivers must be narrowed or use `?.` before this path.
                    var clrReceiverType = receiver.Type.ClrType;
                    var memberName = ne.IdentifierToken.Text;

                    // Issue #529: use interface-aware lookup so that members
                    // declared on a base interface (e.g. IReadOnlyCollection<T>.Count
                    // surfaced through IReadOnlyList<T>) are found.
                    var prop = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(clrReceiverType, memberName, BindingFlags.Public | BindingFlags.Instance);
                    if (prop != null && prop.GetIndexParameters().Length == 0 && prop.CanRead)
                    {
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
                        var receiverOverride = ResolveInstancePropertyTypeFromReceiver(receiver.Type, prop);
                        var propType = receiverOverride
                            ?? (prop.PropertyType.IsByRef
                                ? MapClrMemberType(prop.PropertyType)
                                : ClrNullability.GetPropertyTypeSymbol(prop));
                        return ConversionClassifier.AutoDereferenceRefReturn(new BoundClrPropertyAccessExpression(null, receiver, prop, propType));
                    }

                    var fld = ClrTypeUtilities.SafeGetFieldIncludingInterfaces(clrReceiverType, memberName, BindingFlags.Public | BindingFlags.Instance);
                    if (fld != null)
                    {
                        return new BoundClrPropertyAccessExpression(null, receiver, fld, ClrNullability.GetFieldTypeSymbol(fld));
                    }

                    // Issue #337: an instance member name that resolves to a
                    // method (not a field/property) is a method group bound to
                    // this receiver. In a delegate-conversion context it captures
                    // the receiver as the delegate target over the selected
                    // overload.
                    if (TryBindClrMethodGroup(receiver, clrReceiverType, wantStatic: false, memberName, out var instanceGroup))
                    {
                        return instanceGroup;
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, memberName);
                    return new BoundErrorExpression(null);
                }
                else if (receiver != null
                    && receiver.Type is SliceTypeSymbol or ArrayTypeSymbol
                    && receiver.Type.ClrType == null)
                {
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
                    var arrayMemberName = ne.IdentifierToken.Text;
                    var arrayProp = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(typeof(System.Array), arrayMemberName, BindingFlags.Public | BindingFlags.Instance);
                    if (arrayProp != null && arrayProp.GetIndexParameters().Length == 0 && arrayProp.CanRead)
                    {
                        return new BoundClrPropertyAccessExpression(null, receiver, arrayProp, ClrNullability.GetPropertyTypeSymbol(arrayProp));
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, arrayMemberName);
                    return new BoundErrorExpression(null);
                }
                else if (receiver != null && receiver.Type is TypeParameterSymbol tpRecv)
                {
                    // Issue #1235: a value whose static type is a type parameter
                    // constrained to a class (or interface) exposes that
                    // constraint's FULL instance member surface — fields and
                    // properties, not only methods (instance method calls are
                    // resolved through the constraint in ExpressionBinder.Calls).
                    // Field reads lower to a `box !!T; ldfld` against the
                    // constraint class; property reads dispatch through a
                    // verifiable `box !!T; callvirt get_X` (see the emitter).
                    var tpMember = BindTypeParameterInstanceMemberAccess(tpRecv, receiver, ne);
                    if (tpMember != null)
                    {
                        return tpMember;
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, ne.IdentifierToken.Text);
                }
                else
                {
                    Diagnostics.ReportUnableToFindMember(ne.Location, ne.IdentifierToken.Text);
                }

                return new BoundErrorExpression(null);

            default:
                return new BoundErrorExpression(null);
        }
    }

    /// <summary>
    /// Issue #672: resolves a nested CLR type from the left part of an
    /// accessor expression when the enclosing type is already known (i.e.
    /// <paramref name="classSymbol"/> is non-null). Supports single-level
    /// nesting (left part is a <see cref="NameExpressionSyntax"/>) and
    /// multi-level nesting (left part is an <see cref="AccessorExpressionSyntax"/>
    /// whose segments form a chain of nested types).
    /// </summary>
    private bool TryResolveNestedTypeFromAccessorLeft(ImportedClassSymbol classSymbol, ExpressionSyntax leftPart, out ImportedClassSymbol nestedClassSymbol)
    {
        nestedClassSymbol = null;

        if (leftPart is NameExpressionSyntax nameExpr)
        {
            var name = nameExpr.IdentifierToken.Text;

            // Only resolve as a nested type when the name is NOT a static
            // field/property or method group — those take precedence.
            if (classSymbol.TryLookupMember(name, nameExpr, out _))
            {
                return false;
            }

            if (TryBindClrMethodGroup(receiver: null, classSymbol.ClassType, wantStatic: true, name, out _))
            {
                return false;
            }

            if (scope.References.TryResolveNestedType(classSymbol.ClassType, name, out var nestedType))
            {
                nestedClassSymbol = new ImportedClassSymbol(nestedType, nameExpr);
                return true;
            }

            return false;
        }

        if (leftPart is AccessorExpressionSyntax accessor)
        {
            // Multi-level nesting: recursively resolve the left side first,
            // then resolve the right side as a nested type of that.
            if (!TryResolveNestedTypeFromAccessorLeft(classSymbol, accessor.LeftPart, out var intermediateSymbol))
            {
                return false;
            }

            if (accessor.RightPart is NameExpressionSyntax innerName)
            {
                var innerNameText = innerName.IdentifierToken.Text;
                if (scope.References.TryResolveNestedType(intermediateSymbol.ClassType, innerNameText, out var deepNested))
                {
                    nestedClassSymbol = new ImportedClassSymbol(deepNested, innerName);
                    return true;
                }
            }

            return false;
        }

        return false;
    }

    private bool TrySplitAtLeftmostNullConditional(
        ExpressionSyntax chain,
        out ExpressionSyntax left,
        out ExpressionSyntax right)
    {
        // ParseNameOrCallExpression makes accessor chains RIGHT-recursive: in
        // `a.b?.c.d`, the outer accessor is `.` with LeftPart `a` and RightPart
        // `AccessorExpression(b, ?., AccessorExpression(c, ., d))`. To find the
        // leftmost `?.` we walk the RIGHT spine: if the current node is itself
        // `?.`, it is the split point; otherwise recurse into RightPart and
        // rebuild the LEFT side by re-attaching the prefix with the inner
        // `?.` replaced by its own LeftPart.
        if (chain is AccessorExpressionSyntax acc)
        {
            if (acc.IsNullConditional)
            {
                left = acc.LeftPart;
                right = acc.RightPart;
                return true;
            }

            if (TrySplitAtLeftmostNullConditional(acc.RightPart, out var innerLeft, out var innerRight))
            {
                left = new AccessorExpressionSyntax(acc.SyntaxTree, acc.LeftPart, acc.DotToken, innerLeft);
                right = innerRight;
                return true;
            }
        }

        left = null;
        right = null;
        return false;
    }

    private static TypeSymbol MapClrMemberType(System.Type clrType)
    {
        if (clrType != null && clrType.IsByRef)
        {
            return ByRefTypeSymbol.Get(TypeSymbol.FromClrType(clrType.GetElementType()!));
        }

        return TypeSymbol.FromClrType(clrType);
    }

    /// <summary>
    /// Issue #794: substitute the receiver's symbolic type arguments back
    /// through a CLR property's open declaring type. The closed `clrReceiverType`
    /// is the type-erased shape (#313 / #671), so reflection's
    /// <see cref="PropertyInfo.PropertyType"/> reports the property's open type
    /// closed over `object` — e.g. `Dictionary[K, V].Keys` surfaces as
    /// `ICollection&lt;object&gt;`. Walk the open property on the receiver's
    /// <see cref="ImportedTypeSymbol.OpenDefinition"/> and project its property
    /// type using the receiver's <see cref="ImportedTypeSymbol.TypeArguments"/>.
    /// Returns <see langword="null"/> when no substitution applies.
    /// </summary>
    private static TypeSymbol ResolveInstancePropertyTypeFromReceiver(TypeSymbol receiverType, PropertyInfo closedProperty)
    {
        if (receiverType is not ImportedTypeSymbol imp
            || imp.OpenDefinition == null
            || imp.TypeArguments.IsDefaultOrEmpty
            || closedProperty == null)
        {
            return null;
        }

        try
        {
            // Match by name + indexer arity to find the open counterpart.
            // Properties on closed generic instances carry stable
            // metadata-name overlap with their open declaration; an exact
            // name lookup on the open type with the same instance-binding
            // flags is sufficient for the single-name, non-indexer
            // properties that surface real receiver-type generics.
            var openType = closedProperty.DeclaringType != imp.ClrType && closedProperty.DeclaringType?.IsGenericType == true
                ? imp.OpenDefinition.GetInterfaces().FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == closedProperty.DeclaringType.GetGenericTypeDefinition())
                    ?? imp.OpenDefinition
                : imp.OpenDefinition;
            var openProperty = ClrTypeUtilities.SafeGetProperty(
                openType,
                closedProperty.Name,
                BindingFlags.Public | BindingFlags.Instance);
            if (openProperty == null || openProperty.GetIndexParameters().Length != 0)
            {
                return null;
            }

            var openPropType = openProperty.PropertyType;
            if (openPropType == null)
            {
                return null;
            }

            var mapped = MemberLookup.MapOpenClrTypeToSymbolic(openPropType, imp.OpenDefinition, imp.TypeArguments);

            // Issue #794 surfaced this projection for in-scope type parameters
            // (e.g. `Dictionary[K, V].Keys` -> `ICollection[K]`). Issue #1304
            // extends it to same-compilation user-defined type arguments: a
            // member whose open type is a generic parameter — e.g.
            // `IEnumerator[Ch].Current` -> `Ch` — must keep the user element
            // `Ch` instead of erasing to `object`. A user-defined `Ch` has a
            // null `ClrType` during binding, so the closed reflection property
            // reports the erased `object`; surface the symbolic projection.
            //
            // The override is restricted to a TOP-LEVEL user type (after
            // unwrapping nullable/slice/array). A member typed as a constructed
            // generic over a user element (e.g. a `ChannelWriter[Entry]`
            // property) is intentionally left to the closed reflection
            // fallback, because method/extension lookup on such a non-interned
            // constructed generic is not yet supported (#1305); surfacing it
            // here would regress those call sites.
            return TypeSymbol.ContainsTypeParameter(mapped)
                || TypeSymbol.IsSameCompilationUserTypeTopLevel(mapped)
                ? mapped
                : null;
        }
        catch (System.Reflection.AmbiguousMatchException)
        {
            return null;
        }
    }

    private static bool IsReadOnlyRefReturn(PropertyInfo indexer, MethodInfo getter)
    {
        static bool HasInModifier(System.Type[] modifiers)
        {
            foreach (var m in modifiers)
            {
                if (m.Name == "InAttribute")
                {
                    return true;
                }
            }

            return false;
        }

        if (HasInModifier(indexer.GetRequiredCustomModifiers()))
        {
            return true;
        }

        return HasInModifier(getter.ReturnParameter.GetRequiredCustomModifiers());
    }

    // `length - n` for a from-end index `^n`.
    private BoundExpression MakeFromEndOffset(FromEndIndexExpressionSyntax fromEnd, BoundExpression lengthExpr)
    {
        var offset = conversions.BindConversion(fromEnd.Operand, TypeSymbol.Int32);
        var subtractOp = BoundBinaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int32, TypeSymbol.Int32);
        return new BoundBinaryExpression(null, lengthExpr, subtractOp, offset);
    }

    // Element type for the array/slice slicing path, or null if the target is
    // not an array/slice. Result of slicing is always a `[]T` slice.
    private static TypeSymbol GetArraySliceElementType(TypeSymbol type)
    {
        return type switch
        {
            ArrayTypeSymbol arr => arr.ElementType,
            SliceTypeSymbol slice => slice.ElementType,
            ImportedTypeSymbol imp when imp.ClrType is { IsArray: true } clr && clr.GetArrayRank() == 1
                => TypeSymbol.FromClrType(clr.GetElementType()),
            NullabilityAnnotatedTypeSymbol annot when annot.ClrType is { IsArray: true } clr && clr.GetArrayRank() == 1
                => annot.GetTypeArgumentSymbolForClrType(clr.GetElementType()),
            _ => null,
        };
    }

    // Binds the lower/upper bounds (each optional, each possibly a from-end
    // `^n` marker — issue #1022) as int32 expressions and emits the `src`,
    // source-length, `start`, and `len` temporaries shared by the array,
    // string, and span-like slicing paths. A from-end bound `^n` lowers to
    // `srcLen - n`; an open lower bound is `0` and an open upper bound is
    // `srcLen`. `len = upper - start`.
    private (BoundExpression Src, BoundExpression Start, BoundExpression Len) BuildSliceBounds(
        BoundExpression target,
        RangeExpressionSyntax range,
        Func<BoundExpression, BoundExpression> lengthOf,
        ImmutableArray<BoundStatement>.Builder statements)
    {
        var srcLocal = DeclareRangeTemp("src", target.Type, target, statements);

        BoundExpression SrcRef() => new BoundVariableExpression(null, srcLocal);

        // Compute the source length once; required for open upper bounds and for
        // any from-end (`^n`) bound, and harmless otherwise.
        var srcLenLocal = DeclareRangeTemp("srclen", TypeSymbol.Int32, lengthOf(SrcRef()), statements);

        BoundExpression SrcLenRef() => new BoundVariableExpression(null, srcLenLocal);

        var lowerBound = BindRangeBoundValue(range.LowerBound, SrcLenRef, new BoundLiteralExpression(null, 0));
        var startLocal = DeclareRangeTemp("start", TypeSymbol.Int32, lowerBound, statements);
        var startRef = new BoundVariableExpression(null, startLocal);

        var upperBound = BindRangeBoundValue(range.UpperBound, SrcLenRef, SrcLenRef());

        var subtractOp = BoundBinaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int32, TypeSymbol.Int32);
        var lengthExpr = new BoundBinaryExpression(null, upperBound, subtractOp, startRef);
        var lenLocal = DeclareRangeTemp("len", TypeSymbol.Int32, lengthExpr, statements);

        return (
            new BoundVariableExpression(null, srcLocal),
            new BoundVariableExpression(null, startLocal),
            new BoundVariableExpression(null, lenLocal));
    }

    private BoundExpression BindArraySlice(BoundExpression target, RangeExpressionSyntax range, TypeSymbol elementType)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var (srcRef, startRef, lenRef) = BuildSliceBounds(
            target,
            range,
            src => new BoundLenExpression(null, src),
            statements);

        var resultType = SliceTypeSymbol.Get(elementType);

        // dst = new T[len]
        var dstLocal = DeclareRangeTemp("dst", resultType, new BoundArrayCreationExpression(null, resultType, lenRef), statements);
        var dstRef = new BoundVariableExpression(null, dstLocal);

        // Array.Copy(src, start, dst, 0, len)
        var copyMethod = typeof(System.Array).GetMethod(
            "Copy",
            new[] { typeof(System.Array), typeof(int), typeof(System.Array), typeof(int), typeof(int) });
        var copyCall = new BoundClrStaticCallExpression(
            null,
            copyMethod,
            TypeSymbol.Void,
            ImmutableArray.Create<BoundExpression>(
                srcRef,
                startRef,
                dstRef,
                new BoundLiteralExpression(null, 0),
                lenRef));
        statements.Add(new BoundExpressionStatement(null, copyCall));

        return new BoundBlockExpression(range, statements.ToImmutable(), new BoundVariableExpression(null, dstLocal));
    }

    private BoundExpression BindStringSlice(BoundExpression target, RangeExpressionSyntax range)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var (srcRef, startRef, lenRef) = BuildSliceBounds(
            target,
            range,
            src => new BoundLenExpression(null, src),
            statements);

        var substring = typeof(string).GetMethod("Substring", new[] { typeof(int), typeof(int) });
        var call = new BoundImportedInstanceCallExpression(
            null,
            srcRef,
            substring,
            TypeSymbol.String,
            ImmutableArray.Create<BoundExpression>(startRef, lenRef));

        return new BoundBlockExpression(range, statements.ToImmutable(), call);
    }
}
