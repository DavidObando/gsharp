// <copyright file="DeclarationBinder.Constructors.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis

internal partial class DeclarationBinder {
    internal func ResolveRichAnonymousBaseConstructor(
        structSymbol StructSymbol,
        arguments ImmutableArray[BoundExpression],
        location TextLocation
    ) BaseConstructorInitializer? {
        let builder = arguments.ToBuilder()
        if structSymbol.ImportedBaseType?.ClrType is Type clrBase {
            return ResolveClrBaseConstructor(
                (_ int32) -> location,
                clrBase,
                structSymbol.ImportedBaseType,
                builder,
                location
            )
        }
        if structSymbol.BaseClass is {} baseClass {
            return ResolveGSharpBaseConstructor((_ int32) -> location, structSymbol.Name, baseClass, builder, location)
        }
        if !arguments.IsEmpty {
            Diagnostics.ReportBaseConstructorArgumentsWithoutBase(location)
        }
        return nil
    }

    /// Binds a class declaration's explicit `: Base(args)` initializer, or
    /// its implicit zero-argument base call when no `init` body owns that
    /// call. Resolution materializes omitted optional arguments, so the emitter
    /// calls the constructor that actually exists instead of inventing a
    /// parameterless MemberRef.
    private func BindBaseConstructorInitializer(
        syntax StructDeclarationSyntax,
        structSymbol StructSymbol,
        baseClassSymbol StructSymbol?,
        importedBaseType TypeSymbol?,
        primaryCtorParameters ImmutableArray[ParameterSymbol]
    ) {
        let hasPrimaryOnlyDataBase = baseClassSymbol?.IsData == true && baseClassSymbol!!.HasDeclaredPrimaryConstructor
        let hasImplicitBaseConstructorToResolve = importedBaseType != nil ||
            baseClassSymbol
            ?.EffectiveExplicitConstructors
            .IsDefaultOrEmpty == false ||
            hasPrimaryOnlyDataBase
        if !syntax.HasBaseConstructorArguments &&
            (
            (!hasImplicitBaseConstructorToResolve) ||
                (!syntax.Constructors.IsDefaultOrEmpty && !structSymbol.HasPrimaryConstructor)
        ) {
            return
        }
        // Issue #1085: defer the actual argument binding and base-constructor
        // resolution until all declared types' explicit constructors exist.
        let capturedScope = $scope
        let capturedUnsafeContext = binderCtx.InUnsafeContext
        pendingBaseInitializerBindings.Add(
            () -> {
                using let unsafeContext = binderCtx.PushUnsafeContext(capturedUnsafeContext)
                let outerScope = $scope
                $scope = capturedScope
                // Issue #2342: re-establish this type's OWN owning package as the
                // ambient lookup preference (see field-initializer closure above
                // for the full rationale) for the duration of this deferred bind.
                let savedPackage = $scope.SetCurrentDeclaringPackage(structSymbol.PackageName)
                let savedTree = $scope.SetCurrentReferencingSyntaxTree(syntax.SyntaxTree)
                try {
                    if syntax.HasBaseConstructorArguments {
                        BindBaseConstructorInitializerCore(
                            syntax,
                            structSymbol,
                            baseClassSymbol,
                            importedBaseType,
                            primaryCtorParameters
                        )
                    } else {
                        BindImplicitBaseConstructorInitializer(syntax, structSymbol, baseClassSymbol, importedBaseType)
                    }
                } finally {
                    $scope.SetCurrentDeclaringPackage(savedPackage)
                    $scope.SetCurrentReferencingSyntaxTree(savedTree)
                    $scope = outerScope
                }
            }
        )
    }

    private func BindImplicitBaseConstructorInitializer(
        syntax StructDeclarationSyntax,
        structSymbol StructSymbol,
        baseClassSymbol StructSymbol?,
        importedBaseType TypeSymbol?
    ) {
        let location = syntax.Identifier?.Location ?? syntax.Location
        let arguments = ImmutableArray.CreateBuilder[BoundExpression]()
        var initializer BaseConstructorInitializer?
        if importedBaseType?.ClrType is Type clrBase {
            initializer = ResolveClrBaseConstructor(
                (_ int32) -> location,
                clrBase,
                importedBaseType,
                arguments,
                location
            )
        } else if baseClassSymbol != nil &&
            (
            baseClassSymbol
                .EffectiveExplicitConstructors
                .IsDefaultOrEmpty == false ||
                (baseClassSymbol.IsData && baseClassSymbol.HasDeclaredPrimaryConstructor)
        ) {
            initializer = ResolveGSharpBaseConstructor(
                (_ int32) -> location,
                structSymbol.Name,
                baseClassSymbol,
                arguments,
                location
            )
        } else {
            return
        }
        if initializer != nil && initializer.Arguments.IsEmpty == false {
            structSymbol.SetBaseConstructorInitializer(initializer)
        }
    }

    private func BindBaseConstructorInitializerCore(
        syntax StructDeclarationSyntax,
        structSymbol StructSymbol,
        baseClassSymbol StructSymbol?,
        importedBaseType TypeSymbol?,
        primaryCtorParameters ImmutableArray[ParameterSymbol]
    ) {
        let location = Invariant.Required(
            syntax.BaseConstructorOpenParenthesisToken,
            "a base-constructor argument list has an opening parenthesis",
            expression: "syntax.BaseConstructorOpenParenthesisToken"
        )
            .Location
        if baseClassSymbol == nil && importedBaseType == nil {
            Diagnostics.ReportBaseConstructorArgumentsWithoutBase(location)
            return
        }
        // Bind the argument expressions with the primary-constructor parameters
        // in scope (they are the typical source of forwarded values). Issue
        // #1194: also expose the enclosing type's static members (consts, static
        // fields/properties, static methods) and — because this runs after all
        // top-level functions are declared — free functions, so a `: base(...)`
        // argument can reference them unqualified (matching C#).
        let savedScope = $scope
        let savedTypeParameters = binderCtx.CurrentTypeParameters
        if !structSymbol.TypeParameters.IsDefaultOrEmpty {
            this.binderCtx.CurrentTypeParameters = Dictionary[string, TypeParameterSymbol]()
            for tp in structSymbol.TypeParameters {
                binderCtx.CurrentTypeParameters!![tp.Name] = tp
            }
        }
        var boundArguments ImmutableArray[BoundExpression].Builder
        var clrInit BaseConstructorInitializer? = nil
        var gsharpInit BaseConstructorInitializer? = nil
        let savedFunction = getCurrentFunction()
        setCurrentFunction(CreateFieldInitializerAccessibilityContext(structSymbol))
        try {
            {
                using let _ = PushStaticMemberScope(structSymbol)
                let staticScope = $scope
                $scope = BoundScope(staticScope)
                if !primaryCtorParameters.IsDefaultOrEmpty {
                    for p in primaryCtorParameters {
                        $scope.TryDeclareVariable(p)
                    }
                }
                let baseArguments = syntax.BaseConstructorArguments ??
                    throw InvalidOperationException(
                    "Invariant violated: a base-constructor argument list has an opening parenthesis."
                )
                boundArguments = ImmutableArray.CreateBuilder[BoundExpression](baseArguments.Count)
                for var i = 0; i < baseArguments.Count; i++ {
                    boundArguments.Add(BindConstructorInitializerArgument(baseArguments[i]))
                }
                // Issue #1812: resolve (and, when needed, interpolation-rebind)
                // while the primary-ctor-parameter scope set up above is still
                // active — this must happen before the `using` block below tears
                // the parameter scope back down (`PushStaticMemberScope`'s
                // `Dispose` hard-resets `binderCtx.RootScope`, discarding the
                // child scope created above regardless of any assignment here).
                // See the matching comment in BindConstructorBaseInitializerCore.
                let argumentLocation(int32) -> TextLocation = (i int32) -> baseArguments[i].Location
                let argumentSyntax(int32) -> ExpressionSyntax = (i int32) -> baseArguments[i]
                if importedBaseType?.ClrType is Type clrBase {
                    clrInit = ResolveClrBaseConstructor(
                        argumentLocation,
                        clrBase,
                        importedBaseType,
                        boundArguments,
                        location,
                        argumentSyntax
                    )
                } else {
                    gsharpInit = ResolveGSharpBaseConstructor(
                        argumentLocation,
                        structSymbol.Name,
                        Invariant.Required(
                            baseClassSymbol,
                            "a non-CLR base constructor has a declared GSharp base class",
                            expression: "baseClassSymbol"
                        ),
                        boundArguments,
                        location
                    )
                }
                ReportProtectedReceiverAccess(clrInit ?? gsharpInit)
                $scope = staticScope
            }
        } finally {
            setCurrentFunction(savedFunction)
        }
        if clrInit != nil {
            structSymbol.SetBaseConstructorInitializer(clrInit)
        } else if gsharpInit != nil {
            structSymbol.SetBaseConstructorInitializer(gsharpInit)
        }
        $scope = savedScope
        this.binderCtx.CurrentTypeParameters = savedTypeParameters
    }

