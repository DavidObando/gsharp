// <copyright file="NormalizedIlDump.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.LanguageConformance

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Text

/// Issue #3717: renders an emitted assembly as a text dump that is stable
/// across reference closures, so two compilations of the same source — one
/// against the host's trusted platform assemblies, one against the
/// `Microsoft.NETCore.App.Ref` targeting pack — can be diffed for
/// codegen divergence.
///
/// The two PEs are never byte-identical: they carry different
/// `AssemblyRef` rows (`System.Private.CoreLib` versus the facade
/// set), in a different order, so every `TypeRef` / `MemberRef`
/// token differs numerically. The dump therefore resolves every metadata
/// token to a <em>name</em> — `Namespace.Type::Member(signature)` with
/// the defining assembly deliberately dropped — and orders methods by that
/// name rather than by table row. What survives is exactly the thing the
/// differential is about: the opcode stream, the exception-handling regions
/// and the local-variable types.
///
/// This is the `System.Reflection.Metadata` dumper model established by
/// PR #3692's baseline audit, extended with EH regions because the defect
/// class it is aimed at (#3708 — the missing `for … in` disposal
/// `finally`) is precisely a missing protected region.
internal shared class NormalizedIlDump {
    /// Renders signature blobs as assembly-agnostic type names.
    private class NameTypeProvider : ISignatureTypeProvider[string, object] {
        func GetArrayType(elementType string, shape ArrayShape) string -> elementType +
            "[" +
            String(',', Math.Max(0, shape.Rank - 1)) +
            "]"

        func GetByReferenceType(elementType string) string -> elementType + "&"

        func GetFunctionPointerType(signature MethodSignature[string]) string -> "method " +
            signature.ReturnType +
            " *(" +
            string.Join(", ", signature.ParameterTypes) + ")"

        func GetGenericInstantiation(genericType string, typeArguments ImmutableArray[string]) string -> genericType +
            "<" +
            string.Join(", ", typeArguments) + ">"

        func GetGenericMethodParameter(genericContext object, index int32) string -> "!!" + index.ToString(
            CultureInfo.InvariantCulture
        )

        func GetGenericTypeParameter(genericContext object, index int32) string -> "!" + index.ToString(
            CultureInfo.InvariantCulture
        )

        func GetModifiedType(modifier string, unmodifiedType string, isRequired bool) string -> unmodifiedType +
            (
            if isRequired {
                " modreq("
            } else {
                " modopt("
            }
        ) +
            modifier +
            ")"

        func GetPinnedType(elementType string) string -> elementType + " pinned"

        func GetPointerType(elementType string) string -> elementType + "*"

        func GetPrimitiveType(typeCode PrimitiveTypeCode) string -> typeCode.ToString()

        func GetSZArrayType(elementType string) string -> elementType + "[]"

        func GetTypeFromDefinition(
            metadataReader MetadataReader,
            handle TypeDefinitionHandle,
            rawTypeKind uint8
        ) string -> NormalizedIlDump.TypeName(metadataReader, handle, this)

        func GetTypeFromReference(
            metadataReader MetadataReader,
            handle TypeReferenceHandle,
            rawTypeKind uint8
        ) string -> NormalizedIlDump.TypeName(metadataReader, handle, this)

        func GetTypeFromSpecification(
            metadataReader MetadataReader,
            genericContext object,
            handle TypeSpecificationHandle,
            rawTypeKind uint8
        ) string -> metadataReader
            .GetTypeSpecification(handle).DecodeSignature(this, genericContext)
    }

    private let OpCodesByValue Dictionary[int16, OpCode] = typeof(OpCodes)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .Where((field FieldInfo) -> field.FieldType == typeof(OpCode))
        .Select((field FieldInfo) -> OpCode(field.GetValue(nil)))
        .ToDictionary((opcode OpCode) -> opcode.Value)

    /// Produces the normalised dump of the assembly at
    /// [`assemblyPath`](paramref).
    /// @param assemblyPath Path to the emitted .dll.
    /// @returns A deterministic, reference-closure-independent text dump.
    func Create(assemblyPath string) string {
        using let stream = File.OpenRead(assemblyPath)
        using let pe = PEReader(stream)
        let reader = pe.GetMetadataReader()
        let provider = NameTypeProvider()
        let methods = List[(Key string, Body string)]()
        for handle in reader.MethodDefinitions {
            let method = reader.GetMethodDefinition(handle)
            let signature = SafeDecode(() -> Describe(method.DecodeSignature(provider, nil)), "<bad-signature>")
            let key = NormalizedIlDump.TypeName(reader, method.GetDeclaringType(), provider) + "::" + reader.GetString(
                method.Name
            ) +
                signature
            let builder = StringBuilder()
            builder
                .Append("method ")
                .Append(key)
                .Append(" [")
                .Append(method.Attributes)
                .Append('|')
                .Append(method.ImplAttributes)
                .Append("]\n")
            AppendBody(builder, pe, reader, provider, method)
            methods.Add((key, builder.ToString()))
        }
        return string.Concat(
            methods
                .OrderBy((entry(Key string, Body string)) -> entry.Key, StringComparer.Ordinal)
                .ThenBy((entry(Key string, Body string)) -> entry.Body, StringComparer.Ordinal)
                .Select((entry(Key string, Body string)) -> entry.Body)
        )
    }

    /// The `AssemblyRef` names of an emitted assembly. Used by the
    /// differential suite's non-vacuity check: a TPA compile references
    /// `System.Private.CoreLib`, a ref-pack compile references the
    /// facades, so two dumps that agree while these sets are identical would
    /// mean the second mode silently fell back to runtime types.
    /// @param assemblyPath Path to the emitted .dll.
    /// @returns The referenced assembly simple names, ordered.
    func AssemblyReferenceNames(assemblyPath string) IReadOnlyList[string] {
        using let stream = File.OpenRead(assemblyPath)
        using let pe = PEReader(stream)
        let reader = pe.GetMetadataReader()
        return reader
            .AssemblyReferences
            .Select((handle AssemblyReferenceHandle) -> reader.GetString(reader.GetAssemblyReference(handle).Name))
            .OrderBy((name string) -> name, StringComparer.Ordinal)
            .ToArray()
    }

    private func AppendBody(
        builder StringBuilder,
        pe PEReader,
        reader MetadataReader,
        provider NameTypeProvider,
        method MethodDefinition
    ) {
        let rva = method.RelativeVirtualAddress
        if rva == 0 {
            builder.Append("  <no body>\n")
            return
        }
        let body = pe.GetMethodBody(rva)
        if !body.LocalSignature.IsNil {
            let locals = SafeDecode(
                () -> reader.GetStandaloneSignature(body.LocalSignature).DecodeLocalSignature(provider, nil),
                ImmutableArray[string].Empty
            )
            builder.Append("  .locals (").Append(string.Join(", ", locals)).Append(")\n")
        }
        for region in body
            .ExceptionRegions
            .OrderBy((region ExceptionRegion) -> region.TryOffset)
            .ThenBy((region ExceptionRegion) -> region.HandlerOffset) {
            builder
                .Append("  .region ")
                .Append(region.Kind)
                .Append(" try IL_")
                .Append(Hex(region.TryOffset))
                .Append("..IL_")
                .Append(Hex(region.TryOffset + region.TryLength))
                .Append(" handler IL_")
                .Append(Hex(region.HandlerOffset))
                .Append("..IL_")
                .Append(Hex(region.HandlerOffset + region.HandlerLength))
            if region.Kind == ExceptionRegionKind.Catch {
                builder.Append(" catch ").Append(RenderHandle(reader, provider, region.CatchType))
            } else if region.Kind == ExceptionRegionKind.Filter {
                builder.Append(" filter IL_").Append(Hex(region.FilterOffset))
            }
            builder.Append('\n')
        }
        for instruction in ReadInstructions(body.GetILBytes(), reader, provider) {
            builder.Append("  ").Append(instruction).Append('\n')
        }
    }

    private func ReadInstructions(il[]?uint8, reader MetadataReader, provider NameTypeProvider) IEnumerable[string] {
        let lines = List[string]()
        var offset = 0
        while offset < il!!.Length {
            let instructionOffset = offset
            let value = if il!![offset++] == uint8(0xFE) {
                unchecked(int16((0xFE00 | int32(il!![offset++]))))
            } else {
                unchecked(int16(il!![instructionOffset]))
            }
            if !OpCodesByValue.TryGetValue(value, out var opcode) {
                lines.Add("IL_${Hex(instructionOffset)}: <unknown 0x${value:X4}>")
                break
            }
            var operand = string.Empty
            switch opcode.OperandType {
                case OperandType.InlineNone { }
                case OperandType.ShortInlineBrTarget {
                    operand = " IL_" + Hex(offset + 1 + int32(unchecked(int8(il!![offset]))))
                    offset += 1
                }
                case OperandType.InlineBrTarget {
                    operand = " IL_" + Hex(offset + 4 + BitConverter.ToInt32(il!!, offset))
                    offset += 4
                }
                case OperandType.InlineSwitch {
                    let count = BitConverter.ToInt32(il!!, offset)
                    offset += 4
                    let baseOffset = offset + (count * 4)
                    let targets = List[string](count)
                    for var i = 0; i < count; i++ {
                        targets.Add("IL_" + Hex(baseOffset + BitConverter.ToInt32(il!!, offset)))
                        offset += 4
                    }
                    operand = " (" + string.Join(", ", targets) + ")"
                }
                case OperandType.ShortInlineI {
                    operand = " " + unchecked(int8(il!![offset])).ToString(CultureInfo.InvariantCulture)
                    offset += 1
                }
                case OperandType.ShortInlineVar {
                    operand = " " + il!![offset].ToString(CultureInfo.InvariantCulture)
                    offset += 1
                }
                case OperandType.InlineVar {
                    operand = " " + BitConverter.ToUInt16(il!!, offset).ToString(CultureInfo.InvariantCulture)
                    offset += 2
                }
                case OperandType.InlineI {
                    operand = " " + BitConverter.ToInt32(il!!, offset).ToString(CultureInfo.InvariantCulture)
                    offset += 4
                }
                case OperandType.ShortInlineR {
                    operand = " " + BitConverter.ToSingle(il!!, offset).ToString("R", CultureInfo.InvariantCulture)
                    offset += 4
                }
                case OperandType.InlineI8 {
                    operand = " " + BitConverter.ToInt64(il!!, offset).ToString(CultureInfo.InvariantCulture)
                    offset += 8
                }
                case OperandType.InlineR {
                    operand = " " + BitConverter.ToDouble(il!!, offset).ToString("R", CultureInfo.InvariantCulture)
                    offset += 8
                }
                case OperandType.InlineMethod,
                OperandType.InlineField,
                OperandType.InlineType,
                OperandType.InlineTok,
                OperandType.InlineSig,
                OperandType.InlineString {
                    operand = " " + RenderToken(reader, provider, BitConverter.ToInt32(il!!, offset))
                    offset += 4
                }
                default {
                    throw InvalidOperationException("Unsupported IL operand type ${opcode.OperandType}.")
                }
            }
            lines.Add("IL_${Hex(instructionOffset)}: ${opcode.Name}$operand")
        }
        return lines
    }

    /// Resolves a metadata token to a name. This is the normalisation that
    /// makes the two closures comparable: the numeric token, the row order and
    /// the defining assembly are all discarded, only the member's fully
    /// qualified name and signature survive.
    /// @param reader The metadata reader.
    /// @param provider The signature type provider.
    /// @param token The raw metadata token from the IL stream.
    /// @returns A closure-independent rendering of the token.
    private func RenderToken(reader MetadataReader, provider NameTypeProvider, token int32) string {
        // 0x70 is the UserString heap, which is not an EntityHandle.
        if (token >>> 24) == 0x70 {
            let literal = SafeDecode(() -> reader.GetUserString(MetadataTokens.UserStringHandle(token)), "<bad-string>")
            return "\"" +
                literal
                .Replace("\\", "\\\\", StringComparison.Ordinal)
                .Replace("\"", "\\\"", StringComparison.Ordinal)
                .Replace("\n", "\\n", StringComparison.Ordinal)
                .Replace("\r", "\\r", StringComparison.Ordinal) +
                "\""
        }
        return RenderHandle(reader, provider, MetadataTokens.EntityHandle(token))
    }

    private func RenderHandle(reader MetadataReader, provider NameTypeProvider, handle EntityHandle) string {
        if handle.IsNil {
            return "<nil>"
        }
        return SafeDecode(() -> RenderHandleCore(reader, provider, handle), "<unresolved>")
    }

    private func RenderHandleCore(reader MetadataReader, provider NameTypeProvider, handle EntityHandle) string {
        switch handle.Kind {
            case HandleKind.TypeDefinition, HandleKind.TypeReference, HandleKind.TypeSpecification {
                return NormalizedIlDump.TypeName(reader, handle, provider)
            }
            case HandleKind.MethodDefinition {
                {
                    let method = reader.GetMethodDefinition(MethodDefinitionHandle(handle))
                    return NormalizedIlDump.TypeName(reader, method.GetDeclaringType(), provider) +
                        "::" +
                        reader.GetString(method.Name) + Describe(method.DecodeSignature(provider, nil))
                }
            }
            case HandleKind.FieldDefinition {
                {
                    let field = reader.GetFieldDefinition(FieldDefinitionHandle(handle))
                    return NormalizedIlDump.TypeName(reader, field.GetDeclaringType(), provider) +
                        "::" +
                        reader.GetString(field.Name) + " : " + field.DecodeSignature(provider, nil)
                }
            }
            case HandleKind.MemberReference {
                {
                    let member = reader.GetMemberReference(MemberReferenceHandle(handle))
                    let parent = if member.Parent.Kind == HandleKind.ModuleReference {
                        "<module>"
                    } else {
                        NormalizedIlDump.TypeName(reader, member.Parent, provider)
                    }
                    let signature = if member.GetKind() == MemberReferenceKind.Field {
                        " : " + member.DecodeFieldSignature(provider, nil)
                    } else {
                        Describe(member.DecodeMethodSignature(provider, nil))
                    }
                    return parent + "::" + reader.GetString(member.Name) + signature
                }
            }
            case HandleKind.MethodSpecification {
                {
                    let spec = reader.GetMethodSpecification(MethodSpecificationHandle(handle))
                    let arguments = spec.DecodeSignature(provider, nil)
                    return RenderHandle(reader, provider, spec.Method) + "<" + string.Join(", ", arguments) + ">"
                }
            }
            case HandleKind.StandaloneSignature {
                {
                    let signature = reader.GetStandaloneSignature(StandaloneSignatureHandle(handle))
                    return "sig" + Describe(signature.DecodeMethodSignature(provider, nil))
                }
            }
            default {
                return handle.Kind.ToString()
            }
        }
    }

    private func TypeName(reader MetadataReader, handle EntityHandle, provider NameTypeProvider) string {
        switch handle.Kind {
            case HandleKind.TypeDefinition {
                {
                    let definition = reader.GetTypeDefinition(TypeDefinitionHandle(handle))
                    let name = reader.GetString(definition.Name)
                    if definition.IsNested {
                        return NormalizedIlDump.TypeName(reader, definition.GetDeclaringType(), provider) + "+" + name
                    }
                    let ns = reader.GetString(definition.Namespace)
                    return if string.IsNullOrEmpty(ns) {
                        name
                    } else {
                        ns + "." + name
                    }
                }
            }
            case HandleKind.TypeReference {
                {
                    let reference = reader.GetTypeReference(TypeReferenceHandle(handle))
                    let name = reader.GetString(reference.Name)
                    // The resolution scope is deliberately ignored when it is an
                    // AssemblyRef: that is exactly the axis the two closures differ
                    // on (System.Private.CoreLib versus the facade set).
                    if reference.ResolutionScope.Kind == HandleKind.TypeReference {
                        return NormalizedIlDump.TypeName(reader, reference.ResolutionScope, provider) + "+" + name
                    }
                    let ns = reader.GetString(reference.Namespace)
                    return if string.IsNullOrEmpty(ns) {
                        name
                    } else {
                        ns + "." + name
                    }
                }
            }
            case HandleKind.TypeSpecification {
                return reader.GetTypeSpecification(TypeSpecificationHandle(handle)).DecodeSignature(provider, nil)
            }
            default {
                return handle.Kind.ToString()
            }
        }
    }

    private func Describe(signature MethodSignature[string]) string {
        let generics = if signature.GenericParameterCount > 0 {
            "`" + signature.GenericParameterCount.ToString(CultureInfo.InvariantCulture)
        } else {
            string.Empty
        }
        return generics + "(" + string.Join(", ", signature.ParameterTypes) + ") : " + signature.ReturnType
    }

    private func Hex(offset int32) string -> offset.ToString("X4", CultureInfo.InvariantCulture)

    private func SafeDecode[T](decode() -> T, fallback T) T {
        try {
            return decode()
        } catch (BadImageFormatException) {
            return fallback
        } catch (InvalidOperationException) {
            return fallback
        }
    }
}
