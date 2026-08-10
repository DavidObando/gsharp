// <copyright file="Issue2443ExternalClrOverrideEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2443: overrides can target virtual members inherited from imported
/// CLR base classes instead of only members represented by a G# BaseClass.
/// </summary>
public sealed class Issue2443ExternalClrOverrideEmitTests
{
    private static readonly Lazy<string> ExternalBaseAssembly = new(EmitExternalBaseAssembly);

    [Fact]
    public void ImplicitObjectOverrides_SourceChainsAndGenericClasses_DispatchAndReflectBaseSlots()
    {
        const string Source = """
            package Issue2486
            import System

            open class Root[T] {
            }

            class Derived : Root[int32] {
                override func ToString() string -> "derived"
                override func GetHashCode() int32 -> 2486
                override func Equals(value object) bool -> true
            }

            open class OpenImplicit {
                override func ToString() string -> "open"
            }

            class Generic[T] {
                override func ToString() string -> "generic"
            }

            func Main() {
                let value object = Derived()
                Console.WriteLine(value.ToString())
                Console.WriteLine(value.GetHashCode())
                Console.WriteLine(value.Equals(Derived()))
            }
            """;

        var result = Compile(Source, target: "exe");
        try
        {
            Assert.Equal($"derived{Environment.NewLine}2486{Environment.NewLine}True{Environment.NewLine}", Run(result.OutputPath));
            IlVerifier.Verify(result.OutputPath);

            var assembly = Assembly.LoadFrom(result.OutputPath);
            var derived = assembly.GetType("Issue2486.Derived")!;
            AssertOverrideSlot(
                derived.GetMethod("ToString", BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)!,
                typeof(object).GetMethod("ToString")!);
            AssertOverrideSlot(
                derived.GetMethod("GetHashCode", BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)!,
                typeof(object).GetMethod("GetHashCode")!);
            AssertOverrideSlot(
                derived.GetMethod("Equals", BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)!,
                typeof(object).GetMethod("Equals", new[] { typeof(object) })!);

            var openImplicit = assembly.GetType("Issue2486.OpenImplicit")!;
            Assert.False(openImplicit.IsSealed);
            AssertOverrideSlot(openImplicit.GetMethod("ToString")!, typeof(object).GetMethod("ToString")!);

            var generic = assembly.GetType("Issue2486.Generic`1")!;
            Assert.True(generic.IsSealed);
            AssertOverrideSlot(generic.GetMethod("ToString")!, typeof(object).GetMethod("ToString")!);

            var consumerPath = EmitImplicitObjectConsumer(result.DirectoryPath, result.OutputPath);
            Assert.Equal($"derived{Environment.NewLine}2486{Environment.NewLine}True{Environment.NewLine}generic{Environment.NewLine}", Run(consumerPath));
        }
        finally
        {
            result.Dispose();
        }
    }

