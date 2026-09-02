// <copyright file="Issue2888InterfacePropertyTypeMismatchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2888: ordinary properties must match their G# interface property's
/// type after generic substitution and nullability variance.
/// </summary>
public class Issue2888InterfacePropertyTypeMismatchTests
{
    [Fact]
    public void OrdinaryTypeMismatches_ReportGS0504AndDoNotEmit()
    {
        const string source = """
            package Rejected

            interface IClassGet { prop Value int32 { get; } }
            class ClassGet : IClassGet { prop Value string { get; } }

            interface IStructGet { prop Value int32 { get; } }
            struct StructGet : IStructGet { prop Value string { get; } }

            interface IClassGetSet { prop Value int32 { get; set; } }
            class ClassGetSet : IClassGetSet { prop Value string { get; set; } }

            interface IStructGetSet { prop Value int32 { get; set; } }
            struct StructGetSet : IStructGetSet { prop Value string { get; set; } }

            interface INonNullableGet { prop Value string { get; } }
            class NullableGet : INonNullableGet { prop Value string? -> nil }

            interface INullableSet { prop Value string? { get; set; } }
            class NonNullableSet : INullableSet { prop Value string { get; set; } }

            interface INonNullableSet { prop Value string { get; set; } }
            class NullableSet : INonNullableSet { prop Value string? { get; set; } }

            interface IValueNullableGet { prop Value int32? { get; } }
            class ValueNullableGet : IValueNullableGet { prop Value int32 -> 1 }

            class Cell[T] { }
            interface IConstructed { prop Value Cell[int32] { get; } }
            class ConstructedMismatch : IConstructed {
                prop Value Cell[string] -> Cell[string]()
            }

            interface IBase { prop Value int32 { get; } }
            interface IDerived : IBase { }
            class BaseInterfaceMismatch : IDerived { prop Value string -> "x" }

            open class PropertyBase { prop Value string -> "x" }
            interface IInheritedProperty { prop Value int32 { get; } }
            class InheritedPropertyMismatch : PropertyBase, IInheritedProperty { }

            interface IInit { prop Value int32 { get; init; } }
            class InitMismatch : IInit { prop Value string { get; init; } }
            """;

        var output = CompileExpectingFailure(source);

        Assert.Equal(12, CountOccurrences(output, "error GS0504:"));
        Assert.DoesNotContain("GS0187", output, StringComparison.Ordinal);
        Assert.DoesNotContain("GS0502", output, StringComparison.Ordinal);
        foreach (var typeName in new[]
        {
            "ClassGet",
            "StructGet",
            "ClassGetSet",
            "StructGetSet",
            "NullableGet",
            "NonNullableSet",
            "NullableSet",
            "ValueNullableGet",
            "ConstructedMismatch",
            "BaseInterfaceMismatch",
            "InheritedPropertyMismatch",
            "InitMismatch",
        })
        {
            Assert.Contains($"Type '{typeName}' cannot use property 'Value'", output, StringComparison.Ordinal);
        }

        Assert.Contains(
            "Type 'ClassGet' cannot use property 'Value' to implement interface property 'IClassGet.Value': expected type 'int32', actual type 'string'.",
            output,
            StringComparison.Ordinal);
        Assert.Contains(
            "Type 'ValueNullableGet' cannot use property 'Value' to implement interface property 'IValueNullableGet.Value': expected type 'int32?', actual type 'int32'.",
            output,
            StringComparison.Ordinal);
    }

    [Fact]
    public void PlainInterfaceIndexerParameterMismatch_ReportsGS0187()
    {
        const string source = """
            package ParameterMismatch

            interface ILookup {
                prop this[key string] int32 { get; }
            }
            class Lookup : ILookup {
                prop this[key int32] int32 -> key
            }
            """;

        var output = CompileExpectingFailure(source);

        Assert.Equal(1, CountOccurrences(output, "error GS0187:"));
        Assert.Contains(
            "Class 'Lookup' does not implement interface method 'ILookup.Item'.",
            output,
            StringComparison.Ordinal);
        Assert.DoesNotContain("GS0504", output, StringComparison.Ordinal);
    }

