// <copyright file="Issue2443ExternalClrOverrideEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import Xunit.Sdk

/// Issue #2443: overrides can target virtual members inherited from imported
/// CLR base classes instead of only members represented by a G# BaseClass.
class Issue2443ExternalClrOverrideEmitTests {
    @Fact
    func ImplicitObjectOverrides_SourceChainsAndGenericClasses_DispatchAndReflectBaseSlots() {
        const Source = `package Issue2486
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
}`
        let result = Compile(Source, target: "exe")
        try {
            Assert.Equal(
                "derived${Environment.NewLine}2486${Environment.NewLine}True${Environment.NewLine}",
                Run(result.OutputPath)
            )
            IlVerifier.Verify(result.OutputPath)
            let assembly = EmittedFixture.Load(result.OutputPath)
            let derived = assembly.GetType("Issue2486.Derived")!!
            AssertOverrideSlot(
                derived.GetMethod(
                    "ToString",
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly
                )!!,
                typeof(object).GetMethod("ToString")!!
            )
            AssertOverrideSlot(
                derived.GetMethod(
                    "GetHashCode",
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly
                )!!,
                typeof(object).GetMethod("GetHashCode")!!
            )
            AssertOverrideSlot(
                derived.GetMethod("Equals", BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)!!,
                typeof(object).GetMethod("Equals", []Type{typeof(object)})!!
            )
            let openImplicit = assembly.GetType("Issue2486.OpenImplicit")!!
            Assert.False(openImplicit.IsSealed)
            AssertOverrideSlot(openImplicit.GetMethod("ToString")!!, typeof(object).GetMethod("ToString")!!)
            let generic = assembly.GetType("Issue2486.Generic`1")!!
            Assert.True(generic.IsSealed)
            AssertOverrideSlot(generic.GetMethod("ToString")!!, typeof(object).GetMethod("ToString")!!)
            let consumerPath = EmitImplicitObjectConsumer(result.DirectoryPath, result.OutputPath)
            Assert.Equal(
                "derived${Environment.NewLine}2486${Environment.NewLine}True${Environment.NewLine}generic${Environment.NewLine}",
                Run(consumerPath)
            )
        } finally {
            result.Dispose()
        }
    }

