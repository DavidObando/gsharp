// <copyright file="Issue2895InheritedFieldDeclaringTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import Xunit
import Xunit.Sdk

/// Issue #2895: inherited field references from generic derived classes must
/// name the field's declaring base type, not the generic receiver type.
open class Issue2895InheritedFieldDeclaringTypeTests {
    @Fact
    func UnqualifiedAccessesInsideGenericDerivedUseNonGenericBase() {
        const source = `package Issue2895Unqualified
import System

data struct Payload(Code int32)

open class Base {
    internal var number int32 = 11
    internal var payload Payload = Payload(44)
}

class Derived[T] : Base {
    func Read() int32 { return number }
    func Write() int32 {
        number = 22
        return number
    }
    func Compound() int32 {
        number += 11
        return number
    }
    func ReadPayload() int32 { return payload.Code }
}

let value = Derived[string]()
Console.WriteLine(value.Read())
Console.WriteLine(value.Write())
Console.WriteLine(value.Compound())
Console.WriteLine(value.ReadPayload())`
        using let artifact = Compile("UnqualifiedAccessesInsideGenericDerivedUseNonGenericBase", source)
        AssertFieldOwners(artifact.Assembly, "number", "Base", minimumReferences: 6)
        AssertFieldOwners(artifact.Assembly, "payload", "Base", minimumReferences: 1)
        AssertRuns(artifact.Path, `11
22
33
44
`)
    }

    @Fact
    func ExplicitReceiverWritesUseNonGenericBase() {
        const source = `package Issue2895Explicit
import System

open class Base {
    internal var explicitValue int32
}

class Derived[T] : Base {
}

class Holder {
    internal var child Derived[string] = Derived[string]()

    func Write() int32 {
        child.explicitValue = 67
        return child.explicitValue
    }
}

let top = Derived[string]()
top.explicitValue = 55
Console.WriteLine(top.explicitValue)

func Run() int32 {
    let local = Derived[int32]()
    local.explicitValue = 66
    return local.explicitValue
}

Console.WriteLine(Run())
Console.WriteLine(Holder().Write())`
        using let artifact = Compile("ExplicitReceiverWritesUseNonGenericBase", source)
        AssertFieldOwners(artifact.Assembly, "explicitValue", "Base", minimumReferences: 6)
        AssertRuns(artifact.Path, `55
66
67
`)
    }

    @Fact
    func ObjectInitializerWriteUsesNonGenericBase() {
        const source = `package Issue2895Initializer
import System

open class Base {
    internal var initializedValue int32
}

class Derived[T] : Base {
}

let value = Derived[string]() { initializedValue = 77 }
Console.WriteLine(value.initializedValue)`
        using let artifact = Compile("ObjectInitializerWriteUsesNonGenericBase", source)
        AssertFieldOwners(artifact.Assembly, "initializedValue", "Base", minimumReferences: 2)
        AssertRuns(artifact.Path, "77\n")
    }

    @Fact
    func MultiLevelAndNestedGenericDerivedUseTheirDeclaringBases() {
        const source = `package Issue2895Shapes
import System
import System.Collections.Generic

open class Root {
    internal var deepValue int32 = 88
}

open class Mid[T] : Root {
}

class Deep[T] : Mid[List[T]] {
    func Read() int32 { return deepValue }
}

open class NestedBase {
    internal var nestedValue int32 = 99
}

class Container {
    class Nested[T] : NestedBase {
        func Read() int32 { return nestedValue }
    }
}

Console.WriteLine(Deep[string]().Read())
Console.WriteLine(Container.Nested[string]().Read())`
        using let artifact = Compile("MultiLevelAndNestedGenericDerivedUseTheirDeclaringBases", source)
        AssertFieldOwners(artifact.Assembly, "deepValue", "Root", minimumReferences: 1)
        AssertFieldOwners(artifact.Assembly, "nestedValue", "NestedBase", minimumReferences: 1)
        AssertRuns(artifact.Path, `88
99
`)
    }

    @Fact
    func GenericBaseShapesUseConstructedDeclaringBase() {
        const source = `package Issue2895GenericBases
import System
import System.Collections.Generic

data struct Payload(Code int32)

open class GenericBase[T] {
    internal var genericValue T
}

class Forwarded[T] : GenericBase[T] {
    func Set(value T) { genericValue = value }
    func Read() T { return genericValue }
}

class Substituted[T] : GenericBase[int32] {
    func Set(value int32) { genericValue = value }
    func Read() int32 { return genericValue }
}

class NestedSubstitution[T] : GenericBase[List[T]] {
    func Set(value List[T]) { genericValue = value }
    func Read() List[T] { return genericValue }
}

let forwarded = Forwarded[Payload]()
forwarded.Set(Payload(11))
Console.WriteLine(forwarded.Read().Code)

let substituted = Substituted[string]()
substituted.Set(22)
Console.WriteLine(substituted.Read())

let values = List[string]()
values.Add("item")
let nested = NestedSubstitution[string]()
nested.Set(values)
Console.WriteLine(nested.Read().Count)`
        using let artifact = Compile("GenericBaseShapesUseConstructedDeclaringBase", source)
        AssertFieldOwners(artifact.Assembly, "genericValue", "GenericBase`1", minimumReferences: 6)
        AssertRuns(artifact.Path, `11
22
1
`)
    }

