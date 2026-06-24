// <copyright file="Issue1033VoidPointerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1033 / ADR-0122 §3: end-to-end emit + execution tests for the true
/// void-element pointer <c>*void</c> (CLR <c>ELEMENT_TYPE_PTR</c> over
/// <c>ELEMENT_TYPE_VOID</c>, the faithful mapping of C# <c>void*</c>) — distinct
/// from the byte pointer <c>*uint8</c>. A <c>*void</c> round-trips through
/// <c>nint</c>/<c>IntPtr</c> and casts to/from typed pointers <c>*T</c>; it
/// cannot be dereferenced/indexed/advanced directly (those are binder errors,
/// covered by the Core binder tests).
/// <para>
/// Genuinely-unsafe pointer code is <em>unverifiable by design</em>; the same
/// inherent-unsafety ilverify codes used by the #1014 tests are tolerated here
/// while still gating on unrelated verification regressions.
/// </para>
/// </summary>
public class Issue1033VoidPointerEmitTests
{
    private static readonly string[] UnsafeIlVerifyIgnored =
    {
        "UnmanagedPointer",
        "StackUnexpected",
        "StackByRef",
        "ExpectedPtr",
        "StackUnexpectedArrayType",
    };

    [Fact]
    public void VoidPointer_RoundTripsThroughNintAndTypedCast_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            unsafe func run() {
                var arr = []int32{123, 0}
                var p = &arr[0]
                var vp = *void(p)
                var addr = nint(vp)
                var vp2 = *void(addr)
                var ip = *int32(vp2)
                Console.WriteLine(*ip)
                ip[1] = 999
                Console.WriteLine(arr[1])
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("123\n999\n", output);
    }

    [Fact]
    public void VoidPointer_Field_EmitsVoidElementPointerSignature()
    {
        var source = """
            package Probe
            import System

            unsafe class Holder {
                var buf *void
            }

            func run() {
                Console.WriteLine("ok")
            }

            run()
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_issue1033_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            CompileOrThrow(srcPath, outPath);

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();

            var found = false;
            foreach (var fh in md.FieldDefinitions)
            {
                var fd = md.GetFieldDefinition(fh);
                if (md.GetString(fd.Name) != "buf")
                {
                    continue;
                }

                found = true;
                var sig = md.GetBlobBytes(fd.Signature);

                // FIELD (0x06), then ELEMENT_TYPE_PTR (0x0F) over
                // ELEMENT_TYPE_VOID (0x01) — a genuine void-element pointer,
                // NOT `PTR U1` (0x0F 0x05) which would be a `*uint8`.
                Assert.Equal(3, sig.Length);
                Assert.Equal(0x06, sig[0]);
                Assert.Equal((byte)SignatureTypeCode.Pointer, sig[1]);
                Assert.Equal((byte)SignatureTypeCode.Void, sig[2]);
            }

            Assert.True(found, "field 'buf' not found in emitted metadata");
        }
        finally
        {
            TryDeleteDir(tempDir);
        }
    }

    private static void CompileOrThrow(string srcPath, string outPath)
    {
        var args = new[]
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
            srcPath,
        };

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(args);
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

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1033_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            CompileOrThrow(srcPath, outPath);

            // Unsafe pointer code is unverifiable by design; tolerate the
            // inherent-unsafety error codes while still gating on other
            // verification regressions.
            IlVerifier.Verify(outPath, null, UnsafeIlVerifyIgnored);

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

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            TryDeleteDir(tempDir);
        }
    }

    private static void TryDeleteDir(string dir)
    {
        try
        {
            Directory.Delete(dir, recursive: true);
        }
        catch
        {
            // ignored
        }
    }
}