    [Fact]
    public void NullableIndexerRejected_ReportsGS0504()
    {
        const string source = """
            package NullableIndexerRejected

            interface I[T] { prop this[key string] T? { get; } }
            class C : I[int32] {
                prop this[key string] int32? { get { return nil } }
            }
            """;

        var output = CompileExpectingFailure(source);

        Assert.Equal(1, CountOccurrences(output, "error GS0504:"));
        Assert.Contains(
            "Type 'C' cannot use property 'Item' to implement interface property 'I[int32].Item': expected type 'int32', actual type 'int32?'.",
            output,
            StringComparison.Ordinal);
        Assert.DoesNotContain("GS0187", output, StringComparison.Ordinal);
    }

    [Fact]
    public void CompatibleBaselineSiblingShapes_EmitVerifyAndLoad()
    {
        const string source = """
            package Accepted

            interface IClassGet { prop Value int32 { get; } }
            class ClassGet : IClassGet { prop Value int32 { get; } }

            interface IStructGetSet { prop Value int32 { get; set; } }
            struct StructGetSet : IStructGetSet { prop Value int32 { get; set; } }

            interface INullableClassGet { prop Value string? { get; } }
            class NonNullableClassGet : INullableClassGet { prop Value string -> "x" }

            interface INullableSet { prop Value string? { get; set; } }
            class NullableSet : INullableSet { prop Value string? { get; set; } }

            interface IGeneric[T] { prop Value T { get; } }
            class GenericExact : IGeneric[int32] { prop Value int32 -> 1 }

            class Cell[T] { }
            interface IConstructed { prop Value Cell[int32] { get; } }
            class ConstructedExact : IConstructed {
                prop Value Cell[int32] -> Cell[int32]()
            }

            interface IBase { prop Value int32 { get; } }
            interface IDerived : IBase { }
            class BaseInterfaceExact : IDerived { prop Value int32 -> 1 }

            open class PropertyBase { prop Value int32 -> 1 }
            interface IInheritedProperty { prop Value int32 { get; } }
            class InheritedPropertyExact : PropertyBase, IInheritedProperty { }

            interface IHiddenBase { prop Value int32 { get; } }
            open class HiddenBase { open prop Value int32 -> 1 }
            class DerivedHidesMatchingBase : HiddenBase, IHiddenBase {
                prop Value string -> "x"
            }

            interface IGenericHiddenBase[T] { prop Value T { get; } }
            open class GenericHiddenBase { open prop Value int32 -> 1 }
            class GenericDerivedHidesMatchingBase
                : GenericHiddenBase, IGenericHiddenBase[int32] {
                prop Value string -> "x"
            }

            interface IInit { prop Value int32 { get; init; } }
            class InitExact : IInit { prop Value int32 { get; init; } }

            interface IExplicit { prop Value int32 { get; } }
            class ExplicitExact : IExplicit {
                private prop (IExplicit) Value int32 -> 1
            }

            interface IExplicitIndexer { prop this[key string] int32 { get; } }
            class ExplicitIndexerExact : IExplicitIndexer {
                private prop (IExplicitIndexer) this[key string] int32 {
                    get { return 1 }
                }
            }

            sealed interface IStatic[T] {
                shared { prop Value T { get; } }
            }
            struct StaticExact : IStatic[int32] {
                shared { prop Value int32 -> 1 }
            }

            interface IPositionalClass { prop Value int32 { get; } }
            data class PositionalClass(Value int32) : IPositionalClass

            interface IPositionalStruct { prop Value int32 { get; } }
            data struct PositionalStruct(Value int32) : IPositionalStruct

            interface IDefault {
                prop Value int32 { get { return 1 } }
            }
            class DefaultWithUnrelatedProperty : IDefault {
                prop Value string -> "x"
            }
            """;

        AssertEmitsAndLoads(source);
    }

