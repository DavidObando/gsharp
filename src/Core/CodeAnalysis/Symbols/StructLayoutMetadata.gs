// <copyright file="StructLayoutMetadata.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Runtime.InteropServices

/// The resolved (cref:StructLayoutAttribute)-derived layout for a
/// user struct or class declaration (ADR-0093 / issue #759). The binder
/// attaches one instance to a (cref:StructSymbol) when the type
/// carries a well-formed `@StructLayout(LayoutKind.…)` annotation;
/// the emitter consumes it to pick the right
/// (cref:System.Reflection.TypeAttributes) layout flag and to
/// write a `ClassLayout` row when (cref:Pack) or
/// (cref:Size) is specified.
/// @remarks Only (cref:LayoutKind.Sequential) and (cref:LayoutKind.Explicit)
/// are accepted in v1; (cref:LayoutKind.Auto) is rejected with
/// `GS0346` because Auto-layout types are not portable across the
/// P/Invoke boundary (the CLR is permitted to reorder Auto-layout
/// fields). See ADR-0093 §1 for the full rationale.
///
/// When this metadata is `null`, the emitter falls back to the
/// historical defaults: (cref:LayoutKind.Sequential) for
/// `struct` and (cref:LayoutKind.Auto) for `class`.
data class StructLayoutMetadata : IEquatable[StructLayoutMetadata] {
    /// Initializes a new instance of the (cref:StructLayoutMetadata) class.
    /// @param layout The validated layout kind (Sequential or Explicit).
    /// @param pack The optional `Pack` field; null when unspecified.
    /// @param size The optional `Size` field; null when unspecified.
    init(layout LayoutKind, pack int32?, size int32?) {
        Layout = layout
        Pack = pack
        Size = size
    }

    /// Gets the resolved (cref:LayoutKind) for the declaring type.
    prop Layout LayoutKind {
        get;
    }

    /// Gets the optional `Pack` override (null when unspecified).
    prop Pack int32? {
        get;
    }

    /// Gets the optional `Size` override (null when unspecified).
    prop Size int32? {
        get;
    }
}
