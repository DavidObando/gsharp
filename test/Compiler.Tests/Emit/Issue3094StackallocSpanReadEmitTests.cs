// <copyright file="Issue3094StackallocSpanReadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.Loader;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3094: a stack-allocated <see cref="Span{T}"/> passed to
/// <see cref="Stream.Read(Span{byte})"/> keeps its by-ref-like value shape,
/// and span indexer reads consume the managed pointer returned by
/// <c>get_Item</c>. The sole verifier exemption is the inherent
/// <c>Unverifiable</c> diagnostic on <c>localloc</c> itself (ADR-0124);
/// every other method in the assembly is verified without suppressions.
/// </summary>
public class Issue3094StackallocSpanReadEmitTests
{
    private const string Source = """
        package i3094
        import System
        import System.IO

        func HasMagic(path string) bool {
            using let stream = File.OpenRead(path)
            var magic Span[uint8] = stackalloc [4]uint8
            return stream.Read(magic) == 4
                && magic[0] == uint8(84)
                && magic[1] == uint8(69)
                && magic[2] == uint8(83)
                && magic[3] == uint8(84)
        }

        func HasMagicHeap(path string) bool {
            using let stream Stream = File.OpenRead(path)
            let magic = [4]uint8
            return stream.Read(magic) == 4
                && magic[0] == uint8(84)
                && magic[1] == uint8(69)
                && magic[2] == uint8(83)
                && magic[3] == uint8(84)
        }

        func FirstReadOnly(values ReadOnlySpan[uint8]) uint8 -> values[0]

        func Main() {
            Console.WriteLine(HasMagic("match.bin"))
            Console.WriteLine(HasMagic("miss.bin"))
            Console.WriteLine(HasMagicHeap("match.bin"))
            Console.WriteLine(HasMagicHeap("miss.bin"))
            Console.WriteLine(int32(FirstReadOnly([]uint8{uint8(9)})))
        }
        """;

    [Fact]
    public void StackallocSpanRead_UsesVerifiableByRefLikeIlAndRuns()
    {
        using var program = Compile(Source);
        File.WriteAllBytes(program.Path("match.bin"), new byte[] { (byte)'T', (byte)'E', (byte)'S', (byte)'T' });
        File.WriteAllBytes(program.Path("miss.bin"), new byte[] { (byte)'T', (byte)'E', (byte)'S', (byte)'X' });

        // ECMA-335 makes localloc itself unverifiable. Scope that one category
        // to the exact stackalloc method; the heap/read-only controls and every
        // other emitted method run through ilverify with no suppression.
        IlVerifier.Verify(
            program.AssemblyPath,
            ignoredErrorCodes: new[] { "Unverifiable" },
            ignoredErrorScope: @"<Program>\.HasMagic$");

        Assert.Equal($"True{Environment.NewLine}False{Environment.NewLine}True{Environment.NewLine}False{Environment.NewLine}9{Environment.NewLine}", program.Run());
        AssertIlShape(program.AssemblyPath);
    }