    /// Resolves a base-constructor initializer against an imported CLR base type's constructors (issue
    /// #306). Returns `null` (after reporting a diagnostic) when no accessible constructor matches.
    private func ResolveClrBaseConstructor(
        argLocation(int32) -> TextLocation,
        clrBase Type,
        importedBaseType TypeSymbol?,
        boundArguments ImmutableArray[BoundExpression].Builder,
        location TextLocation,
        argSyntax((int32) -> ExpressionSyntax)? = nil
    ) BaseConstructorInitializer? {
        let visibleConstructors = List[ConstructorInfo]()
        for constructor in ClrTypeUtilities.SafeGetConstructors(
            clrBase,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
        ) {
            if constructor.IsPublic || constructor.IsFamily || constructor.IsFamilyOrAssembly {
                visibleConstructors.Add(constructor)
            }
        }
        let ctors = visibleConstructors.ToArray()
        RebindDeferredArgumentsWithCommonClrTargets(ctors, boundArguments)
        let argTypes = [boundArguments.Count]Type?
        var argsAllTyped = true
        for var i = 0; i < boundArguments.Count; i++ {
            // Issue #530 / #3984: use the OVERLOAD-RESOLUTION projection (see
            // the instance-method path) so an argument with no CLR backing of
            // its own — `[]T`, `map[K, V]`, `chan[T]`, a symbolic tuple, a
            // same-compilation user type — still ranks on its erased shape
            // instead of abandoning resolution here.
            // Issue #533: allow null (nil literal) through.
            let t Type? = getEffectiveArgumentClrTypeForOverloadResolution(boundArguments[i].Type)
            if t == nil && boundArguments[i].Type != TypeSymbol.Null {
                argsAllTyped = false
                break
            }
            argTypes[i] = t
        }
        var bestCtor ConstructorInfo? = nil
        var isExpanded = false
        if argsAllTyped {
            // Issue #1812: a `: base($"...")` argument to an imported CLR base
            // constructor is convertible to an IFormattable/FormattableString
            // (or interpolated-string-handler) parameter just like any other
            // CLR call site, so mark which positional arguments are
            // interpolated-string literals (base-ctor arguments are always
            // positional, never named).
            let interpolatedStringArgs = ComputeInterpolatedStringArgFlags(argSyntax, boundArguments.Count)
            let resolution = ClrOverloadResolution.Resolve[ConstructorInfo](
                ctors,
                argTypes,
                interpolatedStringArgs: interpolatedStringArgs,
                constantNarrowingArgumentCheck: ExpressionBinder.MakeConstantNarrowingArgumentCheck(boundArguments),
                structuralProjectionArgumentCheck: ExpressionBinder.MakeStructuralProjectionArgumentCheck(
                    boundArguments,
                    nativeConversions: conversions
                ),
                erasedArgumentMismatchCheck: ExpressionBinder.MakeErasedArgumentMismatchCheck(boundArguments),
                delegateRefKindArgumentCheck: ExpressionBinder.MakeDelegateRefKindArgumentCheck(boundArguments)
            )
            switch resolution.Outcome {
                case ClrOverloadResolution.ResolutionOutcome.Resolved {
                    bestCtor = resolution.Best as ConstructorInfo
                    isExpanded = resolution.IsExpanded
                }
                case ClrOverloadResolution.ResolutionOutcome.Ambiguous {
                    Diagnostics.ReportAmbiguousOverload(
                        location,
                        clrBase.Name,
                        resolution.Ambiguous.Length,
                        resolution.Ambiguous.Select(ClrOverloadResolution.FormatMethodSignature)
                    )
                    return nil
                }
                default { }
            }
        }
        if bestCtor == nil {
            // Issue #3984: GS0214 says the base declares no accessible
            // constructor of this ARITY. Say that only when it is true. Once
            // resolution has actually run (`argsAllTyped`), a base that does
            // declare a constructor callable with this many arguments failed
            // on applicability, not on arity — which is the same situation the
            // ordinary imported-constructor probe reports as GS0267, so the
            // two positions now name the same problem the same way.
            if argsAllTyped && ctors.Any((ctor ConstructorInfo) -> AcceptsArgumentCount(ctor, boundArguments.Count)) {
                Diagnostics.ReportNoApplicableOverload(location, clrBase.Name)
            } else {
                Diagnostics.ReportNoMatchingBaseConstructor(location, clrBase.Name, boundArguments.Count)
            }
            return nil
        }
        // Issue #1812: mirror RebindFormattableInterpolationArguments (the
        // step every ExpressionBinder CLR-call path runs) — now that overload
        // resolution has selected `bestCtor`, re-lower each interpolated-string
        // `: base(...)` argument whose chosen parameter is
        // IFormattable/FormattableString-shaped to
        // FormattableStringFactory.Create(...). Base-ctor arguments are always
        // positional (no named-argument mapping), so parameter index == argument
        // index. A no-op (and safe) when the caller has no
        // bindInterpolatedStringAsFormattable delegate wired or no argSyntax was
        // supplied.
        if argSyntax != nil && bindInterpolatedStringAsFormattable != nil {
            let bestCtorParams = bestCtor.GetParameters()
            let limit = Math.Min(boundArguments.Count, bestCtorParams.Length)
            for var i = 0; i < limit; i++ {
                if argSyntax(i) is InterpolatedStringExpressionSyntax interpolated &&
                    ClrOverloadResolution
                    .IsFormattableStringTarget(bestCtorParams[i].ParameterType) {
                    boundArguments[i] = bindInterpolatedStringAsFormattable!!(interpolated, nil)
                }
            }
        }
        // Issue #3984: the open definition's constructor is where the parameter
        // types still mention the base's own generic parameters; `clrBase` has
        // already erased them.
        let openBaseDefinition = if clrBase.IsConstructedGenericType {
            clrBase.GetGenericTypeDefinition()
        } else {
            default(Type?)
        }
        let openBaseCtorParams = TryGetOpenBaseConstructorParameters(openBaseDefinition, bestCtor)
        let baseTypeArguments = if importedBaseType is ImportedTypeSymbol importedBase {
            importedBase.TypeArguments
        } else {
            default(ImmutableArray[TypeSymbol])
        }
        // Issue #306 (item 2): honor `ref`/`out`/`in` base-constructor parameters.
        // For a by-ref parameter the bound argument must already be an address-of
        // expression (`&x`); the emitter forwards the address rather than a value.
        let ctorParams = bestCtor.GetParameters()
        // Issue #506 follow-up: when overload resolution selected the expanded
        // form of a `params T[]` base ctor (e.g. `init() : base(1, 2, 3, 4)`
        // flowing into a C# `Base(int x, params int[] tail)`), pack the trailing
        // positional arguments into a synthesised slice/array first. The fixed
        // leading parameters and the synthesised array slot then go through the
        // same per-parameter ref/conversion loop as the normal-form path.
        let suppliedArgumentCount = boundArguments.Count
        var orderedArgs ImmutableArray[BoundExpression]
        if isExpanded {
            let paramsIndex = ctorParams.Length - 1
            let paramArrayType = ctorParams[paramsIndex].ParameterType
            let elementClrType Type? = paramArrayType.GetElementType()
            // Issue #3984 (review): the packed array is what the emitter pushes
            // at the base call, so it has to be built over the SYMBOLIC element
            // — `params T[]` on a `Base[T]` is `!T0[]`, not the erased
            // `object[]` the constructed type reports. Building the erased one
            // boxed each element and handed an `object[]` to a MemberRef whose
            // signature says `T0[]`, which ILVerify rejects.
            let symbolicParamsSlice SliceTypeSymbol? = TryProjectSymbolicBaseParameterType(
                openBaseCtorParams,
                openBaseDefinition,
                baseTypeArguments,
                paramsIndex
            ) as SliceTypeSymbol
            // The packed array's element, read through the funnel and taken
            // bare: the emitter pushes an array of the erased element shape.
            let elementTypeSymbol = symbolicParamsSlice?.ElementType ??
                (
                if elementClrType == nil {
                    TypeSymbol.Object
                } else {
                    ReadParamsElementShape(ctorParams[paramsIndex])
                }
            )
            let sliceType = symbolicParamsSlice ?? SliceTypeSymbol.Get(elementTypeSymbol)
            let tailCount = boundArguments.Count - paramsIndex
            let packed = ImmutableArray.CreateBuilder[BoundExpression](tailCount)
            for var j = 0; j < tailCount; j++ {
                let srcIndex = paramsIndex + j
                var element = boundArguments[srcIndex]
                if conversions.TryRejectClrPlatformContainerArgument(
                    element,
                    ctorParams[paramsIndex],
                    elementTypeSymbol,
                    argLocation(srcIndex),
                    out var rejectedElement
                ) {
                    element = rejectedElement
                } else if element.Type != nil && element.Type != TypeSymbol.Error && element.Type != elementTypeSymbol {
                    if Conversion.Classify(element.Type, elementTypeSymbol).Exists {
                        element = conversions.BindConversion(
                            argLocation(srcIndex),
                            element,
                            elementTypeSymbol,
                            allowExplicit: true
                        )
                    } else if conversions.TryApplyUserDefinedImplicitArgumentConversion(
                        element,
                        elementTypeSymbol,
                        out var udc
                    ) {
                        element = udc
                    }
                }
                packed.Add(element)
            }
            let arrayExpr = BoundArrayCreationExpression(syntax: nil, sliceType, packed.MoveToImmutable())
            let expandedBuilder = ImmutableArray.CreateBuilder[BoundExpression](ctorParams.Length)
            for var i = 0; i < paramsIndex; i++ {
                expandedBuilder.Add(boundArguments[i])
            }
            expandedBuilder.Add(arrayExpr)
            orderedArgs = expandedBuilder.MoveToImmutable()
        } else {
            // Issue #3984 (review): a constructor selected with OMITTED optional
            // parameters supplies fewer arguments than it has parameters, and
            // the per-parameter loop below walks the parameters. Materialize the
            // omitted defaults first — the same step every ordinary CLR call
            // site runs — or the loop indexes past the supplied arguments and
            // the compiler crashes with an IndexOutOfRangeException. Before this
            // fix the case was unreachable from an erased argument only because
            // resolution never ran at all.
            orderedArgs = ConversionClassifier.AppendOmittedOptionalArguments(boundArguments.ToImmutable(), ctorParams)
        }
        let refKindsBuilder = ImmutableArray.CreateBuilder[RefKind](ctorParams.Length)
        let convertedArgs = ImmutableArray.CreateBuilder[BoundExpression](ctorParams.Length)
        for var i = 0; i < ctorParams.Length; i++ {
            let clrParamType = ctorParams[i].ParameterType
            if clrParamType.IsByRef {
                let refKind = if ctorParams[i].IsOut {
                    RefKind.Out
                } else {
                    (
                        if ctorParams[i].IsIn {
                            RefKind.In
                        } else {
                            RefKind.Ref
                        }
                    )
                }
                refKindsBuilder.Add(refKind)
                // Issue #4400: a plain argument at an imported `in` base
                // constructor parameter is passed by readonly reference.
                // For a generic base (`Base<T>(in T)`) the pointee is projected
                // through the base's own type arguments exactly as the by-value
                // branch below projects its target (#3984); the erased closed
                // `object&` is not what the emitted `.ctor(!0&)` takes.
                if ConversionClassifier.IsImplicitInClrArgument(orderedArgs[i], ctorParams[i]) {
                    let inPointee = TryProjectSymbolicBaseInPointeeType(
                        openBaseCtorParams,
                        openBaseDefinition,
                        baseTypeArguments,
                        i
                    ) ??
                        ConversionClassifier
                        .GetImplicitInClrPointeeType(
                        ctorParams[i],
                        i,
                        method: nil,
                        receiverType: nil,
                        symbolicMethodTypeArgs: default(ImmutableArray[TypeSymbol?])
                    )
                    let inLocation = argLocation(i)
                    convertedArgs.Add(
                        (
                            if conversions.TryRejectClrPlatformContainerArgument(
                                orderedArgs[i],
                                ctorParams[i],
                                inPointee,
                                inLocation,
                                out var rejectedArgument
                            ) {
                                rejectedArgument
                            } else {
                                conversions.BindImplicitInArgument(
                                    inLocation,
                                    orderedArgs[i],
                                    inPointee,
                                    parameter: nil
                                )
                            }
                        )
                    )
                    continue
                }
                // A by-ref argument is forwarded as-is (it is already a managed
                // pointer, e.g. the result of `&x`); no value conversion applies.
                convertedArgs.Add(orderedArgs[i])
                continue
            }
            refKindsBuilder.Add(RefKind.None)
            var targetType = ClrNullability.GetParameterTypeSymbol(ctorParams[i])
            // Issue #3984: for a GENERIC base the erased CLR parameter type
            // above is not what the emitter writes. `List[T]`'s CLR shape is
            // `List<object>`, so `ctorParams[i].ParameterType` is
            // `IEnumerable<object>` — but the base-constructor MemberRef is
            // parented at the SYMBOLIC TypeSpec, and its signature reads
            // `IEnumerable<!T0>`. Converting to the erased shape therefore
            // targets a type the call does not have: for an argument with no
            // CLR identity (`[]T`) `Conversion` has no rule at all and the
            // whole initializer failed, and for one that does
            // (`[]string`, `(int32, object)`) it silently succeeded and left
            // ILVerify's StackUnexpected in the emitted constructor. Recover
            // the symbolic parameter by substituting the base's own type
            // arguments into the OPEN definition's constructor — the same
            // projection `ConversionClassifier.TrySubstituteParameterTypeFrom
            // Receiver` applies to an imported instance call's parameters.
            var orderedArg = orderedArgs[i]
            let symbolicTarget TypeSymbol? = TryProjectSymbolicBaseParameterType(
                openBaseCtorParams,
                openBaseDefinition,
                baseTypeArguments,
                i
            )
            if symbolicTarget != nil {
                targetType = symbolicTarget
            }
            // The synthesised params array and any materialised optional default
            // have no source argument of their own, so they report at the call.
            let argLoc = if (isExpanded && i == ctorParams.Length - 1) || i >= suppliedArgumentCount {
                location
            } else {
                argLocation(i)
            }
            // Issue #3984 (review follow-up): an omitted optional is
            // materialised from the parameter's ERASED CLR type, so
            // `T fallback = default` on a `Base[T]` arrives as
            // `default(object)` and meets a symbolic `T` slot it cannot
            // convert to. Re-materialise it at the recovered target instead —
            // the same recovery #1471 applies to an explicit `default`
            // argument, and the reason it matters is identical: `default(T)`
            // must reify over the real slot rather than lower to `ldnull`.
            if symbolicTarget != nil && i >= suppliedArgumentCount && orderedArg is BoundDefaultExpression {
                orderedArg = BoundDefaultExpression(orderedArg.Syntax, symbolicTarget)
            }
            if conversions.TryRejectClrPlatformContainerArgument(
                orderedArg,
                ctorParams[i],
                targetType,
                argLoc,
                out var rejectedValueArgument
            ) {
                convertedArgs.Add(rejectedValueArgument)
                continue
            }
            // Issue #506 follow-up: when the synthesised params array already
            // carries the exact CLR type of the parameter (SliceTypeSymbol(T)
            // → T[]), skip the rebinding so the emitter sees the original
            // array-creation expression without an extra conversion wrapper.
            if symbolicTarget == nil && orderedArg.Type?.ClrType != nil && orderedArg.Type.ClrType == clrParamType {
                convertedArgs.Add(orderedArg)
            } else if orderedArg.Type == targetType {
                convertedArgs.Add(orderedArg)
            } else {
                convertedArgs.Add(conversions.BindConversion(argLoc, orderedArg, targetType))
            }
        }
        return BaseConstructorInitializer(convertedArgs.ToImmutable(), bestCtor, refKindsBuilder.ToImmutable())
    }

