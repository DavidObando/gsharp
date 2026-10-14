// <copyright file="InterpolatedStringHandlerInfo.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Symbols
import System

/// Issue #368 / ADR-0055: describes the user-defined interpolated-string-handler
/// target an interpolated string is being converted to when it is passed to a
/// method/constructor parameter whose type is attributed
/// `[InterpolatedStringHandler]`.
/// @remarks When present on a (cref:BoundInterpolatedStringExpression), the emit
/// lowerer constructs the user handler (with the forwarded arguments resolved by
/// `[InterpolatedStringHandlerArgument]`) instead of the default
/// `DefaultInterpolatedStringHandler`, and yields the handler value itself
/// (rather than `ToStringAndClear()`) as the argument value. Mirrors the
/// C# 10 semantics: the handler constructor receives
/// `(int literalLength, int formattedCount [, ...forwarded args] [, out bool shouldAppend])`.
class InterpolatedStringHandlerInfo {
    private init(
        handlerClrType Type,
        handlerType TypeSymbol,
        constructor ConstructorInfo,
        forwardedArguments ImmutableArray[BoundExpression],
        hasTrailingOutBool bool,
        forwardedSourceIndices ImmutableArray[int32],
        handlerRefKind RefKind
    ) {
        HandlerClrType = handlerClrType
        HandlerType = handlerType
        Constructor = constructor
        ForwardedArguments = forwardedArguments
        HasTrailingOutBool = hasTrailingOutBool
        ForwardedSourceIndices = forwardedSourceIndices
        HandlerRefKind = handlerRefKind
    }

    /// Gets the reflection type of the handler.
    prop HandlerClrType Type {
        get;
    }

    /// Gets the handler type symbol.
    prop HandlerType TypeSymbol {
        get;
    }

    /// Gets the selected handler constructor.
    prop Constructor ConstructorInfo {
        get;
    }

    /// Gets the bound expressions forwarded into the constructor after the
    /// `(literalLength, formattedCount)` pair, in constructor order.
    prop ForwardedArguments ImmutableArray[BoundExpression] {
        get;
    }

    /// Gets a value indicating whether the constructor ends with an `out bool` short-circuit parameter.
    prop HasTrailingOutBool bool {
        get;
    }

    /// Gets, for each entry in (cref:ForwardedArguments), the index of
    /// the originating sibling parameter (`-1` denotes the instance
    /// receiver). Issue #377 sub-item 2: used by the call binder to capture
    /// each forwarded source into a single temp shared by the parent
    /// argument slot and the handler constructor so the source expression
    /// is evaluated exactly once.
    prop ForwardedSourceIndices ImmutableArray[int32] {
        get;
    }

    /// Gets the (cref:RefKind) of the handler-typed parameter
    /// ((cref:RefKind.None), (cref:RefKind.Ref),
    /// (cref:RefKind.In), or (cref:RefKind.Out)). Issue #377
    /// sub-item 1: the lowerer uses this to feed the constructed handler
    /// local by-ref/in/out to the consuming method.
    prop HandlerRefKind RefKind {
        get;
    }

    /// Returns a copy of this info with rewritten forwarded arguments (used by tree rewriters).
    /// @param forwardedArguments The replacement forwarded arguments.
    /// @returns The updated info.
    func WithForwardedArguments(
        forwardedArguments ImmutableArray[BoundExpression]
    ) InterpolatedStringHandlerInfo -> InterpolatedStringHandlerInfo(
        HandlerClrType,
        HandlerType,
        Constructor,
        forwardedArguments,
        HasTrailingOutBool,
        ForwardedSourceIndices,
        HandlerRefKind
    )

    internal func WithCapturedForwardedArguments(
        forwardedArguments ImmutableArray[BoundExpression]
    ) InterpolatedStringHandlerInfo -> InterpolatedStringHandlerInfo(
        HandlerClrType,
        HandlerType,
        Constructor,
        forwardedArguments,
        HasTrailingOutBool,
        ImmutableArray[int32].Empty,
        HandlerRefKind
    )