    [Fact]
    public void PlainStructObjectOverrides_AllShapes_DispatchReflectAndEmitExpectedCallSites()
    {
        const string Source = """
            package Issue2896
            import System

            interface IMarker {
                func Marker() string;
            }

            struct ToStringOnly {
                var Number int32
                override func ToString() string -> "OVERRIDDEN-11"
            }

            struct EqualsOnly {
                var Number int32
                override func Equals(value object) bool -> false
            }

            struct HashOnly {
                var Number int32
                override func GetHashCode() int32 -> 289613
            }

            struct AllValue {
                var Number int32
                override func ToString() string -> "ALL-OVERRIDDEN-17"
                override func Equals(value object) bool -> false
                override func GetHashCode() int32 -> 289617
            }

            struct GenericValue[T any] {
                var Item T
                override func ToString() string -> "GENERIC-OVERRIDDEN-23"
            }

            struct InterfaceValue : IMarker {
                var Number int32
                func Marker() string -> "MARKER-31"
                override func ToString() string -> "INTERFACE-OVERRIDDEN-31"
            }

            struct OperatorValue : IEquatable[OperatorValue] {
                var Number int32
                func Equals(other OperatorValue) bool -> Number == other.Number
                override func Equals(value object) bool -> false
                override func GetHashCode() int32 -> 289637
            }

            func (left OperatorValue) operator ==(right OperatorValue) bool ->
                left.Number == right.Number

            func (left OperatorValue) operator !=(right OperatorValue) bool ->
                left.Number != right.Number

            class Container {
                struct NestedValue {
                    var Number int32
                    override func ToString() string -> "NESTED-OVERRIDDEN-41"
                }
            }

            struct SharedValue {
                var Number int32
                shared {
                    func Label() string -> "SHARED-43"
                }
                override func ToString() string -> "SHARED-OVERRIDDEN-43"
            }

            data struct DataValue {
                var Number int32
            }

            struct DefaultValue {
                var Number int32
            }

            func PrintGeneric[T any](value T) {
                Console.WriteLine(value.ToString())
            }

            func CallSiteProbe(value AllValue, boxed object, peer object) {
                Console.WriteLine(value.ToString())
                Console.WriteLine(boxed.ToString())
                Console.WriteLine(value.Equals(peer))
                Console.WriteLine(boxed.Equals(peer))
                Console.WriteLine(value.GetHashCode())
                Console.WriteLine(boxed.GetHashCode())
            }

            let toStringValue = ToStringOnly{Number: 7}
            let boxedToString object = toStringValue
            Console.WriteLine(toStringValue.ToString())
            Console.WriteLine(boxedToString.ToString())

            let equalsValue = EqualsOnly{Number: 7}
            let equalsPeer object = EqualsOnly{Number: 7}
            let boxedEquals object = equalsValue
            Console.WriteLine(equalsValue.Equals(equalsPeer))
            Console.WriteLine(boxedEquals.Equals(equalsPeer))

            let hashValue = HashOnly{Number: 7}
            let boxedHash object = hashValue
            Console.WriteLine(hashValue.GetHashCode())
            Console.WriteLine(boxedHash.GetHashCode())

            let allValue = AllValue{Number: 7}
            let allPeer object = AllValue{Number: 7}
            let boxedAll object = allValue
            Console.WriteLine(allValue.ToString())
            Console.WriteLine(boxedAll.ToString())
            Console.WriteLine(allValue.Equals(allPeer))
            Console.WriteLine(boxedAll.Equals(allPeer))
            Console.WriteLine(allValue.GetHashCode())
            Console.WriteLine(boxedAll.GetHashCode())
            CallSiteProbe(allValue, boxedAll, allPeer)

            let genericValue = GenericValue[int32]{Item: 7}
            Console.WriteLine(genericValue.ToString())
            PrintGeneric(genericValue)

            let interfaceValue = InterfaceValue{Number: 7}
            let boxedInterface object = interfaceValue
            Console.WriteLine(interfaceValue.Marker())
            Console.WriteLine(interfaceValue.ToString())
            Console.WriteLine(boxedInterface.ToString())

            let operatorLeft = OperatorValue{Number: 7}
            let operatorRight = OperatorValue{Number: 7}
            let boxedOperator object = operatorLeft
            Console.WriteLine(operatorLeft == operatorRight)
            Console.WriteLine(operatorLeft.Equals(operatorRight))
            Console.WriteLine(boxedOperator.Equals(operatorRight))
            Console.WriteLine(boxedOperator.GetHashCode())

            let nestedValue = Container.NestedValue{Number: 7}
            let boxedNested object = nestedValue
            Console.WriteLine(nestedValue.ToString())
            Console.WriteLine(boxedNested.ToString())

            let sharedValue = SharedValue{Number: 7}
            let boxedShared object = sharedValue
            Console.WriteLine(SharedValue.Label())
            Console.WriteLine(sharedValue.ToString())
            Console.WriteLine(boxedShared.ToString())

            let dataValue = DataValue{Number: 7}
            let boxedData object = dataValue
            Console.WriteLine(dataValue.ToString())
            Console.WriteLine(boxedData.ToString())

            let defaultValue = DefaultValue{Number: 7}
            let boxedDefault object = defaultValue
            Console.WriteLine(defaultValue.ToString())
            Console.WriteLine(boxedDefault.ToString())
            """;

        var result = Compile(Source, target: "exe");
        try
        {
            Assert.Equal(
                """
                OVERRIDDEN-11
                OVERRIDDEN-11
                False
                False
                289613
                289613
                ALL-OVERRIDDEN-17
                ALL-OVERRIDDEN-17
                False
                False
                289617
                289617
                ALL-OVERRIDDEN-17
                ALL-OVERRIDDEN-17
                False
                False
                289617
                289617
                GENERIC-OVERRIDDEN-23
                GENERIC-OVERRIDDEN-23
                MARKER-31
                INTERFACE-OVERRIDDEN-31
                INTERFACE-OVERRIDDEN-31
                True
                True
                False
                289637
                NESTED-OVERRIDDEN-41
                NESTED-OVERRIDDEN-41
                SHARED-43
                SHARED-OVERRIDDEN-43
                SHARED-OVERRIDDEN-43
                DataValue(Number=7)
                DataValue(Number=7)
                Issue2896.DefaultValue
                Issue2896.DefaultValue
                """.ReplaceLineEndings(Environment.NewLine) + Environment.NewLine,
                Run(result.OutputPath));

            var assembly = Assembly.Load(File.ReadAllBytes(result.OutputPath));
            var types = assembly.GetTypes();
            var objectToString = typeof(object).GetMethod(nameof(object.ToString))!;
            var objectEquals = typeof(object).GetMethod(nameof(object.Equals), new[] { typeof(object) })!;
            var objectGetHashCode = typeof(object).GetMethod(nameof(object.GetHashCode))!;

            AssertValueTypeObjectOverride(
                types.Single(type => type.FullName == "Issue2896.ToStringOnly").GetMethod(nameof(object.ToString))!,
                objectToString);
            AssertValueTypeObjectOverride(
                types.Single(type => type.FullName == "Issue2896.EqualsOnly").GetMethod(nameof(object.Equals), new[] { typeof(object) })!,
                objectEquals);
            AssertValueTypeObjectOverride(
                types.Single(type => type.FullName == "Issue2896.HashOnly").GetMethod(nameof(object.GetHashCode))!,
                objectGetHashCode);

            var allType = types.Single(type => type.FullName == "Issue2896.AllValue");
            AssertValueTypeObjectOverride(allType.GetMethod(nameof(object.ToString))!, objectToString);
            AssertValueTypeObjectOverride(allType.GetMethod(nameof(object.Equals), new[] { typeof(object) })!, objectEquals);
            AssertValueTypeObjectOverride(allType.GetMethod(nameof(object.GetHashCode))!, objectGetHashCode);

            AssertValueTypeObjectOverride(
                types.Single(type => type.FullName == "Issue2896.GenericValue`1").GetMethod(nameof(object.ToString))!,
                objectToString);
            AssertValueTypeObjectOverride(
                types.Single(type => type.FullName == "Issue2896.InterfaceValue").GetMethod(nameof(object.ToString))!,
                objectToString);

            var operatorType = types.Single(type => type.FullName == "Issue2896.OperatorValue");
            AssertValueTypeObjectOverride(operatorType.GetMethod(nameof(object.Equals), new[] { typeof(object) })!, objectEquals);
            AssertValueTypeObjectOverride(operatorType.GetMethod(nameof(object.GetHashCode))!, objectGetHashCode);
            AssertValueTypeObjectOverride(
                types.Single(type => type.FullName == "Issue2896.Container+NestedValue").GetMethod(nameof(object.ToString))!,
                objectToString);
            AssertValueTypeObjectOverride(
                types.Single(type => type.FullName == "Issue2896.SharedValue").GetMethod(nameof(object.ToString))!,
                objectToString);

            var dataType = types.Single(type => type.FullName == "Issue2896.DataValue");
            AssertValueTypeObjectOverride(dataType.GetMethod(nameof(object.ToString))!, objectToString);
            var defaultType = types.Single(type => type.FullName == "Issue2896.DefaultValue");
            Assert.Null(defaultType.GetMethod(
                nameof(object.ToString),
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly));

            using var peReader = new PEReader(File.OpenRead(result.OutputPath));
            var metadata = peReader.GetMetadataReader();
            AssertMethodImplCount(metadata, "ToStringOnly", 1);
            AssertMethodImplCount(metadata, "EqualsOnly", 1);
            AssertMethodImplCount(metadata, "HashOnly", 1);
            AssertMethodImplCount(metadata, "AllValue", 3);
            AssertMethodImplCount(metadata, "GenericValue`1", 1);
            AssertMethodImplCount(metadata, "InterfaceValue", 1);
            AssertMethodImplCount(metadata, "OperatorValue", 2);
            AssertMethodImplCount(metadata, "NestedValue", 1);
            AssertMethodImplCount(metadata, "SharedValue", 1);

            var programType = types.Single(type => type.Name == "<Program>");
            var callSiteProbe = programType.GetMethod("CallSiteProbe", BindingFlags.Static | BindingFlags.Public)!;
            var callSiteInstructions = IlInstructionReader.Read(callSiteProbe.GetMethodBody()!.GetILAsByteArray()!);
            Assert.Contains(
                callSiteInstructions,
                instruction => instruction.OpCode == OpCodes.Call
                    && callSiteProbe.Module.ResolveMethod(instruction.MetadataToken!.Value)?.DeclaringType == allType);
            Assert.Contains(
                callSiteInstructions,
                instruction => instruction.OpCode == OpCodes.Callvirt
                    && callSiteProbe.Module.ResolveMethod(instruction.MetadataToken!.Value)?.DeclaringType == typeof(object));

            var printGeneric = programType.GetMethod("PrintGeneric", BindingFlags.Static | BindingFlags.Public)!;
            var genericInstructions = IlInstructionReader.Read(printGeneric.GetMethodBody()!.GetILAsByteArray()!);
            var constrainedIndex = Array.FindIndex(
                genericInstructions,
                instruction => instruction.OpCode == OpCodes.Constrained);
            Assert.True(constrainedIndex >= 0);
            Assert.Equal(OpCodes.Callvirt, genericInstructions[constrainedIndex + 1].OpCode);
            Assert.Equal(
                typeof(object),
                printGeneric.Module.ResolveMethod(genericInstructions[constrainedIndex + 1].MetadataToken!.Value)?.DeclaringType);
        }
        finally
        {
            result.Dispose();
        }
    }

