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
        if (target is null || source is null)
        {
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

        if (ReferenceEquals(target.Assembly, source.Assembly) || target.GetType() == source.GetType())
        {
            try
            {
                if (target.IsAssignableFrom(source))
                {
                    return ImplicitConversionKind.Reference;
                }
            }
            catch (InvalidOperationException)
            {
                // MLC cross-context paths throw; fall through to user-defined lookup.
            }
        }

        var udi = UserDefinedImplicitConversionLookup;
        if (udi != null && udi(source, target))
        {
            return ImplicitConversionKind.UserDefinedImplicit;
        }

        return ImplicitConversionKind.None;
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
    /// <returns>The resolution result.</returns>
    public static Result<T> Resolve<T>(IEnumerable<T> candidates, IReadOnlyList<Type> argTypes, IReadOnlyList<Type> explicitTypeArgs = null, Func<Type, Type> projectTypeArgument = null)
        where T : MethodBase
    {
        var applicable = new List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes)>();
        foreach (var rawCandidate in candidates)
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
                EvaluateCandidate(rawCandidate, argTypes, explicitTypeArgs, projectTypeArgument, applicable);
            }
            catch (Exception ex) when (IsMetadataLoadFailure(ex))
            {
                continue;
            }
        }

        if (applicable.Count == 0)
        {
            return Result<T>.NoneApplicable();
        }

        if (applicable.Count == 1)
        {
            return Result<T>.Single(applicable[0].Method);
        }

        return RankApplicable(applicable, argTypes);
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

        // Issue #321: a generic overload may declare trailing optional
        // parameters (e.g. Serialize<TValue>(TValue value, JsonSerializerOptions?
        // options = null)). When fewer arguments are supplied than the method
        // declares, inference still applies as long as the omitted trailing
        // parameters are optional and every method type parameter is inferable
        // from the supplied arguments.
        if (argTypes.Count > parameters.Length || !TrailingParametersOptional(parameters, argTypes.Count))
        {
            return false;
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
    /// signature is a metadata/assembly load failure (issue #321). Such failures
    /// arise when a parameter type cannot be projected under the reference
    /// <c>MetadataLoadContext</c> — for example a ref-struct type or a type that
    /// lives in a transitive assembly that was not supplied via <c>/r:</c>. These
    /// candidates are treated as not applicable rather than aborting the whole
    /// lookup; any other exception is left to propagate.
    /// </summary>
    /// <param name="ex">The exception observed while evaluating a candidate.</param>
    /// <returns>Whether the exception represents a tolerable load failure.</returns>
    private static bool IsMetadataLoadFailure(Exception ex) =>
        ex is System.IO.FileNotFoundException
            or System.IO.FileLoadException
            or TypeLoadException
            or BadImageFormatException
            or MissingMethodException
            or NotSupportedException;

    /// <summary>
    /// Evaluates a single candidate for applicability against the supplied
    /// argument types, appending it to <paramref name="applicable"/> when it
    /// applies. Factored out of <see cref="Resolve{T}(IEnumerable{T}, IReadOnlyList{Type}, IReadOnlyList{Type}, Func{Type, Type})"/>
    /// so the per-candidate work can be guarded against reflection load
    /// failures (issue #321) without disturbing the surrounding control flow.
    /// </summary>
    private static void EvaluateCandidate<T>(T rawCandidate, IReadOnlyList<Type> argTypes, IReadOnlyList<Type> explicitTypeArgs, Func<Type, Type> projectTypeArgument, List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes)> applicable)
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
                if (!TryInferTypeArguments(mi, argTypes, out var typeArgs))
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

            // Issue #321: a candidate applies when it has at least as many
            // parameters as arguments and every parameter beyond the supplied
            // arguments is optional (has a compile-time default). Only the
            // supplied arguments participate in applicability and ranking; the
            // omitted trailing optionals are materialized to their defaults by
            // the binder before emit.
            if (argTypes.Count > parameters.Length || !TrailingParametersOptional(parameters, argTypes.Count))
            {
                return;
            }

            var conversions = new ImplicitConversionKind[argTypes.Count];
            var paramTypes = new Type[argTypes.Count];
            var ok = true;
            for (var i = 0; i < argTypes.Count; i++)
            {
                paramTypes[i] = parameters[i].ParameterType;
                var conv = ClassifyImplicit(paramTypes[i], argTypes[i]);
                if (conv == ImplicitConversionKind.None)
                {
                    ok = false;
                    break;
                }

                conversions[i] = conv;
            }

            if (ok)
            {
                applicable.Add((candidate, conversions, paramTypes));
            }
        }
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
    private static Result<T> RankApplicable<T>(List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes)> applicable, IReadOnlyList<Type> argTypes)
        where T : MethodBase
    {
        // Better-function-member pass: a candidate wins iff for all arguments
        // its conversion is no worse than every other applicable candidate's,
        // and for at least one argument it is strictly better.
        var winners = new List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes)>();
        foreach (var c in applicable)
        {
            var isWinner = true;
            foreach (var other in applicable)
            {
                if (ReferenceEquals(c.Method, other.Method))
                {
                    continue;
                }

                if (!IsAtLeastAsGoodAs(c.Conversions, c.ParamTypes, other.Conversions, other.ParamTypes, argTypes))
                {
                    isWinner = false;
                    break;
                }
            }

            if (isWinner)
            {
                winners.Add(c);
            }
        }

        if (winners.Count == 1)
        {
            return Result<T>.Single(winners[0].Method);
        }

        // Tie-break: prefer the candidate whose parameter types are
        // "more specific" (parameter-by-parameter assignability — a less
        // derived type is implicitly assignable from a more derived one).
        if (winners.Count > 1)
        {
            var mostSpecific = winners
                .Where(w => winners.All(o => ReferenceEquals(w.Method, o.Method) || IsAtLeastAsSpecific(w.Method, o.Method)))
                .ToList();
            if (mostSpecific.Count == 1)
            {
                return Result<T>.Single(mostSpecific[0].Method);
            }
        }

        // If nothing dominated above, report the entire applicable set as
        // ambiguous; otherwise report the surviving winners.
        var ambiguous = (winners.Count > 0 ? winners : applicable)
            .Select(c => c.Method)
            .ToImmutableArray();
        return Result<T>.AmbiguousResult(ambiguous);
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

        // Issue #321: candidates may differ in parameter count once trailing
        // optional parameters are allowed. Compare only the positions both
        // signatures share; the omitted optionals do not affect specificity of
        // the supplied arguments.
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
        if (!target.IsGenericType)
        {
            return false;
        }

        if (!string.Equals(target.GetGenericTypeDefinition().FullName, "System.Nullable`1", StringComparison.Ordinal))
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
        private Result(ResolutionOutcome outcome, T best, ImmutableArray<T> ambiguous)
        {
            Outcome = outcome;
            Best = best;
            Ambiguous = ambiguous;
        }

        /// <summary>Gets the resolution outcome.</summary>
        public ResolutionOutcome Outcome { get; }

        /// <summary>Gets the unique best candidate when <see cref="Outcome"/> is <see cref="ResolutionOutcome.Resolved"/>; otherwise <see langword="null"/>.</summary>
        public T Best { get; }

        /// <summary>Gets the candidates participating in an ambiguity, in source-encounter order.</summary>
        public ImmutableArray<T> Ambiguous { get; }

        internal static Result<T> NoneApplicable() => new(ResolutionOutcome.NoneApplicable, default, ImmutableArray<T>.Empty);

        internal static Result<T> Single(T best) => new(ResolutionOutcome.Resolved, best, ImmutableArray<T>.Empty);

        internal static Result<T> AmbiguousResult(ImmutableArray<T> tied) => new(ResolutionOutcome.Ambiguous, default, tied);
    }
}
