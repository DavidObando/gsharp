// <copyright file="Issue5806ThrowingSwitchArmMaxStackTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

/// Issue #5806: a throwing switch-expression arm (or any `never`-typed arm or
/// branch) must not emit an unreachable result store or branch after `throw`.
/// ILLink (`Mono.Cecil.Cil.CodeWriter.ComputeMaxStack`) walks instructions
/// linearly and ignores incoming branches whose stack depth is 0; an
/// unreachable `stloc` after `throw` pops the stack depth from 0 to -1 and
/// shifts the computed `.maxstack` of the remainder of the method down by 1,
/// causing `InvalidProgramException` in trimmed executables and NativeAOT ILC.
open class Issue5806ThrowingSwitchArmMaxStackTests {
    @Fact
    func ReadSelection_ThrowingDefaultSwitchArm_EmitsNoStoreAfterThrowAndKeepsMaxStackFour() {
        let source = `import System

enum Selection { None; Enabled; }

func ReadSelection(value string?) Selection {
  let selected = switch value {
    case "enabled": Selection.Enabled
    default: throw ArgumentException("Unknown selection")
  }
  Console.Error.WriteLine("Selection: " + (value ?? "none"))
  return selected
}

Console.WriteLine(ReadSelection(Environment.GetEnvironmentVariable("SELECTION")).ToString())`
        let workDir = CreateWorkDirectory()
        try {
            let dllPath = Path.Combine(workDir, "CompilerRepro.dll")
            CompileExe(source, workDir, dllPath)
            IlVerifier.Verify(dllPath)

            let (instructions, exceptionRegions, cecilMaxStack, minStack) = InspectMethodIl(dllPath, "ReadSelection")
            AssertNoUnreachableStoreOrBranchAfterThrow(instructions, exceptionRegions)
            Assert.Equal(0, minStack)
            Assert.True(
                cecilMaxStack >= 4,
                "Expected Cecil/ILLink linear maxstack >= 4 for ReadSelection, got ${cecilMaxStack}."
            )

            let (okExit, okStdout, okStderr) = RunExe(dllPath, "enabled")
            Assert.Equal(0, okExit)
            Assert.Equal("Enabled", okStdout.Trim())
            Assert.Equal("Selection: enabled", okStderr.Trim())

            let (badExit, _, badStderr) = RunExe(dllPath, "invalid")
            Assert.NotEqual(0, badExit)
            Assert.Contains("Unknown selection", badStderr, StringComparison.Ordinal)
        } finally {
            Directory.Delete(workDir, recursive: true)
        }
    }

    @Theory
    @MemberData("ThrowingBranchShapes")
    func ThrowingBranchShapes_KeepNonNegativeStackAndMaxStackAtLeastFour(name string, selectionExpr string) {
        let source = `import System

enum Selection { None; Enabled; }

func ReadSelection(value string?) Selection {
  let selected = ` + selectionExpr + `
  Console.Error.WriteLine("Selection: " + (value ?? "none"))
  return selected
}

Console.WriteLine(ReadSelection(Environment.GetEnvironmentVariable("SELECTION")).ToString())`
        let workDir = CreateWorkDirectory()
        try {
            let dllPath = Path.Combine(workDir, name + ".dll")
            CompileExe(source, workDir, dllPath)
            IlVerifier.Verify(dllPath)

            let (instructions, exceptionRegions, cecilMaxStack, minStack) = InspectMethodIl(dllPath, "ReadSelection")
            AssertNoUnreachableStoreOrBranchAfterThrow(instructions, exceptionRegions)
            Assert.Equal(0, minStack)
            Assert.True(
                cecilMaxStack >= 4,
                "Expected Cecil/ILLink linear maxstack >= 4 for '${name}', got ${cecilMaxStack}."
            )

            let (okExit, okStdout, okStderr) = RunExe(dllPath, "enabled")
            Assert.Equal(0, okExit)
            Assert.Equal("Enabled", okStdout.Trim())
            Assert.Equal("Selection: enabled", okStderr.Trim())
        } finally {
            Directory.Delete(workDir, recursive: true)
        }
    }

