// <copyright file="ExpressionBinder.Access.MemberLookup.cs" company="GSharp">
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

                        return BindExtensionMethodGroupOrError(receiver, ne);
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

                    // Issue #1330: when the receiver is a generic type
                    // constructed over an in-scope generic type parameter
                    // (`Comparer[TResult].Default`), the closed CLR member type
                    // is type-erased (`Comparer<object>`). Recover the symbolic
                    // member type (`Comparer[TResult]`) by substituting the
                    // receiver's symbolic arguments through the open member, and
                    // carry the symbolic container so the emitter parents the
                    // static read at the constructed `Comparer<!TResult>`
                    // TypeSpec rather than the erased `Comparer<object>`.
                    if (classSymbol.SymbolicReceiver != null)
                    {
                        var symbolicMemberType = ResolveStaticMemberTypeFromSymbolicReceiver(classSymbol.SymbolicReceiver, staticMember);
                        if (symbolicMemberType != null)
                        {
                            staticType = symbolicMemberType;
                        }

                        return new BoundClrPropertyAccessExpression(null, null, staticMember, staticType, classSymbol.SymbolicReceiver);
                    }

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

                        // Issue #950 / #2044: enforce `protected`/`private` field
                        // access — only the declaring type (and, for
                        // `protected`, its derived types) may read it.
                        if (!AccessibilityChecker.IsAccessible(field.Accessibility, declaringType, this.function))
                        {
                            Diagnostics.ReportMemberInaccessible(ne.IdentifierToken.Location, field.Name, declaringType.Name, field.Accessibility);
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

                        // Issue #950 / #2044: enforce `protected`/`private`
                        // property access.
                        if (!AccessibilityChecker.IsAccessible(prop.Accessibility, propDeclaringType, this.function))
                        {
                            Diagnostics.ReportMemberInaccessible(ne.IdentifierToken.Location, prop.Name, propDeclaringType.Name, prop.Accessibility);
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

                    // Issue #296 / #1582: a GSharp class inheriting an imported
                    // CLR base (directly or through user classes) exposes the
                    // base's instance properties/fields — including inherited
                    // `protected` / `protected internal` members. Resolve the
                    // inherited CLR base type by walking the user base chain,
                    // then reflect the member (reflection walks the CLR chain).
                    if (GetInheritedClrBaseType(structSym) is System.Type inheritedBaseClr)
                    {
                        var memberName = ne.IdentifierToken.Text;
                        var clrProp = ClrTypeUtilities.SafeGetInheritedInstanceProperty(inheritedBaseClr, memberName);
                        if (clrProp != null && clrProp.CanRead)
                        {
                            return new BoundClrPropertyAccessExpression(null, receiver, clrProp, TypeSymbol.FromClrType(clrProp.PropertyType));
                        }

                        var clrFld = ClrTypeUtilities.SafeGetInheritedInstanceField(inheritedBaseClr, memberName);
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

                    return BindExtensionMethodGroupOrError(receiver, ne);
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

                    return BindExtensionMethodGroupOrError(receiver, ne);
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

                    // Issue #1397: an instance method declared on the static
                    // interface type (or any user base interface) named in
                    // method-group position is captured against the bound
                    // receiver, mirroring the class-receiver path above. The
                    // emitter dispatches via `ldvirtftn` so the delegate invokes
                    // the concrete implementation through interface dispatch.
                    // TypeMemberModel.GetMethods walks SelfAndAllBaseInterfaces
                    // so an inherited base-interface method binds too.
                    var ifaceInstanceMethods = TypeMemberModel.GetMethods(ifaceSym, ne.IdentifierToken.Text, MemberQuery.Instance(MemberKinds.Method));
                    if (TryBuildUserMethodGroup(receiver, ifaceInstanceMethods, out var ifaceUserGroup))
                    {
                        return ifaceUserGroup;
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

                    return BindExtensionMethodGroupOrError(receiver, ne);
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

                    return BindExtensionMethodGroupOrError(receiver, ne);
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

                    return BindExtensionMethodGroupOrError(receiver, ne);
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

                    return BindExtensionMethodGroupOrError(receiver, ne);
                }
                else if (receiver != null
                    && receiver.Type?.ClrType != null
                    && (receiver.Type is not NullableTypeSymbol
                        || receiver is BoundClrPropertyAccessExpression))
                {
                    // Phase 4 exit: read a public instance property or field on
                    // a CLR receiver (e.g. `lst.Count`, `sb.Length`,
                    // `kvp.Key`). Static members are reached through
                    // ImportedClassSymbol; this path covers instances. Permit a
                    // chained CLR member whose oblivious metadata made its
                    // result nullable, while explicit nullable variables still
                    // require narrowing or `?.`.
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

                    return BindExtensionMethodGroupOrError(receiver, ne);
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

                    return BindExtensionMethodGroupOrError(receiver, ne);
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

                    return BindExtensionMethodGroupOrError(receiver, ne);
                }
                else
                {
                    return BindExtensionMethodGroupOrError(receiver, ne);
                }

            default:
                return new BoundErrorExpression(null);
        }
    }

    /// <summary>
    /// Issue #2452: binds a receiver-style extension method reference used as a
    /// value (<c>receiver.Extension</c>) after ordinary fields, properties, and
    /// instance methods have all failed lookup. Calls already resolve extensions
    /// through the overload resolver; method-group lookup must use the same
    /// symbol tables instead of treating the name as a missing property.
    /// </summary>
    private BoundExpression BindExtensionMethodGroupOrError(BoundExpression receiver, NameExpressionSyntax name)
    {
        if (receiver != null)
        {
            var userCandidates = scope.TryLookupExtensionFunctions(receiver.Type, name.IdentifierToken.Text);
            if (!userCandidates.IsDefaultOrEmpty)
            {
                if (userCandidates.Length == 1
                    && userCandidates[0] is { IsExtension: true, TypeParameters.IsDefaultOrEmpty: true } single
                    && single.Parameters.Length > 0)
                {
                    var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(single.Parameters.Length - 1);
                    for (var i = 1; i < single.Parameters.Length; i++)
                    {
                        parameterTypes.Add(single.Parameters[i].Type);
                    }

                    var functionType = FunctionTypeSymbol.Get(
                        parameterTypes.MoveToImmutable(),
                        single.Type ?? TypeSymbol.Void);
                    return new BoundMethodGroupExpression(name, receiver, single, functionType);
                }

                return new BoundMethodGroupExpression(name, receiver, userCandidates);
            }

            var importedCandidates = this.memberLookup.CollectImportedExtensionMethods(name.IdentifierToken.Text);
            if (importedCandidates.Count > 0)
            {
                return new BoundClrMethodGroupExpression(
                    name,
                    receiver,
                    declaringType: null,
                    name.IdentifierToken.Text,
                    importedCandidates.ToImmutableArray());
            }
        }

        Diagnostics.ReportUnableToFindMember(name.Location, name.IdentifierToken.Text);
        return new BoundErrorExpression(null);
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
                nestedClassSymbol = new ImportedClassSymbol(nestedType, nameExpr, references: scope.References);
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
                    nestedClassSymbol = new ImportedClassSymbol(deepNested, innerName, references: scope.References);
                    return true;
                }
            }

            return false;
        }

        return false;
    }

    private BoundExpression BindIndexExpression(IndexExpressionSyntax syntax)
    {
        if (syntax.IsNullConditional)
        {
            // ADR-0073 / issue #710: `a?[i]` evaluates `a` once; if nil, the
            // whole expression is nil (without touching the indexer or the
            // index operand). Otherwise it indexes the captured value once.
            return BindNullConditionalIndexExpression(syntax);
        }

        var target = BindExpression(syntax.Target);
        return BindIndexAgainstTarget(target, syntax.Index, syntax.Target.Location);
    }

    // ADR-0073 / issue #710: bind `target?[index]`. The receiver is evaluated
    // exactly once into a synthetic capture local; the indexed access is then
    // bound against the capture and wrapped in a
    // BoundNullConditionalAccessExpression so the existing lowering and emit
    // pipeline (which already handles `?.`) covers the new form for free.
    private BoundExpression BindNullConditionalIndexExpression(IndexExpressionSyntax syntax)
    {
        var receiver = BindExpression(syntax.Target);
        if (receiver is BoundErrorExpression)
        {
            return receiver;
        }

        return BindNullConditionalIndexFromBoundTarget(receiver, syntax);
    }

    // ADR-0073 / issue #710: shared core for `?[i]` binding. Splits the
    // already-bound receiver into capture + indexed access so nested
    // accessor-chain entry points (e.g. the `IndexExpressionSyntax` case in
    // BindAccessorStep that handles `a.b?[i]`) can reuse the same logic.
    private BoundExpression BindNullConditionalIndexFromBoundTarget(BoundExpression receiver, IndexExpressionSyntax syntax)
    {
        var receiverType = receiver.Type;
        TypeSymbol underlying;
        if (receiverType is NullableTypeSymbol nullable)
        {
            underlying = nullable.UnderlyingType;
        }
        else if (receiverType == TypeSymbol.Null)
        {
            // `nil?[i]` is statically nil.
            return new BoundLiteralExpression(null, null);
        }
        else
        {
            // GS0300 (warning): the receiver of `?[...]` is non-nullable, so
            // the null-check is dead code. Suggest the plain `[...]` form.
            Diagnostics.ReportNullConditionalIndexReceiverNotNullable(
                syntax.OpenBracketToken.Location,
                receiverType);
            underlying = receiverType;
        }

        var captureName = "$ncap_" + (++binderCtx.NullConditionalCaptureCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var capture = new LocalVariableSymbol(captureName, isReadOnly: true, type: underlying);

        // Push a temp scope so the capture is in scope while we bind the
        // indexed access against it.
        scope = new BoundScope(scope);
        scope.TryDeclareVariable(capture);

        var captureRef = new BoundVariableExpression(null, capture);
        var whenNotNull = BindIndexAgainstTarget(captureRef, syntax.Index, syntax.Target.Location);

        scope = scope.Parent;

        if (whenNotNull is BoundErrorExpression || whenNotNull.Type == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        var resultType = whenNotNull.Type is NullableTypeSymbol
            ? whenNotNull.Type
            : (TypeSymbol)NullableTypeSymbol.Get(whenNotNull.Type);

        // Issue #1475: allocate the result slot for ANY value-type underlying
        // recognised by symbol (user enum/struct, value-constrained type
        // parameter, tuple), not only when `ClrType.IsValueType`. Mirrors the
        // member-access `?.` path so `?[]` over a user value type also
        // materialises `default(Nullable<T>)` on the nil branch instead of
        // `ldnull`.
        LocalVariableSymbol resultSlot = null;
        if (resultType is NullableTypeSymbol nullableResult
            && GSharp.Core.CodeAnalysis.Emit.ReflectionMetadataEmitter.IsValueTypeSymbol(nullableResult.UnderlyingType))
        {
            var resultSlotName = "$nres_" + binderCtx.NullConditionalCaptureCounter.ToString(System.Globalization.CultureInfo.InvariantCulture);
            resultSlot = new LocalVariableSymbol(resultSlotName, isReadOnly: false, type: resultType);
        }

        return new BoundNullConditionalAccessExpression(null, receiver, capture, whenNotNull, resultType, resultSlot);
    }

    private BoundExpression BindIndexAgainstTarget(
        BoundExpression target,
        ExpressionSyntax indexSyntax,
        TextLocation targetLocation,
        BoundExpression boundIndexOverride = null)
    {
        // ADR-0122 / issue #1014: pointer indexing `p[i]` == `*(p + i)`.
        if (target.Type is PointerTypeSymbol pointerTarget)
        {
            // ADR-0122 §3 / issue #1033: a `*void` pointer has no element type,
            // so `p[i]` (which lowers to `*(p + i)`) is rejected (GS0403); cast
            // to a typed pointer `*T` first.
            if (TypeSymbol.IsVoidPointer(target.Type))
            {
                Diagnostics.ReportVoidPointerOperationNotAllowed(targetLocation, "index");
                return new BoundErrorExpression(null);
            }

            var pointerIndex = boundIndexOverride ?? BindExpression(indexSyntax);
            if (pointerIndex is BoundErrorExpression)
            {
                return pointerIndex;
            }

            if (!IsPointerOffsetType(pointerIndex.Type))
            {
                pointerIndex = boundIndexOverride != null
                    ? conversions.BindConversion(indexSyntax.Location, pointerIndex, TypeSymbol.NInt)
                    : conversions.BindConversion(indexSyntax, TypeSymbol.NInt);
            }

            var elementPointer = LowerPointerOffset(target, pointerTarget, pointerIndex, subtract: false);
            return new BoundDereferenceExpression(null, elementPointer);
        }

        // Issue #1016: a range operand (`a[lo..hi]`) slices the target rather
        // than indexing a single element.
        if (indexSyntax is RangeExpressionSyntax rangeSyntax)
        {
            return BindRangeSlice(target, rangeSyntax, targetLocation);
        }

        // Issue #1022: a from-end index (`a[^n]`) reads the single element
        // `length - n`.
        if (boundIndexOverride != null
            && ClrTypeUtilities.AreSame(boundIndexOverride.Type?.ClrType, typeof(System.Index)))
        {
            return BindSystemIndexAccess(target, boundIndexOverride, targetLocation);
        }

        if (boundIndexOverride == null && indexSyntax is FromEndIndexExpressionSyntax fromEndSyntax)
        {
            return BindFromEndIndex(target, fromEndSyntax, targetLocation);
        }

        // Issue #1038: an index whose value is a `System.Range` slices the
        // target (`let r = 1..3; a[r]`, or the inline `a[(1..3)]`), dispatching
        // to the same array/string/span/`this[System.Range]` shapes used by the
        // syntactic `a[1..3]` form. Bind the index once here and reuse the bound
        // expression in the ordinary index paths below to avoid re-binding.
        // `default`/interpolated index syntaxes can never be a range value and
        // keep their dedicated conversion handling, so they are not pre-bound.
        BoundExpression boundIndex = boundIndexOverride;
        if (boundIndex == null
            && indexSyntax is not DefaultExpressionSyntax
            && indexSyntax is not InterpolatedStringExpressionSyntax)
        {
            boundIndex = BindExpression(indexSyntax);
            if (boundIndex is BoundErrorExpression)
            {
                return boundIndex;
            }

            if (IsSystemRangeType(boundIndex.Type))
            {
                return BindRangeValueSlice(target, boundIndex, targetLocation);
            }

            if (ClrTypeUtilities.AreSame(boundIndex.Type.ClrType, typeof(System.Index)))
            {
                return BindSystemIndexAccess(target, boundIndex, targetLocation);
            }
        }

        BoundExpression ConvertIndex(TypeSymbol conversionTargetType) =>
            boundIndex != null
                ? conversions.BindConversion(indexSyntax.Location, boundIndex, conversionTargetType)
                : conversions.BindConversion(indexSyntax, conversionTargetType);

        BoundExpression BoundIndexArg() => boundIndex ?? BindExpression(indexSyntax);

        // Phase 3.A.4: map indexing `m[k]` — key bound to K, result type V.
        // The Go convention "zero value if missing" applies at evaluation;
        // the bound representation reuses BoundIndexExpression with the
        // element type set to V.
        if (target.Type is MapTypeSymbol mapType)
        {
            var key = ConvertIndex(mapType.KeyType);
            return new BoundIndexExpression(null, target, key, mapType.ValueType);
        }

        var element = GetIndexElementType(target.Type);
        if (element != null)
        {
            // Issue #1279: array/slice element access accepts any integer-typed
            // index (matching C#). `boundIndex` is non-null for every non-
            // default/interpolated index; those two carry no natural type and
            // keep the historical int32 conversion driven by the target type.
            var index = boundIndex != null
                ? ConvertArrayElementIndex(indexSyntax.Location, boundIndex)
                : ConvertIndex(TypeSymbol.Int32);
            return new BoundIndexExpression(null, target, index, element);
        }

        // Issue #1129: `string` is the primitive `TypeSymbol.String` (not an
        // `ImportedTypeSymbol`), so it matches none of the indexer-resolution
        // branches below. Model `s[i]` against .NET's `String` indexer
        // (`char this[int]` / `get_Chars(int)`), yielding a `char`. Issue #1279:
        // any integer-typed index is accepted; because `get_Chars` takes an
        // int32, the wider integer types convert (narrow) to int32. Emit already
        // lowers a `BoundIndexExpression` whose target is `string` to `get_Chars`
        // (#537).
        if (target.Type == TypeSymbol.String)
        {
            var index = boundIndex != null
                ? ConvertStringCharIndex(indexSyntax.Location, boundIndex)
                : ConvertIndex(TypeSymbol.Int32);
            return new BoundIndexExpression(null, target, index, TypeSymbol.Char);
        }

        // Phase 4 exit: CLR indexer read on an imported reference type
        // (e.g. `d["k"]` on Dictionary[string, int]). Pick a public
        // instance indexer (a `PropertyInfo` whose `GetIndexParameters()`
        // matches the single argument by assignability).
        // Issue #209: when the target carries inner-position nullable flags,
        // use them to type the element correctly (e.g., `list[0]` on `List<string?>` → `string?`).
        if (target.Type is TypeParameterSymbol tpIndexTarget
            && tpIndexTarget.ClrInterfaceConstraint is TypeSymbol clrIndexConstraint
            && clrIndexConstraint.ClrType is System.Type clrConstraintType)
        {
            var idxArgs = ImmutableArray.Create(BoundIndexArg());
            if (this.memberLookup.TryResolveClrIndexer(
                clrIndexConstraint,
                clrConstraintType,
                idxArgs,
                out var idxProp,
                out var resolvedIdxArgs))
            {
                if (idxProp.GetGetMethod(nonPublic: false) == null)
                {
                    Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type);
                    return new BoundErrorExpression(null);
                }

                var elementType = MemberLookup.GetClrPropertyTypeSymbol(clrIndexConstraint, idxProp);
                var declaringInterface = MemberLookup.GetClrMemberDeclaringTypeSymbol(
                    clrIndexConstraint,
                    idxProp);
                var convertedIdxArgs = BindClrIndexerArguments(
                    clrIndexConstraint,
                    idxProp,
                    resolvedIdxArgs,
                    indexSyntax.Location);
                return ConversionClassifier.AutoDereferenceRefReturn(
                    new BoundClrIndexExpression(
                        null,
                        target,
                        idxProp,
                        convertedIdxArgs,
                        elementType,
                        tpIndexTarget,
                        declaringInterface));
            }
        }
        else if (target.Type is NullabilityAnnotatedTypeSymbol annotIdx && annotIdx.ClrType is System.Type clrAnnotIdx)
        {
            var idxArgsAnnot = ImmutableArray.Create(BoundIndexArg());
            if (this.memberLookup.TryResolveClrIndexer(target.Type, clrAnnotIdx, idxArgsAnnot, out var idxPropAnnot, out var resolvedIdxArgsAnnot))
            {
                var elemTypeAnnot = annotIdx.GetTypeArgumentSymbolForClrType(idxPropAnnot.PropertyType);
                var convertedIdxArgsAnnot = BindClrIndexerArguments(
                    target.Type,
                    idxPropAnnot,
                    resolvedIdxArgsAnnot,
                    indexSyntax.Location);
                return ConversionClassifier.AutoDereferenceRefReturn(new BoundClrIndexExpression(null, target, idxPropAnnot, convertedIdxArgsAnnot, elemTypeAnnot));
            }
        }
        else if ((target.Type is ImportedTypeSymbol || target.Type is StructSymbol) && target.Type.ClrType is System.Type clrTarget)
        {
            var idxArgs = ImmutableArray.Create(BoundIndexArg());
            if (this.memberLookup.TryResolveClrIndexer(target.Type, clrTarget, idxArgs, out var idxProp, out var resolvedIdxArgs))
            {
                var elementType = target.Type is ImportedTypeSymbol imported
                    ? MapErasedIndexerElementType(imported, idxProp)
                    : ClrNullability.GetPropertyTypeSymbol(idxProp);
                var convertedIdxArgs = BindClrIndexerArguments(
                    target.Type,
                    idxProp,
                    resolvedIdxArgs,
                    indexSyntax.Location);
                return ConversionClassifier.AutoDereferenceRefReturn(new BoundClrIndexExpression(null, target, idxProp, convertedIdxArgs, elementType));
            }
        }

        // ADR-0118 / issue #944: index access on a user-defined type that
        // declares an indexer member (`prop this[i T] U`). Binds `obj[i]` to a
        // call of the indexer getter (`obj.get_Item(i)`).
        if (target.Type is StructSymbol userIndexTarget
            && TryGetUserIndexer(userIndexTarget, out var readIndexer, out var readSubstitution)
            && readIndexer.Parameters.Length == 1)
        {
            if (readIndexer.GetterSymbol == null)
            {
                Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type);
                return new BoundErrorExpression(null);
            }

            var paramType = readSubstitution != null
                ? Binder.SubstituteType(readIndexer.Parameters[0].Type, readSubstitution, scope.References.MapClrTypeToReferences)
                : readIndexer.Parameters[0].Type;
            var indexArg = ConvertIndex(paramType);
            var elementType = readSubstitution != null
                ? Binder.SubstituteType(readIndexer.Type, readSubstitution, scope.References.MapClrTypeToReferences)
                : readIndexer.Type;
            return new BoundUserInstanceCallExpression(
                null,
                target,
                readIndexer.GetterSymbol,
                ImmutableArray.Create(indexArg),
                elementType);
        }

        // ADR-0149 follow-up (issue #2370): index access through an
        // INTERFACE-typed receiver (`asIface[i]`, `b: IBox; b[0]`). Interfaces
        // could not declare indexers at all before ADR-0149, so this branch
        // never had a symbol to resolve; now that `prop this[...] T` is legal
        // inside a G# interface body, dispatch it exactly like the concrete
        // struct/class case above — `callvirt` through the interface's OWN
        // get_Item slot (registered in `MethodHandles`/`ResolveUserInterfaceInstanceMethodToken`
        // by the emitter regardless of whether the implementer satisfies the
        // slot implicitly or via an explicit `(IFoo)` clause).
        if (target.Type is InterfaceSymbol userIndexIface
            && TryGetUserIndexer(userIndexIface, out var readIfaceIndexer, out var readIfaceSubstitution)
            && readIfaceIndexer.Parameters.Length == 1)
        {
            if (readIfaceIndexer.GetterSymbol == null)
            {
                Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type);
                return new BoundErrorExpression(null);
            }

            var paramType = readIfaceSubstitution != null
                ? Binder.SubstituteType(readIfaceIndexer.Parameters[0].Type, readIfaceSubstitution, scope.References.MapClrTypeToReferences)
                : readIfaceIndexer.Parameters[0].Type;
            var indexArg = ConvertIndex(paramType);
            var elementType = readIfaceSubstitution != null
                ? Binder.SubstituteType(readIfaceIndexer.Type, readIfaceSubstitution, scope.References.MapClrTypeToReferences)
                : readIfaceIndexer.Type;
            return new BoundUserInstanceCallExpression(
                null,
                target,
                readIfaceIndexer.GetterSymbol,
                ImmutableArray.Create(indexArg),
                elementType);
        }

        if (target.Type != TypeSymbol.Error)
        {
            Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type);
        }

        return new BoundErrorExpression(null);
    }

    /// <summary>
    /// ADR-0149 follow-up (issue #2370): the interface counterpart of
    /// <see cref="TryGetUserIndexer(StructSymbol, out PropertySymbol, out Dictionary{TypeParameterSymbol, TypeSymbol})"/>.
    /// Walks <paramref name="target"/> and its base interfaces
    /// (<see cref="InterfaceSymbol.SelfAndAllBaseInterfaces"/>) for the first
    /// declared indexer (an interface may declare at most one <c>this[...]</c>
    /// slot per ADR-0149's parameter-shape uniqueness rule — multiple
    /// interfaces with DIFFERENT indexer shapes are disambiguated by the
    /// static receiver TYPE at the call site, exactly like ordinary named
    /// members), building the type-parameter substitution for a constructed
    /// generic receiver (e.g. <c>IBox[int32]</c> over <c>interface IBox[T]</c>).
    /// </summary>
    private static bool TryGetUserIndexer(
        InterfaceSymbol target,
        out PropertySymbol indexer,
        out Dictionary<TypeParameterSymbol, TypeSymbol> substitution)
    {
        indexer = null;
        substitution = null;

        foreach (var iface in target.SelfAndAllBaseInterfaces())
        {
            var def = iface.Definition ?? iface;
            foreach (var p in def.Properties)
            {
                if (p.IsIndexer)
                {
                    indexer = p;
                    break;
                }
            }

            if (indexer != null)
            {
                break;
            }
        }

        if (indexer == null)
        {
            return false;
        }

        // Build the type-parameter substitution for a constructed generic
        // receiver (e.g. `IBox[int32]` over `interface IBox[T]`).
        if (!target.TypeArguments.IsDefaultOrEmpty
            && target.Definition != null
            && !ReferenceEquals(target.Definition, target))
        {
            var defTps = target.Definition.TypeParameters;
            if (!defTps.IsDefaultOrEmpty && defTps.Length == target.TypeArguments.Length)
            {
                substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>(defTps.Length);
                for (var i = 0; i < defTps.Length; i++)
                {
                    substitution[defTps[i]] = target.TypeArguments[i];
                }
            }
        }

        return true;
    }

    private BoundExpression BindIndexedWriteThroughChain(
        BoundExpression chainBase,
        ExpressionSyntax remainingChain,
        ExpressionSyntax indexSyntax,
        ExpressionSyntax valueSyntax,
        BoundExpression boundValueOverride,
        SyntaxToken compoundOperatorToken,
        ExpressionSyntax compoundRhsSyntax,
        TextLocation diagnosticLocation,
        SyntaxNode outerSyntax)
    {
        if (TrySplitAtLeftmostNullConditional(remainingChain, out var leftSyntax, out var rightSyntax))
        {
            BoundExpression boundLeft = chainBase == null
                ? BindExpression(leftSyntax)
                : BindAccessorStep(chainBase, null, leftSyntax);
            if (boundLeft is BoundErrorExpression || boundLeft.Type == TypeSymbol.Error)
            {
                return new BoundErrorExpression(null);
            }

            TypeSymbol underlying;
            if (boundLeft.Type is NullableTypeSymbol nullable)
            {
                underlying = nullable.UnderlyingType;
            }
            else if (boundLeft.Type == TypeSymbol.Null)
            {
                // Statically nil receiver: assignment is a no-op. Produce a
                // bound literal null so the surrounding expression sees a
                // well-typed value; lowering treats `null` literals as
                // statement-position no-ops.
                return new BoundLiteralExpression(null, null);
            }
            else
            {
                // Non-nullable receiver: `?.` degenerates to `.`, but we still
                // produce a nullable result type for syntactic consistency
                // with the read-side null-conditional path.
                underlying = boundLeft.Type;
            }

            var captureName = "$ncap_" + (++binderCtx.NullConditionalCaptureCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
            var capture = new LocalVariableSymbol(captureName, isReadOnly: true, type: underlying);
            scope = new BoundScope(scope);
            scope.TryDeclareVariable(capture);

            var captureRef = new BoundVariableExpression(null, capture);
            var whenNotNull = BindIndexedWriteThroughChain(
                chainBase: captureRef,
                remainingChain: rightSyntax,
                indexSyntax,
                valueSyntax,
                boundValueOverride,
                compoundOperatorToken,
                compoundRhsSyntax,
                diagnosticLocation,
                outerSyntax);

            scope = scope.Parent;

            if (whenNotNull is BoundErrorExpression)
            {
                return whenNotNull;
            }

            var resultType = whenNotNull.Type is NullableTypeSymbol
                ? whenNotNull.Type
                : (TypeSymbol)NullableTypeSymbol.Get(whenNotNull.Type);

            LocalVariableSymbol resultSlot = null;
            if (resultType is NullableTypeSymbol nullableResult
                && nullableResult.UnderlyingType?.ClrType is { IsValueType: true })
            {
                var resultSlotName = "$nres_" + binderCtx.NullConditionalCaptureCounter.ToString(System.Globalization.CultureInfo.InvariantCulture);
                resultSlot = new LocalVariableSymbol(resultSlotName, isReadOnly: false, type: resultType);
            }

            return new BoundNullConditionalAccessExpression(null, boundLeft, capture, whenNotNull, resultType, resultSlot);
        }

        BoundExpression boundReceiver = chainBase == null
            ? BindExpression(remainingChain)
            : BindAccessorStep(chainBase, null, remainingChain);
        if (boundReceiver is BoundErrorExpression || boundReceiver.Type == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        var tempName = $"<idxAsn{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>";
        var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, boundReceiver.Type);
        if (!scope.TryDeclareVariable(tempVar))
        {
            // Defensive: synthesized names cannot collide with user identifiers
            // (the `<...>` prefix is not a valid identifier token), so a failure
            // here means a duplicate synthesized name within the same scope,
            // which Interlocked.Increment guarantees against. Treat as fatal.
            throw new System.InvalidOperationException(
                $"Failed to declare synthesized index-assignment target local '{tempName}'.");
        }

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(new BoundVariableDeclaration(outerSyntax, tempVar, boundReceiver));

        BoundExpression assignment;
        if (compoundOperatorToken != null)
        {
            if (!SyntaxFacts.TryGetCompoundAssignmentBaseOperator(compoundOperatorToken.Kind, out var baseOpKind))
            {
                // Defensive: parser only emits this node for kinds recognised
                // by TryGetCompoundAssignmentBaseOperator above.
                return new BoundErrorExpression(null);
            }

            BoundExpression sharedIndex = null;
            if (indexSyntax is FromEndIndexExpressionSyntax)
            {
                _ = TryBindSystemIndexValue(indexSyntax, out var boundSystemIndex);
                var indexLocal = DeclareRangeTemp("index", boundSystemIndex.Type, boundSystemIndex, statements);
                sharedIndex = new BoundVariableExpression(null, indexLocal);
            }

            var tempRef = new BoundVariableExpression(null, tempVar);
            var indexRead = BindIndexAgainstTarget(tempRef, indexSyntax, diagnosticLocation, sharedIndex);
            if (indexRead is BoundErrorExpression)
            {
                return indexRead;
            }

            if (sharedIndex == null
                && TryCaptureCompoundIndexArgument(ref indexRead, statements, out var capturedIndex))
            {
                sharedIndex = capturedIndex;
            }
            else if (sharedIndex == null
                && indexSyntax is not DefaultExpressionSyntax
                && indexSyntax is not RangeExpressionSyntax)
            {
                var boundIndex = BindExpression(indexSyntax);
                if (boundIndex is BoundErrorExpression)
                {
                    return boundIndex;
                }

                var indexLocal = DeclareRangeTemp("index", boundIndex.Type, boundIndex, statements);
                sharedIndex = new BoundVariableExpression(null, indexLocal);
                indexRead = BindIndexAgainstTarget(tempRef, indexSyntax, diagnosticLocation, sharedIndex);
                if (indexRead is BoundErrorExpression)
                {
                    return indexRead;
                }
            }

            var rhsBound = BindExpression(compoundRhsSyntax);
            if (rhsBound is BoundErrorExpression || rhsBound.Type == TypeSymbol.Error)
            {
                return new BoundErrorExpression(null);
            }

            // issue #1226 / #1246: the right operand of a compound element/indexer
            // assignment (`data[i] op= v`, including the synthetic `1` for
            // `++`/`--`) participates in the SAME constant-integer-literal
            // adaptation and implicit numeric widening as the equivalent binary
            // `data[i] op v`, via the shared adaptation helper.
            var combined = TryBindCompoundBinaryOperation(baseOpKind, indexRead, rhsBound, compoundRhsSyntax.Location);
            if (combined == null)
            {
                Diagnostics.ReportUndefinedBinaryOperator(
                    compoundOperatorToken.Location,
                    compoundOperatorToken.Text,
                    indexRead.Type,
                    rhsBound.Type);
                return new BoundErrorExpression(null);
            }

            assignment = BindIndexedAssignmentToVariableWithBoundValue(
                tempVar,
                indexSyntax,
                combined,
                diagnosticLocation,
                sharedIndex);
        }
        else if (boundValueOverride != null)
        {
            assignment = BindIndexedAssignmentToVariableWithBoundValue(tempVar, indexSyntax, boundValueOverride, diagnosticLocation);
        }
        else
        {
            assignment = BindIndexedAssignmentToVariable(tempVar, indexSyntax, valueSyntax, diagnosticLocation);
        }

        if (assignment is BoundErrorExpression)
        {
            return assignment;
        }

        return new BoundBlockExpression(outerSyntax, statements.ToImmutable(), assignment);
    }

    private bool TryCaptureCompoundIndexArgument(
        ref BoundExpression indexRead,
        ImmutableArray<BoundStatement>.Builder statements,
        out BoundExpression capturedIndex)
    {
        BoundExpression Capture(BoundExpression argument)
        {
            var indexLocal = DeclareRangeTemp("index", argument.Type, argument, statements);
            return new BoundVariableExpression(null, indexLocal);
        }

        switch (indexRead)
        {
            case BoundClrIndexExpression clrIndex when clrIndex.Arguments.Length == 1:
                capturedIndex = Capture(clrIndex.Arguments[0]);
                indexRead = new BoundClrIndexExpression(
                    null,
                    clrIndex.Target,
                    clrIndex.Indexer,
                    ImmutableArray.Create(capturedIndex),
                    clrIndex.Type);
                return true;

            case BoundDereferenceExpression { Operand: BoundClrIndexExpression clrRefIndex }
                when clrRefIndex.Arguments.Length == 1:
                capturedIndex = Capture(clrRefIndex.Arguments[0]);
                indexRead = new BoundDereferenceExpression(
                    null,
                    new BoundClrIndexExpression(
                        null,
                        clrRefIndex.Target,
                        clrRefIndex.Indexer,
                        ImmutableArray.Create(capturedIndex),
                        clrRefIndex.Type));
                return true;

            case BoundIndexExpression builtInIndex:
                capturedIndex = Capture(builtInIndex.Index);
                indexRead = new BoundIndexExpression(
                    null,
                    builtInIndex.Target,
                    capturedIndex,
                    builtInIndex.Type);
                return true;

            case BoundUserInstanceCallExpression userIndex when userIndex.Arguments.Length == 1:
                capturedIndex = Capture(userIndex.Arguments[0]);
                indexRead = new BoundUserInstanceCallExpression(
                    null,
                    userIndex.Receiver,
                    userIndex.Method,
                    ImmutableArray.Create(capturedIndex),
                    userIndex.Type,
                    userIndex.ConstrainedReceiverTypeParameter,
                    userIndex.ConstrainedInterfaceType)
                {
                    MethodTypeArguments = userIndex.MethodTypeArguments,
                };
                return true;

            default:
                capturedIndex = null;
                return false;
        }
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

    private BoundExpression BindIndexedAssignmentToVariable(
        VariableSymbol variable,
        ExpressionSyntax indexSyntax,
        ExpressionSyntax valueSyntax,
        TextLocation diagnosticLocation)
    {
        return BindIndexedAssignmentToVariableCore(
            variable, indexSyntax, valueSyntax, boundValueOverride: null, diagnosticLocation);
    }

    private BoundExpression BindIndexedAssignmentToVariableWithBoundValue(
        VariableSymbol variable,
        ExpressionSyntax indexSyntax,
        BoundExpression boundValue,
        TextLocation diagnosticLocation,
        BoundExpression boundIndexOverride = null)
    {
        return BindIndexedAssignmentToVariableCore(
            variable, indexSyntax, valueSyntax: null, boundValueOverride: boundValue, diagnosticLocation, boundIndexOverride);
    }

    private BoundExpression BindIndexedAssignmentToVariableCore(
        VariableSymbol variable,
        ExpressionSyntax indexSyntax,
        ExpressionSyntax valueSyntax,
        BoundExpression boundValueOverride,
        TextLocation diagnosticLocation,
        BoundExpression boundIndexOverride = null)
    {
        // Issue #2488: direct indexed writes bypass the ordinary name-expression
        // read binder, so explicitly reuse its narrowed receiver construction.
        // Member/indexer lookup sees the effective type while loads still refer
        // to the original variable slot.
        var target = BuildNarrowedVariableRead(variable);
        var targetType = target.Type;
        var hasNarrowedTarget = target is not BoundVariableExpression targetVariable
            || targetVariable.NarrowedType != null;

        BoundExpression MakeIndexAssignment(BoundExpression index, BoundExpression value, TypeSymbol elementType)
        {
            return hasNarrowedTarget
                ? BoundIndexAssignmentExpression.WithExpressionTarget(null, target, index, value, elementType)
                : new BoundIndexAssignmentExpression(null, variable, index, value, elementType);
        }

        BoundExpression MakeClrIndexAssignment(
            PropertyInfo indexer,
            ImmutableArray<BoundExpression> arguments,
            BoundExpression value,
            TypeSymbol resultType,
            TypeParameterSymbol constrainedReceiverTypeParameter = null,
            TypeSymbol constrainedInterfaceType = null)
        {
            return hasNarrowedTarget
                ? BoundClrIndexAssignmentExpression.WithExpressionTarget(
                    null,
                    target,
                    indexer,
                    arguments,
                    value,
                    resultType,
                    constrainedReceiverTypeParameter,
                    constrainedInterfaceType)
                : new BoundClrIndexAssignmentExpression(
                    null,
                    variable,
                    indexer,
                    arguments,
                    value,
                    resultType,
                    constrainedReceiverTypeParameter,
                    constrainedInterfaceType);
        }

        BoundExpression BindValue(TypeSymbol elementType)
        {
            if (boundValueOverride != null)
            {
                return conversions.BindConversion(diagnosticLocation, boundValueOverride, elementType);
            }

            return conversions.BindConversion(valueSyntax, elementType);
        }

        if (boundIndexOverride != null
            && ClrTypeUtilities.AreSame(boundIndexOverride.Type?.ClrType, typeof(System.Index)))
        {
            return BindSystemIndexAssignment(
                variable, target, targetType, hasNarrowedTarget, boundIndexOverride, BindValue, diagnosticLocation);
        }

        if (boundIndexOverride == null && TryBindSystemIndexValue(indexSyntax, out var systemIndex))
        {
            return BindSystemIndexAssignment(
                variable, target, targetType, hasNarrowedTarget, systemIndex, BindValue, diagnosticLocation);
        }

        BoundExpression BindIndexValue() => boundIndexOverride ?? BindExpression(indexSyntax);

        BoundExpression ConvertIndexValue(TypeSymbol targetType) =>
            boundIndexOverride != null
                ? conversions.BindConversion(indexSyntax.Location, boundIndexOverride, targetType)
                : conversions.BindConversion(indexSyntax, targetType);

        var element = GetIndexElementType(targetType);
        if (element != null)
        {
            var index = boundIndexOverride != null
                ? ConvertArrayElementIndex(indexSyntax.Location, boundIndexOverride)
                : BindArrayElementIndex(indexSyntax);
            var value = BindValue(element);
            return MakeIndexAssignment(index, value, element);
        }

        // ADR-0122 / issue #1014: pointer indexed write `p[i] = v` == `*(p + i) = v`.
        if (targetType is PointerTypeSymbol pointerType)
        {
            // ADR-0122 §3 / issue #1033: a `*void` pointer has no element type,
            // so an indexed write `p[i] = v` is rejected (GS0403); cast to a
            // typed pointer `*T` first.
            if (TypeSymbol.IsVoidPointer(targetType))
            {
                Diagnostics.ReportVoidPointerOperationNotAllowed(diagnosticLocation, "index");
                return new BoundErrorExpression(null);
            }

            var pointerIndex = BindIndexValue();
            if (pointerIndex is BoundErrorExpression)
            {
                return pointerIndex;
            }

            if (!IsPointerOffsetType(pointerIndex.Type))
            {
                pointerIndex = boundIndexOverride != null
                    ? conversions.BindConversion(indexSyntax.Location, pointerIndex, TypeSymbol.NInt)
                    : conversions.BindConversion(indexSyntax, TypeSymbol.NInt);
            }

            var elementPointer = LowerPointerOffset(target, pointerType, pointerIndex, subtract: false);
            var pointerValue = BindValue(pointerType.PointeeType);
            return new BoundIndirectAssignmentExpression(null, elementPointer, pointerValue);
        }

        // Phase 3.A.4: map indexed assignment `m[k] = v` — key bound to K,
        // value bound to V.
        if (targetType is MapTypeSymbol mapType)
        {
            var keyExpr = ConvertIndexValue(mapType.KeyType);
            var valExpr = BindValue(mapType.ValueType);
            return MakeIndexAssignment(keyExpr, valExpr, mapType.ValueType);
        }

        // Phase 4 exit: CLR indexer write on an imported reference type
        // (e.g. `d["k"] = 1` on Dictionary[string, int]).
        // Issue #209: honour inner-position nullable flags when present.
        if (targetType is TypeParameterSymbol tpIndexTarget
            && tpIndexTarget.ClrInterfaceConstraint is TypeSymbol clrIndexConstraint
            && clrIndexConstraint.ClrType is System.Type clrConstraintType)
        {
            var idxArgs = ImmutableArray.Create(BindIndexValue());
            if (this.memberLookup.TryResolveClrIndexer(
                clrIndexConstraint,
                clrConstraintType,
                idxArgs,
                out var idxProp,
                out var resolvedIdxArgs))
            {
                if (idxProp.GetSetMethod(nonPublic: false) == null)
                {
                    Diagnostics.ReportTypeNotIndexable(diagnosticLocation, targetType);
                    return new BoundErrorExpression(null);
                }

                var elementType = MemberLookup.GetClrPropertyTypeSymbol(clrIndexConstraint, idxProp);
                var declaringInterface = MemberLookup.GetClrMemberDeclaringTypeSymbol(
                    clrIndexConstraint,
                    idxProp);
                var value = BindValue(elementType);
                var convertedArgs = BindClrIndexerArguments(
                    clrIndexConstraint,
                    idxProp,
                    resolvedIdxArgs,
                    indexSyntax.Location);
                return MakeClrIndexAssignment(
                    idxProp,
                    convertedArgs,
                    value,
                    elementType,
                    tpIndexTarget,
                    declaringInterface);
            }
        }
        else if (targetType is NullabilityAnnotatedTypeSymbol annotWr && targetType.ClrType is System.Type clrAnnotWr)
        {
            var idxArgsAnnotWr = ImmutableArray.Create(BindIndexValue());
            if (this.memberLookup.TryResolveClrIndexer(targetType, clrAnnotWr, idxArgsAnnotWr, out var idxPropAnnotWr, out var resolvedIdxArgsAnnotWr))
            {
                if (!idxPropAnnotWr.CanWrite)
                {
                    Diagnostics.ReportTypeNotIndexable(diagnosticLocation, targetType);
                    return new BoundErrorExpression(null);
                }

                var valueTypeAnnotWr = annotWr.GetTypeArgumentSymbolForClrType(idxPropAnnotWr.PropertyType);
                var boundValueAnnotWr = BindValue(valueTypeAnnotWr);
                var convertedIdxArgsAnnotWr = BindClrIndexerArguments(
                    targetType,
                    idxPropAnnotWr,
                    resolvedIdxArgsAnnotWr,
                    indexSyntax.Location);
                return MakeClrIndexAssignment(idxPropAnnotWr, convertedIdxArgsAnnotWr, boundValueAnnotWr, valueTypeAnnotWr);
            }
        }
        else if ((targetType is ImportedTypeSymbol || targetType is StructSymbol) && targetType.ClrType is System.Type clrTarget)
        {
            var idxArgs = ImmutableArray.Create(BindIndexValue());
            if (this.memberLookup.TryResolveClrIndexer(targetType, clrTarget, idxArgs, out var idxProp, out var resolvedIdxArgs))
            {
                var convertedIdxArgs = BindClrIndexerArguments(
                    targetType,
                    idxProp,
                    resolvedIdxArgs,
                    indexSyntax.Location);

                // ADR-0056 §2: span element write. `Span[T]` has no `set_Item`; its
                // indexer is a `ref T`-returning getter and writes go through that
                // managed pointer. Detect the ref-returning getter and store through
                // it. A `ReadOnlySpan[T]` getter is `ref readonly T` — writing is a
                // hard error (GS0226).
                if (!idxProp.CanWrite)
                {
                    var refGetter = idxProp.GetGetMethod(nonPublic: false);
                    if (refGetter != null && refGetter.ReturnType.IsByRef)
                    {
                        if (IsReadOnlyRefReturn(idxProp, refGetter))
                        {
                            Diagnostics.ReportCannotAssignReadOnlySpanElement(diagnosticLocation, targetType);
                            return new BoundErrorExpression(null);
                        }

                        var resolvedElementType = targetType is ImportedTypeSymbol importedRefReturn
                            ? MapErasedIndexerElementType(importedRefReturn, idxProp)
                            : ResolveIndexerElementType(targetType, idxProp);
                        var pointeeType = resolvedElementType is ByRefTypeSymbol byRef
                            ? byRef.PointeeType
                            : TypeSymbol.FromClrType(refGetter.ReturnType.GetElementType()!);
                        var refValue = BindValue(pointeeType);
                        return MakeClrIndexAssignment(idxProp, convertedIdxArgs, refValue, pointeeType);
                    }

                    Diagnostics.ReportTypeNotIndexable(diagnosticLocation, targetType);
                    return new BoundErrorExpression(null);
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
                var valueType = targetType is ImportedTypeSymbol imported
                    ? MapErasedIndexerElementType(imported, idxProp)
                    : ClrNullability.GetPropertyTypeSymbol(idxProp);
                var boundValue = BindValue(valueType);
                return MakeClrIndexAssignment(idxProp, convertedIdxArgs, boundValue, valueType);
            }
        }

        // ADR-0118 / issue #944: index assignment on a user-defined type that
        // declares an indexer member. Binds `obj[i] = v` to a call of the
        // indexer setter (`obj.set_Item(i, v)`).
        if (targetType is StructSymbol userIndexTarget
            && TryGetUserIndexer(userIndexTarget, out var writeIndexer, out var writeSubstitution)
            && writeIndexer.Parameters.Length == 1)
        {
            if (writeIndexer.SetterSymbol == null)
            {
                Diagnostics.ReportTypeNotIndexable(diagnosticLocation, targetType);
                return new BoundErrorExpression(null);
            }

            var paramType = writeSubstitution != null
                ? Binder.SubstituteType(writeIndexer.Parameters[0].Type, writeSubstitution, scope.References.MapClrTypeToReferences)
                : writeIndexer.Parameters[0].Type;
            var elementType = writeSubstitution != null
                ? Binder.SubstituteType(writeIndexer.Type, writeSubstitution, scope.References.MapClrTypeToReferences)
                : writeIndexer.Type;

            var indexArg = ConvertIndexValue(paramType);
            var value = BindValue(elementType);
            return new BoundUserInstanceCallExpression(
                null,
                target,
                writeIndexer.SetterSymbol,
                ImmutableArray.Create(indexArg, value));
        }

        // ADR-0149 follow-up (issue #2370): index assignment through an
        // INTERFACE-typed receiver — the write-side counterpart of the read
        // branch above. Dispatches via `callvirt` through the interface's own
        // set_Item slot.
        if (targetType is InterfaceSymbol writeIndexIface
            && TryGetUserIndexer(writeIndexIface, out var writeIfaceIndexer, out var writeIfaceSubstitution)
            && writeIfaceIndexer.Parameters.Length == 1)
        {
            if (writeIfaceIndexer.SetterSymbol == null)
            {
                Diagnostics.ReportTypeNotIndexable(diagnosticLocation, targetType);
                return new BoundErrorExpression(null);
            }

            var paramType = writeIfaceSubstitution != null
                ? Binder.SubstituteType(writeIfaceIndexer.Parameters[0].Type, writeIfaceSubstitution, scope.References.MapClrTypeToReferences)
                : writeIfaceIndexer.Parameters[0].Type;
            var elementType = writeIfaceSubstitution != null
                ? Binder.SubstituteType(writeIfaceIndexer.Type, writeIfaceSubstitution, scope.References.MapClrTypeToReferences)
                : writeIfaceIndexer.Type;

            var indexArg = ConvertIndexValue(paramType);
            var value = BindValue(elementType);
            return new BoundUserInstanceCallExpression(
                null,
                target,
                writeIfaceIndexer.SetterSymbol,
                ImmutableArray.Create(indexArg, value));
        }

        if (targetType != TypeSymbol.Error)
        {
            Diagnostics.ReportTypeNotIndexable(diagnosticLocation, targetType);
        }

        return new BoundErrorExpression(null);
    }

    private ImmutableArray<BoundExpression> BindClrIndexerArguments(
        TypeSymbol targetType,
        PropertyInfo indexer,
        ImmutableArray<BoundExpression> arguments,
        TextLocation diagnosticLocation)
    {
        var converted = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
        for (var i = 0; i < arguments.Length; i++)
        {
            var parameterType = MemberLookup.GetIndexerParameterTypeSymbol(targetType, indexer, i);
            converted.Add(conversions.BindConversion(diagnosticLocation, arguments[i], parameterType));
        }

        return converted.MoveToImmutable();
    }

    private static TypeSymbol MapErasedIndexerElementType(ImportedTypeSymbol target, PropertyInfo closedIndexer)
    {
        var symbolicType = MemberLookup.GetClrPropertyTypeSymbol(target, closedIndexer);
        if (TypeSymbol.RequiresSymbolicProjection(symbolicType))
        {
            return symbolicType;
        }

        // Issue #313 (HasTypeParameterArgument): substitute the open indexer's
        // generic-parameter result back through the target's symbolic type
        // arguments so `list[i]` on `List[T]` is typed as `T`.
        // Issue #671: also substitute when the target is a constructed
        // generic with G# user-defined or nested-symbolic type arguments
        // (e.g. `outer[0]` on `List[List[MyGs]]` -> `List[MyGs]`); without
        // this the element would type-erase to `List<object>` and downstream
        // member access on the result would emit against the wrong parent.
        if (target.HasSubstitutableTypeArgument
            && target.OpenDefinition is System.Type openDefinition)
        {
            try
            {
                var openIndexer = MemberLookup.FindOpenIndexerDefinition(openDefinition, closedIndexer);
                if (openIndexer?.PropertyType is System.Type openElement)
                {
                    // ADR-0056 §1/§2: a ref-returning indexer (e.g. `Span[T]`)
                    // surfaces its element as `T&`; map it through a
                    // `ByRefTypeSymbol` so §1 auto-dereference applies.
                    var openCore = openElement.IsByRef ? openElement.GetElementType()! : openElement;
                    if (openCore.IsGenericParameter)
                    {
                        var position = openCore.GenericParameterPosition;
                        if (position >= 0 && position < target.TypeArguments.Length)
                        {
                            var arg = target.TypeArguments[position];
                            return openElement.IsByRef ? ByRefTypeSymbol.Get(arg) : arg;
                        }
                    }
                }
            }
            catch (System.Reflection.AmbiguousMatchException)
            {
                // Fall back to the erased element type below.
            }
        }

        // ADR-0056 §2: a closed ref-returning indexer (e.g. `ReadOnlySpan[int32]`
        // / `Span[int32]`) reports its element as `int32&`. Surface it as a
        // `ByRefTypeSymbol` over the pointee so the read auto-dereferences (§1)
        // and the emitter loads through the managed pointer.
        var propertyType = closedIndexer.PropertyType;
        if (propertyType.IsByRef)
        {
            // Issue #1701: route the by-ref element through the same
            // nullability-aware helper as the non-byref path below (instead
            // of a raw FromClrType) so a hypothetical `ref T?` indexer
            // element keeps its `[NullableAttribute]` metadata instead of
            // silently erasing to non-null.
            return ByRefTypeSymbol.Get(ClrNullability.GetPropertyElementTypeSymbol(closedIndexer, propertyType.GetElementType()!));
        }

        // Issue #1627 (surfaced regression fix): honour the indexer's
        // `[NullableAttribute]`/`[NullableContextAttribute]` metadata (and
        // the #1354 "unannotated imported reference type defaults to
        // nullable" rule) the same way every other property/parameter read
        // does via `ClrNullability`. Without this, a plain
        // `TypeSymbol.FromClrType(propertyType)` erased a genuinely nullable
        // indexer element (e.g. `JsonNode?` for `JsonNode.this[string]`) to
        // its non-nullable form; the classification fix at
        // `Conversion.Classify` now correctly rejects an incoming `S?` value
        // against that spuriously non-nullable target instead of silently
        // dropping the `?` via the #521 leak.
        return ClrNullability.GetPropertyTypeSymbol(closedIndexer);
    }

    // Issue #1301: resolve the element type of a closed indexer against the
    // receiver's symbolic type arguments, mirroring the normal `this[int]`
    // index path. Routing the from-end (`a[^n]`) / `System.Index` indexer
    // paths through here keeps a user-defined element type `T` (whose
    // `ClrType` is null during binding) typed as `T` instead of erasing to
    // `object`.
    private static TypeSymbol ResolveIndexerElementType(TypeSymbol targetType, PropertyInfo indexer)
    {
        if (targetType is NullabilityAnnotatedTypeSymbol annot && annot.ClrType is System.Type)
        {
            return annot.GetTypeArgumentSymbolForClrType(indexer.PropertyType);
        }

        if (targetType is ImportedTypeSymbol imported)
        {
            return MapErasedIndexerElementType(imported, indexer);
        }

        var propertyType = indexer.PropertyType;
        if (propertyType.IsByRef)
        {
            // Issue #1701: same nullability-aware routing as MapErasedIndexerElementType.
            return ByRefTypeSymbol.Get(ClrNullability.GetPropertyElementTypeSymbol(indexer, propertyType.GetElementType()!));
        }

        return ClrNullability.GetPropertyTypeSymbol(indexer);
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
    /// Issue #1354: maps an imported method's return type to a
    /// <see cref="TypeSymbol"/>, applying the reference-type nullability rule
    /// (oblivious/unannotated → <c>T?</c>, explicit <c>[Nullable(1)]</c> →
    /// non-null) via <see cref="ClrNullability.GetReturnTypeSymbol"/>. This is
    /// the call-return-type counterpart of <see cref="MapClrMemberType"/>:
    /// without it, the non-generic instance-method fallback chain would land on
    /// a bare <see cref="TypeSymbol.FromClrType"/> and treat oblivious imported
    /// reference returns as non-null. The existing by-ref-return handling
    /// (e.g. <c>ref T</c> returns) is preserved.
    /// </summary>
    /// <param name="method">The imported method whose return type to map.</param>
    /// <returns>The nullability-aware return type symbol.</returns>
    private static TypeSymbol MapClrMethodReturnType(System.Reflection.MethodInfo method)
    {
        if (method == null)
        {
            return TypeSymbol.FromClrType(null);
        }

        var returnClrType = method.ReturnType;
        if (returnClrType != null && returnClrType.IsByRef)
        {
            // Preserve by-ref-return handling exactly as MapClrMemberType does.
            return ByRefTypeSymbol.Get(TypeSymbol.FromClrType(returnClrType.GetElementType()!));
        }

        return ClrNullability.GetReturnTypeSymbol(method);
    }

    // ADR-0118 / issue #944: locate a user-declared indexer member on a (possibly
    // constructed-generic) user type and, for a constructed type, build the
    // type-parameter substitution from the receiver's type arguments. The
    // returned PropertySymbol is the OPEN indexer on the type definition so its
    // get_Item/set_Item accessors resolve to the emitted MethodDef handles.
    private static bool TryGetUserIndexer(
        StructSymbol target,
        out PropertySymbol indexer,
        out Dictionary<TypeParameterSymbol, TypeSymbol> substitution)
    {
        indexer = null;
        substitution = null;

        var definition = target.Definition ?? target;
        for (var c = definition; c != null; c = c.BaseClass)
        {
            foreach (var p in c.Properties)
            {
                if (p.IsIndexer)
                {
                    indexer = p;
                    break;
                }
            }

            if (indexer != null)
            {
                break;
            }
        }

        if (indexer == null)
        {
            return false;
        }

        // Build the type-parameter substitution for a constructed generic
        // receiver (e.g. `Repo[int32]` over `class Repo[T]`).
        if (!target.TypeArguments.IsDefaultOrEmpty
            && target.Definition != null
            && !ReferenceEquals(target.Definition, target))
        {
            var defTps = target.Definition.TypeParameters;
            if (!defTps.IsDefaultOrEmpty && defTps.Length == target.TypeArguments.Length)
            {
                substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>(defTps.Length);
                for (var i = 0; i < defTps.Length; i++)
                {
                    substitution[defTps[i]] = target.TypeArguments[i];
                }
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #1330: recover the symbolic type of a static member read on a
    /// generic type constructed over an in-scope generic type parameter (e.g.
    /// <c>Comparer[TResult].Default</c>). The receiver's closed CLR shape is
    /// type-erased (<c>Comparer&lt;object&gt;</c>), so reflection reports the
    /// member's open type closed over <c>object</c>. Walk the open member on the
    /// receiver's <see cref="ImportedTypeSymbol.OpenDefinition"/> and project its
    /// type using the receiver's symbolic <see cref="ImportedTypeSymbol.TypeArguments"/>.
    /// Returns <see langword="null"/> when no substitution applies.
    /// </summary>
    private static TypeSymbol ResolveStaticMemberTypeFromSymbolicReceiver(ImportedTypeSymbol symbolicReceiver, MemberInfo closedMember)
    {
        if (symbolicReceiver?.OpenDefinition == null
            || symbolicReceiver.TypeArguments.IsDefaultOrEmpty
            || closedMember == null)
        {
            return null;
        }

        try
        {
            const BindingFlags staticFlags = BindingFlags.Public | BindingFlags.Static;
            Type openMemberType = closedMember switch
            {
                PropertyInfo => ClrTypeUtilities.SafeGetProperty(symbolicReceiver.OpenDefinition, closedMember.Name, staticFlags)?.PropertyType,
                FieldInfo => symbolicReceiver.OpenDefinition.GetField(closedMember.Name, staticFlags)?.FieldType,
                _ => null,
            };
            if (openMemberType == null)
            {
                return null;
            }

            var mapped = MemberLookup.MapOpenClrTypeToSymbolic(openMemberType, symbolicReceiver.OpenDefinition, symbolicReceiver.TypeArguments);
            return TypeSymbol.ContainsTypeParameter(mapped)
                || TypeSymbol.IsSameCompilationUserTypeTopLevel(mapped)
                || openMemberType.IsGenericParameter
                || openMemberType.IsGenericType
                ? mapped
                : null;
        }
        catch (System.Reflection.AmbiguousMatchException)
        {
            return null;
        }
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
            // Issue #1418 generalizes the #1304/#1328/#1344 progression: surface
            // the symbolic projection whenever it carries a same-compilation
            // user type ANYWHERE — whether the member is the user type itself
            // (`IEnumerator[Ch].Current` -> `Ch`, #1304), a constructed generic
            // that is an enumerable collection (`Dictionary[K, V].Values` ->
            // `ValueCollection[K, V]`, #1328), a channel reader/writer
            // (`Channel[Entry].Reader` -> `ChannelReader[Entry]`, #1344), or any
            // OTHER constructed CLR generic over a user element
            // (`TaskCompletionSource[Entry].Task` -> `Task[Entry]`,
            // `Lazy[Entry]`, `IReadOnlyList[Entry]`, …). In every case the
            // mapped type keeps the type-erased closed `ClrType` (e.g.
            // `Task<object>`) for member/extension lookup — which resolves
            // against the erased shape exactly as before (proven by #1088) —
            // while its symbolic `[Entry]` argument keeps the element type from
            // collapsing to `object` for downstream projections (`await`,
            // `await for`, `.Result`, the `for … in` surface, LINQ terminals).
            //
            // The earlier #1305 worry — that surfacing a constructed generic
            // over a user element would regress method lookup — does not
            // materialize precisely because lookup reads `ClrType`, not the
            // symbolic arguments; #1328 and #1344 already proved this for the
            // collection and channel shapes, and `ContainsSameCompilationUserType`
            // simply removes the type-specific allow-list.
            //
            // When the OPEN property type is itself a bare generic parameter
            // (e.g. `KeyValuePair[K, V].Key` -> `K`, `.Value` -> `V`), the
            // receiver's closed `ClrType` may have erased *every* type argument
            // to `object` because a SIBLING argument is a same-compilation user
            // type (a constructed generic over a user element erases the whole
            // closed shape — so `KeyValuePair[uint32, E]` closes to
            // `KeyValuePair<object, object>`, erasing the concrete `uint32`
            // too). The symbolic projection is then authoritative, so prefer it
            // via the `openPropType.IsGenericParameter` arm even when the mapped
            // result no longer mentions the user type.
            return TypeSymbol.ContainsTypeParameter(mapped)
                || TypeSymbol.ContainsSameCompilationUserType(mapped)
                || openPropType.IsGenericParameter
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
    private BoundExpression BindFromEndIndex(BoundExpression target, FromEndIndexExpressionSyntax fromEnd, TextLocation targetLocation)
    {
        if (target is BoundErrorExpression || target.Type == TypeSymbol.Error || target.Type == null)
        {
            _ = BindExpression(fromEnd.Operand);
            return new BoundErrorExpression(null);
        }

        _ = TryBindSystemIndexValue(fromEnd, out var indexValue);
        return BindSystemIndexAccess(target, indexValue, targetLocation);
    }

    private bool TryBindSystemIndexValue(ExpressionSyntax syntax, out BoundExpression indexValue)
    {
        if (syntax is FromEndIndexExpressionSyntax fromEnd)
        {
            var indexCtor = typeof(System.Index).GetConstructor(new[] { typeof(int), typeof(bool) });
            var indexSym = TypeSymbol.FromClrType(typeof(System.Index));
            var offset = conversions.BindConversion(fromEnd.Operand, TypeSymbol.Int32);
            indexValue = new BoundClrConstructorCallExpression(
                null,
                typeof(System.Index),
                indexCtor,
                ImmutableArray.Create<BoundExpression>(offset, new BoundLiteralExpression(null, true)),
                indexSym);
            return true;
        }

        var bound = BindExpression(syntax);
        if (bound is not BoundErrorExpression && ClrTypeUtilities.AreSame(bound.Type.ClrType, typeof(System.Index)))
        {
            indexValue = bound;
            return true;
        }

        indexValue = null;
        return false;
    }

    private BoundExpression BindSystemIndexAccess(BoundExpression target, BoundExpression indexValue, TextLocation targetLocation)
    {
        var element = GetIndexElementType(target.Type);
        if (element != null)
        {
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            var srcLocal = DeclareRangeTemp("src", target.Type, target, statements);
            var idx = BuildSystemIndexOffset(
                indexValue,
                new BoundLenExpression(null, new BoundVariableExpression(null, srcLocal)),
                statements);
            var read = new BoundIndexExpression(null, new BoundVariableExpression(null, srcLocal), idx, element);
            return new BoundBlockExpression(null, statements.ToImmutable(), read);
        }

        var clrType = target.Type.ClrType;
        if (clrType != null)
        {
            if (TryFindIndexIndexer(clrType, out var indexIndexer))
            {
                var resultType = ResolveIndexerElementType(target.Type, indexIndexer);
                return ConversionClassifier.AutoDereferenceRefReturn(
                    new BoundClrIndexExpression(null, target, indexIndexer, ImmutableArray.Create(indexValue), resultType));
            }

            if (TryFindCountedIntIndexer(clrType, out var lengthMember, out var intIndexer))
            {
                var statements = ImmutableArray.CreateBuilder<BoundStatement>();
                var srcLocal = DeclareRangeTemp("src", target.Type, target, statements);
                var srcRef = new BoundVariableExpression(null, srcLocal);
                var lengthExpr = new BoundClrPropertyAccessExpression(null, srcRef, lengthMember, TypeSymbol.Int32);
                var idx = BuildSystemIndexOffset(indexValue, lengthExpr, statements);
                var resultType = ResolveIndexerElementType(target.Type, intIndexer);
                var read = ConversionClassifier.AutoDereferenceRefReturn(
                    new BoundClrIndexExpression(
                        null,
                        new BoundVariableExpression(null, srcLocal),
                        intIndexer,
                        ImmutableArray.Create<BoundExpression>(idx),
                        resultType));
                return new BoundBlockExpression(null, statements.ToImmutable(), read);
            }
        }

        if (target.Type is StructSymbol userTarget
            && TryGetUserIndexer(userTarget, out var userIndexer, out var substitution)
            && userIndexer.Parameters.Length == 1
            && userIndexer.GetterSymbol != null)
        {
            var parameterType = substitution != null
                ? Binder.SubstituteType(userIndexer.Parameters[0].Type, substitution, scope.References.MapClrTypeToReferences)
                : userIndexer.Parameters[0].Type;
            if (ClrTypeUtilities.AreSame(parameterType.ClrType, typeof(System.Index)))
            {
                var resultType = substitution != null
                    ? Binder.SubstituteType(userIndexer.Type, substitution, scope.References.MapClrTypeToReferences)
                    : userIndexer.Type;
                return new BoundUserInstanceCallExpression(
                    null,
                    target,
                    userIndexer.GetterSymbol,
                    ImmutableArray.Create(conversions.BindConversion(targetLocation, indexValue, parameterType)),
                    resultType);
            }
        }

        Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type);
        return new BoundErrorExpression(null);
    }

    private BoundExpression BindSystemIndexAssignment(
        VariableSymbol variable,
        BoundExpression target,
        TypeSymbol targetType,
        bool hasNarrowedTarget,
        BoundExpression indexValue,
        Func<TypeSymbol, BoundExpression> bindValue,
        TextLocation diagnosticLocation)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();

        var element = GetIndexElementType(targetType);
        if (element != null)
        {
            var idx = BuildSystemIndexOffset(
                indexValue,
                new BoundLenExpression(null, target),
                statements);
            var assignment = hasNarrowedTarget
                ? BoundIndexAssignmentExpression.WithExpressionTarget(null, target, idx, bindValue(element), element)
                : new BoundIndexAssignmentExpression(null, variable, idx, bindValue(element), element);
            return new BoundBlockExpression(null, statements.ToImmutable(), assignment);
        }

        var clrType = targetType.ClrType;
        if (clrType != null)
        {
            PropertyInfo indexer;
            ImmutableArray<BoundExpression> arguments;
            if (TryFindIndexIndexer(clrType, out indexer))
            {
                arguments = ImmutableArray.Create(indexValue);
            }
            else if (TryFindCountedIntIndexer(clrType, out var lengthMember, out indexer))
            {
                var lengthExpr = new BoundClrPropertyAccessExpression(
                    null,
                    target,
                    lengthMember,
                    TypeSymbol.Int32);
                arguments = ImmutableArray.Create(BuildSystemIndexOffset(indexValue, lengthExpr, statements));
            }
            else
            {
                Diagnostics.ReportTypeNotIndexable(diagnosticLocation, targetType);
                return new BoundErrorExpression(null);
            }

            var getter = indexer.GetGetMethod(nonPublic: false);
            var valueType = ResolveIndexerElementType(targetType, indexer);
            if (!indexer.CanWrite)
            {
                if (getter == null || !getter.ReturnType.IsByRef)
                {
                    Diagnostics.ReportTypeNotIndexable(diagnosticLocation, targetType);
                    return new BoundErrorExpression(null);
                }

                if (IsReadOnlyRefReturn(indexer, getter))
                {
                    Diagnostics.ReportCannotAssignReadOnlySpanElement(diagnosticLocation, targetType);
                    return new BoundErrorExpression(null);
                }

                valueType = valueType is ByRefTypeSymbol byRef ? byRef.PointeeType : valueType;
            }

            var assignment = hasNarrowedTarget
                ? BoundClrIndexAssignmentExpression.WithExpressionTarget(
                    null, target, indexer, arguments, bindValue(valueType), valueType)
                : new BoundClrIndexAssignmentExpression(
                    null, variable, indexer, arguments, bindValue(valueType), valueType);
            return new BoundBlockExpression(null, statements.ToImmutable(), assignment);
        }

        if (targetType is StructSymbol userTarget
            && TryGetUserIndexer(userTarget, out var userIndexer, out var substitution)
            && userIndexer.Parameters.Length == 1
            && userIndexer.SetterSymbol != null)
        {
            var parameterType = substitution != null
                ? Binder.SubstituteType(userIndexer.Parameters[0].Type, substitution, scope.References.MapClrTypeToReferences)
                : userIndexer.Parameters[0].Type;
            if (ClrTypeUtilities.AreSame(parameterType.ClrType, typeof(System.Index)))
            {
                var valueType = substitution != null
                    ? Binder.SubstituteType(userIndexer.Type, substitution, scope.References.MapClrTypeToReferences)
                    : userIndexer.Type;
                return new BoundUserInstanceCallExpression(
                    null,
                    target,
                    userIndexer.SetterSymbol,
                    ImmutableArray.Create(
                        conversions.BindConversion(diagnosticLocation, indexValue, parameterType),
                        bindValue(valueType)));
            }
        }

        Diagnostics.ReportTypeNotIndexable(diagnosticLocation, targetType);
        return new BoundErrorExpression(null);
    }

    private BoundExpression BuildSystemIndexOffset(
        BoundExpression indexValue,
        BoundExpression length,
        ImmutableArray<BoundStatement>.Builder statements)
    {
        var indexLocal = DeclareRangeTemp("index", indexValue.Type, indexValue, statements);
        var getOffset = typeof(System.Index).GetMethod("GetOffset", new[] { typeof(int) });
        return new BoundImportedInstanceCallExpression(
            null,
            new BoundVariableExpression(null, indexLocal),
            getOffset,
            TypeSymbol.Int32,
            ImmutableArray.Create(length));
    }

    // `length - n` for a from-end index `^n`.
    private BoundExpression MakeFromEndOffset(FromEndIndexExpressionSyntax fromEnd, BoundExpression lengthExpr)
    {
        var offset = conversions.BindConversion(fromEnd.Operand, TypeSymbol.Int32);
        var subtractOp = BoundBinaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int32, TypeSymbol.Int32);
        return new BoundBinaryExpression(null, lengthExpr, subtractOp, offset);
    }

    private BoundExpression BindRangeSlice(BoundExpression target, RangeExpressionSyntax range, TextLocation targetLocation)
    {
        if (target is BoundErrorExpression || target.Type == TypeSymbol.Error || target.Type == null)
        {
            if (range.LowerBound != null)
            {
                _ = BindExpression(range.LowerBound);
            }

            if (range.UpperBound != null)
            {
                _ = BindExpression(range.UpperBound);
            }

            return new BoundErrorExpression(null);
        }

        var arrayElement = GetArraySliceElementType(target.Type);
        if (arrayElement != null)
        {
            return BindArraySlice(target, range, arrayElement);
        }

        if (target.Type == TypeSymbol.String)
        {
            return BindStringSlice(target, range);
        }

        var clrType = target.Type.ClrType;
        if (clrType != null)
        {
            if (TryFindRangeIndexer(clrType, out var rangeIndexer))
            {
                return BindRangeIndexerSlice(target, range, rangeIndexer);
            }

            if (TryFindSliceShape(clrType, out var lengthMember, out var sliceMethod))
            {
                return BindSpanLikeSlice(target, range, lengthMember, sliceMethod);
            }
        }

        Diagnostics.ReportTypeNotSliceable(range.Location, target.Type);
        return new BoundErrorExpression(null);
    }

    // Element type for the array/slice slicing path, or null if the target is
    // not an array/slice. Result of slicing is always a `[]T` slice.
    // Issue #1951: internal (not private) so PatternBinder.BindListPattern can
    // reuse the same array/slice-or-metadata-array recognition for list
    // patterns instead of only accepting the in-compilation
    // ArrayTypeSymbol/SliceTypeSymbol.
    internal static TypeSymbol GetArraySliceElementType(TypeSymbol type)
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

    private LocalVariableSymbol DeclareRangeTemp(string role, TypeSymbol type, BoundExpression initializer, ImmutableArray<BoundStatement>.Builder statements)
    {
        var name = "$slice_" + role + System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var local = new LocalVariableSymbol(name, isReadOnly: true, type: type);
        scope.TryDeclareVariable(local);
        statements.Add(new BoundVariableDeclaration(null, local, initializer));
        return local;
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

    // Issue #1022: bind a single range bound to an int32 offset. A from-end
    // marker `^n` lowers to `srcLen - n`; a missing bound uses
    // <paramref name="defaultValue"/>; otherwise the bound is the plain value.
    private BoundExpression BindRangeBoundValue(ExpressionSyntax boundSyntax, Func<BoundExpression> srcLenRef, BoundExpression defaultValue)
    {
        if (boundSyntax == null)
        {
            return defaultValue;
        }

        if (boundSyntax is FromEndIndexExpressionSyntax fromEnd)
        {
            var offset = conversions.BindConversion(fromEnd.Operand, TypeSymbol.Int32);
            var subtractOp = BoundBinaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int32, TypeSymbol.Int32);
            return new BoundBinaryExpression(null, srcLenRef(), subtractOp, offset);
        }

        return conversions.BindConversion(boundSyntax, TypeSymbol.Int32);
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

    private BoundExpression BindSpanLikeSlice(BoundExpression target, RangeExpressionSyntax range, MemberInfo lengthMember, MethodInfo sliceMethod)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var (srcRef, startRef, lenRef) = BuildSliceBounds(
            target,
            range,
            src => new BoundClrPropertyAccessExpression(null, src, lengthMember, TypeSymbol.Int32),
            statements);

        var returnType = TypeSymbol.FromClrType(sliceMethod.ReturnType);
        var call = new BoundImportedInstanceCallExpression(
            null,
            srcRef,
            sliceMethod,
            returnType,
            ImmutableArray.Create<BoundExpression>(startRef, lenRef));

        return new BoundBlockExpression(range, statements.ToImmutable(), call);
    }

    private BoundExpression BindRangeIndexerSlice(BoundExpression target, RangeExpressionSyntax range, PropertyInfo indexer)
    {
        var rangeValue = BuildSystemRangeValue(range);
        var resultType = TypeSymbol.FromClrType(indexer.PropertyType);
        return new BoundClrIndexExpression(range, target, indexer, ImmutableArray.Create(rangeValue), resultType);
    }

    // Issue #1016/#1022/#1038: construct a `System.Range` value from a range
    // expression's bounds. Each bound becomes a `System.Index`: an open lower
    // defaults to the start (`Index(0, fromEnd: false)`), an open upper to the
    // end (`Index(0, fromEnd: true)`), a `^n` marker to `Index(n, fromEnd:
    // true)`, and a plain value `v` to `Index(v, fromEnd: false)`. Shared by the
    // `this[System.Range]` indexer-slice path (#1016) and the standalone range
    // value `let r = 1..3` (#1038).
    private BoundExpression BuildSystemRangeValue(RangeExpressionSyntax range)
    {
        var indexCtor = typeof(System.Index).GetConstructor(new[] { typeof(int), typeof(bool) });
        var rangeCtor = typeof(System.Range).GetConstructor(new[] { typeof(System.Index), typeof(System.Index) });
        var indexSym = TypeSymbol.FromClrType(typeof(System.Index));
        var rangeSym = TypeSymbol.FromClrType(typeof(System.Range));

        BoundExpression MakeIndex(ExpressionSyntax boundSyntax, bool defaultFromEnd)
        {
            // Issue #1022: a `^n` bound becomes System.Index(n, fromEnd: true);
            // the System.Range value resolves the concrete offset at runtime.
            if (boundSyntax is FromEndIndexExpressionSyntax fromEnd)
            {
                var endValue = conversions.BindConversion(fromEnd.Operand, TypeSymbol.Int32);
                return new BoundClrConstructorCallExpression(
                    null,
                    typeof(System.Index),
                    indexCtor,
                    ImmutableArray.Create<BoundExpression>(endValue, new BoundLiteralExpression(null, true)),
                    indexSym);
            }

            var value = boundSyntax != null
                ? conversions.BindConversion(boundSyntax, TypeSymbol.Int32)
                : new BoundLiteralExpression(null, 0);
            return new BoundClrConstructorCallExpression(
                null,
                typeof(System.Index),
                indexCtor,
                ImmutableArray.Create<BoundExpression>(value, new BoundLiteralExpression(null, defaultFromEnd)),
                indexSym);
        }

        // Open lower defaults to the start (0, from-start); open upper defaults
        // to the end (^0, i.e. value 0 from-end).
        var startIndex = MakeIndex(range.LowerBound, defaultFromEnd: false);
        var endIndex = range.UpperBound != null
            ? MakeIndex(range.UpperBound, defaultFromEnd: false)
            : MakeIndex(null, defaultFromEnd: true);

        return new BoundClrConstructorCallExpression(
            null,
            typeof(System.Range),
            rangeCtor,
            ImmutableArray.Create<BoundExpression>(startIndex, endIndex),
            rangeSym);
    }

    // Issue #1038: bind a standalone range expression (`let r = 1..3`) to a
    // constructed `System.Range` value. A leading `^` at the very start is
    // genuinely ambiguous with the one's-complement unary operator, so the
    // parser reads `^a..` as `(~a)..`; reject that here (GS0410) so the from-end
    // intent isn't silently misread — use an indexer (`arr[^a..]`) or
    // parenthesise the complement (`(^a)..`).
    private BoundExpression BindStandaloneRange(RangeExpressionSyntax range)
    {
        if (range.LowerBound is UnaryExpressionSyntax leadingUnary
            && leadingUnary.OperatorToken.Kind == SyntaxKind.HatToken)
        {
            Diagnostics.ReportFromEndMarkerNotAllowedInStandaloneRange(leadingUnary.OperatorToken.Location);
            _ = BindExpression(leadingUnary.Operand);
            if (range.UpperBound != null)
            {
                _ = BindExpression(range.UpperBound is FromEndIndexExpressionSyntax fe ? fe.Operand : range.UpperBound);
            }

            return new BoundErrorExpression(range);
        }

        return BuildSystemRangeValue(range);
    }

    // Issue #1038: slice a target by a runtime `System.Range` value (`a[r]`,
    // where `r : System.Range`). Mirrors the syntactic `a[1..3]` shapes from
    // #1016 but reads the concrete `start`/`length` from the range value via
    // `System.Index.GetOffset(length)` rather than from syntactic bounds:
    //   - arrays / slices (`[N]T`, `[]T`, CLR `T[]`) -> new T[len] + Array.Copy.
    //   - `string` -> Substring(start, len).
    //   - span-like types (`int Length`/`Count` + `Slice(int, int)`).
    //   - a type exposing `this[System.Range]` -> call it with the value directly.
    private BoundExpression BindRangeValueSlice(BoundExpression target, BoundExpression rangeValue, TextLocation targetLocation)
    {
        var arrayElement = GetArraySliceElementType(target.Type);
        if (arrayElement != null)
        {
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            var (srcRef, startRef, lenRef) = BuildRangeValueBounds(
                target,
                rangeValue,
                src => new BoundLenExpression(null, src),
                statements);

            var resultType = SliceTypeSymbol.Get(arrayElement);
            var dstLocal = DeclareRangeTemp("dst", resultType, new BoundArrayCreationExpression(null, resultType, lenRef), statements);
            var dstRef = new BoundVariableExpression(null, dstLocal);

            var copyMethod = typeof(System.Array).GetMethod(
                "Copy",
                new[] { typeof(System.Array), typeof(int), typeof(System.Array), typeof(int), typeof(int) });
            var copyCall = new BoundClrStaticCallExpression(
                null,
                copyMethod,
                TypeSymbol.Void,
                ImmutableArray.Create<BoundExpression>(srcRef, startRef, dstRef, new BoundLiteralExpression(null, 0), lenRef));
            statements.Add(new BoundExpressionStatement(null, copyCall));

            return new BoundBlockExpression(null, statements.ToImmutable(), new BoundVariableExpression(null, dstLocal));
        }

        if (target.Type == TypeSymbol.String)
        {
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            var (srcRef, startRef, lenRef) = BuildRangeValueBounds(
                target,
                rangeValue,
                src => new BoundLenExpression(null, src),
                statements);

            var substring = typeof(string).GetMethod("Substring", new[] { typeof(int), typeof(int) });
            var call = new BoundImportedInstanceCallExpression(
                null,
                srcRef,
                substring,
                TypeSymbol.String,
                ImmutableArray.Create<BoundExpression>(startRef, lenRef));
            return new BoundBlockExpression(null, statements.ToImmutable(), call);
        }

        var clrType = target.Type.ClrType;
        if (clrType != null)
        {
            if (TryFindRangeIndexer(clrType, out var rangeIndexer))
            {
                var resultType = TypeSymbol.FromClrType(rangeIndexer.PropertyType);
                return new BoundClrIndexExpression(null, target, rangeIndexer, ImmutableArray.Create(rangeValue), resultType);
            }

            if (TryFindSliceShape(clrType, out var lengthMember, out var sliceMethod))
            {
                var statements = ImmutableArray.CreateBuilder<BoundStatement>();
                var (srcRef, startRef, lenRef) = BuildRangeValueBounds(
                    target,
                    rangeValue,
                    src => new BoundClrPropertyAccessExpression(null, src, lengthMember, TypeSymbol.Int32),
                    statements);

                var returnType = TypeSymbol.FromClrType(sliceMethod.ReturnType);
                var call = new BoundImportedInstanceCallExpression(
                    null,
                    srcRef,
                    sliceMethod,
                    returnType,
                    ImmutableArray.Create<BoundExpression>(startRef, lenRef));
                return new BoundBlockExpression(null, statements.ToImmutable(), call);
            }
        }

        Diagnostics.ReportTypeNotSliceable(targetLocation, target.Type);
        return new BoundErrorExpression(null);
    }

    // Issue #1038: emit the `src`/`start`/`len` temporaries for slicing by a
    // runtime `System.Range` value. The source length is computed once; the
    // range's `Start`/`End` indices are resolved to concrete offsets via
    // `System.Index.GetOffset(length)`, and `len = end - start`.
    private (BoundExpression Src, BoundExpression Start, BoundExpression Len) BuildRangeValueBounds(
        BoundExpression target,
        BoundExpression rangeValue,
        Func<BoundExpression, BoundExpression> lengthOf,
        ImmutableArray<BoundStatement>.Builder statements)
    {
        var indexSym = TypeSymbol.FromClrType(typeof(System.Index));
        var startProp = typeof(System.Range).GetProperty("Start");
        var endProp = typeof(System.Range).GetProperty("End");
        var getOffset = typeof(System.Index).GetMethod("GetOffset", new[] { typeof(int) });

        var srcLocal = DeclareRangeTemp("src", target.Type, target, statements);

        BoundExpression SrcRef() => new BoundVariableExpression(null, srcLocal);

        var srcLenLocal = DeclareRangeTemp("srclen", TypeSymbol.Int32, lengthOf(SrcRef()), statements);

        BoundExpression SrcLenRef() => new BoundVariableExpression(null, srcLenLocal);

        var rngLocal = DeclareRangeTemp("rng", rangeValue.Type, rangeValue, statements);

        BoundExpression RngRef() => new BoundVariableExpression(null, rngLocal);

        // Resolve Start/End (System.Index) into addressable locals so the
        // struct-receiver GetOffset call has an address to load.
        var startIdxLocal = DeclareRangeTemp(
            "startidx",
            indexSym,
            new BoundClrPropertyAccessExpression(null, RngRef(), startProp, indexSym),
            statements);
        var endIdxLocal = DeclareRangeTemp(
            "endidx",
            indexSym,
            new BoundClrPropertyAccessExpression(null, RngRef(), endProp, indexSym),
            statements);

        var startExpr = new BoundImportedInstanceCallExpression(
            null,
            new BoundVariableExpression(null, startIdxLocal),
            getOffset,
            TypeSymbol.Int32,
            ImmutableArray.Create<BoundExpression>(SrcLenRef()));
        var startLocal = DeclareRangeTemp("start", TypeSymbol.Int32, startExpr, statements);

        var endExpr = new BoundImportedInstanceCallExpression(
            null,
            new BoundVariableExpression(null, endIdxLocal),
            getOffset,
            TypeSymbol.Int32,
            ImmutableArray.Create<BoundExpression>(SrcLenRef()));
        var endLocal = DeclareRangeTemp("end", TypeSymbol.Int32, endExpr, statements);

        var subtractOp = BoundBinaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int32, TypeSymbol.Int32);
        var lengthExpr = new BoundBinaryExpression(
            null,
            new BoundVariableExpression(null, endLocal),
            subtractOp,
            new BoundVariableExpression(null, startLocal));
        var lenLocal = DeclareRangeTemp("len", TypeSymbol.Int32, lengthExpr, statements);

        return (
            new BoundVariableExpression(null, srcLocal),
            new BoundVariableExpression(null, startLocal),
            new BoundVariableExpression(null, lenLocal));
    }

    // Issue #1038: a `System.Range`-typed value used as an index argument
    // (`a[r]`) slices the target. Uses ClrTypeUtilities.IsSameAs per the issue
    // #835 guard against reference-identity typeof comparisons.
    private static bool IsSystemRangeType(TypeSymbol type)
    {
        return type?.ClrType != null && type.ClrType.IsSameAs(typeof(System.Range));
    }

    private static bool TryFindRangeIndexer(Type clrType, out PropertyInfo indexer)
    {
        foreach (var property in clrType.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var indexParams = property.GetIndexParameters();
            if (indexParams.Length == 1 && indexParams[0].ParameterType.IsSameAs(typeof(System.Range)))
            {
                indexer = property;
                return true;
            }
        }

        indexer = null;
        return false;
    }

    // Issue #1022: a type that exposes a `this[System.Index]` indexer can serve
    // a from-end index directly (the indexer resolves `^n` at runtime).
    private static bool TryFindIndexIndexer(Type clrType, out PropertyInfo indexer)
    {
        foreach (var property in clrType.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var indexParams = property.GetIndexParameters();
            if (indexParams.Length == 1 && indexParams[0].ParameterType.IsSameAs(typeof(System.Index)))
            {
                indexer = property;
                return true;
            }
        }

        indexer = null;
        return false;
    }

    // Issue #1022: a type with an `int Length`/`int Count` property and a
    // `this[int]` indexer (string, List<T>, span-like) can serve a from-end
    // index as `this[Length - n]`.
    private static bool TryFindCountedIntIndexer(Type clrType, out MemberInfo lengthMember, out PropertyInfo intIndexer)
    {
        lengthMember = null;
        intIndexer = null;

        var lengthProp = clrType.GetProperty("Length", BindingFlags.Public | BindingFlags.Instance);
        if (lengthProp == null || !lengthProp.PropertyType.IsSameAs(typeof(int)))
        {
            lengthProp = clrType.GetProperty("Count", BindingFlags.Public | BindingFlags.Instance);
        }

        if (lengthProp == null || !lengthProp.PropertyType.IsSameAs(typeof(int)))
        {
            return false;
        }

        foreach (var property in clrType.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var indexParams = property.GetIndexParameters();
            if (indexParams.Length == 1 && indexParams[0].ParameterType.IsSameAs(typeof(int)))
            {
                lengthMember = lengthProp;
                intIndexer = property;
                return true;
            }
        }

        return false;
    }

    private static bool TryFindSliceShape(Type clrType, out MemberInfo lengthMember, out MethodInfo sliceMethod)
    {
        lengthMember = null;
        sliceMethod = null;

        var lengthProp = clrType.GetProperty("Length", BindingFlags.Public | BindingFlags.Instance);
        if (lengthProp == null || !lengthProp.PropertyType.IsSameAs(typeof(int)))
        {
            lengthProp = clrType.GetProperty("Count", BindingFlags.Public | BindingFlags.Instance);
        }

        if (lengthProp == null || !lengthProp.PropertyType.IsSameAs(typeof(int)))
        {
            return false;
        }

        // Issue #2114: probe for `Slice(int, int)` by enumerating candidates and
        // comparing parameter types with IsSameAs, rather than the reflection
        // overload that takes a runtime Type[]. When `clrType` is a
        // MetadataLoadContext RoType (the `/reference:` resolver path), passing
        // runtime `typeof(int)` to GetMethod makes DefaultBinder.SelectMethod
        // throw "Type must be a type provided by the MetadataLoadContext" and
        // crash the compiler (GS9998). IsSameAs works across both contexts.
        MethodInfo slice = null;
        foreach (var candidate in clrType.GetMethods(BindingFlags.Public | BindingFlags.Instance))
        {
            if (candidate.Name != "Slice")
            {
                continue;
            }

            var sliceParams = candidate.GetParameters();
            if (sliceParams.Length == 2
                && sliceParams[0].ParameterType.IsSameAs(typeof(int))
                && sliceParams[1].ParameterType.IsSameAs(typeof(int)))
            {
                slice = candidate;
                break;
            }
        }

        if (slice == null)
        {
            return false;
        }

        lengthMember = lengthProp;
        sliceMethod = slice;
        return true;
    }

    // Issue #1279: array/slice element access accepts any integer-typed index
    // (matching C#). Integer types that implicitly widen to int32
    // (int8/uint8/int16/uint16/char/int32) convert to int32; the wider integer
    // types (uint32/int64/uint64/nint/nuint) convert to native int (nint),
    // which CIL ldelem/stelem/ldelema accept as the index operand. Non-integer
    // indices fall through to the int32 conversion, which reports GS0156.
    private static bool IsWideIntegerIndexType(TypeSymbol type) =>
        type == TypeSymbol.UInt32 || type == TypeSymbol.Int64 || type == TypeSymbol.UInt64
        || type == TypeSymbol.NInt || type == TypeSymbol.NUInt;

    private BoundExpression ConvertArrayElementIndex(TextLocation location, BoundExpression boundIndex)
    {
        if (IsWideIntegerIndexType(boundIndex.Type))
        {
            return conversions.BindConversion(location, boundIndex, TypeSymbol.NInt, allowExplicit: true);
        }

        return conversions.BindConversion(location, boundIndex, TypeSymbol.Int32);
    }

    // Issue #1279: `string` char-indexing (`s[i]`) lowers to the CLR
    // `get_Chars(int32)` accessor, so any integer index converts to int32 (an
    // explicit narrowing for the wider integer types). Non-integer indices
    // report GS0156 via the implicit int32 conversion.
    private BoundExpression ConvertStringCharIndex(TextLocation location, BoundExpression boundIndex)
    {
        return conversions.BindConversion(
            location, boundIndex, TypeSymbol.Int32, allowExplicit: IsWideIntegerIndexType(boundIndex.Type));
    }

    // Issue #1279: bind an array/slice element index from syntax. A
    // default/interpolated index carries no natural type, so it keeps the
    // historical target-typed int32 conversion; every other index is bound and
    // then converted via the integer-aware element-index rule above.
    private BoundExpression BindArrayElementIndex(ExpressionSyntax indexSyntax)
    {
        if (indexSyntax is DefaultExpressionSyntax || indexSyntax is InterpolatedStringExpressionSyntax)
        {
            return conversions.BindConversion(indexSyntax, TypeSymbol.Int32);
        }

        var boundIndex = BindExpression(indexSyntax);
        if (boundIndex is BoundErrorExpression)
        {
            return boundIndex;
        }

        return ConvertArrayElementIndex(indexSyntax.Location, boundIndex);
    }

    private static TypeSymbol GetIndexElementType(TypeSymbol type)
    {
        return type switch
        {
            ArrayTypeSymbol arr => arr.ElementType,
            SliceTypeSymbol slice => slice.ElementType,

            // Issue #664: CLR T[] arrays (e.g. result of string.Split) are indexable.
            ImportedTypeSymbol imp when imp.ClrType is { IsArray: true } clr && clr.GetArrayRank() == 1
                => TypeSymbol.FromClrType(clr.GetElementType()),
            NullabilityAnnotatedTypeSymbol annot when annot.ClrType is { IsArray: true } clr && clr.GetArrayRank() == 1
                => annot.GetTypeArgumentSymbolForClrType(clr.GetElementType()),
            _ => null,
        };
    }

    /// <summary>
    /// Issue #662: detect the pattern <c>valueTask.GetAwaiter().GetResult()</c> and
    /// emit warning GS0275. The pattern is unsafe due to ValueTask's single-await
    /// semantics. The safe form is <c>valueTask.AsTask().GetAwaiter().GetResult()</c>.
    /// </summary>
    private void CheckValueTaskGetAwaiterGetResult(BoundExpression boundCall, CallExpressionSyntax callSyntax)
    {
        // The outermost call must be GetResult() with 0 args on a CLR instance.
        if (boundCall is not BoundImportedInstanceCallExpression getResultCall)
        {
            return;
        }

        if (getResultCall.Method.Name != "GetResult" || getResultCall.Arguments.Length != 0)
        {
            return;
        }

        // Its receiver must be a CLR instance call to GetAwaiter() with 0 args.
        if (getResultCall.Receiver is not BoundImportedInstanceCallExpression getAwaiterCall)
        {
            return;
        }

        if (getAwaiterCall.Method.Name != "GetAwaiter" || getAwaiterCall.Arguments.Length != 0)
        {
            return;
        }

        // The receiver of GetAwaiter() must have a ValueTask or ValueTask<T> type.
        var awaiterReceiverType = getAwaiterCall.Receiver?.Type?.ClrType;
        if (awaiterReceiverType == null)
        {
            return;
        }

        string fullName;
        if (awaiterReceiverType.IsGenericType && !awaiterReceiverType.IsGenericTypeDefinition)
        {
            fullName = awaiterReceiverType.GetGenericTypeDefinition()?.FullName;
        }
        else
        {
            fullName = awaiterReceiverType.FullName;
        }

        if (fullName == "System.Threading.Tasks.ValueTask" || fullName == "System.Threading.Tasks.ValueTask`1")
        {
            Diagnostics.ReportValueTaskDirectGetResult(callSyntax.Identifier.Location);
        }
    }

    /// <summary>
    /// Issue #1235: resolves an instance field/property read named on a
    /// receiver whose static type is a <see cref="TypeParameterSymbol"/>,
    /// against the type parameter's class constraint (including inherited
    /// members) or interface constraint. Instance method <em>calls</em> are
    /// handled separately in <c>ExpressionBinder.Calls</c>; this surfaces the
    /// remaining member kinds (fields and properties) so a constrained type
    /// parameter exposes its constraint's full instance member surface.
    /// Returns <see langword="null"/> when no such member exists (so the caller
    /// reports GS0158).
    /// </summary>
    /// <param name="tpRecv">The type-parameter receiver's type.</param>
    /// <param name="receiver">The bound receiver expression.</param>
    /// <param name="ne">The member-name syntax.</param>
    /// <returns>The bound member access, or <see langword="null"/>.</returns>
    private BoundExpression BindTypeParameterInstanceMemberAccess(
        TypeParameterSymbol tpRecv,
        BoundExpression receiver,
        NameExpressionSyntax ne)
    {
        var memberName = ne.IdentifierToken.Text;

        // Class constraint (issue #1056 surfaced methods; this adds the rest):
        // fields and properties, walking the base chain of the constraint class.
        if (tpRecv.ClassConstraint is StructSymbol classConstraint)
        {
            if (TypeMemberModel.TryGetFieldIncludingInherited(classConstraint, memberName, MemberQuery.Instance(MemberKinds.Field), out var field, out var fieldDeclaringType))
            {
                reportObsoleteUseIfApplicable(ne.IdentifierToken.Location, field, $"{fieldDeclaringType.Name}.{field.Name}");

                if (!AccessibilityChecker.IsAccessible(field.Accessibility, fieldDeclaringType, this.function))
                {
                    Diagnostics.ReportMemberInaccessible(ne.IdentifierToken.Location, field.Name, fieldDeclaringType.Name, field.Accessibility);
                }

                return ApplyMemberNarrowing(new BoundFieldAccessExpression(null, receiver, fieldDeclaringType, field));
            }

            if (TypeMemberModel.TryGetProperty(classConstraint, memberName, out var prop, out var propDeclaringType))
            {
                if (!prop.HasGetter)
                {
                    Diagnostics.ReportCannotAssign(ne.Location, memberName);
                    return new BoundErrorExpression(null);
                }

                if (!AccessibilityChecker.IsAccessible(prop.Accessibility, propDeclaringType, this.function))
                {
                    Diagnostics.ReportMemberInaccessible(ne.IdentifierToken.Location, prop.Name, propDeclaringType.Name, prop.Accessibility);
                }

                return ApplyMemberNarrowing(new BoundPropertyAccessExpression(null, receiver, propDeclaringType, prop));
            }
        }

        // Interface constraint: an instance property declared on the (non-generic)
        // interface or any base interface. The getter dispatches through a
        // verifiable `box !!T; callvirt I::get_X` in the emitter.
        if (tpRecv.InterfaceConstraint is InterfaceSymbol interfaceConstraint
            && !interfaceConstraint.IsGenericDefinition
            && interfaceConstraint.TypeArguments.IsDefaultOrEmpty)
        {
            if (TypeMemberModel.TryGetProperty(interfaceConstraint, memberName, out var ifaceProp, out _))
            {
                if (!ifaceProp.HasGetter)
                {
                    Diagnostics.ReportCannotAssign(ne.Location, memberName);
                    return new BoundErrorExpression(null);
                }

                return new BoundPropertyAccessExpression(null, receiver, null, ifaceProp);
            }
        }

        if (tpRecv.ClrInterfaceConstraint is TypeSymbol clrInterfaceConstraint
            && clrInterfaceConstraint.ClrType is Type clrInterface
            && clrInterface.IsInterface)
        {
            var clrProperty = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(
                clrInterface,
                memberName,
                BindingFlags.Public | BindingFlags.Instance);
            if (clrProperty != null && clrProperty.GetIndexParameters().Length == 0)
            {
                if (clrProperty.GetGetMethod(nonPublic: false) == null)
                {
                    Diagnostics.ReportCannotAssign(ne.Location, memberName);
                    return new BoundErrorExpression(null);
                }

                var propertyType = MemberLookup.GetClrPropertyTypeSymbol(clrInterfaceConstraint, clrProperty);
                var declaringInterface = MemberLookup.GetClrMemberDeclaringTypeSymbol(
                    clrInterfaceConstraint,
                    clrProperty);
                return ConversionClassifier.AutoDereferenceRefReturn(
                    new BoundClrPropertyAccessExpression(
                        null,
                        receiver,
                        clrProperty,
                        propertyType,
                        constrainedReceiverTypeParameter: tpRecv,
                        constrainedInterfaceType: declaringInterface));
            }
        }

        return null;
    }

    /// <summary>
    /// ADR-0089 / issue #755: resolves <c>T.Method(args)</c> against the
    /// static-virtual interface members of <paramref name="tpSym"/>'s
    /// constraint. Produces a <see cref="BoundConstrainedStaticCallExpression"/>
    /// at the call site; reports GS0333 when the named member is not a
    /// static-virtual on any constraint interface.
    /// </summary>
    private BoundExpression BindTypeParameterStaticAccessorStep(
        TypeParameterSymbol tpSym,
        NameExpressionSyntax leftName,
        ExpressionSyntax rightPart)
    {
        if (tpSym.InterfaceConstraint == null)
        {
            Diagnostics.ReportStaticVirtualMemberNotFoundOnTypeParameter(
                leftName.Location, tpSym.Name, rightPart is CallExpressionSyntax ce0 ? ce0.Identifier.Text : (rightPart is NameExpressionSyntax ne0 ? ne0.IdentifierToken.Text : "?"));
            return new BoundErrorExpression(null);
        }

        switch (rightPart)
        {
            case CallExpressionSyntax callSyntax:
                {
                    var methodName = callSyntax.Identifier.Text;
                    FunctionSymbol slot = null;
                    foreach (var candidate in TypeMemberModel.GetMethods(tpSym.InterfaceConstraint, methodName, MemberQuery.Static(MemberKinds.Method)))
                    {
                        if (candidate.Parameters.Length == callSyntax.Arguments.Count)
                        {
                            slot = candidate;
                            break;
                        }
                    }

                    if (slot == null)
                    {
                        Diagnostics.ReportStaticVirtualMemberNotFoundOnTypeParameter(
                            leftName.Location, tpSym.Name, methodName);
                        return new BoundErrorExpression(null);
                    }

                    var boundArgs = ImmutableArray.CreateBuilder<BoundExpression>(callSyntax.Arguments.Count);
                    for (var i = 0; i < callSyntax.Arguments.Count; i++)
                    {
                        boundArgs.Add(BindExpression(callSyntax.Arguments[i]));
                    }

                    // Substitute the slot's return type T → caller's T
                    // (which is also the receiver tpSym). The slot was
                    // bound on the open interface definition so its return
                    // type might still mention the interface's own type
                    // parameter symbol — translate it through the
                    // constructed interface's TypeArguments.
                    var returnType = SubstituteThroughConstructedInterface(slot.Type, tpSym.InterfaceConstraint);

                    return new BoundConstrainedStaticCallExpression(
                        callSyntax,
                        tpSym,
                        slot,
                        boundArgs.MoveToImmutable(),
                        returnType);
                }

            case NameExpressionSyntax ne:
                {
                    // ADR-0089 / issue #1019: a static-virtual interface
                    // *property* read `T.Prop` dispatches through the
                    // property's getter accessor (a static-virtual slot),
                    // emitted as `constrained. !!T  call I::get_Prop()`.
                    var propName = ne.IdentifierToken.Text;
                    PropertySymbol slotProp = null;
                    InterfaceSymbol slotIface = null;
                    foreach (var iface in tpSym.InterfaceConstraint.SelfAndAllBaseInterfaces())
                    {
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
                        var defIface = iface.Definition ?? iface;
                        defIface.EnsureMembersResolved();
                        foreach (var candidate in defIface.Properties)
                        {
                            if (candidate.IsStatic && candidate.Name == propName)
                            {
                                slotProp = candidate;
                                slotIface = iface;
                                break;
                            }
                        }

                        if (slotProp != null)
                        {
                            break;
                        }
                    }

                    if (slotProp == null || slotProp.GetterSymbol == null)
                    {
                        Diagnostics.ReportStaticVirtualMemberNotFoundOnTypeParameter(
                            leftName.Location, tpSym.Name, propName);
                        return new BoundErrorExpression(null);
                    }

                    var propType = SubstituteThroughConstructedInterface(slotProp.Type, slotIface);

                    return new BoundConstrainedStaticCallExpression(
                        ne,
                        tpSym,
                        slotProp.GetterSymbol,
                        ImmutableArray<BoundExpression>.Empty,
                        propType);
                }

            default:
                return new BoundErrorExpression(null);
        }
    }

    /// <summary>
    /// ADR-0089: substitute a type that may mention the constructed
    /// interface's open type parameter with the corresponding type
    /// argument from <paramref name="constructedIface"/>. Conservative —
    /// only rewrites a top-level <see cref="TypeParameterSymbol"/>
    /// reference; leaves nested/generic shapes alone (the slot's
    /// signature is typically just <c>T</c> for the common math
    /// pattern).
    /// </summary>
    private static TypeSymbol SubstituteThroughConstructedInterface(TypeSymbol type, InterfaceSymbol constructedIface)
    {
        if (type is TypeParameterSymbol tp
            && constructedIface?.Definition?.TypeParameters != null
            && !constructedIface.Definition.TypeParameters.IsDefaultOrEmpty
            && !constructedIface.TypeArguments.IsDefaultOrEmpty)
        {
            for (var i = 0; i < constructedIface.Definition.TypeParameters.Length; i++)
            {
                if (ReferenceEquals(constructedIface.Definition.TypeParameters[i], tp))
                {
                    return constructedIface.TypeArguments[i];
                }
            }
        }

        return type;
    }

    /// <summary>
    /// ADR-0122 §10 / issue #1035: builds the <c>*T</c> value a fixed-size
    /// buffer field decays to — the address of the inline backing struct
    /// (whose first element sits at offset 0) reinterpreted to the element
    /// pointer type. Reuses the existing address-of + pointer-reinterpret
    /// machinery, so no new bound-node kind is required.
    /// </summary>
    /// <param name="receiver">The receiver expression the buffer field is read from.</param>
    /// <param name="declaringType">The type that declares the buffer field.</param>
    /// <param name="field">The fixed-size buffer field.</param>
    /// <returns>A <c>*T</c>-typed bound expression to the first element.</returns>
    private static BoundExpression MakeFixedBufferPointer(BoundExpression receiver, StructSymbol declaringType, FieldSymbol field)
    {
        var fieldAccess = new BoundFieldAccessExpression(null, receiver, declaringType, field);
        var addressOf = new BoundAddressOfExpression(null, fieldAccess, unmanaged: true);
        var elementPointer = PointerTypeSymbol.Get(field.FixedBufferElementType);
        return new BoundConversionExpression(null, elementPointer, addressOf);
    }
}
