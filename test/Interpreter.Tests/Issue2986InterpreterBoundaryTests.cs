// <copyright file="Issue2986InterpreterBoundaryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Repl;
using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2986: explicit interpreter native-call boundary (GS0514).
/// ADR-0156 Phase 3a: the interactive cells here pin the LEGACY tree-walking
/// evaluator engine, constructed explicitly as <see cref="SessionEngine"/> —
/// never the interactive default, which is now the emitted engine where
/// P/Invoke runs natively. These evaluator-pinned tests retire with the
/// deprecated <c>--engine evaluator</c> escape hatch in Phase 3c.
/// </summary>
[Collection("ConsoleIo")]
public class Issue2986InterpreterBoundaryTests
{
    [Fact]
    public void PInvokeDeclaration_WithoutUse_IsAllowed()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
            func NativeStrLen(text string) nint;

            Console.WriteLine(33)
            """;
        var engine = new SessionEngine { CaptureConsole = true };

        var cell = engine.Evaluate(source, "pinvoke.gs");

        Assert.Empty(cell.Diagnostics);
        Assert.False(cell.HasError);
        Assert.Equal("33\n", cell.Output);
    }

    [Fact]
    public void PInvokeDirectCall_ReportsLocatedGS0514()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
            func NativeStrLen(text string) nint;

            Console.WriteLine(NativeStrLen("Hello"))
            """;
        var engine = new SessionEngine { CaptureConsole = true };

        var cell = engine.Evaluate(source, "pinvoke.gs");

