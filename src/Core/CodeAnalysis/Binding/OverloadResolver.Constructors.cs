// <copyright file="OverloadResolver.Constructors.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Documentation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class OverloadResolver
{
    public BoundExpression BindConstructorCallExpression(CallExpressionSyntax syntax, StructSymbol classType)
    {
        var bound = BindConstructorCallExpressionCore(syntax, classType);

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
        if (bound is BoundConstructorCallExpression ctorCall
            && ctorCall.StructType.IsClass
            && ctorCall.StructType.ClrType != null
            && ctorCall.StructType.IsData)
        {
            return LowerImportedDataClassConstruction(ctorCall);
        }

        return bound;
    }

    /// <summary>
    /// Issue #2263: rewrites an imported <c>data class</c> primary-constructor
    /// call into the field-initialising <see cref="BoundStructLiteralExpression"/>
    /// shared with the <c>with</c>/copy lowering. The constructor's arguments
    /// are already reordered into primary-constructor parameter order, so each
    /// argument maps onto the field named by the parameter at the same index.
    /// Issue #2291: an imported C# record surfaces its positional members as
    /// auto-properties (mangled backing fields), not plain public fields like
    /// a gsc-native data class — a parameter with no matching field falls
    /// back to a settable property with the same name so the emitter's
    /// positional-constructor construction path (<c>MethodBodyEmitter.
    /// EmitImportedPositionalRecordLiteral</c>) sees a value for every
    /// positional member regardless of which kind of data class it is.
    /// </summary>
    private static BoundExpression LowerImportedDataClassConstruction(BoundConstructorCallExpression ctorCall)
    {
        var classType = ctorCall.StructType;
        var parameters = classType.PrimaryConstructorParameters;
        var initializers = ImmutableArray.CreateBuilder<BoundFieldInitializer>(parameters.Length);
        for (var i = 0; i < parameters.Length && i < ctorCall.Arguments.Length; i++)
        {
            if (classType.TryGetField(parameters[i].Name, out var field))
            {
                initializers.Add(new BoundFieldInitializer(field, ctorCall.Arguments[i]));
                continue;
            }

            if (TypeMemberModel.TryGetProperty(classType, parameters[i].Name, out var property) && property.HasSetter)
            {
                initializers.Add(new BoundFieldInitializer(property, ctorCall.Arguments[i]));
            }
        }

        return new BoundStructLiteralExpression(ctorCall.Syntax, classType, initializers.ToImmutable());
    }

    /// <summary>
    /// Issue #2278: returns whether <paramref name="classType"/> is the
    /// semantic aggregate for an already-CLOSED imported generic type (e.g.
    /// <c>Box[int32]</c> built by reflecting over the closed CLR type
    /// <c>Box&lt;int&gt;</c>). Such an aggregate is not itself a generic
    /// definition (<see cref="StructSymbol.IsGenericDefinition"/> is
    /// <see langword="false"/> — its members are already fully substituted),
    /// but a construction call against it still legitimately carries the
    /// original explicit <c>[...]</c> type-argument list the caller used to
    /// select the closed CLR type in the first place.
    /// </summary>
    /// <param name="classType">The candidate aggregate.</param>
    /// <returns><see langword="true"/> when <paramref name="classType"/> is a closed-generic imported aggregate.</returns>
    private static bool IsClosedGenericImportedAggregate(StructSymbol classType)
        => classType.ClrType != null && classType.ClrType.IsGenericType && !classType.ClrType.IsGenericTypeDefinition;

    private BoundExpression BindConstructorCallExpressionCore(CallExpressionSyntax syntax, StructSymbol classType)
    {
        // ADR-0047 §6 / #175: primary-constructor call `Foo(...)` is a
        // use of the class type itself.
        reportObsoleteUseIfApplicable(syntax.Identifier.Location, classType, classType.Name);

        // Issue #987: an abstract class (one with a still-abstract method in its
        // effective member set) cannot be instantiated. Report GS0386 and stop —
        // this is the clean compile error C# gives for `new AbstractType()`
        // (CS0144) rather than a runtime failure. Base-class construction by a
        // derived ctor flows through BaseConstructorInitializer, not here, so the
        // abstract base is still constructible as a base subobject.
        if (classType.IsAbstract)
        {
            Diagnostics.ReportCannotInstantiateAbstractType(syntax.Identifier.Location, classType.Name);
            return new BoundErrorExpression(syntax);
        }

        // Issue #306: a class declaring an explicit `init(...)` constructor is
        // constructed against that constructor's parameter list rather than a
        // primary-constructor parameter list.
        if (classType.ExplicitConstructor != null)
        {
            return BindExplicitConstructorCallExpression(syntax, classType);
        }

        // Issue #343: pre-validate named-argument layout (positional precedes
        // named, no duplicate names). Diagnostics are reported by the helper.
        if (!TryAnalyzeCallArgumentLayout(syntax.Arguments, out _, out var argumentNames))
        {
            return new BoundErrorExpression(syntax);
        }

        // Phase 4.3b / ADR-0020: a primary-constructor call on a generic
        // class definition (`Box(5)` or `Box[int](5)`) builds a type-argument
        // substitution before resolving the parameter list against the
        // user-supplied arguments. Explicit `[…]` wins; otherwise we infer
        // from value-argument types against the definition's primary-ctor
        // parameter types (first-seen-wins, same rule as 4.1 call sites).
        if (classType.IsGenericDefinition)
        {
            var tps = classType.TypeParameters;
            var defParams = classType.PrimaryConstructorParameters;
            var substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
            if (syntax.TypeArgumentList != null)
            {
                var explicitArgs = syntax.TypeArgumentList.Arguments;
                if (explicitArgs.Count != tps.Length)
                {
                    Diagnostics.ReportWrongTypeArgumentCount(syntax.TypeArgumentList.Location, classType.Name, tps.Length, explicitArgs.Count);
                    return new BoundErrorExpression(syntax);
                }

                for (var i = 0; i < explicitArgs.Count; i++)
                {
                    var ta = bindTypeClause(explicitArgs[i]);
                    if (ta == null)
                    {
                        return new BoundErrorExpression(syntax);
                    }

                    substitution[tps[i]] = ta;
                }
            }
            else
            {
                // Issue #1629: the pre-bind below is a throwaway probe used only
                // to infer type arguments — the same argument syntax is bound
                // again for real once the type arguments are known (loop after
                // this generic block). Roll back any diagnostics it produced so
                // they are reported exactly once, by the real bind.
                var inferenceDiagMark = Diagnostics.Count;

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
                var defIsVariadic = defParams.Length > 0
                    && defParams[defParams.Length - 1].IsVariadic;
                var defFixedCount = defIsVariadic ? defParams.Length - 1 : defParams.Length;

                for (var i = 0; i < syntax.Arguments.Count; i++)
                {
                    var argSyntax = syntax.Arguments[i];
                    int paramIdx;
                    if (argSyntax is NamedArgumentExpressionSyntax named)
                    {
                        paramIdx = -1;
                        for (var p = 0; p < defParams.Length; p++)
                        {
                            if (string.Equals(defParams[p].Name, named.NameToken.Text, StringComparison.Ordinal))
                            {
                                paramIdx = p;
                                break;
                            }
                        }

                        if (paramIdx < 0)
                        {
                            continue;
                        }

                        argSyntax = named.Expression;
                    }
                    else
                    {
                        paramIdx = i;
                    }

                    if (defIsVariadic && paramIdx >= defFixedCount)
                    {
                        // Variadic slot: handled in the dedicated block below
                        // so we can choose between pass-through and pack.
                        continue;
                    }

                    if (paramIdx >= defParams.Length)
                    {
                        continue;
                    }

                    var preBound = bindExpression(argSyntax);
                    inferTypeArguments(defParams[paramIdx].Type, preBound.Type, substitution);
                }

                if (defIsVariadic)
                {
                    var variadicParamType = defParams[defParams.Length - 1].Type;
                    var trailingCount = syntax.Arguments.Count - defFixedCount;
                    if (trailingCount == 1)
                    {
                        var single = bindExpression(UnwrapNamedArgumentValue(syntax.Arguments[defFixedCount]));
                        if (single.Type is SliceTypeSymbol)
                        {
                            inferTypeArguments(variadicParamType, single.Type, substitution);
                        }
                        else if (variadicParamType is SliceTypeSymbol variadicSlice)
                        {
                            inferTypeArguments(variadicSlice.ElementType, single.Type, substitution);
                        }
                    }
                    else if (trailingCount > 1 && variadicParamType is SliceTypeSymbol variadicSlice2)
                    {
                        for (var j = defFixedCount; j < syntax.Arguments.Count; j++)
                        {
                            var preBound = bindExpression(UnwrapNamedArgumentValue(syntax.Arguments[j]));
                            inferTypeArguments(variadicSlice2.ElementType, preBound.Type, substitution);
                        }
                    }
                }

                // Issue #1629: discard the pre-bind's speculative diagnostics —
                // the arguments are bound again for real below.
                Diagnostics.TruncateTo(inferenceDiagMark);

                foreach (var tp in tps)
                {
                    if (!substitution.ContainsKey(tp))
                    {
                        Diagnostics.ReportTypeArgumentInferenceFailed(syntax.Identifier.Location, classType.Name, tp.Name);
                        return new BoundErrorExpression(syntax);
                    }
                }
            }

            var constraintLocation = syntax.TypeArgumentList != null
                ? syntax.TypeArgumentList.Location
                : syntax.Identifier.Location;
            foreach (var tp in tps)
            {
                var typeArg = substitution[tp];
                if (!satisfiesConstraint(typeArg, tp))
                {
                    Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(constraintLocation, tp.Name, typeArg, describeConstraint(tp));
                    return new BoundErrorExpression(syntax);
                }
            }

            var typeArgs = ImmutableArray.CreateBuilder<TypeSymbol>(tps.Length);
            foreach (var tp in tps)
            {
                typeArgs.Add(substitution[tp]);
            }

            classType = StructSymbol.Construct(classType, typeArgs.MoveToImmutable(), MapClrType);
        }
        else if (syntax.TypeArgumentList != null && !IsClosedGenericImportedAggregate(classType))
        {
            // Issue #2278: a `classType` that is itself the semantic aggregate
            // for an already-CLOSED imported generic data type (e.g.
            // `Box[int32]`) is not a generic DEFINITION — its `TypeParameters`
            // is empty because reflection over the closed CLR type already
            // substituted every member. The caller
            // (TryBindClrConstructorCall) resolved and consumed the explicit
            // `[...]` type-argument list itself (via `Type.MakeGenericType`)
            // before building this aggregate, so seeing one here is expected
            // and must not be treated as an arity mismatch.
            Diagnostics.ReportWrongTypeArgumentCount(syntax.TypeArgumentList.Location, classType.Name, 0, syntax.TypeArgumentList.Arguments.Count);
            return new BoundErrorExpression(syntax);
        }

        var parameters = classType.PrimaryConstructorParameters;
        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
        foreach (var argument in syntax.Arguments)
        {
            // Issue #343: bind the value behind any named-argument wrapper.
            boundArguments.Add(BindOverloadArgumentValue(UnwrapNamedArgumentValue(argument)));
        }

        // ADR-0101 follow-up / issue #819: a primary constructor may declare a
        // trailing variadic parameter (`name ...T`). When present, the
        // matching auto-field has type `[]T`; at the call site we pack any
        // trailing positional arguments into a fresh `[]T` (or forward a
        // single `[]T` value unchanged). Named arguments are not legal at a
        // variadic call site because the trailing slot consumes any number of
        // positional arguments.
        var primaryIsVariadic = parameters.Length > 0
            && parameters[parameters.Length - 1].IsVariadic;
        if (primaryIsVariadic)
        {
            if (!argumentNames.IsDefault)
            {
                Diagnostics.ReportNamedArgumentParameterNotFound(syntax.Identifier.Location, classType.Name, FirstNamedArgumentName(argumentNames));
                return new BoundErrorExpression(syntax);
            }

            var fixedPrimaryCount = parameters.Length - 1;
            var requestedArgCount = syntax.Arguments.Count;
            if (requestedArgCount < fixedPrimaryCount)
            {
                Diagnostics.ReportTooFewArgumentsForVariadic(syntax.Identifier.Location, classType.Name, fixedPrimaryCount, requestedArgCount);
                return new BoundErrorExpression(syntax);
            }

            var variadicParam = parameters[parameters.Length - 1];
            var variadicSliceType = (SliceTypeSymbol)variadicParam.Type;

            var parameterSyntaxV = new ExpressionSyntax[requestedArgCount];
            for (var i = 0; i < requestedArgCount; i++)
            {
                parameterSyntaxV[i] = syntax.Arguments[i];
            }

            // Convert/validate the fixed-portion arguments first.
            var hasErrorsV = false;
            for (var i = 0; i < fixedPrimaryCount; i++)
            {
                var argument = boundArguments[i];
                var parameter = parameters[i];
                if (parameterSyntaxV[i] is InterpolatedStringExpressionSyntax interpolatedCtorArg
                    && isFormattableStringTargetType(parameter.Type))
                {
                    boundArguments[i] = bindInterpolatedStringAsFormattable(interpolatedCtorArg, parameter.Type);
                    continue;
                }

                // Issue #2069/#2084: force the wrap for a func/arrow literal
                // argument flowing into a NAMED delegate parameter — see the
                // matching comment at the other constructor-argument path
                // (above in this file) for the full rationale. This is the
                // fixed-portion loop for a variadic constructor's arguments.
                if (parameter.Type is DelegateTypeSymbol namedDelegateCtorFixedTarget
                    && argument.Type is FunctionTypeSymbol
                    && !ReferenceEquals(argument.Type, namedDelegateCtorFixedTarget))
                {
                    boundArguments[i] = conversions.BindConversion(parameterSyntaxV[i].Location, argument, parameter.Type);
                    continue;
                }

                if (argument.Type != parameter.Type
                    && !Conversion.Classify(argument.Type, parameter.Type).IsImplicit)
                {
                    if (TryBindConstantNarrowingArgument(argument, parameter.Type, parameterSyntaxV[i].Location, out var narrowedArg))
                    {
                        boundArguments[i] = narrowedArg;
                        continue;
                    }

                    if (conversions.TryApplyUserDefinedImplicitArgumentConversion(argument, parameter.Type, out var convertedArg))
                    {
                        boundArguments[i] = convertedArg;
                        continue;
                    }

                    if (argument.Type != TypeSymbol.Error)
                    {
                        Diagnostics.ReportWrongArgumentType(parameterSyntaxV[i].Location, parameter.Name, parameter.Type, argument.Type);
                    }

                    hasErrorsV = true;
                }
            }

            // Issue #1630: pack/pass-through the trailing arguments through
            // the canonical helper (applies #1493 element coercion when
            // packing).
            var packedArgs = PackOrPassThroughVariadicArguments(
                conversions,
                Diagnostics,
                syntax,
                boundArguments.ToImmutable(),
                fixedPrimaryCount,
                variadicSliceType,
                variadicParam.Name,
                i => parameterSyntaxV[i].Location,
                ref hasErrorsV);

            if (hasErrorsV)
            {
                return new BoundErrorExpression(syntax);
            }

            if (classType.IsInline)
            {
                return new BoundConstructorCallExpression(syntax, classType, packedArgs);
            }

            if (!classType.IsClass)
            {
                var fieldInitializersV = ImmutableArray.CreateBuilder<BoundFieldInitializer>(parameters.Length);
                for (var i = 0; i < parameters.Length; i++)
                {
                    if (classType.TryGetField(parameters[i].Name, out var field))
                    {
                        fieldInitializersV.Add(new BoundFieldInitializer(field, packedArgs[i]));
                        continue;
                    }

                    // Issue #2291: an imported C# `record struct`'s positional
                    // members are auto-properties, not plain fields — fall
                    // back to a settable property with the same name.
                    if (TypeMemberModel.TryGetProperty(classType, parameters[i].Name, out var propertyV) && propertyV.HasSetter)
                    {
                        fieldInitializersV.Add(new BoundFieldInitializer(propertyV, packedArgs[i]));
                    }
                }

                return new BoundStructLiteralExpression(syntax, classType, fieldInitializersV.ToImmutable());
            }

            return new BoundConstructorCallExpression(syntax, classType, packedArgs);
        }

        // ADR-0063 §5: primary constructors now honor optional parameters. When
        // the caller omits a value for a parameter that declared one, use the
        // overload-style permutation helper that fills defaults.
        var primaryHasOptional = false;
        for (var pi = 0; pi < parameters.Length; pi++)
        {
            if (parameters[pi].HasExplicitDefaultValue)
            {
                primaryHasOptional = true;
                break;
            }
        }

        if (primaryHasOptional)
        {
            if (!TryReorderUserCallArgumentsWithDefaults(
                    syntax.Arguments,
                    boundArguments.ToImmutable(),
                    parameters,
                    classType.Name,
                    syntax.Location,
                    out var primaryParameterSyntax,
                    out var primaryPermutedBound))
            {
                return new BoundErrorExpression(syntax);
            }

            boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(primaryPermutedBound.Length);
            for (var i = 0; i < primaryPermutedBound.Length; i++)
            {
                boundArguments.Add(primaryPermutedBound[i]);
            }

            var hasErrorsP = false;
            for (var i = 0; i < parameters.Length; i++)
            {
                var argument = boundArguments[i];
                var parameter = parameters[i];
                var converted = conversions.BindConversion(primaryParameterSyntax[i]?.Location ?? syntax.Location, argument, parameter.Type, allowExplicit: false);
                if (ReferenceEquals(converted.Type, TypeSymbol.Error))
                {
                    hasErrorsP = true;
                }
                else
                {
                    boundArguments[i] = converted;
                }
            }

            if (hasErrorsP)
            {
                return new BoundErrorExpression(syntax);
            }

            return new BoundConstructorCallExpression(syntax, classType, boundArguments.ToImmutable());
        }

        if (syntax.Arguments.Count != parameters.Length)
        {
            TextSpan span;
            if (syntax.Arguments.Count > parameters.Length)
            {
                SyntaxNode firstExceedingNode;
                if (parameters.Length > 0)
                {
                    firstExceedingNode = syntax.Arguments.GetSeparator(parameters.Length - 1);
                }
                else
                {
                    firstExceedingNode = syntax.Arguments[0];
                }

                var lastExceedingArgument = syntax.Arguments[syntax.Arguments.Count - 1];
                span = TextSpan.FromBounds(firstExceedingNode.Span.Start, lastExceedingArgument.Span.End);
            }
            else
            {
                span = syntax.CloseParenthesisToken.Span;
            }

            Diagnostics.ReportWrongArgumentCount(new TextLocation(syntax.Location.Text, span), classType.Name, parameters.Length, syntax.Arguments.Count);
            return new BoundErrorExpression(syntax);
        }

        // Issue #343: reorder bound arguments into parameter order when the
        // call mixes positional and named arguments. The per-position loop
        // below then sees the call as fully positional.
        ExpressionSyntax[] parameterSyntax;
        if (!argumentNames.IsDefault)
        {
            if (!TryReorderUserCallArguments(
                    syntax.Arguments,
                    boundArguments.ToImmutable(),
                    parameters.Length,
                    p => parameters[p].Name,
                    classType.Name,
                    out parameterSyntax,
                    out var permutedBound))
            {
                return new BoundErrorExpression(syntax);
            }

            boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(permutedBound.Length);
            for (var i = 0; i < permutedBound.Length; i++)
            {
                boundArguments.Add(permutedBound[i]);
            }
        }
        else
        {
            parameterSyntax = new ExpressionSyntax[syntax.Arguments.Count];
            for (var i = 0; i < syntax.Arguments.Count; i++)
            {
                parameterSyntax[i] = syntax.Arguments[i];
            }
        }

        var hasErrors = false;
        for (var i = 0; i < parameters.Length; i++)
        {
            var argument = boundArguments[i];
            var parameter = parameters[i];

            // Issue #1238: re-bind a deferred target-typed conditional argument
            // against the constructor parameter type before the convertibility
            // checks below.
            boundArguments[i] = argument = FinalizeBranchyArgument(
                argument,
                i < parameterSyntax.Length ? parameterSyntax[i] : null,
                parameter.Type);

            // ADR-0055 Tier 4 (#369): an interpolated-string argument targeting an
            // IFormattable/FormattableString constructor parameter lowers to
            // FormattableStringFactory.Create rather than an eager string.
            if (parameterSyntax[i] is InterpolatedStringExpressionSyntax interpolatedCtorArg
                && isFormattableStringTargetType(parameter.Type))
            {
                boundArguments[i] = bindInterpolatedStringAsFormattable(interpolatedCtorArg, parameter.Type);
                continue;
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
            if (parameter.Type is DelegateTypeSymbol namedDelegateCtorTarget
                && argument.Type is FunctionTypeSymbol
                && !ReferenceEquals(argument.Type, namedDelegateCtorTarget))
            {
                boundArguments[i] = conversions.BindConversion(parameterSyntax[i].Location, argument, parameter.Type);
                continue;
            }

            if (argument.Type != parameter.Type
                && !Conversion.Classify(argument.Type, parameter.Type).IsImplicit)
            {
                if (TryConvertLiteralArgumentToExpressionTree(argument, parameter.Type, parameterSyntax[i].Location, out var expressionTreeArg))
                {
                    boundArguments[i] = expressionTreeArg;
                    continue;
                }

                // Issue #889: arrow/func literal → void-returning delegate.
                if (TryConvertLiteralArgumentToVoidDelegate(argument, parameter.Type, parameterSyntax[i].Location, out var voidDelegateArg))
                {
                    boundArguments[i] = voidDelegateArg;
                    continue;
                }

                // Issue #1281: implicit constant-expression narrowing argument.
                if (TryBindConstantNarrowingArgument(argument, parameter.Type, parameterSyntax[i].Location, out var narrowedArg))
                {
                    boundArguments[i] = narrowedArg;
                    continue;
                }

                if (conversions.TryApplyUserDefinedImplicitArgumentConversion(argument, parameter.Type, out var convertedArg))
                {
                    boundArguments[i] = convertedArg;
                    continue;
                }

                if (argument.Type != TypeSymbol.Error)
                {
                    Diagnostics.ReportWrongArgumentType(parameterSyntax[i].Location, parameter.Name, parameter.Type, argument.Type);
                }

                hasErrors = true;
            }
            else
            {
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
                boundArguments[i] = conversions.BindConversion(parameterSyntax[i].Location, argument, parameter.Type);
            }
        }

        if (hasErrors)
        {
            return new BoundErrorExpression(syntax);
        }

        if (classType.IsInline)
        {
            return new BoundConstructorCallExpression(syntax, classType, boundArguments.ToImmutable());
        }

        if (!classType.IsClass)
        {
            var fieldInitializers = ImmutableArray.CreateBuilder<BoundFieldInitializer>(parameters.Length);
            for (var i = 0; i < parameters.Length; i++)
            {
                if (classType.TryGetField(parameters[i].Name, out var field))
                {
                    fieldInitializers.Add(new BoundFieldInitializer(field, boundArguments[i]));
                    continue;
                }

                // Issue #2291: an imported C# `record struct`'s positional
                // members are auto-properties, not plain fields — fall back
                // to a settable property with the same name.
                if (TypeMemberModel.TryGetProperty(classType, parameters[i].Name, out var property) && property.HasSetter)
                {
                    fieldInitializers.Add(new BoundFieldInitializer(property, boundArguments[i]));
                }
            }

            return new BoundStructLiteralExpression(syntax, classType, fieldInitializers.ToImmutable());
        }

        return new BoundConstructorCallExpression(syntax, classType, boundArguments.ToImmutable());
    }

    /// <summary>
    /// Issue #306: binds a construction call <c>T(args)</c> to the class's explicit
    /// <c>init(...)</c> constructor, validating the argument count and applying
    /// argument conversions against the constructor's parameter list.
    /// </summary>
    private BoundExpression BindExplicitConstructorCallExpression(CallExpressionSyntax syntax, StructSymbol classType)
    {
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
        if (syntax.TypeArgumentList != null || classType.IsGenericDefinition)
        {
            if (!TryCloseGenericExplicitConstructorType(syntax, classType, out classType))
            {
                return new BoundErrorExpression(syntax);
            }
        }

        // Issue #343: pre-validate named-argument layout (positional precedes
        // named, no duplicate names). Diagnostics are reported by the helper.
        if (!TryAnalyzeCallArgumentLayout(syntax.Arguments, out _, out var argumentNames))
        {
            return new BoundErrorExpression(syntax);
        }

        // ADR-0063 §9: when the class declares multiple init(...) constructors,
        // bind the arguments first, then pick the constructor whose signature
        // best matches the call. With a single constructor the existing
        // single-overload diagnostics (wrong arity) still fire below.
        // Issue #1214: for a closed generic construction, the constructor table
        // lives on the open definition (EffectiveExplicitConstructors).
        var ctorOverloads = classType.EffectiveExplicitConstructors;
        var boundArgumentsBuilder = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
        for (var ai = 0; ai < syntax.Arguments.Count; ai++)
        {
            // Issue #343: peel any named-argument wrapper before binding so the
            // value is bound in source order. We will permute below.
            var argument = UnwrapNamedArgumentValue(syntax.Arguments[ai]);
            ParameterSymbol parameterForArg = null;
            if (ctorOverloads.Length == 1 && ai < ctorOverloads[0].Parameters.Length)
            {
                parameterForArg = ctorOverloads[0].Parameters[ai];
            }

            if (argument is RefArgumentExpressionSyntax refArg)
            {
                boundArgumentsBuilder.Add(bindRefArgumentExpression(refArg, parameterForArg));
            }
            else
            {
                boundArgumentsBuilder.Add(BindOverloadArgumentValue(argument));
            }
        }

        ConstructorSymbol selectedCtor;
        if (ctorOverloads.Length <= 1)
        {
            selectedCtor = ctorOverloads.Length == 1 ? ctorOverloads[0] : classType.ExplicitConstructor;
        }
        else
        {
            var ctorFunctions = ImmutableArray.CreateBuilder<FunctionSymbol>(ctorOverloads.Length);
            foreach (var c in ctorOverloads)
            {
                ctorFunctions.Add(c.Function);
            }

            var selectedFn = SelectBestInstanceOverload(
                ctorFunctions.MoveToImmutable(),
                syntax.Arguments.Count,
                argumentNames,
                boundArgumentsBuilder.ToImmutable(),
                out var ambiguous,
                out var nullSafetyFailure);

            if (selectedFn == null)
            {
                if (nullSafetyFailure != null)
                {
                    var argLoc = nullSafetyFailure.Index < syntax.Arguments.Count
                        ? syntax.Arguments[nullSafetyFailure.Index].Location
                        : syntax.Identifier.Location;
                    Diagnostics.ReportWrongArgumentType(argLoc, nullSafetyFailure.ParamName, nullSafetyFailure.ParamType, nullSafetyFailure.ArgType);
                }
                else if (ambiguous)
                {
                    Diagnostics.ReportAmbiguousOverloadResolution(syntax.Identifier.Location, classType.Name);
                }
                else
                {
                    Diagnostics.ReportNoApplicableOverload(syntax.Identifier.Location, classType.Name);
                }

                return new BoundErrorExpression(syntax);
            }

            selectedCtor = null;
            foreach (var c in ctorOverloads)
            {
                if (ReferenceEquals(c.Function, selectedFn))
                {
                    selectedCtor = c;
                    break;
                }
            }
        }

        var parameters = selectedCtor.Parameters;

        // Issue #1214: for a closed generic construction, surface the
        // constructor's parameter types with the construction's type arguments
        // substituted (`init(v T)` on `Box[int32]` → `init(v int32)`), so the
        // per-position conversion below targets the concrete argument types.
        // For a non-generic or open type these equal the declared types.
        var effectiveParamTypes = classType.GetConstructorParameterTypesForConstruction(selectedCtor);

        // ADR-0101 follow-up / issue #812: a constructor's last parameter
        // may be variadic. The arity check accepts any count >= the fixed
        // (non-variadic) parameter count; pack / pass-through happens just
        // below before the per-position conversion loop.
        var ctorIsVariadic = parameters.Length > 0
            && parameters[parameters.Length - 1].IsVariadic;
        var fixedCtorParamCount = ctorIsVariadic ? parameters.Length - 1 : parameters.Length;

        if (ctorIsVariadic && !argumentNames.IsDefault)
        {
            Diagnostics.ReportNamedArgumentParameterNotFound(syntax.Identifier.Location, classType.Name, FirstNamedArgumentName(argumentNames));
            return new BoundErrorExpression(syntax);
        }

        // ADR-0063: synthesize defaults for any unsupplied trailing/middle
        // optional parameters. Both arity-with-named-omission and
        // trailing-omission go through this path.
        var requestedArgCount = syntax.Arguments.Count;
        if (ctorIsVariadic)
        {
            if (requestedArgCount < fixedCtorParamCount)
            {
                Diagnostics.ReportTooFewArgumentsForVariadic(syntax.Identifier.Location, classType.Name, fixedCtorParamCount, requestedArgCount);
                return new BoundErrorExpression(syntax);
            }
        }
        else if (requestedArgCount < parameters.Length)
        {
            var minRequired = parameters.Length;
            for (var i = parameters.Length - 1; i >= 0; i--)
            {
                if (parameters[i].HasExplicitDefaultValue)
                {
                    minRequired = i;
                }
                else
                {
                    break;
                }
            }

            if (requestedArgCount < minRequired)
            {
                Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, classType.Name, parameters.Length, requestedArgCount);
                return new BoundErrorExpression(syntax);
            }
        }
        else if (requestedArgCount > parameters.Length)
        {
            Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, classType.Name, parameters.Length, requestedArgCount);
            return new BoundErrorExpression(syntax);
        }

        // Issue #343: reorder into parameter order when the call mixes
        // positional and named arguments. ADR-0063: also slot defaults for
        // unsupplied optional parameters.
        ExpressionSyntax[] parameterSyntax;
        var boundArguments = boundArgumentsBuilder;
        if (ctorIsVariadic)
        {
            parameterSyntax = new ExpressionSyntax[syntax.Arguments.Count];
            for (var i = 0; i < syntax.Arguments.Count; i++)
            {
                parameterSyntax[i] = syntax.Arguments[i];
            }

            // Pack or pass-through the trailing arguments into a single
            // slice-typed argument so the per-position conversion loop
            // below sees exactly `parameters.Length` arguments.
            var variadicParam = parameters[parameters.Length - 1];

            // Issue #1214: use the (possibly type-argument-substituted) slice
            // type so a generic variadic init (`init(xs ...T)` on `Box[int32]`)
            // packs into `[]int32`, matching the concrete argument types.
            var sliceType = (SliceTypeSymbol)effectiveParamTypes[parameters.Length - 1];
            var trailingCount = requestedArgCount - fixedCtorParamCount;
            var passThrough = trailingCount == 1
                && boundArguments[fixedCtorParamCount].Type == sliceType;

            if (!passThrough)
            {
                // Issue #1630: pack the trailing arguments through the
                // canonical helper (applies #1493 element coercion).
                var hasVariadicErrors = false;
                var packedArgs = PackOrPassThroughVariadicArguments(
                    conversions,
                    Diagnostics,
                    syntax,
                    boundArguments.ToImmutable(),
                    fixedCtorParamCount,
                    sliceType,
                    variadicParam.Name,
                    i => parameterSyntax[i].Location,
                    ref hasVariadicErrors);

                if (hasVariadicErrors)
                {
                    return new BoundErrorExpression(syntax);
                }

                boundArguments = packedArgs.ToBuilder();

                var newSyntax = new ExpressionSyntax[parameters.Length];
                for (var i = 0; i < fixedCtorParamCount; i++)
                {
                    newSyntax[i] = parameterSyntax[i];
                }

                newSyntax[fixedCtorParamCount] = parameterSyntax.Length > fixedCtorParamCount
                    ? parameterSyntax[fixedCtorParamCount]
                    : (syntax.Arguments.Count > 0 ? syntax.Arguments[syntax.Arguments.Count - 1] : null);
                parameterSyntax = newSyntax;
            }
        }
        else if (!argumentNames.IsDefault || requestedArgCount < parameters.Length)
        {
            if (!TryReorderUserCallArgumentsWithDefaults(
                    syntax.Arguments,
                    boundArguments.ToImmutable(),
                    parameters,
                    classType.Name,
                    syntax.Identifier.Location,
                    out parameterSyntax,
                    out var permutedBound))
            {
                return new BoundErrorExpression(syntax);
            }

            boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(permutedBound.Length);
            for (var i = 0; i < permutedBound.Length; i++)
            {
                boundArguments.Add(permutedBound[i]);
            }
        }
        else
        {
            parameterSyntax = new ExpressionSyntax[syntax.Arguments.Count];
            for (var i = 0; i < syntax.Arguments.Count; i++)
            {
                parameterSyntax[i] = syntax.Arguments[i];
            }
        }

        var hasErrors = false;
        var convertedArguments = ImmutableArray.CreateBuilder<BoundExpression>(parameters.Length);
        for (var i = 0; i < parameters.Length; i++)
        {
            var argument = boundArguments[i];
            var parameter = parameters[i];

            // Issue #1238: re-bind a deferred target-typed conditional argument
            // against the constructor parameter type before the convertibility
            // checks below.
            boundArguments[i] = argument = FinalizeBranchyArgument(
                argument,
                i < parameterSyntax.Length ? parameterSyntax[i] : null,
                effectiveParamTypes[i]);

            // Issue #1214: target the type-argument-substituted parameter type
            // for a closed generic construction (equal to parameter.Type for a
            // non-generic/open type).
            var paramType = effectiveParamTypes[i];

            // ADR-0055 Tier 4 (#369): re-lower an interpolated-string argument
            // targeting an IFormattable/FormattableString parameter.
            if (i < parameterSyntax.Length
                && parameterSyntax[i] != null
                && parameterSyntax[i] is InterpolatedStringExpressionSyntax interpolatedCtorArg
                && isFormattableStringTargetType(paramType))
            {
                convertedArguments.Add(bindInterpolatedStringAsFormattable(interpolatedCtorArg, paramType));
                continue;
            }

            // ADR-0060: when the constructor parameter is ref-kind, the bound
            // argument is a BoundAddressOfExpression of type *T; bypass the
            // standard convertibility check so the address is forwarded as-is.
            // ADR-0061: BoundConditionalAddressExpression is the analogous
            // shape for conditional ref-arguments.
            if (parameter.RefKind != RefKind.None && argument is BoundAddressOfExpression addrCtor)
            {
                var pointee = addrCtor.Operand?.Type;
                if (pointee == paramType || pointee == TypeSymbol.Error || paramType == TypeSymbol.Error)
                {
                    convertedArguments.Add(argument);
                    continue;
                }
            }
            else if (parameter.RefKind != RefKind.None && argument is BoundConditionalAddressExpression condAddrCtor)
            {
                var pointee = condAddrCtor.PointeeType;
                if (pointee == paramType || pointee == TypeSymbol.Error || paramType == TypeSymbol.Error)
                {
                    convertedArguments.Add(argument);
                    continue;
                }
            }

            var argLocation = i < parameterSyntax.Length && parameterSyntax[i] != null
                ? parameterSyntax[i].Location
                : syntax.Identifier.Location;

            // Issue #2069: force the wrap for a func/arrow literal argument
            // flowing into a NAMED delegate parameter — see the matching
            // comment above (constructor-argument path) for the full
            // rationale. Without it, the general implicit-conversion fast
            // path below leaves the literal unwrapped and it materialises
            // against its natural Action/Func shape instead of the named
            // delegate's own TypeDef.
            if (paramType is DelegateTypeSymbol namedDelegateParamTarget
                && argument.Type is FunctionTypeSymbol
                && !ReferenceEquals(argument.Type, namedDelegateParamTarget))
            {
                convertedArguments.Add(conversions.BindConversion(argLocation, argument, paramType));
                continue;
            }

            if (argument.Type != paramType
                && !Conversion.Classify(argument.Type, paramType).IsImplicit)
            {
                if (TryConvertLiteralArgumentToExpressionTree(argument, paramType, argLocation, out var expressionTreeArg))
                {
                    convertedArguments.Add(expressionTreeArg);
                    continue;
                }

                // Issue #889: arrow/func literal → void-returning delegate.
                if (TryConvertLiteralArgumentToVoidDelegate(argument, paramType, argLocation, out var voidDelegateArg))
                {
                    convertedArguments.Add(voidDelegateArg);
                    continue;
                }

                // Issue #1281: implicit constant-expression narrowing argument.
                if (TryBindConstantNarrowingArgument(argument, paramType, argLocation, out var narrowedArg))
                {
                    convertedArguments.Add(narrowedArg);
                    continue;
                }

                if (conversions.TryApplyUserDefinedImplicitArgumentConversion(argument, paramType, out var convertedArg))
                {
                    convertedArguments.Add(convertedArg);
                    continue;
                }

                if (argument.Type != TypeSymbol.Error)
                {
                    Diagnostics.ReportWrongArgumentType(argLocation, parameter.Name, paramType, argument.Type);
                }

                hasErrors = true;
                convertedArguments.Add(argument);
            }
            else
            {
                convertedArguments.Add(conversions.BindConversion(argLocation, argument, paramType));
            }
        }

        if (hasErrors)
        {
            return new BoundErrorExpression(syntax);
        }

        // Issue #2067: enforce `protected`/`private` on an explicit `init(...)`
        // constructor the same way BindUserInstanceCall enforces it on regular
        // method calls (issue #2058) — a separate binder path resolves
        // constructor calls, so it needs its own accessibility gate.
        if (selectedCtor.DeclaringType is StructSymbol ctorDeclaringType
            && !AccessibilityChecker.IsAccessible(selectedCtor.Function.Accessibility, ctorDeclaringType, getCurrentFunction()))
        {
            Diagnostics.ReportMemberInaccessible(syntax.Identifier.Location, "init", ctorDeclaringType.Name, selectedCtor.Function.Accessibility);
        }

        return new BoundConstructorCallExpression(syntax, classType, convertedArguments.ToImmutable(), selectedCtor);
    }

    /// <summary>
    /// Issue #1214: closes a generic class that declares an explicit
    /// <c>init(...)</c> constructor for a construction call <c>Box[int32](args)</c>.
    /// Resolves the type arguments — taken from an explicit <c>[…]</c> list or
    /// inferred from the value arguments against the constructor's parameter
    /// list (first-seen-wins, mirroring the primary-constructor path in
    /// <see cref="BindConstructorCallExpression"/>) — validates the arity and
    /// constraints, then yields the constructed closed <see cref="StructSymbol"/>.
    /// Returns <see langword="false"/> after reporting a diagnostic when the type
    /// arguments cannot be resolved.
    /// </summary>
    private bool TryCloseGenericExplicitConstructorType(
        CallExpressionSyntax syntax,
        StructSymbol classType,
        out StructSymbol constructed)
    {
        constructed = classType;

        if (!classType.IsGenericDefinition)
        {
            // A type-argument list on a non-generic class is a usage error.
            if (syntax.TypeArgumentList != null)
            {
                Diagnostics.ReportWrongTypeArgumentCount(syntax.TypeArgumentList.Location, classType.Name, 0, syntax.TypeArgumentList.Arguments.Count);
                return false;
            }

            return true;
        }

        var tps = classType.TypeParameters;
        var substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
        if (syntax.TypeArgumentList != null)
        {
            var explicitArgs = syntax.TypeArgumentList.Arguments;
            if (explicitArgs.Count != tps.Length)
            {
                Diagnostics.ReportWrongTypeArgumentCount(syntax.TypeArgumentList.Location, classType.Name, tps.Length, explicitArgs.Count);
                return false;
            }

            for (var i = 0; i < explicitArgs.Count; i++)
            {
                var ta = bindTypeClause(explicitArgs[i]);
                if (ta == null)
                {
                    return false;
                }

                substitution[tps[i]] = ta;
            }
        }
        else
        {
            // Infer the type arguments from the value arguments against the
            // (first) explicit constructor's parameter list. The open-definition
            // constructor parameter types reference the class type parameters,
            // so binding each argument and unifying drives inference.
            //
            // Issue #1629: this is a throwaway probe — BindExplicitConstructorCallExpression
            // re-binds the same argument syntax for real once the closed type is
            // known. Roll back any diagnostics the probe produced so they are
            // reported exactly once, by the real bind.
            var inferenceDiagMark = Diagnostics.Count;

            var ctorOverloads = classType.EffectiveExplicitConstructors;
            var ctorParams = ctorOverloads.IsDefaultOrEmpty
                ? ImmutableArray<ParameterSymbol>.Empty
                : ctorOverloads[0].Parameters;

            for (var i = 0; i < syntax.Arguments.Count && i < ctorParams.Length; i++)
            {
                var argSyntax = UnwrapNamedArgumentValue(syntax.Arguments[i]);
                var preBound = bindExpression(argSyntax);
                inferTypeArguments(ctorParams[i].Type, preBound.Type, substitution);
            }

            Diagnostics.TruncateTo(inferenceDiagMark);

            foreach (var tp in tps)
            {
                if (!substitution.ContainsKey(tp))
                {
                    Diagnostics.ReportTypeArgumentInferenceFailed(syntax.Identifier.Location, classType.Name, tp.Name);
                    return false;
                }
            }
        }

        var constraintLocation = syntax.TypeArgumentList != null
            ? syntax.TypeArgumentList.Location
            : syntax.Identifier.Location;
        foreach (var tp in tps)
        {
            var typeArg = substitution[tp];
            if (!satisfiesConstraint(typeArg, tp))
            {
                Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(constraintLocation, tp.Name, typeArg, describeConstraint(tp));
                return false;
            }
        }

        var typeArgs = ImmutableArray.CreateBuilder<TypeSymbol>(tps.Length);
        foreach (var tp in tps)
        {
            typeArgs.Add(substitution[tp]);
        }

        constructed = StructSymbol.Construct(classType, typeArgs.MoveToImmutable(), MapClrType);
        return true;
    }

    /// <summary>
    /// ADR-0065 §2: binds a bare <c>init(args)</c> self-delegation call inside a
    /// constructor body. The selected sibling constructor must be a different
    /// member of the same class's <see cref="StructSymbol.ExplicitConstructors"/>
    /// overload set. Designated initializers may not chain to a sibling; only
    /// <c>convenience init</c> bodies may issue an <c>init(args)</c> self-delegation.
    /// </summary>
    private BoundExpression BindConstructorChainingExpression(CallExpressionSyntax syntax, StructSymbol owningClass, FunctionSymbol currentCtorFunction)
    {
        // Resolve the current ConstructorSymbol so we know whether the caller
        // is convenience or designated, and so we can exclude it from the
        // candidate set (recursion would loop indefinitely).
        ConstructorSymbol currentCtor = null;
        foreach (var c in owningClass.ExplicitConstructors)
        {
            if (ReferenceEquals(c.Function, currentCtorFunction))
            {
                currentCtor = c;
                break;
            }
        }

        if (currentCtor == null)
        {
            Diagnostics.ReportInitDelegationOutsideCtor(syntax.Identifier.Location);
            return new BoundErrorExpression(syntax);
        }

        if (!currentCtor.IsConvenience)
        {
            Diagnostics.ReportInitDelegationFromDesignated(syntax.Identifier.Location, owningClass.Name);
            return new BoundErrorExpression(syntax);
        }

        // Build the candidate overload set: every sibling explicit constructor
        // except the one currently being bound.
        var siblingBuilder = ImmutableArray.CreateBuilder<ConstructorSymbol>(owningClass.ExplicitConstructors.Length);
        foreach (var c in owningClass.ExplicitConstructors)
        {
            if (ReferenceEquals(c, currentCtor))
            {
                continue;
            }

            siblingBuilder.Add(c);
        }

        if (siblingBuilder.Count == 0)
        {
            Diagnostics.ReportInitDelegationRecursive(syntax.Identifier.Location, owningClass.Name);
            return new BoundErrorExpression(syntax);
        }

        if (!TryAnalyzeCallArgumentLayout(syntax.Arguments, out _, out var argumentNames))
        {
            return new BoundErrorExpression(syntax);
        }

        var boundArgsBuilder = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
        for (var i = 0; i < syntax.Arguments.Count; i++)
        {
            var argument = UnwrapNamedArgumentValue(syntax.Arguments[i]);
            ParameterSymbol parameterForArg = null;
            if (siblingBuilder.Count == 1 && i < siblingBuilder[0].Parameters.Length)
            {
                parameterForArg = siblingBuilder[0].Parameters[i];
            }

            if (argument is RefArgumentExpressionSyntax refArg)
            {
                boundArgsBuilder.Add(bindRefArgumentExpression(refArg, parameterForArg));
            }
            else
            {
                boundArgsBuilder.Add(bindExpression(argument));
            }
        }

        ConstructorSymbol selectedCtor;
        if (siblingBuilder.Count == 1)
        {
            selectedCtor = siblingBuilder[0];
        }
        else
        {
            var ctorFunctions = ImmutableArray.CreateBuilder<FunctionSymbol>(siblingBuilder.Count);
            foreach (var c in siblingBuilder)
            {
                ctorFunctions.Add(c.Function);
            }

            var selectedFn = SelectBestInstanceOverload(
                ctorFunctions.MoveToImmutable(),
                syntax.Arguments.Count,
                argumentNames,
                boundArgsBuilder.ToImmutable(),
                out var ambiguous,
                out var nullSafetyFailure);

            if (selectedFn == null)
            {
                if (nullSafetyFailure != null)
                {
                    var argLoc = nullSafetyFailure.Index < syntax.Arguments.Count
                        ? syntax.Arguments[nullSafetyFailure.Index].Location
                        : syntax.Identifier.Location;
                    Diagnostics.ReportWrongArgumentType(argLoc, nullSafetyFailure.ParamName, nullSafetyFailure.ParamType, nullSafetyFailure.ArgType);
                }
                else if (ambiguous)
                {
                    Diagnostics.ReportAmbiguousOverloadResolution(syntax.Identifier.Location, "init");
                }
                else
                {
                    Diagnostics.ReportInitDelegationNoMatch(syntax.Identifier.Location, owningClass.Name);
                }

                return new BoundErrorExpression(syntax);
            }

            selectedCtor = null;
            foreach (var c in siblingBuilder)
            {
                if (ReferenceEquals(c.Function, selectedFn))
                {
                    selectedCtor = c;
                    break;
                }
            }

            if (selectedCtor == null)
            {
                Diagnostics.ReportInitDelegationNoMatch(syntax.Identifier.Location, owningClass.Name);
                return new BoundErrorExpression(syntax);
            }
        }

        var parameters = selectedCtor.Parameters;
        var requestedArgCount = syntax.Arguments.Count;
        if (requestedArgCount < parameters.Length)
        {
            var minRequired = parameters.Length;
            for (var i = parameters.Length - 1; i >= 0; i--)
            {
                if (parameters[i].HasExplicitDefaultValue)
                {
                    minRequired = i;
                }
                else
                {
                    break;
                }
            }

            if (requestedArgCount < minRequired)
            {
                Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, "init", parameters.Length, requestedArgCount);
                return new BoundErrorExpression(syntax);
            }
        }
        else if (requestedArgCount > parameters.Length)
        {
            Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, "init", parameters.Length, requestedArgCount);
            return new BoundErrorExpression(syntax);
        }

        ExpressionSyntax[] parameterSyntax;
        var boundArgs = boundArgsBuilder;
        if (!argumentNames.IsDefault || requestedArgCount < parameters.Length)
        {
            if (!TryReorderUserCallArgumentsWithDefaults(
                    syntax.Arguments,
                    boundArgs.ToImmutable(),
                    parameters,
                    "init",
                    syntax.Identifier.Location,
                    out parameterSyntax,
                    out var permutedBound))
            {
                return new BoundErrorExpression(syntax);
            }

            boundArgs = ImmutableArray.CreateBuilder<BoundExpression>(permutedBound.Length);
            for (var i = 0; i < permutedBound.Length; i++)
            {
                boundArgs.Add(permutedBound[i]);
            }
        }
        else
        {
            parameterSyntax = new ExpressionSyntax[syntax.Arguments.Count];
            for (var i = 0; i < syntax.Arguments.Count; i++)
            {
                parameterSyntax[i] = syntax.Arguments[i];
            }
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(parameters.Length);
        var hadErrors = false;
        for (var i = 0; i < parameters.Length; i++)
        {
            var parameter = parameters[i];
            var argument = boundArgs[i];
            var argLocation = parameterSyntax[i]?.Location ?? syntax.Identifier.Location;

            // Issue #1238: re-bind a deferred target-typed conditional argument
            // against the constructor parameter type before the error/convert
            // checks below.
            argument = FinalizeBranchyArgument(
                argument,
                i < parameterSyntax.Length ? parameterSyntax[i] : null,
                parameter.Type);

            if (argument.Type == TypeSymbol.Error)
            {
                hadErrors = true;
                convertedArgs.Add(argument);
                continue;
            }

            // ADR-0060: when the parameter is ref-kind, the bound argument is
            // a BoundAddressOfExpression of type *T; bypass the standard
            // convertibility check so the address is forwarded as-is.
            if (parameter.RefKind != RefKind.None && argument is BoundAddressOfExpression addrInit)
            {
                var pointee = addrInit.Operand?.Type;
                if (pointee == parameter.Type || pointee == TypeSymbol.Error || parameter.Type == TypeSymbol.Error)
                {
                    convertedArgs.Add(argument);
                    continue;
                }
            }
            else if (parameter.RefKind != RefKind.None && argument is BoundConditionalAddressExpression condAddrInit)
            {
                var pointee = condAddrInit.PointeeType;
                if (pointee == parameter.Type || pointee == TypeSymbol.Error || parameter.Type == TypeSymbol.Error)
                {
                    convertedArgs.Add(argument);
                    continue;
                }
            }

            // Issue #2069: force the wrap for a func/arrow literal argument
            // flowing into a NAMED delegate parameter — see the matching
            // comment at the constructor-argument path (above in this file)
            // for the full rationale.
            if (parameter.Type is DelegateTypeSymbol namedDelegateInitTarget
                && argument.Type is FunctionTypeSymbol
                && !ReferenceEquals(argument.Type, namedDelegateInitTarget))
            {
                convertedArgs.Add(conversions.BindConversion(argLocation, argument, parameter.Type));
                continue;
            }

            if (argument.Type != parameter.Type
                && !Conversion.Classify(argument.Type, parameter.Type).IsImplicit)
            {
                if (TryConvertLiteralArgumentToExpressionTree(argument, parameter.Type, argLocation, out var expressionTreeArg))
                {
                    convertedArgs.Add(expressionTreeArg);
                    continue;
                }

                // Issue #889: arrow/func literal → void-returning delegate.
                if (TryConvertLiteralArgumentToVoidDelegate(argument, parameter.Type, argLocation, out var voidDelegateArg))
                {
                    convertedArgs.Add(voidDelegateArg);
                    continue;
                }

                // Issue #1281: implicit constant-expression narrowing argument.
                if (TryBindConstantNarrowingArgument(argument, parameter.Type, argLocation, out var narrowedArg))
                {
                    convertedArgs.Add(narrowedArg);
                    continue;
                }

                if (conversions.TryApplyUserDefinedImplicitArgumentConversion(argument, parameter.Type, out var convertedArg))
                {
                    convertedArgs.Add(convertedArg);
                    continue;
                }

                if (argument.Type != TypeSymbol.Error)
                {
                    Diagnostics.ReportWrongArgumentType(argLocation, parameter.Name, parameter.Type, argument.Type);
                }

                hadErrors = true;
                convertedArgs.Add(argument);
            }
            else
            {
                convertedArgs.Add(conversions.BindConversion(argLocation, argument, parameter.Type));
            }
        }

        if (hadErrors)
        {
            return new BoundErrorExpression(syntax);
        }

        return new BoundConstructorChainingExpression(syntax, selectedCtor, convertedArgs.ToImmutable());
    }

    /// <summary>
    /// ADR-0063 §9: variant of <c>TryReorderUserCallArguments</c> for constructor
    /// calls that may omit trailing or middle optional parameters. For each
    /// parameter slot not filled by a positional/named argument we synthesize a
    /// default-value bound expression from the parameter symbol.
    /// </summary>
    private bool TryReorderUserCallArgumentsWithDefaults(
        SeparatedSyntaxList<ExpressionSyntax> rawArguments,
        ImmutableArray<BoundExpression> boundPositionalAndNamed,
        ImmutableArray<ParameterSymbol> parameters,
        string callableName,
        TextLocation diagnosticLocation,
        out ExpressionSyntax[] parameterSyntax,
        out ImmutableArray<BoundExpression> permutedBound)
    {
        parameterSyntax = new ExpressionSyntax[parameters.Length];
        var slotted = new BoundExpression[parameters.Length];
        var filled = new bool[parameters.Length];

        var firstNamedIndex = -1;
        for (var i = 0; i < rawArguments.Count; i++)
        {
            if (rawArguments[i] is NamedArgumentExpressionSyntax)
            {
                firstNamedIndex = i;
                break;
            }
        }

        var positionalCount = firstNamedIndex >= 0 ? firstNamedIndex : rawArguments.Count;
        if (positionalCount > parameters.Length)
        {
            Diagnostics.ReportWrongArgumentCount(diagnosticLocation, callableName, parameters.Length, rawArguments.Count);
            permutedBound = ImmutableArray<BoundExpression>.Empty;
            return false;
        }

        for (var i = 0; i < positionalCount; i++)
        {
            slotted[i] = boundPositionalAndNamed[i];
            filled[i] = true;
            parameterSyntax[i] = rawArguments[i];
        }

        for (var i = positionalCount; i < rawArguments.Count; i++)
        {
            if (rawArguments[i] is not NamedArgumentExpressionSyntax named)
            {
                Diagnostics.ReportPositionalArgumentAfterNamedArgument(rawArguments[i].Location);
                permutedBound = ImmutableArray<BoundExpression>.Empty;
                return false;
            }

            var name = named.NameToken.Text;
            var matched = false;
            for (var p = 0; p < parameters.Length; p++)
            {
                if (parameters[p].Name == name)
                {
                    if (filled[p])
                    {
                        Diagnostics.ReportDuplicateNamedArgument(named.NameToken.Location, name);
                        permutedBound = ImmutableArray<BoundExpression>.Empty;
                        return false;
                    }

                    slotted[p] = boundPositionalAndNamed[i];
                    filled[p] = true;
                    parameterSyntax[p] = rawArguments[i];
                    matched = true;
                    break;
                }
            }

            if (!matched)
            {
                Diagnostics.ReportNamedArgumentParameterNotFound(named.NameToken.Location, callableName, name);
                permutedBound = ImmutableArray<BoundExpression>.Empty;
                return false;
            }
        }

        for (var i = 0; i < parameters.Length; i++)
        {
            if (filled[i])
            {
                continue;
            }

            if (!parameters[i].HasExplicitDefaultValue)
            {
                Diagnostics.ReportWrongArgumentCount(diagnosticLocation, callableName, parameters.Length, rawArguments.Count);
                permutedBound = ImmutableArray<BoundExpression>.Empty;
                return false;
            }

            slotted[i] = CreateOptionalUserDefaultArgument(parameters[i]);
        }

        permutedBound = ImmutableArray.Create(slotted);
        return true;
    }
}
