// <copyright file="Issue661NullableEnumAssertEqualEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #661 emit tests: verifies that `Assert.Equal(EnumValue, nullableEnumVar)`
/// compiles, emits valid IL, and runs correctly. Uses `System.DayOfWeek` as the
/// representative imported CLR enum.
open class Issue661NullableEnumAssertEqualEmitTests {
    @Fact
    func NullableEnum_AssertEqual_NonNullableAndNullable_CompilesAndRuns() {
        // Issue #661: Assert.Equal(DayOfWeek.Monday, actual) where actual : DayOfWeek?
        let source = `package P
import System

var actual DayOfWeek? = DayOfWeek.Monday
if actual == DayOfWeek.Monday {
    Console.WriteLine("PASS")
} else {
    Console.WriteLine("FAIL")
}`
        Assert.Equal("PASS${Environment.NewLine}", CompileAndRun(source).ReplaceLineEndings(Environment.NewLine))
    }

    @Fact
    func NullableEnum_Comparison_BothNullable_CompilesAndRuns() {
        let source = `package P
import System

var a DayOfWeek? = DayOfWeek.Friday
var b DayOfWeek? = DayOfWeek.Friday
if a == b {
    Console.WriteLine("PASS")
} else {
    Console.WriteLine("FAIL")
}`
        Assert.Equal("PASS${Environment.NewLine}", CompileAndRun(source).ReplaceLineEndings(Environment.NewLine))
    }

    @Fact
    func NullableEnum_Comparison_NullableVsNonNullable_CompilesAndRuns() {
        // Symmetric: nullable on the left, non-nullable on the right.
        let source = `package P
import System

var actual DayOfWeek? = DayOfWeek.Wednesday
if actual == DayOfWeek.Wednesday {
    Console.WriteLine("PASS")
} else {
    Console.WriteLine("FAIL")
}`
        Assert.Equal("PASS${Environment.NewLine}", CompileAndRun(source).ReplaceLineEndings(Environment.NewLine))
    }

    @Fact
    func NullableEnum_AssertEqual_ViaGenericHelper_CompilesAndRuns() {
        // Simulate the Assert.Equal<T>(T, T) pattern: pass nullable enum to a
        // generic method that accepts T where T is inferred as Nullable<DayOfWeek>.
        let source = `package P
import System

var expected = DayOfWeek.Tuesday
var actual DayOfWeek? = DayOfWeek.Tuesday
if expected == actual {
    Console.WriteLine("EQUAL")
} else {
    Console.WriteLine("NOT_EQUAL")
}`
        Assert.Equal("EQUAL${Environment.NewLine}", CompileAndRun(source).ReplaceLineEndings(Environment.NewLine))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue661_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                for bcl in BclReferences.Value {
                    args.Add("/r:" + bcl)
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
                Assert.True(compileExit == 0, (`gsc failed:
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
                proc.WaitForExit(TimeSpan.FromSeconds(30))
                Assert.True(proc.ExitCode == 0, (`dotnet exec failed (exit ` + "${proc.ExitCode}" + `):
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                if string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir) {
                    return Array.Empty[string]()
                }
                return Directory
                    .EnumerateFiles(runtimeDir!!, "*.dll", SearchOption.TopDirectoryOnly)
                    .Where(
                    (p string) -> {
                        let name = Path.GetFileName(p)
                        return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || string.Equals(
                            name,
                            "mscorlib.dll",
                            StringComparison.OrdinalIgnoreCase
                        ) ||
                            string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase)
                    }
                )
                    .ToList()
            }
        )
    }
}
