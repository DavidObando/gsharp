package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Runtime.CompilerServices
import System.Threading.Tasks
import Xunit

class Issue5070ImportedMetadataTests {
    @Fact
    func ImportedReaders_ReuseRawFactsWithoutErasingReceiverNullability() {
        using let fixture = CSharpFixture(Contract)
        using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        Assert.True(resolver.TryResolveType("Contracts.Box`1", out var definition))
        Assert.True(resolver.TryResolveType("System.String", out var stringType))
        let closed = definition.MakeGenericType(stringType)
        let method = closed.GetMethod("Echo")!!
        let parameter = method.GetParameters()[0]
        let property = closed.GetProperty("Value")!!
        let field = closed.GetField("Field")!!
        let plain = ImportedTypeSymbol.GetConstructed(closed, definition, ImmutableArray.Create(TypeSymbol.String))
        let nullable = ImportedTypeSymbol.GetConstructed(
            closed,
            definition,
            ImmutableArray.Create[TypeSymbol](NullableTypeSymbol.Get(TypeSymbol.String))
        )
        using let measurements = CompilationMeasurements.Start("test")
        let Read = func () {
            Assert.Equal(
                ReferenceNullabilityKind.NotNull,
                ClrNullability.GetReturnTypeSymbol(method).ReferenceNullability
            )
            Assert.Equal(
                ReferenceNullabilityKind.NotNull,
                ClrNullability.GetParameterTypeSymbol(parameter).ReferenceNullability
            )
            Assert.Equal(
                ReferenceNullabilityKind.NotNull,
                ClrNullability.GetPropertyTypeSymbol(property).ReferenceNullability
            )
            Assert.Equal(
                ReferenceNullabilityKind.NotNull,
                ClrNullability.GetFieldTypeSymbol(field).ReferenceNullability
            )
            Assert.Equal(
                ReferenceNullabilityKind.NotNull,
                MemberLookup.GetClrMethodReturnTypeSymbol(plain, method).ReferenceNullability
            )
            Assert.Equal(
                ReferenceNullabilityKind.Nullable,
                MemberLookup.GetClrMethodReturnTypeSymbol(nullable, method).ReferenceNullability
            )
            Assert.Equal(
                ReferenceNullabilityKind.Nullable,
                MemberLookup.GetClrMethodParameterTypeSymbol(nullable, method, 0).ReferenceNullability
            )
        }
        Read()
        let scans = measurements.GetCounter("metadata.definition-scans")
        let attributes = measurements.GetCounter("metadata.attribute-reads")
        let decodes = measurements.GetCounter("metadata.nullable-decodes")
        let contexts = measurements.GetCounter("metadata.context-decodes")
        Assert.True(scans > 0 && attributes > 0 && decodes > 0 && contexts > 0)
        Parallel.For(0, 100, (_ int32) -> Read())
        Assert.Equal(scans, measurements.GetCounter("metadata.definition-scans"))
        Assert.Equal(attributes, measurements.GetCounter("metadata.attribute-reads"))
        Assert.Equal(decodes, measurements.GetCounter("metadata.nullable-decodes"))
        Assert.Equal(contexts, measurements.GetCounter("metadata.context-decodes"))
    }

    @Fact
    func SameAssemblyIdentityAndToken_DoNotCrossActualModules() {
        using let first = CSharpFixture("#nullable enable\npublic class Box<T> { public string Value() => \"x\"; }")
        using let changed = CSharpFixture(
            "#nullable enable\npublic class Box<T> { public string? Value() => null; }",
            assemblyName: Path.GetFileNameWithoutExtension(first.AssemblyPath)
        )
        using let a = ReferenceResolver.WithReferences([]string{first.AssemblyPath})
        using let b = ReferenceResolver.WithReferences([]string{changed.AssemblyPath})
        Assert.True(a.TryResolveType("Box`1", out var aType))
        Assert.True(b.TryResolveType("Box`1", out var bType))
        Assert.True(a.TryResolveType("System.String", out var aString))
        Assert.True(b.TryResolveType("System.String", out var bString))
        let aMethod = aType.MakeGenericType(aString).GetMethod("Value")!!
        let bMethod = bType.MakeGenericType(bString).GetMethod("Value")!!
        Assert.Equal(aMethod.MetadataToken, bMethod.MetadataToken)
        Assert.Equal(aMethod.Module.Assembly.FullName, bMethod.Module.Assembly.FullName)
        Assert.NotSame(aMethod.Module, bMethod.Module)
        for var i = 0; i < 2; i++ {
            Assert.Equal(
                ReferenceNullabilityKind.NotNull,
                ClrNullability.GetReturnTypeSymbol(aMethod).ReferenceNullability
            )
            Assert.Equal(
                ReferenceNullabilityKind.Nullable,
                ClrNullability.GetReturnTypeSymbol(bMethod).ReferenceNullability
            )
            Assert.NotNull(ClrTypeUtilities.FindMetadataDefinition(aType, aMethod, All))
            Assert.Null(ClrTypeUtilities.FindMetadataDefinition(aType, bMethod, All))
        }
    }

