// <copyright file="RendezvousBatchAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization

/// ADR-0174 D10 / GS0562: a batch operation on a rendezvous channel.
/// @remarks `chan[T]()` means one value in flight by definition, so
/// `ReceiveBatch` on it degenerates to that many sequential rendezvous
/// transfers. That is correct and pointless — the whole point of the batch
/// surface is to amortize one lock acquisition and one park across many
/// elements — so it is worth saying out loud.
///
/// The check runs over the bound bodies rather than at the call site
/// because a batch call reaches the binder through several paths (an extension
/// on a directional handle, an instance method on `Chan[T]`) and the
/// question is about the receiver's <em>declaration</em>, not the call.
internal shared class RendezvousBatchAnalyzer {
    private class Walker : BoundTreeWalker {
        init() {
            Findings = List[(Name string, Location TextLocation)]()
        }

        private let rendezvous HashSet[VariableSymbol] = HashSet[VariableSymbol]()

        prop Findings List[(Name string, Location TextLocation)] {
            get;
        }

        protected override func VisitVariableDeclaration(node BoundVariableDeclaration) {
            // `let ch = chan[T]()` — a Chan<T> constructed with a literal zero
            // capacity. The binder has already reported GS0548 there; this only
            // remembers which locals it applies to.
            if node.Initializer is BoundClrConstructorCallExpression construction &&
                construction
                .ClrType
                .IsGenericType &&
                construction
                .ClrType
                .GetGenericTypeDefinition()
                .FullName == RendezvousBatchAnalyzer.ChanTypeName &&
                construction
                .Arguments
                .Length == 1 &&
                (construction.Arguments[0] is BoundLiteralExpression and {Value: 0}) {
                rendezvous.Add(node.Variable)
            }
            base.VisitVariableDeclaration(node)
        }

        protected override func VisitImportedInstanceCallExpression(node BoundImportedInstanceCallExpression) {
            if RendezvousBatchAnalyzer.BatchMethodNames.Contains(node.Method.Name) &&
                IsBatchDeclaringType(node.Method.DeclaringType) &&
                Receiver(node.Receiver) is {} variable {
                Report(variable, node.Syntax)
            }
            base.VisitImportedInstanceCallExpression(node)
        }

        protected override func VisitCallExpression(node BoundCallExpression) {
            // `chunks(ch, n)` is the shape D10 exists to encourage, and a
            // rendezvous channel handed to it is the most likely way to reach
            // the degenerate case. The callee is G#-authored, so it is an
            // ordinary call rather than an imported one.
            if node
                .Function
                .Name == "chunks" &&
                node
                .Function
                .Package
                ?.Name == "Gsharp.Concurrency" &&
                node
                .Arguments
                .Length > 0 &&
                Receiver(node.Arguments[0]) is {} chunked {
                Report(chunked, node.Syntax)
            }
            base.VisitCallExpression(node)
        }

        protected override func VisitImportedCallExpression(node BoundImportedCallExpression) {
            // The extension form: the receiver is the first argument.
            if RendezvousBatchAnalyzer.BatchMethodNames.Contains(node.Function.Name) &&
                node
                .Function
                .ImportedClass
                .ClassType
                .FullName == RendezvousBatchAnalyzer.BatchExtensionsTypeName &&
                node
                .Arguments
                .Length > 0 &&
                Receiver(node.Arguments[0]) is {} variable {
                Report(variable, node.Syntax)
            }
            // `chunks(ch, n)` is the shape D10 exists to encourage, and a
            // rendezvous channel handed to it is the likeliest way to reach the
            // degenerate case. It is G#-authored but lives in another assembly,
            // so it arrives as a static call on that package's `<Program>`.
            if node
                .Function
                .Name == "chunks" &&
                node
                .Function
                .ImportedClass
                .ClassType
                .FullName == RendezvousBatchAnalyzer.ConcurrencyHelpersTypeName &&
                node
                .Arguments
                .Length > 0 &&
                Receiver(node.Arguments[0]) is {} chunked {
                Report(chunked, node.Syntax)
            }
            base.VisitImportedCallExpression(node)
        }

        private func Report(variable VariableSymbol, syntax SyntaxNode?) {
            if rendezvous.Contains(variable) &&
                (syntax?.Location ?? variable.DeclaringSyntax?.Location) is {} location {
                Findings.Add((variable.Name, location))
            }
        }

        shared {
            private func IsBatchDeclaringType(declaring Type?) bool -> declaring != nil &&
                (
                (
                    declaring.IsGenericType && declaring.GetGenericTypeDefinition()
                        .FullName == RendezvousBatchAnalyzer.ChanTypeName
                ) ||
                    declaring.FullName == RendezvousBatchAnalyzer.BatchExtensionsTypeName
            )

            // The operand may be wrapped in the `in chan[T]` / `out chan[T]` view
            // conversion, which carries no syntax of its own.
            private func Receiver(expression BoundExpression?) VariableSymbol? -> switch expression {
                case conversion is BoundConversionExpression: Receiver(conversion.Expression)
                case BoundVariableExpression{Variable: {} variable}: variable
                default: default(VariableSymbol?)
            }
        }
    }

    private const ChanTypeName string = "Gsharp.Concurrency.Chan`1"
    private const BatchExtensionsTypeName string = "Gsharp.Concurrency.ChannelBatchExtensions"
    private const ConcurrencyHelpersTypeName string = "Gsharp.Concurrency.<Program>"
    private let BatchMethodNames HashSet[string] = HashSet[string](StringComparer.Ordinal){
        "TryReceiveBatch",
        "TrySendBatch",
        "ReceiveBatch",
        "SendBatch",
        "ReceiveBatchAsync",
        "SendBatchAsync"
    }

    /// Reports GS0562 for every batch operation on a channel declared without a capacity.
    /// @param bodies Every bound body in the program.
    /// @param diagnostics Receives GS0562.
    func Run(
        bodies ImmutableDictionary[FunctionSymbol, BoundBlockStatement].Builder,
        diagnostics ImmutableArray[Diagnostic].Builder
    ) {
        for body in bodies.Values {
            let walker = RendezvousBatchAnalyzer.Walker()
            walker.Visit(body)
            for (name, location) in walker.Findings {
                let descriptor = DiagnosticDescriptors.BatchOnRendezvousChannel
                diagnostics.Add(
                    Diagnostic(
                        location,
                        descriptor.Id,
                        descriptor.Severity,
                        string.Format(CultureInfo.InvariantCulture, descriptor.MessageFormat, name)
                    )
                )
            }
        }
    }
}
