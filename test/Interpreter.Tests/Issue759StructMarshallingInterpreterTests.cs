// <copyright file="Issue759StructMarshallingInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0093 / issue #759: interpreter coverage for struct- and
/// class-marshalling annotations. The G# interpreter does not call into
/// native code, so the layout annotations are essentially "binder-only"
/// metadata under the REPL. The acceptance contract:
/// <list type="bullet">
/// <item>Well-formed <c>@StructLayout</c> / <c>@FieldOffset</c> programs
/// parse, bind, and run without diagnostics or crashes.</item>
/// <item>Ill-formed annotations surface the same GS0346–GS0351 diagnostics
/// the compiler emits.</item>
/// </list>
/// </summary>
public class Issue759StructMarshallingInterpreterTests
{
    [Fact]
    public void Blittable_SequentialLayout_Struct_Binds_And_Runs_In_Interpreter()
    {
        var source = """
            import System.Runtime.InteropServices

            @StructLayout(LayoutKind.Sequential)
            struct Point {
                var X int32
                var Y int32
            }

            var p = Point{X: 3, Y: 4}
            Console.WriteLine(p.X)
            Console.WriteLine(p.Y)
            """;

        var output = RunSubmission(source);
        Assert.Contains("3", output);
        Assert.Contains("4", output);
        Assert.DoesNotContain("GS0346", output);
        Assert.DoesNotContain("GS0347", output);
        Assert.DoesNotContain("GS0348", output);
        Assert.DoesNotContain("GS0349", output);
        Assert.DoesNotContain("GS0350", output);
        Assert.DoesNotContain("GS0351", output);
    }

    [Fact]
    public void Explicit_StructLayout_With_FieldOffsets_Binds_In_Interpreter()
    {
        var source = """
            import System.Runtime.InteropServices

            @StructLayout(LayoutKind.Explicit, Size: 8)
            struct LargeInteger {
                @FieldOffset(0) var LowPart uint32
                @FieldOffset(4) var HighPart int32
                @FieldOffset(0) var QuadPart int64
            }

            Console.WriteLine("bound")
            """;

        var output = RunSubmission(source);
        Assert.Contains("bound", output);
        Assert.DoesNotContain("GS0346", output);
        Assert.DoesNotContain("GS0347", output);
        Assert.DoesNotContain("GS0348", output);
        Assert.DoesNotContain("GS0350", output);
    }

    [Fact]
    public void Auto_LayoutKind_Reports_GS0346_Under_Interpreter()
    {
        var source = """
            import System.Runtime.InteropServices

            @StructLayout(LayoutKind.Auto)
            struct Bad {
                var X int32
            }
            """;

        var output = RunSubmission(source);
        Assert.Contains("GS0346", output);
    }

    [Fact]
    public void FieldOffset_On_Sequential_Reports_GS0348_Under_Interpreter()
    {
        var source = """
            import System.Runtime.InteropServices

            @StructLayout(LayoutKind.Sequential)
            struct Bad {
                @FieldOffset(0) var X int32
                @FieldOffset(4) var Y int32
            }
            """;

        var output = RunSubmission(source);
        Assert.Contains("GS0348", output);
    }

    [Fact]
    public void NonBlittable_Struct_In_PInvoke_Reports_GS0349_Under_Interpreter()
    {
        var source = """
            import System.Runtime.InteropServices

            @StructLayout(LayoutKind.Sequential)
            struct Bad {
                var Name string
            }

            @DllImport("libc", EntryPoint: "nope")
            func Nope(arg Bad) int32;
            """;

        var output = RunSubmission(source);
        Assert.Contains("GS0349", output);
    }

    private static string RunSubmission(string text)
    {
        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(text);
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        return outWriter.ToString();
    }
}
