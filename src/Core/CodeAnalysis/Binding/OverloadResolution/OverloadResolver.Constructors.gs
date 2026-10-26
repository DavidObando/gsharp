// <copyright file="OverloadResolver.Constructors.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding.OverloadResolution

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Documentation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

internal partial class OverloadResolver {
    func BindConstructorCallExpression(syntax CallExpressionSyntax, classType StructSymbol) BoundExpression {
        let bound = BindConstructorCallExpressionCore(syntax, classType)
        // Issue #2263: an imported `data class` is a reference type whose CLR
        // type (and real parameterless + primary constructors) are already
        // emitted. Normalise its construction to the SAME
        // BoundStructLiteralExpression the `with`/copy path produces so the
        // emitter uses one consistent lowering (`newobj .ctor(); dup; <value>;
        // stfld` per field) and — crucially — the data class keeps a single
        // semantic-aggregate identity in EVERY position (let-initializer,
        // argument, return, member access). Binding construction to a plain
        // CLR-ctor call instead would surface a bare ImportedTypeSymbol here
        // while the type clause / return / member paths surface the aggregate,
        // reintroducing the dual identity that breaks `with` non-deterministically.
        if bound is BoundConstructorCallExpression ctorCall &&
            ctorCall
            .StructType
            .ClrType != nil &&
            ctorCall
            .StructType
            .IsData &&
            (ctorCall.StructType.IsClass || ctorCall.StructType.UsesConstructorOwnedDataConstruction) {
            return LowerImportedDataClassConstruction(ctorCall)
        }
        return bound
    }

