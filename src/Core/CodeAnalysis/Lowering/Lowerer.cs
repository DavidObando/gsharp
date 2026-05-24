// <copyright file="Lowerer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Lowering;

/// <summary>
/// Bound tree lowerer. It simplifies the AST.
/// </summary>
public sealed class Lowerer : BoundTreeRewriter
{
    private int labelCount;

    private Lowerer()
    {
    }

    /// <summary>
    /// Produces a lowered version of the supplied bound statement.
    /// </summary>
    /// <param name="statement">The bound statement.</param>
    /// <returns>A lowered version of the bound statement.</returns>
    public static BoundBlockStatement Lower(BoundStatement statement)
    {
        var lowerer = new Lowerer();
        var result = lowerer.RewriteStatement(statement);
        return Flatten(result);
    }

    /// <inheritdoc/>
    protected override BoundStatement RewriteIfStatement(BoundIfStatement node)
    {
        if (node.ElseStatement == null)
        {
            // if <condition>
            //      <then>
            //
            // ---->
            //
            // gotoFalse <condition> end
            // <then>
            // end:
            var endLabel = GenerateLabel();
            var gotoFalse = new BoundConditionalGotoStatement(endLabel, node.Condition, false);
            var endLabelStatement = new BoundLabelStatement(endLabel);
            var result = new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(gotoFalse, node.ThenStatement, endLabelStatement));
            return RewriteStatement(result);
        }
        else
        {
            // if <condition>
            //      <then>
            // else
            //      <else>
            //
            // ---->
            //
            // gotoFalse <condition> else
            // <then>
            // goto end
            // else:
            // <else>
            // end:
            var elseLabel = GenerateLabel();
            var endLabel = GenerateLabel();

            var gotoFalse = new BoundConditionalGotoStatement(elseLabel, node.Condition, false);
            var gotoEndStatement = new BoundGotoStatement(endLabel);
            var elseLabelStatement = new BoundLabelStatement(elseLabel);
            var endLabelStatement = new BoundLabelStatement(endLabel);
            var result = new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(
                gotoFalse,
                node.ThenStatement,
                gotoEndStatement,
                elseLabelStatement,
                node.ElseStatement,
                endLabelStatement));
            return RewriteStatement(result);
        }
    }

    /// <inheritdoc/>
    protected override BoundStatement RewriteForInfiniteStatement(BoundForInfiniteStatement node)
    {
        // for
        //     <body>
        //
        // ---->
        //
        // {
        //     continue:
        //     <body>
        //     goto continue
        //     break:
        // }
        var continueLabelStatement = new BoundLabelStatement(node.ContinueLabel);
        var gotoContinue = new BoundGotoStatement(node.ContinueLabel);
        var breakLabelStatement = new BoundLabelStatement(node.BreakLabel);

        var result = new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(
            continueLabelStatement,
            node.Body,
            gotoContinue,
            breakLabelStatement));
        return RewriteStatement(result);
    }

    /// <inheritdoc/>
    protected override BoundStatement RewriteForEllipsisStatement(BoundForEllipsisStatement node)
    {
        // for <var> := <lower> ... <upper>
        //      <body>
        //
        // ---->
        //
        // {
        //     var <var> = <lower>
        //     const upperBound = <upper>
        //     var step = 1
        //     if <var> greaterthan upperBound {
        //          step = -1
        //     }
        //     goto start
        //     body:
        //     <body>
        //     continue:
        //     <var> = <var> + step
        //     start:
        //     gotoTrue ((step > 0 && lower < upper) || (step < 0 && lower > upper)) body
        //     break:
        // }
        var variableDeclaration = new BoundVariableDeclaration(node.Variable, node.LowerBound);
        var upperBoundSymbol = new LocalVariableSymbol("upperBound", isReadOnly: true, type: TypeSymbol.Int);
        var upperBoundDeclaration = new BoundVariableDeclaration(upperBoundSymbol, node.UpperBound);
        var stepBoundSymbol = new LocalVariableSymbol("step", isReadOnly: false, type: TypeSymbol.Int);
        var stepBoundDeclaration = new BoundVariableDeclaration(
            variable: stepBoundSymbol,
            initializer: new BoundLiteralExpression(1));
        var variableExpression = new BoundVariableExpression(node.Variable);
        var upperBoundExpression = new BoundVariableExpression(upperBoundSymbol);
        var stepBoundExpression = new BoundVariableExpression(stepBoundSymbol);
        var ifLowerIsGreaterThanUpperExpression = new BoundBinaryExpression(
            left: variableExpression,
            op: BoundBinaryOperator.Bind(SyntaxKind.GreaterToken, TypeSymbol.Int, TypeSymbol.Int),
            right: upperBoundExpression);
        var stepBoundAssingment = new BoundExpressionStatement(
            expression: new BoundAssignmentExpression(
                variable: stepBoundSymbol,
                expression: new BoundLiteralExpression(-1)));
        var ifLowerIsGreaterThanUpperIfStatement = new BoundIfStatement(
            condition: ifLowerIsGreaterThanUpperExpression,
            thenStatement: stepBoundAssingment,
            elseStatement: null);
        var startLabel = GenerateLabel();
        var gotoStart = new BoundGotoStatement(startLabel);
        var bodyLabel = GenerateLabel();
        var bodyLabelStatement = new BoundLabelStatement(bodyLabel);
        var continueLabelStatement = new BoundLabelStatement(node.ContinueLabel);
        var increment = new BoundExpressionStatement(
            expression: new BoundAssignmentExpression(
                variable: node.Variable,
                expression: new BoundBinaryExpression(
                    left: variableExpression,
                    op: BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.Int, TypeSymbol.Int),
                    right: stepBoundExpression)));
        var startLabelStatement = new BoundLabelStatement(startLabel);
        var zeroLiteralExpression = new BoundLiteralExpression(0);
        var stepGreaterThanZeroExpression = new BoundBinaryExpression(
            left: stepBoundExpression,
            op: BoundBinaryOperator.Bind(SyntaxKind.GreaterToken, TypeSymbol.Int, TypeSymbol.Int),
            right: zeroLiteralExpression);
        var lowerLessThanUpperExpression = new BoundBinaryExpression(
            left: variableExpression,
            op: BoundBinaryOperator.Bind(SyntaxKind.LessToken, TypeSymbol.Int, TypeSymbol.Int),
            right: upperBoundExpression);
        var positiveStepAndLowerLessThanUpper = new BoundBinaryExpression(
            left: stepGreaterThanZeroExpression,
            op: BoundBinaryOperator.Bind(SyntaxKind.AmpersandAmpersandToken, TypeSymbol.Bool, TypeSymbol.Bool),
            right: lowerLessThanUpperExpression);
        var stepLessThanZeroExpression = new BoundBinaryExpression(
            left: stepBoundExpression,
            op: BoundBinaryOperator.Bind(SyntaxKind.LessToken, TypeSymbol.Int, TypeSymbol.Int),
            right: zeroLiteralExpression);
        var lowerGreaterThanUpperExpression = new BoundBinaryExpression(
            left: variableExpression,
            op: BoundBinaryOperator.Bind(SyntaxKind.GreaterToken, TypeSymbol.Int, TypeSymbol.Int),
            right: upperBoundExpression);
        var negativeStepAndLowerGreaterThanUpper = new BoundBinaryExpression(
            left: stepLessThanZeroExpression,
            op: BoundBinaryOperator.Bind(SyntaxKind.AmpersandAmpersandToken, TypeSymbol.Bool, TypeSymbol.Bool),
            right: lowerGreaterThanUpperExpression);
        var condition = new BoundBinaryExpression(
            positiveStepAndLowerLessThanUpper,
            BoundBinaryOperator.Bind(SyntaxKind.PipePipeToken, TypeSymbol.Bool, TypeSymbol.Bool),
            negativeStepAndLowerGreaterThanUpper);
        var gotoTrue = new BoundConditionalGotoStatement(bodyLabel, condition, jumpIfTrue: true);
        var breakLabelStatement = new BoundLabelStatement(node.BreakLabel);

        var result = new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(
            variableDeclaration,
            upperBoundDeclaration,
            stepBoundDeclaration,
            ifLowerIsGreaterThanUpperIfStatement,
            gotoStart,
            bodyLabelStatement,
            node.Body,
            continueLabelStatement,
            increment,
            startLabelStatement,
            gotoTrue,
            breakLabelStatement));
        return RewriteStatement(result);
    }

    /// <inheritdoc/>
    protected override BoundStatement RewriteForRangeStatement(BoundForRangeStatement node)
    {
        // for [<k>,] <v> := range <coll>
        //     <body>
        //
        // ---->  (kind-dependent lowering — see helpers below)
        //
        // For arrays/slices (Indexed): index-based iteration using
        // BoundIndexExpression + BoundLenExpression.
        // For CLR dictionaries and enumerables: iterator-based iteration
        // using GetEnumerator()/MoveNext()/Current resolved by reflection.
        BoundStatement lowered = node.IterationKind switch
        {
            ForRangeKind.Indexed => LowerIndexedRange(node),
            ForRangeKind.Dictionary => LowerCollectionRange(node, isDictionary: true),
            ForRangeKind.Enumerable => LowerCollectionRange(node, isDictionary: false),
            _ => throw new System.InvalidOperationException($"Unknown ForRangeKind {node.IterationKind}"),
        };

        return RewriteStatement(lowered);
    }

    private BoundStatement LowerIndexedRange(BoundForRangeStatement node)
    {
        // {
        //   var __coll = <collection>
        //   var __i = 0
        //   goto start
        //   body:
        //   <key> = __i   (only if key var present)
        //   <value> = __coll[__i]
        //   <body>
        //   continue:
        //   __i = __i + 1
        //   start:
        //   gotoTrue (__i < len(__coll)) body
        //   break:
        // }
        var collectionSymbol = new LocalVariableSymbol("__coll", isReadOnly: true, type: node.Collection.Type);
        var collectionDecl = new BoundVariableDeclaration(collectionSymbol, node.Collection);
        var collectionExpr = new BoundVariableExpression(collectionSymbol);

        var indexSymbol = new LocalVariableSymbol("__i", isReadOnly: false, type: TypeSymbol.Int);
        var indexDecl = new BoundVariableDeclaration(indexSymbol, new BoundLiteralExpression(0));
        var indexExpr = new BoundVariableExpression(indexSymbol);

        var startLabel = GenerateLabel();
        var bodyLabel = GenerateLabel();

        var perIterationStatements = ImmutableArray.CreateBuilder<BoundStatement>();
        if (node.KeyVariable != null)
        {
            perIterationStatements.Add(new BoundVariableDeclaration(node.KeyVariable, indexExpr));
        }

        perIterationStatements.Add(new BoundVariableDeclaration(
            node.ValueVariable,
            new BoundIndexExpression(collectionExpr, indexExpr, node.ValueVariable.Type)));

        perIterationStatements.Add(node.Body);

        var increment = new BoundExpressionStatement(
            new BoundAssignmentExpression(
                indexSymbol,
                new BoundBinaryExpression(
                    indexExpr,
                    BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.Int, TypeSymbol.Int),
                    new BoundLiteralExpression(1))));

        var hasMore = new BoundBinaryExpression(
            indexExpr,
            BoundBinaryOperator.Bind(SyntaxKind.LessToken, TypeSymbol.Int, TypeSymbol.Int),
            new BoundLenExpression(collectionExpr));

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(collectionDecl);
        statements.Add(indexDecl);
        statements.Add(new BoundGotoStatement(startLabel));
        statements.Add(new BoundLabelStatement(bodyLabel));
        statements.AddRange(perIterationStatements);
        statements.Add(new BoundLabelStatement(node.ContinueLabel));
        statements.Add(increment);
        statements.Add(new BoundLabelStatement(startLabel));
        statements.Add(new BoundConditionalGotoStatement(bodyLabel, hasMore, jumpIfTrue: true));
        statements.Add(new BoundLabelStatement(node.BreakLabel));
        return new BoundBlockStatement(statements.ToImmutable());
    }

    private BoundStatement LowerCollectionRange(BoundForRangeStatement node, bool isDictionary)
    {
        // {
        //   var __enum = <coll>.GetEnumerator()
        //   var __i = 0    (only for Enumerable when keyVar is present)
        //   goto start
        //   body:
        //   <key> = __i  OR  __enum.Current.Key      (depending on kind)
        //   <value> = __enum.Current  OR  __enum.Current.Value
        //   <body>
        //   continue:
        //   __i = __i + 1   (only for Enumerable when keyVar is present)
        //   start:
        //   gotoTrue __enum.MoveNext() body
        //   break:
        // }
        var collClrType = node.Collection.Type.ClrType;
        var getEnumerator = collClrType.GetMethod("GetEnumerator", System.Type.EmptyTypes);
        if (getEnumerator == null)
        {
            // Defensive: bail out unchanged if we can't resolve. The
            // binder already validated this case, so this shouldn't fire.
            return new BoundExpressionStatement(new BoundErrorExpression());
        }

        var enumeratorClr = getEnumerator.ReturnType;
        var moveNext = enumeratorClr.GetMethod("MoveNext", System.Type.EmptyTypes)
                       ?? typeof(System.Collections.IEnumerator).GetMethod("MoveNext", System.Type.EmptyTypes);
        var currentProp = enumeratorClr.GetProperty("Current")
                          ?? typeof(System.Collections.IEnumerator).GetProperty("Current");

        var enumeratorType = TypeSymbol.FromClrType(enumeratorClr);
        var enumeratorSymbol = new LocalVariableSymbol("__enum", isReadOnly: true, type: enumeratorType);
        var getEnumCall = new BoundImportedInstanceCallExpression(
            node.Collection,
            getEnumerator,
            enumeratorType,
            ImmutableArray<BoundExpression>.Empty);
        var enumeratorDecl = new BoundVariableDeclaration(enumeratorSymbol, getEnumCall);
        var enumeratorExpr = new BoundVariableExpression(enumeratorSymbol);

        var startLabel = GenerateLabel();
        var bodyLabel = GenerateLabel();

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(enumeratorDecl);

        LocalVariableSymbol indexSymbol = null;
        if (!isDictionary && node.KeyVariable != null)
        {
            indexSymbol = new LocalVariableSymbol("__i", isReadOnly: false, type: TypeSymbol.Int);
            statements.Add(new BoundVariableDeclaration(indexSymbol, new BoundLiteralExpression(0)));
        }

        statements.Add(new BoundGotoStatement(startLabel));
        statements.Add(new BoundLabelStatement(bodyLabel));

        var currentAccess = new BoundClrPropertyAccessExpression(
            enumeratorExpr,
            currentProp,
            TypeSymbol.FromClrType(currentProp.PropertyType));

        if (isDictionary)
        {
            var kvpClr = currentProp.PropertyType;
            var keyProp = kvpClr.GetProperty("Key");
            var valueProp = kvpClr.GetProperty("Value");
            var kvpSymbol = new LocalVariableSymbol("__kvp", isReadOnly: true, type: TypeSymbol.FromClrType(kvpClr));
            statements.Add(new BoundVariableDeclaration(kvpSymbol, currentAccess));
            var kvpExpr = new BoundVariableExpression(kvpSymbol);

            if (node.KeyVariable != null)
            {
                statements.Add(new BoundVariableDeclaration(
                    node.KeyVariable,
                    new BoundClrPropertyAccessExpression(kvpExpr, keyProp, TypeSymbol.FromClrType(keyProp.PropertyType))));
            }

            statements.Add(new BoundVariableDeclaration(
                node.ValueVariable,
                new BoundClrPropertyAccessExpression(kvpExpr, valueProp, TypeSymbol.FromClrType(valueProp.PropertyType))));
        }
        else
        {
            if (node.KeyVariable != null)
            {
                statements.Add(new BoundVariableDeclaration(node.KeyVariable, new BoundVariableExpression(indexSymbol)));
            }

            statements.Add(new BoundVariableDeclaration(node.ValueVariable, currentAccess));
        }

        statements.Add(node.Body);
        statements.Add(new BoundLabelStatement(node.ContinueLabel));

        if (indexSymbol != null)
        {
            var indexExpr = new BoundVariableExpression(indexSymbol);
            statements.Add(new BoundExpressionStatement(
                new BoundAssignmentExpression(
                    indexSymbol,
                    new BoundBinaryExpression(
                        indexExpr,
                        BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.Int, TypeSymbol.Int),
                        new BoundLiteralExpression(1)))));
        }

        statements.Add(new BoundLabelStatement(startLabel));
        var moveNextCall = new BoundImportedInstanceCallExpression(
            enumeratorExpr,
            moveNext,
            TypeSymbol.Bool,
            ImmutableArray<BoundExpression>.Empty);
        statements.Add(new BoundConditionalGotoStatement(bodyLabel, moveNextCall, jumpIfTrue: true));
        statements.Add(new BoundLabelStatement(node.BreakLabel));
        return new BoundBlockStatement(statements.ToImmutable());
    }

    private static BoundBlockStatement Flatten(BoundStatement statement)
    {
        var builder = ImmutableArray.CreateBuilder<BoundStatement>();
        var stack = new Stack<BoundStatement>();
        stack.Push(statement);

        while (stack.Count > 0)
        {
            var current = stack.Pop();

            if (current is BoundBlockStatement block)
            {
                foreach (var s in block.Statements.Reverse())
                {
                    stack.Push(s);
                }
            }
            else if (current is BoundTryStatement t)
            {
                var flatTry = Flatten(t.TryBlock);
                var flatCatches = ImmutableArray.CreateBuilder<BoundCatchClause>();
                foreach (var clause in t.CatchClauses)
                {
                    flatCatches.Add(new BoundCatchClause(clause.ExceptionType, clause.Variable, Flatten(clause.Body)));
                }

                var flatFinally = t.FinallyBlock == null ? null : (BoundStatement)Flatten(t.FinallyBlock);
                builder.Add(new BoundTryStatement(flatTry, flatCatches.ToImmutable(), flatFinally));
            }
            else if (current is BoundScopeStatement scope)
            {
                // Phase 5.7: flatten the scope body so the evaluator's flat-statement
                // walker sees lowered gotos/conditionals instead of nested blocks.
                var flatScopeBody = Flatten(scope.Body);
                builder.Add(new BoundScopeStatement(flatScopeBody));
            }
            else if (current is BoundSelectStatement sel)
            {
                // Phase 5.6: flatten each case body for the same reason.
                var flatCases = ImmutableArray.CreateBuilder<BoundSelectCase>(sel.Cases.Length);
                foreach (var arm in sel.Cases)
                {
                    var flatArmBody = Flatten(arm.Body);
                    flatCases.Add(new BoundSelectCase(arm.CaseKind, arm.Channel, arm.Value, arm.Variable, flatArmBody));
                }

                builder.Add(new BoundSelectStatement(flatCases.ToImmutable()));
            }
            else if (current is BoundAwaitForRangeStatement af)
            {
                // Phase 5.8: flatten the await-for body so nested if/for/etc. work.
                var flatAfBody = Flatten(af.Body);
                builder.Add(new BoundAwaitForRangeStatement(af.ValueVariable, af.Stream, flatAfBody));
            }
            else
            {
                builder.Add(current);
            }
        }

        return new BoundBlockStatement(builder.ToImmutable());
    }

    private BoundLabel GenerateLabel()
    {
        var name = $"Label{++labelCount}";
        return new BoundLabel(name);
    }
}
