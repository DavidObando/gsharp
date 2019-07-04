// <copyright file="Lowerer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Lowering
{
    using System.Collections.Generic;
    using System.Collections.Immutable;
    using System.Linq;
    using GSharp.Core.CodeAnalysis.Binding;
    using GSharp.Core.CodeAnalysis.Symbols;
    using GSharp.Core.CodeAnalysis.Syntax;

    /// <summary>
    /// Bound tree lowerer. It simplifies the AST.
    /// </summary>
    internal sealed class Lowerer : BoundTreeRewriter
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
}
