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
        //
        // Issue #1618: user try-finally regions with yields ARE kept as real
        // CLR protected regions in MoveNext (see
        // FieldAccessYieldRewriter.RewriteTryStatement below), so the runtime
        // itself guarantees the finally runs on every exit path — normal
        // completion, an uncaught exception from the body, and an early
        // return/break — not just the happy path. Two problems that come
        // with keeping a real region are solved as follows:
        //   * `ret` is illegal inside a CLR protected region: the yield's
        //     `return true` is rewritten by the later Lowerer.Lower() pass
        //     (which already rewrites any return inside a protected region
        //     into a store-to-temp + goto a shared method-exit label,
        //     see Lowerer.RewriteReturnStatement) into a `goto` that the
        //     emitter turns into `leave`.
        //   * A `leave` from a yield must NOT run the finally (the iterator
        //     merely suspended, it isn't done): the finally is guarded by a
        //     check of the current suspension `state` — while suspended at
        //     one of this try's own yields, `state` equals that yield's
        //     number, which the guard excludes.
        //   * The CLR forbids branching into a protected region from
        //     outside it, so the outer state dispatch cannot jump directly
        //     to a resume label that lives inside a user try. Instead it
        //     routes to a synthesized entry label placed immediately before
        //     the (outermost) try, and an internal dispatch placed at the
        //     top of each try's body routes the rest of the way in.
        // Dispose still handles premature termination (disposal while
        // suspended) separately, by running the pending finallies based on
        // the saved suspension state.
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
            // Issue #1618: user try-finally regions with yields are now kept
            // as real CLR protected regions (see RewriteTryStatement below)
            // so an exception thrown from the body reliably runs the
            // finally. The CLR forbids branching into a protected region
            // from outside it, so a resume state that lives inside a user
            // try cannot be jumped to directly — the outer dispatch instead
            // routes to that try's synthesized entry label (placed just
            // before the try), which falls through into the region, then an
            // internal dispatch placed at the top of the try routes the
            // rest of the way to the actual resume label.
            var target = tryDispatch.GetOuterDispatchTarget(kvp.Value) ?? yieldLabels[kvp.Value];
            statements.Add(new BoundConditionalGotoStatement(
                null,
                target,
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

        // Issue #887: an index assignment (`arr[i] = v`, `m[k] = v`) whose
        // target temp is hoisted into a state-machine field can't reference the
        // field through its VariableSymbol target. Switch to the expression
        // target form reading the hoisted field (same fix as closure boxing,
        // issue #618).
        protected override BoundExpression RewriteIndexAssignmentExpression(BoundIndexAssignmentExpression node)
        {
            if (node.Target != null && this.fieldMap.TryGetValue(node.Target, out var targetField))
            {
                return BoundIndexAssignmentExpression.WithExpressionTarget(
                    null,
                    this.ReadHoistedField(targetField),
                    this.RewriteExpression(node.Index),
                    this.RewriteExpression(node.Value),
                    node.Type);
            }

            return base.RewriteIndexAssignmentExpression(node);
        }

        // Issue #887: same fix for CLR-indexer writes (e.g. `dict["k"] = v` or
        // `psi.Environment["k"] = v`) whose target temp is hoisted into a field.
        protected override BoundExpression RewriteClrIndexAssignmentExpression(BoundClrIndexAssignmentExpression node)
        {
            if (node.Target != null && this.fieldMap.TryGetValue(node.Target, out var targetField))
            {
                return BoundClrIndexAssignmentExpression.WithExpressionTarget(
                    null,
                    this.ReadHoistedField(targetField),
                    node.Indexer,
                    this.RewriteArguments(node.Arguments),
                    this.RewriteExpression(node.Value),
                    node.Type);
            }

            return base.RewriteClrIndexAssignmentExpression(node);
        }

        private ImmutableArray<BoundExpression> RewriteArguments(ImmutableArray<BoundExpression> arguments)
        {
            var builder = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
            foreach (var argument in arguments)
            {
                builder.Add(this.RewriteExpression(argument));
            }

            return builder.MoveToImmutable();
        }

        private BoundExpression ReadHoistedField(FieldSymbol field)
        {
            return new BoundFieldAccessExpression(
                null,
                new BoundVariableExpression(null, this.thisParameter),
                this.smClass,
                field);
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

        // Issue #887: an index assignment (`arr[i] = v`, `m[k] = v`) whose
        // target temp is hoisted into a state-machine field can't reference the
        // field through its VariableSymbol target. Switch to the expression
        // target form reading the hoisted field (same fix as closure boxing,
        // issue #618).
        protected override BoundExpression RewriteIndexAssignmentExpression(BoundIndexAssignmentExpression node)
        {
            if (node.Target != null && this.fieldMap.TryGetValue(node.Target, out var targetField))
            {
                return BoundIndexAssignmentExpression.WithExpressionTarget(
                    null,
                    this.FieldRead(targetField),
                    this.RewriteExpression(node.Index),
                    this.RewriteExpression(node.Value),
                    node.Type);
            }

            return base.RewriteIndexAssignmentExpression(node);
        }

        // Issue #887: same fix for CLR-indexer writes (e.g. `dict["k"] = v` or
        // `psi.Environment["k"] = v`) whose target temp is hoisted into a field.
        protected override BoundExpression RewriteClrIndexAssignmentExpression(BoundClrIndexAssignmentExpression node)
        {
            if (node.Target != null && this.fieldMap.TryGetValue(node.Target, out var targetField))
            {
                var args = ImmutableArray.CreateBuilder<BoundExpression>(node.Arguments.Length);
                foreach (var argument in node.Arguments)
                {
                    args.Add(this.RewriteExpression(argument));
                }

                return BoundClrIndexAssignmentExpression.WithExpressionTarget(
                    null,
                    this.FieldRead(targetField),
                    node.Indexer,
                    args.MoveToImmutable(),
                    this.RewriteExpression(node.Value),
                    node.Type);
            }

            return base.RewriteClrIndexAssignmentExpression(node);
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

            // Issue #1618: the user try contains yields. It is kept as a
            // REAL CLR protected region (rather than removed and inlined)
            // so the runtime itself guarantees the finally runs on every
            // exit path — normal completion, an exception thrown from the
            // body, and an early return/break — not only normal completion.
            //
            //   * Internal dispatch: a resumed call cannot jump directly to
            //     a resume label living inside this try (the CLR forbids
            //     branching into a protected region from outside it). The
            //     outer dispatch instead jumps to this try's entry label
            //     (prepended immediately before the try below), which falls
            //     through into an internal dispatch prepended to the try
            //     body that routes the rest of the way to the actual resume
            //     label (or to a nested try's own entry label).
            //   * Finally guard: `leave`-ing the try on a `yield` suspend
            //     must NOT run the finally — the iterator merely paused, it
            //     isn't done. The finally body is guarded so it only runs
            //     when the current suspension `state` is NOT one of this
            //     try's own yield states; that's true for a genuine exit
            //     (normal completion / exception / return) but false right
            //     after suspending (state was just set to the yield's own
            //     number).
            //
            // Catch clauses are not supported when the try contains yields
            // (the language disallows this). If present we drop them; this
            // is conservative and matches the C# iterator restriction.
            var rewrittenTryBody = this.RewriteStatement(node.TryBlock);

            var tryBodyStatements = ImmutableArray.CreateBuilder<BoundStatement>();
            var internalDispatch = this.tryDispatch.GetInternalDispatchEntries(node);
            if (!internalDispatch.IsDefaultOrEmpty)
            {
                foreach (var entry in internalDispatch)
                {
                    tryBodyStatements.Add(new BoundConditionalGotoStatement(
                        null,
                        entry.Target,
                        new BoundBinaryExpression(
                            null,
                            this.FieldRead(this.stateField),
                            BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                            new BoundLiteralExpression(null, entry.State)),
                        jumpIfTrue: true));
                }
            }

            if (rewrittenTryBody is BoundBlockStatement rewrittenBlock)
            {
                tryBodyStatements.AddRange(rewrittenBlock.Statements);
            }
            else
            {
                tryBodyStatements.Add(rewrittenTryBody);
            }

            BoundStatement result;
            if (node.FinallyBlock == null)
            {
                result = new BoundBlockStatement(null, tryBodyStatements.ToImmutable());
            }
            else
            {
                // Finally body is rewritten with the same field-access /
                // local-hoisting transforms (but the finally itself does
                // not contain yields by language rule, so the yield
                // rewriter is a safe pass-through here).
                var rewrittenFinally = this.RewriteStatement(node.FinallyBlock);

                BoundExpression suspendedAtOwnYield = null;
                foreach (var s in statesInside)
                {
                    var eq = new BoundBinaryExpression(
                        null,
                        this.FieldRead(this.stateField),
                        BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                        new BoundLiteralExpression(null, s));
                    suspendedAtOwnYield = suspendedAtOwnYield == null
                        ? eq
                        : new BoundBinaryExpression(
                            null,
                            suspendedAtOwnYield,
                            BoundBinaryOperator.Bind(SyntaxKind.PipePipeToken, TypeSymbol.Bool, TypeSymbol.Bool),
                            eq);
                }

                var notSuspended = new BoundUnaryExpression(
                    null,
                    BoundUnaryOperator.Bind(SyntaxKind.BangToken, TypeSymbol.Bool),
                    suspendedAtOwnYield);

                var guardedFinally = new BoundIfStatement(null, notSuspended, AsBlock(rewrittenFinally), elseStatement: null);

                result = new BoundTryStatement(
                    node.Syntax,
                    new BoundBlockStatement(null, tryBodyStatements.ToImmutable()),
                    ImmutableArray<BoundCatchClause>.Empty,
                    AsBlock(guardedFinally));
            }

            var entryLabel = this.tryDispatch.GetEntryLabel(node);
            if (entryLabel == null)
            {
                return result;
            }

            return new BoundBlockStatement(
                null,
                ImmutableArray.Create(new BoundLabelStatement(null, entryLabel), result));
        }

        protected override BoundStatement RewriteReturnStatement(BoundReturnStatement node)
        {
            // A bare `return` inside an iterator body means "stop
            // enumerating" (like `yield break`). Goto the shared end label,
            // which sets state = -1 and returns false. If this goto leaves
            // an enclosing user try (now a real CLR protected region — see
            // RewriteTryStatement above), the runtime automatically runs
            // that try's finally as part of the `leave`.
            return new BoundGotoStatement(null, this.endLabel);
        }

        private static BoundBlockStatement AsBlock(BoundStatement statement) =>
            statement as BoundBlockStatement ?? new BoundBlockStatement(null, ImmutableArray.Create(statement));

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
