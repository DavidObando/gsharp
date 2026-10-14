// <copyright file="Issue533NullToNullableParameterEmitTests.cs" company="GSharp">
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

/// Issue #533: passing `nil` to a CLR method/constructor whose parameter
/// is typed as `T?` (either nullable reference type like `string?`,
/// or nullable value type like `int?`) produces GS0130. These tests verify
/// that overload resolution now accepts `nil` for nullable parameters and
/// that emit produces valid IL (verified via ilverify).
open class Issue533NullToNullableParameterEmitTests {
    @Fact
    func Nil_To_CLR_Static_Method_StringParam() {
        // String.IsNullOrEmpty takes a `string?` parameter (NRT annotation
        // on `string`). Passing nil must succeed.
        let source = `package P

import System

var result = String.IsNullOrEmpty(nil)
Console.WriteLine(result)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func Nil_To_CLR_Constructor_StringParam() {
        // System.Uri constructor takes a `string` parameter. Passing nil
        // should compile and emit valid IL (runtime will throw, but the
        // binder and emitter should produce valid code).
        // Instead, use StringBuilder(string?) which accepts null at runtime.
        let source = `package P

import System
import System.Text

var sb = StringBuilder(nil)
Console.WriteLine(sb.Length)`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func Nil_To_User_Function_NullableInt_Param() {
        // A G# function taking Nullable[int32], called with nil directly.
        let source = `package P

import System

func check(n Nullable[int32]) {
    Console.WriteLine(n.HasValue)
}

check(nil)`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}", output)
    }

    @Fact
    func Nil_To_User_Function_NullableString_Param() {
        // A G# function taking string?, called with nil directly.
        let source = `package P

import System

func check(s string?) {
    Console.WriteLine(s == nil)
}

check(nil)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func Nil_To_CLR_Class_Constructor_NullableValueType() {
        // Pass nil to a G# class constructor that takes an int32? parameter.
        // This exercises the CLR constructor overload resolution path.
        let source = `package P

import System

class Box {
    var Value int32?

    init(v int32?) {
        Value = v
    }
}

var b = Box(nil)
Console.WriteLine(b.Value.HasValue)`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}", output)
    }

    @Fact
    func Nil_To_CLR_Class_Constructor_NullableRefType() {
        // Pass nil to a G# class constructor that takes a string? parameter.
        let source = `package P

import System

class Wrapper {
    var Text string?

    init(t string?) {
        Text = t
    }
}

var w = Wrapper(nil)
Console.WriteLine(w.Text == nil)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func Nil_To_CLR_Instance_Method_Nullable_StringParam() {
        // List<string?>.Contains takes a nullable substituted parameter.
        // Passing nil should compile and emit valid IL.
        let source = `package P

import System
import System.Collections.Generic

var xs = List[string?]()
xs.Add("hello")
var result = xs.Contains(nil)
Console.WriteLine(result)`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}", output)
    }

    @Fact
    func Concrete_String_Value_Still_Works() {
        // Regression: passing a non-nil string to String.IsNullOrEmpty.
        let source = `package P

import System

var result = String.IsNullOrEmpty("hello")
Console.WriteLine(result)`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}", output)
    }

    @Fact
    func Concrete_NullableInt_Value_Still_Works() {
        // Regression: passing a concrete int to a Nullable[int32] parameter.
        let source = `package P

import System

func check(n Nullable[int32]) {
    Console.WriteLine(n.HasValue)
    Console.WriteLine(n.GetValueOrDefault())
}

check(42)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func Task_Of_NullableInt_Regression_From_Issue530() {
        // Regression guard: the existing Task<int?> path from #530 still works.
        let source = `package P

import System
import System.Threading.Tasks

let t = Task.FromResult[int32?](99)
let r = t.Result
Console.WriteLine(r)`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
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
            let tempDir = Directory.CreateTempSubdirectory("gs_533_").FullName
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
