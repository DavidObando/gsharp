// <copyright file="LocalVariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax

/// Represents a local variable symbol in the language.
open class LocalVariableSymbol : VariableSymbol {
    /// Initializes a new instance of the (cref:LocalVariableSymbol) class.
    /// @param name The local variable's name.
    /// @param isReadOnly Whether the local variable is read-only or not.
    /// @param type The local variable's type.
    /// @param declaringSyntax The originating declaration syntax (may be `null` for
    /// compiler-synthesised locals — async/iterator state-machine slots,
    /// lowering temporaries, awaiter cache slots, etc.). Used by the Portable
    /// PDB emitter to map IL local slots back to source per ADR-0027 §7.7a.
    init(name string, isReadOnly bool, type TypeSymbol, declaringSyntax SyntaxNode? = nil) : base(
        name,
        isReadOnly,
        type,
        declaringSyntax
    ) { }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    open override prop Kind SymbolKind -> SymbolKind.LocalVariable

    /// Gets or sets a value indicating whether this local carries the `scoped` modifier
    /// (ADR-0058 / issue #376) or has inherited function-local escape scope from its initializer.
    /// When `true`, returning this variable's value from a ref-struct-returning
    /// function is rejected.
    open prop IsScoped bool

    /// Gets or sets the ADR-0060 follow-up (issue #491) by-reference aliasing kind of this local.
    /// Defaults to (cref:Binding.RefKind.None). For a `let ref x = lvalue` / `var ref x = lvalue`
    /// declaration this is (cref:Binding.RefKind.Ref): the local's IL slot stores a managed pointer
    /// (`T&`) to the aliased storage while the symbol's (cref:VariableSymbol.Type) remains the
    /// pointee type `T`. Reads/writes are implicitly indirected by the emitter and interpreter.
    open prop RefKind RefKind

    /// Gets or sets a value indicating whether this local is a folded
    /// compile-time `const` binding (issue #216). Such a local has no IL
    /// slot — every read is inlined — so it has no address (issue #4400).
    internal prop IsConst bool

    internal prop ManagedReferenceOrigin BoundExpression?
    internal prop ManagedReferenceStorage LocalVariableSymbol?
    internal prop ManagedReferenceStorageOrigin BoundExpression?
    internal prop HoldsScopedManagedReference bool
}
