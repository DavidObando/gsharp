// file: PInvokeLibraryImportStringReturn.gs
// issue #1504 / ADR-0092 §2: a `@LibraryImport` function whose RETURN type
// is `string`. Like a `string` parameter, the compiler does NOT rely on a
// runtime marshalling stub — it generates an explicit managed stub whose
// hidden blittable inner P/Invoke returns the raw native pointer, and the
// outer stub materializes the managed `string` via `Marshal.PtrToStringUTF8`
// (UTF-8) or `Marshal.PtrToStringUni` (UTF-16) per `StringMarshalling`.
//
// Ownership: the returned native buffer is treated as NON-OWNING in v1 — the
// native side owns it (as with `getenv`, whose result points into the process
// `environ`), so the stub never frees it. See the ADR-0092 return-marshalling
// table.
//
// This sample sets an environment variable natively via `setenv` (two string
// parameters, marshalled and freed in the stub's `finally`) and reads it back
// via `getenv` (a `string` return), so the round-trip value is deterministic.

package GSharp.Example.PInvokeLibraryImportStringReturn

import System
import System.Runtime.InteropServices

// `int setenv(const char *name, const char *value, int overwrite)` — two
// `string` parameters; `StringMarshalling.Utf8` is required by GS0344.
@LibraryImport("libc", EntryPoint: "setenv", StringMarshalling: StringMarshalling.Utf8)
func SetEnv(name string, value string, overwrite int32) int32;

// `char *getenv(const char *name)` — a `string` parameter AND a `string`
// return marshalled in the same generated stub.
@LibraryImport("libc", EntryPoint: "getenv", StringMarshalling: StringMarshalling.Utf8)
func GetEnv(name string) string;

var rc = SetEnv("GSHARP_LIBIMPORT_RETURN", "round-trip!", 1)
Console.WriteLine(GetEnv("GSHARP_LIBIMPORT_RETURN"))
