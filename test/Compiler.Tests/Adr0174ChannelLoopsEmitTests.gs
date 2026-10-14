// <copyright file="Adr0174ChannelLoopsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// ADR-0174 D3 through the real driver: `gsc` emits a program that uses
/// `for v in ch`, `while let v = <-ch` and the two-value receive;
/// the assembly passes ILVerify (the lowering reuses the tuple, declaration,
/// goto and label nodes, so any stack or scope mistake in the new shapes would
/// surface here); and the program's own output pins the semantics — drain to
/// close, a delivered `nil` element, and the `ok` flag.
open class Adr0174ChannelLoopsEmitTests {
    /// Compiles each case to an executable, IL-verifies it, runs it, and
    /// asserts the program's own output.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func ChannelLoops_CompileVerifyAndRun(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_0174_loops_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(srcPath, source)
            let outPath = Path.Combine(tempDir, name + ".dll")
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
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
            Assert.True(compileExit == 0, (`gsc failed for '` + "$name" + `':
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            let (exit, output) = RunDotnet(outPath)
            Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal(expectedLines, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// Gets the executable cases: each is (name, source, expected stdout lines).
        /// @returns The case data.
        func Cases() sequence[[]object] {
            yield[]object{"for-in-drains-a-goroutine-producer", `package P
import System

func produce(w out chan[int32], n int32) {
    for i in 1 ... n {
        w <- i
    }
    w.Close()
}

let ch = chan[int32](2)
go produce(ch, 6)
var sum = 0
for v in ch {
    sum = sum + v
}
Console.WriteLine(sum)`, []string{"15"}}
            yield[]object{"while-let-delivers-nil-elements", `package P
import System

let ch = chan[string?](3)
ch <- "a"
ch <- nil
ch <- "b"
ch.Close()
while let s = <-ch {
    Console.WriteLine(s ?? "<nil>")
}
Console.WriteLine("closed")`, []string{"a", "<nil>", "b", "closed"}}
            yield[]object{"two-value-receive-forms", `package P
import System

let ch = chan[int32](2)
ch <- 7
ch <- 8
let (first, ok1) = <-ch
var second = 0
var ok2 = false
second, ok2 = <-ch
ch.Close()
let (zero, ok3) = <-ch
Console.WriteLine("{0} {1} {2} {3} {4} {5}", first, ok1, second, ok2, zero, ok3)`, []string{"7 True 8 True 0 False"}}
            yield[]object{"while-let-short-circuits-across-clauses", `package P
import System

let x = chan[int32](1)
let y = chan[int32](1)
x.Close()
y <- 5
while let a = <-x, let b = <-y {
    Console.WriteLine("unexpected")
}
Console.WriteLine(y.Length())`, []string{"1"}}
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let output = StringBuilder()
            output.Append(process.StandardOutput.ReadToEnd())
            output.Append(process.StandardError.ReadToEnd())
            process.WaitForExit()
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
