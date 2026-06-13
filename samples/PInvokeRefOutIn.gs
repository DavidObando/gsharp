// file: PInvokeRefOutIn.gs
// ADR-0094 / issue #760: P/Invoke `ref` / `out` / `in` parameter
// marshalling. The runtime marshals every byref-shaped parameter as a
// managed pointer `T*` to the unmanaged callee, which is exactly what
// libc functions like `time(time_t *)` and `clock_gettime(...,
// struct timespec *)` expect. The pointee type must be blittable —
// a primitive integer/float, `nint`/`nuint`, or a struct annotated
// with `@StructLayout(LayoutKind.Sequential|Explicit)` whose fields are
// all blittable. See ADR-0094 §2 for the full table and the GS0352
// diagnostic that fires when this contract is violated.
//
// The sample exercises two byref patterns side by side:
//   * a primitive scalar out-pointer (`time(time_t *t)`) — the simplest
//     possible byref marshalling shape;
//   * a struct out-pointer (`clock_gettime(int clk_id, struct timespec
//     *tp)`) — proves that a `@StructLayout(LayoutKind.Sequential)`
//     struct is written back through the caller's stack slot.
//
// Output is deterministic: the function returns 0 on success, and the
// out-fields are guaranteed to be positive (current time is past 1970,
// monotonic time is past boot).

package GSharp.Example.PInvokeRefOutIn

import System
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct TimeSpec {
    var tv_sec int64
    var tv_nsec int64
}

@DllImport("libc", EntryPoint: "time")
func native_time(ref t int64) int64;

@DllImport("libc", EntryPoint: "clock_gettime")
func native_clock_gettime(clk_id int32, ref tp TimeSpec) int32;

var t = 0L
var rc1 = native_time(ref t)
Console.WriteLine(rc1 > 0L)
Console.WriteLine(rc1 == t)

var ts = TimeSpec{tv_sec: 0L, tv_nsec: 0L}
var rc2 = native_clock_gettime(0, ref ts)
Console.WriteLine(rc2)
Console.WriteLine(ts.tv_sec > 0L)
