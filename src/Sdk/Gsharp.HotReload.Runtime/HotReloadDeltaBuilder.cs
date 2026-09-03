// <copyright file="HotReloadDeltaBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;

namespace Gsharp.HotReload.Runtime;

internal enum HotReloadDeltaStatus
{
    /// <summary>Delta is valid and ready to apply.</summary>
    Ready,

    /// <summary>Compilation produced no runtime-significant method changes.</summary>
    NoChanges,

    /// <summary>Edit changes metadata shape and requires process restart.</summary>
    Unsupported,
}

/// <summary>Builds stable-row Edit-and-Continue deltas from two G# PE images.</summary>
/// <remarks>
/// <see cref="MetadataUpdater"/> applies deltas but does not create them, while
/// Roslyn's EmitDifference pipeline requires a Roslyn compilation and cannot
/// consume G# bound programs. Keep this encoder limited to existing managed
/// method bodies; structural metadata edits return an explicit restart
/// diagnostic instead of synthesizing partial Roslyn behavior.
/// </remarks>
internal sealed class HotReloadDeltaBuilder
{
    private static readonly IReadOnlyDictionary<ushort, OperandType> OperandTypes = CreateOperandTypeMap();

    private readonly Guid moduleId;
    private readonly string moduleName;
    private readonly string metadataVersion;
    private readonly ImmutableArray<BaselineMethod> baselineMethods;
    private byte[] previousImage;
    private Dictionary<string, int> standaloneSignatures;
    private Dictionary<string, int> userStrings;
    private int standaloneSignatureCount;
    private int userStringHeapOffset;
    private int stringHeapOffset;
    private int blobHeapOffset;
    private int guidHeapOffset;
    private int generation;
    private Guid previousEncId;

    public HotReloadDeltaBuilder(byte[] baselineImage)
    {
        ArgumentNullException.ThrowIfNull(baselineImage);

        this.previousImage = baselineImage;
        using var stream = new MemoryStream(baselineImage, writable: false);
        using var peReader = new PEReader(stream);
        var reader = GetMetadataReader(peReader);
        var module = reader.GetModuleDefinition();

        this.moduleId = reader.GetGuid(module.Mvid);
        this.moduleName = reader.GetString(module.Name);
        this.metadataVersion = reader.MetadataVersion;
        this.userStringHeapOffset = reader.GetHeapSize(HeapIndex.UserString);
        this.stringHeapOffset = reader.GetHeapSize(HeapIndex.String);
        this.blobHeapOffset = reader.GetHeapSize(HeapIndex.Blob);
        this.guidHeapOffset = reader.GetHeapSize(HeapIndex.Guid);
        this.standaloneSignatureCount = reader.GetTableRowCount(TableIndex.StandAloneSig);
        this.standaloneSignatures = ReadStandaloneSignatures(reader);
        this.userStrings = ReadReferencedUserStrings(peReader, reader);
        this.baselineMethods = ReadBaselineMethods(reader);
    }

    public HotReloadDelta CreateUpdate(byte[] currentImage)
    {
        ArgumentNullException.ThrowIfNull(currentImage);

        using var previousStream = new MemoryStream(this.previousImage, writable: false);
        using var currentStream = new MemoryStream(currentImage, writable: false);
        using var previousPe = new PEReader(previousStream);
        using var currentPe = new PEReader(currentStream);
        var previousReader = GetMetadataReader(previousPe);
        var currentReader = GetMetadataReader(currentPe);

        // ADR-0174 P3-9: a method whose suspension changed (a channel
        // operation or a call to a suspending function was added to, or
        // removed from, a plain `func`) is compiled to a different shape
        // (`R` <-> `ValueTask[R]`, plus a state machine); that is a signature
        // change even though the source edit looks like a body edit, so it
        // gets its own restart diagnostic before the generic shape check.
        var suspensionChange = DetectSuspensionChange(previousReader, currentReader);
        if (suspensionChange != null)
        {
            return HotReloadDelta.Unsupported(suspensionChange);
        }

        var unsupportedReason = ValidateMetadataShape(previousReader, currentReader);
        if (unsupportedReason != null)
        {
            return HotReloadDelta.Unsupported(unsupportedReason);
        }

        var changedMethods = new List<MethodDefinitionHandle>();
        foreach (var methodHandle in currentReader.MethodDefinitions)
        {
            var previousMethod = previousReader.GetMethodDefinition(methodHandle);
            var currentMethod = currentReader.GetMethodDefinition(methodHandle);
            if (!MethodBodiesEquivalent(previousPe, previousReader, previousMethod, currentPe, currentReader, currentMethod))
            {
                changedMethods.Add(methodHandle);
            }
        }

        if (changedMethods.Count == 0)
        {
            return HotReloadDelta.NoChanges();
        }

        var nextSignatures = new Dictionary<string, int>(this.standaloneSignatures, StringComparer.Ordinal);
        var nextUserStrings = new Dictionary<string, int>(this.userStrings, StringComparer.Ordinal);
        var nextStandaloneSignatureCount = this.standaloneSignatureCount;
        var newStandaloneSignatures = new List<EntityHandle>();
        var metadata = new MetadataBuilder(
            this.userStringHeapOffset,
            this.stringHeapOffset,
            this.blobHeapOffset,
            this.guidHeapOffset);
        var encId = Guid.NewGuid();

        metadata.AddModule(
            generation: this.generation + 1,
            moduleName: metadata.GetOrAddString(this.moduleName),
            mvid: metadata.GetOrAddGuid(this.moduleId),
            encId: metadata.GetOrAddGuid(encId),
            encBaseId: metadata.GetOrAddGuid(this.previousEncId));

        var ilBuilder = new BlobBuilder();
        ilBuilder.WriteUInt32(0);
        var updatedMethodNames = ImmutableArray.CreateBuilder<string>(changedMethods.Count);

        foreach (var methodHandle in changedMethods)
        {
            var method = currentReader.GetMethodDefinition(methodHandle);
            if (method.RelativeVirtualAddress == 0)
            {
                return HotReloadDelta.Unsupported(
                    $"GSHR1001: method '{GetMethodDisplayName(currentReader, methodHandle)}' changed from managed IL to a body-less method. Restart required.");
            }

            var body = ReadRawMethodBody(currentPe, method.RelativeVirtualAddress);
            PatchMethodBodyTokens(
                body,
                currentReader,
                metadata,
                nextSignatures,
                nextUserStrings,
                newStandaloneSignatures,
                ref nextStandaloneSignatureCount);

            ilBuilder.Align(4);
            var bodyOffset = ilBuilder.Count;
            ilBuilder.WriteBytes(body);

            var rowId = MetadataTokens.GetRowNumber(methodHandle);
            var baseline = this.baselineMethods[rowId - 1];
            metadata.AddMethodDefinition(
                baseline.Attributes,
                baseline.ImplAttributes,
                metadata.GetOrAddString(baseline.Name),
                metadata.GetOrAddBlob(baseline.Signature),
                bodyOffset,
                parameterList: default);
            updatedMethodNames.Add(baseline.DisplayName);
        }

        foreach (var signatureHandle in newStandaloneSignatures)
        {
            metadata.AddEncLogEntry(signatureHandle, EditAndContinueOperation.Default);
        }

        foreach (var methodHandle in changedMethods)
        {
            metadata.AddEncLogEntry(methodHandle, EditAndContinueOperation.Default);
        }

        foreach (var methodHandle in changedMethods)
        {
            metadata.AddEncMapEntry(methodHandle);
        }

        foreach (var signatureHandle in newStandaloneSignatures)
        {
            metadata.AddEncMapEntry(signatureHandle);
        }

        var metadataBuilder = new BlobBuilder();
        var rootBuilder = new MetadataRootBuilder(metadata, this.metadataVersion, suppressValidation: true);
        rootBuilder.Serialize(metadataBuilder, methodBodyStreamRva: 0, mappedFieldDataStreamRva: 0);

        var nextUserStringHeapOffset =
            this.userStringHeapOffset + rootBuilder.Sizes.GetAlignedHeapSize(HeapIndex.UserString);
        var nextStringHeapOffset =
            this.stringHeapOffset + rootBuilder.Sizes.HeapSizes[(int)HeapIndex.String];
        var nextBlobHeapOffset =
            this.blobHeapOffset + rootBuilder.Sizes.GetAlignedHeapSize(HeapIndex.Blob);
        var nextGuidHeapOffset = rootBuilder.Sizes.HeapSizes[(int)HeapIndex.Guid];

        return HotReloadDelta.Ready(
            metadataBuilder.ToArray(),
            ilBuilder.ToArray(),
            updatedMethodNames.MoveToImmutable(),
            commit: () =>
            {
                this.previousImage = currentImage;
                this.standaloneSignatures = nextSignatures;
                this.userStrings = nextUserStrings;
                this.standaloneSignatureCount = nextStandaloneSignatureCount;
                this.userStringHeapOffset = nextUserStringHeapOffset;
                this.stringHeapOffset = nextStringHeapOffset;
                this.blobHeapOffset = nextBlobHeapOffset;
                this.guidHeapOffset = nextGuidHeapOffset;
                this.generation++;
                this.previousEncId = encId;
            });
    }

