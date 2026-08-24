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
data struct Point {
    /// The X coordinate.
    var X float64
    /// The Y coordinate.
    var Y float64
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
    public void EmitsDocumentedEnumsInterfacesAndNullableReferenceDocIds()
    {
        var source = """
            package FindingXmlDocOmissions

            /// Names a paint color.
            public enum Color {
              /// The red color.
              Red,
              Green
            }

            /// Greets a caller.
            public interface Greeter {
              /// Produces the greeting line.
              func Greet() string;

              /// Gets the greeter name.
              prop Name string { get; }

              /// Raised when a greeting is produced.
              event Greeted () -> void

              shared {
                /// Default greeting count.
                const DefaultCount int32 = 1
              }
            }

            /// Hosts documented members.
            public class Widget {
              private func Hidden() {}

              /// Runs the supplied callback.
              /// @param callback The callback to run.
              public func Configure(callback ((int32) -> void)?) {
                callback?(1)
              }
            }
            """;

        var xml = EmitDocXml(source, "FindingXmlDocOmissions");

        Assert.Contains("<member name=\"T:FindingXmlDocOmissions.Color\">", xml);
        Assert.Contains("<member name=\"F:FindingXmlDocOmissions.Color.Red\">", xml);
        Assert.DoesNotContain("F:FindingXmlDocOmissions.Color.Green", xml);
        Assert.Contains("<member name=\"T:FindingXmlDocOmissions.Greeter\">", xml);
        Assert.Contains("<member name=\"M:FindingXmlDocOmissions.Greeter.Greet\">", xml);
        Assert.Contains("<member name=\"P:FindingXmlDocOmissions.Greeter.Name\">", xml);
        Assert.Contains("<member name=\"E:FindingXmlDocOmissions.Greeter.Greeted\">", xml);
        Assert.Contains("<member name=\"F:FindingXmlDocOmissions.Greeter.DefaultCount\">", xml);
        Assert.Contains(
            "<member name=\"M:FindingXmlDocOmissions.Widget.Configure(System.Action{System.Int32})\">",
            xml);
        Assert.DoesNotContain("System.Nullable`1{System.Action", xml);
        Assert.DoesNotContain("M:FindingXmlDocOmissions.Widget.Hidden", xml);
    }

    [Fact]
    public void EmitsStandardIdsForNestedGenericAndNullableMemberShapes()
    {
        var source = """
            package DocShapes

            import System.Collections.Generic

            /// Handles a value.
            public delegate Handler[T](value T) void;

            /// Owns nested types.
            public class Outer[T] {
              /// Stores an inner value.
              public class Inner[U] {
                /// Stored value.
                public var Value U

                /// Creates an inner value.
                public init(value U) {
                  Value = value
                }

                /// Gets the value at an index.
                public prop this[index int32] U {
                  get { return Value }
                }

                /// Raised when the value changes.
                public event Changed (T) -> void

                /// Exercises standard parameter DocID shapes.
                public func Mix(
                  callback ((int32) -> void)?,
                  number int32?,
                  values List[string?]?,
                  handlers []Handler[U]?,
                  other Inner[U],
                  ref converter ((T) -> U)?) {
                }

                private func Hidden() {}
              }
            }

            /// Stores a constrained value.
            public struct ValueBox[T struct] {
              /// Accepts a nullable value.
              public func Take(value T?) {}
            }
            """;

        var xml = EmitDocXml(source, "DocShapes");

        Assert.Contains("<member name=\"T:DocShapes.Handler`1\">", xml);
        Assert.Contains("<member name=\"T:DocShapes.Outer`1\">", xml);
        Assert.Contains("<member name=\"T:DocShapes.Outer`1.Inner`1\">", xml);
        Assert.Contains("<member name=\"F:DocShapes.Outer`1.Inner`1.Value\">", xml);
        Assert.Contains("<member name=\"M:DocShapes.Outer`1.Inner`1.#ctor(`1)\">", xml);
        Assert.Contains("<member name=\"P:DocShapes.Outer`1.Inner`1.Item(System.Int32)\">", xml);
        Assert.Contains("<member name=\"E:DocShapes.Outer`1.Inner`1.Changed\">", xml);
        Assert.Contains(
            "<member name=\"M:DocShapes.Outer`1.Inner`1.Mix(System.Action{System.Int32},System.Nullable{System.Int32},System.Collections.Generic.List{System.String},DocShapes.Handler{`1}[],DocShapes.Outer{`0}.Inner{`1},System.Func{`0,`1}@)\">",
            xml);
        Assert.Contains("<member name=\"T:DocShapes.ValueBox`1\">", xml);
        Assert.Contains(
            "<member name=\"M:DocShapes.ValueBox`1.Take(System.Nullable{`0})\">",
            xml);
        Assert.DoesNotContain("M:DocShapes.Outer`1.Inner`1.Hidden", xml);
    }

