// <copyright file="BoundNodePrinter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using System;
    using System.CodeDom.Compiler;
    using System.IO;
    using GSharp.Core.CodeAnalysis.Symbols;
    using GSharp.Core.CodeAnalysis.Syntax;
    using GSharp.Core.IO;

    /// <summary>
    /// Helps print bound nodes in an idiomatic way.
    /// </summary>
    public static class BoundNodePrinter
    {
        /// <summary>
        /// Writes a bound node to the specified text writer.
        /// </summary>
        /// <param name="node">The bound node.</param>
        /// <param name="writer">The text writer.</param>
        public static void WriteTo(this BoundNode node, TextWriter writer)
        {
            if (writer is IndentedTextWriter iw)
            {
                WriteTo(node, iw);
            }
            else
            {
                WriteTo(node, new IndentedTextWriter(writer));
            }
        }

        /// <summary>
        /// Writes a bound node to the specified text writer.
        /// </summary>
        /// <param name="node">The bound node.</param>
        /// <param name="writer">The text writer.</param>
        public static void WriteTo(this BoundNode node, IndentedTextWriter writer)
        {
            switch (node.Kind)
            {
                case BoundNodeKind.BlockStatement:
                    WriteBlockStatement((BoundBlockStatement)node, writer);
                    break;
                case BoundNodeKind.VariableDeclaration:
                    WriteVariableDeclaration((BoundVariableDeclaration)node, writer);
                    break;
                case BoundNodeKind.IfStatement:
                    WriteIfStatement((BoundIfStatement)node, writer);
                    break;
                case BoundNodeKind.ForInfiniteStatement:
                    WriteForInfiniteStatement((BoundForInfiniteStatement)node, writer);
                    break;
                case BoundNodeKind.ForEllipsisStatement:
                    WriteForEllipsisStatement((BoundForEllipsisStatement)node, writer);
                    break;
                case BoundNodeKind.LabelStatement:
                    WriteLabelStatement((BoundLabelStatement)node, writer);
                    break;
                case BoundNodeKind.GotoStatement:
                    WriteGotoStatement((BoundGotoStatement)node, writer);
                    break;
                case BoundNodeKind.ConditionalGotoStatement:
                    WriteConditionalGotoStatement((BoundConditionalGotoStatement)node, writer);
                    break;
                case BoundNodeKind.ReturnStatement:
                    WriteReturnStatement((BoundReturnStatement)node, writer);
                    break;
                case BoundNodeKind.ExpressionStatement:
                    WriteExpressionStatement((BoundExpressionStatement)node, writer);
                    break;
                case BoundNodeKind.ErrorExpression:
                    WriteErrorExpression((BoundErrorExpression)node, writer);
                    break;
                case BoundNodeKind.LiteralExpression:
                    WriteLiteralExpression((BoundLiteralExpression)node, writer);
                    break;
                case BoundNodeKind.VariableExpression:
                    WriteVariableExpression((BoundVariableExpression)node, writer);
                    break;
                case BoundNodeKind.AssignmentExpression:
                    WriteAssignmentExpression((BoundAssignmentExpression)node, writer);
                    break;
                case BoundNodeKind.UnaryExpression:
                    WriteUnaryExpression((BoundUnaryExpression)node, writer);
                    break;
                case BoundNodeKind.BinaryExpression:
                    WriteBinaryExpression((BoundBinaryExpression)node, writer);
                    break;
                case BoundNodeKind.CallExpression:
                    WriteCallExpression((BoundCallExpression)node, writer);
                    break;
                case BoundNodeKind.ConversionExpression:
                    WriteConversionExpression((BoundConversionExpression)node, writer);
                    break;
                default:
                    throw new Exception($"Unexpected node {node.Kind}");
            }
        }

        private static void WriteNestedStatement(this IndentedTextWriter writer, BoundStatement node)
        {
            var needsIndentation = !(node is BoundBlockStatement);

            if (needsIndentation)
            {
                writer.Indent++;
            }

            node.WriteTo(writer);

            if (needsIndentation)
            {
                writer.Indent--;
            }
        }

        private static void WriteNestedExpression(this IndentedTextWriter writer, int parentPrecedence, BoundExpression expression)
        {
            if (expression is BoundUnaryExpression unary)
            {
                writer.WriteNestedExpression(parentPrecedence, SyntaxFacts.GetUnaryOperatorPrecedence(unary.Op.SyntaxKind), unary);
            }
            else if (expression is BoundBinaryExpression binary)
            {
                writer.WriteNestedExpression(parentPrecedence, SyntaxFacts.GetBinaryOperatorPrecedence(binary.Op.SyntaxKind), binary);
            }
            else
            {
                expression.WriteTo(writer);
            }
        }

        private static void WriteNestedExpression(this IndentedTextWriter writer, int parentPrecedence, int currentPrecedence, BoundExpression expression)
        {
            var needsParenthesis = parentPrecedence >= currentPrecedence;

            if (needsParenthesis)
            {
                writer.WritePunctuation(SyntaxKind.OpenParenthesisToken);
            }

            expression.WriteTo(writer);

            if (needsParenthesis)
            {
                writer.WritePunctuation(SyntaxKind.CloseParenthesisToken);
            }
        }

        private static void WriteBlockStatement(BoundBlockStatement node, IndentedTextWriter writer)
        {
            writer.WritePunctuation(SyntaxKind.OpenBraceToken);
            writer.WriteLine();
            writer.Indent++;

            foreach (var s in node.Statements)
            {
                s.WriteTo(writer);
            }

            writer.Indent--;
            writer.WritePunctuation(SyntaxKind.CloseBraceToken);
            writer.WriteLine();
        }

        private static void WriteVariableDeclaration(BoundVariableDeclaration node, IndentedTextWriter writer)
        {
            if (node.Variable.IsReadOnly)
            {
                writer.WriteKeyword(SyntaxKind.ConstKeyword);
                writer.WriteSpace();
            }

            writer.WriteIdentifier(node.Variable.Name);
            writer.WriteSpace();
            if (node.Variable.IsReadOnly)
            {
                writer.WritePunctuation(SyntaxKind.EqualsToken);
            }
            else
            {
                writer.WritePunctuation(SyntaxKind.ColonEqualsToken);
            }

            writer.WriteSpace();
            node.Initializer.WriteTo(writer);
            writer.WriteLine();
        }

        private static void WriteIfStatement(BoundIfStatement node, IndentedTextWriter writer)
        {
            writer.WriteKeyword(SyntaxKind.IfKeyword);
            writer.WriteSpace();
            node.Condition.WriteTo(writer);
            writer.WriteSpace();
            writer.WriteNestedStatement(node.ThenStatement);

            if (node.ElseStatement != null)
            {
                writer.WriteKeyword(SyntaxKind.ElseKeyword);
                writer.WriteSpace();
                writer.WriteNestedStatement(node.ElseStatement);
            }
        }

        private static void WriteForInfiniteStatement(BoundForInfiniteStatement node, IndentedTextWriter writer)
        {
            writer.WriteKeyword(SyntaxKind.ForKeyword);
            writer.WriteSpace();
            writer.WriteNestedStatement(node.Body);
        }

        private static void WriteForEllipsisStatement(BoundForEllipsisStatement node, IndentedTextWriter writer)
        {
            writer.WriteKeyword(SyntaxKind.ForKeyword);
            writer.WriteSpace();
            writer.WriteIdentifier(node.Variable.Name);
            writer.WriteSpace();
            writer.WritePunctuation(SyntaxKind.ColonEqualsToken);
            writer.WriteSpace();
            node.LowerBound.WriteTo(writer);
            writer.WriteSpace();
            writer.WriteKeyword(SyntaxKind.EllipsisToken);
            writer.WriteSpace();
            node.UpperBound.WriteTo(writer);
            writer.WriteSpace();
            writer.WriteNestedStatement(node.Body);
        }

        private static void WriteLabelStatement(BoundLabelStatement node, IndentedTextWriter writer)
        {
            var unindent = writer.Indent > 0;
            if (unindent)
            {
                writer.Indent--;
            }

            writer.WritePunctuation(node.Label.Name);
            writer.WritePunctuation(SyntaxKind.ColonToken);
            writer.WriteLine();

            if (unindent)
            {
                writer.Indent++;
            }
        }

        private static void WriteGotoStatement(BoundGotoStatement node, IndentedTextWriter writer)
        {
            writer.WriteKeyword("goto ");
            writer.WriteIdentifier(node.Label.Name);
            writer.WriteLine();
        }

        private static void WriteConditionalGotoStatement(BoundConditionalGotoStatement node, IndentedTextWriter writer)
        {
            writer.WriteKeyword("goto ");
            writer.WriteIdentifier(node.Label.Name);
            writer.WriteKeyword(node.JumpIfTrue ? " if " : " unless ");
            node.Condition.WriteTo(writer);
            writer.WriteLine();
        }

        private static void WriteReturnStatement(BoundReturnStatement node, IndentedTextWriter writer)
        {
            writer.WriteKeyword(SyntaxKind.ReturnKeyword);
            if (node.Expression != null)
            {
                writer.WriteSpace();
                node.Expression.WriteTo(writer);
            }

            writer.WriteLine();
        }

        private static void WriteExpressionStatement(BoundExpressionStatement node, IndentedTextWriter writer)
        {
            node.Expression.WriteTo(writer);
            writer.WriteLine();
        }

        private static void WriteErrorExpression(BoundErrorExpression node, IndentedTextWriter writer)
        {
            writer.WriteKeyword(node.Type.Name);
        }

        private static void WriteLiteralExpression(BoundLiteralExpression node, IndentedTextWriter writer)
        {
            var value = node.Value.ToString();

            if (node.Type == TypeSymbol.Bool)
            {
                writer.WriteKeyword((bool)node.Value ? SyntaxKind.TrueKeyword : SyntaxKind.FalseKeyword);
            }
            else if (node.Type == TypeSymbol.Int)
            {
                writer.WriteNumber(value);
            }
            else if (node.Type == TypeSymbol.String)
            {
                value = "\"" + value.Replace("\"", "\\\"") + "\"";
                writer.WriteString(value);
            }
            else
            {
                throw new Exception($"Unexpected type {node.Type}");
            }
        }

        private static void WriteVariableExpression(BoundVariableExpression node, IndentedTextWriter writer)
        {
            writer.WriteIdentifier(node.Variable.Name);
        }

        private static void WriteAssignmentExpression(BoundAssignmentExpression node, IndentedTextWriter writer)
        {
            writer.WriteIdentifier(node.Variable.Name);
            writer.WriteSpace();
            writer.WritePunctuation(SyntaxKind.EqualsToken);
            writer.WriteSpace();
            node.Expression.WriteTo(writer);
        }

        private static void WriteUnaryExpression(BoundUnaryExpression node, IndentedTextWriter writer)
        {
            var precedence = SyntaxFacts.GetUnaryOperatorPrecedence(node.Op.SyntaxKind);

            writer.WritePunctuation(node.Op.SyntaxKind);
            writer.WriteNestedExpression(precedence, node.Operand);
        }

        private static void WriteBinaryExpression(BoundBinaryExpression node, IndentedTextWriter writer)
        {
            var precedence = SyntaxFacts.GetBinaryOperatorPrecedence(node.Op.SyntaxKind);

            writer.WriteNestedExpression(precedence, node.Left);
            writer.WriteSpace();
            writer.WritePunctuation(node.Op.SyntaxKind);
            writer.WriteSpace();
            writer.WriteNestedExpression(precedence, node.Right);
        }

        private static void WriteCallExpression(BoundCallExpression node, IndentedTextWriter writer)
        {
            writer.WriteIdentifier(node.Function.Name);
            writer.WritePunctuation(SyntaxKind.OpenParenthesisToken);

            var isFirst = true;
            foreach (var argument in node.Arguments)
            {
                if (isFirst)
                {
                    isFirst = false;
                }
                else
                {
                    writer.WritePunctuation(SyntaxKind.CommaToken);
                    writer.WriteSpace();
                }

                argument.WriteTo(writer);
            }

            writer.WritePunctuation(SyntaxKind.CloseParenthesisToken);
        }

        private static void WriteConversionExpression(BoundConversionExpression node, IndentedTextWriter writer)
        {
            writer.WriteIdentifier(node.Type.Name);
            writer.WritePunctuation(SyntaxKind.OpenParenthesisToken);
            node.Expression.WriteTo(writer);
            writer.WritePunctuation(SyntaxKind.CloseParenthesisToken);
        }
    }
}
