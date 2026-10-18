// <copyright file="HotReloadDeltaBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.HotReload.Runtime

import System
import System.Buffers.Binary
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

internal enum HotReloadDeltaStatus {
    Ready,
    NoChanges,
    Unsupported
}

/// Builds stable-row Edit-and-Continue deltas from two G# PE images.
/// @remarks (cref:MetadataUpdater) applies deltas but does not create them, while
/// Roslyn's EmitDifference pipeline requires a Roslyn compilation and cannot
/// consume G# bound programs. Keep this encoder limited to existing managed
/// method bodies; structural metadata edits return an explicit restart
/// diagnostic instead of synthesizing partial Roslyn behavior.
internal class HotReloadDeltaBuilder {
    private let moduleId Guid
    private let moduleName string
    private let metadataVersion string
    private let baselineMethods ImmutableArray[BaselineMethod]
    private var previousImage[]uint8 = System.Array.Empty[uint8]()
    private var standaloneSignatures Dictionary[string, int32]
    private var userStrings Dictionary[string, int32]
    private var standaloneSignatureCount int32
    private var userStringHeapOffset int32
    private var stringHeapOffset int32
    private var blobHeapOffset int32
    private var guidHeapOffset int32
    private var generation int32
    private var previousEncId Guid

    init(baselineImage[]uint8) {
        ArgumentNullException.ThrowIfNull(baselineImage, paramName: "baselineImage")
        this.previousImage = baselineImage
        using let stream = MemoryStream(baselineImage, writable: false)
        using let peReader = PEReader(stream)
        let reader = GetMetadataReader(peReader)
        let module = reader.GetModuleDefinition()
        this.moduleId = reader.GetGuid(module.Mvid)
        this.moduleName = reader.GetString(module.Name)
        this.metadataVersion = reader.MetadataVersion
        this.userStringHeapOffset = reader.GetHeapSize(HeapIndex.UserString)
        this.stringHeapOffset = reader.GetHeapSize(HeapIndex.String)
        this.blobHeapOffset = reader.GetHeapSize(HeapIndex.Blob)
        this.guidHeapOffset = reader.GetHeapSize(HeapIndex.Guid)
        this.standaloneSignatureCount = reader.GetTableRowCount(TableIndex.StandAloneSig)
        this.standaloneSignatures = ReadStandaloneSignatures(reader)
        this.userStrings = ReadReferencedUserStrings(peReader, reader)
        this.baselineMethods = ReadBaselineMethods(reader)
    }

    func CreateUpdate(currentImage[]uint8) HotReloadDelta {
        ArgumentNullException.ThrowIfNull(currentImage, paramName: "currentImage")
        using let previousStream = MemoryStream(this.previousImage, writable: false)
        using let currentStream = MemoryStream(currentImage, writable: false)
        using let previousPe = PEReader(previousStream)
        using let currentPe = PEReader(currentStream)
        let previousReader = GetMetadataReader(previousPe)
        let currentReader = GetMetadataReader(currentPe)
        // ADR-0174 P3-9: a method whose suspension changed (a channel
        // operation or a call to a suspending function was added to, or
        // removed from, a plain `func`) is compiled to a different shape
        // (`R` <-> `ValueTask[R]`, plus a state machine); that is a signature
        // change even though the source edit looks like a body edit, so it
        // gets its own restart diagnostic before the generic shape check.
        let suspensionChange string? = DetectSuspensionChange(previousReader, currentReader)
        if suspensionChange != nil {
            return HotReloadDelta.Unsupported(suspensionChange)
        }
        let unsupportedReason string? = ValidateMetadataShape(previousReader, currentReader)
        if unsupportedReason != nil {
            return HotReloadDelta.Unsupported(unsupportedReason)
        }
        let changedMethods = List[MethodDefinitionHandle]()
        for methodHandle in currentReader.MethodDefinitions {
            let previousMethod = previousReader.GetMethodDefinition(methodHandle)
            let currentMethod = currentReader.GetMethodDefinition(methodHandle)
            if !MethodBodiesEquivalent(
                previousPe,
                previousReader,
                previousMethod,
                currentPe,
                currentReader,
                currentMethod
            ) {
                changedMethods.Add(methodHandle)
            }
        }
        if changedMethods.Count == 0 {
            return HotReloadDelta.NoChanges()
        }
        let nextSignatures = Dictionary[string, int32](this.standaloneSignatures, StringComparer.Ordinal)
        let nextUserStrings = Dictionary[string, int32](this.userStrings, StringComparer.Ordinal)
        var nextStandaloneSignatureCount = this.standaloneSignatureCount
        let newStandaloneSignatures = List[EntityHandle]()
        let metadata = MetadataBuilder(
            this.userStringHeapOffset,
            this.stringHeapOffset,
            this.blobHeapOffset,
            this.guidHeapOffset
        )
        let encId = Guid.NewGuid()
        metadata.AddModule(
            generation: this.generation + 1,
            moduleName: metadata.GetOrAddString(this.moduleName),
            mvid: metadata.GetOrAddGuid(this.moduleId),
            encId: metadata.GetOrAddGuid(encId),
            encBaseId: metadata.GetOrAddGuid(this.previousEncId)
        )
        let ilBuilder = BlobBuilder()
        ilBuilder.WriteUInt32(0)
        let updatedMethodNames = ImmutableArray.CreateBuilder[string](changedMethods.Count)
        for methodHandle in changedMethods {
            let method = currentReader.GetMethodDefinition(methodHandle)
            if method.RelativeVirtualAddress == 0 {
                return HotReloadDelta.Unsupported(
                    "GSHR1001: method '${GetMethodDisplayName(currentReader, methodHandle)}' changed from managed IL to a body-less method. Restart required."
                )
            }
            let body = ReadRawMethodBody(currentPe, method.RelativeVirtualAddress)
            PatchMethodBodyTokens(
                body,
                currentReader,
                metadata,
                nextSignatures,
                nextUserStrings,
                newStandaloneSignatures,
                &nextStandaloneSignatureCount
            )
            ilBuilder.Align(4)
            let bodyOffset = ilBuilder.Count
            ilBuilder.WriteBytes(body)
            let rowId = MetadataTokens.GetRowNumber(methodHandle)
            let baseline = this.baselineMethods[rowId - 1]
            metadata.AddMethodDefinition(
                baseline.Attributes,
                baseline.ImplAttributes,
                metadata.GetOrAddString(baseline.Name),
                metadata.GetOrAddBlob(baseline.Signature),
                bodyOffset,
                parameterList: default(ParameterHandle)
            )
            updatedMethodNames.Add(baseline.DisplayName)
        }
        for signatureHandle in newStandaloneSignatures {
            metadata.AddEncLogEntry(signatureHandle, EditAndContinueOperation.Default)
        }
        for methodHandle in changedMethods {
            metadata.AddEncLogEntry(methodHandle, EditAndContinueOperation.Default)
        }
        for methodHandle in changedMethods {
            metadata.AddEncMapEntry(methodHandle)
        }
        for signatureHandle in newStandaloneSignatures {
            metadata.AddEncMapEntry(signatureHandle)
        }
        let metadataBuilder = BlobBuilder()
        let rootBuilder = MetadataRootBuilder(metadata, this.metadataVersion, suppressValidation: true)
        rootBuilder.Serialize(metadataBuilder, methodBodyStreamRva: 0, mappedFieldDataStreamRva: 0)
        let nextUserStringHeapOffset = this.userStringHeapOffset + rootBuilder.Sizes.GetAlignedHeapSize(
            HeapIndex.UserString
        )
        let nextStringHeapOffset = this.stringHeapOffset + rootBuilder.Sizes.HeapSizes[int32(HeapIndex.String)]
        let nextBlobHeapOffset = this.blobHeapOffset + rootBuilder.Sizes.GetAlignedHeapSize(HeapIndex.Blob)
        let nextGuidHeapOffset = rootBuilder.Sizes.HeapSizes[int32(HeapIndex.Guid)]
        return HotReloadDelta.Ready(
            metadataBuilder.ToArray(),
            ilBuilder.ToArray(),
            updatedMethodNames.MoveToImmutable(),
            ImmutableArray.Create(GetUpdatedTypes(currentReader, changedMethods)),
            commit: () -> {
                this.previousImage = currentImage
                this.standaloneSignatures = nextSignatures
                this.userStrings = nextUserStrings
                this.standaloneSignatureCount = nextStandaloneSignatureCount
                this.userStringHeapOffset = nextUserStringHeapOffset
                this.stringHeapOffset = nextStringHeapOffset
                this.blobHeapOffset = nextBlobHeapOffset
                this.guidHeapOffset = nextGuidHeapOffset
                this.generation++
                this.previousEncId = encId
            }
        )
    }