    private func BindConstructorCallExpressionCore(
        syntax CallExpressionSyntax,
        classType StructSymbol
    ) BoundExpression {
        var classType = classType
        // ADR-0047 §6 / #175: primary-constructor call `Foo(...)` is a
        // use of the class type itself.
        reportObsoleteUseIfApplicable(syntax.Identifier.Location, classType, classType.Name)
        // Issue #987: an abstract class (one with a still-abstract method in its
        // effective member set) cannot be instantiated. Report GS0386 and stop —
        // this is the clean compile error C# gives for `new AbstractType()`
        // (CS0144) rather than a runtime failure. Base-class construction by a
        // derived ctor flows through BaseConstructorInitializer, not here, so the
        // abstract base is still constructible as a base subobject.
        if classType.IsAbstract {
            Diagnostics.ReportCannotInstantiateAbstractType(syntax.Identifier.Location, classType.Name)
            return BoundErrorExpression(syntax)
        }
        // Issue #306: a class declaring an explicit `init(...)` constructor is
        // constructed against that constructor's parameter list rather than a
        // primary-constructor parameter list.
        if !classType
            .EffectiveExplicitConstructors
            .IsDefaultOrEmpty &&
            !(
            classType.HasSynthesizedDataConstructor &&
                classType
                .PrimaryConstructorParameters
                .IsEmpty &&
                syntax
                .Arguments
                .Count == 0
        ) {
            return BindExplicitConstructorCallExpression(syntax, classType)
        }
        // Issue #343: pre-validate named-argument layout (positional precedes
        // named, no duplicate names). Diagnostics are reported by the helper.
        if !TryAnalyzeCallArgumentLayout(syntax.Arguments, out _, out var argumentNames) {
            return BoundErrorExpression(syntax)
        }
        // Phase 4.3b / ADR-0020: a primary-constructor call on a generic
        // class definition (`Box(5)` or `Box[int](5)`) builds a type-argument
        // substitution before resolving the parameter list against the
        // user-supplied arguments. Explicit `[…]` wins; otherwise we infer
        // from value-argument types against the definition's primary-ctor
        // parameter types (first-seen-wins, same rule as 4.1 call sites).
        if classType.IsGenericDefinition {
            let tps = classType.TypeParameters
            let defParams = classType.PrimaryConstructorParameters
            let substitution = Dictionary[TypeParameterSymbol, TypeSymbol]()
            if syntax.TypeArgumentList != nil {
                let explicitArgs = syntax.TypeArgumentList.Arguments
                if explicitArgs.Count != tps.Length {
                    Diagnostics.ReportWrongTypeArgumentCount(
                        syntax.TypeArgumentList.Location,
                        classType.Name,
                        tps.Length,
                        explicitArgs.Count
                    )
                    return BoundErrorExpression(syntax)
                }
                for var i = 0; i < explicitArgs.Count; i++ {
                    let ta TypeSymbol? = bindTypeClause(explicitArgs[i])
                    if ta == nil {
                        return BoundErrorExpression(syntax)
                    }
                    substitution[tps[i]] = ta
                }
            } else {
                // Issue #1629: the pre-bind below is a throwaway probe used only
                // to infer type arguments — the same argument syntax is bound
                // again for real once the type arguments are known (loop after
                // this generic block). Roll back any diagnostics it produced so
                // they are reported exactly once, by the real bind.
                let inferenceDiagMark = Diagnostics.Count
                // Pre-bind arguments and infer type arguments from them.
                // Issue #343: when an argument is named, locate its parameter
                // by name (so type inference still works with named args) and
                // unwrap the wrapper before binding.
                //
                // ADR-0101 follow-up / issue #819: when the primary constructor
                // declares a trailing variadic parameter (`name ...T`), drive
                // inference for that slot from EITHER the slice element type
                // (one argument of type `[]T'` — pass-through) OR from each
                // trailing argument's type (multiple positional args — pack).
                // Mirrors `BindCallExpression` ADR-0101 inference. Named args
                // are not legal at a variadic call site (the call layout has
                // no slot name).
                let defIsVariadic = defParams.Length > 0 && defParams[defParams.Length - 1].IsVariadic
                let defFixedCount = if defIsVariadic {
                    defParams.Length - 1
                } else {
                    defParams.Length
                }
                for var i = 0; i < syntax.Arguments.Count; i++ {
                    var argSyntax = syntax.Arguments[i]
                    var paramIdx int32
                    if argSyntax is NamedArgumentExpressionSyntax named {
                        paramIdx = -1
                        for var p = 0; p < defParams.Length; p++ {
                            if string.Equals(defParams[p].Name, named.NameToken.ValueText, StringComparison.Ordinal) {
                                paramIdx = p
                                break
                            }
                        }
                        if paramIdx < 0 {
                            continue
                        }
                        argSyntax = named.Expression
                    } else {
                        paramIdx = i
                    }
                    if defIsVariadic && paramIdx >= defFixedCount {
                        // Variadic slot: handled in the dedicated block below
                        // so we can choose between pass-through and pack.
                        continue
                    }
                    if paramIdx >= defParams.Length {
                        continue
                    }
                    let preBound = bindExpression(argSyntax)
                    inferTypeArguments(defParams[paramIdx].Type, preBound.Type, substitution)
                }
                if defIsVariadic {
                    let variadicParamType = defParams[defParams.Length - 1].Type
                    let trailingCount = syntax.Arguments.Count - defFixedCount
                    if trailingCount == 1 {
                        let single = bindExpression(UnwrapNamedArgumentValue(syntax.Arguments[defFixedCount]))
                        if single.Type is SliceTypeSymbol {
                            inferTypeArguments(variadicParamType, single.Type, substitution)
                        } else if variadicParamType is SliceTypeSymbol variadicSlice {
                            inferTypeArguments(variadicSlice.ElementType, single.Type, substitution)
                        }
                    } else if trailingCount > 1 && variadicParamType is SliceTypeSymbol variadicSlice2 {
                        for var j = defFixedCount; j < syntax.Arguments.Count; j++ {
                            let preBound = bindExpression(UnwrapNamedArgumentValue(syntax.Arguments[j]))
                            inferTypeArguments(variadicSlice2.ElementType, preBound.Type, substitution)
                        }
                    }
                }
                // Issue #1629: discard the pre-bind's speculative diagnostics —
                // the arguments are bound again for real below.
                Diagnostics.TruncateTo(inferenceDiagMark)
                for tp in tps {
                    if !substitution.ContainsKey(tp) {
                        Diagnostics.ReportTypeArgumentInferenceFailed(
                            syntax.Identifier.Location,
                            classType.Name,
                            tp.Name
                        )
                        return BoundErrorExpression(syntax)
                    }
                }
            }
            let constraintLocation = if syntax.TypeArgumentList != nil {
                syntax.TypeArgumentList.Location
            } else {
                syntax.Identifier.Location
            }
            for tp in tps {
                let typeArg = substitution[tp]
                if !satisfiesConstraint(typeArg, tp, substitution) {
                    Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(
                        constraintLocation,
                        tp.Name,
                        typeArg,
                        describeConstraint(tp)
                    )
                    return BoundErrorExpression(syntax)
                }
            }
            let typeArgs = ImmutableArray.CreateBuilder[TypeSymbol](tps.Length)
            for tp in tps {
                typeArgs.Add(substitution[tp])
            }
            classType = if MapClrType is {} mapClrType {
                StructSymbol.Construct(classType, typeArgs.MoveToImmutable(), mapClrType)!!
            } else {
                StructSymbol.Construct(classType, typeArgs.MoveToImmutable())!!
            }
        } else if syntax.TypeArgumentList != nil && !IsClosedGenericImportedAggregate(classType) {
            // Issue #2278: a `classType` that is itself the semantic aggregate
            // for an already-CLOSED imported generic data type (e.g.
            // `Box[int32]`) is not a generic DEFINITION — its `TypeParameters`
            // is empty because reflection over the closed CLR type already
            // substituted every member. The caller
            // (TryBindClrConstructorCall) resolved and consumed the explicit
            // `[...]` type-argument list itself (via `Type.MakeGenericType`)
            // before building this aggregate, so seeing one here is expected
            // and must not be treated as an arity mismatch.
            Diagnostics.ReportWrongTypeArgumentCount(
                syntax.TypeArgumentList.Location,
                classType.Name,
                0,
                syntax.TypeArgumentList.Arguments.Count
            )
            return BoundErrorExpression(syntax)
        }
        let parameters = classType.PrimaryConstructorParameters
        let parameterNameAt(int32) -> string = (parameterIndex int32) -> parameters[parameterIndex].Name
        var boundArguments = ImmutableArray.CreateBuilder[BoundExpression](syntax.Arguments.Count)
        for argument in syntax.Arguments {
            // Issue #343: bind the value behind any named-argument wrapper.
            boundArguments.Add(BindOverloadArgumentValue(UnwrapNamedArgumentValue(argument)))
        }
        // ADR-0101 follow-up / issue #819: a primary constructor may declare a
        // trailing variadic parameter (`name ...T`). When present, the
        // matching auto-field has type `[]T`; at the call site we pack any
        // trailing positional arguments into a fresh `[]T` (or forward a
        // single `[]T` value unchanged). Named arguments are not legal at a
        // variadic call site because the trailing slot consumes any number of
        // positional arguments.
        let primaryIsVariadic = parameters.Length > 0 && parameters[parameters.Length - 1].IsVariadic
        if primaryIsVariadic {
            if !argumentNames.IsDefault {
                Diagnostics.ReportNamedArgumentParameterNotFound(
                    syntax.Identifier.Location,
                    classType.Name,
                    FirstNamedArgumentName(argumentNames)
                )
                return BoundErrorExpression(syntax)
            }
            let fixedPrimaryCount = parameters.Length - 1
            let requestedArgCount = syntax.Arguments.Count
            if requestedArgCount < fixedPrimaryCount {
                Diagnostics.ReportTooFewArgumentsForVariadic(
                    syntax.Identifier.Location,
                    classType.Name,
                    fixedPrimaryCount,
                    requestedArgCount
                )
                return BoundErrorExpression(syntax)
            }
            let variadicParam = parameters[parameters.Length - 1]
            let variadicSliceType = variadicParam.Type
            let parameterSyntaxV = [requestedArgCount]ExpressionSyntax
            for var i = 0; i < requestedArgCount; i++ {
                parameterSyntaxV[i] = syntax.Arguments[i]
            }
            // Convert/validate the fixed-portion arguments first.
            var hasErrorsV = false
            for var i = 0; i < fixedPrimaryCount; i++ {
                let argument = boundArguments[i]
                let parameter = parameters[i]
                if parameterSyntaxV[i] is InterpolatedStringExpressionSyntax interpolatedCtorArg &&
                    isFormattableStringTargetType(parameter.Type) {
                    boundArguments[i] = bindInterpolatedStringAsFormattable(interpolatedCtorArg, parameter.Type)
                    continue
                }
                if TryBindConstructorMethodGroup(
                    argument,
                    parameter.Type,
                    parameterSyntaxV[i].Location,
                    out var methodGroupArg
                ) {
                    boundArguments[i] = Invariant.Required(
                        methodGroupArg,
                        "a successful constructor method-group binding produces a bound expression",
                        expression: "methodGroupArg"
                    )
                    hasErrorsV |= methodGroupArg is BoundErrorExpression
                    continue
                }
                // Issue #2069/#2084: force the wrap for a func/arrow literal
                // argument flowing into a NAMED delegate parameter — see the
                // matching comment at the other constructor-argument path
                // (above in this file) for the full rationale. This is the
                // fixed-portion loop for a variadic constructor's arguments.
                if parameter.Type is DelegateTypeSymbol namedDelegateCtorFixedTarget &&
                    argument.Type is FunctionTypeSymbol &&
                    !object
                    .ReferenceEquals(argument.Type, namedDelegateCtorFixedTarget) {
                    boundArguments[i] = conversions.BindConversion(
                        parameterSyntaxV[i].Location,
                        argument,
                        parameter.Type
                    )
                    continue
                }
                // Issue #3907: an `@AllowNull` parameter declares that it
                // accepts a nil-carrying input, so the `T?` argument needs no
                // conversion at all and is forwarded as-is.
                if ConversionClassifier.AcceptsNilAnnotatedArgument(parameter, argument.Type, parameter.Type) {
                    continue
                }
                if argument.Type != parameter.Type && !conversions.ClassifyArgumentConversion(
                    argument.Type,
                    parameter.Type
                )
                    .IsImplicit {
                    if TryBindConstantNarrowingArgument(
                        argument,
                        parameter.Type,
                        parameterSyntaxV[i].Location,
                        out var narrowedArg
                    ) {
                        boundArguments[i] = Invariant.Required(
                            narrowedArg,
                            "a successful constant narrowing conversion produces a bound expression",
                            expression: "narrowedArg"
                        )
                        continue
                    }
                    if conversions.TryApplyUserDefinedImplicitArgumentConversion(
                        argument,
                        parameter.Type,
                        out var convertedArg
                    ) {
                        boundArguments[i] = convertedArg
                        continue
                    }
                    if argument.Type != TypeSymbol.Error {
                        Diagnostics.ReportWrongArgumentType(
                            parameterSyntaxV[i].Location,
                            parameter.Name,
                            parameter.Type,
                            argument.Type
                        )
                    }
                    hasErrorsV = true
                }
            }
            // Issue #1630: pack/pass-through the trailing arguments through
            // the canonical helper (applies #1493 element coercion when
            // packing).
            let packedArgs = PackOrPassThroughVariadicArguments(
                conversions,
                Diagnostics,
                syntax,
                boundArguments.ToImmutable(),
                fixedPrimaryCount,
                variadicSliceType,
                variadicParam.Name,
                (i int32) -> {
                    return parameterSyntaxV[i].Location
                },
                &hasErrorsV
            )
            if hasErrorsV {
                return BoundErrorExpression(syntax)
            }
            if classType.IsInline ||
                (classType.IsData && classType.ClrType == nil && classType.HasDeclaredPrimaryConstructor) {
                return BoundConstructorCallExpression(syntax, classType, packedArgs)
            }
            if !classType.IsClass {
                let fieldInitializersV = ImmutableArray.CreateBuilder[BoundFieldInitializer](parameters.Length)
                for var i = 0; i < parameters.Length; i++ {
                    if classType.TryGetField(parameters[i].Name, out var field) {
                        fieldInitializersV.Add(BoundFieldInitializer(field!!, packedArgs[i]))
                        continue
                    }
                    // Issue #2291: an imported C# `record struct`'s positional
                    // members are auto-properties, not plain fields — fall
                    // back to a settable property with the same name.
                    if TypeMemberModel.TryGetProperty(classType, parameters[i].Name, out var propertyV) &&
                        propertyV!!.HasSetter {
                        fieldInitializersV.Add(BoundFieldInitializer(propertyV!!, packedArgs[i]))
                    }
                }
                return BoundStructLiteralExpression(syntax, classType, fieldInitializersV.ToImmutable())
            }
            return BoundConstructorCallExpression(syntax, classType, packedArgs)
        }
        // ADR-0063 §5: primary constructors now honor optional parameters. When
        // the caller omits a value for a parameter that declared one, use the
        // overload-style permutation helper that fills defaults.
        var primaryHasOptional = false
        for var pi = 0; pi < parameters.Length; pi++ {
            if parameters[pi].HasExplicitDefaultValue {
                primaryHasOptional = true
                break
            }
        }
        if primaryHasOptional {
            if !TryReorderUserCallArgumentsWithDefaults(
                syntax.Arguments,
                boundArguments.ToImmutable(),
                parameters,
                classType.Name,
                syntax.Location,
                out var primaryParameterSyntax,
                out var primaryPermutedBound
            ) {
                return BoundErrorExpression(syntax)
            }
            boundArguments = ImmutableArray.CreateBuilder[BoundExpression](primaryPermutedBound.Length)
            for var i = 0; i < primaryPermutedBound.Length; i++ {
                boundArguments.Add(primaryPermutedBound[i])
            }
            var hasErrorsP = false
            for var i = 0; i < parameters.Length; i++ {
                let argument = boundArguments[i]
                let parameter = parameters[i]
                let converted = conversions.BindConversion(
                    primaryParameterSyntax[i]?.Location ?? syntax.Location,
                    argument,
                    parameter.Type,
                    allowExplicit: false
                )
                if object.ReferenceEquals(converted.Type, TypeSymbol.Error) {
                    hasErrorsP = true
                } else {
                    boundArguments[i] = converted
                }
            }
            if hasErrorsP {
                return BoundErrorExpression(syntax)
            }
            let optionalFinalArguments = PreserveNamedArgumentEvaluationOrder(
                syntax.Arguments,
                boundArguments.ToImmutable(),
                parameterNameAt
            )
            return BoundConstructorCallExpression(syntax, classType, optionalFinalArguments)
        }
        if syntax.Arguments.Count != parameters.Length {
            var span TextSpan
            if syntax.Arguments.Count > parameters.Length {
                var firstExceedingNode SyntaxNode
                if parameters.Length > 0 {
                    firstExceedingNode = Invariant.Required(
                        syntax.Arguments.GetSeparator(parameters.Length - 1),
                        "an argument list with too many arguments has a separator before the excess arguments",
                        expression: "syntax.Arguments.GetSeparator(parameters.Length - 1)"
                    )
                } else {
                    firstExceedingNode = Invariant.Required(
                        syntax.Arguments[0],
                        "an argument list with too many arguments has a first argument",
                        expression: "syntax.Arguments[0]"
                    )
                }
                let lastExceedingArgument = Invariant.Required(
                    syntax.Arguments[syntax.Arguments.Count - 1],
                    "an argument list with too many arguments has a last argument",
                    expression: "syntax.Arguments[syntax.Arguments.Count - 1]"
                )
                span = TextSpan.FromBounds(firstExceedingNode.Span.Start, lastExceedingArgument.Span.End)
            } else {
                span = syntax.CloseParenthesisToken.Span
            }
            Diagnostics.ReportWrongArgumentCount(
                TextLocation(
                    Invariant.Required(
                        syntax.Location.Text,
                        "a constructor call syntax location has source text",
                        expression: "syntax.Location.Text"
                    ),
                    span
                ),
                classType.Name,
                parameters.Length,
                syntax.Arguments.Count
            )
            return BoundErrorExpression(syntax)
        }
        // Issue #343: reorder bound arguments into parameter order when the
        // call mixes positional and named arguments. The per-position loop
        // below then sees the call as fully positional.
        var parameterSyntax[]ExpressionSyntax?
        if !argumentNames.IsDefault {
            if !TryReorderUserCallArguments(
                syntax.Arguments,
                boundArguments.ToImmutable(),
                parameters.Length,
                (p int32) -> {
                    return parameters[p].Name
                },
                classType.Name,
                out parameterSyntax,
                out var permutedBound
            ) {
                return BoundErrorExpression(syntax)
            }
            boundArguments = ImmutableArray.CreateBuilder[BoundExpression](permutedBound.Length)
            for var i = 0; i < permutedBound.Length; i++ {
                boundArguments.Add(permutedBound[i])
            }
        } else {
            parameterSyntax = [syntax.Arguments.Count]ExpressionSyntax
            for var i = 0; i < syntax.Arguments.Count; i++ {
                parameterSyntax[i] = syntax.Arguments[i]
            }
        }
        var hasErrors = false
        for var i = 0; i < parameters.Length; i++ {
            var argument = boundArguments[i]
            let parameter = parameters[i]
            // Issue #1238: re-bind a deferred target-typed conditional argument
            // against the constructor parameter type before the convertibility
            // checks below.
            boundArguments[i] = (
                argument = FinalizeBranchyArgument(
                    argument,
                    if i < parameterSyntax.Length {
                        parameterSyntax[i]
                    } else {
                        default(ExpressionSyntax?)
                    },
                    parameter.Type
                )
            )
            // ADR-0055 Tier 4 (#369): an interpolated-string argument targeting an
            // IFormattable/FormattableString constructor parameter lowers to
            // FormattableStringFactory.Create rather than an eager string.
            if parameterSyntax[i] is InterpolatedStringExpressionSyntax interpolatedCtorArg &&
                isFormattableStringTargetType(parameter.Type) {
                boundArguments[i] = bindInterpolatedStringAsFormattable(interpolatedCtorArg, parameter.Type)
                continue
            }
            // Issue #2069: a func/arrow literal argument flowing into a NAMED
            // delegate parameter classifies as an implicit conversion (see
            // Conversion.Classify's FunctionTypeSymbol -> DelegateTypeSymbol
            // structural-assignability branch) but is otherwise never routed
            // through BindConversion by the general implicit-conversion
            // fast path below, which leaves matching-shape arguments
            // unwrapped. Without an explicit BoundConversionExpression node,
            // the emitter materialises the literal against its natural
            // structural shape (System.Action/Func) instead of the named
            // delegate's own emitted TypeDef, producing unverifiable IL
            // ("Delegate has no emitted TypeDef" upstream, or a stack-type
            // mismatch downstream). Force the wrap here, mirroring the tuple/
            // nullable special cases below.
            if parameter.Type is DelegateTypeSymbol namedDelegateCtorTarget &&
                argument.Type is FunctionTypeSymbol &&
                !object
                .ReferenceEquals(argument.Type, namedDelegateCtorTarget) {
                boundArguments[i] = conversions.BindConversion(
                    Invariant.Required(
                        parameterSyntax[i],
                        "a delegate constructor argument has source syntax",
                        expression: "parameterSyntax[i]"
                    )
                        .Location,
                    argument,
                    parameter.Type
                )
                continue
            }
            if TryBindConstructorMethodGroup(
                argument,
                parameter.Type,
                Invariant.Required(
                    parameterSyntax[i],
                    "a constructor method-group argument has source syntax",
                    expression: "parameterSyntax[i]"
                )
                    .Location,
                out var methodGroupArg
            ) {
                boundArguments[i] = Invariant.Required(
                    methodGroupArg,
                    "a successful constructor method-group binding produces a bound expression",
                    expression: "methodGroupArg"
                )
                hasErrors |= methodGroupArg is BoundErrorExpression
                continue
            }
            // Issue #3907: an `@AllowNull` parameter declares that it accepts a
            // nil-carrying input, so the `T?` argument is forwarded as-is.
            if ConversionClassifier.AcceptsNilAnnotatedArgument(parameter, argument.Type, parameter.Type) {
                continue
            }
            if argument.Type != parameter.Type && !conversions.ClassifyArgumentConversion(argument.Type, parameter.Type)
                .IsImplicit {
                if TryConvertLiteralArgumentToExpressionTree(
                    argument,
                    parameter.Type,
                    Invariant.Required(
                        parameterSyntax[i],
                        "an expression-tree constructor argument has source syntax",
                        expression: "parameterSyntax[i]"
                    )
                        .Location,
                    out var expressionTreeArg
                ) {
                    boundArguments[i] = Invariant.Required(
                        expressionTreeArg,
                        "a successful expression-tree argument conversion produces a bound expression",
                        expression: "expressionTreeArg"
                    )
                    continue
                }
                // Issues #889/#3465: contextually bind lambda/delegate arguments.
                if parameter.RefKind == RefKind.None &&
                    TryConvertLambdaArgumentWithTarget(
                    argument,
                    parameter.Type,
                    Invariant.Required(
                        parameterSyntax[i],
                        "a delegate constructor argument has source syntax",
                        expression: "parameterSyntax[i]"
                    )
                        .Location,
                    out var targetTypedLambda,
                    parameter: parameter
                ) {
                    boundArguments[i] = Invariant.Required(
                        targetTypedLambda,
                        "a successful target-typed lambda conversion produces a bound expression",
                        expression: "targetTypedLambda"
                    )
                    continue
                }
                // Issue #1281: implicit constant-expression narrowing argument.
                if TryBindConstantNarrowingArgument(
                    argument,
                    parameter.Type,
                    Invariant.Required(
                        parameterSyntax[i],
                        "a narrowed constructor argument has source syntax",
                        expression: "parameterSyntax[i]"
                    )
                        .Location,
                    out var narrowedArg
                ) {
                    boundArguments[i] = Invariant.Required(
                        narrowedArg,
                        "a successful constant narrowing conversion produces a bound expression",
                        expression: "narrowedArg"
                    )
                    continue
                }
                if conversions.TryApplyUserDefinedImplicitArgumentConversion(
                    argument,
                    parameter.Type,
                    out var convertedArg
                ) {
                    boundArguments[i] = convertedArg
                    continue
                }
                if argument.Type != TypeSymbol.Error {
                    Diagnostics.ReportWrongArgumentType(
                        Invariant.Required(
                            parameterSyntax[i],
                            "a constructor argument with a conversion error has source syntax",
                            expression: "parameterSyntax[i]"
                        )
                            .Location,
                        parameter.Name,
                        parameter.Type,
                        argument.Type
                    )
                }
                hasErrors = true
            } else {
                // Issue #2364: the fixed-arity/non-optional primary-constructor
                // path validated that the argument-to-parameter conversion was
                // implicit above, but never actually bound it — the emitter
                // then received the raw, unconverted argument and had no way
                // to compensate (`MethodBodyEmitter.EmitConstructorCall` just
                // emits each bound argument as-is). This silently dropped every
                // non-identity implicit conversion (nullable wrapping, integral/
                // floating widening, user-defined implicit conversions, etc.)
                // at a primary-constructor call site, producing unverifiable IL
                // (ilverify `StackUnexpected`) despite a clean compile. Mirror
                // the sibling paths that already do this correctly:
                // `BindExplicitConstructorCallExpression`'s equivalent loop and
                // the `primaryHasOptional` branch above in this same method.
                boundArguments[i] = conversions.BindConversion(
                    Invariant.Required(
                        parameterSyntax[i],
                        "an implicitly converted constructor argument has source syntax",
                        expression: "parameterSyntax[i]"
                    )
                        .Location,
                    argument,
                    parameter.Type
                )
            }
        }
        if hasErrors {
            return BoundErrorExpression(syntax)
        }
        let finalArguments = PreserveNamedArgumentEvaluationOrder(
            syntax.Arguments,
            boundArguments.ToImmutable(),
            parameterNameAt
        )
        if classType.IsInline ||
            (classType.IsData && classType.ClrType == nil && classType.HasDeclaredPrimaryConstructor) {
            return BoundConstructorCallExpression(syntax, classType, finalArguments)
        }
        if !classType.IsClass {
            let fieldInitializers = ImmutableArray.CreateBuilder[BoundFieldInitializer](parameters.Length)
            for var i = 0; i < parameters.Length; i++ {
                if classType.TryGetField(parameters[i].Name, out var field) {
                    fieldInitializers.Add(BoundFieldInitializer(field!!, finalArguments[i]))
                    continue
                }
                // Issue #2291: an imported C# `record struct`'s positional
                // members are auto-properties, not plain fields — fall back
                // to a settable property with the same name.
                if TypeMemberModel.TryGetProperty(classType, parameters[i].Name, out var property) &&
                    (property!!.HasSetter || classType.UsesConstructorOwnedDataConstruction) {
                    fieldInitializers.Add(BoundFieldInitializer(property!!, finalArguments[i]))
                }
            }
            return BoundStructLiteralExpression(syntax, classType, fieldInitializers.ToImmutable())
        }
        return BoundConstructorCallExpression(syntax, classType, finalArguments)
    }

