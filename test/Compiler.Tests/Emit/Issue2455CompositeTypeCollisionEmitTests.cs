// <copyright file="Issue2455CompositeTypeCollisionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2455 end-to-end emit coverage: the exact Oahu shape — two sibling
/// packages each declaring a top-level <c>ChapterInfo</c> type
/// (<c>Oahu.Audible.Json.ChapterInfo</c> with <c>Chapters []Chapter</c>, and
/// <c>Oahu.BooksDatabase.ChapterInfo</c> with a structurally incompatible
/// <c>ICollection[Chapter]</c> member), a third package (<c>Oahu.Core</c>)
/// that imports ONLY the Audible sibling and declares
/// <c>ContentMetadata{ prop ChapterInfo ChapterInfo }</c>, and an
/// <c>AaxExporter</c> whose <c>Export(ci ChapterInfo) ContentMetadata</c>
/// constructs <c>ContentMetadata{ChapterInfo: ci, ...}</c> via composite
/// literal. Before the fix, <c>BoundScope</c>'s "first declared wins" plain
/// simple-key alias table could resolve <c>ContentMetadata.ChapterInfo</c>'s
/// declared type against the WRONG sibling package (an artifact of
/// syntax-tree array order), misfiring GS0490 (StructuralProjectionFailure).
/// <para>
/// These tests compile the exact shape end-to-end (gsc in-process invocation
/// + ILVerify + <c>dotnet exec</c> run), covering both declaration orders for
/// order-independence, and additionally reflect the emitted assembly via
/// <see cref="MetadataLoadContext"/> to assert
/// <c>ContentMetadata.ChapterInfo</c>'s exact declared CLR type is
/// <c>Oahu.Audible.Json.ChapterInfo</c> — never the sibling
/// <c>Oahu.BooksDatabase.ChapterInfo</c> — regardless of source order.
/// </para>
/// </summary>
public class Issue2455CompositeTypeCollisionEmitTests
{
    private const string AudibleChapterInfoGs = """
        package Oahu.Audible.Json

        class ChapterInfo {
            prop Chapters []Chapter
        }

        class Chapter {
            prop Title string
        }
        """;

    private const string BooksDatabaseChapterInfoGs = """
        package Oahu.BooksDatabase
        import System.Collections.Generic

        class ChapterInfo {
            prop Chapters ICollection[Chapter]
        }

        class Chapter {
            prop Name string
        }
        """;

    private const string ContentMetadataGs = """
        package Oahu.Core
        import Oahu.Audible.Json

        class ContentMetadata {
            prop ChapterInfo ChapterInfo
            prop Title string
        }
        """;

    private const string AaxExporterGs = """
        package Oahu.Core
        import Oahu.Audible.Json
        import System

        class AaxExporter {
            func Export(ci ChapterInfo, title string) ContentMetadata {
                return ContentMetadata{ChapterInfo: ci, Title: title}
            }

            func Describe(cm ContentMetadata) {
                Console.WriteLine(cm.Title)
                Console.WriteLine(cm.ChapterInfo.Chapters.Length.ToString())
                Console.WriteLine(cm.ChapterInfo.Chapters[0].Title)
            }
        }

        func Main() {
            var chapters = []Chapter { Chapter{Title: "Prologue"} }
            var ci = Oahu.Audible.Json.ChapterInfo{Chapters: chapters}
            var exporter = AaxExporter{}
            var cm = exporter.Export(ci, "My Audiobook")
            exporter.Describe(cm)
        }
        """;

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ExactOahuShape_CompositeLiteralProjection_CompilesIlVerifiesAndRuns_OrderIndependent(bool audibleTreeFirst)
    {
        var sources = audibleTreeFirst
            ? new[] { AudibleChapterInfoGs, BooksDatabaseChapterInfoGs, ContentMetadataGs, AaxExporterGs }
            : new[] { BooksDatabaseChapterInfoGs, AudibleChapterInfoGs, ContentMetadataGs, AaxExporterGs };

        var output = CompileAndRun(sources);

        Assert.Equal("My Audiobook\n1\nPrologue\n", output);
    }

