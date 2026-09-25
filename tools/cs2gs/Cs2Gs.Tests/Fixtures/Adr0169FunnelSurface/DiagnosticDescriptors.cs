// <copyright file="DiagnosticDescriptors.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Microsoft.CodeAnalysis;

namespace GSharp.InternalAnalyzers;

/// <summary>A descriptor stand-in for the funnel-surface parity fixture.</summary>
public static class DiagnosticDescriptors
{
    /// <summary>The fixture rule.</summary>
    public static readonly DiagnosticDescriptor NullabilityFunnelBypass = new(
        "GSA0007",
        "Route CLR type conversions through the nullability funnel",
        "{0}",
        "GSharp.InternalAnalyzers",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true);
}
