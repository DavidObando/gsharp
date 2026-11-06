// <copyright file="ConstantConversionFolder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering

import GSharp.Core.CodeAnalysis.Binding
import System.Collections.Immutable

/// Replaces each conversion of a constant floating operand to an integer, `char`, or enum target with
/// the folded literal before any other emit-pipeline pass runs (issue #5767, ADR-0219).
/// @remarks The fold reads the operand's constant value, and later passes can remove that value from
/// the tree. Capture boxing turns a `const` local that a function literal captures into a box-cell
/// read. The async and iterator rewriters turn a `const` local that lives across an `await` or a
/// `yield` into a state-machine field read. Neither read is a constant, so a fold that runs after
/// these passes emits a runtime conversion whose result depends on the host runtime. This pass runs
/// first, so every later pass sees the folded literal.
///
/// The decision and the folded shape come from
/// (cref:ConstantExpressionEvaluator.TryFoldFloatingConstantConversionToLiteral), the same helper that
/// the emitter and the expression-tree lowerer use.
internal class ConstantConversionFolder : NestedFunctionBodyRewriter {
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteConversionExpression(node BoundConversionExpression) BoundExpression {
        if ConstantExpressionEvaluator.TryFoldFloatingConstantConversionToLiteral(node, out var folded) {
            return folded
        }
        return base.RewriteConversionExpression(node)
    }

    shared {
        /// Produces a copy of [`program`](paramref) in which each foldable constant floating
        /// conversion is a literal. Returns the original instance when nothing changed.
        /// @param program The bound program to lower.
        /// @returns The lowered program (or the original when nothing changed).
        func Lower(program BoundProgram) BoundProgram {
            let folder = ConstantConversionFolder()
            var changed = false
            let functions = ImmutableDictionary.CreateBuilder[FunctionSymbol, BoundBlockStatement]()
            // Issue #4663: deterministic order, never identity-hash order.
            for pair in BoundProgramOrder.Functions(program) {
                let newBody = cast[BoundBlockStatement](folder.RewriteStatement(pair.Value))
                functions[pair.Key] = newBody
                changed |= newBody != pair.Value
            }
            let statement = cast[BoundBlockStatement](folder.RewriteStatement(program.Statement))
            changed |= statement != program.Statement
            let initializers = program.Initializers.ToBuilder()
            // Issue #4663: deterministic order, never identity-hash order.
            for pair in BoundProgramOrder.Initializers(program) {
                initializers[pair.Key] = pair.Value.Rewrite(folder.RewriteExpression, folder.RewriteStatement)
                changed |= initializers[pair.Key] != pair.Value
            }
            if !changed {
                return program
            }
            return BoundProgram(
                program.EntryPointPackage,
                program.Packages,
                program.Diagnostics,
                functions.ToImmutable(),
                program.EntryPoint,
                statement,
                program.Structs,
                program.Interfaces,
                program.Enums,
                program.Globals,
                program.Delegates
            ){
                Initializers = initializers.ToImmutable(),
                Imports = program.Imports,
                FriendAssemblies = program.FriendAssemblies,
                AssemblyAttributes = program.AssemblyAttributes,
                ModuleAttributes = program.ModuleAttributes,
                NativeProtocols = program.NativeProtocols
            }
        }
    }
}
