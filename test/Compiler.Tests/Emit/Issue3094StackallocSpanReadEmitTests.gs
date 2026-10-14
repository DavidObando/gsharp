// <copyright file="Issue3094StackallocSpanReadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Runtime.Loader
import Xunit

/// Issue #3094: a stack-allocated (cref:Span{T}) passed to
/// (cref:Stream.Read(Span{byte})) keeps its by-ref-like value shape,
/// and span indexer reads consume the managed pointer returned by
/// `get_Item`. The sole verifier exemption is the inherent
/// `Unverifiable` diagnostic on `localloc` itself (ADR-0124);
/// every other method in the assembly is verified without suppressions.
open class Issue3094StackallocSpanReadEmitTests {
    @Fact
    func StackallocSpanRead_UsesVerifiableByRefLikeIlAndRuns() {
        using let program = Compile(Source)
        File.WriteAllBytes(program.Path("match.bin"), []uint8{uint8('T'), uint8('E'), uint8('S'), uint8('T')})
        File.WriteAllBytes(program.Path("miss.bin"), []uint8{uint8('T'), uint8('E'), uint8('S'), uint8('X')})
        // ECMA-335 makes localloc itself unverifiable. Scope that one category
        // to the exact stackalloc method; the heap/read-only controls and every
        // other emitted method run through ilverify with no suppression.
        IlVerifier.Verify(
            program.AssemblyPath,
            ignoredErrorCodes: []string{"Unverifiable"},
            ignoredErrorScope: "<Program>\\.HasMagic$$"
        )
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}9${Environment.NewLine}",
            program.Run()
        )
        AssertIlShape(program.AssemblyPath)
    }

    private data class ResolvedCall(Instruction IlInstruction, Method MethodBase?) : IEquatable[ResolvedCall] { }

    private class CompiledProgram : IDisposable {
        init(directory string, assemblyPath string) {
            Directory = directory
            AssemblyPath = assemblyPath
        }

        prop Directory string {
            get;
        }

        prop AssemblyPath string {
            get;
        }

        func Path(fileName string) string -> Path.Combine(Directory, fileName)

        func Run() string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Directory
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(AssemblyPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(AssemblyPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start emitted program.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "Emitted program timed out.")
            Assert.True(process.ExitCode == 0, (`Emitted program exited ` + "${process.ExitCode}" + `:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }

        func Dispose() {
            try {
                Directory.Delete(Directory, recursive: true)
            } catch {
                // Best-effort cleanup after a failed assertion or loaded assembly.

            }
        }
    }

    shared {
        private const Source string = `package i3094
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
}`

        private func AssertIlShape(assemblyPath string) {
            let loadContext = AssemblyLoadContext("Issue3094-" + Guid.NewGuid().ToString("N"), isCollectible: true)
            try {
                let assembly = loadContext.LoadFromAssemblyPath(assemblyPath)
                let programType = assembly.GetType("i3094.<Program>", throwOnError: true)!!
                let stackallocMethod = GetMethod(programType, "HasMagic")
                let stackallocBody = stackallocMethod.GetMethodBody()!!
                Assert.Contains(
                    stackallocBody.LocalVariables,
                    (local LocalVariableInfo) -> local.LocalType == typeof(Span[uint8])
                )
                Assert.Contains(
                    stackallocBody.LocalVariables,
                    (local LocalVariableInfo) -> local.LocalType == typeof(int32)
                )
                Assert.DoesNotContain(
                    stackallocBody.LocalVariables,
                    (local LocalVariableInfo) -> local.LocalType.IsByRef
                )
                Assert.DoesNotContain(
                    programType.GetFields(
                        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance
                    ),
                    (field FieldInfo) -> field.FieldType.IsByRefLike
                )
                let stackallocInstructions = IlInstructionReader.Read(stackallocBody.GetILAsByteArray()!!)
                let localloc = Assert.Single(
                    stackallocInstructions,
                    (instruction IlInstruction) -> instruction.OpCode == OpCodes.Localloc
                )
                let stackallocCalls = ResolveCalls(stackallocMethod, stackallocInstructions)
                let stackallocRead = AssertReadSpanOverload(stackallocCalls, typeof(FileStream))
                Assert.True(localloc.Offset < stackallocRead.Instruction.Offset)
                Assert.DoesNotContain(stackallocCalls, (call ResolvedCall) -> call.Method!!.Name == "op_Implicit")
                let spanIndexers = stackallocCalls.Where(
                    (call ResolvedCall) -> call.Method!!.Name == "get_Item" &&
                        call.Method!!.DeclaringType == typeof(Span[uint8])
                )
                    .ToArray()
                Assert.Equal(4, spanIndexers.Length)
                AssertManagedPointerLoads(stackallocInstructions, spanIndexers, isReadOnly: false)
                let finallyClause = Assert.Single(
                    stackallocBody.ExceptionHandlingClauses,
                    (clause ExceptionHandlingClause) -> clause.Flags == ExceptionHandlingClauseOptions.Finally
                )
                let tryEnd = finallyClause.TryOffset + finallyClause.TryLength
                Assert.InRange(localloc.Offset, finallyClause.TryOffset, tryEnd - 1)
                Assert.InRange(spanIndexers[^1].Instruction.Offset, finallyClause.TryOffset, tryEnd - 1)
                let heapMethod = GetMethod(programType, "HasMagicHeap")
                let heapBody = heapMethod.GetMethodBody()!!
                Assert.Contains(
                    heapBody.LocalVariables,
                    (local LocalVariableInfo) -> local.LocalType == typeof([]uint8)
                )
                Assert.DoesNotContain(
                    heapBody.LocalVariables,
                    (local LocalVariableInfo) -> local.LocalType == typeof(Span[uint8]) || local.LocalType.IsByRef
                )
                let heapInstructions = IlInstructionReader.Read(heapBody.GetILAsByteArray()!!)
                let heapCalls = ResolveCalls(heapMethod, heapInstructions)
                let heapRead = AssertReadSpanOverload(heapCalls, typeof(Stream))
                let arrayToSpan = Assert.Single(
                    heapCalls,
                    (call ResolvedCall) -> call.Method!!.Name == "op_Implicit" &&
                        call.Method is MethodInfo method &&
                        method.ReturnType == typeof(Span[uint8]) &&
                        method
                        .GetParameters()
                        .Select((parameter ParameterInfo) -> parameter.ParameterType)
                        .SequenceEqual([]Type{typeof([]uint8)})
                )
                Assert.True(arrayToSpan.Instruction.Offset < heapRead.Instruction.Offset)
                Assert.Equal(
                    4,
                    heapInstructions.Count((instruction IlInstruction) -> instruction.OpCode == OpCodes.Ldelem_U1)
                )
                let readOnlyMethod = GetMethod(programType, "FirstReadOnly")
                Assert.Equal(typeof(ReadOnlySpan[uint8]), Assert.Single(readOnlyMethod.GetParameters()).ParameterType)
                let readOnlyInstructions = IlInstructionReader.Read(
                    readOnlyMethod.GetMethodBody()!!.GetILAsByteArray()!!
                )
                let readOnlyIndexer = Assert.Single(
                    ResolveCalls(readOnlyMethod, readOnlyInstructions),
                    (call ResolvedCall) -> call.Method!!.Name == "get_Item" &&
                        call.Method!!.DeclaringType == typeof(ReadOnlySpan[uint8])
                )
                AssertManagedPointerLoads(readOnlyInstructions, []ResolvedCall{readOnlyIndexer}, isReadOnly: true)
            } finally {
                loadContext.Unload()
            }
        }

        private func AssertReadSpanOverload(calls[]ResolvedCall, declaringType Type) ResolvedCall {
            let read = Assert.Single(
                calls,
                (call ResolvedCall) -> call.Method!!.Name == "Read" &&
                    call.Method!!.DeclaringType == declaringType &&
                    call.Method!!
                    .GetParameters().Length == 1
            )
            Assert.Equal(typeof(Span[uint8]), Assert.Single(read.Method!!.GetParameters()).ParameterType)
            return read
        }

        private func AssertManagedPointerLoads(instructions[]IlInstruction, indexers[]ResolvedCall, isReadOnly bool) {
            for indexer in indexers {
                let method = Assert.IsAssignableFrom[MethodInfo](indexer.Method)
                Assert.True(method.ReturnType.IsByRef)
                Assert.Equal(typeof(uint8), method.ReturnType.GetElementType())
                let requiredModifiers = method.ReturnParameter.GetRequiredCustomModifiers()
                if isReadOnly {
                    Assert.Contains(
                        requiredModifiers,
                        (modifier Type) -> modifier.FullName == "System.Runtime.InteropServices.InAttribute"
                    )
                } else {
                    Assert.Empty(requiredModifiers)
                }
                let instructionIndex = Array.IndexOf(instructions, indexer.Instruction)
                Assert.True(instructionIndex >= 0 && instructionIndex + 1 < instructions.Length)
                Assert.Equal(OpCodes.Ldind_U1, instructions[instructionIndex + 1].OpCode)
            }
        }

        private func ResolveCalls(method MethodInfo, instructions[]IlInstruction)[]ResolvedCall -> instructions
            .Where(
            (instruction IlInstruction) -> (
                instruction.OpCode == OpCodes.Call || instruction.OpCode == OpCodes.Callvirt
            ) &&
                (instruction.MetadataToken != nil)
        )
            .Select(
            (instruction IlInstruction) -> ResolvedCall(
                instruction,
                method.Module.ResolveMethod(instruction.MetadataToken!!)!!
            )
        )
            .ToArray()

        private func GetMethod(programType Type, name string) MethodInfo -> programType.GetMethod(
            name,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        ) ??
            throw InvalidOperationException("Method '$name' was not emitted.")

        private func Compile(source string) Issue3094StackallocSpanReadEmitTests.CompiledProgram {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue3094-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return Issue3094StackallocSpanReadEmitTests.CompiledProgram(directory, assemblyPath)
        }
    }
}
