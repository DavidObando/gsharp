// <copyright file="Issue762MarshalAsInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Coverage for ADR-0096 / issue #762 — per-parameter
/// `@MarshalAs(UnmanagedType.…)` overrides on P/Invoke declarations in
/// the REPL. The GS0514 interpreter boundary pins retired with the
/// tree-walking evaluator (ADR-0156 Phase 3c, #3176; positive native-call
/// coverage lives in the PInvokeMarshalAs conformance sample); binder
/// diagnostics (GS0357–GS0360) for invalid declarations remain.
open class Issue762MarshalAsInterpreterTests {
    @Fact
    func MarshalAs_UnsupportedUnmanagedType_ReportsGS0357InRepl() {
        let source = `import System.Runtime.InteropServices

@DllImport("libfoo", EntryPoint: "x")
func native_x(@MarshalAs(UnmanagedType.CustomMarshaler) p int32) void;

Console.WriteLine("unreachable")`
        let output = RunSubmission(source)
        Assert.Contains("GS0357", output)
    }

    @Fact
    func MarshalAs_LPWStr_OnInt_ReportsGS0358InRepl() {
        let source = `import System.Runtime.InteropServices

@DllImport("libfoo", EntryPoint: "x")
func native_x(@MarshalAs(UnmanagedType.LPWStr) p int32) void;

Console.WriteLine("unreachable")`
        let output = RunSubmission(source)
        Assert.Contains("GS0358", output)
    }

    @Fact
    func MarshalAs_ByValTStr_WithoutSizeConst_ReportsGS0359InRepl() {
        let source = `import System.Runtime.InteropServices

@DllImport("libfoo", EntryPoint: "x")
func native_x(@MarshalAs(UnmanagedType.ByValTStr) s string) void;

Console.WriteLine("unreachable")`
        let output = RunSubmission(source)
        Assert.Contains("GS0359", output)
    }

    @Fact
    func MarshalAs_OnLibraryImportString_ReportsGS0360InRepl() {
        let source = `import System.Runtime.InteropServices

@LibraryImport("libfoo", EntryPoint: "x", StringMarshalling: StringMarshalling.Utf16)
func native_x(@MarshalAs(UnmanagedType.LPWStr) s string) void;

Console.WriteLine("unreachable")`
        let output = RunSubmission(source)
        Assert.Contains("GS0360", output)
    }

    @Fact
    func MarshalAs_OnNonPInvokeFunction_ReportsGS0360InRepl() {
        let source = `import System.Runtime.InteropServices

func managed(@MarshalAs(UnmanagedType.LPWStr) s string) void {
}

Console.WriteLine("unreachable")`
        let output = RunSubmission(source)
        Assert.Contains("GS0360", output)
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