    [Fact]
    public void MatchingImplicitObjectVirtualWithoutOverride_RemainsAnAcceptedShadow()
    {
        const string Source = """
            package Issue2486

            class Shadow {
                func ToString() string -> "shadow"
            }
            """;

        var result = Compile(Source, target: "library");
        try
        {
            IlVerifier.Verify(result.OutputPath);

            var assembly = Assembly.LoadFrom(result.OutputPath);
            var type = assembly.GetType("Issue2486.Shadow")!;
            var instance = Activator.CreateInstance(type);
            var shadow = type.GetMethod("ToString", BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)!;

            Assert.True((shadow.Attributes & MethodAttributes.NewSlot) != 0);
            Assert.Equal("shadow", shadow.Invoke(instance, null));
            Assert.Equal("Issue2486.Shadow", typeof(object).GetMethod("ToString")!.Invoke(instance, null));
        }
        finally
        {
            result.Dispose();
        }
    }

    [Theory]
    [InlineData("""
        package Issue2486
        class Bad {
            override func ToString(value int32) string -> "bad"
        }
        """, "GS0185")]
    [InlineData("""
        package Issue2486
        class Bad {
            protected override func MemberwiseClone() object -> this
        }
        """, "GS0184")]
    [InlineData("""
        package Issue2486
        class Bad {
            override func Missing() string -> "bad"
        }
        """, "GS0183")]
    public void ImplicitObjectOverride_InvalidShapesRetainSpecificDiagnostics(string source, string diagnosticId)
    {
        var result = TryCompile(source, "library");
        try
        {
            Assert.NotEqual(0, result.ExitCode);
            Assert.Contains(diagnosticId, result.Stdout + result.Stderr, StringComparison.Ordinal);
        }
        finally
        {
            result.Dispose();
        }
    }

