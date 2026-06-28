// <copyright file="ILogger.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

namespace GSharp.Core.CodeAnalysis.Diagnostics;

/// <summary>
/// Defines logging severity levels.
/// </summary>
public enum LogLevel
{
    /// <summary>Verbose diagnostic information.</summary>
    Debug,

    /// <summary>Informational messages.</summary>
    Info,

    /// <summary>Potentially harmful situations.</summary>
    Warning,

    /// <summary>Error events.</summary>
    Error,
}

/// <summary>
/// A lightweight logging abstraction for host applications.
/// </summary>
public interface ILogger
{
    /// <summary>
    /// Writes a log entry.
    /// </summary>
    /// <param name="level">The severity level of the log entry.</param>
    /// <param name="message">The log message.</param>
    /// <param name="exception">Optional exception to include.</param>
    void Log(LogLevel level, string message, Exception? exception = null);

    /// <summary>
    /// Writes a debug log entry.
    /// </summary>
    /// <param name="message">The log message.</param>
    /// <param name="exception">Optional exception to include.</param>
    void LogDebug(string message, Exception? exception = null);

    /// <summary>
    /// Writes an informational log entry.
    /// </summary>
    /// <param name="message">The log message.</param>
    /// <param name="exception">Optional exception to include.</param>
    void LogInfo(string message, Exception? exception = null);

    /// <summary>
    /// Writes a warning log entry.
    /// </summary>
    /// <param name="message">The log message.</param>
    /// <param name="exception">Optional exception to include.</param>
    void LogWarning(string message, Exception? exception = null);

    /// <summary>
    /// Writes an error log entry.
    /// </summary>
    /// <param name="message">The log message.</param>
    /// <param name="exception">Optional exception to include.</param>
    void LogError(string message, Exception? exception = null);

    /// <summary>
    /// Checks if the given log level is enabled.
    /// </summary>
    /// <param name="level">The severity level to check.</param>
    /// <returns><see langword="true"/> if this level is enabled; otherwise, <see langword="false"/>.</returns>
    bool IsEnabled(LogLevel level);
}

/// <summary>
/// A no-op logger that discards all log entries. Use <see cref="Instance"/> to access the singleton.
/// </summary>
public sealed class NullLogger : ILogger
{
    /// <summary>
    /// Gets the singleton instance of <see cref="NullLogger"/>.
    /// </summary>
    public static readonly NullLogger Instance = new();

    /// <inheritdoc/>
    public void Log(LogLevel level, string message, Exception? exception = null)
    {
    }

    /// <inheritdoc/>
    public void LogDebug(string message, Exception? exception = null)
    {
    }

    /// <inheritdoc/>
    public void LogInfo(string message, Exception? exception = null)
    {
    }

    /// <inheritdoc/>
    public void LogWarning(string message, Exception? exception = null)
    {
    }

    /// <inheritdoc/>
    public void LogError(string message, Exception? exception = null)
    {
    }

    /// <inheritdoc/>
    public bool IsEnabled(LogLevel level) => false;
}
