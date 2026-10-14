// <copyright file="SemanticColor.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Tokens

import Spectre.Console
import System

/// A single semantic colour token: a Spectre (cref:Color) wrapped in a strong type
/// so widgets compose with intent (`StatusError`) rather than raw colour (`Red`).
data struct SemanticColor(Value Color) : IEquatable[SemanticColor] {
    func operator implicit(c SemanticColor) Color -> c.Value

    func operator implicit(c SemanticColor) Style -> Style(c.Value)

    func MarkupOpen() string -> "[${Value.ToMarkup()}]"

    func ToString() string -> Value.ToMarkup()
}
