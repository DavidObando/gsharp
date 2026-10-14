// <copyright file="Issue2613StaticDelegateMemberEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

class Issue2613StaticDelegateMemberEmitTests {
    @Fact
    func StaticDelegateMembers_AssignReadAndInvoke_CompileWithoutLookupDiagnostics() {
        let (exitCode, diagnostics, _, directory) = Compile(
            Source.Replace("Issue2613", "Issue2613Compile", StringComparison.Ordinal)
        )
        try {
            Assert.True(exitCode == 0, diagnostics)
            Assert.DoesNotContain("GS0158", diagnostics, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0159", diagnostics, StringComparison.Ordinal)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func StaticDelegateMembers_AssignReadAndInvoke_Run() {
        let (exitCode, diagnostics, assembly, directory) = Compile(
            Source.Replace("Issue2613", "Issue2613Runtime", StringComparison.Ordinal)
        )
        try {
            Assert.True(exitCode == 0, diagnostics)
            IlVerifier.Verify(assembly)
            File.WriteAllText(Path.ChangeExtension(assembly, "runtimeconfig.json"), `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
            let startInfo = ProcessStartInfo("dotnet", "exec \"" + assembly + "\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process = Process.Start(startInfo)!!
            let output = process.StandardOutput.ReadToEnd()
            let error = process.StandardError.ReadToEnd()
            process.WaitForExit()
            Assert.True(process.ExitCode == 0, error)
            Assert.Equal(
                "12${Environment.NewLine}12${Environment.NewLine}22${Environment.NewLine}32${Environment.NewLine}",
                output.ReplaceLineEndings(Environment.NewLine)
            )
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private const Source string = `package Issue2613
import System

delegate Transform(value int32) int32;

class Callbacks {
    shared {
        var Field (int32) -> int32 = (value int32) -> value + 1
        private var propertyValue (int32) -> int32 = (value int32) -> value + 2
        prop Property (int32) -> int32 {
            get -> propertyValue
            set { propertyValue = value }
        }
        var Named Transform = (value int32) -> value + 3
    }
}

func Main() {
    Callbacks.Field = (value int32) -> value + 10
    Callbacks.Property = (value int32) -> value + 20
    Callbacks.Named = (value int32) -> value + 30
    let copy = Callbacks.Field
    Console.WriteLine(copy(2))
    Console.WriteLine(Callbacks.Field(2))
    Console.WriteLine(Callbacks.Property(2))
    Console.WriteLine(Callbacks.Named(2))
}`

        private func Compile(source string)(ExitCode int32, Diagnostics string, Assembly string, Directory string) {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue2613", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(
                    []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
                return (exitCode, stdout.ToString() + stderr.ToString(), assemblyPath, directory)
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }
    }
}
