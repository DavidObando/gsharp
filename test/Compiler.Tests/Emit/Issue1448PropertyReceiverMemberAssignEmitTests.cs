// <copyright file="Issue1448PropertyReceiverMemberAssignEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1448 — writing to a member through a bare instance-property receiver
/// (<c>Prop.Member = v</c>, <c>Prop.Member++</c>) crashed emission with GS9998
/// "Variable 'Prop' has no local slot or parameter index in the current
/// method." A bare property receiver resolved to an
/// <c>ImplicitPropertyVariableSymbol</c>, but <c>BindFieldAssignmentExpression</c>
/// synthesized an expression receiver only for the implicit-field case (#689).
/// The fix synthesizes <c>this.Prop</c> (a getter call) as the member-write
/// receiver, mirroring the implicit-field handling and the read-side fix #1339.
/// </summary>
public class Issue1448PropertyReceiverMemberAssignEmitTests
{
    [Fact]
    public void EndToEnd_MemberAssignAndIncrementThroughComputedProperty_Runs()
    {
        var source = """
            package Probe1448a
            import System

            open class Inner1448a {
                prop NextTrackID int32 { get; set; }
            }

            open class Outer1448a {
                private let innerField Inner1448a
                init() { innerField = Inner1448a() }
                prop Mvhd Inner1448a -> innerField

                func Bump() {
                    Mvhd.NextTrackID = 5
                    Mvhd.NextTrackID++
                }
            }

            func Main() {
                let o = Outer1448a()
                o.Bump()
                Console.WriteLine(o.Mvhd.NextTrackID)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("6\n", output);
    }

    [Fact]
    public void EndToEnd_MemberAssignThroughAutoProperty_Runs()
    {
        var source = """
            package Probe1448b
            import System

            open class Leaf1448b {
                prop Value string { get; set; }
            }

            open class Root1448b {
                init() { Child = Leaf1448b() }
                prop Child Leaf1448b { get; init; }

                func SetIt() {
                    Child.Value = "hello"
                }
            }

            func Main() {
                let r = Root1448b()
                r.SetIt()
                Console.WriteLine(r.Child.Value)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hello\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1448_exe_").FullName;
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
