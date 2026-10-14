// <copyright file="Issue4449ArrayPlatformReaderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests
import GSharp.Core.Tests.ReaderAgreement
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #4449: oblivious array positions have one canonical reading.
class Issue4449ArrayPlatformReaderTests : IDisposable {
    private let nullabilityScope IDisposable = NullabilityOptions.Enter(NullabilityMode.PlatformTypes)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Dispose() -> this.nullabilityScope.Dispose()

    @Fact
    func ObliviousStringArray_Readers_Agree_OnPlatformArrayAndElement() {
        using let fixture = CSharpFixture(Contract)
        let type = Assert.IsAssignableFrom[Type](
            fixture.Load().GetType("Issue4449.Contract.Surface", throwOnError: true)
        )
        let receiver = ImportedTypeSymbol.Get(type)
        let field = Assert.IsAssignableFrom[FieldInfo](type.GetField("Field"))
        let property = Assert.IsAssignableFrom[PropertyInfo](type.GetProperty("Property"))
        let method = Assert.IsAssignableFrom[MethodInfo](type.GetMethod("Return"))
        let parameterMethod = Assert.IsAssignableFrom[MethodInfo](type.GetMethod("Parameter"))
        let parameter = parameterMethod.GetParameters()[0]
        let indexer = Assert.IsAssignableFrom[PropertyInfo](type.GetProperty("Item"))
        let indexParameter = indexer.GetIndexParameters()[0]
        let readers = Dictionary[string, TypeSymbol]{
            ["field-direct"] = ClrNullability.GetFieldTypeSymbol(field),
            ["field-member"] = MemberLookup.GetClrFieldTypeSymbol(receiver, field),
            ["property-direct"] = ClrNullability.GetPropertyTypeSymbol(property),
            ["property-member"] = MemberLookup.GetClrPropertyTypeSymbol(receiver, property),
            ["return-direct"] = ClrNullability.GetReturnTypeSymbol(method),
            ["return-member"] = MemberLookup.GetClrMethodReturnTypeSymbol(receiver, method),
            ["parameter-direct"] = ClrNullability.GetParameterTypeSymbol(parameter),
            ["parameter-member"] = MemberLookup.GetClrMethodParameterTypeSymbol(receiver, parameterMethod, 0),
            ["indexer-direct"] = ClrNullability.GetPropertyTypeSymbol(indexer),
            ["indexer-member"] = MemberLookup.GetClrPropertyTypeSymbol(receiver, indexer),
            ["index-parameter-direct"] = ClrNullability.GetParameterTypeSymbol(indexParameter),
            ["index-parameter-member"] = MemberLookup.GetIndexerParameterTypeSymbol(receiver, indexer, 0)
        }
        Assert.All(
            readers,
            (pair KeyValuePair[string, TypeSymbol]) -> Assert.Equal("!<!>", ReaderAgreementHarness.Shape(pair.Value))
        )
        Assert.Single(
            readers.Values.Select((typeSymbol TypeSymbol) -> ReaderAgreementHarness.Shape(typeSymbol)).Distinct()
        )
    }

    @Theory
    @InlineData("Surface().Field")
    @InlineData("Surface().Property")
    @InlineData("Surface().Return()")
    @InlineData("Surface()[Surface().Field]")
    func BoundMemberReads_UseTheSameCanonicalShape(expression string) {
        using let fixture = CSharpFixture(Contract)
        Assert.Equal("[]!string!", ProbeType(fixture, expression))
    }

    @Fact
    func FileReadAllLines_FromNetStandard20_IsPlatformAtBothArrayPositions() {
        let referenceDirectory = Assert.IsType[string](
            typeof(Issue4449ArrayPlatformReaderTests)
                .Assembly
                .GetCustomAttributes[AssemblyMetadataAttribute]()
                .Single((attribute AssemblyMetadataAttribute) -> attribute.Key == "NetStandard20ReferenceDirectory")
                .Value
        )
        let paths = Directory.EnumerateFiles(referenceDirectory, "*.dll").ToArray()
        using let resolver = ReferenceResolver.WithReferences(paths)
        let fileType = Assert.IsAssignableFrom[Type](
            resolver
                .Assemblies
                .Select((assembly Assembly) -> assembly.GetType("System.IO.File"))
                .FirstOrDefault((type Type?) -> type != nil)
        )
        let method = fileType.GetMethods().Single(
            (candidate MethodInfo) -> candidate.Name == "ReadAllLines" && candidate.GetParameters() is [
                {ParameterType: {FullName: "System.String"}}
            ]
        )
        let result = ClrNullability.GetReturnTypeSymbol(method)
        Assert.Equal("!<!>", ReaderAgreementHarness.Shape(result))
        Assert.Equal("[]!string!", SymbolDisplay.ToTypeDisplayString(result))
    }