    internal func WithHandlerRefKind(
        handlerRefKind RefKind
    ) InterpolatedStringHandlerInfo -> InterpolatedStringHandlerInfo(
        HandlerClrType,
        HandlerType,
        Constructor,
        ForwardedArguments,
        HasTrailingOutBool,
        ForwardedSourceIndices,
        handlerRefKind
    )

    shared {
        /// The CLR name of the `[InterpolatedStringHandler]` marker attribute.
        const HandlerAttributeName string = "System.Runtime.CompilerServices.InterpolatedStringHandlerAttribute"

        /// The CLR name of the `[InterpolatedStringHandlerArgument]` attribute.
        const ArgumentAttributeName string = "System.Runtime.CompilerServices.InterpolatedStringHandlerArgumentAttribute"

        /// Determines whether [`type`](paramref) is attributed
        /// `[InterpolatedStringHandler]`. Uses (cref:CustomAttributeData)
        /// so it is safe under a `MetadataLoadContext`.
        /// @param type The candidate parameter type (already by-ref peeled).
        /// @returns `true` when the type is a handler.
        func IsHandlerType(type Type?) bool {
            var type = type
            if type == nil {
                return false
            }
            if type.IsByRef {
                type = type.GetElementType()
                if type == nil {
                    return false
                }
            }
            try {
                for attribute in type!!.GetCustomAttributesData() {
                    if string.Equals(
                        attribute.AttributeType?.FullName,
                        HandlerAttributeName,
                        StringComparison.Ordinal
                    ) {
                        return true
                    }
                }
            } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                return false
            }
            return false
        }

        /// Reads the forwarded-argument names declared by an
        /// `[InterpolatedStringHandlerArgument]` attribute on
        /// [`parameter`](paramref). Returns an empty array when none is present
        /// (the handler constructor then takes only `(literalLength, formattedCount)`).
        /// @param parameter The handler-typed parameter.
        /// @returns The forwarded names in declaration order; `""` denotes the receiver.
        func ReadForwardedNames(parameter ParameterInfo) ImmutableArray[string?] {
            for attribute in parameter.GetCustomAttributesData() {
                if !string.Equals(attribute.AttributeType?.FullName, ArgumentAttributeName, StringComparison.Ordinal) {
                    continue
                }
                if attribute.ConstructorArguments.Count != 1 {
                    continue
                }
                let arg = attribute.ConstructorArguments[0]
                // The string overload: [InterpolatedStringHandlerArgument("name")].
                if arg.Value is string single {
                    return ImmutableArray.Create[string?](single)
                }
                // The params string[] overload: [InterpolatedStringHandlerArgument("a", "b")].
                if arg.Value is IReadOnlyList[CustomAttributeTypedArgument]many {
                    let builder = ImmutableArray.CreateBuilder[string?](many.Count)
                    for element in many {
                        builder.Add(element.Value as string)
                    }
                    return builder.ToImmutable()
                }
            }
            return ImmutableArray[string?].Empty
        }

        /// Builds the handler info for a handler-typed parameter, resolving the
        /// forwarded sibling arguments / receiver and selecting the matching
        /// constructor. Returns `null` when no compatible
        /// constructor exists or a referenced argument name cannot be resolved
        /// (the caller then reports a diagnostic / leaves the argument as-is).
        /// @param handlerClrType The handler parameter type (by-ref peeled).
        /// @param parameter The handler-typed parameter (source of the forwarding attribute).
        /// @param parameters All parameters of the resolved method/constructor.
        /// @param arguments The bound positional arguments aligned with [`parameters`](paramref).
        /// @param receiver The instance receiver for the call, or `null`.
        /// @param failure A human-readable reason when the result is `null`.
        /// @returns The resolved handler info, or `null`.
        func TryCreate(
            handlerClrType Type,
            parameter ParameterInfo,
            parameters[]ParameterInfo,
            arguments ImmutableArray[BoundExpression],
            receiver BoundExpression?,
            out failure string?
        ) InterpolatedStringHandlerInfo? -> TryCreate(
            handlerClrType,
            parameter,
            parameters,
            arguments,
            receiver,
            default(ImmutableArray[int32]),
            Array.IndexOf(parameters, parameter),
            ImmutableArray[BoundInterpolatedStringPart].Empty,
            out failure
        )

