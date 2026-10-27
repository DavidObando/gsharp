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
    private let loopLines List[string] = List[string]()
    private let spanFunctions HashSet[string] = HashSet[string]()
    private let captureSpanFunctions AsyncLocal[HashSet[string]?] = AsyncLocal[HashSet[string]?]()
    // The span registrations of the speculative binds that are open, innermost last.
    private let speculationKeys AsyncLocal[List[HashSet[string]]?] = AsyncLocal[List[HashSet[string]]?]()
    private let environmentPath string? = ReadEnvironment()
    private let capture AsyncLocal[List[string]?] = AsyncLocal[List[string]?]()
    private let pending AsyncLocal[List[string]?] = AsyncLocal[List[string]?]()

    /// Whether the binder should compute the shadow flow.
    prop Enabled bool -> environmentPath != nil || capture.Value != nil

    /// Whether the binder should compute the loop report of ADR-0213 section 20, slice L0. It is
    /// on whenever the comparison mode is, and it reads the binder state like the other reports.
    prop LoopsEnabled bool -> Enabled

    /// Starts collecting entries in memory for a test, in the calling context.
    func BeginCapture() {
        capture.Value = List[string]()
        captureSpanFunctions.Value = HashSet[string]()
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

    /// Records a loop entry fact on which the walker of ADR-0213 and today's back-edge analysis
    /// disagree. The fields are `file:line`, the path, the fact kind (`nullability` or
    /// `type-test`), the disagreement (`old-kept/new-killed` or `old-killed/new-kept`), the rule
    /// (W1 to W8, P7 or A3 with a detail) and the row of ADR-0213 section 16.
    func ReportLoopDisagreement(
        location TextLocation?,
        path string,
        factKind string,
        disagreement string,
        rule string,
        row string
    ) {
        Emit("L\t${Format(location)}\t${path}\t${factKind}\t${disagreement}\t${rule}\t${row}")
    }

    /// Records the facts of a loop as counts, so a reader can tell a loop with no disagreement from
    /// a loop the report never saw. The fields are `file:line`, the number of facts, the number
    /// killed by both, the number kept by both and a description of the walk.
    func ReportLoopSummary(location TextLocation?, facts int32, killedByBoth int32, keptByBoth int32, walk string) {
        Emit("T\t${Format(location)}\t${facts}\t${killedByBoth}\t${keptByBoth}\t${walk}")
    }

    /// Records a backward-jump span of a function: its labels and the effects the walker finds in it.
    func ReportSpan(location TextLocation?, labels string, effects string) {
        Emit("S\t${Format(location)}\t${labels}\t${effects}")
    }

    /// Records a fact that the header of a loop proves on exit and that the entry state lacks
    /// (ADR-0213 row R7 (f)). The last field lists the `!!` sites after the loop on the same path.
    func ReportLoopExitGain(location TextLocation?, path string, hasBreak bool, bangSites string) {
        let breakText = if hasBreak {
            "break"
        } else {
            "no-break"
        }
        Emit("X\t${Format(location)}\t${path}\t${breakText}\t${bangSites}")
    }

    /// Whether this is the first request for the function with this key. A function that has
    /// several labels asks once per label, and the span counts once. A registration made in a
    /// speculative bind is kept or dropped with the reports of that bind, so a bind that is
    /// discarded and repeated reports the span again, and the counter counts a span when it commits.
    func TryRegisterSpanFunction(key string) bool {
        lock gate {
            let committed = captureSpanFunctions.Value ?? spanFunctions
            if committed.Contains(key) {
                return false
            }
            let levels = speculationKeys.Value
            if levels != nil && levels.Count > 0 {
                for keys in levels {
                    if keys.Contains(key) {
                        return false
                    }
                }
                levels[levels.Count - 1].Add(key)
                return true
            }
            committed.Add(key)
            CompilationMeasurements.Count("narrowing.spans")
            return true
        }
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
            } else if !tagged.StartsWith("J\t", StringComparison.Ordinal) {
                loopLines.Add(tagged)
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
        lock gate {
            let levels = speculationKeys.Value ?? List[HashSet[string]]()
            levels.Add(HashSet[string]())
            speculationKeys.Value = levels
        }
        return speculation
    }

    /// Ends the speculation. The buffered reports are kept or dropped together.
    func EndSpeculation(speculation NarrowingSpeculation?, keep bool) {
        if speculation == nil {
            return
        }
        pending.Value = speculation.Previous
        lock gate {
            let levels = speculationKeys.Value
            if levels != nil && levels.Count > 0 {
                let keys = levels[levels.Count - 1]
                levels.RemoveAt(levels.Count - 1)
                if keep {
                    // The registrations commit with the reports: into the enclosing bind, or for good.
                    let committed = captureSpanFunctions.Value ?? spanFunctions
                    for key in keys.OrderBy((text string) -> text, StringComparer.Ordinal) {
                        if levels.Count > 0 {
                            levels[levels.Count - 1].Add(key)
                        } else if committed.Add(key) {
                            CompilationMeasurements.Count("narrowing.spans")
                        }
                    }
                }
            }
        }
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

    /// Writes the reports to [`path`](paramref), `path.reads` and `path.loops`. A run with no
    /// difference writes empty files, so a report of an earlier run cannot remain.
    func FlushTo(path string) {
        lock gate {
            WriteSorted(path, joinLines)
            WriteSorted(path + ".reads", readLines)
            WriteSorted(path + ".loops", loopLines)
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
