// <copyright file="DocumentationFileEmitterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Text;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Documentation;

/// <summary>
/// ADR-0057 §5: Tests that the G# doc-emission pipeline produces correct .xml files
/// that C# consumers can parse.
/// </summary>
public class DocumentationFileEmitterTests
{
    [Fact]
    public void EmitsXmlForDocumentedFunction()
    {
        var source = @"package MyLib

/// Adds two numbers.
/// @param a first operand
/// @param b second operand
/// @returns the sum
func Add(a int32, b int32) int32 {
    return a + b
}
";
        var xml = EmitDocXml(source, "MyLib");

        Assert.Contains("<member name=\"M:MyLib.Add(System.Int32,System.Int32)\">", xml);
        Assert.Contains("<summary>", xml);
        Assert.Contains("Adds two numbers.", xml);
        Assert.Contains("<param name=\"a\">", xml);
        Assert.Contains("<param name=\"b\">", xml);
        Assert.Contains("<returns>", xml);
    }

    [Fact]
    public void EmitsXmlForDocumentedStruct()
    {
        var source = @"package Shapes

/// Represents a 2D point.
type Point data struct {
    /// The X coordinate.
    X float64
    /// The Y coordinate.
    Y float64
}
";
        var xml = EmitDocXml(source, "Shapes");

        Assert.Contains("<member name=\"T:Shapes.Point\">", xml);
        Assert.Contains("Represents a 2D point.", xml);
        Assert.Contains("<member name=\"F:Shapes.Point.X\">", xml);
        Assert.Contains("The X coordinate.", xml);
        Assert.Contains("<member name=\"F:Shapes.Point.Y\">", xml);
        Assert.Contains("The Y coordinate.", xml);
    }

    [Fact]
    public void EmitsAssemblyName()
    {
        var source = @"package Lib

/// A function.
func Foo() {}
";
        var xml = EmitDocXml(source, "Lib");
        Assert.Contains("<name>Lib</name>", xml);
    }

    [Fact]
    public void UndocumentedSymbols_NotEmitted()
    {
        var source = @"package Lib

func NoDoc() {}

/// Has docs.
func WithDoc() {}
";
        var xml = EmitDocXml(source, "Lib");
        Assert.DoesNotContain("M:Lib.NoDoc", xml);
        Assert.Contains("M:Lib.WithDoc", xml);
    }

    [Fact]
    public void MembersAreSortedByDocId()
    {
        var source = @"package Lib

/// Z function.
func Zulu() {}

/// A function.
func Alpha() {}
";
        var xml = EmitDocXml(source, "Lib");
        var alphaPos = xml.IndexOf("M:Lib.Alpha");
        var zuluPos = xml.IndexOf("M:Lib.Zulu");
        Assert.True(alphaPos < zuluPos, "Members should be sorted by DocID");
    }

    private static string EmitDocXml(string source, string assemblyName)
    {
        var tree = SyntaxTree.Parse(source);
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        using var docStream = new MemoryStream();
        compilation.Emit(peStream, pdbStream: null, refStream: null, docStream, assemblyName);
        return Encoding.UTF8.GetString(docStream.ToArray());
    }
}
