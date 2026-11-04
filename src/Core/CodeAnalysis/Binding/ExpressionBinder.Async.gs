// <copyright file="ExpressionBinder.Async.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Text
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding.Suspension

internal partial class ExpressionBinder {
    /// Looks up [`name`](paramref) on base classes, from nearest to farthest.
    /// Writes the selected event through the output parameters; the caller checks accessibility.
    /// @param name The member name after `base.`.
    /// @param sourceEvent The base's source event, when it declares one.
    /// @param sourceOwner The base class (in the hierarchy seen from the derived class) that declares
    /// [`sourceEvent`](paramref).
    /// @param clrEvent The imported base's event, when the name resolves there.
    /// @returns Whether the base declares an event of that name.
    private func TryGetBaseEvent(
        name string,
        out sourceEvent EventSymbol?,
        out sourceOwner StructSymbol?,
        out clrEvent EventInfo?
    ) bool {
        sourceEvent = nil
        sourceOwner = nil
        clrEvent = nil
        if GetBaseAccessThisParameter()?.Type is not StructSymbol{IsClass: true} enclosing {
            return false
        }
        // Level by level, nearest first: an event at a level wins, but a field
        // or property of the same name at a nearer level hides every farther
        // event (the same precedence as SourceValueMemberPrecedesInheritedEvent
        // for ordinary member access), so `base.E += v` then binds the value
        // member as a compound assignment.
        if enclosing.BaseClass is {} sourceBase {
            for level in sourceBase.GetHierarchy() {
                for candidate in level.Events {
                    if !string.Equals(candidate.Name, name, StringComparison.Ordinal) || candidate.IsStatic {
                        continue
                    }
                    sourceEvent = candidate
                    sourceOwner = level
                    return true
                }
                if level.TryGetField(name, out _) || level.Properties.Any(
                    (candidate PropertySymbol) -> !candidate.IsIndexer && candidate.Name == name
                ) {
                    return false
                }
            }
        }
        const DeclaredInstance = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
        for var level Type? = GetInheritedClrBaseType(enclosing); level != nil; level = level!!.BaseType {
            for candidate in ClrTypeUtilities.SafeGetEvents(level, DeclaredInstance) {
                if !string.Equals(candidate.Name, name, StringComparison.Ordinal) {
                    continue
                }
                clrEvent = candidate
                return true
            }
            // A value member the derived class can reach hides farther
            // events; one it cannot reach (e.g. private) does not take part
            // in lookup at all.
            let includeInternal = CanAccessInternalsOf(level)
            if ClrTypeUtilities.SafeGetFields(level, DeclaredInstance).Any(
                (field FieldInfo) -> string.Equals(field.Name, name, StringComparison.Ordinal) &&
                    ClrMemberVisibility.IsVisibleFromDerived(field, includeInternal)
            ) ||
                ClrTypeUtilities
                .SafeGetProperties(level, DeclaredInstance).Any(
                (property PropertyInfo) -> string.Equals(property.Name, name, StringComparison.Ordinal) &&
                    property
                    .GetIndexParameters()
                    .Length == 0 &&
                    (
                    ClrMemberVisibility.IsVisibleFromDerived(property.GetMethod, includeInternal) ||
                        ClrMemberVisibility.IsVisibleFromDerived(property.SetMethod, includeInternal)
                )
            ) {
                return false
            }
        }
        return false
    }

    /// Issue #4394: the accessibility gate every source-event subscription
    /// (`obj.E += h`, `E += h`, `T.E += h` through a class
    /// constraint) shares with `base.E += h`. Reports the usual
    /// inaccessible-member diagnostic when [`ev`](paramref), declared on
    /// [`declaringType`](paramref), cannot be reached from the current
    /// function, and binds the handler so its own errors still surface.
    /// @param ev The event being subscribed to.
    /// @param declaringType The class that declares the event (not the receiver's static type).
    /// @param eventName The event-name syntax, for the diagnostic location.
    /// @param handler The handler expression.
    /// @returns `true` when the event is inaccessible and a diagnostic was reported.
    private func ReportInaccessibleSourceEvent(
        ev EventSymbol,
        declaringType StructSymbol,
        eventName NameExpressionSyntax,
        handler ExpressionSyntax
    ) bool {
        if AccessibilityChecker.IsAccessible(ev.Accessibility, declaringType, function) {
            return false
        }
        Diagnostics.ReportMemberInaccessible(eventName.Location, ev.Name, declaringType.Name, ev.Accessibility)
        let _ = BindExpression(handler)
        return true
    }

    /// Issue #4394: when the visible-member probe of an imported receiver finds
    /// no event named [`eventName`](paramref), looks again including
    /// non-public members. An event found only that way exists but is not
    /// visible to every caller:
    /// - a `protected` accessor is callable from a class that derives from the event's declaring type,
    /// through a receiver of that class (`this.E += h`), as in C#; the event is returned for ordinary
    /// binding;
    /// - otherwise (`private`, another assembly's `internal`, or `protected` from an unrelated class) it
    /// gets the inaccessible-member diagnostic rather than "cannot find member", and [`reported`](paramref)
    /// is set.
    /// @param receiverClrType The receiver's CLR type.
    /// @param receiver The bound instance receiver, or `null` for a static event.
    /// @param isAdd Whether this is `+=` (the add accessor) or `-=` (remove).
    /// @param eventName The event-name syntax.
    /// @param handler The handler expression.
    /// @param reported Set when an inaccessible event was found and reported.
    /// @returns The event, when the current class may subscribe to it through [`receiver`](paramref).
    private func ResolveNonPublicClrEvent(
        receiverClrType Type,
        receiver BoundExpression?,
        isAdd bool,
        eventName NameExpressionSyntax,
        handler ExpressionSyntax,
        out reported bool
    ) EventInfo? {
        reported = false
        // Walk the declared members level by level: reflection never returns
        // a base class's private members through a derived type.
        let name = eventName.IdentifierToken.ValueText
        let declared = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly | (
            if receiver == nil {
                BindingFlags.Static
            } else {
                BindingFlags.Instance
            }
        )
        var hidden EventInfo? = nil
        for var level Type? = receiverClrType; level != nil && hidden == nil; level = level!!.BaseType {
            hidden = ClrTypeUtilities.SafeGetEvent(level, name, declared)
        }
        if hidden == nil {
            return nil
        }
        // The accessor this subscription calls decides, not the one the
        // visible-member probe filtered on (metadata may give add and remove
        // different accessibilities).
        let accessor = if isAdd {
            hidden.AddMethod
        } else {
            hidden.RemoveMethod
        }
        if IsCallableClrEventAccessor(accessor, hidden.DeclaringType, receiver) {
            return hidden
        }
        Diagnostics.ReportMemberInaccessible(
            eventName.Location,
            hidden.Name,
            hidden.DeclaringType?.Name ?? name,
            ClrEventAccessorAccessibility(accessor)
        )
        let _ = BindExpression(handler)
        reported = true
        return nil
    }

    /// Issue #4394: the one decision whether an imported event's add or
    /// remove accessor may be called here through [`receiver`](paramref):
    /// it exists, and it is visible to this compilation (public, or a friend
    /// assembly's internal) or reachable as a `protected` member of a
    /// base class ((cref:IsFamilyAccessibleClrEvent)). Metadata may
    /// omit an accessor or give add and remove different accessibilities, so
    /// each subscription asks about the accessor it calls.
    /// @param accessor The add or remove accessor, if any.
    /// @param declaringType The event's declaring type.
    /// @param receiver The bound instance receiver, or `null` for a static event.
    /// @returns `true` when the accessor may be called.
    private func IsCallableClrEventAccessor(
        accessor MethodInfo?,
        declaringType Type?,
        receiver BoundExpression?
    ) bool -> accessor != nil &&
        (
        ClrMemberVisibility.IsVisible(accessor, CanAccessInternalsOf(declaringType)) ||
            IsFamilyAccessibleClrEvent(accessor, declaringType, receiver)
    )

