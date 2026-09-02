// <copyright file="Issue2922FixedSwitchIlTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Threading.Tasks;
using GSharp.Compiler;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2922: fixed sources must become numeric unmanaged pointers before
/// switch control flow is emitted.
/// </summary>
public class Issue2922FixedSwitchIlTests
{
    private static readonly string ExpectedMatrixOutput =
        $"2{Environment.NewLine}3{Environment.NewLine}12{Environment.NewLine}" +
        $"12{Environment.NewLine}3{Environment.NewLine}3{Environment.NewLine}" +
        $"2{Environment.NewLine}2{Environment.NewLine}2{Environment.NewLine}" +
        $"12{Environment.NewLine}3{Environment.NewLine}3{Environment.NewLine}" +
        $"2{Environment.NewLine}2{Environment.NewLine}SI{Environment.NewLine}";

    private const string MatrixSource = """
        package Issue2922.Matrix
        import System

        var trace = ""

        struct Holder {
            public var Values []int32
        }

        func AllSwitch(x int32, xs []int32) int32 {
            unsafe {
                fixed p *int32 = xs {
                    switch x {
                        case 0 { return xs.Length }
                        default { return 1 }
                    }
                }
            }
        }

        func SomeSwitch(x int32, xs []int32) int32 {
            unsafe {
                fixed p *int32 = xs {
                    switch x {
                        case 0 { return xs.Length }
                    }
                }
            }
            return 3
        }

        func BreakSwitch(x int32, xs []int32) int32 {
            var value = 0
            switchLoop: for {
                unsafe {
                    fixed p *int32 = xs {
                        switch x {
                            case 0 {
                                value = xs.Length
                                break switchLoop
                            }
                            default {
                                value = 1
                                break switchLoop
                            }
                        }
                    }
                }
            }
            return value + 10
        }

        func NestedSwitch(x int32, xs []int32) int32 {
            unsafe {
                fixed p *int32 = xs {
                    switch x {
                        case 0 {
                            switch xs.Length {
                                case 2 { return 12 }
                                default { return -1 }
                            }
                        }
                        default { return 1 }
                    }
                }
            }
        }

        func LoopSwitch(xs []int32) int32 {
            var total = 0
            unsafe {
                fixed p *int32 = xs {
                    for var i = 0; i < 2; i++ {
                        switch i {
                            case 0 { total = total + xs.Length }
                            default { total = total + 1 }
                        }
                    }
                }
            }
            return total
        }

        func MultipleSwitch(x int32, xs []int32, ys []int32) int32 {
            unsafe {
                fixed p *int32 = xs {
                    fixed q *int32 = ys {
                        switch x {
                            case 0 { return xs.Length + ys.Length }
                            default { return 1 }
                        }
                    }
                }
            }
        }

        func StringSwitch(x int32, text string) int32 {
            unsafe {
                fixed p *uint16 = text {
                    switch x {
                        case 0 { return text.Length }
                        default { return 1 }
                    }
                }
            }
        }

        func StructFieldSwitch(x int32, holder Holder) int32 {
            unsafe {
                fixed p *int32 = holder.Values {
                    switch x {
                        case 0 { return holder.Values.Length }
                        default { return 1 }
                    }
                }
            }
        }

        func AllIf(x int32, xs []int32) int32 {
            unsafe {
                fixed p *int32 = xs {
                    if x == 0 { return xs.Length }
                    return 1
                }
            }
        }

        func NestedIf(x int32, xs []int32) int32 {
            unsafe {
                fixed p *int32 = xs {
                    if x == 0 {
                        if xs.Length == 2 { return 12 }
                        return -1
                    }
                    return 1
                }
            }
        }

        func LoopIf(xs []int32) int32 {
            var total = 0
            unsafe {
                fixed p *int32 = xs {
                    for var i = 0; i < 2; i++ {
                        if i == 0 { total = total + xs.Length }
                        else { total = total + 1 }
                    }
                }
            }
            return total
        }

        func MultipleIf(x int32, xs []int32, ys []int32) int32 {
            unsafe {
                fixed p *int32 = xs {
                    fixed q *int32 = ys {
                        if x == 0 { return xs.Length + ys.Length }
                        return 1
                    }
                }
            }
        }

        func StringIf(x int32, text string) int32 {
            unsafe {
                fixed p *uint16 = text {
                    if x == 0 { return text.Length }
                    return 1
                }
            }
        }

        func StructFieldIf(x int32, holder Holder) int32 {
            unsafe {
                fixed p *int32 = holder.Values {
                    if x == 0 { return holder.Values.Length }
                    return 1
                }
            }
        }

        func VoidSwitch(x int32, xs []int32) {
            unsafe {
                fixed p *int32 = xs {
                    switch x {
                        case 0 { trace = trace + "S" }
                        default { trace = trace + "X" }
                    }
                }
            }
        }

        func VoidIf(x int32, xs []int32) {
            unsafe {
                fixed p *int32 = xs {
                    if x == 0 { trace = trace + "I" }
                    else { trace = trace + "X" }
                }
            }
        }

        let xs = []int32{1, 2}
        let ys = []int32{3}
        let holder = Holder{ Values: xs }
        Console.WriteLine(AllSwitch(0, xs))
        Console.WriteLine(SomeSwitch(1, xs))
        Console.WriteLine(BreakSwitch(0, xs))
        Console.WriteLine(NestedSwitch(0, xs))
        Console.WriteLine(LoopSwitch(xs))
        Console.WriteLine(MultipleSwitch(0, xs, ys))
        Console.WriteLine(StringSwitch(0, "AB"))
        Console.WriteLine(StructFieldSwitch(0, holder))
        Console.WriteLine(AllIf(0, xs))
        Console.WriteLine(NestedIf(0, xs))
        Console.WriteLine(LoopIf(xs))
        Console.WriteLine(MultipleIf(0, xs, ys))
        Console.WriteLine(StringIf(0, "AB"))
        Console.WriteLine(StructFieldIf(0, holder))
        VoidSwitch(0, xs)
        VoidIf(0, xs)
        Console.WriteLine(trace)
        """;

