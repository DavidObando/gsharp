// <copyright file="PropertyInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0051 Phase 8: interpreter tests for property declarations on classes.
/// Validates that auto-properties can be read and written through the
/// tree-walking evaluator.
/// </summary>
public class PropertyInterpreterTests
{
    [Fact]
    public void AutoProperty_ReadWrite_OnClass()
    {
        var source = "type Foo class {\n  prop Name string\n}\nlet f = Foo{}\nf.Name = \"hello\"\nf.Name";
        var output = RunSubmission(source);
        Assert.Contains("hello", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void AutoProperty_DefaultValue_String()
    {
        // Uninitialized auto-property of type string should return empty string.
        var source = "type Foo class {\n  prop Name string\n}\nlet f = Foo{}\nf.Name";
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void AutoProperty_DefaultValue_Int32()
    {
        // Uninitialized auto-property of type int32 should return 0.
        var source = "type Foo class {\n  prop Count int32\n}\nlet f = Foo{}\nf.Count";
        var output = RunSubmission(source);
        Assert.Contains("0", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void AutoProperty_ReadWrite_Int32_OnClass()
    {
        var source = "type Counter class {\n  prop Value int32\n}\nlet c = Counter{}\nc.Value = 42\nc.Value";
        var output = RunSubmission(source);
        Assert.Contains("42", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void AutoProperty_MultipleProperties_OnClass()
    {
        var source = "type Person class {\n  prop Name string\n  prop Age int32\n}\nlet p = Person{}\np.Name = \"Alice\"\np.Age = 30\np.Name";
        var output = RunSubmission(source);
        Assert.Contains("Alice", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void AutoProperty_Reassignment_OnClass()
    {
        var source = "type Box class {\n  prop Item string\n}\nlet b = Box{}\nb.Item = \"first\"\nb.Item = \"second\"\nb.Item";
        var output = RunSubmission(source);
        Assert.Contains("second", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void AutoProperty_ReadOnly_OnClass_ReturnsDefault()
    {
        // A get-only auto-property returns the type default.
        var source = "type Foo class {\n  prop Count int32 { get }\n}\nlet f = Foo{}\nf.Count";
        var output = RunSubmission(source);
        Assert.Contains("0", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void OpenProperty_Parses_Without_Error()
    {
        var source = "type Base open class {\n  open prop Label string\n}\nlet b = Base{}\nb.Label = \"hi\"\nb.Label";
        var output = RunSubmission(source);
        Assert.Contains("hi", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void OverrideProperty_Parses_Without_Error()
    {
        var source = "type Base open class {\n  open prop Label string\n}\ntype Derived class : Base {\n  override prop Label string\n}\nlet d = Derived{}\nd.Label = \"derived\"\nd.Label";
        var output = RunSubmission(source);
        Assert.Contains("derived", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void InterfaceProperty_Parses_Without_Error()
    {
        var source = "type Named interface {\n  prop Name string { get }\n}\n";
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void AutoPropertyInDataStruct_ReportsGS0189()
    {
        var source = "type P data struct {\n  X int32\n  prop Y int32\n}\n";
        var output = RunSubmission(source);
        Assert.Contains("GS0189", output);
    }

    [Fact]
    public void ComputedProperty_Getter_ReturnsValue()
    {
        var source = """
            type Rect class {
                prop Width int32
                prop Height int32
                prop Area int32 {
                    get {
                        return this.Width * this.Height
                    }
                }
            }
            let r = Rect{}
            r.Width = 3
            r.Height = 4
            r.Area
            """;
        var output = RunSubmission(source);
        Assert.Contains("12", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void ComputedProperty_Setter_UpdatesBackingState()
    {
        var source = """
            type Counter class {
                prop raw int32
                prop Value int32 {
                    get {
                        return this.raw * 2
                    }
                    set(v) {
                        this.raw = v
                    }
                }
            }
            let c = Counter{}
            c.Value = 5
            c.Value
            """;
        var output = RunSubmission(source);
        Assert.Contains("10", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void ComputedProperty_GetOnly_NoSetter()
    {
        var source = """
            type Greeter class {
                prop Name string
                prop Greeting string {
                    get {
                        return "Hello, " + this.Name
                    }
                }
            }
            let g = Greeter{}
            g.Name = "World"
            g.Greeting
            """;
        var output = RunSubmission(source);
        Assert.Contains("Hello, World", output);
        Assert.DoesNotContain("error GS", output);
    }

    private static string RunSubmission(string text)
    {
        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(text);
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        return outWriter.ToString();
    }
}
