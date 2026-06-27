// <copyright file="OverloadResolution.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Shared C#-style "better function member" overload resolution used by the
/// binder for CLR constructor calls, static method calls on imported classes,
/// and instance method calls on imported CLR receivers. The resolver is a pure
/// function: it consumes a candidate list of <see cref="MethodBase"/> values
/// and the CLR types of the bound arguments, and returns a single best match,
/// an ambiguity, or "no applicable candidate".
/// </summary>
/// <remarks>
/// Implements a deliberately scoped subset of the C# §7.5.3 algorithm. User-
/// defined implicit conversions (Stream E) are wired in through the
/// <see cref="UserDefinedImplicitConversionLookup"/> callback so this file can
/// land before the conversion work.
/// </remarks>
internal static class OverloadResolution
{
    private static readonly Dictionary<string, string[]> NumericWideningTargets = new(StringComparer.Ordinal)
    {
        ["System.SByte"] = new[] { "System.Int16", "System.Int32", "System.Int64", "System.Single", "System.Double", "System.Decimal" },
        ["System.Byte"] = new[] { "System.Int16", "System.UInt16", "System.Int32", "System.UInt32", "System.Int64", "System.UInt64", "System.Single", "System.Double", "System.Decimal" },
        ["System.Int16"] = new[] { "System.Int32", "System.Int64", "System.Single", "System.Double", "System.Decimal" },
        ["System.UInt16"] = new[] { "System.Int32", "System.UInt32", "System.Int64", "System.UInt64", "System.Single", "System.Double", "System.Decimal" },
        ["System.Int32"] = new[] { "System.Int64", "System.Single", "System.Double", "System.Decimal" },
        ["System.UInt32"] = new[] { "System.Int64", "System.UInt64", "System.Single", "System.Double", "System.Decimal" },
        ["System.Int64"] = new[] { "System.Single", "System.Double", "System.Decimal" },
        ["System.UInt64"] = new[] { "System.Single", "System.Double", "System.Decimal" },
        ["System.Char"] = new[] { "System.UInt16", "System.Int32", "System.UInt32", "System.Int64", "System.UInt64", "System.Single", "System.Double", "System.Decimal" },
        ["System.Single"] = new[] { "System.Double" },
    };

    // C# §7.5.3.4 "Better conversion target" — signed integral T1 beats unsigned
    // integral T2 in this map. Used only as a secondary signed/unsigned tie-break
    // when the implicit-conversion direction between T1 and T2 does not resolve
    // the ordering (e.g. int vs. uint: neither implicitly converts to the other).
    private static readonly Dictionary<string, HashSet<string>> SignedBeatsUnsigned = new(StringComparer.Ordinal)
    {
        ["System.SByte"] = new(StringComparer.Ordinal) { "System.Byte", "System.UInt16", "System.UInt32", "System.UInt64" },
        ["System.Int16"] = new(StringComparer.Ordinal) { "System.UInt16", "System.UInt32", "System.UInt64" },
        ["System.Int32"] = new(StringComparer.Ordinal) { "System.UInt32", "System.UInt64" },
        ["System.Int64"] = new(StringComparer.Ordinal) { "System.UInt64" },
    };

    /// <summary>
    /// Classification of an implicit conversion from one CLR type to another.
    /// Lower ordinal values are "better" conversions and win in tie-breaking.
    /// </summary>
    public enum ImplicitConversionKind
    {
        /// <summary>No implicit conversion exists.</summary>
        None = 0,

        /// <summary>Same type by FullName (cross-context safe).</summary>
        Identity = 1,

        /// <summary>Standard numeric widening, e.g. <c>int</c> to <c>long</c>.</summary>
        NumericWidening = 2,

        /// <summary>Reference upcast, including interface satisfaction.</summary>
        Reference = 3,

        /// <summary>Value-type to <see cref="object"/> boxing.</summary>
        Boxing = 4,

        /// <summary>Wrapping <c>T</c> into <c>Nullable&lt;T&gt;</c>.</summary>
        NullableWrap = 5,

        /// <summary>User-defined <c>op_Implicit</c> (Stream E).</summary>
        UserDefinedImplicit = 6,

        /// <summary>
        /// Issue #368: an interpolated string (statically typed <c>string</c>)
        /// converting to a parameter typed as a
        /// <c>[InterpolatedStringHandler]</c> type. Ranked lowest so that, when
        /// both a <c>string</c> and a handler overload are applicable, the
        /// <c>string</c> overload still wins (matching the conservative G#
        /// model where only an actual interpolated-string node is later
        /// rewritten to the handler pattern by the binder).
        /// </summary>
        InterpolatedStringHandler = 7,

        /// <summary>
        /// ADR-0055 Tier 4 (#369): an interpolated-string argument converting to
        /// an <c>IFormattable</c>/<c>FormattableString</c> parameter. Ranked last
        /// (worst) so that, given both a <c>string</c> and a
        /// <c>FormattableString</c> overload, the <c>string</c> overload (an
        /// identity conversion of the interpolation's natural type) still wins —
        /// matching C#.
        /// </summary>
        InterpolatedStringToFormattable = 8,

        /// <summary>
        /// Issue #889: a value-returning <c>func</c>/arrow literal (whose
        /// natural CLR type is a <c>Func&lt;...&gt;</c>) converting to a
        /// void-returning delegate parameter (<c>System.Action</c> /
        /// <c>Action&lt;...&gt;</c> or a named void delegate) by discarding the
        /// trailing value. Ranked last (worst) so that, when both a matching
        /// <c>Func&lt;...&gt;</c> overload and an <c>Action</c> overload are
        /// applicable, the value-preserving <c>Func</c> overload still wins —
        /// matching C#'s preference. Only the binder's void-izing rebind
        /// materializes this conversion.
        /// </summary>
        LambdaToVoidDelegate = 9,

        /// <summary>
        /// Issue #908: a delegate value whose return type is a derived /
        /// implementing reference type converting to a delegate parameter with
        /// the same parameter signature but a base / interface return type
        /// (e.g. <c>Func&lt;MemoryStream&gt;</c> → <c>Func&lt;Stream&gt;</c>, or
        /// <c>() -&gt; NullLoggerFactory</c> → <c>Func&lt;ILoggerFactory&gt;</c>).
        /// This mirrors C#/CLR reference-preserving delegate return-type
        /// covariance. Ranked last (worst) so an exact (identity) delegate match
        /// always wins when both are applicable. The binder's void-izing /
        /// erasing rebind (<c>RebindFunctionLiteralDelegateArguments</c>)
        /// materializes the return conversion for a <c>func</c>/arrow literal
        /// argument so the produced delegate is created over a method whose
        /// return type already matches the target.
        /// </summary>
        DelegateReturnCovariance = 10,

        /// <summary>
        /// Issue #932: a <c>func</c>/arrow literal (whose natural CLR type is a
        /// <c>System.Func&lt;...&gt;</c> / <c>System.Action&lt;...&gt;</c>)
        /// converting to a structurally identical but differently-named
        /// delegate parameter — same parameter types and same return type, but
        /// a distinct delegate definition (e.g. a
        /// <c>func(T) bool</c> literal targeting <c>System.Predicate&lt;T&gt;</c>,
        /// as in <c>Assert.DoesNotContain(items, func(i Item) bool { ... })</c>).
        /// C# allows a lambda to target any compatible delegate type; G#'s
        /// natural delegate type for a literal is always <c>Func</c>/<c>Action</c>,
        /// so without this the literal would never match parameters typed as
        /// <c>Predicate&lt;T&gt;</c>, <c>Comparison&lt;T&gt;</c>, etc. Ranked
        /// last (worst) so an exact (identity) delegate match always wins when
        /// both are applicable. The binder's erasing rebind
        /// (<c>RebindFunctionLiteralDelegateArguments</c>) and the emitter's
        /// delegate-to-delegate adaptation materialize the conversion to the
        /// chosen delegate type.
        /// </summary>
        DelegateStructuralMatch = 11,

        /// <summary>
        /// Issue #1150: a delegate value (typically a <c>func</c>/arrow literal
        /// whose natural CLR type is a <c>System.Func&lt;...&gt;</c>) whose
        /// parameter signature is identical to the target delegate's but whose
        /// numeric return type implicitly, losslessly widens to the target's
        /// return type per the standard C# integer-widening lattice
        /// (e.g. <c>Func&lt;Item,uint32&gt;</c> → <c>Func&lt;Item,int64&gt;</c>,
        /// selecting <c>Enumerable.Sum(Func&lt;T,long&gt;)</c> for a
        /// <c>uint32</c> selector). Mirrors C#'s implicit numeric conversion of
        /// a lambda body to an expected delegate return type. Ranked last
        /// (worst) so an exact (identity) or reference-covariant delegate match
        /// always wins when both are applicable; when several numeric-widening
        /// targets are applicable, <see cref="CompareConversions"/> breaks the
        /// tie by "better conversion target" on the delegate return types so the
        /// closest integral target (e.g. <c>long</c> over <c>double</c>) wins.
        /// The binder's erasing rebind
        /// (<c>RebindFunctionLiteralDelegateArguments</c>) materializes the
        /// numeric return conversion for a literal argument so the produced
        /// delegate is created over a method whose return type already matches
        /// the target.
        /// </summary>
        DelegateReturnNumericWidening = 12,

        /// <summary>
        /// Issue #1311: a constant integer argument (an integer literal, or a
        /// unary +/- over one) whose value lies within the parameter's
        /// (possibly narrower or cross-sign) integer type range converts
        /// implicitly with no cast — C# §10.2.11 implicit constant expression
        /// conversion. This mirrors the user-method overload path
        /// (<c>OverloadResolver.IsApplicableUserCallable</c> via
        /// <c>ExpressionBinder.IsImplicitConstantNarrowingArgument</c>) for
        /// imported/BCL candidates so e.g. <c>stream.WriteByte(0)</c> binds to
        /// <c>Stream.WriteByte(byte)</c>. The binder's
        /// <c>BindClrParameterConversions</c> pass then re-materialises the
        /// correctly-typed (narrower) literal before emit. Ranked last (worst)
        /// so an exact identity or widening match always wins when applicable.
        /// </summary>
        ConstantNarrowing = 13,
    }

    /// <summary>
    /// Outcome of an overload-resolution attempt.
    /// </summary>
    public enum ResolutionOutcome
    {
        /// <summary>No candidate is applicable to the supplied arguments.</summary>
        NoneApplicable,

        /// <summary>A unique best candidate was selected.</summary>
        Resolved,

        /// <summary>Two or more applicable candidates tie on "better-ness".</summary>
        Ambiguous,
    }

    /// <summary>
    /// Gets or sets the optional hook invoked when no built-in implicit
    /// conversion exists. Returns <see langword="true"/> when the caller has
    /// a user-defined <c>op_Implicit</c> method that converts the source type
    /// to the target type. Stream E supplies the implementation; until then
    /// this stays <see langword="null"/> and the classifier returns
    /// <see cref="ImplicitConversionKind.None"/>.
    /// </summary>
    public static Func<Type, Type, bool> UserDefinedImplicitConversionLookup { get; set; }

    /// <summary>
    /// ADR-0060 / issue #977: sentinel argument type representing an inline
    /// <c>out var</c>/<c>out let</c>/<c>out _</c> declaration whose local type is
    /// not yet known. Such an argument is applicable to — and only to — a by-ref
    /// (<c>ref</c>/<c>out</c>/<c>in</c>) parameter; its declared local type is
    /// inferred from the chosen overload's parameter after resolution succeeds.
    /// Using a dedicated marker keeps the out-var neutral during betterness
    /// ranking (it always classifies as an identity conversion against a by-ref
    /// parameter) while still rejecting non-by-ref candidates.
    /// </summary>
#pragma warning disable SA1201 // Elements should appear in the correct order
    public static readonly Type InlineOutVarArgumentType = typeof(InlineOutVarArgumentMarker);
#pragma warning restore SA1201

    /// <summary>
    /// Issue #658: per-call supplementary interface check for user-defined G#
    /// classes whose CLR type does not exist at bind time. When set (non-null),
    /// <see cref="ClassifyImplicit"/> invokes this callback as a final
    /// reference-conversion check before falling through to
    /// <see cref="UserDefinedImplicitConversionLookup"/>. The binder sets this
    /// before calling <see cref="Resolve{T}"/> for calls that include user-
    /// class arguments and clears it immediately after.
    /// </summary>
    [ThreadStatic]
#pragma warning disable SA1401 // Field should be private
#pragma warning disable SA1201 // Elements should appear in the correct order
    internal static Func<Type, Type, bool> SupplementaryInterfaceCheck;
#pragma warning restore SA1201
#pragma warning restore SA1401

    /// <summary>
    /// Issue #1311: per-call constant-narrowing applicability hook for imported/
    /// BCL candidates. When set (non-null), <see cref="EvaluateCandidate{T}"/>
    /// invokes it for an argument whose natural type has no implicit conversion
    /// to the parameter type. The callback receives the source argument index
    /// and the CLR parameter type and returns <see langword="true"/> when the
    /// argument is a constant integer expression whose value fits that
    /// (possibly narrower / cross-sign) integer parameter — i.e. C# §10.2.11
    /// implicit constant expression conversion. The binder sets this from the
    /// bound arguments before calling <see cref="Resolve{T}"/> and clears it
    /// immediately after. Modelled on <see cref="SupplementaryInterfaceCheck"/>.
    /// </summary>
    [ThreadStatic]
#pragma warning disable SA1401 // Field should be private
#pragma warning disable SA1201 // Elements should appear in the correct order
    internal static Func<int, Type, bool> ConstantNarrowingArgumentCheck;
#pragma warning restore SA1201
#pragma warning restore SA1401

