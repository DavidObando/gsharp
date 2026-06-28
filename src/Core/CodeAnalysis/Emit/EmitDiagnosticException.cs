#nullable disable

// <copyright file="EmitDiagnosticException.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// A typed exception that the emit pipeline wraps around internal failures so
/// that the <see cref="Compilation.Compilation.Emit(System.IO.Stream, System.IO.Stream)"/>
/// catch boundary can anchor the resulting <c>GS9998</c> diagnostic at the
/// offending source construct rather than a hard-coded <c>(1,1,1,1)</c>.
/// </summary>
internal sealed class EmitDiagnosticException : Exception
{
    /// <summary>
    /// Initializes a new instance of the <see cref="EmitDiagnosticException"/> class.
    /// </summary>
    /// <param name="message">A human-readable message describing the emit failure.</param>
    /// <param name="anchor">The syntax node nearest to the failure, or <c>null</c>.</param>
    /// <param name="innerException">The original exception, if wrapping one.</param>
    public EmitDiagnosticException(string message, SyntaxNode anchor, Exception innerException = null)
        : base(message, innerException)
    {
        Anchor = anchor;
    }

    /// <summary>
    /// Gets the best-known source location for the failure. May be <c>null</c>
    /// when no syntax context was available at the throw site.
    /// </summary>
    public SyntaxNode Anchor { get; }

    /// <summary>
    /// Throws an <see cref="EmitDiagnosticException"/> anchored at the given
    /// syntax node. Use this helper at call sites that previously threw
    /// <see cref="InvalidOperationException"/> or <see cref="NotSupportedException"/>.
    /// </summary>
    /// <param name="anchor">The syntax node nearest to the failure.</param>
    /// <param name="message">A human-readable message describing the failure.</param>
    [DoesNotReturn]
    public static void Throw(SyntaxNode anchor, string message)
    {
        throw new EmitDiagnosticException(message, anchor);
    }

    /// <summary>
    /// Wraps an existing exception in an <see cref="EmitDiagnosticException"/>
    /// preserving the inner exception and anchoring at the given syntax node.
    /// </summary>
    /// <param name="anchor">The syntax node nearest to the failure.</param>
    /// <param name="innerException">The original exception to wrap.</param>
    [DoesNotReturn]
    public static void Wrap(SyntaxNode anchor, Exception innerException)
    {
        throw new EmitDiagnosticException(
            $"{innerException.GetType().Name}: {innerException.Message}",
            anchor,
            innerException);
    }
}
