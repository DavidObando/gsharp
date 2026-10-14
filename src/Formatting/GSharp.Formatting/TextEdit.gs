// <copyright file="TextEdit.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting

import GSharp.Core.CodeAnalysis.Text
import System

/// Replaces a source span with canonical formatted text.
/// @param Span The span in the original source.
/// @param NewText The replacement text.
data struct TextEdit(Span TextSpan, NewText string) : IEquatable[TextEdit] { }
