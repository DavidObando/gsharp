// <copyright file="Issue2416NullAssertedMemberExtensionInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #2416 end-to-end coverage: compile, IL-verify, and run generic
/// extension calls reached through a null-asserted receiver's member
/// access (e.g. `x!!.Member.Ext()`), plus a faithful
/// Oahu-BookLibrary-shaped repro (`ChapterInfo`/`Chapter` with a
/// recursive `[]Chapter` and a generic
/// `IEnumerable[T]?.IsNullOrEmpty[T]()` extension). The pre-fix
/// binder's `InferTypeArguments` could only unify a slice/array
/// argument against an open CLR interface parameter (like
/// `IEnumerable[T]`) by reflecting over the argument's real CLR
/// `Type`; for a same-compilation source struct/class element type
/// that CLR `Type` doesn't exist pre-emission, so the parameter's
/// type argument was never inferred and the call failed to bind with
/// GS0159 "Cannot find function", regardless of whether the receiver was
/// reached via null-assertion, bare member access, or a for-loop element.
/// The fix adds a symbolic fallback (slice/array `ElementType`
/// unification against the fixed set of CLR-guaranteed
/// single-type-parameter array interfaces) that needs no CLR
/// `Type`, so these calls now bind, emit, verify, and run correctly.
open class Issue2416NullAssertedMemberExtensionInferenceEmitTests {
    @Fact
    func NullAssertedReceiver_ThenMemberAccess_GenericExtension_CompilesAndRuns() {
        // The originally-reported broken shape: x!!.Member.Ext() where
        // Ext is a generic extension over an imported open interface
        // (IEnumerable[T]?) and Member's static type is a slice of a
        // same-compilation source struct.
        let source = `package P
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
Console.WriteLine(book!!.Chapters.IsNullOrEmpty())`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func NullAssertedReceiver_ThenMemberAccess_GenericExtension_NonEmpty_ReturnsFalse() {
        let source = `package P
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
Console.WriteLine(book!!.Chapters.IsNullOrEmpty())`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}", output)
    }

    @Fact
    func NullAssertedReceiver_ThenMemberAccess_NonGenericExtension_CompilesAndRuns() {
        // Non-generic extension variant: proves the fix to the generic
        // inference routine doesn't regress the (unrelated) non-generic
        // extension-lookup path for the same null-assert-then-member
        // shape.
        let source = `package P
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
Console.WriteLine(book!!.Chapters.IsEmpty())`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func OahuBookLibraryShape_NullAssertedReceiver_NestedChapters_GenericExtension_CompilesAndRuns() {
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
        let source = `package Core
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
Console.WriteLine(DescribeChapterInfo(emptyInfo))`
        let output = CompileAndRun(source)
        Assert.Equal("has-nested${Environment.NewLine}empty${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2416_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
