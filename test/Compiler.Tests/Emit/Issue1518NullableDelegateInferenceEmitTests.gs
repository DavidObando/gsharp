// <copyright file="Issue1518NullableDelegateInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1518 — a lambda whose parameter or return type is a NULLABLE value
/// type (`T?`) passed to a generic method (e.g.
/// `Enumerable.Select<TSource,TResult>`) made overload-resolution type
/// inference bind the method type parameter to the NON-NULLABLE underlying
/// `T` instead of `Nullable<T>`, while the emitter built the
/// delegate with the accurate `Func<…,T?>`. The instantiation/delegate
/// mismatch (`Select<…,int32>` vs `Func<…,Nullable<int32>>`)
/// failed ilverify with `StackUnexpected`.
///
/// Root cause: `FunctionTypeSymbol.BuildClrType` built the
/// `Func<…>`/`Action<…>` shape from the raw
/// `parameterTypes[i].ClrType` / `returnType.ClrType`, but
/// `NullableTypeSymbol.ClrType` is the bare underlying CLR type, so a
/// `T?` slot collapsed to `T`. The fix routes both the parameter and
/// the return CLR types through `NullableLifting.GetEffectiveClrType`, which
/// wraps a value-type underlying in `Nullable<T>` and is identity for
/// everything else, so the delegate shape matches the emitted delegate.
///
/// Each facet failed ilverify on current main and passes after the fix. Each
/// uses a UNIQUE package/type name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed.
open class Issue1518NullableDelegateInferenceEmitTests {
    @Fact
    func EndToEnd_SelectNullableReturn_ThenOfTypeFilter_Runs() {
        // (a) Lambda RETURN is a nullable value type (int32?) into Select; the
        // resulting IEnumerable<int32?> is filtered by OfType<int32>() which
        // drops the nil entry, so the runtime count is 2 (1 and 3).
        const source = `package i1518selectofint
import System
import System.Linq

class S1518a { prop V int32? { get; init; } }

func F(xs []S1518a) []int32 -> xs.Select((s S1518a) -> s.V).OfType[int32]().ToArray()

func Main() {
    var xs = []S1518a{ S1518a{V: 1}, S1518a{V: nil}, S1518a{V: 3} }
    System.Console.WriteLine(F(xs).Length)
}`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NullableReturn_IntoUserGenericMethod_Runs() {
        // (b) Nullable value-type RETURN flowing into a USER generic method that
        // takes Func<A,T>; the type parameter T must bind to Nullable<int32>,
        // and the emitted delegate must agree (Func<int32,Nullable<int32>>).
        const source = `package i1518usergeneric
import System

func Box(x int32) int32? -> x

func Apply[A, T](v A, f Func[A, T]) T -> f(v)

func Main() {
    var r = Apply[int32, int32?](5, (x int32) -> Box(x))
    System.Console.WriteLine(r!!)
}`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NullableParameter_WhereFilter_Runs() {
        // (c) Lambda PARAMETER is a nullable value type (int32?) -> Func<int32?,bool>
        // into Where; the type parameter must bind to Nullable<int32>.
        const source = `package i1518whereparam
import System
import System.Linq
import System.Collections.Generic

func CountPositive(xs []int32?) int32 -> xs.Where((v int32?) -> v != nil && v!! > 0).Count()

func Main() {
    var xs = []int32?{ 1, nil, -2, 3 }
    System.Console.WriteLine(CountPositive(xs))
}`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NullableBoolReturn_Select_Runs() {
        // Generalization: nullable of a different value type (bool?) as the
        // lambda RETURN into Select, filtered by OfType<bool>().
        const source = `package i1518selectbool
import System
import System.Linq

class S1518b { prop B bool? { get; init; } }

func F(xs []S1518b) []bool -> xs.Select((s S1518b) -> s.B).OfType[bool]().ToArray()

func Main() {
    var xs = []S1518b{ S1518b{B: true}, S1518b{B: nil}, S1518b{B: false} }
    System.Console.WriteLine(F(xs).Length)
}`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_Control_NonNullableSelect_NoRegression_Runs() {
        // (d) Non-nullable control proving no regression: Select with a plain
        // int32 return still infers TResult = int32 and runs.
        const source = `package i1518ctrlnonnull
import System
import System.Linq

class S1518c { prop V int32 { get; init; } }

func F(xs []S1518c) int32 -> xs.Select((s S1518c) -> s.V).Sum()

func Main() {
    var xs = []S1518c{ S1518c{V: 1}, S1518c{V: 2}, S1518c{V: 3} }
    System.Console.WriteLine(F(xs))
}`
        let output = CompileAndRun(source)
        Assert.Equal("6${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1518_exe_").FullName
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
