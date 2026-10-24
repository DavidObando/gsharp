// <copyright file="MetadataNullability.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335

/// The nullability of one signature position of a handle-backed member (ADR-0209 section 5, "One decoder").
/// @remarks A position is deferred when its type has inner positions (type arguments, array elements, tuples) or is a
/// shape this stage does not read. A deferred position keeps its nullability-free structure, and the comparison skips it.
internal class MetadataNullablePosition {
    internal init(type TypeSymbol, state ClrNullabilityState, isDeferred bool) {
        Type = type
        State = state
        IsDeferred = isDeferred
    }

    /// Gets the position type with nullability applied. For a deferred position it is the structure as decoded.
    internal prop Type TypeSymbol

    /// Gets what the declaration says about the position's outermost reference position.
    internal prop State ClrNullabilityState

    /// Gets whether the position has inner positions or a shape that a later stage reads.
    internal prop IsDeferred bool
}

/// The nullability of the positions of a method signature: the return value, then each parameter.
internal class MetadataNullableSignature {
    internal init(returnPosition MetadataNullablePosition, parameters ImmutableArray[MetadataNullablePosition]) {
        Return = returnPosition
        Parameters = parameters
    }

    internal prop Return MetadataNullablePosition

    internal prop Parameters ImmutableArray[MetadataNullablePosition]
}

