// <copyright file="Issue760PInvokeRefOutInInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Coverage for ADR-0094 / issue #760 — P/Invoke
/// `ref`/`out`/`in` parameter marshalling in the REPL. The
/// GS0514 interpreter boundary pins retired with the tree-walking evaluator
/// (ADR-0156 Phase 3c, #3176) — ref/out/in P/Invoke runs natively on the
/// emitted engine, with positive native-call coverage in the
/// PInvokeRefOutIn conformance sample. Binder diagnostics for invalid
/// declarations remain.
open class Issue760PInvokeRefOutInInterpreterTests {
    @Fact
    func DllImport_RefString_StillProducesBinderDiagnostic() {
        // GS0352 fires before the interpreter ever evaluates the submission.
        // The REPL renders diagnostics into stdout via WriteDiagnostics, so
        // the GS0352 code appears in the captured output stream.
        let source = `import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "native_str")
func native_str(ref s string) int32;

Console.WriteLine("unreachable")`
        let output = RunSubmission(source)
        Assert.Contains("GS0352", output)
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
