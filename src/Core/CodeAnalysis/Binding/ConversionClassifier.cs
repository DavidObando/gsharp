// <copyright file="ConversionClassifier.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// PR-B-3: the binder-side facade that wraps the pure
/// <see cref="Conversion.Classify(TypeSymbol, TypeSymbol)"/> type-pair
/// classifier in the diagnostic-emitting <c>BindConversion</c> family,
/// and owns the CLR-parameter conversion, method-group → delegate
/// resolution, ref-kind validation, default-value attachment,
/// optional-argument appending, conditional-ref argument shaping,
/// and user-defined implicit-conversion lookup that previously lived
/// directly on <see cref="Binder"/>.
/// </summary>
/// <remarks>
/// <para>
/// This type is the binder-side wrapper: it consumes
/// <see cref="BinderContext"/> for the diagnostics bag and reference
/// resolver, and <see cref="MemberLookup"/> for delegate-type / member
/// shape probes. It never back-references <see cref="Binder"/>; the
/// few callbacks it needs (re-binding a sub-expression, the
/// interpolated-string / function-literal adapters) are injected
/// through narrow <see cref="Func{T, TResult}"/> seams in the
/// constructor.
/// </para>
/// <para>
/// The pure value-shaped <see cref="Conversion"/> type in
/// <c>Conversion.cs</c> is unchanged and continues to expose the static
/// <see cref="Conversion.Classify(TypeSymbol, TypeSymbol)"/> entry
/// point. This class merely wraps that classifier with the diagnostic
/// emission and bound-tree shaping previously embedded in
/// <see cref="Binder"/>.
/// </para>
/// <para>
/// The slice-conversion-set-equals-array-conversion-set rule (#570) landed
/// in <c>Conversion.Classify</c> (PR 6.5) via a dedicated arm and the
/// <c>ClrTypeUtilities.ImplementsInterfaceByName</c> cross-context helper.
/// The lifted <c>T → T?</c> conversion (#571) and the related Wave-3
/// architectural fixes from <c>~/gsharp-bug-overview.md</c> will land
/// in this class in a follow-up PR after the full Binder decomposition
/// is complete.
/// </para>
/// </remarks>
internal sealed class ConversionClassifier
{
    private static readonly System.Collections.Generic.HashSet<string> NumericPrimitiveFullNames = new(StringComparer.Ordinal)
    {
        "System.SByte", "System.Byte", "System.Int16", "System.UInt16",
        "System.Int32", "System.UInt32", "System.Int64", "System.UInt64",
        "System.IntPtr", "System.UIntPtr", "System.Char",
        "System.Single", "System.Double", "System.Decimal",
    };

    private readonly BinderContext binderCtx;
    private readonly MemberLookup memberLookup;
    private readonly Func<ExpressionSyntax, BoundExpression> bindExpression;
    private readonly Func<ExpressionSyntax, TypeSymbol, BoundExpression> bindExpressionWithTargetType;
    private readonly Func<TypeSymbol, bool> isFormattableStringTargetType;
    private readonly Func<InterpolatedStringExpressionSyntax, TypeSymbol, BoundExpression> bindInterpolatedStringAsFormattable;
    private readonly Func<BoundFunctionLiteralExpression, FunctionTypeSymbol, BoundFunctionLiteralExpression> createErasedFunctionLiteralAdapter;
    private readonly Func<BoundExpression, bool> isLvalue;
    private readonly Func<SyntaxToken, RefKind> getRefKindFromModifier;
    private readonly Func<RefKind, string> refKindToString;

    /// <summary>
    /// Initializes a new instance of the <see cref="ConversionClassifier"/>
    /// class.
    /// </summary>
    /// <param name="binderCtx">The shared binder context that exposes the
    /// diagnostics bag and reference resolver.</param>
    /// <param name="memberLookup">The binder-side member-lookup facade used
    /// for delegate-shape probes during method-group → delegate conversion
    /// (the <see cref="MemberLookup.TryGetDelegateFunctionType"/> seam).</param>
    /// <param name="bindExpression">Callback to re-bind a sub-expression
    /// through the still-on-Binder expression-binding entry point.</param>
    /// <param name="bindExpressionWithTargetType">Callback to bind a sub-
    /// expression with a target-type hint (used by
    /// <see cref="BindConditionalRefArgument"/> to bind the condition as
    /// <see cref="TypeSymbol.Bool"/>).</param>
    /// <param name="isFormattableStringTargetType">Callback to test whether
    /// a target type is one of the ADR-0055 Tier 4 formattable-string
    /// shapes (<c>IFormattable</c> / <c>FormattableString</c>). Kept on
    /// <see cref="Binder"/> because the interpolated-string binder uses
    /// it from multiple non-conversion call sites.</param>
    /// <param name="bindInterpolatedStringAsFormattable">Callback that
    /// performs the ADR-0055 Tier 4 contextual conversion of an
    /// interpolated string to <c>IFormattable</c>/<c>FormattableString</c>.</param>
    /// <param name="createErasedFunctionLiteralAdapter">Callback that
    /// wraps a function-literal expression in an erased-signature adapter
    /// for the target generic function type. Owned by the lambda binder
    /// (which holds the nested rewriter), surfaced here as a callback.</param>
    /// <param name="isLvalue">Callback that classifies a bound expression
    /// as an l-value (addressable). Used by the conditional-ref-argument
    /// validator.</param>
    /// <param name="getRefKindFromModifier">Callback that maps a
    /// <c>ref</c>/<c>out</c>/<c>in</c> modifier token to a
    /// <see cref="RefKind"/>.</param>
    /// <param name="refKindToString">Callback used only for the
    /// human-readable diagnostic message when an optional parameter
    /// also carries a ref-kind modifier.</param>
    public ConversionClassifier(
        BinderContext binderCtx,
        MemberLookup memberLookup,
        Func<ExpressionSyntax, BoundExpression> bindExpression,
        Func<ExpressionSyntax, TypeSymbol, BoundExpression> bindExpressionWithTargetType,
        Func<TypeSymbol, bool> isFormattableStringTargetType,
        Func<InterpolatedStringExpressionSyntax, TypeSymbol, BoundExpression> bindInterpolatedStringAsFormattable,
        Func<BoundFunctionLiteralExpression, FunctionTypeSymbol, BoundFunctionLiteralExpression> createErasedFunctionLiteralAdapter,
        Func<BoundExpression, bool> isLvalue,
        Func<SyntaxToken, RefKind> getRefKindFromModifier,
        Func<RefKind, string> refKindToString)
    {
        this.binderCtx = binderCtx ?? throw new ArgumentNullException(nameof(binderCtx));
        this.memberLookup = memberLookup ?? throw new ArgumentNullException(nameof(memberLookup));
        this.bindExpression = bindExpression ?? throw new ArgumentNullException(nameof(bindExpression));
        this.bindExpressionWithTargetType = bindExpressionWithTargetType ?? throw new ArgumentNullException(nameof(bindExpressionWithTargetType));
        this.isFormattableStringTargetType = isFormattableStringTargetType ?? throw new ArgumentNullException(nameof(isFormattableStringTargetType));
        this.bindInterpolatedStringAsFormattable = bindInterpolatedStringAsFormattable ?? throw new ArgumentNullException(nameof(bindInterpolatedStringAsFormattable));
        this.createErasedFunctionLiteralAdapter = createErasedFunctionLiteralAdapter ?? throw new ArgumentNullException(nameof(createErasedFunctionLiteralAdapter));
        this.isLvalue = isLvalue ?? throw new ArgumentNullException(nameof(isLvalue));
        this.getRefKindFromModifier = getRefKindFromModifier ?? throw new ArgumentNullException(nameof(getRefKindFromModifier));
        this.refKindToString = refKindToString ?? throw new ArgumentNullException(nameof(refKindToString));
    }

    private DiagnosticBag Diagnostics => binderCtx.Diagnostics;

    // ----- Pure static helpers (no instance state) -----

    /// <summary>
    /// Issue #327/#321: appends synthesized default-value arguments for any
    /// trailing optional parameters the call site omitted.
    /// <paramref name="parameters"/> is the full parameter list of the
    /// resolved CLR method/constructor; <paramref name="suppliedArguments"/>
    /// are the arguments already bound for the leading parameters (for
    /// instance/extension calls this includes the receiver mapped onto the
    /// first parameter). When no parameters are omitted, the supplied array
    /// is returned unchanged.
    /// </summary>
    /// <param name="suppliedArguments">Bound arguments mapped to the leading
    /// parameters.</param>
    /// <param name="parameters">The resolved method's full parameter list.</param>
    /// <returns>The argument array padded to the parameter count with
    /// defaults.</returns>
    public static ImmutableArray<BoundExpression> AppendOmittedOptionalArguments(
        ImmutableArray<BoundExpression> suppliedArguments,
        ParameterInfo[] parameters)
    {
        if (suppliedArguments.Length >= parameters.Length)
        {
            return suppliedArguments;
        }

        var builder = ImmutableArray.CreateBuilder<BoundExpression>(parameters.Length);
        builder.AddRange(suppliedArguments);
        for (var i = suppliedArguments.Length; i < parameters.Length; i++)
        {
            builder.Add(CreateOptionalDefaultArgument(parameters[i]));
        }

        return builder.MoveToImmutable();
    }

    /// <summary>
    /// Issue #327/#321: builds the bound expression for an omitted optional
    /// parameter. An explicit constant default (e.g. <c>int x = 5</c>)
    /// becomes the corresponding literal; <c>= default</c>/<c>= null</c> and
    /// constant-less <c>[Optional]</c> parameters (e.g.
    /// <c>CancellationToken cancellationToken = default</c>) become the zero
    /// value of the parameter type.
    /// </summary>
    /// <param name="parameter">The omitted optional parameter.</param>
    /// <returns>The bound default-value argument.</returns>
    public static BoundExpression CreateOptionalDefaultArgument(ParameterInfo parameter)
    {
        var typeSymbol = TypeSymbol.FromClrType(parameter.ParameterType);

        if (TryGetConstantParameterDefault(parameter, out var constant))
        {
            return new BoundLiteralExpression(null, constant);
        }

        return new BoundDefaultExpression(null, typeSymbol);
    }

