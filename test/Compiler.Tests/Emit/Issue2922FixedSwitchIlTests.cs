// <copyright file="Issue2922FixedSwitchIlTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Threading.Tasks;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2922: string pins use <c>GetPinnableReference</c>; array and span
/// pins retain Roslyn's managed-pointer + <c>conv.u</c> lowering.
/// </summary>
public class Issue2922FixedSwitchIlTests
{
    private const string ExpectedMatrixOutput = "2\n3\n12\n12\n3\n3\n2\n2\n2\n12\n3\n3\n2\n2\nSI\n";

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

    [Fact]
    public void FixedControlFlowMatrix_VerifiesLoadsAndRuns()
    {
        using var program = Compile("Matrix", MatrixSource);
        IlVerifier.Verify(
            program.AssemblyPath,
            additionalReferences: null,
            ignoredErrorCodes: new[] { "ExpectedNumericType" },
            ignoredErrorScope: @"<Program>\.");
        program.AssertLoadable();
        Assert.Equal(ExpectedMatrixOutput, program.Run());
    }

    [Fact]
    public void ArrayPointerDereference_VerifiesLoadsAndRuns()
    {
        const string Source = """
            package Issue2922.Array
            import System

            func F(xs []int32) int32 {
                unsafe {
                    fixed p *int32 = xs {
                        switch xs.Length {
                            case 2 { return *p + p[1] }
                            default { return -1 }
                        }
                    }
                }
            }

            Console.WriteLine(F([]int32{10, 20}))
            """;

        using var program = Compile("Array", Source);
        IlVerifier.Verify(
            program.AssemblyPath,
            additionalReferences: null,
            ignoredErrorCodes: new[] { "ExpectedNumericType" },
            ignoredErrorScope: @"<Program>\.F$");
        program.AssertLoadable();
        Assert.Equal("30\n", program.Run());

        var instructions = program.ReadMethod("F");
        var loadElementAddress = Array.FindIndex(
            instructions,
            instruction => instruction.OpCode == OpCodes.Ldelema);
        Assert.True(loadElementAddress >= 0);
        Assert.Equal(OpCodes.Conv_U, instructions[loadElementAddress + 1].OpCode);
        Assert.DoesNotContain(program.MemberReferenceNames(), name => name == "AsPointer");
    }

    [Fact]
    public void StructPointerDereference_VerifiesLoadsAndRuns()
    {
        const string Source = """
            package Issue2922.Struct
            import System
            import System.Runtime.InteropServices

            @StructLayout(LayoutKind.Sequential)
            struct Point {
                var x int32
                var y int32
            }

            func F(values []Point) int32 {
                unsafe {
                    fixed p *Point = values {
                        switch values.Length {
                            case 1 { return p->x + p->y }
                            default { return -1 }
                        }
                    }
                }
            }

            Console.WriteLine(F([]Point{Point{x: 30, y: 47}}))
            """;

        using var program = Compile("Struct", Source);
        IlVerifier.Verify(
            program.AssemblyPath,
            additionalReferences: null,
            ignoredErrorCodes: new[] { "ExpectedNumericType" },
            ignoredErrorScope: @"<Program>\.F$");
        program.AssertLoadable();
        Assert.Equal("77\n", program.Run());
    }

    [Fact]
    public void SpanPointerDereference_VerifiesLoadsAndRuns()
    {
        const string Source = """
            package Issue2922.Span
            import System

            func F(xs []int32) int32 {
                var span Span[int32] = xs
                unsafe {
                    fixed p *int32 = span {
                        switch xs.Length {
                            case 1 { return *p }
                            default { return -1 }
                        }
                    }
                }
            }

            Console.WriteLine(F([]int32{5}))
            """;

        using var program = Compile("Span", Source);
        IlVerifier.Verify(
            program.AssemblyPath,
            additionalReferences: null,
            ignoredErrorCodes: new[] { "ExpectedNumericType" },
            ignoredErrorScope: @"<Program>\.F$");
        program.AssertLoadable();
        Assert.Equal("5\n", program.Run());
        Assert.DoesNotContain(program.MemberReferenceNames(), name => name == "AsPointer");
    }

