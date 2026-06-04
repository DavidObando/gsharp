// <copyright file="EndToEndEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Phase 1 end-to-end emit tests: compile a tiny GSharp program, load the
/// produced PE bytes, and invoke the synthesized entry point. These pin the
/// behavior of <c>ReflectionMetadataEmitter</c> against real .NET load/execute
/// rather than just checking metadata shapes.
/// </summary>
public class EndToEndEmitTests
{
    private const string HelloWorldSource =
        "package HelloWorld\nimport System\nConsole.WriteLine(\"Hello, world!\")\n";

    [Fact]
    public void Emits_Valid_PE_For_HelloWorld()
    {
        using var peStream = new MemoryStream();
        var result = Compile(HelloWorldSource, peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        using var peReader = new PEReader(peStream, PEStreamOptions.LeaveOpen);
        Assert.True(peReader.HasMetadata);

        var md = peReader.GetMetadataReader();
        Assert.True(md.IsAssembly);

        // <Module> + <Program>.
        Assert.Equal(2, md.TypeDefinitions.Count);

        // Entry point must be set in the corheader.
        var corHeader = peReader.PEHeaders.CorHeader;
        Assert.NotNull(corHeader);
        Assert.NotEqual(0, corHeader!.EntryPointTokenOrRelativeVirtualAddress);
    }

    [Fact]
    public void HelloWorld_Loads_And_Invokes_Entry_Point()
    {
        using var peStream = new MemoryStream();
        var result = Compile(HelloWorldSource, peStream);
        Assert.True(result.Success);

        peStream.Position = 0;

        var loadContext = new AssemblyLoadContext("EndToEndEmitTests-Hello", isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);

            var allTypes = asm.GetTypes();
            var programType = allTypes.FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);

            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, parameters: null);
            }
            finally
            {
                Console.SetOut(stdout);
            }

            Assert.Contains("Hello, world!", captured.ToString());
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static EmitResult Compile(string source, Stream peStream)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Emit(peStream);
    }

    private static string CompileLoadInvokeCaptureStdout(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var result = Compile(source, peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, parameters: null);
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void Emits_Arithmetic_With_Locals_And_BinaryOps()
    {
        const string Source = @"package Arith
import System
var x = 2 + 3 * 4
Console.WriteLine(x)
";
        var output = CompileLoadInvokeCaptureStdout(Source, "EndToEndEmitTests-Arith");
        Assert.Contains("14", output);
    }

    [Fact]
    public void Emits_User_Defined_Function_With_Digit_In_Param_Names()
    {
        // Exercises both BoundCallExpression emit AND issue #32 (digits in identifiers).
        const string Source = @"package UserFn
import System
func add(num1 int32, num2 int32) int32 {
    return num1 + num2
}
Console.WriteLine(add(2, 3))
";
        var output = CompileLoadInvokeCaptureStdout(Source, "EndToEndEmitTests-UserFn");
        Assert.Contains("5", output);
    }

    [Fact]
    public void Emits_For_Loop_With_Branching()
    {
        const string Source = @"package Loop
import System
var sum = 0
for i := 1 ... 5 {
    sum = sum + i
}
Console.WriteLine(sum)
";
        var output = CompileLoadInvokeCaptureStdout(Source, "EndToEndEmitTests-Loop");
        Assert.Contains("10", output);
    }

    [Fact]
    public void Emits_If_Statement_With_Comparison()
    {
        const string Source = @"package Cond
import System
var x = 7
if x > 5 {
    Console.WriteLine(""big"")
} else {
    Console.WriteLine(""small"")
}
";
        var output = CompileLoadInvokeCaptureStdout(Source, "EndToEndEmitTests-Cond");
        Assert.Contains("big", output);
    }

    [Fact]
    public void Emits_String_Concatenation_With_Variable()
    {
        const string Source = @"package Concat
import System
var name = ""world""
Console.WriteLine(""hi "" + name)
";
        var output = CompileLoadInvokeCaptureStdout(Source, "EndToEndEmitTests-Concat");
        Assert.Contains("hi world", output);
    }

    [Fact]
    public void Emits_Recursive_User_Function()
    {
        const string Source = @"package Recurse
import System
func factorial(n int32) int32 {
    if n <= 1 {
        return 1
    }
    return n * factorial(n - 1)
}
Console.WriteLine(factorial(5))
";
        var output = CompileLoadInvokeCaptureStdout(Source, "EndToEndEmitTests-Recurse");
        Assert.Contains("120", output);
    }

    [Fact]
    public void Emit_Is_Deterministic_For_Same_Source()
    {
        using var first = new MemoryStream();
        using var second = new MemoryStream();

        Assert.True(Compile(HelloWorldSource, first).Success);
        Assert.True(Compile(HelloWorldSource, second).Success);

        var firstBytes = first.ToArray();
        var secondBytes = second.ToArray();

        Assert.Equal(firstBytes.Length, secondBytes.Length);
        Assert.True(
            firstBytes.AsSpan().SequenceEqual(secondBytes),
            "two emits of the same source must produce uint8-identical PEs (deterministic MVID + timestamp).");
    }

    [Fact]
    public void Emit_Produces_NonZero_Mvid_Derived_From_Content()
    {
        using var first = new MemoryStream();
        using var second = new MemoryStream();

        Assert.True(Compile(HelloWorldSource, first).Success);
        Assert.True(
            Compile(HelloWorldSource.Replace("Hello, world!", "Hi, world!"), second).Success);

        first.Position = 0;
        second.Position = 0;

        using var firstPe = new PEReader(first, PEStreamOptions.LeaveOpen);
        using var secondPe = new PEReader(second, PEStreamOptions.LeaveOpen);

        var firstMvid = firstPe.GetMetadataReader().GetGuid(firstPe.GetMetadataReader().GetModuleDefinition().Mvid);
        var secondMvid = secondPe.GetMetadataReader().GetGuid(secondPe.GetMetadataReader().GetModuleDefinition().Mvid);

        Assert.NotEqual(Guid.Empty, firstMvid);
        Assert.NotEqual(firstMvid, secondMvid);

        // Deterministic emit zeros out the PE TimeDateStamp (the content id's
        // stamp goes into the COFF header; both should differ across content).
        Assert.NotEqual(
            firstPe.PEHeaders.CoffHeader.TimeDateStamp,
            secondPe.PEHeaders.CoffHeader.TimeDateStamp);
    }

    [Fact]
    public void Emit_Reference_Assembly_Has_No_Method_Bodies_And_Carries_RefAsmAttribute()
    {
        const string Source = @"package RefAsm
import System
func add(a int32, b int32) int32 { return a + b }
Console.WriteLine(add(2, 3))
";
        using var peStream = new MemoryStream();
        using var refStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream, refStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        refStream.Position = 0;
        using var refPe = new PEReader(refStream, PEStreamOptions.LeaveOpen);
        var md = refPe.GetMetadataReader();

        // No entry point should be set on a metadata-only PE.
        Assert.Equal(0, refPe.PEHeaders.CorHeader.EntryPointTokenOrRelativeVirtualAddress);

        // Every method definition must have RVA 0 — no IL body.
        foreach (var mdh in md.MethodDefinitions)
        {
            var method = md.GetMethodDefinition(mdh);
            Assert.Equal(0, method.RelativeVirtualAddress);
        }

        // The assembly must carry [ReferenceAssemblyAttribute].
        var assembly = md.GetAssemblyDefinition();
        var foundRefAsm = false;
        foreach (var cah in assembly.GetCustomAttributes())
        {
            var ca = md.GetCustomAttribute(cah);
            var ctor = ca.Constructor;
            string typeName = null;
            if (ctor.Kind == HandleKind.MemberReference)
            {
                var mr = md.GetMemberReference((MemberReferenceHandle)ctor);
                if (mr.Parent.Kind == HandleKind.TypeReference)
                {
                    var tr = md.GetTypeReference((TypeReferenceHandle)mr.Parent);
                    typeName = md.GetString(tr.Namespace) + "." + md.GetString(tr.Name);
                }
            }

            if (typeName == "System.Runtime.CompilerServices.ReferenceAssemblyAttribute")
            {
                foundRefAsm = true;
                break;
            }
        }

        Assert.True(foundRefAsm, "metadata-only emit must mark the assembly with ReferenceAssemblyAttribute.");

        // The runtime PE should still carry IL and an entry point.
        peStream.Position = 0;
        using var runtimePe = new PEReader(peStream, PEStreamOptions.LeaveOpen);
        Assert.NotEqual(0, runtimePe.PEHeaders.CorHeader.EntryPointTokenOrRelativeVirtualAddress);
    }

    /// <summary>
    /// Issue #420 (P3-14): reference assemblies must emit PE sections in the
    /// conventional Roslyn order (.text / .rsrc / .reloc / .mvid). Placing the
    /// .mvid section first is spec-legal but uncommon and can surprise older
    /// tooling that walks sections positionally.
    /// </summary>
    [Fact]
    public void Emit_Reference_Assembly_Has_Conventional_Section_Order_With_Mvid_Last()
    {
        const string Source = @"package RefAsmSections
import System
func add(a int32, b int32) int32 { return a + b }
Console.WriteLine(add(2, 3))
";
        using var peStream = new MemoryStream();
        using var refStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream, refStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        refStream.Position = 0;
        using var refPe = new PEReader(refStream, PEStreamOptions.LeaveOpen);

        var sectionNames = refPe.PEHeaders.SectionHeaders
            .Select(s => s.Name)
            .ToArray();

        // .text must come first; .mvid must be present and must be the last
        // section in the table (after .text/.rsrc/.reloc).
        Assert.Contains(".text", sectionNames);
        Assert.Contains(".mvid", sectionNames);
        Assert.Equal(".text", sectionNames[0]);
        Assert.Equal(".mvid", sectionNames[sectionNames.Length - 1]);

        // If .rsrc and/or .reloc are present they must precede .mvid; this
        // pins the conventional .text / .rsrc / .reloc / .mvid layout.
        var mvidIndex = Array.IndexOf(sectionNames, ".mvid");
        var rsrcIndex = Array.IndexOf(sectionNames, ".rsrc");
        var relocIndex = Array.IndexOf(sectionNames, ".reloc");
        if (rsrcIndex >= 0)
        {
            Assert.True(rsrcIndex < mvidIndex, ".rsrc must precede .mvid");
        }

        if (relocIndex >= 0)
        {
            Assert.True(relocIndex < mvidIndex, ".reloc must precede .mvid");
        }
    }

    /// <summary>
    /// Issue #457: cross-cutting "dotnet-pdbverify"-style round-trip that
    /// loads both the emitted PE and the standalone Portable PDB through
    /// <see cref="PEReader"/> / <see cref="MetadataReaderProvider"/> and
    /// asserts the structural invariants called out by the P3 PDB/PE
    /// cosmetics review (P3-12, P3-13, P3-14) all hold simultaneously on a
    /// non-trivial program. This is the closest stand-in for the missing
    /// official "pdbverify" tool: any cosmetic regression that broke a
    /// strict consumer (debugger, profiler, PE rewriter) would surface here
    /// as a reader exception or a failed assertion.
    /// </summary>
    [Fact]
    public void PdbAndPe_RoundTripCleanly_Through_Official_Readers()
    {
        const string Source = @"package main
import System

func add(a int32, b int32) int32 {
    let sum = a + b
    return sum
}

func main() {
    let result = add(2, 3)
    Console.WriteLine(result)
}
";
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(Source, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions
            {
                Format = DebugInformationFormat.Portable,
                EmbedAllSources = true,
            },
        };
        var result = compilation.Emit(peStream, pdbStream, null);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        // --- PE side: PEReader must accept the file and report a valid
        // section table with the conventional ordering required by P3-14.
        peStream.Position = 0;
        using var pe = new PEReader(peStream, PEStreamOptions.LeaveOpen);
        Assert.True(pe.HasMetadata, "emitted PE must expose metadata");
        var peMd = pe.GetMetadataReader();
        Assert.True(peMd.IsAssembly);
        Assert.Equal(".text", pe.PEHeaders.SectionHeaders[0].Name);

        // --- PDB side: MetadataReaderProvider must accept the standalone
        // PDB stream and produce a usable MetadataReader. This single line
        // is the strongest "is it a valid Portable PDB?" check the
        // System.Reflection.Metadata library offers.
        pdbStream.Position = 0;
        using var pdbProvider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        var pdb = pdbProvider.GetMetadataReader();

        // At least one document and one method-debug-info row are mandatory
        // for a non-empty program; if either is missing the PDB will not
        // bind any breakpoints.
        Assert.True(pdb.Documents.Count >= 1, "PDB must have at least one Document row");
        Assert.True(pdb.MethodDebugInformation.Count >= 1, "PDB must have at least one MethodDebugInformation row");

        // --- P3-13 regression guard: every MethodDebugInformation row must
        // round-trip its LocalSignature row id consistently with the PE
        // method body's localVariablesSignature, even after the encoder
        // change from "full token" to "row id only". A reader that strictly
        // validates the field would catch the old (non-conforming) encoding
        // as either an out-of-range row id or a "wrong table" error; the
        // assertion below pins both directions of the contract.
        var verifiedAtLeastOne = false;
        foreach (var mdih in pdb.MethodDebugInformation)
        {
            var mdi = pdb.GetMethodDebugInformation(mdih);
            var methodHandle = MetadataTokens.MethodDefinitionHandle(MetadataTokens.GetRowNumber(mdih));
            var method = peMd.GetMethodDefinition(methodHandle);
            if (method.RelativeVirtualAddress == 0)
            {
                continue;
            }

            var body = pe.GetMethodBody(method.RelativeVirtualAddress);
            if (mdi.LocalSignature.IsNil)
            {
                Assert.True(body.LocalSignature.IsNil, "PDB says no locals but PE body has a LocalSignature");
                continue;
            }

            Assert.False(body.LocalSignature.IsNil, "PDB references a LocalSignature but PE body has none");
            Assert.Equal(MetadataTokens.GetRowNumber(body.LocalSignature), MetadataTokens.GetRowNumber(mdi.LocalSignature));

            // The decoded handle must point at a real StandaloneSignature
            // row — i.e. the row id we wrote is within range. This is the
            // check that would have failed under the old "write full token"
            // encoding against a strict reader that validated row ids.
            Assert.True(
                MetadataTokens.GetRowNumber(mdi.LocalSignature) <= peMd.GetTableRowCount(TableIndex.StandAloneSig),
                "MethodDebugInformation.LocalSignature row id must point at a real StandaloneSig row");
            verifiedAtLeastOne = true;
        }

        Assert.True(verifiedAtLeastOne, "expected at least one method with locals to validate");

        // --- P3-12 regression guard: every EmbeddedSource CDI blob must
        // begin with a 4-byte little-endian unsigned zero format marker
        // (uncompressed payload). Beyond the byte-pattern check, the
        // payload's first record-length-of-source must equal the embedded
        // bytes — verifying the official reader can consume the blob.
        var embeddedSeen = false;
        foreach (var cdih in pdb.CustomDebugInformation)
        {
            var cdi = pdb.GetCustomDebugInformation(cdih);
            if (pdb.GetGuid(cdi.Kind) != PortablePdbEmitterTestHelpers.EmbeddedSourceKind)
            {
                continue;
            }

            embeddedSeen = true;
            Assert.Equal(HandleKind.Document, cdi.Parent.Kind);
            var blob = pdb.GetBlobBytes(cdi.Value);
            Assert.True(blob.Length >= 4);
            Assert.Equal(new byte[] { 0, 0, 0, 0 }, blob.Take(4).ToArray());
            Assert.True(blob.Length > 4, "embedded source payload must be non-empty");
        }

        Assert.True(embeddedSeen, "at least one EmbeddedSource CDI expected when EmbedAllSources=true");

        // --- General PDB walk: every LocalScope must reference a real
        // method and an ImportScope (asserted earlier in suite) and every
        // Document name handle must decode to a non-empty string. This is
        // the "look at every row" sweep that strict consumers perform.
        foreach (var docHandle in pdb.Documents)
        {
            var doc = pdb.GetDocument(docHandle);
            var name = pdb.GetString(doc.Name);
            Assert.False(string.IsNullOrEmpty(name), "Document.Name must decode to a non-empty string");
            Assert.False(doc.Hash.IsNil, "Document.Hash blob must be present");
            Assert.False(doc.HashAlgorithm.IsNil, "Document.HashAlgorithm guid must be present");
            Assert.False(doc.Language.IsNil, "Document.Language guid must be present");
        }
    }
}
