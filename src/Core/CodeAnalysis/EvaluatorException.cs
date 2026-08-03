// <copyright file="EvaluatorException.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// Evaluator exception.
/// </summary>
public class EvaluatorException : Exception
{
    /// <summary>
    /// Initializes a new instance of the <see cref="EvaluatorException"/> class.
    /// </summary>
    public EvaluatorException()
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="EvaluatorException"/> class.
    /// </summary>
    /// <param name="message">The exception message.</param>
    public EvaluatorException(string message)
        : base(message)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="EvaluatorException"/> class.
    /// </summary>
    /// <param name="message">The exception message.</param>
    /// <param name="innerException">The inner exception.</param>
    public EvaluatorException(string message, Exception innerException)
        : base(message, innerException)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="EvaluatorException"/> class.
    /// </summary>
    /// <param name="message">The exception message.</param>
    /// <param name="node">The bound node associated with the exception.</param>
    public EvaluatorException(string message, BoundNode node)
        : base(message)
    {
        Node = node;
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="EvaluatorException"/> class.
    /// </summary>
    /// <param name="message">The exception message.</param>
    /// <param name="innerException">The inner exception.</param>
    /// <param name="node">The bound node associated with the exception.</param>
    public EvaluatorException(string message, Exception innerException, BoundNode node)
        : base(message, innerException)
    {
        Node = node;
    }

    /// <summary>
    /// Gets the bound node associated with the exception.
    /// </summary>
    public BoundNode Node { get; }

    /// <summary>
    /// Gets the source location associated with the exception, when available.
    /// </summary>
    internal TextLocation? Location { get; private set; }

    /// <summary>
    /// Gets the stable diagnostic identifier.
    /// </summary>
    internal string DiagnosticId { get; private set; } = "GS9999";

    /// <summary>
    /// Gets the diagnostic severity.
    /// </summary>
    internal DiagnosticSeverity Severity { get; private set; } = DiagnosticSeverity.Error;

    /// <summary>
    /// Gets a value indicating whether this exception is a compiler diagnostic
    /// that must bypass user exception handling.
    /// </summary>
    internal bool IsDiagnosticControlSignal { get; private set; }

    /// <summary>
    /// Creates an evaluator exception for a deliberate diagnostic.
    /// </summary>
    /// <param name="descriptor">The diagnostic descriptor.</param>
    /// <param name="node">The bound node associated with the exception.</param>
    /// <param name="messageArguments">Arguments used to format the descriptor message.</param>
    /// <returns>The evaluator exception.</returns>
    internal static EvaluatorException CreateDiagnostic(DiagnosticDescriptor descriptor, BoundNode node, params object[] messageArguments)
    {
        var message = messageArguments.Length == 0
            ? descriptor.MessageFormat
            : string.Format(descriptor.MessageFormat, messageArguments);
        return new EvaluatorException(message, node)
        {
            DiagnosticId = descriptor.Id,
            Severity = descriptor.Severity,
            IsDiagnosticControlSignal = true,
        };
    }

    /// <summary>
    /// Creates an evaluator exception for a deliberate diagnostic while preserving
    /// the evaluated exception's self-contained message.
    /// </summary>
    /// <param name="descriptor">The diagnostic descriptor.</param>
    /// <param name="innerException">The evaluated exception.</param>
    /// <param name="node">The bound node associated with the exception.</param>
    /// <param name="location">The source location associated with the exception.</param>
    /// <returns>The evaluator exception.</returns>
    internal static EvaluatorException CreateDiagnostic(
        DiagnosticDescriptor descriptor,
        Exception innerException,
        BoundNode node,
        TextLocation? location = null)
    {
        return new EvaluatorException(innerException.Message, innerException, node)
        {
            DiagnosticId = descriptor.Id,
            Severity = descriptor.Severity,
            Location = location,
        };
    }

    /// <summary>
    /// Creates an evaluator exception for a deliberate located diagnostic.
    /// </summary>
    /// <param name="descriptor">The diagnostic descriptor.</param>
    /// <param name="location">The source location.</param>
    /// <param name="node">The bound node associated with the exception.</param>
    /// <param name="messageArguments">The message format arguments.</param>
    /// <returns>The evaluator exception.</returns>
    internal static EvaluatorException CreateDiagnostic(
        DiagnosticDescriptor descriptor,
        TextLocation location,
        BoundNode node,
        params object[] messageArguments)
    {
        return new EvaluatorException(string.Format(descriptor.MessageFormat, messageArguments), node)
        {
            DiagnosticId = descriptor.Id,
            Severity = descriptor.Severity,
            Location = location,
            IsDiagnosticControlSignal = true,
        };
    }
}
