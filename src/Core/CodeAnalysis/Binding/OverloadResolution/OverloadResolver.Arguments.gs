// <copyright file="OverloadResolver.Arguments.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding.OverloadResolution

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Documentation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding

internal partial class OverloadResolver {
    /// Issue #506: synthesises C#-style `params T[]` expansion for a CLR
    /// call site that won overload resolution in expanded form. The trailing
    /// positional arguments (those mapped to the final `params` parameter)
    /// are individually converted to the element type and packed into a
    /// (cref:BoundArrayCreationExpression); the returned argument list
    /// has length equal to [`parameters`](paramref).Length so the
    /// remaining call-binding pipeline (handler rewrite, ref-kind validation,
    /// ordered-mapping fill) treats the call uniformly with normal-form calls.
    /// @param arguments The source-order bound arguments. Includes a synthesised receiver slot for imported
    /// extension calls; the receiver always sits at the leading parameter positions, never the params slot.
    /// @param parameters The resolved method's parameter list.
    /// @param callSyntax The originating call expression; used to surface conversion diagnostics for
    /// individual variadic elements when present.
    /// @param receiverArgCount The number of leading argument slots reserved for a synthesised receiver (0
    /// for plain calls, 1 for imported extension calls).
    /// @param parameterMapping Issue #506 follow-up: when non-default, the source-order mapping from each
    /// input argument to its parameter slot, as produced by overload resolution for calls combining named
    /// arguments with expanded `params` form. Causes the expander to emit arguments already in parameter
    /// order with optional slots filled by their defaults.
    /// @param symbolicMethodTypeArgs The real symbolic method type arguments when reflection used erased
    /// placeholders to close the selected generic method.
    /// @param paramsElementTypeOverride The reified params element type when a constrained generic
    /// receiver's reflected array element is erased.
    /// @returns An argument list of length [`parameters`](paramref).Length whose final element is the
    /// packed array.
    func ExpandParamsArguments(
        arguments ImmutableArray[BoundExpression],
        parameters[]ParameterInfo,
        callSyntax CallExpressionSyntax,
        receiverArgCount int32 = 0,
        parameterMapping ImmutableArray[int32] = default(ImmutableArray[int32]),
        symbolicMethodTypeArgs ImmutableArray[TypeSymbol?] = default(ImmutableArray[TypeSymbol?]),
        paramsElementTypeOverride TypeSymbol? = nil
    ) ImmutableArray[BoundExpression] {
        let paramsIndex = parameters.Length - 1
        let paramArrayType = parameters[paramsIndex].ParameterType
        let elementClrType Type? = paramArrayType.GetElementType()
        var elementTypeSymbol = paramsElementTypeOverride ??
            (
            if elementClrType == nil {
                TypeSymbol.Object
            } else {
                GetParamsElementTypeSymbol(parameters[paramsIndex], elementClrType)
            }
        )
        if !symbolicMethodTypeArgs.IsDefaultOrEmpty &&
            parameters[paramsIndex].Member is MethodInfo method &&
            method
            .IsGenericMethod {
            let openMethod = if method.IsGenericMethodDefinition {
                method
            } else {
                method.GetGenericMethodDefinition()
            }
            let openParameters = openMethod.GetParameters()
            let openElementType Type? = openParameters[paramsIndex].ParameterType.GetElementType()
            if openElementType != nil {
                let symbolicElementType = MemberLookup.MapOpenSignatureWithoutDeclarationMerge(
                    openElementType,
                    openDefinition: nil,
                    typeArguments: default(ImmutableArray[TypeSymbol]),
                    openMethodDefinition: openMethod,
                    methodTypeArguments: symbolicMethodTypeArgs
                )
                if TypeSymbol.RequiresSymbolicProjection(symbolicElementType) {
                    elementTypeSymbol = symbolicElementType
                }
            }
        }
        let sliceType = SliceTypeSymbol.Get(elementTypeSymbol)
        // Issue #506 follow-up: when a parameter mapping is supplied (named
        // arguments combined with `params` expansion) the input arguments are
        // in source order and may bind to any non-params parameter; the source
        // positions that map to the params slot must be packed. The result is
        // built in parameter order so the downstream binding pipeline can drop
        // its own reorder step.
        if !parameterMapping.IsDefault {
            let ordered = [parameters.Length]BoundExpression
            let paramsElementBuilder = ImmutableArray.CreateBuilder[BoundExpression]()
            let paramsSourceIndices = List[int32]()
            for var i = 0; i < arguments.Length; i++ {
                let slot = parameterMapping[i]
                if slot == paramsIndex {
                    paramsSourceIndices.Add(i)
                } else {
                    ordered[slot] = arguments[i]
                }
            }
            for sourceIndex in paramsSourceIndices {
                paramsElementBuilder.Add(
                    ConvertParamsElement(
                        arguments[sourceIndex],
                        parameters[paramsIndex],
                        elementTypeSymbol,
                        callSyntax,
                        sourceIndex,
                        receiverArgCount
                    )
                )
            }
            ordered[paramsIndex] = BoundArrayCreationExpression(
                callSyntax,
                sliceType,
                paramsElementBuilder.ToImmutable()
            )
            for var i = 0; i < parameters.Length; i++ {
                ordered[i] ??= ConversionClassifier.CreateOptionalDefaultArgument(parameters[i])
            }
            return ImmutableArray.Create(ordered)
        }
        let fixedCount = paramsIndex
        let suppliedFixedCount = Math.Min(arguments.Length, fixedCount)
        let tailCount = Math.Max(0, arguments.Length - fixedCount)
        let packed = ImmutableArray.CreateBuilder[BoundExpression](tailCount)
        for var i = 0; i < tailCount; i++ {
            let sourceIndex = fixedCount + i
            packed.Add(
                ConvertParamsElement(
                    arguments[sourceIndex],
                    parameters[paramsIndex],
                    elementTypeSymbol,
                    callSyntax,
                    sourceIndex,
                    receiverArgCount
                )
            )
        }
        let arrayExpr = BoundArrayCreationExpression(callSyntax, sliceType, packed.MoveToImmutable())
        let result = ImmutableArray.CreateBuilder[BoundExpression](parameters.Length)
        for var i = 0; i < suppliedFixedCount; i++ {
            result.Add(arguments[i])
        }
        for var i = suppliedFixedCount; i < fixedCount; i++ {
            result.Add(ConversionClassifier.CreateOptionalDefaultArgument(parameters[i]))
        }
        result.Add(arrayExpr)
        return result.MoveToImmutable()
    }

    /// Issue #506: converts a single positional argument intended for a
    /// `params T[]` element slot to the element type, threading the
    /// originating source location for diagnostic reporting.
    private func ConvertParamsElement(
        arg BoundExpression,
        parameter ParameterInfo,
        elementTypeSymbol TypeSymbol,
        callSyntax CallExpressionSyntax?,
        sourceIndex int32,
        receiverArgCount int32
    ) BoundExpression {
        let conversionSyntaxIndex = sourceIndex - receiverArgCount
        let location = if callSyntax != nil &&
            conversionSyntaxIndex >= 0 &&
            conversionSyntaxIndex < callSyntax
            .Arguments
            .Count {
            callSyntax.Arguments[conversionSyntaxIndex].Location
        } else {
            callSyntax?.Location ?? default(TextLocation)
        }
        if ClrOverloadResolution.IsMethodGroupArgument(arg) {
            return conversions.BindConversion(location, arg, elementTypeSymbol)
        }
        if arg.Type == nil || arg.Type == TypeSymbol.Error || arg.Type == elementTypeSymbol {
            return arg
        }
        let conversion = Conversion.Classify(arg.Type, elementTypeSymbol)
        if conversions.TryRejectClrPlatformContainerArgument(
            arg,
            parameter,
            elementTypeSymbol,
            location,
            out var rejectedArgument,
            conversion
        ) {
            return rejectedArgument
        }
        if conversion.IsExplicit && conversions.TryApplyUserDefinedImplicitArgumentConversion(
            arg,
            elementTypeSymbol,
            out var implicitArg
        ) {
            return implicitArg
        }
        if conversion.Exists {
            return conversions.BindConversion(location, arg, elementTypeSymbol, allowExplicit: true)
        }
        if conversions.TryApplyUserDefinedImplicitArgumentConversion(arg, elementTypeSymbol, out var udc) {
            return udc
        }
        return conversions.BindConversion(location, arg, elementTypeSymbol)
    }

