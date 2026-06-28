#nullable disable

// <copyright file="Constants.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
    /// Gets the GSharp language id advertised by the vscode client (used for document filters).
    /// </summary>
    public static string LanguageId { get; } = "gsharp";
}
