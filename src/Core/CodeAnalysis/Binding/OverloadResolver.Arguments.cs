// <copyright file="OverloadResolver.Arguments.cs" company="GSharp">
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
    /// <summary>
    /// Issue #506: synthesises C#-style <c>params T[]</c> expansion for a CLR
    /// call site that won overload resolution in expanded form. The trailing
    /// positional arguments (those mapped to the final <c>params</c> parameter)
    /// are individually converted to the element type and packed into a
    /// <see cref="BoundArrayCreationExpression"/>; the returned argument list
    /// has length equal to <paramref name="parameters"/>.Length so the
    /// remaining call-binding pipeline (handler rewrite, ref-kind validation,
    /// ordered-mapping fill) treats the call uniformly with normal-form calls.
    /// </summary>
    /// <param name="arguments">The source-order bound arguments. Includes a synthesised receiver slot for imported extension calls; the receiver always sits at the leading parameter positions, never the params slot.</param>
    /// <param name="parameters">The resolved method's parameter list.</param>
    /// <param name="callSyntax">The originating call expression; used to surface conversion diagnostics for individual variadic elements when present.</param>
    /// <param name="receiverArgCount">The number of leading argument slots reserved for a synthesised receiver (0 for plain calls, 1 for imported extension calls).</param>
    /// <param name="parameterMapping">Issue #506 follow-up: when non-default, the source-order mapping from each input argument to its parameter slot, as produced by overload resolution for calls combining named arguments with expanded <c>params</c> form. Causes the expander to emit arguments already in parameter order with optional slots filled by their defaults.</param>
    /// <param name="symbolicMethodTypeArgs">The real symbolic method type arguments when reflection used erased placeholders to close the selected generic method.</param>
    /// <returns>An argument list of length <paramref name="parameters"/>.Length whose final element is the packed array.</returns>
    public ImmutableArray<BoundExpression> ExpandParamsArguments(
        ImmutableArray<BoundExpression> arguments,
        System.Reflection.ParameterInfo[] parameters,
        CallExpressionSyntax callSyntax,
        int receiverArgCount = 0,
        ImmutableArray<int> parameterMapping = default,
        ImmutableArray<TypeSymbol> symbolicMethodTypeArgs = default)
    {
        var paramsIndex = parameters.Length - 1;
        var paramArrayType = parameters[paramsIndex].ParameterType;
        var elementClrType = paramArrayType.GetElementType();
        var elementTypeSymbol = elementClrType == null
            ? TypeSymbol.Object
            : TypeSymbol.FromClrType(elementClrType);
        if (!symbolicMethodTypeArgs.IsDefaultOrEmpty
            && parameters[paramsIndex].Member is MethodInfo method
            && method.IsGenericMethod)
        {
            var openMethod = method.IsGenericMethodDefinition
                ? method
                : method.GetGenericMethodDefinition();
            var openParameters = openMethod.GetParameters();
            var openElementType = openParameters[paramsIndex].ParameterType.GetElementType();
            if (openElementType != null)
            {
                var symbolicElementType = MemberLookup.MapOpenClrTypeToSymbolic(
                    openElementType,
                    openDefinition: null,
                    typeArguments: default,
                    openMethodDefinition: openMethod,
                    methodTypeArguments: symbolicMethodTypeArgs);
                if (TypeSymbol.RequiresSymbolicProjection(symbolicElementType))
                {
                    elementTypeSymbol = symbolicElementType;
                }
            }
        }

        var sliceType = SliceTypeSymbol.Get(elementTypeSymbol);

        // Issue #506 follow-up: when a parameter mapping is supplied (named
        // arguments combined with `params` expansion) the input arguments are
        // in source order and may bind to any non-params parameter; the source
        // positions that map to the params slot must be packed. The result is
        // built in parameter order so the downstream binding pipeline can drop
        // its own reorder step.
        if (!parameterMapping.IsDefault)
        {
            var ordered = new BoundExpression[parameters.Length];
            var paramsElementBuilder = ImmutableArray.CreateBuilder<BoundExpression>();
            var paramsSourceIndices = new List<int>();
            for (var i = 0; i < arguments.Length; i++)
            {
                var slot = parameterMapping[i];
                if (slot == paramsIndex)
                {
                    paramsSourceIndices.Add(i);
                }
                else
                {
                    ordered[slot] = arguments[i];
                }
            }

            foreach (var sourceIndex in paramsSourceIndices)
            {
                paramsElementBuilder.Add(ConvertParamsElement(arguments[sourceIndex], elementTypeSymbol, callSyntax, sourceIndex, receiverArgCount));
            }

            ordered[paramsIndex] = new BoundArrayCreationExpression(callSyntax, sliceType, paramsElementBuilder.ToImmutable());
            for (var i = 0; i < parameters.Length; i++)
            {
                ordered[i] ??= ConversionClassifier.CreateOptionalDefaultArgument(parameters[i]);
            }

            return ImmutableArray.Create(ordered);
        }

        var fixedCount = paramsIndex;
        var suppliedFixedCount = Math.Min(arguments.Length, fixedCount);
        var tailCount = Math.Max(0, arguments.Length - fixedCount);

        var packed = ImmutableArray.CreateBuilder<BoundExpression>(tailCount);
        for (var i = 0; i < tailCount; i++)
        {
            var sourceIndex = fixedCount + i;
            packed.Add(ConvertParamsElement(arguments[sourceIndex], elementTypeSymbol, callSyntax, sourceIndex, receiverArgCount));
        }

        var arrayExpr = new BoundArrayCreationExpression(callSyntax, sliceType, packed.MoveToImmutable());

        var result = ImmutableArray.CreateBuilder<BoundExpression>(parameters.Length);
        for (var i = 0; i < suppliedFixedCount; i++)
        {
            result.Add(arguments[i]);
        }

        for (var i = suppliedFixedCount; i < fixedCount; i++)
        {
            result.Add(ConversionClassifier.CreateOptionalDefaultArgument(parameters[i]));
        }

        result.Add(arrayExpr);
        return result.MoveToImmutable();
    }

    /// <summary>
    /// Issue #506: converts a single positional argument intended for a
    /// <c>params T[]</c> element slot to the element type, threading the
    /// originating source location for diagnostic reporting.
    /// </summary>
    private BoundExpression ConvertParamsElement(BoundExpression arg, TypeSymbol elementTypeSymbol, CallExpressionSyntax callSyntax, int sourceIndex, int receiverArgCount)
    {
        if (arg.Type == null || arg.Type == TypeSymbol.Error || arg.Type == elementTypeSymbol)
        {
            return arg;
        }

        if (Conversion.Classify(arg.Type, elementTypeSymbol).Exists)
        {
            var conversionSyntaxIndex = sourceIndex - receiverArgCount;
            TextLocation location;
            if (callSyntax != null
                && conversionSyntaxIndex >= 0
                && conversionSyntaxIndex < callSyntax.Arguments.Count)
            {
                location = callSyntax.Arguments[conversionSyntaxIndex].Location;
            }
            else
            {
                location = callSyntax?.Location ?? default;
            }

            return conversions.BindConversion(location, arg, elementTypeSymbol, allowExplicit: true);
        }

        if (conversions.TryApplyUserDefinedImplicitArgumentConversion(arg, elementTypeSymbol, out var udc))
        {
            return udc;
        }

        var diagnosticIndex = sourceIndex - receiverArgCount;
        var diagnosticLocation = callSyntax != null
            && diagnosticIndex >= 0
            && diagnosticIndex < callSyntax.Arguments.Count
                ? callSyntax.Arguments[diagnosticIndex].Location
                : callSyntax?.Location ?? default;
        return conversions.BindConversion(diagnosticLocation, arg, elementTypeSymbol);
    }

    /// <summary>
    /// Issue #1493: coerces a single trailing argument bound for a G# variadic
    /// (<c>...T</c>) element slot to the variadic element type, applying the same
    /// implicit conversions a fixed parameter of that type would accept —
    /// reference upcast, interface conversion, tuple-element conversions, nullable
    /// lifting, implicit constant narrowing, and user-defined implicit conversions.
    /// Returns the (possibly conversion-wrapped) argument so the emitter packs the
    /// element with the variadic element type rather than the argument's static
    /// type; reports GS0154 and sets <paramref name="hasErrors"/> when no implicit
    /// conversion exists. This keeps overload applicability and final coercion in
    /// agreement with the non-variadic / array-literal element paths.
    /// </summary>
    internal static BoundExpression CoerceVariadicElement(
        ConversionClassifier conversions,
        DiagnosticBag diagnostics,
        BoundExpression argument,
        TypeSymbol elementType,
        TextLocation location,
        string parameterName,
        ref bool hasErrors)
    {
        var argType = argument.Type;

        // Unknown/error argument, or an open (unsubstituted) element type whose
        // members are erased: leave the argument untouched. Open element types
        // follow the type-erased model where the emitter boxes as needed.
        if (argType == null || argType == TypeSymbol.Error || elementType is TypeParameterSymbol)
        {
            return argument;
        }

        if (argType == elementType)
        {
            return argument;
        }

        var conversion = Conversion.Classify(argType, elementType);
        if (conversion.Exists && (conversion.IsImplicit || conversion.IsIdentity))
        {
            return conversions.BindConversion(location, argument, elementType);
        }

        if (ExpressionBinder.IsImplicitConstantNarrowingArgument(argument, elementType))
        {
            return conversions.BindConversion(location, argument, elementType);
        }

        if (conversions.TryApplyUserDefinedImplicitArgumentConversion(argument, elementType, out var udc))
        {
            return udc;
        }

        diagnostics.ReportWrongArgumentType(location, parameterName, elementType, argType);
        hasErrors = true;
        return argument;
    }

    /// <summary>
    /// Issue #1630: single canonical implementation of the G# variadic
    /// (<c>...T</c>) call-site pack/pass-through protocol, shared by every
    /// call-binding path that can target a trailing variadic parameter (free
    /// function, instance/extension method, constructor, primary
    /// constructor, function-typed-variable indirect call, named-delegate
    /// direct call). Given the fully-bound argument list and the variadic
    /// parameter's declared (possibly type-argument-substituted) slice type,
    /// decides whether the trailing arguments are a pass-through — a single
    /// argument already typed as the slice itself, mirroring C#'s
    /// <c>params T[]</c> call-site semantics — or must be packed into a fresh
    /// <see cref="BoundArrayCreationExpression"/>. In the pack case, every
    /// trailing element is first run through <see cref="CoerceVariadicElement"/>
    /// (issue #1493) so implicit conversions — numeric widening, interface
    /// upcast, nullable lifting, constant narrowing, user-defined implicit
    /// conversions — are applied to the element before it lands in the slice,
    /// keeping all call paths in agreement (issue #1630: this used to be
    /// duplicated by hand at each call site, and two copies had drifted to
    /// pack raw, uncoerced elements).
    /// </summary>
    /// <param name="conversions">The conversion classifier used to bind per-element coercions; issue #1823 promotes this from an instance field to a parameter so <see cref="ExpressionBinder"/> call sites can share this helper.</param>
    /// <param name="diagnostics">The diagnostic bag that receives GS0154 when an element has no valid conversion; issue #1823 promotes this from an instance property to a parameter for the same reason.</param>
    /// <param name="callSyntax">The syntax node attributed to the packed <see cref="BoundArrayCreationExpression"/> when packing is required.</param>
    /// <param name="boundArguments">The fully-bound, in-order argument list; length must be at least <paramref name="fixedCount"/>.</param>
    /// <param name="fixedCount">The number of leading fixed (non-variadic) parameters.</param>
    /// <param name="sliceType">The (possibly substituted) variadic parameter's slice type.</param>
    /// <param name="parameterName">The variadic parameter's name, surfaced in GS0154 diagnostics for elements with no valid conversion.</param>
    /// <param name="locationAt">Maps a trailing argument's index in <paramref name="boundArguments"/> to the source location used for its conversion diagnostics.</param>
    /// <param name="hasErrors">Set to <see langword="true"/> when any trailing element has no valid conversion to the slice's element type.</param>
    /// <returns>An argument list of length <paramref name="fixedCount"/> + 1 whose final element is either the pass-through argument or the packed array.</returns>
    internal static ImmutableArray<BoundExpression> PackOrPassThroughVariadicArguments(
        ConversionClassifier conversions,
        DiagnosticBag diagnostics,
        SyntaxNode callSyntax,
        ImmutableArray<BoundExpression> boundArguments,
        int fixedCount,
        SliceTypeSymbol sliceType,
        string parameterName,
        Func<int, TextLocation> locationAt,
        ref bool hasErrors)
    {
        var trailingCount = boundArguments.Length - fixedCount;
        var passThrough = trailingCount == 1 && boundArguments[fixedCount].Type == sliceType;

        var result = ImmutableArray.CreateBuilder<BoundExpression>(fixedCount + 1);
        for (var i = 0; i < fixedCount; i++)
        {
            result.Add(boundArguments[i]);
        }

        if (passThrough)
        {
            result.Add(boundArguments[fixedCount]);
            return result.MoveToImmutable();
        }

        var elementType = sliceType.ElementType;
        var packed = ImmutableArray.CreateBuilder<BoundExpression>(trailingCount);
        for (var i = fixedCount; i < boundArguments.Length; i++)
        {
            packed.Add(CoerceVariadicElement(
                conversions,
                diagnostics,
                boundArguments[i],
                elementType,
                locationAt(i),
                parameterName,
                ref hasErrors));
        }

        result.Add(new BoundArrayCreationExpression(callSyntax, sliceType, packed.MoveToImmutable()));
        return result.MoveToImmutable();
    }

    /// <summary>
    /// Issue #1281: C# §10.2.11 implicit constant expression conversion at a call
    /// site. When <paramref name="argument"/> is a constant integer expression
    /// whose value fits the (possibly narrower or cross-sign) integer parameter
    /// type <paramref name="parameterType"/>, re-materialise it as a literal of
    /// exactly that type through <see cref="ConversionClassifier.BindConversion(TextLocation, BoundExpression, TypeSymbol, bool)"/>
    /// — mirroring the declaration/assignment behaviour (ADR-0129) so call sites
    /// accept e.g. <c>f(5)</c> for a <c>uint16</c>/<c>uint32</c> parameter the same
    /// way <c>var x uint16 = 5</c> already does. Returns <see langword="true"/>
    /// (with <paramref name="converted"/> set to the retyped literal) when the rule
    /// applies; otherwise <see langword="false"/> so genuine type-mismatch
    /// diagnostics still fire on the regular path.
    /// </summary>
    private bool TryBindConstantNarrowingArgument(BoundExpression argument, TypeSymbol parameterType, TextLocation location, out BoundExpression converted)
    {
        converted = null;
        if (!ExpressionBinder.IsImplicitConstantNarrowingArgument(argument, parameterType))
        {
            return false;
        }

        converted = conversions.BindConversion(location, argument, parameterType);
        return true;
    }

    /// <summary>
    /// Issue #889: when a <c>func</c>/arrow literal argument has a value-typed
    /// natural return (e.g. <c>() -> called = called + 1</c> inferred as
    /// <c>() -> int32</c>) but the target parameter is a void-returning
    /// delegate (<c>System.Action</c>, a named void delegate, or a
    /// <c>(...) -> void</c> function type), void-ize the literal so its trailing
    /// value is discarded — matching the existing <c>func() { ... }</c>
    /// statement-body behaviour. Returns the converted argument through
    /// <paramref name="result"/> on success. Has no effect for non-literal
    /// arguments or non-void delegate targets, so genuine type-mismatch
    /// diagnostics still fire on the regular path.
    /// </summary>
    private bool TryConvertLiteralArgumentToVoidDelegate(BoundExpression argument, TypeSymbol expectedType, TextLocation location, out BoundExpression result)
    {
        result = null;
        if (expectedType == null
            || !tryGetFunctionLiteral(argument, out var literal)
            || literal.FunctionType is not FunctionTypeSymbol literalFnType
            || literalFnType.ReturnType == TypeSymbol.Void
            || literalFnType.ReturnType == TypeSymbol.Error
            || !MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(expectedType, out var targetFnType)
            || targetFnType.ReturnType != TypeSymbol.Void
            || targetFnType.Arity != literalFnType.Arity)
        {
            return false;
        }

        var converted = conversions.BindConversion(location, literal, expectedType);
        if (converted is BoundErrorExpression)
        {
            return false;
        }

        result = converted;
        return true;
    }

    private bool TryConvertLiteralArgumentToExpressionTree(BoundExpression argument, TypeSymbol expectedType, TextLocation location, out BoundExpression result)
    {
        result = null;
        if (expectedType == null
            || !tryGetFunctionLiteral(argument, out var literal)
            || !MemberLookup.TryGetExpressionTreeDelegateTypeFromSymbol(expectedType, out _))
        {
            return false;
        }

        var converted = conversions.BindConversion(location, literal, expectedType);
        if (converted is BoundErrorExpression)
        {
            return false;
        }

        result = converted;
        return true;
    }

    /// <summary>
    /// ADR-0063: synthesizes a bound default-value argument for a user-defined
    /// optional parameter. The default is a CLR-Constant-table representable
    /// primitive/string previously captured on the parameter symbol; <c>nil</c>
    /// becomes a <see cref="BoundDefaultExpression"/>.
    /// </summary>
    /// <param name="parameter">The omitted optional parameter.</param>
    /// <returns>The bound default-value argument for the omitted slot.</returns>
    internal static BoundExpression CreateOptionalUserDefaultArgument(ParameterSymbol parameter)
    {
        if (!parameter.HasExplicitDefaultValue)
        {
            return new BoundDefaultExpression(null, parameter.Type);
        }

        var v = parameter.ExplicitDefaultValue;
        if (v == null)
        {
            return new BoundDefaultExpression(null, parameter.Type);
        }

        return new BoundLiteralExpression(null, v, parameter.Type);
    }

    /// <summary>
    /// Issue #343: returns the underlying value expression for a call-argument
    /// node. When the node is a <see cref="NamedArgumentExpressionSyntax"/>
    /// wrapper (e.g. <c>x: 1</c>), unwraps to the inner value expression so the
    /// argument is bound and post-processed against its actual payload.
    /// </summary>
    /// <param name="argument">The call-argument syntax node.</param>
    /// <returns>The wrapped value expression when named, otherwise the node itself.</returns>
    public static ExpressionSyntax UnwrapNamedArgumentValue(ExpressionSyntax argument)
        => argument is NamedArgumentExpressionSyntax named ? named.Expression : argument;

    /// <summary>
    /// Issue #1238: eagerly binds a (named-argument-unwrapped) call/constructor
    /// argument value. When the argument is a target-typeable branchy
    /// expression (<c>if</c>/<c>else</c>, ternary, or <c>switch</c>-expression)
    /// the <see cref="BinderContext.DeferTargetlessConditional"/> flag is set so
    /// a no-common-type unification failure is deferred (the binder returns a
    /// placeholder retaining the syntax) instead of being reported prematurely
    /// without the parameter's target type. The deferred placeholder is later
    /// re-bound by <c>FinalizeBranchyArgument</c> (or centrally by
    /// <c>ConversionClassifier.BindConversion</c>) once the applicable
    /// parameter type is known.
    /// </summary>
    /// <param name="inner">The unwrapped argument value syntax.</param>
    /// <returns>The eagerly-bound argument (a deferred placeholder when a
    /// branchy argument could not unify without a target).</returns>
    private BoundExpression BindOverloadArgumentValue(ExpressionSyntax inner)
    {
        if (!ExpressionBinder.IsTargetTypedBranchyArgumentSyntax(inner))
        {
            return bindExpression(inner);
        }

        var previous = binderCtx.DeferTargetlessConditional;
        binderCtx.DeferTargetlessConditional = true;
        try
        {
            return bindExpression(inner);
        }
        finally
        {
            binderCtx.DeferTargetlessConditional = previous;
        }
    }

    /// <summary>
    /// Issue #1238: finalizes a deferred branchy-argument placeholder (produced
    /// by <see cref="BindOverloadArgumentValue"/>) once the resolved parameter
    /// type is known. The retained branchy syntax is re-bound with
    /// <paramref name="expectedType"/> as its target so each branch is
    /// target-typed (e.g. a <c>nil</c> arm widens to the parameter's nullable
    /// type). When no usable target is available the syntax is re-bound without
    /// a target so the original no-common-type diagnostic — suppressed at the
    /// deferral point — surfaces. Non-placeholder arguments are returned
    /// unchanged.
    /// </summary>
    /// <param name="argument">The (possibly placeholder) bound argument.</param>
    /// <param name="expectedType">The resolved parameter target type.</param>
    /// <returns>The finalized argument.</returns>
    private BoundExpression FinalizeBranchyArgument(BoundExpression argument, TypeSymbol expectedType)
        => FinalizeBranchyArgument(argument, argumentSyntax: null, expectedType);

    /// <summary>
    /// Issue #1238 / #1480: finalizes a branchy (<c>if</c>/ternary/<c>switch</c>
    /// or <c>??</c>) call argument against the resolved parameter type. Two cases
    /// are handled: (1) a deferred placeholder (produced when the branches could
    /// not unify without a target) is re-bound with the target so each branch is
    /// target-typed; (2) Issue #1480 — a branchy argument that DID unify to a
    /// natural common type (e.g. the arms' shared base class) but whose result is
    /// not implicitly convertible to the parameter type is re-bound with the
    /// parameter type as its target, so sibling arms can unify to a contextual
    /// interface (or wider base) the consumer requires. Non-branchy arguments and
    /// arguments already convertible to the target are returned unchanged.
    /// </summary>
    /// <param name="argument">The (possibly placeholder) bound argument.</param>
    /// <param name="argumentSyntax">The original argument syntax, when known.</param>
    /// <param name="expectedType">The resolved parameter target type.</param>
    /// <returns>The finalized argument.</returns>
    private BoundExpression FinalizeBranchyArgument(BoundExpression argument, ExpressionSyntax argumentSyntax, TypeSymbol expectedType)
    {
        var targetUsable = expectedType != null
            && expectedType != TypeSymbol.Error
            && expectedType != TypeSymbol.Void
            && !TypeSymbol.ContainsTypeParameter(expectedType);

        if (ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(argument, out var branchySyntax))
        {
            return targetUsable
                ? bindExpressionWithTargetType(branchySyntax, expectedType)
                : bindExpression(branchySyntax);
        }

        // Issue #1480: a branchy argument that unified to its natural common type
        // (e.g. the arms' shared base class) but does not implicitly convert to
        // the parameter type is re-bound with the parameter type as its target so
        // sibling arms can unify to the contextual interface/base the call
        // requires (mirroring the return / typed-let target-typing paths).
        if (targetUsable
            && argument != null
            && argument is not BoundErrorExpression
            && argument.Type != null
            && argument.Type != TypeSymbol.Error
            && argument.Type != expectedType
            && !Conversion.Classify(argument.Type, expectedType).IsImplicit)
        {
            var inner = argumentSyntax;
            while (inner is ParenthesizedExpressionSyntax parenthesized)
            {
                inner = parenthesized.Expression;
            }

            if (inner != null && ExpressionBinder.IsTargetTypedBranchyArgumentSyntax(inner))
            {
                return bindExpressionWithTargetType(inner, expectedType);
            }
        }

        return argument;
    }

    /// <summary>
    /// Issue #343: pre-validates the layout of call arguments — positional
    /// arguments must precede all named arguments, and no two named arguments
    /// may share the same name. Reports the corresponding diagnostic
    /// (<see cref="DiagnosticBag.ReportPositionalArgumentAfterNamedArgument"/>
    /// or <see cref="DiagnosticBag.ReportDuplicateNamedArgument"/>) on each
    /// violation, then returns <see langword="false"/> so the surrounding call
    /// binder can fall back to a <see cref="BoundErrorExpression"/>.
    /// </summary>
    /// <param name="arguments">The call's argument syntax list.</param>
    /// <param name="positionalCount">On return, the number of leading positional arguments.</param>
    /// <param name="argumentNames">On return, the per-source-argument names (entries are <see langword="null"/> for positional, the name for named). The default array when no named arguments are present.</param>
    /// <returns><see langword="true"/> when the layout is well-formed.</returns>
    public bool TryAnalyzeCallArgumentLayout(
        SeparatedSyntaxList<ExpressionSyntax> arguments,
        out int positionalCount,
        out ImmutableArray<string> argumentNames)
    {
        positionalCount = 0;
        argumentNames = default;

        if (arguments.Count == 0)
        {
            return true;
        }

        var ok = true;
        var seenNamed = false;
        HashSet<string> seenNames = null;
        string[] names = null;

        for (var i = 0; i < arguments.Count; i++)
        {
            if (arguments[i] is NamedArgumentExpressionSyntax named)
            {
                names ??= new string[arguments.Count];
                seenNames ??= new HashSet<string>(StringComparer.Ordinal);
                seenNamed = true;
                names[i] = named.NameToken.Text;
                if (!seenNames.Add(named.NameToken.Text))
                {
                    Diagnostics.ReportDuplicateNamedArgument(named.NameToken.Location, named.NameToken.Text);
                    ok = false;
                }
            }
            else
            {
                if (seenNamed)
                {
                    Diagnostics.ReportPositionalArgumentAfterNamedArgument(arguments[i].Location);
                    ok = false;
                }
                else
                {
                    positionalCount++;
                }
            }
        }

        if (names != null)
        {
            argumentNames = ImmutableArray.Create(names);
        }

        return ok;
    }

    /// <summary>
    /// Issue #343: re-orders source-order bound arguments into the resolved
    /// callee's parameter order, filling any unfilled (skipped) optional slots
    /// with their compile-time default expressions. Generalises
    /// <see cref="ConversionClassifier.AppendOmittedOptionalArguments"/> to handle named arguments
    /// that target non-trailing parameter positions (so an interior optional
    /// parameter can be omitted).
    /// </summary>
    /// <param name="suppliedArguments">Bound arguments in source order.</param>
    /// <param name="parameterMapping">Per-source-argument → parameter-position map; default for identity.</param>
    /// <param name="parameters">The resolved method's/constructor's full parameter list.</param>
    /// <returns>The argument array reordered into parameter positions, padded with defaults.</returns>
    public static ImmutableArray<BoundExpression> BuildOrderedCallArguments(
        ImmutableArray<BoundExpression> suppliedArguments,
        ImmutableArray<int> parameterMapping,
        System.Reflection.ParameterInfo[] parameters)
    {
        if (parameterMapping.IsDefault)
        {
            // No named-argument reordering required — preserve the existing
            // trailing-optional behaviour.
            return ConversionClassifier.AppendOmittedOptionalArguments(suppliedArguments, parameters);
        }

        var ordered = new BoundExpression[parameters.Length];
        for (var i = 0; i < suppliedArguments.Length; i++)
        {
            var slot = parameterMapping[i];
            ordered[slot] = suppliedArguments[i];
        }

        for (var i = 0; i < parameters.Length; i++)
        {
            ordered[i] ??= ConversionClassifier.CreateOptionalDefaultArgument(parameters[i]);
        }

        return ImmutableArray.Create(ordered);
    }

    /// <summary>
    /// Issue #343: reorders source-order user-function arguments into the
    /// callee's parameter order. User-declared functions, methods, extensions
    /// and constructors do not support default parameter values, so every
    /// parameter slot must be filled — the helper validates that, reports
    /// <see cref="DiagnosticBag.ReportNamedArgumentParameterNotFound"/> /
    /// <see cref="DiagnosticBag.ReportNamedArgumentAlsoSpecifiedPositionally"/> /
    /// <see cref="DiagnosticBag.ReportDuplicateNamedArgument"/> on layout
    /// violations and returns <see langword="false"/> to short-circuit the
    /// surrounding binder. When no named arguments are present, returns
    /// identity-mapped <paramref name="permutedSyntax"/> /
    /// <paramref name="permutedBound"/> so callers can use a single code path.
    /// </summary>
    /// <param name="sourceArguments">The call's argument syntax in source order.</param>
    /// <param name="sourceBound">The bound arguments in source order (already unwrapped from <see cref="NamedArgumentExpressionSyntax"/> at bind time).</param>
    /// <param name="parameterCount">The number of callable parameter slots (excludes any synthetic receiver slot).</param>
    /// <param name="parameterNameAt">Function returning the declared name of the i-th callable parameter.</param>
    /// <param name="calleeName">The callee name used in diagnostics.</param>
    /// <param name="permutedSyntax">On true, an array of length <paramref name="parameterCount"/> giving the argument syntax slotted at each parameter position.</param>
    /// <param name="permutedBound">On true, an <see cref="ImmutableArray{T}"/> of length <paramref name="parameterCount"/> giving the bound arguments in parameter order.</param>
    /// <returns><see langword="true"/> when reordering succeeds.</returns>
    private bool TryReorderUserCallArguments(
        SeparatedSyntaxList<ExpressionSyntax> sourceArguments,
        ImmutableArray<BoundExpression> sourceBound,
        int parameterCount,
        System.Func<int, string> parameterNameAt,
        string calleeName,
        out ExpressionSyntax[] permutedSyntax,
        out ImmutableArray<BoundExpression> permutedBound)
        => TryReorderUserCallArguments(
            sourceArguments,
            sourceBound,
            parameterCount,
            parameterNameAt,
            isOptionalAt: null,
            calleeName,
            out permutedSyntax,
            out permutedBound);

    /// <summary>
    /// ADR-0063: reorders and pads call arguments to match the parameter list.
    /// When <paramref name="isOptionalAt"/> is non-null, omitted optional slots
    /// are left as <see langword="null"/> in the result for callers to fill with
    /// default-value substitutions.
    /// </summary>
    private bool TryReorderUserCallArguments(
        SeparatedSyntaxList<ExpressionSyntax> sourceArguments,
        ImmutableArray<BoundExpression> sourceBound,
        int parameterCount,
        System.Func<int, string> parameterNameAt,
        System.Func<int, bool> isOptionalAt,
        string calleeName,
        out ExpressionSyntax[] permutedSyntax,
        out ImmutableArray<BoundExpression> permutedBound)
    {
        permutedSyntax = null;
        permutedBound = default;

        if (!TryAnalyzeCallArgumentLayout(sourceArguments, out var positionalCount, out var argumentNames))
        {
            return false;
        }

        if (argumentNames.IsDefault)
        {
            // Pure positional: pad with nulls when fewer args than parameters and
            // optional slots are permitted.
            if (sourceArguments.Count == parameterCount || isOptionalAt == null)
            {
                var identitySyntax = new ExpressionSyntax[sourceArguments.Count];
                for (var i = 0; i < sourceArguments.Count; i++)
                {
                    identitySyntax[i] = sourceArguments[i];
                }

                permutedSyntax = identitySyntax;
                permutedBound = sourceBound;
                return true;
            }

            var paddedSyntax = new ExpressionSyntax[parameterCount];
            var paddedBound = new BoundExpression[parameterCount];
            var supplied = sourceArguments.Count < parameterCount ? sourceArguments.Count : parameterCount;
            for (var i = 0; i < supplied; i++)
            {
                paddedSyntax[i] = sourceArguments[i];
                paddedBound[i] = sourceBound[i];
            }

            permutedSyntax = paddedSyntax;
            permutedBound = ImmutableArray.Create(paddedBound);
            return true;
        }

        var slotSyntax = new ExpressionSyntax[parameterCount];
        var slotBound = new BoundExpression[parameterCount];

        var leadingPositional = positionalCount < parameterCount ? positionalCount : parameterCount;
        for (var i = 0; i < leadingPositional; i++)
        {
            slotSyntax[i] = sourceArguments[i];
            slotBound[i] = sourceBound[i];
        }

        var ok = true;
        for (var i = positionalCount; i < sourceArguments.Count; i++)
        {
            var name = argumentNames[i];
            if (name == null)
            {
                continue;
            }

            var named = (NamedArgumentExpressionSyntax)sourceArguments[i];

            var paramIdx = -1;
            for (var p = 0; p < parameterCount; p++)
            {
                if (string.Equals(parameterNameAt(p), name, StringComparison.Ordinal))
                {
                    paramIdx = p;
                    break;
                }
            }

            if (paramIdx < 0)
            {
                Diagnostics.ReportNamedArgumentParameterNotFound(named.NameToken.Location, calleeName, name);
                ok = false;
                continue;
            }

            if (slotSyntax[paramIdx] != null)
            {
                if (paramIdx < leadingPositional)
                {
                    Diagnostics.ReportNamedArgumentAlsoSpecifiedPositionally(named.NameToken.Location, name);
                }
                else
                {
                    Diagnostics.ReportDuplicateNamedArgument(named.NameToken.Location, name);
                }

                ok = false;
                continue;
            }

            slotSyntax[paramIdx] = sourceArguments[i];
            slotBound[paramIdx] = sourceBound[i];
        }

        if (!ok)
        {
            return false;
        }

        for (var p = 0; p < parameterCount; p++)
        {
            if (slotSyntax[p] == null)
            {
                // ADR-0063: empty slot is only OK when the parameter is optional;
                // the caller substitutes the default value.
                if (isOptionalAt != null && isOptionalAt(p))
                {
                    continue;
                }

                // Caller's count check should have prevented this; defensive.
                return false;
            }
        }

        permutedSyntax = slotSyntax;
        permutedBound = ImmutableArray.Create(slotBound);
        return true;
    }

    /// <summary>
    /// Issue #343: returns the first non-null name in <paramref name="argumentNames"/>,
    /// used as the offending name when reporting
    /// <see cref="DiagnosticBag.ReportNamedArgumentParameterNotFound"/> at call sites
    /// where the callee does not expose parameter names (delegate-typed variables,
    /// variadic functions, etc.). Callers should only invoke this when at least one
    /// entry is non-null.
    /// </summary>
    public static string FirstNamedArgumentName(ImmutableArray<string> argumentNames)
    {
        if (argumentNames.IsDefault)
        {
            return string.Empty;
        }

        for (var i = 0; i < argumentNames.Length; i++)
        {
            if (argumentNames[i] != null)
            {
                return argumentNames[i];
            }
        }

        return string.Empty;
    }

    /// <summary>
    /// Issue #343: when overload resolution fails for a CLR call site that
    /// supplied named arguments, surface the first unknown parameter name as a
    /// dedicated diagnostic (<see cref="DiagnosticBag.ReportNamedArgumentParameterNotFound"/>)
    /// rather than the generic "unable to find function". A name is "known"
    /// when any candidate of the requested name and binding flags exposes a
    /// parameter with that name.
    /// </summary>
    /// <param name="receiverClrType">The CLR type that hosts the candidate methods.</param>
    /// <param name="methodName">The method name at the call site.</param>
    /// <param name="bindingFlags">Reflection binding flags used to enumerate candidates.</param>
    /// <param name="ce">The originating call expression (for diagnostic location).</param>
    /// <param name="argumentNames">Per-source-argument names parallel to the call's arguments.</param>
    /// <returns><see langword="true"/> when a dedicated diagnostic was emitted.</returns>
    public bool TryReportUnknownNamedArgumentForClr(
        System.Type receiverClrType,
        string methodName,
        System.Reflection.BindingFlags bindingFlags,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames)
    {
        HashSet<string> knownNames = null;
        for (var i = 0; i < argumentNames.Length; i++)
        {
            var name = argumentNames[i];
            if (name == null)
            {
                continue;
            }

            knownNames ??= MemberLookup.CollectClrParameterNames(receiverClrType, methodName, bindingFlags);
            if (!knownNames.Contains(name))
            {
                var location = ce.Arguments[i] is NamedArgumentExpressionSyntax named ? named.NameToken.Location : ce.Arguments[i].Location;
                Diagnostics.ReportNamedArgumentParameterNotFound(location, methodName, name);
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #343: when overload resolution fails for a CLR <em>constructor</em>
    /// call site that supplied named arguments, surface the first unknown
    /// parameter name as a dedicated diagnostic
    /// (<see cref="DiagnosticBag.ReportNamedArgumentParameterNotFound"/>) instead
    /// of falling back to the generic "no matching constructor" path.
    /// </summary>
    /// <param name="clrType">The CLR type being constructed.</param>
    /// <param name="ce">The originating call expression (for diagnostic location).</param>
    /// <param name="argumentNames">Per-source-argument names parallel to the call's arguments.</param>
    /// <returns><see langword="true"/> when a dedicated diagnostic was emitted.</returns>
    public bool TryReportUnknownNamedArgumentForClrConstructor(
        System.Type clrType,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames)
    {
        HashSet<string> knownNames = null;
        for (var i = 0; i < argumentNames.Length; i++)
        {
            var name = argumentNames[i];
            if (name == null)
            {
                continue;
            }

            knownNames ??= MemberLookup.CollectClrConstructorParameterNames(clrType);
            if (!knownNames.Contains(name))
            {
                var location = ce.Arguments[i] is NamedArgumentExpressionSyntax named ? named.NameToken.Location : ce.Arguments[i].Location;
                Diagnostics.ReportNamedArgumentParameterNotFound(location, clrType.Name, name);
                return true;
            }
        }

        return false;
    }

    public void ValidateRefArguments(
        ImmutableArray<BoundExpression> arguments,
        ImmutableArray<RefKind> refKinds,
        string methodName,
        TextLocation callLocation)
    {
        if (refKinds.IsDefault || refKinds.Length == 0)
        {
            return;
        }

        for (int i = 0; i < refKinds.Length && i < arguments.Length; i++)
        {
            var rk = refKinds[i];
            if (rk == RefKind.None)
            {
                continue;
            }

            if (rk == RefKind.Ref || rk == RefKind.Out)
            {
                // ADR-0061: BoundConditionalAddressExpression is also a valid
                // byref-producing argument (selects one of two addresses at
                // runtime).
                // Issue #377 sub-item 1: a BoundInterpolatedStringExpression
                // whose Handler.HandlerRefKind matches the call's by-ref slot
                // is lowered to a BoundBlockExpression whose trailing
                // expression is a BoundAddressOfExpression of the constructed
                // handler local — the address of that local is what the
                // by-ref slot consumes.
                if (arguments[i] is not BoundAddressOfExpression
                    && arguments[i] is not BoundConditionalAddressExpression
                    && !IsByRefInterpolatedHandlerArgument(arguments[i], rk))
                {
                    Diagnostics.ReportArgumentMustBePassedByRef(callLocation, i + 1, methodName);
                }
            }

            // For `in`: accept either &expr or plain value (emitter spills temp).
        }
    }

    private static bool IsByRefInterpolatedHandlerArgument(BoundExpression argument, RefKind expected)
    {
        return argument is BoundInterpolatedStringExpression interp
            && interp.Handler != null
            && interp.Handler.HandlerRefKind == expected;
    }
}