    /// <summary>
    /// ADR-0056 §1: when a CLR member returns a <see cref="ByRefTypeSymbol"/>
    /// (e.g. <c>ref T</c> from a span indexer or a ref-returning property /
    /// method), automatically dereference at the use site so that downstream
    /// code observes the pointee type. Returns the expression unchanged
    /// otherwise.
    /// </summary>
    /// <param name="expression">The bound member-access / call / index
    /// expression.</param>
    /// <returns>The (possibly dereferenced) bound expression.</returns>
    public static BoundExpression AutoDereferenceRefReturn(BoundExpression expression)
    {
        return expression.Type is ByRefTypeSymbol
            ? new BoundDereferenceExpression(null, expression)
            : expression;
    }

    // ----- Core conversion entry points -----

    /// <summary>
    /// Binds <paramref name="syntax"/> as an expression and converts it to
    /// <paramref name="type"/>. Mirrors the
    /// <see cref="BindConversion(TextLocation, BoundExpression, TypeSymbol, bool)"/>
    /// core overload after delegating to the still-on-<see cref="Binder"/>
    /// expression-binder for the initial bind.
    /// </summary>
    /// <param name="syntax">The expression syntax to bind and convert.</param>
    /// <param name="type">The target conversion type.</param>
    /// <param name="allowExplicit">When <see langword="true"/>, suppresses
    /// the "implicit conversion required" diagnostic for an explicit-only
    /// classification.</param>
    /// <returns>The converted bound expression (or a
    /// <see cref="BoundErrorExpression"/> on failure with diagnostics
    /// already reported).</returns>
    public BoundExpression BindConversion(ExpressionSyntax syntax, TypeSymbol type, bool allowExplicit = false)
    {
        // ADR-0055 Tier 4: contextual conversion of an interpolated string to
        // IFormattable/FormattableString. Handled here, before eager string
        // lowering, so the format/alignment intent is preserved.
        if (syntax is InterpolatedStringExpressionSyntax interpolated && isFormattableStringTargetType(type))
        {
            return bindInterpolatedStringAsFormattable(interpolated, type);
        }

        // ADR-0100 / issue #795: bare `default` (no type clause) takes its
        // type from the surrounding target type. The explicit `default(T)`
        // form is bound through the regular dispatcher because its type
        // comes from the type-clause argument and overload resolution
        // should see a typed expression.
        if (syntax is DefaultExpressionSyntax defaultExpr && defaultExpr.TypeClause == null)
        {
            if (type == null || type == TypeSymbol.Error)
            {
                Diagnostics.ReportBareDefaultNoTargetType(defaultExpr.DefaultKeyword.Location);
                return new BoundErrorExpression(defaultExpr);
            }

            return new BoundDefaultExpression(defaultExpr, type);
        }

        var expression = bindExpression(syntax);
        return BindConversion(syntax.Location, expression, type, allowExplicit);
    }

    /// <summary>
    /// Core <c>BindConversion</c> overload: classifies the conversion from
    /// <paramref name="expression"/>'s static type to <paramref name="type"/>,
    /// surfaces the appropriate diagnostic when the classification is
    /// missing or implicit-only at an explicit target, and produces the
    /// shaped <see cref="BoundExpression"/>.
    /// </summary>
    /// <param name="diagnosticLocation">The location used for reported
    /// diagnostics.</param>
    /// <param name="expression">The bound source expression.</param>
    /// <param name="type">The target conversion type.</param>
    /// <param name="allowExplicit">When <see langword="true"/>, suppresses
    /// the "implicit conversion required" diagnostic for an explicit-only
    /// classification.</param>
    /// <returns>The shaped bound expression.</returns>
    public BoundExpression BindConversion(TextLocation diagnosticLocation, BoundExpression expression, TypeSymbol type, bool allowExplicit = false)
    {
        // Issue #1238: a deferred target-typed conditional/if/switch argument
        // placeholder (a BoundErrorExpression retaining the branchy syntax,
        // produced when the branches could not unify without a target type).
        // Re-bind the retained syntax against the now-known target so each
        // branch is target-typed (e.g. a `nil` arm widens to the parameter's
        // nullable type). When the target is missing/in error, re-bind without
        // a target so the original no-common-type diagnostic — suppressed at the
        // deferral point — surfaces. This is the central finalization path that
        // covers every call/constructor argument site routed through
        // BindConversion.
        if (ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(expression, out var branchySyntax))
        {
            if (type == null || type == TypeSymbol.Error || type == TypeSymbol.Void)
            {
                return bindExpression(branchySyntax);
            }

            return bindExpressionWithTargetType(branchySyntax, type);
        }

        // Issue #1018: a throw-expression has the bottom (`never`) type and is
        // implicitly convertible to any target. Return it unwrapped — there is
        // no value to convert, and wrapping it in a BoundConversionExpression
        // would emit a bogus cast after the CIL `throw`.
        if (expression.Type == TypeSymbol.Never)
        {
            return expression;
        }

        // ADR-0100 / issue #795: a typeless bare-`default` placeholder
        // (produced by ExpressionBinder.BindDefaultExpression when the
        // syntax has no type-clause) takes its concrete type from the
        // target. When the target is missing or itself in error, surface
        // GS0362 instead of the generic "cannot convert ? → ?"
        // diagnostic. The explicit `default(T)` form is already typed and
        // flows through the regular conversion machinery below.
        if (expression is BoundDefaultExpression placeholderDefault
            && placeholderDefault.Type == TypeSymbol.Error
            && placeholderDefault.Syntax is DefaultExpressionSyntax barePlaceholder
            && barePlaceholder.TypeClause == null)
        {
            if (type == null || type == TypeSymbol.Error)
            {
                Diagnostics.ReportBareDefaultNoTargetType(barePlaceholder.DefaultKeyword.Location);
                return new BoundErrorExpression(barePlaceholder);
            }

            return new BoundDefaultExpression(barePlaceholder, type);
        }

        // Issue #337: a CLR member method group has no fixed type until the
        // target delegate signature drives overload selection. Resolve it here,
        // where the expected type is known, before classifying conversions.
        if (expression is BoundClrMethodGroupExpression { ResolvedMethod: null } clrMethodGroup)
        {
            return BindClrMethodGroupConversion(diagnosticLocation, clrMethodGroup, type);
        }

        // ADR-0063 §9: a user-function method group with multiple candidates
        // resolves here against the target delegate/function-type signature.
        if (expression is BoundMethodGroupExpression { FunctionType: null } userMethodGroup)
        {
            return BindUserMethodGroupConversion(diagnosticLocation, userMethodGroup, type);
        }

        if (expression is BoundFunctionLiteralExpression literal
            && type is FunctionTypeSymbol targetFunctionType
            && TypeSymbol.ContainsTypeParameter(targetFunctionType))
        {
            return createErasedFunctionLiteralAdapter(literal, targetFunctionType);
        }

        // Issue #889: a `func`/arrow literal whose natural return type carries a
        // value (e.g. `() -> called = called + 1`, inferred as `() -> int32`)
        // converts to a void-returning delegate target (System.Action, a named
        // void delegate, or a `(...) -> void` function type) by discarding the
        // trailing value — mirroring the `func() { ... }` statement-body form
        // that already yields void. Void-ize the literal through the erased
        // adapter (which now drops the return value), then continue the
        // conversion against the real delegate target.
        if (expression is BoundFunctionLiteralExpression voidCandidateLiteral
            && voidCandidateLiteral.FunctionType is FunctionTypeSymbol voidCandidateFnType
            && voidCandidateFnType.ReturnType != TypeSymbol.Void
            && voidCandidateFnType.ReturnType != TypeSymbol.Error
            && MemberLookup.TryGetDelegateFunctionTypeFromSymbol(type, out var voidTargetFnType)
            && voidTargetFnType.ReturnType == TypeSymbol.Void
            && voidTargetFnType.Arity == voidCandidateFnType.Arity
            && !ReferenceEquals(type, voidCandidateFnType))
        {
            var voidized = createErasedFunctionLiteralAdapter(voidCandidateLiteral, voidTargetFnType);
            if (!ReferenceEquals(voidized, voidCandidateLiteral))
            {
                return BindConversion(diagnosticLocation, voidized, type, allowExplicit);
            }
        }

        // Issue #1150: a `func`/arrow literal whose natural numeric return type
        // implicitly, losslessly widens to the target delegate's return type
        // (e.g. `(x int32) -> uint16(x)` flowing into a `Func<int32,int64>`
        // slot) is reshaped through the erased adapter so the produced delegate
        // is created over a method whose return type already matches the target
        // — inserting the widening conversion in the adapter body. This mirrors
        // C#'s implicit numeric conversion of a lambda body to an expected
        // delegate return type. Without it the literal would materialize as a
        // narrower-returning delegate flowing into a wider delegate slot.
        if (expression is BoundFunctionLiteralExpression widenCandidateLiteral
            && widenCandidateLiteral.FunctionType is FunctionTypeSymbol widenCandidateFnType
            && widenCandidateFnType.ReturnType != TypeSymbol.Void
            && widenCandidateFnType.ReturnType != TypeSymbol.Error
            && MemberLookup.TryGetDelegateFunctionTypeFromSymbol(type, out var widenTargetFnType)
            && widenTargetFnType.ReturnType != TypeSymbol.Void
            && widenTargetFnType.ReturnType != TypeSymbol.Error
            && widenTargetFnType.Arity == widenCandidateFnType.Arity
            && !ReferenceEquals(widenCandidateFnType.ReturnType, widenTargetFnType.ReturnType)
            && IsNumericReturnWideningCore(widenCandidateFnType.ReturnType, widenTargetFnType.ReturnType))
        {
            var widened = createErasedFunctionLiteralAdapter(widenCandidateLiteral, widenTargetFnType);
            if (!ReferenceEquals(widened, widenCandidateLiteral))
            {
                return BindConversion(diagnosticLocation, widened, type, allowExplicit);
            }
        }

        var conversion = Conversion.Classify(expression.Type, type);

        // Issue #1183: C# §10.2.11 implicit constant expression conversion.
        // A *constant* integer expression (an integer literal, or unary +/-
        // applied to one) whose value lies within the target integer type's
        // range converts implicitly — no cast required — even when the
        // type-pair classification above is only an explicit (narrowing)
        // conversion (e.g. `uint8 x = 42`, `int16 s = 100`, `int8 a = -5`).
        // The value is re-materialised as a literal of EXACTLY the target type
        // (so emit produces a correctly-typed constant). Out-of-range constants
        // are NOT adapted (TryAdaptIntegerLiteral fails), so they keep flowing
        // through the explicit-only path below and remain an error unless an
        // explicit cast is requested. Identity/already-implicit (widening)
        // conversions are left untouched so existing behaviour is preserved.
        if (!conversion.IsImplicit
            && ExpressionBinder.IsIntegerType(type)
            && ExpressionBinder.TryGetConstantIntegerValue(expression, out var constantIntegerValue)
            && ExpressionBinder.TryAdaptIntegerLiteral(constantIntegerValue, type, out var adaptedConstant))
        {
            return new BoundLiteralExpression(expression.Syntax, adaptedConstant, type);
        }

        if (!conversion.Exists)
        {
            // Issue #1017: a user-defined conversion operator declared on a
            // same-package struct/class is modelled as a static op_Implicit /
            // op_Explicit FunctionSymbol — those types have no reflectible
            // ClrType during binding, so resolve them symbolically first.
            if (TryResolveUserDefinedSymbolConversion(expression.Type, type, allowExplicit, out var userConvOp))
            {
                var converted = userConvOp.Parameters.Length == 1
                    ? BindConversion(diagnosticLocation, expression, userConvOp.Parameters[0].Type, allowExplicit)
                    : expression;
                return new BoundCallExpression(null, userConvOp, ImmutableArray.Create(converted));
            }

            // Issue #1283: lifted user-defined conversion to a nullable target.
            // When the target is `U?` and the source `T` has a user-defined
            // op_Implicit (or op_Explicit at an explicit position) producing the
            // underlying `U`, apply the operator and then nullable-wrap the
            // result (`U` -> `U?`). The recursive BindConversion call performs
            // the standard nullable-wrap; it cannot recurse into a second
            // user-defined operator because the produced value already has type
            // `U`, the nullable's underlying type.
            if (type is NullableTypeSymbol nullableTarget
                && nullableTarget.UnderlyingType != expression.Type
                && TryResolveUserDefinedSymbolConversion(expression.Type, nullableTarget.UnderlyingType, allowExplicit, out var liftedConvOp))
            {
                var liftedArg = liftedConvOp.Parameters.Length == 1
                    ? BindConversion(diagnosticLocation, expression, liftedConvOp.Parameters[0].Type, allowExplicit)
                    : expression;
                var producedUnderlying = new BoundCallExpression(null, liftedConvOp, ImmutableArray.Create(liftedArg));
                return BindConversion(diagnosticLocation, producedUnderlying, type, allowExplicit);
            }

            // Stream E: fall back to a user-defined op_Implicit (and
            // op_Explicit when allowed) on either source or target CLR type.
            if (expression.Type?.ClrType != null && type?.ClrType != null
                && ClrOperatorResolution.TryResolveConversion(expression.Type.ClrType, type.ClrType, allowExplicit, out var convMethod, out var isExplicit))
            {
                _ = isExplicit;
                return new BoundClrConversionCallExpression(null, expression, convMethod, type);
            }

            if (expression.Type != TypeSymbol.Error && type != TypeSymbol.Error)
            {
                Diagnostics.ReportCannotConvert(diagnosticLocation, expression.Type, type);
            }

            return new BoundErrorExpression(null);
        }

        if (!allowExplicit && conversion.IsExplicit)
        {
            Diagnostics.ReportCannotConvertImplicitly(diagnosticLocation, expression.Type, type);
        }

        if (conversion.IsIdentity)
        {
            return expression;
        }

        // Issue #367: a by-ref-like (`ref struct`) value boxes when converted to
        // a reference type (`object`, an interface, a delegate base, etc.), which
        // the CLR forbids. The `(string)span` form is excluded: it lowers to a
        // `ToString()` call rather than a box. Identity conversions (ref struct to
        // the same ref struct) already returned above.
        if (TypeSymbol.IsByRefLike(expression.Type)
            && type != TypeSymbol.String
            && type?.ClrType != null
            && !type.ClrType.IsValueType
            && expression.Type != TypeSymbol.Error)
        {
            Diagnostics.ReportByRefLikeEscape(diagnosticLocation, expression.Type, $"be boxed or converted to the reference type '{type}'");
            return new BoundErrorExpression(null);
        }

        // Issue #504: lower `nil → Nullable<value-type>` to a
        // BoundDefaultExpression of the target Nullable<T>. Value-type
        // Nullable<T> is a CLR struct distinct from T; emitting `ldnull`
        // against a `valuetype System.Nullable<T>` slot produces invalid IL
        // ("Common Language Runtime detected an invalid program"). The
        // default-expression emit path materialises `default(Nullable<T>)`
        // via a pre-allocated `ldloca/initobj/ldloc` slot, which is the
        // verifiable representation of a missing-value Nullable<T>. The
        // reference-type Nullable<T> case (e.g. `nil → string?`) still
        // shares the CLR representation of `T` and is fine emitting `ldnull`,
        // so it continues through the normal BoundConversionExpression path
        // below.
        //
        // Issue #814 / ADR-0084 §L5: the same lowering also applies when the
        // underlying type is an open type parameter — for `[T struct]` the
        // representation is `Nullable<!!T>` (which requires `initobj`), and
        // for `[T class]` an open `T` slot is verifier-strict (the C#
        // compiler also emits `ldloca; initobj !!T` instead of `ldnull`
        // even with a `class` constraint, since `ldnull → !!T` is rejected
        // by ECMA-335 stack typing). Routing both constraint kinds through
        // BoundDefaultExpression produces uniformly verifiable IL.
        if (expression.Type == TypeSymbol.Null
            && type is NullableTypeSymbol nilTargetNullable
            && (nilTargetNullable.UnderlyingType?.ClrType is { IsValueType: true }
                || nilTargetNullable.UnderlyingType is TypeParameterSymbol
                || nilTargetNullable.UnderlyingType is EnumSymbol))
        {
            return new BoundDefaultExpression(null, type);
        }

        // Issue #1256: element-wise tuple conversion lowering. When the source
        // and target are tuple types of the same arity and the classifier above
        // accepted a non-identity (implicit) tuple conversion, the underlying
        // `ValueTuple<…>` instantiations differ at the CLR level, so a direct
        // reinterpret is not verifiable IL. Lower the conversion into a tuple
        // literal whose elements are the per-element converted accesses of the
        // source. The source is evaluated exactly once (spilled into a temp
        // local when it is not already a tuple literal), and each element flows
        // through `BindConversion` recursively so it picks up the correct
        // element conversion (reference upcast no-op, boxing, numeric widening,
        // nullable-reference upcast, …). The emitter then materialises this as a
        // normal `newobj ValueTuple<…>` over the converted element values.
        if (expression.Type is TupleTypeSymbol sourceTuple
            && type is TupleTypeSymbol targetTuple
            && sourceTuple.Arity == targetTuple.Arity)
        {
            return BindTupleConversion(diagnosticLocation, expression, sourceTuple, targetTuple, allowExplicit);
        }

        return new BoundConversionExpression(null, type, expression);
    }

