// <copyright file="Issue759StructMarshallingEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #759: Emitted-session coverage for struct marshalling.
/// Traceability: ADR-0093; diagnostics GS0346 and GS0351.
open class Issue759StructMarshallingEmittedSessionTests {
    @Fact
    func Blittable_SequentialLayout_Struct_Binds_And_Runs_In_EmittedSession() {
        let source = `import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var X int32
    var Y int32
}

var p = Point{X: 3, Y: 4}
Console.WriteLine(p.X)
Console.WriteLine(p.Y)`
        let output = RunSubmission(source)
        Assert.Contains("3", output)
        Assert.Contains("4", output)
        Assert.DoesNotContain("GS0346", output)
        Assert.DoesNotContain("GS0347", output)
        Assert.DoesNotContain("GS0348", output)
        Assert.DoesNotContain("GS0349", output)
        Assert.DoesNotContain("GS0350", output)
        Assert.DoesNotContain("GS0351", output)
    }

    @Fact
    func Explicit_StructLayout_With_FieldOffsets_Binds_In_EmittedSession() {
        let source = `import System.Runtime.InteropServices

@StructLayout(LayoutKind.Explicit, Size: 8)
struct LargeInteger {
    @FieldOffset(0) var LowPart uint32
    @FieldOffset(4) var HighPart int32
    @FieldOffset(0) var QuadPart int64
}

Console.WriteLine("bound")`
        let output = RunSubmission(source)
        Assert.Contains("bound", output)
        Assert.DoesNotContain("GS0346", output)
        Assert.DoesNotContain("GS0347", output)
        Assert.DoesNotContain("GS0348", output)
        Assert.DoesNotContain("GS0350", output)
    }

    @Fact
    func Auto_LayoutKind_Reports_GS0346_Under_EmittedSession() {
        let source = `import System.Runtime.InteropServices

@StructLayout(LayoutKind.Auto)
struct Bad {
    var X int32
}`
        let output = RunSubmission(source)
        Assert.Contains("GS0346", output)
    }

    @Fact
    func FieldOffset_On_Sequential_Reports_GS0348_Under_EmittedSession() {
        let source = `import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Bad {
    @FieldOffset(0) var X int32
    @FieldOffset(4) var Y int32
}`
        let output = RunSubmission(source)
        Assert.Contains("GS0348", output)
    }

    @Fact
    func NonBlittable_Struct_In_PInvoke_Reports_GS0349_Under_EmittedSession() {
        let source = `import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Bad {
    var Name string
}

@DllImport("libc", EntryPoint: "nope")
func Nope(arg Bad) int32;`
        let output = RunSubmission(source)
        Assert.Contains("GS0349", output)
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