    /// Issue #306: binds a construction call `T(args)` to the class's explicit
    /// `init(...)` constructor, validating the argument count and applying
    /// argument conversions against the constructor's parameter list.
    private func BindExplicitConstructorCallExpression(
        syntax CallExpressionSyntax,
        classType StructSymbol
    ) BoundExpression {
        var classType = classType
        let inlineOutArgumentIndices = GetInlineOutArgumentIndices(syntax.Arguments)
        // Issue #343: pre-validate named-argument layout (positional precedes
        // named, no duplicate names). Diagnostics are reported by the helper.
        if !TryAnalyzeCallArgumentLayout(syntax.Arguments, out _, out var argumentNames) {
            DeclareInvalidInlineOutLocals(syntax.Arguments, inlineOutArgumentIndices)
            return BoundErrorExpression(syntax)
        }
        // Issue #1214: a generic class declaring an explicit `init(...)`
        // constructor is constructed at a closed type (`Box[int32](5, "x")`).
        // Resolve the type arguments — supplied explicitly or inferred from the
        // value arguments against the constructor's parameter list — and close
        // the definition before binding. The closed type's explicit
        // constructor surfaces through EffectiveExplicitConstructors (the open
        // definition's constructor table), with parameter types substituted via
        // GetConstructorParameterTypesForConstruction; the emitter references
        // the `.ctor` through a MemberRef parented at the construction's
        // TypeSpec (ResolveUserCtorTokenForExplicit).
        if syntax.TypeArgumentList != nil || classType.IsGenericDefinition {
            if !inlineOutArgumentIndices.IsDefaultOrEmpty {
                let openConstructors = GetAccessibleExplicitConstructorsOrAll(classType)
                let invalidInlineOutArgument = inlineOutArgumentIndices.FirstOrDefault(
                    (index int32) -> !openConstructors.Any(
                        (ctor ConstructorSymbol) -> ConstructorAcceptsInlineOutArgument(ctor, argumentNames, index)
                    ),
                    -1
                )
                if invalidInlineOutArgument >= 0 {
                    let inlineOut = cast[RefArgumentExpressionSyntax](
                        UnwrapNamedArgumentValue(syntax.Arguments[invalidInlineOutArgument])
                    )
                    Diagnostics.ReportOutDeclarationOutsideOutArgument(inlineOut.Location)
                    DeclareInvalidInlineOutLocals(syntax.Arguments, inlineOutArgumentIndices)
                    return BoundErrorExpression(syntax)
                }
            }
            if !TryCloseGenericExplicitConstructorType(
                syntax,
                classType,
                argumentNames,
                inlineOutArgumentIndices,
                out classType
            ) {
                DeclareUnresolvedInlineOutLocals(syntax.Arguments, inlineOutArgumentIndices)
                return BoundErrorExpression(syntax)
            }
        }
        // ADR-0063 §9: when the class declares multiple init(...) constructors,
        // bind the arguments first, then pick the constructor whose signature
        // best matches the call. With a single constructor the existing
        // single-overload diagnostics (wrong arity) still fire below.
        // Issue #1214: for a closed generic construction, the constructor table
        // lives on the open definition (EffectiveExplicitConstructors).
        var ctorOverloads = GetAccessibleExplicitConstructorsOrAll(classType)
        if !inlineOutArgumentIndices.IsDefaultOrEmpty {
            let invalidInlineOutArgument = inlineOutArgumentIndices.FirstOrDefault(
                (index int32) -> !ctorOverloads.Any(
                    (ctor ConstructorSymbol) -> ConstructorAcceptsInlineOutArgument(ctor, argumentNames, index)
                ),
                -1
            )
            if invalidInlineOutArgument >= 0 {
                let inlineOut = cast[RefArgumentExpressionSyntax](
                    UnwrapNamedArgumentValue(syntax.Arguments[invalidInlineOutArgument])
                )
                Diagnostics.ReportOutDeclarationOutsideOutArgument(inlineOut.Location)
                DeclareInvalidInlineOutLocals(syntax.Arguments, inlineOutArgumentIndices)
                return BoundErrorExpression(syntax)
            }
            ctorOverloads = ctorOverloads.Where(
                (ctor ConstructorSymbol) -> ConstructorAcceptsInlineOutArguments(
                    ctor,
                    argumentNames,
                    inlineOutArgumentIndices
                )
            )
                .ToImmutableArray()
            if ctorOverloads.IsDefaultOrEmpty {
                Diagnostics.ReportNoApplicableOverload(syntax.Identifier.Location, classType.Name)
                DeclareInvalidInlineOutLocals(syntax.Arguments, inlineOutArgumentIndices)
                return BoundErrorExpression(syntax)
            }
        }
        let boundArgumentsBuilder = ImmutableArray.CreateBuilder[BoundExpression](syntax.Arguments.Count)
        for var ai = 0; ai < syntax.Arguments.Count; ai++ {
            // Issue #343: peel any named-argument wrapper before binding so the
            // value is bound in source order. We will permute below.
            let argument = UnwrapNamedArgumentValue(syntax.Arguments[ai])
            var parameterForArg ParameterSymbol? = nil
            if ctorOverloads.Length == 1 {
                var parameterIndex = ai
                if !argumentNames.IsDefault && ai < argumentNames.Length && argumentNames[ai] is {} argumentName {
                    parameterIndex = -1
                    for var pi = 0; pi < ctorOverloads[0].Parameters.Length; pi++ {
                        if ctorOverloads[0].Parameters[pi].Name == argumentName {
                            parameterIndex = pi
                            break
                        }
                    }
                }
                if parameterIndex >= 0 && parameterIndex < ctorOverloads[0].Parameters.Length {
                    parameterForArg = ctorOverloads[0].Parameters[parameterIndex]
                }
            }
            var boundArgument BoundExpression? = nil
            let refArgument RefArgumentExpressionSyntax? = argument as RefArgumentExpressionSyntax
            if refArgument != nil {
                // The callback uses null to mean that overload resolution has
                // not identified the ref parameter yet; its legacy non-null
                // annotation predates that two-pass binding contract.
                boundArgument = bindRefArgumentExpression(refArgument, nil)
            }
            let lambdaArgument LambdaExpressionSyntax? = GetLambdaArgumentSyntax(argument)
            let lambdaTarget FunctionTypeSymbol? = parameterForArg?.Type as FunctionTypeSymbol
            if boundArgument == nil && lambdaArgument != nil && lambdaTarget != nil && bindLambdaWithTarget != nil {
                boundArgument = bindLambdaWithTarget!!(lambdaArgument, lambdaTarget)
            }
            if boundArgument == nil &&
                lambdaArgument != nil &&
                bindLambdaWithTarget != nil &&
                IsUntypedArrowLambda(lambdaArgument) {
                boundArgument = BoundErrorExpression(lambdaArgument)
            }
            boundArgument ??= BindOverloadArgumentValue(argument)
            boundArgumentsBuilder.Add(boundArgument!!)
        }
        if !inlineOutArgumentIndices.IsDefaultOrEmpty && ctorOverloads.Length > 1 {
            let hasFailedExplicitInlineOutType = inlineOutArgumentIndices.Any(
                (index int32) -> (
                    cast[RefArgumentExpressionSyntax](UnwrapNamedArgumentValue(syntax.Arguments[index]))
                ).DeclaredType != nil &&
                    boundArgumentsBuilder[index] is BoundAddressOfExpression{Operand: {Type: var argumentType}} &&
                    argumentType == TypeSymbol.Error
            )
            if hasFailedExplicitInlineOutType {
                DeclareUnresolvedInlineOutLocals(syntax.Arguments, inlineOutArgumentIndices, boundArgumentsBuilder)
                return BoundErrorExpression(syntax)
            }
            ctorOverloads = ctorOverloads.Where(
                (ctor ConstructorSymbol) -> ConstructorAcceptsTypedInlineOutArguments(
                    ctor,
                    classType,
                    argumentNames,
                    inlineOutArgumentIndices,
                    boundArgumentsBuilder
                )
            )
                .ToImmutableArray()
            if ctorOverloads.IsDefaultOrEmpty {
                Diagnostics.ReportNoApplicableOverload(syntax.Identifier.Location, classType.Name)
                DeclareUnresolvedInlineOutLocals(syntax.Arguments, inlineOutArgumentIndices, boundArgumentsBuilder)
                return BoundErrorExpression(syntax)
            }
        }
        var selectedCtor ConstructorSymbol?
        if ctorOverloads.Length <= 1 {
            selectedCtor = if ctorOverloads.Length == 1 {
                ctorOverloads[0]
            } else {
                classType.ExplicitConstructor
            }
        } else {
            let ctorFunctions = ImmutableArray.CreateBuilder[FunctionSymbol](ctorOverloads.Length)
            let constructorByFunction = Dictionary[FunctionSymbol, ConstructorSymbol]()
            for c in ctorOverloads {
                let candidate = CreateConstructedConstructorCandidate(c, classType)
                ctorFunctions.Add(candidate)
                constructorByFunction.Add(candidate, c)
            }
            let selectedFn FunctionSymbol? = SelectBestInstanceOverload(
                ctorFunctions.MoveToImmutable(),
                syntax.Arguments.Count,
                argumentNames,
                boundArgumentsBuilder.ToImmutable(),
                out var ambiguous,
                out var nullSafetyFailure,
                callSyntax: syntax
            )
            if selectedFn == nil {
                if nullSafetyFailure != nil {
                    let argLoc = if nullSafetyFailure.Index < syntax.Arguments.Count {
                        syntax.Arguments[nullSafetyFailure.Index].Location
                    } else {
                        syntax.Identifier.Location
                    }
                    Diagnostics.ReportWrongArgumentType(
                        argLoc,
                        nullSafetyFailure.ParamName,
                        nullSafetyFailure.ParamType,
                        nullSafetyFailure.ArgType
                    )
                } else if ambiguous {
                    Diagnostics.ReportAmbiguousOverloadResolution(syntax.Identifier.Location, classType.Name)
                } else {
                    Diagnostics.ReportNoApplicableOverload(syntax.Identifier.Location, classType.Name)
                }
                DeclareUnresolvedInlineOutLocals(syntax.Arguments, inlineOutArgumentIndices, boundArgumentsBuilder)
                return BoundErrorExpression(syntax)
            }
            selectedCtor = constructorByFunction[selectedFn]
        }
        selectedCtor = Invariant.Required(
            selectedCtor,
            "an applicable explicit constructor has a selected constructor symbol",
            expression: "selectedCtor"
        )
        let parameters = selectedCtor.Parameters
        let parameterNameAt(int32) -> string = (parameterIndex int32) -> parameters[parameterIndex].Name
        // Issue #1214: for a closed generic construction, surface the
        // constructor's parameter types with the construction's type arguments
        // substituted (`init(v T)` on `Box[int32]` → `init(v int32)`), so the
        // per-position conversion below targets the concrete argument types.
        // For a non-generic or open type these equal the declared types.
        let effectiveParamTypes = classType.GetConstructorParameterTypesForConstruction(selectedCtor)
        RebindSelectedConstructorInlineOutArguments(
            syntax.Arguments,
            argumentNames,
            selectedCtor,
            effectiveParamTypes,
            inlineOutArgumentIndices,
            boundArgumentsBuilder
        )
        // ADR-0101 follow-up / issue #812: a constructor's last parameter
        // may be variadic. The arity check accepts any count >= the fixed
        // (non-variadic) parameter count; pack / pass-through happens just
        // below before the per-position conversion loop.
        let ctorIsVariadic = parameters.Length > 0 && parameters[parameters.Length - 1].IsVariadic
        let fixedCtorParamCount = if ctorIsVariadic {
            parameters.Length - 1
        } else {
            parameters.Length
        }
        if ctorIsVariadic && !argumentNames.IsDefault {
            Diagnostics.ReportNamedArgumentParameterNotFound(
                syntax.Identifier.Location,
                classType.Name,
                FirstNamedArgumentName(argumentNames)
            )
            return BoundErrorExpression(syntax)
        }
        // ADR-0063: synthesize defaults for any unsupplied trailing/middle
        // optional parameters. Both arity-with-named-omission and
        // trailing-omission go through this path.
        let requestedArgCount = syntax.Arguments.Count
        if ctorIsVariadic {
            if requestedArgCount < fixedCtorParamCount {
                Diagnostics.ReportTooFewArgumentsForVariadic(
                    syntax.Identifier.Location,
                    classType.Name,
                    fixedCtorParamCount,
                    requestedArgCount
                )
                return BoundErrorExpression(syntax)
            }
        } else if requestedArgCount < parameters.Length {
            var minRequired = parameters.Length
            for var i = parameters.Length - 1; i >= 0; i-- {
                if parameters[i].HasExplicitDefaultValue {
                    minRequired = i
                } else {
                    break
                }
            }
            if requestedArgCount < minRequired {
                Diagnostics.ReportWrongArgumentCount(
                    syntax.Identifier.Location,
                    classType.Name,
                    parameters.Length,
                    requestedArgCount
                )
                return BoundErrorExpression(syntax)
            }
        } else if requestedArgCount > parameters.Length {
            Diagnostics.ReportWrongArgumentCount(
                syntax.Identifier.Location,
                classType.Name,
                parameters.Length,
                requestedArgCount
            )
            return BoundErrorExpression(syntax)
        }
        // Issue #343: reorder into parameter order when the call mixes
        // positional and named arguments. ADR-0063: also slot defaults for
        // unsupplied optional parameters.
        var parameterSyntax[]ExpressionSyntax?
        var boundArguments = boundArgumentsBuilder
        if ctorIsVariadic {
            parameterSyntax = [syntax.Arguments.Count]ExpressionSyntax
            for var i = 0; i < syntax.Arguments.Count; i++ {
                parameterSyntax[i] = syntax.Arguments[i]
            }
            // Pack or pass-through the trailing arguments into a single
            // slice-typed argument so the per-position conversion loop
            // below sees exactly `parameters.Length` arguments.
            let variadicParam = parameters[parameters.Length - 1]
            // Issue #1214: use the (possibly type-argument-substituted) slice
            // type so a generic variadic init (`init(xs ...T)` on `Box[int32]`)
            // packs into `[]int32`, matching the concrete argument types.
            let sliceType = effectiveParamTypes[parameters.Length - 1]
            let trailingCount = requestedArgCount - fixedCtorParamCount
            let passThrough = trailingCount == 1 && boundArguments[fixedCtorParamCount].Type == sliceType
            if !passThrough {
                // Issue #1630: pack the trailing arguments through the
                // canonical helper (applies #1493 element coercion).
                var hasVariadicErrors = false
                let packedArgs = PackOrPassThroughVariadicArguments(
                    conversions,
                    Diagnostics,
                    syntax,
                    boundArguments.ToImmutable(),
                    fixedCtorParamCount,
                    sliceType,
                    variadicParam.Name,
                    (i int32) -> {
                        return Invariant.Required(
                            parameterSyntax[i],
                            "a variadic constructor argument has source syntax",
                            expression: "parameterSyntax[i]"
                        )
                            .Location
                    },
                    &hasVariadicErrors
                )
                if hasVariadicErrors {
                    return BoundErrorExpression(syntax)
                }
                boundArguments = packedArgs.ToBuilder()
                let newSyntax = [parameters.Length]ExpressionSyntax?
                for var i = 0; i < fixedCtorParamCount; i++ {
                    newSyntax[i] = parameterSyntax[i]
                }
                newSyntax[fixedCtorParamCount] = if parameterSyntax.Length > fixedCtorParamCount {
                    parameterSyntax[fixedCtorParamCount]
                } else {
                    default(ExpressionSyntax?)
                }
                parameterSyntax = newSyntax
            }
        } else if !argumentNames.IsDefault || requestedArgCount < parameters.Length {
            if !TryReorderUserCallArgumentsWithDefaults(
                syntax.Arguments,
                boundArguments.ToImmutable(),
                parameters,
                classType.Name,
                syntax.Identifier.Location,
                out parameterSyntax,
                out var permutedBound
            ) {
                return BoundErrorExpression(syntax)
            }
            boundArguments = ImmutableArray.CreateBuilder[BoundExpression](permutedBound.Length)
            for var i = 0; i < permutedBound.Length; i++ {
                boundArguments.Add(permutedBound[i])
            }
        } else {
            parameterSyntax = [syntax.Arguments.Count]ExpressionSyntax
            for var i = 0; i < syntax.Arguments.Count; i++ {
                parameterSyntax[i] = syntax.Arguments[i]
            }
        }
        var hasErrors = false
        let convertedArguments = ImmutableArray.CreateBuilder[BoundExpression](parameters.Length)
        for var i = 0; i < parameters.Length; i++ {
            var argument = boundArguments[i]
            let parameter = parameters[i]
            // Issue #1238: re-bind a deferred target-typed conditional argument
            // against the constructor parameter type before the convertibility
            // checks below.
            boundArguments[i] = (
                argument = FinalizeBranchyArgument(
                    argument,
                    if i < parameterSyntax.Length {
                        parameterSyntax[i]
                    } else {
                        default(ExpressionSyntax?)
                    },
                    effectiveParamTypes[i]
                )
            )
            // Issue #1214: target the type-argument-substituted parameter type
            // for a closed generic construction (equal to parameter.Type for a
            // non-generic/open type).
            let paramType = effectiveParamTypes[i]
            let argumentSyntax = if i < parameterSyntax.Length && parameterSyntax[i] != nil {
                UnwrapNamedArgumentValue(parameterSyntax[i]!!)
            } else {
                default(ExpressionSyntax?)
            }
            if argumentSyntax is RefArgumentExpressionSyntax{IsInlineDeclaration: true} inlineOut {
                if parameter.RefKind != RefKind.Out {
                    Diagnostics.ReportOutDeclarationOutsideOutArgument(inlineOut.Location)
                    hasErrors = true
                    convertedArguments.Add(argument)
                    continue
                }
            }
            // ADR-0055 Tier 4 (#369): re-lower an interpolated-string argument
            // targeting an IFormattable/FormattableString parameter.
            if i < parameterSyntax.Length &&
                parameterSyntax[i] is InterpolatedStringExpressionSyntax interpolatedCtorArg &&
                isFormattableStringTargetType(paramType) {
                let formattable = bindInterpolatedStringAsFormattable(interpolatedCtorArg, paramType)
                // Issue #4400: at an `in` parameter the formattable is a value;
                // pass it by readonly reference.
                convertedArguments.Add(
                    if parameter.RefKind == RefKind.In && !(formattable is BoundErrorExpression) {
                        conversions.CreateImplicitInReference(formattable, paramType)
                    } else {
                        formattable
                    }
                )
                continue
            }
            // ADR-0060: when the constructor parameter is ref-kind, the bound
            // argument is a BoundAddressOfExpression of type *T; bypass the
            // standard convertibility check so the address is forwarded as-is.
            // ADR-0061: BoundConditionalAddressExpression is the analogous
            // shape for conditional ref-arguments.
            let refArgumentLocation = if i < parameterSyntax.Length && parameterSyntax[i] is {} refArgumentSyntax {
                refArgumentSyntax.Location
            } else {
                syntax.Identifier.Location
            }
            if parameter.RefKind != RefKind.None && argument is BoundAddressOfExpression addrCtor {
                let pointee TypeSymbol? = addrCtor.Operand?.Type
                if pointee == TypeSymbol.Error ||
                    paramType == TypeSymbol.Error ||
                    (
                    pointee != nil && conversions.CheckByRefArgumentStorage(
                        refArgumentLocation,
                        parameter,
                        pointee,
                        paramType
                    )
                ) {
                    convertedArguments.Add(argument)
                    continue
                }
                if pointee != nil {
                    conversions.ReportByRefStorageMismatch(refArgumentLocation, parameter.Name, paramType, pointee)
                    hasErrors = true
                    convertedArguments.Add(argument)
                    continue
                }
            } else if parameter.RefKind != RefKind.None && argument is BoundConditionalAddressExpression condAddrCtor {
                let pointee = condAddrCtor.PointeeType
                if pointee == TypeSymbol.Error ||
                    paramType == TypeSymbol.Error ||
                    conversions
                    .CheckByRefArgumentStorage(refArgumentLocation, parameter, pointee, paramType) {
                    convertedArguments.Add(argument)
                    continue
                }
                conversions.ReportByRefStorageMismatch(refArgumentLocation, parameter.Name, paramType, pointee)
                hasErrors = true
                convertedArguments.Add(argument)
                continue
            }
            let argLocation = if i < parameterSyntax.Length && parameterSyntax[i] != nil {
                Invariant.Required(
                    parameterSyntax[i],
                    "an explicit constructor argument has source syntax",
                    expression: "parameterSyntax[i]"
                )
                    .Location
            } else {
                syntax.Identifier.Location
            }
            let isImplicitIn = parameter.RefKind == RefKind.In &&
                !(argument is BoundAddressOfExpression) &&
                !(argument is BoundConditionalAddressExpression)
            if argument is BoundErrorExpression{Syntax: LambdaExpressionSyntax deferredLambda} &&
                bindLambdaWithTarget != nil &&
                MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(paramType, out var deferredTarget) &&
                !TypeSymbol
                .ContainsTypeParameter(deferredTarget!!) {
                let targeted = bindLambdaWithTarget!!(deferredLambda, deferredTarget!!)
                let targetedArgument = if isImplicitIn {
                    conversions.BindImplicitInArgument(argLocation, targeted, paramType, parameter)
                } else {
                    conversions.BindConversion(argLocation, targeted, paramType)
                }
                hasErrors |= isImplicitIn && targetedArgument is BoundErrorExpression
                convertedArguments.Add(targetedArgument)
                continue
            }
            // Issue #4400: a plain argument at an `in` constructor parameter is
            // passed by readonly reference, as in C# (a deferred lambda was
            // target-bound first, just above).
            if isImplicitIn {
                let implicitIn = conversions.BindImplicitInArgument(argLocation, argument, paramType, parameter)
                hasErrors |= implicitIn is BoundErrorExpression
                convertedArguments.Add(implicitIn)
                continue
            }
            if TryBindConstructorMethodGroup(argument, paramType, argLocation, out var methodGroupArg) {
                convertedArguments.Add(
                    Invariant.Required(
                        methodGroupArg,
                        "a successful constructor method-group binding produces a bound expression",
                        expression: "methodGroupArg"
                    )
                )
                hasErrors |= methodGroupArg is BoundErrorExpression
                continue
            }
            // Issue #2069: force the wrap for a func/arrow literal argument
            // flowing into a NAMED delegate parameter — see the matching
            // comment above (constructor-argument path) for the full
            // rationale. Without it, the general implicit-conversion fast
            // path below leaves the literal unwrapped and it materialises
            // against its natural Action/Func shape instead of the named
            // delegate's own TypeDef.
            if paramType is DelegateTypeSymbol namedDelegateParamTarget &&
                argument.Type is FunctionTypeSymbol &&
                !object
                .ReferenceEquals(argument.Type, namedDelegateParamTarget) {
                convertedArguments.Add(conversions.BindConversion(argLocation, argument, paramType))
                continue
            }
            // Issue #3907: an `@AllowNull` parameter declares that it accepts a
            // nil-carrying input, so the `T?` argument is forwarded as-is.
            if ConversionClassifier.AcceptsNilAnnotatedArgument(parameter, argument.Type, paramType) {
                convertedArguments.Add(argument)
                continue
            }
            if argument.Type != paramType && !conversions.ClassifyArgumentConversion(argument.Type, paramType)
                .IsImplicit {
                if TryConvertLiteralArgumentToExpressionTree(
                    argument,
                    paramType,
                    argLocation,
                    out var expressionTreeArg
                ) {
                    convertedArguments.Add(
                        Invariant.Required(
                            expressionTreeArg,
                            "a successful expression-tree argument conversion produces a bound expression",
                            expression: "expressionTreeArg"
                        )
                    )
                    continue
                }
                // Issues #889/#3465: contextually bind lambda/delegate arguments.
                if parameter.RefKind == RefKind.None &&
                    TryConvertLambdaArgumentWithTarget(
                    argument,
                    paramType,
                    argLocation,
                    out var targetTypedLambda,
                    parameter: parameter
                ) {
                    convertedArguments.Add(
                        Invariant.Required(
                            targetTypedLambda,
                            "a successful target-typed lambda conversion produces a bound expression",
                            expression: "targetTypedLambda"
                        )
                    )
                    continue
                }
                // Issue #1281: implicit constant-expression narrowing argument.
                if TryBindConstantNarrowingArgument(argument, paramType, argLocation, out var narrowedArg) {
                    convertedArguments.Add(
                        Invariant.Required(
                            narrowedArg,
                            "a successful constant narrowing conversion produces a bound expression",
                            expression: "narrowedArg"
                        )
                    )
                    continue
                }
                if conversions.TryApplyUserDefinedImplicitArgumentConversion(
                    argument,
                    paramType,
                    out var convertedArg
                ) {
                    convertedArguments.Add(convertedArg)
                    continue
                }
                if argument.Type != TypeSymbol.Error {
                    Diagnostics.ReportWrongArgumentType(argLocation, parameter.Name, paramType, argument.Type)
                }
                hasErrors = true
                convertedArguments.Add(argument)
            } else {
                convertedArguments.Add(conversions.BindConversion(argLocation, argument, paramType))
            }
        }
        if hasErrors {
            return BoundErrorExpression(syntax)
        }
        // Issue #2067: enforce `protected`/`private` on an explicit `init(...)`
        // constructor the same way BindUserInstanceCall enforces it on regular
        // method calls (issue #2058) — a separate binder path resolves
        // constructor calls, so it needs its own accessibility gate.
        if selectedCtor.DeclaringType is StructSymbol ctorDeclaringType && !AccessibilityChecker.IsAccessible(
            selectedCtor.Function.Accessibility,
            ctorDeclaringType,
            getCurrentFunction()
        ) {
            Diagnostics.ReportMemberInaccessible(
                syntax.Identifier.Location,
                "init",
                ctorDeclaringType.Name,
                selectedCtor.Function.Accessibility
            )
        }
        let finalArguments = PreserveNamedArgumentEvaluationOrder(
            syntax.Arguments,
            convertedArguments.ToImmutable(),
            parameterNameAt
        )
        return BoundConstructorCallExpression(syntax, classType, finalArguments, selectedCtor)
    }