    // Issue #2455 (real-world shape): the actual Oahu AaxExporter.cs does not
    // use a struct literal for `ci` — it constructs the Audible sibling via a
    // package-qualified, PARENLESS-ARGS bare CONSTRUCTOR CALL:
    // `new Oahu.Audible.Json.ChapterInfo()`, translated by cs2gs to
    // `Oahu.Audible.Json.ChapterInfo()`. This is peeled by
    // TryBindQualifiedSourceTypeConstruction down to the bare terminal call
    // `ChapterInfo()`, which is bound by OverloadResolver.CallBinding's
    // BindCallExpression — a completely different code path from
    // BindStructLiteralExpression (used by `Type{...}`). Before the fix in
    // this changeset, BindCallExpression's `tryBindClrConstructorCall`
    // unconditionally ran BEFORE any source-type-alias check, always
    // preferring a same-simple-name CLR-IMPORTED class over a colliding
    // SOURCE type — regardless of package qualification or the
    // qualified-construction-package-hint (which is only consulted inside
    // TryLookupTypeAlias, a path this bare-call binder never reached). This
    // test exercises the bare-call SHAPE with two source packages (the exact
    // real-world CLR-vs-source collision is additionally covered end-to-end,
    // using a genuine C#-compiled CLR reference assembly, in
    // Issue2455QualifiedConstructorCallVsClrImportTests in Core.Tests). This
    // is the exact syntax shape that Issue2455CompositeTypeCollisionTests's
    // binder-level tests and the struct-literal-based emit test above did NOT
    // cover, and that reproduced GS0490 against the live Oahu.Core corpus.
    private const string AaxExporterBareCallGs = """
        package Oahu.Core
        import Oahu.Audible.Json
        import System

        class AaxExporter {
            func Export(title string) ContentMetadata {
                let ci = Oahu.Audible.Json.ChapterInfo()
                return ContentMetadata{ChapterInfo: ci, Title: title}
            }

            func Describe(cm ContentMetadata) {
                Console.WriteLine(cm.Title)
            }
        }

        func Main() {
            var exporter = AaxExporter{}
            var cm = exporter.Export("My Audiobook")
            exporter.Describe(cm)
        }
        """;

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ExactOahuShape_BareQualifiedConstructorCall_CompilesIlVerifiesAndRuns_OrderIndependent(bool audibleTreeFirst)
    {
        var sources = audibleTreeFirst
            ? new[] { AudibleChapterInfoGs, BooksDatabaseChapterInfoGs, ContentMetadataGs, AaxExporterBareCallGs }
            : new[] { BooksDatabaseChapterInfoGs, AudibleChapterInfoGs, ContentMetadataGs, AaxExporterBareCallGs };

        var output = CompileAndRun(sources);

        Assert.Equal("My Audiobook\n", output);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ExactOahuShape_BareQualifiedConstructorCall_EmittedContentMetadataChapterInfoProperty_ReflectsAsAudibleType_OrderIndependent(bool audibleTreeFirst)
    {
        var sources = audibleTreeFirst
            ? new[] { AudibleChapterInfoGs, BooksDatabaseChapterInfoGs, ContentMetadataGs, AaxExporterBareCallGs }
            : new[] { BooksDatabaseChapterInfoGs, AudibleChapterInfoGs, ContentMetadataGs, AaxExporterBareCallGs };

        var dllPath = CompileLibrary(sources, out var tempDir);
        try
        {
            var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
            var resolver = new PathAssemblyResolver(
                Directory.GetFiles(runtimeDir, "*.dll").Concat(new[] { dllPath }));
            using var mlc = new MetadataLoadContext(resolver, "System.Private.CoreLib");
            var asm = mlc.LoadFromAssemblyPath(dllPath);

            var contentMetadataType = asm.GetType("Oahu.Core.ContentMetadata")
                ?? throw new InvalidOperationException("Oahu.Core.ContentMetadata not found in emitted assembly");
            var chapterInfoProp = contentMetadataType.GetProperty("ChapterInfo")
                ?? throw new InvalidOperationException("ChapterInfo property not found on ContentMetadata");

            Assert.Equal("Oahu.Audible.Json.ChapterInfo", chapterInfoProp.PropertyType.FullName);
            Assert.NotEqual("Oahu.BooksDatabase.ChapterInfo", chapterInfoProp.PropertyType.FullName);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ExactOahuShape_EmittedContentMetadataChapterInfoProperty_ReflectsAsAudibleType_OrderIndependent(bool audibleTreeFirst)
    {
        var sources = audibleTreeFirst
            ? new[] { AudibleChapterInfoGs, BooksDatabaseChapterInfoGs, ContentMetadataGs, AaxExporterGs }
            : new[] { BooksDatabaseChapterInfoGs, AudibleChapterInfoGs, ContentMetadataGs, AaxExporterGs };

        var dllPath = CompileLibrary(sources, out var tempDir);
        try
        {
            var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
            var resolver = new PathAssemblyResolver(
                Directory.GetFiles(runtimeDir, "*.dll").Concat(new[] { dllPath }));
            using var mlc = new MetadataLoadContext(resolver, "System.Private.CoreLib");
            var asm = mlc.LoadFromAssemblyPath(dllPath);

            var contentMetadataType = asm.GetType("Oahu.Core.ContentMetadata")
                ?? throw new InvalidOperationException("Oahu.Core.ContentMetadata not found in emitted assembly");
            var chapterInfoProp = contentMetadataType.GetProperty("ChapterInfo")
                ?? throw new InvalidOperationException("ChapterInfo property not found on ContentMetadata");

            Assert.Equal("Oahu.Audible.Json.ChapterInfo", chapterInfoProp.PropertyType.FullName);
            Assert.NotEqual("Oahu.BooksDatabase.ChapterInfo", chapterInfoProp.PropertyType.FullName);

            // The property's declared type must carry the Audible sibling's
            // shape (`Chapters` is an array), not the BooksDatabase sibling's
            // (`Chapters` is an `ICollection`).
            var chaptersField = chapterInfoProp.PropertyType.GetProperty("Chapters")
                ?? throw new InvalidOperationException("Chapters property not found on resolved ChapterInfo type");
            Assert.True(
                chaptersField.PropertyType.IsArray,
                $"expected an array-typed Chapters member (Audible shape), got '{chaptersField.PropertyType.FullName}'");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRun(string[] sources)
    {
        var dllPath = CompileToExe(sources, out var tempDir);
        try
        {
            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

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
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileToExe(string[] sources, out string tempDir)
    {
        tempDir = Directory.CreateTempSubdirectory("gs_2455_exe_").FullName;
        var dllPath = Path.Combine(tempDir, "test.dll");
        var args = new List<string>
        {
            "/out:" + dllPath,
            "/target:exe",
            "/targetframework:net10.0",
        };

        for (var i = 0; i < sources.Length; i++)
        {
            var srcPath = Path.Combine(tempDir, $"file{i}.gs");
            File.WriteAllText(srcPath, sources[i]);
            args.Add(srcPath);
        }

        RunCompiler(args, dllPath);
        return dllPath;
    }

    private static string CompileLibrary(string[] sources, out string tempDir)
    {
        tempDir = Directory.CreateTempSubdirectory("gs_2455_lib_").FullName;
        var dllPath = Path.Combine(tempDir, "test.dll");
        var args = new List<string>
        {
            "/out:" + dllPath,
            "/target:library",
            "/targetframework:net10.0",
        };

        for (var i = 0; i < sources.Length; i++)
        {
            var srcPath = Path.Combine(tempDir, $"file{i}.gs");
            File.WriteAllText(srcPath, sources[i]);
            args.Add(srcPath);
        }

        RunCompiler(args, dllPath);
        return dllPath;
    }

    private static void RunCompiler(List<string> args, string dllPath)
    {
        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
        int compileExit;
        try
        {
            compileExit = Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

        IlVerifier.Verify(dllPath);
    }
}
