// <copyright file="ResolutionOutcome.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding.OverloadResolution;

/// <summary>
/// Outcome of an overload-resolution attempt.
/// </summary>
public enum ResolutionOutcome
{
    /// <summary>No candidate was applicable.</summary>
    NoneApplicable,

    /// <summary>A single best candidate was found.</summary>
    Resolved,

    /// <summary>Multiple equally-good candidates were found.</summary>
    Ambiguous,
}
