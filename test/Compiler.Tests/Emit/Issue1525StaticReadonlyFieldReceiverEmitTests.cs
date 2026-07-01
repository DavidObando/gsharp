// <copyright file="Issue1525StaticReadonlyFieldReceiverEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1525 — calling an instance method (or property getter) on a
/// <b>static readonly</b> value-type field emitted <c>ldsflda</c> of the
/// <c>initonly</c> field to obtain the <c>this</c> pointer. Taking the address
/// of an <c>initonly</c> field outside its declaring type-initializer is
/// unverifiable (ilverify <c>InitOnly</c> "Cannot change initonly field outside
/// its .ctor"). The runtime JIT accepts it but the IL is invalid.
/// <para>
/// The fix teaches BOTH mirrored receiver-addressability predicates
/// (<c>MethodBodyEmitter.IsAddressableFieldAccess</c> and
/// <c>ReflectionMetadataEmitter.IsAddressableFieldAccessForReceiverSpill</c>) to
/// treat a static readonly value-type field as NOT addressable outside its
/// declaring type's <c>.cctor</c>, so the existing rvalue-receiver-spill
/// machinery performs a defensive copy (<c>ldsfld; stloc; ldloca; call</c>) —
/// exactly as C# does.
/// </para>
/// Each test uses a UNIQUE package/type name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed.
/// </summary>
public class Issue1525StaticReadonlyFieldReceiverEmitTests
{
    [Fact]
    public void EndToEnd_UserStruct_StaticReadonly_InstanceMethod_VerifiesAndRuns()
    {
        const string source = """
            package i1525userstruct
            import System

            struct Pt1525 { prop X int32   func Plus(d int32) int32 -> X + d }

            class Holder1525 {
                func Compute() int32 -> Holder1525.Origin.Plus(5)
                shared { private let Origin Pt1525 = Pt1525{X: 10} }
            }

            func Main() { System.Console.WriteLine(Holder1525().Compute()) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("15\n", output);
    }

    [Fact]
    public void EndToEnd_UserStruct_StaticReadonly_PropertyGetter_VerifiesAndRuns()
    {
        const string source = """
            package i1525userprop
            import System

            struct Pt1525p { prop X int32 }

            class Holder1525p {
                func Compute() int32 -> Holder1525p.Origin.X
                shared { private let Origin Pt1525p = Pt1525p{X: 42} }
            }

            func Main() { System.Console.WriteLine(Holder1525p().Compute()) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void EndToEnd_FrameworkStruct_DateTimeOffset_StaticReadonly_VerifiesAndRuns()
    {
        // Mirrors the real Oahu HeaderBox.Datum case: a framework value-type
        // (DateTimeOffset) static readonly field used as an instance-method
        // receiver. Today this emits ldsflda of the initonly field (InitOnly).
        const string source = """
            package i1525dto
            import System

            class Holder1525d {
                func Compute() int32 -> Holder1525d.D.AddSeconds(1.0).Second
                shared { private let D DateTimeOffset = DateTimeOffset(2000, 1, 1, 0, 0, 0, System.TimeSpan.Zero) }
            }

            func Main() { System.Console.WriteLine(Holder1525d().Compute()) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n", output);
    }

    [Fact]
    public void EndToEnd_FrameworkStruct_TimeSpan_StaticReadonly_VerifiesAndRuns()
    {
        const string source = """
            package i1525timespan
            import System

            class Holder1525t {
                func Compute() int32 -> Holder1525t.Span.Add(System.TimeSpan(0, 0, 5)).Seconds
                shared { private let Span TimeSpan = System.TimeSpan(0, 0, 10) }
            }

            func Main() { System.Console.WriteLine(Holder1525t().Compute()) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("15\n", output);
    }

    [Fact]
    public void EndToEnd_Enum_StaticReadonly_InstanceMethod_VerifiesAndRuns()
    {
        const string source = """
            package i1525enum
            import System

            enum Color1525 { Red, Green, Blue }

            class HolderEnum1525 {
                func Name() string -> HolderEnum1525.Fav.ToString()
                shared { private let Fav Color1525 = Color1525.Green }
            }

            func Main() { System.Console.WriteLine(HolderEnum1525().Name()) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Green\n", output);
    }

    [Fact]
    public void EndToEnd_Control_MutableStaticValueField_KeepsLdsflda_MutationPersists()
    {
        // A MUTABLE static value-type field must NOT be defensively copied:
        // address-of (ldsflda) is legal and required so a mutating instance
        // method updates the field in place. If the fix wrongly spilled here,
        // the mutations would be discarded and this would print 0.
        const string source = """
            package i1525mutctrl
            import System

            struct Counter1525 { var N int32   func Inc() { N = N + 1 } }

            class HolderMut1525 {
                func Bump() {
                    HolderMut1525.C.Inc()
                    HolderMut1525.C.Inc()
                }
                func Value() int32 -> HolderMut1525.C.N
                shared { var C Counter1525 = Counter1525{N: 0} }
            }

            func Main() {
                let h = HolderMut1525()
                h.Bump()
                System.Console.WriteLine(h.Value())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void EndToEnd_Cctor_SiblingStaticReadonly_AddressLegal_VerifiesAndRuns()
    {
        // Inside the declaring type's synthesized .cctor, taking the address of
        // a sibling static readonly value-type field is legal (ECMA-335), so
        // the exemption keeps ldsflda there and must still verify clean.
        const string source = """
            package i1525cctor
            import System

            struct Pt1525c { prop X int32   func Plus(d int32) int32 -> X + d }

            class HolderC1525 {
                func Get() int32 -> HolderC1525.B
                shared {
                    private let A Pt1525c = Pt1525c{X: 10}
                    private let B int32 = HolderC1525.A.Plus(5)
                }
            }

            func Main() { System.Console.WriteLine(HolderC1525().Get()) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("15\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1525_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
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
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
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
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

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
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
