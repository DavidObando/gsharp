// <copyright file="Issue638NullableValueReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #638: a G# class implementing a CLR interface method that returns
/// <c>Nullable&lt;T&gt;</c> for a value-type <c>T</c> was rejected with
/// GS0187 because the interface-satisfaction check compared the G# binder's
/// <c>NullableTypeSymbol.ClrType</c> (the underlying <c>T</c>) against the
/// interface's <c>Nullable&lt;T&gt;</c> without lifting through
/// <c>NullableLifting.GetEffectiveClrType</c>.
/// </summary>
public class Issue638NullableValueReturnEmitTests
{
    [Fact]
    public void NullableIntReturn_SingleMethodInterface_ReturnsNilAndRealValue()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IMaybeInt
                {
                    int? Try(bool give);
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class MaybeIntImpl : IMaybeInt {
                func Try(give bool) int32? {
                    if give {
                        return 42
                    }
                    return nil
                }
            }

            var m IMaybeInt = MaybeIntImpl{}
            var v = m.Try(true)
            Console.WriteLine(v)
            var n = m.Try(false)
            Console.WriteLine(n == nil)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource);
        Assert.Equal("42\nTrue\n", output);
    }

    [Fact]
    public void NullableBoolReturn_Interface()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IMaybeBool
                {
                    bool? Check();
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class MaybeBoolImpl : IMaybeBool {
                func Check() bool? {
                    return true
                }
            }

            var m IMaybeBool = MaybeBoolImpl{}
            Console.WriteLine(m.Check())
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void NullableDoubleReturn_Interface()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IMaybeDouble
                {
                    double? Compute();
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class MaybeDoubleImpl : IMaybeDouble {
                func Compute() float64? {
                    return 3.14
                }
            }

            var m IMaybeDouble = MaybeDoubleImpl{}
            Console.WriteLine(m.Compute())
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource);
        Assert.Equal("3.14\n", output);
    }

    [Fact]
    public void NullableLongReturn_Interface_ReturnsNilAndRealValue()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IMaybeLong
                {
                    long? Big();
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class MaybeLongImplNil : IMaybeLong {
                func Big() int64? {
                    return nil
                }
            }

            class MaybeLongImplValue : IMaybeLong {
                func Big() int64? {
                    return 42
                }
            }

            var n IMaybeLong = MaybeLongImplNil{}
            Console.WriteLine(n.Big() == nil)
            var v IMaybeLong = MaybeLongImplValue{}
            Console.WriteLine(v.Big())
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource);
        Assert.Equal("True\n42\n", output);
    }

    [Fact]
    public void NullableCharReturn_Interface()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IMaybeChar
                {
                    char? Letter();
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class MaybeCharImpl : IMaybeChar {
                func Letter() char? {
                    return 'A'
                }
            }

            var m IMaybeChar = MaybeCharImpl{}
            Console.WriteLine(m.Letter())
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource);
        Assert.Equal("A\n", output);
    }

    [Fact]
    public void NullableDateTimeReturn_CustomStruct()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IMaybeDateTime
                {
                    System.DateTime? When();
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class MaybeDateTimeImpl : IMaybeDateTime {
                func When() DateTime? {
                    return nil
                }
            }

            var m IMaybeDateTime = MaybeDateTimeImpl{}
            Console.WriteLine(m.When() == nil)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void NullableIntProperty_Interface()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IHasNullableIntProp
                {
                    int? Value { get; }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class HasNullableIntProp : IHasNullableIntProp {
                prop Value int32? { get { return 7 } }
            }

            var p IHasNullableIntProp = HasNullableIntProp{}
            Console.WriteLine(p.Value)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void MethodWithMultipleParams_AndNullableReturn()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IAdder
                {
                    int? Sum(int a, int b);
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class Adder : IAdder {
                func Sum(a int32, b int32) int32? {
                    return a + b
                }
            }

            var adder IAdder = Adder{}
            Console.WriteLine(adder.Sum(3, 4))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void NullableParamAndNullableReturn()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IEcho
                {
                    int? Echo(int? input);
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class Echoer : IEcho {
                func Echo(input int32?) int32? {
                    return input
                }
            }

            var e IEcho = Echoer{}
            Console.WriteLine(e.Echo(99))
            Console.WriteLine(e.Echo(nil) == nil)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource);
        Assert.Equal("99\nTrue\n", output);
    }

    [Fact]
    public void MultipleMethodsMixedReturnShapes()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IMixed
                {
                    int? NullableInt();
                    string PlainString();
                    bool? NullableBool();
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class Mixed : IMixed {
                func NullableInt() int32? { return 10 }
                func PlainString() string { return "hi" }
                func NullableBool() bool? { return nil }
            }

            var m IMixed = Mixed{}
            Console.WriteLine(m.NullableInt())
            Console.WriteLine(m.PlainString())
            Console.WriteLine(m.NullableBool() == nil)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource);
        Assert.Equal("10\nhi\nTrue\n", output);
    }

    [Fact]
    public void NullableStringReturn_ReferenceNullable_Regression()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IMaybeString
                {
                    string? Try();
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class MaybeStringImpl : IMaybeString {
                func Try() string? {
                    return nil
                }
            }

            var m IMaybeString = MaybeStringImpl{}
            Console.WriteLine(m.Try() == nil)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void InheritedInterface_NullableReturn()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IBase
                {
                    int? GetId();
                }
                public interface IDerived : IBase
                {
                    string Name { get; }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class Impl : IDerived {
                func GetId() int32? { return 123 }
                prop Name string { get { return "test" } }
            }

            var d IDerived = Impl{}
            Console.WriteLine(d.GetId())
            Console.WriteLine(d.Name)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource);
        Assert.Equal("123\ntest\n", output);
    }

    [Fact]
    public void ConsoleKeyInfoNullableReturn_FromIssue()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IKeyReader
                {
                    System.ConsoleKeyInfo? ReadKey();
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class KeyReader : IKeyReader {
                func ReadKey() ConsoleKeyInfo? {
                    return nil
                }
            }

            var k IKeyReader = KeyReader{}
            Console.WriteLine(k.ReadKey() == nil)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void NullableLongReturn_ComputedValue()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface ILongAdder
                {
                    long? Add(long a, long b);
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class LongAdder : ILongAdder {
                func Add(a int64, b int64) int64? {
                    return a + b
                }
            }

            var adder ILongAdder = LongAdder{}
            Console.WriteLine(adder.Add(1000000000, 2000000000))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource);
        Assert.Equal("3000000000\n", output);
    }

    [Fact]
    public void NullableULongReturn_Interface()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IMaybeULong
                {
                    ulong? Value();
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class MaybeULongImpl : IMaybeULong {
                func Value() uint64? {
                    return uint64(1024)
                }
            }

            var m IMaybeULong = MaybeULongImpl{}
            var v = m.Value()
            Console.WriteLine(v)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource);
        Assert.Equal("1024\n", output);
    }

    [Fact]
    public void NullableLongParam_Interface()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface ILongEcho
                {
                    long? Echo(long? input);
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class LongEchoer : ILongEcho {
                func Echo(input int64?) int64? {
                    return input
                }
            }

            var e ILongEcho = LongEchoer{}
            var v = e.Echo(int64(99))
            Console.WriteLine(v)
            Console.WriteLine(e.Echo(nil) == nil)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource);
        Assert.Equal("99\nTrue\n", output);
    }

    [Fact]
    public void NullableLongProperty_Interface()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IHasNullableLongProp
                {
                    long? Value { get; }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class HasNullableLongProp : IHasNullableLongProp {
                prop Value int64? { get { return 42 } }
            }

            var p IHasNullableLongProp = HasNullableLongProp{}
            var v = p.Value
            Console.WriteLine(v)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void NullableDoubleReturn_NonNilRoundTrip()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IDoubleRoundTrip
                {
                    double? Echo(double? input);
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class DoubleRoundTrip : IDoubleRoundTrip {
                func Echo(input float64?) float64? {
                    return input
                }
            }

            var d IDoubleRoundTrip = DoubleRoundTrip{}
            var v = d.Echo(2.718)
            Console.WriteLine(v)
            Console.WriteLine(d.Echo(nil) == nil)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource);
        Assert.Equal("2.718\nTrue\n", output);
    }

    // ----- helpers -----

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName = "Probe.CSharp")
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue638_").FullName;
        try
        {
            // Step 1: compile the sibling C# library.
            var csDir = Path.Combine(tempDir, "csref");
            Directory.CreateDirectory(csDir);
            File.WriteAllText(Path.Combine(csDir, "Lib.cs"), csSource);
            File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), $"""
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <OutputType>Library</OutputType>
                    <TargetFramework>net10.0</TargetFramework>
                    <Nullable>enable</Nullable>
                    <AssemblyName>{siblingName}</AssemblyName>
                    <RootNamespace>{siblingName}</RootNamespace>
                    <Nullable>enable</Nullable>
                  </PropertyGroup>
                </Project>
                """);

            var siblingDll = BuildCsProject(csDir, siblingName);

            // Step 2: compile the G# code referencing the sibling.
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, gSource);

            var gscArgs = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/reference:" + siblingDll,
            };

            foreach (var reference in TrustedPlatformAssemblies())
            {
                gscArgs.Add("/reference:" + reference);
            }

            gscArgs.Add("/nowarn:GS9100");
            gscArgs.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(gscArgs.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            File.Copy(siblingDll, Path.Combine(tempDir, Path.GetFileName(siblingDll)), overwrite: true);

            IlVerifier.Verify(outPath, additionalReferences: new[] { siblingDll });

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
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string BuildCsProject(string csDir, string siblingName)
    {
        RunDotnet(csDir, "restore");
        RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore");

        var dll = Path.Combine(csDir, "bin", "Release", "net10.0", siblingName + ".dll");
        Assert.True(File.Exists(dll), $"sibling assembly not found at {dll}");
        return dll;
    }

    private static void RunDotnet(string workingDir, params string[] args)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDir,
        };
        foreach (var a in args)
        {
            psi.ArgumentList.Add(a);
        }

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException($"failed to start dotnet {string.Join(" ", args)}");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(120_000), $"dotnet {args[0]} timed out");
        Assert.True(
            proc.ExitCode == 0,
            $"dotnet {string.Join(" ", args)} failed (exit {proc.ExitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
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
