// <copyright file="CSharpToGSharpTranslator.Suspension.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System.Linq

partial class CSharpToGSharpTranslator {
    /// ADR-0174 D4: recognizes the C# shape a G# `suspend func` compiles to,
    /// so it translates back to one instead of an `async func` with an
    /// explicit `ValueTask[T]` envelope.
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        /// A method is a suspending candidate when it is `async`, returns
        /// `ValueTask` or `ValueTask<T>`, and either carries
        /// `[Gsharp.Concurrency.Suspending]` (the attribute G# stamps on
        /// every suspending function) or names a Gsharp.Concurrency runtime
        /// type or member anywhere in its signature or body (`Chan<T>`,
        /// `ChannelOps`, `Context`, `ScopeFrame`, …). A plain
        /// `async ValueTask<T>` method that never touches the runtime
        /// is ordinary asynchronous code and keeps B.23's explicit envelope.
        /// @param symbol The method symbol.
        /// @param node The method declaration.
        /// @returns `true` when the method renders as `suspend func`.
        private func IsSuspendingCandidate(symbol IMethodSymbol?, node MethodDeclarationSyntax) bool {
            if !symbol!!.IsAsync || !IsValueTaskEnvelope(symbol!!.ReturnType) {
                return false
            }
            if symbol!!.GetAttributes().Any(
                (attribute AttributeData) -> attribute.AttributeClass is {Name: "SuspendingAttribute"} attributeClass &&
                    IsConcurrencyRuntimeNamespace(attributeClass.ContainingNamespace)
            ) {
                return true
            }
            // Issue #3907: the runtime-usage probe below is a heuristic for
            // C# authored AGAINST the concurrency runtime. Inside the runtime
            // assembly itself it carries no signal at all — every method there
            // names a Gsharp.Concurrency type — so it fired on
            // Gsharp.Runtime.Channels' own private helpers
            // (`Chan<T>.ReceiveBatchSlowAsync`, `ChannelOps.ForeignReceiveSlowAsync`,
            // `ScopeFrame.JoinAsync`, …). Those are ordinary async methods whose
            // ValueTask is RETURNED un-awaited by their fast-path callers, and a
            // `suspend func` cannot express that: ADR-0174 D4 makes every call to
            // one an implicit await, so `return SlowAsync(…)` from a
            // `ValueTask[int32]`-returning caller stopped type-checking. The
            // attribute stays authoritative there (checked above) — #3882 marks
            // exactly the four ChannelBatchExtensions methods that really are the
            // suspend ABI — which is why this narrowing is a tightening, not a
            // removal.
            if IsConcurrencyRuntimeNamespace(symbol!!.ContainingType?.ContainingNamespace) {
                return false
            }
            let model = if this.context.SemanticModel.SyntaxTree == node.SyntaxTree {
                this.context.SemanticModel
            } else {
                this.context.Compilation.GetSemanticModel(node.SyntaxTree)
            }
            for descendant in node.DescendantNodes() {
                if !((descendant is IdentifierNameSyntax || descendant is GenericNameSyntax)) {
                    continue
                }
                let resolved ISymbol? = model.GetSymbolInfo(descendant).Symbol
                if IsConcurrencyRuntimeNamespace(NamespaceOf(resolved)) {
                    return true
                }
            }
            return false
        }

        // FunctionSymbol.AddHiddenContextParameter adopts a declared Context
        // and leaves variadic signatures unchanged (ADR-0174 D7).
        private func CanPreserveSuspendingExtensionSignature(
            symbol IMethodSymbol?,
            node MethodDeclarationSyntax
        ) bool -> !this.IsSuspendingCandidate(symbol, node) || symbol!!.Parameters.Any(
            (parameter IParameterSymbol) -> parameter.IsParams ||
                (
                parameter.Type is INamedTypeSymbol{Name: "Context"} contextType &&
                    IsConcurrencyRuntimeNamespace(contextType.ContainingNamespace)
            )
        )

        shared {
            private const ConcurrencyRuntimeNamespace string = "Gsharp.Concurrency"

            private func IsValueTaskEnvelope(type ITypeSymbol) bool -> type is INamedTypeSymbol{
                Name: "ValueTask"
            } named &&
                named
                .ContainingNamespace
                ?.ToDisplayString() == "System.Threading.Tasks"

            private func IsConcurrencyRuntimeNamespace(ns INamespaceSymbol?) bool -> ns != nil &&
                !ns.IsGlobalNamespace &&
                ns.ToDisplayString() == ConcurrencyRuntimeNamespace

            // The namespace that "owns" a resolved name: a type's own namespace; a
            // member's declaring type's namespace; for a local or parameter, the
            // namespace of its type (a `Chan<int> ch` parameter used as `ch` counts).
            private func NamespaceOf(symbol ISymbol?) INamespaceSymbol? {
                switch symbol {
                    case type is INamedTypeSymbol {
                        return type.ContainingNamespace
                    }
                    case _ is IMethodSymbol or _ is IPropertySymbol or _ is IFieldSymbol or _ is IEventSymbol {
                        return symbol!!.ContainingType?.ContainingNamespace
                    }
                    case local is ILocalSymbol {
                        return NamespaceOf(local.Type)
                    }
                    case parameter is IParameterSymbol {
                        return NamespaceOf(parameter.Type)
                    }
                    default {
                        return nil
                    }
                }
            }
        }
    }
}
