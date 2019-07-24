// <copyright file="Evaluator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis
{
    using System;
    using System.Collections.Generic;
    using GSharp.Core.CodeAnalysis.Binding;
    using GSharp.Core.CodeAnalysis.Symbols;

    /// <summary>
    /// Program evaluator.
    /// </summary>
    internal sealed class Evaluator
    {
        private readonly BoundProgram program;
        private readonly Dictionary<VariableSymbol, object> globals;
        private readonly Stack<Dictionary<VariableSymbol, object>> locals = new Stack<Dictionary<VariableSymbol, object>>();
        private Random random;

        private object lastValue;

        /// <summary>
        /// Initializes a new instance of the <see cref="Evaluator"/> class.
        /// </summary>
        /// <param name="program">The program.</param>
        /// <param name="variables">The variables.</param>
        public Evaluator(BoundProgram program, Dictionary<VariableSymbol, object> variables)
        {
            this.program = program;
            globals = variables;
            locals.Push(new Dictionary<VariableSymbol, object>());
        }

        /// <summary>
        /// Evaluates the program and returns the evaluated result.
        /// </summary>
        /// <returns>The evaluation result.</returns>
        public object Evaluate()
        {
            return EvaluateStatement(program.Statement);
        }

        private object EvaluateStatement(BoundBlockStatement body)
        {
            var labelToIndex = new Dictionary<BoundLabel, int>();

            for (var i = 0; i < body.Statements.Length; i++)
            {
                if (body.Statements[i] is BoundLabelStatement l)
                {
                    labelToIndex.Add(l.Label, i + 1);
                }
            }

            var index = 0;

            while (index < body.Statements.Length)
            {
                var s = body.Statements[index];

                switch (s.Kind)
                {
                    case BoundNodeKind.VariableDeclaration:
                        EvaluateVariableDeclaration((BoundVariableDeclaration)s);
                        index++;
                        break;
                    case BoundNodeKind.ExpressionStatement:
                        EvaluateExpressionStatement((BoundExpressionStatement)s);
                        index++;
                        break;
                    case BoundNodeKind.GotoStatement:
                        var gs = (BoundGotoStatement)s;
                        index = labelToIndex[gs.Label];
                        break;
                    case BoundNodeKind.ConditionalGotoStatement:
                        var cgs = (BoundConditionalGotoStatement)s;
                        var condition = (bool)EvaluateExpression(cgs.Condition);
                        if (condition == cgs.JumpIfTrue)
                        {
                            index = labelToIndex[cgs.Label];
                        }
                        else
                        {
                            index++;
                        }

                        break;
                    case BoundNodeKind.LabelStatement:
                        index++;
                        break;
                    case BoundNodeKind.ReturnStatement:
                        var rs = (BoundReturnStatement)s;
                        lastValue = rs.Expression == null ? null : EvaluateExpression(rs.Expression);
                        return lastValue;
                    default:
                        throw new Exception($"Unexpected node {s.Kind}");
                }
            }

            return lastValue;
        }

        private void EvaluateVariableDeclaration(BoundVariableDeclaration node)
        {
            var value = EvaluateExpression(node.Initializer);
            lastValue = value;
            Assign(node.Variable, value);
        }

        private void EvaluateExpressionStatement(BoundExpressionStatement node)
        {
            lastValue = EvaluateExpression(node.Expression);
        }

        private object EvaluateExpression(BoundExpression node)
        {
            switch (node.Kind)
            {
                case BoundNodeKind.LiteralExpression:
                    return EvaluateLiteralExpression((BoundLiteralExpression)node);
                case BoundNodeKind.VariableExpression:
                    return EvaluateVariableExpression((BoundVariableExpression)node);
                case BoundNodeKind.AssignmentExpression:
                    return EvaluateAssignmentExpression((BoundAssignmentExpression)node);
                case BoundNodeKind.UnaryExpression:
                    return EvaluateUnaryExpression((BoundUnaryExpression)node);
                case BoundNodeKind.BinaryExpression:
                    return EvaluateBinaryExpression((BoundBinaryExpression)node);
                case BoundNodeKind.CallExpression:
                    return EvaluateCallExpression((BoundCallExpression)node);
                case BoundNodeKind.ConversionExpression:
                    return EvaluateConversionExpression((BoundConversionExpression)node);
                case BoundNodeKind.ImportedCallExpression:
                    return EvaluateImportedCallExpression((BoundImportedCallExpression)node);
                default:
                    throw new Exception($"Unexpected node {node.Kind}");
            }
        }

        private object EvaluateLiteralExpression(BoundLiteralExpression n)
        {
            return n.Value;
        }

        private object EvaluateVariableExpression(BoundVariableExpression v)
        {
            if (v.Variable.Kind == SymbolKind.GlobalVariable)
            {
                return globals[v.Variable];
            }
            else
            {
                var locals = this.locals.Peek();
                return locals[v.Variable];
            }
        }

        private object EvaluateAssignmentExpression(BoundAssignmentExpression a)
        {
            var value = EvaluateExpression(a.Expression);
            Assign(a.Variable, value);
            return value;
        }

        private object EvaluateUnaryExpression(BoundUnaryExpression u)
        {
            var operand = EvaluateExpression(u.Operand);

            switch (u.Op.Kind)
            {
                case BoundUnaryOperatorKind.Identity:
                    return (int)operand;
                case BoundUnaryOperatorKind.Negation:
                    return -(int)operand;
                case BoundUnaryOperatorKind.LogicalNegation:
                    return !(bool)operand;
                case BoundUnaryOperatorKind.OnesComplement:
                    return ~(int)operand;

                // For now we don't support DereferenceOf or ReferenceOf.
                default:
                    throw new Exception($"Unexpected unary operator {u.Op}");
            }
        }

        private object EvaluateBinaryExpression(BoundBinaryExpression b)
        {
            var left = EvaluateExpression(b.Left);
            var right = EvaluateExpression(b.Right);

            switch (b.Op.Kind)
            {
                case BoundBinaryOperatorKind.Product:
                    return (int)left * (int)right;
                case BoundBinaryOperatorKind.Quotient:
                    return (int)left / (int)right;
                case BoundBinaryOperatorKind.Remainder:
                    return (int)left % (int)right;
                case BoundBinaryOperatorKind.ShiftLeft:
                    return (int)left << (int)right;
                case BoundBinaryOperatorKind.ShiftRight:
                    return (int)left >> (int)right;
                case BoundBinaryOperatorKind.BitwiseAnd:
                    if (b.Type == TypeSymbol.Int)
                    {
                        return (int)left & (int)right;
                    }
                    else
                    {
                        return (bool)left & (bool)right;
                    }

                case BoundBinaryOperatorKind.BitClear:
                    return (int)left & (~(int)right);
                case BoundBinaryOperatorKind.Sum:
                    if (b.Type == TypeSymbol.Int)
                    {
                        return (int)left + (int)right;
                    }
                    else
                    {
                        return (string)left + (string)right;
                    }

                case BoundBinaryOperatorKind.Difference:
                    return (int)left - (int)right;
                case BoundBinaryOperatorKind.BitwiseOr:
                    if (b.Type == TypeSymbol.Int)
                    {
                        return (int)left | (int)right;
                    }
                    else
                    {
                        return (bool)left | (bool)right;
                    }

                case BoundBinaryOperatorKind.BitwiseXor:
                    if (b.Type == TypeSymbol.Int)
                    {
                        return (int)left ^ (int)right;
                    }
                    else
                    {
                        return (bool)left ^ (bool)right;
                    }

                case BoundBinaryOperatorKind.Equals:
                    return Equals(left, right);
                case BoundBinaryOperatorKind.NotEquals:
                    return !Equals(left, right);
                case BoundBinaryOperatorKind.Less:
                    return (int)left < (int)right;
                case BoundBinaryOperatorKind.LessOrEquals:
                    return (int)left <= (int)right;
                case BoundBinaryOperatorKind.Greater:
                    return (int)left > (int)right;
                case BoundBinaryOperatorKind.GreaterOrEquals:
                    return (int)left >= (int)right;
                case BoundBinaryOperatorKind.LogicalAnd:
                    return (bool)left && (bool)right;
                case BoundBinaryOperatorKind.LogicalOr:
                    return (bool)left || (bool)right;
                default:
                    throw new Exception($"Unexpected binary operator {b.Op}");
            }
        }

        private object EvaluateCallExpression(BoundCallExpression node)
        {
            if (node.Function == BuiltinFunctions.Input)
            {
                return Console.ReadLine();
            }
            else if (node.Function == BuiltinFunctions.Print)
            {
                var message = (string)EvaluateExpression(node.Arguments[0]);
                Console.WriteLine(message);
                return null;
            }
            else if (node.Function == BuiltinFunctions.Rnd)
            {
                var max = (int)EvaluateExpression(node.Arguments[0]);
                if (random == null)
                {
                    random = new Random();
                }

                return random.Next(max);
            }
            else
            {
                var locals = new Dictionary<VariableSymbol, object>();
                for (int i = 0; i < node.Arguments.Length; i++)
                {
                    var parameter = node.Function.Parameters[i];
                    var value = EvaluateExpression(node.Arguments[i]);
                    locals.Add(parameter, value);
                }

                this.locals.Push(locals);

                var statement = program.Functions[node.Function];
                var result = EvaluateStatement(statement);

                this.locals.Pop();

                return result;
            }
        }

        private object EvaluateConversionExpression(BoundConversionExpression node)
        {
            var value = EvaluateExpression(node.Expression);
            if (node.Type == TypeSymbol.Bool)
            {
                return Convert.ToBoolean(value);
            }
            else if (node.Type == TypeSymbol.Int)
            {
                return Convert.ToInt32(value);
            }
            else if (node.Type == TypeSymbol.String)
            {
                return Convert.ToString(value);
            }
            else
            {
                throw new Exception($"Unexpected type {node.Type}");
            }
        }

        private object EvaluateImportedCallExpression(BoundImportedCallExpression node)
        {
            // Hack: for now we only support static methods.
            var locals = new List<object>();
            for (int i = 0; i < node.Arguments.Length; i++)
            {
                var value = EvaluateExpression(node.Arguments[i]);
                locals.Add(value);
            }

            return node.Function.Method.Invoke(null, locals.ToArray());
        }

        private void Assign(VariableSymbol variable, object value)
        {
            if (variable.Kind == SymbolKind.GlobalVariable)
            {
                globals[variable] = value;
            }
            else
            {
                var locals = this.locals.Peek();
                locals[variable] = value;
            }
        }
    }
}
