// <copyright file="Issue2896StructObjectOverrideTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;
using CompilerProgram = GSharp.Compiler.Program;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2896: plain structs may override Object virtual methods, including
/// calls dispatched through an object-typed receiver. The evaluator's shared
/// user-type dispatch path also preserves most-derived class overrides.
/// </summary>
[Collection("ConsoleIo")]
public class Issue2896StructObjectOverrideTests
{
    [Theory]
    [InlineData("""
        package Issue2896.TopLevel
        import System

        struct Value {
            var Number int32
            override func ToString() string -> "OVERRIDDEN-11"
            override func Equals(value object) bool -> false
            override func GetHashCode() int32 -> 289611
        }

        let direct = Value{Number: 7}
        let peer object = Value{Number: 7}
        let boxed object = direct
        Console.WriteLine(direct.ToString())
        Console.WriteLine(boxed.ToString())
        Console.WriteLine(direct.Equals(peer))
        Console.WriteLine(boxed.Equals(peer))
        Console.WriteLine(direct.GetHashCode())
        Console.WriteLine(boxed.GetHashCode())
        """)]
    [InlineData("""
        package Issue2896.Function
        import System

        struct Value {
            var Number int32
            override func ToString() string -> "OVERRIDDEN-11"
            override func Equals(value object) bool -> false
            override func GetHashCode() int32 -> 289611
        }

        func Run() {
            let direct = Value{Number: 7}
            let peer object = Value{Number: 7}
            let boxed object = direct
            Console.WriteLine(direct.ToString())
            Console.WriteLine(boxed.ToString())
            Console.WriteLine(direct.Equals(peer))
            Console.WriteLine(boxed.Equals(peer))
            Console.WriteLine(direct.GetHashCode())
            Console.WriteLine(boxed.GetHashCode())
        }

        Run()
        """)]
    public void AllObjectOverrides_DirectAndBoxed_DispatchAtTopLevelAndInsideFunction(string source)
    {
        Assert.Equal(
            "OVERRIDDEN-11\nOVERRIDDEN-11\nFalse\nFalse\n289611\n289611\n",
            Evaluate(source));
    }

    [Theory]
    [InlineData(false, "gsc-evaluate")]
    [InlineData(false, "gsc-emit")]
    [InlineData(false, "gsi")]
    [InlineData(true, "gsc-evaluate")]
    [InlineData(true, "gsc-emit")]
    [InlineData(true, "gsi")]
    public async Task ClassObjectOverrideChain_UsesMostDerivedOverrideAcrossDrivers(
        bool insideFunction,
        string driver)
    {
        var suffix = Guid.NewGuid().ToString("N");
        var source = BuildClassOverrideChainSource(insideFunction, suffix);

        Assert.Equal("L0-11\nL1-22\nL2-33\n", await RunDriverAsync(source, suffix, driver));
    }

