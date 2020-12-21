// <copyright file="Diagnostic.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis
{
    using GSharp.Core.CodeAnalysis.Text;

    /// <summary>
    /// Code analysis diagnostic information.
    /// </summary>
    public sealed class Diagnostic
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="Diagnostic"/> class.
        /// </summary>
        /// <param name="location">Text location in the document where this diagnostic information originates from.</param>
        /// <param name="message">Diagnostic information message.</param>
        public Diagnostic(TextLocation location, string message)
        {
            Location = location;
            Message = message;
        }

        /// <summary>
        /// Gets the text location in the document where this diagnostic information originates from.
        /// </summary>
        public TextLocation Location { get; }

        /// <summary>
        /// Gets the diagnostic information message.
        /// </summary>
        public string Message { get; }

        /// <summary>
        /// Diagnostic information message.
        /// </summary>
        /// <returns>A string with the message.</returns>
        public override string ToString() => Message;
    }
}
