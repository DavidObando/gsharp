// <copyright file="Issue3266InternalErrorSpanTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import CompilerProgram = GSharp.Compiler.Program
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import ReplProgram = GSharp.Repl.Program
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #3266: driver-level GS9998 diagnostics use source anchors carried by
/// compiler exceptions and remain location-less when no anchor exists.
@Collection("ConsoleIo")
open class Issue3266InternalErrorSpanTests {
    @Theory
    @MemberData("AnchoredFailures")
    func Drivers_ReportAnchoredGS9998AtResponsibleConstruct(
        source string,
        construct string,
        startLine int32,
        startCharacter int32,
        endLine int32,
        endCharacter int32,
        exceptionType string,
        message string
    ) {
        let sourceText = SourceText.From(source, "Issue3266.gs")
        let tree = SyntaxTree.Parse(sourceText)
        let anchor = DescendantsAndSelf(tree.Root).First(
            (node SyntaxNode) -> sourceText.ToString(node.Span) == construct
        )
        let innerException Exception = switch exceptionType {
            case "NotSupportedException": cast[Exception](NotSupportedException(message))
            case "InvalidOperationException": cast[Exception](InvalidOperationException(message))
            default: throw ArgumentOutOfRangeException("exceptionType")
        }
        let exception = EmitDiagnosticException(message, anchor, innerException)
        let diagnostic = Compilation.CreateInternalErrorDiagnostic(exception)
        Assert.Equal("GS9998", diagnostic.Id)
        Assert.Equal(startLine, diagnostic.Location.StartLine)
        Assert.Equal(startCharacter, diagnostic.Location.StartCharacter)
        Assert.Equal(endLine, diagnostic.Location.EndLine)
        Assert.Equal(endCharacter, diagnostic.Location.EndCharacter)
        Assert.Equal(construct, diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        let expectedHeader = "Issue3266.gs(${startLine + 1},${startCharacter + 1},${endLine + 1},${endCharacter + 1}): error GS9998: $exceptionType: $message"
        let gsc = Capture(() -> ReportCompilerUnhandledException(exception))
        let gsi = Capture(() -> ReplProgram.ReportUnhandledException(exception))
        Assert.Equal(1, gsc.ExitCode)
        Assert.Contains(expectedHeader, gsc.Stdout, StringComparison.Ordinal)
        Assert.Contains(construct, gsc.Stdout, StringComparison.Ordinal)
        Assert.Empty(gsc.Stderr)
        Assert.Equal(1, gsi.ExitCode)
        Assert.Empty(gsi.Stdout)
        Assert.Contains(expectedHeader, gsi.Stderr, StringComparison.Ordinal)
        Assert.Contains(construct, gsi.Stderr, StringComparison.Ordinal)
    }

    @Fact
    func Drivers_ReportLocationlessGS9998WithoutInventingCoordinates() {
        let exception = InvalidOperationException("no source location")
        let diagnostic = Compilation.CreateInternalErrorDiagnostic(exception)
        let gsc = Capture(() -> ReportCompilerUnhandledException(exception))
        let gsi = Capture(() -> ReplProgram.ReportUnhandledException(exception))
        Assert.Equal("GS9998", diagnostic.Id)
        Assert.Null(diagnostic.Location.Text)
        Assert.Null(diagnostic.Location.FileName)
        Assert.Equal(1, gsc.ExitCode)
        Assert.Contains(
            "error GS9998: InvalidOperationException: no source location",
            gsc.Stdout,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("(1,1,1,1)", gsc.Stdout, StringComparison.Ordinal)
        Assert.Empty(gsc.Stderr)
        Assert.Equal(1, gsi.ExitCode)
        Assert.Empty(gsi.Stdout)
        Assert.Contains(
            "error GS9998: InvalidOperationException: no source location",
            gsi.Stderr,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("(1,1,1,1)", gsi.Stderr, StringComparison.Ordinal)
    }

    shared {
        func AnchoredFailures() sequence[[]object] {
            yield[]object{
                "Console.WriteLine(42)\n",
                "Console.WriteLine(42)",
                0,
                0,
                0,
                21,
                "NotSupportedException",
                "unsupported conversion"
            }
            yield[]object{`func probe() {
    var original = []int32{10, 20, 30}
    let ref r = original[^1]
    Console.WriteLine(r)
}
probe()`, "original[^1]", 2, 16, 2, 28, "InvalidOperationException", "unsupported address"}
        }

        private func DescendantsAndSelf(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for child in node.GetChildren() {
                for descendant in DescendantsAndSelf(child) {
                    yield descendant
                }
            }
        }

        private func ReportCompilerUnhandledException(exception Exception) int32 {
            let method MethodInfo? = typeof(CompilerProgram).GetMethod(
                "ReportUnhandledException",
                BindingFlags.Static | BindingFlags.NonPublic
            )
            Assert.NotNull(method)
            let report = method!!.CreateDelegate[(Exception) -> int32]()
            return report(exception)
        }

        private func Capture(action() -> int32)(ExitCode int32, Stdout string, Stderr string) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = action()
                return (
                    exitCode,
                    stdout.ToString().ReplaceLineEndings(Environment.NewLine),
                    stderr.ToString().ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }
    }
}
