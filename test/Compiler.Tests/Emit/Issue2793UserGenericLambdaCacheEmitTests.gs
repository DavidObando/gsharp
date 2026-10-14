// <copyright file="Issue2793UserGenericLambdaCacheEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2793 — the user generic `TypeSpec`, field `MemberRef`, and
/// method `MemberRef` caches in `UserTokenResolver` keyed only on the
/// class/state-machine remap (`ActiveIteratorStateMachineRemap`) and
/// ignored the generic-promoted-lambda remap
/// (`ActiveLambdaMethodTypeParamRemap`). A user-declared generic struct
/// referenced with an enclosing method type-parameter argument both inside a
/// generic-promoted lambda (where that parameter is cloned to the lambda
/// method's own `MVAR` ordinal) and at the enclosing method's own use site
/// (where the same parameter keeps a different `MVAR` ordinal) therefore
/// reused metadata encoded under the wrong MVAR scope. The emitted
/// `TypeSpec`/`MemberRef` then referenced an out-of-range
/// generic-method parameter — ilverify crashed in
/// `get_GenericParameters` (IndexOutOfRange) and the JIT threw
/// (cref:System.BadImageFormatException) at run time — the user-generic
/// analog of the #2785/#2791 function-delegate cache leak.
///
/// The trigger requires an ordinal mismatch between the two scopes: the lambda
/// references only the SECOND enclosing type parameter, so its own single
/// method type parameter is `MVAR(0)` while the enclosing method encodes
/// the same parameter as `MVAR(1)`. Both scopes construct the same
/// `Box[TB]` and call its `Get()`, exercising all three caches.
///
/// Both facets ilverify clean and JIT-run correctly after the fix. The
/// interface and named-delegate facets exercise the sibling caches
/// (`userInterface*` / `userDelegate*`) that shared the same latent
/// leak and are keyed on the complete remap context by the same fix.
open class Issue2793UserGenericLambdaCacheEmitTests {
    @Fact
    func GenericStruct_InPromotedLambda_AndEnclosingScope_IntString_Runs() {
        let source = `package Probe2793a
import System

struct Box[T] {
    var Value T
    func Get() T { return Value }
}

func Build[TA, TB](a TA, b TB) TB {
    var outer = Box[TB]{ Value: b }
    let f (TB) -> TB = (x TB) -> Box[TB]{ Value: x }.Get()
    return f(outer.Get())
}

func Main() {
    Console.WriteLine(Build[int32, string](1, "hello"))
}`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    @Fact
    func GenericStruct_EnclosingUseAfterLambda_DifferentTypeArgs_Runs() {
        // Generalization: the enclosing Box[TB] use site follows the lambda
        // (order independence), a third leading type parameter widens the
        // ordinal gap (lambda MVAR(0) vs enclosing MVAR(2)), and the type
        // argument differs. Regardless of use order the two scopes must not
        // share a cached encoding.
        let source = `package Probe2793b
import System

struct Box[T] {
    var Value T
    func Get() T { return Value }
}

func Build[TA, TB, TC](a TA, b TB, c TC) TC {
    let f (TC) -> TC = (x TC) -> Box[TC]{ Value: x }.Get()
    var lambdaResult = f(c)
    var outer = Box[TC]{ Value: lambdaResult }
    return outer.Get()
}

func Main() {
    Console.WriteLine(Build[int32, string, int64](1, "s", 42L))
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func GenericInterface_InPromotedLambda_AndEnclosingScope_Runs() {
        // Issue #2793 deferred-work sibling: the user-interface TypeSpec /
        // member-ref caches (GetUserInterfaceTypeSpec /
        // GetUserInterfaceMethodRef / GetUserInterfaceFieldRef) keyed on
        // nothing remap-related, so a generic interface referenced with an
        // enclosing type-parameter argument leaked its encoding across the
        // lambda/enclosing MVAR boundary the same way.
        let source = `package Probe2793i
import System

interface IBox[T] {
    func Get() T;
}

struct Box[T] : IBox[T] {
    var Value T
    func Get() T { return Value }
}

func Build[TA, TB](a TA, b TB) TB {
    var outer IBox[TB] = Box[TB]{ Value: b }
    let f (TB) -> TB = (x TB) -> {
        var inner IBox[TB] = Box[TB]{ Value: x }
        return inner.Get()
    }
    return f(outer.Get())
}

func Main() {
    Console.WriteLine(Build[int32, string](1, "hello"))
}`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    @Fact
    func GenericNamedDelegate_InPromotedLambda_AndEnclosingScope_Runs() {
        // Issue #2793 deferred-work sibling: the user named-delegate TypeSpec /
        // .ctor / Invoke caches (GetUserDelegateTypeSpec /
        // ResolveDelegateCtorToken / ResolveDelegateInvokeToken) keyed only on
        // the delegate symbol, so a generic named delegate constructed with an
        // enclosing type-parameter argument leaked its parent-TypeSpec encoding
        // across the lambda/enclosing MVAR boundary.
        let source = `package Probe2793d
import System

delegate Holder[T](value T) T;

func Build[TA, TB](a TA, b TB) TB {
    var outer Holder[TB] = (v TB) -> v
    let f (TB) -> TB = (x TB) -> {
        var inner Holder[TB] = (v TB) -> v
        return inner(x)
    }
    return f(outer(b))
}

func Main() {
    Console.WriteLine(Build[int32, string](1, "hello"))
}`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2793_exe_").FullName
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
