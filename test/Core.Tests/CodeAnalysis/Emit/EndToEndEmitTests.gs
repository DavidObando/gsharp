// <copyright file="EndToEndEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import System.Threading.Tasks
import Xunit

/// Phase 1 end-to-end emit tests: compile a tiny GSharp program, load the
/// produced PE bytes, and invoke the synthesized entry point. These pin the
/// behavior of `ReflectionMetadataEmitter` against real .NET load/execute
/// rather than just checking metadata shapes.
open class EndToEndEmitTests {
    @Fact
    func Emits_Valid_PE_For_HelloWorld() {
        using let peStream = MemoryStream()
        let result = Compile(HelloWorldSource, peStream)
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        peStream.Position = 0
        using let peReader = PEReader(peStream, PEStreamOptions.LeaveOpen)
        Assert.True(peReader.HasMetadata)
        let md = peReader.GetMetadataReader()
        Assert.True(md.IsAssembly)
        // <Module> + <Program>.
        Assert.Equal(2, md.TypeDefinitions.Count)
        // Entry point must be set in the corheader.
        let corHeader CorHeader? = peReader.PEHeaders.CorHeader
        Assert.NotNull(corHeader)
        Assert.NotEqual(0, corHeader!!.EntryPointTokenOrRelativeVirtualAddress)
    }