    /// Whether the current class may call [`accessor`](paramref), a
    /// `protected` accessor of an event declared on
    /// [`declaringType`](paramref), through [`receiver`](paramref):
    /// the class derives from the declaring type and, for an instance event,
    /// the receiver is of the current class (or a class derived from it), the
    /// C# rule for protected instance access.
    private func IsFamilyAccessibleClrEvent(accessor MethodInfo, declaringType Type?, receiver BoundExpression?) bool {
        if !ClrMemberVisibility.IsVisibleFromDerived(accessor, CanAccessInternalsOf(declaringType)) ||
            declaringType == nil ||
            GetFamilyAccessBase() is not{} familyBase ||
            !IsSameOrDerivedClrType(familyBase, declaringType) {
            return false
        }
        if receiver == nil {
            return true
        }
        // Issue #4453: the receiver half is the same C# CS1540 rule source
        // members follow, asked through the one shared helper.
        let enclosing StructSymbol? = (function?.ReceiverType ?? GetEffectiveThisParameter()?.Type) as StructSymbol
        return enclosing != nil && AccessibilityChecker.IsReceiverWithinClass(receiver.Type, enclosing)
    }

    private func BindEventSubscriptionExpression(syntax EventSubscriptionExpressionSyntax) BoundExpression {
        // Bare identifier `EventName += handler` / `EventName -= handler`:
        // the parser now emits this form for all `id +=/-=` patterns. Try to
        // resolve as an event on the implicit `this`; if not an event, fall
        // back to compound assignment semantics (`x += 1`).
        if syntax.LeftHandSide is NameExpressionSyntax bareName {
            return BindBareEventOrCompoundAssignment(bareName, syntax) ?? BoundErrorExpression(nil)
        }
        // Stream B′: `lhs.Event += handler` / `lhs.Event -= handler`.
        var accessor AccessorExpressionSyntax? = syntax.LeftHandSide as AccessorExpressionSyntax
        if accessor == nil {
            Diagnostics.ReportUnableToFindMember(syntax.LeftHandSide.Location, syntax.OperatorToken.Text)
            return BoundErrorExpression(nil)
        }
        // Issue #503 follow-up: `A.B.Event += handler` (chained-receiver
        // subscription). The parser produces a *right-associative* accessor
        // chain — `A . (B . Event)` — so accessor.RightPart is itself an
        // AccessorExpressionSyntax and the event name is at the rightmost
        // leaf. Rotate the chain into the canonical left-associative form
        // `(A . B) . Event` so the existing receiver/event-name resolution
        // below (which assumes the right part is a single name) just works.
        accessor = NormalizeAccessorLeftAssociative(accessor)
        if accessor.RightPart is not NameExpressionSyntax eventNameSyntax {
            Diagnostics.ReportUnableToFindMember(accessor.RightPart.Location, syntax.OperatorToken.Text)
            return BoundErrorExpression(nil)
        }
        var eventName = eventNameSyntax.IdentifierToken.ValueText
        let isAdd = syntax.OperatorToken.Kind == SyntaxKind.PlusEqualsToken
        // Issue #2154: events only support `+=`/`-=` subscription semantics —
        // any OTHER compound operator (`*=`, `/=`, ...) on the same
        // member-access LHS can never denote an event and must go straight to
        // compound-assignment (operator-overload) resolution below, carrying
        // the actual base operator instead of the +/- `isAdd` bool.
        let isEventCapableOperator = syntax
            .OperatorToken
            .Kind == SyntaxKind.PlusEqualsToken ||
            syntax
            .OperatorToken
            .Kind == SyntaxKind.MinusEqualsToken
        SyntaxFacts.TryGetCompoundAssignmentBaseOperator(syntax.OperatorToken.Kind, out var baseOpSyntaxKind)
        // `base.Member op= rhs` and `base.Member++` / `++base.Member`: the
        // parser desugars every compound form of a member target to this node,
        // but `base` is a contextual keyword with no value of its own — binding
        // it as the receiver below reported GS0125 "Variable 'base' doesn't
        // exist" even though the plain read (`base.Member`) and write
        // (`base.Member = v`) both bind. Compose the compound from those same
        // two paths so the read and the write resolve the member identically
        // (nearest base first, field before property, non-virtual accessor
        // calls). A real value named `base` keeps its ordinary meaning.
        //
        // TryGetBaseEvent applies base-member hiding rules; base subscriptions call the selected accessors without virtual dispatch.
        if accessor.LeftPart is NameExpressionSyntax{IdentifierToken: {ValueText: "base"}} baseName &&
            IsContextualBaseKeyword(baseName) {
            var baseSourceEvent EventSymbol? = nil
            var baseSourceOwner StructSymbol? = nil
            var baseClrEvent EventInfo? = nil
            if !isEventCapableOperator ||
                !TryGetBaseEvent(eventName, out baseSourceEvent, out baseSourceOwner, out baseClrEvent) {
                return BindBaseMemberCompoundAssignment(baseName, eventNameSyntax, syntax, baseOpSyntaxKind)
            }
            if GetBaseAccessThisParameter() is {} baseEventThis {
                let baseEventReceiver = BoundVariableExpression(nil, baseEventThis)
                if baseSourceEvent != nil && baseSourceOwner != nil {
                    // The nearest event of that name hides any farther one,
                    // even when the derived class cannot reach it (a
                    // `private` base event): report it instead of binding its
                    // accessors.
                    if !AccessibilityChecker.IsAccessible(baseSourceEvent.Accessibility, baseSourceOwner, function) {
                        Diagnostics.ReportMemberInaccessible(
                            eventNameSyntax.Location,
                            baseSourceEvent.Name,
                            baseSourceOwner.Name,
                            baseSourceEvent.Accessibility
                        )
                        let _ = BindExpression(syntax.Value)
                        return BoundErrorExpression(nil)
                    }
                    let sourceEventType = baseSourceOwner.SubstituteMemberType(baseSourceEvent.Type) ??
                        baseSourceEvent.Type
                    let sourceHandler = BindEventSubscriptionHandler(syntax.Value, sourceEventType)
                    return BoundEventSubscriptionExpression(
                        nil,
                        baseEventReceiver,
                        baseSourceOwner,
                        baseSourceEvent,
                        sourceHandler,
                        isAdd,
                        sourceEventType
                    ){IsNonVirtualBaseCall = true}
                }
                if baseClrEvent != nil {
                    // The reflected scan sees non-public events too, and the
                    // nearest one hides farther ones; but its accessors must be
                    // callable from the derived class (public, protected, or a
                    // friend assembly's internal), or the call would fail at
                    // run time with MethodAccessException.
                    let eventAccessor MethodInfo? = if isAdd {
                        baseClrEvent.AddMethod
                    } else {
                        baseClrEvent.RemoveMethod
                    }
                    if !ClrMemberVisibility.IsVisibleFromDerived(
                        eventAccessor,
                        CanAccessInternalsOf(baseClrEvent.DeclaringType)
                    ) {
                        let hidden = if eventAccessor == nil || eventAccessor.IsPrivate {
                            Accessibility.Private
                        } else {
                            Accessibility.Internal
                        }
                        Diagnostics.ReportMemberInaccessible(
                            eventNameSyntax.Location,
                            baseClrEvent.Name,
                            baseClrEvent.DeclaringType?.Name ?? eventName,
                            hidden
                        )
                        let _ = BindExpression(syntax.Value)
                        return BoundErrorExpression(nil)
                    }
                    if eventAccessor != nil && eventAccessor.IsAbstract {
                        Diagnostics.ReportBaseClassCallAbstractMember(
                            eventNameSyntax.Location,
                            baseClrEvent.DeclaringType?.Name ?? eventName,
                            eventName
                        )
                        let _ = BindExpression(syntax.Value)
                        return BoundErrorExpression(nil)
                    }
                    // The imported base as the derived class names it
                    // (`Source[Item]` over a same-compilation `Item`), not
                    // the erased CLR construction reflection sees: it
                    // supplies the handler type and the add/remove MemberRef
                    // parent, as for an ordinary imported event receiver.
                    let inheritedImportedBase TypeSymbol? = if GetBaseAccessThisParameter()?.Type is StructSymbol eventEnclosing {
                        TypeMemberModel.GetNearestImportedBase(eventEnclosing)
                    } else {
                        default(TypeSymbol?)
                    }
                    let clrHandlerType = if inheritedImportedBase != nil {
                        MemberLookup.GetClrEventHandlerTypeSymbol(inheritedImportedBase, baseClrEvent)
                    } else {
                        MemberLookup.GetClrEventHandlerTypeSymbol(baseClrEvent)
                    }
                    let clrHandler = BindEventSubscriptionHandler(syntax.Value, clrHandlerType)
                    let clrEventContainingType = if inheritedImportedBase == nil {
                        default(TypeSymbol?)
                    } else {
                        MemberLookup.GetClrMemberDeclaringTypeSymbol(inheritedImportedBase, baseClrEvent)
                    }
                    return BoundClrEventSubscriptionExpression(
                        nil,
                        baseEventReceiver,
                        baseClrEvent,
                        clrHandler,
                        isAdd,
                        eventContainingType: clrEventContainingType
                    ){IsNonVirtualBaseCall = true}
                }
            }
        }
        // Resolve receiver: either an ImportedClassSymbol (static event) or
        // any value-producing expression with a CLR-backed type (instance event).
        var boundReceiver BoundExpression? = nil
        var receiverClrType Type? = nil
        var importedEventTarget TypeSymbol? = nil
        var eventInfo EventInfo? = nil
        var flags BindingFlags
        // Issue #4051: set by the constructed-generic-receiver branch below when
        // its resolver failed for a reason it already REPORTED (a type argument
        // that violates a declared constraint, GS0152). Declared out here
        // because that branch is one link of an `else if` chain, and the
        // fall-through `else` — which is where the false diagnostics came from —
        // has to see it.
        var constructedReceiverFailureHandled = false
        // Issue #4056: the SYMBOLIC constructed view of a generic receiver whose
        // closed CLR shape is type-erased — `Handler[MyOptions]` over a
        // same-compilation `MyOptions` closes over the `object` surrogate
        // because the user type has no CLR type while binding. The read
        // (ExpressionBinder.Access.MemberLookup.cs) and simple-write
        // (BindMemberFieldAssignmentExpression) paths both carry it onto the
        // bound node as the static container so the emitter parents the field
        // reference at `Handler<MyOptions>`; this path dropped it and the
        // emitted TypeSpec named `Handler<object>`, which ILVerify rejects
        // (UnsatisfiedFieldParentInst) and the CLR refuses to load.
        var staticSymbolicContainer ImportedTypeSymbol? = nil
        let staticLeftName NameExpressionSyntax? = accessor.LeftPart as NameExpressionSyntax
        var staticSourceType TypeSymbol? = nil
        var staticImportedOverride ImportedClassSymbol? = nil
        if staticLeftName != nil && binderCtx.TryLookupSourceType(
            $scope,
            staticLeftName.IdentifierToken.ValueText,
            preferredArity: 0,
            getCurrentFunction(),
            out staticSourceType,
            out _
        ) {
            let _ = TryResolveImportedTypeOverride(
                staticLeftName.IdentifierToken.ValueText,
                staticSourceType!!,
                requestedArity: 0,
                staticLeftName,
                out staticImportedOverride
            )
        }
        if staticLeftName != nil &&
            EventReceiverNameCanBindAsType(staticLeftName, eventNameSyntax) &&
            staticImportedOverride == nil &&
            staticSourceType is StructSymbol staticStruct {
            // Issue #263: static event subscription on a user-defined type.
            // Try matching an event first; if no match, fall through to
            // ADR-0053 static field/property compound assignment instead of
            // reporting an immediate "unable to find member". Non-+/-
            // operators (issue #2154) can never be an event, so skip straight
            // to the compound-assignment fallback.
            if isEventCapableOperator &&
                !SourceStaticValueMemberPrecedesInheritedEvent(staticStruct, eventName) &&
                TypeMemberModel
                .TryGetStaticEventIncludingInherited(staticStruct, eventName, out var ev, out var eventOwner) {
                if !AccessibilityChecker.IsAccessible(ev!!.Accessibility, eventOwner, function) {
                    Diagnostics.ReportMemberInaccessible(
                        eventNameSyntax.Location,
                        ev!!.Name,
                        eventOwner!!.Name,
                        ev!!.Accessibility
                    )
                }
                let eventType = eventOwner!!.SubstituteMemberType(ev!!.Type)
                let userHandler = BindEventSubscriptionHandler(syntax.Value, eventType!!)
                return BoundEventSubscriptionExpression(
                    nil,
                    receiver: nil,
                    eventOwner!!,
                    ev!!,
                    userHandler,
                    isAdd,
                    eventType
                )
            }
            // ADR-0053: `Type.StaticField op= rhs` / `Type.StaticProp op= rhs`.
            // The simple-assignment path is handled by BindFieldAssignmentExpression
            // (lines ~6586–6619); this is the compound counterpart.
            if TryBindUserTypeStaticCompoundAssignment(
                staticStruct,
                eventNameSyntax,
                syntax,
                baseOpSyntaxKind,
                out var compoundResult
            ) &&
                compoundResult is {} resolvedCompoundResult {
                return resolvedCompoundResult
            }
            if TypeMemberModel.GetNearestImportedBase(staticStruct)?.ClrType is Type importedBaseClr {
                receiverClrType = importedBaseClr
                flags = BindingFlags.Public | BindingFlags.Static
            } else {
                Diagnostics.ReportUnableToFindMember(eventNameSyntax.Location, eventName)
                return BoundErrorExpression(nil)
            }
        } else if staticLeftName != nil &&
            staticImportedOverride == nil &&
            staticSourceType is InterfaceSymbol staticInterface {
            // ADR-0089 / issue #1030: `IName.StaticField op= rhs` — compound
            // assignment to a (non-generic) interface static field.
            if TryBindInterfaceStaticCompoundAssignment(
                staticInterface,
                eventNameSyntax,
                syntax,
                baseOpSyntaxKind,
                out var ifaceCompound
            ) &&
                ifaceCompound is {} resolvedIfaceCompound {
                return resolvedIfaceCompound
            }
            Diagnostics.ReportUnableToFindMember(eventNameSyntax.Location, eventName)
            return BoundErrorExpression(nil)
        } else if staticLeftName != nil &&
            EventReceiverNameCanBindAsType(staticLeftName, eventNameSyntax) &&
            (
            staticImportedOverride != nil || $scope.TryLookupImportedClass(
                staticLeftName.IdentifierToken.ValueText,
                staticLeftName,
                out staticImportedOverride
            )
        ) {
            receiverClrType = staticImportedOverride!!.ClassType
            flags = BindingFlags.Public | BindingFlags.Static
        } else if TryResolveConstructedGenericTypeReceiver(
            accessor.LeftPart,
            out var ctorStruct,
            out var ctorInterface,
            out var ctorImported,
            out constructedReceiverFailureHandled
        ) {
            // Issue #1559 (extends ADR-0089 / issue #1030): compound assignment
            // to a static field/property through a constructed generic *type*
            // receiver — `Foo[int32].x op= rhs` (class/struct) or
            // `IBox[int32].StaticField op= rhs` (interface). The receiver is a
            // TYPE, resolved to the constructed symbol (mirroring the READ /
            // simple-write paths) rather than bound as element access, and the
            // carried construction drives per-construction emit/storage.
            if ctorStruct != nil &&
                isEventCapableOperator &&
                !SourceStaticValueMemberPrecedesInheritedEvent(ctorStruct, eventName) &&
                TypeMemberModel
                .TryGetStaticEventIncludingInherited(ctorStruct, eventName, out var ctorEvent, out var ctorEventOwner) {
                if !AccessibilityChecker.IsAccessible(ctorEvent!!.Accessibility, ctorEventOwner, function) {
                    Diagnostics.ReportMemberInaccessible(
                        eventNameSyntax.Location,
                        ctorEvent!!.Name,
                        ctorEventOwner!!.Name,
                        ctorEvent!!.Accessibility
                    )
                }
                let eventType = ctorEventOwner!!.SubstituteMemberType(ctorEvent!!.Type)
                let handler = BindEventSubscriptionHandler(syntax.Value, eventType!!)
                return BoundEventSubscriptionExpression(
                    nil,
                    receiver: nil,
                    ctorEventOwner!!,
                    ctorEvent!!,
                    handler,
                    isAdd,
                    eventType
                )
            }
            if ctorStruct != nil &&
                TryBindUserTypeStaticCompoundAssignment(
                ctorStruct,
                eventNameSyntax,
                syntax,
                baseOpSyntaxKind,
                out var ctorStructCompound
            ) &&
                ctorStructCompound is {} resolvedCtorStructCompound {
                return resolvedCtorStructCompound
            }
            if ctorInterface != nil &&
                TryBindInterfaceStaticCompoundAssignment(
                ctorInterface,
                eventNameSyntax,
                syntax,
                baseOpSyntaxKind,
                out var ctorCompound
            ) &&
                ctorCompound is {} resolvedCtorCompound {
                return resolvedCtorCompound
            }
            if ctorStruct != nil && TypeMemberModel.GetNearestImportedBase(ctorStruct)
                ?.ClrType is Type constructedImportedBase {
                receiverClrType = constructedImportedBase
                flags = BindingFlags.Public | BindingFlags.Static
            } else if ctorImported != nil {
                receiverClrType = ctorImported.ClassType
                // Issue #4056: `ClassType` is the ERASED close
                // (`Handler<object>`); the symbolic view is what names the
                // construction the author wrote. Carry it so the emitted
                // TypeSpec matches the read and simple-write spellings.
                staticSymbolicContainer = ctorImported.SymbolicReceiver
                flags = BindingFlags.Public | BindingFlags.Static
            } else {
                Diagnostics.ReportUnableToFindMember(eventNameSyntax.Location, eventName)
                return BoundErrorExpression(nil)
            }
        } else {
            // Issue #4051: the compound-assignment path's version of the read
            // path's cascade. `Handler[string].Field += "z"` reported the
            // accurate GS0152 from the constructed-receiver branch above, whose
            // condition then read `false` — dropping the whole chain into this
            // `else`, where `BindExpression` re-reads `Handler[string]` as an
            // index expression and reports `Handler` and `string` as two
            // missing variables. The construction already explained itself.
            if constructedReceiverFailureHandled {
                return BoundErrorExpression(nil)
            }
            boundReceiver = BindExpression(accessor.LeftPart)
            if boundReceiver.Type == TypeSymbol.Error {
                return BoundErrorExpression(nil)
            }
            // ADR-0186 §4/§5, issue #4325: this method binds BOTH event
            // subscription (`x.E += h`) and compound member assignment
            // (`n.Num += 1`) — the parser routes every `accessor op= value`
            // shape here — and neither had the receiver check the plain write
            // path got in `BindMemberFieldAssignmentExpression`. The dispatch
            // below switches on the receiver's symbol KIND
            // (`is StructSymbol`, `is TypeParameterSymbol`, …) and then falls
            // back to a `ClrType` relay, so a platform wrapper did not fail
            // loudly: it bound through the relay with no unwrap, and a nil
            // receiver produced an unattributed failure instead of §4's
            // message. This is the same one-line call the read, write and
            // indexer paths make.
            boundReceiver = binderCtx.InsertPlatformCheck(
                boundReceiver,
                accessor.LeftPart.Location,
                "a compound member assignment receiver"
            )
            if boundReceiver.Type is TupleTypeSymbol tupleType {
                eventName = GetTupleFieldName(eventName, tupleType)
            }
            // A nearer source field/property hides an inherited event, while
            // an event declared at the same level retains event precedence.
            if isEventCapableOperator &&
                boundReceiver.Type is StructSymbol sourceValueType &&
                SourceValueMemberPrecedesInheritedEvent(sourceValueType, eventName) {
                let sourceCompound BoundExpression? = TryBindChainedCompoundAssignment(
                    sourceValueType,
                    boundReceiver,
                    eventName,
                    eventNameSyntax,
                    syntax,
                    baseOpSyntaxKind
                )
                if sourceCompound != nil {
                    return sourceCompound
                }
            }
            // Check for user-defined event on a StructSymbol before falling through to CLR reflection.
            // ADR-0112 A5: TryGetEvent walks the base chain, so inherited instance
            // events on `open class` bases now resolve (parity with the bare-`this`
            // path in BindBareEventOrCompoundAssignment).
            // Non-+/- operators (issue #2154) can never be an event.
            //
            // The owner is the declaring class as the receiver's hierarchy
            // instantiates it, as on the `base.E` and static paths:
            // - issue #4394: the accessibility check needs the declaring
            //   class (a private event is not reachable from an unrelated or
            //   derived class);
            // - issue #4391: the handler type is the event's type with that
            //   construction's type arguments (`g.Got += h` on a `GB[string]`
            //   takes an `EventHandler[string]`, not `EventHandler[T]`), and
            //   the emitted add/remove reference is parented at it.
            if isEventCapableOperator && boundReceiver.Type is StructSymbol userStruct && TypeMemberModel.TryGetEvent(
                userStruct,
                eventName,
                out var ev,
                out var eventOwner
            ) {
                if ReportInaccessibleSourceEvent(ev!!, eventOwner!!, eventNameSyntax, syntax.Value) {
                    return BoundErrorExpression(nil)
                }
                let eventType = eventOwner!!.SubstituteMemberType(ev!!.Type) ?? ev!!.Type
                let userHandler = BindEventSubscriptionHandler(syntax.Value, eventType)
                return BoundEventSubscriptionExpression(
                    nil,
                    boundReceiver,
                    eventOwner!!,
                    ev!!,
                    userHandler,
                    isAdd,
                    eventType
                )
            }
            // Issue #2519: a class-constrained type parameter exposes the same
            // instance event surface as its constraint's fields, properties,
            // and methods. TypeMemberModel walks inherited events; retain the
            // constraint as the event owner while the receiver remains T.
            if isEventCapableOperator &&
                boundReceiver.Type is TypeParameterSymbol{ClassConstraint: StructSymbol classConstraint} &&
                TypeMemberModel
                .TryGetEvent(classConstraint, eventName, out var constrainedUserEvent, out var constrainedEventOwner) {
                if ReportInaccessibleSourceEvent(
                    constrainedUserEvent!!,
                    constrainedEventOwner!!,
                    eventNameSyntax,
                    syntax.Value
                ) {
                    return BoundErrorExpression(nil)
                }
                // As on the `obj.E` path: the declaring construction supplies
                // the handler type (`EventHandler[string]` for a `GB[string]`
                // constraint, issue #4391) and parents the accessor call.
                let constrainedEventType = constrainedEventOwner!!.SubstituteMemberType(constrainedUserEvent!!.Type) ??
                    constrainedUserEvent!!.Type
                let constrainedHandler = BindEventSubscriptionHandler(syntax.Value, constrainedEventType)
                return BoundEventSubscriptionExpression(
                    nil,
                    boundReceiver,
                    constrainedEventOwner!!,
                    constrainedUserEvent!!,
                    constrainedHandler,
                    isAdd,
                    constrainedEventType
                )
            }
            // ADR-0149 follow-up (issue #2370): event subscription through an
            // INTERFACE-typed receiver (`b: IFoo; b.Changed += h`). Interfaces
            // could always declare events, but no call-site binding ever
            // consulted an interface owner here — mirrors the struct branch
            // immediately above (TypeMemberModel.TryGetEvent already walks
            // InterfaceSymbol.SelfAndAllBaseInterfaces internally; only the
            // receiver-type gate below was missing). Dispatches via
            // `callvirt` through the interface's own add_X/remove_X slot
            // (EmitUserEventSubscription resolves it through
            // ResolveUserInterfaceInstanceMethodToken, which also parents the
            // token at the constructed TypeSpec for a generic interface).
            if isEventCapableOperator && boundReceiver.Type is InterfaceSymbol userIface && TypeMemberModel.TryGetEvent(
                userIface,
                eventName,
                out var ifaceEv
            ) {
                let ifaceHandler = BindEventSubscriptionHandler(syntax.Value, ifaceEv!!.Type)
                return BoundEventSubscriptionExpression(nil, boundReceiver, userIface, ifaceEv!!, ifaceHandler, isAdd)
            }
            if isEventCapableOperator &&
                boundReceiver.Type is TypeParameterSymbol tpReceiver &&
                tpReceiver.ClrInterfaceConstraint is TypeSymbol clrInterfaceConstraint &&
                clrInterfaceConstraint.ClrType is Type clrInterface &&
                clrInterface
                .IsInterface {
                let constrainedEvent EventInfo? = ClrTypeUtilities.SafeGetEventIncludingInterfaces(
                    clrInterface,
                    eventName,
                    BindingFlags.Public | BindingFlags.Instance
                )
                if constrainedEvent != nil {
                    let constrainedHandlerTypeSymbol = MemberLookup.GetClrEventHandlerTypeSymbol(
                        clrInterfaceConstraint,
                        constrainedEvent
                    )
                    let constrainedConvertedHandler = BindEventSubscriptionHandler(
                        syntax.Value,
                        constrainedHandlerTypeSymbol
                    )
                    return BoundClrEventSubscriptionExpression(
                        nil,
                        boundReceiver,
                        constrainedEvent,
                        constrainedConvertedHandler,
                        isAdd,
                        tpReceiver,
                        MemberLookup.GetClrMemberDeclaringTypeSymbol(clrInterfaceConstraint, constrainedEvent)
                    )
                }
            }
            // Issue #4350: a source type keeps precedence over its imported
            // base for compound member writes, matching reads and plain writes.
            // Otherwise `this.SourceProperty += value` on a class deriving from
            // an imported base skips the source property and reports GS0158
            // against the base's CLR surface.
            if boundReceiver.Type is StructSymbol sourceCompoundType {
                let sourceCompound BoundExpression? = TryBindChainedCompoundAssignment(
                    sourceCompoundType,
                    boundReceiver,
                    eventName,
                    eventNameSyntax,
                    syntax,
                    baseOpSyntaxKind
                )
                if sourceCompound != nil {
                    return sourceCompound
                }
            }
            // Issue #4354: a stated-nullable receiver (`T?`) has no CLR member
            // surface until it is narrowed, exactly as on the plain read and write
            // paths (`CanBindClrInstanceMember`). `NullableTypeSymbol.ClrType`
            // relays to the underlying type, so without this test the compound
            // write bound clean and failed at run time with an unattributed
            // NullReferenceException. The same gate covers event subscription,
            // which shares this binder.
            importedEventTarget = boundReceiver.Type
            receiverClrType = if CanBindClrInstanceMember(boundReceiver) {
                importedEventTarget?.ClrType
            } else {
                default(Type?)
            }
            if receiverClrType == nil &&
                boundReceiver.Type is StructSymbol sourceReceiver &&
                TypeMemberModel.GetNearestImportedBase(sourceReceiver) is TypeSymbol importedBase {
                importedEventTarget = importedBase
                receiverClrType = importedBase.ClrType
            }
            if receiverClrType == nil {
                // Issue #648 (generalized by #2154): compound assignment fallback for
                // chained member access on user-defined struct/class types (e.g.
                // `a.B.C += 1`, `a.B.C *= 2`). The parser routes all `lhs.member op=
                // rhs` through EventSubscriptionExpression; when the member is not an
                // event we fall back to compound assignment.
                if boundReceiver.Type is InterfaceSymbol compoundInterface {
                    let compoundResult BoundExpression? = TryBindInterfaceCompoundAssignment(
                        compoundInterface,
                        boundReceiver,
                        eventName,
                        eventNameSyntax,
                        syntax,
                        baseOpSyntaxKind
                    )
                    if compoundResult != nil {
                        return compoundResult
                    }
                }
                // Issue #2519: use the class constraint as the member surface
                // for `T.member op= value`, matching simple reads/writes and
                // method/event lookup through the same constrained receiver.
                if boundReceiver.Type is TypeParameterSymbol{ClassConstraint: StructSymbol compoundConstraint} {
                    let compoundResult BoundExpression? = TryBindChainedCompoundAssignment(
                        compoundConstraint,
                        boundReceiver,
                        eventName,
                        eventNameSyntax,
                        syntax,
                        baseOpSyntaxKind
                    )
                    if compoundResult != nil {
                        return compoundResult
                    }
                }
                if isEventCapableOperator && boundReceiver.Type is InterfaceSymbol eventInterface {
                    eventInfo = MemberLookup.GetInterfaceImportedBaseInstanceEvent(
                        eventInterface,
                        eventName,
                        out importedEventTarget
                    )
                    receiverClrType = importedEventTarget?.ClrType
                }
                if eventInfo == nil {
                    Diagnostics.ReportUnableToFindMember(eventNameSyntax.Location, eventName)
                    return BoundErrorExpression(nil)
                }
            }
            flags = BindingFlags.Public | BindingFlags.Instance
        }
        if eventInfo == nil && isEventCapableOperator && receiverClrType != nil {
            // Issue #3705: friend-visible `internal` events are candidates
            // here exactly as friend-visible methods/properties/fields are.
            let eventsIncludeInternal = CanAccessInternalsOf(receiverClrType)
            eventInfo = if boundReceiver != nil {
                MemberLookup.SafeGetEventIncludingSelfAndInterfaces(receiverClrType, eventName, eventsIncludeInternal)
            } else {
                ClrTypeUtilities.SafeGetEvent(
                    receiverClrType,
                    eventName,
                    ClrMemberVisibility.Widen(flags, eventsIncludeInternal)
                )
            }
            if !ClrMemberVisibility.IsVisible(eventInfo, eventsIncludeInternal) {
                eventInfo = nil
            }
        }
        if eventInfo == nil {
            // Issue #648 (generalized by #2154): compound assignment fallback
            // for CLR fields/properties, through either an instance receiver
            // (`obj.Prop += 1`) or an imported static type (`Type.Prop += 1`).
            if boundReceiver != nil && receiverClrType != nil {
                let clrCompound BoundExpression? = TryBindChainedClrCompoundAssignment(
                    boundReceiver,
                    receiverClrType,
                    eventName,
                    eventNameSyntax,
                    syntax,
                    baseOpSyntaxKind
                )
                if clrCompound != nil {
                    return clrCompound
                }
            } else if receiverClrType != nil {
                let clrCompound BoundExpression? = TryBindStaticClrCompoundAssignment(
                    receiverClrType,
                    eventName,
                    eventNameSyntax,
                    syntax,
                    baseOpSyntaxKind,
                    staticSymbolicContainer
                )
                if clrCompound != nil {
                    return clrCompound
                }
            }
            // Issue #4394: an event that exists but is not public is either
            // a protected event the current class inherits (subscribable
            // through its own instance, as in C#) or out of reach, which is
            // "inaccessible", not "cannot find member".
            if isEventCapableOperator && receiverClrType != nil {
                eventInfo = ResolveNonPublicClrEvent(
                    receiverClrType,
                    boundReceiver,
                    isAdd,
                    eventNameSyntax,
                    syntax.Value,
                    out var reportedInaccessible
                )
                if reportedInaccessible {
                    return BoundErrorExpression(nil)
                }
            }
            if eventInfo == nil {
                Diagnostics.ReportUnableToFindMember(eventNameSyntax.Location, eventName)
                return BoundErrorExpression(nil)
            }
        }
        // Issue #4394: the visibility probe above admits an event by its add
        // accessor; `-=` calls the remove accessor, which metadata can declare
        // with a different accessibility. The same predicate as the
        // non-public path decides, for the accessor this subscription calls.
        let subscriptionAccessor = if isAdd {
            eventInfo.AddMethod
        } else {
            eventInfo.RemoveMethod
        }
        if !IsCallableClrEventAccessor(subscriptionAccessor, eventInfo.DeclaringType, boundReceiver) {
            Diagnostics.ReportMemberInaccessible(
                eventNameSyntax.Location,
                eventInfo.Name,
                eventInfo.DeclaringType?.Name ?? eventName,
                ClrEventAccessorAccessibility(subscriptionAccessor)
            )
            let _ = BindExpression(syntax.Value)
            return BoundErrorExpression(nil)
        }
        // ADR-0193 §4: a static event reached through a symbolic container
        // (`Base[string?].Changed`) reads its handler through that container,
        // so the receiver's argument nullability survives, exactly as an
        // instance event's does through its receiver.
        let handlerReceiver TypeSymbol? = importedEventTarget ?? staticSymbolicContainer
        let handlerTypeSymbol = if handlerReceiver != nil {
            MemberLookup.GetClrEventHandlerTypeSymbol(handlerReceiver, eventInfo)
        } else {
            MemberLookup.GetClrEventHandlerTypeSymbol(eventInfo)
        }
        // BindEventSubscriptionHandler is the single conversion seam. In
        // particular, a nilable structural arrow is converted to the event's
        // nilable named delegate target there; converting that result again to
        // the event's bare delegate would reject the nil that this site
        // deliberately accepts (issue #3775).
        let convertedHandler = BindEventSubscriptionHandler(syntax.Value, handlerTypeSymbol)
        let eventContainingType = if importedEventTarget == nil {
            default(TypeSymbol?)
        } else {
            MemberLookup.GetClrMemberDeclaringTypeSymbol(importedEventTarget, eventInfo)
        }
        return BoundClrEventSubscriptionExpression(
            nil,
            boundReceiver,
            eventInfo,
            convertedHandler,
            isAdd,
            eventContainingType: eventContainingType
        )
    }

