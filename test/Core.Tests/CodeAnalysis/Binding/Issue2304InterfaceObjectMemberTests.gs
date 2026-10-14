// <copyright file="Issue2304InterfaceObjectMemberTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.IO
import System.Linq
import System.Runtime.Loader
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis
import System.Collections.Generic
import System.Reflection

/// Issue #2304: `System.Object`'s universal instance members
/// (`ToString`, `GetHashCode`, `Equals(object)`, `GetType`)
/// were not resolvable through an INTERFACE-typed receiver — neither a
/// source-declared (cref:InterfaceSymbol) nor an imported interface (an
/// (cref:ImportedTypeSymbol) whose `ClrType.IsInterface` is
/// `true`) — even though every interface implicitly derives
/// from `System.Object` for member-access purposes at the CLR/C# layer.
/// The call previously dead-ended at `GS0159` ("Cannot find function").
/// These tests cover both a source interface and an imported (cross-assembly)
/// interface, mirroring a class-typed receiver (which already worked) as a
/// baseline sanity check.
open class Issue2304InterfaceObjectMemberTests {
    @Fact
    func SourceInterface_ToString_Binds() {
        const source = `package t
interface IThing {
    prop Id int32
}
func Describe(x IThing) string {
    return x.ToString()
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func SourceInterface_GetHashCode_Binds() {
        const source = `package t
interface IThing {
    prop Id int32
}
func HashOf(x IThing) int32 {
    return x.GetHashCode()
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func SourceInterface_Equals_Binds() {
        const source = `package t
interface IThing {
    prop Id int32
}
func AreEqual(x IThing, y IThing) bool {
    return x.Equals(y)
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func SourceInterface_ObjectMembers_ProduceExpectedValuesAtRuntime() {
        const source = `package t
import System
interface IThing {
    prop Id int32
}
class Widget : IThing {
    prop Id int32
}
func Main() {
    var w IThing = Widget{ Id: 7 }
    Console.WriteLine(w.ToString())
    Console.WriteLine(w.Equals(w))
    Console.WriteLine(w.GetHashCode() == w.GetHashCode())
}`
        let output = CompileLoadInvokeCaptureStdout(source, "Issue2304-SourceInterface")
        let lines = output.Split([]string{Environment.NewLine, "\n"}, StringSplitOptions.RemoveEmptyEntries)
        Assert.Contains("Widget", lines[0])
        Assert.Equal("True", lines[1])
        Assert.Equal("True", lines[2])
    }

    @Fact
    func ImportedInterface_ToString_GetHashCode_Equals_Bind() {
        let libraryPath = EmitCSharpLibrary(
            "ImportedInterface_ToString_GetHashCode_Equals_Bind",
            "namespace MyLib { public interface IThing { int Id { get; } } public class Entity { public int Id { get; set; } } }"
        )
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Consumer"
        let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package Consumer
import MyLib

func I1(x IThing) string {
    return x.ToString()
}

func I2(x IThing) int32 {
    return x.GetHashCode()
}

func I3(x IThing, y IThing) bool {
    return x.Equals(y)
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func ImportedInterface_ObjectMembers_ProduceExpectedValuesAtRuntime() {
        let libraryPath = EmitCSharpLibrary(
            "ImportedInterface_ObjectMembers_ProduceExpectedValuesAtRuntime",
            "namespace MyLib { public interface IThing { int Id { get; } } public class Entity : IThing { public int Id { get; set; } } }"
        )
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Consumer"
        let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package Consumer
import System
import MyLib

func Main() {
    var e = Entity{ Id: 3 }
    var x IThing = e
    Console.WriteLine(x.ToString())
    Console.WriteLine(x.Equals(x))
    Console.WriteLine(x.GetHashCode() == x.GetHashCode())
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        peStream.Position = 0
        let loadContext = AssemblyLoadContext("Issue2304-ImportedInterface", isCollectible: true)
        try {
            let libraryLoadContext = AssemblyLoadContext("Issue2304-ImportedInterface-Lib", isCollectible: true)
            try {
                libraryLoadContext.LoadFromAssemblyPath(libraryPath)
                let libraryAssemblyName = Path.GetFileNameWithoutExtension(libraryPath)
                loadContext.Resolving += (ctx AssemblyLoadContext, name AssemblyName) -> if string.Equals(
                    name.Name,
                    libraryAssemblyName,
                    StringComparison.Ordinal
                ) {
                    libraryLoadContext.LoadFromAssemblyPath(libraryPath)
                } else {
                    default(Assembly?)
                }
                let asm = loadContext.LoadFromStream(peStream)
                let entry MethodInfo? = asm.EntryPoint
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
                let lines = captured.ToString().Split(
                    []string{Environment.NewLine, "\n"},
                    StringSplitOptions.RemoveEmptyEntries
                )
                Assert.Contains("Entity", lines[0])
                Assert.Equal("True", lines[1])
                Assert.Equal("True", lines[2])
            } finally {
                libraryLoadContext.Unload()
            }
        } finally {
            loadContext.Unload()
        }
    }

    shared {
        private func Bind(source string) IReadOnlyList[GSharp.Core.CodeAnalysis.Diagnostic] {
            let tree = GsSyntaxTree.Parse(SourceText.From(source))
            let compilation = GsCompilation(tree)
            return compilation.GlobalScope.Diagnostics.ToList()
        }

        private func CompileLoadInvokeCaptureStdout(source string, contextName string) string {
            using let peStream = MemoryStream()
            let tree = GsSyntaxTree.Parse(SourceText.From(source))
            let compilation = GsCompilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message)
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

        private func EmitCSharpLibrary(caseName string, source string) string {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2304", caseName)
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "MyLib2304.dll")
            let syntaxTree = CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))
            let referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(
                Path.PathSeparator
            ) ??
                Array.Empty[string]()
            let references = referencePaths
                .Where(File.Exists)
                .Select((p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p)))
                .ToList()
            let compilation = CSharpCompilation.Create(
                "MyLib2304",
                []Microsoft.CodeAnalysis.SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            {
                using let peStream = File.Create(libraryPath)
                let emitResult = compilation.Emit(peStream)
                Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            }
            return libraryPath
        }
    }
}