    private func DeclareInvalidInlineOutLocals(
        arguments GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
        inlineOutArgumentIndices ImmutableArray[int32]
    ) {
        if inlineOutArgumentIndices.IsDefaultOrEmpty {
            return
        }
        let errorOutParameter = ParameterSymbol("value", TypeSymbol.Error, refKind: RefKind.Out)
        for argumentIndex in inlineOutArgumentIndices {
            let inlineOut = cast[RefArgumentExpressionSyntax](UnwrapNamedArgumentValue(arguments[argumentIndex]))
            let _ = bindRefArgumentExpression(inlineOut, errorOutParameter)
        }
    }

    private func DeclareUnresolvedInlineOutLocals(
        arguments GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
        inlineOutArgumentIndices ImmutableArray[int32]
    ) {
        if inlineOutArgumentIndices.IsDefaultOrEmpty {
            return
        }
        let errorOutParameter = ParameterSymbol("value", TypeSymbol.Error, refKind: RefKind.Out)
        for argumentIndex in inlineOutArgumentIndices {
            let inlineOut = cast[RefArgumentExpressionSyntax](UnwrapNamedArgumentValue(arguments[argumentIndex]))
            if inlineOut.IsDiscard {
                continue
            }
            let _ = bindRefArgumentExpression(inlineOut, errorOutParameter)
        }
    }