    private func EventReceiverNameCanBindAsType(receiver NameExpressionSyntax, rightPart ExpressionSyntax) bool {
        let name = receiver.IdentifierToken.ValueText
        if !($scope.TryLookupSymbol(name) is VariableSymbol) {
            return true
        }
        return TryResolveColorColorType(
            name,
            receiver,
            out var importedType,
            out var sourceType,
            out var interfaceType,
            out var enumType
        ) &&
            RightPartLooksLikeStaticMember(importedType, sourceType, interfaceType, enumType, rightPart)
    }

    /// Issue #503 follow-up: binds the right-hand side of an event
    /// subscription against the event's declared handler delegate type. This
    /// is the unified entry point for both user-event and CLR-event
    /// subscriptions, so method-group conversions (`src.Changed +=
    /// this.OnHit`, `src.Changed += OnHit`) are resolved consistently
    /// against the event delegate's `Invoke` signature.
    ///
    /// The helper first inspects the syntactic form of the handler:
    /// * A bare (cref:NameExpressionSyntax) that names an instance
    /// method on the implicit `this` is bound as an instance method
    /// group captured against `this`.
    /// * An (cref:AccessorExpressionSyntax) whose left part
    /// evaluates to a user-defined class and whose right part names an
    /// instance method on that class is bound as an instance method
    /// group captured against the bound receiver.
    /// If neither pattern matches, the handler is bound through
    /// `BindExpression` as usual.
    ///
    /// Once bound, a method-group handler is routed through
    /// `BindConversion` with the event's declared delegate type
    /// so the resolved overload, target delegate, and (for instance groups)
    /// captured receiver are all known by the time the emitter runs.
    private func BindEventSubscriptionHandler(
        handlerSyntax ExpressionSyntax,
        targetDelegateType TypeSymbol
    ) BoundExpression {
        // Bare `OnHit` inside the declaring class: implicit-`this` instance
        // method group. Recognized before the general BindExpression because
        // a non-event name lookup would otherwise emit GS0125 for instance
        // methods (which aren't surfaced as variables).
        if handlerSyntax is NameExpressionSyntax bareName &&
            function?.ThisParameter != nil &&
            function!!.ReceiverType is StructSymbol implicitThisStruct {
            let methods = TypeMemberModel.GetMethods(
                implicitThisStruct,
                bareName.IdentifierToken.ValueText,
                MemberQuery.Instance(MemberKinds.Method)
            )
            if !methods.IsDefaultOrEmpty {
                let receiver = BoundVariableExpression(nil, function!!.ThisParameter!!)
                let group = BuildInstanceMethodGroup(receiver, methods)
                return conversions.BindConversion(handlerSyntax.Location, group, targetDelegateType)
            }
        }
        // `recv.OnHit` where recv is a user-defined class: bind the receiver
        // once, then surface the named instance method as a method group
        // captured against that receiver. We bind the LeftPart inline so the
        // fallback `BindExpression(handlerSyntax)` doesn't re-emit any
        // diagnostics produced during LeftPart binding.
        if handlerSyntax is AccessorExpressionSyntax memberAccess &&
            memberAccess.RightPart is NameExpressionSyntax memberName &&
            !memberAccess
            .IsNullConditional {
            let boundReceiver = BindExpression(memberAccess.LeftPart)
            if boundReceiver is BoundErrorExpression || boundReceiver.Type == TypeSymbol.Error {
                // LeftPart already reported its own diagnostic; surface the
                // error directly to avoid re-binding (and re-reporting) below.
                return boundReceiver
            }
            if boundReceiver.Type is StructSymbol receiverStruct {
                let methods = TypeMemberModel.GetMethods(
                    receiverStruct,
                    memberName.IdentifierToken.ValueText,
                    MemberQuery.Instance(MemberKinds.Method)
                )
                if !methods.IsDefaultOrEmpty {
                    let group = BuildInstanceMethodGroup(boundReceiver, methods)
                    return conversions.BindConversion(handlerSyntax.Location, group, targetDelegateType)
                }
            }
            // Not an instance method on a user class — fall through to the
            // standard accessor binder via a synthetic accessor reusing the
            // already-bound LeftPart. The fast path is `recv.MemberName`
            // where the rebind is cheap; the slower path materializes the
            // bound receiver into a synthetic local so it isn't re-evaluated.
            return ConvertEventSubscriptionHandler(
                handlerSyntax,
                BindEventSubscriptionHandlerFromBoundAccessor(memberAccess, boundReceiver, targetDelegateType),
                targetDelegateType
            )
        }
        // Issue #2389: an untyped arrow lambda handler (`Ticked += (count) ->
        // ...`) omits its parameter type clauses and relies entirely on a
        // target function type to infer them (ADR-0076 / issue #716). The
        // plain `BindExpression(handlerSyntax)` fallback below binds with NO
        // target type at all, so inference fails with GS0304 even though the
        // event's declared delegate type (`targetDelegateType`) fully
        // determines the expected parameter/return shape — the same target
        // shape already threaded into target-typed local declarations
        // (StatementBinder.Narrowing.cs) and call-argument inference
        // (OverloadResolver.*). Reuse that established
        // `TryGetLambdaTargetFunctionTypeFromSymbol` conversion here so the
        // event's delegate type (whether a user `delegate` alias or a
        // genuinely imported CLR delegate) fills in the omitted parameter
        // types before falling through to the same method-group / conversion
        // handling below that already covers typed lambdas.
        if !TryBindLambdaExpressionWithTargetType(handlerSyntax, targetDelegateType, out var bound) {
            bound = BindExpression(handlerSyntax)
        }
        if bound is BoundClrMethodGroupExpression clrGroup && clrGroup.ResolvedMethod == nil {
            return conversions.BindConversion(handlerSyntax.Location, clrGroup, targetDelegateType)
        }
        if bound is BoundMethodGroupExpression userGroup {
            return conversions.BindConversion(handlerSyntax.Location, userGroup, targetDelegateType)
        }
        // Issue #2066: a lambda/function literal handler (`Ticked += (count
        // int32) -> ...`) reaches here still typed as its own inferred
        // anonymous function type rather than the event's declared delegate
        // type. Without converting it, the emitted `add_`/`remove_` call
        // passes a value shaped like the erased native delegate (e.g.
        // `System.Action<int32>`) where a named delegate (e.g.
        // `TickHandler`) is expected, producing invalid IL. Route it (and any
        // other not-yet-matching handler shape) through the same conversion
        // the method-group branches above already apply.
        return ConvertEventSubscriptionHandler(handlerSyntax, bound!!, targetDelegateType)
    }

