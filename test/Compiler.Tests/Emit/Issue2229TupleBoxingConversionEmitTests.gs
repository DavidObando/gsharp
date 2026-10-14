// <copyright file="Issue2229TupleBoxingConversionEmitTests.cs" company="GSharp">
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

/// Issue #2229: a tuple element conversion that boxes a nullable VALUE type to
/// a nullable reference target (e.g. `int32? -> object?`) must not just
/// bind — it must emit a real box so the runtime value observed through the
/// target-typed tuple is the boxed value (or an actual null reference when the
/// source has no value), exactly like the equivalent scalar
/// `int32? -> object?` argument conversion. This proves the fix (a new
/// arm in `Conversion.Classify`'s lifted-nullable-target branch) flows
/// through `ConversionClassifier.BindTupleConversion`'s existing
/// per-element lowering (issue #1256) to produce verifiable IL.
open class Issue2229TupleBoxingConversionEmitTests {
    @Fact
    func NullableInt32Element_BoxedToObject_RoundTripsValue() {
        let source = `package Test
import System

func Take(t (string, object?)) string {
    return t.Item1 + ":" + t.Item2!!.ToString()
}

func F(n int32?) string { return Take(("count", n)) }

Console.WriteLine(F(42))`
        let output = CompileAndRun(source)
        Assert.Equal("count:42${Environment.NewLine}", output)
    }

    @Fact
    func NullableBoolElement_BoxedToObject_RoundTripsValue() {
        let source = `package Test
import System

func Take(t (string, object?)) string {
    return t.Item1 + ":" + t.Item2!!.ToString()
}

func F(b bool?) string { return Take(("ok", b)) }

Console.WriteLine(F(true))`
        let output = CompileAndRun(source)
        Assert.Equal("ok:True${Environment.NewLine}", output)
    }

    @Fact
    func NullValuedNullableElement_BoxedToObject_ProducesNullReference() {
        let source = `package Test
import System

func Take(t (string, object?)) string {
    if t.Item2 == nil {
        return t.Item1 + ":nil"
    }
    return t.Item1 + ":" + t.Item2!!.ToString()
}

func F(n int32?) string { return Take(("count", n)) }

Console.WriteLine(F(nil))`
        let output = CompileAndRun(source)
        Assert.Equal("count:nil${Environment.NewLine}", output)
    }

    @Fact
    func ParamsTupleArray_MixedNullableValueElements_RoundTripsValues() {
        // The exact repro shape from issue #2229: a variadic `(string, object?)`
        // slice packed from tuple literals whose second element is a different
        // nullable value type per argument.
        let source = `package Test
import System

func Args(pairs ...(string, object?)) string {
    var result string = ""
    for p in pairs {
        result = result + p.Item1 + "=" + p.Item2!!.ToString() + ";"
    }
    return result
}

func F(n int32?, b bool?) string {
    return Args(("count", n), ("ok", b))
}

Console.WriteLine(F(7, false))`
        let output = CompileAndRun(source)
        Assert.Equal("count=7;ok=False;${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source)
            Assert.True(exitCode == 0, (`gsc failed (exit ` + "$exitCode" + `):
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2229_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
                for reference in TrustedPlatformAssemblies() {
                    args.Add("/reference:" + reference)
                }
                args.Add("/nowarn:GS9100")
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
                if compileExit != 0 {
                    return (compileExit, compileOut.ToString(), compileErr.ToString())
                }
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

        private func TrustedPlatformAssemblies() sequence[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                yield break
            }
            for path in tpa.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }
    }
}
