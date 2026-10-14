// <copyright file="MarshalAsMetadata.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Reflection.Metadata
import System.Runtime.InteropServices

/// The resolved per-parameter `@MarshalAs(UnmanagedType.…)` override
/// attached to a P/Invoke (cref:ParameterSymbol) (ADR-0096 /
/// issue #762). Carries enough state to (a) build the CLR
/// `FieldMarshal` blob per ECMA-335 II.23.4 and (b) preserve the
/// original syntactic intent for tooling.
/// @remarks One instance is attached by (cref:Binding.PInvokeBinder) when
/// the parameter carries a well-formed `@MarshalAs` annotation;
/// the emitter consumes it to set
/// (cref:System.Reflection.ParameterAttributes.HasFieldMarshal)
/// and to add a row to the `FieldMarshal` table via
/// `MetadataBuilder.AddMarshallingDescriptor`.
/// The attribute is <em>pseudo-custom</em> — its data lives entirely
/// in the dedicated metadata table, so the emitter does NOT also write
/// it as a `CustomAttribute` row (see
/// (cref:Binding.KnownAttributes.IsPseudoCustomAttribute)).
data class MarshalAsMetadata : IEquatable[MarshalAsMetadata] {
    /// Initializes a new instance of the (cref:MarshalAsMetadata) class.
    /// @param unmanagedType The primary (cref:UnmanagedType) override.
    /// @param arraySubType For (cref:UnmanagedType.LPArray) / (cref:UnmanagedType.ByValArray): the
    /// per-element (cref:UnmanagedType) (defaults to (cref:UnmanagedType.AsAny) meaning "unspecified" when
    /// null).
    /// @param safeArraySubType For (cref:UnmanagedType.SafeArray): the per-element (cref:VarEnum) (null
    /// when not specified).
    /// @param sizeConst For sized arrays / fixed strings: the compile-time element count (null when not
    /// specified).
    /// @param sizeParamIndex For (cref:UnmanagedType.LPArray): the zero-based parameter index whose value
    /// is the array element count (null when not specified).
    init(
        unmanagedType UnmanagedType,
        arraySubType UnmanagedType? = nil,
        safeArraySubType VarEnum? = nil,
        sizeConst int32? = nil,
        sizeParamIndex int32? = nil
    ) {
        UnmanagedType = unmanagedType
        ArraySubType = arraySubType
        SafeArraySubType = safeArraySubType
        SizeConst = sizeConst
        SizeParamIndex = sizeParamIndex
    }

    /// Gets the primary (cref:UnmanagedType) override.
    prop UnmanagedType UnmanagedType {
        get;
    }

    /// Gets the per-element (cref:UnmanagedType) for the array
    /// variants ((cref:UnmanagedType.LPArray),
    /// (cref:UnmanagedType.ByValArray)). Null when the user did
    /// not specify `ArraySubType:`.
    prop ArraySubType UnmanagedType? {
        get;
    }

    /// Gets the per-element (cref:VarEnum) for
    /// (cref:UnmanagedType.SafeArray). Null when the user did
    /// not specify `SafeArraySubType:`.
    prop SafeArraySubType VarEnum? {
        get;
    }

    /// Gets the compile-time element count for
    /// (cref:UnmanagedType.ByValArray) /
    /// (cref:UnmanagedType.ByValTStr) / sized
    /// (cref:UnmanagedType.LPArray). Null when not specified.
    prop SizeConst int32? {
        get;
    }

    /// Gets the zero-based parameter index whose value drives the
    /// element count for an (cref:UnmanagedType.LPArray). Null
    /// when not specified.
    prop SizeParamIndex int32? {
        get;
    }

    /// Builds the CLR `FieldMarshal` blob bytes per ECMA-335
    /// II.23.4 for this `@MarshalAs` override. Consumed by the
    /// emitter, which wraps it in a (cref:BlobBuilder) and feeds
    /// it to `MetadataBuilder.AddMarshallingDescriptor`.
    /// @returns The encoded blob bytes (always at least one byte).
    func EncodeFieldMarshalBlob()[]uint8 {
        let bb = BlobBuilder()
        bb.WriteByte(uint8(UnmanagedType))
        switch UnmanagedType {
            case UnmanagedType.LPArray {
                // ECMA-335 II.23.4 — NATIVE_TYPE_ARRAY:
                //   <ArrayElemType> [<ParamNum> [<NumElem> [<flags>]]]
                // ArrayElemType: when not specified, write the
                // CLR-reserved 0x50 (NATIVE_TYPE_MAX, meaning
                // "unspecified") so the runtime falls back to the
                // managed element type.
                bb.WriteByte(uint8((ArraySubType ?? UnmanagedType(0x50))))
                if (SizeParamIndex != nil) && (SizeConst != nil) {
                    bb.WriteCompressedInteger(SizeParamIndex!!)
                    bb.WriteCompressedInteger(SizeConst!!)
                } else if (SizeParamIndex != nil) {
                    bb.WriteCompressedInteger(SizeParamIndex!!)
                } else if (SizeConst != nil) {
                    // ParamNum = 0 placeholder so the runtime reads
                    // NumElem from the next compressed-int slot.
                    bb.WriteCompressedInteger(0)
                    bb.WriteCompressedInteger(SizeConst!!)
                }
            }
            case UnmanagedType.ByValArray {
                // ECMA-335 II.23.4 — NATIVE_TYPE_FIXEDARRAY:
                //   <NumElem> [<ArrayElemType>]
                // SizeConst is mandatory at the binder layer
                // (validated by GS0358); the encoder writes 0 as a
                // defensive fallback when invariants are broken
                // upstream.
                bb.WriteCompressedInteger(SizeConst ?? 0)
                if (ArraySubType != nil) {
                    bb.WriteByte(uint8(ArraySubType!!))
                }
            }
            case UnmanagedType.ByValTStr {
                // ECMA-335 II.23.4 — NATIVE_TYPE_FIXEDSYSSTRING:
                //   <NumElem>
                bb.WriteCompressedInteger(SizeConst ?? 0)
            }
            case UnmanagedType.SafeArray {
                // ECMA-335 II.23.4 — NATIVE_TYPE_SAFEARRAY:
                //   [<VarType>]
                if (SafeArraySubType != nil) {
                    bb.WriteCompressedInteger(int32(SafeArraySubType!!))
                }
            }
            default { }
        }
        return bb.ToArray()
    }
}