    private func DeclareUnresolvedInlineOutLocals(
        arguments GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
        inlineOutArgumentIndices ImmutableArray[int32],
        boundArguments ImmutableArray[BoundExpression].Builder
    ) {
        if inlineOutArgumentIndices.IsDefaultOrEmpty {
            return
        }
        let errorOutParameter = ParameterSymbol("value", TypeSymbol.Error, refKind: RefKind.Out)
        for argumentIndex in inlineOutArgumentIndices {
            let inlineOut = cast[RefArgumentExpressionSyntax](UnwrapNamedArgumentValue(arguments[argumentIndex]))
            if inlineOut.IsDiscard ||
                inlineOut.DeclaredType != nil ||
                !(boundArguments[argumentIndex] is BoundAddressOfExpression{Operand: {Type: var argumentType}}) ||
                argumentType != TypeSymbol.Error {
                continue
            }
            boundArguments[argumentIndex] = bindRefArgumentExpression(inlineOut, errorOutParameter)
        }
    }

    private func RebindSelectedConstructorInlineOutArguments(
        arguments GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
        argumentNames ImmutableArray[string],
        constructor ConstructorSymbol,
        parameterTypes ImmutableArray[TypeSymbol],
        inlineOutArgumentIndices ImmutableArray[int32],
        boundArguments ImmutableArray[BoundExpression].Builder
    ) {
        if inlineOutArgumentIndices.IsDefaultOrEmpty {
            return
        }
        for argumentIndex in inlineOutArgumentIndices {
            let inlineOut = cast[RefArgumentExpressionSyntax](UnwrapNamedArgumentValue(arguments[argumentIndex]))
            if !(boundArguments[argumentIndex] is BoundAddressOfExpression{Operand: {Type: var argumentType}}) ||
                argumentType != TypeSymbol.Error ||
                inlineOut.DeclaredType != nil {
                continue
            }
            let name string? = if argumentNames.IsDefault {
                default(string?)
            } else {
                argumentNames[argumentIndex]
            }
            let parameterIndex = if name == nil {
                argumentIndex
            } else {
                FindParameterIndex(constructor.Parameters, name)
            }
            if parameterIndex < 0 || parameterIndex >= parameterTypes.Length {
                continue
            }
            let parameter = constructor.Parameters[parameterIndex]
            let reboundParameter = ParameterSymbol(parameter, parameterTypes[parameterIndex])
            boundArguments[argumentIndex] = bindRefArgumentExpression(inlineOut, reboundParameter)
        }
    }

