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
/// records the address-of operand and inlines it at every use site:</para>
/// <list type="bullet">
/// <item><description><c>*refLocal</c> (dereference read) → replaced with the
/// operand expression directly.</description></item>
/// <item><description><c>refLocal</c> (bare pointer usage, e.g., passed to ref
/// parameter) → replaced with <c>&amp;operand</c>.</description></item>
/// </list>
/// <para>The ref local declaration is removed. The constituent variables in the
/// operand (array, index, receiver, etc.) remain in the tree and will be hoisted
/// normally by <see cref="AsyncCaptureWalker"/>.</para>
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

        // First pass: collect ref local → operand mappings.
        var refLocals = new Dictionary<LocalVariableSymbol, BoundExpression>();
        CollectRefLocals(body, refLocals);

        if (refLocals.Count == 0)
        {
            return body;
        }

        // Second pass: rewrite the tree.
        var rewriter = new Rewriter(refLocals);
        var result = (BoundBlockStatement)rewriter.RewriteStatement(body);
        return result;
    }

    private static void CollectRefLocals(BoundStatement statement, Dictionary<LocalVariableSymbol, BoundExpression> refLocals)
    {
        if (statement is BoundBlockStatement block)
        {
            foreach (var stmt in block.Statements)
            {
                CollectRefLocals(stmt, refLocals);
            }
        }
        else if (statement is BoundVariableDeclaration decl
            && decl.Variable is LocalVariableSymbol local
            && local.Type is ByRefTypeSymbol
            && decl.Initializer is BoundAddressOfExpression addressOf)
        {
            refLocals[local] = addressOf.Operand;
        }
        else if (statement is BoundIfStatement ifStmt)
        {
            CollectRefLocals(ifStmt.ThenStatement, refLocals);
            if (ifStmt.ElseStatement != null)
            {
                CollectRefLocals(ifStmt.ElseStatement, refLocals);
            }
        }
        else if (statement is BoundTryStatement tryStmt)
        {
            CollectRefLocals(tryStmt.TryBlock, refLocals);
            foreach (var clause in tryStmt.CatchClauses)
            {
                CollectRefLocals(clause.Body, refLocals);
            }

            if (tryStmt.FinallyBlock != null)
            {
                CollectRefLocals(tryStmt.FinallyBlock, refLocals);
            }
        }
    }

    private sealed class Rewriter : BoundTreeRewriter
    {
        private readonly Dictionary<LocalVariableSymbol, BoundExpression> refLocals;

        public Rewriter(Dictionary<LocalVariableSymbol, BoundExpression> refLocals)
        {
            this.refLocals = refLocals;
        }

        protected override BoundStatement RewriteVariableDeclaration(BoundVariableDeclaration node)
        {
            // Remove ref local declarations entirely.
            if (node.Variable is LocalVariableSymbol local && refLocals.ContainsKey(local))
            {
                return new BoundBlockStatement(ImmutableArray<BoundStatement>.Empty);
            }

            return base.RewriteVariableDeclaration(node);
        }

        protected override BoundExpression RewriteDereferenceExpression(BoundDereferenceExpression node)
        {
            // *refLocal → operand (the underlying lvalue expression)
            if (node.Operand is BoundVariableExpression varExpr
                && varExpr.Variable is LocalVariableSymbol local
                && refLocals.TryGetValue(local, out var operand))
            {
                // Recursively rewrite the operand in case it references other ref locals.
                return RewriteExpression(operand);
            }

            return base.RewriteDereferenceExpression(node);
        }

        protected override BoundExpression RewriteVariableExpression(BoundVariableExpression node)
        {
            // Bare ref local usage (e.g., passed to ref parameter) → &operand
            if (node.Variable is LocalVariableSymbol local
                && refLocals.TryGetValue(local, out var operand))
            {
                var rewrittenOperand = RewriteExpression(operand);
                return new BoundAddressOfExpression(rewrittenOperand);
            }

            return base.RewriteVariableExpression(node);
        }

        protected override BoundExpression RewriteAssignmentExpression(BoundAssignmentExpression node)
        {
            // Assignment to a ref local variable itself (re-seating the ref):
            // refLocal = &newTarget → remove (we'll use the ORIGINAL operand at use sites)
            // This case is unlikely in V1 but handle gracefully.
            if (node.Variable is LocalVariableSymbol local && refLocals.ContainsKey(local))
            {
                // Re-seating is not supported in this slice. If the RHS is a new
                // address-of, update the mapping. Otherwise, return a no-op.
                if (node.Expression is BoundAddressOfExpression newAddr)
                {
                    refLocals[local] = newAddr.Operand;
                }

                // Return a dummy expression (literal 0 cast away) — the statement
                // wrapping this will be a no-op expression statement.
                return new BoundLiteralExpression(0);
            }

            return base.RewriteAssignmentExpression(node);
        }
    }
}