    @Fact
    func NeverGuardWithUserLabelInSwitchArm_PreservesGotoTargetAndEmitsNoBranchAfterThrow() {
        let source = `import System

enum Selection { None; Enabled; }

func RunSwitchExpression(value string?) {
  let selected = switch value {
    case "enabled" when ({
      goto JumpInsideGuard
      throw ArgumentException("Guard failed")
      JumpInsideGuard:
      let _ = 0
      true
    }): {
      JumpIntoSwitchExprArm:
      if false {
        goto JumpIntoSwitchExprArm
      }
      Console.Error.WriteLine("Selection: " + (value ?? "none"))
      Selection.Enabled
    }
    case "guard" when throw ArgumentException("Guard failed"): Selection.None
    default: throw ArgumentException("Unknown selection")
  }
  Console.WriteLine("expr:" + selected.ToString())
}

func RunSwitchStatement(value string?) {
  if value == "enabled" {
    goto JumpIntoSwitchStmtArm
  }
  switch value {
    case "guard" when throw ArgumentException("Statement guard failed") {
      JumpIntoSwitchStmtArm:
      Console.Error.WriteLine("Stmt: " + (value ?? "none"))
    }
    default {
      throw ArgumentException("Unknown statement selection")
    }
  }
  Console.WriteLine("stmt-ok")
}

let arg = Environment.GetEnvironmentVariable("SELECTION")
RunSwitchStatement(arg)
RunSwitchExpression(arg)`
        let workDir = CreateWorkDirectory()
        try {
            let dllPath = Path.Combine(workDir, "NeverGuardLabel.dll")
            CompileExe(source, workDir, dllPath)
            IlVerifier.Verify(dllPath)

            for methodName in[]string{"RunSwitchExpression", "RunSwitchStatement"} {
                let (instructions, exceptionRegions, cecilMaxStack, minStack) = InspectMethodIl(dllPath, methodName)
                AssertNoUnreachableStoreOrBranchAfterThrow(instructions, exceptionRegions)
                Assert.Equal(0, minStack)
                Assert.True(
                    cecilMaxStack >= 4,
                    "Expected Cecil/ILLink linear maxstack >= 4 for '${methodName}', got ${cecilMaxStack}."
                )
            }

            let (okExit, okStdout, okStderr) = RunExe(dllPath, "enabled")
            Assert.Equal(0, okExit)
            Assert.Contains("stmt-ok", okStdout, StringComparison.Ordinal)
            Assert.Contains("expr:Enabled", okStdout, StringComparison.Ordinal)
            Assert.Contains("Selection: enabled", okStderr, StringComparison.Ordinal)

            let (guardExit, _, guardStderr) = RunExe(dllPath, "guard")
            Assert.NotEqual(0, guardExit)
            Assert.Contains("Statement guard failed", guardStderr, StringComparison.Ordinal)
        } finally {
            Directory.Delete(workDir, recursive: true)
        }
    }

