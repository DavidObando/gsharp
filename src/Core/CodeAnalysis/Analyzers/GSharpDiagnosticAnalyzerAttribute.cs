// <copyright file="GSharpDiagnosticAnalyzerAttribute.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Core.CodeAnalysis.Analyzers;

/// <summary>
/// Marks a concrete <see cref="GSharpDiagnosticAnalyzer"/> for discovery by
/// the analyzer host (ADR-0169). The counterpart of Roslyn's
/// <c>[DiagnosticAnalyzer(...)]</c>; G# has a single language, so there is no
/// language argument.
/// </summary>
[AttributeUsage(AttributeTargets.Class, AllowMultiple = false, Inherited = false)]
public sealed class GSharpDiagnosticAnalyzerAttribute : Attribute
{
}
