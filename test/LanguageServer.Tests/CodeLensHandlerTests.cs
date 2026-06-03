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

        Assert.Single(lenses);
        Assert.Equal("2 references", lenses[0].Command.Title);
    }

    [Fact]
    public void ComputeLenses_ShowsSingularReference()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\nvar x = add(1, 2)\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content);

        Assert.Single(lenses);
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

        var command = Assert.Single(lenses).Command;
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

        // struct + 2 fields
        Assert.Equal(3, lenses.Count);
        var fieldLenses = lenses.Skip(1).ToList();
        Assert.All(fieldLenses, l => Assert.NotNull(l.Command));
    }

    [Fact]
    public void ComputeLenses_EnumMembers()
    {
        const string source = "type Color enum {\n    Red,\n    Green,\n    Blue\n}\nvar c = Color.Red\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content);

        // enum type + 3 members
        Assert.Equal(4, lenses.Count);
    }

    [Fact]
    public void ComputeLenses_EnumMemberReferenceCounts()
    {
        const string source = "type Color enum {\n    Red,\n    Green\n}\nvar a = Color.Red\nvar b = Color.Red\nvar c = Color.Green\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content);

        // enum + Red + Green
        Assert.Equal(3, lenses.Count);
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

        // class + 1 field + 1 method
        Assert.Equal(3, lenses.Count);
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
}