    @Fact
    func RawContracts_CacheAbsenceButRetryFailedAttributeReads() {
        using let fixture = CSharpFixture(
            Contract + "\n#nullable disable\npublic class Silent { public string Field; }"
        )
        let assembly = fixture.Load()
        let method = assembly.GetType("Contracts.Box`1")!!.GetMethod("Maybe")!!
        let flaky = FlakyParameter(method.ReturnParameter)
        Assert.Empty(ClrNullability.ReadNullableFlags(flaky, nil))
        Assert.Equal(uint8(2), Assert.Single(ClrNullability.ReadNullableFlags(flaky, method)))
        Assert.Equal(uint8(2), Assert.Single(ClrNullability.ReadNullableFlags(flaky, method)))
        Assert.Equal(2, flaky.Reads)
        let field = assembly.GetType("Silent")!!.GetField("Field")!!
        using let measurements = CompilationMeasurements.Start("test")
        Assert.Empty(ClrNullability.ReadNullableFlags(field, field.DeclaringType))
        let reads = measurements.GetCounter("metadata.attribute-reads")
        Assert.True(reads > 0)
        for var i = 0; i < 20; i++ {
            Assert.Empty(ClrNullability.ReadNullableFlags(field, field.DeclaringType))
        }
        Assert.Equal(reads, measurements.GetCounter("metadata.attribute-reads"))
    }

    @Fact
    func RawMetadataCaches_DoNotRetainPrivateContextsOrHostGenericArgumentGraphs() {
        using let fixture = CSharpFixture(Contract)
        let (context, assembly, type) = PopulatePrivateContext(fixture.AssemblyPath)
        for var i = 0; i < 5 && (context.IsAlive || assembly.IsAlive || type.IsAlive); i++ {
            GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true)
            GC.WaitForPendingFinalizers()
        }
        Assert.False(context.IsAlive, "raw metadata must not retain the private MetadataLoadContext")
        Assert.False(assembly.IsAlive, "a host definition must not retain a foreign module")
        Assert.False(type.IsAlive, "a host generic must not retain its private type argument")
    }

    @Fact
    func TokenlessMembers_KeepTheirOriginalFailureBoundary() {
        let dynamic = DynamicMethod("Tokenless", typeof(void), Type.EmptyTypes)
        Assert.Throws[InvalidOperationException](
            () -> ClrTypeUtilities.FindMetadataDefinition(typeof(object), dynamic, All)
        )
    }

    @Fact
    func DirectAndSafeDefinitionViews_KeepDifferentSignatureLoadBehavior() {
        using let dependency = CSharpFixture("namespace Missing { public class Value {} }")
        using let fixture = CSharpFixture(
            "public class Box<T> { public Missing.Value Broken(T value) => null; }",
            []MetadataReference{MetadataReference.CreateFromFile(dependency.AssemblyPath)}
        )
        using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        Assert.True(resolver.TryResolveType("Box`1", out var definition))
        let broken = definition.GetMethods(All).Single((method MethodInfo) -> method.Name == "Broken")
        Assert.Same(broken, ClrTypeUtilities.FindMetadataDefinition(definition, broken, All))
        Assert.Null(ClrTypeUtilities.FindMetadataDefinition(definition, broken, All, safeEnumeration: true))
        Assert.Same(broken, ClrTypeUtilities.FindMetadataDefinition(definition, broken, All))
    }

    private class FlakyParameter : ParameterInfo {
        private let parameter ParameterInfo
        internal var Reads int32

        internal init(parameter ParameterInfo) {
            this.parameter = parameter
        }

        override func GetCustomAttributesData() IList[CustomAttributeData] {
            Reads++
            if Reads == 1 {
                throw FileNotFoundException("retryable metadata read")
            }
            return parameter.GetCustomAttributesData()
        }
    }

    shared {
        private const All BindingFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
        private const Contract string = `#nullable enable
namespace Contracts {
    public class Box<T> {
        public T Field = default!;
        public T Value => Field;
        public T Echo(T value) => value;
        public string? Maybe(string value) => null;
    }
}`

        @MethodImpl(MethodImplOptions.NoInlining)
        private func PopulatePrivateContext(path string)(
            Context WeakReference,
            Assembly WeakReference,
            Type WeakReference
        ) {
            let paths = ReferenceResolver.HostTrustedPlatformAssemblyPaths().Append(path)
            using let context = MetadataLoadContext(PathAssemblyResolver(paths))
            let assembly = context.LoadFromAssemblyPath(path)
            let type = assembly.GetType("Contracts.Box`1")!!
            let method = type.GetMethod("Echo")!!
            Assert.NotNull(ClrTypeUtilities.FindMetadataDefinition(type, method, All))
            Assert.NotEmpty(ClrNullability.ReadNullableFlags(method.ReturnParameter, method))
            // A failed cross-context request must not put the foreign module in a host-owned value.
            Assert.Null(ClrTypeUtilities.FindMetadataDefinition(typeof(List[_]), method, All))
            let hostGeneric = typeof(List[_]).MakeGenericType(type)
            let add = TypeBuilder.GetMethod(hostGeneric, typeof(List[_]).GetMethod("Add")!!)
            ClrNullability.ReadNullableFlags(add, add)
            return (WeakReference(context), WeakReference(assembly), WeakReference(type))
        }
    }
}
