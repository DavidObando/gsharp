// <copyright file="OverloadResolver.cs" company="GSharp">
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

/// <summary>
/// PR-B-4: the binder-side facade for call-site overload resolution. Owns
/// the <see cref="BindCallExpression"/>, <see cref="BindConstructorCallExpression"/>,
/// <see cref="BindExtensionFunctionCall"/>, and <see cref="BindUserInstanceCall"/>
/// entry points, plus the supporting machinery — named-argument
/// reordering, default-value fill, <c>params T[]</c> lowering, generic
/// type-argument inference, candidate selection (delegating to the pure
/// reflection-level resolver in <see cref="OverloadResolution"/>), and
/// the diagnostic emission used at all four call-site shapes.
/// </summary>
/// <remarks>
/// <para>
/// This type is the binder-side wrapper: it consumes
/// <see cref="BinderContext"/> for the diagnostics bag and Scope chain,
/// <see cref="MemberLookup"/> for candidate enumeration, and
/// <see cref="ConversionClassifier"/> for per-argument conversion. It
/// never back-references <see cref="Binder"/>; the callbacks it needs
/// (re-binding a sub-expression, the type-clause and ref-argument
/// binders, the CLR-call probing helpers, the type-argument inference
/// and constraint checking helpers, the function-literal adapter
/// creation, etc.) are injected through narrow delegate seams in the
/// constructor — the same pattern <see cref="ConversionClassifier"/>
/// established in PR-B-3.
/// </para>
/// <para>
/// The pure value-shaped <see cref="OverloadResolution"/> static class
/// in <c>OverloadResolution.cs</c> is unchanged and continues to expose
/// the reflection-level <c>Resolve&lt;T&gt;</c> /
/// <c>TryInferTypeArguments</c> entry points. This class merely wraps
/// that pure resolver with the diagnostic emission, syntax-aware
/// reordering, and bound-tree construction previously embedded in
/// <see cref="Binder"/>.
/// </para>
/// <para>
/// The lifted-overload-resolution work for the nullable cluster
/// (issues #571 / #574) and other Wave-3 architectural fixes from
/// <c>~/gsharp-bug-overview.md</c> §6.1 will land in this class in a
/// follow-up PR after the full Binder decomposition is complete. This
/// PR only sets up the structural home for those fixes; it makes no
/// behaviour change.
/// </para>
/// </remarks>
internal sealed class OverloadResolver
{
    /// <summary>
    /// Custom delegate type for the <c>TryBindClrConstructorCall</c>
    /// callback, required because <see cref="Func{T1, T2, TResult}"/>
    /// cannot express an <c>out</c> parameter.
    /// </summary>
    public delegate bool TryBindClrConstructorCallDelegate(
        CallExpressionSyntax syntax,
        out BoundExpression result);

    /// <summary>
    /// Custom delegate type for the <c>TryBindIntrinsicCall</c>
    /// callback (same rationale as
    /// <see cref="TryBindClrConstructorCallDelegate"/>).
    /// </summary>
    public delegate bool TryBindIntrinsicCallDelegate(
        CallExpressionSyntax syntax,
        out BoundExpression result);

    /// <summary>
    /// Custom delegate type for the <c>TryBindInheritedClrInstanceCall</c>
    /// callback (same rationale as
    /// <see cref="TryBindClrConstructorCallDelegate"/>).
    /// </summary>
    public delegate bool TryBindInheritedClrInstanceCallDelegate(
        BoundExpression receiver,
        Type importedBaseClr,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        out BoundExpression result,
        Type[] explicitTypeArgs,
        ImmutableArray<TypeSymbol> typeArgSymbols,
        ImmutableArray<string> argumentNames);

    /// <summary>
    /// Custom delegate type for the <c>TryGetFunctionLiteral</c>
    /// callback (same rationale as
    /// <see cref="TryBindClrConstructorCallDelegate"/>).
    /// </summary>
    public delegate bool TryGetFunctionLiteralDelegate(
        BoundExpression expression,
        out BoundFunctionLiteralExpression literal);

    private readonly BinderContext binderCtx;
    private readonly MemberLookup memberLookup;
    private readonly ConversionClassifier conversions;

    private readonly Func<ExpressionSyntax, BoundExpression> bindExpression;
    private readonly Func<RefArgumentExpressionSyntax, ParameterSymbol, BoundExpression> bindRefArgumentExpression;
    private readonly Func<TypeClauseSyntax, TypeSymbol> bindTypeClause;
    private readonly Func<string, TypeSymbol> lookupType;
    private readonly Action<TextLocation, Symbol, string> reportObsoleteUseIfApplicable;
    private readonly TryBindClrConstructorCallDelegate tryBindClrConstructorCall;
    private readonly TryBindIntrinsicCallDelegate tryBindIntrinsicCall;
    private readonly TryBindInheritedClrInstanceCallDelegate tryBindInheritedClrInstanceCall;
    private readonly Func<TypeSymbol, bool> isFormattableStringTargetType;
    private readonly Func<InterpolatedStringExpressionSyntax, TypeSymbol, BoundExpression> bindInterpolatedStringAsFormattable;
    private readonly Func<SyntaxToken, RefKind> getRefKindFromModifier;
    private readonly Func<RefKind, string> refKindToString;
    private readonly Func<BoundFunctionLiteralExpression, FunctionTypeSymbol, BoundFunctionLiteralExpression> createErasedFunctionLiteralAdapter;
    private readonly Func<TypeSymbol, TypeSymbol> wrapAsTask;
    private readonly Func<TypeSymbol, bool> isAsyncIteratorReturnType;
    private readonly TryGetFunctionLiteralDelegate tryGetFunctionLiteral;
    private readonly Action<TypeSymbol, TypeSymbol, Dictionary<TypeParameterSymbol, TypeSymbol>> inferTypeArguments;
    private readonly Func<TypeSymbol, Dictionary<TypeParameterSymbol, TypeSymbol>, TypeSymbol> substituteType;
    private readonly Func<TypeSymbol, TypeParameterSymbol, bool> satisfiesConstraint;
    private readonly Func<TypeParameterSymbol, string> describeConstraint;
    private readonly Func<FunctionSymbol> getCurrentFunction;

