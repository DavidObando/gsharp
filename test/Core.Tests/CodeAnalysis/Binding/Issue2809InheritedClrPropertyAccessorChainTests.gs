// <copyright file="Issue2809InheritedClrPropertyAccessorChainTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.IO
import System.Linq
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax

class Issue2809InheritedClrPropertyAccessorChainTests {
    @Fact
    func ImportedBaseProperty_HeadOfUnqualifiedAccessorChain_Binds() {
        Assert.Empty(Bind(`package Consumer
import Project1

class ChatHub : A {
    func Join() int32 {
        return Clients.All()
    }
}`))
    }

    @Fact
    func ImportedBaseProperty_ThroughUserBase_HeadOfUnqualifiedAccessorChain_Binds() {
        Assert.Empty(Bind(`package Consumer
import Project1

open class Mid : A {
}

class ChatHub : Mid {
    func Join() int32 {
        return Clients.All()
    }
}`))
    }

    @Fact
    func ImportedBaseProperty_DoesNotShadowStaticTypeMember() {
        Assert.Empty(Bind(`package Consumer
import Project1
import System.IO

class ChatHub : A {
    func Join() string {
        return Path.Combine("first", "second")
    }
}`))
    }

    @Fact
    func ImportedBaseProperty_DoesNotShadowStaticInterfaceMember() {
        Assert.Empty(Bind(`package Consumer
import Project1

interface Path {
    shared {
        const Kind string = "path"
    }
}

class ChatHub : A {
    func Join() string {
        return Path.Kind
    }
}`))
    }

    @Fact
    func ImportedGenericBaseProperty_PreservesSymbolicReceiverArgument() {
        Assert.Empty(Bind(`package Consumer
import Project1

class SharedOptions {
    prop Header string {
        get -> "X-User"
    }
}

class Handler : GenericBase[SharedOptions] {
    func Read() string {
        return Options.Header
    }
}`))
    }

    shared {
        private let LibraryPath string = EmitLibrary()

        private func Bind(source string) IReadOnlyList[GSharp.Core.CodeAnalysis.Diagnostic] {
            using let resolver = ReferenceResolver.WithReferences([]string{LibraryPath})
            let tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(source))
            let compilation = GsCompilation(resolver, tree){IsLibrary = true}
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
                .ToList()
        }

        private func EmitLibrary() string {
            let outputDirectory = Path.Combine(AppContext.BaseDirectory, "Issue2809Binding")
            Directory.CreateDirectory(outputDirectory)
            let libraryPath = Path.Combine(outputDirectory, "Issue2809.Library.dll")
            const source = `namespace Project1
{
    public class A
    {
        public B Clients { get; } = new B();
        public B Path { get; } = new B();
    }

    public class B
    {
        public int All() => 1;
    }

    public class GenericBase<T>
    {
        public T Options { get; } = default!;
    }
}`
            let trustedPlatformAssemblies string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            let references = if trustedPlatformAssemblies == nil {
                Array.Empty[MetadataReference]()
            } else {
                trustedPlatformAssemblies
                    .Split(Path.PathSeparator)
                    .Where((path string) -> !string.IsNullOrWhiteSpace(path))
                    .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
                    .ToArray()
            }
            let compilation = CSharpCompilation.Create(
                assemblyName: "Issue2809.Library",
                syntaxTrees: []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references: references,
                options: CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let emit = compilation.Emit(libraryPath)
            Assert.True(
                emit.Success,
                string.Join(
                    Environment.NewLine,
                    emit.Diagnostics.Select((d Microsoft.CodeAnalysis.Diagnostic) -> d.ToString())
                )
            )
            return libraryPath
        }
    }
}
