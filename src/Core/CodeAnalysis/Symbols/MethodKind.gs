// <copyright file="MethodKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// What kind of function a (cref:FunctionSymbol) is — the Roslyn
/// `MethodKind` analogue for the analyzer surface (ADR-0169, issue
/// #4436). The member names match Roslyn's so a migrated analyzer's
/// comparisons translate by name. G# constructors are
/// (cref:ConstructorSymbol)s, not functions, so there is no
/// `Constructor` member.
enum MethodKind {
    Ordinary,
    AnonymousFunction,
    LocalFunction,
    PropertyGet,
    PropertySet,
    StaticConstructor
}
