// <copyright file="Issue1330GenericStaticTypeParamTests.cs" company="GSharp">
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
import Xunit.Sdk

/// Issue #1330: a generic static member-access receiver
/// `GenericType[TypeArg].StaticMember(...)` failed with
/// `GS0125: Variable '...' doesn't exist` when `TypeArg` was an
/// in-scope generic <em>type parameter</em> (e.g. `Comparer[TResult].Default`
/// inside `class C[TResult]`), even though the identical receiver with a
/// <em>concrete</em> type argument (`Comparer[int32].Default`) bound and
/// executed cleanly. This residual of #1323 arose because a single simple-name
/// type argument is parsed as an index expression, and the binder's
/// index-then-member fallback only closed the imported generic receiver for a
/// concrete argument — a type-parameter argument has no concrete CLR type, so
/// resolution fell through to binding the receiver name as a (non-existent)
/// variable.
///
/// The fix carries the symbolic constructed receiver
/// (`Comparer<!TResult>`) alongside the type-erased closed CLR shape
/// (`Comparer<object>`) so that (a) static member access resolves,
/// (b) the member's result type is the symbolic `Comparer[TResult]` rather
/// than the erased `object`, and (c) the emitter parents the static member
/// reference at the constructed `Comparer<!TResult>` TypeSpec —
/// producing verifiable IL exactly as the concrete-argument receiver does.
open class Issue1330GenericStaticTypeParamTests {
    /// The headline case: a static property read on a generic type closed over
    /// an in-scope type parameter (`Comparer[T].Default`) resolves, yields a
    /// usable `Comparer[T]`, verifies, and executes — comparing values via
    /// the recovered comparer.
    @Fact
    func StaticProperty_OnTypeParameterReceiver_VerifiesAndExecutes() {
        let source = `package P
import System
import System.Collections.Generic
class C[T IComparable[T]] {
    func Compare(x T, y T) int32 {
        var cmp = Comparer[T].Default
        return cmp.Compare(x, y)
    }
}
var c = C[int32]{}
Console.WriteLine(c.Compare(3, 5))
Console.WriteLine(c.Compare(7, 2))
Console.WriteLine(c.Compare(4, 4))`
        Assert.Equal(
            "-1${Environment.NewLine}1${Environment.NewLine}0${Environment.NewLine}",
            CompileVerifyAndRun(source)
        )
    }

    /// The same static-property receiver also works for a reference-type
    /// argument (`string`), confirming the symbolic receiver is independent
    /// of the element's value/reference kind.
    @Fact
    func StaticProperty_OnTypeParameterReceiver_ReferenceElement_Executes() {
        let source = `package P
import System
import System.Collections.Generic
class C[T IComparable[T]] {
    func Sign(x T, y T) int32 {
        return Comparer[T].Default.Compare(x, y)
    }
}
var c = C[string]{}
Console.WriteLine(c.Sign("apple", "banana"))
Console.WriteLine(c.Sign("pear", "pear"))`
        Assert.Equal("-1${Environment.NewLine}0${Environment.NewLine}", CompileVerifyAndRun(source))
    }

    /// The control: the identical static-property receiver with a CONCRETE type
    /// argument (`Comparer[int32].Default`) continues to verify and run.
    @Fact
    func StaticProperty_OnConcreteReceiver_StillVerifiesAndExecutes() {
        let source = `package P
import System
import System.Collections.Generic
class C {
    func Compare(x int32, y int32) int32 {
        return Comparer[int32].Default.Compare(x, y)
    }
}
var c = C{}
Console.WriteLine(c.Compare(9, 2))`
        Assert.Equal("1${Environment.NewLine}", CompileVerifyAndRun(source))
    }

    /// Issue #1330 root repro: the static factory call
    /// `Comparer[TResult].Create((x, y) -> ...)` whose type argument is an
    /// in-scope generic type parameter now RESOLVES (binds without GS0125 /
    /// GS0159), exactly like its concrete-argument counterpart. (Full execution
    /// of a lambda whose parameters are an enclosing type parameter additionally
    /// depends on generic-lambda hosting, which is tracked separately; this test
    /// locks the resolution fix that is the subject of #1330.)
    @Fact
    func StaticFactoryCall_OnTypeParameterReceiver_Resolves() {
        let source = `package P
import System.Collections.Generic
class C[TResult IComparable[TResult]] {
    func F() Comparer[TResult] {
        return Comparer[TResult].Create((x TResult, y TResult) -> x.CompareTo(y))
    }
}`
        // Compiles cleanly (no GS0125 "Variable doesn't exist"): the
        // type-parameter static receiver resolves to the constructed generic.
        CompileLibrary(source)
    }

    shared {
        private func CompileVerifyAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1330_emit_").FullName
            try {
                let outPath = CompileToDll(tempDir, source, "/target:exe")
                IlVerifier.Verify(outPath)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileLibrary(source string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1330_lib_").FullName
            try {
                CompileToDll(tempDir, source, "/target:library")
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileToDll(tempDir string, source string, target string) string {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            // Resolve against the host runtime's implementation assemblies (the same
            // assemblies IlVerifier verifies against). The implementation metadata
            // for Comparer<T> exposes its strongly typed Compare(T, T) member, which
            // ordinary member lookup binds in preference to the non-generic
            // IComparer.Compare(object, object) explicit-interface overload.
            let runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            let args = List[string]{"/out:" + outPath, target, "/targetframework:net10.0", "/lib:" + runtimeDir}
            for refName in[]string{
                "System.Runtime.dll",
                "System.Private.CoreLib.dll",
                "System.Collections.dll",
                "System.Console.dll"
            } {
                args.Add("/reference:" + Path.Combine(runtimeDir, refName))
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
            Assert.True(compileExit == 0, (`compile failed (` + "$compileExit" + `):
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            return outPath
        }
    }
}
