// <copyright file="Constants.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using OmniSharp.Extensions.LanguageServer.Protocol.Models;

namespace GSharp.LanguageServer;

/// <summary>
/// Constants used in GSharp LanguageServer.
/// </summary>
public static class Constants
{
    /// <summary>
    /// Gets GSharp language identifier.
    /// </summary>
    public static string LanguageIdentifier { get; } = "G#";

    /// <summary>
    /// Gets the common <see cref="TextDocumentSelector"/> for all handlers.
    /// </summary>
    public static TextDocumentSelector DocumentSelector { get; } = new(
        new TextDocumentFilter
        {
            Pattern = "**/*.gs",
        });
}