    /// <summary>
    /// Initializes a new instance of the <see cref="OverloadResolver"/>
    /// class.
    /// </summary>
    /// <param name="binderCtx">The shared binder context that exposes the
    /// diagnostics bag, the (mutable) root/current Scope, and the
    /// reference resolver.</param>
    /// <param name="memberLookup">The binder-side member-lookup facade
    /// used for delegate-shape probes and CLR-parameter-name collection.</param>
    /// <param name="conversions">The binder-side conversion classifier
    /// used to convert each argument once a candidate has been
    /// chosen.</param>
    /// <param name="bindExpression">Callback to re-bind a sub-expression
    /// through the still-on-Binder expression-binding entry point.</param>
    /// <param name="bindRefArgumentExpression">Callback to bind a
    /// <see cref="RefArgumentExpressionSyntax"/> against a known parameter
    /// symbol (or <c>null</c> in the first, parameter-unknown, pass).</param>
    /// <param name="bindTypeClause">Callback to bind a
    /// <see cref="TypeClauseSyntax"/> to a <see cref="TypeSymbol"/>.</param>
    /// <param name="lookupType">Callback to resolve a bare type name to a
    /// <see cref="TypeSymbol"/> in the current binding context.</param>
    /// <param name="reportObsoleteUseIfApplicable">Callback that emits
    /// <c>GS0276</c> when a symbol is <c>[Obsolete]</c>.</param>
    /// <param name="tryBindClrConstructorCall">Callback that attempts to
    /// bind a <c>TypeName(args)</c> / <c>TypeName[T1,T2](args)</c>
    /// invocation against an imported CLR class.</param>
    /// <param name="tryBindIntrinsicCall">Callback that attempts to bind a
    /// well-known intrinsic-named call (<c>len</c>, <c>cap</c>,
    /// <c>append</c>, <c>print</c>, …).</param>
    /// <param name="tryBindInheritedClrInstanceCall">Callback that
    /// attempts to bind an instance call against an imported CLR base
    /// class — used to lower <c>delegateVar(args)</c> through
    /// <c>Invoke</c>.</param>
    /// <param name="isFormattableStringTargetType">Callback to test
    /// whether a target type is one of the ADR-0055 Tier 4
    /// formattable-string shapes.</param>
    /// <param name="bindInterpolatedStringAsFormattable">Callback that
    /// performs the ADR-0055 Tier 4 contextual conversion of an
    /// interpolated string to <c>IFormattable</c>/<c>FormattableString</c>.</param>
    /// <param name="getRefKindFromModifier">Callback that maps a
    /// <c>ref</c>/<c>out</c>/<c>in</c> modifier token to a
    /// <see cref="RefKind"/>.</param>
    /// <param name="refKindToString">Callback used only for the
    /// human-readable diagnostic message when a ref-kind mismatch is
    /// reported.</param>
    /// <param name="createErasedFunctionLiteralAdapter">Callback that
    /// wraps a function-literal expression in an erased-signature adapter
    /// for the target generic function type.</param>
    /// <param name="wrapAsTask">Callback that wraps a return type in
    /// <c>System.Threading.Tasks.Task</c> / <c>Task&lt;T&gt;</c> for
    /// async kickoff-method call sites.</param>
    /// <param name="isAsyncIteratorReturnType">Callback that tests
    /// whether a return type is an async-iterator shape so async-wrap is
    /// suppressed.</param>
    /// <param name="tryGetFunctionLiteral">Callback that unwraps a bound
    /// argument to a <see cref="BoundFunctionLiteralExpression"/> if it
    /// is one (possibly through a <see cref="BoundConversionExpression"/>).</param>
    /// <param name="inferTypeArguments">Callback that performs a single
    /// step of left-to-right type-argument inference, mutating the
    /// supplied substitution map.</param>
    /// <param name="substituteType">Callback that substitutes a single
    /// type expression under the supplied substitution map.</param>
    /// <param name="satisfiesConstraint">Callback that checks whether a
    /// resolved type argument satisfies the declared constraint of a
    /// type parameter.</param>
    /// <param name="describeConstraint">Callback that produces a
    /// human-readable description of a type-parameter constraint for
    /// diagnostics.</param>
    /// <param name="getCurrentFunction">Callback that returns the
    /// enclosing <see cref="FunctionSymbol"/> being bound (or
    /// <c>null</c> at top-level), used by the implicit-<c>this</c>
    /// dispatch path in <see cref="BindCallExpression"/>.</param>
    public OverloadResolver(
        BinderContext binderCtx,
        MemberLookup memberLookup,
        ConversionClassifier conversions,
        Func<ExpressionSyntax, BoundExpression> bindExpression,
        Func<RefArgumentExpressionSyntax, ParameterSymbol, BoundExpression> bindRefArgumentExpression,
        Func<TypeClauseSyntax, TypeSymbol> bindTypeClause,
        Func<string, TypeSymbol> lookupType,
        Action<TextLocation, Symbol, string> reportObsoleteUseIfApplicable,
        TryBindClrConstructorCallDelegate tryBindClrConstructorCall,
        TryBindIntrinsicCallDelegate tryBindIntrinsicCall,
        TryBindInheritedClrInstanceCallDelegate tryBindInheritedClrInstanceCall,
        Func<TypeSymbol, bool> isFormattableStringTargetType,
        Func<InterpolatedStringExpressionSyntax, TypeSymbol, BoundExpression> bindInterpolatedStringAsFormattable,
        Func<SyntaxToken, RefKind> getRefKindFromModifier,
        Func<RefKind, string> refKindToString,
        Func<BoundFunctionLiteralExpression, FunctionTypeSymbol, BoundFunctionLiteralExpression> createErasedFunctionLiteralAdapter,
        Func<TypeSymbol, TypeSymbol> wrapAsTask,
        Func<TypeSymbol, bool> isAsyncIteratorReturnType,
        TryGetFunctionLiteralDelegate tryGetFunctionLiteral,
        Action<TypeSymbol, TypeSymbol, Dictionary<TypeParameterSymbol, TypeSymbol>> inferTypeArguments,
        Func<TypeSymbol, Dictionary<TypeParameterSymbol, TypeSymbol>, TypeSymbol> substituteType,
        Func<TypeSymbol, TypeParameterSymbol, bool> satisfiesConstraint,
        Func<TypeParameterSymbol, string> describeConstraint,
        Func<FunctionSymbol> getCurrentFunction)
    {
        this.binderCtx = binderCtx ?? throw new ArgumentNullException(nameof(binderCtx));
        this.memberLookup = memberLookup ?? throw new ArgumentNullException(nameof(memberLookup));
        this.conversions = conversions ?? throw new ArgumentNullException(nameof(conversions));
        this.bindExpression = bindExpression ?? throw new ArgumentNullException(nameof(bindExpression));
        this.bindRefArgumentExpression = bindRefArgumentExpression ?? throw new ArgumentNullException(nameof(bindRefArgumentExpression));
        this.bindTypeClause = bindTypeClause ?? throw new ArgumentNullException(nameof(bindTypeClause));
        this.lookupType = lookupType ?? throw new ArgumentNullException(nameof(lookupType));
        this.reportObsoleteUseIfApplicable = reportObsoleteUseIfApplicable ?? throw new ArgumentNullException(nameof(reportObsoleteUseIfApplicable));
        this.tryBindClrConstructorCall = tryBindClrConstructorCall ?? throw new ArgumentNullException(nameof(tryBindClrConstructorCall));
        this.tryBindIntrinsicCall = tryBindIntrinsicCall ?? throw new ArgumentNullException(nameof(tryBindIntrinsicCall));
        this.tryBindInheritedClrInstanceCall = tryBindInheritedClrInstanceCall ?? throw new ArgumentNullException(nameof(tryBindInheritedClrInstanceCall));
        this.isFormattableStringTargetType = isFormattableStringTargetType ?? throw new ArgumentNullException(nameof(isFormattableStringTargetType));
        this.bindInterpolatedStringAsFormattable = bindInterpolatedStringAsFormattable ?? throw new ArgumentNullException(nameof(bindInterpolatedStringAsFormattable));
        this.getRefKindFromModifier = getRefKindFromModifier ?? throw new ArgumentNullException(nameof(getRefKindFromModifier));
        this.refKindToString = refKindToString ?? throw new ArgumentNullException(nameof(refKindToString));
        this.createErasedFunctionLiteralAdapter = createErasedFunctionLiteralAdapter ?? throw new ArgumentNullException(nameof(createErasedFunctionLiteralAdapter));
        this.wrapAsTask = wrapAsTask ?? throw new ArgumentNullException(nameof(wrapAsTask));
        this.isAsyncIteratorReturnType = isAsyncIteratorReturnType ?? throw new ArgumentNullException(nameof(isAsyncIteratorReturnType));
        this.tryGetFunctionLiteral = tryGetFunctionLiteral ?? throw new ArgumentNullException(nameof(tryGetFunctionLiteral));
        this.inferTypeArguments = inferTypeArguments ?? throw new ArgumentNullException(nameof(inferTypeArguments));
        this.substituteType = substituteType ?? throw new ArgumentNullException(nameof(substituteType));
        this.satisfiesConstraint = satisfiesConstraint ?? throw new ArgumentNullException(nameof(satisfiesConstraint));
        this.describeConstraint = describeConstraint ?? throw new ArgumentNullException(nameof(describeConstraint));
        this.getCurrentFunction = getCurrentFunction ?? throw new ArgumentNullException(nameof(getCurrentFunction));
    }

    private DiagnosticBag Diagnostics => binderCtx.Diagnostics;