    // ----- CLR parameter / argument conversions -----

    /// <summary>
    /// Issue #506 / ADR-0056: rebinds positional arguments whose declared
    /// CLR parameter type needs an actual IL-visible conversion (boxing,
    /// numeric coercion, func→delegate materialisation, ...). Returns the
    /// input array unchanged when no rebinding is required.
    /// </summary>
    /// <param name="arguments">The source-order bound arguments.</param>
    /// <param name="parameters">The resolved CLR method's parameter list.</param>
    /// <param name="call">The originating call expression (used for argument-
    /// site diagnostic locations).</param>
    /// <param name="parameterMapping">Optional per-source-argument → parameter
    /// index map for named-argument call shapes.</param>
    /// <param name="receiverArgCount">Number of leading argument slots
    /// reserved for a synthesised receiver (0 for plain calls, 1 for
    /// imported extension calls).</param>
    /// <param name="method">Optional resolved CLR method whose declaring type
    /// may be a constructed generic with symbolic user-defined type
    /// arguments (ADR-0087 §3 R5 / issue #765). When supplied alongside
    /// <paramref name="receiverType"/>, parameter targets whose open-def
    /// position is a generic type parameter substitute to the receiver's
    /// symbolic argument so an identity argument (a user-defined struct
    /// passed to <c>List[Box[int32]]::Add</c>) is not boxed at the bind
    /// boundary.</param>
    /// <param name="receiverType">Optional receiver type carrying the
    /// symbolic type arguments referenced by <paramref name="method"/>'s
    /// declaring generic.</param>
    /// <param name="symbolicMethodTypeArgs">Optional symbolic method
    /// type-argument vector (issue #1471). Recovers the real parameter type for
    /// a bare <c>default</c> argument when a method type-argument erased to the
    /// reference-context <c>object</c> placeholder (e.g.
    /// <c>Task.FromResult[T?](default)</c>).</param>
    /// <returns>The (possibly rebound) argument array.</returns>
    public ImmutableArray<BoundExpression> BindClrParameterConversions(
        ImmutableArray<BoundExpression> arguments,
        ParameterInfo[] parameters,
        CallExpressionSyntax call,
        ImmutableArray<int> parameterMapping = default,
        int receiverArgCount = 0,
        MethodInfo method = null,
        TypeSymbol receiverType = null,
        ImmutableArray<TypeSymbol> symbolicMethodTypeArgs = default)
    {
        ImmutableArray<BoundExpression>.Builder builder = null;
        for (var i = 0; i < arguments.Length; i++)
        {
            var paramIndex = parameterMapping.IsDefault ? i : parameterMapping[i];
            var argument = arguments[i];
            var rebound = argument;
            if (paramIndex < parameters.Length)
            {
                var parameterType = parameters[paramIndex].ParameterType;

                // Issue #1391: an untyped `default` literal (bound as a
                // BoundDefaultExpression with the Error sentinel type) survives
                // overload resolution against an imported method via the
                // DefaultLiteralArgumentType wildcard. Materialize it here at the
                // resolved (substituted) parameter type so the emitter lowers it
                // to the correct typed default — `default(int32)` = 0 for
                // `Task.FromResult[int32](default)` — instead of leaking an
                // Error-typed default that produces invalid IL.
                if (!parameterType.IsByRef && argument is BoundDefaultExpression { Type: var defType } && defType == TypeSymbol.Error)
                {
                    // Issue #1471: a generic-method call closed over an open
                    // type parameter (e.g. `Task.FromResult[T?](default)` for an
                    // unconstrained `T`) erases its method type-argument to the
                    // reference-context `object` placeholder, so the closed CLR
                    // parameter type is `object` and `default` would lower to a
                    // `BoundDefaultExpression(object)` → `ldnull`. For an open
                    // `T` (or `T?` over an open `T`) that is unverifiable and
                    // throws `InvalidProgramException` at runtime. Recover the
                    // symbolic parameter type from the method's type-argument
                    // vector so the default lowers against the real type
                    // parameter and emits the verifiable `ldloca; initobj; ldloc`
                    // slot shape uniformly for ref and value instantiations.
                    var defSubstituted = TrySubstituteParameterTypeFromReceiver(method, paramIndex, receiverType)
                        ?? TrySubstituteParameterTypeFromMethodTypeArgs(method, paramIndex, symbolicMethodTypeArgs);
                    var defTargetType = defSubstituted ?? TypeSymbol.FromClrType(parameterType);
                    if (defTargetType != null && defTargetType != TypeSymbol.Error)
                    {
                        rebound = new BoundDefaultExpression(argument.Syntax, defTargetType);
                    }
                }
                else if (!parameterType.IsByRef && argument.Type != TypeSymbol.Error)
                {
                    // ADR-0087 §3 R5 / issue #765: when the call dispatches
                    // through a constructed CLR generic whose type arguments
                    // include user-defined symbolic types (e.g. xs.Add(...)
                    // where xs: List[Box[int32]] and Box is user-defined),
                    // the parameter's open-def type may be a generic type
                    // parameter slot. The closed CLR shape erases that slot
                    // to System.Object, but at emit the receiver materialises
                    // a TypeSpec for `List<Box`1<int32>>` whose Add(!0) really
                    // accepts a Box[int32]. Substitute receiver type-args
                    // into the open parameter so an identity argument is not
                    // boxed at the bind boundary (which would leave a
                    // verifier-rejecting `box T → !0 expected value` IL
                    // sequence at the call site).
                    var substituted = TrySubstituteParameterTypeFromReceiver(
                        method, paramIndex, receiverType);
                    var targetType = substituted ?? TypeSymbol.FromClrType(parameterType);
                    if (argument.Type != targetType
                        && Conversion.Classify(argument.Type, targetType).Exists
                        && NeedsBindClrParameterConversion(argument.Type, parameterType, substituted))
                    {
                        // Issue #506: the source-argument list may not align with
                        // the bound-argument list when a synthesised receiver
                        // occupies leading slots (imported extension calls) or
                        // when params expansion has replaced N positional source
                        // args with one synthesised array. Fall back to the
                        // overall call location when the source slot is absent.
                        var sourceIndex = i - receiverArgCount;
                        var location = call != null && sourceIndex >= 0 && sourceIndex < call.Arguments.Count
                            ? call.Arguments[sourceIndex].Location
                            : call?.Location ?? default;
                        rebound = BindConversion(location, argument, targetType, allowExplicit: true);
                    }
                    else if (argument.Type != targetType
                        && TryApplyUserDefinedImplicitArgumentConversion(argument, targetType, out var udcArg))
                    {
                        // Issue #1459: the resolved parameter type is reachable
                        // only through a user-defined / BCL `op_Implicit` (e.g.
                        // `[]uint8 -> System.ReadOnlySpan[uint8]`,
                        // `Span[uint8] -> ReadOnlySpan[uint8]`,
                        // `Memory[T] -> ReadOnlyMemory[T]`). Built-in
                        // conversions classify above and never reach this
                        // fallback, so existing imported-call overloads keep
                        // selecting unchanged; this only inserts the missing
                        // `op_Implicit` call (as a BoundClrConversionCallExpression)
                        // that the emitter already knows how to lower, mirroring
                        // the user-function argument-coercion path. Without it
                        // the emitter pushed the source type directly and
                        // produced unverifiable IL at imported call sites.
                        rebound = udcArg;
                    }
                }
            }

            if (rebound != argument && builder == null)
            {
                builder = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
                for (var j = 0; j < i; j++)
                {
                    builder.Add(arguments[j]);
                }
            }

            builder?.Add(rebound);
        }

        if (builder == null)
        {
            return arguments;
        }

        for (var i = builder.Count; i < arguments.Length; i++)
        {
            builder.Add(arguments[i]);
        }

        return builder.ToImmutable();
    }

