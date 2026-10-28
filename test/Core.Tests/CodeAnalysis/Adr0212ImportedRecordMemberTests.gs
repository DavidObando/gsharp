// <copyright file="Adr0212ImportedRecordMemberTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import Xunit

/// Issue #5441: an imported C# record is a CLR-backed aggregate that already holds the members it inherits, so
/// (cref:SemanticModel.LookupMembers) does not add the members of its base a second time.
open class Adr0212ImportedRecordMemberTests {
    @Fact
    func ImportedRecord_InheritedMembers_AreListedOnce() {
        let libraryPath = EmitCSharpLibrary("namespace Records { public record Person(string Name, int Age); }")
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Consumer"
        let source = "package Consumer\nimport Records\n\nfunc Run(p Person) {\n    p.GetType() // PRecord\n}\n"
        let tree = GsSyntaxTree.Parse(SourceText.From(source, "consumer.gs"))
        let model = Compilation(resolver, tree).GetSemanticModel(tree)
        let access = tree.Root.DescendantNodes().OfType[AccessorExpressionSyntax]().First()
        let receiver = model.GetReceiverTypeInfo(access.LeftPart).Type!!
        Assert.IsType[StructSymbol](receiver)
        Assert.NotNull(cast[StructSymbol](receiver).ClrType)
        let position = source.IndexOf("// PRecord", StringComparison.Ordinal)
        Assert.Single(model.LookupMembers(position, receiver, "GetType"))
        Assert.Single(model.LookupMembers(position, receiver, "Name"))
        Assert.Single(
            model.LookupMembers(position, receiver, "GetHashCode").Where((m Symbol) -> m.Name == "GetHashCode")
        )
    }

    @Fact
    func ImportedOverride_AnotherAssemblyWithTheSameModuleNameAndToken_DoesNotHideAnInheritedMember() {
        // Both modules are named `Lib.dll`; `Q.Bar` and `R.Foo` have the same metadata token.
        let first = EmitCSharpLibrary(
            "namespace Chain { public class R { public virtual void Foo() { } } }",
            "AsmFirst",
            "first"
        )
        let second = EmitCSharpLibrary(
            "namespace Chain { public class Q : R { public virtual void Bar() { } } }",
            "AsmSecond",
            "second",
            first
        )
        using let resolver = ReferenceResolver.WithReferences([]string{first, second})
        resolver.CurrentAssemblyName = "Consumer"
        let source = "package Consumer\nimport Chain\n\nclass S : Q {\n    override func Bar() { }\n}\n\nfunc Run(s S) {\n    s.Foo() // PChain\n}\n"
        let tree = GsSyntaxTree.Parse(SourceText.From(source, "consumer.gs"))
        let model = Compilation(resolver, tree).GetSemanticModel(tree)
        let access = tree.Root.DescendantNodes().OfType[AccessorExpressionSyntax]().First()
        let receiver = model.GetReceiverTypeInfo(access.LeftPart).Type!!
        let position = source.IndexOf("// PChain", StringComparison.Ordinal)
        Assert.Single(model.LookupMembers(position, receiver, "Foo"))
        Assert.Single(model.LookupMembers(position, receiver, "Bar"))
    }

    @Fact
    func ImportedOverride_AGenericMethodOfTheSameShape_IsNotTakenForTheSynthesizedEquals() {
        let library = EmitCSharpLibrary(
            "namespace Generic { public class Base { public bool Equals<T>(object other) { return false; } } }",
            "AsmGeneric",
            "generic"
        )
        using let resolver = ReferenceResolver.WithReferences([]string{library})
        resolver.CurrentAssemblyName = "Consumer"
        let source = "package Consumer\nimport Generic\n\ndata class D : Base {\n    let X int32\n}\n\nfunc Run(d D) {\n    d.ToString() // PGeneric\n}\n"
        let tree = GsSyntaxTree.Parse(SourceText.From(source, "consumer.gs"))
        let model = Compilation(resolver, tree).GetSemanticModel(tree)
        let access = tree.Root.DescendantNodes().OfType[AccessorExpressionSyntax]().First()
        let receiver = model.GetReceiverTypeInfo(access.LeftPart).Type!!
        let position = source.IndexOf("// PGeneric", StringComparison.Ordinal)
        let equals = model.LookupMembers(position, receiver, "Equals")
        Assert.Contains(equals, (m Symbol) -> m is ImportedFunctionSymbol imported && imported.Method.IsGenericMethod)
        // The synthesized override of `object.Equals(object)` still stands for the non-generic slot.
        Assert.DoesNotContain(
            equals,
            (m Symbol) -> m is ImportedFunctionSymbol imported &&
                !imported
                .Method
                .IsGenericMethod &&
                imported
                .Method
                .DeclaringType!!.Name == "Object" &&
                imported
                .Method
                .GetParameters()
                .Length == 1
        )
    }

    @Fact
    func ImportedOverride_OfAGenericBaseWithASourceTypeArgument_StandsForTheSlot() {
        // The override resolver records the slot on the open `Converter<>`; the base is enumerated as the erased
        // `Converter<object>`. Both are one slot.
        let library = EmitCSharpLibrary(
            "namespace Gen { public abstract class Converter<T> { public abstract void Read(T item); public virtual T Write() { return default(T); } } }",
            "AsmConverter",
            "converter"
        )
        using let resolver = ReferenceResolver.WithReferences([]string{library})
        resolver.CurrentAssemblyName = "Consumer"
        let source = "package Consumer\nimport Gen\n\nclass Payload { var Value int32 = 0 }\n\nclass PayloadConverter : Converter[Payload] {\n    override func Read(item Payload) { }\n    override func Write() Payload { return Payload{} }\n}\n\nfunc Run(c PayloadConverter) {\n    c.Write() // PConverter\n}\n"
        let tree = GsSyntaxTree.Parse(SourceText.From(source, "consumer.gs"))
        let model = Compilation(resolver, tree).GetSemanticModel(tree)
        let access = tree.Root.DescendantNodes().OfType[AccessorExpressionSyntax]().First()
        let receiver = model.GetReceiverTypeInfo(access.LeftPart).Type!!
        let position = source.IndexOf("// PConverter", StringComparison.Ordinal)
        for name in[]string{"Read", "Write"} {
            let only = Assert.Single(model.LookupMembers(position, receiver, name))
            Assert.IsType[FunctionSymbol](only)
        }
    }

    shared {
        private func EmitCSharpLibrary(
            recordSource string,
            assemblyName string = "CSharpLib5441",
            directory string = "record",
            reference string? = nil
        ) string {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Adr0212ImportedRecord", directory)
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "Lib.dll")
            let syntaxTree = CSharpSyntaxTree.ParseText(recordSource, CSharpParseOptions(LanguageVersion.Latest))
            let referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(
                Path.PathSeparator
            ) ??
                Array.Empty[string]()
            let references = referencePaths
                .Where(File.Exists)
                .Select((p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p)))
                .ToList()
            if reference != nil {
                references.Add(MetadataReference.CreateFromFile(reference))
            }
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []Microsoft.CodeAnalysis.SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithModuleName("Lib.dll")
            )
            using let peStream = File.Create(libraryPath)
            let emitResult = compilation.Emit(peStream)
            Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            return libraryPath
        }
    }
}
