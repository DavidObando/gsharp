// <copyright file="CodeLensHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading
import Xunit

open class CodeLensHandlerTests {
    @Fact
    func ComputeLenses_ShowsReferenceCounts() {
        const source = `func add(a int32, b int32) int32 { return a + b }
var x = add(1, 2)
var y = add(3, 4)
`
        let content = LanguageServerTestHelpers.Content(source)
        let lenses = CodeLensComputer.ComputeLenses(content)
        // func add + var x + var y
        Assert.Equal(3, lenses.Count)
        Assert.Equal("2 references", lenses[0].Command!!.Title)
    }

    @Fact
    func ComputeLenses_ShowsSingularReference() {
        const source = `func add(a int32, b int32) int32 { return a + b }
var x = add(1, 2)
`
        let content = LanguageServerTestHelpers.Content(source)
        let lenses = CodeLensComputer.ComputeLenses(content)
        // func add + var x
        Assert.Equal(2, lenses.Count)
        Assert.Equal("1 reference", lenses[0].Command!!.Title)
    }

    @Fact
    func ComputeLenses_ShowsZeroReferences() {
        const source = "func unused(a int32) int32 { return a }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let lenses = CodeLensComputer.ComputeLenses(content)
        Assert.Single(lenses)
        Assert.Equal("0 references", lenses[0].Command!!.Title)
    }

    @Fact
    func ComputeLenses_MultipleFunctions() {
        const source = `func a() int32 { return 1 }
func b() int32 { return a() }
`
        let content = LanguageServerTestHelpers.Content(source)
        let lenses = CodeLensComputer.ComputeLenses(content)
        Assert.Equal(2, lenses.Count)
    }

    @Fact
    func ComputeLenses_PopulatesShowReferencesCommandWithArguments() {
        const source = `func add(a int32, b int32) int32 { return a + b }
var x = add(1, 2)
`
        let content = LanguageServerTestHelpers.Content(source)
        let lenses = CodeLensComputer.ComputeLenses(content, "file:///test.gs")
        // func add + var x
        Assert.Equal(2, lenses.Count)
        let command Command? = lenses[0].Command
        Assert.Equal("gsharp.showReferences", command!!.Name)
        Assert.NotNull(command!!.Arguments)
        Assert.Equal(2, command!!.Arguments.Length)
        Assert.Equal("file:///test.gs", command!!.Arguments[0])
        Assert.IsType[Position](command!!.Arguments[1])
    }

    @Fact
    func ComputeReferenceLenses_ReturnsClientNeutralLocations() {
        const source = `func add(a int32, b int32) int32 { return a + b }
var x = add(1, 2)
var y = add(3, 4)
`
        const uri = "file:///test.gs"
        let content = LanguageServerTestHelpers.Content(source)
        let lenses = CodeLensComputer.ComputeReferenceLenses(content, uri)
        Assert.Equal(3, lenses.Count)
        Assert.Equal(0, lenses[0].DeclarationRange.Start.Line)
        Assert.Equal(2, lenses[0].ReferenceCount)
        Assert.Equal(2, lenses[0].References.Length)
        Assert.All(lenses[0].References, (location Location) -> Assert.Equal(uri, location.Uri!!.ToString()))
        Assert.Equal([]int32{1, 2}, lenses[0].References.Select((location Location) -> location.Range.Start.Line))
    }

    @Fact
    func ComputeLenses_StructFields() {
        const source = `struct Point {
    var X int32
    var Y int32
}
var p = Point{X: 1, Y: 2}
var q = p.X
`
        let content = LanguageServerTestHelpers.Content(source)
        let lenses = CodeLensComputer.ComputeLenses(content)
        // struct + 2 fields + var p + var q
        Assert.Equal(5, lenses.Count)
        let fieldLenses = lenses.Skip(1).Take(2).ToList()
        Assert.All(fieldLenses, (l CodeLens) -> Assert.NotNull(l.Command))
    }

    @Fact
    func ComputeLenses_EnumMembers() {
        const source = `enum Color {
    Red,
    Green,
    Blue
}
var c = Color.Red
`
        let content = LanguageServerTestHelpers.Content(source)
        let lenses = CodeLensComputer.ComputeLenses(content)
        // enum type + 3 members + var c
        Assert.Equal(5, lenses.Count)
    }

