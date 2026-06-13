// <copyright file="Issue796FunctionAndSequenceNilCompareEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #796 / ADR-0084 §L5 follow-up — end-to-end emit coverage for
/// <c>== nil</c> / <c>!= nil</c> on function-typed and sequence-typed
/// values. The binder change extends
/// <see cref="GSharp.Core.CodeAnalysis.Binding.BoundBinaryOperator"/>'s
/// <c>IsNullCompare</c> arm; emit falls through to the generic
/// <c>ldnull; ceq</c> path because both shapes are managed references at
/// the CLR layer (delegate / <c>IEnumerable&lt;T&gt;</c>).
///
/// Each test compiles via in-process <c>gsc</c>, IL-verifies the emitted
/// PE (so any bad emit shape is caught here rather than only at JIT
/// time), and runs the assembly under <c>dotnet exec</c> asserting
/// captured stdout. The IL-pattern tests additionally walk the emitted
/// bytes to confirm a <c>ldnull; ceq</c> sequence is present in the
/// guard method body.
/// </summary>
public class Issue796FunctionAndSequenceNilCompareEmitTests
{
    [Fact]
    public void FunctionParameter_EqualsNil_GuardsAndRuns()
    {
        var source = """
            package Test
            import System

            func Guard(f () -> int32) string {
                if f == nil {
                    return "nil"
                }
                return "bound"
            }

            var nilFn () -> int32 = default(() -> int32)
            Console.WriteLine(Guard(() -> 42))
            Console.WriteLine(Guard(nilFn))
            """;

        var (output, ilBytes) = CompileRunAndCaptureMethodIl(source, methodName: "Guard");
        Assert.Equal("bound\nnil\n", output);
        Assert.True(
            ContainsSequence(ilBytes, ILOpCode.Ldnull, ILOpCode.Ceq),
            "Expected `ldnull; ceq` pattern in the Guard method body for a function-typed `== nil` comparison.");
    }

