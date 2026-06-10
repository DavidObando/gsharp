// <copyright file="IteratorMoveNextBodyBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable CS1591 // Missing XML comment for publicly visible type or member
#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1612 // Element parameter documentation should match
#pragma warning disable SA1572 // Summary documentation should have paramrefs
#pragma warning disable CS1572 // XML comment has a param tag
#pragma warning disable CS1573 // Parameter has no matching param tag
#pragma warning disable SA1512 // Single-line comments should not be followed by blank line
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1615 // Element return value should be documented

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Lowering.Iterators;

/// <summary>
/// Builds the <c>MoveNext()</c> method body for an iterator state machine.
/// Transforms the original function body by replacing each <c>yield</c> with
/// a state transition + return true, and adds a state-dispatch switch at entry.
/// </summary>
public static class IteratorMoveNextBodyBuilder
{
    /// <summary>
    /// Builds the MoveNext body and returns the lowered block statement.
    /// </summary>
    /// <param name="plan">The iterator state machine plan.</param>
    /// <param name="stateField">The state field symbol (parameter slot for state local).</param>
    /// <param name="currentField">The current field symbol (parameter slot for current local).</param>
    /// <param name="thisParameter">The this parameter for the instance method.</param>
    /// <returns>The lowered MoveNext body and the this parameter.</returns>
    public static IteratorMoveNextBody BuildWithFieldAccess(
        IteratorStateMachinePlan plan,
        FieldSymbol stateField,
        FieldSymbol currentField,
        ParameterSymbol thisParameter,
        StructSymbol smClass,
        Dictionary<VariableSymbol, FieldSymbol> hoistedFieldMap)
    {
        BoundExpression FieldRead(FieldSymbol field) =>
            new BoundFieldAccessExpression(null, new BoundVariableExpression(null, thisParameter), smClass, field);

        BoundExpression FieldWrite(FieldSymbol field, BoundExpression value) =>
            new BoundFieldAssignmentExpression(null, thisParameter, smClass, field, value);

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();

        // Pre-pass: locate each yield within the user's try-statement nesting.
        // For iterators we cannot keep user try-finally regions in MoveNext
        // because:
        //   * `ret` is illegal inside a CLR protected region, so the yield's
        //     `return true` cannot stay there, and
        //   * `leave` from the try would trigger the finally on every yield.
        // Instead, the user try-finally is removed in MoveNext: the try body
        // is inlined followed by the finally body so that normal completion
        // still runs cleanup. Dispose handles premature termination by
        // running the pending finallies based on the current suspension state.
        var tryDispatch = IteratorTryDispatchPlanner.Plan(plan.Body, plan.YieldStates);

        var yieldLabels = new Dictionary<int, BoundLabel>();
        foreach (var kvp in plan.YieldStates.OrderBy(p => p.Value))
        {
            var label = tryDispatch.GetResumeLabel(kvp.Value)
                        ?? new BoundLabel($"$iterResume_{kvp.Value}");
            yieldLabels[kvp.Value] = label;
        }

        var startLabel = new BoundLabel("$iterStart");
        var endLabel = new BoundLabel("$iterEnd");

        statements.Add(new BoundConditionalGotoStatement(
            null,
            startLabel,
            new BoundBinaryExpression(
                null,
                FieldRead(stateField),
                BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                new BoundLiteralExpression(null, 0)),
            jumpIfTrue: true));

        foreach (var kvp in plan.YieldStates.OrderBy(p => p.Value))
        {
            // Because we remove the user's try wrappers in MoveNext (see
            // above), the outer dispatch can jump directly to the resume
            // label — there is no protected region to route around.
            statements.Add(new BoundConditionalGotoStatement(
                null,
                yieldLabels[kvp.Value],
                new BoundBinaryExpression(
                    null,
                    FieldRead(stateField),
                    BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                    new BoundLiteralExpression(null, kvp.Value)),
                jumpIfTrue: true));
        }

        statements.Add(new BoundGotoStatement(null, endLabel));
        statements.Add(new BoundLabelStatement(null, startLabel));

        var rewriter = new FieldAccessYieldRewriter(smClass, thisParameter, stateField, currentField, hoistedFieldMap, yieldLabels, endLabel, tryDispatch, plan.YieldStates);
        var rewrittenBody = rewriter.RewriteStatement(plan.Body);
        if (rewrittenBody is BoundBlockStatement block)
        {
            statements.AddRange(block.Statements);
        }
        else
        {
            statements.Add(rewrittenBody);
        }

        statements.Add(new BoundLabelStatement(null, endLabel));
        statements.Add(new BoundExpressionStatement(null, FieldWrite(stateField, new BoundLiteralExpression(null, -1))));
        statements.Add(new BoundReturnStatement(null, new BoundLiteralExpression(null, false)));

        return new IteratorMoveNextBody(Lowerer.Lower(new BoundBlockStatement(null, statements.ToImmutable())), thisParameter);
    }

