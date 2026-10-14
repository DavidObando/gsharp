// <copyright file="Issue2636ImportedInheritedStaticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.IO
import System.Linq
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis
import System.Collections.Generic

class Issue2636ImportedInheritedStaticTests {
    @Fact
    func OahuBookDbContextLazyLoad_StartupAsyncAndStaticData_BindAcrossAssemblies() {
        let (basePath, derivedPath) = EmitLibraries()
        let result = Compile(basePath, derivedPath, `package Issue2636.Consumer
import System.Threading.Tasks
import Issue2636.Derived

async func MainWindowStartupAsync() bool {
    let canConnect bool = await BookDbContextLazyLoad.StartupAsync()!!
    return canConnect
}

class CoreEnvironment {
    shared {
        func InitializeDatabaseAsync() Task[bool] ->
            BookDbContextLazyLoad.StartupAsync()!!

        func InitializeDatabase() bool ->
            BookDbContextLazyLoad.StartupAsync()!!.GetAwaiter().GetResult()

        func InitializeFromMethodGroup() bool {
            let value () -> int32 = BookDbContextLazyLoad.Value
            return value() == 42
        }
    }
}

func ReadStaticData() string ->
    BookDbContextLazyLoad.Field!! + BookDbContextLazyLoad.Property!!`)
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func DerivedDeclaration_HidesBaseOverloadSet() {
        let (basePath, derivedPath) = EmitLibraries()
        let valid = Compile(basePath, derivedPath, `package Issue2636.Consumer
import Issue2636.Derived
func Pick() string -> HidingDerived.Pick("derived")!!`)
        Assert.True(valid.Success, string.Join(Environment.NewLine, valid.Diagnostics))
        let invalid = Compile(basePath, derivedPath, `package Issue2636.Consumer
import Issue2636.Derived
func Pick() string -> HidingDerived.Pick(1)`)
        Assert.Contains(invalid.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0159")
    }

    @Fact
    func InaccessibleDeclarations_DoNotExposeInheritedStaticMembers() {
        let (basePath, derivedPath) = EmitLibraries()
        let result = Compile(basePath, derivedPath, `package Issue2636.Consumer
import Issue2636.Derived

func PrivateCall() string -> BookDbContextLazyLoad.PrivateOnly()
func InternalCall() string -> BookDbContextLazyLoad.InternalOnly()
func ProtectedCall() string -> BookDbContextLazyLoad.ProtectedOnly()`)
        Assert.Equal(3, result.Diagnostics.Count((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0159"))
    }

    @Fact
    func InaccessibleDerivedDeclaration_DoesNotHideAccessibleBaseMember() {
        let (basePath, derivedPath) = EmitLibraries()
        let result = Compile(basePath, derivedPath, `package Issue2636.Consumer
import Issue2636.Derived
func Pick() string -> InaccessibleHidingDerived.Pick(1)!!`)
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func InheritedOverloadAmbiguity_RemainsAmbiguous() {
        let (basePath, derivedPath) = EmitLibraries()
        let result = Compile(basePath, derivedPath, `package Issue2636.Consumer
import Issue2636.Base
import Issue2636.Derived
func Pick(value Both) string -> BookDbContextLazyLoad.Ambiguous(value)`)
        Assert.Contains(result.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0160")
    }

    shared {
        private func EmitLibraries()(BasePath string, DerivedPath string) {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2636ImportedInheritedStaticTests")
            Directory.CreateDirectory(directory)
            let basePath = Path.Combine(directory, "Issue2636.Base.dll")
            let derivedPath = Path.Combine(directory, "Issue2636.Derived.dll")
            EmitCSharp(basePath, "Issue2636.Base", `using System.Threading.Tasks;

namespace Issue2636.Base;

public interface ILeft;
public interface IRight;
public sealed class Both : ILeft, IRight;

public class BookDbContext
{
    public static string Field = "field";
    public static string Property => "property";
    public static int Value() => 42;
    public static Task<bool> StartupAsync() => Task.FromResult(true);
    public static string Ambiguous(ILeft value) => "left";
    public static string Ambiguous(IRight value) => "right";
    private static string PrivateOnly() => "private";
    internal static string InternalOnly() => "internal";
    protected static string ProtectedOnly() => "protected";
}

public class HidingBase
{
    public static string Pick(int value) => "base";
}`)
            EmitCSharp(derivedPath, "Issue2636.Derived", `using Issue2636.Base;

namespace Issue2636.Derived;

public sealed class BookDbContextLazyLoad : BookDbContext;

public sealed class HidingDerived : HidingBase
{
    public new static string Pick(string value) => "derived";
}

public sealed class InaccessibleHidingDerived : HidingBase
{
    private new static string Pick(int value) => "hidden";
}`, basePath)
            return (basePath, derivedPath)
        }

        private func Compile(basePath string, derivedPath string, source string)(
            Success bool,
            Diagnostics IEnumerable[GSharp.Core.CodeAnalysis.Diagnostic]
        ) {
            using let resolver = ReferenceResolver.WithReferences([]string{basePath, derivedPath})
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
            using let stream = MemoryStream()
            let result = compilation.Emit(stream, pdbStream: nil, refStream: nil, assemblyName: "Issue2636.Consumer")
            return (result.Success, result.Diagnostics)
        }

        private func EmitCSharp(path string, assemblyName string, source string, additionalReferences ...string) {
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists)
                .Select((reference string) -> cast[MetadataReference](MetadataReference.CreateFromFile(reference)))
                .Concat(additionalReferences.Select((reference string) -> MetadataReference.CreateFromFile(reference)))
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = File.Create(path)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
    }
}