    private data struct BaselineMethod(
        Attributes MethodAttributes,
        ImplAttributes MethodImplAttributes,
        Name string,
        Signature[]uint8,
        DisplayName string
    ) : IEquatable[BaselineMethod] { }

    shared {
        private let OperandTypes IReadOnlyDictionary[uint16, OperandType] = CreateOperandTypeMap()

        /// Returns the TypeDef tokens of the types a delta changes, as Roslyn
        /// reports them in `EmitDifferenceResult.ChangedTypes` (the list
        /// `dotnet watch` passes to metadata update handlers): each changed
        /// method's declaring type plus every type that contains it, once
        /// each, in the delta writer's traversal order. That order is the
        /// top-level types in TypeDef order, then nested types breadth-first.
        /// @param reader Metadata of the candidate image.
        /// @param methods Methods whose bodies the delta replaces.
        /// @returns TypeDef tokens in update order, without duplicates.
        private func GetUpdatedTypes(reader MetadataReader, methods List[MethodDefinitionHandle])[]int32 {
            let changedTypes = HashSet[TypeDefinitionHandle]()
            for methodHandle in methods {
                var type = reader.GetMethodDefinition(methodHandle).GetDeclaringType()
                // A type already in the set has had its containers added too.
                while !type.IsNil && changedTypes.Add(type) {
                    type = reader.GetTypeDefinition(type).GetDeclaringType()
                }
            }
            let ordered = List[int32](changedTypes.Count)
            let pending = Queue[TypeDefinitionHandle]()
            for handle in reader.TypeDefinitions {
                if reader.GetTypeDefinition(handle).GetDeclaringType().IsNil {
                    pending.Enqueue(handle)
                }
            }
            while pending.Count > 0 {
                let handle = pending.Dequeue()
                // An unchanged type contains no changed type, so only changed
                // types need their nested types visited.
                if changedTypes.Contains(handle) {
                    ordered.Add(MetadataTokens.GetToken(handle))
                    for nested in reader.GetTypeDefinition(handle).GetNestedTypes() {
                        pending.Enqueue(nested)
                    }
                }
            }
            return ordered.ToArray()
        }

        private func GetMetadataReader(peReader PEReader) MetadataReader {
            if !peReader.HasMetadata {
                throw BadImageFormatException("G# hot reload requires a managed assembly with ECMA-335 metadata.")
            }
            return peReader.GetMetadataReader()
        }

        private func ReadBaselineMethods(reader MetadataReader) ImmutableArray[BaselineMethod] {
            let methods = ImmutableArray.CreateBuilder[BaselineMethod](reader.MethodDefinitions.Count)
            for methodHandle in reader.MethodDefinitions {
                let method = reader.GetMethodDefinition(methodHandle)
                methods.Add(
                    BaselineMethod(
                        method.Attributes,
                        method.ImplAttributes,
                        reader.GetString(method.Name),
                        reader.GetBlobBytes(method.Signature),
                        GetMethodDisplayName(reader, methodHandle)
                    )
                )
            }
            return methods.MoveToImmutable()
        }

        private func ReadStandaloneSignatures(reader MetadataReader) Dictionary[string, int32] {
            let result = Dictionary[string, int32](StringComparer.Ordinal)
            let count = reader.GetTableRowCount(TableIndex.StandAloneSig)
            for var row = 1; row <= count; row++ {
                let handle = MetadataTokens.StandaloneSignatureHandle(row)
                let signature = reader.GetStandaloneSignature(handle)
                result.TryAdd(ToKey(reader.GetBlobBytes(signature.Signature)), MetadataTokens.GetToken(handle))
            }
            return result
        }

        private func ReadReferencedUserStrings(peReader PEReader, reader MetadataReader) Dictionary[string, int32] {
            let result = Dictionary[string, int32](StringComparer.Ordinal)
            for methodHandle in reader.MethodDefinitions {
                let method = reader.GetMethodDefinition(methodHandle)
                if method.RelativeVirtualAddress == 0 {
                    continue
                }
                let body = peReader.GetMethodBody(method.RelativeVirtualAddress)
                VisitTokenOperands(
                    body.GetILContent(),
                    (operandType OperandType, token int32) -> {
                        if operandType != OperandType.InlineString {
                            return
                        }
                        let handle = MetadataTokens.UserStringHandle(token & 0x00ffffff)
                        result.TryAdd(reader.GetUserString(handle), token)
                    }
                )
            }
            return result
        }

        private func DetectSuspensionChange(previous MetadataReader, current MetadataReader) string? {
            // A method that starts (or stops) suspending also gains (or loses) a
            // state-machine type with its own MoveNext/SetStateMachine rows, so the
            // MethodDef tables do not line up by row; match the user's methods by
            // declaring type + name + parameter count instead and ignore the
            // synthesized state machines themselves.
            let currentByKey = Dictionary[string, MethodDefinitionHandle](StringComparer.Ordinal)
            for handle in current.MethodDefinitions {
                if TryGetUserMethodKey(current, handle, out var key) {
                    currentByKey.TryAdd(key, handle)
                }
            }
            for handle in previous.MethodDefinitions {
                if !TryGetUserMethodKey(previous, handle, out var key) || !currentByKey.TryGetValue(
                    key,
                    out var currentHandle
                ) {
                    continue
                }
                let wasSuspending = IsSuspending(previous, handle)
                let isSuspending = IsSuspending(current, currentHandle)
                if wasSuspending == isSuspending {
                    continue
                }
                let name = GetMethodDisplayName(current, currentHandle)
                let direction = if isSuspending {
                    "now performs a channel operation or calls a suspending function, so it compiles to a 'ValueTask' state machine instead of a plain method"
                } else {
                    "no longer performs a channel operation or calls a suspending function, so it compiles to a plain method instead of a 'ValueTask' state machine"
                }
                return "GSHR1002: method '$name' changed suspension: it $direction (ADR-0174). Restart required."
            }
            return nil
        }

        private func TryGetUserMethodKey(reader MetadataReader, handle MethodDefinitionHandle, out key string) bool {
            key = string.Empty
            let method = reader.GetMethodDefinition(handle)
            let type = reader.GetTypeDefinition(method.GetDeclaringType())
            let typeName = reader.GetString(type.Name)
            if typeName.StartsWith("<", StringComparison.Ordinal) && typeName.Contains(
                ">d__",
                StringComparison.Ordinal
            ) {
                return false // a synthesized state machine

            }
            // The count excludes a trailing `Context` (ADR-0174 D7): gaining or
            // losing suspension gains or loses that parameter, and the key has to
            // pair the two versions of the same method across exactly that change.
            //
            // Only real parameters count (sequence > 0). A method's Param rows also
            // include an optional sequence-0 row for its RETURN, which exists
            // whenever the return carries an attribute such as [Nullable]. Whether
            // it exists can change with the suspension flip itself (an `R` return
            // becomes a `ValueTask[R]`), so counting it would unpair the very
            // methods this key exists to pair.
            var parameterCount = 0
            for parameterHandle in method.GetParameters() {
                if reader.GetParameter(parameterHandle).SequenceNumber > 0 {
                    parameterCount++
                }
            }
            if parameterCount > 0 && HasTrailingHiddenContext(reader, method) {
                parameterCount--
            }
            key = GetMethodDisplayName(reader, handle) + "/" + parameterCount.ToString(CultureInfo.InvariantCulture)
            return true
        }

        private func HasTrailingHiddenContext(reader MetadataReader, method MethodDefinition) bool {
            var last = default(Parameter)
            var found = false
            for handle in method.GetParameters() {
                let parameter = reader.GetParameter(handle)
                if !found || parameter.SequenceNumber > last.SequenceNumber {
                    last = parameter
                    found = true
                }
            }
            return found && reader.GetString(last.Name) == "<>ctx"
        }

        // The compiler stamps [Gsharp.Concurrency.Suspending] on every suspending
        // kickoff (declared or inferred); its presence is the suspension bit.
        private func IsSuspending(reader MetadataReader, methodHandle MethodDefinitionHandle) bool {
            let method = reader.GetMethodDefinition(methodHandle)
            for attributeHandle in method.GetCustomAttributes() {
                let attribute = reader.GetCustomAttribute(attributeHandle)
                var typeName string? = nil
                var typeNamespace string? = nil
                switch attribute.Constructor.Kind {
                    case HandleKind.MemberReference {
                        let memberRef = reader.GetMemberReference(MemberReferenceHandle(attribute.Constructor))
                        if memberRef.Parent.Kind == HandleKind.TypeReference {
                            let typeRef = reader.GetTypeReference(TypeReferenceHandle(memberRef.Parent))
                            typeName = reader.GetString(typeRef.Name)
                            typeNamespace = reader.GetString(typeRef.Namespace)
                        }
                    }
                    case HandleKind.MethodDefinition {
                        let ctor = reader.GetMethodDefinition(MethodDefinitionHandle(attribute.Constructor))
                        let typeDef = reader.GetTypeDefinition(ctor.GetDeclaringType())
                        typeName = reader.GetString(typeDef.Name)
                        typeNamespace = reader.GetString(typeDef.Namespace)
                    }
                    default {
                        let _ = 0
                    }
                }
                if typeName == "SuspendingAttribute" && typeNamespace == "Gsharp.Concurrency" {
                    return true
                }
            }
            return false
        }

        private func ValidateMetadataShape(previous MetadataReader, current MetadataReader) string? {
            let strictlyStableTables = []TableIndex{
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
                TableIndex.GenericParamConstraint
            }
            for table in strictlyStableTables {
                let previousCount = previous.GetTableRowCount(table)
                let currentCount = current.GetTableRowCount(table)
                if previousCount != currentCount {
                    return "GSHR1001: metadata shape changed ($table rows $previousCount -> $currentCount). Adding or removing types, methods, fields, properties, events, or metadata references requires restart."
                }
            }
            let Changed = func (equivalent bool, table string) string? {
                return if equivalent {
                    default(string?)
                } else {
                    RestartRequired(table + " metadata changed")
                }
            }
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
                Changed(EquivalentGenericConstraints(previous, current), "GenericParamConstraint")
        }

        private func RestartRequired(
            reason string
        ) string -> "GSHR1001: $reason. Restart required; in-place updates currently support existing managed method bodies only."

        private func EquivalentModule(left MetadataReader, right MetadataReader) bool {
            let a = left.GetModuleDefinition()
            let b = right.GetModuleDefinition()
            return a.Generation == b.Generation && EqualString(left, a.Name, right, b.Name)
        }

        private func EquivalentAssembly(left MetadataReader, right MetadataReader) bool {
            if left.IsAssembly != right.IsAssembly {
                return false
            }
            if !left.IsAssembly {
                return true
            }
            let a = left.GetAssemblyDefinition()
            let b = right.GetAssemblyDefinition()
            return a.HashAlgorithm == b.HashAlgorithm &&
                a.Version == b.Version &&
                a.Flags == b.Flags &&
                EqualString(left, a.Name, right, b.Name) &&
                EqualString(left, a.Culture, right, b.Culture) &&
                EqualBlob(left, a.PublicKey, right, b.PublicKey)
        }

        private func EquivalentTypeReferences(left MetadataReader, right MetadataReader) bool {
            for handle in left.TypeReferences {
                let a = left.GetTypeReference(handle)
                let b = right.GetTypeReference(handle)
                if MetadataTokens.GetToken(a.ResolutionScope) != MetadataTokens.GetToken(b.ResolutionScope) ||
                    !EqualString(left, a.Name, right, b.Name) ||
                    !EqualString(left, a.Namespace, right, b.Namespace) {
                    return false
                }
            }
            return true
        }

        private func EquivalentTypeDefinitions(left MetadataReader, right MetadataReader) bool {
            for handle in left.TypeDefinitions {
                let a = left.GetTypeDefinition(handle)
                let b = right.GetTypeDefinition(handle)
                if a.Attributes != b.Attributes || MetadataTokens.GetToken(a.BaseType) != MetadataTokens.GetToken(
                    b.BaseType
                ) ||
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
                    !EquivalentLayout(a.GetLayout(), b.GetLayout()) {
                    return false
                }
            }
            return true
        }

        private func EquivalentFields(left MetadataReader, right MetadataReader) bool {
            let count = left.GetTableRowCount(TableIndex.Field)
            for var row = 1; row <= count; row++ {
                let handle = MetadataTokens.FieldDefinitionHandle(row)
                let a = left.GetFieldDefinition(handle)
                let b = right.GetFieldDefinition(handle)
                if a.Attributes != b.Attributes ||
                    !EqualString(left, a.Name, right, b.Name) ||
                    !EqualBlob(left, a.Signature, right, b.Signature) ||
                    MetadataTokens.GetToken(a.GetDefaultValue()) != MetadataTokens.GetToken(b.GetDefaultValue()) ||
                    a.GetOffset() != b.GetOffset() ||
                    !EqualBlob(left, a.GetMarshallingDescriptor(), right, b.GetMarshallingDescriptor()) {
                    return false
                }
            }
            return true
        }

        private func EquivalentMethods(left MetadataReader, right MetadataReader) bool {
            for handle in left.MethodDefinitions {
                let a = left.GetMethodDefinition(handle)
                let b = right.GetMethodDefinition(handle)
                if a.Attributes != b.Attributes ||
                    a.ImplAttributes != b.ImplAttributes ||
                    !EqualString(left, a.Name, right, b.Name) ||
                    !EqualBlob(left, a.Signature, right, b.Signature) ||
                    !EqualHandles(a.GetParameters(), b.GetParameters()) ||
                    !EqualHandles(a.GetGenericParameters(), b.GetGenericParameters()) ||
                    !EquivalentImport(left, a.GetImport(), right, b.GetImport()) {
                    return false
                }
            }
            return true
        }

        private func EquivalentParameters(left MetadataReader, right MetadataReader) bool {
            let count = left.GetTableRowCount(TableIndex.Param)
            for var row = 1; row <= count; row++ {
                let handle = MetadataTokens.ParameterHandle(row)
                let a = left.GetParameter(handle)
                let b = right.GetParameter(handle)
                if a.Attributes != b.Attributes ||
                    a.SequenceNumber != b.SequenceNumber ||
                    !EqualString(left, a.Name, right, b.Name) ||
                    MetadataTokens.GetToken(a.GetDefaultValue()) != MetadataTokens.GetToken(b.GetDefaultValue()) ||
                    !EqualBlob(left, a.GetMarshallingDescriptor(), right, b.GetMarshallingDescriptor()) {
                    return false
                }
            }
            return true
        }

        private func EquivalentInterfaceImplementations(left MetadataReader, right MetadataReader) bool {
            let count = left.GetTableRowCount(TableIndex.InterfaceImpl)
            for var row = 1; row <= count; row++ {
                let handle = MetadataTokens.InterfaceImplementationHandle(row)
                if MetadataTokens.GetToken(
                    left.GetInterfaceImplementation(handle).Interface
                ) != MetadataTokens.GetToken(right.GetInterfaceImplementation(handle).Interface) {
                    return false
                }
            }
            return true
        }

        private func EquivalentMemberReferences(left MetadataReader, right MetadataReader) bool {
            for handle in left.MemberReferences {
                let a = left.GetMemberReference(handle)
                let b = right.GetMemberReference(handle)
                if MetadataTokens.GetToken(a.Parent) != MetadataTokens.GetToken(b.Parent) ||
                    !EqualString(left, a.Name, right, b.Name) ||
                    !EqualBlob(left, a.Signature, right, b.Signature) {
                    return false
                }
            }
            return true
        }

        private func EquivalentConstants(left MetadataReader, right MetadataReader) bool {
            let count = left.GetTableRowCount(TableIndex.Constant)
            for var row = 1; row <= count; row++ {
                let handle = MetadataTokens.ConstantHandle(row)
                let a = left.GetConstant(handle)
                let b = right.GetConstant(handle)
                if a.TypeCode != b.TypeCode || MetadataTokens.GetToken(a.Parent) != MetadataTokens.GetToken(b.Parent) ||
                    !EqualBlob(left, a.Value, right, b.Value) {
                    return false
                }
            }
            return true
        }

        private func EquivalentCustomAttributes(left MetadataReader, right MetadataReader) bool {
            for handle in left.CustomAttributes {
                let a = left.GetCustomAttribute(handle)
                let b = right.GetCustomAttribute(handle)
                if MetadataTokens.GetToken(a.Parent) != MetadataTokens.GetToken(b.Parent) || MetadataTokens.GetToken(
                    a.Constructor
                ) != MetadataTokens.GetToken(b.Constructor) || !EqualBlob(left, a.Value, right, b.Value) {
                    return false
                }
            }
            return true
        }

        private func EquivalentDeclarativeSecurity(left MetadataReader, right MetadataReader) bool {
            let count = left.GetTableRowCount(TableIndex.DeclSecurity)
            for var row = 1; row <= count; row++ {
                let handle = MetadataTokens.DeclarativeSecurityAttributeHandle(row)
                let a = left.GetDeclarativeSecurityAttribute(handle)
                let b = right.GetDeclarativeSecurityAttribute(handle)
                if a.Action != b.Action || MetadataTokens.GetToken(a.Parent) != MetadataTokens.GetToken(b.Parent) ||
                    !EqualBlob(left, a.PermissionSet, right, b.PermissionSet) {
                    return false
                }
            }
            return true
        }

        private func EquivalentEvents(left MetadataReader, right MetadataReader) bool {
            let count = left.GetTableRowCount(TableIndex.Event)
            for var row = 1; row <= count; row++ {
                let handle = MetadataTokens.EventDefinitionHandle(row)
                let a = left.GetEventDefinition(handle)
                let b = right.GetEventDefinition(handle)
                if a.Attributes != b.Attributes || MetadataTokens.GetToken(a.Type) != MetadataTokens.GetToken(b.Type) ||
                    !EqualString(left, a.Name, right, b.Name) ||
                    !EquivalentEventAccessors(a.GetAccessors(), b.GetAccessors()) {
                    return false
                }
            }
            return true
        }

        private func EquivalentProperties(left MetadataReader, right MetadataReader) bool {
            let count = left.GetTableRowCount(TableIndex.Property)
            for var row = 1; row <= count; row++ {
                let handle = MetadataTokens.PropertyDefinitionHandle(row)
                let a = left.GetPropertyDefinition(handle)
                let b = right.GetPropertyDefinition(handle)
                if a.Attributes != b.Attributes ||
                    !EqualString(left, a.Name, right, b.Name) ||
                    !EqualBlob(left, a.Signature, right, b.Signature) ||
                    MetadataTokens.GetToken(a.GetDefaultValue()) != MetadataTokens.GetToken(b.GetDefaultValue()) ||
                    !EquivalentPropertyAccessors(a.GetAccessors(), b.GetAccessors()) {
                    return false
                }
            }
            return true
        }

        private func EquivalentMethodImplementations(left MetadataReader, right MetadataReader) bool {
            let count = left.GetTableRowCount(TableIndex.MethodImpl)
            for var row = 1; row <= count; row++ {
                let handle = MetadataTokens.MethodImplementationHandle(row)
                let a = left.GetMethodImplementation(handle)
                let b = right.GetMethodImplementation(handle)
                if MetadataTokens.GetToken(a.Type) != MetadataTokens.GetToken(b.Type) || MetadataTokens.GetToken(
                    a.MethodBody
                ) != MetadataTokens.GetToken(b.MethodBody) || MetadataTokens.GetToken(
                    a.MethodDeclaration
                ) != MetadataTokens.GetToken(b.MethodDeclaration) {
                    return false
                }
            }
            return true
        }

        private func EquivalentModuleReferences(left MetadataReader, right MetadataReader) bool {
            let count = left.GetTableRowCount(TableIndex.ModuleRef)
            for var row = 1; row <= count; row++ {
                let handle = MetadataTokens.ModuleReferenceHandle(row)
                if !EqualString(
                    left,
                    left.GetModuleReference(handle).Name,
                    right,
                    right.GetModuleReference(handle).Name
                ) {
                    return false
                }
            }
            return true
        }

        private func EquivalentTypeSpecifications(left MetadataReader, right MetadataReader) bool {
            let count = left.GetTableRowCount(TableIndex.TypeSpec)
            for var row = 1; row <= count; row++ {
                let handle = MetadataTokens.TypeSpecificationHandle(row)
                if !EqualBlob(
                    left,
                    left.GetTypeSpecification(handle).Signature,
                    right,
                    right.GetTypeSpecification(handle).Signature
                ) {
                    return false
                }
            }
            return true
        }

        private func EquivalentAssemblyReferences(left MetadataReader, right MetadataReader) bool {
            for handle in left.AssemblyReferences {
                let a = left.GetAssemblyReference(handle)
                let b = right.GetAssemblyReference(handle)
                if a.Version != b.Version ||
                    a.Flags != b.Flags ||
                    !EqualString(left, a.Name, right, b.Name) ||
                    !EqualString(left, a.Culture, right, b.Culture) ||
                    !EqualBlob(left, a.PublicKeyOrToken, right, b.PublicKeyOrToken) ||
                    !EqualBlob(left, a.HashValue, right, b.HashValue) {
                    return false
                }
            }
            return true
        }

        private func EquivalentAssemblyFiles(left MetadataReader, right MetadataReader) bool {
            let count = left.GetTableRowCount(TableIndex.File)
            for var row = 1; row <= count; row++ {
                let handle = MetadataTokens.AssemblyFileHandle(row)
                let a = left.GetAssemblyFile(handle)
                let b = right.GetAssemblyFile(handle)
                if a.ContainsMetadata != b.ContainsMetadata ||
                    !EqualString(left, a.Name, right, b.Name) ||
                    !EqualBlob(left, a.HashValue, right, b.HashValue) {
                    return false
                }
            }
            return true
        }

        private func EquivalentExportedTypes(left MetadataReader, right MetadataReader) bool {
            let count = left.GetTableRowCount(TableIndex.ExportedType)
            for var row = 1; row <= count; row++ {
                let handle = MetadataTokens.ExportedTypeHandle(row)
                let a = left.GetExportedType(handle)
                let b = right.GetExportedType(handle)
                if a.Attributes != b.Attributes || MetadataTokens.GetToken(a.Implementation) != MetadataTokens.GetToken(
                    b.Implementation
                ) ||
                    !EqualString(left, a.Name, right, b.Name) ||
                    !EqualString(left, a.Namespace, right, b.Namespace) {
                    return false
                }
            }
            return true
        }

        private func EquivalentManifestResources(left MetadataReader, right MetadataReader) bool {
            let count = left.GetTableRowCount(TableIndex.ManifestResource)
            for var row = 1; row <= count; row++ {
                let handle = MetadataTokens.ManifestResourceHandle(row)
                let a = left.GetManifestResource(handle)
                let b = right.GetManifestResource(handle)
                if a.Attributes != b.Attributes || a.Offset != b.Offset || MetadataTokens.GetToken(
                    a.Implementation
                ) != MetadataTokens.GetToken(b.Implementation) || !EqualString(left, a.Name, right, b.Name) {
                    return false
                }
            }
            return true
        }

        private func EquivalentGenericParameters(left MetadataReader, right MetadataReader) bool {
            let count = left.GetTableRowCount(TableIndex.GenericParam)
            for var row = 1; row <= count; row++ {
                let handle = MetadataTokens.GenericParameterHandle(row)
                let a = left.GetGenericParameter(handle)
                let b = right.GetGenericParameter(handle)
                if a.Attributes != b.Attributes || a.Index != b.Index || MetadataTokens.GetToken(
                    a.Parent
                ) != MetadataTokens.GetToken(b.Parent) ||
                    !EqualString(left, a.Name, right, b.Name) ||
                    !EqualHandles(a.GetConstraints(), b.GetConstraints()) {
                    return false
                }
            }
            return true
        }

        private func EquivalentMethodSpecifications(left MetadataReader, right MetadataReader) bool {
            let count = left.GetTableRowCount(TableIndex.MethodSpec)
            for var row = 1; row <= count; row++ {
                let handle = MetadataTokens.MethodSpecificationHandle(row)
                let a = left.GetMethodSpecification(handle)
                let b = right.GetMethodSpecification(handle)
                if MetadataTokens.GetToken(a.Method) != MetadataTokens.GetToken(b.Method) ||
                    !EqualBlob(left, a.Signature, right, b.Signature) {
                    return false
                }
            }
            return true
        }

        private func EquivalentGenericConstraints(left MetadataReader, right MetadataReader) bool {
            let count = left.GetTableRowCount(TableIndex.GenericParamConstraint)
            for var row = 1; row <= count; row++ {
                let handle = MetadataTokens.GenericParameterConstraintHandle(row)
                let a = left.GetGenericParameterConstraint(handle)
                let b = right.GetGenericParameterConstraint(handle)
                if MetadataTokens.GetToken(a.Parameter) != MetadataTokens.GetToken(b.Parameter) ||
                    MetadataTokens.GetToken(a.Type) != MetadataTokens.GetToken(b.Type) {
                    return false
                }
            }
            return true
        }

        private func EquivalentImport(
            leftReader MetadataReader,
            left MethodImport,
            rightReader MetadataReader,
            right MethodImport
        ) bool -> left.Attributes == right.Attributes &&
            MetadataTokens.GetToken(left.Module) == MetadataTokens.GetToken(right.Module) &&
            EqualString(leftReader, left.Name, rightReader, right.Name)

        private func EquivalentLayout(left TypeLayout, right TypeLayout) bool -> left.IsDefault == right.IsDefault &&
            left.PackingSize == right.PackingSize &&
            left.Size == right.Size

        private func EquivalentEventAccessors(left EventAccessors, right EventAccessors) bool -> left.Adder.Equals(
            right.Adder
        ) &&
            left
            .Remover
            .Equals(right.Remover) && left.Raiser.Equals(right.Raiser) && left.Others.SequenceEqual(right.Others)

        private func EquivalentPropertyAccessors(left PropertyAccessors, right PropertyAccessors) bool -> left
            .Getter
            .Equals(right.Getter) && left.Setter.Equals(right.Setter) && left.Others.SequenceEqual(right.Others)

        private func MethodBodiesEquivalent(
            previousPe PEReader,
            previousReader MetadataReader,
            previousMethod MethodDefinition,
            currentPe PEReader,
            currentReader MetadataReader,
            currentMethod MethodDefinition
        ) bool {
            if previousMethod.RelativeVirtualAddress == 0 || currentMethod.RelativeVirtualAddress == 0 {
                return previousMethod.RelativeVirtualAddress == currentMethod.RelativeVirtualAddress
            }
            let previousBody = previousPe.GetMethodBody(previousMethod.RelativeVirtualAddress)
            let currentBody = currentPe.GetMethodBody(currentMethod.RelativeVirtualAddress)
            let previousBytes = ReadRawMethodBody(previousPe, previousMethod.RelativeVirtualAddress)
            let currentBytes = ReadRawMethodBody(currentPe, currentMethod.RelativeVirtualAddress)
            if !previousBytes.AsSpan().SequenceEqual(currentBytes) {
                return false
            }
            if !EqualStandaloneSignature(
                previousReader,
                previousBody.LocalSignature,
                currentReader,
                currentBody.LocalSignature
            ) {
                return false
            }
            let previousTokens = ReadSemanticTokens(previousBody.GetILContent(), previousReader)
            let currentTokens = ReadSemanticTokens(currentBody.GetILContent(), currentReader)
            return previousTokens.SequenceEqual(currentTokens)
        }

        private func ReadSemanticTokens(il ImmutableArray[uint8], reader MetadataReader) ImmutableArray[string] {
            let result = ImmutableArray.CreateBuilder[string]()
            VisitTokenOperands(
                il,
                (operandType OperandType, token int32) -> {
                    switch operandType {
                        case OperandType.InlineString {
                            result.Add("s:" + reader.GetUserString(MetadataTokens.UserStringHandle(token & 0x00ffffff)))
                        }
                        case OperandType.InlineSig {
                            let signature = reader.GetStandaloneSignature(
                                MetadataTokens.StandaloneSignatureHandle(token & 0x00ffffff)
                            )
                            result.Add("g:" + ToKey(reader.GetBlobBytes(signature.Signature)))
                        }
                        default {
                            let _ = 0
                        }
                    }
                }
            )
            return result.ToImmutable()
        }

        private func ReadRawMethodBody(peReader PEReader, relativeVirtualAddress int32)[]uint8 {
            let body = peReader.GetMethodBody(relativeVirtualAddress)
            return peReader.GetSectionData(relativeVirtualAddress).GetContent(0, body.Size).ToArray()
        }

        private func PatchMethodBodyTokens(
            body[]uint8,
            reader MetadataReader,
            metadata MetadataBuilder,
            signatures Dictionary[string, int32],
            userStrings Dictionary[string, int32],
            newStandaloneSignatures List[EntityHandle],
            ref standaloneSignatureCount int32
        ) {
            var nextStandaloneSignatureCount = standaloneSignatureCount
            let headerSize = GetMethodHeaderSize(body)
            if headerSize > 1 {
                let localSignatureToken = BinaryPrimitives.ReadInt32LittleEndian(body.AsSpan(8, 4))
                if localSignatureToken != 0 {
                    let mapped = MapStandaloneSignature(
                        localSignatureToken,
                        reader,
                        metadata,
                        signatures,
                        newStandaloneSignatures,
                        &nextStandaloneSignatureCount
                    )
                    BinaryPrimitives.WriteInt32LittleEndian(body.AsSpan(8, 4), mapped)
                }
            }
            let ilSize = GetMethodCodeSize(body, headerSize)
            VisitTokenOperands(
                body.AsSpan(headerSize, ilSize),
                (operandType OperandType, token int32, operandOffset int32) -> {
                    switch operandType {
                        case OperandType.InlineString {
                            let value = reader.GetUserString(MetadataTokens.UserStringHandle(token & 0x00ffffff))
                            if !userStrings.TryGetValue(value, out var mappedString) {
                                mappedString = MetadataTokens.GetToken(metadata.GetOrAddUserString(value))
                                userStrings.Add(value, mappedString)
                            }
                            BinaryPrimitives.WriteInt32LittleEndian(
                                body.AsSpan(headerSize + operandOffset, 4),
                                mappedString
                            )
                        }
                        case OperandType.InlineSig {
                            let mappedSignature = MapStandaloneSignature(
                                token,
                                reader,
                                metadata,
                                signatures,
                                newStandaloneSignatures,
                                &nextStandaloneSignatureCount
                            )
                            BinaryPrimitives.WriteInt32LittleEndian(
                                body.AsSpan(headerSize + operandOffset, 4),
                                mappedSignature
                            )
                        }
                        default {
                            let _ = 0
                        }
                    }
                }
            )
            standaloneSignatureCount = nextStandaloneSignatureCount
        }

        private func MapStandaloneSignature(
            token int32,
            reader MetadataReader,
            metadata MetadataBuilder,
            signatures Dictionary[string, int32],
            newStandaloneSignatures List[EntityHandle],
            ref standaloneSignatureCount int32
        ) int32 {
            let signature = reader.GetStandaloneSignature(MetadataTokens.StandaloneSignatureHandle(token & 0x00ffffff))
            let signatureBytes = reader.GetBlobBytes(signature.Signature)
            let key = ToKey(signatureBytes)
            if signatures.TryGetValue(key, out var mapped) {
                return mapped
            }
            metadata.AddStandaloneSignature(metadata.GetOrAddBlob(signatureBytes))
            let handle = MetadataTokens.StandaloneSignatureHandle((standaloneSignatureCount += 1))
            mapped = MetadataTokens.GetToken(handle)
            signatures.Add(key, mapped)
            newStandaloneSignatures.Add(handle)
            return mapped
        }

        private func GetMethodHeaderSize(body[]uint8) int32 {
            let format = int32(body[0]) & 0x3
            if format == 0x2 {
                return 1
            }
            if format != 0x3 || body.Length < 12 {
                throw BadImageFormatException("Invalid managed method header in hot-reload output.")
            }
            let flagsAndSize = BinaryPrimitives.ReadUInt16LittleEndian(body.AsSpan(0, 2))
            return ((int32(flagsAndSize) >> 12) & 0xf) * 4
        }

        private func GetMethodCodeSize(body[]uint8, headerSize int32) int32 -> if headerSize == 1 {
            int32(body[0]) >> 2
        } else {
            BinaryPrimitives.ReadInt32LittleEndian(body.AsSpan(4, 4))
        }

        private func VisitTokenOperands(il ImmutableArray[uint8], visitor(OperandType, int32) -> void) {
            VisitTokenOperands(
                il.AsSpan(),
                (operandType OperandType, token int32, _ int32) -> visitor(operandType, token)
            )
        }

        private func VisitTokenOperands(il ReadOnlySpan[uint8], visitor(OperandType, int32, int32) -> void) {
            var offset = 0
            while offset < il.Length {
                var value uint16 = il[offset++]
                if value == uint16(0xfe) {
                    if offset >= il.Length {
                        throw BadImageFormatException("Truncated two-byte IL opcode.")
                    }
                    value = uint16((0xfe00 | int32(il[offset])))
                    offset++
                }
                if !OperandTypes.TryGetValue(value, out var operandType) {
                    throw BadImageFormatException("Unknown IL opcode 0x${value:x4}.")
                }
                let operandOffset = offset
                let operandSize = GetOperandSize(operandType, il, operandOffset)
                if operandOffset + operandSize > il.Length {
                    throw BadImageFormatException("Truncated IL operand.")
                }
                if operandType == OperandType.InlineString || operandType == OperandType.InlineSig {
                    visitor(
                        operandType,
                        BinaryPrimitives.ReadInt32LittleEndian(il.Slice(operandOffset, 4)),
                        operandOffset
                    )
                }
                offset += operandSize
            }
        }

        private func GetOperandSize(
            operandType OperandType,
            il ReadOnlySpan[uint8],
            offset int32
        ) int32 -> switch operandType {
            case OperandType.InlineNone: 0
            case OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar: 1
            case OperandType.InlineVar: 2
            case OperandType.InlineBrTarget or
                OperandType.InlineField or
                OperandType.InlineI or
                OperandType.InlineMethod or
                OperandType.InlineSig or
                OperandType.InlineString or
                OperandType.InlineTok or
                OperandType.InlineType or
                OperandType.ShortInlineR: 4
            case OperandType.InlineI8 or OperandType.InlineR: 8
            case OperandType.InlineSwitch: GetSwitchOperandSize(il, offset)
            default: throw BadImageFormatException("Unsupported IL operand type '$operandType'.")
        }

        private func GetSwitchOperandSize(il ReadOnlySpan[uint8], offset int32) int32 {
            if offset + 4 > il.Length {
                throw BadImageFormatException("Truncated switch operand.")
            }
            let count = BinaryPrimitives.ReadInt32LittleEndian(il.Slice(offset, 4))
            if count < 0 {
                throw BadImageFormatException("Negative switch target count.")
            }
            return checked(4 + (count * 4))
        }

        private func CreateOperandTypeMap() IReadOnlyDictionary[uint16, OperandType] {
            let result = Dictionary[uint16, OperandType]()
            for field in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static) {
                if field.GetValue(nil) is OpCode opcode {
                    result[unchecked(uint16(opcode.Value))] = opcode.OperandType
                }
            }
            return result
        }

