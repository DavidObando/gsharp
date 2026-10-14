// <copyright file="Issue761PInvokeFunctionPointerInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Coverage for ADR-0095 / issue #761 — P/Invoke function-pointer
/// marshalling in the REPL. The GS0514 interpreter boundary pins retired
/// with the tree-walking evaluator (ADR-0156 Phase 3c, #3176); binder
/// diagnostics (GS0353–GS0356) for invalid declarations remain.
open class Issue761PInvokeFunctionPointerInterpreterTests {
    @Fact
    func DllImport_DelegateWithoutUnmanagedFunctionPointer_ReportsGS0353InRepl() {
        let source = `import System.Runtime.InteropServices

delegate Comparer(a nint, b nint) int32;

@DllImport("libc", EntryPoint: "qsort")
func native_qsort(base nint, nmemb nint, size nint, cmp Comparer) void;

Console.WriteLine("unreachable")`
        let output = RunSubmission(source)
        Assert.Contains("GS0353", output)
    }

    @Fact
    func DllImport_DelegateReturn_ReportsGS0355InRepl() {
        let source = `import System.Runtime.InteropServices

@UnmanagedFunctionPointer(CallingConvention.Cdecl)
delegate Callback() void;

@DllImport("libc", EntryPoint: "f")
func bad() Callback;

Console.WriteLine("unreachable")`
        let output = RunSubmission(source)
        Assert.Contains("GS0355", output)
    }

    @Fact
    func DllImport_UnknownCallingConvention_ReportsGS0354InRepl() {
        let source = `import System.Runtime.InteropServices

@DllImport("libc")
func bad(cb unmanaged[Garbage] () -> void) void;

Console.WriteLine("unreachable")`
        let output = RunSubmission(source)
        Assert.Contains("GS0354", output)
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
