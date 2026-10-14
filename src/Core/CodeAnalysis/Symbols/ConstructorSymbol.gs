// <copyright file="ConstructorSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// Issue #306: a standalone user-defined constructor declared on a GSharp
/// `class` via the `init(params) [: base(args)] { ... }` form.
/// @remarks The constructor body is bound and emitted/interpreted through the same
/// machinery as an instance method: the (cref:Function) carries a
/// synthesized `this` parameter and the declared parameters, and its body
/// is keyed in `BoundProgram.Functions` by (cref:Function). The
/// emitter materializes it as a `.ctor` that first chains to the resolved
/// base constructor ((cref:BaseInitializer), or the conventional
/// parameterless chain) and then runs the bound body.
class ConstructorSymbol {
    /// Initializes a new instance of the (cref:ConstructorSymbol) class.
    /// @param function The underlying instance-method-shaped function symbol used as the
    /// bind/emit/interpret key.
    /// @param declaration The declaring syntax. May be `null` for compiler-synthesized constructors (e.g.
    /// ADR-0065 §5 primary-ctor synthesis).
    init(function FunctionSymbol, declaration ConstructorDeclarationSyntax?) {
        Function = function
        Declaration = declaration
    }

    /// Gets the underlying function symbol (receiver = the owning class) keyed in `BoundProgram.Functions`.
    prop Function FunctionSymbol {
        get;
    }

    /// Gets the declaring syntax node, or `null` when this is a compiler-synthesized constructor (ADR-0065
    /// §5).
    prop Declaration ConstructorDeclarationSyntax? {
        get;
        private set;
    }

    /// Gets the constructor parameters (excluding the implicit `this`).
    prop Parameters ImmutableArray[ParameterSymbol] -> Function.Parameters

    /// Gets the owning class.
    prop DeclaringType StructSymbol? -> Function.ReceiverType as StructSymbol

    /// Gets the resolved explicit base-constructor initializer (`: base(args)`), or `null` when the
    /// constructor chains to a parameterless base constructor.
    prop BaseInitializer BaseConstructorInitializer? {
        get;
        private set;
    }

    /// Gets a value indicating whether this constructor is a
    /// `convenience init` (ADR-0065 §2) that must delegate to another
    /// initializer in the same class before performing any other work.
    prop IsConvenience bool {
        get;
        private set;
    }

    /// Gets a value indicating whether this constructor was compiler-synthesized
    /// from a primary-constructor parameter list (ADR-0065 §5). The emitter
    /// materializes the field-assignment body for these constructors rather
    /// than reading it from the program's function bodies.
    prop IsSynthesizedFromPrimaryConstructor bool {
        get;
        private set;
    }

    /// Sets (cref:BaseInitializer) after the binder resolves the base-constructor argument list.
    /// @param initializer The resolved base-constructor initializer.
    func SetBaseInitializer(initializer BaseConstructorInitializer) {
        BaseInitializer = initializer
    }

    /// ADR-0065 §2: marks this constructor as `convenience`.
    func MarkConvenience() {
        IsConvenience = true
    }

    /// ADR-0065 §5: marks this constructor as synthesized from the primary-constructor parameter list.
    func MarkSynthesizedFromPrimaryConstructor() {
        IsSynthesizedFromPrimaryConstructor = true
    }

    /// ADR-0105 Phase 2 — re-points this (reused) constructor at the declaration
    /// node of a freshly-parsed syntax tree whose constructor signature is
    /// byte-identical to the previous one (a body-only edit). Only the backing
    /// syntax — and therefore the body text and source spans — changes; the
    /// symbol's identity (including (cref:Function) and its parameters)
    /// is preserved so cross-compilation reuse stays sound. Intended to be
    /// called only by (cref:Binding.IncrementalGlobalScopeReuse).
    /// @param declaration The corresponding declaration in the re-parsed tree.
    internal func RepointDeclaration(declaration ConstructorDeclarationSyntax) {
        Declaration = declaration
    }
}
