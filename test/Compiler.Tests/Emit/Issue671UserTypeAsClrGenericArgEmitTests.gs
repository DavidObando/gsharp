// <copyright file="Issue671UserTypeAsClrGenericArgEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// End-to-end emit tests for issue #671: user-defined G# class/interface used as
/// a type argument to a CLR generic in declaration position (field type, method
/// return type, method parameter type). Verifies that the emitted assembly loads,
/// runs, and produces correct output.
open class Issue671UserTypeAsClrGenericArgEmitTests {
    @Fact
    func Field_ListOfUserClass_Compiles_And_Runs() {
        let source = `package App
import System
import System.Collections.Generic

class MyType {
    var Name string = ""
}

class Container {
    var items List[MyType]
}

let c = Container()
Console.WriteLine("ok")`
        let output = CompileAndRun(source)
        Assert.Equal("ok${Environment.NewLine}", output)
    }

    @Fact
    func MethodReturn_ListOfUserClass_Compiles() {
        // Verifies that a method with return type List[MyType] compiles without
        // error. IL verification of the access pattern is a follow-up concern
        // (the field signature is correctly emitted as List<MyType>).
        let source = `package App
import System
import System.Collections.Generic

class MyType {
    var Name string = ""
}

class Container {
    var items List[MyType]

    func getItems() List[MyType] {
        return items
    }
}

let c = Container()
Console.WriteLine("method-return-ok")`
        let output = CompileAndRun(source)
        Assert.Equal("method-return-ok${Environment.NewLine}", output)
    }

    @Fact
    func MethodParam_ListOfUserClass_Compiles() {
        // Verifies that a method with parameter type List[MyType] compiles
        // without error and the assembly is IL-valid.
        let source = `package App
import System
import System.Collections.Generic

class MyType {
    var Name string = ""
}

class Container {
    func accept(xs List[MyType]) {
    }
}

let c = Container()
Console.WriteLine("method-param-ok")`
        let output = CompileAndRun(source)
        Assert.Equal("method-param-ok${Environment.NewLine}", output)
    }

    @Fact
    func Field_DictionaryStringAndUserClass_Compiles_And_Runs() {
        let source = `package App
import System
import System.Collections.Generic

class MyType {
    var Name string = ""
}

class Container {
    var lookup Dictionary[string, MyType]
}

let c = Container()
Console.WriteLine("dict-ok")`
        let output = CompileAndRun(source)
        Assert.Equal("dict-ok${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue671_emit_").FullName
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
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
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
    }
}
