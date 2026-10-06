// <copyright file="Issue4755GenericStructInitializerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4755GenericStructInitializerEmitTests
{
    [Theory]
    [InlineData(0, false)]
    [InlineData(0, true)]
    [InlineData(1, false)]
    [InlineData(1, true)]
    [InlineData(2, false)]
    [InlineData(2, true)]
    [InlineData(3, false)]
    [InlineData(3, true)]
    public void AuthoredConstructor_BraceExpressionTreesSelectOwningMarkerSignature(int shape, bool overrideValue)
    {
        InDirectory(directory =>
        {
            var markers = shape switch { 0 => 2, 1 => 3, 2 => 1, _ => 0 };
            var nativeType = shape switch { 1 => "Outer<int>.User", 2 => "User", _ => "User<int>" };
            var sourceType = shape switch { 1 => "Outer[int32].User", 2 => "User", _ => "User[int32]" };
            var nativeOther = shape switch
            {
                0 => "public User(bool ignored) { Effects.Body(\"B\"); Value = 88; }",
                1 => "public User(bool ignored, bool other) { Effects.Body(\"B\"); Value = 88; }",
                _ => "",
            };
            var sourceOther = shape switch
            {
                0 => "public init(ignored bool) { Effects.Body(\"B\")\nValue = 88 }",
                1 => "public init(ignored bool, other bool) { Effects.Body(\"B\")\nValue = 88 }",
                _ => "",
            };
            var markerParameters = string.Join(", ", Enumerable.Range(0, markers).Select(index => "bool marker" + index));
            var nativeMembers = $$"""
                private readonly int Hidden = Effects.Mark("H", 3);
                public int Value = Effects.Mark("I", 7);
                public int ReadHidden() => Hidden;
                public User() { {{(markers == 0 ? "" : "Effects.Body(\"C\"); Value = 99;")}} }
                {{nativeOther}}
                {{(markers == 0 ? "" : "internal User(" + markerParameters + ") { }")}}
                """;
            var sourceMembers = $$"""
                private let Hidden int32 = Effects.Mark("H", 3)
                public var Value int32 = Effects.Mark("I", 7)
                public func ReadHidden() int32 -> Hidden
                {{(markers == 0 ? "" : "public init() { Effects.Body(\"C\")\nValue = 99 }")}}
                {{sourceOther}}
                """;
            var nativeDeclaration = shape == 1
                ? "public class Outer<T> { public struct User { " + nativeMembers + " } }"
                : "public struct User" + (shape == 2 ? "" : "<T>") + " { " + nativeMembers + " }";
            var sourceDeclaration = shape == 1
                ? "class Outer[T] { public struct User { " + sourceMembers + " } }"
                : "struct User" + (shape == 2 ? "" : "[T]") + " { " + sourceMembers + " }";
            var native = EmitCSharp(directory, "NativeMarkerTree4755", $$"""
                using System;
                using System.Linq;
                using System.Linq.Expressions;
                using System.Reflection;
                namespace NativeMarkerTree4755;
                public static class Effects
                {
                    public static string Trace = "";
                    public static int Calls, Overrides, Bodies;
                    public static void Reset() { Trace = ""; Calls = Overrides = Bodies = 0; }
                    public static int Mark(string label, int value) { Trace += label; Calls++; return value; }
                    public static int Override(int value) { Trace += "O"; Overrides++; return value; }
                    public static void Body(string label) { Trace += label; Bodies++; }
                    public static string Describe(int first, int second, int hiddenFirst, int hiddenSecond) =>
                        first + "/" + second + "/" + hiddenFirst + "/" + hiddenSecond + "/" +
                        Trace + "/" + Calls + "/" + Overrides + "/" + Bodies;
                }
                {{nativeDeclaration}}
                public static class Oracle
                {
                    public static string Run()
                    {
                        Effects.Reset();
                        var parameter = Expression.Parameter(typeof(int), "value");
                        var constructor = typeof({{nativeType}}).GetConstructor(
                            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, null,
                            Enumerable.Repeat(typeof(bool), {{markers}}).ToArray(), null)
                            ?? throw new InvalidOperationException("Owning initializer missing");
                        var creation = Expression.New(constructor,
                            Enumerable.Range(0, {{markers}}).Select(_ => Expression.Constant(false)));
                        Expression body = creation;
                        if ({{(overrideValue ? "true" : "false")}})
                            body = Expression.MemberInit(creation, Expression.Bind(
                                typeof({{nativeType}}).GetField("Value") ?? throw new InvalidOperationException("Value missing"),
                                Expression.Call(typeof(Effects).GetMethod(nameof(Effects.Override)), parameter)));
                        var compiled = Expression.Lambda<Func<int, {{nativeType}}>>(body, parameter).Compile();
                        var first = compiled(9);
                        var second = compiled(11);
                        return Effects.Describe(first.Value, second.Value, first.ReadHidden(), second.ReadHidden());
                    }
                }
                """);
            var expected = overrideValue ? "9/11/3/3/HIOHIO/4/2/0" : "7/7/3/3/HIHI/4/0/0";
            Assert.Equal(expected, Invoke(EmittedFixture.Load(native), "NativeMarkerTree4755.Oracle"));
            var members = overrideValue ? "Value: Effects.Override(value)" : "";
            var authoredControl = markers == 0 || shape == 1 ? "" : $$"""
                public func AuthoredControl() string {
                    Effects.Reset()
                    let tree Expression[Func[{{sourceType}}]] = () -> {{sourceType}}()
                    let compiled = tree.Compile()
                    let first = compiled()
                    let second = compiled()
                    return Effects.Describe(first.Value, second.Value, first.ReadHidden(), second.ReadHidden())
                }
                """;
            var emitted = Compile(directory, $$"""
                package MarkerTree4755
                import System
                import System.Linq.Expressions
                import NativeMarkerTree4755
                {{sourceDeclaration}}
                class Api {
                    shared {
                        public func GetTree() Expression[Func[int32, {{sourceType}}]] {
                            return (value int32) -> {{sourceType}}{ {{members}} }
                        }
                        public func Run() string {
                            Effects.Reset()
                            let compiled = GetTree().Compile()
                            let first = compiled(9)
                            let second = compiled(11)
                            return Effects.Describe(first.Value, second.Value, first.ReadHidden(), second.ReadHidden())
                        }
                        public func LiteralControl() string {
                            Effects.Reset()
                            let first = {{sourceType}}{ {{(overrideValue ? "Value: Effects.Override(9)" : "")}} }
                            let second = {{sourceType}}{ {{(overrideValue ? "Value: Effects.Override(11)" : "")}} }
                            return Effects.Describe(first.Value, second.Value, first.ReadHidden(), second.ReadHidden())
                        }
                        {{authoredControl}}
                    }
                }
                """, native);
            IlVerifier.Verify(emitted, new[] { native });
            var assemblies = EmittedFixture.LoadTogether(native, emitted);
            Assert.Equal(expected, Invoke(assemblies.Last(), "MarkerTree4755.Api", "LiteralControl"));
            if (markers > 0 && shape != 1)
            {
                Assert.Equal("99/99/3/3/HICHIC/4/0/2", Invoke(assemblies.Last(), "MarkerTree4755.Api", "AuthoredControl"));
            }

            object actual = string.Empty;
            var error = Record.Exception(() => actual = Invoke(assemblies.Last(), "MarkerTree4755.Api"));
            Assert.Null(error);
            Assert.Equal(expected, actual);
            var effects = assemblies.First().GetType("NativeMarkerTree4755.Effects", throwOnError: true);
            effects.GetMethod("Reset").Invoke(null, null);
            var tree = Assert.IsAssignableFrom<LambdaExpression>(Invoke(assemblies.Last(), "MarkerTree4755.Api", "GetTree"));
            Assert.Equal("", effects.GetField("Trace").GetValue(null));
            var creation = overrideValue ? Assert.IsType<MemberInitExpression>(tree.Body).NewExpression : Assert.IsType<NewExpression>(tree.Body);
            Assert.Equal(tree.ReturnType, creation.Constructor.DeclaringType);
            Assert.Equal(markers == 0, creation.Constructor.IsPublic);
            Assert.Equal(markers > 0, creation.Constructor.IsAssembly);
            Assert.Equal(markers, creation.Constructor.GetParameters().Length);
            Assert.Equal(markers, creation.Arguments.Count);
            Assert.All(creation.Constructor.GetParameters(), parameter => Assert.Equal(typeof(bool), parameter.ParameterType));
            Assert.All(creation.Arguments, argument => Assert.Equal(false, Assert.IsType<ConstantExpression>(argument).Value));
            Assert.Equal(shape != 2, tree.ReturnType.IsGenericType);
            if (shape != 2)
            {
                Assert.Equal(typeof(int), Assert.Single(tree.ReturnType.GetGenericArguments()));
            }

            var hidden = tree.ReturnType.GetField("Hidden", BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.True(hidden.IsPrivate);
            Assert.True(hidden.IsInitOnly);
            Assert.Equal(tree.ReturnType, hidden.DeclaringType);
            AssertNativeConsumer(directory, emitted, "MarkerTree4755.Api", expected, native);
            if (markers > 0)
            {
                var consumer = EmitCSharp(directory, "NativeAuthoredMarkerControl4755", $$"""
                    public static class NativeAuthoredMarkerControl4755
                    {
                        public static string Run()
                        {
                            NativeMarkerTree4755.Effects.Reset();
                            var first = new MarkerTree4755.{{nativeType}}();
                            var second = new MarkerTree4755.{{nativeType}}();
                            return NativeMarkerTree4755.Effects.Describe(
                                first.Value, second.Value, first.ReadHidden(), second.ReadHidden());
                        }
                    }
                    """, native, emitted);
                IlVerifier.Verify(consumer, new[] { native, emitted });
                Assert.Equal("99/99/3/3/HICHIC/4/0/2",
                    Invoke(EmittedFixture.LoadTogether(native, emitted, consumer).Last(), "NativeAuthoredMarkerControl4755"));
            }

        });
    }

    [Theory]
    [InlineData(true, "definition")]
    [InlineData(false, "definition")]
    [InlineData(true, "generic")]
    [InlineData(false, "generic")]
    [InlineData(true, "enclosing")]
    public void RewrittenDeclarationInitializers_RunOnceAndPreserveAuthoredOverrides(bool primary, string shape)
    {
        InDirectory(directory =>
        {
            var native = EmitCSharp(directory, "NativeInterpolation4755", """
                namespace NativeInterpolation4755;
                public static class Provider<T>
                {
                    public static int Calls, Arguments, Overrides;
                    public static string Trace = "";
                    public static void Reset() { Calls = Arguments = Overrides = 0; Trace = ""; }
                    public static int Argument() { Arguments++; Trace += "A"; return 7; }
                    public static int Next() { Calls++; Trace += "I"; return Calls; }
                    public static string Override() { Overrides++; Trace += "O"; return "override"; }
                }
                public struct Primary(int value)
                {
                    public int Value = value;
                    public string Text = $"{Provider<int>.Next()}";
                }
                public struct Plain
                {
                    public int Value;
                    private int marker = 0;
                    public string Text = $"{Provider<int>.Next()}";
                    public Plain() { }
                }
                public static class Oracle
                {
                    public static string RunPrimary()
                    {
                        Provider<int>.Reset();
                        var first = new Primary(Provider<int>.Argument());
                        var second = new Primary(Provider<int>.Argument()) { Text = Provider<int>.Override() };
                        return first.Text + "/" + second.Text + "/" + Provider<int>.Calls + "/" +
                            Provider<int>.Arguments + "/" + Provider<int>.Overrides + "/" + Provider<int>.Trace;
                    }
                    public static string RunPlain()
                    {
                        Provider<int>.Reset();
                        var first = new Plain { Value = Provider<int>.Argument() };
                        var second = new Plain { Value = Provider<int>.Argument(), Text = Provider<int>.Override() };
                        return first.Text + "/" + second.Text + "/" + Provider<int>.Calls + "/" +
                            Provider<int>.Arguments + "/" + Provider<int>.Overrides + "/" + Provider<int>.Trace;
                    }
                }
                """);
            var expected = primary ? "1/override/2/2/1/AIAIO" : "1/override/2/2/1/IAIAO";
            Assert.Equal(expected, Invoke(EmittedFixture.Load(native), "NativeInterpolation4755.Oracle", primary ? "RunPrimary" : "RunPlain"));
            IlVerifier.Verify(native);
            var parameter = shape == "definition" ? "int32" : "T";
            var declaration = $$"""
                struct Item{{(shape == "generic" ? "[T]" : string.Empty)}}{{(primary ? "(Value int32)" : string.Empty)}} {
                    {{(primary ? string.Empty : "public var Value int32\nprivate let Marker int32 = 0")}}
                    public var Text string = "${Provider[{{parameter}}].Next()}"
                }
                """;
            if (shape == "enclosing")
            {
                declaration = "class Outer[T] { public " + declaration + " }";
            }

            var target = shape switch
            {
                "generic" => "Item[int32]",
                "enclosing" => "Outer[int32].Item",
                _ => "Item",
            };
            var emitted = Compile(directory, $$"""
                package RewrittenInitializers4755
                import NativeInterpolation4755
                {{declaration}}
                class Api {
                    shared {
                        public func Run() string {
                            Provider[int32].Reset()
                            let first = {{target}}{Value: Provider[int32].Argument()}
                            let second = {{target}}{Value: Provider[int32].Argument(), Text: Provider[int32].Override()}
                            return first.Text + "/" + second.Text + "/" + Provider[int32].Calls.ToString() + "/" +
                                Provider[int32].Arguments.ToString() + "/" + Provider[int32].Overrides.ToString() + "/" + Provider[int32].Trace
                        }
                    }
                }
                """, native);
            IlVerifier.Verify(emitted, new[] { native });
            AssertNativeConsumer(directory, emitted, "RewrittenInitializers4755.Api", expected, native);
        });
    }

    [Theory]
    [InlineData("return default")]
    [InlineData("let next = func () T { return default }\nreturn next()")]
    [InlineData("let next = func () T { let leaf = func () T { return default }\nreturn leaf() }\nreturn next()")]
    [InlineData("let next[U] = func (input U) T { return default }\nreturn next[int32](1)")]
    public void InitializerFunctions_AreAnalyzedForEachConstructedOwner(string body)
    {
        InDirectory(directory =>
        {
            var result = TryCompile(directory, $$"""
                package FunctionContexts4755
                struct S[T] {
                    public var Factory () -> T = func () T { {{body}} }
                }
                class Api {
                    shared {
                        public func Bad() readonly managed[int32] {
                            let scalar = S[int32]{}
                            let number = scalar.Factory()
                            let managed = S[readonly managed[int32]]{}
                            return managed.Factory()
                        }
                    }
                }
                """, typeof(Gsharp.Values.ReadOnlyManagedRef<>).Assembly.Location);
            Assert.Equal(1, result.Code);
            Assert.Contains("error GS0604:", result.Output, StringComparison.Ordinal);
            Assert.Contains("default would synthesize a null non-null managed-reference slot", result.Output, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", result.Output, StringComparison.Ordinal);
            Assert.DoesNotContain("error GS0005:", result.Output, StringComparison.Ordinal);
            Assert.False(File.Exists(result.AssemblyPath));
        });
    }

    [Theory]
    [InlineData("return default")]
    [InlineData("let next = func () T { return default }\nreturn next()")]
    [InlineData("let next = func () T { let leaf = func () T { return default }\nreturn leaf() }\nreturn next()")]
    [InlineData("let next[U] = func (input U) T { return default }\nreturn next[int32](1)")]
    public void InitializerFunctions_PreserveLegalScalarAndNullableConstructedOwners(string body)
    {
        InDirectory(directory =>
        {
            var values = typeof(Gsharp.Values.ReadOnlyManagedRef<>).Assembly.Location;
            var native = EmitCSharp(directory, "NativeFunctionContexts4755", """
                namespace NativeFunctionContexts4755;
                public struct S<T>
                {
                    public System.Func<T> Factory = () => { T Next<U>(U input) => default(T); return Next(1); };
                    public S() { }
                }
                public static class Oracle
                {
                    public static string Run() => new S<int>().Factory() + "/" +
                        (new S<string>().Factory() == null) + "/" +
                        (new S<Gsharp.Values.ReadOnlyManagedRef<int>>().Factory() == null);
                }
                """, values);
            const string expected = "0/True/True";
            Assert.Equal(expected, Invoke(EmittedFixture.LoadTogether(values, native).Last(), "NativeFunctionContexts4755.Oracle"));
            IlVerifier.Verify(native, new[] { values });
            var emitted = Compile(directory, $$"""
                package LegalFunctionContexts4755
                struct S[T] {
                    public var Factory () -> T = func () T { {{body}} }
                }
                class Api {
                    shared {
                        public func Run() string {
                            let scalar = S[int32]{}
                            let text = S[string?]{}
                            let managed = S[readonly managed[int32]?]{}
                            return scalar.Factory().ToString() + "/" + (text.Factory() == nil).ToString() + "/" +
                                (managed.Factory() == nil).ToString()
                        }
                    }
                }
                """, values);
            IlVerifier.Verify(emitted, new[] { values });
            AssertNativeConsumer(directory, emitted, "LegalFunctionContexts4755.Api", expected, values);
        });
    }

    [Theory]
    [InlineData("readonly managed[int32]", "false", false)]
    [InlineData("managed[int32]", "false", false)]
    [InlineData("[1]readonly managed[int32]", "false", false)]
    [InlineData("(readonly managed[int32], int32)", "false", false)]
    [InlineData("readonly managed[int32]", "", false)]
    [InlineData("readonly managed[int32]", "false", true)]
    public void ExplicitConstructedConstructors_RejectRequiredDeclarationDefaults(string argumentType, string arguments, bool nested)
    {
        InDirectory(directory =>
        {
            var source = $$"""
                package ExplicitDefaults4755
                struct S[T](Value T) {
                    private var Copy T = default
                    public init(flag bool) { }
                    public init() { }
                }
                {{(nested ? "struct Outer[T] { private var Inner S[T] = S[T](false)\npublic init(flag bool) { } }" : string.Empty)}}
                func Bad() { let item = {{(nested ? "Outer" : "S")}}[{{argumentType}}]({{arguments}}) }
                """;
            var result = TryCompile(directory, source, typeof(Gsharp.Values.ReadOnlyManagedRef<>).Assembly.Location);
            Assert.Equal(1, result.Code);
            Assert.Contains("default would synthesize a null non-null managed-reference slot", result.Output, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", result.Output, StringComparison.Ordinal);
            Assert.False(File.Exists(result.AssemblyPath));
            var offset = source.IndexOf("default", StringComparison.Ordinal);
            Assert.True(offset >= 0);
            var line = source[..offset].Count(character => character == '\n') + 1;
            var column = offset - source.LastIndexOf('\n', offset);
            Assert.Contains($"Fixture.gs({line},{column},{line},{column + "default".Length}): error GS0604:", result.Output, StringComparison.Ordinal);
            Assert.Single(result.Output.Split('\n'), text => text.Contains("error GS0604:", StringComparison.Ordinal));
        });
    }

    [Fact]
    public void ExplicitConstructedConstructors_PreserveLegalDefaultsAndBodyAssignments()
    {
        InDirectory(directory =>
        {
            var values = typeof(Gsharp.Values.ReadOnlyManagedRef<>).Assembly.Location;
            var native = EmitCSharp(directory, "NativeExplicitDefaults4755", """
                namespace NativeExplicitDefaults4755;
                public static class Effects
                {
                    public static string Trace = "";
                    public static bool Argument() { Trace += "A"; return false; }
                    public static int Observe() { Trace += "B"; return 9; }
                }
                public static class Factory
                {
                    public static Gsharp.Values.ReadOnlyManagedRef<int> Make() =>
                        Gsharp.Values.ReadOnlyManagedRef<int>.FromArray(new[] { 7 }, 0);
                    public static bool MissingReference(string value) => value == null;
                }
                public struct S<T>(T value)
                {
                    public T Value = value;
                    private T copy = default;
                    public S(bool flag) : this(default(T)) { Effects.Trace += "C"; }
                    public T Read() => copy;
                }
                public struct Assigned<T>
                {
                    public T Value;
                    public Assigned(T value) { Value = value; Effects.Trace += "R"; }
                }
                public struct Concrete
                {
                    private int copy = Effects.Observe();
                    public Concrete(bool flag) { Effects.Trace += "N"; }
                    public int Read() => copy;
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var scalar = new S<int>(Effects.Argument());
                        var text = new S<string>(false);
                        var nullable = new S<string>(false);
                        var nullableHandle = new S<Gsharp.Values.ReadOnlyManagedRef<int>>(false);
                        var assigned = new Assigned<Gsharp.Values.ReadOnlyManagedRef<int>>(Factory.Make());
                        var ordinary = new S<int>(7);
                        var concrete = new Concrete(false);
                        return scalar.Read() + "/" + Factory.MissingReference(text.Read()) + "/" +
                            (nullable.Read() == null) + "/" + (nullableHandle.Read() == null) + "/" +
                            assigned.Value.Borrow() + "/" + ordinary.Read() + "/" + ordinary.Value + "/" +
                            concrete.Read() + "/" + Effects.Trace;
                    }
                }
                """, values);
            const string expected = "0/True/True/True/7/0/7/9/ACCCCRBN";
            Assert.Equal(expected, Invoke(EmittedFixture.LoadTogether(values, native).Last(), "NativeExplicitDefaults4755.Oracle"));
            IlVerifier.Verify(native, new[] { values });
            var emitted = Compile(directory, """
                package ExplicitDefaults4755Controls
                import NativeExplicitDefaults4755
                struct S[T](Value T) {
                    private var Copy T = default
                    public init(flag bool) { Effects.Trace += "C" }
                    public func Read() T -> Copy
                }
                struct Assigned[T] {
                    public var Value T
                    public init(value T) { Value = value Effects.Trace += "R" }
                }
                struct Concrete {
                    private var Copy int32 = Effects.Observe()
                    public init(flag bool) { Effects.Trace += "N" }
                    public func Read() int32 -> Copy
                }
                class Api {
                    shared {
                        public func Run() string {
                            let scalar = S[int32](Effects.Argument())
                            let text = S[string](false)
                            let nullable = S[string?](false)
                            let nullableHandle = S[readonly managed[int32]?](false)
                            let assigned = Assigned[readonly managed[int32]](Factory.Make())
                            let ordinary = S[int32]{Value: 7}
                            let concrete = Concrete(false)
                            return scalar.Read().ToString() + "/" + Factory.MissingReference(text.Read()).ToString() + "/" +
                                (nullable.Read() == nil).ToString() + "/" + (nullableHandle.Read() == nil).ToString() + "/" +
                                (*assigned.Value).ToString() + "/" + ordinary.Read().ToString() + "/" + ordinary.Value.ToString() + "/" +
                                concrete.Read().ToString() + "/" + Effects.Trace
                        }
                    }
                }
                """, native, values);
            IlVerifier.Verify(emitted, new[] { native, values });
            AssertNativeConsumer(directory, emitted, "ExplicitDefaults4755Controls.Api", expected, native, values);
        });
    }

    [Fact]
    public void ImportedPrimaryMagicCollections_RetainClrLiteralInitialization()
    {
        InDirectory(directory =>
        {
            var native = EmitCSharp(directory, "NativeImportedMagic4755", """
                using System.Reflection;
                [assembly: AssemblyMetadata("GSharp.TypeSemantics", "33554434|struct|1|Value")]
                [assembly: AssemblyMetadata("GSharp.MagicCollectionFields", "33554434|Items:slice,Buffer:arr2")]
                namespace NativeImportedMagic4755;
                public struct Scalar
                {
                    public int Value;
                    public int[] Items = System.Array.Empty<int>();
                    public int[] Buffer = new int[2];
                    public Scalar(int Value) { this.Value = Value; }
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var number = new Scalar(7);
                        var supplied = new Scalar(9) { Items = new[] { 5 } };
                        return number.Value + "/" + number.Items.Length + "/" + number.Buffer.Length + ";" +
                            supplied.Value + "/" + supplied.Items.Length + "/" + supplied.Buffer.Length;
                    }
                }
                """);
            var assembly = EmittedFixture.Load(native);
            Assert.Equal(33554434, assembly.GetType("NativeImportedMagic4755.Scalar", throwOnError: true).MetadataToken);
            Assert.Equal("7/0/2;9/1/2", Invoke(assembly, "NativeImportedMagic4755.Oracle"));
            IlVerifier.Verify(native);
            var emitted = Compile(directory, """
                package ImportedMagic4755
                import NativeImportedMagic4755
                class Api {
                    shared {
                        public func Run() string {
                            let number = Scalar{Value: 7}
                            let supplied = Scalar{Value: 9, Items: []int32{5}}
                            return number.Value.ToString() + "/" + number.Items.Length.ToString() + "/" + number.Buffer.Length.ToString() + ";" +
                                supplied.Value.ToString() + "/" + supplied.Items.Length.ToString() + "/" + supplied.Buffer.Length.ToString()
                        }
                    }
                }
                """, native);
            IlVerifier.Verify(emitted, new[] { native });
            AssertNativeConsumer(directory, emitted, "ImportedMagic4755.Api", "7/0/2;9/1/2", native);
        });
    }

    [Fact]
    public void DataPrimaryConstructor_IsRegisteredBeforeInterfaceAndClassCallers()
    {
        InDirectory(directory =>
        {
            var native = EmitCSharp(directory, "NativeData4755", """
                namespace NativeData4755;
                public static class Effects { public static int Calls; }
                public record struct Data<T>(T Value)
                {
                    private readonly T copy = Observe(Value);
                    private static T Observe(T value) { Effects.Calls++; return value; }
                    public T Read() => copy;
                }
                public interface Factory { public static Data<int> Make() => new(7); }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var number = Factory.Make();
                        var text = new Data<string>("text");
                        return number.Value + "/" + number.Read() + ";" + text.Value + "/" + text.Read() + ";" + Effects.Calls;
                    }
                }
                """);
            Assert.Equal("7/7;text/text;2", Invoke(EmittedFixture.Load(native), "NativeData4755.Oracle"));
            var emitted = Compile(directory, """
                package Data4755
                class Effects { shared { public var Calls int32 } }
                data struct Data[T](Value T) {
                    private let Copy T = Observe(Value)
                    public func Read() T -> Copy
                    shared { private func Observe(value T) T { Effects.Calls += 1 return value } }
                }
                interface Factory {
                    shared { func Make() Data[int32] { return Data[int32]{Value: 7} } }
                }
                class Api {
                    shared {
                        public func Run() string {
                            let number = Factory.Make()
                            let text = Data[string]{Value: "text"}
                            return number.Value.ToString() + "/" + number.Read().ToString() + ";" +
                                text.Value + "/" + text.Read() + ";" + Effects.Calls.ToString()
                        }
                    }
                }
                """);
            IlVerifier.Verify(emitted);
            AssertNativeConsumer(directory, emitted, "Data4755.Api", "7/7;text/text;2");
            var type = EmittedFixture.Load(emitted).GetType("Data4755.Data`1", throwOnError: true);
            Assert.Single(type.GetConstructors());
            Assert.Single(type.GetConstructors(), constructor => constructor.GetParameters().Length == 1);
            var field = type.GetField("Copy", BindingFlags.NonPublic | BindingFlags.Instance);
            Assert.True(field.IsPrivate);
            Assert.True(field.IsInitOnly);
            Assert.Equal(type, field.DeclaringType);
        });
    }

    [Theory]
    [InlineData("struct Duplicate(Value int32)", "int32", "public struct Duplicate(int value) { public Duplicate(int other) { } }")]
    [InlineData("struct Duplicate[T](Value T)", "T", "public struct Duplicate<T>(T value) { public Duplicate(T other) { } }")]
    public void AuthoredConstructor_DuplicatePrimarySignatureIsRejected(string declaration, string parameterType, string nativeSource)
    {
        var native = CSharpCompilation.Create(
            "Duplicate4755",
            new[] { CSharpSyntaxTree.ParseText(nativeSource) },
            RuntimeReferences().Select(reference => MetadataReference.CreateFromFile(reference)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        Assert.Contains(native.GetDiagnostics(), diagnostic => diagnostic.Id == "CS0111");
        InDirectory(directory =>
        {
            var result = TryCompile(directory, $$"""
                package Duplicate4755
                {{declaration}} {
                    public var Copy {{parameterType}} = Value
                    public init(other {{parameterType}}) { }
                }
                """);
            Assert.Equal(1, result.Code);
            Assert.Contains("GS0284", result.Output, StringComparison.Ordinal);
            Assert.Contains("(4,12,", result.Output, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", result.Output, StringComparison.Ordinal);
            Assert.False(File.Exists(result.AssemblyPath));
        });
    }

    [Fact]
    public void AuthoredPrimaryConstructor_DeclarationClosuresRetainTheirOwningStorage()
    {
        InDirectory(directory =>
        {
            var native = EmitCSharp(directory, "NativeCaptured4755", """
                namespace NativeCaptured4755;
                public static class Effects { public static string Trace = ""; }
                public struct Captured<T>(T value)
                {
                    public T Value = value;
                    public System.Func<T> Read = Observe(() => value);
                    private readonly System.Func<System.Func<T>> nested = () => () => value;
                    private static System.Func<T> Observe(System.Func<T> read) { Effects.Trace += "I"; return read; }
                    public Captured() : this(default(T)) { Effects.Trace += "C"; }
                    public Captured(bool first, bool second) : this(default(T)) { Effects.Trace += "A"; }
                    public T Nested() => nested()();
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var number = new Captured<int>(7);
                        number.Value = 9;
                        var zero = new Captured<int>();
                        zero.Value = 9;
                        var text = new Captured<string?>("text");
                        text.Value = "changed";
                        var missing = new Captured<string?>(false, false);
                        missing.Value = "changed";
                        return number.Read() + "/" + number.Nested() + ";" + zero.Read() + "/" + zero.Nested() +
                            ";" + text.Read() + "/" + text.Nested() + ";" +
                            (missing.Read() == null) + "/" + (missing.Nested() == null) + ";" + Effects.Trace;
                    }
                }
                """);
            Assert.Equal("7/7;0/0;text/text;True/True;IICIIA",
                Invoke(EmittedFixture.Load(native), "NativeCaptured4755.Oracle"));
            var emitted = Compile(directory, """
                package Captured4755
                class Effects { shared { public var Trace string = "" } }
                struct Captured[T](Value T) {
                    public var Read () -> T = Observe(func () T { return Value })
                    private let NestedReader () -> (() -> T) = func () (() -> T) {
                        return func () T { return Value }
                    }
                    public init() { Effects.Trace += "C" }
                    public init(first bool, second bool) { Effects.Trace += "A" }
                    public func Nested() T -> NestedReader()()
                    shared { private func Observe(read () -> T) () -> T { Effects.Trace += "I" return read } }
                }
                class Api {
                    shared {
                        public func Run() string {
                            var number = Captured[int32]{Value: 7}
                            number.Value = 9
                            var zero = Captured[int32]()
                            zero.Value = 9
                            var text = Captured[string?]{Value: "text"}
                            text.Value = "changed"
                            var missing = Captured[string?](false, false)
                            missing.Value = "changed"
                            return number.Read().ToString() + "/" + number.Nested().ToString() + ";" +
                                zero.Read().ToString() + "/" + zero.Nested().ToString() + ";" +
                                text.Read()!! + "/" + text.Nested()!! + ";" +
                                (missing.Read() == nil).ToString() + "/" + (missing.Nested() == nil).ToString() +
                                ";" + Effects.Trace
                        }
                    }
                }
                """);
            IlVerifier.Verify(emitted);
            AssertNativeConsumer(directory, emitted, "Captured4755.Api", "7/7;0/0;text/text;True/True;IICIIA");
            var type = EmittedFixture.Load(emitted).GetType("Captured4755.Captured`1", throwOnError: true);
            Assert.Equal(3, type.GetConstructors().Length);
            var field = type.GetField("NestedReader", BindingFlags.NonPublic | BindingFlags.Instance);
            Assert.True(field.IsPrivate);
            Assert.True(field.IsInitOnly);
            Assert.Equal(type, field.DeclaringType);
        });
    }

    [Fact]
    public void OrderedPrimaryMembers_ReachTheInitializerBeforeCollectionPopulation()
    {
        InDirectory(directory =>
        {
            var native = EmitCSharp(directory, "NativeOrdered4755", """
                namespace NativeOrdered4755;
                public static class Effects
                {
                    public static string Trace = "";
                    public static int Mark(string label, int value) { Trace += label; return value; }
                }
                public struct Pair<T>(T first, T second)
                {
                    public T First = first;
                    public T Second = second;
                    public T Copy = Observe(first);
                    public System.Collections.Generic.List<int> Items = new();
                    private static T Observe(T value) { Effects.Trace += "I"; return value; }
                    public Pair() : this(default, default) { }
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var item = new Pair<int>(second: Effects.Mark("B", 2), first: Effects.Mark("A", 7))
                            { Items = { Effects.Mark("E", 1) }, Copy = Effects.Mark("S", 9) };
                        return item.First + "/" + item.Second + "/" + item.Copy + "/" + item.Items.Count + "/" + Effects.Trace;
                    }
                }
                """);
            Assert.Equal("7/2/9/1/BAIES", Invoke(EmittedFixture.Load(native), "NativeOrdered4755.Oracle"));
            var emitted = Compile(directory, """
                package Ordered4755
                import System.Collections.Generic
                class Effects {
                    shared {
                        public var Trace string = ""
                        public func Mark(label string, value int32) int32 { Trace += label return value }
                    }
                }
                struct Pair[T](First T, Second T) {
                    public var Copy T = Observe(First)
                    public var Items List[int32] = List[int32]()
                    public init() { }
                    shared {
                        private func Observe(value T) T { Effects.Trace += "I" return value }
                    }
                }
                class Api {
                    shared {
                        public func Run() string {
                            let item = Pair[int32]{Second: Effects.Mark("B", 2), Items: {Effects.Mark("E", 1)},
                                First: Effects.Mark("A", 7), Copy: Effects.Mark("S", 9)}
                            return item.First.ToString() + "/" + item.Second.ToString() + "/" + item.Copy.ToString() +
                                "/" + item.Items.Count.ToString() + "/" + Effects.Trace
                        }
                        public func Original() string {
                            let item = Pair[int32]{First: 7, Second: 2, Items: {1}}
                            return item.First.ToString() + "/" + item.Copy.ToString() + "/" + item.Items.Count.ToString()
                        }
                        public func Reference() string {
                            let item = Pair[string]{First: "text", Second: "right", Items: {1}}
                            return item.First + "/" + item.Copy + "/" + item.Items.Count.ToString()
                        }
                    }
                }
                """);
            IlVerifier.Verify(emitted);
            AssertNativeConsumer(directory, emitted, "Ordered4755.Api", "7/2/9/1/BAIES");
            Assert.Equal("7/7/1", Invoke(EmittedFixture.Load(emitted), "Ordered4755.Api", "Original"));
            Assert.Equal("text/text/1", Invoke(EmittedFixture.Load(emitted), "Ordered4755.Api", "Reference"));
            var pair = EmittedFixture.Load(emitted).GetType("Ordered4755.Pair`1", throwOnError: true);
            Assert.Equal(2, pair.GetConstructors().Length);
            Assert.Empty(pair.GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic));
            var consumer = EmitCSharp(directory, "DirectOrdered4755", """
                public static class DirectOrdered4755
                {
                    public static string Run()
                    {
                        var value = new Ordered4755.Pair<int>(7, 2);
                        var zero = new Ordered4755.Pair<int>();
                        return value.First + "/" + value.Copy + ";" + zero.First + "/" + zero.Copy;
                    }
                }
                """, emitted);
            Assert.Equal("7/7;0/0", Invoke(EmittedFixture.LoadTogether(emitted, consumer).Last(), "DirectOrdered4755"));
        });
    }

    [Fact]
    public void AuthoredDefaultConstructor_LiteralsInitializeWithoutExecutingItsBody()
    {
        InDirectory(directory =>
        {
            var native = EmitCSharp(directory, "NativeAuthored4755", """
                namespace NativeAuthored4755;
                public static class Effects { public static string Trace = ""; }
                public struct User<T>
                {
                    private readonly int hidden = Next();
                    public int Read() => hidden;
                    private static int Next() { Effects.Trace += "I"; return 7; }
                    public User() { Effects.Trace += "C"; }
                    public User(bool first, bool second) { Effects.Trace += "A"; }
                    internal User(bool first, bool second, bool marker) { }
                    public static User<T> Literal() => new(false, false, false);
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var first = User<int>.Literal();
                        var second = new User<int>();
                        var third = User<string>.Literal();
                        var fourth = new User<string>(false, false);
                        User<int> zero = default;
                        var zeros = new User<string>[1];
                        return first.Read() + "/" + second.Read() + "/" + third.Read() + "/" + fourth.Read() +
                            "/" + zero.Read() + "/" + zeros[0].Read() + "/" + Effects.Trace;
                    }
                }
                """);
            Assert.Equal("7/7/7/7/0/0/IICIIA", Invoke(EmittedFixture.Load(native), "NativeAuthored4755.Oracle"));
            var emitted = Compile(directory, """
                package Authored4755
                class Effects { shared { public var Trace string = "" } }
                struct User[T] {
                    private let Hidden int32 = Next()
                    public func Read() int32 -> Hidden
                    public init() { Effects.Trace += "C" }
                    public init(first bool, second bool) { Effects.Trace += "A" }
                    shared { private func Next() int32 { Effects.Trace += "I" return 7 } }
                }
                data struct Data[T](Value T) {
                    public var Copy T = Value
                }
                class Api {
                    shared {
                        public func Run() string {
                            let first = User[int32]{}
                            let second = User[int32]()
                            let third = User[string]{}
                            let fourth = User[string](false, false)
                            let zero User[int32] = default
                            let zeros = System.GC.AllocateArray[User[string]](1)
                            return first.Read().ToString() + "/" + second.Read().ToString() + "/" +
                                third.Read().ToString() + "/" + fourth.Read().ToString() + "/" +
                                zero.Read().ToString() + "/" + zeros[0].Read().ToString() + "/" + Effects.Trace
                        }
                        public func DataRead() string {
                            let number = Data[int32]{Value: 7}
                            let text = Data[string]("text")
                            return number.Value.ToString() + "/" + number.Copy.ToString() + ";" + text.Value + "/" + text.Copy
                        }
                    }
                }
                """);
            IlVerifier.Verify(emitted);
            var type = EmittedFixture.Load(emitted).GetType("Authored4755.User`1", throwOnError: true);
            Assert.Equal(2, type.GetConstructors().Length);
            var initializer = Assert.Single(type.GetConstructors(BindingFlags.NonPublic | BindingFlags.Instance));
            Assert.True(initializer.IsAssembly);
            Assert.Equal(3, initializer.GetParameters().Length);
            Assert.All(initializer.GetParameters(), parameter => Assert.Equal(typeof(bool), parameter.ParameterType));
            var field = type.GetField("Hidden", BindingFlags.NonPublic | BindingFlags.Instance);
            Assert.True(field.IsPrivate);
            Assert.True(field.IsInitOnly);
            Assert.Equal(type, field.DeclaringType);
            AssertNativeConsumer(directory, emitted, "Authored4755.Api", "7/7/7/7/0/0/IICIIA");
            Assert.Equal("7/7;text/text", Invoke(EmittedFixture.Load(emitted), "Authored4755.Api", "DataRead"));
            var data = EmittedFixture.Load(emitted).GetType("Authored4755.Data`1", throwOnError: true);
            Assert.Single(data.GetConstructors());
            Assert.Empty(data.GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic));
            var consumer = EmitCSharp(directory, "DirectAuthored4755", """
                public static class DirectAuthored4755
                {
                    public static string Run()
                    {
                        var value = new Authored4755.User<int>();
                        var data = new Authored4755.Data<string>("text");
                        return value.Read() + "/" + Authored4755.Effects.Trace + ";" + data.Value + "/" + data.Copy;
                    }
                }
                """, emitted);
            Assert.Equal("7/IC;text/text", Invoke(EmittedFixture.LoadTogether(emitted, consumer).Last(), "DirectAuthored4755"));
        });
    }

    [Fact]
    public void OrderedRequiredPrimaryInputs_AreProvidedOnceBeforePopulation()
    {
        InDirectory(directory =>
        {
            var values = typeof(Gsharp.Values.ReadOnlyManagedRef<>).Assembly.Location;
            var native = EmitCSharp(directory, "RequiredOrdered4755", """
                namespace RequiredOrdered4755;
                public static class Factory
                {
                    public static int Calls;
                    public static Gsharp.Values.ReadOnlyManagedRef<int> Make()
                    {
                        Calls++;
                        return Gsharp.Values.ReadOnlyManagedRef<int>.FromArray(new[] { 7 }, 0);
                    }
                }
                public struct Holder<T>(T value)
                {
                    public T Value = value;
                    public T Copy = value;
                    public System.Collections.Generic.List<int> Items = new();
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var value = new Holder<Gsharp.Values.ReadOnlyManagedRef<int>>(Factory.Make()) { Items = { 1 } };
                        return value.Value.Borrow() + "/" + value.Copy.Borrow() + "/" + value.Items.Count + "/" + Factory.Calls;
                    }
                }
                """, values);
            Assert.Equal("7/7/1/1", Invoke(EmittedFixture.LoadTogether(values, native).Last(), "RequiredOrdered4755.Oracle"));
            var emitted = Compile(directory, """
                package RequiredOrdered4755Controls
                import RequiredOrdered4755
                struct Holder[T](Value T) {
                    public var Copy T = Value
                    public var Items System.Collections.Generic.List[int32] = System.Collections.Generic.List[int32]()
                }
                class Api {
                    shared {
                        public func Run() string {
                            let value = Holder[readonly managed[int32]]{Items: {1}, Value: Factory.Make()}
                            return value.Value.Borrow().ToString() + "/" + value.Copy.Borrow().ToString() +
                                "/" + value.Items.Count.ToString() + "/" + Factory.Calls.ToString()
                        }
                    }
                }
                """, native, values);
            IlVerifier.Verify(emitted, new[] { native, values });
            AssertNativeConsumer(directory, emitted, "RequiredOrdered4755Controls.Api", "7/7/1/1", native, values);
        });
    }

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
    public void AuthoredRequiredStorage_PreservesConstructorCallsAndValidatesLiteralInputs()
    {
        InDirectory(directory =>
        {
            var values = typeof(Gsharp.Values.ReadOnlyManagedRef<>).Assembly.Location;
            var native = EmitCSharp(directory, "RequiredAuthored4755", """
                namespace RequiredAuthored4755;
                public static class Factory
                {
                    public static int Calls;
                    public static Gsharp.Values.ReadOnlyManagedRef<int> Make()
                    {
                        Calls++;
                        return Gsharp.Values.ReadOnlyManagedRef<int>.FromArray(new[] { 7 }, 0);
                    }
                }
                public struct Owner<T>
                {
                    public Gsharp.Values.ReadOnlyManagedRef<int> Handle;
                    private readonly int seed = 7;
                    public Owner() { Handle = Factory.Make(); }
                    internal Owner(bool marker) { Handle = default; }
                    public int Read() => seed;
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var called = new Owner<int>();
                        var literal = new Owner<string>(false) { Handle = Factory.Make() };
                        return called.Handle.Borrow() + "/" + called.Read() + ";" +
                            literal.Handle.Borrow() + "/" + literal.Read() + ";" + Factory.Calls;
                    }
                }
                """, values);
            Assert.Equal("7/7;7/7;2", Invoke(EmittedFixture.LoadTogether(values, native).Last(), "RequiredAuthored4755.Oracle"));
            const string declarations = """
                package RequiredAuthored4755Controls
                import RequiredAuthored4755
                struct Owner[T] {
                    public var Handle readonly managed[int32]
                    private let Seed int32 = 7
                    public init() { Handle = Factory.Make() }
                    public func Read() int32 -> Seed
                }
                """;
            var emitted = Compile(directory, declarations + """

                class Api {
                    shared {
                        public func Run() string {
                            let called = Owner[int32]()
                            let literal = Owner[string]{Handle: Factory.Make()}
                            return called.Handle.Borrow().ToString() + "/" + called.Read().ToString() + ";" +
                                literal.Handle.Borrow().ToString() + "/" + literal.Read().ToString() + ";" + Factory.Calls.ToString()
                        }
                    }
                }
                """, native, values);
            IlVerifier.Verify(emitted, new[] { native, values });
            AssertNativeConsumer(directory, emitted, "RequiredAuthored4755Controls.Api", "7/7;7/7;2", native, values);
            var rejectedDirectory = Directory.CreateDirectory(Path.Combine(directory, "Rejected")).FullName;
            var rejected = TryCompile(rejectedDirectory, declarations + "\nfunc Bad() { let value = Owner[int32]{} }", native, values);
            Assert.Equal(1, rejected.Code);
            Assert.Contains("error GS0604:", rejected.Output, StringComparison.Ordinal);
            Assert.Contains("construction must initialize non-null managed-reference field 'Handle'", rejected.Output, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", rejected.Output, StringComparison.Ordinal);
            Assert.False(File.Exists(rejected.AssemblyPath));
        });
    }

    [Fact]
    public void ImportedPositionalRecords_RetainTheirClrPropertyConstructorContract()
    {
        InDirectory(directory =>
        {
            var native = EmitCSharp(directory, "Positional4755", """
                namespace Positional4755;
                public record Box<T>(T Value);
                public readonly record struct Cell<T>(T Value);
                public static class Oracle
                {
                    public static string Run()
                    {
                        var value = new Box<int>(7);
                        var copied = value with { Value = 8 };
                        var text = new Cell<string>("text");
                        var textCopy = text with { Value = "copy" };
                        return value.Value + "/" + copied.Value + ";" + text.Value + "/" + textCopy.Value;
                    }
                }
                """);
            Assert.Equal("7/8;text/copy", Invoke(EmittedFixture.Load(native), "Positional4755.Oracle"));
            var emitted = Compile(directory, """
                package Positional4755Controls
                import Positional4755
                class Api {
                    shared {
                        public func Run() string {
                            let value = Box[int32](7)
                            let copied = value with { Value = 8 }
                            let text = Cell[string]("text")
                            let textCopy = text with { Value = "copy" }
                            return value.Value.ToString() + "/" + copied.Value.ToString() + ";" + text.Value + "/" + textCopy.Value
                        }
                    }
                }
                """, native);
            IlVerifier.Verify(emitted, new[] { native });
            AssertNativeConsumer(directory, emitted, "Positional4755Controls.Api", "7/8;text/copy", native);
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

    [Fact]
    public void PrimaryGenericInitializer_UsesOwningParameterScopeAndNativeConstructor()
    {
        InDirectory(directory =>
        {
            var native = EmitCSharp(directory, "NativePrimary4755", """
                namespace NativePrimary4755;
                public static class Factory<T>
                {
                    public static int Calls;
                    public static T Copy(T value) { Calls++; return value; }
                }
                public struct Box<T>(T value)
                {
                    public T Value = value;
                    public T Copy = Factory<T>.Copy(value);
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var number = new Box<int>(7);
                        var text = new Box<string>("text");
                        return number.Value + "/" + number.Copy + "/" + Factory<int>.Calls + ";" +
                            text.Value + "/" + text.Copy + "/" + Factory<string>.Calls;
                    }
                }
                """);
            Assert.Equal("7/7/1;text/text/1", Invoke(EmittedFixture.Load(native), "NativePrimary4755.Oracle"));
            var emitted = Compile(directory, """
                package PrimaryGeneric4755
                import NativePrimary4755
                struct Box[T](Value T) {
                    public var Copy T = Factory[T].Copy(Value)
                }
                struct Simple[T](Value T) {
                    public var Copy T = Value
                }
                class Api {
                    shared {
                        public func Run() string {
                            let number = Box[int32](7)
                            let text = Box[string]{Value: "text"}
                            return number.Value.ToString() + "/" + number.Copy.ToString() + "/" + Factory[int32].Calls.ToString() +
                                ";" + text.Value + "/" + text.Copy + "/" + Factory[string].Calls.ToString()
                        }
                    }
                }
                """, native);
            IlVerifier.Verify(emitted, new[] { native });
            AssertNativeConsumer(directory, emitted, "PrimaryGeneric4755.Api", "7/7/1;text/text/1", native);

            var consumer = EmitCSharp(directory, "DirectPrimary4755", """
                public static class DirectPrimary4755
                {
                    public static string Run()
                    {
                        var number = new PrimaryGeneric4755.Simple<int>(7);
                        var text = new PrimaryGeneric4755.Simple<string>("text");
                        return number.Value + "/" + number.Copy + ";" + text.Value + "/" + text.Copy;
                    }
                }
                """, emitted, native);
            IlVerifier.Verify(consumer, new[] { emitted, native });
            Assert.Equal("7/7;text/text", Invoke(EmittedFixture.LoadTogether(native, emitted, consumer).Last(), "DirectPrimary4755"));
            var box = EmittedFixture.LoadTogether(native, emitted).Last().GetType("PrimaryGeneric4755.Box`1", throwOnError: true);
            var constructor = Assert.Single(box.GetConstructors());
            var parameter = Assert.Single(constructor.GetParameters());
            Assert.Equal("Value", parameter.Name);
            Assert.Equal(box.GetGenericArguments()[0], parameter.ParameterType);
            Assert.Equal(box, box.GetField("Copy").DeclaringType);
        });
    }

    [Fact]
    public void PrimaryPrivateFixedArray_AndEnclosingTypesPreserveClosedStorage()
    {
        InDirectory(directory =>
        {
            var values = typeof(Gsharp.Values.ReadOnlyManagedRef<>).Assembly.Location;
            var native = EmitCSharp(directory, "NativePrivate4747", """
                #nullable enable
                namespace NativePrivate4747;
                public static class Factory
                {
                    public static Gsharp.Values.ReadOnlyManagedRef<int> Make() =>
                        Gsharp.Values.ReadOnlyManagedRef<int>.FromArray(new[] { 7 }, 0);
                }
                public struct Holder<T>(T value)
                {
                    private T[] handles = [value];
                    private readonly T copy = value;
                    public T Read() => handles[0];
                    public T ReadCopy() => copy;
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var number = new Holder<int>(7);
                        var text = new Holder<string>("text");
                        var location = new Holder<Gsharp.Values.ReadOnlyManagedRef<int>>(Factory.Make());
                        return number.Read() + "/" + number.ReadCopy() + ";" + text.Read() + "/" + text.ReadCopy() +
                            ";" + location.Read().Borrow() + "/" + location.ReadCopy().Borrow();
                    }
                }
                """, values);
            Assert.Equal("7/7;text/text;7/7", Invoke(EmittedFixture.LoadTogether(values, native).Last(), "NativePrivate4747.Oracle"));
            var emitted = Compile(directory, """
                package PrimaryPrivate4747
                import NativePrivate4747
                struct Holder[T](Value T) {
                    private var Handles [1]T = [1]T{Value}
                    private let Copy T = Value
                    public func Read() T -> Handles[0]
                    public func ReadCopy() T -> Copy
                }
                class Outer[T] {
                    public struct Inner(Value T) {
                        public let Copy T = Value
                    }
                }
                struct Plain(Value int32) {
                    public let Copy int32 = Value
                }
                data struct Data[T](Value T) {
                    public let Copy T = Value
                }
                struct Captured[T](Value T) {
                    public var Reader () -> T = func () T { return Value }
                }
                struct Nested[T](Value T) {
                    private var Storage Holder[T] = Holder[T](Value)
                    public func Read() T -> Storage.Read()
                }
                class Api {
                    shared {
                        public func Run() string {
                            let number = Holder[int32]{Value: 7}
                            let text = Holder[string]("text")
                            let nested = Outer[string].Inner{Value: "nested"}
                            let plain = Plain(8)
                            let data = Data[int32](9)
                            let captured = Captured[int32](10)
                            let nestedStorage = Nested[int32](11)
                            let location = Holder[readonly managed[int32]]{Value: Factory.Make()}
                            return number.Read().ToString() + "/" + number.ReadCopy().ToString() + ";" +
                                text.Read() + "/" + text.ReadCopy() + ";" + nested.Copy + ";" +
                                plain.Copy.ToString() + ";" + data.Copy.ToString() + ";" +
                                captured.Reader().ToString() + ";" + nestedStorage.Read().ToString() + ";" +
                                (*location.Read()).ToString() + "/" + (*location.ReadCopy()).ToString()
                        }
                    }
                }
                """, native, values);
            IlVerifier.Verify(emitted, new[] { native, values });
            AssertNativeConsumer(directory, emitted, "PrimaryPrivate4747.Api", "7/7;text/text;nested;8;9;10;11;7/7", native, values);
            var assembly = EmittedFixture.LoadTogether(values, native, emitted).Last();
            var holder = assembly.GetType("PrimaryPrivate4747.Holder`1", throwOnError: true);
            var copy = holder.GetField("Copy", BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.True(copy.IsPrivate);
            Assert.True(copy.IsInitOnly);
            Assert.Equal(holder, copy.DeclaringType);
            Assert.Equal(holder.GetGenericArguments()[0], copy.FieldType);
            Assert.True(holder.GetField("Handles", BindingFlags.Instance | BindingFlags.NonPublic).IsPrivate);
            Assert.Single(holder.GetConstructors());
            Assert.Single(assembly.GetType("PrimaryPrivate4747.Data`1", throwOnError: true).GetConstructors());
        });
    }

    [Fact]
    public void PrimaryConstruction_PreservesArgumentAndInitializerOrderAndRawZero()
    {
        InDirectory(directory =>
        {
            var native = EmitCSharp(directory, "NativeOrder4747", """
                namespace NativeOrder4747;
                public static class Effects
                {
                    public static string Trace = "";
                    public static int Mark(string label, int value) { Trace += label; return value; }
                }
                public struct Pair<T>(T first, T second)
                {
                    public T First = first;
                    public T Second = second;
                    public T Copy = Observe(first);
                    public int Stamp = Effects.Mark("J", 3);
                    private static T Observe(T value) { Effects.Trace += "I"; return value; }
                }
                public struct ZeroInput(int value)
                {
                    public int Value = value;
                    private int seed = Effects.Mark("Z", 5);
                    public int Read() => seed;
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var named = new Pair<int>(second: Effects.Mark("B", 2), first: Effects.Mark("A", 1));
                        var supplied = new Pair<int>(Effects.Mark("C", 7), Effects.Mark("D", 8))
                            { Copy = Effects.Mark("S", 9) };
                        Pair<int> zero = default;
                        var array = new Pair<int>[1];
                        var initialized = new ZeroInput(0);
                        return named.First + "/" + named.Second + "/" + named.Copy + "/" + supplied.Copy +
                            "/" + zero.Stamp + "/" + array[0].Stamp + "/" + initialized.Value + "/" + initialized.Read() + "/" + Effects.Trace;
                    }
                }
                """);
            Assert.Equal("1/2/1/9/0/0/0/5/BAIJCDIJSZ", Invoke(EmittedFixture.Load(native), "NativeOrder4747.Oracle"));
            var emitted = Compile(directory, """
                package PrimaryOrder4747
                class Effects {
                    shared {
                        public var Trace string = ""
                        public func Mark(label string, value int32) int32 {
                            Trace += label
                            return value
                        }
                    }
                }
                struct Pair[T](First T, Second T) {
                    public var Copy T = Observe(First)
                    public var Stamp int32 = Effects.Mark("J", 3)
                    shared {
                        private func Observe(value T) T {
                            Effects.Trace += "I"
                            return value
                        }
                    }
                }
                struct ZeroInput(Value int32) {
                    private var Seed int32 = Effects.Mark("Z", 5)
                    public func Read() int32 -> Seed
                }
                class Api {
                    shared {
                        public func Run() string {
                            let named = Pair[int32](Second: Effects.Mark("B", 2), First: Effects.Mark("A", 1))
                            let supplied = Pair[int32]{First: Effects.Mark("C", 7), Second: Effects.Mark("D", 8), Copy: Effects.Mark("S", 9)}
                            let zero Pair[int32] = default
                            let array = System.GC.AllocateArray[Pair[int32]](1)
                            let initialized = ZeroInput{}
                            return named.First.ToString() + "/" + named.Second.ToString() + "/" + named.Copy.ToString() + "/" +
                                supplied.Copy.ToString() + "/" + zero.Stamp.ToString() + "/" + array[0].Stamp.ToString() + "/" +
                                initialized.Value.ToString() + "/" + initialized.Read().ToString() + "/" + Effects.Trace
                        }
                    }
                }
                """);
            IlVerifier.Verify(emitted);
            AssertNativeConsumer(directory, emitted, "PrimaryOrder4747.Api", "1/2/1/9/0/0/0/5/BAIJCDIJSZ");
        });
    }

    [Theory]
    [InlineData("Holder[readonly managed[int32]]{}", false)]
    [InlineData("Holder[readonly managed[int32]]{}", true)]
    [InlineData("Holder[managed[int32]]{}", false)]
    [InlineData("Holder[managed[int32]]{}", true)]
    [InlineData("Holder[Aggregate[readonly managed[int32]]]{}", false)]
    [InlineData("Holder[Envelope]{}", false)]
    [InlineData("Holder[[1]readonly managed[int32]]{}", false)]
    [InlineData("Holder[(readonly managed[int32], int32)]{}", false)]
    [InlineData("Outer[readonly managed[int32]].Inner{}", false)]
    [InlineData("Container[Holder[readonly managed[int32]]]{Value: Holder[readonly managed[int32]]{}}", false)]
    [InlineData("Pair[readonly managed[int32]]{First: Factory.Make()}", false)]
    [InlineData("Nested[readonly managed[int32]]{Value: Factory.Make()}", false)]
    [InlineData("Authored[readonly managed[int32]]{}", false)]
    [InlineData("Authored[readonly managed[int32]]{}", true)]
    [InlineData("Ordered[readonly managed[int32]]{Items: {1}}", false)]
    public void MissingRequiredPrimaryInputs_ReportDefaultDiagnosticAtTheLiteral(string expression, bool declaredInitializer)
    {
        InDirectory(directory =>
        {
            var values = typeof(Gsharp.Values.ReadOnlyManagedRef<>).Assembly.Location;
            var native = EmitCSharp(directory, "MissingPrimary4755", """
                #nullable enable
                namespace MissingPrimary4755;
                public readonly struct Envelope(Gsharp.Values.ReadOnlyManagedRef<int> handle)
                {
                    public readonly Gsharp.Values.ReadOnlyManagedRef<int> Handle = handle;
                }
                public static class Factory
                {
                    public static Gsharp.Values.ReadOnlyManagedRef<int> Make() =>
                        Gsharp.Values.ReadOnlyManagedRef<int>.FromArray(new[] { 7 }, 0);
                }
                """, values);
            var source = $$"""
                package MissingPrimary4755Controls
                import MissingPrimary4755
                struct Holder[T](Value T) {
                    {{(declaredInitializer ? "private var Handles [1]T = [1]T{Value}" : string.Empty)}}
                    public func Read() T -> {{(declaredInitializer ? "Handles[0]" : "Value")}}
                }
                struct Aggregate[T](Item T) { }
                struct Container[T](Value T) { }
                struct Pair[T](First T, Second T) { }
                struct Authored[T](Value T) {
                    {{(declaredInitializer ? "public var Copy T = Value" : string.Empty)}}
                    public init() { }
                }
                struct Ordered[T](Value T) {
                    public var Copy T = Value
                    public var Items System.Collections.Generic.List[int32] = System.Collections.Generic.List[int32]()
                }
                class Outer[T] { public struct Inner(Value T) { } }
                struct Nested[T](Value T) {
                    private var Storage Holder[T] = Holder[T]{}
                    public func Read() T -> Storage.Read()
                }
                func Bad() {
                    let item = {{expression}}
                }
                """;
            var result = TryCompile(directory, source, native, values);
            Assert.Equal(1, result.Code);
            Assert.Contains("error GS0604:", result.Output, StringComparison.Ordinal);
            Assert.Contains("default would synthesize a null non-null managed-reference slot", result.Output, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", result.Output, StringComparison.Ordinal);
            Assert.False(File.Exists(result.AssemblyPath));
            var rejected = expression.StartsWith("Nested", StringComparison.Ordinal) ? "Holder[T]{}"
                : expression.StartsWith("Container", StringComparison.Ordinal)
                ? "Holder[readonly managed[int32]]{}"
                : expression.StartsWith("Outer", StringComparison.Ordinal) ? "Inner{}" : expression;
            var offset = source.LastIndexOf(rejected, StringComparison.Ordinal);
            Assert.True(offset >= 0);
            var line = source[..offset].Count(character => character == '\n') + 1;
            var column = offset - source.LastIndexOf('\n', offset);
            Assert.Contains($"Fixture.gs({line},{column},{line},{column + rejected.Length}): error GS0604:", result.Output, StringComparison.Ordinal);
            Assert.Single(result.Output.Split('\n'), text => text.Contains("error GS0604:", StringComparison.Ordinal));
        });
    }

    [Fact]
    public void ConstructedGenericArrayInitializer_ReportsRequiredElementDiagnostic()
    {
        InDirectory(directory =>
        {
            var source = """
                package GenericArrayInitializer4755
                struct S[T] {
                    private var Handles []T = [1]T
                }
                func Bad() {
                    let value = S[readonly managed[int32]]{}
                }
                """;
            var result = TryCompile(directory, source);
            Assert.Equal(1, result.Code);
            Assert.Contains("error GS0604:", result.Output, StringComparison.Ordinal);
            Assert.Contains("array initialization must supply every non-null managed-reference element", result.Output, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", result.Output, StringComparison.Ordinal);
            Assert.False(File.Exists(result.AssemblyPath));
            Assert.Single(result.Output.Split('\n'), text => text.Contains("error GS0604:", StringComparison.Ordinal));
        });
    }

    [Fact]
    public void MissingLegalPrimaryInputs_AndExplicitRequiredInputsRetainNativeRuntime()
    {
        InDirectory(directory =>
        {
            var values = typeof(Gsharp.Values.ReadOnlyManagedRef<>).Assembly.Location;
            var native = EmitCSharp(directory, "LegalPrimary4755", """
                #nullable enable
                namespace LegalPrimary4755;
                public static class Factory
                {
                    public static Gsharp.Values.ReadOnlyManagedRef<int> ReadOnly() =>
                        Gsharp.Values.ReadOnlyManagedRef<int>.FromArray(new[] { 7 }, 0);
                    public static Gsharp.Values.ManagedRef<int> Writable() =>
                        Gsharp.Values.ManagedRef<int>.FromArray(new[] { 8 }, 0);
                    public static bool MissingReadOnlyArray(Gsharp.Values.ReadOnlyManagedRef<int>[]? values) => values == null;
                    public static bool MissingNullableArray(Gsharp.Values.ReadOnlyManagedRef<int>?[]? values) => values == null;
                }
                public struct Aggregate<T>(T item) { public T Item = item; }
                public struct Holder<T>(T value)
                {
                    public T Value = value;
                    private readonly T copy = value;
                    public T Read() => copy;
                }
                public struct Nested<T>(T value)
                {
                    private Holder<T> storage = new(default);
                    public T Read() => storage.Read();
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var readOnly = new Holder<Gsharp.Values.ReadOnlyManagedRef<int>>(Factory.ReadOnly());
                        var writable = new Holder<Gsharp.Values.ManagedRef<int>>(Factory.Writable());
                        var nullable = new Holder<Gsharp.Values.ReadOnlyManagedRef<int>?>(null);
                        var scalar = new Holder<int>(0);
                        var text = new Holder<string?>(null);
                        var aggregate = new Holder<Aggregate<Gsharp.Values.ReadOnlyManagedRef<int>>>(
                            new Aggregate<Gsharp.Values.ReadOnlyManagedRef<int>>(Factory.ReadOnly()));
                        var array = new Holder<Gsharp.Values.ReadOnlyManagedRef<int>[]>([Factory.ReadOnly()]);
                        var zeroLength = new Holder<Gsharp.Values.ReadOnlyManagedRef<int>[]?>(null);
                        var nullableArray = new Holder<Gsharp.Values.ReadOnlyManagedRef<int>?[]?>(null);
                        var nestedScalar = new Nested<int>(3);
                        var nestedNullable = new Nested<Gsharp.Values.ReadOnlyManagedRef<int>?>(null);
                        return readOnly.Value.Borrow() + "/" + readOnly.Read().Borrow() + ";" +
                            writable.Value.Borrow() + "/" + writable.Read().Borrow() + ";" +
                            (nullable.Read() == null) + ";" + scalar.Read() + ";" + (text.Read() == null) + ";" +
                            aggregate.Read().Item.Borrow() + ";" + array.Read()[0].Borrow() + ";" +
                            Factory.MissingReadOnlyArray(zeroLength.Read()) + ";" + Factory.MissingNullableArray(nullableArray.Read()) +
                            ";" + nestedScalar.Read() + ";" + (nestedNullable.Read() == null);
                    }
                }
                """, values);
            Assert.Equal("7/7;8/8;True;0;True;7;7;True;True;0;True", Invoke(EmittedFixture.LoadTogether(values, native).Last(), "LegalPrimary4755.Oracle"));
            var emitted = Compile(directory, """
                package LegalPrimary4755Controls
                import LegalPrimary4755
                struct Holder[T](Value T) {
                    private let Copy T = Value
                    public func Read() T -> Copy
                }
                struct Aggregate[T](Item T) { }
                struct Nested[T](Value T) {
                    private var Storage Holder[T] = Holder[T]{}
                    public func Read() T -> Storage.Read()
                }
                class Api {
                    shared {
                        public func Run() string {
                            let readonly = Holder[readonly managed[int32]]{Value: Factory.ReadOnly()}
                            let writable = Holder[managed[int32]](Factory.Writable())
                            let nullable = Holder[readonly managed[int32]?]{}
                            let scalar = Holder[int32]{}
                            let text = Holder[string?]{}
                            let nestedScalar = Nested[int32](3)
                            let nestedNullable = Nested[readonly managed[int32]?]{}
                            let aggregate = Holder[Aggregate[readonly managed[int32]]]{Value: Aggregate[readonly managed[int32]](Factory.ReadOnly())}
                            let array = Holder[[1]readonly managed[int32]]{Value: [1]readonly managed[int32]{Factory.ReadOnly()}}
                            let zeroLength = Holder[[0]readonly managed[int32]]{}
                            let nullableArray = Holder[[1]readonly managed[int32]?]{}
                            return (*readonly.Value).ToString() + "/" + (*readonly.Read()).ToString() + ";" +
                                (*writable.Value).ToString() + "/" + (*writable.Read()).ToString() + ";" +
                                (nullable.Read() == nil).ToString() + ";" + scalar.Read().ToString() + ";" +
                                (text.Read() == nil).ToString() + ";" + (*aggregate.Read().Item).ToString() + ";" +
                                (*array.Read()[0]).ToString() + ";" + Factory.MissingReadOnlyArray(zeroLength.Read()).ToString() + ";" +
                                Factory.MissingNullableArray(nullableArray.Read()).ToString() + ";" +
                                nestedScalar.Read().ToString() + ";" + (nestedNullable.Read() == nil).ToString()
                        }
                    }
                }
                """, native, values);
            IlVerifier.Verify(emitted, new[] { native, values });
            AssertNativeConsumer(directory, emitted, "LegalPrimary4755Controls.Api", "7/7;8/8;True;0;True;7;7;True;True;0;True", native, values);
        });
    }

    private static object Invoke(Assembly assembly, string typeName, string methodName = "Run") =>
        assembly.GetType(typeName, throwOnError: true).GetMethod(methodName).Invoke(null, null);

    private static string Compile(string directory, string source, params string[] references)
    {
        var result = TryCompile(directory, source, references);
        Assert.True(result.Code == 0, result.Output);
        return result.AssemblyPath;
    }

    private static (int Code, string AssemblyPath, string Output) TryCompile(string directory, string source, params string[] references)
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
            var code = Program.Main(arguments);
            return (code, assemblyPath, stdout.ToString() + stderr);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
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
