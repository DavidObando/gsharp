// <copyright file="SourceText.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Text

import System.Collections.Immutable

/// The source text of the compilation target. Represents the document.
class SourceText {
    private let text string

    private init(text string, fileName string, rawBytes[]?uint8) {
        this.text = text
        FileName = fileName
        RawBytes = rawBytes
        Lines = ParseLines(this, text)
    }

    /// Gets the exact bytes this document was loaded from on disk, when it was
    /// loaded from a file; otherwise `null`. Debuggers compute the source
    /// checksum over these raw bytes (including any byte-order mark), so the PDB
    /// document hash must be derived from them — not from a re-encoded copy of
    /// the decoded text — for on-disk source resolution to succeed.
    prop RawBytes[]?uint8 {
        get;
    }

    /// Gets the set of lines contained by this document.
    prop Lines ImmutableArray[TextLine] {
        get;
    }

    /// Gets the length of the document.
    prop Length int32 -> text.Length

    /// Gets the file name.
    prop FileName string {
        get;
    }

    /// Gets the character at the specified document index.
    /// @param index The document index.
    /// @returns The character at that index position in the document.
    prop this[index int32]char -> text[index]

    /// Gets the line index at the specified position in the document.
    /// @param position The position in the document.
    /// @returns The line number for the specified index in the document.
    func GetLineIndex(position int32) int32 {
        var lower = 0
        var upper = Lines.Length - 1
        while lower <= upper {
            let index = lower + ((upper - lower) / 2)
            let start = Lines[index].Start
            if position == start {
                return index
            }
            if start > position {
                upper = index - 1
            } else {
                lower = index + 1
            }
        }
        return lower - 1
    }

    /// Returns the document represented by this source text.
    /// @returns The underlying document.
    override func ToString() string -> text

    /// Returns a subset of the document represented by this source text.
    /// @param start Start index.
    /// @param length Length.
    /// @returns A subset of the underlying document.
    func ToString(start int32, length int32) string {
        var start = start
        var length = length
        if start < 0 {
            start = 0
        }
        if start > text.Length {
            start = text.Length
        }
        if length < 0 {
            length = 0
        }
        if start + length > text.Length {
            length = text.Length - start
        }
        return text.Substring(start, length)
    }

    /// Returns a subset of the document represented by this source text.
    /// @param span The span to include.
    /// @returns A subset of the underlying document.
    func ToString(span TextSpan) string -> ToString(span.Start, span.Length)

    shared {
        /// Creates a source text document from a string.
        /// @param text The string to wrap with a source text.
        /// @param fileName Optional. The file name associated to this source text.
        /// @param rawBytes Optional. The exact on-disk bytes the text was decoded from. Supplied when
        /// the document originates from a file so the PDB source checksum matches the
        /// bytes a debugger hashes.
        /// @returns A hydrated source text instance.
        func From(text string, fileName string = "", rawBytes[]?uint8 = nil) SourceText {
            return SourceText(text, fileName, rawBytes)
        }

        private func ParseLines(sourceText SourceText, text string) ImmutableArray[TextLine] {
            let result = ImmutableArray.CreateBuilder[TextLine]()
            var position = 0
            var lineStart = 0
            while position < text.Length {
                let lineBreakWidth = GetLineBreakWidth(text, position)
                if lineBreakWidth == 0 {
                    position++
                } else {
                    AddLine(result, sourceText, position, lineStart, lineBreakWidth)
                    position += lineBreakWidth
                    lineStart = position
                }
            }
            if position >= lineStart {
                AddLine(result, sourceText, position, lineStart, 0)
            }
            return result.ToImmutable()
        }

        private func AddLine(
            result ImmutableArray[TextLine].Builder,
            sourceText SourceText,
            position int32,
            lineStart int32,
            lineBreakWidth int32
        ) {
            let lineLength = position - lineStart
            let lineLengthIncludingLineBreak = lineLength + lineBreakWidth
            let line = TextLine(sourceText, lineStart, lineLength, lineLengthIncludingLineBreak)
            result.Add(line)
        }

        private func GetLineBreakWidth(text string, position int32) int32 {
            let c = text[position]
            let l = if position + 1 >= text.Length {
                '\u0000'
            } else {
                text[position + 1]
            }
            if c == '\r' && l == '\n' {
                return 2
            }
            if c == '\r' || c == '\n' {
                return 1
            }
            return 0
        }
    }
}
