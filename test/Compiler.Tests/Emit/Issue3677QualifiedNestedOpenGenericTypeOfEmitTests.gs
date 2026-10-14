// <copyright file="Issue3677QualifiedNestedOpenGenericTypeOfEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3677 end-to-end: the qualified (`typeof(A.B[_, _])`) and nested
/// (`typeof(Outer[_].Inner[_])`) open-generic spellings over types declared
/// in the compilation being built must bind AND emit an `ldtoken` that
/// loads. #3678 showed the two halves are independent: an open user generic
/// definition emitted through the generic-REFERENCE TypeSpec path encodes
/// `Name<!0>`, whose VAR slot has no binding in that scope, so the PE
/// compiles and then dies with `BadImageFormatException` the moment the
/// `typeof` runs. This test verifies the IL mechanically and then EXECUTES
/// the emitted assembly, asserting the (cref:Type) each spelling yields
/// is the expected open generic definition.
open class Issue3677QualifiedNestedOpenGenericTypeOfEmitTests {
    @Fact
    func QualifiedAndNestedSourceOpenGenericTypeOf_VerifiesAndRuns() {
        const Source = `package Demo
import System

class Fixtures {
    interface IQuery[T] {}
    interface IChain[A, B, C, D] {}
}

class Outer[T] {
    class Inner[U] {}
    class PlainInner {}
}

Console.WriteLine(typeof(Fixtures.IQuery[_]).FullName)
Console.WriteLine(typeof(Fixtures.IQuery[_]).IsGenericTypeDefinition)
Console.WriteLine(typeof(Fixtures.IChain[_, _, _, _]).FullName)
Console.WriteLine(typeof(Demo.Fixtures.IChain[_, _, _, _]).FullName)
Console.WriteLine(typeof(Fixtures.IQuery[_]).MakeGenericType(typeof(int32)).GetGenericArguments()[0].FullName)
Console.WriteLine(typeof(Outer[_].Inner[_]).FullName)
Console.WriteLine(typeof(Outer[_].Inner[_]).GetGenericArguments().Length)
Console.WriteLine(typeof(Outer[_].PlainInner).FullName)
Console.WriteLine(typeof(Outer[_].PlainInner).IsGenericTypeDefinition)
Console.WriteLine(typeof(Fixtures3677.IPackaged[_]).FullName)
Console.WriteLine(typeof(Fixtures3677.PackagedOuter[_].Inner[_]).FullName)`
        // The shape migrated code actually has: in C# the qualifier is a
        // NAMESPACE, spelled relative to the referencing one.
        const PackagedSource = `package Demo.Fixtures3677

interface IPackaged[T] {}

class PackagedOuter[T] {
    class Inner[U] {}
}`
        let expected = string.Join(
            Environment.NewLine,
            "Demo.Fixtures+IQuery`1",
            "True",
            "Demo.Fixtures+IChain`4",
            "Demo.Fixtures+IChain`4",
            "System.Int32",
            "Demo.Outer`1+Inner`1",
            "2",
            "Demo.Outer`1+PlainInner",
            "True",
            "Demo.Fixtures3677.IPackaged`1",
            "Demo.Fixtures3677.PackagedOuter`1+Inner`1"
        ) +
            Environment.NewLine
        Assert.Equal(expected, CompileVerifyAndRun(Source, PackagedSource))
    }

    shared {
        private func CompileVerifyAndRun(source string, packagedSource string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue3677_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let packagedPath = Path.Combine(directory, "fixtures.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                File.WriteAllText(packagedPath, packagedSource)
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(stdout)
                Console.SetError(stderr)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{
                            "/out:" + outputPath,
                            "/target:exe",
                            "/targetframework:net10.0",
                            packagedPath,
                            sourcePath
                        }
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
