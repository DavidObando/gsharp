// <copyright file="Issue2410ImportedDelegateAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.IO
import System.Linq
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis

open class Issue2410ImportedDelegateAssignmentTests {
    @Fact
    func ImportedStaticDelegateFieldAndProperty_UntypedLambdas_Bind() {
        AssertNoErrors(`package App
import Lib2410

func Main() {
    Holder.StaticField = (x) -> x + 1
    Holder.StaticProperty = (x) -> x + 2
}`)
    }

    @Fact
    func ImportedDelegateAssignment_SiblingMemberPaths_Bind() {
        AssertNoErrors(`package App
import Lib2410

func Same(h Holder) Holder -> h

func Main() {
    let h = Holder()
    h.InstanceField = (x) -> x + 1
    Same(h).InstanceProperty = (x) -> x + 2
    GenericHolder[int32].StaticField = (x) -> x + 3
    GenericHolder[int32].StaticProperty = (x) -> x + 4
}`)
    }

    @Fact
    func ImportedStaticDelegateField_TypedLambda_StillBinds() {
        AssertNoErrors(`package App
import Lib2410

func Main() {
    Holder.StaticField = (x int32) -> x + 1
}`)
    }

    @Fact
    func ImportedStaticDelegateField_ArityMismatch_RemainsRejected() {
        let diagnostics = Bind(`package App
import Lib2410

func Main() {
    Holder.StaticField = (x, y) -> x
}`)
        Assert.Contains(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
    }

    @Fact
    func ImportedStaticDelegateProperty_ReturnMismatch_RemainsRejected() {
        let diagnostics = Bind(`package App
import Lib2410

func Main() {
    Holder.StaticProperty = (x) -> "wrong"
}`)
        Assert.Contains(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
    }

    @Fact
    func ImportedStaticNonDelegateField_UntypedLambda_RemainsRejected() {
        let diagnostics = Bind(`package App
import Lib2410

func Main() {
    Holder.Number = (x) -> x
}`)
        Assert.Contains(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
    }

    shared {
        private let LibraryPath string = EmitCSharpLibrary()

        private func AssertNoErrors(source string) {
            Assert.DoesNotContain(Bind(source), (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
        }

        private func Bind(source string) IReadOnlyList[GSharp.Core.CodeAnalysis.Diagnostic] {
            using let resolver = ReferenceResolver.WithReferences([]string{LibraryPath})
            let tree = GsSyntaxTree.Parse(SourceText.From(source))
            let compilation = GsCompilation(resolver, tree)
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .ToList()
        }

        private func EmitCSharpLibrary() string {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2410Binding")
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "Lib2410.dll")
            const source = `namespace Lib2410
{
    public delegate int Mapper(int value);

    public sealed class Holder
    {
        public static Mapper StaticField;
        public static Mapper StaticProperty { get; set; }
        public static int Number;
        public Mapper InstanceField;
        public Mapper InstanceProperty { get; set; }
    }

    public sealed class GenericHolder<T>
    {
        public static Mapper StaticField;
        public static Mapper StaticProperty { get; set; }
    }
}`
            let syntaxTree = CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists).Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                "Lib2410",
                []Microsoft.CodeAnalysis.SyntaxTree{syntaxTree},
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
