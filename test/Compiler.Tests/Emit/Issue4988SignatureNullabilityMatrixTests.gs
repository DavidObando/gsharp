// <copyright file="Issue4988SignatureNullabilityMatrixTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GscProgram = GSharp.Compiler.Program
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Text
import Xunit

/// Issue #4988: the nullability a G# library declares must survive emit into
/// metadata at every signature position, whichever declaration path produced
/// the member. `func LoadAsync() Task[Token?];` on an interface was exported as
/// `Task[Token]` because a method without a body never minted the sequence-0
/// return row its `[Nullable]` lives on; a body-bearing method did.
///
/// The test is a round-trip contract over a matrix: every declaration kind gsc
/// emits a MethodDef / Property / Field / Event for, crossed with a set of type
/// shapes. The producer is compiled with the real driver; the positions are then
/// read back from metadata exactly as a separately compiled consumer reads a
/// project reference (`MetadataLoadContext` + the `ClrNullability` /
/// `MemberLookup` funnel readers), and checked against two oracles:
/// - the imported (cref:TypeSymbol), spelled in G# syntax, must equal the declared spelling;
/// - the effective per-position nullability bytes must equal what csc emits for the equivalent C#
/// declarations (the C# twin), which also pins the method-level context compression.
open class Issue4988SignatureNullabilityMatrixTests {
    /// The whole matrix, for a modern and a downlevel producer. A netstandard2.0
    /// producer embeds its own `NullableAttribute`, `NullableContextAttribute`,
    /// `IsReadOnlyAttribute`, and `IsExternalInit` (#4922, #4993), so it
    /// exercises the same plan through embedded attribute/modifier bindings.
    /// @param targetFramework The producer's target framework.
    @Theory
    @InlineData("net10.0")
    @InlineData("netstandard2.0")
    func EveryDeclarationKind_RoundTripsEveryShape_ThroughMetadata(targetFramework string) {
        let isNetStandard = targetFramework == "netstandard2.0"
        let tempDir = Directory.CreateTempSubdirectory("gs_issue4988_").FullName
        try {
            var coreDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location) ??
                throw InvalidOperationException("the host runtime has a directory")
            let references = List[string]()
            if isNetStandard {
                let netstandard = FindNetStandardReference() ??
                    throw InvalidOperationException(
                    "could not locate a netstandard.dll reference assembly; this test must not be skipped silently."
                )
                references.Add(netstandard)
                coreDirectory = Path.GetDirectoryName(netstandard) ??
                    throw InvalidOperationException("a reference assembly has a directory")
            }
            let producerPath = CompileGSharp(
                tempDir,
                BuildGSharpProducer(true),
                targetFramework,
                references,
                verify: !isNetStandard
            )
            let twinPath = CompileCSharp(tempDir, BuildCSharpTwin(true))
            using let producerContext = LoadContext(producerPath, coreDirectory, isNetStandard)
            using let twinContext = LoadContext(
                twinPath,
                Path.GetDirectoryName(typeof(object).Assembly.Location) ??
                    throw InvalidOperationException("the host runtime has a directory"),
                false
            )
            let producer = producerContext.LoadFromAssemblyPath(producerPath)
            let twin = twinContext.LoadFromAssemblyPath(twinPath)
            let failures = List[string]()
            var checkedPositions = 0
            var failingPositions = 0
            for position in BuildPositions(true) {
                let reference = Resolve(twin, position)
                checkedPositions++
                // A position gsc emitted without a row at all (an unnamed or
                // missing Param row) cannot be selected; that is a failure of
                // the round trip, not of the test.
                guard let imported = TryResolve(producer, position, failures) else {
                    failingPositions++
                    continue
                }
                let failuresBefore = failures.Count
                let importedSpelling = Render(imported.ReadSymbol(), imported.ClrType)
                if importedSpelling != position.Expected {
                    failures.Add("${position.Key}: imported as '$importedSpelling', declared '${position.Expected}'")
                }
                let importedBytes = EffectiveBytes(imported)
                let referenceBytes = position.ExpectedBytes ?? EffectiveBytes(reference)
                if importedBytes != referenceBytes {
                    failures.Add("${position.Key}: gsc bytes [$importedBytes], expected (csc) bytes [$referenceBytes]")
                }
                if failures.Count != failuresBefore {
                    failingPositions++
                }
            }
            // Anti-vacuity: the matrix really was enumerated.
            Assert.True(checkedPositions > 400, "only $checkedPositions positions were checked")
            Assert.True(
                failures.Count == 0,
                "$failingPositions of $checkedPositions positions did not round-trip ($targetFramework):\n" +
                    string.Join("\n", failures)
            )
        } finally {
            TryDelete(tempDir)
        }
    }

    /// The issue's own scenario, through the real driver on both sides: a
    /// consumer compiled against the producer DLL sees the interface's
    /// `Task[Token?]` result as `Token?`, so `!!` on it is needed (no
    /// GS0536), and returning it as a non-null `Token` is rejected. The
    /// delegate `Invoke` row is the same defect on another path.
    @Fact
    func Consumer_SeesTheNullableResultOfABodylessInterfaceMethod_AcrossAReference() {
        let tempDir = Directory.CreateTempSubdirectory("gs_issue4988_consumer_").FullName
        try {
            let libraryPath = CompileGSharp(tempDir, ContractSource, "net10.0", List[string](), verify: true)
            let asserted = CompileConsumer(tempDir, libraryPath, AssertingConsumerSource)
            Assert.True(asserted.ExitCode == 0, "the consumer must compile:\n" + asserted.Output)
            Assert.DoesNotContain("GS0536", asserted.Output, StringComparison.Ordinal)
            let interfaceMisuse = CompileConsumer(tempDir, libraryPath, InterfaceMisuseSource)
            Assert.True(
                interfaceMisuse.ExitCode != 0,
                "IStore.LoadAsync() must read back as Task[Token?]:\n" + interfaceMisuse.Output
            )
            let delegateMisuse = CompileConsumer(tempDir, libraryPath, DelegateMisuseSource)
            Assert.True(
                delegateMisuse.ExitCode != 0,
                "Loader.Invoke must read back as returning Token?:\n" + delegateMisuse.Output
            )
        } finally {
            TryDelete(tempDir)
        }
    }

    /// A generic method's `[NullableContext]` is also what C# reads for its
    /// type parameters' constraints, which gsc does not stamp (#4996). So a
    /// `T class` method keeps the type's context however its signature
    /// votes: under `[NullableContext(2)]` C# would import `where T : class?`
    /// and stop warning on a nullable type argument. Checked through a real C#
    /// consumer, for a bodyless interface method and for a method with a body
    /// (whose majority-`2` context used to do exactly that).
    @Fact
    func CSharpConsumer_KeepsTheClassConstraintOfGenericMethods() {
        let tempDir = Directory.CreateTempSubdirectory("gs_issue4988_constraint_").FullName
        try {
            let libraryPath = CompileGSharp(tempDir, GenericConstraintSource, "net10.0", List[string](), verify: true)
            let references = ReferenceResolver
                .HostTrustedPlatformAssemblyPaths()
                .Concat([]string{libraryPath})
                .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
            let compilation = CSharpCompilation.Create(
                "ConstraintConsumer",
                []SyntaxTree{CSharpSyntaxTree.ParseText(GenericConstraintConsumerSource)},
                references,
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            let diagnostics = compilation.GetDiagnostics()
            Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            let classWarnings = diagnostics.Where((d Diagnostic) -> d.Id == "CS8634").ToArray()
            Assert.True(
                classWarnings.Length == 2,
                "both `Pick[string?]` calls must violate `T class`:\n" + string.Join("\n", diagnostics)
            )
            let notNullWarnings = diagnostics.Where((d Diagnostic) -> d.Id == "CS8714").ToArray()
            Assert.True(
                notNullWarnings.Length == 2,
                "both `PickNotNull[string?]` calls must violate `T notnull`:\n" + string.Join("\n", diagnostics)
            )
            let constraintWarnings = diagnostics.Where((d Diagnostic) -> d.Id == "CS8631").ToArray()
            Assert.True(
                constraintWarnings.Length == 2,
                "both `PickEquatable` calls with non-null `IEquatable<Token>` must violate `T IEquatable[Token?]`:\n" +
                    string.Join("\n", diagnostics)
            )
        } finally {
            TryDelete(tempDir)
        }
    }

    /// Issue #4996: a G# consumer reading a library compiled by either `csc` or
    /// `gsc` preserves base-type, implemented-interface, generic-constraint,
    /// and generic-parameter nullability in member lookup and constraint checks.
    @Theory
    @InlineData(false)
    @InlineData(true)
    func GSharpConsumer_RespectsImportedRelationshipAndConstraintNullability(useCSharpProducer bool) {
        let tempDir = Directory.CreateTempSubdirectory("gs_issue4996_consumer_").FullName
        try {
            let libraryPath = if useCSharpProducer {
                CompileCSharp(tempDir, RelationshipContractCSharpSource)
            } else {
                CompileGSharp(tempDir, RelationshipContractGSharpSource, "net10.0", List[string](), verify: true)
            }
            let valid = CompileConsumer(tempDir, libraryPath, ValidRelationshipConsumerSource)
            Assert.True(valid.ExitCode == 0, "valid consumer must compile:\n" + valid.Output)
            Assert.DoesNotContain("GS0536", valid.Output, StringComparison.Ordinal)
            {
                let consumerOut = Path.Combine(tempDir, "Consumer.dll")
                let coreDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
                using let mlc = MetadataLoadContext(
                    PathAssemblyResolver(
                        Directory.GetFiles(coreDir, "*.dll").Concat([]string{libraryPath, consumerOut})
                    ),
                    "System.Private.CoreLib"
                )
                let _ = mlc.LoadFromAssemblyPath(libraryPath)
                let consumerAssembly = mlc.LoadFromAssemblyPath(consumerOut)
                for implName in[]string{
                    "Consumer.ConcreteOuterImpl",
                    "Consumer.SymbolicOuterImpl",
                    "Consumer.NonGenericOuterImpl"
                } {
                    let implType = consumerAssembly.GetType(implName) ??
                        throw InvalidOperationException("missing $implName")
                    let rawInterfaces = implType.GetInterfaces()
                    let annotatedInterfaces = ClrNullability.GetInterfaceTypeSymbols(implType)
                    var foundInner = false
                    for var i = 0; i < rawInterfaces.Length; i++ {
                        if rawInterfaces[i].Name == "IInner`1" {
                            Assert.Equal("IInner[Token?]", Render(annotatedInterfaces[i], rawInterfaces[i]))
                            foundInner = true
                        }
                    }
                    Assert.True(foundInner, "expected IInner`1 in InterfaceImpl closure of $implName")
                }
            }
            let badBase = CompileConsumer(tempDir, libraryPath, InvalidBaseNullabilityConsumerSource)
            AssertRejectedWithDiagnostic(
                badBase,
                "GS0155",
                "consumer.gs(6,",
                "NullableTokenSub.Get() must return Token?"
            )
            let badConstraint = CompileConsumer(tempDir, libraryPath, InvalidConstraintNullabilityConsumerSource)
            AssertRejectedWithDiagnostic(
                badConstraint,
                "GS0152",
                "consumer.gs(5,",
                "RequireNullableEquatable must reject IEquatable[Token]"
            )
            let badLocalConstraint = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidLocalConstraintNullabilityConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badLocalConstraint,
                "GS0159",
                "consumer.gs(13,",
                "RequireNullableEquatable must reject consumer-local IEquatable[Token]"
            )
            let badDependentConstraint = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidDependentConstraintNullabilityConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badDependentConstraint,
                "GS0159",
                "consumer.gs(6,",
                "DependentEquatable must reject IEquatable[Token] when T = Token"
            )
            let badNotNullType = CompileConsumer(tempDir, libraryPath, InvalidNotNullTypeConsumerSource)
            AssertRejectedWithDiagnostic(
                badNotNullType,
                "GS0152",
                "consumer.gs(5,",
                "NotNullBox[string?] must violate T notnull"
            )
            let badNotNullValueType = CompileConsumer(tempDir, libraryPath, InvalidNotNullValueTypeConsumerSource)
            AssertRejectedWithDiagnostic(
                badNotNullValueType,
                "GS0152",
                "consumer.gs(5,",
                "NotNullBox[int32?] must violate T notnull"
            )
            let badNotNullMethod = CompileConsumer(tempDir, libraryPath, InvalidNotNullMethodConsumerSource)
            AssertRejectedWithDiagnostic(
                badNotNullMethod,
                "GS0159",
                "consumer.gs(6,",
                "TakeNotNull[string?] must violate T notnull"
            )
            let badClassType = CompileConsumer(tempDir, libraryPath, InvalidClassTypeConsumerSource)
            AssertRejectedWithDiagnostic(
                badClassType,
                "GS0152",
                "consumer.gs(5,",
                "ClassBox[string?] must violate T class"
            )
            let badClassMethod = CompileConsumer(tempDir, libraryPath, InvalidClassMethodConsumerSource)
            AssertRejectedWithDiagnostic(
                badClassMethod,
                "GS0159",
                "consumer.gs(6,",
                "TakeClass[string?] must violate T class"
            )
            let badForwardNotNull = CompileConsumer(tempDir, libraryPath, InvalidForwardNotNullConsumerSource)
            AssertRejectedWithDiagnostic(
                badForwardNotNull,
                "GS0580",
                "consumer.gs(5,",
                "unconstrained T must not forward T notnull"
            )
            let badForwardClass = CompileConsumer(tempDir, libraryPath, InvalidForwardClassConsumerSource)
            AssertRejectedWithDiagnostic(
                badForwardClass,
                "GS0580",
                "consumer.gs(5,",
                "T class? must not forward T class"
            )
            let badAdaptClass = CompileConsumer(tempDir, libraryPath, InvalidAdaptClassConsumerSource)
            AssertRejectedWithDiagnostic(
                badAdaptClass,
                "GS0606",
                "consumer.gs(12,",
                "adapt[IAdaptClass] must reject T class? source"
            )
            let badAdaptNullableClass = CompileConsumer(tempDir, libraryPath, InvalidAdaptNullableClassConsumerSource)
            AssertRejectedWithDiagnostic(
                badAdaptNullableClass,
                "GS0606",
                "consumer.gs(12,",
                "adapt[IAdaptNullableClass] must reject T class source"
            )
            let badAdaptNotNull = CompileConsumer(tempDir, libraryPath, InvalidAdaptNotNullConsumerSource)
            AssertRejectedWithDiagnostic(
                badAdaptNotNull,
                "GS0606",
                "consumer.gs(12,",
                "adapt[IAdaptNotNull] must reject unconstrained T source"
            )
            let badOpenGenericLocal = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidOpenGenericLocalConstraintNullabilityConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badOpenGenericLocal,
                "GS0159",
                "consumer.gs(13,",
                "TakeNullableEquatable must reject open-generic LocalGenericNonNullEq[T]"
            )
            let badCombinedDisposableNotNull = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidCombinedDisposableNotNullConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badCombinedDisposableNotNull,
                "GS0152",
                "consumer.gs(5,",
                "DisposableNotNullBox[DisposableImpl?] must violate T IDisposable notnull"
            )
            let badImportedAdaptConstraint = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidImportedAdaptConstraintNullabilityConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badImportedAdaptConstraint,
                "GS0606",
                "consumer.gs(6,",
                "adapt[IAdaptNullableEquatable] must reject imported IEquatable[Token] source"
            )
            let badForwardSortedDict = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidForwardSortedDictionaryNotNullConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badForwardSortedDict,
                "GS0580",
                "consumer.gs(6,",
                "SortedDictionary[T, int32] must reject unconstrained T"
            )
            let badForwardNullableDisposable = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidForwardNullableDisposableConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badForwardNullableDisposable,
                "GS0580",
                "consumer.gs(6,",
                "DisposableNotNullBox[T] must reject T IDisposable?"
            )
            let badLocalForwardNullableDisposable = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidLocalForwardNullableDisposableConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badLocalForwardNullableDisposable,
                "GS0580",
                "consumer.gs(7,",
                "LocalDisposableBox[T] must reject T IDisposable? class?"
            )
            let badErasedDependentConstraint = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidErasedDependentConstraintNullabilityConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badErasedDependentConstraint,
                "GS0159",
                "consumer.gs(15,",
                "DependentEquatable must reject IEquatable[LocalItem] when T = LocalItem"
            )
            let badOpenGenericDependentConstraint = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidOpenGenericDependentConstraintNullabilityConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badOpenGenericDependentConstraint,
                "GS0159",
                "consumer.gs(13,",
                "DependentEquatable must reject open-generic LocalGenericSelfEq[T] when T class"
            )
            let badNullableRootAdaptConstraint = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidImportedNullableRootAdaptConstraintNullabilityConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badNullableRootAdaptConstraint,
                "GS0606",
                "consumer.gs(6,",
                "adapt[IAdaptNullableRootEquatable] must reject imported IEquatable[Token]? source"
            )
            let badLeakNullableBase = CompileConsumer(tempDir, libraryPath, InvalidLeakNullableBaseConsumerSource)
            AssertRejectedWithDiagnostic(
                badLeakNullableBase,
                "GS0155",
                "consumer.gs(8,",
                "[T LocalBase?] must not implicitly convert to non-null LocalBase"
            )
            let badLeakNullableInterface = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidLeakNullableInterfaceConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badLeakNullableInterface,
                "GS0155",
                "consumer.gs(6,",
                "[T ILocalMarker?] must not implicitly convert to non-null ILocalMarker"
            )
            let badUncheckedBaseRead = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidUncheckedNullableBaseReadConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badUncheckedBaseRead,
                "GS0158",
                "consumer.gs(8,",
                "unchecked field read on [T LocalBase?] must report GS0158"
            )
            let badUncheckedBaseWrite = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidUncheckedNullableBaseWriteConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badUncheckedBaseWrite,
                "GS0158",
                "consumer.gs(8,",
                "unchecked field write on [T LocalBase?] must report GS0158"
            )
            let badUncheckedInterfaceCall = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidUncheckedNullableInterfaceCallConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badUncheckedInterfaceCall,
                "GS0159",
                "consumer.gs(8,",
                "unchecked method call on [T ILocalMarker?] must report GS0159"
            )
            let badLeakNullableBaseToObject = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidLeakNullableBaseToObjectConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badLeakNullableBaseToObject,
                "GS0155",
                "consumer.gs(8,",
                "[T LocalBase?] must not implicitly convert to non-null object"
            )
            let badForwardedObjectCall = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidUncheckedForwardedObjectCallConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badForwardedObjectCall,
                "GS0159",
                "consumer.gs(4,",
                "unchecked GetHashCode() on [A class?, B A] must report GS0159"
            )
            let badNestedAssignBaseRead = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidNestedAssignmentNullableBaseReadConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badNestedAssignBaseRead,
                "GS0158",
                "consumer.gs(11,",
                "nested assignment x = (y = z) on [T LocalBase?] must not prove x non-null"
            )
            let badNullableRootEquatableConversion = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidNullableRootEquatableConversionConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badNullableRootEquatableConversion,
                "GS0156",
                "consumer.gs(7,",
                "[T IEquatable[Token]?] must not implicitly convert to IEquatable[Token?]?"
            )
            let badForwardNullableDepBase = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidForwardNullableDependentBaseConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badForwardNullableDepBase,
                "GS0580",
                "consumer.gs(9,",
                "[A LocalBase, B A?] must not satisfy non-null LocalBaseBox[B]"
            )
            let badForwardNullableDepIface = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidForwardNullableDependentInterfaceConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badForwardNullableDepIface,
                "GS0580",
                "consumer.gs(7,",
                "[A ILocalMarker, B A?] must not satisfy non-null LocalMarkerBox[B]"
            )
            let badForwardNullableDepClrIface = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidForwardNullableDependentClrInterfaceConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badForwardNullableDepClrIface,
                "GS0580",
                "consumer.gs(6,",
                "[A IDisposable, B A?] must not satisfy non-null DisposableNotNullBox[B]"
            )
            let badReceiverInnerMismatch = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidReceiverDependentMethodConstraintConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badReceiverInnerMismatch,
                "GS0159",
                "consumer.gs(6,",
                "ReceiverBox[Token?]().AcceptInner[IInner[Token]]() must report GS0159"
            )
            let badNonGenericDerivedReceiverMismatch = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidNonGenericDerivedReceiverMethodConstraintConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badNonGenericDerivedReceiverMismatch,
                "GS0159",
                "consumer.gs(6,",
                "NonGenericReceiverSub().AcceptInner[IInner[Token]]() must report GS0159"
            )
            let badGenericDerivedReceiverMismatch = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidGenericDerivedReceiverMethodConstraintConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badGenericDerivedReceiverMismatch,
                "GS0159",
                "consumer.gs(6,",
                "GenericReceiverSub[int32]().AcceptInner[IInner[Token]]() must report GS0159"
            )
        } finally {
            TryDelete(tempDir)
        }
    }

    @Fact
    func TypeParameterSyntax_EnforcesPartialMethodConsistencyAndDictionaryNotNullMetadata() {
        let dictParams = typeof(Dictionary[_, _]).GetGenericArguments()
        Assert.True(ClrNullability.HasNotNullConstraint(dictParams[0]))
        Assert.False(ClrNullability.HasNotNullConstraint(dictParams[1]))

        let nullableClassBoundTp = TypeParameterSymbol(
            "TNullableBase",
            0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None
        ){ClassConstraint = NullableTypeSymbol.Get(TypeSymbol.String)}
        let forwardedNullableClassBoundTp = TypeParameterSymbol(
            "TForwarded",
            1,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None
        ){TypeParameterBound = nullableClassBoundTp}
        let nonNullClassBoundTp = TypeParameterSymbol(
            "TNonNullBase",
            0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None
        ){ClassConstraint = TypeSymbol.String}
        Assert.False(GSharp.Core.CodeAnalysis.Binding.Binder.SatisfiesNotNullConstraint(nullableClassBoundTp))
        Assert.False(GSharp.Core.CodeAnalysis.Binding.Binder.SatisfiesNotNullConstraint(forwardedNullableClassBoundTp))
        Assert.True(GSharp.Core.CodeAnalysis.Binding.Binder.SatisfiesNotNullConstraint(nonNullClassBoundTp))

        let tempDir = Directory.CreateTempSubdirectory("gs_issue4996_partial_").FullName
        try {
            let libraryPath = CompileGSharp(
                tempDir,
                RelationshipContractGSharpSource,
                "net10.0",
                List[string](),
                verify: false
            )
            let validComparable = CompileConsumer(tempDir, libraryPath, ValidCrossAssemblyComparableConsumerSource)
            Assert.True(
                validComparable.ExitCode == 0,
                "cross-assembly [T comparable] must accept nullable comparable types:\n" + validComparable.Output
            )
            let closureSrcPath = Path.Combine(tempDir, "closure_order.gs")
            let closureDllPath = Path.Combine(tempDir, "ClosureOrder.dll")
            File.WriteAllText(closureSrcPath, ValidInterfaceClosureOrderConsumerSource)
            let (closureExit, closureOut) = RunDriver(
                List[string]{
                    "/out:" + closureDllPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    "/reference:" + libraryPath,
                    closureSrcPath
                }
            )
            Assert.True(closureExit == 0, "closure order consumer must compile:\n" + closureOut)
            let coreDir = Path.GetDirectoryName(typeof(object).Assembly.Location) ??
                throw InvalidOperationException("host runtime directory")
            using let closureCtx = MetadataLoadContext(
                PathAssemblyResolver(
                    Directory.GetFiles(coreDir, "*.dll").Concat([]string{libraryPath, closureDllPath})
                ),
                "System.Private.CoreLib"
            )
            let closureAssembly = closureCtx.LoadFromAssemblyPath(closureDllPath)
            let derivedFirst = closureAssembly.GetType("Consumer.DerivedThenNullable") ??
                throw InvalidOperationException("DerivedThenNullable not found")
            let nullableFirst = closureAssembly.GetType("Consumer.NullableThenDerived") ??
                throw InvalidOperationException("NullableThenDerived not found")
            let derivedFirstInner = ClrNullability.GetInterfaceTypeSymbols(derivedFirst).Single(
                (s TypeSymbol) -> s.ClrType?.Name == "IInner`1"
            )
            let nullableFirstInner = ClrNullability.GetInterfaceTypeSymbols(nullableFirst).Single(
                (s TypeSymbol) -> s.ClrType?.Name == "IInner`1"
            )
            Assert.Equal("IInner[Token?]", Render(derivedFirstInner, derivedFirstInner.ClrType!!))
            Assert.Equal("IInner[Token?]", Render(nullableFirstInner, nullableFirstInner.ClrType!!))
            let forwardSourceSub = closureAssembly.GetType("Consumer.ForwardSourceInterfaceSub") ??
                throw InvalidOperationException("ForwardSourceInterfaceSub not found")
            let forwardSourceMethod = forwardSourceSub.GetMethods(AllMembers).Single(
                (m MethodInfo) -> m.IsGenericMethodDefinition && m.Name.StartsWith("<>n__", StringComparison.Ordinal)
            )
            let forwardSourceParam = forwardSourceMethod.GetGenericArguments().Single()
            let forwardSourceConstraint = ClrNullability.GetGenericParameterConstraintTypeSymbols(forwardSourceParam)
                .Single()
            Assert.Equal(
                ReferenceNullabilityKind.Nullable,
                ClrNullability.GetGenericParameterTypeSymbol(forwardSourceParam).ReferenceNullability
            )
            Assert.Equal(ReferenceNullabilityKind.Nullable, forwardSourceConstraint.ReferenceNullability)
            let forwardClrSub = closureAssembly.GetType("Consumer.ForwardClrInterfaceSub") ??
                throw InvalidOperationException("ForwardClrInterfaceSub not found")
            let forwardClrMethod = forwardClrSub.GetMethods(AllMembers).Single(
                (m MethodInfo) -> m.IsGenericMethodDefinition && m.Name.StartsWith("<>n__", StringComparison.Ordinal)
            )
            let forwardClrParam = forwardClrMethod.GetGenericArguments().Single()
            let forwardClrConstraint = ClrNullability.GetGenericParameterConstraintTypeSymbols(forwardClrParam).Single()
            Assert.Equal(
                ReferenceNullabilityKind.Nullable,
                ClrNullability.GetGenericParameterTypeSymbol(forwardClrParam).ReferenceNullability
            )
            Assert.Equal(ReferenceNullabilityKind.Nullable, forwardClrConstraint.ReferenceNullability)
            let corruptedDllPath = Path.Combine(tempDir, "CorruptedClosureOrder.dll")
            let closureBytes = File.ReadAllBytes(closureDllPath)
            let needle = []uint8{
                uint8(1),
                uint8(0),
                uint8(2),
                uint8(0),
                uint8(0),
                uint8(0),
                uint8(12),
                uint8('C'),
                uint8('o'),
                uint8('r'),
                uint8('r'),
                uint8('u'),
                uint8('p'),
                uint8('t'),
                uint8('F'),
                uint8('i'),
                uint8('r'),
                uint8('s'),
                uint8('t')
            }
            let needleOffset = closureBytes.AsSpan().IndexOf(needle)
            Assert.True(needleOffset >= 0, "expected TupleElementNamesAttribute blob in ClosureOrder.dll")
            closureBytes[needleOffset + 6] = uint8(120)
            File.WriteAllBytes(corruptedDllPath, closureBytes)
            using let corruptedCtx = MetadataLoadContext(
                PathAssemblyResolver(
                    Directory.GetFiles(coreDir, "*.dll").Concat([]string{libraryPath, corruptedDllPath})
                ),
                "System.Private.CoreLib"
            )
            let corruptedAssembly = corruptedCtx.LoadFromAssemblyPath(corruptedDllPath)
            let corruptedTupleImpl = corruptedAssembly.GetType("Consumer.TupleNamesImpl") ??
                throw InvalidOperationException("TupleNamesImpl not found")
            let corruptedInner = ClrNullability.GetInterfaceTypeSymbols(corruptedTupleImpl).Single(
                (s TypeSymbol) -> s.ClrType?.Name == "IInner`1"
            )
            Assert.Equal("IInner[(Token?, int32)]", Render(corruptedInner, corruptedInner.ClrType!!))
            let badForwardUnconstrainedToObject = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidForwardUnconstrainedToObjectConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badForwardUnconstrainedToObject,
                "GS0580",
                "consumer.gs(5,",
                "unconstrained T must not forward [U object]"
            )
            let badLocalDispClassQuestion = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidLocalDisposableClassQuestionConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badLocalDispClassQuestion,
                "GS0152",
                "consumer.gs(11,",
                "local [T IDisposable class?] must reject DisposableImpl?"
            )
            let badImportedDispClassQuestion = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidCrossAssemblyDisposableClassQuestionConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badImportedDispClassQuestion,
                "GS0159",
                "consumer.gs(6,",
                "imported [T IDisposable class?] must reject DisposableImpl?"
            )
            let badLocalDepNotNull = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidLocalDependentNotNullNullableValueConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badLocalDepNotNull,
                "GS0152",
                "consumer.gs(8,",
                "local [A notnull, B A] must reject A = object, B = int32?"
            )
            let badImportedDepNotNull = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidCrossAssemblyDependentNotNullNullableValueConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badImportedDepNotNull,
                "GS0159",
                "consumer.gs(6,",
                "imported [A notnull, B A] must reject A = object, B = int32?"
            )
            let badPartialNotNull = CompileConsumer(tempDir, libraryPath, InvalidPartialNotNullConsumerSource)
            AssertRejectedWithDiagnostic(
                badPartialNotNull,
                "GS0611",
                "consumer.gs(8,",
                "partial method mismatch on [T] vs [T notnull] must report GS0611"
            )
            let badPartialClassQuestion = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidPartialClassQuestionConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badPartialClassQuestion,
                "GS0611",
                "consumer.gs(8,",
                "partial method mismatch on [T class] vs [T class?] must report GS0611"
            )
            let badPartialDepNullable = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidPartialDependentNullableBoundConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badPartialDepNullable,
                "GS0611",
                "consumer.gs(8,",
                "partial method mismatch on [A class, B A] vs [A class, B A?] must report GS0611"
            )
            let badClassThenClassQuestion = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidClassThenClassQuestionConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badClassThenClassQuestion,
                "GS0361",
                "consumer.gs(3,18,",
                "[T class class?] must report GS0361 at the conflicting constraint"
            )
            Assert.DoesNotContain("GS0005", badClassThenClassQuestion.Output)
            let badClassQuestionThenClass = CompileConsumer(
                tempDir,
                libraryPath,
                InvalidClassQuestionThenClassConsumerSource
            )
            AssertRejectedWithDiagnostic(
                badClassQuestionThenClass,
                "GS0361",
                "consumer.gs(3,19,",
                "[T class? class] must report GS0361 at the conflicting constraint"
            )
            Assert.DoesNotContain("GS0005", badClassQuestionThenClass.Output)
        } finally {
            TryDelete(tempDir)
        }
    }

    /// Emit stays byte-for-byte reproducible with every signature routed
    /// through the plan.
    @Fact
    func ProducerEmit_IsDeterministic() {
        let tempDir = Directory.CreateTempSubdirectory("gs_issue4988_det_").FullName
        try {
            let source = BuildGSharpProducer(true)
            let first = File.ReadAllBytes(
                CompileGSharp(Path.Combine(tempDir, "a"), source, "net10.0", List[string](), verify: false)
            )
            let second = File.ReadAllBytes(
                CompileGSharp(Path.Combine(tempDir, "b"), source, "net10.0", List[string](), verify: false)
            )
            Assert.Equal(first, second)
        } finally {
            TryDelete(tempDir)
        }
    }

    shared {
        private let AllMembers BindingFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly

        private let Shapes[]Issue4988Shape = []Issue4988Shape{
            Issue4988Shape("Token?", "Token?"),
            Issue4988Shape("Task[Token?]", "Task<Token?>"),
            Issue4988Shape("[]Token?", "Token?[]"),
            Issue4988Shape("[]?Token", "Token[]?"),
            Issue4988Shape("Dictionary[string, Token?]", "Dictionary<string, Token?>"),
            Issue4988Shape("Task[List[Token?]]", "Task<List<Token?>>"),
            Issue4988Shape("int32?", "int?"),
            Issue4988Shape("(Token?, int32)", "(Token?, int)"),
            Issue4988Shape("KeyValuePair[string, Token?]", "KeyValuePair<string, Token?>"),
            Issue4988Shape("Token", "Token"),
            Issue4988Shape("List[Token?]?", "List<Token?>?"),
            Issue4988Shape("string", "string")
        }

        private func IsTaskShape(shape Issue4988Shape) bool -> shape.GSharp.StartsWith(
            "Task[",
            StringComparison.Ordinal
        )

        private func BuildGSharpProducer(includeModernOnlyKinds bool) string {
            let g = StringBuilder()
            g.AppendLine("package Matrix")
            g.AppendLine()
            g.AppendLine("import System")
            g.AppendLine("import System.Collections.Generic")
            g.AppendLine("import System.Threading.Tasks")
            g.AppendLine()
            g.AppendLine("class Token {}")
            g.AppendLine("open class BaseGeneric[T] {}")
            g.AppendLine("interface IGeneric[T] {}")
            g.AppendLine()
            g.AppendLine("interface IFace {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].GSharp
                g.AppendLine("    func Abs$i(p $t) $t;")
                g.AppendLine("    func Dim$i(p $t) $t { return p }")
                g.AppendLine("    prop Prop$i $t { get; set; }")
                g.AppendLine("    event Ev$i Action[$t]")
                g.AppendLine("    func Constrained$i[T IGeneric[$t]](p T) T;")
            }
            g.AppendLine("    func Gen[T](p T) T;")
            g.AppendLine("    func GenClass[T class](p T?) T?;")
            g.AppendLine("    func GenClassNullable[T class?](p T?) T?;")
            g.AppendLine("    func GenNotNull[T notnull](p T) T;")
            g.AppendLine("    func GenStruct[T struct](p T?) T?;")
            g.AppendLine("    prop this[key string?] Task[Token?] { get; }")
            g.AppendLine("}")
            g.AppendLine()
            g.AppendLine("sealed interface IStatic[TSelf] {")
            g.AppendLine("    shared {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].GSharp
                g.AppendLine("        func Sva$i(p $t) $t;")
                g.AppendLine("        func SvaDefault$i(p $t) $t { return p }")
            }
            g.AppendLine("    }")
            g.AppendLine("}")
            g.AppendLine()
            g.AppendLine("open class Base {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].GSharp
                g.AppendLine("    open func Abs$i(p $t) $t;")
                g.AppendLine("    open func Virt$i(p $t) $t { return p }")
            }
            g.AppendLine("}")
            g.AppendLine()
            g.AppendLine("class Impl {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].GSharp
                g.AppendLine("    var Field$i $t")
                g.AppendLine("    prop Auto$i $t { get; set; }")
                g.AppendLine("    event Ev$i Action[$t]")
                g.AppendLine("    func Method$i(p $t) $t { return p }")
                g.AppendLine("    func Constrained$i[T IGeneric[$t]](p T) T { return p }")
                if !IsTaskShape(Shapes[i]) {
                    g.AppendLine("    async func Async$i(p $t) $t { return p }")
                }
            }
            g.AppendLine("    func MethodGen[T](p T) T { return p }")
            g.AppendLine("    func MethodClass[T class](p T?) T? { return p }")
            g.AppendLine("    func MethodClassNullable[T class?](p T?) T? { return p }")
            g.AppendLine("    func MethodNotNull[T notnull](p T) T { return p }")
            g.AppendLine("    func MethodStruct[T struct](p T?) T? { return p }")
            g.AppendLine("    shared {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].GSharp
                g.AppendLine("        func Static$i(p $t) $t { return p }")
                g.AppendLine("        prop StaticAuto$i $t { get; set; }")
            }
            g.AppendLine("    }")
            g.AppendLine("}")
            g.AppendLine()
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].GSharp
                g.AppendLine("delegate Del$i(p $t) $t;")
                g.AppendLine("class Ctor$i {")
                g.AppendLine("    init(p $t) {")
                g.AppendLine("    }")
                g.AppendLine("}")
                g.AppendLine("class Conv$i {}")
                g.AppendLine("func operator explicit(value $t) Conv$i { return Conv$i() }")
                g.AppendLine("func (t Token) Ext$i(p $t) $t { return p }")
                g.AppendLine("class BaseSub$i : BaseGeneric[$t] {}")
                g.AppendLine("class IfaceImpl$i : IGeneric[$t] {}")
                g.AppendLine("interface IfaceSub$i : IGeneric[$t] {}")
                g.AppendLine("class ConstrainedType$i[T IGeneric[$t]] {}")
                if includeModernOnlyKinds {
                    g.AppendLine("inline struct Inl$i(V $t)")
                }
                if includeModernOnlyKinds {
                    g.AppendLine("data class Rec$i(V $t)")
                }
            }
            g.AppendLine()
            g.AppendLine("class UnconstrainedParam[T] {}")
            g.AppendLine("class ClassParam[T class] {}")
            g.AppendLine("class NullableClassParam[T class?] {}")
            g.AppendLine("class NotNullParam[T notnull] {}")
            g.AppendLine("class StructParam[T struct] {}")
            g.AppendLine("class NullableBaseParam[T BaseGeneric[Token]?] {}")
            g.AppendLine("class NullableIfaceParam[T IGeneric[Token]?] {}")
            g.AppendLine()
            g.AppendLine("partial class Part {")
            g.AppendLine("    partial func Declared(x Token?) Task[Token?];")
            g.AppendLine("}")
            g.AppendLine("partial class Part {")
            g.AppendLine("    partial func Declared(x Token?) Task[Token?] { return Task.FromResult[Token?](x) }")
            g.AppendLine("}")
            g.AppendLine()
            if includeModernOnlyKinds {
                g.AppendLine("data class GenRec[T](V T)")
            }
            g.AppendLine("class Obl {")
            g.AppendLine("    @Oblivious func ObliviousMethod(p string) string { return p }")
            g.AppendLine("    @Oblivious prop ObliviousProp string { get; set; }")
            g.AppendLine("}")
            return g.ToString()
        }

        private func BuildCSharpTwin(includeModernOnlyKinds bool) string {
            let c = StringBuilder()
            c.AppendLine("#nullable enable")
            c.AppendLine("using System;")
            c.AppendLine("using System.Collections.Generic;")
            c.AppendLine("using System.Threading.Tasks;")
            c.AppendLine("namespace Matrix;")
            c.AppendLine("public class Token {}")
            c.AppendLine("public class BaseGeneric<T> { public Token Anchor = default!; }")
            c.AppendLine("public interface IGeneric<T> {}")
            c.AppendLine("public interface IFace {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].CSharp
                c.AppendLine("    $t Abs$i($t p);")
                c.AppendLine("    $t Dim$i($t p) { return p; }")
                c.AppendLine("    $t Prop$i { get; set; }")
                c.AppendLine("    event Action<$t> Ev$i;")
                c.AppendLine("    T Constrained$i<T>(T p) where T : IGeneric<$t>;")
            }
            c.AppendLine("    T Gen<T>(T p);")
            c.AppendLine("    T? GenClass<T>(T? p) where T : class;")
            c.AppendLine("    T? GenClassNullable<T>(T? p) where T : class?;")
            c.AppendLine("    T GenNotNull<T>(T p) where T : notnull;")
            c.AppendLine("    T? GenStruct<T>(T? p) where T : struct;")
            c.AppendLine("    Task<Token?> this[string? key] { get; }")
            c.AppendLine("}")
            c.AppendLine("public interface IStatic<TSelf> {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].CSharp
                c.AppendLine("    static abstract $t Sva$i($t p);")
                c.AppendLine("    static virtual $t SvaDefault$i($t p) { return p; }")
            }
            c.AppendLine("}")
            c.AppendLine("public abstract class Base {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].CSharp
                c.AppendLine("    public abstract $t Abs$i($t p);")
                c.AppendLine("    public virtual $t Virt$i($t p) { return p; }")
            }
            c.AppendLine("}")
            c.AppendLine("public class Impl {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].CSharp
                c.AppendLine("    public $t Field$i = default!;")
                c.AppendLine("    public $t Auto$i { get; set; } = default!;")
                c.AppendLine("    public event Action<$t> Ev$i = default!;")
                c.AppendLine("    public $t Method$i($t p) { return p; }")
                c.AppendLine("    public T Constrained$i<T>(T p) where T : IGeneric<$t> { return p; }")
                if !IsTaskShape(Shapes[i]) {
                    c.AppendLine("    public async Task<$t> Async$i($t p) { await Task.Yield(); return p; }")
                }
                c.AppendLine("    public static $t Static$i($t p) { return p; }")
                c.AppendLine("    public static $t StaticAuto$i { get; set; } = default!;")
            }
            c.AppendLine("    public T MethodGen<T>(T p) { return p; }")
            c.AppendLine("    public T? MethodClass<T>(T? p) where T : class { return p; }")
            c.AppendLine("    public T? MethodClassNullable<T>(T? p) where T : class? { return p; }")
            c.AppendLine("    public T MethodNotNull<T>(T p) where T : notnull { return p; }")
            c.AppendLine("    public T? MethodStruct<T>(T? p) where T : struct { return p; }")
            c.AppendLine("}")
            c.AppendLine("public static class Program {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].CSharp
                c.AppendLine("    public static $t Ext$i(this Token t, $t p) { return p; }")
            }
            c.AppendLine("}")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].CSharp
                c.AppendLine("public delegate $t Del$i($t p);")
                c.AppendLine("public class Ctor$i { public Ctor$i($t p) {} }")
                c.AppendLine(
                    "public class Conv$i { public static explicit operator Conv$i($t value) { return new Conv$i(); } }"
                )
                c.AppendLine(
                    "public class BaseSub$i : BaseGeneric<$t> { public Token A = default!; public Token B = default!; }"
                )
                c.AppendLine(
                    "public class IfaceImpl$i : IGeneric<$t> { public Token A = default!; public Token B = default!; }"
                )
                c.AppendLine("public interface IfaceSub$i : IGeneric<$t> { Token A { get; } Token B { get; } }")
                c.AppendLine(
                    "public class ConstrainedType$i<T> where T : IGeneric<$t> { public Token A = default!; public Token B = default!; }"
                )
                if includeModernOnlyKinds {
                    c.AppendLine(
                        "public struct Inl$i { public readonly $t V; public Inl$i($t V) { this.V = V; } " +
                            "public void Deconstruct(out $t V) { V = this.V; } " +
                            "public override bool Equals(object? obj) { return false; } " +
                            "public override int GetHashCode() { return 0; } }"
                    )
                }
                if includeModernOnlyKinds {
                    c.AppendLine("public record class Rec$i($t V);")
                }
            }
            c.AppendLine("public class UnconstrainedParam<T> { public Token A = default!; public Token B = default!; }")
            c.AppendLine(
                "public class ClassParam<T> where T : class { public Token A = default!; public Token B = default!; }"
            )
            c.AppendLine(
                "public class NullableClassParam<T> where T : class? { public Token A = default!; public Token B = default!; }"
            )
            c.AppendLine(
                "public class NotNullParam<T> where T : notnull { public Token A = default!; public Token B = default!; }"
            )
            c.AppendLine(
                "public class StructParam<T> where T : struct { public Token A = default!; public Token B = default!; }"
            )
            c.AppendLine(
                "public class NullableBaseParam<T> where T : BaseGeneric<Token>? { public Token A = default!; public Token B = default!; }"
            )
            c.AppendLine(
                "public class NullableIfaceParam<T> where T : IGeneric<Token>? { public Token A = default!; public Token B = default!; }"
            )
            c.AppendLine("public partial class Part {")
            c.AppendLine("    public partial Task<Token?> Declared(Token? x);")
            c.AppendLine("}")
            c.AppendLine("public partial class Part {")
            c.AppendLine("    public partial Task<Token?> Declared(Token? x) { return Task.FromResult<Token?>(x); }")
            c.AppendLine("}")
            if includeModernOnlyKinds {
                c.AppendLine("public record class GenRec<T>(T V);")
            }
            c.AppendLine("public class Obl {")
            c.AppendLine("#nullable disable")
            c.AppendLine("    public string ObliviousMethod(string p) { return p; }")
            c.AppendLine("    public string ObliviousProp { get; set; }")
            c.AppendLine("#nullable enable")
            c.AppendLine("}")
            return c.ToString()
        }

        private func BuildPositions(includeModernOnlyKinds bool) List[Issue4988Position] {
            let positions = List[Issue4988Position]()
            let AddChecked = func (
                typeName string,
                kind Issue4988PositionKind,
                member string,
                index int32,
                selector string?,
                expected string,
                expectedBytes string?
            ) {
                let slot = switch kind {
                    case Issue4988PositionKind.Return: "ret"
                    case Issue4988PositionKind.Parameter: "p$index"
                    default: "${kind}"
                }
                positions.Add(
                    Issue4988Position(
                        "$typeName.$member[$slot]",
                        typeName,
                        kind,
                        member,
                        index,
                        selector,
                        expected,
                        expectedBytes
                    )
                )
            }
            let Add = func (
                typeName string,
                kind Issue4988PositionKind,
                member string,
                index int32,
                selector string?,
                expected string
            ) {
                AddChecked(typeName, kind, member, index, selector, expected, nil)
            }
            let AddMethod = func (
                typeName string,
                member string,
                parameterIndex int32,
                returned string,
                parameter string
            ) {
                Add(typeName, Issue4988PositionKind.Return, member, -1, nil, returned)
                Add(typeName, Issue4988PositionKind.Parameter, member, parameterIndex, nil, parameter)
            }
            let AddProperty = func (typeName string, name string, type string) {
                Add(typeName, Issue4988PositionKind.Property, name, -1, nil, type)
                Add(typeName, Issue4988PositionKind.Return, "get_$name", -1, nil, type)
                Add(typeName, Issue4988PositionKind.Parameter, "set_$name", 0, nil, type)
            }
            let AddEvent = func (typeName string, name string, handler string) {
                Add(typeName, Issue4988PositionKind.Event, name, -1, nil, handler)
                Add(typeName, Issue4988PositionKind.Parameter, "add_$name", 0, nil, handler)
                Add(typeName, Issue4988PositionKind.Parameter, "remove_$name", 0, nil, handler)
            }
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].GSharp
                let handler = "Action[$t]"
                AddMethod("IFace", "Abs$i", 0, t, t)
                AddMethod("IFace", "Dim$i", 0, t, t)
                AddProperty("IFace", "Prop$i", t)
                AddEvent("IFace", "Ev$i", handler)
                AddMethod("IStatic`1", "Sva$i", 0, t, t)
                AddMethod("IStatic`1", "SvaDefault$i", 0, t, t)
                AddMethod("Base", "Abs$i", 0, t, t)
                AddMethod("Base", "Virt$i", 0, t, t)
                Add("Impl", Issue4988PositionKind.Field, "Field$i", -1, nil, t)
                AddProperty("Impl", "Auto$i", t)
                Add("Impl", Issue4988PositionKind.Field, "<Auto$i>k__BackingField", -1, nil, t)
                AddEvent("Impl", "Ev$i", handler)
                Add("Impl", Issue4988PositionKind.Field, "Ev$i", -1, nil, handler)
                AddMethod("Impl", "Method$i", 0, t, t)
                if !IsTaskShape(Shapes[i]) {
                    AddMethod("Impl", "Async$i", 0, "Task[$t]", t)
                }
                AddMethod("Impl", "Static$i", 0, t, t)
                AddProperty("Impl", "StaticAuto$i", t)
                AddMethod("Del$i", "Invoke", 0, t, t)
                Add("Ctor$i", Issue4988PositionKind.Parameter, ".ctor", 0, "p", t)
                // gsc hosts a conversion on a source type it involves, which for
                // `Token` is `Token`; csc on the declaring class. Find it anywhere.
                Add("*", Issue4988PositionKind.Return, "op_Explicit", -1, "Conv$i", "Conv$i")
                Add("*", Issue4988PositionKind.Parameter, "op_Explicit", 0, "Conv$i", t)
                AddMethod("*", "Ext$i", 1, t, t)
                Add("BaseSub$i", Issue4988PositionKind.BaseType, ".base", -1, nil, "BaseGeneric[$t]")
                Add("IfaceImpl$i", Issue4988PositionKind.InterfaceImpl, "IGeneric`1", 0, nil, "IGeneric[$t]")
                Add("IfaceSub$i", Issue4988PositionKind.InterfaceImpl, "IGeneric`1", 0, nil, "IGeneric[$t]")
                Add("ConstrainedType$i`1", Issue4988PositionKind.GenericParamConstraint, "T", 0, nil, "IGeneric[$t]")
                Add("IFace", Issue4988PositionKind.GenericParamConstraint, "Constrained$i", 0, nil, "IGeneric[$t]")
                Add("Impl", Issue4988PositionKind.GenericParamConstraint, "Constrained$i", 0, nil, "IGeneric[$t]")
                if includeModernOnlyKinds {
                    let inline = "Inl$i"
                    Add(inline, Issue4988PositionKind.Parameter, ".ctor", 0, "V", t)
                    Add(inline, Issue4988PositionKind.Field, "V", -1, nil, t)
                    Add(inline, Issue4988PositionKind.Parameter, "Deconstruct", 0, nil, t)
                    Add(inline, Issue4988PositionKind.Parameter, "Equals", 0, "Object", "object?")
                }
                if includeModernOnlyKinds {
                    let record = "Rec$i"
                    Add(record, Issue4988PositionKind.Parameter, ".ctor", 0, "V", t)
                    AddProperty(record, "V", t)
                    Add(record, Issue4988PositionKind.Parameter, "Deconstruct", 0, nil, t)
                    Add(record, Issue4988PositionKind.Parameter, "op_Equality", 0, nil, "$record?")
                    Add(record, Issue4988PositionKind.Parameter, "op_Equality", 1, nil, "$record?")
                    Add(record, Issue4988PositionKind.Parameter, "op_Inequality", 0, nil, "$record?")
                    Add(record, Issue4988PositionKind.Parameter, "op_Inequality", 1, nil, "$record?")
                }
            }
            AddMethod("IFace", "Gen", 0, "T", "T")
            AddMethod("IFace", "GenClass", 0, "T?", "T?")
            AddMethod("IFace", "GenClassNullable", 0, "T?", "T?")
            AddMethod("IFace", "GenNotNull", 0, "T", "T")
            AddMethod("IFace", "GenStruct", 0, "T?", "T?")
            AddMethod("Impl", "MethodGen", 0, "T", "T")
            Add("UnconstrainedParam`1", Issue4988PositionKind.GenericParam, "T", 0, nil, "T?")
            Add("ClassParam`1", Issue4988PositionKind.GenericParam, "T", 0, nil, "T")
            Add("NullableClassParam`1", Issue4988PositionKind.GenericParam, "T", 0, nil, "T?")
            Add("NotNullParam`1", Issue4988PositionKind.GenericParam, "T", 0, nil, "T")
            Add("StructParam`1", Issue4988PositionKind.GenericParam, "T", 0, nil, "T")
            AddChecked("NullableBaseParam`1", Issue4988PositionKind.GenericParam, "T", 0, nil, "T?", "2")
            AddChecked("NullableIfaceParam`1", Issue4988PositionKind.GenericParam, "T", 0, nil, "T?", "2")
            Add("IFace", Issue4988PositionKind.GenericParam, "Gen", 0, nil, "T?")
            Add("IFace", Issue4988PositionKind.GenericParam, "GenClass", 0, nil, "T")
            Add("IFace", Issue4988PositionKind.GenericParam, "GenClassNullable", 0, nil, "T?")
            Add("IFace", Issue4988PositionKind.GenericParam, "GenNotNull", 0, nil, "T")
            Add("IFace", Issue4988PositionKind.GenericParam, "GenStruct", 0, nil, "T")
            Add("Impl", Issue4988PositionKind.GenericParam, "MethodGen", 0, nil, "T?")
            Add("Impl", Issue4988PositionKind.GenericParam, "MethodClass", 0, nil, "T")
            Add("Impl", Issue4988PositionKind.GenericParam, "MethodClassNullable", 0, nil, "T?")
            Add("Impl", Issue4988PositionKind.GenericParam, "MethodNotNull", 0, nil, "T")
            Add("Impl", Issue4988PositionKind.GenericParam, "MethodStruct", 0, nil, "T")
            Add("IFace", Issue4988PositionKind.Property, "Item", -1, nil, "Task[Token?]")
            AddMethod("IFace", "get_Item", 0, "Task[Token?]", "string?")
            AddMethod("Part", "Declared", 0, "Task[Token?]", "Token?")
            if includeModernOnlyKinds {
                // A generic data class's synthesized members refer to the open
                // type itself: its `T` slot must stay `T` under the `?`.
                let generic = "GenRec`1"
                Add(generic, Issue4988PositionKind.Parameter, ".ctor", 0, "V", "T")
                AddProperty(generic, "V", "T")
                Add(generic, Issue4988PositionKind.Parameter, "Deconstruct", 0, nil, "T")
                // csc builds a record's own type for these members with
                // oblivious type arguments, so its bytes read `[2, 0]`. The
                // declared `T` is `1`, which gsc emits (and already emitted for
                // `Equals` before #4988), so the bytes are pinned here instead.
                AddChecked(generic, Issue4988PositionKind.Parameter, "Equals", 0, "GenRec`1", "GenRec[T]?", "2,1")
                for operatorName in[]string{"op_Equality", "op_Inequality"} {
                    AddChecked(generic, Issue4988PositionKind.Parameter, operatorName, 0, nil, "GenRec[T]?", "2,1")
                    AddChecked(generic, Issue4988PositionKind.Parameter, operatorName, 1, nil, "GenRec[T]?", "2,1")
                }
            }
            AddMethod("Obl", "ObliviousMethod", 0, "string!", "string!")
            AddProperty("Obl", "ObliviousProp", "string!")
            return positions
        }

        private func TryResolve(
            assembly Assembly,
            position Issue4988Position,
            failures List[string]
        ) Issue4988ResolvedPosition? {
            try {
                return Resolve(assembly, position)
            } catch (e InvalidOperationException) {
                failures.Add("${position.Key}: not found in the gsc output (${e.Message})")
                return nil
            }
        }

        private func Resolve(assembly Assembly, position Issue4988Position) Issue4988ResolvedPosition {
            let FindType = func (name string) Type {
                return assembly.GetType("Matrix.$name") ??
                    throw InvalidOperationException("${position.Key}: type Matrix.$name not found")
            }
            let FindMethod = func () MethodBase {
                if position.Member == ".ctor" {
                    return FindType(position.TypeName).GetConstructors(AllMembers).Single(
                        (c ConstructorInfo) -> c.GetParameters()
                            .Length > 0 &&
                            c
                            .GetParameters()[0]
                            .Name == position.Selector
                    )
                }
                let candidates = if position.TypeName == "*" {
                    assembly.GetTypes().SelectMany((t Type) -> t.GetMethods(AllMembers)).ToArray()
                } else {
                    FindType(position.TypeName).GetMethods(AllMembers)
                }
                let Selected = func (m MethodInfo) bool {
                    if position.Selector == nil {
                        return true
                    }
                    if position.TypeName == "*" {
                        return m.ReturnType.Name == position.Selector
                    }
                    let parameters = m.GetParameters()
                    return parameters.Length > 0 && parameters[0].ParameterType.Name == position.Selector
                }
                let matches = candidates.Where((m MethodInfo) -> m.Name == position.Member && Selected(m)).ToArray()
                if matches.Length != 1 {
                    throw InvalidOperationException("${position.Key}: expected one method, found ${matches.Length}")
                }
                return matches[0]
            }
            switch position.Kind {
                case Issue4988PositionKind.Return {
                    let method = cast[MethodInfo](FindMethod())
                    return Issue4988ResolvedPosition(
                        method.ReturnType,
                        method.ReturnParameter,
                        method,
                        () -> ClrNullability.GetReturnTypeSymbol(method)
                    )
                }
                case Issue4988PositionKind.Parameter {
                    let method = FindMethod()
                    let parameter = method.GetParameters()[position.Index]
                    return Issue4988ResolvedPosition(
                        parameter.ParameterType,
                        parameter,
                        method,
                        () -> ClrNullability.GetParameterTypeSymbol(parameter)
                    )
                }
                case Issue4988PositionKind.Property {
                    let property = FindType(position.TypeName).GetProperty(position.Member, AllMembers) ??
                        throw InvalidOperationException("${position.Key}: property not found")
                    return Issue4988ResolvedPosition(
                        property.PropertyType,
                        property,
                        property,
                        () -> ClrNullability.GetPropertyTypeSymbol(property)
                    )
                }
                case Issue4988PositionKind.Field {
                    let field = FindType(position.TypeName).GetField(position.Member, AllMembers) ??
                        throw InvalidOperationException("${position.Key}: field not found")
                    return Issue4988ResolvedPosition(
                        field.FieldType,
                        field,
                        field,
                        () -> ClrNullability.GetFieldTypeSymbol(field)
                    )
                }
                case Issue4988PositionKind.BaseType {
                    let declaringType = FindType(position.TypeName)
                    let baseType = declaringType.BaseType ??
                        throw InvalidOperationException("${position.Key}: base type not found")
                    return Issue4988ResolvedPosition(
                        baseType,
                        declaringType,
                        declaringType,
                        () -> ClrNullability.GetBaseTypeSymbol(declaringType) ??
                            throw InvalidOperationException("${position.Key}: null base symbol"),
                        () -> ClrNullability.NormalizeRelationshipFlags(
                            baseType,
                            ClrNullability.ReadNullableFlags(declaringType, declaringType)
                        )
                    )
                }
                case Issue4988PositionKind.InterfaceImpl {
                    let declaringType = FindType(position.TypeName)
                    let interfaces = declaringType.GetInterfaces()
                    if uint32(position.Index) >= uint32(interfaces.Length) {
                        throw InvalidOperationException("${position.Key}: interface index out of range")
                    }
                    let iface = interfaces[position.Index]
                    return Issue4988ResolvedPosition(
                        iface,
                        declaringType,
                        declaringType,
                        () -> ClrNullability.GetInterfaceTypeSymbols(declaringType)[position.Index],
                        () -> ClrNullability.NormalizeRelationshipFlags(
                            iface,
                            ClrSignatureMetadata.Interfaces(declaringType)[position.Index].Flags
                        )
                    )
                }
                case Issue4988PositionKind.GenericParamConstraint {
                    let gp = if position.Member == "T" {
                        FindType(position.TypeName).GetGenericArguments()[0]
                    } else {
                        FindMethod().GetGenericArguments()[0]
                    }
                    let constraints = gp.GetGenericParameterConstraints()
                    if uint32(position.Index) >= uint32(constraints.Length) {
                        throw InvalidOperationException("${position.Key}: constraint index out of range")
                    }
                    let constraint = constraints[position.Index]
                    let enclosing MemberInfo = gp.DeclaringMethod ?? cast[MemberInfo](gp.DeclaringType!!)
                    return Issue4988ResolvedPosition(
                        constraint,
                        gp,
                        enclosing,
                        () -> ClrNullability.GetGenericParameterConstraintTypeSymbols(gp)[position.Index],
                        () -> ClrSignatureMetadata.Constraints(gp)[position.Index].Flags
                    )
                }
                case Issue4988PositionKind.GenericParam {
                    let gp = if position.Member == "T" {
                        FindType(position.TypeName).GetGenericArguments()[position.Index]
                    } else {
                        FindMethod().GetGenericArguments()[position.Index]
                    }
                    let enclosing MemberInfo = gp.DeclaringMethod ?? cast[MemberInfo](gp.DeclaringType!!)
                    return Issue4988ResolvedPosition(
                        gp,
                        gp,
                        enclosing,
                        () -> ClrNullability.GetGenericParameterTypeSymbol(gp)
                    )
                }
                default {
                    let ev = FindType(position.TypeName).GetEvent(position.Member, AllMembers) ??
                        throw InvalidOperationException("${position.Key}: event not found")
                    let handler = ev.EventHandlerType ??
                        throw InvalidOperationException("${position.Key}: event has no handler type")
                    return Issue4988ResolvedPosition(
                        handler,
                        ev,
                        ev,
                        () -> MemberLookup.GetClrEventHandlerTypeSymbol(ev)
                    )
                }
            }
        }

        /// The bytes a reader sees at a position once scalar and context forms
        /// are expanded: the position's own `[Nullable]`, else the nearest
        /// enclosing `[NullableContext]`. Absent metadata reads as `0`.
        private func EffectiveBytes(position Issue4988ResolvedPosition) string {
            let type = if position.ClrType.IsByRef {
                position.ClrType.GetElementType() ??
                    throw InvalidOperationException("a by-ref type has an element type")
            } else {
                position.ClrType
            }
            let flags = if position.ReadFlags is {} readFlags {
                readFlags()
            } else {
                ClrNullability.ReadNullableFlags(position.Declaration, position.Enclosing)
            }
            return string.Join(",", ClrNullability.ExpandNullableFlags(type, flags, uint8(0)))
        }

        /// Spells an imported (cref:TypeSymbol) in G# syntax, descending
        /// through the funnel accessors so every nested `?` / `!` the
        /// reader produced is shown (SymbolDisplay deliberately hides nested
        /// reference `?`).
        private func Render(symbol TypeSymbol, clr Type) string {
            if clr.IsByRef {
                let element = clr.GetElementType() ??
                    throw InvalidOperationException("a by-ref type has an element type")
                return if symbol is ByRefTypeSymbol byRef {
                    Render(byRef.PointeeType, element)
                } else {
                    Render(symbol, element)
                }
            }
            if clr.IsGenericType && !clr.IsGenericTypeDefinition && clr.GetGenericTypeDefinition()
                .FullName == "System.Nullable`1" {
                let inner = if symbol is NullableTypeSymbol nullableValue {
                    nullableValue.UnderlyingType
                } else {
                    symbol
                }
                return Render(inner, clr.GetGenericArguments()[0]) + "?"
            }
            if symbol is NullableTypeSymbol nullable {
                return if clr.IsArray {
                    "[]?" + RenderElement(nullable.UnderlyingType, clr)
                } else {
                    Render(nullable.UnderlyingType, clr) + "?"
                }
            }
            if symbol is PlatformTypeSymbol platform {
                return if clr.IsArray {
                    "[]!" + RenderElement(platform.UnderlyingType, clr)
                } else {
                    Render(platform.UnderlyingType, clr) + "!"
                }
            }
            if clr.IsArray {
                return "[]" + RenderElement(symbol, clr)
            }
            if clr.IsGenericParameter {
                return clr.Name
            }
            let arguments = if clr.IsGenericType {
                clr.GetGenericArguments()
            } else {
                Type.EmptyTypes
            }
            if symbol is TupleTypeSymbol tuple {
                let elements = List[string]()
                for var i = 0; i < tuple.ElementTypes.Length; i++ {
                    elements.Add(Render(tuple.ElementTypes[i], arguments[i]))
                }
                return "(" + string.Join(", ", elements) + ")"
            }
            if arguments.Length > 0 && clr.IsGenericTypeDefinition {
                // The open type referring to itself (`R[T]` inside `R[T]`): its
                // arguments are its own parameters.
                return GenericName(clr) + "[" + string.Join(", ", arguments.Select((a Type) -> a.Name)) + "]"
            }
            if arguments.Length > 0 {
                let rendered = List[string]()
                for var i = 0; i < arguments.Length; i++ {
                    rendered.Add(RenderArgument(symbol, i, arguments[i]))
                }
                return GenericName(clr) + "[" + string.Join(", ", rendered) + "]"
            }
            return SimpleName(clr)
        }

        private func RenderArgument(symbol TypeSymbol, index int32, clr Type) string {
            if symbol is NullabilityAnnotatedTypeSymbol annotated {
                return Render(annotated.GetTypeArgumentSymbol(index), clr)
            }
            if symbol is ImportedTypeSymbol{TypeArguments: {IsDefaultOrEmpty: false}} imported {
                return Render(imported.TypeArguments[index], clr)
            }
            // An argument with no nullability positions (`int32?` in
            // `Action[int32?]`) carries nothing to read back: spell its CLR shape.
            if ClrNullability.CountNullabilityBytes(clr) == 0 {
                return RenderValueType(clr)
            }
            // No per-argument information survived at all.
            return "<${SimpleName(clr)}: no nullability>"
        }

        private func RenderValueType(clr Type) string {
            if clr.IsGenericType && clr.GetGenericTypeDefinition().FullName == "System.Nullable`1" {
                return RenderValueType(clr.GetGenericArguments()[0]) + "?"
            }
            return SimpleName(clr)
        }

        private func RenderElement(symbol TypeSymbol, arrayClr Type) string {
            let element = arrayClr.GetElementType() ??
                throw InvalidOperationException("an array type has an element type")
            return switch symbol {
                case annotated is NullabilityAnnotatedTypeSymbol: Render(
                    ClrNullability.SymbolFromFlagsOffset(element, annotated.NullableFlags, 1),
                    element
                )
                case slice is SliceTypeSymbol: Render(slice.ElementType, element)
                case array is ArrayTypeSymbol: Render(array.ElementType, element)
                default: "<${SimpleName(element)}: no nullability>"
            }
        }

        private func GenericName(clr Type) string {
            let name = clr.Name
            let tick = name.IndexOf('`')
            return if tick < 0 {
                name
            } else {
                name.Substring(0, tick)
            }
        }

        private func SimpleName(clr Type) string -> switch clr.FullName {
            case "System.String": "string"
            case "System.Int32": "int32"
            case "System.Object": "object"
            case "System.Boolean": "bool"
            default: GenericName(clr)
        }

        private func CompileGSharp(
            directory string,
            source string,
            targetFramework string,
            references List[string],
            verify bool
        ) string {
            Directory.CreateDirectory(directory)
            let srcPath = Path.Combine(directory, "producer.gs")
            let outPath = Path.Combine(directory, "Producer.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{
                "/out:" + outPath,
                "/assemblyname:Producer",
                "/target:library",
                "/targetframework:" + targetFramework
            }
            for reference in references {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            let (exit, output) = RunDriver(args)
            Assert.True(exit == 0, "gsc failed compiling the producer:\n" + output)
            if verify {
                IlVerifier.Verify(outPath)
            }
            return outPath
        }

        private func CompileConsumer(directory string, libraryPath string, source string)(
            ExitCode int32,
            Output string
        ) {
            let srcPath = Path.Combine(directory, "consumer.gs")
            let outPath = Path.Combine(
                directory,
                if source == ValidRelationshipConsumerSource {
                    "Consumer.dll"
                } else {
                    "Consumer_${Guid.NewGuid():N}.dll"
                }
            )
            File.WriteAllText(srcPath, source)
            let args = List[string]{
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                "/reference:" + libraryPath,
                srcPath
            }
            return RunDriver(args)
        }

        private func RunDriver(args List[string])(int32, string) {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exit int32
            try {
                exit = GscProgram.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return (exit, "stdout:\n$compileOut\nstderr:\n$compileErr")
        }

        private func CompileCSharp(directory string, source string) string {
            let outPath = Path.Combine(directory, "Twin.dll")
            let references = ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                "Twin",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            let result = compilation.Emit(outPath)
            Assert.True(
                result.Success,
                "the C# twin failed to compile:\n" + string.Join(
                    "\n",
                    result.Diagnostics.Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                )
            )
            return outPath
        }

        private func LoadContext(assemblyPath string, coreDirectory string, isNetStandard bool) MetadataLoadContext {
            let resolver = PathAssemblyResolver(
                Directory.GetFiles(coreDirectory, "*.dll").Concat([]string{assemblyPath})
            )
            return MetadataLoadContext(
                resolver,
                if isNetStandard {
                    "netstandard"
                } else {
                    "System.Private.CoreLib"
                }
            )
        }

        /// The netstandard2.0 contract: the NETStandard.Library 2.0 package's
        /// reference assembly when the NuGet cache has it, otherwise the SDK's
        /// NETStandard.Library.Ref pack scrubbed to the netstandard2.0 surface.
        private func FindNetStandardReference() string? -> Issue4921HostFallbackEmbeddableAttributeTests.FindNetStandardReference()

        private func TryDelete(directory string) {
            try {
                if Directory.Exists(directory) {
                    Directory.Delete(directory, recursive: true)
                }
            } catch {
                // Best-effort cleanup.

            }
        }

        private func AssertRejectedWithDiagnostic(
            result(ExitCode int32, Output string),
            expectedDiagnosticId string,
            expectedLocation string,
            context string
        ) {
            Assert.True(result.ExitCode != 0, "$context:\n${result.Output}")
            Assert.True(
                !result.Output.Contains("GS9998", StringComparison.Ordinal) && !result.Output.Contains(
                    "GS9997",
                    StringComparison.Ordinal
                ),
                "$context (unexpected fatal/internal error):\n${result.Output}"
            )
            Assert.True(
                result.Output.Contains(expectedDiagnosticId, StringComparison.Ordinal),
                "$context (expected $expectedDiagnosticId):\n${result.Output}"
            )
            Assert.True(
                result.Output.Contains(expectedLocation, StringComparison.Ordinal),
                "$context (expected $expectedLocation):\n${result.Output}"
            )
        }

        private const GenericConstraintSource string = `package Generic

import System

class Token {}

class UnconstrainedBox[T] {}

interface IGen {
    func PickUnconstrained[T](p T, q string?) T;
    func Pick[T class](p T?, q string?) T?;
    func PickNullable[T class?](p T?, q string?) T?;
    func PickNotNull[T notnull](p T, q string?) T;
    func PickEquatable[T IEquatable[Token?]](p T) T;
}

class Gen {
    func PickUnconstrained[T](p T, q string?) T {
        return p
    }
    func Pick[T class](p T?, q string?) T? {
        return p
    }
    func PickNullable[T class?](p T?, q string?) T? {
        return p
    }
    func PickNotNull[T notnull](p T, q string?) T {
        return p
    }
    func PickEquatable[T IEquatable[Token?]](p T) T {
        return p
    }
}
`

        private const GenericConstraintConsumerSource string = `#nullable enable
using System;

public sealed class NonNullTokenEq : IEquatable<Generic.Token> {
    public bool Equals(Generic.Token? other) => other != null;
}

public sealed class NullableTokenEq : IEquatable<Generic.Token?> {
    public bool Equals(Generic.Token? other) => true;
}

public static class Use {
    public static void Run(Generic.IGen face, Generic.Gen gen) {
        _ = new Generic.UnconstrainedBox<string?>();
        face.PickUnconstrained<string?>(null, null);
        gen.PickUnconstrained<string?>(null, null);
        face.Pick<string?>(null, null);
        gen.Pick<string?>(null, null);
        face.PickNullable<string?>(null, null);
        gen.PickNullable<string?>(null, null);
        face.PickNotNull<string?>(null, null);
        gen.PickNotNull<string?>(null, null);
        face.PickEquatable(new NullableTokenEq());
        gen.PickEquatable(new NullableTokenEq());
        face.PickEquatable(new NonNullTokenEq());
        gen.PickEquatable(new NonNullTokenEq());
    }
}
`

        private const RelationshipContractGSharpSource string = `package RelContract

import System

open class Token {}

interface IInner[T] {}

interface IOuter[T] : IInner[Token?] {}

interface INonGenericOuter : IInner[Token?] {}

interface INonGenericNonNullOuter : IInner[Token] {}

interface IAdaptClass {
    func Echo[T class](value T) T;
}

interface IAdaptNullableClass {
    func Echo[T class?](value T) T;
}

interface IAdaptNotNull {
    func Echo[T notnull](value T) T;
}

interface IAdaptNullableEquatable {
    func Echo[T IEquatable[Token?]](value T) T;
}

interface IAdaptNullableToken {
    func Echo[T Token?](value T) T;
}

interface IAdaptNullableRootEquatable {
    func Echo[T IEquatable[Token?]?](value T) T;
}

class ImportedNonNullEquatableEcho {
    func Echo[T IEquatable[Token]](value T) T {
        return value
    }
}

class ImportedNullableEquatableEcho {
    func Echo[T IEquatable[Token?]](value T) T {
        return value
    }
}

class ImportedNonNullArgNullableRootEquatableEcho {
    func Echo[T IEquatable[Token]?](value T) T {
        return value
    }
}

class ImportedNullableRootEquatableEcho {
    func Echo[T IEquatable[Token?]?](value T) T {
        return value
    }
}

open class ComparableBox[T comparable] {}

open class BaseBox[T] {
    private let item T
    init(item T) {
        this.item = item
    }
    func Get() T {
        return this.item
    }
}

class NullableTokenSub : BaseBox[Token?] {
    init() : base(nil) {}
}

class NullableEquatableImpl : IEquatable[Token?] {
    func Equals(other Token?) bool {
        return true
    }
}

class NonNullEquatableImpl : IEquatable[Token] {
    func Equals(other Token) bool {
        return true
    }
}

class ConstrainedHolder[T IEquatable[Token?]] {}

open class ClassBox[T class] {}

open class NullableClassBox[T class?] {}

open class NullableClassInitBox[T class? init()] {}

open class NotNullBox[T notnull] {}

open class DisposableNotNullBox[T IDisposable notnull] {}

open class TokenBox[T Token] {}

open class NullableTokenBox[T Token?] {}

open class DependentNullableTokenBox[A Token?, B A] {}

open class NullableInnerBox[T IInner[Token?]?] {
    open class Nested {}
}

class DisposableImpl : IDisposable {
    func Dispose() {}
}

class ConstraintProbes {
    shared {
        func TakeClass[T class](value T?) T? {
            return value
        }
        func TakeNullableClass[T class?](value T?) T? {
            return value
        }
        func TakeNullableClassInit[T class? init()](value T) T {
            return value
        }
        func TakeNotNull[T notnull](value T) T {
            return value
        }
        func TakeComparable[T comparable](value T) T {
            return value
        }
        func TakeDisposableNotNull[T IDisposable notnull](value T) T {
            return value
        }
        func TakeDisposableNullableClass[T IDisposable class?](value T) T {
            return value
        }
        func TakeNullableTokenBound[T Token?](value T) T {
            return value
        }
        func TakeNullableInnerBound[T IInner[Token?]?](value T) T {
            return value
        }
        func TakeDependentNullableToken[A Token?, B A](a A, b B) B {
            return b
        }
        func TakeDependentNotNull[A notnull, B A](a A, b B) B {
            return b
        }
        func TakeNullableEquatable[T IEquatable[Token?]](value T) T {
            return value
        }
        func DependentEquatable[T class, U IEquatable[T?]](first T, second U) U {
            return second
        }
        func MakeNullableTask() System.Threading.Tasks.Task[Token?]? {
            return nil
        }
    }
}

open class Holder[T] {
    let Value T
    prop Prop T {
        get {
            return this.Value
        }
    }
    init(value T) {
        this.Value = value
    }
}

class NamedTupleDerived : Holder[(Name string, Count int32)] {
    init() : base(("ok", 1)) {}
}

interface IHolder[T] {
    func Get() T;
}

interface INamedTupleHolder : IHolder[(Name string, Count int32)] {}

open class OptionalDerived[T class, U T?] {}

open class ReceiverBox[T] {
    func AcceptInner[U IInner[T]]() {}
}

class NonGenericReceiverSub : ReceiverBox[Token?] {}

class GenericReceiverSub[X] : ReceiverBox[Token?] {}
`

        private const RelationshipContractCSharpSource string = `#nullable enable
using System;

namespace RelContract;

public class Token {}

public interface IInner<T> {}

public interface IOuter<T> : IInner<Token?> {}

public interface INonGenericOuter : IInner<Token?> {}

public interface IAdaptClass {
    T Echo<T>(T value) where T : class;
}

public interface IAdaptNullableClass {
    T Echo<T>(T value) where T : class?;
}

public interface IAdaptNotNull {
    T Echo<T>(T value) where T : notnull;
}

public interface IAdaptNullableEquatable {
    T Echo<T>(T value) where T : IEquatable<Token?>;
}

public interface IAdaptNullableToken {
    T Echo<T>(T value) where T : Token?;
}

public interface IAdaptNullableRootEquatable {
    T Echo<T>(T value) where T : IEquatable<Token?>?;
}

public class ImportedNonNullEquatableEcho {
    public T Echo<T>(T value) where T : IEquatable<Token> => value;
}

public class ImportedNullableEquatableEcho {
    public T Echo<T>(T value) where T : IEquatable<Token?> => value;
}

public class ImportedNonNullArgNullableRootEquatableEcho {
    public T Echo<T>(T value) where T : IEquatable<Token>? => value;
}

public class ImportedNullableRootEquatableEcho {
    public T Echo<T>(T value) where T : IEquatable<Token?>? => value;
}

public class BaseBox<T> {
    private readonly T item;
    public BaseBox(T item) {
        this.item = item;
    }
    public T Get() => this.item;
}

public class NullableTokenSub : BaseBox<Token?> {
    public NullableTokenSub() : base(null) {}
}

public class NullableEquatableImpl : IEquatable<Token?> {
    public bool Equals(Token? other) => true;
}

public class NonNullEquatableImpl : IEquatable<Token> {
    public bool Equals(Token? other) => other != null;
}

public class ConstrainedHolder<T> where T : IEquatable<Token?> {}

public class ClassBox<T> where T : class {}

public class NullableClassBox<T> where T : class? {}

public class NullableClassInitBox<T> where T : class?, new() {}

public class NotNullBox<T> where T : notnull {}

public class DisposableNotNullBox<T> where T : IDisposable {}

public class TokenBox<T> where T : Token {}

public class NullableTokenBox<T> where T : Token? {}

public class DependentNullableTokenBox<A, B> where A : Token? where B : A {}

public class NullableInnerBox<T> where T : IInner<Token?>? {
    public class Nested {}
}

public class DisposableImpl : IDisposable {
    public void Dispose() {}
}

public static class ConstraintProbes {
    public static T? TakeClass<T>(T? value) where T : class => value;
    public static T? TakeNullableClass<T>(T? value) where T : class? => value;
    public static T TakeNullableClassInit<T>(T value) where T : class?, new() => value;
    public static T TakeNotNull<T>(T value) where T : notnull => value;
    public static T TakeDisposableNotNull<T>(T value) where T : IDisposable => value;
    public static T TakeNullableTokenBound<T>(T value) where T : Token? => value;
    public static T TakeNullableInnerBound<T>(T value) where T : IInner<Token?>? => value;
    public static B TakeDependentNullableToken<A, B>(A a, B b) where A : Token? where B : A => b;
    public static T TakeNullableEquatable<T>(T value) where T : IEquatable<Token?> => value;
    public static U DependentEquatable<T, U>(T first, U second) where T : class where U : IEquatable<T?> => second;
    public static System.Threading.Tasks.Task<Token?>? MakeNullableTask() => null;
}

public class Holder<T> {
    public readonly T Value;
    public T Prop => this.Value;
    public Holder(T value) {
        this.Value = value;
    }
}

public class NamedTupleDerived : Holder<(string Name, int Count)> {
    public NamedTupleDerived() : base(("ok", 1)) {}
}

public interface IHolder<T> {
    T Get();
}

public interface INamedTupleHolder : IHolder<(string Name, int Count)> {}

public class OptionalDerived<T, U> where T : class where U : T? {}

public class ReceiverBox<T> {
    public void AcceptInner<U>() where U : IInner<T> {}
}

public class NonGenericReceiverSub : ReceiverBox<Token?> {}

public class GenericReceiverSub<X> : ReceiverBox<Token?> {}
`

        private const ValidRelationshipConsumerSource string = `package Consumer

import RelContract
import System
import System.Collections.Generic
import System.Threading.Tasks

class LocalItem {}

class LocalNullableEquatable : IEquatable[Token?] {
    func Equals(other Token?) bool {
        return true
    }
}

class ConcreteOuterImpl : IOuter[string] {}

class SymbolicOuterImpl : IOuter[LocalItem] {}

class NonGenericOuterImpl : INonGenericOuter {}

class ForwardClass[T class] : ClassBox[T] {}

class ForwardNullableClass[T class?] : NullableClassBox[T] {}

class ForwardNotNull[T notnull] : NotNullBox[T] {}

open class LocalNotNullBox[T notnull] {}

open class LocalClassBox[T class] {}

open class LocalDisposableBox[T IDisposable] {}

open class LocalTokenBox[T Token] {}

class ForwardDisposableToImportedNotNull[T IDisposable] : NotNullBox[T] {}

class ForwardDisposableToLocalNotNull[T IDisposable] : LocalNotNullBox[T] {}

class ForwardTokenClassQuestionToImportedClass[T Token class?] : ClassBox[T] {}

class ForwardTokenClassQuestionToLocalClass[T Token class?] : LocalClassBox[T] {}

class ForwardDisposableClassQuestionToImportedDisposable[T IDisposable class?] : DisposableNotNullBox[T] {}

class ForwardDisposableClassQuestionToLocalDisposable[T IDisposable class?] : LocalDisposableBox[T] {}

class ForwardTokenClassQuestionToImportedToken[T Token class?] : TokenBox[T] {}

class ForwardTokenClassQuestionToLocalToken[T Token class?] : LocalTokenBox[T] {}

interface ILocalMarker {
    func Ping() int32;
}

open class LocalBase {
    var Value int32
}

class LocalDerived : LocalBase, ILocalMarker {
    func Ping() int32 {
        return this.Value
    }
}

func ReadAndWriteLocalNullableBase[T LocalBase?](x T) int32 {
    if x != nil {
        let narrowedAlias = x
        narrowedAlias.Value = 2
        return narrowedAlias.Value
    }
    let assertedAlias = x!!
    assertedAlias.Value = 1
    return x?.Value ?? assertedAlias.Value
}

func ConvertLocalNullableBaseToNullableObject[T LocalBase?](x T) object? {
    return x
}

func ConvertAssertedLocalNullableBaseToObject[T LocalBase?](x T) object {
    return x!!
}

func HashForwardedAsserted[A class?, B A](value B) int32 {
    if value != nil {
        return value.GetHashCode()
    }
    return value!!.GetHashCode()
}

func ConvertLocalNullableBase[T LocalBase?](x T) LocalBase? {
    return x
}

func ConvertLocalNullableInterface[T ILocalMarker?](x T) ILocalMarker? {
    return x
}

func ConvertLocalNotNullBase[T LocalBase? notnull](x T) LocalBase {
    return x
}

func ConvertLocalNotNullInterface[T ILocalMarker? notnull](x T) ILocalMarker {
    return x
}

func ReadTaskLocalItem[T Task[LocalItem]?](x T) LocalItem {
    return x!!.Result
}

func ReadEnumerableLocalItem[T IEnumerable[LocalItem]?](x T) IEnumerator[LocalItem] {
    return x!!.GetEnumerator()
}

func ConvertNarrowedImportedHolderField[T LocalBase?](h Holder[T], fallback LocalBase) LocalBase {
    if h.Value != nil {
        return h.Value
    }
    return fallback
}

func ReadNamedTupleBaseAndInterface(d NamedTupleDerived, i INamedTupleHolder) string {
    return d.Prop.Name + i.Get().Name
}

func DisposeWithPropertyPattern[T IDisposable?](x T) {
    if x is {} {
        x.Dispose()
    }
}

func FirstIndexed[T IList[string]?](x T) string? {
    return x?[0]
}

func CallReceiverDependentMethodConstraint() {
    ReceiverBox[Token?]().AcceptInner[IInner[Token?]]()
    NonGenericReceiverSub().AcceptInner[IInner[Token?]]()
    GenericReceiverSub[int32]().AcceptInner[IInner[Token?]]()
}

func DisposeWithCoalesceThrow[T IDisposable?](x T) {
    (x ?? throw InvalidOperationException()).Dispose()
}

class ForwardObjectToNotNull[T object] : NotNullBox[T] {}

open class LocalNullableBaseBox[T LocalBase?] {}

open class LocalBaseBox[T LocalBase] {}

open class LocalNullableInterfaceBox[T ILocalMarker?] {}

open class LocalMarkerBox[T ILocalMarker] {}

class ForwardLocalNullableBase[T LocalBase?] : LocalNullableBaseBox[T] {}

class ForwardLocalNullableInterface[T ILocalMarker?] : LocalNullableInterfaceBox[T] {}

class ForwardNullableDispWithNotNullToImported[T IDisposable? notnull] : DisposableNotNullBox[T] {}

class ForwardNullableDispWithNotNullToLocal[T IDisposable? notnull] : LocalDisposableBox[T] {}

class ForwardNullableTokenWithNotNullToImported[T Token? notnull] : TokenBox[T] {}

class ForwardNullableTokenWithNotNullToLocal[T Token? notnull] : LocalTokenBox[T] {}

class ForwardNullableLocalBaseWithNotNullToLocal[T LocalBase? notnull] : LocalBaseBox[T] {}

class ForwardNullableLocalMarkerWithNotNullToLocal[T ILocalMarker? notnull] : LocalMarkerBox[T] {}

class SourceNullableTokenEcho {
    func Echo[T Token?](value T) T {
        return value
    }
}

class ForwardImportedNullableToken[T Token?] : NullableTokenBox[T] {}

class ForwardImportedNullableInner[T IInner[Token?]?] : NullableInnerBox[T] {}

class SourceClassEcho {
    func Echo[T class](value T) T {
        return value
    }
}

class SourceNullableClassEcho {
    func Echo[T class?](value T) T {
        return value
    }
}

class SourceNotNullEcho {
    func Echo[T notnull](value T) T {
        return value
    }
}

func ReadBase(sub NullableTokenSub) Token {
    let v = sub.Get()
    return v!!
}

func MakeHolder() ConstrainedHolder[NullableEquatableImpl] {
    return ConstrainedHolder[NullableEquatableImpl]()
}

func MakeLocalHolder() ConstrainedHolder[LocalNullableEquatable] {
    let local = LocalNullableEquatable()
    let _ = ConstraintProbes.TakeNullableEquatable(local)
    let _ = ConstraintProbes.DependentEquatable[Token, LocalNullableEquatable](Token(), local)
    return ConstrainedHolder[LocalNullableEquatable]()
}

func LocalNullableClassInit[T class? init()](x T) T {
    return x
}

func LocalEchoNullableClass[T class?](value T) T {
    return value
}

func UseImportedConstraints() string? {
    let _ = ClassBox[string]()
    let _ = NullableClassBox[string?]()
    let _ = NullableClassInitBox[Token?]()
    let _ = NotNullBox[string]()
    let _ = DisposableNotNullBox[DisposableImpl]()
    let _ = ConstraintProbes.TakeClass[string](nil)
    let _ = ConstraintProbes.TakeNullableClassInit[Token?](nil)
    let _ = ConstraintProbes.TakeNotNull[string]("a")
    let _ = ConstraintProbes.TakeDisposableNotNull[DisposableImpl](DisposableImpl())
    let _ = LocalNullableClassInit[Token?](nil)
    let _ = LocalEchoNullableClass(ConstraintProbes.MakeNullableTask())
    let _ = adapt[IAdaptClass](SourceClassEcho())
    let _ = adapt[IAdaptNullableClass](SourceNullableClassEcho())
    let _ = adapt[IAdaptNotNull](SourceNotNullEcho())
    let _ = adapt[IAdaptNullableEquatable](ImportedNullableEquatableEcho())
    let _ = adapt[IAdaptNullableToken](SourceNullableTokenEcho())
    let _ = adapt[IAdaptNullableRootEquatable](ImportedNullableRootEquatableEcho())
    let _ = NullableTokenBox[Token?]()
    let _ = DependentNullableTokenBox[Token?, Token?]()
    let _ = OptionalDerived[string, string?]()
    let _ = NullableInnerBox[INonGenericOuter?]()
    let _ = NullableInnerBox[INonGenericOuter?].Nested()
    let _ = LocalNullableBaseBox[LocalDerived?]()
    let _ = LocalNullableInterfaceBox[LocalDerived?]()
    let _ = ReadAndWriteLocalNullableBase[LocalDerived?](LocalDerived())
    let _ = ConstraintProbes.TakeNullableTokenBound[Token?](nil)
    let _ = ConstraintProbes.TakeNullableInnerBound[INonGenericOuter?](nil)
    let _ = ConstraintProbes.TakeDependentNullableToken[Token?, Token?](nil, nil)
    return ConstraintProbes.TakeNullableClass[string?](nil)
}

func LocalConstraints[TClass class, TNullableClass class?, TNotNull notnull](
    a TClass,
    b TNullableClass,
    c TNotNull
) TNullableClass {
    return b
}

func CallLocalConstraints() string? {
    return LocalConstraints[string, string?, int32]("a", nil, 1)
}
`

        private const InvalidBaseNullabilityConsumerSource string = `package Consumer

import RelContract

func ReadBase(sub NullableTokenSub) Token {
    return sub.Get()
}
`

        private const InvalidConstraintNullabilityConsumerSource string = `package Consumer

import RelContract

func MakeBadHolder() ConstrainedHolder[NonNullEquatableImpl] {
    return ConstrainedHolder[NonNullEquatableImpl]()
}
`

        private const InvalidLocalConstraintNullabilityConsumerSource string = `package Consumer

import RelContract
import System

class LocalNonNullEquatable : IEquatable[Token] {
    func Equals(other Token) bool {
        return true
    }
}

func CallBadLocal() LocalNonNullEquatable {
    return ConstraintProbes.TakeNullableEquatable(LocalNonNullEquatable())
}
`

        private const InvalidDependentConstraintNullabilityConsumerSource string = `package Consumer

import RelContract

func CallBadDependent() NonNullEquatableImpl {
    return ConstraintProbes.DependentEquatable[Token, NonNullEquatableImpl](Token(), NonNullEquatableImpl())
}
`

        private const InvalidNotNullTypeConsumerSource string = `package Consumer

import RelContract

func MakeBad() NotNullBox[string?] {
    return NotNullBox[string?]()
}
`

        private const InvalidNotNullValueTypeConsumerSource string = `package Consumer

import RelContract

func MakeBad() NotNullBox[int32?] {
    return NotNullBox[int32?]()
}
`

        private const InvalidNotNullMethodConsumerSource string = `package Consumer

import RelContract

func CallBad(s string?) string? {
    return ConstraintProbes.TakeNotNull[string?](s)
}
`

        private const InvalidClassTypeConsumerSource string = `package Consumer

import RelContract

func MakeBad() ClassBox[string?] {
    return ClassBox[string?]()
}
`

        private const InvalidClassMethodConsumerSource string = `package Consumer

import RelContract

func CallBad() string? {
    return ConstraintProbes.TakeClass[string?](nil)
}
`

        private const InvalidForwardNotNullConsumerSource string = `package Consumer

import RelContract

class BadForward[T] : NotNullBox[T] {}
`

        private const InvalidForwardClassConsumerSource string = `package Consumer

import RelContract

class BadForward[T class?] : ClassBox[T] {}
`

        private const InvalidAdaptClassConsumerSource string = `package Consumer

import RelContract

class SourceNullableClassEcho {
    func Echo[T class?](value T) T {
        return value
    }
}

func Bad() IAdaptClass {
    return adapt[IAdaptClass](SourceNullableClassEcho())
}
`

        private const InvalidAdaptNullableClassConsumerSource string = `package Consumer

import RelContract

class SourceClassEcho {
    func Echo[T class](value T) T {
        return value
    }
}

func Bad() IAdaptNullableClass {
    return adapt[IAdaptNullableClass](SourceClassEcho())
}
`

        private const InvalidAdaptNotNullConsumerSource string = `package Consumer

import RelContract

class SourceUnconstrainedEcho {
    func Echo[T](value T) T {
        return value
    }
}

func Bad() IAdaptNotNull {
    return adapt[IAdaptNotNull](SourceUnconstrainedEcho())
}
`

        private const InvalidOpenGenericLocalConstraintNullabilityConsumerSource string = `package Consumer

import RelContract
import System

class LocalGenericNonNullEq[T] : IEquatable[Token] {
    func Equals(other Token) bool {
        return true
    }
}

func CallBadGenericLocal[T]() LocalGenericNonNullEq[T] {
    return ConstraintProbes.TakeNullableEquatable(LocalGenericNonNullEq[T]())
}
`

        private const InvalidCombinedDisposableNotNullConsumerSource string = `package Consumer

import RelContract

func MakeBad() DisposableNotNullBox[DisposableImpl?] {
    return DisposableNotNullBox[DisposableImpl?]()
}
`

        private const InvalidImportedAdaptConstraintNullabilityConsumerSource string = `package Consumer

import RelContract

func Bad() IAdaptNullableEquatable {
    return adapt[IAdaptNullableEquatable](ImportedNonNullEquatableEcho())
}
`

        private const InvalidForwardSortedDictionaryNotNullConsumerSource string = `package Consumer

import System.Collections.Generic

class BadSortedDict[T] {
    prop Map SortedDictionary[T, int32]?
}
`

        private const InvalidForwardNullableDisposableConsumerSource string = `package Consumer

import RelContract
import System

class BadForwardNullableDisp[T IDisposable?] : DisposableNotNullBox[T] {}
`

        private const InvalidLocalForwardNullableDisposableConsumerSource string = `package Consumer

import System

open class LocalDisposableBox[T IDisposable] {}

class BadLocalForwardNullableDisp[T IDisposable? class?] : LocalDisposableBox[T] {}
`

        private const InvalidErasedDependentConstraintNullabilityConsumerSource string = `package Consumer

import RelContract
import System

class LocalItem {}

class LocalItemNonNullEq : IEquatable[LocalItem] {
    func Equals(other LocalItem) bool {
        return true
    }
}

func CallBadErasedDependent() LocalItemNonNullEq {
    return ConstraintProbes.DependentEquatable[LocalItem, LocalItemNonNullEq](LocalItem(), LocalItemNonNullEq())
}
`

        private const InvalidOpenGenericDependentConstraintNullabilityConsumerSource string = `package Consumer

import RelContract
import System

class LocalGenericSelfEq[T] : IEquatable[T] {
    func Equals(other T) bool {
        return true
    }
}

func CallBadOpenGeneric[T class](t T, x LocalGenericSelfEq[T]) LocalGenericSelfEq[T] {
    return ConstraintProbes.DependentEquatable[T, LocalGenericSelfEq[T]](t, x)
}
`

        private const InvalidImportedNullableRootAdaptConstraintNullabilityConsumerSource string = `package Consumer

import RelContract

func Bad() IAdaptNullableRootEquatable {
    return adapt[IAdaptNullableRootEquatable](ImportedNonNullArgNullableRootEquatableEcho())
}
`

        private const InvalidLeakNullableBaseConsumerSource string = `package Consumer

open class LocalBase {
    var Value int32
}

func Leak[T LocalBase?](x T) LocalBase {
    return x
}
`

        private const InvalidLeakNullableInterfaceConsumerSource string = `package Consumer

interface ILocalMarker {}

func Leak[T ILocalMarker?](x T) ILocalMarker {
    return x
}
`

        private const InvalidUncheckedNullableBaseReadConsumerSource string = `package Consumer

open class LocalBase {
    var Value int32
}

func BadRead[T LocalBase?](x T) int32 {
    return x.Value
}
`

        private const InvalidUncheckedNullableBaseWriteConsumerSource string = `package Consumer

open class LocalBase {
    var Value int32
}

func BadWrite[T LocalBase?](x T) {
    x.Value = 1
}
`

        private const InvalidUncheckedNullableInterfaceCallConsumerSource string = `package Consumer

interface ILocalMarker {
    func Ping() int32;
}

func BadCall[T ILocalMarker?](x T) int32 {
    return x.Ping()
}
`

        private const InvalidLeakNullableBaseToObjectConsumerSource string = `package Consumer

open class LocalBase {
    var Value int32
}

func Leak[T LocalBase?](x T) object {
    return x
}
`

        private const InvalidUncheckedForwardedObjectCallConsumerSource string = `package Consumer

func Hash[A class?, B A](value B) int32 {
    return value.GetHashCode()
}
`

        private const InvalidNestedAssignmentNullableBaseReadConsumerSource string = `package Consumer

open class LocalBase {
    var Value int32
}

func BadNested[T LocalBase?](z T) int32 {
    var x = z
    var y = z
    x = (y = z)
    return x.Value
}
`

        private const InvalidNullableRootEquatableConversionConsumerSource string = `package Consumer

import RelContract
import System

func Leak[T IEquatable[Token]?](x T) IEquatable[Token?]? {
    return x
}
`

        private const InvalidForwardNullableDependentBaseConsumerSource string = `package Consumer

open class LocalBase {
    var Value int32
}

open class LocalBaseBox[T LocalBase] {}

class BadForward[A LocalBase, B A?] : LocalBaseBox[B] {}
`

        private const InvalidForwardNullableDependentInterfaceConsumerSource string = `package Consumer

interface ILocalMarker {}

open class LocalMarkerBox[T ILocalMarker] {}

class BadForward[A ILocalMarker, B A?] : LocalMarkerBox[B] {}
`

        private const InvalidForwardNullableDependentClrInterfaceConsumerSource string = `package Consumer

import RelContract
import System

class BadForward[A IDisposable, B A?] : DisposableNotNullBox[B] {}
`

        private const InvalidPartialDependentNullableBoundConsumerSource string = `package Consumer

partial class PartDepMismatch {
    partial func M[A class, B A](a A, b B) B;
}

partial class PartDepMismatch {
    partial func M[A class, B A?](a A, b B) B {
        return b
    }
}
`

        private const ValidCrossAssemblyComparableConsumerSource string = `package Consumer

import RelContract

func UseComparable() string? {
    let _ = ComparableBox[int32?]()
    let _ = ComparableBox[string?]()
    let _ = ConstraintProbes.TakeComparable[int32?](nil)
    return ConstraintProbes.TakeComparable[string?](nil)
}
`

        private const ValidInterfaceClosureOrderConsumerSource string = `package Consumer

import RelContract
import System

class DerivedThenNullable : INonGenericNonNullOuter, IInner[Token?] {}

class NullableThenDerived : IInner[Token?], INonGenericNonNullOuter {}

open class LocalObjectBox[U object] {}

class ForwardNotNullToObject[T notnull] : LocalObjectBox[T] {}

open class LocalNullableObjectBox[U object?] {}

class ForwardUnconstrainedToNullableObject[T] : LocalNullableObjectBox[T] {}

interface IForwardMarker {}

open class GenericForwardBase[A] {
    open func Echo[U A?](value U) U {
        return value
    }
}

class ForwardSourceInterfaceSub : GenericForwardBase[IForwardMarker] {
    func CallFromLambda(value IForwardMarker?) () -> IForwardMarker? {
        return () -> base.Echo[IForwardMarker?](value)
    }
}

class ForwardClrInterfaceSub : GenericForwardBase[IDisposable] {
    func CallFromLambda(value IDisposable?) () -> IDisposable? {
        return () -> base.Echo[IDisposable?](value)
    }
}

class TupleNamesImpl : IInner[(CorruptFirst Token?, CorruptSecond int32)] {}
`

        private const InvalidForwardUnconstrainedToObjectConsumerSource string = `package Consumer

open class LocalObjectBox[U object] {}

class BadForward[T] : LocalObjectBox[T] {}
`

        private const InvalidLocalDisposableClassQuestionConsumerSource string = `package Consumer

import RelContract
import System

func LocalDisp[T IDisposable class?](x T) T {
    return x
}

func CallBad() DisposableImpl? {
    return LocalDisp[DisposableImpl?](nil)
}
`

        private const InvalidCrossAssemblyDisposableClassQuestionConsumerSource string = `package Consumer

import RelContract

func CallBad() DisposableImpl? {
    return ConstraintProbes.TakeDisposableNullableClass[DisposableImpl?](nil)
}
`

        private const InvalidLocalDependentNotNullNullableValueConsumerSource string = `package Consumer

func LocalDep[A notnull, B A](a A, b B) B {
    return b
}

func CallBad() int32? {
    return LocalDep[object, int32?]("x", nil)
}
`

        private const InvalidCrossAssemblyDependentNotNullNullableValueConsumerSource string = `package Consumer

import RelContract

func CallBad() int32? {
    return ConstraintProbes.TakeDependentNotNull[object, int32?]("x", nil)
}
`

        private const InvalidPartialNotNullConsumerSource string = `package Consumer

partial class PartMismatch {
    partial func M[T](x T) T;
}

partial class PartMismatch {
    partial func M[T notnull](x T) T {
        return x
    }
}
`

        private const InvalidPartialClassQuestionConsumerSource string = `package Consumer

partial class PartMismatch {
    partial func N[T class](x T) T;
}

partial class PartMismatch {
    partial func N[T class?](x T) T {
        return x
    }
}
`

        private const InvalidClassThenClassQuestionConsumerSource string = `package Consumer

func Bad[T class class?](x T) T {
    return x
}
`

        private const InvalidClassQuestionThenClassConsumerSource string = `package Consumer

func Bad[T class? class](x T) T {
    return x
}
`

        private const InvalidReceiverDependentMethodConstraintConsumerSource string = `package Consumer

import RelContract

func CallBad() {
    ReceiverBox[Token?]().AcceptInner[IInner[Token]]()
}
`

        private const InvalidNonGenericDerivedReceiverMethodConstraintConsumerSource string = `package Consumer

import RelContract

func CallBad() {
    NonGenericReceiverSub().AcceptInner[IInner[Token]]()
}
`

        private const InvalidGenericDerivedReceiverMethodConstraintConsumerSource string = `package Consumer

import RelContract

func CallBad() {
    GenericReceiverSub[int32]().AcceptInner[IInner[Token]]()
}
`

        private const ContractSource string = `package Contract

import System.Threading.Tasks

class Token {}

interface IStore {
    func LoadAsync() Task[Token?];
}

delegate Loader() Token?;
`

        private const AssertingConsumerSource string = `package Consumer

import Contract

async func Read(store IStore) Token {
    let loaded = await store.LoadAsync()
    return loaded!!
}

func Call(loader Loader) Token {
    let loaded = loader()
    return loaded!!
}
`

        private const InterfaceMisuseSource string = `package Consumer

import Contract

async func Read(store IStore) Token {
    return await store.LoadAsync()
}
`

        private const DelegateMisuseSource string = `package Consumer

import Contract

func Call(loader Loader) Token {
    return loader()
}
`
    }
}

/// One type shape: its G# spelling (also the expected imported spelling)
/// and its C# spelling.
internal data class Issue4988Shape(GSharp string, CSharp string)

internal enum Issue4988PositionKind {
    Return,
    Parameter,
    Property,
    Field,
    Event,
    BaseType,
    InterfaceImpl,
    GenericParamConstraint,
    GenericParam
}

/// One signature position to check. A `TypeName` of `*` searches
/// every type (extension methods and conversions live on a compiler-chosen
/// host type). `Selector` picks among constructors by their first parameter's
/// name, among `*` methods by their return type's name, and among other
/// overloads by their first parameter's type name.
internal data class Issue4988Position(
    Key string,
    TypeName string,
    Kind Issue4988PositionKind,
    Member string,
    Index int32,
    Selector string?,
    Expected string,
    ExpectedBytes string?
)

/// A position resolved in one assembly.
internal data class Issue4988ResolvedPosition(
    ClrType Type,
    Declaration ICustomAttributeProvider,
    Enclosing MemberInfo,
    ReadSymbol() -> TypeSymbol,
    ReadFlags(() -> ImmutableArray[uint8])? = nil
)
