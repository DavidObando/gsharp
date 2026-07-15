// <copyright file="StructuralProjectionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Tests ADR-0148 safe structural projections.</summary>
public class StructuralProjectionTests
{
    [Fact]
    public void NamedSourceAndTargetProduceProjectionPlan()
    {
        const string sourceText = @"
class Source { var Name string var Age int32 var Extra bool }
class Target { var Name string var Age int64 }
let source = Source{Name: ""Ada"", Age: 36, Extra: true}
0
";
        var tree = SyntaxTree.Parse(SourceText.From(sourceText));
        var compilation = new Compilation(tree);
        _ = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        var sourceType = compilation.GlobalScope.Variables.Single(v => v.Name == "source").Type;
        var targetType = compilation.GlobalScope.Structs.Single(s => s.Name == "Target");

        var planned = StructuralProjectionPlanner.TryCreate(
            sourceType,
            targetType,
            strict: true,
            explicitMemberNames: null,
            out _,
            out var failure);

        Assert.True(planned, failure);
    }

    [Fact]
    public void AnonymousObject_ImplicitlyProjectsToNamedClass()
    {
        var result = Evaluate(@"
class Person { var Name string var Age int64 }
let person Person = object { let Name = ""Ada""; let Age = 36; let Extra = true }
person.Name == ""Ada"" && person.Age == 36
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void DataObject_ImplicitlyProjectsToPrimaryConstructor()
    {
        var result = Evaluate(@"
data class Person(Name string, Age int64) {}
let person Person = data object { let Name = ""Ada""; let Age = 36 }
person.Name == ""Ada"" && person.Age == 36
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void NamedSource_UsesWidthSubtypingAndCannotWritePrivateTargetField()
    {
        var result = Evaluate(@"
class Source { var Name string var Age int32 var Secret int32 }
class Target {
    var Name string
    var Age int64
    private var Secret int32 = 91
    func ReadSecret() int32 -> Secret
}
let source = Source{Name: ""Ada"", Age: 36, Secret: 0}
let target Target = source
target.ReadSecret()
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(91, result.Value);
    }

    [Fact]
    public void ProjectionEvaluatesAllAnonymousInitializersExactlyOnce()
    {
        var result = Evaluate(@"
class Target { var Value int32 }
func Next(value int32) int32 {
    effects = effects + 1
    return value
}
var effects = 0
let target Target = object { let Value = Next(7); let Extra = Next(8) }
effects * 10 + target.Value
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(27, result.Value);
    }

    [Fact]
    public void ProjectionEvaluatesSourceAndSelectedGetterOnce()
    {
        var result = Evaluate(@"
class Source {
    prop Value int32 {
        get {
            reads = reads + 1
            return 7
        }
    }
}
class Target { var Value int32 }
func Make() Source {
    creates = creates + 1
    return Source{}
}
var creates = 0
var reads = 0
let target Target = Make()
creates * 100 + reads * 10 + target.Value
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(117, result.Value);
    }

    [Fact]
    public void MissingRequiredMemberReportsProjectionDiagnostic()
    {
        var result = Evaluate(@"
class Source { var Name string }
class Target { var Name string var Age int32 }
let source = Source{Name: ""Ada""}
let target Target = source
0
");

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0490");
        Assert.Contains("Age", diagnostic.Message);
    }

    [Fact]
    public void ExplicitSpreadOverridesSourceMember()
    {
        var result = Evaluate(@"
class Source { var Name string var Age int32 }
class Target { var Name string var Age int64 }
let source = Source{Name: ""Ada"", Age: 36}
let target = Target{ ...source, Age: 42 }
target.Name == ""Ada"" && target.Age == 42
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void ExplicitSpreadSuppliesPrimaryConstructorAndPreservesPartialDefaults()
    {
        var primary = Evaluate(@"
class Source { var Name string var Age int32 }
data class Target(Name string, Age int64) {}
let source = Source{Name: ""Ada"", Age: 36}
let target = Target{ ...source, Age: 42 }
target.Name == ""Ada"" && target.Age == 42
");
        Assert.Empty(primary.Diagnostics);
        Assert.Equal(true, primary.Value);

        var partial = Evaluate(@"
class Source { var Name string }
class Target { var Name string var Age int32 = 9 }
let source = Source{Name: ""Ada""}
let target = Target{ ...source }
target.Name == ""Ada"" && target.Age == 9
");
        Assert.Empty(partial.Diagnostics);
        Assert.Equal(true, partial.Value);

        var partialStruct = Evaluate(@"
struct Source { var Name string }
struct Target { var Name string var Age int32 = 11 }
let source = Source{Name: ""Ada""}
let target = Target{ ...source }
target.Name == ""Ada"" && target.Age == 11
");
        Assert.Empty(partialStruct.Diagnostics);
        Assert.Equal(true, partialStruct.Value);
    }

    [Fact]
    public void GenericTargetSpreadParsesAndProjects()
    {
        var result = Evaluate(@"
class Source { var Value int32 }
class Box[T] { var Value T }
let source = Source{Value: 7}
let box = Box[int32]{ ...source }
box.Value
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void OptionalConstructorInputsRetainTheirDefaults()
    {
        var result = Evaluate(@"
class Source { var Name string }
data class Target(Name string, Age int32 = 9) {}
let source = Source{Name: ""Ada""}
let implicitTarget Target = source
let explicitTarget = Target{ ...source }
implicitTarget.Age + explicitTarget.Age
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(18, result.Value);
    }

    [Fact]
    public void ExplicitSpreadBindsConstructorOnlyAndConstructedGenericSlots()
    {
        var constructorOnly = Evaluate(@"
class Source { var Other int32 }
class Target {
    private var stored int32
    init(value int32) { stored = value }
    func Read() int32 { return stored }
}
let source = Source{Other: 1}
let target = Target{ ...source, value: 7 }
target.Read()
");
        Assert.Empty(constructorOnly.Diagnostics);
        Assert.Equal(7, constructorOnly.Value);

        var generic = Evaluate(@"
class Source { var value int32 }
class Box[T] {
    private var stored T
    init(value T) { stored = value }
    func Read() T { return stored }
}
let source = Source{value: 9}
let box = Box[int32]{ ...source }
box.Read()
");
        Assert.Empty(generic.Diagnostics);
        Assert.Equal(9, generic.Value);
    }

    [Fact]
    public void ImportedValueTypeUsesApplicablePublicConstructor()
    {
        var result = Evaluate(@"
import System
class Source { var ticks int64 }
let source = Source{ticks: 42L}
let duration TimeSpan = source
duration.Ticks
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42L, result.Value);
    }

    [Fact]
    public void ProjectedMemberUsesUserDefinedImplicitConversion()
    {
        var result = Evaluate(@"
struct Amount {
    var Value int32
    func operator implicit (amount Amount) int64 {
        return amount.Value
    }
}
class Source { var Number Amount }
class Target { var Number int64 }
let source = Source{Number: Amount{Value: 12}}
let target Target = source
target.Number
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(12L, result.Value);
    }

    [Fact]
    public void ImportedMethodOverloadAcceptsStructuralProjection()
    {
        var result = Evaluate(@"
import System.Net.Http
class Source { var uriString string }
func Probe(client HttpClient, source Source) {
    let pending = client.GetAsync(source)
}
0
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NamedStructProjectsThroughAssignmentReturnAndArgument()
    {
        var result = Evaluate(@"
struct Source { var Name string var Age int32 var Extra bool }
struct Target { var Name string var Age int64 }
func Project(source Source) Target { return source }
func Read(target Target) int64 { return target.Age }
let source = Source{Name: ""Ada"", Age: 36, Extra: true}
let assigned Target = source
Read(Project(source)) + assigned.Age
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(72L, result.Value);
    }

    [Fact]
    public void ProjectionWritesPublicInitProperty()
    {
        var result = Evaluate(@"
class Source { var Name string }
class Target { prop Name string { get; init; } }
let source = Source{Name: ""Ada""}
let target Target = source
target.Name
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("Ada", result.Value);
    }

    [Fact]
    public void ImportedClrSourceProjectsThroughPublicProperties()
    {
        var result = Evaluate(@"
import System
class VersionDto { var Major int32 var Minor int32 }
let version = Version(3, 7)
let dto VersionDto = version
dto.Major * 10 + dto.Minor
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(37, result.Value);
    }

    [Fact]
    public void AnonymousObjectProjectsToImportedClrTarget()
    {
        var result = Evaluate(@"
import System.Text
let builder StringBuilder = object { let Capacity = 20; let Length = 0 }
builder.Capacity >= 20 && builder.Length == 0
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void ExplicitSpreadProjectsToImportedClrTarget()
    {
        var result = Evaluate(@"
import System.Text
class Source { var Length int32 }
let source = Source{Length: 0}
let builder = StringBuilder{ ...source, Capacity: 24 }
builder.Capacity >= 24 && builder.Length == 0
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void PrivateSourceMemberDoesNotParticipate()
    {
        var result = Evaluate(@"
class Source { private var Age int32 = 36 }
class Target { var Age int32 }
let source = Source{}
let target Target = source
0
");

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0490");
        Assert.Contains("public readable", diagnostic.Message);
    }

    [Fact]
    public void ExplicitSpreadCannotWritePrivateTargetStorage()
    {
        var result = Evaluate(@"
class Source { var Value int32 }
class Target {
    var Value int32
    private var Secret int32
    func Copy(source Source) Target {
        return Target{ ...source, Secret: 7 }
    }
}
0
");

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0490");
        Assert.Contains("public construction or writable member", diagnostic.Message);
    }

    [Fact]
    public void ConstructedGenericReadonlyFieldIsNotWritable()
    {
        var result = Evaluate(@"
class Source { var Value int32 }
class Box[T] { let Value T }
let source = Source{Value: 7}
let box Box[int32] = source
0
");

        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void ConstructedGenericTargetsPreserveDeclaredFieldInitializers()
    {
        var classResult = Evaluate(@"
class Source { var Value int32 }
class Box[T] {
    var Value T
    private var Marker int32 = 9
    func ReadMarker() int32 { return Marker }
}
let source = Source{Value: 7}
let box Box[int32] = source
box.ReadMarker()
");
        Assert.Empty(classResult.Diagnostics);
        Assert.Equal(9, classResult.Value);

        var structResult = Evaluate(@"
struct Source { var Value int32 }
struct Box[T] {
    var Value T
    private var Marker int32 = 11
    func ReadMarker() int32 { return Marker }
}
let source = Source{Value: 7}
let box Box[int32] = source
box.ReadMarker()
");
        Assert.Empty(structResult.Diagnostics);
        Assert.Equal(11, structResult.Value);
    }

    [Fact]
    public void ProjectionDoesNotRecursivelyProjectMemberValues()
    {
        var result = Evaluate(@"
class InnerSource { var Value int32 }
class InnerTarget { var Value int32 }
class Source { var Inner InnerSource }
class Target { var Inner InnerTarget }
let source = Source{Inner: InnerSource{Value: 7}}
let target Target = source
0
");

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0490");
        Assert.Contains("Inner", diagnostic.Message);
    }

    [Fact]
    public void IdentityOverloadOutranksProjection()
    {
        var result = Evaluate(@"
class Source { var Value int32 }
class Target { var Value int32 }
func Pick(value Source) int32 { return 1 }
func Pick(value Target) int32 { return 2 }
let source = Source{Value: 7}
Pick(source)
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void UnrelatedProjectionOverloadsRemainAmbiguous()
    {
        var result = Evaluate(@"
class Source { var Value int32 }
class First { var Value int32 }
class Second { var Value int32 }
func Pick(value First) int32 { return 1 }
func Pick(value Second) int32 { return 2 }
let source = Source{Value: 7}
Pick(source)
");

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0266");
    }

    [Fact]
    public void UserDefinedImplicitConversionOutranksProjection()
    {
        var result = Evaluate(@"
struct Target { var Value int32 }
struct Source {
    var Value int32
    func operator implicit (source Source) Target {
        return Target{Value: 99}
    }
}
let source = Source{Value: 7}
let target Target = source
target.Value
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(99, result.Value);
    }

    [Fact]
    public void ProjectionIsNotAppliedToRefArgument()
    {
        var result = Evaluate(@"
class Source { var Value int32 }
class Target { var Value int32 }
func Touch(ref target Target) {}
var source = Source{Value: 7}
Touch(ref source)
0
");

        Assert.NotEmpty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
