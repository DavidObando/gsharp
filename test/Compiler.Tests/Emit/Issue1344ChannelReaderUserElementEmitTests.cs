// <copyright file="Issue1344ChannelReaderUserElementEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1344: iterating a <c>Channel[UserType].Reader.ReadAllAsync()</c>
/// async sequence erased the user element type to <c>System.Object</c>, so
/// member access on the <c>await for</c> loop variable failed
/// <c>GS0158: Cannot find member</c>. The <c>.Reader</c> property surfaced an
/// erased <c>ChannelReader[object]</c>, whose <c>ReadAllAsync()</c> yields
/// <c>IAsyncEnumerable[object]</c>. The fix keeps the symbolic
/// <c>ChannelReader[UserType]</c> projection (sibling of #1320/#1328), so the
/// stream is <c>IAsyncEnumerable[UserType]</c> and member access binds. These
/// tests compile, IL-verify, and run the issue repro end-to-end.
/// </summary>
public class Issue1344ChannelReaderUserElementEmitTests
{
    // G# erases same-compilation user types used as CLR generic arguments to
    // System.Object on the closed type; surfacing the symbolic ChannelReader[E]
    // projection makes ilverify see ChannelReader`1<object> on the signature
    // but ChannelReader`1<E> on the stack (a verifier-only StackUnexpected the
    // CLR accepts — the tests run the program to prove correctness), mirroring
    // #1088.
    private static readonly string[] ErasureIlVerifyIgnored =
    {
        "StackUnexpected",
    };

    [Fact]
    public void ChannelReaderReadAllAsync_UserElement_BindsAndRuns()
    {
        var source = """
            package P
            import System
            import System.Threading.Channels
            import System.Threading.Tasks

            class Issue1344Entry { var NumEntries int32 = 0 }

            public var total = 0
            async func Consume(ch Channel[Issue1344Entry]) {
                await for messages in ch.Reader.ReadAllAsync() {
                    total = total + messages.NumEntries
                }
            }

            let ch = Channel.CreateUnbounded[Issue1344Entry]()
            var a = Issue1344Entry()
            a.NumEntries = 42
            var wrote = ch.Writer.TryWrite(a)
            var b = Issue1344Entry()
            b.NumEntries = 7
            var wrote2 = ch.Writer.TryWrite(b)
            ch.Writer.Complete()
            Consume(ch).Wait()
            Console.WriteLine(total)
            """;

        Assert.Equal("49\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1344_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
            string Ref(string name) => "/r:" + Path.Combine(runtimeDir, name);

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
                    "/target:exe",
                    "/targetframework:net10.0",
                    Ref("System.Private.CoreLib.dll"),
                    Ref("System.Runtime.dll"),
                    Ref("System.Console.dll"),
                    Ref("System.Collections.dll"),
                    Ref("System.Threading.dll"),
                    Ref("System.Threading.Channels.dll"),
                    Ref("System.Threading.Tasks.dll"),
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath, null, ErasureIlVerifyIgnored);

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
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }
}
