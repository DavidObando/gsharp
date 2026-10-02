// <copyright file="SymbolSourceOrderComparer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// The compiler's one deterministic order over symbols (issue #4663).
/// </summary>
/// <remarks>
/// <para>
/// Symbols do not override <see cref="object.GetHashCode"/>, so every
/// hash-ordered collection keyed by them (<c>ImmutableDictionary</c>,
/// <c>ImmutableHashSet</c>, a <c>Dictionary</c> after removals) enumerates in
/// identity-hash order. CoreCLR identity hashes come from a per-thread
/// generator: they repeat for the same compiler binary fed the same inputs,
/// and change as soon as anything shifts allocation — an unrelated input
/// file, a different file order, or a differently-built compiler. Any name,
/// counter or emission order derived from such an enumeration is therefore
/// not deterministic, even under <c>/deterministic</c>.
/// </para>
/// <para>
/// This comparer orders by source facts only, never by input order: the
/// declaration's span start, name and parameter signature (the emitter's
/// MethodDef order since issue #456, kept as the primary keys so existing
/// output does not move), then the declaring file name, the position of any
/// other declaring node (local functions), and the containing type.
/// </para>
/// </remarks>
internal sealed class SymbolSourceOrderComparer : IComparer<Symbol>, IComparer<FunctionSymbol>
{
    /// <summary>The shared instance.</summary>
    public static readonly SymbolSourceOrderComparer Instance = new SymbolSourceOrderComparer();

    private SymbolSourceOrderComparer()
    {
    }

    /// <inheritdoc/>
    public int Compare(FunctionSymbol? x, FunctionSymbol? y) => this.Compare((Symbol?)x, y);

    /// <inheritdoc/>
    public int Compare(Symbol? x, Symbol? y)
    {
        if (ReferenceEquals(x, y))
        {
            return 0;
        }

        if (x is null)
        {
            return -1;
        }

        if (y is null)
        {
            return 1;
        }

        int cmp = PrimaryPosition(x).CompareTo(PrimaryPosition(y));
        if (cmp != 0)
        {
            return cmp;
        }

        cmp = string.CompareOrdinal(x.Name ?? string.Empty, y.Name ?? string.Empty);
        if (cmp != 0)
        {
            return cmp;
        }

        if (x is FunctionSymbol xf && y is FunctionSymbol yf)
        {
            cmp = string.CompareOrdinal(FormatSignature(xf), FormatSignature(yf));
            if (cmp != 0)
            {
                return cmp;
            }
        }

        SyntaxNode? xNode = FirstDeclaringNode(x);
        SyntaxNode? yNode = FirstDeclaringNode(y);
        cmp = string.CompareOrdinal(FileName(xNode), FileName(yNode));
        if (cmp != 0)
        {
            return cmp;
        }

        cmp = (xNode?.Span.Start ?? int.MaxValue).CompareTo(yNode?.Span.Start ?? int.MaxValue);
        if (cmp != 0)
        {
            return cmp;
        }

        cmp = string.CompareOrdinal(ContainingTypeName(x), ContainingTypeName(y));
        if (cmp != 0)
        {
            return cmp;
        }

        return x.Kind.CompareTo(y.Kind);
    }

    /// <summary>
    /// The emitter's historical primary key: a function's own declaration
    /// start (a local function or literal has none and sorts last), or any
    /// other symbol's first declaring node.
    /// </summary>
    private static int PrimaryPosition(Symbol symbol) => symbol is FunctionSymbol function
        ? function.Declaration?.Span.Start ?? int.MaxValue
        : FirstDeclaringNode(symbol)?.Span.Start ?? int.MaxValue;

    private static SyntaxNode? FirstDeclaringNode(Symbol symbol)
    {
        var nodes = symbol.DeclaringSyntaxNodes;
        return nodes.IsDefaultOrEmpty ? null : nodes[0];
    }

    private static string FileName(SyntaxNode? node) => node?.SyntaxTree?.Text?.FileName ?? string.Empty;

    private static string ContainingTypeName(Symbol symbol)
    {
        var containing = symbol.ContainingType;
        if (containing is null)
        {
            return string.Empty;
        }

        return (containing.ContainingNamespace ?? string.Empty) + "." + containing.Name;
    }

    private static string FormatSignature(FunctionSymbol function)
    {
        var builder = new StringBuilder();
        builder.Append(function.Type?.Name ?? "?");
        builder.Append('(');
        for (int i = 0; i < function.Parameters.Length; i++)
        {
            if (i > 0)
            {
                builder.Append(',');
            }

            builder.Append(function.Parameters[i].Type?.Name ?? "?");
        }

        builder.Append(')');
        return builder.ToString();
    }
}