        var diagnostic = Assert.Single(cell.Diagnostics);
        Assert.True(cell.HasError);
        Assert.Equal("GS0514", diagnostic.Id);
        Assert.Equal(DiagnosticSeverity.Error, diagnostic.Severity);
        Assert.Equal("pinvoke.gs", diagnostic.Location.FileName);
        Assert.Equal(5, diagnostic.Location.StartLine);
        Assert.Contains("NativeStrLen", diagnostic.Message);
        Assert.Contains("'gsc /out:<path>'", diagnostic.Message);
        Assert.Equal(string.Empty, cell.Output);
    }

    [Fact]
    public void PInvokeFunctionValue_ReportsGS0514InsteadOfEvaluatorFailure()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
            func NativeStrLen(text string) nint;

            let f = NativeStrLen
            Console.WriteLine(f("Hello"))
            """;

        var cell = new SessionEngine().Evaluate(source);

        var diagnostic = Assert.Single(cell.Diagnostics);
        Assert.True(cell.HasError);
        Assert.Equal("GS0514", diagnostic.Id);
        Assert.DoesNotContain("IConvertible", diagnostic.Message);
        Assert.Contains("'gsc /out:<path>'", diagnostic.Message);
    }

    [Fact]
    public void PInvokeCallInsideInvokedFunction_ReportsGS0514()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
            func NativeStrLen(text string) nint;

            func CallNative() nint {
                return NativeStrLen("Hello")
            }

            Console.WriteLine(CallNative())
            """;

        var cell = new SessionEngine().Evaluate(source);

        var diagnostic = Assert.Single(cell.Diagnostics);
        Assert.Equal("GS0514", diagnostic.Id);
        Assert.True(cell.HasError);
        Assert.Contains("NativeStrLen", diagnostic.Message);
    }

    [Fact]
    public void PInvokeCallWithRewrittenArgument_ReportsUseLocation()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
            func NativeStrLen(text string) nint;

            func CallNative() nint {
                let text = "Hello"
                let invoke = func() nint { return NativeStrLen(text) }
                return invoke()
            }

            CallNative()
            """;

        var cell = new SessionEngine().Evaluate(source, "capture.gs");

        var diagnostic = Assert.Single(cell.Diagnostics);
        Assert.Equal("GS0514", diagnostic.Id);
        Assert.Equal("capture.gs", diagnostic.Location.FileName);
        Assert.Equal(7, diagnostic.Location.StartLine);
    }

    [Fact]
    public void PInvokeDeclaredInEarlierCell_IsDiagnosedOnlyWhenUsed()
    {
        var engine = new SessionEngine { CaptureConsole = true };
        var declaration = engine.Evaluate(
            """
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
            func NativeStrLen(text string) nint;
            """,
            "declaration.gs");

        var unrelated = engine.Evaluate("Console.WriteLine(33)", "unrelated.gs");
        var use = engine.Evaluate("let f = NativeStrLen", "use.gs");

        Assert.Empty(declaration.Diagnostics);
        Assert.Empty(unrelated.Diagnostics);
        Assert.Equal("33\n", unrelated.Output);
        var diagnostic = Assert.Single(use.Diagnostics);
        Assert.Equal("GS0514", diagnostic.Id);
        Assert.Equal("use.gs", diagnostic.Location.FileName);
    }

    [Theory]
    [InlineData(
        "direct call",
        """
        try {
            Console.WriteLine(NativeStrLen("Hello"))
        } catch (e Exception) {
            Console.WriteLine("caught-22")
        }
        Console.WriteLine("body-33")
        """)]
    [InlineData(
        "method group",
        """
        try {
            let f = NativeStrLen
            Console.WriteLine(f("Hello"))
        } catch (e Exception) {
            Console.WriteLine("caught-22")
        }
        Console.WriteLine("body-33")
        """)]
    [InlineData(
        "lambda call",
        """
        let invoke = func() nint { return NativeStrLen("Hello") }
        try {
            Console.WriteLine(invoke())
        } catch (e Exception) {
            Console.WriteLine("caught-22")
        }
        Console.WriteLine("body-33")
        """)]
    public void PInvokeBoundaryDiagnostic_CannotBeCaught(string _, string body)
    {
        AssertPInvokeUseRejected(body);
    }

    [Fact]
    public void OtherEvaluatorBoundaryDiagnostic_CannotBeCaught()
    {
        var source = """
            import System

            try {
                MemoryExtensions.AsSpan([]int32{11, 22, 33})
            } catch (e Exception) {
                Console.WriteLine("caught-22")
            }
            Console.WriteLine("body-33")
            """;
        var cell = new SessionEngine { CaptureConsole = true }.Evaluate(source, "byreflike.gs");

        var diagnostic = Assert.Single(cell.Diagnostics);
        Assert.Equal("GS0511", diagnostic.Id);
        Assert.Equal("byreflike.gs", diagnostic.Location.FileName);
        Assert.Equal(string.Empty, cell.Output);
    }

    [Theory]
    [InlineData(
        "stored local",
        """
        let f = NativeStrLen
        Console.WriteLine(f("Hello"))
        """)]
    [InlineData(
        "generic wrapper",
        """
        func CallNative[T](value T) nint {
            return NativeStrLen(value.ToString())
        }
        Console.WriteLine(CallNative[string]("Hello"))
        """)]
    [InlineData(
        "LINQ lambda",
        """
        var values = List[string]()
        values.Add("Hello")
        Console.WriteLine(values.Select(func(value string) nint { return NativeStrLen(value) }).First())
        """)]
    public void PInvokeUseShapes_ReportGS0514(string _, string body)
    {
        AssertPInvokeUseRejected(body);
    }

    [Fact]
    public void PInvokeGo_ReportsBeforeFireAndForgetSpawn()
    {
        AssertPInvokeUseRejected(
            """
            go NativeStrLen("Hello")
            Console.WriteLine("body-33")
            """);
    }

    [Fact]
    public void PInvokeGoThroughWrapper_ReportsGS0514()
    {
        var diagnostic = AssertPInvokeUseRejected(
            """
            func CallNative() nint {
                return NativeStrLen("Hello")
            }

            go CallNative()
            Console.WriteLine("body-33")
            """);

        Assert.Equal(9, diagnostic.Location.StartLine);
    }

    [Theory]
    [InlineData(
        "instance method",
        """
        class Holder {
            func CallNative() nint {
                return NativeStrLen("Hello")
            }
        }

        let holder = Holder()
        go holder.CallNative()
        Console.WriteLine("body-33")
        """)]
    [InlineData(
        "constructor",
        """
        class Holder {
            init() {
                NativeStrLen("Hello")
            }
        }

        func CreateHolder() Holder {
            return Holder()
        }

        go CreateHolder()
        Console.WriteLine("body-33")
        """)]
    public void PInvokeGoThroughUserDispatch_ReportsGS0514(string _, string body)
    {
        var diagnostic = AssertPInvokeUseRejected(body);
        Assert.Equal(10, diagnostic.Location.StartLine);
    }

    [Theory]
    [InlineData(
        "instance method",
        """
        class Holder {
            func CallNative() nint {
                return NativeStrLen("Hello")
            }
        }

        let holder = Holder()
        scope {
            go holder.CallNative()
        }
        Console.WriteLine("body-33")
        """)]
    [InlineData(
        "constructor",
        """
        class Holder {
            init() {
                NativeStrLen("Hello")
            }
        }

        func CreateHolder() Holder {
            return Holder()
        }

        scope {
            go CreateHolder()
        }
        Console.WriteLine("body-33")
        """)]
    public void PInvokeScopedGoThroughUserDispatch_ReportsGS0514(string _, string body)
    {
        var diagnostic = AssertPInvokeUseRejected(body);
        Assert.Equal(10, diagnostic.Location.StartLine);
    }

    [Fact]
    public void PInvokeDeclarationWithFreeGo_IsConservativelyRejected()
    {
        var diagnostic = AssertPInvokeUseRejected(
            """
            func Managed() int32 {
                return 33
            }

            go Managed()
            Console.WriteLine("body-33")
            """);

        Assert.Equal(12, diagnostic.Location.StartLine);
        Assert.Contains("NativeStrLen", diagnostic.Message);
    }

    [Fact]
    public void PInvokeGoThroughStoredClosure_ReportsGS0514()
    {
        AssertPInvokeUseRejected(
            """
            let invoke = func() nint { return NativeStrLen("Hello") }

            go invoke()
            Console.WriteLine("body-33")
            """);
    }

    [Fact]
    public void PInvokeGoThroughWrapperInsideScope_ReportsGS0514()
    {
        AssertPInvokeUseRejected(
            """
            func CallNative() nint {
                return NativeStrLen("Hello")
            }

            scope {
                go CallNative()
            }
            Console.WriteLine("body-33")
            """);
    }

    [Fact]
    public void PInvokeInsideStaticInitializer_ReportsLocatedGS0514()
    {
        var source = """
            import System
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
            func NativeStrLen(text string) nint;

            class Holder {
                shared {
                    public var Value int32 = 0
                    init {
                        Console.WriteLine(NativeStrLen("Hello"))
                    }
                }
            }

            Console.WriteLine(Holder.Value)
            """;

        var cell = new SessionEngine { CaptureConsole = true }.Evaluate(source, "static-init.gs");

        var diagnostic = Assert.Single(cell.Diagnostics);
        Assert.True(cell.HasError);
        Assert.Equal("GS0514", diagnostic.Id);
        Assert.Equal("static-init.gs", diagnostic.Location.FileName);
        Assert.Equal(10, diagnostic.Location.StartLine);
        Assert.Contains("NativeStrLen", diagnostic.Message);
        Assert.Equal(string.Empty, cell.Output);
    }

    [Fact]
    public void PInvokeInstanceDispatch_DefensiveGuardReportsGS0514()
    {
        var compilation = new Compilation(
            SyntaxTree.Parse(
                """
                import System.Runtime.InteropServices

                @DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
                func NativeStrLen(text string) nint;

                class Holder {
                    func CallNative() nint {
                        return 0
                    }
                }

                let holder = Holder()
                holder.CallNative()
                """));
        var native = compilation.BoundProgram.Functions.Keys.Single(static f => f.Name == "NativeStrLen");
        var method = compilation.BoundProgram.Functions.Keys.Single(static f => f.Name == "CallNative");
        method.PInvokeMetadata = native.PInvokeMetadata;
        var evaluator = new Evaluator(
            compilation.BoundProgram,
            new Dictionary<VariableSymbol, object>());

        var exception = Assert.Throws<EvaluatorException>(() => evaluator.Evaluate());

        Assert.Equal("GS0514", exception.DiagnosticId);
        Assert.Equal(6, exception.Location?.StartLine);
    }

    /// <summary>
    /// ADR-0156 Phase 1: script-mode <c>gsi</c> executes emitted code, so the
    /// ADR-0152 native-call boundary (GS0514) no longer applies to file mode —
    /// the P/Invoke sample calls straight into libc and prints its golden
    /// output. GS0514 remains an interactive-REPL boundary (tests above).
    /// </summary>
    [Fact]
    public void BatchFileRunner_ExecutesPInvokeNatively()
    {
        if (OperatingSystem.IsWindows())
        {
            // The sample targets POSIX libc; the conformance gate skips it on
            // Windows for the same reason (WindowsSkippedSamples).
            return;
        }

        var pInvokePath = LocateSample("PInvoke.gs");
        var pInvoke = RunBatchFile(pInvokePath);
        Assert.Equal(0, pInvoke.ExitCode);
        Assert.Equal("13\n", pInvoke.StandardOutput.Replace("\r\n", "\n", StringComparison.Ordinal));
        Assert.Equal(string.Empty, pInvoke.StandardError);
    }

    private static (int ExitCode, string StandardOutput, string StandardError) RunBatchFile(string path)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main([path]);
            return (exitCode, stdout.ToString(), stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static Diagnostic AssertPInvokeUseRejected(string body)
    {
        var source = """
            import System
            import System.Collections.Generic
            import System.Linq
            import Gsharp.Extensions.Go
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
            func NativeStrLen(text string) nint;

            """ + body;
        var cell = new SessionEngine { CaptureConsole = true }.Evaluate(source, "use.gs");

        var diagnostic = Assert.Single(cell.Diagnostics);
        Assert.True(cell.HasError);
        Assert.Equal("GS0514", diagnostic.Id);
        Assert.Equal("use.gs", diagnostic.Location.FileName);
        Assert.Equal(string.Empty, cell.Output);
        return diagnostic;
    }

    private static string LocateSample(string fileName)
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
        {
            var path = Path.Combine(directory.FullName, "samples", fileName);
            if (File.Exists(path))
            {
                return path;
            }
        }

        throw new DirectoryNotFoundException($"Could not locate samples/{fileName}.");
    }
}
