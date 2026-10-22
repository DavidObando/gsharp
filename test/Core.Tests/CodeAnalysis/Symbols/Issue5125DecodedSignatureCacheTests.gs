package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Globalization
import System.IO
import System.Linq
import System.Reflection
import System.Threading
import System.Threading.Tasks
import Xunit

class Issue5125DecodedSignatureCacheTests {
    private const FixtureSource string = `#nullable enable
using System.Collections.Generic;
namespace Sig5125 {
    public class Holder {
        public List<string?> ListField = new List<string?>();
        public List<string?> ListProperty { get; } = new List<string?>();
        public List<string?> ListReturn() => new List<string?>();
        public void Take(List<string?> items) { }
#nullable disable
        public string Oblivious() => null;
#nullable enable
        public string FillerOne = "";
        public string FillerTwo = "";
        public string FillerThree = "";
        public string Filler4 = "";
        public string Filler5 = "";
        public string Filler6 = "";
        public string Filler7 = "";
        public string Filler8 = "";
        public string Filler9 = "";
        public string Filler10 = "";
        public string Filler11 = "";
        public string Filler12 = "";
        public string? MaybeField;
        public string? MaybeProperty { get; set; }
        public string? MaybeReturn(string first, string second) => null;
        public void TakeMaybe(string? item, string first, string second) { }
    }
}`

    private func LoadHolder(resolver ReferenceResolver, fixture CSharpFixture) Type {
        let name = Path.GetFileNameWithoutExtension(fixture.AssemblyPath)
        let assembly = resolver.Assemblies.First((candidate Assembly) -> candidate.GetName().Name == name)
        return assembly.GetType("Sig5125.Holder")!!
    }

    @Fact
    func EachReader_DecodesOnce_AndReturnsTheSameSymbol() {
        using let fixture = CSharpFixture(FixtureSource)
        using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let holder = LoadHolder(resolver, fixture)
        let field = holder.GetField("ListField")!!
        let property = holder.GetProperty("ListProperty")!!
        let method = holder.GetMethod("ListReturn")!!
        let parameter = holder.GetMethod("Take")!!.GetParameters()[0]
        using let measurements = CompilationMeasurements.Start("test")

        let field1 = ClrNullability.GetFieldTypeSymbol(field)
        let property1 = ClrNullability.GetPropertyTypeSymbol(property)
        let return1 = ClrNullability.GetReturnTypeSymbol(method)
        let parameter1 = ClrNullability.GetParameterTypeSymbol(parameter)
        Assert.Equal(4L, measurements.GetCounter("metadata.signature-decodes"))
        Assert.Equal(0L, measurements.GetCounter("metadata.signature-cache-hits"))

        Assert.Same(field1, ClrNullability.GetFieldTypeSymbol(field))
        Assert.Same(property1, ClrNullability.GetPropertyTypeSymbol(property))
        Assert.Same(return1, ClrNullability.GetReturnTypeSymbol(method))
        Assert.Same(parameter1, ClrNullability.GetParameterTypeSymbol(parameter))
        Assert.Equal(4L, measurements.GetCounter("metadata.signature-decodes"))
        Assert.Equal(4L, measurements.GetCounter("metadata.signature-cache-hits"))
        // The four declarations are different members, so none answers for another.
        Assert.NotSame(field1, property1)
        Assert.NotSame(property1, return1)
        Assert.NotSame(return1, parameter1)
    }

