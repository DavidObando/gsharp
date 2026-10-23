// <copyright file="NarrowingComparison.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text
import System.Threading
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text

/// The comparison mode of ADR-0208 section 19, PR 1. When the environment
/// variable `GSHARP_NARROWING_COMPARE` names a file, the binder compares the
/// shadow join of the narrowing flow state with what the current passes lifted,
/// and records every disagreement. The mode reads the binder state and never
/// changes it, so the compiler output is the same with and without it.
/// @remarks Bodies bind in parallel, so entries collect under a lock. The file
/// is written once, at process exit, with the entries sorted by their text.
/// That order does not depend on thread timing. The join report goes to the
/// named file. The read report goes to the same name with the extension
/// `.reads`. A join line has the fields `file:line`, path, old type, new type
/// and row. A read line has the fields `file:line`, path, declared type,
/// shadow type and kind. A tab character separates the fields. A test can capture entries in
/// memory instead: (cref:BeginCapture) is local to the calling context.
internal shared class NarrowingComparison {
    private let gate object = Object()
    private let joinLines List[string] = List[string]()
    private let readLines List[string] = List[string]()
    private let environmentPath string? = ReadEnvironment()
    private let capture AsyncLocal[List[string]?] = AsyncLocal[List[string]?]()
    private let pending AsyncLocal[List[string]?] = AsyncLocal[List[string]?]()

    /// Whether the binder should compute the shadow flow.
    prop Enabled bool -> environmentPath != nil || capture.Value != nil

    /// Starts collecting entries in memory for a test, in the calling context.
    func BeginCapture() {
        capture.Value = List[string]()
    }

    /// Stops the capture and returns its entries, sorted. A join entry starts
    /// with `J` and a tab character. A read entry starts with `R` and a tab.
    func EndCapture() List[string] {
        let sink = capture.Value ?? List[string]()
        capture.Value = nil
        lock gate {
            return sink.Distinct().OrderBy((line string) -> line, StringComparer.Ordinal).ToList()
        }
    }

    /// Records a disagreement between the shadow join and the current passes.
    func ReportJoin(location string, path string, oldType string, newType string, row string) {
        Report(false, "${location}\t${path}\t${oldType}\t${newType}\t${row}")
    }

    /// Records a read whose type the shadow flow would narrow and the frames do not.
    /// The kind is `type-test` when the narrowed type differs from the declared
    /// non-null type, so member selection or an emitted cast can change. The kind
    /// is `nullability` when only the nil check differs.
    func ReportRead(location TextLocation?, path AccessPath, declaredType TypeSymbol, shadowType TypeSymbol) {
        let stripped = if declaredType is NullableTypeSymbol nullable {
            nullable.UnderlyingType
        } else {
            declaredType
        }
        let kind = if object.Equals(stripped, shadowType) {
            "nullability"
        } else {
            "type-test"
        }
        Report(true, "${Format(location)}\t${path}\t${declaredType}\t${shadowType}\t${kind}")
    }

    /// Formats a location as `file:line`, the line counted from 1.
    func Format(location TextLocation?) string {
        if location == nil {
            return "<unknown>:0"
        }
        let file = location.FileName ?? "<unknown>"
        return "${file}:${location.StartLine + 1}"
    }

    private func Report(isRead bool, line string) {
        Emit(
            if isRead {
                "R\t" + line
            } else {
                "J\t" + line
            }
        )
    }

    // A speculative bind buffers its reports until the binder decides whether to keep it.
    private func Emit(tagged string) {
        let buffer = pending.Value
        let sink = capture.Value
        lock gate {
            if buffer != nil {
                buffer.Add(tagged)
            } else if sink != nil {
                sink.Add(tagged)
            } else if tagged.StartsWith("R\t", StringComparison.Ordinal) {
                readLines.Add(tagged.Substring(2))
            } else {
                joinLines.Add(tagged.Substring(2))
            }
        }
    }

    /// Starts buffering reports for a bind that the binder may discard.
    func BeginSpeculation() NarrowingSpeculation? {
        if !Enabled {
            return nil
        }
        let speculation = NarrowingSpeculation(pending.Value, List[string]())
        pending.Value = speculation.Buffer
        return speculation
    }

    /// Ends the speculation. The buffered reports are kept or dropped together.
    func EndSpeculation(speculation NarrowingSpeculation?, keep bool) {
        if speculation == nil {
            return
        }
        pending.Value = speculation.Previous
        if keep {
            for tagged in speculation.Buffer {
                Emit(tagged)
            }
        }
    }

    /// Writes the report files. The compiler calls this at process exit.
    func Flush() {
        let path = environmentPath
        if path != nil {
            FlushTo(path)
        }
    }

    /// Writes both reports to [`path`](paramref) and `path.reads`. A run with no
    /// difference writes empty files, so a report of an earlier run cannot remain.
    func FlushTo(path string) {
        lock gate {
            WriteSorted(path, joinLines)
            WriteSorted(path + ".reads", readLines)
        }
    }

    private func WriteSorted(path string, lines List[string]) {
        let builder = StringBuilder()
        for line in lines.Distinct().OrderBy((text string) -> text, StringComparer.Ordinal) {
            builder.Append(line).Append('\n')
        }
        File.WriteAllText(path, builder.ToString())
    }

    private func ReadEnvironment() string? {
        let value = Environment.GetEnvironmentVariable("GSHARP_NARROWING_COMPARE")
        if string.IsNullOrWhiteSpace(value) {
            return nil
        }
        // The hook is set when comparison is enabled, so a clean run also writes its reports.
        AppDomain.CurrentDomain.ProcessExit += (sender object?, args EventArgs) -> Flush()
        return value
    }
}

/// The reports of one speculative bind, and the buffer to restore when it ends.
internal sealed class NarrowingSpeculation {
    init(previous List[string]?, buffer List[string]) {
        Previous = previous
        Buffer = buffer
    }

    prop Previous List[string]? {
        get;
    }

    prop Buffer List[string] {
        get;
    }
}