    /// <summary>
    /// Classifies the implicit conversion from <paramref name="source"/> to
    /// <paramref name="target"/>. Designed to work across reflection contexts
    /// (MetadataLoadContext vs. live runtime) by falling back to FullName
    /// equality.
    /// </summary>
    /// <param name="target">The target parameter type.</param>
    /// <param name="source">The argument type.</param>
    /// <returns>The conversion classification.</returns>
    public static ImplicitConversionKind ClassifyImplicit(Type target, Type source)
    {
        if (target is null)
        {
            return ImplicitConversionKind.None;
        }

        // Issue #977: an inline `out var`/`out let`/`out _` argument has no known
        // type until an overload is chosen; it matches exactly the by-ref
        // parameters (out/ref/in) and nothing else.
        if (ReferenceEquals(source, InlineOutVarArgumentType))
        {
            return target.IsByRef ? ImplicitConversionKind.Identity : ImplicitConversionKind.None;
        }

        // Issue #533: a null source represents the `nil` literal in G#.
        // `nil` is implicitly assignable to any reference type and to
        // `Nullable<T>` (value-type nullable), mirroring C#'s null literal
        // compatibility rules.
        if (source is null)
        {
            // Peel by-ref for the target (ref/out/in parameter).
            var t = target.IsByRef ? target.GetElementType()! : target;

            // Nullable<T> (value-type nullable)
            if (NullableLifting.IsValueTypeNullableClr(t))
            {
                return ImplicitConversionKind.NullableWrap;
            }

            // Any reference type (class, interface, array, delegate, string)
            if (!t.IsValueType)
            {
                return ImplicitConversionKind.Reference;
            }

            return ImplicitConversionKind.None;
        }

        // ADR-0039: peel by-ref from target (ref/out/in parameter) for matching.
        // If the user passes &x (source is T&), peel both sides.
        // If the user passes x (source is T), peel only the target.
        if (target.IsByRef)
        {
            target = target.GetElementType()!;
        }

        if (source.IsByRef)
        {
            source = source.GetElementType()!;
        }

        if (ClrTypeUtilities.AreSame(target, source))
        {
            return ImplicitConversionKind.Identity;
        }

        if (IsNumericWidening(source, target))
        {
            return ImplicitConversionKind.NumericWidening;
        }

        if (string.Equals(target.FullName, "System.Object", StringComparison.Ordinal))
        {
            return source.IsValueType ? ImplicitConversionKind.Boxing : ImplicitConversionKind.Reference;
        }

        if (IsNullableWrap(source, target))
        {
            return ImplicitConversionKind.NullableWrap;
        }

        // Issue #322: any delegate type (Func<...>/Action<...> or a named
        // delegate) is implicitly convertible to System.Delegate /
        // System.MulticastDelegate, mirroring C#'s natural-delegate-type
        // conversion. This must work across reflection contexts: a lambda
        // literal in argument position carries a *live runtime* Func<> type,
        // while the target Delegate parameter (e.g. ASP.NET Core MapGet) is
        // loaded through a MetadataLoadContext, so the comparison is by name.
        if ((string.Equals(target.FullName, "System.Delegate", StringComparison.Ordinal)
                || string.Equals(target.FullName, "System.MulticastDelegate", StringComparison.Ordinal))
            && ClrTypeUtilities.IsDelegateType(source))
        {
            return ImplicitConversionKind.Reference;
        }

        // Issue #908: delegate return-type covariance. A delegate value whose
        // return type is a derived / implementing reference type is applicable
        // to a delegate parameter with the same parameter signature but a
        // base / interface return type (e.g. Func<MemoryStream> → Func<Stream>,
        // () -> NullLoggerFactory → Func<ILoggerFactory>), mirroring C#/CLR
        // reference-preserving delegate covariance. Checked here — before the
        // assignability / base-type-walk blocks below — because a func/arrow
        // literal's natural delegate type is a host-runtime Func<> closed over
        // MetadataLoadContext type arguments, on which those reflection probes
        // throw. Ranked last so an exact (identity) delegate match always wins.
        if (IsDelegateReturnCovariant(target, source))
        {
            return ImplicitConversionKind.DelegateReturnCovariance;
        }

        // Issue #1150: delegate return-type numeric widening. A delegate value
        // whose parameter signature matches the target's but whose numeric
        // return type implicitly, losslessly widens to the target's return type
        // (e.g. Func<Item,uint32> → Func<Item,int64>) is applicable, mirroring
        // C#'s implicit numeric conversion of a lambda body to an expected
        // delegate return type. Checked here — alongside the reference
        // covariance case — before the assignability / base-type-walk blocks
        // below. Ranked last so an exact (identity) delegate match always wins.
        if (IsDelegateReturnNumericWidening(target, source))
        {
            return ImplicitConversionKind.DelegateReturnNumericWidening;
        }

        if (ReferenceEquals(target.Assembly, source.Assembly) || target.GetType() == source.GetType())
        {
            try
            {
                if (target.IsAssignableFrom(source))
                {
                    // Issue #570: G# slices are invariant. When the source
                    // is an array type being passed to a generic interface,
                    // CLR's IsAssignableFrom accepts covariant cases (e.g.
                    // string[] → IEnumerable<object>). Guard against this
                    // by cross-checking with ImplementsInterfaceByName which
                    // matches generic args by name (invariantly).
                    if (source.IsArray && target.IsInterface && target.IsGenericType
                        && !ClrTypeUtilities.ImplementsInterfaceByName(source, target))
                    {
                        // Covariant match rejected — fall through.
                    }
                    else
                    {
                        return ImplicitConversionKind.Reference;
                    }
                }
            }
            catch (InvalidOperationException)
            {
                // MLC cross-context paths throw; fall through to user-defined lookup.
            }
        }

        // Issue #570/#610: cross-context reference upcast fallback. When the
        // same-context fast path above cannot fire (live-runtime ↔ MLC boundary),
        // walk the source's interface set and base-type chain by name.
        if (target.IsInterface && ClrTypeUtilities.ImplementsInterfaceByName(source, target))
        {
            return ImplicitConversionKind.Reference;
        }

        // Cross-context base-class walk (#610): covers inheritance across
        // reflection contexts (e.g. an MLC-loaded subclass passed to a
        // parameter typed as its live-runtime base class or vice versa).
        if (!source.IsValueType && !target.IsValueType && !target.IsInterface)
        {
            for (var baseType = source.BaseType; baseType != null; baseType = baseType.BaseType)
            {
                if (ClrTypeUtilities.AreSame(baseType, target))
                {
                    return ImplicitConversionKind.Reference;
                }
            }
        }

        // Issue #658: supplementary interface check for user-defined G# classes.
        // When the binder is resolving a call that includes a user-class argument
        // whose CLR type is a surrogate (e.g. System.Object), the built-in checks
        // above won't recognise that the user class implements the target interface.
        // This callback lets the binder inject that knowledge.
        var sic = SupplementaryInterfaceCheck;
        if (sic != null && target.IsInterface && sic(source, target))
        {
            return ImplicitConversionKind.Reference;
        }

        var udi = UserDefinedImplicitConversionLookup;
        if (udi != null && udi(source, target))
        {
            return ImplicitConversionKind.UserDefinedImplicit;
        }

        // Issue #368: a `string`-typed argument (which is how an interpolated
        // string statically types) is applicable to a parameter whose type is
        // attributed `[InterpolatedStringHandler]`. The binder only ever
        // rewrites an actual BoundInterpolatedStringExpression argument into the
        // handler pattern, so this conversion is harmless for plain strings in
        // practice and is ranked lowest (so a `string` overload always wins).
        if (string.Equals(source.FullName, "System.String", StringComparison.Ordinal)
            && InterpolatedStringHandlerInfo.IsHandlerType(target))
        {
            return ImplicitConversionKind.InterpolatedStringHandler;
        }

        // Issue #889: a value-returning func/arrow literal (whose natural CLR
        // type is a Func<...>) is applicable to a void-returning delegate
        // parameter (System.Action / Action<...> / a named void delegate) by
        // discarding the trailing value. Ranked lowest so a value-preserving
        // Func<...> overload always wins when both are applicable. The binder's
        // void-izing rebind (RebindFunctionLiteralDelegateArguments) materializes
        // the actual discard for the selected literal argument.
        if (IsValueReturningDelegateToVoidDelegate(target, source))
        {
            return ImplicitConversionKind.LambdaToVoidDelegate;
        }

        // Issue #932: a func/arrow literal whose natural delegate type is a
        // Func<...>/Action<...> is applicable to a structurally identical but
        // differently-named delegate parameter (same parameter types and same
        // return type), e.g. `func(i Item) bool { ... }` → System.Predicate<Item>
        // for `Assert.DoesNotContain(items, predicate)`. Ranked lowest so an
        // exact (identity) delegate match always wins when both apply. Checked
        // last because the covariance / void-discard cases above already cover
        // the differing-return-type shapes; this only handles the exact-shape
        // delegate-kind mismatch.
        if (IsStructurallyCompatibleDelegate(target, source))
        {
            return ImplicitConversionKind.DelegateStructuralMatch;
        }

        return ImplicitConversionKind.None;
    }

    /// <summary>
    /// ADR-0055 Tier 4 (#369): determines whether <paramref name="parameterType"/>
    /// is one of the contextual targets to which an interpolated string converts —
    /// <c>System.IFormattable</c> or <c>System.FormattableString</c>. Compared by
    /// <see cref="Type.FullName"/> so it is robust across reflection contexts
    /// (MetadataLoadContext vs. live runtime). By-ref parameters are peeled first.
    /// </summary>
    /// <param name="parameterType">The candidate parameter type.</param>
    /// <returns><see langword="true"/> when the parameter is a Tier-4 target.</returns>
    public static bool IsFormattableStringTarget(Type parameterType)
    {
        if (parameterType is null)
        {
            return false;
        }

        if (parameterType.IsByRef)
        {
            parameterType = parameterType.GetElementType();
        }

        var fullName = parameterType?.FullName;
        return string.Equals(fullName, "System.FormattableString", StringComparison.Ordinal)
            || string.Equals(fullName, "System.IFormattable", StringComparison.Ordinal);
    }

    /// <summary>
    /// Resolves a method-overload set against the supplied argument types and
    /// returns the unique best applicable candidate, or an ambiguity / no-
    /// match result.
    /// </summary>
    /// <typeparam name="T">Candidate kind (<see cref="MethodInfo"/> or <see cref="ConstructorInfo"/>).</typeparam>
    /// <param name="candidates">All candidate methods/ctors to consider.</param>
    /// <param name="argTypes">CLR types of the bound arguments in source order.</param>
    /// <param name="explicitTypeArgs">
    /// Issue #311: when non-<see langword="null"/>, the call site supplied an
    /// explicit type-argument list (e.g. <c>Array.Empty[string]()</c>). Only
    /// open generic method definitions whose arity matches are considered, and
    /// they are closed with these exact type arguments instead of inference.
    /// Non-generic and mismatched-arity candidates are dropped (matches C#'s
    /// rule that explicit type arguments require a matching generic method).
    /// </param>
    /// <param name="projectTypeArgument">
    /// Issue #321: projects an inferred type argument (a live host-runtime
    /// <see cref="Type"/> taken from a bound argument) onto the reference load
    /// context that loaded the candidate methods, so
    /// <see cref="MethodInfo.MakeGenericMethod"/> accepts it. Without this
    /// projection, closing a generic method such as
    /// <c>JsonSerializer.Serialize&lt;TValue&gt;</c> with an inferred
    /// <c>System.String</c> throws "was not loaded by the MetadataLoadContext".
    /// When <see langword="null"/> the inferred arguments are used as-is.
    /// Explicit type arguments are assumed to be pre-projected by the caller.
    /// </param>
    /// <param name="interpolatedStringArgs">
    /// ADR-0055 Tier 4 (#369): optional per-argument flags marking which
    /// arguments are interpolated-string expressions. A flagged argument may, in
    /// addition to its natural <c>string</c> type, convert to an
    /// <c>IFormattable</c>/<c>FormattableString</c> parameter. <see langword="null"/>
    /// (the default) disables the relaxation, preserving prior behaviour for all
    /// other call sites.
    /// </param>
    /// <param name="argumentNames">
    /// Issue #343: optional per-argument names supplied at the call site. Entries
    /// are <see langword="null"/> for positional arguments and the parameter name
    /// for named arguments (e.g. <c>F(1, x: 2)</c> → <c>[null, "x"]</c>). Named
    /// arguments must follow all positional arguments in source order; the binder
    /// pre-validates this layout. When non-<see langword="null"/>, each candidate's
    /// applicability check additionally requires that every named argument maps to
    /// a distinct parameter on that candidate, no positional slot is overwritten
    /// by a named slot, and every unfilled non-trailing slot is optional. The
    /// returned <see cref="Result{T}.ParameterMapping"/> records, for each source
    /// argument index, the resolved parameter position so the binder can reorder
    /// the bound arguments into parameter order before emit.
    /// </param>
    /// <returns>The resolution result.</returns>
    public static Result<T> Resolve<T>(IEnumerable<T> candidates, IReadOnlyList<Type> argTypes, IReadOnlyList<Type> explicitTypeArgs = null, Func<Type, Type> projectTypeArgument = null, IReadOnlyList<bool> interpolatedStringArgs = null, IReadOnlyList<string> argumentNames = null)
        where T : MethodBase
    {
        var applicable = new List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)>();

        // Materialize the candidate set so we can run both the normal-form pass
        // and (if necessary) a second params-expansion pass without re-querying
        // the underlying enumerable.
        var candidateList = candidates as IReadOnlyCollection<T> ?? candidates.ToList();

        foreach (var rawCandidate in candidateList)
        {
            // Issue #321: an overload's signature may reference types that cannot
            // be loaded or projected under the MetadataLoadContext used for
            // reference assemblies (e.g. the ref-struct Utf8JsonWriter, or types
            // living in transitive assemblies that were not supplied via /r:).
            // Reflecting over such a parameter (GetParameters / ParameterType)
            // throws a load exception. A single unloadable overload must not sink
            // the entire candidate set, otherwise an otherwise-resolvable method
            // such as JsonSerializer.Serialize(string) appears "not found". Treat
            // these candidates as simply not applicable and keep evaluating the
            // rest.
            try
            {
                EvaluateCandidate(rawCandidate, argTypes, explicitTypeArgs, projectTypeArgument, applicable, interpolatedStringArgs, argumentNames);
            }
            catch (Exception ex) when (IsMetadataLoadFailure(ex))
            {
                continue;
            }
        }

        // Issue #506: when no candidate applies in its normal (non-expanded)
        // form, attempt C#-style `params T[]` expansion. The expanded form is
        // only ever considered as a fallback so that a normal-form candidate
        // always beats an expanded-form one (C# §7.5.3.2 better-function-member
        // rule).
        if (applicable.Count == 0)
        {
            foreach (var rawCandidate in candidateList)
            {
                try
                {
                    EvaluateExpandedParamsCandidate(rawCandidate, argTypes, explicitTypeArgs, projectTypeArgument, applicable, argumentNames);
                }
                catch (Exception ex) when (IsMetadataLoadFailure(ex))
                {
                    continue;
                }
            }
        }

