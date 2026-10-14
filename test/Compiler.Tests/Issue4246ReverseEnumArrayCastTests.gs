// <copyright file="Issue4246ReverseEnumArrayCastTests.cs" company="GSharp">
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

/// Issue #4246: at c6ba1c17 (the commit the issue's evidence was captured
/// against), an enum-typed array could not convert to `object`
/// (`GS0155`) — reported and fixed forward by #4249 / commit
/// `30445de1`, which added a single implicit-conversion arm to
/// `Conversion.cs`: `from is SliceTypeSymbol or ArrayTypeSymbol &&
/// to.ClrType == typeof(object) → Implicit`. #4249's own commit message
/// says the REVERSE cast (`object` back to a same-compilation enum
/// array) "remains separate" and was deliberately not touched.
///
/// Measured against current `main`, the reverse cast already works —
/// in every spelling G# has for it (`as` + `!!`, an `is`
/// pattern, and the `T(x)` explicit-conversion-call form) — and was
/// independently confirmed broken (`GS0155`, at the `var boxed
/// object = values` line, before the reverse line is even reached) when
/// built at c6ba1c17. The explanation: G#, like C#, defines an explicit
/// conversion to exist between A and B whenever an implicit conversion
/// exists in EITHER direction (ECMA-335 / the C# spec's explicit-conversion
/// closure over implicit conversions) — so #4249's one-directional implicit
/// widening fix silently unlocked the explicit narrowing cast the other
/// way, contrary to its own commit message. This closes the issue's
/// remaining gap with the requested same-compilation/imported controls
/// (no product code change: the fix already landed as a side effect of
/// #4249).
open class Issue4246ReverseEnumArrayCastTests {
    /// Compiles each case, IL-verifies the emitted assembly, runs it, and
    /// asserts the program's own output — including the runtime
    /// `GetType().Name`, so a regression that silently widened the
    /// round-tripped array to its underlying integer type would fail
    /// (rather than only checking the numeric values, which survive that
    /// substitution unchanged).
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func ReverseEnumArrayCast_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4246_reverse_cast_").FullName
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
        func Cases() sequence[[]object] {
            // (case name, enum-array source, expected first-element stdout)
            yield[]object{"same-compilation-as-bang-bang", `import System
enum Kind { First = 7 }
let values = []Kind{Kind.First}
var boxed object = values
let back = (boxed as []Kind)!!
Console.WriteLine(int32(back[0]))
Console.WriteLine(back.GetType().Name)`, []string{"7", "Kind[]"}}
            yield[]object{"same-compilation-is-pattern", `import System
enum Kind { First = 7, Second = 9 }
let values = []Kind{Kind.First, Kind.Second}
var boxed object = values
if boxed is []Kind arr {
    Console.WriteLine(int32(arr[0]))
    Console.WriteLine(int32(arr[1]))
} else {
    Console.WriteLine("no match")
}`, []string{"7", "9"}}
            yield[]object{"same-compilation-explicit-conversion-call", `import System
enum Kind { First = 7 }
let values = []Kind{Kind.First}
var boxed object = values
let back = []Kind(boxed)
Console.WriteLine(int32(back[0]))
Console.WriteLine(back.GetType().Name)`, []string{"7", "Kind[]"}}
            yield[]object{"same-compilation-empty-array", `import System
enum Kind { First = 7 }
let values = []Kind{}
var boxed object = values
let back = (boxed as []Kind)!!
Console.WriteLine(back.Length)
Console.WriteLine(back.GetType().Name)`, []string{"0", "Kind[]"}}
            yield[]object{"imported-as-bang-bang", `import System
let values = []DayOfWeek{DayOfWeek.Monday}
var boxed object = values
let back = (boxed as []DayOfWeek)!!
Console.WriteLine(back[0])
Console.WriteLine(back.GetType().Name)`, []string{"Monday", "DayOfWeek[]"}}
            yield[]object{"imported-explicit-conversion-call", `import System
let values = []DayOfWeek{DayOfWeek.Monday}
var boxed object = values
let back = []DayOfWeek(boxed)
Console.WriteLine(back[0])
Console.WriteLine(back.GetType().Name)`, []string{"Monday", "DayOfWeek[]"}}
            // Primitive-array parity control: the reverse cast must behave the
            // same for a non-enum element type (no enum-specific regression).
            yield[]object{"primitive-explicit-conversion-call", `import System
let values = []int32{7}
var boxed object = values
let back = []int32(boxed)
Console.WriteLine(back[0])
Console.WriteLine(back.GetType().Name)`, []string{"7", "Int32[]"}}
        }

        private const RunTimeoutMilliseconds int32 = 60_000

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            // Draining stdout to EOF before touching stderr deadlocks if the child
            // fills the stderr pipe first — read both concurrently and bound the
            // wait, or a hanging/misbehaving program takes the whole test run
            // down with it (mirrors Issue3958NullableDirectionalChannelTests).
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeoutMilliseconds) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "timed out after ${RunTimeoutMilliseconds / 1000}s (deadlock).")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
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