    @Fact
    func AnnotatedAndValueTypeArrays_KeepTheirDeclaredPositions() {
        let Shape = func (type Type, fieldName string) string {
            return ReaderAgreementHarness.Shape(
                ClrNullability.GetFieldTypeSymbol(Assert.IsAssignableFrom[FieldInfo](type.GetField(fieldName)))
            )
        }
        using let fixture = CSharpFixture(`#nullable enable

public sealed class Controls
{
    public string[] NonNull = [];
    public string?[] NullableElement = [];
    public string[]? NullableArray;
    public int[] Values = [];
    public string?[,] Grid = new string?[1, 1];
}`)
        let type = Assert.IsAssignableFrom[Type](fixture.Load().GetType("Controls", throwOnError: true))
        Assert.Equal("n<n>", Shape(type, "NonNull"))
        Assert.Equal("n<?>", Shape(type, "NullableElement"))
        Assert.Equal("?<n>", Shape(type, "NullableArray"))
        Assert.Equal("n<v>", Shape(type, "Values"))
        Assert.Equal("n<?>", Shape(type, "Grid"))
    }

    @Fact
    func SymbolicGenericAndByRefArrayPositions_KeepTheirElementFacts() {
        using let fixture = CSharpFixture(`#nullable disable

public sealed class Box<T>
{
    public T[] Values;
    public ref T[] RefReturn() => throw null;
    public void RefParameter(ref T[] values) { }
}`)
        let type = Assert.IsAssignableFrom[Type](fixture.Load().GetType("Box`1", throwOnError: true)).MakeGenericType(
            typeof(string)
        )
        let receiver = ImportedTypeSymbol.Get(type)
        let field = Assert.IsAssignableFrom[FieldInfo](type.GetField("Values"))
        let returnMethod = Assert.IsAssignableFrom[MethodInfo](type.GetMethod("RefReturn"))
        let parameterMethod = Assert.IsAssignableFrom[MethodInfo](type.GetMethod("RefParameter"))
        Assert.Equal("!<n>", ReaderAgreementHarness.Shape(MemberLookup.GetClrFieldTypeSymbol(receiver, field)))
        Assert.Equal(
            "!<n>",
            ReaderAgreementHarness.Shape(
                Assert.IsType[ByRefTypeSymbol](MemberLookup.GetClrMethodReturnTypeSymbol(receiver, returnMethod))
                    .PointeeType
            )
        )
        Assert.Equal(
            "!<n>",
            ReaderAgreementHarness.Shape(
                Assert.IsType[ByRefTypeSymbol](
                    MemberLookup.GetClrMethodParameterTypeSymbol(receiver, parameterMethod, 0)
                )
                    .PointeeType
            )
        )
    }

    @Theory
    @InlineData("surface.Field")
    @InlineData("surface.Property")
    @InlineData("surface.Return()")
    @InlineData("surface[surface.Field]")
    func PlatformElementArray_DoesNotConvertToNonNullElementArray(expression string) {
        using let fixture = CSharpFixture(Contract)
        let diagnostics = CompileErrors(fixture, (`import Issue4449.Contract
func Probe(surface Surface) int32 {
    var values []string
    values = ` + "$expression" + `
    return values.Length
}`))
        Assert.Contains(
            diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Id == "GS0155" && diagnostic.Message.Contains(
                "[]!string!",
                StringComparison.Ordinal
            )
        )
    }

    @Theory
    @InlineData("surface.Field")
    @InlineData("surface.Return()")
    func PlatformElementArray_StillConvertsToNullableElementArray(expression string) {
        using let fixture = CSharpFixture(Contract)
        let diagnostics = CompileErrors(fixture, (`import Issue4449.Contract
func Probe(surface Surface) int32 {
    var values []string?
    values = ` + "$expression" + `
    return values.Length
}`))
        Assert.Empty(diagnostics)
    }

    shared {
        private const Contract string = `#nullable disable

namespace Issue4449.Contract
{
    public sealed class Surface
    {
        public string[] Field;
        public string[] Property { get; set; }
        public string[] Return() => null;
        public void Parameter(string[] value) { }
        public string[] this[string[] key] => null;
    }
}`

        private func ProbeType(fixture CSharpFixture, expression string) string {
            using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
            let compilation = Compilation(
                resolver,
                GsSyntaxTree.Parse(SourceText.From("import Issue4449.Contract\nlet probe = " + expression))
            ){Nullability = NullabilityMode.PlatformTypes}
            Assert.Empty(compilation.GlobalScope.Diagnostics.Where((diagnostic Diagnostic) -> diagnostic.IsError))
            let type = Assert.Single(
                compilation.GlobalScope.Variables,
                (variable VariableSymbol) -> variable.Name == "probe"
            )
                .Type
            return SymbolDisplay.ToTypeDisplayString(type)
        }

        private func CompileErrors(fixture CSharpFixture, source string) IReadOnlyList[Diagnostic] {
            using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
            let compilation = Compilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){
                Nullability = NullabilityMode.PlatformTypes
            }
            return compilation
                .GlobalScope
                .Diagnostics
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((diagnostic Diagnostic) -> diagnostic.IsError)
                .ToArray()
        }
    }
}
