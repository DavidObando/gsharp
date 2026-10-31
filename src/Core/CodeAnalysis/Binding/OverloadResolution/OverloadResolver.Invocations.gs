// <copyright file="OverloadResolver.Invocations.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding.OverloadResolution

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Documentation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq
import System.Reflection

internal partial class OverloadResolver {
    /// Issue #1213 / #1221: lowers a call through a delegate/function-typed
    /// variable to a (cref:BoundIndirectCallExpression). When the
    /// variable is the implicit backing-field of a field-like event (an
    /// (cref:ImplicitFieldVariableSymbol)) the callee is loaded as a
    /// field read on `this` (e.g. `ldfld Base::Changed`) — including a
    /// backing field declared on a base class, so an inherited event can be
    /// raised from a derived type — rather than a (non-existent) local slot.
    ///
    /// The null-conditional invocation form `Ev?(args)` is guarded by a
    /// null check (a (cref:BoundNullConditionalAccessExpression)) so a
    /// null delegate short-circuits, mirroring `Ev?.Invoke(args)`. A
    /// `void` delegate yields a plain no-op; Issue #2798: a value-returning
    /// delegate yields the correct optional/null result via the established
    /// result-slot lowering instead of NRE-ing (or silently dropping the
    /// `?` and producing a non-optional result). Issue #2799 follow-up:
    /// this guard applies uniformly across <b>every</b> receiver kind reaching
    /// this path — implicit field-like event backing field, bare static field
    /// or property, and a plain local or parameter — not only the field-like
    /// event originally handled. The receiver is evaluated exactly once.
    private func BuildIndirectDelegateCall(
        syntax CallExpressionSyntax,
        variable VariableSymbol,
        fnType FunctionTypeSymbol,
        args ImmutableArray[BoundExpression],
        narrowedTargetType TypeSymbol? = nil,
        argumentRefKinds ImmutableArray[RefKind] = default(ImmutableArray[RefKind])
    ) BoundExpression {
        // Compute the receiver load and its static type for each variable
        // kind. Every non-null-conditional call below reduces to a plain
        // `BoundIndirectCallExpression` on this receiver load; the null-
        // conditional form additionally guards it (see below).
        //
        // Issue #2066: a smart-cast-narrowed local (and, for the fallthrough
        // below, any local/parameter) carries the narrowed (non-nullable,
        // possibly named-delegate) type so the emitter's
        // `call.Target.Type is DelegateTypeSymbol` check in EmitIndirectCall
        // dispatches through the named delegate's own Invoke MethodDef instead
        // of the type-erased native-function Invoke, which would otherwise
        // mismatch the value's actual runtime (named-delegate) shape and fail
        // IL verification.
        var receiverLoad = BuildCalleeLoad(variable, syntax.Identifier, narrowedTargetType)
        let receiverType = receiverLoad.Type ?? narrowedTargetType ?? variable.Type
        // Issue #1213 / #2798 / #2799 follow-up: the null-conditional
        // invocation form `Ev?(args)` of a structural function-typed value
        // must short-circuit when the delegate is null, evaluating the
        // receiver exactly once. The `void`-returning form is a plain no-op;
        // a value-returning form yields the correct optional/null result via
        // the established result-slot lowering rather than NRE-ing (or, worse,
        // silently dropping the `?` and producing a non-optional result). This
        // applies uniformly across every receiver kind that reaches this path
        // — implicit backing field of a field-like event, bare static field or
        // property, and a plain local or parameter — not just the field-like
        // event handled originally.
        if syntax.NullableQuestionToken != nil {
            if receiverLoad is BoundErrorExpression {
                return receiverLoad
            }
            let captureName = "$$ncap_" + (binderCtx.NullConditionalCaptureCounter += 1).ToString(
                CultureInfo.InvariantCulture
            )
            // ADR-0186: the guard above already tests for nil, so a platform
            // receiver needs no §4 check here — only its wrapper removed, so
            // the emitter still sees a named delegate as one.
            let capture = LocalVariableSymbol(
                captureName,
                isReadOnly: true,
                type: PlatformTypeSymbol.StripTopLevel(receiverType)
            )
            let invoke = BoundIndirectCallExpression(
                nil,
                BoundVariableExpression(nil, capture),
                fnType,
                args,
                argumentRefKinds
            )
            return BuildNullConditionalDelegateResult(syntax, receiverLoad, capture, invoke, fnType.ReturnType)
        }
        // ADR-0186 §4, issue #4325: invoking a platform function value
        // (`f(x)` where `f` is declared in an ADR-0186 §9 oblivious scope) is
        // a coercion to non-null like every other delegate invocation target.
        receiverLoad = PlatformCoercion.CheckDelegateInvocationTarget(receiverLoad, syntax.Identifier.Location)
        return BoundIndirectCallExpression(nil, receiverLoad, fnType, args, argumentRefKinds)
    }