    private func ConvertEventSubscriptionHandler(
        handlerSyntax ExpressionSyntax,
        handler BoundExpression,
        targetDelegateType TypeSymbol
    ) BoundExpression {
        return if handler.Type != targetDelegateType && !(handler is BoundErrorExpression) {
            conversions.BindConversion(
                handlerSyntax.Location,
                handler,
                NilTolerantHandlerTarget(handler, targetDelegateType)
            )
        } else {
            handler
        }
    }

    /// Helper for (cref:BindEventSubscriptionHandler): completes
    /// binding for an `obj.Member` handler when `obj` has already
    /// been bound (so we don't re-bind it and double-report diagnostics) and
    /// the member isn't a user-instance method. Defers to the standard
    /// accessor binder for the simple `name.member` shape; for any
    /// other shape we still re-bind the full syntax (no duplicate diagnostic
    /// risk since this branch is entered only when `boundReceiver`
    /// produced no errors).
    private func BindEventSubscriptionHandlerFromBoundAccessor(
        memberAccess AccessorExpressionSyntax,
        boundReceiver BoundExpression,
        targetDelegateType TypeSymbol
    ) BoundExpression {
        let bound = BindExpression(memberAccess)
        if bound is BoundClrMethodGroupExpression clrGroup && clrGroup.ResolvedMethod == nil {
            return conversions.BindConversion(memberAccess.Location, clrGroup, targetDelegateType)
        }
        if bound is BoundMethodGroupExpression userGroup {
            return conversions.BindConversion(memberAccess.Location, userGroup, targetDelegateType)
        }
        return bound
    }

