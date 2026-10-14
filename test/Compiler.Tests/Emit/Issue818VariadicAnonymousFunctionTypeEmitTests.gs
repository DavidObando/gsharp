// <copyright file="Issue818VariadicAnonymousFunctionTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #818 — emit / IL-verification coverage for variadic parameters in
/// anonymous function-type clauses `(T1, ...T2) -> R`.
/// ADR-0102 follow-up: ensures the indirect-call site through a variable
/// typed as an anonymous variadic function-type packs trailing arguments
/// into a slice, accepts a pre-built slice (pass-through), and IL-verifies.
open class Issue818VariadicAnonymousFunctionTypeEmitTests {
    @Fact
    func AnonymousVariadicLocal_AutoPacks_TrailingArgs() {
        let source = `package P
import System

let f (int32, ...string) -> int32 = (a, args) -> a + args.Length

Console.WriteLine(f(1, "a", "b", "c"))`
        let output = CompileAndRun(source)
        Assert.Equal("4${Environment.NewLine}", output)
    }

    @Fact
    func AnonymousVariadicLocal_PassThroughSlice() {
        let source = `package P
import System

let f (int32, ...string) -> int32 = (a, args) -> a + args.Length

Console.WriteLine(f(10, []string{"x", "y"}))`
        let output = CompileAndRun(source)
        Assert.Equal("12${Environment.NewLine}", output)
    }

    @Fact
    func AnonymousVariadicLocal_EmptyTrailing_ProducesEmptySlice() {
        let source = `package P
import System

let f (int32, ...string) -> int32 = (a, args) -> a + args.Length

Console.WriteLine(f(7))`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func AnonymousVariadicLocal_NoFixed_PacksAllArgs() {
        let source = `package P
import System

let g (...int32) -> int32 = (xs) -> xs.Length

Console.WriteLine(g(1, 2, 3, 4, 5))
Console.WriteLine(g())`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Theory
    @InlineData("async () -> T", "", "nil", "0")
    @InlineData("async () -> T", "", "\"present\"", "1")
    @InlineData("List[async () -> T]", "[string?]", "nil", "0")
    @InlineData("List[async () -> T]", "[string?]", "\"present\"", "1")
    @InlineData("Span[async () -> T]", "[string?]", "nil", "0")
    @InlineData("Span[async () -> T]", "[string?]", "\"present\"", "1")
    @InlineData("ReadOnlySpan[async () -> T]", "[string?]", "nil", "0")
    @InlineData("ReadOnlySpan[async () -> T]", "[string?]", "\"present\"", "1")
    func AsyncVariadicSelector_NullableResult_PreservesDelegateCarrierType(
        carrier string,
        typeArguments string,
        value string,
        expected string
    ) {
        let source = `package P
import System
import System.Collections.Generic
import System.Linq
import System.Threading.Tasks

func Build[T](selectors ...CARRIER) IEnumerable[T] ->
    []T{selectors[0]().GetAwaiter().GetResult()}

let text string? = VALUE
Console.WriteLine(BuildTYPEARGS(async () -> text).OfType[string]().Count())`.Replace(
            "VALUE",
            value,
            StringComparison.Ordinal
        ).Replace(
            "TYPEARGS",
            typeArguments,
            StringComparison.Ordinal
        ).Replace("CARRIER", carrier, StringComparison.Ordinal)
        Assert.Equal(expected + Environment.NewLine, CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue818_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
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
                using let proc Process? = Process.Start(psi)
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
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
