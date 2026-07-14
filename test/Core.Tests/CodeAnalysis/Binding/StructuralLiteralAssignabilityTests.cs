// <copyright file="StructuralLiteralAssignabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0147: implicit structural assignment from an object literal to a
/// concrete target (class / struct / data struct) whose required members are
/// all present in the literal with compatible types. Extra literal members are
/// allowed (width subtyping); a missing required member is reported as GS0490.
/// </summary>
public class StructuralLiteralAssignabilityTests
{
    [Fact]
    public void LiteralToDataStruct_RequiredFieldsPresent_Binds()
    {
        var source = @"
import System

data struct Pet {
    var Name string
    var Age int32
}

func describe(p Pet) string { return p.Name + ""/"" + p.Age.ToString() }
describe(object { let Name = ""Fido""; let Age = 4 })
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Fido/4", result.Value);
    }

    [Fact]
    public void LiteralToDataStruct_ExtraMembersAllowed_WidthSubtyping()
    {
        // The literal carries an extra `Tag` field that the target does not
        // need; ADR-0147 width subtyping tolerates it.
        var source = @"
import System

data struct Pet {
    var Name string
    var Age int32
}

func describe(p Pet) string { return p.Name }
describe(object { let Name = ""Fido""; let Age = 4; let Tag = 99 })
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Fido", result.Value);
    }