        private func EqualString(
            leftReader MetadataReader,
            left StringHandle,
            rightReader MetadataReader,
            right StringHandle
        ) bool -> left.IsNil == right.IsNil &&
            (
            left.IsNil || string.Equals(
                leftReader.GetString(left),
                rightReader.GetString(right),
                StringComparison.Ordinal
            )
        )

        private func EqualBlob(
            leftReader MetadataReader,
            left BlobHandle,
            rightReader MetadataReader,
            right BlobHandle
        ) bool -> left.IsNil == right.IsNil &&
            (left.IsNil || leftReader.GetBlobBytes(left).AsSpan().SequenceEqual(rightReader.GetBlobBytes(right)))

        private func EqualStandaloneSignature(
            leftReader MetadataReader,
            left StandaloneSignatureHandle,
            rightReader MetadataReader,
            right StandaloneSignatureHandle
        ) bool {
            if left.IsNil || right.IsNil {
                return left.IsNil == right.IsNil
            }
            return EqualBlob(
                leftReader,
                leftReader.GetStandaloneSignature(left).Signature,
                rightReader,
                rightReader.GetStandaloneSignature(right).Signature
            )
        }

        private func EqualHandles[THandle struct](left IEnumerable[THandle], right IEnumerable[THandle]) bool {
            using let leftEnumerator = left.GetEnumerator()
            using let rightEnumerator = right.GetEnumerator()
            while true {
                let hasLeft = leftEnumerator.MoveNext()
                let hasRight = rightEnumerator.MoveNext()
                if hasLeft != hasRight {
                    return false
                }
                if !hasLeft {
                    return true
                }
                if !EqualityComparer[THandle].Default.Equals(leftEnumerator.Current, rightEnumerator.Current) {
                    return false
                }
            }
        }

