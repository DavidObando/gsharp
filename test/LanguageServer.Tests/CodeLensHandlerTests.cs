// <copyright file="CodeLensHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class CodeLensHandlerTests
{
    [Fact]
    public void ComputeLenses_ShowsReferenceCounts()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\nvar x = add(1, 2)\nvar y = add(3, 4)\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content);

        // func add + var x + var y
        Assert.Equal(3, lenses.Count);
        Assert.Equal("2 references", lenses[0].Command.Title);
    }

    [Fact]
    public void ComputeLenses_ShowsSingularReference()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\nvar x = add(1, 2)\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content);

        // func add + var x
        Assert.Equal(2, lenses.Count);
        Assert.Equal("1 reference", lenses[0].Command.Title);
    }

    [Fact]
    public void ComputeLenses_ShowsZeroReferences()
    {
        const string source = "func unused(a int32) int32 { return a }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content);

        Assert.Single(lenses);
        Assert.Equal("0 references", lenses[0].Command.Title);
    }

    [Fact]
    public void ComputeLenses_MultipleFunctions()
    {
        const string source = "func a() int32 { return 1 }\nfunc b() int32 { return a() }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content);

        Assert.Equal(2, lenses.Count);
    }

    [Fact]
    public void ComputeLenses_PopulatesShowReferencesCommandWithArguments()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\nvar x = add(1, 2)\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content, "file:///test.gs");

        // func add + var x
        Assert.Equal(2, lenses.Count);
        var command = lenses[0].Command;
        Assert.Equal("gsharp.showReferences", command.Name);
        Assert.NotNull(command.Arguments);
        Assert.Equal(2, command.Arguments.Length);
        Assert.Equal("file:///test.gs", command.Arguments[0]);
        Assert.IsType<GSharp.LanguageServer.Protocol.Position>(command.Arguments[1]);
    }

    [Fact]
    public void ComputeLenses_StructFields()
    {
        const string source = "type Point struct {\n    X int32\n    Y int32\n}\nvar p = Point{X: 1, Y: 2}\nvar q = p.X\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content);

        // struct + 2 fields + var p + var q
        Assert.Equal(5, lenses.Count);
        var fieldLenses = lenses.Skip(1).Take(2).ToList();
        Assert.All(fieldLenses, l => Assert.NotNull(l.Command));
    }

    [Fact]
    public void ComputeLenses_EnumMembers()
    {
        const string source = "type Color enum {\n    Red,\n    Green,\n    Blue\n}\nvar c = Color.Red\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content);

        // enum type + 3 members + var c
        Assert.Equal(5, lenses.Count);
    }

    [Fact]
    public void ComputeLenses_EnumMemberReferenceCounts()
    {
        const string source = "type Color enum {\n    Red,\n    Green\n}\nvar a = Color.Red\nvar b = Color.Red\nvar c = Color.Green\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content);

        // enum + Red + Green + var a + var b + var c
        Assert.Equal(6, lenses.Count);
        var redLens = lenses.First(l => l.Command.Title.StartsWith("2"));
        Assert.Equal("2 references", redLens.Command.Title);
        var greenLens = lenses.First(l => l.Command.Title.StartsWith("1"));
        Assert.Equal("1 reference", greenLens.Command.Title);
    }

    [Fact]
    public void ComputeLenses_ClassBodyMethods()
    {
        const string source = "type Counter class {\n    Value int32\n    func Increment() {\n        Value = Value + 1\n    }\n}\nvar c = Counter{Value: 0}\nc.Increment()\nc.Increment()\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content);

        // class + 1 field + 1 method + var c
        Assert.Equal(4, lenses.Count);
    }

    [Fact]
    public void ComputeLenses_InterfaceMethods()
    {
        const string source = "type Greeter interface {\n    func Greet() string\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content);

        // interface + 1 method
        Assert.Equal(2, lenses.Count);
    }

    [Fact]
    public void ComputeLenses_TopLevelVariables()
    {
        const string source = "let x = 42\nvar y = x + 1\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content);

        // let x + var y
        Assert.Equal(2, lenses.Count);
        Assert.Equal("1 reference", lenses[0].Command.Title); // x referenced in y's initializer
        Assert.Equal("0 references", lenses[1].Command.Title); // y not referenced
    }

    [Fact]
    public void ComputeLenses_TypeAlias()
    {
        const string source = "type MyInt = int32\nvar x MyInt = 5\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content);

        // type alias + var x
        Assert.True(lenses.Count >= 1, "Expected at least 1 lens for type alias");
    }

    [Fact]
    public void ComputeLenses_SharedBlockMembers()
    {
        const string source = "type Config class {\n    Name string\n    shared {\n        Default string\n    }\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content);

        // class + instance field (Name) + static field (Default)
        Assert.Equal(3, lenses.Count);
    }
}

// Temporary reproduction test
public class CodeLensReproTests
{
    [Xunit.Fact]
    public void Repro_UserFile_ClassWithSharedBlock()
    {
        const string source = "package Temp\n\nimport System\n\ntype Person class {\n    shared {\n        prop CallCount int32\n    }\n    public prop Name string\n    public prop Age int32\n\n    func ToString() string {\n        return \"Name: ${Name}, Age: ${this.Age}\"\n    }\n}\n\nfunc Main() {\n    var person = Person{}\n    person.Name = \"Alice\"\n    person.Age = 30\n    Console.WriteLine(\"Name: ${person.Name}\")\n}\n";
        var content = GSharp.LanguageServer.Tests.LanguageServerTestHelpers.Content(source);

        var lenses = GSharp.LanguageServer.CodeLensComputer.ComputeLenses(content);

        System.Console.WriteLine($"Total lenses: {lenses.Count}");
        foreach (var l in lenses)
        {
            System.Console.WriteLine($"  line {l.Range.Start.Line}: {l.Command.Title}");
        }

        // Expect: class Person + shared prop + instance prop Name + instance prop Age + method ToString + func Main + vars
        Xunit.Assert.True(lenses.Count > 2, $"Expected lenses for class members, got {lenses.Count}");
    }