    private func BindConstructorInitializerArgument(syntax ExpressionSyntax) BoundExpression {
        if ExpressionBinder.IsTargetDependentBlockArgumentSyntax(syntax) {
            return BoundErrorExpression(syntax)
        }
        if !ExpressionBinder.IsTargetTypedBranchyArgumentSyntax(syntax) {
            return bindExpression(syntax)
        }
        let previous = binderCtx.DeferTargetlessConditional
        this.binderCtx.DeferTargetlessConditional = true
        try {
            return bindExpression(syntax)
        } finally {
            this.binderCtx.DeferTargetlessConditional = previous
        }
    }

    /// Issue #4453: a `: base(...)` argument is code of the
    /// constructor's class but is bound outside its body, so the
    /// protected-receiver pass runs over the resolved initializer's final
    /// arguments, after constructor resolution has rebound any deferred
    /// (target-dependent) argument. Primary and explicit constructors both
    /// call this.
    /// @param initializer The resolved base-constructor initializer, if resolution succeeded.
    private func ReportProtectedReceiverAccess(initializer BaseConstructorInitializer?) {
        if initializer == nil {
            return
        }
        for argument in initializer.Arguments {
            ProtectedReceiverDiagnostics.Report(argument, getCurrentFunction(), Diagnostics)
        }
    }

