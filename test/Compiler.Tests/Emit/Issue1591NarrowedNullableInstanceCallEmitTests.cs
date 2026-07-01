// <copyright file="Issue1591NarrowedNullableInstanceCallEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1591 — calling an INSTANCE METHOD on a nullable value-type local that
/// has been smart-cast-narrowed by a null guard (<c>if x == nil { return }</c>)
/// silently emitted IL that read the DEFAULT value of the underlying type
/// instead of the actual stored value. No diagnostic was produced.
/// <para>
/// Root cause: smart-cast narrowing materializes the underlying <c>T</c> via the
/// same <c>!!</c> unwrap lowering as postfix null-assertion. When the unwrapped
/// value was then used as an instance-call receiver, the emitter needed the
/// address of the unwrapped <c>T</c>. The <c>Nullable&lt;T&gt;</c> unwrap scratch
/// slot and the bare-<c>T</c> receiver-address scratch slot were keyed on the
/// SAME <c>BoundUnaryExpression</c> node in <c>receiverSpillSlots</c>, so one
/// slot overwrote the other; the <c>get_Value</c> spill stored the
/// <c>Nullable&lt;T&gt;</c> struct into a <c>T</c>-typed slot and the call read a
/// default-initialized value (<c>0</c> for <c>int32?</c>, the first member for an
/// <c>enum?</c>).
/// </para>
/// The fix keys the unwrap scratch slot on the unwrap's OPERAND node rather than
/// the shared unary/receiver node, keeping the two slots distinct. Each test
/// RUNS the program and asserts the CORRECT runtime output; each uses a UNIQUE
/// package and user-type names because the in-process <c>FunctionTypeSymbol</c>
/// cache is name-keyed and not cleared between in-process emit tests.
/// </summary>
public class Issue1591NarrowedNullableInstanceCallEmitTests
{
    [Fact]
    public void EndToEnd_NarrowedInt32Nullable_ToStringReceiver_Runs()
    {
        const string source = """
            package i1591int32tostring
            import System

            class C1591Int { func G(x int32?) string { if x == nil { return "none" } return x.ToString() } }

            func Main() { System.Console.WriteLine(C1591Int().G(42)) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void EndToEnd_NarrowedInt32Nullable_NilGuardTakesNoneBranch_Runs()
    {
        const string source = """
            package i1591int32none
            import System

            class C1591None { func G(x int32?) string { if x == nil { return "none" } return x.ToString() } }

            func Main() { System.Console.WriteLine(C1591None().G(nil)) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("none\n", output);
    }

    [Fact]
    public void EndToEnd_NarrowedEnumNullable_ToStringReceiver_Runs()
    {
        const string source = """
            package i1591enumtostring
            import System

            enum Hue1591 { Red, Green, Blue }

            class C1591Enum { func G(x Hue1591?) string { if x == nil { return "none" } return x.ToString() } }

            func Main() { System.Console.WriteLine(C1591Enum().G(Hue1591.Green)) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Green\n", output);
    }

    [Fact]
    public void EndToEnd_NarrowedUserStructNullable_InstanceMethodReceiver_Runs()
    {
        const string source = """
            package i1591structmethod
            import System

            struct Box1591 { var v int32
              func Show() string { return v.ToString() } }

            class C1591Struct { func G(x Box1591?) string { if x == nil { return "none" } return x.Show() } }

            func Main() { System.Console.WriteLine(C1591Struct().G(Box1591{v: 7})) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void EndToEnd_NarrowedInt32Nullable_ChainedValueTypeMemberCall_Runs()
    {
        const string source = """
            package i1591chained
            import System

            class C1591Chain { func G(x int32?) string { if x == nil { return "none" } return x.CompareTo(0).ToString() } }

            func Main() { System.Console.WriteLine(C1591Chain().G(42)) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n", output);
    }

    [Fact]
    public void EndToEnd_NarrowedInt32Nullable_OperatorUse_StaysCorrect_Runs()
    {
        // Control: operator use of the narrowed local was already correct on
        // main; it must remain correct after the slot-keying fix.
        const string source = """
            package i1591operator
            import System

            class C1591Op { func G(x int32?) int32 { if x == nil { return -1 } return x + 1 } }

            func Main() { System.Console.WriteLine(C1591Op().G(42)) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("43\n", output);
    }

    [Fact]
    public void EndToEnd_NarrowedInt32Nullable_BareReturn_StaysCorrect_Runs()
    {
        // Control: bare read of the narrowed local was already correct on main.
        const string source = """
            package i1591bare
            import System

            class C1591Bare { func G(x int32?) int32 { if x == nil { return -1 } return x } }

            func Main() { System.Console.WriteLine(C1591Bare().G(42)) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1591_exe_").FullName;
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
