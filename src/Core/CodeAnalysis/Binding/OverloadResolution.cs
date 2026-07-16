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

        /// <summary>
        /// ADR-0148 structural projection. Ranked worse than every nominal,
        /// built-in, and user-defined implicit conversion.
        /// </summary>
        StructuralProjection = 14,
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
    /// Issue #2172: the shape of an OPEN generic delegate parameter's return
    /// type, used to prefer <c>Func&lt;Task&lt;TResult&gt;&gt;</c> over
    /// <c>Func&lt;TResult&gt;</c> for a task-returning lambda argument.
    /// </summary>
    private enum TaskLambdaDelegateShape
    {
        /// <summary>Neither a bare type parameter nor a Task-shaped return.</summary>
        Other,

        /// <summary>The delegate return type is a bare method type parameter (<c>Func&lt;TResult&gt;</c>).</summary>
        BareTypeParameter,

        /// <summary>The delegate return type is <c>Task</c>/<c>Task&lt;...&gt;</c> (<c>Func&lt;Task&lt;TResult&gt;&gt;</c>).</summary>
        TaskShaped,
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
    /// Issue #1391: sentinel argument type representing the untyped <c>default</c>
    /// literal whose concrete type is supplied by the chosen parameter. The bare
    /// <c>default</c> is implicitly convertible to <em>any</em> type (its value is
    /// the zero/null of whatever parameter type it lands on), so during overload
    /// resolution against an imported (CLR) method it must classify as applicable
    /// to every (non-by-ref) parameter — mirroring the user-defined generic method
    /// path, which already accepts <c>default</c>. Using a dedicated marker keeps
    /// the literal neutral during betterness ranking (always an identity
    /// conversion) while the concrete-typed default is materialized by
    /// <c>BindClrParameterConversions</c> against the resolved parameter type.
    /// </summary>
#pragma warning disable SA1201 // Elements should appear in the correct order
    public static readonly Type DefaultLiteralArgumentType = typeof(DefaultLiteralArgumentMarker);
#pragma warning restore SA1201

    /// <summary>
    /// Issue #2126: reports whether <paramref name="argType"/> is a resolution
    /// sentinel — the inline <c>out var</c> placeholder
    /// (<see cref="InlineOutVarArgumentType"/>) or the untyped <c>default</c>
    /// literal (<see cref="DefaultLiteralArgumentType"/>). These are synthetic
    /// marker types defined in <c>GSharp.Core</c> that stand in for an argument
    /// whose real type is not yet known (an inline <c>out var</c>) or is supplied
    /// by the chosen parameter (a bare <c>default</c>). A sentinel must never be
    /// projected into a reference set's <see cref="MetadataLoadContext"/> — it has
    /// no name there — and must never leak into emitted IL; it is normalised to
    /// its erased <see cref="object"/> form before a generic candidate is closed
    /// (see the projection loop in <c>EvaluateCandidate</c>).
    /// </summary>
    /// <param name="argType">The candidate argument/type-argument CLR type.</param>
    /// <returns><see langword="true"/> when the type is a resolution sentinel.</returns>
    public static bool IsResolutionSentinel(Type argType) =>
        ReferenceEquals(argType, InlineOutVarArgumentType) || ReferenceEquals(argType, DefaultLiteralArgumentType);

    // Issue #658 / #1311 / #1634: the supplementary-interface and constant-
    // narrowing checks used to live here as mutable (later [ThreadStatic])
    // fields, set immediately before and nulled immediately after each
    // `Resolve<T>` call. That "install/clear around the call" pattern is not
    // reentrant: nested resolution performed *inside* the hook window (e.g.
    // `RebindInlineOutVarArguments`, lambda re-binding, or any other bind that
    // itself resolves an overload before the outer `finally` runs) clears the
    // outer call's hook out from under it, and — because binding also runs
    // concurrently across language-server request threads via `Task.Run` —
    // a `[ThreadStatic]` field only protects against *cross-thread* races, not
    // this same-thread reentrancy hazard. Both checks are now threaded through
    // `Resolve<T>` as ordinary parameters instead, so each call carries its own
    // context and there is no shared mutable state to race or clobber.

    /// <summary>
    /// Classifies the implicit conversion from <paramref name="source"/> to
    /// <paramref name="target"/>. Designed to work across reflection contexts
    /// (MetadataLoadContext vs. live runtime) by falling back to FullName
    /// equality.
    /// </summary>
    /// <param name="target">The target parameter type.</param>
    /// <param name="source">The argument type.</param>
    /// <param name="supplementaryInterfaceCheck">
    /// Issue #658 / #1634: optional per-call callback recognising a user-
    /// defined G# class → CLR-interface implicit reference conversion that the
    /// built-in checks below cannot see (the class's CLR type is a surrogate at
    /// bind time). Passed down from the <see cref="Resolve{T}"/> call that is
    /// evaluating this argument; <see langword="null"/> when the call has no
    /// user-class arguments.
    /// </param>
    /// <returns>The conversion classification.</returns>
    public static ImplicitConversionKind ClassifyImplicit(Type target, Type source, Func<Type, Type, bool> supplementaryInterfaceCheck = null)
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

        // Issue #1391: the untyped `default` literal is implicitly convertible to
        // any (non-by-ref) parameter type — its value is the zero/null of whatever
        // type it lands on. Classify it as an identity conversion so an imported
        // generic method invoked with an explicit type argument (e.g.
        // `Task.FromResult[int32](default)`) stays applicable; the concrete-typed
        // default is materialized against the resolved parameter after selection.
        if (ReferenceEquals(source, DefaultLiteralArgumentType))
        {
            return target.IsByRef ? ImplicitConversionKind.None : ImplicitConversionKind.Identity;
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

        if (target.IsPointer && source.IsPointer
            && string.Equals(target.GetElementType()?.FullName, "System.Void", StringComparison.Ordinal))
        {
            return ImplicitConversionKind.Reference;
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
        if (supplementaryInterfaceCheck != null && target.IsInterface && supplementaryInterfaceCheck(source, target))
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

        // Issue #2142: a lambda/arrow literal (natural CLR type Func<…>/Action<…>)
        // converts to an expression-tree parameter Expression<TDelegate> when its
        // TDelegate is structurally compatible with the source delegate. The
        // conversion is ranked identically to the underlying delegate conversion
        // (so a competing plain-delegate overload is decided purely on parameter
        // specificity, as in C#: e.g. Queryable.Where over Enumerable.Where for an
        // IQueryable receiver).
        if (TryClassifyLambdaToExpressionTree(target, source, supplementaryInterfaceCheck, out var expressionTreeKind))
        {
            return expressionTreeKind;
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
    /// <param name="recoverTypeArgSymbols">
    /// Issue #1325: optional callback that, given the closed candidate method,
    /// returns its recovered symbolic type-argument vector (open-arity order).
    /// Used so the generic value-type/struct constraint check can see through
    /// the <c>object</c> erasure of same-compilation user value types. When
    /// <see langword="null"/>, the constraint check relies solely on the CLR
    /// type arguments (prior behaviour).
    /// </param>
    /// <param name="supplementaryInterfaceCheck">
    /// Issue #658 / #1634: optional per-call user-class → CLR-interface
    /// applicability hook forwarded to <see cref="ClassifyImplicit"/> while
    /// evaluating this call's candidates. Threaded as a parameter (rather than
    /// a shared mutable static) so concurrent and nested resolutions never
    /// observe another call's hook.
    /// </param>
    /// <param name="constantNarrowingArgumentCheck">
    /// Issue #1311 / #1634: optional per-call constant-narrowing applicability
    /// hook forwarded to <see cref="EvaluateCandidate{T}"/> while evaluating
    /// this call's candidates. Threaded as a parameter for the same reentrancy/
    /// concurrency reason as <paramref name="supplementaryInterfaceCheck"/>.
    /// </param>
    /// <param name="structuralProjectionArgumentCheck">
    /// Optional binder callback that recognizes an argument's symbolic object
    /// shape as projectable to a candidate CLR parameter type.
    /// </param>
    public static Result<T> Resolve<T>(IEnumerable<T> candidates, IReadOnlyList<Type> argTypes, IReadOnlyList<Type> explicitTypeArgs = null, Func<Type, Type> projectTypeArgument = null, IReadOnlyList<bool> interpolatedStringArgs = null, IReadOnlyList<string> argumentNames = null, Func<MethodInfo, ImmutableArray<TypeSymbol>> recoverTypeArgSymbols = null, Func<Type, Type, bool> supplementaryInterfaceCheck = null, Func<int, Type, bool> constantNarrowingArgumentCheck = null, Func<int, Type, bool> structuralProjectionArgumentCheck = null)
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
                EvaluateCandidate(rawCandidate, argTypes, explicitTypeArgs, projectTypeArgument, applicable, interpolatedStringArgs, argumentNames, recoverTypeArgSymbols, supplementaryInterfaceCheck, constantNarrowingArgumentCheck, structuralProjectionArgumentCheck);
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
                    EvaluateExpandedParamsCandidate(rawCandidate, argTypes, explicitTypeArgs, projectTypeArgument, applicable, argumentNames, recoverTypeArgSymbols, supplementaryInterfaceCheck, constantNarrowingArgumentCheck, structuralProjectionArgumentCheck);
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
    /// Issue #2347: returns <see langword="true"/> when <paramref name="argument"/>
    /// is a method-group reference (either a same-compilation user-function
    /// group or an imported/CLR one) that has not yet been resolved to a single
    /// concrete method — i.e. its shape depends entirely on the eventual target
    /// delegate signature, which is not known until overload resolution (and any
    /// generic type-argument inference) has picked a candidate. Such an argument
    /// carries <see cref="TypeSymbol.Error"/> as its natural type. Recognising
    /// this shape lets every CLR call-binding path (constructors, static/instance
    /// methods, extension methods, constrained interface/object-member calls)
    /// defer it the same way an untyped arrow lambda is deferred — contributing
    /// no CLR type to the argument-type vector fed to <see cref="Resolve{T}"/>
    /// (so generic inference and applicability fall back to the other
    /// arguments) — and then resolving it against the winning candidate's actual
    /// parameter type afterwards via <c>ConversionClassifier.BindConversion</c>.
    /// This is what makes a bare method group (e.g. <c>Char.IsAsciiHexDigit</c>)
    /// behave like the equivalent lambda when passed to an imported generic
    /// extension method (e.g. <c>Enumerable.All&lt;TSource&gt;</c>), instead of
    /// only working for same-compilation generic functions.
    /// </summary>
    /// <param name="argument">The bound argument expression to inspect.</param>
    /// <returns><see langword="true"/> when the argument is an unresolved method group.</returns>
    public static bool IsUnresolvedMethodGroupArgument(BoundExpression argument) =>
        argument is BoundMethodGroupExpression { FunctionType: null }
            || argument is BoundClrMethodGroupExpression { ResolvedMethod: null };

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
    /// Issue #1599: determines whether the parameter at <paramref name="parameterIndex"/>
    /// of a closed generic method's open definition is typed by exactly one of the
    /// method's own type parameters — including through a by-ref (<c>out</c>/<c>ref</c>)
    /// wrapper, e.g. the <c>out TEnum</c> parameter of
    /// <c>bool TryParse&lt;TEnum&gt;(string, out TEnum)</c>. When it does, the caller can
    /// recover the real parameter (pointee) type from the explicit type-argument symbol
    /// at the reported position, which is necessary when the method was closed over a
    /// value-type placeholder (or an <see cref="object"/> erasure) because the type
    /// argument is a same-compilation user value type with no reference-context CLR type.
    /// This is the parameter analogue of
    /// <see cref="TryGetGenericMethodParameterReturnPosition(MethodInfo, out int)"/> and
    /// is what lets an inline <c>out var</c> declaration recover the correct pointee type
    /// instead of leaking the placeholder.
    /// </summary>
    /// <param name="closed">The closed generic method.</param>
    /// <param name="parameterIndex">The zero-based parameter position to inspect.</param>
    /// <param name="position">The method type-parameter position of the parameter, when matched.</param>
    /// <returns><see langword="true"/> when the parameter (pointee) is a bare method type parameter.</returns>
    public static bool TryGetGenericMethodParameterPosition(MethodInfo closed, int parameterIndex, out int position)
    {
        position = -1;
        if (closed == null || !closed.IsGenericMethod || parameterIndex < 0)
        {
            return false;
        }

        var open = closed.IsGenericMethodDefinition ? closed : closed.GetGenericMethodDefinition();
        var parameters = open.GetParameters();
        if (parameterIndex >= parameters.Length)
        {
            return false;
        }

        var paramType = parameters[parameterIndex].ParameterType;
        var pointee = paramType != null && paramType.IsByRef ? paramType.GetElementType() : paramType;
        if (pointee != null && pointee.IsGenericParameter && pointee.DeclaringMethod != null)
        {
            position = pointee.GenericParameterPosition;
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #2146: implements the C# §7.5.3.4 "better conversion target" rule
    /// for reference-type targets, mirroring <see cref="CompareNumericTargets"/>.
    /// Returns a negative value when <paramref name="t1"/> is the better
    /// (more-derived) target, positive when <paramref name="t2"/> is, and 0 when
    /// the two targets are unrelated (neither implicitly converts to the other),
    /// preserving genuine ambiguity. Convertibility is probed one-directionally
    /// via <see cref="ClassifyImplicit"/> so user classes, interfaces, and
    /// imported/BCL reference types are handled uniformly.
    /// </summary>
    /// <param name="t1">The first candidate target type.</param>
    /// <param name="t2">The second candidate target type.</param>
    /// <returns>-1, 0, or +1 per the description above.</returns>
    public static int CompareReferenceTargets(Type t1, Type t2)
    {
        if (t1 is null || t2 is null || ClrTypeUtilities.AreSame(t1, t2))
        {
            return 0;
        }

        // T1 is a better target than T2 when an implicit conversion T1->T2
        // exists (T1 is more derived) and none exists T2->T1.
        var t1ToT2 = ClassifyImplicit(t2, t1) is not ImplicitConversionKind.None and not ImplicitConversionKind.Identity;
        var t2ToT1 = ClassifyImplicit(t1, t2) is not ImplicitConversionKind.None and not ImplicitConversionKind.Identity;

        if (t1ToT2 && !t2ToT1)
        {
            return -1;
        }

        if (t2ToT1 && !t1ToT2)
        {
            return 1;
        }

        return 0;
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

                // Issue #2375: mirror UnifyForInference's #2142 unwrap — a
                // deferred lambda slot whose delegate parameter is
                // `Expression<TDelegate>` (e.g. `HasOne<TRelated>(Expression<Func<TEntity, TRelated>>)`)
                // has no `Invoke` method of its own; unwrap to `TDelegate`
                // first so this closes the lambda's parameter types instead
                // of unconditionally bailing out for every expression-tree
                // deferred lambda parameter.
                if (delegateType.IsGenericType
                    && !delegateType.IsGenericTypeDefinition
                    && string.Equals(delegateType.GetGenericTypeDefinition().FullName, "System.Linq.Expressions.Expression`1", StringComparison.Ordinal))
                {
                    var expressionArgs = delegateType.GetGenericArguments();
                    if (expressionArgs.Length != 1)
                    {
                        return false;
                    }

                    delegateType = expressionArgs[0];
                }

                invoke = delegateType.GetMethodSafe("Invoke");
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
    /// Issue #1833: identifies a generic candidate whose only structural
    /// mismatch is a value-type-erased type argument (a same-compilation user
    /// struct/enum, or a struct-constrained type parameter) that fails to
    /// satisfy an explicit CLR base-class constraint — e.g. a concrete
    /// non-enum struct, or a plain <c>[T struct]</c> type parameter, forwarded
    /// to <c>Enum.TryParse[TEnum]</c>'s <c>where TEnum : Enum</c> bound. This
    /// distinguishes that specific "binds through overload resolution but only
    /// fails CLR verification" hole from every other reason a candidate can be
    /// inapplicable (arity mismatch, wrong argument types, an unconstrained type
    /// parameter, ...), which must keep surfacing the generic "cannot find
    /// function" diagnostic exactly as it did before <c>#1833</c>.
    /// </summary>
    /// <param name="openMethod">The open generic method definition considered as a candidate.</param>
    /// <param name="typeArgs">The CLR type arguments (with user value types erased).</param>
    /// <param name="typeArgSymbols">The recovered symbolic type-argument vector.</param>
    /// <param name="typeParameterName">On success, the violated type parameter's name.</param>
    /// <param name="typeArgument">On success, the offending type-argument symbol.</param>
    /// <param name="constraintDescription">On success, a human-readable description of the violated constraint.</param>
    /// <returns><see langword="true"/> when a base-constraint violation of this specific shape was found.</returns>
    internal static bool TryDescribeValueTypeBaseConstraintViolation(
        MethodInfo openMethod,
        Type[] typeArgs,
        ImmutableArray<TypeSymbol> typeArgSymbols,
        out string typeParameterName,
        out TypeSymbol typeArgument,
        out string constraintDescription)
    {
        typeParameterName = null;
        typeArgument = null;
        constraintDescription = null;

        if (openMethod is null || typeArgs is null || typeArgSymbols.IsDefaultOrEmpty)
        {
            return false;
        }

        Type[] typeParams;
        try
        {
            typeParams = openMethod.GetGenericArguments();
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex))
        {
            return false;
        }

        if (typeParams.Length != typeArgs.Length || typeParams.Length != typeArgSymbols.Length)
        {
            return false;
        }

        for (var i = 0; i < typeParams.Length; i++)
        {
            var arg = typeArgs[i];
            if (arg is null || arg.IsGenericParameter || !IsValueTypeErasedSymbol(typeArgSymbols[i]))
            {
                continue;
            }

            var param = typeParams[i];
            Type[] typeConstraints;
            try
            {
                typeConstraints = param.GetGenericParameterConstraints();
            }
            catch (Exception ex) when (IsMetadataLoadFailure(ex))
            {
                continue;
            }

            foreach (var constraint in typeConstraints)
            {
                if (constraint is null
                    || constraint.IsInterface
                    || constraint.IsGenericParameter
                    || constraint.ContainsGenericParameters)
                {
                    continue;
                }

                if (!ValueTypeErasedSymbolSatisfiesBaseConstraint(typeArgSymbols[i], constraint))
                {
                    typeParameterName = param.Name;
                    typeArgument = typeArgSymbols[i];
                    constraintDescription = constraint.FullName ?? constraint.Name;
                    return true;
                }
            }
        }

        return false;
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

            if (type.IsPointer)
            {
                if (!TryCloseInferredType(type.GetElementType(), bounds, out var elem))
                {
                    return false;
                }

                closed = elem.MakePointerType();
                return true;
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
            targetInvoke = target.GetMethodSafe("Invoke");
            sourceInvoke = source.GetMethodSafe("Invoke");
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
    /// Issue #2142: determines whether a source delegate (a lambda/arrow
    /// literal's natural <c>Func&lt;...&gt;</c>/<c>Action&lt;...&gt;</c> type, or
    /// any delegate value) converts to an expression-tree parameter
    /// <c>System.Linq.Expressions.Expression&lt;TDelegate&gt;</c>. Mirrors the
    /// symbolic-path helper <c>MemberLookup.TryGetExpressionTreeDelegateType</c>:
    /// the target must be a closed <c>Expression`1</c> whose single type argument
    /// (<c>TDelegate</c>) is a delegate type, and the source must be a delegate
    /// that is <em>compatible</em> with <c>TDelegate</c> — identity, a
    /// structural delegate match, or reference/covariant/numeric-widening return
    /// adaptation (the same conversions the resolver already accepts between two
    /// plain delegate types). A genuine signature mismatch (different arity or
    /// incompatible parameter/return types) yields <see langword="false"/> so the
    /// candidate is still dropped, preserving overload-resolution rejection of a
    /// truly non-matching lambda. The <c>TDelegate</c> must be fully closed (no
    /// open generic parameters); open candidates are closed by
    /// <see cref="EvaluateCandidate"/> before applicability runs, so this holds at
    /// every real call site.
    /// </summary>
    /// <param name="target">The candidate parameter type.</param>
    /// <param name="source">The argument's natural delegate type.</param>
    /// <param name="supplementaryInterfaceCheck">Optional user-class interface hook, threaded through the recursive inner-delegate classification.</param>
    /// <param name="kind">On success, the underlying delegate conversion kind (identity or a delegate adaptation) so the expression-tree conversion ranks identically to the plain-delegate conversion.</param>
    /// <returns><see langword="true"/> when the lambda-to-expression-tree conversion applies.</returns>
    private static bool TryClassifyLambdaToExpressionTree(Type target, Type source, Func<Type, Type, bool> supplementaryInterfaceCheck, out ImplicitConversionKind kind)
    {
        kind = ImplicitConversionKind.None;

        if (source is null || !ClrTypeUtilities.IsDelegateType(source))
        {
            return false;
        }

        if (target is null
            || !target.IsGenericType
            || target.ContainsGenericParameters)
        {
            return false;
        }

        var openDefinition = target.GetGenericTypeDefinition();
        if (!string.Equals(openDefinition.FullName, "System.Linq.Expressions.Expression`1", StringComparison.Ordinal))
        {
            return false;
        }

        var typeArguments = target.GetGenericArguments();
        if (typeArguments.Length != 1)
        {
            return false;
        }

        var targetDelegate = typeArguments[0];
        if (targetDelegate is null || !ClrTypeUtilities.IsDelegateType(targetDelegate))
        {
            return false;
        }

        // A lambda converts to Expression<TDelegate> when its natural delegate
        // shape is compatible with TDelegate. Accept an exact/adaptable delegate
        // match (identity or one of the delegate adaptations the resolver already
        // recognises between two plain delegates), OR — mirroring C#'s lambda
        // conversion — a signature whose parameter types match and whose body
        // (source return) is implicitly convertible to TDelegate's return type,
        // including value-type→object boxing (e.g. `(e) -> e.Id` [int32] into
        // `Expression<Func<T, object?>>`). A genuine parameter/arity mismatch, or
        // a return that does not convert, yields false so the candidate is still
        // dropped.
        var inner = ClassifyImplicit(targetDelegate, source, supplementaryInterfaceCheck);
        switch (inner)
        {
            case ImplicitConversionKind.Identity:
            case ImplicitConversionKind.DelegateStructuralMatch:
            case ImplicitConversionKind.DelegateReturnCovariance:
            case ImplicitConversionKind.DelegateReturnNumericWidening:
                kind = inner;
                return true;
        }

        if (IsLambdaBodyConvertibleToDelegate(targetDelegate, source, supplementaryInterfaceCheck))
        {
            kind = ImplicitConversionKind.DelegateReturnCovariance;
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #2142: determines whether a source delegate's signature is
    /// compatible with a target delegate under a lambda conversion — the
    /// parameter types are pairwise identical and the source's return type is
    /// implicitly convertible (identity, reference, boxing, numeric widening,
    /// nullable-wrap, or user-defined) to the target's return type. This is the
    /// delegate-return counterpart of a lambda-body conversion and is used only
    /// when unwrapping an <c>Expression&lt;TDelegate&gt;</c> target, so a lambda
    /// whose body converts to <c>TDelegate</c>'s return (e.g. an <c>int32</c>
    /// body boxing into an <c>object?</c> return) still binds the expression
    /// tree. A <c>void</c> return on either side, a parameter mismatch, or a
    /// non-convertible return yields <see langword="false"/>.
    /// </summary>
    private static bool IsLambdaBodyConvertibleToDelegate(Type targetDelegate, Type source, Func<Type, Type, bool> supplementaryInterfaceCheck)
    {
        if (!TryGetDelegateSignature(targetDelegate, out var targetParams, out var targetReturn)
            || !TryGetDelegateSignature(source, out var sourceParams, out var sourceReturn)
            || targetReturn is null
            || sourceReturn is null
            || targetParams.Length != sourceParams.Length)
        {
            return false;
        }

        // A void return has no body value to convert; the identity / structural
        // delegate paths already handle exact void-return matches.
        if (string.Equals(targetReturn.FullName, "System.Void", StringComparison.Ordinal)
            || string.Equals(sourceReturn.FullName, "System.Void", StringComparison.Ordinal))
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

        var returnConversion = ClassifyImplicit(targetReturn, sourceReturn, supplementaryInterfaceCheck);
        return returnConversion != ImplicitConversionKind.None;
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
            var invoke = delegateType.GetMethodSafe("Invoke");
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
            var defInvoke = definition.GetMethodSafe("Invoke");
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
    /// applies. Factored out of <see cref="Resolve{T}"/>
    /// so the per-candidate work can be guarded against reflection load
    /// failures (issue #321) without disturbing the surrounding control flow.
    /// </summary>
    private static void EvaluateCandidate<T>(T rawCandidate, IReadOnlyList<Type> argTypes, IReadOnlyList<Type> explicitTypeArgs, Func<Type, Type> projectTypeArgument, List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)> applicable, IReadOnlyList<bool> interpolatedStringArgs = null, IReadOnlyList<string> argumentNames = null, Func<MethodInfo, ImmutableArray<TypeSymbol>> recoverTypeArgSymbols = null, Func<Type, Type, bool> supplementaryInterfaceCheck = null, Func<int, Type, bool> constantNarrowingArgumentCheck = null, Func<int, Type, bool> structuralProjectionArgumentCheck = null)
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

            // Issue #1325: when a candidate must be closed over a
            // same-compilation user value type — erased to a `System.Object`
            // placeholder — live-reflection `MakeGenericMethod` rejects the
            // `object` argument against a `where T : struct` parameter (unlike
            // the MetadataLoadContext overload, which never validates). The
            // fallback below closes the method over a value-type placeholder so
            // a valid closed `MethodInfo` is obtained, and rewrites the closed
            // parameter types back to the `object`-erased shape so applicability
            // still matches the `object`-erased argument types. Emit uses the
            // recovered symbolic type arguments, so the placeholder never leaks
            // into the produced IL.
            Func<Type, Type> paramTypeRewrite = null;
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
                    var explicitTypeArgsArray = explicitTypeArgs.ToArray();
                    try
                    {
                        closed = gmi.MakeGenericMethod(explicitTypeArgsArray);
                    }
                    catch (ArgumentException)
                    {
                        // Issue #1325: live reflection rejects the `object`
                        // erasure of a user value type against a `struct`
                        // constraint. Retry over a value-type placeholder when
                        // the recovered symbols satisfy the real constraints.
                        if (!TryCloseOverUserValueTypePlaceholders(gmi, explicitTypeArgsArray, recoverTypeArgSymbols?.Invoke(gmi) ?? default, out closed))
                        {
                            // Generic constraints not satisfied — drop this candidate.
                            return;
                        }

                        paramTypeRewrite = static t => SubstituteClrType(t, typeof(UserValueTypeConstraintPlaceholder), typeof(object));
                    }

                    // Issue #750 / ADR-0088: same constraint check as the
                    // inference path. Required because MetadataLoadContext's
                    // MakeGenericMethod does not validate constraints.
                    if (!SatisfiesGenericConstraints(gmi, explicitTypeArgsArray, recoverTypeArgSymbols?.Invoke(closed) ?? default))
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
                        // Issue #2126: a resolution sentinel (the inline `out var`
                        // placeholder — issue #977/#1599/#1601 — or the untyped
                        // `default` literal — issue #1391) was bound to this type
                        // parameter because the corresponding argument's real type
                        // is a same-compilation value type with no reference-context
                        // CLR type (so it is erased to `object` everywhere else).
                        // The sentinel is a GSharp.Core marker with no name in the
                        // reference set: projecting it threw and surfaced as a fatal
                        // GS9998 ICE during emit. Normalise it to its erased `object`
                        // form (projected into the candidate's context) — the same
                        // erasure the argument types already carry — so the generic
                        // candidate closes via the issue #1325 value-type-placeholder
                        // path and emit uses the recovered symbolic type argument.
                        typeArgs[t] = IsResolutionSentinel(typeArgs[t])
                            ? (projectTypeArgument(typeof(object)) ?? typeof(object))
                            : (projectTypeArgument(typeArgs[t]) ?? typeArgs[t]);
                    }
                }

                MethodInfo closed;
                try
                {
                    closed = mi.MakeGenericMethod(typeArgs);
                }
                catch (ArgumentException)
                {
                    // Issue #1325: live reflection rejects the `object` erasure
                    // of a user value type against a `struct` constraint. Retry
                    // over a value-type placeholder when the recovered symbols
                    // satisfy the real constraints.
                    if (!TryCloseOverUserValueTypePlaceholders(mi, typeArgs, recoverTypeArgSymbols?.Invoke(mi) ?? default, out closed))
                    {
                        // Generic constraints not satisfied — drop this candidate.
                        return;
                    }

                    paramTypeRewrite = static t => SubstituteClrType(t, typeof(UserValueTypeConstraintPlaceholder), typeof(object));
                }

                // Issue #750 / ADR-0088: explicitly validate generic-parameter
                // constraints against the inferred type arguments. The runtime
                // overload of MakeGenericMethod throws on constraint violation,
                // but the MetadataLoadContext overload silently accepts any
                // closure — without this check, a `where T : class` candidate
                // bound with T = Nullable<int> survives applicability and the
                // resolver picks the wrong overload, emitting IL that fails
                // verification at runtime.
                if (!SatisfiesGenericConstraints(mi, typeArgs, recoverTypeArgSymbols?.Invoke(closed) ?? default))
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
                paramTypes[i] = paramTypeRewrite != null
                    ? paramTypeRewrite(parameters[paramIndex].ParameterType)
                    : parameters[paramIndex].ParameterType;
                var conv = ClassifyImplicit(paramTypes[i], argTypes[i], supplementaryInterfaceCheck);
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
                    else if (constantNarrowingArgumentCheck != null
                        && constantNarrowingArgumentCheck(i, paramTypes[i]))
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
                    else if (structuralProjectionArgumentCheck != null
                        && structuralProjectionArgumentCheck(i, paramTypes[i]))
                    {
                        conv = ImplicitConversionKind.StructuralProjection;
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
    private static void EvaluateExpandedParamsCandidate<T>(T rawCandidate, IReadOnlyList<Type> argTypes, IReadOnlyList<Type> explicitTypeArgs, Func<Type, Type> projectTypeArgument, List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)> applicable, IReadOnlyList<string> argumentNames = null, Func<MethodInfo, ImmutableArray<TypeSymbol>> recoverTypeArgSymbols = null, Func<Type, Type, bool> supplementaryInterfaceCheck = null, Func<int, Type, bool> constantNarrowingArgumentCheck = null, Func<int, Type, bool> structuralProjectionArgumentCheck = null)
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

                if (!SatisfiesGenericConstraints(gmi, explicitTypeArgs.ToArray(), recoverTypeArgSymbols?.Invoke(closed) ?? default))
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
                    // Issue #2126: see the primary projection loop above — a
                    // resolution sentinel must be normalised to its erased
                    // `object` form rather than projected, or it throws a fatal
                    // GS9998 ICE when projected into a MetadataLoadContext.
                    typeArgs[t] = IsResolutionSentinel(typeArgs[t])
                        ? (projectTypeArgument(typeof(object)) ?? typeof(object))
                        : (projectTypeArgument(typeArgs[t]) ?? typeArgs[t]);
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

            if (!SatisfiesGenericConstraints(mi, typeArgs, recoverTypeArgSymbols?.Invoke(closed) ?? default))
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
            var conv = ClassifyImplicit(target, argTypes[i], supplementaryInterfaceCheck);
            if (conv == ImplicitConversionKind.None)
            {
                if (structuralProjectionArgumentCheck != null
                    && structuralProjectionArgumentCheck(i, target))
                {
                    conv = ImplicitConversionKind.StructuralProjection;
                }
                else
                {
                    return;
                }
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

        // Phase 2f — issue #2172: when an argument is a task-returning lambda
        // (its natural delegate type returns Task/Task<T>), prefer the candidate
        // whose OPEN delegate parameter is shaped Func<Task<TResult>> (binding
        // the whole task to a Task-typed delegate result) over one shaped
        // Func<TResult> (binding the whole task to a bare method type parameter).
        // Both close to the same Func<Task<X>> after inference — e.g.
        // Task.Run<TResult>(Func<TResult>) with TResult = Task<X> versus
        // Task.Run<TResult>(Func<Task<TResult>>) with TResult = X — so neither
        // dominates on conversion kind and the earlier tie-breaks cannot choose.
        // This mirrors C#'s preference for the task-returning delegate overload
        // for an async/task-returning lambda argument. Generalised: it fires for
        // ANY overload set differing by Func<X> vs Func<Task<X>> at a slot whose
        // argument is a task-returning delegate, not just Task.Run.
        if (pool.Count > 1)
        {
            var preferred = PreferTaskShapedDelegateForTaskLambda(pool, argTypes);
            if (preferred.Count >= 1 && preferred.Count < pool.Count)
            {
                pool = preferred;
            }

            if (pool.Count == 1)
            {
                return Result<T>.Single(pool[0].Method, BuildMappingArray(pool[0].Mapping, argumentNames), pool[0].IsExpanded);
            }
        }

        // Phase 2g — the full NuGet transitive closure can surface the exact
        // same method more than once: e.g. `MemoryExtensions.AsSpan` reachable
        // via both `System.Memory` and a type-forwarding facade, or
        // `ConfigureAwait`/`WithCancellation`/`GetValueOrDefault` reachable via
        // multiple reference assemblies. Those duplicates are genuinely
        // interchangeable (identical declaring type, name, generic arity, and
        // parameter types), so collapse them to a single representative rather
        // than reporting a spurious ambiguity. Distinct real overloads (e.g.
        // `Ceiling(Decimal)` vs `Ceiling(Double)`) differ in parameter types
        // and are never collapsed.
        if (pool.Count > 1)
        {
            var deduped = new List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)>(pool.Count);
            foreach (var candidate in pool)
            {
                var isDuplicate = false;
                foreach (var kept in deduped)
                {
                    if (AreInterchangeableDuplicates(kept.Method, kept.ParamTypes, candidate.Method, candidate.ParamTypes))
                    {
                        isDuplicate = true;
                        break;
                    }
                }

                if (!isDuplicate)
                {
                    deduped.Add(candidate);
                }
            }

            if (deduped.Count < pool.Count)
            {
                pool = deduped;
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

    /// <summary>
    /// Determines whether two applicable candidates are the same logical method
    /// surfaced twice through the reference closure (identical declaring type,
    /// name, generic arity, and resolved parameter types). Such duplicates arise
    /// from type-forwarding facades / duplicated reference assemblies and are
    /// interchangeable, so overload resolution collapses them instead of
    /// reporting a spurious ambiguity. Cross-reflection-context type identity is
    /// compared with <see cref="ClrTypeUtilities.AreSame(Type, Type)"/>, which
    /// matches by assembly-agnostic full name.
    /// </summary>
    private static bool AreInterchangeableDuplicates(MethodBase a, Type[] aParamTypes, MethodBase b, Type[] bParamTypes)
    {
        if (a is null || b is null || aParamTypes is null || bParamTypes is null)
        {
            return false;
        }

        if (!string.Equals(a.Name, b.Name, StringComparison.Ordinal))
        {
            return false;
        }

        if (!ClrTypeUtilities.AreSame(a.DeclaringType, b.DeclaringType))
        {
            return false;
        }

        if (GetGenericArity(a) != GetGenericArity(b))
        {
            return false;
        }

        if (aParamTypes.Length != bParamTypes.Length)
        {
            return false;
        }

        for (var i = 0; i < aParamTypes.Length; i++)
        {
            if (!ClrTypeUtilities.AreSame(aParamTypes[i], bParamTypes[i]))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Returns the generic arity of a method (the number of its generic type
    /// parameters), or <c>0</c> for a non-generic method.
    /// </summary>
    private static int GetGenericArity(MethodBase method)
    {
        if (method is null || !method.IsGenericMethod)
        {
            return 0;
        }

        try
        {
            return method.GetGenericArguments().Length;
        }
        catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex))
        {
            return 0;
        }
    }

    /// <summary>
    /// Issue #2172: narrows <paramref name="pool"/> to prefer, for each argument
    /// slot whose argument is a task-returning delegate (a lambda whose natural
    /// return type is <c>Task</c>/<c>Task&lt;T&gt;</c>), the candidates whose
    /// OPEN delegate parameter at that slot is shaped <c>Func&lt;Task&lt;TResult&gt;&gt;</c>
    /// over those shaped <c>Func&lt;TResult&gt;</c>. Only narrows when the pool
    /// genuinely splits into both shapes at such a slot, so non-task-lambda calls
    /// and single-shape overload sets are unaffected. Returns the (possibly
    /// unchanged) surviving list.
    /// </summary>
    private static List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)> PreferTaskShapedDelegateForTaskLambda<T>(
        List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)> pool,
        IReadOnlyList<Type> argTypes)
        where T : MethodBase
    {
        if (argTypes == null || argTypes.Count == 0)
        {
            return pool;
        }

        var current = pool;
        for (var argIndex = 0; argIndex < argTypes.Count; argIndex++)
        {
            if (current.Count <= 1)
            {
                break;
            }

            // The argument must itself be a task-returning delegate value
            // (an async / task-returning lambda's natural Func<...> type).
            if (!IsTaskReturningDelegate(argTypes[argIndex]))
            {
                continue;
            }

            var taskShaped = new List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)>(current.Count);
            var bareTypeParam = false;
            foreach (var c in current)
            {
                switch (ClassifyOpenDelegateReturnShape(c.Method, c.Mapping, argIndex))
                {
                    case TaskLambdaDelegateShape.TaskShaped:
                        taskShaped.Add(c);
                        break;
                    case TaskLambdaDelegateShape.BareTypeParameter:
                        bareTypeParam = true;
                        break;
                    default:
                        // Neither shape — keep it eligible so an unrelated
                        // sibling overload is never silently dropped.
                        taskShaped.Add(c);
                        break;
                }
            }

            // Only narrow when the split is a genuine Func<Task<X>> vs Func<X>
            // discrimination (at least one of each) — otherwise leave the pool
            // untouched.
            if (bareTypeParam && taskShaped.Count >= 1 && taskShaped.Count < current.Count)
            {
                current = taskShaped;
            }
        }

        return current;
    }

    /// <summary>
    /// Issue #2172: classifies the OPEN (generic-definition) delegate parameter
    /// bound to argument <paramref name="argIndex"/> as either
    /// <see cref="TaskLambdaDelegateShape.TaskShaped"/> (its delegate return type
    /// is <c>Task</c>/<c>Task&lt;...&gt;</c>, i.e. <c>Func&lt;Task&lt;TResult&gt;&gt;</c>),
    /// <see cref="TaskLambdaDelegateShape.BareTypeParameter"/> (its delegate
    /// return type is a bare method type parameter, i.e. <c>Func&lt;TResult&gt;</c>),
    /// or <see cref="TaskLambdaDelegateShape.Other"/>.
    /// </summary>
    private static TaskLambdaDelegateShape ClassifyOpenDelegateReturnShape<T>(T method, int[] mapping, int argIndex)
        where T : MethodBase
    {
        var paramIndex = mapping != null && argIndex < mapping.Length ? mapping[argIndex] : argIndex;
        if (paramIndex < 0)
        {
            return TaskLambdaDelegateShape.Other;
        }

        MethodBase openMethod = method;
        if (method is MethodInfo mi && mi.IsGenericMethod && !mi.IsGenericMethodDefinition)
        {
            try
            {
                openMethod = mi.GetGenericMethodDefinition();
            }
            catch (Exception)
            {
                return TaskLambdaDelegateShape.Other;
            }
        }

        ParameterInfo[] parameters;
        try
        {
            parameters = openMethod.GetParameters();
        }
        catch (Exception)
        {
            return TaskLambdaDelegateShape.Other;
        }

        if (paramIndex >= parameters.Length)
        {
            return TaskLambdaDelegateShape.Other;
        }

        var openParamType = parameters[paramIndex].ParameterType;
        if (openParamType == null || openParamType.IsByRef)
        {
            return TaskLambdaDelegateShape.Other;
        }

        if (!TryGetDelegateSignature(openParamType, out _, out var openReturn) || openReturn == null)
        {
            return TaskLambdaDelegateShape.Other;
        }

        if (IsTaskType(openReturn))
        {
            return TaskLambdaDelegateShape.TaskShaped;
        }

        if (openReturn.IsGenericParameter)
        {
            return TaskLambdaDelegateShape.BareTypeParameter;
        }

        return TaskLambdaDelegateShape.Other;
    }

    /// <summary>
    /// Issue #2172: whether <paramref name="type"/> is a delegate type whose
    /// return type is <c>Task</c>/<c>Task&lt;T&gt;</c> (the natural type of an
    /// async / task-returning lambda argument).
    /// </summary>
    private static bool IsTaskReturningDelegate(Type type)
    {
        if (type == null || !ClrTypeUtilities.IsDelegateType(type))
        {
            return false;
        }

        return TryGetDelegateSignature(type, out _, out var returnType)
            && IsTaskType(returnType);
    }

    /// <summary>
    /// Issue #2172: whether <paramref name="type"/> is <c>System.Threading.Tasks.Task</c>
    /// or <c>Task&lt;T&gt;</c> (or the <c>ValueTask</c> equivalents), compared by
    /// name so it works across reflection contexts and for constructed types
    /// closed over open generic parameters (whose <see cref="Type.FullName"/> is
    /// <see langword="null"/>).
    /// </summary>
    private static bool IsTaskType(Type type)
    {
        if (type == null)
        {
            return false;
        }

        if (!string.Equals(type.Namespace, "System.Threading.Tasks", StringComparison.Ordinal))
        {
            return false;
        }

        var name = type.Name;
        return string.Equals(name, "Task", StringComparison.Ordinal)
            || string.Equals(name, "Task`1", StringComparison.Ordinal)
            || string.Equals(name, "ValueTask", StringComparison.Ordinal)
            || string.Equals(name, "ValueTask`1", StringComparison.Ordinal);
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

        // Issue #1311 follow-up: when the SAME constant literal adapts to two
        // candidates via constant-narrowing (e.g. `UIntPtr(16)` matching both
        // `.ctor(UInt32)` and `.ctor(UInt64)`), apply the same "better
        // conversion target" rule so the narrowest applicable integral target
        // wins (UInt32 over UInt64) instead of producing a spurious GS0160.
        // A genuinely non-orderable pair (CompareNumericTargets returns 0)
        // still surfaces as ambiguous.
        if (ka == ImplicitConversionKind.ConstantNarrowing)
        {
            return CompareNumericTargets(paramA, paramB, source);
        }

        // Issue #2146: reference "better conversion target" tie-break
        // (C# §7.5.3.4). When both candidates convert the SAME argument by a
        // non-identity implicit reference/boxing conversion to related targets
        // (e.g. Dog->object vs Dog->Animal, or Type->object vs Type->Type?),
        // prefer the MORE DERIVED target instead of tying and relying solely on
        // IsAtLeastAsSpecific: target T1 is better than T2 when an implicit
        // conversion exists from T1 to T2 but not from T2 to T1. Unrelated
        // targets stay tied (0), preserving genuine ambiguity.
        if (ka == ImplicitConversionKind.Reference || ka == ImplicitConversionKind.Boxing)
        {
            return CompareReferenceTargets(paramA, paramB);
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
    /// <param name="typeArgSymbols">
    /// Issue #1325: the recovered symbolic type-argument vector (open-arity
    /// order), or <see langword="default"/>. Lets the value-type/struct
    /// constraint checks see through the <c>object</c> erasure of
    /// same-compilation user value types.
    /// </param>
    /// <returns><see langword="true"/> when every constraint is satisfied.</returns>
    private static bool SatisfiesGenericConstraints(MethodInfo openMethod, Type[] typeArgs, ImmutableArray<TypeSymbol> typeArgSymbols = default)
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

            // Issue #1325: a same-compilation user value type (a non-class
            // `StructSymbol` or an `EnumSymbol`) is erased to a `System.Object`
            // placeholder in the CLR `typeArgs` vector because its symbol carries
            // no reference-context CLR type during binding. The recovered
            // symbolic vector lets the value-type/reference-type constraint
            // checks see through that erasure so a `where T : struct` candidate
            // (e.g. MemoryMarshal.Cast/AsBytes) is not wrongly filtered out and a
            // `where T : class` candidate is not wrongly admitted.
            // Issue #1601: a value-type-constrained generic type parameter (e.g.
            // a `TEnum` forwarded from an enclosing `[TEnum Enum struct]`) erases
            // the same way and must classify as a value type here too.
            var argIsUserValueType = !typeArgSymbols.IsDefaultOrEmpty
                && i < typeArgSymbols.Length
                && IsValueTypeErasedSymbol(typeArgSymbols[i]);

            if ((special & GenericParameterAttributes.ReferenceTypeConstraint) != 0)
            {
                // `where T : class` — arg must be a reference type (not a
                // value type, not Nullable<T>).
                if (arg.IsValueType || argIsUserValueType)
                {
                    return false;
                }
            }

            if ((special & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0)
            {
                // `where T : struct` — arg must be a non-nullable value type.
                // A user struct/enum (erased to `object`) satisfies this even
                // though `arg.IsValueType` is false for the placeholder.
                if (!argIsUserValueType
                    && (!arg.IsValueType || NullableLifting.IsValueTypeNullableClr(arg)))
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
                if (!arg.IsValueType && !argIsUserValueType)
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

                // Issue #1325: a `where T : struct` parameter carries an implicit
                // `System.ValueType` base constraint in metadata (and an enum a
                // `System.Enum` one). A same-compilation user value type is erased
                // to a `System.Object` placeholder, which is not name-assignable
                // to `ValueType`/`Enum` by the plain `IsAssignableByName` check
                // below, so a base-type (class, non-interface) constraint needs
                // the symbolic derivation check instead.
                // Issue #1833: the former version of this guard unconditionally
                // treated *every* `ValueType`/`Enum`-named constraint as satisfied
                // once `argIsUserValueType` was true — so a plain (non-enum)
                // struct, or a bare `[T struct]` type parameter with no `Enum`
                // bound, silently bound through `Enum.TryParse[T]`'s `where T :
                // Enum` constraint and only failed later at CLR verification.
                // `ValueTypeErasedSymbolSatisfiesBaseConstraint` walks the
                // recovered symbol's real derivation/constraint chain so
                // `ValueType`/`Object` are still trivially satisfied by any
                // struct/enum, but `Enum` (or any other concrete base) is only
                // satisfied by an actual enum or a type parameter that itself
                // carries that same base bound.
                if (argIsUserValueType && !constraint.IsInterface)
                {
                    if (ValueTypeErasedSymbolSatisfiesBaseConstraint(typeArgSymbols[i], constraint))
                    {
                        continue;
                    }

                    return false;
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
    /// Issue #1325: recognizes a type-argument symbol that is a same-compilation
    /// user value type — a non-class <see cref="StructSymbol"/> or an
    /// <see cref="EnumSymbol"/>. These are erased to a <c>System.Object</c>
    /// placeholder in the CLR type-argument vector, so the value-type/struct
    /// generic constraint checks need the symbol to classify them correctly. A
    /// user class (<c>StructSymbol { IsClass: true }</c>) and a nullable value
    /// type are deliberately excluded.
    /// </summary>
    /// <param name="symbol">The recovered type-argument symbol.</param>
    /// <returns><see langword="true"/> when the symbol is a user struct or enum.</returns>
    private static bool IsUserValueTypeSymbol(TypeSymbol symbol)
        => symbol is StructSymbol { IsClass: false } or EnumSymbol;

    /// <summary>
    /// Issue #1601: recognizes a type-argument symbol that has no reference-context
    /// CLR type but is guaranteed to be a non-nullable value type — either a
    /// same-compilation user value type (see <see cref="IsUserValueTypeSymbol"/>) or
    /// an in-scope generic type parameter carrying a value-type (<c>struct</c>)
    /// constraint (e.g. the <c>TEnum</c> of <c>func Parse[TEnum Enum struct]</c>
    /// forwarded to <c>Enum.TryParse[TEnum]</c>). Both erase to a <c>System.Object</c>
    /// placeholder in the CLR type-argument vector, so the value-type/struct generic
    /// constraint checks (and the placeholder closure) need the symbol to classify
    /// them correctly. Live-reflection <see cref="MethodInfo.MakeGenericMethod(Type[])"/>
    /// cannot be called with such a symbol because it is not a real runtime
    /// <see cref="Type"/>, so the closure over a value-type placeholder applies to it
    /// exactly as it does to a same-compilation user value type.
    /// </summary>
    /// <param name="symbol">The recovered type-argument symbol.</param>
    /// <returns><see langword="true"/> when the symbol erases to a value-type placeholder.</returns>
    private static bool IsValueTypeErasedSymbol(TypeSymbol symbol)
        => IsUserValueTypeSymbol(symbol)
            || symbol is TypeParameterSymbol { HasValueTypeConstraint: true };

    /// <summary>
    /// Issue #1833: determines whether a value-type-erased type-argument symbol
    /// (see <see cref="IsValueTypeErasedSymbol"/>) satisfies an explicit CLR
    /// base-class (non-interface) constraint <paramref name="constraint"/>,
    /// generalizing the former hardcoded `System.ValueType`/`System.Enum` name
    /// check into a walk of the symbol's own derivation/constraint chain.
    /// <list type="bullet">
    /// <item><description><c>System.ValueType</c> and <c>System.Object</c> are
    /// trivially satisfied by every struct/enum — every value type derives from
    /// them.</description></item>
    /// <item><description>A concrete enum (<see cref="EnumSymbol"/>) satisfies
    /// exactly <c>System.Enum</c> — no other base class is possible for an
    /// enum.</description></item>
    /// <item><description>A plain struct (<see cref="StructSymbol"/>) satisfies
    /// neither — a value type has no symbolic base beyond
    /// <c>ValueType</c>/<c>Object</c> under the CLR, so any other base-class
    /// constraint (most notably <c>Enum</c>) is unsatisfiable.</description></item>
    /// <item><description>An in-scope generic type parameter
    /// (<see cref="TypeParameterSymbol"/>, e.g. the forwarded <c>TEnum</c> of
    /// <c>[TEnum Enum struct]</c>) satisfies <paramref name="constraint"/> only
    /// when its own <see cref="TypeParameterSymbol.ClassConstraint"/> resolves to
    /// the same CLR type (transitively, through a chain of forwarded
    /// constraints) — a bare <c>struct</c> constraint with no class bound does
    /// not prove anything about <c>Enum</c> or any other base.</description></item>
    /// </list>
    /// </summary>
    /// <param name="symbol">The recovered value-type-erased type-argument symbol.</param>
    /// <param name="constraint">The CLR base-class constraint to check against.</param>
    /// <returns><see langword="true"/> when the symbol provably satisfies the constraint.</returns>
    private static bool ValueTypeErasedSymbolSatisfiesBaseConstraint(TypeSymbol symbol, Type constraint)
    {
        if (constraint is null)
        {
            return true;
        }

        if (constraint.IsSameAs(typeof(object))
            || string.Equals(constraint.FullName, "System.ValueType", StringComparison.Ordinal))
        {
            return true;
        }

        var current = symbol;
        while (current != null)
        {
            switch (current)
            {
                case EnumSymbol:
                    return string.Equals(constraint.FullName, "System.Enum", StringComparison.Ordinal);

                case StructSymbol:
                    return false;

                case TypeParameterSymbol typeParam:
                    var classConstraint = typeParam.ClassConstraint;
                    if (classConstraint?.ClrType != null
                        && string.Equals(classConstraint.ClrType.FullName, constraint.FullName, StringComparison.Ordinal))
                    {
                        return true;
                    }

                    current = classConstraint;
                    continue;

                default:
                    return false;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #1325: attempts to close <paramref name="openDef"/> over a value-type
    /// placeholder for every type-argument slot whose CLR type was erased to a
    /// non-value-type placeholder but whose recovered symbol is a user value
    /// type (a non-class <see cref="StructSymbol"/> or an <see cref="EnumSymbol"/>).
    /// Succeeds only when at least one such slot exists, the recovered symbols
    /// satisfy the method's generic constraints, and the placeholder closure is
    /// accepted by <see cref="MethodInfo.MakeGenericMethod(Type[])"/>.
    /// </summary>
    /// <param name="openDef">The open generic method definition.</param>
    /// <param name="typeArgs">The CLR type arguments (with user value types erased).</param>
    /// <param name="recoveredSymbols">The recovered symbolic type-argument vector, or default.</param>
    /// <param name="closed">On success, the method closed over the placeholder.</param>
    /// <returns><see langword="true"/> when a placeholder closure was produced.</returns>
    private static bool TryCloseOverUserValueTypePlaceholders(
        MethodInfo openDef,
        Type[] typeArgs,
        ImmutableArray<TypeSymbol> recoveredSymbols,
        out MethodInfo closed)
    {
        closed = null;
        if (openDef is null || typeArgs is null || recoveredSymbols.IsDefaultOrEmpty)
        {
            return false;
        }

        var substituted = (Type[])typeArgs.Clone();
        var anyUserValueType = false;
        for (var i = 0; i < substituted.Length && i < recoveredSymbols.Length; i++)
        {
            if (substituted[i] != null
                && !substituted[i].IsValueType
                && IsValueTypeErasedSymbol(recoveredSymbols[i]))
            {
                substituted[i] = typeof(UserValueTypeConstraintPlaceholder);
                anyUserValueType = true;
            }
        }

        if (!anyUserValueType || !SatisfiesGenericConstraints(openDef, typeArgs, recoveredSymbols))
        {
            return false;
        }

        try
        {
            closed = openDef.MakeGenericMethod(substituted);
        }
        catch (ArgumentException)
        {
            return false;
        }

        return true;
    }

    /// <summary>
    /// Issue #1325: structurally rewrites every occurrence of
    /// <paramref name="from"/> within <paramref name="type"/> to
    /// <paramref name="to"/>, recursing through by-ref, array and constructed
    /// generic types. Used to map a placeholder-closed parameter type
    /// (e.g. <c>Span&lt;Placeholder&gt;</c>) back to the <c>object</c>-erased
    /// shape (<c>Span&lt;object&gt;</c>) for applicability.
    /// </summary>
    /// <param name="type">The type to rewrite.</param>
    /// <param name="from">The type to replace.</param>
    /// <param name="to">The replacement type.</param>
    /// <returns>The rewritten type, or the original when no occurrence is found.</returns>
    private static Type SubstituteClrType(Type type, Type from, Type to)
    {
        if (type is null || type == from)
        {
            return type == from ? to : type;
        }

        if (type.IsByRef)
        {
            return SubstituteClrType(type.GetElementType(), from, to).MakeByRefType();
        }

        if (type.IsPointer)
        {
            return SubstituteClrType(type.GetElementType(), from, to).MakePointerType();
        }

        if (type.IsArray)
        {
            var element = SubstituteClrType(type.GetElementType(), from, to);
            var rank = type.GetArrayRank();
            return rank == 1 ? element.MakeArrayType() : element.MakeArrayType(rank);
        }

        if (type.IsGenericType && !type.IsGenericTypeDefinition)
        {
            var args = type.GetGenericArguments();
            var changed = false;
            for (var i = 0; i < args.Length; i++)
            {
                var rewritten = SubstituteClrType(args[i], from, to);
                if (!ReferenceEquals(rewritten, args[i]))
                {
                    args[i] = rewritten;
                    changed = true;
                }
            }

            return changed ? type.GetGenericTypeDefinition().MakeGenericType(args) : type;
        }

        return type;
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
        // Issue #1482: query the single authoritative lattice instead of a
        // second local copy. The previous local table lacked all native-int
        // (nint/nuint) rows, so overload "better conversion" ranking disagreed
        // with Conversion.Classify about native-int widening; routing through
        // the shared lattice fixes that divergence by construction.
        return NumericWideningLattice.IsWidening(source, target);
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

        if (parameterType.IsByRef)
        {
            return UnifyForInference(
                parameterType.GetElementType(),
                argumentType.IsByRef ? argumentType.GetElementType() : argumentType,
                bounds);
        }

        if (parameterType.IsPointer)
        {
            if (argumentType.IsPointer)
            {
                return UnifyForInference(parameterType.GetElementType(), argumentType.GetElementType(), bounds);
            }

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

        if (IsStructurallyInferrableDelegate(parameterType, argumentType))
        {
            if (!TryGetDelegateSignature(parameterType, out var parameterDelegateParameters, out var parameterDelegateReturn)
                || !TryGetDelegateSignature(argumentType, out var argumentDelegateParameters, out var argumentDelegateReturn)
                || parameterDelegateParameters.Length != argumentDelegateParameters.Length)
            {
                return true;
            }

            for (var i = 0; i < parameterDelegateParameters.Length; i++)
            {
                if (!UnifyForInference(parameterDelegateParameters[i], argumentDelegateParameters[i], bounds))
                {
                    return false;
                }
            }

            // Issue #1531: a void-returning source delegate/method-group must not
            // make a value-returning delegate parameter whose return is (or
            // contains) a method type parameter applicable. C# forbids inferring
            // a type argument from a void return, so a `(...)->TResult` overload
            // is not applicable when the supplied delegate returns void. Failing
            // inference here prunes that overload, leaving a `(...)->void`
            // overload as the unique match instead of a spurious GS0266.
            if (parameterDelegateReturn is not null
                && argumentDelegateReturn is not null
                && string.Equals(argumentDelegateReturn.FullName, "System.Void", StringComparison.Ordinal)
                && !string.Equals(parameterDelegateReturn.FullName, "System.Void", StringComparison.Ordinal)
                && parameterDelegateReturn.ContainsGenericParameters)
            {
                return false;
            }

            return UnifyForInference(parameterDelegateReturn, argumentDelegateReturn, bounds);
        }

        if (parameterType.IsGenericType && !parameterType.IsGenericTypeDefinition)
        {
            var openDef = parameterType.GetGenericTypeDefinition();
            var paramArgs = parameterType.GetGenericArguments();

            // Issue #2142: an expression-tree parameter Expression<TDelegate>
            // never matches a delegate argument's class hierarchy (a Func<…> is
            // not an Expression<…>), so FindClosedGeneric below returns null and
            // any method type parameter mentioned only inside TDelegate (e.g.
            // HasOne<TRelated>(Expression<Func<TEntity, TRelated?>>)) would never
            // be inferred. Unwrap the expression tree and unify its delegate type
            // argument directly against the supplied delegate argument.
            if (string.Equals(openDef.FullName, "System.Linq.Expressions.Expression`1", StringComparison.Ordinal)
                && paramArgs.Length == 1
                && ClrTypeUtilities.IsDelegateType(argumentType))
            {
                return UnifyForInference(paramArgs[0], argumentType, bounds);
            }

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

    private static bool IsStructurallyInferrableDelegate(Type parameterType, Type argumentType)
    {
        if (parameterType == null || argumentType == null)
        {
            return false;
        }

        if (!parameterType.ContainsGenericParameters
            || !ClrTypeUtilities.IsDelegateType(parameterType)
            || !ClrTypeUtilities.IsDelegateType(argumentType))
        {
            return false;
        }

        if (parameterType.IsGenericType
            && argumentType.IsGenericType
            && MatchesOpenDefinition(
                argumentType.GetGenericTypeDefinition(),
                parameterType.GetGenericTypeDefinition(),
                parameterType.GetGenericTypeDefinition().FullName))
        {
            return false;
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
    /// Issue #1325: a value-type stand-in used to close a generic method over a
    /// same-compilation user value type under live reflection. The user value
    /// type has no reference-context CLR type during binding (it is erased to
    /// <c>System.Object</c>), and the live-reflection
    /// <see cref="MethodInfo.MakeGenericMethod(Type[])"/> rejects <c>object</c>
    /// against a <c>where T : struct</c> parameter. Closing over this
    /// placeholder yields a valid <see cref="MethodInfo"/>; the placeholder is
    /// then rewritten back to <c>object</c> in the candidate's parameter types
    /// (see <see cref="SubstituteClrType"/>) so applicability still matches the
    /// <c>object</c>-erased argument types, and emit uses the recovered symbolic
    /// type arguments rather than this placeholder.
    /// </summary>
    private struct UserValueTypeConstraintPlaceholder
    {
    }

    /// <summary>
    /// Issue #977: private marker type whose <see cref="Type"/> identity is used as
    /// the <see cref="InlineOutVarArgumentType"/> sentinel for inline <c>out var</c>
    /// arguments during overload resolution. Never instantiated.
    /// </summary>
    private sealed class InlineOutVarArgumentMarker
    {
    }

    /// <summary>
    /// Issue #1391: private marker type whose <see cref="Type"/> identity is used
    /// as the <see cref="DefaultLiteralArgumentType"/> sentinel for an untyped
    /// <c>default</c> literal argument during overload resolution. Never instantiated.
    /// </summary>
    private sealed class DefaultLiteralArgumentMarker
    {
    }
}
