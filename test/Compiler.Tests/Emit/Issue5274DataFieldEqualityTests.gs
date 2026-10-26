// <copyright file="Issue5274DataFieldEqualityTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import GSharp.Tests
import System
import System.Collections.Generic
import System.ComponentModel
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Text
import System.Threading
import System.Threading.Tasks
import Xunit

class Issue5274DataFieldEqualityTests {
    @Fact
    func ValueFields_UseTypedCalls_AndPreserveFloatingPointEquality() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        // Keep the reported field shape; #5372 separately tracks readonly literal initialization.
        // Use positional construction for the strictly verified runtime control.
        let dll = fixture.Compile(`package ValueEquality
import System

public enum Kind { First; Second }
public data struct Generated {
    public let Kind Kind
    public let Number float64
    public let Flag bool
}
public data struct Value(Kind Kind, Number float64, Flag bool)
func Main() {
    let a = Value(Kind.Second, Double.NaN, true)
    let b = Value(Kind.Second, Double.NaN, true)
    Console.WriteLine(a.Equals(b))
    Console.WriteLine(a.GetHashCode() == b.GetHashCode())
    Console.WriteLine(a == b)
    Console.WriteLine(a != b)
    let positive = Value(Kind.First, 0.0, false)
    let negative = Value(Kind.First, -0.0, false)
    Console.WriteLine(positive.Equals(negative))
    Console.WriteLine(positive.GetHashCode() == negative.GetHashCode())
    Console.WriteLine(a.Equals(object(b)))
    Console.WriteLine(a.Equals(object("wrong")))
    Console.WriteLine(a.Equals(nil))
    Console.WriteLine(a.Equals(Value(Kind.First, Double.NaN, true)))
    Console.WriteLine(a.Equals(Value(Kind.Second, 1.0, true)))
    Console.WriteLine(a.Equals(Value(Kind.Second, Double.NaN, false)))
}`, "ValueEquality", true)
        IlVerifier.Verify(dll)
        let assembly = EmittedFixture.Load(dll)
        let type = assembly.GetType("ValueEquality.Generated", throwOnError: true)!!
        let fields = []Type{assembly.GetType("ValueEquality.Kind")!!, typeof(float64), typeof(bool)}
        AssertTypedCalls(type, fields)
        AssertTypedCalls(assembly.GetType("ValueEquality.Value", throwOnError: true)!!, fields)
        AssertOutputBytes(dll, "True\nTrue\nTrue\nFalse\nTrue\nTrue\nTrue\nFalse\nFalse\nFalse\nFalse\nFalse\n")
        AssertNotAnImplicitReference(fixture, "ValueEquality.Kind", 30)
    }

    @Fact
    func GenericNullableAndReferenceFields_UseCustomTypedEquality_InFieldOrder() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`using System;
namespace Contracts;
public struct Token : IEquatable<Token> {
    public int Value;
    public static string Trace = "";
    public bool Equals(Token other) {
        Trace += Value.ToString() + ",";
        return Value % 10 == other.Value % 10;
    }
    public override bool Equals(object? other) => false;
    public override int GetHashCode() => Value % 10;
}`, "Contracts")
        let dll = fixture.Compile(`package GenericEquality
import System
import Contracts

public data struct Mixed[T](Value T, Missing int32?, Text string?, First Token, Second Token)
public data struct Maybe[T struct](Value T?)
public data class Reference(Value Token) {
    public prop Label string?
}
func Main() {
    let a = Mixed[int32](7, nil, nil, Token{Value: 11}, Token{Value: 22})
    let b = Mixed[int32](7, nil, nil, Token{Value: 21}, Token{Value: 32})
    Token.Trace = ""
    Console.WriteLine(a.Equals(b))
    Console.WriteLine(Token.Trace)
    Console.WriteLine(a.GetHashCode() == b.GetHashCode())
    Token.Trace = ""
    Console.WriteLine(a.Equals(Mixed[int32](7, nil, nil, Token{Value: 12}, Token{Value: 22})))
    Console.WriteLine(Token.Trace)
    Console.WriteLine(a.Equals(Mixed[int32](7, 1, nil, Token{Value: 11}, Token{Value: 22})))
    Console.WriteLine(a.Equals(Mixed[int32](7, nil, "x", Token{Value: 11}, Token{Value: 22})))
    let s = Mixed[string]("same", 2, "text", Token{Value: 11}, Token{Value: 22})
    Console.WriteLine(s.Equals(Mixed[string]("same", 2, "text", Token{Value: 21}, Token{Value: 32})))
    Console.WriteLine(s.GetHashCode() == Mixed[string]("same", 2, "text", Token{Value: 21}, Token{Value: 32}).GetHashCode())
    let t = Mixed[Token](Token{Value: 11}, nil, nil, Token{Value: 11}, Token{Value: 22})
    let u = Mixed[Token](Token{Value: 21}, nil, nil, Token{Value: 21}, Token{Value: 32})
    Console.WriteLine(t.Equals(u))
    Console.WriteLine(t.GetHashCode() == u.GetHashCode())
    let r = Reference(Token{Value: 11})
    let q = Reference(Token{Value: 21})
    Console.WriteLine(r.Equals(q))
    Console.WriteLine(r.GetHashCode() == q.GetHashCode())
    Console.WriteLine(r.Equals(nil))
    let missing = Maybe[int32](nil)
    Console.WriteLine(missing.Equals(Maybe[int32](nil)))
    Console.WriteLine(missing.GetHashCode() == Maybe[int32](nil).GetHashCode())
    Console.WriteLine(missing.Equals(Maybe[int32](1)))
}`, "GenericEquality", true, "/r:" + contract)
        IlVerifier.Verify(dll, []string{contract})
        let assemblies = GSharp.Tests.EmittedFixture.LoadTogether(contract, dll)
        let token = assemblies[0].GetType("Contracts.Token", throwOnError: true)!!
        let definition = assemblies[1].GetType("GenericEquality.Mixed`1", throwOnError: true)!!
        for argument in[]Type{typeof(int32), typeof(string), token} {
            AssertTypedCalls(
                definition.MakeGenericType(argument),
                []Type{argument, typeof(int32?), typeof(string), token, token}
            )
        }
        AssertTypedCalls(
            assemblies[1].GetType("GenericEquality.Reference", throwOnError: true)!!,
            []Type{token, typeof(string)}
        )
        AssertTypedCalls(
            assemblies[1].GetType("GenericEquality.Maybe`1", throwOnError: true)!!.MakeGenericType(typeof(int32)),
            []Type{typeof(int32?)}
        )
        AssertOutputBytes(
            dll,
            "True\n11,22,\nTrue\nFalse\n11,\nFalse\nFalse\nTrue\nTrue\nTrue\nTrue\nTrue\nTrue\nFalse\nTrue\nTrue\nFalse\n"
        )
    }

    @Theory
    @InlineData(8)
    @InlineData(9)
    func HashBoundary_KeepsFieldTypesAndOrder(count int32) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let ninth = if count == 9 {
            ", Last T"
        } else {
            string.Empty
        }
        let lastArgument = if count == 9 {
            ", 9"
        } else {
            string.Empty
        }
        let expectedHash = if count == 9 {
            `var h HashCode
    h.Add[int32](1)
    h.Add[float64](Double.NaN)
    h.Add[bool](true)
    h.Add[string?](nil)
    h.Add[int32?](nil)
    h.Add[int64](6)
    h.Add[float32](float32(7.0))
    h.Add[uint8](8)
    h.Add[int32](9)
    let expected = h.ToHashCode()`
        } else {
            `let expected = HashCode.Combine[int32, float64, bool, string?, int32?, int64, float32, uint8](1, Double.NaN, true, nil, nil, 6, float32(7.0), 8)`
        }
        let dll = fixture.Compile(`package HashBoundary
import System
public data struct Many[T](A T, B float64, C bool, D string?, E int32?, F int64, G float32, H uint8NINTH)
func Main() {
    let a = Many[int32](1, Double.NaN, true, nil, nil, 6, float32(7.0), 8LAST)
    let b = Many[int32](1, Double.NaN, true, nil, nil, 6, float32(7.0), 8LAST)
    EXPECTED
    Console.WriteLine(a.Equals(b))
    Console.WriteLine(a.GetHashCode() == b.GetHashCode())
    Console.WriteLine(a.GetHashCode() == expected)
}`.Replace(
                "NINTH",
                ninth,
                StringComparison.Ordinal
            ).Replace(
                "LAST",
                lastArgument,
                StringComparison.Ordinal
            ).Replace("EXPECTED", expectedHash, StringComparison.Ordinal), "HashBoundary$count", true)
        IlVerifier.Verify(dll)
        let type = EmittedFixture.Load(dll).GetType("HashBoundary.Many`1", throwOnError: true)!!.MakeGenericType(
            typeof(int32)
        )
        let fields = []Type{
            typeof(int32),
            typeof(float64),
            typeof(bool),
            typeof(string),
            typeof(int32?),
            typeof(int64),
            typeof(float32),
            typeof(uint8)
        }
        AssertTypedCalls(
            type,
            if count == 9 {
                fields.Append(typeof(int32)).ToArray()
            } else {
                fields
            }
        )
        AssertOutputBytes(dll, "True\nTrue\nTrue\n")
        AssertNotAnImplicitReference(fixture, "HashBoundary.Many[int32]", 29)
    }

    @Fact
    func HashSpecifications_ReuseCanonicalRows_WithoutAliasingOpenArguments() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package HashReuse
