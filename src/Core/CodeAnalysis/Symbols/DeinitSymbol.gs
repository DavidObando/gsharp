// <copyright file="DeinitSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Syntax

/// ADR-0068 / issue #698: a user-declared destructor (`deinit { … }`)
/// on a GSharp `class`. Each (cref:DeinitSymbol) wraps a
/// synthesized (cref:FunctionSymbol) named `Finalize` whose
/// receiver is the owning class. The emitter materialises that function as
/// a CLR `Finalize` override whose body is wrapped in
/// `try { … } finally { base.Finalize(); }`, byte-for-byte identical to
/// what the C# compiler emits for a `~Type()` destructor.
/// @remarks The destructor body is bound and lowered exactly like an instance-method
/// body — the (cref:Function) carries a synthesized `this`
/// parameter and the body is keyed in `BoundProgram.Functions` by
/// (cref:Function). The emitter, however, ignores the standard
/// method-emission path for this function and routes through a dedicated
/// `EmitClassDeinitializer` that establishes the try/finally region
/// and the chained `base.Finalize()` call.
class DeinitSymbol {
    /// Initializes a new instance of the (cref:DeinitSymbol) class.
    /// @param function The synthesized `Finalize` function symbol used as the bind/emit key.
    /// @param declaration The declaring syntax.
    init(function FunctionSymbol, declaration DeinitDeclarationSyntax) {
        Function = function
        Declaration = declaration
    }

    /// Gets the synthesized `Finalize` function symbol (receiver = the owning class) keyed in
    /// `BoundProgram.Functions`.
    prop Function FunctionSymbol {
        get;
    }

    /// Gets the declaring syntax node.
    prop Declaration DeinitDeclarationSyntax {
        get;
        private set;
    }

    /// Gets the owning class.
    prop DeclaringType StructSymbol? -> Function.ReceiverType as StructSymbol

    /// ADR-0105 Phase 2 — re-points this (reused) destructor at the declaration
    /// node of a freshly-parsed syntax tree whose declaration is byte-identical
    /// to the previous one (a body-only edit). Only the backing syntax — and
    /// therefore the body text and source spans — changes; the symbol's identity
    /// is preserved so cross-compilation reuse stays sound. Intended to be called
    /// only by (cref:Binding.IncrementalGlobalScopeReuse).
    /// @param declaration The corresponding declaration in the re-parsed tree.
    internal func RepointDeclaration(declaration DeinitDeclarationSyntax) {
        Declaration = declaration
    }
}