    /// ADR-0062: binds a general conditional expression as a conditional
    /// address-of when used as the payload of a ref-kind modifier or as the
    /// operand of `&`. Reuses the same validation rules as
    /// (cref:ConversionClassifier.BindConditionalRefArgument) minus the inner-modifier
    /// checks (which the generalized syntax does not carry).
    /// @param syntax The general conditional expression syntax.
    /// @param outerModifier The outer ref-kind modifier token (`null` for the bare `&` operand form).
    /// @returns The bound conditional address expression, or a (cref:BoundErrorExpression) on failure.
    private func BindConditionalAddressFromGeneral(
        syntax ConditionalExpressionSyntax,
        outerModifier SyntaxToken?
    ) BoundExpression {
        // Condition must be bool.
        let condition = BindExpression(syntax.Condition, TypeSymbol.Bool)
        let whenTrue = BindExpression(syntax.WhenTrue)
        let whenFalse = BindExpression(syntax.WhenFalse)
        if whenTrue is BoundErrorExpression || whenFalse is BoundErrorExpression || condition is BoundErrorExpression {
            return BoundErrorExpression(nil)
        }
        if !IsLvalue(whenTrue) {
            Diagnostics.ReportCannotTakeAddressOfNonLvalue(syntax.WhenTrue.Location, syntax.WhenTrue.ToString())
            return BoundErrorExpression(nil)
        }
        if !IsLvalue(whenFalse) {
            Diagnostics.ReportCannotTakeAddressOfNonLvalue(syntax.WhenFalse.Location, syntax.WhenFalse.ToString())
            return BoundErrorExpression(nil)
        }
        // Branch types must match exactly — no implicit widening, since the
        // resulting byref selects between slots whose physical type must agree.
        if !object.ReferenceEquals(whenTrue.Type, whenFalse.Type) && !string.Equals(
            whenTrue.Type?.Name,
            whenFalse.Type?.Name,
            StringComparison.Ordinal
        ) {
            Diagnostics.ReportConditionalRefArgumentBranchTypeMismatch(
                syntax.Location,
                whenTrue.Type?.Name ?? "?",
                whenFalse.Type?.Name ?? "?"
            )
            return BoundErrorExpression(nil)
        }
        let outerText = outerModifier?.Text ?? "&"
        let requiresWritable = outerText == "ref" || outerText == "out" || outerText == "&"
        if requiresWritable {
            if RefCapabilities.IsReadOnlyStorage(whenTrue) {
                Diagnostics.ReportCannotTakeAddressOfConstant(syntax.WhenTrue.Location, syntax.WhenTrue.ToString())
                return BoundErrorExpression(nil)
            }
            if RefCapabilities.IsReadOnlyStorage(whenFalse) {
                Diagnostics.ReportCannotTakeAddressOfConstant(syntax.WhenFalse.Location, syntax.WhenFalse.ToString())
                return BoundErrorExpression(nil)
            }
        }
        return BoundConditionalAddressExpression(
            nil,
            condition,
            whenTrue,
            whenFalse,
            Invariant.Required(whenTrue.Type, "a bound lvalue has a type", expression: "whenTrue.Type")
        )
    }