        internal func TryCreate(
            handlerClrType Type,
            parameter ParameterInfo,
            parameters[]ParameterInfo,
            arguments ImmutableArray[BoundExpression],
            receiver BoundExpression?,
            parameterMapping ImmutableArray[int32],
            handlerSourceIndex int32,
            parts ImmutableArray[BoundInterpolatedStringPart],
            out failure string?
        ) InterpolatedStringHandlerInfo? {
            failure = nil
            // Issue #377 sub-item 1: a `[InterpolatedStringHandler]` parameter
            // may be byref (typical for `ref struct` handlers such as
            // DefaultInterpolatedStringHandler). Peel the byref before walking
            // attributes / constructors, and capture the RefKind so the call
            // emitter feeds the constructed handler local by-ref/in/out.
            let paramType = parameter.ParameterType
            let peeled Type? = if paramType.IsByRef {
                paramType.GetElementType()
            } else {
                handlerClrType
            }
            if peeled == nil {
                failure = "the handler parameter has no element type"
                return nil
            }
            let names = ReadForwardedNames(parameter)
            let forwarded = ImmutableArray.CreateBuilder[BoundExpression](names.Length)
            let sources = ImmutableArray.CreateBuilder[int32](names.Length)
            for name in names {
                if string.IsNullOrEmpty(name) {
                    if receiver == nil {
                        failure = "the handler argument references the receiver ('') but the call has no instance receiver"
                        return nil
                    }
                    forwarded.Add(receiver)
                    sources.Add(-1)
                    continue
                }
                var index = -1
                for var i = 0; i < parameters.Length; i++ {
                    if string.Equals(parameters[i].Name, name, StringComparison.Ordinal) {
                        index = i
                        break
                    }
                }
                var sourceIndex = index
                if !parameterMapping.IsDefaultOrEmpty {
                    sourceIndex = -1
                    for var source = 0; source < parameterMapping.Length; source++ {
                        if parameterMapping[source] == index {
                            sourceIndex = source
                            break
                        }
                    }
                }
                // Handler forwarding may only reference arguments already
                // evaluated in lexical source order (C# CS8950 semantics).
                if sourceIndex < 0 || sourceIndex >= arguments.Length || sourceIndex >= handlerSourceIndex {
                    failure = "the handler argument references parameter '$name', which is not a preceding argument of this call"
                    return nil
                }
                forwarded.Add(arguments[sourceIndex])
                sources.Add(sourceIndex)
            }
            let forwardedArgs = forwarded.ToImmutable()
            let constructor ConstructorInfo? = SelectConstructor(peeled, forwardedArgs, out var hasOutBool)
            if constructor == nil {
                failure = "'${peeled.Name}' has no interpolated-string-handler constructor matching the forwarded arguments"
                return nil
            }
            if !ValidateAppendMethods(peeled, parts, out failure) {
                return nil
            }
            // Issue #377 sub-item 1: capture the parameter's RefKind so the call
            // binder/lowerer can feed the constructed handler local by-ref.
            var handlerRefKind = RefKind.None
            if paramType.IsByRef {
                if parameter.IsOut {
                    handlerRefKind = RefKind.Out
                } else if parameter.IsIn {
                    handlerRefKind = RefKind.In
                } else {
                    handlerRefKind = RefKind.Ref
                }
            }
            return InterpolatedStringHandlerInfo(
                peeled,
                ReadHandlerType(parameter, peeled),
                constructor,
                forwardedArgs,
                hasOutBool,
                sources.ToImmutable(),
                handlerRefKind
            )
        }