    @Fact
    func EachNullabilityMode_KeepsItsOwnSymbol_WhenModesAlternate() {
        using let fixture = CSharpFixture(FixtureSource)
        using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let method = LoadHolder(resolver, fixture).GetMethod("Oblivious")!!
        using let measurements = CompilationMeasurements.Start("test")

        let platform = ClrNullability.GetReturnTypeSymbol(method)
        Assert.IsType[PlatformTypeSymbol](platform)
        var legacy TypeSymbol? = nil
        {
            using let scope_ = NullabilityOptions.Enter(NullabilityMode.Enabled)
            legacy = ClrNullability.GetReturnTypeSymbol(method)
        }
        Assert.IsType[NullableTypeSymbol](legacy!!)
        for var i = 0; i < 3; i++ {
            Assert.Same(platform, ClrNullability.GetReturnTypeSymbol(method))
            using let scope_ = NullabilityOptions.Enter(NullabilityMode.Enabled)
            Assert.Same(legacy!!, ClrNullability.GetReturnTypeSymbol(method))
        }
        Assert.Equal(2L, measurements.GetCounter("metadata.signature-decodes"))
        Assert.Equal(6L, measurements.GetCounter("metadata.signature-cache-hits"))
    }

    @Fact
    func ConcurrentFirstReads_DecodeOnce_AndShareTheSymbol() {
        using let fixture = CSharpFixture(FixtureSource)
        using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let method = LoadHolder(resolver, fixture).GetMethod("ListReturn")!!
        using let measurements = CompilationMeasurements.Start("test")
        const workers = 8
        using let barrier = Barrier(workers)
        let tasks = List[Task[TypeSymbol]]()
        for var i = 0; i < workers; i++ {
            tasks.Add(
                Task.Run(
                    () -> {
                        barrier.SignalAndWait()
                        return ClrNullability.GetReturnTypeSymbol(method)
                    }
                )
            )
        }
        let symbols = Task.WhenAll(tasks).GetAwaiter().GetResult()
        Assert.Equal(workers, symbols.Length)
        for symbol in symbols {
            Assert.Same(symbols[0], symbol)
        }
        Assert.Equal(1L, measurements.GetCounter("metadata.signature-decodes"))
        Assert.Equal(int64(workers - 1), measurements.GetCounter("metadata.signature-cache-hits"))
    }

    @Fact
    func SeparateReferenceSets_NeverShareADecodedSymbol() {
        using let fixture = CSharpFixture(FixtureSource)
        using let first = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        using let second = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let firstMethod = LoadHolder(first, fixture).GetMethod("ListReturn")!!
        let secondMethod = LoadHolder(second, fixture).GetMethod("ListReturn")!!
        Assert.NotSame(firstMethod, secondMethod)
        using let measurements = CompilationMeasurements.Start("test")

        let firstSymbol = ClrNullability.GetReturnTypeSymbol(firstMethod)
        let secondSymbol = ClrNullability.GetReturnTypeSymbol(secondMethod)

        // One decode per reference set: the same signature in a second set is
        // decoded again and yields its own symbol.
        Assert.Equal(2L, measurements.GetCounter("metadata.signature-decodes"))
        Assert.Equal(0L, measurements.GetCounter("metadata.signature-cache-hits"))
        Assert.NotSame(firstSymbol, secondSymbol)
        Assert.Same(firstSymbol, ClrNullability.GetReturnTypeSymbol(firstMethod))
        Assert.Same(secondSymbol, ClrNullability.GetReturnTypeSymbol(secondMethod))
    }

    // A failed metadata read falls back to a default. Caching that fallback
    // would keep the member wrong after the read starts to succeed.
    private func AssertFallbackIsNotCached(read() -> TypeSymbol) {
        using let measurements = CompilationMeasurements.Start("test")
        let fallback = read()
        Assert.IsNotType[NullableTypeSymbol](fallback)
        Assert.Equal(1L, measurements.GetCounter("metadata.signature-decode-failures"))
        Assert.Equal(0L, measurements.GetCounter("metadata.signature-decodes"))
        let recovered = read()
        Assert.IsType[NullableTypeSymbol](recovered)
        Assert.Equal(1L, measurements.GetCounter("metadata.signature-decodes"))
        Assert.Same(recovered, read())
        Assert.Equal(1L, measurements.GetCounter("metadata.signature-cache-hits"))
        Assert.Equal(1L, measurements.GetCounter("metadata.signature-decode-failures"))
    }