    /// <summary>Gets fixed source kinds whose old conv.u lowering failed verification.</summary>
    public static IEnumerable<object[]> PinKinds()
    {
        yield return new object[]
        {
            "Slice",
            """
            package Issue2922.Slice
            import System
            func F(x int32, xs []int32) int32 {
                unsafe {
                    fixed p *int32 = xs {
                        switch x {
                            case 0 { return xs.Length }
                            default { return 1 }
                        }
                    }
                }
            }
            Console.WriteLine(F(0, []int32{1, 2}))
            """,
            "2\n",
            Array.Empty<string>(),
        };
        yield return new object[]
        {
            "String",
            """
            package Issue2922.String
            import System
            func F(x int32, text string) int32 {
                unsafe {
                    fixed p *uint16 = text {
                        switch x {
                            case 0 { return text.Length }
                            default { return 1 }
                        }
                    }
                }
            }
            Console.WriteLine(F(0, "AB"))
            Console.WriteLine(F(0, ""))
            """,
            "2\n0\n",
            Array.Empty<string>(),
        };
        yield return new object[]
        {
            "Span",
            """
            package Issue2922.Span
            import System
            func F(x int32, xs []int32) int32 {
                var span Span[int32] = xs
                unsafe {
                    fixed p *int32 = span {
                        switch x {
                            case 0 { return xs.Length }
                            default { return 1 }
                        }
                    }
                }
            }
            Console.WriteLine(F(0, []int32{1, 2}))
            """,
            "2\n",
            new[] { "StackUnexpected" },
        };
    }

    [Theory]
    [MemberData(nameof(PinKinds))]
    public void FixedSource_VerifiesLoadsAndRuns(
        string name,
        string source,
        string expectedOutput,
        string[] ignoredVerificationErrors)
    {
        using var program = Compile(name, source);
        IlVerifier.Verify(
            program.AssemblyPath,
            additionalReferences: null,
            ignoredErrorCodes: ignoredVerificationErrors,
            ignoredErrorScope: ignoredVerificationErrors.Length == 0 ? null : @"<Program>\.F$");
        program.AssertLoadable();
        Assert.Equal(
            expectedOutput.Replace("\n", Environment.NewLine, StringComparison.Ordinal),
            program.Run());
    }

