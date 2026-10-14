// <copyright file="DiagnosticLogPaths.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Diagnostics

import System.IO

/// Resolves default log file locations for host applications.
shared class DiagnosticLogPaths {
    /// Gets a default file path for opt-in host logging.
    /// @param fileName The log file name.
    /// @returns An absolute path beneath the platform temporary directory.
    func GetDefaultFilePath(fileName string) string {
        return Path.Combine(Path.GetTempPath(), fileName)
    }
}
