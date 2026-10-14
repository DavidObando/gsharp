// <copyright file="InlayHintHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer.Protocol
import System
import System.Collections.Generic
import System.Linq
import System.Threading

/// Pure-function inlay hint computer usable by both the handler and tests.
shared class InlayHintComputer {
    func ComputeHints(
        content DocumentContent,
        includeParameterNames bool = true,
        includeTypes bool = true,
        ct CancellationToken = default(CancellationToken)
    ) IReadOnlyList[InlayHint] {
        let tree = content.SyntaxTree
        let text = tree.Text
        let hints = List[InlayHint]()
        var compilation Compilation
        try {
            compilation = content.Project?.GetCompilation() ?? Compilation(tree)
        } catch {
            return hints
        }
        if includeParameterNames {
            for call in FindNodes[CallExpressionSyntax](tree.Root) {
                // Each call resolves a symbol (a potentially expensive cold-cache lookup);
                // check between calls so a superseded request aborts mid-walk (issue #1662).
                ct.ThrowIfCancellationRequested()
                AddParameterHints(hints, call, compilation, text, ct)
            }
        }
        if includeTypes {
            for declaration in FindNodes[VariableDeclarationSyntax](tree.Root) {
                ct.ThrowIfCancellationRequested()
                AddTypeHint(hints, declaration, compilation, text, ct)
            }
        }
        return hints
    }

    private func AddTypeHint(
        hints List[InlayHint],
        declaration VariableDeclarationSyntax,
        compilation Compilation,
        text SourceText,
        ct CancellationToken
    ) {
        if declaration.TypeClause != nil || SemanticLookup.ResolveSymbol(
            compilation,
            declaration.Identifier,
            ct
        ) is not VariableSymbol variable ||
            variable.Type == nil ||
            object.ReferenceEquals(variable.Type, TypeSymbol.Error) {
            return
        }
        let offset = declaration.Identifier.Span.End
        let line = text.GetLineIndex(offset)
        hints.Add(
            InlayHint{
                Position: Position(line, offset - text.Lines[line].Start),
                Label: StringOrInlayHintLabelParts(": ${SymbolDisplay.ToTypeDisplayString(variable.Type)}"),
                Kind: InlayHintKind.Type,
                PaddingLeft: true
            }
        )
    }

    private func AddParameterHints(
        hints List[InlayHint],
        call CallExpressionSyntax,
        compilation Compilation,
        text SourceText,
        ct CancellationToken = default(CancellationToken)
    ) {
        let symbol = SemanticLookup.ResolveSymbol(compilation, call.Identifier, ct)
        if symbol is not FunctionSymbol func_ {
            return
        }
        let args = call.Arguments.ToArray()
        let parameters = func_.Parameters
        // Skip receiver parameter for method calls
        let paramOffset = if func_.ExplicitReceiverParameter != nil {
            1
        } else {
            0
        }
        for var i = 0; i < args.Length && i + paramOffset < parameters.Length; i++ {
            let param = parameters[i + paramOffset]
            let arg = args[i]
            // Don't show hint if the argument is already a simple identifier matching the parameter name
            if arg is NameExpressionSyntax nameExpr && string.Equals(
                nameExpr.IdentifierToken.Text,
                param.Name,
                StringComparison.Ordinal
            ) {
                continue
            }
            let argStart = arg.Span.Start
            let line = text.GetLineIndex(argStart)
            let character = argStart - text.Lines[line].Start
            hints.Add(
                InlayHint{
                    Position: Position(line, character),
                    Label: StringOrInlayHintLabelParts("${param.Name}:"),
                    Kind: InlayHintKind.Parameter,
                    PaddingRight: true
                }
            )
        }
    }

    private func FindNodes[T SyntaxNode](root SyntaxNode) sequence[T] {
        if root is T matched {
            yield matched
        }
        for child in root.GetChildren() {
            for descendant in FindNodes[T](child) {
                yield descendant
            }
        }
    }
}
