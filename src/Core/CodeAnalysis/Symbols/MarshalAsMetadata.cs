// <copyright file="MarshalAsMetadata.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Reflection.Metadata;
using System.Runtime.InteropServices;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// The resolved per-parameter <c>@MarshalAs(UnmanagedType.…)</c> override
/// attached to a P/Invoke <see cref="ParameterSymbol"/> (ADR-0096 /
/// issue #762). Carries enough state to (a) build the CLR
/// <c>FieldMarshal</c> blob per ECMA-335 II.23.4 and (b) preserve the
/// original syntactic intent for tooling.
/// </summary>
/// <remarks>
/// One instance is attached by <see cref="Binding.PInvokeBinder"/> when
/// the parameter carries a well-formed <c>@MarshalAs</c> annotation;
/// the emitter consumes it to set
/// <see cref="System.Reflection.ParameterAttributes.HasFieldMarshal"/>
/// and to add a row to the <c>FieldMarshal</c> table via
/// <c>MetadataBuilder.AddMarshallingDescriptor</c>.
/// The attribute is <em>pseudo-custom</em> — its data lives entirely
/// in the dedicated metadata table, so the emitter does NOT also write
/// it as a <c>CustomAttribute</c> row (see
/// <see cref="Binding.KnownAttributes.IsPseudoCustomAttribute"/>).
/// </remarks>
public sealed class MarshalAsMetadata
{
    /// <summary>Initializes a new instance of the <see cref="MarshalAsMetadata"/> class.</summary>
    /// <param name="unmanagedType">The primary <see cref="UnmanagedType"/> override.</param>
    /// <param name="arraySubType">For <see cref="UnmanagedType.LPArray"/> / <see cref="UnmanagedType.ByValArray"/>: the per-element <see cref="UnmanagedType"/> (defaults to <see cref="UnmanagedType.AsAny"/> meaning "unspecified" when null).</param>
    /// <param name="safeArraySubType">For <see cref="UnmanagedType.SafeArray"/>: the per-element <see cref="VarEnum"/> (null when not specified).</param>
    /// <param name="sizeConst">For sized arrays / fixed strings: the compile-time element count (null when not specified).</param>
    /// <param name="sizeParamIndex">For <see cref="UnmanagedType.LPArray"/>: the zero-based parameter index whose value is the array element count (null when not specified).</param>
    public MarshalAsMetadata(
        UnmanagedType unmanagedType,
        UnmanagedType? arraySubType = null,
        VarEnum? safeArraySubType = null,
        int? sizeConst = null,
        int? sizeParamIndex = null)
    {
        UnmanagedType = unmanagedType;
        ArraySubType = arraySubType;
        SafeArraySubType = safeArraySubType;
        SizeConst = sizeConst;
        SizeParamIndex = sizeParamIndex;
    }

    /// <summary>Gets the primary <see cref="UnmanagedType"/> override.</summary>
    public UnmanagedType UnmanagedType { get; }

    /// <summary>
    /// Gets the per-element <see cref="UnmanagedType"/> for the array
    /// variants (<see cref="UnmanagedType.LPArray"/>,
    /// <see cref="UnmanagedType.ByValArray"/>). Null when the user did
    /// not specify <c>ArraySubType:</c>.
    /// </summary>
    public UnmanagedType? ArraySubType { get; }

    /// <summary>
    /// Gets the per-element <see cref="VarEnum"/> for
    /// <see cref="UnmanagedType.SafeArray"/>. Null when the user did
    /// not specify <c>SafeArraySubType:</c>.
    /// </summary>
    public VarEnum? SafeArraySubType { get; }

    /// <summary>
    /// Gets the compile-time element count for
    /// <see cref="UnmanagedType.ByValArray"/> /
    /// <see cref="UnmanagedType.ByValTStr"/> / sized
    /// <see cref="UnmanagedType.LPArray"/>. Null when not specified.
    /// </summary>
    public int? SizeConst { get; }

    /// <summary>
    /// Gets the zero-based parameter index whose value drives the
    /// element count for an <see cref="UnmanagedType.LPArray"/>. Null
    /// when not specified.
    /// </summary>
    public int? SizeParamIndex { get; }

    /// <summary>
    /// Builds the CLR <c>FieldMarshal</c> blob bytes per ECMA-335
    /// II.23.4 for this <c>@MarshalAs</c> override. Consumed by the
    /// emitter, which wraps it in a <see cref="BlobBuilder"/> and feeds
    /// it to <c>MetadataBuilder.AddMarshallingDescriptor</c>.
    /// </summary>
    /// <returns>The encoded blob bytes (always at least one byte).</returns>
    public byte[] EncodeFieldMarshalBlob()
    {
        var bb = new BlobBuilder();
        bb.WriteByte((byte)UnmanagedType);
        switch (UnmanagedType)
        {
            case UnmanagedType.LPArray:
                // ECMA-335 II.23.4 — NATIVE_TYPE_ARRAY:
                //   <ArrayElemType> [<ParamNum> [<NumElem> [<flags>]]]
                // ArrayElemType: when not specified, write the
                // CLR-reserved 0x50 (NATIVE_TYPE_MAX, meaning
                // "unspecified") so the runtime falls back to the
                // managed element type.
                bb.WriteByte((byte)(ArraySubType ?? (UnmanagedType)0x50));
                if (SizeParamIndex.HasValue && SizeConst.HasValue)
                {
                    bb.WriteCompressedInteger(SizeParamIndex.Value);
                    bb.WriteCompressedInteger(SizeConst.Value);
                }
                else if (SizeParamIndex.HasValue)
                {
                    bb.WriteCompressedInteger(SizeParamIndex.Value);
                }
                else if (SizeConst.HasValue)
                {
                    // ParamNum = 0 placeholder so the runtime reads
                    // NumElem from the next compressed-int slot.
                    bb.WriteCompressedInteger(0);
                    bb.WriteCompressedInteger(SizeConst.Value);
                }

                break;

            case UnmanagedType.ByValArray:
                // ECMA-335 II.23.4 — NATIVE_TYPE_FIXEDARRAY:
                //   <NumElem> [<ArrayElemType>]
                // SizeConst is mandatory at the binder layer
                // (validated by GS0358); the encoder writes 0 as a
                // defensive fallback when invariants are broken
                // upstream.
                bb.WriteCompressedInteger(SizeConst ?? 0);
                if (ArraySubType.HasValue)
                {
                    bb.WriteByte((byte)ArraySubType.Value);
                }

                break;

            case UnmanagedType.ByValTStr:
                // ECMA-335 II.23.4 — NATIVE_TYPE_FIXEDSYSSTRING:
                //   <NumElem>
                bb.WriteCompressedInteger(SizeConst ?? 0);
                break;

            case UnmanagedType.SafeArray:
                // ECMA-335 II.23.4 — NATIVE_TYPE_SAFEARRAY:
                //   [<VarType>]
                if (SafeArraySubType.HasValue)
                {
                    bb.WriteCompressedInteger((int)SafeArraySubType.Value);
                }

                break;

            default:
                // Bare UnmanagedType: the single byte already written
                // is the entire blob.
                break;
        }

        return bb.ToArray();
    }
}
