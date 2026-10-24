// Copyright (C) GSharp Authors. All rights reserved.

package Gsharp.Values.FixedArrays.V1

import System.Reflection
import System.Runtime.InteropServices

@assembly: AssemblyMetadata("GSharp.FixedArrayAbi", "1")

/// The empty carrier in the frozen ADR-0210 v1 encoding.
/// @typeparam T The invariant logical element type.
@StructLayout(LayoutKind.Sequential)
struct Empty[T] { }

/// One typed element in the frozen ADR-0210 v1 encoding.
/// @typeparam T The invariant element type.
@StructLayout(LayoutKind.Sequential)
struct Leaf[T] {
    var Item T
}

/// Two value children in the frozen ADR-0210 v1 encoding.
/// @typeparam T The invariant logical element type.
/// @typeparam L The canonical left value child.
/// @typeparam R The canonical right value child.
@StructLayout(LayoutKind.Sequential)
struct Branch[T, L struct, R struct] {
    var Left L
    var Right R
}