        private func GetMethodDisplayName(reader MetadataReader, methodHandle MethodDefinitionHandle) string {
            let method = reader.GetMethodDefinition(methodHandle)
            let type = reader.GetTypeDefinition(method.GetDeclaringType())
            let typeName = reader.GetString(type.Name)
            let namespaceName = reader.GetString(type.Namespace)
            let methodName = reader.GetString(method.Name)
            return if string.IsNullOrEmpty(namespaceName) {
                "$typeName.$methodName"
            } else {
                "$namespaceName.$typeName.$methodName"
            }
        }

        private func ToKey(bytes[]uint8) string -> Convert.ToBase64String(bytes)
    }
}

internal class HotReloadDelta {
    private let commit(() -> void)?

    private init(
        status HotReloadDeltaStatus,
        metadataDelta[]uint8,
        ilDelta[]uint8,
        pdbDelta[]uint8,
        updatedMethods ImmutableArray[string],
        updatedTypes ImmutableArray[int32],
        diagnostic string?,
        commit(() -> void)?
    ) {
        this.Status = status
        this.MetadataDelta = metadataDelta
        this.IlDelta = ilDelta
        this.PdbDelta = pdbDelta
        this.UpdatedMethods = updatedMethods
        this.UpdatedTypes = updatedTypes
        this.Diagnostic = diagnostic
        this.commit = commit
    }