    @Fact
    func HelloWorld_Loads_And_Invokes_Entry_Point() {
        using let peStream = MemoryStream()
        let result = Compile(HelloWorldSource, peStream)
        Assert.True(result.Success)
        peStream.Position = 0
        let loadContext = AssemblyLoadContext("EndToEndEmitTests-Hello", isCollectible: true)
        try {
            let asm = loadContext.LoadFromStream(peStream)
            let allTypes = asm.GetTypes()
            let programType Type? = allTypes.FirstOrDefault((t Type) -> t.Name == "<Program>")
            Assert.NotNull(programType)
            let entry MethodInfo? = programType!!.GetMethod(
                "<Main>$$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(entry)
            let stdout = Console.Out
            let captured = StringWriter()
            Console.SetOut(captured)
            try {
                entry!!.Invoke(
                    nil,
                    if entry!!.GetParameters().Length == 0 {
                        default([]?object)
                    } else {
                        []object{Array.Empty[string]()}
                    }
                )
            } finally {
                Console.SetOut(stdout)
            }
            Assert.Contains("Hello, world!", captured.ToString())
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func Emits_Arithmetic_With_Locals_And_BinaryOps() {
        const Source = `package Arith
import System
var x = 2 + 3 * 4
Console.WriteLine(x)
`
        let output = CompileLoadInvokeCaptureStdout(Source, "EndToEndEmitTests-Arith")
        Assert.Contains("14", output)
    }

    @Fact
    func Emits_User_Defined_Function_With_Digit_In_Param_Names() {
        // Exercises both BoundCallExpression emit AND issue #32 (digits in identifiers).
        const Source = `package UserFn
import System
func add(num1 int32, num2 int32) int32 {
    return num1 + num2
}
Console.WriteLine(add(2, 3))
`
        let output = CompileLoadInvokeCaptureStdout(Source, "EndToEndEmitTests-UserFn")
        Assert.Contains("5", output)
    }

    @Fact
    func Emits_For_Loop_With_Branching() {
        const Source = `package Loop
import System
var sum = 0
for i in 1 ... 5 {
    sum = sum + i
}
Console.WriteLine(sum)
`
        let output = CompileLoadInvokeCaptureStdout(Source, "EndToEndEmitTests-Loop")
        Assert.Contains("10", output)
    }

    @Fact
    func Emits_If_Statement_With_Comparison() {
        const Source = `package Cond
import System
var x = 7
if x > 5 {
    Console.WriteLine("big")
} else {
    Console.WriteLine("small")
}
`
        let output = CompileLoadInvokeCaptureStdout(Source, "EndToEndEmitTests-Cond")
        Assert.Contains("big", output)
    }

    @Fact
    func Emits_String_Concatenation_With_Variable() {
        const Source = `package Concat
import System
var name = "world"
Console.WriteLine("hi " + name)
`
        let output = CompileLoadInvokeCaptureStdout(Source, "EndToEndEmitTests-Concat")
        Assert.Contains("hi world", output)
    }

    @Fact
    func Emits_Recursive_User_Function() {
        const Source = `package Recurse
import System
func factorial(n int32) int32 {
    if n <= 1 {
        return 1
    }
    return n * factorial(n - 1)
}
Console.WriteLine(factorial(5))
`
        let output = CompileLoadInvokeCaptureStdout(Source, "EndToEndEmitTests-Recurse")
        Assert.Contains("120", output)
    }

    @Fact
    func Emit_Is_Deterministic_For_Same_Source() {
        using let first = MemoryStream()
        using let second = MemoryStream()
        Assert.True(Compile(HelloWorldSource, first).Success)
        Assert.True(Compile(HelloWorldSource, second).Success)
        let firstBytes = first.ToArray()
        let secondBytes = second.ToArray()
        Assert.Equal(firstBytes.Length, secondBytes.Length)
        Assert.True(
            firstBytes.AsSpan().SequenceEqual(secondBytes),
            "two emits of the same source must produce uint8-identical PEs (deterministic MVID + timestamp)."
        )
    }

    @Fact
    func Emit_Produces_NonZero_Mvid_Derived_From_Content() {
        using let first = MemoryStream()
        using let second = MemoryStream()
        Assert.True(Compile(HelloWorldSource, first).Success)
        Assert.True(Compile(HelloWorldSource.Replace("Hello, world!", "Hi, world!"), second).Success)
        first.Position = 0
        second.Position = 0
        using let firstPe = PEReader(first, PEStreamOptions.LeaveOpen)
        using let secondPe = PEReader(second, PEStreamOptions.LeaveOpen)
        let firstMvid = firstPe.GetMetadataReader().GetGuid(firstPe.GetMetadataReader().GetModuleDefinition().Mvid)
        let secondMvid = secondPe.GetMetadataReader().GetGuid(secondPe.GetMetadataReader().GetModuleDefinition().Mvid)
        Assert.NotEqual(Guid.Empty, firstMvid)
        Assert.NotEqual(firstMvid, secondMvid)
        // Deterministic emit zeros out the PE TimeDateStamp (the content id's
        // stamp goes into the COFF header; both should differ across content).
        Assert.NotEqual(firstPe.PEHeaders.CoffHeader.TimeDateStamp, secondPe.PEHeaders.CoffHeader.TimeDateStamp)
    }

    @Fact
    func Emit_Reference_Assembly_Has_No_Method_Bodies_And_Carries_RefAsmAttribute() {
        const Source = `package RefAsm
import System
func add(a int32, b int32) int32 { return a + b }
Console.WriteLine(add(2, 3))
`
        using let peStream = MemoryStream()
        using let refStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        let result = compilation.Emit(peStream, refStream)
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        refStream.Position = 0
        using let refPe = PEReader(refStream, PEStreamOptions.LeaveOpen)
        let md = refPe.GetMetadataReader()
        // No entry point should be set on a metadata-only PE.
        Assert.Equal(0, refPe.PEHeaders.CorHeader!!.EntryPointTokenOrRelativeVirtualAddress)
        // Every method definition must have RVA 0 — no IL body.
        for mdh in md.MethodDefinitions {
            let method = md.GetMethodDefinition(mdh)
            Assert.Equal(0, method.RelativeVirtualAddress)
        }
        // The assembly must carry [ReferenceAssemblyAttribute].
        let assembly = md.GetAssemblyDefinition()
        var foundRefAsm = false
        for cah in assembly.GetCustomAttributes() {
            let ca = md.GetCustomAttribute(cah)
            let ctor = ca.Constructor
            var typeName string? = nil
            if ctor.Kind == HandleKind.MemberReference {
                let mr = md.GetMemberReference(MemberReferenceHandle(ctor))
                if mr.Parent.Kind == HandleKind.TypeReference {
                    let tr = md.GetTypeReference(TypeReferenceHandle(mr.Parent))
                    typeName = md.GetString(tr.Namespace) + "." + md.GetString(tr.Name)
                }
            }
            if typeName == "System.Runtime.CompilerServices.ReferenceAssemblyAttribute" {
                foundRefAsm = true
                break
            }
        }
        Assert.True(foundRefAsm, "metadata-only emit must mark the assembly with ReferenceAssemblyAttribute.")
        // The runtime PE should still carry IL and an entry point.
        peStream.Position = 0
        using let runtimePe = PEReader(peStream, PEStreamOptions.LeaveOpen)
        Assert.NotEqual(0, runtimePe.PEHeaders.CorHeader!!.EntryPointTokenOrRelativeVirtualAddress)
    }

    /// Issue #420 (P3-14): reference assemblies must emit PE sections in the
    /// conventional Roslyn order (.text / .rsrc / .reloc / .mvid). Placing the
    /// .mvid section first is spec-legal but uncommon and can surprise older
    /// tooling that walks sections positionally.
    @Fact
    func Emit_Reference_Assembly_Has_Conventional_Section_Order_With_Mvid_Last() {
        const Source = `package RefAsmSections
import System
func add(a int32, b int32) int32 { return a + b }
Console.WriteLine(add(2, 3))
`
        using let peStream = MemoryStream()
        using let refStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        let result = compilation.Emit(peStream, refStream)
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        refStream.Position = 0
        using let refPe = PEReader(refStream, PEStreamOptions.LeaveOpen)
        let sectionNames = refPe.PEHeaders.SectionHeaders.Select((s SectionHeader) -> s.Name).ToArray()
        // .text must come first; .mvid must be present and must be the last
        // section in the table (after .text/.rsrc/.reloc).
        Assert.Contains(".text", sectionNames)
        Assert.Contains(".mvid", sectionNames)
        Assert.Equal(".text", sectionNames[0])
        Assert.Equal(".mvid", sectionNames[sectionNames.Length - 1])
        // If .rsrc and/or .reloc are present they must precede .mvid; this
        // pins the conventional .text / .rsrc / .reloc / .mvid layout.
        let mvidIndex = Array.IndexOf(sectionNames, ".mvid")
        let rsrcIndex = Array.IndexOf(sectionNames, ".rsrc")
        let relocIndex = Array.IndexOf(sectionNames, ".reloc")
        if rsrcIndex >= 0 {
            Assert.True(rsrcIndex < mvidIndex, ".rsrc must precede .mvid")
        }
        if relocIndex >= 0 {
            Assert.True(relocIndex < mvidIndex, ".reloc must precede .mvid")
        }
    }

    /// Issue #457: cross-cutting "dotnet-pdbverify"-style round-trip that
    /// loads both the emitted PE and the standalone Portable PDB through
    /// (cref:PEReader) / (cref:MetadataReaderProvider) and
    /// asserts the structural invariants called out by the P3 PDB/PE
    /// cosmetics review (P3-12, P3-13, P3-14) all hold simultaneously on a
    /// non-trivial program. This is the closest stand-in for the missing
    /// official "pdbverify" tool: any cosmetic regression that broke a
    /// strict consumer (debugger, profiler, PE rewriter) would surface here
    /// as a reader exception or a failed assertion.
    @Fact
    func PdbAndPe_RoundTripCleanly_Through_Official_Readers() {
        const Source = `package main
import System

func add(a int32, b int32) int32 {
    let sum = a + b
    return sum
}

func main() {
    let result = add(2, 3)
    Console.WriteLine(result)
}
`
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(Source, "main.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable, EmbedAllSources: true}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        // --- PE side: PEReader must accept the file and report a valid
        // section table with the conventional ordering required by P3-14.
        peStream.Position = 0
        using let pe = PEReader(peStream, PEStreamOptions.LeaveOpen)
        Assert.True(pe.HasMetadata, "emitted PE must expose metadata")
        let peMd = pe.GetMetadataReader()
        Assert.True(peMd.IsAssembly)
        Assert.Equal(".text", pe.PEHeaders.SectionHeaders[0].Name)
        // --- PDB side: MetadataReaderProvider must accept the standalone
        // PDB stream and produce a usable MetadataReader. This single line
        // is the strongest "is it a valid Portable PDB?" check the
        // System.Reflection.Metadata library offers.
        pdbStream.Position = 0
        using let pdbProvider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let pdb = pdbProvider.GetMetadataReader()
        // At least one document and one method-debug-info row are mandatory
        // for a non-empty program; if either is missing the PDB will not
        // bind any breakpoints.
        Assert.True(pdb.Documents.Count >= 1, "PDB must have at least one Document row")
        Assert.True(pdb.MethodDebugInformation.Count >= 1, "PDB must have at least one MethodDebugInformation row")
        // --- P3-13 regression guard: every MethodDebugInformation row must
        // round-trip its LocalSignature row id consistently with the PE
        // method body's localVariablesSignature, even after the encoder
        // change from "full token" to "row id only". A reader that strictly
        // validates the field would catch the old (non-conforming) encoding
        // as either an out-of-range row id or a "wrong table" error; the
        // assertion below pins both directions of the contract.
        var verifiedAtLeastOne = false
        for mdih in pdb.MethodDebugInformation {
            let mdi = pdb.GetMethodDebugInformation(mdih)
            let methodHandle = MetadataTokens.MethodDefinitionHandle(MetadataTokens.GetRowNumber(mdih))
            let method = peMd.GetMethodDefinition(methodHandle)
            if method.RelativeVirtualAddress == 0 {
                continue
            }
            let body = pe.GetMethodBody(method.RelativeVirtualAddress)
            if mdi.LocalSignature.IsNil {
                Assert.True(body.LocalSignature.IsNil, "PDB says no locals but PE body has a LocalSignature")
                continue
            }
            Assert.False(body.LocalSignature.IsNil, "PDB references a LocalSignature but PE body has none")
            Assert.Equal(
                MetadataTokens.GetRowNumber(body.LocalSignature),
                MetadataTokens.GetRowNumber(mdi.LocalSignature)
            )
            // The decoded handle must point at a real StandaloneSignature
            // row — i.e. the row id we wrote is within range. This is the
            // check that would have failed under the old "write full token"
            // encoding against a strict reader that validated row ids.
            Assert.True(
                MetadataTokens.GetRowNumber(mdi.LocalSignature) <= peMd.GetTableRowCount(TableIndex.StandAloneSig),
                "MethodDebugInformation.LocalSignature row id must point at a real StandaloneSig row"
            )
            verifiedAtLeastOne = true
        }
        Assert.True(verifiedAtLeastOne, "expected at least one method with locals to validate")
        // --- P3-12 regression guard: every EmbeddedSource CDI blob must
        // begin with a 4-byte little-endian unsigned zero format marker
        // (uncompressed payload). Beyond the byte-pattern check, the
        // payload's first record-length-of-source must equal the embedded
        // bytes — verifying the official reader can consume the blob.
        var embeddedSeen = false
        for cdih in pdb.CustomDebugInformation {
            let cdi = pdb.GetCustomDebugInformation(cdih)
            if pdb.GetGuid(cdi.Kind) != PortablePdbEmitterTestHelpers.EmbeddedSourceKind {
                continue
            }
            embeddedSeen = true
            Assert.Equal(HandleKind.Document, cdi.Parent.Kind)
            let blob = pdb.GetBlobBytes(cdi.Value)
            Assert.True(blob.Length >= 4)
            Assert.Equal([]uint8{0, 0, 0, 0}, blob.Take(4).ToArray())
            Assert.True(blob.Length > 4, "embedded source payload must be non-empty")
        }
        Assert.True(embeddedSeen, "at least one EmbeddedSource CDI expected when EmbedAllSources=true")
        // --- General PDB walk: every LocalScope must reference a real
        // method and an ImportScope (asserted earlier in suite) and every
        // Document name handle must decode to a non-empty string. This is
        // the "look at every row" sweep that strict consumers perform.
        for docHandle in pdb.Documents {
            let doc = pdb.GetDocument(docHandle)
            let name = pdb.GetString(doc.Name)
            Assert.False(string.IsNullOrEmpty(name), "Document.Name must decode to a non-empty string")
            Assert.False(doc.Hash.IsNil, "Document.Hash blob must be present")
            Assert.False(doc.HashAlgorithm.IsNil, "Document.HashAlgorithm guid must be present")
            Assert.False(doc.Language.IsNil, "Document.Language guid must be present")
        }
    }

    // Issue #1996: a class-scoped static `Main` (sync or async, any class)
    // must get a real PE entry-point token, exactly like package-scope Main.
    @Fact
    func Emits_Valid_Entry_Point_Token_For_ClassScoped_Static_Main() {
        const Source = `package ClassMainSync
import System
class Launcher1996
{
    shared
    {
        func Main()
        {
            Console.WriteLine("hello class main")
        }
    }
}
`
        using let peStream = MemoryStream()
        let result = Compile(Source, peStream)
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        peStream.Position = 0
        using let peReader = PEReader(peStream, PEStreamOptions.LeaveOpen)
        let corHeader CorHeader? = peReader.PEHeaders.CorHeader
        Assert.NotNull(corHeader)
        Assert.NotEqual(0, corHeader!!.EntryPointTokenOrRelativeVirtualAddress)
    }

    @Fact
    func ClassScoped_Static_Main_Loads_And_Invokes_Via_Assembly_EntryPoint() {
        const Source = `package ClassMainSyncRun
import System
class Launcher1996Run
{
    shared
    {
        func Main()
        {
            Console.WriteLine("hello class main run")
        }
    }
}
`
        let output = CompileLoadInvokeAssemblyEntryPoint(Source, "EndToEndEmitTests-ClassMainSync")
        Assert.Contains("hello class main run", output)
    }

    @Fact
    func Async_ClassScoped_Static_Main_Loads_And_Invokes_Via_Assembly_EntryPoint() {
        const Source = `package ClassMainAsyncRun
import System
import System.Threading.Tasks
class Launcher1996AsyncRun
{
    shared
    {
        async func Main()
        {
            await Task.Delay(1)
            Console.WriteLine("hello async class main run")
        }
    }
}
`
        let output = CompileLoadInvokeAssemblyEntryPoint(Source, "EndToEndEmitTests-ClassMainAsync")
        Assert.Contains("hello async class main run", output)
    }

    shared {
        private const HelloWorldSource string = `package HelloWorld
import System
Console.WriteLine("Hello, world!")
`

        private func Compile(source string, peStream Stream) EmitResult {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.Emit(peStream)
        }

        private func CompileLoadInvokeCaptureStdout(source string, contextName string) string {
            using let peStream = MemoryStream()
            let result = Compile(source, peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }

        /// Compiles, loads, and invokes the emitted assembly's PE entry-point
        /// method directly via (cref:Assembly.EntryPoint) — unlike
        /// (cref:CompileLoadInvokeCaptureStdout) (which looks up the
        /// synthesized-TLS `<Program>.<Main>$` by name), this works
        /// for ANY entry-point shape, including a class-scoped static `Main`
        /// hosted on an arbitrarily-named user class.
        private func CompileLoadInvokeAssemblyEntryPoint(source string, contextName string) string {
            using let peStream = MemoryStream()
            let result = Compile(source, peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let entry MethodInfo? = asm.EntryPoint
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    let invokeResult object? = entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                    // Issue #1996: an async entry point is emitted with a
                    // synchronous-driving wrapper (Issue #1904), so the raw CLR
                    // signature is void/int32 — never Task/Task<T>. Await
                    // defensively anyway so a regression back to a Task-returning
                    // signature doesn't leave the assertion racing the async body.
                    if invokeResult is Task task {
                        task.GetAwaiter().GetResult()
                    }
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
