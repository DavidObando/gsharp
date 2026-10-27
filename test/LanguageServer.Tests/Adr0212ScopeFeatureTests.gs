// <copyright file="Adr0212ScopeFeatureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading
import Xunit

/// ADR-0212 slice S3: the features that moved onto `SemanticModel.LookupSymbols` and
/// `GetEnclosingSymbol`: name completion and the implementation request.
open class Adr0212ScopeFeatureTests {
    @Fact
    func Completion_OffersParametersAndLocalsDeclaredBeforeTheCaret() {
        let items = Complete(Source, "// caret")
        let param = Assert.Single(items, (i CompletionItem) -> i.Label == "param")
        Assert.Equal(CompletionItemKind.Variable, param.Kind)
        let early = Assert.Single(items, (i CompletionItem) -> i.Label == "early")
        Assert.Equal(CompletionItemKind.Variable, early.Kind)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Run" && i.Kind == CompletionItemKind.Function)
    }

    @Fact
    func Completion_DoesNotOfferALocalDeclaredAfterTheCaret() {
        let items = Complete(Source, "// caret")
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Label == "late")
    }

    @Fact
    func Completion_OffersTheEnclosingTypesMembersInAMethod() {
        let items = Complete(Source, "// in method")
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Field" && i.Kind == CompletionItemKind.Field)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Other" && i.Kind == CompletionItemKind.Function)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "this")
    }

    @Fact
    func Completion_OffersTypeAliasNames() {
        // LookupSymbols cannot list an alias (no alias symbol); completion still offers its name.
        let items = Complete(Source, "// caret")
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Meters")
        // `type $Feet` is the alias `Feet`; its target is found by the semantic name.
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Feet" && i.Detail != nil)
    }

    @Fact
    func Completion_WritesAKeywordNamedSymbolWithItsEscape() {
        // The local `$type` is named `type`; written bare it would be the keyword.
        let source = `package P
func Escaped($params string) string {
    let $type = $params
    // caret
    return $type
}
`
        let items = Complete(source, "// caret")
        Assert.Contains(items, (i CompletionItem) -> i.Label == "$$type")
        // `params` is only special in a parameter list, so a use is written bare.
        Assert.Contains(items, (i CompletionItem) -> i.Label == "params" && i.Kind == CompletionItemKind.Variable)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Label == "type" && i.Kind == CompletionItemKind.Variable)
    }

    @Fact
    func Completion_ListsEachNameOnce() {
        let items = Complete(Source, "// caret")
        let labels = items.Select((i CompletionItem) -> i.Label).ToList()
        Assert.Equal(labels.Count, labels.Distinct().Count())
    }

    @Fact
    async func Implementation_FindsStructsOfEveryFileOfTheProject() {
        let rootDir = Path.Combine(Path.GetTempPath(), "gsimpl_" + Guid.NewGuid().ToString("N"))
        let projDir = Path.Combine(rootDir, "Demo")
        Directory.CreateDirectory(projDir)
        try {
            File.WriteAllText(Path.Combine(projDir, "Demo.gsproj"), `<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup><OutputType>Library</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>Demo</AssemblyName></PropertyGroup>
</Project>
`)
            let shapes = `package Demo

interface Shape {
    func Area() int32
}

class Square : Shape {
    func Area() int32 { return 1 }
}
`
            let circles = `package Demo

partial class Circle : Shape {
    func Area() int32 { return 2 }
}

partial class Circle {
    var Radius int32
}

class Unrelated {
}
`
            let shapesPath = Path.Combine(projDir, "a_shapes.gs")
            File.WriteAllText(shapesPath, shapes)
            File.WriteAllText(Path.Combine(projDir, "b_circles.gs"), circles)
            let workspace = WorkspaceState()
            WorkspaceInitializer.Initialize(workspace, rootDir)
            let server = LspServer(DocumentContentService(), workspace)
            let uri = DocumentUri.FromFileSystemPath(shapesPath)!!
            await server.DidOpenAsync(DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: shapes}})
            let found = await server.ImplementationAsync(
                ImplementationParams{
                    TextDocument: TextDocumentIdentifier{Uri: uri},
                    Position: LanguageServerTestHelpers.PositionOf(shapes, "Shape")
                }
            )
            // Both implementers are found, whichever order the project lists its files in. Every location
            // carries the URI of the file that declares it; the ranges are the declared names.
            // A partial type is reported once, not once per part.
            Assert.Equal(2, found.Length)
            let starts = found.Select((l Location) -> l.Range.Start.Line).OrderBy((line int32) -> line).ToArray()
            Assert.Equal([]int32{2, 6}, starts)
            let circleUri = DocumentUri.FromFileSystemPath(Path.Combine(projDir, "b_circles.gs"))!!
            let circle = found.Single((l Location) -> l.Range.Start.Line == 2)
            let square = found.Single((l Location) -> l.Range.Start.Line == 6)
            Assert.Equal(circleUri.ToString(), circle.Uri!!.ToString())
            Assert.Equal(uri.ToString(), square.Uri!!.ToString())
        } finally {
            Directory.Delete(rootDir, true)
        }
    }

    @Fact
    async func Implementation_PartialTypeAcrossFilesPairsUriWithItsOwnRange() {
        let rootDir = Path.Combine(Path.GetTempPath(), "gsimpl_" + Guid.NewGuid().ToString("N"))
        let projDir = Path.Combine(rootDir, "Demo")
        Directory.CreateDirectory(projDir)
        try {
            File.WriteAllText(Path.Combine(projDir, "Demo.gsproj"), `<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup><OutputType>Library</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>Demo</AssemblyName></PropertyGroup>
</Project>
`)
            let shapes = `package Demo

interface Shape {
    func Area() int32
}

partial class Circle {
    var Radius int32
}
`
            let circles = `package Demo

partial class Circle : Shape {
    func Area() int32 { return 2 }
}
`
            let shapesPath = Path.Combine(projDir, "a_shapes.gs")
            File.WriteAllText(shapesPath, shapes)
            File.WriteAllText(Path.Combine(projDir, "b_circles.gs"), circles)
            let workspace = WorkspaceState()
            WorkspaceInitializer.Initialize(workspace, rootDir)
            let server = LspServer(DocumentContentService(), workspace)
            let uri = DocumentUri.FromFileSystemPath(shapesPath)!!
            await server.DidOpenAsync(DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: shapes}})
            let found = await server.ImplementationAsync(
                ImplementationParams{
                    TextDocument: TextDocumentIdentifier{Uri: uri},
                    Position: LanguageServerTestHelpers.PositionOf(shapes, "Shape")
                }
            )
            // One location, whichever part is canonical: its URI is the file that holds its range.
            let location = Assert.Single(found)
            let inShapes = location.Uri!!.ToString() == uri.ToString()
            Assert.Equal(
                if inShapes {
                    6
                } else {
                    2
                },
                location.Range.Start.Line
            )
        } finally {
            Directory.Delete(rootDir, true)
        }
    }

    shared {
        private const Source string = `package P
type Meters = int32
type $Feet = int32
class Holder {
    var Field int32
    func Other() int32 { return 1 }
    func Method() int32 {
        return 0 // in method
    }
}
func Run(param int32) int32 {
    let early = 1
    // caret
    let late = 2
    return param + early + late
}
`

        private func Complete(source string, marker string) IReadOnlyList[CompletionItem] {
            let content = LanguageServerTestHelpers.Content(source)
            return CompletionComputer.ComputeCompletions(content, LanguageServerTestHelpers.PositionOf(source, marker))
        }
    }
}