    @Fact
    func InheritedStaticFieldRemainsValid() {
        const source = `package Issue2895StaticGuard
import System

open class Base {
    shared {
        internal var sharedValue int32
    }
}

class Derived[T] : Base {
}

Derived[string].sharedValue = 44
Console.WriteLine(Derived[string].sharedValue)`
        using let artifact = Compile("InheritedStaticFieldRemainsValid", source)
        AssertFieldOwners(artifact.Assembly, "sharedValue", "Base", minimumReferences: 2)
        AssertRuns(artifact.Path, "44\n")
    }

    @Fact
    func InheritedFieldAddressRemainsValid() {
        const source = `package Issue2895AddressGuard
import System

open class Base {
    internal var addressValue int32
    func Read() int32 { return addressValue }
}

class Derived[T] : Base {
}

func SetAddress(out value int32) { value = 33 }

let value = Derived[string]()
SetAddress(&value.addressValue)
Console.WriteLine(value.Read())`
        using let artifact = Compile("InheritedFieldAddressRemainsValid", source)
        AssertFieldOwners(artifact.Assembly, "addressValue", "Base", minimumReferences: 2)
        AssertRuns(artifact.Path, "33\n")
    }

    private class Artifact : IDisposable {
        init(directory string, path string, assembly Assembly) {
            Directory = directory
            Path = path
            Assembly = assembly
        }

        prop Directory string {
            get;
        }

        prop Path string {
            get;
        }

        prop Assembly Assembly {
            get;
        }

        func Dispose() {
            try {
                Directory.Delete(Directory, recursive: true)
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    shared {
        private let OpCodesByValue IReadOnlyDictionary[uint16, OpCode] = typeof(OpCodes)
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where((field FieldInfo) -> field.FieldType == typeof(OpCode))
            .Select((field FieldInfo) -> OpCode(field.GetValue(nil)!!))
            .ToDictionary((opCode OpCode) -> unchecked(uint16(opCode.Value)))

        private func Compile(name string, source string) Artifact {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2895InheritedFieldDeclaringTypeTests", name)
            if Directory.Exists(directory) {
                Directory.Delete(directory, recursive: true)
            }
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            let exitCode = Program.Main(
                []string{
                    "/out:" + assemblyPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    sourcePath
                }
            )
            Assert.Equal(0, exitCode)
            let assembly = EmittedFixture.Load(assemblyPath)
            let _ = assembly.GetTypes()
            return Artifact(directory, assemblyPath, assembly)
        }

        private func AssertFieldOwners(
            assembly Assembly,
            fieldName string,
            expectedOwner string,
            minimumReferences int32
        ) {
            let fields = GetReferencedFields(assembly).Where((field FieldInfo) -> field.Name == fieldName).ToArray()
            Assert.True(
                fields.Length >= minimumReferences,
                "Expected at least $minimumReferences references to '$fieldName', found ${fields.Length}."
            )
            Assert.All(fields, (field FieldInfo) -> Assert.Equal(expectedOwner, field.DeclaringType!!.Name))
        }

        private func GetReferencedFields(assembly Assembly) sequence[FieldInfo] {
            for type in assembly.GetTypes() {
                for method in type.GetMethods(
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly
                ) {
                    let body MethodBody? = method.GetMethodBody()
                    let il[]?uint8 = body?.GetILAsByteArray()
                    if il == nil {
                        continue
                    }
                    var offset = 0
                    while offset < il.Length {
                        var value = uint16(il[offset++])
                        if value == uint16(0xfe) {
                            value = uint16((0xfe00 | int32(il[offset])))
                            offset++
                        }
                        let opCode = OpCodesByValue[value]
                        if opCode.OperandType == OperandType.InlineField {
                            let token = BitConverter.ToInt32(il, offset)
                            yield method.Module.ResolveField(
                                token,
                                if type.IsGenericType {
                                    type.GetGenericArguments()
                                } else {
                                    default([]?Type)
                                },
                                if method.IsGenericMethod {
                                    method.GetGenericArguments()
                                } else {
                                    default([]?Type)
                                }
                            )!!
                        }
                        offset += OperandSize(opCode.OperandType, il, offset)
                    }
                }
            }
        }

        private func OperandSize(operandType OperandType, il[]uint8, offset int32) int32 -> switch operandType {
            case OperandType.InlineNone: 0
            case OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar: 1
            case OperandType.InlineVar: 2
            case OperandType.InlineI or
                OperandType.InlineBrTarget or
                OperandType.InlineField or
                OperandType.InlineMethod or
                OperandType.InlineSig or
                OperandType.InlineString or
                OperandType.InlineTok or
                OperandType.InlineType or
                OperandType.ShortInlineR: 4
            case OperandType.InlineI8 or OperandType.InlineR: 8
            case OperandType.InlineSwitch: 4 + (BitConverter.ToInt32(il, offset) * 4)
            default: throw InvalidOperationException("Unsupported IL operand type: $operandType.")
        }

        private func AssertRuns(assemblyPath string, expectedOutput string) {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo)!!
            let stdoutTask = process.StandardOutput.ReadToEndAsync()
            let stderrTask = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                throw XunitException("Child process timed out.")
            }
            let stdout = stdoutTask.GetAwaiter().GetResult().ReplaceLineEndings(Environment.NewLine)
            let stderr = stderrTask.GetAwaiter().GetResult().ReplaceLineEndings(Environment.NewLine)
            Assert.True(process.ExitCode == 0, (`Child exited ` + "${process.ExitCode}" + `.
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            Assert.Equal(expectedOutput, stdout)
            Assert.Equal(string.Empty, stderr)
        }
    }
}
