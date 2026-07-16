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
internal sealed partial class OverloadResolver
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
        ImmutableArray<string> argumentNames,
        bool allowProtectedInherited = false);

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
    private readonly Func<TypeSymbol, bool, TypeSymbol> wrapAsTask;
    private readonly Func<TypeSymbol, bool> isAsyncIteratorReturnType;
    private readonly TryGetFunctionLiteralDelegate tryGetFunctionLiteral;
    private readonly Action<TypeSymbol, TypeSymbol, Dictionary<TypeParameterSymbol, TypeSymbol>> inferTypeArguments;
    private readonly Func<TypeSymbol, Dictionary<TypeParameterSymbol, TypeSymbol>, TypeSymbol> substituteType;
    private readonly Func<TypeSymbol, TypeParameterSymbol, bool> satisfiesConstraint;
    private readonly Func<TypeParameterSymbol, string> describeConstraint;
    private readonly Func<FunctionSymbol> getCurrentFunction;
    private readonly Func<LambdaExpressionSyntax, FunctionTypeSymbol, BoundExpression> bindLambdaWithTarget;
    private readonly Func<StructSymbol, CallExpressionSyntax, BoundExpression> bindUserTypeStaticCall;
    private readonly Func<System.Type, CallExpressionSyntax, BoundExpression> bindImportedClrStaticCall;

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
    /// <param name="bindImportedClrStaticCall">ADR-0134 (extended): callback that
    /// finalizes an unqualified call as a qualified static call against a
    /// referenced-assembly CLR type brought into scope by a type import
    /// (C# <c>using static System.Math</c>). May be <see langword="null"/>.</param>
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
        Func<TypeSymbol, bool, TypeSymbol> wrapAsTask,
        Func<TypeSymbol, bool> isAsyncIteratorReturnType,
        TryGetFunctionLiteralDelegate tryGetFunctionLiteral,
        Action<TypeSymbol, TypeSymbol, Dictionary<TypeParameterSymbol, TypeSymbol>> inferTypeArguments,
        Func<TypeSymbol, Dictionary<TypeParameterSymbol, TypeSymbol>, TypeSymbol> substituteType,
        Func<TypeSymbol, TypeParameterSymbol, bool> satisfiesConstraint,
        Func<TypeParameterSymbol, string> describeConstraint,
        Func<FunctionSymbol> getCurrentFunction,
        Func<LambdaExpressionSyntax, FunctionTypeSymbol, BoundExpression> bindLambdaWithTarget = null,
        Func<StructSymbol, CallExpressionSyntax, BoundExpression> bindUserTypeStaticCall = null,
        Func<System.Type, CallExpressionSyntax, BoundExpression> bindImportedClrStaticCall = null)
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
        this.bindImportedClrStaticCall = bindImportedClrStaticCall;
    }

    private DiagnosticBag Diagnostics => binderCtx.Diagnostics;

    private BoundScope Scope => binderCtx.RootScope;

    /// <summary>
    /// Gets the same CLR-arg cross-reflection-context (MLC) projector
    /// threaded through the emit-time <c>Construct</c> call sites
    /// (<see cref="Symbols.StructSymbol.Construct(Symbols.StructSymbol, ImmutableArray{Symbols.TypeSymbol}, Func{Type, Type})"/>).
    /// Both <c>Construct</c> call sites in this file build a same-compilation
    /// user type (<c>classType</c> is always a source-declared
    /// <see cref="Symbols.StructSymbol"/> resolved by name in this scope, never
    /// an imported CLR generic), so under normal binding the raw
    /// <c>ClrType</c> args are already in this compilation's reflection
    /// context and no projection is needed. Threaded anyway for
    /// defense-in-depth / consistency with the other <c>Construct</c> sites
    /// touched by #2037, and to cover a future imported-generic-arg path
    /// without another audit.
    /// </summary>
    private Func<Type, Type> MapClrType => binderCtx.References == null ? null : binderCtx.References.MapClrTypeToReferences;
}
