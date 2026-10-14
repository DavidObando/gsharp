// <copyright file="Issue2395FileScopedImportTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Threading
import System.Threading.Tasks
import Xunit

/// Issue #2395: imports belong to the syntax tree that declares them.
open class Issue2395FileScopedImportTests {
    @Theory
    @InlineData(true)
    @InlineData(false)
    func ClrNamespaceImport_IsVisibleOnlyInDeclaringFile_ForSignaturesAndBodies(importingFileFirst bool) {
        const importing = `package Demo
import System.Text

class ImportedUser {
    func Make(value StringBuilder) StringBuilder {
        return StringBuilder(value.ToString())
    }
}`
        const unrelated = `package Demo

class UnrelatedUser {
    func Make(value StringBuilder) StringBuilder {
        return StringBuilder(value.ToString())
    }
}`
        let errors = Errors(Order(importingFileFirst, importing, unrelated)).ToArray()
        Assert.DoesNotContain(errors, (d Diagnostic) -> d.Location.FileName == "importing.gs")
        Assert.Contains(errors, (d Diagnostic) -> d.Location.FileName == "unrelated.gs")
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    func StaticTypeImport_AndClrAlias_DoNotLeakToSiblingFile(importingFileFirst bool) {
        const library = `package Library

class MathUtil {
    shared {
        func Twice(value int32) int32 { return value * 2 }
    }
}`
        const importing = `package Demo
import Library.MathUtil
import io = System.IO

class ImportedUser {
    func Calculate() int32 { return Twice(16) }
    func Current() string { return io.Directory.GetCurrentDirectory() }
}`
        const unrelated = `package Demo

class UnrelatedUser {
    func Calculate() int32 { return Twice(16) }
    func Current() string { return io.Directory.GetCurrentDirectory() }
}`
        let ordered = if importingFileFirst {
            [](string, string){("library.gs", library), ("importing.gs", importing), ("unrelated.gs", unrelated)}
        } else {
            [](string, string){("unrelated.gs", unrelated), ("importing.gs", importing), ("library.gs", library)}
        }
        let errors = Errors(ordered).ToArray()
        Assert.DoesNotContain(errors, (d Diagnostic) -> d.Location.FileName == "importing.gs")
        Assert.Contains(errors, (d Diagnostic) -> d.Location.FileName == "unrelated.gs")
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    func ClrExtensionNamespaceImport_DoesNotLeakToSiblingFile(importingFileFirst bool) {
        const importing = `package Demo
import System.Linq

class ImportedUser {
    func Convert(values []int32) object { return values.ToHashSet() }
}`
        const unrelated = `package Demo

class UnrelatedUser {
    func Convert(values []int32) object { return values.ToHashSet() }
}`
        let errors = Errors(Order(importingFileFirst, importing, unrelated)).ToArray()
        Assert.DoesNotContain(errors, (d Diagnostic) -> d.Location.FileName == "importing.gs")
        Assert.Contains(errors, (d Diagnostic) -> d.Location.FileName == "unrelated.gs")
    }

    @Fact
    func SamePackageDeclarationsRemainVisibleAcrossFiles_AndForeignTypeCanBeQualified() {
        const declarations = `package Demo

class Shared {}
func MakeShared() Shared { return Shared{} }`
        const consumer = `package Demo

class Consumer {
    func Use(value Shared) Shared { return MakeShared() }
}`
        const foreign = `package Foreign

class External {}`
        const qualified = `package Demo

class Qualified {
    func Make() object { return Foreign.External{} }
}`
        Assert.Empty(
            Errors(
                [](string, string){
                    ("declarations.gs", declarations),
                    ("consumer.gs", consumer),
                    ("foreign.gs", foreign),
                    ("qualified.gs", qualified)
                }
            )
        )
    }

    @Fact
    func UnrelatedFileImport_CannotDisambiguateCollidingSimpleName() {
        const left = `package Left
class Result {}
`
        const right = `package Right
class Result {}
`
        const unrelated = `package Other
import Left
class Marker {}
`
        const consumer = `package Consumer

class UsesResult {
    prop Value Result
}`
        let errors = Errors(
            [](string, string){
                ("left.gs", left),
                ("right.gs", right),
                ("unrelated.gs", unrelated),
                ("consumer.gs", consumer)
            }
        ).ToArray()
        Assert.DoesNotContain(errors, (d Diagnostic) -> d.Id == "GS0496")
    }

    @Fact
    func SameFileCollidingImports_ReportAmbiguityAtReferencingFile() {
        const left = `package Left
class Result {}
`
        const right = `package Right
class Result {}
`
        const consumer = `package Consumer
import Left
import Right

class UsesResult {
    prop Value Result
}`
        let errors = Errors(
            [](string, string){("right.gs", right), ("consumer.gs", consumer), ("left.gs", left)}
        ).ToArray()
        Assert.Contains(errors, (d Diagnostic) -> d.Id == "GS0496" && d.Location.FileName == "consumer.gs")
    }

    @Fact
    async func ConcurrentReferencingTrees_DoNotShareAmbientImportContext() {
        let leftTree = SyntaxTree.Parse(SourceText.From("import System.Text\n", "left.gs"))
        let rightTree = SyntaxTree.Parse(SourceText.From("import System.IO\n", "right.gs"))
        let leftImport = leftTree.Root.Members.OfType[ImportSyntax]().Single()
        let rightImport = rightTree.Root.Members.OfType[ImportSyntax]().Single()
        let scope_ = BoundScope(parent: nil)
        scope_.TryImport(ImportSymbol("System.Text", "System.Text", leftImport))
        scope_.TryImport(ImportSymbol("System.IO", "System.IO", rightImport))
        using let ready = CountdownEvent(2)
        let VisibleImports = async func (tree SyntaxTree) ImmutableArray[string] {
            let previous SyntaxTree? = scope_.SetCurrentReferencingSyntaxTree(tree)
            try {
                ready.Signal()
                await Task.Run(() -> ready.Wait())
                return scope_.GetDeclaredImports().Select((i ImportSymbol) -> i.Target).ToImmutableArray()
            } finally {
                scope_.SetCurrentReferencingSyntaxTree(previous)
            }
        }
        let results = await Task.WhenAll(VisibleImports(leftTree), VisibleImports(rightTree))
        Assert.Equal([]string{"System.Text"}, results[0])
        Assert.Equal([]string{"System.IO"}, results[1])
    }

    shared {
        private func Order(first bool, importing string, unrelated string)[](FileName string, Source string) {
            return if first {
                [](string, string){("importing.gs", importing), ("unrelated.gs", unrelated)}
            } else {
                [](string, string){("unrelated.gs", unrelated), ("importing.gs", importing)}
            }
        }

        private func Errors(sources IEnumerable[(FileName string, Source string)]) IEnumerable[Diagnostic] {
            let trees = sources.Select(
                (source(FileName string, Source string)) -> SyntaxTree.Parse(
                    SourceText.From(source.Source, source.FileName)
                )
            )
                .ToArray()
            let compilation = Compilation(trees){IsLibrary = true}
            return compilation
                .GlobalScope
                .Diagnostics
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((d Diagnostic) -> d.IsError)
        }
    }
}