    [Fact]
    public void StringPin_UsesPinnableReferenceAndPreservesModreq()
    {
        const string Source = """
            package Issue2922.String
            import System

            func F(text string) int32 {
                unsafe {
                    fixed p *uint16 = text {
                        switch text.Length {
                            case 1 { return int32(*p) }
                            default { return -1 }
                        }
                    }
                }
            }

            Console.WriteLine(F("Z"))
            """;

        using var program = Compile("String", Source);
        IlVerifier.Verify(
            program.AssemblyPath,
            additionalReferences: null,
            ignoredErrorCodes: new[] { "ExpectedNumericType" },
            ignoredErrorScope: @"<Program>\.F$");
        program.AssertLoadable();
        Assert.Equal("90\n", program.Run());

        using var stream = File.OpenRead(program.AssemblyPath);
        using var pe = new PEReader(stream);
        var metadata = pe.GetMetadataReader();
        var stringPinnableReference = Assert.Single(
            metadata.MemberReferences,
            handle =>
            {
                var reference = metadata.GetMemberReference(handle);
                return metadata.GetString(reference.Name) == "GetPinnableReference"
                    && reference.Parent.Kind == HandleKind.TypeReference
                    && metadata.GetString(
                        metadata.GetTypeReference((TypeReferenceHandle)reference.Parent).Name) == "String";
            });
        var signature = metadata.GetBlobBytes(
            metadata.GetMemberReference(stringPinnableReference).Signature);
        Assert.Contains((byte)0x1F, signature); // ELEMENT_TYPE_CMOD_REQD
        Assert.DoesNotContain(
            metadata.MemberReferences,
            handle => metadata.GetString(metadata.GetMemberReference(handle).Name)
                == "get_OffsetToStringData");
    }

    [Fact]
    public void NullStringPin_LoadsAndRuns()
    {
        const string Source = """
            package Issue2922.NullString
            import System

            func F(text string) int32 {
                unsafe {
                    fixed p *uint16 = text {
                        return 7
                    }
                }
            }

            let missing string = default
            Console.WriteLine(F(missing))
            """;

        using var program = Compile("NullString", Source);
        IlVerifier.Verify(
            program.AssemblyPath,
            additionalReferences: null,
            ignoredErrorCodes: new[] { "ExpectedNumericType" },
            ignoredErrorScope: @"<Program>\.F$");
        program.AssertLoadable();
        Assert.Equal("7\n", program.Run());
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

        public Assembly Load() => Assembly.Load(File.ReadAllBytes(AssemblyPath));

        public void AssertLoadable() => Assert.NotEmpty(Load().GetTypes());

        public IlInstruction[] ReadMethod(string name)
        {
            using var stream = File.OpenRead(AssemblyPath);
            using var pe = new PEReader(stream);
            var metadata = pe.GetMetadataReader();
            var handle = Assert.Single(
                metadata.MethodDefinitions,
                candidate => metadata.GetString(metadata.GetMethodDefinition(candidate).Name) == name);
            var definition = metadata.GetMethodDefinition(handle);
            return IlInstructionReader.Read(
                pe.GetMethodBody(definition.RelativeVirtualAddress).GetILBytes());
        }

        public string[] MemberReferenceNames()
        {
            using var stream = File.OpenRead(AssemblyPath);
            using var pe = new PEReader(stream);
            var metadata = pe.GetMetadataReader();
            return metadata.MemberReferences
                .Select(handle => metadata.GetString(metadata.GetMemberReference(handle).Name))
                .ToArray();
        }

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
            return stdoutTask.Result.Replace("\r\n", "\n");
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