    [Fact]
    public void BclObjectOverride_DispatchesAndReflectsBaseSlot()
    {
        const string Source = """
            package Issue2443
            import System

            class Derived : Object {
                override func ToString() string -> "derived"
            }

            func Main() {
                let value object = Derived()
                Console.WriteLine(value.ToString())
            }
            """;

        var result = Compile(Source, target: "exe");
        try
        {
            Assert.Equal($"derived{Environment.NewLine}", Run(result.OutputPath));
            IlVerifier.Verify(result.OutputPath);

            var assembly = Assembly.LoadFrom(result.OutputPath);
            var method = assembly.GetType("Issue2443.Derived")!.GetMethod(
                "ToString",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)!;

            Assert.True(method.IsVirtual);
            Assert.True(method.IsFinal);
            Assert.False((method.Attributes & MethodAttributes.NewSlot) != 0);
            Assert.Equal(typeof(object).GetMethod("ToString"), method.GetBaseDefinition());
        }
        finally
        {
            result.Dispose();
        }
    }

    [Fact]
    public void SiblingAssemblyOverrides_MethodsPropertiesEventsGenericsAndCovariance_WorkForCSharpConsumer()
    {
        const string Source = """
            package Issue2443
            import System
            import Issue2443Base

            open class Derived : ExternalBase[int32] {
                override func Echo(value int32) string -> "echo:" + value.ToString()
                override func Identity[U](value U) U -> value
                override func Covariant() Marker -> Marker()
                override prop Value int32 { get { return 7 } }
                override prop this[index int32] int32 { get { return index + 10 } }
                override event Changed EventHandler {
                    add { }
                    remove { }
                }
                protected override func ProtectedCore(value int32) int32 -> value + 1
                override func AbstractName() string -> "abstract"
            }

            open class AbstractDerived : ExternalBase[int32] {
                open override func AbstractName() string;
            }

            open class GenericDerived[T] : ExternalBase[T] {
                override func Echo(value T) string -> "generic"
                override func AbstractName() string -> "generic-abstract"
            }
            """;

        var result = Compile(Source, target: "library", ExternalBaseAssembly.Value);
        try
        {
            IlVerifier.Verify(result.OutputPath, additionalReferences: new[] { ExternalBaseAssembly.Value });

            var baseAssembly = Assembly.LoadFrom(ExternalBaseAssembly.Value);
            var derivedAssembly = Assembly.LoadFrom(result.OutputPath);
            var derived = derivedAssembly.GetType("Issue2443.Derived")!;
            var closedBase = baseAssembly.GetType("Issue2443Base.ExternalBase`1")!.MakeGenericType(typeof(int));

            AssertOverrideSlot(derived.GetMethod("Echo")!, closedBase.GetMethod("Echo")!);
            AssertOverrideSlot(derived.GetMethod("Identity")!, closedBase.GetMethod("Identity")!);
            AssertVirtualReuseSlot(derived.GetMethod("Covariant")!);
            AssertOverrideSlot(derived.GetProperty("Value")!.GetMethod!, closedBase.GetProperty("Value")!.GetMethod!);
            AssertOverrideSlot(
                derived.GetProperty("Item")!.GetMethod!,
                closedBase.GetProperty("Item")!.GetMethod!);
            AssertOverrideSlot(
                derived.GetEvent("Changed")!.AddMethod!,
                closedBase.GetEvent("Changed")!.AddMethod!);

            Assert.Equal(
                baseAssembly.GetType("Issue2443Base.Marker"),
                derived.GetMethod("Covariant")!.ReturnType);

            var abstractDerived = derivedAssembly.GetType("Issue2443.AbstractDerived")!;
            Assert.True(abstractDerived.IsAbstract);
            Assert.True(abstractDerived.GetMethod("AbstractName")!.IsAbstract);
            AssertOverrideSlot(
                abstractDerived.GetMethod("AbstractName")!,
                closedBase.GetMethod("AbstractName")!);

            var genericDerived = derivedAssembly.GetType("Issue2443.GenericDerived`1")!;
            Assert.True(genericDerived.BaseType!.IsGenericType);
            Assert.Equal(
                genericDerived.GetGenericArguments()[0],
                genericDerived.BaseType.GetGenericArguments()[0]);

            var consumerPath = EmitCSharpConsumer(result.DirectoryPath, result.OutputPath, ExternalBaseAssembly.Value);
            Assert.Equal(
                $"echo:4{Environment.NewLine}id{Environment.NewLine}Marker{Environment.NewLine}7{Environment.NewLine}13{Environment.NewLine}5{Environment.NewLine}abstract{Environment.NewLine}generic{Environment.NewLine}generic-abstract{Environment.NewLine}",
                Run(consumerPath));
        }
        finally
        {
            result.Dispose();
        }
    }

