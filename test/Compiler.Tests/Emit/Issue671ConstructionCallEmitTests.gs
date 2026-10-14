// <copyright file="Issue671ConstructionCallEmitTests.cs" company="GSharp">
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

/// End-to-end emit tests for the construction-call follow-up of issue #671:
/// a CLR generic invoked as a constructor with one or more G# user-defined
/// type arguments (e.g. `List[MyGs]()`, `Dictionary[string, MyGs]()`,
/// nested generics, fully-qualified type names) compiles, IL-verifies, and
/// runs.
open class Issue671ConstructionCallEmitTests {
    @Fact
    func Construct_ListOfUserClass_Compiles_And_Runs() {
        let source = `package App
import System
import System.Collections.Generic

class MyGs {
    var Name string = ""
}

let xs = List[MyGs]()
xs.Add(MyGs())
xs.Add(MyGs())
Console.WriteLine(xs.Count)`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func Construct_ListOfUserInterface_Compiles_And_Runs() {
        let source = `package App
import System
import System.Collections.Generic

interface IMyGs {
    func GetName() string;
}

let xs = List[IMyGs]()
Console.WriteLine(xs.Count)`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func Construct_KeyValuePairOfStringToUserClass_Compiles_And_Runs() {
        // Multi-type-arg CLR generic ctor where one type argument is a G#
        // user-defined class. The direct Dictionary[K, V]() coverage for
        // this same shape lives in Issue693DictionaryConstructionEmitTests
        // (the follow-up to this PR); KeyValuePair is kept here as a
        // narrowly-typed sibling regression for the multi-arg construction
        // path itself.
        let source = `package App
import System
import System.Collections.Generic

class MyGs {
    var Name string = ""
}

let kvp = KeyValuePair[string, MyGs]("k", MyGs())
Console.WriteLine(kvp.Key)`
        let output = CompileAndRun(source)
        Assert.Equal("k${Environment.NewLine}", output)
    }

    @Fact
    func Construct_NestedListOfListOfUserClass_Compiles_And_Runs() {
        let source = `package App
import System
import System.Collections.Generic

class MyGs {
    var Name string = ""
}

let outer = List[List[MyGs]]()
outer.Add(List[MyGs]())
outer[0].Add(MyGs())
Console.WriteLine(outer.Count)
Console.WriteLine(outer[0].Count)`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}1${Environment.NewLine}", output)
    }

    @Fact
    func Construct_QualifiedListOfUserClass_Compiles_And_Runs() {
        let source = `package App
import System

class MyGs {
    var Name string = ""
}

let xs = System.Collections.Generic.List[MyGs]()
xs.Add(MyGs())
Console.WriteLine(xs.Count)`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func Construct_ListOfClrType_Regression_StillWorks() {
        // Regression guard: a CLR-only type argument (no symbolic substitution)
        // must continue to bind and emit through the existing happy path.
        let source = `package App
import System
import System.Collections.Generic

let xs = List[int32]()
xs.Add(1)
xs.Add(2)
xs.Add(3)
Console.WriteLine(xs.Count)`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    @Fact
    func Construct_ListOfString_Regression_StillWorks() {
        let source = `package App
import System
import System.Collections.Generic

let xs = List[string]()
xs.Add("a")
xs.Add("b")
Console.WriteLine(xs.Count)`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue671_ctor_").FullName
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