    /// Issue #1214: closes a generic class that declares an explicit
    /// `init(...)` constructor for a construction call `Box[int32](args)`.
    /// Resolves the type arguments — taken from an explicit `[…]` list or
    /// inferred from the value arguments against the constructor's parameter
    /// list (first-seen-wins, mirroring the primary-constructor path in
    /// (cref:BindConstructorCallExpression)) — validates the arity and
    /// constraints, then yields the constructed closed (cref:StructSymbol).
    /// Returns `false` after reporting a diagnostic when the type
    /// arguments cannot be resolved.
    private func TryCloseGenericExplicitConstructorType(
        syntax CallExpressionSyntax,
        classType StructSymbol,
        argumentNames ImmutableArray[string],
        inlineOutArgumentIndices ImmutableArray[int32],
        out constructed StructSymbol
    ) bool {
        constructed = classType
        if !classType.IsGenericDefinition {
            // A type-argument list on a non-generic class is a usage error.
            if syntax.TypeArgumentList != nil {
                Diagnostics.ReportWrongTypeArgumentCount(
                    syntax.TypeArgumentList.Location,
                    classType.Name,
                    0,
                    syntax.TypeArgumentList.Arguments.Count
                )
                return false
            }
            return true
        }
        let tps = classType.TypeParameters
        var substitution = Dictionary[TypeParameterSymbol, TypeSymbol]()
        if syntax.TypeArgumentList != nil {
            let explicitArgs = syntax.TypeArgumentList.Arguments
            if explicitArgs.Count != tps.Length {
                Diagnostics.ReportWrongTypeArgumentCount(
                    syntax.TypeArgumentList.Location,
                    classType.Name,
                    tps.Length,
                    explicitArgs.Count
                )
                return false
            }
            for var i = 0; i < explicitArgs.Count; i++ {
                let ta TypeSymbol? = bindTypeClause(explicitArgs[i])
                if ta == nil {
                    return false
                }
                substitution[tps[i]] = ta
            }
        } else {
            // Issue #1629: this is a throwaway probe — BindExplicitConstructorCallExpression
            // re-binds the same argument syntax for real once the closed type is
            // known. Roll back any diagnostics the probe produced so they are
            // reported exactly once, by the real bind.
            let inferenceDiagMark = Diagnostics.Count
            let inferenceArgumentTypes = [syntax.Arguments.Count]TypeSymbol?
            let inferenceBoundArguments = ImmutableArray.CreateBuilder[BoundExpression](syntax.Arguments.Count)
            for var i = 0; i < syntax.Arguments.Count; i++ {
                let argument = UnwrapNamedArgumentValue(syntax.Arguments[i])
                if argument is RefArgumentExpressionSyntax && argument.IsInlineDeclaration == true {
                    inferenceArgumentTypes[i] = BindExplicitConstructorInferenceArgument(argument)
                    inferenceBoundArguments.Add(BoundErrorExpression(argument))
                    continue
                }
                let boundArgument = bindExpression(argument)
                inferenceArgumentTypes[i] = boundArgument.Type
                inferenceBoundArguments.Add(boundArgument)
            }
            let candidates = List[(Function FunctionSymbol, Substitution Dictionary[TypeParameterSymbol, TypeSymbol])]()
            var inferredCandidateCount = 0
            var unresolvedTypeParameter TypeParameterSymbol? = nil
            var constraintFailureSubstitution Dictionary[TypeParameterSymbol, TypeSymbol]? = nil
            let inferenceConstructors = GetAccessibleExplicitConstructorsOrAll(classType)
            for constructor in inferenceConstructors {
                if !ConstructorAcceptsInlineOutArguments(constructor, argumentNames, inlineOutArgumentIndices) {
                    continue
                }
                let candidateSubstitution = Dictionary[TypeParameterSymbol, TypeSymbol]()
                InferExplicitConstructorTypeArguments(
                    syntax,
                    constructor,
                    argumentNames,
                    inferenceArgumentTypes,
                    candidateSubstitution
                )
                let candidateUnresolvedTypeParameter TypeParameterSymbol? = tps.FirstOrDefault(
                    (tp TypeParameterSymbol) -> !candidateSubstitution.TryGetValue(tp, out var inferredType) ||
                        inferredType == TypeSymbol.Error
                )
                if candidateUnresolvedTypeParameter != nil {
                    if IsPartiallyApplicableExplicitConstructor(
                        syntax,
                        constructor,
                        argumentNames,
                        inferenceArgumentTypes,
                        candidateSubstitution
                    ) {
                        unresolvedTypeParameter ??= candidateUnresolvedTypeParameter
                    }
                    continue
                }
                inferredCandidateCount++
                if !tps.All(
                    (tp TypeParameterSymbol) -> satisfiesConstraint(
                        candidateSubstitution[tp],
                        tp,
                        candidateSubstitution
                    )
                ) {
                    constraintFailureSubstitution ??= candidateSubstitution
                    continue
                }
                let candidateType = ConstructExplicitConstructorType(classType, tps, candidateSubstitution)
                let candidateFunction = CreateConstructedConstructorCandidate(constructor, candidateType)
                if !IsApplicableUserCallable(candidateFunction, syntax.Arguments.Count, argumentNames) ||
                    !IsConvertibilityApplicable(
                    candidateFunction,
                    syntax.Arguments.Count,
                    argumentNames,
                    inferenceBoundArguments
                ) ||
                    !ConstructorAcceptsTypedInlineOutArguments(
                    syntax,
                    candidateFunction,
                    argumentNames,
                    inlineOutArgumentIndices,
                    inferenceArgumentTypes
                ) {
                    continue
                }
                candidates.Add((candidateFunction, candidateSubstitution))
            }
            Diagnostics.TruncateTo(inferenceDiagMark)
            if candidates.Count == 0 {
                if constraintFailureSubstitution != nil {
                    substitution = constraintFailureSubstitution
                } else {
                    if inferredCandidateCount == 0 {
                        let hasFailedExplicitInlineOutType = !inlineOutArgumentIndices.IsDefaultOrEmpty &&
                            inlineOutArgumentIndices
                            .Any(
                            (index int32) -> (
                                cast[RefArgumentExpressionSyntax](UnwrapNamedArgumentValue(syntax.Arguments[index]))
                            ).DeclaredType != nil &&
                                inferenceArgumentTypes[index] == TypeSymbol.Error
                        )
                        if !hasFailedExplicitInlineOutType {
                            Diagnostics.ReportTypeArgumentInferenceFailed(
                                syntax.Identifier.Location,
                                classType.Name,
                                (unresolvedTypeParameter ?? tps[0]).Name
                            )
                        }
                    } else {
                        Diagnostics.ReportNoApplicableOverload(syntax.Identifier.Location, classType.Name)
                    }
                    return false
                }
            } else if candidates.Count == 1 {
                substitution = candidates[0].Substitution
            } else if candidates.Skip(1).All(
                (candidate(Function FunctionSymbol, Substitution Dictionary[TypeParameterSymbol, TypeSymbol])) -> tps
                    .All(
                    (tp TypeParameterSymbol) -> DeclarationBinder.TypeSignaturesEquivalent(
                        candidate.Substitution[tp],
                        candidates[0].Substitution[tp]
                    )
                )
            ) {
                substitution = candidates[0].Substitution
            } else {
                let selected FunctionSymbol? = SelectBestInstanceOverload(
                    candidates.Select(
                        (
                            candidate(Function FunctionSymbol, Substitution Dictionary[TypeParameterSymbol, TypeSymbol])
                        ) -> candidate.Function
                    )
                        .ToImmutableArray(),
                    syntax.Arguments.Count,
                    argumentNames,
                    inferenceBoundArguments.ToImmutable(),
                    out var ambiguous,
                    out _
                )
                if selected == nil {
                    if ambiguous {
                        Diagnostics.ReportAmbiguousOverloadResolution(syntax.Identifier.Location, classType.Name)
                    } else {
                        Diagnostics.ReportNoApplicableOverload(syntax.Identifier.Location, classType.Name)
                    }
                    return false
                }
                substitution = candidates.First(
                    (
                        candidate(Function FunctionSymbol, Substitution Dictionary[TypeParameterSymbol, TypeSymbol])
                    ) -> object.ReferenceEquals(candidate.Function, selected)
                )
                    .Substitution
            }
        }
        let constraintLocation = if syntax.TypeArgumentList != nil {
            syntax.TypeArgumentList.Location
        } else {
            syntax.Identifier.Location
        }
        for tp in tps {
            let typeArg = substitution[tp]
            if !satisfiesConstraint(typeArg, tp, substitution) {
                Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(
                    constraintLocation,
                    tp.Name,
                    typeArg,
                    describeConstraint(tp)
                )
                return false
            }
        }
        constructed = ConstructExplicitConstructorType(classType, tps, substitution)
        return true
    }

    private func InferExplicitConstructorTypeArguments(
        syntax CallExpressionSyntax,
        constructor ConstructorSymbol,
        argumentNames ImmutableArray[string],
        argumentTypes IReadOnlyList[TypeSymbol?],
        substitution Dictionary[TypeParameterSymbol, TypeSymbol]
    ) {
        let parameters = constructor.Parameters
        let isVariadic = parameters.Length > 0 && parameters[parameters.Length - 1].IsVariadic
        let fixedParameterCount = if isVariadic {
            parameters.Length - 1
        } else {
            parameters.Length
        }
        var variadicArgumentIndices List[int32]? = nil
        for var i = 0; i < syntax.Arguments.Count; i++ {
            let parameterIndex = if argumentNames.IsDefault || argumentNames[i] == nil {
                (
                    if isVariadic && i >= fixedParameterCount {
                        parameters.Length - 1
                    } else {
                        i
                    }
                )
            } else {
                FindParameterIndex(parameters, argumentNames[i])
            }
            if parameterIndex < 0 || parameterIndex >= parameters.Length {
                continue
            }
            if isVariadic && parameterIndex == parameters.Length - 1 {
                variadicArgumentIndices ??= List[int32]()
                variadicArgumentIndices!!.Add(i)
                continue
            }
            if argumentTypes[i] is {} argumentType {
                inferTypeArguments(parameters[parameterIndex].Type, argumentType, substitution)
            }
        }
        if !isVariadic ||
            !(variadicArgumentIndices != nil && variadicArgumentIndices.Count > 0) ||
            parameters[parameters.Length - 1].Type is not SliceTypeSymbol variadicSlice {
            return
        }
        if variadicArgumentIndices.Count == 1 {
            let argumentType TypeSymbol? = argumentTypes[variadicArgumentIndices[0]]
            if argumentType is SliceTypeSymbol {
                inferTypeArguments(variadicSlice, argumentType, substitution)
            } else if argumentType != nil {
                inferTypeArguments(variadicSlice.ElementType, argumentType, substitution)
            }
            return
        }
        for argumentIndex in variadicArgumentIndices {
            if argumentTypes[argumentIndex] is {} argumentType {
                inferTypeArguments(variadicSlice.ElementType, argumentType, substitution)
            }
        }
    }

    private func ConstructExplicitConstructorType(
        definition StructSymbol,
        typeParameters ImmutableArray[TypeParameterSymbol],
        substitution Dictionary[TypeParameterSymbol, TypeSymbol]
    ) StructSymbol {
        let typeArguments = ImmutableArray.CreateBuilder[TypeSymbol](typeParameters.Length)
        for typeParameter in typeParameters {
            typeArguments.Add(substitution[typeParameter])
        }
        return if MapClrType is {} mapClrType {
            StructSymbol.Construct(definition, typeArguments.MoveToImmutable(), mapClrType)!!
        } else {
            StructSymbol.Construct(definition, typeArguments.MoveToImmutable())!!
        }
    }

    private func BindExplicitConstructorInferenceArgument(argument ExpressionSyntax) TypeSymbol? {
        if argument is RefArgumentExpressionSyntax{IsInlineDeclaration: true} inlineOut {
            return if inlineOut.DeclaredType == nil {
                default(TypeSymbol?)
            } else {
                bindTypeClause(inlineOut.DeclaredType) ?? TypeSymbol.Error
            }
        }
        return bindExpression(argument).Type
    }

    private func GetAccessibleExplicitConstructorsOrAll(classType StructSymbol) ImmutableArray[ConstructorSymbol] {
        let constructors = classType.EffectiveExplicitConstructors
        let accessibleConstructors = constructors.Where(
            (constructor ConstructorSymbol) -> AccessibilityChecker.IsAccessible(
                constructor.Function.Accessibility,
                constructor.DeclaringType ?? classType,
                getCurrentFunction()
            )
        )
            .ToImmutableArray()
        return if accessibleConstructors.IsDefaultOrEmpty {
            constructors
        } else {
            accessibleConstructors
        }
    }

    private func IsPartiallyApplicableExplicitConstructor(
        syntax CallExpressionSyntax,
        constructor ConstructorSymbol,
        argumentNames ImmutableArray[string],
        argumentTypes IReadOnlyList[TypeSymbol?],
        substitution Dictionary[TypeParameterSymbol, TypeSymbol]
    ) bool {
        if !IsApplicableUserCallable(constructor.Function, syntax.Arguments.Count, argumentNames) {
            return false
        }
        let parameters = constructor.Parameters
        let isVariadic = parameters.Length > 0 && parameters[parameters.Length - 1].IsVariadic
        let fixedParameterCount = if isVariadic {
            parameters.Length - 1
        } else {
            parameters.Length
        }
        let variadicArgumentCount = if isVariadic {
            syntax.Arguments.Count - fixedParameterCount
        } else {
            0
        }
        for var argumentIndex = 0; argumentIndex < syntax.Arguments.Count; argumentIndex++ {
            let parameterIndex = if argumentNames.IsDefault || argumentNames[argumentIndex] == nil {
                (
                    if isVariadic && argumentIndex >= fixedParameterCount {
                        parameters.Length - 1
                    } else {
                        argumentIndex
                    }
                )
            } else {
                FindParameterIndex(parameters, argumentNames[argumentIndex])
            }
            if parameterIndex < 0 || parameterIndex >= parameters.Length {
                return false
            }
            let argumentType TypeSymbol? = argumentTypes[argumentIndex]
            if argumentType == nil || argumentType == TypeSymbol.Error {
                continue
            }
            let parameter = parameters[parameterIndex]
            var parameterType = GSharp.Core.CodeAnalysis.Binding.Binder.SubstituteType(parameter.Type, substitution)
            if isVariadic &&
                parameterIndex == parameters.Length - 1 &&
                parameterType is SliceTypeSymbol variadicSlice &&
                (variadicArgumentCount != 1 || !(argumentType is SliceTypeSymbol)) {
                parameterType = variadicSlice.ElementType
            }
            if TypeSymbol.ContainsTypeParameter(parameterType) {
                continue
            }
            let isCompatible = if parameter.RefKind == RefKind.None {
                conversions.ClassifyArgumentConversion(argumentType, parameterType).IsImplicit
            } else {
                ByRefStorageMatching.AreSameStorageType(argumentType, parameterType, out _, out _, out _)
            }
            if !isCompatible {
                return false
            }
        }
        return true
    }

