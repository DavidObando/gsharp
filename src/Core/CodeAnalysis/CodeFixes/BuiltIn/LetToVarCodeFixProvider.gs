// <copyright file="LetToVarCodeFixProvider.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes.BuiltIn

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable

/// GS0127: a `let` variable that is assigned again becomes `var` (ADR-0227 D8, ADR-0008).
/// @remarks The diagnostic is on the assignment operator. The edit is on the declaration, which
/// can be in another tree of the compilation. A local is (cref:Applicability.MachineApplicable). A field is
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
        // A member assignment (`c.N = 1`, `a[i] = 1`) has a receiver that can have the same name as
        // the read-only member. The provider cannot tell them apart, so it declines.
        let target = tree.Text.ToString(TextSpan.FromBounds(assignment.Span.Start, token.Span.Start))
        if target.Contains('.') || target.Contains('[') {
            return
        }
        let symbol Symbol? = TargetSymbol(context.SemanticModel, assignment, context)
        // GS0127 names the read-only variable. A symbol with another name is the receiver of a
        // member assignment (`c.N = 1`), not the variable to change.
        let arguments = context.Diagnostic.MessageArguments
        if symbol == nil || arguments.IsEmpty || symbol.Name != arguments[0] {
            return
        }
        var keyword SyntaxToken? = nil
        var applicability = Applicability.MachineApplicable
        for declaration in symbol.DeclaringSyntaxNodes {
            if !context.Compilation.SyntaxTrees.Contains(declaration.SyntaxTree) {
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
                case field is FieldDeclarationSyntax when symbol is FieldSymbol &&
                    (
                    cast[FieldSymbol](symbol).IsStatic ||
                        !(field.FirstAncestorOrSelf[StructDeclarationSyntax]()?.IsInline ?? false)
                ) {
                    // The instance fields of an inline struct stay read-only even when spelled `var`;
                    // its shared fields take their keyword.
                    keyword = field.VarOrLetKeyword
                    applicability = Applicability.MaybeIncorrect
                }
            }
        }
        if keyword == nil || keyword.Text != "let" || !FixSyntax.IsReal(keyword) {
            return
        }
        let letKeyword = keyword
        // The declaration can be in another tree of the compilation (a field of a partial type).
        context.RegisterMultiDocumentFix(
            "Change 'let' to 'var'",
            EquivalenceKey,
            applicability,
            (editor MultiDocumentEditor) -> editor.EditorFor(letKeyword.SyntaxTree).ReplaceToken(letKeyword, "var")
        )
    }

    // A local or a field. A parameter, `this` included, is not a `let` declaration.
    private func IsAssignable(symbol Symbol?) bool -> !(symbol is ParameterSymbol) &&
        (symbol is LocalVariableSymbol || symbol is FieldSymbol)

    // The assigned variable: the symbol of the assignment, or of its first child (a compound
    // assignment such as `x += 1`). For a field with an implicit receiver, GetSymbolInfo answers
    // the `this` parameter (#6126), so the name is looked up at the assignment instead.
    private func TargetSymbol(model SemanticModel, assignment SyntaxNode, context CodeFixContext) Symbol? {
        let direct Symbol? = model.GetSymbolInfo(assignment, context.CancellationToken).Symbol
        if IsAssignable(direct) {
            return direct
        }
        for child in assignment.GetChildren() {
            let first Symbol? = model.GetSymbolInfo(child, context.CancellationToken).Symbol
            if IsAssignable(first) {
                return first
            }
            let name = if child is SyntaxToken token && token.Kind == SyntaxKind.IdentifierToken {
                token.ValueText
            } else if child is NameExpressionSyntax nameExpression {
                nameExpression.IdentifierToken.ValueText
            } else {
                default(string?)
            }
            if name == nil {
                return nil
            }
            let found = model.LookupSymbols(assignment.Span.Start, name, context.CancellationToken)
            if found.Length == 1 && found[0] is FieldSymbol {
                return found[0]
            }
            return nil
        }
        return nil
    }
}
