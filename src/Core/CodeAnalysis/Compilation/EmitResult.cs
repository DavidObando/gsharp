// <copyright file="EmitResult.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Compilation
{
    using System.Collections.Immutable;

    /// <summary>
    /// Represents the result of a compilation emit operation.
    /// </summary>
    public class EmitResult
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="EmitResult"/> class.
        /// </summary>
        /// <param name="success">Success state.</param>
        /// <param name="diagnostics">Diagnostics bag.</param>
        public EmitResult(bool success, ImmutableArray<Diagnostic> diagnostics)
        {
            Success = success;
            Diagnostics = diagnostics;
        }

        /// <summary>
        /// Gets a value indicating whether the compilation successfully produced an executable.
        /// If false then the diagnostics should include at least one error diagnostic
        /// indicating the cause of the failure.
        /// </summary>
        public bool Success { get; }

        /// <summary>
        /// Gets a list of all the diagnostics associated with compilations. This include parse errors, declaration errors,
        /// compilation errors, and emitting errors.
        /// </summary>
        public ImmutableArray<Diagnostic> Diagnostics { get; }
    }
}
