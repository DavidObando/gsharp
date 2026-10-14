// <copyright file="Issue1298NullableUserEnumEmitTests.cs" company="GSharp">
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

/// Issue #1298: nullable user-defined enums (`E?`) support lifted equality
/// and inequality with C#/`Nullable<T>` semantics, both in the binder
/// (no GS0129 "operator not defined") and the emitter (no GS9998 ICE encoding
/// `Nullable<E>`). Two `nil`s are equal, a `nil` and a value
/// are unequal, and two values compare by the enum's underlying integral value.
///
/// Each test compiles via `gsc`, IL-verifies the produced PE, then executes
/// it under `dotnet exec` and asserts on captured stdout.
open class Issue1298NullableUserEnumEmitTests {
    @Fact
    func NullableEnumEqualsEnum_PresentMatch_IsTrue() {
        let source = `package P

import System

enum E { A, B }

func Eq(x E?) bool { return x == E.A }

let a E? = E.A
let b E? = E.B
let n E? = nil
Console.WriteLine(Eq(a))
Console.WriteLine(Eq(b))
Console.WriteLine(Eq(n))`
        // present A == A -> True; present B == A -> False; nil == A -> False.
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func NullableEnumNotEqualsEnum_LiftsOverNil() {
        let source = `package P

import System

enum E { A, B }

func Ne(x E?) bool { return x != E.A }

let a E? = E.A
let b E? = E.B
let n E? = nil
Console.WriteLine(Ne(a))
Console.WriteLine(Ne(b))
Console.WriteLine(Ne(n))`
        // A != A -> False; B != A -> True; nil != A -> True (nil unequal to value).
        Assert.Equal(
            "False${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func NullableEnumEqualsNil_DistinguishesPresentFromAbsent() {
        let source = `package P

import System

enum E { A, B }

func IsNil(x E?) bool { return x == nil }
func NotNil(x E?) bool { return x != nil }

let a E? = E.A
let n E? = nil
Console.WriteLine(IsNil(a))
Console.WriteLine(IsNil(n))
Console.WriteLine(NotNil(a))
Console.WriteLine(NotNil(n))`
        // a==nil -> False; n==nil -> True; a!=nil -> True; n!=nil -> False.
        Assert.Equal(
            "False${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func NilEqualsNullableEnum_SymmetricOperand() {
        let source = `package P

import System

enum E { A, B }

func IsNil(x E?) bool { return nil == x }

let a E? = E.A
let n E? = nil
Console.WriteLine(IsNil(a))
Console.WriteLine(IsNil(n))`
        Assert.Equal("False${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NullableEnumEqualsNullableEnum_LiftedSemantics() {
        let source = `package P

import System

enum E { A, B }

func Eq(x E?, y E?) bool { return x == y }
func Ne(x E?, y E?) bool { return x != y }

let a E? = E.A
let b E? = E.B
let n E? = nil
Console.WriteLine(Eq(n, n))
Console.WriteLine(Eq(a, n))
Console.WriteLine(Eq(a, a))
Console.WriteLine(Eq(a, b))
Console.WriteLine(Ne(a, b))
Console.WriteLine(Ne(n, n))`
        // nil==nil -> True; a==nil -> False; a==a -> True; a==b -> False;
        // a!=b -> True; nil!=nil -> False.
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}",
            CompileAndRun(source)
        )
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1298_").FullName
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
