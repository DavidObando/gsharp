// <copyright file="LetToVarCodeFixProvider.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes.BuiltIn

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// GS0127: a `let` variable that is assigned again becomes `var` (ADR-0227 D8, ADR-0008).
/// @remarks The diagnostic is on the assignment operator. The edit is on the declaration, which
/// must be in the same tree. A local is (cref:Applicability.MachineApplicable). A field is
/// (cref:Applicability.MaybeIncorrect), because the change is visible outside the function.
internal class LetToVarCodeFixProvider : GSharpCodeFixProvider {
    const EquivalenceKey string = "GS0127.LetToVar"

    override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("GS0127")

    override prop Id string -> "GSharp.CodeFixes.LetToVar"

    override func RegisterCodeFixes(context CodeFixContext) {
        let tree = context.Tree
        let token SyntaxToken? = tree.Root.FindToken(context.Diagnostic.Location.Span.Start)
        if token == nil {
            return
        }
        let assignment SyntaxNode? = token.Parent
        if assignment == nil {
            return
        }
        let symbol Symbol? = TargetSymbol(context.SemanticModel, assignment, context)
        if symbol == nil {
            return
        }
        var keyword SyntaxToken? = nil
        var applicability = Applicability.MachineApplicable
        for declaration in symbol.DeclaringSyntaxNodes {
            if !object.ReferenceEquals(declaration.SyntaxTree, tree) {
                continue
            }
            let owner = if declaration is SyntaxToken {
                declaration.Parent
            } else {
                declaration
            }
            switch owner {
                case local is VariableDeclarationSyntax when symbol is LocalVariableSymbol {
                    keyword = local.Keyword
                }
                case field is FieldDeclarationSyntax when symbol is FieldSymbol {
                    keyword = field.VarOrLetKeyword
                    applicability = Applicability.MaybeIncorrect
                }
            }
        }
        if keyword == nil || keyword.Text != "let" || !FixSyntax.IsReal(keyword) {
            return
        }
        let letKeyword = keyword
        context.RegisterFix(
            "Change 'let' to 'var'",
            EquivalenceKey,
            applicability,
            (editor SyntaxEditor) -> editor.ReplaceToken(letKeyword, "var")
        )
    }

    // The assigned variable: the symbol of the assignment, or of its first child (a compound
    // assignment such as `x += 1`).
    private func TargetSymbol(model SemanticModel, assignment SyntaxNode, context CodeFixContext) Symbol? {
        let direct Symbol? = model.GetSymbolInfo(assignment, context.CancellationToken).Symbol
        if direct is VariableSymbol || direct is FieldSymbol {
            return direct
        }
        for child in assignment.GetChildren() {
            let first Symbol? = model.GetSymbolInfo(child, context.CancellationToken).Symbol
            if first is VariableSymbol || first is FieldSymbol {
                return first
            }
            return nil
        }
        return nil
    }
}