    private func BindAwaitExpression(syntax AwaitExpressionSyntax) BoundExpression {
        // ADR-0174 D15: `await name` on an `async let` binding reads the cell
        // the child deposits into. It is intercepted before the operand binds,
        // because binding the bare name is exactly what GS0569 forbids — and
        // before the async check, because a plain caller is coloured suspending
        // by this very read, the same way a suspending call colours it.
        if syntax.Expression is NameExpressionSyntax name && $scope.TryLookupSymbol(
            name.IdentifierToken.ValueText
        ) is AsyncLetVariableSymbol binding {
            binding.WasAwaited = true
            if !EnsureChannelRuntime(syntax.AwaitKeyword.Location) {
                return BoundErrorExpression(nil)
            }
            let read = binderCtx.ChannelRuntime.BindAsyncLetAwait(binding.Cell, binding.Type)
            return CompleteSuspendingCall(read, binding.Type, syntax.AwaitKeyword.Location, binding.Name)
        }
        var operand = BindExpression(syntax.Expression)
        if function == nil {
            Diagnostics.ReportAwaitOutsideAsyncFunction(syntax.AwaitKeyword.Location)
            return BoundErrorExpression(nil)
        }
        if operand is BoundErrorExpression {
            return operand
        }
        // ADR-0174 D4: a call to a suspending function is already awaited
        // implicitly (CompleteSuspendingCall), so an explicit `await` on top
        // is redundant but legal — `await twice(ch)` is what a C# or Go
        // programmer (and cs2gs) writes, and rejecting it with GS0133 "int32
        // cannot be awaited" would point at a type the source never spelled.
        // In a not-yet-inferred plain caller the completion is a
        // `Blocking.Wait` bridge that the inference pass turns into an await
        // once the caller is coloured; either way the completed call is the
        // result.
        if IsCompletedSuspendingCall(operand) {
            return operand
        }
        // ADR-0186 §4: awaiting requires a non-null awaitable. A platform
        // task (`Task[string]!`, routine from an ADR-0186 §9 oblivious scope)
        // is checked and unwrapped here, so a nil one fails attributably
        // instead of inside the awaiter machinery. After the completed-
        // suspending-call test, not before: that call's result is the
        // function's logical result, which may itself be `T!`, and checking it
        // would both hide the call from the test and assert a legitimate nil.
        operand = binderCtx.InsertPlatformCheck(operand, syntax.Expression.Location, "an awaited operand")
        if !TryGetTaskElementType(operand.Type, out var element) {
            Diagnostics.ReportTypeIsNotAwaitable(syntax.Expression.Location, operand.Type)
            return BoundErrorExpression(nil)
        }
        // ADR-0174 D4, the `await g()` row: awaiting makes the AWAITING
        // function suspending. Inside an `async func` (or an async iterator)
        // that is C#'s ordinary await over an observable task, and nothing
        // changes. In a plain `func` the await is a suspension point like a
        // channel operation: the binder leaves it in place and
        // `SuspensionPointCollector` reports it, so the inference pass colours
        // this function and the state-machine rewriter takes the await from
        // there. A function whose signature inference may not change — D4's
        // boundaries — is where that stops, and `SuspendingCallRewriter`
        // reports the await that survives — which is why this node carries its
        // syntax: that report needs the `await` keyword's own location.
        return BoundAwaitExpression(syntax, operand, element, TryGetAwaiterTypeSymbol(operand.Type))
    }

