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

using System.Collections.Generic;
using System.Collections.Immutable;
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

        var yieldLabels = new Dictionary<int, BoundLabel>();
        foreach (var kvp in plan.YieldStates)
        {
            var label = new BoundLabel($"$iterResume_{kvp.Value}");
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
                BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int, TypeSymbol.Int),
                new BoundLiteralExpression(null, 0)),
            jumpIfTrue: true));

        foreach (var kvp in plan.YieldStates)
        {
            statements.Add(new BoundConditionalGotoStatement(
                null,
                yieldLabels[kvp.Value],
                new BoundBinaryExpression(
                    null,
                    FieldRead(stateField),
                    BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int, TypeSymbol.Int),
                    new BoundLiteralExpression(null, kvp.Value)),
                jumpIfTrue: true));
        }

        statements.Add(new BoundGotoStatement(null, endLabel));
        statements.Add(new BoundLabelStatement(null, startLabel));

        var rewriter = new FieldAccessYieldRewriter(smClass, thisParameter, stateField, currentField, hoistedFieldMap, yieldLabels, endLabel);
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
        foreach (var kvp in plan.YieldStates)
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
                BoundBinaryOperator.Bind(Syntax.SyntaxKind.EqualsEqualsToken, TypeSymbol.Int, TypeSymbol.Int),
                new BoundLiteralExpression(null, 0)),
            jumpIfTrue: true));

        foreach (var kvp in plan.YieldStates)
        {
            statements.Add(new BoundConditionalGotoStatement(
                null,
                yieldLabels[kvp.Value],
                new BoundBinaryExpression(
                    null,
                    new BoundVariableExpression(null, stateLocal),
                    BoundBinaryOperator.Bind(Syntax.SyntaxKind.EqualsEqualsToken, TypeSymbol.Int, TypeSymbol.Int),
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
        private int yieldIndex;

        public FieldAccessYieldRewriter(
            StructSymbol smClass,
            ParameterSymbol thisParameter,
            FieldSymbol stateField,
            FieldSymbol currentField,
            Dictionary<VariableSymbol, FieldSymbol> fieldMap,
            Dictionary<int, BoundLabel> yieldLabels,
            BoundLabel endLabel)
        {
            this.smClass = smClass;
            this.thisParameter = thisParameter;
            this.stateField = stateField;
            this.currentField = currentField;
            this.fieldMap = fieldMap;
            this.yieldLabels = yieldLabels;
            this.endLabel = endLabel;
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
            this.yieldIndex++;
            var label = this.yieldLabels[this.yieldIndex];
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            statements.Add(new BoundExpressionStatement(null, this.FieldWrite(this.currentField, this.RewriteExpression(node.Expression))));
            statements.Add(new BoundExpressionStatement(null, this.FieldWrite(this.stateField, new BoundLiteralExpression(null, this.yieldIndex))));
            statements.Add(new BoundReturnStatement(null, new BoundLiteralExpression(null, true)));
            statements.Add(new BoundLabelStatement(null, label));
            statements.Add(new BoundExpressionStatement(null, this.FieldWrite(this.stateField, new BoundLiteralExpression(null, 0))));
            return new BoundBlockStatement(null, statements.ToImmutable());
        }

        protected override BoundStatement RewriteReturnStatement(BoundReturnStatement node)
        {
            return new BoundGotoStatement(null, this.endLabel);
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
