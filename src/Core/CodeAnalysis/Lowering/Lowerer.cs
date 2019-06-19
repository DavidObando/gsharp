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
        protected override BoundStatement RewriteForStatement(BoundForStatement node)
        {
            // for <var> := <lower> ... <upper>
            //      <body>
            //
            // ---->
            //
            // {
            //     var <var> = <lower>
            //     const upperBound = <upper>
            //     goto start
            //     body:
            //     <body>
            //     continue:
            //     <var> = <var> + 1
            //     start:
            //     gotoTrue <condition> body
            //     break:
            // }
            var variableDeclaration = new BoundVariableDeclaration(node.Variable, node.LowerBound);
            var upperBoundSymbol = new LocalVariableSymbol("upperBound", isReadOnly: true, type: TypeSymbol.Int);
            var upperBoundDeclaration = new BoundVariableDeclaration(upperBoundSymbol, node.UpperBound);
            var startLabel = GenerateLabel();
            var gotoStart = new BoundGotoStatement(startLabel);
            var bodyLabel = GenerateLabel();
            var bodyLabelStatement = new BoundLabelStatement(bodyLabel);
            var continueLabelStatement = new BoundLabelStatement(node.ContinueLabel);
            var variableExpression = new BoundVariableExpression(node.Variable);
            var increment = new BoundExpressionStatement(
                new BoundAssignmentExpression(
                    node.Variable,
                    new BoundBinaryExpression(
                        variableExpression,
                        BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.Int, TypeSymbol.Int),
                        new BoundLiteralExpression(1))));
            var startLabelStatement = new BoundLabelStatement(startLabel);
            var condition = new BoundBinaryExpression(
                variableExpression,
                BoundBinaryOperator.Bind(SyntaxKind.LessOrEqualsToken, TypeSymbol.Int, TypeSymbol.Int),
                new BoundVariableExpression(upperBoundSymbol));
            var gotoTrue = new BoundConditionalGotoStatement(bodyLabel, condition, jumpIfTrue: true);
            var breakLabelStatement = new BoundLabelStatement(node.BreakLabel);

            var result = new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(
                variableDeclaration,
                upperBoundDeclaration,
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
