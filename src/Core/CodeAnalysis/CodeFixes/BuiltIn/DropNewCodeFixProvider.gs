// <copyright file="DropNewCodeFixProvider.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes.BuiltIn

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable
import System.Linq

/// GS0125 on `new`: `new T(...)` → `T(...)` for a reference type (ADR-0227 D8, ADR-0115 B.16).
/// @remarks The parser reads `new T(x)` as the name `new` and then the call `T(x)`. The fix removes
/// `new` when the call on the same line constructs a reference type. A value type needs the
/// composite literal `T{...}`, and a call to a function is not a construction, so neither gets a fix.
internal class DropNewCodeFixProvider : GSharpCodeFixProvider {
    const EquivalenceKey string = "GS0125.DropNew"

    override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("GS0125")

    override prop Id string -> "GSharp.CodeFixes.DropNew"

    override func RegisterCodeFixes(context CodeFixContext) {
        let tree = context.Tree
        let token SyntaxToken? = FixSyntax.TokenAt(tree, context.Diagnostic)
        if token == nil || token.Kind != SyntaxKind.IdentifierToken || token.Text != "new" {
            return
        }
        let next SyntaxToken? = FixSyntax.NextRealToken(tree, token)
        if next == nil || next.Kind != SyntaxKind.IdentifierToken || !FixSyntax.SameLine(
            tree.Text,
            token.Span.Start,
            next.Span.Start
        ) {
            return
        }
        let call CallExpressionSyntax? = tree
            .Root
            .DescendantNodes()
            .OfType[CallExpressionSyntax]()
            .FirstOrDefault((c CallExpressionSyntax) -> object.ReferenceEquals(c.Identifier, next))
        if call == nil {
            return
        }
        let model = context.SemanticModel
        // A call to a function has a symbol. A construction has none and has the constructed type.
        if model.GetSymbolInfo(call, context.CancellationToken).Symbol != nil {
            return
        }
        let type = model.GetTypeInfo(call, context.CancellationToken).Type
        if type == nil || type.IsValueType {
            return
        }
        // A call of a function value (`new make()` with a parameter `make () -> C`) has no symbol
        // either. The callee's name must name only types or type aliases in scope.
        let named = model.LookupSymbols(call.Span.Start, next.ValueText, context.CancellationToken)
        if named.Any((s Symbol) -> !(s is TypeSymbol || s is TypeAliasSymbol)) {
            return
        }
        context.RegisterFix(
            "Remove 'new'",
            EquivalenceKey,
            Applicability.MachineApplicable,
            (editor SyntaxEditor) -> editor.RemoveToken(token)
        )
    }
}
