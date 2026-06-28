// <copyright file="FileLogger.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System.Text.Json;

namespace GSharp.Core.CodeAnalysis.Diagnostics;

/// <summary>
/// A simple logger that writes structured log entries to a text file.
/// Each entry is prefixed with a timestamp and severity level.
/// </summary>
public sealed class FileLogger : ILogger, IDisposable
{
    private readonly string filePath;
    private readonly object lockObj = new();
    private StreamWriter? writer;

    /// <summary>
    /// Initializes a new instance of the <see cref="FileLogger"/> class.
    /// </summary>
    /// <param name="filePath">The path to the log file.</param>
    public FileLogger(string filePath)
    {
        this.filePath = filePath;

        var dir = Path.GetDirectoryName(filePath);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }

        writer = new StreamWriter(filePath, append: true) { AutoFlush = true };
    }

    /// <inheritdoc/>
    public void Log(LogLevel level, string message, Exception? exception = null)
    {
        lock (lockObj)
        {
            if (writer == null)
            {
                return;
            }

            var entry = new
            {
                Timestamp = DateTimeOffset.UtcNow,
                Level = ToLevelName(level),
                Message = message,
                ExceptionType = exception?.GetType().FullName,
                Exception = exception?.ToString(),
            };

            writer.WriteLine(JsonSerializer.Serialize(entry));
        }
    }

    /// <inheritdoc/>
    public bool IsEnabled(LogLevel level) => true;

    /// <inheritdoc/>
    public void LogDebug(string message, Exception? exception = null) => Log(LogLevel.Debug, message, exception);

    /// <inheritdoc/>
    public void LogInfo(string message, Exception? exception = null) => Log(LogLevel.Info, message, exception);

    /// <inheritdoc/>
    public void LogWarning(string message, Exception? exception = null) => Log(LogLevel.Warning, message, exception);

    /// <inheritdoc/>
    public void LogError(string message, Exception? exception = null) => Log(LogLevel.Error, message, exception);

    /// <inheritdoc/>
    public void Dispose()
    {
        lock (lockObj)
        {
            if (writer != null)
            {
                writer.Dispose();
                writer = null;
            }
        }
    }

    private static string ToLevelName(LogLevel level)
        => level switch
        {
            LogLevel.Debug => "Debug",
            LogLevel.Info => "Info",
            LogLevel.Warning => "Warning",
            LogLevel.Error => "Error",
            _ => level.ToString(),
        };
}
