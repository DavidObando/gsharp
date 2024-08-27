// <copyright file="EvaluatorException.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis
{
    using System;
    using GSharp.Core.CodeAnalysis.Binding;

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
    }
}