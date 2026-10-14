// <copyright file="AttributeEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Emitted-session coverage for attribute.
/// Traceability: ADR-0047; issue #141; diagnostic GS0204.
open class AttributeEmittedSessionTests {
    @Fact
    func EmittedSession_Accepts_Obsolete_Annotation_On_Function() {
        // @Obsolete on the declaration parses and binds; calling Helper()
        // is a use site so the GS0204 warning fires, but the value still
        // evaluates and prints (warnings do not block evaluation).
        let source = `@Obsolete
func Helper() int32 {
  return 42
}
Helper()`
        let output = RunSubmission(source)
        Assert.Contains("42", output)
        Assert.Contains("warning GS0204", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func EmittedSession_Reports_Obsolete_Warning_At_Call_Site_And_Continues() {
        let source = `@Obsolete("use Bar")
func Old() int32 {
  return 7
}
Old()`
        let output = RunSubmission(source)
        Assert.Contains("GS0204", output)
        Assert.Contains("use Bar", output)
        Assert.Contains("7", output)
    }

    @Fact
    func EmittedSession_Reports_Obsolete_Error_When_IsError_Is_True() {
        let source = `@Obsolete("dead", true)
func Old() int32 {
  return 1
}
Old()`
        let output = RunSubmission(source)
        Assert.Contains("GS0204", output)
        Assert.Contains("error GS0204", output)
    }

    @Fact
    func EmittedSession_Rejects_Reserved_CompilerGenerated_Attribute() {
        let source = `import System.Runtime.CompilerServices
@CompilerGenerated
func Helper() {
}
`
        let output = RunSubmission(source)
        Assert.Contains("GS0205", output)
    }

    @Fact
    func EmittedSession_Accepts_AttributeSugar_Class_Declaration() {
        let source = `import System
@Attribute
class Trace {
}
`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func EmittedSession_Reports_Obsolete_Warning_On_Struct_Field_Read() {
        // Issue #186: reading an `@Obsolete` field surfaces GS0204 at the
        // use site; the value still evaluates and prints.
        let source = `data struct Point {
  @Obsolete("use NewX")
  var X int32
  var Y int32
}
let p = Point{ X: 1, Y: 2 }
p.X`
        let output = RunSubmission(source)
        Assert.Contains("warning GS0204", output)
        Assert.Contains("Point.X", output)
        Assert.Contains("use NewX", output)
        Assert.DoesNotContain("error GS", output)
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
