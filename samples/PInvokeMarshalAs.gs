// file: PInvokeMarshalAs.gs
// ADR-0096 / issue #762: per-parameter `@MarshalAs(UnmanagedType.…)`
// overrides on P/Invoke declarations. Demonstrates the most common
// shapes:
//
//   * `@MarshalAs(UnmanagedType.LPUTF8Str)` — opts a `string`
//     parameter into UTF-8 marshalling, the modern C-API default
//     (libgit2, libsodium, curl, …). The standard `strlen` libc
//     entry-point happily accepts a UTF-8 null-terminated byte
//     buffer; on a 7-bit-ASCII string the byte count equals the
//     character count.
//
//   * `@MarshalAs(UnmanagedType.LPArray, SizeParamIndex: i)` — opts
//     a `[]T` parameter into the LPArray form where the element
//     count is conveyed by the sibling parameter at index `i`. This
//     is the C idiom of `void f(int *buf, int count)`.
//
//   * `@MarshalAs(UnmanagedType.I4)` on a `bool` parameter — opts
//     the G# `bool` into the 4-byte signed-int unmanaged form,
//     matching the C idiom of `void f(int flag)` for a function
//     that takes an `int` boolean (rather than the Windows
//     4-byte `BOOL`).
//
// The actual native call only goes through for `strlen` since
// libc strlen is reliably available on every platform .NET supports;
// the LPArray and I4 declarations are bind-only and exercised by the
// emit tests in `Issue762MarshalAsEmitTests`.

package GSharp.Example.PInvokeMarshalAs

import System
import System.Runtime.InteropServices

// `@MarshalAs(UnmanagedType.LPUTF8Str)` rejects the implicit ANSI
// encoding the v1 P/Invoke surface picks for `string` and asks the
// runtime to emit a null-terminated UTF-8 byte buffer instead.
@DllImport("libc", EntryPoint: "strlen")
func native_strlen_utf8(@MarshalAs(UnmanagedType.LPUTF8Str) s string) nuint;

// `@MarshalAs(UnmanagedType.LPArray, SizeParamIndex: 2)` tells the
// marshaller that the element count for `src` is the value of the
// sibling parameter at zero-based index `2` (the `n` argument). On
// a real `memcpy` call this prevents the runtime from passing an
// arbitrary chunk of memory past the managed allocation.
@DllImport("libc", EntryPoint: "memcpy")
func native_memcpy(
    dest nint,
    @MarshalAs(UnmanagedType.LPArray, SizeParamIndex: 2) src []int32,
    n nuint) nint;

// `@MarshalAs(UnmanagedType.I4)` widens the G# `bool` to a 4-byte
// signed integer, matching the C idiom of `void f(int flag)`. The
// declaration is bind-only here so the sample is cross-platform.
@DllImport("libfoo", EntryPoint: "set_flag")
func native_set_flag(@MarshalAs(UnmanagedType.I4) on bool) int32;

// Live call: strlen on an ASCII string returns the byte count.
Console.WriteLine(native_strlen_utf8("Hello, world!"))

// Live call: strlen on a UTF-8 string returns the byte count
// (3 bytes for the U+20AC EURO SIGN, 1 byte each for 'a' / 'b').
Console.WriteLine(native_strlen_utf8("a\u20acb"))
