// <copyright file="SymbolSourceOrderComparer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
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

    private const int MaxContainmentDepth = 100_000;

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

        cmp = x.Kind.CompareTo(y.Kind);
        if (cmp != 0)
        {
            return cmp;
        }

        // Last keys, after everything that orders existing output: the
        // declaration's extent, then the fully qualified signature (the
        // short-name signature above cannot tell List[A.X] from List[B.X]).
        cmp = (xNode?.Span.End ?? int.MaxValue).CompareTo(yNode?.Span.End ?? int.MaxValue);
        if (cmp != 0)
        {
            return cmp;
        }

        return string.CompareOrdinal(QualifiedSignature(x), QualifiedSignature(y));
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

    // Namespace and type segments are distinct: p.A/B is not p/A/B.
    private static string ContainingTypeName(Symbol symbol)
    {
        var builder = new StringBuilder();
        AppendSegment(builder, "namespace", symbol.ContainingType?.ContainingNamespace ?? symbol.ContainingNamespace ?? string.Empty);
        var chain = new List<TypeSymbol>();
        for (var type = symbol.ContainingType; type is not null; type = type.ContainingType)
        {
            // Containment is acyclic by construction. Truncating the chain would
            // make distinct deep paths tie, so a cycle fails loudly instead.
            if (chain.Count >= MaxContainmentDepth)
            {
                throw new InvalidOperationException("Symbol containment chain exceeds " + MaxContainmentDepth + " levels; is it cyclic?");
            }

            chain.Add(type);
        }

        for (int i = chain.Count - 1; i >= 0; i--)
        {
            AppendNamedTypeSegment(builder, chain[i]);
        }

        return builder.ToString();
    }

    private static string QualifiedSignature(Symbol symbol)
    {
        if (symbol is not FunctionSymbol function)
        {
            var key = new StringBuilder();
            if (symbol is TypeSymbol type)
            {
                AppendTypeKey(key, type);
            }

            return key.ToString();
        }

        var builder = new StringBuilder();
        builder.Append(function.TypeParameters.Length.ToString(CultureInfo.InvariantCulture))
            .Append(':').Append(function.ReturnRefKind)
            .Append(':').Append(function.NullableSequenceSpecialization)
            .Append(':').Append(function.IsStatic).Append(':');
        AppendTypeKey(builder, function.ExplicitInterfaceClauseTarget ?? function.ExplicitInterfaceSlotContainingType);
        AppendTypeKey(builder, function.Type);
        builder.Append('(');
        for (int i = 0; i < function.Parameters.Length; i++)
        {
            if (i > 0)
            {
                builder.Append(',');
            }

            var parameter = function.Parameters[i];
            builder.Append(parameter.RefKind).Append(':').Append(parameter.IsVariadic).Append(':');
            AppendTypeKey(builder, parameter.Type);
        }

        return builder.Append(')').ToString();
    }

    private static void AppendSegment(StringBuilder builder, string kind, string text) =>
        builder.Append(kind).Append(':').Append(text.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(text).Append(';');

    private static void AppendArguments(StringBuilder builder, ImmutableArray<TypeSymbol> arguments)
    {
        builder.Append('[');
        foreach (var argument in arguments)
        {
            AppendTypeKey(builder, argument);
            builder.Append(';');
        }

        builder.Append(']');
    }

    private static void AppendNamedTypeSegment(StringBuilder builder, TypeSymbol type)
    {
        AppendSegment(builder, type.GetType().Name, type.Name);
        switch (type)
        {
            case StructSymbol structure:
                builder.Append(structure.IsClass ? "class:" : "struct:")
                    .Append((structure.Definition ?? structure).TypeParameters.Length.ToString(CultureInfo.InvariantCulture));
                AppendArguments(builder, structure.EnclosingTypeArguments);
                AppendArguments(builder, structure.TypeArguments);
                break;
            case InterfaceSymbol contract:
                builder.Append((contract.Definition ?? contract).TypeParameters.Length.ToString(CultureInfo.InvariantCulture));
                AppendArguments(builder, contract.TypeArguments);
                break;
            case DelegateTypeSymbol delegateType:
                builder.Append((delegateType.Definition ?? delegateType).TypeParameters.Length.ToString(CultureInfo.InvariantCulture));
                AppendArguments(builder, delegateType.TypeArguments);
                break;
            case EnumSymbol enumeration:
                AppendArguments(builder, enumeration.EnclosingTypeArguments);
                break;
        }

        builder.Append(';');
    }

    private static void AppendTypeKey(StringBuilder builder, TypeSymbol? type)
    {
        switch (type)
        {
            case null:
                builder.Append("absent;");
                break;
            case TypeParameterSymbol parameter:
                builder.Append("parameter:").Append(parameter.IsMethodTypeParameter).Append(':')
                    .Append(parameter.Ordinal.ToString(CultureInfo.InvariantCulture)).Append(':');
                AppendSegment(builder, "name", parameter.Name);
                builder.Append(ContainingTypeName(parameter));
                break;
            case StructSymbol:
            case InterfaceSymbol:
            case DelegateTypeSymbol:
            case EnumSymbol:
                builder.Append(ContainingTypeName(type));
                AppendNamedTypeSegment(builder, type);
                break;
            case ImportedTypeSymbol imported:
                AppendClrKey(builder, imported.OpenDefinition ?? imported.ClrType);
                AppendArguments(builder, imported.TypeArguments);
                break;
            default:
                // Reuse the cache's shape walker, never its allocation-dependent
                // identity leaves. This also retains every nested nullable/platform
                // position without deriving nullability independently.
                FunctionTypeSymbol.AppendStructuralKey(builder, type, AppendTypeKey, AppendLeafKey);
                break;
        }
    }

    private static void AppendLeafKey(StringBuilder builder, TypeSymbol? type)
    {
        if (type?.ClrType is { } clrType)
        {
            AppendClrKey(builder, clrType);
        }
        else
        {
            AppendSegment(builder, "builtin", type?.Name ?? string.Empty);
        }
    }

    private static void AppendClrKey(StringBuilder builder, System.Type? type)
    {
        AppendSegment(builder, "assembly", type?.Assembly.FullName ?? string.Empty);
        AppendSegment(builder, "clr", type?.FullName ?? type?.Name ?? string.Empty);
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
