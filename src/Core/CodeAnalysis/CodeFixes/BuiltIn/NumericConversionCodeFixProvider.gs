// <copyright file="NumericConversionCodeFixProvider.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes.BuiltIn

import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable

/// GS0156 between two numeric types: `expr` → `checked(T(expr))` (ADR-0227 D8 phase 2, ADR-0115 B.17).
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
        if previous != nil && CompoundAssignmentOperators.Contains(previous.Text) {
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
                "checked(${target}(${editor.OriginalText(expression)}))"
            )
        )
    }

    private let CompoundAssignmentOperators ImmutableHashSet[string] = ImmutableHashSet.Create(
        StringComparer.Ordinal,
        "+=",
        "-=",
        "*=",
        "/=",
        "%=",
        "&=",
        "|=",
        "^=",
        "<<=",
        ">>="
    )

    // A name, a member access of names, a literal, or one of these in parentheses: no arithmetic,
    // no call and no assignment, so `checked` and the conversion change nothing inside it.
    private func IsSimpleOperand(node SyntaxNode) bool -> switch node {
        case n is NameExpressionSyntax: true
        case l is LiteralExpressionSyntax: true
        case a is AccessorExpressionSyntax: IsSimpleOperand(a.LeftPart) && IsSimpleOperand(a.RightPart)
        case p is ParenthesizedExpressionSyntax: IsSimpleOperand(p.Expression)
        default: false
    }
}
