// <copyright file="AnalyzerActionEntry.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Analyzers

import System

/// A registered analyzer callback together with the analyzer that owns it.
/// @typeparam TContext The context type the callback receives.
/// @param Owner The analyzer that registered the callback.
/// @param Action The callback.
internal data class AnalyzerActionEntry[TContext](
    Owner GSharpDiagnosticAnalyzer,
    Action(TContext) -> void
) : IEquatable[AnalyzerActionEntry[TContext]] { }
