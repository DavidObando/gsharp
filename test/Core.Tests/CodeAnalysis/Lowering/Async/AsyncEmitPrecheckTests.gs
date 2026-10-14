// <copyright file="AsyncEmitPrecheckTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.IO
import System.Linq
import Xunit

/// Verifies the pre-emit gate that converts the historical
/// `InvalidProgramException`-at-runtime failure for async functions
/// into a clean compile-time diagnostic until the state-machine emitter
/// lands.
open class AsyncEmitPrecheckTests {
    @Fact
    func Check_NullProgram_ReturnsEmpty() {
        Assert.Empty(AsyncEmitPrecheck.Check(nil))
    }

    @Fact
    func Check_NoAsyncFunctions_ReturnsEmpty() {
        let source = `package main
import System
Console.WriteLine("hi")
`
        let program = Bind(source)
        Assert.Empty(AsyncEmitPrecheck.Check(program))
    }

    @Fact
    func Check_AsyncFunction_ReportsDiagnostic_WithExpectedMessage() {
        let source = `package main
async func doIt() {}
`
        let program = Bind(source)
        let diagnostics = AsyncEmitPrecheck.Check(program)
        let d = Assert.Single(diagnostics)
        Assert.Equal(AsyncEmitPrecheck.AsyncStateMachineUnavailableMessage, d.Message)
    }

    @Fact
    func Check_MultipleAsyncFunctions_OneDiagnosticEach() {
        let source = "package main\n" + "async func a() {}\n" + "async func b() int32 { return 1 }\n" + "func c() {}\n"
        let program = Bind(source)
        let diagnostics = AsyncEmitPrecheck.Check(program)
        Assert.Equal(2, diagnostics.Length)
    }

    @Fact
    func Compile_AsyncFunction_EmitsSuccessfully() {
        // Now that the kickoff body emitter is implemented, simple async
        // functions should compile without the precheck blocking them.
        let source = `package main
async func doIt() {}
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        Assert.True(result.Success, string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
    }

    @Fact
    func Compile_NonAsyncProgram_StillSucceeds() {
        let source = `package HelloWorld
import System
Console.WriteLine("hi")
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        Assert.True(
            result.Success,
            "non-async compilation must still succeed: " + string.Join(
                "; ",
                result.Diagnostics.Select((d Diagnostic) -> d.Message)
            )
        )
    }

    shared {
        private func Bind(source string) BoundProgram {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return Binder.BindProgram(compilation.GlobalScope)
        }
    }
}