    @Fact
    func PlainStructObjectOverrides_AllShapes_DispatchReflectAndEmitExpectedCallSites() {
        const Source = `package Issue2896
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
Console.WriteLine(boxedDefault.ToString())`
        let result = Compile(Source, target: "exe")
        try {
            Assert.Equal(`OVERRIDDEN-11
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
DataValue { Number = 7 }
DataValue { Number = 7 }
Issue2896.DefaultValue
Issue2896.DefaultValue`.ReplaceLineEndings(Environment.NewLine) + Environment.NewLine, Run(result.OutputPath))
            let assembly = EmittedFixture.Load(result.OutputPath)
            let types = assembly.GetTypes()
            let objectToString = typeof(object).GetMethod("ToString")!!
            let objectEquals = typeof(object).GetMethod("Equals", []Type{typeof(object)})!!
            let objectGetHashCode = typeof(object).GetMethod("GetHashCode")!!
            AssertValueTypeObjectOverride(
                types.Single((type Type) -> type.FullName == "Issue2896.ToStringOnly").GetMethod("ToString")!!,
                objectToString
            )
            AssertValueTypeObjectOverride(
                types.Single((type Type) -> type.FullName == "Issue2896.EqualsOnly").GetMethod(
                    "Equals",
                    []Type{typeof(object)}
                )!!,
                objectEquals
            )
            AssertValueTypeObjectOverride(
                types.Single((type Type) -> type.FullName == "Issue2896.HashOnly").GetMethod("GetHashCode")!!,
                objectGetHashCode
            )
            let allType = types.Single((type Type) -> type.FullName == "Issue2896.AllValue")
            AssertValueTypeObjectOverride(allType.GetMethod("ToString")!!, objectToString)
            AssertValueTypeObjectOverride(allType.GetMethod("Equals", []Type{typeof(object)})!!, objectEquals)
            AssertValueTypeObjectOverride(allType.GetMethod("GetHashCode")!!, objectGetHashCode)
            AssertValueTypeObjectOverride(
                types.Single((type Type) -> type.FullName == "Issue2896.GenericValue`1").GetMethod("ToString")!!,
                objectToString
            )
            AssertValueTypeObjectOverride(
                types.Single((type Type) -> type.FullName == "Issue2896.InterfaceValue").GetMethod("ToString")!!,
                objectToString
            )
            let operatorType = types.Single((type Type) -> type.FullName == "Issue2896.OperatorValue")
            AssertValueTypeObjectOverride(operatorType.GetMethod("Equals", []Type{typeof(object)})!!, objectEquals)
            AssertValueTypeObjectOverride(operatorType.GetMethod("GetHashCode")!!, objectGetHashCode)
            AssertValueTypeObjectOverride(
                types.Single((type Type) -> type.FullName == "Issue2896.Container+NestedValue").GetMethod("ToString")!!,
                objectToString
            )
            AssertValueTypeObjectOverride(
                types.Single((type Type) -> type.FullName == "Issue2896.SharedValue").GetMethod("ToString")!!,
                objectToString
            )
            let dataType = types.Single((type Type) -> type.FullName == "Issue2896.DataValue")
            AssertValueTypeObjectOverride(dataType.GetMethod("ToString")!!, objectToString)
            let defaultType = types.Single((type Type) -> type.FullName == "Issue2896.DefaultValue")
            Assert.Null(
                defaultType.GetMethod(
                    "ToString",
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly
                )
            )
            using let peReader = PEReader(File.OpenRead(result.OutputPath))
            let metadata = peReader.GetMetadataReader()
            AssertMethodImplCount(metadata, "ToStringOnly", 1)
            AssertMethodImplCount(metadata, "EqualsOnly", 1)
            AssertMethodImplCount(metadata, "HashOnly", 1)
            AssertMethodImplCount(metadata, "AllValue", 3)
            AssertMethodImplCount(metadata, "GenericValue`1", 1)
            AssertMethodImplCount(metadata, "InterfaceValue", 1)
            AssertMethodImplCount(metadata, "OperatorValue", 2)
            AssertMethodImplCount(metadata, "NestedValue", 1)
            AssertMethodImplCount(metadata, "SharedValue", 1)
            let programType = types.Single((type Type) -> type.Name == "<Program>")
            let callSiteProbe = programType.GetMethod("CallSiteProbe", BindingFlags.Static | BindingFlags.Public)!!
            let callSiteInstructions = IlInstructionReader.Read(callSiteProbe.GetMethodBody()!!.GetILAsByteArray()!!)
            Assert.Contains(
                callSiteInstructions,
                (instruction IlInstruction) -> instruction.OpCode == OpCodes.Call &&
                    callSiteProbe
                    .Module
                    .ResolveMethod(instruction.MetadataToken!!)
                    ?.DeclaringType == allType
            )
            Assert.Contains(
                callSiteInstructions,
                (instruction IlInstruction) -> instruction.OpCode == OpCodes.Callvirt &&
                    callSiteProbe
                    .Module
                    .ResolveMethod(instruction.MetadataToken!!)
                    ?.DeclaringType == typeof(object)
            )
            let printGeneric = programType.GetMethod("PrintGeneric", BindingFlags.Static | BindingFlags.Public)!!
            let genericInstructions = IlInstructionReader.Read(printGeneric.GetMethodBody()!!.GetILAsByteArray()!!)
            let constrainedIndex = Array.FindIndex(
                genericInstructions,
                (instruction IlInstruction) -> instruction.OpCode == OpCodes.Constrained
            )
            Assert.True(constrainedIndex >= 0)
            Assert.Equal(OpCodes.Callvirt, genericInstructions[constrainedIndex + 1].OpCode)
            Assert.Equal(
                typeof(object),
                printGeneric
                    .Module
                    .ResolveMethod(genericInstructions[constrainedIndex + 1].MetadataToken!!)
                    ?.DeclaringType
            )
        } finally {
            result.Dispose()
        }
    }

