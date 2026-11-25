// <copyright file="Issue6037ReturnContractScalingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import CompilationMeasurements = GSharp.Core.CodeAnalysis.Compilation.CompilationMeasurements
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Threading.Tasks
import Xunit
import Xunit.Abstractions

/// Issue #6037: measure and bound return-contract graph construction and
/// propagation cost across reverse-ordered forwarding chains, reverse-ordered
/// fixed contract chains, declaration fan-outs, and multi-compilation
/// dependency chains.
/// @remarks Discrimination witness (ADR-0154): on pre-fix commit `3459c35d8`,
/// `ReverseOrderedForwardingChain_NodeAndEdgeVisitsScaleLinearly` fails with
/// quadratic `propIter=130`, `nodeVisits=16900`, `edgeVisits=25026` at N=128;
/// `ReverseOrderedFixedContractChain_VisitsScaleLinearlyAndPreserveNonNullContract`
/// fails with quadratic `fixedIter` and `fixedEdges`;
/// `MultiCompilationDependencyChain_OwnerScansAndVisitsScaleLinearly` fails with
/// `owners=300`, `syntax=69600`, `nodeVisits=15283` at K=24; and
/// `MultiCompilationFanOut_ReusesCoreSummaryAndScalesLinearly` fails with
/// `owners=49`, `syntax=9096`, `nodeVisits=1994` at L=24.
open class Issue6037ReturnContractScalingTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Fact
    func ReverseOrderedForwardingChain_NodeAndEdgeVisitsScaleLinearly() {
        let nodeVisits = List[int64]()
        let edgeVisits = List[int64]()
        let allocations = List[int64]()
        for length in[]int32{8, 32, 64, 128} {
            let source = BuildReverseForwardingChainSource(length)
            let tree = CSharpSyntaxTree.ParseText(source, path: "DirectChain.cs")
            let compilation = CSharpCompilation.Create(
                "Issue6037DirectChain$length",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Disable
                )
            )
            Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error))
            let m0 = compilation.GetTypeByMetadataName("Chain")!!.GetMembers("M0").OfType[IMethodSymbol]().Single()
            let control = compilation.GetTypeByMetadataName("Chain")!!
                .GetMembers("Control")
                .OfType[IMethodSymbol]()
                .Single()
            let (isNullable, controlNullable, stats) = MeasureDirectReturnContract(compilation, m0, control)
            Assert.True(isNullable)
            Assert.False(controlNullable)
            Assert.Equal(1, stats.Builds)
            Assert.Equal(1, stats.PropIterations)
            this.output.WriteLine(
                "DirectReverseChain N=$length: builds=${stats.Builds}, owners=${stats.OwnerScans}, " +
                    "syntax=${stats.SyntaxVisits}, propIter=${stats.PropIterations}, " +
                    "nodeVisits=${stats.NodeVisits}, edgeVisits=${stats.EdgeVisits}, " +
                    "ms=${stats.ElapsedMs}, alloc=${stats.AllocatedBytes}"
            )
            if length != 8 {
                nodeVisits.Add(stats.NodeVisits)
                edgeVisits.Add(stats.EdgeVisits)
                allocations.Add(stats.AllocatedBytes)
            }
        }
        Assert.True(
            nodeVisits[0] > 0 && nodeVisits[1] <= nodeVisits[0] * 3 && nodeVisits[2] <= nodeVisits[1] * 3,
            "Reverse-ordered forwarding chain node visits must scale linearly: ${string.Join(", ", nodeVisits)}."
        )
        Assert.True(
            edgeVisits[0] > 0 && edgeVisits[1] <= edgeVisits[0] * 3 && edgeVisits[2] <= edgeVisits[1] * 3,
            "Reverse-ordered forwarding chain edge visits must scale linearly: ${string.Join(", ", edgeVisits)}."
        )
        Assert.True(
            allocations[0] > 0 && allocations[1] <= allocations[0] * 3 && allocations[2] <= allocations[1] * 3,
            "Reverse-ordered forwarding chain allocations must scale linearly: ${string.Join(", ", allocations)}."
        )

        let runtimeSource = BuildReverseForwardingChainSource(32) + `
public static class Runner
{
    public static void Main()
    {
        System.Console.WriteLine(Chain.M0() == null);
        System.Console.WriteLine(Chain.Control().Result);
    }
}`
        LiteralConstructionRuntimeParity.AssertMatches(
            runtimeSource,
            verifyTranslation: (printed string) -> {
                Assert.Contains("func M0() Task[int32]?", printed, StringComparison.Ordinal)
                Assert.Contains("func Control() Task[int32] ->", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("func Control() Task[int32]?", printed, StringComparison.Ordinal)
            },
            verifyIL: true,
            nullableContextOptions: NullableContextOptions.Disable,
            expectedOutput: string.Join(Environment.NewLine, []string{"True", "1", ""})
        )
    }

    @Fact
    func ReverseOrderedFixedContractChain_VisitsScaleLinearlyAndPreserveNonNullContract() {
        let libSource = `
#nullable enable
using System.Threading.Tasks;
namespace Library
{
    public interface IRequired { Task<int> Read(); }
}`
        let libTree = CSharpSyntaxTree.ParseText(libSource, path: "Library.cs")
        let libCompilation = CSharpCompilation.Create(
            "Library",
            []SyntaxTree{libTree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Enable
            )
        )
        using let libStream = MemoryStream()
        Assert.True(libCompilation.Emit(libStream).Success)
        let references = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromImage(libStream.ToArray()))
            .ToArray()

        let fixedEdgeVisits = List[int64]()
        let nodeVisits = List[int64]()
        for length in[]int32{8, 32, 64, 128} {
            let sb = StringBuilder()
            sb.AppendLine("#nullable disable")
            sb.AppendLine("using System.Diagnostics.CodeAnalysis;")
            sb.AppendLine("using System.Threading.Tasks;")
            sb.AppendLine("using Library;")
            for var i = length; i >= 1; i-- {
                sb.AppendLine("public class C$i : C${i - 1} { public override Task<int> Read() => base.Read(); }")
            }
            sb.AppendLine(
                "public class C0 : IRequired { [return: MaybeNull] public virtual Task<int> Read() => null; }"
            )
            let tree = CSharpSyntaxTree.ParseText(sb.ToString(), path: "FixedChain.cs")
            let compilation = CSharpCompilation.Create(
                "Issue6037FixedChain$length",
                []SyntaxTree{tree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Disable
                )
            )
            Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error))
            let leaf = compilation.GetTypeByMetadataName("C$length")!!
                .GetMembers("Read")
                .OfType[IMethodSymbol]()
                .Single()
            let root = compilation.GetTypeByMetadataName("C0")!!.GetMembers("Read").OfType[IMethodSymbol]().Single()
            let (leafNullable, rootNullable, stats) = MeasureDirectReturnContract(compilation, leaf, root)
            Assert.False(leafNullable)
            Assert.False(rootNullable)
            Assert.Equal(1, stats.FixedIterations)
            this.output.WriteLine(
                "FixedChain N=$length: fixedIter=${stats.FixedIterations}, fixedEdges=${stats.FixedEdgeVisits}, " +
                    "nodeVisits=${stats.NodeVisits}, edgeVisits=${stats.EdgeVisits}, alloc=${stats.AllocatedBytes}"
            )
            if length != 8 {
                fixedEdgeVisits.Add(stats.FixedEdgeVisits)
                nodeVisits.Add(stats.NodeVisits)
            }
        }
        Assert.True(
            fixedEdgeVisits[0] > 0 &&
                fixedEdgeVisits[1] <= fixedEdgeVisits[0] * 3 &&
                fixedEdgeVisits[2] <= fixedEdgeVisits[1] * 3,
            "Reverse-ordered fixed-contract edge visits must scale linearly: ${string.Join(", ", fixedEdgeVisits)}."
        )
        Assert.True(
            nodeVisits[0] >= 0 && nodeVisits[1] <= Math.Max(int64(1), nodeVisits[0]) * 3,
            "Fixed-contract nodes must not loop in value propagation: ${string.Join(", ", nodeVisits)}."
        )
    }

    @Fact
    func MultiCompilationDependencyChain_OwnerScansAndVisitsScaleLinearly() {
        let ownerScans = List[int64]()
        let syntaxVisits = List[int64]()
        let nodeVisits = List[int64]()
        let edgeVisits = List[int64]()
        for count in[]int32{2, 6, 12, 24} {
            let declarationsPerProject = 16
            let compilations = BuildCompilationChain(count, declarationsPerProject)
            let stats = MeasureDirectCatalogReturnContracts(compilations)
            Assert.Equal(int64(count), stats.Builds)
            Assert.Equal(int64(count), stats.OwnerScans)
            this.output.WriteLine(
                "DirectDepChain K=$count D=$declarationsPerProject: builds=${stats.Builds}, owners=${stats.OwnerScans}, " +
                    "syntax=${stats.SyntaxVisits}, propIter=${stats.PropIterations}, " +
                    "nodeVisits=${stats.NodeVisits}, edgeVisits=${stats.EdgeVisits}, " +
                    "ms=${stats.ElapsedMs}, alloc=${stats.AllocatedBytes}"
            )
            if count != 2 {
                ownerScans.Add(stats.OwnerScans)
                syntaxVisits.Add(stats.SyntaxVisits)
                nodeVisits.Add(stats.NodeVisits)
                edgeVisits.Add(stats.EdgeVisits)
            }
        }
        Assert.True(
            ownerScans[0] > 0 && ownerScans[1] <= ownerScans[0] * 3 && ownerScans[2] <= ownerScans[1] * 3,
            "Dependency chain owner scans must scale linearly: ${string.Join(", ", ownerScans)}."
        )
        Assert.True(
            syntaxVisits[0] > 0 && syntaxVisits[1] <= syntaxVisits[0] * 3 && syntaxVisits[2] <= syntaxVisits[1] * 3,
            "Dependency chain syntax visits must scale linearly: ${string.Join(", ", syntaxVisits)}."
        )
        Assert.True(
            nodeVisits[0] > 0 && nodeVisits[1] <= nodeVisits[0] * 3 && nodeVisits[2] <= nodeVisits[1] * 3,
            "Dependency chain node visits must scale linearly: ${string.Join(", ", nodeVisits)}."
        )
        Assert.True(
            edgeVisits[0] > 0 && edgeVisits[1] <= edgeVisits[0] * 3 && edgeVisits[2] <= edgeVisits[1] * 3,
            "Dependency chain edge visits must scale linearly: ${string.Join(", ", edgeVisits)}."
        )
    }

    @Fact
    func MultiCompilationFanOut_ReusesCoreSummaryAndScalesLinearly() {
        let ownerScans = List[int64]()
        let syntaxVisits = List[int64]()
        let nodeVisits = List[int64]()
        let edgeVisits = List[int64]()
        for leafCount in[]int32{2, 6, 12, 24} {
            let coreDeclarations = 24
            let compilations = BuildCompilationFanOut(leafCount, coreDeclarations)
            let stats = MeasureCatalogTranslation(compilations)
            Assert.Equal(int64(leafCount + 1), stats.Builds)
            Assert.Equal(int64(leafCount + 1), stats.OwnerScans)
            this.output.WriteLine(
                "FanOut L=$leafCount D=$coreDeclarations: builds=${stats.Builds}, owners=${stats.OwnerScans}, " +
                    "syntax=${stats.SyntaxVisits}, propIter=${stats.PropIterations}, " +
                    "nodeVisits=${stats.NodeVisits}, edgeVisits=${stats.EdgeVisits}, " +
                    "ms=${stats.ElapsedMs}, alloc=${stats.AllocatedBytes}"
            )
            if leafCount != 2 {
                ownerScans.Add(stats.OwnerScans)
                syntaxVisits.Add(stats.SyntaxVisits)
                nodeVisits.Add(stats.NodeVisits)
                edgeVisits.Add(stats.EdgeVisits)
            }
        }
        Assert.True(
            ownerScans[0] > 0 && ownerScans[1] <= ownerScans[0] * 3 && ownerScans[2] <= ownerScans[1] * 3,
            "Fan-out owner scans must scale linearly: ${string.Join(", ", ownerScans)}."
        )
        Assert.True(
            syntaxVisits[0] > 0 && syntaxVisits[1] <= syntaxVisits[0] * 3 && syntaxVisits[2] <= syntaxVisits[1] * 3,
            "Fan-out syntax visits must scale linearly: ${string.Join(", ", syntaxVisits)}."
        )
        Assert.True(
            nodeVisits[0] > 0 && nodeVisits[1] <= nodeVisits[0] * 3 && nodeVisits[2] <= nodeVisits[1] * 3,
            "Fan-out node visits must scale linearly: ${string.Join(", ", nodeVisits)}."
        )
        Assert.True(
            edgeVisits[0] > 0 && edgeVisits[1] <= edgeVisits[0] * 3 && edgeVisits[2] <= edgeVisits[1] * 3,
            "Fan-out edge visits must scale linearly: ${string.Join(", ", edgeVisits)}."
        )
    }

    @Fact
    func DiamondFanOut_PreservesDistinctTaskEnvelopeAndResultDomainsAcrossProjects() {
        let options = CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
            NullableContextOptions.Disable
        )
        let EmitBytes = (compilation CSharpCompilation) -> {
            Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error))
            using let stream = MemoryStream()
            let res = compilation.Emit(stream)
            Assert.True(res.Success, string.Join(Environment.NewLine, res.Diagnostics))
            return stream.ToArray()
        }
        let coreTree = CSharpSyntaxTree.ParseText(`
#nullable disable
using System.Diagnostics.CodeAnalysis;
using System.Threading.Tasks;
public static class Core
{
    public static int Calls;
    [return: MaybeNull]
    public static Task<int> EmptyEnvelope() { Calls++; return null; }
    public static async Task<string> MissingPayload() { Calls++; await Task.Yield(); return null; }
    public static Task<string> Present() => Task.FromResult("ok");
}`, path: "Core.cs")
        let core = CSharpCompilation.Create(
            "Core",
            []SyntaxTree{coreTree},
            CSharpProjectLoader.RuntimeReferences(),
            options
        )
        let coreBytes = EmitBytes(core)
        let coreRef = MetadataReference.CreateFromImage(coreBytes)

        let leftTree = CSharpSyntaxTree.ParseText(`
#nullable disable
using System.Threading.Tasks;
public static class Left
{
    public static Task<int> ReadEnvelope() => Core.EmptyEnvelope();
    public static Task<string> ReadPayload() => Core.MissingPayload();
}`, path: "Left.cs")
        let left = CSharpCompilation.Create(
            "Left",
            []SyntaxTree{leftTree},
            CSharpProjectLoader.RuntimeReferences().Append(coreRef).ToArray(),
            options
        )
        let leftBytes = EmitBytes(left)

        let rightTree = CSharpSyntaxTree.ParseText(`
#nullable disable
using System.Threading.Tasks;
public static class Right
{
    public static Task<string> ReadPresent() => Core.Present();
    public static Task<int> Control() => Task.FromResult(7);
}`, path: "Right.cs")
        let right = CSharpCompilation.Create(
            "Right",
            []SyntaxTree{rightTree},
            CSharpProjectLoader.RuntimeReferences().Append(coreRef).ToArray(),
            options
        )
        let rightBytes = EmitBytes(right)

        let appTree = CSharpSyntaxTree.ParseText(`
#nullable disable
using System;
using System.Threading.Tasks;
public static class App
{
    public static Task<int> Envelope() => Left.ReadEnvelope();
    public static string PayloadSync() => Left.ReadPayload().GetAwaiter().GetResult();
    public static string PresentSync() => Right.ReadPresent().GetAwaiter().GetResult();
    public static void Main()
    {
        Console.WriteLine(Envelope() == null);
        Console.WriteLine(PayloadSync() == null);
        Console.WriteLine(PresentSync().Length);
        Console.WriteLine(Right.Control().Result);
        Console.WriteLine(Core.Calls);
    }
}`, path: "App.cs")
        let app = CSharpCompilation.Create(
            "App",
            []SyntaxTree{appTree},
            CSharpProjectLoader
                .RuntimeReferences()
                .Append(coreRef)
                .Append(MetadataReference.CreateFromImage(leftBytes))
                .Append(MetadataReference.CreateFromImage(rightBytes))
                .ToArray(),
            options.WithOutputKind(OutputKind.ConsoleApplication)
        )
        let appBytes = EmitBytes(app)
        let catalog = []CSharpCompilation{core, left, right, app}
        let emitted = List[string]()
        let translator = CSharpToGSharpTranslator()
        for comp in catalog {
            let tree = comp.SyntaxTrees.Single()
            let model = comp.GetSemanticModel(tree)
            let context = TranslationContext(comp, model, tree.FilePath, catalog, catalog)
            emitted.Add(
                GSharpPrinter.Print(translator.TranslateDocument(LoadedDocument(tree.FilePath, tree, model), context))
            )
        }
        Assert.Contains("func ReadEnvelope() Task[int32]?", emitted[1], StringComparison.Ordinal)
        Assert.DoesNotContain("Task[int32]?", emitted[2], StringComparison.Ordinal)
        Assert.Contains("func ReadPresent() Task[string]", emitted[2], StringComparison.Ordinal)
        Assert.Contains("func Envelope() Task[int32]?", emitted[3], StringComparison.Ordinal)
        Assert.Contains("func PayloadSync() string?", emitted[3], StringComparison.Ordinal)
        Assert.Contains("func PresentSync() string ->", emitted[3], StringComparison.Ordinal)

        let directory = Path.Combine(AppContext.BaseDirectory, "issue-6037-diamond", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            File.WriteAllBytes(Path.Combine(directory, "Core.dll"), coreBytes)
            File.WriteAllBytes(Path.Combine(directory, "Left.dll"), leftBytes)
            File.WriteAllBytes(Path.Combine(directory, "Right.dll"), rightBytes)
            let nativeApp = Path.Combine(directory, "App.dll")
            File.WriteAllBytes(nativeApp, appBytes)
            File.WriteAllText(
                Path.Combine(directory, "App.runtimeconfig.json"),
                `{"runtimeOptions":{"tfm":"net10.0","framework":{"name":"Microsoft.NETCore.App","version":"10.0.0"}}}`
            )
            let expected = LiteralConstructionRuntimeParity.RunDotnet([]string{nativeApp})
            Assert.Equal(
                Encoding.UTF8.GetBytes(string.Join(Environment.NewLine, []string{"True", "True", "2", "7", "2", ""})),
                expected
            )
            let compiler = LiteralConstructionRuntimeParity.FindCompiler()
            let Compile = (name string, src string, refs IEnumerable[string], exe bool) -> {
                let gsPath = Path.Combine(directory, name + ".gs")
                let dllPath = Path.Combine(directory, name + ".dll")
                File.WriteAllText(gsPath, src)
                let args = List[string]{
                    compiler,
                    if exe {
                        "/target:exe"
                    } else {
                        "/target:library"
                    },
                    "/targetframework:net10.0",
                    "/assemblyname:" + name,
                    "/out:" + dllPath
                }
                for r in refs {
                    args.Add("/reference:" + Path.Combine(directory, r + ".dll"))
                }
                args.Add(gsPath)
                LiteralConstructionRuntimeParity.RunDotnet(args.ToArray(), src)
                return dllPath
            }
            Compile("Core", emitted[0], Array.Empty[string](), false)
            Compile("Left", emitted[1], []string{"Core"}, false)
            Compile("Right", emitted[2], []string{"Core"}, false)
            let compiledApp = Compile("App", emitted[3], []string{"Core", "Left", "Right"}, true)
            let verified = IlVerifyRunner().Verify(compiledApp)
            Assert.True(verified.Status == IlVerifyStatus.Passed, verified.Output)
            Assert.Empty(verified.Errors)
            Assert.Equal(expected, LiteralConstructionRuntimeParity.RunDotnet([]string{compiledApp}, emitted[3]))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func CrossCompilationDownstreamWriteIntoUpstream_PropagatesOnlyWhenWrittenNullable(passNull bool) {
        let options = CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
            NullableContextOptions.Disable
        )
        let EmitBytes = (compilation CSharpCompilation) -> {
            using let stream = MemoryStream()
            Assert.True(compilation.Emit(stream).Success)
            return stream.ToArray()
        }
        let cTree = CSharpSyntaxTree.ParseText(`
#nullable disable
using System.Threading.Tasks;
public static class C
{
    public static Task<int> Id(Task<int> value) => value;
}`, path: "C.cs")
        let c = CSharpCompilation.Create("C", []SyntaxTree{cTree}, CSharpProjectLoader.RuntimeReferences(), options)
        let cRef = MetadataReference.CreateFromImage(EmitBytes(c))

        let bTree = CSharpSyntaxTree.ParseText(`
#nullable disable
using System.Threading.Tasks;
public static class B
{
    public static Task<int> Forward() => C.Id(Task.FromResult(1));
}`, path: "B.cs")
        let b = CSharpCompilation.Create(
            "B",
            []SyntaxTree{bTree},
            CSharpProjectLoader.RuntimeReferences().Append(cRef).ToArray(),
            options
        )
        let bRef = MetadataReference.CreateFromImage(EmitBytes(b))

        let aArg = if passNull {
            "Empty()"
        } else {
            "Task.FromResult(2)"
        }
        let aTree = CSharpSyntaxTree.ParseText(`
#nullable disable
using System.Diagnostics.CodeAnalysis;
using System.Threading.Tasks;
public static class A
{
    [return: MaybeNull]
    static Task<int> Empty() => null;
    public static Task<int> Touch() => C.Id(` + aArg + `);
    public static Task<int> Read() => B.Forward();
}`, path: "A.cs")
        let a = CSharpCompilation.Create(
            "A",
            []SyntaxTree{aTree},
            CSharpProjectLoader.RuntimeReferences().Append(cRef).Append(bRef).ToArray(),
            options
        )

        let cId = c.GetTypeByMetadataName("C")!!.GetMembers("Id").OfType[IMethodSymbol]().Single()
        let bForward = b.GetTypeByMetadataName("B")!!.GetMembers("Forward").OfType[IMethodSymbol]().Single()
        let aRead = a.GetTypeByMetadataName("A")!!.GetMembers("Read").OfType[IMethodSymbol]().Single()
        let catalog = []CSharpCompilation{a, b, c}

        {
            let cModel = c.GetSemanticModel(cTree)
            let cCtx = TranslationContext(c, cModel, cTree.FilePath, []CSharpCompilation{c}, []CSharpCompilation{c})
            using let _ = ObliviousNullabilityAnalyzer.UseCatalogScope(cCtx)
            Assert.False(ObliviousNullabilityAnalyzer.ReturnContractIsNullable(c, cId))
        }
        {
            let bModel = b.GetSemanticModel(bTree)
            let bCtx = TranslationContext(
                b,
                bModel,
                bTree.FilePath,
                []CSharpCompilation{b, c},
                []CSharpCompilation{b, c}
            )
            using let _ = ObliviousNullabilityAnalyzer.UseCatalogScope(bCtx)
            Assert.False(ObliviousNullabilityAnalyzer.ReturnContractIsNullable(b, bForward))
        }
        let aModel = a.GetSemanticModel(aTree)
        let aCtx = TranslationContext(a, aModel, aTree.FilePath, catalog, catalog)
        using let _ = ObliviousNullabilityAnalyzer.UseCatalogScope(aCtx)
        Assert.Equal(passNull, ObliviousNullabilityAnalyzer.ReturnContractIsNullable(a, aRead))
    }

    private struct MeasurementStats {
        init(
            builds int64,
            ownerScans int64,
            syntaxVisits int64,
            fixedIterations int64,
            fixedEdgeVisits int64,
            propIterations int64,
            nodeVisits int64,
            edgeVisits int64,
            elapsedMs float64,
            allocatedBytes int64
        ) {
            this.Builds = builds
            this.OwnerScans = ownerScans
            this.SyntaxVisits = syntaxVisits
            this.FixedIterations = fixedIterations
            this.FixedEdgeVisits = fixedEdgeVisits
            this.PropIterations = propIterations
            this.NodeVisits = nodeVisits
            this.EdgeVisits = edgeVisits
            this.ElapsedMs = elapsedMs
            this.AllocatedBytes = allocatedBytes
        }

        let Builds int64
        let OwnerScans int64
        let SyntaxVisits int64
        let FixedIterations int64
        let FixedEdgeVisits int64
        let PropIterations int64
        let NodeVisits int64
        let EdgeVisits int64
        let ElapsedMs float64
        let AllocatedBytes int64
    }

    shared {
        private func BuildReverseForwardingChainSource(length int32) string {
            let sb = StringBuilder()
            sb.AppendLine("#nullable disable")
            sb.AppendLine("using System.Diagnostics.CodeAnalysis;")
            sb.AppendLine("using System.Threading.Tasks;")
            sb.AppendLine("public static class Chain")
            sb.AppendLine("{")
            sb.AppendLine("    public static Task<int> Control() => Task.FromResult(1);")
            for var i = 0; i < length; i++ {
                sb.AppendLine("    public static Task<int> M$i() => M${i + 1}();")
            }
            sb.AppendLine("    [return: MaybeNull]")
            sb.AppendLine("    public static Task<int> M$length() => null;")
            sb.AppendLine("}")
            return sb.ToString()
        }

        private func BuildCompilationChain(count int32, declarationsPerProject int32) List[CSharpCompilation] {
            let options = CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Disable
            )
            let compilations = List[CSharpCompilation]()
            let references = List[MetadataReference](CSharpProjectLoader.RuntimeReferences())
            for var i = 0; i < count; i++ {
                let sb = StringBuilder()
                sb.AppendLine("#nullable disable")
                sb.AppendLine("using System.Diagnostics.CodeAnalysis;")
                sb.AppendLine("using System.Threading.Tasks;")
                sb.AppendLine("public static class P$i")
                sb.AppendLine("{")
                if i == 0 {
                    sb.AppendLine("    [return: MaybeNull]")
                    sb.AppendLine("    public static Task<int> Entry() => null;")
                } else {
                    sb.AppendLine("    public static Task<int> Entry() => P${i - 1}.Entry();")
                }
                for var d = 0; d < declarationsPerProject; d++ {
                    sb.AppendLine("    public static Task<int> Helper$d() => Task.FromResult($d);")
                }
                sb.AppendLine("}")
                let tree = CSharpSyntaxTree.ParseText(sb.ToString(), path: "P$i.cs")
                let compilation = CSharpCompilation.Create("P$i", []SyntaxTree{tree}, references.ToArray(), options)
                Assert.Empty(
                    compilation.GetDiagnostics().Where((diag Diagnostic) -> diag.Severity == DiagnosticSeverity.Error)
                )
                using let stream = MemoryStream()
                let emitResult = compilation.Emit(stream)
                Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
                references.Add(MetadataReference.CreateFromImage(stream.ToArray()))
                compilations.Add(compilation)
            }
            return compilations
        }

        private func BuildCompilationFanOut(leafCount int32, coreDeclarations int32) List[CSharpCompilation] {
            let options = CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Disable
            )
            let compilations = List[CSharpCompilation]()
            let coreSb = StringBuilder()
            coreSb.AppendLine("#nullable disable")
            coreSb.AppendLine("using System.Diagnostics.CodeAnalysis;")
            coreSb.AppendLine("using System.Threading.Tasks;")
            coreSb.AppendLine("public static class Core")
            coreSb.AppendLine("{")
            coreSb.AppendLine("    [return: MaybeNull]")
            coreSb.AppendLine("    public static Task<int> Empty() => null;")
            for var d = 0; d < coreDeclarations; d++ {
                coreSb.AppendLine("    public static Task<int> Helper$d() => Task.FromResult($d);")
            }
            coreSb.AppendLine("}")
            let coreTree = CSharpSyntaxTree.ParseText(coreSb.ToString(), path: "Core.cs")
            let coreCompilation = CSharpCompilation.Create(
                "Core",
                []SyntaxTree{coreTree},
                CSharpProjectLoader.RuntimeReferences(),
                options
            )
            using let coreStream = MemoryStream()
            Assert.True(coreCompilation.Emit(coreStream).Success)
            let coreRef = MetadataReference.CreateFromImage(coreStream.ToArray())
            let leafRefs = CSharpProjectLoader.RuntimeReferences().Append(coreRef).ToArray()
            compilations.Add(coreCompilation)
            for var i = 0; i < leafCount; i++ {
                let leafSb = StringBuilder()
                leafSb.AppendLine("#nullable disable")
                leafSb.AppendLine("using System.Threading.Tasks;")
                leafSb.AppendLine("public static class Leaf$i")
                leafSb.AppendLine("{")
                leafSb.AppendLine("    public static Task<int> Forward() => Core.Empty();")
                leafSb.AppendLine("    public static Task<int> Local() => Core.Helper0();")
                leafSb.AppendLine("}")
                let leafTree = CSharpSyntaxTree.ParseText(leafSb.ToString(), path: "Leaf$i.cs")
                let leafCompilation = CSharpCompilation.Create("Leaf$i", []SyntaxTree{leafTree}, leafRefs, options)
                Assert.Empty(
                    leafCompilation.GetDiagnostics().Where(
                        (diag Diagnostic) -> diag.Severity == DiagnosticSeverity.Error
                    )
                )
                compilations.Add(leafCompilation)
            }
            return compilations
        }

        private func MeasureDirectReturnContract(
            compilation CSharpCompilation,
            target IMethodSymbol,
            control IMethodSymbol
        )(bool, bool, MeasurementStats) {
            return Task
                .Run(
                () -> {
                    using let measurements = CompilationMeasurements.Start("issue-6037-direct")
                    let started = Stopwatch.GetTimestamp()
                    let before = GC.GetAllocatedBytesForCurrentThread()
                    let targetNullable = ObliviousNullabilityAnalyzer.ReturnContractIsNullable(compilation, target)
                    let controlNullable = ObliviousNullabilityAnalyzer.ReturnContractIsNullable(compilation, control)
                    let alloc = GC.GetAllocatedBytesForCurrentThread() - before
                    let ms = Stopwatch.GetElapsedTime(started).TotalMilliseconds
                    return (
                        targetNullable,
                        controlNullable,
                        MeasurementStats(
                            measurements.GetCounter("translation.return_contract_graph_builds"),
                            measurements.GetCounter("translation.return_contract_owner_scans"),
                            measurements.GetCounter("translation.return_contract_syntax_node_visits"),
                            measurements.GetCounter("translation.return_contract_fixed_iterations"),
                            measurements.GetCounter("translation.return_contract_fixed_edge_visits"),
                            measurements.GetCounter("translation.return_contract_propagation_iterations"),
                            measurements.GetCounter("translation.return_contract_node_visits"),
                            measurements.GetCounter("translation.return_contract_edge_visits"),
                            ms,
                            alloc
                        )
                    )
                }
            )
                .GetAwaiter()
                .GetResult()
        }

        private func MeasureDirectCatalogReturnContracts(compilations List[CSharpCompilation]) MeasurementStats {
            return Task
                .Run(
                () -> {
                    using let measurements = CompilationMeasurements.Start("issue-6037-direct-catalog")
                    let catalog = compilations.ToArray()
                    let started = Stopwatch.GetTimestamp()
                    let before = GC.GetAllocatedBytesForCurrentThread()
                    for var i = 0; i < compilations.Count; i++ {
                        let comp = compilations[i]
                        let tree = comp.SyntaxTrees.Single()
                        let model = comp.GetSemanticModel(tree)
                        let context = TranslationContext(comp, model, tree.FilePath, catalog, catalog)
                        using let scope_ = ObliviousNullabilityAnalyzer.UseCatalogScope(context)
                        let entry = comp.GetTypeByMetadataName("P$i")!!
                            .GetMembers("Entry")
                            .OfType[IMethodSymbol]()
                            .Single()
                        let helper = comp.GetTypeByMetadataName("P$i")!!
                            .GetMembers("Helper0")
                            .OfType[IMethodSymbol]()
                            .Single()
                        Assert.True(ObliviousNullabilityAnalyzer.ReturnContractIsNullable(comp, entry))
                        Assert.False(ObliviousNullabilityAnalyzer.ReturnContractIsNullable(comp, helper))
                    }
                    let alloc = GC.GetAllocatedBytesForCurrentThread() - before
                    let ms = Stopwatch.GetElapsedTime(started).TotalMilliseconds
                    return MeasurementStats(
                        measurements.GetCounter("translation.return_contract_graph_builds"),
                        measurements.GetCounter("translation.return_contract_owner_scans"),
                        measurements.GetCounter("translation.return_contract_syntax_node_visits"),
                        measurements.GetCounter("translation.return_contract_fixed_iterations"),
                        measurements.GetCounter("translation.return_contract_fixed_edge_visits"),
                        measurements.GetCounter("translation.return_contract_propagation_iterations"),
                        measurements.GetCounter("translation.return_contract_node_visits"),
                        measurements.GetCounter("translation.return_contract_edge_visits"),
                        ms,
                        alloc
                    )
                }
            )
                .GetAwaiter()
                .GetResult()
        }

        private func MeasureCatalogTranslation(compilations List[CSharpCompilation]) MeasurementStats {
            return Task
                .Run(
                () -> {
                    using let measurements = CompilationMeasurements.Start("issue-6037-catalog")
                    let catalog = compilations.ToArray()
                    let translator = CSharpToGSharpTranslator()
                    let started = Stopwatch.GetTimestamp()
                    let before = GC.GetAllocatedBytesForCurrentThread()
                    for compilation in compilations {
                        let tree = compilation.SyntaxTrees.Single()
                        let model = compilation.GetSemanticModel(tree)
                        let context = TranslationContext(compilation, model, tree.FilePath, catalog, catalog)
                        let printed = GSharpPrinter.Print(
                            translator.TranslateDocument(LoadedDocument(tree.FilePath, tree, model), context)
                        )
                        if compilation == compilations[compilations.Count - 1] {
                            Assert.Contains("Task[int32]?", printed, StringComparison.Ordinal)
                        }
                    }
                    let alloc = GC.GetAllocatedBytesForCurrentThread() - before
                    let ms = Stopwatch.GetElapsedTime(started).TotalMilliseconds
                    return MeasurementStats(
                        measurements.GetCounter("translation.return_contract_graph_builds"),
                        measurements.GetCounter("translation.return_contract_owner_scans"),
                        measurements.GetCounter("translation.return_contract_syntax_node_visits"),
                        measurements.GetCounter("translation.return_contract_fixed_iterations"),
                        measurements.GetCounter("translation.return_contract_fixed_edge_visits"),
                        measurements.GetCounter("translation.return_contract_propagation_iterations"),
                        measurements.GetCounter("translation.return_contract_node_visits"),
                        measurements.GetCounter("translation.return_contract_edge_visits"),
                        ms,
                        alloc
                    )
                }
            )
                .GetAwaiter()
                .GetResult()
        }
    }
}