    /// Issue #1281: C# §10.2.11 implicit constant expression conversion at a call
    /// site. When [`argument`](paramref) is a constant integer expression
    /// whose value fits the (possibly narrower or cross-sign) integer parameter
    /// type [`parameterType`](paramref), re-materialise it as a literal of
    /// exactly that type through (cref:ConversionClassifier.BindConversion(TextLocation, BoundExpression,
    /// TypeSymbol, bool, ParameterSymbol))
    /// — mirroring the declaration/assignment behaviour (ADR-0129) so call sites
    /// accept e.g. `f(5)` for a `uint16`/`uint32` parameter the same
    /// way `var x uint16 = 5` already does. Returns `true`
    /// (with [`converted`](paramref) set to the retyped literal) when the rule
    /// applies; otherwise `false` so genuine type-mismatch
    /// diagnostics still fire on the regular path.
    private func TryBindConstantNarrowingArgument(
        argument BoundExpression,
        parameterType TypeSymbol,
        location TextLocation,
        out converted BoundExpression?
    ) bool {
        converted = nil
        if !ExpressionBinder.IsImplicitConstantNarrowingArgument(argument, parameterType) {
            return false
        }
        converted = conversions.BindConversion(location, argument, parameterType)
        return true
    }

    /// Rebinds an arrow lambda against its resolved delegate parameter type
    /// before conversion. This preserves contextual return typing, including
    /// void block lambdas whose target-less return inference produced
    /// (cref:TypeSymbol.Error) and nested delegate-returning lambdas.
    /// Also preserves issue #889's value-discard conversion for `func`
    /// literals targeting void delegates.
    internal func TryConvertLambdaArgumentWithTarget(
        argument BoundExpression,
        expectedType TypeSymbol?,
        location TextLocation,
        out result BoundExpression?,
        lambdaSyntax LambdaExpressionSyntax? = nil,
        parameter ParameterSymbol? = nil
    ) bool {
        result = nil
        let lambda LambdaExpressionSyntax? = lambdaSyntax ??
            GetLambdaArgumentSyntax(argument.Syntax as ExpressionSyntax)
        if expectedType == nil || MemberLookup.TryGetExpressionTreeDelegateTypeFromSymbol(expectedType, out _) ||
            !MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(expectedType, out var targetFnType) ||
            TypeSymbol.ContainsTypeParameter(targetFnType!!) {
            return false
        }
        if lambda != nil && !IsLambdaReturnShapeCompatible(argument, expectedType, lambda) {
            Diagnostics.ReportWrongArgumentType(
                location,
                parameter?.Name ?? "value",
                expectedType,
                argument.Type ?? TypeSymbol.Error
            )
            result = BoundErrorExpression(lambda)
            return true
        }
        using let diagnosticTransaction = Diagnostics.BeginTransaction()
        var candidate BoundExpression
        if lambda != nil && bindLambdaWithTarget != nil {
            candidate = if tryGetFunctionLiteral(argument, out var naturalLiteral) && object.ReferenceEquals(
                naturalLiteral!!.FunctionType,
                targetFnType
            ) {
                cast[BoundExpression](naturalLiteral!!)
            } else {
                bindLambdaWithTarget!!(lambda, targetFnType!!)
            }
        } else if targetFnType!!.ReturnType == TypeSymbol.Void &&
            tryGetFunctionLiteral(argument, out var literal) &&
            literal!!.FunctionType is FunctionTypeSymbol literalFunctionType &&
            literalFunctionType.ReturnType != TypeSymbol.Void &&
            literalFunctionType.ReturnType != TypeSymbol.Error &&
            literalFunctionType.Arity == targetFnType!!.Arity {
            candidate = literal!!
        } else {
            return false
        }
        let converted = conversions.BindConversion(location, candidate, expectedType)
        if converted is BoundErrorExpression {
            return false
        }
        diagnosticTransaction.Commit()
        result = converted
        return true
    }

    private func TryConvertLiteralArgumentToExpressionTree(
        argument BoundExpression,
        expectedType TypeSymbol?,
        location TextLocation,
        out result BoundExpression?
    ) bool {
        result = nil
        if expectedType == nil ||
            !tryGetFunctionLiteral(argument, out var literal) ||
            !MemberLookup.TryGetExpressionTreeDelegateTypeFromSymbol(expectedType, out _) {
            return false
        }
        let converted = conversions.BindConversion(location, literal!!, expectedType)
        if converted is BoundErrorExpression {
            return false
        }
        result = converted
        return true
    }

    /// Issue #1238: eagerly binds a (named-argument-unwrapped) call/constructor
    /// argument value. When the argument is a target-typeable branchy
    /// expression (`if`/`else`, ternary, or `switch`-expression)
    /// the (cref:BinderContext.DeferTargetlessConditional) flag is set so
    /// a no-common-type unification failure is deferred (the binder returns a
    /// placeholder retaining the syntax) instead of being reported prematurely
    /// without the parameter's target type. The deferred placeholder is later
    /// re-bound by `FinalizeBranchyArgument` (or centrally by
    /// `ConversionClassifier.BindConversion`) once the applicable
    /// parameter type is known.
    /// @param inner The unwrapped argument value syntax.
    /// @returns The eagerly-bound argument (a deferred placeholder when a
    /// branchy argument could not unify without a target).
    private func BindOverloadArgumentValue(inner ExpressionSyntax) BoundExpression {
        if ExpressionBinder.IsTargetDependentBlockArgumentSyntax(inner) {
            return BoundErrorExpression(inner)
        }
        if !ExpressionBinder.IsTargetTypedBranchyArgumentSyntax(inner) {
            return bindExpression(inner)
        }
        let previous = binderCtx.DeferTargetlessConditional
        this.binderCtx.DeferTargetlessConditional = true
        try {
            return bindExpression(inner)
        } finally {
            this.binderCtx.DeferTargetlessConditional = previous
        }
    }

    /// Issue #1238: finalizes a deferred branchy-argument placeholder (produced
    /// by (cref:BindOverloadArgumentValue)) once the resolved parameter
    /// type is known. The retained branchy syntax is re-bound with
    /// [`expectedType`](paramref) as its target so each branch is
    /// target-typed (e.g. a `nil` arm widens to the parameter's nullable
    /// type). When no usable target is available the syntax is re-bound without
    /// a target so the original no-common-type diagnostic — suppressed at the
    /// deferral point — surfaces. Non-placeholder arguments are returned
    /// unchanged.
    /// @param argument The (possibly placeholder) bound argument.
    /// @param expectedType The resolved parameter target type.
    /// @returns The finalized argument.
    private func FinalizeBranchyArgument(
        argument BoundExpression,
        expectedType TypeSymbol
    ) BoundExpression -> FinalizeBranchyArgument(argument, argumentSyntax: nil, expectedType)

    /// Issue #1238 / #1480: finalizes a branchy (`if`/ternary/`switch`
    /// or `??`) call argument against the resolved parameter type. Two cases
    /// are handled: (1) a deferred placeholder (produced when the branches could
    /// not unify without a target) is re-bound with the target so each branch is
    /// target-typed; (2) Issue #1480 — a branchy argument that DID unify to a
    /// natural common type (e.g. the arms' shared base class) but whose result is
    /// not implicitly convertible to the parameter type is re-bound with the
    /// parameter type as its target, so sibling arms can unify to a contextual
    /// interface (or wider base) the consumer requires. Non-branchy arguments and
    /// arguments already convertible to the target are returned unchanged.
    /// @param argument The (possibly placeholder) bound argument.
    /// @param argumentSyntax The original argument syntax, when known.
    /// @param expectedType The resolved parameter target type.
    /// @returns The finalized argument.
    private func FinalizeBranchyArgument(
        argument BoundExpression?,
        argumentSyntax ExpressionSyntax?,
        expectedType TypeSymbol?
    ) BoundExpression {
        let targetUsable = expectedType != nil &&
            expectedType != TypeSymbol.Error &&
            expectedType != TypeSymbol.Void &&
            !TypeSymbol.ContainsTypeParameter(expectedType)
        if ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(argument!!, out var branchySyntax) {
            return if targetUsable {
                bindExpressionWithTargetType(
                    Invariant.Required(
                        branchySyntax,
                        "a deferred branchy argument has source syntax",
                        expression: "branchySyntax"
                    ),
                    Invariant.Required(
                        expectedType,
                        "a usable branchy argument target type is non-null",
                        expression: "expectedType"
                    )
                )
            } else {
                bindExpression(branchySyntax)
            }
        }
        // Issue #1480: a branchy argument that unified to its natural common type
        // (e.g. the arms' shared base class) but does not implicitly convert to
        // the parameter type is re-bound with the parameter type as its target so
        // sibling arms can unify to the contextual interface/base the call
        // requires (mirroring the return / typed-let target-typing paths).
        if targetUsable &&
            argument != nil &&
            !(argument is BoundErrorExpression) &&
            argument.Type != nil &&
            argument.Type != TypeSymbol.Error &&
            argument.Type != expectedType &&
            !Conversion
            .Classify(
            argument.Type,
            Invariant.Required(
                expectedType,
                "a usable branchy argument target type is non-null",
                expression: "expectedType"
            )
        )
            .IsImplicit {
            var inner ExpressionSyntax? = argumentSyntax
            while inner is ParenthesizedExpressionSyntax parenthesized {
                inner = parenthesized.Expression
            }
            if inner != nil && ExpressionBinder.IsTargetTypedBranchyArgumentSyntax(inner) {
                return bindExpressionWithTargetType(
                    inner,
                    Invariant.Required(
                        expectedType,
                        "a usable branchy argument target type is non-null",
                        expression: "expectedType"
                    )
                )
            }
        }
        return Invariant.Required(argument, "a finalized call argument remains bound", expression: "argument")
    }

