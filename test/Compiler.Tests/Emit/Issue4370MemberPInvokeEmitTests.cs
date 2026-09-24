// <copyright file="Issue4370MemberPInvokeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end emit + ilverify + execute coverage for issue #4370:
/// <c>@LibraryImport</c> (and <c>@DllImport</c>) declared as a class or
/// struct <c>shared</c> member. The <c>@LibraryImport</c> form emits the
/// ADR-0092 pair — a managed outer stub plus a hidden inner PinvokeImpl
/// method — on the DECLARING type. Before the fix the method-row planner only
/// reserved the inner row for package-level functions, so a member
/// declaration crashed gsc with GS9998 (KeyNotFoundException).
/// </summary>
public class Issue4370MemberPInvokeEmitTests
{
    [Fact]
    public void SharedLibraryImport_GetPid_CalledFromSibling_Runs()
    {
        if (!IsLibcCallable())
        {
            return; // skip-not-fail on platforms without libc
        }

        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            partial class Native {
                shared {
                    @LibraryImport("libc", EntryPoint: "getpid")
                    func GetPid() int32;

                    func Call() int32 -> GetPid()
                }
            }

            Console.WriteLine(Native.Call() > 0)
            """;

        Assert.Equal($"True{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void SharedDllImport_GetPid_MatchesSharedLibraryImport()
    {
        if (!IsLibcCallable())
        {
            return;
        }

        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            class Native {
                shared {
                    @DllImport("libc", EntryPoint: "getpid")
                    func GetPidDll() int32;

                    @LibraryImport("libc", EntryPoint: "getpid")
                    func GetPid() int32;
                }
            }

            Console.WriteLine(Native.GetPidDll() > 0)
            Console.WriteLine(Native.GetPidDll() == Native.GetPid())
            """;

        Assert.Equal($"True{Environment.NewLine}True{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void SharedLibraryImport_StringMarshalling_OnStructAndClass_RoundTrips()
    {
        if (!IsLibcCallable())
        {
            return;
        }

        // Utf8 on a class member, and a struct member declared after it so
        // the struct's own method rows follow the class's stub + inner pair.
        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            class Native {
                shared {
                    @LibraryImport("libc", EntryPoint: "strlen", StringMarshalling: StringMarshalling.Utf8)
                    internal func StrLen(s string) nint;
                }
            }

            struct Helper {
                var v int32
                shared {
                    @LibraryImport("libc", EntryPoint: "strlen", StringMarshalling: StringMarshalling.Utf8)
                    private func Len(s string) nint;

                    func Twice(s string) nint -> Len(s) * 2
                }
            }

            Console.WriteLine(Native.StrLen("Hello, world!"))
            Console.WriteLine(Helper.Twice("abc"))
            """;

        Assert.Equal($"13{Environment.NewLine}6{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void SharedLibraryImport_SetLastError_PreservesErrno()
    {
        if (!IsLibcCallable())
        {
            return;
        }

        // close(-1) fails with EBADF (9 on Linux and macOS).
        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            class Native {
                shared {
                    @LibraryImport("libc", EntryPoint: "close", SetLastError: true)
                    func Close(fd int32) int32;
                }
            }

            var rc = Native.Close(-1)
            var err = Marshal.GetLastPInvokeError()
            Console.WriteLine(rc)
            Console.WriteLine(err)
            """;

        Assert.Equal($"-1{Environment.NewLine}9{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void SharedLibraryImport_OverloadsRefOutAndMarshalAs_Run()
    {
        if (!IsLibcCallable())
        {
            return;
        }

        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            class Native {
                shared {
                    @LibraryImport("libc", EntryPoint: "abs")
                    func Abs(@MarshalAs(UnmanagedType.I4) v int32) int32;

                    @LibraryImport("libc", EntryPoint: "labs")
                    func Abs(v int64) int64;

                    @LibraryImport("libc", EntryPoint: "time")
                    func Time(ref t int64) int64;

                    @LibraryImport("libc", EntryPoint: "time")
                    func TimeOut(out t int64) int64;
                }
            }

            class After {
                func Three() int32 -> 3
                shared {
                    func Four() int32 -> 4
                }
            }

            Console.WriteLine(Native.Abs(-7))
            Console.WriteLine(Native.Abs(int64(-9)))
            var t int64 = 0
            var r = Native.Time(ref t)
            Console.WriteLine(r == t && t > 0)
            var t2 int64
            var r2 = Native.TimeOut(out t2)
            Console.WriteLine(r2 == t2)
            Console.WriteLine(After.Four() + After().Three())
            """;

        var nl = Environment.NewLine;
        Assert.Equal($"7{nl}9{nl}True{nl}True{nl}7{nl}", CompileAndRun(source));
    }

    [Fact]
    public void SharedLibraryImport_PointerParameterInUnsafeClass_Runs()
    {
        if (!IsLibcCallable())
        {
            return;
        }

        // Raw pointers are unverifiable by definition, so this one skips
        // ilverify (as every unsafe-code emit test does) and only runs.
        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            unsafe class Native {
                shared {
                    @LibraryImport("libc", EntryPoint: "strlen")
                    private func RawStrLen(p *uint8) nint;

                    func RawLen() nint {
                        var buf = []uint8{65, 66, 67, 0}
                        fixed pB *uint8 = buf {
                            return RawStrLen(pB)
                        }
                    }
                }
            }

            Console.WriteLine(Native.RawLen())
            """;

        Assert.Equal($"3{Environment.NewLine}", CompileAndRun(source, verify: false));
    }

    [Fact]
    public void SharedLibraryImport_EmitsStubAndInnerPInvokeOnDeclaringType()
    {
        const string source = """
            package P
            import System.Runtime.InteropServices

            class Native {
                shared {
                    @LibraryImport("libc", EntryPoint: "strlen", StringMarshalling: StringMarshalling.Utf8, SetLastError: true)
                    internal func MyStrLen(text string) nint;
                }
            }
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_member_libimport_meta_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            CompileOrThrow(srcPath, outPath, target: "library");
            IlVerifier.Verify(outPath);

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();

            var native = md.TypeDefinitions
                .Select(md.GetTypeDefinition)
                .Single(t => md.GetString(t.Name) == "Native");
            var methods = native.GetMethods().Select(md.GetMethodDefinition).ToList();

            var outer = methods.Single(m => md.GetString(m.Name) == "MyStrLen");
            Assert.Equal(0, (int)(outer.Attributes & MethodAttributes.PinvokeImpl));
            Assert.Equal(MethodAttributes.Static, outer.Attributes & MethodAttributes.Static);
            Assert.Equal(MethodAttributes.Assembly, outer.Attributes & MethodAttributes.MemberAccessMask);
            Assert.NotEqual(0, outer.RelativeVirtualAddress);

            var inner = methods.Single(m => md.GetString(m.Name) == "<MyStrLen>g__PInvoke|0_0");
            Assert.Equal(MethodAttributes.PinvokeImpl, inner.Attributes & MethodAttributes.PinvokeImpl);
            Assert.Equal(MethodAttributes.Static, inner.Attributes & MethodAttributes.Static);
            Assert.Equal(MethodAttributes.Private, inner.Attributes & MethodAttributes.MemberAccessMask);

            var import = inner.GetImport();
            Assert.Equal("libc", md.GetString(md.GetModuleReference(import.Module).Name));
            Assert.Equal("strlen", md.GetString(import.Name));
            Assert.Equal(MethodImportAttributes.SetLastError, import.Attributes & MethodImportAttributes.SetLastError);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static bool IsLibcCallable()
        => RuntimeInformation.IsOSPlatform(OSPlatform.Linux)
        || RuntimeInformation.IsOSPlatform(OSPlatform.OSX);

    private static string CompileAndRun(string source, bool verify = true)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_member_pinvoke_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            CompileOrThrow(srcPath, outPath, target: "exe");
            if (verify)
            {
                IlVerifier.Verify(outPath);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi);
            Assert.NotNull(proc);
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static void CompileOrThrow(string srcPath, string outPath, string target)
    {
        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:" + target,
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
    }
}
