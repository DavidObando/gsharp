// <copyright file="BoundNodePrinter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.CodeDom.Compiler;
using System.IO;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.IO;

namespace GSharp.Core.CodeAnalysis.Binding;

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
            case BoundNodeKind.ForRangeStatement:
                WriteForRangeStatement((BoundForRangeStatement)node, writer);
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
            case BoundNodeKind.TryStatement:
                WriteTryStatement((BoundTryStatement)node, writer);
                break;
            case BoundNodeKind.ThrowStatement:
                WriteThrowStatement((BoundThrowStatement)node, writer);
                break;
            case BoundNodeKind.PatternSwitchStatement:
                WritePatternSwitchStatement((BoundPatternSwitchStatement)node, writer);
                break;
            case BoundNodeKind.GoStatement:
                WriteGoStatement((BoundGoStatement)node, writer);
                break;
            case BoundNodeKind.ChannelSendStatement:
                WriteChannelSendStatement((BoundChannelSendStatement)node, writer);
                break;
            case BoundNodeKind.SelectStatement:
                WriteSelectStatement((BoundSelectStatement)node, writer);
                break;
            case BoundNodeKind.ScopeStatement:
                WriteScopeStatement((BoundScopeStatement)node, writer);
                break;
            case BoundNodeKind.AwaitForRangeStatement:
                WriteAwaitForRangeStatement((BoundAwaitForRangeStatement)node, writer);
                break;
            case BoundNodeKind.YieldStatement:
                WriteYieldStatement((BoundYieldStatement)node, writer);
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
            case BoundNodeKind.ImportedCallExpression:
                WriteImportedCallExpression((BoundImportedCallExpression)node, writer);
                break;
            case BoundNodeKind.ImportedInstanceCallExpression:
                WriteImportedInstanceCallExpression((BoundImportedInstanceCallExpression)node, writer);
                break;
            case BoundNodeKind.ArrayCreationExpression:
                WriteArrayCreationExpression((BoundArrayCreationExpression)node, writer);
                break;
            case BoundNodeKind.MapLiteralExpression:
                WriteMapLiteralExpression((BoundMapLiteralExpression)node, writer);
                break;
            case BoundNodeKind.MapDeleteExpression:
                WriteMapDeleteExpression((BoundMapDeleteExpression)node, writer);
                break;
            case BoundNodeKind.IndexExpression:
                WriteIndexExpression((BoundIndexExpression)node, writer);
                break;
            case BoundNodeKind.IndexAssignmentExpression:
                WriteIndexAssignmentExpression((BoundIndexAssignmentExpression)node, writer);
                break;
            case BoundNodeKind.LenExpression:
                WriteIntrinsicCall("len", ((BoundLenExpression)node).Operand, writer);
                break;
            case BoundNodeKind.CapExpression:
                WriteIntrinsicCall("cap", ((BoundCapExpression)node).Operand, writer);
                break;
            case BoundNodeKind.AppendExpression:
                WriteAppendExpression((BoundAppendExpression)node, writer);
                break;
            case BoundNodeKind.StructLiteralExpression:
                WriteStructLiteralExpression((BoundStructLiteralExpression)node, writer);
                break;
            case BoundNodeKind.BlockExpression:
                WriteBlockExpression((BoundBlockExpression)node, writer);
                break;
            case BoundNodeKind.ConstructorCallExpression:
                WriteConstructorCallExpression((BoundConstructorCallExpression)node, writer);
                break;
            case BoundNodeKind.UserInstanceCallExpression:
                WriteUserInstanceCallExpression((BoundUserInstanceCallExpression)node, writer);
                break;
            case BoundNodeKind.FieldAccessExpression:
                WriteFieldAccessExpression((BoundFieldAccessExpression)node, writer);
                break;
            case BoundNodeKind.FieldAssignmentExpression:
                WriteFieldAssignmentExpression((BoundFieldAssignmentExpression)node, writer);
                break;
            case BoundNodeKind.NullConditionalAccessExpression:
                WriteNullConditionalAccessExpression((BoundNullConditionalAccessExpression)node, writer);
                break;
            case BoundNodeKind.TupleLiteralExpression:
                WriteTupleLiteralExpression((BoundTupleLiteralExpression)node, writer);
                break;
            case BoundNodeKind.TupleElementAccessExpression:
                WriteTupleElementAccessExpression((BoundTupleElementAccessExpression)node, writer);
                break;
            case BoundNodeKind.FunctionLiteralExpression:
                WriteFunctionLiteralExpression((BoundFunctionLiteralExpression)node, writer);
                break;
            case BoundNodeKind.IndirectCallExpression:
                WriteIndirectCallExpression((BoundIndirectCallExpression)node, writer);
                break;
            case BoundNodeKind.ClrConstructorCallExpression:
                WriteClrConstructorCallExpression((BoundClrConstructorCallExpression)node, writer);
                break;
            case BoundNodeKind.ClrPropertyAccessExpression:
                WriteClrPropertyAccessExpression((BoundClrPropertyAccessExpression)node, writer);
                break;
            case BoundNodeKind.ClrPropertyAssignmentExpression:
                WriteClrPropertyAssignmentExpression((BoundClrPropertyAssignmentExpression)node, writer);
                break;
            case BoundNodeKind.ClrEventSubscriptionExpression:
                WriteClrEventSubscriptionExpression((BoundClrEventSubscriptionExpression)node, writer);
                break;
            case BoundNodeKind.ClrBinaryOperatorExpression:
                WriteClrBinaryOperatorExpression((BoundClrBinaryOperatorExpression)node, writer);
                break;
            case BoundNodeKind.ClrUnaryOperatorExpression:
                WriteClrUnaryOperatorExpression((BoundClrUnaryOperatorExpression)node, writer);
                break;
            case BoundNodeKind.ClrConversionCallExpression:
                WriteClrConversionCallExpression((BoundClrConversionCallExpression)node, writer);
                break;
            case BoundNodeKind.ClrIndexExpression:
                WriteClrIndexExpression((BoundClrIndexExpression)node, writer);
                break;
            case BoundNodeKind.ClrIndexAssignmentExpression:
                WriteClrIndexAssignmentExpression((BoundClrIndexAssignmentExpression)node, writer);
                break;
            case BoundNodeKind.AwaitExpression:
                WriteAwaitExpression((BoundAwaitExpression)node, writer);
                break;
            case BoundNodeKind.SwitchExpression:
                WriteSwitchExpression((BoundSwitchExpression)node, writer);
                break;
            case BoundNodeKind.SwitchExpressionArm:
                WriteSwitchExpressionArm((BoundSwitchExpressionArm)node, writer);
                break;
            case BoundNodeKind.MakeChannelExpression:
                WriteMakeChannelExpression((BoundMakeChannelExpression)node, writer);
                break;
            case BoundNodeKind.ChannelReceiveExpression:
                WriteChannelReceiveExpression((BoundChannelReceiveExpression)node, writer);
                break;
            case BoundNodeKind.ChannelCloseExpression:
                WriteIntrinsicCall("close", ((BoundChannelCloseExpression)node).Channel, writer);
                break;
            case BoundNodeKind.AddressOfExpression:
                WriteAddressOfExpression((BoundAddressOfExpression)node, writer);
                break;
            case BoundNodeKind.DereferenceExpression:
                WriteDereferenceExpression((BoundDereferenceExpression)node, writer);
                break;
            case BoundNodeKind.StateMachineAwaitOnCompleted:
                WriteStateMachineAwaitOnCompleted((BoundStateMachineAwaitOnCompleted)node, writer);
                break;
            case BoundNodeKind.SpillSequenceExpression:
                WriteSpillSequenceExpression((BoundSpillSequenceExpression)node, writer);
                break;
            case BoundNodeKind.DefaultExpression:
                WriteDefaultExpression((BoundDefaultExpression)node, writer);
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

    private static void WriteForRangeStatement(BoundForRangeStatement node, IndentedTextWriter writer)
    {
        writer.WriteKeyword(SyntaxKind.ForKeyword);
        writer.WriteSpace();
        if (node.KeyVariable != null)
        {
            writer.WriteIdentifier(node.KeyVariable.Name);
            writer.WritePunctuation(SyntaxKind.CommaToken);
            writer.WriteSpace();
        }

        writer.WriteIdentifier(node.ValueVariable.Name);
        writer.WriteSpace();
        writer.WritePunctuation(SyntaxKind.ColonEqualsToken);
        writer.WriteSpace();
        writer.WriteKeyword(SyntaxKind.RangeKeyword);
        writer.WriteSpace();
        node.Collection.WriteTo(writer);
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
        writer.WriteKeyword("goto"); // There is no SyntaxKind for goto
        writer.WriteSpace();
        writer.WriteIdentifier(node.Label.Name);
        writer.WriteLine();
    }

    private static void WriteConditionalGotoStatement(BoundConditionalGotoStatement node, IndentedTextWriter writer)
    {
        writer.WriteKeyword("goto"); // There is no SyntaxKind for goto
        writer.WriteSpace();
        writer.WriteIdentifier(node.Label.Name);
        writer.WriteSpace();
        writer.WriteKeyword(node.JumpIfTrue ? "if" : "unless");
        writer.WriteSpace();
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

    private static void WriteTryStatement(BoundTryStatement node, IndentedTextWriter writer)
    {
        writer.WriteKeyword(SyntaxKind.TryKeyword);
        writer.WriteSpace();
        node.TryBlock.WriteTo(writer);

        foreach (var clause in node.CatchClauses)
        {
            writer.WriteKeyword(SyntaxKind.CatchKeyword);
            writer.WriteSpace();
            writer.WritePunctuation(SyntaxKind.OpenParenthesisToken);
            writer.WriteIdentifier(clause.Variable.Name);
            writer.WriteSpace();
            writer.WriteIdentifier(clause.ExceptionType.Name);
            writer.WritePunctuation(SyntaxKind.CloseParenthesisToken);
            writer.WriteSpace();
            clause.Body.WriteTo(writer);
        }

        if (node.FinallyBlock != null)
        {
            writer.WriteKeyword(SyntaxKind.FinallyKeyword);
            writer.WriteSpace();
            node.FinallyBlock.WriteTo(writer);
        }
    }

    private static void WriteThrowStatement(BoundThrowStatement node, IndentedTextWriter writer)
    {
        writer.WriteKeyword(SyntaxKind.ThrowKeyword);
        writer.WriteSpace();
        node.Expression.WriteTo(writer);
        writer.WriteLine();
    }

    private static void WriteGoStatement(BoundGoStatement node, IndentedTextWriter writer)
    {
        writer.WriteKeyword(SyntaxKind.GoKeyword);
        writer.WriteSpace();
        node.Expression.WriteTo(writer);
        writer.WriteLine();
    }

    private static void WriteErrorExpression(BoundErrorExpression node, IndentedTextWriter writer)
    {
        writer.WriteKeyword(node.Type.Name);
    }

    private static void WriteLiteralExpression(BoundLiteralExpression node, IndentedTextWriter writer)
    {
        if (node.Type == TypeSymbol.Null)
        {
            writer.WriteKeyword(SyntaxKind.NilKeyword);
            return;
        }

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
        else if (node.Value is int)
        {
            writer.WriteNumber(value);
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

    private static void WriteAwaitExpression(BoundAwaitExpression node, IndentedTextWriter writer)
    {
        writer.WriteKeyword(SyntaxKind.AwaitKeyword);
        writer.WriteSpace();
        node.Expression.WriteTo(writer);
    }

    private static void WritePatternSwitchStatement(BoundPatternSwitchStatement node, IndentedTextWriter writer)
    {
        writer.WriteKeyword(SyntaxKind.SwitchKeyword);
        writer.WriteSpace();
        node.Discriminant.WriteTo(writer);
        writer.WriteSpace();
        writer.WritePunctuation(SyntaxKind.OpenBraceToken);
        writer.WriteLine();
        writer.Indent++;
        foreach (var arm in node.Arms)
        {
            if (arm.IsDefault)
            {
                writer.WriteKeyword(SyntaxKind.DefaultKeyword);
            }
            else
            {
                writer.WriteKeyword(SyntaxKind.CaseKeyword);
                writer.WriteSpace();
                WritePattern(arm.Pattern, writer);
            }

            writer.WriteLine();
            writer.WriteNestedStatement(arm.Body);
        }

        writer.Indent--;
        writer.WritePunctuation(SyntaxKind.CloseBraceToken);
        writer.WriteLine();
    }

    private static void WritePattern(BoundPattern pattern, IndentedTextWriter writer)
    {
        switch (pattern.Kind)
        {
            case BoundNodeKind.ConstantPattern:
                ((BoundConstantPattern)pattern).Value.WriteTo(writer);
                break;
            case BoundNodeKind.DiscardPattern:
                writer.WriteIdentifier("_");
                break;
            case BoundNodeKind.TypePattern:
                var typePattern = (BoundTypePattern)pattern;
                writer.WriteIdentifier(typePattern.Variable.Name);
                writer.WriteSpace();
                writer.WriteKeyword(SyntaxKind.IsKeyword);
                writer.WriteSpace();
                writer.WriteIdentifier(typePattern.TargetType.Name);
                break;
            case BoundNodeKind.RelationalPattern:
                var relational = (BoundRelationalPattern)pattern;
                writer.WritePunctuation(relational.Op.SyntaxKind);
                writer.WriteSpace();
                relational.Value.WriteTo(writer);
                break;
            case BoundNodeKind.PropertyPattern:
                var property = (BoundPropertyPattern)pattern;
                writer.WritePunctuation(SyntaxKind.OpenBraceToken);
                for (var i = 0; i < property.Fields.Length; i++)
                {
                    if (i > 0)
                    {
                        writer.WritePunctuation(SyntaxKind.CommaToken);
                        writer.WriteSpace();
                    }

                    writer.WriteIdentifier(property.Fields[i].Field.Name);
                    writer.WritePunctuation(SyntaxKind.ColonToken);
                    writer.WriteSpace();
                    WritePattern(property.Fields[i].Pattern, writer);
                }

                writer.WritePunctuation(SyntaxKind.CloseBraceToken);
                break;
            case BoundNodeKind.ListPattern:
                var list = (BoundListPattern)pattern;
                writer.WritePunctuation(SyntaxKind.OpenSquareBracketToken);
                for (var i = 0; i < list.Elements.Length; i++)
                {
                    if (i > 0)
                    {
                        writer.WritePunctuation(SyntaxKind.CommaToken);
                        writer.WriteSpace();
                    }

                    WritePattern(list.Elements[i], writer);
                }

                writer.WritePunctuation(SyntaxKind.CloseSquareBracketToken);
                break;
            default:
                throw new Exception($"Unexpected pattern node {pattern.Kind}");
        }
    }

    private static void WriteSwitchExpression(BoundSwitchExpression node, IndentedTextWriter writer)
    {
        writer.WriteKeyword(SyntaxKind.SwitchKeyword);
        writer.WriteSpace();
        node.Discriminant.WriteTo(writer);
        writer.WriteSpace();
        writer.WritePunctuation(SyntaxKind.OpenBraceToken);
        writer.WriteSpace();

        foreach (var arm in node.Arms)
        {
            WriteSwitchExpressionArm(arm, writer);
            writer.WriteSpace();
        }

        writer.WritePunctuation(SyntaxKind.CloseBraceToken);
    }

    private static void WriteSwitchExpressionArm(BoundSwitchExpressionArm arm, IndentedTextWriter writer)
    {
        if (arm.IsDefault)
        {
            writer.WriteKeyword(SyntaxKind.DefaultKeyword);
        }
        else
        {
            writer.WriteKeyword(SyntaxKind.CaseKeyword);
            writer.WriteSpace();
            WritePattern(arm.Pattern, writer);
        }

        writer.WriteSpace();
        writer.WritePunctuation(SyntaxKind.RightArrowToken);
        writer.WriteSpace();
        arm.Result.WriteTo(writer);
    }

    private static void WriteChannelSendStatement(BoundChannelSendStatement node, IndentedTextWriter writer)
    {
        node.Channel.WriteTo(writer);
        writer.WriteSpace();
        writer.WritePunctuation(SyntaxKind.LeftArrowToken);
        writer.WriteSpace();
        node.Value.WriteTo(writer);
        writer.WriteLine();
    }

    private static void WriteSelectStatement(BoundSelectStatement node, IndentedTextWriter writer)
    {
        writer.WriteKeyword(SyntaxKind.SelectKeyword);
        writer.WriteSpace();
        writer.WritePunctuation(SyntaxKind.OpenBraceToken);
        writer.WriteLine();
        writer.Indent++;
        foreach (var arm in node.Cases)
        {
            switch (arm.CaseKind)
            {
                case SelectCaseKind.Default:
                    writer.WriteKeyword(SyntaxKind.DefaultKeyword);
                    break;
                case SelectCaseKind.ReceiveDiscard:
                    writer.WriteKeyword(SyntaxKind.CaseKeyword);
                    writer.WriteSpace();
                    writer.WritePunctuation(SyntaxKind.LeftArrowToken);
                    arm.Channel.WriteTo(writer);
                    break;
                case SelectCaseKind.ReceiveBind:
                    writer.WriteKeyword(SyntaxKind.CaseKeyword);
                    writer.WriteSpace();
                    writer.WriteIdentifier(arm.Variable.Name);
                    writer.WriteSpace();
                    writer.WritePunctuation(SyntaxKind.ColonEqualsToken);
                    writer.WriteSpace();
                    writer.WritePunctuation(SyntaxKind.LeftArrowToken);
                    arm.Channel.WriteTo(writer);
                    break;
                case SelectCaseKind.Send:
                    writer.WriteKeyword(SyntaxKind.CaseKeyword);
                    writer.WriteSpace();
                    arm.Channel.WriteTo(writer);
                    writer.WriteSpace();
                    writer.WritePunctuation(SyntaxKind.LeftArrowToken);
                    writer.WriteSpace();
                    arm.Value.WriteTo(writer);
                    break;
            }

            writer.WriteSpace();
            arm.Body.WriteTo(writer);
        }

        writer.Indent--;
        writer.WritePunctuation(SyntaxKind.CloseBraceToken);
        writer.WriteLine();
    }

    private static void WriteScopeStatement(BoundScopeStatement node, IndentedTextWriter writer)
    {
        writer.WriteKeyword(SyntaxKind.ScopeKeyword);
        writer.WriteSpace();
        node.Body.WriteTo(writer);
    }

    private static void WriteAwaitForRangeStatement(BoundAwaitForRangeStatement node, IndentedTextWriter writer)
    {
        writer.WriteKeyword(SyntaxKind.AwaitKeyword);
        writer.WriteSpace();
        writer.WriteKeyword(SyntaxKind.ForKeyword);
        writer.WriteSpace();
        writer.WriteIdentifier(node.ValueVariable.Name);
        writer.WriteSpace();
        writer.WritePunctuation(SyntaxKind.ColonEqualsToken);
        writer.WriteSpace();
        writer.WriteKeyword(SyntaxKind.RangeKeyword);
        writer.WriteSpace();
        node.Stream.WriteTo(writer);
        writer.WriteSpace();
        node.Body.WriteTo(writer);
    }

    private static void WriteYieldStatement(BoundYieldStatement node, IndentedTextWriter writer)
    {
        writer.WriteIdentifier("yield");
        writer.WriteSpace();
        node.Expression.WriteTo(writer);
    }

    private static void WriteMakeChannelExpression(BoundMakeChannelExpression node, IndentedTextWriter writer)
    {
        writer.WriteIdentifier("make");
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken);
        writer.WriteKeyword(SyntaxKind.ChanKeyword);
        writer.WriteSpace();
        writer.WriteIdentifier(node.ChannelType.ElementType.Name);
        if (node.Capacity != null)
        {
            writer.WritePunctuation(SyntaxKind.CommaToken);
            writer.WriteSpace();
            node.Capacity.WriteTo(writer);
        }

        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken);
    }

    private static void WriteChannelReceiveExpression(BoundChannelReceiveExpression node, IndentedTextWriter writer)
    {
        writer.WritePunctuation(SyntaxKind.LeftArrowToken);
        node.Channel.WriteTo(writer);
    }

    private static void WriteImportedCallExpression(BoundImportedCallExpression node, IndentedTextWriter writer)
    {
        writer.WriteIdentifier(node.Function.ImportedClass.Name);
        writer.WritePunctuation(SyntaxKind.DotToken);
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

    private static void WriteImportedInstanceCallExpression(BoundImportedInstanceCallExpression node, IndentedTextWriter writer)
    {
        node.Receiver.WriteTo(writer);
        writer.WritePunctuation(SyntaxKind.DotToken);
        writer.WriteIdentifier(node.Method.Name);
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

    private static void WriteArrayCreationExpression(BoundArrayCreationExpression node, IndentedTextWriter writer)
    {
        writer.WritePunctuation(SyntaxKind.OpenSquareBracketToken);
        if (node.ContainerType is GSharp.Core.CodeAnalysis.Symbols.ArrayTypeSymbol arr)
        {
            writer.WriteNumber(arr.Length.ToString());
        }

        writer.WritePunctuation(SyntaxKind.CloseSquareBracketToken);
        writer.WriteIdentifier(node.ElementType.Name);
        writer.WritePunctuation(SyntaxKind.OpenBraceToken);

        var isFirst = true;
        foreach (var element in node.Elements)
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

            element.WriteTo(writer);
        }

        writer.WritePunctuation(SyntaxKind.CloseBraceToken);
    }

    private static void WriteIndexExpression(BoundIndexExpression node, IndentedTextWriter writer)
    {
        node.Target.WriteTo(writer);
        writer.WritePunctuation(SyntaxKind.OpenSquareBracketToken);
        node.Index.WriteTo(writer);
        writer.WritePunctuation(SyntaxKind.CloseSquareBracketToken);
    }

    private static void WriteIndexAssignmentExpression(BoundIndexAssignmentExpression node, IndentedTextWriter writer)
    {
        writer.WriteIdentifier(node.Target.Name);
        writer.WritePunctuation(SyntaxKind.OpenSquareBracketToken);
        node.Index.WriteTo(writer);
        writer.WritePunctuation(SyntaxKind.CloseSquareBracketToken);
        writer.WriteSpace();
        writer.WritePunctuation(SyntaxKind.EqualsToken);
        writer.WriteSpace();
        node.Value.WriteTo(writer);
    }

    private static void WriteIntrinsicCall(string name, BoundExpression operand, IndentedTextWriter writer)
    {
        writer.WriteIdentifier(name);
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken);
        operand.WriteTo(writer);
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken);
    }

    private static void WriteAppendExpression(BoundAppendExpression node, IndentedTextWriter writer)
    {
        writer.WriteIdentifier("append");
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken);
        node.Slice.WriteTo(writer);
        writer.WritePunctuation(SyntaxKind.CommaToken);
        writer.WriteSpace();
        node.Element.WriteTo(writer);
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken);
    }

    private static void WriteMapLiteralExpression(BoundMapLiteralExpression node, IndentedTextWriter writer)
    {
        writer.WriteIdentifier(node.MapType.Name);
        writer.WritePunctuation(SyntaxKind.OpenBraceToken);
        for (var i = 0; i < node.Entries.Length; i++)
        {
            if (i > 0)
            {
                writer.WritePunctuation(SyntaxKind.CommaToken);
                writer.WriteSpace();
            }

            node.Entries[i].Key.WriteTo(writer);
            writer.WritePunctuation(SyntaxKind.ColonToken);
            writer.WriteSpace();
            node.Entries[i].Value.WriteTo(writer);
        }

        writer.WritePunctuation(SyntaxKind.CloseBraceToken);
    }

    private static void WriteMapDeleteExpression(BoundMapDeleteExpression node, IndentedTextWriter writer)
    {
        writer.WriteIdentifier("delete");
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken);
        node.Map.WriteTo(writer);
        writer.WritePunctuation(SyntaxKind.CommaToken);
        writer.WriteSpace();
        node.Key.WriteTo(writer);
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken);
    }

    private static void WriteBlockExpression(BoundBlockExpression node, IndentedTextWriter writer)
    {
        writer.WritePunctuation(SyntaxKind.OpenBraceToken);
        writer.WriteLine();
        writer.Indent++;
        foreach (var statement in node.Statements)
        {
            statement.WriteTo(writer);
        }

        node.Expression.WriteTo(writer);
        writer.WriteLine();
        writer.Indent--;
        writer.WritePunctuation(SyntaxKind.CloseBraceToken);
    }

    private static void WriteStructLiteralExpression(BoundStructLiteralExpression node, IndentedTextWriter writer)
    {
        writer.WriteIdentifier(node.StructType.Name);
        writer.WritePunctuation(SyntaxKind.OpenBraceToken);
        for (var i = 0; i < node.Initializers.Length; i++)
        {
            if (i > 0)
            {
                writer.WritePunctuation(SyntaxKind.CommaToken);
                writer.WriteSpace();
            }

            var init = node.Initializers[i];
            writer.WriteIdentifier(init.Field.Name);
            writer.WritePunctuation(SyntaxKind.ColonToken);
            writer.WriteSpace();
            init.Value.WriteTo(writer);
        }

        writer.WritePunctuation(SyntaxKind.CloseBraceToken);
    }

    private static void WriteConstructorCallExpression(BoundConstructorCallExpression node, IndentedTextWriter writer)
    {
        writer.WriteIdentifier(node.StructType.Name);
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken);
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            if (i > 0)
            {
                writer.WritePunctuation(SyntaxKind.CommaToken);
                writer.WriteSpace();
            }

            node.Arguments[i].WriteTo(writer);
        }

        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken);
    }

    private static void WriteClrConstructorCallExpression(BoundClrConstructorCallExpression node, IndentedTextWriter writer)
    {
        writer.WriteIdentifier(node.ClrType.Name);
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken);
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            if (i > 0)
            {
                writer.WritePunctuation(SyntaxKind.CommaToken);
                writer.WriteSpace();
            }

            node.Arguments[i].WriteTo(writer);
        }

        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken);
    }

    private static void WriteClrPropertyAccessExpression(BoundClrPropertyAccessExpression node, IndentedTextWriter writer)
    {
        if (node.Receiver != null)
        {
            node.Receiver.WriteTo(writer);
        }
        else if (node.Member.DeclaringType != null)
        {
            writer.WriteIdentifier(node.Member.DeclaringType.Name);
        }

        writer.WritePunctuation(SyntaxKind.DotToken);
        writer.WriteIdentifier(node.Member.Name);
    }

    private static void WriteClrPropertyAssignmentExpression(BoundClrPropertyAssignmentExpression node, IndentedTextWriter writer)
    {
        if (node.Receiver != null)
        {
            node.Receiver.WriteTo(writer);
        }
        else if (node.Member.DeclaringType != null)
        {
            writer.WriteIdentifier(node.Member.DeclaringType.Name);
        }

        writer.WritePunctuation(SyntaxKind.DotToken);
        writer.WriteIdentifier(node.Member.Name);
        writer.WriteSpace();
        writer.WritePunctuation(SyntaxKind.EqualsToken);
        writer.WriteSpace();
        node.Value.WriteTo(writer);
    }

    private static void WriteClrEventSubscriptionExpression(BoundClrEventSubscriptionExpression node, IndentedTextWriter writer)
    {
        if (node.Receiver != null)
        {
            node.Receiver.WriteTo(writer);
        }
        else if (node.Event.DeclaringType != null)
        {
            writer.WriteIdentifier(node.Event.DeclaringType.Name);
        }

        writer.WritePunctuation(SyntaxKind.DotToken);
        writer.WriteIdentifier(node.Event.Name);
        writer.WriteSpace();
        writer.WritePunctuation(node.IsAdd ? SyntaxKind.PlusEqualsToken : SyntaxKind.MinusEqualsToken);
        writer.WriteSpace();
        node.Handler.WriteTo(writer);
    }

    private static void WriteClrBinaryOperatorExpression(BoundClrBinaryOperatorExpression node, IndentedTextWriter writer)
    {
        node.Left.WriteTo(writer);
        writer.WriteSpace();
        writer.WritePunctuation(node.OperatorKind);
        writer.WriteSpace();
        node.Right.WriteTo(writer);
    }

    private static void WriteClrUnaryOperatorExpression(BoundClrUnaryOperatorExpression node, IndentedTextWriter writer)
    {
        writer.WritePunctuation(node.OperatorKind);
        node.Operand.WriteTo(writer);
    }

    private static void WriteClrConversionCallExpression(BoundClrConversionCallExpression node, IndentedTextWriter writer)
    {
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken);
        writer.WriteIdentifier(node.Type.Name);
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken);
        node.Source.WriteTo(writer);
    }

    private static void WriteClrIndexExpression(BoundClrIndexExpression node, IndentedTextWriter writer)
    {
        node.Target.WriteTo(writer);
        writer.WritePunctuation(SyntaxKind.OpenSquareBracketToken);
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            if (i > 0)
            {
                writer.WritePunctuation(SyntaxKind.CommaToken);
                writer.WriteSpace();
            }

            node.Arguments[i].WriteTo(writer);
        }

        writer.WritePunctuation(SyntaxKind.CloseSquareBracketToken);
    }

    private static void WriteClrIndexAssignmentExpression(BoundClrIndexAssignmentExpression node, IndentedTextWriter writer)
    {
        writer.WriteIdentifier(node.Target.Name);
        writer.WritePunctuation(SyntaxKind.OpenSquareBracketToken);
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            if (i > 0)
            {
                writer.WritePunctuation(SyntaxKind.CommaToken);
                writer.WriteSpace();
            }

            node.Arguments[i].WriteTo(writer);
        }

        writer.WritePunctuation(SyntaxKind.CloseSquareBracketToken);
        writer.WriteSpace();
        writer.WritePunctuation(SyntaxKind.EqualsToken);
        writer.WriteSpace();
        node.Value.WriteTo(writer);
    }

    private static void WriteUserInstanceCallExpression(BoundUserInstanceCallExpression node, IndentedTextWriter writer)
    {
        node.Receiver.WriteTo(writer);
        writer.WritePunctuation(SyntaxKind.DotToken);
        writer.WriteIdentifier(node.Method.Name);
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken);
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            if (i > 0)
            {
                writer.WritePunctuation(SyntaxKind.CommaToken);
                writer.WriteSpace();
            }

            node.Arguments[i].WriteTo(writer);
        }

        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken);
    }

    private static void WriteFieldAccessExpression(BoundFieldAccessExpression node, IndentedTextWriter writer)
    {
        node.Receiver.WriteTo(writer);
        writer.WritePunctuation(SyntaxKind.DotToken);
        writer.WriteIdentifier(node.Field.Name);
    }

    private static void WriteFieldAssignmentExpression(BoundFieldAssignmentExpression node, IndentedTextWriter writer)
    {
        writer.WriteIdentifier(node.Receiver.Name);
        writer.WritePunctuation(SyntaxKind.DotToken);
        writer.WriteIdentifier(node.Field.Name);
        writer.WriteSpace();
        writer.WritePunctuation(SyntaxKind.EqualsToken);
        writer.WriteSpace();
        node.Value.WriteTo(writer);
    }

    private static void WriteNullConditionalAccessExpression(BoundNullConditionalAccessExpression node, IndentedTextWriter writer)
    {
        node.Receiver.WriteTo(writer);
        writer.WritePunctuation(SyntaxKind.QuestionDotToken);
        node.WhenNotNull.WriteTo(writer);
    }

    private static void WriteTupleLiteralExpression(BoundTupleLiteralExpression node, IndentedTextWriter writer)
    {
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken);
        for (var i = 0; i < node.Elements.Length; i++)
        {
            if (i > 0)
            {
                writer.WritePunctuation(SyntaxKind.CommaToken);
                writer.WriteSpace();
            }

            node.Elements[i].WriteTo(writer);
        }

        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken);
    }

    private static void WriteTupleElementAccessExpression(BoundTupleElementAccessExpression node, IndentedTextWriter writer)
    {
        node.Receiver.WriteTo(writer);
        writer.WritePunctuation(SyntaxKind.DotToken);
        writer.WriteIdentifier($"Item{node.Index + 1}");
    }

    private static void WriteFunctionLiteralExpression(BoundFunctionLiteralExpression node, IndentedTextWriter writer)
    {
        writer.WriteKeyword(SyntaxKind.FuncKeyword);
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken);
        for (var i = 0; i < node.Function.Parameters.Length; i++)
        {
            if (i > 0)
            {
                writer.WritePunctuation(SyntaxKind.CommaToken);
                writer.WriteSpace();
            }

            writer.WriteIdentifier(node.Function.Parameters[i].Name);
        }

        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken);
        writer.WriteSpace();
        node.Body.WriteTo(writer);
    }

    private static void WriteIndirectCallExpression(BoundIndirectCallExpression node, IndentedTextWriter writer)
    {
        node.Target.WriteTo(writer);
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken);
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            if (i > 0)
            {
                writer.WritePunctuation(SyntaxKind.CommaToken);
                writer.WriteSpace();
            }

            node.Arguments[i].WriteTo(writer);
        }

        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken);
    }

    private static void WriteAddressOfExpression(BoundAddressOfExpression node, IndentedTextWriter writer)
    {
        writer.WritePunctuation(SyntaxKind.AmpersandToken);
        node.Operand.WriteTo(writer);
    }

    private static void WriteDereferenceExpression(BoundDereferenceExpression node, IndentedTextWriter writer)
    {
        writer.WritePunctuation(SyntaxKind.StarToken);
        node.Operand.WriteTo(writer);
    }

    private static void WriteStateMachineAwaitOnCompleted(BoundStateMachineAwaitOnCompleted node, IndentedTextWriter writer)
    {
        var method = node.UseCritical ? "AwaitUnsafeOnCompleted" : "AwaitOnCompleted";
        writer.WriteKeyword("builder.");
        writer.WriteIdentifier(method);
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken);
        writer.WriteIdentifier("ref ");
        writer.WriteIdentifier(node.AwaiterLocal.Name);
        writer.WritePunctuation(SyntaxKind.CommaToken);
        writer.WriteSpace();
        writer.WriteIdentifier("ref this");
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken);
    }

    private static void WriteSpillSequenceExpression(BoundSpillSequenceExpression node, IndentedTextWriter writer)
    {
        writer.WriteKeyword("spill_seq");
        writer.WritePunctuation(SyntaxKind.OpenBraceToken);
        writer.WriteLine();
        writer.Indent++;
        foreach (var local in node.Locals)
        {
            writer.WriteKeyword("var ");
            writer.WriteIdentifier(local.Name);
            writer.WriteLine();
        }

        foreach (var stmt in node.SideEffects)
        {
            stmt.WriteTo(writer);
            writer.WriteLine();
        }

        node.Value.WriteTo(writer);
        writer.WriteLine();
        writer.Indent--;
        writer.WritePunctuation(SyntaxKind.CloseBraceToken);
    }

    private static void WriteDefaultExpression(BoundDefaultExpression node, IndentedTextWriter writer)
    {
        writer.WriteKeyword("default");
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken);
        writer.WriteIdentifier(node.Type.Name);
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken);
    }
}
