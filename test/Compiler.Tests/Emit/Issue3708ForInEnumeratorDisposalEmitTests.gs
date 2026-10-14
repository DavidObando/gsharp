// <copyright file="Issue3708ForInEnumeratorDisposalEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Buffers.Binary
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

/// Issue #3708: `Lowerer.TryBuildEnumeratorDisposeCall` decided whether a
/// `for … in` loop needed a `try`/`finally` using a live
/// `typeof(IDisposable).IsAssignableFrom(clrType)`. That predicate is
/// unconditionally `false` for types loaded through a
/// (cref:System.Reflection.MetadataLoadContext) — i.e. every imported
/// type in a `/reference:`-based compile, which is every real SDK build —
/// so no disposal was emitted and the enumerator leaked its resource
/// (`File.ReadLines`, `Directory.EnumerateFiles`, `xs.Where(…)`).
/// C# guarantees the `finally` (ECMA-334 §13.9.5).
///
/// These tests pin the emitted IL rather than mere compilation success: a
/// "does it compile?" assertion passes on the bug.
open class Issue3708ForInEnumeratorDisposalEmitTests {
    @Fact
    func ImportedDisposableEnumerator_AgainstRefPack_EmitsTryFinallyWithDisposeCall() {
        // File.ReadLines returns an imported IEnumerable[string] whose
        // enumerator is a reference type implementing IDisposable, resolved
        // entirely out of the MetadataLoadContext.
        const source = `package Probe
import System
import System.IO

class P {
    func Run(path string) {
        for line in File.ReadLines(path) {
            Console.WriteLine(line)
            break
        }
    }
}`
        let assemblyPath = CompileLibraryAgainstRefPack(source)
        try {
            let body = ReadMethodBody(assemblyPath, "P", "Run")
            Assert.Contains(body.Regions, (region ExceptionRegion) -> region.Kind == ExceptionRegionKind.Finally)
            Assert.Contains(
                body.Regions.Where((region ExceptionRegion) -> region.Kind == ExceptionRegionKind.Finally),
                (region ExceptionRegion) -> CalledMethodNames(
                    body,
                    region.HandlerOffset,
                    region.HandlerLength
                ).Contains("Dispose")
            )
        } finally {
            DeleteDirectory(assemblyPath)
        }
    }

    @Fact
    func ImportedDisposableEnumerator_LinqWhere_EmitsTryFinallyWithDisposeCall() {
        // The LINQ iterator returned by Where is an imported class whose
        // Dispose is what stops the underlying enumeration — same MLC path.
        const source = `package Probe
import System
import System.Collections.Generic
import System.Linq

class P {
    func Run(xs IEnumerable[int32]) int32 {
        for x in xs.Where((v int32) -> v > 1) {
            return x
        }
        return 0
    }
}`
        let assemblyPath = CompileLibraryAgainstRefPack(source)
        try {
            let body = ReadMethodBody(assemblyPath, "P", "Run")
            Assert.Contains(
                body.Regions.Where((region ExceptionRegion) -> region.Kind == ExceptionRegionKind.Finally),
                (region ExceptionRegion) -> CalledMethodNames(
                    body,
                    region.HandlerOffset,
                    region.HandlerLength
                ).Contains("Dispose")
            )
        } finally {
            DeleteDirectory(assemblyPath)
        }
    }

    @Fact
    func ByRefLikeEnumerator_Span_EmitsNoDisposal() {
        // Negative pin for the sibling guard the fix must not weaken: ref
        // structs implement interfaces since .NET 9, so Span[T].Enumerator
        // now answers "yes" to IDisposable, but interface dispatch on a
        // byref-like receiver boxes and is invalid IL. Roslyn likewise emits
        // no disposal for the span pattern enumerator.
        const source = `package Probe
import System

class P {
    func Run(values []int32) int32 {
        var span Span[int32] = values
        for v in span {
            return v
        }
        return 0
    }
}`
        let assemblyPath = CompileLibraryAgainstRefPack(source)
        try {
            let body = ReadMethodBody(assemblyPath, "P", "Run")
            Assert.DoesNotContain(body.Regions, (region ExceptionRegion) -> region.Kind == ExceptionRegionKind.Finally)
            Assert.DoesNotContain("Dispose", CalledMethodNames(body, 0, body.Il!!.Length))
        } finally {
            DeleteDirectory(assemblyPath)
        }
    }