    @Fact
    func MatchingImplicitObjectVirtualWithoutOverride_RemainsAnAcceptedShadow() {
        const Source = `package Issue2486

class Shadow {
    func ToString() string -> "shadow"
}`
        let result = Compile(Source, target: "library")
        try {
            IlVerifier.Verify(result.OutputPath)
            let assembly = EmittedFixture.Load(result.OutputPath)
            let type = assembly.GetType("Issue2486.Shadow")!!
            let instance object? = Activator.CreateInstance(type)
            let shadow = type.GetMethod(
                "ToString",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly
            )!!
            Assert.False(shadow.IsVirtual)
            Assert.False(shadow.IsFinal)
            Assert.False((shadow.Attributes & MethodAttributes.NewSlot) != 0)
            Assert.Equal("shadow", shadow.Invoke(instance, nil))
            Assert.Equal("Issue2486.Shadow", typeof(object).GetMethod("ToString")!!.Invoke(instance, nil))
        } finally {
            result.Dispose()
        }
    }

    @Theory
    @InlineData(`package Issue2486
class Bad {
    override func ToString(value int32) string -> "bad"
}`, "GS0185")
    @InlineData(`package Issue2486
class Bad {
    protected override func MemberwiseClone() object -> this
}`, "GS0184")
    @InlineData(`package Issue2486
class Bad {
    override func Missing() string -> "bad"
}`, "GS0183")
    func ImplicitObjectOverride_InvalidShapesRetainSpecificDiagnostics(source string, diagnosticId string) {
        let result = TryCompile(source, "library")
        try {
            Assert.NotEqual(0, result.ExitCode)
            Assert.Contains(diagnosticId, result.Stdout + result.Stderr, StringComparison.Ordinal)
        } finally {
            result.Dispose()
        }
    }

    @Fact
    func BclObjectOverride_DispatchesAndReflectsBaseSlot() {
        const Source = `package Issue2443
import System

class Derived : Object {
    override func ToString() string -> "derived"
}

func Main() {
    let value object = Derived()
    Console.WriteLine(value.ToString())
}`
        let result = Compile(Source, target: "exe")
        try {
            Assert.Equal("derived${Environment.NewLine}", Run(result.OutputPath))
            IlVerifier.Verify(result.OutputPath)
            let assembly = EmittedFixture.Load(result.OutputPath)
            let method = assembly.GetType("Issue2443.Derived")!!.GetMethod(
                "ToString",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly
            )!!
            Assert.True(method.IsVirtual)
            Assert.False(method.IsFinal)
            Assert.False((method.Attributes & MethodAttributes.NewSlot) != 0)
            Assert.Equal(typeof(object).GetMethod("ToString"), method.GetBaseDefinition())
        } finally {
            result.Dispose()
        }
    }

