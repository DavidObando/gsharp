// <copyright file="FileLogger.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Diagnostics

import System
import System.IO
import System.Text.Json
import SystemObject = System.Object

/// A simple logger that writes structured log entries to a text file.
/// Each entry is prefixed with a timestamp and severity level.
class FileLogger : ILogger, IDisposable {
    private let filePath string
    private let lockObj object = SystemObject()
    private var writer StreamWriter?

    /// Initializes a new instance of the (cref:FileLogger) class.
    /// @param filePath The path to the log file.
    init(filePath string) {
        this.filePath = filePath
        let dir = Path.GetDirectoryName(filePath)
        if !string.IsNullOrEmpty(dir) {
            Directory.CreateDirectory(dir)
        }
        writer = StreamWriter(filePath, append: true){AutoFlush = true}
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Log(level LogLevel, message string, exception Exception? = nil) {
        lock lockObj {
            if writer == nil {
                return
            }
            let entry = AnonymousType5_E0A483F6BDB3ADA5(
                DateTimeOffset.UtcNow,
                ToLevelName(level),
                message,
                exception?.GetType().FullName,
                exception?.ToString()
            )
            writer!!.WriteLine(JsonSerializer.Serialize(entry))
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func IsEnabled(level LogLevel) bool -> true

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func LogDebug(message string, exception Exception? = nil) -> Log(LogLevel.Debug, message, exception)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func LogInfo(message string, exception Exception? = nil) -> Log(LogLevel.Info, message, exception)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func LogWarning(message string, exception Exception? = nil) -> Log(LogLevel.Warning, message, exception)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func LogError(message string, exception Exception? = nil) -> Log(LogLevel.Error, message, exception)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Dispose() {
        lock lockObj {
            if writer != nil {
                writer!!.Dispose()
                writer = nil
            }
        }
    }

    shared {
        private func ToLevelName(level LogLevel) string -> switch level {
            case LogLevel.Debug: "Debug"
            case LogLevel.Info: "Info"
            case LogLevel.Warning: "Warning"
            case LogLevel.Error: "Error"
            default: level.ToString()
        }
    }
}

internal data class AnonymousType5_E0A483F6BDB3ADA5(
    Timestamp DateTimeOffset,
    Level string,
    Message string,
    ExceptionType string?,
    Exception string?
) { }
