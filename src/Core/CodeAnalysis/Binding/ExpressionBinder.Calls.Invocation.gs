// <copyright file="ExpressionBinder.Calls.Invocation.cs" company="GSharp">
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
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols.Display

internal partial class ExpressionBinder {
    private func TryReportByRefLikeInheritedCall(
        receiver BoundExpression,
        method MethodInfo,
        location TextLocation
    ) bool {
        let receiverType = if receiver.Type is ByRefTypeSymbol byRef {
            byRef.PointeeType
        } else {
            receiver.Type
        }
        if !TypeSymbol.IsByRefLike(receiverType) || !ReflectionMetadataEmitter.ImportedInstanceReceiverRequiresBoxing(
            receiverType,
            method
        ) {
            return false
        }
        Diagnostics.ReportByRefLikeEscape(
            location,
            receiverType,
            "invoke inherited method '${method.Name}' because dispatch requires boxing the receiver"
        )
        return true
    }

    /// Issue #311: resolves the explicit `[T1, T2]` type-argument list on a
    /// generic-method call site into CLR types projected onto the reference load
    /// context, ready for (cref:System.Reflection.MethodInfo.MakeGenericMethod).
    /// Mirrors the generic-construction path so primitives and constructed
    /// generics resolve against the target framework's reference assemblies.
    /// @param typeArgumentList The call site's explicit type-argument list, or `null`.
    /// @param explicitTypeArgs On success, the resolved (mapped) CLR type arguments; `null` when the list
    /// is absent.
    /// @param typeArgSymbols Issue #320: on success, the resolved type-argument (cref:TypeSymbol)s
    /// in source order; default when the list is absent. These carry user-defined
    /// types (which have no reference-context CLR type and are closed with an
    /// (cref:object) placeholder in [`explicitTypeArgs`](paramref)) so
    /// later stages can recover and emit the real type argument.
    /// @returns `true` when there is no list (no explicit type args) or
    /// every argument resolved; `false` when a type argument
    /// could not be resolved.
    private func TryResolveExplicitMethodTypeArgs(
        typeArgumentList TypeArgumentListSyntax?,
        out explicitTypeArgs[]?Type,
        out typeArgSymbols ImmutableArray[TypeSymbol]
    ) bool {
        explicitTypeArgs = nil
        typeArgSymbols = default(ImmutableArray[TypeSymbol])
        if typeArgumentList == nil {
            return true
        }
        let resolved = [typeArgumentList.Arguments.Count]Type
        let symbols = ImmutableArray.CreateBuilder[TypeSymbol](typeArgumentList.Arguments.Count)
        for var i = 0; i < typeArgumentList.Arguments.Count; i++ {
            let ta TypeSymbol? = bindTypeClause(typeArgumentList.Arguments[i])
            if ta == nil {
                return false
            }
            symbols.Add(ta)
            if ta.ClrType != nil {
                // BCL / imported type argument. Project onto the resolver's
                // reference set so it shares the open generic method's load
                // context, exactly as the generic-construction path does before
                // MakeGenericType / MakeGenericMethod.
                // Issue #530: use ResolveClrTypeForGenericArg so that
                // `int32?` resolves to `Nullable<int>` (not bare `int`).
                resolved[i] = (
                    resolveClrTypeForGenericArg(ta) ?? $scope.References!!.MapClrTypeToReferences(ta.ClrType)
                )!!
            } else {
                // Issue #320: a user-defined type (or an in-scope type parameter)
                // has no reference-context CLR type, so it cannot be handed to
                // MakeGenericMethod directly. Close the open method with a
                // reference-context placeholder so resolution and applicability
                // still run; the real type-argument symbol is preserved in
                // typeArgSymbols and re-emitted as its own TypeDef token in the
                // generic method specification.
                //
                // Issue #4013 is not this; issue #4016 is: the placeholder must
                // be the SAME erasure the ARGUMENTS present, or the two sides
                // describe the same G# type with two different CLR types and no
                // candidate applies. `MemberLookup.TryProjectErasedClrType` —
                // which every structural argument spelling goes through — erases
                // a same-compilation class to its imported base when it has one
                // (`class Derived : ImportedBase` -> `ImportedBase`) and to
                // `object` only when it does not. So `map[string, Derived]`
                // arrives as `Dictionary<string, ImportedBase>` while a flat
                // `System.Object` placeholder closed the slot to
                // `Dictionary<string, object>`: invariant, no conversion,
                // GS0159 — even though the very same call binds when the type
                // arguments are INFERRED (inference reads the argument's own
                // shape) or when the class has no imported base (both erasures
                // are then `object`). `[]Derived` and `[N]Derived` at a `T[]`
                // slot failed identically. Project the type argument the same
                // way the arguments are projected and the two sides agree
                // again; `TryProjectErasedClrType` already answers `object` for
                // a type parameter, an interface and a base-less class, so
                // every case that used to reach the flat placeholder still does.
                //
                // This is the same correction #3087 made one site over in
                // `ExpressionBinder.Calls.cs`, which stopped flattening a
                // symbolic TUPLE type argument to `object` for exactly this
                // reason.
                // Review finding (#4031): a direct same-compilation ENUM keeps
                // the established `System.Object` placeholder.
                // `TryProjectErasedClrType` erases an `EnumSymbol` to `int`,
                // which is a VALUE type, and
                // `TryCloseOverUserValueTypePlaceholders` only substitutes for
                // NON-value-type placeholders — so a candidate whose
                // `MakeGenericMethod` rejects `int` (`Enum.TryParse[TEnum]`,
                // whose `where TEnum : Enum` an `int` does not satisfy) would be
                // dropped outright rather than retried. The enum's own erasure
                // is not what #4016 is about: this fix exists to make a
                // same-compilation CLASS agree with the imported-base surrogate
                // its arguments already present, and every row of it is a
                // class. Reported green either way (`Issue1599`/`Issue1601`
                // pass with and without this guard, because an `EnumSymbol`
                // carries a non-null `ClrType` and so takes the branch above),
                // but the guard states the intent rather than relying on that.
                resolved[i] = if !(ta is EnumSymbol) && MemberLookup.TryProjectErasedClrType(
                    ta,
                    out var erasedTypeArg
                ) {
                    $scope.References!!.MapClrTypeToReferences(erasedTypeArg)!!
                } else {
                    $scope.References!!.GetCoreType("System.Object")
                }
            }
        }
        explicitTypeArgs = resolved
        typeArgSymbols = symbols.MoveToImmutable()
        return true
    }

