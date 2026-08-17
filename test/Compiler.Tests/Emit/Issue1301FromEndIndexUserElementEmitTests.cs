// <copyright file="Issue1301FromEndIndexUserElementEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1301: a from-end index <c>list[^n]</c> (a <c>System.Index</c> /
/// counted <c>this[int]</c> read) over a generic collection whose element type
/// <c>T</c> is a same-compilation user type erased the result element to
/// <c>object</c> (GS0155 / GS0158), even though the normal <c>this[int]</c>
/// path substituted <c>T</c> correctly. These tests pin the fix end-to-end by
/// running the emitted IL and asserting the runtime value read from the
/// user-element member — proving both that the element type is recovered AND
/// that the IL emits correctly. A <c>List[int32]</c> control guards the
/// primitive path against regressions.
/// </summary>
public class Issue1301FromEndIndexUserElementEmitTests
{
    [Fact]
    public void StructElementList_FromEndIndex_ReadsMember()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            struct Chapter { prop EndOffset int32 { get; init; } }

            var l = List[Chapter]()
            l.Add(Chapter{EndOffset: 10})
            l.Add(Chapter{EndOffset: 20})
            l.Add(Chapter{EndOffset: 30})
            Console.WriteLine(l[^1].EndOffset)
            Console.WriteLine(l[^2].EndOffset)
            Console.WriteLine(l[^3].EndOffset)
            """;

        Assert.Equal($"30{Environment.NewLine}20{Environment.NewLine}10{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void StructElementList_FromEndIndex_WholeElementType()
    {
        // The from-end read returns `Chapter` (not `object`), so it can be
        // assigned to a `Chapter`-typed local and have its member read.
        var source = """
            package P
            import System
            import System.Collections.Generic

            struct Chapter { prop EndOffset int32 { get; init; } }

            var l = List[Chapter]()
            l.Add(Chapter{EndOffset: 7})
            l.Add(Chapter{EndOffset: 9})
            var last = l[^1]
            Console.WriteLine(last.EndOffset)
            """;

        Assert.Equal($"9{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void DataStructElementList_FromEndIndex_ReadsMember()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            data struct Point { var X int32
                                var Y int32 }

            var l = List[Point]()
            l.Add(Point{X: 1, Y: 2})
            l.Add(Point{X: 3, Y: 4})
            l.Add(Point{X: 5, Y: 6})
            Console.WriteLine(l[^1].Y)
            Console.WriteLine(l[^2].X)
            """;

        Assert.Equal($"6{Environment.NewLine}3{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void ClassElementList_FromEndIndex_ReadsMember()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Seg { public var X int32 = 0 }

            var a = Seg()
            a.X = 11
            var b = Seg()
            b.X = 22
            var l = List[Seg]()
            l.Add(a)
            l.Add(b)
            Console.WriteLine(l[^1].X)
            Console.WriteLine(l[^2].X)
            """;

        Assert.Equal($"22{Environment.NewLine}11{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void PrimitiveElementList_FromEndIndex_StillWorks()
    {
        // Regression control: the primitive (List[int32]) path is unchanged.
        var source = """
            package P
            import System
            import System.Collections.Generic

            var l = List[int32]()
            l.Add(10)
            l.Add(20)
            l.Add(30)
            Console.WriteLine(l[^1])
            Console.WriteLine(l[^2])
            Console.WriteLine(l[^3])
            """;

        Assert.Equal($"30{Environment.NewLine}20{Environment.NewLine}10{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void IReadOnlyListTypeParameter_FromEndIndex_InfersElementTypeAndUsesInheritedCount()
    {
        // `items[^n]` on an imported generic interface receiver uses BOTH the
        // inherited `Count` candidate (`IReadOnlyCollection[T]`) and the
        // `this[int]` candidate (`IReadOnlyList[T]`). Keep `T` inferred from the
        // G# argument so the result element must round-trip as the user type,
        // not `object`.
        var source = """
            package P
            import System
            import System.Collections.Generic

            class ChapterRef { prop EndOffset int32 { get; init; } }

            func Tail[T any](items IReadOnlyList[T]) T {
                return items[^1]
            }

            func BeforeTail[T any](items IReadOnlyList[T]) T {
                return items[^2]
            }

            var chapters = List[ChapterRef]()
            chapters.Add(ChapterRef{EndOffset: 4})
            chapters.Add(ChapterRef{EndOffset: 9})
            chapters.Add(ChapterRef{EndOffset: 15})

            let items IReadOnlyList[ChapterRef] = chapters
            Console.WriteLine(BeforeTail(items).EndOffset)
            Console.WriteLine(Tail(items).EndOffset)
            """;

        Assert.Equal($"9{Environment.NewLine}15{Environment.NewLine}", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1301_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
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

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
