// file: PInvokeFunctionPointer.gs
// ADR-0095 / issue #761: P/Invoke function-pointer marshalling.
//
// Demonstrates both supported shapes for passing a function value
// through the managed/native boundary:
//
//   Shape A — a named delegate type annotated with
//     `@UnmanagedFunctionPointer(CallingConvention.Cdecl)`. The
//     runtime synthesizes a stable C-ABI thunk for the delegate when
//     it is passed to a P/Invoke parameter; the caller is responsible
//     for keeping the delegate alive (rooted) for as long as the
//     native side might call back.
//
//   Shape B — a raw function-pointer type clause
//     `unmanaged[Cdecl] (T1, T2, ...) -> R`. Metadata-encoded as
//     ELEMENT_TYPE_FNPTR; at runtime the value is an address-sized
//     integer (interconvertible with `nint`).
//
// This sample exercises only the bind + emit pipeline — it declares
// both shapes against well-known libc entry points (`qsort` with a
// delegate callback; `dlsym` returning a raw function pointer), then
// proves the comparator-style logic works against an unmanaged buffer
// allocated through `Marshal.AllocHGlobal`. The actual native
// callback round-trip is exercised by the dedicated emit tests
// (`Issue761PInvokeFunctionPointerEmitTests`).

package GSharp.Example.PInvokeFunctionPointer

import System
import System.Runtime.InteropServices

@UnmanagedFunctionPointer(CallingConvention.Cdecl)
type Int64Comparer = delegate func(a nint, b nint) int32

// Shape A — delegate parameter. The CLR marshals `cmp` as a stable
// function pointer with the calling convention specified on the
// delegate's `@UnmanagedFunctionPointer` attribute.
@DllImport("libc", EntryPoint: "qsort")
func native_qsort(base nint, nmemb nint, size nint, cmp Int64Comparer) void;

// Shape B — raw function-pointer return type. `dlsym` returns the
// address of a named entry point; G# encodes the return slot as an
// ELEMENT_TYPE_FNPTR signature blob.
@DllImport("libc", EntryPoint: "dlsym")
func native_dlsym(handle nint, name string) unmanaged[Cdecl] () -> void;

func compareInt64(a nint, b nint) int32 {
    let av = Marshal.ReadInt64(a)
    let bv = Marshal.ReadInt64(b)
    if av < bv {
        return -1
    }
    if av > bv {
        return 1
    }
    return 0
}

let buf = Marshal.AllocHGlobal(16)
Marshal.WriteInt64(buf, 0, 10L)
Marshal.WriteInt64(buf, 8, 7L)
let pa = IntPtr.Add(buf, 0)
let pb = IntPtr.Add(buf, 8)
Console.WriteLine(compareInt64(pa, pb))
Console.WriteLine(compareInt64(pb, pa))
Console.WriteLine(compareInt64(pa, pa))
Marshal.FreeHGlobal(buf)
