// <copyright file="PatternVariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0166: a read-only local introduced by a designation in a boolean
/// <c>is</c> pattern (<c>value is string text</c>, <c>value is { } item</c>,
/// <c>value is var captured</c>, <c>values is [..rest]</c>). The pattern assigns it exactly once, and the
/// binder makes it visible only in regions the match dominates, so every read
/// observes the assigned value. Closure lowering relies on that invariant to
/// capture the variable by value instead of hoisting it into a heap cell.
/// </summary>
internal sealed class PatternVariableSymbol : LocalVariableSymbol
{
    /// <summary>Initializes a new instance of the <see cref="PatternVariableSymbol"/> class.</summary>
    /// <param name="name">The designation name.</param>
    /// <param name="type">The matched value's type.</param>
    /// <param name="declaringSyntax">The designation token.</param>
    public PatternVariableSymbol(string name, TypeSymbol type, SyntaxNode? declaringSyntax)
        : base(name, isReadOnly: true, type, declaringSyntax)
    {
        // A pattern only assigns its variable when the match succeeded, and a
        // successful narrowing pattern never yields nil. The var-pattern binder
        // clears this fact because a total pattern does not prove non-null. A later
        // `nullable = patternVariable` therefore keeps the target's
        // smart-cast narrowing across a loop back-edge, exactly like assigning
        // a `let` local proven non-null by its initializer.
        HasDefinitelyNonNullValue = type is not NullableTypeSymbol;
    }
}