    [Fact]
    public void MatchingExternalVirtualWithoutOverride_RemainsAnAcceptedShadow()
    {
        const string Source = """
            package Issue2443
            import Issue2443Base

            class ShadowingDerived : ExternalBase[int32] {
                func Echo(value int32) string -> "shadow"
                override func AbstractName() string -> "abstract"
            }
            """;

        var result = Compile(Source, target: "library", ExternalBaseAssembly.Value);
        try
        {
            var baseAssembly = Assembly.LoadFrom(ExternalBaseAssembly.Value);
            var derivedAssembly = Assembly.LoadFrom(result.OutputPath);
            var derivedType = derivedAssembly.GetType("Issue2443.ShadowingDerived")!;
            var instance = Activator.CreateInstance(derivedType);
            var closedBase = baseAssembly.GetType("Issue2443Base.ExternalBase`1")!.MakeGenericType(typeof(int));
            var shadow = derivedType.GetMethod("Echo", BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)!;

            Assert.True((shadow.Attributes & MethodAttributes.NewSlot) != 0);
            Assert.Equal("shadow", shadow.Invoke(instance, new object[] { 1 }));
            Assert.Equal("base", closedBase.GetMethod("Echo")!.Invoke(instance, new object[] { 1 }));
        }
        finally
        {
            result.Dispose();
        }
    }