    /// ADR-0065 §2: binds a bare `init(args)` self-delegation call inside a
    /// constructor body. The selected sibling constructor must be a different
    /// member of the same aggregate's (cref:StructSymbol.ExplicitConstructors)
    /// overload set. Designated initializers may not chain to a sibling; only
    /// `convenience init` bodies may issue an `init(args)` self-delegation.
    private func BindConstructorChainingExpression(
        syntax CallExpressionSyntax,
        owningClass StructSymbol,
        currentCtorFunction FunctionSymbol
    ) BoundExpression {
        using let initializerContext = binderCtx.PushConstructorInitializerContext()
        // Resolve the current ConstructorSymbol so we know whether the caller
        // is convenience or designated, and so we can exclude it from the
        // candidate set (recursion would loop indefinitely).
        var currentCtor ConstructorSymbol? = nil
        for c in owningClass.ExplicitConstructors {
            if object.ReferenceEquals(c.Function, currentCtorFunction) {
                currentCtor = c
                break
            }
        }
        if currentCtor == nil {
            Diagnostics.ReportInitDelegationOutsideCtor(syntax.Identifier.Location)
            return BoundErrorExpression(syntax)
        }
        if !currentCtor.IsConvenience {
            Diagnostics.ReportInitDelegationFromDesignated(syntax.Identifier.Location, owningClass.Name)
            return BoundErrorExpression(syntax)
        }
        // Build the candidate overload set: every sibling explicit constructor
        // except the one currently being bound.
        let siblingBuilder = ImmutableArray.CreateBuilder[ConstructorSymbol](owningClass.ExplicitConstructors.Length)
        for c in owningClass.ExplicitConstructors {
            if object.ReferenceEquals(c, currentCtor) {
                continue
            }
            siblingBuilder.Add(c)
        }
        if siblingBuilder.Count == 0 {
            Diagnostics.ReportInitDelegationRecursive(syntax.Identifier.Location, owningClass.Name)
            return BoundErrorExpression(syntax)
        }
        if !TryAnalyzeCallArgumentLayout(syntax.Arguments, out _, out var argumentNames) {
            return BoundErrorExpression(syntax)
        }
        let boundArgsBuilder = ImmutableArray.CreateBuilder[BoundExpression](syntax.Arguments.Count)
        let savedInitializerContext = currentCtorFunction.IsExpressionInitializer
        currentCtorFunction.IsExpressionInitializer = true
        try {
            for var i = 0; i < syntax.Arguments.Count; i++ {
                let argument = UnwrapNamedArgumentValue(syntax.Arguments[i])
                var parameterForArg ParameterSymbol? = nil
                if siblingBuilder.Count == 1 && i < siblingBuilder[0].Parameters.Length {
                    parameterForArg = siblingBuilder[0].Parameters[i]
                }
                if argument is RefArgumentExpressionSyntax refArg {
                    // The callback uses null to mean that overload resolution has
                    // not identified the ref parameter yet; its legacy non-null
                    // annotation predates that two-pass binding contract.
                    boundArgsBuilder.Add(bindRefArgumentExpression(refArg, parameterForArg!!))
                } else {
                    boundArgsBuilder.Add(BindOverloadArgumentValue(argument))
                }
            }
        } finally {
            currentCtorFunction.IsExpressionInitializer = savedInitializerContext
        }
        var selectedCtor ConstructorSymbol?
        if siblingBuilder.Count == 1 {
            selectedCtor = siblingBuilder[0]
        } else {
            let ctorFunctions = ImmutableArray.CreateBuilder[FunctionSymbol](siblingBuilder.Count)
            for c in siblingBuilder {
                ctorFunctions.Add(c.Function)
            }
            let selectedFn FunctionSymbol? = SelectBestInstanceOverload(
                ctorFunctions.MoveToImmutable(),
                syntax.Arguments.Count,
                argumentNames,
                boundArgsBuilder.ToImmutable(),
                out var ambiguous,
                out var nullSafetyFailure
            )
            if selectedFn == nil {
                if nullSafetyFailure != nil {
                    let argLoc = if nullSafetyFailure.Index < syntax.Arguments.Count {
                        syntax.Arguments[nullSafetyFailure.Index].Location
                    } else {
                        syntax.Identifier.Location
                    }
                    Diagnostics.ReportWrongArgumentType(
                        argLoc,
                        nullSafetyFailure.ParamName,
                        nullSafetyFailure.ParamType,
                        nullSafetyFailure.ArgType
                    )
                } else if ambiguous {
                    Diagnostics.ReportAmbiguousOverloadResolution(syntax.Identifier.Location, "init")
                } else {
                    Diagnostics.ReportInitDelegationNoMatch(syntax.Identifier.Location, owningClass.Name)
                }
                return BoundErrorExpression(syntax)
            }
            selectedCtor = nil
            for c in siblingBuilder {
                if object.ReferenceEquals(c.Function, selectedFn) {
                    selectedCtor = c
                    break
                }
            }
            if selectedCtor == nil {
                Diagnostics.ReportInitDelegationNoMatch(syntax.Identifier.Location, owningClass.Name)
                return BoundErrorExpression(syntax)
            }
        }
        selectedCtor = Invariant.Required(
            selectedCtor,
            "an applicable constructor-chain overload has a selected constructor symbol",
            expression: "selectedCtor"
        )
        let parameters = selectedCtor.Parameters
        let requestedArgCount = syntax.Arguments.Count
        if requestedArgCount < parameters.Length {
            var minRequired = parameters.Length
            for var i = parameters.Length - 1; i >= 0; i-- {
                if parameters[i].HasExplicitDefaultValue {
                    minRequired = i
                } else {
                    break
                }
            }
            if requestedArgCount < minRequired {
                Diagnostics.ReportWrongArgumentCount(
                    syntax.Identifier.Location,
                    "init",
                    parameters.Length,
                    requestedArgCount
                )
                return BoundErrorExpression(syntax)
            }
        } else if requestedArgCount > parameters.Length {
            Diagnostics.ReportWrongArgumentCount(
                syntax.Identifier.Location,
                "init",
                parameters.Length,
                requestedArgCount
            )
            return BoundErrorExpression(syntax)
        }
        var parameterSyntax[]ExpressionSyntax?
        var boundArgs = boundArgsBuilder
        if !argumentNames.IsDefault || requestedArgCount < parameters.Length {
            if !TryReorderUserCallArgumentsWithDefaults(
                syntax.Arguments,
                boundArgs.ToImmutable(),
                parameters,
                "init",
                syntax.Identifier.Location,
                out parameterSyntax,
                out var permutedBound
            ) {
                return BoundErrorExpression(syntax)
            }
            boundArgs = ImmutableArray.CreateBuilder[BoundExpression](permutedBound.Length)
            for var i = 0; i < permutedBound.Length; i++ {
                boundArgs.Add(permutedBound[i])
            }
        } else {
            parameterSyntax = [syntax.Arguments.Count]ExpressionSyntax
            for var i = 0; i < syntax.Arguments.Count; i++ {
                parameterSyntax[i] = syntax.Arguments[i]
            }
        }
        let convertedArgs = ImmutableArray.CreateBuilder[BoundExpression](parameters.Length)
        var hadErrors = false
        for var i = 0; i < parameters.Length; i++ {
            let parameter = parameters[i]
            var argument = boundArgs[i]
            let argLocation = parameterSyntax[i]?.Location ?? syntax.Identifier.Location
            // Issue #1238: re-bind a deferred target-typed conditional argument
            // against the constructor parameter type before the error/convert
            // checks below.
            argument = FinalizeBranchyArgument(
                argument,
                if i < parameterSyntax.Length {
                    parameterSyntax[i]
                } else {
                    default(ExpressionSyntax?)
                },
                parameter.Type
            )
            if TryBindConstructorMethodGroup(argument, parameter.Type, argLocation, out var methodGroupArg) {
                let boundGroup = Invariant.Required(
                    methodGroupArg,
                    "a successful constructor method-group binding produces a bound expression",
                    expression: "methodGroupArg"
                )
                // Issue #4400: a method group at an `in` delegate parameter is
                // a delegate VALUE; pass it by readonly reference.
                convertedArgs.Add(
                    if parameter.RefKind == RefKind.In && !(boundGroup is BoundErrorExpression) {
                        conversions.CreateImplicitInReference(boundGroup, parameter.Type)
                    } else {
                        boundGroup
                    }
                )
                hadErrors |= methodGroupArg is BoundErrorExpression
                continue
            }
            if argument.Type == TypeSymbol.Error {
                hadErrors = true
                convertedArgs.Add(argument)
                continue
            }
            // ADR-0060: when the parameter is ref-kind, the bound argument is
            // a BoundAddressOfExpression of type *T; bypass the standard
            // convertibility check so the address is forwarded as-is.
            if parameter.RefKind != RefKind.None && argument is BoundAddressOfExpression addrInit {
                let pointee TypeSymbol? = addrInit.Operand?.Type
                if pointee == TypeSymbol.Error ||
                    parameter.Type == TypeSymbol.Error ||
                    (
                    pointee != nil && conversions.CheckByRefArgumentStorage(
                        argLocation,
                        parameter,
                        pointee,
                        parameter.Type
                    )
                ) {
                    convertedArgs.Add(argument)
                    continue
                }
                if pointee != nil {
                    conversions.ReportByRefStorageMismatch(argLocation, parameter.Name, parameter.Type, pointee)
                    hadErrors = true
                    convertedArgs.Add(argument)
                    continue
                }
            } else if parameter.RefKind != RefKind.None && argument is BoundConditionalAddressExpression condAddrInit {
                let pointee = condAddrInit.PointeeType
                if pointee == TypeSymbol.Error ||
                    parameter.Type == TypeSymbol.Error ||
                    conversions.CheckByRefArgumentStorage(argLocation, parameter, pointee, parameter.Type) {
                    convertedArgs.Add(argument)
                    continue
                }
                conversions.ReportByRefStorageMismatch(argLocation, parameter.Name, parameter.Type, pointee)
                hadErrors = true
                convertedArgs.Add(argument)
                continue
            } else if parameter.RefKind == RefKind.In {
                // Issue #4400: a plain argument at an `in` parameter of the
                // chained constructor is passed by readonly reference.
                let implicitIn = conversions.BindImplicitInArgument(argLocation, argument, parameter.Type, parameter)
                hadErrors |= implicitIn is BoundErrorExpression
                convertedArgs.Add(implicitIn)
                continue
            }
            // Issue #2069: force the wrap for a func/arrow literal argument
            // flowing into a NAMED delegate parameter — see the matching
            // comment at the constructor-argument path (above in this file)
            // for the full rationale.
            if parameter.Type is DelegateTypeSymbol namedDelegateInitTarget &&
                argument.Type is FunctionTypeSymbol &&
                !object
                .ReferenceEquals(argument.Type, namedDelegateInitTarget) {
                convertedArgs.Add(conversions.BindConversion(argLocation, argument, parameter.Type))
                continue
            }
            // Issue #3907: an `@AllowNull` parameter declares that it accepts a
            // nil-carrying input, so the `T?` argument is forwarded as-is.
            if ConversionClassifier.AcceptsNilAnnotatedArgument(parameter, argument.Type, parameter.Type) {
                convertedArgs.Add(argument)
                continue
            }
            if argument.Type != parameter.Type && !conversions.ClassifyArgumentConversion(argument.Type, parameter.Type)
                .IsImplicit {
                if TryConvertLiteralArgumentToExpressionTree(
                    argument,
                    parameter.Type,
                    argLocation,
                    out var expressionTreeArg
                ) {
                    convertedArgs.Add(
                        Invariant.Required(
                            expressionTreeArg,
                            "a successful expression-tree argument conversion produces a bound expression",
                            expression: "expressionTreeArg"
                        )
                    )
                    continue
                }
                // Issues #889/#3465: contextually bind lambda/delegate arguments.
                if parameter.RefKind == RefKind.None &&
                    TryConvertLambdaArgumentWithTarget(
                    argument,
                    parameter.Type,
                    argLocation,
                    out var targetTypedLambda,
                    parameter: parameter
                ) {
                    convertedArgs.Add(
                        Invariant.Required(
                            targetTypedLambda,
                            "a successful target-typed lambda conversion produces a bound expression",
                            expression: "targetTypedLambda"
                        )
                    )
                    continue
                }
                // Issue #1281: implicit constant-expression narrowing argument.
                if TryBindConstantNarrowingArgument(argument, parameter.Type, argLocation, out var narrowedArg) {
                    convertedArgs.Add(
                        Invariant.Required(
                            narrowedArg,
                            "a successful constant narrowing conversion produces a bound expression",
                            expression: "narrowedArg"
                        )
                    )
                    continue
                }
                if conversions.TryApplyUserDefinedImplicitArgumentConversion(
                    argument,
                    parameter.Type,
                    out var convertedArg
                ) {
                    convertedArgs.Add(convertedArg)
                    continue
                }
                if argument.Type != TypeSymbol.Error {
                    Diagnostics.ReportWrongArgumentType(argLocation, parameter.Name, parameter.Type, argument.Type)
                }
                hadErrors = true
                convertedArgs.Add(argument)
            } else {
                convertedArgs.Add(conversions.BindConversion(argLocation, argument, parameter.Type))
            }
        }
        if hadErrors {
            return BoundErrorExpression(syntax)
        }
        return BoundConstructorChainingExpression(syntax, selectedCtor, convertedArgs.ToImmutable())
    }

