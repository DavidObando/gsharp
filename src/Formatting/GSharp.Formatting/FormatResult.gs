// <copyright file="FormatResult.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable

/// The result of formatting a G# source document.
/// @param Text The canonical source, or `null` when formatting failed.
/// @param Edits Edits relative to the input source.
/// @param Diagnostics Parse or formatter diagnostics.
/// @param Changed Whether applying [`Edits`](paramref) changes the input.
data struct FormatResult(
    Text SourceText?,
    Edits ImmutableArray[TextEdit],
    Diagnostics ImmutableArray[Diagnostic],
    Changed bool
) : IEquatable[FormatResult] { }
