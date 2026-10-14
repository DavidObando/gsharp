// <copyright file="StructuralProjectionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Linq
import Xunit

/// Tests ADR-0148 safe structural projections.
open class StructuralProjectionTests {
    @Fact
    func NamedSourceAndTargetProduceProjectionPlan() {
        const sourceText = `
class Source { var Name string var Age int32 var Extra bool }
class Target { var Name string var Age int64 }
let source = Source{Name: "Ada", Age: 36, Extra: true}
0
`
        // Binder inspection only (issue #3176 Phase 3b.3): a full bind of
        // this compilation populates GlobalScope; nothing needs to execute.
        let tree = SyntaxTree.Parse(SourceText.From(sourceText))
        let compilation = Compilation(tree)
        let _ = EmittedOracle.CompileDiagnostics(compilation)
        let sourceType = compilation.GlobalScope.Variables.Single((v VariableSymbol) -> v.Name == "source").Type
        let targetType = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Target")
        let planned = StructuralProjectionPlanner.TryCreate(
            sourceType,
            targetType,
            strict: true,
            explicitMemberNames: nil,
            out _,
            out var failure
        )
        Assert.True(planned, failure)
    }

    @Fact
    func ReceiverWriteRecoveryRejectsStructuralProjection() {
        const sourceText = `class Source { var Name string var Age int32 }
class Target { var Name string var Age int64 }
let source = Source{Name: "Ada", Age: 36}
0`
        let tree = SyntaxTree.Parse(SourceText.From(sourceText))
        let compilation = Compilation(tree)
        let _ = EmittedOracle.CompileDiagnostics(compilation)
        let sourceType = compilation.GlobalScope.Variables.Single((v VariableSymbol) -> v.Name == "source").Type
        let targetType = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Target")
        Assert.True(Conversion.Classify(sourceType, targetType).IsStructuralProjection)
        Assert.False(ExpressionBinder.CanRecoverDeclaredMemberWriteReceiver(sourceType, targetType))
    }