    prop Status HotReloadDeltaStatus {
        get;
    }

    prop MetadataDelta[]uint8 {
        get;
    }

    prop IlDelta[]uint8 {
        get;
    }

    prop PdbDelta[]uint8 {
        get;
    }

    prop UpdatedMethods ImmutableArray[string] {
        get;
    }

    /// TypeDef tokens of the types whose members the delta changes, in
    /// update order and without duplicates; passed to metadata update
    /// handlers.
    prop UpdatedTypes ImmutableArray[int32] {
        get;
    }

    prop Diagnostic string? {
        get;
    }

    func Commit() -> this.commit?()

    shared {
        func Ready(
            metadataDelta[]uint8,
            ilDelta[]uint8,
            updatedMethods ImmutableArray[string],
            updatedTypes ImmutableArray[int32],
            commit() -> void,
            pdbDelta[]?uint8 = nil
        ) HotReloadDelta -> HotReloadDelta(
            HotReloadDeltaStatus.Ready,
            metadataDelta,
            ilDelta,
            pdbDelta ?? Array.Empty[uint8](),
            updatedMethods,
            updatedTypes,
            diagnostic: nil,
            commit
        )

        func NoChanges() HotReloadDelta -> HotReloadDelta(
            HotReloadDeltaStatus.NoChanges,
            Array.Empty[uint8](),
            Array.Empty[uint8](),
            Array.Empty[uint8](),
            ImmutableArray[string].Empty,
            ImmutableArray[int32].Empty,
            diagnostic: nil,
            commit: nil
        )

        func Unsupported(diagnostic string) HotReloadDelta -> HotReloadDelta(
            HotReloadDeltaStatus.Unsupported,
            Array.Empty[uint8](),
            Array.Empty[uint8](),
            Array.Empty[uint8](),
            ImmutableArray[string].Empty,
            ImmutableArray[int32].Empty,
            diagnostic,
            commit: nil
        )
    }
}
