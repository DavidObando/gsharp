// <copyright file="RendezvousBatchAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0174 D10 / GS0562: a batch operation on a rendezvous channel.
/// </summary>
/// <remarks>
/// <para><c>chan[T]()</c> means one value in flight by definition, so
/// <c>ReceiveBatch</c> on it degenerates to that many sequential rendezvous
/// transfers. That is correct and pointless — the whole point of the batch
/// surface is to amortize one lock acquisition and one park across many
/// elements — so it is worth saying out loud.</para>
/// <para>The check runs over the bound bodies rather than at the call site
/// because a batch call reaches the binder through several paths (an extension
/// on a directional handle, an instance method on <c>Chan[T]</c>) and the
/// question is about the receiver's <em>declaration</em>, not the call.</para>
/// </remarks>
internal static class RendezvousBatchAnalyzer
{
    private const string ChanTypeName = "Gsharp.Concurrency.Chan`1";
    private const string BatchExtensionsTypeName = "Gsharp.Concurrency.ChannelBatchExtensions";
    private const string ConcurrencyHelpersTypeName = "Gsharp.Concurrency.<Program>";

    private static readonly HashSet<string> BatchMethodNames = new(System.StringComparer.Ordinal)
    {
        "TryReceiveBatch",
        "TrySendBatch",
        "ReceiveBatch",
        "SendBatch",
        "ReceiveBatchAsync",
        "SendBatchAsync",
    };

    /// <summary>Reports GS0562 for every batch operation on a channel declared without a capacity.</summary>
    /// <param name="bodies">Every bound body in the program.</param>
    /// <param name="diagnostics">Receives GS0562.</param>
    public static void Run(
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Builder bodies,
        ImmutableArray<Diagnostic>.Builder diagnostics)
    {
        foreach (var body in bodies.Values)
        {
            var walker = new Walker();
            walker.Visit(body);
            foreach (var (name, location) in walker.Findings)
            {
                var descriptor = DiagnosticDescriptors.BatchOnRendezvousChannel;
                diagnostics.Add(new Diagnostic(
                    location,
                    descriptor.Id,
                    descriptor.Severity,
                    string.Format(System.Globalization.CultureInfo.InvariantCulture, descriptor.MessageFormat, name)));
            }
        }
    }

    private sealed class Walker : BoundTreeWalker
    {
        private readonly HashSet<VariableSymbol> rendezvous = new();

        public List<(string Name, Text.TextLocation Location)> Findings { get; } = new();

        protected override void VisitVariableDeclaration(BoundVariableDeclaration node)
        {
            // `let ch = chan[T]()` — a Chan<T> constructed with a literal zero
            // capacity. The binder has already reported GS0548 there; this only
            // remembers which locals it applies to.
            if (node.Initializer is BoundClrConstructorCallExpression construction
                && construction.ClrType.IsGenericType
                && construction.ClrType.GetGenericTypeDefinition().FullName == ChanTypeName
                && construction.Arguments.Length == 1
                && construction.Arguments[0] is BoundLiteralExpression { Value: 0 })
            {
                rendezvous.Add(node.Variable);
            }

            base.VisitVariableDeclaration(node);
        }

        protected override void VisitImportedInstanceCallExpression(BoundImportedInstanceCallExpression node)
        {
            if (BatchMethodNames.Contains(node.Method.Name)
                && IsBatchDeclaringType(node.Method.DeclaringType)
                && Receiver(node.Receiver) is { } variable)
            {
                Report(variable, node.Syntax);
            }

            base.VisitImportedInstanceCallExpression(node);
        }

        protected override void VisitCallExpression(BoundCallExpression node)
        {
            // `chunks(ch, n)` is the shape D10 exists to encourage, and a
            // rendezvous channel handed to it is the most likely way to reach
            // the degenerate case. The callee is G#-authored, so it is an
            // ordinary call rather than an imported one.
            if (node.Function.Name == "chunks"
                && node.Function.Package?.Name == "Gsharp.Concurrency"
                && node.Arguments.Length > 0
                && Receiver(node.Arguments[0]) is { } chunked)
            {
                Report(chunked, node.Syntax);
            }

            base.VisitCallExpression(node);
        }

        protected override void VisitImportedCallExpression(BoundImportedCallExpression node)
        {
            // The extension form: the receiver is the first argument.
            if (BatchMethodNames.Contains(node.Function.Name)
                && node.Function.ImportedClass.ClassType.FullName == BatchExtensionsTypeName
                && node.Arguments.Length > 0
                && Receiver(node.Arguments[0]) is { } variable)
            {
                Report(variable, node.Syntax);
            }

            // `chunks(ch, n)` is the shape D10 exists to encourage, and a
            // rendezvous channel handed to it is the likeliest way to reach the
            // degenerate case. It is G#-authored but lives in another assembly,
            // so it arrives as a static call on that package's `<Program>`.
            if (node.Function.Name == "chunks"
                && node.Function.ImportedClass.ClassType.FullName == ConcurrencyHelpersTypeName
                && node.Arguments.Length > 0
                && Receiver(node.Arguments[0]) is { } chunked)
            {
                Report(chunked, node.Syntax);
            }

            base.VisitImportedCallExpression(node);
        }

        private static bool IsBatchDeclaringType(System.Type? declaring)
            => declaring != null
                && ((declaring.IsGenericType && declaring.GetGenericTypeDefinition().FullName == ChanTypeName)
                    || declaring.FullName == BatchExtensionsTypeName);

        // The operand may be wrapped in the `in chan[T]` / `out chan[T]` view
        // conversion, which carries no syntax of its own.
        private static VariableSymbol? Receiver(BoundExpression? expression)
            => expression switch
            {
                BoundConversionExpression conversion => Receiver(conversion.Expression),
                BoundVariableExpression { Variable: { } variable } => variable,
                _ => null,
            };

        private void Report(VariableSymbol variable, Syntax.SyntaxNode? syntax)
        {
            if (rendezvous.Contains(variable) && (syntax?.Location ?? variable.DeclaringSyntax?.Location) is { } location)
            {
                Findings.Add((variable.Name, location));
            }
        }
    }
}