    /// Issue #1833: scans every public static/instance generic method named
    /// [`methodName`](paramref) on [`classType`](paramref) whose
    /// arity matches the explicit type-argument list, looking for one whose
    /// only structural mismatch is a value-type-erased type argument (a
    /// concrete non-enum struct, or a bare `[T struct]` type parameter)
    /// failing an explicit base-class constraint — e.g. `Enum.TryParse`'s
    /// `where TEnum : Enum` bound. Reports the constraint-violation
    /// diagnostic (`GS0152`, the same one user-declared generic
    /// functions/types already use) and returns `true` on the
    /// first hit; other reasons a candidate is inapplicable (arity, argument
    /// types, an unconstrained type parameter, ...) are left to the caller's
    /// existing "cannot find function" fallback.
    /// @param classType The imported class's CLR (cref:Type).
    /// @param methodName The called method's name.
    /// @param explicitTypeArgs The resolved explicit CLR type arguments.
    /// @param typeArgSymbols The resolved symbolic type-argument vector.
    /// @param location The text location to attach the diagnostic to.
    /// @returns `true` when a violation was found and reported.
    private func TryReportGenericValueTypeBaseConstraintViolation(
        classType Type?,
        methodName string,
        explicitTypeArgs[]?Type,
        typeArgSymbols ImmutableArray[TypeSymbol],
        location TextLocation
    ) bool {
        if classType == nil ||
            explicitTypeArgs == nil ||
            explicitTypeArgs.Length == 0 ||
            typeArgSymbols.IsDefaultOrEmpty {
            return false
        }
        var candidates List[MethodInfo]
        try {
            candidates = List[MethodInfo]()
            for method in classType.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance) {
                if ClrTypeUtilities.EmittedMemberNameMatches(method, methodName) &&
                    method.IsGenericMethodDefinition &&
                    method
                    .GetGenericArguments().Length == explicitTypeArgs.Length {
                    candidates.Add(method)
                }
            }
        } catch (Exception) {
            return false
        }
        for candidate in candidates {
            if ClrOverloadResolution.TryDescribeValueTypeBaseConstraintViolation(
                candidate,
                explicitTypeArgs,
                typeArgSymbols,
                out var typeParameterName,
                out var typeArgument,
                out var constraintDescription
            ) {
                Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(
                    location,
                    typeParameterName,
                    typeArgument,
                    constraintDescription
                )
                return true
            }
        }
        return false
    }

    /// Issue #1507: builds the receiver type used to drive DEFERRED untyped
    /// arrow-lambda inference over a slice (`[]T`) or array (`[N]T`)
    /// receiver. Such a receiver's (cref:TypeSymbol.ClrType) is
    /// `null` for a same-compilation user element (and an array
    /// CLR type otherwise), so the extension-method probe in
    /// (cref:ResolveDeferredArrowLambdaArguments) — which is gated on a
    /// non-null receiver `ClrType` — is never reached and the element type
    /// is never recovered to target-type the untyped lambda parameter. Normalize
    /// to a symbolic constructed `IEnumerable[elementType]` carrying the
    /// element type as a symbolic argument (mirroring the `List[T]` /
    /// `sequence[T]` shapes), so the LINQ extension
    /// `Where<TSource>(IEnumerable<TSource>, Func<TSource,bool>)`
    /// (and every other delegate-taking extension) matches and `TSource` is
    /// recovered as the element type. The constructed `ClrType` uses the
    /// element's erased CLR projection, so a same-compilation user element
    /// (`[]Item`) closes to `IEnumerable<object>` with the
    /// symbolic `[Item]` argument (the symbolic recovery path re-derives
    /// `Item`), while a primitive/BCL element (`[]int32`,
    /// `[]string`) closes to the concrete `IEnumerable<int>` /
    /// `IEnumerable<string>` so the CLR inference path recovers the
    /// real element type instead of erasing it to `object`. This mirrors the
    /// `List[T]` behaviour exactly. The `IEnumerable<>` open
    /// definition and closed shape are resolved through the compilation's
    /// reference set ((cref:ReferenceResolver.MapClrTypeToReferences)) so
    /// the constructed `OpenDefinition` is reference-identical to the
    /// extension methods' `this IEnumerable<TSource>` parameter — the
    /// symbolic unifier (`UnifyForMethodTypeArgs`) matches the open
    /// definition by reference, which would otherwise fail whenever the reference
    /// set is projected through a (cref:System.Reflection.MetadataLoadContext)
    /// (its `IEnumerable<>` is not the runtime `typeof`). The bound
    /// call keeps the original slice/array receiver expression; the emitter
    /// already normalizes slice/array receivers to their enumerable surface, so
    /// emission is unaffected. Returns `false` when no
    /// normalization applies.
    /// @param receiverType The receiver's static type symbol.
    /// @param normalized The normalized symbolic `IEnumerable[T]` receiver type, on success.
    /// @returns `true` when a normalized receiver type was produced.
    private func TryNormalizeSliceArrayReceiverForLambdaInference(
        receiverType TypeSymbol,
        @NotNullWhen(true) out normalized TypeSymbol?
    ) bool {
        normalized = nil
        var elementType TypeSymbol?
        switch receiverType {
            case slice is SliceTypeSymbol {
                elementType = slice.ElementType
            }
            case array is ArrayTypeSymbol {
                elementType = array.ElementType
            }
            default {
                return false
            }
        }
        if elementType == nil || !MemberLookup.TryProjectErasedClrType(elementType, out var erasedElement) {
            return false
        }
        var openDefinition Type
        var closedEnumerable Type
        try {
            openDefinition = $scope.References!!.MapClrTypeToReferences(
                typeof(System.Collections.Generic.IEnumerable[_])
            )!!
            let mappedElement = $scope.References!!.MapClrTypeToReferences(erasedElement)
            closedEnumerable = openDefinition.MakeGenericType(mappedElement!!)
        } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) ||
            ex is ArgumentException ||
            ex is InvalidOperationException {
            return false
        }
        normalized = ImportedTypeSymbol.GetConstructed(
            closedEnumerable,
            openDefinition,
            ImmutableArray.Create(elementType)
        )
        return true
    }

    /// Issue #908: collects the parameter lists of the CLR methods a member-style
    /// call could resolve to — static methods of the accessed class, or instance
    /// methods on the receiver plus imported extension methods — so an arrow
    /// lambda argument can be target-typed from its matching delegate parameter
    /// before binding. Extension-method parameter lists have their leading
    /// `this` receiver parameter stripped so every returned list aligns at a
    /// zero parameter offset, matching the positional argument indices.
    private func CollectDelegateTargetCandidateParameterLists(
        receiver BoundExpression?,
        classSymbol ImportedClassSymbol?,
        methodName string
    ) List[[]ParameterInfo] {
        let result = List[[]ParameterInfo]()
        let staticClassType = classSymbol?.ClassType
        let receiverClrType = if classSymbol == nil {
            receiver?.Type?.ClrType
        } else {
            default(Type?)
        }
        for probe in this.memberLookup.CollectImportedMethodProbes(
            staticClassType,
            receiverClrType,
            methodName,
            includeExtensions: classSymbol == nil
        ) {
            for method in probe.Methods {
                let parameters = method.GetParameters()
                if probe.ReceiverParameterOffset == 0 {
                    result.Add(parameters)
                    continue
                }
                let stripped = [parameters.Length - probe.ReceiverParameterOffset]ParameterInfo
                Array.Copy(parameters, probe.ReceiverParameterOffset, stripped, 0, stripped.Length)
                result.Add(stripped)
            }
        }
        return result
    }

    /// Issue #5569: the parameter lists of a probe's candidates, for (cref:BindLambdaWithCandidateTarget).
    /// @param methods The candidate methods.
    /// @returns Their parameter lists, in candidate order.
    private func CollectProbeParameterLists(methods IReadOnlyList[MethodInfo]) List[[]ParameterInfo] {
        let result = List[[]ParameterInfo](methods.Count)
        for method in methods {
            if method != nil {
                result.Add(method.GetParameters())
            }
        }
        return result
    }

    /// Issue #891: infers the target delegate type for each deferred un-typed
    /// arrow lambda argument of a member-style call by probing the applicable
    /// candidate methods — instance methods on the receiver, imported
    /// extension methods (LINQ et al.), or static methods of the accessed
    /// class — with the lambda slots treated as unconstrained. Once the
    /// (possibly generic) overload is resolved and its type arguments inferred,
    /// the corresponding closed delegate parameter type target-types the lambda,
    /// which is then bound in place inside [`boundArgs`](paramref).
    ///
    /// Issue #951: resolves deferred un-typed arrow-lambda arguments of a
    /// member-style call whose receiver is a <em>user-declared</em>
    /// class/struct/interface (no CLR type to reflect over). For each still-
    /// deferred lambda index, the matching parameter symbol of the candidate
    /// user method(s) supplies the target delegate shape, which target-types
    /// the lambda exactly like the CLR reflection path. When no candidate
    /// exposes a delegate-typed parameter at that position — or candidates
    /// disagree on the shape — the lambda is left deferred so the caller's
    /// fallback binds it without a target (surfacing GS0304).
    /// @param receiver The bound receiver of the member call.
    /// @param methodName The invoked method name.
    /// @param ce The call syntax (used for the argument syntax nodes).
    /// @param deferredIndices The argument indices still awaiting a target.
    /// @param boundArgs The in-progress bound-argument array, mutated in place.
    private func ResolveDeferredArrowLambdaArgumentsFromUserMethods(
        receiver BoundExpression?,
        methodName string,
        ce CallExpressionSyntax,
        deferredIndices List[int32],
        boundArgs[]BoundExpression
    ) {
        if deferredIndices.Count == 0 || receiver?.Type == nil {
            return
        }
        let candidates = MemberLookup.CollectSourceInstanceMethods(receiver!!.Type, methodName)
        if candidates.IsDefaultOrEmpty {
            return
        }
        for idx in deferredIndices.ToArray() {
            if !(boundArgs[idx] is BoundErrorExpression{Syntax: LambdaExpressionSyntax lambdaSyntax}) {
                continue
            }
            var target FunctionTypeSymbol? = nil
            var disagree = false
            for candidate in candidates {
                let offset = if candidate.ExplicitReceiverParameter == nil {
                    0
                } else {
                    1
                }
                let paramPos = idx + offset
                if paramPos < 0 || paramPos >= candidate.Parameters.Length {
                    continue
                }
                if !MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(
                    candidate.Parameters[paramPos].Type,
                    out var fn
                ) ||
                    fn == nil {
                    continue
                }
                if target == nil {
                    target = fn
                } else if !object.ReferenceEquals(target, fn) && !target.Equals(fn) {
                    disagree = true
                    break
                }
            }
            if target != nil && !disagree {
                boundArgs[idx] = lambdas.BindLambdaExpression(lambdaSyntax, target)
                deferredIndices.Remove(idx)
            }
        }
    }

    /// Issue #1330: binds a static method call on a generic type constructed
    /// over an in-scope generic type parameter (e.g.
    /// `Comparer[TResult].Create(...)`) by substituting the receiver's
    /// symbolic type arguments through the resolved method's open parameter and
    /// return types. A delegate parameter surfaces as its symbolic shape
    /// (`Comparison[TResult]`) so a function-literal argument flows through
    /// as an identity adapter hosted in the enclosing generic context rather than
    /// a type-erased `<object>` adapter referencing an out-of-scope
    /// type parameter; the result is the symbolic `Comparer[TResult]`; and
    /// the produced (cref:BoundImportedCallExpression) carries the
    /// symbolic container so the emitter parents the call at the constructed
    /// `Comparer<!TResult>` TypeSpec. Returns `false`
    /// (deferring to the ordinary erased path) when the symbolic open method or a
    /// parameter projection cannot be recovered.
    private func TryBindSymbolicImportedStaticCall(
        ce CallExpressionSyntax,
        classSymbol ImportedClassSymbol,
        staticFn ImportedFunctionSymbol,
        arguments ImmutableArray[BoundExpression],
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        let symbolicReceiver = classSymbol.SymbolicReceiver
        if symbolicReceiver?.OpenDefinition == nil ||
            symbolicReceiver!!
            .TypeArguments
            .IsDefaultOrEmpty ||
            !TryResolveOpenStaticMethod(symbolicReceiver!!.OpenDefinition, staticFn.Method, out var openMethod) {
            return false
        }
        let openParameters = openMethod!!.GetParameters()
        if openParameters.Length != arguments.Length {
            // Optional/params/defaulted parameter shapes are not handled by this
            // narrow symbolic path; fall back to the ordinary resolution.
            return false
        }
        let openDef = symbolicReceiver!!.OpenDefinition
        let symbolicArgs = symbolicReceiver!!.TypeArguments
        let convertedArgs = ImmutableArray.CreateBuilder[BoundExpression](arguments.Length)
        for var i = 0; i < arguments.Length; i++ {
            let argument = arguments[i]
            let openParamType = openParameters[i].ParameterType
            let symbolicParamType = MemberLookup.GetClrOpenParameterTypeSymbol(openParameters[i], openDef, symbolicArgs)
            // Nominal identity remains on the explicit symbolicDelegateParam
            // conversion below; only the mapped Invoke shape is needed here.
            if LambdaBinder.TryGetFunctionLiteral(argument, out var functionLiteral) &&
                symbolicParamType is ImportedTypeSymbol symbolicDelegateParam &&
                symbolicDelegateParam.OpenDefinition != nil &&
                symbolicDelegateParam.HasTypeParameterArgument &&
                TryBuildSymbolicDelegateTarget(
                openParamType,
                openDef,
                symbolicArgs,
                out _,
                out var symbolicDelegateTarget
            ) {
                // The substituted delegate target matches the literal's declared
                // (TResult-typed) shape, so the adapter returns the literal
                // unchanged (IsIdentityAdapter) — the lambda MethodDef is hosted
                // in the enclosing generic context. Wrap it in a conversion to
                // the symbolic constructed delegate type (`Comparison[TResult]`)
                // so the emitter materialises a `Comparison<!TResult>` instance
                // (rather than the natural `Func<...>` or the type-erased
                // `Comparison<object>`) that the callee's reified parameter
                // accepts. The classifier would reject this (the erased
                // `Comparison<object>` Invoke shape differs from the TResult
                // literal), so build the conversion node directly.
                let adapter = lambdas.CreateErasedFunctionLiteralAdapter(functionLiteral!!, symbolicDelegateTarget!!)
                convertedArgs.Add(BoundConversionExpression(nil, symbolicDelegateParam, adapter))
                continue
            }
            if symbolicParamType is TypeParameterSymbol || symbolicParamType == TypeSymbol.Error {
                convertedArgs.Add(argument)
                continue
            }
            let argLoc = if i < ce.Arguments.Count {
                ce.Arguments[i].Location
            } else {
                ce.Location
            }
            // Issue #4400: a plain argument at an `in T` slot is passed by
            // readonly reference to the symbolic pointee (`!0`), as in C#.
            if ConversionClassifier.IsImplicitInClrArgument(argument, openParameters[i]) &&
                TypeSymbol
                .TryGetPointeeType(symbolicParamType, out var symbolicInPointee) {
                convertedArgs.Add(
                    (
                        if conversions.TryRejectClrPlatformContainerArgument(
                            argument,
                            openParameters[i],
                            symbolicInPointee!!,
                            argLoc,
                            out var rejectedInArgument
                        ) {
                            rejectedInArgument
                        } else {
                            conversions.BindImplicitInArgument(argLoc, argument, symbolicInPointee!!, parameter: nil)
                        }
                    )
                )
                continue
            }
            let conversion = Conversion.Classify(argument.Type, symbolicParamType)
            convertedArgs.Add(
                (
                    if conversion.IsExplicit && conversions.TryApplyUserDefinedImplicitArgumentConversion(
                        argument,
                        symbolicParamType,
                        out var implicitArg
                    ) {
                        implicitArg
                    } else {
                        (
                            if conversions.TryRejectClrPlatformContainerArgument(
                                argument,
                                openParameters[i],
                                symbolicParamType,
                                argLoc,
                                out var rejectedArgument,
                                conversion
                            ) {
                                rejectedArgument
                            } else {
                                conversions.BindConversion(argLoc, argument, symbolicParamType)
                            }
                        )
                    }
                )
            )
        }
        let symbolicReturn = MemberLookup.GetClrOpenMethodReturnTypeSymbol(openMethod!!, openDef, symbolicArgs)
        let overriddenFn = ImportedFunctionSymbol(
            staticFn.Name,
            classSymbol,
            staticFn.Method,
            staticFn.Declaration,
            returnTypeOverride: symbolicReturn
        )
        let refKinds = ComputeArgumentRefKinds(staticFn.Method.GetParameters())
        // ADR-0056 §1 / issue #4350: a ref-returning static CLR method
        // (`Unsafe.As[TFrom, TTo](&x)`) is observed through its pointee, exactly
        // like a ref-returning instance member or indexer.
        result = ConversionClassifier.AutoDereferenceRefReturn(
            BoundImportedCallExpression(
                ce,
                overriddenFn,
                convertedArgs.MoveToImmutable(),
                refKinds,
                typeArgumentSymbols: default(ImmutableArray[TypeSymbol?]),
                staticContainerType: symbolicReceiver
            )
        )
        result = CompleteImportedSuspendingCall(result!!, staticFn.Method, ce.Location)
        return true
    }

    private func ResolveDeferredArrowLambdaArguments(
        receiver BoundExpression?,
        classSymbol ImportedClassSymbol?,
        methodName string,
        ce CallExpressionSyntax,
        explicitTypeArgs[]?Type,
        explicitTypeArgSymbols ImmutableArray[TypeSymbol],
        deferredIndices List[int32],
        boundArgs[]BoundExpression
    ) {
        // Issue #1507: a slice/array receiver (`[]T` / `[N]T`) carries a null
        // (user element) or array-shaped ClrType, so the extension-method probe
        // below — gated on a non-null receiver ClrType — would never be added
        // and the untyped lambda parameter would never be target-typed from the
        // matching LINQ delegate. Normalize such a receiver to a symbolic
        // `IEnumerable[elementType]` (recovering the element type exactly as the
        // `List[T]`/`sequence[T]` paths do) purely for the purpose of inferring
        // the deferred lambda targets; the finally-bound call keeps the original
        // slice/array receiver expression.
        var receiverType TypeSymbol? = receiver?.Type ?? classSymbol?.SymbolicReceiver
        if receiverType != nil &&
            TryNormalizeSliceArrayReceiverForLambdaInference(receiverType, out var normalizedReceiverType) {
            receiverType = normalizedReceiverType
        }
        let probes = this.memberLookup.CollectImportedMethodProbes(
            classSymbol?.ClassType,
            if classSymbol == nil {
                receiverType?.ClrType
            } else {
                default(Type?)
            },
            methodName,
            includeExtensions: classSymbol == nil && receiverType?.ClrType != nil
        )
        if probes.Count == 0 {
            return
        }
        let deferred = HashSet[int32](deferredIndices)
        // Issue #903: when the receiver carries a same-compilation user element
        // type (e.g. `List[Check]` where `Check` is a struct/class still being
        // compiled), that element type is erased to `object` at the CLR layer.
        // The reflection-driven inference paths below would therefore bind the
        // lambda parameter as `object` and fail member access in the body
        // (`c.Id` → GS0158). Try a symbol-based inference first that recovers
        // the real element type from the receiver's symbolic `TypeArguments`,
        // builds a `FunctionTypeSymbol` target carrying that type, and binds the
        // lambda against it. Issue #2810 also uses this path for explicit
        // method type arguments whose CLR placeholder is `object`.
        for probe in probes {
            if TryMapDeferredLambdaTargetsSymbolic(
                probe.Methods,
                probe.ReceiverParameterOffset,
                receiverType,
                ce,
                explicitTypeArgSymbols,
                deferredIndices,
                boundArgs,
                deferred,
                out var symbolicTargets,
                out var exactReturnIndices
            ) {
                for idx in deferredIndices {
                    let inner = OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[idx])
                    if inner is LambdaExpressionSyntax lambdaSyntax && symbolicTargets!!.TryGetValue(
                        idx,
                        out var target
                    ) {
                        // Issue #2345: when this slot's return type was fully
                        // recovered (e.g. `void` for an Action-shaped
                        // parameter), bind against the real target so the
                        // void-discard / ordinary target-typed return-type
                        // inference applies instead of inferring the return
                        // type purely from the lambda body.
                        let slotIndex = idx
                        let inferReturn = !exactReturnIndices.Contains(idx)
                        boundArgs[idx] = BindLambdaWithCandidateTarget(
                            lambdaSyntax,
                            CollectProbeParameterLists(probe.Methods),
                            (parameters[]ParameterInfo) -> MapSourceArgumentToParameter(
                                parameters,
                                ce,
                                slotIndex,
                                probe.ReceiverParameterOffset
                            ),
                            () -> {
                                let literal = lambdas.BindLambdaExpression(
                                    lambdaSyntax,
                                    target.FunctionType,
                                    inferReturnTypeFromBody: inferReturn
                                )
                                return if ShouldConvertToNominalDelegate(target.DelegateType) {
                                    conversions.BindConversion(
                                        ce.Arguments[slotIndex].Location,
                                        literal,
                                        target.DelegateType
                                    )
                                } else {
                                    literal
                                }
                            }
                        )
                    }
                }
                return
            }
        }
        for probe in probes {
            let offset = probe.ReceiverParameterOffset
            // Issue #3659: narrow the candidate set to the overloads that can
            // actually receive a lambda in every deferred slot before probing.
            // The probe below passes `null` for a deferred slot, which generic
            // inference skips and treats as reference-convertible to any
            // parameter — so an overload set like `List[T].Sort`'s (no-arg,
            // `IComparer[T]`, `Comparison[T]`, `(int32, int32, IComparer[T])`)
            // stays ambiguous and the untyped lambda never gets a target.
            // A lambda of known arity can only convert to a delegate-shaped
            // parameter with the same parameter count, so the other overloads
            // are not viable receivers for it.
            let methods = FilterCandidatesByDeferredLambdaShape(probe.Methods, offset, ce, deferredIndices)
            let argTypes = [boundArgs.Length + offset]Type?
            if offset == 1 {
                // offset is 1 only for a probe collected with includeExtensions:
                // true, which above is gated on receiverType?.ClrType != null.
                // Issue #3551: prefer the REIFIED closed shape over the cached
                // (possibly erased) ClrType — a symbolic receiver like
                // IGrouping[string?, (string, int32?)] can cache a closed shape
                // whose tuple argument lost its Nullable element, and inferring
                // the deferred lambda's parameter from that shape rebinds the
                // literal against the wrong tuple.
                argTypes[0] = ReifiedReceiverClrType(receiverType) ?? receiverType!!.ClrType
            }
            var usable = true
            for var i = 0; i < boundArgs.Length; i++ {
                if deferred.Contains(i) {
                    // An unconstrained lambda slot: null is skipped by generic
                    // inference and treated as reference-convertible to the
                    // delegate parameter, so the candidate still applies.
                    argTypes[i + offset] = nil
                    continue
                }
                let t Type? = GetEffectiveArgumentClrTypeForOverloadResolution(boundArgs[i].Type)
                if t == nil && boundArgs[i].Type != TypeSymbol.Null {
                    usable = false
                    break
                }
                argTypes[i + offset] = t
            }
            if !usable {
                continue
            }
            // Issue #1812: `interpolatedStringArgs` is intentionally omitted
            // here. This Resolve call is a best-effort probe purely to
            // discover a deferred (untyped) arrow-lambda argument's delegate
            // parameter type by narrowing candidates on the other,
            // already-bound arguments; it is never the final overload
            // decision. The call is re-resolved for real via the ordinary
            // static/instance/extension Resolve call sites once every
            // argument (including the now-typed lambda) is bound — those
            // sites already pass the flag, so an interpolated-string argument
            // sharing a call with a deferred lambda still resolves/rebinds
            // correctly overall.
            let deferredArgumentNames IReadOnlyList[string?]? = BuildDeferredArgumentNames(ce, offset)
            let resolution = ClrOverloadResolution.Resolve(
                methods,
                argTypes,
                explicitTypeArgs,
                $scope.References!!.MapClrTypeToReferences,
                argumentNames: deferredArgumentNames,
                symbolicArgumentConversionClassifier: MakeSymbolicArgumentConversionClassifier(
                    boundArgs,
                    argumentOffset: offset,
                    nativeConversions: conversions
                )
            )
            if resolution.Outcome != ClrOverloadResolution
                .ResolutionOutcome
                .Resolved ||
                resolution.Best is not{} probeMethod {
                continue
            }
            let parameters = probeMethod.GetParameters()
            let targets = Dictionary[int32, (FunctionType FunctionTypeSymbol, DelegateType TypeSymbol)]()
            var allMapped = true
            for idx in deferredIndices {
                let paramIndex = MapSourceArgumentToParameter(parameters, ce, idx, offset)
                if paramIndex < 0 || paramIndex >= parameters.Length {
                    allMapped = false
                    break
                }
                let parameterType = ConversionClassifier.GetPlainValueClrParameterType(parameters[paramIndex])
                if parameterType.ContainsGenericParameters || !MemberLookup.TryGetLambdaTargetFunctionType(
                    parameterType,
                    out var fn
                ) ||
                    fn == nil {
                    allMapped = false
                    break
                }
                // The delegate slot's bare shape: a function literal is never
                // nil, so the slot's own top-level nullability does not apply.
                targets[idx] = (fn, ClrNullability.GetParameterTypeSymbol(parameters[paramIndex]).StripToBareShape())
            }
            if !allMapped {
                continue
            }
            for idx in deferredIndices {
                let inner = OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[idx])
                if inner is LambdaExpressionSyntax lambdaSyntax {
                    let target = targets[idx]
                    let slotIndex = idx
                    boundArgs[idx] = BindLambdaWithCandidateTarget(
                        lambdaSyntax,
                        CollectProbeParameterLists(probe.Methods),
                        (parameters[]ParameterInfo) -> MapSourceArgumentToParameter(parameters, ce, slotIndex, offset),
                        () -> BindLambdaWithDelegateTarget(
                            ce.Arguments[slotIndex],
                            lambdaSyntax,
                            target.FunctionType,
                            target.DelegateType
                        )
                    )
                }
            }
            return
        }
        // Follow-up to issue #891: the full-inference path above could not
        // map every deferred lambda — typically because the matching generic
        // method's lambda RETURN type is a method type parameter that is only
        // inferable from the lambda body (e.g.
        // Select<TSource,TResult>(IEnumerable<TSource>, Func<TSource,TResult>)).
        // Fall back to partial inference: infer the type parameters reachable
        // from the non-lambda arguments (so the lambda's *parameter* types close)
        // and bind each lambda against a target carrying only those parameter
        // types, leaving its return type to be inferred from the body.
        for probe in probes {
            if TryMapDeferredLambdaParameterTargets(
                probe.Methods,
                probe.ReceiverParameterOffset,
                receiverType,
                ce,
                deferredIndices,
                boundArgs,
                out var partialTargets
            ) {
                for idx in deferredIndices {
                    let inner = OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[idx])
                    if inner is LambdaExpressionSyntax lambdaSyntax && partialTargets!!.TryGetValue(
                        idx,
                        out var target
                    ) {
                        boundArgs[idx] = lambdas.BindLambdaExpression(
                            lambdaSyntax,
                            target,
                            inferReturnTypeFromBody: true
                        )
                    }
                }
                return
            }
        }
    }

    private func TryMapDeferredLambdaParameterTargets(
        methods IReadOnlyList[MethodInfo],
        offset int32,
        receiverType TypeSymbol?,
        ce CallExpressionSyntax,
        deferredIndices List[int32],
        boundArgs[]BoundExpression,
        @NotNullWhen(true) out targets Dictionary[int32, FunctionTypeSymbol]?
    ) bool {
        targets = nil
        let deferred = HashSet[int32](deferredIndices)
        let argTypes = [boundArgs.Length + offset]Type?
        if offset == 1 {
            if receiverType?.ClrType is not Type receiverClrType {
                return false
            }
            // Issue #3551: see the full-inference path above — use the reified
            // closed shape so a nullable tuple element survives into the
            // deferred lambda's inferred parameter type.
            argTypes[0] = ReifiedReceiverClrType(receiverType) ?? receiverClrType
        }
        for var i = 0; i < boundArgs.Length; i++ {
            if deferred.Contains(i) {
                argTypes[i + offset] = nil
                continue
            }
            let t Type? = GetEffectiveArgumentClrTypeForOverloadResolution(boundArgs[i].Type)
            if t == nil && boundArgs[i].Type != TypeSymbol.Null {
                return false
            }
            argTypes[i + offset] = t
        }
        let lambdaParamIndices = List[int32]()
        let arities = List[int32]()
        let argIndexByParamIndex = Dictionary[int32, int32]()
        for idx in deferredIndices {
            let inner = OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[idx])
            if inner is not LambdaExpressionSyntax lambda {
                return false
            }
            let paramIndex = idx + offset
            lambdaParamIndices.Add(paramIndex)
            arities.Add(lambda.Parameters.Count)
            argIndexByParamIndex[paramIndex] = idx
        }
        var agreed Dictionary[int32, []Type]? = nil
        for method in methods {
            if method == nil || (!method.IsGenericMethodDefinition && !method.IsGenericMethod) {
                continue
            }
            if !ClrOverloadResolution.TryInferDeferredLambdaParameterTypes(
                method,
                argTypes,
                lambdaParamIndices,
                arities,
                out var closed
            ) {
                continue
            }
            if agreed == nil {
                agreed = closed
            } else if !DeferredLambdaParameterTypesAgree(agreed, closed) {
                return false
            }
        }
        if agreed == nil {
            return false
        }
        let built = Dictionary[int32, FunctionTypeSymbol]()
        for kv in agreed {
            let parameterTypes = ImmutableArray.CreateBuilder[TypeSymbol](kv.Value.Length)
            for clr in kv.Value {
                // These are the closed types CLR inference produced over the
                // erased argument Types; no declaration was read for them.
                let symbol TypeSymbol? = TypeSymbol.FromClrTypeWithoutNullability(
                    clr,
                    NullabilityFreeReason.CompilerProduced
                )
                if symbol == nil || symbol == TypeSymbol.Error {
                    return false
                }
                parameterTypes.Add(symbol)
            }
            // The return slot is a placeholder; binding passes
            // inferReturnTypeFromBody so the lambda infers its own return type.
            built[argIndexByParamIndex[kv.Key]] = FunctionTypeSymbol.Get(
                parameterTypes.ToImmutable(),
                default(ImmutableArray[bool]),
                TypeSymbol.Object
            )
        }
        targets = built
        return true
    }

    /// Issue #903 / #2673: symbol-based deferred arrow-lambda target inference. The
    /// CLR-driven (cref:ResolveDeferredArrowLambdaArguments) paths infer
    /// the lambda's parameter type from the receiver's <em>CLR</em> type, which
    /// for a same-compilation generic element type (e.g. `List[Check]`
    /// where `Check` is being compiled) is erased to `List<object>`
    /// — so the lambda parameter would bind as `object` and member access
    /// in the body fails. This routine instead recovers the element type
    /// symbolically: it unifies the receiver/argument (cref:TypeSymbol)s
    /// against each candidate generic method's open parameters (reusing
    /// (cref:MemberLookup.InferSymbolicMethodTypeArguments)), then maps
    /// each deferred lambda's delegate <em>parameter</em> types through those
    /// inferred symbolic arguments (reusing
    /// (cref:MemberLookup.MapOpenClrTypeToSymbolic(Type, Type, ImmutableArray{TypeSymbol}, MethodInfo,
    /// ImmutableArray{TypeSymbol}))).
    /// A per-slot target carrying both the exact mapped delegate identity and
    /// its (cref:FunctionTypeSymbol) shape is produced. Non-generic
    /// methods on constructed generic receivers are recovered from the open
    /// declaring type too, including delegates whose only symbolic slot is
    /// their return type. Candidates must agree on both identity and shape.
    ///
    /// Issue #2345: also recovers the delegate's <em>return</em> shape when it
    /// is fully closed by the same unification (including the common case of a
    /// `void`-returning `Action`-shaped delegate). When recovered,
    /// the corresponding slot in [`exactReturnIndices`](paramref) is
    /// marked so callers bind that lambda against the real target (not
    /// `inferReturnTypeFromBody`) — this is what lets a block-bodied
    /// lambda whose trailing statement calls a fluent/self-returning method
    /// correctly discard that value instead of being mis-inferred as a
    /// value-returning `Func` (see `InferLambdaReturnType`'s issue
    /// #889 void-discard rule). When the return type still contains an
    /// unresolved method type parameter, the slot keeps the previous
    /// placeholder behavior (return type inferred from the lambda body).
    private func TryMapDeferredLambdaTargetsSymbolic(
        methods IReadOnlyList[MethodInfo],
        offset int32,
        receiverType TypeSymbol?,
        ce CallExpressionSyntax,
        explicitTypeArgSymbols ImmutableArray[TypeSymbol],
        deferredIndices List[int32],
        boundArgs[]BoundExpression,
        deferred HashSet[int32],
        @NotNullWhen(true) out targets Dictionary[int32, (DelegateType TypeSymbol, FunctionType FunctionTypeSymbol)]?,
        out exactReturnIndices HashSet[int32]
    ) bool {
        exactReturnIndices = HashSet[int32]()
        targets = nil
        // Symbolic recovery is anchored on the candidate's symbolic argument
        // vector: the receiver's symbolic TypeArguments for instance/extension
        // calls, or — for a static call (issue #932:
        // `Assert.DoesNotContain(items, i -> ...)`) — the same-compilation user
        // type carried by a non-deferred argument such as `items : List[Item]`.
        // An extension probe (offset == 1) places the receiver in slot 0, so it
        // genuinely needs a receiver; a static/instance probe (offset == 0) does
        // not. The success gate below ensures this path only pre-empts the CLR
        // path when the recovered shape contains symbolic information that
        // reflection cannot faithfully represent.
        if offset == 1 && receiverType == nil {
            return false
        }
        // Build the symbolic argument vector as the candidate method sees it:
        // for an extension probe (offset == 1) the receiver is slot 0 ("this"),
        // followed by the user arguments. Deferred lambda slots are left null so
        // unification skips them.
        let symbolicArgs = [boundArgs.Length + offset]TypeSymbol?
        if offset == 1 {
            // receiverType: non-null per the `offset == 1 && receiverType ==
            // null` early return above.
            symbolicArgs[0] = receiverType!!
        }
        for var i = 0; i < boundArgs.Length; i++ {
            symbolicArgs[i + offset] = if deferred.Contains(i) {
                default(TypeSymbol?)
            } else {
                boundArgs[i]?.Type
            }
        }
        let receiverOpenDefinition Type? = (receiverType as ImportedTypeSymbol)?.OpenDefinition
        let receiverTypeArguments = (receiverType as ImportedTypeSymbol)?.TypeArguments ??
            ImmutableArray[TypeSymbol].Empty
        // Record the expected delegate arity for each deferred lambda slot.
        let arityByIndex = Dictionary[int32, int32]()
        for idx in deferredIndices {
            let inner = OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[idx])
            if inner is not LambdaExpressionSyntax lambda {
                return false
            }
            arityByIndex[idx] = lambda.Parameters.Count
        }
        var agreed Dictionary[int32, (DelegateType TypeSymbol, ParameterTypes ImmutableArray[TypeSymbol])]? = nil
        var agreedReturnTypes Dictionary[int32, TypeSymbol]? = nil
        var anySymbolicType = false
        for method in methods {
            if method == nil {
                continue
            }
            var openMethod MethodInfo
            var openParameters[]ParameterInfo
            // Issue #3659: the candidate as reflected off the receiver's own
            // (erased) closed CLR type — its parameter types are already in the
            // receiver's erasure domain, which is what the rebound lambda's
            // argument type must land in.
            var closedParameters[]ParameterInfo
            try {
                closedParameters = method.GetParameters()
                if receiverOpenDefinition != nil &&
                    TryResolveOpenMethodByToken(
                    receiverOpenDefinition,
                    method,
                    if method.IsStatic {
                        BindingFlags.Static
                    } else {
                        BindingFlags.Instance
                    },
                    out var resolvedOpenMethod
                ) {
                    openMethod = resolvedOpenMethod!!
                } else if method.IsGenericMethod {
                    openMethod = if method.IsGenericMethodDefinition {
                        method
                    } else {
                        method.GetGenericMethodDefinition()
                    }
                } else {
                    continue
                }
                openParameters = openMethod.GetParameters()
            } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                continue
            }
            if openParameters.Length < symbolicArgs.Length {
                continue
            }
            let mappedSymbolicArgs = [openParameters.Length]TypeSymbol?
            if offset == 1 {
                // receiverType: non-null per the `offset == 1 && receiverType ==
                // null` early return above.
                mappedSymbolicArgs[0] = receiverType!!
            }
            var mappingValid = true
            for var sourceIndex = 0; sourceIndex < boundArgs.Length; sourceIndex++ {
                let parameterIndex = MapSourceArgumentToParameter(openParameters, ce, sourceIndex, offset)
                if parameterIndex < 0 ||
                    parameterIndex >= mappedSymbolicArgs.Length ||
                    mappedSymbolicArgs[parameterIndex] != nil {
                    mappingValid = false
                    break
                }
                mappedSymbolicArgs[parameterIndex] = if deferred.Contains(sourceIndex) {
                    default(TypeSymbol?)
                } else {
                    boundArgs[sourceIndex]?.Type
                }
            }
            if !mappingValid {
                continue
            }
            let inferred = if !explicitTypeArgSymbols.IsDefaultOrEmpty && openMethod.GetGenericArguments()
                .Length == explicitTypeArgSymbols.Length {
                explicitTypeArgSymbols.ToArray()
            } else {
                MemberLookup.InferSymbolicMethodTypeArguments(openMethod, ImmutableArray.Create(mappedSymbolicArgs))
            }
            let methodTypeArgs = ImmutableArray.Create(inferred)
            let slotTargets = Dictionary[int32, (DelegateType TypeSymbol, ParameterTypes ImmutableArray[TypeSymbol])]()
            let slotReturnTypes = Dictionary[int32, TypeSymbol]()
            var candidateUsable = true
            var candidateHasSymbolicType = false
            for idx in deferredIndices {
                let paramIndex = MapSourceArgumentToParameter(openParameters, ce, idx, offset)
                if paramIndex < 0 || paramIndex >= openParameters.Length {
                    candidateUsable = false
                    break
                }
                // Issue #5543: a lambda is a plain value, so an `in` slot targets its pointee.
                let openParameterType = ConversionClassifier.GetPlainValueClrParameterType(openParameters[paramIndex])
                var mappedDelegate TypeSymbol?
                var functionType FunctionTypeSymbol?
                // Issue #3666: set when the delegate's RETURN shape was closed
                // entirely by this unification — every method type parameter it
                // mentions was resolved — even though it still mentions an
                // enclosing type parameter carried by the receiver's symbolic
                // arguments (e.g. `[]TMember` from
                // `MemberCache[TMember].Cache : ConcurrentDictionary[(Type,
                // BindingFlags), []TMember]`). Such a return cannot be recorded
                // as an *exact* target return (the lambda body still has to
                // infer it), but it does prove the reflected CLR target would be
                // erased, so this symbolic path must win over the CLR probe.
                var returnGroundedInReceiver = false
                if openParameterType.IsGenericParameter {
                    if !TryBuildSymbolicDelegateTarget(
                        openParameterType,
                        receiverOpenDefinition,
                        receiverTypeArguments,
                        out mappedDelegate,
                        out functionType
                    ) {
                        candidateUsable = false
                        break
                    }
                } else {
                    var invoke MethodInfo?
                    var invokeParameters[]?ParameterInfo
                    try {
                        var delegateType = openParameterType
                        if MemberLookup.TryGetExpressionTreeDelegateType(delegateType, out var unwrappedDelegateType) {
                            delegateType = unwrappedDelegateType
                        }
                        invoke = delegateType?.GetMethodSafe("Invoke")
                        invokeParameters = invoke?.GetParameters()
                    } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                        candidateUsable = false
                        break
                    }
                    if (invoke == nil || invokeParameters == nil || invokeParameters.Length != arityByIndex[idx]) {
                        candidateUsable = false
                        break
                    }
                    // Issue #903: only trust this candidate's delegate parameter
                    // shape when every method type parameter reachable from it was
                    // actually resolved by unifying the receiver/arguments. When a
                    // candidate's "this" parameter does not match the receiver
                    // shape (e.g. a `Single` overload over `IQueryable<T>` against a
                    // `List` receiver), the relevant slot stays unresolved and
                    // MapOpenClrTypeToSymbolic would otherwise surface a bogus open
                    // parameter (an ImportedTypeSymbol named "T") that neither
                    // ContainsTypeParameter nor ContainsSameCompilationUserType
                    // flags — which would then disagree with the correct candidate
                    // and abort the whole inference. Skip such candidates instead.
                    var unresolvedSlot = false
                    for invokeParameter in invokeParameters {
                        if !AllMethodTypeParametersResolved(invokeParameter.ParameterType, openMethod, inferred) {
                            unresolvedSlot = true
                            break
                        }
                    }
                    if unresolvedSlot {
                        candidateUsable = false
                        break
                    }
                    let parameterTypes = ImmutableArray.CreateBuilder[TypeSymbol](invokeParameters.Length)
                    var slotUsable = true
                    for invokeParameter in invokeParameters {
                        let mapped TypeSymbol? = MemberLookup.MapOpenSignatureWithoutDeclarationMerge(
                            PeelByRef(invokeParameter.ParameterType),
                            receiverOpenDefinition,
                            receiverTypeArguments,
                            openMethod,
                            methodTypeArgs
                        )
                        if mapped == nil || mapped == TypeSymbol.Error {
                            slotUsable = false
                            break
                        }
                        parameterTypes.Add(mapped)
                    }
                    if !slotUsable {
                        candidateUsable = false
                        break
                    }
                    mappedDelegate = MemberLookup.MapOpenSignatureWithoutDeclarationMerge(
                        openParameterType,
                        receiverOpenDefinition,
                        receiverTypeArguments,
                        openMethod,
                        methodTypeArgs
                    )
                    if mappedDelegate == nil || mappedDelegate == TypeSymbol.Error {
                        candidateUsable = false
                        break
                    }
                    // Issue #3659: re-anchor the mapped delegate's ERASED CLR
                    // shape on this candidate's own closed parameter type.
                    // `MapOpenClrTypeToSymbolic` re-erases the symbolic type
                    // arguments through the inference-oriented erasure, which
                    // does not always agree with the erasure the receiver was
                    // closed with — a same-compilation enum rides through as
                    // `Int32` there but as `object` in the receiver
                    // (`List[TokMod]` is `List<object>`, so its `Sort` candidate
                    // takes `Comparison<object>` while the mapped target claimed
                    // `Comparison<Int32>`), and a slice of a same-compilation
                    // type collapses to `object` there but stays `object[]` in
                    // the receiver. Either divergence makes the rebound lambda's
                    // argument type unassignable to EVERY candidate, so the call
                    // dead-ends at GS0159 "Cannot find function Sort". The
                    // candidate's own parameter type is by construction in the
                    // receiver's erasure domain; keep the symbolic arguments
                    // (which carry the real element identity for emit) and swap
                    // only the erased CLR shape.
                    if mappedDelegate is ImportedTypeSymbol{OpenDefinition: {} mappedOpenDefinition} mappedImported &&
                        paramIndex < closedParameters.Length &&
                        ConversionClassifier.GetPlainValueClrParameterType(
                        closedParameters[paramIndex]
                    ) is {} closedParameterType &&
                        !closedParameterType.ContainsGenericParameters &&
                        !closedParameterType.IsSameAs(mappedImported.ClrType) &&
                        closedParameterType.IsGenericType &&
                        ClrTypeUtilities
                        .AreSame(closedParameterType.GetGenericTypeDefinition(), mappedOpenDefinition) {
                        mappedDelegate = ImportedTypeSymbol.GetConstructed(
                            closedParameterType,
                            mappedOpenDefinition,
                            mappedImported.TypeArguments
                        )
                    }
                    let returnClrType Type? = invoke.ReturnType
                    let mappedReturnType = if returnClrType != nil && returnClrType.IsSameAs(typeof(Void)) {
                        TypeSymbol.Void
                    } else {
                        MemberLookup.MapOpenSignatureWithoutDeclarationMerge(
                            returnClrType,
                            receiverOpenDefinition,
                            receiverTypeArguments,
                            openMethod,
                            methodTypeArgs
                        )
                    }
                    functionType = FunctionTypeSymbol.Get(parameterTypes.ToImmutable(), mappedReturnType)
                    returnGroundedInReceiver = returnClrType != nil &&
                        AllMethodTypeParametersResolved(returnClrType, openMethod, inferred)
                }
                for parameterType in functionType.ParameterTypes {
                    if TypeSymbol.RequiresSymbolicProjection(parameterType) {
                        candidateHasSymbolicType = true
                    }
                }
                slotTargets[idx] = (mappedDelegate, functionType.ParameterTypes)
                // Issue #2345: recover the delegate's return shape too, when it
                // is fully closed by this unification (most commonly `void`,
                // for an Action-shaped constraints/configuration delegate).
                // Candidates that leave the return type open (e.g. still
                // containing an unresolved method type parameter) fall back to
                // the pre-existing placeholder + inferReturnTypeFromBody
                // behavior for that slot.
                let mappedReturn TypeSymbol? = functionType.ReturnType
                if mappedReturn != nil && mappedReturn != TypeSymbol.Error && !TypeSymbol.ContainsTypeParameter(
                    mappedReturn
                ) {
                    slotReturnTypes[idx] = mappedReturn
                    if TypeSymbol.RequiresSymbolicProjection(mappedReturn) {
                        candidateHasSymbolicType = true
                    }
                } else if returnGroundedInReceiver &&
                    mappedReturn != nil &&
                    mappedReturn != TypeSymbol.Error &&
                    TypeSymbol
                    .RequiresSymbolicProjection(mappedReturn) {
                    // Issue #3666: the return shape is fully determined by the
                    // receiver's symbolic arguments yet still mentions a type
                    // parameter, so it stays a placeholder (the body infers it)
                    // — but the shape IS symbolic information reflection cannot
                    // represent, so this candidate must count toward the success
                    // gate below. Otherwise the whole symbolic recovery declines
                    // and the CLR probe binds the lambda against the receiver's
                    // erased target instead: `MemberCache[TMember].Cache
                    // .GetOrAdd(key, k -> …)` got `Func[…, object[]]`, and the
                    // body's genuine `[]TMember` result failed to convert
                    // (GS0155). This slot deliberately does NOT enter
                    // `slotReturnTypes`, so the lambda still infers its own
                    // return type from the body.
                    candidateHasSymbolicType = true
                }
            }
            if !candidateUsable || slotTargets.Count != deferredIndices.Count {
                continue
            }
            if agreed == nil {
                agreed = slotTargets
                agreedReturnTypes = slotReturnTypes
            } else if !SymbolicLambdaTargetsAgree(agreed, slotTargets) {
                return false
            } else {
                // Issue #2345: parameter shapes agree across candidates, but
                // only keep a recovered return type for a slot when every
                // agreeing candidate recovered the *same* return type;
                // otherwise that slot falls back to the pre-existing
                // placeholder + inferReturnTypeFromBody behavior.
                for idx in deferredIndices {
                    // agreedReturnTypes: always assigned in the same branch as
                    // `agreed`, so it is non-null whenever `agreed` is (the else
                    // branch above only runs once a prior iteration set both).
                    if agreedReturnTypes!!.TryGetValue(idx, out var existingReturn) {
                        if !slotReturnTypes.TryGetValue(idx, out var otherReturn) ||
                            !DeclarationBinder.TypeSignaturesEquivalent(existingReturn, otherReturn) {
                            agreedReturnTypes!!.Remove(idx)
                        }
                    }
                }
            }
            anySymbolicType |= candidateHasSymbolicType
        }
        if agreed == nil || !anySymbolicType {
            return false
        }
        let built = Dictionary[int32, (DelegateType TypeSymbol, FunctionType FunctionTypeSymbol)]()
        for kv in agreed {
            if agreedReturnTypes != nil && agreedReturnTypes.TryGetValue(kv.Key, out var exactReturn) {
                // Issue #2345: the delegate's return shape was fully closed by
                // unification (e.g. `void` for an Action-shaped parameter) —
                // bind against the real target so the caller does NOT pass
                // inferReturnTypeFromBody, letting InferLambdaReturnType's
                // void-discard rule (issue #889) and ordinary target-typed
                // inference apply.
                built[kv.Key] = (kv.Value.DelegateType, FunctionTypeSymbol.Get(kv.Value.ParameterTypes, exactReturn))
                exactReturnIndices.Add(kv.Key)
            } else {
                // The return slot is a placeholder; callers bind with
                // inferReturnTypeFromBody so the lambda infers its own return type.
                built[kv.Key] = (
                    kv.Value.DelegateType,
                    FunctionTypeSymbol.Get(kv.Value.ParameterTypes, TypeSymbol.Object)
                )
            }
        }
        targets = built
        return true
    }

    /// Issue #977: re-binds inline `out var`/`out let`/`out _`
    /// placeholder arguments against the by-ref parameters of the resolved
    /// imported method, declaring each new local with the parameter's pointee
    /// type. Returns the (possibly rebuilt) argument vector.
    /// @param ce The call expression syntax.
    /// @param arguments The bound arguments (with placeholder out-var entries).
    /// @param resolvedMethod The chosen imported method (constructed if generic).
    /// @param parameterMapping The source-argument → parameter-position mapping; default for positional
    /// calls.
    /// @param receiverType The receiver's static type (for symbolic by-ref-parameter recovery); may be
    /// `null`.
    /// @param typeArgSymbols The explicit type-argument symbols (issue #1599, for recovering a
    /// placeholder-closed out-parameter pointee); default when absent.
    /// @returns The argument vector with inline out-var placeholders rebound.
    private func RebindInlineOutVarArguments(
        ce CallExpressionSyntax,
        arguments ImmutableArray[BoundExpression],
        resolvedMethod MethodInfo,
        parameterMapping ImmutableArray[int32],
        receiverType TypeSymbol? = nil,
        typeArgSymbols ImmutableArray[TypeSymbol] = default(ImmutableArray[TypeSymbol])
    ) ImmutableArray[BoundExpression] {
        var rebuilt ImmutableArray[BoundExpression].Builder? = nil
        var parameters[]?ParameterInfo = nil
        var symbolicMethodTypeArgs = default(ImmutableArray[TypeSymbol?])
        var symbolicMethodTypeArgsComputed = false
        for var i = 0; i < arguments.Length; i++ {
            if !TryGetInlineOutVarArgument(ce, i, out var refArg) {
                continue
            }
            parameters ??= resolvedMethod.GetParameters()
            // Issue #4350: an inferred (not explicitly listed) method type
            // argument that is an in-scope G# type parameter was erased to
            // `object` when the CLR method closed, so recover the symbolic
            // vector from the other arguments before typing the new local.
            if !symbolicMethodTypeArgsComputed && resolvedMethod.IsGenericMethod {
                symbolicMethodTypeArgsComputed = true
                symbolicMethodTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(
                    resolvedMethod,
                    typeArgSymbols,
                    SymbolicArgumentTypesInParameterOrder(arguments, parameterMapping, parameters!!.Length)
                )
            }
            let paramIndex = if !parameterMapping.IsDefault && i < parameterMapping.Length {
                parameterMapping[i]
            } else {
                i
            }
            if paramIndex < 0 || paramIndex >= parameters!!.Length {
                continue
            }
            // Issue #1107: when the by-ref parameter's pointee is a type-level
            // generic parameter on the receiver (e.g. `Dictionary[string,
            // Entry].TryGetValue(string, out TValue)`), the resolved CLR method
            // erased `TValue` to `object`, so the out-var local would bind as
            // `object` and member access on it (`found.V`) would fail (GS0158).
            // Recover the symbolic pointee type from the receiver's symbolic
            // type arguments (mirroring `MemberLookup.GetClrReceiverProjectedReturnTypeSymbol`).
            //
            // ADR-0193 Phase 2: the fallback reads through the funnel but keeps
            // the bare shape the local always had. Giving it the parameter's
            // declared `?` (`[NotNullWhen(true)] out Uri? result`) is right in
            // principle but needs `out var` flow narrowing first; migrated code
            // such as `if !Uri.TryCreate(s, k, out var u) { continue }; return u`
            // stops compiling without it. Tracked on #4363.
            let pointeeType = MemberLookup.GetClrReceiverProjectedParameterPointeeTypeSymbol(
                receiverType,
                resolvedMethod,
                paramIndex
            ) ??
                ResolveMethodGenericParameterPointeeType(resolvedMethod, paramIndex, typeArgSymbols) ??
                MemberLookup
                .ResolveByRefParameterPointeeFromSymbolicTypeArgs(
                resolvedMethod,
                paramIndex,
                symbolicMethodTypeArgs,
                receiverType
            ) ??
                ClrNullability
                .GetParameterTypeSymbol(parameters!![paramIndex]).StripToBareShape()
            let syntheticParameter = RefCapabilities.CreateParameterSymbol(
                parameters!![paramIndex],
                pointeeType,
                "value"
            )
            let rebound = BindRefArgumentExpression(refArg, syntheticParameter)
            rebuilt ??= arguments.ToBuilder()
            rebuilt!![i] = rebound
        }
        return if rebuilt != nil {
            rebuilt.ToImmutable()
        } else {
            arguments
        }
    }

    internal func BindAccessorCall(
        receiver BoundExpression?,
        classSymbol ImportedClassSymbol?,
        ce CallExpressionSyntax,
        receiverSyntax ExpressionSyntax? = nil,
        receiverStart int32? = nil
    ) BoundExpression {
        let frame = CallCandidateRecorder.Begin(ce)
        try {
            let bound = BindAccessorCallWithReceiver(receiver, classSymbol, ce, receiverSyntax, receiverStart)
            CallCandidateRecorder.Stamp(frame, bound)
            return bound
        } finally {
            CallCandidateRecorder.End(frame)
        }
    }

    private func BindAccessorCallWithReceiver(
        receiver BoundExpression?,
        classSymbol ImportedClassSymbol?,
        ce CallExpressionSyntax,
        receiverSyntax ExpressionSyntax?,
        receiverStart int32?
    ) BoundExpression {
        if receiver != nil && NativeSliceTypes.TryGetElement(receiver.Type, out _, out _) {
            let statements = ImmutableArray.CreateBuilder[BoundStatement]()
            let saved = DeclareRangeTemp("callReceiver", receiver.Type, receiver, statements)
            let call = BindAccessorCallKeepingLiteralTargetErrors(
                BoundVariableExpression(receiver.Syntax, saved),
                classSymbol,
                ce,
                receiverSyntax,
                receiverStart
            )
            return BoundBlockExpression(ce, statements.ToImmutable(), call)
        }
        return BindAccessorCallKeepingLiteralTargetErrors(receiver, classSymbol, ce, receiverSyntax, receiverStart)
    }

    private func BindAccessorCallKeepingLiteralTargetErrors(
        receiver BoundExpression?,
        classSymbol ImportedClassSymbol?,
        ce CallExpressionSyntax,
        receiverSyntax ExpressionSyntax?,
        receiverStart int32?
    ) BoundExpression {
        let pending = literalTargetDiagnostics.Count
        let mark = Diagnostics.Count
        let call = BindAccessorCallCore(receiver, classSymbol, ce, receiverSyntax, receiverStart)
        ReportDiscardedLiteralTargetDiagnostics(pending, HasErrorDiagnosticSince(mark))
        return call
    }

    private func BindAccessorCallCore(
        receiver BoundExpression?,
        classSymbol ImportedClassSymbol?,
        ce CallExpressionSyntax,
        receiverSyntax ExpressionSyntax?,
        receiverStart int32?
    ) BoundExpression {
        var receiver = receiver
        var classSymbol = classSymbol
        // A derived class may call an inherited `protected` static member by a
        // type name (`Regex.ValidateMatchTimeout(...)` inside a class deriving
        // from `Regex`), exactly as in C#.
        classSymbol = if classSymbol == nil {
            default(ImportedClassSymbol?)
        } else {
            WithFamilyAccess(classSymbol)
        }
        let methodName = ce.Identifier.ValueText
        if string.Equals(methodName, "Invoke", StringComparison.Ordinal) {
            let effectiveReceiverSyntax SyntaxNode? = receiverSyntax ?? receiver?.Syntax
            let receiverLocation = effectiveReceiverSyntax?.Location ?? ce.Identifier.Location
            let receiverName = if effectiveReceiverSyntax == nil {
                methodName
            } else {
                effectiveReceiverSyntax.SyntaxTree.Text.ToString(effectiveReceiverSyntax.Span)
            }
            if receiver != nil &&
                (receiver.Type is FunctionTypeSymbol or NullableTypeSymbol and {UnderlyingType: FunctionTypeSymbol}) &&
                ce.TypeArgumentList == nil {
                return if ce.NullableQuestionToken != nil {
                    overloads.BindNullConditionalIndirectCallExpression(ce, receiver, receiverName, receiverLocation)
                } else {
                    overloads.BindIndirectCallExpression(
                        ce,
                        receiver,
                        receiverName,
                        receiverLocation,
                        nullSafeInvocation: "?(...)"
                    )
                }
            }
            if overloads.TryReportNullableDelegateReceiver(
                receiver?.Type,
                receiverLocation,
                receiverName,
                OverloadResolver.GetNullableDelegateNullSafeInvocation()
            ) {
                return BoundErrorExpression(nil)
            }
        }
        var hasNamedArguments = false
        for argument in ce.Arguments {
            hasNamedArguments |= argument is NamedArgumentExpressionSyntax
        }
        if classSymbol == nil &&
            methodName == "copy" &&
            (hasNamedArguments || (receiver != nil && GetDataCopyType(receiver.Type) != nil)) {
            if TryGetCopyOverrides(ce, out var overrides) {
                // classSymbol == null here (outer condition): every
                // BindAccessorCall(receiver: null, ...) call site in the
                // codebase pairs it with a non-null classSymbol, so a real
                // receiver is always present when classSymbol is null.
                return LowerCopyOrWith(receiver!!, overrides, ce.Identifier.Location, ce)
            }
            Diagnostics.ReportNamedArgumentOnlyValidForCopy(ce.Location)
            return BoundErrorExpression(nil)
        }
        // Issue #343: validate named-argument layout (positional precedes named,
        // no duplicate names). Errors are reported by the helper so the call
        // short-circuits to a bound error here.
        if !overloads.TryAnalyzeCallArgumentLayout(ce.Arguments, out _, out var argumentNames) {
            return BoundErrorExpression(nil)
        }
        // Issue #311: resolve an explicit `[T1, T2]` type-argument list (e.g.
        // `Array.Empty[string]()`) into mapped CLR types up front so every
        // generic-method dispatch path below can close the candidate.
        let typeArgMark = Diagnostics.Count
        if !TryResolveExplicitMethodTypeArgs(ce.TypeArgumentList, out var explicitTypeArgs, out var typeArgSymbols) {
            // Issue #3880: `receiver.Member[i](args)` is committed to a generic
            // call site by ADR-0020's follow-set rule, so `i` is resolved here
            // as a TYPE and the call dies with "type 'i' doesn't exist" before
            // the indexer-then-invoke reading is ever considered. Recover only
            // where that reading is actually available — the bracket holds a
            // bare identifier and the receiver really has a VALUE member of
            // this name — so a genuine unresolvable type argument on a generic
            // method still reports its own diagnostic.
            let indexableOwner = receiver?.Type ??
                classSymbol?.SymbolicReceiver ??
                (
                if classSymbol == nil {
                    default(TypeSymbol?)
                } else {
                    TypeSymbol.FromClrTypeWithoutNullability(classSymbol.ClassType, NullabilityFreeReason.TypeStructure)
                }
            )
            if !IsAmbiguousSingleIdentifierTypeArgument(ce.TypeArgumentList) ||
                indexableOwner is not{} receiverType ||
                !HasCallableIndexableValueMember(receiverType, methodName) {
                Diagnostics.ReportUnableToFindFunction(ce.Location, methodName)
                return BoundErrorExpression(nil)
            }
            Diagnostics.TruncateTo(typeArgMark)
            explicitTypeArgs = nil
            typeArgSymbols = default(ImmutableArray[TypeSymbol])
        }
        let boundArguments = ImmutableArray.CreateBuilder[BoundExpression]()
        let deferredArrowLambdaIndices = List[int32]()
        var delegateTargetCandidateParams List[[]ParameterInfo]? = nil
        var delegateTargetCandidatesComputed = false
        var argSlot = 0
        for argument in ce.Arguments {
            let inner = OverloadResolver.UnwrapNamedArgumentValue(argument)
            if inner is RefArgumentExpressionSyntax refArg {
                boundArguments.Add(BindRefArgumentExpression(refArg, parameter: nil))
            } else if IsTargetDependentBlockArgumentSyntax(inner) {
                if !delegateTargetCandidatesComputed {
                    delegateTargetCandidatesComputed = true
                    delegateTargetCandidateParams = CollectDelegateTargetCandidateParameterLists(
                        receiver,
                        classSymbol,
                        methodName
                    )
                }
                let argumentName = if argumentNames.IsDefault {
                    default(string?)
                } else {
                    argumentNames[argSlot]
                }
                boundArguments.Add(
                    if TryResolveTargetDependentBlockTarget(
                        Invariant.Required(
                            delegateTargetCandidateParams,
                            "target-dependent block resolution has collected candidate parameter lists",
                            expression: "delegateTargetCandidateParams"
                        ),
                        parameterOffset: 0,
                        ce.Arguments.Count,
                        argSlot,
                        argumentName,
                        inner,
                        out var blockTarget
                    ) {
                        BindExpression(inner, blockTarget!!)
                    } else {
                        cast[BoundExpression](BoundErrorExpression(inner))
                    }
                )
            } else if IsUntypedArrowLambda(inner) {
                // Issue #891: defer binding of an un-typed arrow lambda until
                // the target delegate type is known. Binding it now would emit
                // GS0304 (cannot infer parameter type) and produce an error-typed
                // argument that aborts overload resolution — which is exactly why
                // `list.Single((c) -> c.Id == "x")` reported "Cannot find function
                // Single" while the explicit `func(c DoctorCheck) bool { ... }`
                // form worked. The placeholder keeps argument positions aligned;
                // the real binding happens once the (possibly generic) overload —
                // including LINQ extension methods — has been resolved below.
                deferredArrowLambdaIndices.Add(argSlot)
                boundArguments.Add(BoundErrorExpression(inner))
            } else if inner is LambdaExpressionSyntax {
                // Issue #908: target-type an arrow lambda argument from the
                // matching delegate-typed parameter of the applicable CLR
                // static/instance/extension methods before binding it, mirroring
                // the constructor path (BindCallArgumentWithDelegateTargetTyping).
                // Without this, `Factory.CreateStatic(() -> MemoryStream())`
                // binds the lambda with its body-derived return type
                // (`() -> MemoryStream`) before overload resolution and fails to
                // match a `Func<Stream>` parameter (GS0159). Pinning the return
                // type from the delegate target yields `() -> Stream` directly so
                // the call resolves and the produced delegate is created over a
                // method whose return already matches the parameter.
                //
                // Issue #2193: but if a same-named user extension function has a
                // function-typed parameter at this position, the CLR candidate
                // set is not authoritative — target-typing the lambda to a CLR
                // delegate (e.g. the void `SendOrPostCallback` of
                // `SynchronizationContext.Send`) would erase the lambda's return
                // type and break inference of the extension's result type
                // parameter (GS0151). Bind the lambda with its natural type so
                // both the CLR instance method and the user extension can compete
                // (delegate-reshaping conversions still make it applicable to a
                // concrete CLR delegate parameter when that path is chosen).
                let argName = if argumentNames.IsDefault {
                    default(string?)
                } else {
                    argumentNames[argSlot]
                }
                let symbolicReceiver ImportedTypeSymbol? = receiver?.Type as ImportedTypeSymbol ??
                    classSymbol?.SymbolicReceiver
                var lambdaHandled = false
                if !lambdaHandled &&
                    symbolicReceiver != nil &&
                    !symbolicReceiver
                    .TypeArguments
                    .IsDefaultOrEmpty &&
                    symbolicReceiver
                    .TypeArguments
                    .Any(TypeSymbol.RequiresSymbolicProjection) {
                    // Issue #2673 / #2810: a constructed imported instance or
                    // static receiver can erase a symbolic type argument to
                    // object in reflection. Defer the lambda so the symbolic
                    // target pass recovers the open delegate signature.
                    deferredArrowLambdaIndices.Add(argSlot)
                    boundArguments.Add(BoundErrorExpression(inner))
                    lambdaHandled = true
                }
                if !lambdaHandled && UserExtensionHasFunctionTypedParameterAt(receiver, methodName, argSlot) {
                    boundArguments.Add(BindExpression(inner))
                    lambdaHandled = true
                }
                if !lambdaHandled {
                    if !delegateTargetCandidatesComputed {
                        delegateTargetCandidatesComputed = true
                        delegateTargetCandidateParams = CollectDelegateTargetCandidateParameterLists(
                            receiver,
                            classSymbol,
                            methodName
                        )
                    }
                    // delegateTargetCandidateParams: assigned above whenever
                    // delegateTargetCandidatesComputed transitions to true, which
                    // just happened on this iteration or a previous one.
                    let hasClosedTarget = TryResolveDelegateTargetFromCandidates(
                        delegateTargetCandidateParams!!,
                        paramOffset: 0,
                        sourceArgIndex: argSlot,
                        argName: argName,
                        target: out var target,
                        nominalTarget: out var nominalTarget,
                        blockedByOpenGenericParameter: out var blocked,
                        sawOpenGenericParameter: out var sawOpen
                    )
                    // Issue #2345: an explicitly-typed lambda whose matching
                    // delegate parameter is an *open* generic (e.g. an imported
                    // generic method's `Action<Builder<TColumns>>`, where
                    // `TColumns` only closes once the method's type arguments
                    // are inferred from the call's other arguments) cannot be
                    // target-typed yet. Binding it now with no target is only
                    // safe for an expression-bodied lambda (`-> expr`), whose
                    // return type is unambiguously the expression's type either
                    // way. A block-bodied lambda (`-> { ... }`) is different:
                    // with no target, a trailing call expression-statement (e.g.
                    // a fluent/self-returning builder method) is treated as the
                    // block's *value*, producing a `Func<..., TResult>`-shaped
                    // lambda instead of the `void`-returning `Action` the (still
                    // unresolved) target actually expects — which mismatches the
                    // real parameter and cascades into "cannot find function" at
                    // the outer call. Defer such lambdas exactly like an
                    // untyped arrow lambda so the staged inference below
                    // (`ResolveDeferredArrowLambdaArguments`) can close the
                    // generic method's type arguments from the other arguments
                    // first, then bind this lambda against the now-closed
                    // delegate target (its own explicit parameter types are
                    // unaffected — only return-type inference depends on the
                    // target).
                    //
                    // Issue #3149: a mixed open/closed set must also wait for
                    // overload resolution. The closed candidate supplies the
                    // shared function shape, but only the selected method can
                    // determine whether the lambda needs a named delegate.
                    let lambdaSyntax LambdaExpressionSyntax? = inner as LambdaExpressionSyntax
                    if (lambdaSyntax?.Body is BlockExpressionSyntax && !hasClosedTarget && blocked) ||
                        (hasClosedTarget && sawOpen) {
                        deferredArrowLambdaIndices.Add(argSlot)
                        boundArguments.Add(BoundErrorExpression(inner))
                        lambdaHandled = true
                    }
                    if !lambdaHandled && lambdaSyntax != nil && hasClosedTarget {
                        // target: non-null whenever hasClosedTarget is true
                        // ([NotNullWhen(true)] on TryResolveDelegateTargetFromCandidates).
                        let functionTarget = target!!
                        let slotIndex = argSlot
                        boundArguments.Add(
                            BindLambdaWithCandidateTarget(
                                lambdaSyntax,
                                delegateTargetCandidateParams!!,
                                (parameters[]ParameterInfo) -> FindCandidateSlot(parameters, 0, slotIndex, argName),
                                () -> BindLambdaWithDelegateTarget(
                                    argument,
                                    lambdaSyntax,
                                    functionTarget,
                                    nominalTarget
                                )
                            )
                        )
                        lambdaHandled = true
                    }
                    if !lambdaHandled {
                        boundArguments.Add(BindExpression(inner))
                    }
                }
            } else {
                boundArguments.Add(BindArgumentDeferringBranchy(inner))
            }
            argSlot++
        }
        if deferredArrowLambdaIndices.Count > 0 {
            let mutableArgs = boundArguments.ToArray()
            ResolveDeferredArrowLambdaArguments(
                receiver,
                classSymbol,
                methodName,
                ce,
                explicitTypeArgs,
                typeArgSymbols,
                deferredArrowLambdaIndices,
                mutableArgs
            )
            // Issue #951: the reflection-driven resolution above only covers CLR
            // (imported) methods. When the receiver is a user-declared
            // class/struct/interface, recover the target delegate shape from the
            // user method's own parameter symbols so an arrow lambda passed to a
            // user method with a delegate-typed parameter (e.g.
            // `calc.Apply((x) -> x * 2)`) infers its parameter type too.
            ResolveDeferredArrowLambdaArgumentsFromUserMethods(
                receiver,
                methodName,
                ce,
                deferredArrowLambdaIndices,
                mutableArgs
            )
            // Any lambda whose target could not be inferred is now bound without
            // a target so the established GS0304 diagnostic still surfaces.
            for idx in deferredArrowLambdaIndices {
                let placeholder = mutableArgs[idx] as BoundErrorExpression
                let pendingLambda LambdaExpressionSyntax? = placeholder?.Syntax as LambdaExpressionSyntax
                if pendingLambda != nil {
                    mutableArgs[idx] = lambdas.BindLambdaExpression(pendingLambda)
                }
            }
            boundArguments.Clear()
            boundArguments.AddRange(mutableArgs)
        }
        var arguments = boundArguments.ToImmutable()
        if !ValidateNativeSharingArguments(classSymbol, methodName, arguments, ce) {
            return BoundErrorExpression(ce)
        }
        if classSymbol != nil {
            if classSymbol.TryLookupNativeFunction(
                methodName,
                ce,
                arguments,
                out var staticFn,
                out var staticMapping,
                out var staticAmbiguous,
                out var staticAmbiguousMethods,
                out var staticIsExpanded,
                explicitTypeArgs,
                typeArgSymbols,
                $scope.References!!.MapClrTypeToReferences,
                if argumentNames.IsDefault {
                    default(IReadOnlyList[string]?)
                } else {
                    cast[IReadOnlyList[string]](argumentNames)
                },
                func (closed MethodInfo, isExpanded bool, vector ImmutableArray[TypeSymbol])(
                    RefinedArgs ImmutableArray[TypeSymbol],
                    MethodGroupSlots ImmutableArray[bool]
                ) {
                    // `argumentNames!` below: the ternary's `IsDefault` arm
                    // already routes a default array to `null`; that branch
                    // only runs once `argumentNames` is known non-default, so
                    // the cast to `IReadOnlyList<string?>` widens the element
                    // type's static nullability (a `string` element read back
                    // as `string?`) — it does not introduce an actual null the
                    // array doesn't already hold.
                    let refinedArgs = RefineSymbolicArgsForMethodGroups(
                        closed,
                        arguments,
                        vector,
                        receiverArgCount: 0,
                        isExpanded: isExpanded,
                        argumentNames: if argumentNames.IsDefault {
                            default(IReadOnlyList[string?]?)
                        } else {
                            cast[IReadOnlyList[string?]](argumentNames)
                        },
                        parameterMapping: default(ImmutableArray[int32]),
                        methodGroupSlots: out var groupSlots
                    )
                    // Issue #4133 (hot-core translation guard finding): see
                    // MergeMethodGroupArgumentSlots's doc.
                    groupSlots = MergeMethodGroupArgumentSlots(
                        arguments,
                        receiverArgCount: 0,
                        refinedArgs.Length,
                        groupSlots
                    )
                    return (refinedArgs, groupSlots)
                },
                nativeConversions: conversions
            ) {
                // Issue #1538: now that the imported static overload is chosen,
                // re-bind any inline `out var`/`out let`/`out _` placeholders
                // against the resolved by-ref parameter so the synthesized local
                // is declared with the inferred (substituted) pointee type and
                // leaks into the enclosing block scope. Without this the
                // placeholder (an Error-typed address-of) would flow into the
                // parameter-conversion path below and the inline-declared local
                // would never exist for the rest of the body. Static calls have
                // no value receiver, but the constructed container still supplies
                // type arguments (including native slice element nullability).
                arguments = RebindInlineOutVarArguments(
                    ce,
                    arguments,
                    staticFn!!.Method,
                    staticMapping,
                    classSymbol.SymbolicReceiver ?? receiver?.Type,
                    typeArgSymbols
                )
                // Issue #1330: when the receiver is a generic type constructed
                // over an in-scope generic type parameter (`Comparer[TResult]`),
                // bind the static call symbolically — substituting the receiver's
                // symbolic arguments through the resolved method's parameter and
                // return types — so a delegate parameter surfaces as
                // `Comparison[TResult]` (the lambda flows through as an identity
                // adapter hosted in the enclosing generic context rather than a
                // type-erased `<object>` adapter referencing an out-of-scope
                // type parameter), the call's result type is the symbolic
                // `Comparer[TResult]`, and the emitter parents the call at the
                // constructed `Comparer<!TResult>` TypeSpec. Yields verifiable IL
                // exactly as the concrete-argument receiver does.
                if classSymbol.SymbolicReceiver != nil &&
                    argumentNames.IsDefault &&
                    !staticIsExpanded &&
                    staticMapping.IsDefault &&
                    TryBindSymbolicImportedStaticCall(
                    ce,
                    classSymbol,
                    staticFn!!,
                    arguments,
                    out var symbolicStaticCall
                ) {
                    return symbolicStaticCall!!
                }
                // Recover symbolic generic arguments before params expansion so
                // the synthesized array uses the real element type rather than
                // a live-reflection constraint placeholder.
                let staticSymbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(
                    receiverType: nil,
                    ImmutableArray.CreateRange(arguments.Select((a BoundExpression) -> a.Type))
                )
                // Issue #3712 (static calls): the same method-group refinement
                // the extension- and instance-call paths apply — a user method
                // group reaches the vector without a natural type, so its
                // same-compilation return type would otherwise be lost and the
                // call closed over `object` (`Array.ConvertAll` then reports
                // GS0155 against the real element type).
                let refinedStaticSymbolicArgs = RefineSymbolicArgsForMethodGroups(
                    staticFn!!.Method,
                    arguments,
                    staticSymbolicArgs,
                    receiverArgCount: 0,
                    isExpanded: staticIsExpanded,
                    argumentNames: if argumentNames.IsDefault {
                        default(IReadOnlyList[string?]?)
                    } else {
                        cast[IReadOnlyList[string?]](argumentNames)
                    },
                    parameterMapping: staticMapping,
                    methodGroupSlots: out var staticMethodGroupArgumentSlots
                )
                // Issue #4133 (hot-core translation guard finding): see
                // MergeMethodGroupArgumentSlots's doc.
                staticMethodGroupArgumentSlots = MergeMethodGroupArgumentSlots(
                    arguments,
                    receiverArgCount: 0,
                    refinedStaticSymbolicArgs.Length,
                    staticMethodGroupArgumentSlots
                )
                let staticSymbolicTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(
                    staticFn!!.Method,
                    typeArgSymbols,
                    refinedStaticSymbolicArgs,
                    staticIsExpanded,
                    if argumentNames.IsDefault {
                        default(IReadOnlyList[string?]?)
                    } else {
                        cast[IReadOnlyList[string?]](argumentNames)
                    },
                    staticMethodGroupArgumentSlots
                )
                let staticTypeArgSymbolsForCall = if !staticSymbolicTypeArgs.IsDefault {
                    staticSymbolicTypeArgs
                } else {
                    AsNullableElements(typeArgSymbols)
                }
                let staticParameters = staticFn!!.Method.GetParameters()
                let staticDownstreamMapping = if staticIsExpanded {
                    default(ImmutableArray[int32])
                } else {
                    staticMapping
                }
                // Issue #1325 / #1471: recover the symbolic method type-argument
                // vector before parameter conversion so a bare `default`
                // argument closed over an open type parameter (e.g.
                // `Task.FromResult[T?](default)`) materialises against the real
                // type parameter instead of the erased `object` placeholder.
                // Issue #1512: computed BEFORE the delegate rebind so a lambda
                // argument whose return is a method type parameter recovers its
                // symbolic delegate target rather than erasing to `object`.
                // Issue #1638: shared CLR call-argument-construction pipeline
                // (interpolation rebind → handler args → delegate rebind →
                // parameter conversions). Issue #889: void-izes value-returning
                // func/arrow literals passed to void-returning delegate
                // parameters (System.Action / Action<...>), mirroring the
                // instance path. Issue #506 follow-up: ensures value-type →
                // object boxing fires for fixed-arity CLR static calls (e.g.
                // `String.Format("{0}", 42)` selecting the fixed `(string,
                // object)` overload).
                let staticConvertedArgs = BuildResolvedClrCallArguments(
                    arguments,
                    ce.Arguments,
                    staticParameters,
                    staticMapping,
                    receiver: nil,
                    ce.Location,
                    ce,
                    ClrCallDelegateRebindMode.Full,
                    out var staticHandlerPrelude,
                    out _,
                    method: staticFn!!.Method,
                    receiverType: classSymbol.ConstructedReceiver ?? receiver?.Type,
                    symbolicMethodTypeArgs: staticTypeArgSymbolsForCall,
                    isExpanded: staticIsExpanded
                )
                let staticArguments = OverloadResolver.BuildOrderedCallArguments(
                    staticConvertedArgs,
                    staticDownstreamMapping,
                    staticParameters
                )
                let refKinds = ComputeArgumentRefKinds(staticParameters)
                overloads.ValidateRefArguments(staticArguments, refKinds, methodName, ce.Location)
                // Issue #3868: the narrow #1330 path above declines params-
                // expanded, defaulted and named-argument shapes, but the
                // PARENT INSTANTIATION is not optional — a static call on
                // `Verifier[X]` where `X` is a same-compilation user type must
                // still be parented at the constructed `Verifier<X>` TypeSpec.
                // Falling through with no container emitted the type-erased
                // `Verifier<object>::M(...)`, which compiles clean, fails
                // ilverify with UnsatisfiedMethodParentInst and throws
                // TypeLoadException ("GenericArguments[0], 'System.Object' …
                // violates the constraint of type parameter") the first time
                // the method runs. Arguments and the return were bound against
                // the erased closed method, which is exactly what the emitted
                // signature encodes, so carrying the symbolic container changes
                // only the parent token.
                // ADR-0056 §1 / issue #4350: ref-returning static CLR calls
                // auto-dereference like instance members and indexers.
                var staticCall = ConversionClassifier.AutoDereferenceRefReturn(
                    BoundImportedCallExpression(
                        ce,
                        staticFn!!,
                        staticArguments,
                        refKinds,
                        staticTypeArgSymbolsForCall,
                        classSymbol.SymbolicReceiver
                    )
                )
                staticCall = CompleteImportedSuspendingCall(staticCall, staticFn!!.Method, ce.Location)
                return WrapWithHandlerPrelude(staticCall, staticHandlerPrelude, ce)
            }
            if staticAmbiguous {
                // Issue #505: surface the competing candidate signatures so the
                // caller can pick a disambiguation (typically an explicit
                // type-argument list).
                Diagnostics.ReportAmbiguousOverload(
                    ce.Location,
                    methodName,
                    staticAmbiguousMethods.Length,
                    staticAmbiguousMethods.Select(ClrOverloadResolution.FormatMethodSignature)
                )
                return BoundErrorExpression(nil)
            }
            // Issue #343: a named-argument call that resolves to no candidate
            // is most actionably explained by the first unknown name (if any),
            // since the missing parameter is the prevailing cause.
            if !argumentNames.IsDefault && overloads.TryReportUnknownNamedArgumentForClr(
                classSymbol.ClassType,
                methodName,
                BindingFlags.Static | BindingFlags.Instance | BindingFlags.Public,
                ce,
                argumentNames
            ) {
                return BoundErrorExpression(nil)
            }
            // Issue #3970: a public static field or property whose type is a
            // CLR delegate (e.g. `static let Cb Func[string] = ...`) is
            // invokable through the same call syntax used on a variable —
            // `Reg.Cb()`. Static method lookup above only consulted methods
            // named `Cb`, so the delegate member would otherwise miss. This
            // is the static counterpart of the instance delegate-member
            // fallback in BindAccessorCall and must run before the nested-
            // type-constructor and "cannot find function" fallbacks below.
            if TryBindClrStaticDelegateMemberInvocation(
                classSymbol,
                methodName,
                arguments,
                ce,
                argumentNames,
                out var staticDelegateMemberCall
            ) {
                return staticDelegateMemberCall!!
            }
            // Issue #569: when no static/instance method matches, check whether
            // the call identifier names a nested type of the outer class. If so,
            // bind as a constructor invocation — this unifies the call-expression
            // path with the type-clause path that #526 already fixed.
            if TryBindNestedTypeConstructorCall(classSymbol.ClassType, ce, out var nestedCtorResult) {
                return nestedCtorResult!!
            }
            // Issue #1833: a value-type-erased type argument (a concrete
            // non-enum struct, or a bare `[T struct]` type parameter) explicitly
            // supplied to a generic BCL method whose type parameter carries an
            // `Enum` (or any other concrete) base-class constraint is now
            // rejected by `SatisfiesGenericConstraints`, so the candidate above
            // was silently dropped exactly like any other inapplicable overload.
            // Report the specific constraint violation here — before falling
            // back to the generic "cannot find function" diagnostic — so the
            // caller gets a clear bind-time error instead of only discovering
            // the problem at CLR verification.
            if explicitTypeArgs != nil &&
                TryReportGenericValueTypeBaseConstraintViolation(
                classSymbol.ClassType,
                methodName,
                explicitTypeArgs,
                typeArgSymbols,
                ce.Location
            ) {
                return BoundErrorExpression(nil)
            }
            // An argument that already failed to bind cannot participate in
            // overload resolution. Preserve its primary diagnostic instead of
            // adding a misleading "cannot find function" cascade at this call.
            //
            // Issue #4171: an UNRESOLVED bare method group (e.g. a static CLR
            // method reference passed where a delegate parameter's type
            // depends on generic inference — `Pick(items, Handler)` closing
            // `Action[Action[T]]` over an inferred `T`) is NOT a prior
            // failure. `ClrOverloadResolution.IsUnresolvedMethodGroupArgument`
            // deliberately types it `TypeSymbol.Error` as a "defer me" sentinel
            // (see that method's doc) — no diagnostic was ever reported for it.
            // When resolution reaches here with no candidate accepting the
            // call (e.g. because the group's own parameter type does not
            // actually satisfy the delegate slot after the type argument is
            // correctly inferred — the doubly-nested contravariant case naive
            // resolution cannot determine a concrete answer for), the OLD
            // unconditional bailout silently swallowed the failure: the call
            // returned an error expression with NO diagnostic ever reported,
            // so the caller's declared type became the bare `TypeSymbol.Error`
            // sentinel unnoticed, and it later reached the emitter, which
            // crashed with an internal GS9998 trying to encode a signature for
            // it. Only treat a REAL prior failure (any other Error-typed
            // argument) as already-diagnosed; an unresolved method group must
            // still fall through to the "cannot find function" diagnostic
            // below so the failure is reported once, cleanly, here.
            if arguments.Any(
                (argument BoundExpression) -> argument.Type == TypeSymbol.Error &&
                    !ClrOverloadResolution.IsUnresolvedMethodGroupArgument(argument)
            ) {
                return BoundErrorExpression(ce)
            }
            if TryReportValueNullableByRefArgument(ce, arguments, classSymbol.ClassType, methodName) {
                return BoundErrorExpression(nil)
            }
            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName)
            return BoundErrorExpression(nil)
        }
        // Issue #1320: normalize a sequence[T]/asyncsequence[T] or user-element
        // array receiver (whose ClrType is null during binding) to its erased
        // CLR shape so the shared CLR-instance member-lookup path below resolves
        // its enumerable surface (GetEnumerator, ...) uniformly with an
        // explicitly-typed IEnumerable[T] parameter and a primitive-element
        // receiver. The bound call keeps the original receiver expression.
        var effectiveReceiverType = receiver?.Type
        if receiver?.Type != nil &&
            TryNormalizeSymbolicEnumerableReceiver(receiver!!.Type, out var normalizedReceiverType) {
            effectiveReceiverType = normalizedReceiverType
        }
        if receiver == nil || effectiveReceiverType?.ClrType == nil {
            // ADR-0059 / issue #255: a value of a user-declared named delegate
            // type supports member-style invocation `del.Invoke(args)` (same as
            // any CLR delegate). Lower to a BoundIndirectCallExpression whose
            // function shape mirrors the delegate's declared signature; the
            // emitter recognises a DelegateTypeSymbol target and dispatches
            // through the delegate's runtime-implemented Invoke MethodDef.
            if receiver != nil && receiver.Type is DelegateTypeSymbol delRecv && string.Equals(
                methodName,
                "Invoke",
                StringComparison.Ordinal
            ) {
                return BindNamedDelegateInvokeCall(receiver, delRecv, arguments, ce)
            }
            // Phase 3.B.4: dispatch to a user-defined interface method when
            // the static receiver type is an interface.
            if receiver != nil && receiver.Type is InterfaceSymbol ifaceRecv {
                var ifaceOverloads = TypeMemberModel.GetMethods(
                    ifaceRecv,
                    methodName,
                    MemberQuery.Instance(MemberKinds.Method)
                )
                // ADR-0090 / issue #756: private interface helpers are visible
                // ONLY when the call is made from inside another member of the
                // same interface declaration. Both instance and static
                // members of the same interface qualify (a private static
                // helper can be called from a static-virtual default body on
                // the same interface, etc.). When the current function's
                // ReceiverType / StaticOwnerType points at the same
                // InterfaceSymbol — including the generic-definition or any
                // constructed instance — widen the candidate set with the
                // private overloads.
                let owningIfaceDef = ifaceRecv.Definition ?? ifaceRecv
                if IsInsideSameInterface(owningIfaceDef) {
                    let privateOverloads = ifaceRecv.GetPrivateMethods(methodName)
                    if privateOverloads.Length > 0 {
                        ifaceOverloads = ifaceOverloads.AddRange(privateOverloads)
                    }
                } else if ifaceOverloads.Length == 0 {
                    // Probe the private bucket so we can give a precise
                    // visibility diagnostic instead of the generic "method
                    // not found" channel.
                    let probePriv = ifaceRecv.GetPrivateMethods(methodName)
                    if probePriv.Length > 0 {
                        Diagnostics.ReportPrivateInterfaceMemberNotAccessible(
                            ce.Location,
                            owningIfaceDef.Name,
                            methodName
                        )
                        return BoundErrorExpression(nil)
                    }
                }
                if ifaceOverloads.Length > 0 {
                    let ifaceMethod FunctionSymbol? = overloads.SelectInstanceOverloadOrReport(
                        ifaceOverloads,
                        arguments,
                        ce,
                        methodName,
                        argumentNames
                    )
                    if ifaceMethod == nil {
                        return BoundErrorExpression(nil)
                    }
                    return overloads.BindUserInstanceCall(receiver, ifaceMethod, arguments, ce, argumentNames)
                }
            }
            // Issue #1052 (was Phase 4.2b / ADR-0020 sealed-only): dispatch
            // through a type parameter's user-declared interface constraint,
            // just as if the receiver were typed as the interface itself. The
            // constrained type parameter is threaded into the bound call so the
            // emitter produces a verifiable `constrained. !!T  callvirt` sequence
            // rather than a bare `callvirt` on the unboxed value.
            if receiver != nil && receiver.Type is TypeParameterSymbol tpRecv && tpRecv.InterfaceConstraint != nil {
                let tpOverloads = MemberLookup.CollectSourceInstanceMethods(tpRecv, methodName)
                if tpOverloads.Length > 0 {
                    let tpIfaceMethod FunctionSymbol? = overloads.SelectInstanceOverloadOrReport(
                        tpOverloads,
                        arguments,
                        ce,
                        methodName,
                        argumentNames
                    )
                    if tpIfaceMethod == nil {
                        return BoundErrorExpression(nil)
                    }
                    return overloads.BindUserInstanceCall(
                        receiver,
                        tpIfaceMethod,
                        arguments,
                        ce,
                        argumentNames,
                        constrainedReceiverTypeParameter: tpRecv
                    )
                }
            }
            // Issue #1056: dispatch through a type parameter's base-class
            // constraint, just as if the receiver were typed as the base class
            // itself (e.g. `x.Speak()` where `x : T` and `T : Animal`). The
            // constrained type parameter is threaded into the bound call so the
            // emitter produces a verifiable `constrained. !!T  callvirt
            // Animal::Speak()` sequence. The `constrained.` prefix is required
            // even though `T` is a reference type: a bare `callvirt` on the
            // unboxed `!!T` value is rejected by the verifier (StackUnexpected),
            // because the static stack type is `!!T`, not the base class. Unlike
            // the interface paths the method token is the class's own MethodDef
            // (resolved by EmitUserInstanceCall when the constraint type is not
            // an interface), so no interface MemberRef is produced.
            if receiver != nil && receiver.Type is TypeParameterSymbol tpClassRecv {
                let tpClassConstraint StructSymbol? = tpClassRecv.ClassConstraint as StructSymbol
                if tpClassConstraint != nil {
                    let tpClassOverloads = MemberLookup.CollectSourceInstanceMethods(tpClassRecv, methodName)
                    if tpClassOverloads.Length > 0 {
                        let tpClassMethod FunctionSymbol? = overloads.SelectInstanceOverloadOrReport(
                            tpClassOverloads,
                            arguments,
                            ce,
                            methodName,
                            argumentNames,
                            receiver.Type
                        )
                        if tpClassMethod == nil {
                            return BoundErrorExpression(nil)
                        }
                        return overloads.BindUserInstanceCall(
                            receiver,
                            tpClassMethod,
                            arguments,
                            ce,
                            argumentNames,
                            constrainedReceiverTypeParameter: tpClassRecv
                        )
                    }
                }
            }
            // Issue #943 / #3394: dispatch through a type parameter's imported
            // CLR interface or base-class constraint. Both shapes require a
            // constrained call because the receiver's stack type remains !!T.
            if receiver != nil &&
                receiver.Type is TypeParameterSymbol tpClrRecv &&
                (tpClrRecv.ClrInterfaceConstraint != nil || tpClrRecv.ClassConstraint?.ClrType != nil) &&
                TryBindConstrainedClrCall(
                receiver,
                tpClrRecv,
                methodName,
                arguments,
                ce,
                argumentNames,
                out var constrainedCall
            ) {
                return constrainedCall!!
            }
            // Phase 3.B.3 sub-step 2b: dispatch to a user-defined class method
            // if receiver is a user struct symbol.
            if receiver != nil && receiver.Type is StructSymbol userClass {
                let userOverloads = MemberLookup.CollectSourceInstanceMethods(userClass, methodName)
                if userOverloads.Length > 0 {
                    let userMethod FunctionSymbol? = overloads.SelectInstanceOverloadOrReport(
                        userOverloads,
                        arguments,
                        ce,
                        methodName,
                        argumentNames,
                        receiver.Type
                    )
                    if userMethod == nil {
                        return BoundErrorExpression(nil)
                    }
                    return overloads.BindUserInstanceCall(receiver, userMethod, arguments, ce, argumentNames)
                }
                // ADR-0085 / issue #726: a class that does not override an
                // inherited default interface method can still be called by
                // the unqualified method name on a class-typed receiver. The
                // binder routes the call to the interface's default method;
                // the evaluator and emitter both rely on virtual dispatch
                // through the interface slot to land on any subsequent
                // override.
                let defaultIfaceMethod FunctionSymbol? = TryFindDefaultInterfaceMethod(
                    userClass,
                    methodName,
                    arguments,
                    ce,
                    argumentNames
                )
                if defaultIfaceMethod != nil {
                    return overloads.BindUserInstanceCall(receiver, defaultIfaceMethod, arguments, ce, argumentNames)
                }
            }
            // Issues #527, #2925, and #3523: source struct/class and interface
            // callable members are invokable before their CLR types exist.
            if receiver != nil &&
                (receiver.Type is StructSymbol or InterfaceSymbol) &&
                TryBindUserCallableMemberInvocation(
                receiver,
                receiver.Type,
                methodName,
                arguments,
                ce,
                isStatic: false,
                out var userDelegateFieldCall
            ) {
                return userDelegateFieldCall!!
            }
            // Phase 3.B.6 / ADR-0019: extension function fallback for
            // user-type receivers (struct/class/interface). Issue #1188:
            // extension functions overload, so select the best matching
            // overload across all (receiver, name) candidates.
            if TryBindExtensionFunctionOverload(
                receiver,
                methodName,
                arguments,
                ce,
                argumentNames,
                out var userExtResult
            ) {
                return userExtResult!!
            }
            // Issue #296: a GSharp class inheriting an imported CLR base class
            // exposes the base's instance members. After user-defined and
            // extension lookups fail, resolve the call against the imported
            // base CLR type so inherited members are callable on the derived
            // GSharp instance. Inherited instance members take precedence over
            // imported extension methods.
            // Issue #1136: when the user class/struct declares no explicit
            // imported base, every .NET type still inherits System.Object's
            // instance members (GetType/ToString/GetHashCode/Equals). Fall back
            // to typeof(object) so those resolve. TryBindInheritedClrInstanceCall
            // returns false for any name Object does not define, so unknown
            // methods still report GS0159 below.
            // Issue #2210: use the transitive walk (issue #1582) rather than
            // only `inheritedDerived`'s own ImportedBaseType, so a metadata
            // base reached through one or more intermediate G#-defined base
            // classes (`class C : B` where `B : SomeImportedBase`) still
            // surfaces its inherited methods, matching how field/property
            // access already walks the chain.
            // Issue #2218 follow-up: only surface `protected`/`protected
            // internal` inherited members when `receiver` IS the current
            // implicit/explicit `this` — this path (BindAccessorCall) also
            // handles an arbitrary qualified `receiver.Method(...)` call, so
            // without this check protected inherited members would be
            // callable through any receiver expression, leaking accessibility.
            let allowProtectedInherited = IsCurrentThisReceiver(receiver)
            let inheritedDerived StructSymbol? = receiver?.Type as StructSymbol
            if inheritedDerived != nil {
                let inheritedBaseClr = GetInheritedClrBaseType(inheritedDerived) ?? typeof(object)
                if TryBindInheritedClrInstanceCall(
                    receiver!!,
                    inheritedBaseClr,
                    methodName,
                    arguments,
                    ce,
                    out var inheritedCall,
                    explicitTypeArgs,
                    typeArgSymbols,
                    argumentNames,
                    allowProtectedInherited: allowProtectedInherited
                ) {
                    return inheritedCall!!
                }
            }
            // Issue #1218: an enum value is a CLR value type whose base chain is
            // System.Enum -> System.ValueType -> System.Object. Its inherited
            // instance members (Enum.HasFlag, Object/ValueType ToString /
            // GetHashCode / Equals, Object.GetType) are callable on enum values.
            // Resolve against typeof(System.Enum); SafeGetMethods walks the base
            // types so all inherited members are found, and the helper returns
            // false for any name Enum/Object does not define (still GS0159).
            // Enum members are all public, so protected admission stays off here.
            if receiver != nil &&
                receiver.Type is EnumSymbol &&
                TryBindInheritedClrInstanceCall(
                receiver,
                typeof(Enum),
                methodName,
                arguments,
                ce,
                out var enumInheritedCall,
                explicitTypeArgs,
                typeArgSymbols,
                argumentNames,
                mapEnumArgumentsToBaseClr: true
            ) {
                return enumInheritedCall!!
            }
            // Issue #294: imported [Extension] method dispatched with instance
            // (receiver) syntax, when the receiver carries a CLR type even
            // though its symbol is a user/interface shape.
            if receiver != nil &&
                TryBindImportedExtensionCall(
                receiver,
                methodName,
                arguments,
                ce,
                out var userPathExt,
                explicitTypeArgs,
                typeArgSymbols,
                argumentNames
            ) {
                return userPathExt!!
            }
            // Issue #1181: a user interface that extends an imported/BCL
            // interface (e.g. `interface IBox : IDisposable`) inherits that
            // interface's members. After user-declared interface members and
            // extension lookups fail, resolve the call against the transitive
            // imported base interfaces so `b.Dispose()` (b : IBox) binds and
            // emits a verifiable `callvirt IDisposable::Dispose`.
            if receiver != nil &&
                receiver.Type is InterfaceSymbol importedBaseIfaceRecv &&
                TryBindInterfaceImportedBaseInstanceCall(
                receiver,
                importedBaseIfaceRecv,
                methodName,
                arguments,
                ce,
                out var importedBaseIfaceCall,
                explicitTypeArgs,
                typeArgSymbols,
                argumentNames
            ) {
                return importedBaseIfaceCall!!
            }
            // Issue #1550: a value of ANY type parameter is ultimately a
            // System.Object, so the universal object instance members
            // (ToString, GetHashCode, Equals(object), GetType) are callable on
            // any type-parameter receiver even when no constraint supplies them.
            // Runs AFTER the constraint-dispatch paths above (#1052 / #1056 /
            // #943) so a constraint that redeclares one of these names still
            // wins there. Emitted as a verifiable
            // `constrained. !!T  callvirt System.Object::Method(...)` sequence,
            // which dispatches to any override for value, struct/enum and
            // reference type parameters alike without a manual box.
            if receiver != nil &&
                receiver.Type is TypeParameterSymbol tpObjRecv &&
                TryBindConstrainedObjectMemberCall(
                receiver,
                tpObjRecv,
                methodName,
                arguments,
                ce,
                argumentNames,
                out var constrainedObjectCall
            ) {
                return constrainedObjectCall!!
            }
            // Issue #2304: a source-declared interface (`InterfaceSymbol`,
            // ClrType still null at bind time) implicitly derives from
            // `System.Object` for member-access purposes, exactly like the
            // type-parameter fallback just above. Run AFTER every
            // user/imported-interface member and extension lookup so a
            // same-named interface/extension member still wins.
            if receiver != nil &&
                receiver.Type is InterfaceSymbol &&
                TryBindInterfaceObjectMemberCall(
                receiver,
                methodName,
                arguments,
                ce,
                argumentNames,
                out var ifaceObjectCall
            ) {
                return ifaceObjectCall!!
            }
            let effectiveReceiverSyntax SyntaxNode? = receiverSyntax ?? receiver?.Syntax
            if receiver?.Type is NullableTypeSymbol nullableRecvType &&
                IsApplicableNullableUnderlyingCall(
                receiver!!,
                nullableRecvType.UnderlyingType,
                methodName,
                arguments,
                ce,
                argumentNames,
                explicitTypeArgs,
                typeArgSymbols
            ) &&
                effectiveReceiverSyntax != nil {
                Diagnostics.ReportNilableReceiverCall(
                    ce.Location,
                    methodName,
                    DescribeCallReceiver(receiver!!, effectiveReceiverSyntax, receiverStart)
                )
            } else if !TryReportValueNullableByRefArgument(ce, arguments, receiver?.Type?.ClrType, methodName) {
                Diagnostics.ReportUnableToFindFunction(ce.Location, methodName)
            }
            return BoundErrorExpression(nil)
        }
        // The block above returns unconditionally whenever receiver is null
        // (or its CLR type is unavailable), so every remaining statement in
        // this method observes a non-null receiver. Re-bind the parameter so
        // that fact — otherwise lost across the switch below — stays visible
        // to the compiler for the rest of the method instead of re-arguing it
        // at each call site.
        receiver = Invariant.Required(
            receiver,
            "the preceding `receiver == null` branch returns unconditionally",
            expression: "receiver"
        )
        // Prefer a user-defined class method when the receiver is a user
        // class symbol that has one with this name. (BCL lookup is the
        // fallback for imported CLR types.)
        if receiver.Type is StructSymbol userClassPriority {
            let priorityOverloads = MemberLookup.CollectSourceInstanceMethods(userClassPriority, methodName)
            if priorityOverloads.Length > 0 {
                let userMethodPriority FunctionSymbol? = overloads.SelectInstanceOverloadOrReport(
                    priorityOverloads,
                    arguments,
                    ce,
                    methodName,
                    argumentNames,
                    receiver.Type
                )
                if userMethodPriority == nil {
                    return BoundErrorExpression(nil)
                }
                return overloads.BindUserInstanceCall(receiver, userMethodPriority, arguments, ce, argumentNames)
            }
            // ADR-0085 / issue #726: default-interface-method fallback —
            // same as the primary branch above.
            let defaultIfaceMethodPriority FunctionSymbol? = TryFindDefaultInterfaceMethod(
                userClassPriority,
                methodName,
                arguments,
                ce,
                argumentNames
            )
            if defaultIfaceMethodPriority != nil {
                return overloads.BindUserInstanceCall(
                    receiver,
                    defaultIfaceMethodPriority,
                    arguments,
                    ce,
                    argumentNames
                )
            }
        }
        // Issues #527, #2925, and #3523: a G#-defined struct/class or interface
        // callable member is invokable through bare call syntax.
        if (receiver.Type is StructSymbol or InterfaceSymbol) &&
            TryBindUserCallableMemberInvocation(
            receiver,
            receiver.Type,
            methodName,
            arguments,
            ce,
            isStatic: false,
            out var userDelegateCall
        ) {
            return userDelegateCall!!
        }
        // Issue #517: a value-type `T?` lowers to `System.Nullable<T>` at the
        // CLR layer; `receiver.Type.ClrType` returns the underlying T's CLR
        // type (so the binder can share lifting/conversion logic), but
        // instance-method lookup (e.g. `GetValueOrDefault`, `Equals`,
        // `ToString`) must go through the constructed `Nullable<T>` type that
        // actually carries those members.
        // Issue #4924: the members of the target framework's declaration, not the host's.
        // `effectiveReceiverType.ClrType` is non-null here: the `ClrType == nil` branch
        // above returns unconditionally.
        let receiverClrType = effectiveReceiverType!!.ClrType!!
        if !$scope.References!!.TryGetMemberLookupType(receiverClrType, out var lookupType) {
            Diagnostics.ReportTargetFrameworkMemberUnavailable(
                ce.Location,
                (receiverClrType.FullName ?? receiverClrType.Name) + "." + methodName
            )
            return BoundErrorExpression(nil)
        }
        var clrType Type? = lookupType
        if receiver.Type is NullableTypeSymbol nullableRecv {
            let nullableInnerVt = nullableRecv.UnderlyingType?.ClrType
            if nullableInnerVt?.IsValueType == true && this.memberLookup.TryGetNullableConstructedType(
                nullableInnerVt!!,
                out var nullableConstructed
            ) {
                clrType = nullableConstructed!!
            }
        }
        // Issue #529: use interface-aware method enumeration so that
        // methods declared on a base interface (e.g.
        // IEnumerable<T>.GetEnumerator() surfaced through
        // IReadOnlyList<T>) are found.
        let instSymbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(
            receiverType: nil,
            ImmutableArray.CreateRange(arguments.Select((a BoundExpression) -> a.Type))
        )
        // Issue #3679: an `internal` instance method of a referenced assembly
        // that named this compilation in an `InternalsVisibleTo` is a legal
        // candidate — the msbuild `<InternalsVisibleTo>` item the SDK turns
        // into that attribute is how every migrated test app reaches the
        // internals of the project under test.
        let receiverGrantsInternals = $scope.References!!.CanAccessInternalMembers(clrType!!.Assembly)
        // Issue #4013: an author-written call no longer reaches an
        // explicitly-implemented interface member; a synthesized
        // collection-initializer `Add` still does, because ADR-0117 literals
        // and the #3096 spread form fill a `Dictionary[K, V]` through the
        // explicit `ICollection<KeyValuePair<K, V>>.Add` and lower the call
        // through the interface.
        let isSynthesizedCollectionAdd = IsSynthesizedCollectionAddCall(ce)
        // Issue #4013: an explicitly-implemented interface member is offered
        // only where the compiler still depends on it — never for an argument
        // that has a CLR identity of its own and simply does not fit, which is
        // the hole this issue closes.
        //
        // Two dependencies, both measured. (1) A synthesized
        // collection-initializer `Add`: ADR-0117 literals and the #3096 spread
        // form fill a `Dictionary[K, V]` through the explicit
        // `ICollection<KeyValuePair<K, V>>.Add` and lower the call through the
        // interface. (2) An argument carrying a SAME-COMPILATION type, where
        // `IList.Add(object)` is an erasure escape hatch: in
        // `List[System.Action[Mode]].Add((item Mode) -> ...)` for a
        // same-compilation enum `Mode`
        // (`Issue2918InlineLambdaErasedReceiverTests`) the receiver is built
        // over the flat `System.Object` placeholder and presents as
        // `List<Action<object>>`, while the lambda erases the enum to `int` and
        // presents as `Action<int>` — so the type's own `Add(Action<object>)`
        // is inapplicable and only `Add(object)` ever accepted it. That is
        // #4016's defect at the generic-CONSTRUCTION placeholder rather than at
        // the method-type-argument one, and repairing it there is deliberately
        // out of scope here.
        //
        // The reported hole is closed because its argument is a genuine
        // `string` at a genuine `int32`: `List[int32]().Add("x")` reports
        // GS0159 and `map[string, int32]{}.Contains(k)` reports GS0577. What
        // these two exemptions still let through — the literal and
        // same-compilation-argument forms — is #4028, closed at APPLICABILITY
        // just below rather than by narrowing the exemptions here.
        let anyArgumentIsErased = arguments.Any(
            (argument BoundExpression) -> argument.Type != nil && TypeSymbol.ContainsSameCompilationUserType(
                argument.Type
            )
        )
        // Issue #4028: both exemptions above are collection-time and cannot see
        // the arguments, so they also re-admitted the widening
        // `IList.Add(object)` / `IDictionary.Add(object, object)` for a call
        // that has no erasure to repair — `List[int32]{"x"}` and
        // `map[string, int32]{"a": "x"}` compiled and threw. The discrimination
        // is made here instead, on the collected list, where the receiver's and
        // the arguments' real symbolic types are both in hand; see
        // `MemberLookup.ExcludeUnreachableNonGenericInterfaceCandidates` for
        // what keeps the member and why. The memoized collection above is
        // untouched, and a call that admitted no such member pays one loop over
        // its own candidates.
        //
        // Issue #4036 (review finding): this filter and the repair below both
        // compare SOURCE-order arguments against DECLARATION-order parameters,
        // so both are handed the argument names to reconcile the two. Without
        // them `Add(value: someCelsius, key: "a")` asked whether a `Celsius`
        // fits `key: string`, concluded the receiver's own `Add` could not take
        // the call, removed the widening member, and reported GS0159 for a
        // valid call.
        let candidates = MemberLookup.ExcludeUnreachableNonGenericInterfaceCandidates(
            MemberLookup.ExcludeErasureOnlyEnumCandidates(
                MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
                    clrType,
                    methodName,
                    includeInternal: receiverGrantsInternals,
                    includeExplicitInterfaceMembers: isSynthesizedCollectionAdd || anyArgumentIsErased
                ),
                instSymbolicArgs,
                if argumentNames.IsDefault {
                    default(IReadOnlyList[string]?)
                } else {
                    cast[IReadOnlyList[string]](argumentNames)
                },
                effectiveReceiverType
            )
                .ToList(),
            clrType,
            effectiveReceiverType,
            arguments.Select((argument BoundExpression) -> argument.Type).ToList(),
            if argumentNames.IsDefault {
                default(IReadOnlyList[string?]?)
            } else {
                cast[IReadOnlyList[string?]](argumentNames)
            }
        )
            .ToList()
        // Issue #4036: the filter above decided WHICH candidates survive. This
        // decides what happens to the argument once one does. When the widening
        // member was kept because the receiver's own surface would have taken
        // the call through a user-defined implicit conversion, the conversion
        // was never actually APPLIED: the erased argument still presented as
        // `object`, which is an identity match for `IList.Add(object)` and no
        // match for `Add(double)`, so the widening member won and
        // `List[float64]().Add(someCelsius)` threw at run time — while
        // `List[float64](){ ...someCelsiusSlice }` printed the value, because
        // the spread lowering converts the item to the collection's element
        // type BEFORE binding `Add`. Apply the conversion here so the ordinary
        // call agrees with the spread form. The widening member is still
        // collected and still applicable — #4028 keeps it here on purpose — it
        // simply stops winning, because a real `double` beats a boxed one.
        let conversionRepairTargets = MemberLookup.FindUserDefinedConversionRepairTargets(
            candidates,
            clrType,
            effectiveReceiverType,
            arguments.Select((argument BoundExpression) -> argument.Type).ToList(),
            if argumentNames.IsDefault {
                default(IReadOnlyList[string?]?)
            } else {
                cast[IReadOnlyList[string?]](argumentNames)
            }
        )
        if !conversionRepairTargets.IsDefault {
            let repaired = arguments.ToBuilder()
            for var i = 0; i < repaired.Count && i < conversionRepairTargets.Length; i++ {
                if conversionRepairTargets[i] is not TypeSymbol repairTarget {
                    continue
                }
                repaired[i] = conversions.BindConversion(
                    repaired[i].Syntax?.Location ?? ce.Location,
                    repaired[i],
                    repairTarget
                )
            }
            arguments = repaired.ToImmutable()
        }
        if candidates.Count > 0 {
            let argTypes = [arguments.Length]Type?
            var argsAllTyped = true
            var hasUserClassArg = false
            for var i = 0; i < arguments.Length; i++ {
                if (arguments[i].Type is TupleTypeSymbol || ContainsNestedNullType(arguments[i].Type)) &&
                    TryProjectArgumentClrTypeFromSymbolicReceiver(
                    candidates,
                    i,
                    ce,
                    effectiveReceiverType!!,
                    arguments[i].Type,
                    out var receiverProjectedArgumentType
                ) {
                    argTypes[i] = receiverProjectedArgumentType
                    continue
                }
                // Issue #977: an inline `out var`/`out let`/`out _` argument was
                // bound to a placeholder address-of (Error pointee) in the eager
                // pass because the parameter type was unknown. Feed a sentinel so
                // overload resolution treats it as matching any by-ref parameter;
                // the local's type is inferred from the chosen overload below.
                if TryGetInlineOutVarArgument(ce, i, out _) {
                    argTypes[i] = ClrOverloadResolution.InlineOutVarArgumentType
                    continue
                }
                // Issue #530: use GetEffectiveArgumentClrType so that a
                // nullable value type argument (e.g. `int32?`) is matched
                // as `Nullable<T>` in overload resolution.
                // Issue #533: allow null (nil literal) through.
                // Issue #658: use overload-resolution variant for user classes.
                let t Type? = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type)
                if t == nil && arguments[i].Type != TypeSymbol.Null {
                    // Issue #2347: a bare method group (e.g. a static BCL
                    // method or another CLR method reference) passed to a
                    // generic static/instance method has no fixed CLR type
                    // until the target delegate parameter is known. Defer it
                    // like an untyped lambda — leave the argTypes slot null
                    // so applicability/generic inference proceed using the
                    // other arguments — instead of aborting the whole
                    // candidate set; it is resolved against the winning
                    // overload's parameter type afterwards by
                    // BindClrParameterConversions.
                    if !ClrOverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]) {
                        argsAllTyped = false
                        break
                    }
                }
                if (arguments[i].Type is StructSymbol and {IsClass: true}) {
                    hasUserClassArg = true
                }
                argTypes[i] = t
            }
            if argsAllTyped {
                let CheckUserClassInterface = func (source Type, target Type) bool {
                    return IsUserClassAssignableToInterfaceFromArgs(arguments, argTypes, source, target)
                }
                // Issue #658 / #1634: supplementary interface check for user-class
                // args, threaded as a call-local parameter into Resolve instead of
                // a shared static so nested/concurrent binds can't clobber it.
                var supplementaryInterfaceCheck((Type, Type) -> bool)? = nil
                if hasUserClassArg {
                    supplementaryInterfaceCheck = CheckUserClassInterface
                }
                let preResolutionSymbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(
                    nil,
                    ImmutableArray.CreateRange(arguments.Select((a BoundExpression) -> a.Type))
                )
                let recoverTypeArgSymbols(MethodInfo, bool) -> ImmutableArray[TypeSymbol?] = (
                    closed MethodInfo,
                    isExpanded bool
                ) -> {
                    let refinedArgs = RefineSymbolicArgsForMethodGroups(
                        closed,
                        arguments,
                        preResolutionSymbolicArgs,
                        receiverArgCount: 0,
                        isExpanded: isExpanded,
                        argumentNames: if argumentNames.IsDefault {
                            default(IReadOnlyList[string?]?)
                        } else {
                            cast[IReadOnlyList[string?]](argumentNames)
                        },
                        parameterMapping: default(ImmutableArray[int32]),
                        methodGroupSlots: out var recoverInstMethodGroupSlots
                    )
                    // Issue #4133 (hot-core translation guard finding): see
                    // MergeMethodGroupArgumentSlots's doc.
                    recoverInstMethodGroupSlots = MergeMethodGroupArgumentSlots(
                        arguments,
                        receiverArgCount: 0,
                        refinedArgs.Length,
                        recoverInstMethodGroupSlots
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
                        recoverInstMethodGroupSlots
                    )
                }
                var resolution = ClrOverloadResolution.Resolve(
                    candidates,
                    argTypes,
                    explicitTypeArgs,
                    $scope.References!!.MapClrTypeToReferences,
                    ComputeInterpolatedStringArgFlags(ce.Arguments, arguments.Length),
                    if argumentNames.IsDefault {
                        default(IReadOnlyList[string]?)
                    } else {
                        cast[IReadOnlyList[string]](argumentNames)
                    },
                    recoverTypeArgSymbols: recoverTypeArgSymbols,
                    supplementaryInterfaceCheck: supplementaryInterfaceCheck,
                    constantNarrowingArgumentCheck: MakeConstantNarrowingArgumentCheck(arguments),
                    structuralProjectionArgumentCheck: MakeStructuralProjectionArgumentCheck(
                        arguments,
                        nativeConversions: conversions
                    ),
                    erasedArgumentMismatchCheck: MakeErasedArgumentMismatchCheck(arguments),
                    delegateArgumentCheck: MakeDelegateArgumentCheck(arguments),
                    methodGroupInference: MakeMethodGroupInference(
                        arguments,
                        GetEffectiveArgumentClrTypeForOverloadResolution
                    ),
                    methodGroupArgumentCheck: MakeMethodGroupArgumentCheck(arguments),
                    explicitTypeArgIsGenuine: ClrOverloadResolution.BuildGenuineExplicitTypeArgFlags(typeArgSymbols),
                    explicitTypeArgumentMismatchCheck: MakeExplicitTypeArgumentMismatchCheck(arguments, typeArgSymbols),
                    symbolicArgTypes: preResolutionSymbolicArgs,
                    symbolicArgumentConversionClassifier: MakeSymbolicArgumentConversionClassifier(
                        arguments,
                        nativeConversions: conversions
                    )
                )
                // Issue #3745: a user-declared class argument erases to
                // `System.Object`, which gives an imported generic method no
                // evidence for a type parameter that occurs solely inside an
                // interface-typed parameter (`DecodeSignature<TType,
                // TGenericContext>(ISignatureTypeProvider<TType,
                // TGenericContext>, TGenericContext)`), so inference fails and
                // the call reports GS0159. Retry ONCE with each such argument
                // projected onto the imported interface it implements. The
                // retry is on the failure path only, and the original vector is
                // restored when it does not resolve, because the `object`
                // ride-through is itself load-bearing for erased type-parameter
                // parameters (#2840).
                if resolution.Outcome != ClrOverloadResolution.ResolutionOutcome.Resolved && hasUserClassArg {
                    let erasedArgTypes = cast[[]Type?](argTypes.Clone())
                    if TryProjectUserClassArgumentInterfaces(arguments, argTypes) {
                        let projectedResolution = ClrOverloadResolution.Resolve(
                            candidates,
                            argTypes,
                            explicitTypeArgs,
                            $scope.References!!.MapClrTypeToReferences,
                            ComputeInterpolatedStringArgFlags(ce.Arguments, arguments.Length),
                            if argumentNames.IsDefault {
                                default(IReadOnlyList[string]?)
                            } else {
                                cast[IReadOnlyList[string]](argumentNames)
                            },
                            recoverTypeArgSymbols: recoverTypeArgSymbols,
                            supplementaryInterfaceCheck: supplementaryInterfaceCheck,
                            constantNarrowingArgumentCheck: MakeConstantNarrowingArgumentCheck(arguments),
                            structuralProjectionArgumentCheck: MakeStructuralProjectionArgumentCheck(
                                arguments,
                                nativeConversions: conversions
                            ),
                            erasedArgumentMismatchCheck: MakeErasedArgumentMismatchCheck(arguments),
                            delegateArgumentCheck: MakeDelegateArgumentCheck(arguments),
                            methodGroupInference: MakeMethodGroupInference(
                                arguments,
                                GetEffectiveArgumentClrTypeForOverloadResolution
                            ),
                            methodGroupArgumentCheck: MakeMethodGroupArgumentCheck(arguments),
                            explicitTypeArgIsGenuine: ClrOverloadResolution.BuildGenuineExplicitTypeArgFlags(
                                typeArgSymbols
                            ),
                            explicitTypeArgumentMismatchCheck: MakeExplicitTypeArgumentMismatchCheck(
                                arguments,
                                typeArgSymbols
                            ),
                            symbolicArgTypes: preResolutionSymbolicArgs,
                            symbolicArgumentConversionClassifier: MakeSymbolicArgumentConversionClassifier(
                                arguments,
                                nativeConversions: conversions
                            )
                        )
                        if projectedResolution.Outcome == ClrOverloadResolution.ResolutionOutcome.Resolved {
                            resolution = projectedResolution
                        } else {
                            Array.Copy(erasedArgTypes, argTypes, argTypes.Length)
                        }
                    }
                }
                switch resolution.Outcome {
                    case ClrOverloadResolution.ResolutionOutcome.Resolved {
                        // Outcome.Resolved guarantees a non-null Best (see the
                        // Result<T> factory methods in ClrOverloadResolution).
                        if resolution.Best is not{} method {
                            break
                        }
                        // Issue #2193: a CLR/imported instance method that shares a
                        // name with a user extension function must not automatically
                        // win overload resolution when it is only applicable through
                        // a lossy delegate-reshaping conversion (e.g. a G# function
                        // value `(T) -> TResult` discarding its result to satisfy a
                        // named void delegate parameter like
                        // `SynchronizationContext.Send(SendOrPostCallback, object)`)
                        // while an in-scope user extension is a strictly better
                        // (identity/standard) match. Merge the user-extension
                        // candidate set into the decision and prefer the extension
                        // when it is strictly better; instance methods that are a
                        // good (non-reshaping) match still win unconditionally.
                        if receiver != nil &&
                            TryPreferBetterExtensionOverClrInstanceMethod(
                            receiver,
                            methodName,
                            method,
                            argTypes,
                            arguments,
                            ce,
                            argumentNames,
                            out var betterExtensionCall
                        ) {
                            return betterExtensionCall!!
                        }
                        // Issue #4287: an instance method on a stated `T?`
                        // receiver needs a guard first (see
                        // TryReportStatedNullableReceiverCall).
                        if receiver != nil &&
                            TryReportStatedNullableReceiverCall(receiver, receiverSyntax, receiverStart, ce) {
                            return BoundErrorExpression(nil)
                        }
                        // Issue #977: now that the overload is chosen, re-bind
                        // any inline `out var`/`out let`/`out _` placeholders
                        // against the resolved by-ref parameter so the new
                        // local is declared with the inferred pointee type.
                        // Issue #3311: pass the NORMALIZED receiver type so an
                        // open map's `out TValue` (e.g. TryGetValue) recovers
                        // the symbolic V via the Dictionary view's symbolic
                        // arguments, exactly as an explicit Dictionary[K, V]
                        // receiver does (#1107).
                        arguments = RebindInlineOutVarArguments(
                            ce,
                            arguments,
                            method,
                            resolution.ParameterMapping,
                            effectiveReceiverType,
                            typeArgSymbols
                        )
                        // Issue #1512: for a genuine INSTANCE method the receiver
                        // is `this`, not a formal parameter — `GetParameters()`
                        // excludes it. The method-type-argument inference vector
                        // must therefore align with the method's parameters and
                        // must NOT carry the receiver as slot 0 (unlike the
                        // extension-method path, where the receiver IS param 0).
                        // Including it shifted every real argument by one slot, so
                        // a method type parameter inferable only from a lambda
                        // argument (e.g. `TResult` of
                        // `Task.ContinueWith<TResult>(Func<Task,TResult>)`) was
                        // never unified and the call collapsed to `<object>`. The
                        // receiver still drives return-type Var substitution via
                        // `ResolveCallReturnTypeFromSymbolicTypeArgs` below.
                        // Issue #3712 (instance calls): a user method group has
                        // no natural type until the target delegate is known,
                        // so the pre-resolution vector above reached here as
                        // `Error` and the group's same-compilation return type
                        // was never recovered. Now that `method` is known its
                        // delegate parameter pins the group's arity — refine
                        // the vector exactly as the extension-call path does.
                        let refinedInstSymbolicArgs = RefineSymbolicArgsForMethodGroups(
                            method,
                            arguments,
                            instSymbolicArgs,
                            receiverArgCount: 0,
                            isExpanded: resolution.IsExpanded,
                            argumentNames: if argumentNames.IsDefault {
                                default(IReadOnlyList[string?]?)
                            } else {
                                cast[IReadOnlyList[string?]](argumentNames)
                            },
                            parameterMapping: resolution.ParameterMapping,
                            methodGroupSlots: out var instMethodGroupArgumentSlots
                        )
                        // Issue #4133 (hot-core translation guard finding): see
                        // MergeMethodGroupArgumentSlots's doc.
                        instMethodGroupArgumentSlots = MergeMethodGroupArgumentSlots(
                            arguments,
                            receiverArgCount: 0,
                            refinedInstSymbolicArgs.Length,
                            instMethodGroupArgumentSlots
                        )
                        let instSymbolicTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(
                            method,
                            typeArgSymbols,
                            refinedInstSymbolicArgs,
                            resolution.IsExpanded,
                            if argumentNames.IsDefault {
                                default(IReadOnlyList[string?]?)
                            } else {
                                cast[IReadOnlyList[string?]](argumentNames)
                            },
                            instMethodGroupArgumentSlots
                        )
                        let instTypeArgSymbolsForCall = if !instSymbolicTypeArgs.IsDefault {
                            instSymbolicTypeArgs
                        } else {
                            AsNullableElements(typeArgSymbols)
                        }
                        let returnType = ResolveImportedGenericReturnType(method, typeArgSymbols) ??
                            MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(
                            method,
                            instSymbolicTypeArgs,
                            effectiveReceiverType
                        ) ??
                            MemberLookup.GetClrReceiverProjectedReturnTypeSymbol(effectiveReceiverType!!, method) ??
                            MapClrMethodReturnType(method)
                        let instParameters = method.GetParameters()
                        let instMapping = resolution.ParameterMapping
                        let instDownstreamMapping = if resolution.IsExpanded {
                            default(ImmutableArray[int32])
                        } else {
                            instMapping
                        }
                        // Issue #1638: shared CLR call-argument-construction
                        // pipeline (interpolation rebind → handler args →
                        // delegate rebind → parameter conversions).
                        // Issue #3311: the parameter-conversion pass keeps the
                        // RAW receiver type per #1512/#1320, EXCEPT for an open
                        // map — its MapTypeSymbol carries no OpenDefinition, so
                        // TrySubstituteParameterTypeFromReceiver could not
                        // recover the symbolic `!0` parameter slot and a K
                        // argument (e.g. ContainsKey(k)) would box to the
                        // erased `object`, tripping the verifier against the
                        // symbolic `Dictionary<!K, !V>` MemberRef. Feed it the
                        // normalized Dictionary view instead.
                        let instConversionReceiverType = if MemberLookup.TryGetSymbolicOpenReceiverView(
                            receiver?.Type,
                            out _
                        ) {
                            effectiveReceiverType!!
                        } else {
                            receiver?.Type
                        }
                        let instConvertedArgs = BuildResolvedClrCallArguments(
                            arguments,
                            ce.Arguments,
                            instParameters,
                            instMapping,
                            receiver,
                            ce.Location,
                            ce,
                            ClrCallDelegateRebindMode.Full,
                            out var instHandlerPrelude,
                            out var instUpdatedReceiver,
                            method: method,
                            symbolicMethodTypeArgs: instTypeArgSymbolsForCall,
                            receiverType: effectiveReceiverType,
                            hasConversionReceiverTypeOverride: true,
                            conversionReceiverType: instConversionReceiverType,
                            isExpanded: resolution.IsExpanded
                        )
                        let instArguments = OverloadResolver.BuildOrderedCallArguments(
                            instConvertedArgs,
                            instDownstreamMapping,
                            instParameters
                        )
                        let instRefKinds = ComputeArgumentRefKinds(instParameters)
                        overloads.ValidateRefArguments(instArguments, instRefKinds, methodName, ce.Location)
                        // receiver: non-null per the reassignment above; the
                        // switch's lambda arguments (recoverTypeArgSymbols, etc.)
                        // make the compiler re-widen it across this case block.
                        let callReceiver = instUpdatedReceiver ?? receiver
                        if TryReportByRefLikeInheritedCall(callReceiver, method, ce.Location) {
                            return BoundErrorExpression(nil)
                        }
                        var instCall = ConversionClassifier.AutoDereferenceRefReturn(
                            BoundImportedInstanceCallExpression(
                                ce,
                                callReceiver,
                                method,
                                returnType,
                                instArguments,
                                instRefKinds,
                                instTypeArgSymbolsForCall
                            )
                        )
                        instCall = CompleteImportedSuspendingCall(instCall, method, ce.Location)
                        return WrapWithHandlerPrelude(instCall, instHandlerPrelude, ce)
                    }
                    case ClrOverloadResolution.ResolutionOutcome.Ambiguous {
                        Diagnostics.ReportAmbiguousOverload(
                            ce.Location,
                            methodName,
                            resolution.Ambiguous.Length,
                            resolution.Ambiguous.Select(ClrOverloadResolution.FormatMethodSignature)
                        )
                        return BoundErrorExpression(nil)
                    }
                    default { }
                }
            }
        }
        // Issue #527: a public field or property whose type is a CLR delegate
        // (e.g. `public Func<string> OnAsk;`) is invokable through the same
        // call syntax used on the variable itself — `bag.OnAsk()`. Method
        // lookup above only consulted methods named `OnAsk`, so the delegate
        // member would otherwise miss. Lower to a load of the delegate value
        // followed by an `Invoke(args)` dispatch (mirrors the bare-delegate
        // call path in BindCallExpression at #325). This must come before the
        // extension-function fallbacks so an in-scope extension method does
        // not shadow a real delegate-typed member on the type.
        if receiver != nil &&
            TryBindClrDelegateMemberInvocation(
            receiver,
            clrType,
            methodName,
            arguments,
            ce,
            argumentNames,
            out var delegateMemberCall
        ) {
            // Issue #4287: loading the delegate member dereferences the
            // receiver, and this fallback runs after the instance-method gate,
            // so it applies the gate itself (`x.F()` on an `Fns?`).
            return if TryReportStatedNullableReceiverCall(receiver, receiverSyntax, receiverStart, ce) {
                cast[BoundExpression](BoundErrorExpression(nil))
            } else {
                delegateMemberCall!!
            }
        }
        // Phase 3.B.6 / ADR-0019: extension function fallback. After all
        // instance/static lookups fail, try matching by (receiverType, name).
        // Issue #1188: extension functions overload, so select the best
        // matching overload across all (receiver, name) candidates.
        if TryBindExtensionFunctionOverload(receiver, methodName, arguments, ce, argumentNames, out var extResult) {
            return extResult!!
        }
        // Issue #294: BCL/library [Extension] method dispatched with instance
        // (receiver) syntax. After instance members and user extension
        // functions fail, fall back to imported static [Extension] methods
        // whose first parameter is compatible with the receiver type.
        if receiver != nil &&
            TryBindImportedExtensionCall(
            receiver,
            methodName,
            arguments,
            ce,
            out var importedExt,
            explicitTypeArgs,
            typeArgSymbols,
            argumentNames
        ) {
            return importedExt!!
        }
        // Issue #343: if all CLR-instance lookups missed and the call uses
        // named arguments, point at the first unknown parameter name (if any)
        // for a more actionable diagnostic than "unable to find function".
        if !argumentNames.IsDefault &&
            receiver
            ?.Type
            ?.ClrType is Type recvClr &&
            overloads
            .TryReportUnknownNamedArgumentForClr(
            recvClr,
            methodName,
            BindingFlags.Instance | BindingFlags.Public,
            ce,
            argumentNames
        ) {
            return BoundErrorExpression(nil)
        }
        // Issue #2304: an imported interface (`ImportedTypeSymbol` whose
        // `ClrType.IsInterface` is true) implicitly derives from
        // `System.Object` for member-access purposes. `Type.GetMethods()` on
        // an interface type never reports Object's members (only the
        // interface's own transitive base interfaces are walked above), so
        // ToString/GetHashCode/Equals/GetType otherwise dead-end here. Run
        // AFTER every instance/extension lookup so a same-named member still
        // wins.
        // receiver: non-null per the reassignment above (see comment there);
        // the switch above re-widens it for the compiler for the rest of the method.
        if clrType != nil &&
            clrType.IsInterface == true &&
            TryBindInterfaceObjectMemberCall(
            receiver,
            methodName,
            arguments,
            ce,
            argumentNames,
            out var importedIfaceObjectCall
        ) {
            // Issue #4287: this fallback selects a System.Object member for an
            // imported interface receiver AFTER the instance-method gate above,
            // so it applies the same gate itself: `d.ToString()` on an
            // `IDisposable?` is a call on a stated `T?` receiver like any other.
            // (receiver: non-null here, per the note above.)
            return if receiver != nil &&
                TryReportStatedNullableReceiverCall(receiver, receiverSyntax, receiverStart, ce) {
                cast[BoundExpression](BoundErrorExpression(nil))
            } else {
                importedIfaceObjectCall!!
            }
        }
        // Issue #4013: before falling back to the generic "Cannot find
        // function" text, say so when the member DOES exist but only as an
        // explicit interface implementation. Since #4013 such a member is no
        // longer a candidate for an ordinary call — it is not on the
        // implementing type's own surface, exactly as in C# — and without this
        // the author of `map[string, int32]{}.Contains(k)` gets the very same
        // message a misspelled member produces. Only reached on the error path,
        // and only when the receiver's own surface has no member of this name
        // at all: an inapplicable overload on a type that DOES expose the name
        // (`List[int32]().Add("x")`) stays GS0159, which is what an imported
        // member with no interface sibling (`Stack[int32]().Push("x")`) already
        // reported before this change.
        // The excluded members are ranked against the bound arguments, so the
        // diagnostic is chosen only when one of them could really have taken
        // this call — `map[string, int32]{}.Contains(1, 2)` matches `Contains`
        // by name but no unary `ICollection<KeyValuePair<K, V>>.Contains`
        // accepts two arguments, and keeps GS0159 (review finding on #4031).
        let explicitIfaceArgClrTypes = [arguments.Length]Type?
        for var i = 0; i < arguments.Length; i++ {
            explicitIfaceArgClrTypes[i] = if arguments[i].Type is {} explicitIfaceArgType &&
                MemberLookup.TryProjectErasedClrType(explicitIfaceArgType, out var explicitIfaceArgClr) {
                explicitIfaceArgClr
            } else {
                default(Type?)
            }
        }
        if receiver?.Type is {} explicitIfaceRecvType && MemberLookup.TryProjectErasedClrType(
            explicitIfaceRecvType,
            out var explicitIfaceRecvClr
        ) &&
            MemberLookup
            .TryFindInterfaceOnlyInstanceMethod(
            explicitIfaceRecvClr,
            methodName,
            explicitIfaceArgClrTypes,
            out var declaringIface
        ) {
            Diagnostics.ReportExplicitInterfaceMemberNotOnTypeSurface(
                ce.Location,
                explicitIfaceRecvType.Name,
                methodName,
                TypeSymbol.FromClrTypeWithoutNullability(declaringIface, NullabilityFreeReason.TypeStructure)
                    .ToDisplayString(DisplayFormat.Minimal)
            )
            return BoundErrorExpression(nil)
        }
        if TryReportValueNullableByRefArgument(ce, arguments, receiver?.Type?.ClrType, methodName) {
            return BoundErrorExpression(nil)
        }
        Diagnostics.ReportUnableToFindFunction(ce.Location, methodName)
        return BoundErrorExpression(nil)
    }

    /// Issue #4422: before an imported call falls back to "cannot find
    /// function", names the real reason when an argument addresses
    /// value-type `V?` storage (a `Nullable<V>`) and a
    /// same-named, same-arity candidate takes that position as `ref V`
    /// (or `out`/`in`). The two are different runtime types, so no
    /// candidate applied; reporting GS0154 against that parameter says why.
    /// @param ce The call syntax.
    /// @param arguments The bound arguments, in source order.
    /// @param declaringType The CLR type whose methods were searched, if known.
    /// @param methodName The method name.
    /// @returns `true` when GS0154 was reported.
    private func TryReportValueNullableByRefArgument(
        ce CallExpressionSyntax,
        arguments ImmutableArray[BoundExpression],
        declaringType Type?,
        methodName string
    ) bool {
        if declaringType == nil {
            return false
        }
        for var i = 0; i < arguments.Length; i++ {
            if !(arguments[i] is BoundAddressOfExpression{Operand: {Type: {} storage}}) ||
                NullableLifting.GetEffectiveClrType(storage) is not{IsValueType: true} storageClr {
                continue
            }
            // The storage is `V?` (look for `ref V`) or a plain `V` (look for
            // `ref V?`).
            let storageIsNullable = NullableLifting.IsValueTypeNullableClr(storageClr)
            let wantedClr = if storageIsNullable {
                storageClr.GetGenericArguments()[0]
            } else {
                storageClr
            }
            for method in declaringType.GetMethods(
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance
            ) {
                if !string.Equals(method.Name, methodName, StringComparison.Ordinal) {
                    continue
                }
                let parameters = method.GetParameters()
                if parameters.Length != arguments.Length ||
                    !parameters[i]
                    .ParameterType
                    .IsByRef ||
                    parameters[i]
                    .ParameterType
                    .GetElementType() is not{} element || NullableLifting.IsValueTypeNullableClr(
                    element
                ) == storageIsNullable {
                    continue
                }
                let elementValue = if storageIsNullable {
                    element
                } else {
                    element.GetGenericArguments()[0]
                }
                if !ClrTypeUtilities.AreSame(elementValue, wantedClr) {
                    continue
                }
                let location = if i < ce.Arguments.Count {
                    ce.Arguments[i].Location
                } else {
                    ce.Location
                }
                Diagnostics.ReportWrongValueNullableByRefArgument(
                    location,
                    parameters[i].Name ?? "value",
                    ClrNullability.GetParameterTypeSymbol(parameters[i]),
                    storage
                )
                return true
            }
        }
        return false
    }

    private func TryProjectArgumentClrTypeFromSymbolicReceiver(
        candidates IReadOnlyList[MethodInfo],
        sourceArgumentIndex int32,
        call CallExpressionSyntax,
        receiverType TypeSymbol,
        argumentType TypeSymbol,
        @NotNullWhen(true) out projectedType Type?
    ) bool {
        projectedType = nil
        for candidate in candidates {
            let parameterIndex = MapSourceArgumentToParameter(
                candidate.GetParameters(),
                call,
                sourceArgumentIndex,
                offset: 0
            )
            if parameterIndex < 0 {
                continue
            }
            let symbolicTarget TypeSymbol? = ConversionClassifier.TrySubstituteParameterTypeFromReceiver(
                candidate,
                parameterIndex,
                receiverType
            )
            if symbolicTarget == nil {
                continue
            }
            if !CanConvertToSymbolicReceiverTarget(argumentType, symbolicTarget) {
                continue
            }
            let targetClr Type? = NullableLifting.GetEffectiveClrType(symbolicTarget) ??
                (
                if MemberLookup.TryProjectErasedClrType(symbolicTarget, out var projected) {
                    projected
                } else {
                    default(Type?)
                }
            )
            if targetClr == nil || targetClr.IsSameAs(typeof(object)) {
                continue
            }
            let referenceTarget = $scope.References!!.MapClrTypeToReferences(targetClr)
            if projectedType != nil && !ClrTypeUtilities.AreSame(projectedType, referenceTarget) {
                projectedType = nil
                return false
            }
            projectedType = referenceTarget
        }
        return projectedType != nil
    }

    /// Issue #4287: whether an imported CLR instance method, already selected
    /// against a receiver's underlying type, is being called on a receiver
    /// somebody STATED is a nilable reference (`T?`). If so, reports
    /// GS0159 ("receiver may be nil"), the same diagnostic a G#-declared
    /// method gets on that receiver.
    ///
    /// This is the call-path twin of `CanBindClrInstanceMember`, which
    /// rejects a stated `T?` for member reads and writes (#4356/#4390)
    /// but was never consulted for calls. The receiver's `ClrType` is
    /// the underlying type's, so without this test `this.name.ToUpper()`
    /// on a `string?` bound directly and threw a bare
    /// `NullReferenceException` on nil.
    ///
    /// It runs <em>after</em> selection, so it changes which calls are
    /// accepted and never which member is chosen. A name that no instance
    /// method matches still falls through to the extension paths, where an
    /// extension declared over the nilable type is legal. A value-type
    /// `T?` is not affected: its members live on
    /// `Nullable<T>` itself and are safe to call on nil. A platform
    /// `T!` never reaches here as a (cref:NullableTypeSymbol);
    /// ADR-0186 §4's attributed check handles it.
    /// @param receiver The bound receiver.
    /// @param receiverSyntax The receiver's syntax, when the caller has it.
    /// @param receiverStart The receiver text's start, when it differs from the syntax's.
    /// @param ce The call.
    /// @returns `true` when GS0159 was reported.
    private func TryReportStatedNullableReceiverCall(
        receiver BoundExpression,
        receiverSyntax ExpressionSyntax?,
        receiverStart int32?,
        ce CallExpressionSyntax
    ) bool {
        // Value-ness is asked of the SYMBOL, as SmartCastStability asks it, not
        // of `UnderlyingType.ClrType`: a receiver whose underlying type has no
        // CLR type while binding (a same-compilation class, a normalized
        // `sequence[...]`) is still a nilable reference and must not slip
        // through as "not known".
        if receiver.Type is not NullableTypeSymbol nullableReceiver || NullableLifting.IsValueTypeNullable(
            nullableReceiver
        ) ||
            NullableLifting.IsUserValueTypeNullable(nullableReceiver) {
            return false
        }
        Diagnostics.ReportNilableReceiverCall(
            ce.Location,
            ce.Identifier.ValueText,
            DescribeCallReceiver(receiver, receiverSyntax, receiverStart)
        )
        return true
    }

    private func IsApplicableNullableUnderlyingCall(
        receiver BoundExpression,
        underlyingType TypeSymbol,
        methodName string,
        arguments ImmutableArray[BoundExpression],
        ce CallExpressionSyntax,
        argumentNames ImmutableArray[string],
        explicitTypeArgs[]?Type,
        typeArgSymbols ImmutableArray[TypeSymbol]
    ) bool {
        let narrowedReceiver = BoundConversionExpression(receiver.Syntax, underlyingType, receiver)
        let diagnosticMark = Diagnostics.Count
        // Reuse normal call binding as an applicability probe, then discard its
        // diagnostics so only the nullable-receiver diagnostic reaches users.
        let Succeeded = func (call BoundExpression) bool {
            return call != nil && !(call is BoundErrorExpression) && Diagnostics.Count == diagnosticMark
        }
        try {
            if underlyingType is InterfaceSymbol ifaceRecv {
                let candidates = TypeMemberModel.GetMethods(
                    ifaceRecv,
                    methodName,
                    MemberQuery.Instance(MemberKinds.Method)
                )
                if !candidates.IsDefaultOrEmpty {
                    let method FunctionSymbol? = overloads.SelectInstanceOverloadOrReport(
                        candidates,
                        arguments,
                        ce,
                        methodName,
                        argumentNames
                    )
                    return method != nil &&
                        Succeeded(
                        overloads.BindUserInstanceCall(narrowedReceiver, method, arguments, ce, argumentNames)
                    )
                }
            }
            if underlyingType is TypeParameterSymbol tpRecv {
                let candidates = MemberLookup.CollectSourceInstanceMethods(tpRecv, methodName)
                if !candidates.IsDefaultOrEmpty {
                    let method FunctionSymbol? = overloads.SelectInstanceOverloadOrReport(
                        candidates,
                        arguments,
                        ce,
                        methodName,
                        argumentNames
                    )
                    return method != nil &&
                        Succeeded(
                        overloads.BindUserInstanceCall(
                            narrowedReceiver,
                            method,
                            arguments,
                            ce,
                            argumentNames,
                            constrainedReceiverTypeParameter: tpRecv
                        )
                    )
                }
                if (tpRecv.ClrInterfaceConstraint != nil || tpRecv.ClassConstraint?.ClrType != nil) &&
                    TryBindConstrainedClrCall(
                    narrowedReceiver,
                    tpRecv,
                    methodName,
                    arguments,
                    ce,
                    argumentNames,
                    out var constrainedCall
                ) {
                    return Succeeded(constrainedCall!!)
                }
            }
            if underlyingType is StructSymbol structRecv {
                let candidates = MemberLookup.CollectSourceInstanceMethods(structRecv, methodName)
                if !candidates.IsDefaultOrEmpty {
                    let method FunctionSymbol? = overloads.SelectInstanceOverloadOrReport(
                        candidates,
                        arguments,
                        ce,
                        methodName,
                        argumentNames
                    )
                    return method != nil &&
                        Succeeded(
                        overloads.BindUserInstanceCall(narrowedReceiver, method, arguments, ce, argumentNames)
                    )
                }
                let defaultInterfaceMethod FunctionSymbol? = TryFindDefaultInterfaceMethod(
                    structRecv,
                    methodName,
                    arguments,
                    ce,
                    argumentNames
                )
                if defaultInterfaceMethod != nil {
                    return Succeeded(
                        overloads.BindUserInstanceCall(
                            narrowedReceiver,
                            defaultInterfaceMethod,
                            arguments,
                            ce,
                            argumentNames
                        )
                    )
                }
            }
            if (underlyingType is StructSymbol || underlyingType is InterfaceSymbol) &&
                TryBindUserCallableMemberInvocation(
                narrowedReceiver,
                underlyingType,
                methodName,
                arguments,
                ce,
                isStatic: false,
                out var delegateCall
            ) {
                return Succeeded(delegateCall!!)
            }
            if TryBindExtensionFunctionOverload(
                narrowedReceiver,
                methodName,
                arguments,
                ce,
                argumentNames,
                out var extensionCall
            ) {
                return Succeeded(extensionCall!!)
            }
            if underlyingType is StructSymbol inheritedDerived &&
                (GetInheritedClrBaseType(inheritedDerived) ?? typeof(object)) is Type inheritedBaseClr &&
                TryBindInheritedClrInstanceCall(
                narrowedReceiver,
                inheritedBaseClr,
                methodName,
                arguments,
                ce,
                out var inheritedCall,
                explicitTypeArgs,
                typeArgSymbols,
                argumentNames,
                allowProtectedInherited: IsCurrentThisReceiver(receiver)
            ) {
                return Succeeded(inheritedCall!!)
            }
            if underlyingType is EnumSymbol &&
                TryBindInheritedClrInstanceCall(
                narrowedReceiver,
                typeof(Enum),
                methodName,
                arguments,
                ce,
                out var enumCall,
                explicitTypeArgs,
                typeArgSymbols,
                argumentNames,
                mapEnumArgumentsToBaseClr: true
            ) {
                return Succeeded(enumCall!!)
            }
            if TryBindImportedExtensionCall(
                narrowedReceiver,
                methodName,
                arguments,
                ce,
                out var importedExtensionCall,
                explicitTypeArgs,
                typeArgSymbols,
                argumentNames
            ) {
                return Succeeded(importedExtensionCall!!)
            }
            if underlyingType is InterfaceSymbol importedBaseIface &&
                TryBindInterfaceImportedBaseInstanceCall(
                narrowedReceiver,
                importedBaseIface,
                methodName,
                arguments,
                ce,
                out var importedBaseCall,
                explicitTypeArgs,
                typeArgSymbols,
                argumentNames
            ) {
                return Succeeded(importedBaseCall!!)
            }
            if underlyingType is TypeParameterSymbol tpObject &&
                TryBindConstrainedObjectMemberCall(
                narrowedReceiver,
                tpObject,
                methodName,
                arguments,
                ce,
                argumentNames,
                out var objectCall
            ) {
                return Succeeded(objectCall!!)
            }
            return underlyingType is InterfaceSymbol &&
                TryBindInterfaceObjectMemberCall(
                narrowedReceiver,
                methodName,
                arguments,
                ce,
                argumentNames,
                out var interfaceObjectCall
            ) &&
                Succeeded(interfaceObjectCall!!)
        } finally {
            Diagnostics.TruncateTo(diagnosticMark)
        }
    }

    shared {
        /// Issue #320: computes a return-type override for an imported generic method
        /// closed over explicit type arguments. When the method's open return type is
        /// exactly one of its method type parameters, the real return type is the
        /// corresponding explicit type-argument symbol (recovering a user-defined type
        /// that was closed with an (cref:object) placeholder). Returns
        /// `null` when no override is needed, so callers keep their
        /// existing return-type derivation.
        /// @param closed The closed generic method selected by overload resolution.
        /// @param typeArgSymbols The explicit type-argument symbols, or default.
        /// @returns The override return type symbol, or `null`.
        private func ResolveImportedGenericReturnType(
            closed MethodInfo,
            typeArgSymbols ImmutableArray[TypeSymbol]
        ) TypeSymbol? {
            if !typeArgSymbols.IsDefaultOrEmpty && ClrOverloadResolution.TryGetGenericMethodParameterReturnPosition(
                closed,
                out var position
            ) &&
                position >= 0 &&
                position < typeArgSymbols
                .Length {
                // #4451: the same explicit-argument rule the symbolic vector
                // applies, so an oblivious `T Echo<T>(T)` returns `string!`.
                return MemberLookup.ApplyExplicitMethodTypeArgument(closed, position, typeArgSymbols[position])
            }
            return nil
        }

        /// Issue #1320: a `sequence[T]` / `asyncsequence[T]` (iterator
        /// return types, aliases for `IEnumerable<T>` /
        /// `IAsyncEnumerable<T>`) or a user-element array receiver over a
        /// same-compilation user element type has a `null`
        /// (cref:TypeSymbol.ClrType) during binding (the element type is not
        /// yet emitted). That null ClrType caused instance-method lookup
        /// (e.g. `GetEnumerator`) to dead-end with GS0159, even though the same
        /// call resolves on an explicitly-typed `IEnumerable[T]` parameter
        /// (whose ClrType type-erases to `IEnumerable<object>`) and on a
        /// primitive-element `sequence[int32]` / array. Normalize such a
        /// receiver to the equivalent type-erased shape so the shared CLR
        /// member-lookup + symbolic return-type recovery path resolves it uniformly:
        /// - `sequence[T]` → a constructed (cref:ImportedTypeSymbol) over `IEnumerable<>` with the symbolic
        /// `[T]` argument (so the generic `GetEnumerator() → IEnumerator[T]` overload and its element-typed
        /// return are recovered, exactly as for an `IEnumerable[T]` parameter).
        /// - `asyncsequence[T]` → the `IAsyncEnumerable<>` counterpart.
        /// - user-element array / slice → a plain (cref:ImportedTypeSymbol) over the erased array CLR type
        /// (e.g. `object[]`), reaching parity with a primitive-element array (which finds the non-generic
        /// `GetEnumerator()`).
        /// - issue #3311: open `map[K, V]` (null ClrType) → the symbolic constructed `Dictionary[K, V]` view,
        /// so the CLR-interop member surface (`ContainsKey`, `TryGetValue`, `GetEnumerator`, …) resolves
        /// exactly as on an explicit `Dictionary[K, V]` receiver.
        /// The bound call keeps the original receiver expression; the emitter
        /// already normalizes sequence/array receivers
        /// (`TryNormalizeToSymbolicContainer`), so emission is unaffected.
        /// Returns `false` when no normalization applies.
        /// @param receiverType The receiver's static type symbol.
        /// @param normalized The normalized receiver type, on success.
        /// @returns `true` when a normalized receiver type was produced.
        internal func TryNormalizeSymbolicEnumerableReceiver(
            receiverType TypeSymbol?,
            @NotNullWhen(true) out normalized TypeSymbol?
        ) bool {
            normalized = nil
            if receiverType == nil || receiverType.ClrType != nil {
                return false
            }
            switch receiverType {
                case seq is SequenceTypeSymbol {
                    normalized = ImportedTypeSymbol.GetConstructed(
                        typeof(IEnumerable[object]),
                        typeof(System.Collections.Generic.IEnumerable[_]),
                        ImmutableArray.Create(seq.ElementType)
                    )
                    return true
                }
                case aseq is AsyncSequenceTypeSymbol {
                    normalized = ImportedTypeSymbol.GetConstructed(
                        typeof(IAsyncEnumerable[object]),
                        typeof(System.Collections.Generic.IAsyncEnumerable[_]),
                        ImmutableArray.Create(aseq.ElementType)
                    )
                    return true
                }
                case _ is ArrayTypeSymbol or _ is SliceTypeSymbol or _ is RectangularArrayTypeSymbol {
                    if MemberLookup.TryProjectErasedClrType(receiverType, out var erasedArray) {
                        normalized = ImportedTypeSymbol.GetWithoutNullability(
                            erasedArray,
                            NullabilityFreeReason.TypeStructure
                        )
                        return true
                    }
                    return false
                }
                case MapTypeSymbol {
                    // Issue #3311: interop member calls on an open-generic map
                    // receiver (`items.ContainsKey(k)` where `items : map[K, V]`
                    // with type-parameter K/V) dead-ended with GS0159 because the
                    // receiver's ClrType is null by construction. Its runtime
                    // backing is always `Dictionary<K, V>`, so normalize to the
                    // same symbolic constructed shape an explicit
                    // `Dictionary[K, V]` receiver carries (#313/#794/#1107): the
                    // erased closed ClrType drives member lookup, the symbolic
                    // [K, V] arguments drive return/parameter/out-var
                    // re-projection, and the emitter parents the MemberRefs at
                    // the `Dictionary<!K, !V>` TypeSpec
                    // (TryNormalizeToSymbolicContainer's map arm).
                    if MemberLookup.TryGetSymbolicOpenReceiverView(receiverType, out var mapView) {
                        normalized = mapView
                        return true
                    }
                    return false
                }
                case ChannelTypeSymbol {
                    // ADR-0174 D12: a `chan[T]` over a same-compilation or
                    // type-parameter element (`ch.Close()` where `ch : chan[Pair]`)
                    // normalizes to the symbolic constructed Channel<T> /
                    // ChannelReader<T> / ChannelWriter<T> view for the same reason.
                    if MemberLookup.TryGetSymbolicOpenChannelReceiverView(receiverType, out var channelView) {
                        normalized = channelView
                        return true
                    }
                    return false
                }
                default {
                    return false
                }
            }
        }

        /// ADR-0155: (cref:ImmutableArray{T}) is invariant, so a fully-resolved
        /// `ImmutableArray<TypeSymbol>` (every explicit type argument is
        /// known) does not implicitly widen to the
        /// `ImmutableArray<TypeSymbol?>` shape the symbolic-inference APIs
        /// (`*MethodTypeArguments` / `symbolicMethodTypeArgs`) use to mean
        /// "this position is still unresolved". Every element here is already
        /// non-null, so the projection is a pure annotation widening, never a data
        /// loss.
        private func AsNullableElements(types ImmutableArray[TypeSymbol]) ImmutableArray[TypeSymbol?] {
            if types.IsDefault {
                return default(ImmutableArray[TypeSymbol?])
            }
            let nullableTypes = ImmutableArray.CreateBuilder[TypeSymbol?](types.Length)
            for type in types {
                nullableTypes.Add(type)
            }
            return nullableTypes.MoveToImmutable()
        }

        /// Issue #891: determines whether the supplied expression is an arrow
        /// lambda with at least one parameter whose type is omitted, so its
        /// parameter type(s) must be inferred from a target delegate.
        private func IsUntypedArrowLambda(inner ExpressionSyntax) bool {
            if inner is not LambdaExpressionSyntax lambda {
                return false
            }
            for var i = 0; i < lambda.Parameters.Count; i++ {
                if lambda.Parameters[i].Type == nil {
                    return true
                }
            }
            return false
        }

        private func TryResolveTargetDependentBlockTarget(
            candidateParameterLists IReadOnlyList[[]ParameterInfo],
            parameterOffset int32,
            sourceArgumentCount int32,
            sourceArgumentIndex int32,
            argumentName string?,
            syntax ExpressionSyntax,
            @NotNullWhen(true) out target TypeSymbol?
        ) bool {
            target = nil
            for parameters in candidateParameterLists {
                let visibleParameterCount = parameters.Length - parameterOffset
                let hasParams = parameters.Length > parameterOffset && ClrOverloadResolution.IsParamsArrayParameter(
                    parameters[^1]
                )
                var requiredCount = 0
                let visibleEnd = parameterOffset +
                    (
                    if hasParams {
                        visibleParameterCount - 1
                    } else {
                        visibleParameterCount
                    }
                )
                for var i = parameterOffset; i < visibleEnd; i++ {
                    if !parameters[i].IsOptional {
                        requiredCount++
                    }
                }
                if sourceArgumentCount < requiredCount || (!hasParams && sourceArgumentCount > visibleParameterCount) {
                    continue
                }
                var parameterIndex = sourceArgumentIndex + parameterOffset
                if !string.IsNullOrEmpty(argumentName) {
                    parameterIndex = -1
                    for var i = 0; i < parameters.Length; i++ {
                        if string.Equals(parameters[i].Name, argumentName, StringComparison.Ordinal) {
                            parameterIndex = i
                            break
                        }
                    }
                }
                if parameterIndex < 0 || parameterIndex >= parameters.Length {
                    continue
                }
                let parameterType = parameters[parameterIndex].ParameterType
                if parameterType.ContainsGenericParameters {
                    continue
                }
                let candidateTarget = ClrNullability.GetParameterTypeSymbol(parameters[parameterIndex])
                if !CanTargetDependentBlockArgument(syntax, candidateTarget) {
                    continue
                }
                if target == nil {
                    target = candidateTarget
                } else if !TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(target, candidateTarget) {
                    target = nil
                    return false
                }
            }
            return target != nil
        }

        /// Issue #1330: resolves the open generic <em>type</em> definition's method
        /// corresponding to [`closedMethod`](paramref) (a static method on the
        /// type-erased closed shape, e.g. `Comparer<object>.Create`) by
        /// metadata-token identity, yielding e.g. `Comparer<>.Create`
        /// whose parameter/return types are stated in terms of the type's open
        /// generic parameters.
        private func TryResolveOpenStaticMethod(
            openDefinition Type?,
            closedMethod MethodInfo,
            @NotNullWhen(true) out openMethod MethodInfo?
        ) bool -> TryResolveOpenMethodByToken(openDefinition, closedMethod, BindingFlags.Static, out openMethod)

        /// Issue #2365: instance-method sibling of (cref:TryResolveOpenStaticMethod).
        /// Resolves the open generic <em>type</em> definition's INSTANCE method
        /// corresponding to [`closedMethod`](paramref) (a non-generic instance
        /// method reflected off a constructed generic receiver, e.g.
        /// `CreateTableBuilder<object>.PrimaryKey`) by metadata-token
        /// identity, yielding the open shape (e.g. `CreateTableBuilder<>.PrimaryKey`)
        /// whose parameter types are stated in terms of the type's own open generic
        /// parameters. This lets a delegate/expression-tree parameter that closes
        /// over the DECLARING TYPE's type parameter (rather than a method-level one)
        /// recover its symbolic shape even though the method itself is not generic.
        private func TryResolveOpenInstanceMethod(
            openDefinition Type?,
            closedMethod MethodInfo,
            @NotNullWhen(true) out openMethod MethodInfo?
        ) bool -> TryResolveOpenMethodByToken(openDefinition, closedMethod, BindingFlags.Instance, out openMethod)

        private func TryResolveOpenMethodByToken(
            openDefinition Type?,
            closedMethod MethodInfo?,
            kindFlag BindingFlags,
            @NotNullWhen(true) out openMethod MethodInfo?
        ) bool {
            openMethod = nil
            if openDefinition == nil || closedMethod == nil {
                return false
            }
            try {
                for candidate in openDefinition.GetMethods(kindFlag | BindingFlags.Public | BindingFlags.NonPublic) {
                    if candidate.MetadataToken == closedMethod.MetadataToken &&
                        candidate.Module == closedMethod.Module {
                        openMethod = candidate
                        return true
                    }
                }
            } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                return false
            }
            return false
        }

        /// Issue #1330: builds a (cref:FunctionTypeSymbol) for an open
        /// delegate parameter type (e.g. `Comparison<T>`) by substituting
        /// the receiver's symbolic type arguments into the delegate's
        /// `Invoke` signature, producing the symbolic target
        /// `(TResult, TResult) -> int32`. Returns `false` when
        /// the parameter is not a delegate type.
        private func TryBuildSymbolicDelegateTarget(
            openParameterType Type?,
            openDefinition Type?,
            symbolicArgs ImmutableArray[TypeSymbol],
            @NotNullWhen(true) out mapped TypeSymbol?,
            @NotNullWhen(true) out target FunctionTypeSymbol?
        ) bool {
            mapped = nil
            target = nil
            if openParameterType == nil {
                return false
            }
            // Issue #2918: substitute the complete parameter before asking whether
            // it is a lambda target. The open parameter may itself be `T`, while
            // the receiver or method closes `T` to `Action[Src]`.
            mapped = MemberLookup.MapOpenSignatureWithoutDeclarationMerge(
                openParameterType,
                openDefinition,
                symbolicArgs
            )
            if !MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(mapped!!, out var candidate) {
                return false
            }
            target = candidate
            return true
        }

        private func PeelByRef(type Type?) Type? -> if type?.IsByRef == true {
            type!!.GetElementType()
        } else {
            type
        }

        private func UnwrapExpressionTreeDelegate(
            type TypeSymbol
        ) TypeSymbol -> if MemberLookup.TryGetExpressionTreeDelegateTypeFromSymbol(type, out var delegateType) {
            delegateType!!
        } else {
            type
        }

        private func IsCanonicalFunctionDelegate(type TypeSymbol) bool {
            var type = type
            type = UnwrapExpressionTreeDelegate(type)
            if type is ImportedTypeSymbol imported {
                var definition Type? = imported.OpenDefinition ?? imported.ClrType
                if definition?.IsGenericType == true && !definition!!.IsGenericTypeDefinition {
                    definition = definition!!.GetGenericTypeDefinition()
                }
                let coreLibrary Assembly? = definition?.BaseType?.Assembly
                // definition != null is implied by coreLibrary != null (both derive
                // from the same `definition?.` chain); stated explicitly so the
                // rest of this block can use `definition` without re-deriving it.
                if definition != nil && string.Equals(
                    definition.BaseType?.FullName,
                    "System.MulticastDelegate",
                    StringComparison.Ordinal
                ) &&
                    coreLibrary != nil {
                    let arity = if definition.IsGenericTypeDefinition {
                        definition.GetGenericArguments().Length
                    } else {
                        0
                    }
                    let fullName = definition.FullName
                    if (
                        string.Equals(fullName, "System.Action", StringComparison.Ordinal) ||
                            (
                            arity > 0 &&
                                (
                                string.Equals(fullName, "System.Action`$arity", StringComparison.Ordinal) ||
                                    string.Equals(fullName, "System.Func`$arity", StringComparison.Ordinal)
                            )
                        )
                    ) &&
                        TypeIdentityComparer
                        .Instance
                        .Equals(definition, coreLibrary.GetType(fullName!!)) {
                        return true
                    }
                }
            }
            return false
        }

        private func ShouldConvertToNominalDelegate(type TypeSymbol) bool {
            var type = type
            if IsCanonicalFunctionDelegate(type) {
                return false
            }
            type = UnwrapExpressionTreeDelegate(type)
            return !TypeSymbol.ContainsTypeParameter(type) && type?.ClrType?.ContainsGenericParameters != true
        }

        private func SameDelegateIdentity(left TypeSymbol, right TypeSymbol) bool {
            var left = left
            var right = right
            left = UnwrapExpressionTreeDelegate(left)
            right = UnwrapExpressionTreeDelegate(right)
            if object.ReferenceEquals(left, right) {
                return true
            }
            if left is not ImportedTypeSymbol leftImported || right is not ImportedTypeSymbol rightImported {
                return object.Equals(left, right)
            }
            let leftDefinition = leftImported.OpenDefinition ?? leftImported.ClrType
            let rightDefinition = rightImported.OpenDefinition ?? rightImported.ClrType
            if !TypeIdentityComparer.Instance.Equals(leftDefinition, rightDefinition) ||
                leftImported
                .TypeArguments
                .Length != rightImported
                .TypeArguments
                .Length {
                return false
            }
            if IsCanonicalFunctionDelegate(left) && IsCanonicalFunctionDelegate(right) {
                return true
            }
            for var i = 0; i < leftImported.TypeArguments.Length; i++ {
                if !SameDelegateIdentity(leftImported.TypeArguments[i], rightImported.TypeArguments[i]) {
                    return false
                }
            }
            return true
        }

        /// Issue #1512 / #2365: builds a symbolic (cref:FunctionTypeSymbol) for
        /// a lambda argument bound to a CLR/imported method whose delegate (or
        /// `Expression<TDelegate>`-wrapped delegate) parameter mentions a
        /// generic type parameter — either a METHOD-level one (e.g.
        /// `Task.ContinueWith<TResult>(Func<Task,TResult>)`, #1512) or
        /// the DECLARING TYPE's own type parameter closed over by a symbolic
        /// receiver on a non-generic method (e.g.
        /// `CreateTableBuilder<TColumns>.PrimaryKey(Expression<Func<TColumns,object>>)`,
        /// #2365). The CLOSED method's parameter is type-erased
        /// (`Expression<Func<object,object>>` / `Func<Task,object>`),
        /// which would force the lambda's bound function type — and therefore its
        /// synthesized return/parameter shape — to `object`, producing an
        /// unverifiable delegate. This recovers the real shape by substituting the
        /// inferred symbolic method type arguments AND/OR the receiver's symbolic
        /// type arguments through the OPEN method's delegate parameter via
        /// (cref:MemberLookup.MapOpenClrTypeToSymbolic(Type, Type, ImmutableArray{TypeSymbol}, MethodInfo,
        /// ImmutableArray{TypeSymbol})),
        /// unwrapping an `Expression<TDelegate>` parameter shape to its
        /// inner delegate first so both direct-delegate and expression-tree targets
        /// share the same recovery path. Returns `false` (deferring
        /// to the erased target) when neither the method nor the receiver carries a
        /// symbolic type argument, the parameter is not a delegate/expression-tree
        /// shape, or no recovered position contains a type parameter /
        /// same-compilation user type.
        private func TryBuildSymbolicDelegateTargetForMethodParam(
            closedMethod MethodInfo?,
            paramIndex int32,
            symbolicMethodTypeArgs ImmutableArray[TypeSymbol?],
            receiverType TypeSymbol?,
            @NotNullWhen(true) out target FunctionTypeSymbol?
        ) bool {
            target = nil
            if closedMethod == nil {
                return false
            }
            let nonNullSymbolicMethodTypeArgs = if symbolicMethodTypeArgs.IsDefault {
                default(ImmutableArray[TypeSymbol])
            } else {
                symbolicMethodTypeArgs.Select((symbol TypeSymbol?) -> symbol ?? TypeSymbol.Error).ToImmutableArray()
            }
            let methodHasSymbolicArgs = closedMethod.IsGenericMethod &&
                !nonNullSymbolicMethodTypeArgs.IsDefaultOrEmpty &&
                nonNullSymbolicMethodTypeArgs.Any(TypeSymbol.RequiresSymbolicProjection)
            var receiverOpenDef Type? = nil
            var receiverTypeArgs = default(ImmutableArray[TypeSymbol])
            if receiverType is ImportedTypeSymbol imp &&
                imp.OpenDefinition != nil &&
                !imp
                .TypeArguments
                .IsDefaultOrEmpty {
                receiverOpenDef = imp.OpenDefinition
                receiverTypeArgs = imp.TypeArguments
            }
            let receiverHasSymbolicArgs = receiverOpenDef != nil && receiverTypeArgs.Any(
                TypeSymbol.RequiresSymbolicProjection
            )
            if !methodHasSymbolicArgs && !receiverHasSymbolicArgs {
                return false
            }
            var openMethod MethodInfo
            var openParams[]ParameterInfo
            try {
                if closedMethod.IsGenericMethod {
                    openMethod = if closedMethod.IsGenericMethodDefinition {
                        closedMethod
                    } else {
                        closedMethod.GetGenericMethodDefinition()
                    }
                } else if receiverOpenDef != nil &&
                    !closedMethod.IsStatic &&
                    TryResolveOpenInstanceMethod(receiverOpenDef, closedMethod, out var resolvedOpenMethod) {
                    // Issue #2365: the method itself has no generic parameters of
                    // its own — TColumns belongs to the DECLARING TYPE
                    // (`CreateTableBuilder[TColumns]`) — so recover the open shape
                    // from the receiver's open type definition rather than from
                    // `GetGenericMethodDefinition()` (which only applies to
                    // method-level generics).
                    openMethod = resolvedOpenMethod!!
                } else {
                    return false
                }
                openParams = openMethod.GetParameters()
            } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                return false
            }
            if paramIndex < 0 || paramIndex >= openParams.Length {
                return false
            }
            // Issue #5543: a lambda is a plain value, so an `in` slot targets its pointee.
            var openParamType Type? = ConversionClassifier.GetPlainValueClrParameterType(openParams[paramIndex])
            // Issue #2365: an `Expression<TDelegate>` parameter is not itself a
            // delegate (it exposes no `Invoke`), so unwrap it to the wrapped open
            // delegate type first. Both a direct delegate parameter and an
            // expression-tree-wrapped one recover through the identical
            // substitution path below; the caller compares the result against the
            // literal's own (unwrapped) delegate function type either way.
            if MemberLookup.TryGetExpressionTreeDelegateType(openParamType, out var unwrappedOpenDelegate) {
                openParamType = unwrappedOpenDelegate
            }
            let invoke MethodInfo? = openParamType?.GetMethodSafe("Invoke")
            if invoke == nil {
                return false
            }
            let invokeParameters = invoke.GetParameters()
            let parameterTypes = ImmutableArray.CreateBuilder[TypeSymbol](invokeParameters.Length)
            for parameter in invokeParameters {
                parameterTypes.Add(
                    MemberLookup.MapOpenSignatureWithoutDeclarationMerge(
                        PeelByRef(parameter.ParameterType),
                        receiverOpenDef,
                        receiverTypeArgs,
                        openMethod,
                        AsNullableElements(nonNullSymbolicMethodTypeArgs)
                    )
                )
            }
            let returnType = if invoke.ReturnType.IsSameAs(typeof(Void)) {
                TypeSymbol.Void
            } else {
                MemberLookup.MapOpenSignatureWithoutDeclarationMerge(
                    invoke.ReturnType,
                    receiverOpenDef,
                    receiverTypeArgs,
                    openMethod,
                    AsNullableElements(nonNullSymbolicMethodTypeArgs)
                )
            }
            let candidate = FunctionTypeSymbol.Get(parameterTypes.ToImmutable(), returnType)
            // Only override the erased target when the recovered shape actually
            // carries a type parameter or same-compilation user type; otherwise the
            // ordinary closed-CLR delegate target is already correct.
            let carries = TypeSymbol.RequiresSymbolicProjection(returnType) || parameterTypes.Any(
                TypeSymbol.RequiresSymbolicProjection
            )
            if !carries {
                return false
            }
            target = candidate
            return true
        }

        private func BuildDeferredArgumentNames(call CallExpressionSyntax, offset int32) IReadOnlyList[string?]? {
            var names[]?string? = nil
            for var sourceIndex = 0; sourceIndex < call.Arguments.Count; sourceIndex++ {
                if call.Arguments[sourceIndex] is not NamedArgumentExpressionSyntax named {
                    continue
                }
                names ??= [call.Arguments.Count + offset]string?
                names!![sourceIndex + offset] = named.NameToken.ValueText
            }
            return names
        }

        /// Issue #3659: narrows a deferred arrow-lambda probe's candidate set to the
        /// overloads whose deferred-lambda parameters can actually receive a lambda,
        /// i.e. are delegate-shaped (or `Expression<TDelegate>`-wrapped)
        /// with exactly the lambda's parameter count. Without this, an overload set
        /// whose other members take a non-delegate in the same slot (e.g.
        /// `List[T].Sort(IComparer[T])` alongside
        /// `List[T].Sort(Comparison[T])`) probes as ambiguous — the deferred
        /// slot is passed as `null`, which is applicable to everything — so the
        /// lambda never receives a target type and binds untargeted (GS0304), which
        /// in turn fails the whole call (GS0159).
        ///
        /// This is only a narrowing of the best-effort target-type probe; the
        /// call is re-resolved for real once every argument is bound. The filter
        /// declines (returning [`methods`](paramref) unchanged) whenever a
        /// candidate's slot shape cannot be determined — a bare generic-parameter
        /// slot, a non-lambda deferred argument, or a metadata load failure — so no
        /// existing overload-resolution behaviour is loosened.
        /// @param methods The probe's candidate methods.
        /// @param offset The probe's receiver parameter offset.
        /// @param ce The call being bound.
        /// @param deferredIndices The deferred arrow-lambda argument indices.
        /// @returns The narrowed candidates, or [`methods`](paramref) when no
        /// narrowing applies.
        private func FilterCandidatesByDeferredLambdaShape(
            methods IReadOnlyList[MethodInfo],
            offset int32,
            ce CallExpressionSyntax,
            deferredIndices List[int32]
        ) IReadOnlyList[MethodInfo] {
            let arities = [deferredIndices.Count]int32
            for var i = 0; i < deferredIndices.Count; i++ {
                let inner = OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[deferredIndices[i]])
                if inner is not LambdaExpressionSyntax lambda {
                    return methods
                }
                arities[i] = lambda.Parameters.Count
            }
            var filtered List[MethodInfo]? = nil
            for method in methods {
                if method == nil {
                    continue
                }
                var parameters[]ParameterInfo
                try {
                    parameters = method.GetParameters()
                } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                    return methods
                }
                var viable = true
                for var i = 0; i < deferredIndices.Count; i++ {
                    let paramIndex = MapSourceArgumentToParameter(parameters, ce, deferredIndices[i], offset)
                    if paramIndex < 0 || paramIndex >= parameters.Length {
                        viable = false
                        break
                    }
                    if !CanParameterReceiveLambdaOfArity(parameters[paramIndex], arities[i], out var determined) {
                        if !determined {
                            // The slot's shape is unknowable from metadata alone —
                            // decline to narrow rather than drop a viable candidate.
                            return methods
                        }
                        viable = false
                        break
                    }
                }
                if viable {
                    (
                        (
                            if filtered == nil {
                                (filtered = List[MethodInfo]())
                            } else {
                                filtered
                            }
                        )!!
                    ).Add(method)
                }
            }
            return filtered ?? methods
        }

        /// Issue #3659: decides whether [`parameter`](paramref) can receive an
        /// arrow lambda with [`arity`](paramref) parameters — that is, whether
        /// its type is a delegate (possibly wrapped in `Expression<T>`, or
        /// reached through the `params` array element type) whose
        /// `Invoke` takes exactly that many parameters.
        /// @param parameter The candidate parameter.
        /// @param arity The lambda's parameter count.
        /// @param determined Set to `false` when the shape
        /// cannot be decided from metadata (an open type-parameter slot or a
        /// metadata load failure), in which case the caller must not narrow.
        /// @returns `true` when the slot can receive the lambda.
        private func CanParameterReceiveLambdaOfArity(parameter ParameterInfo, arity int32, out determined bool) bool {
            determined = true
            // Issue #5543: a lambda is a plain value, so only an `in` slot passes it by reference.
            let parameterType = ConversionClassifier.GetPlainValueClrParameterType(parameter)
            if parameterType.IsGenericParameter {
                // A bare method/type parameter slot (e.g. `TDelegate`) says nothing
                // about the delegate shape it will close over.
                determined = false
                return false
            }
            try {
                if MatchesDelegateArity(parameterType, arity) {
                    return true
                }
                // A `params Func[...][]` slot receives the lambda through the array
                // element type in expanded form.
                return parameterType.IsArray && parameterType.GetElementType() is {} elementType &&
                    MatchesDelegateArity(elementType, arity)
            } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                determined = false
                return false
            }
        }

        /// Issue #3659: reports whether [`type`](paramref) is a delegate (or an
        /// `Expression<TDelegate>` wrapping one) whose `Invoke`
        /// signature takes exactly [`arity`](paramref) parameters.
        /// @param type The candidate slot type.
        /// @param arity The required parameter count.
        /// @returns `true` when the arity matches.
        private func MatchesDelegateArity(type Type, arity int32) bool {
            var delegateType = type
            if MemberLookup.TryGetExpressionTreeDelegateType(delegateType, out var unwrapped) {
                delegateType = unwrapped
            }
            let invoke MethodInfo? = delegateType?.GetMethodSafe("Invoke")
            return invoke != nil && invoke.GetParameters().Length == arity
        }

        private func MapSourceArgumentToParameter(
            parameters[]ParameterInfo,
            call CallExpressionSyntax,
            sourceIndex int32,
            offset int32
        ) int32 {
            if call.Arguments[sourceIndex] is NamedArgumentExpressionSyntax named {
                for var parameterIndex = 0; parameterIndex < parameters.Length; parameterIndex++ {
                    let parameterName string? = parameters[parameterIndex].Name
                    let argumentName = named.NameToken.ValueText
                    if parameterName != nil && OverloadResolver.ClrParameterNameMatches(
                        parameterName,
                        argumentName,
                        parameters.Select((parameter ParameterInfo) -> parameter.Name ?? string.Empty)
                    ) {
                        return parameterIndex
                    }
                }
                return -1
            }
            return sourceIndex + offset
        }

        /// Follow-up to issue #891: partial-inference fallback for (cref:ResolveDeferredArrowLambdaArguments).
        /// For each candidate generic method, infers the type parameters reachable
        /// from the non-lambda argument CLR types and resolves the closed parameter
        /// types of every deferred lambda's delegate (arity-matched to the lambda),
        /// even when the delegate's return type remains an un-inferred method type
        /// parameter. Builds a per-slot (cref:FunctionTypeSymbol) target that
        /// carries only the closed parameter types. Candidates must agree on the
        /// resulting parameter types; otherwise the fallback declines (preserving the
        /// existing GS0304 behaviour) to avoid binding against an ambiguous shape.
        ///
        /// Issue #3551: resolves the receiver's REIFIED closed CLR shape for
        /// deferred-lambda parameter inference. The cached (cref:TypeSymbol.ClrType)
        /// of a symbolic imported generic can carry an erased or stale closed
        /// shape (e.g. `IGrouping<string, ValueTuple<string, int>>` for the
        /// symbolic `IGrouping[string?, (string, int32?)]`, the tuple's Nullable
        /// element lost), and a lambda rebound against a target inferred from that
        /// shape disagrees with the receiver everywhere else, failing resolution
        /// (GS0159). Returns `null` when no better shape exists.
        /// @param receiverType The symbolic receiver type.
        /// @returns The reified closed CLR type, or `null`.
        private func ReifiedReceiverClrType(receiverType TypeSymbol?) Type? {
            if receiverType is ImportedTypeSymbol imported &&
                imported.OpenDefinition != nil &&
                !imported
                .TypeArguments
                .IsDefaultOrEmpty {
                let reified Type? = imported.ReifyClosedClrType()
                if reified != nil && !reified.ContainsGenericParameters {
                    return reified
                }
            }
            return nil
        }

        private func DeferredLambdaParameterTypesAgree(a Dictionary[int32, []Type], b Dictionary[int32, []Type]) bool {
            if a.Count != b.Count {
                return false
            }
            for kv in a {
                if !b.TryGetValue(kv.Key, out var other) || other.Length != kv.Value.Length {
                    return false
                }
                for var i = 0; i < kv.Value.Length; i++ {
                    if !ClrTypeUtilities.AreSame(kv.Value[i], other[i]) {
                        return false
                    }
                }
            }
            return true
        }

        private func SymbolicLambdaTargetsAgree(
            a Dictionary[int32, (DelegateType TypeSymbol, ParameterTypes ImmutableArray[TypeSymbol])],
            b Dictionary[int32, (DelegateType TypeSymbol, ParameterTypes ImmutableArray[TypeSymbol])]
        ) bool {
            if a.Count != b.Count {
                return false
            }
            for kv in a {
                if !b.TryGetValue(kv.Key, out var other) ||
                    !SameDelegateIdentity(kv.Value.DelegateType, other.DelegateType) ||
                    other
                    .ParameterTypes
                    .Length != kv
                    .Value
                    .ParameterTypes
                    .Length {
                    return false
                }
                for var i = 0; i < kv.Value.ParameterTypes.Length; i++ {
                    if !DeclarationBinder.TypeSignaturesEquivalent(
                        kv.Value.ParameterTypes[i],
                        other.ParameterTypes[i]
                    ) {
                        return false
                    }
                }
            }
            return true
        }

        /// Issue #903: returns `true` when every <em>method</em>
        /// generic parameter (declared on [`openMethod`](paramref)) reachable
        /// from [`openType`](paramref) has a non-`null` entry in
        /// [`inferred`](paramref) — i.e. it was actually resolved by unifying
        /// the receiver/arguments. Used to discard candidate methods whose delegate
        /// parameter shape contains a method type parameter that the call did not
        /// determine (e.g. a `Single` overload whose `this` parameter does
        /// not match the receiver), which would otherwise surface a bogus open
        /// parameter symbol via
        /// (cref:MemberLookup.MapOpenClrTypeToSymbolic(Type, Type, ImmutableArray{TypeSymbol}, MethodInfo,
        /// ImmutableArray{TypeSymbol})).
        private func AllMethodTypeParametersResolved(
            openType Type?,
            openMethod MethodInfo,
            inferred[]TypeSymbol?
        ) bool {
            if openType == nil {
                return false
            }
            try {
                if openType.IsGenericParameter {
                    // A type-level parameter (declared on the receiver type) is
                    // resolved through the receiver's TypeArguments, not the method
                    // type-arg vector, so it does not gate this candidate.
                    if openType.DeclaringMethod == nil {
                        return true
                    }
                    if !object.ReferenceEquals(openType.DeclaringMethod, openMethod) &&
                        openType.DeclaringMethod!!.MetadataToken != openMethod.MetadataToken {
                        return true
                    }
                    let pos = openType.GenericParameterPosition
                    return uint32(pos) < uint32(inferred.Length) && inferred[pos] != nil
                }
                if openType.IsByRef || openType.IsArray {
                    return AllMethodTypeParametersResolved(openType.GetElementType(), openMethod, inferred)
                }
                if openType.IsGenericType {
                    for arg in openType.GetGenericArguments() {
                        if !AllMethodTypeParametersResolved(arg, openMethod, inferred) {
                            return false
                        }
                    }
                }
                return true
            } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                return false
            }
        }

        /// Issue #977: detects whether the argument at [`index`](paramref) of an
        /// imported-method call is an inline `out var`/`out let`/`out _`
        /// declaration whose type is omitted (and therefore must be inferred from the
        /// resolved overload). An explicitly typed inline declaration is excluded
        /// because its local is already declared with a known type in the eager pass.
        /// @param ce The call expression syntax.
        /// @param index The source argument index.
        /// @param refArg The matched ref-argument syntax, when applicable.
        /// @returns `true` when the argument is a type-omitted inline out declaration.
        private func TryGetInlineOutVarArgument(
            ce CallExpressionSyntax,
            index int32,
            @NotNullWhen(true) out refArg RefArgumentExpressionSyntax?
        ) bool {
            refArg = nil
            if index < 0 || index >= ce.Arguments.Count {
                return false
            }
            if OverloadResolver.UnwrapNamedArgumentValue(
                ce.Arguments[index]
            ) is RefArgumentExpressionSyntax candidate &&
                candidate.IsInlineDeclaration &&
                candidate.DeclaredType == nil {
                refArg = candidate
                return true
            }
            return false
        }

        /// Issue #4350: the bound argument types in PARAMETER order, so a named call
        /// (`TryGetArray(segment: out var s, memory: m)`) recovers the same
        /// symbolic method type arguments as its positional spelling. A parameter
        /// with no source argument (an omitted default) contributes nothing.
        /// @param arguments The bound arguments in source order.
        /// @param parameterMapping The source-argument to parameter mapping; default for positional calls.
        /// @param parameterCount The resolved method's parameter count.
        /// @returns The argument types in parameter order.
        private func SymbolicArgumentTypesInParameterOrder(
            arguments ImmutableArray[BoundExpression],
            parameterMapping ImmutableArray[int32],
            parameterCount int32
        ) ImmutableArray[TypeSymbol] {
            if parameterMapping.IsDefault {
                return ImmutableArray.CreateRange(arguments.Select((a BoundExpression) -> a.Type))
            }
            let ordered = [parameterCount]TypeSymbol
            Array.Fill(ordered, TypeSymbol.Error)
            for var i = 0; i < arguments.Length && i < parameterMapping.Length; i++ {
                let parameterIndex = parameterMapping[i]
                if parameterIndex >= 0 &&
                    parameterIndex < parameterCount &&
                    ordered[parameterIndex] == TypeSymbol.Error {
                    ordered[parameterIndex] = arguments[i].Type
                }
            }
            return ImmutableArray.Create(ordered)
        }

        /// Issue #1599: recovers the pointee type of an `out`/`ref` parameter that
        /// is typed by one of the resolved generic method's own type parameters (e.g. the
        /// `out TEnum` of `Enum.TryParse<TEnum>(string, out TEnum)`) from the
        /// explicit type-argument symbols. When the method was closed over a value-type
        /// placeholder (or an (cref:object) erasure) — as happens for a
        /// same-compilation user value type under a `where T : struct` constraint — the
        /// closed CLR parameter carries the placeholder, which must not leak into an inline
        /// `out var` local. Returns `null` when no recovery applies so
        /// the caller falls back to the CLR pointee type.
        /// @param resolvedMethod The closed generic method selected by overload resolution.
        /// @param parameterIndex The zero-based parameter position of the out/ref argument.
        /// @param typeArgSymbols The explicit type-argument symbols, or default.
        /// @returns The recovered pointee type symbol, or `null`.
        private func ResolveMethodGenericParameterPointeeType(
            resolvedMethod MethodInfo,
            parameterIndex int32,
            typeArgSymbols ImmutableArray[TypeSymbol]
        ) TypeSymbol? {
            if !typeArgSymbols.IsDefaultOrEmpty && ClrOverloadResolution.TryGetGenericMethodParameterPosition(
                resolvedMethod,
                parameterIndex,
                out var position
            ) &&
                position >= 0 &&
                position < typeArgSymbols.Length {
                return typeArgSymbols[position]
            }
            return nil
        }

        private func ContainsNestedNullType(type TypeSymbol) bool {
            if type == TypeSymbol.Null {
                return true
            }
            for inner in TypeSymbol.GetWrappedTypes(type) {
                if ContainsNestedNullType(inner) {
                    return true
                }
            }
            return false
        }

        private func CanConvertToSymbolicReceiverTarget(source TypeSymbol, target TypeSymbol) bool {
            if Conversion.Classify(source, target).IsImplicit {
                return true
            }
            if source is not TupleTypeSymbol sourceTuple ||
                target is not TupleTypeSymbol targetTuple ||
                sourceTuple
                .ElementTypes
                .Length != targetTuple
                .ElementTypes
                .Length {
                return false
            }
            for var i = 0; i < sourceTuple.ElementTypes.Length; i++ {
                let sourceElement = sourceTuple.ElementTypes[i]
                let targetElement = targetTuple.ElementTypes[i]
                if sourceElement == TypeSymbol.Null {
                    if targetElement is NullableTypeSymbol || targetElement.ClrType is {IsValueType: false} {
                        continue
                    }
                    return false
                }
                if !Conversion.Classify(sourceElement, targetElement).IsImplicit {
                    return false
                }
            }
            return true
        }

        /// Renders a call receiver for the GS0159 "may be nil" message: its
        /// source text with whitespace collapsed, or its type when no syntax is
        /// in reach (for example, an intermediate in a chained call).
        /// @param receiver The bound receiver.
        /// @param receiverSyntax The receiver's syntax, when the caller has it.
        /// @param receiverStart The receiver text's start, when it differs from the syntax's.
        /// @returns The receiver description.
        private func DescribeCallReceiver(
            receiver BoundExpression,
            receiverSyntax SyntaxNode?,
            receiverStart int32?
        ) string {
            let syntax SyntaxNode? = receiverSyntax ?? receiver.Syntax
            if syntax == nil {
                return if receiver.Type is {} receiverType {
                    "a " + SymbolDisplay.ToTypeDisplayString(receiverType) + " value"
                } else {
                    "a nilable value"
                }
            }
            let text = syntax
                .SyntaxTree
                .Text
                .ToString(TextSpan.FromBounds(receiverStart ?? syntax.Span.Start, syntax.Span.End))
            return string.Join(" ", text.Split(default([]?char), StringSplitOptions.RemoveEmptyEntries))
        }
    }
}
