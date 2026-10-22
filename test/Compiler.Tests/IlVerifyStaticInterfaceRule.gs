package GSharp.Compiler.Tests

import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable

/// #5112: ILVerify 10.0.8 rejects the CLR's constrained static interface calls.
/// Upstream dotnet/runtime#132944 fixes this. Until a stable tool includes it,
/// accept only a reported call whose local slot and type constraint prove this shape.
internal shared class IlVerifyStaticInterfaceRule {
    func Matches(assemblyPath string, line string) bool {
        let code = if line.StartsWith("[IL]: Error [CallAbstract]:", StringComparison.Ordinal) {
            "CallAbstract"
        } else {
            "Constrained"
        }
        if !IlVerifyFilterInFinallyRule.TryParse(
            line,
            out var typeName,
            out var methodName,
            out var parameterCount,
            out var offset,
            code
        ) {
            return false
        }
        try {
            using let pe = PEReader(File.OpenRead(assemblyPath))
            let reader = pe.GetMetadataReader()
            let methods = reader
                .MethodDefinitions
                .Where(
                (handle MethodDefinitionHandle) -> {
                    let method = reader.GetMethodDefinition(handle)
                    return IlVerifyFilterInFinallyRule.NameMatches(
                        typeName,
                        IlVerifyFilterInFinallyRule.GetTypeName(reader, method.GetDeclaringType())
                    ) &&
                        IlVerifyFilterInFinallyRule.NameMatches(methodName, reader.GetString(method.Name)) &&
                        IlVerifyFilterInFinallyRule.GetParameterCount(reader, method) == parameterCount
                }
            )
                .ToArray()
            // ILVerify's rendered identity cannot distinguish same-arity overloads.

            if methods.Length != 1 {
                return false
            }
            let caller = reader.GetMethodDefinition(methods[0])
            if caller.RelativeVirtualAddress == 0 {
                return false
            }
            let il = pe.GetMethodBody(caller.RelativeVirtualAddress).GetILBytes()
            if il == nil {
                return false
            }
            let instructions = IlInstructionReader.Read(il)
            let callIndex = Array.FindIndex(instructions, (i IlInstruction) -> i.Offset == offset)
            if callIndex < 1 ||
                instructions[callIndex].OpCode != OpCodes.Call ||
                instructions[callIndex - 1].OpCode != OpCodes.Constrained ||
                instructions[callIndex - 1].Offset +
                6 != offset ||
                instructions.Any(
                (i IlInstruction) -> i.BranchTarget == offset || i.OpCode.OperandType == OperandType.InlineSwitch
            ) {
                return false
            }
            // A handler or protected region must not enter after the prefix.

            if pe
                .GetMethodBody(caller.RelativeVirtualAddress)
                .ExceptionRegions
                .Any(
                (r ExceptionRegion) -> r.TryOffset == offset || r.HandlerOffset == offset || r.FilterOffset == offset
            ) {
                return false
            }
            let target = MetadataTokens.EntityHandle(instructions[callIndex].MetadataToken ?? 0)
            // External, constructed and generic slots fail closed. The existing

            // explicit debt bundles still cover those older test fixtures.

            if target.Kind != HandleKind.MethodDefinition {
                return false
            }
            let slot = reader.GetMethodDefinition(MethodDefinitionHandle(target))
            let flags = MethodAttributes.Static | MethodAttributes.Virtual
            if (slot.Attributes & flags) != flags ||
                (code == "CallAbstract" && (slot.Attributes & MethodAttributes.Abstract) == 0) ||
                (reader.GetTypeDefinition(slot.GetDeclaringType()).Attributes & TypeAttributes.Interface) == 0 {
                return false
            }
            let constraintType = MetadataTokens.EntityHandle(BitConverter.ToInt32(il, offset - 4))
            if constraintType.Kind != HandleKind.TypeSpecification {
                return false
            }
            var blob = reader.GetBlobReader(
                reader.GetTypeSpecification(TypeSpecificationHandle(constraintType)).Signature
            )
            if blob.ReadByte() != uint8(0x1E) {
                // MVAR: a method type parameter

                return false
            }
            let index = blob.ReadCompressedInteger()
            if blob.RemainingBytes != 0 {
                return false
            }
            for parameterHandle in caller.GetGenericParameters() {
                let parameter = reader.GetGenericParameter(parameterHandle)
                if parameter.Index != index {
                    continue
                }
                for constraintHandle in parameter.GetConstraints() {
                    if reader.GetGenericParameterConstraint(constraintHandle).Type == slot.GetDeclaringType() {
                        return true
                    }
                }
            }
        } catch (BadImageFormatException) { } catch (ArgumentException) { } catch (IndexOutOfRangeException) { } catch (
            InvalidOperationException
        ) { }
        return false
    }
}
