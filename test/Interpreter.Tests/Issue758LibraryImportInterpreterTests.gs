// <copyright file="Issue758LibraryImportInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// ADR-0092 / issue #758: coverage for the `@LibraryImport`
/// source-generator-shaped P/Invoke attribute in the REPL. The GS0514
/// interpreter boundary pins retired with the tree-walking evaluator
/// (ADR-0156 Phase 3c, #3176) — P/Invoke runs natively on the emitted
/// engine, with positive native-call coverage in the PInvoke* conformance
/// samples. Binder diagnostics for invalid declarations remain.
open class Issue758LibraryImportInterpreterTests {
    @Fact
    func LibraryImport_PoorlyTypedSurface_StillProducesBinderDiagnostics() {
        // GS0344: a string-bearing LibraryImport without StringMarshalling
        // is rejected by the binder before the interpreter ever evaluates
        // the submission. The REPL renders diagnostics into stdout via
        // WriteDiagnostics, so the GS0344 code appears in the captured
        // output stream.
        let source = `import System.Runtime.InteropServices

@LibraryImport("libc")
func strlen_native(text string) nint;

Console.WriteLine(strlen_native("hi"))`
        let output = RunSubmission(source)
        Assert.Contains("GS0344", output)
    }

    shared {
        private func RunSubmission(text string) string {
            using let outWriter = StringWriter()
            let prevOut = Console.Out
            Console.SetOut(outWriter)
            try {
                let repl = GSharpRepl()
                repl.EvaluateSubmission(text)
            } finally {
                Console.SetOut(prevOut)
            }
            return outWriter.ToString()
        }
    }
}
