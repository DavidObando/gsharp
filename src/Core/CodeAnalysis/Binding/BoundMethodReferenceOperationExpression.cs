// <copyright file="BoundMethodReferenceOperationExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Reflection;
using System.Threading;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// The shape shared by every bound node that REFERENCES a method without
/// calling it — a method group used as a value (ADR-0169, issue #4436). It is
/// the analyzer-facing counterpart of Roslyn's <c>IMethodReferenceOperation</c>.
/// </summary>
/// <remarks>
/// G# binds a method group to a different node for each callee provenance:
/// <c>BoundMethodGroupExpression</c> for a same-compilation function and
/// <c>BoundClrMethodGroupExpression</c> for an imported one. As with
/// <see cref="BoundCallOperationExpression"/>, an analyzer should not have to
/// know the split, so both derive from this base and a rule registers both
/// <see cref="BoundNodeKind"/> values.
/// </remarks>
public abstract class BoundMethodReferenceOperationExpression : BoundExpression
{
    private Symbol? importedMethod;

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundMethodReferenceOperationExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    private protected BoundMethodReferenceOperationExpression(SyntaxNode? syntax)
        : base(syntax)
    {
    }

    /// <summary>
    /// Gets the referenced method — the Roslyn
    /// <c>IMethodReferenceOperation.Method</c> analogue. It is the selected
    /// overload once the group is resolved against a target delegate type,
    /// and otherwise the group's first candidate. The candidates of one group
    /// share their name and declaring type, which is what the analyzer
    /// surface reads from this symbol. <see langword="null"/> only for an
    /// empty group.
    /// </summary>
    public abstract Symbol? Method { get; }

    /// <summary>
    /// Gets the receiver the delegate would capture — the Roslyn
    /// <c>IMethodReferenceOperation.Instance</c> analogue — or
    /// <see langword="null"/> for a static method.
    /// </summary>
    public abstract BoundExpression? Instance { get; }

    /// <summary>
    /// Builds, once, the symbol for a reflected method that a group node
    /// stores as a <see cref="MethodInfo"/> rather than a symbol.
    /// </summary>
    /// <param name="method">The reflected method, or null for an empty group.</param>
    /// <returns>The method symbol, or null.</returns>
    private protected Symbol? ImportedMethod(MethodInfo? method)
    {
        if (method == null)
        {
            return null;
        }

        if (Volatile.Read(ref importedMethod) is { } cached)
        {
            return cached;
        }

        // Analyzers may run concurrently: publish the first symbol built, so
        // every reader sees one fully constructed instance.
        var built = new ImportedFunctionSymbol(
            method.Name,
            new ImportedClassSymbol(ContainingClrType(method), declaration: null),
            method,
            declaration: null);
        return Interlocked.CompareExchange(ref importedMethod, built, null) ?? built;
    }

    // The type the method is declared on. A module-level (global) method has
    // no declaring type; its reflected type is the next best answer, and
    // object only when reflection reports neither, which ordinary metadata
    // methods never do.
    private static Type ContainingClrType(MethodInfo method)
        => method.DeclaringType ?? method.ReflectedType ?? typeof(object);
}
