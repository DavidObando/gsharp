// <copyright file="Adr0144PartialTypesBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit

/// <summary>
/// ADR-0144 / issue #2201: binder-layer tests for <c>partial</c> types. These
/// exercise the <c>PartialTypeMerger</c> pre-pass that merges multiple
/// <c>partial</c> parts of the same type into one synthetic declaration node
/// before the two-phase shell/body binder runs — covering successful merges
/// (single-file and cross-file), <c>shared { }</c>/init merging, and each new
/// consistency diagnostic (GS0475-GS0483).
/// </para>
/// <para>
/// Issue #3907 discrimination witness: the mutant is
/// <c>PartialTypeMerger.GroupByKey</c> keying on <c>(package, name)</c> without
/// arity, which merged a non-generic type with a same-named generic one and
/// then reported GS0475/GS0480 against the mismatch it had manufactured.
/// <c>NonGenericAndGenericPartsOfTheSameName_AreDistinctTypes</c> kills it;
/// <c>PartialParts_SameArityDifferentParameterNames_StillReportGS0480</c>
/// proves the check was narrowed rather than removed.
/// </summary>
open class Adr0144PartialTypesBinderTests {
    // ─────────────────────────────────────────────────────────────────────────
    // 1. Successful merges (emit + run)
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func TwoPartialClassParts_FieldAndMethod_MergeAndRun() {
        let source = `package App
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
`
        let output = CompileLoadInvokeCaptureStdout(source, "Adr0144-TwoParts")
        Assert.Contains("42", output)
    }