    [Theory]
    [InlineData("""
        package Issue2443
        import Issue2443Base
        class Bad : SealedBase {
            override func ToString() string -> "bad"
        }
        """, "GS0184")]
    [InlineData("""
        package Issue2443
        import Issue2443Base
        class Bad : ExternalBase[int32] {
            override func Echo(value string) string -> value
            override func AbstractName() string -> "abstract"
        }
        """, "GS0185")]
    public void InvalidExplicitExternalOverrideShapes_Report(string source, string diagnosticId)
    {
        var result = TryCompile(source, "library", ExternalBaseAssembly.Value);
        try
        {
            Assert.NotEqual(0, result.ExitCode);
            Assert.Contains(diagnosticId, result.Stdout + result.Stderr, StringComparison.Ordinal);
        }
        finally
        {
            result.Dispose();
        }
    }

    private static void AssertOverrideSlot(MethodInfo implementation, MethodInfo declaration)
    {
        AssertVirtualReuseSlot(implementation);
        Assert.Equal(declaration.GetBaseDefinition().MetadataToken, implementation.GetBaseDefinition().MetadataToken);
        Assert.Equal(declaration.GetBaseDefinition().Module, implementation.GetBaseDefinition().Module);
    }

    private static void AssertVirtualReuseSlot(MethodInfo implementation)
    {
        Assert.True(implementation.IsVirtual);
        Assert.False((implementation.Attributes & MethodAttributes.NewSlot) != 0);
    }