    private static MetadataReader GetMetadataReader(PEReader peReader)
    {
        if (!peReader.HasMetadata)
        {
            throw new BadImageFormatException("G# hot reload requires a managed assembly with ECMA-335 metadata.");
        }

        return peReader.GetMetadataReader();
    }

    private static ImmutableArray<BaselineMethod> ReadBaselineMethods(MetadataReader reader)
    {
        var methods = ImmutableArray.CreateBuilder<BaselineMethod>(reader.MethodDefinitions.Count);
        foreach (var methodHandle in reader.MethodDefinitions)
        {
            var method = reader.GetMethodDefinition(methodHandle);
            methods.Add(new BaselineMethod(
                method.Attributes,
                method.ImplAttributes,
                reader.GetString(method.Name),
                reader.GetBlobBytes(method.Signature),
                GetMethodDisplayName(reader, methodHandle)));
        }

        return methods.MoveToImmutable();
    }

    private static Dictionary<string, int> ReadStandaloneSignatures(MetadataReader reader)
    {
        var result = new Dictionary<string, int>(StringComparer.Ordinal);
        var count = reader.GetTableRowCount(TableIndex.StandAloneSig);
        for (var row = 1; row <= count; row++)
        {
            var handle = MetadataTokens.StandaloneSignatureHandle(row);
            var signature = reader.GetStandaloneSignature(handle);
            result.TryAdd(ToKey(reader.GetBlobBytes(signature.Signature)), MetadataTokens.GetToken(handle));
        }

        return result;
    }

    private static Dictionary<string, int> ReadReferencedUserStrings(PEReader peReader, MetadataReader reader)
    {
        var result = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var methodHandle in reader.MethodDefinitions)
        {
            var method = reader.GetMethodDefinition(methodHandle);
            if (method.RelativeVirtualAddress == 0)
            {
                continue;
            }

            var body = peReader.GetMethodBody(method.RelativeVirtualAddress);
            VisitTokenOperands(body.GetILContent(), (operandType, token) =>
            {
                if (operandType != OperandType.InlineString)
                {
                    return;
                }

                var handle = MetadataTokens.UserStringHandle(token & 0x00ffffff);
                result.TryAdd(reader.GetUserString(handle), token);
            });
        }