    [Fact]
    public void GenericInterfaceOperatorNestedAndSharedShapes_DispatchOverrides()
    {
        const string Source = """
            package Issue2896.Shapes
            import System

            interface IMarker {
                func Marker() string;
            }

            struct GenericValue[T any] {
                var Item T
                override func ToString() string -> "GENERIC-OVERRIDDEN-23"
            }

            struct InterfaceValue : IMarker {
                var Number int32
                func Marker() string -> "MARKER-31"
                override func ToString() string -> "INTERFACE-OVERRIDDEN-31"
            }

            struct OperatorValue : IEquatable[OperatorValue] {
                var Number int32
                func Equals(other OperatorValue) bool -> Number == other.Number
                override func Equals(value object) bool -> false
                override func GetHashCode() int32 -> 289637
            }

            func (left OperatorValue) operator ==(right OperatorValue) bool ->
                left.Number == right.Number

            func (left OperatorValue) operator !=(right OperatorValue) bool ->
                left.Number != right.Number

            class Container {
                struct NestedValue {
                    var Number int32
                    override func ToString() string -> "NESTED-OVERRIDDEN-41"
                }
            }

            struct SharedValue {
                var Number int32
                shared {
                    func Label() string -> "SHARED-43"
                }
                override func ToString() string -> "SHARED-OVERRIDDEN-43"
            }

            func PrintGeneric[T any](value T) {
                Console.WriteLine(value.ToString())
            }

            let genericValue = GenericValue[int32]{Item: 7}
            Console.WriteLine(genericValue.ToString())
            PrintGeneric(genericValue)

            let interfaceValue = InterfaceValue{Number: 7}
            let boxedInterface object = interfaceValue
            Console.WriteLine(interfaceValue.Marker())
            Console.WriteLine(interfaceValue.ToString())
            Console.WriteLine(boxedInterface.ToString())

            let operatorLeft = OperatorValue{Number: 7}
            let operatorRight = OperatorValue{Number: 7}
            let boxedOperator object = operatorLeft
            Console.WriteLine(operatorLeft == operatorRight)
            Console.WriteLine(operatorLeft.Equals(operatorRight))
            Console.WriteLine(boxedOperator.Equals(operatorRight))
            Console.WriteLine(boxedOperator.GetHashCode())

            let nestedValue = Container.NestedValue{Number: 7}
            let boxedNested object = nestedValue
            Console.WriteLine(nestedValue.ToString())
            Console.WriteLine(boxedNested.ToString())

            let sharedValue = SharedValue{Number: 7}
            let boxedShared object = sharedValue
            Console.WriteLine(SharedValue.Label())
            Console.WriteLine(sharedValue.ToString())
            Console.WriteLine(boxedShared.ToString())
            """;

        Assert.Equal(
            """
            GENERIC-OVERRIDDEN-23
            GENERIC-OVERRIDDEN-23
            MARKER-31
            INTERFACE-OVERRIDDEN-31
            INTERFACE-OVERRIDDEN-31
            True
            True
            False
            289637
            NESTED-OVERRIDDEN-41
            NESTED-OVERRIDDEN-41
            SHARED-43
            SHARED-OVERRIDDEN-43
            SHARED-OVERRIDDEN-43
            """.Replace("\r\n", "\n", StringComparison.Ordinal) + "\n",
            Evaluate(Source));
    }

    [Fact]
    public void DataAndDefaultStructBehavior_RemainsUnchanged()
    {
        const string Source = """
            package Issue2896.Controls
            import System

            data struct DataValue {
                var Number int32
            }

            struct DefaultValue {
                var Number int32
            }

            let dataValue = DataValue{Number: 7}
            let boxedData object = dataValue
            Console.WriteLine(dataValue.ToString())
            Console.WriteLine(boxedData.ToString())

            let defaultValue = DefaultValue{Number: 7}
            let boxedDefault object = defaultValue
            Console.WriteLine(defaultValue.ToString())
            Console.WriteLine(boxedDefault.ToString())
            """;

        Assert.Equal(
            "DataValue(Number=7)\nDataValue(Number=7)\n"
                + "DefaultValue(Number=7)\nDefaultValue(Number=7)\n",
            Evaluate(Source));
    }

