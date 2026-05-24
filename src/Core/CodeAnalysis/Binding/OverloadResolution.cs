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
    /// <returns>The resolution result.</returns>
    public static Result<T> Resolve<T>(IEnumerable<T> candidates, IReadOnlyList<Type> argTypes)
        where T : MethodBase
    {
        var applicable = new List<(T Method, ImplicitConversionKind[] Conversions)>();
        foreach (var candidate in candidates)
        {
            var parameters = candidate.GetParameters();
            if (parameters.Length != argTypes.Count)
            {
                continue;
            }

            var conversions = new ImplicitConversionKind[parameters.Length];
            var ok = true;
            for (var i = 0; i < parameters.Length; i++)
            {
                var conv = ClassifyImplicit(parameters[i].ParameterType, argTypes[i]);
                if (conv == ImplicitConversionKind.None)
                {
                    ok = false;
                    break;
                }

                conversions[i] = conv;
            }

            if (ok)
            {
                applicable.Add((candidate, conversions));
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

        // Better-function-member pass: a candidate wins iff for all arguments
        // its conversion is no worse than every other applicable candidate's,
        // and for at least one argument it is strictly better.
        var winners = new List<(T Method, ImplicitConversionKind[] Conversions)>();
        foreach (var c in applicable)
        {
            var isWinner = true;
            foreach (var other in applicable)
            {
                if (ReferenceEquals(c.Method, other.Method))
                {
                    continue;
                }

                if (!IsAtLeastAsGoodAs(c.Conversions, other.Conversions))
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

    private static bool IsAtLeastAsGoodAs(ImplicitConversionKind[] a, ImplicitConversionKind[] b)
    {
        var hasStrictlyBetter = false;
        for (var i = 0; i < a.Length; i++)
        {
            if ((int)a[i] > (int)b[i])
            {
                return false;
            }

            if ((int)a[i] < (int)b[i])
            {
                hasStrictlyBetter = true;
            }
        }

        return hasStrictlyBetter;
    }

    private static bool IsAtLeastAsSpecific(MethodBase a, MethodBase b)
    {
        var pa = a.GetParameters();
        var pb = b.GetParameters();
        for (var i = 0; i < pa.Length; i++)
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
