// <copyright file="GSharpDiagnosticAnalyzerAttribute.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Analyzers

import System

/// Marks a concrete (cref:GSharpDiagnosticAnalyzer) for discovery by
/// the analyzer host (ADR-0169). The counterpart of Roslyn's
/// `[DiagnosticAnalyzer(...)]`; G# has a single language, so there is no
/// language argument.
@AttributeUsage(AttributeTargets.Class, AllowMultiple = false, Inherited = false)
class GSharpDiagnosticAnalyzerAttribute : Attribute { }