    @Fact
    func ComputeLenses_EnumMemberReferenceCounts() {
        const source = `enum Color {
    Red,
    Green
}
var a = Color.Red
var b = Color.Red
var c = Color.Green
`
        let content = LanguageServerTestHelpers.Content(source)
        let lenses = CodeLensComputer.ComputeLenses(content)
        // enum + Red + Green + var a + var b + var c
        Assert.Equal(6, lenses.Count)
        let redLens = lenses.First((l CodeLens) -> l.Command!!.Title.StartsWith("2"))
        Assert.Equal("2 references", redLens.Command!!.Title)
        let greenLens = lenses.First((l CodeLens) -> l.Command!!.Title.StartsWith("1"))
        Assert.Equal("1 reference", greenLens.Command!!.Title)
    }

    @Fact
    func ComputeLenses_ClassBodyMethods() {
        const source = `class Counter {
    var Value int32
    func Increment() {
        Value = Value + 1
    }
}
var c = Counter{Value: 0}
c.Increment()
c.Increment()
`
        let content = LanguageServerTestHelpers.Content(source)
        let lenses = CodeLensComputer.ComputeLenses(content)
        // class + 1 field + 1 method + var c
        Assert.Equal(4, lenses.Count)
    }

    @Fact
    func ComputeLenses_InterfaceMethods() {
        const source = `interface Greeter {
    func Greet() string
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let lenses = CodeLensComputer.ComputeLenses(content)
        // interface + 1 method
        Assert.Equal(2, lenses.Count)
    }

    @Fact
    func ComputeLenses_TopLevelVariables() {
        const source = `let x = 42
var y = x + 1
`
        let content = LanguageServerTestHelpers.Content(source)
        let lenses = CodeLensComputer.ComputeLenses(content)
        // let x + var y
        Assert.Equal(2, lenses.Count)
        Assert.Equal("1 reference", lenses[0].Command!!.Title) // x referenced in y's initializer
        Assert.Equal("0 references", lenses[1].Command!!.Title) // y not referenced

    }

    @Fact
    func ComputeLenses_TypeAlias() {
        const source = `type MyInt = int32
var x MyInt = 5
`
        let content = LanguageServerTestHelpers.Content(source)
        let lenses = CodeLensComputer.ComputeLenses(content)
        // type alias + var x
        Assert.True(lenses.Count >= 1, "Expected at least 1 lens for type alias")
    }

    @Fact
    func ComputeLenses_SharedBlockMembers() {
        const source = `class Config {
    var Name string
    shared {
        var Default string
    }
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let lenses = CodeLensComputer.ComputeLenses(content)
        // class + instance field (Name) + static field (Default)
        Assert.Equal(3, lenses.Count)
    }
}

// Temporary reproduction test
open class CodeLensReproTests {
    @Xunit.Fact
    func Repro_UserFile_ClassWithSharedBlock() {
        const source = `package Temp

import System

class Person {
    shared {
        prop CallCount int32
    }
    public prop Name string
    public prop Age int32

    func ToString() string {
        return "Name: ${Name}, Age: ${this.Age}"
    }
}

func Main() {
    var person = Person{}
    person.Name = "Alice"
    person.Age = 30
    Console.WriteLine("Name: ${person.Name}")
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let lenses = CodeLensComputer.ComputeLenses(content)
        Console.WriteLine("Total lenses: ${lenses.Count}")
        for l in lenses {
            Console.WriteLine("  line ${l.Range.Start.Line}: ${l.Command!!.Title}")
        }
        // Expect: class Person + shared prop + instance prop Name + instance prop Age + method ToString + func Main + vars
        Assert.True(lenses.Count > 2, "Expected lenses for class members, got ${lenses.Count}")
    }

    @Xunit.Fact
    func Repro_UserFile_WithProjectState() {
        // Simulate the real server path where a ProjectState is used
        const source = `package Temp

import System

class Person {
    shared {
        prop CallCount int32
    }
    public prop Name string
    public prop Age int32

    func ToString() string {
        return "Name: ${Name}, Age: ${this.Age}"
    }
}

func Main() {
    var person = Person{}
    person.Name = "Alice"
    person.Age = 30
    Console.WriteLine("Name: ${person.Name}")
}
`
        // Create a temp project file to satisfy ProjectState constructor
        let tempDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString())
        Directory.CreateDirectory(tempDir)
        let projFile = Path.Combine(tempDir, "test.gsproj")
        File.WriteAllText(projFile, "{}")
        let filePath = Path.Combine(tempDir, "Program.gs")
        try {
            let project = ProjectState(projFile)
            let syntaxTree = project.UpdateFile(filePath, source)
            // Create DocumentContent the same way the real server does
            let lines = List[int32]()
            for var i = 0; i < source.Length; i++ {
                if source[i] == '\n' {
                    lines.Add(i)
                }
            }
            let content = DocumentContent(syntaxTree, lines, project)
            let lenses = CodeLensComputer.ComputeLenses(content)
            Console.WriteLine("Total lenses (with project): ${lenses.Count}")
            for l in lenses {
                Console.WriteLine("  line ${l.Range.Start.Line}: ${l.Command!!.Title}")
            }
            // Same expectations: class + shared prop + 2 instance props + method + Main
            Assert.True(lenses.Count >= 6, "Expected at least 6 lenses for class members, got ${lenses.Count}")
        } finally {
            Directory.Delete(tempDir, true)
        }
    }

    @Xunit.Fact
    func Repro_StaleContentTree_AfterDiagnosticPullReparses() {
        // Reproduces the real-world bug: textDocument/diagnostic calls ProjectState.UpdateFile,
        // which replaces the project's tree with a fresh parse. The DocumentContent cached during
        // textDocument/didOpen still holds the prior tree. Without the fix, SemanticLookup uses
        // reference equality on SyntaxTokens and member-identifier lookups silently return null,
        // causing class members to lose their CodeLenses.
        const source = `package Temp

import System

class Person {
    shared {
        prop CallCount int32
    }
    public prop Name string
    public prop Age int32

    func ToString() string {
        return "Name: ${Name}, Age: ${this.Age}"
    }
}

func Main() {
    var person = Person{}
    person.Name = "Alice"
}
`
        let tempDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString())
        Directory.CreateDirectory(tempDir)
        let projFile = Path.Combine(tempDir, "test.gsproj")
        File.WriteAllText(projFile, "{}")
        let filePath = Path.Combine(tempDir, "Program.gs")
        try {
            let project = ProjectState(projFile)
            // First parse: the tree DocumentContent captures (simulates didOpen).
            let staleTree = project.UpdateFile(filePath, source)
            let lines = List[int32]()
            for var i = 0; i < source.Length; i++ {
                if source[i] == '\n' {
                    lines.Add(i)
                }
            }
            let content = DocumentContent(staleTree, lines, project)
            // Second parse: simulates the diagnostic pull reparsing the same text. The project
            // now holds fresh SyntaxToken instances; content.SyntaxTree (staleTree) does not.
            project.UpdateFile(filePath, source)
            // Force the compilation to be rebuilt from the fresh tree.
            let _ = project.GetCompilation()
            let uri = if Path.IsPathRooted(filePath) {
                Uri(filePath).AbsoluteUri
            } else {
                Uri(Path.GetFullPath(filePath)).AbsoluteUri
            }
            let lenses = CodeLensComputer.ComputeLenses(content, uri)
            // Class Person + CallCount + Name + Age + ToString + Main = 6
            Assert.True(
                lenses.Count >= 6,
                "Expected >= 6 lenses (including class members) after a reparse desync, got ${lenses.Count}: " +
                    string.Join(
                    ", ",
                    lenses.Select((l CodeLens) -> "line ${l.Range.Start.Line}:'${l.Command!!.Title}'")
                )
            )
        } finally {
            Directory.Delete(tempDir, true)
        }
    }

    @Fact
    func ComputeLenses_HonorsCancellation() {
        // Issue #1662: ComputeLenses accepted a CancellationToken but never observed it, so a
        // superseded request ran the full per-member FindReferences walk to completion. An
        // already-cancelled token must now short-circuit instead of returning a result.
        const source = `func add(a int32, b int32) int32 { return a + b }
var x = add(1, 2)
`
        let content = LanguageServerTestHelpers.Content(source)
        using let cts = CancellationTokenSource()
        cts.Cancel()
        Assert.Throws[OperationCanceledException](
            func () object? {
                return CodeLensComputer.ComputeLenses(content, uri: nil, cts.Token)
            }
        )
    }
}