    private func RebindDeferredArgumentsWithCommonClrTargets(
        constructors[]ConstructorInfo,
        boundArguments ImmutableArray[BoundExpression].Builder
    ) {
        let deferred = List[int32]()
        for var i = 0; i < boundArguments.Count; i++ {
            if ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(boundArguments[i], out _) {
                deferred.Add(i)
            }
        }
        if deferred.Count == 0 {
            return
        }
        let deferredSet = HashSet[int32](deferred)
        let applicabilityArgumentTypes = [boundArguments.Count]Type?
        for var i = 0; i < boundArguments.Count; i++ {
            if deferredSet.Contains(i) {
                applicabilityArgumentTypes[i] = ClrOverloadResolution.DefaultLiteralArgumentType
                continue
            }
            let argumentType Type? = getEffectiveArgumentClrTypeForOverloadResolution(boundArguments[i].Type)
            if argumentType == nil && boundArguments[i].Type != TypeSymbol.Null {
                return
            }
            applicabilityArgumentTypes[i] = argumentType
        }
        let delegateRefKindCheck = ExpressionBinder.MakeDelegateRefKindArgumentCheck(boundArguments)
        let compatible = List[(Constructor ConstructorInfo, Parameters[]ParameterInfo)]()
        for constructor in constructors {
            let parameters = constructor.GetParameters()
            if parameters.Length != boundArguments.Count {
                continue
            }
            var deferredTargetsMatch = true
            for index in deferred {
                var targetClrType = parameters[index].ParameterType
                if targetClrType.IsByRef {
                    targetClrType = targetClrType.GetElementType() ?? targetClrType
                }
                if !ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(boundArguments[index], out var syntax) ||
                    !ExpressionBinder
                    .CanTargetDependentBlockArgument(
                    syntax!!,
                    ClrNullability.GetParameterTypeSymbol(parameters[index])
                ) {
                    deferredTargetsMatch = false
                    break
                }
            }
            if !deferredTargetsMatch {
                continue
            }
            let refKindCheck(int32, Type) -> bool? = (index int32, targetType Type) -> if deferredSet.Contains(index) {
                true
            } else {
                delegateRefKindCheck?(index, targetType)
            }
            let resolution = ClrOverloadResolution.Resolve[ConstructorInfo](
                []ConstructorInfo{constructor},
                applicabilityArgumentTypes,
                constantNarrowingArgumentCheck: ExpressionBinder.MakeConstantNarrowingArgumentCheck(boundArguments),
                structuralProjectionArgumentCheck: ExpressionBinder.MakeStructuralProjectionArgumentCheck(
                    boundArguments,
                    nativeConversions: conversions
                ),
                erasedArgumentMismatchCheck: ExpressionBinder.MakeErasedArgumentMismatchCheck(boundArguments),
                delegateRefKindArgumentCheck: refKindCheck
            )
            if resolution.Outcome == ClrOverloadResolution.ResolutionOutcome.Resolved {
                compatible.Add((constructor, parameters))
            }
        }
        for index in deferred {
            var commonTargetType Type? = nil
            var commonTargetParameter ParameterInfo? = nil
            var targetsDisagree = false
            for candidate in compatible {
                var candidateTargetType = candidate.Parameters[index].ParameterType
                if candidateTargetType.IsByRef {
                    candidateTargetType = candidateTargetType.GetElementType() ?? candidateTargetType
                }
                if commonTargetType == nil {
                    commonTargetType = candidateTargetType
                    commonTargetParameter = candidate.Parameters[index]
                } else if !ClrTypeUtilities.AreSame(commonTargetType, candidateTargetType) {
                    targetsDisagree = true
                    break
                }
            }
            if commonTargetParameter == nil || targetsDisagree {
                continue
            }
            let targetType = ClrNullability.GetParameterTypeSymbol(commonTargetParameter)
            boundArguments[index] = conversions.BindConversion(
                boundArguments[index].Syntax?.Location ?? default(TextLocation),
                boundArguments[index],
                targetType
            )
        }
    }

    /// Resolves a base-constructor initializer against a GSharp base class's constructors (issue #306).
    /// Returns `null` (after reporting a diagnostic) when no match.
    private func ResolveGSharpBaseConstructor(
        argLocation(int32) -> TextLocation,
        derivedNameForDiag string,
        baseClassSymbol StructSymbol?,
        boundArguments ImmutableArray[BoundExpression].Builder,
        location TextLocation
    ) BaseConstructorInitializer? {
        if baseClassSymbol == nil {
            Diagnostics.ReportNoMatchingBaseConstructor(location, derivedNameForDiag, boundArguments.Count)
            return nil
        }
        // Issue #1060: when the base class declares explicit `init(...)`
        // constructors, the `: base(args)` initializer must resolve against the
        // full overload set — every explicit init plus (when present) the
        // synthesized primary-constructor designated init — selecting the best
        // overload by argument types, mirroring C# where a derived constructor
        // may chain to any accessible base constructor. The primary-only fast
        // path below covers classes that declare no explicit init bodies.
        // Issue #1087: a constructed generic base (e.g. `Base[int32]`) does not
        // carry its own explicit-constructor table — consult the open
        // definition's via EffectiveExplicitConstructors.
        if !baseClassSymbol.EffectiveExplicitConstructors.IsDefaultOrEmpty {
            return ResolveGSharpExplicitBaseConstructor(argLocation, baseClassSymbol, boundArguments, location)
        }
        let baseParams = baseClassSymbol.PrimaryConstructorParameters
        var requiredCount = baseParams.Length
        while requiredCount > 0 && baseParams[requiredCount - 1].HasExplicitDefaultValue {
            requiredCount--
        }
        if boundArguments.Count < requiredCount || boundArguments.Count > baseParams.Length {
            Diagnostics.ReportNoMatchingBaseConstructor(location, baseClassSymbol.Name, boundArguments.Count)
            return nil
        }
        let convertedArgs = ImmutableArray.CreateBuilder[BoundExpression](baseParams.Length)
        for var i = 0; i < baseParams.Length; i++ {
            let parameter = baseParams[i]
            if i >= boundArguments.Count {
                convertedArgs.Add(CreateProjectedOptionalUserDefaultArgument(parameter, parameter.Type))
                continue
            }
            var argument = boundArguments[i]
            if ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(argument, out _) {
                argument = conversions.BindConversion(argLocation(i), argument, parameter.Type)
                boundArguments[i] = argument
            }
            if parameter.RefKind != RefKind.None && !IsImplicitInArgument(parameter, argument) {
                if !TryGetAddressedArgumentType(argument, out var addressedType) || addressedType != parameter.Type {
                    Diagnostics.ReportNoMatchingBaseConstructor(location, baseClassSymbol.Name, boundArguments.Count)
                    return nil
                }
                convertedArgs.Add(argument)
                continue
            }
            // Issue #3907: an `@AllowNull` base-constructor parameter declares
            // that it accepts a nil-carrying input.
            if ConversionClassifier.AcceptsNilAnnotatedArgument(parameter, argument.Type, parameter.Type) {
                convertedArgs.Add(
                    if parameter.RefKind == RefKind.In {
                        conversions.CreateImplicitInReference(argument, parameter.Type)
                    } else {
                        argument
                    }
                )
                continue
            }
            if argument.Type != parameter.Type && !Conversion.Classify(argument.Type, parameter.Type)
                .IsImplicit &&
                !ExpressionBinder
                .IsImplicitConstantNarrowingArgument(argument, parameter.Type) {
                if argument.Type != TypeSymbol.Error {
                    Diagnostics.ReportNoMatchingBaseConstructor(location, baseClassSymbol.Name, boundArguments.Count)
                }
                return nil
            }
            convertedArgs.Add(
                if parameter.RefKind == RefKind.In {
                    conversions.BindImplicitInArgument(argLocation(i), argument, parameter.Type, parameter)
                } else {
                    conversions.BindConversion(argLocation(i), argument, parameter.Type)
                }
            )
        }
        return BaseConstructorInitializer(convertedArgs.ToImmutable(), baseClassSymbol)
    }

