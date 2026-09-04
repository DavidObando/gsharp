// <copyright file="CSharpToGSharpTranslator.Suspension.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Cs2Gs.Translator;

public sealed partial class CSharpToGSharpTranslator
{
    /// <summary>
    /// ADR-0174 D4: recognizes the C# shape a G# <c>suspend func</c> compiles to,
    /// so it translates back to one instead of an <c>async func</c> with an
    /// explicit <c>ValueTask[T]</c> envelope.
    /// </summary>
    private sealed partial class DeclarationVisitor
    {
        private const string ConcurrencyRuntimeNamespace = "Gsharp.Concurrency";

        /// <summary>
        /// A method is a suspending candidate when it is <c>async</c>, returns
        /// <c>ValueTask</c> or <c>ValueTask&lt;T&gt;</c>, and either carries
        /// <c>[Gsharp.Concurrency.Suspending]</c> (the attribute G# stamps on
        /// every suspending function) or names a Gsharp.Concurrency runtime
        /// type or member anywhere in its signature or body (<c>Chan&lt;T&gt;</c>,
        /// <c>ChannelOps</c>, <c>Context</c>, <c>ScopeFrame</c>, …). A plain
        /// <c>async ValueTask&lt;T&gt;</c> method that never touches the runtime
        /// is ordinary asynchronous code and keeps B.23's explicit envelope.
        /// </summary>
        /// <param name="symbol">The method symbol.</param>
        /// <param name="node">The method declaration.</param>
        /// <returns><see langword="true"/> when the method renders as <c>suspend func</c>.</returns>
        private bool IsSuspendingCandidate(IMethodSymbol symbol, MethodDeclarationSyntax node)
        {
            if (!symbol.IsAsync || !IsValueTaskEnvelope(symbol.ReturnType))
            {
                return false;
            }

            if (symbol.GetAttributes().Any(attribute =>
                attribute.AttributeClass is { Name: "SuspendingAttribute" } attributeClass
                && IsConcurrencyRuntimeNamespace(attributeClass.ContainingNamespace)))
            {
                return true;
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
            if (IsConcurrencyRuntimeNamespace(symbol.ContainingType?.ContainingNamespace))
            {
                return false;
            }

            SemanticModel model = this.context.SemanticModel.SyntaxTree == node.SyntaxTree
                ? this.context.SemanticModel
                : this.context.Compilation.GetSemanticModel(node.SyntaxTree);
            foreach (SyntaxNode descendant in node.DescendantNodes())
            {
                if (descendant is not (IdentifierNameSyntax or GenericNameSyntax))
                {
                    continue;
                }

                ISymbol resolved = model.GetSymbolInfo(descendant).Symbol;
                if (IsConcurrencyRuntimeNamespace(NamespaceOf(resolved)))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool IsValueTaskEnvelope(ITypeSymbol type)
            => type is INamedTypeSymbol { Name: "ValueTask" } named
                && named.ContainingNamespace?.ToDisplayString() == "System.Threading.Tasks";

        private static bool IsConcurrencyRuntimeNamespace(INamespaceSymbol ns)
            => ns != null && !ns.IsGlobalNamespace && ns.ToDisplayString() == ConcurrencyRuntimeNamespace;

        // The namespace that "owns" a resolved name: a type's own namespace; a
        // member's declaring type's namespace; for a local or parameter, the
        // namespace of its type (a `Chan<int> ch` parameter used as `ch` counts).
        private static INamespaceSymbol NamespaceOf(ISymbol symbol)
        {
            switch (symbol)
            {
                case INamedTypeSymbol type:
                    return type.ContainingNamespace;
                case IMethodSymbol or IPropertySymbol or IFieldSymbol or IEventSymbol:
                    return symbol.ContainingType?.ContainingNamespace;
                case ILocalSymbol local:
                    return NamespaceOf(local.Type);
                case IParameterSymbol parameter:
                    return NamespaceOf(parameter.Type);
                default:
                    return null;
            }
        }
    }
}