    [Fact]
    public void NullableGenericRelaxations_EmitVerifyAndLoad()
    {
        const string source = """
            package GenericAccepted

            interface IGenericNullable[T] { prop Value T? { get; } }
            class ReferenceCovariant : IGenericNullable[string] {
                prop Value string -> "x"
            }

            class ConstructedValueCovariant : IGenericNullable[int32] {
                prop Value int32 -> 1
            }

            interface IOpenNullable[T] { prop Value T? { get; } }
            class OpenGenericCovariant[T] : IOpenNullable[T] {
                prop Value T { get; }
            }

            interface IExact[T] { prop Value T { get; } }
            class NullableValueArgument : IExact[int32?] {
                prop Value int32? -> nil
            }
            class NullableReferenceArgument : IExact[string?] {
                prop Value string? -> nil
            }
            class ExplicitNullableArgument : IExact[int32?] {
                private prop (IExact[int32?]) Value int32? -> nil
            }

            interface INestedNullable[T] { prop Value T? { get; } }
            class NestedNullableArgument : INestedNullable[int32?] {
                prop Value int32? -> nil
            }

            interface ISetExact[T] { prop Value T { get; set; } }
            class NullableSetArgument : ISetExact[int32?] {
                prop Value int32? { get; set; }
            }

            interface IPositionalExact[T] { prop Value T { get; } }
            data class NullablePositional(Value int32?) : IPositionalExact[int32?]
            """;

        AssertEmitsAndLoads(source);
    }

    [Fact]
    public void NullableGenericPropertySurface_EmitsLoadsOrRejectsWithoutOutput()
    {
        const string accepted = """
            package NullableSurfaceAccepted

            interface IGet[T] { prop Value T? { get; } }
            class ImplicitGet : IGet[int32] { prop Value int32 -> 1 }
            class ExplicitGet : IGet[int32] {
                private prop (IGet[int32]) Value int32 -> 1
            }
            data class PositionalGet(Value int32) : IGet[int32]

            interface ISet[T] { prop Value T? { get; set; } }
            class OpenSet[T] : ISet[T] { prop Value T? { get; set; } }

            interface IIndexer[T] { prop this[key string] T? { get; } }
            class IndexerGet : IIndexer[int32] {
                prop this[key string] int32 { get { return 1 } }
            }

            interface ISlice[T] { prop Value []T? { get; } }
            class SliceGet : ISlice[int32] { prop Value []int32 { get; } }

            interface IArray[T] { prop Value [3]T? { get; } }
            class ArrayGet : IArray[int32] { prop Value [3]int32 { get; } }

            class Cell[T] { }
            interface INested[T] { prop Value Cell[T?] { get; } }
            class NestedGet : INested[int32] {
                prop Value Cell[int32] { get; }
            }

            interface IExactNullableArgument[T] { prop Value T { get; } }
            class ExactNullableArgument : IExactNullableArgument[string?] {
                prop Value string? -> nil
            }

            sealed interface IStatic[T] {
                shared { prop Value T? { get; } }
            }
            struct OpenStatic[T] : IStatic[T] {
                shared { prop Value T? -> nil }
            }
            """;

        AssertEmitsAndLoads(accepted);
        foreach (var rejected in new[]
        {
            """
            package NullableImplicitGetRejected
            interface I[T] { prop Value T? { get; } }
            class C : I[int32] { prop Value int32? -> nil }
            """,
            """
            package NullableExplicitGetRejected
            interface I[T] { prop Value T? { get; } }
            class C : I[int32] {
                private prop (I[int32]) Value int32? -> nil
            }
            """,
            """
            package NullablePositionalGetRejected
            interface I[T] { prop Value T? { get; } }
            data class C(Value int32?) : I[int32]
            """,
            """
            package NullableImplicitSetRejected
            interface I[T] { prop Value T? { get; set; } }
            class C : I[int32] { prop Value int32? { get; set; } }
            """,
            """
            package NullableSliceRejected
            interface I[T] { prop Value []T? { get; } }
            class C : I[int32] { prop Value []int32? { get; } }
            """,
            """
            package NullableArrayRejected
            interface I[T] { prop Value [3]T? { get; } }
            class C : I[int32] { prop Value [3]int32? { get; } }
            """,
            """
            package NullableNestedRejected
            class Cell[T] { }
            interface I[T] { prop Value Cell[T?] { get; } }
            class C : I[int32] { prop Value Cell[int32?] { get; } }
            """,
            """
            package NullableStaticRejected
            sealed interface I[T] {
                shared { prop Value T? { get; } }
            }
            struct C : I[int32] {
                shared { prop Value int32? -> nil }
            }
            """,
            """
            package NullableExplicitStaticRejected
            sealed interface I[T] {
                shared { prop Value T? { get; } }
            }
            struct C : I[int32] {
                shared {
                    private prop (I[int32]) Value int32? -> nil
                }
            }
            """,
        })
        {
            _ = CompileExpectingFailure(rejected);
        }
    }

