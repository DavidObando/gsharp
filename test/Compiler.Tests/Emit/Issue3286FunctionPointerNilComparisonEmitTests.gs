// <copyright file="Issue3286FunctionPointerNilComparisonEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import System
import System.Diagnostics
import System.IO
import System.Threading
import System.Threading.Tasks
import Xunit

/// Issue #3286: function-pointer equality and inequality use native pointer semantics.
open class Issue3286FunctionPointerNilComparisonEmitTests {
    @Fact
    async func FunctionPointerComparisons_AllValueSources_CompileAndRun() {
        const Source = `package Probe
import System

unsafe func identity(x int32) int32 { return x }
unsafe func other(x int32) int32 { return x + 1 }
unsafe func nilManaged() *func(int32) int32 { return nil }
unsafe func nilCdecl() unmanaged[Cdecl] (int32) -> int32 { return nil }

unsafe class ManagedBox {
    let Value *func(int32) int32
    init(value *func(int32) int32) { Value = value }
}

unsafe class CdeclBox {
    let Value unmanaged[Cdecl] (int32) -> int32
    init(value unmanaged[Cdecl] (int32) -> int32) { Value = value }
}

unsafe {
    var nilFp *func(int32) int32 = nil
    var boundFp *func(int32) int32 = &identity
    var otherFp *func(int32) int32 = &other
    Console.WriteLine(nilFp == nil)
    Console.WriteLine(nil == nilFp)
    Console.WriteLine(nilFp != nil)
    Console.WriteLine(nil != nilFp)
    Console.WriteLine(boundFp == nil)
    Console.WriteLine(nil == boundFp)
    Console.WriteLine(boundFp != nil)
    Console.WriteLine(nil != boundFp)
    Console.WriteLine(boundFp == boundFp)
    Console.WriteLine(boundFp != otherFp)

    var nilUf unmanaged[Cdecl] (int32) -> int32 = nil
    var nilUf2 unmanaged[Cdecl] (int32) -> int32 = nil
    Console.WriteLine(nilUf == nil)
    Console.WriteLine(nil == nilUf)
    Console.WriteLine(nilUf != nil)
    Console.WriteLine(nil != nilUf)
    Console.WriteLine(nilUf == nilUf2)
    Console.WriteLine(nilUf != nilUf2)

    var managedBox = ManagedBox(nil)
    var managedItems = []*func(int32) int32{nil, &identity}
    Console.WriteLine(managedBox.Value == nil)
    Console.WriteLine(managedItems[0] == nil)
    Console.WriteLine(managedItems[1] != nil)
    Console.WriteLine(nilManaged() == nil)

    var cdeclBox = CdeclBox(nil)
    var cdeclItems = []unmanaged[Cdecl] (int32) -> int32{nil, nil}
    Console.WriteLine(cdeclBox.Value == nil)
    Console.WriteLine(cdeclItems[0] == nil)
    Console.WriteLine(cdeclItems[1] != nil)
    Console.WriteLine(nilCdecl() == nil)
}`
        Assert.Equal(`True
True
False
False
False
False
True
True
True
True
True
True
False
False
True
False
True
True
True
True
True
True
False
True
`.ReplaceLineEndings(Environment.NewLine), await CompileAndRun(Source))
    }

    shared {
        private async func CompileAndRun(source string) string {
            let outputDirectory = Path.Combine(AppContext.BaseDirectory, "issue3286", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(outputDirectory)
            try {
                let sourcePath = Path.Combine(outputDirectory, "Program.gs")
                let outputPath = Path.Combine(outputDirectory, "Issue3286.dll")
                File.WriteAllText(sourcePath, source)
                using let standardOut = StringWriter()
                using let standardError = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(standardOut)
                Console.SetError(standardError)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, (`gsc failed (exit ` + "$exitCode" + `):
stdout:
` + "$standardOut" + `
stderr:
` + "$standardError"))
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = outputDirectory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"))
                startInfo.ArgumentList.Add(outputPath)
                using let process = Process.Start(startInfo) ??
                    throw InvalidOperationException("Failed to start dotnet exec.")
                let stdoutTask = process.StandardOutput.ReadToEndAsync()
                let stderrTask = process.StandardError.ReadToEndAsync()
                using let timeout = CancellationTokenSource(TimeSpan.FromSeconds(30))
                try {
                    await process.WaitForExitAsync(timeout.Token)
                } catch (OperationCanceledException) {
                    process.Kill(entireProcessTree: true)
                    Assert.Fail("dotnet exec timed out.")
                }
                let stdout = await stdoutTask
                let stderr = await stderrTask
                Assert.True(process.ExitCode == 0, (`sample exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(outputDirectory, recursive: true)
                } catch { }
            }
        }
    }
}
