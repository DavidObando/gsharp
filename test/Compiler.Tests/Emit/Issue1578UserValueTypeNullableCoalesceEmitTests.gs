// <copyright file="Issue1578UserValueTypeNullableCoalesceEmitTests.cs" company="GSharp">
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

/// Issue #1578: null-coalesce `??` over a user-declared value-type nullable
/// (`struct?` / `enum?`) must emit verifiable IL. The primitive
/// `Nullable<T>` `??` path (issue #519) probes via the BCL-backed
/// `get_HasValue`, but user value types have a null CLR (cref:Type)
/// during emit, so #1572's TypeSpec machinery is required. The emitter spills the
/// `Nullable<UserT>` LHS to a pre-allocated slot, box-probes it over the
/// emitted `Nullable<UserT>` TypeSpec (`box; brfalse` — boxing a
/// `Nullable<T>` yields `null` when empty, ECMA-335), and on the
/// non-null branch either reloads the wrapper (result is `Nullable<UserT>`)
/// or unwraps to `UserT` via the TypeSpec `get_Value` MemberRef (#1572).
///
/// Each test compiles via `gsc`, IL-verifies the produced PE, then executes
/// it under `dotnet exec` and asserts on captured stdout. Every user
/// struct/enum/package is given a UNIQUE name because the in-process name-keyed
/// `FunctionTypeSymbol` cache is not cleared between tests.
open class Issue1578UserValueTypeNullableCoalesceEmitTests {
    @Fact
    func StructCoalesce_NilOperandTakesFallback() {
        let source = `package CoalStructNilPkg

import System

struct CsnPt { var x int32 }

func Coalesce(v CsnPt?) CsnPt {
    let fb = CsnPt{x: -1}
    return v ?? fb
}

let none CsnPt? = nil
Console.WriteLine(Coalesce(none).x)`
        Assert.Equal("-1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func StructCoalesce_PresentOperandTakesValue() {
        let source = `package CoalStructPresentPkg

import System

struct CspPt { var x int32 }

func Coalesce(v CspPt?) CspPt {
    let fb = CspPt{x: -1}
    return v ?? fb
}

let some CspPt? = CspPt{x: 9}
Console.WriteLine(Coalesce(some).x)`
        Assert.Equal("9${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EnumCoalesce_NilAndPresentOperands() {
        let source = `package CoalEnumPkg

import System

enum CeColor { Red, Green, Blue }

func Coalesce(v CeColor?) CeColor { return v ?? CeColor.Red }

let none CeColor? = nil
let some CeColor? = CeColor.Blue
Console.WriteLine(Coalesce(none) == CeColor.Red)
Console.WriteLine(Coalesce(some) == CeColor.Blue)`
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func MultiFieldStructCoalesce_NilAndPresent() {
        let source = `package CoalMultiPkg

import System

struct CmRec {
    var a int32
    var b string
    var c bool
}

func Coalesce(v CmRec?) CmRec {
    return v ?? CmRec{a: 1, b: "fb", c: false}
}

let none CmRec? = nil
let some CmRec? = CmRec{a: 2, b: "present", c: true}
Console.WriteLine(Coalesce(none).b)
Console.WriteLine(Coalesce(some).b)`
        Assert.Equal("fb${Environment.NewLine}present${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func StructWithReferenceFieldCoalesce_ReadsReferenceMember() {
        let source = `package CoalRefFieldPkg

import System

struct CrfNamed {
    var name string
    var count int32
}

func Coalesce(v CrfNamed?) CrfNamed {
    return v ?? CrfNamed{name: "fallback", count: 0}
}

let none CrfNamed? = nil
Console.WriteLine(Coalesce(none).name)`
        Assert.Equal("fallback${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EmptyStructCoalesce_NilTakesFallback() {
        let source = `package CoalEmptyPkg

import System

struct CeUnit {}

func Coalesce(v CeUnit?) CeUnit { return v ?? CeUnit{} }

let none CeUnit? = nil
Console.WriteLine(Coalesce(none).ToString())`
        Assert.Equal("CoalEmptyPkg.CeUnit${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func StructCoalesceChain_ThreeOperands() {
        let source = `package CoalChainPkg

import System

struct CcPt { var x int32 }

func Chain(v CcPt?, w CcPt?) CcPt {
    return v ?? w ?? CcPt{x: -99}
}

let none CcPt? = nil
let w CcPt? = CcPt{x: 5}
Console.WriteLine(Chain(none, none).x)
Console.WriteLine(Chain(none, w).x)`
        Assert.Equal("-99${Environment.NewLine}5${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func StructCoalesceMemberAccessOnResult() {
        let source = `package CoalMemberPkg

import System

struct CmemPt { var x int32 }

func GetX(v CmemPt?) int32 {
    let fb = CmemPt{x: 42}
    return (v ?? fb).x
}

let none CmemPt? = nil
let some CmemPt? = CmemPt{x: 9}
Console.WriteLine(GetX(none))
Console.WriteLine(GetX(some))`
        Assert.Equal("42${Environment.NewLine}9${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func StructCoalesce_NullableResultBranchReloadsWrapper() {
        let source = `package CoalNullableRhsPkg

import System

struct CnrPt { var x int32 }

func Coalesce(v CnrPt?, w CnrPt?) CnrPt {
    let fb = CnrPt{x: -5}
    return (v ?? w) ?? fb
}

let none CnrPt? = nil
let w CnrPt? = CnrPt{x: 7}
Console.WriteLine(Coalesce(none, none).x)
Console.WriteLine(Coalesce(none, w).x)`
        Assert.Equal("-5${Environment.NewLine}7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PrimitiveCoalesce_StillEmitsVerifiableIl() {
        let source = `package CoalPrimPkg

import System

func Coalesce(v int32?) int32 { return v ?? -1 }

let none int32? = nil
let some int32? = 8
Console.WriteLine(Coalesce(none))
Console.WriteLine(Coalesce(some))`
        Assert.Equal("-1${Environment.NewLine}8${Environment.NewLine}", CompileAndRun(source))
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1578_").FullName
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
