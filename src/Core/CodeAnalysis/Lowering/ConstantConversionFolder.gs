// <copyright file="ConstantConversionFolder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
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
/// The pass also rewrites the trees that the type symbols hold and that are not in a function body: the
/// field initializers, the static initializer statements, and the base-constructor initializer arguments.
/// The symbols are changed in place, as (cref:InterpolatedStringHandlerLowerer) changes them. The fold is
/// idempotent, so a second emit of the same compilation sees the same literals.
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

    private func RewriteTypeTrees(structSym StructSymbol) bool {
        var changed = false
        let staticInitializers = RewriteFieldInitializers(structSym.StaticFieldInitializers)
        if staticInitializers != nil {
            structSym.SetStaticFieldInitializers(staticInitializers)
            changed = true
        }
        let instanceInitializers = RewriteFieldInitializers(structSym.InstanceFieldInitializers)
        if instanceInitializers != nil {
            structSym.SetInstanceFieldInitializers(instanceInitializers)
            changed = true
        }
        if !structSym.StaticInitializerStatements.IsDefaultOrEmpty {
            let builder = ImmutableArray.CreateBuilder[BoundStatement](structSym.StaticInitializerStatements.Length)
            var statementsChanged = false
            for statement in structSym.StaticInitializerStatements {
                let rewritten = RewriteStatement(statement)
                statementsChanged |= rewritten != statement
                builder.Add(rewritten)
            }
            if statementsChanged {
                structSym.SetStaticInitializerStatements(builder.MoveToImmutable())
                changed = true
            }
        }
        let primary = RewriteBaseInitializer(structSym.BaseConstructorInitializer)
        if primary != nil {
            structSym.SetBaseConstructorInitializer(primary)
            changed = true
        }
        for constructor in structSym.ExplicitConstructors {
            let rewritten = RewriteBaseInitializer(constructor.BaseInitializer)
            if rewritten != nil {
                constructor.SetBaseInitializer(rewritten)
                changed = true
            }
        }
        return changed
    }

    // Returns the rewritten initializers, or `nil` when no initializer changed.
    private func RewriteFieldInitializers(
        initializers ImmutableDictionary[FieldSymbol, BoundExpression]
    ) ImmutableDictionary[FieldSymbol, BoundExpression]? {
        var builder ImmutableDictionary[FieldSymbol, BoundExpression].Builder? = nil
        // Issue #4663: deterministic order, never identity-hash order.
        for pair in BoundProgramOrder.FieldInitializers(initializers) {
            let rewritten = RewriteExpression(pair.Value)
            if rewritten != pair.Value {
                let target = builder ?? initializers.ToBuilder()
                target[pair.Key] = rewritten
                builder = target
            }
        }
        return builder?.ToImmutable()
    }

    // Returns the initializer with rewritten arguments, or `nil` when no argument changed.
    private func RewriteBaseInitializer(initializer BaseConstructorInitializer?) BaseConstructorInitializer? {
        if initializer == nil || initializer.Arguments.IsDefaultOrEmpty {
            return nil
        }
        let builder = ImmutableArray.CreateBuilder[BoundExpression](initializer.Arguments.Length)
        var changed = false
        for argument in initializer.Arguments {
            let rewritten = RewriteExpression(argument)
            changed |= rewritten != argument
            builder.Add(rewritten)
        }
        return if changed {
            initializer.WithArguments(builder.MoveToImmutable())
        } else {
            nil
        }
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
            for structSym in program.Structs {
                changed |= folder.RewriteTypeTrees(structSym)
            }
            for interfaceSym in program.Interfaces {
                let interfaceInitializers = folder.RewriteFieldInitializers(interfaceSym.StaticFieldInitializers)
                if interfaceInitializers != nil {
                    interfaceSym.SetStaticFieldInitializers(interfaceInitializers)
                    changed = true
                }
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
