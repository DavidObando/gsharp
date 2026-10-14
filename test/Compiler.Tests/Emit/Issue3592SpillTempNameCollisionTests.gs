// <copyright file="Issue3592SpillTempNameCollisionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #3592: a method body can pass through SEVERAL spiller passes — the
/// control-flow block lifter during general lowering, then the async await
/// spiller — and each started its `<>7__wrapN` ordinal at zero.
/// Two same-named locals with DIFFERENT types collided in the async state
/// machine, which maps hoisted locals to fields by name: a generic async
/// method whose if-expression arm throws before its trailing value stored the
/// await's `TResult` through the class-typed wrap field (ilverify
/// StackUnexpected; the migrated `GSharpLanguageServerRpc.InvokeAsync`
/// wall). Each pass now names its temps in a distinct domain.
open class Issue3592SpillTempNameCollisionTests {
    @Fact
    func GenericAsync_ThrowingIfExpressionArm_VerifiesAndRuns() {
        const Source = `package Issue3592

import System
import System.Threading.Tasks

class Rpc {
    async func Get[T](name string) T {
        await Task.Delay(1)
        return default(T)
    }
}

class Client {
    private var rpc Rpc? = nil
    private var ready bool = false

    internal func Attach(connection Rpc) {
        rpc = connection
        ready = true
    }

    internal async func Invoke[TResult](method string) TResult {
        var current Rpc
        current = if ready && rpc != nil { rpc!! } else { throw InvalidOperationException("not ready")
            default(Rpc) }
        return await current.Get[TResult](method)
    }
}

func Main() {
    let c = Client()
    c.Attach(Rpc())
    let n = c.Invoke[int32]("answer").GetAwaiter().GetResult()
    Console.WriteLine(n.ToString())
    let missing = Client()
    var threw = false
    try {
        missing.Invoke[int32]("nope").GetAwaiter().GetResult()
    } catch (ex InvalidOperationException) {
        threw = true
    }
    Console.WriteLine(threw.ToString())
}`
        Assert.Equal("0${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(Source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let outputDirectory = Path.Combine(AppContext.BaseDirectory, "issue3592spill", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(outputDirectory)
            try {
                let sourcePath = Path.Combine(outputDirectory, "Program.gs")
                let outputPath = Path.Combine(outputDirectory, "Issue3592Spill.dll")
                File.WriteAllText(sourcePath, source)
                using let standardOut = StringWriter()
                using let standardError = StringWriter()
                var previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(standardOut)
                Console.SetError(standardError)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$standardOut" + `
stderr:
` + "$standardError"))
                IlVerifier.Verify(outputPath)
                let assembly = EmittedFixture.Load(outputPath)
                let _ = assembly.GetTypes()
                let entryPoint = assembly.EntryPoint ??
                    throw InvalidOperationException("Emitted assembly has no entry point.")
                previousOut = Console.Out
                using let output = StringWriter()
                Console.SetOut(output)
                try {
                    entryPoint.Invoke(
                        nil,
                        if entryPoint.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(previousOut)
                }
                return output.ToString()
            } finally {
                try {
                    Directory.Delete(outputDirectory, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }
}