    /// Issue #343/#3090: pre-validates duplicate names and records each source
    /// argument's optional name. Positional arguments may follow a named
    /// argument when that name occupies its natural parameter position (C# 7.2);
    /// candidate-specific mapping validates that rule later.
    /// @param arguments The call's argument syntax list.
    /// @param positionalCount On return, the number of leading positional arguments.
    /// @param argumentNames On return, the per-source-argument names (entries are `null` for positional,
    /// the name for named). The default array when no named arguments are present.
    /// @returns `true` when the layout is well-formed.
    func TryAnalyzeCallArgumentLayout(
        arguments GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
        out positionalCount int32,
        out argumentNames ImmutableArray[string]
    ) bool {
        positionalCount = 0
        argumentNames = default(ImmutableArray[string])
        if arguments.Count == 0 {
            return true
        }
        var ok = true
        var seenNames HashSet[string]? = nil
        var names[]?string = nil
        for var i = 0; i < arguments.Count; i++ {
            if arguments[i] is NamedArgumentExpressionSyntax named {
                names ??= [arguments.Count]string
                seenNames ??= HashSet[string](StringComparer.Ordinal)
                names!![i] = named.NameToken.ValueText
                if !seenNames!!.Add(named.NameToken.ValueText) {
                    Diagnostics.ReportDuplicateNamedArgument(named.NameToken.Location, named.NameToken.ValueText)
                    ok = false
                }
            } else {
                if names == nil {
                    positionalCount++
                }
            }
        }
        if names != nil {
            argumentNames = ImmutableArray.Create(names)
        }
        return ok
    }

    // Named binding stores arguments in parameter order, but evaluation remains
    // lexical. Capture converted argument values in source order inside the
    // first emitted parameter slot, then load those temps in parameter order.
    internal func PreserveNamedArgumentEvaluationOrder(
        sourceArguments GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
        parameterOrderedArguments ImmutableArray[BoundExpression],
        parameterNameAt(int32) -> string,
        parameterOffset int32 = 0
    ) ImmutableArray[BoundExpression] {
        var hasNamedArgument = false
        for argument in sourceArguments {
            hasNamedArgument |= argument is NamedArgumentExpressionSyntax
        }
        if sourceArguments.Count == 0 || !hasNamedArgument {
            return parameterOrderedArguments
        }
        let mapping = ImmutableArray.CreateBuilder[int32](sourceArguments.Count)
        for var sourceIndex = 0; sourceIndex < sourceArguments.Count; sourceIndex++ {
            if sourceArguments[sourceIndex] is not NamedArgumentExpressionSyntax named {
                mapping.Add(sourceIndex)
                continue
            }
            var parameterIndex = -1
            for var candidate = 0; candidate < parameterOrderedArguments.Length - parameterOffset; candidate++ {
                if string.Equals(parameterNameAt(candidate), named.NameToken.ValueText, StringComparison.Ordinal) {
                    parameterIndex = candidate
                    break
                }
            }
            if parameterIndex < 0 {
                return parameterOrderedArguments
            }
            mapping.Add(parameterIndex)
        }
        return PreserveMappedArgumentEvaluationOrder(
            parameterOrderedArguments,
            mapping.MoveToImmutable(),
            parameterOffset
        )
    }

    // Issue #4400: re-roots an address on captured inputs.
    private class CapturedInputRewriter : BoundTreeRewriter {
        private let replacements Dictionary[BoundExpression, BoundExpression]

        init(replacements Dictionary[BoundExpression, BoundExpression]) {
            this.replacements = replacements
        }

        func Rewrite(expression BoundExpression) BoundExpression -> RewriteExpression(expression)

        protected override func RewriteExpression(node BoundExpression) BoundExpression -> if replacements.TryGetValue(
            node,
            out var replacement
        ) {
            replacement
        } else {
            base.RewriteExpression(node)
        }
    }

    /// Issue #343: reorders source-order user-function arguments into the
    /// callee's parameter order. User-declared functions, methods, extensions
    /// and constructors do not support default parameter values, so every
    /// parameter slot must be filled — the helper validates that, reports
    /// (cref:DiagnosticBag.ReportNamedArgumentParameterNotFound) /
    /// (cref:DiagnosticBag.ReportNamedArgumentAlsoSpecifiedPositionally) /
    /// (cref:DiagnosticBag.ReportDuplicateNamedArgument) on layout
    /// violations and returns `false` to short-circuit the
    /// surrounding binder. When no named arguments are present, returns
    /// identity-mapped [`permutedSyntax`](paramref) /
    /// [`permutedBound`](paramref) so callers can use a single code path.
    /// @param sourceArguments The call's argument syntax in source order.
    /// @param sourceBound The bound arguments in source order (already unwrapped from
    /// (cref:NamedArgumentExpressionSyntax) at bind time).
    /// @param parameterCount The number of callable parameter slots (excludes any synthetic receiver slot).
    /// @param parameterNameAt Function returning the declared name of the i-th callable parameter.
    /// @param calleeName The callee name used in diagnostics.
    /// @param permutedSyntax On true, an array of length [`parameterCount`](paramref) giving the argument
    /// syntax slotted at each parameter position.
    /// @param permutedBound On true, an (cref:ImmutableArray{T}) of length [`parameterCount`](paramref)
    /// giving the bound arguments in parameter order.
    /// @returns `true` when reordering succeeds.
    internal func TryReorderUserCallArguments(
        sourceArguments GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
        sourceBound ImmutableArray[BoundExpression],
        parameterCount int32,
        parameterNameAt(int32) -> string,
        calleeName string,
        out permutedSyntax[]ExpressionSyntax?,
        out permutedBound ImmutableArray[BoundExpression]
    ) bool -> TryReorderUserCallArguments(
        sourceArguments,
        sourceBound,
        parameterCount,
        parameterNameAt,
        isOptionalAt: nil,
        calleeName,
        out permutedSyntax,
        out permutedBound
    )

