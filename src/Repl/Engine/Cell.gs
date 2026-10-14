// <copyright file="Cell.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Engine

import GSharp.Core.CodeAnalysis
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO

/// One transcript entry: input plus its result, captured console output, or diagnostics.
data class Cell(
    Index int32,
    Input string,
    Value object?,
    Diagnostics ImmutableArray[GSharp.Core.CodeAnalysis.Diagnostic],
    HasError bool,
    Output string = "",
    StandardError string = ""
) : IEquatable[Cell] { }

/// A single entry in the REPL state sidebar, rendered via the shared `SymbolDisplay` service.
data class ReplSymbol(Display string) : IEquatable[ReplSymbol] { }

/// Snapshot of the accumulated REPL session: imports, functions, variables, and user types.
data class ReplState(
    Imports IReadOnlyList[ReplSymbol],
    Functions IReadOnlyList[ReplSymbol],
    Variables IReadOnlyList[ReplSymbol],
    Types IReadOnlyList[ReplSymbol]
) : IEquatable[ReplState] {
    prop IsEmpty bool -> Imports.Count == 0 && Functions.Count == 0 && Variables.Count == 0 && Types.Count == 0

    shared {
        private let _empty ReplState = ReplState(
            Array.Empty[ReplSymbol](),
            Array.Empty[ReplSymbol](),
            Array.Empty[ReplSymbol](),
            Array.Empty[ReplSymbol]()
        )

        prop Empty ReplState {
            get {
                return _empty
            }
        }
    }
}

/// A (cref:TextReader) that sources whole lines from a callback, letting the interactive
/// REPL prompt the user on demand when evaluated code reads from (cref:Console.In).
internal class CallbackTextReader : TextReader {
    private let readLine() -> string?
    private var buffer string?
    private var bufferPos int32

    init(readLine() -> string?) {
        this.readLine = readLine ?? throw ArgumentNullException("readLine")
    }

    override func ReadLine() string? -> readLine()

    override func Peek() int32 -> if EnsureBuffer() {
        int32(buffer!![bufferPos])
    } else {
        -1
    }

    override func Read() int32 {
        if !EnsureBuffer() {
            return -1
        }
        let ch = buffer!![bufferPos++]
        if bufferPos >= buffer!!.Length {
            buffer = nil
        }
        return ch
    }

    private func EnsureBuffer() bool {
        if buffer != nil && bufferPos < buffer!!.Length {
            return true
        }
        let line string? = readLine()
        if line == nil {
            return false
        }
        buffer = line + "\n"
        bufferPos = 0
        return true
    }
}
