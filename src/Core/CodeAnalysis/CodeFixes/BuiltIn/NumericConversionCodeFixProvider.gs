// <copyright file="NumericConversionCodeFixProvider.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes.BuiltIn

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable

/// GS0156 between two numeric types: `expr` → `checked(cast[T](expr))` (ADR-0227 D8 phase 2, ADR-0115 B.17).
/// @remarks The diagnostic says that an explicit conversion exists, and its message arguments
/// name the source and the target type. The conversion is checked, so it can throw at run time:
/// the fix is (cref:Applicability.MaybeIncorrect). Only a simple operand is converted.
internal class NumericConversionCodeFixProvider : GSharpCodeFixProvider {
    private let NumericTypes ImmutableHashSet[string] = ImmutableHashSet.Create(
        StringComparer.Ordinal,
        "int8",
        "int16",
        "int32",
        "int64",
        "uint8",
        "uint16",
        "uint32",
        "uint64",
        "float32",
        "float64",
        "decimal",
        "nint",
        "nuint",
        "char"
    )

    override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("GS0156")

    override prop Id string -> "GSharp.CodeFixes.NumericConversion"

    override func RegisterCodeFixes(context CodeFixContext) {
        let arguments = context.Diagnostic.MessageArguments
        if arguments.Length < 2 || !NumericTypes.Contains(arguments[0]) || !NumericTypes.Contains(arguments[1]) {
            return
        }
        let target = arguments[1]
        let node SyntaxNode? = FixSyntax.NodeWithSpan(context.Tree, context.Diagnostic.Location.Span)
        if node == nil || !IsSimpleOperand(node) {
            return
        }
        // The diagnostic can cover a tuple while its arguments name one element's conversion: the
        // operand itself must have the source type.
        let type = context.SemanticModel.GetTypeInfo(node, context.CancellationToken).Type
        if type == nil || type.ToString() != arguments[0] {
            return
        }
        // In a compound assignment (`x /= y`) the conversion is of the operation's result, so
        // converting the right operand changes the value.
        let previous SyntaxToken? = FixSyntax.PreviousRealToken(context.Tree, node.GetFirstToken())
        if previous != nil && SyntaxFacts.TryGetCompoundAssignmentBaseOperator(previous.Kind, out _) {
            return
        }
        // A constant operand is checked at compile time: an out-of-range constant would report an
        // error under `checked`, so a constant gets no fix.
        if IsConstant(context, node) {
            return
        }
        let expression = node
        context.RegisterFix(
            "Convert to '${target}'",
            "GS0156.NumericConversion",
            Applicability.MaybeIncorrect,
            // `T(e)` is not overflow-checked outside a `checked` context; `checked` makes an
            // out-of-range value throw. The operand has no arithmetic, so its own context is unchanged.
            (editor SyntaxEditor) -> editor.ReplaceNode(
                expression,
                // `cast[T]` is a conversion even when a function named like the type is in scope.
                "checked(cast[${target}](${editor.OriginalText(expression)}))"
            )
        )
    }

    private func IsConstant(context CodeFixContext, node SyntaxNode) bool {
        let bound = context.SemanticModel.GetBoundNode(node, context.CancellationToken)
        if bound is BoundExpression boundExpression && boundExpression.ConstantValue.HasValue {
            return true
        }
        let named SyntaxNode = if node is ParenthesizedExpressionSyntax p {
            p.Expression
        } else {
            node
        }
        let symbol Symbol? = context.SemanticModel.GetSymbolInfo(named, context.CancellationToken).Symbol
        return switch symbol {
            case g is GlobalVariableSymbol: g.IsConst
            case l is LocalVariableSymbol: l.IsConst
            case f is FieldSymbol: f.IsConst
            default: false
        }
    }

    // A name, a member access of names, or one of these in parentheses: no arithmetic,
    // no call and no assignment, so `checked` and the conversion change nothing inside it.
    private func IsSimpleOperand(node SyntaxNode) bool -> switch node {
        case n is NameExpressionSyntax: true
        case a is AccessorExpressionSyntax: IsSimpleOperand(a.LeftPart) && IsSimpleOperand(a.RightPart)
        case p is ParenthesizedExpressionSyntax: IsSimpleOperand(p.Expression)
        default: false
    }
}