    /// <summary>
    /// ADR-0056 (#344), low-hanging-fruit item #3: a call argument whose
    /// declared parameter type is reachable only through a user-defined CLR
    /// <c>op_Implicit</c> (e.g. <c>[]T -&gt; System.ReadOnlySpan[T]</c> /
    /// <c>Span[T]</c>) is converted here, the same way local-init / explicit-
    /// target conversions go through <see cref="BindConversion(TextLocation, BoundExpression, TypeSymbol, bool)"/>.
    /// Built-in conversions (identity, numeric widening, ...) classify
    /// earlier and never reach this fallback, so existing overloads keep
    /// selecting unchanged. Returns true and emits a
    /// <see cref="BoundClrConversionCallExpression"/> when a user-defined
    /// implicit conversion applies; false leaves the argument as-is.
    /// </summary>
    /// <param name="argument">The bound source argument.</param>
    /// <param name="expectedType">The expected parameter type.</param>
    /// <param name="converted">On <see langword="true"/>, the rebound
    /// argument carrying the user-defined conversion call.</param>
    /// <returns>Whether a user-defined implicit conversion was applied.</returns>
    public bool TryApplyUserDefinedImplicitArgumentConversion(BoundExpression argument, TypeSymbol expectedType, out BoundExpression converted)
    {
        if (argument?.Type?.ClrType != null
            && expectedType?.ClrType != null
            && argument.Type != TypeSymbol.Error
            && ClrOperatorResolution.TryResolveConversion(argument.Type.ClrType, expectedType.ClrType, allowExplicit: false, out var convMethod, out _))
        {
            converted = new BoundClrConversionCallExpression(null, argument, convMethod, expectedType);
            return true;
        }

        // Issue #1017: same-package user-defined implicit conversion operators
        // are modelled as static op_Implicit FunctionSymbols and have no
        // reflectible ClrType during binding, so resolve them symbolically.
        if (argument?.Type != null
            && expectedType != null
            && argument.Type != TypeSymbol.Error
            && TryResolveUserDefinedSymbolConversion(argument.Type, expectedType, allowExplicit: false, out var userConvOp))
        {
            converted = new BoundCallExpression(null, userConvOp, ImmutableArray.Create(argument));
            return true;
        }

        converted = argument;
        return false;
    }