    /// ADR-0063: reorders and pads call arguments to match the parameter list.
    /// When [`isOptionalAt`](paramref) is non-null, omitted optional slots
    /// are left as `null` in the result for callers to fill with
    /// default-value substitutions.
    internal func TryReorderUserCallArguments(
        sourceArguments GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
        sourceBound ImmutableArray[BoundExpression],
        parameterCount int32,
        parameterNameAt(int32) -> string,
        isOptionalAt((int32) -> bool)?,
        calleeName string,
        out permutedSyntax[]ExpressionSyntax?,
        out permutedBound ImmutableArray[BoundExpression]
    ) bool {
        permutedSyntax = [parameterCount]ExpressionSyntax?
        permutedBound = default(ImmutableArray[BoundExpression])
        if !TryAnalyzeCallArgumentLayout(sourceArguments, out var positionalCount, out var argumentNames) {
            return false
        }
        if argumentNames.IsDefault {
            // Pure positional: pad with nulls when fewer args than parameters and
            // optional slots are permitted.
            if sourceArguments.Count == parameterCount || isOptionalAt == nil {
                let identitySyntax = [sourceArguments.Count]ExpressionSyntax
                for var i = 0; i < sourceArguments.Count; i++ {
                    identitySyntax[i] = sourceArguments[i]
                }
                permutedSyntax = identitySyntax
                permutedBound = sourceBound
                return true
            }
            let paddedSyntax = [parameterCount]ExpressionSyntax
            let paddedBound = [parameterCount]BoundExpression
            let supplied = if sourceArguments.Count < parameterCount {
                sourceArguments.Count
            } else {
                parameterCount
            }
            for var i = 0; i < supplied; i++ {
                paddedSyntax[i] = sourceArguments[i]
                paddedBound[i] = sourceBound[i]
            }
            permutedSyntax = paddedSyntax
            permutedBound = ImmutableArray.Create(paddedBound)
            return true
        }
        let slotSyntax = [parameterCount]ExpressionSyntax?
        let slotBound = [parameterCount]BoundExpression
        let leadingPositional = if positionalCount < parameterCount {
            positionalCount
        } else {
            parameterCount
        }
        for var i = 0; i < leadingPositional; i++ {
            slotSyntax[i] = sourceArguments[i]
            slotBound[i] = sourceBound[i]
        }
        var ok = true
        for var i = positionalCount; i < sourceArguments.Count; i++ {
            let name string? = argumentNames[i]
            if name == nil {
                let positionalSlot = i
                if positionalSlot >= parameterCount || slotSyntax[positionalSlot] != nil {
                    Diagnostics.ReportPositionalArgumentAfterNamedArgument(sourceArguments[i].Location)
                    ok = false
                    continue
                }
                slotSyntax[positionalSlot] = sourceArguments[i]
                slotBound[positionalSlot] = sourceBound[i]
                continue
            }
            let named = cast[NamedArgumentExpressionSyntax](sourceArguments[i])
            var paramIdx = -1
            for var p = 0; p < parameterCount; p++ {
                if string.Equals(parameterNameAt(p), name, StringComparison.Ordinal) {
                    paramIdx = p
                    break
                }
            }
            if paramIdx < 0 {
                Diagnostics.ReportNamedArgumentParameterNotFound(named.NameToken.Location, calleeName, name)
                ok = false
                continue
            }
            if slotSyntax[paramIdx] != nil {
                if paramIdx < leadingPositional {
                    Diagnostics.ReportNamedArgumentAlsoSpecifiedPositionally(named.NameToken.Location, name)
                } else {
                    Diagnostics.ReportDuplicateNamedArgument(named.NameToken.Location, name)
                }
                ok = false
                continue
            }
            slotSyntax[paramIdx] = sourceArguments[i]
            slotBound[paramIdx] = sourceBound[i]
        }
        if !ok {
            return false
        }
        for var p = 0; p < parameterCount; p++ {
            if slotSyntax[p] == nil {
                // ADR-0063: empty slot is only OK when the parameter is optional;
                // the caller substitutes the default value.
                if isOptionalAt != nil && isOptionalAt(p) {
                    continue
                }
                // Caller's count check should have prevented this; defensive.
                return false
            }
        }
        permutedSyntax = slotSyntax
        permutedBound = ImmutableArray.Create(slotBound)
        return true
    }

    internal func ValidateExpandedVariadicNamedArguments(
        argumentNames ImmutableArray[string],
        fixedParameterCount int32,
        parameterNameAt(int32) -> string,
        calleeName string,
        syntax CallExpressionSyntax
    ) bool {
        if argumentNames.IsDefault {
            return true
        }
        for var sourceIndex = 0; sourceIndex < argumentNames.Length; sourceIndex++ {
            let name string? = argumentNames[sourceIndex]
            if name == nil {
                continue
            }
            // A named argument may also address the trailing variadic parameter
            // itself, exactly as C# permits for `params`: the name must be the
            // variadic parameter's, it must sit in that parameter's own slot,
            // and it must be the last argument (naming the variadic parameter
            // and then continuing to supply elements positionally is not a
            // spelling C# accepts either). Because the argument is already in
            // its own slot no reordering is needed; the value that follows is
            // either the whole carrier or a single expanded element, which
            // PackOrPassThroughVariadicArguments then decides on by type.
            let namesTrailingVariadic = sourceIndex == fixedParameterCount &&
                sourceIndex == argumentNames.Length - 1 &&
                string.Equals(parameterNameAt(sourceIndex), name, StringComparison.Ordinal)
            if namesTrailingVariadic {
                continue
            }
            if sourceIndex >= fixedParameterCount || !string.Equals(
                parameterNameAt(sourceIndex),
                name,
                StringComparison.Ordinal
            ) {
                Diagnostics.ReportNamedArgumentParameterNotFound(
                    syntax.Arguments[sourceIndex].Location,
                    calleeName,
                    name
                )
                return false
            }
        }
        return true
    }

    /// Issue #343: when overload resolution fails for a CLR call site that
    /// supplied named arguments, surface the first unknown parameter name as a
    /// dedicated diagnostic ((cref:DiagnosticBag.ReportNamedArgumentParameterNotFound))
    /// rather than the generic "unable to find function". A name is "known"
    /// when any candidate of the requested name and binding flags exposes a
    /// parameter with that name.
    /// @param receiverClrType The CLR type that hosts the candidate methods.
    /// @param methodName The method name at the call site.
    /// @param bindingFlags Reflection binding flags used to enumerate candidates.
    /// @param ce The originating call expression (for diagnostic location).
    /// @param argumentNames Per-source-argument names parallel to the call's arguments.
    /// @returns `true` when a dedicated diagnostic was emitted.
    func TryReportUnknownNamedArgumentForClr(
        receiverClrType Type,
        methodName string,
        bindingFlags BindingFlags,
        ce CallExpressionSyntax,
        argumentNames ImmutableArray[string]
    ) bool {
        var knownNames HashSet[string]? = nil
        for var i = 0; i < argumentNames.Length; i++ {
            let name string? = argumentNames[i]
            if name == nil {
                continue
            }
            knownNames ??= MemberLookup.CollectClrParameterNames(receiverClrType, methodName, bindingFlags)
            if !ContainsClrParameterName(knownNames!!, name) {
                let location = if ce.Arguments[i] is NamedArgumentExpressionSyntax named {
                    named.NameToken.Location
                } else {
                    ce.Arguments[i].Location
                }
                Diagnostics.ReportNamedArgumentParameterNotFound(location, methodName, name)
                return true
            }
        }
        return false
    }

    /// Issue #343: when overload resolution fails for a CLR <em>constructor</em>
    /// call site that supplied named arguments, surface the first unknown
    /// parameter name as a dedicated diagnostic
    /// ((cref:DiagnosticBag.ReportNamedArgumentParameterNotFound)) instead
    /// of falling back to the generic "no matching constructor" path.
    /// @param clrType The CLR type being constructed.
    /// @param ce The originating call expression (for diagnostic location).
    /// @param argumentNames Per-source-argument names parallel to the call's arguments.
    /// @returns `true` when a dedicated diagnostic was emitted.
    func TryReportUnknownNamedArgumentForClrConstructor(
        clrType Type,
        ce CallExpressionSyntax,
        argumentNames ImmutableArray[string]
    ) bool {
        var knownNames HashSet[string]? = nil
        for var i = 0; i < argumentNames.Length; i++ {
            let name string? = argumentNames[i]
            if name == nil {
                continue
            }
            knownNames ??= MemberLookup.CollectClrConstructorParameterNames(clrType)
            if !ContainsClrParameterName(knownNames!!, name) {
                let location = if ce.Arguments[i] is NamedArgumentExpressionSyntax named {
                    named.NameToken.Location
                } else {
                    ce.Arguments[i].Location
                }
                Diagnostics.ReportNamedArgumentParameterNotFound(location, clrType.Name, name)
                return true
            }
        }
        return false
    }

    func ValidateRefArguments(
        arguments ImmutableArray[BoundExpression],
        refKinds ImmutableArray[RefKind],
        methodName string,
        callLocation TextLocation
    ) {
        if refKinds.IsDefault || refKinds.Length == 0 {
            return
        }
        for var i = 0; i < refKinds.Length && i < arguments.Length; i++ {
            let rk = refKinds[i]
            if rk == RefKind.None {
                continue
            }
            if rk == RefKind.Ref || rk == RefKind.Out {
                // ADR-0061: BoundConditionalAddressExpression is also a valid
                // byref-producing argument (selects one of two addresses at
                // runtime).
                // Issue #377 sub-item 1: a BoundInterpolatedStringExpression
                // whose Handler.HandlerRefKind matches the call's by-ref slot
                // is lowered to a BoundBlockExpression whose trailing
                // expression is a BoundAddressOfExpression of the constructed
                // handler local — the address of that local is what the
                // by-ref slot consumes.
                if !(arguments[i] is BoundAddressOfExpression) &&
                    !(arguments[i] is BoundConditionalAddressExpression) &&
                    !IsByRefInterpolatedHandlerArgument(arguments[i], rk) {
                    Diagnostics.ReportArgumentMustBePassedByRef(callLocation, i + 1, methodName)
                } else if RefCapabilities.IsReadOnlyStorage(arguments[i]) {
                    Diagnostics.ReportReadOnlyArgumentForWritableRef(
                        callLocation,
                        i + 1,
                        methodName,
                        if rk == RefKind.Ref {
                            "ref"
                        } else {
                            "out"
                        }
                    )
                }
            }
            // For imported `in`: accept either &expr or a plain value. Issue
            // #4400: the CLR argument conversions have already rewritten a
            // plain value into a readonly reference (the lvalue's own address,
            // or a spilled temp's); the emitter has no value fallback.

        }
    }

