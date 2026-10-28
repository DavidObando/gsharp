// <copyright file="Issue5170GlobalCallNarrowingTests.cs" company="GSharp">
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

/// Issue #5170 (ADR-0208 row R11): assignment narrowing applies to a mutable
/// top-level `var`, and any call may assign such a global. Before the
/// correction, a direct call to a declared function (or method, constructor or
/// property getter with user code) did not invalidate a narrowed global in
/// straight-line code or in a loop, so the program compiled and threw
/// `NullReferenceException`.
///
/// Every rejected case goes through the compiler driver and asserts the exit
/// code and the diagnostic. Every accepted case compiles, IL-verifies, runs and
/// asserts the output.
open class Issue5170GlobalCallNarrowingTests {
    /// A call that can assign the narrowed global makes the later read report
    /// the nullable-receiver diagnostic.
    /// @param name The case name.
    /// @param source The G# program.
    @Theory
    @MemberData("RejectedCases")
    func CallThatMayAssignGlobal_InvalidatesNarrowing_ReportsNullableReceiver(name string, source string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_5170_").FullName
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

    /// Narrowing that no call can invalidate, or that the program re-proves,
    /// stays valid.
    /// @param name The case name.
    /// @param source The G# program.
    /// @param expectedLines The expected stdout lines.
    @Theory
    @MemberData("AcceptedCases")
    func NarrowingNotInvalidatedByCall_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_5170_").FullName
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
        /// Builds the driver line prefix of the `GS0158` that the unique `.Length` read of
        /// [`source`](paramref) must report: file, 1-based line and column of `Length`, and its end.
        private func ExpectedDiagnostic(path string, source string) string {
            let dot = source.IndexOf(".Length", StringComparison.Ordinal)
            Assert.True(dot >= 0, "the case must read `.Length` once")
            Assert.True(
                source.IndexOf(".Length", dot + 1, StringComparison.Ordinal) < 0,
                "the case must read `.Length` once"
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
                (column + 6).ToString() + "): error GS0158"
        }

        /// Gets the rejected programs: each is (name, source).
        /// @returns The case data.
        func RejectedCases() sequence[[]object] {
            yield[]object{"straight-line", `
import System

var text string? = nil
func Clear() { text = nil }
func Run() int32 {
    text = "safe"
    Clear()
    return text.Length
}
Console.WriteLine(Run())
`}
            yield[]object{"loop", `
import System

var text string? = nil
func Clear() { text = nil }
func Run() int32 {
    var total int32 = 0
    text = "safe"
    for var i = 0; i < 2; i++ {
        total = total + text.Length
        Clear()
    }
    return total
}
Console.WriteLine(Run())
`}
            yield[]object{"instance-method", `
import System

var text string? = nil
class Resetter {
    func Reset() { text = nil }
}
func Run() int32 {
    let r = Resetter{}
    text = "safe"
    r.Reset()
    return text.Length
}
Console.WriteLine(Run())
`}
            yield[]object{"constructor", `
import System

var text string? = nil
class Resetter {
    init() { text = nil }
}
func Run() int32 {
    text = "safe"
    let r = Resetter()
    return text.Length
}
Console.WriteLine(Run())
`}
            yield[]object{"composite-literal-field-initializer", `
import System

var text string? = nil
func Boom() int32 {
    text = nil
    return 1
}
class Resetter {
    var value int32 = Boom()
}
func Run() int32 {
    text = "safe"
    let r = Resetter{}
    return text.Length + r.value
}
Console.WriteLine(Run())
`}
            yield[]object{"property-getter", `
import System

var text string? = nil
class Resetter {
    prop Value int32 {
        get {
            text = nil
            return 1
        }
    }
}
func Run() int32 {
    let r = Resetter{}
    text = "safe"
    let v = r.Value
    return text.Length + v
}
Console.WriteLine(Run())
`}
            yield[]object{"generic-composite-literal-field-initializer", `
import System

var text string? = nil
func Boom() int32 {
    text = nil
    return 1
}
class Resetter[T] {
    var value int32 = Boom()
}
func Run() int32 {
    text = "safe"
    let r = Resetter[int32]{}
    return text.Length + r.value
}
Console.WriteLine(Run())
`}
            yield[]object{"derived-literal-base-constructor", `
import System

var text string? = nil
open class Base {
    init() { text = nil }
}
class Derived : Base { }
func Run() int32 {
    text = "safe"
    let d = Derived{}
    return text.Length
}
Console.WriteLine(Run())
`}
            yield[]object{"literal-custom-setter", `
import System

var text string? = nil
class Holder {
    var store int32
    prop Value int32 {
        get -> store
        set { text = nil }
    }
}
func Run() int32 {
    text = "safe"
    let h = Holder{Value: 1}
    return text.Length
}
Console.WriteLine(Run())
`}
            yield[]object{"base-call", `
import System

var text string? = nil
open class Base {
    func Clear() { text = nil }
}
class Derived : Base {
    func Run() int32 {
        text = "safe"
        base.Clear()
        return text.Length
    }
}
let d = Derived{}
Console.WriteLine(d.Run())
`}
            yield[]object{"iterator-for-in-after-loop", `
import System

var text string? = nil
func Items() sequence[int32] {
    text = nil
    yield 1
}
func Run() int32 {
    let items = Items()
    text = "safe"
    for item in items {
    }
    return text.Length
}
Console.WriteLine(Run())
`}
            yield[]object{"iterator-for-in-inside-loop", `
import System

var text string? = nil
func Items() sequence[int32] {
    text = nil
    yield 1
}
func Run() int32 {
    let items = Items()
    var total int32 = 0
    text = "safe"
    for item in items {
        total = total + text.Length
    }
    return total
}
Console.WriteLine(Run())
`}
        }

        /// Gets the accepted programs: each is (name, source, expected stdout lines).
        /// @returns The case data.
        func AcceptedCases() sequence[[]object] {
            yield[]object{"no-call", `
import System

var text string? = nil
func Run() int32 {
    text = "safe"
    let n = text.Length
    return n + text.Length
}
Console.WriteLine(Run())
`, []string{"8"}}
            yield[]object{"reassigned-after-call", `
import System

var text string? = nil
func Clear() { text = nil }
func Run() int32 {
    text = "safe"
    Clear()
    text = "again"
    return text.Length
}
Console.WriteLine(Run())
`, []string{"5"}}
            yield[]object{"assigned-from-call", `
import System

var text string? = nil
func Make() string { return "made" }
func Run() int32 {
    text = Make()
    return text.Length
}
Console.WriteLine(Run())
`, []string{"4"}}
            yield[]object{"literal-without-initializers", `
import System

var text string? = nil
class Plain {
    var value int32
}
func Run() int32 {
    text = "safe"
    let p = Plain{}
    return text.Length + p.value
}
Console.WriteLine(Run())
`, []string{"4"}}
            yield[]object{"local-survives-call", `
import System

var text string? = nil
func Clear() { text = nil }
func Run() int32 {
    var s string? = "local"
    if s == nil { return 0 }
    Clear()
    return s.Length
}
Console.WriteLine(Run())
`, []string{"5"}}
            yield[]object{"indexed-for-in", `
import System

var text string? = nil
func Run() int32 {
    text = "safe"
    var total int32 = 0
    for item in []int32{1, 2} {
        // A member read would remove the fact at the loop entry (ADR-0213 W5); a conversion does not.
        let copy string = text
        total = item
    }
    return total + text.Length
}
Console.WriteLine(Run())
`, []string{"6"}}
            yield[]object{"read-only-global-survives-call", `
import System

func Get() string? { return "abc" }
let text string? = Get()
func Poke() { }
func Run() int32 {
    if text == nil { return 0 }
    Poke()
    return text.Length
}
Console.WriteLine(Run())
`, []string{"3"}}
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