        if (applicable.Count == 0)
        {
            return Result<T>.NoneApplicable();
        }

        if (applicable.Count == 1)
        {
            var only = applicable[0];
            return Result<T>.Single(only.Method, BuildMappingArray(only.Mapping, argumentNames), only.IsExpanded);
        }

        return RankApplicable(applicable, argTypes, argumentNames);
    }

    /// <summary>
    /// Issue #506: returns <see langword="true"/> when <paramref name="parameter"/>
    /// is the trailing <c>params T[]</c> parameter — i.e. carries the
    /// <see cref="ParamArrayAttribute"/> marker and is a single-dimensional
    /// array. Detected via <see cref="CustomAttributeData"/> so the check works
    /// even when the candidate is reflected through a MetadataLoadContext.
    /// </summary>
    /// <param name="parameter">The parameter to inspect.</param>
    /// <returns>Whether the parameter is a <c>params</c> array.</returns>
    public static bool IsParamsArrayParameter(ParameterInfo parameter)
    {
        if (parameter == null)
        {
            return false;
        }

        var paramType = parameter.ParameterType;
        if (paramType == null || !paramType.IsArray || paramType.GetArrayRank() != 1)
        {
            return false;
        }

        IList<CustomAttributeData> attrs;
        try
        {
            attrs = parameter.GetCustomAttributesData();
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex))
        {
            return false;
        }

        if (attrs == null)
        {
            return false;
        }

        for (var i = 0; i < attrs.Count; i++)
        {
            var name = attrs[i]?.AttributeType?.FullName;
            if (string.Equals(name, "System.ParamArrayAttribute", StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #506: returns the position of the trailing <c>params T[]</c>
    /// parameter on <paramref name="method"/>, or -1 when there is none.
    /// </summary>
    /// <param name="method">The method to inspect.</param>
    /// <returns>The params parameter position, or -1.</returns>
    public static int GetParamsParameterIndex(MethodBase method)
    {
        if (method == null)
        {
            return -1;
        }

        ParameterInfo[] parameters;
        try
        {
            parameters = method.GetParameters();
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex))
        {
            return -1;
        }

        if (parameters.Length == 0)
        {
            return -1;
        }

        var lastIndex = parameters.Length - 1;
        return IsParamsArrayParameter(parameters[lastIndex]) ? lastIndex : -1;
    }

    /// <summary>
    /// Issue #320: determines whether a closed generic method's open definition
    /// returns exactly one of its own method type parameters (e.g.
    /// <c>T GetService&lt;T&gt;()</c>, <c>T GetRequiredService&lt;T&gt;()</c>,
    /// <c>T CreateInstance&lt;T&gt;()</c>). When it does, the caller can recover the
    /// real return type from the explicit type-argument symbol at the reported
    /// position, which is necessary when the method was closed with a placeholder
    /// CLR type because the type argument is a user-defined type with no
    /// reference-context CLR type.
    /// </summary>
    /// <param name="closed">The closed generic method.</param>
    /// <param name="position">The method type-parameter position of the return type, when matched.</param>
    /// <returns><see langword="true"/> when the return type is a bare method type parameter.</returns>
    public static bool TryGetGenericMethodParameterReturnPosition(MethodInfo closed, out int position)
    {
        position = -1;
        if (closed == null || !closed.IsGenericMethod)
        {
            return false;
        }

        var open = closed.IsGenericMethodDefinition ? closed : closed.GetGenericMethodDefinition();
        var ret = open.ReturnType;
        if (ret != null && ret.IsGenericParameter && ret.DeclaringMethod != null)
        {
            position = ret.GenericParameterPosition;
            return true;
        }

        return false;
    }

    /// <summary>
    /// Compares two candidate conversion targets for the same source type per
    /// C# §7.5.3.4 "Better conversion target". Returns a negative value when
    /// <paramref name="t1"/> is the better target, a positive value when
    /// <paramref name="t2"/> is better, or zero when neither dominates.
    /// </summary>
    /// <param name="t1">The first candidate target type.</param>
    /// <param name="t2">The second candidate target type.</param>
    /// <param name="source">The source argument type.</param>
    /// <returns>-1, 0, or +1 per the description above.</returns>
    public static int CompareNumericTargets(Type t1, Type t2, Type source)
    {
        if (t1 is null || t2 is null || source is null)
        {
            return 0;
        }

        if (ClrTypeUtilities.AreSame(t1, t2))
        {
            return 0;
        }

        // Identity always wins over widening — caller handles that via the
        // conversion-kind comparison; here we only break ties between two
        // widenings, so identity to either target is not in scope.
        var t1ToT2 = ClassifyImplicit(t2, t1) != ImplicitConversionKind.None;
        var t2ToT1 = ClassifyImplicit(t1, t2) != ImplicitConversionKind.None;

        // T1 is a better target than T2 if an implicit conversion T1→T2 exists
        // and none exists T2→T1 (T1 is the "smaller"/closer numeric type).
        if (t1ToT2 && !t2ToT1)
        {
            return -1;
        }

        if (t2ToT1 && !t1ToT2)
        {
            return 1;
        }

        // Signed integral T1 beats unsigned integral T2 (and vice versa) per
        // the signed-vs-unsigned subclause when neither dominates by the
        // conversion-direction rule above (e.g. int vs. uint).
        if (t1.FullName is { } t1Name && t2.FullName is { } t2Name)
        {
            if (SignedBeatsUnsigned.TryGetValue(t1Name, out var t1Beats) && t1Beats.Contains(t2Name))
            {
                return -1;
            }

            if (SignedBeatsUnsigned.TryGetValue(t2Name, out var t2Beats) && t2Beats.Contains(t1Name))
            {
                return 1;
            }
        }

        return 0;
    }

    /// <summary>
    /// Formats a CLR method/constructor signature into a short human-readable
    /// form suitable for a diagnostic: <c>Name[T1, T2](P1, P2, …)</c>. Used by
    /// the ambiguous-overload diagnostic (issue #505) to list the competing
    /// candidates so the caller can choose how to disambiguate (typically by
    /// supplying an explicit type-argument list).
    /// </summary>
    /// <param name="method">The CLR method or constructor.</param>
    /// <returns>The formatted signature.</returns>
    public static string FormatMethodSignature(MethodBase method)
    {
        if (method is null)
        {
            return "<null>";
        }

        var sb = new System.Text.StringBuilder();
        sb.Append(method.Name);

        if (method is MethodInfo mi && mi.IsGenericMethod)
        {
            sb.Append('[');
            var typeArgs = mi.GetGenericArguments();
            for (var i = 0; i < typeArgs.Length; i++)
            {
                if (i > 0)
                {
                    sb.Append(", ");
                }

                sb.Append(FormatTypeName(typeArgs[i]));
            }

            sb.Append(']');
        }

        sb.Append('(');
        var parameters = method.GetParameters();
        for (var i = 0; i < parameters.Length; i++)
        {
            if (i > 0)
            {
                sb.Append(", ");
            }

            sb.Append(FormatTypeName(parameters[i].ParameterType));
        }

        sb.Append(')');
        return sb.ToString();
    }

    /// <summary>
    /// Attempts to infer the type arguments of an open generic method
    /// definition from the supplied argument types. Implements a deliberately
    /// scoped subset of C# §7.5.2 "Type inference": only the input-type
    /// inference phase against argument CLR types, plus exact unification on
    /// recursive generic / array shapes. Lambdas and unbound delegate-typed
    /// arguments are not considered. Returns <see langword="true"/> with
    /// <paramref name="typeArgs"/> populated when every method type parameter
    /// receives a single consistent bound; <see langword="false"/> otherwise.
    /// </summary>
    /// <param name="openMethod">An open generic method definition (i.e. <see cref="MethodBase.IsGenericMethodDefinition"/> is <see langword="true"/>).</param>
    /// <param name="argTypes">CLR types of the supplied arguments.</param>
    /// <param name="typeArgs">On success, the inferred type arguments in declaration order.</param>
    /// <returns>Whether inference succeeded.</returns>
    public static bool TryInferTypeArguments(MethodInfo openMethod, IReadOnlyList<Type> argTypes, out Type[] typeArgs)
    {
        typeArgs = null;
        if (openMethod is null || !openMethod.IsGenericMethodDefinition)
        {
            return false;
        }

        var parameters = openMethod.GetParameters();

        // Issue #327/#321: allow the call to omit trailing optional parameters.
        // We infer type arguments from the supplied positional arguments only;
        // any omitted optional parameter must therefore not introduce a method
        // type parameter that is otherwise un-inferable (the loop below still
        // requires every type parameter to receive a bound).
        if (parameters.Length < argTypes.Count)
        {
            return false;
        }

        for (var i = argTypes.Count; i < parameters.Length; i++)
        {
            if (!parameters[i].IsOptional)
            {
                return false;
            }
        }

        var typeParams = openMethod.GetGenericArguments();
        var bounds = new Dictionary<string, Type>(StringComparer.Ordinal);
        for (var i = 0; i < argTypes.Count; i++)
        {
            var arg = argTypes[i];
            if (arg is null)
            {
                continue;
            }

            // Unify the parameter against the argument; soft-fail (skip this
            // arg) when shapes don't line up, hard-fail only on a true
            // bound-conflict for a method type parameter.
            if (!UnifyForInference(parameters[i].ParameterType, arg, bounds))
            {
                return false;
            }
        }

        var result = new Type[typeParams.Length];
        for (var i = 0; i < typeParams.Length; i++)
        {
            if (!bounds.TryGetValue(typeParams[i].Name, out var bound))
            {
                return false;
            }

            result[i] = bound;
        }

        typeArgs = result;
        return true;
    }

    /// <summary>
    /// Partial method type inference for deferred arrow-lambda arguments
    /// (follow-up to issue #891). When a generic method's lambda
    /// parameter return type is a method type parameter that can only be
    /// inferred from the lambda body (e.g.
    /// <c>Select&lt;TSource,TResult&gt;(this IEnumerable&lt;TSource&gt;, Func&lt;TSource,TResult&gt;)</c>),
    /// full inference via <see cref="TryInferTypeArguments"/> fails because
    /// <c>TResult</c> has no bound. This routine instead infers only the type
    /// parameters reachable from the supplied (non-lambda) argument types, then
    /// resolves each requested delegate parameter's <em>parameter</em> CLR types
    /// through those bounds. It succeeds for a slot only when every delegate
    /// parameter type is fully closed — the delegate's return type may remain an
    /// un-inferred method type parameter (it is later inferred from the lambda
    /// body, which now has typed parameters to bind against).
    /// </summary>
    /// <param name="method">The candidate method (open generic definition or a
    /// constructed generic method whose definition is used for inference).</param>
    /// <param name="argTypes">CLR types of the supplied arguments in parameter
    /// order; deferred lambda slots are passed as <see langword="null"/>.</param>
    /// <param name="lambdaParameterIndices">Parameter indices (aligned to
    /// <paramref name="argTypes"/>) that correspond to deferred lambdas.</param>
    /// <param name="expectedArities">The expected delegate arity (lambda
    /// parameter count) for each entry of <paramref name="lambdaParameterIndices"/>.</param>
    /// <param name="closedLambdaParameterTypes">On success, maps each requested
    /// parameter index to the closed CLR parameter types of its delegate.</param>
    /// <returns>Whether closed parameter types were determined for every
    /// requested lambda slot.</returns>
    public static bool TryInferDeferredLambdaParameterTypes(
        MethodInfo method,
        IReadOnlyList<Type> argTypes,
        IReadOnlyList<int> lambdaParameterIndices,
        IReadOnlyList<int> expectedArities,
        out Dictionary<int, Type[]> closedLambdaParameterTypes)
    {
        closedLambdaParameterTypes = null;
        if (method is null || argTypes is null || lambdaParameterIndices is null || expectedArities is null)
        {
            return false;
        }

        MethodInfo openMethod;
        ParameterInfo[] parameters;
        try
        {
            openMethod = method.IsGenericMethodDefinition
                ? method
                : (method.IsGenericMethod ? method.GetGenericMethodDefinition() : method);
            if (!openMethod.IsGenericMethodDefinition)
            {
                return false;
            }

            parameters = openMethod.GetParameters();
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex))
        {
            return false;
        }

        if (parameters.Length < argTypes.Count)
        {
            return false;
        }

        var bounds = new Dictionary<string, Type>(StringComparer.Ordinal);
        for (var i = 0; i < argTypes.Count; i++)
        {
            var arg = argTypes[i];
            if (arg is null)
            {
                continue;
            }

            try
            {
                if (!UnifyForInference(parameters[i].ParameterType, arg, bounds))
                {
                    return false;
                }
            }
            catch (Exception ex) when (IsMetadataLoadFailure(ex))
            {
                return false;
            }
        }

        var result = new Dictionary<int, Type[]>();
        for (var k = 0; k < lambdaParameterIndices.Count; k++)
        {
            var paramIndex = lambdaParameterIndices[k];
            if (paramIndex < 0 || paramIndex >= parameters.Length)
            {
                return false;
            }

            MethodInfo invoke;
            ParameterInfo[] invokeParams;
            try
            {
                var delegateType = parameters[paramIndex].ParameterType;
                if (delegateType is null)
                {
                    return false;
                }

                invoke = delegateType.GetMethod("Invoke");
                if (invoke is null)
                {
                    return false;
                }

                invokeParams = invoke.GetParameters();
            }
            catch (Exception ex) when (IsMetadataLoadFailure(ex))
            {
                return false;
            }

            if (invokeParams.Length != expectedArities[k])
            {
                return false;
            }

            var closedParams = new Type[invokeParams.Length];
            for (var p = 0; p < invokeParams.Length; p++)
            {
                if (!TryCloseInferredType(invokeParams[p].ParameterType, bounds, out closedParams[p]))
                {
                    return false;
                }
            }

            result[paramIndex] = closedParams;
        }

        closedLambdaParameterTypes = result;
        return true;
    }

    /// <summary>
    /// Substitutes inferred method-type-parameter <paramref name="bounds"/> into
    /// <paramref name="type"/>, succeeding only when the result is fully closed
    /// (contains no remaining generic parameters). Used by
    /// <see cref="TryInferDeferredLambdaParameterTypes"/> to close a delegate's
    /// parameter types while leaving an un-inferred return type unresolved.
    /// </summary>
    private static bool TryCloseInferredType(Type type, IReadOnlyDictionary<string, Type> bounds, out Type closed)
    {
        closed = null;
        if (type is null)
        {
            return false;
        }

        try
        {
            if (type.IsGenericParameter)
            {
                if (!bounds.TryGetValue(type.Name, out var bound)
                    || bound is null
                    || bound.IsGenericParameter
                    || bound.ContainsGenericParameters)
                {
                    return false;
                }

                closed = bound;
                return true;
            }

            if (!type.ContainsGenericParameters)
            {
                closed = type;
                return true;
            }

            if (type.IsByRef)
            {
                return TryCloseInferredType(type.GetElementType(), bounds, out closed);
            }

            if (type.IsArray)
            {
                if (!TryCloseInferredType(type.GetElementType(), bounds, out var elem))
                {
                    return false;
                }

                closed = elem.MakeArrayType();
                return true;
            }

            if (type.IsGenericType)
            {
                var def = type.GetGenericTypeDefinition();
                var args = type.GetGenericArguments();
                var closedArgs = new Type[args.Length];
                for (var i = 0; i < args.Length; i++)
                {
                    if (!TryCloseInferredType(args[i], bounds, out closedArgs[i]))
                    {
                        return false;
                    }
                }

                closed = def.MakeGenericType(closedArgs);
                return true;
            }
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex) || ex is ArgumentException || ex is InvalidOperationException)
        {
            return false;
        }

        return false;
    }

    /// <summary>
    /// Determines whether an exception thrown while reflecting over a candidate's
    /// signature is a metadata/assembly load failure (issue #321, generalized in
    /// issue #338). Delegates to the single shared predicate in
    /// <see cref="ClrTypeUtilities.IsMetadataLoadFailure(Exception)"/> so every
    /// CLR member enumeration site classifies load failures identically.
    /// </summary>
    /// <param name="ex">The exception observed while evaluating a candidate.</param>
    /// <returns>Whether the exception represents a tolerable load failure.</returns>
    private static bool IsMetadataLoadFailure(Exception ex) =>
        ClrTypeUtilities.IsMetadataLoadFailure(ex);

    /// <summary>
    /// Issue #889: determines whether <paramref name="source"/> is a delegate
    /// type that returns a value (e.g. <c>Func&lt;...&gt;</c>) whose parameter
    /// list matches a void-returning delegate <paramref name="target"/> (e.g.
    /// <c>System.Action</c> / <c>Action&lt;...&gt;</c>). Parameter and return
    /// types are compared by name to remain safe across reflection contexts
    /// (the target may be loaded through a <c>MetadataLoadContext</c> while the
    /// literal's natural <c>Func&lt;...&gt;</c> is a live-runtime type).
    /// </summary>
    /// <param name="target">The candidate void-returning delegate parameter type.</param>
    /// <param name="source">The argument's natural delegate type.</param>
    /// <returns><see langword="true"/> when the discard conversion applies.</returns>
    private static bool IsValueReturningDelegateToVoidDelegate(Type target, Type source)
    {
        if (!ClrTypeUtilities.IsDelegateType(target) || !ClrTypeUtilities.IsDelegateType(source))
        {
            return false;
        }

        MethodInfo targetInvoke;
        MethodInfo sourceInvoke;
        try
        {
            targetInvoke = target.GetMethod("Invoke");
            sourceInvoke = source.GetMethod("Invoke");
        }
        catch (Exception)
        {
            return false;
        }

        if (targetInvoke is null || sourceInvoke is null)
        {
            return false;
        }

        // Target must return void; source must return a value.
        if (!string.Equals(targetInvoke.ReturnType.FullName, "System.Void", StringComparison.Ordinal))
        {
            return false;
        }

        if (string.Equals(sourceInvoke.ReturnType.FullName, "System.Void", StringComparison.Ordinal))
        {
            return false;
        }

        var targetParams = targetInvoke.GetParameters();
        var sourceParams = sourceInvoke.GetParameters();
        if (targetParams.Length != sourceParams.Length)
        {
            return false;
        }

        for (var i = 0; i < targetParams.Length; i++)
        {
            if (!ClrTypeUtilities.AreSame(targetParams[i].ParameterType, sourceParams[i].ParameterType))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #908: determines whether <paramref name="source"/> is a delegate
    /// type whose parameter signature is identical to delegate
    /// <paramref name="target"/> but whose return type is a derived /
    /// implementing reference type of the target's return type — i.e. a
    /// reference-preserving delegate return-type covariance
    /// (<c>Func&lt;MemoryStream&gt;</c> → <c>Func&lt;Stream&gt;</c>,
    /// <c>() -&gt; NullLoggerFactory</c> → <c>Func&lt;ILoggerFactory&gt;</c>).
    /// Parameter and return types are compared by name to remain safe across
    /// reflection contexts (the target parameter is typically loaded through a
    /// <c>MetadataLoadContext</c> while the literal's natural <c>Func&lt;...&gt;</c>
    /// may be a host-runtime constructed type). Only reference conversions are
    /// accepted (no value-type / boxing / numeric conversions), matching C#'s
    /// variance rules.
    /// </summary>
    /// <param name="target">The candidate delegate parameter type.</param>
    /// <param name="source">The argument's natural delegate type.</param>
    /// <returns><see langword="true"/> when the covariant conversion applies.</returns>
    private static bool IsDelegateReturnCovariant(Type target, Type source)
    {
        if (!ClrTypeUtilities.IsDelegateType(target) || !ClrTypeUtilities.IsDelegateType(source))
        {
            return false;
        }

        if (!TryGetDelegateSignature(target, out var targetParams, out var targetReturn)
            || !TryGetDelegateSignature(source, out var sourceParams, out var sourceReturn))
        {
            return false;
        }

        if (targetReturn is null || sourceReturn is null)
        {
            return false;
        }

        // Identity return types are handled by the normal delegate identity /
        // assignability paths; covariance only applies when they differ.
        if (ClrTypeUtilities.AreSame(targetReturn, sourceReturn))
        {
            return false;
        }

        // Reference-preserving only: both return types must be reference types
        // (no value-type covariance, no boxing).
        if (targetReturn.IsValueType || sourceReturn.IsValueType
            || string.Equals(targetReturn.FullName, "System.Void", StringComparison.Ordinal)
            || string.Equals(sourceReturn.FullName, "System.Void", StringComparison.Ordinal))
        {
            return false;
        }

        if (!IsReferencePreservingUpcast(targetReturn, sourceReturn))
        {
            return false;
        }

        // Parameter signatures must match exactly (by name, cross-context safe).
        if (targetParams.Length != sourceParams.Length)
        {
            return false;
        }

        for (var i = 0; i < targetParams.Length; i++)
        {
            if (!ClrTypeUtilities.AreSame(targetParams[i], sourceParams[i]))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #1150: determines whether <paramref name="source"/> is a delegate
    /// type whose parameter signature is identical to delegate
    /// <paramref name="target"/> but whose numeric return type implicitly,
    /// losslessly widens to the target's numeric return type per the standard
    /// integer-widening lattice (e.g. <c>Func&lt;Item,uint32&gt;</c> →
    /// <c>Func&lt;Item,int64&gt;</c>). This mirrors C#'s implicit numeric
    /// conversion of a lambda body to an expected delegate return type, and lets
    /// a <c>uint32</c> selector flow into <c>Enumerable.Sum(Func&lt;T,long&gt;)</c>.
    /// Parameter and return types are compared by name to remain safe across
    /// reflection contexts (the literal's natural <c>Func&lt;...&gt;</c> may be a
    /// host-runtime constructed type closed over MetadataLoadContext arguments).
    /// Only the widening lattice in this file is consulted; narrowing and
    /// signed/unsigned same-width mismatches are rejected.
    /// </summary>
    /// <param name="target">The candidate delegate parameter type.</param>
    /// <param name="source">The argument's natural delegate type.</param>
    /// <returns><see langword="true"/> when the numeric-widening return conversion applies.</returns>
    private static bool IsDelegateReturnNumericWidening(Type target, Type source)
    {
        if (!ClrTypeUtilities.IsDelegateType(target) || !ClrTypeUtilities.IsDelegateType(source))
        {
            return false;
        }

        if (!TryGetDelegateSignature(target, out var targetParams, out var targetReturn)
            || !TryGetDelegateSignature(source, out var sourceParams, out var sourceReturn))
        {
            return false;
        }

        if (targetReturn is null || sourceReturn is null)
        {
            return false;
        }

        // Identity return types are handled by the normal delegate identity /
        // assignability paths; numeric widening only applies when they differ.
        if (ClrTypeUtilities.AreSame(targetReturn, sourceReturn))
        {
            return false;
        }

        // The source's return type must implicitly widen to the target's return
        // type per the lossless numeric-widening lattice (directional only).
        if (!IsNumericWidening(sourceReturn, targetReturn))
        {
            return false;
        }

        // Parameter signatures must match exactly (by name, cross-context safe).
        if (targetParams.Length != sourceParams.Length)
        {
            return false;
        }

        for (var i = 0; i < targetParams.Length; i++)
        {
            if (!ClrTypeUtilities.AreSame(targetParams[i], sourceParams[i]))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #932: determines whether <paramref name="source"/> and
    /// <paramref name="target"/> are two distinct delegate types with an
    /// identical <c>Invoke</c> shape — the same parameter types and the same
    /// return type. A <c>func</c>/arrow literal's natural delegate type is a
    /// <c>System.Func&lt;...&gt;</c> / <c>System.Action&lt;...&gt;</c>, but a
    /// CLR API may type the parameter as a structurally identical, differently
    /// named delegate (e.g. <c>System.Predicate&lt;T&gt;</c>,
    /// <c>System.Comparison&lt;T&gt;</c>). C# lets a lambda target any
    /// compatible delegate type, so G# must treat the literal as applicable to
    /// such a parameter. Parameter and return types are compared by name to
    /// remain safe across reflection contexts (the target parameter is
    /// typically loaded through a <c>MetadataLoadContext</c> while the literal's
    /// natural <c>Func&lt;...&gt;</c> is a live-runtime constructed type). The
    /// exact-return-type requirement keeps this distinct from
    /// <see cref="IsDelegateReturnCovariant"/> (differing returns) and
    /// <see cref="IsValueReturningDelegateToVoidDelegate"/> (void discard),
    /// which handle the non-identity return shapes.
    /// </summary>
    /// <param name="target">The candidate delegate parameter type.</param>
    /// <param name="source">The argument's natural delegate type.</param>
    /// <returns><see langword="true"/> when the structural delegate conversion applies.</returns>
    private static bool IsStructurallyCompatibleDelegate(Type target, Type source)
    {
        if (!ClrTypeUtilities.IsDelegateType(target) || !ClrTypeUtilities.IsDelegateType(source))
        {
            return false;
        }

        // Same delegate definition is already handled by the identity /
        // assignability paths; this conversion only bridges distinct kinds.
        if (ClrTypeUtilities.AreSame(target, source))
        {
            return false;
        }

        if (!TryGetDelegateSignature(target, out var targetParams, out var targetReturn)
            || !TryGetDelegateSignature(source, out var sourceParams, out var sourceReturn))
        {
            return false;
        }

        if (targetReturn is null || sourceReturn is null
            || !ClrTypeUtilities.AreSame(targetReturn, sourceReturn))
        {
            return false;
        }

        if (targetParams.Length != sourceParams.Length)
        {
            return false;
        }

        for (var i = 0; i < targetParams.Length; i++)
        {
            if (!ClrTypeUtilities.AreSame(targetParams[i], sourceParams[i]))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #908: extracts a delegate type's parameter types and return type.
    /// Prefers the <c>Invoke</c> method, but falls back to decomposing the
    /// generic arguments of a closed <c>System.Func`N</c> / <c>System.Action`N</c>
    /// shape. The fallback is required because a <c>func</c>/arrow literal's
    /// natural delegate type is built by <c>FunctionTypeSymbol.BuildClrType</c>
    /// as a host-runtime <c>Func&lt;&gt;</c> closed over
    /// <see cref="System.Reflection.MetadataLoadContext"/> type arguments, on
    /// which <see cref="Type.GetMethod(string)"/> throws.
    /// </summary>
    private static bool TryGetDelegateSignature(Type delegateType, out Type[] parameterTypes, out Type returnType)
    {
        parameterTypes = Array.Empty<Type>();
        returnType = null;

        try
        {
            var invoke = delegateType.GetMethod("Invoke");
            if (invoke != null)
            {
                var ps = invoke.GetParameters();
                var result = new Type[ps.Length];
                for (var i = 0; i < ps.Length; i++)
                {
                    result[i] = ps[i].ParameterType;
                }

                parameterTypes = result;
                returnType = invoke.ReturnType;
                return true;
            }
        }
        catch (Exception)
        {
            // Cross-context constructed Func<>/Action<> — fall back to the
            // generic-argument decomposition below.
        }

        var fullName = delegateType.FullName;
        if (fullName == null || !delegateType.IsGenericType)
        {
            return false;
        }

        Type[] genericArgs;
        try
        {
            genericArgs = delegateType.GetGenericArguments();
        }
        catch (Exception)
        {
            return false;
        }

        if (fullName.StartsWith("System.Func`", StringComparison.Ordinal) && genericArgs.Length >= 1)
        {
            // Func<T1,...,Tn,TResult>: trailing argument is the return type.
            var ps = new Type[genericArgs.Length - 1];
            Array.Copy(genericArgs, ps, ps.Length);
            parameterTypes = ps;
            returnType = genericArgs[genericArgs.Length - 1];
            return true;
        }

        if (fullName.StartsWith("System.Action`", StringComparison.Ordinal))
        {
            // Action<T1,...,Tn>: void return, all generic arguments are parameters.
            parameterTypes = genericArgs;
            returnType = typeof(void);
            return true;
        }

        // Issue #932: any other closed generic delegate (e.g.
        // System.Predicate<T>, System.Comparison<T>, System.Converter<TIn,TOut>)
        // whose constructed Invoke is unreachable across reflection contexts.
        // Read the Invoke signature off the open generic definition — which is
        // always in metadata — then substitute the closed type arguments into
        // each generic-parameter slot. This generalises the Func/Action special
        // cases above to the whole delegate surface a func/arrow literal may
        // target.
        try
        {
            var definition = delegateType.GetGenericTypeDefinition();
            var defInvoke = definition.GetMethod("Invoke");
            if (defInvoke == null)
            {
                return false;
            }

            var defParams = defInvoke.GetParameters();
            var resolvedParams = new Type[defParams.Length];
            for (var i = 0; i < defParams.Length; i++)
            {
                resolvedParams[i] = SubstituteGenericParameter(defParams[i].ParameterType, genericArgs);
            }

            parameterTypes = resolvedParams;
            returnType = SubstituteGenericParameter(defInvoke.ReturnType, genericArgs);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>
    /// Issue #932: maps a (possibly generic-parameter) type drawn from a
    /// delegate's open-definition <c>Invoke</c> signature to the corresponding
    /// closed type argument. A bare generic parameter <c>T</c> is replaced by
    /// <paramref name="genericArgs"/> at its <see cref="Type.GenericParameterPosition"/>;
    /// every other type is returned unchanged. Only the direct-parameter case
    /// is needed for the BCL delegates a func/arrow literal targets
    /// (<c>Predicate&lt;T&gt;</c>, <c>Comparison&lt;T&gt;</c>,
    /// <c>Converter&lt;TIn,TOut&gt;</c>).
    /// </summary>
    /// <param name="type">A type from the open definition's Invoke signature.</param>
    /// <param name="genericArgs">The closed delegate's type arguments.</param>
    /// <returns>The substituted type.</returns>
    private static Type SubstituteGenericParameter(Type type, Type[] genericArgs)
    {
        if (type != null && type.IsGenericParameter
            && type.GenericParameterPosition >= 0
            && type.GenericParameterPosition < genericArgs.Length)
        {
            return genericArgs[type.GenericParameterPosition];
        }

        return type;
    }

    /// <summary>
    /// Issue #908: determines whether <paramref name="source"/> is
    /// reference-convertible (an upcast) to <paramref name="target"/> — i.e.
    /// <paramref name="target"/> is the same type, an interface implemented by
    /// <paramref name="source"/>, or a base class of <paramref name="source"/>.
    /// Compared by name so it is robust across reflection contexts.
    /// </summary>
    private static bool IsReferencePreservingUpcast(Type target, Type source)
    {
        if (ClrTypeUtilities.AreSame(target, source))
        {
            return true;
        }

        if (string.Equals(target.FullName, "System.Object", StringComparison.Ordinal))
        {
            return true;
        }

        if (target.IsInterface && ClrTypeUtilities.ImplementsInterfaceByName(source, target))
        {
            return true;
        }

        for (var baseType = SafeBaseType(source); baseType != null; baseType = SafeBaseType(baseType))
        {
            if (ClrTypeUtilities.AreSame(baseType, target))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #908: returns <see cref="Type.BaseType"/>, swallowing the reflection
    /// load failures that cross-context constructed generics can throw during a
    /// base-type walk.
    /// </summary>
    private static Type SafeBaseType(Type type)
    {
        try
        {
            return type.BaseType;
        }
        catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex))
        {
            return null;
        }
    }

    /// <summary>
    /// Evaluates a single candidate for applicability against the supplied
    /// argument types, appending it to <paramref name="applicable"/> when it
    /// applies. Factored out of <see cref="Resolve{T}(IEnumerable{T}, IReadOnlyList{Type}, IReadOnlyList{Type}, Func{Type, Type}, IReadOnlyList{bool}, IReadOnlyList{string})"/>
    /// so the per-candidate work can be guarded against reflection load
    /// failures (issue #321) without disturbing the surrounding control flow.
    /// </summary>
    private static void EvaluateCandidate<T>(T rawCandidate, IReadOnlyList<Type> argTypes, IReadOnlyList<Type> explicitTypeArgs, Func<Type, Type> projectTypeArgument, List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)> applicable, IReadOnlyList<bool> interpolatedStringArgs = null, IReadOnlyList<string> argumentNames = null)
        where T : MethodBase
    {
        {
            // Stream F follow-up: when the candidate is an open generic method
            // definition, attempt to infer its type arguments from the supplied
            // arg types. A successful inference yields a closed MethodInfo that
            // then participates in the same applicability + ranking pass as a
            // non-generic candidate. Inference failures or constraint
            // violations drop the candidate silently (matches C# §7.5.2 "if
            // type inference fails, the method is not applicable").
            T candidate = rawCandidate;
            if (explicitTypeArgs != null)
            {
                // Issue #311: explicit type-argument path. Only open generic
                // method definitions of matching arity are applicable; close
                // them with the supplied type arguments verbatim.
                if (rawCandidate is MethodInfo gmi
                    && gmi.IsGenericMethodDefinition
                    && gmi.GetGenericArguments().Length == explicitTypeArgs.Count)
                {
                    MethodInfo closed;
                    try
                    {
                        closed = gmi.MakeGenericMethod(explicitTypeArgs.ToArray());
                    }
                    catch (ArgumentException)
                    {
                        // Generic constraints not satisfied — drop this candidate.
                        return;
                    }

                    // Issue #750 / ADR-0088: same constraint check as the
                    // inference path. Required because MetadataLoadContext's
                    // MakeGenericMethod does not validate constraints.
                    if (!SatisfiesGenericConstraints(gmi, explicitTypeArgs.ToArray()))
                    {
                        return;
                    }

                    candidate = (T)(MethodBase)closed;
                }
                else
                {
                    return;
                }
            }
            else if (rawCandidate is MethodInfo mi && mi.IsGenericMethodDefinition)
            {
                // Issue #343: when named arguments are present, the per-source
                // argTypes are not necessarily in parameter order. Build an
                // ordered argTypes for inference by mapping each source index to
                // its target parameter position (positional first, then named by
                // name). Inference is purely on parameter-type vs argument-type
                // unification, so the mapping must already be known before
                // inference; we use this open candidate's parameters to compute it.
                IReadOnlyList<Type> inferenceArgTypes = argTypes;
                if (argumentNames != null && HasAnyNamedArgument(argumentNames))
                {
                    if (!TryBuildOrderedArgTypesForInference(mi, argTypes, argumentNames, out var orderedArgTypes))
                    {
                        return;
                    }

                    inferenceArgTypes = orderedArgTypes;
                }

                if (!TryInferTypeArguments(mi, inferenceArgTypes, out var typeArgs))
                {
                    return;
                }

                // Issue #321: inferred type arguments are live host-runtime types
                // pulled from the bound arguments. Project them onto the same load
                // context that loaded the open method so MakeGenericMethod accepts
                // them; otherwise it throws "was not loaded by the
                // MetadataLoadContext that loaded the generic type or method".
                if (projectTypeArgument != null)
                {
                    for (var t = 0; t < typeArgs.Length; t++)
                    {
                        typeArgs[t] = projectTypeArgument(typeArgs[t]) ?? typeArgs[t];
                    }
                }

                MethodInfo closed;
                try
                {
                    closed = mi.MakeGenericMethod(typeArgs);
                }
                catch (ArgumentException)
                {
                    // Generic constraints not satisfied — drop this candidate.
                    return;
                }

                // Issue #750 / ADR-0088: explicitly validate generic-parameter
                // constraints against the inferred type arguments. The runtime
                // overload of MakeGenericMethod throws on constraint violation,
                // but the MetadataLoadContext overload silently accepts any
                // closure — without this check, a `where T : class` candidate
                // bound with T = Nullable<int> survives applicability and the
                // resolver picks the wrong overload, emitting IL that fails
                // verification at runtime.
                if (!SatisfiesGenericConstraints(mi, typeArgs))
                {
                    return;
                }

                candidate = (T)(MethodBase)closed;
            }

            var parameters = candidate.GetParameters();

            // Issue #343: build a per-source-index → parameter-position mapping
            // when named arguments are present. Reject the candidate if any
            // named argument refers to a parameter that does not exist, is
            // already filled by a positional argument, or is named twice. Any
            // parameter slot that ends up unfilled must be optional.
            int[] mapping = null;
            if (argumentNames != null && HasAnyNamedArgument(argumentNames))
            {
                if (!TryBuildNamedArgumentMapping(parameters, argTypes.Count, argumentNames, out mapping))
                {
                    return;
                }
            }
            else if (argTypes.Count > parameters.Length || !TrailingParametersOptional(parameters, argTypes.Count))
            {
                // Issue #321: a candidate applies when it has at least as many
                // parameters as arguments and every parameter beyond the supplied
                // arguments is optional (has a compile-time default). Only the
                // supplied arguments participate in applicability and ranking; the
                // omitted trailing optionals are materialized to their defaults by
                // the binder before emit.
                return;
            }

            var conversions = new ImplicitConversionKind[argTypes.Count];
            var paramTypes = new Type[argTypes.Count];
            var ok = true;
            for (var i = 0; i < argTypes.Count; i++)
            {
                var paramIndex = mapping != null ? mapping[i] : i;
                paramTypes[i] = parameters[paramIndex].ParameterType;
                var conv = ClassifyImplicit(paramTypes[i], argTypes[i]);
                if (conv == ImplicitConversionKind.None)
                {
                    // ADR-0055 Tier 4 (#369): an interpolated-string argument
                    // (natural type `string`) additionally converts to an
                    // `IFormattable`/`FormattableString` parameter. This is the
                    // only case where the argument's natural type does not
                    // directly convert yet the candidate still applies; the
                    // binder re-lowers the interpolation against the chosen
                    // parameter once this candidate wins.
                    if (interpolatedStringArgs != null
                        && i < interpolatedStringArgs.Count
                        && interpolatedStringArgs[i]
                        && IsFormattableStringTarget(paramTypes[i]))
                    {
                        conv = ImplicitConversionKind.InterpolatedStringToFormattable;
                    }
                    else if (ConstantNarrowingArgumentCheck != null
                        && ConstantNarrowingArgumentCheck(i, paramTypes[i]))
                    {
                        // Issue #1311: a constant integer argument that fits a
                        // narrower / cross-sign integer parameter is implicitly
                        // convertible there (C# §10.2.11), so it must not
                        // disqualify the imported/BCL candidate. Mirrors the
                        // user-method path (OverloadResolver). The binder's
                        // BindClrParameterConversions pass re-materialises the
                        // correctly-typed literal before emit.
                        conv = ImplicitConversionKind.ConstantNarrowing;
                    }
                    else
                    {
                        ok = false;
                        break;
                    }
                }

                conversions[i] = conv;
            }

            if (ok)
            {
                applicable.Add((candidate, conversions, paramTypes, mapping, false));
            }
        }
    }

    /// <summary>
    /// Issue #506: evaluates a candidate in <em>expanded</em> form — the trailing
    /// <c>params T[]</c> parameter accepts zero or more positional arguments, each
    /// assignable to the element type <c>T</c>. Closes open generic candidates
    /// (e.g. <c>Bar&lt;T&gt;(params T[] items)</c>) by inferring <c>T</c> from
    /// the trailing arguments via the same unification used by
    /// <see cref="TryInferTypeArguments"/>. Honours named arguments that bind to
    /// a leading fixed parameter (the params parameter itself is never nameable
    /// from caller-side under G#'s positional-before-named layout); the leftover
    /// positional surplus is packed into the synthesised array. Mirrors the
    /// applicability check in <see cref="EvaluateCandidate"/> but rewrites the
    /// trailing parameter type to the element type for ranking purposes.
    /// </summary>
    private static void EvaluateExpandedParamsCandidate<T>(T rawCandidate, IReadOnlyList<Type> argTypes, IReadOnlyList<Type> explicitTypeArgs, Func<Type, Type> projectTypeArgument, List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)> applicable, IReadOnlyList<string> argumentNames = null)
        where T : MethodBase
    {
        T candidate = rawCandidate;

        // Issue #506 follow-up: close open generic candidates before applicability
        // classification. Explicit type arguments win; otherwise infer from the
        // supplied positional/named args (trailing positionals beyond the params
        // index unify against T).
        if (explicitTypeArgs != null)
        {
            if (rawCandidate is MethodInfo gmi
                && gmi.IsGenericMethodDefinition
                && gmi.GetGenericArguments().Length == explicitTypeArgs.Count)
            {
                MethodInfo closed;
                try
                {
                    closed = gmi.MakeGenericMethod(explicitTypeArgs.ToArray());
                }
                catch (ArgumentException)
                {
                    return;
                }

                if (!SatisfiesGenericConstraints(gmi, explicitTypeArgs.ToArray()))
                {
                    return;
                }

                candidate = (T)(MethodBase)closed;
            }
            else
            {
                return;
            }
        }
        else if (rawCandidate is MethodInfo mi && mi.IsGenericMethodDefinition)
        {
            if (!TryInferTypeArgumentsForExpandedParams(mi, argTypes, argumentNames, out var typeArgs))
            {
                return;
            }

            if (projectTypeArgument != null)
            {
                for (var t = 0; t < typeArgs.Length; t++)
                {
                    typeArgs[t] = projectTypeArgument(typeArgs[t]) ?? typeArgs[t];
                }
            }

            MethodInfo closed;
            try
            {
                closed = mi.MakeGenericMethod(typeArgs);
            }
            catch (ArgumentException)
            {
                return;
            }

            if (!SatisfiesGenericConstraints(mi, typeArgs))
            {
                return;
            }

            candidate = (T)(MethodBase)closed;
        }

        var parameters = candidate.GetParameters();
        if (parameters.Length == 0)
        {
            return;
        }

        var paramsIndex = parameters.Length - 1;
        if (!IsParamsArrayParameter(parameters[paramsIndex]))
        {
            return;
        }

        var elementType = parameters[paramsIndex].ParameterType.GetElementType();
        if (elementType == null)
        {
            return;
        }

        // G#'s positional-before-named rule guarantees the layout
        //   [positional_0 … positional_{P-1}, named_0 … named_{N-1}].
        // The leading positionals fill slots 0..min(P, paramsIndex)-1; the
        // surplus past the params slot (positionals at indices
        // [paramsIndex..P-1]) is packed into the synthesised array; the named
        // arguments fill the remaining fixed slots by parameter name. A named
        // argument that targets the params parameter or a slot already filled
        // positionally rejects the candidate.
        var positionalCount = argTypes.Count;
        var hasNamed = argumentNames != null && HasAnyNamedArgument(argumentNames);
        if (hasNamed)
        {
            positionalCount = 0;
            while (positionalCount < argTypes.Count && argumentNames[positionalCount] == null)
            {
                positionalCount++;
            }

            for (var i = positionalCount; i < argTypes.Count; i++)
            {
                if (argumentNames[i] == null)
                {
                    return;
                }
            }
        }

        var fixedFilledByPositional = positionalCount < paramsIndex ? positionalCount : paramsIndex;
        var tailCount = positionalCount > paramsIndex ? positionalCount - paramsIndex : 0;

        var mapping = new int[argTypes.Count];
        var filled = new bool[parameters.Length];
        for (var i = 0; i < fixedFilledByPositional; i++)
        {
            mapping[i] = i;
            filled[i] = true;
        }

        for (var i = fixedFilledByPositional; i < positionalCount; i++)
        {
            mapping[i] = paramsIndex;
        }

        if (tailCount > 0)
        {
            filled[paramsIndex] = true;
        }

        if (hasNamed)
        {
            for (var i = positionalCount; i < argTypes.Count; i++)
            {
                var name = argumentNames[i];
                var paramIdx = FindParameterIndex(parameters, name);
                if (paramIdx < 0 || paramIdx == paramsIndex || filled[paramIdx])
                {
                    return;
                }

                mapping[i] = paramIdx;
                filled[paramIdx] = true;
            }
        }

        // Every non-params fixed slot left empty must be optional. The params
        // slot is virtually optional in expanded form (zero trailing args
        // allocates an empty array).
        for (var i = 0; i < paramsIndex; i++)
        {
            if (!filled[i] && !parameters[i].IsOptional)
            {
                return;
            }
        }

        var conversions = new ImplicitConversionKind[argTypes.Count];
        var paramTypes = new Type[argTypes.Count];
        for (var i = 0; i < argTypes.Count; i++)
        {
            var slot = mapping[i];
            Type target;
            if (slot == paramsIndex && i >= fixedFilledByPositional)
            {
                target = elementType;
            }
            else
            {
                target = parameters[slot].ParameterType;
            }

            paramTypes[i] = target;
            var conv = ClassifyImplicit(target, argTypes[i]);
            if (conv == ImplicitConversionKind.None)
            {
                return;
            }

            conversions[i] = conv;
        }

        // When all arguments are purely positional, drop the mapping so the
        // existing ExpandParamsArguments fast path remains the canonical
        // post-resolution lowering (matches the prior signature).
        var storedMapping = hasNamed ? mapping : null;
        applicable.Add((candidate, conversions, paramTypes, storedMapping, true));
    }

    /// <summary>
    /// Issue #506 follow-up: infers method type arguments for an open generic
    /// candidate in <c>params T[]</c> expanded form. Each fixed leading
    /// parameter unifies against its positional/named argument; trailing
    /// positionals beyond the params index unify against the params element
    /// type. Returns <see langword="false"/> when any type parameter cannot
    /// be bound.
    /// </summary>
    private static bool TryInferTypeArgumentsForExpandedParams(MethodInfo openMethod, IReadOnlyList<Type> argTypes, IReadOnlyList<string> argumentNames, out Type[] typeArgs)
    {
        typeArgs = null;
        var parameters = openMethod.GetParameters();
        if (parameters.Length == 0)
        {
            return false;
        }

        var paramsIndex = parameters.Length - 1;
        if (!IsParamsArrayParameter(parameters[paramsIndex]))
        {
            return false;
        }

        var elementType = parameters[paramsIndex].ParameterType.GetElementType();
        if (elementType == null)
        {
            return false;
        }

        var positionalCount = argTypes.Count;
        var hasNamed = argumentNames != null && HasAnyNamedArgument(argumentNames);
        if (hasNamed)
        {
            positionalCount = 0;
            while (positionalCount < argTypes.Count && argumentNames[positionalCount] == null)
            {
                positionalCount++;
            }
        }

        var typeParams = openMethod.GetGenericArguments();
        var bounds = new Dictionary<string, Type>(StringComparer.Ordinal);

        var fixedFilledByPositional = positionalCount < paramsIndex ? positionalCount : paramsIndex;

        for (var i = 0; i < fixedFilledByPositional; i++)
        {
            if (argTypes[i] == null)
            {
                continue;
            }

            if (!UnifyForInference(parameters[i].ParameterType, argTypes[i], bounds))
            {
                return false;
            }
        }

        for (var i = fixedFilledByPositional; i < positionalCount; i++)
        {
            if (argTypes[i] == null)
            {
                continue;
            }

            if (!UnifyForInference(elementType, argTypes[i], bounds))
            {
                return false;
            }
        }

        if (hasNamed)
        {
            for (var i = positionalCount; i < argTypes.Count; i++)
            {
                var name = argumentNames[i];
                var paramIdx = FindParameterIndex(parameters, name);
                if (paramIdx < 0 || paramIdx == paramsIndex)
                {
                    return false;
                }

                if (argTypes[i] == null)
                {
                    continue;
                }

                if (!UnifyForInference(parameters[paramIdx].ParameterType, argTypes[i], bounds))
                {
                    return false;
                }
            }
        }

        var result = new Type[typeParams.Length];
        for (var i = 0; i < typeParams.Length; i++)
        {
            if (!bounds.TryGetValue(typeParams[i].Name, out var bound))
            {
                return false;
            }

            result[i] = bound;
        }

        typeArgs = result;
        return true;
    }

    /// <summary>
    /// Issue #343: returns <see langword="true"/> when any entry in
    /// <paramref name="argumentNames"/> is non-null (i.e. the call site has at
    /// least one named argument).
    /// </summary>
    private static bool HasAnyNamedArgument(IReadOnlyList<string> argumentNames)
    {
        if (argumentNames == null)
        {
            return false;
        }

        for (var i = 0; i < argumentNames.Count; i++)
        {
            if (argumentNames[i] != null)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #343: matches positional and named arguments to a candidate's
    /// parameters, producing a per-source-index → parameter-position mapping.
    /// Returns <see langword="false"/> when the candidate is not applicable
    /// (unknown name, duplicate slot, or required slot left unfilled).
    /// </summary>
    private static bool TryBuildNamedArgumentMapping(ParameterInfo[] parameters, int argCount, IReadOnlyList<string> argumentNames, out int[] mapping)
    {
        mapping = null;
        if (argCount > parameters.Length)
        {
            return false;
        }

        var result = new int[argCount];
        var filled = new bool[parameters.Length];

        // Positional arguments occupy parameter slots [0..positionalCount).
        var positionalCount = 0;
        for (var i = 0; i < argCount; i++)
        {
            if (argumentNames[i] != null)
            {
                break;
            }

            result[i] = i;
            filled[i] = true;
            positionalCount++;
        }

        // Each named argument fills the slot whose parameter name matches.
        // Reject duplicates or slots already filled by positional args.
        for (var i = positionalCount; i < argCount; i++)
        {
            var name = argumentNames[i];
            if (name == null)
            {
                // Should not happen: pre-validation forbids positional after named.
                return false;
            }

            var paramIndex = FindParameterIndex(parameters, name);
            if (paramIndex < 0 || filled[paramIndex])
            {
                return false;
            }

            result[i] = paramIndex;
            filled[paramIndex] = true;
        }

        // Every unfilled parameter must be optional.
        for (var i = 0; i < parameters.Length; i++)
        {
            if (!filled[i] && !parameters[i].IsOptional)
            {
                return false;
            }
        }

        mapping = result;
        return true;
    }

    /// <summary>
    /// Issue #343: returns the index of the parameter whose name matches
    /// <paramref name="name"/> (ordinal comparison), or -1 when no parameter
    /// has that name.
    /// </summary>
    private static int FindParameterIndex(ParameterInfo[] parameters, string name)
    {
        for (var i = 0; i < parameters.Length; i++)
        {
            if (string.Equals(parameters[i].Name, name, StringComparison.Ordinal))
            {
                return i;
            }
        }

        return -1;
    }

    /// <summary>
    /// Issue #343: builds the parameter-order arg-type vector required by
    /// <see cref="TryInferTypeArguments"/> when named arguments are present.
    /// Returns <see langword="false"/> when names cannot be matched to
    /// <paramref name="openMethod"/>'s parameters.
    /// </summary>
    private static bool TryBuildOrderedArgTypesForInference(MethodInfo openMethod, IReadOnlyList<Type> argTypes, IReadOnlyList<string> argumentNames, out Type[] orderedArgTypes)
    {
        orderedArgTypes = null;
        var parameters = openMethod.GetParameters();
        if (!TryBuildNamedArgumentMapping(parameters, argTypes.Count, argumentNames, out var mapping))
        {
            return false;
        }

        // The inference helper only consumes the leading parameters whose count
        // equals argTypes.Count, in parameter order. Reorder argTypes so each
        // source argument's type lands at its target parameter position. Any
        // omitted optional slots in the middle break the leading-prefix
        // invariant; in that case fall back to the per-parameter-position
        // mapping and trim trailing nulls — TryInferTypeArguments expects
        // exactly argTypes.Count leading types.
        var perParam = new Type[parameters.Length];
        var filled = new bool[parameters.Length];
        for (var i = 0; i < argTypes.Count; i++)
        {
            perParam[mapping[i]] = argTypes[i];
            filled[mapping[i]] = true;
        }

        // Inference only needs types for parameters that have an argument; the
        // helper accepts argTypes shorter than parameters.Length (with the
        // trailing parameters required to be optional). We compress filled
        // parameter positions into a leading prefix while preserving order.
        // When non-contiguous slots are filled (e.g. positional[0] + named at
        // slot 3 with slots 1,2 omitted), inference would have to skip the gaps
        // — but TryInferTypeArguments aligns position-by-position. To handle
        // gaps cleanly, build a contiguous leading-prefix view that uses each
        // filled parameter's type so per-position unification still aligns
        // correctly with the open candidate's parameter list, then close any
        // open type parameters that appeared only in gap positions.
        var leadingCount = 0;
        for (var i = 0; i < parameters.Length; i++)
        {
            if (filled[i])
            {
                leadingCount = i + 1;
            }
        }

        // Pad gap positions with the parameter's declared type so unification
        // is a no-op there (parameter unified against itself adds no new bound).
        var ordered = new Type[leadingCount];
        for (var i = 0; i < leadingCount; i++)
        {
            ordered[i] = filled[i] ? perParam[i] : parameters[i].ParameterType;
        }

        orderedArgTypes = ordered;
        return true;
    }

    /// <summary>
    /// Issue #343: packages a per-source-index → parameter-position mapping
    /// into an <see cref="ImmutableArray{Int32}"/> for the resolution result.
    /// Returns the default array when no named arguments were supplied.
    /// </summary>
    private static ImmutableArray<int> BuildMappingArray(int[] mapping, IReadOnlyList<string> argumentNames)
    {
        if (mapping == null || !HasAnyNamedArgument(argumentNames))
        {
            return default;
        }

        return ImmutableArray.Create(mapping);
    }

    /// <summary>
    /// Determines whether every parameter from <paramref name="suppliedCount"/>
    /// onward is optional (issue #321). Used to decide whether an overload with
    /// more parameters than supplied arguments can still apply by relying on the
    /// trailing parameters' compile-time default values.
    /// </summary>
    /// <param name="parameters">The candidate's parameter list.</param>
    /// <param name="suppliedCount">The number of arguments supplied at the call site.</param>
    /// <returns>Whether all parameters past the supplied arguments are optional.</returns>
    private static bool TrailingParametersOptional(ParameterInfo[] parameters, int suppliedCount)
    {
        for (var i = suppliedCount; i < parameters.Length; i++)
        {
            if (!parameters[i].IsOptional)
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Applies the C# "better function member" ranking pass to the applicable
    /// candidate set, returning the unique best, an ambiguity, or "none".
    /// Always called with at least two applicable candidates.
    /// </summary>
    /// <remarks>
    /// Issue #505 reworked this pass to match C# §7.5.3.2 semantics more
    /// faithfully:
    /// <list type="number">
    ///   <item>
    ///     <description>Pairwise <em>domination</em> removes candidates for
    ///     which some other candidate is strictly better. A candidate that is
    ///     not strictly worse than any other survives. (The previous
    ///     implementation required strict dominance over <em>every</em>
    ///     other candidate, which incorrectly rejected non-generic vs
    ///     generic ties where neither dominates by pure conversion-kind ranking.)</description>
    ///   </item>
    ///   <item>
    ///     <description>Among survivors, the standard tie-breakers run in C#
    ///     order: fewer-parameters (fewer omitted optionals), more-specific
    ///     parameter types, then non-generic-over-generic.</description>
    ///   </item>
    /// </list>
    /// Issue #506: the tuple carries an <c>IsExpanded</c> flag so the winning
    /// candidate's <c>params T[]</c>-expanded form is propagated to the
    /// caller through <see cref="Result{T}.IsExpanded"/>.
    /// </remarks>
    private static Result<T> RankApplicable<T>(List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)> applicable, IReadOnlyList<Type> argTypes, IReadOnlyList<string> argumentNames)
        where T : MethodBase
    {
        // Phase 1 — drop candidates that are strictly dominated by another.
        // C# §7.5.3.2: a candidate c is the best iff no other candidate is
        // strictly better than c. Equivalently, c survives iff for every other
        // candidate `other`, !IsStrictlyBetter(other, c).
        var nonDominated = new List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)>();
        foreach (var c in applicable)
        {
            var dominated = false;
            foreach (var other in applicable)
            {
                if (ReferenceEquals(c.Method, other.Method))
                {
                    continue;
                }

                if (IsAtLeastAsGoodAs(other.Conversions, other.ParamTypes, c.Conversions, c.ParamTypes, argTypes))
                {
                    dominated = true;
                    break;
                }
            }

            if (!dominated)
            {
                nonDominated.Add(c);
            }
        }

        if (nonDominated.Count == 1)
        {
            return Result<T>.Single(nonDominated[0].Method, BuildMappingArray(nonDominated[0].Mapping, argumentNames), nonDominated[0].IsExpanded);
        }

        var pool = nonDominated.Count > 0 ? nonDominated : applicable;

        // Phase 2a — issue #327: prefer the candidate that does not rely on
        // omitted optional/default parameters (the smallest parameter count).
        // Matches C# §7.5.3.2's preference for the member with no extra
        // defaulted parameters.
        if (pool.Count > 1)
        {
            var minParamCount = pool.Min(w => w.Method.GetParameters().Length);
            var fewestParams = pool
                .Where(w => w.Method.GetParameters().Length == minParamCount)
                .ToList();
            if (fewestParams.Count >= 1 && fewestParams.Count < pool.Count)
            {
                pool = fewestParams;
            }

            if (pool.Count == 1)
            {
                return Result<T>.Single(pool[0].Method, BuildMappingArray(pool[0].Mapping, argumentNames), pool[0].IsExpanded);
            }
        }

        // Phase 2b — prefer the candidate whose parameter types are
        // "more specific" (parameter-by-parameter assignability — a less
        // derived type is implicitly assignable from a more derived one).
        if (pool.Count > 1)
        {
            var mostSpecific = pool
                .Where(w => pool.All(o => ReferenceEquals(w.Method, o.Method) || IsAtLeastAsSpecific(w.Method, o.Method)))
                .ToList();
            if (mostSpecific.Count >= 1 && mostSpecific.Count < pool.Count)
            {
                pool = mostSpecific;
            }

            if (pool.Count == 1)
            {
                return Result<T>.Single(pool[0].Method, BuildMappingArray(pool[0].Mapping, argumentNames), pool[0].IsExpanded);
            }
        }

        // Phase 2c — issue #505: prefer a non-generic candidate over a generic
        // one when the candidates are otherwise tied. Matches C# §7.5.3.2:
        // "If MP is a non-generic method and MQ is a generic method, then MP
        // is better than MQ." Without this tie-break, xUnit-style helpers like
        // `Assert.Equal<T>(T, T)` collide with the non-generic
        // `Assert.Equal(string, string)` overload for two string arguments.
        if (pool.Count > 1)
        {
            var nonGeneric = pool.Where(w => !IsGenericMethod(w.Method)).ToList();
            if (nonGeneric.Count >= 1 && nonGeneric.Count < pool.Count)
            {
                pool = nonGeneric;
            }

            if (pool.Count == 1)
            {
                return Result<T>.Single(pool[0].Method, BuildMappingArray(pool[0].Mapping, argumentNames), pool[0].IsExpanded);
            }
        }

        // Phase 2d — issue #530: when multiple candidates survive with identical
        // parameter types but different declaring types (e.g. Task<T>.GetAwaiter()
        // vs. inherited Task.GetAwaiter()), prefer the most-derived declaring type.
        // This mirrors C#'s "method hiding" rule: a derived-class method hides any
        // base-class method with the same signature.
        if (pool.Count > 1)
        {
            var mostDerived = FilterToMostDerivedDeclaringType(pool);
            if (mostDerived.Count >= 1 && mostDerived.Count < pool.Count)
            {
                pool = mostDerived;
            }

            if (pool.Count == 1)
            {
                return Result<T>.Single(pool[0].Method, BuildMappingArray(pool[0].Mapping, argumentNames), pool[0].IsExpanded);
            }
        }

        // Phase 2e — issue #750 / ADR-0088: when two open generic candidates
        // have already been closed and both apply, prefer the one whose
        // generic-parameter constraints are strictly more specific
        // (struct > class > no constraint, per ADR-0088 §2). This is the
        // pure-overload tie-break that lets `Map<T>(T?, …) where T : class`
        // and `Map<T>(T?, …) where T : struct` co-exist on the same name —
        // mirroring C# §11.6.4.6 which uses constraints as the final ranking
        // axis after parameter shape and arity.
        if (pool.Count > 1)
        {
            var mostConstrained = pool
                .Where(w => pool.All(o => ReferenceEquals(w.Method, o.Method) || CompareConstraintSpecificity(w.Method, o.Method) >= 0))
                .ToList();
            if (mostConstrained.Count >= 1 && mostConstrained.Count < pool.Count)
            {
                pool = mostConstrained;
            }

            if (pool.Count == 1)
            {
                return Result<T>.Single(pool[0].Method, BuildMappingArray(pool[0].Mapping, argumentNames), pool[0].IsExpanded);
            }
        }

        // If nothing dominated above, report the surviving pool as ambiguous.
        var ambiguous = pool
            .Select(c => c.Method)
            .ToImmutableArray();
        return Result<T>.AmbiguousResult(ambiguous);
    }

    private static bool IsGenericMethod(MethodBase method)
        => method is MethodInfo mi && mi.IsGenericMethod;

    /// <summary>
    /// Issue #530: when multiple surviving candidates have the same parameter
    /// types but different declaring types (e.g. <c>Task&lt;T&gt;.GetAwaiter()</c>
    /// hiding <c>Task.GetAwaiter()</c>), keep only those declared on the
    /// most-derived type. This mirrors C#'s method-hiding semantics: a derived
    /// class method with the same signature as a base class method hides it.
    /// </summary>
    private static List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)> FilterToMostDerivedDeclaringType<T>(
        List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)> pool)
    {
        var result = new List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)>(pool.Count);
        foreach (var candidate in pool)
        {
            var declaringType = (candidate.Method as MethodBase)?.DeclaringType;
            if (declaringType == null)
            {
                result.Add(candidate);
                continue;
            }

            // Check if any other candidate in the pool is declared on a
            // more-derived type (i.e., a type that inherits from this one).
            bool isHidden = false;
            foreach (var other in pool)
            {
                if (ReferenceEquals(candidate.Method as MethodBase, other.Method as MethodBase))
                {
                    continue;
                }

                var otherDeclaring = (other.Method as MethodBase)?.DeclaringType;
                if (otherDeclaring != null && otherDeclaring != declaringType && IsSubclassOf(otherDeclaring, declaringType))
                {
                    isHidden = true;
                    break;
                }
            }

            if (!isHidden)
            {
                result.Add(candidate);
            }
        }

        return result;
    }

    /// <summary>
    /// Checks whether <paramref name="derived"/> is a subclass of
    /// <paramref name="baseType"/>, using FullName comparison for cross-context
    /// type compatibility (MetadataLoadContext vs. runtime types).
    /// </summary>
    private static bool IsSubclassOf(Type derived, Type baseType)
    {
        if (derived == null || baseType == null)
        {
            return false;
        }

        var baseFullName = baseType.FullName;
        for (var current = derived.BaseType; current != null; current = current.BaseType)
        {
            if (current == baseType || current.FullName == baseFullName)
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsAtLeastAsGoodAs(
        ImplicitConversionKind[] a,
        Type[] paramsA,
        ImplicitConversionKind[] b,
        Type[] paramsB,
        IReadOnlyList<Type> sources)
    {
        var hasStrictlyBetter = false;
        for (var i = 0; i < a.Length; i++)
        {
            var cmp = CompareConversions(a[i], paramsA[i], b[i], paramsB[i], sources[i]);
            if (cmp > 0)
            {
                return false;
            }

            if (cmp < 0)
            {
                hasStrictlyBetter = true;
            }
        }

        return hasStrictlyBetter;
    }

    private static int CompareConversions(
        ImplicitConversionKind ka,
        Type paramA,
        ImplicitConversionKind kb,
        Type paramB,
        Type source)
    {
        // Issue #377 sub-item 4: when one candidate offers a Tier-4
        // interpolated-string→FormattableString/IFormattable conversion and
        // the other offers a plain reference upcast to System.Object, prefer
        // the formattable conversion. This matches C# §11.18.1's "more
        // specific target" rule for interpolated-string arguments where
        // string > FormattableString > IFormattable > object. Without this
        // tiebreak the lower-ranked ImplicitConversionKind.Reference (3)
        // would beat InterpolatedStringToFormattable (8) and silently route
        // the interpolation through M(object).
        if (ka == ImplicitConversionKind.InterpolatedStringToFormattable
            && kb == ImplicitConversionKind.Reference
            && IsSystemObject(paramB))
        {
            return -1;
        }

        if (kb == ImplicitConversionKind.InterpolatedStringToFormattable
            && ka == ImplicitConversionKind.Reference
            && IsSystemObject(paramA))
        {
            return 1;
        }

        if (ka != kb)
        {
            return ((int)ka).CompareTo((int)kb);
        }

        // Same conversion kind: tie-break by "better conversion target" for
        // numeric widenings (C# §7.5.3.4). Other kinds fall back to "equal";
        // upstream IsAtLeastAsSpecific then breaks pure reference ties.
        if (ka == ImplicitConversionKind.NumericWidening)
        {
            return CompareNumericTargets(paramA, paramB, source);
        }

        // Issue #1150: when two candidates both convert a delegate argument by
        // numeric return-type widening, prefer the one whose delegate return is
        // the "better conversion target" for the source's return type — so a
        // uint32 selector prefers Func<T,long> over Func<T,double>/decimal,
        // mirroring C#'s preference of the closest integral target.
        if (ka == ImplicitConversionKind.DelegateReturnNumericWidening)
        {
            if (TryGetDelegateSignature(paramA, out _, out var retA)
                && TryGetDelegateSignature(paramB, out _, out var retB)
                && TryGetDelegateSignature(source, out _, out var retSource)
                && retA != null && retB != null && retSource != null)
            {
                return CompareNumericTargets(retA, retB, retSource);
            }

            return 0;
        }

        // Issue #377 sub-item 4: FormattableString is more specific than
        // IFormattable for an interpolated-string argument.
        if (ka == ImplicitConversionKind.InterpolatedStringToFormattable)
        {
            var aIsFs = string.Equals(PeelByRef(paramA)?.FullName, "System.FormattableString", StringComparison.Ordinal);
            var bIsFs = string.Equals(PeelByRef(paramB)?.FullName, "System.FormattableString", StringComparison.Ordinal);
            if (aIsFs && !bIsFs)
            {
                return -1;
            }

            if (bIsFs && !aIsFs)
            {
                return 1;
            }
        }

        return 0;
    }

    private static bool IsSystemObject(Type type)
    {
        type = PeelByRef(type);
        return type != null && string.Equals(type.FullName, "System.Object", StringComparison.Ordinal);
    }

    private static Type PeelByRef(Type type)
    {
        return type is { IsByRef: true } ? type.GetElementType() : type;
    }

    private static bool IsAtLeastAsSpecific(MethodBase a, MethodBase b)
    {
        var pa = a.GetParameters();
        var pb = b.GetParameters();

        // Issue #327/#321: optional-parameter omission can leave two applicable
        // candidates with different parameter counts. Compare only the shared
        // leading positions (the supplied arguments live there); trailing
        // optionals do not affect specificity.
        var shared = Math.Min(pa.Length, pb.Length);
        for (var i = 0; i < shared; i++)
        {
            // a is "at least as specific" parameter-wise when each of its
            // parameter types is assignable to b's (i.e. a's parameter is
            // more derived or equal).
            if (!ClrTypeUtilities.IsAssignableByName(pb[i].ParameterType, pa[i].ParameterType))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #750 / ADR-0088: validates that <paramref name="typeArgs"/>
    /// satisfies every CLR-level generic-parameter constraint declared on
    /// <paramref name="openMethod"/>. The runtime overload of
    /// <see cref="MethodInfo.MakeGenericMethod(Type[])"/> performs this
    /// check itself and throws <see cref="ArgumentException"/> on failure,
    /// but the <see cref="System.Reflection.MetadataLoadContext"/> overload
    /// (used for every <c>/reference</c> assembly the binder consumes)
    /// silently accepts any closure regardless of constraints. Without this
    /// explicit check a <c>where T : class</c> candidate inferred with
    /// <c>T = Nullable&lt;int&gt;</c> survives applicability and the
    /// resolver picks the wrong overload, emitting IL that fails
    /// verification at runtime.
    /// </summary>
    /// <param name="openMethod">The open generic method definition.</param>
    /// <param name="typeArgs">The candidate type arguments in declaration order.</param>
    /// <returns><see langword="true"/> when every constraint is satisfied.</returns>
    private static bool SatisfiesGenericConstraints(MethodInfo openMethod, Type[] typeArgs)
    {
        if (openMethod is null || typeArgs is null)
        {
            return true;
        }

        Type[] typeParams;
        try
        {
            typeParams = openMethod.GetGenericArguments();
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex))
        {
            return true;
        }

        if (typeParams.Length != typeArgs.Length)
        {
            return true;
        }

        for (var i = 0; i < typeParams.Length; i++)
        {
            var param = typeParams[i];
            var arg = typeArgs[i];
            if (arg is null || arg.IsGenericParameter)
            {
                continue;
            }

            GenericParameterAttributes attrs;
            try
            {
                attrs = param.GenericParameterAttributes;
            }
            catch (Exception ex) when (IsMetadataLoadFailure(ex))
            {
                continue;
            }

            var special = attrs & GenericParameterAttributes.SpecialConstraintMask;

            if ((special & GenericParameterAttributes.ReferenceTypeConstraint) != 0)
            {
                // `where T : class` — arg must be a reference type (not a
                // value type, not Nullable<T>).
                if (arg.IsValueType)
                {
                    return false;
                }
            }

            if ((special & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0)
            {
                // `where T : struct` — arg must be a non-nullable value type.
                if (!arg.IsValueType || NullableLifting.IsValueTypeNullableClr(arg))
                {
                    return false;
                }
            }

            if ((special & GenericParameterAttributes.DefaultConstructorConstraint) != 0
                && (special & GenericParameterAttributes.NotNullableValueTypeConstraint) == 0)
            {
                // `where T : new()` — arg must have a public parameterless
                // constructor. Value types always satisfy this implicitly;
                // reference types require an actual ctor.
                if (!arg.IsValueType)
                {
                    try
                    {
                        var ctor = arg.GetConstructor(Type.EmptyTypes);
                        if (ctor is null || !ctor.IsPublic)
                        {
                            return false;
                        }
                    }
                    catch (Exception ex) when (IsMetadataLoadFailure(ex))
                    {
                        // Conservative: a load failure means we can't disprove
                        // the constraint; keep the candidate alive.
                    }
                }
            }

            // Type-bound constraints — `where T : SomeBase` or
            // `where T : ISomething`. Constraints that reference another
            // method type parameter (e.g. `where TResult : T`) are skipped:
            // resolving them requires substitution and is rare on the
            // surfaces that motivated this work (ADR-0084). The dominant
            // class/struct cases above already disambiguate the
            // Optional/Sequences overload sets.
            Type[] typeConstraints;
            try
            {
                typeConstraints = param.GetGenericParameterConstraints();
            }
            catch (Exception ex) when (IsMetadataLoadFailure(ex))
            {
                continue;
            }

            for (var c = 0; c < typeConstraints.Length; c++)
            {
                var constraint = typeConstraints[c];
                if (constraint is null || constraint.IsGenericParameter || constraint.ContainsGenericParameters)
                {
                    continue;
                }

                try
                {
                    if (!ClrTypeUtilities.IsAssignableByName(constraint, arg))
                    {
                        return false;
                    }
                }
                catch (Exception ex) when (IsMetadataLoadFailure(ex))
                {
                    // Conservative — treat as satisfied on load failure.
                }
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #750 / ADR-0088: scores a single generic parameter's special
    /// constraints for the constraint-specificity tie-break.
    /// <c>where T : struct</c> dominates <c>where T : class</c> dominates
    /// no constraint. The two value-axis constraints are disjoint by
    /// construction so a strict ordering between them is well-defined.
    /// </summary>
    private static int ConstraintSpecificityScore(GenericParameterAttributes attrs)
    {
        var special = attrs & GenericParameterAttributes.SpecialConstraintMask;
        if ((special & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0)
        {
            return 2;
        }

        if ((special & GenericParameterAttributes.ReferenceTypeConstraint) != 0)
        {
            return 1;
        }

        return 0;
    }

    /// <summary>
    /// Issue #750 / ADR-0088: compares two candidates by the
    /// constraint-specificity ordering described in ADR-0088 §2. Returns
    /// <c>+1</c> when <paramref name="a"/> is strictly more constrained
    /// than <paramref name="b"/> (every type-parameter slot is at least as
    /// constrained on <paramref name="a"/> and at least one slot is
    /// strictly more constrained), <c>-1</c> in the symmetric case, and
    /// <c>0</c> when neither dominates. Non-generic candidates and
    /// arity-mismatched pairs always tie — those are handled by the
    /// non-generic-over-generic phase that runs before this one.
    /// </summary>
    /// <param name="a">The first candidate.</param>
    /// <param name="b">The second candidate.</param>
    /// <returns>+1, -1, or 0 per the description above.</returns>
    private static int CompareConstraintSpecificity(MethodBase a, MethodBase b)
    {
        if (a is not MethodInfo ma || b is not MethodInfo mb)
        {
            return 0;
        }

        if (!ma.IsGenericMethod || !mb.IsGenericMethod)
        {
            return 0;
        }

        MethodInfo aOpen, bOpen;
        try
        {
            aOpen = ma.IsGenericMethodDefinition ? ma : ma.GetGenericMethodDefinition();
            bOpen = mb.IsGenericMethodDefinition ? mb : mb.GetGenericMethodDefinition();
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex))
        {
            return 0;
        }

        Type[] aParams, bParams;
        try
        {
            aParams = aOpen.GetGenericArguments();
            bParams = bOpen.GetGenericArguments();
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex))
        {
            return 0;
        }

        if (aParams.Length != bParams.Length)
        {
            return 0;
        }

        var aMore = false;
        var bMore = false;
        for (var i = 0; i < aParams.Length; i++)
        {
            int s1;
            int s2;
            try
            {
                s1 = ConstraintSpecificityScore(aParams[i].GenericParameterAttributes);
                s2 = ConstraintSpecificityScore(bParams[i].GenericParameterAttributes);
            }
            catch (Exception ex) when (IsMetadataLoadFailure(ex))
            {
                return 0;
            }

            if (s1 > s2)
            {
                aMore = true;
            }
            else if (s2 > s1)
            {
                bMore = true;
            }
        }

        if (aMore && !bMore)
        {
            return 1;
        }

        if (bMore && !aMore)
        {
            return -1;
        }

        return 0;
    }

    private static string FormatTypeName(Type type)
    {
        if (type is null)
        {
            return "<null>";
        }

        if (type.IsByRef)
        {
            return "ref " + FormatTypeName(type.GetElementType());
        }

        if (type.IsArray)
        {
            return FormatTypeName(type.GetElementType()) + "[]";
        }

        if (type.IsGenericParameter)
        {
            return type.Name;
        }

        if (type.IsGenericType)
        {
            var def = type.GetGenericTypeDefinition();
            var defName = def.Name;
            var tickIndex = defName.IndexOf('`');
            if (tickIndex >= 0)
            {
                defName = defName.Substring(0, tickIndex);
            }

            var args = type.GetGenericArguments();
            var sb = new System.Text.StringBuilder();
            sb.Append(defName);
            sb.Append('[');
            for (var i = 0; i < args.Length; i++)
            {
                if (i > 0)
                {
                    sb.Append(", ");
                }

                sb.Append(FormatTypeName(args[i]));
            }

            sb.Append(']');
            return sb.ToString();
        }

        return type.Name;
    }

    private static bool IsNumericWidening(Type source, Type target)
    {
        if (source.FullName is { } sn && target.FullName is { } tn
            && NumericWideningTargets.TryGetValue(sn, out var targets))
        {
            foreach (var t in targets)
            {
                if (string.Equals(t, tn, StringComparison.Ordinal))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static bool IsNullableWrap(Type source, Type target)
    {
        if (!NullableLifting.IsValueTypeNullableClr(target))
        {
            return false;
        }

        var underlying = target.GetGenericArguments()[0];
        return ClrTypeUtilities.AreSame(underlying, source);
    }

    private static bool UnifyForInference(Type parameterType, Type argumentType, Dictionary<string, Type> bounds)
    {
        if (parameterType is null || argumentType is null)
        {
            return true;
        }

        if (parameterType.IsGenericParameter)
        {
            if (bounds.TryGetValue(parameterType.Name, out var existing))
            {
                if (ClrTypeUtilities.AreSame(existing, argumentType))
                {
                    return true;
                }

                // Issue #661: when one bound is T and the other is Nullable<T>
                // (where T is any value type, including enums), promote to
                // Nullable<T> — mirroring C#'s inference rule that picks the
                // nullable form when both T and T? are lower bounds.
                if (NullableLifting.IsValueTypeNullableClr(argumentType))
                {
                    var underlying = argumentType.GetGenericArguments()[0];
                    if (ClrTypeUtilities.AreSame(underlying, existing))
                    {
                        bounds[parameterType.Name] = argumentType;
                        return true;
                    }
                }

                if (NullableLifting.IsValueTypeNullableClr(existing))
                {
                    var underlying = existing.GetGenericArguments()[0];
                    if (ClrTypeUtilities.AreSame(underlying, argumentType))
                    {
                        // existing is already Nullable<T>; keep it.
                        return true;
                    }
                }

                // Promote toward the common base: keep the more general type
                // when one is assignable from the other. Otherwise the bounds
                // genuinely conflict and inference fails.
                try
                {
                    if (existing.IsAssignableFrom(argumentType))
                    {
                        return true;
                    }

                    if (argumentType.IsAssignableFrom(existing))
                    {
                        bounds[parameterType.Name] = argumentType;
                        return true;
                    }
                }
                catch (InvalidOperationException)
                {
                    // MLC cross-context: treat as inconclusive.
                    return false;
                }

                return false;
            }

            bounds[parameterType.Name] = argumentType;
            return true;
        }

        if (parameterType.IsArray)
        {
            if (argumentType.IsArray)
            {
                UnifyForInference(parameterType.GetElementType(), argumentType.GetElementType(), bounds);
            }

            // If the argument isn't an array, the classifier will reject the
            // candidate later; inference itself doesn't fail.
            return true;
        }

        if (parameterType.IsByRef)
        {
            return UnifyForInference(parameterType.GetElementType(), argumentType, bounds);
        }

        if (parameterType.IsGenericType && !parameterType.IsGenericTypeDefinition)
        {
            var openDef = parameterType.GetGenericTypeDefinition();
            var paramArgs = parameterType.GetGenericArguments();

            // Find the argument type (or any of its base types or interfaces)
            // matching the parameter's open generic definition. Walk class
            // hierarchy first, then interfaces.
            var matched = FindClosedGeneric(argumentType, openDef);
            if (matched != null)
            {
                var matchedArgs = matched.GetGenericArguments();
                for (var i = 0; i < paramArgs.Length && i < matchedArgs.Length; i++)
                {
                    if (!UnifyForInference(paramArgs[i], matchedArgs[i], bounds))
                    {
                        return false;
                    }
                }
            }

            // If no matching closed generic is found we don't fail inference
            // here — the applicability pass will reject the candidate.
            return true;
        }

        return true;
    }

    private static Type FindClosedGeneric(Type type, Type openDefinition)
    {
        if (openDefinition is null)
        {
            return null;
        }

        var openDefName = openDefinition.FullName;

        try
        {
            for (var t = type; t != null; t = t.BaseType)
            {
                if (t.IsGenericType && MatchesOpenDefinition(t.GetGenericTypeDefinition(), openDefinition, openDefName))
                {
                    return t;
                }
            }
        }
        catch (NotSupportedException)
        {
            // TypeBuilderInstantiation (cross-context constructed generics) may
            // throw on BaseType traversal; fall through to interface walk.
        }

        Type[] ifaces;
        try
        {
            ifaces = type.GetInterfaces();
        }
        catch (InvalidOperationException)
        {
            return null;
        }
        catch (NotSupportedException)
        {
            // Issue #666: TypeBuilderInstantiation (produced when
            // FunctionTypeSymbol.BuildClrType constructs a host-runtime Func<>
            // with MetadataLoadContext type arguments) throws
            // NotSupportedException from GetInterfaces(). Treat as "no match"
            // and let inference continue from other parameters.

            // Fallback: if the type itself is a closed generic whose open
            // definition matches by name, return it directly. This handles
            // Func<T,bool> / Action<T> shapes from BuildClrType.
            if (type.IsGenericType && !type.IsGenericTypeDefinition
                && MatchesOpenDefinition(type.GetGenericTypeDefinition(), openDefinition, openDefName))
            {
                return type;
            }

            return null;
        }

        foreach (var iface in ifaces)
        {
            if (iface.IsGenericType && MatchesOpenDefinition(iface.GetGenericTypeDefinition(), openDefinition, openDefName))
            {
                return iface;
            }
        }

        return null;
    }

    /// <summary>
    /// Issue #666: compares a candidate open generic type definition against
    /// <paramref name="openDefinition"/>. Uses <see cref="object.ReferenceEquals"/>
    /// first (fast path for same-context types), then falls back to
    /// <see cref="Type.FullName"/> comparison for cross-reflection-context
    /// scenarios (e.g. a host-runtime <c>Func&lt;,&gt;</c> vs a
    /// MetadataLoadContext <c>Func&lt;,&gt;</c>).
    /// </summary>
    private static bool MatchesOpenDefinition(Type candidateDefinition, Type openDefinition, string openDefName)
    {
        if (ReferenceEquals(candidateDefinition, openDefinition))
        {
            return true;
        }

        // Cross-context fallback: same FullName implies structural equivalence
        // for open generic definitions.
        return openDefName != null
            && string.Equals(candidateDefinition.FullName, openDefName, StringComparison.Ordinal);
    }

    /// <summary>
    /// Result of resolving a candidate set.
    /// </summary>
    /// <typeparam name="T">Candidate kind (<see cref="MethodInfo"/> or <see cref="ConstructorInfo"/>).</typeparam>
    public readonly struct Result<T>
        where T : MethodBase
    {
        private Result(ResolutionOutcome outcome, T best, ImmutableArray<T> ambiguous, ImmutableArray<int> parameterMapping, bool isExpanded)
        {
            Outcome = outcome;
            Best = best;
            Ambiguous = ambiguous;
            ParameterMapping = parameterMapping;
            IsExpanded = isExpanded;
        }

        /// <summary>Gets the resolution outcome.</summary>
        public ResolutionOutcome Outcome { get; }

        /// <summary>Gets the unique best candidate when <see cref="Outcome"/> is <see cref="ResolutionOutcome.Resolved"/>; otherwise <see langword="null"/>.</summary>
        public T Best { get; }

        /// <summary>Gets the candidates participating in an ambiguity, in source-encounter order.</summary>
        public ImmutableArray<T> Ambiguous { get; }

        /// <summary>
        /// Gets the per-source-argument → parameter-position mapping (issue
        /// #343) when the call site supplied named arguments.
        /// <see cref="ImmutableArray{Int32}.IsDefault"/> is <see langword="true"/>
        /// when no reordering took place (positional-only call), in which case
        /// the identity mapping is implied.
        /// </summary>
        public ImmutableArray<int> ParameterMapping { get; }

        /// <summary>
        /// Gets a value indicating whether issue #506: the resolved candidate
        /// was selected in <em>expanded</em> form, i.e. the trailing
        /// <c>params T[]</c> parameter packs zero or more positional arguments
        /// from the call site into a synthesised <c>T[]</c>. Callers must
        /// repack the trailing arguments into a slice/array creation before
        /// emit. Always <see langword="false"/> when <see cref="Outcome"/> is
        /// not <see cref="ResolutionOutcome.Resolved"/>.
        /// </summary>
        public bool IsExpanded { get; }

        internal static Result<T> NoneApplicable() => new(ResolutionOutcome.NoneApplicable, default, ImmutableArray<T>.Empty, default, false);

        internal static Result<T> Single(T best) => new(ResolutionOutcome.Resolved, best, ImmutableArray<T>.Empty, default, false);

        internal static Result<T> Single(T best, ImmutableArray<int> parameterMapping) => new(ResolutionOutcome.Resolved, best, ImmutableArray<T>.Empty, parameterMapping, false);

        internal static Result<T> Single(T best, ImmutableArray<int> parameterMapping, bool isExpanded) => new(ResolutionOutcome.Resolved, best, ImmutableArray<T>.Empty, parameterMapping, isExpanded);

        internal static Result<T> AmbiguousResult(ImmutableArray<T> tied) => new(ResolutionOutcome.Ambiguous, default, tied, default, false);
    }

    /// <summary>
    /// Issue #977: private marker type whose <see cref="Type"/> identity is used as
    /// the <see cref="InlineOutVarArgumentType"/> sentinel for inline <c>out var</c>
    /// arguments during overload resolution. Never instantiated.
    /// </summary>
    private sealed class InlineOutVarArgumentMarker
    {
    }
}
