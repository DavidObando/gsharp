// <copyright file="DiagnosticBag.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis
{
    using System.Collections;
    using System.Collections.Generic;
    using GSharp.Core.CodeAnalysis.Symbols;
    using GSharp.Core.CodeAnalysis.Syntax;
    using GSharp.Core.CodeAnalysis.Text;

    /// <summary>
    /// Represents a collection of code analysis diagnostics information.
    /// </summary>
    public sealed class DiagnosticBag : IEnumerable<Diagnostic>
    {
        private readonly List<Diagnostic> diagnostics = new List<Diagnostic>();

        /// <inheritdoc/>
        public IEnumerator<Diagnostic> GetEnumerator() => diagnostics.GetEnumerator();

        /// <inheritdoc/>
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

        /// <summary>
        /// Adds the diagnotics contained by the specified diagnostics bag into
        /// this instance.
        /// </summary>
        /// <param name="diagnostics">The diagnostics bag to copy from.</param>
        public void AddRange(DiagnosticBag diagnostics)
        {
            this.diagnostics.AddRange(diagnostics.diagnostics);
        }

        /// <summary>
        /// Reports a bad character during lexing.
        /// </summary>
        /// <param name="position">Position in the stream.</param>
        /// <param name="character">The unexpected bad character.</param>
        public void ReportBadCharacter(int position, char character)
        {
            var span = new TextSpan(position, 1);
            var message = $"Bad character input: '{character}'.";
            Report(span, message);
        }

        /// <summary>
        /// Reports an unterminated string literal.
        /// </summary>
        /// <param name="span">Span where unterminated string was found.</param>
        public void ReportUnterminatedString(TextSpan span)
        {
            var message = "Unterminated string literal.";
            Report(span, message);
        }

        /// <summary>
        /// Reports a number literal as invalid.
        /// </summary>
        /// <param name="span">Span where literal was found.</param>
        /// <param name="text">Text found in the source document.</param>
        /// <param name="type">Expected type.</param>
        public void ReportInvalidNumber(TextSpan span, string text, TypeSymbol type)
        {
            var message = $"The number {text} isn't valid {type}.";
            Report(span, message);
        }

        /// <summary>
        /// Reports an unexpected token while parsing.
        /// </summary>
        /// <param name="span">The text span where the token was found.</param>
        /// <param name="actualKind">The kind of syntax encountered.</param>
        /// <param name="expectedKind">The kind of syntax expected.</param>
        public void ReportUnexpectedToken(TextSpan span, SyntaxKind actualKind, SyntaxKind expectedKind)
        {
            var message = $"Unexpected token <{actualKind}>, expected <{expectedKind}>.";
            Report(span, message);
        }

        private void Report(TextSpan span, string message)
        {
            var diagnostic = new Diagnostic(span, message);
            diagnostics.Add(diagnostic);
        }
    }
}