import System
public data struct Repeated(A int32, B int32, C int32, D int32, E int32, F int32, G int32, H int32, I int32)
public data struct Again(A int32, B int32, C int32, D int32, E int32, F int32, G int32, H int32, I int32)
public data struct Eight(A int32, B int32, C int32, D int32, E int32, F int32, G int32, H int32)
public data struct EightAgain(A int32, B int32, C int32, D int32, E int32, F int32, G int32, H int32)
public data struct Open[T struct, U struct](A T, B T, C U, D T?, E U?, F int32, G int32?, H T, I U)
public data struct OpenAgain[T struct, U struct](A T, B T, C U, D T?, E U?, F int32, G int32?, H T, I U)
func Main() {
    let a = Repeated(1, 2, 3, 4, 5, 6, 7, 8, 9)
    Console.WriteLine(a.Equals(Repeated(1, 2, 3, 4, 5, 6, 7, 8, 9)))
    Console.WriteLine(a.GetHashCode() == Again(1, 2, 3, 4, 5, 6, 7, 8, 9).GetHashCode())
    let b = Open[int32, int64](1, 2, 3, nil, 5, 6, nil, 8, 9)
    Console.WriteLine(b.Equals(Open[int32, int64](1, 2, 3, nil, 5, 6, nil, 8, 9)))
    Console.WriteLine(b.GetHashCode() == OpenAgain[int32, int64](1, 2, 3, nil, 5, 6, nil, 8, 9).GetHashCode())
}`, "HashReuse", true)
        IlVerifier.Verify(dll)
        let assembly = EmittedFixture.Load(dll)
        let repeated = HashSpecifications(assembly.GetType("HashReuse.Repeated", throwOnError: true)!!)
        Assert.Equal(9, repeated.Length)
        let integer = Assert.Single(repeated.Distinct())
        Assert.Equal(repeated, HashSpecifications(assembly.GetType("HashReuse.Again", throwOnError: true)!!))
        let eight = Assert.Single(HashSpecifications(assembly.GetType("HashReuse.Eight", throwOnError: true)!!))
        Assert.Equal(
            eight,
            Assert.Single(HashSpecifications(assembly.GetType("HashReuse.EightAgain", throwOnError: true)!!))
        )
        let openType = assembly.GetType("HashReuse.Open`2", throwOnError: true)!!.MakeGenericType(
            typeof(int32),
            typeof(int64)
        )
        let other = assembly.GetType("HashReuse.OpenAgain`2", throwOnError: true)!!.MakeGenericType(
            typeof(int64),
            typeof(int32)
        )
        let openSpecs = HashSpecifications(openType)
        Assert.Equal(9, openSpecs.Length)
        Assert.Equal(6, openSpecs.Distinct().Count())
        Assert.Equal(openSpecs[0], openSpecs[1])
        Assert.Equal(openSpecs[0], openSpecs[7])
        Assert.Equal(openSpecs[2], openSpecs[8])
        Assert.Equal(integer, openSpecs[5])
        Assert.Equal(openSpecs, HashSpecifications(other))
        Assert.Equal(7, repeated.Concat(openSpecs).Append(eight).Distinct().Count())
        AssertTypedCalls(
            openType,
            []Type{
                typeof(int32),
                typeof(int32),
                typeof(int64),
                typeof(int32?),
                typeof(int64?),
                typeof(int32),
                typeof(int32?),
                typeof(int32),
                typeof(int64)
            }
        )
        AssertTypedCalls(
            other,
            []Type{
                typeof(int64),
                typeof(int64),
                typeof(int32),
                typeof(int64?),
                typeof(int32?),
                typeof(int32),
                typeof(int32?),
                typeof(int64),
                typeof(int32)
            }
        )
        AssertOutputBytes(dll, "True\nTrue\nTrue\nTrue\n")
        AssertNotAnImplicitReference(fixture, "HashReuse.Repeated", 26)
    }

    @Fact
    func TimedOutOutputFixture_TerminatesTheChild_AndCompletesPipeReads() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package EqualityTimeout
