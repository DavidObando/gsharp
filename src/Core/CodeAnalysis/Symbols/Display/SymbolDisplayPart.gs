// <copyright file="SymbolDisplayPart.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols.Display

import GSharp.Core.CodeAnalysis.Symbols
import System

/// A single classified run of text in a symbol's display, optionally carrying the
/// (cref:Symbol) it refers to (for navigation). The analog of Roslyn's
/// `SymbolDisplayPart`.
/// @param Kind The classification of this part.
/// @param Text The literal text of this part.
/// @param Symbol The symbol this part refers to, when applicable.
data struct SymbolDisplayPart(Kind SymbolDisplayPartKind, Text string, Symbol Symbol? = nil) : IEquatable[
    SymbolDisplayPart
] { }
