// <copyright file="Issue663UserDefinedConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #663: user-defined CLR conversion operators (op_Explicit/op_Implicit)
/// and nullable-type-as-function-call cast form (`string?(x)`).
/// Each test compiles via in-process <c>gsc</c>, IL-verifies the PE, then runs
/// under <c>dotnet exec</c> and asserts captured stdout.
/// </summary>
public class Issue663UserDefinedConversionEmitTests
{
    [Fact]
    public void JsonNode_Explicit_String_Via_TypeFnCast()
    {
        // string(node["name"]!!) — non-nullable type-fn cast that invokes
        // op_Explicit(JsonNode) → string.
        var source = """
            package Test
            import System
            import System.Text.Json.Nodes

            let obj = JsonObject()
            obj["name"] = JsonValue.Create("ada")
            let name = string(obj["name"]!!)
            Console.WriteLine(name)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("ada\n", output);
    }

    [Fact]
    public void JsonNode_Explicit_NullableString_Via_NullableTypeFnCast()
    {
        // string?(node["name"]) — nullable-type-fn cast form (parser fix).
        var source = """
            package Test
            import System
            import System.Text.Json.Nodes

            let obj = JsonObject()
            obj["name"] = JsonValue.Create("ada")
            let name = string?(obj["name"])
            Console.WriteLine(name!!)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("ada\n", output);
    }

    [Fact]
    public void JsonNode_Explicit_NullableString_Returns_Nil_For_Missing_Key()
    {
        // string?(node["absent"]) should return nil when the key is absent.
        var source = """
            package Test
            import System
            import System.Text.Json.Nodes

            let obj = JsonObject()
            obj["name"] = JsonValue.Create("ada")
            let alias = string?(obj["absent"])
            if alias == nil {
                Console.WriteLine("nil")
            } else {
                Console.WriteLine(alias!!)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("nil\n", output);
    }

    [Fact]
    public void JsonNode_Explicit_Int32_Via_TypeFnCast()
    {
        // int32(node["age"]!!) — non-nullable type-fn cast that invokes
        // op_Explicit(JsonNode) → int32.
        var source = """
            package Test
            import System
            import System.Text.Json.Nodes

            let obj = JsonObject()
            obj["age"] = JsonValue.Create(42)
            let age = int32(obj["age"]!!)
            Console.WriteLine(age)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void JsonNode_Explicit_Bool_Via_TypeFnCast()
    {
        // bool(node["flag"]!!) — non-nullable type-fn cast that invokes
        // op_Explicit(JsonNode) → bool.
        var source = """
            package Test
            import System
            import System.Text.Json.Nodes

            let obj = JsonObject()
            obj["flag"] = JsonValue.Create(true)
            let flag = bool(obj["flag"]!!)
            Console.WriteLine(flag)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void JsonNode_Explicit_NullableInt32_Via_NullableTypeFnCast()
    {
        // int32?(node["age"]) — nullable type-fn cast.
        var source = """
            package Test
            import System
            import System.Text.Json.Nodes

            let obj = JsonObject()
            obj["age"] = JsonValue.Create(42)
            let age = int32?(obj["age"])
            Console.WriteLine(age!!)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source);
        Assert.True(
            exitCode == 0,
            $"gsc failed (exit {exitCode}):\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue663_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
            };

            foreach (var reference in TrustedPlatformAssemblies())
            {
                args.Add("/reference:" + reference);
            }

            args.Add("/nowarn:GS9100");
            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            if (compileExit != 0)
            {
                return (compileExit, compileOut.ToString(), compileErr.ToString());
            }

            IlVerifier.Verify(outPath);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");

            if (proc.ExitCode != 0)
            {
                return (proc.ExitCode, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"));
            }

            return (0, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            yield break;
        }

        foreach (var path in tpa.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }
}
