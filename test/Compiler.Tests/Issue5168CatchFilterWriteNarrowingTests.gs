// <copyright file="Issue5168CatchFilterWriteNarrowingTests.cs" company="GSharp">
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

/// Issue #5168 (ADR-0208 row R10): a `catch` clause's `when` filter runs
/// before its handler is chosen, and a false or throwing filter continues the
/// handler search (ADR-0177). A write that the filter makes to a narrowed
/// variable therefore reaches the clause's own body, every later clause and the
/// `finally` block. Before the correction, the binder bound those code regions
/// with the narrowing of the `try` entry minus the `try` block's writes, so the
/// program compiled and threw `NullReferenceException`.
///
/// Every rejected case goes through the compiler driver and asserts the exit
/// code and the diagnostic. Every accepted case compiles, IL-verifies, runs and
/// asserts the output.
open class Issue5168CatchFilterWriteNarrowingTests {
    /// A filter that stores nil makes the read in a later clause, in the own
    /// clause and in the `finally` block report the nullable-receiver
    /// diagnostic.
    /// @param name The case name.
    /// @param source The G# program.
    @Theory
    @MemberData("RejectedCases")
    func FilterWrite_ReachesHandlerCode_ReportsNullableReceiver(name string, source string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_5168_").FullName
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

    /// Filters that leave the narrowed variable alone keep the narrowing, and a
    /// guard that re-proves it after the filter is honored.
    /// @param name The case name.
    /// @param source The G# program.
    /// @param expectedLines The expected stdout lines.
    @Theory
    @MemberData("AcceptedCases")
    func FilterWithoutWrite_KeepsNarrowing_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_5168_").FullName
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
            // The reduction from the issue: the first filter stores nil and
            // declines, so the second clause reads nil.
            yield[]object{"later-clause", `
package P
import System

func Get() string? { return "a" }
func Clear(ref s string?) bool {
    s = nil
    return false
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    try {
        throw Exception("x")
    } catch when Clear(ref s) {
        return 1
    } catch {
        return s.Length
    }
}
func Main() { Console.WriteLine(Run()) }
`}
            // The filter accepts, so its own handler body reads nil.
            yield[]object{"own-clause", `
package P
import System

func Get() string? { return "a" }
func Clear(ref s string?) bool {
    s = nil
    return true
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    try {
        throw Exception("x")
    } catch when Clear(ref s) {
        return s.Length
    }
}
func Main() { Console.WriteLine(Run()) }
`}
            // The write is made by a closure that the filter calls.
            yield[]object{"callback-filter", `
package P
import System

func Get() string? { return "a" }
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    let clear = func() bool {
        s = nil
        return false
    }
    try {
        throw Exception("x")
    } catch when clear() {
        return 1
    } catch {
        return s.Length
    }
}
func Main() { Console.WriteLine(Run()) }
`}
            // The filter of the second clause writes, and the third reads.
            yield[]object{"third-clause", `
package P
import System

func Get() string? { return "a" }
func Clear(ref s string?) bool {
    s = nil
    return false
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    try {
        throw Exception("x")
    } catch (InvalidOperationException) {
        return 1
    } catch (Exception) when Clear(ref s) {
        return 2
    } catch {
        return s.Length
    }
}
func Main() { Console.WriteLine(Run()) }
`}
            // The finally block runs after the declining filter.
            yield[]object{"finally-block", `
package P
import System

func Get() string? { return "a" }
func Clear(ref s string?) bool {
    s = nil
    return false
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    try {
        try {
            throw Exception("x")
        } catch when Clear(ref s) {
            return 1
        } finally {
            Console.WriteLine(s.Length)
        }
    } catch {
        return 2
    }
}
func Main() { Console.WriteLine(Run()) }
`}
            // An enclosing filter runs in the first pass, before the inner finally.
            yield[]object{"enclosing-filter-inner-finally", `
package P
import System

func Get() string? { return "a" }
func Clear(ref s string?) bool {
    s = nil
    return true
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    try {
        try {
            throw Exception("x")
        } finally {
            Console.WriteLine(s.Length)
        }
    } catch when Clear(ref s) {
        return 1
    }
    return 2
}
func Main() { Console.WriteLine(Run()) }
`}
            // A replacement exception from a finally reaches an inner catch after the outer filter ran.
            yield[]object{"enclosing-filter-inner-catch", `
package P
import System

func Get() string? { return "a" }
func Clear(ref s string?) bool {
    s = nil
    return true
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    try {
        try {
            try {
                throw FormatException("f")
            } finally {
                throw InvalidOperationException("g")
            }
        } catch (InvalidOperationException) {
            return s.Length
        }
    } catch (FormatException) when Clear(ref s) {
        return 0
    }
    return 2
}
func Main() { Console.WriteLine(Run()) }
`}
            // An enclosing filter assigns a callable alias, so the alias no longer proves an external call.
            yield[]object{"enclosing-filter-callable-alias", `
package P
import System

func Get() string? { return "a" }
func Run(callback () -> void) int32 {
    var s string? = Get()
    let clear = func() { s = nil }
    var action = callback
    let flip = func() bool {
        action = clear
        return true
    }
    try {
        try {
            throw Exception("x")
        } finally {
            if s != nil {
                action()
                Console.WriteLine(s.Length)
            }
        }
    } catch when flip() {
        return 1
    }
    return 2
}
func Main() { Console.WriteLine(Run(() -> { })) }
`}
            // An enclosing filter reads a property whose factory clears the variable; the filter has no call expression.
            yield[]object{"enclosing-filter-getter", `
package P
import System

func Get() string? { return "a" }
func Run() int32 {
    var s string? = Get()
    let box = Lazy[bool](() -> {
        s = nil
        return true
    })
    if s == nil { return 0 }
    try {
        try {
            throw Exception("x")
        } finally {
            Console.WriteLine(s.Length)
        }
    } catch when box.Value {
        return 1
    }
    return 2
}
func Main() { Console.WriteLine(Run()) }
`}
            // An enclosing filter assigns the variable directly.
            yield[]object{"enclosing-filter-assignment", `
package P
import System

func Get() string? { return "a" }
func Run() int32 {
    var s string? = Get()
    var empty string? = nil
    if s == nil { return 0 }
    try {
        try {
            throw Exception("x")
        } finally {
            Console.WriteLine(s.Length)
        }
    } catch when (s = empty) == nil {
        return 1
    }
    return 2
}
func Main() { Console.WriteLine(Run()) }
`}
            // A replacement exception reaches the first clause after the filter of the second clause ran.
            yield[]object{"earlier-clause-after-later-filter", `
package P
import System

func Get() string? { return "a" }
func Clear(ref s string?) bool {
    s = nil
    return false
}
func Boom() {
    try {
        throw FormatException("f")
    } finally {
        throw InvalidOperationException("g")
    }
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    try {
        Boom()
    } catch (InvalidOperationException) {
        return s.Length
    } catch (FormatException) when Clear(ref s) {
        return 0
    }
    return 2
}
func Main() { Console.WriteLine(Run()) }
`}
            // An outer filter replaces a callable alias, and an inner catch handles a replacement exception.
            yield[]object{"enclosing-filter-alias-after-inner-try", `
package P
import System

func Run(callback () -> void) int32 {
    var s string? = "abc"
    let clear = func() { s = nil }
    var action = callback
    let flip = func() bool {
        action = clear
        return true
    }
    try {
        try {
            try {
                throw FormatException("f")
            } finally {
                throw InvalidOperationException("g")
            }
        } catch (InvalidOperationException) {
        }
        if s != nil {
            action()
            return s.Length
        }
        return 0
    } catch (FormatException) when flip() {
        return 1
    }
}
func Main() { Console.WriteLine(Run(() -> { })) }
`}
            // A branch join must not restore a fact that an enclosing filter cleared.
            yield[]object{"enclosing-filter-if-join", `
package P
import System

func Clear(ref s string?) bool {
    s = nil
    return false
}
func Run(flag bool) int32 {
    let f = FormatException("f")
    let g = InvalidOperationException("g")
    var s string? = nil
    try {
        if flag {
            s = "a"
            try {
                try {
                    throw f
                } finally {
                    throw g
                }
            } catch (InvalidOperationException) {
            }
        } else {
            s = "b"
        }
        return s.Length
    } catch (FormatException) when Clear(ref s) {
        return 0
    }
}
func Main() { Console.WriteLine(Run(true)) }
`}
            // The exit state of a try keeps the callable alias that its own declining filter replaced.
            yield[]object{"own-filter-alias-after-try", `
package P
import System

func Run(callback () -> void) int32 {
    var s string? = "abc"
    let clear = func() { s = nil }
    var action = callback
    let flip = func() bool {
        action = clear
        return false
    }
    try {
        throw Exception("x")
    } catch when flip() {
        return 1
    } catch {
    }
    if s != nil {
        action()
        return s.Length
    }
    return 0
}
func Main() { Console.WriteLine(Run(() -> { })) }
`}
        }

