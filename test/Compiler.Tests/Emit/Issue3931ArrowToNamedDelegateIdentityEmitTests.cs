// <copyright file="Issue3931ArrowToNamedDelegateIdentityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3931: an arrow function type and the CLR delegate it is represented
/// by are two spellings of ONE type — <c>(int32) -&gt; void</c> is
/// <c>System.Action&lt;int&gt;</c>, and <c>async (CancellationToken) -&gt; void</c>
/// is <c>System.Func&lt;CancellationToken, Task&gt;</c>. The emitter used to
/// treat the arrow → named spelling as a delegate-to-delegate *adaptation*
/// and re-wrap the value in a fresh delegate over its own <c>Invoke</c>. That
/// was wrong three ways: a pointless allocation, a broken reference identity,
/// and — the way it actually bit — <c>newobj Delegate::.ctor</c> throws
/// <c>ArgumentException("Delegate to an instance method cannot have null
/// 'this'")</c> when the source delegate is null, so reading an unset
/// delegate field into an <c>Action</c>/<c>Func</c>-typed local crashed.
///
/// The crash is invisible when it happens on a fire-and-forget thread-pool
/// task: the task faults, nobody observes it, and whatever the task was going
/// to signal never gets signalled. That is exactly how it presented — as the
/// migrated language server never completing a push-diagnostics bind, which
/// left an unbounded <c>await</c> in its test suite hanging forever.
///
/// These tests execute the emitted program; a binding-only assertion would
/// not have caught any of this.
/// </summary>
public class Issue3931ArrowToNamedDelegateIdentityEmitTests
{
    [Fact]
    public void NullArrowTypedField_ReadIntoNamedClrDelegateLocal_StaysNullInsteadOfThrowing()
    {
        var source = """
            package Issue3931Pkg
            import System
            import System.Threading
            import System.Threading.Tasks

            class Hooks {
                internal var OnThing (int32) -> void
                internal var Delay async (CancellationToken) -> void
            }

            let hooks = Hooks()
            let act Action[int32]? = hooks.OnThing
            let delay Func[CancellationToken, Task]? = hooks.Delay
            Console.WriteLine("act nil: " + (act == nil).ToString())
            Console.WriteLine("delay nil: " + (delay == nil).ToString())
            """;

        var (exitCode, stdout, stderr) = CompileAndRun(source);
        Assert.Equal(string.Empty, stderr);
        Assert.Equal(0, exitCode);
        Assert.Equal(
            $"act nil: True{Environment.NewLine}delay nil: True{Environment.NewLine}",
            stdout);
    }

    [Fact]
    public void NonNullArrowTypedField_ReadIntoNamedClrDelegateLocal_KeepsReferenceIdentityAndInvokes()
    {
        var source = """
            package Issue3931Pkg
            import System
            import System.Threading
            import System.Threading.Tasks

            class Hooks {
                internal var OnThing (int32) -> void
                internal var Delay async (CancellationToken) -> void
            }

            let hooks = Hooks()
            hooks.OnThing = (x int32) -> { Console.WriteLine("act " + x.ToString()) }
            hooks.Delay = async (ct CancellationToken) -> { await Task.Delay(1, ct) }

            let act Action[int32] = hooks.OnThing
            act(7)
            Console.WriteLine("act same: " + object.ReferenceEquals(act, hooks.OnThing).ToString())

            let delay Func[CancellationToken, Task] = hooks.Delay
            delay(CancellationToken.None).GetAwaiter().GetResult()
            Console.WriteLine("delay same: " + object.ReferenceEquals(delay, hooks.Delay).ToString())
            """;

        var (exitCode, stdout, stderr) = CompileAndRun(source);
        Assert.Equal(string.Empty, stderr);
        Assert.Equal(0, exitCode);
        Assert.Equal(
            $"act 7{Environment.NewLine}act same: True{Environment.NewLine}delay same: True{Environment.NewLine}",
            stdout);
    }

    /// <summary>
    /// The identity shortcut must not swallow a genuine adaptation: a
    /// variance-adapted target (<c>() -&gt; string</c> into
    /// <c>Func[object]</c>) is a different CLR delegate type and still needs
    /// the re-wrap.
    /// </summary>
    [Fact]
    public void VarianceAdaptedTarget_StillWrapsAndInvokes()
    {
        var source = """
            package Issue3931Pkg
            import System

            let produce () -> string = () -> "hi"
            let boxed Func[object] = produce
            Console.WriteLine(boxed().ToString()!!)
            """;

        var (exitCode, stdout, stderr) = CompileAndRun(source);
        Assert.Equal(string.Empty, stderr);
        Assert.Equal(0, exitCode);
        Assert.Equal($"hi{Environment.NewLine}", stdout);
    }

    /// <summary>
    /// A fire-and-forget <c>Task.Run</c> body that reads an unset hook into a
    /// <c>Func[...]</c> local is the exact shape that hung the migrated
    /// language server: the wrap threw, the task faulted unobserved, and the
    /// completion the caller was waiting on never arrived.
    /// </summary>
    [Fact]
    public void FireAndForgetTaskReadingUnsetHook_CompletesInsteadOfFaultingUnobserved()
    {
        var source = """
            package Issue3931Pkg
            import System
            import System.Threading
            import System.Threading.Tasks

            class Server {
                internal var TestDelay async (CancellationToken) -> void
                private let done TaskCompletionSource[bool] = TaskCompletionSource[bool](
                    TaskCreationOptions.RunContinuationsAsynchronously)

                func Schedule() Task[bool] {
                    let _ = Task.Run(async () -> {
                        let delay Func[CancellationToken, Task]? = this.TestDelay
                        if delay != nil {
                            await delay(CancellationToken.None).ConfigureAwait(false)
                        } else {
                            await Task.Delay(1).ConfigureAwait(false)
                        }
                        this.done.TrySetResult(true)
                    })
                    return this.done.Task
                }
            }

            let server = Server()
            let signalled = server.Schedule().Wait(TimeSpan.FromSeconds(10))
            Console.WriteLine("signalled: " + signalled.ToString())
            """;

        var (exitCode, stdout, stderr) = CompileAndRun(source);
        Assert.Equal(string.Empty, stderr);
        Assert.Equal(0, exitCode);
        Assert.Equal($"signalled: True{Environment.NewLine}", stdout);
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRun(string source)
    {
        var tempDir = Path.Combine(AppContext.BaseDirectory, "Issue3931_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new System.Collections.Generic.List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
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
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();

            return (proc.ExitCode, stdout.ReplaceLineEndings(Environment.NewLine), stderr.ReplaceLineEndings(Environment.NewLine));
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
}
