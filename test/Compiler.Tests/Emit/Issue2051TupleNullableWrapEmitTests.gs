// <copyright file="Issue2051TupleNullableWrapEmitTests.cs" company="GSharp">
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

/// Issue #2051: the implicit `T -> Nullable<T>` lift (issue #504) must
/// also fire when `T` is a ValueTuple-shaped value type. The
/// `EmitConversion` lift arm keys off `from == toValueNullableLift.UnderlyingType`,
/// which holds for tuple types (they are interned via
/// `TupleTypeSymbol.Get`), but the arm was never reached for a bare
/// tuple-literal initializer/argument because
/// (cref:System.Reflection.Emit)... (see production code comments) —
/// the fix ensures a raw `ValueTuple`2` is never left on the stack where
/// a `Nullable`1<ValueTuple`2>` is expected.
open class Issue2051TupleNullableWrapEmitTests {
    @Fact
    func LocalVariableInitializer_TupleLiteralIntoNullableTuple_WrapsAndVerifies() {
        let source = `package TupleNullableLocalPkg

import System

var p (int32, int32)? = (0, 0)
let v = p!!
Console.WriteLine(v.Item1)
Console.WriteLine(v.Item2)`
        Assert.Equal("0${Environment.NewLine}0${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ArgumentPassing_TupleLiteralIntoNullableTupleParameter_WrapsAndVerifies() {
        let source = `package TupleNullableArgPkg

import System

func Test(v (int32, int32)?) int32 {
    let t = v!!
    return t.Item1 + t.Item2
}

Console.WriteLine(Test((3, 4)))`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ReturnPosition_TupleLiteralIntoNullableTupleReturnType_WrapsAndVerifies() {
        let source = `package TupleNullableReturnPkg

import System

func Make() (int32, int32)? {
    return (5, 6)
}

let r = Make()!!
Console.WriteLine(r.Item1)
Console.WriteLine(r.Item2)`
        Assert.Equal("5${Environment.NewLine}6${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source)
            Assert.True(exitCode == 0, (`exited ` + "$exitCode" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2051_").FullName
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
                return (
                    proc.ExitCode,
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    stderr.ReplaceLineEndings(Environment.NewLine)
                )
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