    @Fact
    func SiblingAssemblyOverrides_MethodsPropertiesEventsGenericsAndCovariance_WorkForCSharpConsumer() {
        const Source = `package Issue2443
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
}`
        let result = Compile(Source, target: "library", ExternalBaseAssembly.Value)
        try {
            IlVerifier.Verify(result.OutputPath, additionalReferences: []string{ExternalBaseAssembly.Value})
            // One context for both: the assertions below compare the
            // derived type's base methods and return types against the
            // external base's, which only holds when a single context
            // supplies one identity for Issue2443Base.
            let loaded = EmittedFixture.LoadTogether(ExternalBaseAssembly.Value, result.OutputPath)
            let baseAssembly = loaded[0]
            let derivedAssembly = loaded[1]
            let derived = derivedAssembly.GetType("Issue2443.Derived")!!
            let closedBase = baseAssembly.GetType("Issue2443Base.ExternalBase`1")!!.MakeGenericType(typeof(int32))
            AssertOverrideSlot(derived.GetMethod("Echo")!!, closedBase.GetMethod("Echo")!!)
            AssertOverrideSlot(derived.GetMethod("Identity")!!, closedBase.GetMethod("Identity")!!)
            AssertVirtualReuseSlot(derived.GetMethod("Covariant")!!)
            AssertOverrideSlot(
                derived.GetProperty("Value")!!.GetMethod!!,
                closedBase.GetProperty("Value")!!.GetMethod!!
            )
            AssertOverrideSlot(derived.GetProperty("Item")!!.GetMethod!!, closedBase.GetProperty("Item")!!.GetMethod!!)
            AssertOverrideSlot(derived.GetEvent("Changed")!!.AddMethod!!, closedBase.GetEvent("Changed")!!.AddMethod!!)
            Assert.Equal(baseAssembly.GetType("Issue2443Base.Marker"), derived.GetMethod("Covariant")!!.ReturnType)
            let abstractDerived = derivedAssembly.GetType("Issue2443.AbstractDerived")!!
            Assert.True(abstractDerived.IsAbstract)
            Assert.True(abstractDerived.GetMethod("AbstractName")!!.IsAbstract)
            AssertOverrideSlot(abstractDerived.GetMethod("AbstractName")!!, closedBase.GetMethod("AbstractName")!!)
            let genericDerived = derivedAssembly.GetType("Issue2443.GenericDerived`1")!!
            Assert.True(genericDerived.BaseType!!.IsGenericType)
            Assert.Equal(genericDerived.GetGenericArguments()[0], genericDerived.BaseType!!.GetGenericArguments()[0])
            let consumerPath = EmitCSharpConsumer(result.DirectoryPath, result.OutputPath, ExternalBaseAssembly.Value)
            Assert.Equal(
                "echo:4${Environment.NewLine}id${Environment.NewLine}Marker${Environment.NewLine}7${Environment.NewLine}13${Environment.NewLine}5${Environment.NewLine}abstract${Environment.NewLine}generic${Environment.NewLine}generic-abstract${Environment.NewLine}",
                Run(consumerPath)
            )
        } finally {
            result.Dispose()
        }
    }

    @Fact
    func MatchingExternalVirtualWithoutOverride_RemainsAnAcceptedShadow() {
        const Source = `package Issue2443
import Issue2443Base

class ShadowingDerived : ExternalBase[int32] {
    func Echo(value int32) string -> "shadow"
    override func AbstractName() string -> "abstract"
}`
        let result = Compile(Source, target: "library", ExternalBaseAssembly.Value)
        try {
            // One context for both: the assertions below compare the
            // derived type's base methods and return types against the
            // external base's, which only holds when a single context
            // supplies one identity for Issue2443Base.
            let loaded = EmittedFixture.LoadTogether(ExternalBaseAssembly.Value, result.OutputPath)
            let baseAssembly = loaded[0]
            let derivedAssembly = loaded[1]
            let derivedType = derivedAssembly.GetType("Issue2443.ShadowingDerived")!!
            let instance object? = Activator.CreateInstance(derivedType)
            let closedBase = baseAssembly.GetType("Issue2443Base.ExternalBase`1")!!.MakeGenericType(typeof(int32))
            let shadow = derivedType.GetMethod(
                "Echo",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly
            )!!
            Assert.False(shadow.IsVirtual)
            Assert.False(shadow.IsFinal)
            Assert.False((shadow.Attributes & MethodAttributes.NewSlot) != 0)
            Assert.Equal("shadow", shadow.Invoke(instance, []object{1}))
            Assert.Equal("base", closedBase.GetMethod("Echo")!!.Invoke(instance, []object{1}))
        } finally {
            result.Dispose()
        }
    }

