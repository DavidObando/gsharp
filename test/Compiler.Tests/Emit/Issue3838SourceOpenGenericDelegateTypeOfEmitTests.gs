// <copyright file="Issue3838SourceOpenGenericDelegateTypeOfEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3838 end-to-end: `typeof(Mapper[_])` over a NAMED GENERIC
/// DELEGATE declared in the compilation being built must bind and emit an
/// `ldtoken` that loads.
///
/// Two independent halves, both required. The binder's declared-type fallback
/// for the explicit-arity unbound-generic spelling (#3678/#3677) only
/// recognised `StructSymbol` and `InterfaceSymbol` definitions, so a
/// source generic delegate reported GS0113 carrying the arity-mangled metadata
/// name the caller never wrote. Fixing only that half compiles and then dies at
/// run time with (cref:BadImageFormatException), because the emitter's
/// open-generic-definition `ldtoken` arm had the same missing case and
/// fell back to the generic-REFERENCE TypeSpec (`Mapper<!0>`), whose
/// VAR slot has no binding in that scope. That is why this test EXECUTES the
/// emitted assembly rather than asserting on binding alone.
open class Issue3838SourceOpenGenericDelegateTypeOfEmitTests {
    @Fact
    func SourceOpenGenericDelegateTypeOf_VerifiesAndRuns() {
        const Source = `package Demo
import System

delegate Mapper[T](value T) int32;
delegate Pair[A, B](a A, b B) string;
delegate Plain(value int32) int32;

Console.WriteLine(typeof(Mapper[_]).FullName)
Console.WriteLine(typeof(Mapper[_]).IsGenericTypeDefinition)
Console.WriteLine(typeof(Pair[_, _]).FullName)
Console.WriteLine(typeof(Mapper[_]).MakeGenericType(typeof(string)).GetGenericArguments()[0].FullName)

// Anti-vacuity: these spellings already worked before #3838 and must
// keep working — the fix must not disturb the bound or non-generic
// delegate paths.
Console.WriteLine(typeof(Plain).FullName)
Console.WriteLine(typeof(Mapper[int32]).IsGenericTypeDefinition)`
        let expected = string.Join(
            Environment.NewLine,
            "Demo.Mapper`1",
            "True",
            "Demo.Pair`2",
            "System.String",
            "Demo.Plain",
            "False"
        ) +
            Environment.NewLine
        Assert.Equal(expected, CompileVerifyAndRun(Source))
    }

    shared {
        private func CompileVerifyAndRun(source string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue3838_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(stdout)
                Console.SetError(stderr)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, (`gsc failed:
` + "$stdout" + `
` + "$stderr"))
                IlVerifier.Verify(outputPath)
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = directory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"))
                startInfo.ArgumentList.Add(outputPath)
                using let process Process? = Process.Start(startInfo)
                let runtimeOutput = process!!.StandardOutput.ReadToEnd()
                let runtimeError = process!!.StandardError.ReadToEnd()
                Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(process!!.ExitCode == 0, (`runtime failed:
` + "$runtimeOutput" + `
` + "$runtimeError"))
                return runtimeOutput.ReplaceLineEndings(Environment.NewLine)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