        internal func TryResolveAppendFormatted(
            handlerType Type,
            part BoundInterpolatedStringPart,
            holeType TypeSymbol,
            @NotNullWhen(true) out method MethodInfo?,
            out typeArguments ImmutableArray[TypeSymbol]
        ) bool {
            method = nil
            typeArguments = default(ImmutableArray[TypeSymbol])
            let wantAlign = (part.Alignment != nil)
            let wantFormat = part.Format != nil
            let extra = (
                if wantAlign {
                    1
                } else {
                    0
                }
            ) +
                (
                if wantFormat {
                    1
                } else {
                    0
                }
            )
            let contextType = FindCoreContextType(handlerType)
            let intType = ClrTypeUtilities.RemapHostCoreTypeToContext(typeof(int32), contextType)
            let stringType = ClrTypeUtilities.RemapHostCoreTypeToContext(typeof(string), contextType)
            let candidates = ImmutableArray.CreateBuilder[MethodInfo]()
            for candidate in handlerType.GetMethods(BindingFlags.Public | BindingFlags.Instance) {
                if candidate.Name != "AppendFormatted" {
                    continue
                }
                let parameters = candidate.GetParameters()
                if parameters.Length != 1 + extra {
                    continue
                }
                var index = 1
                if wantAlign && !parameters[index++].ParameterType.IsSameAs(intType) {
                    continue
                }
                if wantFormat && !parameters[index].ParameterType.IsSameAs(stringType) {
                    continue
                }
                candidates.Add(candidate)
            }
            if candidates.Count == 0 {
                return false
            }
            let valueClrType Type? = ClrTypeUtilities.RemapHostCoreTypeToContext(
                NullableTypeSymbol.GetEffectiveClrType(holeType),
                contextType
            )
            if valueClrType != nil {
                let argumentTypes = [1 + extra]Type
                argumentTypes[0] = valueClrType
                var index = 1
                if wantAlign {
                    argumentTypes[index] = intType!!
                    index++
                }
                if wantFormat {
                    argumentTypes[index] = stringType!!
                }
                let resolution = ClrOverloadResolution.Resolve[MethodInfo](candidates, argumentTypes)
                if resolution.Outcome == ClrOverloadResolution.ResolutionOutcome.Resolved {
                    method = Invariant.Required(
                        resolution.Best,
                        "a resolved CLR overload has a best method",
                        expression: "resolution.Best"
                    )
                } else if resolution.Outcome == ClrOverloadResolution.ResolutionOutcome.Ambiguous {
                    for candidate in resolution.Ambiguous {
                        if candidate.IsGenericMethod {
                            continue
                        }
                        if method != nil {
                            method = nil
                            break
                        }
                        method = candidate
                    }
                }
                if method == nil {
                    return false
                }
            } else {
                method = nil
                for candidate in candidates {
                    if candidate.IsGenericMethodDefinition {
                        method = candidate
                        break
                    }
                }
                method ??= candidates[0]
            }
            if !method!!.IsGenericMethodDefinition {
                return true
            }
            if valueClrType != nil {
                method = method!!.MakeGenericMethod(valueClrType)
                return true
            }
            method = method!!.MakeGenericMethod(
                ClrTypeUtilities.RemapHostCoreTypeToContext(typeof(object), contextType)!!
            )
            typeArguments = ImmutableArray.Create(holeType)
            return true
        }

        internal func TryResolveAppendLiteral(handlerType Type, @NotNullWhen(true) out method MethodInfo?) bool {
            method = handlerType.GetMethods(BindingFlags.Public | BindingFlags.Instance).FirstOrDefault(
                (candidate MethodInfo) -> {
                    if candidate.Name != "AppendLiteral" {
                        return false
                    }
                    let parameters = candidate.GetParameters()
                    return parameters.Length == 1 && parameters[0].ParameterType.IsSameAs(typeof(string))
                }
            )
            return method != nil
        }

        private func FindCoreContextType(handlerType Type) Type {
            for constructor in handlerType.GetConstructors(BindingFlags.Public | BindingFlags.Instance) {
                for parameter in constructor.GetParameters() {
                    let parameterType Type? = if parameter.ParameterType.IsByRef {
                        parameter.ParameterType.GetElementType()
                    } else {
                        parameter.ParameterType
                    }
                    if parameterType != nil && parameterType.IsSameAs(typeof(int32)) {
                        return parameterType
                    }
                }
            }
            return handlerType
        }