    [Fact]
    public void ImplicitStaticVirtualNullableErasure_EmitsAndLoads()
    {
        const string source = """
            package StaticImplicitCovarianceRejected
            sealed interface I[T] {
                shared { prop Value T? { get; } }
            }
            struct C : I[int32] {
                shared { prop Value int32 -> 1 }
            }
            """;

        AssertEmitsAndLoads(source);
    }

    [Fact]
    public void ExplicitStaticVirtualNullableErasure_EmitsAndLoads()
    {
        const string source = """
            package StaticExplicitCovarianceRejected
            sealed interface I[T] {
                shared { prop Value T? { get; } }
            }
            struct C : I[int32] {
                shared {
                    private prop (I[int32]) Value int32 -> 1
                }
            }
            """;

        AssertEmitsAndLoads(source);
    }

    [Fact]
    public void ImportedGenericDisplayCollision_ReportsGS0187InsteadOfMisleadingGS0504()
    {
        const string source = """
            package ImportedGenericMismatch
            import System.Collections.Generic

            interface ISeq[T] { prop Items List[T] { get; } }
            class IntSeq : ISeq[int32] {
                prop Items List[int32] { get; }
            }
            """;

        var output = CompileExpectingFailure(source);

        Assert.Contains("GS0187", output, StringComparison.Ordinal);
        Assert.DoesNotContain("GS0504", output, StringComparison.Ordinal);
    }

