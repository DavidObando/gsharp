// <copyright file="ExpressionBinder.Calls.Arguments.cs" company="GSharp">
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
import GSharp.Core.CodeAnalysis.Binding.Suspension
import GSharp.Core.CodeAnalysis.Emit
import System.Globalization

internal partial class ExpressionBinder {
    /// Issue #2193: returns `true` when a user-defined extension
    /// function for the `(receiver, name)` pair declares a function-typed
    /// (arrow / delegate) parameter at the given user-argument position. The
    /// extension's synthetic receiver occupies `Parameters[0]`, so user
    /// argument [`argSlot`](paramref) aligns with `Parameters[argSlot + 1]`.
    /// Used to suppress CLR-derived lambda target-typing that would otherwise
    /// erase the lambda's return type and break the extension's type-argument
    /// inference.
    private func UserExtensionHasFunctionTypedParameterAt(
        receiver BoundExpression?,
        methodName string,
        argSlot int32
    ) bool {
        if receiver?.Type == nil {
            return false
        }
        let extCandidates = $scope.TryLookupExtensionFunctions(receiver!!.Type, methodName)
        if extCandidates.IsDefaultOrEmpty {
            return false
        }
        let paramIndex = argSlot + 1
        for candidate in extCandidates {
            if candidate != nil &&
                paramIndex < candidate
                .Parameters
                .Length &&
                candidate
                .Parameters[paramIndex]
                .Type is FunctionTypeSymbol {
                return true
            }
        }
        return false
    }

    /// Issue #2193: overload-resolution tie-break that merges the user-defined
    /// extension-function candidate set for `(receiver type, name)` into a
    /// resolved CLR/imported instance-method call and prefers the extension when
    /// it is a strictly better match.
    ///
    /// The defect: a same-named BCL instance method can be <em>applicable</em> to
    /// a call only through a lossy delegate-reshaping conversion — e.g. a G#
    /// function value `(T) -> TResult` discarding its result to satisfy the
    /// named void delegate parameter of
    /// `SynchronizationContext.Send(SendOrPostCallback, object)`. Because the
    /// CLR-instance path commits as soon as it resolves, the user extension
    /// `Send[T, TResult]((T) -> TResult, T) TResult` — an exact match — never
    /// competed, so the call bound to the `void` member (GS0124 / GS0151).
    ///
    /// The fix is deliberately conservative so it does not disturb normal
    /// instance-method resolution: the extension is only preferred when (a) the
    /// resolved instance method's <em>worst</em> argument conversion is a
    /// delegate-reshaping conversion (rank ≥
    /// (cref:ClrOverloadResolution.ImplicitConversionKind.LambdaToVoidDelegate)),
    /// and (b) some applicable user extension matches the same arguments with a
    /// strictly better worst-case conversion. An instance method that matches by
    /// identity / standard implicit conversion always wins, so a genuine member
    /// that is the better match is never shadowed.
    private func TryPreferBetterExtensionOverClrInstanceMethod(
        receiver BoundExpression?,
        methodName string,
        clrBest MethodInfo?,
        argTypes[]?Type?,
        arguments ImmutableArray[BoundExpression],
        ce CallExpressionSyntax,
        argumentNames ImmutableArray[string],
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        if receiver?.Type == nil || clrBest == nil || argTypes == nil {
            return false
        }
        let extCandidates = $scope.TryLookupExtensionFunctions(receiver!!.Type, methodName)
        if extCandidates.IsDefaultOrEmpty {
            return false
        }
        // Only intervene when the CLR instance method is applicable solely via a
        // lossy delegate-reshaping conversion; a good (identity/standard implicit)
        // instance match is never overridden.
        let clrWorst = ComputeClrCandidateWorstConversionRank(clrBest, argTypes)
        if !IsDelegateReshapingConversion(clrWorst) {
            return false
        }
        // The extension must be a strictly better match than the instance method.
        let extWorst = ComputeBestApplicableExtensionWorstConversionRank(extCandidates, argTypes)
        if extWorst == ClrOverloadResolution.ImplicitConversionKind.None || int32(extWorst) >= int32(clrWorst) {
            return false
        }
        if TryBindExtensionFunctionOverload(receiver, methodName, arguments, ce, argumentNames, out var extResult) &&
            !(extResult is BoundErrorExpression) {
            result = extResult
            return true
        }
        return false
    }

    /// Issue #2193: across every user extension overload for the
    /// `(receiver, name)` pair, computes each applicable overload's worst
    /// argument-conversion rank (using the same CLR-type projection that produced
    /// [`argTypes`](paramref)) and returns the <em>best</em> (lowest-ordinal)
    /// worst-rank. The extension's synthetic receiver slot lives in
    /// `Parameters[0]`, so user arguments align against `Parameters[1..]`.
    /// Returns (cref:ClrOverloadResolution.ImplicitConversionKind.None) when
    /// no overload lines up positionally with the arguments.
    private func ComputeBestApplicableExtensionWorstConversionRank(
        extCandidates ImmutableArray[FunctionSymbol],
        argTypes[]Type?
    ) ClrOverloadResolution
        .ImplicitConversionKind {
        var best = ClrOverloadResolution.ImplicitConversionKind.None
        for candidate in extCandidates {
            if candidate == nil || candidate.Parameters.Length != argTypes.Length + 1 {
                continue
            }
            var worst = ClrOverloadResolution.ImplicitConversionKind.Identity
            var applicable = true
            for var i = 0; i < argTypes.Length; i++ {
                let paramClr = GetEffectiveArgumentClrTypeForOverloadResolution(candidate.Parameters[i + 1].Type)
                let kind = ClrOverloadResolution.ClassifyImplicit(paramClr, argTypes[i])
                if kind == ClrOverloadResolution.ImplicitConversionKind.None {
                    applicable = false
                    break
                }
                if int32(kind) > int32(worst) {
                    worst = kind
                }
            }
            if !applicable {
                continue
            }
            if best == ClrOverloadResolution.ImplicitConversionKind.None || int32(worst) < int32(best) {
                best = worst
            }
        }
        return best
    }

    /// Issue #1188: resolves an instance-syntax call `receiver.Method(args)`
    /// against the user-defined extension functions visible from the current
    /// scope, supporting overloading. Collects every extension overload matching
    /// the (receiver type, name) pair and selects the single best applicable one
    /// through the standard overload-resolution machinery before delegating to
    /// (cref:OverloadResolver.BindExtensionFunctionCall).
    /// @remarks Extension function symbols carry their receiver in `Parameters[0]` and
    /// never set (cref:FunctionSymbol.ExplicitReceiverParameter), so user
    /// arguments line up against `Parameters[1..]`. To reuse the existing
    /// instance-overload selector (which keys parameter alignment off
    /// `ExplicitReceiverParameter`) the receiver is prepended as the first
    /// positional argument; this makes the candidate's synthetic receiver slot
    /// participate in applicability/convertibility ranking and in generic receiver
    /// inference exactly as (cref:OverloadResolver.BindExtensionFunctionCall)
    /// does once a candidate is chosen.
    /// @param receiver The bound call receiver.
    /// @param methodName The invoked method name.
    /// @param arguments The bound user arguments (excluding the receiver).
    /// @param ce The originating call syntax.
    /// @param argumentNames The named-argument layout, or default.
    /// @param result The bound call, when an extension overload matched.
    /// @returns `true` when at least one extension overload matched the (receiver, name) pair.
    private func TryBindExtensionFunctionOverload(
        receiver BoundExpression?,
        methodName string,
        arguments ImmutableArray[BoundExpression],
        ce CallExpressionSyntax,
        argumentNames ImmutableArray[string],
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        if receiver == nil {
            return false
        }
        let candidates = $scope.TryLookupExtensionFunctions(receiver.Type, methodName)
        if candidates.IsDefaultOrEmpty {
            return false
        }
        var selected FunctionSymbol? = candidates[0]
        if candidates.Length > 1 {
            let allArguments = ImmutableArray.CreateBuilder[BoundExpression](arguments.Length + 1)
            allArguments.Add(receiver)
            allArguments.AddRange(arguments)
            var allNames = argumentNames
            if !argumentNames.IsDefault {
                let names = [argumentNames.Length + 1]string
                for var i = 0; i < argumentNames.Length; i++ {
                    names[i + 1] = argumentNames[i]
                }
                allNames = ImmutableArray.Create(names)
            }
            selected = overloads.SelectInstanceOverloadOrReport(
                candidates,
                allArguments.ToImmutable(),
                ce,
                methodName,
                allNames
            )
            if selected == nil {
                result = BoundErrorExpression(nil)
                return true
            }
        }
        result = overloads.BindExtensionFunctionCall(
            receiver,
            Invariant.Required(
                selected,
                "a non-empty extension candidate set selects a function",
                expression: "selected"
            ),
            arguments,
            ce,
            argumentNames
        )
        return true
    }

    /// Issues #527 and #3523 (G#-defined struct/class arm): when a member-style call
    /// `receiver.Member(args)` does not match a method on the user
    /// struct/class, fall back to a callable field or property. Delegate values
    /// lower to (cref:BoundIndirectCallExpression); raw function pointers
    /// lower to (cref:BoundFunctionPointerInvocationExpression).
    /// Returns `true` when a callable member matched (the
    /// resulting expression may be a (cref:BoundErrorExpression) if
    /// arity is wrong).
    ///
    /// ADR-0085 / issue #726: when a class-typed receiver does not have a
    /// matching instance method, look at the class's implemented interfaces
    /// (including bases) for a default-method (DIM) whose signature accepts
    /// the supplied arguments. Returns the selected interface method or
    /// `null` if there is no suitable candidate. Diamond conflicts are
    /// reported by `VerifyInterfaceImplementations`; this helper picks
    /// the first matching candidate so that diagnostics are not duplicated
    /// at every call site.
    ///
    /// ADR-0090 / issue #756: returns `true` when the current function
    /// being bound (the enclosing default-method body) belongs to the same
    /// interface declaration as [`ifaceDef`](paramref). Used at call
    /// sites that resolve through an interface receiver to decide whether
    /// the private-helper bucket is in scope.
    /// @param ifaceDef The interface generic definition (callers
    /// pass `InterfaceSymbol.Definition`) being targeted.
    /// @returns True when the enclosing function's owning interface is the
    /// same definition.
    private func IsInsideSameInterface(ifaceDef InterfaceSymbol?) bool {
        let current FunctionSymbol? = function
        if current == nil || ifaceDef == nil {
            return false
        }
        var ownerIface InterfaceSymbol? = nil
        if current.ReceiverType is InterfaceSymbol ri {
            ownerIface = ri
        } else if current.StaticOwnerType is InterfaceSymbol si {
            ownerIface = si
        }
        if ownerIface == nil {
            return false
        }
        let ownerDef = ownerIface.Definition ?? ownerIface
        return object.ReferenceEquals(ownerDef, ifaceDef)
    }

    private func TryFindDefaultInterfaceMethod(
        receiverClass StructSymbol,
        methodName string,
        arguments ImmutableArray[BoundExpression],
        ce CallExpressionSyntax,
        argumentNames ImmutableArray[string]
    ) FunctionSymbol? {
        for current in receiverClass.GetHierarchy() {
            for iface in current.Interfaces {
                if iface == nil {
                    continue
                }
                let candidates = TypeMemberModel.GetMethods(iface, methodName, MemberQuery.Instance(MemberKinds.Method))
                let defaultsOnly = ImmutableArray.CreateBuilder[FunctionSymbol]()
                for var i = 0; i < candidates.Length; i++ {
                    if InterfaceSymbol.HasDefaultBody(candidates[i]) {
                        defaultsOnly.Add(candidates[i])
                    }
                }
                if defaultsOnly.Count == 0 {
                    continue
                }
                let selected FunctionSymbol? = this.overloads.SelectInstanceOverloadOrReport(
                    defaultsOnly.ToImmutable(),
                    arguments,
                    ce,
                    methodName,
                    argumentNames
                )
                if selected != nil {
                    return selected
                }
            }
        }
        return nil
    }

    private func TryBindUserCallableMemberInvocation(
        receiver BoundExpression?,
        receiverType TypeSymbol,
        methodName string,
        arguments ImmutableArray[BoundExpression],
        ce CallExpressionSyntax,
        isStatic bool,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        let receiverStruct StructSymbol? = receiverType as StructSymbol
        let receiverInterface InterfaceSymbol? = receiverType as InterfaceSymbol
        var matchedField FieldSymbol? = nil
        var declaringType StructSymbol? = nil
        var declaringOwner TypeSymbol? = nil
        var effectiveInterfaceOwner InterfaceSymbol? = nil
        if isStatic && receiverStruct != nil {
            TypeMemberModel.TryGetStaticFieldIncludingInherited(
                receiverStruct,
                methodName,
                out matchedField,
                out declaringType
            )
            declaringOwner = declaringType
        } else if isStatic && receiverInterface != nil {
            let fieldOwner = receiverInterface.Definition ?? receiverInterface
            matchedField = fieldOwner.GetStaticField(methodName)
            if matchedField != nil {
                declaringOwner = fieldOwner
                effectiveInterfaceOwner = receiverInterface
            }
        } else if receiverStruct != nil {
            // Walk the base chain so an inherited callable field on a base class
            // is invokable on a derived instance.
            for current in receiverStruct.GetHierarchy() {
                if current.TryGetField(methodName, out var f) {
                    matchedField = f
                    declaringType = current
                    declaringOwner = current
                    break
                }
            }
        }
        var matchedProperty PropertySymbol? = nil
        if matchedField == nil {
            var property PropertySymbol? = nil
            var propertyDeclaringOwner TypeSymbol? = nil
            var foundProperty = false
            if isStatic {
                if receiverStruct != nil {
                    foundProperty = TypeMemberModel.TryGetStaticPropertyIncludingInherited(
                        receiverStruct,
                        methodName,
                        out property,
                        out var propertyDeclaringType
                    )
                    propertyDeclaringOwner = propertyDeclaringType
                } else if receiverInterface != nil {
                    let propertyOwner = receiverInterface.Definition ?? receiverInterface
                    property = propertyOwner.Properties.FirstOrDefault(
                        (candidate PropertySymbol) -> candidate.IsStatic &&
                            !candidate.IsIndexer &&
                            candidate.Name == methodName &&
                            candidate.HasGetter &&
                            candidate.GetterSymbol != nil
                    )
                    foundProperty = property != nil
                    propertyDeclaringOwner = propertyOwner
                }
            } else {
                foundProperty = TypeMemberModel.TryGetPropertyWithOwner(
                    receiverType,
                    methodName,
                    out property,
                    out propertyDeclaringOwner
                )
            }
            if foundProperty && (property != nil && property.HasGetter == true) {
                matchedProperty = property
                declaringOwner = propertyDeclaringOwner
                declaringType = propertyDeclaringOwner as StructSymbol
                effectiveInterfaceOwner = if isStatic && receiverInterface != nil {
                    receiverInterface
                } else {
                    propertyDeclaringOwner as InterfaceSymbol
                }
            }
        }
        let declaredMemberType TypeSymbol? = matchedField?.Type ?? matchedProperty?.Type
        if declaredMemberType == nil {
            return false
        }
        let memberType = if effectiveInterfaceOwner != nil {
            effectiveInterfaceOwner.SubstituteMemberType(declaredMemberType)
        } else {
            (
                if matchedField != nil && isStatic && declaringType != nil {
                    declaringType.SubstituteMemberType(declaredMemberType)!!
                } else {
                    declaredMemberType
                }
            )
        }
        let substitutedMemberType = if object.ReferenceEquals(memberType, declaredMemberType) {
            default(TypeSymbol?)
        } else {
            memberType
        }
        // Issue #2849: derive both argument conversions and Invoke shape from
        // the narrowed stable member read, not the nullable declaration.
        var memberLoad BoundExpression
        if matchedField != nil {
            memberLoad = if isStatic && receiverInterface != nil {
                BoundFieldAccessExpression(nil, matchedField, receiverInterface, substitutedMemberType)
            } else {
                BoundFieldAccessExpression(
                    nil,
                    receiver,
                    declaringType,
                    matchedField,
                    substitutedMemberType,
                    narrowedType: nil
                )
            }
        } else if matchedProperty != nil {
            if isStatic && receiverInterface != nil {
                memberLoad = BoundCallExpression(
                    nil,
                    Invariant.Required(
                        matchedProperty.GetterSymbol,
                        "a matched static interface property has a getter",
                        expression: "matchedProperty.GetterSymbol"
                    ),
                    ImmutableArray[BoundExpression].Empty,
                    memberType
                ){
                    StaticGenericInterfaceOwnerType = if receiverInterface.Definition != nil {
                        receiverInterface
                    } else {
                        default(InterfaceSymbol?)
                    }
                }
            } else {
                memberLoad = BoundPropertyAccessExpression(
                    nil,
                    receiver,
                    declaringType,
                    matchedProperty,
                    substitutedMemberType,
                    narrowedType: nil,
                    interfaceType: effectiveInterfaceOwner
                )
            }
        } else {
            return false
        }
        memberLoad = ApplyMemberNarrowing(memberLoad)
        let effectiveMemberType = switch memberLoad {
            case BoundFieldAccessExpression{NarrowedType: TypeSymbol narrowedField}: narrowedField
            case BoundPropertyAccessExpression{NarrowedType: TypeSymbol narrowedProperty}: narrowedProperty
            // Issue #4943: BuildNarrowedRead narrows a value-type nullable member
            // (`(unmanaged[CC] () -> R)?` is `Nullable<nint>`) by unwrapping it,
            // so the narrowed type is the unwrap's result type.
            case unwrap is BoundUnaryExpression when unwrap.Op.Kind == BoundUnaryOperatorKind.NullAssertion: unwrap.Type
            default: memberType
        }
        var callableType = if ce.NullableQuestionToken != nil &&
            effectiveMemberType is NullableTypeSymbol nullableMember {
            nullableMember.UnderlyingType
        } else {
            effectiveMemberType
        }
        let memberAccessibility = if matchedField != nil {
            matchedField.Accessibility
        } else {
            matchedProperty?.GetterAccessibility
        }
        if declaringOwner != nil && memberAccessibility is {} accessibility && !AccessibilityChecker.IsAccessible(
            accessibility,
            declaringOwner,
            function
        ) {
            Diagnostics.ReportMemberInaccessible(ce.Identifier.Location, methodName, declaringOwner.Name, accessibility)
        }
        if ce.NullableQuestionToken == nil &&
            ce.TypeArgumentList == nil &&
            effectiveMemberType is FunctionPointerTypeSymbol functionPointerType {
            if !overloads.TryAnalyzeCallArgumentLayout(ce.Arguments, out _, out var argumentNames) {
                result = BoundErrorExpression(nil)
                return true
            }
            result = overloads.BindFunctionPointerInvocation(
                ce,
                memberLoad,
                functionPointerType,
                methodName,
                ce.Identifier.Location,
                arguments,
                argumentNames
            )
            return true
        }
        if ce.NullableQuestionToken == nil && overloads.TryReportNullableDelegateReceiver(
            effectiveMemberType,
            ce.Identifier.Location,
            methodName,
            nullSafeInvocation: "?(...)"
        ) {
            result = BoundErrorExpression(nil)
            return true
        }
        if !MemberLookup.TryGetDelegateFunctionTypeFromSymbol(callableType, out var functionType) {
            // Issue #3880: ADR-0020 commits `X.Member[i](args)` to a GENERIC
            // call site — a single bracketed simple name scans as a type clause
            // and `(` is in the follow-set — and indexer-then-invoke was never
            // reconsidered afterwards. A dictionary of factories
            // (`GNodeSamples.All[type]()`) therefore reported GS0158 on the
            // member, while the identical `let f = GNodeSamples.All[type]`
            // followed by `f()` bound fine: the `.` follow-set already got this
            // treatment for the single-argument shape in issue #942, the `(`
            // follow-set did not. The parser cannot decide this — `Map[int](xs)`
            // is a real generic instantiation with the same token shape — so
            // the binder decides it, and only where the generic reading has
            // already failed: the member is not itself callable.
            //
            // The indexed value REPLACES the callable and falls through, so
            // everything below — named-delegate ref kinds, variadic packing,
            // optional and named arguments — applies to it unchanged. An
            // earlier revision converted the arguments here instead, which
            // implemented only fixed-arity by-value shapes and rejected
            // `b.Named[k](",", "a", "b", "c")` against a variadic named
            // delegate.
            if !TryBindAmbiguousBracketAsIndex(ce, memberLoad, out var indexedValue) ||
                indexedValue!!.Type is not{} indexedType ||
                !MemberLookup.TryGetDelegateFunctionTypeFromSymbol(indexedType, out functionType) {
                return false
            }
            memberLoad = indexedValue!!
            callableType = indexedType
        }
        if !(callableType is FunctionTypeSymbol) &&
            callableType.ClrType is {} importedDelegateClr &&
            ClrTypeUtilities
            .IsDelegateType(importedDelegateClr) {
            result = BuildDelegateMemberInvocation(ce, memberLoad, callableType, functionType!!, arguments)
            return true
        }
        if callableType is DelegateTypeSymbol namedDelegate {
            if !overloads.TryBindNamedDelegateArguments(
                methodName,
                namedDelegate,
                ce,
                arguments,
                out var namedArguments,
                out var namedRefKinds
            ) {
                result = BoundErrorExpression(nil)
                return true
            }
            result = BuildDelegateMemberInvocation(
                ce,
                memberLoad,
                callableType,
                functionType!!,
                namedArguments,
                namedRefKinds
            )
            return true
        }
        // ADR-0102 follow-up / issue #818: when the field's declared
        // function type spells a trailing variadic parameter, pack /
        // pass-through trailing args at the call site.
        let fldIsVariadic = functionType!!.HasVariadic
        let fldFixedCount = if fldIsVariadic {
            functionType!!.ParameterTypes.Length - 1
        } else {
            functionType!!.ParameterTypes.Length
        }
        if fldIsVariadic {
            if arguments.Length < fldFixedCount {
                Diagnostics.ReportTooFewArgumentsForVariadic(ce.Location, methodName, fldFixedCount, arguments.Length)
                result = BoundErrorExpression(nil)
                return true
            }
        } else if arguments.Length != functionType!!.ParameterTypes.Length {
            Diagnostics.ReportWrongArgumentCount(
                ce.Location,
                methodName,
                functionType!!.ParameterTypes.Length,
                arguments.Length
            )
            result = BoundErrorExpression(nil)
            return true
        }
        var permutedArgs = arguments
        if fldIsVariadic {
            let sliceType = functionType!!.ParameterTypes[functionType!!.ParameterTypes.Length - 1]
            var hasVariadicErrors = false
            // Issue #1823: route through the #1630 canonical helper so
            // trailing elements get the same per-element coercion applied
            // at every other variadic pack site (previously packed raw,
            // uncoerced elements here).
            let variadicArgumentLocation(int32) -> TextLocation = (i int32) -> if i < ce.Arguments.Count {
                ce.Arguments[i].Location
            } else {
                ce.Location
            }
            permutedArgs = OverloadResolver.PackOrPassThroughVariadicArguments(
                conversions,
                Diagnostics,
                ce,
                arguments,
                fldFixedCount,
                sliceType,
                methodName,
                variadicArgumentLocation,
                &hasVariadicErrors
            )
            if hasVariadicErrors {
                result = BoundErrorExpression(nil)
                return true
            }
        }
        let convertedArgs = ImmutableArray.CreateBuilder[BoundExpression](permutedArgs.Length)
        for var i = 0; i < permutedArgs.Length; i++ {
            let argLoc = if i < ce.Arguments.Count {
                ce.Arguments[i].Location
            } else {
                ce.Location
            }
            var argument = permutedArgs[i]
            if argument is BoundErrorExpression{Syntax: LambdaExpressionSyntax lambda} &&
                MemberLookup
                .TryGetLambdaTargetFunctionTypeFromSymbol(functionType!!.ParameterTypes[i], out var target) {
                argument = lambdas.BindLambdaExpression(lambda, target)
            }
            convertedArgs.Add(conversions.BindConversion(argLoc, argument, functionType!!.ParameterTypes[i]))
        }
        result = BuildDelegateMemberInvocation(
            ce,
            memberLoad,
            callableType,
            functionType!!,
            convertedArgs.MoveToImmutable()
        )
        return true
    }