import System
import System.Threading
func Main() {
    Console.Write("partial")
    Console.Out.Flush()
    Console.Error.WriteLine("ready")
    Thread.Sleep(Timeout.Infinite)
}`, "EqualityTimeout", true)
        IlVerifier.Verify(dll)
        using let process = StartFixture(dll)
        try {
            using let startup = CancellationTokenSource(30_000)
            Assert.Equal("ready", process.StandardError.ReadLineAsync(startup.Token).AsTask().GetAwaiter().GetResult())
            let error = Assert.Throws[InvalidOperationException](() -> ReadOutputBytes(process, 0))
            Assert.True(process.HasExited, "The timed-out child is still running.")
            Assert.StartsWith("Equality fixture timed out.", error.Message, StringComparison.Ordinal)
            Assert.Contains("Child terminated: True.", error.Message, StringComparison.Ordinal)
            Assert.Contains("Pipe reads completed: True.", error.Message, StringComparison.Ordinal)
        } finally {
            if !process.HasExited {
                process.Kill(entireProcessTree: true)
                Assert.True(process.WaitForExit(10_000), "Timeout control child survived cleanup.")
            }
        }
    }

    shared {
        private func AssertNotAnImplicitReference(
            fixture NativeSliceLanguageTests.Fixture,
            fieldType string,
            endColumn int32
        ) {
            let (code, diagnostics) = fixture.TryCompile(
                "package EqualityIsolation\nfunc Read(value " + fieldType + ") {}",
                "EqualityImplicitReference",
                false
            )
            Assert.NotEqual(0, code)
            Assert.Contains(
                "EqualityImplicitReference.gs(2,17,2,$endColumn): error GS0113:",
                diagnostics,
                StringComparison.Ordinal
            )
            Assert.False(File.Exists(Path.Combine(fixture.Directory, "EqualityImplicitReference.dll")))
        }

        private func AssertOutputBytes(assembly string, expected string) {
            using let process = StartFixture(assembly)
            Assert.Equal(
                Encoding.UTF8.GetBytes(expected.Replace("\n", Environment.NewLine, StringComparison.Ordinal)),
                ReadOutputBytes(process)
            )
        }

        private func StartFixture(assembly string) Process {
            let start = ProcessStartInfo("dotnet"){
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(assembly) ??
                    throw InvalidOperationException("Missing fixture directory.")
            }
            start.ArgumentList.Add(assembly)
            return Process.Start(start) ?? throw InvalidOperationException("Failed to start fixture.")
        }

        private func ReadOutputBytes(process Process, timeoutMilliseconds int32 = 30_000)[]uint8 {
            using let output = MemoryStream()
            using let cancellation = CancellationTokenSource()
            let stdout = process.StandardOutput.BaseStream.CopyToAsync(output, cancellation.Token)
            let stderr = process.StandardError.ReadToEndAsync(cancellation.Token)
            let reads = Task.WhenAll([]Task{stdout, stderr})
            if !process.WaitForExit(timeoutMilliseconds) {
                let message = StringBuilder("Equality fixture timed out.")
                try {
                    process.Kill(entireProcessTree: true)
                } catch (error InvalidOperationException) {
                    message.Append(" Kill failed: ").Append(error.Message)
                } catch (error Win32Exception) {
                    message.Append(" Kill failed: ").Append(error.Message)
                }
                message.Append(" Child terminated: ").Append(process.WaitForExit(10_000)).Append(".")
                cancellation.Cancel()
                let _ = reads.ContinueWith((task Task) -> task.Exception, TaskContinuationOptions.OnlyOnFaulted)
                try {
                    reads.Wait(10_000)
                } catch (error AggregateException) when error.InnerExceptions.All(
                    (failure Exception) -> failure is OperationCanceledException or
                        IOException or
                        ObjectDisposedException
                ) {
                    message.Append(" Pipe read cancellation: ").Append(error.Message)
                }
                message.Append(" Pipe reads completed: ").Append(reads.IsCompleted).Append(".")
                throw InvalidOperationException(message.ToString())
            }
            reads.GetAwaiter().GetResult()
            Assert.True(process.ExitCode == 0, stderr.GetAwaiter().GetResult())
            return output.ToArray()
        }

        private func HashSpecifications(type Type)[]int32 {
            let hash = type.GetMethod("GetHashCode", Type.EmptyTypes) ??
                throw InvalidOperationException("Missing hash.")
            let instructions = IlInstructionReader.Read(hash.GetMethodBody()?.GetILAsByteArray())
            Assert.NotEmpty(instructions)
            return instructions
                .Where(
                (instruction IlInstruction) -> instruction.MetadataToken is int32 token &&
                    hash
                    .Module
                    .ResolveMethod(token, type.GetGenericArguments(), nil)
                    ?.Name is "Add" or
                    "Combine"
            )
                .Select(
                (instruction IlInstruction) -> instruction.MetadataToken ??
                    throw InvalidOperationException("Missing hash specification.")
            )
                .ToArray()
        }

        private func AssertTypedCalls(type Type, fields[]Type) {
            let equals = type.GetMethod("Equals", []Type{type}) ??
                throw InvalidOperationException("Missing typed Equals.")
            let calls = CallsWithoutBoxing(equals).Where(
                (method MethodInfo) -> method.DeclaringType is {IsGenericType: true} owner &&
                    owner.GetGenericTypeDefinition() == typeof(EqualityComparer[_])
            )
                .ToArray()
            Assert.Equal(fields.Length * 2, calls.Length)
            for var i = 0; i < fields.Length; i++ {
                let comparer = typeof(EqualityComparer[_]).MakeGenericType(fields[i])
                Assert.Equal("get_Default", calls[i * 2].Name)
                Assert.Equal(comparer, calls[i * 2].DeclaringType)
                Assert.Equal(comparer, calls[i * 2].ReturnType)
                Assert.Equal("Equals", calls[i * 2 + 1].Name)
                Assert.Equal(comparer, calls[i * 2 + 1].DeclaringType)
                Assert.Equal(
                    []Type{fields[i], fields[i]},
                    calls[i * 2 + 1].GetParameters().Select((p ParameterInfo) -> p.ParameterType).ToArray()
                )
            }
            let hash = type.GetMethod("GetHashCode", Type.EmptyTypes) ??
                throw InvalidOperationException("Missing hash.")
            let hashCalls = CallsWithoutBoxing(hash)
            if fields.Length <= 8 {
                let combine = Assert.Single(hashCalls)
                Assert.Equal(typeof(HashCode), combine.DeclaringType)
                Assert.Equal("Combine", combine.Name)
                Assert.Equal(fields, combine.GetGenericArguments())
                Assert.Equal(fields, combine.GetParameters().Select((p ParameterInfo) -> p.ParameterType).ToArray())
            } else {
                Assert.Equal(fields.Length + 1, hashCalls.Length)
                for var i = 0; i < fields.Length; i++ {
                    Assert.Equal(typeof(HashCode), hashCalls[i].DeclaringType)
                    Assert.Equal("Add", hashCalls[i].Name)
                    Assert.Equal([]Type{fields[i]}, hashCalls[i].GetGenericArguments())
                    Assert.Equal(fields[i], Assert.Single(hashCalls[i].GetParameters()).ParameterType)
                }
                Assert.Equal("ToHashCode", hashCalls[fields.Length].Name)
            }
        }

        private func CallsWithoutBoxing(method MethodInfo)[]MethodInfo {
            let instructions = IlInstructionReader.Read(method.GetMethodBody()?.GetILAsByteArray())
            Assert.NotEmpty(instructions)
            Assert.DoesNotContain(instructions, (instruction IlInstruction) -> instruction.OpCode == OpCodes.Box)
            return instructions
                .Where(
                (instruction IlInstruction) -> instruction.OpCode == OpCodes.Call ||
                    instruction.OpCode == OpCodes.Callvirt
            )
                .Select(
                (instruction IlInstruction) -> cast[MethodInfo](
                    method.Module.ResolveMethod(
                        instruction.MetadataToken ?? throw InvalidOperationException("Missing call token."),
                        method.DeclaringType!!.GetGenericArguments(),
                        method.GetGenericArguments()
                    ) ??
                        throw InvalidOperationException("Missing call target.")
                )
            )
                .ToArray()
        }
    }
}
