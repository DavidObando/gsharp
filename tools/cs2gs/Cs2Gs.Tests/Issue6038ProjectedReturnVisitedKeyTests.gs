// <copyright file="Issue6038ProjectedReturnVisitedKeyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text
import Xunit

/// Regression coverage for issue #6038: projected return-contract traversal
/// shares one visited set across alternative branches that can enter the same
/// source with `requirePromotion: true` (narrowed) before `requirePromotion: false`
/// (unnarrowed).
open class Issue6038ProjectedReturnVisitedKeyTests {
    @Theory
    @InlineData(false, "if")
    @InlineData(true, "if")
    @InlineData(false, "ternary")
    @InlineData(true, "ternary")
    @InlineData(false, "switch")
    @InlineData(true, "switch")
    @InlineData(false, "coalesce")
    @InlineData(true, "coalesce")
    func NarrowedBeforeUnnarrowedBranch_PreservesProjectedNullableReturnAcrossSourceOwners(
        narrowedFirst bool,
        shape string
    ) {
        let pickBody = switch shape {
            case "if": if narrowedFirst {
                "if (flag) return (await Forward())!; return await Forward();"
            } else {
                "if (!flag) return await Forward(); return (await Forward())!;"
            }
            case "ternary": if narrowedFirst {
                "return flag ? (await Forward())! : await Forward();"
            } else {
                "return !flag ? await Forward() : (await Forward())!;"
            }
            case "switch": if narrowedFirst {
                "return flag switch { true => (await Forward())!, false => await Forward() };"
            } else {
                "return flag switch { false => await Forward(), true => (await Forward())! };"
            }
            case "coalesce": if narrowedFirst {
                "return (await Guarded()) ?? (flag ? (await Forward())! : await Forward());"
            } else {
                "return (await Guarded()) ?? (!flag ? await Forward() : (await Forward())!);"
            }
            default: throw ArgumentOutOfRangeException(nameof(shape))
        }
        let libSource = `
#nullable enable
using System.Threading.Tasks;
public static class EnabledSource
{
    public static Task<string?> GetNullableAsync() => Task.FromResult<string?>(null);
}
#nullable disable
public static class Lib
{
    static Task<string> Guarded() => Task.FromResult<string>(null);
    public static Task<string> Forward() => EnabledSource.GetNullableAsync();
    public static async Task<string> Pick(bool flag)
    {
        await Task.Yield();
        ` + pickBody + `
    }
}`
        let appSource = `
#nullable disable
using System;
public static class App
{
    public static string ReadSync(bool flag) => Lib.Pick(flag).GetAwaiter().GetResult();
    public static void Main()
    {
        var value = ReadSync(false);
        Console.WriteLine(value == null ? "null" : value.Length.ToString());
    }
}`
        let libCompilation = CSharpCompilation.Create(
            "Lib",
            []SyntaxTree{CSharpSyntaxTree.ParseText(libSource, path: "Lib.cs")},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Disable
            )
        )
        let Image = (compilation CSharpCompilation) -> {
            using let stream = MemoryStream()
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return stream.ToArray()
        }
        let libBytes = Image(libCompilation)
        let appCompilation = CSharpCompilation.Create(
            "App",
            []SyntaxTree{CSharpSyntaxTree.ParseText(appSource, path: "App.cs")},
            CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromImage(libBytes)),
            CSharpCompilationOptions(OutputKind.ConsoleApplication).WithNullableContextOptions(
                NullableContextOptions.Disable
            )
        )
        let appBytes = Image(appCompilation)
        let catalog = []CSharpCompilation{appCompilation, libCompilation}

        let libTree = libCompilation.SyntaxTrees.Single()
        let libModel = libCompilation.GetSemanticModel(libTree)
        let libContext = TranslationContext(libCompilation, libModel, libTree.FilePath, catalog, catalog)
        var libPrinted string
        {
            using let _ = ObliviousNullabilityAnalyzer.UseCatalogScope(libContext)
            libPrinted = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(
                    LoadedDocument(libTree.FilePath, libTree, libModel),
                    libContext
                )
            )
        }

        let appTree = appCompilation.SyntaxTrees.Single()
        let appModel = appCompilation.GetSemanticModel(appTree)
        let appContext = TranslationContext(appCompilation, appModel, appTree.FilePath, catalog, catalog)
        let readSync = appCompilation.GetTypeByMetadataName("App")!!
            .GetMembers("ReadSync")
            .OfType[IMethodSymbol]()
            .Single()
        var appPrinted string
        {
            using let _ = ObliviousNullabilityAnalyzer.UseCatalogScope(appContext)
            Assert.True(
                ObliviousNullabilityAnalyzer.ReturnContractIsNullable(appCompilation, readSync),
                "Expected ReadSync return contract to be nullable for narrowedFirst=" + narrowedFirst.ToString() +
                    ", shape=" +
                    shape
            )
            appPrinted = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(
                    LoadedDocument(appTree.FilePath, appTree, appModel),
                    appContext
                )
            )
        }
        Assert.Contains("func ReadSync(flag bool) string?", appPrinted, StringComparison.Ordinal)

        let directory = Path.Combine(AppContext.BaseDirectory, "issue-6038-visited", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            File.WriteAllBytes(Path.Combine(directory, "Lib.dll"), libBytes)
            let nativeApp = Path.Combine(directory, "App.dll")
            File.WriteAllBytes(nativeApp, appBytes)
            File.WriteAllText(
                Path.Combine(directory, "App.runtimeconfig.json"),
                `{"runtimeOptions":{"tfm":"net10.0","framework":{"name":"Microsoft.NETCore.App","version":"10.0.0"}}}`
            )
            let expected = LiteralConstructionRuntimeParity.RunDotnet([]string{nativeApp})
            Assert.Equal(Encoding.UTF8.GetBytes("null" + Environment.NewLine), expected)

            let libGs = Path.Combine(directory, "Lib.gs")
            let libOut = Path.Combine(directory, "Lib.dll")
            File.WriteAllText(libGs, libPrinted)
            LiteralConstructionRuntimeParity.RunDotnet(
                []string{
                    LiteralConstructionRuntimeParity.FindCompiler(),
                    "/target:library",
                    "/targetframework:net10.0",
                    "/assemblyname:Lib",
                    "/out:" + libOut,
                    libGs
                },
                libPrinted
            )
            let appGs = Path.Combine(directory, "App.gs")
            let appOut = Path.Combine(directory, "App.dll")
            File.WriteAllText(appGs, appPrinted)
            LiteralConstructionRuntimeParity.RunDotnet(
                []string{
                    LiteralConstructionRuntimeParity.FindCompiler(),
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/assemblyname:App",
                    "/reference:" + libOut,
                    "/out:" + appOut,
                    appGs
                },
                appPrinted
            )
            let verified = IlVerifyRunner().Verify(appOut)
            Assert.True(verified.Status == IlVerifyStatus.Passed, verified.Output)
            Assert.Empty(verified.Errors)
            Assert.Equal(expected, LiteralConstructionRuntimeParity.RunDotnet([]string{appOut}, appPrinted))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func SingleCompilation_NarrowedBeforeUnnarrowed_PreservesProjectedReturnContract(narrowedFirst bool) {
        let pickBody = if narrowedFirst {
            "return flag ? (await Forward())! : await Forward();"
        } else {
            "return !flag ? await Forward() : (await Forward())!;"
        }
        let source = `
#nullable enable
using System;
using System.Threading.Tasks;
public static class EnabledSource
{
    public static Task<string?> GetNullableAsync() => Task.FromResult<string?>(null);
}
#nullable disable
public static class P
{
    static Task<string> Forward() => EnabledSource.GetNullableAsync();
    static async Task<string> Pick(bool flag)
    {
        await Task.Yield();
        ` + pickBody + `
    }
    public static string ReadSync(bool flag) => Pick(flag).GetAwaiter().GetResult();
    public static void Main()
    {
        var value = ReadSync(false);
        Console.WriteLine(value == null ? "null" : value.Length.ToString());
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Probe.cs", source)})
        let readSync = project.Compilation.GetTypeByMetadataName("P")!!
            .GetMembers("ReadSync")
            .OfType[IMethodSymbol]()
            .Single()
        Assert.True(
            ObliviousNullabilityAnalyzer.ReturnContractIsNullable(project.Compilation, readSync),
            "Expected P.ReadSync return contract to be nullable for narrowedFirst=" + narrowedFirst.ToString()
        )
        Assert.True(
            ObliviousNullabilityAnalyzer.ValueFlowIsPromoted(project.Compilation, readSync),
            "Expected P.ReadSync value flow to be promoted for narrowedFirst=" + narrowedFirst.ToString()
        )
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (printed string) -> Assert.Contains("func ReadSync(flag bool) string?", printed),
            verifyIL: true,
            nullableContextOptions: NullableContextOptions.Disable,
            expectedOutput: "null" + Environment.NewLine
        )
    }

    @Fact
    func AllNarrowedBranches_DoNotPromoteProjectedReturnContract() {
        const source = `
#nullable enable
using System;
using System.Threading.Tasks;
public static class EnabledSource
{
    public static Task<string?> GetNullableAsync() => Task.FromResult<string?>("ok");
}
#nullable disable
public static class P
{
    static Task<string> Forward() => EnabledSource.GetNullableAsync();
    static async Task<string> Pick(bool flag)
    {
        await Task.Yield();
        if (flag)
            return (await Forward())!;
        return (await Forward())!;
    }
    public static string ReadSync(bool flag) => Pick(flag).GetAwaiter().GetResult();
    public static void Main() => Console.WriteLine(ReadSync(false).Length);
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Control.cs", source)})
        let readSync = project.Compilation.GetTypeByMetadataName("P")!!
            .GetMembers("ReadSync")
            .OfType[IMethodSymbol]()
            .Single()
        Assert.False(ObliviousNullabilityAnalyzer.ReturnContractIsNullable(project.Compilation, readSync))
        Assert.False(ObliviousNullabilityAnalyzer.ValueFlowIsPromoted(project.Compilation, readSync))
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (printed string) -> Assert.Contains("func ReadSync(flag bool) string ->", printed),
            verifyIL: true,
            nullableContextOptions: NullableContextOptions.Disable,
            expectedOutput: "2" + Environment.NewLine
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func TupleSource_NarrowedBeforeUnnarrowed_PreservesProjectedReturnContract(narrowedFirst bool) {
        let pickBody = if narrowedFirst {
            "if (flag) return (await taskA)!; return await taskB;"
        } else {
            "if (!flag) return await taskB; return (await taskA)!;"
        }
        let source = `
#nullable enable
using System;
using System.Threading.Tasks;
public static class EnabledSource
{
    public static Task<string?> GetNullableAsync() => Task.FromResult<string?>(null);
}
#nullable disable
public static class P
{
    static (Task<string>, int) MakePair() => (EnabledSource.GetNullableAsync(), 1);
    static async Task<string> Pick(bool flag)
    {
        var pair = MakePair();
        Task<string> taskA = pair.Item1;
        Task<string> taskB = pair.Item1;
        await Task.Yield();
        ` + pickBody + `
    }
    public static string ReadSync(bool flag) => Pick(flag).GetAwaiter().GetResult();
    public static void Main()
    {
        var value = ReadSync(false);
        Console.WriteLine(value == null ? "null" : value.Length.ToString());
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("TupleProbe.cs", source)})
        let readSync = project.Compilation.GetTypeByMetadataName("P")!!
            .GetMembers("ReadSync")
            .OfType[IMethodSymbol]()
            .Single()
        Assert.True(
            ObliviousNullabilityAnalyzer.ReturnContractIsNullable(project.Compilation, readSync),
            "Expected tuple-backed P.ReadSync return contract to be nullable for narrowedFirst=" +
                narrowedFirst.ToString()
        )
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (printed string) -> Assert.Contains("func ReadSync(flag bool) string?", printed),
            verifyIL: true,
            nullableContextOptions: NullableContextOptions.Disable,
            expectedOutput: "null" + Environment.NewLine
        )
    }
}
