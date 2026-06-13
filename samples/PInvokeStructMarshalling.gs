// file: PInvokeStructMarshalling.gs
// ADR-0093 / issue #759: P/Invoke struct and class marshalling. Declares
// two blittable G# structs annotated with `@StructLayout(LayoutKind...)`
// and exercises them in pure managed code so the sample runs on any
// supported runtime (libc availability isn't required). The companion
// `PInvoke.gs` and `PInvokeLibraryImport.gs` samples show the matching
// libc round-trip via `strlen`.
//
// The sample illustrates the two layout kinds that v1 P/Invoke supports:
// `Sequential` (the default for blittable structs) and `Explicit` with
// per-field `@FieldOffset(N)` annotations (for C unions). The CLR
// honours the emitted `ClassLayout` / `FieldLayout` metadata rows; that
// the overlapping fields of the explicit-layout struct round-trip as
// expected is the runtime-side verification that the emitter wrote the
// right offsets.

package GSharp.Example.PInvokeStructMarshalling

import System
import System.Runtime.InteropServices

// A blittable struct with the default sequential layout. The G# field
// declaration order matches the C field declaration order, which is the
// portable contract for `struct Point { int x; int y; }`.
@StructLayout(LayoutKind.Sequential)
struct Point {
    var X int32
    var Y int32
}

// A C-style union: two int32 halves overlapping a 64-bit field at the
// same offset. `Size: 8` pins the total footprint.
@StructLayout(LayoutKind.Explicit, Size: 8)
struct LargeInteger {
    @FieldOffset(0) var LowPart uint32
    @FieldOffset(4) var HighPart int32
    @FieldOffset(0) var QuadPart int64
}

var p = Point{X: 3, Y: 4}
Console.WriteLine(p.X)
Console.WriteLine(p.Y)

var v = LargeInteger{LowPart: 0u, HighPart: 0, QuadPart: 0L}
v.LowPart = 0x11223344u
v.HighPart = 0x55667788
Console.WriteLine(v.QuadPart)