    private static void AssertIlShape(string assemblyPath)
    {
        var loadContext = new AssemblyLoadContext("Issue3094-" + Guid.NewGuid().ToString("N"), isCollectible: true);
        try
        {
            var assembly = loadContext.LoadFromAssemblyPath(assemblyPath);
            var programType = assembly.GetType("i3094.<Program>", throwOnError: true)!;

            var stackallocMethod = GetMethod(programType, "HasMagic");
            var stackallocBody = stackallocMethod.GetMethodBody()!;
            Assert.Contains(stackallocBody.LocalVariables, local => local.LocalType == typeof(Span<byte>));
            Assert.Contains(stackallocBody.LocalVariables, local => local.LocalType == typeof(int));
            Assert.DoesNotContain(stackallocBody.LocalVariables, local => local.LocalType.IsByRef);
            Assert.DoesNotContain(
                programType.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance),
                field => field.FieldType.IsByRefLike);

            var stackallocInstructions = IlInstructionReader.Read(stackallocBody.GetILAsByteArray()!);
            var localloc = Assert.Single(
                stackallocInstructions,
                instruction => instruction.OpCode == OpCodes.Localloc);
            var stackallocCalls = ResolveCalls(stackallocMethod, stackallocInstructions);
            var stackallocRead = AssertReadSpanOverload(stackallocCalls, typeof(FileStream));
            Assert.True(localloc.Offset < stackallocRead.Instruction.Offset);
            Assert.DoesNotContain(stackallocCalls, call => call.Method.Name == "op_Implicit");

            var spanIndexers = stackallocCalls
                .Where(call => call.Method.Name == "get_Item" && call.Method.DeclaringType == typeof(Span<byte>))
                .ToArray();
            Assert.Equal(4, spanIndexers.Length);
            AssertManagedPointerLoads(stackallocInstructions, spanIndexers, isReadOnly: false);

            var finallyClause = Assert.Single(
                stackallocBody.ExceptionHandlingClauses,
                clause => clause.Flags == ExceptionHandlingClauseOptions.Finally);
            var tryEnd = finallyClause.TryOffset + finallyClause.TryLength;
            Assert.InRange(localloc.Offset, finallyClause.TryOffset, tryEnd - 1);
            Assert.InRange(spanIndexers[^1].Instruction.Offset, finallyClause.TryOffset, tryEnd - 1);

            var heapMethod = GetMethod(programType, "HasMagicHeap");
            var heapBody = heapMethod.GetMethodBody()!;
            Assert.Contains(heapBody.LocalVariables, local => local.LocalType == typeof(byte[]));
            Assert.DoesNotContain(heapBody.LocalVariables, local => local.LocalType == typeof(Span<byte>) || local.LocalType.IsByRef);

            var heapInstructions = IlInstructionReader.Read(heapBody.GetILAsByteArray()!);
            var heapCalls = ResolveCalls(heapMethod, heapInstructions);
            var heapRead = AssertReadSpanOverload(heapCalls, typeof(Stream));
            var arrayToSpan = Assert.Single(
                heapCalls,
                call => call.Method.Name == "op_Implicit"
                    && call.Method is MethodInfo method
                    && method.ReturnType == typeof(Span<byte>)
                    && method.GetParameters().Select(parameter => parameter.ParameterType).SequenceEqual(new[] { typeof(byte[]) }));
            Assert.True(arrayToSpan.Instruction.Offset < heapRead.Instruction.Offset);
            Assert.Equal(4, heapInstructions.Count(instruction => instruction.OpCode == OpCodes.Ldelem_U1));

            var readOnlyMethod = GetMethod(programType, "FirstReadOnly");
            Assert.Equal(typeof(ReadOnlySpan<byte>), Assert.Single(readOnlyMethod.GetParameters()).ParameterType);
            var readOnlyInstructions = IlInstructionReader.Read(readOnlyMethod.GetMethodBody()!.GetILAsByteArray()!);
            var readOnlyIndexer = Assert.Single(
                ResolveCalls(readOnlyMethod, readOnlyInstructions),
                call => call.Method.Name == "get_Item" && call.Method.DeclaringType == typeof(ReadOnlySpan<byte>));
            AssertManagedPointerLoads(readOnlyInstructions, new[] { readOnlyIndexer }, isReadOnly: true);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static ResolvedCall AssertReadSpanOverload(ResolvedCall[] calls, Type declaringType)
    {
        var read = Assert.Single(
            calls,
            call => call.Method.Name == nameof(Stream.Read)
                && call.Method.DeclaringType == declaringType
                && call.Method.GetParameters().Length == 1);
        Assert.Equal(typeof(Span<byte>), Assert.Single(read.Method.GetParameters()).ParameterType);
        return read;
    }

    private static void AssertManagedPointerLoads(
        IlInstruction[] instructions,
        ResolvedCall[] indexers,
        bool isReadOnly)
    {
        foreach (var indexer in indexers)
        {
            var method = Assert.IsAssignableFrom<MethodInfo>(indexer.Method);
            Assert.True(method.ReturnType.IsByRef);
            Assert.Equal(typeof(byte), method.ReturnType.GetElementType());
            var requiredModifiers = method.ReturnParameter.GetRequiredCustomModifiers();
            if (isReadOnly)
            {
                Assert.Contains(
                    requiredModifiers,
                    modifier => modifier.FullName == "System.Runtime.InteropServices.InAttribute");
            }
            else
            {
                Assert.Empty(requiredModifiers);
            }

            var instructionIndex = Array.IndexOf(instructions, indexer.Instruction);
            Assert.True(instructionIndex >= 0 && instructionIndex + 1 < instructions.Length);
            Assert.Equal(OpCodes.Ldind_U1, instructions[instructionIndex + 1].OpCode);
        }
    }

    private static ResolvedCall[] ResolveCalls(MethodInfo method, IlInstruction[] instructions)
        => instructions
            .Where(instruction => (instruction.OpCode == OpCodes.Call || instruction.OpCode == OpCodes.Callvirt)
                && instruction.MetadataToken.HasValue)
            .Select(instruction => new ResolvedCall(
                instruction,
                method.Module.ResolveMethod(instruction.MetadataToken!.Value)!))
            .ToArray();

    private static MethodInfo GetMethod(Type programType, string name)
        => programType.GetMethod(
            name,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException($"Method '{name}' was not emitted.");

    private static CompiledProgram Compile(string source)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue3094-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var assemblyPath = Path.Combine(directory, "test.dll");
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

    private sealed record ResolvedCall(IlInstruction Instruction, MethodBase Method);

    private sealed class CompiledProgram : IDisposable
    {
        public CompiledProgram(string directory, string assemblyPath)
        {
            Directory = directory;
            AssemblyPath = assemblyPath;
        }

        public string Directory { get; }

        public string AssemblyPath { get; }

        public string Path(string fileName) => System.IO.Path.Combine(Directory, fileName);

        public string Run()
        {
            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(System.IO.Path.ChangeExtension(AssemblyPath, ".runtimeconfig.json"));
            startInfo.ArgumentList.Add(AssemblyPath);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start emitted program.");
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "Emitted program timed out.");
            Assert.True(
                process.ExitCode == 0,
                $"Emitted program exited {process.ExitCode}:\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return stdout.ReplaceLineEndings(Environment.NewLine);
        }

        public void Dispose()
        {
            try
            {
                System.IO.Directory.Delete(Directory, recursive: true);
            }
            catch
            {
                // Best-effort cleanup after a failed assertion or loaded assembly.
            }
        }
    }
}
