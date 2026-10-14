// <copyright file="ImportedTypeAmbiguity.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System

/// Issue #3734: a bare imported type name that two or more explicitly written
/// imports each resolve to a DIFFERENT CLR type. Resolution still answers with
/// (cref:Chosen) (first-import-wins), but the choice is an artifact of
/// import order rather than of anything the author wrote, so the reference is
/// reported as ambiguous (GS0547).
/// @param First The candidate contributed by the first explicit import that resolves the name.
/// @param Second The first candidate that differs from [`First`](paramref).
/// @param Chosen The type first-import-wins actually selected.
data class ImportedTypeAmbiguity(First Type, Second Type, Chosen Type) : IEquatable[ImportedTypeAmbiguity] { }
