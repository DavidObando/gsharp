// <copyright file="Issue3840DefaultInterfaceMethodBareMemberEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3840 end-to-end: an UNQUALIFIED read/write of the enclosing
/// interface's own property from inside a DEFAULT INTERFACE METHOD body must
/// bind to the implicit <c>this</c> receiver, exactly as the same spelling does
/// in a class body.
/// <para>
/// The implicit-member pseudo-variables the binder seeds into a member body's
/// scope were only ever built for a <see cref="GSharp.Core.CodeAnalysis.Symbols.StructSymbol"/>
/// receiver, so inside a DIM the bare spelling reported GS0125 "Variable 'Name'
/// doesn't exist" while <c>this.Name</c> bound and dispatched correctly — the
/// two spellings disagreed only in an interface.
/// </para>
/// <para>
/// The test EXECUTES the emitted assembly through an implementation that does
/// NOT override the default methods, so the assertions prove the DIM body ran
/// and read the implementation's state (guarding the emitted-session DIM
/// dispatch of #572/#608), not merely that the binder stopped objecting.
/// </para>
/// </summary>
public class Issue3840DefaultInterfaceMethodBareMemberEmitTests
{
    [Fact]
    public void BareInterfaceMemberInsideDefaultMethodBody_VerifiesAndRuns()
    {
        const string Source = """
            package Demo
            import System

            interface IBase {
                prop Name string {
                    get;
                    set;
                }
            }

            interface IGreeter : IBase {
                prop Count int32 {
                    get;
                    set;
                }

                func Tag() string {
                    return "tag"
                }

                // Bare READ of an own property, of an INHERITED interface's
                // property, and of a sibling default method.
                func Greeting() string {
                    return "Hello, " + Name + "! " + Tag()
                }

                // Bare WRITE (own and inherited).
                func Rename(next string) {
                    Name = next
                }

                // Bare COMPOUND write.
                func Bump() {
                    Count += 2
                }

                // Bare name as the HEAD of an accessor chain.
                func Describe() string {
                    return Count.ToString() + "/" + Name.Length.ToString()
                }
            }

            interface IBox[T] {
                prop Value T {
                    get;
                    set;
                }

                func Describe() string {
                    return "box:" + Value.ToString()
                }
            }

            // Neither implementation overrides a default method.
            class Greeter : IGreeter {
                prop Name string {
                    get;
                    set;
                }

                prop Count int32 {
                    get;
                    set;
                }
            }

            class IntBox : IBox[int32] {
                prop Value int32 {
                    get;
                    set;
                }
            }

            let greeter IGreeter = Greeter()
            greeter.Rename("world")
            greeter.Bump()
            greeter.Bump()
            Console.WriteLine(greeter.Greeting())
            Console.WriteLine(greeter.Describe())

            let box IBox[int32] = IntBox()
            box.Value = 41
            Console.WriteLine(box.Describe())
            """;

        var expected = string.Join(
            Environment.NewLine,
            "Hello, world! tag",
            "4/5",
            "box:41") + Environment.NewLine;

        Assert.Equal(expected, CompileVerifyAndRun(Source));
    }

    /// <summary>
    /// Anti-vacuity guard: a bare name inside a DIM that names NOTHING on the
    /// interface must still report GS0125. The fix must not turn the diagnostic
    /// off, only route the names that genuinely resolve.
    /// </summary>
    [Fact]
    public void UnknownBareNameInsideDefaultMethodBody_StillReportsUndefinedVariable()
    {
        const string Source = """
            package Demo

            interface IGreeter {
                prop Name string {
                    get;
                }

                func Greeting() string {
                    return "Hello, " + Nope
                }
            }
            """;

        var (exitCode, output) = Compile(Source);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0125", output, StringComparison.Ordinal);
        Assert.Contains("Nope", output, StringComparison.Ordinal);
    }

    /// <summary>
    /// Anti-vacuity guard: a bare WRITE to a get-only interface property inside
    /// a DIM must report "cannot assign", not silently succeed and not fall back
    /// to GS0125 "doesn't exist".
    /// </summary>
    [Fact]
    public void BareWriteToGetOnlyInterfaceProperty_ReportsCannotAssign()
    {
        const string Source = """
            package Demo

            interface IGreeter {
                prop Name string {
                    get;
                }

                func Rename(next string) {
                    Name = next
                }
            }
            """;

        var (exitCode, output) = Compile(Source);
        Assert.NotEqual(0, exitCode);
        Assert.DoesNotContain("GS0125", output, StringComparison.Ordinal);
        Assert.Contains("Name", output, StringComparison.Ordinal);
    }

    private static (int ExitCode, string Output) Compile(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue3840_").FullName;
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
                var exitCode = Program.Main(new[]
                {
                    "/out:" + outputPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    sourcePath,
                });
                return (exitCode, stdout + stderr.ToString());
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string CompileVerifyAndRun(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue3840_").FullName;
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
                exitCode = Program.Main(new[]
                {
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath,
                });
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.True(exitCode == 0, $"gsc failed:\n{stdout}\n{stderr}");
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

            using var process = Process.Start(startInfo);
            var runtimeOutput = process!.StandardOutput.ReadToEnd();
            var runtimeError = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, $"runtime failed:\n{runtimeOutput}\n{runtimeError}");
            return runtimeOutput.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
