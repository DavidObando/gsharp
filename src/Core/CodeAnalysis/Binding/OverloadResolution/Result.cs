// <copyright file="Result.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Binding.OverloadResolution;

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

    /// <summary>
    /// Gets the resolution outcome.
    /// </summary>
    public ResolutionOutcome Outcome { get; }

    /// <summary>
    /// Gets the single best candidate, if <see cref="Outcome"/> is <see cref="ResolutionOutcome.Resolved"/>.
    /// </summary>
    public T Best { get; }

    /// <summary>
    /// Gets the set of tied candidates, if <see cref="Outcome"/> is <see cref="ResolutionOutcome.Ambiguous"/>.
    /// </summary>
    public ImmutableArray<T> Ambiguous { get; }

    /// <summary>
    /// Gets the parameter mapping from original signature to resolved signature.
    /// </summary>
    public ImmutableArray<int> ParameterMapping { get; }

    /// <summary>
    /// Gets a value indicating whether the resolved candidate is in expanded (params) form.
    /// </summary>
    public bool IsExpanded { get; }

    internal static Result<T> NoneApplicable() => new(ResolutionOutcome.NoneApplicable, default, ImmutableArray<T>.Empty, default, false);

    internal static Result<T> Single(T best) => new(ResolutionOutcome.Resolved, best, ImmutableArray<T>.Empty, default, false);

    internal static Result<T> Single(T best, ImmutableArray<int> parameterMapping) => new(ResolutionOutcome.Resolved, best, ImmutableArray<T>.Empty, parameterMapping, false);

    internal static Result<T> Single(T best, ImmutableArray<int> parameterMapping, bool isExpanded) => new(ResolutionOutcome.Resolved, best, ImmutableArray<T>.Empty, parameterMapping, isExpanded);

    internal static Result<T> AmbiguousResult(ImmutableArray<T> tied) => new(ResolutionOutcome.Ambiguous, default, tied, default, false);
}