    [Fact]
    public void EmitsDocumentedPrivateInterfaceMethods()
    {
        var source = """
            package PrivateInterfaceDocs

            interface Helpers {
              /// Formats an instance value.
              private func Format(value int32) int32 { return value }

              private func UndocumentedInstance() {}

              shared {
                /// Formats a static value.
                private func FormatStatic(value string) string { return value }

                private func UndocumentedStatic() {}
              }
            }
            """;

        var xml = EmitDocXml(source, "PrivateInterfaceDocs");

        Assert.Contains(
            "<member name=\"M:PrivateInterfaceDocs.Helpers.Format(System.Int32)\">",
            xml);
        Assert.Contains(
            "<member name=\"M:PrivateInterfaceDocs.Helpers.FormatStatic(System.String)\">",
            xml);
        Assert.DoesNotContain("M:PrivateInterfaceDocs.Helpers.UndocumentedInstance", xml);
        Assert.DoesNotContain("M:PrivateInterfaceDocs.Helpers.UndocumentedStatic", xml);
    }

    [Fact]
    public void EmitsStandardIdsForTupleMemberShapes()
    {
        var source = """
            package TupleDocs

            import System.Collections.Generic

            public class TupleHost[T] {
              /// Exercises tuple parameter and function-return shapes.
              public func Shapes(
                pair (int32, string),
                nullablePair (int32, string)?,
                nested (T, (string, bool)),
                nullableGeneric (T, string)?,
                generic List[(T, string?)],
                pairs [](T, string),
                fixedPairs [2](T, string),
                nullablePairs [](T, string)?,
                ref byRef (T, string),
                projector ((T, string)) -> (bool, T),
                wide (int8, uint8, int16, uint16, int32, uint32, int64, uint64)) {
              }
            }

            public struct TupleSource {
            }

            /// Converts a source value to a tuple.
            func operator implicit (value TupleSource) (int32, string) {
              return (0, "")
            }
            """;

        var xml = EmitDocXml(source, "TupleDocs");
        var expectedDocId =
            "M:TupleDocs.TupleHost`1.Shapes(" +
            "System.ValueTuple{System.Int32,System.String}," +
            "System.Nullable{System.ValueTuple{System.Int32,System.String}}," +
            "System.ValueTuple{`0,System.ValueTuple{System.String,System.Boolean}}," +
            "System.Nullable{System.ValueTuple{`0,System.String}}," +
            "System.Collections.Generic.List{System.ValueTuple{`0,System.String}}," +
            "System.ValueTuple{`0,System.String}[]," +
            "System.ValueTuple{`0,System.String}[]," +
            "System.Nullable{System.ValueTuple{`0,System.String}}[]," +
            "System.ValueTuple{`0,System.String}@," +
            "System.Func{System.ValueTuple{`0,System.String},System.ValueTuple{System.Boolean,`0}}," +
            "System.ValueTuple{System.SByte,System.Byte,System.Int16,System.UInt16," +
            "System.Int32,System.UInt32,System.Int64,System.ValueTuple{System.UInt64}})";

        Assert.Contains($"<member name=\"{expectedDocId}\">", xml);
        Assert.Contains(
            "<member name=\"M:TupleDocs.TupleSource.op_Implicit(TupleDocs.TupleSource)~System.ValueTuple{System.Int32,System.String}\">",
            xml);
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
        var result = compilation.Emit(peStream, pdbStream: null, refStream: null, docStream, assemblyName);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics));
        return Encoding.UTF8.GetString(docStream.ToArray());
    }
}
