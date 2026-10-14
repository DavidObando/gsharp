// <copyright file="Issue1499ClosureConstraintRemapEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1499 — when a lambda is reified into a GENERIC synthesized closure /
/// capture-box class (generic over captured enclosing type parameters, per
/// #1477), the cloned closure type parameters must REMAP self-/cross-referential
/// generic constraints onto the clone set. A constraint such as
/// `TKey IComparable[TKey]` copied onto the closure clone previously still
/// referenced the ORIGINAL `TKey` (out of scope inside the reified class),
/// so the emitted `GenericParamConstraint` was unsatisfiable at the capture
/// site (`UnsatisfiedMethodParentInst`/`UnsatisfiedFieldParentInst`)
/// and the constrained member call inside the closure's `Invoke` erased its
/// constraint type argument to `object`
/// (`StackUnexpected [found value 'TKey'][expected ref 'object']`).
///
/// The fix is a two-pass clone in `SynthesizedClosureReifier` that
/// substitutes the original → clone type-parameter map into every cloned
/// constraint, plus preserving the constrained-call metadata through
/// `BoundTreeRewriter.RewriteImportedInstanceCallExpression` (which the
/// closure lowering invokes) so the lambda body still binds to the GENERIC
/// interface method (`IComparable[T].CompareTo(T)`, no box) rather than the
/// non-generic `object` overload.
///
/// Each facet ilverifies clean and runs; the controls (unconstrained captured
/// TP, non-generic user-interface constraint) must not regress.
open class Issue1499ClosureConstraintRemapEmitTests {
    @Fact
    func EndToEnd_SelfReferentialIComparableConstraint_ConstrainedCallInClosure_Runs() {
        let source = `package Issue1499Cmp
import System
class C {
    shared {
        func Make[TResult, TKey IComparable[TKey]](keySelector (TResult) -> TKey) (TResult, TResult) -> int32 ->
            (x TResult, y TResult) -> keySelector(x).CompareTo(keySelector(y))
    }
}
func Main() {
    let f = C.Make[int32, int32]((v int32) -> v)
    System.Console.WriteLine(f(3, 5))
    System.Console.WriteLine(f(5, 3))
    System.Console.WriteLine(f(4, 4))
}`
        let output = CompileAndRun(source)
        Assert.Equal("-1${Environment.NewLine}1${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_SelfReferentialIEquatableConstraint_EqualsCallInClosure_Runs() {
        let source = `package Issue1499Eq
import System
class C {
    shared {
        func Make[TResult, TKey IEquatable[TKey]](keySelector (TResult) -> TKey) (TResult, TResult) -> bool ->
            (x TResult, y TResult) -> keySelector(x).Equals(keySelector(y))
    }
}
func Main() {
    let f = C.Make[int32, int32]((v int32) -> v)
    System.Console.WriteLine(f(4, 4))
    System.Console.WriteLine(f(4, 5))
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_TwoCapturedTypeParameters_SecondSelfReferentiallyConstrained_Runs() {
        let source = `package Issue1499TwoTp
import System
class C {
    shared {
        func Make[T, U IComparable[U]](sel (T) -> U) (T, T) -> int32 ->
            (a T, b T) -> sel(a).CompareTo(sel(b))
    }
}
func Main() {
    let f = C.Make[string, int32]((s string) -> s.Length)
    System.Console.WriteLine(f("aa", "bbbb"))
    System.Console.WriteLine(f("xxxxx", "y"))
}`
        let output = CompileAndRun(source)
        Assert.Equal("-1${Environment.NewLine}1${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_UnconstrainedCapturedTypeParameter_Control_Runs() {
        let source = `package Issue1499Unconstrained
import System
class C {
    shared {
        func Make[T](item T) () -> T ->
            () -> item
    }
}
func Main() {
    let f = C.Make[int32](77)
    System.Console.WriteLine(f())
}`
        let output = CompileAndRun(source)
        Assert.Equal("77${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NonGenericUserInterfaceConstraint_Control_Runs() {
        let source = `package Issue1499NonGenericIface
import System
interface ILabeled {
    func Label() string;
}
data struct Tag(Name string) : ILabeled {
    func Label() string -> Name
}
class C {
    shared {
        func Make[T ILabeled](item T) () -> string ->
            () -> item.Label()
    }
}
func Main() {
    let t = Tag("hello")
    let f = C.Make[Tag](t)
    System.Console.WriteLine(f())
}`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1499_exe_").FullName
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
