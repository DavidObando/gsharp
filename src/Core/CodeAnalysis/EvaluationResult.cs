// <copyright file="EvaluationResult.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis
{
    using System.Collections.Immutable;

    /// <summary>
    /// Evaluation result.
    /// </summary>
    public sealed class EvaluationResult
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="EvaluationResult"/> class.
        /// </summary>
        /// <param name="diagnostics">The diagnostics bag.</param>
        /// <param name="value">The evaluated value.</param>
        public EvaluationResult(ImmutableArray<Diagnostic> diagnostics, object value)
        {
            Diagnostics = diagnostics;
            Value = value;
        }

        /// <summary>
        /// Gets the diagnostics bag.
        /// </summary>
        public ImmutableArray<Diagnostic> Diagnostics { get; }

        /// <summary>
        /// Gets the evaluated value.
        /// </summary>
        public object Value { get; }
    }
}
