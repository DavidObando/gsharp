// <copyright file="CSharpToGSharpTranslator.ConditionalSymbols.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import GExpressionLiteral = Cs2Gs.CodeModel.Ast.LiteralExpression
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp.Syntax
import SymbolNames = GSharp.Core.CodeAnalysis.ConditionalSymbols
import System
import System.Collections.Generic
import System.Linq

partial class CSharpToGSharpTranslator {
    /// Gets or sets whether the destination compiler supports ADR-0230 symbol annotations.
    prop SupportsScopedConditionalSymbols bool

    shared {
        const ConditionalSymbolsDiagnosticId string = "CS2GS-CONDITIONAL-SYMBOLS"

        private func GetConditionalMethodSymbols(method IMethodSymbol) IEnumerable[string] {
            for var current IMethodSymbol? = method; current != nil; current = current?.OverriddenMethod {
                for attribute in current.GetAttributes() {
                    if attribute.AttributeClass?.ToDisplayString() == "System.Diagnostics.ConditionalAttribute" &&
                        attribute.ConstructorArguments.Length == 1 &&
                        attribute.ConstructorArguments[0].Value is string name {
                        yield name
                    }
                }
            }
        }
    }

    private func PreserveConditionalSymbols(
        trees IEnumerable[SyntaxTree],
        context TranslationContext,
        attributes IReadOnlyList[AttributeUse]
    ) IReadOnlyList[AttributeUse] {
        let states = Dictionary[string, bool](StringComparer.Ordinal)
        var conflicting = false
        var firstCall InvocationExpressionSyntax? = nil
        for tree in trees.OrderBy((item SyntaxTree) -> item.FilePath, StringComparer.Ordinal) {
            using let model = context.UseSemanticModelFor(tree, context.Compilation)
            for invocation in tree.GetRoot().DescendantNodes().OfType[InvocationExpressionSyntax]() {
                if context.GetSymbolInfo(invocation).Symbol is not IMethodSymbol method || !method.IsConditional {
                    continue
                }
                firstCall ??= invocation
                for name in GetConditionalMethodSymbols(method) {
                    if !SymbolNames.IsValidName(name) {
                        context.ReportUnsupported(
                            invocation,
                            "The conditional symbol '$name' cannot be represented by a G# symbol annotation.",
                            ConditionalSymbolsDiagnosticId
                        )
                        continue
                    }
                    let defined = context.IsPreprocessorSymbolDefined(tree, invocation.SpanStart, name)
                    if states.TryGetValue(name, out var previous) && previous != defined {
                        conflicting = true
                    } else {
                        states[name] = defined
                    }
                }
            }
        }
        if states.Count == 0 {
            return attributes
        }
        if !this.SupportsScopedConditionalSymbols {
            context.ReportUnsupported(
                firstCall!!,
                "The destination SDK does not advertise scoped conditional symbols. " +
                    "Use a supporting SDK before translating ConditionalAttribute calls.",
                ConditionalSymbolsDiagnosticId
            )
            return attributes
        }
        if conflicting {
            context.ReportUnsupported(
                firstCall!!,
                "Merged source files have different conditional-symbol environments. " +
                    "Preserve their partial declarations in separate output files.",
                ConditionalSymbolsDiagnosticId
            )
            return attributes
        }
        let result = attributes.ToList()
        for defined in[]bool{true, false} {
            let arguments = states
                .Where((entry KeyValuePair[string, bool]) -> entry.Value == defined)
                .OrderBy((entry KeyValuePair[string, bool]) -> entry.Key, StringComparer.Ordinal)
                .Select((entry KeyValuePair[string, bool]) -> AttributeArgument(GExpressionLiteral.String(entry.Key)))
                .ToArray()
            if arguments.Length > 0 {
                result.Add(
                    AttributeUse(
                        if defined {
                            "DefineSymbol"
                        } else {
                            "UndefineSymbol"
                        },
                        arguments,
                        target: "file"
                    )
                )
            }
        }
        return result
    }
}
