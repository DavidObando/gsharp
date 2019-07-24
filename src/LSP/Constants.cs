// <copyright file="Constants.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.LSP
{
    using OmniSharp.Extensions.LanguageServer.Protocol.Models;

    /// <summary>
    /// Constants used in GSharp LSP.
    /// </summary>
    public static class Constants
    {
        /// <summary>
        /// Gets GSharp language identifier.
        /// </summary>
        public static string LanguageIdentifier { get; } = "G#";

        /// <summary>
        /// Gets the common <see cref="DocumentSelector"/> for all handlers.
        /// </summary>
        public static DocumentSelector DocumentSelector { get; } = new DocumentSelector(
            new DocumentFilter()
            {
                Pattern = "**/*.gs",
            });
    }
}
