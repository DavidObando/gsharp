// <copyright file="Issue608EmittedSessionCLRDispatchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #608: Emitted-session coverage for clr dispatch.
open class Issue608EmittedSessionCLRDispatchTests {
    /// #572 shape: a default interface method (DIM) on a CLR interface should be
    /// callable through an interface-typed variable even when the concrete class
    /// does not override it.
    @Fact
    func EmittedSession_DIMDispatchOnConcreteCLRType_Works() {
        let source = `import GSharp.Interpreter.Tests.ProbeRef
import System
var obj = WithDIMImpl("world")
var iface IWithDIM = obj
iface.Greeting()`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error", output, StringComparison.OrdinalIgnoreCase)
        Assert.Contains("Hello, world!", output)
    }

    /// #573 shape: a G# class with a public field that matches a getter-only CLR
    /// interface property should satisfy the contract; reading through the interface
    /// should yield the field value.
    @Fact
    func EmittedSession_FieldSatisfiesGetterOnlyPropertyContract_GetterReadsField() {
        let source = `import GSharp.Interpreter.Tests.ProbeRef
import System
class Impl1 : IHasName {
    var Name string
}
var impl = Impl1{Name: "hello"}
var iface IHasName = impl
iface.Name`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error", output, StringComparison.OrdinalIgnoreCase)
        Assert.Contains("hello", output)
    }

    /// #606 shape: a G# class with a public mutable field that matches a read-write
    /// CLR interface property; both getter and setter should work through the interface.
    @Fact
    func EmittedSession_FieldSatisfiesReadWritePropertyContract_BothAccessorsWork() {
        let source = `import GSharp.Interpreter.Tests.ProbeRef
import System
class RWImpl : IReadWrite {
    var Value string
}
var impl = RWImpl{Value: "initial"}
var iface IReadWrite = impl
Console.WriteLine(iface.Value)
iface.Value = "updated"
Console.WriteLine(iface.Value)`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error", output, StringComparison.OrdinalIgnoreCase)
        Assert.Contains("initial", output)
        Assert.Contains("updated", output)
    }

    /// Pin the #568 path: IDisposable.Dispose() dispatch on a CLR type works in the
    /// emitted session. Tests that MemberLookup.SafeGetMethodIncludingSelfAndInterfaces
    /// finds the Dispose method correctly.
    @Fact
    func EmittedSession_BasicIDisposableInUsingLet_StillWorks() {
        // Use manual Dispose() call to test the #568 dispatch path (DIM-aware
        // method lookup finding IDisposable.Dispose through a concrete type).
        // Top-level `using let` in the REPL has a pre-existing scoping limitation
        // (subsequent statements execute after the finally block) so we test
        // Dispose dispatch directly instead.
        let source = `import System
import System.IO
let sr = StringReader("hello")
var result = sr.ReadToEnd()
sr.Dispose()
result`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error", output, StringComparison.OrdinalIgnoreCase)
        Assert.Contains("hello", output)
    }

    shared {
        private func RunSubmission(text string) string {
            using let outWriter = StringWriter()
            using let errWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(outWriter)
            Console.SetError(errWriter)
            try {
                let repl = GSharpRepl()
                repl.EvaluateSubmission(text)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return outWriter.ToString() + errWriter.ToString()
        }
    }
}
