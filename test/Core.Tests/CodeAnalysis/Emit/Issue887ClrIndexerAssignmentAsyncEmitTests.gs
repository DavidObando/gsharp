// <copyright file="Issue887ClrIndexerAssignmentAsyncEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit
import Xunit.Abstractions

/// Issue #887: an index assignment through a member (e.g. `obj.Map["k"] = v`
/// on a `Dictionary`, or `psi.Environment["k"] = v`) inside a
/// state-machine method (`async func`, iterator, or async iterator)
/// previously failed at emit with GS9998
/// "Variable '<idxAsn#>' has no local slot or parameter index". The
/// synthesized index-assignment receiver temp was hoisted into a state-machine
/// field, but the index-assignment bound nodes keep their receiver as a raw
/// (cref:GSharp.Core.CodeAnalysis.Symbols.VariableSymbol) that the
/// MoveNext rewriters never redirected to the hoisted field. These tests verify
/// emit succeeds and the writes persist.
open class Issue887ClrIndexerAssignmentAsyncEmitTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Fact
    func MemberClrIndexerAssignment_InAsync_PersistsWrites() {
        let result = this.CompileAndRun(`package R
import System
import System.Collections.Generic
import System.Threading.Tasks

class Wrap { prop Map Dictionary[string,string]
    init(m Dictionary[string,string]) { Map = m }
}

async func run() string {
    let h = Dictionary[string,string]()
    let w = Wrap(h)
    w.Map["FOO"] = "1"
    w.Map["BAR"] = "2"
    await Task.Yield()
    return w.Map["FOO"] + w.Map["BAR"]
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
`, "Issue887Async")
        Assert.Contains("12", result)
    }

    @Fact
    func ProcessStartInfo_ObjectInitializer_AndEnvironmentIndexer_InAsync() {
        // The original repro shape from the issue: an object initializer block
        // followed by `psi.Environment[...] = ...` CLR-indexer writes, all inside
        // an async func.
        let result = this.CompileAndRun(`package R
import System
import System.Diagnostics
import System.Threading.Tasks

async func run() int32 {
    let psi = ProcessStartInfo("dotnet")
    {
        RedirectStandardOutput = true,
        UseShellExecute = false
    }
    psi.Environment["OAHU_NO_TUI"] = "1"
    psi.Environment["NO_COLOR"] = "1"
    await Task.Yield()
    Console.WriteLine(psi.Environment["OAHU_NO_TUI"] + psi.Environment["NO_COLOR"])
    return 0
}

var t = run()
t.Wait()
`, "Issue887Psi")
        Assert.Contains("11", result)
    }

    @Fact
    func MemberClrIndexerAssignment_InIterator_PersistsWrites() {
        let result = this.CompileAndRun(`package R
import System
import System.Collections.Generic

class Wrap { prop Map Dictionary[string,string]
    init(m Dictionary[string,string]) { Map = m }
}

func gen() sequence[int32] {
    let w = Wrap(Dictionary[string,string]())
    w.Map["FOO"] = "1"
    yield 1
    Console.WriteLine(w.Map["FOO"])
    yield 2
}

for x in gen() {
    Console.WriteLine(x)
}
`, "Issue887Iter")
        Assert.Contains("1", result)
    }

    @Fact
    func MemberClrIndexerAssignment_InAsyncIterator_Emits() {
        // Async iterator (IAsyncEnumerable) state machine: emit must succeed
        // when a hoisted receiver temp feeds a CLR-indexer write.
        using let peStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(`package R
import System
import System.Collections.Generic
import System.Threading.Tasks

class Wrap { prop Map Dictionary[string,string]
    init(m Dictionary[string,string]) { Map = m }
}

func gen() IAsyncEnumerable[int32] {
    let w = Wrap(Dictionary[string,string]())
    w.Map["FOO"] = "1"
    yield 1
    await Task.Yield()
    w.Map["BAR"] = "2"
    yield 2
}
`))
        let compilation = Compilation(tree)
        let result = compilation.Emit(peStream)
        for diagnostic in result.Diagnostics {
            this.output.WriteLine(diagnostic.ToString())
        }
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
    }

    private func CompileAndRun(source string, contextName string) string {
        using let peStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        let result = compilation.Emit(peStream)
        for diagnostic in result.Diagnostics {
            this.output.WriteLine(diagnostic.ToString())
        }
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        peStream.Position = 0
        let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
        try {
            let asm = loadContext.LoadFromStream(peStream)
            let programType = asm.GetTypes().First((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = programType.GetMethod(
                "<Main>$$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(entry)
            let stdout = Console.Out
            let captured = StringWriter()
            Console.SetOut(captured)
            try {
                entry!!.Invoke(
                    nil,
                    if entry!!.GetParameters().Length == 0 {
                        default([]?object)
                    } else {
                        []object{Array.Empty[string]()}
                    }
                )
            } finally {
                Console.SetOut(stdout)
            }
            return captured.ToString()
        } finally {
            loadContext.Unload()
        }
    }
}