    @Theory
    @MemberData("AsyncThrowingSwitchShapes")
    func AsyncSwitchWithAwaitedGuardOrPattern_KeepsMoveNextMaxStackValid(name string, switchExpr string) {
        let source = `import System
import System.Threading.Tasks

enum Selection { None; Enabled; }

async func CheckAsync(value string?) Task[bool] {
  await Task.Yield()
  return value != nil
}

async func ExpectedAsync(expected string) Task[string?] {
  await Task.Yield()
  return expected
}

async func ReadSelectionAsync(value string?) Task[Selection] {
  let selected = ` + switchExpr + `
  Console.Error.WriteLine("Selection: " + (value ?? "none"))
  return selected
}

let result = ReadSelectionAsync(Environment.GetEnvironmentVariable("SELECTION")).GetAwaiter().GetResult()
Console.WriteLine(result.ToString())`
        let workDir = CreateWorkDirectory()
        try {
            let dllPath = Path.Combine(workDir, name + ".dll")
            CompileExe(source, workDir, dllPath)
            IlVerifier.Verify(dllPath)

            let (instructions, exceptionRegions, cecilMaxStack, minStack) = InspectMoveNextIl(
                dllPath,
                "ReadSelectionAsync"
            )
            AssertNoUnreachableStoreOrBranchAfterThrow(instructions, exceptionRegions)
            Assert.Equal(0, minStack)
            Assert.True(
                cecilMaxStack >= 4,
                "Expected Cecil/ILLink linear maxstack >= 4 for '${name}' MoveNext, got ${cecilMaxStack}."
            )

            let (okExit, okStdout, okStderr) = RunExe(dllPath, "enabled")
            Assert.Equal(0, okExit)
            Assert.Equal("Enabled", okStdout.Trim())
            Assert.Equal("Selection: enabled", okStderr.Trim())

            let (badExit, _, badStderr) = RunExe(dllPath, "bad")
            Assert.NotEqual(0, badExit)
            Assert.Contains("Bad selection", badStderr, StringComparison.Ordinal)

            let (unknownExit, _, unknownStderr) = RunExe(dllPath, "invalid")
            Assert.NotEqual(0, unknownExit)
            Assert.Contains("Unknown selection", unknownStderr, StringComparison.Ordinal)
        } finally {
            Directory.Delete(workDir, recursive: true)
        }
    }

    private class VoidMarkerProvider : ISignatureTypeProvider[int32, object] {
        func GetPrimitiveType(typeCode PrimitiveTypeCode) int32 -> if typeCode == PrimitiveTypeCode.Void {
            0
        } else {
            1
        }

        func GetTypeFromDefinition(reader MetadataReader, handle TypeDefinitionHandle, rawTypeKind uint8) int32 -> 1

        func GetTypeFromReference(reader MetadataReader, handle TypeReferenceHandle, rawTypeKind uint8) int32 -> 1

        func GetTypeFromSpecification(
            reader MetadataReader,
            genericContext object,
            handle TypeSpecificationHandle,
            rawTypeKind uint8
        ) int32 -> 1

        func GetSZArrayType(elementType int32) int32 -> 1

        func GetArrayType(elementType int32, shape ArrayShape) int32 -> 1

        func GetByReferenceType(elementType int32) int32 -> 1

        func GetPointerType(elementType int32) int32 -> 1

        func GetGenericInstantiation(genericType int32, typeArguments ImmutableArray[int32]) int32 -> 1

        func GetGenericMethodParameter(genericContext object, index int32) int32 -> 1

        func GetGenericTypeParameter(genericContext object, index int32) int32 -> 1

        func GetFunctionPointerType(signature MethodSignature[int32]) int32 -> 1

        func GetModifiedType(modifier int32, unmodifiedType int32, isRequired bool) int32 -> unmodifiedType

        func GetPinnedType(elementType int32) int32 -> 1
    }

