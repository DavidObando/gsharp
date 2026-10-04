// <copyright file="Issue4757RecursiveDelegateDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests;

public sealed class Issue4757RecursiveDelegateDriverTests
{
    private const string RecursiveNative = """
        using System;
        namespace Recursive4757;
        public delegate Callback Callback(Callback other);
        public delegate Second First(Second other);
        public delegate First Second(First other);
        public sealed class MarkerAttribute : Attribute {
            public Type Value;
            public MarkerAttribute(Type value) { Value = value; }
        }
        public static class Owner {
            public static Callback Apply(Callback callback) => callback(callback);
            public static First ApplyMutual(First first, Second second) => first(second)(first);
            [Marker(typeof(Callback))]
            public static int Tagged() => 1;
        }
        """;

    private const string RecursiveSource = """
        package Recursive4757
        import System
        delegate Callback(other Callback) Callback;
        delegate First(other Second) Second;
        delegate Second(other First) First;
        class MarkerAttribute : Attribute {
            var Value Type
            init(value Type) { Value = value }
        }
        shared class Owner {
            func Apply(callback Callback) Callback -> callback.Invoke(callback)
            func ApplyMutual(first First, second Second) First -> first.Invoke(second).Invoke(first)
            @Marker(typeof(Callback))
            func Tagged() int32 -> 1
        }
        """;

    private const string RecursiveConsumer = """
        using System;
        using Recursive4757;
        public static class Consumer {
            public static string Run() {
                var calls = 0;
                Callback self = other => { calls++; return other; };
                if (!ReferenceEquals(self, Owner.Apply(self)) || calls != 1) throw new Exception("self");
                First? first = null;
                Second second = other => other;
                first = other => other;
                if (!ReferenceEquals(first, Owner.ApplyMutual(first, second))) throw new Exception("mutual");
                var invoke = typeof(Callback).GetMethod("Invoke") ?? throw new Exception("Invoke");
                if (invoke.ReturnType != typeof(Callback) ||
                    invoke.GetParameters()[0].ParameterType != typeof(Callback)) throw new Exception("nominal");
                var method = typeof(Owner).GetMethod("Tagged") ?? throw new Exception("Tagged");
                var marker = (MarkerAttribute)(Attribute.GetCustomAttribute(method, typeof(MarkerAttribute))
                    ?? throw new Exception("marker"));
                if (marker.Value != typeof(Callback) || Owner.Tagged() != 1) throw new Exception("attribute");
                return "self:1;mutual:identity;attribute:Callback";
            }
        }
        """;

    private const string GrowingNative = """
        using System;
        namespace Growing4757;
        public delegate Growing<Growing<T>> Growing<T>(Growing<T> other);
        public delegate T NullableParameter<T>(T? value) where T : class;
        public class RefBox<T> where T : class { }
        public class Outer<T> { public class Inner { } }
        public sealed class MarkerAttribute : Attribute {
            public Type Value;
            public MarkerAttribute(Type value) { Value = value; }
        }
        public static class Owner {
            private class Box { }
            public static Growing<Growing<int>> Apply(Growing<int> callback) => callback(callback);
            public static Type Get() => typeof(Growing<int>);
            public static Type GetPrivate() => typeof(Growing<Box>);
            public static Type GetNested() => typeof(Growing<Outer<int>.Inner>);
            public static Type GetConstrained() => typeof(RefBox<Growing<int>>);
            [Marker(typeof(Growing<int>))]
            public static int Tagged() => 1;
        }
        """;

    private const string GrowingSource = """
        package Growing4757
        import System
        delegate Growing[T](other Growing[T]) Growing[Growing[T]];
        delegate NullableParameter[T class](value T?) T;
        class RefBox[T class] { }
        class Outer[T] { class Inner { } }
        class MarkerAttribute : Attribute {
            var Value Type
            init(value Type) { Value = value }
        }
        shared class Owner {
            private class Box { }
            func Apply(callback Growing[int32]) Growing[Growing[int32]] -> callback.Invoke(callback)
            func Get() Type -> typeof(Growing[int32])
            func GetPrivate() Type -> typeof(Growing[Box])
            func GetNested() Type -> typeof(Growing[Outer[int32].Inner])
            func GetConstrained() Type -> typeof(RefBox[Growing[int32]])
            @Marker(typeof(Growing[int32]))
            func Tagged() int32 -> 1
        }
        """;

