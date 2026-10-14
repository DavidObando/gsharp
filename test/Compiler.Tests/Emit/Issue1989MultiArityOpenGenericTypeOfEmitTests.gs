// <copyright file="Issue1989MultiArityOpenGenericTypeOfEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1989: same-base-name multi-arity BCL generic families (`Func`,
/// `Action`, …) broke the #1915 bare-name open-generic `typeof(...)`
/// fallback — `typeof(Func)` stayed GS0113 (every arity 1..16 matches
/// "Func", so the fallback correctly bails as ambiguous), and `typeof(Action)`
/// SILENTLY resolved to the non-generic `System.Action` instead of ever
/// reaching a generic `Action`N`.
///
/// G# has no `Name<>`/`Name<,>` unbound-generic spelling
/// (generics use `Name[T1, T2]` brackets), so the fix carries the
/// explicit requested arity the same way C# derives it from comma count —
/// via `_` placeholder type arguments: `typeof(Func[_])` is arity 1,
/// `typeof(Func[_, _])` is arity 2, etc. This always requires the
/// arity-suffixed generic and never falls back to a same-named non-generic
/// type, fixing the `Action` silent-wrong-type case for good.
open class Issue1989MultiArityOpenGenericTypeOfEmitTests {
    @Fact
    func EndToEnd_FuncArity1_TypeOf_ResolvesGenericOneArity() {
        const source = `package i1989func1
import System

func Main() { System.Console.WriteLine(typeof(Func[_]).Name) }`
        let output = CompileAndRun(source)
        Assert.Equal("Func`1${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_FuncArity2_TypeOf_ResolvesGenericTwoArity() {
        const source = `package i1989func2
import System

func Main() { System.Console.WriteLine(typeof(Func[_, _]).Name) }`
        let output = CompileAndRun(source)
        Assert.Equal("Func`2${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ActionArity1_TypeOf_ResolvesGenericOneArity_NotNonGenericAction() {
        const source = `package i1989action1
import System

func Main() { System.Console.WriteLine(typeof(Action[_]).Name) }`
        let output = CompileAndRun(source)
        Assert.Equal("Action`1${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ActionArity2_TypeOf_ResolvesGenericTwoArity() {
        const source = `package i1989action2
import System

func Main() { System.Console.WriteLine(typeof(Action[_, _]).Name) }`
        let output = CompileAndRun(source)
        Assert.Equal("Action`2${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_QualifiedValueTaskArity1_TypeOf_ResolvesGenericDefinition() {
        const source = `package i3412valuetask
import System

func Main() {
    Console.WriteLine(typeof(System.Threading.Tasks.ValueTask[_]).Name)
}`
        let output = CompileAndRun(source)
        Assert.Equal("ValueTask`1${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_DictionaryEnumerator_TypeOf_ResolvesOpenNestedDefinition() {
        const source = `package i3589dictionaryenumerator
import System
import System.Collections.Generic

func Main() { Console.WriteLine(typeof(Dictionary[_, _].Enumerator).FullName) }`
        let output = CompileAndRun(source)
        Assert.Equal("System.Collections.Generic.Dictionary`2+Enumerator${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_BareAction_TypeOf_StillResolvesNonGenericAction() {
        const source = `package i1989actionbare
import System

func Main() { System.Console.WriteLine(typeof(Action).Name) }`
        let output = CompileAndRun(source)
        Assert.Equal("Action${Environment.NewLine}", output)
    }

    /// Issue #2012 (S3): hardens the existing emit coverage — which only
    /// asserted on `.Name` (a string that collapses closed and open
    /// generics to the same value, e.g. both `Func<int>` and open
    /// `Func`1` print "Func`1") — with an actual reflection (cref:Type) equality check against
    /// `typeof(System.Func<>)`,
    /// proving `typeof(Func[_])` really is the same CLR open-generic
    /// type definition, not merely a type whose name happens to match.
    @Fact
    func EndToEnd_FuncArity1_TypeOf_ReflectionEquals_ClrOpenGenericFuncDefinition() {
        const source = `package i2012s3func1
import System

func Main() { System.Console.WriteLine(typeof(Func[_]).AssemblyQualifiedName) }`
        let output = CompileAndRun(source)
        let resolvedType Type? = Type.GetType(output.Trim())
        Assert.Equal(typeof(Func[_]), resolvedType)
    }

    /// Issue #2012 (N3): when the requested arity resolves to two or more
    /// DIFFERENT CLR types across the imports in scope, the previous
    /// behavior misreported "type doesn't exist" (GS0113). This is a genuine
    /// ambiguity, not an absence, and now reports GS0471 instead.
    @Fact
    func ExplicitArity_AmbiguousAcrossTwoImportedAssemblies_ReportsGS0471() {
        let tempDir = Directory.CreateTempSubdirectory("gs_2012_amb_").FullName
        try {
            let aDll = Path.Combine(tempDir, "a.dll")
            let bDll = Path.Combine(tempDir, "b.dll")
            CompileLibrary(`package pkg.a
class Foo[T any] {
}
`, aDll, tempDir)
            CompileLibrary(`package pkg.b
class Foo[T any] {
}
`, bDll, tempDir)
            const source = `package pkg.c
import pkg.a
import pkg.b

func Main() {
    let t = typeof(Foo[_])
}`
            let srcPath = Path.Combine(tempDir, "c.gs")
            File.WriteAllText(srcPath, source)
            let dllPath = Path.Combine(tempDir, "c.dll")
            let args = []string{
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/r:" + aDll,
                "/r:" + bDll,
                "/nowarn:GS9100",
                srcPath
            }
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
            Assert.NotEqual(0, compileExit)
            Assert.Contains("GS0471", stdoutWriter.ToString() + stderrWriter.ToString())
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    shared {
        private func CompileLibrary(source string, dllPath string, tempDir string) {
            let srcPath = Path.Combine(tempDir, Path.GetFileNameWithoutExtension(dllPath) + ".gs")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + dllPath, "/target:library", "/targetframework:net10.0", srcPath}
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
            Assert.True(compileExit == 0, (`gsc failed compiling library ` + "$dllPath" + `:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1989_exe_").FullName
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
