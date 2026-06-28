#nullable disable

// <copyright file="ExpressionBinder.Async.cs" company="GSharp">
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
    private BoundExpression BindEventSubscriptionExpression(EventSubscriptionExpressionSyntax syntax)
    {
        // Bare identifier `EventName += handler` / `EventName -= handler`:
        // the parser now emits this form for all `id +=/-=` patterns. Try to
        // resolve as an event on the implicit `this`; if not an event, fall
        // back to compound assignment semantics (`x += 1`).
        if (syntax.LeftHandSide is NameExpressionSyntax bareName)
        {
            return BindBareEventOrCompoundAssignment(bareName, syntax);
        }

        // Stream B′: `lhs.Event += handler` / `lhs.Event -= handler`.
        if (syntax.LeftHandSide is not AccessorExpressionSyntax accessor)
        {
            Diagnostics.ReportUnableToFindMember(syntax.LeftHandSide.Location, syntax.OperatorToken.Text);
            return new BoundErrorExpression(null);
        }

        // Issue #503 follow-up: `A.B.Event += handler` (chained-receiver
        // subscription). The parser produces a *right-associative* accessor
        // chain — `A . (B . Event)` — so accessor.RightPart is itself an
        // AccessorExpressionSyntax and the event name is at the rightmost
        // leaf. Rotate the chain into the canonical left-associative form
        // `(A . B) . Event` so the existing receiver/event-name resolution
        // below (which assumes the right part is a single name) just works.
        accessor = NormalizeAccessorLeftAssociative(accessor);

        if (accessor.RightPart is not NameExpressionSyntax eventNameSyntax)
        {
            Diagnostics.ReportUnableToFindMember(accessor.RightPart.Location, syntax.OperatorToken.Text);
            return new BoundErrorExpression(null);
        }

        var eventName = eventNameSyntax.IdentifierToken.Text;
        var isAdd = syntax.OperatorToken.Kind == SyntaxKind.PlusEqualsToken;

        // Resolve receiver: either an ImportedClassSymbol (static event) or
        // any value-producing expression with a CLR-backed type (instance event).
        BoundExpression boundReceiver = null;
        Type receiverClrType = null;
        BindingFlags flags;
        if (accessor.LeftPart is NameExpressionSyntax leftName
            && scope.TryLookupImportedClass(leftName.IdentifierToken.Text, leftName, out var importedClass))
        {
            receiverClrType = importedClass.ClassType;
            flags = BindingFlags.Public | BindingFlags.Static;
        }
        else if (accessor.LeftPart is NameExpressionSyntax staticLeftName
            && scope.TryLookupTypeAlias(staticLeftName.IdentifierToken.Text, out var staticTypeAlias)
            && staticTypeAlias is StructSymbol staticStruct)
        {
            // Issue #263: static event subscription on a user-defined type.
            // Try matching an event first; if no match, fall through to
            // ADR-0053 static field/property compound assignment instead of
            // reporting an immediate "unable to find member".
            if (TypeMemberModel.TryGetStaticEvent(staticStruct, eventName, out var ev))
            {
                var userHandler = BindEventSubscriptionHandler(syntax.Value, ev.Type);
                return new BoundEventSubscriptionExpression(null, receiver: null, staticStruct, ev, userHandler, isAdd);
            }

            // ADR-0053: `Type.StaticField += rhs` / `Type.StaticProp += rhs`.
            // The simple-assignment path is handled by BindFieldAssignmentExpression
            // (lines ~6586–6619); this is the compound counterpart.
            if (TryBindUserTypeStaticCompoundAssignment(staticStruct, eventNameSyntax, syntax, isAdd, out var compoundResult))
            {
                return compoundResult;
            }

            Diagnostics.ReportUnableToFindMember(eventNameSyntax.Location, eventName);
            return new BoundErrorExpression(null);
        }
        else if (accessor.LeftPart is NameExpressionSyntax ifaceLeftName
            && scope.TryLookupTypeAlias(ifaceLeftName.IdentifierToken.Text, out var ifaceTypeAlias)
            && ifaceTypeAlias is InterfaceSymbol staticInterface)
        {
            // ADR-0089 / issue #1030: `IName.StaticField += rhs` — compound
            // assignment to a (non-generic) interface static field.
            if (TryBindInterfaceStaticCompoundAssignment(staticInterface, eventNameSyntax, syntax, isAdd, out var ifaceCompound))
            {
                return ifaceCompound;
            }

            Diagnostics.ReportUnableToFindMember(eventNameSyntax.Location, eventName);
            return new BoundErrorExpression(null);
        }
        else if (accessor.LeftPart is IndexExpressionSyntax ifaceIndex
            && !ifaceIndex.IsNullConditional
            && TryResolveConstructedGenericInterfaceReceiver(ifaceIndex, out var ctorInterface))
        {
            // ADR-0089 / issue #1030: `IBox[int32].StaticField += rhs` —
            // compound assignment to a constructed generic interface static
            // field (per-construction storage).
            if (TryBindInterfaceStaticCompoundAssignment(ctorInterface, eventNameSyntax, syntax, isAdd, out var ctorCompound))
            {
                return ctorCompound;
            }

            Diagnostics.ReportUnableToFindMember(eventNameSyntax.Location, eventName);
            return new BoundErrorExpression(null);
        }
        else
        {
            boundReceiver = BindExpression(accessor.LeftPart);
            if (boundReceiver.Type == TypeSymbol.Error)
            {
                return new BoundErrorExpression(null);
            }

            // Check for user-defined event on a StructSymbol before falling through to CLR reflection.
            // ADR-0112 A5: TryGetEvent walks the base chain, so inherited instance
            // events on `open class` bases now resolve (parity with the bare-`this`
            // path in BindBareEventOrCompoundAssignment). The owner symbol remains
            // `userStruct` (the receiver's static type) to preserve the bound-node shape.
            if (boundReceiver.Type is StructSymbol userStruct && TypeMemberModel.TryGetEvent(userStruct, eventName, out var ev))
            {
                var userHandler = BindEventSubscriptionHandler(syntax.Value, ev.Type);
                return new BoundEventSubscriptionExpression(null, boundReceiver, userStruct, ev, userHandler, isAdd);
            }

            receiverClrType = boundReceiver.Type?.ClrType;
            if (receiverClrType == null)
            {
                // Issue #648: compound assignment fallback for chained member access
                // on user-defined struct/class types (e.g. `a.B.C += 1`). The parser
                // routes all `lhs.member +=/-=` through EventSubscriptionExpression;
                // when the member is not an event we fall back to compound assignment.
                if (boundReceiver.Type is StructSymbol compoundStruct)
                {
                    var compoundResult = TryBindChainedCompoundAssignment(
                        compoundStruct, boundReceiver, eventName, eventNameSyntax, syntax, isAdd);
                    if (compoundResult != null)
                    {
                        return compoundResult;
                    }
                }

                Diagnostics.ReportUnableToFindMember(eventNameSyntax.Location, eventName);
                return new BoundErrorExpression(null);
            }

            flags = BindingFlags.Public | BindingFlags.Instance;
        }

        var eventInfo = ClrTypeUtilities.SafeGetEvent(receiverClrType, eventName, flags);
        if (eventInfo == null)
        {
            // Issue #648: compound assignment fallback for chained CLR member access
            // (e.g. `obj.Prop += 1` where Prop is a field/property, not an event).
            if (boundReceiver != null)
            {
                var clrCompound = TryBindChainedClrCompoundAssignment(
                    boundReceiver, receiverClrType, eventName, eventNameSyntax, syntax, isAdd);
                if (clrCompound != null)
                {
                    return clrCompound;
                }
            }

            Diagnostics.ReportUnableToFindMember(eventNameSyntax.Location, eventName);
            return new BoundErrorExpression(null);
        }

        var handlerType = eventInfo.EventHandlerType;
        var handlerTypeSymbol = TypeSymbol.FromClrType(handlerType);
        var boundHandler = BindEventSubscriptionHandler(syntax.Value, handlerTypeSymbol);

        // The handler is most useful when expressed as a function literal of
        // matching signature. For that path we skip BindConversion (which has
        // no generic fn → custom-delegate rule) and rely on the evaluator /
        // emitter to materialize the right delegate type. Otherwise fall back
        // to the standard conversion (covers null, already-typed delegate
        // variables, etc.). Method-group handlers were already routed through
        // BindEventSubscriptionHandler above and arrive here resolved.
        BoundExpression convertedHandler;
        if (boundHandler is BoundFunctionLiteralExpression
            || boundHandler is BoundMethodGroupExpression
            || boundHandler is BoundClrMethodGroupExpression
            || (boundHandler.Type is FunctionTypeSymbol fn
                && IsSignatureCompatibleWithDelegate(fn, handlerType)))
        {
            convertedHandler = boundHandler;
        }
        else
        {
            convertedHandler = conversions.BindConversion(syntax.Value.Location, boundHandler, handlerTypeSymbol);
        }

        return new BoundClrEventSubscriptionExpression(null, boundReceiver, eventInfo, convertedHandler, isAdd);
    }

    /// <summary>
    /// Issue #503 follow-up: binds the right-hand side of an event
    /// subscription against the event's declared handler delegate type. This
    /// is the unified entry point for both user-event and CLR-event
    /// subscriptions, so method-group conversions (<c>src.Changed +=
    /// this.OnHit</c>, <c>src.Changed += OnHit</c>) are resolved consistently
    /// against the event delegate's <c>Invoke</c> signature.
    ///
    /// The helper first inspects the syntactic form of the handler:
    ///   * A bare <see cref="NameExpressionSyntax"/> that names an instance
    ///     method on the implicit <c>this</c> is bound as an instance method
    ///     group captured against <c>this</c>.
    ///   * An <see cref="AccessorExpressionSyntax"/> whose left part
    ///     evaluates to a user-defined class and whose right part names an
    ///     instance method on that class is bound as an instance method
    ///     group captured against the bound receiver.
    /// If neither pattern matches, the handler is bound through
    /// <c>BindExpression</c> as usual.
    ///
    /// Once bound, a method-group handler is routed through
    /// <c>BindConversion</c> with the event's declared delegate type
    /// so the resolved overload, target delegate, and (for instance groups)
    /// captured receiver are all known by the time the emitter runs.
    /// </summary>
    private BoundExpression BindEventSubscriptionHandler(ExpressionSyntax handlerSyntax, TypeSymbol targetDelegateType)
    {
        // Bare `OnHit` inside the declaring class: implicit-`this` instance
        // method group. Recognized before the general BindExpression because
        // a non-event name lookup would otherwise emit GS0125 for instance
        // methods (which aren't surfaced as variables).
        if (handlerSyntax is NameExpressionSyntax bareName
            && function?.ThisParameter != null
            && function.ReceiverType is StructSymbol implicitThisStruct)
        {
            var methods = TypeMemberModel.GetMethods(implicitThisStruct, bareName.IdentifierToken.Text, MemberQuery.Instance(MemberKinds.Method));
            if (!methods.IsDefaultOrEmpty)
            {
                var receiver = new BoundVariableExpression(null, function.ThisParameter);
                var group = BuildInstanceMethodGroup(receiver, methods);
                return conversions.BindConversion(handlerSyntax.Location, group, targetDelegateType);
            }
        }

        // `recv.OnHit` where recv is a user-defined class: bind the receiver
        // once, then surface the named instance method as a method group
        // captured against that receiver. We bind the LeftPart inline so the
        // fallback `BindExpression(handlerSyntax)` doesn't re-emit any
        // diagnostics produced during LeftPart binding.
        if (handlerSyntax is AccessorExpressionSyntax memberAccess
            && memberAccess.RightPart is NameExpressionSyntax memberName
            && !memberAccess.IsNullConditional)
        {
            var boundReceiver = BindExpression(memberAccess.LeftPart);
            if (boundReceiver is BoundErrorExpression || boundReceiver.Type == TypeSymbol.Error)
            {
                // LeftPart already reported its own diagnostic; surface the
                // error directly to avoid re-binding (and re-reporting) below.
                return boundReceiver;
            }

            if (boundReceiver.Type is StructSymbol receiverStruct)
            {
                var methods = TypeMemberModel.GetMethods(receiverStruct, memberName.IdentifierToken.Text, MemberQuery.Instance(MemberKinds.Method));
                if (!methods.IsDefaultOrEmpty)
                {
                    var group = BuildInstanceMethodGroup(boundReceiver, methods);
                    return conversions.BindConversion(handlerSyntax.Location, group, targetDelegateType);
                }
            }

            // Not an instance method on a user class — fall through to the
            // standard accessor binder via a synthetic accessor reusing the
            // already-bound LeftPart. The fast path is `recv.MemberName`
            // where the rebind is cheap; the slower path materializes the
            // bound receiver into a synthetic local so it isn't re-evaluated.
            return BindEventSubscriptionHandlerFromBoundAccessor(memberAccess, boundReceiver, targetDelegateType);
        }

        var bound = BindExpression(handlerSyntax);

        if (bound is BoundClrMethodGroupExpression clrGroup && clrGroup.ResolvedMethod == null)
        {
            return conversions.BindConversion(handlerSyntax.Location, clrGroup, targetDelegateType);
        }

        if (bound is BoundMethodGroupExpression userGroup)
        {
            return conversions.BindConversion(handlerSyntax.Location, userGroup, targetDelegateType);
        }

        return bound;
    }

    /// <summary>
    /// Helper for <see cref="BindEventSubscriptionHandler"/>: completes
    /// binding for an <c>obj.Member</c> handler when <c>obj</c> has already
    /// been bound (so we don't re-bind it and double-report diagnostics) and
    /// the member isn't a user-instance method. Defers to the standard
    /// accessor binder for the simple <c>name.member</c> shape; for any
    /// other shape we still re-bind the full syntax (no duplicate diagnostic
    /// risk since this branch is entered only when <c>boundReceiver</c>
    /// produced no errors).
    /// </summary>
    private BoundExpression BindEventSubscriptionHandlerFromBoundAccessor(
        AccessorExpressionSyntax memberAccess,
        BoundExpression boundReceiver,
        TypeSymbol targetDelegateType)
    {
        _ = boundReceiver;
        var bound = BindExpression(memberAccess);

        if (bound is BoundClrMethodGroupExpression clrGroup && clrGroup.ResolvedMethod == null)
        {
            return conversions.BindConversion(memberAccess.Location, clrGroup, targetDelegateType);
        }

        if (bound is BoundMethodGroupExpression userGroup)
        {
            return conversions.BindConversion(memberAccess.Location, userGroup, targetDelegateType);
        }

        return bound;
    }

    /// <summary>
    /// ADR-0062: binds a general conditional expression as a conditional
    /// address-of when used as the payload of a ref-kind modifier or as the
    /// operand of <c>&amp;</c>. Reuses the same validation rules as
    /// <see cref="ConversionClassifier.BindConditionalRefArgument"/> minus the inner-modifier
    /// checks (which the generalized syntax does not carry).
    /// </summary>
    /// <param name="syntax">The general conditional expression syntax.</param>
    /// <param name="outerModifier">The outer ref-kind modifier token (<see langword="null"/> for the bare <c>&amp;</c> operand form).</param>
    /// <returns>The bound conditional address expression, or a <see cref="BoundErrorExpression"/> on failure.</returns>
    private BoundExpression BindConditionalAddressFromGeneral(
        ConditionalExpressionSyntax syntax,
        SyntaxToken outerModifier)
    {
        // Condition must be bool.
        var condition = BindExpression(syntax.Condition, TypeSymbol.Bool);

        var whenTrue = BindExpression(syntax.WhenTrue);
        var whenFalse = BindExpression(syntax.WhenFalse);

        if (whenTrue is BoundErrorExpression || whenFalse is BoundErrorExpression || condition is BoundErrorExpression)
        {
            return new BoundErrorExpression(null);
        }

        if (!IsLvalue(whenTrue))
        {
            Diagnostics.ReportCannotTakeAddressOfNonLvalue(syntax.WhenTrue.Location, syntax.WhenTrue.ToString());
            return new BoundErrorExpression(null);
        }

        if (!IsLvalue(whenFalse))
        {
            Diagnostics.ReportCannotTakeAddressOfNonLvalue(syntax.WhenFalse.Location, syntax.WhenFalse.ToString());
            return new BoundErrorExpression(null);
        }

        // Branch types must match exactly — no implicit widening, since the
        // resulting byref selects between slots whose physical type must agree.
        if (!ReferenceEquals(whenTrue.Type, whenFalse.Type)
            && !string.Equals(whenTrue.Type?.Name, whenFalse.Type?.Name, System.StringComparison.Ordinal))
        {
            Diagnostics.ReportConditionalRefArgumentBranchTypeMismatch(
                syntax.Location,
                whenTrue.Type?.Name ?? "?",
                whenFalse.Type?.Name ?? "?");
            return new BoundErrorExpression(null);
        }

        string outerText = outerModifier?.Text ?? "&";
        bool requiresWritable = outerText == "ref" || outerText == "out" || outerText == "&";
        if (requiresWritable)
        {
            if (whenTrue is BoundVariableExpression wtVar && wtVar.Variable.IsReadOnly)
            {
                Diagnostics.ReportCannotTakeAddressOfConstant(syntax.WhenTrue.Location, wtVar.Variable.Name);
                return new BoundErrorExpression(null);
            }

            if (whenFalse is BoundVariableExpression wfVar && wfVar.Variable.IsReadOnly)
            {
                Diagnostics.ReportCannotTakeAddressOfConstant(syntax.WhenFalse.Location, wfVar.Variable.Name);
                return new BoundErrorExpression(null);
            }
        }

        return new BoundConditionalAddressExpression(null, condition, whenTrue, whenFalse, whenTrue.Type);
    }

    private BoundExpression BindAwaitExpression(AwaitExpressionSyntax syntax)
    {
        var operand = BindExpression(syntax.Expression);

        if (function == null || (!function.IsAsync && !isAsyncIteratorReturnType(function.Type)))
        {
            Diagnostics.ReportAwaitOutsideAsyncFunction(syntax.AwaitKeyword.Location);
            return new BoundErrorExpression(null);
        }

        if (operand is BoundErrorExpression)
        {
            return operand;
        }

        if (!TryGetTaskElementType(operand.Type, out var element))
        {
            Diagnostics.ReportTypeIsNotAwaitable(syntax.Expression.Location, operand.Type);
            return new BoundErrorExpression(null);
        }

        return new BoundAwaitExpression(null, operand, element, TryGetAwaiterTypeSymbol(operand.Type));
    }

    private static TypeSymbol TryGetAwaiterTypeSymbol(TypeSymbol awaitableType)
    {
        if (awaitableType is not ImportedTypeSymbol importedAwaitable
            || importedAwaitable.OpenDefinition == null
            || importedAwaitable.TypeArguments.IsDefaultOrEmpty
            || importedAwaitable.HasTypeParameterArgument
            || !importedAwaitable.TypeArguments.Any(static a => a is StructSymbol or InterfaceSymbol or EnumSymbol))
        {
            return null;
        }

        var shape = AwaitableShape.Resolve(importedAwaitable.ClrType);
        if (shape?.AwaiterType == null || !shape.AwaiterType.IsConstructedGenericType)
        {
            return null;
        }

        var awaiterOpen = shape.AwaiterType.GetGenericTypeDefinition();
        return ImportedTypeSymbol.GetConstructed(
            shape.AwaiterType,
            awaiterOpen,
            importedAwaitable.TypeArguments);
    }
}