    @Fact
    func FailedFieldAttributeRead_IsNotCached() {
        using let fixture = CSharpFixture(FixtureSource)
        using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let flaky = FailsFirstField(LoadHolder(resolver, fixture).GetField("MaybeField")!!)
        AssertFallbackIsNotCached(() -> ClrNullability.GetFieldTypeSymbol(flaky))
    }

    @Fact
    func FailedPropertyAttributeRead_IsNotCached() {
        using let fixture = CSharpFixture(FixtureSource)
        using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let flaky = FailsFirstProperty(LoadHolder(resolver, fixture).GetProperty("MaybeProperty")!!)
        AssertFallbackIsNotCached(() -> ClrNullability.GetPropertyTypeSymbol(flaky))
    }

    @Fact
    func FailedReturnAttributeRead_IsNotCached() {
        using let fixture = CSharpFixture(FixtureSource)
        using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let flaky = FailsFirstReturn(LoadHolder(resolver, fixture).GetMethod("MaybeReturn")!!)
        AssertFallbackIsNotCached(() -> ClrNullability.GetReturnTypeSymbol(flaky))
    }

    @Fact
    func FailedParameterAttributeRead_IsNotCached() {
        using let fixture = CSharpFixture(FixtureSource)
        using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let method = LoadHolder(resolver, fixture).GetMethod("TakeMaybe")!!
        let flaky = FailsFirstParameter(method.GetParameters()[0])
        AssertFallbackIsNotCached(() -> ClrNullability.GetParameterTypeSymbol(flaky))
    }

    private class FailsFirstParameter : ParameterInfo {
        private let parameter ParameterInfo
        private var reads int32

        internal init(parameter ParameterInfo) {
            this.parameter = parameter
        }

        override func GetCustomAttributesData() IList[CustomAttributeData] {
            reads++
            if reads == 1 {
                throw FileNotFoundException("retryable metadata read")
            }
            return parameter.GetCustomAttributesData()
        }

        override prop ParameterType Type -> parameter.ParameterType
        override prop Position int32 -> parameter.Position
        override prop Member MemberInfo -> parameter.Member
        override prop Name string? -> parameter.Name
        override prop Attributes ParameterAttributes -> parameter.Attributes
        override prop HasDefaultValue bool -> parameter.HasDefaultValue
        override prop RawDefaultValue object? -> parameter.RawDefaultValue
    }

    private class FailsFirstReturn : MethodInfo {
        private let method MethodInfo
        private let returnParameter FailsFirstParameter

        internal init(method MethodInfo) {
            this.method = method
            returnParameter = FailsFirstParameter(method.ReturnParameter)
        }

        override prop ReturnParameter ParameterInfo -> returnParameter
        override prop Name string -> method.Name
        override prop DeclaringType Type? -> method.DeclaringType
        override prop ReflectedType Type? -> method.ReflectedType
        override prop Attributes MethodAttributes -> method.Attributes
        override prop MethodHandle RuntimeMethodHandle -> method.MethodHandle
        override prop ReturnType Type -> method.ReturnType
        override prop ReturnTypeCustomAttributes ICustomAttributeProvider -> method.ReturnTypeCustomAttributes
        override prop MetadataToken int32 -> method.MetadataToken
        override prop Module Module -> method.Module

        override func GetCustomAttributesData() IList[CustomAttributeData] -> method.GetCustomAttributesData()

        override func GetParameters()[]ParameterInfo -> method.GetParameters()

        override func GetBaseDefinition() MethodInfo -> method.GetBaseDefinition()

        override func GetMethodImplementationFlags() MethodImplAttributes -> method.GetMethodImplementationFlags()

        override func GetCustomAttributes(inherit bool)[]object -> method.GetCustomAttributes(inherit)

        override func GetCustomAttributes(attributeType Type, inherit bool)[]object -> method.GetCustomAttributes(
            attributeType,
            inherit
        )

        override func IsDefined(attributeType Type, inherit bool) bool -> method.IsDefined(attributeType, inherit)

