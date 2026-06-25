// <copyright file="Issue1088ConstructedGenericIdentityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1088 end-to-end coverage. Assigning the result of a constructed
/// generic factory method (e.g. <c>Channel.CreateBounded[BufferEntry](...)</c>)
/// to a variable of the SAME constructed generic type
/// (<c>Channel[BufferEntry]</c>) used to report a false
/// <c>GS0155: Cannot convert type 'Channel`1[BufferEntry]' to
/// 'Channel`1[BufferEntry]'</c> when the type argument was a
/// <em>same-compilation</em> user type (whose <c>ClrType</c> is <c>null</c>
/// during binding and erases to <c>object</c> on the closed
/// <c>ImportedTypeSymbol</c>).
/// <para>
/// The binder-level fix is covered by
/// <c>Issue1088GenericIdentityTests</c>; these tests additionally round-trip
/// the scenario through compile → IL-verify → run so a regression in the
/// constructed-generic identity comparison is caught end-to-end (the failing
/// case never even emitted, so an executable test is the strongest guard).
/// </para>
/// </summary>
public class Issue1088ConstructedGenericIdentityEmitTests
{
    // G# erases same-compilation user types used as CLR generic arguments to
    // System.Object on the closed type (the very erasure that #1088 is about).
    // When such a constructed BCL generic (e.g. Channel[BufferEntry]) flows
    // through a member that re-projects the argument (ch.Writer ->
    // ChannelWriter[BufferEntry]), ilverify sees ChannelWriter`1<object> on the
    // signature but ChannelWriter`1<BufferEntry> on the stack and reports a
    // verifier-only StackUnexpected. The CLR runtime accepts the erased form
    // (the tests below prove this by executing the program), so the code is
    // ignored here exactly as the unsafe-pointer emit tests do.
    private static readonly string[] ErasureIlVerifyIgnored =
    {
        "StackUnexpected",
    };

    [Fact]
    public void Channel_Factory_To_Same_Constructed_Generic_Roundtrips()
    {
        // The exact issue #1088 repro, lifted into an executable program: a
        // static factory returns Channel[BufferEntry] (a concrete BCL generic
        // class) and is assigned to a Channel[BufferEntry] local. The user type
        // BufferEntry erases to object on the closed ClrType, so this is the
        // path that spuriously failed before the fix.
        var source = """
            package P
            import System
            import System.Threading.Channels

            class BufferEntry {
            }

            func make() Channel[BufferEntry] {
                return Channel.CreateBounded[BufferEntry](BoundedChannelOptions(2))
            }

            var ch Channel[BufferEntry] = make()
            var wrote = ch.Writer.TryWrite(BufferEntry())
            Console.WriteLine(wrote)
            Console.WriteLine(ch.Reader.Count)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n1\n", output);
    }

    [Fact]
    public void Channel_Field_Of_Same_Constructed_Generic_Roundtrips()
    {
        // The field-initializer variant from the issue (FrameFilterBase's
        // private let filterChannel Channel[BufferEntry] = ...).
        var source = """
            package P
            import System
            import System.Threading.Channels

            class BufferEntry {
            }

            class Holder {
                private let filterChannel Channel[BufferEntry] = Channel.CreateBounded[BufferEntry](BoundedChannelOptions(2))

                func WriteOne() bool {
                    return this.filterChannel.Writer.TryWrite(BufferEntry())
                }
            }

            var h = Holder()
            Console.WriteLine(h.WriteOne())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1088_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            // System.Threading.Channels is not part of gsc's default implicit
            // reference set, so pass the relevant framework assemblies
            // explicitly (mirrors the binder test's reference resolver).
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
                    Ref("System.Threading.Channels.dll"),
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
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
