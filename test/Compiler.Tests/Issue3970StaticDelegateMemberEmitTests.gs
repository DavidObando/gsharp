// <copyright file="Issue3970StaticDelegateMemberEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #3970: a static delegate-typed field/property on an imported type
/// was not invocable (`Reg.Cb()`) even though the same member on a
/// source-declared (same-compilation) type and the instance/imported case
/// (`bag.OnAsk()`, issue #527) both worked. Static method lookup on the
/// imported static branch never fell back to a delegate-typed field/property
/// after missing on name, so the call reported GS0159 "Cannot find function".
open class Issue3970StaticDelegateMemberEmitTests {
    @Fact
    func StaticDelegateField_OnImportedType_IsInvocable() {
        // The exact issue-body repro.
        let (exit, output, compileLog) = CompileAndRun(`package Consumer
import System
import LibFour

func Main() {
    Console.WriteLine(Reg.Cb())
}`)
        Assert.True(exit == 0, compileLog)
        Assert.DoesNotContain("GS0159", compileLog)
        Assert.Equal("static-delegate", output.Trim())
    }

    @Fact
    func StaticDelegateField_OnImportedType_ReadThroughLocal_StillInvocable() {
        // Regression guard: reading the static delegate into a local and
        // invoking through the local already worked before the fix (it goes
        // through the ordinary static-member-read + bare-delegate-call
        // paths); this must keep working alongside the direct-call fix.
        let (exit, output, compileLog) = CompileAndRun(`package Consumer
import System
import LibFour

func Main() {
    var f = Reg.Cb
    Console.WriteLine(f())
}`)
        Assert.True(exit == 0, compileLog)
        Assert.Equal("static-delegate", output.Trim())
    }

    @Fact
    func StaticDelegateField_WithArguments_OnImportedType_IsInvocable() {
        // The fallback must route through the same Invoke-overload-resolution
        // path as the instance case, so arguments flow correctly (not just
        // the zero-arity shape from the issue body).
        const AdderLibrary = `package LibFour
import System

class Adder {
    shared {
        let Add Func[int32, int32, int32] = func(a int32, b int32) int32 { return a + b }
    }
}`
        let (exit, output, compileLog) = CompileAndRun(`package Consumer
import System
import LibFour

func Main() {
    Console.WriteLine(Adder.Add(3, 4))
}`, AdderLibrary)
        Assert.True(exit == 0, compileLog)
        Assert.DoesNotContain("GS0159", compileLog)
        Assert.Equal("7", output.Trim())
    }

    shared {
        private const Library string = `package LibFour
import System

class Reg {
    shared {
        let Cb Func[string] = func() string { return "static-delegate" }
    }
}`

        private func CompileAndRun(appSource string)(Exit int32, Output string, CompileLog string) -> CompileAndRun(
            appSource,
            Library
        )

        private func CompileAndRun(appSource string, library string)(Exit int32, Output string, CompileLog string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_3970_static_delegate_").FullName
            try {
                // The emitted assembly name is the source's package clause (not
                // the /out file name), so the reference must be named to match
                // (package LibFour) or the consumer's AssemblyRef won't resolve
                // at load time.
                let libPath = Path.Combine(tempDir, "LibFour.dll")
                let libLog = Compile(tempDir, "Lib.gs", library, libPath, "/target:library")
                Assert.True(File.Exists(libPath), "library compile failed:\n" + libLog)
                let appPath = Path.Combine(tempDir, "App.dll")
                let appLog = Compile(tempDir, "App.gs", appSource, appPath, "/target:exe", "/reference:" + libPath)
                if !File.Exists(appPath) {
                    return (-1, string.Empty, appLog)
                }
                let (exit, output) = RunDotnet(appPath)
                return (exit, output, appLog)
            } finally {
                Directory.Delete(tempDir, recursive: true)
            }
        }

        private func Compile(dir string, fileName string, source string, outPath string, extra ...string) string {
            let srcPath = Path.Combine(dir, fileName)
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/targetframework:net10.0"}
            args.AddRange(extra)
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return compileOut.ToString() + compileErr.ToString()
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let output = StringBuilder()
            output.Append(process.StandardOutput.ReadToEnd())
            output.Append(process.StandardError.ReadToEnd())
            process.WaitForExit()
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
