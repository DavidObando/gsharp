// <copyright file="Issue3712OverloadedMethodGroupInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #3712: an OVERLOADED user method group passed to a generic imported
/// extension method (`list.Select(Helper.ToRange)`) had no natural type,
/// so the symbolic type-argument vector kept the argument's erased CLR shape
/// and the generic call was emitted closed over `object` —
/// `Enumerable::Select<Token, object>` feeding a
/// `List<object>` into an `IEnumerable<Range>` slot. The
/// binder still typed the expression symbolically, so nothing was reported and
/// the assembly failed IL verification with `StackUnexpected`. This was
/// the sole ilverify failure of the migrated `src/LanguageServer`
/// (`LspServer::ComputeLinkedEditingRanges`).
open class Issue3712OverloadedMethodGroupInferenceEmitTests {
    /// The reduced `LspServer::ComputeLinkedEditingRanges` shape: an
    /// overloaded `shared` group whose return type is a same-compilation
    /// class, projected over a `List[T]` and stored into an
    /// `IEnumerable[T]` field.
    @Fact
    func OverloadedSharedGroup_ReturningSameCompilationClass_EmitsClosedOverRealType() {
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

class Token {
    var Text string
    init(text string) { Text = text }
}

class Range {
    var Label string
    init(label string) { Label = label }
}

class Holder {
    var Items IEnumerable[Range]
}

class Helper {
    shared {
        func ToRange(token Token) Range { return Range(token.Text) }
        func ToRange(text string, extra int32) Range { return Range(text) }
    }
}

func Build(tokens List[Token]) Holder {
    return Holder{Items: tokens.Select(Helper.ToRange).ToList()}
}

var tokens = List[Token]()
tokens.Add(Token("a"))
tokens.Add(Token("b"))
for item in Build(tokens).Items {
    Console.WriteLine(item.Label)
}`
        Assert.Equal("a${Environment.NewLine}b${Environment.NewLine}", CompileAndRun(source))
    }

    /// The same defect with an imported element type: only the group's RETURN
    /// type is same-compilation, so the erasure enters inference through the
    /// output position alone.
    @Fact
    func OverloadedSharedGroup_ImportedSource_SameCompilationResult_EmitsClosedOverRealType() {
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

class Range {
    var Label string
    init(label string) { Label = label }
}

class Holder {
    var Items IEnumerable[Range]
}

class Helper {
    shared {
        func ToRange(value int32) Range { return Range(value.ToString()) }
        func ToRange(text string, extra int32) Range { return Range(text) }
    }
}

func Build(values List[int32]) Holder {
    return Holder{Items: values.Select(Helper.ToRange).ToList()}
}

var values = List[int32]()
values.Add(1)
values.Add(2)
for item in Build(values).Items {
    Console.WriteLine(item.Label)
}`
        Assert.Equal("1${Environment.NewLine}2${Environment.NewLine}", CompileAndRun(source))
    }

    /// Regression guard for the pre-existing single-candidate path, which
    /// already recovered the symbolic return type — the refinement must not
    /// disturb it.
    @Fact
    func SingleCandidateGroup_ReturningSameCompilationClass_StillEmitsClosedOverRealType() {
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

class Range {
    var Label string
    init(label string) { Label = label }
}

class Helper {
    shared {
        func ToRange(value int32) Range { return Range(value.ToString()) }
    }
}

func Build(values List[int32]) IEnumerable[Range] {
    return values.Select(Helper.ToRange).ToList()
}

var values = List[int32]()
values.Add(7)
for item in Build(values) {
    Console.WriteLine(item.Label)
}`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    /// An overloaded group whose candidates share the target arity stays
    /// ambiguous by arity alone and must keep binding through the existing
    /// CLR-erasure path — here both candidates take one parameter and the
    /// argument type selects between them.
    @Fact
    func OverloadedSharedGroup_SameArityCandidates_StillBindsAndRuns() {
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

class Helper {
    shared {
        func Describe(value int32) string { return "i" + value.ToString() }
        func Describe(value string) string { return "s" + value }
    }
}

func Build(values List[int32]) List[string] {
    return values.Select(Helper.Describe).ToList()
}

var values = List[int32]()
values.Add(3)
for item in Build(values) {
    Console.WriteLine(item)
}`
        Assert.Equal("i3${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_3712_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                // (a) Static verification: the erased `object` closure produced
                // unverifiable IL, so ilverify is the primary assertion.
                IlVerifier.Verify(outPath)
                // (b) Dynamic verification: verifiable-but-wrong lowering would be
                // worse than the bug, so the program must also produce the right
                // values.
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
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }
}
