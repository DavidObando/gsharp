// file: PInvoke.gs
// ADR-0086 / issue #727: P/Invoke / native interop. Declares a managed
// stub for the POSIX `strlen()` libc function via `@DllImport` and
// prints the length of a fixed string. `strlen` is deterministic and
// available on every supported runtime (libc on Linux/macOS, msvcrt /
// the C runtime forwarder on Windows under `libc` as exposed by .NET).
// The `nint` return type matches the unmanaged `size_t`.

package GSharp.Example.PInvoke

import System
import System.Runtime.InteropServices

// `;` is the no-body marker that flags this declaration as a P/Invoke.
// The library name is the single positional argument; `EntryPoint`
// (named) overrides the unmanaged symbol when it differs from the G#
// identifier; `CharSet` controls how the `string` parameter is
// marshalled into the unmanaged ANSI byte buffer.
@DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
func NativeStrLen(text string) nint;

Console.WriteLine(NativeStrLen("Hello, world!"))

