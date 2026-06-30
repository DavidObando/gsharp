// file: PInvokeLibraryImport.gs
// ADR-0092 / issue #758: P/Invoke via the source-generator-shaped
// `@LibraryImport` attribute. Unlike `@DllImport`, the compiler does NOT
// rely on a runtime marshalling stub — it generates an explicit managed
// stub that allocates an unmanaged CoTaskMem buffer for each `string`
// parameter (per `StringMarshalling`), calls a hidden blittable inner
// P/Invoke, and frees the buffer in a `finally` block. The IL is fully
// verifiable and AOT-friendly. See ADR-0092 for the full rationale,
// supported marshalling table, and diagnostic surface (GS0342–GS0344).

package GSharp.Example.PInvokeLibraryImport

import System
import System.Runtime.InteropServices

// `;` is the no-body marker that flags this declaration as a P/Invoke.
// `StringMarshalling: StringMarshalling.Utf8` is required by GS0344
// whenever a `string` parameter or return type is present — unlike
// `@DllImport`, `@LibraryImport` does not infer a default encoding.
@LibraryImport("libc", EntryPoint: "strlen", StringMarshalling: StringMarshalling.Utf8)
func NativeStrLen(text string) nuint;

Console.WriteLine(NativeStrLen("Hello, world!"))
