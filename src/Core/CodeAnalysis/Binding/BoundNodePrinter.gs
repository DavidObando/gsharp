// <copyright file="BoundNodePrinter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.CodeDom.Compiler
import System.IO
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.IO
import GSharp.Core.CodeAnalysis
import System.Globalization
import System.Reflection

/// Helps print bound nodes in an idiomatic way.
shared class BoundNodePrinter {
    private func WriteBlockStatement(node BoundBlockStatement, writer IndentedTextWriter) {
        writer.WritePunctuation(SyntaxKind.OpenBraceToken)
        writer.WriteLine()
        writer.Indent++
        for s in node.Statements {
            BoundNodePrinter.WriteTo(s, writer)
        }
        writer.Indent--
        writer.WritePunctuation(SyntaxKind.CloseBraceToken)
        writer.WriteLine()
    }

    private func WriteVariableDeclaration(node BoundVariableDeclaration, writer IndentedTextWriter) {
        if node.Variable.IsReadOnly {
            writer.WriteKeyword(SyntaxKind.ConstKeyword)
            writer.WriteSpace()
        }
        writer.WriteIdentifier(node.Variable.Name)
        writer.WriteSpace()
        if node.Variable.IsReadOnly {
            writer.WritePunctuation(SyntaxKind.EqualsToken)
        } else {
            writer.WritePunctuation(SyntaxKind.ColonEqualsToken)
        }
        writer.WriteSpace()
        let initializer BoundExpression? = node.Initializer
        if initializer != nil {
            BoundNodePrinter.WriteTo(initializer, writer)
        }
        writer.WriteLine()
    }

    private func WriteLocalFunctionDeclaration(node BoundLocalFunctionDeclaration, writer IndentedTextWriter) {
        writer.WriteKeyword(SyntaxKind.LetKeyword)
        writer.WriteSpace()
        writer.WriteIdentifier(node.Literal.Function.Name)
        writer.WritePunctuation(SyntaxKind.OpenSquareBracketToken)
        for var i = 0; i < node.Literal.Function.TypeParameters.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            writer.WriteIdentifier(node.Literal.Function.TypeParameters[i].Name)
        }
        writer.WritePunctuation(SyntaxKind.CloseSquareBracketToken)
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.EqualsToken)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Literal, writer)
        writer.WriteLine()
    }

    private func WriteIfStatement(node BoundIfStatement, writer IndentedTextWriter) {
        writer.WriteKeyword(SyntaxKind.IfKeyword)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Condition, writer)
        writer.WriteSpace()
        writer.WriteNestedStatement(node.ThenStatement)
        if node.ElseStatement != nil {
            writer.WriteKeyword(SyntaxKind.ElseKeyword)
            writer.WriteSpace()
            writer.WriteNestedStatement(node.ElseStatement!!)
        }
    }

    private func WriteForInfiniteStatement(node BoundForInfiniteStatement, writer IndentedTextWriter) {
        writer.WriteKeyword(SyntaxKind.ForKeyword)
        writer.WriteSpace()
        writer.WriteNestedStatement(node.Body)
    }

    private func WriteForEllipsisStatement(node BoundForEllipsisStatement, writer IndentedTextWriter) {
        writer.WriteKeyword(SyntaxKind.ForKeyword)
        writer.WriteSpace()
        writer.WriteIdentifier(node.Variable.Name)
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.ColonEqualsToken)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.LowerBound, writer)
        writer.WriteSpace()
        writer.WriteKeyword(SyntaxKind.EllipsisToken)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.UpperBound, writer)
        writer.WriteSpace()
        writer.WriteNestedStatement(node.Body)
    }

    private func WriteForRangeStatement(node BoundForRangeStatement, writer IndentedTextWriter) {
        writer.WriteKeyword(SyntaxKind.ForKeyword)
        writer.WriteSpace()
        if node.KeyVariable != nil {
            writer.WriteIdentifier(node.KeyVariable.Name)
            writer.WritePunctuation(SyntaxKind.CommaToken)
            writer.WriteSpace()
        }
        writer.WriteIdentifier(node.ValueVariable.Name)
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.ColonEqualsToken)
        writer.WriteSpace()
        writer.WriteKeyword(SyntaxKind.RangeKeyword)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Collection, writer)
        writer.WriteSpace()
        writer.WriteNestedStatement(node.Body)
    }

    private func WriteLabelStatement(node BoundLabelStatement, writer IndentedTextWriter) {
        let unindent = writer.Indent > 0
        if unindent {
            writer.Indent--
        }
        writer.WritePunctuation(node.Label.Name)
        writer.WritePunctuation(SyntaxKind.ColonToken)
        writer.WriteLine()
        if unindent {
            writer.Indent++
        }
    }

    private func WriteGotoStatement(node BoundGotoStatement, writer IndentedTextWriter) {
        writer.WriteKeyword("goto") // There is no SyntaxKind for goto
        writer.WriteSpace()
        writer.WriteIdentifier(node.Label.Name)
        writer.WriteLine()
    }

    private func WriteConditionalGotoStatement(node BoundConditionalGotoStatement, writer IndentedTextWriter) {
        writer.WriteKeyword("goto") // There is no SyntaxKind for goto
        writer.WriteSpace()
        writer.WriteIdentifier(node.Label.Name)
        writer.WriteSpace()
        writer.WriteKeyword(
            if node.JumpIfTrue {
                "if"
            } else {
                "unless"
            }
        )
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Condition, writer)
        writer.WriteLine()
    }

    private func WriteReturnStatement(node BoundReturnStatement, writer IndentedTextWriter) {
        writer.WriteKeyword(SyntaxKind.ReturnKeyword)
        if node.Expression != nil {
            writer.WriteSpace()
            BoundNodePrinter.WriteTo(node.Expression!!, writer)
        }
        writer.WriteLine()
    }

    private func WriteExpressionStatement(node BoundExpressionStatement, writer IndentedTextWriter) {
        BoundNodePrinter.WriteTo(node.Expression, writer)
        writer.WriteLine()
    }

    private func WriteTryStatement(node BoundTryStatement, writer IndentedTextWriter) {
        writer.WriteKeyword(SyntaxKind.TryKeyword)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.TryBlock, writer)
        for clause in node.CatchClauses {
            writer.WriteKeyword(SyntaxKind.CatchKeyword)
            writer.WriteSpace()
            writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
            if clause.Variable != nil {
                writer.WriteIdentifier(clause.Variable.Name)
                writer.WriteSpace()
            }
            writer.WriteIdentifier(clause.ExceptionType.Name)
            writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
            writer.WriteSpace()
            if clause.Filter != nil {
                writer.WriteIdentifier("when")
                writer.WriteSpace()
                BoundNodePrinter.WriteTo(clause.Filter!!, writer)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(clause.Body, writer)
        }
        if node.FinallyBlock != nil {
            writer.WriteKeyword(SyntaxKind.FinallyKeyword)
            writer.WriteSpace()
            BoundNodePrinter.WriteTo(node.FinallyBlock!!, writer)
        }
    }

    private func WriteThrowStatement(node BoundThrowStatement, writer IndentedTextWriter) {
        writer.WriteKeyword(SyntaxKind.ThrowKeyword)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Expression, writer)
        writer.WriteLine()
    }

    private func WriteRethrowStatement(writer IndentedTextWriter) {
        writer.WriteKeyword(SyntaxKind.RethrowKeyword)
        writer.WriteLine()
    }

    private func WriteGoStatement(node BoundGoStatement, writer IndentedTextWriter) {
        writer.WriteKeyword(SyntaxKind.GoKeyword)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Expression, writer)
        writer.WriteLine()
    }

    private func WriteErrorExpression(node BoundErrorExpression, writer IndentedTextWriter) {
        writer.WriteKeyword(node.Type.Name)
    }

    private func WriteLiteralExpression(node BoundLiteralExpression, writer IndentedTextWriter) {
        if node.Type == TypeSymbol.Null {
            writer.WriteKeyword(SyntaxKind.NilKeyword)
            return
        }
        var value = node.Value?.ToString() ?? string.Empty
        if node.Type == TypeSymbol.Bool {
            writer.WriteKeyword(
                if object.Equals(node.Value, true) {
                    SyntaxKind.TrueKeyword
                } else {
                    SyntaxKind.FalseKeyword
                }
            )
        } else if node.Type == TypeSymbol.String {
            value = "\"" + value.Replace("\"", "\\\"") + "\""
            writer.WriteString(value)
        } else if node.Type == TypeSymbol.Char {
            writer.WriteString("'" + value.Replace("'", "\\'") + "'")
        } else if IsRecognizedNumericLiteralType(node.Type) || node.Value is int32 {
            writer.WriteNumber(value)
        } else {
            throw Exception("Unexpected type ${node.Type}")
        }
    }

    private func IsRecognizedNumericLiteralType(t TypeSymbol) bool {
        return t == TypeSymbol.Int8 ||
            t == TypeSymbol.UInt8 ||
            t == TypeSymbol.Int16 ||
            t == TypeSymbol.UInt16 ||
            t == TypeSymbol.Int32 ||
            t == TypeSymbol.UInt32 ||
            t == TypeSymbol.Int64 ||
            t == TypeSymbol.UInt64 ||
            t == TypeSymbol.NInt ||
            t == TypeSymbol.NUInt ||
            t == TypeSymbol.Float32 ||
            t == TypeSymbol.Float64 ||
            t == TypeSymbol.Decimal
    }

    private func WriteVariableExpression(node BoundVariableExpression, writer IndentedTextWriter) {
        writer.WriteIdentifier(node.Variable.Name)
    }

    private func WriteAssignmentExpression(node BoundAssignmentExpression, writer IndentedTextWriter) {
        writer.WriteIdentifier(node.Variable.Name)
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.EqualsToken)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Expression, writer)
    }

    private func WriteUnaryExpression(node BoundUnaryExpression, writer IndentedTextWriter) {
        let precedence = node.Op.SyntaxKind.GetUnaryOperatorPrecedence()
        writer.WritePunctuation(node.Op.SyntaxKind)
        writer.WriteNestedExpression(precedence, node.Operand)
    }

    private func WriteBinaryExpression(node BoundBinaryExpression, writer IndentedTextWriter) {
        let precedence = node.Op.SyntaxKind.GetBinaryOperatorPrecedence()
        writer.WriteNestedExpression(precedence, node.Left)
        writer.WriteSpace()
        writer.WritePunctuation(node.Op.SyntaxKind)
        writer.WriteSpace()
        writer.WriteNestedExpression(precedence, node.Right)
    }

    private func WriteCallExpression(node BoundCallExpression, writer IndentedTextWriter) {
        writer.WriteIdentifier(node.Function.Name)
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        var isFirst = true
        for argument in node.Arguments {
            if isFirst {
                isFirst = false
            } else {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(argument, writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteConversionExpression(node BoundConversionExpression, writer IndentedTextWriter) {
        writer.WriteIdentifier(node.Type.Name)
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        BoundNodePrinter.WriteTo(node.Expression, writer)
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteAwaitExpression(node BoundAwaitExpression, writer IndentedTextWriter) {
        writer.WriteKeyword(SyntaxKind.AwaitKeyword)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Expression, writer)
    }

    private func WritePatternSwitchStatement(node BoundPatternSwitchStatement, writer IndentedTextWriter) {
        writer.WriteKeyword(SyntaxKind.SwitchKeyword)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Discriminant, writer)
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.OpenBraceToken)
        writer.WriteLine()
        writer.Indent++
        for arm in node.Arms {
            if arm.IsDefault {
                writer.WriteKeyword(SyntaxKind.DefaultKeyword)
            } else {
                writer.WriteKeyword(SyntaxKind.CaseKeyword)
                writer.WriteSpace()
                WritePattern(arm.Pattern!!, writer)
            }
            if arm.Guard != nil {
                writer.WriteSpace()
                writer.WriteKeyword("when")
                writer.WriteSpace()
                BoundNodePrinter.WriteTo(arm.Guard!!, writer)
            }
            writer.WriteLine()
            writer.WriteNestedStatement(arm.Body)
        }
        writer.Indent--
        writer.WritePunctuation(SyntaxKind.CloseBraceToken)
        writer.WriteLine()
    }

    private func WritePattern(pattern BoundPattern, writer IndentedTextWriter) {
        switch pattern.Kind {
            case BoundNodeKind.ConstantPattern {
                BoundNodePrinter.WriteTo((cast[BoundConstantPattern](pattern)).Value, writer)
            }
            case BoundNodeKind.DiscardPattern {
                let discardPattern = cast[BoundDiscardPattern](pattern)
                if discardPattern.Syntax is VarPatternSyntax {
                    writer.WriteKeyword(SyntaxKind.VarKeyword)
                    writer.WriteSpace()
                    writer.WriteIdentifier(discardPattern.Variable?.Name ?? "_")
                } else {
                    writer.WriteIdentifier("_")
                }
            }
            case BoundNodeKind.TypePattern {
                let typePattern = cast[BoundTypePattern](pattern)
                if typePattern.HasBinding {
                    writer.WriteIdentifier(typePattern.Variable.Name)
                    writer.WriteSpace()
                    writer.WriteKeyword(SyntaxKind.IsKeyword)
                    writer.WriteSpace()
                } else if (typePattern.Syntax is TypePatternSyntax and {Identifier: {ValueText: "_"}}) {
                    writer.WriteIdentifier("_")
                    writer.WriteSpace()
                    writer.WriteKeyword(SyntaxKind.IsKeyword)
                    writer.WriteSpace()
                }
                writer.WriteIdentifier(typePattern.TargetType.Name)
                if typePattern.PropertyPattern != nil {
                    writer.WriteSpace()
                    WritePattern(typePattern.PropertyPattern!!, writer)
                }
            }
            case BoundNodeKind.RelationalPattern {
                let relational = cast[BoundRelationalPattern](pattern)
                writer.WritePunctuation(relational.Op.SyntaxKind)
                writer.WriteSpace()
                BoundNodePrinter.WriteTo(relational.Value, writer)
            }
            case BoundNodeKind.PropertyPattern {
                let property = cast[BoundPropertyPattern](pattern)
                writer.WritePunctuation(SyntaxKind.OpenBraceToken)
                for var i = 0; i < property.Fields.Length; i++ {
                    if i > 0 {
                        writer.WritePunctuation(SyntaxKind.CommaToken)
                        writer.WriteSpace()
                    }
                    writer.WriteIdentifier(property.Fields[i].Name)
                    writer.WritePunctuation(SyntaxKind.ColonToken)
                    writer.WriteSpace()
                    WritePattern(property.Fields[i].Pattern, writer)
                }
                writer.WritePunctuation(SyntaxKind.CloseBraceToken)
            }
            case BoundNodeKind.ListPattern {
                let list = cast[BoundListPattern](pattern)
                writer.WritePunctuation(SyntaxKind.OpenSquareBracketToken)
                for var i = 0; i < list.Elements.Length; i++ {
                    if i > 0 {
                        writer.WritePunctuation(SyntaxKind.CommaToken)
                        writer.WriteSpace()
                    }
                    WritePattern(list.Elements[i], writer)
                }
                writer.WritePunctuation(SyntaxKind.CloseSquareBracketToken)
            }
            case BoundNodeKind.SlicePattern {
                let slice = cast[BoundSlicePattern](pattern)
                writer.WritePunctuation(SyntaxKind.DotDotToken)
                if slice.Variable != nil && slice.Pattern == nil {
                    writer.WriteIdentifier(slice.Variable.Name)
                } else if slice.Pattern != nil {
                    WritePattern(slice.Pattern, writer)
                }
            }
            case BoundNodeKind.BinaryPattern {
                let binary = cast[BoundBinaryPattern](pattern)
                WritePattern(binary.Left, writer)
                writer.WriteSpace()
                writer.WriteIdentifier(
                    if binary.IsConjunction {
                        "and"
                    } else {
                        "or"
                    }
                )
                writer.WriteSpace()
                WritePattern(binary.Right, writer)
            }
            case BoundNodeKind.NotPattern {
                let not = cast[BoundNotPattern](pattern)
                writer.WriteIdentifier("not")
                writer.WriteSpace()
                WritePattern(not.Pattern, writer)
            }
            default {
                throw Exception("Unexpected pattern node ${pattern.Kind}")
            }
        }
    }

    private func WriteSwitchExpression(node BoundSwitchExpression, writer IndentedTextWriter) {
        writer.WriteKeyword(SyntaxKind.SwitchKeyword)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Discriminant, writer)
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.OpenBraceToken)
        writer.WriteSpace()
        for arm in node.Arms {
            WriteSwitchExpressionArm(arm, writer)
            writer.WriteSpace()
        }
        writer.WritePunctuation(SyntaxKind.CloseBraceToken)
    }

    private func WriteSwitchExpressionArm(arm BoundSwitchExpressionArm, writer IndentedTextWriter) {
        if arm.IsDefault {
            writer.WriteKeyword(SyntaxKind.DefaultKeyword)
        } else {
            writer.WriteKeyword(SyntaxKind.CaseKeyword)
            writer.WriteSpace()
            WritePattern(arm.Pattern!!, writer)
        }
        if arm.Guard != nil {
            writer.WriteSpace()
            writer.WriteKeyword("when")
            writer.WriteSpace()
            BoundNodePrinter.WriteTo(arm.Guard!!, writer)
        }
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.RightArrowToken)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(arm.Result, writer)
    }

    private func WriteFixedStatement(node BoundFixedStatement, writer IndentedTextWriter) {
        writer.WriteIdentifier("fixed")
        writer.WriteSpace()
        writer.WriteIdentifier(node.PointerVariable.Name)
        writer.WriteSpace()
        writer.WriteIdentifier(node.PointerVariable.Type.Name)
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.EqualsToken)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.PinnedSource, writer)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Body, writer)
    }

    private func WriteAwaitForRangeStatement(node BoundAwaitForRangeStatement, writer IndentedTextWriter) {
        writer.WriteKeyword(SyntaxKind.AwaitKeyword)
        writer.WriteSpace()
        writer.WriteKeyword(SyntaxKind.ForKeyword)
        writer.WriteSpace()
        writer.WriteIdentifier(node.ValueVariable.Name)
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.ColonEqualsToken)
        writer.WriteSpace()
        writer.WriteKeyword(SyntaxKind.RangeKeyword)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Stream, writer)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Body, writer)
    }

    private func WriteYieldStatement(node BoundYieldStatement, writer IndentedTextWriter) {
        writer.WriteIdentifier("yield")
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Expression, writer)
    }

    private func WriteImportedCallExpression(node BoundImportedCallExpression, writer IndentedTextWriter) {
        writer.WriteIdentifier(node.Function.ImportedClass.Name)
        writer.WritePunctuation(SyntaxKind.DotToken)
        writer.WriteIdentifier(node.Function.Name)
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        var isFirst = true
        for argument in node.Arguments {
            if isFirst {
                isFirst = false
            } else {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(argument, writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteImportedInstanceCallExpression(
        node BoundImportedInstanceCallExpression,
        writer IndentedTextWriter
    ) {
        BoundNodePrinter.WriteTo(node.Receiver, writer)
        writer.WritePunctuation(SyntaxKind.DotToken)
        writer.WriteIdentifier(node.Method.Name)
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        var isFirst = true
        for argument in node.Arguments {
            if isFirst {
                isFirst = false
            } else {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(argument, writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteConstrainedStaticCallExpression(
        node BoundConstrainedStaticCallExpression,
        writer IndentedTextWriter
    ) {
        // ADR-0089 / issue #755: print as `T.M(args)` — the receiver is a
        // type parameter, the slot is an interface static-virtual method.
        writer.WriteIdentifier(node.TypeParameter.Name)
        writer.WritePunctuation(SyntaxKind.DotToken)
        writer.WriteIdentifier(node.InterfaceMethod?.Name ?? node.ClrMethod?.Name ?? "?")
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        var isFirst = true
        for argument in node.Arguments {
            if isFirst {
                isFirst = false
            } else {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(argument, writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteStackAllocExpression(node BoundStackAllocExpression, writer IndentedTextWriter) {
        writer.WriteKeyword("stackalloc")
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.OpenSquareBracketToken)
        if !node.HasInitializer {
            BoundNodePrinter.WriteTo(node.Count, writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseSquareBracketToken)
        writer.WriteIdentifier(node.ElementType.Name)
        if node.HasInitializer {
            writer.WritePunctuation(SyntaxKind.OpenBraceToken)
            for var i = 0; i < node.InitializerElements.Length; i++ {
                if i > 0 {
                    writer.WritePunctuation(SyntaxKind.CommaToken)
                    writer.WriteSpace()
                }
                BoundNodePrinter.WriteTo(node.InitializerElements[i], writer)
            }
            writer.WritePunctuation(SyntaxKind.CloseBraceToken)
        }
    }

    private func WriteArrayCreationExpression(node BoundArrayCreationExpression, writer IndentedTextWriter) {
        writer.WritePunctuation(SyntaxKind.OpenSquareBracketToken)
        if node.DimensionExpressions.Length > 1 {
            for var i = 0; i < node.DimensionExpressions.Length; i++ {
                if i > 0 {
                    writer.WritePunctuation(SyntaxKind.CommaToken)
                    writer.WriteSpace()
                }
                BoundNodePrinter.WriteTo(node.DimensionExpressions[i], writer)
            }
        } else if node.ContainerType is ArrayTypeSymbol arr {
            writer.WriteNumber(arr.Length.ToString())
        }
        writer.WritePunctuation(SyntaxKind.CloseSquareBracketToken)
        writer.WriteIdentifier(node.ElementType.Name)
        // Issue #1016: runtime-length form prints as `[]T(length)`.
        if node.LengthExpression != nil && node.DimensionExpressions.Length <= 1 {
            writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
            BoundNodePrinter.WriteTo(node.LengthExpression!!, writer)
            writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
            return
        }
        if node.ContainerType is RectangularArrayTypeSymbol && node.Elements.IsDefaultOrEmpty {
            return
        }
        writer.WritePunctuation(SyntaxKind.OpenBraceToken)
        var isFirst = true
        for element in node.Elements {
            if isFirst {
                isFirst = false
            } else {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(element, writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseBraceToken)
    }

    private func WriteIndexExpression(node BoundIndexExpression, writer IndentedTextWriter) {
        BoundNodePrinter.WriteTo(node.Target, writer)
        writer.WritePunctuation(SyntaxKind.OpenSquareBracketToken)
        for var i = 0; i < node.Indices.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(node.Indices[i], writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseSquareBracketToken)
    }

    private func WriteIndexAssignmentExpression(node BoundIndexAssignmentExpression, writer IndentedTextWriter) {
        if node.TargetExpression != nil {
            BoundNodePrinter.WriteTo(node.TargetExpression, writer)
        } else {
            writer.WriteIdentifier(node.Target?.Name ?? string.Empty)
        }
        writer.WritePunctuation(SyntaxKind.OpenSquareBracketToken)
        for var i = 0; i < node.Indices.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(node.Indices[i], writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseSquareBracketToken)
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.EqualsToken)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Value, writer)
    }

    private func WriteIntrinsicCall(name string, operand BoundExpression, writer IndentedTextWriter) {
        writer.WriteIdentifier(name)
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        BoundNodePrinter.WriteTo(operand, writer)
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteTypeOfExpression(node BoundTypeOfExpression, writer IndentedTextWriter) {
        writer.WriteIdentifier("typeof")
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        writer.WriteIdentifier(node.OperandType.Name)
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteManagedFieldKeyExpression(node BoundManagedFieldKeyExpression, writer IndentedTextWriter) {
        writer.WriteIdentifier("managedFieldKey")
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        BoundNodePrinter.WriteTo(node.Parent, writer)
        writer.WritePunctuation(SyntaxKind.CommaToken)
        writer.WriteSpace()
        // The field's original receiver is metadata, not a second evaluation.
        switch node.Field {
            case field is BoundFieldAccessExpression {
                writer.WriteIdentifier(
                    Invariant.Required(
                        field.StructType,
                        "persistent fields have a declaring type",
                        expression: "field.StructType"
                    )
                        .Name
                )
                writer.WritePunctuation(SyntaxKind.DotToken)
                writer.WriteIdentifier(field.Field.Name)
            }
            case BoundClrPropertyAccessExpression{Member: FieldInfo field} access {
                writer.WriteIdentifier(
                    access.StaticContainerType?.Name ?? Invariant.Required(
                        field.DeclaringType,
                        "instance fields have a declaring type",
                        expression: "field.DeclaringType"
                    )
                        .ToString()
                )
                writer.WritePunctuation(SyntaxKind.DotToken)
                writer.WriteIdentifier(field.Name)
            }
            default {
                throw InvalidOperationException("Persistent field identity requires a resolved field.")
            }
        }
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteSizeOfExpression(node BoundSizeOfExpression, writer IndentedTextWriter) {
        writer.WriteIdentifier("sizeof")
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        writer.WriteIdentifier(node.MeasuredType.Name)
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteFunctionPointerFromMethodExpression(
        node BoundFunctionPointerFromMethodExpression,
        writer IndentedTextWriter
    ) {
        writer.WritePunctuation(SyntaxKind.AmpersandToken)
        writer.WriteIdentifier(node.Method.Name)
    }

    private func WriteFunctionPointerInvocationExpression(
        node BoundFunctionPointerInvocationExpression,
        writer IndentedTextWriter
    ) {
        BoundNodePrinter.WriteTo(node.Pointer, writer)
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        for var i = 0; i < node.Arguments.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(node.Arguments[i], writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteMapLiteralExpression(node BoundMapLiteralExpression, writer IndentedTextWriter) {
        writer.WriteIdentifier(node.MapType.Name)
        writer.WritePunctuation(SyntaxKind.OpenBraceToken)
        for var i = 0; i < node.Entries.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(node.Entries[i].Key, writer)
            writer.WritePunctuation(SyntaxKind.ColonToken)
            writer.WriteSpace()
            BoundNodePrinter.WriteTo(node.Entries[i].Value, writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseBraceToken)
    }

    private func WriteBlockExpression(node BoundBlockExpression, writer IndentedTextWriter) {
        writer.WritePunctuation(SyntaxKind.OpenBraceToken)
        writer.WriteLine()
        writer.Indent++
        for statement in node.Statements {
            BoundNodePrinter.WriteTo(statement, writer)
        }
        BoundNodePrinter.WriteTo(node.Expression, writer)
        writer.WriteLine()
        writer.Indent--
        writer.WritePunctuation(SyntaxKind.CloseBraceToken)
    }

    private func WriteStructLiteralExpression(node BoundStructLiteralExpression, writer IndentedTextWriter) {
        writer.WriteIdentifier(node.StructType.Name)
        writer.WritePunctuation(SyntaxKind.OpenBraceToken)
        for var i = 0; i < node.Initializers.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            let init = node.Initializers[i]
            writer.WriteIdentifier(init.MemberName)
            writer.WritePunctuation(SyntaxKind.ColonToken)
            writer.WriteSpace()
            BoundNodePrinter.WriteTo(init.Value, writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseBraceToken)
    }

    private func WriteConstructorCallExpression(node BoundConstructorCallExpression, writer IndentedTextWriter) {
        writer.WriteIdentifier(node.StructType.Name)
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        for var i = 0; i < node.Arguments.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(node.Arguments[i], writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteConstructorChainingExpression(
        node BoundConstructorChainingExpression,
        writer IndentedTextWriter
    ) {
        writer.WriteKeyword("init")
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        for var i = 0; i < node.Arguments.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(node.Arguments[i], writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteClrConstructorCallExpression(node BoundClrConstructorCallExpression, writer IndentedTextWriter) {
        writer.WriteIdentifier(node.ClrType.Name)
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        for var i = 0; i < node.Arguments.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(node.Arguments[i], writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteClrStaticCallExpression(node BoundClrStaticCallExpression, writer IndentedTextWriter) {
        if node.Method.DeclaringType != nil {
            writer.WriteIdentifier(node.Method.DeclaringType!!.Name)
            writer.WritePunctuation(SyntaxKind.DotToken)
        }
        writer.WriteIdentifier(node.Method.Name)
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        for var i = 0; i < node.Arguments.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(node.Arguments[i], writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteClrPropertyAccessExpression(node BoundClrPropertyAccessExpression, writer IndentedTextWriter) {
        if node.Receiver != nil {
            BoundNodePrinter.WriteTo(node.Receiver, writer)
        } else if node.Member.DeclaringType != nil {
            writer.WriteIdentifier(node.Member.DeclaringType!!.Name)
        }
        writer.WritePunctuation(SyntaxKind.DotToken)
        writer.WriteIdentifier(node.Member.Name)
    }

    private func WriteClrPropertyAssignmentExpression(
        node BoundClrPropertyAssignmentExpression,
        writer IndentedTextWriter
    ) {
        if node.Receiver != nil {
            BoundNodePrinter.WriteTo(node.Receiver, writer)
        } else if node.Member.DeclaringType != nil {
            writer.WriteIdentifier(node.Member.DeclaringType!!.Name)
        }
        writer.WritePunctuation(SyntaxKind.DotToken)
        writer.WriteIdentifier(node.Member.Name)
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.EqualsToken)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Value, writer)
    }

    private func WriteClrEventSubscriptionExpression(
        node BoundClrEventSubscriptionExpression,
        writer IndentedTextWriter
    ) {
        if node.Receiver != nil {
            BoundNodePrinter.WriteTo(node.Receiver, writer)
        } else if node.Event.DeclaringType != nil {
            writer.WriteIdentifier(node.Event.DeclaringType!!.Name)
        }
        writer.WritePunctuation(SyntaxKind.DotToken)
        writer.WriteIdentifier(node.Event.Name)
        writer.WriteSpace()
        writer.WritePunctuation(
            if node.IsAdd {
                SyntaxKind.PlusEqualsToken
            } else {
                SyntaxKind.MinusEqualsToken
            }
        )
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Handler, writer)
    }

    private func WriteEventSubscriptionExpression(node BoundEventSubscriptionExpression, writer IndentedTextWriter) {
        if node.Receiver != nil {
            BoundNodePrinter.WriteTo(node.Receiver, writer)
        } else {
            writer.WriteIdentifier(node.StructType.Name)
        }
        writer.WritePunctuation(SyntaxKind.DotToken)
        writer.WriteIdentifier(node.Event.Name)
        writer.WriteSpace()
        writer.WritePunctuation(
            if node.IsAdd {
                SyntaxKind.PlusEqualsToken
            } else {
                SyntaxKind.MinusEqualsToken
            }
        )
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Handler, writer)
    }

    private func WriteClrBinaryOperatorExpression(node BoundClrBinaryOperatorExpression, writer IndentedTextWriter) {
        BoundNodePrinter.WriteTo(node.Left, writer)
        writer.WriteSpace()
        writer.WritePunctuation(node.OperatorKind)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Right, writer)
    }

    private func WriteClrUnaryOperatorExpression(node BoundClrUnaryOperatorExpression, writer IndentedTextWriter) {
        writer.WritePunctuation(node.OperatorKind)
        BoundNodePrinter.WriteTo(node.Operand, writer)
    }

    private func WriteClrConversionCallExpression(node BoundClrConversionCallExpression, writer IndentedTextWriter) {
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        writer.WriteIdentifier(node.Type.Name)
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
        BoundNodePrinter.WriteTo(node.Source, writer)
    }

    private func WriteClrIndexExpression(node BoundClrIndexExpression, writer IndentedTextWriter) {
        BoundNodePrinter.WriteTo(node.Target, writer)
        writer.WritePunctuation(SyntaxKind.OpenSquareBracketToken)
        for var i = 0; i < node.Arguments.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(node.Arguments[i], writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseSquareBracketToken)
    }

    private func WriteClrIndexAssignmentExpression(node BoundClrIndexAssignmentExpression, writer IndentedTextWriter) {
        if node.TargetExpression != nil {
            BoundNodePrinter.WriteTo(node.TargetExpression, writer)
        } else {
            writer.WriteIdentifier(node.Target?.Name ?? string.Empty)
        }
        writer.WritePunctuation(SyntaxKind.OpenSquareBracketToken)
        for var i = 0; i < node.Arguments.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(node.Arguments[i], writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseSquareBracketToken)
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.EqualsToken)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Value, writer)
    }

    private func WriteUserInstanceCallExpression(node BoundUserInstanceCallExpression, writer IndentedTextWriter) {
        BoundNodePrinter.WriteTo(node.Receiver, writer)
        writer.WritePunctuation(SyntaxKind.DotToken)
        writer.WriteIdentifier(node.Method.Name)
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        for var i = 0; i < node.Arguments.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(node.Arguments[i], writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteBaseClassCallExpression(node BoundBaseClassCallExpression, writer IndentedTextWriter) {
        writer.WriteKeyword("base")
        writer.WritePunctuation(SyntaxKind.OpenSquareBracketToken)
        writer.WriteIdentifier(node.BaseClass.Name)
        writer.WritePunctuation(SyntaxKind.CloseSquareBracketToken)
        writer.WritePunctuation(SyntaxKind.DotToken)
        writer.WriteIdentifier(
            node
                .Method
                ?.Name ??
                (
                (
                    if node.IsSetterAccessor {
                        "set_"
                    } else {
                        "get_"
                    }
                ) +
                    node
                    .Property
                    ?.Name
            )
        )
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        for var i = 0; i < node.Arguments.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(node.Arguments[i], writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteBaseInterfaceCallExpression(node BoundBaseInterfaceCallExpression, writer IndentedTextWriter) {
        writer.WriteKeyword("base")
        writer.WritePunctuation(SyntaxKind.OpenSquareBracketToken)
        writer.WriteIdentifier(node.Interface.Name)
        writer.WritePunctuation(SyntaxKind.CloseSquareBracketToken)
        writer.WritePunctuation(SyntaxKind.DotToken)
        writer.WriteIdentifier(node.Method.Name)
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        for var i = 0; i < node.Arguments.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(node.Arguments[i], writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteFieldAccessExpression(node BoundFieldAccessExpression, writer IndentedTextWriter) {
        if node.Receiver != nil {
            BoundNodePrinter.WriteTo(node.Receiver, writer)
        } else if node.StructType != nil {
            writer.WriteIdentifier(node.StructType.Name)
        } else {
            // Issue #1030: an interface static field access carries no
            // declaring struct. Print `IName.Field` when the owning interface
            // is known, otherwise the field name unqualified.
            if node.InterfaceType != nil {
                writer.WriteIdentifier(node.InterfaceType.Name)
                writer.WritePunctuation(SyntaxKind.DotToken)
            }
            writer.WriteIdentifier(node.Field.Name)
            return
        }
        writer.WritePunctuation(SyntaxKind.DotToken)
        writer.WriteIdentifier(node.Field.Name)
    }

    private func WriteFieldAssignmentExpression(node BoundFieldAssignmentExpression, writer IndentedTextWriter) {
        if node.Receiver != nil {
            writer.WriteIdentifier(node.Receiver.Name)
            writer.WritePunctuation(SyntaxKind.DotToken)
            writer.WriteIdentifier(node.Field.Name)
        } else if node.StructType != nil {
            writer.WriteIdentifier(node.StructType.Name)
            writer.WritePunctuation(SyntaxKind.DotToken)
            writer.WriteIdentifier(node.Field.Name)
        } else {
            // Issue #1030: interface static field — print `IName.Field` when
            // the owning interface is known, otherwise unqualified.
            if node.InterfaceType != nil {
                writer.WriteIdentifier(node.InterfaceType.Name)
                writer.WritePunctuation(SyntaxKind.DotToken)
            }
            writer.WriteIdentifier(node.Field.Name)
        }
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.EqualsToken)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Value, writer)
    }

    private func WritePropertyAccessExpression(node BoundPropertyAccessExpression, writer IndentedTextWriter) {
        if node.Receiver != nil {
            BoundNodePrinter.WriteTo(node.Receiver, writer)
            writer.WritePunctuation(SyntaxKind.DotToken)
        } else {
            // Only the interface-receiver form leaves StructType null, and that
            // form always carries a receiver, so this branch has one. A printer
            // must not throw, so fall back rather than assert.
            writer.WriteIdentifier(node.StructType?.Name ?? node.Property.Name)
            writer.WritePunctuation(SyntaxKind.DotToken)
        }
        writer.WriteIdentifier(node.Property.Name)
    }

    private func WritePropertyAssignmentExpression(node BoundPropertyAssignmentExpression, writer IndentedTextWriter) {
        if node.Receiver != nil {
            BoundNodePrinter.WriteTo(node.Receiver, writer)
            writer.WritePunctuation(SyntaxKind.DotToken)
        } else {
            writer.WriteIdentifier(
                Invariant.Required(
                    node.StructType,
                    "a static property assignment has a declaring type",
                    expression: "node.StructType"
                )
                    .Name
            )
            writer.WritePunctuation(SyntaxKind.DotToken)
        }
        writer.WriteIdentifier(node.Property.Name)
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.EqualsToken)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Value, writer)
    }

    private func WriteNullConditionalAccessExpression(
        node BoundNullConditionalAccessExpression,
        writer IndentedTextWriter
    ) {
        BoundNodePrinter.WriteTo(node.Receiver, writer)
        // ADR-0073 / issue #710: when the inner access is a `?[i]` (or
        // `?[i]` over a CLR indexer), print using the `?[...]` punctuation
        // rather than `?.<index-expr>` for syntactic fidelity.
        if node.WhenNotNull is BoundIndexExpression idx &&
            idx.Target is BoundVariableExpression idxRecv &&
            object
            .ReferenceEquals(idxRecv.Variable, node.Capture) {
            writer.WritePunctuation(SyntaxKind.QuestionOpenBracketToken)
            for var i = 0; i < idx.Indices.Length; i++ {
                if i > 0 {
                    writer.WritePunctuation(SyntaxKind.CommaToken)
                    writer.WriteSpace()
                }
                BoundNodePrinter.WriteTo(idx.Indices[i], writer)
            }
            writer.WritePunctuation(SyntaxKind.CloseSquareBracketToken)
            return
        }
        if node.WhenNotNull is BoundClrIndexExpression clrIdx &&
            clrIdx.Target is BoundVariableExpression clrIdxRecv &&
            object
            .ReferenceEquals(clrIdxRecv.Variable, node.Capture) {
            writer.WritePunctuation(SyntaxKind.QuestionOpenBracketToken)
            for var i = 0; i < clrIdx.Arguments.Length; i++ {
                if i > 0 {
                    writer.WritePunctuation(SyntaxKind.CommaToken)
                    writer.WriteSpace()
                }
                BoundNodePrinter.WriteTo(clrIdx.Arguments[i], writer)
            }
            writer.WritePunctuation(SyntaxKind.CloseSquareBracketToken)
            return
        }
        writer.WritePunctuation(SyntaxKind.QuestionDotToken)
        BoundNodePrinter.WriteTo(node.WhenNotNull, writer)
    }

    private func WriteTupleLiteralExpression(node BoundTupleLiteralExpression, writer IndentedTextWriter) {
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        for var i = 0; i < node.Elements.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(node.Elements[i], writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteTupleElementAccessExpression(node BoundTupleElementAccessExpression, writer IndentedTextWriter) {
        BoundNodePrinter.WriteTo(node.Receiver, writer)
        writer.WritePunctuation(SyntaxKind.DotToken)
        writer.WriteIdentifier("Item${node.Index + 1}")
    }

    private func WriteFunctionLiteralExpression(node BoundFunctionLiteralExpression, writer IndentedTextWriter) {
        writer.WriteKeyword(SyntaxKind.FuncKeyword)
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        for var i = 0; i < node.Function.Parameters.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            writer.WriteIdentifier(node.Function.Parameters[i].Name)
        }
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Body, writer)
    }

    private func WriteMethodGroupExpression(node BoundMethodGroupExpression, writer IndentedTextWriter) {
        if node.Receiver != nil {
            BoundNodePrinter.WriteTo(node.Receiver, writer)
            writer.WritePunctuation(".")
        }
        if node.Function != nil {
            writer.WriteIdentifier(node.Function.Name)
        } else if !node.Candidates.IsDefaultOrEmpty {
            writer.WriteIdentifier(node.Candidates[0].Name)
        }
    }

    private func WriteClrMethodGroupExpression(node BoundClrMethodGroupExpression, writer IndentedTextWriter) {
        if node.Receiver != nil {
            BoundNodePrinter.WriteTo(node.Receiver, writer)
            writer.WritePunctuation(".")
        }
        writer.WriteIdentifier(node.MethodName)
    }

    private func WriteInterpolatedStringExpression(node BoundInterpolatedStringExpression, writer IndentedTextWriter) {
        writer.WriteString("$$\"")
        for part in node.Parts {
            if part.IsLiteral {
                writer.WriteString((part.Literal ?? string.Empty).Replace("\"", "\\\""))
                continue
            }
            writer.WritePunctuation(SyntaxKind.OpenBraceToken)
            let value BoundExpression? = part.Value
            if value != nil {
                BoundNodePrinter.WriteTo(value, writer)
            }
            if (part.Alignment != nil) {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteNumber(part.Alignment!!.ToString(CultureInfo.InvariantCulture))
            }
            if part.Format != nil {
                writer.WritePunctuation(SyntaxKind.ColonToken)
                writer.WriteString(part.Format!!)
            }
            writer.WritePunctuation(SyntaxKind.CloseBraceToken)
        }
        writer.WriteString("\"")
    }

    private func WriteIndirectCallExpression(node BoundIndirectCallExpression, writer IndentedTextWriter) {
        BoundNodePrinter.WriteTo(node.Target, writer)
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        for var i = 0; i < node.Arguments.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteTo(node.Arguments[i], writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteAddressOfExpression(node BoundAddressOfExpression, writer IndentedTextWriter) {
        writer.WritePunctuation(SyntaxKind.AmpersandToken)
        BoundNodePrinter.WriteTo(node.Operand, writer)
    }

    private func WriteConditionalAddressExpression(node BoundConditionalAddressExpression, writer IndentedTextWriter) {
        writer.WritePunctuation(SyntaxKind.AmpersandToken)
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        BoundNodePrinter.WriteTo(node.Condition, writer)
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.QuestionToken)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.WhenTrueOperand, writer)
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.ColonToken)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.WhenFalseOperand, writer)
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteConditionalExpression(node BoundConditionalExpression, writer IndentedTextWriter) {
        BoundNodePrinter.WriteTo(node.Condition, writer)
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.QuestionToken)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.WhenTrue, writer)
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.ColonToken)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.WhenFalse, writer)
    }

    private func WriteThrowExpression(node BoundThrowExpression, writer IndentedTextWriter) {
        writer.WriteKeyword(SyntaxKind.ThrowKeyword)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Expression, writer)
    }

    private func WriteDereferenceExpression(node BoundDereferenceExpression, writer IndentedTextWriter) {
        writer.WritePunctuation(SyntaxKind.StarToken)
        BoundNodePrinter.WriteTo(node.Operand, writer)
    }

    private func WriteIndirectAssignmentExpression(node BoundIndirectAssignmentExpression, writer IndentedTextWriter) {
        writer.WritePunctuation(SyntaxKind.StarToken)
        BoundNodePrinter.WriteTo(node.Pointer, writer)
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.EqualsToken)
        writer.WriteSpace()
        BoundNodePrinter.WriteTo(node.Value, writer)
    }

    private func WriteStateMachineAwaitOnCompleted(node BoundStateMachineAwaitOnCompleted, writer IndentedTextWriter) {
        let method = if node.UseCritical {
            "AwaitUnsafeOnCompleted"
        } else {
            "AwaitOnCompleted"
        }
        writer.WriteKeyword("builder.")
        writer.WriteIdentifier(method)
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        writer.WriteIdentifier("ref ")
        writer.WriteIdentifier(node.AwaiterLocal.Name)
        writer.WritePunctuation(SyntaxKind.CommaToken)
        writer.WriteSpace()
        writer.WriteIdentifier("ref this")
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteSpillSequenceExpression(node BoundSpillSequenceExpression, writer IndentedTextWriter) {
        writer.WriteKeyword("spill_seq")
        writer.WritePunctuation(SyntaxKind.OpenBraceToken)
        writer.WriteLine()
        writer.Indent++
        for local in node.Locals {
            writer.WriteKeyword("var ")
            writer.WriteIdentifier(local.Name)
            writer.WriteLine()
        }
        for stmt in node.SideEffects {
            BoundNodePrinter.WriteTo(stmt, writer)
            writer.WriteLine()
        }
        BoundNodePrinter.WriteTo(node.Value, writer)
        writer.WriteLine()
        writer.Indent--
        writer.WritePunctuation(SyntaxKind.CloseBraceToken)
    }

    private func WriteDefaultExpression(node BoundDefaultExpression, writer IndentedTextWriter) {
        writer.WriteKeyword("default")
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        writer.WriteIdentifier(node.Type.Name)
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteTypeParameterConstructionExpression(
        node BoundTypeParameterConstructionExpression,
        writer IndentedTextWriter
    ) {
        writer.WriteIdentifier(node.TypeParameter.Name)
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }

    private func WriteAwaitSequencePoint(node BoundAwaitSequencePoint, writer IndentedTextWriter) {
        let label = if node.Kind == BoundNodeKind.AwaitYieldPoint {
            "AwaitYieldPoint"
        } else {
            "AwaitResumePoint"
        }
        writer.WriteKeyword("/* $label(state=${node.State}) */")
        writer.WriteLine()
    }

    private func WriteIsExpression(node BoundIsExpression, writer IndentedTextWriter) {
        BoundNodePrinter.WriteTo(node.Expression, writer)
        writer.Write(" is ")
        WritePattern(node.Pattern, writer)
    }

    private func WriteAsExpression(node BoundAsExpression, writer IndentedTextWriter) {
        BoundNodePrinter.WriteTo(node.Expression, writer)
        writer.Write(" as ")
        writer.Write(node.TargetType?.Name ?? "?")
    }
}

/// Writes a bound node to the specified text writer.
/// @param writer The text writer.
@ExtensionOwner(typeof(BoundNodePrinter))
func (node BoundNode) WriteTo(writer TextWriter) {
    if writer is IndentedTextWriter iw {
        BoundNodePrinter.WriteTo(node, iw)
    } else {
        BoundNodePrinter.WriteTo(node, IndentedTextWriter(writer))
    }
}

/// Writes a bound node to the specified text writer.
/// @param writer The text writer.
@ExtensionOwner(typeof(BoundNodePrinter))
func (node BoundNode) WriteTo(writer IndentedTextWriter) {
    switch node.Kind {
        case BoundNodeKind.BlockStatement {
            BoundNodePrinter.WriteBlockStatement(cast[BoundBlockStatement](node), writer)
        }
        case BoundNodeKind.VariableDeclaration {
            BoundNodePrinter.WriteVariableDeclaration(cast[BoundVariableDeclaration](node), writer)
        }
        case BoundNodeKind.LocalFunctionDeclaration {
            BoundNodePrinter.WriteLocalFunctionDeclaration(cast[BoundLocalFunctionDeclaration](node), writer)
        }
        case BoundNodeKind.IfStatement {
            BoundNodePrinter.WriteIfStatement(cast[BoundIfStatement](node), writer)
        }
        case BoundNodeKind.ForInfiniteStatement {
            BoundNodePrinter.WriteForInfiniteStatement(cast[BoundForInfiniteStatement](node), writer)
        }
        case BoundNodeKind.ForEllipsisStatement {
            BoundNodePrinter.WriteForEllipsisStatement(cast[BoundForEllipsisStatement](node), writer)
        }
        case BoundNodeKind.ForRangeStatement {
            BoundNodePrinter.WriteForRangeStatement(cast[BoundForRangeStatement](node), writer)
        }
        case BoundNodeKind.LabelStatement {
            BoundNodePrinter.WriteLabelStatement(cast[BoundLabelStatement](node), writer)
        }
        case BoundNodeKind.GotoStatement {
            BoundNodePrinter.WriteGotoStatement(cast[BoundGotoStatement](node), writer)
        }
        case BoundNodeKind.ConditionalGotoStatement {
            BoundNodePrinter.WriteConditionalGotoStatement(cast[BoundConditionalGotoStatement](node), writer)
        }
        case BoundNodeKind.ReturnStatement {
            BoundNodePrinter.WriteReturnStatement(cast[BoundReturnStatement](node), writer)
        }
        case BoundNodeKind.ExpressionStatement {
            BoundNodePrinter.WriteExpressionStatement(cast[BoundExpressionStatement](node), writer)
        }
        case BoundNodeKind.TryStatement {
            BoundNodePrinter.WriteTryStatement(cast[BoundTryStatement](node), writer)
        }
        case BoundNodeKind.ThrowStatement {
            BoundNodePrinter.WriteThrowStatement(cast[BoundThrowStatement](node), writer)
        }
        case BoundNodeKind.RethrowStatement {
            BoundNodePrinter.WriteRethrowStatement(writer)
        }
        case BoundNodeKind.PatternSwitchStatement {
            BoundNodePrinter.WritePatternSwitchStatement(cast[BoundPatternSwitchStatement](node), writer)
        }
        case BoundNodeKind.GoStatement {
            BoundNodePrinter.WriteGoStatement(cast[BoundGoStatement](node), writer)
        }
        case BoundNodeKind.FixedStatement {
            BoundNodePrinter.WriteFixedStatement(cast[BoundFixedStatement](node), writer)
        }
        case BoundNodeKind.AwaitForRangeStatement {
            BoundNodePrinter.WriteAwaitForRangeStatement(cast[BoundAwaitForRangeStatement](node), writer)
        }
        case BoundNodeKind.YieldStatement {
            BoundNodePrinter.WriteYieldStatement(cast[BoundYieldStatement](node), writer)
        }
        case BoundNodeKind.AwaitYieldPoint, BoundNodeKind.AwaitResumePoint {
            BoundNodePrinter.WriteAwaitSequencePoint(cast[BoundAwaitSequencePoint](node), writer)
        }
        case BoundNodeKind.ErrorExpression {
            BoundNodePrinter.WriteErrorExpression(cast[BoundErrorExpression](node), writer)
        }
        case BoundNodeKind.LiteralExpression {
            BoundNodePrinter.WriteLiteralExpression(cast[BoundLiteralExpression](node), writer)
        }
        case BoundNodeKind.Utf8StringExpression {
            writer.Write("u8:" + System.Convert.ToHexString(cast[BoundUtf8StringExpression](node).Bytes.AsSpan()))
        }
        case BoundNodeKind.VariableExpression {
            BoundNodePrinter.WriteVariableExpression(cast[BoundVariableExpression](node), writer)
        }
        case BoundNodeKind.AssignmentExpression {
            BoundNodePrinter.WriteAssignmentExpression(cast[BoundAssignmentExpression](node), writer)
        }
        case BoundNodeKind.UnaryExpression {
            BoundNodePrinter.WriteUnaryExpression(cast[BoundUnaryExpression](node), writer)
        }
        case BoundNodeKind.BinaryExpression {
            BoundNodePrinter.WriteBinaryExpression(cast[BoundBinaryExpression](node), writer)
        }
        case BoundNodeKind.CallExpression {
            BoundNodePrinter.WriteCallExpression(cast[BoundCallExpression](node), writer)
        }
        case BoundNodeKind.ConversionExpression {
            BoundNodePrinter.WriteConversionExpression(cast[BoundConversionExpression](node), writer)
        }
        case BoundNodeKind.ImportedCallExpression {
            BoundNodePrinter.WriteImportedCallExpression(cast[BoundImportedCallExpression](node), writer)
        }
        case BoundNodeKind.ImportedInstanceCallExpression {
            BoundNodePrinter.WriteImportedInstanceCallExpression(
                cast[BoundImportedInstanceCallExpression](node),
                writer
            )
        }
        case BoundNodeKind.ConstrainedStaticCallExpression {
            BoundNodePrinter.WriteConstrainedStaticCallExpression(
                cast[BoundConstrainedStaticCallExpression](node),
                writer
            )
        }
        case BoundNodeKind.ArrayCreationExpression {
            BoundNodePrinter.WriteArrayCreationExpression(cast[BoundArrayCreationExpression](node), writer)
        }
        case BoundNodeKind.StackAllocExpression {
            BoundNodePrinter.WriteStackAllocExpression(cast[BoundStackAllocExpression](node), writer)
        }
        case BoundNodeKind.MapLiteralExpression {
            BoundNodePrinter.WriteMapLiteralExpression(cast[BoundMapLiteralExpression](node), writer)
        }
        case BoundNodeKind.IndexExpression {
            BoundNodePrinter.WriteIndexExpression(cast[BoundIndexExpression](node), writer)
        }
        case BoundNodeKind.IndexAssignmentExpression {
            BoundNodePrinter.WriteIndexAssignmentExpression(cast[BoundIndexAssignmentExpression](node), writer)
        }
        case BoundNodeKind.LenExpression {
            BoundNodePrinter.WriteIntrinsicCall("len", (cast[BoundLenExpression](node)).Operand, writer)
        }
        case BoundNodeKind.TypeOfExpression {
            BoundNodePrinter.WriteTypeOfExpression(cast[BoundTypeOfExpression](node), writer)
        }
        case BoundNodeKind.SizeOfExpression {
            BoundNodePrinter.WriteSizeOfExpression(cast[BoundSizeOfExpression](node), writer)
        }
        case BoundNodeKind.FunctionPointerFromMethodExpression {
            BoundNodePrinter.WriteFunctionPointerFromMethodExpression(
                cast[BoundFunctionPointerFromMethodExpression](node),
                writer
            )
        }
        case BoundNodeKind.FunctionPointerInvocationExpression {
            BoundNodePrinter.WriteFunctionPointerInvocationExpression(
                cast[BoundFunctionPointerInvocationExpression](node),
                writer
            )
        }
        case BoundNodeKind.StructLiteralExpression {
            BoundNodePrinter.WriteStructLiteralExpression(cast[BoundStructLiteralExpression](node), writer)
        }
        case BoundNodeKind.BlockExpression {
            BoundNodePrinter.WriteBlockExpression(cast[BoundBlockExpression](node), writer)
        }
        case BoundNodeKind.ConstructorCallExpression {
            BoundNodePrinter.WriteConstructorCallExpression(cast[BoundConstructorCallExpression](node), writer)
        }
        case BoundNodeKind.ConstructorChainingExpression {
            BoundNodePrinter.WriteConstructorChainingExpression(cast[BoundConstructorChainingExpression](node), writer)
        }
        case BoundNodeKind.UserInstanceCallExpression {
            BoundNodePrinter.WriteUserInstanceCallExpression(cast[BoundUserInstanceCallExpression](node), writer)
        }
        case BoundNodeKind.BaseClassCallExpression {
            BoundNodePrinter.WriteBaseClassCallExpression(cast[BoundBaseClassCallExpression](node), writer)
        }
        case BoundNodeKind.BaseInterfaceCallExpression {
            BoundNodePrinter.WriteBaseInterfaceCallExpression(cast[BoundBaseInterfaceCallExpression](node), writer)
        }
        case BoundNodeKind.FieldAccessExpression {
            BoundNodePrinter.WriteFieldAccessExpression(cast[BoundFieldAccessExpression](node), writer)
        }
        case BoundNodeKind.FieldAssignmentExpression {
            BoundNodePrinter.WriteFieldAssignmentExpression(cast[BoundFieldAssignmentExpression](node), writer)
        }
        case BoundNodeKind.PropertyAccessExpression {
            BoundNodePrinter.WritePropertyAccessExpression(cast[BoundPropertyAccessExpression](node), writer)
        }
        case BoundNodeKind.PropertyAssignmentExpression {
            BoundNodePrinter.WritePropertyAssignmentExpression(cast[BoundPropertyAssignmentExpression](node), writer)
        }
        case BoundNodeKind.NullConditionalAccessExpression {
            BoundNodePrinter.WriteNullConditionalAccessExpression(
                cast[BoundNullConditionalAccessExpression](node),
                writer
            )
        }
        case BoundNodeKind.TupleLiteralExpression {
            BoundNodePrinter.WriteTupleLiteralExpression(cast[BoundTupleLiteralExpression](node), writer)
        }
        case BoundNodeKind.TupleElementAccessExpression {
            BoundNodePrinter.WriteTupleElementAccessExpression(cast[BoundTupleElementAccessExpression](node), writer)
        }
        case BoundNodeKind.FunctionLiteralExpression {
            BoundNodePrinter.WriteFunctionLiteralExpression(cast[BoundFunctionLiteralExpression](node), writer)
        }
        case BoundNodeKind.MethodGroupExpression {
            BoundNodePrinter.WriteMethodGroupExpression(cast[BoundMethodGroupExpression](node), writer)
        }
        case BoundNodeKind.ClrMethodGroupExpression {
            BoundNodePrinter.WriteClrMethodGroupExpression(cast[BoundClrMethodGroupExpression](node), writer)
        }
        case BoundNodeKind.IndirectCallExpression {
            BoundNodePrinter.WriteIndirectCallExpression(cast[BoundIndirectCallExpression](node), writer)
        }
        case BoundNodeKind.InterpolatedStringExpression {
            BoundNodePrinter.WriteInterpolatedStringExpression(cast[BoundInterpolatedStringExpression](node), writer)
        }
        case BoundNodeKind.ClrConstructorCallExpression {
            BoundNodePrinter.WriteClrConstructorCallExpression(cast[BoundClrConstructorCallExpression](node), writer)
        }
        case BoundNodeKind.ClrStaticCallExpression {
            BoundNodePrinter.WriteClrStaticCallExpression(cast[BoundClrStaticCallExpression](node), writer)
        }
        case BoundNodeKind.ClrPropertyAccessExpression {
            BoundNodePrinter.WriteClrPropertyAccessExpression(cast[BoundClrPropertyAccessExpression](node), writer)
        }
        case BoundNodeKind.ClrPropertyAssignmentExpression {
            BoundNodePrinter.WriteClrPropertyAssignmentExpression(
                cast[BoundClrPropertyAssignmentExpression](node),
                writer
            )
        }
        case BoundNodeKind.ClrEventSubscriptionExpression {
            BoundNodePrinter.WriteClrEventSubscriptionExpression(
                cast[BoundClrEventSubscriptionExpression](node),
                writer
            )
        }
        case BoundNodeKind.EventSubscriptionExpression {
            BoundNodePrinter.WriteEventSubscriptionExpression(cast[BoundEventSubscriptionExpression](node), writer)
        }
        case BoundNodeKind.ClrBinaryOperatorExpression {
            BoundNodePrinter.WriteClrBinaryOperatorExpression(cast[BoundClrBinaryOperatorExpression](node), writer)
        }
        case BoundNodeKind.ClrUnaryOperatorExpression {
            BoundNodePrinter.WriteClrUnaryOperatorExpression(cast[BoundClrUnaryOperatorExpression](node), writer)
        }
        case BoundNodeKind.ClrConversionCallExpression {
            BoundNodePrinter.WriteClrConversionCallExpression(cast[BoundClrConversionCallExpression](node), writer)
        }
        case BoundNodeKind.ClrIndexExpression {
            BoundNodePrinter.WriteClrIndexExpression(cast[BoundClrIndexExpression](node), writer)
        }
        case BoundNodeKind.ClrIndexAssignmentExpression {
            BoundNodePrinter.WriteClrIndexAssignmentExpression(cast[BoundClrIndexAssignmentExpression](node), writer)
        }
        case BoundNodeKind.AwaitExpression {
            BoundNodePrinter.WriteAwaitExpression(cast[BoundAwaitExpression](node), writer)
        }
        case BoundNodeKind.SwitchExpression {
            BoundNodePrinter.WriteSwitchExpression(cast[BoundSwitchExpression](node), writer)
        }
        case BoundNodeKind.SwitchExpressionArm {
            BoundNodePrinter.WriteSwitchExpressionArm(cast[BoundSwitchExpressionArm](node), writer)
        }
        case BoundNodeKind.AddressOfExpression {
            BoundNodePrinter.WriteAddressOfExpression(cast[BoundAddressOfExpression](node), writer)
        }
        case BoundNodeKind.ManagedReferenceExpression {
            let managed = cast[BoundManagedReferenceExpression](node)
            if managed.IsReadOnly {
                writer.WriteIdentifier("readonly")
                writer.WriteSpace()
            }
            BoundNodePrinter.WriteIntrinsicCall("managed", managed.Location, writer)
        }
        case BoundNodeKind.ManagedFieldKeyExpression {
            BoundNodePrinter.WriteManagedFieldKeyExpression(cast[BoundManagedFieldKeyExpression](node), writer)
        }
        case BoundNodeKind.ConditionalAddressExpression {
            BoundNodePrinter.WriteConditionalAddressExpression(cast[BoundConditionalAddressExpression](node), writer)
        }
        case BoundNodeKind.ConditionalExpression {
            BoundNodePrinter.WriteConditionalExpression(cast[BoundConditionalExpression](node), writer)
        }
        case BoundNodeKind.ThrowExpression {
            BoundNodePrinter.WriteThrowExpression(cast[BoundThrowExpression](node), writer)
        }
        case BoundNodeKind.DereferenceExpression {
            BoundNodePrinter.WriteDereferenceExpression(cast[BoundDereferenceExpression](node), writer)
        }
        case BoundNodeKind.IndirectAssignmentExpression {
            BoundNodePrinter.WriteIndirectAssignmentExpression(cast[BoundIndirectAssignmentExpression](node), writer)
        }
        case BoundNodeKind.StateMachineAwaitOnCompleted {
            BoundNodePrinter.WriteStateMachineAwaitOnCompleted(cast[BoundStateMachineAwaitOnCompleted](node), writer)
        }
        case BoundNodeKind.SpillSequenceExpression {
            BoundNodePrinter.WriteSpillSequenceExpression(cast[BoundSpillSequenceExpression](node), writer)
        }
        case BoundNodeKind.DefaultExpression {
            BoundNodePrinter.WriteDefaultExpression(cast[BoundDefaultExpression](node), writer)
        }
        case BoundNodeKind.TypeParameterConstructionExpression {
            BoundNodePrinter.WriteTypeParameterConstructionExpression(
                cast[BoundTypeParameterConstructionExpression](node),
                writer
            )
        }
        case BoundNodeKind.IsExpression {
            BoundNodePrinter.WriteIsExpression(cast[BoundIsExpression](node), writer)
        }
        case BoundNodeKind.AsExpression {
            BoundNodePrinter.WriteAsExpression(cast[BoundAsExpression](node), writer)
        }
        default {
            throw Exception("Unexpected node ${node.Kind}")
        }
    }
}

@ExtensionOwner(typeof(BoundNodePrinter))
private func (writer IndentedTextWriter) WriteNestedStatement(node BoundStatement) {
    let needsIndentation = !(node is BoundBlockStatement)
    if needsIndentation {
        writer.Indent++
    }
    BoundNodePrinter.WriteTo(node, writer)
    if needsIndentation {
        writer.Indent--
    }
}

@ExtensionOwner(typeof(BoundNodePrinter))
private func (writer IndentedTextWriter) WriteNestedExpression(parentPrecedence int32, expression BoundExpression) {
    if expression is BoundUnaryExpression unary {
        writer.WriteNestedExpression(parentPrecedence, unary.Op.SyntaxKind.GetUnaryOperatorPrecedence(), unary)
    } else if expression is BoundBinaryExpression binary {
        writer.WriteNestedExpression(parentPrecedence, binary.Op.SyntaxKind.GetBinaryOperatorPrecedence(), binary)
    } else {
        BoundNodePrinter.WriteTo(expression, writer)
    }
}

@ExtensionOwner(typeof(BoundNodePrinter))
private func (writer IndentedTextWriter) WriteNestedExpression(
    parentPrecedence int32,
    currentPrecedence int32,
    expression BoundExpression
) {
    let needsParenthesis = parentPrecedence >= currentPrecedence
    if needsParenthesis {
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
    }
    BoundNodePrinter.WriteTo(expression, writer)
    if needsParenthesis {
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
    }
}
