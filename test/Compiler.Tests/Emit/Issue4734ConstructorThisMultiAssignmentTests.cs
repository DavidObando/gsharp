// <copyright file="Issue4734ConstructorThisMultiAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Reflection;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4734ConstructorThisMultiAssignmentTests
{
    [Theory]
    [InlineData("class", "this.", "(3, 7)")]
    [InlineData("class", "", "(3, 7)")]
    [InlineData("class", "this.", "3, 7")]
    [InlineData("class", "", "3, 7")]
    [InlineData("struct", "this.", "(3, 7)")]
    [InlineData("struct", "", "(3, 7)")]
    [InlineData("struct", "this.", "3, 7")]
    [InlineData("struct", "", "3, 7")]
    public void GetterOnlyConstructorStores_VerifyRunAndKeepReadonlyMetadata(
        string kind, string receiver, string values)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            $$"""
            package InitOnlyRepro
            import System

            public {{kind}} TupleProperties {
                public prop First int32 { get; }
                public prop Second int32 { get; }
                public init() {
                    {{receiver}}First, {{receiver}}Second = {{values}}
                }
            }
            func Main() {
                let value = TupleProperties()
                Console.WriteLine(value.First)
                Console.WriteLine(value.Second)
            }
            """, "InitOnlyRepro", executable: true);

        IlVerifier.Verify(dll);
        Assert.Equal("3\n7\n", fixture.Run(dll));
        var type = EmittedFixture.Load(dll).GetType("InitOnlyRepro.TupleProperties")
            ?? throw new InvalidOperationException("TupleProperties was not emitted");
        foreach (var name in new[] { "First", "Second" })
        {
            var property = type.GetProperty(name)
                ?? throw new InvalidOperationException("Missing property " + name);
            Assert.Null(property.SetMethod);
            var field = type.GetField("<" + name + ">k__BackingField", BindingFlags.NonPublic | BindingFlags.Instance)
                ?? throw new InvalidOperationException("Missing backing field " + name);
            Assert.Equal(FieldAttributes.Private | FieldAttributes.InitOnly, field.Attributes);
        }
    }

    [Theory]
    [InlineData("class")]
    [InlineData("struct")]
    public void ReadonlyFieldsAndScalarInitializers_KeepTheirExistingContracts(string kind)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            $$"""
            package ReadonlyControls
            import System
            public {{kind}} Fields {
                public let First int32 = 1
                public let Second int32
                public prop Scalar int32 { get; }
                public init() {
                    this.First, this.Second = (5, 11)
                    this.Scalar = 13
                }
            }
            class Primary(seed int32) {
                public let Field int32 = seed
                public prop Value int32 -> Field + 1
            }
            func Main() {
                let value = Fields()
                let primary = Primary(17)
                Console.WriteLine(value.First)
                Console.WriteLine(value.Second)
                Console.WriteLine(value.Scalar)
                Console.WriteLine(primary.Field)
                Console.WriteLine(primary.Value)
            }
            """, "ReadonlyControls", executable: true);

        IlVerifier.Verify(dll);
        Assert.Equal("5\n11\n13\n17\n18\n", fixture.Run(dll));
        var type = EmittedFixture.Load(dll).GetType("ReadonlyControls.Fields")
            ?? throw new InvalidOperationException("Fields was not emitted");
        var fields = type.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.Equal(3, fields.Length);
        Assert.All(fields, field => Assert.True(field.IsInitOnly, field.Name));
    }

    [Fact]
    public void MutableReceiversAndIndices_AreCapturedBeforeTheSingleTupleRhs()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            """
            package CaptureControls
            import System
            func Step(n int32) { order = order * 10 + n }
            class Box {
                var Raw int32
                prop Value int32 {
                    get { return Raw }
                    set(v) {
                        writes = writes * 10 + v
                        Raw = v
                    }
                }
            }
            func Target() Box {
                Step(1)
                return current
            }
            func Index() int32 {
                Step(2)
                return 0
            }
            func Rhs() (int32, int32, int32, int32) {
                Step(3)
                calls = calls + 1
                current = replacement
                return (7, 8, 9, 10)
            }
            class Control {
                var Raw int32
                prop Value int32 {
                    get { return Raw }
                    set(v) {
                        writes = writes * 10 + v
                        Raw = v
                    }
                }
                init() { this.Value, current.Value, Target().Value, values[Index()] = Rhs() }
            }
            var order = 0
            var writes = 0
            var calls = 0
            var old = Box{Raw: 5}
            var current = old
            var replacement = Box{Raw: 6}
            var values = []int32{0}
            let value = Control()
            Console.WriteLine(order)
            Console.WriteLine(writes)
            Console.WriteLine(calls)
            Console.WriteLine(value.Raw)
            Console.WriteLine(old.Raw)
            Console.WriteLine(current.Raw)
            Console.WriteLine(values[0])
            """, "CaptureControls", executable: true);

        IlVerifier.Verify(dll);
        Assert.Equal("123\n789\n1\n7\n9\n6\n10\n", fixture.Run(dll));
    }

    [Fact]
    public void StructPropertyReceivers_PreserveConstructorAndRefStorageIdentity()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            """
            package StructControls
            import System
            struct Counter {
                var Raw int32
                prop Value int32 { get { return Raw } set(v) { Raw = v } }
                init() { this.Value, this.Raw = (7, 8) }
            }
            func Update(ref value Counter) { value.Value, value.Raw = (9, 10) }
            func Main() {
                var value = Counter()
                Console.WriteLine(value.Raw)
                Update(ref value)
                Console.WriteLine(value.Raw)
            }
            """, "StructControls", executable: true);

        IlVerifier.Verify(dll);
        Assert.Equal("8\n10\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData("prop First int32 { get; }", "func Bad()", "this.First")]
    [InlineData("let First int32", "func Bad()", "this.First")]
    [InlineData("prop First int32 { get; }", "init(other C)", "other.First")]
    [InlineData("let First int32", "init(other C)", "other.First")]
    public void MultiAssignment_DoesNotRelaxReadonlyReceiverProtection(
        string member, string function, string target)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile(
            $$"""
            package ReadonlyRejection
            class C {
                {{member}}
                var Second int32
                {{function}} {
                    {{target}}, this.Second = (3, 7)
                }
            }
            """, "ReadonlyRejection", executable: false);

        Assert.NotEqual(0, code);
        var errors = output.Split('\n').Where(line => line.Contains("error GS0127:", StringComparison.Ordinal)).ToArray();
        Assert.Single(errors);
        Assert.Contains("ReadonlyRejection.gs(6,", errors[0], StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("prop First int32 { get; }")]
    [InlineData("let First int32")]
    public void DerivedConstructor_CannotWriteForeignReadonlyMembers(string member)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile(
            $$"""
            package OwnerRejection
            open class Base {
                {{member}}
                init() { First = 1 }
            }
            class Derived : Base {
                var Second int32
                init() : base() {
                    this.First, this.Second = (3, 7)
                }
            }
            """, "OwnerRejection", executable: false);

        Assert.NotEqual(0, code);
        var errors = output.Split('\n').Where(line => line.Contains("error GS0127:", StringComparison.Ordinal)).ToArray();
        Assert.Single(errors);
        Assert.Contains("OwnerRejection.gs(9,", errors[0], StringComparison.Ordinal);
    }
}