    /// <summary>
    /// Builds the <c>Dispose()</c> body for an iterator state machine.
    /// </summary>
    /// <remarks>
    /// <para>For each user <c>try { … } finally { … }</c> that contains
    /// <c>yield</c> statements, Dispose must run the <c>finally</c> block
    /// when invoked while the enumerator is suspended inside that try. The
    /// suspension is identified by the current state field value, which
    /// equals one of the yield states inside the try.</para>
    /// <para>Nested try-finally with yields produces innermost-first walking
    /// so that inner finallies run before their enclosers, matching the
    /// normal stack-unwinding semantics on <c>foreach</c> early break.</para>
    /// <para>If the iterator body contains no yields inside any try-finally
    /// the body is the trivial <c>state = -1; return;</c> as before.</para>
    /// </remarks>
    public static BoundBlockStatement BuildDisposeBody(
        IteratorStateMachinePlan plan,
        FieldSymbol stateField,
        ParameterSymbol thisParameter,
        StructSymbol smClass,
        Dictionary<VariableSymbol, FieldSymbol> hoistedFieldMap)
    {
        BoundExpression FieldRead(FieldSymbol field) =>
            new BoundFieldAccessExpression(null, new BoundVariableExpression(null, thisParameter), smClass, field);

        BoundExpression FieldWrite(FieldSymbol field, BoundExpression value) =>
            new BoundFieldAssignmentExpression(null, thisParameter, smClass, field, value);

        var tryDispatch = IteratorTryDispatchPlanner.Plan(plan.Body, plan.YieldStates);

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();

        // Walk pending try-finallies in innermost-first order. For each:
        //   if (<state matches a yield state inside this try>) {
        //     try { /* empty: leave triggers finally */ } finally { <user finally> }
        //   }
        // We always set state = -1 BEFORE the chain so the iterator is left
        // in the finished state even if a finally throws.
        statements.Add(new BoundExpressionStatement(null, FieldWrite(stateField, new BoundLiteralExpression(null, -1))));

        if (!tryDispatch.FinallyTrysInnermostFirst.IsDefaultOrEmpty)
        {
            // We need to compute the per-try yield-state membership using
            // the ORIGINAL (pre-Dispose-rewrite) state field. Capture it
            // into a local once so the chain of if/try-finally blocks all
            // observe the suspension state.
            var savedStateLocal = new LocalVariableSymbol("<>savedState", isReadOnly: true, TypeSymbol.Int32);

            // Restore: state = -1 was already written above; we keep it.
            // Replace the unconditional `state = -1` write with a local-init
            // that snapshots the current state, then writes -1.
            statements.Clear();
            statements.Add(new BoundVariableDeclaration(null, savedStateLocal, FieldRead(stateField)));
            statements.Add(new BoundExpressionStatement(null, FieldWrite(stateField, new BoundLiteralExpression(null, -1))));

            // For each try-finally that contains yields (innermost first):
            //   if (savedState == s1 || savedState == s2 || ...) {
            //     try {} finally { <rewritten user finally> }
            //   }
            foreach (var tryStmt in tryDispatch.FinallyTrysInnermostFirst)
            {
                var insideStates = tryDispatch.GetYieldStatesInTry(tryStmt);
                if (insideStates.IsDefaultOrEmpty)
                {
                    continue;
                }

                // Build OR-chain: savedState == s1 || savedState == s2 || ...
                BoundExpression condition = null;
                foreach (var s in insideStates)
                {
                    var eq = new BoundBinaryExpression(
                        null,
                        new BoundVariableExpression(null, savedStateLocal),
                        BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                        new BoundLiteralExpression(null, s));
                    condition = condition == null
                        ? eq
                        : new BoundBinaryExpression(
                            null,
                            condition,
                            BoundBinaryOperator.Bind(SyntaxKind.PipePipeToken, TypeSymbol.Bool, TypeSymbol.Bool),
                            eq);
                }

                // Rewrite the user's finally body so any references to
                // hoisted locals resolve to fields on the state machine
                // (Dispose has its own `this`, distinct from MoveNext's).
                var disposeRewriter = new FieldAccessRewriter(smClass, thisParameter, hoistedFieldMap);
                var rewrittenFinally = disposeRewriter.RewriteStatement(tryStmt.FinallyBlock);

                // try {} finally { … }
                var emptyTryBody = new BoundBlockStatement(null, ImmutableArray<BoundStatement>.Empty);
                var tryFinally = new BoundTryStatement(
                    null,
                    emptyTryBody,
                    ImmutableArray<BoundCatchClause>.Empty,
                    rewrittenFinally);

                statements.Add(new BoundIfStatement(null, condition, tryFinally, elseStatement: null));
            }
        }

        statements.Add(new BoundReturnStatement(null, null));

        return Lowerer.Lower(new BoundBlockStatement(null, statements.ToImmutable()));
    }