    @Fact
    func UserIteratorEnumerator_StillEmitsTryFinallyWithDisposeCall() {
        // The symbolic/same-compilation branch (a synthesized iterator state
        // machine) answered correctly before the fix because its enumerator
        // type is a live runtime type. Pin that it keeps working.
        const source = `package Probe
import System
import System.Collections.Generic

class P {
    func Numbers() IEnumerable[int32] {
        yield 1
        yield 2
    }

    func Run() int32 {
        for n in Numbers() {
            return n
        }
        return 0
    }
}`
        let assemblyPath = CompileLibraryAgainstRefPack(source)
        try {
            let body = ReadMethodBody(assemblyPath, "P", "Run")
            Assert.Contains(
                body.Regions.Where((region ExceptionRegion) -> region.Kind == ExceptionRegionKind.Finally),
                (region ExceptionRegion) -> CalledMethodNames(
                    body,
                    region.HandlerOffset,
                    region.HandlerLength
                ).Contains("Dispose")
            )
        } finally {
            DeleteDirectory(assemblyPath)
        }
    }

    @Fact
    func ImportedDisposableEnumerator_EarlyBreak_ReleasesTheFileHandle() {
        // Executing proof: after the loop breaks, the file must be openable
        // with FileShare.None. While the enumerator's handle leaks (pre-fix,
        // held until GC) that open throws IOException.
        const source = `package Probe
import System
import System.IO

let path = Environment.GetCommandLineArgs()[1]
for line in File.ReadLines(path) {
    Console.WriteLine(line)
    break
}

let exclusive = File.Open(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None)
exclusive.Dispose()
Console.WriteLine("released")`
        let assemblyPath = CompileExecutableAgainstRefPack(source)
        let directory = Path.GetDirectoryName(assemblyPath)!!
        try {
            let dataPath = Path.Combine(directory, "lines.txt")
            File.WriteAllText(dataPath, "alpha" + Environment.NewLine + "beta" + Environment.NewLine)
            let result = Run(assemblyPath, dataPath)
            Assert.True(
                result.ExitCode == 0,
                (
                    `the enumerator's file handle was still held after ` +
                        "\u0060" +
                        `break` +
                        "\u0060" +
                        ` (exit ` +
                        "${result.ExitCode}" +
                        `):
`
                ) +
                    (`stdout:
` + "${result.StandardOutput}" + `
stderr:
` + "${result.StandardError}")
            )
            Assert.Contains("released", result.StandardOutput)
        } finally {
            TryDeleteDirectory(directory)
        }
    }

    private data class MethodBody(
        Il[]?uint8,
        Regions ImmutableArray[ExceptionRegion],
        MethodNamesByToken IReadOnlyDictionary[int32, string]
    ) : IEquatable[MethodBody] { }

