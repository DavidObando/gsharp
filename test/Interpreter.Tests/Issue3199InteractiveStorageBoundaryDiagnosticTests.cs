// <copyright file="Issue3199InteractiveStorageBoundaryDiagnosticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis;
using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>Issue #3199: interactive compiled-only storage boundaries use GS0513.</summary>
public class Issue3199InteractiveStorageBoundaryDiagnosticTests
{
    public static TheoryData<string, string> Boundaries => new()
    {
        {
            """
            import System

            unsafe {
                let values = []int32{11, 22}
                fixed p *int32 = values {
                    Console.WriteLine(*p)
                }
            }
            """,
            "'fixed' (pinning) statements are not supported in the interpreter; they require the CIL pinned-local emit path."
        },
        {
            """
            func run() int32 {
                let values = stackalloc [2]int32
                return values.Length
            }

            run()
            """,
            "stackalloc is not supported in the interpreter; it requires the CIL localloc emit path."
        },
        {
            """
            struct Pair {
                var Left int32
                var Right int32
            }

            unsafe {
                sizeof(Pair)
            }
            """,
            "sizeof on an unmanaged-pointer struct pointee is not supported in the interpreter; it requires the CIL sizeof emit path."
        },
        {
            """
            unsafe func identity(value int32) int32 {
                return value
            }

            unsafe {
                let pointer *func(int32) int32 = &identity
            }
            """,
            "'&Method' function pointers are not supported in the interpreter; they require the CIL ldftn/calli emit path (ADR-0122 §9)."
        },
        {
            """
            unsafe {
                let pointer *func(int32) int32 = nil
                pointer(11)
            }
            """,
            "function-pointer invocation ('fp(args)') is not supported in the interpreter; it requires the CIL calli emit path (ADR-0122 §9)."
        },
    };

    [Theory]
    [MemberData(nameof(Boundaries))]
    public void CompiledOnlyBoundary_ReportsGs0513(string source, string expectedMessage)
    {
        var cell = new SessionEngine { CaptureConsole = true }.Evaluate(source);

        var diagnostic = Assert.Single(cell.Diagnostics);
        Assert.True(cell.HasError);
        Assert.Equal("GS0513", diagnostic.Id);
        Assert.Equal(DiagnosticSeverity.Error, diagnostic.Severity);
        Assert.Equal(expectedMessage, diagnostic.Message);
        Assert.Equal(string.Empty, cell.Output);
    }

    [Fact]
    public void UnexpectedEvaluatorFailure_StillReportsGs9999()
    {
        const string Source = """
            @Flags
            enum Access { None = 0, Read = 1, Write = 2 }

            func choose(x Access) int32 {
                return switch x {
                    case Access.None: 0
                    case Access.Read: 1
                    case Access.Write: 2
                }
            }

            choose(Access.Read | Access.Write)
            """;

        var cell = new SessionEngine { CaptureConsole = true }.Evaluate(Source);

        var diagnostic = Assert.Single(cell.Diagnostics);
        Assert.True(cell.HasError);
        Assert.Equal("GS9999", diagnostic.Id);
        Assert.Equal(DiagnosticSeverity.Error, diagnostic.Severity);
        Assert.Equal("Unmatched switch expression value.", diagnostic.Message);
        Assert.Equal(string.Empty, cell.Output);
    }
}