    shared {
        func ThrowingBranchShapes() sequence[[]object] {
            yield []object{"switch-non-default-throw", `switch value {
    case "bad": throw ArgumentException("Bad selection")
    default: Selection.Enabled
  }`}
            yield []object{"switch-block-throw", `switch value {
    case "enabled": Selection.Enabled
    default: {
      throw ArgumentException("Unknown selection")
    }
  }`}
            yield []object{"if-else-throw", `if value == "enabled" {
    Selection.Enabled
  } else {
    throw ArgumentException("Unknown selection")
  }`}
            yield []object{
                "ternary-throw",
                `value == "bad" ? throw ArgumentException("Bad selection") : Selection.Enabled`
            }
            yield []object{"if-let-throw", `if let v = value && v == "enabled" {
    Selection.Enabled
  } else {
    throw ArgumentException("Unknown selection")
  }`}
            yield []object{"null-coalesce-block-throw", `{
    let nonNull = value ?? {
      throw ArgumentException("Unknown selection")
    }
    nonNull == "enabled" ? Selection.Enabled : Selection.None
  }`}
        }

        func AsyncThrowingSwitchShapes() sequence[[]object] {
            yield []object{"async-guarded-await-throwing-arm", `switch value {
    case "enabled" when await CheckAsync(value): Selection.Enabled
    case "bad" when await CheckAsync(value): throw ArgumentException("Bad selection")
    default: throw ArgumentException("Unknown selection")
  }`}
            yield []object{"async-pattern-await-throwing-arm", `switch value {
    case == await ExpectedAsync("enabled"): Selection.Enabled
    case == await ExpectedAsync("bad"): throw ArgumentException("Bad selection")
    default: throw ArgumentException("Unknown selection")
  }`}
            yield []object{"async-guarded-await-never-guard", `switch value {
    case "bad" when await CheckAsync(value) ? throw ArgumentException("Bad selection") : throw ArgumentException("Other"): Selection.None
    case "enabled" when await CheckAsync(value): Selection.Enabled
    default: throw ArgumentException("Unknown selection")
  }`}
            yield []object{"async-pattern-await-never-guard", `switch value {
    case == await ExpectedAsync("bad") when await CheckAsync(value) ? throw ArgumentException("Bad selection") : throw ArgumentException("Other"): Selection.None
    case == await ExpectedAsync("enabled"): Selection.Enabled
    default: throw ArgumentException("Unknown selection")
  }`}
        }

        private func CreateWorkDirectory() string {
            let path = Path.Combine(AppContext.BaseDirectory, "gs_5806_" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(path)
            return path
        }

        private func CompileExe(source string, workDir string, dllPath string) {
            let srcPath = Path.Combine(workDir, "Program.gs")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, "gsc failed:\n${stdoutWriter}\n${stderrWriter}")
        }

        private func RunExe(dllPath string, selectionValue string)(ExitCode int32, Stdout string, Stderr string) {
            let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
            if !File.Exists(rtConfig) {
                File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
            }
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            }
            psi.ArgumentList.Add(dllPath)
            psi.Environment["SELECTION"] = selectionValue
            using let proc = Process.Start(psi)!!
            let stdout = proc.StandardOutput.ReadToEnd()
            let stderr = proc.StandardError.ReadToEnd()
            proc.WaitForExit()
            return (proc.ExitCode, stdout, stderr)
        }

        private func AssertNoUnreachableStoreOrBranchAfterThrow(
            instructions[]IlInstruction,
            exceptionRegions ImmutableArray[ExceptionRegion]
        ) {
            let handlerOffsets = HashSet[int32]()
            for region in exceptionRegions {
                handlerOffsets.Add(region.HandlerOffset)
                if region.Kind == ExceptionRegionKind.Filter {
                    handlerOffsets.Add(region.FilterOffset)
                }
            }
            let throwIndices = List[int32]()
            for var i = 0; i < instructions.Length; i++ {
                if instructions[i].OpCode == OpCodes.Throw {
                    throwIndices.Add(i)
                }
            }
            Assert.NotEmpty(throwIndices)
            for throwIndex in throwIndices {
                if throwIndex + 1 < instructions.Length {
                    let nextInstruction = instructions[throwIndex + 1]
                    if handlerOffsets.Contains(nextInstruction.Offset) {
                        continue
                    }
                    let nextOp = nextInstruction.OpCode
                    Assert.False(
                        IsStoreLocal(nextOp) ||
                            nextOp == OpCodes.Pop ||
                            nextOp == OpCodes.Br ||
                            nextOp == OpCodes.Br_S ||
                            nextOp == OpCodes.Brfalse ||
                            nextOp == OpCodes.Brfalse_S ||
                            nextOp == OpCodes.Brtrue ||
                            nextOp == OpCodes.Brtrue_S,
                        "Unreachable '${nextOp}' emitted immediately after 'throw' at IL_${instructions[throwIndex].Offset:X4}."
                    )
                }
            }
        }

        private func IsStoreLocal(opcode OpCode) bool -> opcode == OpCodes.Stloc ||
            opcode == OpCodes.Stloc_S ||
            opcode == OpCodes.Stloc_0 ||
            opcode == OpCodes.Stloc_1 ||
            opcode == OpCodes.Stloc_2 ||
            opcode == OpCodes.Stloc_3

