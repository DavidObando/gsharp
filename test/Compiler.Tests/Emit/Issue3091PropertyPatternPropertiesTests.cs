// <copyright file="Issue3091PropertyPatternPropertiesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Runtime and ILVerify coverage for issue #3091.</summary>
public sealed class Issue3091PropertyPatternPropertiesTests
{
    [Fact]
    public void IssueRepro_PropertiesAndNestedNullableProperty_ReturnOneTwoZero()
    {
        const string Source = """
            package Issue3091
            import System
            import System.Collections.Generic

            class Message {
                prop Role string { get; init; }
                prop Calls IReadOnlyList[string]? { get; init; }
            }

            func Classify(message Message) int32 {
                return switch message {
                    case { Role: "tool" }: 1
                    case { Calls: { Count: > 0 } }: 2
                    default: 0
                }
            }

            let calls = List[string]()
            calls.Add("invoke")
            Console.WriteLine(Classify(Message{Role: "tool", Calls: nil}))
            Console.WriteLine(Classify(Message{Role: "assistant", Calls: calls}))
            Console.WriteLine(Classify(Message{Role: "assistant", Calls: nil}))
            """;

        Assert.Equal($"1{Environment.NewLine}2{Environment.NewLine}0{Environment.NewLine}", CompileAndRun(Source));
    }

    [Fact]
    public void GetterDispatchSingleEvaluationAndNullShortCircuit_VerifyAndRun()
    {
        const string Source = """
            package Issue3091.Semantics
            import System

            class Counter {
                shared {
                    var Reads int32
                }
            }

            open class BaseProbe {
                open prop Value int32 {
                    get {
                        Counter.Reads += 1
                        return 1
                    }
                }
            }

            class DerivedProbe : BaseProbe {
                override prop Value int32 {
                    get {
                        Counter.Reads += 1
                        return 5
                    }
                }
            }

            struct Payload {
                prop Count int32 { get -> 2 }
            }

            class Holder {
                prop Child BaseProbe? { get; init; }
                prop Item Payload? { get; init; }
            }

            func MatchProbe(value BaseProbe) int32 {
                return switch value {
                    case { Value: > 0 and < 10 }: 1
                    default: 0
                }
            }

            func MatchHolder(value Holder) int32 {
                return switch value {
                    case { Child: { Value: > 0 } }: 1
                    default: 0
                }
            }

            func MatchDiscard(value BaseProbe) int32 {
                return switch value {
                    case { Value: _ }: 1
                    default: 0
                }
            }

            func MatchPayload(value Holder) int32 {
                return switch value {
                    case { Item: { Count: 2 } }: 1
                    default: 0
                }
            }

            Console.WriteLine(MatchProbe(DerivedProbe{}))
            Console.WriteLine(Counter.Reads)
            Console.WriteLine(MatchDiscard(DerivedProbe{}))
            Console.WriteLine(Counter.Reads)
            Console.WriteLine(MatchHolder(Holder{Child: nil, Item: nil}))
            Console.WriteLine(Counter.Reads)
            Console.WriteLine(MatchPayload(Holder{Child: nil, Item: Payload{}}))
            Console.WriteLine(MatchPayload(Holder{Child: nil, Item: nil}))
            """;

        Assert.Equal($"1{Environment.NewLine}1{Environment.NewLine}1{Environment.NewLine}2{Environment.NewLine}0{Environment.NewLine}2{Environment.NewLine}1{Environment.NewLine}0{Environment.NewLine}", CompileAndRun(Source));
    }

    private static string CompileAndRun(string source)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3091PropertyPatternPropertiesTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var previousOut = Console.Out;
            var previousErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int exitCode;
            try
            {
                exitCode = Program.Main(
                [
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath,
                ]);
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousErr);
            }

            Assert.True(
                exitCode == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            IlVerifier.Verify(outputPath);

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"));
            startInfo.ArgumentList.Add(outputPath);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start dotnet exec.");
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
            Assert.True(
                process.ExitCode == 0,
                $"exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