        private func ValidateAppendMethods(
            handlerType Type,
            parts ImmutableArray[BoundInterpolatedStringPart],
            out failure string?
        ) bool {
            failure = nil
            if parts.Any((part BoundInterpolatedStringPart) -> part.IsLiteral && part.Literal is {Length: > 0}) &&
                !TryResolveAppendLiteral(handlerType, out _) {
                failure = "'${handlerType.Name}' has no AppendLiteral(string) method"
                return false
            }
            for part in parts {
                if part.IsHole {
                    let hole BoundExpression? = part.Value
                    if hole == nil || !TryResolveAppendFormatted(handlerType, part, hole.Type, out _, out _) {
                        let shape = if (part.Alignment != nil) && part.Format != nil {
                            "(value, int, string)"
                        } else {
                            (
                                if (part.Alignment != nil) {
                                    "(value, int)"
                                } else {
                                    (
                                        if part.Format != nil {
                                            "(value, string)"
                                        } else {
                                            "(value)"
                                        }
                                    )
                                }
                            )
                        }
                        failure = "'${handlerType.Name}' has no applicable AppendFormatted$shape method"
                        return false
                    }
                }
            }
            return true
        }

        private func SelectConstructor(
            handlerClrType Type,
            forwardedArgs ImmutableArray[BoundExpression],
            out hasOutBool bool
        ) ConstructorInfo? {
            hasOutBool = false
            var match ConstructorInfo? = nil
            var matchOutBool = false
            for ctor in handlerClrType.GetConstructors(BindingFlags.Public | BindingFlags.Instance) {
                let ps = ctor.GetParameters()
                // The shape is (int literalLength, int formattedCount, <forwarded...>, [out bool]).
                if ps.Length < 2 + forwardedArgs.Length {
                    continue
                }
                if !IsInt32(ps[0].ParameterType) || !IsInt32(ps[1].ParameterType) {
                    continue
                }
                var ok = true
                for var i = 0; i < forwardedArgs.Length; i++ {
                    var paramType = ps[2 + i].ParameterType
                    if paramType.IsByRef {
                        paramType = paramType.GetElementType()!!
                    }
                    let argType Type? = forwardedArgs[i].Type?.ClrType
                    if argType != nil && ClrOverloadResolution.ClassifyImplicit(
                        paramType,
                        argType
                    ) == ClrOverloadResolution
                        .ImplicitConversionKind
                        .None {
                        ok = false
                        break
                    }
                }
                if !ok {
                    continue
                }
                let remaining = ps.Length - (2 + forwardedArgs.Length)
                var ctorOutBool bool
                if remaining == 0 {
                    ctorOutBool = false
                } else if remaining == 1 && ps[ps.Length - 1].IsOut && IsBoolean(ps[ps.Length - 1].ParameterType) {
                    ctorOutBool = true
                } else {
                    continue
                }
                // Prefer the constructor that does not need the out-bool gate when
                // both are present (fewer parameters), matching C#'s preference.
                if match == nil || (matchOutBool && !ctorOutBool) {
                    match = ctor
                    matchOutBool = ctorOutBool
                }
            }
            hasOutBool = matchOutBool
            return match
        }

        private func IsInt32(t Type?) bool -> string.Equals(t?.FullName, "System.Int32", StringComparison.Ordinal)

        private func IsBoolean(t Type?) bool {
            var t = t
            if t?.IsByRef == true {
                t = t!!.GetElementType()
            }
            return string.Equals(t?.FullName, "System.Boolean", StringComparison.Ordinal)
        }

        /// The handler local's type: the parameter's bare (by-ref peeled) shape,
        /// read through the funnel — or, for a `params` array of handlers,
        /// its element. A handler is constructed, never nil.
        private func ReadHandlerType(parameter ParameterInfo, handler Type) TypeSymbol {
            let read = ClrNullability.GetParameterTypeSymbol(parameter).StripToBareShape()
            if ClrTypeUtilities.AreSame(read.ClrType, handler) {
                return read
            }
            let elements = read.GetElementPositions()
            return if elements.Length == 1 {
                elements[0].StripToBareShape()
            } else {
                read
            }
        }
    }
}
