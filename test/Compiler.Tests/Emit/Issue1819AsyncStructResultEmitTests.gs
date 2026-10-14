// <copyright file="Issue1819AsyncStructResultEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1819 — awaiting a `Task<UserValueType>` (a same-compilation
/// user struct or enum, non-nullable OR nullable) whose CLR type is still
/// `null` at bind time forced the closed-over-object CLR
/// signature of the generic BCL method that produced the task (for example
/// `Task.FromResult<T>(T)`) to be used for ARGUMENT conversion,
/// classifying the concrete struct/enum argument as an implicit
/// value-to-object boxing conversion and inserting a spurious `box`.
/// Meanwhile the call is actually re-instantiated at emit over the REAL
/// symbolic type argument (e.g. `Task<Pt>::FromResult<Pt>`), whose
/// MethodSpec expects the raw (unboxed) value on the stack — producing an
/// ilverify `StackUnexpected` ("found ref 'X' expected value 'X'") at the
/// call site. Every downstream consumer of the produced `Task<X>` (an
/// awaited local, a field, a member-access receiver, a `??` operand)
/// inherits the same corrupted value, since the bug already occurs before the
/// `Task<X>` is even constructed.
///
/// The fix teaches `ConversionClassifier.BindClrParameterConversions` to
/// recover the real symbolic parameter type (via
/// `TrySubstituteParameterTypeFromMethodTypeArgs`) whenever the argument's
/// OWN bound type is already a concrete same-compilation user type
/// (`TypeSymbol.IsSameCompilationUserTypeTopLevel` — struct, enum,
/// interface, delegate; unwraps `Nullable<T>`), not just when the
/// argument is a bare (cref:GSharp.Core.CodeAnalysis.Symbols.TypeParameterSymbol)
/// or a function literal (the pre-existing #1512/#1540 recoveries). This
/// keeps the argument an identity conversion (`Pt -> Pt`, no `box`),
/// matching what the emitter's `GetMethodEntityHandle` actually
/// instantiates.
///
/// Every facet failed ilverify on current main and passes after the fix. Each
/// uses a UNIQUE package/type name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed.
open class Issue1819AsyncStructResultEmitTests {
    @Fact
    func EndToEnd_AwaitTaskUserStruct_LocalThenFieldAccess_Runs() {
        // The exact issue #1819 repro shape: `let v = await t; return v.X`.
        const source = `package i1819structlocal
import System
import System.Threading.Tasks

struct Pt1819A(X int32) { }

async func getVal() int32 {
    let t = Task.FromResult(Pt1819A(42))
    let v = await t
    return v.X
}

func Main() { System.Console.WriteLine(getVal().Result) }`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_AwaitTaskUserStruct_FieldAssignment_Runs() {
        // Generalization: the awaited struct result is stored directly into a
        // FIELD (hoisted across the await) rather than a plain local, then
        // read back via field access — exercises the `TryGetHoistedField`
        // result-target path alongside the argument-conversion fix.
        const source = `package i1819structfield
import System
import System.Threading.Tasks

struct Pt1819B(X int32, Y int32) { }

async func getSum() int32 {
    var acc = 0
    let v = await Task.FromResult(Pt1819B(10, 32))
    acc = v.X + v.Y
    let v2 = await Task.FromResult(Pt1819B(1, 1))
    acc = acc + v2.X
    return acc
}

func Main() { System.Console.WriteLine(getSum().Result) }`
        let output = CompileAndRun(source)
        Assert.Equal("43${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_AwaitTaskUserEnum_UsedDirectlyInBinaryExpression_Runs() {
        // Generalization: a same-compilation user ENUM (not a struct), and the
        // awaited result is consumed directly in a binary expression without
        // ever being assigned to an intermediate local.
        const source = `package i1819enumbinary
import System
import System.Threading.Tasks

enum Shade1819 { Dim, Mid, Bright }

async func isBright() bool {
    let t = Task.FromResult(Shade1819.Bright)
    return await t == Shade1819.Bright
}

func Main() { System.Console.WriteLine(isBright().Result) }`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_AwaitTaskNullableUserStruct_NullCoalesce_Runs() {
        // Generalization: a NULLABLE same-compilation user struct
        // (`Task<Pt?>`), with the awaited result immediately consumed as the
        // left operand of `??`.
        const source = `package i1819nullablecoalesce
import System
import System.Threading.Tasks

struct Pt1819C(X int32) { }

async func getValOrDefault() int32 {
    let t = Task.FromResult[Pt1819C?](Pt1819C(7))
    let v = (await t) ?? Pt1819C(0)
    return v.X
}

func Main() { System.Console.WriteLine(getValOrDefault().Result) }`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_AwaitTaskUserStruct_MemberAccessReceiver_Runs() {
        // Generalization: the awaited struct result is used directly as the
        // RECEIVER of a member access (no intermediate local at all).
        const source = `package i1819memberaccess
import System
import System.Threading.Tasks

struct Pt1819D(X int32) { }

async func getX() int32 {
    return (await Task.FromResult(Pt1819D(99))).X
}

func Main() { System.Console.WriteLine(getX().Result) }`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1819_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                IlVerifier.Verify(dllPath)
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
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
    }
}
