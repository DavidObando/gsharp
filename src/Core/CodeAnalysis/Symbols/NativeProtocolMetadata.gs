// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Emit
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.CompilerServices
import System.Text.Json

internal class NativeProtocolAssemblyContract(
    protocols ImmutableArray[Type],
    error string?,
    manifest JsonElement = default(JsonElement)
) {
    internal prop Protocols ImmutableArray[Type] -> protocols
    internal prop Error string? -> error
    internal prop Manifest JsonElement -> manifest
}

internal shared class NativeProtocolMetadata {
    internal const Key string = "GSharp.NativeProtocols"
    internal const FeatureKey string = "GSharp.NativeProtocolFeature"
    internal const FeatureName string = "GSharp.NativeProtocols.v1"
    internal const Schema string = "6b105e95-6860-496a-9acb-d81bc250a275/1"

    private let cache ConditionalWeakTable[Assembly, NativeProtocolAssemblyContract] =
    ConditionalWeakTable[Assembly, NativeProtocolAssemblyContract]()
    private let nativeImages ConditionalWeakTable[Assembly, StrongBox[bool]] =
    ConditionalWeakTable[Assembly, StrongBox[bool]]()

    internal func Read(assembly Assembly) NativeProtocolAssemblyContract -> cache.GetValue(assembly, ReadSafely)

    private func ReadSafely(assembly Assembly) NativeProtocolAssemblyContract {
        try {
            return ReadCore(assembly)
        } catch (error BadImageFormatException) {
            return NativeProtocolAssemblyContract(
                ImmutableArray[Type].Empty,
                "malformed native protocol attribute encoding: " + error.Message
            )
        } catch (error CustomAttributeFormatException) {
            return NativeProtocolAssemblyContract(
                ImmutableArray[Type].Empty,
                "malformed native protocol custom attribute: " + error.Message
            )
        } catch (error TypeLoadException) {
            return NativeProtocolAssemblyContract(
                ImmutableArray[Type].Empty,
                "unresolved native protocol attribute dependency: " + error.Message
            )
        }
    }

    internal func IsPublic(type TypeSymbol) bool -> if type is StructSymbol aggregate {
        aggregate.Accessibility == Accessibility.Public && aggregate.ContainingType == nil
    } else {
        if type is InterfaceSymbol protocol {
            protocol.Accessibility == Accessibility.Public && protocol.ContainingType == nil
        } else {
            type.ClrType?.IsVisible == true
        }
    }

    internal func TypeName(type TypeSymbol) string -> if type.ContainingType is {} parent {
        TypeName(parent) + "+" + type.Name
    } else {
        if string.IsNullOrEmpty(type.ContainingNamespace) {
            type.Name
        } else {
            type.ContainingNamespace + "." + type.Name
        }
    }

    internal func Identity(type TypeSymbol, localAssembly string) string -> if type.ClrType is {} imported {
        imported.Assembly.FullName + "|" + imported.FullName
    } else {
        localAssembly + "|" + TypeName(type)
    }

    internal func Signature(method FunctionSymbol, localAssembly string) string ->
    method.Name + "(" + string.Join(
        ",",
        method.Parameters.Select(
            (parameter ParameterSymbol) -> parameter.RefKind.ToString() +
                ":" +
                TypeSignature(parameter.Type, localAssembly)
        )
    ) +
        ")->" +
        method
        .ReturnRefKind
        .ToString() + ":" + TypeSignature(method.Type, localAssembly)

    private func TypeSignature(type TypeSymbol, localAssembly string) string ->
    type.ToDisplayString(DisplayFormat.FullyQualified) +
        "@" +
        (type.ClrType?.Assembly.FullName ?? localAssembly) +
        "[" +
        string.Join(",", NullableFlagsBuilder.Build(type)) +
        "]" +
        (
        if type.ConstructedTypeArguments.IsDefaultOrEmpty {
            string.Empty
        } else {
            "<" + string.Join(
                ",",
                type.ConstructedTypeArguments.Select((argument TypeSymbol) -> TypeSignature(argument, localAssembly))
            ) +
                ">"
        }
    )

    internal func Require(element JsonElement, name string, kind JsonValueKind) JsonElement {
        if element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var value) ||
            value.ValueKind != kind {
            throw InvalidDataException("missing or malformed native protocol field '" + name + "'")
        }
        return value
    }

    internal func RequireFields(element JsonElement, fields ...string) {
        if element.ValueKind != JsonValueKind.Object {
            throw InvalidDataException("native protocol record must be an object")
        }
        let seen = HashSet[string](StringComparer.Ordinal)
        for property in element.EnumerateObject() {
            if !fields.Contains(property.Name, StringComparer.Ordinal) || !seen.Add(property.Name) {
                throw InvalidDataException("unknown or duplicate native protocol field '" + property.Name + "'")
            }
        }
        if seen.Count != fields.Length {
            throw InvalidDataException("incomplete native protocol record")
        }
    }

    internal func IsProtocol(type TypeSymbol) bool {
        if type is NullabilityAnnotatedTypeSymbol annotated {
            return IsProtocol(annotated.BaseType)
        }
        if type is NullableTypeSymbol || type is PlatformTypeSymbol || type is ByRefTypeSymbol {
            return false
        }
        if type is InterfaceSymbol source {
            return source.IsProtocol
        }
        if type.ClrType is not{} imported {
            return false
        }
        return Read(imported.Assembly).Protocols.Any(
            (candidate Type) -> ClrTypeUtilities.AreSame(candidate, imported)
        ) ||
            imported.IsInterface &&
            HasFeatureMarker(imported)
    }

    internal func HasFeatureMarker(member MemberInfo) bool -> HasNativeImage(member.Module.Assembly) &&
        member
        .GetCustomAttributesData().Any(
        (attribute CustomAttributeData) ->
        IsAttributeType(attribute, typeof(CompilerFeatureRequiredAttribute)) &&
            attribute
            .ConstructorArguments
            .Count == 1 &&
            attribute
            .ConstructorArguments[0]
            .Value is string feature &&
            feature.StartsWith("GSharp.NativeProtocols.", StringComparison.Ordinal)
    )

    internal func HasSupportedFeatureMarker(member MemberInfo) bool {
        if !HasNativeImage(member.Module.Assembly) {
            return false
        }
        let markers = member
            .GetCustomAttributesData()
            .Where(
            (attribute CustomAttributeData) ->
            IsAttributeType(attribute, typeof(CompilerFeatureRequiredAttribute)) &&
                attribute
                .ConstructorArguments
                .Count == 1 &&
                attribute
                .ConstructorArguments[0]
                .Value is string feature &&
                feature.StartsWith("GSharp.NativeProtocols.", StringComparison.Ordinal)
        )
            .ToArray()
        return markers.Length == 1 &&
            markers[0]
            .ConstructorArguments[0]
            .Value is string feature &&
            feature == FeatureName
    }

    private func ReadCore(assembly Assembly) NativeProtocolAssemblyContract {
        if !HasNativeImage(assembly) {
            return NativeProtocolAssemblyContract(ImmutableArray[Type].Empty, nil)
        }
        let protocols = ImmutableArray.CreateBuilder[Type]()
        var found = false
        var featureCount = 0
        var manifest = default(JsonElement)
        for attribute in assembly.GetCustomAttributesData() {
            if !IsAttributeType(attribute, typeof(AssemblyMetadataAttribute)) ||
                attribute
                .ConstructorArguments
                .Count != 2 ||
                attribute
                .ConstructorArguments[0]
                .Value is not string key {
                continue
            }
            if key == FeatureKey {
                featureCount++
                if featureCount > 1 ||
                    attribute
                    .ConstructorArguments[1]
                    .Value is not string feature ||
                    feature != Schema {
                    return NativeProtocolAssemblyContract(
                        ImmutableArray[Type].Empty,
                        "unsupported or duplicate native protocol feature contract"
                    )
                }
                continue
            }
            if key != Key {
                continue
            }
            if found {
                return NativeProtocolAssemblyContract(ImmutableArray[Type].Empty, "duplicate native protocol manifests")
            }
            found = true
            if attribute.ConstructorArguments[1].Value is not string payload {
                return NativeProtocolAssemblyContract(ImmutableArray[Type].Empty, "malformed native protocol manifest")
            }
            try {
                using let document = JsonDocument.Parse(payload)
                let root = document.RootElement
                RequireFields(root, "schema", "declarations", "entries")
                if Require(root, "schema", JsonValueKind.String).GetString() != Schema {
                    throw InvalidDataException("unsupported native protocol schema")
                }
                let declarations = Require(root, "declarations", JsonValueKind.Array)
                Require(root, "entries", JsonValueKind.Array)
                let names = HashSet[string](StringComparer.Ordinal)
                for declaration in declarations.EnumerateArray() {
                    RequireFields(declaration, "type", "slots")
                    let name = Require(declaration, "type", JsonValueKind.String).GetString()
                    Require(declaration, "slots", JsonValueKind.Array)
                    if name == nil || !names.Add(name) {
                        throw InvalidDataException("malformed or duplicate protocol identity")
                    }
                    let type = assembly.GetType(name, throwOnError: false)
                    if type == nil || !type.IsInterface || type.IsGenericType {
                        throw InvalidDataException("stale or unsupported protocol identity")
                    }
                    protocols.Add(type)
                }
                manifest = root.Clone()
            } catch (error JsonException) {
                return NativeProtocolAssemblyContract(
                    ImmutableArray[Type].Empty,
                    "malformed native protocol JSON: " + error.Message
                )
            } catch (error InvalidDataException) {
                return NativeProtocolAssemblyContract(ImmutableArray[Type].Empty, error.Message)
            } catch (error ArgumentException) {
                return NativeProtocolAssemblyContract(
                    ImmutableArray[Type].Empty,
                    "malformed native protocol type identity: " + error.Message
                )
            } catch (error TypeLoadException) {
                return NativeProtocolAssemblyContract(
                    ImmutableArray[Type].Empty,
                    "stale native protocol type dependency: " + error.Message
                )
            } catch (error FileNotFoundException) {
                return NativeProtocolAssemblyContract(
                    ImmutableArray[Type].Empty,
                    "missing native protocol declaration dependency: " + error.Message
                )
            }
        }
        if found != (featureCount == 1) {
            return NativeProtocolAssemblyContract(
                ImmutableArray[Type].Empty,
                "missing native protocol manifest or required feature contract"
            )
        }
        return NativeProtocolAssemblyContract(protocols.ToImmutable(), nil, manifest)
    }

    private func HasNativeImage(assembly Assembly) bool -> nativeImages.GetValue(
        assembly,
        (image Assembly) -> {
            using let stream = ReferenceResolver.OpenAssemblyImage(image)
            if stream == nil {
                return StrongBox[bool](true)
            }
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            for handle in reader.CustomAttributes {
                let attribute = reader.GetCustomAttribute(handle)
                if attribute.Constructor.Kind != HandleKind.MemberReference {
                    continue
                }
                let constructor = reader.GetMemberReference(cast[MemberReferenceHandle](attribute.Constructor))
                if constructor.Parent.Kind != HandleKind.TypeReference {
                    continue
                }
                let type = reader.GetTypeReference(cast[TypeReferenceHandle](constructor.Parent))
                let name = reader.GetString(type.Name)
                let ns = reader.GetString(type.Namespace)
                if !(ns == "System.Reflection" && name == "AssemblyMetadataAttribute") &&
                    !(ns == "System.Runtime.CompilerServices" && name == "CompilerFeatureRequiredAttribute") {
                    continue
                }
                var blob = reader.GetBlobReader(attribute.Value)
                if blob.ReadUInt16() != 1 {
                    continue
                }
                let value = blob.ReadSerializedString()
                if value == Key || value == FeatureKey || value?.StartsWith(
                    "GSharp.NativeProtocols.",
                    StringComparison.Ordinal
                ) == true {
                    return StrongBox[bool](true)
                }
            }
            return StrongBox[bool](false)
        }
    )
        .Value

    private func IsAttributeType(attribute CustomAttributeData, expected Type) bool ->
    ClrTypeUtilities.AreSame(attribute.AttributeType, expected) &&
        attribute
        .AttributeType
        .Assembly
        .FullName == expected
        .Assembly
        .FullName
}