        return result;
    }

    private static string? DetectSuspensionChange(MetadataReader previous, MetadataReader current)
    {
        // A method that starts (or stops) suspending also gains (or loses) a
        // state-machine type with its own MoveNext/SetStateMachine rows, so the
        // MethodDef tables do not line up by row; match the user's methods by
        // declaring type + name + parameter count instead and ignore the
        // synthesized state machines themselves.
        var currentByKey = new Dictionary<string, MethodDefinitionHandle>(StringComparer.Ordinal);
        foreach (var handle in current.MethodDefinitions)
        {
            if (TryGetUserMethodKey(current, handle, out var key))
            {
                currentByKey.TryAdd(key, handle);
            }
        }

        foreach (var handle in previous.MethodDefinitions)
        {
            if (!TryGetUserMethodKey(previous, handle, out var key) || !currentByKey.TryGetValue(key, out var currentHandle))
            {
                continue;
            }

            var wasSuspending = IsSuspending(previous, handle);
            var isSuspending = IsSuspending(current, currentHandle);
            if (wasSuspending == isSuspending)
            {
                continue;
            }

            var name = GetMethodDisplayName(current, currentHandle);
            var direction = isSuspending
                ? "now performs a channel operation or calls a suspending function, so it compiles to a 'ValueTask' state machine instead of a plain method"
                : "no longer performs a channel operation or calls a suspending function, so it compiles to a plain method instead of a 'ValueTask' state machine";
            return $"GSHR1002: method '{name}' changed suspension: it {direction} (ADR-0174). Restart required.";
        }

        return null;
    }

    private static bool TryGetUserMethodKey(MetadataReader reader, MethodDefinitionHandle handle, out string key)
    {
        key = string.Empty;
        var method = reader.GetMethodDefinition(handle);
        var type = reader.GetTypeDefinition(method.GetDeclaringType());
        var typeName = reader.GetString(type.Name);
        if (typeName.StartsWith("<", StringComparison.Ordinal) && typeName.Contains(">d__", StringComparison.Ordinal))
        {
            return false; // a synthesized state machine
        }

        key = GetMethodDisplayName(reader, handle) + "/" + method.GetParameters().Count.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return true;
    }

    // The compiler stamps [Gsharp.Concurrency.Suspending] on every suspending
    // kickoff (declared or inferred); its presence is the suspension bit.
    private static bool IsSuspending(MetadataReader reader, MethodDefinitionHandle methodHandle)
    {
        var method = reader.GetMethodDefinition(methodHandle);
        foreach (var attributeHandle in method.GetCustomAttributes())
        {
            var attribute = reader.GetCustomAttribute(attributeHandle);
            string? typeName = null;
            string? typeNamespace = null;
            switch (attribute.Constructor.Kind)
            {
                case HandleKind.MemberReference:
                    var memberRef = reader.GetMemberReference((MemberReferenceHandle)attribute.Constructor);
                    if (memberRef.Parent.Kind == HandleKind.TypeReference)
                    {
                        var typeRef = reader.GetTypeReference((TypeReferenceHandle)memberRef.Parent);
                        typeName = reader.GetString(typeRef.Name);
                        typeNamespace = reader.GetString(typeRef.Namespace);
                    }

                    break;
                case HandleKind.MethodDefinition:
                    var ctor = reader.GetMethodDefinition((MethodDefinitionHandle)attribute.Constructor);
                    var typeDef = reader.GetTypeDefinition(ctor.GetDeclaringType());
                    typeName = reader.GetString(typeDef.Name);
                    typeNamespace = reader.GetString(typeDef.Namespace);
                    break;
            }

            if (typeName == "SuspendingAttribute" && typeNamespace == "Gsharp.Concurrency")
            {
                return true;
            }
        }

        return false;
    }

    private static string? ValidateMetadataShape(MetadataReader previous, MetadataReader current)
    {
        var strictlyStableTables = new[]
        {
            TableIndex.TypeRef,
            TableIndex.TypeDef,
            TableIndex.Field,
            TableIndex.MethodDef,
            TableIndex.Param,
            TableIndex.InterfaceImpl,
            TableIndex.MemberRef,
            TableIndex.Constant,
            TableIndex.CustomAttribute,
            TableIndex.DeclSecurity,
            TableIndex.ClassLayout,
            TableIndex.FieldLayout,
            TableIndex.EventMap,
            TableIndex.Event,
            TableIndex.PropertyMap,
            TableIndex.Property,
            TableIndex.MethodSemantics,
            TableIndex.MethodImpl,
            TableIndex.ModuleRef,
            TableIndex.TypeSpec,
            TableIndex.ImplMap,
            TableIndex.FieldRva,
            TableIndex.Assembly,
            TableIndex.AssemblyRef,
            TableIndex.File,
            TableIndex.ExportedType,
            TableIndex.ManifestResource,
            TableIndex.NestedClass,
            TableIndex.GenericParam,
            TableIndex.MethodSpec,
            TableIndex.GenericParamConstraint,
        };

        foreach (var table in strictlyStableTables)
        {
            var previousCount = previous.GetTableRowCount(table);
            var currentCount = current.GetTableRowCount(table);
            if (previousCount != currentCount)
            {
                return $"GSHR1001: metadata shape changed ({table} rows {previousCount} -> {currentCount}). Adding or removing types, methods, fields, properties, events, or metadata references requires restart.";
            }
        }

        string? Changed(bool equivalent, string table) =>
            equivalent ? null : RestartRequired(table + " metadata changed");

        return Changed(EquivalentModule(previous, current), "module") ??
            Changed(EquivalentAssembly(previous, current), "assembly") ??
            Changed(EquivalentTypeReferences(previous, current), "TypeRef") ??
            Changed(EquivalentTypeDefinitions(previous, current), "TypeDef") ??
            Changed(EquivalentFields(previous, current), "Field") ??
            Changed(EquivalentMethods(previous, current), "MethodDef") ??
            Changed(EquivalentParameters(previous, current), "Param") ??
            Changed(EquivalentInterfaceImplementations(previous, current), "InterfaceImpl") ??
            Changed(EquivalentMemberReferences(previous, current), "MemberRef") ??
            Changed(EquivalentConstants(previous, current), "Constant") ??
            Changed(EquivalentCustomAttributes(previous, current), "CustomAttribute") ??
            Changed(EquivalentDeclarativeSecurity(previous, current), "DeclSecurity") ??
            Changed(EquivalentEvents(previous, current), "Event") ??
            Changed(EquivalentProperties(previous, current), "Property") ??
            Changed(EquivalentMethodImplementations(previous, current), "MethodImpl") ??
            Changed(EquivalentModuleReferences(previous, current), "ModuleRef") ??
            Changed(EquivalentTypeSpecifications(previous, current), "TypeSpec") ??
            Changed(EquivalentAssemblyReferences(previous, current), "AssemblyRef") ??
            Changed(EquivalentAssemblyFiles(previous, current), "File") ??
            Changed(EquivalentExportedTypes(previous, current), "ExportedType") ??
            Changed(EquivalentManifestResources(previous, current), "ManifestResource") ??
            Changed(EquivalentGenericParameters(previous, current), "GenericParam") ??
            Changed(EquivalentMethodSpecifications(previous, current), "MethodSpec") ??
            Changed(EquivalentGenericConstraints(previous, current), "GenericParamConstraint");
    }

    private static string RestartRequired(string reason) =>
        $"GSHR1001: {reason}. Restart required; in-place updates currently support existing managed method bodies only.";

    private static bool EquivalentModule(MetadataReader left, MetadataReader right)
    {
        var a = left.GetModuleDefinition();
        var b = right.GetModuleDefinition();
        return a.Generation == b.Generation &&
            EqualString(left, a.Name, right, b.Name);
    }

    private static bool EquivalentAssembly(MetadataReader left, MetadataReader right)
    {
        if (left.IsAssembly != right.IsAssembly)
        {
            return false;
        }

        if (!left.IsAssembly)
        {
            return true;
        }

        var a = left.GetAssemblyDefinition();
        var b = right.GetAssemblyDefinition();
        return a.HashAlgorithm == b.HashAlgorithm &&
            a.Version == b.Version &&
            a.Flags == b.Flags &&
            EqualString(left, a.Name, right, b.Name) &&
            EqualString(left, a.Culture, right, b.Culture) &&
            EqualBlob(left, a.PublicKey, right, b.PublicKey);
    }

    private static bool EquivalentTypeReferences(MetadataReader left, MetadataReader right)
    {
        foreach (var handle in left.TypeReferences)
        {
            var a = left.GetTypeReference(handle);
            var b = right.GetTypeReference(handle);
            if (MetadataTokens.GetToken(a.ResolutionScope) != MetadataTokens.GetToken(b.ResolutionScope) ||
                !EqualString(left, a.Name, right, b.Name) ||
                !EqualString(left, a.Namespace, right, b.Namespace))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentTypeDefinitions(MetadataReader left, MetadataReader right)
    {
        foreach (var handle in left.TypeDefinitions)
        {
            var a = left.GetTypeDefinition(handle);
            var b = right.GetTypeDefinition(handle);
            if (a.Attributes != b.Attributes ||
                MetadataTokens.GetToken(a.BaseType) != MetadataTokens.GetToken(b.BaseType) ||
                !EqualString(left, a.Name, right, b.Name) ||
                !EqualString(left, a.Namespace, right, b.Namespace) ||
                !EqualHandles(a.GetFields(), b.GetFields()) ||
                !EqualHandles(a.GetMethods(), b.GetMethods()) ||
                !EqualHandles(a.GetProperties(), b.GetProperties()) ||
                !EqualHandles(a.GetEvents(), b.GetEvents()) ||
                !EqualHandles(a.GetInterfaceImplementations(), b.GetInterfaceImplementations()) ||
                !EqualHandles(a.GetMethodImplementations(), b.GetMethodImplementations()) ||
                !EqualHandles(a.GetGenericParameters(), b.GetGenericParameters()) ||
                MetadataTokens.GetToken(a.GetDeclaringType()) != MetadataTokens.GetToken(b.GetDeclaringType()) ||
                !EquivalentLayout(a.GetLayout(), b.GetLayout()))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentFields(MetadataReader left, MetadataReader right)
    {
        var count = left.GetTableRowCount(TableIndex.Field);
        for (var row = 1; row <= count; row++)
        {
            var handle = MetadataTokens.FieldDefinitionHandle(row);
            var a = left.GetFieldDefinition(handle);
            var b = right.GetFieldDefinition(handle);
            if (a.Attributes != b.Attributes ||
                !EqualString(left, a.Name, right, b.Name) ||
                !EqualBlob(left, a.Signature, right, b.Signature) ||
                MetadataTokens.GetToken(a.GetDefaultValue()) != MetadataTokens.GetToken(b.GetDefaultValue()) ||
                a.GetOffset() != b.GetOffset() ||
                !EqualBlob(left, a.GetMarshallingDescriptor(), right, b.GetMarshallingDescriptor()))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentMethods(MetadataReader left, MetadataReader right)
    {
        foreach (var handle in left.MethodDefinitions)
        {
            var a = left.GetMethodDefinition(handle);
            var b = right.GetMethodDefinition(handle);
            if (a.Attributes != b.Attributes ||
                a.ImplAttributes != b.ImplAttributes ||
                !EqualString(left, a.Name, right, b.Name) ||
                !EqualBlob(left, a.Signature, right, b.Signature) ||
                !EqualHandles(a.GetParameters(), b.GetParameters()) ||
                !EqualHandles(a.GetGenericParameters(), b.GetGenericParameters()) ||
                !EquivalentImport(left, a.GetImport(), right, b.GetImport()))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentParameters(MetadataReader left, MetadataReader right)
    {
        var count = left.GetTableRowCount(TableIndex.Param);
        for (var row = 1; row <= count; row++)
        {
            var handle = MetadataTokens.ParameterHandle(row);
            var a = left.GetParameter(handle);
            var b = right.GetParameter(handle);
            if (a.Attributes != b.Attributes ||
                a.SequenceNumber != b.SequenceNumber ||
                !EqualString(left, a.Name, right, b.Name) ||
                MetadataTokens.GetToken(a.GetDefaultValue()) != MetadataTokens.GetToken(b.GetDefaultValue()) ||
                !EqualBlob(left, a.GetMarshallingDescriptor(), right, b.GetMarshallingDescriptor()))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentInterfaceImplementations(MetadataReader left, MetadataReader right)
    {
        var count = left.GetTableRowCount(TableIndex.InterfaceImpl);
        for (var row = 1; row <= count; row++)
        {
            var handle = MetadataTokens.InterfaceImplementationHandle(row);
            if (MetadataTokens.GetToken(left.GetInterfaceImplementation(handle).Interface) !=
                MetadataTokens.GetToken(right.GetInterfaceImplementation(handle).Interface))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentMemberReferences(MetadataReader left, MetadataReader right)
    {
        foreach (var handle in left.MemberReferences)
        {
            var a = left.GetMemberReference(handle);
            var b = right.GetMemberReference(handle);
            if (MetadataTokens.GetToken(a.Parent) != MetadataTokens.GetToken(b.Parent) ||
                !EqualString(left, a.Name, right, b.Name) ||
                !EqualBlob(left, a.Signature, right, b.Signature))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentConstants(MetadataReader left, MetadataReader right)
    {
        var count = left.GetTableRowCount(TableIndex.Constant);
        for (var row = 1; row <= count; row++)
        {
            var handle = MetadataTokens.ConstantHandle(row);
            var a = left.GetConstant(handle);
            var b = right.GetConstant(handle);
            if (a.TypeCode != b.TypeCode ||
                MetadataTokens.GetToken(a.Parent) != MetadataTokens.GetToken(b.Parent) ||
                !EqualBlob(left, a.Value, right, b.Value))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentCustomAttributes(MetadataReader left, MetadataReader right)
    {
        foreach (var handle in left.CustomAttributes)
        {
            var a = left.GetCustomAttribute(handle);
            var b = right.GetCustomAttribute(handle);
            if (MetadataTokens.GetToken(a.Parent) != MetadataTokens.GetToken(b.Parent) ||
                MetadataTokens.GetToken(a.Constructor) != MetadataTokens.GetToken(b.Constructor) ||
                !EqualBlob(left, a.Value, right, b.Value))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentDeclarativeSecurity(MetadataReader left, MetadataReader right)
    {
        var count = left.GetTableRowCount(TableIndex.DeclSecurity);
        for (var row = 1; row <= count; row++)
        {
            var handle = MetadataTokens.DeclarativeSecurityAttributeHandle(row);
            var a = left.GetDeclarativeSecurityAttribute(handle);
            var b = right.GetDeclarativeSecurityAttribute(handle);
            if (a.Action != b.Action ||
                MetadataTokens.GetToken(a.Parent) != MetadataTokens.GetToken(b.Parent) ||
                !EqualBlob(left, a.PermissionSet, right, b.PermissionSet))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentEvents(MetadataReader left, MetadataReader right)
    {
        var count = left.GetTableRowCount(TableIndex.Event);
        for (var row = 1; row <= count; row++)
        {
            var handle = MetadataTokens.EventDefinitionHandle(row);
            var a = left.GetEventDefinition(handle);
            var b = right.GetEventDefinition(handle);
            if (a.Attributes != b.Attributes ||
                MetadataTokens.GetToken(a.Type) != MetadataTokens.GetToken(b.Type) ||
                !EqualString(left, a.Name, right, b.Name) ||
                !EquivalentEventAccessors(a.GetAccessors(), b.GetAccessors()))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentProperties(MetadataReader left, MetadataReader right)
    {
        var count = left.GetTableRowCount(TableIndex.Property);
        for (var row = 1; row <= count; row++)
        {
            var handle = MetadataTokens.PropertyDefinitionHandle(row);
            var a = left.GetPropertyDefinition(handle);
            var b = right.GetPropertyDefinition(handle);
            if (a.Attributes != b.Attributes ||
                !EqualString(left, a.Name, right, b.Name) ||
                !EqualBlob(left, a.Signature, right, b.Signature) ||
                MetadataTokens.GetToken(a.GetDefaultValue()) != MetadataTokens.GetToken(b.GetDefaultValue()) ||
                !EquivalentPropertyAccessors(a.GetAccessors(), b.GetAccessors()))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentMethodImplementations(MetadataReader left, MetadataReader right)
    {
        var count = left.GetTableRowCount(TableIndex.MethodImpl);
        for (var row = 1; row <= count; row++)
        {
            var handle = MetadataTokens.MethodImplementationHandle(row);
            var a = left.GetMethodImplementation(handle);
            var b = right.GetMethodImplementation(handle);
            if (MetadataTokens.GetToken(a.Type) != MetadataTokens.GetToken(b.Type) ||
                MetadataTokens.GetToken(a.MethodBody) != MetadataTokens.GetToken(b.MethodBody) ||
                MetadataTokens.GetToken(a.MethodDeclaration) != MetadataTokens.GetToken(b.MethodDeclaration))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentModuleReferences(MetadataReader left, MetadataReader right)
    {
        var count = left.GetTableRowCount(TableIndex.ModuleRef);
        for (var row = 1; row <= count; row++)
        {
            var handle = MetadataTokens.ModuleReferenceHandle(row);
            if (!EqualString(left, left.GetModuleReference(handle).Name, right, right.GetModuleReference(handle).Name))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentTypeSpecifications(MetadataReader left, MetadataReader right)
    {
        var count = left.GetTableRowCount(TableIndex.TypeSpec);
        for (var row = 1; row <= count; row++)
        {
            var handle = MetadataTokens.TypeSpecificationHandle(row);
            if (!EqualBlob(
                left,
                left.GetTypeSpecification(handle).Signature,
                right,
                right.GetTypeSpecification(handle).Signature))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentAssemblyReferences(MetadataReader left, MetadataReader right)
    {
        foreach (var handle in left.AssemblyReferences)
        {
            var a = left.GetAssemblyReference(handle);
            var b = right.GetAssemblyReference(handle);
            if (a.Version != b.Version ||
                a.Flags != b.Flags ||
                !EqualString(left, a.Name, right, b.Name) ||
                !EqualString(left, a.Culture, right, b.Culture) ||
                !EqualBlob(left, a.PublicKeyOrToken, right, b.PublicKeyOrToken) ||
                !EqualBlob(left, a.HashValue, right, b.HashValue))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentAssemblyFiles(MetadataReader left, MetadataReader right)
    {
        var count = left.GetTableRowCount(TableIndex.File);
        for (var row = 1; row <= count; row++)
        {
            var handle = MetadataTokens.AssemblyFileHandle(row);
            var a = left.GetAssemblyFile(handle);
            var b = right.GetAssemblyFile(handle);
            if (a.ContainsMetadata != b.ContainsMetadata ||
                !EqualString(left, a.Name, right, b.Name) ||
                !EqualBlob(left, a.HashValue, right, b.HashValue))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentExportedTypes(MetadataReader left, MetadataReader right)
    {
        var count = left.GetTableRowCount(TableIndex.ExportedType);
        for (var row = 1; row <= count; row++)
        {
            var handle = MetadataTokens.ExportedTypeHandle(row);
            var a = left.GetExportedType(handle);
            var b = right.GetExportedType(handle);
            if (a.Attributes != b.Attributes ||
                MetadataTokens.GetToken(a.Implementation) != MetadataTokens.GetToken(b.Implementation) ||
                !EqualString(left, a.Name, right, b.Name) ||
                !EqualString(left, a.Namespace, right, b.Namespace))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentManifestResources(MetadataReader left, MetadataReader right)
    {
        var count = left.GetTableRowCount(TableIndex.ManifestResource);
        for (var row = 1; row <= count; row++)
        {
            var handle = MetadataTokens.ManifestResourceHandle(row);
            var a = left.GetManifestResource(handle);
            var b = right.GetManifestResource(handle);
            if (a.Attributes != b.Attributes ||
                a.Offset != b.Offset ||
                MetadataTokens.GetToken(a.Implementation) != MetadataTokens.GetToken(b.Implementation) ||
                !EqualString(left, a.Name, right, b.Name))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentGenericParameters(MetadataReader left, MetadataReader right)
    {
        var count = left.GetTableRowCount(TableIndex.GenericParam);
        for (var row = 1; row <= count; row++)
        {
            var handle = MetadataTokens.GenericParameterHandle(row);
            var a = left.GetGenericParameter(handle);
            var b = right.GetGenericParameter(handle);
            if (a.Attributes != b.Attributes ||
                a.Index != b.Index ||
                MetadataTokens.GetToken(a.Parent) != MetadataTokens.GetToken(b.Parent) ||
                !EqualString(left, a.Name, right, b.Name) ||
                !EqualHandles(a.GetConstraints(), b.GetConstraints()))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentMethodSpecifications(MetadataReader left, MetadataReader right)
    {
        var count = left.GetTableRowCount(TableIndex.MethodSpec);
        for (var row = 1; row <= count; row++)
        {
            var handle = MetadataTokens.MethodSpecificationHandle(row);
            var a = left.GetMethodSpecification(handle);
            var b = right.GetMethodSpecification(handle);
            if (MetadataTokens.GetToken(a.Method) != MetadataTokens.GetToken(b.Method) ||
                !EqualBlob(left, a.Signature, right, b.Signature))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentGenericConstraints(MetadataReader left, MetadataReader right)
    {
        var count = left.GetTableRowCount(TableIndex.GenericParamConstraint);
        for (var row = 1; row <= count; row++)
        {
            var handle = MetadataTokens.GenericParameterConstraintHandle(row);
            var a = left.GetGenericParameterConstraint(handle);
            var b = right.GetGenericParameterConstraint(handle);
            if (MetadataTokens.GetToken(a.Parameter) != MetadataTokens.GetToken(b.Parameter) ||
                MetadataTokens.GetToken(a.Type) != MetadataTokens.GetToken(b.Type))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EquivalentImport(
        MetadataReader leftReader,
        MethodImport left,
        MetadataReader rightReader,
        MethodImport right) =>
        left.Attributes == right.Attributes &&
        MetadataTokens.GetToken(left.Module) == MetadataTokens.GetToken(right.Module) &&
        EqualString(leftReader, left.Name, rightReader, right.Name);

    private static bool EquivalentLayout(TypeLayout left, TypeLayout right) =>
        left.IsDefault == right.IsDefault &&
        left.PackingSize == right.PackingSize &&
        left.Size == right.Size;

    private static bool EquivalentEventAccessors(EventAccessors left, EventAccessors right) =>
        left.Adder.Equals(right.Adder) &&
        left.Remover.Equals(right.Remover) &&
        left.Raiser.Equals(right.Raiser) &&
        left.Others.SequenceEqual(right.Others);

    private static bool EquivalentPropertyAccessors(PropertyAccessors left, PropertyAccessors right) =>
        left.Getter.Equals(right.Getter) &&
        left.Setter.Equals(right.Setter) &&
        left.Others.SequenceEqual(right.Others);

    private static bool MethodBodiesEquivalent(
        PEReader previousPe,
        MetadataReader previousReader,
        MethodDefinition previousMethod,
        PEReader currentPe,
        MetadataReader currentReader,
        MethodDefinition currentMethod)
    {
        if (previousMethod.RelativeVirtualAddress == 0 || currentMethod.RelativeVirtualAddress == 0)
        {
            return previousMethod.RelativeVirtualAddress == currentMethod.RelativeVirtualAddress;
        }

        var previousBody = previousPe.GetMethodBody(previousMethod.RelativeVirtualAddress);
        var currentBody = currentPe.GetMethodBody(currentMethod.RelativeVirtualAddress);
        var previousBytes = ReadRawMethodBody(previousPe, previousMethod.RelativeVirtualAddress);
        var currentBytes = ReadRawMethodBody(currentPe, currentMethod.RelativeVirtualAddress);
        if (!previousBytes.AsSpan().SequenceEqual(currentBytes))
        {
            return false;
        }

        if (!EqualStandaloneSignature(
            previousReader,
            previousBody.LocalSignature,
            currentReader,
            currentBody.LocalSignature))
        {
            return false;
        }

        var previousTokens = ReadSemanticTokens(previousBody.GetILContent(), previousReader);
        var currentTokens = ReadSemanticTokens(currentBody.GetILContent(), currentReader);
        return previousTokens.SequenceEqual(currentTokens);
    }

    private static ImmutableArray<string> ReadSemanticTokens(ImmutableArray<byte> il, MetadataReader reader)
    {
        var result = ImmutableArray.CreateBuilder<string>();
        VisitTokenOperands(il, (operandType, token) =>
        {
            switch (operandType)
            {
                case OperandType.InlineString:
                    result.Add("s:" + reader.GetUserString(MetadataTokens.UserStringHandle(token & 0x00ffffff)));
                    break;
                case OperandType.InlineSig:
                    var signature = reader.GetStandaloneSignature(MetadataTokens.StandaloneSignatureHandle(token & 0x00ffffff));
                    result.Add("g:" + ToKey(reader.GetBlobBytes(signature.Signature)));
                    break;
            }
        });

        return result.ToImmutable();
    }

    private static byte[] ReadRawMethodBody(PEReader peReader, int relativeVirtualAddress)
    {
        var body = peReader.GetMethodBody(relativeVirtualAddress);
        return peReader.GetSectionData(relativeVirtualAddress).GetContent(0, body.Size).ToArray();
    }

    private static void PatchMethodBodyTokens(
        byte[] body,
        MetadataReader reader,
        MetadataBuilder metadata,
        Dictionary<string, int> signatures,
        Dictionary<string, int> userStrings,
        List<EntityHandle> newStandaloneSignatures,
        ref int standaloneSignatureCount)
    {
        var nextStandaloneSignatureCount = standaloneSignatureCount;
        var headerSize = GetMethodHeaderSize(body);
        if (headerSize > 1)
        {
            var localSignatureToken = BinaryPrimitives.ReadInt32LittleEndian(body.AsSpan(8, 4));
            if (localSignatureToken != 0)
            {
                var mapped = MapStandaloneSignature(
                    localSignatureToken,
                    reader,
                    metadata,
                    signatures,
                    newStandaloneSignatures,
                    ref nextStandaloneSignatureCount);
                BinaryPrimitives.WriteInt32LittleEndian(body.AsSpan(8, 4), mapped);
            }
        }

        var ilSize = GetMethodCodeSize(body, headerSize);
        VisitTokenOperands(body.AsSpan(headerSize, ilSize), (operandType, token, operandOffset) =>
        {
            switch (operandType)
            {
                case OperandType.InlineString:
                    var value = reader.GetUserString(MetadataTokens.UserStringHandle(token & 0x00ffffff));
                    if (!userStrings.TryGetValue(value, out var mappedString))
                    {
                        mappedString = MetadataTokens.GetToken(metadata.GetOrAddUserString(value));
                        userStrings.Add(value, mappedString);
                    }

                    BinaryPrimitives.WriteInt32LittleEndian(
                        body.AsSpan(headerSize + operandOffset, 4),
                        mappedString);
                    break;
                case OperandType.InlineSig:
                    var mappedSignature = MapStandaloneSignature(
                        token,
                        reader,
                        metadata,
                        signatures,
                        newStandaloneSignatures,
                        ref nextStandaloneSignatureCount);
                    BinaryPrimitives.WriteInt32LittleEndian(
                        body.AsSpan(headerSize + operandOffset, 4),
                        mappedSignature);
                    break;
            }
        });
        standaloneSignatureCount = nextStandaloneSignatureCount;
    }

    private static int MapStandaloneSignature(
        int token,
        MetadataReader reader,
        MetadataBuilder metadata,
        Dictionary<string, int> signatures,
        List<EntityHandle> newStandaloneSignatures,
        ref int standaloneSignatureCount)
    {
        var signature = reader.GetStandaloneSignature(
            MetadataTokens.StandaloneSignatureHandle(token & 0x00ffffff));
        var signatureBytes = reader.GetBlobBytes(signature.Signature);
        var key = ToKey(signatureBytes);
        if (signatures.TryGetValue(key, out var mapped))
        {
            return mapped;
        }

        metadata.AddStandaloneSignature(metadata.GetOrAddBlob(signatureBytes));
        var handle = MetadataTokens.StandaloneSignatureHandle(++standaloneSignatureCount);
        mapped = MetadataTokens.GetToken(handle);
        signatures.Add(key, mapped);
        newStandaloneSignatures.Add(handle);
        return mapped;
    }

    private static int GetMethodHeaderSize(byte[] body)
    {
        var format = body[0] & 0x3;
        if (format == 0x2)
        {
            return 1;
        }

        if (format != 0x3 || body.Length < 12)
        {
            throw new BadImageFormatException("Invalid managed method header in hot-reload output.");
        }

        var flagsAndSize = BinaryPrimitives.ReadUInt16LittleEndian(body.AsSpan(0, 2));
        return ((flagsAndSize >> 12) & 0xf) * 4;
    }

    private static int GetMethodCodeSize(byte[] body, int headerSize) =>
        headerSize == 1
            ? body[0] >> 2
            : BinaryPrimitives.ReadInt32LittleEndian(body.AsSpan(4, 4));

    private static void VisitTokenOperands(ImmutableArray<byte> il, Action<OperandType, int> visitor)
    {
        VisitTokenOperands(il.AsSpan(), (operandType, token, _) => visitor(operandType, token));
    }

    private static void VisitTokenOperands(ReadOnlySpan<byte> il, Action<OperandType, int, int> visitor)
    {
        var offset = 0;
        while (offset < il.Length)
        {
            ushort value = il[offset++];
            if (value == 0xfe)
            {
                if (offset >= il.Length)
                {
                    throw new BadImageFormatException("Truncated two-byte IL opcode.");
                }

                value = (ushort)(0xfe00 | il[offset++]);
            }

            if (!OperandTypes.TryGetValue(value, out var operandType))
            {
                throw new BadImageFormatException($"Unknown IL opcode 0x{value:x4}.");
            }

            var operandOffset = offset;
            var operandSize = GetOperandSize(operandType, il, operandOffset);
            if (operandOffset + operandSize > il.Length)
            {
                throw new BadImageFormatException("Truncated IL operand.");
            }

            if (operandType is OperandType.InlineString or OperandType.InlineSig)
            {
                visitor(
                    operandType,
                    BinaryPrimitives.ReadInt32LittleEndian(il.Slice(operandOffset, 4)),
                    operandOffset);
            }

            offset += operandSize;
        }
    }

    private static int GetOperandSize(OperandType operandType, ReadOnlySpan<byte> il, int offset) =>
        operandType switch
        {
            OperandType.InlineNone => 0,
            OperandType.ShortInlineBrTarget or
            OperandType.ShortInlineI or
            OperandType.ShortInlineVar => 1,
            OperandType.InlineVar => 2,
            OperandType.InlineBrTarget or
            OperandType.InlineField or
            OperandType.InlineI or
            OperandType.InlineMethod or
            OperandType.InlineSig or
            OperandType.InlineString or
            OperandType.InlineTok or
            OperandType.InlineType or
            OperandType.ShortInlineR => 4,
            OperandType.InlineI8 or
            OperandType.InlineR => 8,
            OperandType.InlineSwitch => GetSwitchOperandSize(il, offset),
            _ => throw new BadImageFormatException($"Unsupported IL operand type '{operandType}'."),
        };

    private static int GetSwitchOperandSize(ReadOnlySpan<byte> il, int offset)
    {
        if (offset + 4 > il.Length)
        {
            throw new BadImageFormatException("Truncated switch operand.");
        }

        var count = BinaryPrimitives.ReadInt32LittleEndian(il.Slice(offset, 4));
        if (count < 0)
        {
            throw new BadImageFormatException("Negative switch target count.");
        }

        return checked(4 + (count * 4));
    }

    private static IReadOnlyDictionary<ushort, OperandType> CreateOperandTypeMap()
    {
        var result = new Dictionary<ushort, OperandType>();
        foreach (var field in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static))
        {
            if (field.GetValue(null) is OpCode opcode)
            {
                result[unchecked((ushort)opcode.Value)] = opcode.OperandType;
            }
        }

        return result;
    }

    private static bool EqualString(
        MetadataReader leftReader,
        StringHandle left,
        MetadataReader rightReader,
        StringHandle right) =>
        left.IsNil == right.IsNil &&
        (left.IsNil || string.Equals(leftReader.GetString(left), rightReader.GetString(right), StringComparison.Ordinal));

    private static bool EqualBlob(
        MetadataReader leftReader,
        BlobHandle left,
        MetadataReader rightReader,
        BlobHandle right) =>
        left.IsNil == right.IsNil &&
        (left.IsNil || leftReader.GetBlobBytes(left).AsSpan().SequenceEqual(rightReader.GetBlobBytes(right)));

    private static bool EqualStandaloneSignature(
        MetadataReader leftReader,
        StandaloneSignatureHandle left,
        MetadataReader rightReader,
        StandaloneSignatureHandle right)
    {
        if (left.IsNil || right.IsNil)
        {
            return left.IsNil == right.IsNil;
        }

        return EqualBlob(
            leftReader,
            leftReader.GetStandaloneSignature(left).Signature,
            rightReader,
            rightReader.GetStandaloneSignature(right).Signature);
    }

    private static bool EqualHandles<THandle>(
        IEnumerable<THandle> left,
        IEnumerable<THandle> right)
        where THandle : struct
    {
        using var leftEnumerator = left.GetEnumerator();
        using var rightEnumerator = right.GetEnumerator();
        while (true)
        {
            var hasLeft = leftEnumerator.MoveNext();
            var hasRight = rightEnumerator.MoveNext();
            if (hasLeft != hasRight)
            {
                return false;
            }

            if (!hasLeft)
            {
                return true;
            }

            if (!EqualityComparer<THandle>.Default.Equals(leftEnumerator.Current, rightEnumerator.Current))
            {
                return false;
            }
        }
    }

    private static string GetMethodDisplayName(MetadataReader reader, MethodDefinitionHandle methodHandle)
    {
        var method = reader.GetMethodDefinition(methodHandle);
        var type = reader.GetTypeDefinition(method.GetDeclaringType());
        var typeName = reader.GetString(type.Name);
        var namespaceName = reader.GetString(type.Namespace);
        var methodName = reader.GetString(method.Name);
        return string.IsNullOrEmpty(namespaceName)
            ? $"{typeName}.{methodName}"
            : $"{namespaceName}.{typeName}.{methodName}";
    }

    private static string ToKey(byte[] bytes) => Convert.ToBase64String(bytes);

    private readonly record struct BaselineMethod(
        MethodAttributes Attributes,
        MethodImplAttributes ImplAttributes,
        string Name,
        byte[] Signature,
        string DisplayName);
}

internal sealed class HotReloadDelta
{
    private readonly Action? commit;

    private HotReloadDelta(
        HotReloadDeltaStatus status,
        byte[] metadataDelta,
        byte[] ilDelta,
        byte[] pdbDelta,
        ImmutableArray<string> updatedMethods,
        string? diagnostic,
        Action? commit)
    {
        this.Status = status;
        this.MetadataDelta = metadataDelta;
        this.IlDelta = ilDelta;
        this.PdbDelta = pdbDelta;
        this.UpdatedMethods = updatedMethods;
        this.Diagnostic = diagnostic;
        this.commit = commit;
    }

    public HotReloadDeltaStatus Status { get; }

    public byte[] MetadataDelta { get; }

    public byte[] IlDelta { get; }

    public byte[] PdbDelta { get; }

    public ImmutableArray<string> UpdatedMethods { get; }

    public string? Diagnostic { get; }

    public static HotReloadDelta Ready(
        byte[] metadataDelta,
        byte[] ilDelta,
        ImmutableArray<string> updatedMethods,
        Action commit,
        byte[]? pdbDelta = null) =>
        new(
            HotReloadDeltaStatus.Ready,
            metadataDelta,
            ilDelta,
            pdbDelta ?? Array.Empty<byte>(),
            updatedMethods,
            diagnostic: null,
            commit);

    public static HotReloadDelta NoChanges() =>
        new(
            HotReloadDeltaStatus.NoChanges,
            Array.Empty<byte>(),
            Array.Empty<byte>(),
            Array.Empty<byte>(),
            ImmutableArray<string>.Empty,
            diagnostic: null,
            commit: null);

    public static HotReloadDelta Unsupported(string diagnostic) =>
        new(
            HotReloadDeltaStatus.Unsupported,
            Array.Empty<byte>(),
            Array.Empty<byte>(),
            Array.Empty<byte>(),
            ImmutableArray<string>.Empty,
            diagnostic,
            commit: null);

    public void Commit() => this.commit?.Invoke();
}
