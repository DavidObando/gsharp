// <copyright file="NumericConversionCodeFixProvider.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes.BuiltIn

import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable

/// GS0156 between two numeric types: `expr` → `T(expr)` (ADR-0227 D8 phase 2, ADR-0115 B.17).
/// @remarks The diagnostic says that an explicit conversion exists, and its message arguments
/// name the source and the target type. The conversion is checked, so it can throw at run time:
/// the fix is (cref:Applicability.MaybeIncorrect).
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
        "decimal"
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
        if node == nil || !(node is ExpressionSyntax) {
            return
        }
        let expression = node
        context.RegisterFix(
            "Convert to '${target}'",
            "GS0156.NumericConversion",
            Applicability.MaybeIncorrect,
            (editor SyntaxEditor) -> editor.ReplaceNode(expression, "${target}(${editor.OriginalText(expression)})")
        )
    }
}