    /// Issue #3880: the indexer-then-invoke reading of `X.Member[i](args)`,
    /// attempted only after the generic-method reading the parser committed to
    /// has already failed and the member itself turned out not to be callable.
    ///
    /// Deliberately narrow. The bracketed item must be a bare identifier — the
    /// only shape that is genuinely ambiguous, because anything a type clause
    /// can spell but an index expression cannot (`T?`, `[]T`,
    /// `List[T]`, a qualified name) is unambiguously a type argument, and
    /// anything an index expression can spell but a type clause cannot
    /// (`All[0]()`, `All["k"]()`) never reached the generic reading
    /// in the first place. The index bind is speculative: its diagnostics are
    /// rolled back on failure so a genuine "no such generic method" still
    /// reports the generic-reading diagnostic the caller would have produced.
    private func TryBindAmbiguousBracketAsIndex(
        ce CallExpressionSyntax,
        memberLoad BoundExpression,
        @NotNullWhen(true) out indexed BoundExpression?
    ) bool {
        indexed = nil
        if ce.NullableQuestionToken != nil ||
            !IsAmbiguousSingleIdentifierTypeArgument(ce.TypeArgumentList) ||
            Invariant
            .Required(
            ce.TypeArgumentList,
            "an ambiguous bracket has a type-argument list",
            expression: "ce.TypeArgumentList"
        )
            .Arguments[0]
            .Identifier is not{} indexIdentifier {
            return false
        }
        let mark = Diagnostics.Count
        let bound = BindIndexAgainstTarget(
            memberLoad,
            NameExpressionSyntax(ce.SyntaxTree, indexIdentifier),
            ce.Identifier.Location
        )
        if bound is BoundErrorExpression || Diagnostics.Count != mark || bound.Type == nil {
            Diagnostics.TruncateTo(mark)
            return false
        }
        indexed = bound
        return true
    }

    private func BuildDelegateMemberInvocation(
        syntax CallExpressionSyntax,
        delegateLoad BoundExpression,
        delegateType TypeSymbol,
        functionType FunctionTypeSymbol,
        arguments ImmutableArray[BoundExpression],
        argumentRefKinds ImmutableArray[RefKind] = default(ImmutableArray[RefKind])
    ) BoundExpression {
        let BindInvocation = func (receiver BoundExpression) BoundExpression {
            if !(delegateType is FunctionTypeSymbol) &&
                delegateType.ClrType is {} delegateClr &&
                ClrTypeUtilities
                .IsDelegateType(delegateClr) {
                if !overloads.TryAnalyzeCallArgumentLayout(syntax.Arguments, out _, out var argumentNames) {
                    return BoundErrorExpression(syntax)
                }
                if TryBindInheritedClrInstanceCall(
                    receiver,
                    delegateClr,
                    "Invoke",
                    arguments,
                    syntax,
                    out var importedCall,
                    argumentNames: argumentNames
                ) {
                    return importedCall!!
                }
                Diagnostics.ReportNotAFunction(syntax.Location, delegateType.Name)
                return BoundErrorExpression(syntax)
            }
            return BoundIndirectCallExpression(nil, receiver, functionType, arguments, argumentRefKinds)
        }
        if syntax.NullableQuestionToken == nil {
            // ADR-0186 §4: invoking a delegate-typed member VALUE is a
            // delegate invocation target like `f()` (see
            // PlatformCoercion.CheckDelegateInvocationTarget).
            return BindInvocation(
                PlatformCoercion.CheckDelegateInvocationTarget(delegateLoad, syntax.Identifier.Location)
            )
        }
        let captureName = "$$ncap_" + (binderCtx.NullConditionalCaptureCounter += 1).ToString(
            CultureInfo.InvariantCulture
        )
        let capture = LocalVariableSymbol(captureName, isReadOnly: true, type: delegateType)
        let invoke = BindInvocation(BoundVariableExpression(nil, capture))
        return BuildNullConditionalDelegateInvocation(syntax, delegateLoad, capture, invoke)
    }

    private func BuildNullConditionalDelegateInvocation(
        syntax CallExpressionSyntax,
        delegateLoad BoundExpression,
        capture LocalVariableSymbol,
        invoke BoundExpression
    ) BoundExpression {
        if object.ReferenceEquals(invoke.Type, TypeSymbol.Void) {
            return BoundNullConditionalAccessExpression(
                syntax,
                delegateLoad,
                capture,
                invoke,
                TypeSymbol.Void,
                resultSlot: nil
            )
        }
        let resultType = if invoke.Type is NullableTypeSymbol {
            invoke.Type
        } else {
            cast[TypeSymbol](NullableTypeSymbol.Get(invoke.Type))
        }
        var resultSlot LocalVariableSymbol? = nil
        if resultType is NullableTypeSymbol nullableResult && ReflectionMetadataEmitter.IsValueTypeSymbol(
            nullableResult.UnderlyingType
        ) {
            let resultSlotName = "$$nres_" + binderCtx.NullConditionalCaptureCounter.ToString(
                CultureInfo.InvariantCulture
            )
            resultSlot = LocalVariableSymbol(resultSlotName, isReadOnly: false, type: resultType)
        }
        return BoundNullConditionalAccessExpression(syntax, delegateLoad, capture, invoke, resultType, resultSlot)
    }

