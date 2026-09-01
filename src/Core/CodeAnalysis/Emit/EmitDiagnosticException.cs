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
    public EmitDiagnosticException(string message, SyntaxNode? anchor, Exception? innerException = null)
        : base(message, innerException)
    {
        Anchor = anchor;
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="EmitDiagnosticException"/>
    /// class that reports a specific diagnostic rather than the GS9998
    /// internal-error catch-all.
    /// </summary>
    /// <param name="diagnosticId">The diagnostic id to report.</param>
    /// <param name="message">The diagnostic's message, used verbatim.</param>
    /// <param name="anchor">The syntax node nearest to the failure, or <c>null</c>.</param>
    private EmitDiagnosticException(string diagnosticId, string message, SyntaxNode? anchor)
        : base(message)
    {
        Anchor = anchor;
        DiagnosticId = diagnosticId;
    }

    /// <summary>
    /// Gets the diagnostic id this failure should be reported as, or
    /// <see langword="null"/> to fall back to GS9998.
    /// <para>
    /// Issue #3755: an emit-time well-known member the <em>target framework</em>
    /// does not declare is a condition of the user's reference closure, not a
    /// compiler bug, so it must not be dressed up as an internal error. The
    /// emit pipeline has no <c>DiagnosticBag</c> in scope (see
    /// <c>MethodBodyEmitter.Expressions.cs</c>), so the existing exception
    /// channel carries the id instead of a new sink being threaded through it.
    /// </para>
    /// </summary>
    public string? DiagnosticId { get; }

    /// <summary>
    /// Gets the best-known source location for the failure. May be <c>null</c>
    /// when no syntax context was available at the throw site.
    /// </summary>
    public SyntaxNode? Anchor { get; }

    /// <summary>
    /// Throws a failure that surfaces as <c>GS0546</c>: the referenced target
    /// framework does not declare a member the lowering emits a call to.
    /// </summary>
    /// <param name="anchor">The syntax node nearest to the failure, or <c>null</c>.</param>
    /// <param name="missingMember">The member the target does not provide.</param>
    [DoesNotReturn]
    public static void ThrowTargetFrameworkMemberUnavailable(SyntaxNode? anchor, string missingMember)
    {
        var descriptor = DiagnosticDescriptors.TargetFrameworkMemberUnavailable;
        throw new EmitDiagnosticException(
            descriptor.Id,
            string.Format(System.Globalization.CultureInfo.InvariantCulture, descriptor.MessageFormat, missingMember),
            anchor);
    }

    /// <summary>
    /// Throws an <see cref="EmitDiagnosticException"/> anchored at the given
    /// syntax node. Use this helper at call sites that previously threw
    /// <see cref="InvalidOperationException"/> or <see cref="NotSupportedException"/>.
    /// </summary>
    /// <param name="anchor">The syntax node nearest to the failure, or
    /// <c>null</c> for a synthesized node with no source counterpart.</param>
    /// <param name="message">A human-readable message describing the failure.</param>
    [DoesNotReturn]
    public static void Throw(SyntaxNode? anchor, string message)
    {
        throw new EmitDiagnosticException(message, anchor);
    }

    /// <summary>
    /// Wraps an existing exception in an <see cref="EmitDiagnosticException"/>
    /// preserving the inner exception and anchoring at the given syntax node.
    /// </summary>
    /// <param name="anchor">The syntax node nearest to the failure, or
    /// <c>null</c> for a synthesized node with no source counterpart.</param>
    /// <param name="innerException">The original exception to wrap.</param>
    [DoesNotReturn]
    public static void Wrap(SyntaxNode? anchor, Exception innerException)
    {
        throw new EmitDiagnosticException(
            $"{innerException.GetType().Name}: {innerException.Message}",
            anchor,
            innerException);
    }
}
