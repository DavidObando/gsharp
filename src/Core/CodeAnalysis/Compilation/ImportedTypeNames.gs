// <copyright file="ImportedTypeNames.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Compilation

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic

/// Answers whether a simple name resolves to an imported type in a tree of a prefix compilation, which a
/// later source type of the same name hides when nothing follows the cut (#6215, ADR-0225 D6.8).
/// @remarks The answer depends only on the trees and their imports, so a bind that reuses declarations
/// or bodies gets the answer of a bind from scratch.
internal sealed class ImportedTypeNames {
    // A generic type is looked up by its arity, which a bare name does not state.
    private const MaxArity int32 = 8

    private let compilation Compilation
    private let answers Dictionary[(Tree SyntaxTree, Name string), bool] = Dictionary[
        (Tree SyntaxTree, Name string),
        bool
    ]()
    private var lookupScope BoundScope?

    /// Creates the test for the trees of [`compilation`](paramref).
    /// @param compilation The prefix compilation.
    internal init(compilation Compilation) {
        this.compilation = compilation
    }

    /// Returns a value that tells whether [`name`](paramref) resolves to an imported type in
    /// [`tree`](paramref).
    /// @param tree The tree whose imports apply.
    /// @param name The simple name.
    /// @returns `true` for the name of an imported type.
    internal func Resolves(tree SyntaxTree, name string) bool {
        let key = (tree, name)
        if answers.TryGetValue(key, out var known) {
            return known
        }
        lookupScope ??= Binder.CreateImportLookupScope(compilation.GlobalScope)
        let lookup = lookupScope!!
        let previous = lookup.SetCurrentReferencingSyntaxTree(tree)
        var found = false
        try {
            found = lookup.TryLookupImportedClass(name, declaration: nil, out _)
            for var arity = 1; !found && arity <= MaxArity; arity++ {
                found = lookup.TryLookupImportedGenericClass(name, arity, out _)
            }
        } finally {
            lookup.SetCurrentReferencingSyntaxTree(previous)
        }
        answers[key] = found
        return found
    }
}
