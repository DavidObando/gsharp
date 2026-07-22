// <copyright file="Issue2702ConstructedGenericIdentityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2702: a constructed generic nested in a tuple must retain its
/// same-compilation user type argument through dictionary calls and iterator
/// state machines.
/// </summary>
public class Issue2702ConstructedGenericIdentityEmitTests
{
    private static readonly string[] ExactFingerprintPrefixes =
    {
        "0a1d04691fa4",
        "1ea76fca833c",
        "1e6c6a1a86da",
    };

    [Fact]
    public void ExactCliAppFingerprints_ChannelUserTypeThroughTupleDictionaryAndAsyncIterator_VerifyAndRun()
    {
        var source = """
            package Oahu.Cli.App.Jobs

            import System
            import System.Collections.Concurrent
            import System.Collections.Generic
            import System.Threading
            import System.Threading.Channels
            import System.Threading.Tasks

            class JobUpdate {
                var Value int32 = 0
            }

            class JobScheduler {
                private let subscribers ConcurrentDictionary[Guid, Channel[JobUpdate]] = ConcurrentDictionary[Guid, Channel[JobUpdate]]()

                func ObserveAll() IAsyncEnumerable[JobUpdate] {
                    let (ch, key) = RegisterSubscriber()
                    return Drain(ch, key)
                }

                func ObserveAsync() IAsyncEnumerable[JobUpdate] {
                    let (ch, key) = RegisterSubscriber()
                    return Drain(ch, key)
                }

                private func RegisterSubscriber() (Channel[JobUpdate], Guid) {
                    let ch = Channel.CreateUnbounded[JobUpdate]()
                    let key = Guid.NewGuid()
                    subscribers.TryAdd(key, ch)
                    return (ch, key)
                }

                private async func Drain(ch Channel[JobUpdate], key Guid) IAsyncEnumerable[JobUpdate] {
                    try {
                        await for update in ch.Reader.ReadAllAsync() {
                            yield update
                        }
                    } finally {
                        subscribers.TryRemove(key, out _)
                    }
                }

                async func Run() int32 {
                    let (ch, key) = RegisterSubscriber()
                    let stream = Drain(ch, key)
                    var sum = 0
                    let update = JobUpdate()
                    update.Value = 7
                    ch.Writer.TryWrite(update)
                    ch.Writer.Complete()
                    await for update in stream {
                        sum += update.Value
                    }
                    return sum
                }
            }

            Console.WriteLine(JobScheduler().Run().GetAwaiter().GetResult())
            """;

        Assert.Equal("7\n", CompileVerifyAndRun(source, string.Join(", ", ExactFingerprintPrefixes)));
    }

    [Fact]
    public void MismatchedChannelTypeArgument_StillDiagnoses()
    {
        var diagnostics = CompileForDiagnostics("""
            package P
            import System
            import System.Threading.Channels

            class B {}

            func Wrong() {
                let channel Channel[B] = Channel.CreateBounded[int32](BoundedChannelOptions(2))
            }
            """);

        Assert.Contains("GS0155", diagnostics, StringComparison.Ordinal);
    }

    private static string CompileVerifyAndRun(string source, string fingerprintContext)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue2702_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);
            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(stdout);
            Console.SetError(stderr);
            int exitCode;
            try
            {
                var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
                string Reference(string name) => "/reference:" + Path.Combine(runtimeDirectory, name);
                exitCode = Program.Main(new[]
                {
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    Reference("System.Private.CoreLib.dll"),
                    Reference("System.Runtime.dll"),
                    Reference("System.Console.dll"),
                    Reference("System.Collections.dll"),
                    Reference("System.Collections.Concurrent.dll"),
                    Reference("System.Threading.dll"),
                    Reference("System.Threading.Channels.dll"),
                    Reference("System.Threading.Tasks.dll"),
                    sourcePath,
                });
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.True(exitCode == 0, $"compile failed ({exitCode}):\n{stdout}\n{stderr}");
            try
            {
                IlVerifier.Verify(outputPath);
            }
            catch (Xunit.Sdk.XunitException ex)
            {
                throw new Xunit.Sdk.XunitException(
                    $"Exact issue fingerprints must fall from 3 to 0 ({fingerprintContext}).\n{ex.Message}");
            }

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add(outputPath);

            using var process = Process.Start(startInfo)!;
            var output = process.StandardOutput.ReadToEnd();
            var error = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}:\n{error}");
            return output.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(directory, recursive: true); } catch { }
        }
    }

    private static string CompileForDiagnostics(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue2702_negative_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);
            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(stdout);
            Console.SetError(stderr);
            try
            {
                var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
                var exitCode = Program.Main(new[]
                {
                    "/out:" + outputPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    "/reference:" + Path.Combine(runtimeDirectory, "System.Private.CoreLib.dll"),
                    "/reference:" + Path.Combine(runtimeDirectory, "System.Runtime.dll"),
                    "/reference:" + Path.Combine(runtimeDirectory, "System.Threading.Channels.dll"),
                    sourcePath,
                });
                Assert.NotEqual(0, exitCode);
                return stdout.ToString() + stderr;
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }
        }
        finally
        {
            try { Directory.Delete(directory, recursive: true); } catch { }
        }
    }
}
