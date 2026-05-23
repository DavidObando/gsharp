// <copyright file="Evaluator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// Program evaluator.
/// </summary>
public sealed class Evaluator
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
                case BoundNodeKind.TryStatement:
                    EvaluateTryStatement((BoundTryStatement)s);
                    index++;
                    break;
                case BoundNodeKind.ThrowStatement:
                    EvaluateThrowStatement((BoundThrowStatement)s);
                    break;
                default:
                    throw new EvaluatorException($"Unexpected node {s.Kind}", s);
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

    private void EvaluateTryStatement(BoundTryStatement node)
    {
        try
        {
            EvaluateStatement((BoundBlockStatement)node.TryBlock);
        }
        catch (Exception ex) when (TryFindCatchHandler(node, ex, out _))
        {
            TryFindCatchHandler(node, ex, out var handler);
            Assign(handler.Variable, ex);
            EvaluateStatement((BoundBlockStatement)handler.Body);
        }
        finally
        {
            if (node.FinallyBlock != null)
            {
                EvaluateStatement((BoundBlockStatement)node.FinallyBlock);
            }
        }
    }

    private void EvaluateThrowStatement(BoundThrowStatement node)
    {
        var value = EvaluateExpression(node.Expression);
        if (value is Exception ex)
        {
            throw ex;
        }

        throw new Exception(value?.ToString());
    }

    private static bool TryFindCatchHandler(BoundTryStatement node, Exception ex, out BoundCatchClause matched)
    {
        var actualType = ex.GetType();
        foreach (var clause in node.CatchClauses)
        {
            var clrName = clause.ExceptionType?.ClrType?.FullName;
            if (clrName == null)
            {
                continue;
            }

            for (var t = actualType; t != null; t = t.BaseType)
            {
                if (t.FullName == clrName)
                {
                    matched = clause;
                    return true;
                }
            }
        }

        matched = null;
        return false;
    }

    private object EvaluateExpression(BoundExpression node)
    {
        try
        {
            return node.Kind switch
            {
                BoundNodeKind.LiteralExpression => EvaluateLiteralExpression((BoundLiteralExpression)node),
                BoundNodeKind.VariableExpression => EvaluateVariableExpression((BoundVariableExpression)node),
                BoundNodeKind.AssignmentExpression => EvaluateAssignmentExpression((BoundAssignmentExpression)node),
                BoundNodeKind.UnaryExpression => EvaluateUnaryExpression((BoundUnaryExpression)node),
                BoundNodeKind.BinaryExpression => EvaluateBinaryExpression((BoundBinaryExpression)node),
                BoundNodeKind.CallExpression => EvaluateCallExpression((BoundCallExpression)node),
                BoundNodeKind.ConversionExpression => EvaluateConversionExpression((BoundConversionExpression)node),
                BoundNodeKind.ImportedCallExpression => EvaluateImportedCallExpression((BoundImportedCallExpression)node),
                BoundNodeKind.ImportedInstanceCallExpression => EvaluateImportedInstanceCallExpression((BoundImportedInstanceCallExpression)node),
                BoundNodeKind.ArrayCreationExpression => EvaluateArrayCreationExpression((BoundArrayCreationExpression)node),
                BoundNodeKind.IndexExpression => EvaluateIndexExpression((BoundIndexExpression)node),
                BoundNodeKind.IndexAssignmentExpression => EvaluateIndexAssignmentExpression((BoundIndexAssignmentExpression)node),
                BoundNodeKind.LenExpression => EvaluateLenExpression((BoundLenExpression)node),
                BoundNodeKind.CapExpression => EvaluateCapExpression((BoundCapExpression)node),
                BoundNodeKind.AppendExpression => EvaluateAppendExpression((BoundAppendExpression)node),
                BoundNodeKind.StructLiteralExpression => EvaluateStructLiteralExpression((BoundStructLiteralExpression)node),
                BoundNodeKind.ConstructorCallExpression => EvaluateConstructorCallExpression((BoundConstructorCallExpression)node),
                BoundNodeKind.UserInstanceCallExpression => EvaluateUserInstanceCallExpression((BoundUserInstanceCallExpression)node),
                BoundNodeKind.FieldAccessExpression => EvaluateFieldAccessExpression((BoundFieldAccessExpression)node),
                BoundNodeKind.FieldAssignmentExpression => EvaluateFieldAssignmentExpression((BoundFieldAssignmentExpression)node),
                BoundNodeKind.NullConditionalAccessExpression => EvaluateNullConditionalAccessExpression((BoundNullConditionalAccessExpression)node),
                _ => throw new EvaluatorException($"Unexpected node {node.Kind}", node),
            };
        }
        catch (Exception ex) when (ex is not EvaluatorException)
        {
            throw new EvaluatorException(ex.Message, ex, node);
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

    private object EvaluateArrayCreationExpression(BoundArrayCreationExpression node)
    {
        var clrType = node.ElementType.ClrType ?? typeof(object);
        var array = System.Array.CreateInstance(clrType, node.Elements.Length);
        for (var i = 0; i < node.Elements.Length; i++)
        {
            array.SetValue(EvaluateExpression(node.Elements[i]), i);
        }

        return array;
    }

    private object EvaluateIndexExpression(BoundIndexExpression node)
    {
        var target = (System.Array)EvaluateExpression(node.Target);
        var index = (int)EvaluateExpression(node.Index);
        return target.GetValue(index);
    }

    private object EvaluateIndexAssignmentExpression(BoundIndexAssignmentExpression node)
    {
        var target = (System.Array)(node.Target.Kind == Symbols.SymbolKind.GlobalVariable
            ? globals[node.Target]
            : locals.Peek()[node.Target]);
        var index = (int)EvaluateExpression(node.Index);
        var value = EvaluateExpression(node.Value);
        target.SetValue(value, index);
        return value;
    }

    private object EvaluateLenExpression(BoundLenExpression node)
    {
        var v = EvaluateExpression(node.Operand);
        return v switch
        {
            string s => s.Length,
            System.Array a => a.Length,
            _ => throw new EvaluatorException($"len: unsupported operand of CLR type '{v?.GetType()}'.", node),
        };
    }

    private object EvaluateCapExpression(BoundCapExpression node)
    {
        var v = EvaluateExpression(node.Operand);
        return v switch
        {
            System.Array a => a.Length,
            _ => throw new EvaluatorException($"cap: unsupported operand of CLR type '{v?.GetType()}'.", node),
        };
    }

    private object EvaluateAppendExpression(BoundAppendExpression node)
    {
        var src = (System.Array)EvaluateExpression(node.Slice);
        var element = EvaluateExpression(node.Element);
        var clrType = node.SliceType.ElementType.ClrType ?? typeof(object);
        var dst = System.Array.CreateInstance(clrType, src.Length + 1);
        System.Array.Copy(src, dst, src.Length);
        dst.SetValue(element, src.Length);
        return dst;
    }

    private object EvaluateStructLiteralExpression(BoundStructLiteralExpression node)
    {
        var sv = new StructValue(node.StructType);

        // Default-initialize all fields (walking inheritance), then apply explicit initializers.
        for (var t = node.StructType; t != null; t = t.BaseClass)
        {
            foreach (var f in t.Fields)
            {
                if (!sv.Fields.ContainsKey(f.Name))
                {
                    sv.Fields[f.Name] = DefaultValue(f.Type);
                }
            }
        }

        foreach (var init in node.Initializers)
        {
            sv.Fields[init.Field.Name] = EvaluateExpression(init.Value);
        }

        return sv;
    }

    private object EvaluateConstructorCallExpression(BoundConstructorCallExpression node)
    {
        var sv = new StructValue(node.StructType);

        // Default-initialize all fields first (including inherited), then bind primary-ctor args.
        for (var t = node.StructType; t != null; t = t.BaseClass)
        {
            foreach (var f in t.Fields)
            {
                if (!sv.Fields.ContainsKey(f.Name))
                {
                    sv.Fields[f.Name] = DefaultValue(f.Type);
                }
            }
        }

        var parameters = node.StructType.PrimaryConstructorParameters;
        for (var i = 0; i < parameters.Length; i++)
        {
            sv.Fields[parameters[i].Name] = EvaluateExpression(node.Arguments[i]);
        }

        return sv;
    }

    private object EvaluateFieldAccessExpression(BoundFieldAccessExpression node)
    {
        var receiverValue = EvaluateExpression(node.Receiver);
        if (receiverValue is StructValue sv && sv.Fields.TryGetValue(node.Field.Name, out var value))
        {
            return value;
        }

        return DefaultValue(node.Field.Type);
    }

    private object EvaluateFieldAssignmentExpression(BoundFieldAssignmentExpression node)
    {
        var current = node.Receiver.Kind == Symbols.SymbolKind.GlobalVariable
            ? globals[node.Receiver]
            : locals.Peek()[node.Receiver];

        var sv = current as StructValue ?? new StructValue(node.StructType);

        // Class types are reference types: mutate the existing instance in
        // place so other references observe the write. Structs preserve
        // Go-style value semantics by writing to a copy.
        if (node.StructType.IsClass)
        {
            var value = EvaluateExpression(node.Value);
            sv.Fields[node.Field.Name] = value;
            if (!ReferenceEquals(sv, current))
            {
                Assign(node.Receiver, sv);
            }

            return value;
        }
        else
        {
            var copy = sv.Copy();
            var value = EvaluateExpression(node.Value);
            copy.Fields[node.Field.Name] = value;
            Assign(node.Receiver, copy);
            return value;
        }
    }

    private static object DefaultValue(Symbols.TypeSymbol type)
    {
        if (type == Symbols.TypeSymbol.Bool)
        {
            return false;
        }

        if (type == Symbols.TypeSymbol.Int)
        {
            return 0;
        }

        if (type == Symbols.TypeSymbol.String)
        {
            return string.Empty;
        }

        if (type is Symbols.StructSymbol s)
        {
            var sv = new StructValue(s);
            foreach (var f in s.Fields)
            {
                sv.Fields[f.Name] = DefaultValue(f.Type);
            }

            return sv;
        }

        return null;
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
            case BoundUnaryOperatorKind.NullAssertion:
                if (operand == null)
                {
                    throw new EvaluatorException("nil value !!", u);
                }

                return operand;

            // For now we don't support DereferenceOf or ReferenceOf.
            default:
                throw new EvaluatorException($"Unexpected unary operator {u.Op}", u);
        }
    }

    private object EvaluateBinaryExpression(BoundBinaryExpression b)
    {
        // Phase 3.C.3 / ADR-0001: null-coalescing must short-circuit so the
        // right-hand side is only evaluated when the left is nil.
        if (b.Op.Kind == BoundBinaryOperatorKind.NullCoalesce)
        {
            var leftValue = EvaluateExpression(b.Left);
            return leftValue ?? EvaluateExpression(b.Right);
        }

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
                throw new EvaluatorException($"Unexpected binary operator {b.Op}", b);
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

    private object EvaluateUserInstanceCallExpression(BoundUserInstanceCallExpression node)
    {
        var receiverValue = EvaluateExpression(node.Receiver);

        // Phase 3.B.3 sub-step 3: virtual dispatch. If the receiver's runtime
        // type overrides the statically-bound method, route to the override.
        var method = node.Method;

        // Phase 3.B.4 + Phase 4.2b: an interface method (or a generic
        // type-parameter's interface-constrained method) has a null
        // ThisParameter / ReceiverType. Resolve the concrete implementation
        // by looking up the method by name on the runtime struct type.
        if (method.ThisParameter == null && receiverValue is StructValue ifaceSv && ifaceSv.StructType != null)
        {
            for (var t = ifaceSv.StructType; t != null; t = t.BaseClass)
            {
                if (t.TryGetMethod(method.Name, out var implMethod))
                {
                    method = implMethod;
                    break;
                }
            }
        }
        else if (receiverValue is StructValue sv && sv.StructType != null)
        {
            for (var t = sv.StructType; t != null; t = t.BaseClass)
            {
                if (t == method.ReceiverType)
                {
                    break;
                }

                if (t.TryGetMethod(method.Name, out var overrideMethod) && overrideMethod.IsOverride)
                {
                    method = overrideMethod;
                    break;
                }
            }
        }

        var frame = new Dictionary<VariableSymbol, object>
        {
            [method.ThisParameter] = receiverValue,
        };

        for (int i = 0; i < node.Arguments.Length; i++)
        {
            var parameter = method.Parameters[i];
            var value = EvaluateExpression(node.Arguments[i]);
            frame.Add(parameter, value);
        }

        locals.Push(frame);
        var statement = program.Functions[method];
        var result = EvaluateStatement(statement);
        locals.Pop();

        return result;
    }

    private object EvaluateConversionExpression(BoundConversionExpression node)
    {
        var value = EvaluateExpression(node.Expression);
        if (node.Type == TypeSymbol.Bool)
        {
            return Convert.ToBoolean(value, System.Globalization.CultureInfo.InvariantCulture);
        }
        else if (node.Type == TypeSymbol.Int)
        {
            return Convert.ToInt32(value, System.Globalization.CultureInfo.InvariantCulture);
        }
        else if (node.Type == TypeSymbol.String)
        {
            return Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
        }
        else if (node.Type is NullableTypeSymbol)
        {
            // Phase 3.C.1: nullability is a bind-time annotation; the runtime
            // representation is identical to the underlying type.
            return value;
        }
        else
        {
            throw new EvaluatorException($"Unexpected type {node.Type}", node);
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

    private object EvaluateImportedInstanceCallExpression(BoundImportedInstanceCallExpression node)
    {
        var receiver = EvaluateExpression(node.Receiver);
        var locals = new object[node.Arguments.Length];
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            locals[i] = EvaluateExpression(node.Arguments[i]);
        }

        return node.Method.Invoke(receiver, locals);
    }

    private object EvaluateNullConditionalAccessExpression(BoundNullConditionalAccessExpression node)
    {
        // Phase 3.C.3b: evaluate the receiver exactly once; nil short-circuits
        // the whole subtree to nil. Otherwise, bind the value to the synthetic
        // capture local so the access subtree resolves to the receiver value
        // without re-evaluating it.
        var receiver = EvaluateExpression(node.Receiver);
        if (receiver == null)
        {
            return null;
        }

        var locals = this.locals.Peek();
        locals[node.Capture] = receiver;
        try
        {
            return EvaluateExpression(node.WhenNotNull);
        }
        finally
        {
            locals.Remove(node.Capture);
        }
    }

    private void Assign(VariableSymbol variable, object value)
    {
        // Value-typed structs are copied on assignment (Go semantics).
        // Class types (Phase 3.B.3) are reference types — share the instance.
        if (value is StructValue sv && !sv.StructType.IsClass)
        {
            value = sv.Copy();
        }

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