    /// <summary>
    /// Lightweight rewriter that maps hoisted local reads/writes to field
    /// accesses on the synthesized state machine, using the supplied
    /// <c>this</c> parameter (different per state-machine method).
    /// </summary>
    private sealed class FieldAccessRewriter : BoundTreeRewriter
    {
        private readonly StructSymbol smClass;
        private readonly ParameterSymbol thisParameter;
        private readonly Dictionary<VariableSymbol, FieldSymbol> fieldMap;

        public FieldAccessRewriter(
            StructSymbol smClass,
            ParameterSymbol thisParameter,
            Dictionary<VariableSymbol, FieldSymbol> fieldMap)
        {
            this.smClass = smClass;
            this.thisParameter = thisParameter;
            this.fieldMap = fieldMap;
        }

        protected override BoundExpression RewriteVariableExpression(BoundVariableExpression node)
        {
            if (this.fieldMap.TryGetValue(node.Variable, out var field))
            {
                return new BoundFieldAccessExpression(
                    null,
                    new BoundVariableExpression(null, this.thisParameter),
                    this.smClass,
                    field);
            }

            return node;
        }

        protected override BoundExpression RewriteAssignmentExpression(BoundAssignmentExpression node)
        {
            if (this.fieldMap.TryGetValue(node.Variable, out var field))
            {
                return new BoundFieldAssignmentExpression(
                    null,
                    this.thisParameter,
                    this.smClass,
                    field,
                    this.RewriteExpression(node.Expression));
            }

            return base.RewriteAssignmentExpression(node);
        }

        // Issue #655: explicitly rewrite field-access expressions whose
        // receiver is a BoundVariableExpression referencing the user-class
        // `this` (hoisted as <>4__this). Ensures the proxy load is applied
        // directly, protecting against regressions.
        protected override BoundExpression RewriteFieldAccessExpression(BoundFieldAccessExpression node)
        {
            if (node.Receiver is BoundVariableExpression varExpr
                && this.fieldMap.TryGetValue(varExpr.Variable, out var proxyField))
            {
                var rewrittenReceiver = new BoundFieldAccessExpression(
                    null,
                    new BoundVariableExpression(null, this.thisParameter),
                    this.smClass,
                    proxyField);
                return new BoundFieldAccessExpression(null, rewrittenReceiver, node.StructType, node.Field);
            }

            return base.RewriteFieldAccessExpression(node);
        }

