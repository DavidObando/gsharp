// <copyright file="Issue1617BaseInitializerArgForwardingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1617 (drift 4): <c>EmitClassConstructorWithBaseInitializerBodyBytes</c>
/// (the primary-constructor / forwarding <c>: Base(args)</c> scaffold) forwarded
/// its base-constructor arguments with a plain per-argument
/// <c>emitter.EmitValue(arg)</c> loop, while its sibling
/// <c>EmitClassConstructorWithBodyBodyBytes</c> (explicit <c>init(...)</c> with a
/// base initializer) uses the ref-kind-aware
/// <c>emitter.EmitBaseConstructorArguments(init.Arguments, init.ArgumentRefKinds)</c>.
/// This test locks the forwarding behavior of the primary-ctor scaffold now that
/// both scaffolds share the ref-kind-aware helper.
/// <para>
/// NOTE: this drift is <b>latent</b> — it produces no observable behavioral
/// difference on current G#. By-reference (<c>ref</c>/<c>out</c>/<c>in</c>) base
/// arguments are only ever bound (with populated <c>ArgumentRefKinds</c>) for a
/// CLR base whose constructor declares a by-ref parameter, and G# requires an
/// explicit <c>&amp;</c>/<c>ref</c> at the call site, producing a
/// <c>BoundAddressOfExpression</c> that <c>EmitValue</c>/<c>EmitExpression</c>
/// already lowers to the same address IL that <c>EmitBaseConstructorArguments</c>
/// emits. No G#-expressible base-initializer forwards a by-ref argument through
/// this primary-ctor scaffold, so the two code paths were behaviorally
/// equivalent. The fix removes the textual drift (required so the Step-2
/// scaffold unification is byte-identical) and makes any future by-ref base-arg
/// support automatically cover this scaffold. This test therefore passes both
/// before and after the fix; it guards the by-value forwarding path.
/// </para>
/// Uses a UNIQUE package/type name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed.
/// </summary>
public class Issue1617BaseInitializerArgForwardingEmitTests
{
    [Fact]
    public void EndToEnd_PrimaryCtorClass_ForwardsBaseArgsToClrBase_Runs()
    {
        const string source = """
            package i1617baseinit
            import System

            class Wrapped1617(msg string, inner Exception) : Exception(msg, inner) { }

            func Main() {
                var root = System.InvalidOperationException("root-1617")
                var w = Wrapped1617("outer-1617", root)
                System.Console.WriteLine(w.Message)
                System.Console.WriteLine(w.InnerException.Message)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("outer-1617\nroot-1617\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1617baseinit_exe_").FullName;
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