    private static void AssertValueTypeObjectOverride(MethodInfo implementation, MethodInfo declaration)
    {
        AssertOverrideSlot(implementation, declaration);
        Assert.True(implementation.IsFinal);
        Assert.True(implementation.IsHideBySig);
    }

    private static void AssertMethodImplCount(MetadataReader reader, string typeName, int expected)
    {
        var type = reader.TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single(definition => reader.GetString(definition.Name) == typeName);
        Assert.Equal(expected, type.GetMethodImplementations().Count);
    }

    private static CompilationResult Compile(string source, string target, params string[] references)
    {
        var result = TryCompile(source, target, references);
        Assert.True(
            result.ExitCode == 0,
            $"gsc failed ({result.ExitCode}):\nstdout:\n{result.Stdout}\nstderr:\n{result.Stderr}");
        return result;
    }

    private static CompilationResult TryCompile(string source, string target, params string[] references)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue2443_").FullName;
        var sourcePath = Path.Combine(directory, "test.gs");
        var assemblyName = "Issue2443Derived_" + Guid.NewGuid().ToString("N");
        var outputPath = Path.Combine(directory, assemblyName + ".dll");
        File.WriteAllText(sourcePath, source);

        var args = new List<string>
        {
            "/out:" + outputPath,
            "/assemblyname:" + assemblyName,
            "/target:" + target,
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };
        foreach (var reference in references)
        {
            args.Add("/r:" + reference);
        }

        foreach (var reference in BclReferences.Value)
        {
            args.Add("/r:" + reference);
        }

        args.Add(sourcePath);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        if (File.Exists(ExternalBaseAssembly.Value))
        {
            File.Copy(
                ExternalBaseAssembly.Value,
                Path.Combine(directory, Path.GetFileName(ExternalBaseAssembly.Value)),
                overwrite: true);
        }

