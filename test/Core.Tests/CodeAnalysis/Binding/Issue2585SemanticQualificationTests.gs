// <copyright file="Issue2585SemanticQualificationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
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
import System.Collections.Generic

class Issue2585SemanticQualificationTests {
    @Fact
    func ImportedNamespaceHomonym_DoesNotReclassifyEventLambdaParameterAsTypeRoot() {
        Assert.Empty(Bind(`package Consumer
import Oahu.App
import Oahu.Tui

func Wire(hub Hub) {
    hub.Changed += (vm ViewModel) -> {
        vm.Changed += () -> { }
    }
}`))
    }

    @Fact
    func ImportedNamespaceHomonym_DoesNotReclassifyLocalValueAsTypeRoot() {
        Assert.Empty(Bind(`package Consumer
import Oahu.App
import Oahu.Tui

func Run() {
    let vm = ViewModel()
    vm.Changed += () -> { }
}`))
    }

    @Fact
    func ImportedConstructorPath_DoesNotReclassifyLocalValueAsNamespaceRoot() {
        Assert.Empty(Bind(`package Consumer
import Oahu.App
import Oahu.Trap

func Run() int32 {
    let local = Factory()
    return local.Make()
}`))
    }

    @Fact
    func ImportedNestedNamespaceAndAlias_RemainValidTypeQualifiers() {
        Assert.Empty(Bind(`package Consumer
import Tui = Oahu.Tui

func Run() {
    let direct = Oahu.Tui.Nested.Refresh()
    let aliased = Tui.Nested.Refresh()
}`))
    }

    @Fact
    func FullyQualifiedImportedStaticMember_SelectsTypeDespiteSourceHomonym() {
        Assert.Empty(Bind(`package Oahu.Core.Ex

class JsonExtensions {
}`, `package Oahu.Audible.Json
import Oahu.Aux.Extensions

func Read() int32 {
    return Oahu.Aux.Extensions.JsonExtensions.Options
}`))
    }

    @Fact
    func FullyQualifiedSourceStaticMember_SelectsMatchingPackage() {
        Assert.Empty(Bind(`package Target

class JsonExtensions {
    shared {
        let Options int32 = 1
    }
}`, `package Other

class JsonExtensions {
}`, `package Consumer

func Read() int32 {
    return Target.JsonExtensions.Options
}`))
    }

    @Fact
    func FullyQualifiedImportedStaticMember_UnknownMemberRemainsDiagnosed() {
        Assert.Contains(Bind(`package Oahu.Core.Ex

class JsonExtensions {
}`, `package Consumer
import Oahu.Aux.Extensions

func Read() int32 {
    return Oahu.Aux.Extensions.JsonExtensions.Missing
}`), (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0158")
    }

    @Fact
    func ImportedGenericCompositeLiteral_ResolvesClosedType() {
        Assert.Empty(Bind(`package Consumer
import Oahu.Widgets

func Run() {
    let list = SelectList[string]{ Value: "ok" }
}`))
    }

    @Fact
    func ImportedGenericCompositeLiteral_WrongArity_RemainsDiagnosed() {
        Assert.Contains(Bind(`package Consumer
import Oahu.Widgets

func Run() {
    SelectList[string, int32]{ Value: "bad" }
}`), (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic
                .Message
                .Contains("Cannot find type SelectList", StringComparison.Ordinal))
    }

    @Fact
    func SourceQualifiedTypeAndValueReceiver_RemainDistinct() {
        Assert.Empty(Bind(`package Oahu.App

class ViewModel {
    event Changed () -> void

    func Refresh() {
    }
}`, `package Oahu.Tui.Nested

class Refresh {
    init(required int32) {
    }
}

class vm {
}`, `package Consumer
import AppAlias = Oahu.App

func Run() {
    let vm = Oahu.App.ViewModel()
    vm.Changed += () -> { }
    vm.Refresh()
    let aliased = AppAlias.ViewModel()
    aliased.Refresh()
    let qualified = Oahu.Tui.Nested.Refresh(1)
}`))
    }

    shared {
        private let LibraryPath string = EmitLibrary()

        private func Bind(sources ...string) IReadOnlyList[GSharp.Core.CodeAnalysis.Diagnostic] {
            using let resolver = ReferenceResolver.WithReferences([]string{LibraryPath})
            let trees = sources.Select(
                (source string) -> GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(source))
            )
                .ToArray()
            let compilation = GsCompilation(resolver, trees){IsLibrary = true}
            return trees
                .SelectMany(
                func (tree GSharp.Core.CodeAnalysis.Syntax.SyntaxTree) IEnumerable[
                    GSharp.Core.CodeAnalysis.Diagnostic
                ] {
                    return tree.Diagnostics
                }
            )
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
                .ToList()
        }

        private func EmitLibrary() string {
            let outputDirectory = Path.Combine(AppContext.BaseDirectory, "Issue2585Binding")
            Directory.CreateDirectory(outputDirectory)
            let libraryPath = Path.Combine(outputDirectory, "Issue2585.Library.dll")
            const source = `using System;

namespace Oahu.App
{
    public sealed class ViewModel
    {
        public event Action Changed;
        public void Refresh() { }
    }

    public sealed class Hub
    {
        public event Action<ViewModel> Changed;
    }

    public sealed class Factory
    {
        public int Make() => 1;
    }
}

namespace Oahu.Tui.Nested
{
    public sealed class Refresh
    {
        public Refresh() { }
    }
}

namespace Oahu.Tui
{
    public sealed class vm
    {
    }
}

namespace Oahu.Trap.local
{
    public sealed class Make
    {
    }
}

namespace Oahu.Widgets
{
    public sealed class SelectList<T>
    {
        public T Value { get; set; }
    }
}

namespace Oahu.Aux.Extensions
{
    public static class JsonExtensions
    {
        public static int Options => 1;
    }
}`
            let tree = CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")))
                .Split(Path.PathSeparator)
                .Where(File.Exists)
                .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
            let compilation = CSharpCompilation.Create(
                "Issue2585.Library",
                []Microsoft.CodeAnalysis.SyntaxTree{tree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = File.Create(libraryPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return libraryPath
        }
    }
}