    private const string GrowingConsumer = """
        using System;
        using Growing4757;
        public static class Consumer {
            public static string Run() {
                var calls = 0;
                Growing<Growing<int>> result = other => throw new Exception("must not run");
                Growing<int> callback = other => { calls++; return result; };
                if (!ReferenceEquals(result, Owner.Apply(callback)) || calls != 1) throw new Exception("effect");
                if (Owner.Get() != typeof(Growing<int>)) throw new Exception("closed identity");
                var invoke = typeof(Growing<int>).GetMethod("Invoke") ?? throw new Exception("Invoke");
                if (invoke.ReturnType != typeof(Growing<Growing<int>>) ||
                    invoke.GetParameters()[0].ParameterType != typeof(Growing<int>)) throw new Exception("signature");
                if (typeof(Growing<>).GetGenericArguments().Length != 1 ||
                    !typeof(Growing<>).ContainsGenericParameters ||
                    typeof(Growing<int>).ContainsGenericParameters) throw new Exception("open/closed");
                var privateType = Owner.GetPrivate();
                if (privateType.GetGenericTypeDefinition() != typeof(Growing<>) ||
                    !privateType.GetGenericArguments()[0].IsNestedPrivate ||
                    privateType.GetGenericArguments()[0].DeclaringType != typeof(Owner)) throw new Exception("private identity");
                if (Owner.GetNested() != typeof(Growing<Outer<int>.Inner>)) throw new Exception("containing arguments");
                if (Owner.GetConstrained() != typeof(RefBox<Growing<int>>)) throw new Exception("constrained argument");
                var method = typeof(Owner).GetMethod("Tagged") ?? throw new Exception("Tagged");
                var marker = (MarkerAttribute)(Attribute.GetCustomAttribute(method, typeof(MarkerAttribute))
                    ?? throw new Exception("marker"));
                if (marker.Value != typeof(Growing<int>) || Owner.Tagged() != 1) throw new Exception("attribute");
                var parameter = typeof(NullableParameter<>).GetGenericArguments()[0];
                if ((parameter.GenericParameterAttributes & System.Reflection.GenericParameterAttributes.ReferenceTypeConstraint) == 0)
                    throw new Exception("constraint");
                var nullableInvoke = typeof(NullableParameter<string>).GetMethod("Invoke") ?? throw new Exception("nullable Invoke");
                var context = new System.Reflection.NullabilityInfoContext();
                if (context.Create(nullableInvoke.ReturnParameter).ReadState != System.Reflection.NullabilityState.NotNull ||
                    context.Create(nullableInvoke.GetParameters()[0]).ReadState != System.Reflection.NullabilityState.Nullable)
                    throw new Exception("nullability");
                return "growing:1;closed:int32;private:Box;nested:int32;parameter:2/return:1";
            }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void RealDriver_EmitsNativeCallableRecursiveDelegates(bool growing)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var native = fixture.CompileCSharp(growing ? GrowingNative : RecursiveNative, "native4757");
        var emitted = Compile(fixture.Directory, growing ? GrowingSource : RecursiveSource, growing ? "Growing4757" : "Recursive4757");
        var expected = growing
            ? "growing:1;closed:int32;private:Box;nested:int32;parameter:2/return:1"
            : "self:1;mutual:identity;attribute:Callback";
        foreach (var producer in new[] { native, emitted })
        {
            IlVerifier.Verify(producer);
            var consumer = fixture.CompileCSharp(
                growing ? GrowingConsumer : RecursiveConsumer,
                Path.GetFileNameWithoutExtension(producer) + "Consumer",
                producer);
            IlVerifier.Verify(consumer, new[] { producer });
            var pair = EmittedFixture.LoadTogether(producer, consumer);
            var entry = pair[1].GetType("Consumer", throwOnError: true).GetMethod("Run");
            Assert.NotNull(entry);
            Assert.Equal(expected, entry.Invoke(null, null));
        }
    }

    [Theory]
    [InlineData("class Open[T] { shared { @Marker(typeof(Growing[T])) func Tagged() int32 -> 1 } }", "GS0202", 34)]
    [InlineData("shared class Bad { func Get() Type -> typeof(RefBox[int32]) }", "GS0152", 46)]
    [InlineData("func Bad(value Growing[int32]?) Growing[int32] -> value", "GS0155", 51)]
    public void RealDriver_RejectsOpenAttributeOperandsConstraintsAndNullableNarrowing(string invalid, string diagnostic, int column)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var source = """
            package Negative4757
            import System
            delegate Growing[T](other Growing[T]) Growing[Growing[T]];
            delegate NullableParameter[T class](value T?) T;
            class MarkerAttribute : Attribute { init(value Type) { } }
            class RefBox[T class] { }
            """ + "\n" + invalid;
        var (exit, output) = TryCompile(fixture.Directory, source, "negative4757");
        Assert.NotEqual(0, exit);
        Assert.Contains("error " + diagnostic, output, StringComparison.Ordinal);
        Assert.Contains($"negative4757.gs(7,{column},7,", output, StringComparison.Ordinal);
        Assert.DoesNotContain("Stack overflow", output, StringComparison.Ordinal);
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "negative4757.dll")));
    }

    private static string Compile(string directory, string source, string name)
    {
        var (exit, output) = TryCompile(directory, source, name);
        Assert.True(exit == 0, $"real gsc exit {exit}:\n{output}");
        var path = Path.Combine(directory, name + ".dll");
        Assert.True(new FileInfo(path).Length > 0, "real gsc must emit a nonempty assembly");
        return path;
    }

    private static (int Exit, string Output) TryCompile(string directory, string source, string name)
    {
        var sourcePath = Path.Combine(directory, name + ".gs");
        File.WriteAllText(sourcePath, source);
        var start = new ProcessStartInfo("dotnet")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(typeof(GSharp.Compiler.Program).Assembly.Location);
        start.ArgumentList.Add("/target:library");
        start.ArgumentList.Add("/out:" + Path.Combine(directory, name + ".dll"));
        start.ArgumentList.Add(sourcePath);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("could not start real gsc");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(60_000))
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException("real gsc exceeded 60 seconds");
        }

        return (process.ExitCode, stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult());
    }
}