    /// Issue #527: when an accessor-style call `receiver.Member(args)`
    /// matches no method on the CLR receiver type, fall back to a public
    /// field or property of the same name whose type is a CLR delegate.
    /// Lowers to a load of the delegate value (`ldfld` / property getter)
    /// followed by an `Invoke(args)` call. Returns `true`
    /// when a delegate-typed member matched and the call was bound (the
    /// resulting expression may be a (cref:BoundErrorExpression) if
    /// argument resolution failed).
    private func TryBindClrDelegateMemberInvocation(
        receiver BoundExpression,
        clrType Type?,
        methodName string,
        arguments ImmutableArray[BoundExpression],
        ce CallExpressionSyntax,
        argumentNames ImmutableArray[string],
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        if clrType == nil {
            return false
        }
        // Prefer a property of the right name over a field — the same
        // precedence used by the read path in BindAccessorStep (properties
        // first, fields fallback). Indexer properties (those with parameters)
        // are not member-style invocable, so skip them.
        var member MemberInfo? = ClrTypeUtilities.SafeGetProperty(
            clrType,
            methodName,
            BindingFlags.Public | BindingFlags.Instance
        )
        if member is PropertyInfo prop && (prop.GetIndexParameters().Length != 0 || !prop.CanRead) {
            member = nil
        }
        member ??= ClrTypeUtilities.SafeGetField(clrType, methodName, BindingFlags.Public | BindingFlags.Instance)
        if member == nil {
            return false
        }
        var memberClrType Type? = switch member {
            case p is PropertyInfo: p.PropertyType
            case f is FieldInfo: f.FieldType
            default: default(Type?)
        }
        if memberClrType == nil {
            return false
        }
        let memberTypeSymbol = MemberLookup.GetClrMemberValueTypeSymbol(member)
        var delegateLoad = ApplyMemberNarrowing(
            BoundClrPropertyAccessExpression(nil, receiver, member, memberTypeSymbol)
        )
        if !ClrTypeUtilities.IsDelegateType(memberClrType) {
            // Issue #3880, the imported twin of the source-receiver recovery in
            // TryBindUserCallableMemberInvocation. `x.Callbacks[key]()` where
            // `Callbacks` is a CLR field/property of a referenced assembly is
            // the SAME parser ambiguity; binding it only for source-declared
            // receivers would make the feature depend on which assembly the
            // type happened to be compiled into. The indexed value replaces the
            // delegate load and falls through to the same `Invoke` dispatch
            // below, which already owns named arguments, ref/in/out and
            // variadic packing.
            if !TryBindAmbiguousBracketAsIndex(ce, delegateLoad, out var indexedValue) ||
                indexedValue!!
                .Type
                ?.ClrType is not{} indexedClrType ||
                !ClrTypeUtilities.IsDelegateType(indexedClrType) {
                return false
            }
            delegateLoad = indexedValue!!
            memberClrType = indexedClrType
        }
        let effectiveMemberType = delegateLoad.Type
        if ce.NullableQuestionToken == nil && overloads.TryReportNullableDelegateReceiver(
            effectiveMemberType,
            ce.Identifier.Location,
            methodName,
            nullSafeInvocation: "?(...)"
        ) {
            result = BoundErrorExpression(nil)
            return true
        }
        // The delegate value load — `ldfld` for a field, `call get_X` for a
        // property. The shared BoundClrPropertyAccessExpression node carries
        // either MemberInfo shape, and EmitClrPropertyAccess already handles
        // both (including the value-type-receiver `ldloca` step we need for
        // a CLR struct field).
        // Strip nullable annotation when dispatching through Invoke.
        let underlyingDelegateClr = memberClrType
        var capture LocalVariableSymbol? = nil
        // ADR-0186 §4: a nil oblivious delegate member is checked where it is
        // invoked (see PlatformCoercion.CheckDelegateInvocationTarget); the
        // `?(…)` form below replaces this receiver with its guarded capture.
        var invokeReceiver = PlatformCoercion.CheckDelegateInvocationTarget(delegateLoad, ce.Identifier.Location)
        if ce.NullableQuestionToken != nil {
            let captureType = if effectiveMemberType is NullableTypeSymbol nullableMember {
                nullableMember.UnderlyingType
            } else {
                effectiveMemberType
            }
            let captureName = "$$ncap_" + (binderCtx.NullConditionalCaptureCounter += 1).ToString(
                CultureInfo.InvariantCulture
            )
            capture = LocalVariableSymbol(captureName, isReadOnly: true, type: captureType)
            invokeReceiver = BoundVariableExpression(nil, capture)
        }
        // Reuse the same Invoke-overload-resolution path that the bare
        // delegate-variable call uses at #325 (BindCallExpression), so
        // generic delegate arguments, named arguments, and ref/in/out are
        // all handled uniformly.
        if TryBindInheritedClrInstanceCall(
            invokeReceiver,
            underlyingDelegateClr,
            "Invoke",
            arguments,
            ce,
            out var invokeCall,
            argumentNames: argumentNames
        ) {
            result = if capture == nil {
                invokeCall
            } else {
                BuildNullConditionalDelegateInvocation(ce, delegateLoad, capture, invokeCall!!)
            }
            return true
        }
        // No applicable Invoke overload — most likely an argument-count or
        // type mismatch. Report against the member name (not "Invoke") so the
        // diagnostic points to what the user wrote.
        let invoke = memberClrType.GetMethodSafe("Invoke")
        let expectedArity = invoke?.GetParameters().Length ?? 0
        if arguments.Length != expectedArity {
            Diagnostics.ReportWrongArgumentCount(ce.Location, methodName, expectedArity, arguments.Length)
        } else {
            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName)
        }
        result = BoundErrorExpression(nil)
        return true
    }

    /// Issue #3970: static counterpart to
    /// (cref:TryBindClrDelegateMemberInvocation). When a static call
    /// `Type.Member(args)` against an imported class matches no static
    /// method, fall back to a public static field or property of the same
    /// name whose type is a CLR delegate (e.g. `static let Cb Func[string]
    /// = ...` invoked as `Reg.Cb()`). Reuses
    /// (cref:ImportedClassSymbol.TryLookupMember) for the same
    /// property-then-field precedence the static member-read path already
    /// uses, then lowers to a load of the delegate value (with a null
    /// receiver) followed by an `Invoke(args)` dispatch. Returns
    /// `true` when a delegate-typed static member matched and
    /// the call was bound (the resulting expression may be a
    /// (cref:BoundErrorExpression) if argument resolution failed).
    private func TryBindClrStaticDelegateMemberInvocation(
        classSymbol ImportedClassSymbol,
        methodName string,
        arguments ImmutableArray[BoundExpression],
        ce CallExpressionSyntax,
        argumentNames ImmutableArray[string],
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        if !classSymbol.TryLookupMember(methodName, ne: nil, out var member) {
            return false
        }
        var memberClrType Type? = switch member {
            case p is PropertyInfo: p.PropertyType
            case f is FieldInfo: f.FieldType
            default: default(Type?)
        }
        if memberClrType == nil {
            return false
        }
        let memberTypeSymbol = MemberLookup.GetClrMemberValueTypeSymbol(member!!)
        var delegateLoad = ApplyMemberNarrowing(BoundClrPropertyAccessExpression(nil, nil, member!!, memberTypeSymbol))
        if !ClrTypeUtilities.IsDelegateType(memberClrType) {
            // Static imports have the same Member[index](args) ambiguity as
            // instance members; reuse their index recovery before Invoke.
            if !TryBindAmbiguousBracketAsIndex(ce, delegateLoad, out var indexedValue) ||
                indexedValue!!
                .Type
                ?.ClrType is not{} indexedClrType ||
                !ClrTypeUtilities.IsDelegateType(indexedClrType) {
                return false
            }
            delegateLoad = indexedValue!!
            memberClrType = indexedClrType
        }
        let effectiveMemberType = delegateLoad.Type
        if ce.NullableQuestionToken == nil && overloads.TryReportNullableDelegateReceiver(
            effectiveMemberType,
            ce.Identifier.Location,
            methodName,
            nullSafeInvocation: "?(...)"
        ) {
            result = BoundErrorExpression(nil)
            return true
        }
        let underlyingDelegateClr = memberClrType
        var capture LocalVariableSymbol? = nil
        // ADR-0186 §4: as for the instance member above.
        var invokeReceiver = PlatformCoercion.CheckDelegateInvocationTarget(delegateLoad, ce.Identifier.Location)
        if ce.NullableQuestionToken != nil {
            let captureType = if effectiveMemberType is NullableTypeSymbol nullableMember {
                nullableMember.UnderlyingType
            } else {
                effectiveMemberType
            }
            let captureName = "$$ncap_" + (binderCtx.NullConditionalCaptureCounter += 1).ToString(
                CultureInfo.InvariantCulture
            )
            capture = LocalVariableSymbol(captureName, isReadOnly: true, type: captureType)
            invokeReceiver = BoundVariableExpression(nil, capture)
        }
        // Reuse the same Invoke-overload-resolution path the instance
        // delegate-member call and the bare delegate-variable call share.
        if TryBindInheritedClrInstanceCall(
            invokeReceiver,
            underlyingDelegateClr,
            "Invoke",
            arguments,
            ce,
            out var invokeCall,
            argumentNames: argumentNames
        ) {
            result = if capture == nil {
                invokeCall
            } else {
                BuildNullConditionalDelegateInvocation(ce, delegateLoad, capture, invokeCall!!)
            }
            return true
        }
        // No applicable Invoke overload — most likely an argument-count or
        // type mismatch. Report against the member name (not "Invoke") so the
        // diagnostic points to what the user wrote.
        let invoke = memberClrType.GetMethodSafe("Invoke")
        let expectedArity = invoke?.GetParameters().Length ?? 0
        if arguments.Length != expectedArity {
            Diagnostics.ReportWrongArgumentCount(ce.Location, methodName, expectedArity, arguments.Length)
        } else {
            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName)
        }
        result = BoundErrorExpression(nil)
        return true
    }

    /// Issue #296: resolves an instance method call against an imported CLR
    /// base class for a GSharp class receiver that inherits it. Uses the same
    /// overload resolution as direct imported-instance calls; `GetMethods`
    /// on the base type already includes members inherited up the CLR chain.
    /// Returns `true` with a bound call when a unique match is found.
    internal func TryBindInheritedClrInstanceCall(
        receiver BoundExpression,
        importedBaseClr Type?,
        methodName string,
        arguments ImmutableArray[BoundExpression],
        ce CallExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?,
        explicitTypeArgs[]?Type = nil,
        typeArgSymbols ImmutableArray[TypeSymbol] = default(ImmutableArray[TypeSymbol]),
        argumentNames ImmutableArray[string] = default(ImmutableArray[string]),
        mapEnumArgumentsToBaseClr bool = false,
        allowProtectedInherited bool = false
    ) bool {
        result = nil
        if receiver.Type is InterfaceSymbol interfaceReceiver &&
            TryBindInterfaceImportedBaseInstanceCall(
            receiver,
            interfaceReceiver,
            methodName,
            arguments,
            ce,
            out result,
            explicitTypeArgs,
            typeArgSymbols,
            argumentNames
        ) {
            return true
        }
        if importedBaseClr == nil {
            return false
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
        let candidates = List[MethodInfo](
            MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(importedBaseClr, methodName)
        )
        for protectedCandidate in CollectBaseClrMethodCandidates(importedBaseClr, methodName) {
            if !MemberLookup.HasSameSignature(candidates, protectedCandidate) {
                candidates.Add(protectedCandidate)
            }
        }
        if candidates.Count == 0 {
            return false
        }
        return TryResolveAndBindClrInstanceCall(
            receiver,
            candidates,
            importedBaseClr,
            methodName,
            arguments,
            ce,
            out result,
            explicitTypeArgs,
            typeArgSymbols,
            argumentNames,
            mapEnumArgumentsToBaseClr,
            allowProtectedInherited: allowProtectedInherited
        )
    }

    /// Issue #1181: resolves an instance method call against the imported/BCL
    /// base interfaces of a user interface receiver. A user interface
    /// `interface IBox : IDisposable` has a null `ClrType`, so the
    /// regular imported-instance walks find nothing; this projects every
    /// transitive imported base interface's public instance methods onto the
    /// receiver (matching how user-base-interface members are surfaced) and
    /// runs the shared overload resolution. The emitted
    /// (cref:BoundImportedInstanceCallExpression) dispatches via
    /// `callvirt` on the imported interface method, which is verifiable
    /// because `IBox` carries an InterfaceImpl row to each imported base.
    /// Runs only after user member-table lookup fails, so user-declared
    /// interface members keep priority.
    /// @param receiver The interface-typed receiver expression.
    /// @param interfaceSymbol The user interface symbol of the receiver.
    /// @param methodName The invoked method name.
    /// @param arguments The bound call arguments.
    /// @param ce The call syntax (for diagnostics/locations).
    /// @param result The bound call on success, or an error node on ambiguity.
    /// @param explicitTypeArgs Explicit CLR type arguments, when present.
    /// @param typeArgSymbols Explicit symbolic type arguments, when present.
    /// @param argumentNames Named-argument labels, when present.
    /// @returns True when the call resolved (or reported a precise ambiguity).
    internal func TryBindInterfaceImportedBaseInstanceCall(
        receiver BoundExpression,
        interfaceSymbol InterfaceSymbol,
        methodName string,
        arguments ImmutableArray[BoundExpression],
        ce CallExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?,
        explicitTypeArgs[]?Type = nil,
        typeArgSymbols ImmutableArray[TypeSymbol] = default(ImmutableArray[TypeSymbol]),
        argumentNames ImmutableArray[string] = default(ImmutableArray[string])
    ) bool {
        result = nil
        let candidates = MemberLookup.GetInterfaceImportedBaseInstanceMethods(
            interfaceSymbol,
            methodName,
            out var importedBaseClr
        )
        if candidates.Count == 0 || importedBaseClr == nil {
            return false
        }
        return TryResolveAndBindClrInstanceCall(
            receiver,
            candidates,
            importedBaseClr,
            methodName,
            arguments,
            ce,
            out result,
            explicitTypeArgs,
            typeArgSymbols,
            argumentNames
        )
    }

    /// Issue #296 / #1181: shared overload-resolution + bound-call construction
    /// core for an imported-instance method call against a pre-collected
    /// [`candidates`](paramref) set. Factored out of
    /// (cref:TryBindInheritedClrInstanceCall) so the inherited-base-class
    /// path and the user-interface imported-base path share one implementation.
    /// @param receiver The receiver expression.
    /// @param candidates The candidate CLR methods.
    /// @param importedBaseClr A representative CLR type for named-argument diagnostics.
    /// @param methodName The invoked method name.
    /// @param arguments The bound call arguments.
    /// @param ce The call syntax.
    /// @param result The bound call on success.
    /// @param explicitTypeArgs Explicit CLR type arguments, when present.
    /// @param typeArgSymbols Explicit symbolic type arguments, when present.
    /// @param argumentNames Named-argument labels, when present.
    /// @param mapEnumArgumentsToBaseClr When `true`, enum-typed arguments resolve as the inherited base CLR
    /// type (`System.Enum`) instead of their erased underlying primitive, so members such as
    /// `HasFlag(System.Enum)` match.
    /// @param nonVirtualBaseCall Issue #1260: when `true`, the resolved call is a `base.M(...)` access into
    /// an imported/BCL base and is flagged so the emitter writes a non-virtual `call`; an `abstract` best
    /// match is reported as GS0413.
    /// @param baseMemberLocation Issue #1260: the location of the member identifier for the GS0413
    /// abstract-base diagnostic (used only when [`nonVirtualBaseCall`](paramref) is set).
    /// @param allowProtectedInherited Issue #2218 follow-up: when `false`, a resolved
    /// `protected`/`protected internal` candidate is rejected with a GS0379 accessibility diagnostic
    /// instead of being bound. Defaults to `true` for the `base.M(...)` and user-interface imported-base
    /// callers, which never surface a protected candidate they aren't entitled to call.
    /// @returns True when the call resolved (or reported a precise ambiguity).
    private func TryResolveAndBindClrInstanceCall(
        receiver BoundExpression,
        candidates IReadOnlyList[MethodInfo],
        importedBaseClr Type?,
        methodName string,
        arguments ImmutableArray[BoundExpression],
        ce CallExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?,
        explicitTypeArgs[]?Type,
        typeArgSymbols ImmutableArray[TypeSymbol],
        argumentNames ImmutableArray[string],
        mapEnumArgumentsToBaseClr bool = false,
        nonVirtualBaseCall bool = false,
        baseMemberLocation TextLocation? = nil,
        allowProtectedInherited bool = true
    ) bool {
        result = nil
        let argTypes = [arguments.Length]Type?
        let CheckUserClassInterface = func (source Type, target Type) bool {
            return IsUserClassAssignableToInterfaceFromArgs(arguments, argTypes, source, target)
        }
        var hasUserClassArg = false
        for var i = 0; i < arguments.Length; i++ {
            // Issue #1218: when resolving an inherited call against System.Enum
            // (e.g. HasFlag(System.Enum)), an enum-typed argument is the boxed
            // System.Enum the parameter expects. The default mapping erases an
            // enum to its underlying int32 (issue #661), which would not match a
            // System.Enum parameter, so map it to the base CLR type instead.
            if mapEnumArgumentsToBaseClr && arguments[i].Type is EnumSymbol {
                argTypes[i] = importedBaseClr
                continue
            }
            // Issue #530: use GetEffectiveArgumentClrType (see instance method path).
            // Issue #533: allow null (nil literal) through.
            // Issue #658: use overload-resolution variant for user classes.
            let t Type? = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type)
            if t == nil && arguments[i].Type != TypeSymbol.Null {
                // Issue #2347: defer an unresolved method-group argument (see
                // TryBindImportedExtensionCall) instead of failing outright;
                // BindClrParameterConversions resolves it once the candidate
                // (and its parameter type) is known.
                if !ClrOverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]) {
                    return false
                }
            }
            if (arguments[i].Type is StructSymbol and {IsClass: true}) {
                hasUserClassArg = true
            }
            argTypes[i] = t
        }
        // Issue #658 / #1634: supplementary interface check for user-class args,
        // threaded as a call-local parameter into Resolve instead of a shared
        // static so nested/concurrent binds can't clobber it.
        var supplementaryInterfaceCheck((Type, Type) -> bool)? = nil
        if hasUserClassArg {
            supplementaryInterfaceCheck = CheckUserClassInterface
        }
        let inheritedSymbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(
            nil,
            ImmutableArray.CreateRange(arguments.Select((a BoundExpression) -> a.Type))
        )
        let recoverInheritedTypeArgs(MethodInfo, bool) -> ImmutableArray[TypeSymbol?] = (
            closed MethodInfo,
            isExpanded bool
        ) -> {
            let refinedArgs = RefineSymbolicArgsForMethodGroups(
                closed,
                arguments,
                inheritedSymbolicArgs,
                receiverArgCount: 0,
                isExpanded: isExpanded,
                argumentNames: if argumentNames.IsDefault {
                    default(IReadOnlyList[string?]?)
                } else {
                    cast[IReadOnlyList[string?]](argumentNames)
                },
                parameterMapping: default(ImmutableArray[int32]),
                methodGroupSlots: out var recoverInheritedMethodGroupSlots
            )
            // Issue #4133 (hot-core translation guard finding): see
            // MergeMethodGroupArgumentSlots's doc.
            recoverInheritedMethodGroupSlots = MergeMethodGroupArgumentSlots(
                arguments,
                receiverArgCount: 0,
                refinedArgs.Length,
                recoverInheritedMethodGroupSlots
            )
            return MemberLookup.BuildSymbolicMethodTypeArgs(
                closed,
                typeArgSymbols,
                refinedArgs,
                isExpanded,
                if argumentNames.IsDefault {
                    default(IReadOnlyList[string?]?)
                } else {
                    cast[IReadOnlyList[string?]](argumentNames)
                },
                recoverInheritedMethodGroupSlots
            )
        }
        let resolution = ClrOverloadResolution.Resolve(
            candidates,
            argTypes,
            explicitTypeArgs,
            $scope.References!!.MapClrTypeToReferences,
            ComputeInterpolatedStringArgFlags(ce.Arguments, arguments.Length),
            argumentNames: if argumentNames.IsDefault {
                default(IReadOnlyList[string]?)
            } else {
                cast[IReadOnlyList[string]](argumentNames)
            },
            recoverTypeArgSymbols: recoverInheritedTypeArgs,
            supplementaryInterfaceCheck: supplementaryInterfaceCheck,
            constantNarrowingArgumentCheck: MakeConstantNarrowingArgumentCheck(arguments),
            structuralProjectionArgumentCheck: MakeStructuralProjectionArgumentCheck(
                arguments,
                nativeConversions: conversions
            ),
            erasedArgumentMismatchCheck: MakeErasedArgumentMismatchCheck(arguments),
            delegateRefKindArgumentCheck: MakeDelegateRefKindArgumentCheck(arguments),
            methodGroupInference: MakeMethodGroupInference(arguments, GetEffectiveArgumentClrTypeForOverloadResolution),
            methodGroupArgumentCheck: MakeMethodGroupArgumentCheck(arguments),
            deferredInferenceArgs: BuildOpenLiteralInferenceFlags(arguments),
            explicitTypeArgIsGenuine: ClrOverloadResolution.BuildGenuineExplicitTypeArgFlags(typeArgSymbols),
            explicitTypeArgumentMismatchCheck: MakeExplicitTypeArgumentMismatchCheck(arguments, typeArgSymbols),
            openLiteralArgumentCheck: MakeOpenLiteralArgumentCheck(arguments),
            symbolicArgTypes: inheritedSymbolicArgs,
            symbolicArgumentConversionClassifier: MakeSymbolicArgumentConversionClassifier(
                arguments,
                nativeConversions: conversions
            )
        )
        switch resolution.Outcome {
            case ClrOverloadResolution.ResolutionOutcome.Resolved {
                if resolution.Best is not{} best {
                    return false
                }
                // Issue #1260: a `base.M(...)` into an abstract BCL member has no
                // base implementation to delegate to (e.g. Stream.Read). Match C#
                // (CS0205) with a clean diagnostic instead of emitting invalid IL.
                if nonVirtualBaseCall && best.IsAbstract {
                    Diagnostics.ReportBaseClassCallAbstractMember(
                        baseMemberLocation ?? ce.Location,
                        importedBaseClr?.Name ?? "object",
                        methodName
                    )
                    result = BoundErrorExpression(nil)
                    return true
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
                if !allowProtectedInherited &&
                    !nonVirtualBaseCall &&
                    !best.IsPublic &&
                    (best.IsFamily || best.IsFamilyOrAssembly || best.IsFamilyAndAssembly) {
                    Diagnostics.ReportProtectedMemberInaccessible(
                        ce.Identifier.Location,
                        methodName,
                        ClrTypeDisplayName(best.DeclaringType ?? importedBaseClr)
                    )
                    result = BoundErrorExpression(nil)
                    return true
                }
                // Issue #1512: an instance method (incl. one inherited from an
                // imported generic base) excludes the receiver from its formal
                // parameter list, so the method-type-argument inference vector must
                // not carry the receiver as slot 0 — otherwise lambda-only-inferable
                // method type parameters never unify and erase to `<object>`.
                // Issue #3712 (instance calls): refine the pre-resolution vector
                // for method-group arguments now that the winning overload pins
                // each group's target delegate — the same refinement the
                // extension-call and direct-instance paths apply.
                let refinedInheritedSymbolicArgs = RefineSymbolicArgsForMethodGroups(
                    best,
                    arguments,
                    inheritedSymbolicArgs,
                    receiverArgCount: 0,
                    isExpanded: resolution.IsExpanded,
                    argumentNames: if argumentNames.IsDefault {
                        default(IReadOnlyList[string?]?)
                    } else {
                        cast[IReadOnlyList[string?]](argumentNames)
                    },
                    parameterMapping: resolution.ParameterMapping,
                    methodGroupSlots: out var inheritedMethodGroupArgumentSlots
                )
                // Issue #4133 (hot-core translation guard finding): see
                // MergeMethodGroupArgumentSlots's doc.
                inheritedMethodGroupArgumentSlots = MergeMethodGroupArgumentSlots(
                    arguments,
                    receiverArgCount: 0,
                    refinedInheritedSymbolicArgs.Length,
                    inheritedMethodGroupArgumentSlots
                )
                let inheritedSymbolicTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(
                    best,
                    typeArgSymbols,
                    refinedInheritedSymbolicArgs,
                    resolution.IsExpanded,
                    if argumentNames.IsDefault {
                        default(IReadOnlyList[string?]?)
                    } else {
                        cast[IReadOnlyList[string?]](argumentNames)
                    },
                    inheritedMethodGroupArgumentSlots
                )
                let inheritedTypeArgSymbolsForCall = if !inheritedSymbolicTypeArgs.IsDefault {
                    inheritedSymbolicTypeArgs
                } else {
                    (
                        if typeArgSymbols.IsDefault {
                            default(ImmutableArray[TypeSymbol?])
                        } else {
                            ImmutableArray.CreateRange[TypeSymbol?](typeArgSymbols)
                        }
                    )
                }
                let returnType = ResolveImportedGenericReturnType(best, typeArgSymbols) ??
                    MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(
                    best,
                    inheritedSymbolicTypeArgs,
                    receiver.Type
                ) ??
                    MemberLookup.GetClrReceiverProjectedReturnTypeSymbol(receiver.Type, best) ??
                    MapClrMethodReturnType(best)
                let inheritedParameters = best.GetParameters()
                let inheritedMapping = resolution.ParameterMapping
                let inheritedDownstreamMapping = if resolution.IsExpanded {
                    default(ImmutableArray[int32])
                } else {
                    inheritedMapping
                }
                // Issue #1638: shared CLR call-argument-construction pipeline
                // (interpolation rebind → handler args → delegate rebind →
                // parameter conversions). Previously this inherited-instance
                // path skipped straight to handler args, so an interpolated
                // string argument targeting an IFormattable/FormattableString
                // parameter of an inherited (base-class) member was never
                // re-lowered to FormattableStringFactory.Create(...).
                let inheritedConvertedArgs = BuildResolvedClrCallArguments(
                    arguments,
                    ce.Arguments,
                    inheritedParameters,
                    inheritedMapping,
                    receiver,
                    ce.Location,
                    ce,
                    ClrCallDelegateRebindMode.Full,
                    out var inheritedHandlerPrelude,
                    out var inheritedUpdatedReceiver,
                    method: best,
                    symbolicMethodTypeArgs: inheritedTypeArgSymbolsForCall,
                    receiverType: receiver.Type,
                    isExpanded: resolution.IsExpanded
                )
                let inheritedArguments = OverloadResolver.BuildOrderedCallArguments(
                    inheritedConvertedArgs,
                    inheritedDownstreamMapping,
                    inheritedParameters
                )
                let refKinds = ComputeArgumentRefKinds(inheritedParameters)
                overloads.ValidateRefArguments(inheritedArguments, refKinds, methodName, ce.Location)
                let inheritedCallReceiver = inheritedUpdatedReceiver ?? receiver
                if TryReportByRefLikeInheritedCall(inheritedCallReceiver, best, ce.Location) {
                    result = BoundErrorExpression(nil)
                    return true
                }
                var inheritedCall = ConversionClassifier.AutoDereferenceRefReturn(
                    BoundImportedInstanceCallExpression(
                        ce,
                        inheritedCallReceiver,
                        best,
                        returnType,
                        inheritedArguments,
                        refKinds,
                        inheritedTypeArgSymbolsForCall,
                        isNonVirtualBaseCall: nonVirtualBaseCall
                    )
                )
                // Issue #4392: a suspending method of an imported base, reached
                // through `base.M()` or unqualified, is completed like any other
                // imported suspending call (ADR-0174 D4).
                inheritedCall = CompleteImportedSuspendingCall(inheritedCall, best, ce.Location)
                result = WrapWithHandlerPrelude(inheritedCall, inheritedHandlerPrelude, ce)
                return true
            }
            case ClrOverloadResolution.ResolutionOutcome.Ambiguous {
                Diagnostics.ReportAmbiguousOverload(
                    ce.Location,
                    methodName,
                    resolution.Ambiguous.Length,
                    resolution.Ambiguous.Select(ClrOverloadResolution.FormatMethodSignature)
                )
                result = BoundErrorExpression(nil)
                return true
            }
            default {
                // Issue #343: if the failure is plausibly due to an unknown
                // named-argument target, surface that as the diagnostic.
                if importedBaseClr != nil && !argumentNames.IsDefault && overloads.TryReportUnknownNamedArgumentForClr(
                    importedBaseClr,
                    methodName,
                    BindingFlags.Instance | BindingFlags.Public,
                    ce,
                    argumentNames
                ) {
                    result = BoundErrorExpression(nil)
                    return true
                }
                return false
            }
        }
    }

    /// ADR-0059 / issue #255: lowers a `delegateValue.Invoke(args)`
    /// call against a value of (cref:DelegateTypeSymbol) into a
    /// (cref:BoundIndirectCallExpression) whose function shape is the
    /// delegate's equivalent (cref:FunctionTypeSymbol). The emitter
    /// recognises a DelegateTypeSymbol target and routes the call through
    /// the delegate's runtime-implemented Invoke MethodDef.
    private func BindNamedDelegateInvokeCall(
        receiver BoundExpression,
        delegateSym DelegateTypeSymbol,
        arguments ImmutableArray[BoundExpression],
        ce CallExpressionSyntax
    ) BoundExpression {
        if !overloads.TryBindNamedDelegateArguments(
            delegateSym.Name,
            delegateSym,
            ce,
            arguments,
            out var convertedArgs,
            out var argumentRefKinds
        ) {
            return BoundErrorExpression(nil)
        }
        return BoundIndirectCallExpression(
            nil,
            receiver,
            delegateSym.EquivalentFunctionType,
            convertedArgs,
            argumentRefKinds
        )
    }

    /// Issue #294: resolves a call written with instance ("receiver") syntax
    /// against an imported CLR static method marked with
    /// `[System.Runtime.CompilerServices.ExtensionAttribute]` whose first
    /// parameter is compatible with the receiver's type. This makes BCL/library
    /// extension methods (LINQ `Where`/`Select`/`ToList`, the
    /// ASP.NET Core minimal-API/middleware surface, etc.) callable as
    /// `receiver.Method(args)` rather than only statically as
    /// `DeclaringClass.Method(receiver, args)`.
    /// @param receiver The bound receiver expression.
    /// @param methodName The method name at the call site.
    /// @param arguments The bound user arguments (excluding the receiver).
    /// @param ce The originating call expression.
    /// @param result The bound call when resolution succeeds (or a bound error on ambiguity).
    /// @param explicitTypeArgs Issue #311: resolved explicit type arguments from a `[T1, T2]` list, or
    /// `null` for inference.
    /// @param typeArgSymbols Issue #320: explicit type-argument symbols in source order (carrying
    /// user-defined types), or default.
    /// @param argumentNames Issue #343: per-source-argument names parallel to [`arguments`](paramref)
    /// (entries are `null` for positional); default when the call is purely positional.
    /// @returns True when an imported extension method was matched (success or ambiguity); false to let the
    /// caller report GS0159.
    private func TryBindImportedExtensionCall(
        receiver BoundExpression,
        methodName string,
        arguments ImmutableArray[BoundExpression],
        ce CallExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?,
        explicitTypeArgs[]?Type = nil,
        typeArgSymbols ImmutableArray[TypeSymbol] = default(ImmutableArray[TypeSymbol]),
        argumentNames ImmutableArray[string] = default(ImmutableArray[string])
    ) bool {
        result = nil
        var receiverClrType Type? = receiver.Type.ClrType
        if receiverClrType == nil {
            // Issue #833: a slice/sequence of an open method type parameter
            // (e.g. `[]T{}.ToArray()` inside `func F[T]()`) has no CLR
            // backing on the receiver. Project it to an erased shape so
            // overload resolution can run; symbolic recovery happens via
            // BuildSymbolicMethodTypeArgs + ResolveCallReturnTypeFromSymbolicTypeArgs.
            if !MemberLookup.TryProjectErasedClrType(receiver.Type, out receiverClrType) {
                return false
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
        if receiver.Type is ImportedTypeSymbol symbolicImportedReceiver &&
            symbolicImportedReceiver.OpenDefinition != nil &&
            !symbolicImportedReceiver
            .TypeArguments
            .IsDefaultOrEmpty {
            let reifiedReceiver Type? = symbolicImportedReceiver.ReifyClosedClrType()
            if reifiedReceiver != nil && !reifiedReceiver.ContainsGenericParameters {
                receiverClrType = reifiedReceiver
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
        if receiver.Type is StructSymbol{IsClass: true} userReceiverClass &&
            (receiverClrType == nil || receiverClrType.IsSameAs(typeof(object))) &&
            TryProjectUserClassReceiverInterface(userReceiverClass, out var receiverIface) {
            receiverClrType = receiverIface
        }
        // Build the argument-type vector as the extension method sees it: the
        // receiver becomes the first ("this") parameter, followed by the user
        // arguments. Every argument must carry a concrete CLR type so overload
        // resolution (including generic inference) can run.
        let argTypes = [arguments.Length + 1]Type?
        let CheckUserClassInterface = func (source Type, target Type) bool {
            return IsUserClassAssignableToInterfaceFromArgs(arguments, argTypes, source, target)
        }
        let deferredInferenceArgs = [arguments.Length + 1]bool
        argTypes[0] = receiverClrType
        var hasUserClassArg = false
        for var i = 0; i < arguments.Length; i++ {
            // Issue #530: use GetEffectiveArgumentClrType (see instance method path).
            // Issue #533: allow null (nil literal) through.
            // Issue #658: use overload-resolution variant for user classes.
            var t Type? = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type)
            if t == nil && arguments[i].Type != TypeSymbol.Null {
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
                if !ClrOverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]) {
                    // Issue #833: argument may carry an open TP (e.g. `T`,
                    // `[]T`). Project to an erased shape so resolution can run.
                    if !MemberLookup.TryProjectErasedClrType(arguments[i].Type, out t) {
                        return false
                    }
                }
            }
            if (arguments[i].Type is StructSymbol and {IsClass: true}) {
                hasUserClassArg = true
            }
            // A same-compilation lambda parameter may erase to its imported
            // base while its inherited-interface receiver erases to object.
            // Keep that CLR shape for applicability, but infer from the
            // receiver's symbolic hierarchy instead of conflicting erasures.
            if receiver.Type is ImportedTypeSymbol &&
                arguments[i].Type is FunctionTypeSymbol functionType &&
                functionType
                .ParameterTypes
                .Any(TypeSymbol.RequiresSymbolicProjection) {
                deferredInferenceArgs[i + 1] = true
            }
            argTypes[i + 1] = t
        }
        // Issue #343: extension methods are dispatched as `Class.Method(receiver, userArgs...)`,
        // so prepend a null slot to user-supplied argument names so positions
        // align with the method's parameter list (where index 0 is `this`).
        var extensionArgumentNames IReadOnlyList[string]? = nil
        if !argumentNames.IsDefault {
            let withReceiver = [arguments.Length + 1]string
            for var i = 0; i < arguments.Length; i++ {
                withReceiver[i + 1] = argumentNames[i]
            }
            extensionArgumentNames = withReceiver
        }
        let extensionSymbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(
            receiver.Type,
            ImmutableArray.CreateRange(
                arguments.Select(
                    (argument BoundExpression) -> if argument is BoundMethodGroupExpression userGroup &&
                        TryGetSymbolicUserMethodGroupType(userGroup, out var symbolicGroupType) {
                        cast[TypeSymbol](
                            Invariant.Required(
                                symbolicGroupType,
                                "a symbolic method-group type was resolved",
                                expression: "symbolicGroupType"
                            )
                        )
                    } else {
                        argument.Type
                    }
                )
            )
        )
        let candidates = MemberLookup.ExcludeErasureOnlyEnumCandidates(
            this.memberLookup.CollectImportedExtensionMethods(methodName),
            extensionSymbolicArgs,
            extensionArgumentNames
        )
            .ToList()
        if candidates.Count == 0 {
            return false
        }
        var hasDeferredInferenceArgument = false
        for deferred in deferredInferenceArgs {
            hasDeferredInferenceArgument |= deferred
        }
        if hasDeferredInferenceArgument && (receiverClrType != nil && receiverClrType.IsGenericType == true) {
            let receiverDefinition = receiverClrType.GetGenericTypeDefinition()
            var candidateMatchesReceiver = false
            for candidate in candidates {
                let candidateParameters = candidate.GetParameters()
                if candidateParameters.Length == 0 || !candidateParameters[0].ParameterType.IsGenericType {
                    continue
                }
                if ClrTypeUtilities.AreSame(
                    receiverDefinition,
                    candidateParameters[0].ParameterType.GetGenericTypeDefinition()
                ) {
                    candidateMatchesReceiver = true
                    break
                }
            }
            if candidateMatchesReceiver {
                Array.Clear(deferredInferenceArgs)
            }
        }
        for var i = 0; i < arguments.Length; i++ {
            if TypeSymbol.ContainsNullLiteralType(arguments[i].Type) {
                deferredInferenceArgs[i + 1] = true
            }
        }
        // Issue #2523: when a symbolic imported receiver's own reconstructed
        // CLR type is still unavailable, project it onto a candidate's declared
        // generic receiver interface/base. This gives generic inference the
        // subset of source arguments that the extension actually consumes
        // (for example IIncludableQueryable<TEntity, TProperty?> ->
        // IQueryable<TEntity>) without letting unrelated nullable or invariant
        // source slots collapse that receiver to object.
        if receiver.Type is ImportedTypeSymbol symbolicReceiver {
            for candidate in candidates {
                let candidateParameters = candidate.GetParameters()
                if candidateParameters.Length == 0 {
                    continue
                }
                let candidateReceiver = candidateParameters[0].ParameterType
                if !candidateReceiver.IsGenericType {
                    continue
                }
                let candidateReceiverOpen = if candidateReceiver.IsGenericTypeDefinition {
                    candidateReceiver
                } else {
                    candidateReceiver.GetGenericTypeDefinition()
                }
                if MemberLookup.TryProjectConstructedHierarchyClrType(
                    symbolicReceiver,
                    candidateReceiverOpen,
                    out var projectedReceiver
                ) {
                    receiverClrType = projectedReceiver
                    argTypes[0] = projectedReceiver
                    break
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
        var supplementaryInterfaceCheck((Type, Type) -> bool)? = nil
        if hasUserClassArg {
            supplementaryInterfaceCheck = CheckUserClassInterface
        }
        let argumentStructuralProjectionCheck = MakeStructuralProjectionArgumentCheck(
            arguments,
            argumentOffset: 1,
            nativeConversions: conversions
        )
        let ExtensionStructuralProjectionCheck = func (index int32, target Type) bool {
            return if index == 0 {
                ClrTypeUtilities.IsAssignableByName(target, argTypes[0]) || Conversion.ClassifyNonStructural(
                    receiver.Type,
                    TypeSymbol.FromClrTypeWithoutNullability(target, NullabilityFreeReason.IdentityComparison)
                )
                    .IsImplicit
            } else {
                argumentStructuralProjectionCheck?(index, target) == true
            }
        }
        // Issue #3989: the same offset-by-one shape for the subtractive check.
        // Slot 0 is the `this` receiver, whose real type is `receiver.Type`.
        let argumentErasedMismatchCheck = MakeErasedArgumentMismatchCheck(arguments, argumentOffset: 1)
        let ExtensionErasedMismatchCheck = func (index int32, target Type) bool {
            return if index == 0 {
                IsErasedArgumentApplicabilityMismatch(receiver.Type, target)
            } else {
                argumentErasedMismatchCheck?(index, target) == true
            }
        }
        // Issue #1311: imported extension calls dispatch as
        // `Class.Method(this receiver, args…)`, so argTypes slot 0 is the
        // receiver and user argument `i` lives at slot `i + 1`.
        // Issue #1812: mirror the flag every other CLR-call path already passes
        // — an interpolated-string argument to an extension method's
        // IFormattable/FormattableString (or handler) parameter must resolve
        // consistently with the instance/inherited/static/ctor paths. Offset by
        // 1 (receiverArgCount) since slot 0 here is the receiver, not a
        // user-supplied argument.
        let recoverExtensionTypeArgs(MethodInfo, bool) -> ImmutableArray[TypeSymbol?] = (
            closed MethodInfo,
            isExpanded bool
        ) -> {
            let refinedArgs = RefineSymbolicArgsForMethodGroups(
                closed,
                arguments,
                extensionSymbolicArgs,
                receiverArgCount: 1,
                isExpanded: isExpanded,
                argumentNames: extensionArgumentNames,
                parameterMapping: default(ImmutableArray[int32]),
                methodGroupSlots: out var recoverExtensionMethodGroupSlots
            )
            // Issue #4133 (hot-core translation guard finding): see
            // MergeMethodGroupArgumentSlots's doc.
            recoverExtensionMethodGroupSlots = MergeMethodGroupArgumentSlots(
                arguments,
                receiverArgCount: 1,
                refinedArgs.Length,
                recoverExtensionMethodGroupSlots
            )
            return MemberLookup.BuildSymbolicMethodTypeArgs(
                closed,
                typeArgSymbols,
                refinedArgs,
                isExpanded,
                extensionArgumentNames,
                recoverExtensionMethodGroupSlots
            )
        }
        let functionLiteralArgumentCheck(int32) -> bool = (argumentIndex int32) -> argumentIndex > 0 &&
            argumentIndex - 1 < arguments.Length &&
            arguments[argumentIndex - 1] is BoundFunctionLiteralExpression
        let ResolveExtensionCandidates = func () ClrOverloadResolution.Result[MethodInfo] {
            return ClrOverloadResolution.Resolve(
                candidates,
                argTypes,
                explicitTypeArgs,
                $scope.References!!.MapClrTypeToReferences,
                ComputeInterpolatedStringArgFlags(ce.Arguments, argTypes.Length, receiverArgCount: 1),
                argumentNames: extensionArgumentNames,
                recoverTypeArgSymbols: recoverExtensionTypeArgs,
                supplementaryInterfaceCheck: supplementaryInterfaceCheck,
                constantNarrowingArgumentCheck: MakeConstantNarrowingArgumentCheck(arguments, argumentOffset: 1),
                structuralProjectionArgumentCheck: ExtensionStructuralProjectionCheck,
                erasedArgumentMismatchCheck: ExtensionErasedMismatchCheck,
                delegateRefKindArgumentCheck: MakeDelegateRefKindArgumentCheck(arguments, argumentOffset: 1),
                methodGroupInference: MakeMethodGroupInference(
                    arguments,
                    GetEffectiveArgumentClrTypeForOverloadResolution,
                    argumentOffset: 1
                ),
                methodGroupArgumentCheck: MakeMethodGroupArgumentCheck(arguments, argumentOffset: 1),
                deferredInferenceArgs: deferredInferenceArgs,
                functionLiteralArgumentCheck: functionLiteralArgumentCheck,
                explicitTypeArgIsGenuine: ClrOverloadResolution.BuildGenuineExplicitTypeArgFlags(typeArgSymbols),
                explicitTypeArgumentMismatchCheck: MakeExplicitTypeArgumentMismatchCheck(
                    arguments,
                    typeArgSymbols,
                    argumentOffset: 1
                ),
                openLiteralArgumentCheck: MakeOpenLiteralArgumentCheck(arguments, argumentOffset: 1),
                symbolicArgTypes: extensionSymbolicArgs,
                symbolicArgumentConversionClassifier: MakeSymbolicArgumentConversionClassifier(
                    arguments,
                    argumentOffset: 1,
                    nativeConversions: conversions
                )
            )
        }
        var resolution = ResolveExtensionCandidates()
        // Issue #3673: `NullableTypeSymbol.ClrType` is the *underlying* CLR type
        // (`Int32` for `int32?`), so slot 0 above presents a value-typed nullable
        // receiver unlifted. A candidate whose `this` parameter is
        // `Nullable<T>` — for example
        // `Gsharp.Extensions.Optional.OrThrow[T struct](self T?, message string)` —
        // then has no evidence to infer `T` from, because none of the user
        // arguments mention it, and the whole call dead-ends at GS0159. (Sibling
        // helpers such as `OrElse`/`OrCompute` are unaffected only because their
        // user argument independently pins `T`.) Retry once with the lifted
        // `Nullable<T>` receiver shape so `Nullable<T>` self-parameters unify.
        // The retry runs only after the unlifted shape has already failed, so
        // extensions that legitimately match the underlying type keep binding
        // exactly as before.
        if resolution.Outcome == ClrOverloadResolution
            .ResolutionOutcome
            .NoneApplicable &&
            receiver.Type is NullableTypeSymbol &&
            NullableLifting.GetEffectiveClrType(receiver.Type) is {} liftedReceiverClrType && !ClrTypeUtilities.AreSame(
            liftedReceiverClrType,
            receiverClrType
        ) {
            argTypes[0] = liftedReceiverClrType
            let liftedResolution = ResolveExtensionCandidates()
            if liftedResolution.Outcome != ClrOverloadResolution.ResolutionOutcome.NoneApplicable {
                resolution = liftedResolution
            } else {
                argTypes[0] = receiverClrType
            }
        }
        switch resolution.Outcome {
            case ClrOverloadResolution.ResolutionOutcome.Resolved { }
            case ClrOverloadResolution.ResolutionOutcome.Ambiguous {
                Diagnostics.ReportAmbiguousOverload(
                    ce.Location,
                    methodName,
                    resolution.Ambiguous.Length,
                    resolution.Ambiguous.Select(ClrOverloadResolution.FormatMethodSignature)
                )
                result = BoundErrorExpression(nil)
                return true
            }
            default {
                return false
            }
        }
        if resolution.Best is not{} best {
            return false
        }
        let declaringType Type? = best.DeclaringType
        if declaringType == nil {
            return false
        }
        let importedClass = ImportedClassSymbol(declaringType, ce, references: $scope.References)
        // Issue #833: for an extension call the symbolic-argument vector
        // includes the receiver as slot 0 to mirror the static-dispatch
        // shape (`Class.Method(this receiver, args…)`). The inferred
        // method-type-args may then surface a symbolic return like
        // `[]T` from `[]T{}.ToArray()` instead of the erased
        // `object[]`.
        // Issue #3712: an OVERLOADED user method group has no natural type, so
        // the pre-resolution symbolic vector above kept the argument's erased
        // shape. Now that `best` is known its delegate parameter pins the
        // group's arity — refine the vector so the symbolic type arguments
        // (and therefore the emitted generic instantiation) recover the
        // same-compilation return type instead of its `object` erasure.
        let refinedExtensionSymbolicArgs = RefineSymbolicArgsForMethodGroups(
            best,
            arguments,
            extensionSymbolicArgs,
            receiverArgCount: 1,
            isExpanded: resolution.IsExpanded,
            argumentNames: extensionArgumentNames,
            parameterMapping: resolution.ParameterMapping,
            methodGroupSlots: out var extensionMethodGroupArgumentSlots
        )
        // Issue #4133 (hot-core translation guard finding): see
        // MergeMethodGroupArgumentSlots's doc — a method group that already
        // had a single, unambiguous candidate was substituted with its
        // natural FunctionTypeSymbol back when `extensionSymbolicArgs` was
        // first built above, before `best` was known, so
        // RefineSymbolicArgsForMethodGroups's own tracking alone missed it.
        extensionMethodGroupArgumentSlots = MergeMethodGroupArgumentSlots(
            arguments,
            receiverArgCount: 1,
            refinedExtensionSymbolicArgs.Length,
            extensionMethodGroupArgumentSlots
        )
        let extensionSymbolicTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(
            best,
            typeArgSymbols,
            refinedExtensionSymbolicArgs,
            resolution.IsExpanded,
            extensionArgumentNames,
            extensionMethodGroupArgumentSlots
        )
        let extensionTypeArgSymbolsForCall = if !extensionSymbolicTypeArgs.IsDefault {
            extensionSymbolicTypeArgs
        } else {
            (
                if typeArgSymbols.IsDefault {
                    default(ImmutableArray[TypeSymbol?])
                } else {
                    ImmutableArray.CreateRange[TypeSymbol?](typeArgSymbols)
                }
            )
        }
        let returnOverride = ResolveImportedGenericReturnType(best, typeArgSymbols) ??
            MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(best, extensionSymbolicTypeArgs, receiver.Type)
        let function = ImportedFunctionSymbol(methodName, importedClass, best, ce, returnOverride)
        let allArguments = ImmutableArray.CreateBuilder[BoundExpression](arguments.Length + 1)
        allArguments.Add(receiver)
        allArguments.AddRange(arguments)
        var bound = allArguments.MoveToImmutable()
        let parameters = best.GetParameters()
        let downstreamMapping = if resolution.IsExpanded {
            default(ImmutableArray[int32])
        } else {
            resolution.ParameterMapping
        }
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
        let extensionDelegateRebindMode = if best.IsGenericMethod {
            ClrCallDelegateRebindMode.NumericWideningOnly
        } else {
            ClrCallDelegateRebindMode.Full
        }
        bound = BuildResolvedClrCallArguments(
            bound,
            ce.Arguments,
            parameters,
            resolution.ParameterMapping,
            receiver,
            ce.Location,
            ce,
            extensionDelegateRebindMode,
            out var extensionHandlerPrelude,
            out var extensionUpdatedReceiver,
            method: best,
            symbolicMethodTypeArgs: extensionTypeArgSymbolsForCall,
            receiverType: receiver.Type,
            receiverArgCount: 1,
            isExpanded: resolution.IsExpanded
        )
        if extensionUpdatedReceiver != nil && extensionUpdatedReceiver != receiver {
            bound = bound.SetItem(0, extensionUpdatedReceiver)
        }
        // Issue #327 / #343: re-order arguments into parameter positions when
        // named arguments were used; otherwise fall through to the existing
        // trailing-optional fill.
        bound = OverloadResolver.BuildOrderedCallArguments(bound, downstreamMapping, parameters)
        let refKinds = ComputeArgumentRefKinds(parameters)
        overloads.ValidateRefArguments(bound, refKinds, methodName, ce.Location)
        // ADR-0174 D4: an imported `[Suspending]` extension — the batch surface
        // of D10 is written this way — is completed at the call site like any
        // other suspending call, so the caller sees `R` rather than
        // `ValueTask[R]` and is coloured suspending by the call. The completion
        // wraps the call itself, before any handler prelude, so an await lands
        // on the call rather than on the prelude around it.
        let extensionCall = CompleteImportedSuspendingCall(
            ConversionClassifier.AutoDereferenceRefReturn(
                BoundImportedCallExpression(ce, function, bound, refKinds, extensionTypeArgSymbolsForCall)
            ),
            function.Method,
            ce.Location
        )
        result = WrapWithHandlerPrelude(extensionCall, extensionHandlerPrelude, ce)
        return true
    }

    /// Issue #1638: selects which delegate-argument rebind step
    /// (cref:BuildResolvedClrCallArguments) runs between the
    /// interpolated-string-handler pass and the CLR parameter-conversion
    /// pass.
    private enum ClrCallDelegateRebindMode {
        Full,
        NumericWideningOnly
    }

    /// Issue #1638: the shared post-overload-resolution CLR call-argument
    /// construction pipeline — `RebindFormattableInterpolationArguments →
    /// ApplyInterpolatedStringHandlers → (delegate rebind) →
    /// BindClrParameterConversions` — used by every resolved CLR call
    /// dispatch (ctor, static, instance, inherited-instance, extension).
    /// Centralising the sequence keeps a fix applied once (e.g. a step
    /// re-ordering or a missing step) from drifting out of sync across the
    /// five call sites.
    ///
    /// `argumentSyntax` is the call's source argument syntax list, used
    /// to detect interpolated-string arguments; it does NOT include a slot
    /// for a synthesised receiver. `delegateRebindMode` selects which
    /// delegate-argument rebind step runs; see
    /// (cref:ClrCallDelegateRebindMode). `receiverType` is passed
    /// to the delegate-rebind step's symbolic-target lookup. Issue
    /// #1512/#1320: `conversionReceiverType` is the receiver type passed
    /// to (cref:ConversionClassifier.BindClrParameterConversions)
    /// instead — the instance-call path deliberately feeds the delegate
    /// rebind the enumerable-normalized receiver type while feeding the
    /// parameter-conversion pass the raw (un-normalized) receiver type, so
    /// this can differ from `receiverType`; defaults to it via
    /// `hasConversionReceiverTypeOverride` when not overridden.
    /// `receiverArgCount` is the number of leading argument/parameter
    /// slots reserved for a synthesised receiver (0 for plain calls, 1 for
    /// imported extension calls).
    private func BuildResolvedClrCallArguments(
        arguments ImmutableArray[BoundExpression],
        argumentSyntax GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
        parameters[]ParameterInfo,
        parameterMapping ImmutableArray[int32],
        receiver BoundExpression?,
        location TextLocation,
        call CallExpressionSyntax,
        delegateRebindMode ClrCallDelegateRebindMode,
        out preludeStatements ImmutableArray[BoundStatement],
        out updatedReceiver BoundExpression?,
        method MethodInfo? = nil,
        symbolicMethodTypeArgs ImmutableArray[TypeSymbol?] = default(ImmutableArray[TypeSymbol?]),
        receiverType TypeSymbol? = nil,
        hasConversionReceiverTypeOverride bool = false,
        conversionReceiverType TypeSymbol? = nil,
        receiverArgCount int32 = 0,
        parameterTypeOverrides IReadOnlyDictionary[int32, TypeSymbol]? = nil,
        isExpanded bool = false
    ) ImmutableArray[BoundExpression] {
        var parameterMapping = parameterMapping
        let expandedMapping = if isExpanded {
            parameterMapping
        } else {
            default(ImmutableArray[int32])
        }
        let expandedArgumentLocations = CaptureExpandedArgumentLocations(
            call,
            arguments.Length,
            parameterMapping,
            parameters.Length,
            receiverArgCount,
            isExpanded
        )
        let rebound = RebindFormattableInterpolationArguments(
            arguments,
            argumentSyntax,
            parameters,
            parameterMapping,
            receiverArgCount,
            isExpanded
        )
        var handlerArgs = ApplyInterpolatedStringHandlers(
            parameters,
            rebound,
            receiver,
            location,
            parameterMapping,
            isExpanded,
            out preludeStatements,
            out updatedReceiver
        )
        if isExpanded {
            handlerArgs = overloads.ExpandParamsArguments(
                handlerArgs,
                parameters,
                call,
                receiverArgCount,
                parameterMapping,
                symbolicMethodTypeArgs
            )
            parameterMapping = default(ImmutableArray[int32])
        }
        let delegateArgs = if delegateRebindMode == ClrCallDelegateRebindMode.Full {
            RebindFunctionLiteralDelegateArguments(
                handlerArgs,
                parameters,
                parameterMapping,
                method,
                symbolicMethodTypeArgs,
                receiverType,
                parameterTypeOverrides
            )
        } else {
            RebindNumericReturnWideningDelegateArguments(handlerArgs, parameters, parameterMapping)
        }
        let effectiveConversionReceiverType = if hasConversionReceiverTypeOverride {
            conversionReceiverType
        } else {
            receiverType
        }
        let conversionSymbolicMethodTypeArgs = if symbolicMethodTypeArgs.IsDefault {
            default(ImmutableArray[TypeSymbol?])
        } else {
            ImmutableArray.CreateRange[TypeSymbol?](
                symbolicMethodTypeArgs.Select((symbol TypeSymbol?) -> symbol ?? TypeSymbol.Error)
            )
        }
        let converted = conversions.BindClrParameterConversions(
            delegateArgs,
            parameters,
            call,
            parameterMapping,
            receiverArgCount,
            method,
            effectiveConversionReceiverType,
            conversionSymbolicMethodTypeArgs,
            parameterTypeOverrides,
            expandedParamsIndex: if isExpanded {
                parameters.Length - 1
            } else {
                -1
            },
            parameterArgumentLocations: expandedArgumentLocations
        )
        return if isExpanded {
            OverloadResolver.PreserveExpandedArgumentEvaluationOrder(converted, expandedMapping, receiverArgCount)
        } else {
            converted
        }
    }

    private func RebindFunctionLiteralDelegateArguments(
        arguments ImmutableArray[BoundExpression],
        parameters[]ParameterInfo,
        parameterMapping ImmutableArray[int32] = default(ImmutableArray[int32]),
        method MethodInfo? = nil,
        symbolicMethodTypeArgs ImmutableArray[TypeSymbol?] = default(ImmutableArray[TypeSymbol?]),
        receiverType TypeSymbol? = nil,
        parameterTypeOverrides IReadOnlyDictionary[int32, TypeSymbol]? = nil
    ) ImmutableArray[BoundExpression] {
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < arguments.Length; i++ {
            let paramIndex = if parameterMapping.IsDefault {
                i
            } else {
                parameterMapping[i]
            }
            let argument = arguments[i]
            var rebound = argument
            var parameterTypeOverride TypeSymbol? = nil
            if parameterTypeOverrides != nil {
                parameterTypeOverrides.TryGetValue(paramIndex, out parameterTypeOverride)
            }
            var targetFunctionType FunctionTypeSymbol? = nil
            let hasTargetFunctionType = if parameterTypeOverride != nil {
                MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(parameterTypeOverride, out targetFunctionType)
            } else {
                paramIndex < parameters.Length && MemberLookup.TryGetLambdaTargetFunctionType(
                    parameters[paramIndex].ParameterType,
                    out targetFunctionType
                )
            }
            if paramIndex < parameters.Length && LambdaBinder.TryGetFunctionLiteral(argument, out var literal) &&
                hasTargetFunctionType &&
                literal!!.FunctionType != targetFunctionType {
                targetFunctionType = Invariant.Required(
                    targetFunctionType,
                    "successful delegate target lookup returns a function type",
                    expression: "targetFunctionType"
                )
                // Issue #1512: when the call is a generic method whose delegate
                // parameter mentions a method type parameter, the closed CLR
                // parameter type erases that slot to `object`, so the literal
                // would be rebound to e.g. `(Task) -> object` and emit a
                // `Func<Task,object>` delegate where `Func<Task,T>` is required.
                // Prefer the symbolic delegate target recovered from the OPEN
                // method parameter substituted with the inferred symbolic method
                // type arguments — including when it already equals the literal's
                // bound function type, so the erasing rebind below is skipped.
                if TryBuildSymbolicDelegateTargetForMethodParam(
                    method,
                    paramIndex,
                    symbolicMethodTypeArgs,
                    receiverType,
                    out var symbolicTarget
                ) {
                    targetFunctionType = symbolicTarget
                } else if TypeSymbol.ContainsTypeParameter(literal!!.FunctionType) ||
                    TypeSymbol
                    .ContainsSameCompilationUserType(literal!!.FunctionType) {
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
                    targetFunctionType = literal!!.FunctionType
                }
                if literal!!.FunctionType != targetFunctionType {
                    rebound = lambdas.CreateErasedFunctionLiteralAdapter(literal!!, targetFunctionType!!)
                }
            }
            if rebound != argument && builder == nil {
                builder = ImmutableArray.CreateBuilder[BoundExpression](arguments.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(arguments[j])
                }
            }
            builder?.Add(rebound)
        }
        if builder == nil {
            return arguments
        }
        for var i = builder.Count; i < arguments.Length; i++ {
            builder.Add(arguments[i])
        }
        return builder.ToImmutable()
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
    private func RebindNumericReturnWideningDelegateArguments(
        arguments ImmutableArray[BoundExpression],
        parameters[]ParameterInfo,
        parameterMapping ImmutableArray[int32] = default(ImmutableArray[int32])
    ) ImmutableArray[BoundExpression] {
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < arguments.Length; i++ {
            let paramIndex = if parameterMapping.IsDefault {
                i
            } else {
                parameterMapping[i]
            }
            let argument = arguments[i]
            var rebound = argument
            if paramIndex < parameters.Length && LambdaBinder.TryGetFunctionLiteral(argument, out var literal) {
                let literalFnType FunctionTypeSymbol? = literal!!.FunctionType as FunctionTypeSymbol
                if literalFnType != nil &&
                    literalFnType.ReturnType != TypeSymbol.Void &&
                    literalFnType.ReturnType != TypeSymbol.Error &&
                    MemberLookup.TryGetLambdaTargetFunctionType(
                    parameters[paramIndex].ParameterType,
                    out var targetFunctionType
                ) &&
                    targetFunctionType!!.ReturnType != TypeSymbol.Void &&
                    targetFunctionType!!.ReturnType != TypeSymbol.Error &&
                    targetFunctionType!!.Arity == literalFnType.Arity &&
                    !object.ReferenceEquals(literalFnType.ReturnType, targetFunctionType!!.ReturnType) &&
                    ConversionClassifier
                    .IsNumericReturnWidening(literalFnType.ReturnType, targetFunctionType!!.ReturnType) {
                    rebound = lambdas.CreateErasedFunctionLiteralAdapter(literal!!, targetFunctionType!!)
                }
            }
            if rebound != argument && builder == nil {
                builder = ImmutableArray.CreateBuilder[BoundExpression](arguments.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(arguments[j])
                }
            }
            builder?.Add(rebound)
        }
        if builder == nil {
            return arguments
        }
        for var i = builder.Count; i < arguments.Length; i++ {
            builder.Add(arguments[i])
        }
        return builder.ToImmutable()
    }

    /// ADR-0091 / issue #757: bind an explicit-base interface call
    /// `base[IFoo].M(args)`. Validates that:
    /// 1. the enclosing function is an instance member of a class or struct,
    /// 2. the interface resolves and is in the enclosing type's interface set (GS0338),
    /// 3. the named member exists on the interface (GS0339),
    /// 4. the member has a default body (GS0340), and
    /// 5. the member is not a `private` helper (GS0341 — preserves ADR-0090).
    /// On success, returns a (cref:BoundBaseInterfaceCallExpression)
    /// whose receiver is the enclosing method's `this` parameter.
    private func BindBaseInterfaceCallExpression(syntax BaseInterfaceCallExpressionSyntax) BoundExpression {
        // Resolve the selector inside the brackets first. Issue #986: when it
        // names a base CLASS instead of an interface, route to the base-class
        // call form so `base[BaseClass].M(args)` works as an alternative
        // spelling of `base.M(args)` — binding arguments there (not here) so
        // they are not bound twice. Type-clause binding already reports the
        // relevant "type not found" diagnostic (GS0046) when resolution fails.
        let ifaceType TypeSymbol? = bindTypeClause(syntax.InterfaceTypeClause)
        if ifaceType == nil || ifaceType == TypeSymbol.Error {
            return BoundErrorExpression(nil)
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
        if syntax.IsPropertyAccess && ifaceType is StructSymbol propSelector && propSelector.IsClass {
            if syntax.IsPropertyWrite {
                if syntax.Value is not{} valueSyntax || syntax.EqualsToken is not{} equalsToken {
                    return BoundErrorExpression(nil)
                }
                let boundValue = BindExpression(valueSyntax)
                return BindBaseClassPropertyWrite(
                    syntax.MethodIdentifier.ValueText,
                    syntax.MethodIdentifier.Location,
                    syntax.BaseKeyword.Location,
                    boundValue,
                    valueSyntax.Location,
                    equalsToken.Location,
                    explicitBaseType: propSelector,
                    selectorLocation: syntax.InterfaceTypeClause.Location
                )
            }
            let memberName = NameExpressionSyntax(syntax.SyntaxTree, syntax.MethodIdentifier)
            return BindBaseClassPropertyRead(
                memberName,
                syntax.BaseKeyword.Location,
                explicitBaseType: propSelector,
                selectorLocation: syntax.InterfaceTypeClause.Location
            )
        }
        if ifaceType is StructSymbol classSelector && classSelector.IsClass {
            if syntax.OpenParenthesisToken is not{} openParenthesisToken ||
                syntax.CloseParenthesisToken is not{} closeParenthesisToken {
                return BoundErrorExpression(nil)
            }
            let synthesizedCall = CallExpressionSyntax(
                syntax.SyntaxTree,
                syntax.MethodIdentifier,
                syntax.MethodTypeArgumentList,
                openParenthesisToken,
                syntax.Arguments,
                closeParenthesisToken
            )
            return BindBaseClassCall(
                synthesizedCall,
                syntax.BaseKeyword.Location,
                classSelector,
                syntax.InterfaceTypeClause.Location
            )
        }
        // Bind the user arguments unconditionally — even on the failure paths
        // below we want any nested binder diagnostics (unknown name in arg
        // position, etc.) to surface in the same pass.
        let boundArguments = ImmutableArray.CreateBuilder[BoundExpression](syntax.Arguments.Count)
        for var i = 0; i < syntax.Arguments.Count; i++ {
            boundArguments.Add(BindExpression(syntax.Arguments[i]))
        }
        // The selector must denote an interface.
        if ifaceType is not InterfaceSymbol ifaceSym {
            Diagnostics.ReportBaseInterfaceCallTypeDoesNotImplementInterface(
                syntax.InterfaceTypeClause.Location,
                EnclosingTypeDisplayName(),
                ifaceType.Name
            )
            return BoundErrorExpression(nil)
        }
        // The call site must live in an instance member of a class/struct
        // that implements `ifaceSym`. A top-level function, a `shared` static,
        // or a generic-typeparameter-receiver call all fail this test.
        let enclosingType StructSymbol? = function?.ReceiverType as StructSymbol
        if enclosingType == nil || function?.ThisParameter == nil {
            Diagnostics.ReportBaseInterfaceCallTypeDoesNotImplementInterface(
                syntax.BaseKeyword.Location,
                "<top-level>",
                ifaceSym.Name
            )
            return BoundErrorExpression(nil)
        }
        if !EnclosingTypeImplements(enclosingType, ifaceSym) {
            Diagnostics.ReportBaseInterfaceCallTypeDoesNotImplementInterface(
                syntax.InterfaceTypeClause.Location,
                enclosingType.Name,
                ifaceSym.Name
            )
            return BoundErrorExpression(nil)
        }
        // Generic-method type arguments on the selector are reserved for a
        // future ADR-0091 follow-up — reject for now with the "member is
        // abstract"-shaped diagnostic name so users get a clear pointer.
        if syntax.MethodTypeArgumentList != nil {
            Diagnostics.ReportBaseInterfaceCallMemberNotFound(
                syntax.MethodIdentifier.Location,
                ifaceSym.Name,
                syntax.MethodIdentifier.ValueText + "[…]"
            )
            return BoundErrorExpression(nil)
        }
        let methodName = syntax.MethodIdentifier.ValueText
        // Private helpers (ADR-0090) are intentionally invisible to
        // implementers; calling one through base[IFoo] would defeat that
        // encapsulation. Check first so the diagnostic distinguishes the
        // private case from a generic "no such member".
        let privateMatches = ifaceSym.GetPrivateMethods(methodName)
        if privateMatches.Length > 0 {
            Diagnostics.ReportBaseInterfaceCallTargetsPrivateHelper(
                syntax.MethodIdentifier.Location,
                ifaceSym.Name,
                methodName
            )
            return BoundErrorExpression(nil)
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
        var arityMatch FunctionSymbol? = nil
        var anyMatch FunctionSymbol? = nil
        var matchIndex = -1
        let overloads = ifaceSym.Methods
        for var i = 0; i < overloads.Length; i++ {
            let candidate = overloads[i]
            if candidate.Name != methodName {
                continue
            }
            anyMatch = candidate
            let calleeOffset = if candidate.ExplicitReceiverParameter == nil {
                0
            } else {
                1
            }
            let callableParameterCount = candidate.Parameters.Length - calleeOffset
            if callableParameterCount == boundArguments.Count {
                arityMatch = candidate
                matchIndex = i
                break
            }
        }
        if anyMatch == nil {
            Diagnostics.ReportBaseInterfaceCallMemberNotFound(
                syntax.MethodIdentifier.Location,
                ifaceSym.Name,
                methodName
            )
            return BoundErrorExpression(nil)
        }
        if arityMatch == nil {
            // Member exists but no overload accepts this many arguments;
            // report a wrong-arg-count diagnostic against the first overload
            // for ergonomic recovery (the user will fix the arg count and
            // re-bind).
            let calleeOffset = if anyMatch.ExplicitReceiverParameter == nil {
                0
            } else {
                1
            }
            let callableParameterCount = anyMatch.Parameters.Length - calleeOffset
            Diagnostics.ReportWrongArgumentCount(
                syntax.MethodIdentifier.Location,
                methodName,
                callableParameterCount,
                boundArguments.Count
            )
            return BoundErrorExpression(nil)
        }
        // Map the substituted method on a constructed generic interface back
        // to its open MethodDef slot (cache.MethodHandles is keyed on the
        // open definition). CreateConstructed preserves declaration order
        // 1:1, so the same index identifies the open slot.
        var openMethod = arityMatch
        if ifaceSym.Definition != nil && !object.ReferenceEquals(ifaceSym.Definition, ifaceSym) &&
            matchIndex >= 0 &&
            matchIndex < ifaceSym
            .Definition
            .Methods
            .Length {
            openMethod = ifaceSym.Definition.Methods[matchIndex]
        }
        if !InterfaceSymbol.HasDefaultBody(openMethod) {
            Diagnostics.ReportBaseInterfaceCallMemberIsAbstract(
                syntax.MethodIdentifier.Location,
                ifaceSym.Name,
                methodName
            )
            return BoundErrorExpression(nil)
        }
        if function?.ThisParameter is not{} thisParameter {
            return BoundErrorExpression(nil)
        }
        let receiver = BoundVariableExpression(nil, thisParameter)
        return BoundBaseInterfaceCallExpression(syntax, receiver, ifaceSym, openMethod, boundArguments.ToImmutable())
    }

    /// Issue #2534: binds the canonical `base.M(args)` syntax. A real
    /// value named `base` retains its historical member-call meaning;
    /// otherwise the call resolves through the base-class overload set and
    /// emits non-virtually.
    private func BindBaseClassCallExpression(syntax BaseClassCallExpressionSyntax) BoundExpression {
        // `base` is contextual: when anything named `base` is in scope (a
        // local, field, function, source or imported type), `base.M(args)`
        // is an ordinary member call on it.
        let baseName = NameExpressionSyntax(syntax.SyntaxTree, syntax.BaseKeyword)
        if !IsContextualBaseKeyword(baseName) {
            let receiver = baseName
            let accessor = AccessorExpressionSyntax(syntax.SyntaxTree, receiver, syntax.DotToken, syntax.Call)
            return BindAccessorExpression(accessor)
        }
        return BindBaseClassCall(
            syntax.Call,
            syntax.BaseKeyword.Location,
            explicitBaseType: nil,
            selectorLocation: syntax.BaseKeyword.Location
        )
    }

    /// ADR-0091: produces a human-readable display name for the enclosing
    /// receiver type used in GS0338 messages. Falls back to a placeholder
    /// when the call site is not inside an instance member.
    private func EnclosingTypeDisplayName() string {
        if (function?.ReceiverType ?? GetBaseAccessThisParameter()?.Type) is {} recv {
            return recv.Name
        }
        return "<top-level>"
    }

    /// Issue #986: binds a base-class call of the form `base.M(args)`
    /// (when [`explicitBaseType`](paramref) is `null`) or
    /// the bracketed `base[BaseClass].M(args)` form (when it names the
    /// base class). Resolves `M` on the nearest base class's member set
    /// (walking grandparents), reuses the standard overload resolution and
    /// argument-conversion pipeline via
    /// (cref:OverloadResolver.BindUserInstanceCall), then wraps the
    /// result in a (cref:BoundBaseClassCallExpression) so the emitter
    /// produces a non-virtual `call` (not `callvirt`) — exactly like
    /// C# `base.M(...)`.
    /// @param ce The method-call syntax (`M(args)`).
    /// @param baseLocation The location of the `base` token for context diagnostics.
    /// @param explicitBaseType The class named in `base[BaseClass]`, or `null` for the plain `base.M` form.
    /// @param selectorLocation The location of the bracketed selector (for GS0385); ignored when
    /// [`explicitBaseType`](paramref) is null.
    /// @returns The bound base-class call, or a bound error on failure.
    private func BindBaseClassCall(
        ce CallExpressionSyntax,
        baseLocation TextLocation,
        explicitBaseType StructSymbol?,
        selectorLocation TextLocation
    ) BoundExpression {
        if !TryResolveBaseSearchType(
            baseLocation,
            explicitBaseType,
            selectorLocation,
            out var searchBase,
            out var clrBaseFallback
        ) {
            return BoundErrorExpression(nil)
        }
        let methodName = ce.Identifier.ValueText
        // Resolve the overload set on the user base chain (this-first from the
        // search base), which walks grandparents — so the nearest user base
        // implementation of an inherited member is chosen.
        let baseOverloads = if searchBase != nil {
            TypeMemberModel.GetMethods(searchBase, methodName, MemberQuery.Instance(MemberKinds.Method))
        } else {
            ImmutableArray[FunctionSymbol].Empty
        }
        if baseOverloads.IsEmpty {
            // Issue #1260: no GSharp base declares the member (the class derives
            // directly from a BCL base, or the nearest user base does not declare
            // it). Fall back to the imported/BCL base type so `base.Dispose(...)`,
            // `base.ToString()`, etc. resolve and emit a non-virtual `call`.
            if TryBindBaseClrInstanceCall(ce, methodName, clrBaseFallback, out var bclResult) {
                return bclResult!!
            }
            Diagnostics.ReportBaseClassCallMemberNotFound(
                ce.Identifier.Location,
                searchBase?.Name ?? ClrTypeDisplayName(clrBaseFallback),
                methodName
            )
            return BoundErrorExpression(nil)
        }
        if !overloads.TryAnalyzeCallArgumentLayout(ce.Arguments, out _, out var argumentNames) {
            return BoundErrorExpression(nil)
        }
        let arguments = BindBaseCallArguments(ce)
        let method FunctionSymbol? = overloads.SelectInstanceOverloadOrReport(
            baseOverloads,
            arguments,
            ce,
            methodName,
            argumentNames,
            searchBase
        )
        if method == nil {
            return BoundErrorExpression(nil)
        }
        // Reuse the full instance-call binding pipeline (named-argument
        // reordering, generic substitution, variadic packing, per-argument
        // conversions). The receiver is the enclosing method's `this`.
        if GetBaseAccessThisParameter() is not{} thisParameter {
            return BoundErrorExpression(nil)
        }
        let receiver = BoundVariableExpression(nil, thisParameter)
        let bound = overloads.BindUserInstanceCall(receiver, method, arguments, ce, argumentNames)
        // Issue #4392: a call to a suspending method comes back already
        // completed (ADR-0174 D4): an implicit await, or the blocking bridge,
        // around the instance call. Wrap the inner call, not the completed
        // one, and complete the base call again; returning the completed
        // call as it was left a virtual call, so a suspend override calling
        // `base.M()` re-entered itself.
        let completedSuspendingCall BoundUserInstanceCallExpression? = if method.IsSuspending {
            TryGetCompletedSuspendingInstanceCall(bound)
        } else {
            default(BoundUserInstanceCallExpression?)
        }
        if (completedSuspendingCall ?? bound) is not BoundUserInstanceCallExpression uic {
            return bound
        }
        let declaringType StructSymbol? = uic.Method.ReceiverType as StructSymbol ?? searchBase
        if declaringType == nil {
            return BoundErrorExpression(nil)
        }
        let baseCall = BoundBaseClassCallExpression(
            ce,
            uic.Receiver,
            declaringType,
            uic.Method,
            uic.Arguments,
            uic.Type
        ){MethodTypeArguments = uic.MethodTypeArguments}
        return if completedSuspendingCall != nil {
            CompleteSuspendingCall(baseCall, bound.Type, ce.Location, method.Name)
        } else {
            cast[BoundExpression](baseCall)
        }
    }

    /// Issue #3724: binds the argument list of a `base.M(args)` call.
    ///
    /// Both base-call paths used to bind every argument with the plain
    /// `BindExpression`, which has no `ref`/`out` arm —
    /// it reaches the "an inline out declaration is only allowed at an out
    /// parameter position" guard (GS0236) and answers a bound error. That error
    /// then failed overload resolution, so a user base call surfaced GS0130 and
    /// an imported base call surfaced GS0384 ("does not declare an accessible
    /// method"), each followed by a GS0238 definite-assignment cascade on the
    /// caller's own `out` parameter. Every other call site in the binder
    /// routes a (cref:RefArgumentExpressionSyntax) through
    /// (cref:BindRefArgumentExpression); base calls now do the same.
    ///
    /// The parameter is not known during this first pass (the overload is picked
    /// from the resulting argument types), so inline `out var`/`out let`
    /// payloads bind against their declared type and are patched up by the shared
    /// instance-call pipeline afterwards — exactly as in
    /// `OverloadResolver.BindCallExpression`.
    /// @param ce The method-call syntax whose arguments to bind.
    /// @returns The bound arguments, in source order.
    private func BindBaseCallArguments(ce CallExpressionSyntax) ImmutableArray[BoundExpression] {
        let boundArguments = ImmutableArray.CreateBuilder[BoundExpression](ce.Arguments.Count)
        for argument in ce.Arguments {
            let argSyntax = OverloadResolver.UnwrapNamedArgumentValue(argument)
            boundArguments.Add(
                if argSyntax is RefArgumentExpressionSyntax refArgument {
                    BindRefArgumentExpression(refArgument, parameter: nil)
                } else {
                    BindExpression(argSyntax)
                }
            )
        }
        return boundArguments.ToImmutable()
    }

    /// Issue #1260: binds a `base.M(args)` call into an imported/BCL base
    /// class. Resolves the overload set against [`clrBase`](paramref)
    /// (which walks the CLR base chain), runs the shared imported-instance
    /// overload resolution, and produces a
    /// (cref:BoundImportedInstanceCallExpression) flagged as a non-virtual
    /// base call so the emitter writes `call` (not `callvirt`) — exactly
    /// like C# `base.M(...)`. A base call to an `abstract` BCL member
    /// (no implementation to delegate to) is reported as GS0413.
    /// @param ce The method-call syntax.
    /// @param methodName The invoked method name.
    /// @param clrBase The CLR base type to resolve the inherited member against.
    /// @param result The bound non-virtual base call (or an error node) when handled.
    /// @returns `true` when the call resolved (or a precise diagnostic was reported); `false` when no
    /// candidate member exists.
    private func TryBindBaseClrInstanceCall(
        ce CallExpressionSyntax,
        methodName string,
        clrBase Type?,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        let candidates = CollectBaseClrMethodCandidates(clrBase, methodName)
        if candidates.Count == 0 {
            return false
        }
        if !overloads.TryAnalyzeCallArgumentLayout(ce.Arguments, out _, out var argumentNames) {
            result = BoundErrorExpression(nil)
            return true
        }
        let arguments = BindBaseCallArguments(ce)
        if GetBaseAccessThisParameter() is not{} thisParameter {
            return false
        }
        let receiver = BoundVariableExpression(nil, thisParameter)
        return TryResolveAndBindClrInstanceCall(
            receiver,
            candidates,
            clrBase,
            methodName,
            arguments,
            ce,
            out result,
            explicitTypeArgs: nil,
            typeArgSymbols: default(ImmutableArray[TypeSymbol]),
            argumentNames: argumentNames,
            nonVirtualBaseCall: true,
            baseMemberLocation: ce.Identifier.Location
        )
    }

    /// The `this` a `base.Member` access binds against: the
    /// enclosing instance member's own, or, inside a function literal (whose
    /// synthetic symbol has no receiver), the enclosing member's `this`
    /// that the literal captures. `null` outside an instance
    /// member.
    /// @returns The receiver parameter, or `null`.
    private func GetBaseAccessThisParameter() ParameterSymbol? -> function?.ThisParameter ?? GetEffectiveThisParameter()

    /// Issue #1260: collects the candidate inherited CLR instance methods named
    /// [`methodName`](paramref) that are reachable for a `base.M(...)`
    /// call against [`clrBase`](paramref). Unlike the ordinary inherited-CLR
    /// lookup (public only), a base call may target a `protected` virtual
    /// member (e.g. `System.IO.Stream.Dispose(bool)`), so this includes
    /// non-public methods but excludes members a derived type cannot legally
    /// call via `base` (`private`, and other-assembly `internal`).
    /// @param clrBase The CLR base type to search (its base chain is walked by reflection).
    /// @param methodName The invoked method name.
    /// @returns The deduplicated candidate methods (most-derived signature wins).
    private func CollectBaseClrMethodCandidates(clrBase Type?, methodName string) IReadOnlyList[MethodInfo] {
        let result = List[MethodInfo]()
        if clrBase == nil {
            return result
        }
        for m in ClrTypeUtilities.SafeGetMethods(
            clrBase,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
        ) {
            if !string.Equals(m.Name, methodName, StringComparison.Ordinal) {
                continue
            }
            if !ClrMemberVisibility.IsVisibleFromDerived(m, CanAccessInternalsOf(m.DeclaringType)) {
                continue
            }
            if !MemberLookup.HasSameSignature(result, m) {
                result.Add(m)
            }
        }
        return result
    }

    /// Issue #1104 / #1260: resolves the base class to start a
    /// `base.Member` search from, shared by the base-method-call path
    /// ((cref:BindBaseClassCall)) and the base-property-access path
    /// ((cref:BindBaseClassPropertyRead) /
    /// (cref:BindBaseClassPropertyWrite)). Reports GS0383 when the call
    /// site is not an instance member of a class and GS0385 when a bracketed
    /// `base[Type]` selector does not name an actual base class.
    ///
    /// Issue #1260: a class with no GSharp base class still inherits the members
    /// of its imported/BCL base (or `System.Object`), so when there is no
    /// user (cref:StructSymbol) base this no longer reports GS0383.
    /// Instead it returns with [`searchBase`](paramref) `null`
    /// and [`clrBaseFallback`](paramref) set to the CLR base type to resolve
    /// inherited members against. [`clrBaseFallback`](paramref) is always
    /// non-`null` on success (defaulting to `typeof(object)`)
    /// so a multi-level user → user → BCL chain can fall back when the nearest
    /// user base does not declare the member.
    /// @param baseLocation The location of the `base` token (for GS0383).
    /// @param explicitBaseType The class named in `base[BaseClass]`, or `null` for the plain form.
    /// @param selectorLocation The location of the bracketed selector (for GS0385).
    /// @param searchBase The resolved GSharp base class to start the member search from, or `null` when the
    /// class derives only from an imported/BCL base.
    /// @param clrBaseFallback The CLR base type to resolve inherited BCL members against (issue #1260);
    /// always set on success.
    /// @returns `true` when the access site is a valid class instance member.
    private func TryResolveBaseSearchType(
        baseLocation TextLocation,
        explicitBaseType StructSymbol?,
        selectorLocation TextLocation,
        out searchBase StructSymbol?,
        out clrBaseFallback Type?
    ) bool {
        searchBase = nil
        clrBaseFallback = nil
        // The access site must live in an instance member of a class, or in a
        // function literal nested in one (a closure keeps its enclosing
        // member's `base`, as in C#). Top-level functions, `shared` statics,
        // and structs (no base class) all fail.
        let enclosingType StructSymbol? = GetBaseAccessThisParameter()?.Type as StructSymbol
        if enclosingType == nil || !enclosingType.IsClass {
            Diagnostics.ReportBaseClassCallHasNoBaseClass(baseLocation, EnclosingTypeDisplayName())
            return false
        }
        // Determine the base class to start the member search from. For the
        // bracketed form, the named selector must be an actual base class of
        // the enclosing type; for the plain form, use the immediate base.
        if explicitBaseType != nil {
            if !IsBaseClassOf(enclosingType, explicitBaseType) {
                Diagnostics.ReportBaseClassCallSelectorNotBaseClass(
                    selectorLocation,
                    enclosingType.Name,
                    explicitBaseType.Name
                )
                return false
            }
            searchBase = explicitBaseType
        } else {
            searchBase = enclosingType.BaseClass
        }
        // Issue #1260: the CLR base type used for inherited-BCL member lookup —
        // walk from the search base (or the enclosing type when there is no user
        // base) to the topmost user class and take its imported CLR base,
        // defaulting to System.Object so universally-inherited members
        // (ToString/Equals/GetHashCode/GetType) resolve.
        clrBaseFallback = ResolveClrBaseSearchType(searchBase ?? enclosingType)
        return true
    }

    /// Issue #1104: binds a base-class property READ of the form
    /// `base.Prop` (or the bracketed `base[BaseClass].Prop` form).
    /// Resolves `Prop` on the nearest base class's property set (walking
    /// grandparents) and wraps the property's getter accessor in a
    /// (cref:BoundBaseClassCallExpression) so the emitter produces a
    /// non-virtual `call instance R BaseClass::get_Prop()` — exactly like
    /// C# `base.Prop`. This lets an override reference the inherited member
    /// it shadows without re-entering its own getter (infinite recursion).
    /// @param member The member-name syntax (`Prop`).
    /// @param baseLocation The location of the `base` token for context diagnostics.
    /// @param explicitBaseType The class named in `base[BaseClass]`, or `null` for the plain form.
    /// @param selectorLocation The location of the bracketed selector (for GS0385).
    /// @returns The bound base-class property read, or a bound error on failure.
    private func BindBaseClassPropertyRead(
        member NameExpressionSyntax,
        baseLocation TextLocation,
        explicitBaseType StructSymbol?,
        selectorLocation TextLocation
    ) BoundExpression {
        if !TryResolveBaseSearchType(
            baseLocation,
            explicitBaseType,
            selectorLocation,
            out var searchBase,
            out var clrBaseFallback
        ) {
            return BoundErrorExpression(nil)
        }
        let memberName = member.IdentifierToken.ValueText
        // Issue #4331 (base-field-access), Copilot review round (PR #4334):
        // field-before-property precedence, mirroring the ordinary
        // (non-`base.`) lookup order in
        // ExpressionBinder.Access.MemberLookup.cs — TryGetFieldIncludingInherited
        // is checked, and returned on success, BEFORE TryGetProperty is even
        // attempted there. That is NOT "nearest declaration wins regardless
        // of kind": TryGetProperty below walks searchBase's ENTIRE hierarchy
        // for a property before ever returning false, so this field check
        // must run first and unconditionally — nesting it inside
        // `!TryGetProperty(...)` let a same-named property on a DISTANT
        // ancestor incorrectly win over a field the IMMEDIATE base declares
        // (the bug the field-before-property regression test below covers).
        //
        // Fields are never virtually dispatched, so this needs no
        // non-virtual distinction — it produces the exact same
        // BoundFieldAccessExpression an ordinary `this.Field`/`obj.Field`
        // read would, just rooted at the resolved base type rather than the
        // most-derived one, so a field the derived class shadows still
        // reads the base's own storage.
        if searchBase != nil && TypeMemberModel.TryGetFieldIncludingInherited(
            searchBase,
            memberName,
            MemberQuery.Instance(MemberKinds.Field),
            out var baseField,
            out var baseFieldDeclaringType
        ) &&
            GetEffectiveThisParameter() is {} fieldReadThisParameter {
            if !AccessibilityChecker.IsAccessible(baseField!!.Accessibility, baseFieldDeclaringType, this.function) {
                Diagnostics.ReportMemberInaccessible(
                    member.IdentifierToken.Location,
                    baseField!!.Name,
                    baseFieldDeclaringType!!.Name,
                    baseField!!.Accessibility
                )
            }
            return BoundFieldAccessExpression(
                member,
                BoundVariableExpression(nil, fieldReadThisParameter),
                baseFieldDeclaringType,
                baseField!!
            )
        }
        if searchBase == nil || !TypeMemberModel.TryGetProperty(
            searchBase,
            memberName,
            out var prop,
            out var declaringType
        ) {
            // Issue #3501: `base.M` used as a method GROUP (an argument, a
            // `let` initializer, …) — the base declares a METHOD, not a
            // property. Bind the group over `this` with non-virtual dispatch
            // so the resulting delegate captures the BASE implementation,
            // exactly like C#'s `base.M` delegate conversion.
            let baseMethods = if searchBase != nil {
                TypeMemberModel.GetMethods(searchBase, memberName, MemberQuery.Instance(MemberKinds.Method))
            } else {
                ImmutableArray[FunctionSymbol].Empty
            }
            if !baseMethods.IsEmpty && GetEffectiveThisParameter() is {} baseGroupReceiver {
                return BuildInstanceMethodGroup(
                    BoundVariableExpression(nil, baseGroupReceiver),
                    baseMethods,
                    forceNonVirtualDispatch: true
                )
            }
            // Issue #1260: no GSharp base declares the property — fall back to the
            // imported/BCL base type so `base.Prop` reads the inherited member
            // non-virtually (e.g. a virtual/overridable BCL property).
            if TryBindBaseClrPropertyRead(member, clrBaseFallback, out var bclRead) {
                return bclRead!!
            }
            // Issue #4331: no GSharp/CLR base PROPERTY declares this name —
            // fall back to an inherited/imported CLR base FIELD (e.g.
            // RegexRunner.runtextpos), matching TryBindBaseClrPropertyRead's
            // sibling shape for fields.
            if TryBindBaseClrFieldRead(member, clrBaseFallback, out var bclFieldRead) {
                return bclFieldRead!!
            }
            Diagnostics.ReportBaseClassCallMemberNotFound(
                member.IdentifierToken.Location,
                searchBase?.Name ?? ClrTypeDisplayName(clrBaseFallback),
                memberName
            )
            return BoundErrorExpression(nil)
        }
        declaringType = Invariant.Required(
            declaringType,
            "a base-class property has a declaring type",
            expression: "declaringType"
        )
        if !prop!!.HasGetter {
            Diagnostics.ReportCannotAssign(member.IdentifierToken.Location, memberName)
            return BoundErrorExpression(nil)
        }
        // Issue #950 / #2044: enforce `protected`/`private` property access
        // against the declaring type.
        if !AccessibilityChecker.IsAccessible(prop!!.GetterAccessibility, declaringType, this.function) {
            Diagnostics.ReportMemberInaccessible(
                member.IdentifierToken.Location,
                prop!!.Name,
                declaringType.Name,
                prop!!.GetterAccessibility
            )
        }
        if GetBaseAccessThisParameter() is not{} thisParameter {
            return BoundErrorExpression(nil)
        }
        let receiver = BoundVariableExpression(nil, thisParameter)
        // Issue #1347: an auto-property has no getter FunctionSymbol — its
        // getter is a compiler-synthesized backing-field read. Route the base
        // access through the property so the emitter resolves the synthesized
        // `get_Prop` MethodDef and the interpreter reads the backing field,
        // rather than mis-binding the read as a write (GS0127).
        if prop!!.GetterSymbol == nil {
            return BoundBaseClassCallExpression(
                member,
                receiver,
                declaringType,
                method: nil,
                ImmutableArray[BoundExpression].Empty,
                prop!!.Type,
                property: prop,
                isSetterAccessor: false
            )
        }
        return BoundBaseClassCallExpression(
            member,
            receiver,
            declaringType,
            prop!!.GetterSymbol,
            ImmutableArray[BoundExpression].Empty,
            prop!!.Type
        )
    }

    /// Issue #1104: binds a base-class property WRITE of the form
    /// `base.Prop = value`. Resolves `Prop` on the nearest base
    /// class's property set (walking grandparents) and wraps the property's
    /// setter accessor in a (cref:BoundBaseClassCallExpression) so the
    /// emitter produces a non-virtual
    /// `call instance void BaseClass::set_Prop(value)`.
    /// @param memberName The property name.
    /// @param memberLocation The location of the property name token.
    /// @param baseLocation The location of the `base` token for context diagnostics.
    /// @param value The already-bound right-hand value expression.
    /// @param valueLocation The location of the value expression (for conversion diagnostics).
    /// @param equalsLocation The location of the `=` token (for GS cannot-assign).
    /// @param explicitBaseType The class named in `base[BaseClass]`, or `null` for the plain `base.Prop`
    /// form.
    /// @param selectorLocation The location of the bracketed selector (for GS0385); use
    /// [`baseLocation`](paramref) for the plain form.
    /// @returns The bound base-class property write, or a bound error on failure.
    private func BindBaseClassPropertyWrite(
        memberName string,
        memberLocation TextLocation,
        baseLocation TextLocation,
        value BoundExpression,
        valueLocation TextLocation,
        equalsLocation TextLocation,
        explicitBaseType StructSymbol?,
        selectorLocation TextLocation
    ) BoundExpression {
        if !TryResolveBaseSearchType(
            baseLocation,
            explicitBaseType,
            selectorLocation,
            out var searchBase,
            out var clrBaseFallback
        ) {
            return BoundErrorExpression(nil)
        }
        // Issue #4331 (base-field-access), Copilot review round (PR #4334):
        // field-before-property precedence — see the read-side twin in
        // BindBaseClassPropertyRead for why this must run BEFORE, and
        // unconditionally on, the TryGetProperty check below (that call
        // walks searchBase's entire hierarchy for a property before
        // returning false, so nesting this field check inside it would let
        // a distant ancestor's same-named property beat an immediate base's
        // field).
        if searchBase != nil && TypeMemberModel.TryGetFieldIncludingInherited(
            searchBase,
            memberName,
            MemberQuery.Instance(MemberKinds.Field),
            out var baseField,
            out var baseFieldDeclaringType
        ) {
            if !AccessibilityChecker.IsAccessible(baseField!!.Accessibility, baseFieldDeclaringType, this.function) {
                Diagnostics.ReportMemberInaccessible(
                    memberLocation,
                    baseField!!.Name,
                    baseFieldDeclaringType!!.Name,
                    baseField!!.Accessibility
                )
            }
            if baseField!!.IsReadOnly {
                Diagnostics.ReportCannotAssign(equalsLocation, memberName)
                return BoundErrorExpression(nil)
            }
            let baseFieldConverted = conversions.BindConversion(valueLocation, value, baseField!!.Type)
            if GetEffectiveThisParameter() is not{} fieldWriteThisParameter {
                return BoundErrorExpression(nil)
            }
            return BoundFieldAssignmentExpression(
                value.Syntax,
                fieldWriteThisParameter,
                baseFieldDeclaringType!!,
                baseField!!,
                baseFieldConverted
            )
        }
        if searchBase == nil || !TypeMemberModel.TryGetProperty(
            searchBase,
            memberName,
            out var prop,
            out var declaringType
        ) {
            // Issue #1260: no GSharp base declares the property — fall back to the
            // imported/BCL base type so `base.Prop = value` writes the inherited
            // member non-virtually.
            if TryBindBaseClrPropertyWrite(
                memberName,
                memberLocation,
                value,
                valueLocation,
                equalsLocation,
                clrBaseFallback,
                out var bclWrite
            ) {
                return bclWrite!!
            }
            // Issue #4331: no GSharp/CLR base PROPERTY declares this name —
            // fall back to an inherited/imported CLR base FIELD write.
            if TryBindBaseClrFieldWrite(
                memberName,
                memberLocation,
                value,
                valueLocation,
                equalsLocation,
                clrBaseFallback,
                out var bclFieldWrite
            ) {
                return bclFieldWrite!!
            }
            Diagnostics.ReportBaseClassCallMemberNotFound(
                memberLocation,
                searchBase?.Name ?? ClrTypeDisplayName(clrBaseFallback),
                memberName
            )
            return BoundErrorExpression(nil)
        }
        declaringType = Invariant.Required(
            declaringType,
            "a base-class property has a declaring type",
            expression: "declaringType"
        )
        if !prop!!.HasSetter {
            Diagnostics.ReportCannotAssign(equalsLocation, memberName)
            return BoundErrorExpression(nil)
        }
        // Issue #950 / #2044: enforce `protected`/`private` property
        // assignment against the declaring type.
        if !AccessibilityChecker.IsAccessible(prop!!.SetterAccessibility, declaringType, this.function) {
            Diagnostics.ReportMemberInaccessible(
                memberLocation,
                prop!!.Name,
                declaringType.Name,
                prop!!.SetterAccessibility
            )
        }
        let converted = conversions.BindConversion(valueLocation, value, prop!!.Type)
        if GetBaseAccessThisParameter() is not{} thisParameter {
            return BoundErrorExpression(nil)
        }
        let receiver = BoundVariableExpression(nil, thisParameter)
        // Issue #1347: an auto-property has no setter FunctionSymbol — its
        // setter is a compiler-synthesized backing-field write. Route the base
        // assignment through the property so the emitter resolves the
        // synthesized `set_Prop` MethodDef and the interpreter writes the
        // backing field.
        if prop!!.SetterSymbol == nil {
            return BoundBaseClassCallExpression(
                value.Syntax,
                receiver,
                declaringType,
                method: nil,
                ImmutableArray.Create(converted),
                TypeSymbol.Void,
                property: prop,
                isSetterAccessor: true
            )
        }
        return BoundBaseClassCallExpression(
            value.Syntax,
            receiver,
            declaringType,
            prop!!.SetterSymbol,
            ImmutableArray.Create(converted)
        )
    }

    /// Issue #1260: binds a `base.Prop` READ into an imported/BCL base
    /// class. Resolves the inherited CLR property's getter and wraps it in a
    /// non-virtual (cref:BoundImportedInstanceCallExpression) so the
    /// emitter produces `call instance R BaseClass::get_Prop()` — exactly
    /// like C# `base.Prop`. An `abstract` getter (no implementation)
    /// is reported as GS0413.
    /// @param member The member-name syntax (`Prop`).
    /// @param clrBase The CLR base type to resolve the inherited property against.
    /// @param result The bound non-virtual property read (or an error node) when handled.
    /// @returns `true` when a readable inherited property was found (or a precise diagnostic was reported).
    private func TryBindBaseClrPropertyRead(
        member NameExpressionSyntax,
        clrBase Type?,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        if clrBase == nil {
            return false
        }
        let memberName = member.IdentifierToken.ValueText
        let clrProp PropertyInfo? = ClrTypeUtilities.SafeGetInheritedInstanceProperty(
            clrBase,
            memberName,
            CanAccessInternalsOf
        )
        if clrProp == nil {
            return false
        }
        let getter MethodInfo? = GetVisibleGetter(clrProp, fromDerivedType: true)
        if getter == nil {
            return false
        }
        if getter.IsAbstract {
            Diagnostics.ReportBaseClassCallAbstractMember(
                member.IdentifierToken.Location,
                clrProp.DeclaringType?.Name ?? clrBase.Name,
                memberName
            )
            result = BoundErrorExpression(nil)
            return true
        }
        if GetBaseAccessThisParameter() is not{} thisParameter {
            return false
        }
        let receiver = BoundVariableExpression(nil, thisParameter)
        let propertyType = GetInheritedClrMemberType(thisParameter.Type, clrProp)
        result = BoundImportedInstanceCallExpression(
            member,
            receiver,
            getter,
            propertyType,
            ImmutableArray[BoundExpression].Empty,
            isNonVirtualBaseCall: true
        )
        return true
    }

    /// Issue #1260: binds a `base.Prop = value` WRITE into an imported/BCL
    /// base class. Resolves the inherited CLR property's setter and wraps it in a
    /// non-virtual (cref:BoundImportedInstanceCallExpression) so the
    /// emitter produces `call instance void BaseClass::set_Prop(value)`.
    /// An `abstract` setter (no implementation) is reported as GS0413.
    /// @param memberName The property name.
    /// @param memberLocation The location of the property name token.
    /// @param value The already-bound right-hand value expression.
    /// @param valueLocation The location of the value expression (for conversion diagnostics).
    /// @param equalsLocation The location of the `=` token (for GS cannot-assign).
    /// @param clrBase The CLR base type to resolve the inherited property against.
    /// @param result The bound non-virtual property write (or an error node) when handled.
    /// @returns `true` when a writable inherited property was found (or a precise diagnostic was reported).
    private func TryBindBaseClrPropertyWrite(
        memberName string,
        memberLocation TextLocation,
        value BoundExpression,
        valueLocation TextLocation,
        equalsLocation TextLocation,
        clrBase Type?,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        if clrBase == nil {
            return false
        }
        let clrProp PropertyInfo? = ClrTypeUtilities.SafeGetInheritedInstanceProperty(
            clrBase,
            memberName,
            CanAccessInternalsOf
        )
        if clrProp == nil {
            return false
        }
        if !clrProp.CanWrite {
            Diagnostics.ReportCannotAssign(equalsLocation, memberName)
            result = BoundErrorExpression(nil)
            return true
        }
        let setter MethodInfo? = GetVisibleSetter(clrProp, fromDerivedType: true)
        if setter == nil {
            Diagnostics.ReportCannotAssign(equalsLocation, memberName)
            result = BoundErrorExpression(nil)
            return true
        }
        if setter.IsAbstract {
            Diagnostics.ReportBaseClassCallAbstractMember(
                memberLocation,
                clrProp.DeclaringType?.Name ?? clrBase.Name,
                memberName
            )
            result = BoundErrorExpression(nil)
            return true
        }
        if GetBaseAccessThisParameter() is not{} thisParameter {
            return false
        }
        let propertyType = GetInheritedClrMemberType(thisParameter.Type, clrProp)
        let converted = conversions.BindConversion(valueLocation, value, propertyType)
        let receiver = BoundVariableExpression(nil, thisParameter)
        result = BoundImportedInstanceCallExpression(
            value.Syntax,
            receiver,
            setter,
            TypeSymbol.Void,
            ImmutableArray.Create(converted),
            isNonVirtualBaseCall: true
        )
        return true
    }

    /// Issue #4331 (base-field-access): binds a `base.Field` READ into an
    /// imported/BCL base class FIELD (as opposed to a property — see
    /// (cref:TryBindBaseClrPropertyRead)). Fields are never virtually
    /// dispatched, so unlike the method/property base-call paths this needs no
    /// non-virtual distinction at emission time: it produces the exact same
    /// (cref:BoundClrPropertyAccessExpression) that an ordinary
    /// inherited-CLR-field read already does (see
    /// (cref:TryBindInheritedClrInstanceMemberByBareName)) — the only
    /// "base" semantics needed is resolving the field starting from
    /// [`clrBase`](paramref) (the nearest base type) rather than the
    /// most-derived receiver type, matching C#'s `base.Field` shadowing
    /// semantics.
    /// @param member The member-name syntax (`Field`).
    /// @param clrBase The CLR base type to resolve the inherited field against.
    /// @param result The bound field read (or an error node) when handled.
    /// @returns `true` when a readable inherited field was found (or a precise diagnostic was reported).
    private func TryBindBaseClrFieldRead(
        member NameExpressionSyntax,
        clrBase Type?,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        if clrBase == nil {
            return false
        }
        let memberName = member.IdentifierToken.ValueText
        let clrField FieldInfo? = ClrTypeUtilities.SafeGetInheritedInstanceField(
            clrBase,
            memberName,
            CanAccessInternalsOf
        )
        if clrField == nil {
            return false
        }
        if GetBaseAccessThisParameter() is not{} thisParameter {
            return false
        }
        let receiver = BoundVariableExpression(nil, thisParameter)
        result = BoundClrPropertyAccessExpression(
            member,
            receiver,
            clrField,
            GetInheritedClrMemberType(thisParameter.Type, clrField)
        )
        return true
    }

    /// Issue #4331: binds a `base.Field = value` WRITE into an
    /// imported/BCL base class FIELD. See (cref:TryBindBaseClrFieldRead)
    /// for why fields need no non-virtual emission distinction. A readonly
    /// (`InitOnly`) or literal (`const`) field is reported as
    /// cannot-assign, matching the ordinary inherited-field write path
    /// ((cref:TryGetWritableClrMember(MemberInfo?, TypeSymbol?, out Type?, out TypeSymbol?, out bool,
    /// bool))).
    /// @param memberName The field name.
    /// @param memberLocation The location of the field name token, for diagnostics.
    /// @param value The already-bound right-hand value expression.
    /// @param valueLocation The location of the value expression (for conversion diagnostics).
    /// @param equalsLocation The location of the `=` token (for GS cannot-assign).
    /// @param clrBase The CLR base type to resolve the inherited field against.
    /// @param result The bound field write (or an error node) when handled.
    /// @returns `true` when a writable inherited field was found (or a precise diagnostic was reported).
    private func TryBindBaseClrFieldWrite(
        memberName string,
        memberLocation TextLocation,
        value BoundExpression,
        valueLocation TextLocation,
        equalsLocation TextLocation,
        clrBase Type?,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        if clrBase == nil {
            return false
        }
        let clrField FieldInfo? = ClrTypeUtilities.SafeGetInheritedInstanceField(
            clrBase,
            memberName,
            CanAccessInternalsOf
        )
        if clrField == nil {
            return false
        }
        if clrField.IsInitOnly || clrField.IsLiteral {
            Diagnostics.ReportCannotAssign(equalsLocation, memberName)
            result = BoundErrorExpression(nil)
            return true
        }
        if GetBaseAccessThisParameter() is not{} thisParameter {
            return false
        }
        let fieldType = GetInheritedClrMemberType(thisParameter.Type, clrField)
        let converted = conversions.BindConversion(valueLocation, value, fieldType)
        let receiver = BoundVariableExpression(nil, thisParameter)
        result = BoundClrPropertyAssignmentExpression(
            value.Syntax,
            receiver,
            clrField,
            converted,
            fieldType,
            staticContainerType: nil
        )
        return true
    }

    /// Issue #943 / #3394: binds an instance call dispatched through a type
    /// parameter's imported CLR interface or base-class constraint (for example,
    /// `a.CompareTo(b)` with `T : IComparable[T]`, or
    /// `m.GetParameters()` with `T : MethodBase`). The method is
    /// resolved against the constraint's CLR type; the resulting
    /// (cref:BoundImportedInstanceCallExpression) carries the constrained
    /// type parameter and the symbolic interface type so the emitter produces a
    /// verifiable `constrained. !!T callvirt` sequence with the
    /// `MemberRef` parented at the constructed interface
    /// (`IComparable`1<!!T>::CompareTo(!0)`).
    /// @param receiver The bound receiver (its type is the constrained type parameter).
    /// @param tp The receiver's type parameter, carrying the CLR constraint.
    /// @param methodName The invoked method name.
    /// @param arguments The bound argument expressions.
    /// @param ce The originating call-expression syntax.
    /// @param argumentNames Optional named-argument labels in source order.
    /// @param result The bound constrained call on success.
    /// @returns `true` when a matching constrained method was found and bound.
    private func TryBindConstrainedClrCall(
        receiver BoundExpression,
        tp TypeParameterSymbol,
        methodName string,
        arguments ImmutableArray[BoundExpression],
        ce CallExpressionSyntax,
        argumentNames ImmutableArray[string],
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        var arguments = arguments
        result = nil
        let constraintType TypeSymbol? = tp.ClrInterfaceConstraint ?? tp.ClassConstraint
        let clrType Type? = constraintType?.ClrType
        if constraintType == nil || clrType == nil {
            return false
        }
        let candidates = List[MethodInfo](MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(clrType, methodName))
        if candidates.Count == 0 {
            return false
        }
        let argTypes = [arguments.Length]Type?
        for var i = 0; i < arguments.Length; i++ {
            let t Type? = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type)
            if t == nil && arguments[i].Type != TypeSymbol.Null {
                // Issue #2347: defer an unresolved method-group argument (see
                // TryBindImportedExtensionCall) instead of failing outright.
                if !ClrOverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]) {
                    return false
                }
            }
            argTypes[i] = t
        }
        // Issue #1852 (follow-up from #1812 N1): mark which positional
        // arguments are interpolated-string literals so overload resolution
        // treats them as applicable to an IFormattable/FormattableString (or
        // handler) parameter, just like every other CLR-call Resolve site.
        let interpolatedStringArgs = ComputeInterpolatedStringArgFlags(ce.Arguments, arguments.Length)
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
                argumentNames: if argumentNames.IsDefault {
                    default(IReadOnlyList[string?]?)
                } else {
                    cast[IReadOnlyList[string?]](argumentNames)
                },
                parameterMapping: default(ImmutableArray[int32]),
                methodGroupSlots: out var recoverConstrainedMethodGroupSlots
            )
            // Issue #4133 (hot-core translation guard finding): see
            // MergeMethodGroupArgumentSlots's doc.
            recoverConstrainedMethodGroupSlots = MergeMethodGroupArgumentSlots(
                arguments,
                receiverArgCount: 0,
                refinedArgs.Length,
                recoverConstrainedMethodGroupSlots
            )
            return MemberLookup.BuildSymbolicMethodTypeArgs(
                closed,
                default(ImmutableArray[TypeSymbol]),
                refinedArgs,
                isExpanded,
                if argumentNames.IsDefault {
                    default(IReadOnlyList[string?]?)
                } else {
                    cast[IReadOnlyList[string?]](argumentNames)
                },
                recoverConstrainedMethodGroupSlots
            )
        }
        let resolution = ClrOverloadResolution.Resolve(
            candidates,
            argTypes,
            nil,
            $scope.References!!.MapClrTypeToReferences,
            interpolatedStringArgs,
            if argumentNames.IsDefault {
                default(IReadOnlyList[string]?)
            } else {
                cast[IReadOnlyList[string]](argumentNames)
            },
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
                ce.Location,
                methodName,
                resolution.Ambiguous.Length,
                resolution.Ambiguous.Select(ClrOverloadResolution.FormatMethodSignature)
            )
            result = BoundErrorExpression(ce)
            return true
        }
        if resolution.Outcome != ClrOverloadResolution.ResolutionOutcome.Resolved {
            return false
        }
        if resolution.Best is not{} method {
            return false
        }
        let parameters = method.GetParameters()
        let symbolicMethodTypeArgs = recoverTypeArgSymbols(method, resolution.IsExpanded)
        // Return type: a return that names the constraint type-variable is
        // recovered by projecting through the constructed constraint;
        // a concrete return (e.g. IComparable.CompareTo -> int32) falls back to
        // the direct CLR mapping.
        let returnType = MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(
            method,
            symbolicMethodTypeArgs,
            constraintType
        ) ??
            MemberLookup.GetClrMethodReturnTypeSymbol(constraintType, method)
        let declaringConstraint = MemberLookup.GetClrMemberDeclaringTypeSymbol(constraintType, method)
        var downstreamMapping = resolution.ParameterMapping
        let expandedArgumentLocations = CaptureExpandedArgumentLocations(
            ce,
            arguments.Length,
            downstreamMapping,
            parameters.Length,
            receiverArgCount: 0,
            resolution.IsExpanded
        )
        arguments = RebindFormattableInterpolationArguments(
            arguments,
            ce.Arguments,
            parameters,
            downstreamMapping,
            isExpanded: resolution.IsExpanded
        )
        // Reviewer finding on #4142: expanded resolution can select a
        // `params Handler[]` candidate for a custom
        // [InterpolatedStringHandler] element, but this constrained path
        // only rebound FormattableString above. Without this step a
        // handler-typed params element still carries an ordinary string
        // interpolation into ExpandParamsArguments and fails conversion
        // (measured: GS0155 "Cannot convert type 'string' to
        // '<Handler>'"). Route it through the shared rewrite, BEFORE
        // expansion, same as every other resolved CLR call dispatch
        // (BuildResolvedClrCallArguments). The receiver here is the real
        // instance expression, not a synthesized one, so the
        // prelude/updated-receiver outputs (relevant only to a synthesized
        // extension receiver forwarded into a handler constructor) are
        // discarded through the convenience overload.
        arguments = ApplyInterpolatedStringHandlers(
            parameters,
            arguments,
            receiver,
            ce.Location,
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
                ce,
                parameterMapping: downstreamMapping,
                symbolicMethodTypeArgs: symbolicMethodTypeArgs,
                paramsElementTypeOverride: symbolicParamsElement
            )
            downstreamMapping = default(ImmutableArray[int32])
        }
        // Issue #1852: interpolated-string arguments are re-lowered above
        // before params expansion keeps source syntax and source slots aligned,
        // WITHOUT routing through the rest of
        // BuildResolvedClrCallArguments (delegate rebind,
        // BindClrParameterConversions). This path deliberately skips the CLR
        // boxing/conversion pass below (see the "deliberately skip" comment
        // on orderedArgs): the emitted MemberRef parameter is the interface
        // type-variable `!0`, passed unconverted, so routing every argument
        // through the conversion pipeline would risk an ilverify mismatch.
        // Only the specific interpolated-string arguments actually bound to
        // a handler parameter are touched; every other argument (and the
        // overload choice itself, unaffected unless a candidate's
        // applicability actually depended on the flag) is unchanged.
        arguments = ApplySymbolicClrArgumentConversions(
            arguments,
            parameters,
            downstreamMapping,
            method,
            constraintType,
            symbolicMethodTypeArgs
        )
        // Non-generic constrained slots stay on the established unconverted
        // path: the emitted MemberRef parameter is the interface type-variable
        // `!0` (== the reified `!!T`). A generic method needs its recovered
        // method arguments during conversion too, so `Take<U>(U)` reifies U as
        // the caller's T and does not box it to the reflection-time `object`.
        arguments = if method.IsGenericMethod {
            conversions.BindClrParameterConversions(
                arguments,
                parameters,
                ce,
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
                ce,
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
        result = BoundImportedInstanceCallExpression(
            ce,
            receiver,
            method,
            returnType,
            orderedArgs,
            refKinds,
            symbolicMethodTypeArgs,
            constrainedReceiverTypeParameter: tp,
            constrainedInterfaceType: declaringConstraint
        )
        return true
    }

    /// Issue #4054: a constrained CLR dispatch through a type-parameter
    /// receiver still has to apply the USER-DEFINED implicit conversion a
    /// same-compilation argument needs to reach the parameter type. Without
    /// it the argument is pushed unconverted and the emitted call does not
    /// verify — `[StackUnexpected] [found value 'P.Celsius'][expected
    /// Double]` and three sibling shapes, measured.
    private func ApplySymbolicClrArgumentConversions(
        arguments ImmutableArray[BoundExpression],
        parameters[]ParameterInfo,
        parameterMapping ImmutableArray[int32],
        method MethodInfo,
        constraintType TypeSymbol,
        symbolicMethodTypeArgs ImmutableArray[TypeSymbol?]
    ) ImmutableArray[BoundExpression] {
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < arguments.Length; i++ {
            let parameterIndex = if parameterMapping.IsDefault {
                i
            } else {
                parameterMapping[i]
            }
            if parameterIndex >= parameters.Length || parameters[parameterIndex].ParameterType.IsByRef {
                continue
            }
            let argument = arguments[i]
            let targetType TypeSymbol? = MemberLookup.GetClrMethodParameterConversionTargetTypeSymbol(
                constraintType,
                method,
                parameterIndex,
                symbolicMethodTypeArgs
            ) ??
                MemberLookup.GetClrMethodParameterTypeSymbol(constraintType, method, parameterIndex)
            if argument.Type is not{} sourceType ||
                sourceType.ClrType != nil ||
                !TypeSymbol.ContainsSameCompilationUserType(sourceType) ||
                targetType == nil ||
                targetType == TypeSymbol.Error ||
                TypeSymbol.ContainsTypeParameter(targetType) {
                continue
            }
            let conversion = Conversion.Classify(sourceType, targetType)
            var converted BoundExpression
            if conversion.IsImplicit && !conversion.IsStructuralProjection {
                converted = conversions.BindConversion(
                    argument.Syntax?.Location ?? default(TextLocation),
                    argument,
                    targetType
                )
            } else if !conversions.TryApplyUserDefinedImplicitArgumentConversion(argument, targetType, out converted) {
                continue
            }
            builder ??= arguments.ToBuilder()
            builder!![i] = converted
        }
        return builder?.MoveToImmutable() ?? arguments
    }

    /// Issue #1550: binds a call to a universal (cref:object) instance
    /// member (`ToString`, `GetHashCode`, `Equals(object)`,
    /// `GetType`) dispatched through ANY type-parameter receiver, even one
    /// without a matching user/CLR constraint. The method is resolved against
    /// `typeof(object)`; the resulting
    /// (cref:BoundImportedInstanceCallExpression) carries the constrained
    /// type parameter (and a `null` constrained interface type,
    /// so the emitted `MemberRef` is parented at `System.Object`) so
    /// the emitter produces a verifiable
    /// `constrained. !!T callvirt System.Object::Method(...)` sequence.
    /// The `constrained.` prefix dispatches to any override for value,
    /// struct/enum-constrained and reference type parameters alike without a
    /// manual box.
    /// @param receiver The bound receiver (its type is the constrained type parameter).
    /// @param tp The receiver's type parameter.
    /// @param methodName The invoked method name.
    /// @param arguments The bound argument expressions.
    /// @param ce The originating call-expression syntax.
    /// @param argumentNames Optional named-argument labels in source order.
    /// @param result The bound constrained call on success.
    /// @returns `true` when a matching object member was found and bound.
    private func TryBindConstrainedObjectMemberCall(
        receiver BoundExpression,
        tp TypeParameterSymbol,
        methodName string,
        arguments ImmutableArray[BoundExpression],
        ce CallExpressionSyntax,
        argumentNames ImmutableArray[string],
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        let candidates = List[MethodInfo](
            MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(object), methodName)
        )
        if candidates.Count == 0 {
            return false
        }
        let argTypes = [arguments.Length]Type?
        for var i = 0; i < arguments.Length; i++ {
            let t Type? = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type)
            if t == nil && arguments[i].Type != TypeSymbol.Null {
                // Issue #2347: defer an unresolved method-group argument (see
                // TryBindImportedExtensionCall) instead of failing outright.
                if !ClrOverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]) {
                    return false
                }
            }
            argTypes[i] = t
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
        let resolution = ClrOverloadResolution.Resolve(
            candidates,
            argTypes,
            nil,
            $scope.References!!.MapClrTypeToReferences,
            nil,
            if argumentNames.IsDefault {
                default(IReadOnlyList[string]?)
            } else {
                cast[IReadOnlyList[string]](argumentNames)
            }
        )
        if resolution.Outcome == ClrOverloadResolution.ResolutionOutcome.Ambiguous {
            Diagnostics.ReportAmbiguousOverload(
                ce.Location,
                methodName,
                resolution.Ambiguous.Length,
                resolution.Ambiguous.Select(ClrOverloadResolution.FormatMethodSignature)
            )
            result = BoundErrorExpression(ce)
            return true
        }
        if resolution.Outcome != ClrOverloadResolution.ResolutionOutcome.Resolved {
            return false
        }
        if resolution.Best is not{} method {
            return false
        }
        let parameters = method.GetParameters()
        // A concrete object member has a concrete return type (string / int32 /
        // bool / System.Type). Resolve it nullable-obliviously: the receiver is
        // an erased type parameter (ADR-0004 / #313), so the BCL's `string?`
        // annotation on `object.ToString()` must not leak a spurious nullable
        // return into the generic context (which would reject the common
        // `func Show[T struct]() string -> v.ToString()` shape with GS0156).
        let returnType = ClrNullability.GetReturnTypeSymbol(method).StripToBareShape()
        // Unlike the CLR-interface path, the parameter of a matched object
        // member (e.g. Equals(object)) is a real System.Object, so a `T`-typed
        // argument must be boxed. Run the normal CLR conversion pass so the
        // emitter widens (boxes) the `!!T` value to object.
        let mapping = resolution.ParameterMapping
        let convertedArgs = conversions.BindClrParameterConversions(
            arguments,
            parameters,
            ce,
            mapping,
            method: method,
            receiverType: receiver.Type
        )
        let orderedArgs = OverloadResolver.BuildOrderedCallArguments(convertedArgs, mapping, parameters)
        let refKinds = ComputeArgumentRefKinds(parameters)
        result = BoundImportedInstanceCallExpression(
            ce,
            receiver,
            method,
            returnType,
            orderedArgs,
            refKinds,
            default(ImmutableArray[TypeSymbol?]),
            constrainedReceiverTypeParameter: tp,
            constrainedInterfaceType: nil
        )
        return true
    }

    /// Issue #2304: binds a call to a universal (cref:object) instance
    /// member (`ToString`, `GetHashCode`, `Equals(object)`,
    /// `GetType`) dispatched through an INTERFACE-typed receiver — either
    /// a source-declared (cref:InterfaceSymbol) (whose `ClrType` is
    /// still `null` at bind time) or an imported interface
    /// (an (cref:ImportedTypeSymbol) whose `ClrType.IsInterface` is
    /// `true`). Every interface implicitly derives from
    /// (cref:object) at the CLR/C# layer for member-access purposes —
    /// `Type.GetMethods()` on an interface type never reports it, though,
    /// so the shared CLR-instance-method enumeration (which walks only an
    /// interface's own transitive base interfaces) never finds these names and
    /// the call otherwise dead-ends at `GS0159`.
    /// @remarks Unlike (cref:TryBindConstrainedObjectMemberCall) (used for an
    /// erased type-parameter receiver), no `constrained.` prefix is
    /// needed here: an interface-typed receiver is ALWAYS a genuine managed
    /// reference at the CLR level (never an unboxed value), so a plain
    /// `callvirt System.Object::Method(...)` against that reference is
    /// already verifiable and dispatches to the runtime type's override.
    /// @param receiver The bound receiver (its static type is the interface).
    /// @param methodName The invoked method name.
    /// @param arguments The bound argument expressions.
    /// @param ce The originating call-expression syntax.
    /// @param argumentNames Optional named-argument labels in source order.
    /// @param result The bound call on success.
    /// @returns `true` when a matching object member was found and bound.
    private func TryBindInterfaceObjectMemberCall(
        receiver BoundExpression,
        methodName string,
        arguments ImmutableArray[BoundExpression],
        ce CallExpressionSyntax,
        argumentNames ImmutableArray[string],
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        let candidates = List[MethodInfo](
            MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(object), methodName)
        )
        if candidates.Count == 0 {
            return false
        }
        let argTypes = [arguments.Length]Type?
        for var i = 0; i < arguments.Length; i++ {
            let t Type? = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type)
            if t == nil && arguments[i].Type != TypeSymbol.Null {
                // Issue #2347: defer an unresolved method-group argument (see
                // TryBindImportedExtensionCall) instead of failing outright.
                if !ClrOverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]) {
                    return false
                }
            }
            argTypes[i] = t
        }
        // Constant-narrowing is intentionally omitted: the only object member
        // with an argument is Equals(object), so there is no narrower integer
        // parameter for §10.2.11 to target.
        let resolution = ClrOverloadResolution.Resolve(
            candidates,
            argTypes,
            nil,
            $scope.References!!.MapClrTypeToReferences,
            nil,
            if argumentNames.IsDefault {
                default(IReadOnlyList[string]?)
            } else {
                cast[IReadOnlyList[string]](argumentNames)
            }
        )
        if resolution.Outcome != ClrOverloadResolution.ResolutionOutcome.Resolved {
            return false
        }
        if resolution.Best is not{} method {
            return false
        }
        let parameters = method.GetParameters()
        // Read nullable-obliviously, as the object-member path above does: the
        // receiver is an erased type parameter.
        let returnType = ClrNullability.GetReturnTypeSymbol(method).StripToBareShape()
        let mapping = resolution.ParameterMapping
        let convertedArgs = conversions.BindClrParameterConversions(
            arguments,
            parameters,
            ce,
            mapping,
            method: method,
            receiverType: receiver.Type
        )
        let orderedArgs = OverloadResolver.BuildOrderedCallArguments(convertedArgs, mapping, parameters)
        let refKinds = ComputeArgumentRefKinds(parameters)
        result = BoundImportedInstanceCallExpression(
            ce,
            receiver,
            method,
            returnType,
            orderedArgs,
            refKinds,
            default(ImmutableArray[TypeSymbol?]),
            constrainedReceiverTypeParameter: nil,
            constrainedInterfaceType: nil
        )
        return true
    }

    shared {
        /// Issue #2193: a delegate-reshaping implicit conversion (rank ≥
        /// (cref:ClrOverloadResolution.ImplicitConversionKind.LambdaToVoidDelegate)
        /// and ≤
        /// (cref:ClrOverloadResolution.ImplicitConversionKind.DelegateReturnNumericWidening))
        /// reshapes a G# function value to satisfy a differently-shaped or
        /// differently-named CLR delegate parameter (discarding a return value,
        /// widening/covarying a return type, or retargeting to a named delegate).
        /// These are the "worst"-ranked conversions and are the loose applicability
        /// that lets a same-named BCL instance method shadow an exact user extension.
        private func IsDelegateReshapingConversion(kind ClrOverloadResolution.ImplicitConversionKind) bool {
            return kind == ClrOverloadResolution
                .ImplicitConversionKind
                .LambdaToVoidDelegate ||
                kind == ClrOverloadResolution
                .ImplicitConversionKind
                .DelegateReturnCovariance ||
                kind == ClrOverloadResolution
                .ImplicitConversionKind
                .DelegateStructuralMatch ||
                kind == ClrOverloadResolution
                .ImplicitConversionKind
                .DelegateReturnNumericWidening
        }

        /// Issue #2193: classifies each supplied argument against the corresponding
        /// parameter of a resolved CLR candidate and returns the <em>worst</em>
        /// (highest-ordinal) implicit-conversion rank across all arguments. Returns
        /// (cref:ClrOverloadResolution.ImplicitConversionKind.None) when the
        /// arities do not line up positionally (the candidate matched in an expanded
        /// / named / defaulted form this cheap check cannot reason about, so the
        /// tie-break is skipped and the instance method keeps winning).
        private func ComputeClrCandidateWorstConversionRank(candidate MethodInfo, argTypes[]Type?) ClrOverloadResolution
            .ImplicitConversionKind {
            let parameters = candidate.GetParameters()
            if parameters.Length != argTypes.Length {
                return ClrOverloadResolution.ImplicitConversionKind.None
            }
            var worst = ClrOverloadResolution.ImplicitConversionKind.Identity
            for var i = 0; i < argTypes.Length; i++ {
                let kind = ClrOverloadResolution.ClassifyImplicit(parameters[i].ParameterType, argTypes[i])
                if kind == ClrOverloadResolution.ImplicitConversionKind.None {
                    return ClrOverloadResolution.ImplicitConversionKind.None
                }
                if int32(kind) > int32(worst) {
                    worst = kind
                }
            }
            return worst
        }

        /// Issue #3880: whether a bracketed list is the one shape where the
        /// ADR-0020 generic-call-site commitment is genuinely ambiguous with an
        /// indexer — a single bare identifier. Everything a type clause can spell
        /// that an index expression cannot (`T?`, `[]T`, `List[T]`,
        /// a qualified name, a tuple, a function type) stays unambiguously a type
        /// argument.
        /// @param typeArgumentList The bracketed list from the call site.
        /// @returns `true` when the bracket could equally be an index.
        private func IsAmbiguousSingleIdentifierTypeArgument(typeArgumentList TypeArgumentListSyntax?) bool {
            if typeArgumentList is not{} bracketed || bracketed.Arguments.Count != 1 {
                return false
            }
            let item = bracketed.Arguments[0]
            return item.Identifier != nil &&
                !item.HasQualifier &&
                !item.IsArray &&
                !item.IsNullable &&
                !item.IsTuple &&
                item.FuncKeyword == nil &&
                item.TypeArguments is not{Count: > 0}
        }

        /// Issue #3880: whether [`receiverType`](paramref) has a readable
        /// VALUE member (field or property) named [`memberName`](paramref) —
        /// the precondition for reading `receiver.Member[i](args)` as
        /// indexer-then-invoke rather than as a generic method call.
        /// @param receiverType The receiver's type.
        /// @param memberName The member name at the call site.
        /// @returns `true` when such a member exists.
        private func HasCallableIndexableValueMember(receiverType TypeSymbol, memberName string) bool {
            if receiverType is StructSymbol structSymbol {
                for current in structSymbol.GetHierarchy() {
                    if current.TryGetField(memberName, out _) {
                        return true
                    }
                }
            }
            if TypeMemberModel.TryGetPropertyWithOwner(receiverType, memberName, out var property, out _) &&
                property != nil &&
                property.HasGetter == true {
                return true
            }
            // Issue #3880: the parser ambiguity this recovery exists for is
            // receiver-AGNOSTIC — `x.Callbacks[key]()` reads identically whether
            // `Callbacks` is declared in this compilation or comes from a
            // referenced assembly. Recognising only source members would make the
            // feature work or not purely by where the receiver was declared, which
            // is not something a user can reason about from the call site. So the
            // imported CLR field/property shapes are recognised on the same terms
            // TryBindClrDelegateMemberInvocation uses: a readable non-indexer
            // property first, then a field.
            if receiverType.ClrType is {} receiverClrType {
                let clrProperty = ClrTypeUtilities.SafeGetProperty(
                    receiverClrType,
                    memberName,
                    BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static
                )
                if clrProperty != nil && clrProperty.CanRead == true && clrProperty.GetIndexParameters().Length == 0 {
                    return true
                }
                if ClrTypeUtilities.SafeGetField(
                    receiverClrType,
                    memberName,
                    BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static
                ) != nil {
                    return true
                }
            }
            return false
        }

        /// Issue #1423: projects a user-declared class to the implemented CLR
        /// interface best suited to drive extension-method receiver matching and
        /// generic inference. Prefers an implemented interface that is, or extends,
        /// `IEnumerable<T>` (so LINQ-style extensions whose `this`
        /// self-parameter is `IEnumerable<TSource>` bind and infer
        /// `TSource`), choosing the most-derived such interface so any
        /// methods declared on the richer interface remain reachable. Falls back to
        /// the first implemented CLR interface so non-collection extensions can
        /// still match an interface receiver.
        ///
        /// Issue #3745: the same projection is reused for ORDINARY arguments by
        /// (cref:TryProjectUserClassArgumentInterfaces), but only after
        /// overload resolution has already failed with the erased shapes.
        /// @param userClass The user-declared class receiver or argument.
        /// @param clrInterface The projected CLR interface type, on success.
        /// @returns `true` when an implemented CLR interface was found.
        private func TryProjectUserClassReceiverInterface(
            userClass StructSymbol,
            @NotNullWhen(true) out clrInterface Type?
        ) bool {
            clrInterface = nil
            if userClass.ImplementedClrInterfaces.IsDefaultOrEmpty {
                return false
            }
            var firstInterface Type? = nil
            var bestEnumerable Type? = nil
            for implemented in userClass.ImplementedClrInterfaces {
                let clr Type? = implemented?.ClrType
                if clr == nil || !clr.IsInterface {
                    continue
                }
                firstInterface ??= clr
                // A generic collection interface (IReadOnlyCollection<T>,
                // ICollection<T>, IList<T>, IEnumerable<T>, …) exposes
                // IEnumerable<T> through its base interfaces, letting overload
                // resolution recover the element type. Prefer the most-derived
                // such interface (the one whose interface set is largest).
                if ImplementsGenericEnumerable(clr) &&
                    (bestEnumerable == nil || SafeInterfaceCount(clr) > SafeInterfaceCount(bestEnumerable)) {
                    bestEnumerable = clr
                }
            }
            clrInterface = bestEnumerable ?? firstInterface
            return clrInterface != nil
        }

        /// Issue #3745: rewrites, IN PLACE, every argument slot holding a
        /// user-declared class that erased to `System.Object` so it carries the
        /// implemented imported interface instead. An imported generic method whose
        /// type parameter occurs solely inside an interface-typed parameter — e.g.
        /// `MethodDefinition.DecodeSignature<TType, TGenericContext>(
        /// ISignatureTypeProvider<TType, TGenericContext>, TGenericContext)`
        /// called with a G#-declared `NameSignatureProvider :
        /// ISignatureTypeProvider[string, object]` — gets no bound at all from an
        /// `object` argument, so inference fails and the call reports
        /// `GS0159 Cannot find function`.
        ///
        /// This runs ONLY after resolution with the erased shapes has already
        /// failed. The `object` ride-through is load-bearing on its own — it is
        /// what makes a parameter whose type is an erased type parameter applicable
        /// (issue #2840's `Do(ctx T, …)` on an imported `Jobb[T]`) — so a
        /// caller must restore the original vector when the retry does not resolve.
        /// @param arguments The bound arguments, positionally aligned with [`argTypes`](paramref).
        /// @param argTypes The CLR argument-type vector, rewritten in place.
        /// @returns `true` when at least one slot was rewritten.
        private func TryProjectUserClassArgumentInterfaces(
            arguments ImmutableArray[BoundExpression],
            argTypes[]Type?
        ) bool {
            var projected = false
            for var i = 0; i < arguments.Length && i < argTypes.Length; i++ {
                if arguments[i].Type is not StructSymbol{IsClass: true} userClass ||
                    argTypes[i] is not{} erased ||
                    !erased.IsSameAs(typeof(object)) ||
                    !TryProjectUserClassReceiverInterface(userClass, out var clrInterface) {
                    continue
                }
                argTypes[i] = clrInterface
                projected = true
            }
            return projected
        }

        private func ImplementsGenericEnumerable(clr Type) bool {
            if clr.IsGenericType && clr.GetGenericTypeDefinition()
                .FullName == "System.Collections.Generic.IEnumerable`1" {
                return true
            }
            try {
                for iface in clr.GetInterfaces() {
                    if iface.IsGenericType && iface.GetGenericTypeDefinition()
                        .FullName == "System.Collections.Generic.IEnumerable`1" {
                        return true
                    }
                }
            } catch (Exception) {
                // Cross-context (MLC) types may throw on GetInterfaces(); ignore.

            }
            return false
        }

        private func SafeInterfaceCount(clr Type) int32 {
            try {
                return clr.GetInterfaces().Length
            } catch (Exception) {
                return 0
            }
        }

        /// Issue #658: determines whether a user-defined G# class argument (identified
        /// by its surrogate CLR type in [`argTypes`](paramref)) implements the
        /// specified CLR [`target`](paramref) interface. Used as the
        /// `supplementaryInterfaceCheck` argument to
        /// (cref:ClrOverloadResolution.Resolve{T}) during overload resolution for
        /// calls that include user-class arguments.
        private func IsUserClassAssignableToInterface(
            boundArguments ImmutableArray[BoundExpression].Builder,
            argTypes[]Type?,
            source Type,
            target Type
        ) bool {
            for var i = 0; i < boundArguments.Count; i++ {
                if !ClrTypeUtilities.AreSame(argTypes[i], source) {
                    continue
                }
                if boundArguments[i].Type is StructSymbol{IsClass: true} ss {
                    if UserClassImplementsInterface(ss, target) {
                        return true
                    }
                }
            }
            return false
        }

        /// Issue #658: checks whether a user-defined G# class (or any of its base
        /// classes) declares implementation of the specified CLR interface.
        private func UserClassImplementsInterface(ss StructSymbol, target Type) bool {
            for current in ss.GetHierarchy() {
                for iface in current.ImplementedClrInterfaces {
                    if iface.ClrType == nil {
                        continue
                    }
                    // Direct match: the implemented interface IS the target.
                    if ClrTypeUtilities.AreSame(iface.ClrType, target) {
                        return true
                    }
                    // The implemented interface itself inherits from the target.
                    if ClrTypeUtilities.ImplementsInterfaceByName(iface.ClrType, target) {
                        return true
                    }
                }
            }
            // Also check the imported CLR base type (if any) — it may implement
            // the target interface.
            if ss.ImportedBaseType?.ClrType != nil && ClrTypeUtilities.ImplementsInterfaceByName(
                ss.ImportedBaseType!!.ClrType,
                target
            ) {
                return true
            }
            return false
        }

        /// Issue #658: variant of (cref:IsUserClassAssignableToInterface) that
        /// works with (cref:ImmutableArray{T}) arguments (used by instance
        /// method call paths).
        private func IsUserClassAssignableToInterfaceFromArgs(
            boundArguments ImmutableArray[BoundExpression],
            argTypes[]Type?,
            source Type,
            target Type
        ) bool {
            for var i = 0; i < boundArguments.Length; i++ {
                if !ClrTypeUtilities.AreSame(argTypes[i], source) {
                    continue
                }
                if boundArguments[i].Type is StructSymbol{IsClass: true} ss {
                    if UserClassImplementsInterface(ss, target) {
                        return true
                    }
                }
            }
            return false
        }

        /// ADR-0091 / issue #757: returns true when [`enclosingType`](paramref)
        /// (or any of its base classes) appears in [`ifaceSym`](paramref)'s
        /// implementer set. Constructed generic interfaces compare by
        /// (cref:InterfaceSymbol.Definition) identity to allow
        /// `base[IFoo[int]]` from a class declared as `: IFoo[int]`.
        private func EnclosingTypeImplements(enclosingType StructSymbol, ifaceSym InterfaceSymbol) bool {
            let ifaceDef = ifaceSym.Definition ?? ifaceSym
            for t in enclosingType.GetHierarchy() {
                for iface in t.Interfaces {
                    let candidateDef = iface.Definition ?? iface
                    if object.ReferenceEquals(candidateDef, ifaceDef) {
                        return true
                    }
                }
            }
            return false
        }

        /// Issue #4392: the instance call inside a completed suspending call, the
        /// operand of the implicit await or the argument of the blocking bridge
        /// that (cref:CompleteSuspendingCall) produced.
        /// @param completed The bound call as overload resolution returned it.
        /// @returns The inner instance call, or `null` when [`completed`](paramref) is not a completed
        /// suspending instance call.
        private func TryGetCompletedSuspendingInstanceCall(
            completed BoundExpression
        ) BoundUserInstanceCallExpression? -> switch completed {
            case BoundAwaitExpression{Expression: BoundUserInstanceCallExpression awaited}: awaited
            case bridge is BoundImportedCallExpression when LockRegions.IsBlockingBridge(bridge) &&
                bridge.Arguments[0] is BoundUserInstanceCallExpression bridged: bridged
            default: default(BoundUserInstanceCallExpression?)
        }

        /// Issue #1260: a readable display name for a CLR base type used in base-call member-not-found
        /// diagnostics.
        private func ClrTypeDisplayName(clrType Type?) string -> clrType?.Name ?? "object"

        /// Issue #1260: returns the CLR base type whose inherited instance members a
        /// `base.Member` access resolves against. Walks the GSharp base-class
        /// chain from [`from`](paramref) to the topmost user class and returns
        /// that class's imported/BCL base ((cref:StructSymbol.ImportedBaseType)),
        /// defaulting to `typeof(object)` when no class in the chain declares an
        /// imported base.
        /// @param from The GSharp class to start walking from.
        /// @returns The CLR base type for inherited-member lookup.
        private func ResolveClrBaseSearchType(from StructSymbol) Type {
            for current in from.GetHierarchy() {
                let clr Type? = current.ImportedBaseType?.ClrType
                if clr != nil {
                    return clr
                }
            }
            return typeof(object)
        }

        /// Issue #986: returns true when [`candidate`](paramref) is a base
        /// class of [`derived`](paramref) (compared by definition identity to
        /// allow constructed generics).
        private func IsBaseClassOf(derived StructSymbol, candidate StructSymbol) bool {
            let candidateDef = candidate.Definition ?? candidate
            let chain = derived.GetHierarchy()
            for var level = 1; level < chain.Count; level++ {
                let current = chain[level]
                let currentDef = current.Definition ?? current
                if object.ReferenceEquals(currentDef, candidateDef) || object.ReferenceEquals(current, candidate) {
                    return true
                }
            }
            return false
        }

        private func CaptureExpandedArgumentLocations(
            call CallExpressionSyntax,
            argumentCount int32,
            parameterMapping ImmutableArray[int32],
            parameterCount int32,
            receiverArgCount int32,
            isExpanded bool
        ) ImmutableArray[TextLocation?] {
            if !isExpanded || parameterMapping.IsDefault {
                return default(ImmutableArray[TextLocation?])
            }
            let locations = ImmutableArray.CreateBuilder[TextLocation?](parameterCount)
            locations.Count = parameterCount
            for var i = receiverArgCount; i < argumentCount && i < parameterMapping.Length; i++ {
                let sourceIndex = i - receiverArgCount
                let parameterIndex = parameterMapping[i]
                if sourceIndex < call.Arguments.Count && parameterIndex < parameterCount - 1 {
                    locations[parameterIndex] = call.Arguments[sourceIndex].Location
                }
            }
            return locations.MoveToImmutable()
        }
    }
}
