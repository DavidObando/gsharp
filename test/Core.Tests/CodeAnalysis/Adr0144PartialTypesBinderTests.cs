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
    public void CrossFile_PartsMergeAndMemberBodyUsesDeclaringFileImports()
    {
        // Part A declares a field; part B (a separate tree, with its OWN
        // `import System`) declares a method that references a System type.
        // Compiling both trees together must merge the parts while preserving
        // part B's syntax-tree provenance for its method body.
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
    public void CrossFile_FieldTypeUsesDeclaringPartImports_AndRuns()
    {
        var declaringPart = SyntaxTree.Parse(SourceText.From(
            """
            package FindingPartialImportBinding

            import System.Text

            public partial class Holder {
                var sb StringBuilder?

                public func Fill() {
                    let local = StringBuilder()
                    local.Append("ok")
                    sb = local
                }

                public func Text() string {
                    return sb?.ToString() ?? ""
                }
            }
            """,
            "Holder.gs"));
        var featurePart = SyntaxTree.Parse(SourceText.From(
            """
            package FindingPartialImportBinding

            import System

            public partial class Holder {
                public func Touch() {
                }
            }

            let holder = Holder()
            holder.Fill()
            Console.WriteLine(holder.Text())
            """,
            "Holder.Feature.gs"));

        var output = CompileLoadInvokeCaptureStdout(
            new[] { declaringPart, featurePart },
            "Issue3336-PartialFieldImport");

        Assert.Contains("ok", output);
    }

    [Fact]
    public void CrossFile_PrimaryPartImportDoesNotLeakToDeclaringPart()
    {
        var declaringPart = SyntaxTree.Parse(SourceText.From(
            """
            package FindingPartialImportBinding

            public partial class Holder {
                var sb StringBuilder?
            }
            """,
            "Holder.gs"));
        var featurePart = SyntaxTree.Parse(SourceText.From(
            """
            package FindingPartialImportBinding

            import System.Text

            public partial class Holder {
            }
            """,
            "Holder.Feature.gs"));

        using var peStream = new MemoryStream();
        var result = new Compilation(new[] { declaringPart, featurePart }).Emit(peStream);

        Assert.Contains(
            result.Diagnostics,
            diagnostic => diagnostic.Id == "GS0113"
                && diagnostic.Location.FileName == "Holder.gs");
    }

    [Fact]
    public void CrossFile_GenericConstraintsUseImportingPartProvenance()
    {
        var declaringPart = SyntaxTree.Parse(SourceText.From(
            """
            package FindingPartialConstraintImport

            import System.Collections.Generic

            public partial class Holder[T IEnumerable[T]] {
            }

            public partial interface IHolder[T IEnumerable[T]] {
            }

            public partial class Outer {
                partial class Nested[T IEnumerable[T]] {
                }
            }
            """,
            "Holder.gs"));
        var featurePart = SyntaxTree.Parse(SourceText.From(
            """
            package FindingPartialConstraintImport

            public partial class Holder[T IEnumerable[T]] {
            }

            public partial interface IHolder[T IEnumerable[T]] {
            }

            public partial class Outer {
                partial class Nested[T IEnumerable[T]] {
                }
            }
            """,
            "Holder.Feature.gs"));

        using var peStream = new MemoryStream();
        var result = new Compilation(new[] { declaringPart, featurePart })
        {
            IsLibrary = true,
        }.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void CrossFile_SameConstraintTextResolvingToDifferentTypesReportsGS0480(bool leftPartFirst)
    {
        var contract = SyntaxTree.Parse(SourceText.From(
            """
            package Contracts

            public interface IConstraint[U any] {
            }
            """,
            "Contract.gs"));
        var leftMarker = SyntaxTree.Parse(SourceText.From(
            """
            package Left

            public class Marker[U any] {
            }
            """,
            "Left.Marker.gs"));
        var rightMarker = SyntaxTree.Parse(SourceText.From(
            """
            package Right

            public class Marker[U any] {
            }
            """,
            "Right.Marker.gs"));
        var leftPart = SyntaxTree.Parse(SourceText.From(
            """
            package App

            import Contracts
            import Left

            public partial class Holder[T IConstraint[Marker[T]] class init()] {
            }
            """,
            "Holder.Left.gs"));
        var rightPart = SyntaxTree.Parse(SourceText.From(
            """
            package App

            import Contracts
            import Right

            public partial class Holder[T IConstraint[Marker[T]] class init()] {
            }
            """,
            "Holder.Right.gs"));
        var parts = leftPartFirst
            ? new[] { leftPart, rightPart }
            : new[] { rightPart, leftPart };

        using var peStream = new MemoryStream();
        var result = new Compilation(
            new[] { contract, leftMarker, rightMarker }.Concat(parts).ToArray())
        {
            IsLibrary = true,
        }.Emit(peStream);

        var mismatch = Assert.Single(result.Diagnostics.Where(diagnostic => diagnostic.Id == "GS0480"));
        Assert.Equal("Holder.Right.gs", mismatch.Location.FileName);
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS0496");
    }

    [Fact]
    public void CrossFile_AllPartialConstraintBindingsFailReportsEachDeclaringFile()
    {
        var firstPart = SyntaxTree.Parse(SourceText.From(
            """
            package App

            public partial class Holder[T MissingConstraint] {
            }
            """,
            "Holder.Feature.gs"));
        var secondPart = SyntaxTree.Parse(SourceText.From(
            """
            package App

            public partial class Holder[T MissingConstraint] {
            }
            """,
            "Holder.gs"));

        using var peStream = new MemoryStream();
        var result = new Compilation(firstPart, secondPart)
        {
            IsLibrary = true,
        }.Emit(peStream);

        var unresolved = result.Diagnostics
            .Where(diagnostic => diagnostic.Id == "GS0113")
            .OrderBy(diagnostic => diagnostic.Location.FileName, StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(2, unresolved.Length);
        Assert.Equal(
            new[] { "Holder.Feature.gs", "Holder.gs" },
            unresolved.Select(diagnostic => diagnostic.Location.FileName));
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS0480");
    }

    [Fact]
    public void CrossFile_PartialStructMatchingResolvedGenericConstraintsCompile()
    {
        var importingPart = SyntaxTree.Parse(SourceText.From(
            """
            package App

            import System.Collections.Generic

            public partial struct Holder[T IEnumerable[T] struct] {
            }
            """,
            "Holder.gs"));
        var featurePart = SyntaxTree.Parse(SourceText.From(
            """
            package App

            import System.Collections.Generic

            public partial struct Holder[T IEnumerable[T] struct] {
            }
            """,
            "Holder.Feature.gs"));

        using var peStream = new MemoryStream();
        var result = new Compilation(featurePart, importingPart)
        {
            IsLibrary = true,
        }.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));
    }

    [Fact]
    public void CrossFile_GenericConstraintImportDoesNotLeakFromUnrelatedFile()
    {
        var declaringPart = SyntaxTree.Parse(SourceText.From(
            """
            package FindingPartialConstraintImport

            public partial class Holder[T IEnumerable[T]] {
            }
            """,
            "Holder.gs"));
        var featurePart = SyntaxTree.Parse(SourceText.From(
            """
            package FindingPartialConstraintImport

            public partial class Holder[T IEnumerable[T]] {
            }
            """,
            "Holder.Feature.gs"));
        var unrelated = SyntaxTree.Parse(SourceText.From(
            """
            package FindingPartialConstraintImport

            import System.Collections.Generic

            public class Marker {
            }
            """,
            "Unrelated.gs"));

        using var peStream = new MemoryStream();
        var result = new Compilation(new[] { unrelated, declaringPart, featurePart })
        {
            IsLibrary = true,
        }.Emit(peStream);

        Assert.Contains(
            result.Diagnostics,
            diagnostic => diagnostic.Id == "GS0113"
                && diagnostic.Location.FileName == "Holder.Feature.gs");
    }

    [Fact]
    public void CrossFile_GenericConstraintMismatchStillReportsGS0480()
    {
        var anyConstraint = SyntaxTree.Parse(SourceText.From(
            """
            package FindingPartialConstraintImport

            public partial class Holder[T any] {
            }
            """,
            "Holder.Feature.gs"));
        var importedConstraint = SyntaxTree.Parse(SourceText.From(
            """
            package FindingPartialConstraintImport

            import System.Collections.Generic

            public partial class Holder[T IEnumerable[T]] {
            }
            """,
            "Holder.gs"));

        using var peStream = new MemoryStream();
        var result = new Compilation(new[] { importedConstraint, anyConstraint })
        {
            IsLibrary = true,
        }.Emit(peStream);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0480");
    }

    [Fact]
    public void CrossFile_MergedMemberDeclarationsKeepDeclaringTreeProvenance()
    {
        var declaringPart = SyntaxTree.Parse(SourceText.From(
            """
            package FindingPartialImportBinding

            import System.ComponentModel
            import System.IO
            import System.Text

            public partial interface IBuilderSource {
                func Build() StringBuilder;
            }

            @Description("holder")
            public partial class Holder : MemoryStream, IBuilderSource {
                var builder StringBuilder = StringBuilder()

                public prop Value StringBuilder -> builder

                shared {
                    var Initialized string = ""

                    init {
                        let local = StringBuilder()
                        local.Append("shared")
                        Initialized = local.ToString()
                    }
                }

                public class Token {
                    var text StringBuilder = StringBuilder()

                    public func Text() string {
                        text.Append("nested")
                        return text.ToString()
                    }
                }

                private func Echo(value StringBuilder) StringBuilder {
                    return value
                }

                private func Mode(value FileMode = FileMode.Open) FileMode {
                    return value
                }

                public func Build() StringBuilder {
                    builder.Append("ok")
                    return Echo(Value)
                }

                public func ModeText() string {
                    return Mode().ToString()
                }
            }
            """,
            "Holder.gs"));
        var featurePart = SyntaxTree.Parse(SourceText.From(
            """
            package FindingPartialImportBinding

            import System

            public partial interface IBuilderSource {
            }

            public partial class Holder {
                public func Touch() {
                }
            }

            let holder = Holder()
            Console.WriteLine(holder.Build().ToString())
            Console.WriteLine(holder.ModeText())
            Console.WriteLine(Holder.Token().Text())
            Console.WriteLine(Holder.Initialized)
            """,
            "Holder.Feature.gs"));

        var output = CompileLoadInvokeCaptureStdout(
            new[] { featurePart, declaringPart },
            "Issue3336-PartialMemberProvenance");

        Assert.Contains("ok", output);
        Assert.Contains("Open", output);
        Assert.Contains("nested", output);
        Assert.Contains("shared", output);
    }

    [Fact]
    public void CrossPackage_SecondaryPartialPropertyThroughAsCast_MergesAndRuns()
    {
        var generatedPart = SyntaxTree.Parse(SourceText.From(
            """
            package Models

            partial class BookItemViewModel {
                prop IsSelected bool
            }
            """,
            "A.Generated.gs"));
        var sourcePart = SyntaxTree.Parse(SourceText.From(
            """
            package Models

            partial class BookItemViewModel(asin string) {
                prop Asin string -> asin
            }
            """,
            "B.Source.gs"));
        var consumer = SyntaxTree.Parse(SourceText.From(
            """
            package Views
            import Models
            import System

            class Selection {
                prop Asin string
                prop Item BookItemViewModel
            }

            let item object = BookItemViewModel("B001")
            let selection object = Selection()
            (selection as Selection)!!.Asin = (item as BookItemViewModel)!!.Asin
            (selection as Selection)!!.Item = (item as BookItemViewModel)!!
            Console.WriteLine((selection as Selection)!!.Asin)
            """,
            "C.View.gs"));

        var output = CompileLoadInvokeCaptureStdout(
            new[] { generatedPart, sourcePart, consumer },
            "Issue2641-PartialCastReceiver");
        Assert.Contains("B001", output);
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
    public void CrossFileSharedBlocks_MergeDeterministicallyAndResolveSiblingMethods()
    {
        var blocksPart = SyntaxTree.Parse(SourceText.From(
            """
            package App

            partial class StatementBinder {
                shared {
                    var Order string = ""

                    init {
                        Order = Order + "B"
                    }

                    func BindBlock() bool -> true
                }
            }
            """,
            "StatementBinder.Blocks.gs"));
        var jumpsPart = SyntaxTree.Parse(SourceText.From(
            """
            package App

            import System

            partial class StatementBinder {
                shared {
                    init {
                        Order = Order + "J"
                    }

                    func HasFunctionLocalRefScope() bool -> BindBlock()
                }
            }

            Console.WriteLine(StatementBinder.Order)
            Console.WriteLine(StatementBinder.HasFunctionLocalRefScope())
            """,
            "StatementBinder.Jumps.gs"));

        // Reverse compiler input order. Partial merging still follows file-name
        // order, and each shared block contributes its own members.
        var output = CompileLoadInvokeCaptureStdout(
            new[] { jumpsPart, blocksPart },
            "Issue3410-CrossFileShared");

        Assert.Contains("BJ", output);
        Assert.Contains("True", output);
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
        func Read() string {
            return value.ToString()
        }
    }
}", "A.gs"));
        var fileB = SyntaxTree.Parse(SourceText.From(@"package App
import System
import System.Text

partial class Box {
    partial class Slot {
        var value StringBuilder = StringBuilder(""nested"")
    }
}

let s = Box.Slot()
Console.WriteLine(s.Read())", "B.gs"));

        var output = CompileLoadInvokeCaptureStdout(new[] { fileA, fileB }, "Adr0144-NestedSplit");
        Assert.Contains("nested", output);
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