    @Fact
    func TwoPartialClassParts_EmitExactlyOneTypeDef_WithMembersFromBothParts() {
        // The merge must yield ONE TypeDef (not one per part), carrying the field
        // from the first part and the method from the second.
        let source = `package App
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
`
        using let peStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let result = Compilation(tree).Emit(peStream)
        Assert.True(result.Success, string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        peStream.Position = 0
        using let peReader = PEReader(peStream)
        let md = peReader.GetMetadataReader()
        let fooDefs = md
            .TypeDefinitions
            .Select(md.GetTypeDefinition)
            .Where((t TypeDefinition) -> md.GetString(t.Name) == "Foo")
            .ToList()
        Assert.Single(fooDefs)
        let foo = fooDefs[0]
        let fieldNames = foo
            .GetFields()
            .Select((h FieldDefinitionHandle) -> md.GetString(md.GetFieldDefinition(h).Name))
            .ToList()
        let methodNames = foo
            .GetMethods()
            .Select((h MethodDefinitionHandle) -> md.GetString(md.GetMethodDefinition(h).Name))
            .ToList()
        Assert.Contains("value", fieldNames)
        Assert.Contains("Sum", methodNames)
    }

    @Fact
    func CrossFile_PartsMergeAndMemberBodyUsesDeclaringFileImports() {
        // Part A declares a field; part B (a separate tree, with its OWN
        // `import System`) declares a method that references a System type.
        // Compiling both trees together must merge the parts while preserving
        // part B's syntax-tree provenance for its method body.
        let treeA = SyntaxTree.Parse(SourceText.From(`package App

partial class Calc {
    var seed int32 = 9
}
`, "A.gs"))
        let treeB = SyntaxTree.Parse(SourceText.From(`package App
import System

partial class Calc {
    func Abs() int32 {
        return Math.Abs(seed - 20)
    }
}

let c = Calc()
Console.WriteLine(c.Abs())
`, "B.gs"))
        let output = CompileLoadInvokeCaptureStdout([]SyntaxTree{treeA, treeB}, "Adr0144-CrossFile")
        Assert.Contains("11", output)
    }

    @Fact
    func CrossFile_FieldTypeUsesDeclaringPartImports_AndRuns() {
        let declaringPart = SyntaxTree.Parse(SourceText.From(`package FindingPartialImportBinding

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
}`, "Holder.gs"))
        let featurePart = SyntaxTree.Parse(SourceText.From(`package FindingPartialImportBinding

import System

public partial class Holder {
    public func Touch() {
    }
}

let holder = Holder()
holder.Fill()
Console.WriteLine(holder.Text())`, "Holder.Feature.gs"))
        let output = CompileLoadInvokeCaptureStdout(
            []SyntaxTree{declaringPart, featurePart},
            "Issue3336-PartialFieldImport"
        )
        Assert.Contains("ok", output)
    }

    @Fact
    func CrossFile_PrimaryPartImportDoesNotLeakToDeclaringPart() {
        let declaringPart = SyntaxTree.Parse(SourceText.From(`package FindingPartialImportBinding

public partial class Holder {
    var sb StringBuilder?
}`, "Holder.gs"))
        let featurePart = SyntaxTree.Parse(SourceText.From(`package FindingPartialImportBinding

import System.Text

public partial class Holder {
}`, "Holder.Feature.gs"))
        using let peStream = MemoryStream()
        let result = Compilation([]SyntaxTree{declaringPart, featurePart}).Emit(peStream)
        Assert.Contains(
            result.Diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Id == "GS0113" && diagnostic.Location.FileName == "Holder.gs"
        )
    }

    @Fact
    func CrossFile_GenericConstraintsUseImportingPartProvenance() {
        let declaringPart = SyntaxTree.Parse(SourceText.From(`package FindingPartialConstraintImport

import System.Collections.Generic

public partial class Holder[T IEnumerable[T]] {
}

public partial interface IHolder[T IEnumerable[T]] {
}

public partial class Outer {
    partial class Nested[T IEnumerable[T]] {
    }
}`, "Holder.gs"))
        let featurePart = SyntaxTree.Parse(SourceText.From(`package FindingPartialConstraintImport

public partial class Holder[T IEnumerable[T]] {
}

public partial interface IHolder[T IEnumerable[T]] {
}

public partial class Outer {
    partial class Nested[T IEnumerable[T]] {
    }
}`, "Holder.Feature.gs"))
        using let peStream = MemoryStream()
        let result = Compilation([]SyntaxTree{declaringPart, featurePart}){IsLibrary = true}.Emit(peStream)
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    func CrossFile_SameConstraintTextResolvingToDifferentTypesReportsGS0480(leftPartFirst bool) {
        let contract = SyntaxTree.Parse(SourceText.From(`package Contracts

public interface IConstraint[U any] {
}`, "Contract.gs"))
        let leftMarker = SyntaxTree.Parse(SourceText.From(`package Left

public class Marker[U any] {
}`, "Left.Marker.gs"))
        let rightMarker = SyntaxTree.Parse(SourceText.From(`package Right

public class Marker[U any] {
}`, "Right.Marker.gs"))
        let leftPart = SyntaxTree.Parse(SourceText.From(`package App

import Contracts
import Left

public partial class Holder[T IConstraint[Marker[T]] class init()] {
}`, "Holder.Left.gs"))
        let rightPart = SyntaxTree.Parse(SourceText.From(`package App

import Contracts
import Right

public partial class Holder[T IConstraint[Marker[T]] class init()] {
}`, "Holder.Right.gs"))
        let parts = if leftPartFirst {
            []SyntaxTree{leftPart, rightPart}
        } else {
            []SyntaxTree{rightPart, leftPart}
        }
        using let peStream = MemoryStream()
        let result = Compilation([]SyntaxTree{contract, leftMarker, rightMarker}.Concat(parts).ToArray()){
            IsLibrary = true
        }.Emit(peStream)
        let mismatch = Assert.Single(result.Diagnostics.Where((diagnostic Diagnostic) -> diagnostic.Id == "GS0480"))
        Assert.Equal("Holder.Right.gs", mismatch.Location.FileName)
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0496")
    }

    @Fact
    func CrossFile_AllPartialConstraintBindingsFailReportsEachDeclaringFile() {
        let firstPart = SyntaxTree.Parse(SourceText.From(`package App

public partial class Holder[T MissingConstraint] {
}`, "Holder.Feature.gs"))
        let secondPart = SyntaxTree.Parse(SourceText.From(`package App

public partial class Holder[T MissingConstraint] {
}`, "Holder.gs"))
        using let peStream = MemoryStream()
        let result = Compilation(firstPart, secondPart){IsLibrary = true}.Emit(peStream)
        let unresolved = result
            .Diagnostics
            .Where((diagnostic Diagnostic) -> diagnostic.Id == "GS0113")
            .OrderBy((diagnostic Diagnostic) -> diagnostic.Location.FileName!!, StringComparer.Ordinal)
            .ToArray()
        Assert.Equal(2, unresolved.Length)
        Assert.Equal(
            []string{"Holder.Feature.gs", "Holder.gs"},
            unresolved.Select((diagnostic Diagnostic) -> diagnostic.Location.FileName)
        )
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0480")
    }

    @Fact
    func CrossFile_PartialStructMatchingResolvedGenericConstraintsCompile() {
        let importingPart = SyntaxTree.Parse(SourceText.From(`package App

import System.Collections.Generic

public partial struct Holder[T IEnumerable[T] struct] {
}`, "Holder.gs"))
        let featurePart = SyntaxTree.Parse(SourceText.From(`package App

import System.Collections.Generic

public partial struct Holder[T IEnumerable[T] struct] {
}`, "Holder.Feature.gs"))
        using let peStream = MemoryStream()
        let result = Compilation(featurePart, importingPart){IsLibrary = true}.Emit(peStream)
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
    }

    @Fact
    func CrossFile_GenericConstraintImportDoesNotLeakFromUnrelatedFile() {
        let declaringPart = SyntaxTree.Parse(SourceText.From(`package FindingPartialConstraintImport

public partial class Holder[T IEnumerable[T]] {
}`, "Holder.gs"))
        let featurePart = SyntaxTree.Parse(SourceText.From(`package FindingPartialConstraintImport

public partial class Holder[T IEnumerable[T]] {
}`, "Holder.Feature.gs"))
        let unrelated = SyntaxTree.Parse(SourceText.From(`package FindingPartialConstraintImport

import System.Collections.Generic

public class Marker {
}`, "Unrelated.gs"))
        using let peStream = MemoryStream()
        let result = Compilation([]SyntaxTree{unrelated, declaringPart, featurePart}){IsLibrary = true}.Emit(peStream)
        Assert.Contains(
            result.Diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Id == "GS0113" && diagnostic.Location.FileName == "Holder.Feature.gs"
        )
    }

    @Fact
    func CrossFile_GenericConstraintMismatchStillReportsGS0480() {
        let anyConstraint = SyntaxTree.Parse(SourceText.From(`package FindingPartialConstraintImport

public partial class Holder[T any] {
}`, "Holder.Feature.gs"))
        let importedConstraint = SyntaxTree.Parse(SourceText.From(`package FindingPartialConstraintImport

import System.Collections.Generic

public partial class Holder[T IEnumerable[T]] {
}`, "Holder.gs"))
        using let peStream = MemoryStream()
        let result = Compilation([]SyntaxTree{importedConstraint, anyConstraint}){IsLibrary = true}.Emit(peStream)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0480")
    }

    @Fact
    func CrossFile_MergedMemberDeclarationsKeepDeclaringTreeProvenance() {
        let declaringPart = SyntaxTree.Parse(SourceText.From(`package FindingPartialImportBinding

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
}`, "Holder.gs"))
        let featurePart = SyntaxTree.Parse(SourceText.From(`package FindingPartialImportBinding

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
Console.WriteLine(Holder.Initialized)`, "Holder.Feature.gs"))
        let output = CompileLoadInvokeCaptureStdout(
            []SyntaxTree{featurePart, declaringPart},
            "Issue3336-PartialMemberProvenance"
        )
        Assert.Contains("ok", output)
        Assert.Contains("Open", output)
        Assert.Contains("nested", output)
        Assert.Contains("shared", output)
    }

    @Fact
    func CrossPackage_SecondaryPartialPropertyThroughAsCast_MergesAndRuns() {
        let generatedPart = SyntaxTree.Parse(SourceText.From(`package Models

partial class BookItemViewModel {
    prop IsSelected bool
}`, "A.Generated.gs"))
        let sourcePart = SyntaxTree.Parse(SourceText.From(`package Models

partial class BookItemViewModel(asin string) {
    prop Asin string -> asin
}`, "B.Source.gs"))
        let consumer = SyntaxTree.Parse(SourceText.From(`package Views
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
Console.WriteLine((selection as Selection)!!.Asin)`, "C.View.gs"))
        let output = CompileLoadInvokeCaptureStdout(
            []SyntaxTree{generatedPart, sourcePart, consumer},
            "Issue2641-PartialCastReceiver"
        )
        Assert.Contains("B001", output)
    }

    @Fact
    func TwoPartialStructParts_Merge() {
        let source = `package App
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
`
        let output = CompileLoadInvokeCaptureStdout(source, "Adr0144-StructMerge")
        Assert.Contains("7", output)
    }

    @Fact
    func TwoPartialInterfaceParts_UnionMustBeSatisfiedByImplementer() {
        let source = `package App
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
`
        let output = CompileLoadInvokeCaptureStdout(source, "Adr0144-IfaceMerge")
        Assert.Contains("45", output)
    }

    @Fact
    func MergedSharedBlocks_BothContributeStaticMembersAndInitBlocks() {
        // Each part contributes a `shared { }` block with a static field and an
        // init block. The merge must concatenate init blocks in part order
        // (ADR-0140), so BOTH run.
        let source = `package App
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
`
        let output = CompileLoadInvokeCaptureStdout(source, "Adr0144-SharedMerge")
        // A = 10 (part 1 init), B = A + 5 = 15 (part 2 init runs after) => 25.
        Assert.Contains("25", output)
    }

    @Fact
    func CrossFileSharedBlocks_MergeDeterministicallyAndResolveSiblingMethods() {
        let blocksPart = SyntaxTree.Parse(SourceText.From(`package App

partial class StatementBinder {
    shared {
        var Order string = ""

        init {
            Order = Order + "B"
        }

        func BindBlock() bool -> true
    }
}`, "StatementBinder.Blocks.gs"))
        let jumpsPart = SyntaxTree.Parse(SourceText.From(`package App

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
Console.WriteLine(StatementBinder.HasFunctionLocalRefScope())`, "StatementBinder.Jumps.gs"))
        // Reverse compiler input order. Partial merging still follows file-name
        // order, and each shared block contributes its own members.
        let output = CompileLoadInvokeCaptureStdout([]SyntaxTree{jumpsPart, blocksPart}, "Issue3410-CrossFileShared")
        Assert.Contains("BJ", output)
        Assert.Contains("True", output)
    }

    @Fact
    func LonePartialClass_CompilesFine() {
        let source = `package App
import System

partial class Solo {
    var n int32 = 3
    func Get() int32 {
        return n
    }
}

let x = Solo()
Console.WriteLine(x.Get())
`
        let output = CompileLoadInvokeCaptureStdout(source, "Adr0144-Lone")
        Assert.Contains("3", output)
    }

    @Fact
    func NestedPartialType_SplitAcrossOuterParts_Merges() {
        // The outer `Box` is split across two parts; each contributes a part of a
        // nested `partial class Slot`. The recursive nested merge must fold the two
        // Slot parts into one type (no GS0102), with members from both.
        let fileA = SyntaxTree.Parse(SourceText.From(`package App
import System

partial class Box {
    partial class Slot {
        func Read() string {
            return value.ToString()
        }
    }
}`, "A.gs"))
        let fileB = SyntaxTree.Parse(SourceText.From(`package App
import System
import System.Text

partial class Box {
    partial class Slot {
        var value StringBuilder = StringBuilder("nested")
    }
}

let s = Box.Slot()
Console.WriteLine(s.Read())`, "B.gs"))
        let output = CompileLoadInvokeCaptureStdout([]SyntaxTree{fileA, fileB}, "Adr0144-NestedSplit")
        Assert.Contains("nested", output)
    }

    @Fact
    func NestedPartialType_WithinSingleOuter_Merges() {
        // A non-split (lone) outer `Holder` contains two `partial class Item` parts
        // in the same file. NormalizeNestedTypes must merge them even though the
        // outer itself was never merged.
        let source = `package App
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
`
        let output = CompileLoadInvokeCaptureStdout(source, "Adr0144-NestedSingle")
        Assert.Contains("21", output)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Consistency diagnostics (GS0475-GS0483)
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func MixedPartialAndNonPartial_ReportsGS0475() {
        let source = `package App

partial class Foo {
    var a int32
}

class Foo {
    var b int32
}
`
        AssertHasDiagnostic(source, "GS0475")
    }

    @Fact
    func DifferentBaseClass_ReportsGS0481() {
        let source = `package App

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
`
        AssertHasDiagnostic(source, "GS0481")
    }

    @Fact
    func PrimaryConstructorOnTwoParts_ReportsGS0482() {
        let source = `package App

partial class Foo(a int32) {
    var x int32
}

partial class Foo(b int32) {
    var y int32
}
`
        AssertHasDiagnostic(source, "GS0482")
    }

    @Fact
    func DataOnOnePartOnly_ReportsGS0479() {
        let source = `package App

partial data struct Foo {
    var a int32
}

partial struct Foo {
    var b int32
}
`
        AssertHasDiagnostic(source, "GS0479")
    }

    @Fact
    func ConflictingAccessibility_ReportsGS0477() {
        let source = `package App

public partial class Foo {
    var a int32
}

private partial class Foo {
    var b int32
}
`
        AssertHasDiagnostic(source, "GS0477")
    }

    @Fact
    func TwoDeinits_ReportsGS0483() {
        let source = `package App

partial class Foo {
    deinit {
    }
}

partial class Foo {
    deinit {
    }
}
`
        AssertHasDiagnostic(source, "GS0483")
    }

    @Fact
    func DuplicateMemberAcrossParts_SurfacesGS0102() {
        // The merged node's Fields contains both `dup` fields, so the body
        // binder's duplicate detection catches the collision across parts.
        let source = `package App

partial class Foo {
    var dup int32
}

partial class Foo {
    var dup int32
}
`
        AssertHasDiagnostic(source, "GS0102")
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Issue #3907: a type is (name, arity), so `Chan` and `Chan[T]` are two
    // types rather than two parts of one.
    // ─────────────────────────────────────────────────────────────────────────
    @Theory
    @InlineData("partial class Box {")
    @InlineData("class Box {")
    func NonGenericAndGenericPartsOfTheSameName_AreDistinctTypes(nonGenericHeader string) {
        // ADR-0174 D12's shape: a generic `Chan[T]` split across parts beside a
        // non-generic `Chan` factory host. Both spellings of the non-generic
        // part are legal — it is a different type, so `partial` is its own
        // business.
        let source = `package App
import System

partial class Box[T] {
    var value T
}

partial class Box[T] {
    func Get() T {
        return value
    }
}

` + nonGenericHeader + `
    shared {
        func Make[T](v T) Box[T] {
            var b = Box[T]()
            b.value = v
            return b
        }
    }
}

let made = Box.Make[int32](42)
Console.WriteLine(made.Get())
`
        let output = CompileLoadInvokeCaptureStdout(
            source,
            "Issue3907-Arity-" + nonGenericHeader.GetHashCode().ToString("X")
        )
        Assert.Contains("42", output)
    }

    @Fact
    func NonGenericAndGenericInterfacesOfTheSameName_AreDistinctTypes() {
        // MergeInterfaces shares GroupByKey, so it shared the defect.
        let source = `package App
import System

partial interface IBox[T] {
    func Get() T;
}

partial interface IBox {
    func Describe() string;
}

class Holder : IBox[int32], IBox {
    func Get() int32 {
        return 7
    }

    func Describe() string {
        return "holder"
    }
}

let h = Holder()
Console.WriteLine(h.Get())
Console.WriteLine(h.Describe())
`
        let output = CompileLoadInvokeCaptureStdout(source, "Issue3907-ArityInterface")
        Assert.Contains("7", output)
        Assert.Contains("holder", output)
    }

    @Fact
    func PartialParts_SameArityDifferentParameterNames_StillReportGS0480() {
        // The narrowing must not have removed the check: same arity, different
        // type-parameter names, is still a genuine mismatch.
        let source = `package App

partial class Box[T] {
    var value T
}

partial class Box[U] {
    var other int32
}
`
        let diagnostics = Compile(source)
        Assert.Contains(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0480")
    }

    @Fact
    func PartialParts_DifferentArity_ReportNeitherGS0475NorGS0480() {
        let source = `package App

partial class Box[T] {
    var value T
}

class Box {
    var marker int32
}
`
        let diagnostics = Compile(source)
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0475")
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0480")
    }

    shared {
        // ─────────────────────────────────────────────────────────────────────────
        // Helpers
        // ─────────────────────────────────────────────────────────────────────────
        private func AssertHasDiagnostic(source string, expectedId string) {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == expectedId)
        }

        private func Compile(source string) IReadOnlyList[Diagnostic] {
            using let peStream = MemoryStream()
            return Compilation(SyntaxTree.Parse(SourceText.From(source, "Test.gs"))){IsLibrary = true}
                .Emit(peStream)
                .Diagnostics
                .ToArray()
        }

        private func CompileLoadInvokeCaptureStdout(source string, contextName string) string {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return CompileLoadInvokeCaptureStdout([]SyntaxTree{tree}, contextName)
        }

        private func CompileLoadInvokeCaptureStdout(trees[]SyntaxTree, contextName string) string {
            using let peStream = MemoryStream()
            let compilation = Compilation(trees)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
