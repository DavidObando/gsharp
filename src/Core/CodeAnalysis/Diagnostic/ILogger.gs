// <copyright file="ILogger.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Diagnostics

import System

/// Defines logging severity levels.
enum LogLevel {
    Debug,
    Info,
    Warning,
    Error
}

/// A lightweight logging abstraction for host applications.
interface ILogger {
    /// Writes a log entry.
    /// @param level The severity level of the log entry.
    /// @param message The log message.
    /// @param exception Optional exception to include.
    func Log(level LogLevel, message string, exception Exception? = nil);

    /// Writes a debug log entry.
    /// @param message The log message.
    /// @param exception Optional exception to include.
    func LogDebug(message string, exception Exception? = nil);

    /// Writes an informational log entry.
    /// @param message The log message.
    /// @param exception Optional exception to include.
    func LogInfo(message string, exception Exception? = nil);

    /// Writes a warning log entry.
    /// @param message The log message.
    /// @param exception Optional exception to include.
    func LogWarning(message string, exception Exception? = nil);

    /// Writes an error log entry.
    /// @param message The log message.
    /// @param exception Optional exception to include.
    func LogError(message string, exception Exception? = nil);

    /// Checks if the given log level is enabled.
    /// @param level The severity level to check.
    /// @returns `true` if this level is enabled; otherwise, `false`.
    func IsEnabled(level LogLevel) bool;
}

/// A no-op logger that discards all log entries. Use (cref:Instance) to access the singleton.
class NullLogger : ILogger {
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Log(level LogLevel, message string, exception Exception? = nil) { }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func LogDebug(message string, exception Exception? = nil) { }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func LogInfo(message string, exception Exception? = nil) { }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func LogWarning(message string, exception Exception? = nil) { }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func LogError(message string, exception Exception? = nil) { }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func IsEnabled(level LogLevel) bool -> false

    shared {
        /// Gets the singleton instance of (cref:NullLogger).
        let Instance NullLogger = NullLogger()
    }
}
