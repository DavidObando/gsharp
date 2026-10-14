// <copyright file="PatternVariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// ADR-0166: a read-only local introduced by a designation in a boolean
/// `is` pattern (`value is string text`, `value is { } item`,
/// `value is var captured`, `values is [..rest]`). The pattern assigns it exactly once, and the
/// binder makes it visible only in regions the match dominates, so every read
/// observes the assigned value. Closure lowering relies on that invariant to
/// capture the variable by value instead of hoisting it into a heap cell.
internal class PatternVariableSymbol : LocalVariableSymbol {
    /// Initializes a new instance of the (cref:PatternVariableSymbol) class.
    /// @param name The designation name.
    /// @param type The matched value's type.
    /// @param declaringSyntax The designation token.
    init(name string, type TypeSymbol, declaringSyntax SyntaxNode?) : base(name, true, type, declaringSyntax) {
        // A pattern only assigns its variable when the match succeeded, and a
        // successful narrowing pattern never yields nil. The var-pattern binder
        // clears this fact because a total pattern does not prove non-null. A later
        // `nullable = patternVariable` therefore keeps the target's
        // smart-cast narrowing across a loop back-edge, exactly like assigning
        // a `let` local proven non-null by its initializer.
        HasDefinitelyNonNullValue = !(type is NullableTypeSymbol)
    }
}
