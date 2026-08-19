// <copyright file="AnalyzerActionEntry.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Core.CodeAnalysis.Analyzers;

/// <summary>
/// A registered analyzer callback together with the analyzer that owns it.
/// </summary>
/// <typeparam name="TContext">The context type the callback receives.</typeparam>
/// <param name="Owner">The analyzer that registered the callback.</param>
/// <param name="Action">The callback.</param>
internal sealed record AnalyzerActionEntry<TContext>(
    GSharpDiagnosticAnalyzer Owner,
    Action<TContext> Action);