    private BoundScope Scope => binderCtx.RootScope;

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
    /// <returns>An argument list of length <paramref name="parameters"/>.Length whose final element is the packed array.</returns>
    public ImmutableArray<BoundExpression> ExpandParamsArguments(
        ImmutableArray<BoundExpression> arguments,
        System.Reflection.ParameterInfo[] parameters,
        CallExpressionSyntax callSyntax,
        int receiverArgCount = 0,
        ImmutableArray<int> parameterMapping = default)
    {
        var paramsIndex = parameters.Length - 1;
        var paramArrayType = parameters[paramsIndex].ParameterType;
        var elementClrType = paramArrayType.GetElementType();
        var elementTypeSymbol = elementClrType == null
            ? TypeSymbol.Object
            : TypeSymbol.FromClrType(elementClrType);
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
        var tailCount = arguments.Length - fixedCount;
        if (tailCount < 0)
        {
            // Shouldn't happen: overload resolution rejects expanded-form
            // candidates whose fixed leading parameters are not all supplied.
            // Defensive fallback: leave the arguments unchanged.
            return arguments;
        }

        var packed = ImmutableArray.CreateBuilder<BoundExpression>(tailCount);
        for (var i = 0; i < tailCount; i++)
        {
            var sourceIndex = fixedCount + i;
            packed.Add(ConvertParamsElement(arguments[sourceIndex], elementTypeSymbol, callSyntax, sourceIndex, receiverArgCount));
        }

        var arrayExpr = new BoundArrayCreationExpression(callSyntax, sliceType, packed.MoveToImmutable());

        var result = ImmutableArray.CreateBuilder<BoundExpression>(parameters.Length);
        for (var i = 0; i < fixedCount; i++)
        {
            result.Add(arguments[i]);
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

        return arg;
    }

    /// <summary>
    /// ADR-0063: thin wrapper around <see cref="SelectBestInstanceOverload"/>
    /// that reports the standard ambiguity / no-applicable-overload diagnostics
    /// when more than one candidate is supplied. When a single candidate is
    /// supplied the wrapper returns it unchanged so legacy single-overload
    /// callsites keep their existing diagnostics (wrong arity, etc.).
    /// </summary>
    public FunctionSymbol SelectInstanceOverloadOrReport(
        ImmutableArray<FunctionSymbol> overloads,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        string methodName,
        ImmutableArray<string> argumentNames)
    {
        if (overloads.Length <= 1)
        {
            return overloads.Length == 1 ? overloads[0] : null;
        }

        var selected = SelectBestInstanceOverload(overloads, arguments.Length, argumentNames, arguments, out var ambiguous);
        if (selected != null)
        {
            return selected;
        }

        if (ambiguous)
        {
            Diagnostics.ReportAmbiguousOverloadResolution(ce.Identifier.Location, methodName);
        }
        else
        {
            Diagnostics.ReportNoApplicableOverload(ce.Identifier.Location, methodName);
        }

        return null;
    }

    private FunctionSymbol SelectBestUserOverload(
        ImmutableArray<FunctionSymbol> candidates,
        int argumentCount,
        ImmutableArray<string> argumentNames,
        ImmutableArray<BoundExpression>.Builder boundArguments,
        out bool ambiguous)
    {
        return SelectBestUserOverloadCore(candidates, argumentCount, argumentNames, boundArguments, out ambiguous);
    }

    /// <summary>
    /// ADR-0063 §6: instance-method overload selection. Filters a candidate set
    /// of methods (each may or may not carry an explicit receiver parameter) by
    /// callable arity, named-argument compatibility, and optional-parameter
    /// applicability, then ranks by exact-type matches and defaulted slots.
    /// </summary>
    public FunctionSymbol SelectBestInstanceOverload(
        ImmutableArray<FunctionSymbol> candidates,
        int argumentCount,
        ImmutableArray<string> argumentNames,
        ImmutableArray<BoundExpression> boundArguments,
        out bool ambiguous)
    {
        ambiguous = false;
        if (candidates.Length == 0)
        {
            return null;
        }

        if (candidates.Length == 1)
        {
            return candidates[0];
        }

        var builder = ImmutableArray.CreateBuilder<BoundExpression>(boundArguments.Length);
        builder.AddRange(boundArguments);
        return SelectBestUserOverloadCore(candidates, argumentCount, argumentNames, builder, out ambiguous);
    }

    private FunctionSymbol SelectBestUserOverloadCore(
        ImmutableArray<FunctionSymbol> candidates,
        int argumentCount,
        ImmutableArray<string> argumentNames,
        ImmutableArray<BoundExpression>.Builder boundArguments,
        out bool ambiguous)
    {
        ambiguous = false;

        // Phase 1: applicability.
        var applicable = new List<FunctionSymbol>();
        foreach (var cand in candidates)
        {
            if (IsApplicableUserCallable(cand, argumentCount, argumentNames))
            {
                applicable.Add(cand);
            }
        }

        if (applicable.Count == 0)
        {
            return null;
        }

        if (applicable.Count == 1)
        {
            return applicable[0];
        }

        // Phase 2: prefer candidates with the fewest defaulted parameters (an
        // exact-arity overload beats one that relies on defaults). Also prefer
        // a non-variadic candidate over a variadic one when both apply.
        var bestScore = int.MaxValue;
        FunctionSymbol best = null;
        var tie = false;
        foreach (var cand in applicable)
        {
            var parameterOffset = cand.ExplicitReceiverParameter == null ? 0 : 1;
            var paramLen = cand.Parameters.Length - parameterOffset;
            var isVariadic = paramLen > 0 && cand.Parameters[cand.Parameters.Length - 1].IsVariadic;
            var paramCountForScore = isVariadic ? paramLen - 1 : paramLen;
            var defaultsUsed = paramCountForScore - argumentCount;
            if (defaultsUsed < 0)
            {
                defaultsUsed = 0;
            }

            // Apply a small penalty to variadic candidates (per ADR §6.6).
            var score = defaultsUsed + (isVariadic ? 1 : 0);

            // Score argument-type compatibility: +1 per exact-type match.
            for (var i = 0; i < paramCountForScore && i < boundArguments.Count; i++)
            {
                var argType = boundArguments[i]?.Type;
                var paramType = cand.Parameters[i + parameterOffset].Type;
                if (argType != null && paramType != null && argType == paramType)
                {
                    score -= 10;
                }
            }

            if (score < bestScore)
            {
                bestScore = score;
                best = cand;
                tie = false;
            }
            else if (score == bestScore)
            {
                tie = true;
            }
        }

        if (tie)
        {
            ambiguous = true;
            return null;
        }

        return best;
    }

    /// <summary>
    /// ADR-0063: returns true when the supplied argument count + names could
    /// reach the parameter list of the candidate.
    /// </summary>
    private static bool IsApplicableUserCallable(FunctionSymbol candidate, int argumentCount, ImmutableArray<string> argumentNames)
    {
        var parameterOffset = candidate.ExplicitReceiverParameter == null ? 0 : 1;
        var paramLen = candidate.Parameters.Length - parameterOffset;
        var isVariadic = paramLen > 0 && candidate.Parameters[candidate.Parameters.Length - 1].IsVariadic;
        var fixedParamCount = isVariadic ? paramLen - 1 : paramLen;

        // Compute required (non-optional) leading-parameter count.
        var requiredParamCount = paramLen;
        for (var i = paramLen - 1; i >= 0; i--)
        {
            if (candidate.Parameters[i + parameterOffset].HasExplicitDefaultValue)
            {
                requiredParamCount = i;
            }
            else
            {
                break;
            }
        }

        if (isVariadic)
        {
            if (argumentCount < fixedParamCount)
            {
                return false;
            }
        }
        else if (argumentCount < requiredParamCount || argumentCount > paramLen)
        {
            return false;
        }

        // Named-argument names must each correspond to a parameter.
        if (!argumentNames.IsDefault)
        {
            for (var i = 0; i < argumentNames.Length; i++)
            {
                var n = argumentNames[i];
                if (n == null)
                {
                    continue;
                }

                var found = false;
                for (var p = 0; p < paramLen; p++)
                {
                    if (candidate.Parameters[p + parameterOffset].Name == n)
                    {
                        found = true;
                        break;
                    }
                }

                if (!found)
                {
                    return false;
                }
            }
        }

        return true;
    }

    /// <summary>
    /// ADR-0063: synthesizes a bound default-value argument for a user-defined
    /// optional parameter. The default is a CLR-Constant-table representable
    /// primitive/string previously captured on the parameter symbol; <c>nil</c>
    /// becomes a <see cref="BoundDefaultExpression"/>.
    /// </summary>
    private static BoundExpression CreateOptionalUserDefaultArgument(ParameterSymbol parameter)
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

    public ImmutableArray<BoundExpression> ValidateRefArguments(
        ImmutableArray<BoundExpression> arguments,
        ImmutableArray<RefKind> refKinds,
        string methodName,
        TextLocation callLocation)
    {
        if (refKinds.IsDefault || refKinds.Length == 0)
        {
            return arguments;
        }

        var builder = arguments.ToBuilder();
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
                if (arguments[i] is not BoundAddressOfExpression
                    && arguments[i] is not BoundConditionalAddressExpression)
                {
                    Diagnostics.ReportArgumentMustBePassedByRef(callLocation, i + 1, methodName);
                }
            }

            // For `in`: accept either &expr or plain value (emitter spills temp).
        }