    [Fact]
    public void FunctionParameter_NotEqualNil_GuardsAndRuns()
    {
        var source = """
            package Test
            import System

            func IsBound(f () -> int32) bool {
                return f != nil
            }

            var nilFn () -> int32 = default(() -> int32)
            Console.WriteLine(IsBound(() -> 1))
            Console.WriteLine(IsBound(nilFn))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void ConcreteArrowFunction_EqualsNil_GuardsAndRuns()
    {
        // Concrete `(int32) -> int32` parameter — the binder must
        // bind `f == nil` through the FunctionTypeSymbol shape and
        // emit must produce verifiable IL. (The open-generic
        // `(T) -> R` shape is covered by the binder tests; element-
        // type inference through arrow shapes is tracked separately.)
        var source = """
            package Test
            import System

            func Apply(x int32, f (int32) -> int32) bool {
                return f == nil
            }

            var nilFn (int32) -> int32 = default((int32) -> int32)
            Console.WriteLine(Apply(1, nilFn))
            Console.WriteLine(Apply(1, (n int32) -> n + 1))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void SequenceInt32_EqualsNil_GuardsAndRuns()
    {
        var source = """
            package Test
            import System

            func Sum(xs sequence[int32]) int32 {
                if xs == nil {
                    return -1
                }
                var total = 0
                for x in xs {
                    total = total + x
                }
                return total
            }

            var nilSeq sequence[int32] = default(sequence[int32])
            Console.WriteLine(Sum([]int32{1, 2, 3}))
            Console.WriteLine(Sum(nilSeq))
            """;

        var (output, ilBytes) = CompileRunAndCaptureMethodIl(source, methodName: "Sum");
        Assert.Equal("6\n-1\n", output);
        Assert.True(
            ContainsSequence(ilBytes, ILOpCode.Ldnull, ILOpCode.Ceq),
            "Expected `ldnull; ceq` pattern in the Sum method body for a sequence-typed `== nil` comparison.");
    }

    [Fact]
    public void GenericSequence_NotEqualNil_GuardsAndRuns()
    {
        // Element-typed sequence: `sequence[int32] != nil` over a
        // concrete element type. The generic-T form is covered by the
        // binder tests; element-level inference through `sequence[T]`
        // is a separate language gap tracked outside this issue.
        var source = """
            package Test
            import System

            func HasAny(xs sequence[int32]) bool {
                return xs != nil
            }

            var nilSeq sequence[int32] = default(sequence[int32])
            Console.WriteLine(HasAny([]int32{}))
            Console.WriteLine(HasAny(nilSeq))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void NamedDelegateType_EqualsNil_GuardsAndRuns()
    {
        // ADR-0059 named delegate. Reference-typed at the CLR level
        // (sealed class deriving MulticastDelegate); must compile and
        // verify identically to the structural FunctionTypeSymbol path.
        var source = """
            package Test
            import System

            type Reducer = delegate func(a int32, b int32) int32

            func Apply(seed int32, f Reducer) int32 {
                if f == nil {
                    return -1
                }
                return f.Invoke(seed, 10)
            }

            var add Reducer = func(a int32, b int32) int32 { return a + b }
            var nilReducer Reducer = default(Reducer)
            Console.WriteLine(Apply(5, add))
            Console.WriteLine(Apply(5, nilReducer))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("15\n-1\n", output);
    }

    [Fact]
    public void LegacyFuncForm_EqualsNil_GuardsAndRuns()
    {
        // The legacy `func(int32) int32` spelling lowers to the same
        // FunctionTypeSymbol as the arrow form. Cover both spellings.
        var source = """
            package Test
            import System

            func Guard(f func(int32) int32) string {
                if f == nil {
                    return "nil"
                }
                return "bound"
            }

            var nilFn func(int32) int32 = default(func(int32) int32)
            Console.WriteLine(Guard((x int32) -> x * 2))
            Console.WriteLine(Guard(nilFn))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("bound\nnil\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var (output, _) = CompileRunAndCaptureMethodIl(source, methodName: null);
        return output;
    }

    private static (string Output, byte[] MethodIl) CompileRunAndCaptureMethodIl(string source, string methodName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue796_").FullName;
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
                "/nowarn:GS9100",
                srcPath,
            };

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

            Assert.True(
                compileExit == 0,
                $"gsc failed (exit {compileExit}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

            byte[] methodIl = methodName != null ? ReadMethodIl(outPath, methodName) : Array.Empty<byte>();

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
                $"sample exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return (stdout.Replace("\r\n", "\n"), methodIl);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static byte[] ReadMethodIl(string assemblyPath, string methodName)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var peReader = new PEReader(stream);
        var md = peReader.GetMetadataReader();
        foreach (var methodHandle in md.MethodDefinitions)
        {
            var method = md.GetMethodDefinition(methodHandle);
            if (md.GetString(method.Name) != methodName)
            {
                continue;
            }

            if (method.RelativeVirtualAddress == 0)
            {
                continue;
            }

            var body = peReader.GetMethodBody(method.RelativeVirtualAddress);
            return body.GetILBytes() ?? Array.Empty<byte>();
        }

        throw new InvalidOperationException(
            $"Method '{methodName}' not found in '{assemblyPath}'.");
    }

    // Lightweight opcode-sequence scan: walks the IL byte stream looking
    // for the requested 1- or 2-byte opcodes appearing back-to-back
    // (mirroring ECMA-335 §III.1.2.1 prefix rules: a 0xFE byte
    // introduces a 2-byte opcode; otherwise a single byte is the
    // opcode). Operands of intervening opcodes are skipped at a coarse
    // level — both `ldnull` (1 byte, no operand) and `ceq` (2 bytes,
    // 0xFE 0x01, no operand) have no operand bytes so the contiguity
    // test is straightforward.
    private static bool ContainsSequence(byte[] il, ILOpCode first, ILOpCode second)
    {
        var firstCode = (ushort)first;
        var secondCode = (ushort)second;
        int i = 0;
        while (i < il.Length)
        {
            int firstSize;
            ushort firstHere;
            if (il[i] == 0xFE && i + 1 < il.Length)
            {
                firstHere = (ushort)(0xFE00 | il[i + 1]);
                firstSize = 2;
            }
            else
            {
                firstHere = il[i];
                firstSize = 1;
            }

            if (firstHere == firstCode)
            {
                int j = i + firstSize;
                if (j < il.Length)
                {
                    ushort secondHere;
                    if (il[j] == 0xFE && j + 1 < il.Length)
                    {
                        secondHere = (ushort)(0xFE00 | il[j + 1]);
                    }
                    else
                    {
                        secondHere = il[j];
                    }

                    if (secondHere == secondCode)
                    {
                        return true;
                    }
                }
            }

            i += firstSize;
        }

        return false;
    }
}
