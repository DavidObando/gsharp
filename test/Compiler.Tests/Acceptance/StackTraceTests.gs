// <copyright file="StackTraceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Acceptance

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import System.Text.RegularExpressions
import System.Threading.Tasks
import Xunit
import Xunit.Sdk

/// Phase 9 acceptance tests for the Portable PDB pipeline (#95 / #50):
/// compile a GSharp program to PE + sidecar Portable PDB, load both into
/// an isolated (cref:AssemblyLoadContext), invoke a method that
/// throws, and assert that the captured stack trace points back to the
/// original `.gs` source file at the right line. These verify the
/// end-to-end debugging contract — sequence points, document table, and
/// PE/PDB pairing — that downstream cross-language tooling depends on.
open class StackTraceTests {
    @Fact
    func StackTrace_SyncThrow_PointsAtThrowingLine() {
        let source = string.Join(
            "\n",
            []string{
                "package StackTraceSync",
                "",
                "import System",
                "",
                "public func Boom() {",
                "    throw Exception(\"sync boom\")",
                "}",
                string.Empty
            }
        )
        let trace = CompileAndCaptureThrow(source, methodName: "Boom", contextName: "sync-throw")
        AssertHasFrame(trace.StackTrace, trace.SourceFile, expectedLine: 6, methodHint: "Boom")
        Assert.Equal("sync boom", trace.Message)
    }

    @Fact
    func StackTrace_ThrowInsideNestedCall_PointsAtThrowSite() {
        // The .NET JIT is free to inline trivial leaf functions, which would
        // collapse the throwing frame into its caller's IL offset map. Padding
        // `Inner` with a few branches keeps it out of the inliner's threshold
        // so we can validate that the PDB resolves BOTH the throwing site and
        // the call site to the original source lines.
        let source = string.Join(
            "\n",
            []string{
                "package StackTraceNested",
                "",
                "import System",
                "",
                "func Inner(seed int32) {",
                "    var acc = 0",
                "    for var i = 0; i < seed; i++ {",
                "        acc = acc + i",
                "    }",
                "    if acc >= 0 {",
                "        throw Exception(\"deep boom: \" + acc.ToString())",
                "    }",
                "}",
                "",
                "public func Outer() {",
                "    Inner(4)",
                "}",
                string.Empty
            }
        )
        let trace = CompileAndCaptureThrow(source, methodName: "Outer", contextName: "nested-throw")
        // PDB must locate at least the throw site OR the call site; both is
        // ideal but JIT inlining behavior is the runtime's prerogative. Either
        // proves the document table + sequence points round-trip correctly.
        let sourceName = Path.GetFileName(trace.SourceFile)
        let matches = Regex.Matches(trace.StackTrace, Regex.Escape(sourceName) + "[^\\n]*?(\\d+)")
        let lines = matches.Cast[Match]().Select((m Match) -> int32.Parse(m.Groups[1].Value)).ToHashSet()
        Assert.True(lines.Contains(11) || lines.Contains(16), (`Expected stack-trace frame at ` + "$sourceName" + `:11 (throw) or :16 (call site). Trace:
` + "${trace.StackTrace}"))
        Assert.StartsWith("deep boom:", trace.Message)
    }

    @Fact
    func StackTrace_ThrowFromForInBody_PointsAtThrowingLine() {
        // Exercises the for-in lowering: the throw lives inside a synthesized
        // foreach over a slice. Phase 1's Syntax-on-BoundNode threading is
        // what keeps the sequence point on the user-visible line, not on the
        // synthesized iteration header.
        let source = string.Join(
            "\n",
            []string{
                "package StackTraceForIn",
                "",
                "import System",
                "",
                "public func RunForIn() {",
                "    var items = []int32{1, 2, 3}",
                "    for v in items {",
                "        throw Exception(\"for-in boom: \" + v.ToString())",
                "    }",
                "}",
                string.Empty
            }
        )
        let trace = CompileAndCaptureThrow(source, methodName: "RunForIn", contextName: "for-in-throw")
        AssertHasFrame(trace.StackTrace, trace.SourceFile, expectedLine: 8, methodHint: "RunForIn")
        Assert.StartsWith("for-in boom:", trace.Message)
    }

