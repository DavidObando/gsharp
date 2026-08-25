// <copyright file="ExpressionBinder.Calls.Arguments.cs" company="GSharp">
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
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using System.Reflection;
using System.Text;
using GSharp.Core.CodeAnalysis.Binding.OverloadResolution;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class ExpressionBinder
{
    /// <summary>
    /// Issue #2193: returns <see langword="true"/> when a user-defined extension
    /// function for the <c>(receiver, name)</c> pair declares a function-typed
    /// (arrow / delegate) parameter at the given user-argument position. The
    /// extension's synthetic receiver occupies <c>Parameters[0]</c>, so user
    /// argument <paramref name="argSlot"/> aligns with <c>Parameters[argSlot + 1]</c>.
    /// Used to suppress CLR-derived lambda target-typing that would otherwise
    /// erase the lambda's return type and break the extension's type-argument
    /// inference.
    /// </summary>
    private bool UserExtensionHasFunctionTypedParameterAt(BoundExpression? receiver, string methodName, int argSlot)
    {
        if (receiver?.Type == null)
        {
            return false;
        }

        var extCandidates = scope.TryLookupExtensionFunctions(receiver.Type, methodName);
        if (extCandidates.IsDefaultOrEmpty)
        {
            return false;
        }

        var paramIndex = argSlot + 1;
        foreach (var candidate in extCandidates)
        {
            if (candidate != null
                && paramIndex < candidate.Parameters.Length
                && candidate.Parameters[paramIndex].Type is FunctionTypeSymbol)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #2193: overload-resolution tie-break that merges the user-defined
    /// extension-function candidate set for <c>(receiver type, name)</c> into a
    /// resolved CLR/imported instance-method call and prefers the extension when
    /// it is a strictly better match.
    /// <para>
    /// The defect: a same-named BCL instance method can be <em>applicable</em> to
    /// a call only through a lossy delegate-reshaping conversion — e.g. a G#
    /// function value <c>(T) -&gt; TResult</c> discarding its result to satisfy the
    /// named void delegate parameter of
    /// <c>SynchronizationContext.Send(SendOrPostCallback, object)</c>. Because the
    /// CLR-instance path commits as soon as it resolves, the user extension
    /// <c>Send[T, TResult]((T) -&gt; TResult, T) TResult</c> — an exact match — never
    /// competed, so the call bound to the <c>void</c> member (GS0124 / GS0151).
    /// </para>
    /// <para>
    /// The fix is deliberately conservative so it does not disturb normal
    /// instance-method resolution: the extension is only preferred when (a) the
    /// resolved instance method's <em>worst</em> argument conversion is a
    /// delegate-reshaping conversion (rank ≥
    /// <see cref="ClrOverloadResolution.ImplicitConversionKind.LambdaToVoidDelegate"/>),
    /// and (b) some applicable user extension matches the same arguments with a
    /// strictly better worst-case conversion. An instance method that matches by
    /// identity / standard implicit conversion always wins, so a genuine member
    /// that is the better match is never shadowed.
    /// </para>
    /// </summary>
    private bool TryPreferBetterExtensionOverClrInstanceMethod(
        BoundExpression? receiver,
        string methodName,
        MethodInfo? clrBest,
        Type?[]? argTypes,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames,
        [NotNullWhen(true)] out BoundExpression? result)
    {
        result = null;
        if (receiver?.Type == null || clrBest == null || argTypes == null)
        {
            return false;
        }

        var extCandidates = scope.TryLookupExtensionFunctions(receiver.Type, methodName);
        if (extCandidates.IsDefaultOrEmpty)
        {
            return false;
        }

        // Only intervene when the CLR instance method is applicable solely via a
        // lossy delegate-reshaping conversion; a good (identity/standard implicit)
        // instance match is never overridden.
        var clrWorst = ComputeClrCandidateWorstConversionRank(clrBest, argTypes);
        if (!IsDelegateReshapingConversion(clrWorst))
        {
            return false;
        }

        // The extension must be a strictly better match than the instance method.
        var extWorst = ComputeBestApplicableExtensionWorstConversionRank(extCandidates, argTypes);
        if (extWorst == ClrOverloadResolution.ImplicitConversionKind.None
            || (int)extWorst >= (int)clrWorst)
        {
            return false;
        }

        if (TryBindExtensionFunctionOverload(receiver, methodName, arguments, ce, argumentNames, out var extResult)
            && extResult is not BoundErrorExpression)
        {
            result = extResult;
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #2193: a delegate-reshaping implicit conversion (rank ≥
    /// <see cref="ClrOverloadResolution.ImplicitConversionKind.LambdaToVoidDelegate"/>
    /// and ≤
    /// <see cref="ClrOverloadResolution.ImplicitConversionKind.DelegateReturnNumericWidening"/>)
    /// reshapes a G# function value to satisfy a differently-shaped or
    /// differently-named CLR delegate parameter (discarding a return value,
    /// widening/covarying a return type, or retargeting to a named delegate).
    /// These are the "worst"-ranked conversions and are the loose applicability
    /// that lets a same-named BCL instance method shadow an exact user extension.
    /// </summary>
    private static bool IsDelegateReshapingConversion(ClrOverloadResolution.ImplicitConversionKind kind)
    {
        return kind is ClrOverloadResolution.ImplicitConversionKind.LambdaToVoidDelegate
            or ClrOverloadResolution.ImplicitConversionKind.DelegateReturnCovariance
            or ClrOverloadResolution.ImplicitConversionKind.DelegateStructuralMatch
            or ClrOverloadResolution.ImplicitConversionKind.DelegateReturnNumericWidening;
    }

    /// <summary>
    /// Issue #2193: classifies each supplied argument against the corresponding
    /// parameter of a resolved CLR candidate and returns the <em>worst</em>
    /// (highest-ordinal) implicit-conversion rank across all arguments. Returns
    /// <see cref="ClrOverloadResolution.ImplicitConversionKind.None"/> when the
    /// arities do not line up positionally (the candidate matched in an expanded
    /// / named / defaulted form this cheap check cannot reason about, so the
    /// tie-break is skipped and the instance method keeps winning).
    /// </summary>
    private static ClrOverloadResolution.ImplicitConversionKind ComputeClrCandidateWorstConversionRank(MethodInfo candidate, Type?[] argTypes)
    {
        var parameters = candidate.GetParameters();
        if (parameters.Length != argTypes.Length)
        {
            return ClrOverloadResolution.ImplicitConversionKind.None;
        }

        var worst = ClrOverloadResolution.ImplicitConversionKind.Identity;
        for (var i = 0; i < argTypes.Length; i++)
        {
            var kind = ClrOverloadResolution.ClassifyImplicit(parameters[i].ParameterType, argTypes[i]);
            if (kind == ClrOverloadResolution.ImplicitConversionKind.None)
            {
                return ClrOverloadResolution.ImplicitConversionKind.None;
            }

            if ((int)kind > (int)worst)
            {
                worst = kind;
            }
        }

        return worst;
    }

    /// <summary>
    /// Issue #2193: across every user extension overload for the
    /// <c>(receiver, name)</c> pair, computes each applicable overload's worst
    /// argument-conversion rank (using the same CLR-type projection that produced
    /// <paramref name="argTypes"/>) and returns the <em>best</em> (lowest-ordinal)
    /// worst-rank. The extension's synthetic receiver slot lives in
    /// <c>Parameters[0]</c>, so user arguments align against <c>Parameters[1..]</c>.
    /// Returns <see cref="ClrOverloadResolution.ImplicitConversionKind.None"/> when
    /// no overload lines up positionally with the arguments.
    /// </summary>
    private ClrOverloadResolution.ImplicitConversionKind ComputeBestApplicableExtensionWorstConversionRank(
        ImmutableArray<FunctionSymbol> extCandidates,
        Type?[] argTypes)
    {
        var best = ClrOverloadResolution.ImplicitConversionKind.None;
        foreach (var candidate in extCandidates)
        {
            if (candidate == null || candidate.Parameters.Length != argTypes.Length + 1)
            {
                continue;
            }

            var worst = ClrOverloadResolution.ImplicitConversionKind.Identity;
            var applicable = true;
            for (var i = 0; i < argTypes.Length; i++)
            {
                var paramClr = GetEffectiveArgumentClrTypeForOverloadResolution(candidate.Parameters[i + 1].Type);
                var kind = ClrOverloadResolution.ClassifyImplicit(paramClr, argTypes[i]);
                if (kind == ClrOverloadResolution.ImplicitConversionKind.None)
                {
                    applicable = false;
                    break;
                }

                if ((int)kind > (int)worst)
                {
                    worst = kind;
                }
            }

            if (!applicable)
            {
                continue;
            }

            if (best == ClrOverloadResolution.ImplicitConversionKind.None || (int)worst < (int)best)
            {
                best = worst;
            }
        }

        return best;
    }

    /// <summary>
    /// Issue #1188: resolves an instance-syntax call <c>receiver.Method(args)</c>
    /// against the user-defined extension functions visible from the current
    /// scope, supporting overloading. Collects every extension overload matching
    /// the (receiver type, name) pair and selects the single best applicable one
    /// through the standard overload-resolution machinery before delegating to
    /// <see cref="OverloadResolver.BindExtensionFunctionCall"/>.
    /// </summary>
    /// <remarks>
    /// Extension function symbols carry their receiver in <c>Parameters[0]</c> and
    /// never set <see cref="FunctionSymbol.ExplicitReceiverParameter"/>, so user
    /// arguments line up against <c>Parameters[1..]</c>. To reuse the existing
    /// instance-overload selector (which keys parameter alignment off
    /// <c>ExplicitReceiverParameter</c>) the receiver is prepended as the first
    /// positional argument; this makes the candidate's synthetic receiver slot
    /// participate in applicability/convertibility ranking and in generic receiver
    /// inference exactly as <see cref="OverloadResolver.BindExtensionFunctionCall"/>
    /// does once a candidate is chosen.
    /// </remarks>
    /// <param name="receiver">The bound call receiver.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="arguments">The bound user arguments (excluding the receiver).</param>
    /// <param name="ce">The originating call syntax.</param>
    /// <param name="argumentNames">The named-argument layout, or default.</param>
    /// <param name="result">The bound call, when an extension overload matched.</param>
    /// <returns><see langword="true"/> when at least one extension overload matched the (receiver, name) pair.</returns>
    private bool TryBindExtensionFunctionOverload(
        BoundExpression? receiver,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames,
        [NotNullWhen(true)] out BoundExpression? result)
    {
        result = null;
        if (receiver == null)
        {
            return false;
        }

        var candidates = scope.TryLookupExtensionFunctions(receiver.Type, methodName);
        if (candidates.IsDefaultOrEmpty)
        {
            return false;
        }

        FunctionSymbol? selected = candidates[0];
        if (candidates.Length > 1)
        {
            var allArguments = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length + 1);
            allArguments.Add(receiver);
            allArguments.AddRange(arguments);

            var allNames = argumentNames;
            if (!argumentNames.IsDefault)
            {
                var names = new string[argumentNames.Length + 1];
                for (var i = 0; i < argumentNames.Length; i++)
                {
                    names[i + 1] = argumentNames[i];
                }

                allNames = ImmutableArray.Create(names);
            }

            selected = overloads.SelectInstanceOverloadOrReport(candidates, allArguments.ToImmutable(), ce, methodName, allNames);
            if (selected == null)
            {
                result = new BoundErrorExpression(null);
                return true;
            }
        }

        result = overloads.BindExtensionFunctionCall(
            receiver,
            Invariant.Required(selected, "a non-empty extension candidate set selects a function"),
            arguments,
            ce,
            argumentNames);
        return true;
    }

    /// <summary>
    /// Issue #527 (G#-defined struct/class arm): when a member-style call
    /// <c>receiver.Member(args)</c> does not match a method on the user
    /// struct/class, fall back to a field whose type is a function value or
    /// named delegate. Lowers to a load of the field followed by a
    /// <see cref="BoundIndirectCallExpression"/> through the function shape.
    /// Returns <see langword="true"/> when a callable field matched (the
    /// resulting expression may be a <see cref="BoundErrorExpression"/> if
    /// arity is wrong).
    /// </summary>
    /// <summary>
    /// ADR-0085 / issue #726: when a class-typed receiver does not have a
    /// matching instance method, look at the class's implemented interfaces
    /// (including bases) for a default-method (DIM) whose signature accepts
    /// the supplied arguments. Returns the selected interface method or
    /// <c>null</c> if there is no suitable candidate. Diamond conflicts are
    /// reported by <c>VerifyInterfaceImplementations</c>; this helper picks
    /// the first matching candidate so that diagnostics are not duplicated
    /// at every call site.
    /// </summary>
    /// <summary>
    /// ADR-0090 / issue #756: returns <c>true</c> when the current function
    /// being bound (the enclosing default-method body) belongs to the same
    /// interface declaration as <paramref name="ifaceDef"/>. Used at call
    /// sites that resolve through an interface receiver to decide whether
    /// the private-helper bucket is in scope.
    /// </summary>
    /// <param name="ifaceDef">The interface generic definition (callers
    /// pass <c>InterfaceSymbol.Definition</c>) being targeted.</param>
    /// <returns>True when the enclosing function's owning interface is the
    /// same definition.</returns>
    private bool IsInsideSameInterface(InterfaceSymbol ifaceDef)
    {
        var current = function;
        if (current == null || ifaceDef == null)
        {
            return false;
        }

        InterfaceSymbol? ownerIface = null;
        if (current.ReceiverType is InterfaceSymbol ri)
        {
            ownerIface = ri;
        }
        else if (current.StaticOwnerType is InterfaceSymbol si)
        {
            ownerIface = si;
        }

        if (ownerIface == null)
        {
            return false;
        }

        var ownerDef = ownerIface.Definition ?? ownerIface;
        return ReferenceEquals(ownerDef, ifaceDef);
    }

    private FunctionSymbol? TryFindDefaultInterfaceMethod(
        StructSymbol receiverClass,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames)
    {
        StructSymbol? current = receiverClass;
        while (current != null)
        {
            var c = current;
            foreach (var iface in c.Interfaces)
            {
                if (iface == null)
                {
                    continue;
                }

                var candidates = TypeMemberModel.GetMethods(iface, methodName, MemberQuery.Instance(MemberKinds.Method));
                var defaultsOnly = ImmutableArray.CreateBuilder<FunctionSymbol>();
                for (var i = 0; i < candidates.Length; i++)
                {
                    if (InterfaceSymbol.HasDefaultBody(candidates[i]))
                    {
                        defaultsOnly.Add(candidates[i]);
                    }
                }

                if (defaultsOnly.Count == 0)
                {
                    continue;
                }

                var selected = this.overloads.SelectInstanceOverloadOrReport(defaultsOnly.ToImmutable(), arguments, ce, methodName, argumentNames);
                if (selected != null)
                {
                    return selected;
                }
            }

            current = c.BaseClass;
        }

        return null;
    }

    private bool TryBindUserDelegateMemberInvocation(
        BoundExpression? receiver,
        TypeSymbol receiverType,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        bool isStatic,
        [NotNullWhen(true)] out BoundExpression? result)
    {
        result = null;

        var receiverStruct = receiverType as StructSymbol;
        FieldSymbol? matchedField = null;
        StructSymbol? declaringType = null;
        if (isStatic && receiverStruct != null)
        {
            TypeMemberModel.TryGetStaticFieldIncludingInherited(
                receiverStruct,
                methodName,
                out matchedField,
                out declaringType);
        }
        else if (receiverStruct != null)
        {
            // Walk the base chain so an inherited delegate field on a base class
            // is invokable on a derived instance.
            StructSymbol? current = receiverStruct;
            while (current != null)
            {
                if (current.TryGetField(methodName, out var f))
                {
                    matchedField = f;
                    declaringType = current;
                    break;
                }

                current = current.BaseClass;
            }
        }

        PropertySymbol? matchedProperty = null;
        if (matchedField == null)
        {
            PropertySymbol? property = null;
            StructSymbol? propertyDeclaringType = null;
            var foundProperty = false;
            if (isStatic)
            {
                if (receiverStruct != null)
                {
                    foundProperty = TypeMemberModel.TryGetStaticPropertyIncludingInherited(
                        receiverStruct,
                        methodName,
                        out property,
                        out propertyDeclaringType);
                }
            }
            else
            {
                foundProperty = TypeMemberModel.TryGetProperty(
                    receiverType,
                    methodName,
                    out property,
                    out propertyDeclaringType);
            }

            if (foundProperty && property is { HasGetter: true })
            {
                matchedProperty = property;
                declaringType = propertyDeclaringType;
            }
        }

        var memberType = matchedField != null && isStatic && declaringType != null
            ? declaringType.SubstituteMemberType(matchedField.Type)
            : matchedField?.Type ?? matchedProperty?.Type;

        // declaringType is null for a property declared on an INTERFACE: the
        // out-parameter is a StructSymbol and an interface is not one. Bailing
        // out here (as a nullable-warning guard once did) silently unbinds
        // `ifaceReceiver.DelegateProp(args)` and reports GS0159 -- issues #2925
        // and #3016. BoundPropertyAccessExpression.StructType is nullable for
        // exactly this form, so the null flows through correctly.
        if (memberType == null)
        {
            return false;
        }

        // Issue #2849: derive both argument conversions and Invoke shape from
        // the narrowed stable member read, not the nullable declaration.
        BoundExpression memberLoad;
        if (matchedField != null)
        {
            memberLoad = isStatic
                ? new BoundFieldAccessExpression(null, receiver, declaringType, matchedField, memberType)
                : new BoundFieldAccessExpression(null, receiver, declaringType, matchedField);
        }
        else if (matchedProperty != null)
        {
            memberLoad = new BoundPropertyAccessExpression(null, receiver, declaringType, matchedProperty);
        }
        else
        {
            return false;
        }

        memberLoad = ApplyMemberNarrowing(memberLoad);
        var effectiveMemberType = memberLoad switch
        {
            BoundFieldAccessExpression { NarrowedType: TypeSymbol narrowedField } => narrowedField,
            BoundPropertyAccessExpression { NarrowedType: TypeSymbol narrowedProperty } => narrowedProperty,
            _ => memberType,
        };
        var callableType = ce.NullableQuestionToken != null
            && effectiveMemberType is NullableTypeSymbol nullableMember
            ? nullableMember.UnderlyingType
            : effectiveMemberType;

        if (isStatic)
        {
            var accessibility = matchedField != null
                ? matchedField.Accessibility
                : matchedProperty?.Accessibility;
            if (declaringType != null
                && accessibility is { } memberAccessibility
                && !AccessibilityChecker.IsAccessible(memberAccessibility, declaringType, function))
            {
                Diagnostics.ReportMemberInaccessible(ce.Identifier.Location, methodName, declaringType.Name, memberAccessibility);
            }
        }

        if (ce.NullableQuestionToken == null
            && overloads.TryReportNullableDelegateReceiver(
                effectiveMemberType,
                ce.Identifier.Location,
                methodName,
                nullSafeInvocation: "?(...)"))
        {
            result = new BoundErrorExpression(null);
            return true;
        }

        if (!MemberLookup.TryGetDelegateFunctionTypeFromSymbol(callableType, out var functionType))
        {
            return false;
        }

        if (callableType is DelegateTypeSymbol namedDelegate)
        {
            if (!overloads.TryBindNamedDelegateArguments(
                methodName,
                namedDelegate,
                ce,
                arguments,
                out var namedArguments,
                out var namedRefKinds))
            {
                result = new BoundErrorExpression(null);
                return true;
            }

            result = BuildDelegateMemberInvocation(
                ce,
                memberLoad,
                callableType,
                functionType,
                namedArguments,
                namedRefKinds);
            return true;
        }

        // ADR-0102 follow-up / issue #818: when the field's declared
        // function type spells a trailing variadic parameter, pack /
        // pass-through trailing args at the call site.
        var fldIsVariadic = functionType.HasVariadic;
        var fldFixedCount = fldIsVariadic ? functionType.ParameterTypes.Length - 1 : functionType.ParameterTypes.Length;
        if (fldIsVariadic)
        {
            if (arguments.Length < fldFixedCount)
            {
                Diagnostics.ReportTooFewArgumentsForVariadic(ce.Location, methodName, fldFixedCount, arguments.Length);
                result = new BoundErrorExpression(null);
                return true;
            }
        }
        else if (arguments.Length != functionType.ParameterTypes.Length)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, methodName, functionType.ParameterTypes.Length, arguments.Length);
            result = new BoundErrorExpression(null);
            return true;
        }

        ImmutableArray<BoundExpression> permutedArgs = arguments;
        if (fldIsVariadic)
        {
            var sliceType = (SliceTypeSymbol)functionType.ParameterTypes[functionType.ParameterTypes.Length - 1];
            var hasVariadicErrors = false;

            // Issue #1823: route through the #1630 canonical helper so
            // trailing elements get the same per-element coercion applied
            // at every other variadic pack site (previously packed raw,
            // uncoerced elements here).
            Func<int, TextLocation> variadicArgumentLocation =
                i => i < ce.Arguments.Count ? ce.Arguments[i].Location : ce.Location;
            permutedArgs = OverloadResolver.PackOrPassThroughVariadicArguments(
                conversions,
                Diagnostics,
                ce,
                arguments,
                fldFixedCount,
                sliceType,
                methodName,
                variadicArgumentLocation,
                ref hasVariadicErrors);

            if (hasVariadicErrors)
            {
                result = new BoundErrorExpression(null);
                return true;
            }
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(permutedArgs.Length);
        for (var i = 0; i < permutedArgs.Length; i++)
        {
            var argLoc = i < ce.Arguments.Count ? ce.Arguments[i].Location : ce.Location;
            var argument = permutedArgs[i];
            if (argument is BoundErrorExpression { Syntax: LambdaExpressionSyntax lambda }
                && MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(functionType.ParameterTypes[i], out var target))
            {
                argument = lambdas.BindLambdaExpression(lambda, target);
            }

            convertedArgs.Add(conversions.BindConversion(argLoc, argument, functionType.ParameterTypes[i]));
        }

        result = BuildDelegateMemberInvocation(
            ce,
            memberLoad,
            callableType,
            functionType,
            convertedArgs.MoveToImmutable());
        return true;
    }

    private BoundExpression BuildDelegateMemberInvocation(
        CallExpressionSyntax syntax,
        BoundExpression delegateLoad,
        TypeSymbol delegateType,
        FunctionTypeSymbol functionType,
        ImmutableArray<BoundExpression> arguments,
        ImmutableArray<RefKind> argumentRefKinds = default)
    {
        if (syntax.NullableQuestionToken == null)
        {
            return new BoundIndirectCallExpression(null, delegateLoad, functionType, arguments, argumentRefKinds);
        }

        var captureName = "$ncap_" + (++binderCtx.NullConditionalCaptureCounter)
            .ToString(System.Globalization.CultureInfo.InvariantCulture);
        var capture = new LocalVariableSymbol(captureName, isReadOnly: true, type: delegateType);
        var invoke = new BoundIndirectCallExpression(
            null,
            new BoundVariableExpression(null, capture),
            functionType,
            arguments,
            argumentRefKinds);
        return BuildNullConditionalDelegateInvocation(syntax, delegateLoad, capture, invoke);
    }

    private BoundExpression BuildNullConditionalDelegateInvocation(
        CallExpressionSyntax syntax,
        BoundExpression delegateLoad,
        LocalVariableSymbol capture,
        BoundExpression invoke)
    {
        if (ReferenceEquals(invoke.Type, TypeSymbol.Void))
        {
            return new BoundNullConditionalAccessExpression(
                syntax,
                delegateLoad,
                capture,
                invoke,
                TypeSymbol.Void,
                resultSlot: null);
        }

        var resultType = invoke.Type is NullableTypeSymbol
            ? invoke.Type
            : (TypeSymbol)NullableTypeSymbol.Get(invoke.Type);
        LocalVariableSymbol? resultSlot = null;
        if (resultType is NullableTypeSymbol nullableResult
            && GSharp.Core.CodeAnalysis.Emit.ReflectionMetadataEmitter.IsValueTypeSymbol(nullableResult.UnderlyingType))
        {
            var resultSlotName = "$nres_" + binderCtx.NullConditionalCaptureCounter
                .ToString(System.Globalization.CultureInfo.InvariantCulture);
            resultSlot = new LocalVariableSymbol(resultSlotName, isReadOnly: false, type: resultType);
        }

        return new BoundNullConditionalAccessExpression(
            syntax,
            delegateLoad,
            capture,
            invoke,
            resultType,
            resultSlot);
    }

    /// <summary>
    /// Issue #527: when an accessor-style call <c>receiver.Member(args)</c>
    /// matches no method on the CLR receiver type, fall back to a public
    /// field or property of the same name whose type is a CLR delegate.
    /// Lowers to a load of the delegate value (<c>ldfld</c> / property getter)
    /// followed by an <c>Invoke(args)</c> call. Returns <see langword="true"/>
    /// when a delegate-typed member matched and the call was bound (the
    /// resulting expression may be a <see cref="BoundErrorExpression"/> if
    /// argument resolution failed).
    /// </summary>
    private bool TryBindClrDelegateMemberInvocation(
        BoundExpression receiver,
        System.Type clrType,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames,
        [NotNullWhen(true)] out BoundExpression? result)
    {
        result = null;
        if (clrType == null)
        {
            return false;
        }

        // Prefer a property of the right name over a field — the same
        // precedence used by the read path in BindAccessorStep (properties
        // first, fields fallback). Indexer properties (those with parameters)
        // are not member-style invocable, so skip them.
        System.Reflection.MemberInfo? member = ClrTypeUtilities.SafeGetProperty(clrType, methodName, BindingFlags.Public | BindingFlags.Instance);
        if (member is System.Reflection.PropertyInfo prop && (prop.GetIndexParameters().Length != 0 || !prop.CanRead))
        {
            member = null;
        }

        member ??= ClrTypeUtilities.SafeGetField(clrType, methodName, BindingFlags.Public | BindingFlags.Instance);
        if (member == null)
        {
            return false;
        }

        System.Type? memberClrType = member switch
        {
            System.Reflection.PropertyInfo p => p.PropertyType,
            System.Reflection.FieldInfo f => f.FieldType,
            _ => null,
        };
        if (memberClrType == null || !ClrTypeUtilities.IsDelegateType(memberClrType))
        {
            return false;
        }

        TypeSymbol memberTypeSymbol = member switch
        {
            System.Reflection.PropertyInfo p2 => ClrNullability.GetPropertyTypeSymbol(p2),
            System.Reflection.FieldInfo f2 => ClrNullability.GetFieldTypeSymbol(f2),
            _ => TypeSymbol.FromClrType(memberClrType),
        };

        BoundExpression delegateLoad = ApplyMemberNarrowing(
            new BoundClrPropertyAccessExpression(null, receiver, member, memberTypeSymbol));
        var effectiveMemberType = delegateLoad.Type;

        if (ce.NullableQuestionToken == null
            && overloads.TryReportNullableDelegateReceiver(
                effectiveMemberType,
                ce.Identifier.Location,
                methodName,
                nullSafeInvocation: "?(...)"))
        {
            result = new BoundErrorExpression(null);
            return true;
        }

        // The delegate value load — `ldfld` for a field, `call get_X` for a
        // property. The shared BoundClrPropertyAccessExpression node carries
        // either MemberInfo shape, and EmitClrPropertyAccess already handles
        // both (including the value-type-receiver `ldloca` step we need for
        // a CLR struct field).
        // Strip nullable annotation when dispatching through Invoke.
        var underlyingDelegateClr = memberClrType;

        LocalVariableSymbol? capture = null;
        BoundExpression invokeReceiver = delegateLoad;
        if (ce.NullableQuestionToken != null)
        {
            var captureType = effectiveMemberType is NullableTypeSymbol nullableMember
                ? nullableMember.UnderlyingType
                : effectiveMemberType;
            var captureName = "$ncap_" + (++binderCtx.NullConditionalCaptureCounter)
                .ToString(System.Globalization.CultureInfo.InvariantCulture);
            capture = new LocalVariableSymbol(captureName, isReadOnly: true, type: captureType);
            invokeReceiver = new BoundVariableExpression(null, capture);
        }

        // Reuse the same Invoke-overload-resolution path that the bare
        // delegate-variable call uses at #325 (BindCallExpression), so
        // generic delegate arguments, named arguments, and ref/in/out are
        // all handled uniformly.
        if (TryBindInheritedClrInstanceCall(invokeReceiver, underlyingDelegateClr, "Invoke", arguments, ce, out var invokeCall, argumentNames: argumentNames))
        {
            result = capture == null
                ? invokeCall
                : BuildNullConditionalDelegateInvocation(ce, delegateLoad, capture, invokeCall);
            return true;
        }

        // No applicable Invoke overload — most likely an argument-count or
        // type mismatch. Report against the member name (not "Invoke") so the
        // diagnostic points to what the user wrote.
        var invoke = memberClrType.GetMethodSafe("Invoke");
        var expectedArity = invoke?.GetParameters().Length ?? 0;
        if (arguments.Length != expectedArity)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, methodName, expectedArity, arguments.Length);
        }
        else
        {
            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
        }

        result = new BoundErrorExpression(null);
        return true;
    }

    /// <summary>
    /// Issue #296: resolves an instance method call against an imported CLR
    /// base class for a GSharp class receiver that inherits it. Uses the same
    /// overload resolution as direct imported-instance calls; <c>GetMethods</c>
    /// on the base type already includes members inherited up the CLR chain.
    /// Returns <c>true</c> with a bound call when a unique match is found.
    /// </summary>
    internal bool TryBindInheritedClrInstanceCall(
        BoundExpression receiver,
        System.Type? importedBaseClr,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        [NotNullWhen(true)] out BoundExpression? result,
        System.Type[]? explicitTypeArgs = null,
        ImmutableArray<TypeSymbol> typeArgSymbols = default,
        ImmutableArray<string> argumentNames = default,
        bool mapEnumArgumentsToBaseClr = false,
        bool allowProtectedInherited = false)
    {
        result = null;
        if (importedBaseClr == null)
        {
            return false;
        }

        // Issue #2210: start from the public (+ self-interface DIM) candidates
        // this helper has always resolved, then union in any `protected` /
        // `protected internal` instance methods reachable from a derived G#
        // type — so a call like `OnPropertyChanged(...)` inherited from an
        // imported `protected` base method (e.g. CommunityToolkit.Mvvm's
        // ObservableObject) can resolve. Reuses the same accessibility filter
        // (public/Family/FamilyOrAssembly) already applied to
        // `base.Method(...)` calls (issue #1260).
        // Issue #2218 follow-up: this helper is shared by the general
        // qualified-accessor call path (any `receiver.Method(...)`, not just
        // `this.`/implicit-this), so a resolved `protected` candidate is only
        // actually usable when `allowProtectedInherited` is set by the
        // caller (i.e. it already verified `receiver` IS the current
        // implicit/explicit `this`). Otherwise `TryResolveAndBindClrInstanceCall`
        // below rejects the resolved protected candidate with a GS0379
        // accessibility diagnostic instead of silently binding it.
        var candidates = new List<MethodInfo>(MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(importedBaseClr, methodName));
        foreach (var protectedCandidate in CollectBaseClrMethodCandidates(importedBaseClr, methodName))
        {
            if (!MemberLookup.HasSameSignature(candidates, protectedCandidate))
            {
                candidates.Add(protectedCandidate);
            }
        }

        if (candidates.Count == 0)
        {
            return false;
        }

        return TryResolveAndBindClrInstanceCall(receiver, candidates, importedBaseClr, methodName, arguments, ce, out result, explicitTypeArgs, typeArgSymbols, argumentNames, mapEnumArgumentsToBaseClr, allowProtectedInherited: allowProtectedInherited);
    }

    /// <summary>
    /// Issue #1181: resolves an instance method call against the imported/BCL
    /// base interfaces of a user interface receiver. A user interface
    /// <c>interface IBox : IDisposable</c> has a null <c>ClrType</c>, so the
    /// regular imported-instance walks find nothing; this projects every
    /// transitive imported base interface's public instance methods onto the
    /// receiver (matching how user-base-interface members are surfaced) and
    /// runs the shared overload resolution. The emitted
    /// <see cref="BoundImportedInstanceCallExpression"/> dispatches via
    /// <c>callvirt</c> on the imported interface method, which is verifiable
    /// because <c>IBox</c> carries an InterfaceImpl row to each imported base.
    /// Runs only after user member-table lookup fails, so user-declared
    /// interface members keep priority.
    /// </summary>
    /// <param name="receiver">The interface-typed receiver expression.</param>
    /// <param name="interfaceSymbol">The user interface symbol of the receiver.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="arguments">The bound call arguments.</param>
    /// <param name="ce">The call syntax (for diagnostics/locations).</param>
    /// <param name="result">The bound call on success, or an error node on ambiguity.</param>
    /// <param name="explicitTypeArgs">Explicit CLR type arguments, when present.</param>
    /// <param name="typeArgSymbols">Explicit symbolic type arguments, when present.</param>
    /// <param name="argumentNames">Named-argument labels, when present.</param>
    /// <returns>True when the call resolved (or reported a precise ambiguity).</returns>
    internal bool TryBindInterfaceImportedBaseInstanceCall(
        BoundExpression receiver,
        InterfaceSymbol interfaceSymbol,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        [NotNullWhen(true)] out BoundExpression? result,
        System.Type[]? explicitTypeArgs = null,
        ImmutableArray<TypeSymbol> typeArgSymbols = default,
        ImmutableArray<string> argumentNames = default)
    {
        result = null;

        var clrBases = MemberLookup.GetTransitiveClrBaseInterfaces(interfaceSymbol);
        if (clrBases.Count == 0)
        {
            return false;
        }

        var candidates = new List<MethodInfo>();
        foreach (var clrBase in clrBases)
        {
            foreach (var m in ClrTypeUtilities.SafeGetMethods(clrBase, BindingFlags.Instance | BindingFlags.Public))
            {
                if (string.Equals(m.Name, methodName, System.StringComparison.Ordinal)
                    && !MemberLookup.HasSameSignature(candidates, m))
                {
                    candidates.Add(m);
                }
            }
        }

        if (candidates.Count == 0)
        {
            return false;
        }

        if (clrBases[0] is not { } importedBaseClr)
        {
            return false;
        }

        return TryResolveAndBindClrInstanceCall(receiver, candidates, importedBaseClr, methodName, arguments, ce, out result, explicitTypeArgs, typeArgSymbols, argumentNames);
    }

    /// <summary>
    /// Issue #296 / #1181: shared overload-resolution + bound-call construction
    /// core for an imported-instance method call against a pre-collected
    /// <paramref name="candidates"/> set. Factored out of
    /// <see cref="TryBindInheritedClrInstanceCall"/> so the inherited-base-class
    /// path and the user-interface imported-base path share one implementation.
    /// </summary>
    /// <param name="receiver">The receiver expression.</param>
    /// <param name="candidates">The candidate CLR methods.</param>
    /// <param name="importedBaseClr">A representative CLR type for named-argument diagnostics.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="arguments">The bound call arguments.</param>
    /// <param name="ce">The call syntax.</param>
    /// <param name="result">The bound call on success.</param>
    /// <param name="explicitTypeArgs">Explicit CLR type arguments, when present.</param>
    /// <param name="typeArgSymbols">Explicit symbolic type arguments, when present.</param>
    /// <param name="argumentNames">Named-argument labels, when present.</param>
    /// <param name="mapEnumArgumentsToBaseClr">When <see langword="true"/>, enum-typed arguments resolve as the inherited base CLR type (<c>System.Enum</c>) instead of their erased underlying primitive, so members such as <c>HasFlag(System.Enum)</c> match.</param>
    /// <param name="nonVirtualBaseCall">Issue #1260: when <see langword="true"/>, the resolved call is a <c>base.M(...)</c> access into an imported/BCL base and is flagged so the emitter writes a non-virtual <c>call</c>; an <c>abstract</c> best match is reported as GS0413.</param>
    /// <param name="baseMemberLocation">Issue #1260: the location of the member identifier for the GS0413 abstract-base diagnostic (used only when <paramref name="nonVirtualBaseCall"/> is set).</param>
    /// <param name="allowProtectedInherited">Issue #2218 follow-up: when <see langword="false"/>, a resolved <c>protected</c>/<c>protected internal</c> candidate is rejected with a GS0379 accessibility diagnostic instead of being bound. Defaults to <see langword="true"/> for the <c>base.M(...)</c> and user-interface imported-base callers, which never surface a protected candidate they aren't entitled to call.</param>
    /// <returns>True when the call resolved (or reported a precise ambiguity).</returns>
    private bool TryResolveAndBindClrInstanceCall(
        BoundExpression receiver,
        IReadOnlyList<MethodInfo> candidates,
        System.Type? importedBaseClr,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        [NotNullWhen(true)] out BoundExpression? result,
        System.Type[]? explicitTypeArgs,
        ImmutableArray<TypeSymbol> typeArgSymbols,
        ImmutableArray<string> argumentNames,
        bool mapEnumArgumentsToBaseClr = false,
        bool nonVirtualBaseCall = false,
        TextLocation? baseMemberLocation = null,
        bool allowProtectedInherited = true)
    {
        result = null;

        var argTypes = new System.Type?[arguments.Length];
        var hasUserClassArg = false;
        for (var i = 0; i < arguments.Length; i++)
        {
            // Issue #1218: when resolving an inherited call against System.Enum
            // (e.g. HasFlag(System.Enum)), an enum-typed argument is the boxed
            // System.Enum the parameter expects. The default mapping erases an
            // enum to its underlying int32 (issue #661), which would not match a
            // System.Enum parameter, so map it to the base CLR type instead.
            if (mapEnumArgumentsToBaseClr && arguments[i].Type is EnumSymbol)
            {
                argTypes[i] = importedBaseClr;
                continue;
            }

            // Issue #530: use GetEffectiveArgumentClrType (see instance method path).
            // Issue #533: allow null (nil literal) through.
            // Issue #658: use overload-resolution variant for user classes.
            var t = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type);
            if (t == null && arguments[i].Type != TypeSymbol.Null)
            {
                // Issue #2347: defer an unresolved method-group argument (see
                // TryBindImportedExtensionCall) instead of failing outright;
                // BindClrParameterConversions resolves it once the candidate
                // (and its parameter type) is known.
                if (!ClrOverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]))
                {
                    return false;
                }
            }

            if (arguments[i].Type is StructSymbol { IsClass: true })
            {
                hasUserClassArg = true;
            }

            argTypes[i] = t;
        }

        // Issue #658 / #1634: supplementary interface check for user-class args,
        // threaded as a call-local parameter into Resolve instead of a shared
        // static so nested/concurrent binds can't clobber it.
        Func<Type, Type, bool>? supplementaryInterfaceCheck = null;
        if (hasUserClassArg)
        {
            supplementaryInterfaceCheck = CheckUserClassInterface;
        }

        bool CheckUserClassInterface(Type source, Type target) =>
            IsUserClassAssignableToInterfaceFromArgs(arguments, argTypes, source, target);

        var inheritedSymbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(
            null,
            ImmutableArray.CreateRange(arguments.Select(a => a.Type)));
        Func<MethodInfo, bool, ImmutableArray<TypeSymbol?>> recoverInheritedTypeArgs =
            (closed, isExpanded) => MemberLookup.BuildSymbolicMethodTypeArgs(
                closed,
                typeArgSymbols,
                inheritedSymbolicArgs,
                isExpanded);
        var resolution = ClrOverloadResolution.Resolve(
            candidates,
            argTypes,
            explicitTypeArgs,
            scope.References.MapClrTypeToReferences,
            ComputeInterpolatedStringArgFlags(ce.Arguments, arguments.Length),
            argumentNames: argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames,
            recoverTypeArgSymbols: recoverInheritedTypeArgs,
            supplementaryInterfaceCheck: supplementaryInterfaceCheck,
            constantNarrowingArgumentCheck: MakeConstantNarrowingArgumentCheck(arguments),
            structuralProjectionArgumentCheck: MakeStructuralProjectionArgumentCheck(arguments),
            delegateRefKindArgumentCheck: MakeDelegateRefKindArgumentCheck(arguments),
            methodGroupInference: MakeMethodGroupInference(arguments, GetEffectiveArgumentClrTypeForOverloadResolution),
            methodGroupArgumentCheck: MakeMethodGroupArgumentCheck(arguments));

        switch (resolution.Outcome)
        {
            case ClrOverloadResolution.ResolutionOutcome.Resolved:
                if (resolution.Best is not { } best)
                {
                    return false;
                }

                // Issue #1260: a `base.M(...)` into an abstract BCL member has no
                // base implementation to delegate to (e.g. Stream.Read). Match C#
                // (CS0205) with a clean diagnostic instead of emitting invalid IL.
                if (nonVirtualBaseCall && best.IsAbstract)
                {
                    Diagnostics.ReportBaseClassCallAbstractMember(baseMemberLocation ?? ce.Location, importedBaseClr?.Name ?? "object", methodName);
                    result = new BoundErrorExpression(null);
                    return true;
                }

                // Issue #2218 follow-up: the candidate set unioned in by
                // TryBindInheritedClrInstanceCall (issue #2210) may include a
                // `protected`/`protected internal` member reachable only via
                // `base.M(...)` (always legitimate — see nonVirtualBaseCall)
                // or the current implicit/explicit `this` (only when the
                // caller passed `allowProtectedInherited: true`). Any other
                // qualified `receiver.Method(...)` call resolving to such a
                // member is an accessibility violation: report the same GS0379
                // diagnostic G# already uses for a protected member accessed
                // from outside its declaring/derived type, instead of
                // silently binding it.
                if (!allowProtectedInherited && !nonVirtualBaseCall
                    && !best.IsPublic && (best.IsFamily || best.IsFamilyOrAssembly))
                {
                    Diagnostics.ReportProtectedMemberInaccessible(ce.Identifier.Location, methodName, ClrTypeDisplayName(best.DeclaringType ?? importedBaseClr));
                    result = new BoundErrorExpression(null);
                    return true;
                }

                // Issue #1512: an instance method (incl. one inherited from an
                // imported generic base) excludes the receiver from its formal
                // parameter list, so the method-type-argument inference vector must
                // not carry the receiver as slot 0 — otherwise lambda-only-inferable
                // method type parameters never unify and erase to `<object>`.
                var inheritedSymbolicTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(
                    best,
                    typeArgSymbols,
                    inheritedSymbolicArgs,
                    resolution.IsExpanded);
                var inheritedTypeArgSymbolsForCall = !inheritedSymbolicTypeArgs.IsDefault
                    ? inheritedSymbolicTypeArgs
                    : typeArgSymbols.IsDefault
                        ? default
                        : ImmutableArray.CreateRange<TypeSymbol?>(typeArgSymbols);
                var returnType = ResolveImportedGenericReturnType(best, typeArgSymbols)
                    ?? MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(best, inheritedSymbolicTypeArgs, receiver.Type)
                    ?? ResolveInstanceReturnTypeFromReceiver(receiver.Type, best)
                    ?? MapClrMethodReturnType(best);
                var inheritedParameters = best.GetParameters();
                var inheritedMapping = resolution.ParameterMapping;
                var inheritedExpandedArgs = resolution.IsExpanded
                    ? overloads.ExpandParamsArguments(
                        arguments,
                        inheritedParameters,
                        ce,
                        parameterMapping: inheritedMapping,
                        symbolicMethodTypeArgs: inheritedTypeArgSymbolsForCall)
                    : arguments;
                var inheritedDownstreamMapping = resolution.IsExpanded ? default : inheritedMapping;

                // Issue #1638: shared CLR call-argument-construction pipeline
                // (interpolation rebind → handler args → delegate rebind →
                // parameter conversions). Previously this inherited-instance
                // path skipped straight to handler args, so an interpolated
                // string argument targeting an IFormattable/FormattableString
                // parameter of an inherited (base-class) member was never
                // re-lowered to FormattableStringFactory.Create(...).
                var inheritedConvertedArgs = BuildResolvedClrCallArguments(
                    inheritedExpandedArgs,
                    ce.Arguments,
                    inheritedParameters,
                    inheritedDownstreamMapping,
                    receiver,
                    ce.Location,
                    ce,
                    ClrCallDelegateRebindMode.Full,
                    out var inheritedHandlerPrelude,
                    out var inheritedUpdatedReceiver,
                    method: best,
                    symbolicMethodTypeArgs: inheritedTypeArgSymbolsForCall,
                    receiverType: receiver.Type);
                var inheritedArguments = OverloadResolver.BuildOrderedCallArguments(inheritedConvertedArgs, inheritedDownstreamMapping, inheritedParameters);
                var refKinds = ComputeArgumentRefKinds(inheritedParameters);
                overloads.ValidateRefArguments(inheritedArguments, refKinds, methodName, ce.Location);
                var inheritedCallReceiver = inheritedUpdatedReceiver ?? receiver;
                if (TryReportByRefLikeInheritedCall(inheritedCallReceiver, best, ce.Location))
                {
                    result = new BoundErrorExpression(null);
                    return true;
                }

                BoundExpression inheritedCall = new BoundImportedInstanceCallExpression(null, inheritedCallReceiver, best, returnType, inheritedArguments, refKinds, inheritedTypeArgSymbolsForCall, isNonVirtualBaseCall: nonVirtualBaseCall);
                result = WrapWithHandlerPrelude(inheritedCall, inheritedHandlerPrelude, ce);
                return true;
            case ClrOverloadResolution.ResolutionOutcome.Ambiguous:
                Diagnostics.ReportAmbiguousOverload(ce.Location, methodName, resolution.Ambiguous.Length, resolution.Ambiguous.Select(ClrOverloadResolution.FormatMethodSignature));
                result = new BoundErrorExpression(null);
                return true;
            default:
                // Issue #343: if the failure is plausibly due to an unknown
                // named-argument target, surface that as the diagnostic.
                if (importedBaseClr != null
                    && !argumentNames.IsDefault
                    && overloads.TryReportUnknownNamedArgumentForClr(importedBaseClr, methodName, BindingFlags.Instance | BindingFlags.Public, ce, argumentNames))
                {
                    result = new BoundErrorExpression(null);
                    return true;
                }

                return false;
        }
    }

    /// <summary>
    /// ADR-0059 / issue #255: lowers a <c>delegateValue.Invoke(args)</c>
    /// call against a value of <see cref="DelegateTypeSymbol"/> into a
    /// <see cref="BoundIndirectCallExpression"/> whose function shape is the
    /// delegate's equivalent <see cref="FunctionTypeSymbol"/>. The emitter
    /// recognises a DelegateTypeSymbol target and routes the call through
    /// the delegate's runtime-implemented Invoke MethodDef.
    /// </summary>
    private BoundExpression BindNamedDelegateInvokeCall(BoundExpression receiver, DelegateTypeSymbol delegateSym, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce)
    {
        if (!overloads.TryBindNamedDelegateArguments(
            delegateSym.Name,
            delegateSym,
            ce,
            arguments,
            out var convertedArgs,
            out var argumentRefKinds))
        {
            return new BoundErrorExpression(null);
        }

        return new BoundIndirectCallExpression(
            null,
            receiver,
            delegateSym.EquivalentFunctionType,
            convertedArgs,
            argumentRefKinds);
    }

    /// <summary>
    /// Issue #294: resolves a call written with instance ("receiver") syntax
    /// against an imported CLR static method marked with
    /// <c>[System.Runtime.CompilerServices.ExtensionAttribute]</c> whose first
    /// parameter is compatible with the receiver's type. This makes BCL/library
    /// extension methods (LINQ <c>Where</c>/<c>Select</c>/<c>ToList</c>, the
    /// ASP.NET Core minimal-API/middleware surface, etc.) callable as
    /// <c>receiver.Method(args)</c> rather than only statically as
    /// <c>DeclaringClass.Method(receiver, args)</c>.
    /// </summary>
    /// <param name="receiver">The bound receiver expression.</param>
    /// <param name="methodName">The method name at the call site.</param>
    /// <param name="arguments">The bound user arguments (excluding the receiver).</param>
    /// <param name="ce">The originating call expression.</param>
    /// <param name="result">The bound call when resolution succeeds (or a bound error on ambiguity).</param>
    /// <param name="explicitTypeArgs">Issue #311: resolved explicit type arguments from a <c>[T1, T2]</c> list, or <c>null</c> for inference.</param>
    /// <param name="typeArgSymbols">Issue #320: explicit type-argument symbols in source order (carrying user-defined types), or default.</param>
    /// <param name="argumentNames">Issue #343: per-source-argument names parallel to <paramref name="arguments"/> (entries are <see langword="null"/> for positional); default when the call is purely positional.</param>
    /// <returns>True when an imported extension method was matched (success or ambiguity); false to let the caller report GS0159.</returns>
    private bool TryBindImportedExtensionCall(BoundExpression receiver, string methodName, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce, [NotNullWhen(true)] out BoundExpression? result, System.Type[]? explicitTypeArgs = null, ImmutableArray<TypeSymbol> typeArgSymbols = default, ImmutableArray<string> argumentNames = default)
    {
        result = null;

        var receiverClrType = receiver.Type.ClrType;
        if (receiverClrType == null)
        {
            // Issue #833: a slice/sequence of an open method type parameter
            // (e.g. `[]T{}.ToArray()` inside `func F[T]()`) has no CLR
            // backing on the receiver. Project it to an erased shape so
            // overload resolution can run; symbolic recovery happens via
            // BuildSymbolicMethodTypeArgs + ResolveCallReturnTypeFromSymbolicTypeArgs.
            if (!MemberLookup.TryProjectErasedClrType(receiver.Type, out receiverClrType))
            {
                return false;
            }
        }

        // Issue #2523: a symbolic imported generic return keeps an erased CLR
        // probe shape for binding (for example,
        // IChain<object, object>) even when every symbolic argument now has a
        // concrete CLR type. Reify that shape before extension-method generic
        // inference so the receiver contributes its real base/interface
        // substitutions (IQuery<TEntity>) rather than conflicting `object`
        // evidence. Reification already preserves real Nullable<T> value
        // arguments and erases only reference nullability, matching CLR type
        // identity; it safely falls back to the cached probe shape for
        // same-compilation/open arguments that cannot yet be closed.
        if (receiver.Type is ImportedTypeSymbol symbolicImportedReceiver
            && symbolicImportedReceiver.OpenDefinition != null
            && !symbolicImportedReceiver.TypeArguments.IsDefaultOrEmpty)
        {
            var reifiedReceiver = symbolicImportedReceiver.ReifyClosedClrType();
            if (reifiedReceiver != null && !reifiedReceiver.ContainsGenericParameters)
            {
                receiverClrType = reifiedReceiver;
            }
        }

        // Issue #1423: a user class that implements a generic collection
        // interface (e.g. `class EntryList : IReadOnlyCollection[Entry]`, which
        // extends `IEnumerable[Entry]`) erases to `System.Object` via
        // TryProjectErasedClrType (it has no imported base class), so an
        // extension method whose `this` self-parameter is `IEnumerable<TSource>`
        // (LINQ Where/Select/OrderBy/…) cannot match the receiver and TSource
        // cannot be inferred. Project the receiver to the most-derived
        // implemented CLR interface instead so overload resolution sees the
        // collection element type; the bound receiver expression is unchanged.
        if (receiver.Type is StructSymbol { IsClass: true } userReceiverClass
            && (receiverClrType == null || receiverClrType.IsSameAs(typeof(object)))
            && TryProjectUserClassReceiverInterface(userReceiverClass, out var receiverIface))
        {
            receiverClrType = receiverIface;
        }

        // Build the argument-type vector as the extension method sees it: the
        // receiver becomes the first ("this") parameter, followed by the user
        // arguments. Every argument must carry a concrete CLR type so overload
        // resolution (including generic inference) can run.
        var argTypes = new Type?[arguments.Length + 1];
        var deferredInferenceArgs = new bool[arguments.Length + 1];
        argTypes[0] = receiverClrType;
        var hasUserClassArg = false;
        for (var i = 0; i < arguments.Length; i++)
        {
            // Issue #530: use GetEffectiveArgumentClrType (see instance method path).
            // Issue #533: allow null (nil literal) through.
            // Issue #658: use overload-resolution variant for user classes.
            var t = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type);
            if (t == null && arguments[i].Type != TypeSymbol.Null)
            {
                // Issue #2347: a bare method group passed as a generic
                // extension-method argument (e.g. `key.All(Char.IsAsciiHexDigit)`)
                // has no fixed CLR type until the extension candidate's target
                // delegate parameter is known — defer it exactly like an
                // untyped lambda (leave the argTypes slot null so generic
                // inference/applicability resolve TSource from the receiver
                // and the other arguments) instead of failing the whole
                // extension-call candidate. It is resolved against the
                // winning candidate's (possibly generic-inferred) parameter
                // type afterwards by BindClrParameterConversions.
                if (!ClrOverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]))
                {
                    // Issue #833: argument may carry an open TP (e.g. `T`,
                    // `[]T`). Project to an erased shape so resolution can run.
                    if (!MemberLookup.TryProjectErasedClrType(arguments[i].Type, out t))
                    {
                        return false;
                    }
                }
            }

            if (arguments[i].Type is StructSymbol { IsClass: true })
            {
                hasUserClassArg = true;
            }

            // A same-compilation lambda parameter may erase to its imported
            // base while its inherited-interface receiver erases to object.
            // Keep that CLR shape for applicability, but infer from the
            // receiver's symbolic hierarchy instead of conflicting erasures.
            if (receiver.Type is ImportedTypeSymbol
                && arguments[i].Type is FunctionTypeSymbol functionType
                && functionType.ParameterTypes.Any(TypeSymbol.RequiresSymbolicProjection))
            {
                deferredInferenceArgs[i + 1] = true;
            }

            argTypes[i + 1] = t;
        }

        // Issue #343: extension methods are dispatched as `Class.Method(receiver, userArgs...)`,
        // so prepend a null slot to user-supplied argument names so positions
        // align with the method's parameter list (where index 0 is `this`).
        IReadOnlyList<string>? extensionArgumentNames = null;
        if (!argumentNames.IsDefault)
        {
            var withReceiver = new string[arguments.Length + 1];
            for (var i = 0; i < arguments.Length; i++)
            {
                withReceiver[i + 1] = argumentNames[i];
            }

            extensionArgumentNames = withReceiver;
        }

        var extensionSymbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(
            receiver.Type,
            ImmutableArray.CreateRange(arguments.Select(argument =>
                argument is BoundMethodGroupExpression userGroup
                    && TryGetSymbolicUserMethodGroupType(userGroup, out var symbolicGroupType)
                        ? Invariant.Required(symbolicGroupType, "a symbolic method-group type was resolved")
                        : argument.Type)));
        var candidates = MemberLookup.ExcludeErasureOnlyEnumCandidates(
            this.memberLookup.CollectImportedExtensionMethods(methodName),
            extensionSymbolicArgs,
            extensionArgumentNames).ToList();
        if (candidates.Count == 0)
        {
            return false;
        }

        var hasDeferredInferenceArgument = false;
        foreach (var deferred in deferredInferenceArgs)
        {
            hasDeferredInferenceArgument |= deferred;
        }

        if (hasDeferredInferenceArgument && receiverClrType is { IsGenericType: true })
        {
            var receiverDefinition = receiverClrType.GetGenericTypeDefinition();
            var candidateMatchesReceiver = false;
            foreach (var candidate in candidates)
            {
                var candidateParameters = candidate.GetParameters();
                if (candidateParameters.Length == 0 || !candidateParameters[0].ParameterType.IsGenericType)
                {
                    continue;
                }

                if (ClrTypeUtilities.AreSame(
                        receiverDefinition,
                        candidateParameters[0].ParameterType.GetGenericTypeDefinition()))
                {
                    candidateMatchesReceiver = true;
                    break;
                }
            }

            if (candidateMatchesReceiver)
            {
                Array.Clear(deferredInferenceArgs);
            }
        }

        // Issue #2523: when a symbolic imported receiver's own reconstructed
        // CLR type is still unavailable, project it onto a candidate's declared
        // generic receiver interface/base. This gives generic inference the
        // subset of source arguments that the extension actually consumes
        // (for example IIncludableQueryable<TEntity, TProperty?> ->
        // IQueryable<TEntity>) without letting unrelated nullable or invariant
        // source slots collapse that receiver to object.
        if (receiver.Type is ImportedTypeSymbol symbolicReceiver)
        {
            foreach (var candidate in candidates)
            {
                var candidateParameters = candidate.GetParameters();
                if (candidateParameters.Length == 0)
                {
                    continue;
                }

                var candidateReceiver = candidateParameters[0].ParameterType;
                if (!candidateReceiver.IsGenericType)
                {
                    continue;
                }

                var candidateReceiverOpen = candidateReceiver.IsGenericTypeDefinition
                    ? candidateReceiver
                    : candidateReceiver.GetGenericTypeDefinition();
                if (MemberLookup.TryProjectConstructedHierarchyClrType(
                    symbolicReceiver,
                    candidateReceiverOpen,
                    out var projectedReceiver))
                {
                    receiverClrType = projectedReceiver;
                    argTypes[0] = projectedReceiver;
                    break;
                }
            }
        }

        // ClrOverloadResolution.Resolve infers type arguments for open generic
        // method definitions (e.g. Where<TSource>(IEnumerable<TSource>,
        // Func<TSource,bool>)) from the receiver and argument types. Issue #311:
        // when the call site supplied explicit type arguments (e.g.
        // services.AddSingleton[IService, Service]()), those are used to close
        // the generic method instead of inference.
        // Issue #658 / #1634: supplementary interface check for user-class args,
        // threaded as a call-local parameter into Resolve instead of a shared
        // static so nested/concurrent binds can't clobber it.
        Func<Type, Type, bool>? supplementaryInterfaceCheck = null;
        if (hasUserClassArg)
        {
            supplementaryInterfaceCheck = CheckUserClassInterface;
        }

        bool CheckUserClassInterface(Type source, Type target) =>
            IsUserClassAssignableToInterfaceFromArgs(arguments, argTypes, source, target);

        var argumentStructuralProjectionCheck = MakeStructuralProjectionArgumentCheck(arguments, argumentOffset: 1);
        bool ExtensionStructuralProjectionCheck(int index, Type target) =>
            index == 0
                ? ClrTypeUtilities.IsAssignableByName(target, argTypes[0])
                    || Conversion.ClassifyNonStructural(receiver.Type, TypeSymbol.FromClrType(target)).IsImplicit
                : argumentStructuralProjectionCheck?.Invoke(index, target) == true;

        // Issue #1311: imported extension calls dispatch as
        // `Class.Method(this receiver, args…)`, so argTypes slot 0 is the
        // receiver and user argument `i` lives at slot `i + 1`.
        // Issue #1812: mirror the flag every other CLR-call path already passes
        // — an interpolated-string argument to an extension method's
        // IFormattable/FormattableString (or handler) parameter must resolve
        // consistently with the instance/inherited/static/ctor paths. Offset by
        // 1 (receiverArgCount) since slot 0 here is the receiver, not a
        // user-supplied argument.
        Func<MethodInfo, bool, ImmutableArray<TypeSymbol?>> recoverExtensionTypeArgs =
            (closed, isExpanded) => MemberLookup.BuildSymbolicMethodTypeArgs(
                closed,
                typeArgSymbols,
                extensionSymbolicArgs,
                isExpanded);
        Func<int, bool> functionLiteralArgumentCheck = argumentIndex =>
            argumentIndex > 0
            && argumentIndex - 1 < arguments.Length
            && arguments[argumentIndex - 1] is BoundFunctionLiteralExpression;
        var resolution = ClrOverloadResolution.Resolve(
            candidates,
            argTypes,
            explicitTypeArgs,
            scope.References.MapClrTypeToReferences,
            ComputeInterpolatedStringArgFlags(ce.Arguments, argTypes.Length, receiverArgCount: 1),
            argumentNames: extensionArgumentNames,
            recoverTypeArgSymbols: recoverExtensionTypeArgs,
            supplementaryInterfaceCheck: supplementaryInterfaceCheck,
            constantNarrowingArgumentCheck: MakeConstantNarrowingArgumentCheck(arguments, argumentOffset: 1),
            structuralProjectionArgumentCheck: ExtensionStructuralProjectionCheck,
            delegateRefKindArgumentCheck: MakeDelegateRefKindArgumentCheck(arguments, argumentOffset: 1),
            methodGroupInference: MakeMethodGroupInference(arguments, GetEffectiveArgumentClrTypeForOverloadResolution, argumentOffset: 1),
            methodGroupArgumentCheck: MakeMethodGroupArgumentCheck(arguments, argumentOffset: 1),
            deferredInferenceArgs: deferredInferenceArgs,
            functionLiteralArgumentCheck: functionLiteralArgumentCheck);

        switch (resolution.Outcome)
        {
            case ClrOverloadResolution.ResolutionOutcome.Resolved:
                break;
            case ClrOverloadResolution.ResolutionOutcome.Ambiguous:
                Diagnostics.ReportAmbiguousOverload(ce.Location, methodName, resolution.Ambiguous.Length, resolution.Ambiguous.Select(ClrOverloadResolution.FormatMethodSignature));
                result = new BoundErrorExpression(null);
                return true;
            default:
                return false;
        }

        if (resolution.Best is not { } best)
        {
            return false;
        }

        var declaringType = best.DeclaringType;
        if (declaringType == null)
        {
            return false;
        }

        var importedClass = new ImportedClassSymbol(declaringType, ce, references: scope.References);

        // Issue #833: for an extension call the symbolic-argument vector
        // includes the receiver as slot 0 to mirror the static-dispatch
        // shape (`Class.Method(this receiver, args…)`). The inferred
        // method-type-args may then surface a symbolic return like
        // `[]T` from `[]T{}.ToArray()` instead of the erased
        // `object[]`.
        var extensionSymbolicTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(
            best,
            typeArgSymbols,
            extensionSymbolicArgs,
            resolution.IsExpanded);
        var extensionTypeArgSymbolsForCall = !extensionSymbolicTypeArgs.IsDefault
            ? extensionSymbolicTypeArgs
            : typeArgSymbols.IsDefault
                ? default
                : ImmutableArray.CreateRange<TypeSymbol?>(typeArgSymbols);
        var returnOverride = ResolveImportedGenericReturnType(best, typeArgSymbols)
            ?? MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(best, extensionSymbolicTypeArgs, receiver.Type);
        var function = new ImportedFunctionSymbol(methodName, importedClass, best, ce, returnOverride);

        var allArguments = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length + 1);
        allArguments.Add(receiver);
        allArguments.AddRange(arguments);
        var bound = allArguments.MoveToImmutable();

        // Issue #506: when overload resolution selected the expanded form of a
        // `params T[]` extension method (e.g. `MyEnumerable.Concat(this src,
        // params string[] tail)` called with positional tail args), pack the
        // trailing positional arguments into a synthesised slice/array first.
        // The receiver occupies parameter slot 0; the params slot is always
        // the last parameter, so it never collides with the receiver. Named
        // arguments against an expanded-form extension already carry a
        // receiver-prefixed mapping from overload resolution.
        var parameters = best.GetParameters();
        if (resolution.IsExpanded)
        {
            bound = overloads.ExpandParamsArguments(
                bound,
                parameters,
                ce,
                receiverArgCount: 1,
                parameterMapping: resolution.ParameterMapping,
                symbolicMethodTypeArgs: extensionTypeArgSymbolsForCall);
        }

        var downstreamMapping = resolution.IsExpanded ? default : resolution.ParameterMapping;

        // Issue #1638: shared CLR call-argument-construction pipeline
        // (interpolation rebind → handler args → delegate rebind →
        // parameter conversions). The receiver occupies bound[0] /
        // parameters[0] (receiverArgCount: 1), so both the interpolation
        // rebind and handler-args steps must skip that synthesised slot
        // (it has no source syntax and, per the extension-call ADR, no
        // separate BoundExpression that needs updating outside `bound`).
        //
        // Issue #1150: generic extension methods keep ONLY numeric-return
        // widening: full rebinding could erase a LINQ delegate to
        // `Func<object,object>` while the call is re-closed over symbolic type
        // arguments (#1334). Non-generic extensions have no such re-closing
        // hazard and use full rebinding so nested named-delegate slots retain
        // their exact CLR ABI (#2672).
        //
        // Issue #506 follow-up: still routes through BindClrParameterConversions
        // so value-type → object boxing fires for fixed-arity imported
        // extension calls too.
        var extensionDelegateRebindMode = best.IsGenericMethod
            ? ClrCallDelegateRebindMode.NumericWideningOnly
            : ClrCallDelegateRebindMode.Full;
        bound = BuildResolvedClrCallArguments(
            bound,
            ce.Arguments,
            parameters,
            downstreamMapping,
            receiver,
            ce.Location,
            ce,
            extensionDelegateRebindMode,
            out var extensionHandlerPrelude,
            out var extensionUpdatedReceiver,
            method: best,
            symbolicMethodTypeArgs: extensionTypeArgSymbolsForCall,
            receiverType: receiver.Type,
            receiverArgCount: 1);
        if (extensionUpdatedReceiver != null && extensionUpdatedReceiver != receiver)
        {
            bound = bound.SetItem(0, extensionUpdatedReceiver);
        }

        // Issue #327 / #343: re-order arguments into parameter positions when
        // named arguments were used; otherwise fall through to the existing
        // trailing-optional fill.
        bound = OverloadResolver.BuildOrderedCallArguments(bound, downstreamMapping, parameters);

        var refKinds = ComputeArgumentRefKinds(parameters);
        overloads.ValidateRefArguments(bound, refKinds, methodName, ce.Location);
        result = WrapWithHandlerPrelude(new BoundImportedCallExpression(ce, function, bound, refKinds, extensionTypeArgSymbolsForCall), extensionHandlerPrelude, ce);
        return true;
    }

    /// <summary>
    /// Issue #1423: projects a user-declared class to the implemented CLR
    /// interface best suited to drive extension-method receiver matching and
    /// generic inference. Prefers an implemented interface that is, or extends,
    /// <c>IEnumerable&lt;T&gt;</c> (so LINQ-style extensions whose <c>this</c>
    /// self-parameter is <c>IEnumerable&lt;TSource&gt;</c> bind and infer
    /// <c>TSource</c>), choosing the most-derived such interface so any
    /// methods declared on the richer interface remain reachable. Falls back to
    /// the first implemented CLR interface so non-collection extensions can
    /// still match an interface receiver.
    /// </summary>
    /// <param name="userClass">The user-declared class receiver.</param>
    /// <param name="clrInterface">The projected CLR interface type, on success.</param>
    /// <returns><see langword="true"/> when an implemented CLR interface was found.</returns>
    private static bool TryProjectUserClassReceiverInterface(StructSymbol userClass, [NotNullWhen(true)] out Type? clrInterface)
    {
        clrInterface = null;
        if (userClass.ImplementedClrInterfaces.IsDefaultOrEmpty)
        {
            return false;
        }

        Type? firstInterface = null;
        Type? bestEnumerable = null;
        foreach (var implemented in userClass.ImplementedClrInterfaces)
        {
            var clr = implemented?.ClrType;
            if (clr == null || !clr.IsInterface)
            {
                continue;
            }

            firstInterface ??= clr;

            // A generic collection interface (IReadOnlyCollection<T>,
            // ICollection<T>, IList<T>, IEnumerable<T>, …) exposes
            // IEnumerable<T> through its base interfaces, letting overload
            // resolution recover the element type. Prefer the most-derived
            // such interface (the one whose interface set is largest).
            if (ImplementsGenericEnumerable(clr)
                && (bestEnumerable == null
                    || SafeInterfaceCount(clr) > SafeInterfaceCount(bestEnumerable)))
            {
                bestEnumerable = clr;
            }
        }

        clrInterface = bestEnumerable ?? firstInterface;
        return clrInterface != null;
    }

    private static bool ImplementsGenericEnumerable(Type clr)
    {
        if (clr.IsGenericType && clr.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IEnumerable`1")
        {
            return true;
        }

        try
        {
            foreach (var iface in clr.GetInterfaces())
            {
                if (iface.IsGenericType && iface.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IEnumerable`1")
                {
                    return true;
                }
            }
        }
        catch (Exception)
        {
            // Cross-context (MLC) types may throw on GetInterfaces(); ignore.
        }

        return false;
    }

    private static int SafeInterfaceCount(Type clr)
    {
        try
        {
            return clr.GetInterfaces().Length;
        }
        catch (Exception)
        {
            return 0;
        }
    }

    /// <summary>
    /// Issue #1638: selects which delegate-argument rebind step
    /// <see cref="BuildResolvedClrCallArguments"/> runs between the
    /// interpolated-string-handler pass and the CLR parameter-conversion
    /// pass.
    /// </summary>
    private enum ClrCallDelegateRebindMode
    {
        /// <summary>Full erasing rebind (<see cref="RebindFunctionLiteralDelegateArguments"/>): used by ctor/static/instance/inherited dispatch.</summary>
        Full,

        /// <summary>
        /// Issue #1150 / #1334: numeric-return-widening-only rebind
        /// (<see cref="RebindNumericReturnWideningDelegateArguments"/>).
        /// Imported EXTENSION dispatch deliberately narrows to this subset:
        /// a full erasing rebind of a non-numeric-widening literal would
        /// erase the delegate to the generic LINQ method's type-erased
        /// shape (e.g. <c>Func&lt;object,object&gt;</c>) while the call site
        /// re-closes the generic method over the real (symbolic) type
        /// argument, producing an ilverify StackUnexpected mismatch.
        /// </summary>
        NumericWideningOnly,
    }

    /// <summary>
    /// Issue #1638: the shared post-overload-resolution CLR call-argument
    /// construction pipeline — <c>RebindFormattableInterpolationArguments →
    /// ApplyInterpolatedStringHandlers → (delegate rebind) →
    /// BindClrParameterConversions</c> — used by every resolved CLR call
    /// dispatch (ctor, static, instance, inherited-instance, extension).
    /// Centralising the sequence keeps a fix applied once (e.g. a step
    /// re-ordering or a missing step) from drifting out of sync across the
    /// five call sites.
    ///
    /// <c>argumentSyntax</c> is the call's source argument syntax list, used
    /// to detect interpolated-string arguments; it does NOT include a slot
    /// for a synthesised receiver. <c>delegateRebindMode</c> selects which
    /// delegate-argument rebind step runs; see
    /// <see cref="ClrCallDelegateRebindMode"/>. <c>receiverType</c> is passed
    /// to the delegate-rebind step's symbolic-target lookup. Issue
    /// #1512/#1320: <c>conversionReceiverType</c> is the receiver type passed
    /// to <see cref="ConversionClassifier.BindClrParameterConversions"/>
    /// instead — the instance-call path deliberately feeds the delegate
    /// rebind the enumerable-normalized receiver type while feeding the
    /// parameter-conversion pass the raw (un-normalized) receiver type, so
    /// this can differ from <c>receiverType</c>; defaults to it via
    /// <c>hasConversionReceiverTypeOverride</c> when not overridden.
    /// <c>receiverArgCount</c> is the number of leading argument/parameter
    /// slots reserved for a synthesised receiver (0 for plain calls, 1 for
    /// imported extension calls).
    /// </summary>
    private ImmutableArray<BoundExpression> BuildResolvedClrCallArguments(
        ImmutableArray<BoundExpression> arguments,
        SeparatedSyntaxList<ExpressionSyntax> argumentSyntax,
        ParameterInfo[] parameters,
        ImmutableArray<int> parameterMapping,
        BoundExpression? receiver,
        TextLocation location,
        CallExpressionSyntax call,
        ClrCallDelegateRebindMode delegateRebindMode,
        out ImmutableArray<BoundStatement> preludeStatements,
        out BoundExpression? updatedReceiver,
        MethodInfo? method = null,
        ImmutableArray<TypeSymbol?> symbolicMethodTypeArgs = default,
        TypeSymbol? receiverType = null,
        bool hasConversionReceiverTypeOverride = false,
        TypeSymbol? conversionReceiverType = null,
        int receiverArgCount = 0,
        IReadOnlyDictionary<int, TypeSymbol>? parameterTypeOverrides = null)
    {
        var rebound = RebindFormattableInterpolationArguments(arguments, argumentSyntax, parameters, parameterMapping, receiverArgCount);
        var handlerArgs = ApplyInterpolatedStringHandlers(parameters, rebound, receiver, location, parameterMapping, out preludeStatements, out updatedReceiver);
        var delegateArgs = delegateRebindMode == ClrCallDelegateRebindMode.Full
            ? RebindFunctionLiteralDelegateArguments(
                handlerArgs,
                parameters,
                parameterMapping,
                method,
                symbolicMethodTypeArgs,
                receiverType,
                parameterTypeOverrides)
            : RebindNumericReturnWideningDelegateArguments(handlerArgs, parameters, parameterMapping);
        var effectiveConversionReceiverType = hasConversionReceiverTypeOverride ? conversionReceiverType : receiverType;
        var conversionSymbolicMethodTypeArgs = symbolicMethodTypeArgs.IsDefault
            ? default
            : ImmutableArray.CreateRange<TypeSymbol?>(
                symbolicMethodTypeArgs.Select(symbol => symbol ?? TypeSymbol.Error));
        return conversions.BindClrParameterConversions(
            delegateArgs,
            parameters,
            call,
            parameterMapping,
            receiverArgCount,
            method,
            effectiveConversionReceiverType,
            conversionSymbolicMethodTypeArgs,
            parameterTypeOverrides);
    }

    private ImmutableArray<BoundExpression> RebindFunctionLiteralDelegateArguments(
        ImmutableArray<BoundExpression> arguments,
        ParameterInfo[] parameters,
        ImmutableArray<int> parameterMapping = default,
        MethodInfo? method = null,
        ImmutableArray<TypeSymbol?> symbolicMethodTypeArgs = default,
        TypeSymbol? receiverType = null,
        IReadOnlyDictionary<int, TypeSymbol>? parameterTypeOverrides = null)
    {
        ImmutableArray<BoundExpression>.Builder? builder = null;
        for (var i = 0; i < arguments.Length; i++)
        {
            var paramIndex = parameterMapping.IsDefault ? i : parameterMapping[i];
            var argument = arguments[i];
            var rebound = argument;
            TypeSymbol? parameterTypeOverride = null;
            if (parameterTypeOverrides != null)
            {
                parameterTypeOverrides.TryGetValue(paramIndex, out parameterTypeOverride);
            }

            FunctionTypeSymbol? targetFunctionType = null;
            var hasTargetFunctionType = parameterTypeOverride != null
                ? MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(parameterTypeOverride, out targetFunctionType)
                : paramIndex < parameters.Length
                    && MemberLookup.TryGetLambdaTargetFunctionType(parameters[paramIndex].ParameterType, out targetFunctionType);
            if (paramIndex < parameters.Length
                && LambdaBinder.TryGetFunctionLiteral(argument, out var literal)
                && hasTargetFunctionType
                && literal.FunctionType != targetFunctionType)
            {
                targetFunctionType = Invariant.Required(
                    targetFunctionType,
                    "successful delegate target lookup returns a function type");

                // Issue #1512: when the call is a generic method whose delegate
                // parameter mentions a method type parameter, the closed CLR
                // parameter type erases that slot to `object`, so the literal
                // would be rebound to e.g. `(Task) -> object` and emit a
                // `Func<Task,object>` delegate where `Func<Task,T>` is required.
                // Prefer the symbolic delegate target recovered from the OPEN
                // method parameter substituted with the inferred symbolic method
                // type arguments — including when it already equals the literal's
                // bound function type, so the erasing rebind below is skipped.
                if (TryBuildSymbolicDelegateTargetForMethodParam(method, paramIndex, symbolicMethodTypeArgs, receiverType, out var symbolicTarget))
                {
                    targetFunctionType = symbolicTarget;
                }
                else if (TypeSymbol.ContainsTypeParameter(literal.FunctionType) || TypeSymbol.ContainsSameCompilationUserType(literal.FunctionType))
                {
                    // Issue #1502 (ctor path): no method-generic recovery applies
                    // (this is a constructor call, or a non-generic/erasure-free
                    // method), yet the literal's bound function type already
                    // carries a type parameter or same-compilation user type —
                    // e.g. a `Lazy[T](() -> v)` ctor argument pre-bound against
                    // the OPEN ctor's symbolic delegate shape by
                    // TryResolveSymbolicDelegateTargetForCtor. The CLR parameter
                    // type here is only the erased placeholder shape (type
                    // parameters closed with `object`); re-erasing the
                    // already-correct symbolic literal below would downgrade
                    // `Func<T>` back to `Func<object>` and produce an
                    // unverifiable delegate. Keep the literal's existing
                    // (already symbolic) function type instead of erasing it.
                    targetFunctionType = literal.FunctionType;
                }

                if (literal.FunctionType != targetFunctionType)
                {
                    rebound = lambdas.CreateErasedFunctionLiteralAdapter(literal, targetFunctionType);
                }
            }

            if (rebound != argument && builder == null)
            {
                builder = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
                for (var j = 0; j < i; j++)
                {
                    builder.Add(arguments[j]);
                }
            }

            builder?.Add(rebound);
        }

        if (builder == null)
        {
            return arguments;
        }

        for (var i = builder.Count; i < arguments.Length; i++)
        {
            builder.Add(arguments[i]);
        }

        return builder.ToImmutable();
    }

    // Issue #1150: reshape only those func/arrow literal arguments whose natural
    // numeric return type implicitly, losslessly widens to the corresponding
    // delegate parameter's return type. The reshape routes through the erased
    // adapter (the established pattern for generic-LINQ dispatch), inserting the
    // numeric return-widening conversion in the body so the produced delegate's
    // return type matches the target. Literals whose return already matches the
    // target (the common LINQ case: Where/Single/Select with bool/string
    // selectors) are left completely untouched, preserving their natural
    // concrete delegate signature.
    //
    // Issue #1334: the widening gate is deliberately restricted to NUMERIC
    // (value-type primitive) return widening — matching the equivalent guard on
    // the BindConversion path. A non-numeric implicit widening (a reference
    // covariance, or a same-compilation user-type return widening to the
    // type-erased `object` of a generic LINQ projection such as
    // `Select<TSource, TResult>` where `TResult` is recovered symbolically) must
    // NOT be erased here: doing so materialised the lambda as `Func<object,
    // object>` while the call site re-closed `Select<Entry, Filter>`, producing
    // an ilverify StackUnexpected mismatch. Reference covariance is handled by
    // the CLR delegate's natural variance at emit, so leaving such literals at
    // their concrete delegate signature is both correct and verifiable.
    private ImmutableArray<BoundExpression> RebindNumericReturnWideningDelegateArguments(
        ImmutableArray<BoundExpression> arguments,
        ParameterInfo[] parameters,
        ImmutableArray<int> parameterMapping = default)
    {
        ImmutableArray<BoundExpression>.Builder? builder = null;
        for (var i = 0; i < arguments.Length; i++)
        {
            var paramIndex = parameterMapping.IsDefault ? i : parameterMapping[i];
            var argument = arguments[i];
            var rebound = argument;
            if (paramIndex < parameters.Length
                && LambdaBinder.TryGetFunctionLiteral(argument, out var literal))
            {
                var literalFnType = literal.FunctionType as FunctionTypeSymbol;
                if (literalFnType != null
                    && literalFnType.ReturnType != TypeSymbol.Void
                    && literalFnType.ReturnType != TypeSymbol.Error
                    && MemberLookup.TryGetLambdaTargetFunctionType(parameters[paramIndex].ParameterType, out var targetFunctionType)
                    && targetFunctionType.ReturnType != TypeSymbol.Void
                    && targetFunctionType.ReturnType != TypeSymbol.Error
                    && targetFunctionType.Arity == literalFnType.Arity
                    && !ReferenceEquals(literalFnType.ReturnType, targetFunctionType.ReturnType)
                    && ConversionClassifier.IsNumericReturnWidening(literalFnType.ReturnType, targetFunctionType.ReturnType))
                {
                    rebound = lambdas.CreateErasedFunctionLiteralAdapter(literal, targetFunctionType);
                }
            }

            if (rebound != argument && builder == null)
            {
                builder = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
                for (var j = 0; j < i; j++)
                {
                    builder.Add(arguments[j]);
                }
            }

            builder?.Add(rebound);
        }

        if (builder == null)
        {
            return arguments;
        }

        for (var i = builder.Count; i < arguments.Length; i++)
        {
            builder.Add(arguments[i]);
        }

        return builder.ToImmutable();
    }

    /// <summary>
    /// Issue #658: determines whether a user-defined G# class argument (identified
    /// by its surrogate CLR type in <paramref name="argTypes"/>) implements the
    /// specified CLR <paramref name="target"/> interface. Used as the
    /// <c>supplementaryInterfaceCheck</c> argument to
    /// <see cref="ClrOverloadResolution.Resolve{T}"/> during overload resolution for
    /// calls that include user-class arguments.
    /// </summary>
    private static bool IsUserClassAssignableToInterface(
        ImmutableArray<BoundExpression>.Builder boundArguments,
        System.Type?[] argTypes,
        System.Type source,
        System.Type target)
    {
        for (var i = 0; i < boundArguments.Count; i++)
        {
            if (!ClrTypeUtilities.AreSame(argTypes[i], source))
            {
                continue;
            }

            if (boundArguments[i].Type is StructSymbol { IsClass: true } ss)
            {
                if (UserClassImplementsInterface(ss, target))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #658: checks whether a user-defined G# class (or any of its base
    /// classes) declares implementation of the specified CLR interface.
    /// </summary>
    private static bool UserClassImplementsInterface(StructSymbol ss, System.Type target)
    {
        StructSymbol? current = ss;
        while (current != null)
        {
            foreach (var iface in current.ImplementedClrInterfaces)
            {
                if (iface.ClrType == null)
                {
                    continue;
                }

                // Direct match: the implemented interface IS the target.
                if (ClrTypeUtilities.AreSame(iface.ClrType, target))
                {
                    return true;
                }

                // The implemented interface itself inherits from the target.
                if (ClrTypeUtilities.ImplementsInterfaceByName(iface.ClrType, target))
                {
                    return true;
                }
            }

            current = current.BaseClass;
        }

        // Also check the imported CLR base type (if any) — it may implement
        // the target interface.
        if (ss.ImportedBaseType?.ClrType != null
            && ClrTypeUtilities.ImplementsInterfaceByName(ss.ImportedBaseType.ClrType, target))
        {
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #658: variant of <see cref="IsUserClassAssignableToInterface"/> that
    /// works with <see cref="ImmutableArray{T}"/> arguments (used by instance
    /// method call paths).
    /// </summary>
    private static bool IsUserClassAssignableToInterfaceFromArgs(
        ImmutableArray<BoundExpression> boundArguments,
        System.Type?[] argTypes,
        System.Type source,
        System.Type target)
    {
        for (var i = 0; i < boundArguments.Length; i++)
        {
            if (!ClrTypeUtilities.AreSame(argTypes[i], source))
            {
                continue;
            }

            if (boundArguments[i].Type is StructSymbol { IsClass: true } ss)
            {
                if (UserClassImplementsInterface(ss, target))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// ADR-0091 / issue #757: bind an explicit-base interface call
    /// <c>base[IFoo].M(args)</c>. Validates that:
    /// <list type="number">
    ///   <item>the enclosing function is an instance member of a class or struct,</item>
    ///   <item>the interface resolves and is in the enclosing type's interface set (GS0338),</item>
    ///   <item>the named member exists on the interface (GS0339),</item>
    ///   <item>the member has a default body (GS0340), and</item>
    ///   <item>the member is not a <c>private</c> helper (GS0341 — preserves ADR-0090).</item>
    /// </list>
    /// On success, returns a <see cref="BoundBaseInterfaceCallExpression"/>
    /// whose receiver is the enclosing method's <c>this</c> parameter.
    /// </summary>
    private BoundExpression BindBaseInterfaceCallExpression(BaseInterfaceCallExpressionSyntax syntax)
    {
        // Resolve the selector inside the brackets first. Issue #986: when it
        // names a base CLASS instead of an interface, route to the base-class
        // call form so `base[BaseClass].M(args)` works as an alternative
        // spelling of `base.M(args)` — binding arguments there (not here) so
        // they are not bound twice. Type-clause binding already reports the
        // relevant "type not found" diagnostic (GS0046) when resolution fails.
        var ifaceType = bindTypeClause(syntax.InterfaceTypeClause);
        if (ifaceType is null || ifaceType == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        // Issue #1104: the parenthesis-less PROPERTY form `base[BaseClass].Prop`
        // (read) and `base[BaseClass].Prop = value` (write). Route to the shared
        // base-class property read/write path with the explicit ancestor
        // selector so resolution + GS0383/GS0384/GS0385 diagnostics + non-virtual
        // `call instance ... <SelectorBase>::get_/set_Prop` emission all reuse
        // the same code as plain `base.Prop`. A base-class selector is required;
        // an interface selector in this position is not a supported form and is
        // reported via the member-not-found path below by falling through to the
        // call handling (which yields a clear diagnostic).
        if (syntax.IsPropertyAccess && ifaceType is StructSymbol propSelector && propSelector.IsClass)
        {
            if (syntax.IsPropertyWrite)
            {
                if (syntax.Value is not { } valueSyntax
                    || syntax.EqualsToken is not { } equalsToken)
                {
                    return new BoundErrorExpression(null);
                }

                var boundValue = BindExpression(valueSyntax);
                return BindBaseClassPropertyWrite(
                    syntax.MethodIdentifier.Text,
                    syntax.MethodIdentifier.Location,
                    syntax.BaseKeyword.Location,
                    boundValue,
                    valueSyntax.Location,
                    equalsToken.Location,
                    explicitBaseType: propSelector,
                    selectorLocation: syntax.InterfaceTypeClause.Location);
            }

            var memberName = new NameExpressionSyntax(syntax.SyntaxTree, syntax.MethodIdentifier);
            return BindBaseClassPropertyRead(
                memberName,
                syntax.BaseKeyword.Location,
                explicitBaseType: propSelector,
                selectorLocation: syntax.InterfaceTypeClause.Location);
        }

        if (ifaceType is StructSymbol classSelector && classSelector.IsClass)
        {
            if (syntax.OpenParenthesisToken is not { } openParenthesisToken
                || syntax.CloseParenthesisToken is not { } closeParenthesisToken)
            {
                return new BoundErrorExpression(null);
            }

            var synthesizedCall = new CallExpressionSyntax(
                syntax.SyntaxTree,
                syntax.MethodIdentifier,
                syntax.MethodTypeArgumentList,
                openParenthesisToken,
                syntax.Arguments,
                closeParenthesisToken);
            return BindBaseClassCall(
                synthesizedCall,
                syntax.BaseKeyword.Location,
                classSelector,
                syntax.InterfaceTypeClause.Location);
        }

        // Bind the user arguments unconditionally — even on the failure paths
        // below we want any nested binder diagnostics (unknown name in arg
        // position, etc.) to surface in the same pass.
        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
        for (var i = 0; i < syntax.Arguments.Count; i++)
        {
            boundArguments.Add(BindExpression(syntax.Arguments[i]));
        }

        // The selector must denote an interface.
        if (ifaceType is not InterfaceSymbol ifaceSym)
        {
            Diagnostics.ReportBaseInterfaceCallTypeDoesNotImplementInterface(
                syntax.InterfaceTypeClause.Location,
                EnclosingTypeDisplayName(),
                ifaceType.Name);
            return new BoundErrorExpression(null);
        }

        // The call site must live in an instance member of a class/struct
        // that implements `ifaceSym`. A top-level function, a `shared` static,
        // or a generic-typeparameter-receiver call all fail this test.
        var enclosingType = function?.ReceiverType as StructSymbol;
        if (enclosingType == null || function?.ThisParameter == null)
        {
            Diagnostics.ReportBaseInterfaceCallTypeDoesNotImplementInterface(
                syntax.BaseKeyword.Location,
                "<top-level>",
                ifaceSym.Name);
            return new BoundErrorExpression(null);
        }

        if (!EnclosingTypeImplements(enclosingType, ifaceSym))
        {
            Diagnostics.ReportBaseInterfaceCallTypeDoesNotImplementInterface(
                syntax.InterfaceTypeClause.Location,
                enclosingType.Name,
                ifaceSym.Name);
            return new BoundErrorExpression(null);
        }

        // Generic-method type arguments on the selector are reserved for a
        // future ADR-0091 follow-up — reject for now with the "member is
        // abstract"-shaped diagnostic name so users get a clear pointer.
        if (syntax.MethodTypeArgumentList != null)
        {
            Diagnostics.ReportBaseInterfaceCallMemberNotFound(
                syntax.MethodIdentifier.Location,
                ifaceSym.Name,
                syntax.MethodIdentifier.Text + "[…]");
            return new BoundErrorExpression(null);
        }

        var methodName = syntax.MethodIdentifier.Text;

        // Private helpers (ADR-0090) are intentionally invisible to
        // implementers; calling one through base[IFoo] would defeat that
        // encapsulation. Check first so the diagnostic distinguishes the
        // private case from a generic "no such member".
        var privateMatches = ifaceSym.GetPrivateMethods(methodName);
        if (privateMatches.Length > 0)
        {
            Diagnostics.ReportBaseInterfaceCallTargetsPrivateHelper(
                syntax.MethodIdentifier.Location,
                ifaceSym.Name,
                methodName);
            return new BoundErrorExpression(null);
        }

        // Look up the named method on the interface's public contract. Pick
        // the overload whose callable arity matches the call site; if no
        // overload matches at all, fall back to "member not found" — when
        // overload-by-arity finds a match but its body is abstract, fall to
        // GS0340 below. For a constructed generic interface, the method we
        // find is the substituted one; we map it back to its open definition
        // (preserved on InterfaceSymbol.Definition.Methods at the same
        // index) so the emitter and interpreter can resolve through the
        // single MethodHandles / program.Functions slot.
        FunctionSymbol? arityMatch = null;
        FunctionSymbol? anyMatch = null;
        int matchIndex = -1;
        var overloads = ifaceSym.Methods;
        for (var i = 0; i < overloads.Length; i++)
        {
            var candidate = overloads[i];
            if (candidate.Name != methodName)
            {
                continue;
            }

            anyMatch = candidate;
            var calleeOffset = candidate.ExplicitReceiverParameter == null ? 0 : 1;
            var callableParameterCount = candidate.Parameters.Length - calleeOffset;
            if (callableParameterCount == boundArguments.Count)
            {
                arityMatch = candidate;
                matchIndex = i;
                break;
            }
        }

        if (anyMatch == null)
        {
            Diagnostics.ReportBaseInterfaceCallMemberNotFound(
                syntax.MethodIdentifier.Location,
                ifaceSym.Name,
                methodName);
            return new BoundErrorExpression(null);
        }

        if (arityMatch == null)
        {
            // Member exists but no overload accepts this many arguments;
            // report a wrong-arg-count diagnostic against the first overload
            // for ergonomic recovery (the user will fix the arg count and
            // re-bind).
            var calleeOffset = anyMatch.ExplicitReceiverParameter == null ? 0 : 1;
            var callableParameterCount = anyMatch.Parameters.Length - calleeOffset;
            Diagnostics.ReportWrongArgumentCount(syntax.MethodIdentifier.Location, methodName, callableParameterCount, boundArguments.Count);
            return new BoundErrorExpression(null);
        }

        // Map the substituted method on a constructed generic interface back
        // to its open MethodDef slot (cache.MethodHandles is keyed on the
        // open definition). CreateConstructed preserves declaration order
        // 1:1, so the same index identifies the open slot.
        var openMethod = arityMatch;
        if (ifaceSym.Definition != null && !ReferenceEquals(ifaceSym.Definition, ifaceSym) && matchIndex >= 0 && matchIndex < ifaceSym.Definition.Methods.Length)
        {
            openMethod = ifaceSym.Definition.Methods[matchIndex];
        }

        if (!InterfaceSymbol.HasDefaultBody(openMethod))
        {
            Diagnostics.ReportBaseInterfaceCallMemberIsAbstract(
                syntax.MethodIdentifier.Location,
                ifaceSym.Name,
                methodName);
            return new BoundErrorExpression(null);
        }

        if (function?.ThisParameter is not { } thisParameter)
        {
            return new BoundErrorExpression(null);
        }

        var receiver = new BoundVariableExpression(null, thisParameter);
        return new BoundBaseInterfaceCallExpression(
            syntax,
            receiver,
            ifaceSym,
            openMethod,
            boundArguments.ToImmutable());
    }

    /// <summary>
    /// ADR-0091 / issue #757: returns true when <paramref name="enclosingType"/>
    /// (or any of its base classes) appears in <paramref name="ifaceSym"/>'s
    /// implementer set. Constructed generic interfaces compare by
    /// <see cref="InterfaceSymbol.Definition"/> identity to allow
    /// <c>base[IFoo[int]]</c> from a class declared as <c>: IFoo[int]</c>.
    /// </summary>
    private static bool EnclosingTypeImplements(StructSymbol enclosingType, InterfaceSymbol ifaceSym)
    {
        var ifaceDef = ifaceSym.Definition ?? ifaceSym;
        StructSymbol? t = enclosingType;
        while (t != null)
        {
            foreach (var iface in t.Interfaces)
            {
                var candidateDef = iface.Definition ?? iface;
                if (ReferenceEquals(candidateDef, ifaceDef))
                {
                    return true;
                }
            }

            t = t.BaseClass;
        }

        return false;
    }

    /// <summary>
    /// Issue #2534: binds the canonical <c>base.M(args)</c> syntax. A real
    /// value named <c>base</c> retains its historical member-call meaning;
    /// otherwise the call resolves through the base-class overload set and
    /// emits non-virtually.
    /// </summary>
    private BoundExpression BindBaseClassCallExpression(BaseClassCallExpressionSyntax syntax)
    {
        if (scope.TryLookupSymbol(syntax.BaseKeyword.Text) is VariableSymbol)
        {
            var receiver = new NameExpressionSyntax(syntax.SyntaxTree, syntax.BaseKeyword);
            var accessor = new AccessorExpressionSyntax(syntax.SyntaxTree, receiver, syntax.DotToken, syntax.Call);
            return BindAccessorExpression(accessor);
        }

        return BindBaseClassCall(
            syntax.Call,
            syntax.BaseKeyword.Location,
            explicitBaseType: null,
            selectorLocation: syntax.BaseKeyword.Location);
    }

    /// <summary>
    /// ADR-0091: produces a human-readable display name for the enclosing
    /// receiver type used in GS0338 messages. Falls back to a placeholder
    /// when the call site is not inside an instance member.
    /// </summary>
    private string EnclosingTypeDisplayName()
    {
        if (function?.ReceiverType is { } recv)
        {
            return recv.Name;
        }

        return "<top-level>";
    }

    /// <summary>
    /// Issue #986: binds a base-class call of the form <c>base.M(args)</c>
    /// (when <paramref name="explicitBaseType"/> is <see langword="null"/>) or
    /// the bracketed <c>base[BaseClass].M(args)</c> form (when it names the
    /// base class). Resolves <c>M</c> on the nearest base class's member set
    /// (walking grandparents), reuses the standard overload resolution and
    /// argument-conversion pipeline via
    /// <see cref="OverloadResolver.BindUserInstanceCall"/>, then wraps the
    /// result in a <see cref="BoundBaseClassCallExpression"/> so the emitter
    /// produces a non-virtual <c>call</c> (not <c>callvirt</c>) — exactly like
    /// C# <c>base.M(...)</c>.
    /// </summary>
    /// <param name="ce">The method-call syntax (<c>M(args)</c>).</param>
    /// <param name="baseLocation">The location of the <c>base</c> token for context diagnostics.</param>
    /// <param name="explicitBaseType">The class named in <c>base[BaseClass]</c>, or <see langword="null"/> for the plain <c>base.M</c> form.</param>
    /// <param name="selectorLocation">The location of the bracketed selector (for GS0385); ignored when <paramref name="explicitBaseType"/> is null.</param>
    /// <returns>The bound base-class call, or a bound error on failure.</returns>
    private BoundExpression BindBaseClassCall(
        CallExpressionSyntax ce,
        TextLocation baseLocation,
        StructSymbol? explicitBaseType,
        TextLocation selectorLocation)
    {
        if (!TryResolveBaseSearchType(baseLocation, explicitBaseType, selectorLocation, out var searchBase, out var clrBaseFallback))
        {
            return new BoundErrorExpression(null);
        }

        var methodName = ce.Identifier.Text;

        // Resolve the overload set on the user base chain (this-first from the
        // search base), which walks grandparents — so the nearest user base
        // implementation of an inherited member is chosen.
        var baseOverloads = searchBase != null
            ? TypeMemberModel.GetMethods(searchBase, methodName, MemberQuery.Instance(MemberKinds.Method))
            : ImmutableArray<FunctionSymbol>.Empty;
        if (baseOverloads.IsEmpty)
        {
            // Issue #1260: no GSharp base declares the member (the class derives
            // directly from a BCL base, or the nearest user base does not declare
            // it). Fall back to the imported/BCL base type so `base.Dispose(...)`,
            // `base.ToString()`, etc. resolve and emit a non-virtual `call`.
            if (TryBindBaseClrInstanceCall(ce, methodName, clrBaseFallback, out var bclResult))
            {
                return bclResult;
            }

            Diagnostics.ReportBaseClassCallMemberNotFound(ce.Identifier.Location, searchBase?.Name ?? ClrTypeDisplayName(clrBaseFallback), methodName);
            return new BoundErrorExpression(null);
        }

        if (!overloads.TryAnalyzeCallArgumentLayout(ce.Arguments, out _, out var argumentNames))
        {
            return new BoundErrorExpression(null);
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(ce.Arguments.Count);
        foreach (var argument in ce.Arguments)
        {
            boundArguments.Add(BindExpression(OverloadResolver.UnwrapNamedArgumentValue(argument)));
        }

        var arguments = boundArguments.ToImmutable();
        var method = overloads.SelectInstanceOverloadOrReport(baseOverloads, arguments, ce, methodName, argumentNames);
        if (method == null)
        {
            return new BoundErrorExpression(null);
        }

        // Reuse the full instance-call binding pipeline (named-argument
        // reordering, generic substitution, variadic packing, per-argument
        // conversions). The receiver is the enclosing method's `this`.
        if (function?.ThisParameter is not { } thisParameter)
        {
            return new BoundErrorExpression(null);
        }

        var receiver = new BoundVariableExpression(null, thisParameter);

        var bound = overloads.BindUserInstanceCall(receiver, method, arguments, ce, argumentNames);
        if (bound is not BoundUserInstanceCallExpression uic)
        {
            return bound;
        }

        var declaringType = uic.Method.ReceiverType as StructSymbol ?? searchBase;
        if (declaringType == null)
        {
            return new BoundErrorExpression(null);
        }

        return new BoundBaseClassCallExpression(
            ce,
            uic.Receiver,
            declaringType,
            uic.Method,
            uic.Arguments,
            uic.Type);
    }

    /// <summary>
    /// Issue #1260: binds a <c>base.M(args)</c> call into an imported/BCL base
    /// class. Resolves the overload set against <paramref name="clrBase"/>
    /// (which walks the CLR base chain), runs the shared imported-instance
    /// overload resolution, and produces a
    /// <see cref="BoundImportedInstanceCallExpression"/> flagged as a non-virtual
    /// base call so the emitter writes <c>call</c> (not <c>callvirt</c>) — exactly
    /// like C# <c>base.M(...)</c>. A base call to an <c>abstract</c> BCL member
    /// (no implementation to delegate to) is reported as GS0413.
    /// </summary>
    /// <param name="ce">The method-call syntax.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="clrBase">The CLR base type to resolve the inherited member against.</param>
    /// <param name="result">The bound non-virtual base call (or an error node) when handled.</param>
    /// <returns><see langword="true"/> when the call resolved (or a precise diagnostic was reported); <see langword="false"/> when no candidate member exists.</returns>
    private bool TryBindBaseClrInstanceCall(
        CallExpressionSyntax ce,
        string methodName,
        System.Type? clrBase,
        [NotNullWhen(true)] out BoundExpression? result)
    {
        result = null;

        var candidates = CollectBaseClrMethodCandidates(clrBase, methodName);
        if (candidates.Count == 0)
        {
            return false;
        }

        if (!overloads.TryAnalyzeCallArgumentLayout(ce.Arguments, out _, out var argumentNames))
        {
            result = new BoundErrorExpression(null);
            return true;
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(ce.Arguments.Count);
        foreach (var argument in ce.Arguments)
        {
            boundArguments.Add(BindExpression(OverloadResolver.UnwrapNamedArgumentValue(argument)));
        }

        var arguments = boundArguments.ToImmutable();
        if (function?.ThisParameter is not { } thisParameter)
        {
            return false;
        }

        var receiver = new BoundVariableExpression(null, thisParameter);
        return TryResolveAndBindClrInstanceCall(
            receiver,
            candidates,
            clrBase,
            methodName,
            arguments,
            ce,
            out result,
            explicitTypeArgs: null,
            typeArgSymbols: default,
            argumentNames: argumentNames,
            nonVirtualBaseCall: true,
            baseMemberLocation: ce.Identifier.Location);
    }

    /// <summary>Issue #1260: a readable display name for a CLR base type used in base-call member-not-found diagnostics.</summary>
    private static string ClrTypeDisplayName(System.Type? clrType) => clrType?.Name ?? "object";

    /// <summary>
    /// Issue #1260: collects the candidate inherited CLR instance methods named
    /// <paramref name="methodName"/> that are reachable for a <c>base.M(...)</c>
    /// call against <paramref name="clrBase"/>. Unlike the ordinary inherited-CLR
    /// lookup (public only), a base call may target a <c>protected</c> virtual
    /// member (e.g. <c>System.IO.Stream.Dispose(bool)</c>), so this includes
    /// non-public methods but excludes members a derived type cannot legally
    /// call via <c>base</c> (<c>private</c>, and other-assembly <c>internal</c>).
    /// </summary>
    /// <param name="clrBase">The CLR base type to search (its base chain is walked by reflection).</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <returns>The deduplicated candidate methods (most-derived signature wins).</returns>
    private static IReadOnlyList<MethodInfo> CollectBaseClrMethodCandidates(System.Type? clrBase, string methodName)
    {
        var result = new List<MethodInfo>();
        if (clrBase == null)
        {
            return result;
        }

        foreach (var m in ClrTypeUtilities.SafeGetMethods(clrBase, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance))
        {
            if (!string.Equals(m.Name, methodName, System.StringComparison.Ordinal))
            {
                continue;
            }

            // Accessible to a derived type via `base`: public, protected
            // (Family), or protected-internal (FamilyOrAssembly). Exclude
            // private and (cross-assembly) internal members.
            if (!(m.IsPublic || m.IsFamily || m.IsFamilyOrAssembly))
            {
                continue;
            }

            if (!MemberLookup.HasSameSignature(result, m))
            {
                result.Add(m);
            }
        }

        return result;
    }

    /// <summary>
    /// Issue #1104 / #1260: resolves the base class to start a
    /// <c>base.Member</c> search from, shared by the base-method-call path
    /// (<see cref="BindBaseClassCall"/>) and the base-property-access path
    /// (<see cref="BindBaseClassPropertyRead"/> /
    /// <see cref="BindBaseClassPropertyWrite"/>). Reports GS0383 when the call
    /// site is not an instance member of a class and GS0385 when a bracketed
    /// <c>base[Type]</c> selector does not name an actual base class.
    /// <para>
    /// Issue #1260: a class with no GSharp base class still inherits the members
    /// of its imported/BCL base (or <c>System.Object</c>), so when there is no
    /// user <see cref="StructSymbol"/> base this no longer reports GS0383.
    /// Instead it returns with <paramref name="searchBase"/> <see langword="null"/>
    /// and <paramref name="clrBaseFallback"/> set to the CLR base type to resolve
    /// inherited members against. <paramref name="clrBaseFallback"/> is always
    /// non-<see langword="null"/> on success (defaulting to <c>typeof(object)</c>)
    /// so a multi-level user → user → BCL chain can fall back when the nearest
    /// user base does not declare the member.
    /// </para>
    /// </summary>
    /// <param name="baseLocation">The location of the <c>base</c> token (for GS0383).</param>
    /// <param name="explicitBaseType">The class named in <c>base[BaseClass]</c>, or <see langword="null"/> for the plain form.</param>
    /// <param name="selectorLocation">The location of the bracketed selector (for GS0385).</param>
    /// <param name="searchBase">The resolved GSharp base class to start the member search from, or <see langword="null"/> when the class derives only from an imported/BCL base.</param>
    /// <param name="clrBaseFallback">The CLR base type to resolve inherited BCL members against (issue #1260); always set on success.</param>
    /// <returns><see langword="true"/> when the access site is a valid class instance member.</returns>
    private bool TryResolveBaseSearchType(
        TextLocation baseLocation,
        StructSymbol? explicitBaseType,
        TextLocation selectorLocation,
        out StructSymbol? searchBase,
        out System.Type? clrBaseFallback)
    {
        searchBase = null;
        clrBaseFallback = null;

        // The access site must live in an instance member of a class. Top-level
        // functions, `shared` statics, and structs (no base class) all fail.
        var enclosingType = function?.ReceiverType as StructSymbol;
        if (enclosingType == null || function?.ThisParameter == null || !enclosingType.IsClass)
        {
            Diagnostics.ReportBaseClassCallHasNoBaseClass(baseLocation, EnclosingTypeDisplayName());
            return false;
        }

        // Determine the base class to start the member search from. For the
        // bracketed form, the named selector must be an actual base class of
        // the enclosing type; for the plain form, use the immediate base.
        if (explicitBaseType != null)
        {
            if (!IsBaseClassOf(enclosingType, explicitBaseType))
            {
                Diagnostics.ReportBaseClassCallSelectorNotBaseClass(selectorLocation, enclosingType.Name, explicitBaseType.Name);
                return false;
            }

            searchBase = explicitBaseType;
        }
        else
        {
            searchBase = enclosingType.BaseClass;
        }

        // Issue #1260: the CLR base type used for inherited-BCL member lookup —
        // walk from the search base (or the enclosing type when there is no user
        // base) to the topmost user class and take its imported CLR base,
        // defaulting to System.Object so universally-inherited members
        // (ToString/Equals/GetHashCode/GetType) resolve.
        clrBaseFallback = ResolveClrBaseSearchType(searchBase ?? enclosingType);
        return true;
    }

    /// <summary>
    /// Issue #1260: returns the CLR base type whose inherited instance members a
    /// <c>base.Member</c> access resolves against. Walks the GSharp base-class
    /// chain from <paramref name="from"/> to the topmost user class and returns
    /// that class's imported/BCL base (<see cref="StructSymbol.ImportedBaseType"/>),
    /// defaulting to <c>typeof(object)</c> when no class in the chain declares an
    /// imported base.
    /// </summary>
    /// <param name="from">The GSharp class to start walking from.</param>
    /// <returns>The CLR base type for inherited-member lookup.</returns>
    private static System.Type ResolveClrBaseSearchType(StructSymbol from)
    {
        StructSymbol? current = from;
        while (current != null)
        {
            var clr = current.ImportedBaseType?.ClrType;
            if (clr != null)
            {
                return clr;
            }

            current = current.BaseClass;
        }

        return typeof(object);
    }

    /// <summary>
    /// Issue #1104: binds a base-class property READ of the form
    /// <c>base.Prop</c> (or the bracketed <c>base[BaseClass].Prop</c> form).
    /// Resolves <c>Prop</c> on the nearest base class's property set (walking
    /// grandparents) and wraps the property's getter accessor in a
    /// <see cref="BoundBaseClassCallExpression"/> so the emitter produces a
    /// non-virtual <c>call instance R BaseClass::get_Prop()</c> — exactly like
    /// C# <c>base.Prop</c>. This lets an override reference the inherited member
    /// it shadows without re-entering its own getter (infinite recursion).
    /// </summary>
    /// <param name="member">The member-name syntax (<c>Prop</c>).</param>
    /// <param name="baseLocation">The location of the <c>base</c> token for context diagnostics.</param>
    /// <param name="explicitBaseType">The class named in <c>base[BaseClass]</c>, or <see langword="null"/> for the plain form.</param>
    /// <param name="selectorLocation">The location of the bracketed selector (for GS0385).</param>
    /// <returns>The bound base-class property read, or a bound error on failure.</returns>
    private BoundExpression BindBaseClassPropertyRead(
        NameExpressionSyntax member,
        TextLocation baseLocation,
        StructSymbol? explicitBaseType,
        TextLocation selectorLocation)
    {
        if (!TryResolveBaseSearchType(baseLocation, explicitBaseType, selectorLocation, out var searchBase, out var clrBaseFallback))
        {
            return new BoundErrorExpression(null);
        }

        var memberName = member.IdentifierToken.Text;
        if (searchBase == null || !TypeMemberModel.TryGetProperty(searchBase, memberName, out var prop, out var declaringType))
        {
            // Issue #3501: `base.M` used as a method GROUP (an argument, a
            // `let` initializer, …) — the base declares a METHOD, not a
            // property. Bind the group over `this` with non-virtual dispatch
            // so the resulting delegate captures the BASE implementation,
            // exactly like C#'s `base.M` delegate conversion.
            var baseMethods = searchBase != null
                ? TypeMemberModel.GetMethods(searchBase, memberName, MemberQuery.Instance(MemberKinds.Method))
                : ImmutableArray<FunctionSymbol>.Empty;
            if (!baseMethods.IsEmpty && GetEffectiveThisParameter() is { } baseGroupReceiver)
            {
                return BuildInstanceMethodGroup(
                    new BoundVariableExpression(null, baseGroupReceiver),
                    baseMethods,
                    forceNonVirtualDispatch: true);
            }

            // Issue #1260: no GSharp base declares the property — fall back to the
            // imported/BCL base type so `base.Prop` reads the inherited member
            // non-virtually (e.g. a virtual/overridable BCL property).
            if (TryBindBaseClrPropertyRead(member, clrBaseFallback, out var bclRead))
            {
                return bclRead;
            }

            Diagnostics.ReportBaseClassCallMemberNotFound(member.IdentifierToken.Location, searchBase?.Name ?? ClrTypeDisplayName(clrBaseFallback), memberName);
            return new BoundErrorExpression(null);
        }

        declaringType = Invariant.Required(declaringType, "a base-class property has a declaring type");
        if (!prop.HasGetter)
        {
            Diagnostics.ReportCannotAssign(member.IdentifierToken.Location, memberName);
            return new BoundErrorExpression(null);
        }

        // Issue #950 / #2044: enforce `protected`/`private` property access
        // against the declaring type.
        if (!AccessibilityChecker.IsAccessible(prop.GetterAccessibility, declaringType, this.function))
        {
            Diagnostics.ReportMemberInaccessible(member.IdentifierToken.Location, prop.Name, declaringType.Name, prop.GetterAccessibility);
        }

        if (function?.ThisParameter is not { } thisParameter)
        {
            return new BoundErrorExpression(null);
        }

        var receiver = new BoundVariableExpression(null, thisParameter);

        // Issue #1347: an auto-property has no getter FunctionSymbol — its
        // getter is a compiler-synthesized backing-field read. Route the base
        // access through the property so the emitter resolves the synthesized
        // `get_Prop` MethodDef and the interpreter reads the backing field,
        // rather than mis-binding the read as a write (GS0127).
        if (prop.GetterSymbol == null)
        {
            return new BoundBaseClassCallExpression(
                member,
                receiver,
                declaringType,
                method: null,
                ImmutableArray<BoundExpression>.Empty,
                prop.Type,
                property: prop,
                isSetterAccessor: false);
        }

        return new BoundBaseClassCallExpression(
            member,
            receiver,
            declaringType,
            prop.GetterSymbol,
            ImmutableArray<BoundExpression>.Empty,
            prop.Type);
    }

    /// <summary>
    /// Issue #1104: binds a base-class property WRITE of the form
    /// <c>base.Prop = value</c>. Resolves <c>Prop</c> on the nearest base
    /// class's property set (walking grandparents) and wraps the property's
    /// setter accessor in a <see cref="BoundBaseClassCallExpression"/> so the
    /// emitter produces a non-virtual
    /// <c>call instance void BaseClass::set_Prop(value)</c>.
    /// </summary>
    /// <param name="memberName">The property name.</param>
    /// <param name="memberLocation">The location of the property name token.</param>
    /// <param name="baseLocation">The location of the <c>base</c> token for context diagnostics.</param>
    /// <param name="value">The already-bound right-hand value expression.</param>
    /// <param name="valueLocation">The location of the value expression (for conversion diagnostics).</param>
    /// <param name="equalsLocation">The location of the <c>=</c> token (for GS cannot-assign).</param>
    /// <param name="explicitBaseType">The class named in <c>base[BaseClass]</c>, or <see langword="null"/> for the plain <c>base.Prop</c> form.</param>
    /// <param name="selectorLocation">The location of the bracketed selector (for GS0385); use <paramref name="baseLocation"/> for the plain form.</param>
    /// <returns>The bound base-class property write, or a bound error on failure.</returns>
    private BoundExpression BindBaseClassPropertyWrite(
        string memberName,
        TextLocation memberLocation,
        TextLocation baseLocation,
        BoundExpression value,
        TextLocation valueLocation,
        TextLocation equalsLocation,
        StructSymbol? explicitBaseType,
        TextLocation selectorLocation)
    {
        if (!TryResolveBaseSearchType(baseLocation, explicitBaseType, selectorLocation, out var searchBase, out var clrBaseFallback))
        {
            return new BoundErrorExpression(null);
        }

        if (searchBase == null || !TypeMemberModel.TryGetProperty(searchBase, memberName, out var prop, out var declaringType))
        {
            // Issue #1260: no GSharp base declares the property — fall back to the
            // imported/BCL base type so `base.Prop = value` writes the inherited
            // member non-virtually.
            if (TryBindBaseClrPropertyWrite(memberName, memberLocation, value, valueLocation, equalsLocation, clrBaseFallback, out var bclWrite))
            {
                return bclWrite;
            }

            Diagnostics.ReportBaseClassCallMemberNotFound(memberLocation, searchBase?.Name ?? ClrTypeDisplayName(clrBaseFallback), memberName);
            return new BoundErrorExpression(null);
        }

        declaringType = Invariant.Required(declaringType, "a base-class property has a declaring type");
        if (!prop.HasSetter)
        {
            Diagnostics.ReportCannotAssign(equalsLocation, memberName);
            return new BoundErrorExpression(null);
        }

        // Issue #950 / #2044: enforce `protected`/`private` property
        // assignment against the declaring type.
        if (!AccessibilityChecker.IsAccessible(prop.SetterAccessibility, declaringType, this.function))
        {
            Diagnostics.ReportMemberInaccessible(memberLocation, prop.Name, declaringType.Name, prop.SetterAccessibility);
        }

        var converted = conversions.BindConversion(valueLocation, value, prop.Type);
        if (function?.ThisParameter is not { } thisParameter)
        {
            return new BoundErrorExpression(null);
        }

        var receiver = new BoundVariableExpression(null, thisParameter);

        // Issue #1347: an auto-property has no setter FunctionSymbol — its
        // setter is a compiler-synthesized backing-field write. Route the base
        // assignment through the property so the emitter resolves the
        // synthesized `set_Prop` MethodDef and the interpreter writes the
        // backing field.
        if (prop.SetterSymbol == null)
        {
            return new BoundBaseClassCallExpression(
                value.Syntax,
                receiver,
                declaringType,
                method: null,
                ImmutableArray.Create(converted),
                TypeSymbol.Void,
                property: prop,
                isSetterAccessor: true);
        }

        return new BoundBaseClassCallExpression(
            value.Syntax,
            receiver,
            declaringType,
            prop.SetterSymbol,
            ImmutableArray.Create(converted));
    }

    /// <summary>
    /// Issue #1260: binds a <c>base.Prop</c> READ into an imported/BCL base
    /// class. Resolves the inherited CLR property's getter and wraps it in a
    /// non-virtual <see cref="BoundImportedInstanceCallExpression"/> so the
    /// emitter produces <c>call instance R BaseClass::get_Prop()</c> — exactly
    /// like C# <c>base.Prop</c>. An <c>abstract</c> getter (no implementation)
    /// is reported as GS0413.
    /// </summary>
    /// <param name="member">The member-name syntax (<c>Prop</c>).</param>
    /// <param name="clrBase">The CLR base type to resolve the inherited property against.</param>
    /// <param name="result">The bound non-virtual property read (or an error node) when handled.</param>
    /// <returns><see langword="true"/> when a readable inherited property was found (or a precise diagnostic was reported).</returns>
    private bool TryBindBaseClrPropertyRead(
        NameExpressionSyntax member,
        System.Type? clrBase,
        [NotNullWhen(true)] out BoundExpression? result)
    {
        result = null;
        if (clrBase == null)
        {
            return false;
        }

        var memberName = member.IdentifierToken.Text;
        var clrProp = ClrTypeUtilities.SafeGetProperty(clrBase, memberName, BindingFlags.Public | BindingFlags.Instance);
        if (clrProp == null || clrProp.GetIndexParameters().Length != 0 || !clrProp.CanRead)
        {
            return false;
        }

        var getter = clrProp.GetGetMethod(nonPublic: false);
        if (getter == null)
        {
            return false;
        }

        if (getter.IsAbstract)
        {
            Diagnostics.ReportBaseClassCallAbstractMember(member.IdentifierToken.Location, clrProp.DeclaringType?.Name ?? clrBase.Name, memberName);
            result = new BoundErrorExpression(null);
            return true;
        }

        if (function?.ThisParameter is not { } thisParameter)
        {
            return false;
        }

        var receiver = new BoundVariableExpression(null, thisParameter);
        result = new BoundImportedInstanceCallExpression(
            member,
            receiver,
            getter,
            TypeSymbol.FromClrType(clrProp.PropertyType),
            ImmutableArray<BoundExpression>.Empty,
            isNonVirtualBaseCall: true);
        return true;
    }

    /// <summary>
    /// Issue #1260: binds a <c>base.Prop = value</c> WRITE into an imported/BCL
    /// base class. Resolves the inherited CLR property's setter and wraps it in a
    /// non-virtual <see cref="BoundImportedInstanceCallExpression"/> so the
    /// emitter produces <c>call instance void BaseClass::set_Prop(value)</c>.
    /// An <c>abstract</c> setter (no implementation) is reported as GS0413.
    /// </summary>
    /// <param name="memberName">The property name.</param>
    /// <param name="memberLocation">The location of the property name token.</param>
    /// <param name="value">The already-bound right-hand value expression.</param>
    /// <param name="valueLocation">The location of the value expression (for conversion diagnostics).</param>
    /// <param name="equalsLocation">The location of the <c>=</c> token (for GS cannot-assign).</param>
    /// <param name="clrBase">The CLR base type to resolve the inherited property against.</param>
    /// <param name="result">The bound non-virtual property write (or an error node) when handled.</param>
    /// <returns><see langword="true"/> when a writable inherited property was found (or a precise diagnostic was reported).</returns>
    private bool TryBindBaseClrPropertyWrite(
        string memberName,
        TextLocation memberLocation,
        BoundExpression value,
        TextLocation valueLocation,
        TextLocation equalsLocation,
        System.Type? clrBase,
        [NotNullWhen(true)] out BoundExpression? result)
    {
        result = null;
        if (clrBase == null)
        {
            return false;
        }

        var clrProp = ClrTypeUtilities.SafeGetProperty(clrBase, memberName, BindingFlags.Public | BindingFlags.Instance);
        if (clrProp == null || clrProp.GetIndexParameters().Length != 0)
        {
            return false;
        }

        if (!clrProp.CanWrite)
        {
            Diagnostics.ReportCannotAssign(equalsLocation, memberName);
            result = new BoundErrorExpression(null);
            return true;
        }

        var setter = clrProp.GetSetMethod(nonPublic: false);
        if (setter == null)
        {
            Diagnostics.ReportCannotAssign(equalsLocation, memberName);
            result = new BoundErrorExpression(null);
            return true;
        }

        if (setter.IsAbstract)
        {
            Diagnostics.ReportBaseClassCallAbstractMember(memberLocation, clrProp.DeclaringType?.Name ?? clrBase.Name, memberName);
            result = new BoundErrorExpression(null);
            return true;
        }

        var converted = conversions.BindConversion(valueLocation, value, TypeSymbol.FromClrType(clrProp.PropertyType));
        if (function?.ThisParameter is not { } thisParameter)
        {
            return false;
        }

        var receiver = new BoundVariableExpression(null, thisParameter);
        result = new BoundImportedInstanceCallExpression(
            value.Syntax,
            receiver,
            setter,
            TypeSymbol.Void,
            ImmutableArray.Create(converted),
            isNonVirtualBaseCall: true);
        return true;
    }

    /// <summary>
    /// Issue #986: returns true when <paramref name="candidate"/> is a base
    /// class of <paramref name="derived"/> (compared by definition identity to
    /// allow constructed generics).
    /// </summary>
    private static bool IsBaseClassOf(StructSymbol derived, StructSymbol candidate)
    {
        var candidateDef = candidate.Definition ?? candidate;
        var current = derived.BaseClass;
        while (current != null)
        {
            var currentDef = current.Definition ?? current;
            if (ReferenceEquals(currentDef, candidateDef) || ReferenceEquals(current, candidate))
            {
                return true;
            }

            current = current.BaseClass;
        }

        return false;
    }

    /// <summary>
    /// Issue #943 / #3394: binds an instance call dispatched through a type
    /// parameter's imported CLR interface or base-class constraint (for example,
    /// <c>a.CompareTo(b)</c> with <c>T : IComparable[T]</c>, or
    /// <c>m.GetParameters()</c> with <c>T : MethodBase</c>). The method is
    /// resolved against the constraint's CLR type; the resulting
    /// <see cref="BoundImportedInstanceCallExpression"/> carries the constrained
    /// type parameter and the symbolic interface type so the emitter produces a
    /// verifiable <c>constrained. !!T  callvirt</c> sequence with the
    /// <c>MemberRef</c> parented at the constructed interface
    /// (<c>IComparable`1&lt;!!T&gt;::CompareTo(!0)</c>).
    /// </summary>
    /// <param name="receiver">The bound receiver (its type is the constrained type parameter).</param>
    /// <param name="tp">The receiver's type parameter, carrying the CLR constraint.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="arguments">The bound argument expressions.</param>
    /// <param name="ce">The originating call-expression syntax.</param>
    /// <param name="argumentNames">Optional named-argument labels in source order.</param>
    /// <param name="result">The bound constrained call on success.</param>
    /// <returns><see langword="true"/> when a matching constrained method was found and bound.</returns>
    private bool TryBindConstrainedClrCall(
        BoundExpression receiver,
        TypeParameterSymbol tp,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames,
        [NotNullWhen(true)] out BoundExpression? result)
    {
        result = null;
        var constraintType = tp.ClrInterfaceConstraint ?? tp.ClassConstraint;
        var clrType = constraintType?.ClrType;
        if (constraintType == null || clrType == null)
        {
            return false;
        }

        var candidates = new List<MethodInfo>(MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(clrType, methodName));
        if (candidates.Count == 0)
        {
            return false;
        }

        var argTypes = new Type?[arguments.Length];
        for (var i = 0; i < arguments.Length; i++)
        {
            var t = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type);
            if (t == null && arguments[i].Type != TypeSymbol.Null)
            {
                // Issue #2347: defer an unresolved method-group argument (see
                // TryBindImportedExtensionCall) instead of failing outright.
                if (!ClrOverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]))
                {
                    return false;
                }
            }

            argTypes[i] = t;
        }

        // Issue #1852 (follow-up from #1812 N1): mark which positional
        // arguments are interpolated-string literals so overload resolution
        // treats them as applicable to an IFormattable/FormattableString (or
        // handler) parameter, just like every other CLR-call Resolve site.
        var interpolatedStringArgs = ComputeInterpolatedStringArgFlags(ce.Arguments, arguments.Length);
        var resolution = ClrOverloadResolution.Resolve(
            candidates,
            argTypes,
            null,
            scope.References.MapClrTypeToReferences,
            interpolatedStringArgs,
            argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames,
            constantNarrowingArgumentCheck: MakeConstantNarrowingArgumentCheck(arguments),
            structuralProjectionArgumentCheck: MakeStructuralProjectionArgumentCheck(arguments),
            delegateRefKindArgumentCheck: MakeDelegateRefKindArgumentCheck(arguments),
            methodGroupInference: MakeMethodGroupInference(arguments, GetEffectiveArgumentClrTypeForOverloadResolution),
            methodGroupArgumentCheck: MakeMethodGroupArgumentCheck(arguments));
        if (resolution.Outcome != ClrOverloadResolution.ResolutionOutcome.Resolved)
        {
            return false;
        }

        if (resolution.Best is not { } method)
        {
            return false;
        }

        var parameters = method.GetParameters();

        // Return type: a return that names the constraint type-variable is
        // recovered by projecting through the constructed constraint;
        // a concrete return (e.g. IComparable.CompareTo -> int32) falls back to
        // the direct CLR mapping.
        var returnType = MemberLookup.GetClrMethodReturnTypeSymbol(constraintType, method);
        var declaringConstraint = MemberLookup.GetClrMemberDeclaringTypeSymbol(
            constraintType,
            method);

        // Issue #1852: re-lower each interpolated-string argument whose
        // resolved parameter is IFormattable/FormattableString-shaped to
        // FormattableStringFactory.Create(...) — mirroring
        // RebindFormattableInterpolationArguments, the same step every other
        // CLR-call path runs — WITHOUT routing through the rest of
        // BuildResolvedClrCallArguments (ApplyInterpolatedStringHandlers,
        // delegate rebind, BindClrParameterConversions). This path
        // deliberately skips the CLR boxing/conversion pass below (see the
        // "deliberately skip" comment on orderedArgs): the emitted MemberRef
        // parameter is the interface type-variable `!0`, passed unconverted,
        // so routing every argument through the conversion pipeline would
        // risk an ilverify mismatch. Only the specific interpolated-string
        // arguments actually bound to a handler parameter are touched; every
        // other argument (and the overload choice itself, unaffected unless a
        // candidate's applicability actually depended on the flag) is
        // unchanged.
        arguments = RebindFormattableInterpolationArguments(arguments, ce.Arguments, parameters, resolution.ParameterMapping);

        // Order positionally for named arguments; deliberately skip the CLR
        // boxing/conversion pass — the emitted MemberRef parameter is the
        // interface type-variable `!0` (== the reified `!!T`), so a `T`-typed
        // argument must be passed unboxed.
        var orderedArgs = OverloadResolver.BuildOrderedCallArguments(arguments, resolution.ParameterMapping, parameters);
        var refKinds = ComputeArgumentRefKinds(parameters);

        result = new BoundImportedInstanceCallExpression(
            ce,
            receiver,
            method,
            returnType,
            orderedArgs,
            refKinds,
            default,
            constrainedReceiverTypeParameter: tp,
            constrainedInterfaceType: declaringConstraint);
        return true;
    }

    /// <summary>
    /// Issue #1550: binds a call to a universal <see cref="object"/> instance
    /// member (<c>ToString</c>, <c>GetHashCode</c>, <c>Equals(object)</c>,
    /// <c>GetType</c>) dispatched through ANY type-parameter receiver, even one
    /// without a matching user/CLR constraint. The method is resolved against
    /// <c>typeof(object)</c>; the resulting
    /// <see cref="BoundImportedInstanceCallExpression"/> carries the constrained
    /// type parameter (and a <see langword="null"/> constrained interface type,
    /// so the emitted <c>MemberRef</c> is parented at <c>System.Object</c>) so
    /// the emitter produces a verifiable
    /// <c>constrained. !!T  callvirt System.Object::Method(...)</c> sequence.
    /// The <c>constrained.</c> prefix dispatches to any override for value,
    /// struct/enum-constrained and reference type parameters alike without a
    /// manual box.
    /// </summary>
    /// <param name="receiver">The bound receiver (its type is the constrained type parameter).</param>
    /// <param name="tp">The receiver's type parameter.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="arguments">The bound argument expressions.</param>
    /// <param name="ce">The originating call-expression syntax.</param>
    /// <param name="argumentNames">Optional named-argument labels in source order.</param>
    /// <param name="result">The bound constrained call on success.</param>
    /// <returns><see langword="true"/> when a matching object member was found and bound.</returns>
    private bool TryBindConstrainedObjectMemberCall(
        BoundExpression receiver,
        TypeParameterSymbol tp,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames,
        [NotNullWhen(true)] out BoundExpression? result)
    {
        result = null;

        var candidates = new List<MethodInfo>(MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(object), methodName));
        if (candidates.Count == 0)
        {
            return false;
        }

        var argTypes = new Type?[arguments.Length];
        for (var i = 0; i < arguments.Length; i++)
        {
            var t = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type);
            if (t == null && arguments[i].Type != TypeSymbol.Null)
            {
                // Issue #2347: defer an unresolved method-group argument (see
                // TryBindImportedExtensionCall) instead of failing outright.
                if (!ClrOverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]))
                {
                    return false;
                }
            }

            argTypes[i] = t;
        }

        // Issue #1812: `interpolatedStringArgs` is deliberately left null here.
        // Candidates are drawn only from `typeof(object)`'s public instance
        // methods (ToString, Equals(object), GetHashCode, GetType) — none
        // declares an IFormattable/FormattableString/handler parameter, so an
        // interpolated-string argument could never take the Tier-4
        // (ADR-0055) conversion path against any candidate here regardless of
        // the flag. Unlike TryBindConstrainedClrCall above, this path
        // does run the full CLR parameter-conversion pass afterward, but that
        // fact is irrelevant given no candidate parameter shape could match.
        // Constant-narrowing is intentionally omitted for the same reason:
        // object members expose only zero parameters or Equals(object), never a
        // narrower integer parameter.
        var resolution = ClrOverloadResolution.Resolve(
            candidates,
            argTypes,
            null,
            scope.References.MapClrTypeToReferences,
            null,
            argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames);
        if (resolution.Outcome != ClrOverloadResolution.ResolutionOutcome.Resolved)
        {
            return false;
        }

        if (resolution.Best is not { } method)
        {
            return false;
        }

        var parameters = method.GetParameters();

        // A concrete object member has a concrete return type (string / int32 /
        // bool / System.Type). Resolve it nullable-obliviously: the receiver is
        // an erased type parameter (ADR-0004 / #313), so the BCL's `string?`
        // annotation on `object.ToString()` must not leak a spurious nullable
        // return into the generic context (which would reject the common
        // `func Show[T struct]() string -> v.ToString()` shape with GS0156).
        var returnType = TypeSymbol.FromClrType(method.ReturnType);

        // Unlike the CLR-interface path, the parameter of a matched object
        // member (e.g. Equals(object)) is a real System.Object, so a `T`-typed
        // argument must be boxed. Run the normal CLR conversion pass so the
        // emitter widens (boxes) the `!!T` value to object.
        var mapping = resolution.ParameterMapping;
        var convertedArgs = conversions.BindClrParameterConversions(arguments, parameters, ce, mapping, method: method, receiverType: receiver.Type);
        var orderedArgs = OverloadResolver.BuildOrderedCallArguments(convertedArgs, mapping, parameters);
        var refKinds = ComputeArgumentRefKinds(parameters);

        result = new BoundImportedInstanceCallExpression(
            ce,
            receiver,
            method,
            returnType,
            orderedArgs,
            refKinds,
            default,
            constrainedReceiverTypeParameter: tp,
            constrainedInterfaceType: null);
        return true;
    }

    /// <summary>
    /// Issue #2304: binds a call to a universal <see cref="object"/> instance
    /// member (<c>ToString</c>, <c>GetHashCode</c>, <c>Equals(object)</c>,
    /// <c>GetType</c>) dispatched through an INTERFACE-typed receiver — either
    /// a source-declared <see cref="InterfaceSymbol"/> (whose <c>ClrType</c> is
    /// still <see langword="null"/> at bind time) or an imported interface
    /// (an <see cref="ImportedTypeSymbol"/> whose <c>ClrType.IsInterface</c> is
    /// <see langword="true"/>). Every interface implicitly derives from
    /// <see cref="object"/> at the CLR/C# layer for member-access purposes —
    /// <c>Type.GetMethods()</c> on an interface type never reports it, though,
    /// so the shared CLR-instance-method enumeration (which walks only an
    /// interface's own transitive base interfaces) never finds these names and
    /// the call otherwise dead-ends at <c>GS0159</c>.
    /// </summary>
    /// <remarks>
    /// Unlike <see cref="TryBindConstrainedObjectMemberCall"/> (used for an
    /// erased type-parameter receiver), no <c>constrained.</c> prefix is
    /// needed here: an interface-typed receiver is ALWAYS a genuine managed
    /// reference at the CLR level (never an unboxed value), so a plain
    /// <c>callvirt System.Object::Method(...)</c> against that reference is
    /// already verifiable and dispatches to the runtime type's override.
    /// </remarks>
    /// <param name="receiver">The bound receiver (its static type is the interface).</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="arguments">The bound argument expressions.</param>
    /// <param name="ce">The originating call-expression syntax.</param>
    /// <param name="argumentNames">Optional named-argument labels in source order.</param>
    /// <param name="result">The bound call on success.</param>
    /// <returns><see langword="true"/> when a matching object member was found and bound.</returns>
    private bool TryBindInterfaceObjectMemberCall(
        BoundExpression receiver,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames,
        [NotNullWhen(true)] out BoundExpression? result)
    {
        result = null;

        var candidates = new List<MethodInfo>(MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(object), methodName));
        if (candidates.Count == 0)
        {
            return false;
        }

        var argTypes = new Type?[arguments.Length];
        for (var i = 0; i < arguments.Length; i++)
        {
            var t = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type);
            if (t == null && arguments[i].Type != TypeSymbol.Null)
            {
                // Issue #2347: defer an unresolved method-group argument (see
                // TryBindImportedExtensionCall) instead of failing outright.
                if (!ClrOverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]))
                {
                    return false;
                }
            }

            argTypes[i] = t;
        }

        // Constant-narrowing is intentionally omitted: the only object member
        // with an argument is Equals(object), so there is no narrower integer
        // parameter for §10.2.11 to target.
        var resolution = ClrOverloadResolution.Resolve(
            candidates,
            argTypes,
            null,
            scope.References.MapClrTypeToReferences,
            null,
            argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames);
        if (resolution.Outcome != ClrOverloadResolution.ResolutionOutcome.Resolved)
        {
            return false;
        }

        if (resolution.Best is not { } method)
        {
            return false;
        }

        var parameters = method.GetParameters();
        var returnType = TypeSymbol.FromClrType(method.ReturnType);

        var mapping = resolution.ParameterMapping;
        var convertedArgs = conversions.BindClrParameterConversions(arguments, parameters, ce, mapping, method: method, receiverType: receiver.Type);
        var orderedArgs = OverloadResolver.BuildOrderedCallArguments(convertedArgs, mapping, parameters);
        var refKinds = ComputeArgumentRefKinds(parameters);

        result = new BoundImportedInstanceCallExpression(
            ce,
            receiver,
            method,
            returnType,
            orderedArgs,
            refKinds,
            default,
            constrainedReceiverTypeParameter: null,
            constrainedInterfaceType: null);
        return true;
    }
}
