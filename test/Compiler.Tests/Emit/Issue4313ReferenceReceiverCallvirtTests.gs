// <copyright file="Issue4313ReferenceReceiverCallvirtTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import System.Collections.Generic

/// Issue #4313: string indexing, string length, and rectangular-array length
/// emit the same `callvirt` opcode as C#.
class Issue4313ReferenceReceiverCallvirtTests {
    @Fact
    func ReferenceReceiverSites_UseCallvirt_WhileAdjacentControlsKeepTheirOpcodes() {
        let assembly = Compile()
        AssertCall(assembly, "StringIndex4313", OpCodes.Callvirt, typeof(string), "get_Chars")
        AssertCall(assembly, "StringLength4313", OpCodes.Callvirt, typeof(string), "get_Length")
        AssertCall(assembly, "RectangularLength4313", OpCodes.Callvirt, typeof(Array), "get_Length")
        let vectorLength = GetMethod(assembly, "VectorArrayLengthControl4313")
        let vectorLengthInstructions = IlInstructionReader.Read(vectorLength.GetMethodBody()!!.GetILAsByteArray()!!)
        Assert.Contains(vectorLengthInstructions, (instruction IlInstruction) -> instruction.OpCode == OpCodes.Ldlen)
        Assert.DoesNotContain(
            vectorLengthInstructions,
            (instruction IlInstruction) -> (instruction.MetadataToken != nil) && vectorLength.Module.ResolveMethod(
                instruction.MetadataToken!!
            ) is MethodInfo called &&
                called.DeclaringType == typeof(Array) &&
                called.Name == "get_Length"
        )
        AssertCall(assembly, "ValueTypePropertyControl4313", OpCodes.Call, typeof(DateTime), "get_Day")
        AssertCall(assembly, "RectangularIndexControl4313", OpCodes.Call, typeof([,]int32), "Get")
    }

    @Fact
    func ReferenceReceiverSites_PreserveRuntimeBehavior_Smoke() {
        // This is a behavior smoke test only. Both call and callvirt normally
        // produce NullReferenceException for nil receivers, and optimizing JITs
        // may change observed stack frames. ADR-0154 discrimination is provided
        // by the exact opcode assertions above.
        let assembly = Compile()
        Assert.Equal('C', Invoke(assembly, "StringIndex4313", "ABCD", 2))
        Assert.Equal(4, Invoke(assembly, "StringLength4313", "ABCD"))
        Assert.Equal(6, Invoke(assembly, "RectangularLength4313", [2, 3]int32))
        AssertNullReceiverThrows(assembly, "StringIndex4313", nil, 0)
        AssertNullReceiverThrows(assembly, "StringLength4313", default(object))
        AssertNullReceiverThrows(assembly, "RectangularLength4313", default(object))
    }

    shared {
        private const Source string = `package Issue4313
import System

public func StringIndex4313(value string, index int32) char -> value[index]
public func StringLength4313(value string) int32 -> value.Length
public func RectangularLength4313(value [,]int32) int32 -> value.Length

public func VectorArrayLengthControl4313(value []int32) int32 {
    var count = 0
    for item in value { count++ }
    return count
}
public func ValueTypePropertyControl4313(value DateTime) int32 -> value.Day
public func RectangularIndexControl4313(value [,]int32) int32 -> value[0, 0]`

        private func Invoke(assembly Assembly, methodName string, arguments ...object) object -> GetMethod(
            assembly,
            methodName
        ).Invoke(nil, arguments)!!

        private func AssertNullReceiverThrows(assembly Assembly, methodName string, arguments ...object?) {
            let invocation = Assert.Throws[TargetInvocationException](
                func () object? {
                    return GetMethod(assembly, methodName).Invoke(nil, arguments)
                }
            )
            Assert.IsType[NullReferenceException](invocation.InnerException)
        }

        private func AssertCall(
            assembly Assembly,
            methodName string,
            expectedOpcode OpCode,
            expectedDeclaringType Type,
            expectedCalledMethod string
        ) {
            let method = GetMethod(assembly, methodName)
            let calls = IlInstructionReader
                .Read(method.GetMethodBody()!!.GetILAsByteArray()!!)
                .Where((instruction IlInstruction) -> (instruction.MetadataToken != nil))
                .Select(
                (instruction IlInstruction) -> (
                    instruction.OpCode,
                    Method: method.Module.ResolveMethod(instruction.MetadataToken!!)
                )
            )
                .Where((call(OpCode OpCode, Method MethodBase)) -> call.Item2?.Name == expectedCalledMethod)
                .ToArray()
            let call = Assert.Single(calls)
            Assert.Equal(expectedOpcode, call.Item1)
            Assert.Equal(expectedDeclaringType, call.Item2.DeclaringType)
        }

        private func GetMethod(assembly Assembly, methodName string) MethodInfo -> assembly
            .GetTypes()
            .SelectMany(
            func (type Type) IEnumerable[MethodInfo] {
                return type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
            }
        )
            .Single((method MethodInfo) -> method.Name == methodName)

        private func Compile() Assembly {
            let outputDirectory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue4313ReferenceReceiverCallvirtTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(outputDirectory)
            try {
                let sourcePath = Path.Combine(outputDirectory, "Program.gs")
                let assemblyPath = Path.Combine(outputDirectory, "Issue4313.dll")
                File.WriteAllText(sourcePath, Source)
                using let standardOut = StringWriter()
                using let standardError = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(standardOut)
                Console.SetError(standardError)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + assemblyPath, "/target:library", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, (`gsc failed (exit ` + "$exitCode" + `):
stdout:
` + "$standardOut" + `
stderr:
` + "$standardError"))
                IlVerifier.Verify(assemblyPath)
                return EmittedFixture.Load(assemblyPath)
            } finally {
                try {
                    Directory.Delete(outputDirectory, recursive: true)
                } catch { }
            }
        }
    }
}
