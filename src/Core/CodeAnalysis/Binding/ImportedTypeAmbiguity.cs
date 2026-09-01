// <copyright file="ImportedTypeAmbiguity.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Issue #3734: a bare imported type name that two or more explicitly written
/// imports each resolve to a DIFFERENT CLR type. Resolution still answers with
/// <see cref="Chosen"/> (first-import-wins), but the choice is an artifact of
/// import order rather than of anything the author wrote, so the reference is
/// reported as ambiguous (GS0547).
/// </summary>
/// <param name="First">The candidate contributed by the first explicit import that resolves the name.</param>
/// <param name="Second">The first candidate that differs from <paramref name="First"/>.</param>
/// <param name="Chosen">The type first-import-wins actually selected.</param>
public sealed record ImportedTypeAmbiguity(
    System.Type First,
    System.Type Second,
    System.Type Chosen);