    @Theory
    @InlineData(`package Issue2443
import Issue2443Base
class Bad : SealedBase {
    override func ToString() string -> "bad"
}`, "GS0184")
    @InlineData(`package Issue2443
import Issue2443Base
class Bad : ExternalBase[int32] {
    override func Echo(value string) string -> value
    override func AbstractName() string -> "abstract"
}`, "GS0185")
    func InvalidExplicitExternalOverrideShapes_Report(source string, diagnosticId string) {
        let result = TryCompile(source, "library", ExternalBaseAssembly.Value)
        try {
            Assert.NotEqual(0, result.ExitCode)
            Assert.Contains(diagnosticId, result.Stdout + result.Stderr, StringComparison.Ordinal)
        } finally {
            result.Dispose()
        }
    }

    private class CompilationResult : IDisposable {
        init(directoryPath string, outputPath string, exitCode int32, stdout string, stderr string) {
            DirectoryPath = directoryPath
            OutputPath = outputPath
            ExitCode = exitCode
            Stdout = stdout
            Stderr = stderr
        }

        prop DirectoryPath string {
            get;
        }

        prop OutputPath string {
            get;
        }

        prop ExitCode int32 {
            get;
        }

        prop Stdout string {
            get;
        }

        prop Stderr string {
            get;
        }

        func Dispose() {
            try {
                Directory.Delete(DirectoryPath, recursive: true)
            } catch { }
        }
    }

    shared {
        private let ExternalBaseAssembly Lazy[string] = Lazy[string](EmitExternalBaseAssembly)

        private func AssertOverrideSlot(implementation MethodInfo?, declaration MethodInfo?) {
            AssertVirtualReuseSlot(implementation)
            Assert.Equal(
                declaration!!.GetBaseDefinition().MetadataToken,
                implementation!!.GetBaseDefinition().MetadataToken
            )
            Assert.Equal(declaration!!.GetBaseDefinition().Module, implementation!!.GetBaseDefinition().Module)
        }

        private func AssertVirtualReuseSlot(implementation MethodInfo?) {
            Assert.True(implementation!!.IsVirtual)
            Assert.False((implementation!!.Attributes & MethodAttributes.NewSlot) != 0)
        }

        private func AssertValueTypeObjectOverride(implementation MethodInfo?, declaration MethodInfo) {
            AssertOverrideSlot(implementation, declaration)
            Assert.False(implementation!!.IsFinal)
            Assert.True(implementation!!.IsHideBySig)
        }

        private func AssertMethodImplCount(reader MetadataReader, typeName string, expected int32) {
            let type = reader
                .TypeDefinitions
                .Select(reader.GetTypeDefinition)
                .Single((definition TypeDefinition) -> reader.GetString(definition.Name) == typeName)
            Assert.Equal(expected, type.GetMethodImplementations().Count)
        }

        private func Compile(source string, target string, references ...string) Issue2443ExternalClrOverrideEmitTests
            .CompilationResult {
            let result = TryCompile(source, target, references)
            Assert.True(result.ExitCode == 0, (`gsc failed (` + "${result.ExitCode}" + `):
stdout:
` + "${result.Stdout}" + `
stderr:
` + "${result.Stderr}"))
            return result
        }

        private func TryCompile(
            source string,
            target string,
            references ...string
        ) Issue2443ExternalClrOverrideEmitTests
            .CompilationResult {
            let directory = Directory.CreateTempSubdirectory("gs_issue2443_").FullName
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyName = "Issue2443Derived_" + Guid.NewGuid().ToString("N")
            let outputPath = Path.Combine(directory, assemblyName + ".dll")
            File.WriteAllText(sourcePath, source)
            let args = List[string]{
                "/out:" + outputPath,
                "/assemblyname:" + assemblyName,
                "/target:" + target,
                "/targetframework:net10.0",
                "/nowarn:GS9100"
            }
            for reference in references {
                args.Add("/r:" + reference)
            }
            for reference in BclReferences.Value {
                args.Add("/r:" + reference)
            }
            args.Add(sourcePath)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            if File.Exists(ExternalBaseAssembly.Value) {
                File.Copy(
                    ExternalBaseAssembly.Value,
                    Path.Combine(directory, Path.GetFileName(ExternalBaseAssembly.Value)),
                    overwrite: true
                )
            }
            return Issue2443ExternalClrOverrideEmitTests.CompilationResult(
                directory,
                outputPath,
                exitCode,
                stdout.ToString(),
                stderr.ToString()
            )
        }

        private func EmitExternalBaseAssembly() string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2443ExternalBase")
            Directory.CreateDirectory(directory)
            let path = Path.Combine(directory, "Issue2443Base.dll")
            const Source = `using System;

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
}`
            EmitCSharpAssembly(path, "Issue2443Base", Source, OutputKind.DynamicallyLinkedLibrary)
            return path
        }