    /// ADR-0174 D4: finishes a call to a suspending function. The call itself
    /// is typed `ValueTask[R]`; a G# caller sees `R`. Inside an
    /// `async`, suspending, or async-iterator body that is an implicit
    /// await; anywhere else the caller has nowhere to await, so the call
    /// blocks through `Blocking.Wait` and GS0558 says so — except at the
    /// synthesized entry point, which is the root where blocking is correct.
    /// @param call The bound call, typed `ValueTask` or `ValueTask[R]`.
    /// @param logicalType The callee's logical return type `R`.
    /// @param location The call's location, for GS0558.
    /// @param calleeName The callee's name, for GS0558.
    /// @returns An expression typed [`logicalType`](paramref).
    internal func CompleteSuspendingCall(
        call BoundExpression,
        logicalType TypeSymbol,
        location TextLocation,
        calleeName string
    ) BoundExpression {
        if call is BoundErrorExpression || call.Type == nil || call.Type == TypeSymbol.Error {
            return call
        }
        if function != nil && (function!!.IsAsyncOrSuspending || isAsyncIteratorReturnType(function!!.Type)) {
            return BoundAwaitExpression.CreateImplicitCompletion(
                nil,
                call,
                logicalType,
                TryGetAwaiterTypeSymbol(call.Type)
            )
        }
        if !EnsureChannelRuntime(location) {
            return BoundErrorExpression(nil)
        }
        // GS0558 is reported by the inference pass (Suspension.SuspensionInference)
        // for the bridges that remain after the caller's own coloring is known.
        return binderCtx.ChannelRuntime.BindBlockingWait(call, logicalType)
    }

