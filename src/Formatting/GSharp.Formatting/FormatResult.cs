// <copyright file="FormatResult.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Formatting;

/// <summary>
/// The result of formatting a G# source document.
/// </summary>
/// <param name="Text">The canonical source, or <see langword="null"/> when formatting failed.</param>
/// <param name="Edits">Edits relative to the input source.</param>
/// <param name="Diagnostics">Parse or formatter diagnostics.</param>
/// <param name="Changed">Whether applying <paramref name="Edits"/> changes the input.</param>
public readonly record struct FormatResult(
    SourceText? Text,
    ImmutableArray<TextEdit> Edits,
    ImmutableArray<Diagnostic> Diagnostics,
    bool Changed);
