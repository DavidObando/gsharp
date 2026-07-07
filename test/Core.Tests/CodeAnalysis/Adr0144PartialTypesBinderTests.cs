// <copyright file="Adr0144PartialTypesBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// ADR-0144 / issue #2201: binder-layer tests for <c>partial</c> types. These
/// exercise the <c>PartialTypeMerger</c> pre-pass that merges multiple
/// <c>partial</c> parts of the same type into one synthetic declaration node
/// before the two-phase shell/body binder runs — covering successful merges
/// (single-file and cross-file), <c>shared { }</c>/init merging, and each new
/// consistency diagnostic (GS0475-GS0483).
/// </summary>
public class Adr0144PartialTypesBinderTests
{
    // ─────────────────────────────────────────────────────────────────────────
    // 1. Successful merges (emit + run)
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void TwoPartialClassParts_FieldAndMethod_MergeAndRun()
    {
        var source = @"package App
import System

partial class Foo {
    var value int32 = 40
}

partial class Foo {
    func Sum() int32 {
        return value + 2
    }
}

let f = Foo()
Console.WriteLine(f.Sum())
";
        var output = CompileLoadInvokeCaptureStdout(source, "Adr0144-TwoParts");
        Assert.Contains("42", output);
    }

    [Fact]
    public void TwoPartialClassParts_EmitExactlyOneTypeDef_WithMembersFromBothParts()
    {
        // The merge must yield ONE TypeDef (not one per part), carrying the field
        // from the first part and the method from the second.
        var source = @"package App
import System

partial class Foo {
    var value int32 = 40
}

partial class Foo {
    func Sum() int32 {
        return value + 2
    }
}

Console.WriteLine(Foo().Sum())
";
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var result = new Compilation(tree).Emit(peStream);
        Assert.True(result.Success, string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        using var peReader = new PEReader(peStream);
        var md = peReader.GetMetadataReader();

        var fooDefs = md.TypeDefinitions
            .Select(md.GetTypeDefinition)
            .Where(t => md.GetString(t.Name) == "Foo")
            .ToList();
        Assert.Single(fooDefs);

        var foo = fooDefs[0];
        var fieldNames = foo.GetFields().Select(h => md.GetString(md.GetFieldDefinition(h).Name)).ToList();
        var methodNames = foo.GetMethods().Select(h => md.GetString(md.GetMethodDefinition(h).Name)).ToList();
        Assert.Contains("value", fieldNames);
        Assert.Contains("Sum", methodNames);
    }

    [Fact]
    public void CrossFile_PartsMergeAndGlobalImportsResolve()
    {
        // Part A declares a field; part B (a separate tree, with its OWN
        // `import System`) declares a method that references a System type.
        // Compiling both trees together must merge the parts AND let part B's
        // body resolve `System.Math` — proving imports are compilation-global.
        var treeA = SyntaxTree.Parse(SourceText.From(
            @"package App

partial class Calc {
    var seed int32 = 9
}
",
            "A.gs"));

        var treeB = SyntaxTree.Parse(SourceText.From(
            @"package App
import System

partial class Calc {
    func Abs() int32 {
        return Math.Abs(seed - 20)
    }
}

let c = Calc()
Console.WriteLine(c.Abs())
",
            "B.gs"));

        var output = CompileLoadInvokeCaptureStdout(new[] { treeA, treeB }, "Adr0144-CrossFile");
        Assert.Contains("11", output);
    }

    [Fact]
    public void TwoPartialStructParts_Merge()
    {
        var source = @"package App
import System

partial struct Point {
    var x int32
}

partial struct Point {
    var y int32
    func Sum() int32 {
        return x + y
    }
}

var p Point
p.x = 3
p.y = 4
Console.WriteLine(p.Sum())
";
        var output = CompileLoadInvokeCaptureStdout(source, "Adr0144-StructMerge");
        Assert.Contains("7", output);
    }

    [Fact]
    public void TwoPartialInterfaceParts_UnionMustBeSatisfiedByImplementer()
    {
        var source = @"package App
import System

partial interface IShape {
    func Area() int32;
}

partial interface IShape {
    func Perimeter() int32;
}

class Square : IShape {
    var side int32 = 5
    func Area() int32 {
        return side * side
    }
    func Perimeter() int32 {
        return side * 4
    }
}

let s = Square()
Console.WriteLine(s.Area() + s.Perimeter())
";
        var output = CompileLoadInvokeCaptureStdout(source, "Adr0144-IfaceMerge");
        Assert.Contains("45", output);
    }

    [Fact]
    public void MergedSharedBlocks_BothContributeStaticMembersAndInitBlocks()
    {
        // Each part contributes a `shared { }` block with a static field and an
        // init block. The merge must concatenate init blocks in part order
        // (ADR-0140), so BOTH run.
        var source = @"package App
import System

partial class Config {
    shared {
        var A int32 = 0
        init {
            A = 10
        }
    }
}

partial class Config {
    shared {
        var B int32 = 0
        init {
            B = A + 5
        }
    }
}

Console.WriteLine(Config.A + Config.B)
";
        var output = CompileLoadInvokeCaptureStdout(source, "Adr0144-SharedMerge");

        // A = 10 (part 1 init), B = A + 5 = 15 (part 2 init runs after) => 25.
        Assert.Contains("25", output);
    }

    [Fact]
    public void LonePartialClass_CompilesFine()
    {
        var source = @"package App
import System

partial class Solo {
    var n int32 = 3
    func Get() int32 {
        return n
    }
}

let x = Solo()
Console.WriteLine(x.Get())
";
        var output = CompileLoadInvokeCaptureStdout(source, "Adr0144-Lone");
        Assert.Contains("3", output);
    }

    [Fact]
    public void NestedPartialType_SplitAcrossOuterParts_Merges()
    {
        // The outer `Box` is split across two parts; each contributes a part of a
        // nested `partial class Slot`. The recursive nested merge must fold the two
        // Slot parts into one type (no GS0102), with members from both.
        var fileA = SyntaxTree.Parse(SourceText.From(@"package App
import System

partial class Box {
    partial class Slot {
        var value int32 = 7
    }
}", "A.gs"));
        var fileB = SyntaxTree.Parse(SourceText.From(@"package App
import System

partial class Box {
    partial class Slot {
        func Read() int32 {
            return value
        }
    }
}

let s = Box.Slot()
Console.WriteLine(s.Read())", "B.gs"));

        var output = CompileLoadInvokeCaptureStdout(new[] { fileA, fileB }, "Adr0144-NestedSplit");
        Assert.Contains("7", output);
    }

    [Fact]
    public void NestedPartialType_WithinSingleOuter_Merges()
    {
        // A non-split (lone) outer `Holder` contains two `partial class Item` parts
        // in the same file. NormalizeNestedTypes must merge them even though the
        // outer itself was never merged.
        var source = @"package App
import System

class Holder {
    partial class Item {
        var a int32 = 20
    }
    partial class Item {
        func Sum() int32 {
            return a + 1
        }
    }
}

let i = Holder.Item()
Console.WriteLine(i.Sum())
";
        var output = CompileLoadInvokeCaptureStdout(source, "Adr0144-NestedSingle");
        Assert.Contains("21", output);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Consistency diagnostics (GS0475-GS0483)
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void MixedPartialAndNonPartial_ReportsGS0475()
    {
        var source = @"package App

partial class Foo {
    var a int32
}

class Foo {
    var b int32
}
";
        AssertHasDiagnostic(source, "GS0475");
    }

    [Fact]
    public void DifferentBaseClass_ReportsGS0481()
    {
        var source = @"package App

open class BaseA {
}

open class BaseB {
}

partial class Foo : BaseA {
    var a int32
}

partial class Foo : BaseB {
    var b int32
}
";
        AssertHasDiagnostic(source, "GS0481");
    }

    [Fact]
    public void PrimaryConstructorOnTwoParts_ReportsGS0482()
    {
        var source = @"package App

partial class Foo(a int32) {
    var x int32
}

partial class Foo(b int32) {
    var y int32
}
";
        AssertHasDiagnostic(source, "GS0482");
    }

    [Fact]
    public void DataOnOnePartOnly_ReportsGS0479()
    {
        var source = @"package App

partial data struct Foo {
    var a int32
}

partial struct Foo {
    var b int32
}
";
        AssertHasDiagnostic(source, "GS0479");
    }

    [Fact]
    public void ConflictingAccessibility_ReportsGS0477()
    {
        var source = @"package App

public partial class Foo {
    var a int32
}

private partial class Foo {
    var b int32
}
";
        AssertHasDiagnostic(source, "GS0477");
    }

    [Fact]
    public void TwoDeinits_ReportsGS0483()
    {
        var source = @"package App

partial class Foo {
    deinit {
    }
}

partial class Foo {
    deinit {
    }
}
";
        AssertHasDiagnostic(source, "GS0483");
    }

    [Fact]
    public void DuplicateMemberAcrossParts_SurfacesGS0102()
    {
        // The merged node's Fields contains both `dup` fields, so the body
        // binder's duplicate detection catches the collision across parts.
        var source = @"package App

partial class Foo {
    var dup int32
}

partial class Foo {
    var dup int32
}
";
        AssertHasDiagnostic(source, "GS0102");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    private static void AssertHasDiagnostic(string source, string expectedId)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.Contains(
            result.Diagnostics,
            d => d.Id == expectedId);
    }

    private static string CompileLoadInvokeCaptureStdout(string source, string contextName)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return CompileLoadInvokeCaptureStdout(new[] { tree }, contextName);
    }

    private static string CompileLoadInvokeCaptureStdout(SyntaxTree[] trees, string contextName)
    {
        using var peStream = new MemoryStream();
        var compilation = new Compilation(trees);
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