    /// ADR-0174 D4, the import side: a CLR method carrying
    /// `[Gsharp.Concurrency.Suspending]` was emitted by G# as a suspending
    /// function, so its call is completed exactly like a same-assembly one —
    /// the logical type is the awaited element of its `ValueTask` return.
    /// @param call The bound imported call.
    /// @param method The CLR method it targets.
    /// @param location The call's location, for GS0558.
    /// @returns The completed call, or [`call`](paramref) when the method is not suspending.
    internal func CompleteImportedSuspendingCall(
        call BoundExpression,
        method MethodInfo,
        location TextLocation
    ) BoundExpression {
        if !ImportedFunctionSymbol.IsSuspendingMethod(method) || call.Type == nil {
            return call
        }
        let logicalType = if AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(call.Type, out var awaited) {
            awaited!!
        } else {
            TypeSymbol.Void
        }
        return CompleteSuspendingCall(call, logicalType, location, method.Name)
    }

    shared {
        private func IsSameOrDerivedClrType(type Type, ancestor Type) bool {
            let ancestorDefinition = if ancestor.IsGenericType {
                ancestor.GetGenericTypeDefinition()
            } else {
                ancestor
            }
            for var current Type? = type; current != nil; current = current!!.BaseType {
                let currentDefinition = if current.IsGenericType {
                    current.GetGenericTypeDefinition()
                } else {
                    current
                }
                if current.IsSameAs(ancestor) || currentDefinition.IsSameAs(ancestorDefinition) {
                    return true
                }
            }
            return false
        }

        /// The G# accessibility that names why an imported event accessor is out of
        /// reach, for the inaccessible-member diagnostic: `protected` (GS0379)
        /// for an accessor a derived class could call, `private` (GS0472)
        /// for one that no code outside its assembly can call (`private`,
        /// `internal`, `private protected`).
        /// @param accessor The add or remove accessor, if any.
        /// @returns The accessibility to report.
        private func ClrEventAccessorAccessibility(accessor MethodInfo?) Accessibility -> if accessor != nil &&
            (accessor.IsFamily || accessor.IsFamilyOrAssembly) {
            Accessibility.Protected
        } else {
            Accessibility.Private
        }

        /// Issue #3775: `e += h` / `e -= h` where `h` is nil is a
        /// silent no-op in C# — `add_E` forwards to
        /// (cref:Delegate.Combine(Delegate?, Delegate?)), which returns the
        /// other operand unchanged — so an `EventHandler?` handler is a legal
        /// subscription argument, not a conversion error. Binding the handler
        /// against the event's bare (non-nilable) delegate type rejected exactly
        /// that shape with `GS0155`, which is the same defect class as the
        /// unguarded `using` cleanup fixed in #3787: a position where the
        /// lowering assumes non-nil while C# defines nil-tolerant behaviour. Here
        /// the divergence surfaces at bind time rather than at run time, because
        /// the only way to spell the subscription was a `!!` that throws.
        ///
        /// The relaxation is scoped to the subscription argument alone: it widens
        /// the conversion target to `T?` only when the handler expression is
        /// already nilable (or the literal `nil`) and the delegate type's CLR
        /// representation is a managed reference. A method group, a lambda, and a
        /// non-nilable handler are all unaffected, and nothing about the event's
        /// own declared type changes — the backing delegate stays exactly as
        /// nilable as it always was.
        /// @param handler The bound handler expression.
        /// @param targetDelegateType The event's declared delegate type.
        /// @returns The conversion target for the handler.
        private func NilTolerantHandlerTarget(handler BoundExpression, targetDelegateType TypeSymbol) TypeSymbol {
            if targetDelegateType is NullableTypeSymbol || NullableTypeSymbol.GetEffectiveClrType(
                targetDelegateType
            ) is {IsValueType: true} {
                // Already nilable, or not a managed reference at all: leave the
                // target exactly as the caller computed it.
                return targetDelegateType
            }
            let isNilableHandler = handler.Type is NullableTypeSymbol ||
                handler.Type == TypeSymbol.Null ||
                handler is BoundLiteralExpression &&
                handler.Value == nil
            return if isNilableHandler {
                cast[TypeSymbol](NullableTypeSymbol.Get(targetDelegateType))
            } else {
                targetDelegateType
            }
        }

        // The implicit await produced by CompleteSuspendingCall yields the logical
        // type R; a genuine nested await (`await (await f())` on a `Task[Task[T]]`)
        // yields a Task and is left to the ordinary path.
        private func IsCompletedSuspendingCall(operand BoundExpression) bool -> (
            operand is BoundAwaitExpression && !TryGetTaskElementType(operand.Type, out _)
        ) ||
            (operand is BoundImportedCallExpression bridge && LockRegions.IsBlockingBridge(bridge))

        // Issue #1785: `Task[T?]` for a same-compilation user value type
        // (struct/enum) wraps T in a NullableTypeSymbol, whose ClrType is null
        // just like the bare struct/enum case. Symbol-based detection (not
        // ClrType.IsValueType, which is null for in-flight user types) is
        // required to recognize it below.
        //
        // Issue #2030: a bare or nullable-wrapped open type parameter (e.g.
        // `await` on a `Task[U]` produced by calling another generic async
        // function from within a generic caller) reaches here the same way —
        // its `ClrType` is erased to `object`, just like a same-compilation
        // struct/enum. Build the symbolic awaiter type (`TaskAwaiter[U]`) so the
        // emitted awaiter pool field and `GetAwaiter()`/`GetResult()` call sites
        // agree on `!!0`/`!0` instead of the erased `object`.
        private func IsAwaiterTypeArgumentCandidate(a TypeSymbol) bool -> TypeSymbol.RequiresSymbolicProjection(a)

        internal func TryGetAwaiterTypeSymbol(awaitableType TypeSymbol) TypeSymbol? {
            if awaitableType is not ImportedTypeSymbol importedAwaitable ||
                importedAwaitable.OpenDefinition == nil ||
                importedAwaitable
                .TypeArguments
                .IsDefaultOrEmpty ||
                !importedAwaitable
                .TypeArguments
                .Any(IsAwaiterTypeArgumentCandidate) {
                return nil
            }
            let shape = AwaitableShape.Resolve(importedAwaitable.ClrType)
            if shape?.AwaiterType == nil || !shape!!.AwaiterType.IsConstructedGenericType {
                return nil
            }
            let awaiterOpen = shape!!.AwaiterType.GetGenericTypeDefinition()
            return ImportedTypeSymbol.GetConstructed(shape!!.AwaiterType, awaiterOpen, importedAwaitable.TypeArguments)
        }
    }
}