        private func InspectMethodIl(dllPath string, methodName string)(
            Instructions[]IlInstruction,
            ExceptionRegions ImmutableArray[ExceptionRegion],
            CecilMaxStack int32,
            MinStack int32
        ) {
            using let stream = File.OpenRead(dllPath)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            for handle in reader.MethodDefinitions {
                let method = reader.GetMethodDefinition(handle)
                if reader.GetString(method.Name) != methodName {
                    continue
                }
                let body = pe.GetMethodBody(method.RelativeVirtualAddress)
                let instructions = IlInstructionReader.Read(body.GetILBytes())
                let (cecilMaxStack, minStack) = ComputeCecilMaxStack(
                    reader,
                    method,
                    body.ExceptionRegions,
                    instructions
                )
                return (instructions, body.ExceptionRegions, cecilMaxStack, minStack)
            }
            throw InvalidOperationException("Method '${methodName}' was not found in '${dllPath}'.")
        }

        private func InspectMoveNextIl(dllPath string, asyncMethodName string)(
            Instructions[]IlInstruction,
            ExceptionRegions ImmutableArray[ExceptionRegion],
            CecilMaxStack int32,
            MinStack int32
        ) {
            using let stream = File.OpenRead(dllPath)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            for typeHandle in reader.TypeDefinitions {
                let typeDef = reader.GetTypeDefinition(typeHandle)
                let typeName = reader.GetString(typeDef.Name)
                if !typeName.Contains(asyncMethodName, StringComparison.Ordinal) {
                    continue
                }
                for methodHandle in typeDef.GetMethods() {
                    let method = reader.GetMethodDefinition(methodHandle)
                    if reader.GetString(method.Name) != "MoveNext" {
                        continue
                    }
                    let body = pe.GetMethodBody(method.RelativeVirtualAddress)
                    let instructions = IlInstructionReader.Read(body.GetILBytes())
                    let (cecilMaxStack, minStack) = ComputeCecilMaxStack(
                        reader,
                        method,
                        body.ExceptionRegions,
                        instructions
                    )
                    return (instructions, body.ExceptionRegions, cecilMaxStack, minStack)
                }
            }
            throw InvalidOperationException(
                "State machine MoveNext for '${asyncMethodName}' was not found in '${dllPath}'."
            )
        }

        /// Simulates `Mono.Cecil.Cil.CodeWriter.ComputeMaxStack` over the linear
        /// instruction stream, including exception-handler entry stack seeding
        /// (`Catch` and `Filter` push the exception object at stack height 1)
        /// and Cecil's `if (stack_size == 0) return;` branch-target optimization
        /// that exposes unreachable stack-popping instructions after `throw`.
        private func ComputeCecilMaxStack(
            reader MetadataReader,
            method MethodDefinition,
            exceptionRegions ImmutableArray[ExceptionRegion],
            instructions[]IlInstruction
        )(MaxStack int32, MinStack int32) {
            let provider = VoidMarkerProvider()
            let methodSig = method.DecodeSignature(provider, nil)
            let stackSizes = Dictionary[int32, int32]()
            for region in exceptionRegions {
                if region.Kind == ExceptionRegionKind.Catch {
                    stackSizes[region.HandlerOffset] = 1
                } else if region.Kind == ExceptionRegionKind.Filter {
                    stackSizes[region.FilterOffset] = 1
                    stackSizes[region.HandlerOffset] = 1
                }
            }
            var stackSize = 0
            var maxStack = 0
            var minStack = 0
            for instruction in instructions {
                if stackSizes.TryGetValue(instruction.Offset, out var computedSize) {
                    stackSize = computedSize
                }
                maxStack = Math.Max(maxStack, stackSize)
                let (pop, push) = ComputeStackDelta(reader, provider, methodSig.ReturnType != 0, instruction)
                stackSize -= pop
                minStack = Math.Min(minStack, stackSize)
                stackSize += push
                maxStack = Math.Max(maxStack, stackSize)
                // Mono.Cecil's CopyBranchStackSize ignores stack_size == 0.
                if stackSize != 0 && instruction.BranchTarget is {} target {
                    if stackSizes.TryGetValue(target, out var existing) {
                        stackSizes[target] = Math.Max(existing, stackSize)
                    } else {
                        stackSizes[target] = stackSize
                    }
                }
                let flow = instruction.OpCode.FlowControl
                if flow == FlowControl.Branch || flow == FlowControl.Throw || flow == FlowControl.Return {
                    stackSize = 0
                }
            }
            return (maxStack, minStack)
        }

