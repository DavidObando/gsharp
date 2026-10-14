// <copyright file="Issue710NullConditionalIndexingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #710 / ADR-0073 — emit coverage for the new `a?[i]`
/// null-conditional indexing operator. Each test compiles via in-process
/// `gsc`, IL-verifies the emitted PE, and runs it under
/// `dotnet exec`, asserting captured stdout. Covers slices, maps,
/// CLR indexers, and the receiver-evaluated-once invariant.
open class Issue710NullConditionalIndexingEmitTests {
    @Fact
    func Slice_NullReceiver_YieldsNil() {
        let source = `package Test
import System

func main() {
    var a []?int32 = nil
    var x = a?[0]
    if x == nil {
        Console.WriteLine("nil")
    } else {
        Console.WriteLine("notnil")
    }
}

main()`
        Assert.Equal("nil${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Slice_NonNullReceiver_YieldsLiftedValue() {
        let source = `package Test
import System

func main() {
    var a []?int32 = []int32{10, 20, 30}
    var x = a?[1]
    Console.WriteLine(x)
}

main()`
        Assert.Equal("20${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Map_NullReceiver_YieldsNil() {
        let source = `package Test
import System
import System.Collections.Generic

func main() {
    var d Dictionary[string, int32]? = nil
    var v = d?["k"]
    if v == nil {
        Console.WriteLine("nil")
    } else {
        Console.WriteLine("notnil")
    }
}

main()`
        Assert.Equal("nil${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Map_NonNullReceiver_YieldsLiftedValue() {
        let source = `package Test
import System
import System.Collections.Generic

func main() {
    var d Dictionary[string, int32]? = Dictionary[string, int32]()
    d!!.Add("a", 100)
    d!!.Add("b", 200)
    var v = d?["a"]
    Console.WriteLine(v)
}

main()`
        Assert.Equal("100${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func StringIndexer_ReferenceTypedResult_PropagatesNil() {
        // String[int] is a CLR indexer returning char. Use a Dictionary
        // returning string to exercise a reference-typed result through
        // `?[]` and confirm both the nil and non-nil paths.
        let source = `package Test
import System
import System.Collections.Generic

func main() {
    var d Dictionary[string, string]? = Dictionary[string, string]()
    d!!.Add("hi", "world")
    Console.WriteLine(d?["hi"])

    var d2 Dictionary[string, string]? = nil
    var v = d2?["hi"]
    if v == nil {
        Console.WriteLine("nil")
    }
}

main()`
        Assert.Equal("world${Environment.NewLine}nil${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Receiver_EvaluatedOnce_WhenNonNull() {
        // The receiver function is called once per `?[...]` site whether
        // or not it returns nil. The index sub-expression must not be
        // evaluated when the receiver is nil.
        let source = `package Test
import System

var receiverCalls int32 = 0
var indexCalls int32 = 0

func getSlice() []?int32 {
    receiverCalls = receiverCalls + 1
    return []int32{7, 8, 9}
}

func getNilSlice() []?int32 {
    receiverCalls = receiverCalls + 1
    return nil
}

func getIndex() int32 {
    indexCalls = indexCalls + 1
    return 1
}

func main() {
    // Non-nil receiver: receiver + 1, index + 1, value = 8.
    var x = getSlice()?[getIndex()]
    Console.WriteLine(x)
    Console.WriteLine(receiverCalls)
    Console.WriteLine(indexCalls)

    // Nil receiver: receiver + 1, index NOT evaluated, value = nil.
    var y = getNilSlice()?[getIndex()]
    if y == nil {
        Console.WriteLine("nil")
    }
    Console.WriteLine(receiverCalls)
    Console.WriteLine(indexCalls)
}

main()`
        // After the first `?[]`: receiver=1, index=1, x=8.
        // After the second `?[]`: receiver=2, index still 1, y=nil.
        Assert.Equal(
            "8${Environment.NewLine}1${Environment.NewLine}1${Environment.NewLine}nil${Environment.NewLine}2${Environment.NewLine}1${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func Chained_NullConditional_Member_Then_Index() {
        // `h?.Data?[0]` short-circuits at either segment.
        let source = `package Test
import System

class Holder {
    var Data []?int32
}

func main() {
    var h Holder? = Holder{Data: []int32{1, 2, 3}}
    var v = h?.Data?[1]
    Console.WriteLine(v)

    var hNoData Holder? = Holder{Data: nil}
    var v2 = hNoData?.Data?[0]
    if v2 == nil {
        Console.WriteLine("nil-data")
    }

    var hNil Holder? = nil
    var v3 = hNil?.Data?[0]
    if v3 == nil {
        Console.WriteLine("nil-holder")
    }
}

main()`
        Assert.Equal(
            "2${Environment.NewLine}nil-data${Environment.NewLine}nil-holder${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue710_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed (exit ` + "$compileExit" + `):
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`sample exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
