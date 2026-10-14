// <copyright file="IdentifierNameContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System

/// Identifies grammar positions where contextual G# spellings can consume an
/// otherwise ordinary identifier.
@Flags
enum IdentifierNameContext {
    General,
    Parameter,
    Local,
    TypeParameter = 4,
    Invocation = 8,
    Pattern = 16,
    Type = 32,
    Index = 64
}