    [Xunit.Fact]
    public void Repro_UserFile_WithProjectState()
    {
        // Simulate the real server path where a ProjectState is used
        const string source = "package Temp\n\nimport System\n\ntype Person class {\n    shared {\n        prop CallCount int32\n    }\n    public prop Name string\n    public prop Age int32\n\n    func ToString() string {\n        return \"Name: ${Name}, Age: ${this.Age}\"\n    }\n}\n\nfunc Main() {\n    var person = Person{}\n    person.Name = \"Alice\"\n    person.Age = 30\n    Console.WriteLine(\"Name: ${person.Name}\")\n}\n";

        // Create a temp project file to satisfy ProjectState constructor
        var tempDir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), System.Guid.NewGuid().ToString());
        System.IO.Directory.CreateDirectory(tempDir);
        var projFile = System.IO.Path.Combine(tempDir, "test.gsproj");
        System.IO.File.WriteAllText(projFile, "{}");
        var filePath = System.IO.Path.Combine(tempDir, "Program.gs");

        try
        {
            var project = new GSharp.LanguageServer.ProjectState(projFile);
            var syntaxTree = project.UpdateFile(filePath, source);

            // Create DocumentContent the same way the real server does
            var lines = new System.Collections.Generic.List<int>();
            for (var i = 0; i < source.Length; i++)
            {
                if (source[i] == '\n') lines.Add(i);
            }

            var content = new GSharp.LanguageServer.DocumentContent(syntaxTree, lines, project);

            var lenses = GSharp.LanguageServer.CodeLensComputer.ComputeLenses(content);

            System.Console.WriteLine($"Total lenses (with project): {lenses.Count}");
            foreach (var l in lenses)
            {
                System.Console.WriteLine($"  line {l.Range.Start.Line}: {l.Command.Title}");
            }

            // Same expectations: class + shared prop + 2 instance props + method + Main
            Xunit.Assert.True(lenses.Count >= 6, $"Expected at least 6 lenses for class members, got {lenses.Count}");
        }
        finally
        {
            System.IO.Directory.Delete(tempDir, true);
        }
    }

    [Xunit.Fact]
    public void Repro_StaleContentTree_AfterDiagnosticPullReparses()
    {
        // Reproduces the real-world bug: textDocument/diagnostic calls ProjectState.UpdateFile,
        // which replaces the project's tree with a fresh parse. The DocumentContent cached during
        // textDocument/didOpen still holds the prior tree. Without the fix, SemanticLookup uses
        // reference equality on SyntaxTokens and member-identifier lookups silently return null,
        // causing class members to lose their CodeLenses.
        const string source = "package Temp\n\nimport System\n\ntype Person class {\n    shared {\n        prop CallCount int32\n    }\n    public prop Name string\n    public prop Age int32\n\n    func ToString() string {\n        return \"Name: ${Name}, Age: ${this.Age}\"\n    }\n}\n\nfunc Main() {\n    var person = Person{}\n    person.Name = \"Alice\"\n}\n";

        var tempDir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), System.Guid.NewGuid().ToString());
        System.IO.Directory.CreateDirectory(tempDir);
        var projFile = System.IO.Path.Combine(tempDir, "test.gsproj");
        System.IO.File.WriteAllText(projFile, "{}");
        var filePath = System.IO.Path.Combine(tempDir, "Program.gs");

        try
        {
            var project = new GSharp.LanguageServer.ProjectState(projFile);

            // First parse: the tree DocumentContent captures (simulates didOpen).
            var staleTree = project.UpdateFile(filePath, source);

            var lines = new System.Collections.Generic.List<int>();
            for (var i = 0; i < source.Length; i++)
            {
                if (source[i] == '\n') lines.Add(i);
            }

            var content = new GSharp.LanguageServer.DocumentContent(staleTree, lines, project);

            // Second parse: simulates the diagnostic pull reparsing the same text. The project
            // now holds fresh SyntaxToken instances; content.SyntaxTree (staleTree) does not.
            project.UpdateFile(filePath, source);

            // Force the compilation to be rebuilt from the fresh tree.
            _ = project.GetCompilation();

            var uri = System.IO.Path.IsPathRooted(filePath)
                ? new System.Uri(filePath).AbsoluteUri
                : new System.Uri(System.IO.Path.GetFullPath(filePath)).AbsoluteUri;

            var lenses = GSharp.LanguageServer.CodeLensComputer.ComputeLenses(content, uri);

            // Class Person + CallCount + Name + Age + ToString + Main = 6
            Xunit.Assert.True(
                lenses.Count >= 6,
                $"Expected >= 6 lenses (including class members) after a reparse desync, got {lenses.Count}: "
                    + string.Join(", ", lenses.Select(l => $"line {l.Range.Start.Line}:'{l.Command.Title}'")));
        }
        finally
        {
            System.IO.Directory.Delete(tempDir, true);
        }
    }
}
