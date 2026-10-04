// <copyright file="Issue4755GenericStructInitializerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4755GenericStructInitializerEmitTests
{
    [Fact]
    public void PublicScalarInitializer_MatchesNativeRoslynRuntime()
    {
        InDirectory(directory =>
        {
            var native = EmitCSharp(directory, "Native4755", """
                namespace Native4755;
                public static class Provider<T>
                {
                    public static int Calls;
                    public static int Next() { Calls++; return 7; }
                }
                public struct Inner<T>
                {
                    public int Value = Provider<T>.Next();
                    public Inner() { }
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var item = new Inner<int>();
                        return item.Value + "/" + Provider<int>.Calls;
                    }
                }
                """);
            var nativeAssembly = EmittedFixture.Load(native);
            Assert.Equal("7/1", Invoke(nativeAssembly, "Native4755.Oracle"));

            var emitted = Compile(directory, """
                package GenericScalar4755
                class Provider[T] {
                    shared {
                        public var Calls int32
                        public func Next() int32 {
                            Calls += 1
                            return 7
                        }
                    }
                }
                struct Inner[T] {
                    public var Value int32 = Provider[T].Next()
                }
                class Api {
                    shared {
                        public func Run() string {
                            let item = Inner[int32]{}
                            return item.Value.ToString() + "/" + Provider[int32].Calls.ToString()
                        }
                    }
                }
                """);
            IlVerifier.Verify(emitted);
            AssertNativeConsumer(directory, emitted, "GenericScalar4755.Api", "7/1");
        });
    }

    [Fact]
    public void ImportedGenericInitializer_SubstitutesValueAndReferenceArguments()
    {
        InDirectory(directory =>
        {
            var native = EmitCSharp(directory, "Factory4755", """
                namespace Factory4755;
                public static class Factory<T>
                {
                    public static int Calls;
                    public static T Next()
                    {
                        Calls++;
                        return typeof(T) == typeof(int) ? (T)(object)7 : (T)(object)"text";
                    }
                }
                public struct Inner<T>
                {
                    public T Value = Factory<T>.Next();
                    public Inner() { }
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var number = new Inner<int>();
                        var text = new Inner<string>();
                        return number.Value + "/" + Factory<int>.Calls + ";" +
                            text.Value + "/" + Factory<string>.Calls;
                    }
                }
                """);
            Assert.Equal("7/1;text/1", Invoke(EmittedFixture.Load(native), "Factory4755.Oracle"));
            var emitted = Compile(directory, """
                package GenericImported4755
                import Factory4755
                struct Inner[T] {
                    public var Value T = Factory[T].Next()
                }
                class Api {
                    shared {
                        public func Run() string {
                            let number = Inner[int32]{}
                            let text = Inner[string]()
                            return number.Value.ToString() + "/" + Factory[int32].Calls.ToString() + ";" +
                                text.Value + "/" + Factory[string].Calls.ToString()
                        }
                    }
                }
                """, native);
            IlVerifier.Verify(emitted, new[] { native });
            AssertNativeConsumer(directory, emitted, "GenericImported4755.Api", "7/1;text/1", native);
        });
    }

    [Fact]
    public void ConstructorOwnership_PreservesExplicitOrderPrivateReadonlyAndZeroStorage()
    {
        InDirectory(directory =>
        {
            var native = EmitCSharp(directory, "NativeControls4755", """
                namespace NativeControls4755;
                public static class Effects
                {
                    public static string Trace = "";
                    public static int Mark(string label, int value) { Trace += label; return value; }
                }
                public struct Box<T>
                {
                    public int First = Effects.Mark("A", 7);
                    public int Second = Effects.Mark("B", 8);
                    public Box() { }
                }
                public struct Hidden<T>
                {
                    private readonly int value = Effects.Mark("H", 9);
                    public Hidden() { }
                    public int Read() => value;
                }
                public struct Open<T>
                {
                    public readonly int Value = Effects.Mark("R", 6);
                    public Open() { }
                }
                public struct Plain
                {
                    public int Value = Effects.Mark("P", 5);
                    public Plain() { }
                }
                public struct User<T>
                {
                    public int Value = Effects.Mark("U", 4);
                    public User() { }
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var item = new Box<int> { Second = Effects.Mark("S", 2), First = Effects.Mark("F", 1) };
                        var hidden = new Hidden<string>();
                        var readOnly = new Open<string>();
                        var plain = new Plain();
                        var user = new User<int>();
                        var zeros = new Open<string>[1];
                        Open<string> zero = default;
                        return item.First + "/" + item.Second + "/" + hidden.Read() + "/" +
                            readOnly.Value + "/" + plain.Value + "/" + user.Value + "/" +
                            zeros[0].Value + "/" + zero.Value + "/" + Effects.Trace;
                    }
                }
                """);
            Assert.Equal("1/2/9/6/5/4/0/0/ABSFHRPU", Invoke(EmittedFixture.Load(native), "NativeControls4755.Oracle"));
            var emitted = Compile(directory, """
                package GenericControls4755
                class Effects {
                    shared {
                        public var Trace string = ""
                        public func Mark(label string, value int32) int32 {
                            Trace += label
                            return value
                        }
                    }
                }
                struct Box[T] {
                    public var First int32 = Effects.Mark("A", 7)
                    public var Second int32 = Effects.Mark("B", 8)
                }
                struct Hidden[T] {
                    private let Hidden int32 = Effects.Mark("H", 9)
                    public func Read() int32 -> Hidden
                }
                struct Open[T] {
                    public let Value int32 = Effects.Mark("R", 6)
                }
                struct Plain {
                    public var Value int32 = Effects.Mark("P", 5)
                }
                struct User[T] {
                    public var Value int32 = Effects.Mark("U", 4)
                    public init() { }
                }
                class Api {
                    shared {
                        public func Run() string {
                            let item = Box[int32]{Second: Effects.Mark("S", 2), First: Effects.Mark("F", 1)}
                            let hidden = Hidden[string]{}
                            let readonly = Open[string]{}
                            let plain = Plain{}
                            let user = User[int32]()
                            let zeros = System.GC.AllocateArray[Open[string]](1)
                            let zero Open[string] = default
                            return item.First.ToString() + "/" + item.Second.ToString() + "/" + hidden.Read().ToString() +
                                "/" + readonly.Value.ToString() + "/" + plain.Value.ToString() + "/" + user.Value.ToString() + "/" +
                                zeros[0].Value.ToString() + "/" + zero.Value.ToString() + "/" + Effects.Trace
                        }
                    }
                }
                """);
            IlVerifier.Verify(emitted);
            var assembly = EmittedFixture.Load(emitted);
            var open = assembly.GetType("GenericControls4755.Open`1", throwOnError: true);
            Assert.NotNull(open);
            Assert.True(open.GetField("Value").IsInitOnly);
            Assert.Equal(open, open.GetField("Value").DeclaringType);
            Assert.Single(open.GetConstructors());
            Assert.Empty(assembly.GetType("GenericControls4755.Plain", throwOnError: true).GetConstructors());
            Assert.Single(assembly.GetType("GenericControls4755.User`1", throwOnError: true).GetConstructors());
            var box = assembly.GetType("GenericControls4755.Hidden`1", throwOnError: true);
            var hidden = box.GetField("Hidden", BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.NotNull(hidden);
            Assert.True(hidden.IsPrivate);
            Assert.True(hidden.IsInitOnly);
            Assert.Equal(box, hidden.DeclaringType);
            AssertNativeConsumer(directory, emitted, "GenericControls4755.Api", "1/2/9/6/5/4/0/0/ABSFHRPU");
        });
    }

    [Fact]
    public void NestedAndProjectionLiterals_UseTheSameDefinitionOwnedInitialization()
    {
        InDirectory(directory =>
        {
            var emitted = Compile(directory, """
                package GenericSibling4755
                class Provider[T] {
                    shared {
                        public var Calls int32
                        public func Next() int32 {
                            Calls += 1
                            return 7
                        }
                    }
                }
                class Outer[T] {
                    public struct Inner {
                        public var Value int32 = Provider[T].Next()
                    }
                }
                struct Source {
                    public var Copied int32
                    public var Stamp int32
                }
                struct Target[T] {
                    public var Copied T
                    public var Stamp int32 = Provider[T].Next()
                }
                class Api {
                    shared {
                        public func Run() string {
                            let nested = Outer[string].Inner{}
                            let source = Source{Copied: 42, Stamp: 23}
                            let projected Target[int32] = source
                            return nested.Value.ToString() + "/" + Provider[string].Calls.ToString() + ";" +
                                projected.Copied.ToString() + "/" + projected.Stamp.ToString() + "/" +
                                Provider[int32].Calls.ToString()
                        }
                    }
                }
                """);
            IlVerifier.Verify(emitted);
            AssertNativeConsumer(directory, emitted, "GenericSibling4755.Api", "7/1;42/23/1");
        });
    }

    private static void AssertNativeConsumer(string directory, string emitted, string api, string expected, params string[] references)
    {
        var consumer = EmitCSharp(directory, "Consumer4755",
            "public static class Consumer4755 { public static string Run() => " + api + ".Run(); }",
            references.Append(emitted).ToArray());
        IlVerifier.Verify(consumer, references.Append(emitted));
        var assemblies = EmittedFixture.LoadTogether(references.Concat(new[] { emitted, consumer }).ToArray());
        Assert.Equal(expected, Invoke(assemblies.Last(), "Consumer4755"));
    }

    private static object Invoke(Assembly assembly, string typeName) =>
        assembly.GetType(typeName, throwOnError: true).GetMethod("Run").Invoke(null, null);

    private static string Compile(string directory, string source, params string[] references)
    {
        var sourcePath = Path.Combine(directory, "Fixture.gs");
        var assemblyPath = Path.Combine(directory, "Fixture.dll");
        File.WriteAllText(sourcePath, source);
        var arguments = new[] { "/target:library", "/assemblyname:Fixture", "/out:" + assemblyPath, "/targetframework:net10.0" }
            .Concat(RuntimeReferences().Concat(references).Select(path => "/reference:" + path))
            .Append(sourcePath).ToArray();
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        try
        {
            Console.SetOut(stdout);
            Console.SetError(stderr);
            Assert.True(Program.Main(arguments) == 0, stdout.ToString() + stderr);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        return assemblyPath;
    }

    private static string EmitCSharp(string directory, string name, string source, params string[] references)
    {
        var path = Path.Combine(directory, name + ".dll");
        var compilation = CSharpCompilation.Create(
            name,
            new[] { CSharpSyntaxTree.ParseText(source) },
            RuntimeReferences().Concat(references).Select(reference => MetadataReference.CreateFromFile(reference)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var result = compilation.Emit(path);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return path;
    }

    private static string[] RuntimeReferences() =>
        Directory.GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location), "*.dll");

    private static void InDirectory(Action<string> test)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue4755_").FullName;
        try
        {
            test(directory);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
