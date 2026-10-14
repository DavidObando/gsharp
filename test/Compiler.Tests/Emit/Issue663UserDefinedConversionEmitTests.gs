// <copyright file="Issue663UserDefinedConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #663: user-defined CLR conversion operators (op_Explicit/op_Implicit)
/// and nullable-type-as-function-call cast form (`string?(x)`).
/// Each test compiles via in-process `gsc`, IL-verifies the PE, then runs
/// under `dotnet exec` and asserts captured stdout.
open class Issue663UserDefinedConversionEmitTests {
    @Fact
    func JsonNode_Explicit_String_Via_TypeFnCast() {
        // string(node["name"]!!) — non-nullable type-fn cast that invokes
        // op_Explicit(JsonNode) → string.
        let source = `package Test
import System
import System.Text.Json.Nodes

let obj = JsonObject()
obj["name"] = JsonValue.Create("ada")
let name = string(obj["name"]!!)
Console.WriteLine(name)`
        let output = CompileAndRun(source)
        Assert.Equal("ada${Environment.NewLine}", output)
    }

    @Fact
    func JsonNode_Explicit_NullableString_Via_NullableTypeFnCast() {
        // string?(node["name"]) — nullable-type-fn cast form (parser fix).
        let source = `package Test
import System
import System.Text.Json.Nodes

let obj = JsonObject()
obj["name"] = JsonValue.Create("ada")
let name = string?(obj["name"])
Console.WriteLine(name!!)`
        let output = CompileAndRun(source)
        Assert.Equal("ada${Environment.NewLine}", output)
    }

    @Fact
    func JsonNode_Explicit_NullableString_Returns_Nil_For_Missing_Key() {
        // string?(node["absent"]) should return nil when the key is absent.
        let source = `package Test
import System
import System.Text.Json.Nodes

let obj = JsonObject()
obj["name"] = JsonValue.Create("ada")
let alias = string?(obj["absent"])
if alias == nil {
    Console.WriteLine("nil")
} else {
    Console.WriteLine(alias!!)
}`
        let output = CompileAndRun(source)
        Assert.Equal("nil${Environment.NewLine}", output)
    }

    @Fact
    func JsonNode_Explicit_Int32_Via_TypeFnCast() {
        // int32(node["age"]!!) — non-nullable type-fn cast that invokes
        // op_Explicit(JsonNode) → int32.
        let source = `package Test
import System
import System.Text.Json.Nodes

let obj = JsonObject()
obj["age"] = JsonValue.Create(42)
let age = int32(obj["age"]!!)
Console.WriteLine(age)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func JsonNode_Explicit_Bool_Via_TypeFnCast() {
        // bool(node["flag"]!!) — non-nullable type-fn cast that invokes
        // op_Explicit(JsonNode) → bool.
        let source = `package Test
import System
import System.Text.Json.Nodes

let obj = JsonObject()
obj["flag"] = JsonValue.Create(true)
let flag = bool(obj["flag"]!!)
Console.WriteLine(flag)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func JsonNode_Explicit_NullableInt32_Via_NullableTypeFnCast() {
        // int32?(node["age"]) — nullable type-fn cast.
        let source = `package Test
import System
import System.Text.Json.Nodes

let obj = JsonObject()
obj["age"] = JsonValue.Create(42)
let age = int32?(obj["age"])
Console.WriteLine(age!!)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func JsonNode_Implicit_String_InIndexerInitializer_Runs() {
        let source = `package Test
import System
import System.Text.Json.Nodes

class Writer {
    shared {
        const SchemaVersion string = "1"

        func Build(resourceName string) JsonObject ->
            JsonObject(){
                ["_schemaVersion"] = Writer.SchemaVersion,
                ["resource"] = resourceName,
            }
    }
}

let obj = Writer.Build("queue")
Console.WriteLine(string?(obj["_schemaVersion"]) ?? "nil")
Console.WriteLine(string?(obj["resource"]) ?? "nil")`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}queue${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source)
            Assert.True(exitCode == 0, (`gsc failed (exit ` + "$exitCode" + `):
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue663_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
                for reference in TrustedPlatformAssemblies() {
                    args.Add("/reference:" + reference)
                }
                args.Add("/nowarn:GS9100")
                args.Add(srcPath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                if compileExit != 0 {
                    return (compileExit, compileOut.ToString(), compileErr.ToString())
                }
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
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                if proc.ExitCode != 0 {
                    return (
                        proc.ExitCode,
                        stdout.ReplaceLineEndings(Environment.NewLine),
                        stderr.ReplaceLineEndings(Environment.NewLine)
                    )
                }
                return (
                    0,
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    stderr.ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func TrustedPlatformAssemblies() sequence[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                yield break
            }
            for path in tpa.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }
    }
}