    /// Issue #1060: resolves a `: base(args)` initializer against the explicit
    /// `init(...)` constructors declared on a GSharp base class (which already
    /// includes the synthesized primary-constructor designated init when present),
    /// selecting the best overload by argument types. Returns `null` (after
    /// reporting a diagnostic) when no accessible base constructor matches.
    private func ResolveGSharpExplicitBaseConstructor(
        argLocation(int32) -> TextLocation,
        baseClassSymbol StructSymbol,
        boundArguments ImmutableArray[BoundExpression].Builder,
        location TextLocation
    ) BaseConstructorInitializer? {
        let candidates = ImmutableArray.CreateBuilder[ConstructorSymbol]()
        var anyArgIsError = false
        for arg in boundArguments {
            if arg.Type == TypeSymbol.Error {
                anyArgIsError = true
            }
        }
        // Issue #1087: iterate the effective explicit-constructor set (the open
        // definition's, for a constructed generic base) and compare against each
        // candidate's type-argument-substituted parameter signature so that a
        // generic base ctor such as `init(a T)` matches `: base(value)` on a
        // constructed `Base[int32]`.
        for candidate in baseClassSymbol.EffectiveExplicitConstructors {
            let paramTypes = baseClassSymbol.GetConstructorParameterTypesForConstruction(candidate)
            var requiredCount = candidate.Parameters.Length
            while requiredCount > 0 && candidate.Parameters[requiredCount - 1].HasExplicitDefaultValue {
                requiredCount--
            }
            if boundArguments.Count < requiredCount || boundArguments.Count > paramTypes.Length {
                continue
            }
            var applicable = true
            for var i = 0; i < boundArguments.Count; i++ {
                let argType = boundArguments[i].Type
                let paramType = paramTypes[i]
                let parameter = candidate.Parameters[i]
                // Issue #4400: a plain argument at an `in` parameter is
                // applicable like a by-value one (it is passed by implicit
                // readonly reference after the ordinary conversion).
                if parameter.RefKind != RefKind.None && !IsImplicitInArgument(parameter, boundArguments[i]) {
                    if !TryGetAddressedArgumentType(boundArguments[i], out var addressedType) ||
                        addressedType != paramType {
                        applicable = false
                        break
                    }
                    continue
                }
                if (
                    boundArguments[i] is BoundAddressOfExpression and
                        {IsUnmanaged: false} or
                        BoundConditionalAddressExpression
                ) {
                    applicable = false
                    break
                }
                if argType == paramType {
                    continue
                }
                // Error-typed arguments don't disqualify a candidate: a prior
                // diagnostic already explains the bad argument.
                if argType == TypeSymbol.Error {
                    if ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(
                        boundArguments[i],
                        out var deferredSyntax
                    ) &&
                        !ExpressionBinder.CanTargetDependentBlockArgument(deferredSyntax!!, paramType) {
                        applicable = false
                        break
                    }
                    continue
                }
                // Issue #1307: a constant integer argument that fits a narrower /
                // cross-sign integer parameter is implicitly convertible there
                // (C# §10.2.11, issue #1281), so it must not disqualify the
                // candidate even though the lattice conversion is not implicit.
                if ExpressionBinder.IsImplicitConstantNarrowingArgument(boundArguments[i], paramType) {
                    continue
                }
                if !Conversion.Classify(argType, paramType).IsImplicit {
                    applicable = false
                    break
                }
            }
            if !applicable {
                continue
            }
            candidates.Add(candidate)
        }
        let best = selectBestConstructor(candidates.ToImmutable(), baseClassSymbol, boundArguments.ToImmutable())
        if best == nil {
            // Suppress the GS0214 cascade when an argument already failed to
            // bind (an error type was produced upstream).
            if !anyArgIsError {
                Diagnostics.ReportNoMatchingBaseConstructor(location, baseClassSymbol.Name, boundArguments.Count)
            }
            return nil
        }
        let bestParamTypes = baseClassSymbol.GetConstructorParameterTypesForConstruction(best)
        let convertedArgs = ImmutableArray.CreateBuilder[BoundExpression](best.Parameters.Length)
        for var i = 0; i < best.Parameters.Length; i++ {
            if i >= boundArguments.Count {
                convertedArgs.Add(CreateProjectedOptionalUserDefaultArgument(best.Parameters[i], bestParamTypes[i]))
                continue
            }
            convertedArgs.Add(
                if IsImplicitInArgument(best.Parameters[i], boundArguments[i]) {
                    conversions.BindImplicitInArgument(
                        argLocation(i),
                        boundArguments[i],
                        bestParamTypes[i],
                        best.Parameters[i]
                    )
                } else {
                    (
                        if best.Parameters[i].RefKind != RefKind.None {
                            boundArguments[i]
                        } else {
                            conversions.BindConversion(argLocation(i), boundArguments[i], bestParamTypes[i])
                        }
                    )
                }
            )
        }
        return BaseConstructorInitializer(convertedArgs.ToImmutable(), baseClassSymbol, best)
    }

    /// Issue #306 / #2766: binds standalone user-defined constructors (`init(...)`)
    /// declared in a class or plain struct body. Each constructor becomes a (cref:ConstructorSymbol)
    /// whose body is bound in (cref:Binder.BindProgram(BoundGlobalScope, ReferenceResolver)) as an
    /// instance-method body and
    /// emitted/interpreted as a `.ctor`.
    private func BindConstructorDeclarations(
        syntax StructDeclarationSyntax,
        structSymbol StructSymbol,
        $package PackageSymbol,
        baseClassSymbol StructSymbol?,
        importedBaseType TypeSymbol?
    ) {
        // ADR-0065 §5: a class with a primary-constructor parameter list and
        // no explicit `init(...)` body still needs ExplicitConstructors set up
        // for the convenience-init self-delegation lookup, but the emitter
        // already handles the primary-ctor-only case via its existing
        // ClassPrimaryCtorHandles path. We only need to materialize a
        // synthesized designated ConstructorSymbol when there are also
        // explicit init(...) bodies (so that primary becomes a peer in the
        // overload set), or when a class needs an init(...) overload for
        // diagnostics or chaining purposes. For pure primary-ctor classes we
        // leave the existing path unchanged.
        if syntax.Constructors.IsDefaultOrEmpty {
            return
        }
        // ADR-0065 §5: when both a primary-constructor parameter list and
        // explicit `init(...)` bodies are declared, the primary constructor
        // becomes a synthesized designated initializer that participates in
        // the overload set alongside the explicit bodies. Duplicate signatures
        // are diagnosed below by the same overload-equality check that catches
        // collisions between two user-declared init overloads. Data structs
        // share these signatures with ordinary calls and self-delegation.
        var synthesizedPrimary ConstructorSymbol? = nil
        if structSymbol.HasPrimaryConstructor ||
            (
            structSymbol.UsesConstructorOwnedDataConstruction &&
                (
                structSymbol.HasDeclaredPrimaryConstructor || !syntax.Constructors.Any(
                    (constructor ConstructorDeclarationSyntax) -> constructor.Parameters.Count == 0
                )
            )
        ) {
            synthesizedPrimary = SynthesizePrimaryConstructor(structSymbol, $package)
        }
        // ADR-0063 §9: bind every declared init(...) constructor. Duplicate
        // signatures are diagnosed as GS0264 the same way as duplicate method
        // overloads, so each surviving ConstructorSymbol carries a unique
        // signature within the overload family.
        let ctorBuilder = ImmutableArray.CreateBuilder[ConstructorSymbol]()
        if (structSymbol.IsClass || structSymbol.UsesConstructorOwnedDataConstruction) && synthesizedPrimary != nil {
            ctorBuilder.Add(synthesizedPrimary)
        }
        for ctorSyntax in syntax.Constructors {
            let ctor ConstructorSymbol? = BindSingleConstructorDeclaration(
                ctorSyntax,
                structSymbol,
                $package,
                baseClassSymbol,
                importedBaseType
            )
            if ctor == nil {
                continue
            }
            // ADR-0065 §2: enforce constraints on convenience initializers.
            // Issue #1085: base-initializer resolution is deferred, so detect the
            // `: base(...)` presence from syntax rather than the (not-yet-set)
            // resolved BaseInitializer symbol.
            if ctor.IsConvenience && ctorSyntax.HasBaseInitializer {
                Diagnostics.ReportConvenienceInitMayNotCallBase(
                    Invariant.Required(
                        ctorSyntax.BaseKeyword,
                        "a constructor with a base initializer has a base keyword",
                        expression: "ctorSyntax.BaseKeyword"
                    )
                        .Location,
                    structSymbol.Name
                )
            }
            // Check the owning primary signature before accepting an authored overload.
            var duplicate = synthesizedPrimary != nil && BoundScope.FunctionSignaturesEqual(
                synthesizedPrimary.Function,
                ctor.Function
            )
            for existing in ctorBuilder {
                if BoundScope.FunctionSignaturesEqual(existing.Function, ctor.Function) {
                    duplicate = true
                    break
                }
            }
            if duplicate {
                // ADR-0065 §5: distinguish duplication against the synthesized
                // primary ctor from duplication between two user inits so users
                // get an actionable message.
                if synthesizedPrimary != nil && BoundScope.FunctionSignaturesEqual(
                    synthesizedPrimary.Function,
                    ctor.Function
                ) {
                    Diagnostics.ReportInitDuplicatesPrimaryCtor(
                        ctorSyntax.InitKeyword.Location,
                        structSymbol.Name,
                        Binder.FormatOverloadSignature(ctor.Function)
                    )
                } else {
                    Diagnostics.ReportDuplicateOverloadSignature(
                        ctorSyntax.InitKeyword.Location,
                        "init",
                        Binder.FormatOverloadSignature(ctor.Function)
                    )
                }
                continue
            }
            ctorBuilder.Add(ctor)
        }
        structSymbol.SetExplicitConstructors(ctorBuilder.ToImmutable())
        // Issue #4143: validate every EXPLICIT `init(...)` overload's
        // parameter types too — `csc` checks CS0181 against every
        // constructor of an attribute class, not just the primary one. The
        // synthesized primary constructor (if any) is skipped here: its
        // parameters were already validated once, against the primary
        // constructor's own parameter list, where the class's base clause
        // was bound (`BindStructBaseAndInterfaces`) — validating it again
        // here would double-report the same offending parameter.
        //
        // `DerivesFromSystemAttributeDuringDeclaration`, not
        // `DerivesFromSystemAttribute` alone — see the matching comment in
        // `BindStructBaseAndInterfaces` for why: a NESTED same-compilation
        // base's own flags are not reliable here when it is declared after
        // this type in the same enclosing body, and `IsAttributeType`'s
        // `bindTypeClause` fallback is not safe to call from here (it
        // regressed `Issue1244GenericAbstractOverrideBinderTests`).
        if DerivesFromSystemAttributeDuringDeclaration(structSymbol) {
            for ctor in ctorBuilder {
                if ctor == synthesizedPrimary {
                    continue
                }
                ValidateAttributeConstructorParameterTypes(ctor.Parameters, syntax.Identifier.Location)
            }
        }
    }

