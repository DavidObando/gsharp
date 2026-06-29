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
    private readonly Func<ExpressionSyntax, TypeSymbol, BoundExpression> bindExpressionWithTargetType;
    private readonly Func<RefArgumentExpressionSyntax, ParameterSymbol, BoundExpression> bindRefArgumentExpression;
    private readonly Func<BoundExpression, ExpressionSyntax, ParameterSymbol, TypeSymbol, BoundExpression> tryRebindInlineOutVarPlaceholder;
    private readonly Func<TypeClauseSyntax, TypeSymbol> bindTypeClause;
    private readonly Func<string, TypeSymbol> lookupType;

    // Issue #1263: arity-aware type lookup. When a construction carries an
    // explicit type-argument list (`Op[int32](5)`), the constructed type name
    // must be resolved by (name, arity) so a non-generic `Op` and a generic
    // `Op[T]` can coexist — mirroring the #1051 disambiguation already used by
    // the type-reference and struct-literal paths. A negative arity means "no
    // preference" and falls back to the arity-0 type.
    private readonly Func<string, int, TypeSymbol> lookupTypeWithArity;
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
    private readonly Func<LambdaExpressionSyntax, FunctionTypeSymbol, BoundExpression> bindLambdaWithTarget;
    private readonly Func<StructSymbol, CallExpressionSyntax, BoundExpression> bindUserTypeStaticCall;

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
    /// <param name="bindExpressionWithTargetType">Issue #1238: callback that
    /// (re)binds an expression with an explicit target type, used to finalize a
    /// deferred target-typed conditional/if/switch argument against its resolved
    /// parameter type.</param>
    /// <param name="bindRefArgumentExpression">Callback to bind a
    /// <see cref="RefArgumentExpressionSyntax"/> against a known parameter
    /// symbol (or <c>null</c> in the first, parameter-unknown, pass).</param>
    /// <param name="tryRebindInlineOutVarPlaceholder">Callback that re-binds a
    /// first-pass inline out-var placeholder once the callee/parameter is
    /// resolved, returning the rebound expression (or <c>null</c> when the
    /// argument is not an inline out-var placeholder).</param>
    /// <param name="bindTypeClause">Callback to bind a
    /// <see cref="TypeClauseSyntax"/> to a <see cref="TypeSymbol"/>.</param>
    /// <param name="lookupType">Callback to resolve a bare type name to a
    /// <see cref="TypeSymbol"/> in the current binding context.</param>
    /// <param name="lookupTypeWithArity">Callback to resolve a type name by
    /// (name, generic arity), used at construction sites so a non-generic and a
    /// same-named generic type can be disambiguated by the supplied
    /// type-argument count (issue #1263).</param>
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
    /// <param name="bindLambdaWithTarget">Issue #951: callback that binds an
    /// arrow-lambda syntax against a target <see cref="FunctionTypeSymbol"/>,
    /// used to target-type a deferred un-typed arrow-lambda argument from the
    /// resolved parameter's delegate shape. May be <see langword="null"/>.</param>
    /// <param name="bindUserTypeStaticCall">Issue #1147: callback that finalizes
    /// a <c>Type.Method(args)</c> static (<c>shared</c>) user call against a
    /// resolved struct/class, used by the unqualified implicit-<c>this</c> path
    /// when unified instance+static overload resolution selects a static sibling.
    /// May be <see langword="null"/>.</param>
    public OverloadResolver(
        BinderContext binderCtx,
        MemberLookup memberLookup,
        ConversionClassifier conversions,
        Func<ExpressionSyntax, BoundExpression> bindExpression,
        Func<ExpressionSyntax, TypeSymbol, BoundExpression> bindExpressionWithTargetType,
        Func<RefArgumentExpressionSyntax, ParameterSymbol, BoundExpression> bindRefArgumentExpression,
        Func<BoundExpression, ExpressionSyntax, ParameterSymbol, TypeSymbol, BoundExpression> tryRebindInlineOutVarPlaceholder,
        Func<TypeClauseSyntax, TypeSymbol> bindTypeClause,
        Func<string, TypeSymbol> lookupType,
        Func<string, int, TypeSymbol> lookupTypeWithArity,
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
        Func<FunctionSymbol> getCurrentFunction,
        Func<LambdaExpressionSyntax, FunctionTypeSymbol, BoundExpression> bindLambdaWithTarget = null,
        Func<StructSymbol, CallExpressionSyntax, BoundExpression> bindUserTypeStaticCall = null)
    {
        this.binderCtx = binderCtx ?? throw new ArgumentNullException(nameof(binderCtx));
        this.memberLookup = memberLookup ?? throw new ArgumentNullException(nameof(memberLookup));
        this.conversions = conversions ?? throw new ArgumentNullException(nameof(conversions));
        this.bindExpression = bindExpression ?? throw new ArgumentNullException(nameof(bindExpression));
        this.bindExpressionWithTargetType = bindExpressionWithTargetType ?? throw new ArgumentNullException(nameof(bindExpressionWithTargetType));
        this.bindRefArgumentExpression = bindRefArgumentExpression ?? throw new ArgumentNullException(nameof(bindRefArgumentExpression));
        this.tryRebindInlineOutVarPlaceholder = tryRebindInlineOutVarPlaceholder ?? throw new ArgumentNullException(nameof(tryRebindInlineOutVarPlaceholder));
        this.bindTypeClause = bindTypeClause ?? throw new ArgumentNullException(nameof(bindTypeClause));
        this.lookupType = lookupType ?? throw new ArgumentNullException(nameof(lookupType));
        this.lookupTypeWithArity = lookupTypeWithArity ?? throw new ArgumentNullException(nameof(lookupTypeWithArity));
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
        this.bindLambdaWithTarget = bindLambdaWithTarget;
        this.bindUserTypeStaticCall = bindUserTypeStaticCall;
    }

    private DiagnosticBag Diagnostics => binderCtx.Diagnostics;

    private BoundScope Scope => binderCtx.RootScope;

    /// <summary>
    /// Issue #1159: returns the implicit-<c>this</c> parameter that an
    /// unqualified instance-member reference should bind against. For a direct
    /// instance method (or interface default method) body this is the enclosing
    /// function's own <see cref="FunctionSymbol.ThisParameter"/>. Inside a
    /// lambda body the enclosing function is a synthetic
    /// <see cref="FunctionSymbol"/> with no receiver, so we fall back to the
    /// <c>this</c> that is still visible in the current lexical scope — the
    /// enclosing instance method's <c>this</c>, which the lambda's child scope
    /// inherits and which capture analysis already captures into the display
    /// class (mirroring how explicit <c>this.X</c> and bare field/property
    /// reads already work and capture). In a static context no <c>this</c> is
    /// in scope, so this returns <see langword="null"/> and unqualified
    /// resolution stays unchanged.
    /// </summary>
    private ParameterSymbol GetEffectiveThisParameter()
    {
        var current = getCurrentFunction();
        if (current?.ThisParameter != null)
        {
            return current.ThisParameter;
        }

        return Scope.TryLookupSymbol("this") as ParameterSymbol;
    }

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
            || !MemberLookup.TryGetDelegateFunctionTypeFromSymbol(expectedType, out var targetFnType)
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

        // Issue #1124: a call may carry an explicit method type-argument list
        // (e.g. `Factory.Make[Box](...)`). Thread its arity into overload
        // selection so generic candidates are filtered for applicability against
        // either the explicit type arguments or, in their absence, type inference.
        var explicitTypeArgCount = ce.TypeArgumentList?.Arguments.Count ?? 0;
        var selected = SelectBestInstanceOverload(overloads, arguments.Length, argumentNames, arguments, out var ambiguous, explicitTypeArgCount);
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

    /// <summary>
    /// Issue #1147: builds the <em>unified</em> instance + static (<c>shared</c>)
    /// method group for <paramref name="structSym"/>.<paramref name="methodName"/>
    /// and selects the single best applicable overload across BOTH buckets,
    /// reporting the standard ambiguity / no-applicable-overload diagnostics. This
    /// implements C#'s combined instance+static overload resolution that both the
    /// "Color Color" receiver-disambiguation (ECMA-334 §12.8.7.1) and an
    /// unqualified same-named call inside an instance method reduce to. The
    /// selected method's <see cref="FunctionSymbol.IsStatic"/> tells the caller
    /// whether to finalize the call as an instance or a static dispatch.
    /// </summary>
    /// <param name="structSym">The user struct/class whose method group is searched.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="arguments">The already-bound call arguments.</param>
    /// <param name="ce">The originating call syntax (for diagnostic locations / type-arg arity).</param>
    /// <param name="argumentNames">The named-argument layout, or default.</param>
    /// <param name="hasCandidates">Set to <see langword="true"/> when the union
    /// was non-empty. When this is <see langword="false"/> the caller should fall
    /// through to its existing not-found path so a genuinely-undefined name still
    /// reports GS0130.</param>
    /// <returns>The selected overload, or <see langword="null"/> (after a
    /// diagnostic) when the non-empty union had no applicable overload.</returns>
    public FunctionSymbol SelectUnifiedInstanceStaticOverload(
        StructSymbol structSym,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames,
        out bool hasCandidates)
    {
        var instanceGroup = TypeMemberModel.GetMethods(structSym, methodName, MemberQuery.Instance(MemberKinds.Method));
        var staticGroup = TypeMemberModel.GetMethods(structSym, methodName, MemberQuery.Static(MemberKinds.Method));
        var unified = instanceGroup.IsDefaultOrEmpty
            ? staticGroup
            : staticGroup.IsDefaultOrEmpty
                ? instanceGroup
                : instanceGroup.AddRange(staticGroup);

        hasCandidates = !unified.IsDefaultOrEmpty;
        if (!hasCandidates)
        {
            return null;
        }

        return SelectInstanceOverloadOrReport(unified, arguments, ce, methodName, argumentNames);
    }

    private FunctionSymbol SelectBestUserOverload(
        ImmutableArray<FunctionSymbol> candidates,
        int argumentCount,
        ImmutableArray<string> argumentNames,
        ImmutableArray<BoundExpression>.Builder boundArguments,
        out bool ambiguous,
        int explicitTypeArgCount = 0)
    {
        return SelectBestUserOverloadCore(candidates, argumentCount, argumentNames, boundArguments, out ambiguous, explicitTypeArgCount);
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
        out bool ambiguous,
        int explicitTypeArgCount = 0)
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
        return SelectBestUserOverloadCore(candidates, argumentCount, argumentNames, builder, out ambiguous, explicitTypeArgCount);
    }

    private FunctionSymbol SelectBestUserOverloadCore(
        ImmutableArray<FunctionSymbol> candidates,
        int argumentCount,
        ImmutableArray<string> argumentNames,
        ImmutableArray<BoundExpression>.Builder boundArguments,
        out bool ambiguous,
        int explicitTypeArgCount = 0)
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

        // Issue #1124: a generic candidate whose method type parameters cannot be
        // determined for the call is not applicable (C# §11.6.4.2 "if type
        // inference fails, the method is not a candidate"). Without an explicit
        // type-argument list this means every type parameter must be inferable
        // from the argument types; with an explicit list it means the candidate
        // must be generic of matching arity (a non-generic overload cannot accept
        // type arguments). Dropping such candidates here prevents a uninferable
        // generic overload from tying with — and thus being reported ambiguous
        // (GS0266) against — an otherwise-unique non-generic best match.
        if (applicable.Count > 1)
        {
            var filtered = new List<FunctionSymbol>(applicable.Count);
            foreach (var cand in applicable)
            {
                if (explicitTypeArgCount > 0)
                {
                    if (cand.IsGeneric && cand.TypeParameters.Length == explicitTypeArgCount)
                    {
                        filtered.Add(cand);
                    }
                }
                else if (cand.IsGeneric)
                {
                    if (AllMethodTypeParametersInferable(cand, boundArguments, argumentCount))
                    {
                        filtered.Add(cand);
                    }
                }
                else
                {
                    filtered.Add(cand);
                }
            }

            // Only adopt the filtered set when it leaves at least one candidate;
            // an empty result means the call shape is genuinely unsatisfiable and
            // the pre-existing diagnostics on the unfiltered set are preferable.
            if (filtered.Count > 0)
            {
                applicable = filtered;
            }
        }

        // Issue #1154: arity/name applicability (Phase 1) does not check whether
        // each argument is type-convertible to the corresponding parameter. Per
        // C# §11.6.4.2 a candidate is NOT applicable when any argument has no
        // implicit conversion to its parameter type. Without this filter a
        // wholly-inapplicable overload (e.g. F(string) for a []uint8 argument)
        // can tie — and thus be reported ambiguous (GS0266) — with the unique
        // genuinely-applicable overload that merely needs an implicit
        // nullable/reference widening (e.g. []uint8 -> []?uint8). Drop such
        // non-convertible candidates here, conservatively (see skips below), so
        // the unique applicable overload is selected without a spurious GS0266.
        if (applicable.Count > 1 && !HasNamedArguments(argumentNames))
        {
            var convertible = new List<FunctionSymbol>(applicable.Count);
            foreach (var cand in applicable)
            {
                if (IsConvertibilityApplicable(cand, argumentCount, boundArguments))
                {
                    convertible.Add(cand);
                }
            }

            // Mirror the #1124 pattern: only adopt the narrowed set when it
            // leaves at least one candidate. An empty result means the call is
            // genuinely unsatisfiable; keep the prior list so the pre-existing
            // diagnostics (no-applicable-overload / ambiguity) are preserved.
            if (convertible.Count > 0)
            {
                applicable = convertible;
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
    /// Issue #1154: returns <see langword="true"/> when <paramref name="argumentNames"/>
    /// carries any non-null positional name. When named arguments are present the
    /// positional index→parameter mapping used by the convertibility filter is
    /// unreliable, so the filter is skipped entirely for that call.
    /// </summary>
    private static bool HasNamedArguments(ImmutableArray<string> argumentNames)
    {
        if (argumentNames.IsDefault)
        {
            return false;
        }

        for (var i = 0; i < argumentNames.Length; i++)
        {
            if (argumentNames[i] != null)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #1154: convertibility-aware applicability. Returns
    /// <see langword="true"/> when every positional argument actually supplied
    /// is implicitly convertible to the corresponding parameter type of
    /// <paramref name="candidate"/>. Conservatively treats a candidate as
    /// convertible (does NOT reject) for situations where the positional
    /// index→parameter mapping or the parameter type is unreliable: generic
    /// candidates (their parameter types may contain unsubstituted method type
    /// parameters — handled by the #1124 inference filter), the variadic tail,
    /// by-ref/out/in parameters, and unknown argument/parameter types.
    /// </summary>
    private bool IsConvertibilityApplicable(
        FunctionSymbol candidate,
        int argumentCount,
        ImmutableArray<BoundExpression>.Builder boundArguments)
    {
        // Generic candidates may carry unsubstituted method type parameters in
        // their signature; rely on the existing #1124 inference filter instead.
        if (candidate.IsGeneric)
        {
            return true;
        }

        var parameterOffset = candidate.ExplicitReceiverParameter == null ? 0 : 1;
        var paramLen = candidate.Parameters.Length - parameterOffset;
        var isVariadic = paramLen > 0 && candidate.Parameters[candidate.Parameters.Length - 1].IsVariadic;
        var fixedParamCount = isVariadic ? paramLen - 1 : paramLen;

        var count = Math.Min(argumentCount, paramLen);
        for (var i = 0; i < count && i < boundArguments.Count; i++)
        {
            // The variadic tail binds its element(s) elsewhere; do not reject.
            if (isVariadic && i >= fixedParamCount)
            {
                continue;
            }

            var parameter = candidate.Parameters[i + parameterOffset];

            // By-ref/out/in parameters have their own exact-type rules.
            if (parameter.RefKind != RefKind.None)
            {
                continue;
            }

            var argType = boundArguments[i]?.Type;
            var paramType = parameter.Type;

            // Unknown argument or parameter type — be conservative, do not reject.
            if (argType == null || paramType == null)
            {
                continue;
            }

            var conversion = Conversion.Classify(argType, paramType);
            if (conversion.Exists && (conversion.IsImplicit || conversion.IsIdentity))
            {
                continue;
            }

            // Issue #1281: a constant integer argument that fits a narrower /
            // cross-sign integer parameter is implicitly convertible there
            // (C# §10.2.11), so it must not disqualify the candidate.
            if (ExpressionBinder.IsImplicitConstantNarrowingArgument(boundArguments[i], paramType))
            {
                continue;
            }

            if (conversions.TryApplyUserDefinedImplicitArgumentConversion(boundArguments[i], paramType, out _))
            {
                continue;
            }

            return false;
        }

        return true;
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
    /// Issue #1124: returns <see langword="true"/> when every method type
    /// parameter of a generic candidate can be inferred from the supplied
    /// argument types, mirroring the inference the binder performs once a
    /// candidate is selected (see <c>BindUserTypeStaticCall</c> /
    /// <c>InferTypeArguments</c>). Used to drop generic candidates whose type
    /// arguments cannot be inferred so they do not participate in (and tie within)
    /// overload ranking. Non-generic candidates trivially qualify.
    /// </summary>
    private bool AllMethodTypeParametersInferable(
        FunctionSymbol candidate,
        ImmutableArray<BoundExpression>.Builder boundArguments,
        int argumentCount)
    {
        if (!candidate.IsGeneric)
        {
            return true;
        }

        var substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
        var parameterOffset = candidate.ExplicitReceiverParameter == null ? 0 : 1;
        var paramLen = candidate.Parameters.Length - parameterOffset;
        var isVariadic = paramLen > 0 && candidate.Parameters[candidate.Parameters.Length - 1].IsVariadic;
        var fixedParamCount = isVariadic ? paramLen - 1 : paramLen;

        var inferenceLimit = isVariadic ? fixedParamCount : Math.Min(argumentCount, paramLen);
        for (var i = 0; i < inferenceLimit && i < boundArguments.Count; i++)
        {
            var argType = boundArguments[i]?.Type;
            if (argType == null)
            {
                continue;
            }

            inferTypeArguments(candidate.Parameters[i + parameterOffset].Type, argType, substitution);
        }

        if (isVariadic && candidate.Parameters[candidate.Parameters.Length - 1].Type is SliceTypeSymbol variadicSlice)
        {
            for (var i = fixedParamCount; i < argumentCount && i < boundArguments.Count; i++)
            {
                var argType = boundArguments[i]?.Type;
                if (argType == null)
                {
                    continue;
                }

                var source = argType is SliceTypeSymbol argSlice ? argSlice.ElementType : argType;
                inferTypeArguments(variadicSlice.ElementType, source, substitution);
            }
        }

        foreach (var tp in candidate.TypeParameters)
        {
            if (!substitution.ContainsKey(tp))
            {
                return false;
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
    /// re-bound by <see cref="FinalizeBranchyArgument"/> (or centrally by
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
    {
        if (!ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(argument, out var branchySyntax))
        {
            return argument;
        }

        if (expectedType != null
            && expectedType != TypeSymbol.Error
            && expectedType != TypeSymbol.Void
            && !TypeSymbol.ContainsTypeParameter(expectedType))
        {
            return bindExpressionWithTargetType(branchySyntax, expectedType);
        }

        return bindExpression(branchySyntax);
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

        return builder.ToImmutable();
    }

    private static bool IsByRefInterpolatedHandlerArgument(BoundExpression argument, RefKind expected)
    {
        return argument is BoundInterpolatedStringExpression interp
            && interp.Handler != null
            && interp.Handler.HandlerRefKind == expected;
    }

    public BoundExpression BindConstructorCallExpression(CallExpressionSyntax syntax, StructSymbol classType)
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
            var elementType = variadicSliceType.ElementType;
            var trailingCount = requestedArgCount - fixedPrimaryCount;
            var passThrough = trailingCount == 1
                && boundArguments[fixedPrimaryCount].Type == variadicSliceType;

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

            if (!passThrough)
            {
                for (var i = fixedPrimaryCount; i < requestedArgCount; i++)
                {
                    var argument = boundArguments[i];
                    if (argument.Type != elementType
                        && argument.Type != TypeSymbol.Error
                        && !Conversion.Classify(argument.Type, elementType).IsImplicit)
                    {
                        Diagnostics.ReportWrongArgumentType(parameterSyntaxV[i].Location, variadicParam.Name, elementType, argument.Type);
                        hasErrorsV = true;
                    }
                }
            }

            if (hasErrorsV)
            {
                return new BoundErrorExpression(syntax);
            }

            // Build the final argument list: fixed args + a single slice arg.
            var rebuilt = ImmutableArray.CreateBuilder<BoundExpression>(parameters.Length);
            for (var i = 0; i < fixedPrimaryCount; i++)
            {
                rebuilt.Add(boundArguments[i]);
            }

            if (passThrough)
            {
                rebuilt.Add(boundArguments[fixedPrimaryCount]);
            }
            else
            {
                var packed = ImmutableArray.CreateBuilder<BoundExpression>(trailingCount);
                for (var i = fixedPrimaryCount; i < requestedArgCount; i++)
                {
                    packed.Add(boundArguments[i]);
                }

                rebuilt.Add(new BoundArrayCreationExpression(syntax, variadicSliceType, packed.MoveToImmutable()));
            }

            var packedArgs = rebuilt.MoveToImmutable();

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
            if (ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(argument, out _))
            {
                boundArguments[i] = argument = FinalizeBranchyArgument(argument, parameter.Type);
            }

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
            var elementType = sliceType.ElementType;
            var trailingCount = requestedArgCount - fixedCtorParamCount;
            var passThrough = trailingCount == 1
                && boundArguments[fixedCtorParamCount].Type == sliceType;

            if (!passThrough)
            {
                var hasVariadicErrors = false;
                for (var i = fixedCtorParamCount; i < requestedArgCount; i++)
                {
                    var argument = boundArguments[i];
                    if (argument.Type != elementType
                        && argument.Type != TypeSymbol.Error
                        && !Conversion.Classify(argument.Type, elementType).IsImplicit)
                    {
                        Diagnostics.ReportWrongArgumentType(parameterSyntax[i].Location, variadicParam.Name, elementType, argument.Type);
                        hasVariadicErrors = true;
                    }
                }

                if (hasVariadicErrors)
                {
                    return new BoundErrorExpression(syntax);
                }

                var packed = ImmutableArray.CreateBuilder<BoundExpression>(trailingCount);
                for (var i = fixedCtorParamCount; i < requestedArgCount; i++)
                {
                    packed.Add(boundArguments[i]);
                }

                var rebuilt = ImmutableArray.CreateBuilder<BoundExpression>(parameters.Length);
                for (var i = 0; i < fixedCtorParamCount; i++)
                {
                    rebuilt.Add(boundArguments[i]);
                }

                rebuilt.Add(new BoundArrayCreationExpression(syntax, sliceType, packed.MoveToImmutable()));
                boundArguments = rebuilt;

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
            if (ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(argument, out _))
            {
                boundArguments[i] = argument = FinalizeBranchyArgument(argument, effectiveParamTypes[i]);
            }

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
            if (argument.Type != paramType
                && !Conversion.Classify(argument.Type, paramType).IsImplicit)
            {
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

        constructed = StructSymbol.Construct(classType, typeArgs.MoveToImmutable());
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
                out var ambiguous);

            if (selectedFn == null)
            {
                if (ambiguous)
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
            if (ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(argument, out _))
            {
                argument = FinalizeBranchyArgument(argument, parameter.Type);
            }

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

            if (argument.Type != parameter.Type
                && !Conversion.Classify(argument.Type, parameter.Type).IsImplicit)
            {
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

    /// <summary>
    /// Issue #1213 / #1221: lowers a call through a delegate/function-typed
    /// variable to a <see cref="BoundIndirectCallExpression"/>, with two
    /// event-raise refinements when the variable is the implicit backing-field
    /// of a field-like event (an <see cref="ImplicitFieldVariableSymbol"/>):
    /// <list type="bullet">
    /// <item><description>The callee is loaded as a field read on <c>this</c>
    /// (e.g. <c>ldfld Base::Changed</c>) — including the backing field declared
    /// on a base class, so an inherited event can be raised from a derived type
    /// — rather than a (non-existent) local slot.</description></item>
    /// <item><description>The conditional raise form <c>Ev?(args)</c> on a
    /// <c>void</c> delegate is guarded by a null check (a
    /// <see cref="BoundNullConditionalAccessExpression"/>), so raising an event
    /// with no subscribers is a safe no-op, mirroring <c>Ev?.Invoke(args)</c>.
    /// </description></item>
    /// </list>
    /// </summary>
    private BoundExpression BuildIndirectDelegateCall(
        CallExpressionSyntax syntax,
        VariableSymbol variable,
        FunctionTypeSymbol fnType,
        ImmutableArray<BoundExpression> args)
    {
        if (variable is ImplicitFieldVariableSymbol implicitField)
        {
            if (syntax.NullableQuestionToken != null
                && ReferenceEquals(fnType.ReturnType, TypeSymbol.Void))
            {
                var captureName = "$ncap_" + (++binderCtx.NullConditionalCaptureCounter)
                    .ToString(System.Globalization.CultureInfo.InvariantCulture);
                var capture = new LocalVariableSymbol(captureName, isReadOnly: true, type: implicitField.Field.Type);
                var invoke = new BoundIndirectCallExpression(null, new BoundVariableExpression(null, capture), fnType, args);
                return new BoundNullConditionalAccessExpression(
                    syntax,
                    BuildImplicitFieldLoad(implicitField),
                    capture,
                    invoke,
                    TypeSymbol.Void,
                    resultSlot: null);
            }

            return new BoundIndirectCallExpression(null, BuildImplicitFieldLoad(implicitField), fnType, args);
        }

        return new BoundIndirectCallExpression(null, new BoundVariableExpression(null, variable), fnType, args);
    }

    /// <summary>
    /// Issue #1213 / #1221: loads an <see cref="ImplicitFieldVariableSymbol"/>
    /// (the implicit <c>this</c>-field exposed for a bare field/event name) as
    /// a field read on its declaring type. The declaring type carried by the
    /// symbol may be a base class, producing the correct base field token when
    /// the access originates from a derived method.
    /// </summary>
    private static BoundExpression BuildImplicitFieldLoad(ImplicitFieldVariableSymbol implicitField) =>
        new BoundFieldAccessExpression(
            null,
            new BoundVariableExpression(null, implicitField.Receiver),
            implicitField.StructType,
            implicitField.Field);

    public BoundExpression BindCallExpression(CallExpressionSyntax syntax)
    {
        // ADR-0065 §2: a bare `init(args)` call inside a constructor body is
        // a self-delegation to a sibling constructor on the same class. This
        // is the only legal use of `init` as a callable identifier. Recognise
        // it before any other call-binding path so the generic identifier
        // fallback at the bottom doesn't surface a misleading "unknown
        // function" diagnostic.
        if (syntax.TypeArgumentList == null
            && syntax.Identifier.Kind == SyntaxKind.IdentifierToken
            && syntax.Identifier.Text == "init")
        {
            var inCtor = getCurrentFunction();
            if (inCtor != null
                && inCtor.IsSpecialName
                && inCtor.Name == ".ctor"
                && inCtor.ReceiverType is StructSymbol owningClass
                && owningClass.IsClass
                && !owningClass.ExplicitConstructors.IsDefaultOrEmpty)
            {
                return BindConstructorChainingExpression(syntax, owningClass, inCtor);
            }
        }

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

        // Issue #1263: when the construction carries an explicit type-argument
        // list (`Op[int32](5)`), resolve the constructed type by (name, arity)
        // so a non-generic `Op` and a generic `Op[T]` can coexist. With no type
        // arguments the arity is -1 ("no preference"), preferring the arity-0
        // type — so `Op(...)` keeps picking the non-generic `Op`. This reuses
        // the same #1051 arity-keyed type-alias lookup the type-reference and
        // struct-literal paths already use.
        var ctorPreferredArity = syntax.TypeArgumentList != null
            ? syntax.TypeArgumentList.Arguments.Count
            : -1;

        if (syntax.Arguments.Count == 1 && lookupTypeWithArity(syntax.Identifier.Text, ctorPreferredArity) is TypeSymbol type)
        {
            // Issue #663: when the call carries a `?` token (e.g. `string?(x)`),
            // wrap the resolved type in NullableTypeSymbol so the conversion
            // targets the nullable form.
            if (syntax.NullableQuestionToken != null)
            {
                type = NullableTypeSymbol.Get(type);
            }

            // A single-arg call to a primitive-typed name is a conversion
            // (`int(x)`, `string(x)`). Defer to BindConversion. For a class
            // or inline-struct type, treat it as a ctor call instead — even
            // when no explicit/primary constructor is declared, so the user
            // sees an actionable "wrong argument count" diagnostic rather
            // than a misleading conversion error (issue #524). Issue #1069: a
            // value struct (e.g. a `data struct`) declaring a primary
            // constructor is likewise positionally constructible — `Entry(1)`
            // builds the struct, not a conversion to it.
            if (!(type is StructSymbol singleArgStruct
                  && (singleArgStruct.IsClass || singleArgStruct.IsInline || singleArgStruct.HasPrimaryConstructor)))
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
        // Issue #1069: a value struct (e.g. a `data struct`) declaring a
        // primary constructor is also positionally constructible —
        // `Entry(1, 2)` lowers to a struct literal initializing its fields.
        if (lookupTypeWithArity(syntax.Identifier.Text, ctorPreferredArity) is StructSymbol classType
            && (classType.IsClass || classType.IsInline || classType.HasPrimaryConstructor))
        {
            return BindConstructorCallExpression(syntax, classType);
        }

        // Issue #988: `T()` constructs the type parameter `T` when the enclosing
        // generic declares an `init()` default-constructor constraint (`[T init()]`).
        // Lowered to a reified `Activator.CreateInstance<T>()` (ADR-0087). A
        // type parameter has no user-callable members, so a zero-argument call
        // to it can only mean construction. When the `init()` constraint is
        // absent we cannot guarantee an accessible parameterless constructor, so
        // report GS0389 pointing at the missing constraint.
        if (syntax.Arguments.Count == 0
            && syntax.TypeArgumentList == null
            && lookupType(syntax.Identifier.Text) is TypeParameterSymbol typeParam)
        {
            if (typeParam.HasDefaultConstructorConstraint)
            {
                return new BoundTypeParameterConstructionExpression(syntax, typeParam);
            }

            Diagnostics.ReportConstructedTypeParameterRequiresNewConstraint(
                syntax.Identifier.Location, typeParam.Name);
            return new BoundErrorExpression(null);
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

        // Issue #951: indices of un-typed arrow lambda arguments whose binding
        // is deferred until the callee's parameter types are known, so the
        // target delegate shape can drive lambda-parameter-type inference.
        // Without the deferral the lambda binds with no target, reports GS0304
        // ("cannot infer parameter type"), and aborts the call — even though
        // the parameter (e.g. `Func[int32, int32]` / `(int32) -> int32`)
        // fully determines the lambda's shape.
        HashSet<int> deferredArrowLambdaIndices = null;

        // ADR-0060: argument binding needs the matching parameter to resolve
        // inline `out var`/`out let`/`out _` payloads. For free-function calls
        // we don't have the FunctionSymbol resolved until below, so we first
        // bind everything with parameter=null (the inline-out form falls back
        // to its declared type) and patch up the type later. The plain
        // lvalue ref/in/out form is parameter-independent.
        var argIndex = 0;
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
            else if (argumentNames.IsDefault
                && bindLambdaWithTarget != null
                && IsUntypedArrowLambda(argSyntax))
            {
                // Issue #951: defer; bind once the parameter delegate target is
                // known (per-position loop below). A placeholder carrying the
                // lambda syntax keeps argument positions aligned.
                (deferredArrowLambdaIndices ??= new HashSet<int>()).Add(argIndex);
                boundArgument = new BoundErrorExpression(argSyntax);
            }
            else
            {
                boundArgument = BindOverloadArgumentValue(argSyntax);
            }

            boundArguments.Add(boundArgument);
            argIndex++;
        }

        var symbol = Scope.TryLookupSymbol(syntax.Identifier.Text);
        if (symbol == null)
        {
            // Implicit `this`: if we are inside an instance method body and the
            // name matches a sibling method on the receiver type, dispatch via
            // `this.<method>(args)` automatically.
            // Issue #1159: `effThis` is the enclosing instance method's `this`
            // even when this call sits inside a lambda body (whose synthetic
            // enclosing function carries no receiver), so unqualified
            // enclosing-instance member calls resolve and capture `this`.
            var effThis = GetEffectiveThisParameter();
            if (effThis != null
                && effThis.Type is StructSymbol implicitReceiverStruct)
            {
                // Issue #1147 (Facet B): an unqualified same-named call inside an
                // instance method resolves against the COMBINED instance + static
                // (`shared`) overload set of the enclosing type — mirroring C#'s
                // unified overload resolution — instead of seeing only instance
                // overloads. The selected method's IsStatic routes emission.
                var implicitMethod = SelectUnifiedInstanceStaticOverload(
                    implicitReceiverStruct,
                    syntax.Identifier.Text,
                    boundArguments.ToImmutable(),
                    syntax,
                    argumentNames,
                    out var implicitHasCandidates);
                if (implicitHasCandidates)
                {
                    if (implicitMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    if (implicitMethod.IsStatic)
                    {
                        // Resolved to a same-named static sibling: finalize as a
                        // static user call (full optional/variadic/generic
                        // fidelity via the shared static-call finalizer).
                        if (bindUserTypeStaticCall != null)
                        {
                            return bindUserTypeStaticCall(implicitReceiverStruct, syntax);
                        }

                        var convertedSelfStaticArgs = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
                        for (var ai = 0; ai < syntax.Arguments.Count; ai++)
                        {
                            convertedSelfStaticArgs.Add(conversions.BindConversion(syntax.Arguments[ai].Location, boundArguments[ai], implicitMethod.Parameters[ai].Type));
                        }

                        return new BoundCallExpression(null, implicitMethod, convertedSelfStaticArgs.MoveToImmutable());
                    }

                    var implicitReceiver = new BoundVariableExpression(null, effThis);
                    return BindUserInstanceCall(implicitReceiver, implicitMethod, boundArguments.ToImmutable(), syntax, argumentNames);
                }

                // Issue #1136: a bare (implicit-`this`) call such as `GetType()`
                // inside an instance method must resolve as `this.GetType()`
                // against the universally-inherited System.Object members when
                // no sibling user method matches. Falls back to typeof(object)
                // (or the explicit imported base if present); the helper returns
                // false for any name Object does not define, so the GS0130 path
                // below still fires for genuinely undefined functions.
                var implicitBaseClr = implicitReceiverStruct.ImportedBaseType?.ClrType ?? typeof(object);
                var implicitReceiverExpr = new BoundVariableExpression(null, effThis);
                if (tryBindInheritedClrInstanceCall(implicitReceiverExpr, implicitBaseClr, syntax.Identifier.Text, boundArguments.ToImmutable(), syntax, out var implicitInheritedCall, null, default, argumentNames))
                {
                    return implicitInheritedCall;
                }
            }

            // ADR-0085 / ADR-0090 implicit `this` inside an interface default
            // method body. The body's enclosing function is a DIM whose
            // ReceiverType is the owning InterfaceSymbol; an unqualified call
            // (`Helper(args)`) should resolve to a sibling method on the same
            // interface. The visibility rule from ADR-0090 applies: callers
            // inside the interface see both the public surface and the
            // private helpers; external callers go through the receiver-typed
            // path which does its own GS0334 check.
            if (effThis != null
                && effThis.Type is InterfaceSymbol implicitReceiverIface)
            {
                var implicitIfaceOverloads = TypeMemberModel.GetMethods(implicitReceiverIface, syntax.Identifier.Text, MemberQuery.Instance(MemberKinds.Method));
                var implicitPrivateIfaceOverloads = implicitReceiverIface.GetPrivateMethods(syntax.Identifier.Text);
                if (implicitPrivateIfaceOverloads.Length > 0)
                {
                    implicitIfaceOverloads = implicitIfaceOverloads.AddRange(implicitPrivateIfaceOverloads);
                }

                if (implicitIfaceOverloads.Length > 0)
                {
                    var implicitIfaceMethod = SelectInstanceOverloadOrReport(implicitIfaceOverloads, boundArguments.ToImmutable(), syntax, syntax.Identifier.Text, argumentNames);
                    if (implicitIfaceMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    var implicitReceiver = new BoundVariableExpression(null, effThis);
                    return BindUserInstanceCall(implicitReceiver, implicitIfaceMethod, boundArguments.ToImmutable(), syntax, argumentNames);
                }
            }

            // ADR-0089 / ADR-0090: implicit static-self dispatch inside a
            // static-virtual or private-static interface helper body. The
            // enclosing function has no `this` parameter but
            // <c>StaticOwnerType</c> set to the owning InterfaceSymbol. An
            // unqualified call resolves against the interface's static
            // (public + private) buckets.
            if (getCurrentFunction()?.ThisParameter == null
                && getCurrentFunction()?.StaticOwnerType is InterfaceSymbol implicitStaticIface)
            {
                var implicitStaticOverloads = TypeMemberModel.GetMethods(implicitStaticIface, syntax.Identifier.Text, MemberQuery.Static(MemberKinds.Method));
                var implicitStaticPrivateOverloads = implicitStaticIface.GetStaticPrivateMethods(syntax.Identifier.Text);
                if (implicitStaticPrivateOverloads.Length > 0)
                {
                    implicitStaticOverloads = implicitStaticOverloads.AddRange(implicitStaticPrivateOverloads);
                }

                if (implicitStaticOverloads.Length > 0)
                {
                    var implicitStaticMethod = SelectInstanceOverloadOrReport(implicitStaticOverloads, boundArguments.ToImmutable(), syntax, syntax.Identifier.Text, argumentNames);
                    if (implicitStaticMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    var convertedStaticArgs = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
                    for (var ai = 0; ai < syntax.Arguments.Count; ai++)
                    {
                        convertedStaticArgs.Add(conversions.BindConversion(syntax.Arguments[ai].Location, boundArguments[ai], implicitStaticMethod.Parameters[ai].Type));
                    }

                    return new BoundCallExpression(null, implicitStaticMethod, convertedStaticArgs.MoveToImmutable());
                }
            }

            // Issue #1201 (C# `using static`): an unqualified call may resolve
            // to a `shared` (static) method of a type brought into scope by a
            // type import (`import Ns.Type`). Mirror C#'s using-static
            // semantics — search every type-import's static method set and bind
            // against the single match. When two or more imported types expose a
            // same-named static method the reference is ambiguous (GS0414), but
            // only here, where the name is actually used. The shared static-call
            // finalizer (`bindUserTypeStaticCall`) provides full
            // optional/variadic/generic fidelity, so an unqualified
            // `GetValues[TEnum]()` resolves exactly like `EnumUtil.GetValues[TEnum]()`.
            if (bindUserTypeStaticCall != null)
            {
                StructSymbol matchedStaticImport = null;
                var ambiguousStaticImport = false;
                foreach (var importedType in binderCtx.GetStaticImportTypes())
                {
                    var importedStatics = TypeMemberModel.GetMethods(
                        importedType,
                        syntax.Identifier.Text,
                        MemberQuery.Static(MemberKinds.Method));
                    if (importedStatics.IsDefaultOrEmpty)
                    {
                        continue;
                    }

                    if (matchedStaticImport == null)
                    {
                        matchedStaticImport = importedType;
                    }
                    else if (!ReferenceEquals(matchedStaticImport, importedType))
                    {
                        ambiguousStaticImport = true;
                        break;
                    }
                }

                if (ambiguousStaticImport)
                {
                    Diagnostics.ReportAmbiguousImportedStaticMember(syntax.Identifier.Location, syntax.Identifier.Text);
                    return new BoundErrorExpression(null);
                }

                if (matchedStaticImport != null)
                {
                    return bindUserTypeStaticCall(matchedStaticImport, syntax);
                }
            }

            Diagnostics.ReportUndefinedFunction(syntax.Identifier.Location, syntax.Identifier.Text);
            return new BoundErrorExpression(null);
        }

        // ADR-0122 §9 / issue #1035: invoking a function-pointer-typed
        // variable goes through the `calli` path. Sites like `fp(1, 2)` where
        // `fp` is `let fp *func(int32, int32) int32 = &Add` reduce to a
        // BoundFunctionPointerInvocationExpression.
        if (symbol is VariableSymbol fpVar && fpVar.Type is FunctionPointerTypeSymbol fpSym)
        {
            if (!argumentNames.IsDefault)
            {
                Diagnostics.ReportNamedArgumentParameterNotFound(syntax.Identifier.Location, fpVar.Name, FirstNamedArgumentName(argumentNames));
                return new BoundErrorExpression(null);
            }

            if (syntax.Arguments.Count != fpSym.Arity)
            {
                Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, fpVar.Name, fpSym.Arity, syntax.Arguments.Count);
                return new BoundErrorExpression(null);
            }

            var fpConvertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(fpSym.Arity);
            for (var i = 0; i < fpSym.Arity; i++)
            {
                var argLoc = i < syntax.Arguments.Count ? syntax.Arguments[i].Location : syntax.Identifier.Location;
                fpConvertedArgs.Add(conversions.BindConversion(argLoc, boundArguments[i], fpSym.ParameterTypes[i]));
            }

            return new BoundFunctionPointerInvocationExpression(
                null,
                new BoundVariableExpression(null, fpVar),
                fpConvertedArgs.MoveToImmutable(),
                fpSym);
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

            // ADR-0102 follow-up / issue #818: a function-typed variable
            // whose declared type spells a trailing variadic parameter
            // (`(T1, ..., ...Tn) -> R`) packs / passes through the trailing
            // arguments at the call site, mirroring the named-delegate path.
            var fnIsVariadic = fnType.HasVariadic;
            var fnFixedCount = fnIsVariadic ? fnType.Arity - 1 : fnType.Arity;

            if (fnIsVariadic)
            {
                if (syntax.Arguments.Count < fnFixedCount)
                {
                    Diagnostics.ReportTooFewArgumentsForVariadic(syntax.Identifier.Location, variable.Name, fnFixedCount, syntax.Arguments.Count);
                    return new BoundErrorExpression(null);
                }
            }
            else if (syntax.Arguments.Count != fnType.Arity)
            {
                Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, variable.Name, fnType.Arity, syntax.Arguments.Count);
                return new BoundErrorExpression(null);
            }

            ImmutableArray<BoundExpression> fnPermutedArgs = boundArguments.ToImmutable();
            if (fnIsVariadic)
            {
                var fnSliceType = (SliceTypeSymbol)fnType.ParameterTypes[fnType.Arity - 1];
                var fnTrailing = syntax.Arguments.Count - fnFixedCount;
                var fnPassThrough = fnTrailing == 1 && boundArguments[fnFixedCount].Type == fnSliceType;
                if (!fnPassThrough)
                {
                    var fnPacked = ImmutableArray.CreateBuilder<BoundExpression>(fnTrailing);
                    for (var i = fnFixedCount; i < syntax.Arguments.Count; i++)
                    {
                        fnPacked.Add(boundArguments[i]);
                    }

                    var fnNew = ImmutableArray.CreateBuilder<BoundExpression>(fnFixedCount + 1);
                    for (var i = 0; i < fnFixedCount; i++)
                    {
                        fnNew.Add(boundArguments[i]);
                    }

                    fnNew.Add(new BoundArrayCreationExpression(syntax, fnSliceType, fnPacked.MoveToImmutable()));
                    fnPermutedArgs = fnNew.ToImmutable();
                }
            }

            var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(fnPermutedArgs.Length);
            for (var i = 0; i < fnPermutedArgs.Length; i++)
            {
                var argLoc = i < syntax.Arguments.Count ? syntax.Arguments[i].Location : syntax.Identifier.Location;
                convertedArgs.Add(conversions.BindConversion(argLoc, fnPermutedArgs[i], fnType.ParameterTypes[i]));
            }

            return BuildIndirectDelegateCall(syntax, variable, fnType, convertedArgs.MoveToImmutable());
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

            // ADR-0101 follow-up / issue #812: a named delegate can declare a
            // trailing variadic parameter. Pack / pass-through happens at the
            // direct-call site so the lowered Invoke receives one slice
            // argument, matching the delegate's Invoke signature.
            var ndIsVariadic = namedDelegateSym.Parameters.Length > 0
                && namedDelegateSym.Parameters[namedDelegateSym.Parameters.Length - 1].IsVariadic;
            var ndFixedCount = ndIsVariadic
                ? namedDelegateSym.Parameters.Length - 1
                : namedDelegateSym.Parameters.Length;

            if (ndIsVariadic)
            {
                if (syntax.Arguments.Count < ndFixedCount)
                {
                    Diagnostics.ReportTooFewArgumentsForVariadic(syntax.Identifier.Location, namedDelegateVar.Name, ndFixedCount, syntax.Arguments.Count);
                    return new BoundErrorExpression(null);
                }
            }
            else if (syntax.Arguments.Count != namedDelegateSym.Parameters.Length)
            {
                Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, namedDelegateVar.Name, namedDelegateSym.Parameters.Length, syntax.Arguments.Count);
                return new BoundErrorExpression(null);
            }

            ImmutableArray<BoundExpression> ndPermutedArgs = boundArguments.ToImmutable();
            if (ndIsVariadic)
            {
                var ndVariadicParam = namedDelegateSym.Parameters[namedDelegateSym.Parameters.Length - 1];
                var ndSliceType = (SliceTypeSymbol)ndVariadicParam.Type;
                var ndElementType = ndSliceType.ElementType;
                var ndTrailing = syntax.Arguments.Count - ndFixedCount;
                var ndPassThrough = ndTrailing == 1 && boundArguments[ndFixedCount].Type == ndSliceType;
                if (!ndPassThrough)
                {
                    var ndPacked = ImmutableArray.CreateBuilder<BoundExpression>(ndTrailing);
                    for (var i = ndFixedCount; i < syntax.Arguments.Count; i++)
                    {
                        ndPacked.Add(boundArguments[i]);
                    }

                    var ndNew = ImmutableArray.CreateBuilder<BoundExpression>(ndFixedCount + 1);
                    for (var i = 0; i < ndFixedCount; i++)
                    {
                        ndNew.Add(boundArguments[i]);
                    }

                    ndNew.Add(new BoundArrayCreationExpression(syntax, ndSliceType, ndPacked.MoveToImmutable()));
                    ndPermutedArgs = ndNew.ToImmutable();
                }
            }

            var convertedNamedArgs = ImmutableArray.CreateBuilder<BoundExpression>(ndPermutedArgs.Length);
            for (var i = 0; i < ndPermutedArgs.Length; i++)
            {
                var argLoc = i < syntax.Arguments.Count ? syntax.Arguments[i].Location : syntax.Identifier.Location;
                convertedNamedArgs.Add(conversions.BindConversion(argLoc, ndPermutedArgs[i], namedDelegateSym.Parameters[i].Type));
            }

            return BuildIndirectDelegateCall(syntax, namedDelegateVar, namedDelegateSym.EquivalentFunctionType, convertedNamedArgs.MoveToImmutable());
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
            var receiver = delegateVar is ImplicitFieldVariableSymbol clrImplicitField
                ? BuildImplicitFieldLoad(clrImplicitField)
                : (BoundExpression)new BoundVariableExpression(null, delegateVar);
            if (tryBindInheritedClrInstanceCall(receiver, delegateClrType, "Invoke", boundArguments.ToImmutable(), syntax, out var invokeCall, null, default, argumentNames))
            {
                return invokeCall;
            }

            var invoke = delegateClrType.GetMethodSafe("Invoke");
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
            var selected = SelectBestUserOverload(overloadSet, syntax.Arguments.Count, argumentNames, boundArguments, out var overloadAmbiguous, syntax.TypeArgumentList?.Arguments.Count ?? 0);
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
                    var paramType = function.Parameters[i].Type;

                    // ADR-0101 / issue #799: when the trailing parameter is
                    // variadic (`name ...T`), inference must consider every
                    // packed argument against the element type — *unless* the
                    // caller supplied a single trailing argument whose type
                    // already matches the slice (the C# `params` pass-through
                    // case), in which case the slice itself drives inference.
                    if (i == function.Parameters.Length - 1
                        && function.Parameters[i].IsVariadic
                        && paramType is SliceTypeSymbol variadicSlice)
                    {
                        var trailingCount = boundArguments.Count - i;
                        if (trailingCount == 1 && boundArguments[i].Type is SliceTypeSymbol)
                        {
                            inferTypeArguments(paramType, boundArguments[i].Type, substitution);
                        }
                        else
                        {
                            for (var j = i; j < boundArguments.Count; j++)
                            {
                                inferTypeArguments(variadicSlice.ElementType, boundArguments[j].Type, substitution);
                            }
                        }

                        break;
                    }

                    inferTypeArguments(paramType, boundArguments[i].Type, substitution);
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

            // Issue #1238: a deferred target-typed conditional/if/switch
            // argument is re-bound here against the resolved parameter type so
            // each branch is target-typed before the convertibility checks
            // below (which would otherwise reject the suppressed-error
            // placeholder).
            if (ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(argument, out _))
            {
                boundArguments[i] = argument = FinalizeBranchyArgument(argument, expectedType);
            }

            // bound against the resolved parameter's delegate target so its
            // omitted parameter type(s) and inferred return type are filled in
            // from the parameter shape (e.g. `func F(f Func[int32, int32])`
            // accepts `F((x) -> x + 1)`). The bound lambda is then converted to
            // the exact parameter type so the correct delegate adapter
            // (`Func`/`Action`/`Predicate`/a named delegate) is materialised.
            // If the parameter is not a delegate type, fall back to binding the
            // lambda with no target, which surfaces the established GS0304
            // diagnostic through the regular conversion checks below.
            if (deferredArrowLambdaIndices != null
                && deferredArrowLambdaIndices.Remove(i)
                && i < parameterSyntax.Length
                && UnwrapNamedArgumentValue(parameterSyntax[i]) is LambdaExpressionSyntax deferredLambda)
            {
                var lambdaLoc = parameterSyntax[i].Location;
                if (bindLambdaWithTarget != null
                    && expectedType != null
                    && expectedType != TypeSymbol.Error
                    && !TypeSymbol.ContainsTypeParameter(expectedType)
                    && MemberLookup.TryGetDelegateFunctionTypeFromSymbol(expectedType, out var deferredTarget)
                    && deferredTarget != null)
                {
                    var targeted = bindLambdaWithTarget(deferredLambda, deferredTarget);
                    boundArguments[i] = conversions.BindConversion(lambdaLoc, targeted, expectedType);
                    continue;
                }

                boundArguments[i] = argument = bindExpression(deferredLambda);
            }

            // ADR-0100 / issue #795: materialise a bare-`default`
            // placeholder argument (BoundDefaultExpression with Error
            // type and bare DefaultExpressionSyntax) against the
            // expected parameter type. The placeholder originates in
            // ExpressionBinder.BindDefaultExpression when the bare form
            // is encountered through the eager argument-binding loop
            // above; by this point we know the target type and can pin
            // it down.
            if (argument is BoundDefaultExpression bareDefArg
                && argument.Type == TypeSymbol.Error
                && argument.Syntax is DefaultExpressionSyntax bareDefArgSyntax
                && bareDefArgSyntax.TypeClause == null
                && expectedType != null
                && expectedType != TypeSymbol.Error)
            {
                boundArguments[i] = argument = new BoundDefaultExpression(bareDefArgSyntax, expectedType);
            }

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
                // ADR-0087 §3 R6: substitute the open target before
                // routing through the adapter so the identity-check
                // inside the adapter can drop the wrapper when the
                // literal already matches.
                var substitutedOpenTarget = (substituteType(openFunctionParameter, substitution) as FunctionTypeSymbol)
                    ?? openFunctionParameter;
                boundArguments[i] = createErasedFunctionLiteralAdapter(functionLiteralArgument, substitutedOpenTarget);
                continue;
            }

            // Issue #1150: a func/arrow literal argument whose natural numeric
            // return type implicitly, losslessly widens to the (non-generic)
            // delegate parameter's return type (e.g. `(x int32) -> uint16(x)`
            // into a `Func<int32,int64>` parameter) is routed through
            // BindConversion, which reshapes it via the erased adapter so the
            // produced delegate's return type already matches the target —
            // inserting the widening conversion in the body. Without this the
            // literal would materialise as a narrower-returning delegate flowing
            // into a wider delegate slot (unverifiable IL).
            if (!(substitution != null && TypeSymbol.ContainsTypeParameter(parameter.Type))
                && tryGetFunctionLiteral(argument, out var widenLiteralArg)
                && widenLiteralArg.FunctionType is FunctionTypeSymbol widenLiteralFnType
                && widenLiteralFnType.ReturnType != TypeSymbol.Void
                && widenLiteralFnType.ReturnType != TypeSymbol.Error
                && MemberLookup.TryGetDelegateFunctionTypeFromSymbol(expectedType, out var widenTargetFn)
                && widenTargetFn != null
                && widenTargetFn.Arity == widenLiteralFnType.Arity
                && widenTargetFn.ReturnType != TypeSymbol.Void
                && widenTargetFn.ReturnType != TypeSymbol.Error
                && !ReferenceEquals(widenLiteralFnType.ReturnType, widenTargetFn.ReturnType)
                && Conversion.Classify(widenLiteralFnType.ReturnType, widenTargetFn.ReturnType).IsImplicit)
            {
                var widenLoc = i < parameterSyntax.Length ? parameterSyntax[i].Location : syntax.Identifier.Location;
                boundArguments[i] = conversions.BindConversion(widenLoc, argument, expectedType);
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

            // ADR-0112 / ADR-0063 §9: an unresolved method group argument
            // (multiple user overloads, or a CLR method group) carries no fixed
            // type until the target delegate signature drives overload
            // selection. Route it through BindConversion — which performs the
            // signature-directed pick — instead of the type-equality / implicit
            // conversion checks below (which would reject the Error-typed group).
            if ((argument is BoundMethodGroupExpression { FunctionType: null }
                    || argument is BoundClrMethodGroupExpression { ResolvedMethod: null })
                && !(substitution != null && TypeSymbol.ContainsTypeParameter(parameter.Type)))
            {
                var groupLoc = i < parameterSyntax.Length ? parameterSyntax[i].Location : syntax.Identifier.Location;
                var resolvedGroupArg = conversions.BindConversion(groupLoc, argument, expectedType);
                boundArguments[i] = resolvedGroupArg;
                if (resolvedGroupArg is BoundErrorExpression)
                {
                    hasErrors = true;
                }

                continue;
            }

            // Issue #1256: an element-wise tuple conversion `(T1, …) -> (U1, …)`
            // is implicit but NOT representation-preserving — the source and
            // target `ValueTuple<…>` are different CLR instantiations, so the
            // argument must be lowered (rebuilt) via BindConversion rather than
            // passed through unchanged. The generic implicit-conversion branch
            // below only inserts a conversion node for value-type nullable
            // targets, leaving every other "implicit" conversion as a no-op, so
            // tuple arguments would otherwise reach the call site still typed as
            // the source tuple and produce unverifiable IL.
            if (argument.Type is TupleTypeSymbol argTuple
                && expectedType is TupleTypeSymbol paramTuple
                && argTuple.Arity == paramTuple.Arity
                && argTuple != paramTuple
                && Conversion.Classify(argTuple, paramTuple).IsImplicit)
            {
                var tupleLoc = i < parameterSyntax.Length ? parameterSyntax[i].Location : syntax.Identifier.Location;
                boundArguments[i] = conversions.BindConversion(tupleLoc, argument, expectedType);
                continue;
            }

            if (argument.Type != expectedType
                && !(substitution != null && TypeSymbol.ContainsTypeParameter(parameter.Type))
                && !Conversion.Classify(argument.Type, expectedType).IsImplicit)
            {
                // Issue #889: arrow/func literal → void-returning delegate.
                var voidDelegateLoc = i < parameterSyntax.Length ? parameterSyntax[i].Location : syntax.Identifier.Location;
                if (TryConvertLiteralArgumentToVoidDelegate(argument, expectedType, voidDelegateLoc, out var voidDelegateArg))
                {
                    boundArguments[i] = voidDelegateArg;
                    continue;
                }

                // Issue #1281: a constant integer argument that fits a narrower /
                // cross-sign integer parameter converts implicitly (C# §10.2.11).
                // Re-materialise it as a literal of exactly the parameter type so
                // emit produces a correctly-typed constant — matching `var x
                // uint16 = 5` at a declaration target (ADR-0129).
                if (TryBindConstantNarrowingArgument(argument, expectedType, voidDelegateLoc, out var narrowedArg))
                {
                    boundArguments[i] = narrowedArg;
                    continue;
                }

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

        // Issue #951: any deferred un-typed arrow lambda that did not map to a
        // fixed parameter (e.g. it landed in a trailing variadic slot) is bound
        // here with no target so the established GS0304 diagnostic surfaces
        // rather than leaving an unbound placeholder.
        if (deferredArrowLambdaIndices != null)
        {
            foreach (var idx in deferredArrowLambdaIndices)
            {
                if (idx < boundArguments.Count
                    && boundArguments[idx] is BoundErrorExpression placeholder
                    && placeholder.Syntax is LambdaExpressionSyntax pendingLambda)
                {
                    boundArguments[idx] = bindExpression(pendingLambda);
                }
            }
        }

        // Phase 4.8: type-check trailing variadic arguments against the slice
        // element type, then pack them into a single slice-typed argument.
        // ADR-0101 / issue #799: a single trailing argument whose type already
        // matches the variadic slice type is passed through unchanged
        // (parity with the C# `params T[]` call-site semantics so the
        // dogfooded `Sequences.Of` port accepts `Sequences.Of(arr)`).
        if (isVariadic)
        {
            var variadicParam = function.Parameters[function.Parameters.Length - 1];
            var paramSliceType = (SliceTypeSymbol)variadicParam.Type;
            var sliceType = substitution != null
                ? (SliceTypeSymbol)substituteType(paramSliceType, substitution)
                : paramSliceType;
            var elementType = sliceType.ElementType;
            var trailingCount = syntax.Arguments.Count - fixedParamCount;

            bool passThrough = trailingCount == 1
                && boundArguments[fixedParamCount].Type == sliceType;

            if (passThrough)
            {
                // Single trailing []T argument — keep as-is. boundArguments
                // already has the correct shape (fixedParamCount + 1 entries).
            }
            else
            {
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
    /// Issue #951: determines whether the supplied expression is an arrow
    /// lambda with at least one parameter whose type clause is omitted, so its
    /// parameter type(s) must be inferred from a target delegate.
    /// </summary>
    /// <param name="inner">The (already name-unwrapped) argument expression.</param>
    /// <returns><see langword="true"/> for an arrow lambda carrying an
    /// untyped parameter slot.</returns>
    private static bool IsUntypedArrowLambda(ExpressionSyntax inner)
    {
        if (inner is not LambdaExpressionSyntax lambda)
        {
            return false;
        }

        for (var i = 0; i < lambda.Parameters.Count; i++)
        {
            if (lambda.Parameters[i].Type == null)
            {
                return true;
            }
        }

        return false;
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
                    // ADR-0087 §3 R6: substitute the open target so the
                    // identity-check inside the adapter drops the
                    // wrapper when the literal already matches.
                    var substitutedOpenTarget = (substituteType(openFunctionParameter, substitution) as FunctionTypeSymbol)
                        ?? openFunctionParameter;
                    convertedArgs.Add(createErasedFunctionLiteralAdapter(functionLiteralArgument, substitutedOpenTarget));
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
            if (extension.IsAsync && !isAsyncIteratorReturnType(extension.Type))
            {
                returnType = wrapAsTask(returnType);
            }

            return new BoundCallExpression(null, extension, convertedArgs.MoveToImmutable(), returnType);
        }

        // Issue #1376: an async receiver-clause (extension) function's call-site
        // return type is Task / Task[T], not the underlying void / T. Wrap here
        // so awaiting the call sees a value-bearing Task, mirroring the async
        // free-function and user-instance-call paths.
        if (extension.IsAsync && !isAsyncIteratorReturnType(extension.Type))
        {
            var asyncReturn = wrapAsTask(extension.Type);
            return new BoundCallExpression(null, extension, convertedArgs.MoveToImmutable(), asyncReturn);
        }

        return new BoundCallExpression(null, extension, convertedArgs.MoveToImmutable());
    }

    public BoundExpression BindUserInstanceCall(BoundExpression receiver, FunctionSymbol method, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce, ImmutableArray<string> argumentNames = default, TypeParameterSymbol constrainedReceiverTypeParameter = null)
    {
        // Issue #950: enforce `protected` method access — only the declaring
        // type and its derived types may call it. The emitted IL also carries
        // CIL `family` accessibility so the CLR enforces the same rule.
        if (method.Accessibility == Accessibility.Protected
            && method.ReceiverType is StructSymbol protMethodDeclaringType
            && !AccessibilityChecker.IsAccessible(method.Accessibility, protMethodDeclaringType, getCurrentFunction()))
        {
            Diagnostics.ReportProtectedMemberInaccessible(ce.Identifier.Location, method.Name, protMethodDeclaringType.Name);
        }

        var parameterOffset = method.ExplicitReceiverParameter == null ? 0 : 1;
        var callableParameterCount = method.Parameters.Length - parameterOffset;

        // ADR-0101 follow-up / issue #812: class / interface instance methods
        // may declare a trailing variadic parameter. The arity check accepts
        // any count >= fixed parameters (the fixed prefix is everything
        // except the trailing variadic). Pack / pass-through happens below
        // before the per-position conversion loop.
        var isVariadic = method.Parameters.Length > 0
            && method.Parameters[method.Parameters.Length - 1].IsVariadic;
        var fixedCallableParamCount = isVariadic ? callableParameterCount - 1 : callableParameterCount;

        // ADR-0063 / issue #1319: count the leading non-optional callable
        // parameters. An instance / constructor call may omit any trailing
        // parameter that declares a default value; the omitted slots are
        // synthesized from each parameter's captured default constant below,
        // mirroring the top-level and static (`shared`) call paths. The
        // receiver parameter (when present) is excluded via `parameterOffset`.
        var requiredCallableParamCount = callableParameterCount;
        for (var i = callableParameterCount - 1; i >= 0; i--)
        {
            if (method.Parameters[i + parameterOffset].HasExplicitDefaultValue)
            {
                requiredCallableParamCount = i;
            }
            else
            {
                break;
            }
        }

        // Issue #343: variadic functions and named arguments do not compose.
        if (isVariadic && !argumentNames.IsDefault)
        {
            Diagnostics.ReportNamedArgumentParameterNotFound(ce.Identifier.Location, method.Name, FirstNamedArgumentName(argumentNames));
            return new BoundErrorExpression(null);
        }

        if (isVariadic)
        {
            if (arguments.Length < fixedCallableParamCount)
            {
                Diagnostics.ReportTooFewArgumentsForVariadic(ce.Identifier.Location, method.Name, fixedCallableParamCount, arguments.Length);
                return new BoundErrorExpression(null);
            }
        }
        else if (arguments.Length < requiredCallableParamCount || arguments.Length > callableParameterCount)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, method.Name, callableParameterCount, arguments.Length);
            return new BoundErrorExpression(null);
        }

        // Issue #343: reorder named arguments into the method's parameter
        // order. ADR-0063 / issue #1319: positional calls may omit trailing
        // optional parameters; the omitted slots are padded from each
        // parameter's captured default value after the reorder below.
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

        // ADR-0063 / issue #1319: pad any omitted trailing optional parameters
        // with their captured default values so the per-position conversion loop
        // binds the full callable parameter list (matching the top-level and
        // static call paths). Variadic methods never reach here with a short
        // slice (their trailing slot is packed below), so the optional pad is
        // gated on the non-variadic shape.
        if (argumentNames.IsDefault && !isVariadic && permutedArguments.Length < callableParameterCount)
        {
            var padded = ImmutableArray.CreateBuilder<BoundExpression>(callableParameterCount);
            padded.AddRange(permutedArguments);
            for (var i = permutedArguments.Length; i < callableParameterCount; i++)
            {
                padded.Add(CreateOptionalUserDefaultArgument(method.Parameters[i + parameterOffset]));
            }

            permutedArguments = padded.MoveToImmutable();
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
                    // ADR-0101 follow-up / issue #812: when the call lands
                    // on the trailing variadic parameter (whose type is
                    // `[]T`), each trailing argument contributes to `T`'s
                    // inference. A single trailing `[]U` argument infers
                    // `T = U` from the slice element so the pass-through
                    // path works.
                    var paramType = method.Parameters[i + parameterOffset].Type;
                    if (isVariadic
                        && i + parameterOffset == method.Parameters.Length - 1
                        && paramType is SliceTypeSymbol variadicSlice)
                    {
                        var argType = permutedArguments[i].Type;
                        if (permutedArguments.Length - i == 1 && argType is SliceTypeSymbol passThroughSlice)
                        {
                            inferTypeArguments(variadicSlice.ElementType, passThroughSlice.ElementType, substitution);
                        }
                        else
                        {
                            for (var j = i; j < permutedArguments.Length; j++)
                            {
                                inferTypeArguments(variadicSlice.ElementType, permutedArguments[j].Type, substitution);
                            }
                        }

                        break;
                    }

                    inferTypeArguments(paramType, permutedArguments[i].Type, substitution);
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

        // ADR-0101 follow-up / issue #812: pack or pass-through trailing
        // variadic arguments before per-position conversion. Mirrors the
        // top-level call path: a single trailing argument whose substituted
        // type matches the variadic slice type forwards unchanged; otherwise
        // the trailing args are typed against the element type and packed
        // into a fresh `BoundArrayCreationExpression`.
        if (isVariadic)
        {
            var variadicParam = method.Parameters[method.Parameters.Length - 1];
            var paramSliceType = (SliceTypeSymbol)variadicParam.Type;
            var sliceType = substitution != null
                ? (SliceTypeSymbol)substituteType(paramSliceType, substitution)
                : paramSliceType;
            var elementType = sliceType.ElementType;
            var trailingCount = permutedArguments.Length - fixedCallableParamCount;

            var passThrough = trailingCount == 1
                && permutedArguments[fixedCallableParamCount].Type == sliceType;

            if (!passThrough)
            {
                var hasVariadicErrors = false;
                for (var i = fixedCallableParamCount; i < permutedArguments.Length; i++)
                {
                    var argument = permutedArguments[i];
                    if (elementType is TypeParameterSymbol)
                    {
                        // Open element type: leave argument untouched, the
                        // emitter boxes as needed (type-erased model).
                        continue;
                    }

                    if (argument.Type != elementType
                        && argument.Type != TypeSymbol.Error
                        && !Conversion.Classify(argument.Type, elementType).IsImplicit)
                    {
                        Diagnostics.ReportWrongArgumentType(permutedSyntax[i].Location, variadicParam.Name, elementType, argument.Type);
                        hasVariadicErrors = true;
                    }
                }

                if (hasVariadicErrors)
                {
                    return new BoundErrorExpression(null);
                }

                var packed = ImmutableArray.CreateBuilder<BoundExpression>(trailingCount);
                for (var i = fixedCallableParamCount; i < permutedArguments.Length; i++)
                {
                    packed.Add(permutedArguments[i]);
                }

                var newArgs = ImmutableArray.CreateBuilder<BoundExpression>(fixedCallableParamCount + 1);
                for (var i = 0; i < fixedCallableParamCount; i++)
                {
                    newArgs.Add(permutedArguments[i]);
                }

                newArgs.Add(new BoundArrayCreationExpression(ce, sliceType, packed.MoveToImmutable()));
                permutedArguments = newArgs.ToImmutable();

                var newSyntax = new ExpressionSyntax[fixedCallableParamCount + 1];
                for (var i = 0; i < fixedCallableParamCount; i++)
                {
                    newSyntax[i] = permutedSyntax[i];
                }

                // The packed-slice slot has no corresponding source argument
                // (or, when the user supplied one or more trailing args, we
                // collapse them down to a single synthetic slot). Use the
                // first trailing arg's syntax when present, otherwise leave
                // null and the conversion loop will fall back to `ce.Location`.
                newSyntax[fixedCallableParamCount] = permutedSyntax.Length > fixedCallableParamCount
                    ? permutedSyntax[fixedCallableParamCount]
                    : null;
                permutedSyntax = newSyntax;
            }
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(permutedArguments.Length);
        for (var i = 0; i < permutedArguments.Length; i++)
        {
            var parameter = method.Parameters[i + parameterOffset];
            var paramType = parameter.Type;

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
            if (permutedArguments[i] is BoundAddressOfExpression inlineOutAddr
                && inlineOutAddr.Operand.Type == TypeSymbol.Error)
            {
                var slotSyntax = i < permutedSyntax.Length ? permutedSyntax[i] : null;
                var pointeeType = substitution != null ? substituteType(paramType, substitution) : paramType;
                var reboundOutVar = tryRebindInlineOutVarPlaceholder(permutedArguments[i], slotSyntax, parameter, pointeeType);
                if (reboundOutVar != null)
                {
                    convertedArgs.Add(reboundOutVar);
                    continue;
                }
            }

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
                    // ADR-0087 §3 R6: substitute the open target so the
                    // identity-check inside the adapter drops the
                    // wrapper when the literal already matches.
                    var substitutedOpenTarget = (substituteType(openFunctionParameter, substitution) as FunctionTypeSymbol)
                        ?? openFunctionParameter;
                    convertedArgs.Add(createErasedFunctionLiteralAdapter(functionLiteralArgument, substitutedOpenTarget));
                    continue;
                }

                if (MemberLookup.TryGetDelegateFunctionType(paramType.ClrType ?? expectedType.ClrType, out var targetDelegateFunctionType)
                    && functionLiteralArgument.FunctionType != targetDelegateFunctionType)
                {
                    convertedArgs.Add(createErasedFunctionLiteralAdapter(functionLiteralArgument, targetDelegateFunctionType));
                    continue;
                }
            }

            var argSyntaxForLocation = i < permutedSyntax.Length ? permutedSyntax[i] : null;

            // ADR-0055 Tier 4 (#369): re-lower an interpolated-string argument to
            // FormattableStringFactory.Create when the parameter is
            // IFormattable/FormattableString.
            var argSyntaxForInterp = argSyntaxForLocation != null ? UnwrapNamedArgumentValue(argSyntaxForLocation) : null;
            if (argSyntaxForInterp is InterpolatedStringExpressionSyntax interpolatedArg
        && isFormattableStringTargetType(expectedType))
            {
        convertedArgs.Add(bindInterpolatedStringAsFormattable(interpolatedArg, expectedType));
        continue;
            }

            var argLoc = argSyntaxForLocation?.Location ?? ce.Location;
            convertedArgs.Add(conversions.BindCallArgumentWithRefKind(argLoc, permutedArguments[i], expectedType, method.Parameters[i + parameterOffset]));
        }

        if (substitution != null)
        {
            var substitutedReturn = substituteType(method.Type, substitution);
            if (method.IsAsync && !isAsyncIteratorReturnType(method.Type))
            {
                substitutedReturn = wrapAsTask(substitutedReturn);
                return new BoundUserInstanceCallExpression(null, receiver, method, convertedArgs.ToImmutable(), substitutedReturn, constrainedReceiverTypeParameter, constrainedReceiverTypeParameter?.InterfaceConstraint);
            }

            if (!ReferenceEquals(substitutedReturn, method.Type))
            {
                return new BoundUserInstanceCallExpression(null, receiver, method, convertedArgs.ToImmutable(), substitutedReturn, constrainedReceiverTypeParameter, constrainedReceiverTypeParameter?.InterfaceConstraint);
            }
        }

        // Issue #502: an async instance method's call-site return type is
        // Task / Task[T], not the underlying T. Wrap here so the call
        // expression's static type matches the kickoff method's return type.
        if (method.IsAsync && !isAsyncIteratorReturnType(method.Type))
        {
            var asyncReturn = wrapAsTask(method.Type);
            return new BoundUserInstanceCallExpression(null, receiver, method, convertedArgs.ToImmutable(), asyncReturn, constrainedReceiverTypeParameter, constrainedReceiverTypeParameter?.InterfaceConstraint);
        }

        return new BoundUserInstanceCallExpression(null, receiver, method, convertedArgs.ToImmutable(), returnTypeOverride: null, constrainedReceiverTypeParameter, constrainedReceiverTypeParameter?.InterfaceConstraint);
    }

    private static Dictionary<TypeParameterSymbol, TypeSymbol> TryBuildReceiverSubstitution(TypeSymbol receiverType)
    {
        if (receiverType is not StructSymbol start)
        {
            return null;
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
        Dictionary<TypeParameterSymbol, TypeSymbol> map = null;
        for (var c = start; c != null; c = c.BaseClass)
        {
            if (c.Definition == null
                || ReferenceEquals(c.Definition, c)
                || c.TypeArguments.IsDefaultOrEmpty
                || c.Definition.TypeParameters.IsDefaultOrEmpty)
            {
                continue;
            }

            var defTps = c.Definition.TypeParameters;
            var count = System.Math.Min(defTps.Length, c.TypeArguments.Length);
            for (var i = 0; i < count; i++)
            {
                var arg = c.TypeArguments[i];

                // Resolve an argument that is itself one of a more-derived
                // class's type parameters through the running map.
                if (arg is TypeParameterSymbol tpArg && map != null && map.TryGetValue(tpArg, out var resolved))
                {
                    arg = resolved;
                }

                map ??= new Dictionary<TypeParameterSymbol, TypeSymbol>();
                map[defTps[i]] = arg;
            }
        }

        return map;
    }
}