        return new CompilationResult(directory, outputPath, exitCode, stdout.ToString(), stderr.ToString());
    }

    private static string EmitExternalBaseAssembly()
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2443ExternalBase");
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, "Issue2443Base.dll");
        const string Source = """
            using System;

            namespace Issue2443Base;

            public sealed class Marker
            {
            }

            public abstract class ExternalBase<T>
            {
                public virtual int Value => -1;

                public virtual T this[int index] => default!;

                public virtual event EventHandler Changed
                {
                    add { }
                    remove { }
                }

                public virtual string Echo(T value) => "base";

                public virtual U Identity<U>(U value) => value;

                public virtual object Covariant() => new object();

                public abstract string AbstractName();

                public int CallProtected(int value) => ProtectedCore(value);

                protected virtual int ProtectedCore(int value) => -1;
            }

            public class SealedBase
            {
                public sealed override string ToString() => "sealed";
            }
            """;

        EmitCSharpAssembly(path, "Issue2443Base", Source, OutputKind.DynamicallyLinkedLibrary);
        return path;
    }

    private static string EmitCSharpConsumer(string directory, string gsharpAssembly, string baseAssembly)
    {
        var outputPath = Path.Combine(directory, "Issue2443Consumer.dll");
        const string Source = """
            using System;
            using Issue2443;
            using Issue2443Base;

            internal static class Program
            {
                private static void Main()
                {
                    ExternalBase<int> value = new Derived();
                    value.Changed += (_, _) => { };
                    Console.WriteLine(value.Echo(4));
                    Console.WriteLine(value.Identity("id"));
                    Console.WriteLine(value.Covariant().GetType().Name);
                    Console.WriteLine(value.Value);
                    Console.WriteLine(value[3]);
                    Console.WriteLine(value.CallProtected(4));
                    Console.WriteLine(value.AbstractName());

                    ExternalBase<int> generic = new GenericDerived<int>();
                    Console.WriteLine(generic.Echo(4));
                    Console.WriteLine(generic.AbstractName());
                }
            }
            """;

        EmitCSharpAssembly(
            outputPath,
            "Issue2443Consumer",
            Source,
            OutputKind.ConsoleApplication,
            gsharpAssembly,
            baseAssembly);
        return outputPath;
    }

    private static string EmitImplicitObjectConsumer(string directory, string gsharpAssembly)
    {
        var outputPath = Path.Combine(directory, "Issue2486Consumer.dll");
        const string Source = """
            using System;
            using Issue2486;

            internal static class Program
            {
                private static void Main()
                {
                    object value = new Derived();
                    Console.WriteLine(value.ToString());
                    Console.WriteLine(value.GetHashCode());
                    Console.WriteLine(value.Equals(new Derived()));

                    object generic = new Generic<string>();
                    Console.WriteLine(generic.ToString());
                }
            }
            """;

        EmitCSharpAssembly(
            outputPath,
            "Issue2486Consumer",
            Source,
            OutputKind.ConsoleApplication,
            gsharpAssembly);
        return outputPath;
    }

    private static void EmitCSharpAssembly(
        string outputPath,
        string assemblyName,
        string source,
        OutputKind outputKind,
        params string[] additionalReferences)
    {
        var references = TrustedPlatformReferences()
            .Concat(additionalReferences.Select(path => MetadataReference.CreateFromFile(path)))
            .ToArray();
        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(outputKind));

        using var peStream = File.Create(outputPath);
        var emitResult = compilation.Emit(peStream);
        Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics));
    }

    private static string Run(string assemblyPath)
    {
        var runtimeConfigPath = Path.ChangeExtension(assemblyPath, "runtimeconfig.json");
        File.WriteAllText(runtimeConfigPath, """
            {
              "runtimeOptions": {
                "tfm": "net10.0",
                "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
              }
            }
            """);

        var startInfo = new ProcessStartInfo("dotnet", "exec \"" + assemblyPath + "\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        using var process = Process.Start(startInfo)!;
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(30_000))
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
            throw new Xunit.Sdk.XunitException("child process timed out after 30000 ms");
        }

        var stdout = stdoutTask.GetAwaiter().GetResult();
        var stderr = stderrTask.GetAwaiter().GetResult();
        Assert.True(process.ExitCode == 0, $"exit {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.ReplaceLineEndings(Environment.NewLine);
    }

    private static IEnumerable<MetadataReference> TrustedPlatformReferences()
        => ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
            ?.Split(Path.PathSeparator)
            ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => MetadataReference.CreateFromFile(path));

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDirectory) || !Directory.Exists(runtimeDirectory))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDirectory, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(path =>
            {
                var name = Path.GetFileName(path);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToArray();
    });

    private sealed class CompilationResult : IDisposable
    {
        public CompilationResult(
            string directoryPath,
            string outputPath,
            int exitCode,
            string stdout,
            string stderr)
        {
            DirectoryPath = directoryPath;
            OutputPath = outputPath;
            ExitCode = exitCode;
            Stdout = stdout;
            Stderr = stderr;
        }

        public string DirectoryPath { get; }

        public string OutputPath { get; }

        public int ExitCode { get; }

        public string Stdout { get; }

        public string Stderr { get; }

        public void Dispose()
        {
            try
            {
                Directory.Delete(DirectoryPath, recursive: true);
            }
            catch
            {
            }
        }
    }
}
