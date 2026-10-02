// <copyright file="Issue4580CapturingRefReturningLocalFunctionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #4580: a CAPTURING ref-returning local function literal is emitted
/// as the <c>Invoke</c> method of a synthesized closure class. That method
/// used to be declared by-value (<c>int32 Invoke(...)</c>) while its body
/// returned a managed pointer (<c>ldelema; ret</c>) and every call site
/// stored the result as one, so the program crashed with an
/// AccessViolationException at run time. Each case compiles, ILVerifies and
/// RUNS the program, asserting stdout byte-for-byte.
/// </summary>
public sealed class Issue4580CapturingRefReturningLocalFunctionTests
{
    [Fact]
    public void ReportedShape_CapturedLocalArrayInClassMethod_WritesThroughAlias()
    {
        const string Source = """
            package Repro

            class C {
                func Run() int32 {
                    var data = []int32{10}
                    let At = func (index int32) ref int32 {
                        return ref data[index]
                    }
                    var ref alias = At(0)
                    alias = 42
                    return data[0]
                }
            }

            Console.WriteLine(C().Run())
            """;

        Assert.Equal("42" + Environment.NewLine, CompileVerifyAndRun(Source));
    }

    [Fact]
    public void CapturedLocal_InTopLevelFunction_WritesThroughAliasAndCallStorage()
    {
        const string Source = """
            package Issue4580Local

            func Run() string {
                var data = []int32{1, 2, 3}
                let At = func (index int32) ref int32 {
                    return ref data[index]
                }
                var ref alias = At(0)
                alias = 40
                At(2) = At(1) + 5
                return "${data[0]},${data[1]},${data[2]}"
            }

            Console.WriteLine(Run())
            """;

        Assert.Equal("40,2,7" + Environment.NewLine, CompileVerifyAndRun(Source));
    }

    [Fact]
    public void CapturedParameter_WritesThroughAlias()
    {
        const string Source = """
            package Issue4580Parameter

            func Run(data []int32) int32 {
                let At = func (index int32) ref int32 {
                    return ref data[index]
                }
                var ref alias = At(1)
                alias = 7
                return data[1] * 10 + data[0]
            }

            Console.WriteLine(Run([]int32{1, 2}))
            """;

        Assert.Equal("71" + Environment.NewLine, CompileVerifyAndRun(Source));
    }

    [Fact]
    public void CapturedThisField_OfClass_WritesThroughAlias()
    {
        const string Source = """
            package Issue4580This

            class Counter {
                var hits int32
                func Bump() int32 {
                    let Slot = func () ref int32 {
                        return ref this.hits
                    }
                    var ref h = Slot()
                    h = h + 5
                    Slot() = Slot() + 1
                    return this.hits
                }
            }

            let c = Counter()
            Console.WriteLine(c.Bump())
            Console.WriteLine(c.Bump())
            """;

        Assert.Equal("6" + Environment.NewLine + "12" + Environment.NewLine, CompileVerifyAndRun(Source));
    }

    [Fact]
    public void NestedLiterals_InnerRefReturningLiteralCapturesOuterLocal()
    {
        const string Source = """
            package Issue4580Nested

            class C {
                func Run() string {
                    var data = []int32{1, 2, 3}
                    let Outer = func (k int32) int32 {
                        let Inner = func (index int32) ref int32 {
                            return ref data[index]
                        }
                        var ref a = Inner(k)
                        a = a * 10
                        return Inner(k)
                    }
                    let r = Outer(2)
                    return "${data[0]},${data[1]},${data[2]};${r}"
                }
            }

            Console.WriteLine(C().Run())
            """;

        Assert.Equal("1,2,30;30" + Environment.NewLine, CompileVerifyAndRun(Source));
    }

    [Fact]
    public void RefReadOnlyReturn_CapturedLocal_ObservesLaterWrites()
    {
        const string Source = """
            package Issue4580ReadOnly

            class C {
                func Run() int32 {
                    var data = []int32{10, 20}
                    let View = func (index int32) ref readonly int32 {
                        return ref data[index]
                    }
                    let ref readonly v = View(1)
                    data[1] = 99
                    return v + View(0)
                }
            }

            Console.WriteLine(C().Run())
            """;

        Assert.Equal("109" + Environment.NewLine, CompileVerifyAndRun(Source));
    }

    [Fact]
    public void StructEncloser_CaptureFreeAndCapturingLiterals_WriteThroughAlias()
    {
        // The capturing literal is emitted as a `<closure_*>` Invoke method
        // nested in the struct, and is the half this test discriminates on.
        // The capture-free literal is a control: it is hosted on
        // `<local_host_*>` as the literal's own function symbol, which
        // already carried the by-ref return before #4580.
        const string Source = """
            package Issue4580Struct

            struct Holder {
                var n int32
                func Run(data []int32) int32 {
                    let At = func (xs []int32, index int32) ref int32 {
                        return ref xs[index]
                    }
                    var ref a = At(data, 0)
                    a = 31
                    return data[0]
                }
                func RunCapturing(data []int32) int32 {
                    let At = func (index int32) ref int32 {
                        return ref data[index]
                    }
                    var ref a = At(0)
                    a = 32
                    return data[0]
                }
            }

            var h = Holder{}
            Console.WriteLine(h.Run([]int32{1}))
            Console.WriteLine(h.RunCapturing([]int32{1}))
            """;

        Assert.Equal("31" + Environment.NewLine + "32" + Environment.NewLine, CompileVerifyAndRun(Source));
    }

    private static string CompileVerifyAndRun(string source)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue4580CapturingRefReturningLocalFunctionTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var sourcePath = Path.Combine(directory, "Program.gs");
            var outputPath = Path.Combine(directory, "Issue4580.dll");
            File.WriteAllText(sourcePath, source);

            var arguments = new List<string>
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            };

            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(stdout);
            Console.SetError(stderr);
            int exitCode;
            try
            {
                exitCode = Program.Main(arguments.ToArray());
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.True(exitCode == 0, $"gsc failed:{Environment.NewLine}{stdout}{stderr}");
            IlVerifier.Verify(outputPath);

            using var process = Process.Start(new ProcessStartInfo("dotnet")
            {
                ArgumentList =
                {
                    "exec",
                    "--runtimeconfig",
                    Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                    outputPath,
                },
                WorkingDirectory = directory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            });
            Assert.NotNull(process);
            var output = process.StandardOutput.ReadToEndAsync();
            var error = process.StandardError.ReadToEndAsync();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            var errorText = error.GetAwaiter().GetResult();
            Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}:{Environment.NewLine}{errorText}");
            return output.GetAwaiter().GetResult().ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            // Best-effort cleanup: a transiently locked file must not turn a
            // passing run red or mask the original assertion failure.
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}
