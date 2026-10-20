package Gsharp.NET.Sdk.Tools

import System
import System.Collections.Generic
import System.IO
import System.Text
import System.Threading
import SystemObject = System.Object

/// Captures inherited OS diagnostics independently from the private protocol.
internal class WorkerDiagnosticCapture : IDisposable {
    private let gate object = SystemObject()
    private let input StreamReader
    private let stop() -> void
    private let reader Thread
    private let ready ManualResetEventSlim = ManualResetEventSlim()
    private let lines List[string] = List[string]()
    private let line StringBuilder = StringBuilder()
    private var marker string = string.Empty
    private var failure Exception?
    private var count int32
    private var carriageReturn bool
    private var disposed bool

    init(input StreamReader, stop() -> void, initialFence string = "") {
        this.input = input
        this.stop = stop
        marker = initialFence
        reader = Thread(Read)
        reader.IsBackground = true
        reader.Start()
    }

    internal func Begin(fence string) {
        lock gate {
            marker = fence
            ready.Reset()
        }
    }

    internal func FailureMessage() string? {
        lock gate {
            return failure?.Message
        }
    }

    internal func Complete(cancellation CancellationToken, report(string) -> void) bool {
        if !ready.Wait(30000, cancellation) {
            throw IOException("Worker inherited diagnostic stream did not reach its completion fence.")
        }
        var captured[]string
        lock gate {
            if failure is {} error {
                throw IOException("Worker inherited diagnostic stream failed: ${error.Message}", error)
            }
            captured = lines.ToArray()
            lines.Clear()
            count = 0
        }
        for text in captured {
            report(text)
        }
        return captured.Length != 0
    }

    internal func DrainFailure(report(string) -> void) {
        reader.Join(1000)
        var captured[]string
        lock gate {
            if line.Length > 0 {
                lines.Add(line.ToString())
                line.Clear()
            }
            captured = lines.ToArray()
            lines.Clear()
            count = 0
        }
        for text in captured {
            report(text)
        }
    }

    private func Read() {
        try {
            while true {
                let next = input.Read()
                if next < 0 {
                    lock gate {
                        if marker.Length == 0 {
                            return
                        }
                    }
                    throw EndOfStreamException("Worker inherited diagnostic stream closed before its fence.")
                }
                lock gate {
                    let value = char(next)
                    line.Append(value)
                    count++
                    if count > 16 * 1024 * 1024 {
                        throw InvalidDataException("Worker inherited diagnostics exceed the protocol limit.")
                    }
                    if marker.Length > 0 && EndsWithMarker() {
                        line.Length -= marker.Length
                        if line.Length > 0 {
                            lines.Add(line.ToString())
                        }
                        line.Clear()
                        marker = string.Empty
                        carriageReturn = false
                        ready.Set()
                    } else if value == '\r' || value == '\n' {
                        line.Length--
                        if value != '\n' || !carriageReturn {
                            lines.Add(line.ToString())
                        }
                        line.Clear()
                        carriageReturn = value == '\r'
                    } else {
                        carriageReturn = false
                    }
                }
            }
        } catch (ex Exception) when ex is IOException || ex is InvalidDataException || ex is InvalidOperationException {
            lock gate {
                if !disposed {
                    failure = ex
                    ready.Set()
                    stop()
                }
            }
        }
    }

    private func EndsWithMarker() bool {
        if line.Length < marker.Length {
            return false
        }
        for var i = 0; i < marker.Length; i++ {
            if line[line.Length - marker.Length + i] != marker[i] {
                return false
            }
        }
        return true
    }

    func Dispose() {
        lock gate {
            disposed = true
        }
        input.Dispose()
        reader.Join(1000)
        ready.Dispose()
    }
}