        // Issue #641: rewrite field assignments whose receiver is the
        // user-class `this` (hoisted as <>4__this) to use an expression
        // receiver so the emitter loads the proxy field.
        protected override BoundExpression RewriteFieldAssignmentExpression(BoundFieldAssignmentExpression node)
        {
            var value = this.RewriteExpression(node.Value);
            if (node.Receiver != null && this.fieldMap.TryGetValue(node.Receiver, out var proxyField))
            {
                var receiverExpr = new BoundFieldAccessExpression(
                    null,
                    new BoundVariableExpression(null, this.thisParameter),
                    this.smClass,
                    proxyField);
                return BoundFieldAssignmentExpression.WithExpressionReceiver(null, receiverExpr, node.StructType, node.Field, value);
            }

            if (node.ReceiverExpression != null)
            {
                var receiverExpr = this.RewriteExpression(node.ReceiverExpression);
                if (!ReferenceEquals(value, node.Value) || !ReferenceEquals(receiverExpr, node.ReceiverExpression))
                {
                    return BoundFieldAssignmentExpression.WithExpressionReceiver(null, receiverExpr, node.StructType, node.Field, value);
                }
            }
            else if (!ReferenceEquals(value, node.Value))
            {
                return new BoundFieldAssignmentExpression(null, node.Receiver, node.StructType, node.Field, value);
            }

            return node;
        }

        protected override BoundStatement RewriteVariableDeclaration(BoundVariableDeclaration node)
        {
            if (this.fieldMap.TryGetValue(node.Variable, out var field))
            {
                return new BoundExpressionStatement(
                    null,
                    new BoundFieldAssignmentExpression(
                        null,
                        this.thisParameter,
                        this.smClass,
                        field,
                        this.RewriteExpression(node.Initializer)));
            }

            return base.RewriteVariableDeclaration(node);
        }
    }

