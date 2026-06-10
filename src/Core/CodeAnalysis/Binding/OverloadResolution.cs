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

        return 0;
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

        for (var t = type; t != null; t = t.BaseType)
        {
            if (t.IsGenericType && ReferenceEquals(t.GetGenericTypeDefinition(), openDefinition))
            {
                return t;
            }
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

        foreach (var iface in ifaces)
        {
            if (iface.IsGenericType && ReferenceEquals(iface.GetGenericTypeDefinition(), openDefinition))
            {
                return iface;
            }
        }

        return null;
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
}