    private func TryBindConstructorMethodGroup(
        argument BoundExpression,
        targetType TypeSymbol,
        location TextLocation,
        out converted BoundExpression?
    ) bool {
        if ClrOverloadResolution.IsUnresolvedMethodGroupArgument(argument) {
            converted = conversions.BindConversion(location, argument, targetType)
            return true
        }
        converted = nil
        return false
    }

    /// ADR-0063 §9: variant of `TryReorderUserCallArguments` for constructor
    /// calls that may omit trailing or middle optional parameters. For each
    /// parameter slot not filled by a positional/named argument we synthesize a
    /// default-value bound expression from the parameter symbol.
    private func TryReorderUserCallArgumentsWithDefaults(
        rawArguments GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
        boundPositionalAndNamed ImmutableArray[BoundExpression],
        parameters ImmutableArray[ParameterSymbol],
        callableName string,
        diagnosticLocation TextLocation,
        out parameterSyntax[]ExpressionSyntax?,
        out permutedBound ImmutableArray[BoundExpression]
    ) bool {
        parameterSyntax = [parameters.Length]ExpressionSyntax
        let slotted = [parameters.Length]BoundExpression
        let filled = [parameters.Length]bool
        for var i = 0; i < rawArguments.Count; i++ {
            if rawArguments[i] is not NamedArgumentExpressionSyntax named {
                if (i >= parameters.Length || filled[i]) {
                    Diagnostics.ReportPositionalArgumentAfterNamedArgument(rawArguments[i].Location)
                    permutedBound = ImmutableArray[BoundExpression].Empty
                    return false
                }
                slotted[i] = boundPositionalAndNamed[i]
                filled[i] = true
                parameterSyntax[i] = rawArguments[i]
                continue
            }
            let name = named.NameToken.ValueText
            var matched = false
            for var p = 0; p < parameters.Length; p++ {
                if parameters[p].Name == name {
                    if (filled[p]) {
                        Diagnostics.ReportDuplicateNamedArgument(named.NameToken.Location, name)
                        permutedBound = ImmutableArray[BoundExpression].Empty
                        return false
                    }
                    slotted[p] = boundPositionalAndNamed[i]
                    filled[p] = true
                    parameterSyntax[p] = rawArguments[i]
                    matched = true
                    break
                }
            }
            if !matched {
                Diagnostics.ReportNamedArgumentParameterNotFound(named.NameToken.Location, callableName, name)
                permutedBound = ImmutableArray[BoundExpression].Empty
                return false
            }
        }
        for var i = 0; i < parameters.Length; i++ {
            if (filled[i]) {
                continue
            }
            if !parameters[i].HasExplicitDefaultValue {
                Diagnostics.ReportWrongArgumentCount(
                    diagnosticLocation,
                    callableName,
                    parameters.Length,
                    rawArguments.Count
                )
                permutedBound = ImmutableArray[BoundExpression].Empty
                return false
            }
            slotted[i] = CreateOptionalUserDefaultArgument(parameters[i])
        }
        permutedBound = ImmutableArray.Create(slotted)
        return true
    }

    shared {
        /// Issue #2263: rewrites an imported `data class` primary-constructor
        /// call into the field-initialising (cref:BoundStructLiteralExpression)
        /// shared with the `with`/copy lowering. The constructor's arguments
        /// are already reordered into primary-constructor parameter order, so each
        /// argument maps onto the field named by the parameter at the same index.
        /// Issue #2291: an imported C# record surfaces its positional members as
        /// auto-properties (mangled backing fields), not plain public fields like
        /// a gsc-native data class — a parameter with no matching field falls
        /// back to a settable property with the same name so the emitter's
        /// positional-constructor construction path (`MethodBodyEmitter.
        /// EmitImportedPositionalRecordLiteral`) sees a value for every
        /// positional member regardless of which kind of data class it is.
        private func LowerImportedDataClassConstruction(ctorCall BoundConstructorCallExpression) BoundExpression {
            let classType = ctorCall.StructType
            let parameters = classType.PrimaryConstructorParameters
            let initializers = ImmutableArray.CreateBuilder[BoundFieldInitializer](parameters.Length)
            for var i = 0; i < parameters.Length && i < ctorCall.Arguments.Length; i++ {
                if classType.TryGetField(parameters[i].Name, out var field) {
                    initializers.Add(BoundFieldInitializer(field!!, ctorCall.Arguments[i]))
                    continue
                }
                if TypeMemberModel.TryGetProperty(classType, parameters[i].Name, out var property) &&
                    (property!!.HasSetter || classType.UsesConstructorOwnedDataConstruction) {
                    initializers.Add(BoundFieldInitializer(property!!, ctorCall.Arguments[i]))
                }
            }
            return BoundStructLiteralExpression(ctorCall.Syntax, classType, initializers.ToImmutable())
        }

        /// Issue #2278: returns whether [`classType`](paramref) is the
        /// semantic aggregate for an already-CLOSED imported generic type (e.g.
        /// `Box[int32]` built by reflecting over the closed CLR type
        /// `Box<int>`). Such an aggregate is not itself a generic
        /// definition ((cref:StructSymbol.IsGenericDefinition) is
        /// `false` — its members are already fully substituted),
        /// but a construction call against it still legitimately carries the
        /// original explicit `[...]` type-argument list the caller used to
        /// select the closed CLR type in the first place.
        /// @param classType The candidate aggregate.
        /// @returns `true` when [`classType`](paramref) is a closed-generic imported aggregate.
        private func IsClosedGenericImportedAggregate(classType StructSymbol) bool -> classType.ClrType != nil &&
            classType
            .ClrType
            .IsGenericType &&
            !classType
            .ClrType
            .IsGenericTypeDefinition

        private func GetInlineOutArgumentIndices(
            arguments GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax]
        ) ImmutableArray[int32] {
            var indices ImmutableArray[int32].Builder? = nil
            for var i = 0; i < arguments.Count; i++ {
                if (
                    UnwrapNamedArgumentValue(arguments[i]) is RefArgumentExpressionSyntax and
                        {IsInlineDeclaration: true}
                ) {
                    indices ??= ImmutableArray.CreateBuilder[int32]()
                    indices!!.Add(i)
                }
            }
            return indices?.ToImmutable() ?? default(ImmutableArray[int32])
        }

        private func ConstructorAcceptsInlineOutArguments(
            constructor ConstructorSymbol,
            argumentNames ImmutableArray[string],
            inlineOutArgumentIndices ImmutableArray[int32]
        ) bool {
            if inlineOutArgumentIndices.IsDefaultOrEmpty {
                return true
            }
            for argumentIndex in inlineOutArgumentIndices {
                if !ConstructorAcceptsInlineOutArgument(constructor, argumentNames, argumentIndex) {
                    return false
                }
            }
            return true
        }

        private func ConstructorAcceptsInlineOutArgument(
            constructor ConstructorSymbol,
            argumentNames ImmutableArray[string],
            argumentIndex int32
        ) bool {
            let parameters = constructor.Parameters
            let name string? = if argumentNames.IsDefault {
                default(string?)
            } else {
                argumentNames[argumentIndex]
            }
            let parameterIndex = if name == nil {
                argumentIndex
            } else {
                FindParameterIndex(parameters, name)
            }
            return parameterIndex >= 0 &&
                parameterIndex < parameters.Length &&
                parameters[parameterIndex].RefKind == RefKind.Out
        }

        private func FindParameterIndex(parameters ImmutableArray[ParameterSymbol], name string) int32 {
            for var i = 0; i < parameters.Length; i++ {
                if parameters[i].Name == name {
                    return i
                }
            }
            return -1
        }

        private func ConstructorAcceptsTypedInlineOutArguments(
            constructor ConstructorSymbol,
            constructedType StructSymbol,
            argumentNames ImmutableArray[string],
            inlineOutArgumentIndices ImmutableArray[int32],
            boundArguments ImmutableArray[BoundExpression].Builder
        ) bool {
            let parameterTypes = constructedType.GetConstructorParameterTypesForConstruction(constructor)
            for argumentIndex in inlineOutArgumentIndices {
                if !(boundArguments[argumentIndex] is BoundAddressOfExpression{Operand: {Type: var argumentType}}) ||
                    argumentType == TypeSymbol.Error {
                    continue
                }
                let name string? = if argumentNames.IsDefault {
                    default(string?)
                } else {
                    argumentNames[argumentIndex]
                }
                let parameterIndex = if name == nil {
                    argumentIndex
                } else {
                    FindParameterIndex(constructor.Parameters, name)
                }
                if parameterIndex < 0 ||
                    parameterIndex >= parameterTypes.Length ||
                    !ByRefStorageMatching.AreSameStorageType(
                    argumentType,
                    parameterTypes[parameterIndex],
                    out _,
                    out _,
                    out _
                ) {
                    return false
                }
            }
            return true
        }

        private func CreateConstructedConstructorCandidate(
            constructor ConstructorSymbol,
            constructedType StructSymbol
        ) FunctionSymbol {
            let effectiveTypes = constructedType.GetConstructorParameterTypesForConstruction(constructor)
            let parameters = ImmutableArray.CreateBuilder[ParameterSymbol](constructor.Parameters.Length)
            for var i = 0; i < constructor.Parameters.Length; i++ {
                let parameter = constructor.Parameters[i]
                let candidateParameter = ParameterSymbol(parameter, effectiveTypes[i], parameter.DeclaringSyntax)
                if parameter.HasExplicitDefaultValue {
                    candidateParameter.SetExplicitDefaultValue(parameter.ExplicitDefaultValue)
                }
                parameters.Add(candidateParameter)
            }
            let function = constructor.Function
            return FunctionSymbol(
                function.Name,
                parameters.MoveToImmutable(),
                function.Type,
                function.Declaration,
                function.Package,
                function.Accessibility,
                constructedType
            )
        }

        private func ConstructorAcceptsTypedInlineOutArguments(
            syntax CallExpressionSyntax,
            constructor FunctionSymbol,
            argumentNames ImmutableArray[string],
            inlineOutArgumentIndices ImmutableArray[int32],
            argumentTypes IReadOnlyList[TypeSymbol?]
        ) bool {
            if inlineOutArgumentIndices.IsDefaultOrEmpty {
                return true
            }
            for argumentIndex in inlineOutArgumentIndices {
                let inlineOut = cast[RefArgumentExpressionSyntax](
                    UnwrapNamedArgumentValue(syntax.Arguments[argumentIndex])
                )
                if inlineOut.IsDiscard || inlineOut.DeclaredType == nil {
                    continue
                }
                let name string? = if argumentNames.IsDefault {
                    default(string?)
                } else {
                    argumentNames[argumentIndex]
                }
                let parameterIndex = if name == nil {
                    argumentIndex
                } else {
                    FindParameterIndex(constructor.Parameters, name)
                }
                if parameterIndex < 0 ||
                    parameterIndex >= constructor
                    .Parameters
                    .Length ||
                    argumentTypes[argumentIndex] is not{} argumentType ||
                    !ByRefStorageMatching
                    .AreSameStorageType(
                    argumentType,
                    constructor.Parameters[parameterIndex].Type,
                    out _,
                    out _,
                    out _
                ) {
                    return false
                }
            }
            return true
        }
    }
}