    /// Wraps a null-conditional delegate/event invocation in a
    /// (cref:BoundNullConditionalAccessExpression) that short-circuits
    /// when the captured receiver is null. A `void`-returning invocation
    /// leaves no value (a plain no-op null branch); a value-returning
    /// invocation adopts the established result-slot lowering — the result type
    /// is the nullable wrapping of [`returnType`](paramref), and a
    /// value-type return additionally allocates a `$nres_` slot so the null
    /// branch can materialize `default(Nullable<T>)`. Shared by the
    /// CLR-delegate call path (`OverloadResolver.CallBinding`) and the
    /// structural (cref:FunctionTypeSymbol) path
    /// ((cref:BuildIndirectDelegateCall)). The caller must have already
    /// incremented `binderCtx.NullConditionalCaptureCounter` for the
    /// capture; this method reuses that same value for the result slot.
    private func BuildNullConditionalDelegateResult(
        syntax CallExpressionSyntax,
        receiverLoad BoundExpression,
        capture VariableSymbol,
        whenNotNull BoundExpression,
        returnType TypeSymbol
    ) BoundExpression {
        if object.ReferenceEquals(returnType, TypeSymbol.Void) {
            return BoundNullConditionalAccessExpression(
                syntax,
                receiverLoad,
                capture,
                whenNotNull,
                TypeSymbol.Void,
                resultSlot: nil
            )
        }
        let resultType = if returnType is NullableTypeSymbol {
            returnType
        } else {
            cast[TypeSymbol](NullableTypeSymbol.Get(returnType))
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
        return BoundNullConditionalAccessExpression(syntax, receiverLoad, capture, whenNotNull, resultType, resultSlot)
    }

    private func TryBindNullableDelegateInvocation(
        variable VariableSymbol,
        syntax CallExpressionSyntax,
        boundArguments ImmutableArray[BoundExpression],
        argumentNames ImmutableArray[string],
        out result BoundExpression
    ) bool {
        result = BoundErrorExpression(nil)
        if syntax.NullableQuestionToken == nil ||
            variable.Type is not NullableTypeSymbol nullable ||
            !MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(nullable.UnderlyingType, out var functionType) {
            return false
        }
        let delegateLoad = BuildCalleeLoad(variable, syntax.Identifier, narrowedType: nil)
        if delegateLoad is BoundErrorExpression {
            result = delegateLoad
            return true
        }
        let captureName = "$$ncap_" + (binderCtx.NullConditionalCaptureCounter += 1).ToString(
            CultureInfo.InvariantCulture
        )
        let capture = LocalVariableSymbol(captureName, isReadOnly: true, type: nullable.UnderlyingType)
        let captureRef = BoundVariableExpression(nil, capture)
        var whenNotNull BoundExpression?
        if !(nullable.UnderlyingType is FunctionTypeSymbol) &&
            !(nullable.UnderlyingType is DelegateTypeSymbol) &&
            nullable
            .UnderlyingType
            .ClrType is Type delegateClr &&
            ClrTypeUtilities
            .IsDelegateType(delegateClr) {
            // The callback uses null to mean that no explicit type arguments were supplied.
            if !tryBindInheritedClrInstanceCall(
                captureRef,
                delegateClr,
                "Invoke",
                boundArguments,
                syntax,
                out whenNotNull,
                nil,
                default(ImmutableArray[TypeSymbol]),
                argumentNames,
                false
            ) {
                result = BoundErrorExpression(nil)
                return true
            }
        } else {
            if nullable.UnderlyingType is DelegateTypeSymbol namedDelegate {
                if !TryBindNamedDelegateArguments(
                    variable.Name,
                    namedDelegate,
                    syntax,
                    boundArguments,
                    out var namedArgs,
                    out var namedRefKinds
                ) {
                    result = BoundErrorExpression(nil)
                    return true
                }
                whenNotNull = BoundIndirectCallExpression(nil, captureRef, functionType!!, namedArgs, namedRefKinds)
            } else if !TryBindFunctionTypeArguments(
                variable.Name,
                functionType!!,
                syntax,
                boundArguments,
                variable.CallableParameterNames,
                out var convertedArgs
            ) {
                result = BoundErrorExpression(nil)
                return true
            } else {
                whenNotNull = BoundIndirectCallExpression(nil, captureRef, functionType!!, convertedArgs)
            }
        }
        if object.ReferenceEquals(functionType!!.ReturnType, TypeSymbol.Void) {
            result = BoundNullConditionalAccessExpression(
                syntax,
                delegateLoad,
                capture,
                whenNotNull!!,
                TypeSymbol.Void,
                resultSlot: nil
            )
            return true
        }
        let resultType = if functionType!!.ReturnType is NullableTypeSymbol {
            functionType!!.ReturnType
        } else {
            cast[TypeSymbol](NullableTypeSymbol.Get(functionType!!.ReturnType))
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
        result = BoundNullConditionalAccessExpression(
            syntax,
            delegateLoad,
            capture,
            whenNotNull!!,
            resultType,
            resultSlot
        )
        return true
    }

    internal func BindFunctionPointerInvocation(
        syntax CallExpressionSyntax,
        pointer BoundExpression,
        functionPointerType FunctionPointerTypeSymbol,
        calleeName string,
        calleeLocation TextLocation,
        boundArguments ImmutableArray[BoundExpression],
        argumentNames ImmutableArray[string],
        parameterNames ImmutableArray[string] = default(ImmutableArray[string])
    ) BoundExpression {
        if functionPointerType.IsManaged && !binderCtx.InUnsafeContext {
            Diagnostics.ReportUnmanagedPointerOutsideUnsafe(calleeLocation)
            return BoundErrorExpression(nil)
        }
        if syntax.Arguments.Count != functionPointerType.Arity {
            Diagnostics.ReportWrongArgumentCount(
                calleeLocation,
                calleeName,
                functionPointerType.Arity,
                syntax.Arguments.Count
            )
            return BoundErrorExpression(nil)
        }
        let parameterNameAt(int32) -> string = (parameterIndex int32) -> parameterNames[parameterIndex]
        var parameterSyntax[]ExpressionSyntax?
        var arguments = boundArguments
        if !argumentNames.IsDefault {
            if parameterNames.IsDefaultOrEmpty || parameterNames.Length != functionPointerType.Arity {
                Diagnostics.ReportNamedArgumentParameterNotFound(
                    calleeLocation,
                    calleeName,
                    FirstNamedArgumentName(argumentNames)
                )
                return BoundErrorExpression(nil)
            }
            if !TryReorderUserCallArguments(
                syntax.Arguments,
                arguments,
                functionPointerType.Arity,
                parameterNameAt,
                calleeName,
                out parameterSyntax,
                out arguments
            ) {
                return BoundErrorExpression(nil)
            }
        } else {
            parameterSyntax = [syntax.Arguments.Count]ExpressionSyntax
            for var i = 0; i < syntax.Arguments.Count; i++ {
                parameterSyntax[i] = syntax.Arguments[i]
            }
        }
        let convertedArguments = ImmutableArray.CreateBuilder[BoundExpression](functionPointerType.Arity)
        for var i = 0; i < functionPointerType.Arity; i++ {
            let argumentLocation = if i < parameterSyntax.Length {
                parameterSyntax[i]?.Location ?? calleeLocation
            } else {
                calleeLocation
            }
            convertedArguments.Add(
                conversions.BindConversion(argumentLocation, arguments[i], functionPointerType.ParameterTypes[i])
            )
        }
        let finalArguments = PreserveNamedArgumentEvaluationOrder(
            syntax.Arguments,
            convertedArguments.MoveToImmutable(),
            parameterNameAt
        )
        return BoundFunctionPointerInvocationExpression(syntax, pointer, finalArguments, functionPointerType)
    }

    private func TryBindFunctionTypeArguments(
        calleeName string,
        functionType FunctionTypeSymbol,
        syntax CallExpressionSyntax,
        boundArguments ImmutableArray[BoundExpression],
        parameterNames ImmutableArray[string],
        out convertedArgs ImmutableArray[BoundExpression]
    ) bool {
        convertedArgs = default(ImmutableArray[BoundExpression])
        let isVariadic = functionType.HasVariadic
        let fixedCount = if isVariadic {
            functionType.Arity - 1
        } else {
            functionType.Arity
        }
        if isVariadic {
            if syntax.Arguments.Count < fixedCount {
                Diagnostics.ReportTooFewArgumentsForVariadic(
                    syntax.Identifier.Location,
                    calleeName,
                    fixedCount,
                    syntax.Arguments.Count
                )
                return false
            }
        } else if syntax.Arguments.Count != functionType.Arity {
            Diagnostics.ReportWrongArgumentCount(
                syntax.Identifier.Location,
                calleeName,
                functionType.Arity,
                syntax.Arguments.Count
            )
            return false
        }
        var parameterSyntax[]ExpressionSyntax?
        var permutedArgs = boundArguments
        let parameterNameAt(int32) -> string = (parameterIndex int32) -> parameterNames[parameterIndex]
        var hasNamedArguments = false
        var firstNamedArgumentName = string.Empty
        for argument in syntax.Arguments {
            if argument is NamedArgumentExpressionSyntax namedArgument {
                hasNamedArguments = true
                firstNamedArgumentName = namedArgument.NameToken.ValueText
                break
            }
        }
        if hasNamedArguments {
            if parameterNames.IsDefaultOrEmpty || parameterNames.Length != functionType.Arity {
                Diagnostics.ReportNamedArgumentParameterNotFound(
                    syntax.Identifier.Location,
                    calleeName,
                    firstNamedArgumentName
                )
                return false
            }
            if isVariadic {
                if !TryAnalyzeCallArgumentLayout(syntax.Arguments, out _, out var argumentNames) ||
                    !ValidateExpandedVariadicNamedArguments(
                    argumentNames,
                    fixedCount,
                    parameterNameAt,
                    calleeName,
                    syntax
                ) {
                    return false
                }
                parameterSyntax = syntax.Arguments.ToArray()
            } else if !TryReorderUserCallArguments(
                syntax.Arguments,
                boundArguments,
                functionType.Arity,
                parameterNameAt,
                calleeName,
                out parameterSyntax,
                out permutedArgs
            ) {
                return false
            }
        } else {
            parameterSyntax = [syntax.Arguments.Count]ExpressionSyntax
            for var i = 0; i < syntax.Arguments.Count; i++ {
                parameterSyntax[i] = syntax.Arguments[i]
            }
        }
        if isVariadic {
            // Issue #1630: pack/pass-through through the canonical helper
            // (applies #1493 element coercion when packing).
            let sliceType = functionType.ParameterTypes[functionType.Arity - 1]
            var hasElementErrors = false
            let argumentLocation(int32) -> TextLocation = (argumentIndex int32) -> syntax
                .Arguments[argumentIndex]
                .Location
            permutedArgs = PackOrPassThroughVariadicArguments(
                conversions,
                Diagnostics,
                syntax,
                boundArguments,
                fixedCount,
                sliceType,
                calleeName,
                argumentLocation,
                &hasElementErrors
            )
            if hasElementErrors {
                return false
            }
        }
        let convertedBuilder = ImmutableArray.CreateBuilder[BoundExpression](permutedArgs.Length)
        for var i = 0; i < permutedArgs.Length; i++ {
            let argLoc = if i < parameterSyntax.Length {
                parameterSyntax[i]?.Location ?? syntax.Identifier.Location
            } else {
                syntax.Identifier.Location
            }
            var argument = permutedArgs[i]
            let argSyntax = if i < parameterSyntax.Length && parameterSyntax[i] is {} parameterExpression {
                UnwrapNamedArgumentValue(parameterExpression)
            } else {
                default(ExpressionSyntax?)
            }
            if GetLambdaArgumentSyntax(argSyntax) is {} lambdaSyntax &&
                bindLambdaWithTarget != nil &&
                IsUntypedArrowLambda(lambdaSyntax) &&
                functionType.ParameterTypes[i] is FunctionTypeSymbol lambdaTarget {
                argument = bindLambdaWithTarget!!(lambdaSyntax, lambdaTarget)
            }
            convertedBuilder.Add(conversions.BindConversion(argLoc, argument, functionType.ParameterTypes[i]))
        }
        convertedArgs = PreserveNamedArgumentEvaluationOrder(
            syntax.Arguments,
            convertedBuilder.MoveToImmutable(),
            parameterNameAt
        )
        return true
    }

    internal func TryBindNamedDelegateArguments(
        calleeName string,
        delegateType DelegateTypeSymbol,
        syntax CallExpressionSyntax,
        boundArguments ImmutableArray[BoundExpression],
        out convertedArgs ImmutableArray[BoundExpression],
        out argumentRefKinds ImmutableArray[RefKind]
    ) bool {
        convertedArgs = default(ImmutableArray[BoundExpression])
        argumentRefKinds = default(ImmutableArray[RefKind])
        let parameters = delegateType.Parameters
        let parameterNameAt(int32) -> string = (parameterIndex int32) -> parameters[parameterIndex].Name
        let parameterIsOptional(int32) -> bool = (parameterIndex int32) -> parameters[
            parameterIndex
        ].HasExplicitDefaultValue
        let isVariadic = parameters.Length > 0 && parameters[parameters.Length - 1].IsVariadic
        let fixedCount = if isVariadic {
            parameters.Length - 1
        } else {
            parameters.Length
        }
        if isVariadic {
            if syntax.Arguments.Count < fixedCount {
                Diagnostics.ReportTooFewArgumentsForVariadic(
                    syntax.Identifier.Location,
                    calleeName,
                    fixedCount,
                    syntax.Arguments.Count
                )
                return false
            }
        } else if syntax.Arguments.Count != parameters.Length {
            var requiredCount = parameters.Length
            while requiredCount > 0 && parameters[requiredCount - 1].HasExplicitDefaultValue {
                requiredCount--
            }
            if syntax.Arguments.Count < requiredCount || syntax.Arguments.Count > parameters.Length {
                Diagnostics.ReportWrongArgumentCount(
                    syntax.Identifier.Location,
                    calleeName,
                    parameters.Length,
                    syntax.Arguments.Count
                )
                return false
            }
        }
        if !TryAnalyzeCallArgumentLayout(syntax.Arguments, out _, out var argumentNames) {
            return false
        }
        var parameterSyntax[]ExpressionSyntax?
        var arguments = boundArguments
        if !argumentNames.IsDefault && !isVariadic {
            if !TryReorderUserCallArguments(
                syntax.Arguments,
                boundArguments,
                parameters.Length,
                parameterNameAt,
                parameterIsOptional,
                calleeName,
                out parameterSyntax,
                out arguments
            ) {
                return false
            }
            let filled = arguments.ToBuilder()
            for var i = 0; i < filled.Count; i++ {
                filled[i] ??= CreateOptionalUserDefaultArgument(parameters[i])
            }
            arguments = filled.MoveToImmutable()
        } else {
            if isVariadic &&
                !ValidateExpandedVariadicNamedArguments(
                argumentNames,
                fixedCount,
                parameterNameAt,
                calleeName,
                syntax
            ) {
                return false
            }
            parameterSyntax = [syntax.Arguments.Count]ExpressionSyntax
            for var i = 0; i < syntax.Arguments.Count; i++ {
                parameterSyntax[i] = syntax.Arguments[i]
            }
        }
        if isVariadic {
            let variadicParameter = parameters[parameters.Length - 1]
            var hasElementErrors = false
            arguments = PackOrPassThroughVariadicArguments(
                conversions,
                Diagnostics,
                syntax,
                arguments,
                fixedCount,
                variadicParameter.Type,
                variadicParameter.Name,
                (i int32) -> {
                    return if i < syntax.Arguments.Count {
                        syntax.Arguments[i].Location
                    } else {
                        syntax.Location
                    }
                },
                &hasElementErrors
            )
            if hasElementErrors {
                return false
            }
        } else if arguments.Length < parameters.Length {
            let padded = ImmutableArray.CreateBuilder[BoundExpression](parameters.Length)
            padded.AddRange(arguments)
            for var i = arguments.Length; i < parameters.Length; i++ {
                padded.Add(CreateOptionalUserDefaultArgument(parameters[i]))
            }
            arguments = padded.MoveToImmutable()
        }
        var hasRefKinds = false
        let refKinds = ImmutableArray.CreateBuilder[RefKind](parameters.Length)
        let converted = ImmutableArray.CreateBuilder[BoundExpression](arguments.Length)
        var hasErrors = false
        for var i = 0; i < arguments.Length; i++ {
            let parameter = parameters[i]
            refKinds.Add(parameter.RefKind)
            hasRefKinds |= parameter.RefKind != RefKind.None
            var argument = arguments[i]
            let argumentSyntax = if i < parameterSyntax.Length && parameterSyntax[i] is {} parameterExpression {
                UnwrapNamedArgumentValue(parameterExpression)
            } else {
                default(ExpressionSyntax?)
            }
            let argumentLocation = argumentSyntax?.Location ?? syntax.Identifier.Location
            if parameter.RefKind != RefKind.None || argumentSyntax is RefArgumentExpressionSyntax {
                var argumentRefKind = if argumentSyntax is RefArgumentExpressionSyntax refArgument {
                    getRefKindFromModifier(refArgument.RefKindModifier)
                } else {
                    RefKind.None
                }
                if argumentRefKind == RefKind.None &&
                    (argument is BoundAddressOfExpression or BoundConditionalAddressExpression) &&
                    parameter.RefKind != RefKind.None {
                    argumentRefKind = parameter.RefKind
                }
                if argumentRefKind != parameter.RefKind {
                    if parameter.RefKind == RefKind.In && argumentRefKind == RefKind.None {
                        // Issue #4400: pass a readonly reference, as in C#. An
                        // untyped lambda is target-bound first, exactly as at
                        // a by-value delegate parameter.
                        if GetLambdaArgumentSyntax(argumentSyntax) is {} inLambdaSyntax &&
                            bindLambdaWithTarget != nil &&
                            IsUntypedArrowLambda(inLambdaSyntax) &&
                            parameter.Type is FunctionTypeSymbol inLambdaTarget {
                            argument = bindLambdaWithTarget!!(inLambdaSyntax, inLambdaTarget)
                        }
                        let implicitIn = conversions.BindImplicitInArgument(
                            argumentLocation,
                            argument,
                            parameter.Type,
                            parameter
                        )
                        hasErrors |= implicitIn is BoundErrorExpression
                        converted.Add(implicitIn)
                        continue
                    }
                    Diagnostics.ReportRefKindMismatch(
                        argumentLocation,
                        i + 1,
                        parameter.Name,
                        refKindToString(parameter.RefKind),
                        refKindToString(argumentRefKind)
                    )
                    hasErrors = true
                    converted.Add(argument)
                    continue
                }
                if argument is BoundAddressOfExpression address {
                    if address
                        .Operand
                        .Type == TypeSymbol.Error &&
                        argumentSyntax is RefArgumentExpressionSyntax inlineOut &&
                        inlineOut.IsInlineDeclaration &&
                        inlineOut.DeclaredType == nil {
                        argument = bindRefArgumentExpression(inlineOut, parameter)
                    } else if address.Operand.Type != TypeSymbol.Error && !conversions.CheckByRefArgumentStorage(
                        argumentLocation,
                        parameter,
                        address.Operand.Type,
                        parameter.Type
                    ) {
                        conversions.ReportByRefStorageMismatch(
                            argumentLocation,
                            parameter.Name,
                            parameter.Type,
                            address.Operand.Type
                        )
                        hasErrors = true
                    }
                } else if argument is BoundConditionalAddressExpression conditionalAddress {
                    if conditionalAddress.PointeeType != TypeSymbol.Error && !conversions.CheckByRefArgumentStorage(
                        argumentLocation,
                        parameter,
                        conditionalAddress.PointeeType,
                        parameter.Type
                    ) {
                        conversions.ReportByRefStorageMismatch(
                            argumentLocation,
                            parameter.Name,
                            parameter.Type,
                            conditionalAddress.PointeeType
                        )
                        hasErrors = true
                    }
                } else {
                    Diagnostics.ReportWrongArgumentType(argumentLocation, parameter.Name, parameter.Type, argument.Type)
                    hasErrors = true
                }
                converted.Add(argument)
                continue
            }
            if GetLambdaArgumentSyntax(argumentSyntax) is {} lambdaSyntax &&
                bindLambdaWithTarget != nil &&
                IsUntypedArrowLambda(lambdaSyntax) &&
                parameter.Type is FunctionTypeSymbol lambdaTarget {
                argument = bindLambdaWithTarget!!(lambdaSyntax, lambdaTarget)
            }
            converted.Add(conversions.BindConversion(argumentLocation, argument, parameter.Type))
        }
        if hasErrors {
            return false
        }
        convertedArgs = PreserveNamedArgumentEvaluationOrder(
            syntax.Arguments,
            converted.MoveToImmutable(),
            parameterNameAt
        )
        argumentRefKinds = if hasRefKinds {
            refKinds.MoveToImmutable()
        } else {
            default(ImmutableArray[RefKind])
        }
        return true
    }

    // Issue #4400: the per-argument loops of the user-method and extension
    // paths leave through several early `continue`s (an open type-parameter
    // pass-through, function-literal adapters, formattable strings, a
    // target-typed lambda) that never reach BindCallArgumentWithRefKind. Any
    // plain value such a branch leaves at a by-ref slot is finished here — an
    // `in` one is passed by readonly reference, a `ref`/`out` one reports
    // GS0235 — so no path can hand the emitter a value where the callee
    // expects an address.
    private func FinishByRefArguments(
        convertedArgs ImmutableArray[BoundExpression].Builder,
        parameters ImmutableArray[ParameterSymbol],
        parameterOffset int32,
        substitution Dictionary[TypeParameterSymbol, TypeSymbol]?,
        locationAt(int32) -> TextLocation,
        argumentNumberOffset int32
    ) {
        for var i = 0; i < convertedArgs.Count && i + parameterOffset < parameters.Length; i++ {
            let parameter = parameters[i + parameterOffset]
            if parameter.RefKind == RefKind.None {
                continue
            }
            let expectedType = if substitution != nil {
                substituteType(parameter.Type, substitution)
            } else {
                parameter.Type
            }
            convertedArgs[i] = conversions.FinishByRefArgument(
                convertedArgs[i],
                parameter,
                expectedType,
                locationAt(i),
                i + argumentNumberOffset
            )
        }
    }

    /// Issue #4943: loads a callee variable — a local, a parameter, or a bare
    /// implicit field/property — with its active narrowing applied through
    /// (cref:ExpressionBinder.BuildNarrowedRead), the single place that
    /// decides how a narrowed read is built. A narrowed value-type nullable
    /// (a `(unmanaged[CC] () -> R)?` function pointer is `Nullable<nint>`)
    /// is unwrapped there; building the narrowed node directly left the
    /// `Nullable<nint>` storage on the stack for `calli`, which jumped to a
    /// garbage address.
    /// @param variable The callee variable.
    /// @param identifier The callee name, for diagnostics and semantic lookup.
    /// @param narrowedType The active narrowed type, or `null`.
    /// @returns The callee load.
    private func BuildCalleeLoad(
        variable VariableSymbol,
        identifier SyntaxToken,
        narrowedType TypeSymbol?
    ) BoundExpression {
        let location = identifier.Location
        let bareRead = if TryBuildImplicitMemberLoad(variable, location, out var memberLoad) {
            Invariant.Required(
                memberLoad,
                "an implicit member load succeeds with a bound expression",
                expression: "memberLoad"
            )
        } else {
            cast[BoundExpression](BoundVariableExpression(identifier, variable))
        }
        if bareRead is not BoundErrorExpression {
            bareRead.AnchorSyntax(identifier)
        }
        if narrowedType == nil || bareRead is BoundErrorExpression {
            return bareRead
        }
        let narrowedRead = ExpressionBinder.BuildNarrowedRead(
            bareRead,
            bareRead.Type,
            narrowedType,
            func (narrowed TypeSymbol) BoundExpression {
                if TryBuildImplicitMemberLoad(variable, location, out var narrowedLoad, narrowed) {
                    return Invariant.Required(
                        narrowedLoad,
                        "an implicit member load succeeds with a bound expression",
                        expression: "narrowedLoad"
                    )
                }
                return BoundVariableExpression(identifier, variable, narrowed)
            }
        )
        if narrowedRead is not BoundErrorExpression {
            narrowedRead.AnchorSyntax(identifier)
        }
        return narrowedRead
    }

    private func TryBuildImplicitMemberLoad(
        variable VariableSymbol,
        location TextLocation,
        out load BoundExpression?,
        narrowedType TypeSymbol? = nil
    ) bool {
        load = nil
        switch variable {
            case staticField is ImplicitStaticFieldVariableSymbol {
                if staticField.InterfaceType != nil {
                    // Interface static fields are not smart-cast-stable.
                    load = BoundFieldAccessExpression(nil, staticField.Field, staticField.InterfaceType)
                } else {
                    // Static member access has no instance receiver; this constructor's
                    // non-null annotation predates its use for static fields.
                    load = BoundFieldAccessExpression(
                        nil,
                        receiver: nil,
                        staticField.StructType,
                        staticField.Field,
                        narrowedType
                    )
                }
                return true
            }
            case instanceField is ImplicitFieldVariableSymbol {
                load = BoundFieldAccessExpression(
                    nil,
                    BoundVariableExpression(nil, instanceField.Receiver),
                    instanceField.StructType,
                    instanceField.Field,
                    narrowedType
                )
                return true
            }
            case prop is ImplicitPropertyVariableSymbol {
                if !prop.Property.HasGetter {
                    Diagnostics.ReportCannotAssign(location, prop.Property.Name)
                    load = BoundErrorExpression(nil)
                    return true
                }
                load = BoundPropertyAccessExpression(
                    nil,
                    BoundVariableExpression(nil, prop.Receiver),
                    prop.StructType,
                    prop.Property,
                    narrowedType
                )
                return true
            }
            case staticProp is ImplicitStaticPropertyVariableSymbol {
                if !staticProp.Property.HasGetter {
                    Diagnostics.ReportCannotAssign(location, staticProp.Property.Name)
                    load = BoundErrorExpression(nil)
                    return true
                }
                // Static member access has no instance receiver; this constructor's
                // non-null annotation predates its use for static properties.
                load = BoundPropertyAccessExpression(
                    nil,
                    receiver: nil,
                    staticProp.StructType,
                    staticProp.Property,
                    narrowedType
                )
                return true
            }
            default {
                return false
            }
        }
    }

    /// Issue #1566: determines whether every top-level function overload with the
    /// given name is an extension function. When true, an unqualified,
    /// receiver-less call to that name inside a type should first try to bind
    /// against an accessible member of the enclosing type (member-over-extension
    /// shadowing) before falling back to the extension.
    /// @param name The invoked identifier.
    /// @returns `true` when at least one overload exists and all of them are extension functions.
    private func IsAllExtensionOverloadSet(name string) bool {
        let overloads = Scope.TryLookupFunctions(name)
        if overloads.IsDefaultOrEmpty {
            return false
        }
        for overload in overloads {
            if !overload.IsExtension {
                return false
            }
        }
        return true
    }

    /// Issue #2066: replicates `ExpressionBinder.TryGetNarrowedType(VariableSymbol)`
    /// so direct call-syntax binding (which looks up the callee via
    /// `Scope.TryLookupSymbol` rather than a bound name-expression read)
    /// can see an active smart-cast null-guard narrowing on the callee local.
    /// Walks the active frame stack innermost-first — the topmost narrowing
    /// wins, mirroring the name-expression lookup.
    private func TryGetNarrowedVariableType(variable VariableSymbol) TypeSymbol? -> TryGetNarrowedVariableAccess(
        variable,
        out _
    )

    private func GetNarrowedVariablePath(variable VariableSymbol) AccessPath {
        TryGetNarrowedVariableAccess(variable, out var path)
        return path
    }

    /// Looks up the active narrowing for a callee variable and reports the
    /// access path it is recorded under: the bare variable for a local, or the
    /// stable member path (`this.hn`) for a bare implicit field/property.
    /// This is the single place that chooses the narrowing key, so tracking a
    /// backward-edge use must reuse [`path`](paramref) rather than assume
    /// the variable path. When nothing narrows the callee, the path is the
    /// variable path and the result is `null` (un-narrowed).
    private func TryGetNarrowedVariableAccess(variable VariableSymbol, out path AccessPath) TypeSymbol? {
        path = AccessPath.ForVariable(variable)
        if binderCtx.NarrowedVariables.Query(path) is {} narrowed {
            return narrowed
        }
        // Issue #2185: a bare field/property callee (`hn(value)` after an
        // `if hn == nil { return }` guard) records its null-guard narrowing under
        // the stable member access path (`this.hn`), not the bare variable symbol.
        // Look that path up too, so a smart-cast-narrowed nullable function-typed
        // field is recognised as callable exactly like a narrowed local. Only
        // nullable-typed implicit members can carry such a narrowing, and the
        // guard avoids invoking the diagnostic-emitting member-load path for any
        // other symbol shape.
        let isNarrowableImplicitMember = variable.Type is NullableTypeSymbol &&
            (
            variable is ImplicitFieldVariableSymbol ||
                (variable is ImplicitPropertyVariableSymbol prop && prop.Property.HasGetter)
        )
        if isNarrowableImplicitMember &&
            TryBuildImplicitMemberLoad(variable, default(TextLocation), out var memberLoad) &&
            memberLoad != nil &&
            !(memberLoad is BoundErrorExpression) &&
            SmartCastStability.TryGetStablePath(memberLoad) is AccessPath memberPath && memberPath.HasMembers {
            if binderCtx.NarrowedVariables.Query(memberPath) is {} narrowedMember {
                path = memberPath
                return narrowedMember
            }
        }
        return nil
    }

    /// Issue #2185: binds an <em>indirect</em> invocation `callee(args)` whose
    /// (cref:CallExpressionSyntax.Callee) is an arbitrary expression (a parenthesized
    /// expression, a null-forgiveness `expr!!`, a curried `f()`, an indexer read, ...).
    /// The callee is bound as an ordinary expression — so smart-cast narrowing and null-forgiveness
    /// already produce its non-null (function) type — and the call is accepted whenever that bound
    /// type is a G# (cref:FunctionTypeSymbol), a user-declared (cref:DelegateTypeSymbol),
    /// or a CLR delegate. Any other callee type reports GS0131 ("is not a function").
    private func BindIndirectCallExpression(syntax CallExpressionSyntax) BoundExpression {
        let calleeSyntax = Invariant.Required(
            syntax.Callee,
            "an indirect call has a callee expression",
            expression: "syntax.Callee"
        )
        let callee = bindExpression(calleeSyntax)
        let calleeName = calleeSyntax.SyntaxTree.Text.ToString(calleeSyntax.Span)
        if syntax.NullableQuestionToken != nil {
            return BindNullConditionalIndirectCallExpression(syntax, callee, calleeName, calleeSyntax.Location)
        }
        return BindIndirectCallExpression(
            syntax,
            callee,
            calleeName,
            calleeSyntax.Location,
            GetNullableDelegateNullSafeInvocation()
        )
    }

    internal func BindNullConditionalIndirectCallExpression(
        syntax CallExpressionSyntax,
        callee BoundExpression,
        calleeName string,
        calleeLocation TextLocation
    ) BoundExpression {
        if callee is BoundErrorExpression {
            return callee
        }
        let callableType = if callee.Type is NullableTypeSymbol nullable {
            nullable.UnderlyingType
        } else {
            callee.Type
        }
        if !MemberLookup.TryGetDelegateFunctionTypeFromSymbol(callableType, out _) {
            Diagnostics.ReportNotAFunction(calleeLocation, calleeName)
            return BoundErrorExpression(nil)
        }
        let captureName = "$$ncap_" + (binderCtx.NullConditionalCaptureCounter += 1).ToString(
            CultureInfo.InvariantCulture
        )
        let capture = LocalVariableSymbol(captureName, isReadOnly: true, type: callableType)
        let captureRef = BoundVariableExpression(nil, capture)
        let invocation = BindIndirectCallExpression(
            syntax,
            captureRef,
            calleeName,
            calleeLocation,
            nullSafeInvocation: nil
        )
        if invocation is BoundErrorExpression {
            return invocation
        }
        return BuildNullConditionalDelegateResult(syntax, callee, capture, invocation, invocation.Type)
    }

    internal func BindIndirectCallExpression(
        syntax CallExpressionSyntax,
        callee BoundExpression,
        calleeName string,
        calleeLocation TextLocation,
        nullSafeInvocation string?
    ) BoundExpression {
        var callee = callee
        if callee is BoundErrorExpression {
            return callee
        }
        if nullSafeInvocation != nil && callee is BoundVariableExpression variableCallee {
            binderCtx.TrackBackwardGotoNarrowingUse(
                GetNarrowedVariablePath(variableCallee.Variable),
                calleeLocation,
                calleeName,
                BackwardGotoNarrowingUseKind.Function
            )
        }
        var nullConditionalCallee BoundNullConditionalAccessExpression? = nil
        let assertions = Stack[BoundUnaryExpression]()
        var assertedCallee = callee
        while assertedCallee is BoundUnaryExpression assertion &&
            assertion
            .Op
            .Kind == BoundUnaryOperatorKind.NullAssertion {
            assertions.Push(assertion)
            assertedCallee = assertion.Operand
        }
        if assertedCallee is BoundNullConditionalAccessExpression assertedNullConditional {
            nullConditionalCallee = assertedNullConditional
            callee = assertedNullConditional.WhenNotNull
            while assertions.TryPop(out var assertion) {
                let assertionOperator = Invariant.Required(
                    BoundUnaryOperator.Bind(SyntaxKind.BangBangToken, callee.Type),
                    "a null assertion has a bound unary operator",
                    expression: "BoundUnaryOperator.Bind(SyntaxKind.BangBangToken, callee.Type)"
                )
                callee = BoundUnaryExpression(assertion.Syntax, assertionOperator, callee, assertion.IsChecked)
            }
        }
        let CompleteInvocation = func (invocation BoundExpression) BoundExpression {
            return if nullConditionalCallee == nil {
                invocation
            } else {
                BuildNullConditionalDelegateResult(
                    syntax,
                    nullConditionalCallee.Receiver,
                    nullConditionalCallee.Capture,
                    invocation,
                    invocation.Type
                )
            }
        }
        if !TryAnalyzeCallArgumentLayout(syntax.Arguments, out _, out var argumentNames) {
            return BoundErrorExpression(nil)
        }
        let boundArguments = ImmutableArray.CreateBuilder[BoundExpression](syntax.Arguments.Count)
        let deferredArrowLambdaIndices = HashSet[int32]()
        for var i = 0; i < syntax.Arguments.Count; i++ {
            let argSyntax = UnwrapNamedArgumentValue(syntax.Arguments[i])
            if bindLambdaWithTarget != nil && IsUntypedArrowLambda(argSyntax) {
                // Defer: TryBindFunctionTypeArguments re-binds the lambda once the
                // callee's parameter delegate shape is known (mirrors the direct path).
                deferredArrowLambdaIndices.Add(i)
                boundArguments.Add(BoundErrorExpression(argSyntax))
            } else if argSyntax is RefArgumentExpressionSyntax refArgument {
                boundArguments.Add(bindRefArgumentExpression(refArgument, nil))
            } else {
                boundArguments.Add(BindOverloadArgumentValue(argSyntax))
            }
        }
        if deferredArrowLambdaIndices.Count == 0 {
            for boundArgument in boundArguments {
                if boundArgument is BoundErrorExpression {
                    return BoundErrorExpression(nil)
                }
            }
        }
        // ADR-0186 §4/§5, issue #4325: invoking a delegate VALUE is a
        // receiver position with no CLR check of its own worth relying on —
        // the nil surfaces from inside the invocation, not at the call site —
        // so it gets §4's attributed check like every other coercion. The
        // unwrap it carries is also what lets the arms below see the delegate
        // at all: each tests `callee.Type is FunctionTypeSymbol` /
        // `is DelegateTypeSymbol`, and a platform wrapper matches neither.
        //
        // Skipped for a null-conditional invocation (`f?.()`), where `callee`
        // is already the guarded `WhenNotNull` branch: §4 inserts nothing for
        // a guarded access, because no coercion to non-null occurs there.
        if nullConditionalCallee == nil {
            callee = PlatformCoercion.CheckDelegateInvocationTarget(callee, calleeLocation)
        }
        if TryReportNullableDelegateReceiver(callee.Type, calleeLocation, calleeName, nullSafeInvocation) {
            return BoundErrorExpression(nil)
        }
        if callee.Type is FunctionPointerTypeSymbol functionPointerType {
            return CompleteInvocation(
                BindFunctionPointerInvocation(
                    syntax,
                    callee,
                    functionPointerType,
                    calleeName,
                    calleeLocation,
                    boundArguments.ToImmutable(),
                    argumentNames,
                    GetIndirectCallableParameterNames(callee)
                )
            )
        }
        if callee.Type is FunctionTypeSymbol fnType {
            if !TryBindFunctionTypeArguments(
                calleeName,
                fnType,
                syntax,
                boundArguments.ToImmutable(),
                GetIndirectCallableParameterNames(callee),
                out var convertedArgs
            ) {
                return BoundErrorExpression(nil)
            }
            return CompleteInvocation(BoundIndirectCallExpression(syntax, callee, fnType, convertedArgs))
        }
        if callee.Type is DelegateTypeSymbol delegateSym {
            if !TryBindNamedDelegateArguments(
                calleeName,
                delegateSym,
                syntax,
                boundArguments.ToImmutable(),
                out var convertedDelegateArgs,
                out var delegateRefKinds
            ) {
                return BoundErrorExpression(nil)
            }
            return CompleteInvocation(
                BoundIndirectCallExpression(
                    syntax,
                    callee,
                    delegateSym.EquivalentFunctionType,
                    convertedDelegateArgs,
                    delegateRefKinds
                )
            )
        }
        // A value whose CLR type is a delegate (e.g. `Func[int32, int32]`) is
        // callable through its `Invoke` method, mirroring the direct-call path.
        if callee.Type?.ClrType is Type calleeClrType && ClrTypeUtilities.IsDelegateType(calleeClrType) {
            if tryBindInheritedClrInstanceCall(
                callee,
                calleeClrType,
                "Invoke",
                boundArguments.ToImmutable(),
                syntax,
                out var invokeCall,
                nil,
                default(ImmutableArray[TypeSymbol]),
                argumentNames,
                false
            ) {
                return CompleteInvocation(invokeCall!!)
            }
        }
        Diagnostics.ReportNotAFunction(calleeLocation, calleeName)
        return BoundErrorExpression(nil)
    }

    func BindExtensionFunctionCall(
        receiver BoundExpression,
        extension FunctionSymbol,
        arguments ImmutableArray[BoundExpression],
        ce CallExpressionSyntax,
        argumentNames ImmutableArray[string] = default(ImmutableArray[string])
    ) BoundExpression {
        // The extension's first parameter is the receiver; user arguments line
        // up against parameters[1..].
        let userParamCount = extension.Parameters.Length - 1
        // ADR-0063 / issue #1556: count the leading non-optional user
        // parameters. A receiver-form (extension) call may omit any trailing
        // parameter that declares a default value, mirroring the free-function,
        // static (`shared`), and user-instance call paths. The receiver
        // occupies `Parameters[0]`, so the scan runs over the user slice
        // `Parameters[1..]` and the omitted trailing slots are synthesized from
        // each parameter's captured default constant below.
        var requiredUserParamCount = userParamCount
        for var i = userParamCount - 1; i >= 0; i-- {
            if extension.Parameters[i + 1].HasExplicitDefaultValue {
                requiredUserParamCount = i
            } else {
                break
            }
        }
        if arguments.Length < requiredUserParamCount || arguments.Length > userParamCount {
            Diagnostics.ReportWrongArgumentCount(ce.Location, extension.Name, userParamCount, arguments.Length)
            return BoundErrorExpression(nil)
        }
        // Issue #343: reorder named arguments into the extension's parameter
        // order (excluding the synthetic receiver slot). ADR-0063 / issue #1556:
        // positional calls may omit trailing optional parameters; the omitted
        // slots are padded from each parameter's captured default value after
        // the reorder below.
        var permutedSyntax[]ExpressionSyntax?
        var permutedArguments ImmutableArray[BoundExpression]
        let extensionParameterNameAt(int32) -> string = (parameterIndex int32) -> extension
            .Parameters[parameterIndex + 1]
            .Name
        let extensionParameterIsOptional(int32) -> bool = (parameterIndex int32) -> extension
            .Parameters[parameterIndex + 1]
            .HasExplicitDefaultValue
        if !argumentNames.IsDefault {
            if !TryReorderUserCallArguments(
                ce.Arguments,
                arguments,
                userParamCount,
                extensionParameterNameAt,
                extensionParameterIsOptional,
                extension.Name,
                out permutedSyntax,
                out permutedArguments
            ) {
                return BoundErrorExpression(nil)
            }
            let filledArguments = permutedArguments.ToBuilder()
            for var i = 0; i < filledArguments.Count; i++ {
                filledArguments[i] ??= CreateOptionalUserDefaultArgument(extension.Parameters[i + 1])
            }
            permutedArguments = filledArguments.MoveToImmutable()
        } else {
            permutedSyntax = [ce.Arguments.Count]ExpressionSyntax
            for var i = 0; i < ce.Arguments.Count; i++ {
                permutedSyntax[i] = ce.Arguments[i]
            }
            permutedArguments = arguments
        }
        // ADR-0063 / issue #1556: pad any omitted trailing optional parameters
        // with their captured default values so the generic-inference and
        // per-position conversion loops below bind the full user parameter list
        // (matching the free-function, static, and user-instance call paths).
        // Named-argument calls are reordered above against the full parameter
        // count, so this positional pad is gated on the unnamed shape.
        if argumentNames.IsDefault && permutedArguments.Length < userParamCount {
            let padded = ImmutableArray.CreateBuilder[BoundExpression](userParamCount)
            padded.AddRange(permutedArguments)
            for var i = permutedArguments.Length; i < userParamCount; i++ {
                padded.Add(CreateOptionalUserDefaultArgument(extension.Parameters[i + 1]))
            }
            permutedArguments = padded.MoveToImmutable()
        }
        // Issue #326: a generic extension function
        // `func (r R) Name[T](item T) T` resolves its type parameters either
        // from an explicit `[T1, T2]` type-argument list at the call site or by
        // left-to-right inference from the receiver and argument types matched
        // against the declared parameter types. Mirrors the free-function
        // generic path (Phase 4.1 / ADR-0020).
        var substitution Dictionary[TypeParameterSymbol, TypeSymbol]? = nil
        if extension.IsGeneric {
            substitution = Dictionary[TypeParameterSymbol, TypeSymbol]()
            if ce.TypeArgumentList is {} typeArgumentList {
                let explicitArgs = typeArgumentList.Arguments
                if explicitArgs.Count != extension.TypeParameters.Length {
                    Diagnostics.ReportWrongTypeArgumentCount(
                        typeArgumentList.Location,
                        extension.Name,
                        extension.TypeParameters.Length,
                        explicitArgs.Count
                    )
                    return BoundErrorExpression(nil)
                }
                for var i = 0; i < explicitArgs.Count; i++ {
                    let ta TypeSymbol? = bindTypeClause(explicitArgs[i])
                    if ta == nil {
                        return BoundErrorExpression(nil)
                    }
                    substitution[extension.TypeParameters[i]] = ta
                }
            } else {
                // The receiver lines up against parameters[0]; user arguments
                // against parameters[1..]. Inferring from the receiver too lets
                // a generic receiver type (e.g. `func (s []T) ...`) bind T.
                if receiver?.Type != nil {
                    inferTypeArguments(
                        extension.Parameters[0].Type,
                        RefCapabilities.GetInferenceType(extension.Parameters[0], receiver.Type),
                        substitution
                    )
                }
                for var i = 0; i < permutedArguments.Length; i++ {
                    if permutedArguments[i].Type != nil {
                        inferTypeArguments(
                            extension.Parameters[i + 1].Type,
                            RefCapabilities.GetInferenceType(extension.Parameters[i + 1], permutedArguments[i].Type),
                            substitution
                        )
                    }
                }
                for tp in extension.TypeParameters {
                    if !substitution.ContainsKey(tp) {
                        Diagnostics.ReportTypeArgumentInferenceFailed(ce.Identifier.Location, extension.Name, tp.Name)
                        return BoundErrorExpression(nil)
                    }
                }
            }
            // Phase 4.2 / ADR-0020: each substituted type argument must satisfy
            // its type parameter's declared constraint.
            let constraintLocation = if ce.TypeArgumentList != nil {
                ce.TypeArgumentList.Location
            } else {
                ce.Identifier.Location
            }
            if TryReportByRefLikeTypeArgument(extension.TypeParameters, substitution, constraintLocation) {
                return BoundErrorExpression(nil)
            }
            for tp in extension.TypeParameters {
                let typeArg = substitution[tp]
                if !satisfiesConstraint(typeArg, tp, substitution) {
                    Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(
                        constraintLocation,
                        tp.Name,
                        typeArg,
                        describeConstraint(tp)
                    )
                    return BoundErrorExpression(nil)
                }
            }
        }
        let convertedArgs = ImmutableArray.CreateBuilder[BoundExpression](extension.Parameters.Length)
        let receiverParamType = if substitution != nil {
            substituteType(extension.Parameters[0].Type, substitution)
        } else {
            extension.Parameters[0].Type
        }
        convertedArgs.Add(
            conversions.BindConversion(
                ce.Location,
                Invariant.Required(receiver, "an extension call has a bound receiver", expression: "receiver"),
                receiverParamType
            )
        )
        for var i = 0; i < permutedArguments.Length; i++ {
            let paramType = extension.Parameters[i + 1].Type
            let expectedType = if substitution != nil {
                substituteType(paramType, substitution)
            } else {
                paramType
            }
            if substitution != nil && TypeSymbol.ContainsTypeParameter(paramType) {
                if paramType is FunctionTypeSymbol openFunctionParameter &&
                    tryGetFunctionLiteral(permutedArguments[i], out var functionLiteralArgument) {
                    // ADR-0087 §3 R6: substitute the open target so the
                    // identity-check inside the adapter drops the
                    // wrapper when the literal already matches.
                    let substitutedOpenTarget = (
                        substituteType(openFunctionParameter, substitution) as FunctionTypeSymbol
                    ) ??
                        openFunctionParameter
                    convertedArgs.Add(
                        createErasedFunctionLiteralAdapter(functionLiteralArgument!!, substitutedOpenTarget)
                    )
                    continue
                }
                if TypeSymbol.ContainsTypeParameter(expectedType) {
                    // Issue #3932: the skip below is right for a BARE open `T`
                    // slot (erased to System.Object, emitter boxes), but it
                    // fired for anything that merely CONTAINS a type parameter
                    // — including `Memory[T]`, which emits as a REAL
                    // constructed slot `Memory`1<!!0>`, not as `object`. A
                    // `[]T` argument there needs `Memory`1::op_Implicit` and
                    // got nothing, so the raw array reached the slot and
                    // ILVerify reported `[found ref 'T0[]'][expected value
                    // 'Memory`1<T0>']`. The identical call with a CONCRETE
                    // element type has always emitted the operator — the
                    // conversion was only ever lost when the element was open.
                    // This is the same bare-vs-constructed distinction #3222
                    // taught the plain-function argument path; the extension
                    // path never learned it.
                    //
                    // Only APPLIES a conversion that resolves; when none does,
                    // the historical unconverted pass-through is unchanged, so
                    // the bare-`T` case this skip exists for is untouched.
                    if permutedArguments[i].Type is {} openArgumentType &&
                        openArgumentType != TypeSymbol.Error &&
                        openArgumentType != expectedType &&
                        conversions
                        .TryApplyUserDefinedImplicitArgumentConversion(
                        permutedArguments[i],
                        expectedType,
                        out var openTargetConverted
                    ) {
                        convertedArgs.Add(openTargetConverted)
                        continue
                    }
                    // A parameter typed as an open T is encoded as System.Object in
                    // the emitted signature; pass the argument unconverted so the
                    // emitter inserts box / unbox.any around the erased boundary.
                    convertedArgs.Add(permutedArguments[i])
                    continue
                }
            }
            let argLoc = if i < permutedSyntax.Length {
                permutedSyntax[i]?.Location ?? ce.Location
            } else {
                ce.Location
            }
            let lambdaSyntax = if i < permutedSyntax.Length && permutedSyntax[i] is {} sourceArgument {
                GetLambdaArgumentSyntax(sourceArgument)
            } else {
                default(LambdaExpressionSyntax?)
            }
            if (extension.Parameters[i + 1].RefKind is RefKind.None or RefKind.In) &&
                TryConvertLambdaArgumentWithTarget(
                permutedArguments[i],
                expectedType,
                argLoc,
                out var targetTypedLambda,
                lambdaSyntax,
                extension.Parameters[i + 1]
            ) {
                convertedArgs.Add(
                    Invariant.Required(
                        targetTypedLambda,
                        "a successfully target-typed extension lambda produces a bound expression",
                        expression: "targetTypedLambda"
                    )
                )
                continue
            }
            convertedArgs.Add(
                conversions.BindCallArgumentWithRefKind(
                    argLoc,
                    permutedArguments[i],
                    expectedType,
                    extension.Parameters[i + 1],
                    i + 1
                )
            )
        }
        // convertedArgs[0] is the receiver, so it aligns with extension.Parameters
        // and argument i is source argument i - 1.
        FinishByRefArguments(
            convertedArgs,
            extension.Parameters,
            parameterOffset: 0,
            substitution,
            (i int32) -> if i >= 1 && i - 1 < permutedSyntax.Length {
                permutedSyntax[i - 1]?.Location ?? ce.Location
            } else {
                ce.Location
            },
            argumentNumberOffset: 0
        )
        // Issue #1931: stash the extension function's own (explicit or
        // inferred) type arguments on the bound node so the emitter's
        // MethodSpec construction can use this authoritative bind-time result
        // instead of re-deriving it via structural unification.
        var extensionMethodTypeArguments = default(ImmutableArray[TypeSymbol])
        if extension.IsGeneric && substitution != nil {
            let extensionMethodTypeArgsBuilder = ImmutableArray.CreateBuilder[TypeSymbol](
                extension.TypeParameters.Length
            )
            for tp in extension.TypeParameters {
                extensionMethodTypeArgsBuilder.Add(substitution[tp])
            }
            extensionMethodTypeArguments = extensionMethodTypeArgsBuilder.MoveToImmutable()
        }
        let finalArguments = PreserveNamedArgumentEvaluationOrder(
            ce.Arguments,
            convertedArgs.MoveToImmutable(),
            extensionParameterNameAt,
            parameterOffset: 1
        )
        let MakeExtensionCall = func (returnType TypeSymbol?) BoundCallExpression {
            return BoundCallExpression(ce, extension, finalArguments, returnType){
                MethodTypeArguments = extensionMethodTypeArguments
            }
        }
        if substitution != nil {
            var returnType = substituteType(extension.Type, substitution)
            if extension.IsAsync && !extension.IsAsyncVoid && !isAsyncIteratorReturnType(extension.Type) {
                returnType = wrapAsTask(returnType, extension.AsyncReturnsValueTask)
            }
            if extension.IsSuspending {
                let suspendingCall = MakeExtensionCall(wrapAsTask(returnType, true))
                return completeSuspendingCall(suspendingCall, returnType, ce.Location, extension.Name)
            }
            return MakeExtensionCall(returnType)
        }
        // Issue #1376: an async receiver-clause (extension) function's call-site
        // return type is Task / Task[T], not the underlying void / T. Wrap here
        // so awaiting the call sees a value-bearing Task, mirroring the async
        // free-function and user-instance-call paths.
        if extension.IsAsync && !extension.IsAsyncVoid && !isAsyncIteratorReturnType(extension.Type) {
            let asyncReturn = wrapAsTask(extension.Type, extension.AsyncReturnsValueTask)
            return MakeExtensionCall(asyncReturn)
        }
        // ADR-0174 D4: a suspending receiver-clause function's call is typed ValueTask[R]; the caller sees R.
        if extension.IsSuspending {
            let suspendingCall = MakeExtensionCall(wrapAsTask(extension.Type, true))
            return completeSuspendingCall(suspendingCall, extension.Type, ce.Location, extension.Name)
        }
        return MakeExtensionCall(nil)
    }

    func BindUserInstanceCall(
        receiver BoundExpression,
        method FunctionSymbol,
        arguments ImmutableArray[BoundExpression],
        ce CallExpressionSyntax,
        argumentNames ImmutableArray[string] = default(ImmutableArray[string]),
        constrainedReceiverTypeParameter TypeParameterSymbol? = nil
    ) BoundExpression {
        // Issue #950 / #2044 / #2058: enforce `protected`/`private` method
        // access — a `protected` method is only callable from the declaring
        // type and its derived types, and a `private` method is only
        // callable from within its declaring top-level type's body. The
        // emitted IL also carries the matching CIL accessibility so the CLR
        // enforces the same rule independently.
        if method.ReceiverType is StructSymbol methodDeclaringType && !AccessibilityChecker.IsAccessible(
            method.Accessibility,
            methodDeclaringType,
            getCurrentFunction()
        ) {
            Diagnostics.ReportMemberInaccessible(
                ce.Identifier.Location,
                method.Name,
                methodDeclaringType.Name,
                method.Accessibility
            )
        }
        let parameterOffset = if method.ExplicitReceiverParameter == nil {
            0
        } else {
            1
        }
        let callableParameterCount = method.Parameters.Length - parameterOffset
        // ADR-0101 follow-up / issue #812: class / interface instance methods
        // may declare a trailing variadic parameter. The arity check accepts
        // any count >= fixed parameters (the fixed prefix is everything
        // except the trailing variadic). Pack / pass-through happens below
        // before the per-position conversion loop.
        let isVariadic = method.Parameters.Length > 0 && method.Parameters[method.Parameters.Length - 1].IsVariadic
        let fixedCallableParamCount = if isVariadic {
            callableParameterCount - 1
        } else {
            callableParameterCount
        }
        var requiredFixedCallableParamCount = fixedCallableParamCount
        while requiredFixedCallableParamCount > 0 &&
            method
            .Parameters[requiredFixedCallableParamCount - 1 + parameterOffset]
            .HasExplicitDefaultValue {
            requiredFixedCallableParamCount--
        }
        let callableParameterNameAt(int32) -> string = (parameterIndex int32) -> method
            .Parameters[parameterIndex + parameterOffset]
            .Name
        let callableParameterIsOptional(int32) -> bool = (parameterIndex int32) -> method
            .Parameters[parameterIndex + parameterOffset]
            .HasExplicitDefaultValue
        // ADR-0063 / issue #1319: count the leading non-optional callable
        // parameters. An instance / constructor call may omit any trailing
        // parameter that declares a default value; the omitted slots are
        // synthesized from each parameter's captured default constant below,
        // mirroring the top-level and static (`shared`) call paths. The
        // receiver parameter (when present) is excluded via `parameterOffset`.
        var requiredCallableParamCount = callableParameterCount
        for var i = callableParameterCount - 1; i >= 0; i-- {
            if method.Parameters[i + parameterOffset].HasExplicitDefaultValue {
                requiredCallableParamCount = i
            } else {
                break
            }
        }
        if isVariadic &&
            !ValidateExpandedVariadicNamedArguments(
            argumentNames,
            fixedCallableParamCount,
            callableParameterNameAt,
            method.Name,
            ce
        ) {
            return BoundErrorExpression(nil)
        }
        if isVariadic {
            if arguments.Length < requiredFixedCallableParamCount {
                Diagnostics.ReportTooFewArgumentsForVariadic(
                    ce.Identifier.Location,
                    method.Name,
                    requiredFixedCallableParamCount,
                    arguments.Length
                )
                return BoundErrorExpression(nil)
            }
        } else if arguments.Length < requiredCallableParamCount || arguments.Length > callableParameterCount {
            Diagnostics.ReportWrongArgumentCount(ce.Location, method.Name, callableParameterCount, arguments.Length)
            return BoundErrorExpression(nil)
        }
        // Issue #343: reorder named arguments into the method's parameter
        // order. ADR-0063 / issue #1319: positional calls may omit trailing
        // optional parameters; the omitted slots are padded from each
        // parameter's captured default value after the reorder below.
        var permutedSyntax[]ExpressionSyntax?
        var permutedArguments ImmutableArray[BoundExpression]
        if !argumentNames.IsDefault && !isVariadic {
            if !TryReorderUserCallArguments(
                ce.Arguments,
                arguments,
                callableParameterCount,
                callableParameterNameAt,
                callableParameterIsOptional,
                method.Name,
                out permutedSyntax,
                out permutedArguments
            ) {
                return BoundErrorExpression(nil)
            }
            let filledArguments = permutedArguments.ToBuilder()
            for var i = 0; i < filledArguments.Count; i++ {
                filledArguments[i] ??= CreateOptionalUserDefaultArgument(method.Parameters[i + parameterOffset])
            }
            permutedArguments = filledArguments.MoveToImmutable()
        } else {
            permutedSyntax = [ce.Arguments.Count]ExpressionSyntax
            for var i = 0; i < ce.Arguments.Count; i++ {
                permutedSyntax[i] = ce.Arguments[i]
            }
            permutedArguments = arguments
        }
        // ADR-0063 / issue #1319: pad any omitted trailing optional parameters
        // with their captured default values so the per-position conversion loop
        // binds the full callable parameter list (matching the top-level and
        // static call paths). Variadic methods never reach here with a short
        // slice (their trailing slot is packed below), so the optional pad is
        // gated on the non-variadic shape.
        if argumentNames.IsDefault && !isVariadic && permutedArguments.Length < callableParameterCount {
            let padded = ImmutableArray.CreateBuilder[BoundExpression](callableParameterCount)
            padded.AddRange(permutedArguments)
            for var i = permutedArguments.Length; i < callableParameterCount; i++ {
                padded.Add(CreateOptionalUserDefaultArgument(method.Parameters[i + parameterOffset]))
            }
            permutedArguments = padded.MoveToImmutable()
        }
        // Phase 4.3b / ADR-0020: if the receiver is a constructed generic
        // class/struct, substitute the method's parameter types and return
        // type with the receiver's type-argument map. The method symbol
        // itself (and its bound body) are kept intact so runtime dispatch
        // through program.Functions[method] continues to work.
        var substitution Dictionary[TypeParameterSymbol, TypeSymbol]? = TryBuildReceiverSubstitution(receiver.Type)
        // Issue #312 / ADR-0020: the method may declare its own generic
        // type-parameter list (`func M[T](...) T`). Resolve those type
        // arguments from an explicit `[T1, T2]` list at the call site or by
        // left-to-right inference from argument types, then fold them into the
        // same substitution map used for the receiver's type arguments.
        if method.IsGeneric {
            if substitution == nil {
                substitution = Dictionary[TypeParameterSymbol, TypeSymbol]()
            }
            if ce.TypeArgumentList is {} typeArgumentList {
                let explicitArgs = typeArgumentList.Arguments
                if explicitArgs.Count != method.TypeParameters.Length {
                    Diagnostics.ReportWrongTypeArgumentCount(
                        typeArgumentList.Location,
                        method.Name,
                        method.TypeParameters.Length,
                        explicitArgs.Count
                    )
                    return BoundErrorExpression(nil)
                }
                for var i = 0; i < explicitArgs.Count; i++ {
                    let ta TypeSymbol? = bindTypeClause(explicitArgs[i])
                    if ta == nil {
                        return BoundErrorExpression(nil)
                    }
                    substitution[method.TypeParameters[i]] = ta
                }
            } else {
                for var i = 0; i < permutedArguments.Length; i++ {
                    // ADR-0101 follow-up / issue #812: when the call lands
                    // on the trailing variadic parameter (whose type is
                    // `[]T`), each trailing argument contributes to `T`'s
                    // inference. A single trailing `[]U` argument infers
                    // `T = U` from the slice element so the pass-through
                    // path works.
                    let paramType = method.Parameters[i + parameterOffset].Type
                    if isVariadic &&
                        i +
                        parameterOffset == method
                        .Parameters
                        .Length - 1 &&
                        VariadicCarriers.GetElementType(paramType) is {} variadicInferElement &&
                        variadicInferElement != TypeSymbol
                        .Error {
                        // Normalized first, so a top-level `T!` over a slice is still a
                        // pass-through carrier.
                        let argType = RefCapabilities.GetValueArgumentInferenceType(permutedArguments[i].Type)
                        if permutedArguments.Length - i == 1 && argType is SliceTypeSymbol passThroughSlice {
                            inferTypeArguments(variadicInferElement, passThroughSlice.ElementType, substitution)
                        } else if permutedArguments.Length - i == 1 && Conversion.Classify(argType, paramType)
                            .IsImplicit {
                            // Carrier pass-through (`f(existingList)`): let the
                            // general structural walk unify the carrier shapes.
                            inferTypeArguments(paramType, argType, substitution)
                        } else {
                            for var j = i; j < permutedArguments.Length; j++ {
                                inferTypeArguments(
                                    variadicInferElement,
                                    RefCapabilities.GetValueArgumentInferenceType(permutedArguments[j].Type),
                                    substitution
                                )
                            }
                        }
                        break
                    }
                    inferTypeArguments(
                        paramType,
                        RefCapabilities.GetInferenceType(
                            method.Parameters[i + parameterOffset],
                            permutedArguments[i].Type
                        ),
                        substitution
                    )
                }
                // Issue #3760: sibling of the free-function path — a method
                // group argument gives the loop above nothing to unify, so a
                // type parameter reachable only through the target delegate's
                // return position stays unbound. Retry the unbound ones
                // through the method group's own signature. Runs ONLY after
                // the positional pass failed (#3756), so no call that already
                // infers changes shape.
                if HasUnboundTypeParameter(method.TypeParameters, substitution) {
                    for var i = 0; i < permutedArguments.Length && i + parameterOffset < method.Parameters.Length; i++ {
                        InferFromUserMethodGroupArgument(
                            method.Parameters[i + parameterOffset].Type,
                            permutedArguments[i],
                            substitution
                        )
                    }
                }
                for tp in method.TypeParameters {
                    if !substitution.ContainsKey(tp) {
                        Diagnostics.ReportTypeArgumentInferenceFailed(ce.Identifier.Location, method.Name, tp.Name)
                        return BoundErrorExpression(nil)
                    }
                }
            }
            // Phase 4.2 / ADR-0020: each substituted type argument must satisfy
            // its type parameter's declared constraint.
            let constraintLocation = if ce.TypeArgumentList != nil {
                ce.TypeArgumentList.Location
            } else {
                ce.Identifier.Location
            }
            if TryReportByRefLikeTypeArgument(method.TypeParameters, substitution, constraintLocation) {
                return BoundErrorExpression(nil)
            }
            for tp in method.TypeParameters {
                let typeArg = substitution[tp]
                if !satisfiesConstraint(typeArg, tp, substitution) {
                    Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(
                        constraintLocation,
                        tp.Name,
                        typeArg,
                        describeConstraint(tp)
                    )
                    return BoundErrorExpression(nil)
                }
            }
        }
        // ADR-0101 follow-up / issue #812: pack or pass-through trailing
        // variadic arguments before per-position conversion. Mirrors the
        // top-level call path: a single trailing argument whose substituted
        // type matches the variadic slice type forwards unchanged; otherwise
        // the trailing args are typed against the element type and packed
        // into a fresh `BoundArrayCreationExpression`.
        if isVariadic {
            if permutedArguments.Length < fixedCallableParamCount {
                let padded = ImmutableArray.CreateBuilder[BoundExpression](fixedCallableParamCount)
                padded.AddRange(permutedArguments)
                for var i = permutedArguments.Length; i < fixedCallableParamCount; i++ {
                    padded.Add(CreateOptionalUserDefaultArgument(method.Parameters[i + parameterOffset]))
                }
                permutedArguments = padded.MoveToImmutable()
                Array.Resize(&permutedSyntax, fixedCallableParamCount)
            }
            let variadicParam = method.Parameters[method.Parameters.Length - 1]
            let paramCarrierType = variadicParam.Type
            let sliceType = if substitution != nil {
                substituteType(paramCarrierType, substitution)
            } else {
                paramCarrierType
            }
            let trailingCount = permutedArguments.Length - fixedCallableParamCount
            let passThrough = trailingCount == 1 && permutedArguments[fixedCallableParamCount].Type == sliceType
            if !passThrough {
                // Issue #1630: pack through the canonical helper (applies
                // #1493 element coercion).
                var hasVariadicErrors = false
                permutedArguments = PackOrPassThroughVariadicArguments(
                    conversions,
                    Diagnostics,
                    ce,
                    permutedArguments,
                    fixedCallableParamCount,
                    sliceType,
                    variadicParam.Name,
                    (i int32) -> {
                        return permutedSyntax[i]?.Location ?? ce.Location
                    },
                    &hasVariadicErrors
                )
                if hasVariadicErrors {
                    return BoundErrorExpression(nil)
                }
                let newSyntax = [fixedCallableParamCount + 1]ExpressionSyntax?
                for var i = 0; i < fixedCallableParamCount; i++ {
                    newSyntax[i] = permutedSyntax[i]
                }
                // The packed-slice slot has no corresponding source argument
                // (or, when the user supplied one or more trailing args, we
                // collapse them down to a single synthetic slot). Use the
                // first trailing arg's syntax when present, otherwise leave
                // null and the conversion loop will fall back to `ce.Location`.
                newSyntax[fixedCallableParamCount] = if permutedSyntax.Length > fixedCallableParamCount {
                    permutedSyntax[fixedCallableParamCount]
                } else {
                    default(ExpressionSyntax?)
                }
                permutedSyntax = newSyntax
            }
        }
        let convertedArgs = ImmutableArray.CreateBuilder[BoundExpression](permutedArguments.Length)
        for var i = 0; i < permutedArguments.Length; i++ {
            let parameter = method.Parameters[i + parameterOffset]
            let paramType = parameter.Type
            let expectedType = if substitution != nil {
                substituteType(paramType, substitution)
            } else {
                paramType
            }
            // ADR-0060 / issue #1133: an inline-decl `out var n` / `out let n` /
            // `out _` was bound with TypeSymbol.Error in the first pass (from
            // BindCallExpression, before the method was resolved) and never
            // declared a local. Now that overload resolution has chosen the
            // method — and the receiver / method type-argument substitution is
            // known — re-bind it so the synthesized local is typed from the
            // resolved (substituted) out-parameter pointee type and leaks into
            // the enclosing block scope. This mirrors the free-function path
            // and the imported-method RebindInlineOutVarArguments helper, and
            // must run BEFORE the open-type-parameter shortcut below so generic
            // out-parameters (`func M[T](out result T)`) are handled too.
            if permutedArguments[i] is BoundAddressOfExpression inlineOutAddr &&
                inlineOutAddr
                .Operand
                .Type == TypeSymbol
                .Error {
                let slotSyntax = if i < permutedSyntax.Length {
                    permutedSyntax[i]
                } else {
                    default(ExpressionSyntax?)
                }
                let pointeeType = if substitution != nil {
                    substituteType(paramType, substitution)
                } else {
                    paramType
                }
                let reboundOutVar BoundExpression? = tryRebindInlineOutVarPlaceholder(
                    permutedArguments[i],
                    slotSyntax!!,
                    parameter,
                    pointeeType
                )
                if reboundOutVar != nil {
                    convertedArgs.Add(reboundOutVar)
                    continue
                }
            }
            // An argument bound to an open type parameter is left untouched —
            // the emitter boxes value types at the call boundary (the parameter
            // is encoded as System.Object under the type-erased model).
            if paramType is TypeParameterSymbol && TypeSymbol.ContainsTypeParameter(expectedType) {
                convertedArgs.Add(permutedArguments[i])
                continue
            }
            if substitution != nil && tryGetFunctionLiteral(permutedArguments[i], out var functionLiteralArgument) {
                if paramType is FunctionTypeSymbol openFunctionParameter {
                    // ADR-0087 §3 R6: substitute the open target so the
                    // identity-check inside the adapter drops the
                    // wrapper when the literal already matches.
                    let substitutedOpenTarget = (
                        substituteType(openFunctionParameter, substitution) as FunctionTypeSymbol
                    ) ??
                        openFunctionParameter
                    convertedArgs.Add(
                        createErasedFunctionLiteralAdapter(functionLiteralArgument!!, substitutedOpenTarget)
                    )
                    continue
                }
                if MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(
                    expectedType,
                    out var targetDelegateFunctionType
                ) &&
                    functionLiteralArgument!!.FunctionType != targetDelegateFunctionType {
                    permutedArguments = permutedArguments.SetItem(
                        i,
                        createErasedFunctionLiteralAdapter(functionLiteralArgument!!, targetDelegateFunctionType!!)
                    )
                }
            }
            let argSyntaxForLocation ExpressionSyntax? = if i < permutedSyntax.Length {
                permutedSyntax[i]
            } else {
                default(ExpressionSyntax?)
            }
            let argLoc = argSyntaxForLocation?.Location ?? ce.Location
            let lambdaSyntax = if argSyntaxForLocation is {} sourceArgument {
                GetLambdaArgumentSyntax(sourceArgument)
            } else {
                default(LambdaExpressionSyntax?)
            }
            if (parameter.RefKind is RefKind.None or RefKind.In) &&
                TryConvertLambdaArgumentWithTarget(
                permutedArguments[i],
                expectedType,
                argLoc,
                out var targetTypedLambda,
                lambdaSyntax,
                parameter
            ) {
                convertedArgs.Add(
                    Invariant.Required(
                        targetTypedLambda,
                        "a successfully target-typed instance lambda produces a bound expression",
                        expression: "targetTypedLambda"
                    )
                )
                continue
            }
            // ADR-0055 Tier 4 (#369): re-lower an interpolated-string argument to
            // FormattableStringFactory.Create when the parameter is
            // IFormattable/FormattableString.
            let argSyntaxForInterp = if argSyntaxForLocation != nil {
                UnwrapNamedArgumentValue(argSyntaxForLocation)
            } else {
                default(ExpressionSyntax?)
            }
            if argSyntaxForInterp is InterpolatedStringExpressionSyntax interpolatedArg &&
                isFormattableStringTargetType(expectedType) {
                convertedArgs.Add(bindInterpolatedStringAsFormattable(interpolatedArg, expectedType))
                continue
            }
            convertedArgs.Add(
                conversions.BindCallArgumentWithRefKind(
                    argLoc,
                    permutedArguments[i],
                    expectedType,
                    method.Parameters[i + parameterOffset],
                    i + 1
                )
            )
        }
        // Issue #1931: stash the method's own (explicit or inferred) type
        // arguments on the bound node regardless of whether they affect the
        // return type below, so the emitter's MethodSpec construction can use
        // this authoritative bind-time result instead of re-deriving it via
        // structural unification (which can fail for uninformative argument
        // shapes like a bare `nil`).
        var methodTypeArguments = default(ImmutableArray[TypeSymbol])
        if method.IsGeneric && substitution != nil {
            let methodTypeArgsBuilder = ImmutableArray.CreateBuilder[TypeSymbol](method.TypeParameters.Length)
            for tp in method.TypeParameters {
                methodTypeArgsBuilder.Add(substitution[tp])
            }
            methodTypeArguments = methodTypeArgsBuilder.MoveToImmutable()
        }
        FinishByRefArguments(
            convertedArgs,
            method.Parameters,
            parameterOffset,
            substitution,
            (i int32) -> if i < permutedSyntax.Length {
                permutedSyntax[i]?.Location ?? ce.Location
            } else {
                ce.Location
            },
            argumentNumberOffset: 1
        )
        let finalArguments = PreserveNamedArgumentEvaluationOrder(
            ce.Arguments,
            convertedArgs.ToImmutable(),
            callableParameterNameAt
        )
        let MakeCall = func (returnTypeOverride TypeSymbol?) BoundUserInstanceCallExpression {
            let result = BoundUserInstanceCallExpression(
                ce,
                receiver,
                method,
                finalArguments,
                returnTypeOverride,
                constrainedReceiverTypeParameter,
                constrainedReceiverTypeParameter?.InterfaceConstraint
            )
            result.MethodTypeArguments = methodTypeArguments
            return result
        }
        if substitution != nil {
            var substitutedReturn = substituteType(method.Type, substitution)
            if method.IsAsync && !method.IsAsyncVoid && !isAsyncIteratorReturnType(method.Type) {
                substitutedReturn = wrapAsTask(substitutedReturn, method.AsyncReturnsValueTask)
                return MakeCall(substitutedReturn)
            }
            if method.IsSuspending {
                return completeSuspendingCall(
                    MakeCall(wrapAsTask(substitutedReturn, true)),
                    substitutedReturn,
                    ce.Location,
                    method.Name
                )
            }
            if !object.ReferenceEquals(substitutedReturn, method.Type) {
                return MakeCall(substitutedReturn)
            }
        }
        // Issue #502: an async instance method's call-site return type is
        // Task / Task[T], not the underlying T. Wrap here so the call
        // expression's static type matches the kickoff method's return type.
        if method.IsAsync && !method.IsAsyncVoid && !isAsyncIteratorReturnType(method.Type) {
            let asyncReturn = wrapAsTask(method.Type, method.AsyncReturnsValueTask)
            return MakeCall(asyncReturn)
        }
        // ADR-0174 D4: a suspending method's call is typed ValueTask[R]; the caller sees R.
        if method.IsSuspending {
            return completeSuspendingCall(
                MakeCall(wrapAsTask(method.Type, true)),
                method.Type,
                ce.Location,
                method.Name
            )
        }
        return MakeCall(returnTypeOverride: nil)
    }

    shared {
        private func GetIndirectCallableParameterNames(callee BoundExpression) ImmutableArray[string] {
            if callee is BoundVariableExpression variable {
                return variable.Variable.CallableParameterNames
            }
            if callee is BoundFunctionLiteralExpression literal {
                let names = ImmutableArray.CreateBuilder[string](literal.Function.Parameters.Length)
                for parameter in literal.Function.Parameters {
                    names.Add(parameter.Name)
                }
                return names.MoveToImmutable()
            }
            return default(ImmutableArray[string])
        }

        private func TryBuildReceiverSubstitution(receiverType TypeSymbol) Dictionary[
            TypeParameterSymbol,
            TypeSymbol
        ]? {
            let start StructSymbol? = switch receiverType {
                case receiverStruct is StructSymbol: receiverStruct
                case TypeParameterSymbol{ClassConstraint: StructSymbol constraint}: constraint
                default: default(StructSymbol?)
            }
            if start == nil {
                return nil
            }
            // Issue #1250: an inherited method's signature is declared in terms of
            // its declaring class's type parameters (e.g. `LinkTo(next FilterBase[TOut])`
            // on `TransformBase[TIn, TOut]`). When the method is reached through a
            // derived receiver (`AudioFilter : TransformBase[FrameEntry, FrameEntry]`),
            // the substitution must compose every hop of the base chain so the
            // inherited type parameters (TIn/TOut) resolve to the concrete arguments
            // seen at the most-derived level. Walk the chain accumulating each
            // class's declaration-parameter -> (resolved) argument mappings, exactly
            // like Conversion.DerivesFromConstructed threads its map for subtyping.
            var map_ Dictionary[TypeParameterSymbol, TypeSymbol]? = nil
            for c in start.GetHierarchy() {
                // Issue #1537: a receiver that is a generic type nested inside a
                // generic enclosing type (e.g. `Outer[int32].Middle[string]`)
                // carries the enclosing construction's arguments on
                // EnclosingTypeArguments (`[int32]`) separately from its own
                // arguments (`[string]`). An instance method's signature may mention
                // the ENCLOSING type's parameters (a method returning `U`), so map
                // each enclosing parameter to its construction argument in addition
                // to the own parameter -> own argument mappings below.
                if !c.EnclosingTypeArguments.IsDefaultOrEmpty {
                    let enclosingParams = StructSymbol.CollectEnclosingTypeParameters(c)
                    let enclosingCount = Math.Min(enclosingParams.Length, c.EnclosingTypeArguments.Length)
                    for var i = 0; i < enclosingCount; i++ {
                        var arg = c.EnclosingTypeArguments[i]
                        if arg is TypeParameterSymbol tpEnc && map_ != nil && map_.TryGetValue(
                            tpEnc,
                            out var resolvedEnc
                        ) {
                            arg = resolvedEnc
                        }
                        map_ ??= Dictionary[TypeParameterSymbol, TypeSymbol]()
                        map_!![enclosingParams[i]] = arg
                    }
                }
                if c.Definition == nil || object.ReferenceEquals(c.Definition, c) ||
                    c
                    .TypeArguments
                    .IsDefaultOrEmpty ||
                    c.Definition!!
                    .TypeParameters
                    .IsDefaultOrEmpty {
                    continue
                }
                let defTps = c.Definition!!.TypeParameters
                let count = Math.Min(defTps.Length, c.TypeArguments.Length)
                for var i = 0; i < count; i++ {
                    var arg = c.TypeArguments[i]
                    // Resolve an argument that is itself one of a more-derived
                    // class's type parameters through the running map.
                    if arg is TypeParameterSymbol tpArg && map_ != nil && map_.TryGetValue(tpArg, out var resolved) {
                        arg = resolved
                    }
                    map_ ??= Dictionary[TypeParameterSymbol, TypeSymbol]()
                    map_!![defTps[i]] = arg
                }
            }
            return map_
        }
    }
}