        override func Invoke(
            obj object?,
            invokeAttr BindingFlags,
            binder System.Reflection.Binder?,
            parameters[]?object?,
            culture CultureInfo?
        ) object? -> method.Invoke(obj, invokeAttr, binder, parameters, culture)
    }

    private class FailsFirstProperty : PropertyInfo {
        private let property PropertyInfo
        private var reads int32

        internal init(property PropertyInfo) {
            this.property = property
        }

        override func GetCustomAttributesData() IList[CustomAttributeData] {
            reads++
            if reads == 1 {
                throw FileNotFoundException("retryable metadata read")
            }
            return property.GetCustomAttributesData()
        }

        override prop Name string -> property.Name
        override prop DeclaringType Type? -> property.DeclaringType
        override prop ReflectedType Type? -> property.ReflectedType
        override prop PropertyType Type -> property.PropertyType
        override prop Attributes PropertyAttributes -> property.Attributes
        override prop CanRead bool -> property.CanRead
        override prop CanWrite bool -> property.CanWrite
        override prop MetadataToken int32 -> property.MetadataToken
        override prop Module Module -> property.Module

        override func GetAccessors(nonPublic bool)[]MethodInfo -> property.GetAccessors(nonPublic)

        override func GetGetMethod(nonPublic bool) MethodInfo? -> property.GetGetMethod(nonPublic)

        override func GetSetMethod(nonPublic bool) MethodInfo? -> property.GetSetMethod(nonPublic)

        override func GetIndexParameters()[]ParameterInfo -> property.GetIndexParameters()

        override func GetValue(
            obj object?,
            invokeAttr BindingFlags,
            binder System.Reflection.Binder?,
            index[]?object?,
            culture CultureInfo?
        ) object? -> property.GetValue(obj, invokeAttr, binder, index, culture)

        override func SetValue(
            obj object?,
            value object?,
            invokeAttr BindingFlags,
            binder System.Reflection.Binder?,
            index[]?object?,
            culture CultureInfo?
        ) {
            property.SetValue(obj, value, invokeAttr, binder, index, culture)
        }

        override func GetCustomAttributes(inherit bool)[]object -> property.GetCustomAttributes(inherit)

        override func GetCustomAttributes(attributeType Type, inherit bool)[]object -> property.GetCustomAttributes(
            attributeType,
            inherit
        )

        override func IsDefined(attributeType Type, inherit bool) bool -> property.IsDefined(attributeType, inherit)
    }

    private class FailsFirstField : FieldInfo {
        private let field FieldInfo
        private var reads int32

        internal init(field FieldInfo) {
            this.field = field
        }

        override func GetCustomAttributesData() IList[CustomAttributeData] {
            reads++
            if reads == 1 {
                throw FileNotFoundException("retryable metadata read")
            }
            return field.GetCustomAttributesData()
        }

        override prop Name string -> field.Name
        override prop DeclaringType Type? -> field.DeclaringType
        override prop ReflectedType Type? -> field.ReflectedType
        override prop FieldType Type -> field.FieldType
        override prop Attributes FieldAttributes -> field.Attributes
        override prop FieldHandle RuntimeFieldHandle -> field.FieldHandle
        override prop MetadataToken int32 -> field.MetadataToken
        override prop Module Module -> field.Module

        override func GetValue(obj object?) object? -> field.GetValue(obj)

        override func SetValue(
            obj object?,
            value object?,
            invokeAttr BindingFlags,
            binder System.Reflection.Binder?,
            culture CultureInfo?
        ) {
            field.SetValue(obj, value, invokeAttr, binder, culture)
        }

        override func GetCustomAttributes(inherit bool)[]object -> field.GetCustomAttributes(inherit)

        override func GetCustomAttributes(attributeType Type, inherit bool)[]object -> field.GetCustomAttributes(
            attributeType,
            inherit
        )

        override func IsDefined(attributeType Type, inherit bool) bool -> field.IsDefined(attributeType, inherit)
    }
}
