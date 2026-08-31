// <copyright file="NormalizedIlDump.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Text;

namespace GSharp.Compiler.Tests.LanguageConformance;

/// <summary>
/// Issue #3717: renders an emitted assembly as a text dump that is stable
/// across reference closures, so two compilations of the same source — one
/// against the host's trusted platform assemblies, one against the
/// <c>Microsoft.NETCore.App.Ref</c> targeting pack — can be diffed for
/// codegen divergence.
/// <para>
/// The two PEs are never byte-identical: they carry different
/// <c>AssemblyRef</c> rows (<c>System.Private.CoreLib</c> versus the facade
/// set), in a different order, so every <c>TypeRef</c> / <c>MemberRef</c>
/// token differs numerically. The dump therefore resolves every metadata
/// token to a <em>name</em> — <c>Namespace.Type::Member(signature)</c> with
/// the defining assembly deliberately dropped — and orders methods by that
/// name rather than by table row. What survives is exactly the thing the
/// differential is about: the opcode stream, the exception-handling regions
/// and the local-variable types.
/// </para>
/// <para>
/// This is the <c>System.Reflection.Metadata</c> dumper model established by
/// PR #3692's baseline audit, extended with EH regions because the defect
/// class it is aimed at (#3708 — the missing <c>for … in</c> disposal
/// <c>finally</c>) is precisely a missing protected region.
/// </para>
/// </summary>
internal static class NormalizedIlDump
{
    private static readonly Dictionary<short, OpCode> OpCodesByValue = typeof(OpCodes)
        .GetFields(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)
        .Where(field => field.FieldType == typeof(OpCode))
        .Select(field => (OpCode)field.GetValue(null))
        .ToDictionary(opcode => opcode.Value);

    /// <summary>
    /// Produces the normalised dump of the assembly at
    /// <paramref name="assemblyPath"/>.
    /// </summary>
    /// <param name="assemblyPath">Path to the emitted .dll.</param>
    /// <returns>A deterministic, reference-closure-independent text dump.</returns>
    public static string Create(string assemblyPath)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        MetadataReader reader = pe.GetMetadataReader();
        var provider = new NameTypeProvider();

        var methods = new List<(string Key, string Body)>();
        foreach (MethodDefinitionHandle handle in reader.MethodDefinitions)
        {
            MethodDefinition method = reader.GetMethodDefinition(handle);
            string signature = SafeDecode(
                () => Describe(method.DecodeSignature(provider, null)),
                "<bad-signature>");
            string key = TypeName(reader, method.GetDeclaringType(), provider)
                + "::" + reader.GetString(method.Name) + signature;

            var builder = new StringBuilder();
            builder.Append("method ").Append(key).Append(" [")
                .Append(method.Attributes).Append('|').Append(method.ImplAttributes).Append("]\n");
            AppendBody(builder, pe, reader, provider, method);
            methods.Add((key, builder.ToString()));
        }

