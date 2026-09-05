// <copyright file="TextEdit.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Formatting;

/// <summary>
/// Replaces a source span with canonical formatted text.
/// </summary>
/// <param name="Span">The span in the original source.</param>
/// <param name="NewText">The replacement text.</param>
public readonly record struct TextEdit(TextSpan Span, string NewText);
