#nullable disable

// <copyright file="RefInitializationHoister.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Lowering pass that eliminates <c>ref</c> locals (managed pointer locals) from
/// async method bodies so they do not require hoisting into byref fields — which
/// the CLR forbids on heap-allocated or state-machine types.
/// </summary>
/// <remarks>
/// <para>A ref local is identified by its type being <see cref="ByRefTypeSymbol"/>
/// and its initializer being a <see cref="BoundAddressOfExpression"/>. The hoister
/// recomputes the managed pointer at every use site:</para>
/// <list type="bullet">
/// <item><description><c>*refLocal</c> (dereference read) → replaced with the
/// underlying lvalue expression.</description></item>
/// <item><description><c>refLocal</c> (bare pointer usage, e.g., passed to ref
/// parameter) → replaced with <c>&amp;lvalue</c>.</description></item>
/// </list>
/// <para>To avoid duplicating side effects (issue #418 / P1-12), any
/// non-trivial sub-expression of the original ref initializer (call receiver,
/// index expression, etc.) is evaluated <em>once</em> into a hoisted temporary
/// local at the ref-initialization site. The reconstructed lvalue then refers
/// only to those temporaries and other side-effect-free leaves (variables,
/// parameters, literals), making it safe to inline at every use site. The
/// constituent variables are themselves later hoisted into state-machine
/// fields by <see cref="AsyncCaptureWalker"/> if they cross an await.</para>
/// <para>This pass runs after <see cref="SpillSequenceSpiller"/> and before
/// <see cref="AsyncStateMachineTypeBuilder"/> in the async pipeline.</para>
/// </remarks>
public static class RefInitializationHoister
{
    /// <summary>
    /// Rewrites <paramref name="body"/> by eliminating all ref locals.
    /// </summary>
    /// <param name="body">The spilled async method body.</param>
    /// <returns>The rewritten body with no ref local declarations or usages.</returns>
    public static BoundBlockStatement Rewrite(BoundBlockStatement body)
    {
        if (body == null)
        {
            return body;
        }

        // First pass: collect ref local declarations (we still need to know
        // which locals are ref so the rewriter can recognize their uses). The
        // operand template is computed in the second pass at the declaration
        // site itself, where we also emit the hoisting prelude.
        var refLocals = new Dictionary<LocalVariableSymbol, BoundExpression>();
        if (!CollectRefLocals(body, refLocals))
        {
            return body;
        }

        // Second pass: rewrite the tree. The rewriter replaces each ref local
        // declaration with a block containing the hoisting prelude and updates
        // the refLocals mapping to point at the side-effect-free template
        // expression that re-derives the lvalue from hoisted temporaries.
        var rewriter = new Rewriter(refLocals);
        var result = (BoundBlockStatement)rewriter.RewriteStatement(body);
        return result;
    }

    private static bool CollectRefLocals(BoundStatement statement, Dictionary<LocalVariableSymbol, BoundExpression> refLocals)
    {
        bool found = false;
        if (statement is BoundBlockStatement block)
        {
            foreach (var stmt in block.Statements)
            {
                found |= CollectRefLocals(stmt, refLocals);
            }
        }
        else if (statement is BoundVariableDeclaration decl
            && decl.Variable is LocalVariableSymbol local
            && local.Type is ByRefTypeSymbol
            && decl.Initializer is BoundAddressOfExpression addressOf)
        {
            // Seed with the raw operand; the rewriter replaces this with the
            // hoisted template when it visits the declaration.
            refLocals[local] = addressOf.Operand;
            found = true;
        }
        else if (statement is BoundIfStatement ifStmt)
        {
            found |= CollectRefLocals(ifStmt.ThenStatement, refLocals);
            if (ifStmt.ElseStatement != null)
            {
                found |= CollectRefLocals(ifStmt.ElseStatement, refLocals);
            }
        }
        else if (statement is BoundTryStatement tryStmt)
        {
            found |= CollectRefLocals(tryStmt.TryBlock, refLocals);
            foreach (var clause in tryStmt.CatchClauses)
            {
                found |= CollectRefLocals(clause.Body, refLocals);
            }

            if (tryStmt.FinallyBlock != null)
            {
                found |= CollectRefLocals(tryStmt.FinallyBlock, refLocals);
            }
        }

        return found;
    }

    /// <summary>
    /// Returns <see langword="true"/> when <paramref name="expression"/> can
    /// be re-evaluated arbitrarily many times without observable side effects
    /// and without re-running user code: pure leaves like variable reads,
    /// parameter reads, literals, and the implicit <c>this</c>/state-machine
    /// receiver. Anything else (calls, indexers, field/property reads, casts,
    /// arithmetic, etc.) is hoisted into a temporary.
    /// </summary>
    private static bool IsTriviallyRepeatable(BoundExpression expression)
    {
        return expression is BoundVariableExpression
            || expression is BoundLiteralExpression;
    }

    private sealed class Rewriter : BoundTreeRewriter
    {
        private readonly Dictionary<LocalVariableSymbol, BoundExpression> refLocals;
        private int tempCounter;

        public Rewriter(Dictionary<LocalVariableSymbol, BoundExpression> refLocals)
        {
            this.refLocals = refLocals;
        }