    shared {
        /// Preserves lexical evaluation order after params expansion has packed
        /// several source arguments into one parameter-ordered array slot.
        internal func PreserveExpandedArgumentEvaluationOrder(
            parameterOrderedArguments ImmutableArray[BoundExpression],
            sourceToParameterMapping ImmutableArray[int32],
            receiverArgCount int32 = 0
        ) ImmutableArray[BoundExpression] {
            var sourceToParameterMapping = sourceToParameterMapping
            if parameterOrderedArguments.IsDefaultOrEmpty {
                return parameterOrderedArguments
            }
            let paramsIndex = parameterOrderedArguments.Length - 1
            if parameterOrderedArguments[paramsIndex] is not BoundArrayCreationExpression paramsArray {
                return parameterOrderedArguments
            }
            if sourceToParameterMapping.IsDefaultOrEmpty {
                if !HasHandlerSourceForwarding(parameterOrderedArguments) {
                    return parameterOrderedArguments
                }
                let positionalMapping = ImmutableArray.CreateBuilder[int32](paramsIndex + paramsArray.Elements.Length)
                for var i = 0; i < paramsIndex; i++ {
                    positionalMapping.Add(i)
                }
                for var i = 0; i < paramsArray.Elements.Length; i++ {
                    positionalMapping.Add(paramsIndex)
                }
                sourceToParameterMapping = positionalMapping.MoveToImmutable()
            }
            let fixedSlots = HashSet[int32]()
            var paramsElementIndex = 0
            // Source slot zero may be a synthesized extension receiver. Keep it
            // in the same capture map used by handler-forwarded arguments.
            for var sourceIndex = 0; sourceIndex < sourceToParameterMapping.Length; sourceIndex++ {
                let parameterIndex = sourceToParameterMapping[sourceIndex]
                if sourceIndex < receiverArgCount && parameterIndex != sourceIndex {
                    return parameterOrderedArguments
                }
                if parameterIndex == paramsIndex {
                    if paramsElementIndex >= paramsArray.Elements.Length {
                        return parameterOrderedArguments
                    }
                    paramsElementIndex++
                    continue
                }
                if parameterIndex < 0 || parameterIndex >= paramsIndex || !fixedSlots.Add(parameterIndex) {
                    return parameterOrderedArguments
                }
            }
            let replacements = parameterOrderedArguments.ToArray()
            let paramsElements = paramsArray.Elements.ToBuilder()
            let evaluations = ImmutableArray.CreateBuilder[BoundStatement]()
            let sourceCaptures = Dictionary[int32, BoundExpression]()
            paramsElementIndex = 0
            for var sourceIndex = 0; sourceIndex < sourceToParameterMapping.Length; sourceIndex++ {
                let parameterIndex = sourceToParameterMapping[sourceIndex]
                var argument = if parameterIndex == paramsIndex {
                    paramsElements[paramsElementIndex]
                } else {
                    replacements[parameterIndex]
                }
                argument = RewriteHandlerForwardedArguments(argument, sourceCaptures)
                var addressCapturedValue = false
                if argument is BoundInterpolatedStringExpression handlerArgument &&
                    handlerArgument.Handler is {HandlerRefKind: not RefKind.None} handler {
                    addressCapturedValue = true
                    argument = handlerArgument.Update(handlerArgument.Parts, handler.WithHandlerRefKind(RefKind.None))
                }
                if StatementBinder.IsNilLiteral(argument) {
                    if parameterIndex == paramsIndex {
                        paramsElementIndex++
                    }
                    continue
                }
                let temp = LocalVariableSymbol("<>expandedNamedArg$sourceIndex", isReadOnly: true, argument.Type)
                evaluations.Add(BoundVariableDeclaration(argument.Syntax, temp, argument))
                let tempLoad BoundExpression = BoundVariableExpression(argument.Syntax, temp)
                sourceCaptures[sourceIndex] = tempLoad
                var replacement = tempLoad
                if addressCapturedValue {
                    replacement = BoundAddressOfExpression(argument.Syntax, replacement)
                } else if argument.Type is ByRefTypeSymbol {
                    replacement = BoundAddressOfExpression(
                        argument.Syntax,
                        BoundDereferenceExpression(argument.Syntax, replacement)
                    )
                }
                if parameterIndex == paramsIndex {
                    paramsElements[paramsElementIndex] = replacement
                    paramsElementIndex++
                } else {
                    replacements[parameterIndex] = replacement
                }
            }
            if evaluations.Count == 0 {
                return parameterOrderedArguments
            }
            replacements[paramsIndex] = BoundArrayCreationExpression(
                paramsArray.Syntax,
                paramsArray.ContainerType,
                paramsElements.ToImmutable()
            )
            const carrier = 0
            var orderedCarrier BoundExpression = BoundBlockExpression(
                parameterOrderedArguments[carrier].Syntax,
                evaluations.ToImmutable(),
                replacements[carrier]
            )
            if replacements[carrier].Type is ByRefTypeSymbol {
                orderedCarrier = BoundAddressOfExpression(
                    parameterOrderedArguments[carrier].Syntax,
                    BoundDereferenceExpression(parameterOrderedArguments[carrier].Syntax, orderedCarrier)
                )
            }
            replacements[carrier] = orderedCarrier
            return ImmutableArray.Create(replacements)
        }

        private func HasHandlerSourceForwarding(arguments ImmutableArray[BoundExpression]) bool {
            for argument in arguments {
                if HasHandlerSourceForwarding(argument) {
                    return true
                }
            }
            return false
        }

        private func HasHandlerSourceForwarding(argument BoundExpression) bool {
            if argument is BoundInterpolatedStringExpression{Handler: {} handler} {
                for sourceIndex in handler.ForwardedSourceIndices {
                    if sourceIndex >= 0 {
                        return true
                    }
                }
            }
            if argument is BoundArrayCreationExpression array {
                for element in array.Elements {
                    if HasHandlerSourceForwarding(element) {
                        return true
                    }
                }
            }
            return false
        }

        private func RewriteHandlerForwardedArguments(
            argument BoundExpression,
            sourceCaptures IReadOnlyDictionary[int32, BoundExpression]
        ) BoundExpression {
            if !(argument is BoundInterpolatedStringExpression{Handler: {} handler} interpolated) {
                return argument
            }
            var forwarded ImmutableArray[BoundExpression].Builder? = nil
            for var i = 0; i < handler.ForwardedSourceIndices.Length; i++ {
                let sourceIndex = handler.ForwardedSourceIndices[i]
                if sourceIndex < 0 || !sourceCaptures.TryGetValue(sourceIndex, out var captured) {
                    continue
                }
                forwarded ??= handler.ForwardedArguments.ToBuilder()
                forwarded!![i] = captured
            }
            return interpolated.Update(
                interpolated.Parts,
                handler.WithCapturedForwardedArguments(forwarded?.ToImmutable() ?? handler.ForwardedArguments)
            )
        }

        /// Issue #3747: resolves the ELEMENT type of an imported `params T[]`
        /// parameter with the declaration's `[Nullable]` metadata applied.
        ///
        /// The inconsistent-sibling shape of #3705 family 2: this site read the
        /// element with a bare (cref:TypeSymbol.FromClrType), which sees only
        /// the erased CLR shape, so every `params T?[]` element bound as
        /// non-null `T` and `nil` in an expanded position was rejected
        /// with GS0155 — while every other element-of-an-imported-position reader in
        /// the binder (`GetArraySliceElementType`,
        /// `TryGetCollectionSpreadElementType`, the indexer readers) already
        /// goes through (cref:NullabilityAnnotatedTypeSymbol). Note this was
        /// never specific to a nullable params ARRAY (`params object?[]?`): a
        /// plain `params object?[]` lost its element annotation identically.
        /// @param parameter The `params` parameter.
        /// @param elementClrType The params array's CLR element type.
        /// @returns The element type symbol, nullability-annotated where the declaration says so.
        private func GetParamsElementTypeSymbol(parameter ParameterInfo, elementClrType Type) TypeSymbol {
            // The parameter's own type carries the flags; the array may itself be
            // nullable (`params object?[]?`), so peel that wrapper before reading
            // the element position out of the annotation.
            //
            // ADR-0186 §2/§5b, issue #4322: an OBLIVIOUS `params T[]` is wrapped
            // in a `PlatformTypeSymbol`, not a `NullableTypeSymbol`, so peeling
            // only the latter made this fall through to
            // `TypeSymbol.FromClrType(elementClrType)` — the ERASED answer, which
            // types the element non-null `T` and loses the obliviousness the
            // container is carrying. That is §5b's hazard one level down: the
            // container reads as `[]T!` while its element reads as `T`, so the
            // two disagree about the same declaration: an oblivious CONCRETE
            // `params string[]` reads as `[]!string!`, so its element is
            // `string!` and `nil -> string!` is legal by §3's last row. (An OPEN
            // `params T[]` element is not oblivious at all — §2 gives it the
            // substituted argument's own nullability, issue #4361 — so this peel
            // exposes whatever `ClrNullability`'s projection decided for it.)
            var parameterType = ClrNullability.GetParameterTypeSymbol(parameter)
            parameterType = switch parameterType {
                case nullableArray is NullableTypeSymbol: nullableArray.UnderlyingType
                case platformArray is PlatformTypeSymbol: platformArray.UnderlyingType
                default: parameterType
            }
            // A parameter that states nothing about its element positions (no
            // annotation wrapper) has an element type with no nullability to
            // read, which is the element CLR type as it stands.
            return if parameterType is NullabilityAnnotatedTypeSymbol annotated {
                annotated.GetTypeArgumentSymbolForClrType(elementClrType)
            } else {
                TypeSymbol.FromClrTypeWithoutNullability(elementClrType, NullabilityFreeReason.TypeStructure)
            }
        }

        /// Issue #1493: coerces a single trailing argument bound for a G# variadic
        /// (`...T`) element slot to the variadic element type, applying the same
        /// implicit conversions a fixed parameter of that type would accept —
        /// reference upcast, interface conversion, tuple-element conversions, nullable
        /// lifting, implicit constant narrowing, and user-defined implicit conversions.
        /// Returns the (possibly conversion-wrapped) argument so the emitter packs the
        /// element with the variadic element type rather than the argument's static
        /// type; reports GS0154 and sets [`hasErrors`](paramref) when no implicit
        /// conversion exists. This keeps overload applicability and final coercion in
        /// agreement with the non-variadic / array-literal element paths.
        internal func CoerceVariadicElement(
            conversions ConversionClassifier,
            diagnostics DiagnosticBag,
            argument BoundExpression,
            elementType TypeSymbol,
            location TextLocation,
            parameterName string,
            ref hasErrors bool
        ) BoundExpression {
            let argType TypeSymbol? = argument.Type
            // Unknown/error argument, or an open (unsubstituted) element type whose
            // members are erased: leave the argument untouched. Open element types
            // follow the type-erased model where the emitter boxes as needed.
            if argType == nil || argType == TypeSymbol.Error || elementType is TypeParameterSymbol {
                return Invariant.Required(argument, "a finalized call argument remains bound", expression: "argument")
            }
            if argType == elementType {
                return argument
            }
            let conversion = Conversion.Classify(argType, elementType)
            if conversion.Exists && (conversion.IsImplicit || conversion.IsIdentity) {
                return conversions.BindConversion(location, argument, elementType)
            }
            if ExpressionBinder.IsImplicitConstantNarrowingArgument(argument, elementType) {
                return conversions.BindConversion(location, argument, elementType)
            }
            if conversions.TryApplyUserDefinedImplicitArgumentConversion(argument, elementType, out var udc) {
                return udc
            }
            diagnostics.ReportWrongArgumentType(location, parameterName, elementType, argType)
            hasErrors = true
            return Invariant.Required(argument, "a finalized call argument remains bound", expression: "argument")
        }

        /// Issue #1630: single canonical implementation of the G# variadic
        /// (`...T`) call-site pack/pass-through protocol, shared by every
        /// call-binding path that can target a trailing variadic parameter (free
        /// function, instance/extension method, constructor, primary
        /// constructor, function-typed-variable indirect call, named-delegate
        /// direct call). Given the fully-bound argument list and the variadic
        /// parameter's declared (possibly type-argument-substituted) slice type,
        /// decides whether the trailing arguments are a pass-through — a single
        /// argument already typed as the slice itself, mirroring C#'s
        /// `params T[]` call-site semantics — or must be packed into a fresh
        /// (cref:BoundArrayCreationExpression). In the pack case, every
        /// trailing element is first run through (cref:CoerceVariadicElement)
        /// (issue #1493) so implicit conversions — numeric widening, interface
        /// upcast, nullable lifting, constant narrowing, user-defined implicit
        /// conversions — are applied to the element before it lands in the slice,
        /// keeping all call paths in agreement (issue #1630: this used to be
        /// duplicated by hand at each call site, and two copies had drifted to
        /// pack raw, uncoerced elements).
        /// @param conversions The conversion classifier used to bind per-element coercions; issue #1823
        /// promotes this from an instance field to a parameter so (cref:ExpressionBinder) call sites can share
        /// this helper.
        /// @param diagnostics The diagnostic bag that receives GS0154 when an element has no valid conversion;
        /// issue #1823 promotes this from an instance property to a parameter for the same reason.
        /// @param callSyntax The syntax node attributed to the packed (cref:BoundArrayCreationExpression) when
        /// packing is required.
        /// @param boundArguments The fully-bound, in-order argument list; length must be at least
        /// [`fixedCount`](paramref).
        /// @param fixedCount The number of leading fixed (non-variadic) parameters.
        /// @param carrierType The (possibly substituted) variadic parameter's carrier type — a slice for
        /// classic `...T`, or an ADR-0173 collection carrier (`...List[T]`, `...ReadOnlySpan[T]`, …).
        /// @param parameterName The variadic parameter's name, surfaced in GS0154 diagnostics for elements with
        /// no valid conversion.
        /// @param locationAt Maps a trailing argument's index in [`boundArguments`](paramref) to the source
        /// location used for its conversion diagnostics.
        /// @param hasErrors Set to `true` when any trailing element has no valid conversion to the slice's
        /// element type.
        /// @returns An argument list of length [`fixedCount`](paramref) + 1 whose final element is either the
        /// pass-through argument or the packed array.
        internal func PackOrPassThroughVariadicArguments(
            conversions ConversionClassifier,
            diagnostics DiagnosticBag,
            callSyntax SyntaxNode,
            boundArguments ImmutableArray[BoundExpression],
            fixedCount int32,
            carrierType TypeSymbol,
            parameterName string,
            locationAt(int32) -> TextLocation,
            ref hasErrors bool
        ) ImmutableArray[BoundExpression] {
            let trailingCount = boundArguments.Length - fixedCount
            let passThrough = trailingCount == 1 && Conversion.Classify(boundArguments[fixedCount].Type, carrierType)
                .IsImplicit
            let result = ImmutableArray.CreateBuilder[BoundExpression](fixedCount + 1)
            for var i = 0; i < fixedCount; i++ {
                result.Add(boundArguments[i])
            }
            if passThrough {
                result.Add(conversions.BindConversion(locationAt(fixedCount), boundArguments[fixedCount], carrierType))
                return result.MoveToImmutable()
            }
            // ADR-0173: the elements are packed into a fresh array of the
            // carrier's element type, then wrapped in the carrier's construction
            // form (identity for the array family, upcast for interface
            // carriers, `new List<T>(T[])` / span `T[]` ctor otherwise).
            let elementType = VariadicCarriers.GetElementType(carrierType)
            let packed = ImmutableArray.CreateBuilder[BoundExpression](trailingCount)
            for var i = fixedCount; i < boundArguments.Length; i++ {
                packed.Add(
                    CoerceVariadicElement(
                        conversions,
                        diagnostics,
                        boundArguments[i],
                        elementType,
                        locationAt(i),
                        parameterName,
                        &hasErrors
                    )
                )
            }
            let packedArray = BoundArrayCreationExpression(
                callSyntax,
                carrierType as SliceTypeSymbol ?? SliceTypeSymbol.Get(elementType),
                packed.MoveToImmutable()
            )
            result.Add(VariadicCarriers.WrapPackedArray(conversions, diagnostics, callSyntax, carrierType, packedArray))
            return result.MoveToImmutable()
        }

        /// ADR-0063: synthesizes a bound default-value argument for a user-defined
        /// optional parameter. The default is a CLR-Constant-table representable
        /// primitive/string previously captured on the parameter symbol; `nil`
        /// becomes a (cref:BoundDefaultExpression).
        /// @param parameter The omitted optional parameter.
        /// @returns The bound default-value argument for the omitted slot.
        internal func CreateOptionalUserDefaultArgument(parameter ParameterSymbol) BoundExpression {
            if !parameter.HasExplicitDefaultValue {
                return BoundDefaultExpression(nil, parameter.Type)
            }
            let v object? = parameter.ExplicitDefaultValue
            if v == nil {
                return BoundDefaultExpression(nil, parameter.Type)
            }
            return BoundLiteralExpression(nil, v, parameter.Type)
        }

        /// Issue #343: returns the underlying value expression for a call-argument
        /// node. When the node is a (cref:NamedArgumentExpressionSyntax)
        /// wrapper (e.g. `x: 1`), unwraps to the inner value expression so the
        /// argument is bound and post-processed against its actual payload.
        /// @param argument The call-argument syntax node.
        /// @returns The wrapped value expression when named, otherwise the node itself.
        func UnwrapNamedArgumentValue(
            argument ExpressionSyntax
        ) ExpressionSyntax -> if argument is NamedArgumentExpressionSyntax named {
            named.Expression
        } else {
            argument
        }

        /// Returns a call argument's canonical value expression for syntax-kind
        /// checks. Named-argument and parenthesis wrappers do not change whether
        /// the payload is a lambda.
        internal func UnwrapArgumentValueWrappers(argument ExpressionSyntax) ExpressionSyntax {
            var argument = argument
            while true {
                switch argument {
                    case named is NamedArgumentExpressionSyntax {
                        argument = named.Expression
                        continue
                    }
                    case parenthesized is ParenthesizedExpressionSyntax {
                        argument = parenthesized.Expression
                        continue
                    }
                    default {
                        return argument
                    }
                }
            }
        }

        internal func GetLambdaArgumentSyntax(
            argument ExpressionSyntax?
        ) LambdaExpressionSyntax? -> if argument == nil {
            default(LambdaExpressionSyntax?)
        } else {
            UnwrapArgumentValueWrappers(argument) as LambdaExpressionSyntax
        }

        /// Issue #343: re-orders source-order bound arguments into the resolved
        /// callee's parameter order, filling any unfilled (skipped) optional slots
        /// with their compile-time default expressions. Generalises
        /// (cref:ConversionClassifier.AppendOmittedOptionalArguments) to handle named arguments
        /// that target non-trailing parameter positions (so an interior optional
        /// parameter can be omitted).
        /// @param suppliedArguments Bound arguments in source order.
        /// @param parameterMapping Per-source-argument → parameter-position map; default for identity.
        /// @param parameters The resolved method's/constructor's full parameter list.
        /// @returns The argument array reordered into parameter positions, padded with defaults.
        func BuildOrderedCallArguments(
            suppliedArguments ImmutableArray[BoundExpression],
            parameterMapping ImmutableArray[int32],
            parameters[]ParameterInfo
        ) ImmutableArray[BoundExpression] {
            if parameterMapping.IsDefault {
                // No named-argument reordering required — preserve the existing
                // trailing-optional behaviour.
                let orderedArguments = ConversionClassifier.AppendOmittedOptionalArguments(
                    suppliedArguments,
                    parameters
                )
                if !HasHandlerSourceForwarding(orderedArguments) {
                    return orderedArguments
                }
                let positionalMapping = ImmutableArray.CreateBuilder[int32](suppliedArguments.Length)
                for var i = 0; i < suppliedArguments.Length; i++ {
                    positionalMapping.Add(i)
                }
                return PreserveMappedArgumentEvaluationOrder(orderedArguments, positionalMapping.MoveToImmutable())
            }
            let ordered = [parameters.Length]BoundExpression
            for var i = 0; i < suppliedArguments.Length; i++ {
                let slot = parameterMapping[i]
                ordered[slot] = suppliedArguments[i]
            }
            for var i = 0; i < parameters.Length; i++ {
                ordered[i] ??= ConversionClassifier.CreateOptionalDefaultArgument(parameters[i])
            }
            return PreserveMappedArgumentEvaluationOrder(ImmutableArray.Create(ordered), parameterMapping)
        }

        // Issue #4400: recognises the spill ConversionClassifier.CreateImplicitInReference
        // builds for an rvalue at an `in` slot — `&{ let <inArgumentN> = value; <inArgumentN> }`
        // — and returns the spilled value.
        private func TryGetImplicitInSpilledValue(
            argument BoundExpression,
            @NotNullWhen(true) out value BoundExpression?
        ) bool {
            if argument is BoundAddressOfExpression{Operand: BoundBlockExpression block} &&
                block.Statements is [BoundVariableDeclaration{Variable: var temp, Initializer: {} initializer}] &&
                block.Expression is BoundVariableExpression{Variable: var read} &&
                object.ReferenceEquals(temp, read) && ConversionClassifier.IsImplicitInTemp(temp) {
                value = initializer
                return true
            }
            value = nil
            return false
        }

        // Issue #4400: the value a reordered named `in` argument is captured as,
        // in source order, when its storage can neither stay put (see
        // IsFixedStorageAddress) nor be re-addressed from captured inputs (see
        // TryGetAddressInputs). An implicit-`in` spill captures its spilled value;
        // any other readonly (`in`) address — a ref-returning call's, a
        // dereference's — captures the value it addresses, so it still runs in
        // source order. The cost is that the callee sees a copy of that storage,
        // which a readonly reference only reveals if the storage changes during
        // the call. A by-ref local cannot hold the address instead, because a
        // named-argument temp may have to survive an `await` in a later argument.
        private func TryGetInArgumentCaptureValue(
            argument BoundExpression,
            @NotNullWhen(true) out value BoundExpression?
        ) bool {
            if TryGetImplicitInSpilledValue(argument, out value) {
                return true
            }
            if argument is BoundAddressOfExpression{IsReadOnly: true, IsUnmanaged: false} readOnlyAddress &&
                !IsFixedStorageAddress(readOnlyAddress) &&
                !TryGetAddressInputs(readOnlyAddress, out _, out _) {
                value = readOnlyAddress.Operand
                return true
            }
            value = nil
            return false
        }

        // Issue #4400: an address whose storage no later argument can redirect —
        // a variable (reassigning it changes the value at that same storage,
        // which the callee then sees exactly as in C#), a static field, or a
        // value-type field chain rooted in such storage — may stay in its
        // parameter slot when the arguments are reordered.
        private func IsFixedStorageAddress(argument BoundExpression) bool -> argument is BoundAddressOfExpression{
            IsUnmanaged: false
        } address &&
            IsFixedStorage(address.Operand)

        private func IsFixedStorage(operand BoundExpression) bool -> switch operand {
            case _ is BoundVariableExpression: true
            case boundFieldAccessExpression is BoundFieldAccessExpression when boundFieldAccessExpression.Receiver == nil: true
            case BoundFieldAccessExpression{Receiver: {} receiver} when !GSharp
                .Core
                .CodeAnalysis
                .Binding
                .Binder
                .IsReferenceTypeForConstraint(receiver.Type): IsFixedStorage(receiver)
            default: false
        }

        // Issue #4400: the inputs that select an address's storage — a reference
        // receiver (`h` in `h.F`) or an array and its index (`xs[i]`). Capturing
        // them in source order and re-taking the address from the captured values
        // passes exactly the storage C# passes, even when a later argument
        // reassigns `h`, `xs` or `i`, and keeps the aliasing.
        private func TryGetAddressInputs(
            argument BoundExpression,
            @NotNullWhen(true) out address BoundAddressOfExpression?,
            out inputs ImmutableArray[BoundExpression]
        ) bool {
            if argument is BoundAddressOfExpression{IsUnmanaged: false} candidate &&
                TryGetStorageRootInputs(candidate.Operand, out inputs) {
                address = candidate
                return true
            }
            address = nil
            inputs = default(ImmutableArray[BoundExpression])
            return false
        }

        // Walks an lvalue through value-type field links (`holder.Cell.Value`,
        // `grid[i, j].Value`) down to what actually selects its storage: a
        // reference receiver, or an array and all of its indices.
        private func TryGetStorageRootInputs(lvalue BoundExpression, out inputs ImmutableArray[BoundExpression]) bool {
            switch lvalue {
                case BoundFieldAccessExpression{Receiver: {} receiver} when GSharp
                    .Core
                    .CodeAnalysis
                    .Binding
                    .Binder
                    .IsReferenceTypeForConstraint(receiver.Type) {
                    inputs = ImmutableArray.Create(receiver)
                    return true
                }
                case BoundFieldAccessExpression{Receiver: {} valueReceiver} {
                    return TryGetStorageRootInputs(valueReceiver, out inputs)
                }
                case BoundIndexExpression{IsArrayBackedElementAccess: true} element {
                    inputs = ImmutableArray.Create(element.Target).AddRange(element.Indices)
                    return true
                }
                default {
                    inputs = default(ImmutableArray[BoundExpression])
                    return false
                }
            }
        }

        private func PreserveMappedArgumentEvaluationOrder(
            parameterOrderedArguments ImmutableArray[BoundExpression],
            sourceToParameterMapping ImmutableArray[int32],
            parameterOffset int32 = 0
        ) ImmutableArray[BoundExpression] {
            if sourceToParameterMapping.IsDefaultOrEmpty ||
                parameterOffset < 0 ||
                parameterOffset >= parameterOrderedArguments.Length {
                return parameterOrderedArguments
            }
            let seenSlots = HashSet[int32]()
            var reordered = false
            let hasHandlerSourceForwarding = HasHandlerSourceForwarding(parameterOrderedArguments)
            for var sourceIndex = 0; sourceIndex < sourceToParameterMapping.Length; sourceIndex++ {
                let parameterIndex = sourceToParameterMapping[sourceIndex]
                let slot = parameterOffset + parameterIndex
                if parameterIndex < 0 || slot >= parameterOrderedArguments.Length || !seenSlots.Add(slot) {
                    return parameterOrderedArguments
                }
                reordered |= parameterIndex != sourceIndex
                // Issue #4400: an address stays in its slot when its storage is
                // fixed, is re-taken from inputs captured in source order when a
                // receiver/index selects it, and an `in` one is otherwise captured
                // by value. Only a remaining `ref`/`out` address still forgoes
                // reordering, as before.
                if !hasHandlerSourceForwarding &&
                    (
                    parameterOrderedArguments[slot] is BoundAddressOfExpression or BoundConditionalAddressExpression
                ) &&
                    !TryGetInArgumentCaptureValue(parameterOrderedArguments[slot], out _) &&
                    !IsFixedStorageAddress(parameterOrderedArguments[slot]) &&
                    !TryGetAddressInputs(parameterOrderedArguments[slot], out _, out _) {
                    return parameterOrderedArguments
                }
            }
            if !reordered && !hasHandlerSourceForwarding {
                return parameterOrderedArguments
            }
            let replacements = parameterOrderedArguments.ToArray()
            let evaluations = ImmutableArray.CreateBuilder[BoundStatement](sourceToParameterMapping.Length)
            let sourceCaptures = Dictionary[int32, BoundExpression]()
            for var sourceIndex = 0; sourceIndex < sourceToParameterMapping.Length; sourceIndex++ {
                let slot = parameterOffset + sourceToParameterMapping[sourceIndex]
                var argument = parameterOrderedArguments[slot]
                // Issue #4400: an `in` argument evaluates its VALUE here, in source
                // order, into the named-argument temp whose address is passed; a
                // plain variable's address needs no capture at all.
                var implicitInSpill = false
                var captureType TypeSymbol? = nil
                if TryGetInArgumentCaptureValue(argument, out var spilledValue) {
                    // The capture temp takes the SLOT's pointee type, not the
                    // value's: an implicit-`in` spill may hold a narrower value
                    // (`FormattableString` at `in IFormattable`) whose own type
                    // would make the passed address `FormattableString&`.
                    captureType = if TypeSymbol.TryGetPointeeType(argument.Type, out var slotPointee) {
                        slotPointee
                    } else {
                        default(TypeSymbol?)
                    }
                    argument = spilledValue
                    implicitInSpill = true
                } else if IsFixedStorageAddress(argument) {
                    replacements[slot] = argument
                    continue
                } else if TryGetAddressInputs(argument, out var inputAddress, out var inputs) {
                    let inputTemps = Dictionary[BoundExpression, BoundExpression](ReferenceEqualityComparer.Instance)
                    for var inputIndex = 0; inputIndex < inputs.Length; inputIndex++ {
                        let input = inputs[inputIndex]
                        let inputTemp = LocalVariableSymbol(
                            "<>namedArg${sourceIndex}_$inputIndex",
                            isReadOnly: true,
                            input.Type
                        )
                        evaluations.Add(BoundVariableDeclaration(input.Syntax, inputTemp, input))
                        inputTemps[input] = BoundVariableExpression(input.Syntax, inputTemp)
                    }
                    replacements[slot] = BoundAddressOfExpression(
                        inputAddress.Syntax,
                        CapturedInputRewriter(inputTemps).Rewrite(inputAddress.Operand),
                        unmanaged: false,
                        inputAddress.IsReadOnly
                    )
                    continue
                }
                argument = RewriteHandlerForwardedArguments(argument, sourceCaptures)
                var addressCapturedValue = implicitInSpill
                if argument is BoundInterpolatedStringExpression handlerArgument &&
                    handlerArgument.Handler is {HandlerRefKind: not RefKind.None} handler {
                    addressCapturedValue = true
                    argument = handlerArgument.Update(handlerArgument.Parts, handler.WithHandlerRefKind(RefKind.None))
                }
                if StatementBinder.IsNilLiteral(argument) {
                    // A nil literal has no evaluation to preserve. Capturing it
                    // would create a local whose type is `nil`, which has no CLR
                    // signature representation; leave it in its parameter slot.
                    // Issue #4400: an `in` nil keeps its original typed spill,
                    // since the slot needs an address, not the bare value.
                    replacements[slot] = if implicitInSpill {
                        parameterOrderedArguments[slot]
                    } else {
                        argument
                    }
                    continue
                }
                let temp = LocalVariableSymbol("<>namedArg$sourceIndex", isReadOnly: true, captureType ?? argument.Type)
                evaluations.Add(BoundVariableDeclaration(argument.Syntax, temp, argument))
                let tempLoad BoundExpression = BoundVariableExpression(argument.Syntax, temp)
                sourceCaptures[sourceIndex] = tempLoad
                var replacement = tempLoad
                if addressCapturedValue {
                    replacement = BoundAddressOfExpression(argument.Syntax, replacement)
                } else if argument.Type is ByRefTypeSymbol {
                    replacement = BoundAddressOfExpression(
                        argument.Syntax,
                        BoundDereferenceExpression(argument.Syntax, replacement)
                    )
                }
                replacements[slot] = replacement
            }
            let carrier = parameterOffset
            var orderedCarrier BoundExpression = BoundBlockExpression(
                parameterOrderedArguments[carrier].Syntax,
                evaluations.ToImmutable(),
                replacements[carrier]
            )
            if replacements[carrier].Type is ByRefTypeSymbol {
                orderedCarrier = BoundAddressOfExpression(
                    parameterOrderedArguments[carrier].Syntax,
                    BoundDereferenceExpression(parameterOrderedArguments[carrier].Syntax, orderedCarrier)
                )
            }
            replacements[carrier] = orderedCarrier
            return ImmutableArray.Create(replacements)
        }

        /// Issue #343: returns the first non-null name in [`argumentNames`](paramref),
        /// used as the offending name when reporting
        /// (cref:DiagnosticBag.ReportNamedArgumentParameterNotFound) at call sites
        /// where the callee does not expose parameter names (delegate-typed variables,
        /// variadic functions, etc.). Callers should only invoke this when at least one
        /// entry is non-null.
        func FirstNamedArgumentName(argumentNames ImmutableArray[string]) string {
            if argumentNames.IsDefault {
                return string.Empty
            }
            for var i = 0; i < argumentNames.Length; i++ {
                if argumentNames[i] != nil {
                    return argumentNames[i]
                }
            }
            return string.Empty
        }

        private func ContainsClrParameterName(parameterNames IEnumerable[string], name string) bool {
            let names = parameterNames.ToArray()
            for parameterName in names {
                if ClrParameterNameMatches(parameterName, name, names) {
                    return true
                }
            }
            return false
        }

        // Metadata names are semantic identifiers; retain the collision-safe
        // sanitizer spelling accepted by older G# callers as an alias.
        internal func ClrParameterNameMatches(
            parameterName string,
            argumentName string,
            parameterNames IEnumerable[string]
        ) bool -> string.Equals(parameterName, argumentName, StringComparison.Ordinal) || string.Equals(
            SyntaxFacts.GetEmittedIdentifier(parameterName, IdentifierNameContext.Parameter, parameterNames),
            argumentName,
            StringComparison.Ordinal
        )

        private func IsByRefInterpolatedHandlerArgument(argument BoundExpression, expected RefKind) bool {
            return argument is BoundInterpolatedStringExpression interp &&
                interp.Handler != nil &&
                interp
                .Handler
                .HandlerRefKind == expected
        }
    }
}
