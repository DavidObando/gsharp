// <copyright file="Adr0065ConvenienceInitEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0065 §2 / §5: end-to-end emit tests for convenience initializers,
/// constructor self-delegation, and primary-ctor / explicit-init coexistence.
/// Each test compiles via <c>gsc</c>, runs <c>ilverify</c>, and then executes
/// the produced assembly under <c>dotnet exec</c> to assert behavior.
/// </summary>
public class Adr0065ConvenienceInitEmitTests
{
    [Fact]
    public void ConvenienceInit_DelegatesToDesignated_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            type Rect class {
                var Width int32
                var Height int32
                init(w int32, h int32) {
                    Width = w
                    Height = h
                }
                convenience init(side int32) {
                    init(side, side)
                }
            }

            var r1 = Rect(3, 4)
            var r2 = Rect(5)
            Console.WriteLine(r1.Width)
            Console.WriteLine(r1.Height)
            Console.WriteLine(r2.Width)
            Console.WriteLine(r2.Height)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n4\n5\n5\n", output);
    }

    [Fact]
    public void ConvenienceInit_ChainOfConveniences_CompilesAndRuns()
    {
        // ADR-0065 §2: a convenience init may delegate to another convenience
        // init, which transitively reaches the designated initializer that
        // performs the actual field setup.
        var source = """
            package Probe
            import System

            type HttpClient class {
                var BaseUrl string
                var Timeout int32
                init(baseUrl string, timeout int32) {
                    BaseUrl = baseUrl
                    Timeout = timeout
                }
                convenience init(baseUrl string) {
                    init(baseUrl, 30)
                }
                convenience init() {
                    init("http://localhost")
                }
            }

            var a = HttpClient("https://example", 5)
            var b = HttpClient("https://other")
            var c = HttpClient()
            Console.WriteLine(a.BaseUrl)
            Console.WriteLine(a.Timeout)
            Console.WriteLine(b.BaseUrl)
            Console.WriteLine(b.Timeout)
            Console.WriteLine(c.BaseUrl)
            Console.WriteLine(c.Timeout)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("https://example\n5\nhttps://other\n30\nhttp://localhost\n30\n", output);
    }

    [Fact]
    public void PrimaryCtorWithConvenience_DelegatesToSynthesizedPrimary()
    {
        // ADR-0065 §5: the synthesized primary-ctor init is one of the
        // designated initializers in the overload set. A convenience init may
        // delegate to it via `init(args)`.
        var source = """
            package Probe
            import System

            type LifecycleTab class(Title string, Key string) {
                var Active bool = false
                convenience init(key string) {
                    init(key, key)
                }
            }

            var t1 = LifecycleTab("Settings", "settings")
            var t2 = LifecycleTab("home")
            Console.WriteLine(t1.Title)
            Console.WriteLine(t1.Key)
            Console.WriteLine(t1.Active)
            Console.WriteLine(t2.Title)
            Console.WriteLine(t2.Key)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Settings\nsettings\nFalse\nhome\nhome\n", output);
    }

    [Fact]
    public void PrimaryCtorPlusInitOverload_BothInitializersWork()
    {
        // ADR-0065 §5: primary ctor `(Name string)` AND explicit
        // `init(age int32)` with distinct signatures both compile and are
        // selectable by argument type.
        var source = """
            package Probe
            import System

            type Person class(Name string) {
                var Age int32
                init(age int32) {
                    Age = age
                }
            }

            var byName = Person("Alice")
            var byAge = Person(42)
            Console.WriteLine(byName.Name)
            Console.WriteLine(byAge.Age)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Alice\n42\n", output);
    }

    [Fact]
    public void DesignatedInit_UsingInitDelegation_ReportsError()
    {
        // ADR-0065 §2 / GS0281: only convenience init may use init(args)
        // self-delegation; designated must call base via : base() instead.
        var source = """
            package Probe

            type Bad class {
                var X int32
                init(x int32) {
                    X = x
                }
                init() {
                    init(0)
                }
            }
            """;

        var errors = CompileExpectingErrors(source);
        Assert.True(
            errors.Any(e => e.Contains("GS0281") || e.Contains("designated")),
            $"Expected GS0281: {string.Join("\n", errors)}");
    }

    [Fact]
    public void ConvenienceInit_WithoutDelegation_ReportsError()
    {
        // ADR-0065 §2 / GS0278: a convenience init body must begin with an
        // init(args) self-delegation.
        var source = """
            package Probe

            type Bad class {
                var X int32
                init(x int32) {
                    X = x
                }
                convenience init() {
                    X = 0
                }
            }
            """;

        var errors = CompileExpectingErrors(source);
        Assert.True(
            errors.Any(e => e.Contains("GS0278") || e.Contains("delegate")),
            $"Expected GS0278: {string.Join("\n", errors)}");
    }

    [Fact]
    public void ConvenienceInit_WithBaseClause_ReportsError()
    {
        // ADR-0065 §2 / GS0279: convenience init may not declare ': base()'.
        var source = """
            package Probe

            type Animal open class {
                var Name string
                init(name string) {
                    Name = name
                }
            }

            type Dog class : Animal {
                init(name string) : base(name) {
                }
                convenience init() : base("rex") {
                    init("rex")
                }
            }
            """;

        var errors = CompileExpectingErrors(source);
        Assert.True(
            errors.Any(e => e.Contains("GS0279") || e.Contains("convenience")),
            $"Expected GS0279: {string.Join("\n", errors)}");
    }

    [Fact]
    public void InitDelegation_OutsideCtor_ReportsError()
    {
        // ADR-0065 §2 / GS0280: bare init(args) outside any ctor body is not
        // a valid identifier-call. Falls through to the standard "unknown
        // function" diagnostic since `init` only has special meaning inside
        // a class ctor body.
        var source = """
            package Probe

            type Foo class {
                init() {
                }
            }

            func main() {
                init(1)
            }
            """;

        var errors = CompileExpectingErrors(source);
        // The bare identifier `init` outside a ctor body has no binding;
        // either GS0280 (if we ever surface it from a free-function ctx)
        // or a generic "undefined name" diagnostic is acceptable.
        Assert.NotEmpty(errors);
    }

    [Fact]
    public void ConvenienceInit_OverloadResolution_PicksMatchingSibling()
    {
        // ADR-0065 §2 + ADR-0063 §9: when multiple sibling overloads exist
        // the init(args) call uses arity/type-based overload resolution.
        var source = """
            package Probe
            import System

            type Color class {
                var R int32
                var G int32
                var B int32
                init(r int32, g int32, b int32) {
                    R = r
                    G = g
                    B = b
                }
                init(gray int32) {
                    R = gray
                    G = gray
                    B = gray
                }
                convenience init() {
                    init(0)
                }
            }

            var black = Color()
            var gray = Color(128)
            var red = Color(255, 0, 0)
            Console.WriteLine(black.R)
            Console.WriteLine(gray.G)
            Console.WriteLine(red.R)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n128\n255\n", output);
    }

    // ====================================================================
    // Helpers
    // ====================================================================

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_adr0065_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
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
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

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
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // ignored
            }
        }
    }

    private static System.Collections.Generic.List<string> CompileExpectingErrors(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_adr0065_err_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
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
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded");
            var combined = compileOut.ToString() + compileErr.ToString();
            return combined.Split('\n').Where(l => !string.IsNullOrWhiteSpace(l)).ToList();
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // ignored
            }
        }
    }
}