    /// ADR-0068 / issue #698: binds the optional `deinit { … }` destructor
    /// on a class body into a synthesized (cref:FunctionSymbol) named
    /// `Finalize`. The body itself is bound later in
    /// (cref:Binder.BindProgram(BoundGlobalScope, ReferenceResolver))
    /// alongside method and constructor bodies. Non-class types are rejected
    /// here so the parser-level GS0289 is never the only signal in tools that
    /// skip parser diagnostics.
    private func BindDeinitDeclaration(
        syntax StructDeclarationSyntax,
        structSymbol StructSymbol,
        $package PackageSymbol
    ) {
        let deinitSyntax DeinitDeclarationSyntax? = syntax.Deinitializer
        if deinitSyntax == nil {
            return
        }
        // Defence-in-depth: the parser already reports GS0289 when `deinit`
        // appears inside a non-class body, but if a downstream tool feeds us
        // such a tree directly we must still refuse to synthesise a Finalize
        // symbol for the value type.
        if !structSymbol.IsClass {
            return
        }
        let ctorFunction = FunctionSymbol(
            "Finalize",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            declaration: nil,
            $package,
            Accessibility.Private,
            receiverType: structSymbol
        ){IsUnsafe = binderCtx.InUnsafeContext}
        let deinitSymbol = DeinitSymbol(ctorFunction, deinitSyntax)
        structSymbol.SetDeinitializer(deinitSymbol)
    }

    /// ADR-0065 §5: synthesizes a designated (cref:ConstructorSymbol)
    /// whose signature matches the type's primary-constructor parameter list.
    /// The emitter produces its body (field assignments per parameter) directly
    /// rather than reading from `BoundProgram.Functions`; we leave the
    /// function's body unbound here. The synthesized ctor is marked with
    /// (cref:ConstructorSymbol.IsSynthesizedFromPrimaryConstructor) so
    /// emit and overload-resolution paths can detect it.
    private func SynthesizePrimaryConstructor(structSymbol StructSymbol, $package PackageSymbol) ConstructorSymbol {
        // Reuse the primary-ctor parameter symbols verbatim — they already
        // carry the right names, types, ref-kinds and any defaults. The
        // emitter looks up the matching same-named field for each parameter.
        let parameters = structSymbol.PrimaryConstructorParameters
        let ctorFunction = FunctionSymbol(
            ".ctor",
            parameters,
            TypeSymbol.Void,
            declaration: nil,
            $package,
            Accessibility.Public,
            receiverType: structSymbol
        ){IsSpecialName = true, IsUnsafe = binderCtx.InUnsafeContext}
        let ctorSymbol = ConstructorSymbol(ctorFunction, declaration: nil)
        ctorSymbol.MarkSynthesizedFromPrimaryConstructor()
        return ctorSymbol
    }

