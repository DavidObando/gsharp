// <copyright file="Issue2947ImportedNestedGenericTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #2947: imported nested types retain symbolic enclosing arguments.
open class Issue2947ImportedNestedGenericTypeTests {
    @Fact
    func ImportedNestedEnumLiterals_RetainSymbolicOuterArgumentAtBothDepths() {
        let directory = CreateEmptyTestDirectory()
        try {
            let libraryPath = Path.Combine(directory, "glib.dll")
            EmitLibrary(libraryPath)
            {
                using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
                let compilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package consumer

func Take[T]() {
    var direct glib.Outer[T].Color = glib.Outer[T].Color.Green
    var deep glib.Outer[T].Mid.Tone = glib.Outer[T].Mid.Tone.Green
    var invalid int32 = direct
}`)))
                let errors = compilation
                    .GlobalScope
                    .Diagnostics
                    .Concat(compilation.BoundProgram.Diagnostics)
                    .Where((diagnostic Diagnostic) -> diagnostic.IsError)
                    .ToArray()
                let error = Assert.Single(errors)
                Assert.Equal("GS0156", error.Id)
                Assert.Equal(
                    "Cannot convert type 'glib.Outer[T].Color' to 'int32'. An explicit conversion exists (are you missing a cast?)",
                    error.Message
                )
                let function = compilation
                    .BoundProgram
                    .Functions
                    .Keys
                    .Single((symbol FunctionSymbol) -> symbol.Name == "Take")
                let collector = Issue2947ImportedNestedGenericTypeTests.EnumLiteralCollector()
                collector.Visit(compilation.BoundProgram.Functions[function])
                AssertSymbolicImportedType(
                    collector.Literals.Single((literal BoundLiteralExpression) -> object.Equals(literal.Value, 5)),
                    "type glib.Outer[T].Color",
                    compilation
                )
                AssertSymbolicImportedType(
                    collector.Literals.Single((literal BoundLiteralExpression) -> object.Equals(literal.Value, 8)),
                    "type glib.Outer[T].Mid.Tone",
                    compilation
                )
            }
            let _ = Assembly.LoadFrom(libraryPath)
            let runtimeCompilation = Compilation(SyntaxTree.Parse(SourceText.From(`package consumer

struct Holder[T] {
    func Take() {
        var direct glib.Outer[T].Color = glib.Outer[T].Color.Green
        var invalid int32 = direct
    }
}`)))
            let runtimeErrors = runtimeCompilation
                .GlobalScope
                .Diagnostics
                .Concat(runtimeCompilation.BoundProgram.Diagnostics)
                .Where((diagnostic Diagnostic) -> diagnostic.IsError)
                .ToArray()
            Assert.Equal(
                []string{
                    "Cannot convert type 'glib.Outer[T].Color' to 'int32'. An explicit conversion exists (are you missing a cast?)"
                },
                runtimeErrors.Select((diagnostic Diagnostic) -> diagnostic.Message)
            )
        } finally {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }

    private class EnumLiteralCollector : BoundTreeWalker {
        init() {
            Literals = List[BoundLiteralExpression]()
        }

        prop Literals List[BoundLiteralExpression] {
            get;
        }

        override func VisitExpression(node BoundExpression) {
            if node is BoundLiteralExpression literal {
                Literals.Add(literal)
            }
            base.VisitExpression(node)
        }
    }

    shared {
        private func AssertSymbolicImportedType(
            literal BoundLiteralExpression,
            expectedDisplay string,
            compilation Compilation
        ) {
            let imported = Assert.IsType[ImportedTypeSymbol](literal.Type)
            Assert.True(imported.HasTypeParameterArgument)
            Assert.Equal("T", Assert.Single(imported.TypeArguments).Name)
            Assert.Equal(
                expectedDisplay,
                SymbolDisplay.ToDisplayString(imported, SymbolDisplayFormat.Signature, compilation)
            )
        }

        private func EmitLibrary(outputPath string) {
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(`package glib

public struct Outer[T] {
    public enum Color { Red = 4, Green = 5, Blue = 6 }

    public struct Mid {
        public enum Tone { Red = 7, Green = 8, Blue = 9 }
    }
}`))){IsLibrary = true}
            using let output = File.Create(outputPath)
            let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "glib")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func CreateEmptyTestDirectory() string {
            let root = Path.Combine(Environment.CurrentDirectory, "TestArtifacts")
            Directory.CreateDirectory(root)
            let path = Path.Combine(root, "${"Issue2947ImportedNestedGenericTypeTests"}-${Guid.NewGuid():N}")
            Directory.CreateDirectory(path)
            Assert.Empty(Directory.GetFileSystemEntries(path))
            return path
        }
    }
}
