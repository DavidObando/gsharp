// <copyright file="Issue3266InternalErrorSpanTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;
using CompilerProgram = GSharp.Compiler.Program;
using ReplProgram = GSharp.Repl.Program;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3266: driver-level GS9998 diagnostics use source anchors carried by
/// compiler exceptions and remain location-less when no anchor exists.
/// </summary>
[Collection("ConsoleIo")]
public class Issue3266InternalErrorSpanTests
{
    public static IEnumerable<object[]> AnchoredFailures()
    {
        yield return
        [
            "Console.WriteLine(42)\n",
            "Console.WriteLine(42)",
            0,
            0,
            0,
            21,
            "NotSupportedException",
            "unsupported conversion",
        ];
        yield return
        [
            """
            func probe() {
                var original = []int32{10, 20, 30}
                let ref r = original[^1]
                Console.WriteLine(r)
            }
            probe()
            """,
            "original[^1]",
            2,
            16,
            2,
            28,
            "InvalidOperationException",
            "unsupported address",
        ];
    }

    [Theory]
    [MemberData(nameof(AnchoredFailures))]
    public void Drivers_ReportAnchoredGS9998AtResponsibleConstruct(
        string source,
        string construct,
        int startLine,
        int startCharacter,
        int endLine,
        int endCharacter,
        string exceptionType,
        string message)
    {
        var sourceText = SourceText.From(source, "Issue3266.gs");
        var tree = SyntaxTree.Parse(sourceText);
        var anchor = DescendantsAndSelf(tree.Root)
            .First(node => sourceText.ToString(node.Span) == construct);
        Exception innerException = exceptionType switch
        {
            "NotSupportedException" => new NotSupportedException(message),
            "InvalidOperationException" => new InvalidOperationException(message),
            _ => throw new ArgumentOutOfRangeException(nameof(exceptionType)),
        };
        var exception = new EmitDiagnosticException(message, anchor, innerException);
        var diagnostic = Compilation.CreateInternalErrorDiagnostic(exception);

        Assert.Equal("GS9998", diagnostic.Id);
        Assert.Equal(startLine, diagnostic.Location.StartLine);
        Assert.Equal(startCharacter, diagnostic.Location.StartCharacter);
        Assert.Equal(endLine, diagnostic.Location.EndLine);
        Assert.Equal(endCharacter, diagnostic.Location.EndCharacter);
        Assert.Equal(construct, diagnostic.Location.Text.ToString(diagnostic.Location.Span));

        var expectedHeader =
            $"Issue3266.gs({startLine + 1},{startCharacter + 1},{endLine + 1},{endCharacter + 1}): error GS9998: {exceptionType}: {message}";
        var gsc = Capture(() => ReportCompilerUnhandledException(exception));
        var gsi = Capture(() => ReplProgram.ReportUnhandledException(exception));

        Assert.Equal(1, gsc.ExitCode);
        Assert.Contains(expectedHeader, gsc.Stdout, StringComparison.Ordinal);
        Assert.Contains(construct, gsc.Stdout, StringComparison.Ordinal);
        Assert.Empty(gsc.Stderr);

        Assert.Equal(1, gsi.ExitCode);
        Assert.Empty(gsi.Stdout);
        Assert.Contains(expectedHeader, gsi.Stderr, StringComparison.Ordinal);
        Assert.Contains(construct, gsi.Stderr, StringComparison.Ordinal);
    }

    [Fact]
    public void Drivers_ReportLocationlessGS9998WithoutInventingCoordinates()
    {
        var exception = new InvalidOperationException("no source location");
        var diagnostic = Compilation.CreateInternalErrorDiagnostic(exception);
        var gsc = Capture(() => ReportCompilerUnhandledException(exception));
        var gsi = Capture(() => ReplProgram.ReportUnhandledException(exception));

        Assert.Equal("GS9998", diagnostic.Id);
        Assert.Null(diagnostic.Location.Text);
        Assert.Null(diagnostic.Location.FileName);

        Assert.Equal(1, gsc.ExitCode);
        Assert.Contains("error GS9998: InvalidOperationException: no source location", gsc.Stdout, StringComparison.Ordinal);
        Assert.DoesNotContain("(1,1,1,1)", gsc.Stdout, StringComparison.Ordinal);
        Assert.Empty(gsc.Stderr);

        Assert.Equal(1, gsi.ExitCode);
        Assert.Empty(gsi.Stdout);
        Assert.Contains("error GS9998: InvalidOperationException: no source location", gsi.Stderr, StringComparison.Ordinal);
        Assert.DoesNotContain("(1,1,1,1)", gsi.Stderr, StringComparison.Ordinal);
    }

    private static IEnumerable<SyntaxNode> DescendantsAndSelf(SyntaxNode node)
    {
        yield return node;
        foreach (var child in node.GetChildren())
        {
            foreach (var descendant in DescendantsAndSelf(child))
            {
                yield return descendant;
            }
        }
    }

    private static int ReportCompilerUnhandledException(Exception exception)
    {
        var method = typeof(CompilerProgram).GetMethod(
            "ReportUnhandledException",
            BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(method);
        var report = method.CreateDelegate<Func<Exception, int>>();
        return report(exception);
    }

    private static (int ExitCode, string Stdout, string Stderr) Capture(Func<int> action)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = action();
            return (
                exitCode,
                stdout.ToString().ReplaceLineEndings(Environment.NewLine),
                stderr.ToString().ReplaceLineEndings(Environment.NewLine));
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }
}
