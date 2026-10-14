// <copyright file="Issue4241NullableStructAsExpressionEmitTests.cs" company="GSharp">
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

/// Issue #4241: `boxed as Item?` over a same-compilation user struct
/// skipped `unbox.any` entirely — `EmitAsExpression`'s
/// nullable-value-target probe checked the underlying type's `ClrType`,
/// which is always `null` for a same-compilation struct/enum
/// during emit, so the `isinst` result (a boxed-object reference, or
/// null) was stored directly into the `Nullable<Item>`-typed spill
/// slot. The pointer's raw bytes were then reinterpreted as the struct's own
/// fields, corrupting every subsequent read (observed as a value that
/// changed across runs). The fix widens the probe to
/// `NullableLifting.IsAnyValueTypeNullable`, matching the predicate
/// `GetElementTypeToken` and the `!!`-unwrap slot planner already
/// use for this exact shape.
open class Issue4241NullableStructAsExpressionEmitTests {
    /// The exact repro from issue #4241 (plus an enum variant covering the
    /// same `NullableLifting.IsUserValueTypeNullable` predicate):
    /// compiles, IL-verifies, and runs the program, asserting both the
    /// original and the round-tripped value read the same, unmangled value.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param tempDirPrefix The temp-directory name prefix.
    @Theory
    @MemberData("Cases")
    func ObjectToNullableUserValueType_RoundTripsFieldValue(name string, source string, tempDirPrefix string) {
        let tempDir = Directory.CreateTempSubdirectory(tempDirPrefix).FullName
        try {
            let srcPath = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(srcPath, source)
            let outPath = Path.Combine(tempDir, "DirectRoundtrip.dll")
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
            // Run the emitted program twice: pre-fix the corrupted value was
            // an uninitialized pointer's low bytes, which differed run to
            // run — a single passing run would not have caught the defect.
            for var i = 0; i < 2; i++ {
                let (exit, output) = RunDotnet(outPath)
                Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
                let lines = output
                    .Split('\n')
                    .Select((line string) -> line.TrimEnd('\r'))
                    .Where((line string) -> line.Length > 0)
                    .ToArray()
                Assert.Equal([]string{"6", "6"}, lines)
            }
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        private const DirectStructRoundtripSource string = `import System
struct Item { var Value int32 }
var item = Item{Value: 6}
var boxed object = item
let restored = (boxed as Item?)!!
Console.WriteLine(item.Value)
Console.WriteLine(restored.Value)`

        // Same defect shape as the struct case — an enum's underlying is also a
        // same-compilation symbolic value type with a null ClrType during emit,
        // and NullableLifting.IsUserValueTypeNullable/IsAnyValueTypeNullable
        // deliberately unify EnumSymbol with a non-class StructSymbol.
        private const DirectEnumRoundtripSource string = `import System
enum Item { First = 6 }
var item = Item.First
var boxed object = item
let restored = (boxed as Item?)!!
Console.WriteLine(int32(item))
Console.WriteLine(int32(restored))`

        /// Gets the executable cases: each is (case name, source, temp-dir prefix).
        /// @returns The case data.
        func Cases() sequence[[]object] {
            yield[]object{"struct", DirectStructRoundtripSource, "gs_4241_direct_struct_"}
            yield[]object{"enum", DirectEnumRoundtripSource, "gs_4241_direct_enum_"}
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
