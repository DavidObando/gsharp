// <copyright file="Accessibility.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// CLR-visibility level recorded on top-level declarations
/// (functions, types, global variables). Default for top-level
/// declarations is (cref:Public) per ADR-0014.
enum Accessibility {
    Public,
    Internal,
    Private,
    Protected
}