        private func EmitCSharpConsumer(directory string, gsharpAssembly string, baseAssembly string) string {
            let outputPath = Path.Combine(directory, "Issue2443Consumer.dll")
            const Source = `using System;
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
}`
            EmitCSharpAssembly(
                outputPath,
                "Issue2443Consumer",
                Source,
                OutputKind.ConsoleApplication,
                gsharpAssembly,
                baseAssembly
            )
            return outputPath
        }

        private func EmitImplicitObjectConsumer(directory string, gsharpAssembly string) string {
            let outputPath = Path.Combine(directory, "Issue2486Consumer.dll")
            const Source = `using System;
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
}`
            EmitCSharpAssembly(outputPath, "Issue2486Consumer", Source, OutputKind.ConsoleApplication, gsharpAssembly)
            return outputPath
        }

        private func EmitCSharpAssembly(
            outputPath string,
            assemblyName string,
            source string,
            outputKind OutputKind,
            additionalReferences ...string
        ) {
            let references = TrustedPlatformReferences().Concat(
                additionalReferences.Select((path string) -> MetadataReference.CreateFromFile(path))
            )
                .ToArray()
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(outputKind)
            )
            using let peStream = File.Create(outputPath)
            let emitResult = compilation.Emit(peStream)
            Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
        }

        private func Run(assemblyPath string) string {
            let runtimeConfigPath = Path.ChangeExtension(assemblyPath, "runtimeconfig.json")
            File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
            let startInfo = ProcessStartInfo("dotnet", "exec \"" + assemblyPath + "\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process = Process.Start(startInfo)!!
            let stdoutTask = process.StandardOutput.ReadToEndAsync()
            let stderrTask = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                throw XunitException("child process timed out after 30000 ms")
            }
            let stdout = stdoutTask.GetAwaiter().GetResult()
            let stderr = stderrTask.GetAwaiter().GetResult()
            Assert.True(process.ExitCode == 0, (`exit ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }

        private func TrustedPlatformReferences() IEnumerable[MetadataReference] -> (
            (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                Array.Empty[string]()
        )
            .Where(File.Exists).Select((path string) -> MetadataReference.CreateFromFile(path))

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                let runtimeDirectory string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                if string.IsNullOrEmpty(runtimeDirectory) || !Directory.Exists(runtimeDirectory) {
                    return Array.Empty[string]()
                }
                return Directory
                    .EnumerateFiles(runtimeDirectory!!, "*.dll", SearchOption.TopDirectoryOnly)
                    .Where(
                    (path string) -> {
                        let name = Path.GetFileName(path)
                        return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || string.Equals(
                            name,
                            "mscorlib.dll",
                            StringComparison.OrdinalIgnoreCase
                        ) ||
                            string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase)
                    }
                )
                    .ToArray()
            }
        )
    }
}