        return builder.ToImmutable();
    }

    public BoundExpression BindConstructorCallExpression(CallExpressionSyntax syntax, StructSymbol classType)
    {
        // ADR-0047 §6 / #175: primary-constructor call `Foo(...)` is a
        // use of the class type itself.
        reportObsoleteUseIfApplicable(syntax.Identifier.Location, classType, classType.Name);

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
                // Pre-bind arguments and infer type arguments from them.
                // Issue #343: when an argument is named, locate its parameter
                // by name (so type inference still works with named args) and
                // unwrap the wrapper before binding.
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

                    if (paramIdx >= defParams.Length)
                    {
                        continue;
                    }

                    var preBound = bindExpression(argSyntax);
                    inferTypeArguments(defParams[paramIdx].Type, preBound.Type, substitution);
                }

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

            classType = StructSymbol.Construct(classType, typeArgs.MoveToImmutable());
        }
        else if (syntax.TypeArgumentList != null)
        {
            Diagnostics.ReportWrongTypeArgumentCount(syntax.TypeArgumentList.Location, classType.Name, 0, syntax.TypeArgumentList.Arguments.Count);
            return new BoundErrorExpression(syntax);
        }

        var parameters = classType.PrimaryConstructorParameters;
        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
        foreach (var argument in syntax.Arguments)
        {
            // Issue #343: bind the value behind any named-argument wrapper.
            boundArguments.Add(bindExpression(UnwrapNamedArgumentValue(argument)));
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

            // ADR-0055 Tier 4 (#369): an interpolated-string argument targeting an
            // IFormattable/FormattableString constructor parameter lowers to
            // FormattableStringFactory.Create rather than an eager string.
            if (parameterSyntax[i] is InterpolatedStringExpressionSyntax interpolatedCtorArg
                && isFormattableStringTargetType(parameter.Type))
            {
                boundArguments[i] = bindInterpolatedStringAsFormattable(interpolatedCtorArg, parameter.Type);
                continue;
            }

            if (argument.Type != parameter.Type
                && !Conversion.Classify(argument.Type, parameter.Type).IsImplicit)
            {
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
        if (syntax.TypeArgumentList != null || classType.IsGenericDefinition)
        {
            Diagnostics.ReportGenericExplicitConstructorUnsupported(syntax.Identifier.Location, classType.Name);
            return new BoundErrorExpression(syntax);
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
        var ctorOverloads = classType.ExplicitConstructors;
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
                boundArgumentsBuilder.Add(bindExpression(argument));
            }
        }

        ConstructorSymbol selectedCtor;
        if (ctorOverloads.Length <= 1)
        {
            selectedCtor = classType.ExplicitConstructor;
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
                out var ambiguous);

            if (selectedFn == null)
            {
                if (ambiguous)
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

        // ADR-0063: synthesize defaults for any unsupplied trailing/middle
        // optional parameters. Both arity-with-named-omission and
        // trailing-omission go through this path.
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
        if (!argumentNames.IsDefault || requestedArgCount < parameters.Length)
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

            // ADR-0055 Tier 4 (#369): re-lower an interpolated-string argument
            // targeting an IFormattable/FormattableString parameter.
            if (i < parameterSyntax.Length
                && parameterSyntax[i] is InterpolatedStringExpressionSyntax interpolatedCtorArg
                && isFormattableStringTargetType(parameter.Type))
            {
                convertedArguments.Add(bindInterpolatedStringAsFormattable(interpolatedCtorArg, parameter.Type));
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
                if (pointee == parameter.Type || pointee == TypeSymbol.Error || parameter.Type == TypeSymbol.Error)
                {
                    convertedArguments.Add(argument);
                    continue;
                }
            }
            else if (parameter.RefKind != RefKind.None && argument is BoundConditionalAddressExpression condAddrCtor)
            {
                var pointee = condAddrCtor.PointeeType;
                if (pointee == parameter.Type || pointee == TypeSymbol.Error || parameter.Type == TypeSymbol.Error)
                {
                    convertedArguments.Add(argument);
                    continue;
                }
            }

            var argLocation = i < parameterSyntax.Length ? parameterSyntax[i].Location : syntax.Identifier.Location;
            if (argument.Type != parameter.Type
                && !Conversion.Classify(argument.Type, parameter.Type).IsImplicit)
            {
                if (conversions.TryApplyUserDefinedImplicitArgumentConversion(argument, parameter.Type, out var convertedArg))
                {
                    convertedArguments.Add(convertedArg);
                    continue;
                }

                if (argument.Type != TypeSymbol.Error)
                {
                    Diagnostics.ReportWrongArgumentType(argLocation, parameter.Name, parameter.Type, argument.Type);
                }

                hasErrors = true;
                convertedArguments.Add(argument);
            }
            else
            {
                convertedArguments.Add(conversions.BindConversion(argLocation, argument, parameter.Type));
            }
        }

        if (hasErrors)
        {
            return new BoundErrorExpression(syntax);
        }

        return new BoundConstructorCallExpression(syntax, classType, convertedArguments.ToImmutable(), selectedCtor);
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

    public BoundExpression BindCallExpression(CallExpressionSyntax syntax)
    {
        // Phase 4-exit: prefer CLR class instantiation over the single-arg
        // conversion-call hijack below, so that `StringBuilder(16)` resolves
        // to a CLR ctor rather than `conversions.BindConversion(int → StringBuilder)`.
        // Also handles closed-generic imports (`List[int]()`,
        // `Dictionary[string, int]()`). Interpreter-only — resolves a
        // ConstructorInfo and emits BoundClrConstructorCallExpression.
        if (tryBindClrConstructorCall(syntax, out var clrCtorCall))
        {
            return clrCtorCall;
        }

        if (syntax.Arguments.Count == 1 && lookupType(syntax.Identifier.Text) is TypeSymbol type)
        {
            // A single-arg call to a primitive-typed name is a conversion
            // (`int(x)`, `string(x)`). Defer to BindConversion. For a class
            // or inline-struct type, treat it as a ctor call instead — even
            // when no explicit/primary constructor is declared, so the user
            // sees an actionable "wrong argument count" diagnostic rather
            // than a misleading conversion error (issue #524).
            if (!(type is StructSymbol singleArgStruct && (singleArgStruct.IsClass || singleArgStruct.IsInline)))
            {
                // ADR-0047 §6 / #175: `Type(x)` as an explicit conversion
                // is still a use of the named type.
                reportObsoleteUseIfApplicable(syntax.Identifier.Location, type, type.Name);
                return conversions.BindConversion(syntax.Arguments[0], type, allowExplicit: true);
            }
        }

        // Phase 3.B.3 sub-step 2: `ClassName(arg1, arg2, ...)` invokes the
        // class's primary constructor when the call target resolves to a
        // class type with a declared primary ctor. Issue #524: a class
        // declaring no explicit `init(...)` and no primary constructor is
        // still constructible via `ClassName()` against the synthesized
        // parameterless default constructor — the emitter already produces
        // a `.ctor()` for such classes (see EmitClassDefaultConstructor),
        // so we just need the binder to route `ClassName()` through here.
        if (lookupType(syntax.Identifier.Text) is StructSymbol classType && (classType.IsClass || classType.IsInline))
        {
            return BindConstructorCallExpression(syntax, classType);
        }

        if (tryBindIntrinsicCall(syntax, out var intrinsic))
        {
            return intrinsic;
        }

        // Issue #343: pre-validate named-argument layout (positional precedes
        // named, no duplicate names). Errors are reported by the helper so the
        // call short-circuits to a bound error here.
        if (!TryAnalyzeCallArgumentLayout(syntax.Arguments, out _, out var argumentNames))
        {
            return new BoundErrorExpression(null);
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>();

        // ADR-0060: argument binding needs the matching parameter to resolve
        // inline `out var`/`out let`/`out _` payloads. For free-function calls
        // we don't have the FunctionSymbol resolved until below, so we first
        // bind everything with parameter=null (the inline-out form falls back
        // to its declared type) and patch up the type later. The plain
        // lvalue ref/in/out form is parameter-independent.
        foreach (var argument in syntax.Arguments)
        {
            // Issue #343: a named-argument wrapper carries the value expression
            // we want to bind; unwrap it so the value is bound on its own.
            var argSyntax = UnwrapNamedArgumentValue(argument);
            BoundExpression boundArgument;
            if (argSyntax is RefArgumentExpressionSyntax refArg)
            {
                boundArgument = bindRefArgumentExpression(refArg, null);
            }
            else
            {
                boundArgument = bindExpression(argSyntax);
            }

            boundArguments.Add(boundArgument);
        }

        var symbol = Scope.TryLookupSymbol(syntax.Identifier.Text);
        if (symbol == null)
        {
            // Implicit `this`: if we are inside an instance method body and the
            // name matches a sibling method on the receiver type, dispatch via
            // `this.<method>(args)` automatically.
            if (getCurrentFunction()?.ThisParameter != null
                && getCurrentFunction().ReceiverType is StructSymbol implicitReceiverStruct)
            {
                var implicitOverloads = implicitReceiverStruct.GetMethodsIncludingInherited(syntax.Identifier.Text);
                if (implicitOverloads.Length > 0)
                {
                    var implicitMethod = SelectInstanceOverloadOrReport(implicitOverloads, boundArguments.ToImmutable(), syntax, syntax.Identifier.Text, argumentNames);
                    if (implicitMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    var implicitReceiver = new BoundVariableExpression(null, getCurrentFunction().ThisParameter);
                    return BindUserInstanceCall(implicitReceiver, implicitMethod, boundArguments.ToImmutable(), syntax, argumentNames);
                }
            }

            Diagnostics.ReportUndefinedFunction(syntax.Identifier.Location, syntax.Identifier.Text);
            return new BoundErrorExpression(null);
        }

        // Phase 4.7: invoking a function-typed variable goes through the
        // indirect-call path. Sites like `add(1, 2)` where `add` is `let
        // add func(int, int) int = ...` reduce to BoundIndirectCallExpression.
        if (symbol is VariableSymbol variable && variable.Type is FunctionTypeSymbol fnType)
        {
            // Issue #343: indirect calls through a function-typed variable have
            // no preserved parameter names; named arguments are not allowed.
            if (!argumentNames.IsDefault)
            {
                Diagnostics.ReportNamedArgumentParameterNotFound(syntax.Identifier.Location, variable.Name, FirstNamedArgumentName(argumentNames));
                return new BoundErrorExpression(null);
            }

            if (syntax.Arguments.Count != fnType.Arity)
            {
                Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, variable.Name, fnType.Arity, syntax.Arguments.Count);
                return new BoundErrorExpression(null);
            }

            var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
            for (var i = 0; i < syntax.Arguments.Count; i++)
            {
                convertedArgs.Add(conversions.BindConversion(syntax.Arguments[i].Location, boundArguments[i], fnType.ParameterTypes[i]));
            }

            return new BoundIndirectCallExpression(null, new BoundVariableExpression(null, variable), fnType, convertedArgs.MoveToImmutable());
        }

        // ADR-0059 / issue #255: direct call syntax `h(args)` on a variable
        // of a user-declared named delegate type. Mirrors the CLR-delegate
        // branch below — both end up dispatching through Invoke.
        if (symbol is VariableSymbol namedDelegateVar && namedDelegateVar.Type is DelegateTypeSymbol namedDelegateSym)
        {
            // Issue #343: named-delegate Invoke parameter names live on the
            // delegate-type symbol; they are not surfaced to the call site.
            if (!argumentNames.IsDefault)
            {
                Diagnostics.ReportNamedArgumentParameterNotFound(syntax.Identifier.Location, namedDelegateVar.Name, FirstNamedArgumentName(argumentNames));
                return new BoundErrorExpression(null);
            }

            if (syntax.Arguments.Count != namedDelegateSym.Parameters.Length)
            {
                Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, namedDelegateVar.Name, namedDelegateSym.Parameters.Length, syntax.Arguments.Count);
                return new BoundErrorExpression(null);
            }

            var convertedNamedArgs = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
            for (var i = 0; i < syntax.Arguments.Count; i++)
            {
                convertedNamedArgs.Add(conversions.BindConversion(syntax.Arguments[i].Location, boundArguments[i], namedDelegateSym.Parameters[i].Type));
            }

            return new BoundIndirectCallExpression(null, new BoundVariableExpression(null, namedDelegateVar), namedDelegateSym.EquivalentFunctionType, convertedNamedArgs.MoveToImmutable());
        }

        // #325: a variable whose type is a CLR delegate (e.g. `Func[int32,
        // int32]`, `RequestDelegate`) is callable with call syntax `f(x)`,
        // mirroring native func-typed variables. Lower the call to an
        // invocation of the delegate's `Invoke` method, identical in behavior
        // to the explicit `f.Invoke(x)` form.
        if (symbol is VariableSymbol delegateVar
            && delegateVar.Type?.ClrType is System.Type delegateClrType
            && ClrTypeUtilities.IsDelegateType(delegateClrType))
        {
            var receiver = new BoundVariableExpression(null, delegateVar);
            if (tryBindInheritedClrInstanceCall(receiver, delegateClrType, "Invoke", boundArguments.ToImmutable(), syntax, out var invokeCall, null, default, argumentNames))
            {
                return invokeCall;
            }

            var invoke = delegateClrType.GetMethod("Invoke");
            var expectedArity = invoke?.GetParameters().Length ?? 0;
            if (syntax.Arguments.Count != expectedArity)
            {
                Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, delegateVar.Name, expectedArity, syntax.Arguments.Count);
                return new BoundErrorExpression(null);
            }

            Diagnostics.ReportNotAFunction(syntax.Identifier.Location, syntax.Identifier.Text);
            return new BoundErrorExpression(null);
        }

        var function = symbol as FunctionSymbol;
        if (function == null)
        {
            Diagnostics.ReportNotAFunction(syntax.Identifier.Location, syntax.Identifier.Text);
            return new BoundErrorExpression(null);
        }

        // ADR-0063 §11: when multiple top-level functions share this name,
        // perform overload selection over the supplied argument shape (count
        // and, where useful, types). The legacy `TryLookupSymbol` returned the
        // first declared overload; we now consult the overload-set store.
        var overloadSet = Scope.TryLookupFunctions(syntax.Identifier.Text);
        if (overloadSet.Length > 1)
        {
            var selected = SelectBestUserOverload(overloadSet, syntax.Arguments.Count, argumentNames, boundArguments, out var overloadAmbiguous);
            if (selected == null)
            {
                if (overloadAmbiguous)
                {
                    Diagnostics.ReportAmbiguousOverloadResolution(syntax.Identifier.Location, syntax.Identifier.Text);
                }
                else
                {
                    Diagnostics.ReportNoApplicableOverload(syntax.Identifier.Location, syntax.Identifier.Text);
                }

                return new BoundErrorExpression(null);
            }

            function = selected;
        }

        reportObsoleteUseIfApplicable(syntax.Identifier.Location, function, function.Name);

        var isVariadic = function.Parameters.Length > 0 && function.Parameters[function.Parameters.Length - 1].IsVariadic;
        var fixedParamCount = isVariadic ? function.Parameters.Length - 1 : function.Parameters.Length;

        // ADR-0063: count of leading non-optional parameters (the minimum a
        // call must supply when there are no variadic parameters).
        var requiredParamCount = function.Parameters.Length;
        for (var i = function.Parameters.Length - 1; i >= 0; i--)
        {
            if (function.Parameters[i].HasExplicitDefaultValue)
            {
                requiredParamCount = i;
            }
            else
            {
                break;
            }
        }

        // Issue #343: variadic functions and named arguments do not compose:
        // there is no way to "name" the variadic slot at a call site.
        if (isVariadic && !argumentNames.IsDefault)
        {
            Diagnostics.ReportNamedArgumentParameterNotFound(syntax.Identifier.Location, function.Name, FirstNamedArgumentName(argumentNames));
            return new BoundErrorExpression(null);
        }

        if (isVariadic)
        {
            if (syntax.Arguments.Count < fixedParamCount)
            {
                Diagnostics.ReportTooFewArgumentsForVariadic(syntax.Identifier.Location, function.Name, fixedParamCount, syntax.Arguments.Count);
                return new BoundErrorExpression(null);
            }
        }
        else if (syntax.Arguments.Count < requiredParamCount || syntax.Arguments.Count > function.Parameters.Length)
        {
            TextSpan span;
            if (syntax.Arguments.Count > function.Parameters.Length)
            {
                SyntaxNode firstExceedingNode;
                if (function.Parameters.Length > 0)
                {
                    firstExceedingNode = syntax.Arguments.GetSeparator(function.Parameters.Length - 1);
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

            Diagnostics.ReportWrongArgumentCount(new TextLocation(syntax.Location.Text, span), function.Name, function.Parameters.Length, syntax.Arguments.Count);
            return new BoundErrorExpression(null);
        }

        // Issue #343: when the call site mixes positional and named arguments,
        // reorder the bound arguments into the function's parameter order so
        // the existing per-position passes operate as if every argument were
        // positional. `parameterSyntax[i]` carries the source-syntax node at
        // parameter position `i` (preserving locations for diagnostics).
        // ADR-0063: when there are optional parameters, omitted slots are left
        // empty in the reorder output, then filled with default-value
        // BoundLiteralExpression here.
        ExpressionSyntax[] parameterSyntax;
        var hasOptional = function.Parameters.Length > 0 && requiredParamCount < function.Parameters.Length && !isVariadic;
        if (!argumentNames.IsDefault || (hasOptional && syntax.Arguments.Count < function.Parameters.Length))
        {
            if (!TryReorderUserCallArguments(
                    syntax.Arguments,
                    boundArguments.ToImmutable(),
                    function.Parameters.Length,
                    p => function.Parameters[p].Name,
                    hasOptional ? (p => function.Parameters[p].HasExplicitDefaultValue) : (System.Func<int, bool>)null,
                    function.Name,
                    out parameterSyntax,
                    out var permutedBound))
            {
                return new BoundErrorExpression(null);
            }

            boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(permutedBound.Length);
            for (var i = 0; i < permutedBound.Length; i++)
            {
                if (permutedBound[i] == null)
                {
                    // ADR-0063: fill the omitted optional slot with the parameter's default.
                    boundArguments.Add(CreateOptionalUserDefaultArgument(function.Parameters[i]));
                }
                else
                {
                    boundArguments.Add(permutedBound[i]);
                }
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

        bool hasErrors = false;

        // Phase 4.1 / ADR-0020: if the callee is generic, build the type
        // substitution either from the explicit `[T1, T2]` list at the call
        // site or by left-to-right inference from argument types matched
        // against parameter types.
        Dictionary<TypeParameterSymbol, TypeSymbol> substitution = null;
        if (function.IsGeneric)
        {
            substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
            if (syntax.TypeArgumentList != null)
            {
                var explicitArgs = syntax.TypeArgumentList.Arguments;
                if (explicitArgs.Count != function.TypeParameters.Length)
                {
                    Diagnostics.ReportWrongTypeArgumentCount(syntax.TypeArgumentList.Location, function.Name, function.TypeParameters.Length, explicitArgs.Count);
                    return new BoundErrorExpression(null);
                }

                for (var i = 0; i < explicitArgs.Count; i++)
                {
                    var ta = bindTypeClause(explicitArgs[i]);
                    if (ta == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    substitution[function.TypeParameters[i]] = ta;
                }
            }
            else
            {
                for (var i = 0; i < function.Parameters.Length && i < boundArguments.Count; i++)
                {
                    inferTypeArguments(function.Parameters[i].Type, boundArguments[i].Type, substitution);
                }

                foreach (var tp in function.TypeParameters)
                {
                    if (!substitution.ContainsKey(tp))
                    {
                        Diagnostics.ReportTypeArgumentInferenceFailed(syntax.Identifier.Location, function.Name, tp.Name);
                        return new BoundErrorExpression(null);
                    }
                }
            }

            // Phase 4.2 / ADR-0020: each substituted type argument must satisfy
            // its type parameter's declared constraint.
            var constraintLocation = syntax.TypeArgumentList != null
                ? syntax.TypeArgumentList.Location
                : syntax.Identifier.Location;
            foreach (var tp in function.TypeParameters)
            {
                var typeArg = substitution[tp];
                if (!satisfiesConstraint(typeArg, tp))
                {
                    Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(constraintLocation, tp.Name, typeArg, describeConstraint(tp));
                    return new BoundErrorExpression(null);
                }
            }
        }

        for (var i = 0; i < fixedParamCount; i++)
        {
            var argument = boundArguments[i];
            var parameter = function.Parameters[i];
            var expectedType = substitution != null ? substituteType(parameter.Type, substitution) : parameter.Type;

            // ADR-0060: ref-kind argument matching. The argument's syntax must
            // carry the same `ref`/`out`/`in` modifier as the parameter; for `in`
            // the modifier is required (warning GS0242 is reported when omitted).
            // ADR-0060 §1 back-compat: a bare `&x` (BoundAddressOfExpression
            // without a RefArgumentExpressionSyntax wrapper) is universally
            // compatible with any ref-kind parameter (existing ADR-0039 behaviour).
            if (parameter.RefKind != RefKind.None || (i < parameterSyntax.Length && parameterSyntax[i] is RefArgumentExpressionSyntax))
            {
                var argSyntax = i < parameterSyntax.Length ? parameterSyntax[i] : null;
                var argRefKind = RefKind.None;
                if (argSyntax is RefArgumentExpressionSyntax refArgSyntax)
                {
                    argRefKind = getRefKindFromModifier(refArgSyntax.RefKindModifier);
                }

                // Back-compat: bare `&x` (UnaryExpression with AmpersandToken,
                // bound to BoundAddressOfExpression) is universally compatible
                // with any ref-kind parameter. Treat it as if the user wrote the
                // matching keyword. ADR-0061: same back-compat applies to the
                // bare `&(cond ? a : b)` conditional address-of form.
                bool isBareAddressOf = argRefKind == RefKind.None
                    && (argument is BoundAddressOfExpression || argument is BoundConditionalAddressExpression)
                    && parameter.RefKind != RefKind.None;
                if (isBareAddressOf)
                {
                    argRefKind = parameter.RefKind;
                }

                if (argRefKind != parameter.RefKind)
                {
                    if (parameter.RefKind == RefKind.In && argRefKind == RefKind.None)
                    {
                        // GS0242: warn on `in` without explicit modifier; the call site is
                        // still rejected as a type error (the value isn't an address) unless
                        // we rebind under the `in` modifier — but ADR §1 says we do NOT
                        // silently spill. So this remains a hard error.
                        Diagnostics.ReportInArgumentMissingInModifier(argSyntax?.Location ?? syntax.Location, i + 1, parameter.Name);
                        hasErrors = true;
                        continue;
                    }

                    Diagnostics.ReportRefKindMismatch(
                        argSyntax?.Location ?? syntax.Location,
                        i + 1,
                        parameter.Name,
                        refKindToString(parameter.RefKind),
                        refKindToString(argRefKind));
                    hasErrors = true;
                    continue;
                }

                // Modifiers match. The bound argument is BoundAddressOfExpression
                // (or, ADR-0061, BoundConditionalAddressExpression) whose
                // operand/pointee type must match the parameter's pointee type.
                if (argument is BoundAddressOfExpression addr)
                {
                    var operandType = addr.Operand.Type;

                    // ADR-0060: an inline-decl `out var n` / `out let n` / `out _`
                    // was bound with TypeSymbol.Error in the first pass because
                    // the parameter was unknown. Re-bind now that overload
                    // resolution has chosen the function and the parameter
                    // pointee type is known.
                    if (operandType == TypeSymbol.Error
                        && i < parameterSyntax.Length
                        && parameterSyntax[i] is RefArgumentExpressionSyntax refArgFixup
                        && refArgFixup.IsInlineDeclaration
                        && refArgFixup.DeclaredType == null)
                    {
                        boundArguments[i] = bindRefArgumentExpression(refArgFixup, parameter);
                        continue;
                    }

                    if (operandType != expectedType && operandType != TypeSymbol.Error)
                    {
                        Diagnostics.ReportWrongArgumentType(parameterSyntax[i].Location, parameter.Name, expectedType, operandType);
                        hasErrors = true;
                    }
                }
                else if (argument is BoundConditionalAddressExpression condAddrArg)
                {
                    var pointeeType = condAddrArg.PointeeType;
                    if (pointeeType != expectedType && pointeeType != TypeSymbol.Error)
                    {
                        Diagnostics.ReportWrongArgumentType(parameterSyntax[i].Location, parameter.Name, expectedType, pointeeType);
                        hasErrors = true;
                    }
                }

                continue;
            }

            if (substitution != null
                && parameter.Type is FunctionTypeSymbol openFunctionParameter
                && tryGetFunctionLiteral(argument, out var functionLiteralArgument))
            {
                boundArguments[i] = createErasedFunctionLiteralAdapter(functionLiteralArgument, openFunctionParameter);
                continue;
            }

            // ADR-0055 Tier 4 (#369): an interpolated-string argument bound
            // against an IFormattable/FormattableString parameter is re-lowered
            // to FormattableStringFactory.Create instead of an eager string. Only
            // applies in the non-generic case (a type parameter is never a
            // formattable target).
            if (substitution == null
                && i < parameterSyntax.Length
                && parameterSyntax[i] is InterpolatedStringExpressionSyntax interpolatedArg
                && isFormattableStringTargetType(expectedType))
            {
                boundArguments[i] = bindInterpolatedStringAsFormattable(interpolatedArg, expectedType);
                continue;
            }

            if (argument.Type != expectedType
                && !(substitution != null && TypeSymbol.ContainsTypeParameter(parameter.Type))
                && !Conversion.Classify(argument.Type, expectedType).IsImplicit)
            {
                if (conversions.TryApplyUserDefinedImplicitArgumentConversion(argument, expectedType, out var convertedArg))
                {
                    boundArguments[i] = convertedArg;
                    continue;
                }

                if (argument.Type != TypeSymbol.Error)
                {
                    Diagnostics.ReportWrongArgumentType(parameterSyntax[i].Location, parameter.Name, expectedType, argument.Type);
                }

                hasErrors = true;
            }
            else if (argument.Type != expectedType
                && expectedType is NullableTypeSymbol ntConv
                && ntConv.UnderlyingType?.ClrType is { IsValueType: true })
            {
                // Issue #533: conversions to a value-type Nullable<T> parameter
                // need explicit lowering:
                // - nil → Nullable<T> becomes BoundDefaultExpression (initobj)
                // - T → Nullable<T> becomes BoundConversionExpression (newobj ctor)
                var argLoc = i < parameterSyntax.Length ? parameterSyntax[i].Location : syntax.Identifier.Location;
                boundArguments[i] = conversions.BindConversion(argLoc, argument, expectedType);
            }
        }

        // Phase 4.8: type-check trailing variadic arguments against the slice
        // element type, then pack them into a single slice-typed argument.
        if (isVariadic)
        {
            var variadicParam = function.Parameters[function.Parameters.Length - 1];
            var sliceType = (SliceTypeSymbol)variadicParam.Type;
            var elementType = sliceType.ElementType;
            for (var i = fixedParamCount; i < syntax.Arguments.Count; i++)
            {
                var argument = boundArguments[i];
                if (argument.Type != elementType && argument.Type != TypeSymbol.Error)
                {
                    Diagnostics.ReportWrongArgumentType(syntax.Arguments[i].Location, variadicParam.Name, elementType, argument.Type);
                    hasErrors = true;
                }
            }

            if (!hasErrors)
            {
                var packed = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count - fixedParamCount);
                for (var i = fixedParamCount; i < syntax.Arguments.Count; i++)
                {
                    packed.Add(boundArguments[i]);
                }

                var finalArgs = ImmutableArray.CreateBuilder<BoundExpression>(fixedParamCount + 1);
                for (var i = 0; i < fixedParamCount; i++)
                {
                    finalArgs.Add(boundArguments[i]);
                }

                finalArgs.Add(new BoundArrayCreationExpression(syntax, sliceType, packed.MoveToImmutable()));
                boundArguments = finalArgs;
            }
        }

        if (hasErrors)
        {
            return new BoundErrorExpression(syntax);
        }

        if (substitution != null)
        {
            var returnType = substituteType(function.Type, substitution);
            if (function.IsAsync && !isAsyncIteratorReturnType(function.Type))
            {
                returnType = wrapAsTask(returnType);
            }

            return CreatePossiblyElidedCall(function, boundArguments.ToImmutable(), returnType);
        }

        if (function.IsAsync && !isAsyncIteratorReturnType(function.Type))
        {
            var asyncReturn = wrapAsTask(function.Type);
            return CreatePossiblyElidedCall(function, boundArguments.ToImmutable(), asyncReturn);
        }

        return CreatePossiblyElidedCall(function, boundArguments.ToImmutable(), returnType: null);
    }

    /// <summary>
    /// Constructs a <see cref="BoundCallExpression"/> for a direct function
    /// call, applying ADR-0047 §6 / issue #176 <c>[Conditional]</c> call-site
    /// elision. When elision applies, the resulting call carries an empty
    /// argument list (C# semantics: arguments to a conditional method are
    /// not evaluated when the symbol is undefined) and the
    /// <see cref="BoundCallExpression.IsConditionalElided"/> flag is set so
    /// the emitter and interpreter skip both argument evaluation and the
    /// method invocation. The validation that the function returns
    /// <c>void</c> was performed at declaration time (GS0212), so callers
    /// can rely on the elided call being a no-op of type <c>void</c>.
    /// Argument binding still ran above so wrong-type diagnostics on the
    /// elided arguments are reported normally.
    /// </summary>
    private BoundExpression CreatePossiblyElidedCall(FunctionSymbol function, ImmutableArray<BoundExpression> arguments, TypeSymbol returnType)
    {
        if (KnownAttributes.IsConditionallyElided(function.Attributes, Scope.PreprocessorSymbols))
        {
            return new BoundCallExpression(null, function, ImmutableArray<BoundExpression>.Empty, returnType, isConditionalElided: true);
        }

        return new BoundCallExpression(null, function, arguments, returnType);
    }

    public BoundExpression BindExtensionFunctionCall(BoundExpression receiver, FunctionSymbol extension, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce, ImmutableArray<string> argumentNames = default)
    {
        // The extension's first parameter is the receiver; user arguments line
        // up against parameters[1..].
        var userParamCount = extension.Parameters.Length - 1;
        if (arguments.Length != userParamCount)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, extension.Name, userParamCount, arguments.Length);
            return new BoundErrorExpression(null);
        }

        // Issue #343: reorder named arguments into the extension's parameter
        // order (excluding the synthetic receiver slot). User extensions have
        // no default parameter values, so every callable parameter must be filled.
        ExpressionSyntax[] permutedSyntax;
        ImmutableArray<BoundExpression> permutedArguments;
        if (!argumentNames.IsDefault)
        {
            if (!TryReorderUserCallArguments(
                    ce.Arguments,
                    arguments,
                    userParamCount,
                    p => extension.Parameters[p + 1].Name,
                    extension.Name,
                    out permutedSyntax,
                    out permutedArguments))
            {
                return new BoundErrorExpression(null);
            }
        }
        else
        {
            permutedSyntax = new ExpressionSyntax[ce.Arguments.Count];
            for (var i = 0; i < ce.Arguments.Count; i++)
            {
                permutedSyntax[i] = ce.Arguments[i];
            }

            permutedArguments = arguments;
        }

        // Issue #326: a generic extension function
        // `func (r R) Name[T](item T) T` resolves its type parameters either
        // from an explicit `[T1, T2]` type-argument list at the call site or by
        // left-to-right inference from the receiver and argument types matched
        // against the declared parameter types. Mirrors the free-function
        // generic path (Phase 4.1 / ADR-0020).
        Dictionary<TypeParameterSymbol, TypeSymbol> substitution = null;
        if (extension.IsGeneric)
        {
            substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
            if (ce.TypeArgumentList != null)
            {
                var explicitArgs = ce.TypeArgumentList.Arguments;
                if (explicitArgs.Count != extension.TypeParameters.Length)
                {
                    Diagnostics.ReportWrongTypeArgumentCount(ce.TypeArgumentList.Location, extension.Name, extension.TypeParameters.Length, explicitArgs.Count);
                    return new BoundErrorExpression(null);
                }

                for (var i = 0; i < explicitArgs.Count; i++)
                {
                    var ta = bindTypeClause(explicitArgs[i]);
                    if (ta == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    substitution[extension.TypeParameters[i]] = ta;
                }
            }
            else
            {
                // The receiver lines up against parameters[0]; user arguments
                // against parameters[1..]. Inferring from the receiver too lets
                // a generic receiver type (e.g. `func (s []T) ...`) bind T.
                if (receiver?.Type != null)
                {
                    inferTypeArguments(extension.Parameters[0].Type, receiver.Type, substitution);
                }

                for (var i = 0; i < permutedArguments.Length; i++)
                {
                    if (permutedArguments[i].Type != null)
                    {
                        inferTypeArguments(extension.Parameters[i + 1].Type, permutedArguments[i].Type, substitution);
                    }
                }

                foreach (var tp in extension.TypeParameters)
                {
                    if (!substitution.ContainsKey(tp))
                    {
                        Diagnostics.ReportTypeArgumentInferenceFailed(ce.Identifier.Location, extension.Name, tp.Name);
                        return new BoundErrorExpression(null);
                    }
                }
            }

            // Phase 4.2 / ADR-0020: each substituted type argument must satisfy
            // its type parameter's declared constraint.
            var constraintLocation = ce.TypeArgumentList != null
                ? ce.TypeArgumentList.Location
                : ce.Identifier.Location;
            foreach (var tp in extension.TypeParameters)
            {
                var typeArg = substitution[tp];
                if (!satisfiesConstraint(typeArg, tp))
                {
                    Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(constraintLocation, tp.Name, typeArg, describeConstraint(tp));
                    return new BoundErrorExpression(null);
                }
            }
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(extension.Parameters.Length);
        var receiverParamType = substitution != null ? substituteType(extension.Parameters[0].Type, substitution) : extension.Parameters[0].Type;
        convertedArgs.Add(conversions.BindConversion(ce.Location, receiver, receiverParamType));
        for (var i = 0; i < permutedArguments.Length; i++)
        {
            var paramType = extension.Parameters[i + 1].Type;
            if (substitution != null && TypeSymbol.ContainsTypeParameter(paramType))
            {
                if (paramType is FunctionTypeSymbol openFunctionParameter
                    && tryGetFunctionLiteral(permutedArguments[i], out var functionLiteralArgument))
                {
                    convertedArgs.Add(createErasedFunctionLiteralAdapter(functionLiteralArgument, openFunctionParameter));
                    continue;
                }

                // A parameter typed as an open T is encoded as System.Object in
                // the emitted signature; pass the argument unconverted so the
                // emitter inserts box / unbox.any around the erased boundary.
                convertedArgs.Add(permutedArguments[i]);
            }
            else
            {
                var expectedType = substitution != null ? substituteType(paramType, substitution) : paramType;
                convertedArgs.Add(conversions.BindCallArgumentWithRefKind(permutedSyntax[i].Location, permutedArguments[i], expectedType, extension.Parameters[i + 1]));
            }
        }

        if (substitution != null)
        {
            var returnType = substituteType(extension.Type, substitution);
            return new BoundCallExpression(null, extension, convertedArgs.MoveToImmutable(), returnType);
        }

        return new BoundCallExpression(null, extension, convertedArgs.MoveToImmutable());
    }

    public BoundExpression BindUserInstanceCall(BoundExpression receiver, FunctionSymbol method, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce, ImmutableArray<string> argumentNames = default)
    {
        var parameterOffset = method.ExplicitReceiverParameter == null ? 0 : 1;
        var callableParameterCount = method.Parameters.Length - parameterOffset;
        if (arguments.Length != callableParameterCount)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, method.Name, callableParameterCount, arguments.Length);
            return new BoundErrorExpression(null);
        }

        // Issue #343: reorder named arguments into the method's parameter
        // order. User-defined methods have no default parameter values, so
        // every parameter slot must be filled.
        ExpressionSyntax[] permutedSyntax;
        ImmutableArray<BoundExpression> permutedArguments;
        if (!argumentNames.IsDefault)
        {
            if (!TryReorderUserCallArguments(
                    ce.Arguments,
                    arguments,
                    callableParameterCount,
                    p => method.Parameters[p + parameterOffset].Name,
                    method.Name,
                    out permutedSyntax,
                    out permutedArguments))
            {
                return new BoundErrorExpression(null);
            }
        }
        else
        {
            permutedSyntax = new ExpressionSyntax[ce.Arguments.Count];
            for (var i = 0; i < ce.Arguments.Count; i++)
            {
                permutedSyntax[i] = ce.Arguments[i];
            }

            permutedArguments = arguments;
        }

        // Phase 4.3b / ADR-0020: if the receiver is a constructed generic
        // class/struct, substitute the method's parameter types and return
        // type with the receiver's type-argument map. The method symbol
        // itself (and its bound body) are kept intact so runtime dispatch
        // through program.Functions[method] continues to work.
        Dictionary<TypeParameterSymbol, TypeSymbol> substitution = TryBuildReceiverSubstitution(receiver.Type);

        // Issue #312 / ADR-0020: the method may declare its own generic
        // type-parameter list (`func M[T](...) T`). Resolve those type
        // arguments from an explicit `[T1, T2]` list at the call site or by
        // left-to-right inference from argument types, then fold them into the
        // same substitution map used for the receiver's type arguments.
        if (method.IsGeneric)
        {
            if (substitution == null)
            {
                substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
            }

            if (ce.TypeArgumentList != null)
            {
                var explicitArgs = ce.TypeArgumentList.Arguments;
                if (explicitArgs.Count != method.TypeParameters.Length)
                {
                    Diagnostics.ReportWrongTypeArgumentCount(ce.TypeArgumentList.Location, method.Name, method.TypeParameters.Length, explicitArgs.Count);
                    return new BoundErrorExpression(null);
                }

                for (var i = 0; i < explicitArgs.Count; i++)
                {
                    var ta = bindTypeClause(explicitArgs[i]);
                    if (ta == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    substitution[method.TypeParameters[i]] = ta;
                }
            }
            else
            {
                for (var i = 0; i < permutedArguments.Length; i++)
                {
                    inferTypeArguments(method.Parameters[i + parameterOffset].Type, permutedArguments[i].Type, substitution);
                }

                foreach (var tp in method.TypeParameters)
                {
                    if (!substitution.ContainsKey(tp))
                    {
                        Diagnostics.ReportTypeArgumentInferenceFailed(ce.Identifier.Location, method.Name, tp.Name);
                        return new BoundErrorExpression(null);
                    }
                }
            }

            // Phase 4.2 / ADR-0020: each substituted type argument must satisfy
            // its type parameter's declared constraint.
            var constraintLocation = ce.TypeArgumentList != null
                ? ce.TypeArgumentList.Location
                : ce.Identifier.Location;
            foreach (var tp in method.TypeParameters)
            {
                var typeArg = substitution[tp];
                if (!satisfiesConstraint(typeArg, tp))
                {
                    Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(constraintLocation, tp.Name, typeArg, describeConstraint(tp));
                    return new BoundErrorExpression(null);
                }
            }
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(permutedArguments.Length);
        for (var i = 0; i < permutedArguments.Length; i++)
        {
            var paramType = method.Parameters[i + parameterOffset].Type;

            // An argument bound to an open type parameter is left untouched —
            // the emitter boxes value types at the call boundary (the parameter
            // is encoded as System.Object under the type-erased model).
            if (paramType is TypeParameterSymbol)
            {
                convertedArgs.Add(permutedArguments[i]);
                continue;
            }

            var expectedType = substitution != null ? substituteType(paramType, substitution) : paramType;

            if (substitution != null
                && tryGetFunctionLiteral(permutedArguments[i], out var functionLiteralArgument))
            {
                if (paramType is FunctionTypeSymbol openFunctionParameter)
                {
                    convertedArgs.Add(createErasedFunctionLiteralAdapter(functionLiteralArgument, openFunctionParameter));
                    continue;
                }

                if (MemberLookup.TryGetDelegateFunctionType(paramType.ClrType ?? expectedType.ClrType, out var targetDelegateFunctionType)
                    && functionLiteralArgument.FunctionType != targetDelegateFunctionType)
                {
                    convertedArgs.Add(createErasedFunctionLiteralAdapter(functionLiteralArgument, targetDelegateFunctionType));
                    continue;
                }
            }

            // ADR-0055 Tier 4 (#369): re-lower an interpolated-string argument to
            // FormattableStringFactory.Create when the parameter is
            // IFormattable/FormattableString.
            var argSyntaxForInterp = UnwrapNamedArgumentValue(permutedSyntax[i]);
            if (argSyntaxForInterp is InterpolatedStringExpressionSyntax interpolatedArg
                && isFormattableStringTargetType(expectedType))
            {
                convertedArgs.Add(bindInterpolatedStringAsFormattable(interpolatedArg, expectedType));
                continue;
            }

            convertedArgs.Add(conversions.BindCallArgumentWithRefKind(permutedSyntax[i].Location, permutedArguments[i], expectedType, method.Parameters[i + parameterOffset]));
        }

        if (substitution != null)
        {
            var substitutedReturn = substituteType(method.Type, substitution);
            if (method.IsAsync && !isAsyncIteratorReturnType(method.Type))
            {
                substitutedReturn = wrapAsTask(substitutedReturn);
                return new BoundUserInstanceCallExpression(null, receiver, method, convertedArgs.ToImmutable(), substitutedReturn);
            }

            if (!ReferenceEquals(substitutedReturn, method.Type))
            {
                return new BoundUserInstanceCallExpression(null, receiver, method, convertedArgs.ToImmutable(), substitutedReturn);
            }
        }

        // Issue #502: an async instance method's call-site return type is
        // Task / Task[T], not the underlying T. Wrap here so the call
        // expression's static type matches the kickoff method's return type.
        if (method.IsAsync && !isAsyncIteratorReturnType(method.Type))
        {
            var asyncReturn = wrapAsTask(method.Type);
            return new BoundUserInstanceCallExpression(null, receiver, method, convertedArgs.ToImmutable(), asyncReturn);
        }

        return new BoundUserInstanceCallExpression(null, receiver, method, convertedArgs.ToImmutable());
    }

    private static Dictionary<TypeParameterSymbol, TypeSymbol> TryBuildReceiverSubstitution(TypeSymbol receiverType)
    {
        if (receiverType is StructSymbol s
            && !s.TypeArguments.IsDefaultOrEmpty
            && s.Definition != null
            && !ReferenceEquals(s.Definition, s))
        {
            var defTps = s.Definition.TypeParameters;
            if (!defTps.IsDefaultOrEmpty && defTps.Length == s.TypeArguments.Length)
            {
                var map = new Dictionary<TypeParameterSymbol, TypeSymbol>(defTps.Length);
                for (var i = 0; i < defTps.Length; i++)
                {
                    map[defTps[i]] = s.TypeArguments[i];
                }

                return map;
            }
        }

        return null;
    }
}