    @Fact
    func AnonymousObject_ImplicitlyProjectsToNamedClass() {
        let result = Evaluate(`
class Person { var Name string var Age int64 }
let person Person = object { let Name = "Ada"; let Age = 36; let Extra = true }
person.Name == "Ada" && person.Age == 36
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func DataObject_ImplicitlyProjectsToPrimaryConstructor() {
        let result = Evaluate(`
data class Person(Name string, Age int64) {}
let person Person = data object { let Name = "Ada"; let Age = 36 }
person.Name == "Ada" && person.Age == 36
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func NamedSource_UsesWidthSubtypingAndCannotWritePrivateTargetField() {
        let result = Evaluate(`
class Source { var Name string var Age int32 var Secret int32 }
class Target {
    var Name string
    var Age int64
    private var Secret int32 = 91
    func ReadSecret() int32 -> Secret
}
let source = Source{Name: "Ada", Age: 36, Secret: 0}
let target Target = source
target.ReadSecret()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(91, result.Value)
    }

    @Fact
    func ProjectionEvaluatesAllAnonymousInitializersExactlyOnce() {
        let result = Evaluate(`
class Target { var Value int32 }
func Next(value int32) int32 {
    effects = effects + 1
    return value
}
var effects = 0
let target Target = object { let Value = Next(7); let Extra = Next(8) }
effects * 10 + target.Value
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(27, result.Value)
    }

    @Fact
    func ProjectionEvaluatesSourceAndSelectedGetterOnce() {
        let result = Evaluate(`
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
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(117, result.Value)
    }

    @Fact
    func MissingRequiredMemberReportsProjectionDiagnostic() {
        let result = Evaluate(`
class Source { var Name string }
class Target { var Name string var Age int32 }
let source = Source{Name: "Ada"}
let target Target = source
0
`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0490")
        Assert.Contains("Age", diagnostic.Message)
    }

    @Fact
    func ExplicitSpreadOverridesSourceMember() {
        let result = Evaluate(`
class Source { var Name string var Age int32 }
class Target { var Name string var Age int64 }
let source = Source{Name: "Ada", Age: 36}
let target = Target{ ...source, Age: 42 }
target.Name == "Ada" && target.Age == 42
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func ExplicitSpreadSuppliesPrimaryConstructorAndPreservesPartialDefaults() {
        let primary = Evaluate(`
class Source { var Name string var Age int32 }
data class Target(Name string, Age int64) {}
let source = Source{Name: "Ada", Age: 36}
let target = Target{ ...source, Age: 42 }
target.Name == "Ada" && target.Age == 42
`)
        Assert.Empty(primary.Diagnostics)
        Assert.Equal(true, primary.Value)
        let partial = Evaluate(`
class Source { var Name string }
class Target { var Name string var Age int32 = 9 }
let source = Source{Name: "Ada"}
let target = Target{ ...source }
target.Name == "Ada" && target.Age == 9
`)
        Assert.Empty(partial.Diagnostics)
        Assert.Equal(true, partial.Value)
        let partialStruct = Evaluate(`
struct Source { var Name string }
struct Target { var Name string var Age int32 = 11 }
let source = Source{Name: "Ada"}
let target = Target{ ...source }
target.Name == "Ada" && target.Age == 11
`)
        Assert.Empty(partialStruct.Diagnostics)
        Assert.Equal(true, partialStruct.Value)
    }

    @Fact
    func GenericTargetSpreadParsesAndProjects() {
        let result = Evaluate(`
class Source { var Value int32 }
class Box[T] { var Value T }
let source = Source{Value: 7}
let box = Box[int32]{ ...source }
box.Value
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func OptionalConstructorInputsRetainTheirDefaults() {
        let result = Evaluate(`
class Source { var Name string }
data class Target(Name string, Age int32 = 9) {}
let source = Source{Name: "Ada"}
let implicitTarget Target = source
let explicitTarget = Target{ ...source }
implicitTarget.Age + explicitTarget.Age
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(18, result.Value)
    }

    @Fact
    func ExplicitSpreadBindsConstructorOnlyAndConstructedGenericSlots() {
        let constructorOnly = Evaluate(`
class Source { var Other int32 }
class Target {
    private var stored int32
    init(value int32) { stored = value }
    func Read() int32 { return stored }
}
let source = Source{Other: 1}
let target = Target{ ...source, value: 7 }
target.Read()
`)
        Assert.Empty(constructorOnly.Diagnostics)
        Assert.Equal(7, constructorOnly.Value)
        let generic = Evaluate(`
class Source { var value int32 }
class Box[T] {
    private var stored T
    init(value T) { stored = value }
    func Read() T { return stored }
}
let source = Source{value: 9}
let box = Box[int32]{ ...source }
box.Read()
`)
        Assert.Empty(generic.Diagnostics)
        Assert.Equal(9, generic.Value)
    }

    @Fact
    func ImportedValueTypeUsesApplicablePublicConstructor() {
        let result = Evaluate(`
import System
class Source { var ticks int64 }
let source = Source{ticks: 42L}
let duration TimeSpan = source
duration.Ticks
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42L, result.Value)
    }

    @Fact
    func ProjectedMemberUsesUserDefinedImplicitConversion() {
        let result = Evaluate(`
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
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(12L, result.Value)
    }

    @Fact
    func ImportedMethodOverloadAcceptsStructuralProjection() {
        // #3218: emitted — the projection into the imported `System.Uri?`
        // parameter lowers at bind time and the nullable wrap is a no-op.
        let result = Evaluate(`
import System.Net.Http
class Source { var uriString string }
func Probe(client HttpClient, source Source) {
    let pending = client.GetAsync(source)
}
0
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NamedStructProjectsThroughAssignmentReturnAndArgument() {
        let result = Evaluate(`
struct Source { var Name string var Age int32 var Extra bool }
struct Target { var Name string var Age int64 }
func Project(source Source) Target { return source }
func Read(target Target) int64 { return target.Age }
let source = Source{Name: "Ada", Age: 36, Extra: true}
let assigned Target = source
Read(Project(source)) + assigned.Age
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(72L, result.Value)
    }

    @Fact
    func ProjectionWritesPublicInitProperty() {
        let result = Evaluate(`
class Source { var Name string }
class Target { prop Name string { get; init; } }
let source = Source{Name: "Ada"}
let target Target = source
target.Name
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Ada", result.Value)
    }

    @Fact
    func ImportedClrSourceProjectsThroughPublicProperties() {
        let result = Evaluate(`
import System
class VersionDto { var Major int32 var Minor int32 }
let version = Version(3, 7)
let dto VersionDto = version
dto.Major * 10 + dto.Minor
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(37, result.Value)
    }

    @Fact
    func AnonymousObjectProjectsToImportedClrTarget() {
        let result = Evaluate(`
import System.Text
let builder StringBuilder = object { let Capacity = 20; let Length = 0 }
builder.Capacity >= 20 && builder.Length == 0
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func ExplicitSpreadProjectsToImportedClrTarget() {
        let result = Evaluate(`
import System.Text
class Source { var Length int32 }
let source = Source{Length: 0}
let builder = StringBuilder{ ...source, Capacity: 24 }
builder.Capacity >= 24 && builder.Length == 0
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func PrivateSourceMemberDoesNotParticipate() {
        let result = Evaluate(`
class Source { private var Age int32 = 36 }
class Target { var Age int32 }
let source = Source{}
let target Target = source
0
`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0490")
        Assert.Contains("public readable", diagnostic.Message)
    }

    @Fact
    func ExplicitSpreadCannotWritePrivateTargetStorage() {
        let result = Evaluate(`
class Source { var Value int32 }
class Target {
    var Value int32
    private var Secret int32
    func Copy(source Source) Target {
        return Target{ ...source, Secret: 7 }
    }
}
0
`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0490")
        Assert.Contains("public construction or writable member", diagnostic.Message)
    }

    @Fact
    func ConstructedGenericReadonlyFieldIsNotWritable() {
        let result = Evaluate(`
class Source { var Value int32 }
class Box[T] { let Value T }
let source = Source{Value: 7}
let box Box[int32] = source
0
`)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func ConstructedGenericTargetsPreserveDeclaredFieldInitializers() {
        // #3219: the emitted oracle now runs the struct target's private
        // declared initializer through the synthesized parameterless ctor
        // (in-type) instead of a call-site stfld.
        let classResult = Evaluate(`
class Source { var Value int32 }
class Box[T] {
    var Value T
    private var Marker int32 = 9
    func ReadMarker() int32 { return Marker }
}
let source = Source{Value: 7}
let box Box[int32] = source
box.ReadMarker()
`)
        Assert.Empty(classResult.Diagnostics)
        Assert.Equal(9, classResult.Value)
        let structResult = Evaluate(`
struct Source { var Value int32 }
struct Box[T] {
    var Value T
    private var Marker int32 = 11
    func ReadMarker() int32 { return Marker }
}
let source = Source{Value: 7}
let box Box[int32] = source
box.ReadMarker()
`)
        Assert.Empty(structResult.Diagnostics)
        Assert.Equal(11, structResult.Value)
    }

    @Fact
    func ProjectionDoesNotRecursivelyProjectMemberValues() {
        let result = Evaluate(`
class InnerSource { var Value int32 }
class InnerTarget { var Value int32 }
class Source { var Inner InnerSource }
class Target { var Inner InnerTarget }
let source = Source{Inner: InnerSource{Value: 7}}
let target Target = source
0
`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0490")
        Assert.Contains("Inner", diagnostic.Message)
    }

    @Fact
    func IdentityOverloadOutranksProjection() {
        let result = Evaluate(`
class Source { var Value int32 }
class Target { var Value int32 }
func Pick(value Source) int32 { return 1 }
func Pick(value Target) int32 { return 2 }
let source = Source{Value: 7}
Pick(source)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func UnrelatedProjectionOverloadsRemainAmbiguous() {
        let result = Evaluate(`
class Source { var Value int32 }
class First { var Value int32 }
class Second { var Value int32 }
func Pick(value First) int32 { return 1 }
func Pick(value Second) int32 { return 2 }
let source = Source{Value: 7}
Pick(source)
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0266")
    }

    @Fact
    func UserDefinedImplicitConversionOutranksProjection() {
        let result = Evaluate(`
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
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(99, result.Value)
    }

    @Fact
    func ProjectionIsNotAppliedToRefArgument() {
        let result = Evaluate(`
class Source { var Value int32 }
class Target { var Value int32 }
func Touch(ref target Target) {}
var source = Source{Value: 7}
Touch(ref source)
0
`)
        Assert.NotEmpty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
