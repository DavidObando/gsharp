// <copyright file="DiagnosticLogPaths.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Diagnostics;

/// <summary>
/// Resolves default log file locations for host applications.
/// </summary>
public static class DiagnosticLogPaths
{
    /// <summary>
    /// Gets a default file path for opt-in host logging.
    /// </summary>
    /// <param name="fileName">The log file name.</param>
    /// <returns>An absolute path beneath the platform temporary directory.</returns>
    public static string GetDefaultFilePath(string fileName)
    {
        return Path.Combine(Path.GetTempPath(), fileName);
    }
}