    private static string Evaluate(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source));

        using var outWriter = new StringWriter();
        var previousOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
            var errors = result.Diagnostics.Where(diagnostic => diagnostic.IsError).ToArray();
            Assert.True(
                errors.Length == 0,
                "evaluation failed:\n" + string.Join("\n", errors.Select(diagnostic => diagnostic.ToString())));
        }
        finally
        {
            Console.SetOut(previousOut);
        }

        return outWriter.ToString().Replace("\r\n", "\n", StringComparison.Ordinal);
    }

    private static string BuildClassOverrideChainSource(bool insideFunction, string suffix)
    {
        var declarations = $$"""
            package Issue2896.Driver{{suffix}}
            import System

            open class L0{{suffix}} {
                open override func ToString() string -> "L0-11"
            }

            open class L1{{suffix}} : L0{{suffix}} {
                open override func ToString() string -> "L1-22"
            }

            class L2{{suffix}} : L1{{suffix}} {
                override func ToString() string -> "L2-33"
            }
            """;
        var calls = $$"""
            let l0 object = L0{{suffix}}()
            let l1 object = L1{{suffix}}()
            let l2 object = L2{{suffix}}()
            Console.WriteLine(l0.ToString())
            Console.WriteLine(l1.ToString())
            Console.WriteLine(l2.ToString())
            """;

        return insideFunction
            ? declarations + "\nfunc Run" + suffix + "() {\n" + calls + "\n}\nRun" + suffix + "()\n"
            : declarations + "\n" + calls;
    }

    private static async Task<string> RunDriverAsync(string source, string suffix, string driver)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2896StructObjectOverrideTests),
            suffix);
        Assert.False(Directory.Exists(directory));
        Directory.CreateDirectory(directory);
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory));
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            File.WriteAllText(sourcePath, source);

            return driver switch
            {
                "gsc-evaluate" => RunCompilerEvaluation(sourcePath),
                "gsc-emit" => await RunEmittedBinaryAsync(directory, sourcePath, suffix),
                "gsi" => RunInterpreter(sourcePath),
                _ => throw new ArgumentOutOfRangeException(nameof(driver), driver, null),
            };
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static string RunCompilerEvaluation(string sourcePath)
    {
        var result = CaptureConsole(() => CompilerProgram.Main(new[] { sourcePath }));
        Assert.Equal(0, result.ExitCode);
        Assert.Equal(string.Empty, result.StandardError);
        Assert.EndsWith("Success.\n", result.StandardOutput, StringComparison.Ordinal);
        return result.StandardOutput[..^"Success.\n".Length];
    }

    private static string RunInterpreter(string sourcePath)
    {
        var result = CaptureConsole(() => GSharp.Repl.Program.Main(new[] { sourcePath }));
        Assert.Equal(0, result.ExitCode);
        Assert.Equal(string.Empty, result.StandardError);
        return result.StandardOutput;
    }

    private static async Task<string> RunEmittedBinaryAsync(string directory, string sourcePath, string suffix)
    {
        var assemblyName = "Issue2896Driver" + suffix;
        var outputPath = Path.Combine(directory, assemblyName + ".dll");
        var compile = CaptureConsole(() => CompilerProgram.Main(new[]
        {
            "/out:" + outputPath,
            "/assemblyname:" + assemblyName,
            "/target:exe",
            "/targetframework:net10.0",
            sourcePath,
        }));
        Assert.Equal(0, compile.ExitCode);
        Assert.Equal(string.Empty, compile.StandardError);

        var assembly = Assembly.Load(File.ReadAllBytes(outputPath));
        Assert.NotEmpty(assembly.GetTypes());

        var runtimeConfigPath = Path.ChangeExtension(outputPath, ".runtimeconfig.json");
        File.WriteAllText(runtimeConfigPath, """
            {
              "runtimeOptions": {
                "tfm": "net10.0",
                "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
              }
            }
            """);

        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = directory,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(runtimeConfigPath);
        startInfo.ArgumentList.Add(outputPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start emitted assembly");
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        try
        {
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30));
        }
        catch (TimeoutException)
        {
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            throw new Xunit.Sdk.XunitException("Emitted assembly timed out");
        }

        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        Assert.Equal(0, process.ExitCode);
        Assert.Equal(string.Empty, stderr);
        return stdout.Replace("\r\n", "\n", StringComparison.Ordinal);
    }

    private static (int ExitCode, string StandardOutput, string StandardError) CaptureConsole(Func<int> action)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        try
        {
            Console.SetOut(stdout);
            Console.SetError(stderr);
            var exitCode = action();
            return (
                exitCode,
                stdout.ToString().Replace("\r\n", "\n", StringComparison.Ordinal),
                stderr.ToString().Replace("\r\n", "\n", StringComparison.Ordinal));
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }
}