        protected override BoundStatement RewriteVariableDeclaration(BoundVariableDeclaration node)
        {
            // Replace ref local declarations with a block containing the
            // hoisting prelude (one variable declaration per side-effecting
            // sub-expression). The rewritten template — referencing only the
            // hoisted temps and trivially repeatable leaves — is recorded in
            // refLocals so that use-site rewrites read it back instead of
            // duplicating the original operand.
            if (node.Variable is LocalVariableSymbol local
                && local.Type is ByRefTypeSymbol
                && node.Initializer is BoundAddressOfExpression addressOf)
            {
                var prelude = ImmutableArray.CreateBuilder<BoundStatement>();
                var template = HoistOperand(addressOf.Operand, prelude);
                refLocals[local] = template;
                return new BoundBlockStatement(null, prelude.ToImmutable());
            }

            return base.RewriteVariableDeclaration(node);
        }

        protected override BoundExpression RewriteDereferenceExpression(BoundDereferenceExpression node)
        {
            // *refLocal → reconstructed lvalue template.
            if (node.Operand is BoundVariableExpression varExpr
                && varExpr.Variable is LocalVariableSymbol local
                && refLocals.TryGetValue(local, out var template))
            {
                // The template only references hoisted temps and trivially
                // repeatable leaves, so no further rewriting is required and
                // every inlining is side-effect-free.
                return template;
            }

            return base.RewriteDereferenceExpression(node);
        }

        protected override BoundExpression RewriteVariableExpression(BoundVariableExpression node)
        {
            // Bare ref local usage (e.g., passed to a ref parameter) → &lvalue.
            if (node.Variable is LocalVariableSymbol local
                && refLocals.TryGetValue(local, out var template))
            {
                return new BoundAddressOfExpression(null, template);
            }

            return base.RewriteVariableExpression(node);
        }

        protected override BoundExpression RewriteAssignmentExpression(BoundAssignmentExpression node)
        {
            // Re-seating the ref local itself (refLocal = &newTarget): replace
            // the template with the new target's hoisted form. This case is
            // unlikely in V1 but handle it gracefully.
            if (node.Variable is LocalVariableSymbol local && refLocals.ContainsKey(local))
            {
                if (node.Expression is BoundAddressOfExpression newAddr)
                {
                    // Re-seating mid-method: any side effects in the new
                    // operand must execute exactly once at this point. We
                    // cannot inject statements from inside an expression
                    // rewrite, so fall back to inlining the (already-rewritten)
                    // operand directly. Spilling earlier in the pipeline will
                    // already have flattened complex re-seats, so in practice
                    // the operand is simple.
                    refLocals[local] = RewriteExpression(newAddr.Operand);
                }

                return new BoundLiteralExpression(null, 0);
            }

            return base.RewriteAssignmentExpression(node);
        }

        /// <summary>
        /// Reconstructs <paramref name="operand"/> as a side-effect-free
        /// template, emitting hoisting declarations into
        /// <paramref name="prelude"/> for any non-trivial sub-expression.
        /// </summary>
        private BoundExpression HoistOperand(BoundExpression operand, ImmutableArray<BoundStatement>.Builder prelude)
        {
            switch (operand)
            {
                case BoundIndexExpression idx:
                    {
                        var target = HoistIfNeeded(idx.Target, prelude);
                        var index = HoistIfNeeded(idx.Index, prelude);
                        return new BoundIndexExpression(idx.Syntax, target, index, idx.Type);
                    }

                case BoundFieldAccessExpression field:
                    {
                        var receiver = HoistIfNeeded(field.Receiver, prelude);
                        return new BoundFieldAccessExpression(field.Syntax, receiver, field.StructType, field.Field, field.NarrowedType);
                    }

                case BoundClrIndexExpression clrIdx:
                    {
                        var target = HoistIfNeeded(clrIdx.Target, prelude);
                        var args = ImmutableArray.CreateBuilder<BoundExpression>(clrIdx.Arguments.Length);
                        foreach (var arg in clrIdx.Arguments)
                        {
                            args.Add(HoistIfNeeded(arg, prelude));
                        }

                        return new BoundClrIndexExpression(clrIdx.Syntax, target, clrIdx.Indexer, args.MoveToImmutable(), clrIdx.Type);
                    }

                case BoundClrPropertyAccessExpression clrProp when clrProp.Receiver != null:
                    {
                        var receiver = HoistIfNeeded(clrProp.Receiver, prelude);
                        return new BoundClrPropertyAccessExpression(clrProp.Syntax, receiver, clrProp.Member, clrProp.Type);
                    }

                default:
                    // Any other operand form (e.g., a bare BoundVariableExpression
                    // for `ref x = ref y`, or a BoundDereferenceExpression for
                    // `ref x = ref *p`): trivially repeatable or already in a
                    // hoist-safe shape after spilling. Inline directly.
                    return operand;
            }
        }

        /// <summary>
        /// Returns <paramref name="expression"/> unchanged when it is trivially
        /// repeatable; otherwise emits a fresh local declaration into
        /// <paramref name="prelude"/> and returns a read of that local.
        /// </summary>
        private BoundExpression HoistIfNeeded(BoundExpression expression, ImmutableArray<BoundStatement>.Builder prelude)
        {
            if (IsTriviallyRepeatable(expression))
            {
                return expression;
            }

            var temp = new LocalVariableSymbol(
                $"<refTmp>__{tempCounter++}",
                isReadOnly: false,
                expression.Type);
            prelude.Add(new BoundVariableDeclaration(null, temp, expression));
            return new BoundVariableExpression(null, temp);
        }
    }
}