    /// <summary>
    /// ADR-0087 §3 R5 / issue #765: when a method is invoked on a constructed
    /// generic whose type arguments include user-defined symbolic types,
    /// return the substituted symbolic parameter type for the call site so
    /// the binder does not insert a box conversion to the type-erased
    /// <see cref="object"/> shape. Returns <see langword="null"/> when no
    /// substitution applies.
    /// </summary>
    /// <param name="method">The resolved CLR method (may be null).</param>
    /// <param name="paramIndex">Zero-based index into the method's parameter list.</param>
    /// <param name="receiverType">The receiver's bound type symbol.</param>
    /// <returns>The substituted target symbol or <see langword="null"/>.</returns>
    public static TypeSymbol TrySubstituteParameterTypeFromReceiver(
        MethodInfo method,
        int paramIndex,
        TypeSymbol receiverType)
    {
        if (method == null
            || receiverType is not ImportedTypeSymbol imported
            || imported.TypeArguments.IsDefaultOrEmpty
            || !imported.TypeArguments.Any(arg =>
                arg is StructSymbol
                || arg is InterfaceSymbol
                || arg is EnumSymbol
                || arg is DelegateTypeSymbol
                || (arg is ImportedTypeSymbol nested && nested.HasTypeParameterArgument == false
                    && !nested.TypeArguments.IsDefaultOrEmpty)))
        {
            return null;
        }

        var declaring = method.DeclaringType;
        if (declaring == null || !declaring.IsConstructedGenericType)
        {
            return null;
        }

        var openDef = declaring.GetGenericTypeDefinition();
        MethodInfo openMethod = null;
        foreach (var candidate in openDef.GetMethods(
            BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (candidate.MetadataToken == method.MetadataToken && candidate.Module == method.Module)
            {
                openMethod = candidate;
                break;
            }
        }

        if (openMethod == null)
        {
            return null;
        }

        var openParams = openMethod.GetParameters();
        if (paramIndex < 0 || paramIndex >= openParams.Length)
        {
            return null;
        }

        var openParamType = openParams[paramIndex].ParameterType;
        if (openParamType.IsGenericParameter
            && openParamType.DeclaringMethod == null
            && openParamType.GenericParameterPosition < imported.TypeArguments.Length)
        {
            return imported.TypeArguments[openParamType.GenericParameterPosition];
        }

        return null;
    }

    /// <summary>
    /// Issue #1471: recovers the symbolic parameter type for a generic CLR
    /// method invoked with a method-level type-argument vector that includes an
    /// open type parameter (or a same-compilation user type). The closed CLR
    /// method erases such arguments to the reference-context <see cref="object"/>
    /// placeholder, so the closed parameter type is <c>object</c>; mapping the
    /// open method parameter through <paramref name="methodTypeArgs"/> recovers
    /// the real symbol (e.g. <c>T?</c> for <c>Task.FromResult[T?]</c>). Returns
    /// <see langword="null"/> when no symbolic recovery applies, so concrete
    /// instantiations keep flowing through the erased CLR shape unchanged.
    /// </summary>
    /// <param name="method">The resolved (closed) CLR method (may be null).</param>
    /// <param name="paramIndex">Zero-based index into the method's parameter list.</param>
    /// <param name="methodTypeArgs">The symbolic method type-argument vector.</param>
    /// <returns>The recovered symbolic parameter type, or <see langword="null"/>.</returns>
    public static TypeSymbol TrySubstituteParameterTypeFromMethodTypeArgs(
        MethodInfo method,
        int paramIndex,
        ImmutableArray<TypeSymbol> methodTypeArgs)
    {
        if (method == null
            || !method.IsGenericMethod
            || methodTypeArgs.IsDefaultOrEmpty
            || paramIndex < 0)
        {
            return null;
        }

        var openMethod = method.IsGenericMethodDefinition ? method : method.GetGenericMethodDefinition();
        var openParams = openMethod.GetParameters();
        if (paramIndex >= openParams.Length)
        {
            return null;
        }

        var openParamType = openParams[paramIndex].ParameterType;
        if (openParamType.IsByRef)
        {
            openParamType = openParamType.GetElementType();
        }

        if (openParamType == null)
        {
            return null;
        }

        var mapped = MemberLookup.MapOpenClrTypeToSymbolic(
            openParamType,
            openDefinition: null,
            typeArguments: default,
            openMethodDefinition: openMethod,
            methodTypeArguments: methodTypeArgs);

        return mapped != null
            && mapped != TypeSymbol.Error
            && (TypeSymbol.ContainsTypeParameter(mapped) || TypeSymbol.ContainsSameCompilationUserType(mapped))
            ? mapped
            : null;
    }

    // ----- Method-group → delegate conversions -----

    /// <summary>
    /// Issue #337: resolves a CLR member method group whose target delegate
    /// signature drives overload selection. Produces a
    /// <see cref="BoundClrMethodGroupExpression"/> carrying the resolved
    /// <see cref="MethodInfo"/> (or a <see cref="BoundErrorExpression"/>
    /// with a diagnostic when no compatible candidate exists).
    /// </summary>
    /// <param name="diagnosticLocation">The location for reported diagnostics.</param>
    /// <param name="group">The unresolved CLR method group.</param>
    /// <param name="targetType">The target delegate type.</param>
    /// <returns>The shaped bound expression.</returns>
    public BoundExpression BindClrMethodGroupConversion(TextLocation diagnosticLocation, BoundClrMethodGroupExpression group, TypeSymbol targetType)
    {
        var delegateClr = targetType?.ClrType;
        if (delegateClr == null || !ClrTypeUtilities.IsDelegateType(delegateClr))
        {
            // A non-delegate target (e.g. `var x int32 = Console.WriteLine`) or
            // an already-errored target: report unless the target itself is an
            // error type (which already produced a diagnostic).
            if (targetType != null && targetType != TypeSymbol.Error)
            {
                Diagnostics.ReportCannotConvertMethodGroup(diagnosticLocation, group.MethodName, targetType);
            }

            return new BoundErrorExpression(null);
        }

        var invoke = delegateClr.GetMethodSafe("Invoke");
        if (invoke == null)
        {
            Diagnostics.ReportCannotConvertMethodGroup(diagnosticLocation, group.MethodName, targetType);
            return new BoundErrorExpression(null);
        }

        var invokeParams = invoke.GetParameters();
        var argTypes = new Type[invokeParams.Length];
        for (var i = 0; i < invokeParams.Length; i++)
        {
            argTypes[i] = invokeParams[i].ParameterType;
        }

        var applicable = new List<MethodInfo>();
        foreach (var candidate in group.Candidates)
        {
            if (candidate.GetParameters().Length != invokeParams.Length)
            {
                continue;
            }

            if (!IsMethodGroupReturnCompatible(candidate.ReturnType, invoke.ReturnType))
            {
                continue;
            }

            applicable.Add(candidate);
        }

        if (applicable.Count > 0)
        {
            var resolution = OverloadResolution.Resolve(applicable, argTypes);
            if (resolution.Outcome == OverloadResolution.ResolutionOutcome.Resolved)
            {
                return new BoundClrMethodGroupExpression(group.Syntax, group.Receiver, resolution.Best, targetType);
            }
        }

        Diagnostics.ReportCannotConvertMethodGroup(diagnosticLocation, group.MethodName, targetType);
        return new BoundErrorExpression(null);
    }

    /// <summary>
    /// ADR-0063 §9: resolves a multi-overload user-function method group
    /// against a target delegate or native function type. The pick is the
    /// unique candidate whose parameter types and return type exactly match
    /// the target's invoke signature. When zero or multiple candidates
    /// match, a <c>GS0218</c> ("cannot convert method group") diagnostic
    /// is reported.
    /// </summary>
    /// <param name="diagnosticLocation">The location for reported diagnostics.</param>
    /// <param name="group">The unresolved user-function method group.</param>
    /// <param name="targetType">The target delegate / function type.</param>
    /// <returns>The shaped bound expression.</returns>
    public BoundExpression BindUserMethodGroupConversion(TextLocation diagnosticLocation, BoundMethodGroupExpression group, TypeSymbol targetType)
    {
        var groupName = group.Function?.Name ?? "<method group>";

        ImmutableArray<TypeSymbol> targetParameterTypes;
        TypeSymbol targetReturnType;
        if (targetType is FunctionTypeSymbol nativeFn)
        {
            targetParameterTypes = nativeFn.ParameterTypes;
            targetReturnType = nativeFn.ReturnType;
        }
        else if (targetType is DelegateTypeSymbol userDelegate)
        {
            var pb = ImmutableArray.CreateBuilder<TypeSymbol>(userDelegate.Parameters.Length);
            foreach (var p in userDelegate.Parameters)
            {
                pb.Add(p.Type);
            }

            targetParameterTypes = pb.MoveToImmutable();
            targetReturnType = userDelegate.ReturnType;
        }
        else
        {
            if (targetType != null && targetType != TypeSymbol.Error)
            {
                Diagnostics.ReportCannotConvertMethodGroup(diagnosticLocation, groupName, targetType);
            }

            return new BoundErrorExpression(null);
        }

        FunctionSymbol pick = null;
        foreach (var candidate in group.Candidates)
        {
            if (candidate.Parameters.Length != targetParameterTypes.Length)
            {
                continue;
            }

            var paramsMatch = true;
            for (var i = 0; i < candidate.Parameters.Length; i++)
            {
                if (!ReferenceEquals(candidate.Parameters[i].Type, targetParameterTypes[i]))
                {
                    paramsMatch = false;
                    break;
                }
            }

            if (!paramsMatch)
            {
                continue;
            }

            var candidateReturn = candidate.Type ?? TypeSymbol.Void;
            if (!ReferenceEquals(candidateReturn, targetReturnType))
            {
                continue;
            }

            if (pick != null)
            {
                Diagnostics.ReportCannotConvertMethodGroup(diagnosticLocation, groupName, targetType);
                return new BoundErrorExpression(null);
            }

            pick = candidate;
        }

        if (pick == null)
        {
            Diagnostics.ReportCannotConvertMethodGroup(diagnosticLocation, groupName, targetType);
            return new BoundErrorExpression(null);
        }

        var pickParams = ImmutableArray.CreateBuilder<TypeSymbol>(pick.Parameters.Length);
        foreach (var p in pick.Parameters)
        {
            pickParams.Add(p.Type);
        }

        var pickFnType = FunctionTypeSymbol.Get(pickParams.MoveToImmutable(), pick.Type ?? TypeSymbol.Void);
        var resolvedGroup = new BoundMethodGroupExpression(group.Syntax, group.Receiver, pick, pickFnType);

        // If the target is the native function type matching the pick exactly,
        // identity-convert; otherwise let the regular conversion machinery turn
        // the function-typed value into the user delegate.
        if (ReferenceEquals(targetType, pickFnType))
        {
            return resolvedGroup;
        }

        var conversion = Conversion.Classify(pickFnType, targetType);
        if (!conversion.Exists)
        {
            Diagnostics.ReportCannotConvertMethodGroup(diagnosticLocation, groupName, targetType);
            return new BoundErrorExpression(null);
        }

        if (conversion.IsIdentity)
        {
            return resolvedGroup;
        }

        return new BoundConversionExpression(null, targetType, resolvedGroup);
    }

    // ----- Ref-kind argument validation -----

    /// <summary>
    /// ADR-0062: binds a conditional ref-argument
    /// (<c>cond ? &amp;a : &amp;b</c>) and validates the inner / outer
    /// ref-kind compatibility, l-value-ness, and branch type agreement.
    /// </summary>
    /// <param name="syntax">The conditional ref-argument syntax.</param>
    /// <param name="outerModifier">The outer ref-kind modifier token, or
    /// <see langword="null"/> for the bare <c>&amp;</c> operand form.</param>
    /// <returns>The shaped bound expression.</returns>
    public BoundExpression BindConditionalRefArgument(
        ConditionalRefArgumentExpressionSyntax syntax,
        SyntaxToken outerModifier)
    {
        // Condition must be bool.
        var condition = bindExpressionWithTargetType(syntax.Condition, TypeSymbol.Bool);

        // Inner-modifier matching (GS0251). The outer modifier text is `ref`,
        // `out`, `in`, or `&`. The bare `&` form (outerModifier == null) maps
        // to `ref`/`&` semantics; an inner `in`/`out` on a `&` operand is a
        // mismatch since `&` already denotes mutable byref.
        string outerText = outerModifier?.Text ?? "&";
        if (syntax.WhenTrueRefKindModifier != null
            && !InnerModifierMatchesOuter(syntax.WhenTrueRefKindModifier.Text, outerText))
        {
            Diagnostics.ReportConditionalRefArgumentInnerModifierMismatch(
                syntax.WhenTrueRefKindModifier.Location,
                outerText,
                syntax.WhenTrueRefKindModifier.Text);
            return new BoundErrorExpression(null);
        }

        if (syntax.WhenFalseRefKindModifier != null
            && !InnerModifierMatchesOuter(syntax.WhenFalseRefKindModifier.Text, outerText))
        {
            Diagnostics.ReportConditionalRefArgumentInnerModifierMismatch(
                syntax.WhenFalseRefKindModifier.Location,
                outerText,
                syntax.WhenFalseRefKindModifier.Text);
            return new BoundErrorExpression(null);
        }

        // Each branch must itself be a plain lvalue expression — not a nested
        // conditional, not a ref-argument, not an inline-declaration. We
        // explicitly reject the inline-declaration form here (GS0250) before
        // attempting to bind.
        if (syntax.WhenTrue is RefArgumentExpressionSyntax wtRefArg && wtRefArg.IsInlineDeclaration)
        {
            Diagnostics.ReportInlineDeclarationInConditionalRefBranch(wtRefArg.Location);
            return new BoundErrorExpression(null);
        }

        if (syntax.WhenFalse is RefArgumentExpressionSyntax wfRefArg && wfRefArg.IsInlineDeclaration)
        {
            Diagnostics.ReportInlineDeclarationInConditionalRefBranch(wfRefArg.Location);
            return new BoundErrorExpression(null);
        }

        var whenTrue = bindExpression(syntax.WhenTrue);
        var whenFalse = bindExpression(syntax.WhenFalse);

        if (whenTrue is BoundErrorExpression || whenFalse is BoundErrorExpression || condition is BoundErrorExpression)
        {
            return new BoundErrorExpression(null);
        }

        if (!isLvalue(whenTrue))
        {
            Diagnostics.ReportCannotTakeAddressOfNonLvalue(syntax.WhenTrue.Location, syntax.WhenTrue.ToString());
            return new BoundErrorExpression(null);
        }

        if (!isLvalue(whenFalse))
        {
            Diagnostics.ReportCannotTakeAddressOfNonLvalue(syntax.WhenFalse.Location, syntax.WhenFalse.ToString());
            return new BoundErrorExpression(null);
        }

        // Branch types must match exactly — no implicit widening or nullable
        // adjustment, since the resulting byref selects between slots whose
        // physical type must agree.
        if (!ReferenceEquals(whenTrue.Type, whenFalse.Type)
            && !string.Equals(whenTrue.Type?.Name, whenFalse.Type?.Name, System.StringComparison.Ordinal))
        {
            Diagnostics.ReportConditionalRefArgumentBranchTypeMismatch(
                syntax.Location,
                whenTrue.Type?.Name ?? "?",
                whenFalse.Type?.Name ?? "?");
            return new BoundErrorExpression(null);
        }

        // Readonly check: for `ref` (and bare `&`), neither branch may be a
        // read-only local. For `in` either branch may be read-only. For `out`
        // both must be writable. (Definite-assignment is enforced elsewhere
        // by RefKindDefiniteAssignmentAnalyzer.)
        bool requiresWritable = outerText == "ref" || outerText == "out" || outerText == "&";
        if (requiresWritable)
        {
            if (whenTrue is BoundVariableExpression wtVar && wtVar.Variable.IsReadOnly)
            {
                Diagnostics.ReportCannotTakeAddressOfConstant(syntax.WhenTrue.Location, wtVar.Variable.Name);
                return new BoundErrorExpression(null);
            }

            if (whenFalse is BoundVariableExpression wfVar && wfVar.Variable.IsReadOnly)
            {
                Diagnostics.ReportCannotTakeAddressOfConstant(syntax.WhenFalse.Location, wfVar.Variable.Name);
                return new BoundErrorExpression(null);
            }
        }

        return new BoundConditionalAddressExpression(null, condition, whenTrue, whenFalse, whenTrue.Type);
    }

    /// <summary>
    /// ADR-0060: validates a parameter's <see cref="RefKind"/> against the
    /// surrounding declaration shape (pointer-typed parameters, variadic
    /// parameters, async/iterator functions). Surfaces the corresponding
    /// diagnostic for each violation and returns the (possibly downgraded)
    /// <see cref="RefKind"/>.
    /// </summary>
    /// <param name="parameterSyntax">The parameter syntax.</param>
    /// <param name="parameterName">The parameter's declared name.</param>
    /// <param name="parameterType">The bound parameter type.</param>
    /// <param name="isVariadic">Whether the parameter is variadic.</param>
    /// <param name="asyncOrIteratorKind">A non-<see langword="null"/> kind
    /// label (<c>"async"</c> / <c>"iterator"</c>) when the surrounding
    /// function is a state-machine kickoff that cannot host a managed
    /// pointer.</param>
    /// <returns>The validated ref-kind.</returns>
    public RefKind BindAndValidateParameterRefKind(
        ParameterSyntax parameterSyntax,
        string parameterName,
        TypeSymbol parameterType,
        bool isVariadic,
        string asyncOrIteratorKind)
    {
        var parameterRefKind = getRefKindFromModifier(parameterSyntax.RefKindModifier);

        // ADR-0060 §2: a `*T` type cannot appear as a parameter type. The CLR's
        // managed-pointer-typed parameter slot would normally surface as `T&`
        // via the keyword form; suggest the rewrite.
        if (parameterType is ByRefTypeSymbol pointerParamType)
        {
            Diagnostics.ReportPointerTypeCannotBeParameterType(
                parameterSyntax.Type.Location,
                parameterName,
                pointerParamType.PointeeType.Name);
        }

        // ADR-0060 §8: a variadic parameter (`...T`) cannot also carry a ref-kind
        // modifier — the CLR cannot represent an array of managed pointers.
        if (parameterRefKind != RefKind.None && isVariadic)
        {
            Diagnostics.ReportRefKindOnVariadicParameter(parameterSyntax.Location, parameterName);
            parameterRefKind = RefKind.None;
        }

        // ADR-0060 §10: ban ref-kind parameters on async / iterator (sequence) functions.
        // The state-machine rewriter cannot hoist a managed pointer into a field.
        if (parameterRefKind != RefKind.None && asyncOrIteratorKind != null)
        {
            Diagnostics.ReportRefKindOnAsyncOrIterator(parameterSyntax.Location, parameterName, asyncOrIteratorKind);
            parameterRefKind = RefKind.None;
        }

        return parameterRefKind;
    }

    /// <summary>
    /// ADR-0060: at call sites that target a G#-authored
    /// function/method/constructor with a <c>ref</c>/<c>out</c>/<c>in</c>
    /// parameter, the bound argument should already be a
    /// <see cref="BoundAddressOfExpression"/> whose operand type matches
    /// the parameter's pointee type. In that case we pass the argument
    /// through unchanged — the conversion machinery would otherwise try
    /// to coerce <c>*T</c> into <c>T</c> and fail.
    /// </summary>
    /// <param name="location">The diagnostic location for any conversion
    /// error.</param>
    /// <param name="argument">The bound argument.</param>
    /// <param name="expectedType">The (substituted) parameter type.</param>
    /// <param name="parameter">The target parameter (carrying
    /// <see cref="RefKind"/>).</param>
    /// <returns>The argument, possibly with a normal conversion applied.</returns>
    public BoundExpression BindCallArgumentWithRefKind(
        TextLocation location,
        BoundExpression argument,
        TypeSymbol expectedType,
        ParameterSymbol parameter)
    {
        if (parameter != null && parameter.RefKind != RefKind.None)
        {
            if (argument is BoundAddressOfExpression addr)
            {
                var operandType = addr.Operand?.Type;
                if (operandType == expectedType || operandType == TypeSymbol.Error || expectedType == TypeSymbol.Error)
                {
                    return argument;
                }

                // Fall through: type mismatch on the address-of operand. Surface
                // the standard "cannot convert" diagnostic via BindConversion.
            }
            else if (argument is BoundConditionalAddressExpression condAddr)
            {
                // ADR-0061: conditional address-of also accepted at ref-kind
                // parameter positions. The shared pointee type was validated
                // by BindConditionalRefArgument.
                var pointeeType = condAddr.PointeeType;
                if (pointeeType == expectedType || pointeeType == TypeSymbol.Error || expectedType == TypeSymbol.Error)
                {
                    return argument;
                }
            }
        }

        return BindConversion(location, argument, expectedType);
    }

    // ----- Optional / default-value argument shaping -----

    /// <summary>
    /// ADR-0063: binds, validates, and (when valid) records a user-declared
    /// optional default value on <paramref name="parameter"/>. Enforces the
    /// v1 restrictions: the default must be a compile-time constant
    /// representable in CLR parameter metadata, the parameter must not be
    /// <c>ref</c>/<c>out</c>/<c>in</c>, must not be variadic, and must not
    /// be the receiver parameter. Reports
    /// <see cref="DiagnosticBag.ReportInvalidOptionalParameter"/> on misuse.
    /// </summary>
    /// <param name="parameterSyntax">The parameter syntax carrying the
    /// default clause.</param>
    /// <param name="parameter">The bound parameter symbol to attach the
    /// default to.</param>
    /// <param name="isReceiver">True when the parameter is a method's source
    /// receiver.</param>
    public void BindAndAttachParameterDefaultValue(ParameterSyntax parameterSyntax, ParameterSymbol parameter, bool isReceiver = false)
    {
        if (parameterSyntax == null || !parameterSyntax.HasDefaultValue || parameter == null)
        {
            return;
        }

        var location = parameterSyntax.DefaultValue?.Location ?? parameterSyntax.Location;

        if (isReceiver)
        {
            Diagnostics.ReportInvalidOptionalParameter(location, parameter.Name, "the receiver parameter cannot declare a default value.");
            return;
        }

        if (parameter.IsVariadic)
        {
            Diagnostics.ReportInvalidOptionalParameter(location, parameter.Name, "a variadic parameter cannot declare a default value.");
            return;
        }

        if (parameter.RefKind != RefKind.None)
        {
            Diagnostics.ReportInvalidOptionalParameter(location, parameter.Name, $"a '{refKindToString(parameter.RefKind)}' parameter cannot declare a default value.");
            return;
        }

        // Bind the default-value expression in the surrounding scope. Diagnostics
        // (undefined symbol, etc.) bubble through normally.
        var bound = bindExpression(parameterSyntax.DefaultValue);
        if (bound == null || bound is BoundErrorExpression || parameter.Type == TypeSymbol.Error)
        {
            return;
        }

        // The default must be a compile-time constant of one of the kinds the CLR
        // parameter Constant table can represent.
        if (!TryExtractConstantDefault(bound, parameter.Type, out var constant, out var reason))
        {
            Diagnostics.ReportInvalidOptionalParameter(location, parameter.Name, reason);
            return;
        }

        parameter.SetExplicitDefaultValue(constant);
    }

    // ----- using-statement helper -----

    /// <summary>
    /// ADR-0048 / using-statement support: builds a <c>variable.Dispose()</c>
    /// call against the CLR <c>Dispose</c> method on the variable's type.
    /// Reports <see cref="DiagnosticBag.ReportTypeNotDisposable"/> when the
    /// type does not expose a public parameterless <c>Dispose</c>.
    /// </summary>
    /// <param name="variable">The variable to dispose.</param>
    /// <param name="location">The diagnostic location.</param>
    /// <returns>The bound call expression, or <see langword="null"/> on
    /// failure.</returns>
    public BoundExpression TryBuildDisposeCall(VariableSymbol variable, TextLocation location)
    {
        // #568 primary path: if the variable's type is a user-defined class
        // that declares a public parameterless Dispose() (including via
        // IDisposable implementation), route through user-instance-call.
        if (variable.Type is StructSymbol userType
            && TypeMemberModel.TryGetMethodIncludingInherited(userType, "Dispose", out var userDispose)
            && userDispose.Parameters.Length == 0
            && (userDispose.Type == TypeSymbol.Void || userDispose.Type == null)
            && userDispose.Accessibility == Accessibility.Public)
        {
            var receiver = new BoundVariableExpression(null, variable);
            return new BoundUserInstanceCallExpression(null, receiver, userDispose, ImmutableArray<BoundExpression>.Empty);
        }

        // Extended CLR-type path: walk self + transitive interfaces so a
        // CLR class inheriting Dispose solely through IDisposable is found.
        var clrType = variable.Type?.ClrType;
        if (clrType == null)
        {
            Diagnostics.ReportTypeNotDisposable(location, variable.Type ?? TypeSymbol.Error);
            return null;
        }

        var disposeMethod = MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(clrType, "Dispose", Type.EmptyTypes);
        if (disposeMethod == null)
        {
            Diagnostics.ReportTypeNotDisposable(location, variable.Type);
            return null;
        }

        var receiver2 = new BoundVariableExpression(null, variable);
        return new BoundImportedInstanceCallExpression(null, receiver2, disposeMethod, TypeSymbol.Void, ImmutableArray<BoundExpression>.Empty);
    }

    /// <summary>
    /// Issue #605: builds a bound <c>await receiver.DisposeAsync()</c> expression.
    /// Probes for a public parameterless <c>DisposeAsync()</c> returning
    /// <see cref="System.Threading.Tasks.ValueTask"/> on user-defined G# classes
    /// and CLR types (via <c>IAsyncDisposable</c>).
    /// Reports <see cref="DiagnosticBag.ReportTypeNotAsyncDisposable"/> on failure.
    /// </summary>
    /// <param name="variable">The variable to async-dispose.</param>
    /// <param name="location">The diagnostic location.</param>
    /// <returns>A <see cref="BoundAwaitExpression"/> wrapping the DisposeAsync call, or <c>null</c> on failure.</returns>
    public BoundExpression TryBuildDisposeAsyncCall(VariableSymbol variable, TextLocation location)
    {
        var valueTaskType = TypeSymbol.FromClrType(typeof(System.Threading.Tasks.ValueTask));

        // User-defined G# class path: probe for DisposeAsync() returning ValueTask.
        if (variable.Type is StructSymbol userType
            && TypeMemberModel.TryGetMethodIncludingInherited(userType, "DisposeAsync", out var userDisposeAsync)
            && userDisposeAsync.Parameters.Length == 0
            && userDisposeAsync.Accessibility == Accessibility.Public)
        {
            var receiver = new BoundVariableExpression(null, variable);
            var call = new BoundUserInstanceCallExpression(null, receiver, userDisposeAsync, ImmutableArray<BoundExpression>.Empty);
            return new BoundAwaitExpression(null, call, TypeSymbol.Void);
        }

        // CLR-type path: walk self + transitive interfaces for DisposeAsync.
        var clrType = variable.Type?.ClrType;
        if (clrType == null)
        {
            Diagnostics.ReportTypeNotAsyncDisposable(location, variable.Type ?? TypeSymbol.Error);
            return null;
        }

        var disposeAsyncMethod = MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(clrType, "DisposeAsync", Type.EmptyTypes);
        if (disposeAsyncMethod == null ||
            disposeAsyncMethod.ReturnType.FullName != "System.Threading.Tasks.ValueTask")
        {
            Diagnostics.ReportTypeNotAsyncDisposable(location, variable.Type);
            return null;
        }

        var receiver2 = new BoundVariableExpression(null, variable);
        var clrCall = new BoundImportedInstanceCallExpression(null, receiver2, disposeAsyncMethod, valueTaskType, ImmutableArray<BoundExpression>.Empty);
        return new BoundAwaitExpression(null, clrCall, TypeSymbol.Void);
    }

    // Issue #1334: shared accessor so the generic-LINQ delegate-argument rebind
    // path (ExpressionBinder.Calls) can apply the same NUMERIC-only return
    // widening gate used by BindConversion, rather than an over-broad implicit
    // conversion check that erased same-compilation user-type projections.
    internal static bool IsNumericReturnWidening(TypeSymbol source, TypeSymbol target)
    {
        return IsNumericReturnWideningCore(source, target);
    }

    // ----- Private helpers (kept here because they are only used by methods in this class) -----

    /// <summary>
    /// Issue #1017: resolves a user-defined conversion declared on a
    /// same-package struct/class as a static <c>op_Implicit</c> /
    /// <c>op_Explicit</c> method. Searches both the source and target type's
    /// static methods, preferring implicit conversions over explicit ones, just
    /// like C#. These symbols have no reflectible CLR type during binding, so
    /// the lookup is symbolic.
    /// </summary>
    /// <param name="sourceType">The type of the value being converted.</param>
    /// <param name="targetType">The type being converted to.</param>
    /// <param name="allowExplicit">Whether <c>op_Explicit</c> is acceptable.</param>
    /// <param name="method">The resolved conversion method on success.</param>
    /// <returns><see langword="true"/> if a conversion was found.</returns>
    private static bool TryResolveUserDefinedSymbolConversion(TypeSymbol sourceType, TypeSymbol targetType, bool allowExplicit, out FunctionSymbol method)
    {
        method = null;
        if (sourceType == null || targetType == null
            || sourceType == TypeSymbol.Error || targetType == TypeSymbol.Error)
        {
            return false;
        }

        // Pass 1: implicit conversions on the source then the target type.
        if (TryFindUserConversion(sourceType, "op_Implicit", sourceType, targetType, out method)
            || TryFindUserConversion(targetType, "op_Implicit", sourceType, targetType, out method))
        {
            return true;
        }

        if (!allowExplicit)
        {
            return false;
        }

        // Pass 2: explicit conversions on the source then the target type.
        return TryFindUserConversion(sourceType, "op_Explicit", sourceType, targetType, out method)
            || TryFindUserConversion(targetType, "op_Explicit", sourceType, targetType, out method);
    }

    private static bool TryFindUserConversion(TypeSymbol declaring, string opName, TypeSymbol source, TypeSymbol target, out FunctionSymbol method)
    {
        method = null;
        var owner = (declaring as StructSymbol)?.Definition ?? declaring as StructSymbol;
        if (owner == null || owner.StaticMethods.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var candidate in owner.StaticMethods)
        {
            if (!string.Equals(candidate.Name, opName, StringComparison.Ordinal)
                || candidate.Parameters.Length != 1)
            {
                continue;
            }

            if (Conversion.Classify(candidate.Parameters[0].Type, source).IsIdentity
                && Conversion.Classify(candidate.Type, target).IsIdentity)
            {
                method = candidate;
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #506 follow-up: returns <see langword="true"/> when the bound
    /// argument's static type needs an actual IL-visible conversion to land in
    /// the CLR parameter's slot (boxing, numeric coercion, func→delegate
    /// materialisation, etc.). Skips no-op rewraps where the source and
    /// destination share the same CLR type — for example
    /// <c>string?</c> → <c>string</c>, where the difference is purely the
    /// nullability wrapper and emit is identical. Those no-op rewraps would
    /// otherwise wrap a <see cref="BoundVariableExpression"/> argument in a
    /// <see cref="BoundConversionExpression"/>, defeating nullable-flow
    /// narrowing patterns (e.g. <c>!String.IsNullOrEmpty(s)</c> can no longer
    /// strip <c>s</c>'s nullability).
    /// </summary>
    /// <param name="from">The bound argument's static type.</param>
    /// <param name="targetParameterType">The CLR parameter type.</param>
    /// <param name="substitutedTarget">Optional substituted target type
    /// recovered from the receiver's symbolic type arguments
    /// (ADR-0087 §3 R5 / issue #765). When non-null and equal to
    /// <paramref name="from"/>, the conversion is treated as identity.</param>
    /// <returns>Whether a rebinding conversion is required.</returns>
    private static bool NeedsBindClrParameterConversion(TypeSymbol from, Type targetParameterType, TypeSymbol substitutedTarget = null)
    {
        if (from == null || targetParameterType == null)
        {
            return false;
        }

        // ADR-0087 §3 R5 / issue #765: if the call's emit-time target is
        // recovered from receiver type-args (e.g. List[Box[int32]]::Add
        // really targets `!0` which is `Box[int32]`), an argument whose
        // static type already matches that substituted target is identity
        // — no conversion required.
        _ = substitutedTarget;
        if (substitutedTarget != null && from == substitutedTarget)
        {
            return false;
        }

        // FunctionTypeSymbol carries no ClrType but always needs delegate
        // materialisation when handed to a CLR delegate parameter.
        if (from.ClrType == null)
        {
            return true;
        }

        return from.ClrType != targetParameterType;
    }

    // Issue #1150: a func/arrow literal's natural numeric return type
    // implicitly, losslessly widens to a target delegate's numeric return type
    // per the standard widening lattice. Both types must be numeric CLR
    // primitives and the conversion classified implicit (i.e. directional
    // widening — narrowing and signed/unsigned same-width pairs are excluded).
    private static bool IsNumericReturnWideningCore(TypeSymbol source, TypeSymbol target)
    {
        var sourceClr = source?.ClrType?.FullName;
        var targetClr = target?.ClrType?.FullName;
        if (sourceClr == null || targetClr == null
            || !NumericPrimitiveFullNames.Contains(sourceClr)
            || !NumericPrimitiveFullNames.Contains(targetClr))
        {
            return false;
        }

        var conversion = Conversion.Classify(source, target);
        return conversion.Exists && conversion.IsImplicit;
    }

    // Issue #337: a method-group overload's return type is compatible with a
    // delegate's Invoke return type when both are void, or when the method's
    // (non-void) return is identity / implicitly reference- or value-convertible
    // (by name, MetadataLoadContext-safe) to the delegate's (non-void) return.
    private static bool IsMethodGroupReturnCompatible(Type methodReturn, Type invokeReturn)
    {
        var invokeVoid = invokeReturn == null
            || string.Equals(invokeReturn.FullName, "System.Void", StringComparison.Ordinal);
        var methodVoid = methodReturn == null
            || string.Equals(methodReturn.FullName, "System.Void", StringComparison.Ordinal);

        if (invokeVoid || methodVoid)
        {
            return invokeVoid && methodVoid;
        }

        return ClrTypeUtilities.IsAssignableByName(invokeReturn, methodReturn);
    }

    // ADR-0062: an inner ref-kind modifier on a conditional ref-argument branch
    // must agree with the outer modifier text (`ref`, `out`, `in`, or `&`).
    // The bare `&` form is compatible only with `ref` / `&` semantics.
    private static bool InnerModifierMatchesOuter(string inner, string outer)
    {
        if (string.Equals(inner, outer, StringComparison.Ordinal))
        {
            return true;
        }

        if (string.Equals(outer, "&", StringComparison.Ordinal))
        {
            return string.Equals(inner, "ref", StringComparison.Ordinal);
        }

        if (string.Equals(inner, "&", StringComparison.Ordinal))
        {
            return string.Equals(outer, "ref", StringComparison.Ordinal);
        }

        return false;
    }

    // Issue #327/#321: extracts the CLR `RawDefaultValue` for an optional
    // parameter when it is one of the primitive/string constant kinds that
    // BoundLiteralExpression carries directly; returns false for `[Optional]`
    // without a constant and any non-primitive type.
    private static bool TryGetConstantParameterDefault(ParameterInfo parameter, out object value)
    {
        value = null;
        object raw;
        try
        {
            raw = parameter.RawDefaultValue;
        }
        catch
        {
            return false;
        }

        if (raw == null || raw is System.DBNull)
        {
            return false;
        }

        // Only primitive/string constants flow through BoundLiteralExpression's
        // known value kinds; the constant's CLR type is also the IL form for an
        // enum parameter (whose default is encoded as its underlying integral).
        switch (raw)
        {
            case bool:
            case sbyte:
            case byte:
            case short:
            case ushort:
            case int:
            case uint:
            case long:
            case ulong:
            case float:
            case double:
            case char:
            case string:
                value = raw;
                return true;
            default:
                return false;
        }
    }

    // ADR-0063: extracts a CLR-Constant-table representable default value from a
    // bound expression, applying limited implicit conversion to the parameter type
    // (numeric widening / nil → reference|nullable). Returns false with a
    // human-visible reason otherwise.
    private static bool TryExtractConstantDefault(BoundExpression bound, TypeSymbol parameterType, out object value, out string reason)
    {
        value = null;
        reason = null;

        // Unwrap a conversion that the binder may have inserted around a literal.
        var inner = bound;
        while (inner is BoundConversionExpression bce)
        {
            inner = bce.Expression;
        }

        if (inner is BoundLiteralExpression lit)
        {
            value = lit.Value;
        }
        else if (inner is BoundDefaultExpression def)
        {
            // Issue #1182: a value-type `default(T)` (and the zero-value `T()`
            // form, which the binder also lowers to a BoundDefaultExpression for
            // value types with no surfaced parameterless constructor) is a valid
            // compile-time constant — the type's all-zero value. Accept it and
            // record a constant the call site can materialize, mirroring C#.
            return TryExtractValueTypeDefaultConstant(def, parameterType, out value, out reason);
        }
        else
        {
            reason = "the default value must be a compile-time constant (numeric, bool, char, string, enum, nil, or a value-type default(T)).";
            return false;
        }

        // `nil` is only valid for a reference-compatible or nullable parameter type.
        if (value == null)
        {
            if (parameterType is NullableTypeSymbol || (parameterType.ClrType is System.Type ct && !ct.IsValueType))
            {
                return true;
            }

            reason = $"'nil' is not a valid default for value-type parameter of type '{parameterType.Name}'.";
            value = null;
            return false;
        }

        // Numeric / bool / char / string / enum-underlying types are CLR Constant-table representable.
        switch (value)
        {
            case bool:
            case sbyte:
            case byte:
            case short:
            case ushort:
            case int:
            case uint:
            case long:
            case ulong:
            case float:
            case double:
            case char:
            case string:
                return true;
            default:
                reason = $"the default value type '{value.GetType().Name}' is not representable in CLR parameter metadata.";
                value = null;
                return false;
        }
    }

    // Issue #1182: extracts the constant default for a value-type `default(T)` /
    // zero-value `T()` optional default. The written `default(T)` must denote the
    // parameter's own type. Primitive value types (numeric / bool / char) are
    // recorded as their typed zero — identical to `= 0` — so a CLR Constant row is
    // emitted; arbitrary value types (e.g. TimeSpan, user structs) and Nullable<T>
    // record <see langword="null"/>, which the call site materializes as the
    // all-zero value via a BoundDefaultExpression and the metadata encodes as a
    // nullref Constant (matching C# `T x = default`).
    private static bool TryExtractValueTypeDefaultConstant(BoundDefaultExpression def, TypeSymbol parameterType, out object value, out string reason)
    {
        value = null;
        reason = null;

        var paramUnderlying = parameterType is NullableTypeSymbol pn ? pn.UnderlyingType : parameterType;
        var defUnderlying = def.Type is NullableTypeSymbol dn ? dn.UnderlyingType : def.Type;

        // The written `default(T)` / `T()` must denote the parameter's own type;
        // no implicit conversion of a value-type default is supported.
        if (!DefaultTypeMatchesParameter(defUnderlying, paramUnderlying))
        {
            reason = $"the default value 'default({def.Type?.Name})' does not match the parameter type '{parameterType.Name}'.";
            return false;
        }

        // Nullable<T> or reference-type parameter: the default is the missing value
        // (nil), already representable as a nullref Constant and materialized as nil.
        if (parameterType is NullableTypeSymbol || !IsValueTypeForDefault(paramUnderlying))
        {
            value = null;
            return true;
        }

        // Primitive value types are CLR Constant-table representable as their typed
        // zero — emit the same constant as the `= 0` form.
        if (TryGetPrimitiveZero(paramUnderlying, out var primitiveZero))
        {
            value = primitiveZero;
            return true;
        }

        // Arbitrary value type (TimeSpan, user struct, enum, tuple): materialized at
        // the call site via BoundDefaultExpression; metadata Constant is nullref.
        value = null;
        return true;
    }

    // Issue #1182: the written `default(T)` / `T()` must denote the same type as the
    // parameter. Symbol identity covers the common case (including user value types
    // whose <see cref="TypeSymbol.ClrType"/> is null pre-emit); the CLR full-name and
    // name fallbacks cover imported types and re-resolved symbol instances.
    private static bool DefaultTypeMatchesParameter(TypeSymbol defType, TypeSymbol paramType)
    {
        if (defType == null || paramType == null)
        {
            return false;
        }

        if (ReferenceEquals(defType, paramType) || Equals(defType, paramType))
        {
            return true;
        }

        var defClr = defType.ClrType;
        var paramClr = paramType.ClrType;
        if (defClr != null && paramClr != null)
        {
            return string.Equals(defClr.FullName, paramClr.FullName, System.StringComparison.Ordinal);
        }

        return string.Equals(defType.Name, paramType.Name, System.StringComparison.Ordinal);
    }

    // Issue #1182: recognises value-type parameter symbols whose all-zero default is a
    // valid optional default — including user `data struct` / enum / tuple symbols that
    // carry no CLR backing type before emit.
    private static bool IsValueTypeForDefault(TypeSymbol type)
    {
        if (type is StructSymbol s && !s.IsClass)
        {
            return true;
        }

        if (type is EnumSymbol || type is TupleTypeSymbol)
        {
            return true;
        }

        return type?.ClrType is { IsValueType: true };
    }

    // Issue #1182: returns the typed CLR zero for a primitive value-type symbol so a
    // `default(T)` optional default emits the same CLR Constant row as `= 0`.
    private static bool TryGetPrimitiveZero(TypeSymbol type, out object zero)
    {
        zero = null;

        if (type == TypeSymbol.Bool)
        {
            zero = false;
        }
        else if (type == TypeSymbol.Int8)
        {
            zero = (sbyte)0;
        }
        else if (type == TypeSymbol.UInt8)
        {
            zero = (byte)0;
        }
        else if (type == TypeSymbol.Int16)
        {
            zero = (short)0;
        }
        else if (type == TypeSymbol.UInt16)
        {
            zero = (ushort)0;
        }
        else if (type == TypeSymbol.Int32)
        {
            zero = 0;
        }
        else if (type == TypeSymbol.UInt32)
        {
            zero = 0u;
        }
        else if (type == TypeSymbol.Int64)
        {
            zero = 0L;
        }
        else if (type == TypeSymbol.UInt64)
        {
            zero = 0UL;
        }
        else if (type == TypeSymbol.Float32)
        {
            zero = 0f;
        }
        else if (type == TypeSymbol.Float64)
        {
            zero = 0d;
        }
        else if (type == TypeSymbol.Char)
        {
            zero = '\0';
        }

        return zero != null;
    }

    /// <summary>
    /// Issue #1256: lowers a non-identity implicit tuple-to-tuple conversion
    /// into a tuple literal of per-element converted accesses, rebuilding the
    /// target <see cref="System.ValueTuple"/> so the emitted IL is verifiable.
    /// </summary>
    /// <param name="diagnosticLocation">The diagnostic location.</param>
    /// <param name="expression">The source tuple expression.</param>
    /// <param name="sourceTuple">The source tuple type.</param>
    /// <param name="targetTuple">The target tuple type.</param>
    /// <param name="allowExplicit">Whether explicit element conversions are allowed.</param>
    /// <returns>The lowered expression building the target tuple.</returns>
    private BoundExpression BindTupleConversion(
        TextLocation diagnosticLocation,
        BoundExpression expression,
        TupleTypeSymbol sourceTuple,
        TupleTypeSymbol targetTuple,
        bool allowExplicit)
    {
        var arity = sourceTuple.Arity;

        // Fast path: the source is already a tuple literal, so its element
        // expressions are directly available — re-convert each to the target
        // element type without introducing a temp or element accesses.
        if (expression is BoundTupleLiteralExpression literalSource
            && literalSource.Elements.Length == arity)
        {
            var convertedLiteralElements = ImmutableArray.CreateBuilder<BoundExpression>(arity);
            for (var i = 0; i < arity; i++)
            {
                convertedLiteralElements.Add(
                    BindConversion(diagnosticLocation, literalSource.Elements[i], targetTuple.ElementTypes[i], allowExplicit));
            }

            return new BoundTupleLiteralExpression(expression.Syntax, targetTuple, convertedLiteralElements.ToImmutable());
        }

        // General path: evaluate the source once into a temp local, then build
        // a tuple literal of converted `ItemN` accesses off that local.
        var temp = new LocalVariableSymbol("<>tupleConv", isReadOnly: true, type: sourceTuple);
        var declaration = new BoundVariableDeclaration(expression.Syntax, temp, expression);

        var convertedElements = ImmutableArray.CreateBuilder<BoundExpression>(arity);
        for (var i = 0; i < arity; i++)
        {
            var elementAccess = new BoundTupleElementAccessExpression(
                expression.Syntax,
                new BoundVariableExpression(expression.Syntax, temp),
                sourceTuple,
                i);
            convertedElements.Add(
                BindConversion(diagnosticLocation, elementAccess, targetTuple.ElementTypes[i], allowExplicit));
        }

        var rebuilt = new BoundTupleLiteralExpression(expression.Syntax, targetTuple, convertedElements.ToImmutable());
        return new BoundBlockExpression(
            expression.Syntax,
            ImmutableArray.Create<BoundStatement>(declaration),
            rebuilt);
    }
}
