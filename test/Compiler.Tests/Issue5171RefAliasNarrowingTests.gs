// <copyright file="Issue5171RefAliasNarrowingTests.cs" company="GSharp">
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

/// Issue #5171 (ADR-0208 row R12): a `ref` local and the variable it aliases
/// name one storage, and a by-reference parameter or a `ref` local of an element
/// or member names storage that no root names. Before the correction, a narrowing
/// fact on the alias survived a write to the aliased variable, a write through a
/// sibling alias, an index or member write, and a call, so the program compiled and
/// threw `NullReferenceException`.
///
/// Every rejected case goes through the compiler driver and asserts the exit
/// code, the diagnostic and its location. Every accepted case compiles,
/// IL-verifies, runs and asserts the output.
open class Issue5171RefAliasNarrowingTests {
    /// A write that can change the aliased storage makes the later read through
    /// the alias report the nullable-receiver diagnostic.
    /// @param name The case name.
    /// @param source The G# program.
    @Theory
    @MemberData("RejectedCases")
    func WriteToTheStorage_InvalidatesAliasNarrowing_ReportsNullableReceiver(name string, source string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_5171_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let (exit, log) = Compile(tempDir, source, appPath)
            Assert.NotEqual(0, exit)
            Assert.False(File.Exists(appPath), "'$name' must not emit an assembly. Log:\n$log")
            Assert.Contains(
                ExpectedDiagnostic(Path.Combine(tempDir, name + ".gs"), source),
                log,
                StringComparison.Ordinal
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Narrowing that no write can invalidate, or that the program re-proves,
    /// stays valid.
    /// @param name The case name.
    /// @param source The G# program.
    /// @param expectedLines The expected stdout lines.
    @Theory
    @MemberData("AcceptedCases")
    func UnrelatedWrite_KeepsAliasNarrowing_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_5171_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let (exit, log) = Compile(tempDir, source, appPath)
            Assert.True(exit == 0, "'$name' must compile. Log:\n$log")
            IlVerifier.Verify(appPath)
            let (runExit, output) = RunDotnet(appPath)
            Assert.True(runExit == 0, "'$name' must run to completion. Exit $runExit:\n$output")
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
        /// Builds the driver line prefix of the `GS0158` that the unique `.Value` read of
        /// [`source`](paramref) must report: file, 1-based line and column of `Value`, and its end.
        private func ExpectedDiagnostic(path string, source string) string {
            let dot = source.IndexOf(".Value", StringComparison.Ordinal)
            Assert.True(dot >= 0, "the case must read `.Value` once")
            Assert.True(
                source.IndexOf(".Value", dot + 1, StringComparison.Ordinal) < 0,
                "the case must read `.Value` once"
            )
            var line = 1
            var lineStart = 0
            for var i = 0; i < dot; i++ {
                if source[i] == '\n' {
                    line++
                    lineStart = i + 1
                }
            }
            let column = dot - lineStart + 2
            return path + "(" + line.ToString() + "," + column.ToString() + "," + line.ToString() +
                "," +
                (column + 5).ToString() + "): error GS0158"
        }

        /// Gets the rejected programs: each is (name, source).
        /// @returns The case data.
        func RejectedCases() sequence[[]object] {
            yield[]object{"ref-local-root-write", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    let ref a C? = x
    if a == nil { return 0 }
    x = nil
    return a.Value
}
func Main() { Console.WriteLine(Run()) }
`}
            yield[]object{"ref-local-root-write-loop", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    var total int32 = 0
    let ref a C? = x
    if a == nil { return 0 }
    for var i = 0; i < 2; i++ {
        total = total + a.Value
        x = nil
    }
    return total
}
func Main() { Console.WriteLine(Run()) }
`}
            yield[]object{"ref-local-sibling-write", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    let ref a C? = x
    let ref b C? = x
    if a == nil { return 0 }
    b = nil
    return a.Value
}
func Main() { Console.WriteLine(Run()) }
`}
            yield[]object{"aliased-root-fact-after-alias-write", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    let ref a C? = x
    if x == nil { return 0 }
    a = nil
    return x.Value
}
func Main() { Console.WriteLine(Run()) }
`}
            yield[]object{"ref-local-element-index-write", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var xs = []C?{C{}}
    let ref a C? = xs[0]
    if a == nil { return 0 }
    xs[0] = nil
    return a.Value
}
func Main() { Console.WriteLine(Run()) }
`}
            yield[]object{"ref-local-field-member-write", `
import System

class C {
    var Value int32 = 1
}
class Box {
    var Field C? = C{}
}
func Run() int32 {
    let box = Box{}
    let ref a C? = box.Field
    if a == nil { return 0 }
    box.Field = nil
    return a.Value
}
func Main() { Console.WriteLine(Run()) }
`}
            yield[]object{"ref-parameter-index-write", `
import System

class C {
    var Value int32 = 1
}
func Run(ref a C?, xs []C?) int32 {
    if a == nil { return 0 }
    xs[0] = nil
    return a.Value
}
func Main() {
    var xs = []C?{C{}}
    Console.WriteLine(Run(ref xs[0], xs))
}
`}
            yield[]object{"ref-parameter-call", `
import System

class C {
    var Value int32 = 1
}
func Clear(xs []C?) { xs[0] = nil }
func Run(ref a C?, xs []C?) int32 {
    if a == nil { return 0 }
    Clear(xs)
    return a.Value
}
func Main() {
    var xs = []C?{C{}}
    Console.WriteLine(Run(ref xs[0], xs))
}
`}
        }

        /// Gets the accepted programs: each is (name, source, expected stdout lines).
        /// @returns The case data.
        func AcceptedCases() sequence[[]object] {
            yield[]object{"ref-local-unrelated-write", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    var y C? = C{}
    let ref a C? = x
    if a == nil { return 0 }
    y = nil
    return a.Value
}
func Main() { Console.WriteLine(Run()) }
`, []string{"1"}}
            yield[]object{"ref-local-reguard-after-write", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    let ref a C? = x
    if a == nil { return 0 }
    x = nil
    if a == nil { return -1 }
    return a.Value
}
func Main() { Console.WriteLine(Run()) }
`, []string{"-1"}}
            yield[]object{"ref-local-of-local-survives-index-write", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    var xs = []C?{C{}}
    let ref a C? = x
    if a == nil { return 0 }
    xs[0] = nil
    return a.Value
}
func Main() { Console.WriteLine(Run()) }
`, []string{"1"}}
            yield[]object{"ref-parameter-unrelated-assignment", `
import System

class C {
    var Value int32 = 1
}
func Run(ref a C?) int32 {
    var n int32 = 0
    if a == nil { return 0 }
    n = n + 1
    return a.Value + n
}
func Main() {
    var x C? = C{}
    Console.WriteLine(Run(ref x))
}
`, []string{"2"}}
        }

        private func Compile(dir string, source string, outPath string)(Exit int32, Log string) {
            let srcPath = Path.Combine(dir, Path.GetFileNameWithoutExtension(outPath) + ".gs")
            File.WriteAllText(srcPath, source)
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
            var exit int32
            try {
                exit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return (exit, compileOut.ToString() + compileErr.ToString())
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
