// <copyright file="Issue2988DeinitInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Repl
import GSharp.Repl.Engine
import System
import System.Collections.Generic
import System.IO
import Xunit

/// Coverage for CLR GC finalizers declared with `deinit`. The GS0510
/// interpreter-boundary warning ("deinitializer will not run under the
/// interpreter") retired with the tree-walking evaluator in ADR-0156 Phase 3c
/// (#3176): every driver executes emitted code and runs deinitializers as
/// real CLR finalizers, so the remaining tests assert positive finalizer
/// behavior — including that a still-reachable instance's deinitializer does
/// NOT run — with no boundary diagnostic anywhere.
@Collection("ConsoleIo")
open class Issue2988DeinitInterpreterTests {
    /// ADR-0156 Phase 1: bare `gsc` and script-mode `gsi` execute
    /// emitted code, so deinitializers run as real CLR finalizers on every
    /// driver — derived-then-base, per declaring class — and no GS0510
    /// boundary warning fires on any of them.
    /// @param driver The driver under test.
    @Theory
    @InlineData(Issue3010EntryPointDriverMatrixTests.Driver(0))
    @InlineData(Issue3010EntryPointDriverMatrixTests.Driver(1))
    @InlineData(Issue3010EntryPointDriverMatrixTests.Driver(2))
    func InheritedDeinitializersRunOnEveryDriver(driver Issue3010EntryPointDriverMatrixTests.Driver) {
        const Source = `import System

open class Resource(Tag string) {
    deinit {
        Console.WriteLine("base-deinit-11")
    }
}

class CachedResource : Resource {
    init(tag string) : base(tag) {
    }

    deinit {
        Console.WriteLine("derived-deinit-22")
    }
}

func Allocate() {
    var resource = CachedResource("held-33")
    Console.WriteLine("body-44")
    GC.KeepAlive(resource)
}

Allocate()
GC.Collect()
GC.WaitForPendingFinalizers()
Console.WriteLine("end-55")`
        let emittedOutput = "body-44${Environment.NewLine}derived-deinit-22${Environment.NewLine}base-deinit-11${Environment.NewLine}end-55${Environment.NewLine}"
        let result = Issue3010EntryPointDriverMatrixTests.Run("inherited-deinit-" + driver.ToString(), Source, driver)
        Assert.Equal(0, result.ExitCode)
        let expectedOutput = if driver == Issue3010EntryPointDriverMatrixTests.Driver.BareCompiler {
            emittedOutput + "Success.${Environment.NewLine}"
        } else {
            emittedOutput
        }
        Assert.Equal(expectedOutput, result.StandardOutput)
        Assert.Equal(string.Empty, result.StandardError)
        Assert.DoesNotContain("GS0510", result.StandardOutput + result.StandardError, StringComparison.Ordinal)
    }

    @Fact
    func ReachableInstanceDoesNotRunDeinitializer() {
        // Historically also pinned the evaluator's GS0510 warning; the
        // engine-independent core survives emitted: a still-reachable
        // instance's deinitializer must not run, even across a forced
        // collection (ADR-0156 Phase 3c, #3176). The deinit records into a
        // counter rather than printing so that the finalizer — which runs on
        // the process-global finalizer thread when the session ALC is later
        // reclaimed — can never leak output into another test's captured
        // console.
        let source = `import System

class Res(Tag string) {
    shared {
        var Runs int32
    }

    deinit {
        Res.Runs = Res.Runs + 1
    }
}

func Make() Res {
    var r = Res("kept")
    Console.WriteLine("made-22")
    return r
}

var held = Make()
GC.Collect()
GC.WaitForPendingFinalizers()
Console.WriteLine("after-collect-33")
Console.WriteLine(held.Tag)`
        using let engine = EmittedSessionEngine(default(IReadOnlyList[string])){CaptureConsole = true}
        let cell = engine.Evaluate(source)
        Assert.False(cell.HasError)
        Assert.Equal(
            "made-22${Environment.NewLine}after-collect-33${Environment.NewLine}kept${Environment.NewLine}",
            cell.Output.ReplaceLineEndings(Environment.NewLine)
        )
        Assert.DoesNotContain(
            cell.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0510"
        )
        let counterRead = engine.Evaluate("Res.Runs")
        Assert.False(counterRead.HasError)
        Assert.Equal(0, counterRead.Value)
    }

    /// ADR-0156 Phase 1: script-mode `gsi` runs emitted code, so a class
    /// deinitializer executes as a real CLR finalizer — asserted positively by
    /// forcing a collection — with no boundary warning.
    @Fact
    func ScriptRunnerRunsDeinitializersWithoutBoundaryWarning() {
        let sourcePath = Path.Combine(AppContext.BaseDirectory, "issue2988-deinit.gs")
        File.WriteAllText(sourcePath, `import System

class Resource {
    deinit {
        Console.WriteLine("deinit-ran-22")
    }
}

func Allocate() {
    var resource = Resource()
    GC.KeepAlive(resource)
}

Allocate()
GC.Collect()
GC.WaitForPendingFinalizers()
Console.WriteLine("body-33")`)
        let previousOut = Console.Out
        let previousError = Console.Error
        using let output = StringWriter{NewLine: Environment.NewLine}
        using let error = StringWriter{NewLine: Environment.NewLine}
        Console.SetOut(output)
        Console.SetError(error)
        try {
            let exitCode = GSharp.Repl.Program.Main([]string{sourcePath})
            Assert.Equal(0, exitCode)
            Assert.Equal("deinit-ran-22${Environment.NewLine}body-33${Environment.NewLine}", output.ToString())
            Assert.Equal(string.Empty, error.ToString())
        } finally {
            Console.SetOut(previousOut)
            Console.SetError(previousError)
            File.Delete(sourcePath)
        }
    }
}
