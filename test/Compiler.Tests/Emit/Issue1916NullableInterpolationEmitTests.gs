// <copyright file="Issue1916NullableInterpolationEmitTests.cs" company="GSharp">
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

/// Issue #1916: interpolating a value-type `Nullable<T>` hole
/// (e.g. `"n=$n"` where `n` is `int32?`) emitted invalid IL —
/// ilverify reported `StackUnexpected` ("found Nullable`1<int32>
/// expected Int32") at the `AppendFormatted<T>` call site.
///
/// Root cause: (cref:GSharp.Core.CodeAnalysis.Symbols.NullableTypeSymbol)
/// reuses the underlying type's CLR (cref:Type) as its own
/// `ClrType` (so binder-side ClrType probes see the lifted primitive),
/// but the emitter always pushes the full `Nullable<T>` struct for
/// a nullable-typed local/expression. `InterpolatedStringHandlerLowerer
/// .CloseAppendFormatted` closed the generic
/// `AppendFormatted<T>` call over `holeType.ClrType` (the bare
/// underlying type), producing a generic instantiation that expects
/// `Int32` while the actual stack value is `Nullable<Int32>`.
/// The fix routes through
/// (cref:GSharp.Core.CodeAnalysis.Symbols.NullableTypeSymbol.GetEffectiveClrType),
/// which already exists for exactly this "declared type vs. actual stack
/// shape" mismatch (see issue #530) and returns `Nullable<T>` for a
/// value-type nullable.
///
/// The bug was unrelated to `??=` itself — the original report's
/// `n ??= 9` repro only manifested the mismatch because the following
/// line interpolated `n`; a bare `Console.WriteLine(n)` after the
/// same `??=` already verified cleanly.
open class Issue1916NullableInterpolationEmitTests {
    @Fact
    func InterpolateNullableInt32_AfterCoalesceAssign_VerifiesAndPrintsUnderlying() {
        let source = `package P

import System

var n int32? = nil
n ??= 9
Console.WriteLine("n=$n")`
        let output = CompileAndRun(source)
        Assert.Equal("n=9${Environment.NewLine}", output)
    }

    @Fact
    func InterpolateNullableInt32_WithValue_VerifiesAndPrintsUnderlying() {
        let source = `package P

import System

var n int32? = 9
Console.WriteLine("n=$n")`
        let output = CompileAndRun(source)
        Assert.Equal("n=9${Environment.NewLine}", output)
    }

    @Fact
    func InterpolateNullableInt32_Absent_VerifiesAndPrintsEmpty() {
        let source = `package P

import System

var n int32? = nil
Console.WriteLine("n=[$n]")`
        let output = CompileAndRun(source)
        Assert.Equal("n=[]${Environment.NewLine}", output)
    }

    @Fact
    func InterpolateNullableBool_VerifiesAndPrintsUnderlying() {
        let source = `package P

import System

var b bool? = true
Console.WriteLine("b=$b")`
        let output = CompileAndRun(source)
        Assert.Equal("b=True${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1916_").FullName
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
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
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