        return string.Concat(methods
            .OrderBy(entry => entry.Key, StringComparer.Ordinal)
            .ThenBy(entry => entry.Body, StringComparer.Ordinal)
            .Select(entry => entry.Body));
    }

    /// <summary>
    /// The <c>AssemblyRef</c> names of an emitted assembly. Used by the
    /// differential suite's non-vacuity check: a TPA compile references
    /// <c>System.Private.CoreLib</c>, a ref-pack compile references the
    /// facades, so two dumps that agree while these sets are identical would
    /// mean the second mode silently fell back to runtime types.
    /// </summary>
    /// <param name="assemblyPath">Path to the emitted .dll.</param>
    /// <returns>The referenced assembly simple names, ordered.</returns>
    public static IReadOnlyList<string> AssemblyReferenceNames(string assemblyPath)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        MetadataReader reader = pe.GetMetadataReader();
        return reader.AssemblyReferences
            .Select(handle => reader.GetString(reader.GetAssemblyReference(handle).Name))
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
    }

    private static void AppendBody(
        StringBuilder builder,
        PEReader pe,
        MetadataReader reader,
        NameTypeProvider provider,
        MethodDefinition method)
    {
        int rva = method.RelativeVirtualAddress;
        if (rva == 0)
        {
            builder.Append("  <no body>\n");
            return;
        }

        MethodBodyBlock body = pe.GetMethodBody(rva);

        if (!body.LocalSignature.IsNil)
        {
            ImmutableArray<string> locals = SafeDecode(
                () => reader.GetStandaloneSignature(body.LocalSignature)
                    .DecodeLocalSignature(provider, null),
                ImmutableArray<string>.Empty);
            builder.Append("  .locals (").Append(string.Join(", ", locals)).Append(")\n");
        }

        foreach (ExceptionRegion region in body.ExceptionRegions
            .OrderBy(region => region.TryOffset)
            .ThenBy(region => region.HandlerOffset))
        {
            builder.Append("  .region ").Append(region.Kind)
                .Append(" try IL_").Append(Hex(region.TryOffset))
                .Append("..IL_").Append(Hex(region.TryOffset + region.TryLength))
                .Append(" handler IL_").Append(Hex(region.HandlerOffset))
                .Append("..IL_").Append(Hex(region.HandlerOffset + region.HandlerLength));
            if (region.Kind == ExceptionRegionKind.Catch)
            {
                builder.Append(" catch ").Append(RenderHandle(reader, provider, region.CatchType));
            }
            else if (region.Kind == ExceptionRegionKind.Filter)
            {
                builder.Append(" filter IL_").Append(Hex(region.FilterOffset));
            }

            builder.Append('\n');
        }

        foreach (string instruction in ReadInstructions(body.GetILBytes(), reader, provider))
        {
            builder.Append("  ").Append(instruction).Append('\n');
        }
    }

    private static IEnumerable<string> ReadInstructions(
        byte[] il,
        MetadataReader reader,
        NameTypeProvider provider)
    {
        var lines = new List<string>();
        int offset = 0;
        while (offset < il.Length)
        {
            int instructionOffset = offset;
            short value = il[offset++] == 0xFE
                ? unchecked((short)(0xFE00 | il[offset++]))
                : unchecked((short)il[instructionOffset]);
            if (!OpCodesByValue.TryGetValue(value, out OpCode opcode))
            {
                lines.Add($"IL_{Hex(instructionOffset)}: <unknown 0x{value:X4}>");
                break;
            }

            string operand = string.Empty;
            switch (opcode.OperandType)
            {
                case OperandType.InlineNone:
                    break;
                case OperandType.ShortInlineBrTarget:
                    operand = " IL_" + Hex(offset + 1 + unchecked((sbyte)il[offset]));
                    offset += 1;
                    break;
                case OperandType.InlineBrTarget:
                    operand = " IL_" + Hex(offset + 4 + BitConverter.ToInt32(il, offset));
                    offset += 4;
                    break;
                case OperandType.InlineSwitch:
                    int count = BitConverter.ToInt32(il, offset);
                    offset += 4;
                    int baseOffset = offset + (count * 4);
                    var targets = new List<string>(count);
                    for (int i = 0; i < count; i++)
                    {
                        targets.Add("IL_" + Hex(baseOffset + BitConverter.ToInt32(il, offset)));
                        offset += 4;
                    }

                    operand = " (" + string.Join(", ", targets) + ")";
                    break;
                case OperandType.ShortInlineI:
                    operand = " " + unchecked((sbyte)il[offset]).ToString(CultureInfo.InvariantCulture);
                    offset += 1;
                    break;
                case OperandType.ShortInlineVar:
                    operand = " " + il[offset].ToString(CultureInfo.InvariantCulture);
                    offset += 1;
                    break;
                case OperandType.InlineVar:
                    operand = " " + BitConverter.ToUInt16(il, offset).ToString(CultureInfo.InvariantCulture);
                    offset += 2;
                    break;
                case OperandType.InlineI:
                    operand = " " + BitConverter.ToInt32(il, offset).ToString(CultureInfo.InvariantCulture);
                    offset += 4;
                    break;
                case OperandType.ShortInlineR:
                    operand = " " + BitConverter.ToSingle(il, offset).ToString("R", CultureInfo.InvariantCulture);
                    offset += 4;
                    break;
                case OperandType.InlineI8:
                    operand = " " + BitConverter.ToInt64(il, offset).ToString(CultureInfo.InvariantCulture);
                    offset += 8;
                    break;
                case OperandType.InlineR:
                    operand = " " + BitConverter.ToDouble(il, offset).ToString("R", CultureInfo.InvariantCulture);
                    offset += 8;
                    break;
                case OperandType.InlineMethod:
                case OperandType.InlineField:
                case OperandType.InlineType:
                case OperandType.InlineTok:
                case OperandType.InlineSig:
                case OperandType.InlineString:
                    operand = " " + RenderToken(reader, provider, BitConverter.ToInt32(il, offset));
                    offset += 4;
                    break;
                default:
                    throw new InvalidOperationException(
                        $"Unsupported IL operand type {opcode.OperandType}.");
            }

            lines.Add($"IL_{Hex(instructionOffset)}: {opcode.Name}{operand}");
        }

        return lines;
    }

    /// <summary>
    /// Resolves a metadata token to a name. This is the normalisation that
    /// makes the two closures comparable: the numeric token, the row order and
    /// the defining assembly are all discarded, only the member's fully
    /// qualified name and signature survive.
    /// </summary>
    /// <param name="reader">The metadata reader.</param>
    /// <param name="provider">The signature type provider.</param>
    /// <param name="token">The raw metadata token from the IL stream.</param>
    /// <returns>A closure-independent rendering of the token.</returns>
    private static string RenderToken(MetadataReader reader, NameTypeProvider provider, int token)
    {
        // 0x70 is the UserString heap, which is not an EntityHandle.
        if ((token >>> 24) == 0x70)
        {
            string literal = SafeDecode(
                () => reader.GetUserString(MetadataTokens.UserStringHandle(token)),
                "<bad-string>");
            return "\"" + literal.Replace("\\", "\\\\", StringComparison.Ordinal)
                .Replace("\"", "\\\"", StringComparison.Ordinal)
                .Replace("\n", "\\n", StringComparison.Ordinal)
                .Replace("\r", "\\r", StringComparison.Ordinal) + "\"";
        }

        return RenderHandle(reader, provider, MetadataTokens.EntityHandle(token));
    }

    private static string RenderHandle(
        MetadataReader reader,
        NameTypeProvider provider,
        EntityHandle handle)
    {
        if (handle.IsNil)
        {
            return "<nil>";
        }

        return SafeDecode(() => RenderHandleCore(reader, provider, handle), "<unresolved>");
    }

    private static string RenderHandleCore(
        MetadataReader reader,
        NameTypeProvider provider,
        EntityHandle handle)
    {
        switch (handle.Kind)
        {
            case HandleKind.TypeDefinition:
            case HandleKind.TypeReference:
            case HandleKind.TypeSpecification:
                return TypeName(reader, handle, provider);

            case HandleKind.MethodDefinition:
            {
                MethodDefinition method = reader.GetMethodDefinition((MethodDefinitionHandle)handle);
                return TypeName(reader, method.GetDeclaringType(), provider)
                    + "::" + reader.GetString(method.Name)
                    + Describe(method.DecodeSignature(provider, null));
            }

            case HandleKind.FieldDefinition:
            {
                FieldDefinition field = reader.GetFieldDefinition((FieldDefinitionHandle)handle);
                return TypeName(reader, field.GetDeclaringType(), provider)
                    + "::" + reader.GetString(field.Name)
                    + " : " + field.DecodeSignature(provider, null);
            }

            case HandleKind.MemberReference:
            {
                MemberReference member = reader.GetMemberReference((MemberReferenceHandle)handle);
                string parent = member.Parent.Kind == HandleKind.ModuleReference
                    ? "<module>"
                    : TypeName(reader, member.Parent, provider);
                string signature = member.GetKind() == MemberReferenceKind.Field
                    ? " : " + member.DecodeFieldSignature(provider, null)
                    : Describe(member.DecodeMethodSignature(provider, null));
                return parent + "::" + reader.GetString(member.Name) + signature;
            }

            case HandleKind.MethodSpecification:
            {
                MethodSpecification spec = reader.GetMethodSpecification((MethodSpecificationHandle)handle);
                ImmutableArray<string> arguments = spec.DecodeSignature(provider, null);
                return RenderHandle(reader, provider, spec.Method)
                    + "<" + string.Join(", ", arguments) + ">";
            }

            case HandleKind.StandaloneSignature:
            {
                StandaloneSignature signature =
                    reader.GetStandaloneSignature((StandaloneSignatureHandle)handle);
                return "sig" + Describe(signature.DecodeMethodSignature(provider, null));
            }

            default:
                return handle.Kind.ToString();
        }
    }

    private static string TypeName(
        MetadataReader reader,
        EntityHandle handle,
        NameTypeProvider provider)
    {
        switch (handle.Kind)
        {
            case HandleKind.TypeDefinition:
            {
                TypeDefinition definition = reader.GetTypeDefinition((TypeDefinitionHandle)handle);
                string name = reader.GetString(definition.Name);
                if (definition.IsNested)
                {
                    return TypeName(reader, definition.GetDeclaringType(), provider) + "+" + name;
                }

                string ns = reader.GetString(definition.Namespace);
                return string.IsNullOrEmpty(ns) ? name : ns + "." + name;
            }

            case HandleKind.TypeReference:
            {
                TypeReference reference = reader.GetTypeReference((TypeReferenceHandle)handle);
                string name = reader.GetString(reference.Name);

                // The resolution scope is deliberately ignored when it is an
                // AssemblyRef: that is exactly the axis the two closures differ
                // on (System.Private.CoreLib versus the facade set).
                if (reference.ResolutionScope.Kind == HandleKind.TypeReference)
                {
                    return TypeName(reader, reference.ResolutionScope, provider) + "+" + name;
                }

                string ns = reader.GetString(reference.Namespace);
                return string.IsNullOrEmpty(ns) ? name : ns + "." + name;
            }

            case HandleKind.TypeSpecification:
                return reader.GetTypeSpecification((TypeSpecificationHandle)handle)
                    .DecodeSignature(provider, null);

            default:
                return handle.Kind.ToString();
        }
    }

    private static string Describe(MethodSignature<string> signature)
    {
        string generics = signature.GenericParameterCount > 0
            ? "`" + signature.GenericParameterCount.ToString(CultureInfo.InvariantCulture)
            : string.Empty;
        return generics + "(" + string.Join(", ", signature.ParameterTypes) + ") : "
            + signature.ReturnType;
    }

    private static string Hex(int offset)
        => offset.ToString("X4", CultureInfo.InvariantCulture);

    private static T SafeDecode<T>(Func<T> decode, T fallback)
    {
        try
        {
            return decode();
        }
        catch (BadImageFormatException)
        {
            return fallback;
        }
        catch (InvalidOperationException)
        {
            return fallback;
        }
    }

    /// <summary>
    /// Renders signature blobs as assembly-agnostic type names.
    /// </summary>
    private sealed class NameTypeProvider : ISignatureTypeProvider<string, object>
    {
        public string GetArrayType(string elementType, ArrayShape shape)
            => elementType + "[" + new string(',', Math.Max(0, shape.Rank - 1)) + "]";

        public string GetByReferenceType(string elementType) => elementType + "&";

        public string GetFunctionPointerType(MethodSignature<string> signature)
            => "method " + signature.ReturnType + " *("
                + string.Join(", ", signature.ParameterTypes) + ")";

        public string GetGenericInstantiation(string genericType, ImmutableArray<string> typeArguments)
            => genericType + "<" + string.Join(", ", typeArguments) + ">";

        public string GetGenericMethodParameter(object genericContext, int index)
            => "!!" + index.ToString(CultureInfo.InvariantCulture);

        public string GetGenericTypeParameter(object genericContext, int index)
            => "!" + index.ToString(CultureInfo.InvariantCulture);

        public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired)
            => unmodifiedType + (isRequired ? " modreq(" : " modopt(") + modifier + ")";

        public string GetPinnedType(string elementType) => elementType + " pinned";

        public string GetPointerType(string elementType) => elementType + "*";

        public string GetPrimitiveType(PrimitiveTypeCode typeCode) => typeCode.ToString();

        public string GetSZArrayType(string elementType) => elementType + "[]";

        public string GetTypeFromDefinition(
            MetadataReader metadataReader,
            TypeDefinitionHandle handle,
            byte rawTypeKind)
            => TypeName(metadataReader, handle, this);

        public string GetTypeFromReference(
            MetadataReader metadataReader,
            TypeReferenceHandle handle,
            byte rawTypeKind)
            => TypeName(metadataReader, handle, this);

        public string GetTypeFromSpecification(
            MetadataReader metadataReader,
            object genericContext,
            TypeSpecificationHandle handle,
            byte rawTypeKind)
            => metadataReader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);
    }
}