    @Fact
    async func StackTrace_AsyncThrowAfterAwait_PointsAtThrowingLine() {
        // Exercises Phase 5 + Phase 6 (async state-machine sequence points):
        // throwing AFTER an await suspends + resumes through MoveNext. The
        // sequence-point table must restore the user-visible line on the
        // post-await path, so the captured stack trace must still cite the
        // .gs source location even though execution went through a generated
        // state-machine type.
        let source = string.Join(
            "\n",
            []string{
                "package StackTraceAsync",
                "",
                "import System",
                "import System.Threading.Tasks",
                "",
                "public async func AsyncBoom() {",
                "    await Task.Delay(1)",
                "    throw Exception(\"async boom\")",
                "}",
                string.Empty
            }
        )
        let compiled = CompileWithPdb(source, contextName: "async-throw")
        try {
            let method MethodInfo? = compiled.ProgramType!!.GetMethod(
                "AsyncBoom",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            Assert.NotNull(method)
            var caught Exception? = nil
            try {
                let task Task? = cast[Task](method!!.Invoke(nil, parameters: nil))
                Assert.NotNull(task)
                await task!!
            } catch (tie TargetInvocationException) when tie.InnerException != nil {
                caught = tie.InnerException
            } catch (ex Exception) {
                caught = ex
            }
            Assert.NotNull(caught)
            Assert.Equal("async boom", caught!!.Message)
            AssertHasFrame(caught!!.StackTrace, compiled.SourceFile, expectedLine: 8, methodHint: "AsyncBoom")
        } finally {
            compiled.LoadContext.Unload()
            try {
                Directory.Delete(compiled.WorkDir, recursive: true)
            } catch { }
        }
    }

    private data class CompiledProgram(
        LoadContext AssemblyLoadContext,
        ProgramType Type?,
        SourceFile string,
        WorkDir string
    ) : IEquatable[StackTraceTests.CompiledProgram] { }

    private data class ThrowTrace(Message string, StackTrace string, SourceFile string) : IEquatable[ThrowTrace] { }

    shared {
        private func CompileAndCaptureThrow(source string, methodName string, contextName string) ThrowTrace {
            let compiled = CompileWithPdb(source, contextName)
            try {
                let method MethodInfo? = compiled.ProgramType!!.GetMethod(
                    methodName,
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                )
                Assert.NotNull(method)
                try {
                    method!!.Invoke(nil, parameters: nil)
                } catch (tie TargetInvocationException) when tie.InnerException != nil {
                    return ThrowTrace(
                        tie.InnerException!!.Message,
                        tie.InnerException!!.StackTrace ?? string.Empty,
                        compiled.SourceFile
                    )
                } catch (ex Exception) {
                    return ThrowTrace(ex.Message, ex.StackTrace ?? string.Empty, compiled.SourceFile)
                }
                throw XunitException("Method '$methodName' returned without throwing.")
            } finally {
                compiled.LoadContext.Unload()
                try {
                    Directory.Delete(compiled.WorkDir, recursive: true)
                } catch { }
            }
        }

        private func CompileWithPdb(source string, contextName string) StackTraceTests.CompiledProgram {
            let workDir = Directory.CreateTempSubdirectory("gs_stacktrace_${contextName}_").FullName
            let srcPath = Path.Combine(workDir, "$contextName.gs")
            let asmPath = Path.Combine(workDir, "$contextName.dll")
            let pdbPath = Path.ChangeExtension(asmPath, ".pdb")
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
                    []string{
                        "/out:" + asmPath,
                        "/target:library",
                        "/targetframework:net10.0",
                        "/debug:portable",
                        "/pdb:" + pdbPath,
                        srcPath
                    }
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(asmPath)
            Assert.True(File.Exists(asmPath), "missing PE: $asmPath")
            Assert.True(File.Exists(pdbPath), "missing PDB: $pdbPath")
            let peBytes = File.ReadAllBytes(asmPath)
            let pdbBytes = File.ReadAllBytes(pdbPath)
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            using let peStream = MemoryStream(peBytes)
            using let pdbStream = MemoryStream(pdbBytes)
            let asm = loadContext.LoadFromStream(peStream, pdbStream)
            let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
            Assert.NotNull(programType)
            return StackTraceTests.CompiledProgram(loadContext, programType!!, srcPath, workDir)
        }

        private func AssertHasFrame(stackTrace string?, sourceFile string, expectedLine int32, methodHint string) {
            Assert.False(string.IsNullOrEmpty(stackTrace), "stack trace was empty — was the PDB attached?")
            // The CLR formats stack frames as " in <path>:line <N>" (culture-invariant
            // "line " literal in en-US; localized in other locales). Match the
            // shape "<file>:line <number>" with the source path appearing somewhere
            // on the same line — we don't tie ourselves to the exact culture
            // formatting.
            let sourceName = Path.GetFileName(sourceFile)
            let pattern = Regex(Regex.Escape(sourceName) + "[^\\n]*?(\\d+)", RegexOptions.CultureInvariant)
            var matched = false
            for m Match in pattern.Matches(stackTrace!!) {
                if int32.TryParse(m.Groups[1].Value, out var line) && line == expectedLine {
                    matched = true
                    break
                }
            }
            Assert.True(
                matched,
                (
                    `Expected stack-trace frame for ` +
                        "$sourceName" +
                        `:` +
                        "$expectedLine" +
                        ` (method '` +
                        "$methodHint" +
                        `'). Full trace:
` +
                        "$stackTrace"
                )
            )
        }
    }
}
