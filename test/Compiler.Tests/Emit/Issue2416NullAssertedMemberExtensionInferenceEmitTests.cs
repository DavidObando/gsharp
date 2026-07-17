// <copyright file="Issue2416NullAssertedMemberExtensionInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2416 end-to-end coverage: compile, IL-verify, and run generic
/// extension calls reached through a null-asserted receiver's member
/// access (e.g. <c>x!!.Member.Ext()</c>), plus a faithful
/// Oahu-BookLibrary-shaped repro (<c>ChapterInfo</c>/<c>Chapter</c> with a
/// recursive <c>[]Chapter</c> and a generic
/// <c>IEnumerable[T]?.IsNullOrEmpty[T]()</c> extension). The pre-fix
/// binder's <c>InferTypeArguments</c> could only unify a slice/array
/// argument against an open CLR interface parameter (like
/// <c>IEnumerable[T]</c>) by reflecting over the argument's real CLR
/// <c>Type</c>; for a same-compilation source struct/class element type
/// that CLR <c>Type</c> doesn't exist pre-emission, so the parameter's
/// type argument was never inferred and the call failed to bind with
/// GS0159 "Cannot find function", regardless of whether the receiver was
/// reached via null-assertion, bare member access, or a for-loop element.
/// The fix adds a symbolic fallback (slice/array <c>ElementType</c>
/// unification against the fixed set of CLR-guaranteed
/// single-type-parameter array interfaces) that needs no CLR
/// <c>Type</c>, so these calls now bind, emit, verify, and run correctly.
/// </summary>
public class Issue2416NullAssertedMemberExtensionInferenceEmitTests
{
    [Fact]
    public void NullAssertedReceiver_ThenMemberAccess_GenericExtension_CompilesAndRuns()
    {
        // The originally-reported broken shape: x!!.Member.Ext() where
        // Ext is a generic extension over an imported open interface
        // (IEnumerable[T]?) and Member's static type is a slice of a
        // same-compilation source struct.
        var source = """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            struct Chapter {
                var Title string
            }

            struct Book {
                var Chapters []Chapter
            }

            func (e IEnumerable[T]?) IsNullOrEmpty[T]() bool {
                return e == nil || e!!.Count() == 0
            }

            var book Book? = Book{ Chapters: []Chapter{} }
            Console.WriteLine(book!!.Chapters.IsNullOrEmpty())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void NullAssertedReceiver_ThenMemberAccess_GenericExtension_NonEmpty_ReturnsFalse()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            struct Chapter {
                var Title string
            }

            struct Book {
                var Chapters []Chapter
            }

            func (e IEnumerable[T]?) IsNullOrEmpty[T]() bool {
                return e == nil || e!!.Count() == 0
            }

            var book Book? = Book{ Chapters: []Chapter{ Chapter{ Title: "One" } } }
            Console.WriteLine(book!!.Chapters.IsNullOrEmpty())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\n", output);
    }

    [Fact]
    public void NullAssertedReceiver_ThenMemberAccess_NonGenericExtension_CompilesAndRuns()
    {
        // Non-generic extension variant: proves the fix to the generic
        // inference routine doesn't regress the (unrelated) non-generic
        // extension-lookup path for the same null-assert-then-member
        // shape.
        var source = """
            package P
            import System

            struct Chapter {
                var Title string
            }

            struct Book {
                var Chapters []Chapter
            }

            func (e []Chapter) IsEmpty() bool {
                return e.Length == 0
            }

            var book Book? = Book{ Chapters: []Chapter{} }
            Console.WriteLine(book!!.Chapters.IsEmpty())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void OahuBookLibraryShape_NullAssertedReceiver_NestedChapters_GenericExtension_CompilesAndRuns()
    {
        // Faithful Oahu.Core BookLibrary shape: ChapterInfo/Chapter mirror
        // the real Oahu.Core.Models.LicenseResponse.cs JSON model — each
        // Chapter recursively carries a []Chapter of nested chapters, and
        // ChapterInfo carries the top-level []Chapter. The real
        // Oahu.Foundation extension is reproduced verbatim:
        //   func (e IEnumerable[T]?) IsNullOrEmpty[T]() bool ->
        //       e == nil || e!!.Count() == 0
        // Both the reported-broken chain
        // (chapterInfo!!.Chapters.IsNullOrEmpty()) and a nested-chapter
        // variant (reaching a chapter's own nested Chapters through a
        // for-loop element, mirroring BookLibrary.gs:766) are exercised.
        var source = """
            package Core
            import System
            import System.Collections.Generic
            import System.Linq

            class Chapter {
                prop Title string
                prop Chapters []Chapter
            }

            class ChapterInfo {
                prop Chapters []Chapter
            }

            func (e IEnumerable[T]?) IsNullOrEmpty[T]() bool {
                return e == nil || e!!.Count() == 0
            }

            func DescribeChapterInfo(info ChapterInfo?) string {
                if info!!.Chapters.IsNullOrEmpty() {
                    return "empty"
                }
                for chapter in info!!.Chapters {
                    if !chapter.Chapters.IsNullOrEmpty() {
                        return "has-nested"
                    }
                }
                return "flat"
            }

            var leaf = Chapter{ Title: "Leaf", Chapters: []Chapter{} }
            var nested = Chapter{ Title: "Nested", Chapters: []Chapter{ leaf } }
            var info = ChapterInfo{ Chapters: []Chapter{ nested } }
            Console.WriteLine(DescribeChapterInfo(info))

            var emptyInfo = ChapterInfo{ Chapters: []Chapter{} }
            Console.WriteLine(DescribeChapterInfo(emptyInfo))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("has-nested\nempty\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2416_emit_").FullName;
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

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