    [Fact]
    public void LiteralToDataStruct_MissingRequiredField_IsRejected()
    {
        // With member validation at classify time, missing required members
        // cause Conversion.None — the error is a type mismatch, not GS0490.
        var diagnostics = GetDiagnostics(@"
import System

data struct Pet {
    var Name string
    var Age int32
}

func describe(p Pet) string { return p.Name }
describe(object { let Name = ""Fido"" })
");
        Assert.NotEmpty(diagnostics);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0490");
    }

    [Fact]
    public void LiteralToDataStruct_TypeWidening_Binds()
    {
        // ADR-0147: the literal's `Age` is int32 and the target field is
        // int64 — implicit numeric widening applies.
        var source = @"
import System

data struct Pet {
    var Name string
    var Age int64
}

func describe(p Pet) string { return p.Age.ToString() }
describe(object { let Name = ""Fido""; let Age = 4 })
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("4", result.Value);
    }

    [Fact]
    public void LiteralToDataStruct_ViaLocalBinding_Binds()
    {
        var source = @"
import System

data struct Pet {
    var Name string
    var Age int32
}

let p Pet = object { let Name = ""Fido""; let Age = 4 }
p.Name
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Fido", result.Value);
    }

    [Fact]
    public void LiteralToDataStruct_InterfaceTarget_NotStructural()
    {
        // Structural literal-to-type assignability only applies to concrete
        // value-type targets, not interfaces (that is ADR-0146 object : Iface).
        var diagnostics = GetDiagnostics(@"
import System

interface Animal { func speak() string; }

data struct Pet {
    var Name string
}

func take(a Animal) string { return a.speak() }
take(object { let Name = ""Fido"" })
");
        Assert.NotEmpty(diagnostics);
    }

    [Fact]
    public void SampleProgram_Animals_Runs()
    {
        var output = CompileAndRun(@"
import System

interface Animal {
    func speak() string;
}

class Dog : Animal {
    func speak() string { return ""woof"" }
}

data struct Pet {
    var Name string
    var Age int32
}

func announce(a Animal) {
    Console.WriteLine(a.speak())
}

func describe(p Pet) {
    Console.WriteLine(""${p.Name} is ${p.Age}"")
}

var cat Animal = object : Animal {
    func speak() string { return ""meow"" }
}

announce(Dog{})
announce(cat)
describe(object { let Name = ""Fido""; let Age = 4 })
");
        Assert.Equal(
            "woof" + Environment.NewLine +
            "meow" + Environment.NewLine +
            "Fido is 4" + Environment.NewLine,
            output);
    }

    [Fact]
    public void EmptyLiteral_ToZeroMemberTarget_Binds()
    {
        var source = @"
struct Empty { }

var x Empty = object {}
""ok""
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("ok", result.Value);
    }

    [Fact]
    public void EmptyLiteral_ToZeroMemberTarget_EmitsAndRuns()
    {
        // ADR-0146: `object {}` creates a zero-member anonymous type that is
        // a structural subtype of any zero-member target. This test exercises
        // the emit path (not just the interpreter) to verify that the primary
        // constructor and entry point are emitted correctly.
        var output = CompileAndRun(@"
struct Empty { }

var x Empty = object {}
Console.WriteLine(""ok"")
");
        Assert.Contains("ok", output);
    }

    [Fact]
    public void LiteralToClass_RequiredFieldsPresent_Binds()
    {
        var source = @"
class Dog {
    var Name string
    var WoofCount int32
}

func announce(d Dog) string { return d.Name }
announce(object { let Name = ""Fido""; let WoofCount = 3 })
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Fido", result.Value);
    }

    [Fact]
    public void LiteralToClass_MissingRequiredField_IsRejected()
    {
        // With member validation at classify time, missing required members
        // cause Conversion.None — the error is a type mismatch, not GS0490.
        var diagnostics = GetDiagnostics(@"
class Dog {
    var Name string
    var WoofCount int32
}

func announce(d Dog) string { return d.Name }
announce(object { let Name = ""Fido"" })
");
        Assert.NotEmpty(diagnostics);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0490");
    }

    [Fact]
    public void LiteralToStruct_MissingSettableProperty_IsRejected()
    {
        // With member validation at classify time, missing settable properties
        // cause Conversion.None — the error is a type mismatch, not GS0490.
        var diagnostics = GetDiagnostics(@"
data struct Pet {
    var Name string
    prop Tag string { get; set }
}

func describe(p Pet) string { return p.Name }
describe(object { let Name = ""Fido"" })
");
        Assert.NotEmpty(diagnostics);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0490");
    }

    [Fact]
    public void LiteralToStruct_MemberTypeIncompatible_IsRejected()
    {
        // With member validation at classify time, incompatible member types
        // cause Conversion.None — the error is a type mismatch, not GS0490.
        var diagnostics = GetDiagnostics(@"
data struct Pet {
    var Name string
    var Age int32
}

func describe(p Pet) string { return p.Name }
describe(object { let Name = ""Fido""; let Age = true })
");
        Assert.NotEmpty(diagnostics);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0490");
    }

    [Fact]
    public void LiteralToClass_WidthSubtyping_Allowed()
    {
        var source = @"
class Dog {
    var Name string
    var WoofCount int32
}

func announce(d Dog) string { return d.Name }
announce(object { let Name = ""Fido""; let WoofCount = 3; let Tag = 99 })
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Fido", result.Value);
    }

    [Fact]
    public void LiteralToDataStruct_ViaVariable_Binds()
    {
        var source = @"
import System

data struct Pet {
    var Name string
    var Age int32
}

func describe(p Pet) string { return p.Name + ""/"" + p.Age.ToString() }
let lit = object { let Name = ""Fido""; let Age = 4 }
describe(lit)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Fido/4", result.Value);
    }

    [Fact]
    public void LiteralToDataStruct_ViaLocalAssignment_Binds()
    {
        var source = @"
data struct Pet {
    var Name string
    var Age int32
}

let lit = object { let Name = ""Fido""; let Age = 4 }
let p Pet = lit
p.Name
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Fido", result.Value);
    }

    [Fact]
    public void LiteralToClass_ViaVariable_Binds()
    {
        var source = @"
class Dog {
    var Name string
    var WoofCount int32
}

func announce(d Dog) string { return d.Name }
let lit = object { let Name = ""Fido""; let WoofCount = 3 }
announce(lit)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Fido", result.Value);
    }

    private static System.Collections.Immutable.ImmutableArray<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        return result.Diagnostics;
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static string CompileAndRun(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        peStream.Position = 0;

        var context = new AssemblyLoadContext("struct-literal-run", isCollectible: true);
        try
        {
            var assembly = context.LoadFromStream(peStream);
            var programType = assembly.GetTypes().First(t => t.Name == "<Program>");
            var entry = programType.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);

            var savedOut = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry.Invoke(
                    null,
                    entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(savedOut);
            }

            return captured.ToString();
        }
        finally
        {
            context.Unload();
        }
    }
}