        /// Gets the accepted programs: each is (name, source, expected stdout lines).
        /// @returns The case data.
        func AcceptedCases() sequence[[]object] {
            // A filter that only reads keeps the narrowing in every clause.
            yield[]object{"filter-without-write", `
package P
import System

func Get() string? { return "abc" }
func Check(value int32) bool { return value == 1 }
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    try {
        throw Exception("x")
    } catch when Check(2) {
        return 1
    } catch {
        return s.Length
    }
}
func Main() { Console.WriteLine(Run()) }
`, []string{"3"}}
            // A filter that writes another variable leaves the narrowing alone.
            yield[]object{"filter-writes-other-variable", `
package P
import System

func Get() string? { return "abcd" }
func Touch(ref t string?) bool {
    t = nil
    return false
}
func Run() int32 {
    var s string? = Get()
    var t string? = Get()
    if s == nil { return 0 }
    try {
        throw Exception("x")
    } catch when Touch(ref t) {
        return 1
    } catch {
        return s.Length
    }
}
func Main() { Console.WriteLine(Run()) }
`, []string{"4"}}
            // The write is real, and the program re-proves the fact first.
            yield[]object{"guard-after-filter-write", `
package P
import System

func Get() string? { return "a" }
func Clear(ref s string?) bool {
    s = nil
    return false
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    try {
        throw Exception("x")
    } catch when Clear(ref s) {
        return 1
    } catch {
        if s == nil { return -1 }
        return s.Length
    }
}
func Main() { Console.WriteLine(Run()) }
`, []string{"-1"}}
            // A filter of an enclosing try that names no narrowed variable keeps the narrowing.
            yield[]object{"enclosing-filter-unrelated", `
package P
import System

func Get() string? { return "abc" }
func Touch(ref t string?) bool {
    t = nil
    return true
}
func Run() int32 {
    var s string? = Get()
    var t string? = Get()
    if s == nil { return 0 }
    try {
        try {
            throw Exception("x")
        } finally {
            Console.WriteLine(s.Length)
        }
    } catch when Touch(ref t) {
        return 1
    }
    return 2
}
func Main() { Console.WriteLine(Run()) }
`, []string{"3", "1"}}
            // A filter that only reads the narrowed local keeps the narrowing in the filter and the handlers.
            yield[]object{"filter-reads-narrowed-local", `
package P
import System

func Get() string? { return "abc" }
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    try {
        throw Exception("x")
    } catch when s.Length > 5 {
        return 1
    } catch {
        return s.Length
    }
}
func Main() { Console.WriteLine(Run()) }
`, []string{"3"}}
            // An `in` argument cannot write its storage.
            yield[]object{"filter-passes-in-argument", `
package P
import System

func Get() string? { return "abc" }
func Check(in value string?) bool { return false }
func Run() int32 {
    let s string? = Get()
    if s == nil { return 0 }
    try {
        throw Exception("x")
    } catch when Check(in s) {
        return 1
    } catch {
        return s.Length
    }
}
func Main() { Console.WriteLine(Run()) }
`, []string{"3"}}
            // An index input of a ref operand is only read, so the narrowed local keeps its fact.
            yield[]object{"filter-ref-operand-index-read", `
package P
import System

func Get() string? { return "abc" }
func Touch(ref slot int32) bool { return false }
func Run() int32 {
    let s string? = Get()
    if s == nil { return 0 }
    var items = []int32{0, 0, 0, 0}
    try {
        throw Exception("x")
    } catch when Touch(ref items[s.Length]) {
        return 1
    } catch {
        return s.Length
    }
}
func Main() { Console.WriteLine(Run()) }
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