    /// ADR-0063 §9: binds a single `init(...)` constructor declaration into a
    /// (cref:ConstructorSymbol) with the optional `: base(args)` initializer
    /// resolved. The caller is responsible for collecting all constructors and
    /// rejecting same-signature duplicates.
    private func BindSingleConstructorDeclaration(
        ctorSyntax ConstructorDeclarationSyntax,
        structSymbol StructSymbol,
        $package PackageSymbol,
        baseClassSymbol StructSymbol?,
        importedBaseType TypeSymbol?
    ) ConstructorSymbol {
        let parameters = ImmutableArray.CreateBuilder[ParameterSymbol]()
        let seenParameterNames = HashSet[string]()
        for parameterSyntax in ctorSyntax.Parameters {
            // ADR-0185: a constructor parameter never comes from the
            // destructured arrow-lambda path (Parser.Members.cs's
            // ParseParameter always sets Identifier).
            let parameterName = parameterSyntax.Identifier!!.ValueText
            var parameterType = if parameterSyntax.Type is {} parameterTypeSyntax {
                bindTypeClause(parameterTypeSyntax) ?? TypeSymbol.Error
            } else {
                TypeSymbol.Error
            }
            // ADR-0101 follow-up / issue #812: variadic parameters are now
            // accepted on explicit `init(...)` constructors. The body sees
            // the parameter as `[]T`; constructor calls (and
            // `: this(...)` / `: base(...)` chaining) go through the
            // constructor overload paths that pack trailing arguments.
            let isVariadic = parameterSyntax.IsVariadic
            if isVariadic && parameterType != TypeSymbol.Error {
                parameterType = VariadicCarriers.ResolveDeclaredParameterType(parameterType)
            }
            let parameterRefKind = conversions.BindAndValidateParameterRefKind(
                parameterSyntax,
                parameterName,
                parameterType,
                isVariadic,
                asyncOrIteratorKind: nil
            )
            // Issue #1262: `_` is the discard identifier — repeated `_` parameters are
            // permitted on named functions/methods. Each `_` occupies a positional slot
            // but is not added to the body scope, so non-`_` duplicates still error.
            if parameterName != "_" && !seenParameterNames.Add(parameterName) {
                Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName)
            } else {
                let ctorParam = ParameterSymbol(
                    parameterName,
                    parameterType,
                    isVariadic,
                    declaringSyntax: parameterSyntax.Identifier,
                    isScoped: parameterSyntax.IsScoped,
                    refKind: parameterRefKind
                )
                DeferParameterDefaultValueBinding(parameterSyntax, ctorParam, structSymbol, $package)
                BindAndAttachParameterAttributes(parameterSyntax, ctorParam)
                parameters.Add(ctorParam)
            }
        }
        ValidateVariadicParameterShape(ctorSyntax.Parameters)
        let ctorAccessibility = resolveAccessibility(ctorSyntax.AccessibilityModifier)
        let ctorFunction = FunctionSymbol(
            ".ctor",
            parameters.ToImmutable(),
            TypeSymbol.Void,
            declaration: nil,
            $package,
            ctorAccessibility,
            receiverType: structSymbol
        ){IsSpecialName = true, IsUnsafe = binderCtx.InUnsafeContext}
        let constructorSymbol = ConstructorSymbol(ctorFunction, ctorSyntax)
        Binder.AttachDocumentation(ctorFunction, ctorSyntax)
        // ADR-0065 §2: propagate the contextual `convenience` modifier from
        // syntax onto the symbol so the binder/emitter can apply the §2
        // rules (delegation-first, no `: base()`, this(args) chaining).
        if ctorSyntax.IsConvenience {
            constructorSymbol.MarkConvenience()
        }
        // Resolve the explicit `: base(args)` initializer, or the implicit
        // zero-argument base call of a designated constructor, with the
        // constructor parameters in scope so explicit arguments can be
        // forwarded to the base.
        //
        // Issue #1085: the argument expressions may construct other user types
        // whose explicit constructors are not yet populated when this type body
        // is bound (the constructed type may live in a source file processed
        // later). Defer the argument binding and base-constructor resolution to
        // a post-pass that runs after every declared type's constructors exist.
        if ctorSyntax.HasBaseInitializer ||
            (
            !ctorSyntax.IsConvenience &&
                (
                importedBaseType != nil ||
                    baseClassSymbol
                    ?.EffectiveExplicitConstructors
                    .IsDefaultOrEmpty == false ||
                    (baseClassSymbol?.IsData == true && baseClassSymbol!!.HasDeclaredPrimaryConstructor)
            )
        ) {
            let capturedScope = $scope
            let capturedUnsafeContext = binderCtx.InUnsafeContext
            pendingBaseInitializerBindings.Add(
                () -> {
                    using let unsafeContext = binderCtx.PushUnsafeContext(capturedUnsafeContext)
                    let outerScope = $scope
                    $scope = capturedScope
                    // Issue #2342: re-establish this type's OWN owning package as
                    // the ambient lookup preference (see field-initializer closure
                    // above for the full rationale) for the duration of this
                    // deferred bind.
                    let savedPackage = $scope.SetCurrentDeclaringPackage(structSymbol.PackageName)
                    let savedTree = $scope.SetCurrentReferencingSyntaxTree(ctorSyntax.SyntaxTree)
                    try {
                        BindConstructorBaseInitializerCore(
                            ctorSyntax,
                            constructorSymbol,
                            ctorFunction,
                            structSymbol,
                            baseClassSymbol,
                            importedBaseType
                        )
                    } finally {
                        $scope.SetCurrentDeclaringPackage(savedPackage)
                        $scope.SetCurrentReferencingSyntaxTree(savedTree)
                        $scope = outerScope
                    }
                }
            )
        }
        return constructorSymbol
    }

    private func BindConstructorBaseInitializerCore(
        ctorSyntax ConstructorDeclarationSyntax,
        constructorSymbol ConstructorSymbol,
        ctorFunction FunctionSymbol,
        structSymbol StructSymbol,
        baseClassSymbol StructSymbol?,
        importedBaseType TypeSymbol?
    ) {
        let hasExplicitBaseInitializer = ctorSyntax.HasBaseInitializer
        let location = if hasExplicitBaseInitializer {
            Invariant.Required(
                ctorSyntax.BaseKeyword,
                "a constructor base initializer has a base keyword",
                expression: "ctorSyntax.BaseKeyword"
            )
                .Location
        } else {
            ctorSyntax.InitKeyword.Location
        }
        // Issue #1194: expose the enclosing type's static members (consts, static
        // fields/properties, static methods) and — because this runs after all
        // top-level functions are declared — free functions, so a `: base(...)`
        // argument can reference them unqualified (matching C#).
        let savedScope = $scope
        let savedTypeParameters = binderCtx.CurrentTypeParameters
        if !structSymbol.TypeParameters.IsDefaultOrEmpty {
            this.binderCtx.CurrentTypeParameters = Dictionary[string, TypeParameterSymbol]()
            for tp in structSymbol.TypeParameters {
                binderCtx.CurrentTypeParameters!![tp.Name] = tp
            }
        }
        var boundArguments ImmutableArray[BoundExpression].Builder
        var init BaseConstructorInitializer? = nil
        let savedFunction = getCurrentFunction()
        let savedInitializerContext = ctorFunction.IsExpressionInitializer
        ctorFunction.IsExpressionInitializer = true
        setCurrentFunction(ctorFunction)
        try {
            using let initializerContext = binderCtx.PushConstructorInitializerContext()
            {
                using let _ = PushStaticMemberScope(structSymbol)
                let staticScope = $scope
                $scope = BoundScope(staticScope)
                for p in ctorFunction.Parameters {
                    $scope.TryDeclareVariable(p)
                }
                let baseArgumentCount = if hasExplicitBaseInitializer {
                    ctorSyntax.BaseArguments.Count
                } else {
                    0
                }
                boundArguments = ImmutableArray.CreateBuilder[BoundExpression](baseArgumentCount)
                for var i = 0; i < baseArgumentCount; i++ {
                    boundArguments.Add(BindConstructorInitializerArgument(ctorSyntax.BaseArguments[i]))
                }
                // Issue #1812: resolve (and, when needed, interpolation-rebind)
                // while the ctor-parameter scope set up above is still active, so
                // a `: base($"...{n}...")` argument referencing an explicit ctor
                // parameter (`n`) can be re-bound against the chosen
                // FormattableString parameter — this must happen before the
                // `using` block below tears the parameter scope back down
                // (`PushStaticMemberScope`'s `Dispose` hard-resets
                // `binderCtx.RootScope`, discarding the child scope created above
                // regardless of any assignment here), otherwise the rebind would
                // fail to resolve `n` (issue #377/#1638's
                // RebindFormattableInterpolationArguments does not have this
                // problem because ExpressionBinder never tears its scope down
                // mid-call the way this deferred base-initializer pass does).
                if baseClassSymbol == nil && importedBaseType == nil {
                    Diagnostics.ReportBaseConstructorArgumentsWithoutBase(location)
                } else if importedBaseType?.ClrType is Type clrBase {
                    let argumentLocation(int32) -> TextLocation = (i int32) -> if hasExplicitBaseInitializer {
                        ctorSyntax.BaseArguments[i].Location
                    } else {
                        location
                    }
                    let argumentSyntax((int32) -> ExpressionSyntax)? = if hasExplicitBaseInitializer {
                        (i int32) -> ctorSyntax.BaseArguments[i]
                    } else {
                        default(((int32) -> ExpressionSyntax)?)
                    }
                    init = ResolveClrBaseConstructor(
                        argumentLocation,
                        clrBase,
                        importedBaseType,
                        boundArguments,
                        location,
                        argumentSyntax
                    )
                } else {
                    let argumentLocation(int32) -> TextLocation = (i int32) -> if hasExplicitBaseInitializer {
                        ctorSyntax.BaseArguments[i].Location
                    } else {
                        location
                    }
                    init = ResolveGSharpBaseConstructor(
                        argumentLocation,
                        structSymbol.Name,
                        Invariant.Required(
                            baseClassSymbol,
                            "a non-CLR base constructor has a declared GSharp base class",
                            expression: "baseClassSymbol"
                        ),
                        boundArguments,
                        location
                    )
                }
                ReportProtectedReceiverAccess(init)
                $scope = staticScope
            }
        } finally {
            ctorFunction.IsExpressionInitializer = savedInitializerContext
            setCurrentFunction(savedFunction)
        }
        if init != nil {
            constructorSymbol.SetBaseInitializer(init)
        }
        $scope = savedScope
        this.binderCtx.CurrentTypeParameters = savedTypeParameters
    }

    shared {
        /// Issue #3984: reports whether [`ctor`](paramref) is callable with
        /// [`argumentCount`](paramref) positional arguments — its fixed arity,
        /// or fewer once optional parameters are omitted, or more once a trailing
        /// `params` array is expanded. Used to keep GS0214's arity claim
        /// honest.
        /// @param ctor The candidate constructor.
        /// @param argumentCount The number of supplied arguments.
        /// @returns Whether the constructor accepts that many arguments.
        private func AcceptsArgumentCount(ctor ConstructorInfo, argumentCount int32) bool {
            let parameters = ctor.GetParameters()
            if parameters.Length == argumentCount {
                return true
            }
            // `ClrOverloadResolution.IsParamsArrayParameter` reads the marker by
            // name, which is what keeps this working for a base type loaded through
            // a MetadataLoadContext.
            if parameters.Length > 0 && ClrOverloadResolution.IsParamsArrayParameter(parameters[^1]) &&
                argumentCount >= parameters.Length - 1 {
                return true
            }
            var required = 0
            for parameter in parameters {
                if !parameter.IsOptional {
                    required++
                }
            }
            return argumentCount >= required && argumentCount <= parameters.Length
        }

        /// Issue #3984: finds [`bestCtor`](paramref) on the base type's OPEN
        /// generic definition, whose parameter types still mention the base's own
        /// generic parameters.
        /// @param openBaseDefinition The base type's open generic definition, or `null` for a non-generic base.
        /// @param bestCtor The constructor overload resolution selected, on the constructed (erased) type.
        /// @returns The open constructor's parameters, or `null`.
        private func TryGetOpenBaseConstructorParameters(
            openBaseDefinition Type?,
            bestCtor ConstructorInfo
        )[]?ParameterInfo {
            if openBaseDefinition == nil {
                return nil
            }
            return (
                ClrTypeUtilities.FindMetadataDefinition(
                    openBaseDefinition,
                    bestCtor,
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
                    safeEnumeration: true
                ) as ConstructorInfo
            )?.GetParameters()
        }

        /// Issue #3984: substitutes the base type's symbolic type arguments into
        /// the open base constructor's parameter at [`index`](paramref),
        /// producing the type the emitted MemberRef's signature actually carries
        /// (`IEnumerable[T]` for `List[T]`, not
        /// `IEnumerable[object]`).
        /// @remarks Returns `null` unless the substitution genuinely changes
        /// something — a base closed over concrete types (`List[int32]`) maps
        /// back to the same shape the erased signature already gave, so those call
        /// sites keep the exact target, conversion and IL they have today.
        /// @param openBaseCtorParams The open base constructor's parameters.
        /// @param openBaseDefinition The base type's open generic definition.
        /// @param baseTypeArguments The base type's symbolic type arguments.
        /// @param index The parameter ordinal.
        /// @returns The symbolic parameter type, or `null`.
        private func TryProjectSymbolicBaseParameterType(
            openBaseCtorParams[]?ParameterInfo,
            openBaseDefinition Type?,
            baseTypeArguments ImmutableArray[TypeSymbol],
            index int32
        ) TypeSymbol? {
            if openBaseCtorParams == nil ||
                openBaseDefinition == nil ||
                baseTypeArguments.IsDefaultOrEmpty ||
                index < 0 ||
                index >= openBaseCtorParams.Length {
                return nil
            }
            let raw = MemberLookup.GetClrOpenParameterPointeeTypeSymbol(
                openBaseCtorParams[index],
                openBaseDefinition,
                baseTypeArguments
            )
            // Issue #3987: #3984 canonicalised `raw` here — a `Dictionary`2`-shaped
            // `ImportedTypeSymbol` became a `MapTypeSymbol`, a `ValueTuple`n`-shaped
            // one a `TupleTypeSymbol` — because `Conversion` related the two
            // spellings of one type only while their `ClrType`s were readable, and
            // an argument the author wrote as `map[K, V]` therefore could not reach
            // the `Dictionary[K, V]` parameter it IS. That rewrite (and the
            // `ShouldCanonicalizeAgainst` guard that kept it from breaking the
            // opposite spelling) is DELETED: `Conversion` now recognises both
            // shapes by shape rather than by spelling, so the raw projection is
            // accepted whichever way either side is written.
            let mapped = raw
            if mapped == TypeSymbol.Error {
                return nil
            }
            let keepsSymbolicShape = TypeSymbol.ContainsTypeParameter(mapped) ||
                TypeSymbol.ContainsSameCompilationUserType(mapped) || TypeSymbol.RequiresSymbolicProjection(mapped) ||
                TypeSymbol.ContainsFixedLengthArray(mapped) || mapped is TupleTypeSymbol
            return if keepsSymbolicShape {
                mapped
            } else {
                default(TypeSymbol?)
            }
        }

        // Issue #4400: the symbolic pointee of a generic base constructor's `in`
        // parameter (`Base<T>(in T)` → `T`), or null when nothing was erased.
        private func TryProjectSymbolicBaseInPointeeType(
            openBaseCtorParams[]?ParameterInfo,
            openBaseDefinition Type?,
            baseTypeArguments ImmutableArray[TypeSymbol],
            index int32
        ) TypeSymbol? {
            if openBaseCtorParams == nil ||
                openBaseDefinition == nil ||
                baseTypeArguments.IsDefaultOrEmpty ||
                index < 0 ||
                index >= openBaseCtorParams.Length ||
                !openBaseCtorParams[index]
                .ParameterType
                .IsByRef {
                return nil
            }
            // Keep every symbolic shape the receiver projection keeps
            // (ConversionClassifier.TrySubstituteParameterTypeFromReceiver): a
            // type parameter or same-compilation type in the pointee, or a base
            // type argument whose nullability, fixed length or tuple names the
            // erased closed signature cannot carry (`Base[string?]`, `Base[[3]int32]`).
            let mapped = MemberLookup.GetClrOpenParameterPointeeTypeSymbol(
                openBaseCtorParams[index],
                openBaseDefinition,
                baseTypeArguments
            )
            let keepsSymbolicShape = TypeSymbol.ContainsTypeParameter(mapped) ||
                TypeSymbol.ContainsSameCompilationUserType(mapped) || baseTypeArguments.Any(
                (argument TypeSymbol) -> TypeSymbol.RequiresSymbolicProjection(argument) ||
                    TypeSymbol.ContainsFixedLengthArray(argument) || argument is TupleTypeSymbol
            )
            return if mapped != TypeSymbol.Error && keepsSymbolicShape {
                mapped
            } else {
                default(TypeSymbol?)
            }
        }

        /// Issue #1812 (ADR-0055 Tier 4 / #369 companion): produces the per-argument
        /// flags marking which positional `: base(...)` arguments are
        /// interpolated-string literals, so overload resolution can treat them as
        /// convertible to IFormattable/FormattableString/handler parameters — the
        /// same treatment every other CLR-call Resolve site gives interpolated
        /// string arguments. Base-constructor arguments are always positional
        /// (there is no named-argument base-ctor syntax), so no unwrap step is
        /// needed here (contrast with the named-argument-aware helpers used for
        /// ordinary calls). Returns `null` when no argument
        /// qualifies or [`argSyntax`](paramref) is unavailable.
        private func ComputeInterpolatedStringArgFlags(
            argSyntax((int32) -> ExpressionSyntax)?,
            count int32
        ) IReadOnlyList[bool]? {
            if argSyntax == nil {
                return nil
            }
            var flags[]?bool = nil
            for var i = 0; i < count; i++ {
                if argSyntax(i) is InterpolatedStringExpressionSyntax {
                    flags ??= [count]bool
                    flags!![i] = true
                }
            }
            return flags
        }

        // Issue #4400: a plain (non-address) argument at an `in` parameter.
        private func IsImplicitInArgument(
            parameter ParameterSymbol,
            argument BoundExpression
        ) bool -> parameter.RefKind == RefKind.In &&
            !TryGetAddressedArgumentType(argument, out _)

        private func CreateProjectedOptionalUserDefaultArgument(
            parameter ParameterSymbol,
            targetType TypeSymbol
        ) BoundExpression {
            if parameter.ExplicitDefaultValue == nil {
                return BoundDefaultExpression(nil, targetType)
            }
            return BoundLiteralExpression(nil, parameter.ExplicitDefaultValue, targetType)
        }

        private func TryGetAddressedArgumentType(
            argument BoundExpression,
            @NotNullWhen(true) out addressedType TypeSymbol?
        ) bool {
            switch argument {
                case BoundAddressOfExpression{IsUnmanaged: false} address {
                    addressedType = address.Operand.Type
                    return true
                }
                case conditionalAddress is BoundConditionalAddressExpression {
                    addressedType = conditionalAddress.PointeeType
                    return true
                }
                default {
                    addressedType = nil
                    return false
                }
            }
        }

        private func ReadParamsElementShape(paramsParameter ParameterInfo) TypeSymbol {
            let positions = ClrNullability.GetParameterTypeSymbol(paramsParameter).GetElementPositions()
            return if positions.Length == 1 {
                positions[0].StripToBareShape()
            } else {
                TypeSymbol.Object
            }
        }
    }
}