    [Fact]
    public void ConstructedGenericMismatches_ReportGS0504WithSubstitutedTypesAndDoNotEmit()
    {
        const string source = """
            package GenericRejected

            interface IBox[T] { prop Value T { get; } }
            class WrongType : IBox[int32] { prop Value string -> "x" }

            interface INullableBox[T] { prop Value T? { get; } }
            class NullableGetter : INullableBox[int32] {
                prop Value int32? -> nil
            }

            interface INullableSettableBox[T] { prop Value T? { get; set; } }
            class NullableSettable : INullableSettableBox[int32] {
                prop Value int32? { get; set; }
            }

            interface IStructNullable[T struct] { prop Value T? { get; } }
            class StructConstrained[T struct] : IStructNullable[T] {
                prop Value T { get; }
            }
            """;

        var output = CompileExpectingFailure(source);

        Assert.Equal(4, CountOccurrences(output, "error GS0504:"));
        Assert.Contains(
            "Type 'WrongType' cannot use property 'Value' to implement interface property 'IBox[int32].Value': expected type 'int32', actual type 'string'.",
            output,
            StringComparison.Ordinal);
        Assert.Contains(
            "Type 'NullableGetter' cannot use property 'Value' to implement interface property 'INullableBox[int32].Value': expected type 'int32', actual type 'int32?'.",
            output,
            StringComparison.Ordinal);
        Assert.Contains(
            "Type 'NullableSettable' cannot use property 'Value' to implement interface property 'INullableSettableBox[int32].Value': expected type 'int32', actual type 'int32?'.",
            output,
            StringComparison.Ordinal);
        Assert.Contains(
            "Type 'StructConstrained' cannot use property 'Value' to implement interface property 'IStructNullable[T].Value': expected type 'T?', actual type 'T'.",
            output,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ExplicitClauseAndPrivateBaseProperties_DoNotSilentlySatisfyOtherSlots()
    {
        const string source = """
            package ShadowRejected

            interface IA { prop Value int32 { get; } }
            interface IB { prop Value string { get; } }
            class ExplicitShadow : IA, IB {
                private prop (IB) Value string -> "x"
            }

            interface IPrivateBase { prop Value int32 { get; } }
            open class PrivateBase { private prop Value int32 -> 1 }
            class PrivateBaseDerived : PrivateBase, IPrivateBase { }
            """;

        var output = CompileExpectingFailure(source);

        Assert.Equal(2, CountOccurrences(output, "error GS0187:"));
        Assert.DoesNotContain("GS0504", output, StringComparison.Ordinal);
        Assert.Contains("Class 'ExplicitShadow' does not implement interface method 'IA.Value'.", output, StringComparison.Ordinal);
        Assert.Contains("Class 'PrivateBaseDerived' does not implement interface method 'IPrivateBase.Value'.", output, StringComparison.Ordinal);
    }

    [Fact]
    public void PositionalValueTypeNullableCovariance_ReportsGS0504AndDoesNotEmit()
    {
        const string source = """
            package PositionalRejected

            interface IBox { prop Value int32? { get; } }
            data class Box(Value int32) : IBox
            """;

        var output = CompileExpectingFailure(source);

        Assert.Contains(
            "error GS0504: Type 'Box' cannot use property 'Value' to implement interface property 'IBox.Value': expected type 'int32?', actual type 'int32'.",
            output,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ExplicitAndStaticMismatchPaths_StillRejectWithoutOutput()
    {
        const string source = """
            package ExistingPaths

            interface IExplicit { prop Value int32 { get; } }
            class ExplicitMismatch : IExplicit {
                private prop (IExplicit) Value string -> "x"
            }

            sealed interface IStatic {
                shared { prop Value int32 { get; } }
            }
            struct StaticMismatch : IStatic {
                shared { prop Value string -> "x" }
            }
            """;

        var output = CompileExpectingFailure(source);

        Assert.Contains("GS0494", output, StringComparison.Ordinal);
        Assert.Contains("GS0397", output, StringComparison.Ordinal);
    }

    [Fact]
    public void ImportedClrInterfaceProperty_ExactType_EmitsVerifyAndLoads()
    {
        const string source = """
            package ImportedExact
            import ClrContracts

            class Box : IBox {
                prop Value int32 { get; set; }
            }
            """;

        var directory = CreateWorkDirectory();
        try
        {
            var referencePath = CompileCSharpFixture(directory);
            AssertEmitsAndLoads(source, referencePath);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void ImportedObliviousInterfaceProperty_NullableImplementation_EmitsVerifyAndLoads()
    {
        const string source = """
            package ImportedOblivious
            import ClrContracts

            class Book : IObliviousBook {
                prop Asin string?
            }
            """;

        var directory = CreateWorkDirectory();
        try
        {
            var referencePath = CompileCSharpFixture(directory);
            AssertEmitsAndLoads(source, referencePath);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void ImportedClrInterfaceProperty_WrongType_ReportsGS0187AndDoesNotEmit()
    {
        const string source = """
            package ImportedMismatch
            import ClrContracts

            class Box : IBox {
                prop Value string { get; set; }
            }
            """;

        var directory = CreateWorkDirectory();
        try
        {
            var referencePath = CompileCSharpFixture(directory);
            var output = CompileExpectingFailure(source, referencePath);
            Assert.Contains("GS0187", output, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void ImportedClrBaseProperty_SatisfiesGSharpInterface_EmitsVerifyAndLoads()
    {
        const string source = """
            package ImportedBaseExact
            import ClrContracts

            interface IValue { prop Value int32 { get; } }
            class Box : Base, IValue { }
            """;

        var directory = CreateWorkDirectory();
        try
        {
            var referencePath = CompileCSharpFixture(directory);
            AssertEmitsAndLoads(source, referencePath);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void ImportedClrBaseProperty_HiddenByWrongTypeProperty_EmitsVerifyAndLoads()
    {
        const string source = """
            package ImportedBaseHidden
            import ClrContracts

            interface IValue { prop Value int32 { get; } }
            class Box : Base, IValue {
                prop Value string -> "x"
            }
            """;

        var directory = CreateWorkDirectory();
        try
        {
            var referencePath = CompileCSharpFixture(directory);
            AssertEmitsAndLoads(source, referencePath);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void ImportedClrBaseProperty_WrongTypeOrAccessor_ReportsGS0187AndDoesNotEmit()
    {
        const string source = """
            package ImportedBaseRejected
            import ClrContracts

            interface IValue { prop Value int32 { get; } }
            class WrongTypeBox : WrongTypeBase, IValue { }
            class MissingGetterBox : MissingGetterBase, IValue { }
            """;

        var directory = CreateWorkDirectory();
        try
        {
            var referencePath = CompileCSharpFixture(directory);
            var output = CompileExpectingFailure(source, referencePath);
            Assert.Equal(2, CountOccurrences(output, "error GS0187:"));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static int CountOccurrences(string text, string value)
        => text.Split(value, StringSplitOptions.None).Length - 1;

    private static string CompileExpectingFailure(string source, string referencePath = null)
    {
        var directory = CreateWorkDirectory();
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            var arguments = CreateCompilerArguments(sourcePath, outputPath, referencePath);
            var (exitCode, output) = Compile(arguments);

            Assert.NotEqual(0, exitCode);
            Assert.False(File.Exists(outputPath), "gsc must not emit an assembly after an interface-property error.");
            return output;
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static void AssertEmitsAndLoads(string source, string referencePath = null)
    {
        var directory = CreateWorkDirectory();
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            var arguments = CreateCompilerArguments(sourcePath, outputPath, referencePath);
            var (exitCode, output) = Compile(arguments);

            Assert.True(exitCode == 0, "gsc failed:\n" + output);
            Assert.True(File.Exists(outputPath), "gsc did not emit the expected assembly.");
            IlVerifier.Verify(
                outputPath,
                referencePath == null ? null : new[] { referencePath });
            if (referencePath != null)
            {
                _ = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.GetFullPath(referencePath));
            }

            _ = EmittedFixture.Load(outputPath).GetTypes();
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string[] CreateCompilerArguments(
        string sourcePath,
        string outputPath,
        string referencePath)
    {
        var arguments = new List<string>
        {
            "/out:" + outputPath,
            "/target:library",
            "/targetframework:net10.0",
        };
        if (referencePath != null)
        {
            arguments.Add("/r:" + referencePath);
        }

        arguments.Add(sourcePath);
        return arguments.ToArray();
    }

    private static string CompileCSharpFixture(string directory)
    {
        var outputPath = Path.Combine(directory, "ClrContracts." + Guid.NewGuid().ToString("N") + ".dll");
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
            .Split(Path.PathSeparator)
            .Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            Path.GetFileNameWithoutExtension(outputPath),
            new[]
            {
                CSharpSyntaxTree.ParseText(
                    """
                    namespace ClrContracts;
                    public interface IBox
                    {
                        int Value { get; set; }
                    }

                    #nullable disable
                    public interface IObliviousBook
                    {
                        string Asin { get; }
                    }
                    #nullable restore

                    public class Base
                    {
                        public virtual int Value => 1;
                    }

                    public class WrongTypeBase
                    {
                        public virtual string Value => "x";
                    }

                    public class MissingGetterBase
                    {
                        public virtual int Value { set { } }
                    }
                    """,
                    new CSharpParseOptions(LanguageVersion.Latest)),
            },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var output = File.Create(outputPath);
        var result = compilation.Emit(output);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return outputPath;
    }

    private static (int ExitCode, string Output) Compile(params string[] arguments)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(arguments);
            return (exitCode, stdout.ToString() + stderr);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string CreateWorkDirectory()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue2888",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }
}