    [Fact]
    public void FixedControlFlowMatrix_Verifies()
    {
        using var program = Compile("MatrixVerify", MatrixSource);
        IlVerifier.Verify(program.AssemblyPath);
    }

    [Fact]
    public void FixedControlFlowMatrix_LoadsAndRuns()
    {
        using var program = Compile("MatrixRun", MatrixSource);
        program.AssertLoadable();
        Assert.Equal(ExpectedMatrixOutput, program.Run());
    }

    [Fact]
    public void SlicePin_ConvertsManagedPointerThroughUnsafeAsPointer()
    {
        using var program = Compile("Instruction", PinKinds().First()[1].ToString()!);
        var assembly = program.Load();
        var method = assembly.GetTypes()
            .Single(type => type.Name == "<Program>")
            .GetMethod("F", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!;
        var instructions = IlInstructionReader.Read(method.GetMethodBody()!.GetILAsByteArray()!);
        var loadElementAddressIndex = Array.FindIndex(
            instructions,
            instruction => instruction.OpCode == OpCodes.Ldelema);

        Assert.True(loadElementAddressIndex >= 0);
        Assert.True(loadElementAddressIndex + 1 < instructions.Length);
        var call = instructions[loadElementAddressIndex + 1];
        Assert.Equal(OpCodes.Call, call.OpCode);
        Assert.True(call.MetadataToken.HasValue);
        var calledMethod = method.Module.ResolveMethod(call.MetadataToken.Value);
        Assert.Equal("AsPointer", calledMethod!.Name);
    }

    [Fact]
    public void InstructionReader_DoesNotTreatOperandByteAsOpcode()
    {
        var il = new byte[]
        {
            unchecked((byte)OpCodes.Ldc_I4.Value),
            unchecked((byte)OpCodes.Ldelema.Value),
            0,
            0,
            0,
            unchecked((byte)OpCodes.Ret.Value),
        };
        Assert.Equal(1, Array.IndexOf(il, unchecked((byte)OpCodes.Ldelema.Value)));

        var instructions = IlInstructionReader.Read(il);
        Assert.Equal(
            new[] { OpCodes.Ldc_I4, OpCodes.Ret },
            instructions.Select(instruction => instruction.OpCode));
    }

    private static CompiledProgram Compile(string name, string source)
    {
        var directory = Directory.CreateTempSubdirectory($"gs_i2922_{name}_").FullName;
        var sourcePath = Path.Combine(directory, "Program.gs");
        var assemblyPath = Path.Combine(directory, "Program.dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(
            exitCode == 0,
            $"gsc failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return new CompiledProgram(directory, assemblyPath);
    }

    private sealed class CompiledProgram : IDisposable
    {
        private readonly string directory;

        public CompiledProgram(string directory, string assemblyPath)
        {
            this.directory = directory;
            AssemblyPath = assemblyPath;
        }

        public string AssemblyPath { get; }

        public Assembly Load() => EmittedFixture.Load(AssemblyPath);

        public void AssertLoadable() => Assert.NotEmpty(Load().GetTypes());

        public string Run()
        {
            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add(AssemblyPath);

            using var process = Process.Start(startInfo)!;
            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            var stderrTask = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(10_000))
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit();
                throw new Xunit.Sdk.XunitException("Compiled program timed out.");
            }

            Task.WaitAll(stdoutTask, stderrTask);
            Assert.True(
                process.ExitCode == 0,
                $"dotnet exec exited {process.ExitCode}:\n{stderrTask.Result}");
            return stdoutTask.Result.ReplaceLineEndings(Environment.NewLine);
        }

        public void Dispose()
        {
            if (Directory.Exists(this.directory))
            {
                Directory.Delete(this.directory, recursive: true);
            }
        }
    }
}