    public static IteratorMoveNextBody Build(
        IteratorStateMachinePlan plan,
        VariableSymbol stateLocal,
        VariableSymbol currentLocal,
        ParameterSymbol thisParameter)
    {
        // The MoveNext body is:
        // 1. switch(state) { case 0: goto start; case 1: goto resume1; ... default: goto end; }
        // 2. start: [user body with yields replaced by: current=x; state=K; return true; resumeK: state=0; ...]
        // 3. end: state=-1; return false;

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();

        // Create labels for each yield resume point
        var yieldLabels = new Dictionary<int, BoundLabel>();
        foreach (var kvp in plan.YieldStates.OrderBy(p => p.Value))
        {
            var label = new BoundLabel($"$iterResume_{kvp.Value}");
            yieldLabels[kvp.Value] = label;
        }

        var startLabel = new BoundLabel("$iterStart");
        var endLabel = new BoundLabel("$iterEnd");

        // State dispatch: if state == 0 goto start; if state == K goto resumeK; else goto end
        statements.Add(new BoundConditionalGotoStatement(
            null,
            startLabel,
            new BoundBinaryExpression(
                null,
                new BoundVariableExpression(null, stateLocal),
                BoundBinaryOperator.Bind(Syntax.SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                new BoundLiteralExpression(null, 0)),
            jumpIfTrue: true));

        foreach (var kvp in plan.YieldStates.OrderBy(p => p.Value))
        {
            statements.Add(new BoundConditionalGotoStatement(
                null,
                yieldLabels[kvp.Value],
                new BoundBinaryExpression(
                    null,
                    new BoundVariableExpression(null, stateLocal),
                    BoundBinaryOperator.Bind(Syntax.SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                    new BoundLiteralExpression(null, kvp.Value)),
                jumpIfTrue: true));
        }

        // Default: goto end
        statements.Add(new BoundGotoStatement(null, endLabel));

        // start:
        statements.Add(new BoundLabelStatement(null, startLabel));

        // Rewrite the user body: replace yields with state transitions
        var rewriter = new YieldReplacer(stateLocal, currentLocal, yieldLabels, endLabel);
        var rewrittenBody = rewriter.RewriteStatement(plan.Body);

        // Flatten the body into the statement list
        if (rewrittenBody is BoundBlockStatement block)
        {
            statements.AddRange(block.Statements);
        }
        else
        {
            statements.Add(rewrittenBody);
        }

        // Fall through to end: state = -1; return false
        statements.Add(new BoundLabelStatement(null, endLabel));
        statements.Add(new BoundExpressionStatement(
            null,
            new BoundAssignmentExpression(null, stateLocal, new BoundLiteralExpression(null, -1))));
        statements.Add(new BoundReturnStatement(null, new BoundLiteralExpression(null, false)));

        var body = new BoundBlockStatement(null, statements.ToImmutable());
        return new IteratorMoveNextBody(body, thisParameter);
    }

    private sealed class FieldAccessYieldRewriter : BoundTreeRewriter
    {
        private readonly StructSymbol smClass;
        private readonly ParameterSymbol thisParameter;
        private readonly FieldSymbol stateField;
        private readonly FieldSymbol currentField;
        private readonly Dictionary<VariableSymbol, FieldSymbol> fieldMap;
        private readonly Dictionary<int, BoundLabel> yieldLabels;
        private readonly BoundLabel endLabel;
        private readonly IteratorTryDispatchPlan tryDispatch;
        private readonly IReadOnlyDictionary<BoundYieldStatement, int> yieldStateMap;

        // Stack of pending user-finally blocks during walk (innermost first).
        // A `return` lexically inside these trys must run each finally body
        // before jumping to endLabel, mirroring the CLR's normal stack
        // unwinding on `leave`. Yields do NOT consume this stack — the
        // finally is run lazily by Dispose on premature termination.
        private readonly Stack<BoundStatement> pendingFinallies = new Stack<BoundStatement>();

        public FieldAccessYieldRewriter(
            StructSymbol smClass,
            ParameterSymbol thisParameter,
            FieldSymbol stateField,
            FieldSymbol currentField,
            Dictionary<VariableSymbol, FieldSymbol> fieldMap,
            Dictionary<int, BoundLabel> yieldLabels,
            BoundLabel endLabel,
            IteratorTryDispatchPlan tryDispatch,
            IReadOnlyDictionary<BoundYieldStatement, int> yieldStateMap)
        {
            this.smClass = smClass;
            this.thisParameter = thisParameter;
            this.stateField = stateField;
            this.currentField = currentField;
            this.fieldMap = fieldMap;
            this.yieldLabels = yieldLabels;
            this.endLabel = endLabel;
            this.tryDispatch = tryDispatch;
            this.yieldStateMap = yieldStateMap;
        }

        protected override BoundExpression RewriteVariableExpression(BoundVariableExpression node)
        {
            if (this.fieldMap.TryGetValue(node.Variable, out var field))
            {
                return this.FieldRead(field);
            }

            return node;
        }

        protected override BoundExpression RewriteAssignmentExpression(BoundAssignmentExpression node)
        {
            if (this.fieldMap.TryGetValue(node.Variable, out var field))
            {
                return this.FieldWrite(field, this.RewriteExpression(node.Expression));
            }

            return base.RewriteAssignmentExpression(node);
        }

        // Issue #655: explicitly rewrite field-access expressions whose
        // receiver is a BoundVariableExpression referencing the user-class
        // `this` (hoisted as <>4__this). Ensures the proxy load is applied
        // directly, protecting against regressions.
        protected override BoundExpression RewriteFieldAccessExpression(BoundFieldAccessExpression node)
        {
            if (node.Receiver is BoundVariableExpression varExpr
                && this.fieldMap.TryGetValue(varExpr.Variable, out var proxyField))
            {
                var rewrittenReceiver = this.FieldRead(proxyField);
                return new BoundFieldAccessExpression(null, rewrittenReceiver, node.StructType, node.Field);
            }

            return base.RewriteFieldAccessExpression(node);
        }

        // Issue #641: rewrite field assignments whose receiver is the
        // user-class `this` (hoisted as <>4__this) to use an expression
        // receiver so the emitter loads the proxy field.
        protected override BoundExpression RewriteFieldAssignmentExpression(BoundFieldAssignmentExpression node)
        {
            var value = this.RewriteExpression(node.Value);
            if (node.Receiver != null && this.fieldMap.TryGetValue(node.Receiver, out var proxyField))
            {
                var receiverExpr = this.FieldRead(proxyField);
                return BoundFieldAssignmentExpression.WithExpressionReceiver(null, receiverExpr, node.StructType, node.Field, value);
            }

            if (node.ReceiverExpression != null)
            {
                var receiverExpr = this.RewriteExpression(node.ReceiverExpression);
                if (!ReferenceEquals(value, node.Value) || !ReferenceEquals(receiverExpr, node.ReceiverExpression))
                {
                    return BoundFieldAssignmentExpression.WithExpressionReceiver(null, receiverExpr, node.StructType, node.Field, value);
                }
            }
            else if (!ReferenceEquals(value, node.Value))
            {
                return new BoundFieldAssignmentExpression(null, node.Receiver, node.StructType, node.Field, value);
            }

            return node;
        }

        protected override BoundStatement RewriteVariableDeclaration(BoundVariableDeclaration node)
        {
            if (this.fieldMap.TryGetValue(node.Variable, out var field))
            {
                return new BoundExpressionStatement(null, this.FieldWrite(field, this.RewriteExpression(node.Initializer)));
            }

            return base.RewriteVariableDeclaration(node);
        }

        protected override BoundStatement RewriteYieldStatement(BoundYieldStatement node)
        {
            var state = this.yieldStateMap[node];
            var label = this.yieldLabels[state];
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            statements.Add(new BoundExpressionStatement(null, this.FieldWrite(this.currentField, this.RewriteExpression(node.Expression))));
            statements.Add(new BoundExpressionStatement(null, this.FieldWrite(this.stateField, new BoundLiteralExpression(null, state))));
            statements.Add(new BoundReturnStatement(null, new BoundLiteralExpression(null, true)));
            statements.Add(new BoundLabelStatement(null, label));
            statements.Add(new BoundExpressionStatement(null, this.FieldWrite(this.stateField, new BoundLiteralExpression(null, 0))));
            return new BoundBlockStatement(null, statements.ToImmutable());
        }

        protected override BoundStatement RewriteTryStatement(BoundTryStatement node)
        {
            // Inspect whether this try contains any yields. If not, leave
            // it intact (a normal protected region with no resume needs).
            var statesInside = this.tryDispatch.GetYieldStatesInTry(node);
            if (statesInside.IsDefaultOrEmpty)
            {
                return base.RewriteTryStatement(node);
            }

            // The user try contains yields. We cannot keep it as a CLR
            // protected region in MoveNext because the yield's `return true`
            // would be illegal inside the try, and a `leave` would run the
            // finally on every yield. Instead, we remove the try wrapper:
            //   * Inline the rewritten try body.
            //   * If a finally is present, inline it after the body so that
            //     normal completion still runs cleanup.
            //   * Premature termination (early break / Dispose) is handled
            //     by the synthesized Dispose body, which runs the same
            //     finally based on the current state.
            //
            // Catch clauses are not supported when the try contains yields
            // (the language disallows this). If present we drop them; this
            // is conservative and matches the C# iterator restriction.
            if (node.FinallyBlock != null)
            {
                this.pendingFinallies.Push(node.FinallyBlock);
            }

            BoundStatement rewrittenTryBody;
            try
            {
                rewrittenTryBody = this.RewriteStatement(node.TryBlock);
            }
            finally
            {
                if (node.FinallyBlock != null)
                {
                    this.pendingFinallies.Pop();
                }
            }

            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            if (rewrittenTryBody is BoundBlockStatement b)
            {
                statements.AddRange(b.Statements);
            }
            else
            {
                statements.Add(rewrittenTryBody);
            }

            if (node.FinallyBlock != null)
            {
                // Finally body is rewritten with the same field-access /
                // local-hoisting transforms (but the finally itself does
                // not contain yields by language rule, so the yield
                // rewriter is a safe pass-through here).
                var rewrittenFinally = this.RewriteStatement(node.FinallyBlock);
                if (rewrittenFinally is BoundBlockStatement fb)
                {
                    statements.AddRange(fb.Statements);
                }
                else
                {
                    statements.Add(rewrittenFinally);
                }
            }

            return new BoundBlockStatement(null, statements.ToImmutable());
        }

        protected override BoundStatement RewriteReturnStatement(BoundReturnStatement node)
        {
            // `return` inside an iterator terminates enumeration. Run any
            // pending user-finally blocks (innermost first) before jumping
            // to the end label, mirroring CLR `leave` unwinding semantics.
            if (this.pendingFinallies.Count == 0)
            {
                return new BoundGotoStatement(null, this.endLabel);
            }

            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            foreach (var finallyBlock in this.pendingFinallies)
            {
                var rewrittenFinally = this.RewriteStatement(finallyBlock);
                if (rewrittenFinally is BoundBlockStatement fb)
                {
                    statements.AddRange(fb.Statements);
                }
                else
                {
                    statements.Add(rewrittenFinally);
                }
            }

            statements.Add(new BoundGotoStatement(null, this.endLabel));
            return new BoundBlockStatement(null, statements.ToImmutable());
        }

        private BoundExpression FieldRead(FieldSymbol field) =>
            new BoundFieldAccessExpression(null, new BoundVariableExpression(null, this.thisParameter), this.smClass, field);

        private BoundExpression FieldWrite(FieldSymbol field, BoundExpression value) =>
            new BoundFieldAssignmentExpression(null, this.thisParameter, this.smClass, field, value);
    }

    private sealed class YieldReplacer : BoundTreeRewriter
    {
        private readonly VariableSymbol stateLocal;
        private readonly VariableSymbol currentLocal;
        private readonly Dictionary<int, BoundLabel> yieldLabels;
        private readonly BoundLabel endLabel;
        private int yieldIndex;

        public YieldReplacer(
            VariableSymbol stateLocal,
            VariableSymbol currentLocal,
            Dictionary<int, BoundLabel> yieldLabels,
            BoundLabel endLabel)
        {
            this.stateLocal = stateLocal;
            this.currentLocal = currentLocal;
            this.yieldLabels = yieldLabels;
            this.endLabel = endLabel;
        }

        protected override BoundStatement RewriteYieldStatement(BoundYieldStatement node)
        {
            yieldIndex++;
            var label = yieldLabels[yieldIndex];

            // current = expr; state = K; return true; resumeK: state = -1;
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            statements.Add(new BoundExpressionStatement(
                null,
                new BoundAssignmentExpression(null, currentLocal, node.Expression)));
            statements.Add(new BoundExpressionStatement(
                null,
                new BoundAssignmentExpression(null, stateLocal, new BoundLiteralExpression(null, yieldIndex))));
            statements.Add(new BoundReturnStatement(null, new BoundLiteralExpression(null, true)));
            statements.Add(new BoundLabelStatement(null, label));
            statements.Add(new BoundExpressionStatement(
                null,
                new BoundAssignmentExpression(null, stateLocal, new BoundLiteralExpression(null, -1))));

            return new BoundBlockStatement(null, statements.ToImmutable());
        }

        protected override BoundStatement RewriteReturnStatement(BoundReturnStatement node)
        {
            // In an iterator, `return` (with or without value) means end iteration.
            return new BoundGotoStatement(null, endLabel);
        }
    }
}

/// <summary>
/// The result of building a MoveNext body.
/// </summary>
public sealed class IteratorMoveNextBody
{
    /// <summary>Initializes a new instance of the <see cref="IteratorMoveNextBody"/> class.</summary>
    public IteratorMoveNextBody(BoundBlockStatement body, ParameterSymbol thisParameter)
    {
        Body = body;
        ThisParameter = thisParameter;
    }

    /// <summary>Gets the lowered MoveNext body.</summary>
    public BoundBlockStatement Body { get; }

    /// <summary>Gets the this parameter.</summary>
    public ParameterSymbol ThisParameter { get; }
}