/// The metadata-side half of the nullability funnel (ADR-0193, ADR-0209 section 5).
/// @remarks It reads the `[Nullable]` and `[NullableContext]` bytes from the attribute blobs, with the same fallback
/// chain as (cref:ClrNullability.ReadNullableFlags), classifies them with (cref:ClrNullability.ClassifyPosition), and
/// applies them with (cref:NullabilityImportRule.ApplyConcrete). It computes nothing that those three do not. Only the
/// positions with no inner position are read in this stage.
internal shared class MetadataNullability {
    private let AttributeNamespace string = "System.Runtime.CompilerServices"
    private let NullableName string = "NullableAttribute"
    private let NullableContextName string = "NullableContextAttribute"

    /// Reads the declared bytes of a position: its own `[Nullable]`, else the first `[NullableContext]` of the holders,
    /// in order. No bytes at all give the empty array, which classifies as oblivious.
    /// @param own The member row that carries `[Nullable]` for the position (a `Param` row, a field, a property).
    /// @param holders The rows searched for `[NullableContext]`, innermost first.
    @NullabilityFunnel
    internal func ReadFlags(module MetadataModule, own EntityHandle, holders IEnumerable[EntityHandle]) ImmutableArray[
        uint8
    ] {
        if !own.IsNil {
            let flags = ReadRaw(module, own, false)
            if !flags.IsDefault {
                return flags
            }
        }
        for holder in holders {
            let context = ReadRaw(module, holder, true)
            if !context.IsDefault {
                return context
            }
        }
        return ImmutableArray[uint8].Empty
    }

    /// Lists the rows that can carry `[NullableContext]` for a member of a type, innermost first:
    /// an optional member row, the type, then the types that enclose it.
    internal func ContextHolders(module MetadataModule, member EntityHandle, type TypeDefinitionHandle) List[
        EntityHandle
    ] {
        let holders = List[EntityHandle]()
        if !member.IsNil {
            holders.Add(member)
        }
        var current = type
        while !current.IsNil {
            holders.Add(current)
            current = module.Reader.GetTypeDefinition(current).GetDeclaringType()
        }
        return holders
    }

    /// Reads the nullability of one position from its structure and its bytes.
    /// The structure may be by-ref and may carry custom modifiers; both are kept around the result.
    @NullabilityFunnel
    internal func ApplyPosition(
        set ReferenceImageSet,
        structure TypeSymbol,
        flags ImmutableArray[uint8]
    ) MetadataNullablePosition {
        let outer = MetadataModifiers.Of(structure)
        var core = MetadataModifiers.Strip(structure)
        var byRef ByRefTypeSymbol? = nil
        var inner = ImmutableArray[MetadataCustomModifier].Empty
        if core is ByRefTypeSymbol peeled {
            byRef = peeled
            inner = MetadataModifiers.Of(peeled.PointeeType)
            core = MetadataModifiers.Strip(peeled.PointeeType)
        }
        let state = ClrNullability.ClassifyPosition(flags, 0)
        if !IsSinglePosition(core) {
            return MetadataNullablePosition(structure, state, true)
        }
        var applied = NullabilityImportRule.ApplyConcrete(core, state)
        if !inner.IsEmpty {
            applied = set.GetModified(applied, inner)
        }
        if byRef != nil {
            applied = ByRefTypeSymbol.Get(applied)
        }
        if !outer.IsEmpty {
            applied = set.GetModified(applied, outer)
        }
        return MetadataNullablePosition(applied, state, false)
    }

    /// Tells whether a position type has exactly one position of its own: a built-in, a non-generic definition, a type
    /// parameter, or a `Nullable<T>` over such a value type. Anything with type arguments, an element type, tuple
    /// elements or a pointer is read by a later stage.
    internal func IsSinglePosition(type TypeSymbol) bool {
        if type is NullableTypeSymbol nullable {
            return IsSinglePosition(nullable.UnderlyingType)
        }
        if type is TypeParameterSymbol {
            return true
        }
        if type is MetadataTypeSymbol definition {
            return definition.GenericParameters.Length == 0
        }
        return MetadataTypeKeys.IsBuiltIn(type)
    }

    /// The reflection-type side of (cref:IsSinglePosition), for the comparison.
    internal func IsSinglePosition(type Type) bool {
        if type.IsGenericParameter {
            return true
        }
        // Only the core library's `Nullable<T>` is a stated nullable; a namesake is an ordinary generic type.
        if type.IsGenericType && !type.IsGenericTypeDefinition && type.GetGenericTypeDefinition()
            .FullName == "System.Nullable`1" &&
            MetadataTypeKeys
            .IsCoreLibrary(type.GetGenericTypeDefinition().Assembly) {
            return IsSinglePosition(type.GetGenericArguments()[0])
        }
        return !type.IsGenericType && !type.IsArray && !type.IsPointer && !type.IsByRef && !type.IsFunctionPointer
    }

    /// Spells a position's mark: `?` for a stated nullable, `!` for a platform type, empty for the rest.
    /// A deferred position is `~`. The one spelling for the symbol and the legacy side.
    internal func Mark(type TypeSymbol, isDeferred bool) string {
        if isDeferred {
            return "~"
        }
        // A by-ref or modified position has the mark of the type beneath.
        let core = MetadataModifiers.Strip(type)
        if core is ByRefTypeSymbol byRef {
            return Mark(byRef.PointeeType, false)
        }
        if core is NullableTypeSymbol {
            return Mark(ImportedReferenceNullability.Nullable)
        }
        return if core is PlatformTypeSymbol {
            Mark(ImportedReferenceNullability.Platform)
        } else {
            Mark(ImportedReferenceNullability.Unchanged)
        }
    }

    /// Spells the mark of a decision of (cref:NullabilityImportRule): the same characters as (cref:Mark(TypeSymbol, bool)).
    internal func Mark(decision ImportedReferenceNullability) string -> switch decision {
        case ImportedReferenceNullability.Nullable: "?"
        case ImportedReferenceNullability.Platform: "!"
        default: ""
    }

    // ---- attribute blobs

    private func ReadRaw(module MetadataModule, entity EntityHandle, context bool) ImmutableArray[uint8] {
        let reader = module.Reader
        for attributeHandle in reader.GetCustomAttributes(entity) {
            let attribute = reader.GetCustomAttribute(attributeHandle)
            if !IsAttribute(
                reader,
                attribute,
                if context {
                    NullableContextName
                } else {
                    NullableName
                }
            ) {
                continue
            }
            var blob = reader.GetBlobReader(attribute.Value)
            if blob.ReadUInt16() != 1 {
                continue
            }
            let payload = blob.ReadBytes(blob.RemainingBytes)
            // NullableAttribute has two constructors: (byte) and (byte[]). The constructor's own signature says which
            // one the blob was written for; the blob's length does not (named arguments can follow either).
            let decoded = DecodePayload(payload, !context && TakesByteArray(reader, attribute.Constructor))
            if !decoded.IsDefault {
                return decoded
            }
        }
        return default(ImmutableArray[uint8])
    }

    /// Decodes the fixed arguments that follow the prolog of a `[Nullable]` or `[NullableContext]` blob: one byte, or a
    /// length-prefixed byte array. Bytes after the fixed arguments (named arguments) are ignored. A payload that is too
    /// short, or a null or oversized array, is not a declaration and gives the default array.
    internal func DecodePayload(payload[]uint8, isArray bool) ImmutableArray[uint8] {
        if !isArray {
            return if payload.Length >= 1 {
                ImmutableArray.Create(payload[0])
            } else {
                default(ImmutableArray[uint8])
            }
        }
        if payload.Length < 4 {
            return default(ImmutableArray[uint8])
        }
        let count = BitConverter.ToInt32(payload, 0)
        if count < 0 || count > payload.Length - 4 {
            return default(ImmutableArray[uint8])
        }
        return ImmutableArray.Create(payload, 4, count)
    }

    // Tells whether an attribute constructor's first parameter is an array: the signature is the calling convention
    // byte, the parameter count, the return type (void), then the first parameter's element type.
    internal func TakesByteArray(reader MetadataReader, constructor EntityHandle) bool {
        var signature BlobHandle = default(BlobHandle)
        if constructor.Kind == HandleKind.MemberReference {
            signature = reader.GetMemberReference(cast[MemberReferenceHandle](constructor)).Signature
        } else if constructor.Kind == HandleKind.MethodDefinition {
            signature = reader.GetMethodDefinition(cast[MethodDefinitionHandle](constructor)).Signature
        } else {
            return false
        }
        var blob = reader.GetBlobReader(signature)
        blob.ReadByte()
        if blob.ReadCompressedInteger() < 1 {
            return false
        }
        blob.ReadByte()
        return blob.ReadByte() == 0x1D
    }

    // The attribute type is matched by namespace and name, as ADR-0209 section 6 says: the type is never constructed.
    private func IsAttribute(reader MetadataReader, attribute CustomAttribute, name string) bool {
        let constructor = attribute.Constructor
        if constructor.Kind == HandleKind.MemberReference {
            let parent = reader.GetMemberReference(cast[MemberReferenceHandle](constructor)).Parent
            if parent.Kind != HandleKind.TypeReference {
                return false
            }
            let reference = reader.GetTypeReference(cast[TypeReferenceHandle](parent))
            return reader.GetString(reference.Name) == name && reader.GetString(
                reference.Namespace
            ) == AttributeNamespace
        }
        if constructor.Kind == HandleKind.MethodDefinition {
            let declaring = reader.GetTypeDefinition(
                reader.GetMethodDefinition(cast[MethodDefinitionHandle](constructor)).GetDeclaringType()
            )
            return reader.GetString(declaring.Name) == name && reader.GetString(
                declaring.Namespace
            ) == AttributeNamespace
        }
        return false
    }
}