        private func ComputeStackDelta(
            reader MetadataReader,
            provider VoidMarkerProvider,
            methodReturnsValue bool,
            instruction IlInstruction
        )(Pop int32, Push int32) {
            let opcode = instruction.OpCode
            if opcode == OpCodes.Call || opcode == OpCodes.Callvirt || opcode == OpCodes.Newobj {
                let handle = MetadataTokens.EntityHandle(instruction.MetadataToken.GetValueOrDefault())
                let sig = DecodeCallSignature(reader, provider, handle)
                if opcode == OpCodes.Newobj {
                    return (sig.ParameterTypes.Length, 1)
                }
                let pop = sig
                    .ParameterTypes
                    .Length +
                    (
                    if sig.Header.IsInstance {
                        1
                    } else {
                        0
                    }
                )
                let push = if sig.ReturnType == 0 {
                    0
                } else {
                    1
                }
                return (pop, push)
            }
            if opcode == OpCodes.Ret {
                return (
                    if methodReturnsValue {
                        1
                    } else {
                        0
                    },
                    0
                )
            }
            let popCount = switch opcode.StackBehaviourPop {
                case StackBehaviour.Pop0: 0
                case StackBehaviour.Pop1, StackBehaviour.Popi, StackBehaviour.Popref: 1
                case StackBehaviour.Pop1_pop1,
                StackBehaviour.Popi_pop1,
                StackBehaviour.Popi_popi,
                StackBehaviour.Popi_popi8,
                StackBehaviour.Popi_popr4,
                StackBehaviour.Popi_popr8,
                StackBehaviour.Popref_pop1,
                StackBehaviour.Popref_popi: 2
                case StackBehaviour.Popi_popi_popi,
                StackBehaviour.Popref_popi_popi,
                StackBehaviour.Popref_popi_popi8,
                StackBehaviour.Popref_popi_popr4,
                StackBehaviour.Popref_popi_popr8,
                StackBehaviour.Popref_popi_popref,
                StackBehaviour.Popref_popi_pop1: 3
                default: 0
            }
            let pushCount = switch opcode.StackBehaviourPush {
                case StackBehaviour.Push0: 0
                case StackBehaviour.Push1,
                StackBehaviour.Pushi,
                StackBehaviour.Pushi8,
                StackBehaviour.Pushr4,
                StackBehaviour.Pushr8,
                StackBehaviour.Pushref: 1
                case StackBehaviour.Push1_push1: 2
                default: 0
            }
            return (popCount, pushCount)
        }

        private func DecodeCallSignature(
            reader MetadataReader,
            provider VoidMarkerProvider,
            handle EntityHandle
        ) MethodSignature[int32] {
            switch handle.Kind {
                case HandleKind.MethodDefinition {
                    let def = reader.GetMethodDefinition(cast[MethodDefinitionHandle](handle))
                    return def.DecodeSignature(provider, nil)
                }
                case HandleKind.MemberReference {
                    let memberRef = reader.GetMemberReference(cast[MemberReferenceHandle](handle))
                    return memberRef.DecodeMethodSignature(provider, nil)
                }
                case HandleKind.MethodSpecification {
                    let spec = reader.GetMethodSpecification(cast[MethodSpecificationHandle](handle))
                    return DecodeCallSignature(reader, provider, spec.Method)
                }
                default {
                    throw InvalidOperationException("Unsupported call target handle kind '${handle.Kind}'.")
                }
            }
        }
    }
}
