// <copyright file="Issue2455CompositeTypeCollisionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #2455 end-to-end emit coverage: the exact Oahu shape — two sibling
/// packages each declaring a top-level `ChapterInfo` type
/// (`Oahu.Audible.Json.ChapterInfo` with `Chapters []Chapter`, and
/// `Oahu.BooksDatabase.ChapterInfo` with a structurally incompatible
/// `ICollection[Chapter]` member), a third package (`Oahu.Core`)
/// that imports ONLY the Audible sibling and declares
/// `ContentMetadata{ prop ChapterInfo ChapterInfo }`, and an
/// `AaxExporter` whose `Export(ci ChapterInfo) ContentMetadata`
/// constructs `ContentMetadata{ChapterInfo: ci, ...}` via composite
/// literal. Before the fix, `BoundScope`'s "first declared wins" plain
/// simple-key alias table could resolve `ContentMetadata.ChapterInfo`'s
/// declared type against the WRONG sibling package (an artifact of
/// syntax-tree array order), misfiring GS0490 (StructuralProjectionFailure).
///
/// These tests compile the exact shape end-to-end (gsc in-process invocation
/// + ILVerify + `dotnet exec` run), covering both declaration orders for
/// order-independence, and additionally reflect the emitted assembly via
/// (cref:MetadataLoadContext) to assert
/// `ContentMetadata.ChapterInfo`'s exact declared CLR type is
/// `Oahu.Audible.Json.ChapterInfo` — never the sibling
/// `Oahu.BooksDatabase.ChapterInfo` — regardless of source order.
open class Issue2455CompositeTypeCollisionEmitTests {
    @Theory
    @InlineData(true)
    @InlineData(false)
    func ExactOahuShape_CompositeLiteralProjection_CompilesIlVerifiesAndRuns_OrderIndependent(audibleTreeFirst bool) {
        let sources = if audibleTreeFirst {
            []string{AudibleChapterInfoGs, BooksDatabaseChapterInfoGs, ContentMetadataGs, AaxExporterGs}
        } else {
            []string{BooksDatabaseChapterInfoGs, AudibleChapterInfoGs, ContentMetadataGs, AaxExporterGs}
        }
        let output = CompileAndRun(sources)
        Assert.Equal("My Audiobook${Environment.NewLine}1${Environment.NewLine}Prologue${Environment.NewLine}", output)
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    func ExactOahuShape_BareQualifiedConstructorCall_CompilesIlVerifiesAndRuns_OrderIndependent(audibleTreeFirst bool) {
        let sources = if audibleTreeFirst {
            []string{AudibleChapterInfoGs, BooksDatabaseChapterInfoGs, ContentMetadataGs, AaxExporterBareCallGs}
        } else {
            []string{BooksDatabaseChapterInfoGs, AudibleChapterInfoGs, ContentMetadataGs, AaxExporterBareCallGs}
        }
        let output = CompileAndRun(sources)
        Assert.Equal("My Audiobook${Environment.NewLine}", output)
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    func ExactOahuShape_BareQualifiedConstructorCall_EmittedContentMetadataChapterInfoProperty_ReflectsAsAudibleType_OrderIndependent(
        audibleTreeFirst bool
    ) {
        let sources = if audibleTreeFirst {
            []string{AudibleChapterInfoGs, BooksDatabaseChapterInfoGs, ContentMetadataGs, AaxExporterBareCallGs}
        } else {
            []string{BooksDatabaseChapterInfoGs, AudibleChapterInfoGs, ContentMetadataGs, AaxExporterBareCallGs}
        }
        let dllPath = CompileLibrary(sources, out var tempDir)
        try {
            let runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            let resolver = PathAssemblyResolver(Directory.GetFiles(runtimeDir, "*.dll").Concat([]string{dllPath}))
            using let mlc = MetadataLoadContext(resolver, "System.Private.CoreLib")
            let asm = mlc.LoadFromAssemblyPath(dllPath)
            let contentMetadataType = asm.GetType("Oahu.Core.ContentMetadata") ??
                throw InvalidOperationException("Oahu.Core.ContentMetadata not found in emitted assembly")
            let chapterInfoProp = contentMetadataType.GetProperty("ChapterInfo") ??
                throw InvalidOperationException("ChapterInfo property not found on ContentMetadata")
            Assert.Equal("Oahu.Audible.Json.ChapterInfo", chapterInfoProp.PropertyType.FullName)
            Assert.NotEqual("Oahu.BooksDatabase.ChapterInfo", chapterInfoProp.PropertyType.FullName)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    func ExactOahuShape_EmittedContentMetadataChapterInfoProperty_ReflectsAsAudibleType_OrderIndependent(
        audibleTreeFirst bool
    ) {
        let sources = if audibleTreeFirst {
            []string{AudibleChapterInfoGs, BooksDatabaseChapterInfoGs, ContentMetadataGs, AaxExporterGs}
        } else {
            []string{BooksDatabaseChapterInfoGs, AudibleChapterInfoGs, ContentMetadataGs, AaxExporterGs}
        }
        let dllPath = CompileLibrary(sources, out var tempDir)
        try {
            let runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            let resolver = PathAssemblyResolver(Directory.GetFiles(runtimeDir, "*.dll").Concat([]string{dllPath}))
            using let mlc = MetadataLoadContext(resolver, "System.Private.CoreLib")
            let asm = mlc.LoadFromAssemblyPath(dllPath)
            let contentMetadataType = asm.GetType("Oahu.Core.ContentMetadata") ??
                throw InvalidOperationException("Oahu.Core.ContentMetadata not found in emitted assembly")
            let chapterInfoProp = contentMetadataType.GetProperty("ChapterInfo") ??
                throw InvalidOperationException("ChapterInfo property not found on ContentMetadata")
            Assert.Equal("Oahu.Audible.Json.ChapterInfo", chapterInfoProp.PropertyType.FullName)
            Assert.NotEqual("Oahu.BooksDatabase.ChapterInfo", chapterInfoProp.PropertyType.FullName)
            // The property's declared type must carry the Audible sibling's
            // shape (`Chapters` is an array), not the BooksDatabase sibling's
            // (`Chapters` is an `ICollection`).
            let chaptersField = chapterInfoProp.PropertyType.GetProperty("Chapters") ??
                throw InvalidOperationException("Chapters property not found on resolved ChapterInfo type")
            Assert.True(
                chaptersField.PropertyType.IsArray,
                "expected an array-typed Chapters member (Audible shape), got '${chaptersField.PropertyType.FullName}'"
            )
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    shared {
        private const AudibleChapterInfoGs string = `package Oahu.Audible.Json

class ChapterInfo {
    prop Chapters []Chapter
}

class Chapter {
    prop Title string
}`

        private const BooksDatabaseChapterInfoGs string = `package Oahu.BooksDatabase
import System.Collections.Generic

class ChapterInfo {
    prop Chapters ICollection[Chapter]
}

class Chapter {
    prop Name string
}`

        private const ContentMetadataGs string = `package Oahu.Core
import Oahu.Audible.Json

class ContentMetadata {
    prop ChapterInfo ChapterInfo
    prop Title string
}`

        private const AaxExporterGs string = `package Oahu.Core
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
}`

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
        private const AaxExporterBareCallGs string = `package Oahu.Core
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
}`

        private func CompileAndRun(sources[]string) string {
            let dllPath = CompileToExe(sources, out var tempDir)
            try {
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileToExe(sources[]string, out tempDir string) string {
            tempDir = Directory.CreateTempSubdirectory("gs_2455_exe_").FullName
            let dllPath = Path.Combine(tempDir, "test.dll")
            let args = List[string]{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0"}
            for var i = 0; i < sources.Length; i++ {
                let srcPath = Path.Combine(tempDir, "file$i.gs")
                File.WriteAllText(srcPath, sources[i])
                args.Add(srcPath)
            }
            RunCompiler(args, dllPath)
            return dllPath
        }

        private func CompileLibrary(sources[]string, out tempDir string) string {
            tempDir = Directory.CreateTempSubdirectory("gs_2455_lib_").FullName
            let dllPath = Path.Combine(tempDir, "test.dll")
            let args = List[string]{"/out:" + dllPath, "/target:library", "/targetframework:net10.0"}
            for var i = 0; i < sources.Length; i++ {
                let srcPath = Path.Combine(tempDir, "file$i.gs")
                File.WriteAllText(srcPath, sources[i])
                args.Add(srcPath)
            }
            RunCompiler(args, dllPath)
            return dllPath
        }

        private func RunCompiler(args List[string], dllPath string) {
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
            IlVerifier.Verify(dllPath)
        }
    }
}