    shared {
        private func ReadMethodBody(assemblyPath string, typeName string, methodName string) MethodBody {
            using let stream = File.OpenRead(assemblyPath)
            using let pe = PEReader(stream)
            let metadata = pe.GetMetadataReader()
            let method = metadata
                .TypeDefinitions
                .Select((handle TypeDefinitionHandle) -> metadata.GetTypeDefinition(handle))
                .Where((type TypeDefinition) -> metadata.GetString(type.Name) == typeName)
                .SelectMany(
                func (type TypeDefinition) IEnumerable[MethodDefinitionHandle] {
                    return type.GetMethods()
                }
            )
                .Select((handle MethodDefinitionHandle) -> metadata.GetMethodDefinition(handle))
                .Single((candidate MethodDefinition) -> metadata.GetString(candidate.Name) == methodName)
            let body = pe.GetMethodBody(method.RelativeVirtualAddress)
            // Resolve the whole call-target name table eagerly: the metadata heaps
            // are backed by this PEReader's memory block and must not be touched
            // once it is disposed.
            let namesByToken = Dictionary[int32, string]()
            for handle in metadata.MemberReferences {
                namesByToken[MetadataTokens.GetToken(handle)] = metadata.GetString(
                    metadata.GetMemberReference(handle).Name
                )
            }
            for handle in metadata.MethodDefinitions {
                namesByToken[MetadataTokens.GetToken(handle)] = metadata.GetString(
                    metadata.GetMethodDefinition(handle).Name
                )
            }
            let methodSpecCount = metadata.GetTableRowCount(TableIndex.MethodSpec)
            for var row = 1; row <= methodSpecCount; row++ {
                let handle = MetadataTokens.MethodSpecificationHandle(row)
                let parent = metadata.GetMethodSpecification(handle).Method
                if namesByToken.TryGetValue(MetadataTokens.GetToken(parent), out var parentName) {
                    namesByToken[MetadataTokens.GetToken(handle)] = parentName
                }
            }
            return MethodBody(body.GetILBytes()!!, body.ExceptionRegions, namesByToken)
        }

        /// Returns the names of every method targeted by a `call` /
        /// `callvirt` / `constrained.`-prefixed call inside the given IL
        /// window. Scanning for the two call opcodes plus a 4-byte token is
        /// sufficient here because the windows inspected are the tiny bodies the
        /// lowerer synthesizes, matching the byte-scanning idiom used by the other
        /// emit tests in this folder.
        /// @param body The decoded method body.
        /// @param offset Start of the IL window.
        /// @param length Length of the IL window.
        /// @returns The set of called method names.
        private func CalledMethodNames(body MethodBody, offset int32, length int32) HashSet[string] {
            let names = HashSet[string](StringComparer.Ordinal)
            let end = Math.Min(body.Il!!.Length, offset + length)
            for var i = offset; i + 5 <= end; i++ {
                if body.Il!![i] != uint8(0x28) && body.Il!![i] != uint8(0x6F) {
                    continue
                }
                let token = BinaryPrimitives.ReadInt32LittleEndian(body.Il.AsSpan(i + 1, 4))
                if body.MethodNamesByToken.TryGetValue(token, out var name) {
                    names.Add(name)
                }
            }
            return names
        }

        private func CompileLibraryAgainstRefPack(source string) string -> Compile(source, "library")

        private func CompileExecutableAgainstRefPack(source string) string -> Compile(source, "exe")

        private func Compile(source string, target string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue3708_").FullName
            let sourcePath = Path.Combine(directory, "probe.gs")
            let outputPath = Path.Combine(directory, "probe.dll")
            File.WriteAllText(sourcePath, source)
            let args = List[string]{
                "/out:" + outputPath,
                "/target:" + target,
                "/targetframework:net10.0",
                "/nowarn:GS9100"
            }
            for reference in RefPackReferences() {
                args.Add("/reference:" + reference)
            }
            args.Add(sourcePath)
            using let standardOutput = StringWriter()
            using let standardError = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(standardOutput)
            Console.SetError(standardError)
            try {
                let exitCode = Program.Main(args.ToArray())
                Assert.True(exitCode == 0, (`compile failed (` + "$exitCode" + `):
` + "$standardOutput" + `
` + "$standardError"))
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            IlVerifier.Verify(outputPath)
            return outputPath
        }

        private func Run(assemblyPath string, argument string)(
            ExitCode int32,
            StandardOutput string,
            StandardError string
        ) {
            using let process = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                        assemblyPath,
                        argument
                    },
                    WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            )!!
            let standardOutput = process.StandardOutput.ReadToEnd().ReplaceLineEndings(Environment.NewLine)
            let standardError = process.StandardError.ReadToEnd().ReplaceLineEndings(Environment.NewLine)
            Assert.True(process.WaitForExit(60_000), "dotnet exec timed out")
            return (process.ExitCode, standardOutput, standardError)
        }

        /// Assembles the reference closure the .NET SDK would hand gsc — the
        /// `Microsoft.NETCore.App.Ref` targeting-pack facades. Loading through
        /// these (rather than the test host's TPA) is what puts every imported type
        /// in a MetadataLoadContext with an assembly identity distinct from the
        /// host's `System.Private.CoreLib`, which is the exact configuration
        /// issue #3708 mis-answered. Mirrors
        /// `XunitAssertOverloadResolutionTests.RefPackReferences`.
        /// @returns The reference assembly paths.
        private func RefPackReferences() IEnumerable[string] {
            let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
            Assert.False(string.IsNullOrEmpty(runtimeDir), "host runtime directory not resolvable")
            let dotnetRoot string? = Directory.GetParent(runtimeDir!!)?.Parent?.Parent?.FullName
            Assert.False(string.IsNullOrEmpty(dotnetRoot), "dotnet root not resolvable")
            let packsRoot = Path.Combine(dotnetRoot!!, "packs", "Microsoft.NETCore.App.Ref")
            Assert.True(Directory.Exists(packsRoot), "ref pack root '$packsRoot' missing")
            let major = Environment.Version.Major.ToString()
            var refDir = Path.Combine(packsRoot, Environment.Version.ToString(3), "ref", "net$major.0")
            if !Directory.Exists(refDir) {
                let candidate string? = Directory
                    .EnumerateDirectories(packsRoot, major + ".*")
                    .OrderByDescending((d string) -> d, StringComparer.Ordinal)
                    .Select((d string) -> Path.Combine(d, "ref", "net$major.0"))
                    .FirstOrDefault(Directory.Exists)
                Assert.False(string.IsNullOrEmpty(candidate), "no ref pack for net$major.0 under '$packsRoot'")
                refDir = candidate!!
            }
            return Directory.EnumerateFiles(refDir, "*.dll")
        }

        private func DeleteDirectory(assemblyPath string) -> TryDeleteDirectory(Path.GetDirectoryName(assemblyPath)!!)

        private func TryDeleteDirectory(directory string?) {
            try {
                Directory.Delete(directory!!, recursive: true)
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
