// <copyright file="UseNilCodeFixProvider.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes.BuiltIn

import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// GS0273: `null` → `nil` (ADR-0227 D8, ADR-0081).
internal class UseNilCodeFixProvider : GSharpCodeFixProvider {
    const EquivalenceKey string = "GS0273.UseNil"

    override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("GS0273")

    override prop Id string -> "GSharp.CodeFixes.UseNil"

    override func RegisterCodeFixes(context CodeFixContext) {
        let token SyntaxToken? = FixSyntax.TokenAt(context.Tree, context.Diagnostic)
        if token == nil || token.Kind != SyntaxKind.IdentifierToken || token.Text != "null" {
            return
        }
        context.RegisterFix(
            "Use 'nil'",
            EquivalenceKey,
            Applicability.MachineApplicable,
            (editor SyntaxEditor) -> editor.ReplaceToken(token, "nil")
        )
    }
}
